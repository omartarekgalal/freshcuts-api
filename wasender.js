/* ═══════════════════════════════════════════════════════════════════════════
   🤖 مُرسل واتساب الآلي (واتساب ويب عن طريق إضافة كروم) — ٢٦/٩

   طلب عمر: «اعمل لي اعدادات كاملة للواتس اب اليدوي وخليه يربط مع كروم عشان
   يعمل اتمتة بشكل ذكي للارسال عن طريق الواتساب ويب زي sender … باعدادات كاملة
   وفلاتر كاملة، مع اعتبار ان … بحد ١ رسالة كل ٣ ايام فقط من خلال الاتمتة».

   ── الشكل ──────────────────────────────────────────────────────────────────
   اللوحة بتعمل «حملة» من شريحة (نفس شرايح الواتساب اليدوي outreach.js) +
   فلاتر ⇒ طابور wa_send_queue. إضافة كروم على web.whatsapp.com بتسأل السيرفر
   «الرسالة الجاية إيه؟» (/api/wa-sender/agent/next) — السيرفر هو اللي بيقرّر
   الإيقاع كله، والإضافة بتنفّذ بس. فلو الإضافة اتقفلت أو اتلخبطت، الحدود فاضلة.

   ── الحدود (كلها في السيرفر، مش في الإضافة) ─────────────────────────────
   • رقم واحد = رسالة واحدة كل ٣ أيام على الأقل (قاعدة عمر). بتتحسب من
     wa_contact_log: الآلي + اللي اتفتح من الشاشة اليدوية. مابتقلّش عن ٣ أبداً.
   • سقف يومي، وساعات إرسال (الرياض)، وفاصل عشوائي بين كل رسالتين، واستراحة
     بعد كل دفعة. الأرقام دي بتقلّل احتمال إن واتساب يحظر الرقم.
   • مستبعدين دايماً: اللي عامل إلغاء اشتراك، أرقام الفريق، اللي طلب أونلاين
     في آخر X أيام، واللي عنده طلب مفتوح دلوقتي.
   • ٣ فشل ورا بعض ⇒ الإيقاف أوتوماتيك (غالباً واتساب ويب اتقفل أو اتغيّر).

   ── الإضافة ────────────────────────────────────────────────────────────────
   التوثيق بتوكن جهاز (بيتولّد من اللوحة، بيتخزّن sha256 بس). الإضافة مابتشوفش
   غير رسالة واحدة في المرة.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { staffPhoneSet } from "./smsrules.js";

export const MIN_GAP_DAYS = 3;
export const DEFAULTS = {
  enabled: false,           // المفتاح الرئيسي — مقفول لحد ما المالك يفتحه
  gapDays: 3,               // رقم واحد كل كام يوم (مابيقلّش عن ٣)
  dailyCap: 40,             // أقصى رسايل في اليوم
  hourCap: 15,              // أقصى رسايل في الساعة
  minDelaySec: 60,          // الفاصل العشوائي بين رسالتين
  maxDelaySec: 150,
  batchSize: 10,            // بعد كل كام رسالة…
  batchPauseMin: 12,        // …استراحة كام دقيقة
  startHour: 13,            // ساعات الإرسال (الرياض)
  endHour: 22,
  days: ["sat", "sun", "mon", "tue", "wed", "thu", "fri"],
  skipOnlineWithinDays: 3,  // طلب أونلاين قريب = مانضايقوش
  skipOpenOrder: true,
  footer: "",               // سطر اختياري آخر الرسالة (زي «للإيقاف ردّ: إيقاف»)
  failStop: 3,              // فشل ورا بعض ⇒ إيقاف
};
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

export function senderCfg(settings) {
  const x = { ...DEFAULTS, ...(((settings || {}).waSender) || {}) };
  const minD = clampN(x.minDelaySec, 20, 1800, DEFAULTS.minDelaySec);
  return {
    enabled: x.enabled === true,
    gapDays: clampN(x.gapDays, MIN_GAP_DAYS, 60, 3),
    dailyCap: clampN(x.dailyCap, 1, 300, 40),
    hourCap: clampN(x.hourCap, 1, 100, 15),
    minDelaySec: minD,
    maxDelaySec: Math.max(minD, clampN(x.maxDelaySec, 20, 3600, DEFAULTS.maxDelaySec)),
    batchSize: clampN(x.batchSize, 1, 200, 10),
    batchPauseMin: clampN(x.batchPauseMin, 0, 240, 12),
    startHour: clampN(x.startHour, 0, 23, 13),
    endHour: clampN(x.endHour, 1, 24, 22),
    days: Array.isArray(x.days) ? x.days.filter((d) => DAYS.includes(d)) : DEFAULTS.days,
    skipOnlineWithinDays: clampN(x.skipOnlineWithinDays, 0, 60, 3),
    skipOpenOrder: x.skipOpenOrder !== false,
    footer: String(x.footer || "").slice(0, 200),
    failStop: clampN(x.failStop, 1, 20, 3),
    agentHash: x.agentHash || null,
  };
}

const riyadh = (now) => new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
export function inWindow(cfg, now = Date.now()) {
  const r = riyadh(now);
  if (!cfg.days.includes(DAYS[r.getDay()])) return false;
  const h = r.getHours();
  return cfg.endHour > cfg.startHour ? h >= cfg.startHour && h < cfg.endHour : h >= cfg.startHour || h < cfg.endHour;
}

/* القرار: نبعت دلوقتي ولا نستنى كام ثانية؟ (دالة صافية — متجرّبة) */
export function pacing(cfg, st, now = Date.now(), rnd = Math.random) {
  if (!cfg.enabled) return { wait: null, reason: "disabled" };
  if (!inWindow(cfg, now)) return { wait: 600, reason: "outside_hours" };
  if (st.today >= cfg.dailyCap) return { wait: 1800, reason: "daily_cap" };
  if (st.lastHour >= cfg.hourCap) return { wait: 300, reason: "hour_cap" };
  if (st.failStreak >= cfg.failStop) return { wait: null, reason: "fail_stop" };
  if (st.lastSentAt) {
    const since = (now - new Date(st.lastSentAt).getTime()) / 1000;
    const pause = cfg.batchPauseMin > 0 && st.sinceBreak >= cfg.batchSize ? cfg.batchPauseMin * 60 : 0;
    const gap = pause || (st.nextGapSec || cfg.minDelaySec);
    if (since < gap) return { wait: Math.ceil(gap - since), reason: pause ? "batch_pause" : "delay" };
  }
  const nextGapSec = Math.round(cfg.minDelaySec + rnd() * (cfg.maxDelaySec - cfg.minDelaySec));
  return { wait: 0, nextGapSec };
}

export const withFooter = (msg, footer) => (footer ? `${msg}\n\n${footer}` : msg);
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const outreach = deps.outreach || null;          // { AUDIENCES, audienceRows }
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);
  const bad = (c, error, message, status = 400) => c.json({ ok: false, error, message }, status);
  const whoOf = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return (u && u.name) || "المالك";
    } catch { return "المالك"; }
  };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_contact_log (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        channel TEXT NOT NULL,          -- auto | manual
        job_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), by TEXT
      );
      CREATE INDEX IF NOT EXISTS wa_contact_log_pn_idx ON wa_contact_log(phone_norm, at DESC);
      CREATE TABLE IF NOT EXISTS wa_send_jobs (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',   -- running | paused | done | cancelled
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        template TEXT,
        total INT NOT NULL DEFAULT 0,
        created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS wa_send_queue (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL,
        phone_norm TEXT NOT NULL,
        name TEXT, message TEXT NOT NULL, score INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | skipped
        reason TEXT, attempts INT NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
        UNIQUE(job_id, phone_norm)
      );
      CREATE INDEX IF NOT EXISTS wa_send_queue_pending_idx ON wa_send_queue(status, job_id, score DESC);
      CREATE TABLE IF NOT EXISTS wa_sender_state (
        id INT PRIMARY KEY DEFAULT 1,
        last_sent_at TIMESTAMPTZ, next_gap_sec INT, since_break INT NOT NULL DEFAULT 0,
        fail_streak INT NOT NULL DEFAULT 0, last_seen_at TIMESTAMPTZ, agent JSONB,
        stopped_reason TEXT
      );
      INSERT INTO wa_sender_state(id) VALUES (1) ON CONFLICT DO NOTHING;
    `);
  }
  ensureSchema().catch((e) => console.error("[wasender] schema:", e.message));

  async function stateNow() {
    const s = (await pool.query("SELECT * FROM wa_sender_state WHERE id=1")).rows[0] || {};
    const c = (await pool.query(
      `SELECT count(*) FILTER (WHERE (sent_at AT TIME ZONE 'Asia/Riyadh')::date = (NOW() AT TIME ZONE 'Asia/Riyadh')::date)::int AS today,
              count(*) FILTER (WHERE sent_at > NOW() - INTERVAL '1 hour')::int AS last_hour
         FROM wa_send_queue WHERE status='sent' AND sent_at > NOW() - INTERVAL '2 days'`)).rows[0];
    return { lastSentAt: s.last_sent_at, nextGapSec: s.next_gap_sec, sinceBreak: s.since_break || 0,
      failStreak: s.fail_streak || 0, lastSeenAt: s.last_seen_at, agent: s.agent, stoppedReason: s.stopped_reason,
      today: c.today, lastHour: c.last_hour };
  }

  /* الأرقام اللي اتكلّمت في آخر gapDays — آلي أو يدوي */
  async function recentSet(pns, gapDays) {
    if (!pns.length) return new Set();
    const r = await pool.query(
      `SELECT DISTINCT phone_norm FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > NOW() - ($2 || ' days')::interval`,
      [pns, String(gapDays)]);
    return new Set(r.rows.map((x) => x.phone_norm));
  }
  async function blockedSets(pns, cfg) {
    const out = { onlineRecent: new Set(), openOrder: new Set() };
    if (!pns.length) return out;
    if (cfg.skipOnlineWithinDays > 0) {
      const r = await pool.query(
        `SELECT DISTINCT phone_norm FROM shop_orders WHERE phone_norm = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval
           AND status NOT IN ('pending_payment','expired')`, [pns, String(cfg.skipOnlineWithinDays)]);
      out.onlineRecent = new Set(r.rows.map((x) => x.phone_norm));
    }
    if (cfg.skipOpenOrder) {
      const r = await pool.query(
        `SELECT DISTINCT phone_norm FROM shop_orders WHERE phone_norm = ANY($1::text[])
           AND status IN ('pos_created','accepted','courier_requested','courier_assigned','on_the_way','courier_cancelled')`, [pns]);
      out.openOrder = new Set(r.rows.map((x) => x.phone_norm));
    }
    return out;
  }

  /* الفلاتر فوق الشريحة: {audience, minOrders, maxOrders, minSpend, minDaysSince,
     maxDaysSince, maxWebOrders, requireName, onlyAdBlocked, excludeAdBlocked, limit} */
  function applyFilters(rows, f = {}) {
    const n = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return rows.filter((r) =>
      (n(f.minOrders) == null || r.orders >= n(f.minOrders)) &&
      (n(f.maxOrders) == null || r.orders <= n(f.maxOrders)) &&
      (n(f.minSpend) == null || r.spend >= n(f.minSpend)) &&
      (n(f.minDaysSince) == null || (r.daysAgo ?? 9999) >= n(f.minDaysSince)) &&
      (n(f.maxDaysSince) == null || (r.daysAgo ?? 9999) <= n(f.maxDaysSince)) &&
      (n(f.maxWebOrders) == null || (r.webOrders || 0) <= n(f.maxWebOrders)) &&
      (!f.requireName || Boolean(r.name)) &&
      (!f.onlyAdBlocked || r.adBlocked) &&
      (!f.excludeAdBlocked || !r.adBlocked));
  }

  async function build(filters, s) {
    if (!outreach) throw new Error("outreach_missing");
    const cfg = senderCfg(s);
    const aud = outreach.AUDIENCES[filters.audience] ? filters.audience : "never_online";
    const minLast = Number(filters.minLastOrder) > 0 ? Number(filters.minLastOrder) : 0;
    const all = await outreach.audienceRows(aud, { canSee: true, minLastOrder: minLast });
    // مفيش ولا طلب ≥ الحد (بيشتري مية/بيبسي بس) ⇒ مالوش رسالة تفكّره بأكلة
    const smallOnly = all.filter((r) => r.noMeaningfulOrder).length;
    const filtered = applyFilters(all.filter((r) => !r.noMeaningfulOrder), filters);
    const pns = filtered.map((r) => r.pn);
    const staff = staffPhoneSet(s);
    const recent = await recentSet(pns, cfg.gapDays);
    const blk = await blockedSets(pns, cfg);
    const queued = new Set((await pool.query(
      `SELECT DISTINCT q.phone_norm FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
        WHERE q.status IN ('pending','sending') AND j.status IN ('running','paused') AND q.phone_norm = ANY($1::text[])`,
      [pns])).rows.map((x) => x.phone_norm));
    const excluded = { staff: 0, recent: 0, onlineRecent: 0, openOrder: 0, queued: 0 };
    const ok = [];
    for (const r of filtered) {
      if (staff.has(r.pn)) { excluded.staff++; continue; }
      if (recent.has(r.pn)) { excluded.recent++; continue; }
      if (blk.onlineRecent.has(r.pn)) { excluded.onlineRecent++; continue; }
      if (blk.openOrder.has(r.pn)) { excluded.openOrder++; continue; }
      if (queued.has(r.pn)) { excluded.queued++; continue; }
      ok.push(r);
    }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 100));
    excluded.smallOnly = smallOnly;
    excluded.smallSkipped = ok.filter((r) => r.skippedSmall > 0).length;   // اترجعنا لطلب أقدم
    return { audience: aud, inAudience: all.length, afterFilters: filtered.length, excluded, eligible: ok.length,
      picked: ok.slice(0, limit), cfg };
  }

  // ── اللوحة ──────────────────────────────────────────────────────────────
  app.get("/api/cms/wa-sender", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const cfg = senderCfg(s);
    const st = await stateNow();
    const jobs = (await pool.query(
      `SELECT j.*, count(q.*) FILTER (WHERE q.status='sent')::int AS sent,
              count(q.*) FILTER (WHERE q.status='failed')::int AS failed,
              count(q.*) FILTER (WHERE q.status='skipped')::int AS skipped,
              count(q.*) FILTER (WHERE q.status IN ('pending','sending'))::int AS pending
         FROM wa_send_jobs j LEFT JOIN wa_send_queue q ON q.job_id=j.id
        GROUP BY j.id ORDER BY j.id DESC LIMIT 30`)).rows;
    const { agentHash, ...pub } = cfg;
    return c.json({ ok: true, cfg: pub, agentPaired: Boolean(agentHash), state: st,
      pace: pacing(cfg, st, now(), () => 0), inWindow: inWindow(cfg, now()),
      audiences: outreach ? Object.entries(outreach.AUDIENCES).map(([id, a]) => ({ id, ...a })) : [],
      jobs: jobs.map((j) => ({ ...j, id: Number(j.id) })), minGapDays: MIN_GAP_DAYS });
  });

  app.post("/api/cms/wa-sender/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await getSettingsData();
    const cur = (s.waSender && typeof s.waSender === "object") ? s.waSender : {};
    const allowed = ["enabled", "gapDays", "dailyCap", "hourCap", "minDelaySec", "maxDelaySec", "batchSize", "batchPauseMin",
      "startHour", "endHour", "days", "skipOnlineWithinDays", "skipOpenOrder", "footer", "failStop"];
    const next = { ...cur };
    for (const k of allowed) if (b[k] !== undefined) next[k] = b[k];
    if (Number(next.gapDays) < MIN_GAP_DAYS) next.gapDays = MIN_GAP_DAYS;
    const clean = senderCfg({ waSender: next });
    const { agentHash, ...store } = clean;
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waSender}', $1::jsonb, true) WHERE id=1`,
      [J({ ...store, agentHash: cur.agentHash || null })]);
    if (b.enabled === true) await pool.query("UPDATE wa_sender_state SET fail_streak=0, stopped_reason=NULL WHERE id=1");
    return c.json({ ok: true, cfg: store });
  });

  // توكن الإضافة: بيتعرض مرة واحدة
  app.post("/api/cms/wa-sender/pair", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const token = "wa_" + crypto.randomBytes(24).toString("base64url");
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN COALESCE(data,'{}'::jsonb) ? 'waSender' THEN data ELSE jsonb_set(COALESCE(data,'{}'::jsonb),'{waSender}','{}'::jsonb,true) END,
         '{waSender,agentHash}', $1::jsonb, true) WHERE id=1`, [J(sha(token))]);
    return c.json({ ok: true, token });
  });

  app.post("/api/cms/wa-sender/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await getSettingsData();
    const r = await build(b.filters || {}, s);
    const tpl = String(b.template || "").trim();
    // العينة: أول ٥ + مثال واحد اترجعنا فيه لطلب أقدم (عشان المالك يشوف الفلتر شغّال)
    const pick = r.picked.slice(0, 5);
    const ex = r.picked.find((x) => x.skippedSmall > 0);
    if (ex && !pick.includes(ex)) pick.push(ex);
    const sample = pick.map((x) => ({ name: x.name, phone: `${x.pn.slice(0, 3)}••••${x.pn.slice(-2)}`,
      orders: x.orders, spend: x.spend, daysAgo: x.daysAgo, lastTotal: x.lastTotal, skippedSmall: x.skippedSmall || 0,
      message: withFooter(x.message, r.cfg.footer) }));
    const days = Math.ceil(r.picked.length / r.cfg.dailyCap);
    return c.json({ ok: true, audience: r.audience, inAudience: r.inAudience, afterFilters: r.afterFilters,
      excluded: r.excluded, eligible: r.eligible, willQueue: r.picked.length, estDays: days, sample, customTemplate: Boolean(tpl) });
  });

  app.post("/api/cms/wa-sender/jobs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await getSettingsData();
    const r = await build(b.filters || {}, s);
    if (!r.picked.length) return bad(c, "empty", "مفيش حد مؤهل بالفلاتر دي");
    if (b.confirmCount != null && Number(b.confirmCount) !== r.picked.length) {
      return bad(c, "count_changed", `العدد اتغيّر (${r.picked.length}) — اعمل معاينة تاني`, 409);
    }
    const by = await whoOf(c);
    const name = String(b.name || "").trim().slice(0, 80) || `حملة ${new Date(now()).toISOString().slice(0, 10)}`;
    const client = await pool.connect();
    let jobId;
    try {
      await client.query("BEGIN");
      jobId = Number((await client.query(
        `INSERT INTO wa_send_jobs(name, filters, total, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, J(b.filters || {}), r.picked.length, by])).rows[0].id);
      for (const x of r.picked) {
        await client.query(
          `INSERT INTO wa_send_queue(job_id, phone_norm, name, message, score) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [jobId, x.pn, x.name, withFooter(x.message, r.cfg.footer), x.score || 0]);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
    return c.json({ ok: true, jobId, total: r.picked.length });
  });

  app.post("/api/cms/wa-sender/jobs/:id/:action", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id")), action = c.req.param("action");
    const to = { pause: "paused", resume: "running", cancel: "cancelled" }[action];
    if (!to) return bad(c, "bad_action", "أمر مش معروف");
    const r = await pool.query(
      `UPDATE wa_send_jobs SET status=$2, finished_at = CASE WHEN $2='cancelled' THEN NOW() ELSE finished_at END
        WHERE id=$1 AND status NOT IN ('done','cancelled') RETURNING id`, [id, to]);
    if (!r.rowCount) return bad(c, "not_found", "الحملة خلصت أو مش موجودة", 404);
    if (to === "cancelled") await pool.query("UPDATE wa_send_queue SET status='skipped', reason='cancelled' WHERE job_id=$1 AND status='pending'", [id]);
    return c.json({ ok: true });
  });

  app.get("/api/cms/wa-sender/jobs/:id/items", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const canSee = typeof ctx.canSeePhones === "function" ? await ctx.canSeePhones(c) : false;
    const r = await pool.query(
      `SELECT id, phone_norm, name, status, reason, attempts, sent_at, message FROM wa_send_queue WHERE job_id=$1
        ORDER BY (status='pending'), sent_at DESC NULLS LAST, score DESC LIMIT 500`, [Number(c.req.param("id"))]);
    return c.json({ ok: true, items: r.rows.map((x) => ({ ...x, id: Number(x.id),
      phone_norm: canSee ? x.phone_norm : `${x.phone_norm.slice(0, 3)}••••${x.phone_norm.slice(-2)}` })) });
  });

  // الشاشة اليدوية: «افتح واتساب» بيتسجّل هنا عشان قاعدة الـ٣ أيام تشمله
  app.post("/api/cms/outreach/opened", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pn = String(b.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    if (!/^5\d{8}$/.test(pn)) return bad(c, "invalid_phone", "رقم غلط");
    await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, by) VALUES ($1,'manual',$2)", [pn, await whoOf(c)]);
    return c.json({ ok: true });
  });
  app.post("/api/cms/outreach/recent", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pns = (Array.isArray(b.phones) ? b.phones : []).map((x) => String(x).replace(/\D/g, "").replace(/^(966|0)/, "")).filter((x) => /^5\d{8}$/.test(x)).slice(0, 500);
    if (!pns.length) return c.json({ ok: true, recent: {} });
    const r = await pool.query(
      `SELECT phone_norm, max(at) AS at FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > NOW() - INTERVAL '30 days' GROUP BY 1`, [pns]);
    return c.json({ ok: true, recent: Object.fromEntries(r.rows.map((x) => [x.phone_norm, x.at])) });
  });

  // ── الإضافة (توكن جهاز، مش جلسة لوحة) ─────────────────────────────────
  async function agentAuth(c) {
    const t = (c.req.header("x-agent-token") || "").trim();
    if (!t) return null;
    const cfg = senderCfg(await getSettingsData());
    if (!cfg.agentHash || sha(t) !== cfg.agentHash) return null;
    return cfg;
  }

  app.post("/api/wa-sender/agent/next", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch {}
    await pool.query("UPDATE wa_sender_state SET last_seen_at=NOW(), agent=$1::jsonb WHERE id=1",
      [J({ version: String(b.version || "").slice(0, 20), waReady: b.waReady === true, ua: String(c.req.header("user-agent") || "").slice(0, 120) })]);
    // رسايل «بتتبعت» من أكتر من ١٠ دقايق = الإضافة وقعت ⇒ ترجع للطابور
    await pool.query(`UPDATE wa_send_queue SET status='pending' WHERE status='sending' AND claimed_at < NOW() - INTERVAL '10 minutes' AND attempts < 2`);
    await pool.query(`UPDATE wa_send_queue SET status='failed', reason='stuck' WHERE status='sending' AND claimed_at < NOW() - INTERVAL '10 minutes'`);
    if (b.waReady === false) return c.json({ ok: true, wait: 60, reason: "wa_not_ready" });
    const st = await stateNow();
    const p = pacing(cfg, st, now());
    if (p.reason === "fail_stop") await pool.query("UPDATE wa_sender_state SET stopped_reason='fail_stop' WHERE id=1");
    if (p.wait !== 0) return c.json({ ok: true, wait: p.wait, reason: p.reason });
    const s = await getSettingsData();
    const staff = staffPhoneSet(s);
    // بنجرّب لحد ٥ مرشّحين — اللي يقع في قاعدة الـ٣ أيام أو اتغيّر حاله بيتعلّم skipped
    for (let i = 0; i < 5; i++) {
      const q = (await pool.query(
        `UPDATE wa_send_queue SET status='sending', claimed_at=NOW(), attempts=attempts+1
          WHERE id = (SELECT q.id FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
                       WHERE q.status='pending' AND j.status='running'
                       ORDER BY j.id, q.score DESC, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, job_id, phone_norm, message`)).rows[0];
      if (!q) {
        await pool.query(`UPDATE wa_send_jobs j SET status='done', finished_at=NOW() WHERE status='running'
                           AND NOT EXISTS (SELECT 1 FROM wa_send_queue q WHERE q.job_id=j.id AND q.status IN ('pending','sending'))`);
        return c.json({ ok: true, wait: 300, reason: "queue_empty" });
      }
      const skip = async (reason) => pool.query("UPDATE wa_send_queue SET status='skipped', reason=$2 WHERE id=$1", [q.id, reason]);
      const oo = (await pool.query("SELECT 1 FROM cms_contacts WHERE phone_norm=$1 AND opted_out_at IS NOT NULL", [q.phone_norm])).rowCount;
      if (oo) { await skip("opted_out"); continue; }
      if (staff.has(q.phone_norm)) { await skip("staff"); continue; }
      if ((await recentSet([q.phone_norm], cfg.gapDays)).size) { await skip("gap_3d"); continue; }
      const blk = await blockedSets([q.phone_norm], cfg);
      if (blk.onlineRecent.size) { await skip("ordered_online"); continue; }
      if (blk.openOrder.size) { await skip("open_order"); continue; }
      await pool.query("UPDATE wa_sender_state SET next_gap_sec=$1 WHERE id=1", [p.nextGapSec]);
      return c.json({ ok: true, wait: 0, item: { id: Number(q.id), phone: `966${q.phone_norm}`, text: q.message } });
    }
    return c.json({ ok: true, wait: 30, reason: "skipped_batch" });
  });

  app.post("/api/wa-sender/agent/result", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const id = Number(b.id);
    const q = (await pool.query("SELECT id, job_id, phone_norm, status FROM wa_send_queue WHERE id=$1", [id])).rows[0];
    if (!q) return bad(c, "not_found", "مش موجودة", 404);
    if (q.status !== "sending") return c.json({ ok: true, already: true });
    if (b.ok === true) {
      await pool.query("UPDATE wa_send_queue SET status='sent', sent_at=NOW(), reason=NULL WHERE id=$1", [id]);
      await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id) VALUES ($1,'auto',$2)", [q.phone_norm, q.job_id]);
      await pool.query(
        `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak=0,
                since_break = CASE WHEN since_break >= $1 THEN 1 ELSE since_break + 1 END WHERE id=1`, [cfg.batchSize]);
    } else {
      const reason = String(b.reason || "failed").slice(0, 60);
      // رقم مش على واتساب = مش غلطة الإضافة، مابيعدّش في «فشل ورا بعض»
      const notOnWa = reason === "invalid_number";
      await pool.query("UPDATE wa_send_queue SET status='failed', reason=$2 WHERE id=$1", [id, reason]);
      await pool.query(
        `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak = CASE WHEN $1 THEN fail_streak ELSE fail_streak+1 END WHERE id=1`, [notOnWa]);
    }
    return c.json({ ok: true });
  });
}
