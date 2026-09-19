/* ═══════════════════════════════════════════════════════════════════════════
   ADCONNECT — «خلّي جوجل وميتا وسناب وتيك توك متوصّلين على طول» (عمر، ١٩/٩)

   Every 3 hours (and on demand) each ad platform's connection is proven with a
   real read, and the token's shape is recorded:

     meta     system-user token (META_CAPI_TOKEN) → /debug_token: type, expiry
              (0 = never), scopes, is_valid. One token = CAPI + management.
     snapchat OAuth refresh_token → a fresh 1h access token is minted on every
              use (ads.js token()). Refresh tokens don't expire unless revoked.
              CAPI uses SNAP_ACCESS_TOKEN and falls back to a minted token on 401.
     tiktok   Marketing API token (TIKTOK_MARKETING_TOKEN, long-lived, no
              refresh) for reports/campaigns/audiences; Events API token
              (TIKTOK_ACCESS_TOKEN) for the pixel/CAPI — probed separately.
     google   OAuth refresh_token + developer token → access token minted per
              hour (google.js token()); probe = GAQL on `customer`.

   So "auto refresh" is already the design for Snap/Google (minted from the
   refresh token every call); Meta's system-user token and TikTok's marketing
   token don't expire. What CAN break is revocation / a password change / an
   app review — this module is the alarm for that:
     • state per platform in ad_connect_state (ok, detail, fail_since, alerted_at)
     • staff critical SMS (alert phones) when a platform fails twice in a row
       or Meta's token expires within 7 days — max once per platform per 24h
     • GET /api/ads/connections   (growth)  — the table, fresh=1 re-probes
     • syshealth reads the same state (component «ربط منصات الإعلانات»)
═══════════════════════════════════════════════════════════════════════════ */

import { makeStaffNotifier } from "./staffalerts.js";
import { ttMktToken, ttMktTokenSource, ttAdvertiserId, checkScopes } from "./ttconnect.js";
import { ttCatalogStatus } from "./ttcatalog.js";

/* set by register(): true when a DB token row exists but can't be decrypted */
let ttDbTokenLost = null;

const PLATFORMS = ["meta", "snapchat", "tiktok", "google"];
const LABEL = { meta: "Meta", snapchat: "Snapchat", tiktok: "TikTok", google: "Google Ads" };
const env = (k) => (process.env[k] || "").trim();

async function getJson(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); return { status: r.status, json: await r.json().catch(() => null) }; }
  finally { clearTimeout(t); }
}

export async function probeMeta() {
  const tok = env("META_CAPI_TOKEN");
  if (!tok) return { ok: false, configured: false, reason: "META_CAPI_TOKEN مش موجود" };
  const r = await getJson(`https://graph.facebook.com/v25.0/debug_token?input_token=${encodeURIComponent(tok)}&access_token=${encodeURIComponent(tok)}`);
  const d = r.json?.data;
  if (!d) return { ok: false, configured: true, reason: r.json?.error?.message || `HTTP ${r.status}` };
  const exp = Number(d.expires_at || 0);
  const act = env("META_AD_ACCOUNT_ID");
  let accountOk = null, accountReason = null;
  if (act) {
    const a = await getJson(`https://graph.facebook.com/v25.0/${act.startsWith("act_") ? act : `act_${act}`}?fields=account_status,name&access_token=${encodeURIComponent(tok)}`);
    accountOk = a.json?.account_status === 1; accountReason = a.json?.error?.message || (accountOk ? null : `account_status ${a.json?.account_status}`);
  }
  return {
    ok: Boolean(d.is_valid) && accountOk !== false, configured: true,
    token: { kind: d.type || "unknown", expiresAt: exp ? new Date(exp * 1000).toISOString() : null, never: exp === 0, refresh: "لا يحتاج (system user)", scopes: d.scopes || [] },
    reason: !d.is_valid ? (d.error?.message || "التوكن مش صالح") : accountReason,
  };
}

export async function probeSnap() {
  const id = env("SNAP_CLIENT_ID"), sec = env("SNAP_CLIENT_SECRET"), rt = env("SNAP_REFRESH_TOKEN"), acct = env("SNAP_AD_ACCOUNT_ID");
  if (!id || !rt) return { ok: false, configured: false, reason: "SNAP_CLIENT_ID / SNAP_REFRESH_TOKEN مش موجودين" };
  const b = new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: sec, refresh_token: rt });
  const t = await getJson("https://accounts.snapchat.com/login/oauth2/access_token", { method: "POST", body: b });
  const at = t.json?.access_token;
  if (!at) return { ok: false, configured: true, reason: `تجديد التوكن اترفض: ${t.json?.error_description || t.json?.error || `HTTP ${t.status}`}`, token: { kind: "oauth refresh_token", refresh: "تلقائي كل ساعة" } };
  const a = acct ? await getJson(`https://adsapi.snapchat.com/v1/adaccounts/${acct}`, { headers: { Authorization: `Bearer ${at}` } }) : null;
  const st = a?.json?.adaccounts?.[0]?.adaccount?.status || null;
  return { ok: !a || a.json?.request_status === "SUCCESS", configured: true,
    token: { kind: "oauth refresh_token", refresh: "تلقائي — توكن جديد كل ساعة من الـrefresh", accessTtlSec: t.json?.expires_in || null, never: true },
    account: { status: st, currency: a?.json?.adaccounts?.[0]?.adaccount?.currency || null }, capiToken: Boolean(env("SNAP_ACCESS_TOKEN")),
    reason: a && a.json?.request_status !== "SUCCESS" ? (a.json?.debug_message || `HTTP ${a.status}`) : null };
}

export async function probeTiktok() {
  /* (19/9 مساءً) التوكن من ttconnect: الداتابيز (المالك ربط من «حالة النظام») ← env.
     «مش مربوط خالص» = تحذير من غير SMS؛ توكن Marketing موجود (داتابيز/env) ووقع
     أو اتخزّن ومابقاش يتقري (مفتاح السيرفر اتغيّر) = عطل → SMS بعد فشلتين. */
  const adv = ttAdvertiserId(), ev = env("TIKTOK_ACCESS_TOKEN");
  const src = ttMktTokenSource(), tok = ttMktToken();
  const mk = src === "db" || src.startsWith("env:TIKTOK_MARKETING");
  let dbLost = false;
  try { dbLost = Boolean(await ttDbTokenLost?.()); } catch { /* */ }
  const how = "اربطه من حالة النظام ← «ربط تيك توك»";
  if (dbLost && !mk) return { ok: false, configured: true, eventsToken: Boolean(ev), token: { kind: "Marketing API (مخزّن في الداتابيز)", never: true },
    reason: `توكن تيك توك المتخزّن مابقاش يتقري (مفتاح السيرفر اتغيّر؟) — ${how}` };
  if (!adv || !tok) return { ok: false, configured: false, reason: `TIKTOK_ADVERTISER_ID / توكن مش موجود — ${how}` };
  const sc = await checkScopes(tok, adv);
  const mgmtOk = sc.advertiser?.ok && sc.campaigns?.ok && sc.reporting?.ok;
  const bad = Object.entries(sc).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.message || v.code}`);
  // كتالوج Fresh Cuts Menu (ttcatalog.js) — معلومة بس، مابيوقعش الربط.
  let catalog = null;
  try { catalog = await ttCatalogStatus(); } catch (e) { catalog = { error: String(e.message || e).slice(0, 200) }; }
  return {
    // events-only = management not set up yet (warn, no SMS); a marketing token that fails = broken (alert)
    ok: Boolean(mgmtOk), configured: mk || Boolean(mgmtOk),
    token: { kind: src === "db" ? "Marketing API (مربوط من اللوحة)" : mk ? "Marketing API (TIKTOK_MARKETING_TOKEN)" : "Events token فقط (TIKTOK_ACCESS_TOKEN)", source: src, refresh: "طويل العمر — مفيش تجديد، بيقف لو اتلغى التفويض", never: true },
    management: Boolean(mgmtOk), eventsToken: Boolean(ev), scopeCheck: sc, catalog,
    reason: mgmtOk ? (bad.length ? `شغّال — صلاحيات لسه مش متاحة: ${bad.join(" · ")}` : null)
      : mk ? `الإدارة/التقارير: ${bad.join(" · ")} — ${how} تاني` : `مفيش توكن Marketing API — التقارير والحملات والجماهير واقفة (${bad[0] || ""}) — ${how}`,
  };
}

export async function probeGoogle() {
  let p = null;
  try { p = (await import("./ads.js")).byId("google"); } catch { /* */ }
  if (!p) return { ok: false, configured: false, reason: "موديول جوجل مش محمّل" };
  const miss = p.missing?.("manageEnv");
  if (miss) return { ok: false, configured: false, reason: miss };
  const r = await p.search("SELECT customer.id, customer.descriptive_name, customer.time_zone, customer.currency_code, customer.status FROM customer LIMIT 1");
  const c = r.results?.[0]?.customer || {};
  return { ok: r.ok, configured: true,
    token: { kind: "OAuth refresh_token + developer token", refresh: "تلقائي — توكن جديد كل ساعة من الـrefresh", never: true },
    account: r.ok ? { name: c.descriptiveName, tz: c.timeZone, currency: c.currencyCode, status: c.status } : null,
    reason: r.ok ? null : r.reason };
}

const PROBES = { meta: probeMeta, snapchat: probeSnap, tiktok: probeTiktok, google: probeGoogle };

/* pure: should we alert? (unit-tested) */
export function alertDecision(prev, cur, now = Date.now()) {
  const within24h = prev?.alerted_at && now - Date.parse(prev.alerted_at) < 24 * 3600e3;
  if (within24h) return null;
  if (!cur.configured) return null; // not set up ≠ broken
  const failedTwice = !cur.ok && prev && prev.ok === false;
  const exp = cur.token?.expiresAt ? Date.parse(cur.token.expiresAt) : null;
  const expSoon = exp && exp - now < 7 * 864e5;
  if (failedTwice) return `FC ADS: ${LABEL[cur.platform] || cur.platform} connection failing (${String(cur.reason || "").replace(/[^\x20-\x7E]/g, "").slice(0, 70)}). Autopilot/reports blind. Reconnect.`;
  if (expSoon) return `FC ADS: ${LABEL[cur.platform] || cur.platform} token expires ${new Date(exp).toISOString().slice(0, 10)}. Renew it.`;
  return null;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  ttDbTokenLost = async () => {
    const r = await pool.query("SELECT access_token_enc FROM tt_connect WHERE id=1").catch(() => ({ rows: [] }));
    return Boolean(r.rows[0]?.access_token_enc) && ttMktTokenSource() !== "db";
  };
  const staff = deps.sendSms ? makeStaffNotifier({ getSettingsData, sendSms: deps.sendSms }) : null;
  let ready = null;
  const ensure = () => (ready ||= pool.query(`CREATE TABLE IF NOT EXISTS ad_connect_state (
      platform TEXT PRIMARY KEY, ok BOOLEAN, configured BOOLEAN, detail JSONB NOT NULL DEFAULT '{}',
      checked_at TIMESTAMPTZ, fail_since TIMESTAMPTZ, alerted_at TIMESTAMPTZ)`).catch((e) => { ready = null; throw e; }));

  async function probeAll() {
    await ensure();
    const prevRows = (await pool.query(`SELECT * FROM ad_connect_state`)).rows;
    const prev = Object.fromEntries(prevRows.map((r) => [r.platform, r]));
    const out = [];
    for (const id of PLATFORMS) {
      let cur;
      try { cur = await PROBES[id](); } catch (e) { cur = { ok: false, configured: true, reason: String(e.message || e).slice(0, 200) }; }
      cur.platform = id;
      const pr = prev[id];
      const text = alertDecision(pr, cur);
      let alerted = pr?.alerted_at || null;
      if (text && staff) { try { await staff.critical(() => text, `adconnect ${id}`); alerted = new Date().toISOString(); } catch (e) { console.error("[adconnect] alert", e.message); } }
      await pool.query(`INSERT INTO ad_connect_state(platform, ok, configured, detail, checked_at, fail_since, alerted_at)
          VALUES ($1,$2,$3,$4,now(), CASE WHEN $2 THEN NULL ELSE now() END, $5)
          ON CONFLICT (platform) DO UPDATE SET ok=EXCLUDED.ok, configured=EXCLUDED.configured, detail=EXCLUDED.detail, checked_at=now(),
            fail_since = CASE WHEN EXCLUDED.ok THEN NULL ELSE COALESCE(ad_connect_state.fail_since, now()) END,
            alerted_at = EXCLUDED.alerted_at`,
      [id, Boolean(cur.ok), cur.configured !== false, JSON.stringify(cur), alerted]);
      out.push(cur);
    }
    return out;
  }
  async function state() {
    await ensure();
    return (await pool.query(`SELECT platform, ok, configured, detail, checked_at, fail_since, alerted_at FROM ad_connect_state ORDER BY platform`)).rows;
  }

  app.get("/api/ads/connections", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      if (c.req.query("fresh") === "1") await probeAll();
      return c.json({ ok: true, platforms: await state() });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e) }); }
  });

  if (process.env.ADCONNECT_SCHEDULER !== "0") {
    const t = setTimeout(() => { probeAll().catch((e) => console.error("[adconnect]", e.message)); setInterval(() => probeAll().catch((e) => console.error("[adconnect]", e.message)), 3 * 3600e3); }, 150_000);
    if (t.unref) t.unref();
  }
  return { probeAll, state };
}
