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
import { staffPhoneSet, inHoldout, normLocal } from "./smsrules.js";
import {
  TEMPLATE_VARS, renderTemplate, templateProblem, recipientLink, effectiveDailyCap, isOptOutText,
  creditOrders, dropPosMirrors, summarizeResults,
} from "./wamsg.js";
import { shopPaidSql } from "./identity.js";

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
  // قرار عمر ٢٦/٩: سطر الإيقاف الافتراضي — والردود بتتسجّل (agent/reply)
  footer: "لو ما تبي رسايلنا ردّ بكلمة: إيقاف",
  failStop: 3,              // فشل ورا بعض ⇒ إيقاف
  // تجميع تدريجي اختياري (الخط مستقر ومشغول ⇒ مقفول افتراضياً)
  warmup: { enabled: false, from: 10, step: 5, startedAt: null },
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
    footer: String(x.footer ?? DEFAULTS.footer).slice(0, 200),
    failStop: clampN(x.failStop, 1, 20, 3),
    warmup: warmupCfg(x.warmup),
    agentHash: x.agentHash || null,
  };
}
function warmupCfg(w) {
  const o = w && typeof w === "object" ? w : {};
  return { enabled: o.enabled === true, from: clampN(o.from, 1, 300, 10), step: clampN(o.step, 1, 100, 5),
    startedAt: o.startedAt && Number.isFinite(Date.parse(o.startedAt)) ? String(o.startedAt) : null };
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
  if (st.today >= effectiveDailyCap(cfg, now)) return { wait: 1800, reason: cfg.warmup?.enabled ? "warmup_cap" : "daily_cap" };
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

/* ── إدخال «حملة جديدة» (دالة صافية — متجرّبة) ─────────────────────────
   template  نص الحملة (فاضي = القالب العام)، {name} إجباري
   link      {slug?, target_type, target_id, coupon} — رابط متتبّع بيتعمل تلقائي
   holdoutPct ٠–٥٠٪ مجموعة محجوزة للمقارنة (مابيتبعتلهاش)
   imageUrl  صورة عرض (https من دوميناتنا بس)
   offer     {oneTime, percent, freeDelivery, validDays, minTotal} — كوبون مرة واحدة لكل عميل */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TARGETS = ["home", "collection", "product", "offer"];
export function imageUrlOk(u, hosts) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" && (hosts || []).includes(x.hostname.toLowerCase());
  } catch { return false; }
}
export function jobInput(b = {}, { hosts = [] } = {}) {
  const errs = [];
  const template = String(b.template || "").trim().slice(0, 1200);
  const tp = templateProblem(template);
  if (tp) errs.push(tp === "name_required" ? ["name_required", "النص لازم يحتوي على {name} — من غير الاسم بتبقى رسالة جماعية"]
    : tp.startsWith("unknown_var") ? ["unknown_var", `متغير مش معروف: {${tp.split(":")[1]}}`] : ["too_long", "النص طويل"]);
  const L = b.link && typeof b.link === "object" ? b.link : {};
  const slug = String(L.slug || "").trim().toLowerCase();
  if (slug && !SLUG_RE.test(slug)) errs.push(["bad_slug", "اسم الرابط: حروف إنجليزي صغيرة وأرقام وشرطة بس"]);
  const target_type = TARGETS.includes(L.target_type) ? L.target_type : "home";
  const target_id = target_type === "home" ? null : String(L.target_id || "").trim().slice(0, 64) || null;
  if (target_type !== "home" && !target_id) errs.push(["target_missing", "اختار العرض/الصنف/التجميعة اللي الرابط يفتحها"]);
  const staticCoupon = String(L.coupon || "").trim().toUpperCase().slice(0, 40) || null;
  const holdoutPct = Math.min(50, Math.max(0, Math.round(Number(b.holdoutPct) || 0)));
  const imageUrl = String(b.imageUrl || "").trim() || null;
  if (imageUrl && !imageUrlOk(imageUrl, hosts)) errs.push(["bad_image", "رابط الصورة لازم يبقى https من صورنا المرفوعة"]);
  const O = b.offer && typeof b.offer === "object" ? b.offer : {};
  let offer = null;
  if (O.oneTime === true) {
    const percent = Math.min(50, Math.max(0, Math.round(Number(O.percent) || 0)));
    const freeDelivery = O.freeDelivery === true;
    if (!percent && !freeDelivery) errs.push(["offer_empty", "الكوبون لازم يبقى خصم أو توصيل مجاني"]);
    offer = { oneTime: true, percent, freeDelivery, validDays: Math.min(30, Math.max(1, Math.round(Number(O.validDays) || 7))),
      minTotal: Math.max(0, Number(O.minTotal) || 0) };
    if (staticCoupon) errs.push(["two_coupons", "اختار: كوبون ثابت على الرابط أو كوبون مرة واحدة لكل عميل — مش الاتنين"]);
  }
  return { errs, template, link: { slug: slug || null, target_type, target_id, coupon: staticCoupon }, holdoutPct, imageUrl, offer };
}

/* كود الرابط لكل مستلم + كود الكوبون (من غير حروف متشابهة) */
const B36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const CPN = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randFrom = (abc, n) => { const b = crypto.randomBytes(n); let o = ""; for (let i = 0; i < n; i++) o += abc[b[i] % abc.length]; return o; };
export const newLinkCode = () => randFrom(B36, 6);
export const newCouponCode = (jobId) => `W${jobId}${randFrom(CPN, 5)}`;

/* الرسالة لمستلم واحد: متغيرات الصف + الرابط/الكوبون بتوعه */
export function messageFor(row, { template, footer, host, slug, code, coupon, couponDays }) {
  const vars = { ...(row.vars || {}), link: recipientLink(host, slug, code), coupon: coupon || "",
    coupon_days: coupon && couponDays ? String(couponDays) : "" };
  const body = template ? renderTemplate(template, vars) : row.message;
  return withFooter(body, footer);
}


export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const outreach = deps.outreach || null;          // { AUDIENCES, audienceRows, cfg }
  const cmsApi = () => (typeof deps.cms === "function" ? deps.cms() : deps.cms) || null;   // شرايح لوحة المتجر
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);
  const bad = (c, error, message, status = 400) => c.json({ ok: false, error, message }, status);
  const STORE = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const API_BASE = () => String(process.env.CONTENT_PUBLIC_BASE || process.env.COOLIFY_URL || "https://freshcuts-api.o2m8.me")
    .split(",")[0].trim().replace(/\/+$/, "");
  const imageHosts = () => [...new Set([API_BASE(), STORE(), "https://freshcuts-api.o2m8.me", "https://freshcuts.sa", "https://www.freshcuts.sa"]
    .map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean))];
  const ATTR_DAYS = 7;
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
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | skipped | holdout
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
      -- مرحلة ٠ (٢٦/٩): رابط متتبّع + holdout + صورة + كوبون مرة واحدة لكل حملة
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS link_slug TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS holdout_pct INT NOT NULL DEFAULT 0;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS offer JSONB;
      ALTER TABLE wa_send_jobs ADD COLUMN IF NOT EXISTS audience_label TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS link_code TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS coupon TEXT;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS clicks INT NOT NULL DEFAULT 0;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS optout_at TIMESTAMPTZ;
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS media TEXT;      -- image | text
      ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS note TEXT;       -- ليه الصورة ماراحتش مثلاً
      CREATE INDEX IF NOT EXISTS wa_send_queue_link_idx ON wa_send_queue(link_code) WHERE link_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS wa_send_queue_pn_idx ON wa_send_queue(phone_norm, sent_at DESC);
      -- ردود العملاء اللي الإضافة بتقراها من واتساب ويب
      CREATE TABLE IF NOT EXISTS wa_replies (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        text TEXT NOT NULL,
        ext_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',    -- chat | list
        job_id BIGINT, queue_id BIGINT,
        is_optout BOOLEAN NOT NULL DEFAULT FALSE,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(phone_norm, ext_id)
      );
      CREATE INDEX IF NOT EXISTS wa_replies_pn_idx ON wa_replies(phone_norm, at DESC);
      -- أرقام مش على واتساب — مابتدخلش أي حملة تانية
      CREATE TABLE IF NOT EXISTS wa_invalid_numbers (
        phone_norm TEXT PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        job_id BIGINT,
        hits INT NOT NULL DEFAULT 1
      );
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

  /* الأرقام اللي اتكلّمت في آخر gapDays — واتساب (آلي/يدوي) + رسايل SMS التسويقية
     (حملات، أتمتة، استرجاع السلة). عمر: العميل مايتضربش واتساب وSMS في نفس الفاصل.
     بترجع Map(رقم → «wa» | «sms»). جدول ناقص (قاعدة جديدة) = نكمّل بالموجود. */
  async function recentMap(pns, gapDays) {
    const out = new Map();
    if (!pns.length) return out;
    const iv = String(gapDays);
    const run = async (ch, sql) => {
      try { for (const r of (await pool.query(sql, [pns, iv])).rows) if (!out.has(r.pn)) out.set(r.pn, ch); }
      catch (e) { if (e && e.code !== "42P01") throw e; }
    };
    await run("wa", `SELECT DISTINCT phone_norm pn FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > NOW() - ($2 || ' days')::interval`);
    /* SMS الدعائي لحاجبين الإعلانات عمره ما وصل (smsblock.js — قرار عمر ٢٦/٩:
       الحجب غلطة مزوّد مش العميل) ⇒ مايتحسبش «اتكلّم». أول قراية حيّة: ٢٢٦ من
       ٤٨٦ حاجب كانوا هيتشالوا من الواتساب بسبب رسايل ماوصلتهمش. */
    const notBlocked = await pool.query("SELECT 1 FROM sms_ad_blocked LIMIT 1").then(() => true).catch(() => false)
      ? "AND phone_norm NOT IN (SELECT phone_norm FROM sms_ad_blocked)" : "";
    await run("sms", `SELECT DISTINCT phone_norm pn FROM cms_campaign_sends WHERE status='sent' AND phone_norm = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    await run("sms", `SELECT DISTINCT phone_norm pn FROM cms_flow_log WHERE phone_norm = ANY($1::text[]) AND sent_at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    await run("sms", `SELECT DISTINCT phone_norm pn FROM sms_log WHERE kind='cart_recovery' AND status='sent' AND phone_norm = ANY($1::text[]) AND at > NOW() - ($2 || ' days')::interval ${notBlocked}`);
    return out;
  }
  async function recentSet(pns, gapDays) { return new Set((await recentMap(pns, gapDays)).keys()); }
  async function invalidSet(pns) {
    if (!pns.length) return new Set();
    const r = await pool.query("SELECT phone_norm FROM wa_invalid_numbers WHERE phone_norm = ANY($1::text[])", [pns]);
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

  /* الشرايح: شرايح الواتساب اليدوي (outreach) + كل شرايح لوحة المتجر (cms)
     بـ«segment:<id>» — نفس تعريف الشريحة في الحملات والأتمتة. */
  async function audienceList() {
    const out = outreach ? Object.entries(outreach.AUDIENCES).map(([id, a]) => ({ id, ...a, group: "wa" })) : [];
    const cms = cmsApi();
    if (cms && typeof cms.segmentList === "function") {
      for (const s of cms.segmentList()) out.push({ id: `segment:${s.id}`, label: `${s.icon || ""} ${s.label}`.trim(), hint: s.hint, group: "cms" });
    }
    return out;
  }
  async function resolveAudience(aud) {
    if (typeof aud === "string" && aud.startsWith("segment:")) {
      const cms = cmsApi();
      const id = aud.slice(8);
      if (!cms || typeof cms.segmentPhones !== "function") return null;
      const phones = await cms.segmentPhones(id);
      return phones ? { aud, segmentPhones: new Set(phones) } : null;
    }
    return outreach && outreach.AUDIENCES[aud] ? { aud, segmentPhones: null } : null;
  }

  async function build(filters, s) {
    if (!outreach) throw new Error("outreach_missing");
    const cfg = senderCfg(s);
    const A = (await resolveAudience(filters.audience)) || { aud: "never_online", segmentPhones: null };
    const minLast = Number(filters.minLastOrder) > 0 ? Number(filters.minLastOrder) : 0;
    const all = await outreach.audienceRows(A.aud, { canSee: true, minLastOrder: minLast, segmentPhones: A.segmentPhones });
    // مفيش ولا طلب ≥ الحد (بيشتري مية/بيبسي بس) ⇒ مالوش رسالة تفكّره بأكلة
    const smallOnly = all.filter((r) => r.noMeaningfulOrder).length;
    const filtered = applyFilters(all.filter((r) => !r.noMeaningfulOrder), filters);
    const pns = filtered.map((r) => r.pn);
    const staff = staffPhoneSet(s);
    const recent = await recentMap(pns, cfg.gapDays);
    const invalid = await invalidSet(pns);
    const blk = await blockedSets(pns, cfg);
    const qr = (await pool.query(
      `SELECT q.phone_norm, bool_or(q.status = 'holdout') AS held FROM wa_send_queue q JOIN wa_send_jobs j ON j.id=q.job_id
        WHERE q.phone_norm = ANY($1::text[])
          AND ((q.status IN ('pending','sending') AND j.status IN ('running','paused'))
            -- المحجوزين لسه في نافذة القياس (٧ أيام): مانبعتلهمش من حملة تانية وإلا المقارنة تبوظ
            OR (q.status = 'holdout' AND j.created_at > NOW() - make_interval(days => $2::int + 7)))
        GROUP BY 1`, [pns, ATTR_DAYS])).rows;
    const queued = new Map(qr.map((x) => [x.phone_norm, x.held]));
    const excluded = { staff: 0, recent: 0, recentSms: 0, invalid: 0, onlineRecent: 0, openOrder: 0, queued: 0, heldOut: 0 };
    const ok = [];
    for (const r of filtered) {
      if (staff.has(r.pn)) { excluded.staff++; continue; }
      if (invalid.has(r.pn)) { excluded.invalid++; continue; }
      if (recent.has(r.pn)) { excluded[recent.get(r.pn) === "sms" ? "recentSms" : "recent"]++; continue; }
      if (blk.onlineRecent.has(r.pn)) { excluded.onlineRecent++; continue; }
      if (blk.openOrder.has(r.pn)) { excluded.openOrder++; continue; }
      if (queued.has(r.pn)) { excluded[queued.get(r.pn) ? "heldOut" : "queued"]++; continue; }
      ok.push(r);
    }
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 100));
    excluded.smallOnly = smallOnly;
    excluded.smallSkipped = ok.filter((r) => r.skippedSmall > 0).length;   // اترجعنا لطلب أقدم
    const C = typeof outreach.cfg === "function" ? await outreach.cfg() : { template: "" };
    return { audience: A.aud, inAudience: all.length, afterFilters: filtered.length, excluded, eligible: ok.length,
      picked: ok.slice(0, limit), cfg, globalTemplate: C.template };
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
              count(q.*) FILTER (WHERE q.status='holdout')::int AS holdout,
              count(q.*) FILTER (WHERE q.status IN ('pending','sending'))::int AS pending,
              count(q.*) FILTER (WHERE q.replied_at IS NOT NULL)::int AS replied,
              count(q.*) FILTER (WHERE q.optout_at IS NOT NULL)::int AS optouts,
              count(q.*) FILTER (WHERE q.clicks > 0)::int AS clickers,
              (SELECT l.clicks FROM cms_links l WHERE l.slug = j.link_slug) AS link_clicks
         FROM wa_send_jobs j LEFT JOIN wa_send_queue q ON q.job_id=j.id
        GROUP BY j.id ORDER BY j.id DESC LIMIT 30`)).rows;
    const extra = (await pool.query(
      `SELECT (SELECT count(*)::int FROM wa_invalid_numbers) AS invalid,
              (SELECT count(*)::int FROM wa_replies WHERE at > NOW() - INTERVAL '7 days') AS replies7,
              (SELECT count(*)::int FROM wa_replies WHERE is_optout AND at > NOW() - INTERVAL '7 days') AS optouts7`)).rows[0];
    const C = outreach && typeof outreach.cfg === "function" ? await outreach.cfg() : { template: "", site: "freshcuts.sa" };
    const { agentHash, ...pub } = cfg;
    return c.json({ ok: true, cfg: pub, agentPaired: Boolean(agentHash), state: st,
      pace: pacing(cfg, st, now(), () => 0), inWindow: inWindow(cfg, now()),
      effectiveDailyCap: effectiveDailyCap(cfg, now()),
      audiences: await audienceList(),
      jobs: jobs.map((j) => ({ ...j, id: Number(j.id) })), minGapDays: MIN_GAP_DAYS,
      templateVars: TEMPLATE_VARS, defaultTemplate: C.template, linkHost: STORE().replace(/^https?:\/\//, ""),
      invalidCount: extra.invalid, replies7: extra.replies7, optouts7: extra.optouts7 });
  });

  // اختيارات «الرابط يفتح إيه» + صور العروض — قوايم صغيرة للفورم
  app.get("/api/cms/wa-sender/options", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const safe = (p) => p.then((r) => r.rows).catch(() => []);
    const [offers, cols, media] = await Promise.all([
      safe(pool.query("SELECT id, title FROM offer_registry WHERE enabled ORDER BY updated_at DESC LIMIT 30")),
      safe(pool.query("SELECT id::text AS id, name AS title FROM cms_collections WHERE active ORDER BY sort, id LIMIT 30")),
      safe(pool.query(`SELECT id, filename, mime, created_at FROM content_media WHERE mime LIKE 'image/%'
                        ORDER BY created_at DESC LIMIT 24`)),
    ]);
    const base = API_BASE();
    return c.json({ ok: true, offers, collections: cols,
      images: media.map((m) => ({ id: m.id, name: m.filename, url: `${base}/api/content/media/${m.id}${/jpe?g/i.test(m.mime) ? ".jpg" : ""}` })) });
  });

  app.post("/api/cms/wa-sender/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await getSettingsData();
    const cur = (s.waSender && typeof s.waSender === "object") ? s.waSender : {};
    const allowed = ["enabled", "gapDays", "dailyCap", "hourCap", "minDelaySec", "maxDelaySec", "batchSize", "batchPauseMin",
      "startHour", "endHour", "days", "skipOnlineWithinDays", "skipOpenOrder", "footer", "failStop", "warmup"];
    const next = { ...cur };
    for (const k of allowed) if (b[k] !== undefined) next[k] = b[k];
    if (Number(next.gapDays) < MIN_GAP_DAYS) next.gapDays = MIN_GAP_DAYS;
    // التجميع: أول ما يتفعّل بيبدأ العدّ من النهاردة؛ لما يتقفل بيتنسي
    if (b.warmup !== undefined) {
      const w = warmupCfg(b.warmup), was = warmupCfg(cur.warmup);
      w.startedAt = w.enabled ? (was.enabled && was.startedAt ? was.startedAt : new Date(now()).toISOString()) : null;
      next.warmup = w;
    }
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

  const tplOf = (r, input) => input.template || r.globalTemplate || "";

  app.post("/api/cms/wa-sender/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const input = jobInput(b, { hosts: imageHosts() });
    const s = await getSettingsData();
    const r = await build(b.filters || {}, s);
    const tpl = tplOf(r, input);
    // العينة: أول ٥ + مثال واحد اترجعنا فيه لطلب أقدم (عشان المالك يشوف الفلتر شغّال)
    const pick = r.picked.slice(0, 5);
    const ex = r.picked.find((x) => x.skippedSmall > 0);
    if (ex && !pick.includes(ex)) pick.push(ex);
    const slug = input.link.slug || "w…";
    const couponEx = input.offer ? "W…" : input.link.coupon;
    const host = STORE();
    const sample = pick.map((x) => ({ name: x.name, phone: `${x.pn.slice(0, 3)}••••${x.pn.slice(-2)}`,
      orders: x.orders, spend: x.spend, daysAgo: x.daysAgo, lastTotal: x.lastTotal, skippedSmall: x.skippedSmall || 0,
      vars: { ...x.vars, link: recipientLink(host, slug, "xxxxxx"), coupon: couponEx || "", coupon_days: input.offer ? String(input.offer.validDays) : "" },
      message: messageFor(x, { template: tpl, footer: r.cfg.footer, host, slug, code: "xxxxxx", coupon: couponEx, couponDays: input.offer?.validDays }) }));
    const hold = input.holdoutPct ? r.picked.filter((x) => inHoldout("preview", x.pn, input.holdoutPct)).length : 0;
    const days = Math.ceil((r.picked.length - hold) / Math.max(1, effectiveDailyCap(r.cfg, now())));
    return c.json({ ok: true, audience: r.audience, inAudience: r.inAudience, afterFilters: r.afterFilters,
      excluded: r.excluded, eligible: r.eligible, willQueue: r.picked.length, holdoutEst: hold, estDays: days, sample,
      customTemplate: Boolean(input.template), template: tpl, footer: r.cfg.footer,
      problems: input.errs.map(([error, message]) => ({ error, message })) });
  });

  app.post("/api/cms/wa-sender/jobs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const input = jobInput(b, { hosts: imageHosts() });
    if (input.errs.length) return bad(c, input.errs[0][0], input.errs[0][1], 422);
    if (input.link.coupon) {
      const ok = (await pool.query("SELECT 1 FROM shop_coupons WHERE upper(code)=$1 AND active", [input.link.coupon])).rowCount;
      if (!ok) return bad(c, "coupon_invalid", `الكوبون ${input.link.coupon} مش موجود أو مقفول`, 422);
    }
    if (input.link.slug) {
      const taken = (await pool.query("SELECT 1 FROM cms_links WHERE slug=$1", [input.link.slug])).rowCount;
      if (taken) return bad(c, "slug_taken", "اسم الرابط ده مستخدم — اختار اسم تاني أو سيبه فاضي", 409);
    }
    const s = await getSettingsData();
    const r = await build(b.filters || {}, s);
    if (!r.picked.length) return bad(c, "empty", "مفيش حد مؤهل بالفلاتر دي");
    if (b.confirmCount != null && Number(b.confirmCount) !== r.picked.length) {
      return bad(c, "count_changed", `العدد اتغيّر (${r.picked.length}) — اعمل معاينة تاني`, 409);
    }
    const by = await whoOf(c);
    const name = String(b.name || "").trim().slice(0, 80) || `حملة ${new Date(now()).toISOString().slice(0, 10)}`;
    const aud = (await audienceList()).find((a) => a.id === r.audience);
    const tpl = tplOf(r, input);
    const host = STORE();
    const client = await pool.connect();
    let jobId, slug, holdN = 0;
    try {
      await client.query("BEGIN");
      jobId = Number((await client.query(
        `INSERT INTO wa_send_jobs(name, filters, total, created_by, template, holdout_pct, image_url, offer, audience_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [name, J(b.filters || {}), r.picked.length, by, input.template || null, input.holdoutPct, input.imageUrl,
          input.offer ? J(input.offer) : null, aud ? aud.label : r.audience])).rows[0].id);
      /* الرابط المتتبّع: /l/<slug> (utm_source=whatsapp, utm_campaign=wa-<id>) —
         وكل عميل بياخد /l/<slug>-<code> عشان نعرف مين ضغط (cms.js resolve). */
      slug = input.link.slug || `w${jobId}`;
      await client.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, active, created_by)
         VALUES ($1,$2,$3,$4,$5,'whatsapp','message',$6,true,$7)`,
        [slug, `واتساب: ${name}`.slice(0, 80), input.link.target_type, input.link.target_id, input.link.coupon, `wa-${jobId}`, by]);
      await client.query("UPDATE wa_send_jobs SET link_slug=$2 WHERE id=$1", [jobId, slug]);
      const codes = new Set();
      for (const x of r.picked) {
        const hold = input.holdoutPct > 0 && inHoldout(`wa${jobId}`, x.pn, input.holdoutPct);
        let code; do { code = newLinkCode(); } while (codes.has(code)); codes.add(code);
        let coupon = input.link.coupon || null;
        if (input.offer && !hold) {
          /* كوبون مرة واحدة ومقفول على جوال العميل. بيتعمل مقفول (active=false)
             وبيتفتح لحظة ما الرسالة تتبعت فعلاً — اللي ماتبعتلوش كوبونه مايشتغلش. */
          for (let k = 0; k < 4; k++) {
            const cc = newCouponCode(jobId);
            const ins = await client.query(
              `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer, free_delivery, phone_norm)
               VALUES ($1,$2,false,$3,1,NULL,$4,true,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING code`,
              [cc, input.offer.percent, input.offer.minTotal, `واتساب #${jobId} — ${x.pn.slice(-4)}`, input.offer.freeDelivery, x.pn]);
            if (ins.rowCount) { coupon = cc; break; }
          }
        }
        const msg = messageFor(x, { template: tpl, footer: r.cfg.footer, host, slug, code, coupon, couponDays: input.offer?.validDays });
        if (hold) holdN++;
        await client.query(
          `INSERT INTO wa_send_queue(job_id, phone_norm, name, message, score, status, reason, link_code, coupon)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [jobId, x.pn, x.name, msg, x.score || 0, hold ? "holdout" : "pending", hold ? "holdout" : null, code, hold ? null : coupon]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (String(e.message).includes("cms_links_slug_key") || String(e.message).includes("duplicate key")) {
        return bad(c, "slug_taken", "اسم الرابط اتاخد — جرّب تاني", 409);
      }
      throw e;
    } finally { client.release(); }
    return c.json({ ok: true, jobId, total: r.picked.length, holdout: holdN, slug, link: recipientLink(host, slug, null) });
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
      `SELECT q.id, q.phone_norm, q.name, q.status, q.reason, q.attempts, q.sent_at, q.message, q.clicks, q.replied_at,
              q.optout_at, q.media, q.note, q.coupon,
              (SELECT w.text FROM wa_replies w WHERE w.phone_norm = q.phone_norm AND w.at >= q.sent_at
                ORDER BY w.at DESC LIMIT 1) AS reply
         FROM wa_send_queue q WHERE q.job_id=$1
        ORDER BY (q.status='pending'), (q.status='holdout'), q.sent_at DESC NULLS LAST, q.score DESC LIMIT 500`, [Number(c.req.param("id"))]);
    return c.json({ ok: true, items: r.rows.map((x) => ({ ...x, id: Number(x.id),
      phone_norm: canSee ? x.phone_norm : `${x.phone_norm.slice(0, 3)}••••${x.phone_norm.slice(-2)}` })) });
  });

  /* ── إيقاف (من رد العميل أو زرار «طلب إيقاف») ─────────────────────────
     بيكتب في نفس cms_contacts اللي كل القنوات بتحترمه (SMS + واتساب + إشعارات)،
     وبيشيل الرقم من أي طابور واتساب لسه مابعتش. */
  async function optOut(pn, source, reason, actor) {
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code)
       VALUES ($1, substr(md5(random()::text || $1 || clock_timestamp()::text), 1, 10))
       ON CONFLICT (phone_norm) DO NOTHING`, [pn]);
    const r = await pool.query(
      `UPDATE cms_contacts SET opted_out_at = COALESCE(opted_out_at, NOW()),
              optout_source = CASE WHEN opted_out_at IS NULL THEN $2 ELSE optout_source END,
              optout_reason = CASE WHEN opted_out_at IS NULL THEN $3 ELSE optout_reason END,
              optout_by = CASE WHEN opted_out_at IS NULL THEN $4 ELSE optout_by END
        WHERE phone_norm=$1 RETURNING phone_norm`, [pn, source, String(reason || "").slice(0, 200), actor || null]);
    await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, reason, actor) VALUES ($1,'optout',$2,$3,$4)",
      [pn, source, String(reason || "").slice(0, 200), actor || null]).catch(() => {});
    await pool.query("UPDATE wa_send_queue SET status='skipped', reason='opted_out' WHERE phone_norm=$1 AND status='pending'", [pn]);
    await pool.query(
      `UPDATE wa_send_queue SET optout_at = COALESCE(optout_at, NOW())
        WHERE id = (SELECT id FROM wa_send_queue WHERE phone_norm=$1 AND status='sent' ORDER BY sent_at DESC LIMIT 1)`, [pn]);
    return r.rowCount > 0;
  }

  app.post("/api/cms/wa-sender/items/:id/optout", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = (await pool.query("SELECT phone_norm FROM wa_send_queue WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!q) return bad(c, "not_found", "مش موجود", 404);
    const by = await whoOf(c);
    await optOut(q.phone_norm, "wa_manual", "طلب إيقاف على واتساب (من اللوحة)", by);
    await pool.query("UPDATE wa_send_queue SET optout_at = COALESCE(optout_at, NOW()) WHERE id=$1", [Number(c.req.param("id"))]);
    return c.json({ ok: true });
  });

  /* ── نتيجة الحملة ────────────────────────────────────────────────────
     «اتحوّل» = طلب خلال ٧ أيام من الرسالة، بالجوال: الموقع (shop_orders
     المدفوعة) + نقطة البيع (ts_orders عبر order_sources/ts_customers).
     التطبيقات (كيتا/هنقر…) بتتعرض لوحدها — مش هدفنا. كل طلب بيتحسب مرة
     واحدة لآخر رسالة واتساب قبله (أي حملة أو يدوي). المحجوزين (holdout)
     بيبدأ عدّهم من أول رسالة في الحملة. */
  app.get("/api/cms/wa-sender/jobs/:id/results", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const job = (await pool.query("SELECT * FROM wa_send_jobs WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!job) return bad(c, "not_found", "مش موجودة", 404);
    const jobId = Number(job.id);
    const rows = (await pool.query(
      `SELECT phone_norm pn, status, reason, sent_at, clicks, replied_at, optout_at, media, coupon FROM wa_send_queue WHERE job_id=$1`, [jobId])).rows;
    const sent = rows.filter((x) => x.status === "sent");
    const hold = rows.filter((x) => x.status === "holdout");
    const count = (f) => rows.filter(f).length;
    const t0h = sent.length ? new Date(Math.min(...sent.map((x) => new Date(x.sent_at).getTime()))) : new Date(job.created_at);
    const pns = [...new Set([...sent, ...hold].map((x) => x.pn))];
    const linkRow = job.link_slug ? (await pool.query("SELECT clicks FROM cms_links WHERE slug=$1", [job.link_slug])).rows[0] : null;
    const base = { ok: true, id: jobId, name: job.name, status: job.status, slug: job.link_slug, windowDays: ATTR_DAYS,
      sent: sent.length, holdout: hold.length, failed: count((x) => x.status === "failed"),
      invalid: count((x) => x.reason === "invalid_number"), skipped: count((x) => x.status === "skipped"),
      pending: count((x) => ["pending", "sending"].includes(x.status)),
      replies: count((x) => x.replied_at), optouts: count((x) => x.optout_at),
      clicks: linkRow ? Number(linkRow.clicks) : null, clickers: count((x) => Number(x.clicks) > 0),
      images: count((x) => x.media === "image"), imageFallbacks: count((x) => x.status === "sent" && x.media === "text" && job.image_url) };
    if (!pns.length) return c.json({ ...base, direct: null, apps: null, web: null, pos: null });
    const from = new Date(Math.min(t0h.getTime(), ...sent.map((x) => new Date(x.sent_at).getTime())));
    const to = new Date(Math.max(t0h.getTime(), ...sent.map((x) => new Date(x.sent_at).getTime())) + ATTR_DAYS * 86400000);
    const [sends, web, pos, cpn] = await Promise.all([
      pool.query(`SELECT phone_norm pn, at, job_id FROM wa_contact_log WHERE phone_norm = ANY($1::text[]) AND at > $2::timestamptz - INTERVAL '8 days' AND at <= $3`,
        [pns, from, to]),
      pool.query(`SELECT 'web:' || so.order_no AS key, so.phone_norm pn, so.created_at at, so.total, so.coupon, so.attribution->>'fc_link' AS fc_link
                    FROM shop_orders so WHERE so.phone_norm = ANY($1::text[]) AND ${shopPaidSql("so")}
                     AND so.created_at >= $2 AND so.created_at <= $3`, [pns, from, to]),
      pool.query(`SELECT 'pos:' || o.order_id AS key, COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn, o.order_date at, o.total,
                         btrim(COALESCE(s.source_note,'')) AS note, o.order_type
                    FROM ts_orders o
                    LEFT JOIN order_sources s ON s.order_id = o.order_id
                    LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
                   WHERE (s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[]))
                     AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%' AND o.order_type NOT ILIKE '%parked%'))
                     AND o.order_date >= $2 AND o.order_date <= $3`, [pns, from, to]),
      // الكوبون بتاع الحملة استخدمه نفس المستلم بعد رسالته (الكوبون الثابت زي FIRST مابيتحسبش لغيره)
      pool.query(`SELECT count(DISTINCT so.order_no)::int n, COALESCE(sum(so.total),0)::float rev
                    FROM wa_send_queue q JOIN shop_orders so ON upper(so.coupon) = upper(q.coupon) AND so.phone_norm = q.phone_norm
                     AND so.created_at >= q.sent_at AND ${shopPaidSql("so")}
                   WHERE q.job_id=$1 AND q.status='sent' AND q.coupon IS NOT NULL`, [jobId]),
    ]);
    const webO = web.rows.map((o) => ({ ...o, channel: "web" }));
    // مرايا طلبات الموقع في نقطة البيع (ملاحظة W…) أو نفس الإجمالي في نفس الوقت ⇒ مش طلب تاني
    const posO = dropPosMirrors(pos.rows.filter((o) => !/^W\d+/.test(o.note)), webO)
      .map((o) => ({ ...o, channel: o.note || /^external$/i.test(String(o.order_type || "")) ? "app" : "pos" }));
    const allOrders = [...webO, ...posO];
    const credit = creditOrders(sends.rows.map((x) => ({ pn: x.pn, at: x.at, jobId: x.job_id == null ? null : Number(x.job_id) })), allOrders, ATTR_DAYS);
    const mine = allOrders.filter((o) => credit.get(o.key)?.jobId === jobId);
    const holdSet = new Set(hold.map((x) => x.pn));
    const holdOrders = allOrders.filter((o) => holdSet.has(o.pn) && !credit.has(o.key)
      && new Date(o.at) >= t0h && new Date(o.at) - t0h <= ATTR_DAYS * 86400000);
    const direct = summarizeResults({ sentN: sent.length, holdN: hold.length,
      sentOrders: mine.filter((o) => o.channel !== "app"), holdOrders: holdOrders.filter((o) => o.channel !== "app") });
    const sum = (l) => ({ orders: l.length, revenue: Math.round(l.reduce((s, o) => s + (Number(o.total) || 0), 0)), people: new Set(l.map((o) => o.pn)).size });
    return c.json({ ...base,
      direct, web: sum(mine.filter((o) => o.channel === "web")), pos: sum(mine.filter((o) => o.channel === "pos")),
      apps: sum(mine.filter((o) => o.channel === "app")), holdoutApps: sum(holdOrders.filter((o) => o.channel === "app")),
      viaLink: sum(mine.filter((o) => o.channel === "web" && o.fc_link === job.link_slug)),
      coupons: { redeemed: cpn.rows[0].n, revenue: Math.round(cpn.rows[0].rev) },
      holdoutStart: t0h });
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
      if ((await invalidSet([q.phone_norm])).size) { await skip("invalid_number"); continue; }
      const rec = await recentMap([q.phone_norm], cfg.gapDays);
      if (rec.size) { await skip(rec.get(q.phone_norm) === "sms" ? "gap_sms" : "gap_3d"); continue; }
      const blk = await blockedSets([q.phone_norm], cfg);
      if (blk.onlineRecent.size) { await skip("ordered_online"); continue; }
      if (blk.openOrder.size) { await skip("open_order"); continue; }
      await pool.query("UPDATE wa_sender_state SET next_gap_sec=$1 WHERE id=1", [p.nextGapSec]);
      const job = (await pool.query("SELECT image_url FROM wa_send_jobs WHERE id=$1", [q.job_id])).rows[0] || {};
      return c.json({ ok: true, wait: 0, item: { id: Number(q.id), phone: `966${q.phone_norm}`, text: q.message,
        ...(job.image_url ? { image: job.image_url } : {}) } });
    }
    return c.json({ ok: true, wait: 30, reason: "skipped_batch" });
  });

  app.post("/api/wa-sender/agent/result", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const id = Number(b.id);
    const q = (await pool.query("SELECT id, job_id, phone_norm, status, coupon FROM wa_send_queue WHERE id=$1", [id])).rows[0];
    if (!q) return bad(c, "not_found", "مش موجودة", 404);
    if (q.status !== "sending") return c.json({ ok: true, already: true });
    const media = ["image", "text"].includes(b.media) ? b.media : null;
    const note = b.note ? String(b.note).slice(0, 80) : null;
    if (b.ok === true) {
      await pool.query("UPDATE wa_send_queue SET status='sent', sent_at=NOW(), reason=NULL, media=$2, note=$3 WHERE id=$1", [id, media, note]);
      await pool.query("INSERT INTO wa_contact_log(phone_norm, channel, job_id) VALUES ($1,'auto',$2)", [q.phone_norm, q.job_id]);
      await pool.query(
        `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak=0,
                since_break = CASE WHEN since_break >= $1 THEN 1 ELSE since_break + 1 END WHERE id=1`, [cfg.batchSize]);
      // الكوبون مرة واحدة بيتفتح دلوقتي بس، وصلاحيته من يوم الإرسال
      if (q.coupon) {
        const job = (await pool.query("SELECT offer FROM wa_send_jobs WHERE id=$1", [q.job_id])).rows[0] || {};
        const days = Number(job.offer?.validDays) || 0;
        if (job.offer?.oneTime && days) {
          await pool.query(
            `UPDATE shop_coupons SET active=true, expires_at = CURRENT_DATE + $3::int
              WHERE code=$1 AND phone_norm=$2 AND NOT active AND used_count=0`, [q.coupon, q.phone_norm, days]).catch(() => {});
        }
      }
    } else {
      const reason = String(b.reason || "failed").slice(0, 60);
      // رقم مش على واتساب = مش غلطة الإضافة، مابيعدّش في «فشل ورا بعض» — وبيتحفظ عشان مايدخلش حملة تانية
      const notOnWa = reason === "invalid_number";
      await pool.query("UPDATE wa_send_queue SET status='failed', reason=$2, note=$3 WHERE id=$1", [id, reason, note]);
      if (notOnWa) {
        await pool.query(
          `INSERT INTO wa_invalid_numbers(phone_norm, job_id) VALUES ($1,$2)
           ON CONFLICT (phone_norm) DO UPDATE SET hits = wa_invalid_numbers.hits + 1, at = NOW(), job_id = EXCLUDED.job_id`,
          [q.phone_norm, q.job_id]);
      }
      await pool.query(
        `UPDATE wa_sender_state SET last_sent_at=NOW(), fail_streak = CASE WHEN $1 THEN fail_streak ELSE fail_streak+1 END WHERE id=1`, [notOnWa]);
    }
    return c.json({ ok: true });
  });

  /* ردود العملاء: الإضافة بتقرا الفقاعات الجاية (.message-in) في المحادثة اللي
     لسه باعتين فيها، أو معاينة المحادثات اللي فيها رسايل ماتقرتش. بنقبل بس
     من رقم بعتناله آلي في آخر ٣٠ يوم — محادثات المحل التانية مابتتسجّلش. */
  app.post("/api/wa-sender/agent/reply", async (c) => {
    const cfg = await agentAuth(c);
    if (!cfg) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const pn = normLocal(b.phone);
    const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!pn || !text) return bad(c, "bad_input", "رقم أو نص ناقص");
    const last = (await pool.query(
      `SELECT id, job_id, sent_at FROM wa_send_queue WHERE phone_norm=$1 AND status='sent' AND sent_at > NOW() - INTERVAL '30 days'
        ORDER BY sent_at DESC LIMIT 1`, [pn])).rows[0];
    if (!last) return c.json({ ok: true, ignored: "no_recent_send" });
    const ext = String(b.extId || "").slice(0, 200) || `h:${sha(text).slice(0, 20)}`;
    const opt = isOptOutText(text);
    const ins = await pool.query(
      `INSERT INTO wa_replies(phone_norm, text, ext_id, source, job_id, queue_id, is_optout)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (phone_norm, ext_id) DO NOTHING RETURNING id`,
      [pn, text, ext, b.source === "list" ? "list" : "chat", last.job_id, last.id, opt]);
    if (!ins.rowCount) return c.json({ ok: true, duplicate: true });
    await pool.query("UPDATE wa_send_queue SET replied_at = COALESCE(replied_at, NOW()) WHERE id=$1", [last.id]);
    if (opt) await optOut(pn, "wa_web", text, "واتساب ويب");
    return c.json({ ok: true, optout: opt });
  });

  app.get("/api/cms/wa-sender/replies", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const canSee = typeof ctx.canSeePhones === "function" ? await ctx.canSeePhones(c) : false;
    const r = await pool.query(
      `SELECT w.id, w.phone_norm, w.text, w.source, w.is_optout, w.at, w.job_id, j.name AS job_name
         FROM wa_replies w LEFT JOIN wa_send_jobs j ON j.id = w.job_id ORDER BY w.at DESC LIMIT 100`);
    return c.json({ ok: true, replies: r.rows.map((x) => ({ ...x, id: Number(x.id),
      phone_norm: canSee ? x.phone_norm : `${x.phone_norm.slice(0, 3)}••••${x.phone_norm.slice(-2)}` })) });
  });

  return { recentSet, recentMap, build };
}
