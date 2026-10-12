/* ════════════════════════════════════════════════════════════════════════════
   اختبارات بوت واتساب v1 (wabotrun.js) — ١٢/١٠/٢٠٢٦
   المحادثات هنا بتعدّي من الويب هوك الحقيقي (whatsapp.processWebhook) لحد طلب Graph نفسه (fetch مزيّف)،
   فالتأكيد على **جسم الرسالة الخارجة بالظبط**، وعلى إن مفيش ولا طلب شبكة لما المفروض نسكت.
     node --test wabotrun.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import * as C from "./waconsent.js";
import * as AIC from "./waaicost.js";
const W = await import("./whatsapp.js");
const R = await import("./wabotrun.js");
const LLM = await import("./wabotllm.js");
/* المنيو والبوكسات الحيّة يوم ١٢/١٠ (ملف اختبار) — الشجرة والتصنيف بيتجرّبوا على الأسماء والأسعار الحقيقية */
const LIVE = JSON.parse(fs.readFileSync(new URL("./wabot-live.fixture.json", import.meta.url), "utf8"));

const BIZ = "966546715683";
const HOURS = { enabled: true, days: { fri: { open: "12:00", close: "03:00" }, mon: { open: "12:00", close: "02:00" }, sat: { open: "12:00", close: "02:00" },
  sun: { open: "12:00", close: "02:00" }, thu: { open: "12:00", close: "03:00" }, tue: { open: "12:00", close: "02:00" }, wed: { open: "12:00", close: "02:00" } } };
const BUNDLES = [
  { slug: "gathering-4", price: 225, section: "" },
  { slug: "box-solo-crepe", price: 29, section: "بوكسات فردية", section_en: "Solo boxes" },
  { slug: "box-solo-mixgrill", price: 39, section: "بوكسات فردية", section_en: "Solo boxes" },
  { slug: "box-crepe-duo", price: 65, section: "بوكسات لشخصين", section_en: "Boxes for two" },
  { slug: "box-mixgrill-duo", price: 85, section: "بوكسات لشخصين", section_en: "Boxes for two" },
  { slug: "box-pizza-night", price: 85, section: "بوكسات المشاركة والعائلة", section_en: "Sharing boxes" },
  { slug: "box-family", price: 179, section: "بوكسات المشاركة والعائلة", section_en: "Sharing boxes" },
];
const POLICY = { type: "distance_tiers", maxKm: 10, farZoneEnabled: true, farZoneMaxKm: 15, farZonePerKm: 3, farZoneFromKm: 10,
  feeByTotal: [{ fee: 20, over: 0 }, { fee: 15, over: 60 }, { fee: 10, over: 80 }, { fee: 5, over: 100 }, { fee: 0, over: 150 }] };
const FIRST = { code: "FIRST", min_total: "60", free_delivery: true, once_per_customer: true, active: true, expires_at: null };
const FAQ = [{ q: "ما طرق الدفع؟", a: "الدفع الإلكتروني عبر Apple Pay وmada والبطاقات الائتمانية وSTC Pay.", a_en: "Online payment with Apple Pay, mada, credit cards and STC Pay." }];
const OPEN_AT = "2026-10-12T15:00:00Z";     // الاثنين ١٨:٠٠ الرياض — مفتوح
const CLOSED_AT = "2026-10-12T05:00:00Z";   // الاثنين ٠٨:٠٠ الرياض — مقفل، يفتح اليوم ١٢ ظهراً
const FOOTER = "رد آلي · اكتب «القائمة» للرجوع أو «موظف»";
const BOXES = "🎁 بوكساتنا:\n• بوكسات فردية من 29 ر.س\n• بوكسات لشخصين من 65 ر.س\n• بوكسات المشاركة والعائلة من 85 ر.س";
const FIRST_LINE = "🎁 أول طلب توصيل لك من الموقع توصيله مجاني للطلبات من 60 ر.س وأكثر داخل نطاق التوصيل (كود FIRST يتطبّق تلقائياً).";

const ENV = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "META_CAPI_TOKEN", "WHATSAPP_BOT_ENABLED"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };          // مفتاح العملاء مقفول
const LOCKS_OPEN = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };

/* ── عالم صغير: قاعدة في الذاكرة + ساعة + Graph مزيّف ─────────────────────── */
function world({ waBot = {}, notifications = { whatsappEnabled: true }, orders = [], bundles = BUNDLES, policy = POLICY, first = FIRST, links = ["wab-boxes", "wa-boxes", "wa-box-d4"],
  at = OPEN_AT, graph = null, failDb = null, extraSettings = {}, disclosure = false, pages = LIVE.pages, quote = null, llm = null, greetMenu = false, offers = LIVE.offers } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; }, set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { msgs: [], log: [], jobs: [], proofs: [], consentLog: [], ai: [], aiAlerts: [], tpl: [], cfgLog: [], chats: new Map(), optouts: [], optins: {}, links: links.map((s) => ({ slug: s, active: true, clicks: 0 })), settings: null };
  db.settings = { hours: HOURS, notifications, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: FAQ } },
    cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 } }, delivery: { alertPhones: ["0544775082", "0506338246"], staffSmsLanguage: "en" }, waBot: { footerMode: "always", ...waBot },
    waMaster: { enabled: true },   // SEC: مفتاح المالك الرئيسي (whatsapp.js guardSend) — مفتوح في العالم الافتراضي للاختبار
    ...extraSettings };
  const iso = () => new Date(nowMs).toISOString();
  const chat = (p) => { if (!db.chats.has(p)) db.chats.set(p, { phone_norm: p, unknown_streak: 0, ...(disclosure ? {} : { last_disclosed_at: iso() }) }); return db.chats.get(p); };
  const pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (failDb && failDb.test(s)) throw new Error("db down");
      if (/^CREATE TABLE|^DELETE FROM wa_bot_log|wa_webhook_health|wa_contact_names|wa_threads/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO wa_bot_config_log/i.test(s)) { db.cfgLog.push({ id: db.cfgLog.length + 1, at: iso(), who: p[0], changes: JSON.parse(p[1]) }); return { rows: [] }; }
      if (/FROM wa_bot_config_log/i.test(s)) return { rows: [...db.cfgLog].reverse() };
      if (/^SELECT text, reply_key AS key, handoff, phone_norm AS phone, detail FROM wa_bot_log/i.test(s)) return { rows: db.log.filter((l) => l.text).map((l) => ({ text: l.text, key: l.reply_key, handoff: l.handoff || null, phone: l.phone_norm, detail: l.detail || null })).reverse() };
      // ── ai_calls (waaicost.js)
      if (/^INSERT INTO ai_calls/i.test(s)) { db.ai.push({ id: db.ai.length + 1, at: iso(), purpose: p[0], provider: p[1], model: p[2], in_tokens: p[3], out_tokens: p[4], cached_tokens: p[5], estimated: p[6], cost_sar: p[7], priced: p[8], price_date: p[9],
        ms: p[10], chat_hash: p[11], outcome: p[12], detail: p[13], sent_text: p[14], prompt_chars: p[15], prompt_hash: p[16], log_id: p[17] }); return { rows: [] }; }
      if (/FROM ai_calls/i.test(s)) {
        const k = AIC.riyadhKeys(new Date(nowMs)), kOf = (a) => AIC.riyadhKeys(new Date(a.at)), sum = (l) => l.reduce((x, a) => x + Number(a.cost_sar), 0);
        if (/AS day, COALESCE\(sum\(cost_sar\), 0\)::float AS month/i.test(s)) { const m = db.ai.filter((a) => kOf(a).month === k.month && (!p[0] || a.purpose === p[0])); return { rows: [{ day: sum(m.filter((a) => kOf(a).day === k.day)), month: sum(m) }] }; }
        if (/^SELECT count\(\*\)::int AS calls/i.test(s)) {
          const l = db.ai.filter((a) => (!p[0] || a.purpose === p[0]) && (/date_trunc\('day'/.test(s) ? kOf(a).day === k.day : /7 days/.test(s) ? nowMs - Date.parse(a.at) < 7 * 86400_000 : kOf(a).month === k.month));
          return { rows: [{ calls: l.length, cost: sum(l), ms: l.length ? l.reduce((x, a) => x + a.ms, 0) / l.length : 0, tin: l.reduce((x, a) => x + a.in_tokens, 0), tout: l.reduce((x, a) => x + a.out_tokens, 0), tcached: l.reduce((x, a) => x + a.cached_tokens, 0),
            chats: new Set(l.map((a) => a.chat_hash)).size, estimated: l.filter((a) => a.estimated).length, accepted: l.filter((a) => a.outcome === "accepted").length }] };
        }
        if (/GROUP BY 1/i.test(s)) { const g = {}; for (const a of db.ai) g[a.outcome] = (g[a.outcome] || 0) + 1; return { rows: Object.entries(g).map(([outcome, n]) => ({ outcome, n })) }; }
        return { rows: [...db.ai].reverse().slice(0, p[0]) };
      }
      if (/^UPDATE wa_bot_log SET detail=.2 WHERE id=.1/i.test(s)) { const l = db.log.find((x) => x.id === p[0]); if (l) l.detail = p[1]; return { rows: [] }; }
      if (/^INSERT INTO ai_budget_alerts/i.test(s)) { if (db.aiAlerts.includes(p[0])) return { rows: [] }; db.aiAlerts.push(p[0]); return { rows: [{ key: p[0] }] }; }
      if (/ai_budget_alerts/i.test(s)) return { rows: db.aiAlerts.map((key) => ({ key })) };
      if (/^SELECT count\(\*\)::int AS n FROM wa_bot_log WHERE at >= \(date_trunc\('month'/i.test(s)) return { rows: [{ n: db.log.length }] };
      if (/FROM wa_messages WHERE direction='out' AND template IS NOT NULL/i.test(s)) return { rows: db.tpl };
      if (/^INSERT INTO cms_links/i.test(s)) { if (!db.links.find((l) => l.slug === p[0])) db.links.push({ slug: p[0], active: true, clicks: 0, seeded: true }); return { rows: [] }; }
      if (/FROM cms_links WHERE slug = ANY/i.test(s)) return { rows: db.links.filter((l) => p[0].includes(l.slug) && l.active) };
      // SEC: نافذة الـ٢٤ ساعة اللي الحارس المركزي بيتأكد منها قبل أي رد حر
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) {
        const n = db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "in" && m.source !== "history" && nowMs - Date.parse(m.created_at) < 24 * 3600_000).length;
        return { rows: n ? [{}] : [], rowCount: n ? 1 : 0 };
      }
      if (/^INSERT INTO wa_messages/i.test(s)) {
        if (p[0] && db.msgs.some((m) => m.wamid === p[0])) return { rows: [], rowCount: 0 };
        const echo = /'echo'/.test(s), inbound = /'in'/.test(s);
        const row = inbound ? { wamid: p[0], direction: "in", phone_norm: p[1], body: p[2], source: "api", created_at: iso() }
          : echo ? { wamid: p[0], direction: "out", phone_norm: p[1], body: p[2], source: "echo", created_at: iso() }
            : { wamid: p[0], direction: "out", phone_norm: p[1], template: p[2], status: p[6], body: p[8], source: p[10], created_at: iso() };
        db.msgs.push(row);
        return { rows: [{ id: db.msgs.length }], rowCount: 1 };
      }
      if (/^SELECT max\(created_at\) AS at FROM wa_messages WHERE phone_norm=\$1 AND source='echo'/i.test(s)) {
        const e = db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && nowMs - Date.parse(m.created_at) < 24 * 3600_000).map((m) => m.created_at).sort().pop();
        return { rows: [{ at: e || null }] };
      }
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND source='echo' AND created_at > \$2/i.test(s)) {
        return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && Date.parse(m.created_at) > Date.parse(p[1])).map(() => ({})) };
      }
      if (/^INSERT INTO wa_bot_jobs/i.test(s)) {
        if (p[0] && db.jobs.some((j) => j.wamid === p[0])) return { rows: [], rowCount: 0 };
        const j = { id: db.jobs.length + 1, wamid: p[0], phone_norm: p[1], kind: p[2], due_at: p[3], ev: JSON.parse(p[4]), log_id: p[5], status: "pending", reason: null };
        db.jobs.push(j); return { rows: [{ id: j.id }], rowCount: 1 };
      }
      if (/^SELECT id FROM wa_bot_jobs WHERE status='pending' AND due_at <= \$1/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "pending" && Date.parse(j.due_at) <= Date.parse(p[0])).map((j) => ({ id: j.id })) };
      if (/^UPDATE wa_bot_jobs SET status='running' WHERE id=\$1 AND status='pending'/i.test(s)) {
        const j = db.jobs.find((x) => x.id === p[0] && x.status === "pending");
        if (!j) return { rows: [], rowCount: 0 };
        j.status = "running"; return { rows: [{ ...j }], rowCount: 1 };
      }
      if (/^UPDATE wa_bot_jobs SET status=\$2, reason=\$3/i.test(s)) { const j = db.jobs.find((x) => x.id === p[0]); j.status = p[1]; j.reason = p[2]; return { rows: [] }; }
      if (/^UPDATE wa_bot_jobs SET status='cancelled', reason='manual_mute'/i.test(s)) { for (const j of db.jobs) if (j.phone_norm === p[0] && j.status === "pending") { j.status = "cancelled"; j.reason = "manual_mute"; } return { rows: [] }; }
      if (/FROM wa_bot_jobs WHERE status='pending'/i.test(s)) return { rows: [{ n: db.jobs.filter((j) => j.status === "pending").length }] };
      if (/FROM wa_messages WHERE phone_norm=\$1 AND source='echo'/i.test(s)) {
        const n = db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && nowMs - Date.parse(m.created_at) < p[1] * 3600_000).length;
        return { rows: [], rowCount: n };
      }
      if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
      if (/^INSERT INTO wa_optin_proofs/i.test(s)) { db.proofs.push({ phone_norm: p[0], answer: p[1], wording: p[2], lang: p[3], asked_at: p[4], answer_wamid: p[5], at: iso() }); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET handoff_reminded_at=NOW\(\)/i.test(s)) { chat(p[0]).handoff_reminded_at = iso(); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET optin_asked_at=NOW\(\)/i.test(s)) { chat(p[0]).optin_asked_at = iso(); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET optin_answered_at=NOW\(\)/i.test(s)) { chat(p[0]).optin_answered_at = iso(); return { rows: [] }; }
      if (/^UPDATE wa_bot_log SET reply_arg=\$2/i.test(s)) { const l = db.log.find((x) => x.id === p[0]); if (l) l.reply_arg = p[1]; return { rows: [] }; }
      if (/^UPDATE wa_bot_log SET intent=\$2, reply_key=\$3, detail=\$4/i.test(s)) { const l = db.log.find((x) => x.id === p[0]); Object.assign(l, { intent: p[1], reply_key: p[2], detail: p[3] }); return { rows: [] }; }
      if (/FROM wa_messages WHERE direction='in'/i.test(s)) return { rows: db.msgs.filter((m) => m.direction === "in").map((m) => ({ wamid: m.wamid, phone_norm: m.phone_norm, body: m.body, msg_type: "text", created_at: m.created_at })).reverse() };
      if (/^INSERT INTO wa_optins\(phone_norm, updates, marketing, source, order_no, updates_answered_at, updates_version\)/i.test(s)) {   // waconsent.js — the shared consent storage
        const cur = db.optins[p[0]] || {}; db.optins[p[0]] = { updates: p[1], marketing: cur.marketing ?? false, source: p[2], updates_answered_at: iso(), updates_version: p[4] }; return { rows: [] }; }
      if (/^INSERT INTO wa_optin_log/i.test(s)) { db.consentLog.push({ phone_norm: p[0], kind: "updates", value: p[1], text_version: p[2], text: p[3], source: p[4], order_no: p[5], ip: p[6], ua: p[7], at: iso() }); return { rows: [] }; }
      if (/^INSERT INTO wa_optins/i.test(s)) { const cur = db.optins[p[0]] || {}; db.optins[p[0]] = { ...cur, updates: p[1] ?? cur.updates ?? false, marketing: p[2] ?? cur.marketing ?? false }; return { rows: [] }; }
      if (/^UPDATE cms_contacts/i.test(s)) { db.optouts.push(p[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: db.optouts.includes(p[0]) ? 1 : 0 };
      if (/^INSERT INTO wa_bot_log/i.test(s)) {
        if (p[0] && db.log.some((l) => l.wamid === p[0])) return { rows: [], rowCount: 0 };
        const row = { id: db.log.length + 1, wamid: p[0], msg_at: p[1], phone_norm: p[2], mode: p[3], msg_type: p[4], text: p[5], intent: p[6], reply_key: p[7], score: p[8], lang: p[9], decision: "pending", referral: p[10], at: iso() };
        db.log.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (/^UPDATE wa_bot_log SET decision/i.test(s)) {
        const l = db.log.find((x) => x.id === p[0]);
        Object.assign(l, { decision: p[1], reason: p[2], detail: p[3] ?? l.detail ?? null, reply_key: p[4] || l.reply_key, replies: p[5] ? JSON.parse(p[5]) : null, sent: p[6], error: p[7], handoff: p[8], alert: p[9], link_slug: p[10], resume_at: p[11] || null });
        return { rows: [], rowCount: 1 };
      }
      if (/count\(\*\) FILTER \(WHERE decision IN \('replied','dry'\) AND at > NOW\(\) - INTERVAL '1 hour'\)/i.test(s)) {
        const rows = db.log.filter((l) => l.phone_norm === p[0] && ["replied", "dry"].includes(l.decision) && nowMs - Date.parse(l.at) < 3600_000);
        const same = rows.filter((l) => l.reply_key === p[1] && (l.reply_arg || "") === (p[2] || "")).map((l) => l.at).sort().pop() || null;
        const failed = db.log.filter((l) => l.phone_norm === p[0] && l.decision === "failed" && !/^skipped:/.test(l.error || "") && nowMs - Date.parse(l.at) < 600_000).map((l) => l.at).sort().pop() || null;
        const cnt = rows.filter((l) => !["rate", "rate_burst", "handoff_remind"].includes(l.reply_key)), tap = (l) => l.msg_type === "interactive", first = (l) => l.map((x) => x.at).sort()[0] || null;
        const txt = cnt.filter((l) => !tap(l)), taps = cnt.filter(tap), min1 = cnt.filter((l) => nowMs - Date.parse(l.at) < 60_000), last = (k) => rows.filter((l) => l.reply_key === k).map((l) => l.at).sort().pop() || null;
        return { rows: [{ n: rows.length, n_text: txt.length, oldest_text: first(txt), n_tap: taps.length, oldest_tap: first(taps), n_min: min1.length, oldest_min: first(min1), rate_at: last("rate"), burst_at: last("rate_burst"), same_at: same, failed_at: failed }] };
      }
      if (/FROM wa_bot_log WHERE alert='sent'/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.alert === "sent" && nowMs - Date.parse(l.at) < 3600_000).length }] };
      if (/^SELECT \* FROM wa_bot_chats WHERE phone_norm/i.test(s)) return { rows: db.chats.has(p[0]) ? [{ ...db.chats.get(p[0]) }] : (disclosure ? [] : [{ phone_norm: p[0], unknown_streak: 0, last_disclosed_at: iso() }]) };
      if (/^INSERT INTO wa_bot_chats\(phone_norm, referral, referral_at\)/i.test(s)) { Object.assign(chat(p[0]), { referral: JSON.parse(p[1]), referral_at: iso() }); return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, last_greet_at, unknown_streak, last_key, last_key_at, last_disclosed_at\)/i.test(s)) {
        const c = chat(p[0]);
        if (p[1]) c.last_greet_at = iso();
        if (p[4]) c.last_disclosed_at = iso();
        c.unknown_streak = p[2] ? (c.unknown_streak || 0) + 1 : 0;
        c.last_key = p[3]; c.last_key_at = iso();
        return { rows: [] };
      }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, handoff_at, handoff_reason\)/i.test(s)) { Object.assign(chat(p[0]), { handoff_at: iso(), handoff_reason: p[1], unknown_streak: 0 }); return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, muted_until, mute_reason, muted_by\)/i.test(s)) { Object.assign(chat(p[0]), { muted_until: new Date(nowMs + p[1] * 3600_000).toISOString(), mute_reason: "manual", muted_by: p[2] }); return { rows: [] }; }
      if (/FROM wa_bot_chats c LEFT JOIN LATERAL/i.test(s)) return { rows: [...db.chats.values()].map((c) => ({ ...c })) };
      if (/FROM wa_bot_log WHERE decision='replied' AND at >=/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.decision === "replied").length }] };
      if (/^UPDATE wa_bot_chats SET muted_until=NULL/i.test(s)) { const clear = { muted_until: null, mute_reason: null, handoff_at: null, handoff_reason: null, unknown_streak: 0 }; if (p[0]) Object.assign(chat(p[0]), clear); else for (const c of db.chats.values()) Object.assign(c, clear, { last_greet_at: null }); return { rows: [] }; }
      if (/FROM wa_bot_chats WHERE muted_until > NOW\(\)/i.test(s) && /count/.test(s)) return { rows: [{ n: [...db.chats.values()].filter((c) => c.muted_until && Date.parse(c.muted_until) > nowMs).length }] };
      if (/FROM dl_policies/i.test(s)) return { rows: policy ? [{ config: policy }] : [] };
      if (/FROM shop_coupons WHERE code=\$1/i.test(s)) return { rows: first && first.code === p[0] ? [first] : [] };
      if (/FROM shop_orders WHERE order_no=\$1 AND phone_norm=\$2/i.test(s)) return { rows: orders.filter((o) => o.order_no === p[0] && o.phone_norm === p[1]) };
      if (/FROM shop_orders WHERE phone_norm=\$1/i.test(s)) return { rows: orders.filter((o) => o.phone_norm === p[0]).slice(-1) };
      if (/^UPDATE settings SET data = jsonb_set/i.test(s)) { db.settings.waBot = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const r = graph ? graph(body, calls.length) : null;
    if (r && r.error) return { ok: false, status: 400, json: async () => ({ error: r.error }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OUT${calls.length}` }] }) };
  };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE"),
    request: async () => ({ ok: bundles !== null, status: bundles === null ? 500 : 200, json: async () => ({ ok: true, bundles }) }) };
  let owner = true;
  const actor = { who: { id: 7, username: "omar", name: "عمر", role: "owner" } };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""), isOwner: () => owner };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const sms = [];
  const bot = R.register(app, ctx, { app, wa, now: clock.now, noTimer: true, whoami: async () => actor.who, sendSms: async (x) => { sms.push(x); return { ok: true }; },
    fetchMenuPages: async () => { if (pages === null) throw new Error("menu down"); return pages; }, quote: async (lat, lng) => (typeof quote === "function" ? quote(lat, lng) : quote), llm,
    fetchOffers: async () => { if (offers === null) throw new Error("offers down"); return offers; } });
  let seq = 0;
  const hook = (field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: BIZ, phone_number_id: "PHONE1" }, ...value } }] }] });
  const ts = (agoMin = 0) => String(Math.floor((nowMs - agoMin * 60_000) / 1000));
  async function say(text, { from = "966512345678", id = null, type = "text", referral = null, agoMin = 0, raw = null } = {}) {
    const wamid = id || `wamid.IN${++seq}`;
    const msg = raw ? { from, id: wamid, timestamp: ts(agoMin), ...raw } : { from, id: wamid, timestamp: ts(agoMin), type, text: { body: text }, ...(referral ? { referral } : {}) };
    const before = calls.length;
    await wa.processWebhook(hook("messages", { messages: [msg] }));
    const all = calls.slice(before).map((c) => c.body);
    const isGreetMenu = (x) => x.type === "interactive" && x.interactive.type === "list" && x.interactive.body.text === "أو اختر من القائمة 👇";
    return { wamid, sent: greetMenu ? all : all.filter((x) => !isGreetMenu(x)), all, log: db.log.find((l) => l.wamid === wamid) || null };
  }
  const press = (buttonId, title, o = {}) => say(null, { ...o, raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title } } } });
  const cashier = (text, to = "966512345678") => wa.processWebhook(hook("smb_message_echoes", { message_echoes: [{ from: BIZ, to, id: `wamid.ECHO${++seq}`, timestamp: ts(), type: "text", text: { body: text } }] }));
  const call = async (method, path, json = {}, query = {}) => routes[`${method} ${path}`]({ req: { json: async () => json, query: (k) => query[k], header: () => undefined, text: async () => "" }, json: (body, status = 200) => ({ body, status }) });
  /* وقت الرد المؤجّل: نقدّم الساعة ونشغّل دورة الردود المؤجّلة؛ بيرجّع اللي اتبعت فيها */
  const tick = async (min = 0) => { clock.advance(min); const before = calls.length; await bot.runDueJobs(); return calls.slice(before).map((c) => c.body); };
  return { db, clock, calls, sms, say, press, cashier, call, wa, bot, tick, setOwner: (v) => { owner = v; }, setActor: (v) => { actor.who = v; }, setMode: (m) => { db.settings.waBot = { ...db.settings.waBot, mode: m }; } };
}
const cta = (to, body, title, url) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
  interactive: { type: "cta_url", body: { text: body }, footer: { text: FOOTER }, action: { name: "cta_url", parameters: { display_text: title, url } } } });
const txt = (to, body, preview = false) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body, preview_url: preview } });
const ME = "966512345678";
const order = (o = {}) => ({ order_no: "W1790011111111", phone_norm: "512345678", status: "accepted", option: "delivery", total: "86.50", created_at: new Date(Date.parse(OPEN_AT) - 20 * 60_000).toISOString(),
  pos_ready_at: null, handed_at: null, refund_id: null, table_no: null, ...o });

/* ── ١) الأقفال والأوضاع ─────────────────────────────────────────────────── */
test("off (the default): the bot does not touch the message — no log row, no send, no alert", withEnv(LOCKS_OPEN, async () => {
  const w = world({});
  assert.equal(R.botConfig({}).mode, "off");
  const r = await w.say("السلام عليكم");
  assert.equal(r.sent.length, 0); assert.equal(w.db.log.length, 0); assert.equal(w.sms.length, 0);
  // an unknown mode value is «off», never «live»
  assert.equal(R.botConfig({ waBot: { mode: "LIVE" } }).mode, "off");
  assert.equal(R.botConfig({ waBot: { mode: true } }).mode, "off");
}));

test("dry run: decides and logs the exact payload it WOULD send, sends nothing and alerts nobody", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "dry" } });
  const a = await w.say("السلام عليكم");
  assert.equal(a.sent.length, 0);
  assert.equal(a.log.decision, "dry"); assert.equal(a.log.reply_key, "greet"); assert.equal(a.log.sent, 0);
  assert.equal(a.log.replies[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  const b = await w.say("الأكل وصل بارد وناقص");
  assert.equal(b.log.decision, "dry"); assert.equal(b.log.handoff, "complaint"); assert.equal(b.log.alert, "would");
  assert.equal(w.calls.length, 0); assert.equal(w.sms.length, 0);
}));

test("test mode: replies ONLY to the allow-list, with the customer switches still OFF", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "test", testPhones: ["0544775082", "+966561186075"] }, notifications: {} });
  assert.deepEqual(R.botConfig(w.db.settings).testPhones, ["544775082", "561186075"]);
  const stranger = await w.say("السلام عليكم", { from: "966512345678" });
  assert.equal(stranger.sent.length, 0); assert.equal(stranger.log.decision, "silent"); assert.equal(stranger.log.reason, "test_mode_not_listed");
  const omar = await w.say("السلام عليكم", { from: "966544775082" });
  assert.equal(omar.sent.length, 1); assert.equal(omar.sent[0].to, "966544775082"); assert.equal(omar.log.decision, "replied");
  // a handover in test mode does not text the manager unless alertInTest is on
  const h = await w.say("ابي اكلم موظف", { from: "966561186075" });
  assert.equal(h.sent.length, 1); assert.equal(h.log.handoff, "asked_human"); assert.equal(h.log.alert, "would"); assert.equal(w.sms.length, 0);
  assert.ok(w.calls.every((c) => ["966544775082", "966561186075"].includes(c.body.to)));
}));

test("live mode needs the normal WhatsApp locks: without them nothing is sent, nobody is muted or alerted", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "live" } });
  const r = await w.say("عندي شكوى");
  assert.equal(r.sent.length, 0); assert.equal(r.log.decision, "failed"); assert.equal(r.log.error, "skipped:disabled");
  assert.equal(r.log.handoff, null); assert.equal(w.sms.length, 0);
  assert.equal(w.db.chats.get("512345678")?.muted_until || null, null);
}));

test("kill switch: mode → off takes effect on the very next message", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  assert.equal((await w.say("المنيو")).sent.length, 1);
  w.setMode("off");
  const r = await w.say("كم رسوم التوصيل");
  assert.equal(r.sent.length, 0); assert.equal(r.log, null);
}));

/* ── ٢) محادثة كاملة — أجسام الرسائل بالحرف ──────────────────────────────── */
/* ── ٣) حالة الطلب — بجوال المرسل فقط ───────────────────────────────────── */
test("order status: the real status + the order's own tracking link, per order kind and stage", withEnv(LOCKS_OPEN, async () => {
  const cases = [
    [order({ status: "pos_created" }), "استلمنا طلبك وتم الدفع ✅"],
    [order({ status: "accepted" }), "المطبخ يجهّز طلبك 👨‍🍳"],
    [order({ status: "courier_assigned" }), "المطبخ يجهّز طلبك 👨‍🍳"],                                   // «المطعم أولاً»: لا كلام عن المندوب قبل الجاهزية
    [order({ status: "courier_assigned", pos_ready_at: "2026-10-12T14:55:00Z" }), "طلبك جاهز ونسلّمه للمندوب 🛵"],
    [order({ status: "courier_assigned", pos_ready_at: "2026-10-12T14:55:00Z", handed_at: "2026-10-12T14:57:00Z" }), "سلّمنا طلبك للمندوب 🛵"],
    [order({ status: "on_the_way" }), "طلبك مع المندوب وفي الطريق إليك 🛵"],
    [order({ status: "delivered" }), "تم توصيل طلبك ✅"],
    [order({ option: "pickup", status: "accepted" }), "المطبخ يجهّز طلبك 👨‍🍳"],
    [order({ option: "pickup", status: "accepted", pos_ready_at: "2026-10-12T14:55:00Z" }), "طلبك جاهز للاستلام من الفرع ✅"],
    [order({ option: "pickup", status: "delivered" }), "تم استلام طلبك ✅ بالعافية."],
    [order({ option: "pickup", table_no: 4, status: "delivered" }), "تم تقديم طلبك ✅ بالعافية."],
    [order({ status: "rejected_refunded", refund_id: "RF1" }), "اعتذر المطعم عن الطلب وتم استرجاع المبلغ لوسيلة الدفع."],
  ];
  for (const [o, label] of cases) {
    const w = world({ waBot: { mode: "live" }, orders: [o] });
    const r = await w.say("وين طلبي؟");
    assert.deepEqual(r.sent, [cta(ME, `طلبك رقم W1790011111111: ${label}`, "تتبّع الطلب", "https://freshcuts.sa/track/W1790011111111")], label);
    assert.equal(r.log.handoff, null, label);
  }
}));

/* ── ٤) الإنسان أولاً ────────────────────────────────────────────────────── */
/* ── ٥) النافذة، التكرار، الحدود ────────────────────────────────────────── */
test("window rule: a late-delivered message is not answered (stale), and nothing older than 24 h ever is", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const a = await w.say("مفتوحين؟", { agoMin: 45 });
  assert.equal(a.sent.length, 0); assert.equal(a.log.reason, "stale");
  const b = await w.say("مفتوحين؟", { agoMin: 25 * 60, from: "966598765432" });
  assert.equal(b.sent.length, 0); assert.equal(b.log.reason, "outside_window");
  assert.equal((await w.say("مفتوحين؟", { agoMin: 5, from: "966555555555" })).sent.length, 1);
  // the bot never starts a conversation: there is no code path that sends without an inbound message
  assert.equal(w.calls.length, 1);
}));

/* ── ٦) المواعيد ─────────────────────────────────────────────────────────── */
test("closed hours: says when we open, points to «نبّهني أول ما نفتح», and handovers say the reply comes after opening", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, at: CLOSED_AT });
  assert.deepEqual((await w.say("مفتوحين الحين؟")).sent, [cta(ME,
    "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً.\nجهّز سلتك من الرابط واضغط «نبّهني أول ما نفتح» ونذكّرك.",
    "جهّز سلتك", "https://freshcuts.sa/l/wab-boxes")]);
  const g = await w.say("مرحبا", { from: "966598765432" });
  assert.equal(g.sent[0].interactive.body.text, `حيّاك الله في فريش كاتس 👋\n${BOXES}\n${FIRST_LINE}\n🌙 المطعم مقفل الحين ونفتح اليوم الساعة 12 ظهراً. جهّز سلتك واضغط «نبّهني أول ما نفتح» ونذكّرك.`);
  const h = await w.say("ابي موظف", { from: "966555555555" });
  assert.equal(h.sent[0].text.body, "أبشر 🙏 حوّلت محادثتك لموظف.\nالمطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً، والمساعد الآلي يترك المحادثة له.");
  // 02:30 Tuesday (Monday's shift ended 02:00) — closed; 01:30 — still open on Monday's shift
  const late = world({ waBot: { mode: "live" }, at: "2026-10-12T23:30:00Z" });
  assert.match((await late.say("مفتوحين؟")).sent[0].interactive.body.text, /🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً\./);
  const tail = world({ waBot: { mode: "live" }, at: "2026-10-12T22:30:00Z" });
  assert.match((await tail.say("مفتوحين؟")).sent[0].text.body, /🟢 مفتوحين الحين لين 2 فجراً\.$/);
  // delivery paused from the dashboard
  const paused = world({ waBot: { mode: "live" }, extraSettings: { service: { delivery: { paused: true, until: null, reason: "" }, pickup: { paused: false } } } });
  assert.match((await paused.say("ابي اطلب")).sent[0].interactive.body.text, /\n⚠️ التوصيل متوقف مؤقتاً، والاستلام من الفرع متاح\.$/);
}));

/* ── ٧) الإعلانات ────────────────────────────────────────────────────────── */
test("click-to-WhatsApp: the ad is captured on the chat and its replies use the ad's tracked link", withEnv(LOCKS_OPEN, async () => {
  const referral = { source_url: "https://fb.me/abc", source_id: "120251225139440593", source_type: "ad", headline: "ميكس جريل لشخصين", ctwa_clid: "CLID123" };
  const w = world({ waBot: { mode: "live", links: { adMap: { "120251225139440593": "wa-box-d4" } } } });
  const g = await w.say("مرحبا، ابي اعرف اكثر", { referral });
  assert.equal(g.sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-box-d4");
  assert.equal(g.log.link_slug, "wa-box-d4"); assert.equal(g.log.referral, true);
  assert.deepEqual(w.db.chats.get("512345678").referral, { source_id: "120251225139440593", source_type: "ad", source_url: "https://fb.me/abc", headline: "ميكس جريل لشخصين", ctwa_clid: "CLID123" });
  // later messages carry no referral object — the stored one keeps the attribution for 72 h
  w.clock.advance(30);
  assert.equal((await w.say("ابي اطلب")).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-box-d4");
  w.clock.advance(73 * 60);
  assert.equal((await w.say("ابي اطلب")).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  // an ad that is not in the map uses the general ad link; an organic chat uses the bot link
  const w2 = world({ waBot: { mode: "live" } });
  assert.equal((await w2.say("السلام عليكم", { referral: { source_id: "999999999", source_type: "ad", ctwa_clid: "X" } })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-boxes");
  assert.equal((await w2.say("السلام عليكم", { from: "966598765432" })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  // a real question from an ad chat is answered as that question, not swallowed by a greeting
  const w3 = world({ waBot: { mode: "live" } });
  assert.equal((await w3.say("كم رسوم التوصيل", { referral })).log.reply_key, "delivery");
  // greet only ad chats (dashboard choice)
  const w4 = world({ waBot: { mode: "live", greetScope: "ads" } });
  assert.equal((await w4.say("السلام عليكم")).log.reason, "greet_ads_only");
  assert.equal((await w4.say("السلام عليكم", { from: "966598765432", referral })).sent.length, 1);
  assert.equal((await w4.say("المنيو")).sent.length, 1, "questions are still answered for everyone");
}));

/* ── ٨) بيانات ناقصة وفشل الإرسال ───────────────────────────────────────── */
/* ── ٩) الإيقاف والمرفقات ───────────────────────────────────────────────── */
test("«إيقاف» stops marketing (also in looser wording) and is confirmed; order-status questions still get answered", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, orders: [order({ status: "on_the_way" })] });
  const s = await w.say("إيقاف");
  assert.deepEqual(s.sent, [txt(ME, "تم إيقاف رسائل العروض ✅ تحديثات طلباتك توصلك عادي.\nللرجوع اكتب: اشتراك")]);
  assert.deepEqual(w.db.optouts, ["512345678"]); assert.equal(w.db.optins["512345678"].marketing, false);
  w.clock.advance(1);
  const st = await w.say("وين طلبي");
  assert.equal(st.sent.length, 1); assert.match(st.sent[0].interactive.body.text, /في الطريق إليك/);
  const w2 = world({ waBot: { mode: "live" } });
  const loose = await w2.say("لا ترسلون لي رسايل");
  assert.equal(loose.log.reply_key, "stop"); assert.deepEqual(w2.db.optouts, ["512345678"]);
  w2.clock.advance(1);
  assert.deepEqual((await w2.say("اشتراك")).sent, [txt(ME, "تم تفعيل رسائل العروض ✅\nللإيقاف اكتب: إيقاف")]);
  assert.equal(w2.db.optins["512345678"].marketing, true);
  // opt-out is honoured even when the bot must stay silent (cashier active)
  const w3 = world({ waBot: { mode: "live" } });
  await w3.cashier("هلا");
  const q = await w3.say("وقفوا الرسايل");
  assert.equal(q.sent.length, 0); assert.equal(q.log.reason, "staff_pause"); assert.deepEqual(w3.db.optouts, ["512345678"]);
}));

/* ── ١٠) النوايا: صياغات ولهجات وأخطاء إملائية ──────────────────────────── */
/* ── ١١) حدود ميتا والنصوص ──────────────────────────────────────────────── */
test("every reply in both languages, open and closed, fits Meta's limits and has no placeholder left", () => {
  const { openState } = W_BOT;
  for (const at of [OPEN_AT, CLOSED_AT]) for (const lang of ["ar", "en"]) for (const interactive of [true, false]) {
    const now = new Date(at);
    const settings = { hours: HOURS, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: FAQ } } };
    const data = { settings, now, open: openState(settings, now), loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 }, bundles: BUNDLES, policy: POLICY, first: FIRST,
      order: order({ status: "on_the_way" }), links: { "wab-boxes": true, "wa-boxes": true }, chat: {} };
    const cfg = R.botConfig({ waBot: { mode: "live" } });
    for (const key of [...R.REPLY_KEYS, "data_missing", "rate"]) {
      const r = R.buildReply(key, { cfg, lang, data, referral: null });
      const p = R.toPayload(r, { cfg, lang, interactive });
      assert.equal(R.payloadProblem(p), null, `${key} ${lang} ${at} interactive=${interactive}`);
      const text = p.type === "text" ? p.text.body : p.interactive.body.text;
      assert.ok([...text].length <= (p.type === "text" ? 4096 : 1024), key);
      assert.ok(text.split("\n").length <= 14, `${key}: short, not a wall of text`);
      assert.doesNotMatch(text, /\n\n\n|^\s|\s$/);
    }
  }
  for (const k of R.TEXT_KEYS) {
    const d = R.TEXTS[k];
    for (const lang of ["ar", "en"]) {
      assert.ok([...d[lang]].length <= d.max, `${k}.${lang} length`);
      assert.equal(R.textProblem(k, lang, d[lang]), null, `${k}.${lang} default is valid`);
    }
    // white dialect / simple fusha — no Egyptian wording, no banned claims
    assert.doesNotMatch(d.ar, /وحشتنا|دلوقتي|عايز|عاوز|بتاع|امبارح|إزاي|ازاي|كده|مفيش|\sمش\s|النهارده|بكام|لسه|هنبعت|هنرد|بنبعت/, k);
    assert.doesNotMatch(`${d.ar} ${d.en}`, /أرخص من التطبيقات|cheaper than|ستيك|steak|\d+\s*(جرام|كيلو)/i, k);
  }
  for (const k of ["btn_menu", "btn_status", "btn_human", "cta_order", "cta_menu", "cta_cart", "cta_map", "cta_track"]) for (const lang of ["ar", "en"]) assert.ok([...R.TEXTS[k][lang]].length <= 20, `${k}.${lang}`);
});
const W_BOT = await import("./wabot.js");

/* ── ١٢) الإعدادات من اللوحة ─────────────────────────────────────────────── */
test("dashboard settings: validation, editable texts with safe placeholders, owner only", withEnv(LOCKS_OPEN, async () => {
  assert.deepEqual(R.configFromBody({ mode: "banana" }).errors, ["mode"]);
  assert.match(R.configFromBody({ mode: "test" }).errors[0], /mode=test/);
  assert.match(R.configFromBody({ testPhones: ["0544775082", "12345"] }).errors[0], /testPhones/);
  assert.deepEqual(R.configFromBody({ mode: "test", testPhones: "0544775082, 0561186075" }).value.testPhones, ["544775082", "561186075"]);
  assert.equal(R.textProblem("greet", "ar", "أهلاً {boxes} {price}"), "unknown_placeholder:price");
  assert.equal(R.textProblem("greet", "ar", "أهلاً {{1}}"), "double_braces");
  assert.equal(R.textProblem("greet", "ar", "أهلاً {boxes"), "stray_brace");
  assert.equal(R.textProblem("btn_menu", "ar", "عنوان زر أطول من عشرين حرفاً بكثير"), "too_long:20");
  assert.equal(R.textProblem("footer", "ar", "سطر\nسطرين"), "single_line_only");
  assert.equal(R.textProblem("nope", "ar", "x"), "unknown_key");
  assert.equal(R.configFromBody({ texts: { greet: { ar: "حياك {discount}" } } }).ok, false);
  // clamps: a nonsense number can not switch a safety rule off
  const c = R.botConfig({ waBot: { humanPauseMin: 0, maxRepliesPerHour: 9999, maxAgeMinutes: -5, staffWaitMin: 999, unknownWaitMin: -3 } });
  assert.deepEqual([c.humanPauseMin, c.maxRepliesPerHour, c.maxAgeMinutes, c.staffWaitMin, c.unknownWaitMin], [1, 300, 1, 15, 0]);

  const w = world({ waBot: {} });
  w.setOwner(false);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live" })).status, 403);
  w.setOwner(true);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live", texts: { thanks: { ar: "العفو {x}" } } })).status, 400);
  assert.equal(w.db.settings.waBot.mode, undefined, "a refused save changes nothing");
  const ok = await w.call("PUT", "/api/cms/wabot/config", { mode: "live", humanPauseMin: 45, texts: { thanks: { ar: "حيّاك الله، في خدمتك دائماً 🌟" }, greet: { ar: "أهلاً بك في فريش كاتس 👋\n{boxes}" } } });
  assert.equal(ok.body.ok, true);
  assert.deepEqual((await w.say("شكرا")).sent, [txt(ME, "حيّاك الله، في خدمتك دائماً 🌟")]);
  assert.equal((await w.say("السلام عليكم", { from: "966598765432" })).sent[0].interactive.body.text, `أهلاً بك في فريش كاتس 👋\n${BOXES}`);
  // emptying a text returns it to the default; other settings are kept
  await w.call("PUT", "/api/cms/wabot/config", { texts: { thanks: { ar: "" } } });
  assert.equal(w.db.settings.waBot.texts.thanks, undefined); assert.equal(w.db.settings.waBot.humanPauseMin, 45); assert.equal(w.db.settings.waBot.mode, "live");
  const g = await w.call("GET", "/api/cms/wabot/config");
  assert.equal(g.body.config.mode, "live"); assert.equal(g.body.state.liveReady, true); assert.equal(g.body.texts.length, R.TEXT_KEYS.length);
  assert.ok(g.body.links.find((l) => l.slug === "wab-boxes" && !l.missing));
  // switch an answer off ⇒ that question goes to staff
  await w.call("PUT", "/api/cms/wabot/config", { intentsOff: ["payment"] });
  assert.equal((await w.say("طرق الدفع", { from: "966555555555" })).log.handoff, "needs_staff");
}));

test("simulate and the log/stats routes: read-only preview, then a record of every decision", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const s = await w.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل" });
  assert.equal(s.body.decision.key, "delivery"); assert.equal(s.body.payloads[0].type, "interactive");
  assert.equal(w.calls.length, 0); assert.equal(w.db.log.length, 0, "simulate leaves no trace");
  await w.say("المنيو"); await w.say("ابي موظف", { from: "966598765432" });
  const log = await w.call("GET", "/api/cms/wabot/log", {}, { limit: "10" });
  assert.equal(log.status, 200);
  const seeded = w.db.links.find((l) => l.slug === "wab-boxes");
  assert.ok(seeded, "the bot's tracked link exists");
}));

test("template test send: owner only, allow-list only, no customer switch needed", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "off", testPhones: ["0544775082", "0561186075"] }, notifications: {} });
  const dry = await w.call("POST", "/api/cms/wabot/test-template", { name: "fc_order_on_the_way", phone: "0544775082", dryRun: true });
  assert.equal(dry.body.text, "طلبك رقم W1790012345678 مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.");
  assert.equal(w.calls.length, 0);
  assert.equal((await w.call("POST", "/api/cms/wabot/test-template", { name: "fc_order_on_the_way", phone: "0512345678" })).body.error, "not_in_allow_list");
  assert.equal(w.calls.length, 0);
  w.setOwner(false);
  assert.equal((await w.call("POST", "/api/cms/wabot/test-template", { name: "fc_order_on_the_way", phone: "0544775082" })).status, 403);
  w.setOwner(true);
  const r = await w.call("POST", "/api/cms/wabot/test-template", { name: "fc_order_on_the_way", phone: "0561186075" });
  assert.equal(r.body.ok, true);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].body.to, "966561186075"); assert.equal(w.calls[0].body.template.name, "fc_order_on_the_way");
  assert.equal(w.calls[0].body.template.components.find((c) => c.type === "button").parameters[0].text, "W1790012345678");
  // staff template in English
  const en = await w.call("POST", "/api/cms/wabot/test-template", { name: "fc_staff_new_order", phone: "0544775082", language: "en", dryRun: true });
  assert.equal(en.body.text, "New online order W1790012345678: Delivery, 86.50 SAR, paid. 3 items, follow it on the portal.");
}));

/* ════════════════════════════════════════════════════════════════════════════
   ١٢/١٠ — قواعد «البوت والموظف» (موافقة عمر): سكوت بالدقايق، نهاية مبكرة، المطعم مقفول، الكتم اليدوي،
   الشكوى المفتوحة، انتظار الغير مفهوم، الرد المؤجّل، التعريف، ووضوح السجل.
═════════════════════════════════════════════════════════════════════════════ */
const SOON = "\nيرد عليك موظف هنا في أقرب وقت، والمساعد الآلي يترك المحادثة له.";
const DISC = "معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف";
const mins = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);
const CLOSE_AT = "2026-10-12T23:00:00Z";     // الثلاثاء ٠٢:٠٠ الرياض = قفلة وردية الاثنين

test("order status: never another person's order; no order ⇒ say so plainly and hand over", withEnv(LOCKS_OPEN, async () => {
  const other = order({ order_no: "W1790099999999", phone_norm: "598765432", status: "on_the_way" });
  const w = world({ waBot: { mode: "live" }, orders: [other] });
  const r = await w.say("وين طلبي W1790099999999");
  assert.deepEqual(r.sent, [txt(ME, `ما لقيت طلب حديث من موقعنا على رقمك هذا 🙏\nحوّلت محادثتك لموظف يتأكد لك.${SOON}`)]);
  assert.doesNotMatch(JSON.stringify(r.sent), /W1790099999999|الطريق/);
  assert.equal(r.log.handoff, "order_not_found");
  assert.equal(w.sms.length, 2);
  assert.equal(w.sms[0].body, "Fresh Cuts WhatsApp: customer 0512345678 needs staff (order not found). Reply from the restaurant phone.");
  assert.deepEqual(w.sms.map((s) => s.phoneNorm), ["544775082", "506338246"], "the alert goes to Omar AND the manager");
  assert.ok(w.sms.every((s) => s.kind === "staff" && s.body.length <= 160));
  const mine = await w.say("وين طلبي", { from: "966598765432" });
  assert.match(mine.sent[0].interactive.body.text, /^طلبك رقم W1790099999999: طلبك مع المندوب وفي الطريق إليك 🛵$/);
}));

test("order status: a late or stuck order gets its status AND a handover; an unknown state is never guessed", withEnv(LOCKS_OPEN, async () => {
  const late = world({ waBot: { mode: "live" }, orders: [order({ status: "accepted", created_at: new Date(Date.parse(OPEN_AT) - 95 * 60_000).toISOString() })] });
  const r = await late.say("طلبي وين");
  assert.equal(r.sent[0].interactive.body.text, `طلبك رقم W1790011111111: المطبخ يجهّز طلبك 👨‍🍳\nنعتذر عن التأخير 🙏 بلّغت الفريق يتابعه معك.${SOON}`);
  assert.equal(r.log.handoff, "order_late");
  assert.match(late.sms[0].body, /needs staff \(LATE order\) order W1790011111111\./);
  const stuck = world({ waBot: { mode: "live" }, orders: [order({ status: "refund_failed" })] });
  const s = await stuck.say("وين طلبي");
  assert.match(s.sent[0].interactive.body.text, /استرجاع المبلغ جاري وفريقنا يتابعه\.$/); assert.equal(s.log.handoff, "order_issue");
  for (const o of [order({ status: "rejected_refunded", refund_id: null }), order({ status: "some_new_status" }), order({ option: "dine_in", status: "accepted" })]) {
    const w = world({ waBot: { mode: "live" }, orders: [o] });
    const x = await w.say("وين طلبي");
    assert.deepEqual(x.sent, [txt(ME, `ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.${SOON}`)], o.status);
    assert.equal(x.log.handoff, "data_missing");
  }
}));

/* ── القاعدة ١ و٢ ───────────────────────────────────────────────────────── */
test("rule 1+2: staff reply pauses the bot 30 min from the LAST echo; a customer message inside the pause is answered after 5 min if staff stay silent", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  assert.equal(R.botConfig({ waBot: { humanWindowHours: 12 } }).humanPauseMin, 30, "the stored 12 h setting is ignored: 30 minutes");
  await w.cashier("حياك الله، كيف أخدمك؟");
  w.clock.advance(2);
  const r = await w.say("كم رسوم التوصيل");
  assert.equal(r.sent.length, 0, "nothing yet: the staff member is in the chat");
  assert.equal(r.log.decision, "waiting"); assert.equal(r.log.reason, "staff_pause"); assert.equal(r.log.reply_key, "delivery");
  assert.equal(mins(r.log.resume_at, w.clock.now().toISOString()), 5, "the log says when the bot will answer");
  assert.deepEqual(await w.tick(4), [], "4 minutes: still waiting for staff");
  const out = await w.tick(1);
  assert.equal(out.length, 1); assert.match(out[0].interactive.body.text, /^🛵 نوصّل لمسافة 10 كم/);
  assert.equal(r.log.decision, "replied"); assert.equal(r.log.reason, "after_staff_wait");
  assert.deepEqual(await w.tick(10), [], "one answer per message — never twice");
  // staff answered inside the 5 minutes ⇒ the bot drops its reply
  const w2 = world({ waBot: { mode: "live" } });
  await w2.cashier("هلا");
  const q = await w2.say("وين موقعكم");
  w2.clock.advance(3); await w2.cashier("في حي السلامة عند دوار رامي");
  assert.deepEqual(await w2.tick(3), []);
  assert.equal(q.log.decision, "silent"); assert.equal(q.log.reason, "staff_answered");
  // an unrecognised message during the pause is left to the staff member: no reply, no delayed reply
  const w3 = world({ waBot: { mode: "live" } });
  await w3.cashier("هلا");
  const u = await w3.say("طيب والثاني؟");
  assert.equal(u.log.decision, "silent"); assert.equal(u.log.reason, "staff_pause"); assert.equal(w3.db.jobs.length, 0);
  assert.equal(mins(u.log.resume_at, w3.clock.now().toISOString()), 30);
  assert.equal((await w3.say("كم رسوم التوصيل", { from: "966598765432" })).sent.length, 1, "another customer is not affected");
}));

test("rule 1: the pause slides from the last echo, ends after 30 min, and is a dashboard setting; Omar's case (echo 4 h earlier) is answered at once", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  await w.cashier("هلا"); w.clock.advance(25); await w.cashier("تمام"); w.clock.advance(15);
  const a = await w.say("المنيو");
  assert.equal(a.log.decision, "waiting", "40 min after the first echo but 15 after the last: still paused");
  w.clock.advance(16);
  const b = await w.say("وين موقعكم");
  assert.equal(b.sent.length, 1, "31 min after the last echo: the bot answers immediately");
  // near the end of the pause the wait is the remaining pause, not a full 5 minutes
  const w2 = world({ waBot: { mode: "live" } });
  await w2.cashier("هلا"); w2.clock.advance(28);
  const c = await w2.say("المنيو");
  assert.equal(mins(c.log.resume_at, w2.clock.now().toISOString()), 2);
  // the incident of 12/10: the restaurant phone messaged the number about 4 hours before
  const w3 = world({ waBot: { mode: "live" } });
  await w3.cashier("أهلاً عمر"); w3.clock.advance(4 * 60);
  const o = await w3.say("السلام عليكم");
  assert.equal(o.sent.length, 1); assert.equal(o.log.decision, "replied");
  const w4 = world({ waBot: { mode: "live", humanPauseMin: 10, staffWaitMin: 2 } });
  await w4.cashier("هلا"); w4.clock.advance(5);
  const d = await w4.say("المنيو");
  assert.equal(mins(d.log.resume_at, w4.clock.now().toISOString()), 2);
  w4.clock.advance(6);
  assert.equal((await w4.say("وين موقعكم")).sent.length, 1);
}));

/* ── القاعدة ٣ و٤ج و٦ ───────────────────────────────────────────────────── */
test("rule 3+6+4c: closed ⇒ the staff pause does not exist; a pause ends at closing; an echo sent while closed pauses 10 min only", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, at: "2026-10-12T22:50:00Z" });     // 01:50 Riyadh, open
  await w.cashier("طلبك جاهز");
  w.clock.set("2026-10-12T22:58:00Z");
  assert.equal((await w.say("المنيو")).log.decision, "waiting", "still open: paused");
  w.clock.set("2026-10-12T23:05:00Z");                                          // 02:05, closed; the echo is 15 min old
  const r = await w.say("متى تفتحون", { from: ME });
  assert.equal(r.sent.length, 1, "closed: answered although the echo is only 15 minutes old");
  assert.match(r.sent[0].interactive.body.text, /🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً\./);
  assert.deepEqual(R.pauseState({ cfg: R.botConfig({}), now: new Date("2026-10-12T23:05:00Z"), open: false, lastEchoAt: "2026-10-12T22:50:00Z", hours: HOURS }),
    { paused: false, until: null, kind: null, expired: "closing" });
  // a staff member writes after closing ⇒ 10 minutes only, and the customer's question is still answered if they go quiet
  await w.cashier("نعتذر، قفلنا");
  w.clock.advance(4);
  const q = await w.say("وين موقعكم");
  assert.equal(q.log.decision, "waiting"); assert.equal(q.log.reason, "staff_pause_closed");
  assert.equal(mins(q.log.resume_at, w.clock.now().toISOString()), 5);
  assert.equal((await w.tick(5)).length, 1);
  w.clock.advance(3);                                                           // 12 min after the closed echo
  assert.equal((await w.say("طرق الدفع")).sent.length, 1, "after 10 minutes the bot is back");
  assert.equal(R.botConfig({ waBot: { closedEchoPauseMin: 0 } }).closedEchoPauseMin, 0, "0 = never pause while closed");
}));

/* ── القاعدة ٤أ: الكتم اليدوي ───────────────────────────────────────────── */
test("rule 4a: a manual mute holds even when closed, shows who and until when, expires by itself, and staff can set and lift it", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, at: CLOSED_AT });
  assert.equal((await w.call("POST", "/api/cms/ops/wabot/mute", { phone: "12345" })).status, 400);
  const m = await w.call("POST", "/api/cms/ops/wabot/mute", { phone: "0512345678", by: "أحمد الكاشير" });
  assert.deepEqual(m.body, { ok: true, hours: 24, phone: "0512345678" });
  const r = await w.say("متى تفتحون");
  assert.equal(r.sent.length, 0); assert.equal(r.log.reason, "manual_mute");
  assert.equal(mins(r.log.resume_at, w.clock.now().toISOString()), 24 * 60);
  assert.equal((await w.say("متى تفتحون", { from: "966598765432" })).sent.length, 1, "only that chat");
  const list = await w.call("GET", "/api/cms/ops/wabot/chats");
  assert.equal(list.body.rows.find((x) => x.phone_norm === "512345678").muted_by, "أحمد الكاشير");
  w.clock.advance(24 * 60 + 1);
  assert.equal((await w.say("وين موقعكم")).sent.length, 1, "the mute expired");
  // custom length, lifted early, and it cancels a delayed reply that was waiting
  const w2 = world({ waBot: { mode: "live" } });
  await w2.cashier("هلا");
  await w2.say("المنيو");
  assert.equal(w2.db.jobs[0].status, "pending");
  assert.equal((await w2.call("POST", "/api/cms/wabot/chats/mute", { phone: "0512345678", hours: 2 })).body.hours, 2);
  assert.equal(w2.db.jobs[0].status, "cancelled");
  assert.deepEqual(await w2.tick(10), []);
  await w2.call("POST", "/api/cms/ops/wabot/unmute", { phone: "0512345678" });
  w2.clock.advance(30);
  assert.equal((await w2.say("وين موقعكم")).sent.length, 1);
  assert.equal(R.botConfig({ waBot: { manualMuteHours: 6 } }).manualMuteHours, 6);
  // the opt-out is still honoured in a muted chat
  const w3 = world({ waBot: { mode: "live" } });
  await w3.bot.muteChat("512345678", 24, "x");
  const s = await w3.say("إيقاف");
  assert.equal(s.sent.length, 0); assert.deepEqual(w3.db.optouts, ["512345678"]);
}));

/* ── القاعدة ٤ب: شكوى مفتوحة ────────────────────────────────────────────── */
test("complaint or order problem: apology in the house style, order number, immediate handover and staff alert", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, orders: [order({ status: "delivered" })] });
  const r = await w.say("الطلب وصل بارد وناقص");
  assert.deepEqual(r.sent, [txt(ME, `نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nطلبك رقم W1790011111111 قدّامنا.${SOON}`)]);
  assert.equal(w.sms[0].body, "Fresh Cuts WhatsApp: customer 0512345678 needs staff (complaint) order W1790011111111. Reply from the restaurant phone.");
  const w2 = world({ waBot: { mode: "live" } });
  assert.deepEqual((await w2.say("جاني طلب غلط")).sent, [txt(ME, `نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nلو تكرّمت اكتب رقم الطلب (يبدأ بحرف W) عشان نخدمك أسرع.${SOON}`)]);
  w2.clock.advance(1);
  const no = await w2.say("W1790011111111");
  assert.equal(no.log.reply_key, "status", "an order number is read as a status question (a fact): answered, never as a second complaint");
  assert.equal(w2.sms.length, 2);
  for (const [phrase, key, reason] of [["ابي استرجاع المبلغ", "complaint", "complaint"], ["انخصم المبلغ وما وصل تاكيد", "problem", "problem"], ["الموقع ما يفتح", "problem", "problem"],
    ["ابي الغي الطلب", "change", "order_change"], ["ابي اغير العنوان", "change", "order_change"], ["الكود ما يشتغل", "problem", "problem"], ["صار عندي تسمم", "complaint", "complaint"]]) {
    const x = world({ waBot: { mode: "live" } });
    const y = await x.say(phrase);
    assert.equal(y.log.reply_key, key, phrase); assert.equal(y.log.handoff, reason, phrase); assert.equal(x.sms.length, 2, phrase);
    assert.doesNotMatch(y.sent[0].text.body, /بأسرع وقت|as soon as possible/, "no «as soon as possible» promise in the body");
  }
  const ar = world({ waBot: { mode: "live" }, extraSettings: { delivery: { alertPhones: ["0544775082"], staffSmsLanguage: "ar" } } });
  await ar.say("عندي شكوى");
  assert.equal(ar.sms[0].body, "فريش كاتس واتساب: 0512345678 يحتاج موظف (شكوى)"); assert.ok(ar.sms[0].body.length <= 70);
}));

/* ── القاعدة ٥ ───────────────────────────────────────────────────────────── */
const FALLBACK = (to) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: { type: "button", body: { text: "ما فهمت طلبك تماماً 🙏 اختر من الأزرار، أو اكتب: موظف" }, footer: { text: FOOTER },
  action: { buttons: [{ type: "reply", reply: { id: "bot:menu", title: "🎁 البوكسات والمنيو" } }, { type: "reply", reply: { id: "bot:status", title: "📦 وين طلبي؟" } }, { type: "reply", reply: { id: "bot:human", title: "👤 كلّم موظف" } }] } } });
/* ── القاعدة ٧: التعريف ─────────────────────────────────────────────────── */
test("rule 7: the first bot message of a conversation says it is automated and how to reach a person; once per 24 h", withEnv(LOCKS_OPEN, async () => {
  const CONTACT = { storefront: { seo: { faq: [...FAQ, { q: "كيف أتواصل مع المطعم؟", a: "هاتف أو واتساب على 0546715683." }] } } };
  const w = world({ waBot: { mode: "live" }, disclosure: true, extraSettings: CONTACT });
  const a = await w.say("السلام عليكم");
  assert.equal(a.sent[0].interactive.body.text, `${DISC}، أو اتصل على 0546715683\nحيّاك الله في فريش كاتس 👋\n${BOXES}\n${FIRST_LINE}`);
  w.clock.advance(2);
  assert.equal((await w.say("وين موقعكم")).sent[0].interactive.body.text, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.", "not repeated in the same conversation");
  w.clock.advance(24 * 60);
  assert.match((await w.say("طرق الدفع")).sent[0].text.body, /^معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف، أو اتصل على 0546715683\n💳 /, "again after 24 h");
  // no public number in the settings ⇒ the «موظف» path alone; a number set on the bot page wins
  const n = world({ waBot: { mode: "live" }, disclosure: true });
  assert.match((await n.say("وين موقعكم")).sent[0].interactive.body.text, new RegExp(`^${DISC}\\n📍`));
  const o = world({ waBot: { mode: "live", publicPhone: "0126001234" }, disclosure: true, extraSettings: CONTACT });
  assert.match((await o.say("وين موقعكم")).sent[0].interactive.body.text, /أو اتصل على 0126001234\n/);
  assert.equal(R.configFromBody({ publicPhone: "abc" }).ok, false);
  // a handover is also introduced, and a failed send does not count as «introduced»
  const h = world({ waBot: { mode: "live" }, disclosure: true });
  assert.deepEqual((await h.say("ابي اكلم موظف")).sent, [txt(ME, `${DISC}\nأبشر 🙏 حوّلت محادثتك لموظف.${SOON}`)]);
  const f = world({ waBot: { mode: "live" }, disclosure: true, graph: (body, n2) => (n2 <= 2 ? { error: { code: 131000, message: "x" } } : null) });
  await f.say("وين موقعكم"); f.clock.advance(11);
  assert.match((await f.say("متى تقفلون")).sent[0].text.body, new RegExp(`^${DISC}\\n`));
  // every reply still fits Meta's limits with the introduction in front
  for (const lang of ["ar", "en"]) {
    const now = new Date(OPEN_AT), settings = { hours: HOURS, ...CONTACT };
    const data = { settings, now, open: W_BOT.openState(settings, now), loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 }, bundles: BUNDLES, policy: POLICY, first: FIRST, order: null, links: { "wab-boxes": true }, chat: {} };
    for (const text of ["كم رسوم التوصيل", "السلام عليكم", "hello", "how much is delivery"]) {
      const d = R.decide({ phone: "512345678", text, type: "text", at: now.toISOString() }, { cfg: R.botConfig({ waBot: { mode: "live" } }), now, chat: {}, lastEchoAt: null, repliesLastHour: 0, lastSame: null, data });
      assert.equal(d.act, "reply", text); assert.equal(d.disclose, true); assert.equal(R.payloadProblem(d.payloads[0]), null, `${lang} ${text}`);
    }
  }
}));

/* ── السجل والتكلفة ─────────────────────────────────────────────────────── */
test("the log says why the bot stayed silent and when it answers again; this month's replies and their cost are counted", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live", freeRepliesPerMonth: 2, replyRateSar: 0.0401 } });
  const g = await w.say("السلام عليكم"); w.clock.advance(1);
  const g2 = await w.say("هلا");
  assert.equal(g2.log.reason, "already_greeted"); assert.equal(mins(g2.log.resume_at, g.log.at), 24 * 60);
  await w.say("وين موقعكم", { from: "966598765432" }); await w.say("طرق الدفع", { from: "966577777777" }); await w.say("المنيو", { from: "966566666666" });
  const st = await w.call("GET", "/api/cms/wabot/stats", {}, { days: "7" });
  assert.deepEqual(st.body.month, { replies: 4, free: 2, billable: 2, rateSar: 0.0401, costSar: 0.08 });
  const log = await w.call("GET", "/api/cms/wabot/log", {}, { decision: "waiting" });
  assert.equal(log.status, 200);
  const cfg = await w.call("GET", "/api/cms/wabot/config");
  assert.equal(cfg.body.config.humanPauseMin, 30); assert.equal(cfg.body.state.open, true);
  assert.equal("humanWindowHours" in cfg.body.config, false);
  // saving any setting removes the retired 12-hour key from the stored settings
  w.db.settings.waBot.humanWindowHours = 12;
  await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 20 });
  assert.equal("humanWindowHours" in w.db.settings.waBot, false); assert.equal(w.db.settings.waBot.humanPauseMin, 20);
}));

test("an old dashboard screen that saves ALL settings can not wipe or roll back the bot's settings", async () => {
  const G = await import("./settings-guard.js");
  const current = { waBot: { mode: "test", testPhones: ["544775082"] }, hours: HOURS };
  const stale = { hours: HOURS, waBot: { mode: "live" } };
  assert.deepEqual(G.mergeForPut(current, stale).waBot, current.waBot);
  assert.deepEqual(G.mergeForPut(current, { hours: HOURS }).waBot, current.waBot);
  assert.equal("waBot" in G.mergeForPut({ hours: HOURS }, stale), false, "nor can it switch a bot on that was never configured");
});

/* ── الحدود وفشل الإرسال ────────────────────────────────────────────────── */
test("Meta refuses the message: one plain-text retry for an interactive message, then stop — never a loop", withEnv(LOCKS_OPEN, async () => {
  const a = world({ waBot: { mode: "live" }, graph: (body) => (body.type === "interactive" ? { error: { code: 131009, message: "Parameter value is not valid" } } : null) });
  const r = await a.say("ابي اطلب");
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].type, "text");
  assert.match(r.sent[1].text.body, /\nhttps:\/\/freshcuts\.sa\/l\/wab-boxes$/); assert.equal(r.sent[1].text.preview_url, true);
  assert.equal(r.log.decision, "replied"); assert.equal(r.log.handoff, null); assert.equal(r.log.replies[0].type, "text");
  const b = world({ waBot: { mode: "live" }, graph: () => ({ error: { code: 131000, message: "Something went wrong" } }) });
  const x = await b.say("ابي اطلب");
  assert.equal(x.sent.length, 2); assert.equal(x.log.decision, "failed"); assert.equal(x.log.handoff, "send_failed");
  assert.match(x.log.error, /^WA_131000 Something went wrong/);
  assert.match(b.sms[0].body, /needs staff \(bot reply failed\)/);
  b.clock.advance(1);
  const y = await b.say("وين موقعكم");
  assert.equal(y.sent.length, 0); assert.equal(y.log.reason, "recent_send_failure");
  assert.equal(b.calls.length, 2, "no further attempts for 10 minutes");
  const c = world({ waBot: { mode: "live" }, graph: () => ({ error: { code: 131047, message: "Re-engagement message" } }) });
  assert.equal((await c.say("شكرا")).sent.length, 1);
  const d = world({ waBot: { mode: "live", interactive: false } });
  const t = await d.say("وين موقعكم");
  assert.deepEqual(t.sent, [txt(ME, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.\nhttps://maps.google.com/?cid=14767749764292326433", true)]);
}));

/* ════════════════════════════════════════════════════════════════════════════
   ١٢/١٠ (بعد تجربة عمر) — الشجرة العميقة، معرفة المنيو من البيانات الحيّة، الأسئلة الشائعة المعتمدة،
   ثبات التحويل، سؤال الموافقة، التصنيف الهجين، وإعادة التشغيل على الرسايل الحقيقية.
═════════════════════════════════════════════════════════════════════════════ */
const KNOW = { menu: W_BOT.indexMenu(LIVE.pages, {}), bundles: LIVE.bundles };
const ALL_LINKS = ["wab-boxes", "wa-boxes", "wa-box-d4", ...LIVE.bundles.map((b) => b.slug)];
const liveWorld = (o = {}) => world({ waBot: { mode: "live" }, bundles: LIVE.bundles, links: ALL_LINKS, ...o, ...(o.waBot ? { waBot: { mode: "live", ...o.waBot } } : {}) });
const bodyOf = (p) => (p.type === "text" ? p.text.body : p.interactive.body.text);
const rowsOf = (p) => p.interactive.action.sections[0].rows;
const urlOf = (p) => p.interactive.action.parameters.url;
const LIVE_BOXES = "🎁 بوكساتنا:\n• بوكسات فردية من 29 ر.س\n• بوكسات لشخصين من 65 ر.س\n• بوكسات المشاركة والعائلة من 85 ر.س";
const HAND = "يرد عليك موظف هنا في أقرب وقت، والمساعد الآلي يترك المحادثة له.";

test("conversation: greeting (link + main menu) → order → delivery → hours → location → payment → thanks (exact payloads)", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, greetMenu: true });
  const g = await w.say("السلام عليكم");
  assert.equal(g.sent.length, 2, "the greeting is the order link, then the main menu");
  assert.deepEqual(g.sent[0], cta(ME, `حيّاك الله في فريش كاتس 👋\n${BOXES}\n${FIRST_LINE}`, "اطلب الآن", "https://freshcuts.sa/l/wab-boxes"));
  assert.equal(g.sent[1].interactive.type, "list"); assert.equal(bodyOf(g.sent[1]), "أو اختر من القائمة 👇");
  assert.deepEqual(rowsOf(g.sent[1]).map((r) => r.id), ["m:boxes", "m:cats", "m:offers", "m:delivery", "m:pickup", "m:status", "m:hours", "m:packs", "m:pay", "m:human"]);
  assert.equal(w.db.log.length, 1, "two messages, one log row");
  w.clock.advance(1);
  const again = await w.say("هلا");
  assert.equal(again.sent.length, 0); assert.equal(again.log.reason, "already_greeted");
  w.clock.advance(1);
  assert.deepEqual((await w.say("ابي اطلب")).sent, [cta(ME, `الطلب من موقعنا يأخذ دقيقة 👇\nاختر طلبك، حدّد موقعك على الخريطة وادفع إلكترونياً، ونبلّغك بكل تحديث.\n${FIRST_LINE}`, "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("كم رسوم التوصيل؟")).sent, [cta(ME,
    `🛵 نوصّل لمسافة 10 كم من فرعنا في حي السلامة بجدة.\nومن 10 إلى 15 كم برسوم مسافة إضافية 3 ر.س لكل كم.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 60 ر.س: 20 ر.س\n• من 60 ر.س: 15 ر.س\n• من 80 ر.س: 10 ر.س\n• من 100 ر.س: 5 ر.س\n• من 150 ر.س: مجاني\n${FIRST_LINE}\nحدّد موقعك على الخريطة في صفحة الطلب وتظهر لك الرسوم قبل الدفع، أو أرسل موقعك 📍 هنا وأتأكد لك.`,
    "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("متى تقفلون")).sent, [txt(ME, "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🟢 مفتوحين الحين لين 2 فجراً.")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("وين موقعكم")).sent, [cta(ME, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.", "افتح الخريطة", "https://maps.google.com/?cid=14767749764292326433")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("تقبلون كاش؟")).sent, [txt(ME, "💳 الدفع الإلكتروني عبر Apple Pay وmada والبطاقات الائتمانية وSTC Pay.")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("يعطيك العافية")).sent, [txt(ME, "العفو، حيّاك الله 🌟")]);
  assert.equal(w.sms.length, 0);
}));

test("the three messages that went wrong in Omar's test on 12/10", withEnv(LOCKS_OPEN, async () => {
  // «الساعة كم» was filed as a complaint, apologised, attached his last order and alerted the manager
  const w = liveWorld({ orders: [order({ order_no: "W1791728428905", status: "delivered", option: "pickup" })] });
  const t = await w.say("الساعة كم");
  assert.equal(t.log.reply_key, "hours"); assert.equal(t.log.handoff, null); assert.equal(w.sms.length, 0);
  assert.match(bodyOf(t.sent[0]), /^⏰ مواعيدنا:/); assert.doesNotMatch(JSON.stringify(t.sent), /نعتذر|W1791728428905|مدير/);
  for (const q of ["كم الساعة", "الساعه كم تقفلون", "لين الساعة كم فاتحين", "الى متى مفتوحين", "ساعة كم تفتحون"]) assert.equal(R.classify({ text: q, type: "text" }, KNOW).key, "hours", q);
  // a complaint needs an actual complaint signal; a weak «waiting» signal about an order is a status question
  for (const q of ["الاكل بارد", "الطلب ناقص", "طلبي متأخر ساعة", "لسه ما وصل الطلب", "عندي شكوى"]) assert.equal(R.classify({ text: q, type: "text" }, KNOW).key, "complaint", q);
  for (const q of ["صار لي ساعة انتظر الطلب", "من ساعة مستني الطلب"]) assert.equal(R.classify({ text: q, type: "text" }, KNOW).key, "status", q);
  for (const q of ["ساعة", "من ساعة", "ساعتين"]) assert.notEqual(R.classify({ text: q, type: "text" }, KNOW).key, "complaint", q);
  // «ايش نوع اللحم»: no approved answer yet ⇒ an honest handover, the same every time, and the log names the missing answer
  w.clock.advance(1);
  const a = await w.say("ايش نوع اللحم");
  assert.deepEqual(a.sent, [txt(ME, `سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\n${HAND}`)]);
  assert.equal(a.log.handoff, "needs_staff"); assert.equal(a.log.detail, "faq:meat"); assert.equal(w.sms.length, 2);
  w.clock.advance(1);
  const b = await w.say("ايش نوع اللحم");
  assert.deepEqual(b.sent, [txt(ME, `محادثتك عند الموظف 🙏\n${HAND}`)], "he keeps writing: told once more that the chat is with staff");
  assert.equal(b.log.reply_key, "handoff_remind"); assert.equal(b.log.handoff, null);
  w.clock.advance(1);
  const c = await w.say("ايش نوع اللحم");
  assert.equal(c.sent.length, 0); assert.equal(c.log.reason, "handoff_open", "consistent: the assistant said it leaves the chat to staff, and it does");
  assert.equal(w.sms.length, 2);
  // once Omar approves an answer in the dashboard, the same question is answered
  const w2 = liveWorld({ waBot: { faq: { meat: { ar: "إجابة تجريبية يكتبها المالك عن نوع اللحم." } } } });
  assert.deepEqual((await w2.say("ايش نوع اللحم")).sent, [txt(ME, "إجابة تجريبية يكتبها المالك عن نوع اللحم.")]);
  assert.equal(w2.sms.length, 0);
  assert.ok(R.FAQ_KEYS.every((k) => !("a" in R.FAQ_DEFS[k]) && !("ar" in R.FAQ_DEFS[k])), "the code ships no answers: they are the owner's");
}));

test("tree: main menu → boxes → a tier → a box (contents, price, its own tracked link); every list has a way back and to staff", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  const m = await w.say("القائمة");
  assert.equal(bodyOf(m.sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.");
  assert.deepEqual(rowsOf(m.sent[0]).map((r) => [r.id, r.title]), [["m:boxes", "🎁 البوكسات"], ["m:cats", "📋 المنيو بالأقسام"], ["m:offers", "🔥 العروض وأول طلب"], ["m:delivery", "🛵 التوصيل والرسوم"],
    ["m:pickup", "🏃 الاستلام من الفرع"], ["m:status", "📦 حالة طلبي"], ["m:hours", "⏰ المواعيد والموقع"], ["m:packs", "👥 باقات التجمعات"], ["m:pay", "💳 طرق الدفع"], ["m:human", "👤 كلّم موظف"]]);
  assert.equal(rowsOf(m.sent[0])[0].description, "فردية من 29 · لشخصين من 65 · المشاركة والعائلة من 85");
  assert.equal(m.sent[0].interactive.footer.text, FOOTER);
  w.clock.advance(1);
  const b = await w.press("m:boxes", "🎁 البوكسات");
  assert.deepEqual(rowsOf(b.sent[0]), [
    { id: "tier:0", title: "بوكسات فردية", description: "6 بوكسات · من 29 ر.س" }, { id: "tier:1", title: "بوكسات لشخصين", description: "6 بوكسات · من 65 ر.س" },
    { id: "tier:2", title: "بوكسات المشاركة والعائلة", description: "6 بوكسات · من 85 ر.س" }, { id: "m:main", title: "↩️ القائمة الرئيسية" }, { id: "m:human", title: "👤 كلّم موظف" }]);
  w.clock.advance(1);
  const t = await w.press("tier:1", "بوكسات لشخصين");
  assert.equal(bodyOf(t.sent[0]), "بوكسات لشخصين 👇 اختر البوكس لمحتواه وسعره.");
  assert.deepEqual(rowsOf(t.sent[0]).map((r) => [r.id, r.title, r.description]), [
    ["box:box-crepe-duo", "الكريب لشخصين", "65 ر.س"], ["box:box-meals-duo", "وجبتين مشاوي لشخصين", "65 ر.س"], ["box:box-burger-duo", "البرجر لشخصين", "65 ر.س"],
    ["box:box-pizza-pasta", "بيتزا وباستا لشخصين", "69 ر.س"], ["box:box-late-night", "السهرة", "72 ر.س"], ["box:box-mixgrill-duo", "ميكس جريل لشخصين", "85 ر.س"],
    ["m:boxes", "🎁 البوكسات", undefined], ["m:human", "👤 كلّم موظف", undefined]]);
  w.clock.advance(1);
  const x = await w.press("box:box-mixgrill-duo", "ميكس جريل لشخصين");
  assert.deepEqual(x.sent, [cta(ME, "*ميكس جريل لشخصين* — 85 ر.س\nوجبتين من اختيارك (ميكس جريل أو كفتة وطرب) + بطاطس + كولسلو + مشروبين غازيين.\nالبوكسات للطلب من الموقع فقط: توصيل، استلام، أو من الطاولة عبر الموقع.", "اطلب البوكس", "https://freshcuts.sa/l/box-mixgrill-duo")]);
  assert.equal(x.log.link_slug, "box-mixgrill-duo");
  // the box's own link was switched off ⇒ the general tracked link, never a dead one
  const w2 = liveWorld({ links: ["wab-boxes"] });
  assert.equal(urlOf((await w2.press("box:box-family", "العائلة")).sent[0]), "https://freshcuts.sa/l/wab-boxes");
  // a box that is no longer offered ⇒ honest handover
  assert.equal((await w2.press("box:box-gone", "x", { from: "966598765432" })).log.reply_key, "data_missing");
}));

test("tree: menu by section → dishes → a dish (price and description from the live menu, link opens that dish)", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  const c = await w.say("المنيو");
  assert.equal(bodyOf(c.sent[0]), "أقسام المنيو 👇 اختر القسم وأعرض لك الأصناف بأسعارها.");
  assert.deepEqual(rowsOf(c.sent[0]).map((r) => [r.id, r.title, r.description]), [
    ["cat:38", "الأكثر طلباً", "9 أصناف · من 25 ر.س"], ["cat:21", "وجبات", "10 أصناف · من 24 ر.س"], ["cat:43", "مشاوي بالوزن", "9 أصناف · من 30 ر.س"], ["cat:23", "كريبات", "11 صنف · من 15 ر.س"],
    ["cat:40", "بيتزا", "13 صنف · من 20 ر.س"], ["cat:42", "طاسات", "5 أصناف · من 29 ر.س"], ["cat:24", "باستا", "9 أصناف · من 25 ر.س"], ["cat:41", "برجر", "4 أصناف · من 19 ر.س"],
    ["cat:25", "حواوشي", "3 أصناف · من 20 ر.س"], ["cat:26", "إضافات", "12 صنف · من 1 ر.س"]]);
  w.clock.advance(1);
  const p = await w.press("cat:40", "بيتزا");
  assert.equal(bodyOf(p.sent[0]), "بيتزا 👇 اختر الصنف لتفاصيله.\nوباقي أصناف القسم في الموقع.");
  assert.equal(rowsOf(p.sent[0]).length, 10);
  assert.deepEqual(rowsOf(p.sent[0])[0], { id: "item:41", title: "بيتزا سوبر سوبريم", description: "31 ر.س · شرائح لحم بقري، سجق، بيبروني، موتزاريلا، فلفل وزيتون" });
  assert.deepEqual(rowsOf(p.sent[0])[9], { id: "m:cats", title: "📋 المنيو بالأقسام" });
  w.clock.advance(1);
  const i = await w.press("item:8", "كريب زنجر سوبريم");
  assert.deepEqual(i.sent, [cta(ME, "*كريب زنجر سوبريم* — 25 ر.س\nستربس دجاج حار، موتزاريلا، شيدر، فلفل وزيتون", "اطلبه الآن", "https://freshcuts.sa/l/wab-menu#item-8")]);
  // by weight: «من»; مشكل مخصوص: the name and the price only (no weights, no serving count)
  w.clock.advance(1);
  assert.equal(bodyOf((await w.press("item:91", "كفتة")).sent[0]), "*كفتة مشوية بالوزن* — من 40 ر.س\nكفتة مشوية على الفحم — متاح بثلث كيلو ونصف كيلو وكيلو");
  w.clock.advance(1);
  assert.equal(bodyOf((await w.press("item:103", "مشكل")).sent[0]), "*مشكل مخصوص بالوزن* — من 53 ر.س");
  // sold out today is said; a hidden dish does not exist for the bot
  const so = liveWorld({ extraSettings: { catalog: { soldOut: { 8: {} }, hiddenIds: [45] } } });
  assert.match(bodyOf((await so.press("item:8", "x")).sent[0]), /\n⚠️ خلص اليوم\.$/);
  assert.equal((await so.press("item:45", "x", { from: "966598765432" })).log.reply_key, "data_missing");
}));

test("free text about the menu is answered from the data — or handed over honestly", withEnv(LOCKS_OPEN, async () => {
  const ask = async (text, opts = {}) => { const w = liveWorld(opts); const r = await w.say(text); return { r, w, p: r.sent[0] }; };
  let x = await ask("عندكم برجر دجاج");
  assert.equal(x.r.log.reply_key, "cat"); assert.deepEqual(rowsOf(x.p).slice(0, 4).map((r) => r.title), ["برجر لحم كلاسيك", "مشروم بيف بيكون برجر", "كريمي مشروم تشيكن", "جريلد تشيكن ساندوتش"]);
  x = await ask("كم سعر البيتزا");
  assert.equal(x.r.log.reply_key, "cat"); assert.match(rowsOf(x.p)[11 - 11].description, /^31 ر\.س/);
  x = await ask("ايش فيه بوكس الشخصين");
  assert.equal(x.r.log.reply_key, "tier"); assert.equal(rowsOf(x.p)[0].id, "box:box-crepe-duo");
  x = await ask("ايش فيه بوكس السهرة");
  assert.equal(bodyOf(x.p), `*بوكس السهرة* — 72 ر.س\n${LIVE.bundles.find((b) => b.slug === "box-late-night").description}\nالبوكسات للطلب من الموقع فقط: توصيل، استلام، أو من الطاولة عبر الموقع.`);
  x = await ask("بكم الكفتة");
  assert.equal(x.r.log.reply_key, "items"); assert.equal(bodyOf(x.p), "• وجبة كفتة وطرب: 37 ر.س\n• وجبة كفتة: 24 ر.س\n• كفتة مشوية بالوزن: من 40 ر.س");
  x = await ask("كم سعر وجبة نص دجاجة");
  assert.equal(bodyOf(x.p), "*وجبة نصف دجاجة على الفحم* — 28 ر.س\nنصف دجاجة مشوية على الفحم تُقدَّم مع الأرز والسلطة والطحينة");
  x = await ask("عندكم ستيك");
  assert.equal(bodyOf(x.p), "ما عندنا ستيك في المنيو 🙏 تقدر تشوف الأقسام من هنا:"); assert.deepEqual(x.p.interactive.action.buttons.map((b) => b.reply.id), ["m:cats", "m:boxes", "bot:human"]);
  x = await ask("فيه شي حار");
  assert.equal(x.r.log.reply_key, "spicy"); assert.ok(rowsOf(x.p).some((r) => r.title === "كريب زنجر سوبريم")); assert.ok(rowsOf(x.p).every((r) => r.id === "m:cats" || /حار|هالابينو|ديناميت|تشيلي/.test(`${r.title} ${r.description}`)));
  x = await ask("وش احلى شي عندكم");
  assert.equal(bodyOf(x.p), "الأكثر طلباً 👇 اختر الصنف لتفاصيله.");
  // facts the data does not hold ⇒ handover until the owner approves an answer
  for (const [q, k] of [["عندكم شي للأطفال", "kids"], ["حلال؟", "halal"], ["في حشو اطراف", "stuffed_crust"], ["اللحم بلدي ولا مستورد", "meat"], ["عندي حساسية من المكسرات", "allergens"], ["فيه اكل نباتي", "vegetarian"], ["عندكم جلسات عوائل", "dine_in"], ["فيه مواقف", "parking"], ["ابي احجز طاولة", "reservation"]]) {
    x = await ask(q);
    assert.equal(x.r.log.detail, `faq:${k}`, q); assert.equal(x.r.log.handoff, "needs_staff", q); assert.equal(x.r.log.reply_key, "staff", q);
    const y = await ask(q, { waBot: { faq: { [k]: { ar: `إجابة معتمدة ${k}` } } } });
    assert.deepEqual(y.r.sent, [txt(ME, `إجابة معتمدة ${k}`)], q);
  }
  // the menu service is down ⇒ no guessing from memory
  x = await ask("كريب زنجر", { pages: null });
  assert.notEqual(x.r.log.reply_key, "item");
  x = await ask("المنيو", { pages: null });
  assert.equal(x.r.log.reply_key, "data_missing");
}));

test("gathering packs, pickup, hours + location, and the delivery check from a shared location", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ extraSettings: { storefront: { seo: { faq: [...FAQ, { q: "هل يمكن الاستلام من الفرع؟", a: "نعم، اختر «استلام» في صفحة الطلب وسيكون طلبك جاهزاً في فرع حي السلامة." }] } } } });
  assert.deepEqual((await w.say("ابي طلب لـ ٥٠ شخص")).sent, [cta(ME, "باقات التجمعات 👥\n• باقة تجمّع ٤–٦ أشخاص: 225 ر.س (لين 15/10)\n• باقة تجمّع ٨–١٠ أشخاص: 395 ر.س (لين 15/10)\n• باقة مناسبة ١٥ شخصاً وأكثر: 595 ر.س (لين 15/10)\nللطلبات الأكبر أو طلبات الشركات اكتب: موظف", "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  assert.deepEqual((await w.press("m:pickup", "x")).sent, [cta(ME, "🏃 نعم، اختر «استلام» في صفحة الطلب وسيكون طلبك جاهزاً في فرع حي السلامة.", "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  const h = await w.press("m:hours", "x");
  assert.equal(h.sent.length, 2); assert.match(bodyOf(h.sent[0]), /^⏰ مواعيدنا:/); assert.equal(urlOf(h.sent[1]), "https://maps.google.com/?cid=14767749764292326433");
  const loc = (q) => liveWorld({ quote: q }).say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.equal(bodyOf((await loc({ ok: true, deliverable: true, fee: 15 })).sent[0]), "✅ موقعك داخل نطاق التوصيل. الرسوم حسب قيمة الطلب وتظهر لك قبل الدفع.");
  assert.match(bodyOf((await loc({ ok: true, deliverable: false, reason: "out_of_range", farZoneOffer: { surcharge: 9 } })).sent[0]), /^موقعك خارج النطاق الأساسي/);
  assert.equal(bodyOf((await loc({ ok: true, deliverable: false, reason: "out_of_range" })).sent[0]), "موقعك خارج نطاق التوصيل حالياً 🙏 تقدر تطلب استلام من الفرع.");
  for (const bad of [null, { ok: false }, { ok: true, deliverable: false, reason: "under_minimum" }]) assert.equal((await loc(bad)).log.reply_key, "data_missing", JSON.stringify(bad));
  let asked = null;
  await liveWorld({ quote: (lat, lng) => { asked = [lat, lng]; return { deliverable: true }; } }).say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.deepEqual(asked, [21.58, 39.15]);
}));

test("media, acknowledgements and other non-questions", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  const v = await w.say(null, { raw: { type: "audio", audio: { id: "A1", voice: true } } });
  assert.deepEqual(v.sent, [txt(ME, `ما أقدر أفتح الصور والمقاطع الصوتية 🙏 حوّلت محادثتك لموظف.\n${HAND}`)]); assert.equal(v.log.handoff, "media");
  const w2 = liveWorld();
  for (const raw of [{ type: "reaction", reaction: { message_id: "x", emoji: "👍" } }, { type: "sticker", sticker: { id: "S" } }]) {
    const r = await w2.say(null, { raw }); assert.equal(r.sent.length, 0); assert.equal(r.log.reason, "ignored_type");
  }
  for (const t of ["تمام", "اوكي", "ok", "طيب", "👍", "لا", "no thanks"]) { const r = await w2.say(t); assert.equal(r.sent.length, 0, t); assert.equal(r.log.reason, "ack", t); }
  assert.equal((await w2.say(null, { from: "966577777777", raw: { type: "image", image: { id: "I", caption: "الطلب وصل ناقص" } } })).log.reply_key, "complaint");
  assert.equal((await w2.say(null, { from: "966566666666", raw: { type: "location" } })).log.reply_key, "media", "a location with no coordinates is treated as an attachment");
}));

test("after a handover the assistant really leaves the chat: facts only, until staff reply (ordinary) or it expires (complaint)", withEnv(LOCKS_OPEN, async () => {
  for (const phrase of ["موظف", "كلموني", "ابي اكلم موظف", "ابغى خدمة العملاء", "agent", "customer service please", "ابي المدير", "محد يرد علي"]) {
    const w = liveWorld();
    const r = await w.say(phrase);
    assert.equal(r.log.reply_key, "human", phrase); assert.equal(r.log.handoff, "asked_human", phrase); assert.equal(w.sms.length, 2, phrase);
  }
  const w = liveWorld();
  assert.deepEqual((await w.say("ابي اكلم موظف")).sent, [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.\n${HAND}`)]);
  // an ordinary handover: menu, prices and delivery are information and are still answered; sales talk is not
  w.clock.advance(1); assert.equal((await w.say("كم رسوم التوصيل")).log.reply_key, "delivery");
  w.clock.advance(1); assert.equal((await w.say("المنيو")).log.reply_key, "cats");
  w.clock.advance(3); assert.equal((await w.say("اسعاركم")).sent.length, 1, "«اسعاركم» during a handover is answered");
  w.clock.advance(1); assert.equal((await w.say("بكم الكفتة")).log.reply_key, "items");
  // he keeps writing other things: one reminder, then quiet
  w.clock.advance(1);
  const rem = await w.say("موظف");
  assert.deepEqual(rem.sent, [txt(ME, `محادثتك عند الموظف 🙏\n${HAND}`)]); assert.equal(rem.log.reply_key, "handoff_remind");
  for (const q of ["السلام عليكم", "ابي اطلب", "قفغفغ", "موظف"]) { w.clock.advance(1); const x = await w.say(q); assert.equal(x.sent.length, 0, q); assert.equal(x.log.reason, "handoff_open", q); assert.ok(x.log.resume_at, "the log says until when"); }
  w.clock.advance(1);
  assert.equal((await w.say("متى تقفلون")).sent.length, 1, "a fact is still answered");
  assert.equal(w.sms.length, 2, "one alert");
  w.clock.advance(1);
  const c = await w.say("الطلب وصل بارد");
  assert.equal(c.sent.length, 1); assert.equal(c.log.handoff, "complaint"); assert.equal(w.sms.length, 4, "a complaint after «موظف» is a new, more serious alert");
  // an ordinary handover ends when a staff member replies; then the normal 30-minute pause, then the bot is back
  const w2 = liveWorld();
  await w2.say("ابي اكلم موظف"); w2.clock.advance(2);
  await w2.cashier("تفضل معك أحمد"); w2.clock.advance(31);
  assert.equal((await w2.say("كم رسوم التوصيل")).sent.length, 1);
  // a complaint stays «facts only» even after staff replied (rule 4b), until it expires or «رجّع البوت»
  const w3 = liveWorld();
  await w3.say("عندي شكوى"); w3.clock.advance(2); await w3.cashier("نعتذر منك"); w3.clock.advance(31);
  assert.equal((await w3.say("المنيو")).log.reply_key, "handoff_remind", "told once that the chat is with staff"); w3.clock.advance(1);
  assert.equal((await w3.say("المنيو")).log.reason, "handoff_open");
  await w3.call("POST", "/api/cms/wabot/chats/unmute", { phone: "0512345678" }); w3.clock.advance(1);
  assert.equal((await w3.say("المنيو")).sent.length, 1);
}));

test("rule 4b: with an open complaint the bot answers facts only — no order link, no first-order line, no second alert", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ at: CLOSED_AT, orders: [order({ status: "delivered" })] });
  const c = await w.say("الطلب وصل بارد وناقص");
  assert.deepEqual(c.sent, [txt(ME, "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nطلبك رقم W1790011111111 قدّامنا.\nالمطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً، والمساعد الآلي يترك المحادثة له.")]);
  assert.equal(w.sms.length, 2, "the alert still goes out while closed");
  w.clock.advance(2);
  assert.deepEqual((await w.say("متى تفتحون")).sent, [txt(ME, "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً.")]);
  w.clock.advance(2);
  assert.equal(urlOf((await w.say("وين موقعكم")).sent[0]), "https://maps.google.com/?cid=14767749764292326433");
  w.clock.advance(2);
  assert.match(bodyOf((await w.say("وين طلبي")).sent[0]), /^طلبك رقم W1790011111111: تم توصيل طلبك ✅$/);
  // an open COMPLAINT: no menu, no prices, no promotion. Told once that the chat is with staff (with the reopening time), then quiet
  w.clock.advance(2);
  const rem = await w.say("اسعاركم");
  assert.equal(rem.log.reply_key, "handoff_remind"); assert.match(bodyOf(rem.sent[0]), /^محادثتك عند الموظف 🙏\nالمطعم مقفل الحين\. يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً/);
  for (const promo of ["السلام عليكم", "عندكم عروض؟", "ابي اطلب", "كم رسوم التوصيل", "المنيو", "ابي اكلم موظف", "الاكل كان محروق", "بوكس العائلة", "القائمة"]) {
    w.clock.advance(2);
    const x = await w.say(promo);
    assert.equal(x.sent.length, 0, promo); assert.equal(x.log.reason, "handoff_open", promo); assert.equal(x.log.detail, "complaint");
  }
  assert.equal(w.sms.length, 2);
  assert.ok(w.calls.every((k) => !/FIRST|wab-boxes|اطلب الآن|جهّز سلتك/.test(JSON.stringify(k.body))), "nothing promotional went to the unhappy customer");
  w.clock.advance(24 * 60);
  assert.equal((await w.say("المنيو")).sent.length, 1, "after handoffOpenHours the chat is normal again");
}));

const FALLBACK2 = (to) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: { type: "button", body: { text: "ما فهمت طلبك تماماً 🙏 اختر من الأزرار، أو اكتب: موظف" }, footer: { text: FOOTER },
  action: { buttons: [{ type: "reply", reply: { id: "bot:menu", title: "📋 القائمة" } }, { type: "reply", reply: { id: "bot:status", title: "📦 وين طلبي؟" } }, { type: "reply", reply: { id: "bot:human", title: "👤 كلّم موظف" } }] } } });
test("rule 5: open hours — known questions at once; an unrecognised message waits 3 min for staff, then the menu buttons + «موظف»; closed — at once", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  assert.equal((await w.say("كم رسوم التوصيل")).sent.length, 1);
  const u = await w.say("قفغفغ", { from: "966598765432" });
  assert.equal(u.sent.length, 0); assert.equal(u.log.decision, "waiting"); assert.equal(u.log.reason, "unknown_wait");
  assert.equal(mins(u.log.resume_at, w.clock.now().toISOString()), 3);
  assert.deepEqual(await w.tick(2), []);
  assert.deepEqual(await w.tick(1), [FALLBACK2("966598765432")]);
  assert.equal(u.log.decision, "replied"); assert.equal(u.log.handoff, null);
  w.clock.advance(1);
  assert.equal(bodyOf((await w.press("bot:menu", "📋 القائمة", { from: "966598765432" })).sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.");
  const w2 = liveWorld();
  const v = await w2.say("قفغفغ");
  w2.clock.advance(1); await w2.cashier("تفضل كيف أخدمك");
  assert.deepEqual(await w2.tick(5), []); assert.equal(v.log.reason, "staff_answered");
  const w3 = liveWorld();
  await w3.say("قفغفغ"); await w3.tick(3); w3.clock.advance(1);
  const s = await w3.say("ثصضص");
  assert.equal(s.sent.length, 0);
  assert.deepEqual(await w3.tick(3), [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.\n${HAND}`)]); assert.equal(s.log.handoff, "not_understood_twice"); assert.equal(w3.sms.length, 2);
  assert.deepEqual((await liveWorld({ at: CLOSED_AT }).say("قفغفغ")).sent, [FALLBACK2(ME)]);
  assert.equal((await liveWorld({ waBot: { unknownWaitMin: 0 } }).say("قفغفغ")).sent.length, 1);
  for (const phrase of ["فيه وظايف عندكم؟", "ابي فاتورة ضريبية", "نبي نتعاون معكم"]) {
    const x = liveWorld();
    const y = await x.say(phrase);
    assert.equal(y.log.reply_key, "staff", phrase); assert.equal(y.log.handoff, "needs_staff", phrase);
    assert.deepEqual(y.sent, [txt(ME, `سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\n${HAND}`)], phrase);
  }
}));

test("delayed replies: stored in the database, re-checked at send time, sent exactly once", withEnv(LOCKS_OPEN, async () => {
  const mk = async (opts = {}) => { const w = liveWorld(opts); await w.cashier("هلا"); const r = await w.say("كم رسوم التوصيل"); return { w, r }; };
  let { w, r } = await mk();
  assert.equal(w.db.jobs.length, 1);
  assert.deepEqual([w.db.jobs[0].kind, w.db.jobs[0].status, w.db.jobs[0].wamid, w.db.jobs[0].ev.text], ["staff_wait", "pending", r.wamid, "كم رسوم التوصيل"]);
  w.clock.advance(5);
  const [a, b] = await Promise.all([w.bot.runDueJobs(), w.bot.runDueJobs()]);
  assert.equal(a + b, 1); assert.equal(w.calls.length, 1); assert.equal(w.db.jobs[0].status, "done");
  assert.deepEqual(await w.tick(60), []);
  ({ w, r } = await mk());
  await w.say("كم رسوم التوصيل", { id: r.wamid });
  assert.equal(w.db.jobs.length, 1); assert.equal(w.db.log.length, 1);
  ({ w, r } = await mk());
  w.setMode("off");
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "mode_off"); assert.equal(w.db.jobs[0].status, "cancelled");
  ({ w, r } = await mk());
  w.db.settings.waBot = { mode: "test", testPhones: ["0544775082"] };
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "test_mode_not_listed");
  ({ w, r } = await mk());
  assert.deepEqual(await w.tick(60), []); assert.equal(r.log.reason, "stale");
  ({ w, r } = await mk());
  w.db.jobs[0].status = "running";
  assert.deepEqual(await w.tick(10), []);
  ({ w, r } = await mk({ failDb: /^SELECT 1 FROM wa_messages/ }));
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "echo_check_failed");
  const d = liveWorld({ waBot: { mode: "dry" } });
  await d.cashier("هلا"); const dr = await d.say("كم رسوم التوصيل");
  assert.deepEqual(await d.tick(5), []); assert.equal(dr.log.decision, "dry"); assert.equal(urlOf(dr.log.replies[0]), "https://freshcuts.sa/l/wab-boxes");
}));

test("no loops and no double replies: webhook re-delivery, duplicate window, hourly cap", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ greetMenu: true });
  for (let i = 0; i < 4; i++) await w.say("السلام عليكم", { id: "wamid.SAME" });
  assert.equal(w.calls.length, 2, "one greeting = its two messages, once"); assert.equal(w.db.log.length, 1);
  assert.equal(await w.bot.handle({ phone: "512345678", wamid: "wamid.SAME", text: "السلام عليكم", type: "text", at: w.clock.now().toISOString(), isEcho: false, intent: null }), true);
  assert.equal(w.calls.length, 2);
  const d = liveWorld();
  assert.equal((await d.say("المنيو")).sent.length, 1);
  const dup = await d.say("ارسل المنيو");
  assert.equal(dup.sent.length, 0); assert.equal(dup.log.reason, "duplicate");
  d.clock.advance(3);
  assert.equal((await d.say("المنيو")).sent.length, 1);
  // the hourly guard for TYPED messages: one calm line, no handover, no alert; quiet until the window slides; then back by itself
  assert.deepEqual([R.botConfig({}).maxRepliesPerHour, R.botConfig({}).maxTapsPerHour, R.botConfig({}).maxRepliesPerMinute], [40, 150, 6]);
  const cap = liveWorld({ waBot: { maxRepliesPerHour: 5, duplicateSeconds: 0 } });
  const keys = [];
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "طرق الدفع", "ابي اطلب", "بكم الكفتة", "اسعاركم"]) { const r = await cap.say(q); keys.push([r.log.reply_key, r.sent.length, r.log.reason || null, r.log.handoff || null]); cap.clock.advance(2); }
  assert.deepEqual(keys, [["cats", 1, null, null], ["delivery", 1, null, null], ["location", 1, null, null], ["hours", 1, null, null], ["payment", 1, null, null],
    ["rate", 1, null, null], ["items", 0, "rate_limited", null], ["cats", 0, "rate_limited", null]]);
  assert.deepEqual(cap.calls[cap.calls.length - 1].body, txt(ME, "وصلنا حد الرسائل الآلية لهذه الساعة 🙏 اكتب «موظف» لو تحتاج مساعدة."));
  assert.equal(cap.sms.length, 0, "the guard never alerts staff"); assert.equal(cap.db.chats.get("512345678").handoff_at ?? null, null, "and never opens a handover");
  const lim = cap.db.log[cap.db.log.length - 1];
  assert.equal(lim.detail, "hour"); assert.equal(mins(lim.resume_at, cap.db.log[0].at), 60, "the log says when the bot answers again: one hour after the oldest counted reply");
  assert.equal((await cap.say("ابي اكلم موظف")).log.handoff, "asked_human", "asking for a person always works, limit or not");
  const cap2 = liveWorld({ waBot: { maxRepliesPerHour: 5, duplicateSeconds: 0 } });
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "طرق الدفع", "ابي اطلب"]) { await cap2.say(q); cap2.clock.advance(2); }
  cap2.clock.advance(52);
  assert.equal((await cap2.say("بكم الكفتة")).log.reply_key, "items", "the window slid: the bot is back without anyone touching it");
  // menu taps are counted apart from typed messages: browsing the tree is never cut off by the typed-message limit
  const nav = liveWorld({ waBot: { maxRepliesPerHour: 5, duplicateSeconds: 0 } });
  const taps = [["m:cats", "📋 المنيو بالأقسام"], ["m:boxes", "🎁 البوكسات"], ["tier:0", "x"], ["tier:1", "x"], ["tier:2", "x"], ["m:main", "x"], ["m:delivery", "x"], ["m:offers", "x"], ["m:hours", "x"], ["m:packs", "x"], ["m:pay", "x"], ["box:box-family", "x"]];
  let navSent = 0;
  for (let i = 0; i < 36; i++) { const t = taps[i % taps.length]; const r = await nav.press(t[0], t[1]); navSent += r.sent.length ? 1 : 0; assert.notEqual(r.log.reply_key, "rate", `tap ${i + 1}`); assert.equal(r.log.handoff || null, null); nav.clock.advance(1); }
  assert.equal(navSent, 36, "36 taps in 36 minutes: every one answered");
  assert.equal((await nav.say("بكم الكفتة")).log.reply_key, "items", "and a typed question after all that browsing is still answered");
  const tapCap = liveWorld({ waBot: { maxTapsPerHour: 20, duplicateSeconds: 0 } });
  for (let i = 0; i < 20; i++) { await tapCap.press(taps[i % taps.length][0], "x"); tapCap.clock.advance(1); }
  const over = await tapCap.press("m:cats", "x");
  assert.equal(over.log.reply_key, "rate"); assert.equal(over.log.handoff || null, null);
  tapCap.clock.advance(1);
  const over2 = await tapCap.press("m:boxes", "x"); assert.equal(over2.log.reason, "rate_limited"); assert.equal(over2.log.detail, "taps");
  // burst: more than maxRepliesPerMinute in one minute ⇒ one «لحظة» line, then quiet for the minute, then normal
  const burst = liveWorld({ waBot: { maxRepliesPerMinute: 3, duplicateSeconds: 0 } });
  const bk = [];
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "طرق الدفع"]) { const r = await burst.say(q); bk.push([r.log.reply_key, r.sent.length, r.log.reason || null]); }
  assert.deepEqual(bk, [["cats", 1, null], ["delivery", 1, null], ["location", 1, null], ["rate_burst", 1, null], ["payment", 0, "rate_limited"]]);
  assert.equal(burst.sms.length, 0);
  burst.clock.advance(2);
  assert.equal((await burst.say("طرق الدفع")).log.reply_key, "payment");
  // settings: the schema allows the generous values and refuses nonsense
  assert.equal(R.configFromBody({ maxRepliesPerHour: 40, maxTapsPerHour: 300, maxRepliesPerMinute: 10 }).ok, true);
  assert.equal(R.configFromBody({ maxRepliesPerHour: 2 }).ok, false); assert.equal(R.configFromBody({ maxRepliesPerMinute: 100 }).ok, false);
}));

test("Omar's session of 12/10 morning: browsing the tree is never cut off, and a handover does not look like «the bot stopped»", withEnv(LOCKS_OPEN, async () => {
  // that morning the limit was 8 replies an hour of ANY kind and reaching it opened a handover; now: defaults (40 typed, 150 taps), no handover
  const w = liveWorld({ waBot: { duplicateSeconds: 0 }, quote: { ok: true, deliverable: true, fee: 15 } });
  const seq = [];
  const step = async (label, p) => { const r = await p; seq.push([label, r.log.reply_key, r.sent.length, r.log.reason || null, r.log.handoff || null]); w.clock.advance(1); return r; };
  await step("السلام عليكم", w.say("السلام عليكم"));
  await step("كم رسوم التوصيل", w.say("كم رسوم التوصيل"));
  await step("location", w.say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } }));
  await step("وين طلبي", w.say("وين طلبي"));
  w.db.chats.get("512345678").handoff_at = null;                    // «no order found» handed over; the coordinator cleared the chat — same here
  await step("متى تقفلون", w.say("متى تقفلون"));
  await step("عندكم عروض", w.say("عندكم عروض"));
  await step("طرق الدفع", w.say("طرق الدفع"));
  await step("بكم الكفتة", w.say("بكم الكفتة"));
  const cats = await step("tap المنيو بالأقسام", w.press("m:cats", "📋 المنيو بالأقسام"));
  const grill = rowsOf(cats.sent[0]).find((r) => /مشاوي بالوزن/.test(r.title));
  assert.ok(grill, "the section he tapped exists in the live menu");
  const dishes = await step("tap مشاوي بالوزن", w.press(grill.id, grill.title));
  const kofta = rowsOf(dishes.sent[0]).find((r) => /كفتة مشوية بالوزن/.test(r.title));
  const dish = await step("tap كفتة مشوية بالوزن", w.press(kofta.id, kofta.title));
  assert.deepEqual(seq.slice(7).map((x) => x.slice(1)), [["items", 1, null, null], ["cats", 1, null, null], ["cat", 1, null, null], ["item", 1, null, null]],
    "the tap that was answered «handover rate_limit» that morning is answered with the dish");
  assert.match(bodyOf(dish.sent[0]), /^\*كفتة مشوية بالوزن\*/);
  assert.equal(w.sms.length, 2, "only the «no order found» handover alerted; the limit alerted nobody");
  // then a voice note: the bot can not open it ⇒ handover, said plainly
  const voice = await step("voice note", w.say(null, { raw: { type: "audio", audio: { id: "A1" } } }));
  assert.equal(voice.log.handoff, "media"); assert.match(bodyOf(voice.sent[0]), /^ما أقدر أفتح الصور والمقاطع الصوتية/);
  // with the chat at staff: location and prices are still answered; he is told once if he writes something else
  assert.equal((await step("وين موقعكم", w.say("وين موقعكم"))).sent.length, 1);
  const prices = await step("اسعاركم", w.say("اسعاركم"));
  assert.deepEqual([prices.log.reply_key, prices.sent.length], ["cats", 1], "«اسعاركم» was «silent (handoff_open)» that morning");
  const more = await step("ابي اطلب", w.say("ابي اطلب"));
  assert.equal(more.log.reply_key, "handoff_remind");
  const quiet = await step("هلا", w.say("هلا"));
  assert.deepEqual([quiet.sent.length, quiet.log.reason, quiet.log.detail], [0, "handoff_open", "media"]); assert.ok(quiet.log.resume_at);
  // staff reply ⇒ the ordinary handover is over; after the pause the bot is fully back
  await w.cashier("تفضل"); w.clock.advance(31);
  assert.equal((await w.say("ابي اطلب")).log.reply_key, "order");
}));

test("missing data: never a partial or placeholder text — a plain «handed to staff» and an alert", withEnv(LOCKS_OPEN, async () => {
  const MISSING = [txt(ME, `ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.\n${HAND}`)];
  const cases = [
    [{ bundles: [] }, "ابي بوكس"], [{ bundles: null }, "السلام عليكم"], [{ bundles: [{ price: 0, section: "x" }, { price: 20 }] }, "عندكم عروض"], [{ pages: null }, "المنيو"], [{ pages: [] }, "وش الاصناف"],
    [{ policy: null }, "كم رسوم التوصيل"], [{ policy: { maxKm: 10, feeByTotal: [] } }, "كم التوصيل"], [{ policy: { maxKm: 0, feeByTotal: POLICY.feeByTotal } }, "توصلون؟"],
    [{ policy: { maxKm: 10, feeByTotal: [{ fee: "x", over: 0 }] } }, "رسوم التوصيل"],
    [{ failDb: /FROM cms_links WHERE slug = ANY/ }, "ابي اطلب"], [{ extraSettings: { storefront: { seo: { faq: [] } } } }, "طرق الدفع"], [{ extraSettings: { storefront: { seo: { faq: [] } } } }, "ابي استلم من الفرع"],
    [{ failDb: /FROM shop_orders/ }, "وين طلبي"],
  ];
  for (const [opts, q] of cases) {
    const w = world({ waBot: { mode: "live" }, ...opts });
    const r = await w.say(q);
    assert.deepEqual(r.sent, MISSING, `${q} ${JSON.stringify(Object.keys(opts))}`);
    assert.equal(r.log.handoff, "data_missing"); assert.equal(r.log.reply_key, "data_missing");
    assert.match(w.sms[0].body, /needs staff \(bot could not answer\)/);
  }
  const nh = world({ waBot: { mode: "live" }, extraSettings: { hours: null } });
  assert.deepEqual((await nh.say("متى تفتحون")).sent, [txt(ME, "ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.")]);
  const w = world({ waBot: { mode: "live" }, first: null, offers: [], extraSettings: { cms: { loyalty: { enabled: false } } } });
  assert.equal(bodyOf((await w.say("السلام عليكم")).sent[0]), `حيّاك الله في فريش كاتس 👋\n${BOXES}`);
  w.clock.advance(3);
  assert.equal(bodyOf((await w.say("عندكم عروض")).sent[0]), BOXES);
  const w2 = world({ waBot: { mode: "live" }, links: ["wab-boxes"] });
  assert.equal(urlOf((await w2.say("ابي اطلب", { referral: { source_id: "1234567", source_type: "ad" } })).sent[0]), "https://freshcuts.sa/l/wab-boxes");
}));

/* ── سؤال الموافقة على تحديثات الطلب ────────────────────────────────────── */
test("opt-in: one question after an order-status answer, stored with its wording as proof; never marketing; never nagging", withEnv(LOCKS_OPEN, async () => {
  const ASK = { messaging_product: "whatsapp", recipient_type: "individual", to: ME, type: "interactive", interactive: { type: "button", body: { text: "تحديثات طلبك على واتساب؟ نرسل لك من فريش كاتس على هذا الرقم: تأكيد الطلب، وقت جاهزيته، وخروجه مع المندوب. توقفها في أي وقت بإرسال كلمة «إيقاف»." }, footer: { text: FOOTER },
    action: { buttons: [{ type: "reply", reply: { id: "optin:yes", title: "نعم، بلّغوني" } }, { type: "reply", reply: { id: "optin:no", title: "لا، شكراً" } }] } } };
  const mk = (o = {}) => liveWorld({ orders: [order({ status: "on_the_way" })], ...o, waBot: { optin: { enabled: true }, ...(o.waBot || {}) } });
  assert.equal(R.botConfig({}).optin.enabled, false, "off by default");
  assert.equal((await liveWorld({ orders: [order({ status: "on_the_way" })] }).say("وين طلبي")).sent.length, 1, "switch off ⇒ no question");
  const w = mk();
  const s = await w.say("وين طلبي");
  assert.equal(s.sent.length, 2); assert.match(bodyOf(s.sent[0]), /^طلبك رقم W1790011111111:/); assert.deepEqual(s.sent[1], ASK);
  w.clock.advance(1);
  assert.equal((await w.say("وين طلبي")).sent.length, 1, "not asked again");
  w.clock.advance(1);
  const y = await w.press("optin:yes", "نعم، بلّغوني");
  assert.deepEqual(y.sent, [txt(ME, "تم ✅ نبلّغك بتحديثات طلباتك هنا. للإيقاف في أي وقت اكتب: إيقاف")]);
  assert.equal(R.TEXTS.optin_ask.ar, C.WA_UPDATES_TEXTS[C.WA_UPDATES_CURRENT].ar, "the bot asks with the storefront's consent wording");
  const row = w.db.optins["512345678"];
  assert.deepEqual([row.updates, row.marketing, row.source, row.updates_version, Boolean(row.updates_answered_at)], [true, false, "bot", "wa-updates-v1", true], "order updates only — marketing consent is a separate question");
  // the builder's append-only consent log: verified phone = the WhatsApp sender, source bot, the wording shown and its version
  assert.deepEqual(w.db.consentLog.map((l) => [l.phone_norm, l.kind, l.value, l.text_version, l.text, l.source, l.ua]), [["512345678", "updates", true, "wa-updates-v1", ASK.interactive.body.text, "bot", `wa:${y.wamid}`]]);
  assert.equal(w.db.proofs.length, 1);
  assert.deepEqual([w.db.proofs[0].phone_norm, w.db.proofs[0].answer, w.db.proofs[0].wording, w.db.proofs[0].lang, w.db.proofs[0].answer_wamid], ["512345678", "yes", "تحديثات طلبك على واتساب؟ نرسل لك من فريش كاتس على هذا الرقم: تأكيد الطلب، وقت جاهزيته، وخروجه مع المندوب. توقفها في أي وقت بإرسال كلمة «إيقاف».", "ar", y.wamid]);
  assert.ok(w.db.proofs[0].asked_at && w.db.proofs[0].at);
  w.clock.advance(60 * 24 * 40);
  assert.equal((await w.say("وين طلبي")).sent.length, 1, "already opted in ⇒ never asked again");
  // «لا»: recorded in the same storage and log, no opt-in, and never asked again (here or at checkout: one answer per number)
  const n = mk({ orders: [order({ status: "delivered" })] });
  await n.say("وين طلبي"); n.clock.advance(1);
  assert.deepEqual((await n.press("optin:no", "لا، شكراً")).sent, [txt(ME, "تمام، ما نرسل لك تحديثات على واتساب.")]);
  assert.equal(n.db.proofs[0].answer, "no"); assert.equal(n.db.optins["512345678"].updates, false); assert.ok(n.db.optins["512345678"].updates_answered_at);
  assert.deepEqual([n.db.consentLog[0].value, n.db.consentLog[0].source], [false, "bot"]);
  n.clock.advance(60 * 24 * 40);
  assert.equal((await n.say("وين طلبي")).sent.length, 1, "answered «لا» ⇒ not asked again");
  // asked but never answered ⇒ may be asked once more after askAfterHours, not before
  const u = mk({ orders: [order({ status: "delivered" })] });
  await u.say("وين طلبي"); u.clock.advance(60 * 24 * 10);
  assert.equal((await u.say("وين طلبي")).sent.length, 1, "10 days later: still not asked (30 days)");
  u.clock.advance(60 * 24 * 21);
  assert.equal((await u.say("وين طلبي")).sent.length, 2);
  // answered at checkout (yes or no) ⇒ the bot never asks
  for (const updates of [true, false]) { const k = mk(); k.db.optins["512345678"] = { updates, marketing: false, updates_answered_at: new Date().toISOString() }; assert.equal((await k.say("وين طلبي")).sent.length, 1, `checkout answer ${updates}`); }
  // the owner edited the wording in the dashboard ⇒ the log keeps that exact text under its own version
  const e = mk({ waBot: { texts: { optin_ask: { ar: "تبغى نرسل لك تحديثات طلبك من فريش كاتس على واتساب؟" } } } });
  await e.say("وين طلبي"); e.clock.advance(1); await e.press("optin:yes", "x");
  assert.equal(e.db.consentLog[0].text, "تبغى نرسل لك تحديثات طلبك من فريش كاتس على واتساب؟"); assert.match(e.db.consentLog[0].text_version, /^bot-[0-9a-f]{10}$/);
  assert.equal(C.botTextVersion(C.WA_UPDATES_TEXTS["wa-updates-v1"].en), "wa-updates-v1");
  // a typed answer right after the question counts; the same word any other time is just an acknowledgement
  const t = mk();
  await t.say("وين طلبي"); t.clock.advance(1);
  assert.equal((await t.say("تمام")).log.reply_key, "optin_yes"); assert.equal(t.db.optins["512345678"].updates, true);
  const t2 = mk();
  await t2.say("وين طلبي"); t2.clock.advance(1);
  assert.equal((await t2.say("لا")).log.reply_key, "optin_no");
  const t3 = mk();
  assert.equal((await t3.say("تمام")).log.reason, "ack"); assert.equal(t3.db.proofs.length, 0);
  // not asked: no order found, a late/stuck order (handover), an unhappy customer, dry mode records nothing
  assert.equal((await mk({ orders: [] }).say("وين طلبي")).sent.length, 1);
  assert.equal((await mk({ orders: [order({ status: "refund_failed" })] }).say("وين طلبي")).sent.length, 1);
  const c = mk(); await c.say("عندي شكوى"); c.clock.advance(1);
  assert.equal((await c.say("وين طلبي")).sent.length, 1);
  const d = mk({ waBot: { mode: "dry" } });
  const ds = await d.say("وين طلبي"); assert.equal(ds.log.replies.length, 2);
  d.clock.advance(1); await d.press("optin:yes", "x");
  assert.equal(d.db.proofs.length, 0); assert.equal(d.db.optins["512345678"], undefined); assert.equal(d.db.consentLog.length, 0);
  // «إيقاف» is honoured as always and does not touch the order-updates consent
  w.clock.advance(1); await w.say("إيقاف");
  assert.equal(w.db.optins["512345678"].updates, true); assert.equal(w.db.optins["512345678"].marketing, false); assert.deepEqual(w.db.optouts, ["512345678"]);
  const pr = await w.call("GET", "/api/cms/wabot/optins");
  assert.equal(pr.status, 200);
}));

/* ── التصنيف الهجين ─────────────────────────────────────────────────────── */
test("LLM (switchable, off by default): classification only, for messages the rules did not understand", withEnv(LOCKS_OPEN, async () => {
  const seen = [];
  const fake = (answer) => async (a) => { seen.push(a); return typeof answer === "function" ? answer(a) : answer; };
  // off ⇒ never called
  let w = liveWorld({ llm: fake({ key: "item", arg: "8", confidence: 0.99 }) });
  assert.equal(R.botConfig({}).llm.enabled, false);
  await w.say("ابي شي فيه دجاج مقرمش"); assert.equal(seen.length, 0);
  // on: only for «unknown»; the reply is still our fixed text built from the live menu
  w = liveWorld({ waBot: { llm: { enabled: true } }, llm: fake({ key: "item", arg: "8", confidence: 0.92, ms: 640 }) });
  await w.say("كم رسوم التوصيل"); assert.equal(seen.length, 0, "the rules understood it: no model call");
  w.clock.advance(1);
  assert.equal(R.classify({ text: "ابغا ذاك اللي جربته قبل اسبوع 0544775082", type: "text" }, KNOW).key, "unknown");
  const r = await w.say("ابغا ذاك اللي جربته قبل اسبوع 0544775082");
  assert.equal(seen.length, 1); assert.equal(seen[0].text, "ابغا ذاك اللي جربته قبل اسبوع 0544775082");
  assert.deepEqual(r.sent, [cta(ME, "*كريب زنجر سوبريم* — 25 ر.س\nستربس دجاج حار، موتزاريلا، شيدر، فلفل وزيتون", "اطلبه الآن", "https://freshcuts.sa/l/wab-menu#item-8")]);
  assert.equal(r.log.intent, "llm:item"); assert.equal(r.log.detail, "llm 92% 640ms");
  // low confidence, an answer that is not ours, a failure or a timeout ⇒ the normal «unknown» flow (wait for staff, then the buttons)
  for (const ans of [{ key: "item", arg: "8", confidence: 0.6 }, null, () => { throw new Error("timeout"); }, { key: null, arg: null, confidence: 0.2 }]) {
    const x = liveWorld({ waBot: { llm: { enabled: true } }, llm: fake(ans) });
    const y = await x.say("هذا كلام مو واضح ابد");
    assert.equal(y.log.decision, "waiting"); assert.equal(y.log.reason, "unknown_wait");
    assert.deepEqual(await x.tick(3), [FALLBACK2(ME)]);
  }
  // what leaves the server: the text with long digit runs masked, plus public menu names; no phone, no name
  assert.equal(LLM.maskText("ابغا الكريب 0544775082 طلب W1790011111111 رقم ٠٥٤٤٧٧٥٠٨٢"), "ابغا الكريب [رقم] طلب [طلب] رقم [رقم]");
  const reqs = [];
  const cls = LLM.makeClassifier({ faqKeys: R.FAQ_KEYS, env: { ANTHROPIC_API_KEY: "k" }, fetch: async (url, init) => { reqs.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: 'النتيجة: {"intent":"item","item_id":"8","confidence":0.9}' }] }) }; } });
  const g = await cls({ text: "ابغا الكريب الحراق 0544775082", menu: KNOW.menu, bundles: LIVE.bundles, cfg: { model: "claude-haiku-5-5", timeoutMs: 2500 } });
  assert.deepEqual([g.key, g.arg, g.confidence], ["item", "8", 0.9]);
  assert.equal(reqs[0].url, "https://api.anthropic.com/v1/messages"); assert.equal(reqs[0].body.model, "claude-haiku-5-5"); assert.deepEqual(reqs[0].body.output_config, { effort: "low" });
  assert.equal(reqs[0].body.messages[0].content, "ابغا الكريب الحراق [رقم]"); assert.doesNotMatch(JSON.stringify(reqs[0].body), /0544775082|544775082/);
  assert.ok(!("temperature" in reqs[0].body) && !("tool_choice" in reqs[0].body));
  // the model can not invent a dish, a box, a category, an FAQ key or an intent
  const V = (o) => LLM.validate(o, { menu: KNOW.menu, bundles: LIVE.bundles, faqKeys: R.FAQ_KEYS });
  for (const bad of [{ intent: "item", item_id: "9999", confidence: 0.9 }, { intent: "box", box: "box-unicorn", confidence: 0.9 }, { intent: "cat", category_id: "1", confidence: 0.9 }, { intent: "faq", faq: "prices", confidence: 0.9 },
    { intent: "refund_now", confidence: 0.9 }, { intent: "item", item_id: "8", confidence: 7 }, { intent: "tier", tier: 5, confidence: 0.9 }, "no json here", { intent: "item", item_id: "8" }]) assert.equal(V(bad), null, JSON.stringify(bad));
  assert.deepEqual(V('{"intent":"box","box":"box-family","confidence":0.8}'), { key: "box", arg: "box-family", confidence: 0.8 });
  assert.deepEqual(V({ intent: "unknown", confidence: 0.3 }), { key: null, arg: null, confidence: 0.3 });
  assert.equal(await LLM.makeClassifier({ env: {}, fetch: async () => { throw new Error("must not be called"); } })({ text: "هلا", menu: KNOW.menu }), null, "no provider key ⇒ no call");
  assert.equal(await LLM.makeClassifier({ env: { ANTHROPIC_API_KEY: "k" }, fetch: async () => ({ ok: false, json: async () => ({}) }) })({ text: "هلا هلا", menu: KNOW.menu }), null);
  assert.equal(await LLM.makeClassifier({ env: { ANTHROPIC_API_KEY: "k" }, fetch: async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) }) })({ text: "هلا هلا", menu: KNOW.menu }), null);
  // settings
  assert.equal(R.configFromBody({ llm: { enabled: true, minConfidence: 0.8 } }).value.llm.enabled, true);
  assert.equal(R.configFromBody({ llm: { model: "bad model!" } }).ok, false);
}));

/* ── تكلفة الذكاء: إخفاء، تسجيل، سقف ───────────────────────────────────── */
test("masking before anything leaves the server: phones, order numbers, links, names after a cue, address details — the district stays", () => {
  const M = LLM.maskText;
  for (const [raw, out] of [
    ["رقمي 0544775082", "رقمي [رقم]"], ["كلموني على +966 54 477 5082", "كلموني على [رقم]"], ["00966544775082", "[رقم]"], ["054-477-5082 ضروري", "[رقم] ضروري"],
    ["بطاقتي 4111 1111 1111 1111", "بطاقتي [رقم]"], ["طلبي W1790011111111 وينه", "طلبي [طلب] وينه"], ["w 1790011111111", "[طلب]"],
    ["اسمي احمد العتيبي ابي بوكس", "اسمي [اسم] ابي بوكس"], ["معك خالد ابي اطلب", "معك [اسم] ابي اطلب"], ["my name is Omar Tarek", "my name is [اسم]"], ["الطلب باسم سارة", "الطلب باسم [اسم]"],
    ["توصلون حي السلامة شارع صاري عمارة 12 شقة 5", "توصلون حي السلامة [عنوان] [عنوان]"], ["انا في حي الصفا جنب مسجد النور", "انا في حي الصفا [عنوان]"],
    ["فيلا 22 حي الروضة", "[عنوان] حي الروضة"], ["موقعي 21.5810, 39.1502", "موقعي [موقع]"], ["https://maps.app.goo.gl/AbC123 هذا موقعي", "[رابط] هذا موقعي"], ["ايميلي omar@example.com", "ايميلي [ايميل]"],
    // ordinary questions are untouched: prices, counts and short numbers are not personal
    ["ابي 2 كريب زنجر وبطاطس", "ابي 2 كريب زنجر وبطاطس"], ["عندكم بوكس ل 6 اشخاص بحدود 200", "عندكم بوكس ل 6 اشخاص بحدود 200"], ["توصلون حي النعيم؟", "توصلون حي النعيم؟"], ["بكم الكفتة", "بكم الكفتة"],
  ]) assert.equal(M(raw), out, raw);
  for (const leak of ["0544775082", "٠٥٤٤٧٧٥٠٨٢ احمد", "اسمي فهد 0561186075 شارع التحلية عمارة 4"]) assert.doesNotMatch(M(leak), /\d{7,}|فهد|التحلية/, leak);
  assert.equal(M("x".repeat(900)).length, 300);
});

test("AI cost: price table → SAR per call, unknown model never under-counted, projection, budgets, settings validation", () => {
  assert.deepEqual(AIC.normUsage({ prompt_tokens: 2675, completion_tokens: 163 }, "openai"), { in: 2675, out: 163, cached: 0 });
  assert.deepEqual(AIC.normUsage({ prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 2000 } }, "openai"), { in: 1000, out: 10, cached: 2000 });
  assert.deepEqual(AIC.normUsage({ input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }, "anthropic"), { in: 600, out: 80, cached: 2000 });
  // the measured classification call of 12/10: 2,675 in + 163 out on claude-haiku-5-5 = $0.000349 = 0.001309 SAR
  assert.deepEqual(AIC.costSar({ in: 2675, out: 163, cached: 0 }, "anthropic/claude-haiku-5-5", null), { sar: 0.001309, priced: true, priceDate: "2026-10-06" });
  assert.deepEqual(AIC.costSar({ in: 4339, out: 631, cached: 0 }, "claude-sonnet-5-5", null).sar, 0.056205);
  const odd = AIC.costSar({ in: 1000, out: 100, cached: 0 }, "some-new-model", null);
  assert.equal(odd.priced, false); assert.equal(odd.sar, 0.0225, "a model missing from the table is charged at the dearest listed price");
  assert.equal(AIC.costSar({ in: 1e6, out: 0, cached: 0 }, "claude-haiku-5-5", { usdSar: 3.8, date: "2026-11-01", models: { "claude-haiku-5-5": { in: 0.2 } } }).sar, 0.76);
  assert.equal(AIC.pricesOf({ models: { "claude-haiku-5-5": { in: -5, out: "x" } }, usdSar: 99 }).models["claude-haiku-5-5"].in, 0.1, "a bad stored price falls back to the default");
  assert.equal(AIC.pricesOf({ usdSar: 99 }).usdSar, 3.75);
  assert.equal(AIC.pricesFromBody({ models: { "claude-haiku-5-5": { in: "abc" } } }, null).ok, false);
  assert.equal(AIC.pricesFromBody({ date: "2026-11-01", models: { "claude-haiku-5-5": { in: 0.12 } } }, null).value.models["claude-haiku-5-5"].in, 0.12);
  assert.equal(AIC.waRatesFromBody({ marketing: 9 }, null).ok, false); assert.equal(AIC.waRatesOf(null).utility, 0.0401);
  assert.equal(AIC.projectMonth(6, new Date("2026-10-12T21:00:00Z")), 15.5, "12 full days gone (it is 00:00 on the 13th in Riyadh) ⇒ 6 ÷ 12 × 31");
  assert.equal(AIC.projectMonth(1, new Date("2026-10-01T03:00:00Z")), null, "less than one day of data ⇒ no projection");
  assert.equal(AIC.budgetStop({ day: 2.99, month: 10 }, { budgetDaySar: 3, budgetMonthSar: 30 }), null);
  assert.equal(AIC.budgetStop({ day: 3, month: 10 }, { budgetDaySar: 3, budgetMonthSar: 30 }), "budget_day");
  assert.equal(AIC.budgetStop({ day: 0.1, month: 30 }, { budgetDaySar: 3, budgetMonthSar: 30 }), "budget_month");
  assert.equal(AIC.budgetStop({ day: 0, month: 0 }, { budgetDaySar: 3, budgetMonthSar: 0 }), "budget_month", "a zero budget means off");
  assert.ok(AIC.budgetSms("budget_day", { day: 3.01, month: 9 }, { budgetDaySar: 3, budgetMonthSar: 30 }, "en").length <= 160);
  assert.match(AIC.chatHash("512345678", "s"), /^[0-9a-f]{16}$/); assert.notEqual(AIC.chatHash("512345678", "s"), AIC.chatHash("512345679", "s"));
  const d = R.botConfig({}).llm;
  assert.deepEqual([d.budgetMonthSar, d.budgetDaySar, d.prices.models["claude-haiku-5-5"].out], [30, 3, 0.5]);
  assert.equal(R.configFromBody({ llm: { budgetDaySar: -1 } }).ok, false); assert.equal(R.configFromBody({ llm: { budgetMonthSar: "" } }).ok, false);
  assert.equal(R.configFromBody({ llm: { budgetDaySar: 1.5, budgetMonthSar: 20 } }).value.llm.budgetDaySar, 1.5);
  assert.equal(R.configFromBody({ waRates: { marketing: 0.25, date: "2026-11-01" } }).value.waRates.marketing, 0.25);
  assert.equal(R.configFromBody({ waRates: { utility: "x" } }).ok, false);
});

test("AI cost: every model call is logged with tokens, SAR cost, hashed chat and the exact masked text; ceilings stop the model and alert once", withEnv(LOCKS_OPEN, async () => {
  const USAGE = { prompt_tokens: 2675, completion_tokens: 163 };
  let n = 0;
  const model = async (a) => { n++; a.cfg.onCall({ provider: "litellm:llm.o2m8.me", model: a.cfg.model, usage: USAGE, usageKind: "openai", ms: 1700, outcome: "ok", sent: LLM.maskText(a.text), promptChars: 5200, promptHash: "abc123abc123" }); return { key: "item", arg: "8", confidence: 0.92, ms: 1700 }; };
  const ph = (i) => ({ from: `96650000${String(1000 + i)}` });
  const w = liveWorld({ waBot: { llm: { enabled: true } }, llm: model });
  await w.say("كم رسوم التوصيل"); assert.equal(w.db.ai.length, 0, "the rules answered: no call, no row");
  const r = await w.say("ابغا ذاك اللي جربته قبل اسبوع اسمي احمد 0544775082", ph(1));
  assert.equal(r.log.reply_key, "item"); assert.equal(w.db.ai.length, 1);
  const row = w.db.ai[0];
  assert.deepEqual([row.purpose, row.provider, row.model, row.in_tokens, row.out_tokens, row.cached_tokens, row.estimated, row.cost_sar, row.priced, row.price_date, row.ms, row.outcome, row.detail, row.log_id],
    ["classify", "litellm:llm.o2m8.me", "claude-haiku-5-5", 2675, 163, 0, false, 0.001309, true, "2026-10-06", 1700, "accepted", "item 92%", r.log.id]);
  assert.equal(row.sent_text, "ابغا ذاك اللي جربته قبل اسبوع اسمي [اسم] [رقم]"); assert.match(row.chat_hash, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(row), /500001001|0544775082|احمد/, "no phone and no name in the cost log");
  // outcomes: low confidence and failures are logged too (a failed call may still be billed)
  const lo = liveWorld({ waBot: { llm: { enabled: true } }, llm: async (a) => { a.cfg.onCall({ model: a.cfg.model, usage: USAGE, usageKind: "openai", ms: 900, outcome: "ok", sent: "x" }); return { key: "item", arg: "8", confidence: 0.5 }; } });
  await lo.say("هذا كلام مو واضح ابد"); assert.equal(lo.db.ai[0].outcome, "low_confidence");
  const to = liveWorld({ waBot: { llm: { enabled: true } }, llm: async (a) => { a.cfg.onCall({ model: a.cfg.model, usage: null, ms: 2500, outcome: "timeout", sent: "هذا كلام مو واضح ابد", promptChars: 5200 }); return null; } });
  await to.say("هذا كلام مو واضح ابد");
  assert.deepEqual([to.db.ai[0].outcome, to.db.ai[0].estimated, to.db.ai[0].in_tokens, to.db.ai[0].cost_sar > 0], ["timeout", true, 2610, true], "no usage from the provider ⇒ estimated from the prompt length, never zero");
  const silent = liveWorld({ waBot: { llm: { enabled: true } }, llm: async () => ({ key: "item", arg: "8", confidence: 0.9 }) });
  await silent.say("هذا كلام مو واضح ابد"); assert.equal(silent.db.ai.length, 1, "a classifier that reports nothing still leaves a row"); assert.equal(silent.db.ai[0].estimated, true);
  // daily ceiling: 0.002 SAR ⇒ two calls (0 and 0.0013 are under it), then rules-only, one SMS to each alert phone, once
  n = 0;
  const b = liveWorld({ waBot: { llm: { enabled: true, budgetDaySar: 0.002 } }, llm: model });
  await b.say("ابغا ذاك اللي جربته قبل اسبوع", ph(1)); b.clock.advance(1);
  await b.say("ابغا ذاك اللي جربته قبل اسبوع", ph(2)); b.clock.advance(1);
  assert.equal(n, 2); assert.equal(b.sms.length, 0);
  const s3 = await b.say("ابغا ذاك اللي جربته قبل اسبوع", ph(3));
  assert.equal(n, 2, "ceiling reached: the model is not called"); assert.equal(s3.log.detail, "llm off: budget_day"); assert.equal(s3.log.reason, "unknown_wait", "the bot carries on with the rules");
  assert.equal(b.sms.length, 2); assert.match(b.sms[0].body, /^WhatsApp bot: AI daily ceiling reached \(.+ SAR\)\. Rules-only until tomorrow\.$/); assert.ok(b.sms[0].body.length <= 160);
  b.clock.advance(1); await b.say("ابغا ذاك اللي جربته قبل اسبوع", ph(4));
  assert.equal(n, 2); assert.equal(b.sms.length, 2, "one alert per day, not one per message");
  assert.equal(b.db.ai.length, 2, "a blocked message costs nothing and adds no call row");
  b.clock.advance(60 * 24);
  await b.say("ابغا ذاك اللي جربته قبل اسبوع", ph(5)); assert.equal(n, 3, "next day the model is back");
  // monthly budget, a zero budget, the alert phones of the AI card, dry mode
  n = 0;
  const m = liveWorld({ waBot: { llm: { enabled: true, budgetMonthSar: 0.001, alertPhones: ["0544775082"] } }, llm: model });
  await m.say("ابغا ذاك اللي جربته قبل اسبوع", ph(1)); m.clock.advance(1);
  const m2 = await m.say("ابغا ذاك اللي جربته قبل اسبوع", ph(2));
  assert.equal(n, 1); assert.equal(m2.log.detail, "llm off: budget_month"); assert.equal(m.sms.length, 1); assert.match(m.sms[0].body, /monthly budget/);
  n = 0;
  const z = liveWorld({ waBot: { llm: { enabled: true, budgetDaySar: 0 } }, llm: model });
  await z.say("ابغا ذاك اللي جربته قبل اسبوع"); assert.equal(n, 0);
  const dry = liveWorld({ waBot: { mode: "dry", llm: { enabled: true, budgetDaySar: 0 } }, llm: model });
  await dry.say("ابغا ذاك اللي جربته قبل اسبوع"); assert.equal(dry.sms.length, 0, "dry mode alerts nobody");
  // the cost database is unreachable ⇒ no spending blind
  n = 0;
  const down = liveWorld({ waBot: { llm: { enabled: true } }, llm: model, failDb: /FROM ai_calls/ });
  const dn = await down.say("ابغا ذاك اللي جربته قبل اسبوع"); assert.equal(n, 0); assert.equal(dn.log.detail, "llm off: cost_db_down");
  // the card
  w.db.tpl = [{ category: "utility", n: 40 }, { category: "marketing", n: 10 }];
  const card = (await w.call("GET", "/api/cms/wabot/cost")).body;
  assert.deepEqual([card.ok, card.enabled, card.model, card.ai.today.calls, card.ai.month.costSar, card.ai.month.perChatSar, card.ai.month.avgMs, card.ai.share.messages, card.ai.share.modelCalls, card.ai.share.pct],
    [true, true, "claude-haiku-5-5", 1, 0.001309, 0.001309, 1700, 2, 1, 50]);
  assert.deepEqual([card.ai.budget.budgetMonthSar, card.ai.budget.budgetDaySar, card.ai.budget.stop, card.ai.prices.date], [30, 3, null, "2026-10-06"]);
  assert.deepEqual(card.wa.replies, { used: 2, free: 1000, left: 998, billable: 0, rateSar: 0.0401, costSar: 0 });
  assert.deepEqual(card.wa.templates, [{ category: "marketing", sent: 10, rateSar: 0.2159, costSar: 2.16 }, { category: "utility", sent: 40, rateSar: 0.0401, costSar: 1.6 }, { category: "authentication", sent: 0, rateSar: 0.0401, costSar: 0 }]);
  assert.equal(card.wa.totalSar, 3.76);
  const audit = (await w.call("GET", "/api/cms/wabot/ai-calls")).body;
  assert.equal(audit.rows.length, 1); assert.equal(audit.rows[0].sent_text, row.sent_text);
  w.setOwner(false); assert.equal((await w.call("GET", "/api/cms/wabot/ai-calls")).status, 403);
}));

/* ── الإعدادات الكاملة: السطر السفلي، المخطط، سجل التعديلات، تنقيب الأسئلة ──────────── */
test("footer «للرجوع… أو موظف»: not under every message (smart, the default); always / first are dashboard options; a way to a person is always there", withEnv(LOCKS_OPEN, async () => {
  assert.equal(R.botConfig({}).footerMode, "smart"); assert.equal(R.configFromBody({ footerMode: "loud" }).ok, false);
  const foot = (p) => (p.type === "interactive" ? p.interactive.footer?.text || null : null);
  const run = async (mode) => {
    const w = liveWorld({ waBot: { footerMode: mode }, disclosure: true, greetMenu: true });
    const out = {};
    const g = await w.say("السلام عليكم"); out.greetLink = foot(g.sent[0]); out.greetMenu = foot(g.sent[1]); out.greetBody = bodyOf(g.sent[0]); out.menuRows = rowsOf(g.sent[1]).map((r) => r.id);
    w.clock.advance(1); out.cta = foot((await w.say("كم رسوم التوصيل")).sent[0]);
    w.clock.advance(1); const l = (await w.say("القائمة")).sent[0]; out.list = foot(l);
    w.clock.advance(1); out.box = foot((await w.press("box:box-mixgrill-duo", "x")).sent[0]);
    w.clock.advance(1); const nm = (await w.say("عندكم ستيك")).sent[0]; out.notmenu = foot(nm); out.notmenuBtns = nm.interactive.action.buttons.map((b) => b.reply.id);
    const u = liveWorld({ waBot: { footerMode: mode, unknownWaitMin: 0 } });
    out.unknown = foot((await u.say("قفغفغ")).sent[0]);
    const o = liveWorld({ waBot: { footerMode: mode, optin: { enabled: true } }, orders: [order({ status: "on_the_way" })] });
    const st = await o.say("وين طلبي"); out.status = foot(st.sent[0]); out.optin = foot(st.sent[1]);
    return out;
  };
  const smart = await run("smart");
  assert.match(smart.greetBody, /^معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف/, "the first message says how to reach a person");
  assert.deepEqual([smart.greetLink, smart.greetMenu], [null, null], "the first message already carries the introduction: no footer repeating «موظف» in the same bubble");
  assert.ok(smart.menuRows.includes("m:human"), "the menu itself carries «كلّم موظف»");
  assert.deepEqual([smart.cta, smart.list, smart.box, smart.notmenu, smart.status], [null, null, null, null, null], "no footer on ordinary answers");
  assert.ok(smart.notmenuBtns.includes("bot:human"));
  assert.equal(smart.unknown, FOOTER, "the not-understood reply keeps it");
  assert.equal(smart.optin, FOOTER, "buttons with no way back (yes / no) keep it");
  const always = await run("always");
  assert.deepEqual([always.greetLink, always.greetMenu, always.cta, always.list, always.box, always.notmenu, always.unknown, always.status, always.optin], Array(9).fill(FOOTER));
  const first = await run("first");
  assert.deepEqual([first.greetLink, first.greetMenu, first.cta, first.list, first.box, first.notmenu, first.status, first.optin], [FOOTER, null, null, null, null, null, null, null]);
  // the dashboard preview: first message of a conversation by default, an ordinary later message with first:false
  const sw = liveWorld({ waBot: { footerMode: "smart" } });
  const s1 = (await sw.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل" })).body.payloads[0];
  assert.match(s1.interactive.body.text, /^معك المساعد الآلي/); assert.equal(foot(s1), null);
  const s2 = (await sw.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل", first: false })).body.payloads[0];
  assert.match(s2.interactive.body.text, /^🛵/); assert.equal(foot(s2), null, "second and later link messages: no introduction and no footer");
  // «موظف» typed works in every mode, footer or not
  const h = liveWorld({ waBot: { footerMode: "first" } });
  await h.say("كم رسوم التوصيل"); h.clock.advance(1);
  assert.equal((await h.say("موظف")).log.handoff, "asked_human");
}));

test("settings are complete: every tunable has a schema row (type, limits, default, Arabic name), out-of-range saves are refused, every save is logged with who and what", withEnv(LOCKS_OPEN, async () => {
  // every key of DEFAULTS (nested for llm / optin / links) is described
  const flat = [];
  for (const [k, v] of Object.entries(R.DEFAULTS)) { if (["llm", "optin", "links"].includes(k)) for (const k2 of Object.keys(v)) flat.push(`${k}.${k2}`); else flat.push(k); }
  flat.push("waRates");
  assert.deepEqual(flat.filter((k) => !R.SCHEMA[k]), [], "a setting without a schema row");
  assert.deepEqual(Object.keys(R.SCHEMA).filter((k) => !flat.includes(k)), [], "a schema row without a setting");
  const def = R.botConfig({});
  for (const [key, s] of Object.entries(R.SCHEMA)) {
    assert.ok(s.ar && R.SCHEMA_GROUPS[s.group], key);
    if (s.type !== "number") continue;
    const at = (v) => { const o = {}; const ks = key.split("."); let c = o; ks.forEach((k, i) => { if (i === ks.length - 1) c[k] = v; else c = c[k] = {}; }); return o; };
    const get = (cfg) => key.split(".").reduce((a, k) => a[k], cfg);
    assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max) && get(def) >= s.min && get(def) <= s.max, `${key}: default inside its limits`);
    for (const ok of [s.min, s.max]) { const v = R.configFromBody(at(ok)); assert.equal(v.ok, true, `${key}=${ok}`); assert.equal(get(R.botConfig({ waBot: v.value })), ok, `${key} stored and read back`); }
    for (const bad of [s.min - 1, s.max + 1, "", "abc", null]) assert.equal(R.configFromBody(at(bad)).ok, false, `${key}=${JSON.stringify(bad)} must be refused`);
  }
  const w = liveWorld();
  const sch = (await w.call("GET", "/api/cms/wabot/schema")).body;
  const row = sch.settings.find((x) => x.key === "humanPauseMin");
  assert.deepEqual([row.type, row.min, row.max, row.default, row.value, row.unit, row.groupAr, Boolean(row.ar && row.help)], ["number", 1, 720, 30, 30, "دقيقة", "البوت والموظف", true]);
  assert.equal(sch.faq.length, R.FAQ_KEYS.length); assert.ok(sch.texts.length > 50);
  // audit trail
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 45, llm: { budgetDaySar: 2 } })).status, 200);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 45 })).status, 200);
  assert.equal(w.db.cfgLog.length, 1, "a save that changes nothing adds no row");
  assert.equal(w.db.cfgLog[0].who, "عمر (owner)", "a dashboard user: name and role");
  w.setActor({ id: 0, username: "admin", name: "المالك", role: "owner", adminKey: true });
  await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 46 });
  assert.equal(w.db.cfgLog[1].who, "owner token", "a script or agent using the owner token is named as such (the live row of 12/10 02:54Z had who: null)");
  w.setActor(null); await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 45 });
  assert.equal(w.db.cfgLog[2].who, "unknown", "never empty");
  w.db.cfgLog.splice(1); w.setActor({ name: "عمر", role: "owner" });
  assert.deepEqual(w.db.cfgLog[0].changes.map((x) => [x.path, x.to]).filter((x) => ["humanPauseMin", "llm.budgetDaySar"].includes(x[0])), [["humanPauseMin", 45], ["llm.budgetDaySar", 2]]);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { humanPauseMin: 100000 })).status, 400);
  assert.equal(w.db.cfgLog.length, 1);
  assert.equal((await w.call("GET", "/api/cms/wabot/config-log")).body.rows.length, 1);
  w.setOwner(false); assert.equal((await w.call("GET", "/api/cms/wabot/config-log")).status, 403);
  assert.deepEqual(R.configDiff({ a: 1, b: { c: [1] } }, { a: 2, b: { c: [1] }, d: true }), [{ path: "a", from: 1, to: 2 }, { path: "d", from: null, to: true }]);
}));

test("the settings that used to be constants really drive the behaviour", withEnv(LOCKS_OPEN, async () => {
  // unknownHandoverAfter: 3 ⇒ two fallbacks, the third hands over
  const u = liveWorld({ waBot: { unknownWaitMin: 0, unknownHandoverAfter: 3, duplicateSeconds: 0 } });
  assert.equal((await u.say("قفغفغ")).log.handoff, null); u.clock.advance(1);
  assert.equal((await u.say("ثصضص")).log.handoff, null); u.clock.advance(1);
  assert.equal((await u.say("لالالا بيس")).log.handoff, "not_understood_twice");
  // disclosureHours: 2 ⇒ introduced again after two hours, not after one
  const d = liveWorld({ waBot: { disclosureHours: 2 }, disclosure: true });
  assert.match(bodyOf((await d.say("وين موقعكم")).sent[0]), /^معك المساعد الآلي/); d.clock.advance(60);
  assert.doesNotMatch(bodyOf((await d.say("طرق الدفع")).sent[0]), /المساعد الآلي/); d.clock.advance(61);
  assert.match(bodyOf((await d.say("متى تقفلون")).sent[0]), /^معك المساعد الآلي/);
  // offerEndWithinDays
  const now = new Date("2026-10-12T10:00:00Z");
  assert.equal(R.endsSoon("2026-10-15", now, "ar"), " (لين 15/10)"); assert.equal(R.endsSoon("2026-10-15", now, "ar", 2), ""); assert.equal(R.endsSoon("2026-11-10", now, "ar", 30), " (لين 10/11)");
  // optinAnswerWindowMin: a typed «تمام» counts only inside the window
  const o = liveWorld({ waBot: { optin: { enabled: true }, optinAnswerWindowMin: 10 }, orders: [order({ status: "on_the_way" })] });
  await o.say("وين طلبي"); o.clock.advance(11);
  assert.equal((await o.say("تمام")).log.reason, "ack");
}));

test("FAQ mining: the unanswered and handed-over questions grouped by similarity, with counts and examples", withEnv(LOCKS_OPEN, async () => {
  const g = R.mineQuestions([
    { text: "عندكم توصيل لمكة؟", key: "unknown", phone: "1" }, { text: "توصلون مكة", key: "unknown", phone: "2" }, { text: "هل فيه توصيل الى مكة", key: "staff", handoff: "needs_staff", phone: "3" },
    { text: "ابي فاتورة ضريبية", key: "staff", handoff: "needs_staff", phone: "4" }, { text: "ممكن فاتورة ضريبية للطلب", key: "staff", handoff: "needs_staff", phone: "4" },
    { text: "فيه وظايف", key: "staff", handoff: "needs_staff", phone: "5" }, { text: "؟؟", key: "unknown", phone: "6" }]);
  assert.deepEqual(g.map((x) => [x.count, x.customers, x.handoffs]), [[3, 3, 1], [2, 1, 2]]);
  assert.match(g[0].words.join(" "), /مكه/); assert.equal(g[0].examples.length, 3); assert.ok(g[1].words.includes("فاتوره") || g[1].words.includes("فاتورة"));
  const w = liveWorld({ waBot: { unknownWaitMin: 0, duplicateSeconds: 0 } });
  let i = 0; const from = () => ({ from: `96650000${2000 + ++i}` });
  for (const t of ["ابي فاتورة ضريبية", "ممكن فاتورة ضريبية", "فاتورة ضريبية لو سمحت", "كم رسوم التوصيل", "ايش نوع اللحم", "اللحم بلدي ولا مستورد", "فيه وظايف عندكم؟"]) { await w.say(t, from()); w.clock.advance(1); }
  const r = (await w.call("GET", "/api/cms/wabot/faq-mining", {}, { days: "30" })).body;
  assert.equal(r.ok, true); assert.equal(r.messages, 7);
  assert.ok(r.intents.find((x) => x.key === "delivery" && x.n === 1));
  assert.deepEqual([r.unanswered.groups[0].count, r.unanswered.groups[0].handoffs], [3, 3]); assert.match(r.unanswered.groups[0].examples.join(" "), /فاتورة/);
  assert.deepEqual(r.faqWaiting, [{ key: "meat", q: R.FAQ_DEFS.meat.q, n: 2 }], "questions waiting for the owner's FAQ answer, by how often they were asked");
  assert.ok(r.unanswered.singles.some((x) => /وظايف/.test(x)));
}));

test("replay: the stored inbound messages run through the current classifier offline — nothing sent, nothing logged", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ waBot: { mode: "off" } });
  for (const [t, from] of [["السلام عليكم", "966544775082"], ["الساعة كم", "966544775082"], ["ايش نوع اللحم", "966544775082"], ["بكم الكفتة", "966512345678"]]) await w.say(t, { from });
  assert.equal(w.db.log.length, 0);
  const r = await w.call("GET", "/api/cms/wabot/replay", {}, { limit: "50" });
  assert.equal(r.body.count, 4); assert.equal(r.body.menuItems, KNOW.menu.items.length); assert.ok(r.body.menuItems > 70);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.text, x]));
  assert.equal(by["الساعة كم"].key, "hours"); assert.match(by["الساعة كم"].would, /^⏰ مواعيدنا:/);
  assert.equal(by["ايش نوع اللحم"].key, "staff"); assert.equal(by["ايش نوع اللحم"].handoff, "needs_staff");
  assert.equal(by["بكم الكفتة"].key, "items"); assert.equal(by["السلام عليكم"].messages, 2);
  assert.ok(r.body.rows.every((x) => /^…\d{4}$/.test(x.phone)), "phones are shown as the last four digits only");
  assert.equal(w.calls.length, 0); assert.equal(w.db.log.length, 0); assert.equal(w.sms.length, 0);
  w.setOwner(false);
  assert.equal((await w.call("GET", "/api/cms/wabot/replay", {}, {})).status, 403);
}));

/* ── ١٥٠+ صياغة حقيقية ──────────────────────────────────────────────────── */
test("classification of 200+ realistic phrasings (Saudi/Gulf, Egyptian, fusha, English, franco, typos, short and ambiguous)", () => {
  const T = {
    greet: ["السلام عليكم", "سلام عليكم ورحمة الله", "هلا والله", "مرحبا", "مساء الخير", "صباح الخير", "hi", "Hello", "hey", "salam", "هااااي", "يا هلا"],
    main: ["القائمة", "القائمه", "رجوع", "menu", "back", "0", "القائمة الرئيسية"],
    cats: ["المنيو", "ممكن المنيو لو سمحت", "وش عندكم", "ايش عندكم", "عندكم ايه", "ارسل المنيو", "send me the menu", "el menu law sama7t", "اسعاركم", "قائمة الطعام", "عندكو ايه", "عايز اكل", "وش الاصناف"],
    "cat:40": ["بيتزا", "كم سعر البيتزا", "عندكم بيتزا؟", "البيتزا بكام", "how much is the pizza"], "cat:41": ["عندكم برجر دجاج", "برجر", "البرجر بكم"], "cat:25": ["الحواوشي بكام", "حواوشي"], "cat:24": ["مكرونة", "باستا"], "cat:23": ["كريبات", "عندكم كريب"],
    "cat:43": ["مشاوي بالكيلو", "اسعار المشاوي بالوزن"],
    "item:8": ["كريب زنجر", "بكم كريب زنجر سوبريم"], "item:13": ["كم سعر وجبة نص دجاجة", "وجبة نصف دجاجة"], "item:18": ["وجبة ميكس جريل"], "item:61": ["باستا بشاميل"], "item:45": ["بيتزا مارجريتا بكم"], "item:20": ["حواوشي كيري بسطرمة"],
    items: ["بكم الكفتة", "وجبة كفتة"],
    notmenu: ["عندكم ستيك", "بكم الستيك", "فيه شاورما"],
    best: ["وش تنصحني", "ايش الاكثر طلب", "what do you recommend", "وش احلى شي عندكم", "محتار وش اطلب"],
    boxes: ["ابي بوكس", "البوكسات", "عندكم بوكسات؟", "boxes", "بوكس الكريب"],
    "tier:0": ["بوكس فردي", "بوكس لشخص واحد", "ابي بوكس لي انا"], "tier:1": ["ايش فيه بوكس الشخصين", "بوكس لشخصين", "box for two", "بوكس لاثنين"], "tier:2": ["بوكس عائلي", "بوكسات المشاركة", "ابي شي للعائلة"],
    "box:box-family": ["بوكس العائلة"], "box:box-late-night": ["ايش فيه بوكس السهرة"], "box:box-solo-crepe": ["بوكس الكريب الفردي"], "box:box-burger-duo": ["بوكس البرجر لشخصين"], "box:box-taste-all": ["بوكس التشكيلة"], "box:box-mashakel": ["بوكس المشكل"],
    packs: ["ابي طلب لـ ٥٠ شخص", "عندكم باقات تجمعات", "عزيمة ٢٠ نفر", "catering for an event", "طلب كبير لشركة", "باقة تجمع"],
    order: ["ابي اطلب", "ابغى اطلب", "عايز اطلب", "عاوز اطلب", "اريد اطلب", "كيف اطلب", "رابط الطلب", "ارسل اللينك", "i want to order", "how can i order", "abi atlob", "3ayez atlob", "اطلب اونلاين"],
    pickup: ["ابي استلم من الفرع", "عندكم سفري؟", "pickup available?", "تيك اواي"],
    offers: ["عندكم عروض؟", "فيه عروض", "عروض اليوم", "وش العروض", "any offers?", "discount", "في كود خصم؟", "كوبون", "deals today", "فيه خصم"],
    delivery: ["توصيل؟", "عندكم توصيل", "توصلون حي الصفا؟", "هل توصلون لحي النزهة", "do you deliver to al rawdah", "كم رسوم التوصيل", "التوصيل بكم", "سعر التوصيل", "is delivery free", "التوصيل مجاني؟", "الحد الادنى للطلب", "كم ياخذ التوصيل", "delivery fee?", "twseel", "مناطق التوصيل", "بكام التوصيل"],
    hours: ["متى تفتحون", "متى تقفلون", "مواعيد الدوام", "ساعات العمل", "مفتوحين؟", "فاتحين الحين", "are you open now", "opening hours", "what time do you close", "شغالين الحين", "لسه فاتحين؟", "لين متى فاتحين", "ذكرني لما تفتحون", "الساعة كم", "كم الساعة", "الى الساعة كم"],
    location: ["وين موقعكم", "وين المطعم", "فين المطعم", "ارسل اللوكيشن", "العنوان", "location", "where are you located", "address?", "عندكم فروع؟", "كيف اوصلكم", "وينكم"],
    payment: ["طرق الدفع", "اقدر ادفع كاش؟", "الدفع عند الاستلام؟", "تقبلون مدى", "apple pay?", "cash on delivery", "payment methods", "stc pay متوفر"],
    status: ["وين طلبي", "وين الطلب", "فين طلبي", "متى يوصل طلبي", "حالة الطلب", "تتبع الطلب", "where is my order", "track my order", "wen talabi", "طلبي W1790012345678", "وين المندوب", "فين الاوردر", "W1790012345678"],
    complaint: ["الاكل وصل بارد", "الطلب ناقص", "جاني طلب غلط", "طلبي متأخر ساعة", "the food was cold", "missing item", "الاكل محروق", "عندي شكوى", "تجربة سيئة", "ابي استرجاع المبلغ", "رجعوا فلوسي", "refund please", "صار عندي تسمم"],
    problem: ["ما قدرت ادفع", "انخصم المبلغ وما وصل تاكيد", "payment failed", "charged twice", "الموقع ما يفتح", "website not working", "الكود ما يشتغل", "كود FIRST مرفوض"],
    change: ["ابي الغي الطلب", "كنسل الطلب", "cancel my order", "ابي اعدل الطلب", "نسيت اضيف بيبسي", "ابي اغير العنوان", "wrong address", "بدون بصل لو سمحت"],
    human: ["موظف", "ابي اكلم موظف", "كلموني", "خدمة العملاء", "talk to a human", "customer service", "ابي المدير", "محد يرد", "call me", "agent", "رقمكم"],
    thanks: ["شكرا", "مشكور", "يعطيك العافية", "thanks", "thank you", "تسلم", "مع السلامة", "bye"],
    stop: ["لا ترسلون لي", "الغاء الاشتراك", "unsubscribe", "وقفوا الرسايل", "احذفوا رقمي"],
    ack: ["تمام", "اوكي", "ok", "طيب", "👍", "ماشي"], nack: ["لا", "لا شكرا", "no"],
    "faq:meat": ["ايش نوع اللحم", "اللحم بلدي ولا مستورد", "نوع اللحوم عندكم", "لحمكم بقري ولا غنم", "what kind of meat", "الدجاج مبرد ولا مجمد"],
    "faq:halal": ["حلال؟", "الاكل حلال", "is it halal"], "faq:stuffed_crust": ["في حشو اطراف", "البيتزا بحشو الاطراف", "stuffed crust?"], "faq:kids": ["عندكم شي للأطفال", "وجبات اطفال", "kids meal"],
    "faq:allergens": ["عندي حساسية من المكسرات", "gluten free options?", "فيه سمسم"], "faq:vegetarian": ["فيه اكل نباتي؟", "vegetarian?"], "faq:calories": ["السعرات كم", "اكل دايت"],
    "faq:dine_in": ["عندكم جلسات؟", "فيه قسم عوائل"], "faq:parking": ["فيه مواقف؟", "parking available?"], "faq:reservation": ["ابي احجز طاولة", "do you take reservations"], "faq:apps": ["انتم في هنقرستيشن؟", "موجودين على كيتا"],
    spicy: ["فيه شي حار", "شي حار", "ابي اكل سبايسي", "spicy food"],
    unknown: ["asdkjh", "؟؟", "١٢٣", "zzz", "......", "كم", "ابي", "ساعة", "طيب وبعدين"],
    staff: ["فيه وظايف؟", "ابي فاتورة ضريبية", "نبي نتعاون معكم"],
  };
  const wrong = [];
  let n = 0;
  for (const [exp, phrases] of Object.entries(T)) for (const p of phrases) {
    n++;
    const c = R.classify({ text: p, type: "text" }, KNOW);
    const got = exp.includes(":") ? `${c.key}:${c.arg}` : c.key;
    if (got !== exp) wrong.push(`«${p}» → ${c.key}${c.arg != null ? `:${JSON.stringify(c.arg)}` : ""} (${c.rawIntent}), expected ${exp}`);
  }
  assert.deepEqual(wrong, [], `${wrong.length}/${n} misclassified`);
  assert.ok(n >= 200, `phrasings: ${n}`);
  assert.equal(R.classify({ text: "إيقاف", type: "text", intent: "stop" }, KNOW).key, "stop");
  assert.equal(R.classify({ text: "[صورة]", type: "image" }, KNOW).key, "media");
  assert.equal(R.classify({ text: "[رسالة صوتية]", type: "audio" }, KNOW).key, "media");
  assert.equal(R.classify({ text: "[ملصق]", type: "sticker" }, KNOW).key, null);
  assert.deepEqual(R.classify({ text: "[موقع]", type: "location", location: { lat: 21.5, lng: 39.1 } }, KNOW).arg, { lat: 21.5, lng: 39.1 });
  // every list/button id the bot itself sends is understood when it comes back
  for (const id of ["m:main", "m:boxes", "m:cats", "m:offers", "m:delivery", "m:pickup", "m:status", "m:hours", "m:packs", "m:pay", "m:human", "tier:0", "box:box-family", "cat:40", "item:8", "bot:menu", "bot:status", "bot:human", "optin:yes", "optin:no"]) {
    assert.ok(R.classify({ text: "x", type: "interactive", interactiveId: id }, KNOW).key, id);
  }
  assert.equal(R.classify({ text: "x", type: "interactive", interactiveId: "item:8; DROP" }, KNOW).rawIntent.startsWith("list:"), false, "a malformed id is not trusted");
});

test("every screen of the tree, for the whole live menu and all boxes, fits WhatsApp's limits in both languages", () => {
  const cfg = R.botConfig({ waBot: { mode: "live" } });
  let screens = 0;
  for (const at of [OPEN_AT, CLOSED_AT]) for (const lang of ["ar", "en"]) for (const interactive of [true, false]) {
    const now = new Date(at), settings = { hours: HOURS, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: [...FAQ, { q: "هل يمكن الاستلام من الفرع؟", a: "نعم.", a_en: "Yes." }] } } };
    const data = { settings, now, open: W_BOT.openState(settings, now), loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 }, bundles: LIVE.bundles, menu: KNOW.menu, policy: POLICY, first: FIRST,
      order: order({ status: "on_the_way" }), links: Object.fromEntries([...ALL_LINKS, "wab-menu"].map((s) => [s, true])), chat: {}, quote: { deliverable: true } };
    const jobs = [["main"], ["boxes"], ["cats"], ["best"], ["spicy"], ["packs"], ["pickup"], ["hoursloc"], ["area"], ["notmenu", "ستيك"], ["optin_yes"], ["optin_no"], ["items", ["87", "17", "91"]],
      ...[0, 1, 2].map((i) => ["tier", String(i)]), ...LIVE.bundles.filter((b) => b.section).map((b) => ["box", b.slug]), ...KNOW.menu.categories.map((c) => ["cat", c.id]), ...KNOW.menu.items.map((i) => ["item", i.id])];
    for (const [key, arg] of jobs) {
      const r = R.buildReply(key, { cfg, lang, data, referral: null, arg });
      for (const one of [r, ...(r.extra || [])]) {
        const p = R.toPayload(one, { cfg, lang, interactive });
        assert.equal(R.payloadProblem(p), null, `${key} ${JSON.stringify(arg)} ${lang} interactive=${interactive}`);
        const text = p.type === "text" ? p.text.body : p.interactive.body.text;
        assert.doesNotMatch(text, /\{[a-z_]+\}|undefined|NaN|\n\n\n/, key);
        if (p.type === "interactive" && p.interactive.type === "list") {
          const rows = p.interactive.action.sections[0].rows;
          assert.ok(rows.length <= 10 && rows.every((x) => [...x.title].length <= 24 && [...(x.description || "")].length <= 72), `${key} ${arg}`);
          assert.ok(key === "cats" || rows.some((x) => /^m:/.test(x.id)), `${key}: a way back / to staff`);
        }
        screens++;
      }
    }
  }
  assert.ok(screens > 900);
  for (const k of R.TEXT_KEYS) for (const lang of ["ar", "en"]) assert.equal(R.textProblem(k, lang, R.TEXTS[k][lang]), null, `${k}.${lang}`);
  for (const k of R.TEXT_KEYS) assert.doesNotMatch(R.TEXTS[k].ar, /وحشتنا|دلوقتي|عايز|عاوز|بتاع|امبارح|إزاي|ازاي|كده|مفيش|\sمش\s|النهارده|بكام|لسه|هنبعت|هنرد|بنبعت|بأسرع وقت/, k);
});

test("FAQ answers are the owner's: saved from the dashboard, validated, listed with what is still missing", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  const g = await w.call("GET", "/api/cms/wabot/config");
  assert.deepEqual(g.body.faq.map((f) => f.key), R.FAQ_KEYS); assert.ok(g.body.faq.every((f) => f.ar === "" && f.q && f.needs));
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { faq: { prices: { ar: "x" } } })).status, 400);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { faq: { halal: { ar: "نص فيه {متغيّر}" } } })).status, 400);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { faq: { halal: { ar: "إجابة المالك" } }, optin: { enabled: true, askAfterHours: 48 }, llm: { enabled: false } })).body.ok, true);
  assert.deepEqual(w.db.settings.waBot.faq, { halal: { ar: "إجابة المالك" } });
  assert.deepEqual((await w.say("حلال؟")).sent, [txt(ME, "إجابة المالك")]);
  assert.deepEqual((await w.say("is it halal", { from: "966598765432" })).sent, [txt("966598765432", "إجابة المالك")], "no English version ⇒ the approved Arabic, not a guess");
  await w.call("PUT", "/api/cms/wabot/config", { faq: { halal: { ar: "" } } });
  assert.deepEqual(w.db.settings.waBot.faq, {});
}));

/* ── كل معلومة من النظام الحي وقت الرد (طلب عمر ١٢/١٠) ─────────────────── */
test("live system: nothing is frozen in the texts — prices, offers, availability and hours follow the system at reply time", withEnv(LOCKS_OPEN, async () => {
  // no reply text carries a number at all: every price, minimum, distance, hour, date and code comes from the data
  for (const k of R.TEXT_KEYS) for (const lang of ["ar", "en"]) {
    assert.doesNotMatch(R.TEXTS[k][lang], /[0-9٠-٩]/, `${k}.${lang} has a hard-coded number`);
    assert.doesNotMatch(R.TEXTS[k][lang], /FIRST|خصم \S+ ?٪|% off/, `${k}.${lang} names an offer or a code`);
  }
  for (const k of R.FAQ_KEYS) assert.deepEqual(Object.keys(R.FAQ_DEFS[k]).sort(), ["needs", "q"], "FAQ entries ship without answers");
  const packs = async (o) => bodyOf((await liveWorld(o).say("عندكم باقات تجمعات")).sent[0]);
  const off = (patch) => LIVE.offers.map((x) => (x.id === "gathering_4" ? { ...x, ...patch } : x));
  // an offer that ended yesterday, or has not started, is not mentioned; one that ends far away carries no date
  assert.doesNotMatch(await packs({ offers: off({ until: "2026-10-11" }) }), /٤–٦/);
  assert.doesNotMatch(await packs({ offers: off({ from: "2026-10-20" }) }), /٤–٦/);
  assert.match(await packs({ offers: off({ until: "2026-11-30" }) }), /• باقة تجمّع ٤–٦ أشخاص: 225 ر\.س\n/);
  assert.match(await packs({ offers: off({ until: "2026-10-12" }) }), /225 ر\.س \(لين 12\/10\)/, "the last day is still valid, and said");
  assert.doesNotMatch(await packs({ extraSettings: { catalog: { pausedOffers: { gathering_4: {} } } } }), /٤–٦/, "paused from the dashboard");
  // the registry is unreachable ⇒ say less (what the store itself lists), never a guessed date
  const less = await packs({ offers: null });
  assert.match(less, /٤–٦ أشخاص: 225 ر\.س\n/); assert.doesNotMatch(less, /لين/);
  // every pack's offer is over ⇒ nothing to quote ⇒ handover, not an empty list
  assert.equal((await liveWorld({ offers: [] }).say("عندكم باقات تجمعات")).log.reply_key, "data_missing");
  // «العروض»: first-order rule and loyalty as configured, then what is time-limited, then the boxes
  assert.equal(bodyOf((await liveWorld().say("عندكم عروض؟")).sent[0]),
    `${FIRST_LINE}\n⭐ وكل 3 طلبات من الموقع لك توصيل مجاني على طلب من 60 ر.س وأكثر.\n⏳ لفترة محدودة:\n• باقة تجمّع ٤–٦ أشخاص: 225 ر.س (لين 15/10)\n• باقة تجمّع ٨–١٠ أشخاص: 395 ر.س (لين 15/10)\n• باقة مناسبة ١٥ شخصاً وأكثر: 595 ر.س (لين 15/10)\n${LIVE_BOXES}`);
  // a change in the dashboard reaches the next answer: FIRST minimum, loyalty rule, fee ladder, a box price, a box taken off the site
  const changed = liveWorld({ first: { ...FIRST, min_total: "80" }, extraSettings: { cms: { loyalty: { enabled: true, every: 5, reward: "free_delivery", minTotal: 70 } } },
    policy: { ...POLICY, maxKm: 8, farZoneEnabled: false, feeByTotal: [{ fee: 25, over: 0 }, { fee: 0, over: 200 }] },
    bundles: LIVE.bundles.filter((b) => b.slug !== "box-solo-crepe").map((b) => (b.slug === "box-crepe-duo" ? { ...b, price: 67 } : b)) });
  const o = bodyOf((await changed.say("عندكم عروض؟")).sent[0]);
  assert.match(o, /للطلبات من 80 ر\.س وأكثر/); assert.match(o, /وكل 5 طلبات من الموقع لك توصيل مجاني على طلب من 70 ر\.س/); assert.match(o, /• بوكسات لشخصين من 65 ر\.س/);
  changed.clock.advance(3);
  assert.match(bodyOf((await changed.say("كم رسوم التوصيل")).sent[0]), /^🛵 نوصّل لمسافة 8 كم من فرعنا في حي السلامة بجدة\.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 200 ر\.س: 25 ر\.س\n• من 200 ر\.س: مجاني\n/);
  changed.clock.advance(3);
  assert.match(bodyOf((await changed.press("box:box-crepe-duo", "x")).sent[0]), /^\*بوكس الكريب لشخصين\* — 67 ر\.س\n/);
  changed.clock.advance(3);
  assert.equal((await changed.press("box:box-solo-crepe", "x")).log.reply_key, "data_missing", "a box that left the site is not sold from memory");
  // «what the bot knows right now» for the dashboard
  const f = (await liveWorld().call("GET", "/api/cms/wabot/facts")).body;
  assert.equal(f.hours.open, true); assert.equal(f.hours.closesAt, "2 فجراً"); assert.deepEqual(f.boxes.tiers.map((x) => x.from), [29, 65, 85]);
  assert.equal(f.menu.items, KNOW.menu.items.length); assert.equal(f.first, FIRST_LINE); assert.equal(f.delivery.km, 10); assert.equal(f.delivery.fees.length, 5);
  assert.deepEqual(f.offers.list.map((x) => x.ends), ["(لين 15/10)", "(لين 15/10)", "(لين 15/10)"]); assert.equal(f.faq.missing.length, R.FAQ_KEYS.length);
  const down = (await liveWorld({ pages: null, bundles: null, offers: null, policy: null, first: null, extraSettings: { hours: null } }).call("GET", "/api/cms/wabot/facts")).body;
  assert.deepEqual([down.hours.known, down.boxes.known, down.menu.known, down.offers.known, down.delivery.known, down.first], [false, false, false, false, false, null]);
}));
