/* ═══════════════════════════════════════════════════════════════════════════
   AUDIENCES — retargeting audience sync (Meta / TikTok / Snapchat).

   Builds customer segments from the restaurant's OWN first-party data and
   pushes them (SHA-256 hashed, never raw) to each platform as custom
   audiences, so campaigns can retarget real customers and exclude recent
   buyers.

   Phone sources (both already normalised to the 9-digit Saudi subscriber):
     • ts_customers.phone_norm    — POS-registered customers
     • order_sources.phone_norm   — cashier captures + FeedUs Keeta phones
                                    (~96% of delivery volume carries a phone)

   Segments (recomputed fresh on every sync):
     all        كل العملاء المعروفين
     vip        صرف ≥ 300 ر.س أو ≥ 4 طلبات
     lapsed30   آخر طلب من أكتر من 30 يوم (win-back)
     recent14   طلبوا خلال 14 يوم (استبعاد من حملات الاكتساب + ريتارجيت ساخن)
     delivery   عملاء تطبيقات التوصيل (مصدر الطلب delivery_app)

   V1 is APPEND-only: platforms de-dupe hashed members, so re-sending the full
   list nightly is idempotent. The recency segments therefore go stale slowly
   (someone who ordered yesterday stays in lapsed30 until the platforms age
   them out) — acceptable for v1 and called out in the UI.

   Credentials reuse ads.js env vars: META_CAPI_TOKEN + META_AD_ACCOUNT_ID,
   TIKTOK_ACCESS_TOKEN + TIKTOK_ADVERTISER_ID, Snap OAuth set.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  byId, canManage, missingOf, hashPhoneDigits, hashPhonePlus,
  httpJson, redact,
} from "./ads.js";

const META_VER = () => (process.env.META_API_VERSION || "v25.0").trim();
const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const SNAP_BASE = "https://adsapi.snapchat.com/v1";
const env = (k) => (process.env[k] || "").trim();

const SEGMENTS = [
  { id: "all",      label: "كل العملاء",            desc: "كل رقم جوال معروف لينا" },
  { id: "vip",      label: "عملاء VIP",             desc: "صرف ≥ 300 ر.س أو ≥ 4 طلبات" },
  { id: "lapsed30", label: "عملاء نايمين (30+ يوم)", desc: "آخر طلب من أكتر من شهر — حملات الرجوع" },
  { id: "recent14", label: "طلبوا آخر 14 يوم",       desc: "ريتارجيت ساخن + استبعاد من الاكتساب" },
  { id: "delivery", label: "عملاء تطبيقات التوصيل",  desc: "جالنا منهم رقم عن طريق FeedUs/الكاشير" },
];

export function register(app, ctx) {
  const { pool, requireAdmin, jb } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aud_audiences (
        platform TEXT NOT NULL,
        segment TEXT NOT NULL,
        audience_id TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, segment)
      );
      CREATE TABLE IF NOT EXISTS aud_syncs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        segment TEXT,
        size INT,
        status TEXT,                -- sent|failed|skipped
        response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS aud_syncs_time_idx ON aud_syncs(created_at DESC);
    `);
  }
  ensureSchema()
    .then(() => console.log("[audiences] schema ready"))
    .catch((e) => console.error("[audiences] schema failed:", e.message));

  /* ── segment membership (phone_norm list per segment) ─────────────────── */
  const BASE_CTE = `
    WITH ph AS (
      SELECT pn, max(day) AS last_day, count(*)::int AS orders, COALESCE(sum(total),0) AS spend,
             bool_or(is_delivery) AS is_delivery
        FROM (
          SELECT s.phone_norm AS pn, o.calendar_day AS day, o.total,
                 (s.source = 'delivery_app') AS is_delivery
            FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
           WHERE s.phone_norm <> ''
          UNION ALL
          SELECT tc.phone_norm, o.calendar_day, o.total, false
            FROM ts_orders o JOIN ts_customers tc ON tc.customer_id = o.customer_id
           WHERE tc.phone_norm <> ''
        ) u
       WHERE length(pn) = 9
       GROUP BY pn
    )`;

  const SEGMENT_SQL = {
    all:      `${BASE_CTE} SELECT pn FROM ph`,
    vip:      `${BASE_CTE} SELECT pn FROM ph WHERE spend >= 300 OR orders >= 4`,
    lapsed30: `${BASE_CTE} SELECT pn FROM ph WHERE last_day < (NOW() AT TIME ZONE 'utc')::date - 30`,
    recent14: `${BASE_CTE} SELECT pn FROM ph WHERE last_day >= (NOW() AT TIME ZONE 'utc')::date - 14`,
    delivery: `${BASE_CTE} SELECT pn FROM ph WHERE is_delivery`,
  };

  async function segmentPhones(segId) {
    const sql = SEGMENT_SQL[segId];
    if (!sql) throw new Error(`unknown segment ${segId}`);
    const r = await pool.query(sql);
    // 9-digit subscriber → full international digits.
    return r.rows.map((x) => "966" + x.pn);
  }

  /* ── platform senders — create-or-reuse audience, then append hashes ──── */

  async function audienceIdFor(platform, segment, createFn) {
    const r = await pool.query(
      `SELECT audience_id FROM aud_audiences WHERE platform=$1 AND segment=$2`, [platform, segment]);
    if (r.rows[0]) return { id: r.rows[0].audience_id, created: false };
    const created = await createFn();
    if (!created.ok) return created;
    await pool.query(
      `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id, name=EXCLUDED.name`,
      [platform, segment, created.id, created.name]);
    return { id: created.id, created: true };
  }

  const segName = (segId) => `FreshCuts ${SEGMENTS.find((s) => s.id === segId)?.label || segId}`;

  /* Meta: POST /act_x/customaudiences → POST /{aud}/users (batches of 10k). */
  async function syncMeta(segId, phones) {
    const token = env("META_CAPI_TOKEN");
    const actRaw = env("META_AD_ACCOUNT_ID");
    if (!token || !actRaw) return { ok: false, error: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing" };
    const act = actRaw.startsWith("act_") ? actRaw : `act_${actRaw}`;
    const base = `https://graph.facebook.com/${META_VER()}`;

    const aud = await audienceIdFor("meta", segId, async () => {
      const res = await httpJson(`${base}/${act}/customaudiences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          name: segName(segId),
          subtype: "CUSTOM",
          description: SEGMENTS.find((s) => s.id === segId)?.desc || "",
          customer_file_source: "USER_PROVIDED_ONLY",
          access_token: token,
        },
      });
      if (!res.ok || !res.json?.id) {
        return { ok: false, error: res.json?.error?.message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, id: String(res.json.id), name: segName(segId) };
    });
    if (!aud.id) return aud;

    let added = 0;
    for (let i = 0; i < phones.length; i += 10000) {
      const chunk = phones.slice(i, i + 10000);
      const res = await httpJson(`${base}/${aud.id}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          payload: { schema: ["PHONE_SHA256"], data: chunk.map((d) => [hashPhoneDigits(d)]) },
          access_token: token,
        },
      });
      if (!res.ok) {
        return { ok: false, error: res.json?.error?.message || res.error || `HTTP ${res.status}`, added };
      }
      added += res.json?.num_received ?? chunk.length;
    }
    return { ok: true, audienceId: aud.id, added };
  }

  /* TikTok: multipart file upload → create or APPEND update. */
  async function ttMultipart(url, fields, fileField, fileName, fileContent) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    fd.append(fileField, new Blob([fileContent], { type: "text/csv" }), fileName);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Access-Token": env("TIKTOK_ACCESS_TOKEN") },
      body: fd,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok && json?.code === 0, json, status: res.status, text: json ? undefined : text.slice(0, 400) };
  }

  async function syncTiktok(segId, phones) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = env("TIKTOK_ADVERTISER_ID");
    if (!token || !adv) return { ok: false, error: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing" };

    // TikTok wants the '+' inside the hash for phones.
    const fileContent = phones.map((d) => hashPhonePlus(d)).join("\n");
    const up = await ttMultipart(`${TT_BASE}/dmp/custom_audience/file/upload/`, {
      advertiser_id: adv,
      calculate_type: "PHONE_SHA256",
    }, "file", `freshcuts_${segId}.csv`, fileContent);
    if (!up.ok) return { ok: false, error: up.json?.message || up.text || `HTTP ${up.status}` };
    const filePath = up.json?.data?.file_path;
    if (!filePath) return { ok: false, error: "upload returned no file_path" };

    const existing = await pool.query(
      `SELECT audience_id FROM aud_audiences WHERE platform='tiktok' AND segment=$1`, [segId]);
    if (existing.rows[0]) {
      const res = await httpJson(`${TT_BASE}/dmp/custom_audience/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Access-Token": token },
        body: {
          advertiser_id: adv,
          custom_audience_id: existing.rows[0].audience_id,
          action: "APPEND",
          file_paths: [filePath],
        },
      });
      if (!(res.ok && res.json?.code === 0)) {
        return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, audienceId: existing.rows[0].audience_id, added: phones.length };
    }
    const res = await httpJson(`${TT_BASE}/dmp/custom_audience/create/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: {
        advertiser_id: adv,
        custom_audience_name: segName(segId),
        calculate_type: "PHONE_SHA256",
        file_paths: [filePath],
      },
    });
    if (!(res.ok && res.json?.code === 0) || !res.json?.data?.custom_audience_id) {
      return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
    }
    const id = String(res.json.data.custom_audience_id);
    await pool.query(
      `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ('tiktok',$1,$2,$3)
       ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id`,
      [segId, id, segName(segId)]);
    return { ok: true, audienceId: id, added: phones.length, created: true };
  }

  /* Snap: POST /adaccounts/{id}/segments → POST /segments/{id}/users. */
  async function syncSnap(segId, phones) {
    const snap = byId("snapchat");
    const acct = env("SNAP_AD_ACCOUNT_ID");
    const t = await snap.token();
    if (!t || !acct) return { ok: false, error: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing" };
    const hdr = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };

    const aud = await audienceIdFor("snapchat", segId, async () => {
      const res = await httpJson(`${SNAP_BASE}/adaccounts/${acct}/segments`, {
        method: "POST", headers: hdr,
        body: {
          segments: [{
            name: segName(segId),
            description: SEGMENTS.find((s) => s.id === segId)?.desc || "",
            source_type: "FIRST_PARTY",
            retention_in_days: 180,
            ad_account_id: acct,
          }],
        },
      });
      const seg = res.json?.segments?.[0]?.segment;
      if (!res.ok || !seg?.id) {
        return { ok: false, error: res.json?.debug_message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, id: seg.id, name: segName(segId) };
    });
    if (!aud.id) return aud;

    let added = 0;
    for (let i = 0; i < phones.length; i += 10000) {
      const chunk = phones.slice(i, i + 10000);
      const res = await httpJson(`${SNAP_BASE}/segments/${aud.id}/users`, {
        method: "POST", headers: hdr,
        body: { users: [{ schema: ["PHONE_SHA256"], data: chunk.map((d) => [hashPhoneDigits(d)]) }] },
      });
      if (!res.ok) {
        return { ok: false, error: res.json?.debug_message || res.error || `HTTP ${res.status}`, added };
      }
      added += res.json?.users?.[0]?.user?.number_uploaded_users ?? chunk.length;
    }
    return { ok: true, audienceId: aud.id, added };
  }

  const SENDERS = { meta: syncMeta, tiktok: syncTiktok, snapchat: syncSnap };

  /* ── the sync driver — every (platform × segment) pair, never throws ──── */
  async function syncAll({ platforms, segments, trigger = "manual" } = {}) {
    const wantP = platforms?.length ? platforms : Object.keys(SENDERS);
    const wantS = segments?.length ? segments : SEGMENTS.map((s) => s.id);
    const out = { trigger, results: {} };
    // Compute each segment once, reuse across platforms.
    const phonesBySeg = {};
    for (const segId of wantS) {
      try { phonesBySeg[segId] = await segmentPhones(segId); }
      catch (e) { phonesBySeg[segId] = { error: e.message }; }
    }
    for (const pid of wantP) {
      const sender = SENDERS[pid];
      if (!sender) continue;
      out.results[pid] = {};
      for (const segId of wantS) {
        const phones = phonesBySeg[segId];
        let r;
        if (phones?.error) r = { ok: false, error: phones.error };
        else if (!phones.length) r = { ok: true, skipped: "empty segment", added: 0 };
        else {
          try { r = await sender(segId, phones); }
          catch (e) { r = { ok: false, error: String(e.message || e) }; }
        }
        out.results[pid][segId] = r;
        await pool.query(
          `INSERT INTO aud_syncs (id, platform, segment, size, status, response)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [crypto.randomUUID(), pid, segId, Array.isArray(phones) ? phones.length : 0,
           r.ok ? (r.skipped ? "skipped" : "sent") : "failed", jb(redact(r))]).catch(() => {});
      }
    }
    return out;
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */

  app.get("/api/audiences/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const sizes = {};
    for (const s of SEGMENTS) {
      try { sizes[s.id] = (await segmentPhones(s.id)).length; }
      catch (e) { sizes[s.id] = null; }
    }
    const auds = await pool.query(`SELECT * FROM aud_audiences ORDER BY platform, segment`);
    const last = await pool.query(
      `SELECT DISTINCT ON (platform, segment) platform, segment, size, status, created_at
         FROM aud_syncs ORDER BY platform, segment, created_at DESC`);
    const plats = ["meta", "tiktok", "snapchat"].map((id) => {
      const p = byId(id);
      return { id, configured: id === "meta"
        ? !!(env("META_CAPI_TOKEN") && env("META_AD_ACCOUNT_ID"))
        : canManage(p), missing: missingOf(p.manageEnv) };
    });
    return c.json({
      ok: true,
      segments: SEGMENTS.map((s) => ({ ...s, size: sizes[s.id] })),
      platforms: plats,
      audiences: auds.rows,
      lastSyncs: last.rows,
    });
  });

  app.post("/api/audiences/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const r = await syncAll({ platforms: b.platforms, segments: b.segments, trigger: "manual" });
    return c.json({ ok: true, ...r });
  });

  console.log("[audiences] routes ready");
  return { syncAll };
}
