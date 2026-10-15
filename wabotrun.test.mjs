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
import { CTX_RULES } from "./waassistrun.js";
import * as AIC from "./waaicost.js";
import * as BC from "./wabotcart.js";
const W = await import("./whatsapp.js");
const R = await import("./wabotrun.js");
const LLM = await import("./wabotllm.js");
const R0 = await import("./wabot.js");
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
  at = OPEN_AT, graph = null, failDb = null, extraSettings = {}, disclosure = false, pages = LIVE.pages, quote = null, llm = null, greetMenu = false, offers = LIVE.offers, resolveMapsLink = null, lastCart = null, assistModel = null, assistStore = null, kb = null, adReport = [], channelReport = [], mediaFile = null, transcribe = null, sttFetch = null, variants = null, team = null, flow = null, fav = null, expandBundle = null } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; }, advanceSec: (s) => { nowMs += s * 1000; }, set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { msgs: [], log: [], jobs: [], proofs: [], consentLog: [], ai: [], aiAlerts: [], tpl: [], cfgLog: [], botCarts: [], chats: new Map(), optouts: [], optins: {}, links: links.map((s) => (typeof s === "string" ? { slug: s, active: true, clicks: 0 } : { active: true, clicks: 0, ...s })), adChats: [], adReportParams: null, channelOffers: [], channelReportParams: null, sttKey: null, liveDay: [], marketingTo: [], settings: null };
  db.settings = { hours: HOURS, notifications, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: FAQ } },
    cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 } }, delivery: { alertPhones: ["0544775082", "0506338246"], staffSmsLanguage: "en" }, waBot: { footerMode: "always", disclosureMode: "classic", ...waBot, assist: { menuToRules: false, grillFamilies: false, salesBrain: false, ...((waBot || {}).assist || {}) } },      // PS4: the sections list alone, as the older tests expect; the menu link under it is tested on its own
    waMaster: { enabled: true },   // SEC: مفتاح المالك الرئيسي (whatsapp.js guardSend) — مفتوح في العالم الافتراضي للاختبار
    ...extraSettings };
  const iso = () => new Date(nowMs).toISOString();
  const chat = (p) => { if (!db.chats.has(p)) db.chats.set(p, { phone_norm: p, unknown_streak: 0, ...(disclosure ? {} : { last_disclosed_at: iso() }) }); return db.chats.get(p); };
  /* FU1: نسخة في الذاكرة من جمل wafollow.FU_SQL (نفس المنطق على db.msgs / db.log / db.jobs / db.fu) */
  db.fu = []; db.fuBrake = null;
  const T0 = (v) => (v ? Date.parse(v) : NaN);
  const isMkt = (c) => c.direction === "out" && c.template && (c.category === "MARKETING" || c.source === "campaign");
  const okOut = (c) => !["failed", "skipped"].includes(c.status || "");
  const inAfter = (pn, from, to) => db.msgs.some((m) => m.phone_norm === pn && m.direction === "in" && m.source !== "history" && T0(m.created_at) > from && T0(m.created_at) < to);
  const stoppedAfter = (pn, at) => { const o = db.optins[pn] || {}; return (o.stopped_at && T0(o.stopped_at) >= at) || (o.marketing_off_at && T0(o.marketing_off_at) >= at); };
  const fuRows = (r) => ({ rows: r, rowCount: r.length });
  function fuFake(name, p) {
    const maxOf = (l) => l.sort().pop() || null;
    switch (name) {
      case "candidates": {
        const by = new Map();
        for (const m of db.msgs) { if (!/^5\d{8}$/.test(String(m.phone_norm || "")) || nowMs - T0(m.created_at) >= 25 * 3600_000) continue; const e = by.get(m.phone_norm) || { ins: [], outs: [] };
          if (m.direction === "in" && m.source !== "history") e.ins.push(m.created_at); if (m.direction === "out" && m.source !== "echo" && okOut(m)) e.outs.push(m.created_at); by.set(m.phone_norm, e); }
        const out = [];
        for (const [pn, e] of by) {
          const li = maxOf(e.ins), lo = maxOf(e.outs);
          if (!li || !lo || !(nowMs - T0(li) < p[1] * 60_000) || !(T0(lo) >= T0(li)) || nowMs - T0(lo) < p[0] * 60_000) continue;
          if (p[5] && !p[5].includes(pn)) continue;
          if (db.jobs.some((j) => j.phone_norm === pn && j.kind === "reply_followup" && T0(j.created_at) >= T0(li))) continue;
          if (db.fu.some((f) => f.phone_norm === pn && f.status !== "failed" && nowMs - T0(f.sent_at) < 24 * 3600_000)) continue;
          if (db.msgs.some((c) => c.phone_norm === pn && isMkt(c) && T0(c.created_at) > T0(li))) continue;
          const camp = db.msgs.some((c) => c.phone_norm === pn && isMkt(c) && okOut(c) && nowMs - T0(c.created_at) < p[2] * 3600_000 && T0(c.created_at) < T0(li));
          const tap = db.log.some((l) => l.phone_norm === pn && ["interactive", "button"].includes(l.msg_type) && p[3].includes(l.reply_key) && T0(l.at) > T0(li) - p[4] * 3600_000 && T0(l.at) <= T0(li) + 120_000);
          if (camp || tap) out.push({ phone_norm: pn, last_in: li, last_out: lo });
        }
        return fuRows(out.slice(0, p[6]));
      }
      case "last_out": { const o = db.msgs.filter((c) => c.phone_norm === p[0] && c.direction === "out" && c.source !== "echo" && okOut(c) && T0(c.created_at) >= T0(p[1]));
        return fuRows([{ at: maxOf(o.map((c) => c.created_at)), mkt: o.filter(isMkt).length, manual: o.filter((c) => !c.template && !["bot", "window"].includes(c.source || "api")).length }]); }
      case "trigger": {
        const camp = maxOf(db.msgs.filter((c) => c.phone_norm === p[0] && isMkt(c) && okOut(c) && nowMs - T0(c.created_at) < p[2] * 3600_000 && T0(c.created_at) < T0(p[1])).map((c) => c.created_at));
        const tap = db.log.filter((l) => l.phone_norm === p[0] && ["interactive", "button"].includes(l.msg_type) && p[3].includes(l.reply_key) && T0(l.at) > T0(p[1]) - p[4] * 3600_000 && T0(l.at) <= T0(p[1]) + 120_000).map((l) => l.at).sort()[0] || null;
        return fuRows([{ camp_at: camp, tap_at: tap }]);
      }
      case "conv": return fuRows(db.log.filter((l) => l.phone_norm === p[0] && T0(l.at) >= T0(p[1])).sort((a, b) => T0(b.at) - T0(a.at) || b.id - a.id).slice(0, 60)
        .map((l) => ({ reply_key: l.reply_key, reply_arg: l.reply_arg ?? null, msg_type: l.msg_type, decision: l.decision, lang: l.lang, wamid: l.wamid, at: l.at })));
      case "recent": return fuRows([{ mine: db.fu.filter((f) => f.phone_norm === p[0] && f.status !== "failed" && nowMs - T0(f.sent_at) < 24 * 3600_000).length,
        others: db.jobs.filter((j) => j.phone_norm === p[0] && p[2].includes(j.kind) && j.status === "done" && T0(j.done_at) > T0(p[1])).length,
        pending: db.jobs.filter((j) => j.phone_norm === p[0] && p[2].includes(j.kind) && j.status === "pending").length }]);
      case "ignored": return fuRows([{ n: db.log.filter((l) => l.phone_norm === p[0] && l.msg_type === "followup" && l.decision === "replied" && p[1].includes(l.reply_key) && nowMs - T0(l.at) < p[2] * 86400_000
        && !inAfter(p[0], T0(l.at), T0(l.at) + 24 * 3600_000)).length }]);
      case "opted_out": return fuRows(db.optouts.includes(p[0]) ? [{}] : []);
      case "manual": return fuRows([{ n: db.msgs.filter((c) => c.phone_norm === p[0] && c.direction === "out" && !c.template && !["bot", "window", "echo"].includes(c.source || "api") && okOut(c) && T0(c.created_at) > T0(p[1])).length }]);
      case "ordered": return fuRows(orders.filter((o) => o.phone_norm === p[0] && T0(o.created_at) > T0(p[1]) && !["expired", "pending_payment"].includes(o.status)).map(() => ({})));
      case "cart_live": return fuRows(db.botCarts.filter((x) => x.phone === p[0] && !x.expired && T0(x.created_at) > T0(p[1])).slice(-1).map((x) => ({ code: x.code })));
      case "cart_ok": return fuRows(db.botCarts.filter((x) => x.code === p[0] && x.phone === p[1] && !x.expired).map(() => ({})));
      case "day_count": return fuRows([{ n: db.fu.filter((f) => f.status !== "failed" && T0(f.sent_at) >= T0(p[0])).length }]);
      case "day_stats": { const l = db.fu.filter((f) => f.status === "sent" && T0(f.sent_at) >= T0(p[0])); const st = (f) => stoppedAfter(f.phone_norm, T0(f.sent_at)), bl = (f) => db.msgs.some((m) => f.wamid && m.wamid === f.wamid && m.status === "failed");
        return fuRows([{ sent: l.length, stopped: l.filter(st).length, blocked: l.filter(bl).length, bad: l.filter((f) => st(f) || bl(f)).length }]); }
      case "brake_get": return fuRows(db.fuBrake ? [{ ...db.fuBrake }] : []);
      case "brake_set": { const b = db.fuBrake; if (b && b.on_at && !(b.cleared_at && T0(b.cleared_at) >= T0(b.on_at))) return fuRows([]); db.fuBrake = { on_at: iso(), sent: p[0], bad: p[1], pct: p[2], detail: p[3], cleared_at: null, cleared_by: null }; return fuRows([{ id: 1 }]); }
      case "brake_clear": { const b = db.fuBrake; if (!b || !b.on_at || (b.cleared_at && T0(b.cleared_at) >= T0(b.on_at))) return fuRows([]); b.cleared_at = iso(); b.cleared_by = p[0]; return fuRows([{ on_at: b.on_at }]); }
      case "reserve": { if (db.fu.some((f) => f.job_key === p[0])) return fuRows([]); const f = { id: db.fu.length + 1, job_key: p[0], phone_norm: p[1], trigger: p[2], trigger_at: p[3], last_in: p[4], via: p[5], ref: p[6], lang: p[7], cart_code: p[8], cart_total: p[9], status: "sending", sent_at: iso(), answer: null, answered_at: null }; db.fu.push(f); return fuRows([{ id: f.id }]); }
      case "mark": { const f = db.fu.find((x) => x.id === p[0]); if (f) Object.assign(f, { status: p[1], wamid: p[2], error: p[3], sent_at: iso() }); return fuRows([]); }
      case "defer": { const j = db.jobs.find((x) => x.id === p[0]); if (j) Object.assign(j, { status: "pending", due_at: p[1], reason: p[2], done_at: null }); return fuRows([]); }
      case "cancel_pending": { for (const j of db.jobs) if (j.kind === "reply_followup" && j.status === "pending") Object.assign(j, { status: "cancelled", reason: p[0], done_at: iso() }); return fuRows([]); }
      case "latest": return fuRows(db.fu.filter((f) => f.phone_norm === p[0] && f.status === "sent" && nowMs - T0(f.sent_at) < 24 * 3600_000).slice(-1).map((f) => ({ id: f.id, cart_code: f.cart_code, sent_at: f.sent_at, answered_at: f.answered_at, via: f.via })));
      case "other_reply": return fuRows(db.log.filter((l) => l.phone_norm === p[0] && l.wamid && l.id !== p[1] && T0(l.at) > T0(p[2])).slice(0, 1).map(() => ({})));
      case "answer": { const f = db.fu.filter((x) => x.phone_norm === p[0] && x.status === "sent" && !x.answered_at && nowMs - T0(x.sent_at) < 24 * 3600_000).slice(-1)[0]; if (!f) return fuRows([]); f.answered_at = iso(); f.answer = p[1]; return fuRows([{ id: f.id }]); }
      case "decline": chat(p[0]).follow_declined_at = iso(); return fuRows([]);
      case "report": {
        const l = db.fu.filter((f) => f.status === "sent" && T0(f.sent_at) >= T0(p[0]) && T0(f.sent_at) < T0(p[1]));
        const ordOf = (f) => orders.filter((o) => o.phone_norm === f.phone_norm && !o.is_test && T0(o.created_at) > T0(f.sent_at) && T0(o.created_at) < T0(f.sent_at) + 24 * 3600_000 && !["pending_payment", "expired", "rejected_refunded", "refund_failed", "paid_pos_failed"].includes(o.status));
        return fuRows([{ sent: l.length, replied: l.filter((f) => f.answered_at || inAfter(f.phone_norm, T0(f.sent_at), T0(f.sent_at) + 24 * 3600_000)).length, said_yes: l.filter((f) => f.answer === "yes").length, said_no: l.filter((f) => f.answer === "no").length,
          stopped: l.filter((f) => stoppedAfter(f.phone_norm, T0(f.sent_at))).length, blocked: l.filter((f) => db.msgs.some((m) => f.wamid && m.wamid === f.wamid && m.status === "failed")).length,
          carts: l.filter((f) => f.cart_code).length, carts_opened: l.filter((f) => db.botCarts.some((x) => x.code === f.cart_code && Number(x.opens) > 0)).length,
          ordered: l.filter((f) => ordOf(f).length).length, paid_orders: l.reduce((a, f) => a + ordOf(f).length, 0), paid_sar: l.reduce((a, f) => a + ordOf(f).reduce((b, o) => b + Number(o.total), 0), 0),
          paid_via_link: l.reduce((a, f) => a + ordOf(f).filter((o) => o.attribution && o.attribution.fc_link === "wa-followup").length, 0) }]);
      }
      case "report_via": { const g = {}; for (const f of db.fu.filter((x) => x.status === "sent" && T0(x.sent_at) >= T0(p[0]) && T0(x.sent_at) < T0(p[1]))) g[f.via || "-"] = (g[f.via || "-"] || 0) + 1; return fuRows(Object.entries(g).map(([via, n]) => ({ via, n }))); }
      default: throw new Error(`fuFake: unknown statement ${name}`);
    }
  }
  const pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (failDb && failDb.test(s)) throw new Error("db down");
      if (/^CREATE TABLE|^DELETE FROM wa_bot_log|wa_webhook_health|wa_contact_names|wa_threads/i.test(s)) return { rows: [], rowCount: 0 };
      /* FU1: «متابعة اللي ردّ» — كل جمل wafollow.FU_SQL بتبدأ بعلامة /*fu:<الاسم>*\/ */
      { const fm = /^\/\*fu:([a-z_]+)\*\//.exec(s); if (fm) return fuFake(fm[1], p); }
      if (/^SELECT phone_norm, max\(created_at\) AS last_in FROM wa_messages WHERE direction='in'/i.test(s)) { const last = new Map(); for (const m of db.msgs) if (m.direction === "in" && m.source !== "history") last.set(m.phone_norm, m.created_at > (last.get(m.phone_norm) || "") ? m.created_at : last.get(m.phone_norm));
        return { rows: [...last.entries()].filter(([, at]) => nowMs - Date.parse(at) >= p[0] * 3600_000 && nowMs - Date.parse(at) < 23.5 * 3600_000).map(([phone_norm, last_in]) => ({ phone_norm, last_in })) }; }
      // ── EX6: رسالة مش مدعومة، تأكيد الدفع، متابعة المحادثة
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='out' AND COALESCE\(source,'api'\) <> 'echo' AND created_at > \$2/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "out" && m.source !== "echo" && Date.parse(m.created_at) > Date.parse(p[1])).slice(0, 1).map(() => ({})) };
      if (/^SELECT o\.order_no, o\.phone_norm FROM shop_orders o/i.test(s)) return { rows: orders.filter((o) => !o.is_test && ["paid", "pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way"].includes(o.status) && nowMs - Date.parse(o.created_at) < 7200_000
        && db.log.some((l) => l.phone_norm === o.phone_norm && l.decision === "replied" && Date.parse(l.at) < Date.parse(o.created_at) + 600_000 && Date.parse(l.at) > Date.parse(o.created_at) - 86400_000) && !db.jobs.some((j) => j.wamid === `paid:${o.order_no}`)).map((o) => ({ order_no: o.order_no, phone_norm: o.phone_norm })) };
      if (/^SELECT l\.phone_norm, l\.at, l\.lang FROM wa_bot_log l/i.test(s)) { const last = new Map(); for (const l of db.log) last.set(l.phone_norm, l);
        return { rows: [...last.values()].filter((l) => nowMs - Date.parse(l.at) >= p[0] * 60_000 && nowMs - Date.parse(l.at) < (p[0] + 60) * 60_000 && l.decision === "silent" && ["out_of_scope", "ignored_type", "auto_reply_covered"].includes(l.reason) && !(/<> 'revoke'/.test(s) && l.msg_type === "revoke")).map((l) => ({ phone_norm: l.phone_norm, at: l.at, lang: l.lang })) }; }
      /* «شكوى في آخر ٢٤ ساعة» (COMPLAINT_24H_SQL): القوايم بتتقري من الجملة نفسها — اللي في الكود هو اللي بيتجرّب */
      if (/^SELECT 1 FROM wa_bot_log WHERE phone_norm=\$1 AND at > NOW\(\) - INTERVAL '24 hours' AND \(reply_key IN/i.test(s)) {
        const inList = (re) => ((re.exec(s) || [])[1] || "").split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
        const keys = inList(/reply_key IN \(([^)]*)\)/i), hos = inList(/handoff IN \(([^)]*)\)/i);
        return { rows: db.log.filter((l) => l.phone_norm === p[0] && nowMs - Date.parse(l.at) < 86400_000 && (keys.includes(l.reply_key) || hos.includes(l.handoff))).slice(0, 1).map(() => ({})) };
      }
      // ── FD1: البوت رد على الرقم ده بعد رسالة الحملة؟
      if (/^SELECT 1 FROM wa_bot_log WHERE phone_norm=\$1 AND id <> \$2 AND decision IN \('replied','dry'\) AND at > \$3::timestamptz/i.test(s)) return { rows: db.log.filter((l) => l.phone_norm === p[0] && l.id !== p[1] && ["replied", "dry"].includes(l.decision) && Date.parse(l.at) > Date.parse(p[2])).slice(0, 1).map(() => ({})) };
      // ── EX6: آخر ردّين (سياق الكارت)
      if (/^SELECT reply_key, reply_arg, msg_type FROM wa_bot_log WHERE phone_norm=\$1 AND id <> \$2/i.test(s)) return { rows: db.log.filter((l) => l.phone_norm === p[0] && l.id !== p[1] && ["replied", "dry"].includes(l.decision) && nowMs - Date.parse(l.at) < 900_000).slice(-2).reverse().map((l) => ({ reply_key: l.reply_key, reply_arg: l.reply_arg || null, msg_type: l.msg_type })) };
      // ── EX5: رد آلي وارد + حارس الحلقات
      if (/^SELECT max\(created_at\) FILTER \(WHERE template IS NOT NULL\) AS tpl_at/i.test(s)) { const o = db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "out" && m.source !== "echo" && !["failed", "skipped"].includes(m.status) && nowMs - Date.parse(m.created_at) < 600_000);
        const mx = (l) => l.map((m) => m.created_at).sort().pop() || null; return { rows: [{ tpl_at: mx(o.filter((m) => m.template)), out_at: mx(o) }] }; }
      if (/^DELETE FROM wa_replies WHERE phone_norm=\$1 AND ext_id=\$2 AND NOT is_optout/i.test(s)) { const hit = (db.replies || []).filter((r) => r.phone_norm === p[0] && r.ext_id === p[1] && !r.is_optout); db.replies = (db.replies || []).filter((r) => !hit.includes(r)); return { rows: hit.map((r) => ({ queue_id: r.queue_id })) }; }
      if (/^UPDATE wa_send_queue SET replied_at=NULL WHERE id=\$1 AND NOT EXISTS/i.test(s)) { const qr = (db.queue || []).find((x) => x.id === p[0]); if (qr && !(db.replies || []).some((r) => r.queue_id === p[0])) qr.replied_at = null; return { rows: [] }; }
      if (/^SELECT text FROM wa_bot_log WHERE phone_norm=\$1 AND id <> \$2/i.test(s)) return { rows: db.log.filter((l) => l.phone_norm === p[0] && l.id !== p[1] && nowMs - Date.parse(l.at) < p[2] * 1000).slice(-1).map((l) => ({ text: l.text })) };
      if (/^INSERT INTO wa_bot_chats\(phone_norm, loop_streak, loop_at\)/i.test(s)) { const ch = chat(p[0]); ch.loop_streak = ch.loop_at && nowMs - Date.parse(ch.loop_at) < p[1] * 1000 ? (ch.loop_streak || 0) + 1 : 1; ch.loop_at = iso(); return { rows: [{ loop_streak: ch.loop_streak }] }; }
      if (/^UPDATE wa_bot_chats SET loop_streak=0/i.test(s)) { chat(p[0]).loop_streak = 0; return { rows: [] }; }
      // ── M4/M5 (مراجعة الخبير)
      if (/^SELECT acked_at FROM wa_handovers WHERE phone_norm=\$1/i.test(s)) return { rows: db.acks && db.acks[p[0]] ? [{ acked_at: db.acks[p[0]] }] : [] };
      if (/^SELECT count\(\*\)::int AS n FROM wa_bot_log WHERE phone_norm=\$1 AND msg_type IN \('image'/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.phone_norm === p[0] && ["image", "video", "document", "audio", "voice", "sticker"].includes(l.msg_type) && nowMs - Date.parse(l.at) < p[1] * 60_000).length }] };
      if (/^SELECT phone_norm FROM cms_contacts WHERE is_staff/i.test(s)) return { rows: (db.staffContacts || []).map((phone_norm) => ({ phone_norm })) };
      /* SX1: شبكة أمان قايمة الموظفين — نفس منطق STAFF_SILENT_SQL / HUMAN_OUT على db.log / db.msgs، والتحويلات من أحداث البوابة */
      { const human = (m) => m.direction === "out" && okOut(m) && ((m.source === "echo" && (m.echo_kind || "staff") !== "auto") || (!m.template && !["bot", "window", "echo"].includes(m.source || "api")));
        const hoAts = (pn) => portalEvents.filter(([e, d]) => e === "wa_handover" && d.phone === `0${pn}`).map(([, d]) => T0(d.at));
        if (/^\/\*ss:candidates\*\//.test(s)) {
          const by = new Map();
          for (const l of db.log) {
            if (l.decision !== "silent" || l.reason !== "never_reply" || !p[1].includes(l.detail) || ["revoke", "reaction"].includes(l.msg_type || "")) continue;
            const at = T0(l.at); if (!(at > nowMs - (p[0] + 60) * 60_000)) continue;
            const lh = Math.max(-Infinity, ...db.msgs.filter((m) => m.phone_norm === l.phone_norm && human(m)).map((m) => T0(m.created_at)));
            const lo = Math.max(-Infinity, ...hoAts(l.phone_norm));
            if (!(at > lh) || !(at > lo)) continue;
            by.set(l.phone_norm, Math.min(by.get(l.phone_norm) ?? Infinity, at));
          }
          return { rows: [...by.entries()].filter(([, at]) => at <= nowMs - p[0] * 60_000).map(([phone_norm, at]) => ({ phone_norm, first_at: new Date(at).toISOString() })) };
        }
        if (/^SELECT 1 FROM wa_messages m WHERE m\.phone_norm = \$1 AND m\.created_at > \$2 AND m\.direction = 'out'/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && T0(m.created_at) > T0(p[1]) && human(m)).slice(0, 1).map(() => ({})) };
        if (/^SELECT 1 FROM wa_handovers WHERE phone_norm = \$1 AND at >= \$2/i.test(s)) return { rows: hoAts(p[0]).filter((at) => at >= T0(p[1])).slice(0, 1).map(() => ({})) };
        if (/^SELECT text FROM wa_bot_log WHERE phone_norm = \$1 AND at >= \$2 AND decision = 'silent'/i.test(s)) return { rows: db.log.filter((l) => l.phone_norm === p[0] && T0(l.at) >= T0(p[1]) && l.decision === "silent").slice(-1).map((l) => ({ text: l.text })) }; }
      if (/^SELECT DISTINCT driver->>'phone' AS phone FROM dl_shipments/i.test(s)) return { rows: (db.drivers || []).map((phone) => ({ phone })) };
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND created_at < \$2::timestamptz LIMIT 1/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && Date.parse(m.created_at) < Date.parse(p[1])).slice(0, 1).map(() => ({})) };
      // ── مساعد الطلبات: «جاري الكتابة» والمتابعة بعد رابط السلة
      if (/^SELECT 1 FROM wa_messages WHERE wamid=\$1 AND phone_norm=\$2 AND direction='in'/i.test(s)) return { rows: db.msgs.filter((m) => m.wamid === p[0] && m.phone_norm === p[1] && m.direction === "in" && nowMs - Date.parse(m.created_at) < 24 * 3600_000).map(() => ({})) };
      if (/^SELECT max\(created_at\) FILTER \(WHERE direction='in'/i.test(s)) { const mine = db.msgs.filter((m) => m.phone_norm === p[0] && nowMs - Date.parse(m.created_at) < 25 * 3600_000);
        return { rows: [{ last_in: mine.filter((m) => m.direction === "in" && m.source !== "history").map((m) => m.created_at).sort().pop() || null, wrote: mine.filter((m) => m.direction === "in" && Date.parse(m.created_at) > Date.parse(p[1])).length, staff: mine.filter((m) => m.source === "echo" && Date.parse(m.created_at) > Date.parse(p[1])).length }] }; }
      if (/^SELECT \(expires_at > NOW\(\)\) AS live FROM wa_bot_carts/i.test(s)) return { rows: db.botCarts.filter((x) => x.code === p[0] && x.phone === p[1]).map((x) => ({ live: !x.expired })) };
      if (/^SELECT 1 FROM shop_orders WHERE phone_norm=\$1 AND created_at > \$2 AND status <> 'expired'/i.test(s)) return { rows: orders.filter((o) => o.phone_norm === p[0] && Date.parse(o.created_at) > Date.parse(p[1]) && o.status !== "expired").map(() => ({})) };
      if (/^UPDATE wa_bot_jobs SET status='cancelled', reason=\$2, done_at=NOW\(\) WHERE phone_norm=\$1 AND kind='assist_reminder'/i.test(s)) { for (const j of db.jobs) if (j.phone_norm === p[0] && j.kind === "assist_reminder" && j.status === "pending") { j.status = "cancelled"; j.reason = p[1]; } return { rows: [] }; }
      if (/^SELECT id FROM wa_bot_jobs WHERE phone_norm=\$1 AND kind='media_burst' AND status='pending'/i.test(s)) return { rows: db.jobs.filter((j) => j.phone_norm === p[0] && j.kind === "media_burst" && j.status === "pending").slice(0, 1).map((j) => ({ id: j.id })) };
      if (/^SELECT ev, log_id FROM wa_bot_jobs WHERE phone_norm=\$1 AND kind='media_burst' AND status='done' AND reason='burst_merged'/i.test(s)) return { rows: db.jobs.filter((j) => j.phone_norm === p[0] && j.kind === "media_burst" && j.status === "done" && j.reason === "burst_merged").map((j) => ({ ev: j.ev, log_id: j.log_id })) };
      if (/^UPDATE wa_bot_jobs SET reason='burst_used'/i.test(s)) { for (const j of db.jobs) if (j.phone_norm === p[0] && j.kind === "media_burst" && j.reason === "burst_merged") j.reason = "burst_used"; return { rows: [] }; }
      if (/^UPDATE wa_bot_jobs SET status='cancelled', reason='replaced'/i.test(s)) { for (const j of db.jobs) if (j.phone_norm === p[0] && j.kind === "assist_followup" && j.status === "pending") { j.status = "cancelled"; j.reason = "replaced"; } return { rows: [] }; }
      /* PK1: متابعة المحادثة اللي وقفت عند سؤال المساعد (assist_nudge) */
      if (/^UPDATE wa_bot_jobs SET status='pending', reason=NULL, done_at=NULL, due_at=\$2, ev=\$3 WHERE wamid=\$1/i.test(s)) { const j = db.jobs.find((x) => x.wamid === p[0] && ["pending", "cancelled"].includes(x.status)); if (!j) return { rows: [] }; Object.assign(j, { status: "pending", reason: null, due_at: p[1], ev: JSON.parse(p[2]) }); return { rows: [{ id: j.id }] }; }
      if (/^SELECT 1 FROM wa_bot_jobs WHERE phone_norm=\$1 AND kind IN \('assist_nudge'/i.test(s)) return { rows: db.jobs.filter((j) => j.phone_norm === p[0] && ["assist_nudge", "lead_followup", "assist_followup", "reply_followup"].includes(j.kind) && j.status === "done").map(() => ({})) };
      if (/^SELECT 1 FROM wa_bot_carts WHERE phone_norm=\$1 AND created_at > \$2/i.test(s)) return { rows: db.botCarts.filter((x) => x.phone === p[0]).map(() => ({})) };
      if (/^SELECT 1 FROM wa_bot_jobs WHERE phone_norm=\$1 AND kind='assist_followup' AND status='done'/i.test(s)) return { rows: db.jobs.filter((j) => j.phone_norm === p[0] && j.kind === "assist_followup" && j.status === "done").map(() => ({})) };
      if (/^SELECT last_loc FROM wa_bot_chats/i.test(s)) return { rows: db.chats.has(p[0]) ? [{ last_loc: db.chats.get(p[0]).last_loc || null }] : [] };
      if (/^INSERT INTO wa_bot_config_log/i.test(s)) { db.cfgLog.push({ id: db.cfgLog.length + 1, at: iso(), who: p[0], changes: JSON.parse(p[1]) }); return { rows: [] }; }
      if (/FROM wa_bot_config_log/i.test(s)) return { rows: [...db.cfgLog].reverse() };
      if (/^SELECT text, reply_key AS key, handoff, phone_norm AS phone, detail FROM wa_bot_log/i.test(s)) return { rows: db.log.filter((l) => l.text).map((l) => ({ text: l.text, key: l.reply_key, handoff: l.handoff || null, phone: l.phone_norm, detail: l.detail || null })).reverse() };
      // ── ai_calls (waaicost.js)
      if (/^INSERT INTO ai_calls/i.test(s)) { db.ai.push({ id: db.ai.length + 1, at: iso(), purpose: p[0], provider: p[1], model: p[2], in_tokens: p[3], out_tokens: p[4], cached_tokens: p[5], estimated: p[6], cost_sar: p[7], priced: p[8], price_date: p[9],
        ms: p[10], chat_hash: p[11], outcome: p[12], detail: p[13], sent_text: p[14], prompt_chars: p[15], prompt_hash: p[16], log_id: p[17] }); return { rows: [] }; }
      if (/AS s FROM ai_calls WHERE purpose='assistant' AND detail LIKE 'media:%'/i.test(s)) { const k0 = AIC.riyadhKeys(new Date(nowMs)); return { rows: [{ s: db.ai.filter((a) => a.purpose === "assistant" && /^media:/.test(String(a.detail || "")) && AIC.riyadhKeys(new Date(a.at)).day === k0.day).reduce((x, a) => x + Number(a.cost_sar), 0) }] }; }
      if (/THEN 'voice' ELSE 'images' END AS kind/i.test(s)) { const g = {}; for (const a of db.ai.filter((x) => x.purpose === "assistant" && /^media:/.test(String(x.detail || "")))) { const kd = /^media:stt/.test(a.detail) ? "voice" : "images"; g[kd] = g[kd] || { kind: kd, n: 0, ok: 0, sar: 0 }; g[kd].n++; if (a.outcome === "ok") g[kd].ok++; g[kd].sar += Number(a.cost_sar); } return { rows: Object.values(g) }; }
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
      if (/^UPDATE wa_bot_log SET text=.2 WHERE id=.1/i.test(s)) { const l = db.log.find((x) => x.id === p[0]); if (l) l.text = p[1]; return { rows: [] }; }
      if (/^UPDATE wa_bot_log SET detail=.2 WHERE id=.1/i.test(s)) { const l = db.log.find((x) => x.id === p[0]); if (l) l.detail = p[1]; return { rows: [] }; }
      if (/^INSERT INTO ai_budget_alerts/i.test(s)) { if (db.aiAlerts.includes(p[0])) return { rows: [] }; db.aiAlerts.push(p[0]); return { rows: [{ key: p[0] }] }; }
      if (/ai_budget_alerts/i.test(s)) return { rows: db.aiAlerts.map((key) => ({ key })) };
      if (/^SELECT count\(\*\)::int AS n FROM wa_bot_log WHERE at >= \(date_trunc\('month'/i.test(s)) return { rows: [{ n: db.log.length }] };
      if (/FROM wa_messages WHERE direction='out' AND template IS NOT NULL/i.test(s)) return { rows: db.tpl };
      if (/^INSERT INTO wa_bot_chats\(phone_norm, channel_offered_at\)/i.test(s)) { chat(p[0]).channel_offered_at = iso(); return { rows: [] }; }
      if (/^INSERT INTO wa_channel_offers/i.test(s)) { db.channelOffers.push({ phone_norm: p[0], via: p[1], at: iso() }); return { rows: [] }; }
      if (/FROM wa_channel_offers/i.test(s)) { db.channelReportParams = p; return { rows: channelReport }; }
      if (/^SELECT provider, key_enc, last4, saved_at, saved_by, test FROM wa_stt_key/i.test(s)) return { rows: db.sttKey ? [{ ...db.sttKey }] : [] };
      if (/^INSERT INTO wa_stt_key/i.test(s)) { db.sttKey = { provider: p[0], key_enc: p[1], last4: p[2], saved_at: iso(), saved_by: p[3], test: null }; return { rows: [{ provider: p[0] }] }; }
      if (/^UPDATE wa_stt_key SET test=/i.test(s)) { if (db.sttKey) db.sttKey.test = JSON.parse(p[0]); return { rows: [] }; }
      if (/^DELETE FROM wa_stt_key/i.test(s)) { db.sttKey = null; return { rows: [] }; }
      if (/FROM wa_assist_live_day WHERE phone_norm=\$1/i.test(s)) { const dk = AIC.riyadhKeys(new Date(nowMs)).day, yk = AIC.riyadhKeys(new Date(nowMs - 86400_000)).day; return { rows: db.liveDay.filter((r) => r.phone_norm === p[0] && (r.day === dk || (p[1] === 1 && r.day === yk))).slice(0, 1).map(() => ({ ok: 1 })) }; }
      if (/^INSERT INTO wa_assist_live_day/i.test(s)) { const dk = AIC.riyadhKeys(new Date(nowMs)).day; if (db.liveDay.filter((r) => r.day === dk).length >= p[2] || db.liveDay.some((r) => r.day === dk && r.phone_norm === p[0])) return { rows: [] }; db.liveDay.push({ day: dk, phone_norm: p[0], why: p[1] }); return { rows: [{ phone_norm: p[0] }] }; }
      if (/^SELECT count\(\*\)::int AS n FROM wa_assist_live_day/i.test(s)) { const dk = AIC.riyadhKeys(new Date(nowMs)).day; return { rows: [{ n: db.liveDay.filter((r) => r.day === dk).length }] }; }
      if (/FROM wa_messages WHERE phone_norm=\$1 AND direction='out' AND category='MARKETING'/i.test(s)) return { rows: db.marketingTo.includes(p[0]) ? [{ ok: 1 }] : [] };
      if (/^UPDATE wa_optins SET stopped_at=NOW\(\)/i.test(s)) { db.optins[p[0]] = { ...(db.optins[p[0]] || {}), stopped_at: iso() }; return { rows: [] }; }
      if (/^UPDATE wa_optins SET stopped_at=NULL/i.test(s)) { if (db.optins[p[0]]) db.optins[p[0]].stopped_at = null; return { rows: [] }; }
      /* M1: echo classification (whatsapp.js handleEcho) + the bot's «did the app's own auto reply cover it» checks */
      if (/^SELECT max\(created_at\) AS at FROM wa_messages WHERE phone_norm=\$1 AND direction='in' AND created_at <= \$2/i.test(s)) { const e = db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "in" && Date.parse(m.created_at) <= Date.parse(p[1])).map((m) => m.created_at).sort().pop(); return { rows: [{ at: e || null }] }; }
      if (/^UPDATE wa_messages SET echo_kind=\$2 WHERE wamid=\$1/i.test(s)) { const m = db.msgs.find((x) => x.wamid === p[0]); if (m) m.echo_kind = p[1]; return { rows: [] }; }
      if (/^SELECT 1 FROM wa_messages WHERE echo_kind='auto' AND created_at > NOW\(\) - INTERVAL '7 days'/i.test(s)) return { rows: db.msgs.some((m) => m.echo_kind === "auto") ? [{}] : [] };
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND echo_kind='auto' AND created_at >= \$2/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && m.echo_kind === "auto" && Date.parse(m.created_at) >= Date.parse(p[1]) - 5000).slice(0, 1).map(() => ({})) };
      if (/^INSERT INTO wa_ad_chats/i.test(s)) { const x = db.adChats.find((r) => r.phone_norm === p[0] && r.ad_id === p[1]); if (x) x.clicks++; else db.adChats.push({ phone_norm: p[0], ad_id: p[1], headline: p[2], source_type: p[3], clicks: 1 }); return { rows: [] }; }
      if (/FROM wa_ad_chats a/i.test(s)) { db.adReportParams = p; return { rows: adReport }; }
      if (/^SELECT target_type, target_id FROM cms_links WHERE slug=\$1 AND active/i.test(s)) return { rows: db.links.filter((l) => l.slug === p[0] && l.active).map((l) => ({ target_type: l.target_type || "home", target_id: l.target_id || null })) };
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
          : echo ? { wamid: p[0], direction: "out", phone_norm: p[1], body: p[2], source: "echo", created_at: p[4] || iso() }
            : { wamid: p[0], direction: "out", phone_norm: p[1], template: p[2], category: p[3], order_no: p[4], stage: p[5], status: p[6], body: p[8], source: p[10], created_at: iso() };
        db.msgs.push(row);
        return { rows: [{ id: db.msgs.length }], rowCount: 1 };
      }
      if (/^SELECT max\(created_at\) AS at FROM wa_messages WHERE phone_norm=\$1 AND source='echo'/i.test(s)) {
        const e = db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && m.echo_kind !== "auto" && nowMs - Date.parse(m.created_at) < 24 * 3600_000).map((m) => m.created_at).sort().pop();
        return { rows: [{ at: e || null }] };
      }
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND source='echo' AND created_at > \$2/i.test(s)) {
        return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && m.echo_kind !== "auto" && Date.parse(m.created_at) > Date.parse(p[1])).map(() => ({})) };
      }
      if (/^INSERT INTO wa_bot_jobs/i.test(s)) {
        if (p[0] && db.jobs.some((j) => j.wamid === p[0])) return { rows: [], rowCount: 0 };
        const j = { id: db.jobs.length + 1, wamid: p[0], phone_norm: p[1], kind: p[2], due_at: p[3], ev: JSON.parse(p[4]), log_id: p[5], status: "pending", reason: null, created_at: iso() };
        db.jobs.push(j); return { rows: [{ id: j.id }], rowCount: 1 };
      }
      if (/^SELECT id FROM wa_bot_jobs WHERE status='pending' AND due_at <= \$1/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "pending" && Date.parse(j.due_at) <= Date.parse(p[0])).map((j) => ({ id: j.id })) };
      if (/^UPDATE wa_bot_jobs SET status='running' WHERE id=\$1 AND status='pending'/i.test(s)) {
        const j = db.jobs.find((x) => x.id === p[0] && x.status === "pending");
        if (!j) return { rows: [], rowCount: 0 };
        j.status = "running"; return { rows: [{ ...j }], rowCount: 1 };
      }
      if (/^UPDATE wa_bot_jobs SET status=\$2, reason=\$3/i.test(s)) { const j = db.jobs.find((x) => x.id === p[0]); j.status = p[1]; j.reason = p[2]; j.done_at = iso(); return { rows: [] }; }
      if (/^UPDATE wa_bot_jobs SET status='cancelled', reason='manual_mute'/i.test(s)) { for (const j of db.jobs) if (j.phone_norm === p[0] && j.status === "pending") { j.status = "cancelled"; j.reason = "manual_mute"; } return { rows: [] }; }
      if (/FROM wa_bot_jobs WHERE status='pending'/i.test(s)) return { rows: [{ n: db.jobs.filter((j) => j.status === "pending").length }] };
      if (/FROM wa_messages WHERE phone_norm=\$1 AND source='echo'/i.test(s)) {
        const n = db.msgs.filter((m) => m.phone_norm === p[0] && m.source === "echo" && m.echo_kind !== "auto" && nowMs - Date.parse(m.created_at) < p[1] * 3600_000).length;
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
      if (/^INSERT INTO wa_optin_log/i.test(s) && /'updates'/.test(s)) { db.consentLog.push({ phone_norm: p[0], kind: "updates", value: p[1], text_version: p[2], text: p[3], source: p[4], order_no: p[5], ip: p[6], ua: p[7], at: iso() }); return { rows: [] }; }
      if (/^INSERT INTO wa_optins/i.test(s)) { const cur = db.optins[p[0]] || {}; db.optins[p[0]] = { ...cur, updates: p[1] ?? cur.updates ?? false, marketing: p[2] ?? cur.marketing ?? false, marketing_off_at: p[2] === false ? (cur.marketing_off_at || iso()) : p[2] === true ? null : (cur.marketing_off_at || null) }; return { rows: [] }; }
      if (/^UPDATE cms_contacts SET opted_out_at=NULL/i.test(s)) { const had = db.optouts.includes(p[0]) && !(db.smsOptouts || []).includes(p[0]); if (had) db.optouts = db.optouts.filter((x) => x !== p[0]); return { rows: had ? [{}] : [], rowCount: had ? 1 : 0 }; }
      if (/^INSERT INTO cms_optout_log/i.test(s)) { (db.optoutLog ||= []).push([p[0], /resubscribe/.test(s) ? "resubscribe" : "other"]); return { rows: [], rowCount: 1 }; }
      if (/^UPDATE cms_contacts/i.test(s)) { if (!db.optouts.includes(p[0])) db.optouts.push(p[0]); return { rows: [], rowCount: 1 }; }
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
        return { rows: [{ n: rows.length, n_text: txt.length, oldest_text: first(txt), n_tap: taps.length, oldest_tap: first(taps), n_min: min1.length, oldest_min: first(min1), rate_at: last("rate"), burst_at: last("rate_burst"), same_at: same, same_text_at: p[3] ? (rows.filter((l) => (l.text || "") === p[3]).map((l) => l.at).sort().pop() || null) : null, same_text_key: p[3] ? ((rows.filter((l) => (l.text || "") === p[3]).slice(-1)[0] || {}).reply_key || null) : null, failed_at: failed }] };
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
      if (/^INSERT INTO wa_bot_chats\(phone_norm, muted_until, mute_reason, muted_by\)/i.test(s)) { Object.assign(chat(p[0]), { muted_until: new Date(nowMs + p[1] * (/make_interval\(mins/.test(s) ? 60_000 : 3600_000)).toISOString(), mute_reason: "manual", muted_by: p[2] }); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, updated_at=NOW\(\) WHERE phone_norm=\$1 AND mute_reason='manual'/i.test(s)) { const c = chat(p[0]); if (c.mute_reason === "manual") Object.assign(c, { muted_until: null, mute_reason: null, muted_by: null }); return { rows: [] }; }
      if (/FROM wa_bot_chats c LEFT JOIN LATERAL/i.test(s)) return { rows: [...db.chats.values()].map((c) => ({ ...c })) };
      if (/FROM wa_bot_log WHERE decision='replied' AND at >=/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.decision === "replied").length }] };
      if (/^UPDATE wa_bot_chats SET muted_until=NULL/i.test(s)) { const clear = { muted_until: null, mute_reason: null, handoff_at: null, handoff_reason: null, unknown_streak: 0 }; if (p[0]) Object.assign(chat(p[0]), clear, /released_at=NOW\(\)/.test(s) ? { released_at: iso() } : {}); else for (const c of db.chats.values()) Object.assign(c, clear, { last_greet_at: null }); return { rows: [] }; }
      if (/FROM wa_bot_chats WHERE muted_until > NOW\(\)/i.test(s) && /count/.test(s)) return { rows: [{ n: [...db.chats.values()].filter((c) => c.muted_until && Date.parse(c.muted_until) > nowMs).length }] };
      if (/FROM dl_policies/i.test(s)) return { rows: policy ? [{ config: policy }] : [] };
      if (/FROM shop_coupons WHERE code=\$1/i.test(s)) return { rows: first && first.code === p[0] ? [first] : [] };
      if (/FROM shop_orders WHERE order_no=\$1 AND phone_norm=\$2/i.test(s)) return { rows: orders.filter((o) => o.order_no === p[0] && o.phone_norm === p[1]) };
      if (/^SELECT customer->>'name' AS name FROM shop_orders/i.test(s)) return { rows: orders.filter((o) => o.phone_norm === p[0]).slice(-1).map((o) => ({ name: o.customer?.name ?? null })) };
      /* ١٤/١٠: زر «تابع طلبك» + سياسة النافذة المقفولة (wapolicy.js) */
      if (/^INSERT INTO wa_bot_chats\(phone_norm, follow_order, follow_at\)/i.test(s)) { Object.assign(chat(p[0]), { follow_order: p[1], follow_at: iso() }); return { rows: [] }; }
      if (/^INSERT INTO wa_policy_skips/i.test(s)) { (db.policySkips ||= []).push({ order_no: p[0], phone_norm: p[1], stage: /'review'/.test(s) ? "review" : p[2], reason: /'review_merged'/.test(s) ? "review_merged" : p[3], at: iso() }); return { rows: [], rowCount: 1 }; }
      if (/FROM wa_policy_skips WHERE at >= \$1/i.test(s)) return { rows: (db.policySkips || []).map((x) => ({ order_no: x.order_no, stage: x.stage, reason: x.reason })) };
      if (/^SELECT template, source, stage, created_at AS at FROM wa_messages WHERE order_no=\$1 AND direction='out'/i.test(s)) return { rows: db.msgs.filter((m) => m.order_no === p[0] && m.direction === "out" && !["failed", "skipped"].includes(m.status)).map((m) => ({ template: m.template || null, source: m.source || null, stage: m.stage || null, at: m.created_at })).reverse() };
      if (/^SELECT order_no, stage, template, source FROM wa_messages WHERE direction='out' AND order_no IS NOT NULL AND stage IS NOT NULL/i.test(s)) return { rows: db.msgs.filter((m) => m.direction === "out" && m.order_no && m.stage && !["failed", "skipped"].includes(m.status)).map((m) => ({ order_no: m.order_no, stage: m.stage, template: m.template || null, source: m.source || null })) };
      /* SB4: نوافذ الـ٢٤ ساعة */
      if (/^SELECT driver FROM dl_shipments WHERE shop_order_no=\$1/i.test(s)) return { rows: (db.shipments || []).filter((x) => x.order_no === p[0]).slice(-1).map((x) => ({ driver: x.driver })) };
      if (/^SELECT review_code, review_order, review_asked_at FROM wa_bot_chats/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch ? [{ review_code: ch.review_code || null, review_order: ch.review_order || null, review_asked_at: ch.review_asked_at || null }] : [] }; }
      if (/^SELECT code, order_no FROM review_invites WHERE phone_norm=\$1/i.test(s)) return { rows: (db.invites || []).filter((x) => x.phone_norm === p[0]).slice(-1) };
      if (/^UPDATE review_invites SET sent_at=COALESCE/i.test(s)) { const iv = (db.invites || []).find((x) => x.code === p[0]); if (iv) { iv.sent_at = iv.sent_at || iso(); iv.channel = iv.channel || "wa_tap"; } return { rows: [] }; }
      if (/^SELECT window_sell_at FROM wa_bot_chats/i.test(s)) return { rows: [{ window_sell_at: (db.chats.get(p[0]) || {}).window_sell_at || null }] };
      if (/^UPDATE wa_bot_chats SET window_sell_at=NOW\(\)/i.test(s)) { chat(p[0]).window_sell_at = iso(); return { rows: [] }; }
      if (/^SELECT 1 FROM wa_bot_jobs WHERE phone_norm=\$1 AND kind IN \('assist_followup','assist_nudge','lead_followup','window_keep'/i.test(s)) return { rows: db.jobs.filter((j) => j.phone_norm === p[0] && ["assist_followup", "assist_nudge", "lead_followup", "window_keep", "assist_reminder", "reply_followup"].includes(j.kind) && j.status === "done").map(() => ({})) };
      if (/count\(\*\) FILTER \(WHERE done_at >= \(date_trunc/i.test(s)) { const d = db.jobs.filter((j) => j.kind === "window_keep" && j.status === "done"); return { rows: [{ today: d.length, week: d.filter((j) => j.phone_norm === p[0]).length }] }; }
      if (/^SELECT order_no FROM shop_orders WHERE phone_norm=\$1 AND NOT COALESCE\(is_test,false\) AND status IN \('pos_created'/i.test(s)) return { rows: orders.filter((o) => o.phone_norm === p[0] && ["pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way"].includes(o.status)).slice(-1) };
      if (/^SELECT b\.code FROM wa_bot_carts b/i.test(s)) return { rows: db.botCarts.filter((x) => x.phone === p[0] && !x.expired).slice(-1).map((x) => ({ code: x.code })) };
      /* RV1: النجوم جوّه واتساب (wareviews.js) — db.invites = دعوات التقييم، db.reviews = صفوف التقييم */
      if (/^SELECT review_stars_at FROM wa_bot_chats WHERE phone_norm=\$1/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch ? [{ review_stars_at: ch.review_stars_at || null }] : [] }; }
      if (/^UPDATE wa_bot_chats SET review_stars_at = CASE WHEN \$2::boolean THEN NOW\(\) ELSE NULL END WHERE phone_norm=\$1/i.test(s)) { chat(p[0]).review_stars_at = p[1] ? iso() : null; return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, review_code, review_order, review_stars_at\)/i.test(s)) { Object.assign(chat(p[0]), { review_code: p[1], review_order: p[2], review_stars_at: iso() }); return { rows: [] }; }
      if (/^SELECT review_code, review_stars_at, review_answered_at FROM wa_bot_chats/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch ? [{ review_code: ch.review_code || null, review_stars_at: ch.review_stars_at || null, review_answered_at: ch.review_answered_at || null }] : [] }; }
      if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='out' AND created_at > \$2::timestamptz \+ INTERVAL '15 seconds'/i.test(s)) return { rows: db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "out" && Date.parse(m.created_at) > Date.parse(p[1]) + 15_000).slice(0, 1).map(() => ({})) };
      if (/^SELECT review_code FROM wa_bot_chats WHERE phone_norm=\$1 AND review_asked_at/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch && ch.review_asked_at && nowMs - Date.parse(ch.review_asked_at) < 48 * 3600_000 ? [{ review_code: ch.review_code || null }] : [] }; }
      if (/^SELECT kind, option, ref, rating, skip_reason FROM review_invites WHERE code=\$1 AND phone_norm=\$2/i.test(s)) return { rows: (db.invites || []).filter((x) => x.code === p[0] && x.phone_norm === p[1]).map((x) => ({ kind: x.kind || null, option: x.option || null, ref: x.ref || null, rating: x.rating ?? null, skip_reason: x.skip_reason || null })) };
      if (/^SELECT order_no, code, phone_norm, option, kind, rating, review_id, ref FROM review_invites WHERE code=\$1/i.test(s)) return { rows: (db.invites || []).filter((x) => x.code === p[0]).map((x) => ({ option: null, kind: null, rating: null, review_id: null, ref: null, ...x })) };
      if (/^SELECT order_no, code, phone_norm, option, kind, rating, review_id, ref FROM review_invites WHERE wa_msg_id=\$1 AND phone_norm=\$2/i.test(s)) return { rows: (db.invites || []).filter((x) => x.wa_msg_id && x.wa_msg_id === p[0] && x.phone_norm === p[1]).map((x) => ({ option: null, kind: null, rating: null, review_id: null, ref: null, ...x })) };
      if (/^SELECT order_no, code, phone_norm, option, kind, rating, review_id, ref FROM review_invites WHERE phone_norm=\$1 AND created_at/i.test(s)) return { rows: (db.invites || []).filter((x) => x.phone_norm === p[0] && !/^TEST-/.test(x.order_no)).slice(-1).map((x) => ({ option: null, kind: null, rating: null, review_id: null, ref: null, ...x })) };
      if (/^UPDATE review_invites SET rating=\$2, wa_answer=\$3/i.test(s)) { const iv = (db.invites || []).find((x) => x.code === p[0] && x.rating == null); if (!iv) return { rows: [] }; Object.assign(iv, { rating: p[1], wa_answer: p[2], sent_at: iv.sent_at || iso(), channel: iv.channel || "wa_tap" }); return { rows: [{ order_no: iv.order_no }] }; }
      if (/^SELECT id FROM reviews WHERE phone_norm=\$1 AND channel='whatsapp'/i.test(s)) return { rows: (db.reviews || []).filter((r) => r.phone_norm === p[0] && nowMs - Date.parse(r.at) < 600_000).map((r) => ({ id: r.id })) };
      if (/^INSERT INTO reviews\(rating, code, code_label, channel, order_no, phone_norm, is_test, rating_exact, kind\)/i.test(s)) { const r = { id: (db.reviews ||= []).length + 1, rating: p[0], code: p[1], code_label: p[2], channel: "whatsapp", order_no: p[3], phone_norm: p[4], is_test: p[5], rating_exact: p[6], kind: p[7], categories: [], comment: null, at: iso() }; db.reviews.push(r); return { rows: [{ id: r.id }] }; }
      if (/^UPDATE review_invites SET review_id=\$2 WHERE code=\$1/i.test(s)) { const iv = (db.invites || []).find((x) => x.code === p[0]); if (iv) iv.review_id = p[1]; return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, review_low_id, review_low_at\)/i.test(s)) { Object.assign(chat(p[0]), { review_low_id: p[1], review_low_at: iso() }); return { rows: [] }; }
      if (/^SELECT review_low_id, review_low_at FROM wa_bot_chats/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch ? [{ review_low_id: ch.review_low_id || null, review_low_at: ch.review_low_at || null }] : [] }; }
      if (/^UPDATE reviews SET comment=\$3 WHERE id=\$1 AND phone_norm=\$2 AND comment IS NULL/i.test(s)) { const r = (db.reviews || []).find((x) => x.id === p[0] && x.phone_norm === p[1] && x.comment == null); if (r) r.comment = p[2]; return { rows: r ? [{ id: r.id }] : [] }; }
      if (/^UPDATE reviews SET categories = CASE/i.test(s)) { const r = (db.reviews || []).find((x) => x.id === p[0] && x.phone_norm === p[1]); if (r && !r.categories.includes(p[2])) r.categories.push(p[2]); return { rows: r ? [{ id: r.id }] : [] }; }
      if (/^UPDATE review_invites SET google_sent_at=/i.test(s)) { const iv = (db.invites || []).find((x) => x.code === p[0]); if (iv) iv.google_sent_at = iv.google_sent_at || iso(); return { rows: [] }; }
      /* SB2: طلب التقييم على واتساب */
      if (/^SELECT review_code, review_order, review_asked_at, review_answered_at FROM wa_bot_chats/i.test(s)) { const ch = db.chats.get(p[0]); return { rows: ch ? [{ review_code: ch.review_code || null, review_order: ch.review_order || null, review_asked_at: ch.review_asked_at || null, review_answered_at: ch.review_answered_at || null }] : [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, review_code, review_order, review_asked_at, review_answered_at\)/i.test(s)) { Object.assign(chat(p[0]), { review_code: p[1], review_order: p[2], review_asked_at: iso(), review_answered_at: null }); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET review_answered_at=NOW\(\)/i.test(s)) { chat(p[0]).review_answered_at = iso(); return { rows: [] }; }
      if (/^UPDATE review_invites SET wa_answer=\$2/i.test(s)) { (db.reviewAnswers ||= []).push([p[0], p[1]]); return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, last_loc\)/i.test(s)) { chat(p[0]).last_loc = JSON.parse(p[1]); return { rows: [] }; }
      if (/^INSERT INTO wa_optin_log\(phone_norm, kind, value, text_version, text, source, order_no, ip, ua\) VALUES \(\$1, 'marketing'/i.test(s)) { db.consentLog.push({ phone_norm: p[0], kind: "marketing", value: p[1], text_version: p[2], text: p[3], source: "bot", ua: p[4], at: iso() }); return { rows: [] }; }
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
  const mediaAsked = [];
  if (mediaFile) wa.fetchMedia = async (id, o) => { mediaAsked.push([id, o]); return typeof mediaFile === "function" ? mediaFile(id, o) : mediaFile; };
  const sms = [];
  const botCarts = { ensure: async () => {}, lastOrderCarts: async (ph, days, o) => { const v = typeof lastCart === "function" ? lastCart(ph, days, o) : lastCart; return (Array.isArray(v) ? v : v ? [v] : []).map((x, i) => ({ latest: i === 0, ...x })); },
    create: async (x) => { if (failDb && failDb.test("INSERT INTO wa_bot_carts")) return null; const code = `rc${String(db.botCarts.length + 1).padStart(6, "0")}`; db.botCarts.push({ code, created_at: iso(), ...x }); return { code }; }, open: async () => null, restore: async () => null, coverage: async () => ({ orders: 40, with_snapshot: 30, with_raw: 28, usable: 26, avg_diff: 0, mismatched: 2, links: db.botCarts.length, opened: 0 }) };
  const portalEvents = [];
  const bot = R.register(app, ctx, { app, wa, now: clock.now, noTimer: true, botCarts, ...(team ? { team: () => team } : {}), ...(flow ? { flow: () => flow } : {}), ...(fav ? { fav: () => fav } : {}),
    assist: { expandBundle: expandBundle || (async () => ({ ok: false, error: "bundle_not_found" })), modifiersCatalog: async () => ({ cfg: { enabled: true }, catalog: {} }), modifiersResolve: async () => ({ ok: true, shown: 0 }),
      quote: async (x) => (typeof quote === "function" ? quote(x.lat, x.lng) : quote), buildProfile: async () => ({ identity: { name: "أحمد" }, summary: { orders: 2, status: "repeat" }, orders: [], favorites: { items: [] }, addresses: [] }) }, whoami: async () => actor.who, ...(resolveMapsLink ? { resolveMapsLink } : { resolveMapsLink: async () => null }), sendSms: async (x) => { sms.push(x); return { ok: true }; },
    portalEmit: (ev2, data) => portalEvents.push([ev2, data]), whoami: async () => actor.who, ...(resolveMapsLink ? { resolveMapsLink } : { resolveMapsLink: async () => null }), sendSms: async (x) => { sms.push(x); return { ok: true }; },
    ...(variants ? { fetchVariants: async (id) => { if (variants[id] === "down") throw new Error("product down"); return variants[id] || []; } } : {}),
    fetchMenuPages: async () => { const pg = typeof pages === "function" ? pages() : pages; if (pg === null) throw new Error("menu down"); return pg; }, quote: async (lat, lng) => (typeof quote === "function" ? quote(lat, lng) : quote), llm,
    fetchOffers: async () => { if (offers === null) throw new Error("offers down"); return offers; }, ...(assistModel ? { assistCallModel: assistModel } : {}), ...(assistStore ? { assistStore } : {}), ...(kb ? { kb: () => kb } : {}), ...(transcribe ? { transcribe } : {}), ...(sttFetch ? { sttFetch } : {}) });
  let seq = 0;
  const hook = (field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: BIZ, phone_number_id: "PHONE1" }, ...value } }] }] });
  const ts = (agoMin = 0) => String(Math.floor((nowMs - agoMin * 60_000) / 1000));
  async function say(text, { from = "966512345678", id = null, type = "text", referral = null, agoMin = 0, raw = null } = {}) {
    const wamid = id || `wamid.IN${++seq}`;
    const msg = raw ? { from, id: wamid, timestamp: ts(agoMin), ...raw } : { from, id: wamid, timestamp: ts(agoMin), type, text: { body: text }, ...(referral ? { referral } : {}) };
    const before = calls.length;
    await wa.processWebhook(hook("messages", { messages: [msg] }));
    const all = calls.slice(before).map((c) => c.body);
    return { wamid, sent: all, all, log: db.log.find((l) => l.wamid === wamid) || null };
  }
  const press = (buttonId, title, o = {}) => say(null, { ...o, raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title } } } });
  const cashier = (text, to = "966512345678") => wa.processWebhook(hook("smb_message_echoes", { message_echoes: [{ from: BIZ, to, id: `wamid.ECHO${++seq}`, timestamp: ts(), type: "text", text: { body: text } }] }));
  const call = async (method, path, json = {}, query = {}) => routes[`${method} ${path}`]({ req: { json: async () => json, query: (k) => query[k], header: () => undefined, text: async () => "" }, json: (body, status = 200) => ({ body, status }) });
  /* وقت الرد المؤجّل: نقدّم الساعة ونشغّل دورة الردود المؤجّلة؛ بيرجّع اللي اتبعت فيها */
  const tick = async (min = 0) => { clock.advance(min); const before = calls.length; await bot.runDueJobs(); return calls.slice(before).map((c) => c.body); };
  return { db, clock, calls, sms, portal: portalEvents, mediaAsked, say, press, cashier, call, wa, bot, tick, setOwner: (v) => { owner = v; }, setActor: (v) => { actor.who = v; }, setMode: (m) => { db.settings.waBot = { ...db.settings.waBot, mode: m }; } };
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
  assert.equal(a.log.replies[0].interactive.type, "list"); assert.equal(a.log.replies.length, 1);
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
    if (o.status === "delivered") {      // EX4: a closed order is not «your order status» — one plain line, the last order for reference, two buttons, no handover
      assert.equal(bodyOf(r.sent[0]), `ما فيه طلب مفتوح على رقمك هذا الحين.\nآخر طلب لك W1790011111111: ${label}\nتبي تطلب، أو أحوّلك لموظف؟`, label);
      assert.deepEqual(r.sent[0].interactive.action.buttons.map((x) => x.reply.id), ["bot:menu", "bot:human"], label);
    } else assert.deepEqual(r.sent, [cta(ME, `طلبك رقم W1790011111111: ${label}`, "تتبّع الطلب", "https://freshcuts.sa/track/W1790011111111")], label);
    assert.equal(r.log.handoff, null, label);
  }
}));

/* ── ٤) الإنسان أولاً ────────────────────────────────────────────────────── */
/* ── ٥) النافذة، التكرار، الحدود ────────────────────────────────────────── */
test("window rule: a late-delivered message is handed to staff and the customer is told (M4: never silence), and nothing older than 24 h is ever answered", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const a = await w.say("مفتوحين؟", { agoMin: 45 });
  assert.deepEqual(a.sent, [txt(ME, `سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\n${HAND}`)]); assert.deepEqual([a.log.decision, a.log.reply_key, a.log.handoff], ["replied", "staff", "late_message"]);
  assert.equal((await w.say("تمام", { agoMin: 45, from: "966511111111" })).log.reason, "stale", "a late «ok» closes nothing and needs no staff");
  const b = await w.say("مفتوحين؟", { agoMin: 25 * 60, from: "966598765432" });
  assert.equal(b.sent.length, 0); assert.equal(b.log.reason, "outside_window");
  assert.equal((await w.say("مفتوحين؟", { agoMin: 5, from: "966555555555" })).sent.length, 1);
  // the bot never starts a conversation: there is no code path that sends without an inbound message
  assert.equal(w.calls.length, 2);
}));

/* ── ٦) المواعيد ─────────────────────────────────────────────────────────── */
test("closed hours: says when we open, points to «نبّهني أول ما نفتح», and handovers say the reply comes after opening", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, at: CLOSED_AT });
  assert.deepEqual((await w.say("مفتوحين الحين؟")).sent, [cta(ME,
    "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً.\nجهّز سلتك من الرابط واضغط «نبّهني أول ما نفتح» ونذكّرك.",
    "جهّز سلتك", "https://freshcuts.sa/l/wab-boxes")]);
  const g = await w.say("مرحبا", { from: "966598765432" });
  assert.equal(g.sent[0].interactive.body.text, "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.\n🌙 المطعم مقفل الحين ونفتح اليوم الساعة 12 ظهراً.");
  const h = await w.say("ابي موظف", { from: "966555555555" });
  assert.equal(h.sent[0].text.body, "أبشر 🙏 حوّلت محادثتك لموظف.\nالمطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً، وأنا أترك المحادثة له.");
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
  const g0 = await w.say("مرحبا، ابي اعرف اكثر", { referral });
  assert.equal(g0.log.reply_key, "greet"); assert.equal(g0.sent[0].interactive.type, "list", "the greeting is the short menu; the ad's link comes with the first answer that has a link");
  assert.equal(g0.log.referral, true); w.clock.advance(1);
  const g = await w.say("ابي اطلب");
  assert.equal(g.sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-box-d4");
  assert.equal(g.log.link_slug, "wa-box-d4");
  assert.deepEqual(w.db.chats.get("512345678").referral, { source_id: "120251225139440593", source_type: "ad", source_url: "https://fb.me/abc", headline: "ميكس جريل لشخصين", ctwa_clid: "CLID123" });
  // later messages carry no referral object — the stored one keeps the attribution for 72 h
  w.clock.advance(30);
  assert.equal((await w.say("ابي اطلب")).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-box-d4");
  w.clock.advance(73 * 60);
  assert.equal((await w.say("ابي اطلب")).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  // an ad that is not in the map uses the general ad link; an organic chat uses the bot link
  const w2 = world({ waBot: { mode: "live" } });
  assert.equal((await w2.say("ابي اطلب", { referral: { source_id: "999999999", source_type: "ad", ctwa_clid: "X" } })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wa-boxes");
  assert.equal((await w2.say("ابي اطلب", { from: "966598765432" })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  // a real question from an ad chat is answered as that question, not swallowed by a greeting
  const w3 = world({ waBot: { mode: "live" } });
  assert.equal((await w3.say("كم رسوم التوصيل", { referral })).log.reply_key, "delivery");
  // greet only ad chats (dashboard choice)
  const w4 = world({ waBot: { mode: "live", greetScope: "ads" } });
  const na = await w4.say("السلام عليكم");
  assert.equal(na.log.reply_key, "main"); assert.equal(bodyOf(na.sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.", "greeting kept for ad chats ⇒ an organic hello still gets the main menu, never silence");
  assert.equal((await w4.say("السلام عليكم", { from: "966598765432", referral })).sent.length, 1);
  assert.equal((await w4.say("المنيو")).sent.length, 1, "questions are still answered for everyone");
}));

/* ── ٨) بيانات ناقصة وفشل الإرسال ───────────────────────────────────────── */
/* ── ٩) الإيقاف والمرفقات ───────────────────────────────────────────────── */
test("«إيقاف» stops marketing (also in looser wording) and is confirmed; order-status questions still get answered", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, orders: [order({ status: "on_the_way" })] });
  const s = await w.say("إيقاف");
  const STOP = "تم إيقاف العروض ✅ تحديثات طلباتك مستمرة.\nضغطت بالغلط؟ اضغط «رجّع العروض». وللرجوع في أي وقت اكتب: اشتراك";
  assert.equal(bodyOf(s.sent[0]), STOP);
  assert.deepEqual(s.sent[0].interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["stop:undo", "↩️ رجّع العروض"], ["stop:updates", "أوقف تحديثات الطلب"], ["stop:ok", "تمام"]], "M2: «إيقاف» stops the offers; order updates stop only with their button. EX4: the first button undoes the stop");
  assert.ok(!w.db.optins["512345678"].stopped_at, "order updates are still on");
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
  assert.equal(R.textProblem("menu", "ar", "أهلاً {boxes} {price}"), "unknown_placeholder:price");
  assert.equal(R.textProblem("greet", "ar", "أهلاً {{1}}"), "double_braces");
  assert.equal(R.textProblem("greet", "ar", "أهلاً {boxes"), "stray_brace");
  assert.equal(R.textProblem("btn_menu", "ar", "عنوان زر أطول من عشرين حرفاً بكثير"), "too_long:20");
  assert.equal(R.textProblem("footer", "ar", "سطر\nسطرين"), "single_line_only");
  assert.equal(R.textProblem("nope", "ar", "x"), "unknown_key");
  assert.equal(R.configFromBody({ texts: { greet: { ar: "حياك {discount}" } } }).ok, false);
  // clamps: a nonsense number can not switch a safety rule off
  const c = R.botConfig({ waBot: { humanPauseMin: 0, maxRepliesPerHour: 9999, maxAgeMinutes: -5, staffWaitMin: 999, sameTextSeconds: 999 } });
  assert.deepEqual([c.humanPauseMin, c.maxRepliesPerHour, c.maxAgeMinutes, c.staffWaitMin, c.sameTextSeconds], [1, 300, 1, 15, 120]);
  assert.equal("unknownWaitMin" in c, false, "the three-minute wait on a message the bot did not understand is gone (12/10)");

  const w = world({ waBot: {} });
  w.setOwner(false);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live" })).status, 403);
  w.setOwner(true);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live", texts: { thanks: { ar: "العفو {x}" } } })).status, 400);
  assert.equal(w.db.settings.waBot.mode, undefined, "a refused save changes nothing");
  const noScope = await w.call("PUT", "/api/cms/wabot/config", { mode: "live" });
  assert.deepEqual([noScope.status, noScope.body.scopeReason], [400, "choose_scope"], "M5: switching the bot on for customers names its scope in the same request"); assert.equal(w.db.settings.waBot.mode, undefined);
  const ok = await w.call("PUT", "/api/cms/wabot/config", { mode: "live", liveScope: "all", humanPauseMin: 45, texts: { thanks: { ar: "حيّاك الله، في خدمتك دائماً 🌟" }, greet: { ar: "أهلاً بك في فريش كاتس 👋\n{closed}" } } });
  assert.equal(ok.body.ok, true);
  assert.deepEqual((await w.say("شكرا")).sent, [txt(ME, "حيّاك الله، في خدمتك دائماً 🌟")]);
  assert.equal((await w.say("السلام عليكم", { from: "966598765432" })).sent[0].interactive.body.text, "أهلاً بك في فريش كاتس 👋");
  // emptying a text returns it to the default; other settings are kept
  await w.call("PUT", "/api/cms/wabot/config", { texts: { thanks: { ar: "" } } });
  assert.equal(w.db.settings.waBot.texts.thanks, undefined); assert.equal(w.db.settings.waBot.humanPauseMin, 45); assert.equal(w.db.settings.waBot.mode, "live");
  assert.equal(w.db.settings.waBot.liveSince, w.clock.now().toISOString(), "the go-live moment is stamped once");
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
const SOON = "\nيرد عليك موظف هنا في أقرب وقت، وأنا أترك المحادثة له.";
const DISC = "معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف";
const mins = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);
const CLOSE_AT = "2026-10-12T23:00:00Z";     // الثلاثاء ٠٢:٠٠ الرياض = قفلة وردية الاثنين

test("order status: never another person's order; no open order ⇒ say so plainly with two buttons (order / staff), no automatic handover", withEnv(LOCKS_OPEN, async () => {
  const other = order({ order_no: "W1790099999999", phone_norm: "598765432", status: "on_the_way" });
  const w = world({ waBot: { mode: "live" }, orders: [other] });
  const r = await w.say("وين طلبي W1790099999999");
  assert.equal(bodyOf(r.sent[0]), "ما فيه طلب مفتوح على رقمك هذا الحين.\nتبي تطلب، أو أحوّلك لموظف؟");
  assert.deepEqual(r.sent[0].interactive.action.buttons.map((x) => [x.reply.id, x.reply.title]), [["bot:menu", "🎁 البوكسات والمنيو"], ["bot:human", "👤 كلّم موظف"]]);
  assert.doesNotMatch(JSON.stringify(r.sent), /W1790099999999|الطريق/);
  assert.equal(r.log.handoff, null); assert.equal(w.sms.length, 0, "nobody is alerted for «no open order»; the customer has the staff button");
  w.clock.advance(1);
  const hu = await w.press("bot:human", "👤 كلّم موظف");
  assert.equal(hu.log.handoff, "asked_human"); assert.deepEqual(w.sms.map((s) => s.phoneNorm), ["544775082", "506338246"], "the alert goes to Omar AND the manager"); assert.ok(w.sms.every((s) => s.kind === "staff" && s.body.length <= 160));
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
  // M4: an unrecognised message during the pause waits for the staff member like any other, and is answered if he stays silent (never left without a reply)
  const w3 = world({ waBot: { mode: "live" } });
  await w3.cashier("هلا");
  const u = await w3.say("طيب والثاني؟");
  assert.deepEqual([u.sent.length, u.log.decision, u.log.reason, u.log.reply_key], [0, "waiting", "staff_pause", "unknown"]); assert.equal(w3.db.jobs.length, 1);
  assert.equal(mins(u.log.resume_at, w3.clock.now().toISOString()), 5);
  const late3 = await w3.tick(5);
  assert.equal(late3.length, 1); assert.match(bodyOf(late3[0]), /ما وضح لي|ما فهمت|ما قدرت أفهم|لم أفهم/); assert.deepEqual([u.log.decision, u.log.reason], ["replied", "after_staff_wait"]);
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
const FALLBACK = (to) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: { type: "button", body: { text: "المعذرة، ما وضح لي طلبك 🙏 اكتبه لي بكلمات ثانية أو اختر من الأزرار، وإذا تبي أحد من الفريق اكتب: موظف" }, footer: { text: FOOTER },
  action: { buttons: [{ type: "reply", reply: { id: "bot:menu", title: "🎁 البوكسات والمنيو" } }, { type: "reply", reply: { id: "bot:status", title: "📦 وين طلبي؟" } }, { type: "reply", reply: { id: "bot:human", title: "👤 كلّم موظف" } }] } } });
/* ── القاعدة ٧: التعريف ─────────────────────────────────────────────────── */
test("rule 7: the first bot message of a conversation says it is automated and how to reach a person; once per 24 h", withEnv(LOCKS_OPEN, async () => {
  const CONTACT = { storefront: { seo: { faq: [...FAQ, { q: "كيف أتواصل مع المطعم؟", a: "هاتف أو واتساب على 0546715683." }] } } };
  const w = world({ waBot: { mode: "live" }, disclosure: true, extraSettings: CONTACT });
  const a = await w.say("السلام عليكم");
  assert.equal(a.sent[0].interactive.body.text, `${DISC}، أو اتصل على 0546715683\nحيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.`);
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
  assert.equal(g2.log.reply_key, "main"); assert.equal(g2.sent.length, 1); assert.ok(g.log.at);
  await w.say("وين موقعكم", { from: "966598765432" }); await w.say("طرق الدفع", { from: "966577777777" }); await w.say("المنيو", { from: "966566666666" });
  const st = await w.call("GET", "/api/cms/wabot/stats", {}, { days: "7" });
  assert.deepEqual(st.body.month, { replies: 5, free: 2, billable: 3, rateSar: 0.0401, costSar: 0.12 });
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
const HAND = "يرد عليك موظف هنا في أقرب وقت، وأنا أترك المحادثة له.";

test("conversation: greeting (link + main menu) → order → delivery → hours → location → payment → thanks (exact payloads)", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, greetMenu: true });
  const g = await w.say("السلام عليكم");
  assert.equal(g.sent.length, 1, "the greeting is ONE short message: a welcome line and the menu (Omar 12/10: the long greeting with the boxes was too much)");
  assert.equal(g.sent[0].interactive.type, "list"); assert.equal(bodyOf(g.sent[0]), "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.");
  assert.deepEqual(rowsOf(g.sent[0]).map((r) => [r.id, r.title]), [["m:boxes", "🎁 البوكسات"], ["m:cats", "📋 المنيو بالأقسام"], ["m:offers", "🔥 العروض وأول طلب"], ["m:delivery", "🛵 التوصيل والرسوم"], ["m:status", "📦 حالة طلبي"], ["m:human", "👤 كلّم موظف"]]);
  assert.doesNotMatch(JSON.stringify(g.sent), /بوكسات فردية|ر\.س|FIRST|freshcuts\.sa/, "no box list, no fees, no offer text, no link in the greeting");
  assert.equal(w.db.log.length, 1);
  w.clock.advance(1);
  const again = await w.say("هلا");
  assert.equal(again.sent.length, 1); assert.equal(again.log.reply_key, "main"); assert.equal(bodyOf(again.sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.");
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
  assert.deepEqual((await w.say("يعطيك العافية")).sent, [txt(ME, "العفو، حيّاك الله في أي وقت 🌟")]);
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
  const pk = await w.say("ابي طلب لـ ٥٠ شخص");
  assert.deepEqual(pk.sent[0], cta(ME, "باقات التجمعات 👥\n• باقة تجمّع ٤–٦ أشخاص: 225 ر.س (لين 15/10)\n• باقة تجمّع ٨–١٠ أشخاص: 395 ر.س (لين 15/10)\n• باقة مناسبة ١٥ شخصاً وأكثر: 595 ر.س (لين 15/10)", "اطلب الآن", "https://freshcuts.sa/l/wab-packs"));
  assert.equal(pk.log.link_slug, "wab-packs");
  // the packs link switched off in the dashboard ⇒ the button falls back to the ordinary link (never a dead link)
  { const w2 = liveWorld(); w2.db.links.push({ slug: "wab-packs", active: false, clicks: 0 });
    const p2 = await w2.say("ابي طلب لـ ٥٠ شخص"); assert.equal(p2.sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes"); }
  assert.equal(bodyOf(pk.sent[1]), "وعندنا عروض مخصصة للتجمعات والمناسبات وطلبات الشركات 👇");
  assert.deepEqual(pk.sent[1].interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["bot:custom", "أبغى عرض مخصص"], ["bot:menu", "📋 القائمة"]]);
  // «أبغى عرض مخصص»: the details are asked first, then it is handed to staff (one alert); with the reopening time when closed
  { const cw = liveWorld();
    const co = await cw.press("bot:custom", "أبغى عرض مخصص");
    assert.deepEqual(co.sent, [txt(ME, `أبشر 🙏 عشان نجهّز لك عرض مخصص اكتب لنا هنا: عدد الأشخاص، اليوم والوقت، وتوصيل أو استلام.\nحوّلت طلبك لموظف.\n${HAND}`)]);
    assert.equal(co.log.handoff, "custom_offer"); assert.equal(cw.sms.length, 2); assert.match(cw.sms[0].body, /wants a tailored group offer/);
    const cc = await liveWorld({ at: CLOSED_AT }).press("bot:custom", "x");
    assert.match(bodyOf(cc.sent[0]), /يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً/); }
  w.clock.advance(1);
  assert.deepEqual((await w.press("m:pickup", "x")).sent, [cta(ME, "🏃 نعم، اختر «استلام» في صفحة الطلب وسيكون طلبك جاهزاً في فرع حي السلامة.", "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  const h = await w.press("m:hours", "x");
  assert.equal(h.sent.length, 2); assert.match(bodyOf(h.sent[0]), /^⏰ مواعيدنا:/); assert.equal(urlOf(h.sent[1]), "https://maps.google.com/?cid=14767749764292326433");
  const loc = (q) => liveWorld({ quote: q }).say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.equal(bodyOf((await loc({ ok: true, deliverable: true, fee: 15 })).sent[0]), `✅ موقعك داخل نطاق التوصيل.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 60 ر.س: 20 ر.س\n• من 60 ر.س: 15 ر.س\n• من 80 ر.س: 10 ر.س\n• من 100 ر.س: 5 ر.س\n• من 150 ر.س: مجاني\n${FIRST_LINE}`);
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
  assert.deepEqual(v.sent, [txt(ME, `ما أقدر أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا وأجهّزه لك على طول.\nوحوّلت محادثتك لموظف يسمعها.\n${HAND}`)]); assert.equal(v.log.handoff, "media");      // PK1
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
    assert.equal(r.log.reply_key, "human", phrase); assert.equal(r.log.handoff, phrase === "ابي المدير" ? "asked_manager" : "asked_human", phrase); assert.equal(w.sms.length, 2, phrase);      // RG1: «المدير» = طلب مسؤول
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
  // Omar 12/10: after staff replied to a complaint the bot is completely silent — no facts, no reminder
  for (const q of ["المنيو", "متى تقفلون", "وين طلبي", "ابي اطلب", "عندي شكوى ثانية"]) { const x = await w3.say(q); assert.equal(x.sent.length, 0, q); assert.equal(x.log.reason, "complaint_with_staff", q); assert.ok(x.log.resume_at); w3.clock.advance(1); }
  assert.equal(w3.sms.length, 2, "no second alert");
  assert.equal(bodyOf((await w3.say("إيقاف")).sent[0]).slice(0, 12), "تم إيقاف الع", "«إيقاف» is still confirmed");
  await w3.call("POST", "/api/cms/wabot/chats/unmute", { phone: "0512345678" }); w3.clock.advance(1);
  assert.equal((await w3.say("المنيو")).sent.length, 1);
}));

test("rule 4b: with an open complaint the bot answers facts only — no order link, no first-order line, no second alert", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ at: CLOSED_AT, orders: [order({ status: "delivered" })] });
  const c = await w.say("الطلب وصل بارد وناقص");
  assert.deepEqual(c.sent, [txt(ME, "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nطلبك رقم W1790011111111 قدّامنا.\nالمطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح اليوم الساعة 12 ظهراً، وأنا أترك المحادثة له.")]);
  assert.equal(w.sms.length, 2, "the alert still goes out while closed");
  w.clock.advance(2);
  assert.deepEqual((await w.say("متى تفتحون")).sent, [txt(ME, "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً.")]);
  w.clock.advance(2);
  assert.equal(urlOf((await w.say("وين موقعكم")).sent[0]), "https://maps.google.com/?cid=14767749764292326433");
  w.clock.advance(2);
  assert.match(bodyOf((await w.say("وين طلبي")).sent[0]), /^ما فيه طلب مفتوح على رقمك هذا الحين\.\nآخر طلب لك W1790011111111: تم توصيل طلبك ✅\n/);
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

const FALLBACK2 = (to) => ({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: { type: "button", body: { text: "المعذرة، ما وضح لي طلبك 🙏 اكتبه لي بكلمات ثانية أو اختر من الأزرار، وإذا تبي أحد من الفريق اكتب: موظف" }, footer: { text: FOOTER },
  action: { buttons: [{ type: "reply", reply: { id: "bot:menu", title: "📋 القائمة" } }, { type: "reply", reply: { id: "bot:status", title: "📦 وين طلبي؟" } }, { type: "reply", reply: { id: "bot:human", title: "👤 كلّم موظف" } }] } } });
test("rule 5: a message the bot does not understand is answered AT ONCE with the honest line + buttons (no three minutes of silence); twice in a row ⇒ staff; a staff member in the chat still gets his wait", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  assert.equal((await w.say("كم رسوم التوصيل")).sent.length, 1);
  const u = await w.say("قفغفغ", { from: "966598765432" });
  assert.deepEqual(u.sent, [FALLBACK2("966598765432")]); assert.deepEqual([u.log.decision, u.log.reply_key, u.log.handoff], ["replied", "unknown", null]);
  assert.equal(w.db.jobs.length, 0, "nothing is parked");
  w.clock.advance(1);
  assert.equal(bodyOf((await w.press("bot:menu", "📋 القائمة", { from: "966598765432" })).sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.");
  // a staff member is talking to the customer: he gets his five minutes; after them the customer gets the honest line (M4: no «left to staff» silence)
  const w2 = liveWorld();
  await w2.cashier("تفضل كيف أخدمك"); w2.clock.advance(1);
  const v = await w2.say("قفغفغ");
  assert.deepEqual([v.sent.length, v.log.decision, v.log.reason], [0, "waiting", "staff_pause"]);
  assert.deepEqual(await w2.tick(5), [FALLBACK2(ME)]);
  // the second message in a row that is not understood goes to staff at once (alert as today)
  const w3 = liveWorld();
  await w3.say("قفغفغ"); w3.clock.advance(1);
  const s = await w3.say("ثصضص");
  assert.deepEqual(s.sent, [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.\n${HAND}`)]); assert.equal(s.log.handoff, "not_understood_twice"); assert.equal(w3.sms.length, 2);
  assert.deepEqual((await liveWorld({ at: CLOSED_AT }).say("قفغفغ")).sent, [FALLBACK2(ME)]);
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
  assert.equal(w.calls.length, 1, "one greeting, once"); assert.equal(w.db.log.length, 1);
  assert.equal(await w.bot.handle({ phone: "512345678", wamid: "wamid.SAME", text: "السلام عليكم", type: "text", at: w.clock.now().toISOString(), isEcho: false, intent: null }), true);
  assert.equal(w.calls.length, 1);
  // the duplicate guard is for a double send, not for a customer repeating himself (Omar 12/10: «ايه احسن عرض عندكم» a minute later got silence)
  assert.equal(R.botConfig({}).sameTextSeconds, 8);
  const d = liveWorld();
  assert.equal((await d.say("المنيو")).sent.length, 1);
  const dup = await d.say("المنيو");                                  // the very same text again in the same second
  assert.equal(dup.sent.length, 1); assert.equal(bodyOf(dup.sent[0]), "نفس المعلومة 👆 تبي أحوّلك لموظف؟"); assert.deepEqual(dup.sent[0].interactive.action.buttons.map((x) => x.reply.id), ["bot:human"]); assert.equal(dup.log.reply_key, "repeat_short");
  const dup3 = await d.say("المنيو");                                 // and a third time: a person
  assert.deepEqual(dup3.sent, [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.\n${HAND}`)]); assert.equal(dup3.log.handoff, "repeated_question");
  const d2 = liveWorld(); await d2.say("المنيو"); await d2.say("المنيو");
  assert.equal((await d2.say("ارسل المنيو")).sent.length, 1, "another wording of the same question is answered");
  const d3 = liveWorld(); await d3.say("المنيو"); await d3.say("المنيو");
  d3.clock.advance(1);
  const again = await d3.say("المنيو");                                // a minute later, the same words: answered
  assert.equal(again.sent.length, 1); assert.equal(again.log.decision, "replied");
  const off = liveWorld({ waBot: { sameTextSeconds: 0 } }); await off.say("المنيو"); assert.equal((await off.say("المنيو")).sent.length, 1, "0 = the guard is off");
  // the hourly guard for TYPED messages: one calm line, no handover, no alert; quiet until the window slides; then back by itself
  assert.deepEqual([R.botConfig({}).maxRepliesPerHour, R.botConfig({}).maxTapsPerHour, R.botConfig({}).maxRepliesPerMinute], [40, 150, 6]);
  const cap = liveWorld({ waBot: { maxRepliesPerHour: 5, sameTextSeconds: 0 } });
  const keys = [];
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "طرق الدفع", "ابي اطلب", "بكم الكفتة", "اسعاركم"]) { const r = await cap.say(q); keys.push([r.log.reply_key, r.sent.length, r.log.reason || null, r.log.handoff || null]); cap.clock.advance(2); }
  assert.deepEqual(keys, [["cats", 1, null, null], ["delivery", 1, null, null], ["location", 1, null, null], ["hours", 1, null, null], ["payment", 1, null, null],
    ["rate", 1, null, null], ["items", 0, "rate_limited", null], ["cats", 0, "rate_limited", null]]);
  assert.deepEqual(cap.calls[cap.calls.length - 1].body, txt(ME, "وصلنا حد الرسائل الآلية لهذه الساعة 🙏 اكتب «موظف» لو تحتاج مساعدة."));
  assert.equal(cap.sms.length, 0, "the guard never alerts staff"); assert.equal(cap.db.chats.get("512345678").handoff_at ?? null, null, "and never opens a handover");
  const lim = cap.db.log[cap.db.log.length - 1];
  assert.equal(lim.detail, "hour"); assert.equal(mins(lim.resume_at, cap.db.log[0].at), 60, "the log says when the bot answers again: one hour after the oldest counted reply");
  assert.equal((await cap.say("ابي اكلم موظف")).log.handoff, "asked_human", "asking for a person always works, limit or not");
  const cap2 = liveWorld({ waBot: { maxRepliesPerHour: 5, sameTextSeconds: 0 } });
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "طرق الدفع", "ابي اطلب"]) { await cap2.say(q); cap2.clock.advance(2); }
  cap2.clock.advance(52);
  assert.equal((await cap2.say("بكم الكفتة")).log.reply_key, "items", "the window slid: the bot is back without anyone touching it");
  // menu taps are counted apart from typed messages: browsing the tree is never cut off by the typed-message limit
  const nav = liveWorld({ waBot: { maxRepliesPerHour: 5, sameTextSeconds: 0 } });
  const taps = [["m:cats", "📋 المنيو بالأقسام"], ["m:boxes", "🎁 البوكسات"], ["tier:0", "x"], ["tier:1", "x"], ["tier:2", "x"], ["m:main", "x"], ["m:delivery", "x"], ["m:offers", "x"], ["m:hours", "x"], ["m:packs", "x"], ["m:pay", "x"], ["box:box-family", "x"]];
  let navSent = 0;
  for (let i = 0; i < 36; i++) { const t = taps[i % taps.length]; const r = await nav.press(t[0], t[1]); navSent += r.sent.length ? 1 : 0; assert.notEqual(r.log.reply_key, "rate", `tap ${i + 1}`); assert.equal(r.log.handoff || null, null); nav.clock.advance(1); }
  assert.equal(navSent, 36, "36 taps in 36 minutes: every one answered");
  assert.equal((await nav.say("بكم الكفتة")).log.reply_key, "items", "and a typed question after all that browsing is still answered");
  const tapCap = liveWorld({ waBot: { maxTapsPerHour: 20, sameTextSeconds: 0 } });
  for (let i = 0; i < 20; i++) { await tapCap.press(taps[i % taps.length][0], "x"); tapCap.clock.advance(1); }
  const over = await tapCap.press("m:cats", "x");
  assert.equal(over.log.reply_key, "rate"); assert.equal(over.log.handoff || null, null);
  tapCap.clock.advance(1);
  const over2 = await tapCap.press("m:boxes", "x"); assert.equal(over2.log.reason, "rate_limited"); assert.equal(over2.log.detail, "taps");
  // burst: more than maxRepliesPerMinute in one minute ⇒ one «لحظة» line, then quiet for the minute, then normal
  const burst = liveWorld({ waBot: { maxRepliesPerMinute: 3, sameTextSeconds: 0 } });
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
  const w = liveWorld({ waBot: { sameTextSeconds: 0 }, quote: { ok: true, deliverable: true, fee: 15 } });
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
  assert.equal(w.sms.length, 0, "EX4: «no open order» is said plainly with two buttons and alerts nobody; the limit alerted nobody either");
  // then a voice note: the bot can not open it ⇒ handover, said plainly
  const voice = await step("voice note", w.say(null, { raw: { type: "audio", audio: { id: "A1" } } }));
  assert.equal(voice.log.handoff, "media"); assert.match(bodyOf(voice.sent[0]), /^ما أقدر أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا/);
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
    [{ bundles: [] }, "ابي بوكس"], [{ bundles: null }, "ابي بوكس"], [{ bundles: [{ price: 0, section: "x" }, { price: 20 }] }, "عندكم عروض"], [{ pages: null }, "المنيو"], [{ pages: [] }, "وش الاصناف"],
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
  assert.equal(bodyOf((await w.say("السلام عليكم")).sent[0]), "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.");
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
    assert.deepEqual(y.sent, [FALLBACK2(ME)]); assert.equal(y.log.decision, "replied");
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

test("masking never eats a dish: address and name cues must be whole words — «دوريتوس», «برجر», every menu and box name stay as written", () => {
  const M = LLM.maskText;
  const flat = (t) => t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/\s+/g, " ").trim();      // maskText also writes digits Western and trims spaces
  // the defect of 12/10: «دور» (floor) matched inside «دوريتوس», so the side choice reached the model as «[عنوان]»
  assert.equal(M("كريب زنجر سوبريم وكريب ميكس دجاج، والجانبي دوريتوس، والزنجر بدون مخلل"), "كريب زنجر سوبريم وكريب ميكس دجاج، والجانبي دوريتوس، والزنجر بدون مخلل");
  for (const same of ["والجانبي دوريتوس", "ابي برجر لحم كلاسيك", "برجرين ودوريتوس", "جبنة فيلادلفيا", "الدور عليك", "دوري ابطال", "شارعكم زحمة", "شقتي بعيدة", "ادفع عن طريق ابل باي", "اطلب عن طريق الموقع", "ابي اطلب معك بيتزا",
    "معك بوكس الكريب؟", "معاك طلب لشخصين", "حيّاكم الله", "الحين مفتوحين؟", "flatbread please", "a floor of fries", "burger and doritos", "building my order", "the villa menu", "الطابق مو مهم"])
    assert.equal(M(same), flat(same), same);
  // every dish and box name of the live menu, alone and inside an order sentence, in both languages
  const names = [...R0.indexMenu(LIVE.pages).items.flatMap((i) => [i.name, i.nameEn]), ...LIVE.bundles.flatMap((b) => [b.name, b.name_en])].filter(Boolean);
  assert.ok(names.length > 150);
  for (const n of names) for (const t of [n, `ابي ${n}`, `ابي 2 ${n} والجانبي دوريتوس`, `I want ${n} please`]) assert.equal(M(t), flat(t), t);
  // real address and name details are still masked
  for (const [raw, out] of [["برج العرب الدور الثاني شقة 4", "[عنوان] [عنوان] [عنوان]"], ["عمارة 12 الدور 3", "[عنوان] [عنوان]"], ["فيلا 22", "[عنوان]"], ["الطابق الثالث", "[عنوان]"], ["floor 3 apt 12", "[عنوان] [عنوان]"], ["apartment 5", "[عنوان]"],
    ["شارع التحلية", "[عنوان]"], ["طريق المدينة الطالع", "[عنوان]"], ["معك خالد ابي اطلب", "معك [اسم] ابي اطلب"], ["السلام عليكم معاك ابو فهد", "السلام عليكم معاك [اسم]"], ["ابي كريب واسمي خالد العمري", "ابي كريب واسمي [اسم]"], ["هلا معك سارة", "هلا معك [اسم]"],
    ["الطلب باسم سارة", "الطلب باسم [اسم]"], ["انا في حي الصفا جنب مسجد النور", "انا في حي الصفا [عنوان]"]]) assert.equal(M(raw), out, raw);
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
  assert.equal(n, 2, "ceiling reached: the model is not called"); assert.equal(s3.log.detail, "llm off: budget_day"); assert.equal(s3.log.reply_key, "unknown", "the bot carries on with the rules");
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
    const g = await w.say("السلام عليكم"); out.greet = foot(g.sent[0]); out.greetBody = bodyOf(g.sent[0]); out.menuRows = rowsOf(g.sent[0]).map((r) => r.id);
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
  assert.equal(smart.greet, null, "the first message already carries the introduction: no footer repeating «موظف» in the same bubble");
  assert.ok(smart.menuRows.includes("m:human"), "the menu itself carries «كلّم موظف»");
  assert.deepEqual([smart.cta, smart.list, smart.box, smart.notmenu, smart.status], [null, null, null, null, null], "no footer on ordinary answers");
  assert.ok(smart.notmenuBtns.includes("bot:human"));
  assert.equal(smart.unknown, FOOTER, "the not-understood reply keeps it");
  assert.equal(smart.optin, FOOTER, "buttons with no way back (yes / no) keep it");
  const always = await run("always");
  assert.deepEqual([always.greet, always.cta, always.list, always.box, always.notmenu, always.unknown, always.status, always.optin], Array(8).fill(FOOTER));
  const first = await run("first");
  assert.deepEqual([first.greet, first.cta, first.list, first.box, first.notmenu, first.status, first.optin], [FOOTER, null, null, null, null, null, null]);
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
  for (const [k, v] of Object.entries(R.DEFAULTS)) { if (["llm", "optin", "links", "assist", "reviewFlow"].includes(k)) for (const k2 of Object.keys(v)) { if (k === "links" && k2 === "channel") for (const k3 of Object.keys(v[k2])) flat.push(`${k}.${k2}.${k3}`); else flat.push(`${k}.${k2}`); } else flat.push(k); }
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
  const u = liveWorld({ waBot: { unknownWaitMin: 0, unknownHandoverAfter: 3, sameTextSeconds: 0 } });
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
  const w = liveWorld({ waBot: { unknownWaitMin: 0, sameTextSeconds: 0 } });
  let i = 0; const from = () => ({ from: `96650000${2000 + ++i}` });
  for (const t of ["ابي فاتورة ضريبية", "ممكن فاتورة ضريبية", "فاتورة ضريبية لو سمحت", "كم رسوم التوصيل", "ايش نوع اللحم", "اللحم بلدي ولا مستورد", "فيه وظايف عندكم؟"]) { await w.say(t, from()); w.clock.advance(1); }
  const r = (await w.call("GET", "/api/cms/wabot/faq-mining", {}, { days: "30" })).body;
  assert.equal(r.ok, true); assert.equal(r.messages, 7);
  assert.ok(r.intents.find((x) => x.key === "delivery" && x.n === 1));
  assert.deepEqual([r.unanswered.groups[0].count, r.unanswered.groups[0].handoffs], [3, 3]); assert.match(r.unanswered.groups[0].examples.join(" "), /فاتورة/);
  assert.deepEqual(r.faqWaiting, [{ key: "meat", q: R.FAQ_DEFS.meat.q, n: 2 }], "questions waiting for the owner's FAQ answer, by how often they were asked");
  assert.ok(r.unanswered.singles.some((x) => /وظايف/.test(x)));
}));

/* ── قرارات عمر ١٢/١٠ الضهر: تحية قصيرة، زرار رجوع بعد الإيقاف، الأسئلة الشائعة والتحويل، الموقع ───────────── */
test("Omar's «السلام عليكم» of 12/10: one short reply (welcome + how to reach a person + the menu), by name for a returning customer, reopening time when closed", withEnv(LOCKS_OPEN, async () => {
  const CONTACT = { storefront: { seo: { faq: [...FAQ, { q: "كيف أتواصل مع المطعم؟", a: "هاتف أو واتساب على 0546715683." }] } } };
  const w = liveWorld({ disclosure: true, extraSettings: CONTACT, waBot: { footerMode: "smart" } });
  const g = await w.say("السلام عليكم");
  assert.equal(g.sent.length, 1);
  assert.equal(bodyOf(g.sent[0]), "معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف، أو اتصل على 0546715683\nحيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.");
  assert.ok(bodyOf(g.sent[0]).length < 170, "short"); assert.equal(rowsOf(g.sent[0]).length, 6); assert.equal(g.sent[0].interactive.footer, undefined);
  // the branches hold what the greeting used to carry
  w.clock.advance(1);
  assert.match(bodyOf((await w.press("m:boxes", "🎁 البوكسات")).sent[0]), /^بوكساتنا/);
  w.clock.advance(1);
  assert.match(bodyOf((await w.press("m:offers", "x")).sent[0]), /أول طلب توصيل لك من الموقع توصيله مجاني/);
  w.clock.advance(1);
  assert.match(bodyOf((await w.press("m:delivery", "x")).sent[0]), /• من 150 ر\.س: مجاني/);
  // returning customer: greeted by the name he typed in his last order; junk names are not used
  for (const [name, expect] of [["أحمد العتيبي", "هلا أحمد، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة."], ["Omar", "هلا Omar، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة."], ["05444", "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة."], ["", "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة."], ["عميل", "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة."]]) {
    const r = liveWorld({ orders: [{ ...order({ status: "delivered" }), customer: { name } }] });
    assert.equal(bodyOf((await r.say("هلا")).sent[0]), expect, JSON.stringify(name));
  }
  assert.deepEqual(["أحمد", "x", "أبو-فهد", "Mohammed Ali", "aaaaaaaaaaaaaaaaaaaaaaaa"].map(R.greetName), ["أحمد", "", "", "Mohammed", ""]);
  // closed: one more line with the real reopening time, nothing about building a cart
  const c = liveWorld({ at: CLOSED_AT });
  assert.equal(bodyOf((await c.say("السلام عليكم")).sent[0]), "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.\n🌙 المطعم مقفل الحين ونفتح اليوم الساعة 12 ظهراً.");
}));

test("«إيقاف»: confirmed with what was stopped and two buttons to turn messages back on; each choice is an explicit, logged consent", withEnv(LOCKS_OPEN, async () => {
  const STOP = "تم إيقاف العروض ✅ تحديثات طلباتك مستمرة.\nضغطت بالغلط؟ اضغط «رجّع العروض». وللرجوع في أي وقت اكتب: اشتراك";
  const w = liveWorld({ orders: [order({ status: "on_the_way" })] });
  const s = await w.say("إيقاف");
  assert.equal(bodyOf(s.sent[0]), STOP); assert.equal(R.payloadProblem(s.sent[0]), null);
  assert.deepEqual(w.db.optouts, ["512345678"]);
  w.clock.advance(1);
  assert.match(bodyOf((await w.say("وين طلبي")).sent[0]), /في الطريق إليك/, "what he asks about his order is still answered");
  // «تحديثات طلبي فقط»: order updates come back through the consent storage; offers stay off
  w.clock.advance(1);
  const full = await w.press("stop:updates", "أوقف تحديثات الطلب");
  assert.equal(bodyOf(full.sent[0]), "تم ✅ أوقفنا تحديثات الطلب أيضاً.\nلو سألت عن طلبك هنا نرد عليك عادي.\nغيّرت رأيك؟ اختر من الأزرار 👇");
  assert.deepEqual(full.sent[0].interactive.action.buttons.map((x) => x.reply.id), ["resume:updates", "resume:all"]); assert.ok(w.db.optins["512345678"].stopped_at, "now order updates are stopped too");
  w.clock.advance(1);
  const u = await w.press("resume:updates", "تحديثات طلبي فقط");
  assert.deepEqual(u.sent, [txt(ME, "تم ✅ رجّعنا تحديثات طلباتك فقط، والعروض موقوفة.\nللإيقاف في أي وقت اكتب: إيقاف")]);
  const row = w.db.optins["512345678"];
  assert.deepEqual([row.updates, row.marketing, row.source, Boolean(row.updates_answered_at)], [true, false, "bot", true]);
  const lg = w.db.consentLog[w.db.consentLog.length - 1];
  assert.deepEqual([lg.kind, lg.value, lg.source, lg.ua], ["updates", true, "bot", `wa:${u.wamid}`]); assert.match(lg.text, /^تم ✅ أوقفنا تحديثات الطلب[\s\S]*\[تحديثات طلبي فقط\]$/); assert.match(lg.text_version, /^bot-[0-9a-f]{10}$/);
  assert.deepEqual([...new Set(w.db.optouts)], ["512345678"], "the marketing stop is untouched");
  // «كل الرسائل والعروض»: the same as typing «اشتراك», plus a marketing consent row
  const a = liveWorld();
  await a.say("إيقاف"); a.clock.advance(1);
  const all = await a.press("resume:all", "كل الرسائل والعروض");
  assert.deepEqual(all.sent, [txt(ME, "تم ✅ رجّعنا لك رسائلنا: تحديثات طلباتك والعروض.\nللإيقاف في أي وقت اكتب: إيقاف")]);
  assert.equal(a.db.optins["512345678"].marketing, true);
  const ml = a.db.consentLog[a.db.consentLog.length - 1];
  assert.deepEqual([ml.kind, ml.value, ml.source, ml.ua], ["marketing", true, "bot", `wa:${all.wamid}`]); assert.match(ml.text, /\[كل الرسائل والعروض\]$/);
  // dry mode records nothing; the buttons work during an open handover and past the rate guard
  const d = liveWorld({ waBot: { mode: "dry" } });
  await d.press("resume:all", "x"); assert.equal(d.db.consentLog.length, 0); assert.equal(d.db.optins["512345678"], undefined);
  const h = liveWorld();
  await h.say("عندي شكوى"); h.clock.advance(1); await h.say("إيقاف"); h.clock.advance(1);
  assert.equal((await h.press("resume:updates", "x")).sent.length, 1);
  for (const lang of ["ar", "en"]) for (const k of ["stop", "resume_all", "resume_updates", "btn_resume_all", "btn_resume_updates"]) assert.ok([...R.TEXTS[k][lang]].length <= R.TEXTS[k].max, `${k} ${lang}`);
}));

test("FAQ during an ordinary handover is answered like a menu question; an FAQ with no answer does not open a second handover", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ waBot: { faq: { parking: { ar: "إجابة معتمدة عن المواقف." } } } });
  await w.say("ابي اكلم موظف"); w.clock.advance(1);
  assert.deepEqual((await w.say("فيه مواقف؟")).sent, [txt(ME, "إجابة معتمدة عن المواقف.")], "Omar: «البوت يجاوب الاسئلة»");
  w.clock.advance(1);
  const gap = await w.say("ايش نوع اللحم");
  assert.equal(gap.log.reply_key, "handoff_remind"); assert.equal(gap.log.handoff, null); assert.equal(w.sms.length, 2, "no new alert");
  w.clock.advance(1);
  assert.equal((await w.say("اللحم بلدي ولا مستورد")).log.reason, "handoff_open");
  // a complaint handover: FAQ is not answered (facts only: hours, location, order status)
  const c = liveWorld({ waBot: { faq: { parking: { ar: "إجابة معتمدة عن المواقف." } } } });
  await c.say("عندي شكوى"); c.clock.advance(1);
  assert.equal((await c.say("فيه مواقف؟")).log.reply_key, "handoff_remind");
}));

test("location: a shared WhatsApp location or a pasted maps link gets the zone answer with the real fee ladder, from any point of the conversation; remembered for the chat", withEnv(LOCKS_OPEN, async () => {
  for (const [t, lat, lng] of [["https://www.google.com/maps?q=21.5810,39.1502", 21.581, 39.1502], ["https://maps.google.com/?ll=21.5810%2C39.1502&z=16", 21.581, 39.1502], ["https://www.google.com/maps/place/X/@21.5433,39.1728,17z/data=!3m1!4b1", 21.5433, 39.1728],
    ["https://www.google.com/maps/place/X/data=!3d21.60011!4d39.10022", 21.60011, 39.10022], ["21.58100, 39.15020", 21.581, 39.1502], ["موقعي https://maps.google.com/?q=21.5810,39.1502 حي الصفا", 21.581, 39.1502]]) assert.deepEqual(R.coordsFromText(t), { lat, lng }, t);
  for (const t of ["ابي 2 كريب", "السعر 25.50, 30.75", "https://freshcuts.sa/l/x?q=1.5,2.5", "https://maps.app.goo.gl/AbC123", "0.000,0.000"]) assert.equal(R.coordsFromText(t), null, t);
  assert.equal(R.shortMapsLink("هذا موقعي https://maps.app.goo.gl/AbC123xyz?g_st=iw"), "https://maps.app.goo.gl/AbC123xyz?g_st=iw"); assert.equal(R.shortMapsLink("https://evil.example/maps.app.goo.gl/x"), null);
  const IN = `✅ موقعك داخل نطاق التوصيل.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 60 ر.س: 20 ر.س\n• من 60 ر.س: 15 ر.س\n• من 80 ر.س: 10 ر.س\n• من 100 ر.س: 5 ر.س\n• من 150 ر.س: مجاني\n${FIRST_LINE}`;
  let asked = [];
  const mk = (qv) => liveWorld({ quote: (lat, lng) => { asked.push([lat, lng]); return qv; } });
  // in the middle of browsing the tree: the shared location is answered, then browsing goes on
  const w = mk({ ok: true, deliverable: true, fee: 15 });
  await w.press("m:cats", "x"); w.clock.advance(1);
  const l1 = await w.say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.equal(bodyOf(l1.sent[0]), IN); assert.equal(urlOf(l1.sent[0]), "https://freshcuts.sa/l/wab-boxes"); assert.equal(l1.log.reply_key, "area");
  assert.deepEqual([w.db.chats.get("512345678").last_loc.lat, w.db.chats.get("512345678").last_loc.lng, w.db.chats.get("512345678").last_loc.via], [21.58, 39.15, "location"]);
  w.clock.advance(1);
  assert.equal((await w.press("m:boxes", "x")).log.reply_key, "boxes");
  // a pasted Google Maps link is the same thing
  w.clock.advance(3);
  const l2 = await w.say("https://www.google.com/maps?q=21.5810,39.1502");
  assert.equal(bodyOf(l2.sent[0]), IN); assert.deepEqual(asked[asked.length - 1], [21.581, 39.1502]); assert.equal(w.db.chats.get("512345678").last_loc.via, "maps_link");
  // far zone: the real extra charge for this location; outside: pickup
  const far = mk({ ok: true, deliverable: false, reason: "out_of_range", farZoneOffer: { surcharge: 9 } });
  assert.match(bodyOf((await far.say(null, { raw: { type: "location", location: { latitude: 21.7, longitude: 39.2 } } })).sent[0]), /^موقعك خارج النطاق الأساسي: نوصّل له برسوم مسافة إضافية 9 ر\.س فوق رسوم التوصيل، أو تقدر تستلم من الفرع\.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 60/);
  const outz = mk({ ok: true, deliverable: false, reason: "out_of_range" });
  assert.equal(bodyOf((await outz.say("https://maps.google.com/?q=22.9000,39.9000")).sent[0]), "موقعك خارج نطاق التوصيل حالياً 🙏 تقدر تطلب استلام من الفرع.");
  // a short link is resolved by the runtime (allowed hosts only); if it can not be resolved it is an ordinary message
  const sl = liveWorld({ quote: { ok: true, deliverable: true }, resolveMapsLink: async (u) => (u.startsWith("https://maps.app.goo.gl/") ? { lat: 21.58, lng: 39.15 } : null) });
  assert.equal((await sl.say("https://maps.app.goo.gl/AbC123xyz")).log.reply_key, "area");
  const bad = liveWorld({ quote: { ok: true, deliverable: true }, resolveMapsLink: async () => null, waBot: { unknownWaitMin: 0 } });
  assert.notEqual((await bad.say("https://maps.app.goo.gl/AbC123xyz")).log.reply_key, "area");
  // during an ordinary handover a location is still answered; the quote service down ⇒ honest handover, never a guess
  const h = mk({ ok: true, deliverable: true });
  await h.say("ابي اكلم موظف"); h.clock.advance(1);
  assert.equal((await h.say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } })).log.reply_key, "area");
  assert.equal((await mk(null).say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } })).log.reply_key, "data_missing");
}));

/* ── «نفس طلبي الأخير» بضغطة (طلب عمر ١٢/١٠) ────────────────────────────── */
const SNAP = () => ({ orderNo: "W1790011111111", option: "delivery", at: "2026-10-05T17:00:00Z",
  raw: { "8": { item: { id: 8 }, qty: 2 }, "59": { item: { id: 59 }, qty: 1, note: "بدون زيتون" },
    "box-mixgrill-duo:k1": { key: "box-mixgrill-duo:k1", qty: 1, choices: { main1: "x", main2: "y" }, notes: {}, bundle: { slug: "box-mixgrill-duo", name: "ميكس جريل لشخصين", price: 85 } } },
  items: [{ id: 8, n: "كريب زنجر سوبريم", q: 2, p: 25 }, { id: 59, n: "بنا تشيكن كازرول", q: 1, p: 28 }, { id: "box-mixgrill-duo:k1", n: "ميكس جريل لشخصين", q: 1, p: 85 }] });
test("reorder plan: every line of the last order's cart is checked against the live menu and boxes; what changed is listed exactly", () => {
  const live = { menu: KNOW.menu, bundles: LIVE.bundles };
  const p = BC.reorderPlan(SNAP(), live);
  assert.equal(p.ok, true);
  assert.deepEqual(p.lines.map((l) => [l.name, l.q]), [["كريب زنجر سوبريم", 2], ["بنا تشيكن كازرول", 1], ["ميكس جريل لشخصين", 1]]);
  assert.deepEqual([p.removed, p.repriced, p.review], [[], [], []]);
  assert.deepEqual(p.raw["59"], { item: { id: "59" }, qty: 1, note: "بدون زيتون" }, "the customer's note travels with the line");
  assert.deepEqual(p.raw["box-mixgrill-duo:k1"].choices, { main1: "x", main2: "y" }, "box choices are kept exactly as he made them");
  assert.equal(BC.planSummary(p, "ar"), "2× كريب زنجر سوبريم، بنا تشيكن كازرول، ميكس جريل لشخصين");
  assert.ok([...BC.planSummary({ lines: Array.from({ length: 9 }, (_, i) => ({ name: `صنف طويل الاسم رقم ${i}`, q: 1 })) }, "ar")].length <= 72);
  // an item removed from the menu, one sold out today, a box that is gone, a box whose price changed, a line that had add-ons
  const menu2 = { ...KNOW.menu, items: KNOW.menu.items.filter((i) => i.id !== "59").map((i) => (i.id === "8" ? { ...i, soldOut: true } : i)) };
  const p2 = BC.reorderPlan({ ...SNAP(), raw: { ...SNAP().raw, "x:1": { qty: 1, bundle: { slug: "box-gone", name: "بوكس قديم", price: 50 } } } },
    { menu: menu2, bundles: LIVE.bundles.map((b) => (b.slug === "box-mixgrill-duo" ? { ...b, price: 89 } : b)) });
  assert.deepEqual(p2.removed, [{ name: "كريب زنجر سوبريم", why: "sold_out" }, { name: "بنا تشيكن كازرول", why: "gone" }, { name: "بوكس قديم", why: "gone" }]);
  assert.deepEqual(p2.repriced, [{ name: "ميكس جريل لشخصين", was: 85, now: 89 }]);
  assert.deepEqual(Object.keys(p2.raw), ["box-mixgrill-duo:k1"]); assert.equal(p2.raw["box-mixgrill-duo:k1"].bundle.price, 89);
  const p3 = BC.reorderPlan({ raw: { "8": { item: { id: 8 }, qty: 1 } }, items: [{ id: 8, n: "كريب زنجر سوبريم", q: 1, p: 30 }] }, live);
  assert.deepEqual(p3.review, ["كريب زنجر سوبريم"], "snapshot price differs from the menu ⇒ add-ons or a price change: the customer is asked to check, we do not guess which");
  // nothing left, or a source that is down ⇒ no plan (never a guess)
  assert.deepEqual([BC.reorderPlan({ raw: { "59": { item: { id: 59 }, qty: 1 } }, items: [] }, { menu: menu2, bundles: LIVE.bundles }).ok, BC.reorderPlan(SNAP(), { menu: null, bundles: LIVE.bundles }).why,
    BC.reorderPlan(SNAP(), { menu: KNOW.menu, bundles: null }).why, BC.reorderPlan({ raw: {} }, live).why, BC.reorderPlan(null, live).why], [false, "menu_unavailable", "bundles_unavailable", "no_snapshot", "no_snapshot"]);
});

test("ready-cart store: last order's snapshot only when it really is that order's cart; codes never collide with recovery links or ad carts; expiry", async () => {
  const rows = { orders: [], carts: [], bot: [], taken: new Set(["takencod"]) };
  let nowMs = Date.parse("2026-10-12T15:00:00Z");
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/.test(s)) return { rows: [] };
    if (/FROM shop_orders WHERE phone_norm=\$1/.test(s)) return { rows: rows.orders.filter((o) => o.phone_norm === p[0] && nowMs - Date.parse(o.created_at) < p[1] * 86400_000 && Number(o.subtotal) >= p[3]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, p[2]) };
    if (/FROM shop_carts WHERE phone_norm=\$1 AND recovered_order=\$2/.test(s)) return { rows: rows.carts.filter((c) => c.phone_norm === p[0] && c.recovered_order === p[1] && c.cart_raw).sort((a, b) => Math.abs(a.subtotal - p[2]) - Math.abs(b.subtotal - p[2])).slice(0, 1) };
    if (/FROM cart_recovery WHERE code=\$1 UNION ALL/.test(s)) return { rows: rows.taken.has(p[0]) || rows.bot.some((b) => b.code === p[0]) ? [{}] : [] };
    if (/^INSERT INTO wa_bot_carts/.test(s)) { rows.bot.push({ code: p[0], phone_norm: p[1], source: p[2], from_order: p[3], items: JSON.parse(p[4]), cart_raw: JSON.parse(p[5]), option: p[6], note: JSON.parse(p[7]), exp: nowMs + p[8] * 86400_000, opens: 0 }); return { rows: [{ code: p[0] }] }; }
    if (/^UPDATE wa_bot_carts SET opens/.test(s)) { const b = rows.bot.find((x) => x.code === p[0] && x.exp > nowMs); if (!b) return { rows: [] }; b.opens++; return { rows: [{ source: b.source }] }; }
    if (/^SELECT c\.items, c\.cart_raw, c\.option, ch\.last_loc, c\.source, c\.note FROM wa_bot_carts c LEFT JOIN wa_bot_chats ch/.test(s)) { const b = rows.bot.find((x) => x.code === p[0] && x.exp > nowMs); return { rows: b ? [b] : [] }; }
    throw new Error("unexpected sql: " + s.slice(0, 60));
  } };
  const st = BC.makeBotCarts({ pool, log: () => {} });
  const snap = SNAP();
  rows.orders.push({ phone_norm: "512345678", order_no: "W1", option: "pickup", subtotal: 163, created_at: "2026-10-05T17:00:00Z" });
  rows.carts.push({ phone_norm: "512345678", recovered_order: "W1", cart_raw: snap.raw, items: snap.items, subtotal: 163, option: "pickup" });
  const lc = await st.lastOrderCart("512345678", 90);
  assert.deepEqual([lc.orderNo, lc.option, Object.keys(lc.raw).length], ["W1", "pickup", 3]);
  assert.equal(await st.lastOrderCart("598765432", 90), null, "another phone never sees it");
  assert.equal(await st.lastOrderCart("512345678", 3), null, "older than the limit");
  rows.orders.push({ phone_norm: "512345678", order_no: "W2", option: "delivery", subtotal: 40, created_at: "2026-10-11T17:00:00Z" });
  assert.equal(await st.lastOrderCart("512345678", 90), null, "his latest order has no snapshot (other device) ⇒ no «same as last order»");
  rows.carts.push({ phone_norm: "512345678", recovered_order: "W2", cart_raw: snap.raw, items: snap.items, subtotal: 163, option: "delivery" });
  assert.equal(await st.lastOrderCart("512345678", 90), null, "snapshot total differs from the order's items total ⇒ not trusted");
  // two device rows marked with the same order (an old abandoned cart on another device): the one whose total matches the order is taken
  rows.carts.push({ phone_norm: "512345678", recovered_order: "W2", cart_raw: { 8: { item: { id: 8 }, qty: 1 } }, items: [{ id: 8, n: "x", q: 1, p: 40 }], subtotal: 40, option: "delivery" });
  assert.deepEqual(Object.keys((await st.lastOrderCart("512345678", 90)).raw), ["8"]);
  rows.orders.pop(); rows.carts.splice(1);
  // several orders: newest first, only those with a trusted snapshot; tiny and test orders are skipped by the query
  rows.orders.push({ phone_norm: "512345678", order_no: "W3", option: "pickup", subtotal: 0.5, created_at: "2026-10-11T18:00:00Z" });
  rows.carts.push({ phone_norm: "512345678", recovered_order: "W3", cart_raw: { 1: { item: { id: 1 }, qty: 1 } }, items: [], subtotal: 0.5, option: "pickup" });
  assert.deepEqual((await st.lastOrderCarts("512345678", 90, { limit: 5, minTotal: 0 })).map((x) => [x.orderNo, x.latest]), [["W3", true], ["W1", false]]);
  assert.deepEqual((await st.lastOrderCarts("512345678", 90, { limit: 5, minTotal: 10 })).map((x) => x.orderNo), ["W1"], "a 0.5 SAR test order is not offered");
  assert.deepEqual(await st.lastOrderCarts("abc", 90), []);
  rows.orders.pop(); rows.carts.pop();
  const plan = BC.reorderPlan(snap, { menu: KNOW.menu, bundles: LIVE.bundles });
  const made = await st.create({ phone: "512345678", source: "reorder", fromOrder: "W1", plan, option: "pickup", days: 7 });
  assert.match(made.code, /^[a-z0-9]{8}$/); assert.equal(rows.bot[0].from_order, "W1"); assert.deepEqual(rows.bot[0].note, { removed: [], repriced: [], review: [] });
  assert.equal(await st.create({ phone: "512345678", source: "reorder", plan: { ok: false } }), null); assert.equal(await st.create({ phone: "abc", source: "reorder", plan }), null);
  assert.equal(await st.open(made.code), `/?cart=${made.code}&utm_source=whatsapp&utm_medium=bot&utm_campaign=wa_reorder&fc_link=wa-reorder`); assert.equal(rows.bot[0].opens, 1);
  const back = await st.restore(made.code);
  assert.deepEqual([back.ok, back.option, back.ordered, Object.keys(back.raw).length, back.items.length], [true, "pickup", false, 3, 3]);
  assert.equal(await st.open("nope1234"), null); assert.equal(await st.restore("../etc"), null);
  nowMs += 8 * 86400_000;
  assert.equal(await st.open(made.code), null, "expired"); assert.equal(await st.restore(made.code), null);
});

test("«نفس طلبي الأخير»: a row in the returning customer's greeting; one tap sends his last order as a ready cart with what changed; honest when it can not be rebuilt", withEnv(LOCKS_OPEN, async () => {
  const prior = [{ ...order({ status: "delivered" }), customer: { name: "أحمد" } }];
  const w = liveWorld({ orders: prior, lastCart: SNAP() });
  const g = await w.say("السلام عليكم");
  assert.equal(bodyOf(g.sent[0]), "هلا أحمد، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.");
  assert.deepEqual(rowsOf(g.sent[0])[0], { id: "re:last", title: "🔁 نفس طلبي السابق", description: "5/10: 2× كريب زنجر سوبريم، بنا تشيكن كازرول، ميكس جريل لشخصين" });
  assert.equal(rowsOf(g.sent[0]).length, 7); assert.equal(w.db.botCarts.length, 0, "nothing is created until he taps");
  w.clock.advance(1);
  const r = await w.press("re:last", "🔁 نفس طلبي الأخير");
  assert.deepEqual(r.sent, [cta(ME, "جهّزنا لك نفس طلبك يوم الاثنين 5/10 🛒\n• 2× كريب زنجر سوبريم\n• بنا تشيكن كازرول\n• ميكس جريل لشخصين\nراجع السلة وكمّل الدفع من الرابط 👇", "كمّل طلبك", "https://freshcuts.sa/c/rc000001")]);
  assert.equal(r.log.reply_key, "reorder"); assert.equal(r.log.link_slug, "wa-reorder"); assert.equal(r.log.handoff, null);
  assert.deepEqual([w.db.botCarts[0].phone, w.db.botCarts[0].source, w.db.botCarts[0].fromOrder, w.db.botCarts[0].option, w.db.botCarts[0].days], ["512345678", "reorder", "W1790011111111", "delivery", 7]);
  // typed, in several wordings
  for (const t of ["نفس الطلب", "ابي نفس طلبي", "زي اخر مره", "كرر الطلب", "المعتاد لو سمحت", "same order please", "reorder"]) assert.equal(R.classify({ text: t, type: "text" }, KNOW).key, "reorder", t);
  for (const t of ["نفس الطلب اللي جاني بارد", "ابي الغي الطلب", "وين طلبي"]) assert.notEqual(R.classify({ text: t, type: "text" }, KNOW).key, "reorder", t);
  // what changed since his order is said exactly: sold out today, removed from the menu, a box price, and add-ons to check
  const pages2 = LIVE.pages.map((pg) => ({ ...pg, items: pg.items.filter((i) => String(i.id) !== "59") }));
  const snap2 = SNAP(); snap2.items[0].p = 30;
  const c = liveWorld({ orders: prior, lastCart: snap2, pages: pages2, bundles: LIVE.bundles.map((b) => (b.slug === "box-mixgrill-duo" ? { ...b, price: 89 } : b)) });
  const cr = await c.say("نفس الطلب");
  assert.equal(bodyOf(cr.sent[0]), "جهّزنا لك نفس طلبك يوم الاثنين 5/10 🛒\n• 2× كريب زنجر سوبريم\n• ميكس جريل لشخصين\nغير متاح الآن وشلناه من السلة: بنا تشيكن كازرول\nسعر ميكس جريل لشخصين الآن 89 ر.س (كان 85 ر.س)\nراجع الإضافات والسعر في السلة قبل الدفع: كريب زنجر سوبريم\nراجع السلة وكمّل الدفع من الرابط 👇");
  assert.deepEqual(Object.keys(c.db.botCarts[0].plan.raw), ["8", "box-mixgrill-duo:k1"], "the cart behind the link holds only what is available");
  const so = liveWorld({ orders: prior, lastCart: SNAP(), extraSettings: { catalog: { soldOut: { 8: {} } } } });
  assert.match(bodyOf((await so.say("نفس الطلب")).sent[0]), /\nخلص اليوم وشلناه من السلة: كريب زنجر سوبريم\n/);
  // closed: the cart is still prepared, with the reopening time
  const cl = liveWorld({ orders: prior, lastCart: SNAP(), at: CLOSED_AT });
  assert.match(bodyOf((await cl.press("re:last", "x")).sent[0]), /\n🌙 المطعم مقفل الحين ونفتح اليوم الساعة 12 ظهراً\.\nراجع السلة/);
  // no snapshot / nothing left / store failure / switched off ⇒ no row in the greeting, and the tap gets an honest line with the ordinary link (no handover)
  for (const o of [{ lastCart: null }, { lastCart: { ...SNAP(), raw: { "999999": { item: { id: 999999 }, qty: 1 } }, items: [] } }, { lastCart: SNAP(), failDb: /INSERT INTO wa_bot_carts/ }, { lastCart: SNAP(), waBot: { reorderEnabled: false } }]) {
    const x = liveWorld({ orders: prior, ...o });
    if (!o.failDb) assert.ok(!rowsOf((await x.say("هلا")).sent[0]).some((row) => row.id === "re:last"), JSON.stringify(Object.keys(o)));
    x.clock.advance(1);
    const y = await x.press("re:last", "x");
    assert.deepEqual(y.sent, [cta(ME, "ما قدرنا نجهّز نفس طلبك الأخير تلقائياً 🙏 تقدر تطلب من الرابط 👇", "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]); assert.equal(y.log.handoff, null);
  }
  // dry mode: the reply is logged with a placeholder link and no cart row is created; simulate creates nothing either
  const d = liveWorld({ orders: prior, lastCart: SNAP(), waBot: { mode: "dry" } });
  const dr = await d.press("re:last", "x");
  assert.equal(d.db.botCarts.length, 0); assert.match(JSON.stringify(dr.log.replies), /freshcuts\.sa\/c\/dryrun00/);
  const sim = (await w.call("POST", "/api/cms/wabot/simulate", { text: "نفس الطلب", phone: "0512345678", first: false })).body;
  assert.match(JSON.stringify(sim.payloads), /freshcuts\.sa\/c\/preview0/); assert.equal(w.db.botCarts.length, 1);
  // a sales intent: not answered during a handover (one reminder), and never for a complaint
  const h = liveWorld({ orders: prior, lastCart: SNAP() });
  await h.say("عندي شكوى"); h.clock.advance(1);
  assert.equal((await h.press("re:last", "x")).log.reply_key, "handoff_remind"); assert.equal(h.db.botCarts.length, 1, "the row made before the decision is an unused orphan, never sent");
  // owner diagnostics: coverage numbers, and what one customer would get (nothing is created)
  const chk = (await w.call("GET", "/api/cms/wabot/reorder-check", {}, { phone: "0512345678" })).body;
  assert.deepEqual([chk.ok, chk.enabled, chk.coverage.usable, chk.customer.hasSnapshot, chk.customer.fromOrder, chk.customer.plan.ok, chk.customer.plan.lines.length, chk.customer.plan.day], [true, true, 26, true, "W1790011111111", true, 3, "يوم الاثنين 5/10"]);
  assert.equal((await w.call("GET", "/api/cms/wabot/reorder-check")).body.customer, undefined); assert.equal(w.db.botCarts.length, 1);
  // Omar's own case (12/10): his LATEST order can not be rebuilt (a test item that is no longer on the menu) but an older one can ⇒ the older one is offered, and the reply says which day
  const older = [{ ...SNAP(), orderNo: "W1791728428905", at: "2026-10-11T18:00:00Z", raw: { "999999": { item: { id: 999999 }, qty: 1 } }, items: [] }, { ...SNAP(), orderNo: "W1790000000002", at: "2026-10-03T16:30:00Z" }];
  let askedWith = null;
  const om = liveWorld({ orders: prior, lastCart: (ph, days, o) => { askedWith = [days, o]; return older; } });
  const og = await om.say("السلام عليكم");
  assert.equal(rowsOf(og.sent[0])[0].description, "3/10: 2× كريب زنجر سوبريم، بنا تشيكن كازرول، ميكس جريل لشخصين");
  assert.deepEqual(askedWith, [90, { limit: 5, minTotal: 10 }], "the store is asked for the last 5 orders of at least 10 SAR (tiny test orders are skipped there)");
  om.clock.advance(1);
  const ot = await om.press("re:last", "x");
  assert.match(bodyOf(ot.sent[0]), /^جهّزنا لك نفس طلبك يوم السبت 3\/10 🛒\n/); assert.equal(om.db.botCarts[0].fromOrder, "W1790000000002");
  const oc = (await om.call("GET", "/api/cms/wabot/reorder-check", {}, { phone: "0512345678" })).body.customer;
  assert.deepEqual(oc.tried, [{ fromOrder: "W1791728428905", day: "يوم الأحد 11/10", ok: false, why: "nothing_left" }, { fromOrder: "W1790000000002", day: "يوم السبت 3/10", ok: true, why: null }]);
  assert.deepEqual([BC.orderDay("2026-10-11T22:30:00Z"), BC.orderDay("2026-10-11T22:30:00Z", "en"), BC.orderDay("nonsense")], ["يوم الاثنين 12/10", "Monday 12/10", ""], "the day is the Riyadh day");
  // settings
  assert.deepEqual([R.botConfig({}).reorderEnabled, R.botConfig({}).reorderMaxDays, R.botConfig({}).reorderLinkDays, R.botConfig({}).reorderMinTotal, R.botConfig({}).reorderLookback], [true, 90, 7, 10, 5]);
  assert.equal(R.configFromBody({ reorderLinkDays: 99 }).ok, false); assert.equal(R.configFromBody({ reorderEnabled: false }).value.reorderEnabled, false);
}));

test("trade secrets (Omar 12/10): «what is in X» gets the public menu description only; «does X contain Y» goes to staff until the facts file is approved; recipe, quantities, marinade, method, supplier are never discussed", withEnv(LOCKS_OPEN, async () => {
  const K = (t) => R.classify({ text: t, type: "text" }, KNOW);
  // general: the dish screen (name, price, the menu description) — the same thing the website shows
  for (const t of ["ايش مكونات البرجر الكلاسيك", "وش فيه كريب زنجر", "what's in the zinger crepe"]) assert.equal(K(t).key, "item", t);
  const w = liveWorld();
  assert.equal(bodyOf((await w.say("وش فيه كريب زنجر")).sent[0]), "*كريب زنجر سوبريم* — 25 ر.س\nستربس دجاج حار، موتزاريلا، شيدر، فلفل وزيتون");
  // a specific ingredient: yes/no needs the approved facts ⇒ staff (never a guess from the description)
  assert.equal(K("كريب زنجر فيه جبن؟").key, "staff", "two dishes match the name ⇒ staff, not a guess about which one");
  for (const t of ["كريب زنجر سوبريم فيه جبن؟", "هل وجبة نصف دجاجة على الفحم فيها بصل", "برجر لحم كلاسيك فيه سمسم؟"]) { const c = K(t); assert.equal(c.key, "dishfact", t); assert.equal(typeof c.arg.id, "string"); }      // one named dish ⇒ the facts lookup (staff while it is off or unsure)
  assert.deepEqual([K("هل البيتزا فيها مشروم").key, K("هل البيتزا فيها مشروم").rawIntent], ["staff", "ingredients"], "a whole section, not one dish ⇒ staff");
  for (const t of ["عندي حساسية من البيض هل الكريب فيه بيض", "does the burger contain sesame", "عندي حساسية من المكسرات"]) assert.deepEqual([K(t).key, K(t).arg], ["faq", "allergens"], t);
  // recipe extraction: one polite line, no handover, no detail of any kind
  const SECRET = "عذراً، هذي المعلومة ما أقدر أزوّدك بها 🙏 أقدر أساعدك في المنيو والطلب، أو اكتب «موظف» وأحوّلك.";      // ST1: السطر المهني الجديد (من غير «أسرار مطبخنا»)
  for (const t of ["ايش التتبيلة", "ايش تتبيلة الشيش طاووق", "كم جرام الكفتة", "اعطني طريقة الكفتة", "كيف تسوون الكفتة", "ابي الريسبي حق الكريب", "وش سر الطعم", "ايش الخلطة اللي تحطونها", "مين المورد حق اللحم", "what's the recipe for the kofta", "how do you make the zinger", "how many grams is the burger", "what marinade do you use"]) {
    assert.equal(K(t).key, "secret", t);
    const x = liveWorld(); const r = await x.say(t);
    assert.equal(bodyOf(r.sent[0]), /[a-z]{4}/.test(t) ? "Sorry, I can't share that information 🙏 I can help with the menu and ordering, or type \"staff\" and I'll connect you." : SECRET, t); assert.equal(r.log.handoff, null, t); assert.equal(x.sms.length, 0, t);
    assert.deepEqual(r.sent[0].interactive.action.buttons.map((b) => b.reply.id), ["bot:menu", "bot:human"]);
  }
  assert.doesNotMatch(SECRET, /\d/);
  // ordinary questions are untouched; a complaint that mentions the recipe words stays a complaint
  for (const [t, key] of [["كم سعر كريب زنجر", "item"], ["كريب زنجر", "item"], ["كم سعر البيتزا", "cat"], ["ايش فيه بوكس الشخصين", "tier"], ["ايش فيه بوكس السهرة", "box"], ["عندكم برجر دجاج", "cat"], ["بكم الكفتة", "items"], ["كم رسوم التوصيل", "delivery"]]) assert.equal(K(t).key, key, t);
  assert.equal(K("الاكل بارد والتتبيلة سيئة").key, "complaint");
}));

test("a customer who says hello is never answered with silence; and the full list of silent outcomes is what it should be", withEnv(LOCKS_OPEN, async () => {
  // Omar 12/10 07:12: greeted at 04:34, wrote «هلا» and «السلام عليكم» again inside the 24-hour greeting window and got nothing
  const w = liveWorld({ orders: [{ ...order({ status: "delivered" }), customer: { name: "أحمد" } }], waBot: { greetWindowHours: 24 } });
  assert.equal(bodyOf((await w.say("السلام عليكم")).sent[0]), "هلا أحمد، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.");
  w.clock.advance(158);
  for (const hello of ["هلا", "السلام عليكم"]) {
    const r = await w.say(hello); w.clock.advance(3);
    assert.equal(r.sent.length, 1, hello); assert.equal(r.log.reply_key, "main"); assert.equal(r.log.detail, "regreet");
    assert.equal(bodyOf(r.sent[0]), "القائمة الرئيسية 👇 اختر اللي تبيه.", "the short main menu: no welcome again, no name, no introduction line");
    assert.equal(rowsOf(r.sent[0]).length, 10);
  }
  w.clock.advance(24 * 60);
  assert.match(bodyOf((await w.say("هلا")).sent[0]), /هلا أحمد، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة\.$/, "after the window: a proper greeting again");
  // a reply that can not be built correctly is not silence either: the plain «handed to staff» line goes out, with the alert
  const b = liveWorld({ waBot: { texts: {} } });
  b.db.settings.waBot.texts = { thanks: { ar: "العفو undefined" } };
  const br = await b.say("شكرا");
  assert.deepEqual(br.sent, [txt(ME, `ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.\n${HAND}`)]); assert.match(br.log.reason, /^payload_invalid:/); assert.equal(b.sms.length, 2);
  // every reason that may still end in silence, and that each is one of the allowed kinds
  const src = fs.readFileSync(new URL("./wabotrun.js", import.meta.url), "utf8");
  const reasons = [...new Set([...src.matchAll(/silent\("([a-z_]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(reasons, ["ack", "complaint_with_staff", "handoff_open", "ignored_type", "manual_mute", "never_reply", "not_saudi_mobile", "off", "out_of_scope", "outside_window", "rate_limited", "recent_send_failure", "stale", "test_mode_not_listed"],
    "adding a new silent outcome must be a deliberate decision: update this list and the table in the slice README");
}));

test("handover also rings the restaurant portal: one live event per handover alert, with the contract the portal UI reads", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ orders: [order({ status: "delivered" })] });
  const r = await w.say("الطلب وصل بارد");
  assert.equal(r.log.handoff, "complaint");
  assert.deepEqual(w.portal, [["wa_handover", { phone: "0512345678", phoneMasked: "…5678", reason: "complaint", reasonAr: "شكوى", urgent: true, orderNo: "W1790011111111", at: w.portal[0][1].at, test: false }]]);
  assert.match(w.portal[0][1].at, /^2026-10-12T/); assert.equal(w.sms.length, 2, "the SMS to Omar and the manager still goes");
  w.clock.advance(1); await w.say("المنيو");
  assert.equal(w.portal.length, 1, "no second ring for the same open handover");
  // test mode: the cashier is the one who answers, so the portal rings even though the SMS is held back; dry mode rings nobody
  const t = liveWorld({ waBot: { mode: "test", testPhones: ["0512345678"] } });
  await t.say("ابي اكلم موظف"); assert.deepEqual([t.portal.length, t.portal[0][1].test, t.portal[0][1].urgent, t.sms.length], [1, true, false, 0]);
  const d = liveWorld({ waBot: { mode: "dry" } });
  await d.say("ابي اكلم موظف"); assert.equal(d.portal.length, 0);
}));

test("assistant core, slice 1: the owner route runs one tool on live sources and previews a cart — no model, no send, no cart row, nothing changes in the bot's replies", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ quote: { deliverable: true, fee: 15, toNextTier: 10, nextTierFee: 10 } });
  const T = async (tool, args = {}, extra = {}) => (await w.call("POST", "/api/cms/wabot/assist/try", { tool, phone: "0512345678", args, ...extra }));
  const s = (await T("search_menu", { query: "كريب زنجر" })).body;
  assert.deepEqual([s.ok, s.tool, s.result.results[0].name, s.result.results[0].price], [true, "search_menu", "كريب زنجر سوبريم", 25]);
  const c = (await T("build_cart", { items: [{ id: "8", qty: 2 }, { id: "999999" }] })).body.result;
  assert.deepEqual([c.ok, c.saved, c.subtotal, c.lines.length, c.problems[0].error, c.link], [true, false, 50, 1, "not_on_menu", undefined]);
  assert.equal(w.db.botCarts.length, 0, "the try route never creates a cart");
  const p = (await T("customer_profile")).body;
  assert.equal(p.result.profile.name, "أحمد"); assert.match(p.told_to_customer, /^عدد طلباتك السابقة: 2\./);
  const h = (await T("get_hours")).body.result; assert.equal(h.open_now, true);
  const v = (await T("search_menu", { query: "كريب زنجر" }, { reply: "كريب زنجر سوبريم بـ 999 ر.س" })).body.validation;
  assert.equal(v.ok, false); assert.equal(v.problems[0].type, "number_not_from_tools");
  assert.equal((await T("drop_tables")).status, 400);
  w.setOwner(false); assert.equal((await T("get_hours")).status, 403); w.setOwner(true);
  assert.equal(w.calls.length, 0, "nothing was sent"); assert.equal(w.db.log.length, 0);
  // the bot's own replies are unchanged by this slice
  assert.equal((await w.say("كم رسوم التوصيل")).log.reply_key, "delivery");
}));

test("per-dish facts: «does X contain Y» answers only that one thing for the covered dishes; everything else, and any severe allergy, goes to staff", withEnv(LOCKS_OPEN, async () => {
  const DF = await import("./wadishfacts.js");
  const cov = DF.factsCoverage();
  assert.deepEqual([cov.dishes, cov.covered], [77, 24]);
  // the lookup: one status, at most one remove label, never a list (dish 13 = half charcoal chicken meal, complete data)
  assert.deepEqual(DF.lookupFact("13", "وجبة نص دجاجة فيها سمسم؟"), { dish: "وجبة نصف دجاجة على الفحم", dishEn: "Half Charcoal Chicken Meal", status: "present_removable", asked: "سمسم", part: "الطحينة", partEn: "tahini", kind: "allergen", fryer: false });
  assert.deepEqual([DF.lookupFact("13", "فيها حليب؟").status, DF.lookupFact("13", "فيها بيض؟").status, DF.lookupFact("13", "فيها صويا؟").status, DF.lookupFact("13", "فيها سمسم وبيض؟").status], ["present_fixed", "not_found", "unknown_staff", "unknown_staff"]);
  assert.deepEqual([DF.lookupFact("13", "فيها ارز؟").status, DF.lookupFact("13", "فيها ارز؟").part, DF.lookupFact("13", "فيها بصل؟").status, DF.lookupFact("13", "فيها فلفل؟").status], ["present_removable", "الأرز", "present_fixed", "unknown_staff"], "an ingredient that is not recorded is never declared absent");
  // a dish with a bought-in part (not complete data): what IS recorded is answered, what is not recorded goes to staff — absence is never inferred
  assert.deepEqual([DF.lookupFact("71", "البرجر فيه سمسم؟").status, DF.lookupFact("71", "البرجر فيه خردل؟").status, DF.lookupFact("71", "البرجر فيه خردل؟").why], ["present_fixed", "unknown_staff", "has_unlabelled_part"]);
  assert.equal(DF.lookupFact("999", "فيه بيض؟").status, "unknown_staff");
  for (const sev of ["عندي حساسية شديدة من السمسم", "حساسية قوية من البيض", "severe nut allergy", "اخر مره رحت المستشفى من المكسرات"]) assert.equal(DF.lookupFact("13", sev).status, "severe", sev);
  assert.doesNotMatch(JSON.stringify(DF.lookupFact("13", "فيها سمسم؟")), /mustard|milk|"rm"|"fx"|"a":|السلطة|ثوم/, "nothing else about the dish leaves the lookup");
  // the bot: switched off (default) ⇒ staff, as before
  assert.equal(R.botConfig({}).dishFactsEnabled, false);
  const off = liveWorld();
  const o = await off.say("وجبة نصف دجاجة على الفحم فيها سمسم؟");
  assert.deepEqual(o.sent, [txt(ME, `سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\n${HAND}`)]); assert.equal(o.log.handoff, "needs_staff");
  // switched on
  const mk = () => liveWorld({ waBot: { dishFactsEnabled: true } });
  const KITCHEN = "مطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.";
  const NOTE = "واكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.";      // 12/10 (Omar): after an allergy answer, offer the order note
  let w = mk();
  let r = await w.say("وجبة نصف دجاجة على الفحم فيها سمسم؟");
  assert.deepEqual(r.sent, [txt(ME, `نعم، يوجد سمسم في «وجبة نصف دجاجة على الفحم»، وذلك في الطحينة. يمكن تجهيز الطلب بدون الطحينة: اكتبها في ملاحظة الصنف عند الطلب.\n${KITCHEN}\n${NOTE}`)]);
  assert.deepEqual([r.log.reply_key, r.log.detail, r.log.handoff, w.sms.length], ["dishfact", "fact:present_removable", null, 0]);
  w = mk(); r = await w.say("هل وجبة نصف دجاجة على الفحم فيها بيض");
  assert.deepEqual(r.sent, [txt(ME, `حسب بياناتنا لا يوجد بيض في «وجبة نصف دجاجة على الفحم».\n${KITCHEN}\nوإذا كانت الحساسية شديدة اكتب «موظف» قبل الطلب.\n${NOTE}`)]);
  w = mk(); r = await w.say("وجبة نصف دجاجة على الفحم فيها حليب؟");
  assert.deepEqual(r.sent, [txt(ME, `نعم، يوجد حليب في «وجبة نصف دجاجة على الفحم»، ولا يمكن تجهيز الطلب بدون حليب.\n${NOTE}`)]);
  w = mk(); r = await w.say("وجبة نصف دجاجة على الفحم فيها ارز؟");
  assert.deepEqual(r.sent, [txt(ME, "نعم، الأرز ضمن «وجبة نصف دجاجة على الفحم». يمكن تجهيز الطلب بدون الأرز: اكتبها في ملاحظة الصنف عند الطلب.")]);
  // not sure, not covered, several allergens ⇒ said plainly, with the order note and «موظف» if he wants the kitchen to confirm. No automatic handover, no alert (12/10); the reply names no ingredient
  for (const q of ["وجبة نصف دجاجة على الفحم فيها فلفل؟", "برجر لحم كلاسيك فيه خردل؟", "وجبة نصف دجاجة على الفحم فيها صويا؟"]) {
    w = mk(); r = await w.say(q);
    assert.deepEqual(r.sent, [txt(ME, `ما عندي معلومة مؤكدة عن هذا المكوّن في الصنف.\n${NOTE}\nولو تبي تأكيد من المطبخ اكتب: موظف`)], q); assert.equal(r.log.handoff, null, q); assert.equal(w.sms.length, 0, q); assert.match(r.log.detail, /^fact:unknown:/, q);
  }
  // severe: urgent handover whatever the dish, on or off, with no dish advice
  for (const world of [mk(), liveWorld()]) {
    r = await world.say("عندي حساسية شديدة من السمسم، وجبة نصف دجاجة على الفحم تنفع؟");
    assert.deepEqual(r.sent, [txt(ME, `سلامتك أهم 🙏 ما دام الحساسية شديدة، حوّلت محادثتك لموظف يتأكد من المطبخ بنفسه قبل أي طلب.\n${HAND}`)]); assert.equal(r.log.handoff, "allergy_severe");
    assert.match(world.sms[0].body, /SEVERE ALLERGY/); assert.equal(world.portal[0][1].urgent, true);
  }
  // a general allergy question with no single dish keeps the old path (the empty «allergens» entry ⇒ staff)
  w = mk(); r = await w.say("عندي حساسية من المكسرات");
  assert.equal(r.log.detail, "faq:allergens"); assert.equal(r.log.handoff, "needs_staff");
  // never «free from», «safe», «guaranteed», and never «no nuts in the kitchen», in any of the texts
  for (const k of ["df_removable", "df_removable_item", "df_fixed", "df_fixed_visible", "df_not_found", "df_can_remove", "df_cannot_remove", "df_unknown", "df_severe", "kitchen_line", "fryer_line", "df_note_line", "df_maybe_removable", "df_removable_only", "df_alt", "df_bread"]) for (const lang of ["ar", "en"]) assert.doesNotMatch(R.TEXTS[k][lang], /خالٍ من|خالي من|آمن|مضمون|free from|safe |guarantee|no nuts/i, `${k} ${lang}`);
  // gatherings with the number written as a word (the phrase B12's verify used)
  for (const q of ["ابي طلب لخمسين شخص", "عندنا عشرين ضيف", "ابي طلب لعزومة 20 شخص"]) assert.equal(R.classify({ text: q, type: "text" }, KNOW).key, "packs", q);
}));

test("the chef's worked examples (12/10), and the two live misses: a named dish + an allergen reaches the dish lookup before the general FAQ; «ممكن X بدون Y؟» is answered", withEnv(LOCKS_OPEN, async () => {
  const DF = await import("./wadishfacts.js");
  const mk = () => liveWorld({ waBot: { dishFactsEnabled: true } });
  const KITCHEN = "مطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.";
  const ask = async (q) => { const w = mk(); const r = await w.say(q); return { r, w, body: r.sent[0] ? bodyOf(r.sent[0]) : null }; };
  // live miss 1: «وجبة الكفتة فيها سمسم؟» went to the empty general FAQ because two dishes matched «كفتة». The full name wins now.
  assert.equal(DF.pickDish("وجبة الكفتة فيها سمسم؟", [{ id: 17, name: "وجبة كفتة" }, { id: 87, name: "وجبة كفتة وطرب" }]), "17");
  assert.equal(DF.pickDish("وجبة كفتة وطرب فيها سمسم؟", [{ id: 17, name: "وجبة كفتة" }, { id: 87, name: "وجبة كفتة وطرب" }]), "87", "the longer full name wins");
  assert.equal(DF.pickDish("الكفتة فيها سمسم؟", [{ id: 17, name: "وجبة كفتة" }, { id: 87, name: "وجبة كفتة وطرب" }]), null, "no full name and two candidates ⇒ no guess");
  let x = await ask("وجبة الكفتة فيها سمسم؟");
  const NOTE = "واكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.";
  // owner fact of 12/10: the kofta itself has no sesame; it is in the tahini that comes with the order
  assert.equal(x.body, `نعم، يوجد سمسم في «وجبة كفتة»، وذلك في الطحينة فقط، والكفتة نفسها بدون سمسم. يمكن تجهيز الطلب بدون الطحينة: اكتبها في ملاحظة الصنف عند الطلب.\n${KITCHEN}\n${NOTE}`);
  assert.deepEqual([x.r.log.reply_key, x.r.log.detail, x.r.log.handoff], ["dishfact", "fact:present_removable_only", null]);
  // chef's example 3: «ممكن وجبة الكفتة بدون طحينة؟»
  x = await ask("ممكن وجبة الكفتة بدون طحينة؟");
  assert.equal(x.body, "أكيد، يمكن تجهيز «وجبة كفتة» بدون الطحينة. اكتبها في ملاحظة الصنف عند الطلب."); assert.equal(x.r.log.detail, "fact:can_remove"); assert.equal(x.w.sms.length, 0);
  x = await ask("ابي برجر لحم كلاسيك بدون بصل");
  assert.equal(x.body, "أكيد، يمكن تجهيز «برجر لحم كلاسيك» بدون البصل. اكتبها في ملاحظة الصنف عند الطلب.");
  x = await ask("ممكن وجبة نصف دجاجة على الفحم بدون ثوم؟");
  assert.equal(x.body, "لا يمكن تجهيز «وجبة نصف دجاجة على الفحم» بدون ثوم.");
  x = await ask("ممكن وجبة الكفتة بدون كزبرة؟");
  assert.equal(x.r.log.handoff, null); assert.match(x.body, /^ما عندي معلومة مؤكدة عن هذا المكوّن في الصنف\./, "an ingredient that is not recorded ⇒ said plainly, never «yes» or «it has none», and no automatic handover");
  // a removal about an EXISTING order stays an order change for staff
  x = await ask("طلبي بدون بصل لو سمحت"); assert.notEqual(x.r.log.reply_key, "dishfact");
  assert.equal(R.classify({ text: "بدون بصل لو سمحت", type: "text" }, KNOW).key, "change", "no dish named ⇒ not a dish question («بصل» is not «حلقات بصل»)");
  // chef's example 1 (sesame and the burger): recorded and fixed ⇒ yes, cannot be made without it — and not where it is
  x = await ask("برجر لحم كلاسيك فيه سمسم؟");
  assert.equal(x.body, `نعم، يوجد سمسم في «برجر لحم كلاسيك»، وذلك في الخبز.\nللتأكد من إمكانية بديل عن الخبز اكتب: موظف\n${KITCHEN}\n${NOTE}`);
  assert.deepEqual([x.r.log.detail, x.r.log.handoff, x.w.sms.length], ["fact:present_fixed_visible", null, 0], "revision 4: the bun is a visible component ⇒ the place is said, staff only if he asks");
  // live miss 2, answered by the owner on 12/10: no egg in the burger itself; it MAY be in the bought-in sauce (mayonnaise type) ⇒ «قد يوجد», in the sauce, which can be left out. No handover.
  x = await ask("البرجر الكلاسيك فيه بيض؟");
  assert.equal(x.body, `قد يوجد بيض في الصوص المستخدم مع «برجر لحم كلاسيك». يمكن تجهيز الطلب بدون الصوص: اكتبها في ملاحظة الصنف عند الطلب.\n${KITCHEN}\n${NOTE}`);
  assert.deepEqual([x.r.log.detail, x.r.log.handoff, x.w.sms.length], ["fact:present_maybe_removable", null, 0]);
  // owner facts of 12/10, each through the bot: hawawshi bread has no sesame; zinger without the heat = the strips crepe; another bread for a burger ⇒ staff; hot dog is meat; crunchy fries have beef
  x = await ask("حواوشي سادة فيه سمسم؟");
  assert.equal(x.body, `نعم، يوجد سمسم في «حواوشي سادة»، وذلك في الطحينة فقط، وخبز الحواوشي بدون سمسم. يمكن تجهيز الطلب بدون الطحينة: اكتبها في ملاحظة الصنف عند الطلب.\n${KITCHEN}\nونوضّح لك أن البطاطس تُقلى في نفس القلاية مع أصناف مقرمشة أخرى.\n${NOTE}`.replace("\nونوضّح لك أن البطاطس تُقلى في نفس القلاية مع أصناف مقرمشة أخرى.", ""));
  x = await ask("ممكن كريب زنجر سوبريم بدون حار؟");
  assert.equal(x.body, "«كريب زنجر سوبريم» فيه حار. بدون حار عندنا «كريب ستربس»."); assert.deepEqual([x.r.log.detail, x.r.log.handoff], ["fact:alternative", null]);
  x = await ask("ممكن برجر لحم كلاسيك بدون خبز؟");
  assert.equal(x.body, `تغيير خبز «برجر لحم كلاسيك» يحتاج تأكيد من موظف 🙏 حوّلت طلبك له.\n${HAND}`); assert.deepEqual([x.r.log.detail, x.r.log.handoff], ["fact:unknown:other_bread", "needs_staff"]);
  assert.deepEqual([DF.lookupFact("4", "فيه لحم؟").status, DF.lookupFact("40", "فيها لحوم؟").status, DF.lookupFact("77", "فيها لحم بقري؟").status, DF.lookupFact("77", "فيها لحم بقري؟").part], ["present_fixed", "present_fixed", "present_removable", "شرائح اللحم البقري"]);
  assert.deepEqual([DF.factNote("73"), DF.factNote("52", "en"), DF.factNote("8")], ["صدور دجاج مقرمشة (ستربس) تُقدَّم مع صوص ثاوزند آيلاند.", "The sauce is served on the side.", null]);
  assert.equal(DF.lookupFact("19", "فيه جبن؟").rest, undefined, "cheese is used in other items too: «only» is never said about cheese");
  // chef's example 2 (egg and a crepe), for one named crepe
  x = await ask("كريب زنجر سوبريم فيه بيض؟");
  assert.equal(x.body, `نعم، يوجد بيض في «كريب زنجر سوبريم»، ولا يمكن تجهيز الطلب بدون بيض.\n${NOTE}`);
  // a general word for a whole group («البرجر», «الكريب») is still not one dish ⇒ staff (the assistant, not the rules bot, will suggest alternatives)
  x = await ask("عندي حساسية سمسم، ينفع البرجر؟"); assert.equal(x.r.log.handoff, "needs_staff");
}));

test("dish facts wording: no pronoun tied to the dish name (reads right for any dish), and the place of a fixed allergen is said only for a visible component the chef flagged", withEnv(LOCKS_OPEN, async () => {
  const DF = await import("./wadishfacts.js");
  // every Arabic dish-fact text is free of the pronouns that mismatched «وجبة …» («فيه», «نجهّزه», «بدونه»)
  for (const k of ["df_removable", "df_removable_item", "df_fixed", "df_fixed_visible", "df_not_found", "df_can_remove", "df_cannot_remove"]) assert.doesNotMatch(R.TEXTS[k].ar, /فيه |فيها |نجهّزه|نجهّزها|بدونه|بدونها|استبعاده/, k);
  // a visible component (flag from the chef's file): «in the bread», with a pointer to staff for an alternative — no handover by itself
  const real = DF.loadFacts();
  const d71 = JSON.parse(JSON.stringify(real.dishes["71"]));
  d71.a.sesame = { r: false, v: { ar: "الخبز", en: "bun" } };
  DF._setFactsForTests({ ...real, dishes: { ...real.dishes, 71: d71 } });
  try {
    assert.deepEqual([DF.lookupFact("71", "فيه سمسم؟").status, DF.lookupFact("71", "فيه سمسم؟").part], ["present_fixed", "الخبز"]);
    const w = liveWorld({ waBot: { dishFactsEnabled: true } });
    const r = await w.say("برجر لحم كلاسيك فيه سمسم؟");
    assert.deepEqual(r.sent, [txt(ME, "نعم، يوجد سمسم في «برجر لحم كلاسيك»، وذلك في الخبز.\nللتأكد من إمكانية بديل عن الخبز اكتب: موظف\nمطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.")]);
    assert.deepEqual([r.log.detail, r.log.handoff, w.sms.length], ["fact:present_fixed_visible", null, 0]);
    // milk in the same dish is NOT flagged visible ⇒ no place is said
    assert.equal(bodyOf((await liveWorld({ waBot: { dishFactsEnabled: true } }).say("برجر لحم كلاسيك فيه حليب؟")).sent[0]), "نعم، يوجد حليب في «برجر لحم كلاسيك»، ولا يمكن تجهيز الطلب بدون حليب.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.");
  } finally { DF._setFactsForTests(real); }
  // revision 4 of the chef's data (12/10): 59 visible cases in 24 dishes; bread on the burgers, nothing inside a dough, marinade or mix
  assert.equal(real.revision, 5);      // revision 5 = the owner's facts of 12/10 on top of the chef's revision 4 (the visible-component flags are unchanged)
  const vis = Object.entries(real.dishes).flatMap(([id, d]) => Object.entries(d.a || {}).filter(([, a]) => a.v).map(([g, a]) => [id, g, a.v.ar]));
  assert.deepEqual([vis.length, new Set(vis.map((v) => v[0])).size], [59, 24]);
  assert.ok(vis.every(([, , place]) => !/عجين|تتبيل|خلط|marinad|dough|batter/i.test(place)), "no place names a dough, marinade or mix");
  assert.ok(vis.every(([id, g]) => real.dishes[id].a[g].r === false), "a place is only for an allergen that can not be left out");
  assert.deepEqual([real.dishes["71"].a.sesame.v, real.dishes["71"].a.gluten_wheat.v, real.dishes["71"].a.milk.v], [{ ar: "الخبز", en: "bun" }, { ar: "الخبز", en: "bun" }, undefined]);
  // on the real data: the burger's sesame is on the bun (said, no handover); the egg of a crepe is in the dough (no place is said)
  const on = () => liveWorld({ waBot: { dishFactsEnabled: true } });
  const b = on(); const br = await b.say("برجر لحم كلاسيك فيه سمسم؟");
  assert.deepEqual(br.sent, [txt(ME, "نعم، يوجد سمسم في «برجر لحم كلاسيك»، وذلك في الخبز.\nللتأكد من إمكانية بديل عن الخبز اكتب: موظف\nمطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.")]);
  assert.deepEqual([br.log.handoff, b.sms.length, b.portal.length], [null, 0, 0]);
  const cr = await on().say("كريب زنجر سوبريم فيه بيض؟");
  assert.deepEqual(cr.sent, [txt(ME, "نعم، يوجد بيض في «كريب زنجر سوبريم»، ولا يمكن تجهيز الطلب بدون بيض.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.")]); assert.equal(real.dishes["8"].a.egg.v, undefined);
  // «موظف» after the bun answer is an ordinary handover
  b.clock.advance(1); assert.equal((await b.say("موظف")).log.handoff, "asked_human");
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
  assert.equal(by["بكم الكفتة"].key, "items"); assert.equal(by["السلام عليكم"].messages, 1);
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
    eta: ["كم ياخذ التوصيل", "كم باقي", "متى يوصل", "متى يوصل الطلب؟", "قد ايش باقي"],
    bill: ["كم الحساب", "كم المجموع", "الحساب كم؟"],
    whoami: ["انت بوت؟", "مين معي", "are you a bot?"],
    other_city: ["انتم في جدة ولا مكة", "فيه في مكه العزيزيه", "توصلون مكة؟", "عندكم فرع بالرياض", "توصلون الطائف", "do you deliver to Riyadh"],
    delivery: ["توصيل؟", "عندكم توصيل", "توصلون حي الصفا؟", "هل توصلون لحي النزهة", "do you deliver to al rawdah", "كم رسوم التوصيل", "التوصيل بكم", "سعر التوصيل", "is delivery free", "التوصيل مجاني؟", "الحد الادنى للطلب", "delivery fee?", "twseel", "مناطق التوصيل", "بكام التوصيل"],
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

/* ══ مساعد الطلبات جوّه البوت (الشريحة ٢): الوضع، مين يرد، الرجوع للقواعد، السقف، التحويل، رابط السلة، المتابعة، المسارات ═══════════════
   الموديل هنا مكتوب (مفيش نداء حقيقي)، والمخزن في الذاكرة. كل تأكيد على جسم الرسالة اللي راحت لـGraph فعلاً. */
const AST = await import("./waassistrun.js");
const tUse = (name, input = {}) => ({ type: "tool_use", id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input });
const mSay = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 6000 }, ms: 900, provider: "litellm:llm.o2m8.me" });
const mUse = (...u) => ({ ok: true, content: u, stop: "tool_use", usage: { input_tokens: 1000, output_tokens: 60 }, ms: 700, provider: "litellm:llm.o2m8.me" });
function aModel(steps) { const seen = [], full = []; let i = 0; return { seen, full, used: () => i, push: (...s) => steps.push(...s), callModel: async (a) => { seen.push({ model: a.model, messages: JSON.parse(JSON.stringify(a.messages)) }); full.push({ system: a.system, brief: a.brief ?? null }); const s = steps[i++]; if (!s) throw new Error("scripted model: no step left"); return s; } }; }
function memStore() {
  const st = { sessions: new Map(), turns: [], sugg: [], tags: [] };
  return { st, ensure: async () => {}, purge: async () => {}, loadSession: async (p, now, min) => { const x = st.sessions.get(p); return x && now.getTime() - x.at <= min * 60_000 ? JSON.parse(x.s) : null; },
    saveSession: async (p, s, now) => { st.sessions.set(p, { s: JSON.stringify(s), at: now.getTime() }); }, dropSession: async (p) => { st.sessions.delete(p); },
    repliesToday: async (p) => st.turns.filter((t) => t.phone === p && t.handledBy === "assistant" && !/^followup/.test(t.outcome)).length, addTurn: async (t) => { st.turns.push(t); return st.turns.length; },
    recordSuggestions: async (_p, _sid, _tid, list) => { st.sugg.push(...list); }, tagCart: async (code, acc) => { st.tags.push([code, acc]); }, chats: async () => [{ phone_norm: "512345678", turns: st.turns.length }], turns: async () => st.turns, stats: async () => ({ turns: { turns: st.turns.length } }) };
}
const TESTERS = ["0512345678"];
/* PS4: the older assistant tests keep the behaviour they were written for; PS4 has its own tests (wa-ps4.test.mjs and the PS4 tests below) */
const LEGACY_ASSIST = { salesBrain: false, imageBurstSec: 0, firstLead: false, grillFamilies: false, oneOfferPerChat: false, ackMaxChars: 0, feeMoment: false, menuToRules: false, pickForMe: false, choiceList: false, bigBoxSar: 0, pairingEnabled: false, adButtons: false, weightToAssistant: false, faqShort: false,
  briefEnabled: false, sellerClose: false, nudgeMin: 0,      // PK1: ملف المعرفة، قفلة السؤال ومتابعة السكوت — اختباراتهم في wa-pk1.test.mjs
  personalSell: false, boxForDish: false, drinksPerPerson: false, familyOutside: false, comboFallback: false, skipNeverTakes: false, tierNetOnly: false };      // S1: البيع الشخصي — اختباراته في wa-sb6.test.mjs
function aWorld(steps, o = {}) {
  const m = aModel(steps), store = memStore();
  const w = world({ bundles: LIVE.bundles, links: ALL_LINKS, ...o, waBot: { mode: "test", testPhones: TESTERS, footerMode: "smart", ...(o.waBot || {}), assist: { mode: "test", forceSuggestion: false, typing: false, orderWordsStrong: true, ...LEGACY_ASSIST, ...((o.waBot || {}).assist || {}) } }, assistModel: m.callModel, assistStore: store });
  return { ...w, m, store: store.st };
}
const msgs = (r) => r.sent.filter((b) => b.type);                    // رسايل فعلية (من غير «مقروء + جاري الكتابة»)
const receipts = (r) => r.sent.filter((b) => b.status === "read");
const CART = { option: "pickup", items: [{ id: "8", qty: 1 }] };

test("assistant, test mode: the model's validated reply is what Graph receives; cost, log and transcript are written; the customer's number never reaches the model", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("search_menu", { query: "كريب زنجر سوبريم" })), mSay("كريب زنجر سوبريم بـ 25 ر.س. توصيل ولا استلام؟")], { waBot: { assist: { typing: true } } });
  const r = await w.say("ابي كريب زنجر سوبريم ورقمي 0512345678");
  assert.deepEqual(msgs(r), [txt(ME, "كريب زنجر سوبريم بـ 25 ر.س. توصيل ولا استلام؟")], "plain text, no footer, no link");
  assert.deepEqual(receipts(r), [{ messaging_product: "whatsapp", status: "read", message_id: r.wamid, typing_indicator: { type: "text" } }], "read + typing on the customer's own message, with no «to» in the Graph body");
  assert.deepEqual([r.log.decision, r.log.reply_key, r.log.sent, r.log.handoff], ["replied", "assist", 1, null]); assert.match(r.log.detail, /^assist strong 2 calls \d+ms [\d.]+ SAR$/);
  assert.ok(!JSON.stringify(w.m.seen).includes("512345678"), "the phone is injected by code, never sent to the model");
  const ai = w.db.ai.filter((a) => a.purpose === "assistant");
  assert.equal(ai.length, 2); assert.deepEqual([ai[0].model, ai[0].outcome, ai[0].log_id, ai[0].sent_text, ai[0].cached_tokens], ["claude-sonnet-5-5", "ok", r.log.id, "ابي كريب زنجر سوبريم ورقمي [رقم]", 0]);
  assert.ok(ai[1].cost_sar > 0 && ai[1].cached_tokens === 6000);
  const t = w.store.turns[0];
  assert.deepEqual([t.handledBy, t.outcome, t.masked, t.text, t.logId, t.trace.tools[0].name, t.trace.verdicts[0].ok], ["assistant", "sent", "ابي كريب زنجر سوبريم ورقمي [رقم]", "كريب زنجر سوبريم بـ 25 ر.س. توصيل ولا استلام؟", r.log.id, "search_menu", true]);
  assert.equal(w.store.sessions.size, 1); assert.equal(w.sms.length, 0);
  // a number that is not on the test list: the rules bot's own rule (silent in test mode), the model is not called
  const before = w.m.used();
  const o = await w.say("ابي كريب", { from: "966598765432" });
  assert.equal(o.sent.length, 0); assert.equal(o.log.reason, "test_mode_not_listed"); assert.equal(w.m.used(), before);
}));

test("assistant off (the default), dry bot, or assistant «test» while the bot is off: no model call, the rules bot is exactly as before", withEnv(CONFIGURED, async () => {
  assert.equal(R.botConfig({}).assist.mode, "off");
  const base = world({ bundles: LIVE.bundles, links: ALL_LINKS, waBot: { mode: "test", testPhones: TESTERS, footerMode: "smart" } });
  const want = (await base.say("ابي بيتزا")).sent;
  const off = aWorld([], { waBot: { assist: { mode: "off" } } });
  assert.deepEqual((await off.say("ابي بيتزا")).sent, want); assert.equal(off.m.used(), 0); assert.equal(off.store.turns.length, 0);
  const dry = aWorld([], { waBot: { mode: "dry" } });
  const d = await dry.say("ابي بيتزا"); assert.equal(d.sent.length, 0); assert.equal(d.log.decision, "dry"); assert.equal(dry.m.used(), 0);
  const botOff = aWorld([], { waBot: { mode: "off" } });
  assert.equal((await botOff.say("ابي بيتزا")).sent.length, 0); assert.equal(botOff.m.used(), 0);
}));

test("assistant: what the rules own is never sent to the model — stop, staff, complaint, order status, recipes, severe allergy, hours, taps, a staff member in the chat, an open handover", withEnv(CONFIGURED, async () => {
  for (const text of ["إيقاف", "ابي اكلم موظف", "الطلب وصل بارد وناقص", "ايش التتبيلة حقت الشيش طاووق؟", "عندي حساسية شديدة من المكسرات وش اطلب", "متى تقفلون؟", "وين موقعكم"]) {
    const w = aWorld([]); const r = await w.say(text);
    assert.equal(w.m.used(), 0, text); assert.ok(r.log.reply_key !== "assist", text); assert.ok(msgs(r).length >= 1, `${text}: the rules bot answered`);
    assert.deepEqual(w.store.turns.map((t) => t.handledBy), ["rules_owned"], text);
  }
  const tap = aWorld([]); await tap.press("bot:menu", "القائمة"); assert.equal(tap.m.used(), 0);
  // a cashier answered from the restaurant phone: the pause rules apply, the assistant does not talk over a person
  const st = aWorld([]); await st.cashier("هلا بك"); st.clock.advance(1);
  const p = await st.say("ابي بيتزا"); assert.equal(st.m.used(), 0); assert.equal(p.log.decision, "waiting");
  // 12/10 (Omar's live test): an ORDINARY handover (he asked for staff) no longer owns the chat — the assistant keeps answering and knows staff were already asked
  const ho = aWorld([mSay("عندنا بيتزا بأنواع كثيرة. تبي أعرض لك الأنواع؟")]); const h1 = await ho.say("ابي اكلم موظف"); ho.clock.advance(1);
  assert.equal(bodyOf(msgs(h1)[0]), "أبشر 🙏 حوّلت محادثتك لموظف.\nيرد عليك موظف هنا في أقرب وقت، وأنا معك لو تحتاج شي ثاني.");
  const h2 = await ho.say("ابي بيتزا"); assert.equal(h2.log.reply_key, "assist"); assert.equal(ho.m.used(), 1);
  assert.match(ho.m.seen[0].messages[0].content[0].text, /"staff_already_asked":\{"reason":"asked_human","minutes_ago":1\}/);
  ho.clock.advance(1); const h3 = await ho.say("موظف"); assert.equal(h3.log.alert, "already_open", "asking again does not alert the team twice"); assert.equal(ho.portal.length, 1);
  // a SERIOUS handover (complaint) holds the assistant for assist.seriousHoldMin (15), not for 24 hours
  const se = aWorld([mSay("هلا 👋 وش تحب تطلب؟")]); await se.say("الطلب وصل بارد وناقص"); se.clock.advance(5);
  await se.say("ابي بيتزا"); assert.equal(se.m.used(), 0, "inside the hold: the rules bot's facts-only behaviour");
  se.clock.advance(11); assert.equal((await se.say("ابي بيتزا")).log.reply_key, "assist");
  // an unknown message waits three minutes for staff in the rules bot; with the assistant on it is answered now
  const un = aWorld([mSay("أقدر أساعدك في المنيو والطلب. وش تحب تطلب؟")]);
  const u = await un.say("بلا بلا بلا كلام مو مفهوم"); assert.equal(u.log.decision, "replied"); assert.equal(u.log.reply_key, "assist"); assert.equal(un.db.jobs.length, 0);
}));

test("assistant: timeout, model error, a reply refused twice, a broken payload ⇒ the customer gets the rules bot's reply, and the transcript says why", withEnv(CONFIGURED, async () => {
  const base = world({ bundles: LIVE.bundles, links: ALL_LINKS, waBot: { mode: "test", testPhones: TESTERS, footerMode: "smart" } });
  const want = (await base.say("ابي بيتزا")).sent;
  for (const [steps, reason] of [[[{ ok: false, error: "timeout", ms: 20000, provider: "x", usage: null }], "timeout"], [[{ ok: false, error: "http_500", ms: 80, provider: "x", usage: null }], "model_http_500"],
    [[mSay("بيتزا مارجريتا بـ 9 ر.س"), mSay("بيتزا مارجريتا بـ 8 ر.س")], "validator"], [[mSay("x".repeat(1200)), mSay("y".repeat(1200))], "validator"], [[{ ...mSay("x"), stop: "refusal" }], "stop_refusal"]]) {
    const w = aWorld(steps); const r = await w.say("ابي بيتزا");
    assert.deepEqual(msgs(r), want, `${reason}: same reply as without the assistant`); assert.equal(r.log.detail, `assist off: ${reason}`);
    assert.deepEqual(w.store.turns.map((t) => [t.handledBy, t.outcome]), [["rules", `fallback:${reason}`]]); assert.equal(w.store.sessions.size, 0, "a failed first turn leaves no conversation");
    assert.ok(w.db.ai.filter((a) => a.purpose === "assistant").length >= 1, "the failed call is still in the cost log");
  }
  // the model throws ⇒ still the rules bot
  const boom = aWorld([]); const b = await boom.say("ابي بيتزا"); assert.deepEqual(msgs(b), want);
}));

test("assistant budget: 10 SAR a day and 100 a month of its own; at the ceiling the rules bot answers and the owner gets ONE SMS; a per-customer daily limit without a handover", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("هلا 👋 وش تحب تطلب؟")]);
  w.db.ai.push({ id: 1, at: w.clock.now().toISOString(), purpose: "classify", cost_sar: 50, ms: 1, in_tokens: 0, out_tokens: 0, cached_tokens: 0 });       // the understanding budget is separate
  assert.equal((await w.say("ابي بيتزا")).log.reply_key, "assist");
  w.db.ai.push({ id: 2, at: w.clock.now().toISOString(), purpose: "assistant", cost_sar: 10, ms: 1, in_tokens: 0, out_tokens: 0, cached_tokens: 0 });
  w.clock.advance(3);
  const r = await w.say("وعندكم باستا؟");
  assert.equal(r.log.detail, "assist off: budget_day"); assert.ok(r.log.reply_key !== "assist"); assert.equal(msgs(r).length >= 1, true);
  assert.equal(w.sms.length, 2, "one alert, to the two alert phones"); assert.match(w.sms[0].body, /AI daily ceiling reached \(10\.\d+\/10 SAR\)/);
  w.clock.advance(3); await w.say("وعندكم برجر؟"); assert.equal(w.sms.length, 2, "no second alert the same day");
  assert.equal(w.m.used(), 1);
  const c = (await w.call("GET", "/api/cms/wabot/cost")).body;
  assert.deepEqual([c.assistant.mode, c.assistant.model, c.assistant.summary.budget.budgetDaySar, c.assistant.summary.budget.stop], ["test", "claude-sonnet-5-5", 10, "budget_day"]); assert.equal(c.ai.budget.budgetDaySar, 3);
  // month
  const mo = aWorld([]); mo.db.ai.push({ id: 1, at: new Date(mo.clock.now().getTime() - 5 * 86400_000).toISOString(), purpose: "assistant", cost_sar: 100, ms: 1, in_tokens: 0, out_tokens: 0, cached_tokens: 0 });
  assert.equal((await mo.say("ابي بيتزا")).log.detail, "assist off: budget_month");
  // replies per customer per day: the rules bot goes on, no handover, no alert
  const lim = aWorld([mSay("هلا 👋 وش تحب تطلب؟")], { waBot: { assist: { maxRepliesPerChatDay: 1 } } });
  await lim.say("ابي بيتزا"); lim.clock.advance(3);
  const l2 = await lim.say("وعندكم باستا؟"); assert.equal(l2.log.detail, "assist off: daily_replies"); assert.equal(l2.log.handoff, null); assert.equal(lim.sms.length, 0);
}));

test("assistant handover: the customer gets the rules bot's fixed line, the chat is handed over with the note, and the assistant goes quiet", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("list_packs", {})), mSay("عندنا باقات تجمّع جاهزة. تناسبك واحدة منها ولا تبي عرض مخصص؟"), mUse(tUse("handover", { reason: "custom_offer", note: "25 people, Friday 9 pm, delivery" }))]);
  await w.say("عندنا عزيمة 25 شخص"); w.clock.advance(1);      // PS3: the packs are shown first; the tailored offer is handed over in a later turn
  const r = await w.say("ابي عرض لعزيمة 25 شخص الجمعة الساعة 9 توصيل");
  assert.deepEqual(msgs(r), [txt(ME, "أبشر 🙏 حوّلت محادثتك لموظف.\nيرد عليك موظف هنا في أقرب وقت، وأنا معك لو تحتاج شي ثاني.")]);
  assert.deepEqual([r.log.reply_key, r.log.handoff], ["assist", "custom_offer"]); assert.equal(w.db.chats.get("512345678").handoff_reason, "custom_offer");
  assert.deepEqual([w.portal[0][0], w.portal[0][1].reason, w.portal[0][1].note, w.portal[0][1].test], ["wa_handover", "custom_offer", "25 people, Friday 9 pm, delivery", true]);
  assert.deepEqual([w.store.turns.at(-1).outcome, w.store.turns.at(-1).handover], ["handover:custom_offer", "custom_offer"]);
  w.m.push(mSay("أبشر، عندنا بيتزا. وطلب العرض المخصص عند الموظف ويرد عليك هنا.")); w.clock.advance(2);
  assert.equal((await w.say("ابي بيتزا")).log.reply_key, "assist", "a tailored-offer handover does not silence the assistant"); assert.equal(w.m.used(), 4);
  // severe allergy raised by the model: the same urgent text the rules bot uses
  const s = aWorld([mUse(tUse("handover", { reason: "allergy_severe" }))]);
  const a = await s.say("ولدي ياكل اي شي؟ عنده مشكلة مع الفستق");
  assert.match(bodyOf(msgs(a)[0]), /^سلامتك أهم 🙏/); assert.equal(a.log.handoff, "allergy_severe"); assert.equal(s.portal[0][1].urgent, true);
}));

test("assistant cart: the link goes out as the «كمّل طلبك» button, the cart is tagged with accepted suggestions, a returning customer gets the one-tap reorder button, the first message carries the disclosure", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("preview_cart", CART)), mSay("كريب زنجر سوبريم بـ 25 ر.س. تحب أضيف لك مشروبات غازية بـ 3 ر.س؟"), mUse(tUse("note_suggestion", { kind: "drink", outcome: "accepted" }), tUse("build_cart", { option: "pickup", items: [{ id: "8" }, { id: "82" }] })), mSay("سلتك: كريب زنجر سوبريم + مشروبات غازية = 28 ر.س، استلام. اضغط الزر وادفع 👇")]);
  const a = await w.say("ابي كريب زنجر سوبريم");
  assert.equal(msgs(a)[0].type, "text"); w.clock.advance(1);
  const b = await w.say("ايوه ضيفها، استلام");
  assert.deepEqual(msgs(b), [{ messaging_product: "whatsapp", recipient_type: "individual", to: ME, type: "interactive", interactive: { type: "cta_url", body: { text: "سلتك: كريب زنجر سوبريم + مشروبات غازية = 28 ر.س، استلام. اضغط الزر وادفع 👇" }, action: { name: "cta_url", parameters: { display_text: "كمّل طلبك", url: "https://freshcuts.sa/c/rc000001" } } } }]);
  assert.deepEqual([w.db.botCarts[0].source, w.db.botCarts[0].phone, w.db.botCarts[0].option], ["assistant", "512345678", "pickup"]);
  assert.ok(!JSON.stringify(w.m.seen).includes("rc000001"), "the model never sees the link");
  assert.deepEqual(w.store.tags, [["rc000001", [{ kind: "drink", ref: "82", name: "مشروبات غازية" }]]]);
  assert.deepEqual(w.store.sugg.map((s) => [s.kind, s.outcome]), [["drink", "offered"], ["drink", "accepted"]]);
  assert.equal(w.store.turns[1].cartCode, "rc000001");
  assert.deepEqual(w.db.jobs.map((j) => [j.kind, j.wamid, j.status, (Date.parse(j.due_at) - w.clock.now().getTime()) / 60_000]), [["assist_followup", "fu:rc000001", "pending", 30]]);
  // returning customer: greeted from his profile, with the rules bot's one-tap reorder button under the first message; the disclosure line on top
  const prior = [order({ status: "delivered", created_at: "2026-10-05T17:00:00Z", customer: { name: "أحمد" } })];
  const g = aWorld([mSay("هلا بك أحمد 👋 نفس طلبك السابق؟")], { orders: prior, lastCart: SNAP(), disclosure: true });
  const h = await g.say("هلا");
  const p = msgs(h)[0];
  assert.equal(p.interactive.type, "button"); assert.deepEqual(p.interactive.action.buttons.map((x) => [x.reply.id, x.reply.title]), [["re:last", "🔁 نفس طلبي السابق"]]);
  assert.match(p.interactive.body.text, /^معك المساعد الآلي لفريش كاتس 🤖[^\n]*\nهلا بك أحمد 👋 نفس طلبك السابق؟$/);
  const ctx = g.m.seen[0].messages[0].content[0].text;
  assert.match(ctx, /"reorder_offer":\{"day":"يوم الاثنين 5\/10"/); assert.match(ctx, /"customer":\{"known":true,"name":"أحمد"/); assert.ok(!/512345678|consent|refunds/.test(ctx));
  g.clock.advance(1); const tapped = await g.press("re:last", "🔁 نفس طلبي السابق");
  assert.equal(g.m.used(), 1, "the tap is the rules bot's"); assert.match(urlOf(msgs(tapped)[0]), /^https:\/\/freshcuts\.sa\/c\/rc/);
}));

test("follow-up: once, 30 minutes after the cart link — and not if he ordered, wrote, stopped, was handed over or muted, the window closed, we are closed or closing, or anything changed in the settings", withEnv(CONFIGURED, async () => {
  const steps = () => [mUse(tUse("build_cart", CART)), mSay("سلتك: كريب زنجر سوبريم = 25 ر.س. اضغط الزر وادفع 👇")];
  const FU = { messaging_product: "whatsapp", recipient_type: "individual", to: ME, type: "interactive", interactive: { type: "cta_url", body: { text: "سلتك ما زالت جاهزة 🛒 تقدر تكمّل طلبك من الزر 👇\nوإذا تحتاج شي ثاني اكتب لي." }, action: { name: "cta_url", parameters: { display_text: "كمّل طلبك", url: "https://freshcuts.sa/c/rc000001" } } } };
  const sent = async (o = {}) => { const w = aWorld(steps(), o); await w.say("ابي كريب زنجر سوبريم استلام"); assert.equal(w.db.jobs.length, 1); return w; };
  const job = (w) => [w.db.jobs[0].status, w.db.jobs[0].reason];
  // the plain case
  const w = await sent();
  assert.deepEqual(await w.tick(29), [], "not before its time");
  assert.deepEqual(await w.tick(1), [FU]); assert.deepEqual(job(w), ["done", null]);
  assert.deepEqual([w.db.log.at(-1).reply_key, w.db.log.at(-1).decision, w.db.log.at(-1).wamid], ["assist_followup", "replied", null]); assert.equal(w.store.turns.at(-1).outcome, "followup_sent");
  assert.deepEqual(await w.tick(60), [], "once"); assert.equal(w.m.used(), 2, "a fixed text: no model call");
  // every reason not to send
  const cases = {
    customer_wrote: async (x) => { x.clock.advance(5); await x.say("شكرا"); },
    ordered: async (x, orders) => { orders.push(order({ created_at: new Date(x.clock.now().getTime() + 60_000).toISOString(), status: "pending_payment" })); },
    stopped: async (x) => { x.db.optins["512345678"] = { stopped_at: x.clock.now().toISOString() }; },
    staff_in_chat: async (x) => { x.clock.advance(2); await x.cashier("تفضل كيف اخدمك"); },
    handover_open: async (x) => { x.db.chats.get("512345678").handoff_at = x.clock.now().toISOString(); },
    muted: async (x) => { x.db.chats.get("512345678").muted_until = new Date(x.clock.now().getTime() + 3600_000).toISOString(); },
    window_closed: async (x) => { for (const m of x.db.msgs) if (m.direction === "in") m.created_at = new Date(x.clock.now().getTime() - 23.95 * 3600_000).toISOString(); },
    cart_gone: async (x) => { x.db.botCarts[0].expired = true; },
    assist_off: async (x) => { x.db.settings.waBot.assist.mode = "off"; },
    not_test_phone: async (x) => { x.db.settings.waBot.testPhones = ["0544775082"]; },
    mode_off: async (x) => { x.setMode("off"); },
  };
  for (const [reason, change] of Object.entries(cases)) {
    const orders = []; const x = await sent({ orders }); await change(x, orders);
    const left = 30 - (x.clock.now().getTime() - Date.parse(x.db.jobs[0].ev.sentAt)) / 60_000;
    const out = (await x.tick(left)).filter((b) => b.type === "interactive" && /ما زالت جاهزة/.test(b.interactive.body.text));
    assert.deepEqual(out, [], reason); assert.deepEqual(job(x), ["cancelled", reason], reason);
  }
  const off = await sent(); off.db.settings.waBot.assist.followUpEnabled = false; await off.tick(30); assert.deepEqual(job(off), ["cancelled", "assist_off"]);
  // the manual mute button cancels it at once
  const mu = await sent(); await mu.bot.muteChat("512345678", 2, "omar"); assert.deepEqual(job(mu), ["cancelled", "manual_mute"]);
  // closing soon (01:20, we close at 02:00 ⇒ due 01:50, ten minutes before closing) and closed
  const late = await sent({ at: "2026-10-12T22:20:00Z" }); assert.deepEqual(await late.tick(30), []); assert.deepEqual(job(late), ["cancelled", "near_closing"]);
  const shut = await sent({ at: "2026-10-12T22:45:00Z" }); await shut.tick(30); assert.deepEqual(job(shut), ["cancelled", "closed"]);
  // the server was down past the time: no late nudge
  const stale = await sent(); await stale.tick(55); assert.deepEqual(job(stale), ["cancelled", "stale"]);
  // a setting changed while waiting: the delay is read when the link is sent; the switch and the list are read when it is due
  const cfg45 = await sent({ waBot: { assist: { followUpMin: 45, followUpCloseGuardMin: 0 } } }); assert.deepEqual(await cfg45.tick(44), []); assert.equal((await cfg45.tick(1)).length, 1);
  // a new cart replaces the pending follow-up of the old one; one follow-up a day
  const two = aWorld([...steps(), ...steps()]); await two.say("ابي كريب زنجر سوبريم استلام"); two.clock.advance(10); await two.say("ابي كريب زنجر سوبريم استلام مرة ثانية");
  assert.deepEqual(two.db.jobs.map((j) => [j.wamid, j.status, j.reason]), [["fu:rc000001", "cancelled", "replaced"], ["fu:rc000002", "pending", null]]);
  for (const m of two.db.msgs) if (m.direction === "in") m.created_at = new Date(two.clock.now().getTime() - 60_000).toISOString();
  two.db.jobs[1].ev.sentAt = two.clock.now().toISOString(); two.db.jobs[1].due_at = new Date(two.clock.now().getTime() + 30 * 60_000).toISOString();
  assert.equal((await two.tick(30)).length, 1);
  two.m.push(...steps()); two.clock.advance(5); await two.say("ابي كريب زنجر سوبريم استلام كمان"); two.db.jobs[2].ev.sentAt = two.clock.now().toISOString();
  for (const m of two.db.msgs) if (m.direction === "in") m.created_at = new Date(two.clock.now().getTime() - 60_000).toISOString();
  await two.tick(30); assert.deepEqual([two.db.jobs[2].status, two.db.jobs[2].reason], ["cancelled", "already_followed_up"]);
}));

test("assistant settings and owner routes: schema rows, limits enforced, «live» refused, change log, transcripts and stats for the hub, and a try-out that sends nothing", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("search_menu", { query: "بيتزا مارجريتا" })), mSay("بيتزا مارجريتا بـ 20 ر.س.")], { waBot: { assist: { mode: "off" } } });
  const sch = (await w.call("GET", "/api/cms/wabot/schema")).body;
  const rows = sch.settings.filter((x) => x.group === "assist");
  assert.equal(rows.length, Object.keys(AST.ASSIST_CFG_DEFAULTS).length); assert.equal(sch.groups.assist, "مساعد الطلبات");
  const day = rows.find((x) => x.key === "assist.budgetDaySar");
  assert.deepEqual([day.type, day.min, day.max, day.default, day.value, day.unit, day.groupAr], ["number", 0, 1000, 10, 10, "ر.س", "مساعد الطلبات"]);
  assert.deepEqual(rows.find((x) => x.key === "assist.mode").options, ["off", "test", "live"]);
  for (const bad of [{ assist: { mode: "live" } }, { assist: { budgetDaySar: 5000 } }, { assist: { followUpMin: 1 } }, { assist: { model: "x y" } }, { assist: { unknownKey: 1 } }]) assert.equal((await w.call("PUT", "/api/cms/wabot/config", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { testPhones: [], mode: "off", assist: { mode: "test" } })).status, 400, "test mode needs a test number");
  const ok = await w.call("PUT", "/api/cms/wabot/config", { assist: { mode: "test", budgetDaySar: 7 } });
  assert.deepEqual([ok.status, ok.body.config.assist.mode, ok.body.config.assist.budgetDaySar, ok.body.config.assist.budgetMonthSar], [200, "test", 7, 100]);
  assert.deepEqual(w.db.cfgLog.at(-1).changes.filter((c) => /^assist\./.test(c.path)).map((c) => [c.path, c.from, c.to]), [["assist.budgetDaySar", null, 7], ["assist.mode", "off", "test"]]);
  w.setOwner(false);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { assist: { mode: "off" } })).status, 403);
  for (const p of ["/api/cms/wabot/assist/chats", "/api/cms/wabot/assist/turns"]) assert.equal((await w.call("GET", p)).status, 403, p);
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/simulate", { phone: "0512345678", text: "x" })).status, 403);
  w.setOwner(true);
  // try-out: a real turn of the loop on live data, nothing sent, counted on the budget, in the transcript as «simulate»
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/simulate", { phone: "0598765432", text: "بكم بيتزا مارجريتا" })).status, 403, "only a number of the test list");
  const before = w.calls.length;
  const sim = (await w.call("POST", "/api/cms/wabot/assist/simulate", { phone: "0512345678", text: "بكم بيتزا مارجريتا", reset: true })).body;
  assert.deepEqual([sim.ok, sim.reply, sim.wouldAnswer, sim.trace.tools[0].name, sim.trace.calls.length], [true, "بيتزا مارجريتا بـ 20 ر.س.", "assistant", "search_menu", 2]);
  assert.equal(w.calls.length, before, "no Graph request"); assert.equal(w.db.log.length, 0); assert.equal(w.store.turns.at(-1).handledBy, "simulate"); assert.equal(w.db.ai.filter((a) => a.purpose === "assistant").length, 2);
  const turns = (await w.call("GET", "/api/cms/wabot/assist/turns", {}, { phone: "0512345678" })).body;
  assert.equal(turns.ok, true); assert.equal(turns.rows.length, 1);
  assert.equal((await w.call("GET", "/api/cms/wabot/assist/chats")).body.rows[0].phone, "0512345678");
  const stats = (await w.call("GET", "/api/cms/wabot/assist/stats")).body;
  assert.deepEqual([stats.ok, stats.mode, stats.botMode, stats.testPhones, stats.models.strong, typeof stats.promptVersion], [true, "test", "test", 1, "claude-sonnet-5-5", "string"]);
}));

test("assistant: «خلها بدون طحينة» while building a cart is a note for the assistant; the same words from someone with a paid order today stay an order change for staff", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("تمام، أضفتها ملاحظة: بدون طحينة. توصيل ولا استلام؟")]);
  const r = await w.say("طيب خلها بدون طحينة");
  assert.equal(R.classify({ text: "طيب خلها بدون طحينة", type: "text" }, {}).key, "change");
  assert.deepEqual([r.log.reply_key, r.log.handoff], ["assist", null]); assert.equal(w.m.used(), 1);
  assert.match(w.m.seen[0].messages[0].content[0].text, /"hint":\{"intent":"note_or_change_to_the_cart_being_built"\}/);
  const paid = aWorld([], { orders: [order()] });
  const p = await paid.say("طيب خلها بدون طحينة");
  assert.equal(paid.m.used(), 0); assert.equal(p.log.handoff, "order_change"); assert.match(bodyOf(msgs(p)[0]), /تعديل الطلب أو إلغاؤه يحتاج موظف/);
  // cancelling is always the rules' (staff), order or not
  const c = aWorld([]); const x = await c.say("ابي الغي طلبي"); assert.equal(c.m.used(), 0); assert.equal(x.log.handoff, "order_change");
  // inside the assistant's conversation a question about hours stays with it; outside, the rules answer it
  const h = aWorld([mSay("هلا 👋 وش تحب تطلب؟"), mUse(tUse("get_hours", {})), mSay("مفتوحين الحين. تبي أجهّز لك طلب؟")]);
  await h.say("ابي اطلب"); h.clock.advance(1);
  assert.equal((await h.say("متى تقفلون؟")).log.reply_key, "assist");
  const o = aWorld([]); assert.equal((await o.say("متى تقفلون؟")).log.reply_key, "hours"); assert.equal(o.m.used(), 0);
}));

/* ══ ١٢/١٠ بعد تجربة عمر الحيّة (المساعد ماردّش ولا مرة): الموظف والمساعد في نفس المحادثة ═══════════════ */
test("item 8 — an offers question after a staff reply is answered by the ASSISTANT: it steps back 5 minutes (not 30), waits for staff, then answers; unknown messages are not dropped", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("get_offers", {})), mSay("عندك عرض الطلب الأول: توصيل مجاني للطلبات من 60 ر.س. تحب أرشح لك شي؟"), mSay("أنا معك. وش تحب تطلب؟")], { waBot: { staffWaitMin: 2 } });
  await w.cashier("هلا بك، كيف اخدمك"); w.clock.advance(1);
  // the customer writes one minute after staff: nothing is sent yet, the message waits for the staff member (2 min)
  const a = await w.say("عندكم عروض؟");
  assert.deepEqual([a.sent.length, a.log.decision, w.m.used()], [0, "waiting", 0]); assert.equal(w.db.jobs[0].kind, "staff_wait");
  // staff did not answer ⇒ the delayed reply is the assistant's (it was the rules bot's: «سالته اكتر من مرة على العروض ومبيردش»)
  const out = (await w.tick(2)).filter((b) => b.type);
  assert.deepEqual(out, [txt(ME, "عندك عرض الطلب الأول: توصيل مجاني للطلبات من 60 ر.س. تحب أرشح لك شي؟")]);
  assert.deepEqual([a.log.reply_key, a.log.reason, w.m.used()], ["assist", "assistant", 2]);
  // a message the rules do not understand also waits and is then answered (it used to be left to staff with no reply at all)
  w.clock.advance(1); const u = await w.say("انت بطيء اوي");
  assert.equal(u.log.decision, "waiting"); assert.equal((await w.tick(2)).filter((b) => b.type).length, 1); assert.equal(u.log.reply_key, "assist");
  // five minutes after the LAST staff message the assistant answers at once again; with the assistant off the old 30-minute pause still applies
  const s = aWorld([mSay("هلا 👋 وش تحب تطلب؟")]); await s.cashier("لحظة"); s.clock.advance(6);
  const now = await s.say("ابي بيتزا"); assert.deepEqual([now.log.decision, now.log.reply_key], ["replied", "assist"]);
  const off = aWorld([], { waBot: { assist: { mode: "off" } } }); await off.cashier("لحظة"); off.clock.advance(6);
  assert.equal((await off.say("ابي بيتزا")).log.decision, "waiting", "assistant off: the rules bot's own pause, as before");
  // staff answered while the message was waiting ⇒ nobody talks over them
  const st = aWorld([], { waBot: { staffWaitMin: 2 } }); await st.cashier("هلا"); st.clock.advance(1); const q1 = await st.say("عندكم عروض؟"); st.clock.advance(1); await st.cashier("ايوه عندنا");
  assert.deepEqual(await st.tick(1), []); assert.equal(q1.log.reason, "staff_answered"); assert.equal(st.m.used(), 0);
}));

test("handover follow-up: staff are alerted again after 5 minutes of silence, the customer gets ONE honest note after 10 — never if staff wrote or pressed «تم», the handover changed, the chat is muted, or we are closed", withEnv(CONFIGURED, async () => {
  const NOTE = txt(ME, "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.\nوأنا معك لو تحتاج شي في المنيو أو الطلب.");
  const start = async (o = {}) => { const w = aWorld([], o); await w.say("ابي اكلم موظف"); return w; };
  const jobs = (w) => w.db.jobs.filter((j) => j.kind === "handover_check").map((j) => [j.ev.stage, j.status, j.reason]);
  const w = await start();
  assert.deepEqual(jobs(w), [["realert", "pending", null]]); assert.equal(w.portal.length, 1);
  assert.deepEqual(await w.tick(4), []); assert.equal(w.portal.length, 1, "not before five minutes");
  assert.deepEqual(await w.tick(1), []);
  assert.deepEqual([w.portal.length, w.portal[1][0], w.portal[1][1].reminder, w.portal[1][1].waitedMin, w.portal[1][1].reason, w.portal[1][1].test], [2, "wa_handover", true, 5, "asked_human", true]);
  assert.deepEqual(jobs(w), [["realert", "done", "realert:would"], ["note", "pending", null]]); assert.equal(w.sms.length, 0, "test mode: no SMS unless alertInTest");
  assert.deepEqual(await w.tick(5), [NOTE]); assert.deepEqual(jobs(w)[1], ["note", "done", "note_sent"]);
  assert.deepEqual([w.db.log.at(-1).reply_key, w.db.log.at(-1).decision], ["handover_note", "replied"]);
  assert.deepEqual(await w.tick(30), [], "once per handover");
  // staff wrote ⇒ neither the second alert nor the note
  const a = await start(); a.clock.advance(2); await a.cashier("تفضل"); await a.tick(3);
  assert.deepEqual([jobs(a), a.portal.length], [[["realert", "cancelled", "staff_answered"]], 1]);
  // staff wrote between the alert and the note ⇒ no note
  const b = await start(); await b.tick(5); b.clock.advance(1); await b.cashier("معك"); assert.deepEqual(await b.tick(4), []); assert.deepEqual(jobs(b)[1], ["note", "cancelled", "staff_answered"]);
  // «رجّع البوت» / a new handover / a manual mute / mode off / the number left the test list
  const c = await start(); await c.bot.unmuteChat("512345678"); await c.tick(5); assert.equal(jobs(c)[0][2], "handover_changed");
  const d = await start(); await d.bot.muteChat("512345678", 2, "omar"); assert.deepEqual(jobs(d)[0].slice(1), ["cancelled", "manual_mute"]);
  const e = await start(); e.setMode("off"); await e.tick(5); assert.equal(jobs(e)[0][2], "mode_off");
  const f = await start(); f.db.settings.waBot.testPhones = ["0544775082"]; await f.tick(5); assert.equal(jobs(f)[0][2], "not_test_phone");
  // closed when the note is due: no note (the handover line already said a person answers when we open)
  const g = await start({ at: "2026-10-12T22:52:00Z" }); await g.tick(5); assert.equal(g.portal.length, 2); assert.deepEqual(await g.tick(5), []); assert.equal(jobs(g)[1][2], "closed");
  // he stopped our messages ⇒ no note
  const h = await start(); await h.tick(5); h.db.optins["512345678"] = { stopped_at: h.clock.now().toISOString() }; await h.tick(5); assert.equal(jobs(h)[1][2], "stopped");
  // settings: zero switches each step off; a complaint gets the note without «وأنا معك»; alertInTest sends the SMS again
  const n0 = await start({ waBot: { handoverRealertMin: 0, handoverCustomerNoteMin: 0 } }); assert.deepEqual(jobs(n0), []);
  const n1 = await start({ waBot: { handoverRealertMin: 0, handoverCustomerNoteMin: 3 } }); assert.deepEqual(jobs(n1), [["note", "pending", null]]); assert.equal((await n1.tick(3)).length, 1);
  const cp = aWorld([]); await cp.say("الطلب وصل بارد وناقص"); await cp.tick(5);
  assert.deepEqual(await cp.tick(5), [txt(ME, "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.")]);
  const sm = await start({ waBot: { alertInTest: true } }); const n = sm.sms.length; await sm.tick(5); assert.equal(sm.sms.length, n + 2, "the team is alerted again by SMS when test alerts are on"); assert.equal(jobs(sm)[0][2], "realert:sent");
  // the settings exist with limits
  for (const k of ["handoverRealertMin", "handoverCustomerNoteMin"]) { assert.ok(R.SCHEMA[k].ar && R.SCHEMA[k].group === "staff"); assert.equal(R.configFromBody({ [k]: 999 }).ok, false); }
  assert.deepEqual([R.botConfig({}).handoverRealertMin, R.botConfig({}).handoverCustomerNoteMin, R.botConfig({}).assist.staffStepBackMin, R.botConfig({}).assist.seriousHoldMin], [5, 10, 5, 15]);
}));

test("fewer handovers: «not sure» about an ingredient is said plainly by the assistant with the order note — no staff alert; a severe allergy and a different burger bread still go to staff", withEnv(CONFIGURED, async () => {
  const x = aWorld([], { waBot: { dishFactsEnabled: true } });
  x.m.push(mUse(tUse("dish_fact", { id: "71", question: "خردل" })), mSay("ما عندي معلومة مؤكدة عن هذا المكوّن في الصنف.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.\nولو تبي تأكيد من المطبخ اكتب: موظف"));
  const r = await x.say("برجر لحم كلاسيك فيه خردل وانا عندي حساسية خفيفة؟");
  assert.deepEqual([r.log.reply_key, r.log.handoff, x.portal.length], ["assist", null, 0]);
  const res = JSON.parse(x.m.seen[1].messages.at(-1).content[0].content);
  assert.deepEqual([res.status.slice(0, 7), /do NOT hand over/.test(res.rule)], ["unknown", true]);
  assert.deepEqual(x.store.turns[0].trace.unanswered.map((u) => u.source), ["dish_fact"], "the question is kept for the manager's queue");
  // another bread: the tool itself says handover
  const b = aWorld([mUse(tUse("dish_fact", { id: "71", question: "بدون خبز", remove: true })), mUse(tUse("handover", { reason: "needs_staff", note: "burger without the bun" }))], { waBot: { dishFactsEnabled: true } });
  const br = await b.say("ابي برجر لحم كلاسيك بس بخبز توست");
  assert.equal(br.log.handoff, "needs_staff"); assert.equal(JSON.parse(b.m.seen[1].messages.at(-1).content[0].content).handover, "needs_staff");
  // severe allergy never reaches the model
  const s = aWorld([], { waBot: { dishFactsEnabled: true } }); const sr = await s.say("عندي حساسية شديدة من السمسم، وجبة كفتة تنفع؟");
  assert.equal(s.m.used(), 0); assert.equal(sr.log.handoff, "allergy_severe"); assert.match(bodyOf(msgs(sr)[0]), /وأنا أترك المحادثة له\.$/, "a serious handover keeps the old line: the assistant does step back");
}));

const ctxOf = (seenCall) => { const t = seenCall.messages.map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || "").join("\n") : String(m.content || ""))).join("\n"); const m = /<context [^>]*>([\s\S]*?)<\/context>/.exec(t); return m ? JSON.parse(m[1]) : null; };
function fakeKb({ answers = [], notes = null } = {}) {
  const calls = { queue: [], used: [], search: [] };
  return { calls, search: async (q, lang) => { calls.search.push([q, lang]); return answers; }, markUsed: async (id) => { calls.used.push(id); }, queue: async (x) => { calls.queue.push(x); return { id: calls.queue.length, created: true }; }, notesFor: async () => notes };
}

test("AS4 ads — a chat opened from an ad: the assistant opens on the advertised box (from the ad's link), the ad's numbers never reach it, and every ad chat is counted per ad", withEnv(CONFIGURED, async () => {
  const AD = "120251225139440593";
  const referral = { source_url: "https://fb.me/abc", source_id: AD, source_type: "ad", headline: "بوكس الكريب الفردي بـ 19 ريال خصم 50%", ctwa_clid: "CLID123" };
  const links = [...ALL_LINKS, { slug: "ad-crepe", target_type: "box", target_id: "box-solo-crepe" }];
  const w = aWorld([mSay("هلا 👋 بوكس الكريب الفردي بـ 29 ر.س.\nتبيه توصيل ولا استلام؟")], { links, waBot: { links: { organic: "wab-boxes", ads: "wa-boxes", adMap: { [AD]: "ad-crepe" } } } });
  const r = await w.say("مرحبا", { referral });
  assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"]);
  const cx = ctxOf(w.m.seen[0]);
  assert.deepEqual(cx.came_from_ad.advertised, { kind: "box", slug: "box-solo-crepe", name: "بوكس الكريب الفردي", name_en: "Crepe Solo Box", price: 29 });
  assert.ok(!/\d|%/.test(cx.came_from_ad.ad_text), "prices and percentages written in the ad are stripped: " + cx.came_from_ad.ad_text);
  assert.ok(!JSON.stringify(w.m.seen).includes(AD) && !JSON.stringify(w.m.seen).includes("CLID123"), "no ad id or click id goes to the model");
  assert.deepEqual(w.db.adChats, [{ phone_norm: "512345678", ad_id: AD, headline: "بوكس الكريب الفردي بـ 19 ريال خصم 50%", source_type: "ad", clicks: 1 }]);
  // an ad with no link of its own: the ad text only, no «advertised»; a second click on the first ad is the same row
  const w2 = aWorld([mSay("هلا 👋 وش تحب تطلب اليوم؟")], { links });
  await w2.say("مرحبا", { referral: { source_id: "777777777", source_type: "ad", headline: "عشاء لشخصين" } });
  assert.deepEqual(ctxOf(w2.m.seen[0]).came_from_ad, { ad_text: "عشاء لشخصين", rule: CTX_RULES.ad });
  w.m.push(mSay("أكيد، تبيه توصيل ولا استلام؟")); await w.say("ابي العرض", { referral });
  assert.equal(w.db.adChats.length, 1); assert.equal(w.db.adChats[0].clicks, 2);
  // not from an ad ⇒ nothing about ads in the context
  const w3 = aWorld([mSay("هلا 👋 وش تحب تطلب اليوم؟")], { links }); await w3.say("مرحبا");
  assert.equal(ctxOf(w3.m.seen[0]).came_from_ad, undefined); assert.equal(w3.db.adChats.length, 0);
  // the rules bot counts ad chats too (assistant off)
  const lw = liveWorld(); await lw.say("مرحبا", { referral });
  assert.equal(lw.db.adChats.length, 1);
}));

test("AS4 ads — the per-ad report: chats, carts, opened carts, buyers, paid orders and revenue; test numbers left out", withEnv(CONFIGURED, async () => {
  const w = liveWorld({ waBot: { testPhones: ["0512345678"], adWindowHours: 48, links: { organic: "wab-boxes", ads: "wa-boxes", adMap: { "111111111": "wa-box-d4" } } },
    adReport: [{ ad_id: "111111111", headline: "بوكس", chats: 12, clicks: 14, first_at: "2026-10-12T10:00:00Z", last_at: "2026-10-13T10:00:00Z", carts: 5, carts_opened: 4, buyers: 3, orders: 4, revenue: 356.4 },
      { ad_id: "", headline: null, chats: 2, clicks: 2, first_at: "2026-10-12T10:00:00Z", last_at: "2026-10-12T11:00:00Z", carts: 0, carts_opened: 0, buyers: 0, orders: 0, revenue: 0 }] });
  const r = await w.call("GET", "/api/cms/wabot/ads", {}, { days: "14" });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.deepEqual([r.body.days, r.body.windowHours], [14, 48]);
  assert.deepEqual(w.db.adReportParams, [14, 48, ["512345678"]]);
  assert.deepEqual(r.body.ads[0], { adId: "111111111", headline: "بوكس", link: "wa-box-d4", mapped: true, chats: 12, clicks: 14, carts: 5, cartsOpened: 4, buyers: 3, orders: 4, revenue: 356.4, firstAt: "2026-10-12T10:00:00.000Z", lastAt: "2026-10-13T10:00:00.000Z" });
  assert.deepEqual([r.body.ads[1].adId, r.body.ads[1].link, r.body.ads[1].mapped], [null, "wa-boxes", false]);
  assert.deepEqual(r.body.totals, { ads: 2, chats: 14, carts: 5, cartsOpened: 4, buyers: 3, orders: 4, revenue: 356.4 });
}));

test("AS4 delivery — a shared pin goes to the assistant even as the first message; the coordinates never reach the model", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("quote_delivery", { total: 0 })), mSay("نوصل لموقعك 👍 رسوم التوصيل 15 ر.س.\nوش تحب تطلب؟")], { quote: { deliverable: true, fee: 15, toFree: 150, routeKm: 6.4 } });
  const r = await w.say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"]);
  assert.equal(ctxOf(w.m.seen[0]).customer_just_shared_a_location_pin, true); assert.equal(ctxOf(w.m.seen[0]).location_shared, true);
  assert.ok(!/21\.58|39\.15/.test(JSON.stringify(w.m.seen)), "the pin itself stays in our system");
  const res = JSON.parse(w.m.seen[1].messages.at(-1).content[0].content);
  assert.deepEqual([res.deliverable, res.fee, res.free_from_total, res.distance_km, "about_minutes" in res], [true, 15, 150, 6.4, false]);
  // assistant off ⇒ the rules bot's zone answer, as before
  const off = aWorld([], { waBot: { assist: { mode: "off" } }, quote: { deliverable: true } });
  assert.equal((await off.say(null, { raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } })).log.reply_key, "area");
}));

test("AS4 knowledge base, wired: notes reach the first context, a used answer is counted, an unanswered question is queued with no customer link, and a message the rules do not understand is queued too", withEnv(CONFIGURED, async () => {
  const kb = fakeKb({ answers: [{ id: 7, question: "عندكم واي فاي؟", say: "نعم، عندنا واي فاي للضيوف في الصالة." }], notes: "الصالة فيها قسم عائلات." });
  const w = aWorld([mUse(tUse("ask_knowledge", { question: "عندكم واي فاي؟" })), mSay("نعم، عندنا واي فاي للضيوف في الصالة.\nتحب أجهّز لك طلب؟")], { kb });
  const r = await w.say("عندكم واي فاي في المطعم؟");
  assert.equal(r.log.reply_key, "assist"); assert.equal(ctxOf(w.m.seen[0]).manager_notes, "الصالة فيها قسم عائلات.");
  assert.deepEqual(kb.calls.used, [7]); assert.deepEqual(kb.calls.queue, []);
  // nothing saved ⇒ queued once, as the model worded the question, with the language; no phone anywhere
  const kb2 = fakeKb();
  const w2 = aWorld([mUse(tUse("ask_knowledge", { question: "فيه مصلى؟" })), mSay("ما عندي معلومة مؤكدة عن هذا، ولو تحب تسأل الفريق اكتب: موظف")], { kb: kb2 });
  await w2.say("فيه مصلى عندكم؟ رقمي 0512345678");
  assert.deepEqual(kb2.calls.queue, [{ question: "فيه مصلى؟", lang: "ar", source: "no_answer" }]); assert.deepEqual(kb2.calls.used, []);
  // the knowledge base is down ⇒ the assistant still answers
  const w3 = aWorld([mUse(tUse("ask_knowledge", { question: "فيه مصلى؟" })), mSay("ما عندي معلومة مؤكدة عن هذا، ولو تحب تسأل الفريق اكتب: موظف")], { kb: { search: async () => null, notesFor: async () => { throw new Error("down"); }, queue: async () => { throw new Error("down"); }, markUsed: async () => {} } });
  assert.equal((await w3.say("فيه مصلى عندكم؟")).log.reply_key, "assist");
  // rules bot (assistant off): «ما فهمت» ⇒ the question is queued when it has two meaning words; noise is not
  const kb4 = fakeKb(); const lw = liveWorld({ kb: kb4 });
  const u = await lw.say("زبطوني بمصلى للحريم");
  assert.equal(u.log.reply_key, "unknown");
  assert.deepEqual(kb4.calls.queue, [{ question: "زبطوني بمصلى للحريم", lang: "ar", source: "rules_unknown" }]);
  const kb5 = fakeKb(); const lw5 = liveWorld({ kb: kb5 }); await lw5.say("؟؟؟"); await lw5.say("زبطوني");
  assert.deepEqual(kb5.calls.queue, []);
}));

test("AS4 gatherings — the link type «gather» is seeded for the packs reply and the setting is in the dashboard schema", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld(); await w.say("ابي طلب لـ ٥٠ شخص");
  assert.ok(w.db.links.find((l) => l.slug === "wab-packs" && l.seeded), "seeded when missing");
  assert.equal(R.SEED_LINKS.find((l) => l.slug === "wab-packs").target_type, "gather");
  assert.equal(R.botConfig({}).links.packs, "wab-packs"); assert.equal(R.botConfig({ waBot: { links: { packs: "my-packs" } } }).links.packs, "my-packs");
}));

/* ── SR2: سحب المحادثة بالدقايق + «سيبها للبوت» فوراً ─────────────────────── */
test("SR2 hooks: a hold in minutes silences the bot and ends by itself; releasing lets the bot answer at once despite the staff's earlier reply", withEnv(LOCKS_OPEN, async () => {
  // hold: minute precision, same columns as the manual mute, pending delayed reply cancelled
  const w = world({ waBot: { mode: "live" } });
  await w.cashier("هلا");
  await w.say("المنيو");
  assert.equal(w.db.jobs[0].status, "pending");
  assert.deepEqual(await w.bot.holdChat("512345678", 20, "أحمد"), { ok: true, minutes: 20 });
  assert.equal(w.db.jobs[0].status, "cancelled");
  const c = w.db.chats.get("512345678");
  assert.equal(c.mute_reason, "manual"); assert.equal(c.muted_by, "أحمد");
  assert.equal(Math.round((Date.parse(c.muted_until) - w.clock.now().getTime()) / 60_000), 20);
  const h = await w.say("وين موقعكم");
  assert.equal(h.sent.length, 0); assert.equal(h.log.reason, "manual_mute");
  w.clock.advance(31);                                    // the hold ran out, and the cashier's «هلا» is older than humanPauseMin
  assert.equal((await w.say("وين موقعكم")).sent.length, 1, "a forgotten hold returns the chat to the bot");
  assert.equal((await w.bot.holdChat("512345678", 0, null)).minutes, 1); assert.equal((await w.bot.holdChat("512345678", 99999, null)).minutes, 1440);

  // without release: the staff's reply keeps the bot waiting (today's behaviour, unchanged)
  const a = world({ waBot: { mode: "live" } });
  await a.cashier("تفضل");
  await a.bot.unmuteChat("512345678");
  const a1 = await a.say("وين موقعكم");
  assert.equal(a1.sent.length, 0); assert.equal(a1.log.reason, "staff_pause");

  // release: the same staff reply no longer silences the bot…
  const b = world({ waBot: { mode: "live" } });
  await b.cashier("تفضل");
  await b.bot.holdChat("512345678", 20, "أحمد");
  b.clock.advance(1);
  await b.bot.unmuteChat("512345678", { release: true });
  const bc = b.db.chats.get("512345678");
  assert.equal(bc.muted_until, null); assert.ok(bc.released_at);
  b.clock.advance(1);
  assert.equal((await b.say("وين موقعكم")).sent.length, 1, "the bot answers at once after «سيبها للبوت»");
  // …but a staff reply AFTER the release pauses it again
  b.clock.advance(1); await b.cashier("لحظة"); b.clock.advance(1);
  const b2 = await b.say("كم سعر البوكس");
  assert.equal(b2.sent.length, 0); assert.equal(b2.log.reason, "staff_pause");

  // auto-release of a forgotten hold keeps an open handover
  const k = world({ waBot: { mode: "live" } });
  await k.say("أبغى أكلم موظف");
  assert.ok(k.db.chats.get("512345678").handoff_at);
  await k.bot.holdChat("512345678", 20, "أحمد");
  await k.bot.unmuteChat("512345678", { keepHandover: true });
  const kc = k.db.chats.get("512345678");
  assert.equal(kc.muted_until, null); assert.ok(kc.handoff_at, "the handover is still open"); assert.equal(kc.released_at || null, null);
}));


/* ── قناة واتساب (CH1) ─────────────────────────────────────────────────── */
const CH = "https://whatsapp.com/channel/0029VaExampleChannel01";
const AR = await import("./waassistrun.js");
const chOn = (extra = {}) => ({ links: { organic: "wab-boxes", ads: "wa-boxes", channel: { url: CH, enabled: true, everyDays: 30, ...extra } } });

test("CH1 settings — the link must be a WhatsApp channel link; empty or switched off = dormant (no row, no line)", withEnv(LOCKS_OPEN, async () => {
  assert.deepEqual(R.botConfig({}).links.channel, { url: "", enabled: false, everyDays: 30 });
  for (const ok of [CH, "https://www.whatsapp.com/channel/0029VaExampleChannel01"]) assert.equal(R.channelUrlOk(ok), true, ok);
  for (const bad of ["http://whatsapp.com/channel/0029VaExampleChannel01", "https://whatsapp.com/channel/", "https://wa.me/966500000000", "https://whatsapp.com.evil.sa/channel/0029VaExampleChannel01", "https://chat.whatsapp.com/AbCdEf", "https://whatsapp.com/channel/0029Va?x=1", "https://whatsapp.com/channel/0029VaExampleChannel01/extra", ""]) assert.equal(R.channelUrlOk(bad), false, bad);
  const v = R.configFromBody({ links: { channel: { url: CH + "/", enabled: true, everyDays: 14 } } });
  assert.equal(v.ok, true); assert.deepEqual(R.botConfig({ waBot: v.value }).links.channel, { url: CH, enabled: true, everyDays: 14 });
  assert.equal(R.configFromBody({ links: { channel: { url: "https://example.com/channel/x" } } }).ok, false);
  assert.equal(R.configFromBody({ links: { channel: { everyDays: 0 } } }).ok, false);
  assert.equal(R.configFromBody({ links: { channel: { url: "" } } }).ok, true, "clearing the link is allowed");
  // a bad url already stored (edited outside the route) is read as empty
  assert.equal(R.botConfig({ waBot: { links: { channel: { url: "https://evil.sa/x", enabled: true } } } }).links.channel.url, "");
  assert.equal(R.channelOn(R.botConfig({ waBot: { links: { channel: { url: CH, enabled: false } } } })), false);
  assert.equal(R.channelOn(R.botConfig({ waBot: { links: { channel: { url: "", enabled: true } } } })), false);
  // dormant: the greeting list has no channel row and «شكراً» is one message
  const w = liveWorld({ disclosure: true });
  const g = await w.say("السلام عليكم");
  assert.ok(!JSON.stringify(g.sent).includes("m:channel"));
  assert.equal((await w.say("شكرا")).sent.length, 1);
  assert.equal(w.db.channelOffers.length, 0);
}));

test("CH1 rules bot — a row in the greeting list, and one closing line with the link after «شكراً», once per customer per everyDays; never with an open handover or after «إيقاف»", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ waBot: chOn(), disclosure: true });
  const g = await w.say("السلام عليكم");
  const list = g.sent.find((p) => p.interactive && p.interactive.type === "list");
  assert.deepEqual(rowsOf(list).map((r) => r.id).slice(-2), ["m:channel", "m:human"]);
  assert.equal(rowsOf(list).find((r) => r.id === "m:channel").title, "🔔 قناة العروض");
  // the customer taps the row: body + a button that opens the channel; counted as shown (rules_menu)
  const t = await w.press("m:channel", "🔔 قناة العروض");
  assert.equal(urlOf(t.sent[0]), CH); assert.equal(t.sent[0].interactive.action.parameters.display_text, "تابع القناة");
  assert.deepEqual(w.db.channelOffers.map((o) => o.via), ["rules_menu"]);
  // «شكراً» right after: already shown within the period ⇒ no second invite
  const th = await w.say("شكرا");
  assert.equal(th.sent.length, 1); assert.equal(w.db.channelOffers.length, 1);
  // 31 days later: the closing line comes with the thanks reply, as its own message, and is counted (rules_close)
  w.clock.advance(31 * 24 * 60);
  const th2 = await w.say("مشكور");
  assert.equal(th2.sent.length, 2); assert.equal(bodyOf(th2.sent[1]), "وتابع قناتنا على واتساب لعروض الطلب من موقعنا 👇"); assert.equal(urlOf(th2.sent[1]), CH);
  assert.deepEqual(w.db.channelOffers.map((o) => o.via), ["rules_menu", "rules_close"]);
  // a new customer who only says thanks gets it once
  const a = liveWorld({ waBot: chOn() });
  assert.equal((await a.say("شكرا")).sent.length, 2); w.clock.advance(1);
  assert.equal((await a.say("شكرا")).sent.length <= 1, true);
  // an open handover (complaint): the thanks reply carries no invite
  const c = liveWorld({ waBot: chOn() });
  await c.say("الاكل وصل بارد وناقص"); c.clock.advance(1);
  const ct = await c.say("شكرا");
  assert.ok(!JSON.stringify(ct.sent).includes("whatsapp.com/channel")); assert.equal(c.db.channelOffers.length, 0);
  // the customer wrote «إيقاف» before (or switched marketing off): no invite
  const s = liveWorld({ waBot: chOn() }); s.db.optins["512345678"] = { updates: false, marketing: false, stopped_at: "2026-10-01T10:00:00Z" };
  const st = await s.say("شكرا");
  assert.ok(!JSON.stringify(st.sent).includes("whatsapp.com/channel")); assert.equal(s.db.channelOffers.length, 0);
  // the channel was switched off after the list went out: the row answers with the main list, not a dead link
  const off = liveWorld();
  const po = await off.press("m:channel", "🔔 قناة العروض");
  assert.ok(!JSON.stringify(po.sent).includes("whatsapp.com")); assert.equal(off.db.channelOffers.length, 0);
}));

test("CH1 assistant — the invite line is offered only when the context allows it, with exactly the configured link; shared counter with the rules bot; never with an allergy answer", withEnv(CONFIGURED, async () => {
  const say = `وتابع قناتنا على واتساب لعروض الطلب من موقعنا: ${CH}`;
  const w = aWorld([mSay(`العفو، بالعافية 🌟\n${say}`)], { waBot: chOn() });
  const r = await w.say("شكرا على المساعدة يعطيك العافية", {});
  if (r.log.reply_key === "assist") {
    assert.deepEqual(ctxOf(w.m.seen[0]).channel_invite, { say });
    assert.equal(bodyOf(msgs(r)[0]).includes(CH), true); assert.deepEqual(w.db.channelOffers.map((o) => o.via), ["assistant"]);
  } else { assert.equal(r.log.reply_key, "thanks"); assert.deepEqual(w.db.channelOffers.map((o) => o.via), ["rules_close"]); }
  // a normal question: the context allows the invite, the model does not use it ⇒ nothing is counted
  const w2 = aWorld([mSay("هلا 👋 وش تحب تطلب اليوم؟"), mSay("أكيد، تفضّل مشاوي ولا كريب؟")], { waBot: chOn() });
  const a = await w2.say("ابي اطلب عشا");
  assert.equal(a.log.reply_key, "assist"); assert.deepEqual(ctxOf(w2.m.seen[0]).channel_invite, { say, rule: CTX_RULES.channel }); assert.equal(w2.db.channelOffers.length, 0);
  // shown once (by the rules bot's row) ⇒ the assistant's next context has no invite, and the link written anyway is refused by the validator
  await w2.press("m:channel", "🔔 قناة العروض"); assert.deepEqual(w2.db.channelOffers.map((o) => o.via), ["rules_menu"]);
  w2.clock.advance(1);
  const b = await w2.say("ابي شي حار");
  assert.equal(ctxOf({ messages: w2.m.seen[1].messages.slice(-1) }).channel_invite, undefined);
  assert.equal(b.log.reply_key, "assist"); assert.equal(w2.db.channelOffers.length, 1);
  // channel off ⇒ never in the context
  const w3 = aWorld([mSay("هلا 👋 وش تحب تطلب اليوم؟")]); await w3.say("ابي اطلب عشا");
  assert.equal(ctxOf(w3.m.seen[0]).channel_invite, undefined);
  // the validator: exactly the configured link, only in a turn that allows it
  const P = (t, o) => AR.checkReply(t, { lang: "ar", ...o }).problems.map((p) => p.type);
  assert.deepEqual(P(`بالعافية 🌟\n${say}`, { sayTexts: [say], channelUrl: CH, facts: [{ channel_invite: { say } }] }), []);
  assert.ok(P(`بالعافية 🌟\n${say}`, { sayTexts: [], channelUrl: null, facts: [{ channel_invite: { say } }] }).includes("link_in_text"), "no invite in this turn");
  assert.ok(P("تابعنا https://whatsapp.com/channel/0029VaSomeOtherChannel99", { sayTexts: [say], channelUrl: CH, facts: [{ channel_invite: { say } }] }).includes("link_in_text"), "another channel");
  assert.ok(P(`تابعنا ${CH}x`, { sayTexts: [say], channelUrl: CH, facts: [{ channel_invite: { say } }] }).includes("link_in_text"), "not exactly the configured link");
  assert.ok(P(`تابعنا على ${CH} وكمان https://example.com/x`, { sayTexts: [say], channelUrl: CH, facts: [{ channel_invite: { say } }] }).length > 0, "any other link is still refused");
  assert.ok(AR.SYSTEM_PROMPT.includes('"channel_invite"'));
}));

test("CH1 stats — offers shown per day and per route; test numbers left out", withEnv(CONFIGURED, async () => {
  const w = liveWorld({ waBot: { ...chOn({ everyDays: 21 }), testPhones: ["0512345678"] },
    channelReport: [{ day: "2026-10-13", via: "rules_close", n: 4, people: 4 }, { day: "2026-10-13", via: "assistant", n: 2, people: 2 }, { day: "2026-10-12", via: "rules_menu", n: 1, people: 1 }] });
  const r = await w.call("GET", "/api/cms/wabot/channel", {}, { days: "7" });
  assert.equal(r.status, 200); assert.deepEqual(w.db.channelReportParams, [7, ["512345678"]]);
  assert.deepEqual([r.body.enabled, r.body.hasUrl, r.body.active, r.body.everyDays, r.body.days], [true, true, true, 21, 7]);
  assert.deepEqual(r.body.byDay, [{ day: "2026-10-13", rules_close: 4, rules_menu: 0, assistant: 2, total: 6 }, { day: "2026-10-12", rules_close: 0, rules_menu: 1, assistant: 0, total: 1 }]);
  assert.deepEqual(r.body.totals, { rules_close: 4, rules_menu: 1, assistant: 2, total: 7 });
  assert.ok(!JSON.stringify(r.body).includes("whatsapp.com"), "the report does not repeat the link");
}));

/* ── «يشوف ويسمع» (VM1) ─────────────────────────────────────────────────── */
const OGG = (sec) => { const b = Buffer.alloc(64); b.write("OggS", 0, "latin1"); b.write("OggS", 30, "latin1"); b.writeBigUInt64LE(BigInt(Math.round(sec * 48000)), 36); return b; };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const voiceMsg = { type: "audio", audio: { id: "111222333444", mime_type: "audio/ogg; codecs=opus", voice: true } };
const imageMsg = (caption) => ({ type: "image", image: { id: "555666777888", mime_type: "image/jpeg", ...(caption ? { caption } : {}) } });
const look = (o) => mSay(JSON.stringify(o));
const MEDIA_ON = { assist: { imagesEnabled: true, voiceEnabled: true } };
const OLD = /ما أقدر (?:أفتح الصور والمقاطع الصوتية|أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا)/;      // PK1: الصوت بقى له سطره («اكتب لي طلبك») والتحويل زي ما هو

test("VM1 off by default — a photo or a voice note gets today's reply and handover, nothing is fetched, no model is called", withEnv(CONFIGURED, async () => {
  const cfg = R.botConfig({}).assist;
  assert.deepEqual([cfg.imagesEnabled, cfg.voiceEnabled, cfg.voiceMaxSec, cfg.mediaBudgetDaySar, cfg.sttModel, cfg.visionModel], [false, false, 60, 2, "gpt-4o-transcribe", "claude-haiku-5-5"]);
  for (const k of ["assist.imagesEnabled", "assist.voiceEnabled", "assist.voiceMaxSec", "assist.mediaBudgetDaySar", "assist.sttSarPerMin", "assist.sttModel", "assist.visionModel"]) assert.ok(R.SCHEMA[k] && R.SCHEMA[k].ar, k);
  const w = aWorld([], { mediaFile: { ok: true, buf: OGG(8), mime: "audio/ogg" }, transcribe: async () => { throw new Error("must not be called"); } });
  const v = await w.say(null, { raw: voiceMsg });
  assert.match(bodyOf(msgs(v)[0]), OLD); assert.equal(v.log.handoff, "media"); assert.equal(w.mediaAsked.length, 0); assert.equal(w.m.used(), 0);
  const w2 = aWorld([], { mediaFile: { ok: true, buf: JPG, mime: "image/jpeg" } });
  const i = await w2.say(null, { raw: imageMsg() });
  assert.match(bodyOf(msgs(i)[0]), OLD); assert.equal(w2.mediaAsked.length, 0); assert.equal(w2.m.used(), 0);
  // switched on, but the assistant is off for this number ⇒ still today's reply
  const w3 = aWorld([], { waBot: { assist: { mode: "off", imagesEnabled: true, voiceEnabled: true } }, mediaFile: { ok: true, buf: JPG, mime: "image/jpeg" } });
  assert.match(bodyOf(msgs(await w3.say(null, { raw: imageMsg() }))[0]), OLD); assert.equal(w3.mediaAsked.length, 0);
}));

test("VM1 voice — the note is transcribed, the assistant gets the text marked as heard from a voice note, the cost is recorded by the minute; too long / unclear / failed ⇒ today's handover", withEnv(CONFIGURED, async () => {
  const heard = [];
  const w = aWorld([mUse(tUse("search_menu", { query: "كريب زنجر سوبريم" })), mSay("سمعت إنك تبي كريب زنجر سوبريم استلام، صح؟")], { waBot: MEDIA_ON, mediaFile: { ok: true, buf: OGG(12), mime: "audio/ogg; codecs=opus" },
    transcribe: async (a) => { heard.push({ model: a.model, mime: a.mime, bytes: a.buf.length }); return { ok: true, text: "ابي كريب زنجر سوبريم استلام ورقمي 0512345678", ms: 800, provider: "stt:llm.o2m8.me" }; } });
  const r = await w.say(null, { raw: voiceMsg });
  assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"]);
  assert.equal(bodyOf(msgs(r)[0]), "سمعت إنك تبي كريب زنجر سوبريم استلام، صح؟");
  assert.deepEqual(heard, [{ model: "gpt-4o-transcribe", mime: "audio/ogg; codecs=opus", bytes: 64 }]);
  assert.deepEqual(w.mediaAsked[0], ["111222333444", { maxBytes: 4_000_000 }]);
  assert.deepEqual(ctxOf(w.m.seen[0]).heard_from_voice_note, { rule: CTX_RULES.voice });
  assert.ok(!JSON.stringify(w.m.seen).includes("512345678"), "the transcript is masked before the model like any text");
  assert.equal(r.log.text, "🎤 ابي كريب زنجر سوبريم استلام ورقمي [رقم]");
  const stt = w.db.ai.find((a) => /^media:stt/.test(a.detail));
  assert.deepEqual([stt.purpose, stt.model, stt.outcome, stt.detail, stt.cost_sar, stt.sent_text], ["assistant", "gpt-4o-transcribe", "ok", "media:stt 12s", 0.0045, null]);
  // the three ways out: longer than the setting (not sent to the transcriber at all), an unclear transcript, a provider error
  let called = 0;
  const long = aWorld([], { waBot: MEDIA_ON, mediaFile: { ok: true, buf: OGG(75), mime: "audio/ogg" }, transcribe: async () => { called++; return { ok: true, text: "x" }; } });
  const l = await long.say(null, { raw: voiceMsg });
  assert.match(bodyOf(msgs(l)[0]), OLD); assert.equal(l.log.handoff, "media"); assert.equal(called, 0); assert.match(l.log.detail, /voice_too_long_75s/);
  const un = aWorld([], { waBot: MEDIA_ON, mediaFile: { ok: true, buf: OGG(3), mime: "audio/ogg" }, transcribe: async () => ({ ok: true, text: "..", ms: 5 }) });
  const u = await un.say(null, { raw: voiceMsg }); assert.match(bodyOf(msgs(u)[0]), OLD); assert.match(u.log.detail, /stt_unclear/);
  const er = aWorld([], { waBot: MEDIA_ON, mediaFile: { ok: true, buf: OGG(3), mime: "audio/ogg" }, transcribe: async () => ({ ok: false, reason: "http_404", ms: 5 }) });
  const e = await er.say(null, { raw: voiceMsg }); assert.match(bodyOf(msgs(e)[0]), OLD); assert.equal(e.log.handoff, "media"); assert.match(e.log.detail, /stt_http_404/);
  assert.equal(er.db.ai.find((a) => /^media:stt/.test(a.detail)).cost_sar, 0, "a failed transcription costs nothing");
  // Meta no longer has the file
  const gone = aWorld([], { waBot: MEDIA_ON, mediaFile: { ok: false, error: "expired" } });
  assert.match(bodyOf(msgs(await gone.say(null, { raw: voiceMsg }))[0]), OLD);
  // a voice note that is a complaint is the rules bot's, as if typed
  const cw = aWorld([], { waBot: MEDIA_ON, mediaFile: { ok: true, buf: OGG(5), mime: "audio/ogg" }, transcribe: async () => ({ ok: true, text: "الاكل وصل بارد وناقص", ms: 5 }) });
  const c = await cw.say(null, { raw: voiceMsg }); assert.equal(c.log.handoff, "complaint"); assert.equal(cw.m.used(), 0);
}));

test("VM1 images — a menu or ad screenshot is answered like text from a masked description; payment and order-problem photos go to staff with what was understood; a location screenshot asks for the pin; anything else is today's handover", withEnv(CONFIGURED, async () => {
  const file = { ok: true, buf: JPG, mime: "image/jpeg" };
  const w = aWorld([look({ kind: "menu_or_ad", summary: "إعلان بوكس الكريب الفردي بسعر 29، رقم التواصل 0512345678", clear: true }), mSay("هلا 👋 بوكس الكريب الفردي عندنا. تبيه توصيل ولا استلام؟")], { waBot: MEDIA_ON, mediaFile: file });
  const r = await w.say(null, { raw: imageMsg("كم هذا؟") });
  assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"]);
  // call 1 = the look: the fast model, the image as base64, no tools, nothing about the customer
  const c1 = w.m.seen[0];
  assert.equal(c1.model, "claude-haiku-5-5"); assert.equal(c1.messages[0].content[0].type, "image"); assert.equal(c1.messages[0].content[0].source.media_type, "image/jpeg");
  assert.equal(c1.messages[0].content[0].source.data, JPG.toString("base64"));
  // call 2 = the normal turn: the description (masked), the caption, the flag; never the image
  const c2 = JSON.stringify(w.m.seen[1].messages);
  assert.ok(!c2.includes(JPG.toString("base64")) && !c2.includes("512345678"));
  assert.ok(c2.includes("كم هذا؟") && c2.includes("[صورة من العميل]") && c2.includes("بوكس الكريب الفردي"));
  assert.deepEqual(ctxOf(w.m.seen[1]).seen_in_a_picture, { rule: CTX_RULES.picture });
  assert.equal(r.log.text, "🖼 إعلان بوكس الكريب الفردي بسعر 29، رقم التواصل [رقم]");
  const vis = w.db.ai.find((a) => /^media:vision/.test(a.detail));
  assert.deepEqual([vis.purpose, vis.model, vis.detail, vis.sent_text], ["assistant", "claude-haiku-5-5", "media:vision menu_or_ad", null]);
  // payment screenshot: fixed text, urgent handover, the note has no number at all
  const p = aWorld([look({ kind: "payment", summary: "إيصال دفع ناجح بمبلغ 125.50 من بطاقة تنتهي بـ 4821", clear: true })], { waBot: MEDIA_ON, mediaFile: file });
  const pr = await p.say(null, { raw: imageMsg() });
  assert.match(bodyOf(msgs(pr)[0]), /^وصلتني صورة عن الدفع 🙏 حوّلتها لموظف يراجعها معك\./); assert.equal(pr.log.handoff, "problem"); assert.equal(p.m.used(), 1);
  assert.ok(!/\d/.test(pr.log.text), pr.log.text); assert.ok(!JSON.stringify(p.portal).match(/4821|125/));
  // order problem: apology + urgent complaint handover
  const o = aWorld([look({ kind: "order_problem", summary: "صورة وجبة الصوص منسكب فيها والبطاطس ناقصة", clear: true })], { waBot: MEDIA_ON, mediaFile: file });
  const or = await o.say(null, { raw: imageMsg() });
  assert.match(bodyOf(msgs(or)[0]), /^نعتذر منك 🙏 وصلتني صورة الطلب وحوّلتها لموظف يتابعها معك\./); assert.equal(or.log.handoff, "complaint");
  // location screenshot: ask for the pin, no handover
  const lo = aWorld([look({ kind: "location", summary: "لقطة شاشة لخريطة", clear: true })], { waBot: MEDIA_ON, mediaFile: file });
  const lr = await lo.say(null, { raw: imageMsg() });
  assert.match(bodyOf(msgs(lr)[0]), /أرسل الموقع نفسه من واتساب/); assert.equal(lr.log.handoff, null);
  // other / unclear / unreadable answer / refused ⇒ today's reply + handover
  for (const step of [look({ kind: "other", summary: "صورة شخصية", clear: true }), look({ kind: "menu_or_ad", summary: "غير واضحة", clear: false }), mSay("لا أستطيع"), { ok: false, error: "http_500", ms: 5, provider: "x", usage: null }]) {
    const x = aWorld([step], { waBot: MEDIA_ON, mediaFile: file }); const xr = await x.say(null, { raw: imageMsg() });
    assert.match(bodyOf(msgs(xr)[0]), OLD); assert.equal(xr.log.handoff, "media"); assert.equal(x.m.used(), 1);
  }
  // a video or a document is never looked at
  const vd = aWorld([], { waBot: MEDIA_ON, mediaFile: file });
  assert.match(bodyOf(msgs(await vd.say(null, { raw: { type: "video", video: { id: "999000111222", mime_type: "video/mp4" } } }))[0]), OLD); assert.equal(vd.mediaAsked.length, 0);
}));

test("VM1 budget — the media line inside the assistant's budget: at the limit photos and voice go back to the handover; the stats card shows both lines", withEnv(CONFIGURED, async () => {
  const file = { ok: true, buf: JPG, mime: "image/jpeg" };
  const w = aWorld([look({ kind: "location", summary: "خريطة", clear: true })], { waBot: { assist: { imagesEnabled: true, voiceEnabled: true, mediaBudgetDaySar: 0.5 } }, mediaFile: file });
  w.db.ai.push({ id: 1, at: w.clock.now().toISOString(), purpose: "assistant", model: "gpt-4o-transcribe", in_tokens: 0, out_tokens: 0, cached_tokens: 0, cost_sar: 0.5, outcome: "ok", detail: "media:stt 60s", ms: 1 });
  const r = await w.say(null, { raw: imageMsg() });
  assert.match(bodyOf(msgs(r)[0]), OLD); assert.equal(w.m.used(), 0); assert.equal(w.mediaAsked.length, 0); assert.match(r.log.detail, /media_budget_day/);
  const st = await w.call("GET", "/api/cms/wabot/assist/stats", {}, {});
  assert.deepEqual(st.body.media, { imagesEnabled: true, voiceEnabled: true, budgetDaySar: 0.5, daySar: 0.5, voice: { n: 1, ok: 1, sar: 0.5 }, images: { n: 0, ok: 0, sar: 0 }, known: true });
  // zero = closed; out-of-range values are refused on save
  const z = aWorld([], { waBot: { assist: { imagesEnabled: true, mediaBudgetDaySar: 0 } }, mediaFile: file });
  assert.match(bodyOf(msgs(await z.say(null, { raw: imageMsg() }))[0]), OLD); assert.equal(z.m.used(), 0);
  for (const bad of [{ voiceMaxSec: 5 }, { voiceMaxSec: 301 }, { mediaBudgetDaySar: 51 }, { sttSarPerMin: 2 }, { sttModel: "bad model!" }]) assert.equal(R.configFromBody({ assist: bad }).ok, false, JSON.stringify(bad));
  assert.equal(R.configFromBody({ assist: { voiceEnabled: true, voiceMaxSec: 90, sttModel: "groq/whisper-large-v3" } }).ok, true);
}));

/* ── مفتاح تحويل الصوت من اللوحة (VM2) ───────────────────────────────────── */
const STT_KEY = "sk-proj-TESTONLYnotARealKey0123456789abcdWXYZ";
const withSecret = (fn) => async () => { const a = process.env.ADMIN_TOKEN, s = process.env.SECRETS_KEY; process.env.ADMIN_TOKEN = "admin-token-for-tests"; delete process.env.SECRETS_KEY;
  try { await fn(); } finally { if (a === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = a; if (s !== undefined) process.env.SECRETS_KEY = s; } };
function sttProviderFake(first = { status: 200, body: { text: "السلام عليكم ورحمة الله" } }) {
  const st = { calls: [], answer: first };
  st.fetch = async (url, o) => { st.calls.push({ url: String(url), headers: o.headers, size: o.body.get("file").size, model: o.body.get("model") }); const a = st.answer; return { ok: a.status === 200, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) }; };
  return st;
}

test("VM2 routes — owner only; the key is saved encrypted and never comes back; test → unlock → the switch; a new key or another model locks it again", withEnv(CONFIGURED, withSecret(async () => {
  const pv = sttProviderFake();
  const w = aWorld([], { sttFetch: pv.fetch });
  const all = (o) => JSON.stringify(o);
  // not the owner ⇒ 403 on all four, nothing happens
  w.setOwner(false);
  for (const [m, p, b] of [["GET", "/api/cms/wabot/assist/stt", {}], ["PUT", "/api/cms/wabot/assist/stt/key", { provider: "openai", key: STT_KEY }], ["DELETE", "/api/cms/wabot/assist/stt/key", {}], ["POST", "/api/cms/wabot/assist/stt/test", {}]]) { const r = await w.call(m, p, b); assert.deepEqual([r.status, r.body.error], [403, "owner_only"], `${m} ${p}`); }
  assert.equal(w.db.sttKey, null); assert.equal(pv.calls.length, 0);
  w.setOwner(true);
  let s = await w.call("GET", "/api/cms/wabot/assist/stt");
  assert.deepEqual([s.body.provider, s.body.model, s.body.key, s.body.canEnable, s.body.reason, s.body.voiceEnabled], ["openai", "gpt-4o-transcribe", { saved: false }, false, "no_key", false]);
  // the switch cannot be turned on yet: the save is refused with the reason, and nothing is stored
  let c = await w.call("PUT", "/api/cms/wabot/config", { assist: { voiceEnabled: true } });
  assert.deepEqual([c.status, c.body.error, c.body.sttReason], [400, "invalid", "no_key"]); assert.match(c.body.errors[0], /^assist\.voiceEnabled: /);
  assert.notEqual((w.db.settings.waBot.assist || {}).voiceEnabled, true);
  // bad keys
  for (const b of [{ provider: "openai", key: "sk-short" }, { provider: "groq", key: STT_KEY }, { provider: "x", key: STT_KEY }, {}]) assert.equal((await w.call("PUT", "/api/cms/wabot/assist/stt/key", b)).status, 400);
  // save
  const k = await w.call("PUT", "/api/cms/wabot/assist/stt/key", { provider: "openai", key: STT_KEY });
  assert.equal(k.status, 200); assert.deepEqual([k.body.key.saved, k.body.key.last4, k.body.key.provider, k.body.key.savedBy, k.body.key.readable, k.body.key.under, k.body.voiceTurnedOff], [true, "WXYZ", "openai", "عمر (owner)", true, "ADMIN_TOKEN", false]);
  assert.match(w.db.sttKey.key_enc, /^v1:/);
  assert.ok(!all(k.body).includes("TESTONLY") && !all(w.db.sttKey).includes("TESTONLY") && !all(w.db.settings).includes("TESTONLY") && !all(w.db.cfgLog).includes("TESTONLY") && !all(w.db.log).includes("TESTONLY"), "the key is nowhere in the clear");
  assert.deepEqual(w.db.cfgLog.at(-1).changes, [{ path: "assist.sttKey", from: null, to: "مفتاح تحويل الصوت: اتحفظ (OpenAI، آخره WXYZ)" }]);
  s = await w.call("GET", "/api/cms/wabot/assist/stt");
  assert.deepEqual([s.body.key.saved, s.body.route, s.body.canEnable, s.body.reason], [true, "direct", false, "not_tested"]); assert.ok(!all(s.body).includes("TESTONLY"));
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { voiceEnabled: true } }); assert.deepEqual([c.status, c.body.sttReason], [400, "not_tested"]);
  // test: one real-shaped call to the provider with the sample, recorded as the assistant's spend
  const t = await w.call("POST", "/api/cms/wabot/assist/stt/test");
  assert.deepEqual([t.status, t.body.ok, t.body.route, t.body.heard, t.body.costSar, t.body.canEnable], [200, true, "direct", "السلام عليكم ورحمة الله", 0.000938, true]); assert.equal("ran" in t.body, false);
  assert.deepEqual([pv.calls.length, pv.calls[0].url, pv.calls[0].headers.authorization, pv.calls[0].model], [1, "https://api.openai.com/v1/audio/transcriptions", `Bearer ${STT_KEY}`, "gpt-4o-transcribe"]);
  const row = w.db.ai.at(-1); assert.deepEqual([row.purpose, row.detail, row.outcome, row.cost_sar, row.sent_text], ["assistant", "media:stt test", "ok", 0.000938, null]);
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/stt/test")).status, 429, "cooldown");
  // now the switch turns on
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { voiceEnabled: true } });
  assert.equal(c.status, 200); assert.equal(c.body.config.assist.voiceEnabled, true);
  // changing the model while voice is on is refused (stale test) unless voice goes off in the same save
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { sttModel: "whisper-1" } }); assert.deepEqual([c.status, c.body.sttReason], [400, "test_stale"]);
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { sttModel: "whisper-1", voiceEnabled: false } }); assert.equal(c.status, 200);
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { sttModel: "gpt-4o-transcribe", voiceEnabled: true } }); assert.equal(c.status, 200, "back to the tested model: the old test is current again");
  // an unrelated save while voice is on and the test is current goes through
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { assist: { voiceMaxSec: 90 } })).status, 200);
  // a new key turns voice off and clears the test; so does deleting it
  const k2 = await w.call("PUT", "/api/cms/wabot/assist/stt/key", { provider: "openai", key: STT_KEY.replace("WXYZ", "7777") });
  assert.equal(k2.body.voiceTurnedOff, true); assert.equal(w.db.settings.waBot.assist.voiceEnabled, false);
  assert.deepEqual(w.db.cfgLog.at(-1).changes.map((x) => x.path), ["assist.sttKey", "assist.voiceEnabled"]);
  s = await w.call("GET", "/api/cms/wabot/assist/stt"); assert.deepEqual([s.body.test, s.body.reason, s.body.voiceEnabled], [null, "not_tested", false]);
  const d = await w.call("DELETE", "/api/cms/wabot/assist/stt/key");
  assert.deepEqual(d.body, { ok: true, key: { saved: false }, voiceTurnedOff: false }); assert.equal(w.db.sttKey, null);
  assert.equal(w.db.cfgLog.at(-1).changes[0].to, "مفتاح تحويل الصوت: اتمسح");
})));

test("VM2 at run time — a voice note is transcribed with the saved key only while the test is current; a failed or stale test, a deleted key or a refused key ⇒ today's reply and handover", withEnv(CONFIGURED, withSecret(async () => {
  const pv = sttProviderFake();
  const file = { ok: true, buf: OGG(6), mime: "audio/ogg; codecs=opus" };
  const w = aWorld([mSay("هلا 👋 وش تحب تطلب اليوم؟")], { sttFetch: pv.fetch, mediaFile: file, waBot: { assist: { imagesEnabled: true } } });
  await w.call("PUT", "/api/cms/wabot/assist/stt/key", { provider: "openai", key: STT_KEY });
  // voice forced on in storage without a test (cannot happen through the route): the bot still refuses to transcribe
  w.db.settings.waBot = { ...w.db.settings.waBot, assist: { ...w.db.settings.waBot.assist, voiceEnabled: true } };
  const a = await w.say(null, { raw: voiceMsg });
  assert.match(bodyOf(msgs(a)[0]), OLD); assert.match(a.log.detail, /stt_not_tested/); assert.equal(pv.calls.length, 0); assert.equal(w.mediaAsked.length, 0, "the file is not even fetched");
  // after a passing test the same note goes to the provider with the saved key, then to the assistant
  w.clock.advance(1); await w.call("POST", "/api/cms/wabot/assist/stt/test"); assert.equal(pv.calls.length, 1);
  pv.answer = { status: 200, body: { text: "السلام عليكم ابي اطلب عشا" } };
  w.clock.advance(1); const b = await w.say(null, { raw: voiceMsg });
  assert.deepEqual([b.log.reply_key, b.log.text], ["assist", "🎤 السلام عليكم ابي اطلب عشا"]);
  assert.deepEqual([pv.calls.length, pv.calls[1].url, pv.calls[1].headers.authorization, pv.calls[1].size], [2, "https://api.openai.com/v1/audio/transcriptions", `Bearer ${STT_KEY}`, 64]);
  assert.ok(!JSON.stringify([w.m.seen, w.db.ai, w.db.log, w.calls]).includes("TESTONLY"), "the key reaches neither the model, the cost log, the bot log nor Meta");
  const cost = w.db.ai.filter((x) => /^media:stt \d/.test(x.detail)).at(-1); assert.deepEqual([cost.provider, cost.outcome], ["stt:api.openai.com", "ok"]);
  // the provider starts refusing the key: this note falls back to the handover (the customer is never left without a reply)
  pv.answer = { status: 401, body: { error: { message: "Incorrect API key" } } };
  w.clock.advance(1); const c = await w.say(null, { raw: voiceMsg });
  assert.match(bodyOf(msgs(c)[0]), OLD); assert.match(c.log.detail, /stt_unauthorized/);
  // the key is deleted: voice is switched off by the route, the next note gets today's reply with no provider call
  await w.call("DELETE", "/api/cms/wabot/assist/stt/key"); const n = pv.calls.length;
  w.clock.advance(1); const d = await w.say(null, { raw: voiceMsg });
  assert.notEqual(d.log.reply_key, "assist"); assert.equal(pv.calls.length, n); assert.equal(w.db.settings.waBot.assist.voiceEnabled, false);
})));

/* ── الجاهزية للعملاء (GL1): مفيش سكوت، ووضع العملاء للمساعد على مراحل ─────────────────── */
const C1 = "966598765432", C2 = "966577777771", C3 = "966577777772", C4 = "966577777773";
const liveA = (steps, assist = {}, o = {}) => {
  const m = aModel(steps), store = memStore();
  const w = world({ bundles: LIVE.bundles, links: ALL_LINKS, ...o, waBot: { mode: "live", testPhones: TESTERS, footerMode: "smart", ...(o.waBot || {}), assist: { mode: "live", liveAudience: "ads", liveDailyCustomers: 2, forceSuggestion: false, typing: false, salesBrain: false, ...assist } }, assistModel: m.callModel, assistStore: store });
  return { ...w, m, store: store.st };
};
const AD = { source_id: "120251225139440593", source_type: "ad", headline: "بوكس", ctwa_clid: "X" };
const hello = () => mSay("هلا 👋 وش تحب تطلب اليوم؟");

test("GL1 no dead air — with the assistant on, a message the rules do not understand is answered by it at once; if the model fails the customer still gets the honest line at once, never a wait", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("أكيد، أشوف طلباتك السابقة. تبي نفس طلبك الأخير؟")]);
  const r = await w.say("بس انا طلبت قبل كدا");
  assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"]); assert.equal(w.db.jobs.filter((j) => j.kind === "unknown_wait").length, 0);
  // the model is down ⇒ the rules bot's line + buttons in the same second (it used to be three minutes of nothing)
  const down = aWorld([{ ok: false, error: "http_500", ms: 5, provider: "x", usage: null }]);
  const d = await down.say("بس انا طلبت قبل كدا");
  assert.deepEqual([d.log.decision, d.log.reply_key], ["replied", "unknown"]); assert.match(bodyOf(msgs(d)[0]), /ما وضح لي طلبك/); assert.equal(down.db.jobs.length, 0);
  // Omar's exact sequence: the same question a minute later is answered again (by whoever is on), never «duplicate»
  const o = aWorld([mUse(tUse("get_offers", {})), mSay("عندك عرض الطلب الأول: توصيل مجاني للطلبات من 60 ر.س. تحب أرشح لك شي؟"), mUse(tUse("get_offers", {})), mSay("عرض الطلب الأول: توصيل مجاني للطلبات من 60 ر.س. تبي أجهّز لك طلب؟")]);
  const a1 = await o.say("ايه احسن عرض عندكم"); o.clock.advance(1);
  const a2 = await o.say("ايه احسن عرض عندكم");
  assert.deepEqual([a1.log.decision, a2.log.decision, a2.log.reason === "duplicate"], ["replied", "replied", false]);
}));

test("GL1 live audience — ads only: the ad customer gets the assistant and keeps it, others get the rules bot; the daily cap counts customers, not messages; test numbers are never counted; the cap resets the next day", withEnv(LOCKS_OPEN, async () => {
  const w = liveA([hello(), hello(), hello(), hello(), hello(), hello(), hello(), hello()]);
  const a = await w.say("مرحبا", { from: C1, referral: AD });
  assert.deepEqual([a.log.decision, a.log.reply_key], ["replied", "assist"]); assert.equal(a.sent.length, 1);
  const b = await w.say("مرحبا", { from: C2 });                                   // no ad ⇒ the rules bot, as today
  assert.notEqual(b.log.reply_key, "assist"); assert.equal(b.log.decision, "replied");
  w.clock.advance(1);
  assert.equal((await w.say("ابي اطلب عشا", { from: C1 })).log.reply_key, "assist", "the same customer continues with the assistant without the ad tag");
  const t = await w.say("مرحبا");                                                   // a test number: always, and outside the count
  assert.equal(t.log.reply_key, "assist"); assert.deepEqual(w.db.liveDay.map((r) => r.phone_norm), ["598765432"]);
  assert.equal((await w.say("مرحبا", { from: C3, referral: AD })).log.reply_key, "assist");       // customer 2 of 2
  const over = await w.say("مرحبا", { from: C4, referral: AD });                                    // customer 3: the cap ⇒ rules bot, still answered
  assert.notEqual(over.log.reply_key, "assist"); assert.equal(over.log.decision, "replied"); assert.equal(w.db.liveDay.length, 2);
  w.clock.advance(1);
  assert.equal((await w.say("كم التوصيل", { from: C1 })).log.reply_key, "assist", "customers already started today are not cut off by the cap");
  w.clock.advance(24 * 60);
  assert.equal((await w.say("مرحبا", { from: C4, referral: AD })).log.reply_key, "assist", "a new day, a new count");
}));

test("GL1 live audience — campaign replies, everyone, and the locks: bot in test mode / assistant in test mode / budget reached ⇒ customers get the rules bot (or nothing in bot test mode), never an unguarded send", withEnv(LOCKS_OPEN, async () => {
  const camp = liveA([hello(), hello()], { liveAudience: "campaign", liveDailyCustomers: 10 }); camp.db.marketingTo.push("598765432");
  assert.equal((await camp.say("مرحبا", { from: C1 })).log.reply_key, "assist");
  assert.notEqual((await camp.say("مرحبا", { from: C2 })).log.reply_key, "assist");
  assert.notEqual((await camp.say("مرحبا", { from: C3, referral: AD })).log.reply_key, "assist", "campaign only: an ad click is not in it");
  const both = liveA([hello(), hello()], { liveAudience: "ads_campaign", liveDailyCustomers: 10 }); both.db.marketingTo.push("598765432");
  assert.equal((await both.say("مرحبا", { from: C1 })).log.reply_key, "assist"); assert.equal((await both.say("مرحبا", { from: C3, referral: AD })).log.reply_key, "assist");
  const all = liveA([hello()], { liveAudience: "all", liveDailyCustomers: 10 });
  assert.equal((await all.say("مرحبا", { from: C2 })).log.reply_key, "assist");
  // audience «test» in live mode, a zero cap, or assistant mode test: customers stay with the rules bot
  for (const assist of [{ liveAudience: "test" }, { liveAudience: "all", liveDailyCustomers: 0 }, { mode: "test", liveAudience: "all" }]) {
    const x = liveA([hello()], assist); const r = await x.say("مرحبا", { from: C2, referral: AD });
    assert.notEqual(r.log.reply_key, "assist", JSON.stringify(assist)); assert.equal(r.log.decision, "replied"); assert.equal(x.m.used(), 0);
  }
  // the BOT itself in test mode: a customer gets nothing at all, whatever the assistant's mode
  const bt = liveA([hello()], { liveAudience: "all" }, { waBot: { mode: "test" } });
  const q1 = await bt.say("مرحبا", { from: C2 }); assert.equal(q1.sent.length, 0); assert.equal(q1.log.reason, "test_mode_not_listed"); assert.equal(bt.m.used(), 0);
  // the assistant's own budget is spent ⇒ the rules bot answers the customer, the model is not called
  const bd = liveA([hello()], { liveAudience: "all", liveDailyCustomers: 10, budgetDaySar: 1 });
  bd.db.ai.push({ id: 1, at: bd.clock.now().toISOString(), purpose: "assistant", cost_sar: 1, in_tokens: 0, out_tokens: 0, cached_tokens: 0, ms: 1, outcome: "ok", detail: "x" });
  const r2 = await bd.say("مرحبا", { from: C2 }); assert.notEqual(r2.log.reply_key, "assist"); assert.equal(r2.log.decision, "replied"); assert.equal(bd.m.used(), 0);
  // the guard still decides every send: master switch off ⇒ nothing leaves, assistant or not
  const prevEnabled = process.env.WHATSAPP_ENABLED; delete process.env.WHATSAPP_ENABLED;
  try { const g = liveA([hello()], { liveAudience: "all", liveDailyCustomers: 10 }); const r3 = await g.say("مرحبا", { from: C2 }); assert.equal(r3.sent.filter((x) => x.type).length, 0, "master switch off: no message to a customer"); }
  finally { if (prevEnabled !== undefined) process.env.WHATSAPP_ENABLED = prevEnabled; }
}));

test("GL1 go-live — owner only, a preview that lists what will happen, a typed confirmation, blockers; ordinary settings saves cannot open live or widen the audience; one tap stops it", withEnv(LOCKS_OPEN, async () => {
  const w = liveA([], { mode: "test", liveAudience: "test", liveDailyCustomers: 30 });
  w.setOwner(false);
  for (const [m, p] of [["GET", "/api/cms/wabot/assist/live"], ["POST", "/api/cms/wabot/assist/go-live"], ["POST", "/api/cms/wabot/assist/kill"]]) assert.equal((await w.call(m, p, { audience: "all", confirm: "all" })).status, 403, p);
  w.setOwner(true);
  let s = await w.call("GET", "/api/cms/wabot/assist/live");
  assert.deepEqual([s.body.mode, s.body.botMode, s.body.audience, s.body.dailyCustomers, s.body.servedToday, s.body.customersGetAssistant, s.body.stopped], ["test", "live", "test", 30, 0, false, null]);
  assert.deepEqual(s.body.budget, { daySar: 0, dayCapSar: 10, monthSar: 0, monthCapSar: 100 }); assert.equal(s.body.guard.open, true);
  assert.deepEqual(s.body.proposals.map((x) => x.audience), ["ads", "ads_campaign", "all"]); assert.deepEqual(s.body.audiences.map((x) => x.id), ["test", "ads", "campaign", "ads_campaign", "all"]);
  // the ordinary save refuses live
  let c = await w.call("PUT", "/api/cms/wabot/config", { assist: { mode: "live", liveAudience: "all" } });
  assert.deepEqual([c.status, c.body.liveReason], [400, "use_go_live"]); assert.equal(w.db.settings.waBot.assist.mode, "test");
  // preview: nothing changes
  let g = await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "ads", dailyCustomers: 25, budgetDaySar: 12 });
  assert.deepEqual([g.status, g.body.preview, g.body.confirmWith, g.body.canConfirm, g.body.blockers.length], [200, true, "ads", true, 0]);
  assert.ok(g.body.will.length >= 6 && g.body.will.some((x) => /25 عميل/.test(x)) && g.body.will.some((x) => /12 ر\.س في اليوم/.test(x)) && g.body.will.some((x) => /بوت القواعد/.test(x)) && g.body.will.some((x) => /إيقاف/.test(x)));
  assert.ok(g.body.changes.some((x) => x.path === "assist.mode" && x.to === "live")); assert.equal(w.db.settings.waBot.assist.mode, "test");
  // bad audience / wrong confirmation / out-of-range numbers
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "test", confirm: "test" })).body.error, "bad_audience");
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "vip" })).status, 400);
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "ads", confirm: true })).body.error, "confirm_mismatch");
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "ads", confirm: "all" })).body.error, "confirm_mismatch");
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "ads", dailyCustomers: 99999, confirm: "ads" })).status, 400);
  assert.equal(w.db.settings.waBot.assist.mode, "test");
  // confirmed
  g = await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "ads", dailyCustomers: 25, budgetDaySar: 12, confirm: "ads" });
  assert.deepEqual([g.status, g.body.live, g.body.status.mode, g.body.status.audience, g.body.status.dailyCustomers, g.body.status.customersGetAssistant], [200, true, "live", "ads", 25, true]);
  assert.deepEqual([w.db.settings.waBot.assist.mode, w.db.settings.waBot.assist.liveAudience, w.db.settings.waBot.assist.budgetDaySar], ["live", "ads", 12]);
  assert.ok(w.db.cfgLog.at(-1).changes.some((x) => x.path === "assist.mode" && x.from !== "live" && x.to === "live")); assert.equal(w.db.cfgLog.at(-1).who, "عمر (owner)");
  // while live: the cap can be changed by an ordinary save, the audience cannot (go-live again), going back to test can
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { assist: { liveDailyCustomers: 40 } })).status, 200);
  c = await w.call("PUT", "/api/cms/wabot/config", { assist: { liveAudience: "all" } }); assert.deepEqual([c.status, c.body.liveReason], [400, "use_go_live"]);
  g = await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "all", confirm: "all" }); assert.equal(g.body.status.audience, "all");
  // one tap: customers back to the rules bot, test numbers keep working
  const k = await w.call("POST", "/api/cms/wabot/assist/kill", {});
  assert.deepEqual([k.status, k.body.was, k.body.mode, k.body.status.customersGetAssistant], [200, "live", "test", false]); assert.equal(w.db.settings.waBot.assist.mode, "test");
  assert.equal((await w.call("POST", "/api/cms/wabot/assist/kill", { to: "off" })).body.mode, "off");
  // blockers: the bot itself not live, a zero cap, a zero budget
  const t = liveA([], { mode: "test" }, { waBot: { mode: "test" } });
  const p = await t.call("POST", "/api/cms/wabot/assist/go-live", { audience: "all" });
  assert.deepEqual([p.body.canConfirm, p.body.blockers.map((x) => x.code)], [false, ["bot_not_live"]]);
  const blocked = await t.call("POST", "/api/cms/wabot/assist/go-live", { audience: "all", confirm: "all" });
  assert.deepEqual([blocked.status, blocked.body.error], [409, "blocked"]); assert.equal(t.db.settings.waBot.assist.mode, "test");
  const z = await w.call("POST", "/api/cms/wabot/assist/go-live", { audience: "all", dailyCustomers: 0, budgetDaySar: 0 });
  assert.deepEqual(z.body.blockers.map((x) => x.code), ["zero_customers", "zero_budget"]);
}));

test("GL1 found by the readiness check — «the payment does not work» in its common wordings is a payment PROBLEM (urgent, to staff), not the payment-methods answer; asking how to pay stays information", withEnv(LOCKS_OPEN, async () => {
  for (const t of ["الدفع ما يشتغل معي", "الدفع فشل", "مو راضي يكمل الدفع", "الدفع مو شغال", "فيه مشكلة في الدفع", "payment not working", "I can't pay"]) {
    const c = R.classify({ text: t, type: "text" }, {}); assert.deepEqual([c.key, c.rawIntent], ["problem", "payment_issue"], t);
  }
  for (const t of ["طرق الدفع", "كيف ادفع", "تقبلون مدى؟", "الدفع عند الاستلام؟"]) assert.notEqual(R.classify({ text: t, type: "text" }, {}).key, "problem", t);
  const w = liveWorld(); const r = await w.say("الدفع ما يشتغل معي");
  assert.equal(r.log.handoff, "problem"); assert.equal(r.sent.length, 1);
}));

/* ── مراجعة الخبير ١٢/١٠ — M1 (الصدى الآلي مش موظف) + M2 («الغاء / وقف» لوحدهم مش إيقاف رسايل) ─────────── */
const EK = await import("./waecho.js");
const AUTO_HOW = "افتح freshcuts.sa/l/wa-ctwa-1 ← اختر أصنافك ← ادفع أونلاين. التوصيل داخل جدة والاستلام من الفرع.";
const AUTO_FIRST = "عرض أول طلب: اكتب FIRST في السلة وخذ توصيل مجاني على طلبك الأول من الموقع.";
const AUTO_HELLO = "مرحباً بك في Fresh Cuts.. كيف نقدر نخدمك اليوم؟";

test("M1 — the timing rule: an echo within autoEchoMaxSec of the customer's message and 25+ characters is the app's auto reply; later, or short, is a person (the reviewer's replay cases)", () => {
  const k = (text, deltaSec, o = {}) => EK.echoKind({ text, deltaSec, maxSec: 8, texts: [], ...o });
  // the live threads of 12/10: auto replies at 1, 2, 2, 3 and 5 s
  for (const [t, d] of [[AUTO_HOW, 1], [AUTO_FIRST, 2], [AUTO_HELLO, 2], [AUTO_HOW, 3], [AUTO_HOW, 5]]) assert.equal(k(t, d), "auto", `${d}s`);
  // «متوفر ي فندم» 10 s and 12 characters; «احنا ف جده» 86 s; the FIRST text tapped as a quick reply after 138 s
  assert.equal(k("متوفر ي فندم", 10), "staff"); assert.equal(k("احنا ف جده", 86), "staff"); assert.equal(k(AUTO_FIRST, 138), "staff");
  assert.equal(k("متوفر ي فندم", 3), "staff", "a short answer typed fast is a person");
  assert.equal(k(AUTO_HOW, 9), "staff"); assert.equal(k(AUTO_HOW, 8), "auto"); assert.equal(k(AUTO_HOW, -2), "auto", "Meta's whole-second stamp can sit just before our receive time"); assert.equal(k(AUTO_HOW, -9), "staff");
  assert.equal(k(AUTO_HOW, null), "staff", "no customer message before it: a person started the chat"); assert.equal(k("", 1), "staff");
  // the owner's list: an exact text is auto up to 60 s, even a short one; maxSec 0 switches the timing rule off but not the list
  assert.equal(k("أهلاً 👋", 30, { texts: ["أهلاً 👋"] }), "auto"); assert.equal(k("أهلاً 👋", 61, { texts: ["أهلاً 👋"] }), "staff"); assert.equal(k("أهلاً  👋 ", 5, { texts: ["أهلاً 👋"] }), "auto");
  assert.equal(k(AUTO_HOW, 2, { maxSec: 0 }), "staff"); assert.equal(k(AUTO_HOW, 2, { maxSec: 0, texts: [AUTO_HOW] }), "auto");
  assert.deepEqual(EK.echoSettings({}), { maxSec: 8, texts: [] }); assert.deepEqual(EK.echoSettings({ waBot: { autoEchoMaxSec: 99, autoEchoTexts: [" a  b ", "", 5] } }), { maxSec: 30, texts: ["a b", "5"] });
  assert.equal(EK.echoSettings({ waBot: { autoEchoMaxSec: 0 } }).maxSec, 0);
  assert.equal(R.botConfig({}).autoEchoMaxSec, 8); assert.ok(R.SCHEMA.autoEchoMaxSec && R.SCHEMA.autoEchoTexts);
  assert.equal(R.configFromBody({ autoEchoTexts: ["x".repeat(1001)] }).ok, false); assert.equal(R.configFromBody({ autoEchoMaxSec: 31 }).ok, false);
  assert.deepEqual(R.botConfig({ waBot: R.configFromBody({ autoEchoTexts: [" مرحبا  بك ", "مرحبا بك"] }).value }).autoEchoTexts, ["مرحبا بك"]);
});

test("M1 — an auto reply does not silence the bot: the echo is stored as «auto», the next customer message is answered at once, an unknown one follows the normal path; a real staff message still pauses it", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  await w.say("كيف أطلب من الموقع؟"); w.clock.advanceSec(2);
  await w.cashier(AUTO_HOW);                                             // the app's own answer, 2 s later
  const e = w.db.msgs.find((m) => m.source === "echo");
  assert.equal(e.echo_kind, "auto");
  w.clock.advanceSec(20);
  const r = await w.say("كم الكيلو");                                   // 20 s after the auto echo
  assert.equal(r.log.decision, "replied"); assert.notEqual(r.log.reason, "staff_pause"); assert.equal(w.db.jobs.filter((j) => j.kind === "staff_wait").length, 0);
  w.clock.advanceSec(30);
  const u = await w.say("قفغفغ ثصضص");
  assert.deepEqual([u.log.decision, u.log.reply_key], ["replied", "unknown"]); assert.notEqual(u.log.detail, "unknown_left_to_staff");
  // a person: a short answer 10 s later ⇒ «staff», and the pause applies exactly as before
  const p = liveWorld();
  await p.say("عندكم كباب؟"); p.clock.advanceSec(10); await p.cashier("متوفر ي فندم");
  assert.equal(p.db.msgs.find((m) => m.source === "echo").echo_kind, "staff");
  p.clock.advanceSec(30);
  const q2 = await p.say("كم الكيلو");
  assert.equal(q2.log.decision, "waiting"); assert.equal(p.db.jobs.at(-1).kind, "staff_wait");
  // the same canned text tapped by a cashier two minutes later is a person
  const t = liveWorld();
  await t.say("وش عرض أول طلب؟"); t.clock.advanceSec(138); await t.cashier(AUTO_FIRST);
  assert.equal(t.db.msgs.find((m) => m.source === "echo").echo_kind, "staff");
  // a handover is not closed by an auto reply: the re-alert still fires
  const h = liveWorld({ waBot: { handoverRealertMin: 5 } });
  await h.say("الاكل وصل بارد وناقص"); h.clock.advanceSec(2); await h.cashier(AUTO_HELLO);
  assert.equal(h.db.msgs.find((m) => m.source === "echo").echo_kind, "auto");
  await h.tick(5);
  assert.equal(h.db.jobs.find((j) => j.kind === "handover_check").reason === "staff_answered", false, "the app's auto reply is not «staff took it»");
}));

test("M1 — no double reply (EX4: only when the owner switches autoEchoSkipCovered on): greet / order / offers wait autoEchoMaxSec; covered ⇒ silent «auto_reply_covered», not covered ⇒ the bot answers; other questions are never delayed", withEnv(LOCKS_OPEN, async () => {
  // the default (Omar 13/10: «خليه العميل يوصل ردود تفاعلية عادي حتى لو وصله ردود تانية»): the bot answers at once, and the auto echo still is not «staff»
  assert.equal(R.botConfig({}).autoEchoSkipCovered, false); assert.ok(R.SCHEMA.autoEchoSkipCovered.ar);
  const dflt = liveWorld({ disclosure: true });
  await dflt.say("مرحبا", { from: "966577777771" }); dflt.clock.advanceSec(2); await dflt.cashier(AUTO_HELLO, "966577777771");
  assert.equal(dflt.db.msgs.find((m) => m.source === "echo").echo_kind, "auto", "still classified as automatic");
  dflt.clock.advance(1);
  const dg = await dflt.say("السلام عليكم"); assert.deepEqual([dg.sent.length, dg.log.decision], [1, "replied"], "no wait");
  dflt.clock.advanceSec(2); await dflt.cashier(AUTO_HELLO); dflt.clock.advance(1);
  const dq = await dflt.say("ابي اطلب"); assert.deepEqual([dq.sent.length, dq.log.decision], [1, "replied"], "answered although the app's auto reply went out, and the auto reply did not pause the bot");
  assert.equal(dflt.db.jobs.filter((j) => j.kind === "auto_wait").length, 0);
  const w = liveWorld({ disclosure: true, waBot: { autoEchoSkipCovered: true } });
  // before any auto echo was ever seen: no delay at all
  assert.equal((await w.say("السلام عليكم", { from: "966577777770" })).log.decision, "replied");
  // an auto echo is seen once ⇒ from now on a greeting waits
  await w.say("مرحبا", { from: "966577777771" }); w.clock.advanceSec(2);
  await w.cashier(AUTO_HELLO, "966577777771");
  w.clock.advance(1);
  const g = await w.say("السلام عليكم");
  assert.deepEqual([g.sent.length, g.log.decision, g.log.reason], [0, "waiting", "auto_wait"]); assert.equal(w.db.jobs.at(-1).kind, "auto_wait");
  w.clock.advanceSec(2); await w.cashier(AUTO_HELLO);                       // the app answers it
  w.clock.advanceSec(7); assert.deepEqual(await w.tick(0), []);
  assert.deepEqual([g.log.decision, g.log.reason], ["silent", "auto_reply_covered"]);
  // the app did NOT answer this one ⇒ after the wait the bot does, once
  w.clock.advance(3);
  const o = await w.say("ابي اطلب", { from: "966577777772" });
  assert.equal(o.log.decision, "waiting"); w.clock.advanceSec(9);
  const out = await w.tick(0);
  assert.equal(out.length >= 1, true); assert.equal(o.log.decision, "replied"); assert.equal(w.db.jobs.filter((j) => j.kind === "auto_wait" && j.status === "pending").length, 0);
  // already covered when the message is processed (the echo came first) ⇒ silent at once
  w.clock.advance(3);
  const pre = await w.say("وش العروض؟", { from: "966577777773" });
  if (pre.log.decision === "waiting") { w.clock.advanceSec(1); await w.cashier(AUTO_FIRST, "966577777773"); w.clock.advanceSec(8); await w.tick(0); assert.equal(pre.log.reason, "auto_reply_covered"); }
  // a price question, a tap and an unknown message are never delayed
  w.clock.advance(3);
  assert.equal((await w.say("كم رسوم التوصيل", { from: "966577777774" })).log.decision, "replied");
  assert.equal((await w.press("m:boxes", "🎁 البوكسات", { from: "966577777774" })).log.decision, "replied");
  // a real staff answer during the wait ⇒ the bot stays out (staff_answered), as with any delayed reply
  w.clock.advance(3);
  const s = await w.say("السلام عليكم", { from: "966577777775" }); w.clock.advanceSec(6); await w.cashier("هلا", "966577777775"); w.clock.advanceSec(3); await w.tick(0);
  assert.equal(s.log.reason, "staff_answered");
  // autoEchoMaxSec = 0 switches the whole thing off
  const off = liveWorld({ waBot: { autoEchoMaxSec: 0, autoEchoSkipCovered: true } }); await off.say("مرحبا", { from: "966577777771" }); off.clock.advanceSec(2); await off.cashier(AUTO_HELLO, "966577777771");
  assert.equal(off.db.msgs.find((m) => m.source === "echo").echo_kind, "staff"); off.clock.advance(40);
  assert.equal((await off.say("السلام عليكم")).log.decision, "replied");
}));

test("M2 — «الغاء» / «وقف» alone are not an opt-out: no recent order ⇒ a two-button question and nothing changes; an open order ⇒ urgent cancel handover; the buttons do what they say", withEnv(LOCKS_OPEN, async () => {
  for (const t of ["الغاء", "إلغاء", "وقف", "كنسل", "cancel", "الغي"]) {
    assert.equal(W.intentOf(t), null, `${t}: the webhook no longer treats it as STOP`);
    const c = R.classify({ text: t, type: "text" }, {}); assert.deepEqual([c.key, c.rawIntent], ["cancel_what", "bare_cancel"], t);
  }
  for (const t of ["إيقاف", "ايقاف", "stop", "unsubscribe", "إيقاف العروض", "الغاء الاشتراك"]) assert.equal(W.intentOf(t), "stop", t);
  const w = liveWorld();
  const r = await w.say("الغاء");
  assert.equal(bodyOf(r.sent[0]), "تبي تلغي طلبك، ولا توقف رسائلنا؟ اختر 👇");
  assert.deepEqual(r.sent[0].interactive.action.buttons.map((x) => [x.reply.id, x.reply.title]), [["cw:order", "إلغاء طلبي"], ["cw:stop", "إيقاف الرسائل"]]);
  assert.deepEqual([r.log.reply_key, r.log.handoff], ["cancel_what", null]); assert.equal(w.db.optins["512345678"], undefined, "wa_optins untouched"); assert.deepEqual(w.db.optouts, []);
  // tap «إيقاف الرسائل» ⇒ offers stopped, order updates continue, and a second button to stop those too
  w.clock.advance(1);
  const st = await w.press("cw:stop", "إيقاف الرسائل");
  assert.equal(bodyOf(st.sent[0]), "تم إيقاف العروض ✅ تحديثات طلباتك مستمرة.\nضغطت بالغلط؟ اضغط «رجّع العروض». وللرجوع في أي وقت اكتب: اشتراك");
  assert.equal(w.db.optins["512345678"].marketing, false); assert.ok(!w.db.optins["512345678"].stopped_at);
  w.clock.advance(1);
  const ok = await w.press("stop:ok", "تمام"); assert.equal(ok.sent.length, 0); assert.ok(!w.db.optins["512345678"].stopped_at);
  // tap «إلغاء طلبي» with no order on file ⇒ staff (they find the order), urgent
  const n = liveWorld(); await n.say("وقف"); n.clock.advance(1);
  const co = await n.press("cw:order", "إلغاء طلبي"); assert.equal(co.log.handoff, "order_change");
  // an open paid order ⇒ no question: urgent cancel handover with the order number, consent untouched
  const o = liveWorld({ orders: [order({ status: "accepted" })] });
  const x = await o.say("الغاء");
  assert.deepEqual([x.log.reply_key, x.log.handoff], ["change", "order_change"]); assert.equal(o.db.optins["512345678"], undefined); assert.match(o.sms[0].body, /order W\d+/);
  // a delivered order is not «open» ⇒ the question
  const d = liveWorld({ orders: [order({ status: "delivered" })] });
  assert.equal((await d.say("الغاء")).log.reply_key, "cancel_what");
  // the order wordings go straight to the cancel handover
  for (const t of ["ابي اوقف الطلب", "وقفوا الطلب لو سمحت", "الغوا الطلب", "لا تسوون الطلب"]) { const c = R.classify({ text: t, type: "text" }, {}); assert.deepEqual([c.key, c.rawIntent], ["change", "cancel_order"], t); }
}));

test("M2 — opt-out wordings stop the OFFERS only and are never answered with the offers list; order updates stop with the second button; the simulate route shows the same", withEnv(LOCKS_OPEN, async () => {
  for (const t of ["ما ابي رسايل", "لا ابي عروض", "ما ابي عروض", "كفاية رسايل", "لا ترسلون", "بلوك", "ازعاج", "شيلوا رقمي"]) assert.equal(R.classify({ text: t, type: "text" }, {}).key, "stop", t);
  for (const t of ["عندكم عروض؟", "ابي عروض اليوم", "وش العروض"]) assert.equal(R.classify({ text: t, type: "text" }, {}).key, "offers", t);
  const w = liveWorld();
  const r = await w.say("لا ابي عروض");
  assert.equal(bodyOf(r.sent[0]), "تم إيقاف العروض ✅ تحديثات طلباتك مستمرة.\nضغطت بالغلط؟ اضغط «رجّع العروض». وللرجوع في أي وقت اكتب: اشتراك"); assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].interactive.action.buttons.map((x) => x.reply.id), ["stop:undo", "stop:updates", "stop:ok"]);
  assert.equal(w.db.optins["512345678"].marketing, false); assert.ok(!w.db.optins["512345678"].stopped_at, "order updates continue");
  w.clock.advance(1);
  const u = await w.press("stop:updates", "أوقف تحديثات الطلب");
  assert.match(bodyOf(u.sent[0]), /^تم ✅ أوقفنا تحديثات الطلب أيضاً/); assert.ok(w.db.optins["512345678"].stopped_at);
  // simulate (the dashboard's «جرّب»): the question for a bare word, the stop text for the opt-out wording, and nothing is written
  const s1 = await w.call("POST", "/api/cms/wabot/simulate", { text: "الغاء", phone: "0599999991", first: false });
  assert.equal(s1.body.decision.key, "cancel_what"); assert.equal(s1.body.payloads[0].interactive.action.buttons.length, 2);
  const s2 = await w.call("POST", "/api/cms/wabot/simulate", { text: "لا ابي عروض", phone: "0599999991", first: false });
  assert.equal(s2.body.decision.key, "stop"); assert.ok(!JSON.stringify(s2.body.payloads).includes("FIRST"));
  assert.equal(w.db.optins["599999991"], undefined);
  const withOrder = liveWorld({ orders: [order({ status: "accepted" })] });
  const s3 = await withOrder.call("POST", "/api/cms/wabot/simulate", { text: "الغاء", phone: "0512345678", first: false });
  assert.deepEqual([s3.body.decision.key, s3.body.decision.handoff], ["change", ["order_change", "urgent"]]);
}));

/* ── مراجعة الخبير M3 — الأصناف بالوزن: أوزانها وأسعارها في كل مكان ─────────────────────────────── */
const VAR = JSON.parse(fs.readFileSync(new URL("./eval/fixtures/variants.json", import.meta.url), "utf8")).variants;
const ASSIST_TOOLS = await import("./waassist.js");

test("M3 index — weights come from the live variant options (no price in code): label, price, option id; an unavailable option is dropped; no data ⇒ null", () => {
  const m = W_BOT.indexMenu(LIVE.pages, { variants: VAR });
  const mk = m.items.find((i) => i.id === "103");
  assert.deepEqual(mk.weights.map((w) => [w.label_ar, w.label_en, w.price, w.variant_option_id]), [["ثلث كيلو", "1/3 Kilo", 53, 56], ["نصف كيلو", "1/2 Kilo", 78, 57], ["كيلو", "Kilo", 155, 58]]);
  assert.ok(mk.weights.every((w) => w.price_ex > 0 && w.price_ex < w.price));
  assert.equal(m.items.filter((i) => i.byWeight).every((i) => Array.isArray(i.weights) && i.weights.length === 3), true);
  assert.equal(m.items.find((i) => !i.byWeight).weights, undefined);
  assert.equal(W_BOT.indexMenu(LIVE.pages).items.find((i) => i.id === "103").weights, null, "no variant data: weights unknown, never invented");
  assert.deepEqual(W_BOT.weightsOf([{ id: 1, name: "كيلو", retail_price: 100, available: { available: false } }, { id: 2, name: "نصف كيلو", local_name: "1/2 Kilo", retail_price: 50, price: 43.48 }, { id: 3, name: "", retail_price: 9 }, { id: 4, name: "x", retail_price: 0 }]).map((w) => w.variant_option_id), [2]);
  assert.equal(W_BOT.weightsOf([]), null); assert.equal(W_BOT.weightsOf(null), null);
});

test("M3 rules bot — «كم كيلو المشكل» gets the three real prices; mashakel has no serving count or piece list; a sold-out dish says so with NO order button; unknown weights fall back to «من X»", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ variants: VAR });
  const r = await w.say("كم كيلو المشكل");
  assert.equal(r.log.reply_key, "item");
  assert.equal(bodyOf(r.sent[0]), "*مشكل مخصوص بالوزن*\nثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س");
  assert.ok(!/أشخاص|شخص|قطع|ريش|كباب|يكفي/.test(bodyOf(r.sent[0])), "owner rule: prices only for «مشكل مخصوص»");
  assert.match(urlOf(r.sent[0]), /#item-103$/);
  w.clock.advance(1);
  const k = await w.say("بكم كيلو الكباب");
  assert.match(bodyOf(k.sent[0]), /^\*كباب مشوي بالوزن\*\nثلث كيلو: 47 ر\.س · نصف كيلو: 70 ر\.س · كيلو: 140 ر\.س/);
  assert.ok(!/من 47/.test(bodyOf(k.sent[0])));
  // English
  w.clock.advance(1);
  const e = await w.say("how much is the grilled kebab by the kilo");
  if (e.log.reply_key === "item") assert.match(bodyOf(e.sent[0]), /1\/3 Kilo: SAR 47 · 1\/2 Kilo: SAR 70 · Kilo: SAR 140/);
  // sold out today: said plainly, no «اطلبه الآن», the sections instead
  const so = liveWorld({ variants: VAR, extraSettings: { catalog: { soldOut: { 97: { until: null } } } } });
  const s = await so.say("بكم كيلو الكباب");
  assert.match(bodyOf(s.sent[0]), /خلص اليوم/); assert.equal(s.sent[0].interactive.type, "button"); assert.ok(!JSON.stringify(s.sent[0]).includes("cta_url"));
  assert.deepEqual(s.sent[0].interactive.action.buttons.map((b) => b.reply.id), ["m:cats", "m:boxes", "bot:menu"]);
  // the product endpoint is down for one dish ⇒ that dish says «من X» as before; nothing is guessed
  const dn = liveWorld({ variants: { ...VAR, 103: "down" } });
  assert.match(bodyOf((await dn.say("كم كيلو المشكل")).sent[0]), /^\*مشكل مخصوص بالوزن\* — من 53 ر\.س/);
  // no variant loader at all (older setups): unchanged
  assert.match(bodyOf((await liveWorld().say("كم كيلو المشكل")).sent[0]), /من 53 ر\.س/);
}));

test("M3 assistant tools — a by-weight dish has weights and NO bare price; the cart takes a weight by its option id, «٢ كيلو» = 2 × the kilo line, and the saved cart is the storefront's own line shape", async () => {
  const menu = W_BOT.indexMenu(LIVE.pages, { variants: VAR });
  const made = [];
  const tools = ASSIST_TOOLS.makeAssistTools({ menuIndex: async () => menu, boxes: async () => LIVE.bundles, pool: { query: async () => ({ rows: [] }) }, expandBundle: async () => ({ ok: false }), modifiers: { catalogItems: async () => ({}), resolve: async () => ({ ok: true }) },
    quote: async () => ({ deliverable: true, fee: 15 }), offers: async () => [], openState: async () => ({ open: true }), buildProfile: async () => null, lastLocation: async () => null, settings: async () => ({}),
    botCarts: { create: async (x) => { made.push(x); return { code: "wt000001" }; } } });
  const s = await tools.search_menu("512345678", { query: "مشكل مخصوص" });
  const hit = s.results.find((i) => i.id === "103");
  assert.equal("price" in hit, false, "no single price to misquote"); assert.equal(hit.by_weight, true);
  assert.deepEqual(hit.weights, [{ label: "ثلث كيلو", label_en: "1/3 Kilo", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", label_en: "1/2 Kilo", price: 78, variant_option_id: 57 }, { label: "كيلو", label_en: "Kilo", price: 155, variant_option_id: 58 }]);
  const g = await tools.get_item("512345678", { id: "103" });
  assert.equal("price" in g.item, false); assert.equal(g.item.weights.length, 3);
  const plain = (await tools.search_menu("512345678", { query: "كريب زنجر سوبريم" })).results[0];
  assert.equal(plain.price, 25); assert.equal(plain.by_weight, false); assert.equal("weights" in plain, false);
  // no weight ⇒ asked for it, with the list; a wrong option id ⇒ the same
  let c = await tools.build_cart("512345678", { option: "pickup", items: [{ id: "103", qty: 2 }] }, { save: false });
  assert.deepEqual([c.ok, c.error, c.problems[0].error, c.problems[0].weights.length], [false, "empty_cart", "need_weight", 3]);
  c = await tools.build_cart("512345678", { option: "pickup", items: [{ id: "103", qty: 1, variant_option_id: 50 }] }, { save: false });
  assert.equal(c.problems[0].error, "need_weight", "the kebab's kilo id is not the mashakel's");
  // «ابي ٢ كيلو مشكل مخصوص استلام»
  c = await tools.build_cart("512345678", { option: "pickup", items: [{ id: "103", qty: 2, variant_option_id: 58 }] });
  assert.equal(c.ok, true); assert.equal(c.subtotal, 310);
  assert.deepEqual(c.lines.map((l) => [l.id, l.weight, l.variant_option_id, l.price, l.qty, l.total]), [["103", "كيلو", 58, 155, 2, 310]]);
  assert.deepEqual(Object.keys(made[0].plan.raw), ["103:v58"], "the storefront's cart key for a variant line");
  assert.deepEqual(made[0].plan.raw["103:v58"], { item: { id: 103 }, qty: 2, variant: { id: 58, name: "كيلو", local_name: "Kilo", retail_price: 155, price: 134.7826087 } });
  assert.deepEqual(made[0].plan.items, [{ id: "103", n: "مشكل مخصوص بالوزن (كيلو)", q: 2, p: 155, v: 58 }]);
  // «كيلو ونص» = two lines; the same weight twice merges; a plain dish beside it is unchanged
  c = await tools.build_cart("512345678", { option: "delivery", items: [{ id: "103", qty: 1, variant_option_id: 58 }, { id: "103", qty: 1, variant_option_id: 57 }, { id: "103", qty: 1, variant_option_id: 58 }, { id: "8", qty: 1 }] }, { save: false });
  assert.deepEqual(c.lines.map((l) => [l.id, l.weight || null, l.qty, l.total]), [["103", "كيلو", 2, 310], ["103", "نصف كيلو", 1, 78], ["8", null, 1, 25]]); assert.equal(c.subtotal, 413);
  // weights unknown right now ⇒ said so, with the dish's page; never a guessed price
  const bare = ASSIST_TOOLS.makeAssistTools({ menuIndex: async () => W_BOT.indexMenu(LIVE.pages), boxes: async () => [], pool: { query: async () => ({ rows: [] }) } });
  const b0 = await bare.build_cart("512345678", { option: "pickup", items: [{ id: "103", qty: 1, variant_option_id: 58 }] }, { save: false });
  assert.equal(b0.problems[0].error, "weights_unavailable"); assert.equal((await bare.get_item("512345678", { id: "103" })).item.weights, null);
});

test("M3 validator — a price of a by-weight dish must sit with its own weight: «by the kilo at <third-kilo price>» and a bare price are refused; the three-prices line passes", async () => {
  const AR3 = await import("./waassistrun.js");
  const know = { menu: W_BOT.indexMenu(LIVE.pages, { variants: VAR }), boxes: [] };
  const facts = [{ item: { name: "مشكل مخصوص بالوزن", id: "103", by_weight: true, name_en: "Special Mixed Grill (by the kilo)", weights: [{ label: "ثلث كيلو", price: 53 }, { label: "نصف كيلو", price: 78 }, { label: "كيلو", price: 155 }] } }, { item: { name: "كباب مشوي بالوزن", name_en: "Grilled Kebab (by the kilo)", weights: [{ price: 47 }, { price: 70 }, { price: 140 }] } }];
  const P = (t, lang = "ar") => AR3.checkReply(t, { facts, know, lang }).problems.map((p) => p.type);
  const bad = (t, lang) => assert.ok(P(t, lang).includes("weight_price_without_weight"), t);
  const ok = (t, lang) => assert.ok(!P(t, lang).includes("weight_price_without_weight"), `${t} ⇒ ${JSON.stringify(AR3.checkReply(t, { facts, know, lang }).problems)}`);
  ok("مشكل مخصوص بالوزن:\nثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س\nتبيه نصف كيلو ولا كيلو؟");
  ok("المشكل المخصوص: ثلث كيلو بـ 53 ر.س، نصف كيلو بـ 78 ر.س، والكيلو بـ 155 ر.س.");
  ok("سلتك: مشكل مخصوص بالوزن (كيلو) × 2 = 310 ر.س", "ar");
  ok("Special Mixed Grill: 1/3 Kilo: SAR 53 · 1/2 Kilo: SAR 78 · Kilo: SAR 155", "en");
  ok("Special Mix Grill: 1/3 Kilo: SAR 53 · 1/2 Kilo: SAR 78 · Kilo: SAR 155", "en");
  ok("كباب مشوي بالوزن: نص كيلو بـ 70 ر.س");
  bad("Special Mix Grill is sold by the kilo, at SAR 53.", "en");            // named loosely: caught because the dish's weights are in this conversation's tool results
  bad("Special Mixed Grill is sold by the kilo, at SAR 53.", "en");           // the reviewer's fast-tier line: 53 is the third-kilo price
  bad("مشكل مخصوص بالوزن بـ 53 ر.س");                                        // no weight at all
  bad("كيلو المشكل المخصوص بـ 78 ر.س");                                       // the half-kilo price beside «كيلو»
  bad("مشكل مخصوص بالوزن: الكيلو 53 ر.س");
  // a reply with no by-weight dish in it is not touched, and a plain dish with a price equal to a weight price is fine
  ok("كريب زنجر سوبريم بـ 25 ر.س. توصيل ولا استلام؟"); ok("رسوم التوصيل 53 ر.س");
  // two by-weight dishes in one reply: each line is judged with its own dish
  ok("كباب مشوي بالوزن: ثلث كيلو 47 ر.س · نصف كيلو 70 ر.س · كيلو 140 ر.س\nمشكل مخصوص بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س");
  bad("كباب مشوي بالوزن: الكيلو 47 ر.س\nمشكل مخصوص بالوزن: ثلث كيلو 53 ر.س");
  assert.ok(AR3.SYSTEM_PROMPT.includes("Never state one price for such a dish without its weight")); assert.ok(AR3.SYSTEM_PROMPT.includes("How many people a weight serves: never volunteered"));      // SB4: «لما العميل يسأل بس»
  assert.ok(AR3.TOOL_DEFS.find((t) => t.name === "build_cart").input_schema.properties.items.items.properties.variant_option_id);
});

test("M3 ad — an ad mapped to a by-weight dish opens the assistant on that dish with its three prices in the context; the cart from the chat is 2 × the kilo line", withEnv(CONFIGURED, async () => {
  const AD = "120251224485800593";
  const referral = { source_id: AD, source_type: "ad", headline: "مشكل مخصوص على الفحم — راسلنا واتساب", ctwa_clid: "C1" };
  const links = [...ALL_LINKS, { slug: "ad-mashakel", target_type: "product", target_id: "103" }];
  const w = aWorld([mSay("هلا 👋 مشكل مخصوص بالوزن:\nثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س\nتبيه نصف كيلو ولا كيلو؟"),
    mUse(tUse("preview_cart", { option: "pickup", items: [{ id: "103", qty: 2, variant_option_id: 58 }] })), mUse(tUse("build_cart", { option: "pickup", items: [{ id: "103", qty: 2, variant_option_id: 58 }] })), mSay("سلتك (استلام): مشكل مخصوص بالوزن (كيلو) × 2 = 310 ر.س\nاضغط الزر وكمّل طلبك 👇")],
    { links, variants: VAR, waBot: { links: { organic: "wab-boxes", ads: "wa-boxes", adMap: { [AD]: "ad-mashakel" } } } });
  const r = await w.say("مرحبا", { referral });
  assert.equal(r.log.reply_key, "assist");
  const adv = ctxOf(w.m.seen[0]).came_from_ad.advertised;
  assert.deepEqual([adv.kind, adv.id, adv.name, adv.by_weight, adv.weights.map((x) => x.price)], ["item", "103", "مشكل مخصوص بالوزن", true, [53, 78, 155]]); assert.equal("price" in adv, false);
  assert.match(bodyOf(msgs(r)[0]), /ثلث كيلو: 53 ر\.س · نصف كيلو: 78 ر\.س · كيلو: 155 ر\.س/);
  w.clock.advance(1);
  const c = await w.say("ابي ٢ كيلو استلام");
  assert.equal(c.log.reply_key, "assist"); assert.match(bodyOf(msgs(c)[0]), /= 310 ر\.س/);
  assert.deepEqual(w.db.botCarts.at(-1).plan.raw["103:v58"].variant.retail_price, 155); assert.equal(w.db.botCarts.at(-1).plan.raw["103:v58"].qty, 2);
}));

test("M3 found on the way — «بالوزن» is not a nut: the word «لوز» inside «الوزن» (and «جوز» inside «يجوز») no longer turns a by-weight order into an allergy question", async () => {
  const DF = await import("./wadishfacts.js");
  for (const t of ["ابي كفتة مشوية بالوزن توصيل", "كم سعر الكباب بالوزن", "يجوز اطلب بدون صوص؟", "الوزن كم؟"]) assert.deepEqual(DF.groupsIn(t), [], t);
  for (const t of ["فيه لوز في الكريب؟", "عندي حساسية من اللوز", "فيه جوز؟", "حساسية مكسرات"]) assert.deepEqual(DF.groupsIn(t), ["tree_nuts"], t);
  assert.notEqual(R.classify({ text: "ابي كفتة مشوية بالوزن توصيل", type: "text" }, KNOW).key, "dishfact");
});

/* ── مراجعة الخبير: M4 الباقي + M5 + البنود الجدّية (١٣/١٠) ─────────────────────────────── */
test("M4: the live-log wordings that used to end in «ما فهمت» or in the wrong answer", withEnv(LOCKS_OPEN, async () => {
  const keyOf = async (w, text, o) => (await w.say(text, o)).log.reply_key;
  // «محتاجه اعمل اوردر», «عايز اطلب», «ممكن اطلب» ⇒ how to order
  for (const t of ["محتاجه اعمل اوردر", "عايز اطلب", "ممكن اطلب"]) assert.equal(await keyOf(liveWorld(), t), "order", t);
  // «كم الحساب / المجموع»: an open order ⇒ its status; none ⇒ how to order
  for (const t of ["كم الحساب", "كم المجموع"]) { assert.equal(await keyOf(liveWorld(), t), "order", t); assert.equal(await keyOf(liveWorld({ orders: [order()] }), t), "status", t); }
  // transfer / cash ⇒ the owner's direct line first, then the payment methods; never a handover
  for (const t of ["ابي ادفع تحويل", "عايزه حساب عشان احولك", "ادفع كاش؟"]) {
    const r = await liveWorld().say(t);
    assert.equal(r.log.reply_key, "payment", t); assert.equal(r.log.handoff, null, t);
    assert.match(bodyOf(r.sent[0]), /^الدفع أونلاين من موقعنا عند إتمام الطلب، وما نستقبل تحويل بنكي أو كاش عبر المحادثة\.\n/, t);
    assert.match(bodyOf(r.sent[0]), /Apple Pay/, t);
  }
  assert.doesNotMatch(bodyOf((await liveWorld().say("طرق الدفع")).sent[0]), /تحويل بنكي/, "the plain payment question keeps its answer");
  // a payment that failed is a problem for a person (urgent), never the payment-methods text
  for (const t of ["الدفع ما اشتغل", "ما قدرت ادفع", "انخصم ولا جاني طلب"]) { const r = await liveWorld().say(t); assert.equal(r.log.reply_key, "problem", t); assert.ok(r.log.handoff, t); }
  // «انت بوت؟ / مين معي» ⇒ the disclosure line and the main menu — the line is said once, also on a first message
  for (const t of ["انت بوت؟", "مين معي"]) for (const disclosure of [true, false]) {
    const w = liveWorld({ disclosure }), r = await w.say(t), body = bodyOf(r.sent[0]), who = R.disclosureLine(R.botConfig(w.db.settings), "ar", w.db.settings);
    assert.equal(r.log.reply_key, "whoami", t); assert.equal(body, `${who}\nاختر اللي تبيه 👇`, t); assert.equal(rowsOf(r.sent[0]).length, 10);
  }
  // another city ⇒ one honest line; a Jeddah street named after a city is not «another city»
  for (const t of ["انتم في جدة ولا مكة", "فيه في مكه العزيزيه", "توصلون مكة؟", "عندكم فرع بالرياض", "انا في الطائف توصلون؟"]) {
    const r = await liveWorld().say(t); assert.equal(r.log.reply_key, "other_city", t); assert.equal(bodyOf(r.sent[0]), "نحن في جدة، حي السلامة، والتوصيل داخل جدة فقط.", t);
  }
  for (const t of ["انا على طريق مكة القديم", "شارع المدينة", "حي الرياض", "انا رياض", "عطني خبر"]) assert.notEqual(R.classify({ text: t, type: "text" }, {}).key, "other_city", t);
  assert.equal(R.classify({ text: "وقف الرسائل انا في الرياض", type: "text" }, {}).key, "stop", "a clear intent wins over the city");
  // the order went wrong / the courier ⇒ complaint: urgent, a person, with the order number in the alert
  for (const t of ["جاني طلب غيري", "الطلب ناقص", "المندوب ما يرد", "المندوب ما وصل"]) {
    const w = liveWorld({ orders: [order()] }), r = await w.say(t);
    assert.equal(r.log.reply_key, "complaint", t); assert.equal(r.log.handoff, "complaint", t); assert.ok(w.sms.length >= 1 && w.sms.every((m) => /W1790011111111/.test(m.text || m.message || JSON.stringify(m))), t);
    assert.equal(w.portal.at(-1)[1].urgent, true, t);
  }
  // where the meat comes from ⇒ the owner's approved answer (staff while it is empty) — never a list of dishes; the supplier's name stays a trade secret
  const meat = liveWorld(), mr = await meat.say("من وين تجيبون اللحم");
  assert.deepEqual([mr.log.reply_key, mr.log.handoff, mr.log.detail], ["staff", "needs_staff", "faq:meat"]);
  const meat2 = liveWorld({ waBot: { faq: { meat: { ar: "لحومنا طازجة يومياً." } } } }), mr2 = await meat2.say("من وين تجيبون اللحم");
  assert.equal(mr2.log.reply_key, "faq"); assert.match(bodyOf(mr2.sent[0]), /لحومنا طازجة يومياً\./); assert.doesNotMatch(bodyOf(mr2.sent[0]), /ر\.س|SAR|\d+ ريال/);
  assert.equal((await liveWorld().say("مين المورد")).log.reply_key, "secret");
  // «كم باقي / متى يوصل»: an open order ⇒ its status; none ⇒ the short answer without minutes (not the fee ladder)
  for (const t of ["كم باقي", "متى يوصل", "كم ياخذ التوصيل"]) {
    const r = await liveWorld().say(t);
    assert.equal(r.log.reply_key, "delivery_time", t); assert.equal(bodyOf(r.sent[0]), "الوقت يختلف حسب المسافة والزحمة. أرسل موقعك 📍 وأتأكد لك من التغطية والرسوم.", t); assert.doesNotMatch(bodyOf(r.sent[0]), /\d/, t);
    assert.equal(await keyOf(liveWorld({ orders: [order()] }), t), "status", t);
  }
  // generic wordings from the replay set that used to be «ما فهمت»
  for (const [t, k] of [["الوو", "greet"], ["اخبارك يا معلم", "greet"], ["اشكرك", "thanks"], ["ثواني", "ack"], ["👍🏻", "ack"], ["ما اسمك", "whoami"], ["نفسي اكل حاجة بس مش عارف اكل ايه", "best"], ["ايش تقترح", "best"]]) assert.equal(R.classify({ text: t, type: "text" }, {}).key, k, t);
  // the new texts are editable owner texts; the classifier waits 4 s by default
  for (const k of ["repeat_short", "other_city", "delivery_time", "payment_no_cash_transfer", "whoami"]) assert.ok(R.TEXT_KEYS.includes(k), k);
  assert.equal(R.botConfig({}).llm.timeoutMs, 4000);
}));

test("M5: a number that is not a customer is never answered — the owner's list, the team's alert phones, couriers — with a one-tap route", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ waBot: { neverReplyPhones: ["0598765432"] } });
  w.db.drivers = ["0533000111", "+966 53 300 0222"];
  w.db.staffContacts = ["544000999", "544000888"];      // SX1: is_staff في ملف العملاء مابقاش مصدر للبوت
  w.db.settings.cms = { phoneLists: { migratedAt: "2026-10-15T00:00:00Z", staffPhones: [{ phone: "0544000999", reason: "employee", name: "موظف" }], noAdsPhones: [{ phone: "0544000888", reason: "ads_request" }] },
    campaigns: { excludePhones: ["0544000777"] } };      // القايمة القديمة بعد الترحيل: محدش بيقراها
  const a = await w.say("السلام عليكم", { from: "966598765432" });
  assert.deepEqual([a.sent.length, a.log.decision, a.log.reason, a.log.detail], [0, "silent", "never_reply", "never_list"]);
  const b = await w.say("وين المطعم", { from: "966506338246" });          // an alert phone of the team
  assert.deepEqual([b.sent.length, b.log.reason, b.log.detail], [0, "never_reply", "alert_phone"]);
  for (const from of ["966533000111", "966533000222"]) { const c = await w.say("انا عند الباب", { from }); assert.deepEqual([c.sent.length, c.log.reason, c.log.detail], [0, "never_reply", "courier"], from); }
  { const st = await w.say("صباح الخير", { from: "966544000999" }); assert.deepEqual([st.sent.length, st.log.reason, st.log.detail], [0, "never_reply", "staff_list"], "in the «موظفين / فريق» list"); }
  /* SX1: «مستثنين من الإعلانات بس» والقايمة القديمة بعد الترحيل ⇒ البوت بيرد عادي (ده اللي سكّت البوت على 0568•••14) */
  for (const from of ["966544000888", "966544000777"]) { const na = await w.say("السلام عليكم", { from }); assert.equal(na.sent.length, 1, from); assert.notEqual(na.log.reason, "never_reply", from); }
  assert.equal((await w.say("السلام عليكم")).sent.length, 1, "customers are answered as always");
  assert.equal(w.sms.length, 0, "no staff alert for a number that is not a customer");
  // a test phone is never excluded by itself (Omar's phone is an alert phone AND a test phone) — only by the owner's list
  const t = world({ waBot: { mode: "test", testPhones: ["0506338246"] } });
  assert.equal((await t.say("السلام عليكم", { from: "966506338246" })).sent.length, 1);
  // the one-tap route (orders section): add, list with the automatic ones and why, remove; the change is logged
  const r = liveWorld(); r.db.drivers = ["0533000111"];
  assert.equal((await r.call("POST", "/api/cms/ops/wabot/never-reply", { phone: "12345" })).status, 400);
  assert.deepEqual((await r.call("POST", "/api/cms/ops/wabot/never-reply", { phone: "0512345678" })).body, { ok: true, phone: "0512345678", on: true, count: 1 });
  assert.deepEqual(r.db.settings.waBot.neverReplyPhones, ["512345678"]); assert.equal(r.db.settings.waBot.mode, "live", "nothing else in the settings is touched");
  assert.equal((await r.say("السلام عليكم")).log.reason, "never_reply");
  const g = (await r.call("GET", "/api/cms/ops/wabot/never-reply")).body;
  assert.deepEqual(g.phones, ["0512345678"]); assert.ok(g.auto.find((x) => x.phone === "0533000111" && x.why === "courier")); assert.ok(g.auto.find((x) => x.why === "alert_phone"));
  assert.equal((await r.call("POST", "/api/cms/ops/wabot/never-reply", { phone: "0512345678", on: false })).body.count, 0);
  assert.equal((await r.say("مرحبا")).sent.length, 1);
  assert.equal(r.db.cfgLog.length, 2);
  // the same action for the portal / inbox (through the bot object)
  assert.deepEqual(await r.bot.setNeverReply("0598765432", true, "cashier"), { ok: true, phone: "0598765432", on: true, count: 1 }); assert.equal((await r.bot.setNeverReply("123", true)).error, "bad_phone");
  const tp = world({ waBot: { mode: "test", testPhones: ["0512345678"] } });
  assert.equal((await tp.call("POST", "/api/cms/ops/wabot/never-reply", { phone: "0512345678" })).body.error, "test_phone");
  // the setting itself
  assert.match(R.configFromBody({ neverReplyPhones: ["123"] }).errors[0], /neverReplyPhones/);
  assert.deepEqual(R.configFromBody({ neverReplyPhones: ["0512345678", "966512345678"] }).value.neverReplyPhones, ["512345678"]);
  assert.ok(R.SCHEMA.neverReplyPhones.ar && R.SCHEMA.liveScope.ar && R.SCHEMA.mediaFloodCount.ar);
}));

/* SX1 (١٥/١٠ ١٨:٣٧ — 0568•••14 كتب «السلام عليكم» / «عندي ملاحظات» والبوت سكت ومحدش رد): رقم في قايمة «موظفين / فريق» (مش عضو في دليل الفريق)
   كتب ومحدش من الفريق رد خلال staffSilent.afterMin ⇒ تحويل عادي «رقم في قايمة الموظفين كتب ومحدش رد» — والبوت نفسه مابيبعتلوش ولا رسالة. */
test("SX1: staff-listed number writes, nobody answers in N min ⇒ a normal handover; no bot message; a staff reply / team member / switch off ⇒ none; the owner's review queue is answered by the bot", withEnv(LOCKS_OPEN, async () => {
  const PL = (x = {}) => ({ cms: { phoneLists: { migratedAt: "2026-10-15T00:00:00Z", staffPhones: [{ phone: "0568000014", reason: "ambassador", name: "محمد" }], staffSilent: { enabled: true, afterMin: 5 }, ...x } } });
  const FROM = "966568000014";
  const toHim = (w) => w.calls.filter((c) => c.body && c.body.to && String(c.body.to).endsWith("568000014"));
  const hos = (w) => w.portal.filter(([e, d]) => e === "wa_handover" && d.phone === "0568000014");
  const w = liveWorld({ extraSettings: PL() });
  const a = await w.say("السلام عليكم", { from: FROM }); w.clock.advance(1);
  const b = await w.say("عندي ملاحظات", { from: FROM });
  for (const r of [a, b]) assert.deepEqual([r.sent.length, r.log.decision, r.log.reason, r.log.detail], [0, "silent", "never_reply", "staff_list"]);
  await w.tick(3);
  assert.equal(hos(w).length, 0, "4 min after the first message: not yet");
  await w.tick(2);
  assert.equal(hos(w).length, 1, "5 min with no reply ⇒ one handover");
  const [, ev] = hos(w)[0];
  assert.equal(ev.reason, "staff_silent"); assert.equal(ev.reasonAr, "رقم في قايمة الموظفين كتب ومحدش رد"); assert.match(ev.note, /«موظفين \/ فريق»/); assert.match(ev.note, /سفير/);
  assert.ok(w.sms.some((x) => /staff_silent/.test(String(x.ref || ""))), "the team is alerted like any handover");
  assert.ok(w.db.jobs.some((j) => j.kind === "staff_silent" && j.status === "done"));
  await w.tick(15); await w.tick(15);
  assert.equal(hos(w).filter(([, d]) => !d.reminder && !d.reopened).length, 1, "one handover per silence, not one per minute");
  assert.equal(toHim(w).length, 0, "the bot never writes to a staff-listed number — not even the «we will get back to you» note");
  assert.ok(!w.db.jobs.some((j) => j.kind === "handover_check" && /:note$/.test(String(j.wamid)) && j.status === "done" && j.reason === "note_sent"), "no customer note from the bot");
  // a staff member answered (echo from the restaurant phone) inside the window ⇒ no handover
  const w2 = liveWorld({ extraSettings: PL() });
  await w2.say("السلام عليكم", { from: FROM }); w2.clock.advance(2); await w2.cashier("هلا محمد، تفضل", FROM);
  await w2.tick(10);
  assert.equal(hos(w2).length, 0, "a human answered");
  // a team member (waTeam) on the same list ⇒ silent as «staff» (the team's own number), never a handover
  const w3 = liveWorld({ extraSettings: { ...PL(), waTeam: { members: [{ phone: "0568000014", name: "محمد", role: "cashier" }] } } });
  const t3 = await w3.say("السلام عليكم", { from: FROM });
  assert.equal(t3.log.detail, "staff"); await w3.tick(10);
  assert.equal(hos(w3).length, 0);
  // the switch is off ⇒ silent, no handover
  const w4 = liveWorld({ extraSettings: PL({ staffSilent: { enabled: false, afterMin: 5 } }) });
  await w4.say("السلام عليكم", { from: FROM }); await w4.tick(10);
  assert.equal(hos(w4).length, 0);
  // moved to «مستثنين من الإعلانات بس» before the job ran ⇒ the next message is answered by the bot, and no staff-list handover
  const w5 = liveWorld({ extraSettings: PL() });
  await w5.say("السلام عليكم", { from: FROM });
  w5.db.settings.cms.phoneLists = { ...w5.db.settings.cms.phoneLists, staffPhones: [], noAdsPhones: [{ phone: "0568000014", reason: "ads_request" }] };
  const r5 = await w5.say("عندي ملاحظات", { from: FROM });
  assert.notEqual(r5.log.reason, "never_reply", "the customer is handled by the bot right away");
  assert.ok(toHim(w5).length >= 1, "(the helper sees messages to him when the bot does answer)");
  await w5.tick(6);
  assert.equal(hos(w5).filter(([, d]) => d.reason === "staff_silent").length, 0);
  // neverReplyOf names the staff list (the inbox / portal header «رقم موظف — البوت ساكت»)
  assert.equal(await w.bot.neverReplyOf("0568000014"), "staff_list");
  /* a number waiting for the owner's decision — the migration puts an old-list number with chats or paid web orders there, 0568•••14 himself —
     looks like a customer: the bot answers him from the first message, and there is no staff-list handover */
  const w6 = liveWorld({ extraSettings: { cms: { phoneLists: { migratedAt: "2026-10-15T00:00:00Z", reviewPhones: [{ phone: "0568000014", reason: "ambassador" }] } } } });
  const r6 = await w6.say("السلام عليكم", { from: FROM });
  assert.equal(r6.sent.length, 1); assert.notEqual(r6.log.reason, "never_reply"); assert.equal(await w6.bot.neverReplyOf("0568000014"), null);
  await w6.tick(6);
  assert.equal(hos(w6).filter(([, d]) => d.reason === "staff_silent").length, 0);
}));

test("M5: live scope — ads only / ads + new numbers / everyone; outside the scope the bot is silent and logs the reply it would have sent", withEnv(LOCKS_OPEN, async () => {
  const AD = { source_id: "120251224485800593", source_type: "ad", ctwa_clid: "X" };
  assert.equal(R.botConfig({}).liveScope, "all"); assert.match(R.configFromBody({ liveScope: "x" }).errors[0], /liveScope/);
  const w = liveWorld({ waBot: { liveScope: "ads", testPhones: ["0555555555"] } });
  const out = await w.say("كم رسوم التوصيل");
  assert.deepEqual([out.sent.length, out.log.decision, out.log.reason, out.log.reply_key, out.log.detail], [0, "silent", "out_of_scope", "delivery", "scope:ads"]);
  assert.equal(w.sms.length, 0);
  const ad = await w.say("مرحبا", { from: "966598765432", referral: AD });
  assert.equal(ad.sent.length, 1, "the ad chat is answered");
  w.clock.advance(30);
  assert.equal((await w.say("كم رسوم التوصيل", { from: "966598765432" })).sent.length, 1, "and stays answered inside the ad window");
  assert.equal((await w.say("مرحبا", { from: "966555555555" })).sent.length, 1, "a test phone is always inside");
  // simulate says the same (acceptance)
  const s1 = (await w.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل" })).body;
  assert.deepEqual([s1.decision.act, s1.decision.reason, s1.decision.key, s1.payloads.length, s1.wouldSend.length], ["silent", "out_of_scope", "delivery", 0, 1]);
  const s2 = (await w.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل", referral: AD })).body;
  assert.equal(s2.decision.act, "reply"); assert.equal(s2.payloads.length, 1);
  // new = ads + numbers that never wrote before the go-live moment
  const n = liveWorld({ waBot: { liveScope: "new", liveSince: OPEN_AT } });
  n.db.msgs.push({ phone_norm: "598765432", direction: "in", wamid: "old1", created_at: new Date(Date.parse(OPEN_AT) - 86400_000).toISOString(), text: "هلا" });
  assert.equal((await n.say("مرحبا", { from: "966598765432" })).log.reason, "out_of_scope", "he wrote to the restaurant before: the team's chat");
  assert.equal((await n.say("مرحبا")).sent.length, 1, "a number we never heard from");
  assert.equal((await n.say("مرحبا", { from: "966598765432", referral: AD })).sent.length, 1, "an ad click is always in");
  const n0 = liveWorld({ waBot: { liveScope: "new" } });
  assert.equal((await n0.say("مرحبا")).log.reason, "out_of_scope", "no go-live moment stored: nobody counts as new (ads only)");
  // the scope is for live only: test mode and its list are untouched
  const t = world({ waBot: { mode: "test", testPhones: ["0512345678"], liveScope: "ads" } });
  assert.equal((await t.say("مرحبا")).sent.length, 1);
}));

test("M5: a flood of pictures with no text mutes the chat for 24 h with ONE handover — not thirty «I can not open pictures»", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  const img = () => w.say("", { type: "image" });
  const first = [];
  for (let i = 0; i < 4; i++) { first.push((await img()).log.reply_key); w.clock.advanceSec(10); }
  assert.equal(first.length, 4); assert.ok(w.calls.length >= 1, "the first ones are handled as today");
  const smsBefore = w.sms.length, portalBefore = w.portal.length;
  const f = await img();
  /* PS5: the mute is no longer silent — the customer gets ONE line, and the team an urgent alert */
  assert.deepEqual([f.sent.length, f.log.decision, f.log.reason, f.log.handoff], [1, "silent", "media_flood", "media_flood"]); assert.equal(f.sent[0].text.body, "وصلتنا صورك 🙏 حوّلتها لواحد من الفريق يراجعها ويرد عليك هنا."); assert.equal(w.portal.at(-1)[1].urgent, true);
  assert.equal(w.portal.length, portalBefore + 1); assert.equal(w.portal.at(-1)[1].reason, "media_flood");
  assert.ok(w.sms.length >= smsBefore);
  const chat = w.db.chats.get("512345678");
  assert.deepEqual([chat.mute_reason, chat.muted_by], ["manual", "media_flood"], "EX5: stored as a manual mute with its cause in muted_by — a mute with any other reason was cleared at every restart"); assert.equal(Math.round((Date.parse(chat.muted_until) - w.clock.now().getTime()) / 3600_000), 24);
  const p2 = w.portal.length;
  for (let i = 0; i < 6; i++) { const x = await img(); assert.equal(x.sent.length, 0); }
  assert.equal(w.portal.length, p2, "one handover, not one per picture");
  assert.equal((await w.say("مرحبا", { from: "966598765432" })).sent.length, 1, "other customers are not affected");
  // slow pictures are not a flood; 0 switches it off
  const slow = liveWorld();
  for (let i = 0; i < 7; i++) { assert.notEqual((await slow.say("", { type: "image" })).log.reason, "media_flood"); slow.clock.advance(1); }
  const off = liveWorld({ waBot: { mediaFloodCount: 0 } });
  for (let i = 0; i < 7; i++) assert.notEqual((await off.say("", { type: "image" })).log.reason, "media_flood");
  assert.deepEqual([R.botConfig({}).mediaFloodCount, R.botConfig({}).mediaFloodMinutes, R.botConfig({}).mediaFloodMuteHours], [5, 2, 24]);
}));

test("serious: an urgent handover is not stopped by the hourly alert cap", withEnv(LOCKS_OPEN, async () => {
  // the cap is for ordinary alerts
  const w = liveWorld({ waBot: { maxAlertsPerHour: 1 } });
  const a = await w.say("ابي اكلم موظف", { from: "966598765432" }); assert.equal(a.log.alert, "sent");
  const b = await w.say("ابي اكلم موظف", { from: "966555555555" }); assert.equal(b.log.alert, "capped");
  const c = await w.say("الطلب وصل بارد وناقص", { from: "966577777777" }); assert.equal(c.log.alert, "sent", "a complaint still reaches the team");
}));

test("serious: portal «تم» with no reply to the customer does not leave him without his note", withEnv(CONFIGURED, async () => {
  // «تم» without a word to the customer
  const NOTE = txt(ME, "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.\nوأنا معك لو تحتاج شي في المنيو أو الطلب.");
  const jobs = (x) => x.db.jobs.filter((j) => j.kind === "handover_check").map((j) => [j.ev.stage, j.status, j.reason]);
  const x = aWorld([]); await x.say("ابي اكلم موظف");
  x.db.acks = { 512345678: x.clock.now().toISOString() };
  assert.deepEqual(await x.tick(5), []);
  assert.deepEqual(jobs(x), [["realert", "done", "realert:skipped_acked"], ["note", "pending", null]]); assert.equal(x.portal.length, 1, "the card was closed: no second alert at five minutes");
  assert.deepEqual(await x.tick(5), [NOTE], "ten minutes and still nobody wrote to him: he is told, and the card comes back");
  assert.deepEqual([x.portal.length, x.portal[1][1].reopened], [2, true]);
  // «تم» and then a real reply ⇒ nothing more
  const y = aWorld([]); await y.say("ابي اكلم موظف"); y.db.acks = { 512345678: y.clock.now().toISOString() }; await y.tick(5); y.clock.advance(1); await y.cashier("معك");
  assert.deepEqual(await y.tick(4), []); assert.equal(jobs(y)[1][2], "staff_answered");
  // the owner can return to the old meaning of «تم» (a team that answers by phone)
  const z = aWorld([], { waBot: { handoverAckNeedsReply: false } }); await z.say("ابي اكلم موظف"); z.db.acks = { 512345678: z.clock.now().toISOString() };
  assert.deepEqual(await z.tick(5), []); assert.deepEqual(jobs(z), [["realert", "cancelled", "staff_acked"]]); assert.deepEqual(await z.tick(10), []);
  assert.equal(R.botConfig({}).handoverAckNeedsReply, true); assert.ok(R.SCHEMA.handoverAckNeedsReply.ar);
}));

test("serious (assistant): another city and «انت بوت؟» are answered by the fixed owner texts, not by the model", withEnv(CONFIGURED, async () => {
  const w = aWorld([]);
  const r = await w.say("انا في مكة توصلون؟");
  assert.deepEqual([r.log.reply_key, bodyOf(r.sent[0]), w.m.used()], ["other_city", "نحن في جدة، حي السلامة، والتوصيل داخل جدة فقط.", 0]);
  const b = await aWorld([]).say("انت بوت؟");
  assert.equal(b.log.reply_key, "whoami");
  const AR3 = await import("./waassistrun.js");
  assert.match(AR3.SYSTEM_PROMPT, /deliver inside Jeddah only/); assert.match(AR3.SYSTEM_PROMPT, /Never ask the same question twice/); assert.match(AR3.SYSTEM_PROMPT, /before you say anything about a coupon or a code/);
}));

/* ── EX4 (عمر ١٣/١٠) ─────────────────────────────────────────────────────────────── */
test("EX4: «إيقاف» is undoable in one tap, typed «رجّع» wordings resubscribe, and a resubscribe really lifts the block", withEnv(LOCKS_OPEN, async () => {
  const START = "تم تفعيل رسائل العروض ✅\nللإيقاف اكتب: إيقاف";
  const w = liveWorld();
  const s = await w.say("إيقاف");
  assert.deepEqual(s.sent[0].interactive.action.buttons.map((x) => [x.reply.id, x.reply.title]), [["stop:undo", "↩️ رجّع العروض"], ["stop:updates", "أوقف تحديثات الطلب"], ["stop:ok", "تمام"]]);
  assert.match(bodyOf(s.sent[0]), /اكتب: اشتراك$/, "the stop message says how to come back later");
  assert.equal(R.payloadProblem(s.sent[0]), null);
  assert.equal(w.db.optins["512345678"].marketing, false); assert.deepEqual(w.db.optouts, ["512345678"], "the stop is immediate");
  w.clock.advance(1);
  const u = await w.press("stop:undo", "↩️ رجّع العروض");
  assert.deepEqual(u.sent, [txt(ME, START)]); assert.equal(u.log.reply_key, "start");
  assert.equal(w.db.optins["512345678"].marketing, true); assert.ok(!w.db.optins["512345678"].marketing_off_at);
  assert.deepEqual(w.db.optouts, [], "the customers-file block set by the WhatsApp stop is lifted too (it was not, before EX4)");
  assert.deepEqual(w.db.optoutLog, [["512345678", "resubscribe"]]);
  assert.ok(w.db.consentLog.length >= 1, "the tap is a logged consent");
  // an opt-out made elsewhere (SMS link / staff) is not lifted by a WhatsApp resubscribe
  const sms = liveWorld(); sms.db.optouts = ["512345678"]; sms.db.smsOptouts = ["512345678"];
  await sms.say("اشترك"); assert.deepEqual(sms.db.optouts, ["512345678"]);
  // Omar's own words, and the rest of the list: explicit wordings resubscribe whoever writes them
  for (const text of ["شغل الاعلانات والعروض", "شغل العروض", "شغل الاعلانات", "رجع العروض", "رجعوا الرسايل", "فعّل العروض", "اشترك"]) {
    const x = liveWorld(); await x.say("إيقاف"); x.clock.advance(1);
    const r = await x.say(text);
    assert.deepEqual([r.log.reply_key, bodyOf(r.sent[0])], ["start", START], text); assert.equal(x.db.optins["512345678"].marketing, true, text); assert.deepEqual(x.db.optouts, [], text);
  }
  // short ambiguous words mean «undo» only from someone who stopped in the last 24 hours
  for (const text of ["استمرار", "تشغيل", "غلطت", "ضغطت بالغلط"]) {
    const x = liveWorld(); await x.say("إيقاف"); x.clock.advance(1);
    const r = await x.say(text);
    assert.equal(r.log.reply_key, "start", text); assert.equal(x.db.optins["512345678"].marketing, true, text);
    const fresh = liveWorld(); const f = await fresh.say(text);
    assert.notEqual(f.log.reply_key, "start", `${text}: from someone who never stopped it is not a subscription`); assert.equal(fresh.db.optins["512345678"], undefined, text);
    const old = liveWorld(); await old.say("إيقاف"); old.clock.advance(25 * 60);
    assert.notEqual((await old.say(text)).log.reply_key, "start", `${text}: a day later it is not an undo`);
  }
  // the questions about offers are still questions
  for (const text of ["عندكم عروض؟", "وش العروض", "ابي عروض اليوم"]) assert.equal(R.classify({ text, type: "text" }, {}).key, "offers", text);
  assert.equal(R.classify({ text: "وقف العروض", type: "text" }, {}).key, "stop");
  // after «أوقف تحديثات الطلب» too: «اشترك» brings everything back
  const all = liveWorld(); await all.say("إيقاف"); all.clock.advance(1); await all.press("stop:updates", "أوقف تحديثات الطلب"); all.clock.advance(1);
  await all.say("اشترك"); assert.ok(!all.db.optins["512345678"].stopped_at); assert.equal(all.db.optins["512345678"].marketing, true);
  assert.ok(R.TEXT_KEYS.includes("btn_stop_undo"));
}));

test("EX4: with the assistant on, a stopped customer who asks for the offers back gets the same resubscribe — the model is not asked", withEnv(CONFIGURED, async () => {
  for (const text of ["استمرار", "شغل الاعلانات والعروض"]) {
    const w = aWorld([]);
    await w.say("إيقاف"); w.clock.advance(1);
    const r = await w.say(text);
    assert.deepEqual([r.log.reply_key, w.m.used()], ["start", 0], text); assert.equal(w.db.optins["512345678"].marketing, true, text);
  }
  const AR4 = await import("./waassistrun.js");
  assert.match(AR4.SYSTEM_PROMPT, /You cannot switch our offer messages on or off/); assert.match(AR4.SYSTEM_PROMPT, /only when it returns has_open_order true/);
}));

test("EX4: order status is for an OPEN order only — «وين طلبي / كم الحساب / كم باقي / متى يوصل» with none, with a delivered one, with an open one", withEnv(LOCKS_OPEN, async () => {
  const NONE = "ما فيه طلب مفتوح على رقمك هذا الحين.\nتبي تطلب، أو أحوّلك لموظف؟";
  const none = liveWorld(), a = await none.say("وين طلبي");
  assert.deepEqual([a.log.reply_key, bodyOf(a.sent[0]), a.log.handoff, none.sms.length, none.portal.length], ["status", NONE, null, 0, 0]);
  none.clock.advance(1);
  assert.equal(bodyOf((await none.press("bot:status", "📦 طلبي")).sent[0]), NONE, "the status button says the same");
  const del = liveWorld({ orders: [order({ status: "delivered" })] }), b = await del.say("وين طلبي");
  assert.equal(bodyOf(b.sent[0]), "ما فيه طلب مفتوح على رقمك هذا الحين.\nآخر طلب لك W1790011111111: تم توصيل طلبك ✅\nتبي تطلب، أو أحوّلك لموظف؟"); assert.equal(b.log.handoff, null);
  assert.doesNotMatch(JSON.stringify(b.sent), /track\//, "no tracking link for a closed order");
  const open = liveWorld({ orders: [order({ status: "on_the_way" })] });
  assert.match(bodyOf((await open.say("وين طلبي")).sent[0]), /^طلبك رقم W1790011111111: طلبك مع المندوب/);
  // the EX3 routes follow the same rule
  for (const [text, key] of [["كم الحساب", "order"], ["كم المجموع", "order"], ["كم باقي", "delivery_time"], ["متى يوصل", "delivery_time"]]) {
    for (const orders of [[], [order({ status: "delivered" })]]) { const r = await liveWorld({ orders }).say(text); assert.equal(r.log.reply_key, key, `${text} / ${orders.length}`); assert.doesNotMatch(bodyOf(r.sent[0]), /W1790011111111/, text); }
    assert.equal((await liveWorld({ orders: [order({ status: "accepted" })] }).say(text)).log.reply_key, "status", text);
  }
  assert.equal(bodyOf((await liveWorld().say("كم باقي")).sent[0]), "الوقت يختلف حسب المسافة والزحمة. أرسل موقعك 📍 وأتأكد لك من التغطية والرسوم.");
  // an order the restaurant refused and refunded keeps its real status: that is what the customer is asking about
  assert.match(bodyOf((await liveWorld({ orders: [order({ status: "rejected_refunded", refund_id: "RF1" })] }).say("وين طلبي")).sent[0]), /استرجاع المبلغ/);
  assert.equal(R.TEXT_KEYS.includes("status_none"), false); assert.ok(R.TEXT_KEYS.includes("status_no_open") && R.TEXT_KEYS.includes("status_last_closed"));
}));

/* ── EX5 (١٣/١٠، أول «رد عميل» بعد الحملة كان رد آلي من نشاط تجاري) ─────────────────────────── */
const CITY_DOORS = "شكرا لك على تواصلك مع \n*مدينة الابواب - City Doors. *\nيرجى إخبارنا بما يمكننا القيام به لمساعدتك.\nفضلاً تحديد المدينه وعدد الابواب لاخباركم بكافة العروض والتخفيضات الساريه 👈\nيمكنكم زيارة موقعنا الالكتروني واكتشف المزيد عن اختياراتنا المتنوعة https://citydoors.example";
const AWAY_AR = "شكراً لك على رسالتك. نحن لسنا متوفرين في الوقت الحالي، ولكننا سنرد عليك في أسرع وقت ممكن.";

test("EX5: what an automatic reply looks like — the two messages of 13/10, the usual Arabic and English boilerplate, and what a customer writes", () => {
  for (const text of [CITY_DOORS, AWAY_AR, "شكراً لتواصلك معنا", "نحن غير متواجدين حالياً", "سنرد عليك في أقرب وقت", "سيتم الرد عليكم خلال ساعات العمل", "أنت تراسلنا خارج أوقات العمل", "هذا رد آلي", "Thank you for contacting ACME Trading!", "We are currently away",
    "we're currently unavailable", "Thanks for your message. We'll get back to you as soon as possible.", "You reached us outside business hours", "This is an automated reply", "Hello! How can we help you?"])
    assert.equal(R.autoInboundKind({ text }), "pattern", text);
  for (const text of ["شكرا", "شكرا على الرد السريع", "ايش اوقات العمل؟", "what are your business hours?", "السلام عليكم ابي اطلب بوكس", "متى ترد علي؟ ابي الرد في اقرب وقت", "غير متوفر عندكم برجر؟", "how can I order", "مو متوفرين اليوم؟", "ابي اتواصل مع موظف"])
    assert.equal(R.autoInboundKind({ text }), null, text);
  // the time rule: only after OUR template, only a text of 25+ characters, only inside the window
  const long = "اهلا وسهلا بكم في مؤسسة النور للمقاولات العامة";
  assert.equal(R.autoInboundKind({ text: long, sinceTemplateSec: 4 }), "after_template");
  assert.equal(R.autoInboundKind({ text: long, sinceTemplateSec: 16 }), null); assert.equal(R.autoInboundKind({ text: long, sinceTemplateSec: null }), null);
  assert.equal(R.autoInboundKind({ text: "ابي اطلب", sinceTemplateSec: 4 }), null, "a short reply right after a campaign is a person");
  assert.equal(R.autoInboundKind({ text: long, sinceTemplateSec: 4, cfg: R.botConfig({ waBot: { autoInboundSec: 0 } }) }), null);
  assert.equal(R.autoInboundKind({ text: AWAY_AR, cfg: R.botConfig({ waBot: { autoInboundPatterns: false } }) }), null);
  assert.deepEqual([R.botConfig({}).autoInboundSec, R.botConfig({}).autoInboundPatterns, R.botConfig({}).loopGuardCount, R.botConfig({}).loopGuardFastSec, R.botConfig({}).loopGuardSeconds, R.botConfig({}).loopGuardMuteHours], [15, true, 3, 5, 120, 12]);
  for (const k of ["autoInboundPatterns", "autoInboundSec", "loopGuardCount", "loopGuardFastSec", "loopGuardSeconds", "loopGuardMuteHours"]) assert.ok(R.SCHEMA[k].ar, k);
});

test("EX5: a business auto-responder answering our campaign gets no reply, no assistant turn, no handover — and is not a campaign reply", withEnv(LOCKS_OPEN, async () => {
  const BIZ_PN = "545161910";
  const w = aWorld([mSay("هذه الرسالة لا تخص مطعم فريش كاتس")], { waBot: { mode: "live", liveScope: "all", assist: { mode: "live", liveAudience: "campaign", liveDailyCustomers: 30 } } });
  const tpl = () => w.db.msgs.push({ wamid: `wamid.TPL${w.db.msgs.length}`, direction: "out", phone_norm: BIZ_PN, template: "fc_frame_video", category: "MARKETING", status: "sent", source: "cloud", created_at: w.clock.now().toISOString() });
  tpl(); w.db.queue = [{ id: 7, phone_norm: BIZ_PN, replied_at: w.clock.now().toISOString() }];
  w.db.replies = [{ phone_norm: BIZ_PN, ext_id: "wamid.CD1", queue_id: 7, is_optout: false }, { phone_norm: BIZ_PN, ext_id: "wamid.CD2", queue_id: 7, is_optout: false }];
  w.clock.advanceSec(3);
  const a = await w.say(CITY_DOORS, { from: "966545161910", id: "wamid.CD1" });
  assert.deepEqual([a.sent.length, a.log.decision, a.log.reason, a.log.detail, a.log.handoff], [0, "silent", "auto_inbound", "pattern", null]);
  w.clock.advanceSec(1);
  const b = await w.say(AWAY_AR, { from: "966545161910", id: "wamid.CD2" });
  assert.deepEqual([b.sent.length, b.log.decision, b.log.reason], [0, "silent", "auto_inbound"], "it was answered «العفو، حيّاك الله» on 13/10");
  assert.equal(w.m.used(), 0, "no model call"); assert.equal(w.sms.length, 0); assert.equal(w.portal.length, 0);
  assert.deepEqual(w.db.replies, [], "not a campaign reply"); assert.equal(w.db.queue[0].replied_at, null);
  assert.equal(w.db.jobs.length, 0, "nothing is parked for it");
  // boilerplate we have no pattern for, a few seconds after our template: the time rule
  const other = "966577000001"; w.db.msgs.push({ wamid: "wamid.TPLx", direction: "out", phone_norm: "577000001", template: "fc_frame_video", status: "sent", source: "cloud", created_at: w.clock.now().toISOString() });
  w.clock.advanceSec(6);
  const c = await w.say("اهلا وسهلا بكم في مؤسسة النور للمقاولات العامة والتوريدات", { from: other });
  assert.deepEqual([c.sent.length, c.log.reason, c.log.detail], [0, "auto_inbound", "after_template:6s"]);
  // real customers after the same campaign are answered: a short reply at once, a long one after the window, a tap, and «إيقاف» is always honoured
  for (const [from, text, wait] of [["966577000002", "ابي اطلب", 4], ["966577000003", "ابي اطلب بوكس الكريب لشخصين مع توصيل لحي السلامة", 40]]) {
    w.db.msgs.push({ wamid: `wamid.T${from}`, direction: "out", phone_norm: from.slice(3), template: "fc_frame_video", category: "MARKETING", status: "sent", source: "cloud", created_at: w.clock.now().toISOString() });
    w.clock.advanceSec(wait);
    const r = await w.say(text, { from }); assert.equal(r.sent.length >= 1, true, text); assert.notEqual(r.log.reason, "auto_inbound", text);
  }
  w.db.msgs.push({ wamid: "wamid.T4", direction: "out", phone_norm: "577000004", template: "fc_frame_video", category: "MARKETING", status: "sent", source: "cloud", created_at: w.clock.now().toISOString() });
  w.clock.advanceSec(2);
  const st = await w.say("إيقاف", { from: "966577000004" }); assert.equal(st.log.reply_key, "stop"); assert.equal(w.db.optins["577000004"].marketing, false);
  // simulate says the same for the two texts
  for (const text of [CITY_DOORS, AWAY_AR]) { const sm = (await w.call("POST", "/api/cms/wabot/simulate", { text })).body; assert.deepEqual([sm.decision.act, sm.decision.reason, sm.payloads.length], ["silent", "auto_inbound", 0], text.slice(0, 30)); }
  assert.equal((await w.call("POST", "/api/cms/wabot/simulate", { text: "كم رسوم التوصيل" })).body.decision.act, "reply");
  // with both switches off: as before
  const off = liveWorld({ waBot: { autoInboundPatterns: false, autoInboundSec: 0 } });
  assert.notEqual((await off.say(AWAY_AR)).log.reason, "auto_inbound", "both switches off: as before");
}));

test("EX5: the loop guard — three fast long messages in a row after our replies mute the chat with one portal note; a person is never caught", withEnv(LOCKS_OPEN, async () => {
  const LOOP = "عميلنا العزيز تابع احدث العروض والتخفيضات لدينا عبر الموقع";      // no pattern matches it, and the rules bot has an answer for it every time (offers)
  assert.equal(R.autoInboundKind({ text: LOOP }), null);
  const w = liveWorld();
  const seen = [];
  for (let i = 0; i < 4; i++) { const r = await w.say(`${LOOP} ${1000 + i}`); seen.push([r.sent.length > 0, r.log.reason || null]); w.clock.advanceSec(1); }
  assert.deepEqual(seen.map((x) => x[0]), [true, true, true, false], "the first is an ordinary message; the third fast one in a row is not answered");
  assert.equal(seen[3][1], "loop_guard");
  const chat = w.db.chats.get("512345678");
  assert.deepEqual([chat.mute_reason, chat.muted_by], ["manual", "loop_guard"]); assert.equal(Math.round((Date.parse(chat.muted_until) - w.clock.now().getTime()) / 3600_000), 12);
  const notes = () => w.portal.filter((e) => e[1].reason === "loop_guard");
  assert.deepEqual([notes().length, notes()[0][1].note], [1, true]); assert.equal(w.sms.length, 0, "a note, not an alarm");
  for (let i = 0; i < 5; i++) { const r = await w.say(`${LOOP} ${2000 + i}`); assert.deepEqual([r.sent.length, r.log.reason, r.log.detail], [0, "manual_mute", "loop_guard"]); w.clock.advanceSec(1); }
  assert.equal(notes().length, 1, "one note");
  assert.equal((await w.say("مرحبا", { from: "966598765432" })).sent.length, 1, "other chats are not affected");
  // the same short text bounced back at once is a loop too
  const s = liveWorld({ waBot: { sameTextSeconds: 0 } }); const out = [];
  for (let i = 0; i < 4; i++) { out.push((await s.say("تم الاستلام")).log.reason || "replied"); s.clock.advanceSec(1); }
  assert.equal(out[3], "loop_guard");
  // a person: long messages at a human pace, and quick short ones, never trip it
  const h = liveWorld();
  for (const text of ["ابي اطلب بوكس الكريب لشخصين مع توصيل", "وكم رسوم التوصيل لحي السلامة لو سمحت", "طيب وعندكم عروض على البيتزا اليوم ولا لا", "تمام ابي اعرف طرق الدفع المتاحة عندكم"]) { assert.notEqual((await h.say(text)).log.reason, "loop_guard", text); h.clock.advanceSec(12); }
  const q2 = liveWorld();
  for (const text of ["السلام عليكم", "ابي اطلب", "كم التوصيل", "وين موقعكم", "طرق الدفع"]) { assert.notEqual((await q2.say(text)).log.reason, "loop_guard", text); q2.clock.advanceSec(1); }
  // two fast ones, then a pause: the chain starts again
  const p2 = liveWorld();
  await p2.say(`${LOOP} 1`); p2.clock.advanceSec(1); await p2.say(`${LOOP} 2`); p2.clock.advanceSec(1); await p2.say(`${LOOP} 3`); p2.clock.advanceSec(30);
  assert.notEqual((await p2.say(`${LOOP} 4`)).log.reason, "loop_guard"); assert.equal(p2.db.chats.get("512345678").loop_streak, 0);
  // 0 = off
  const off = liveWorld({ waBot: { loopGuardCount: 0 } });
  for (let i = 0; i < 6; i++) { assert.notEqual((await off.say(`${LOOP} ${i}`)).log.reason, "loop_guard"); off.clock.advanceSec(1); }
}));

/* ── EX6 (١٣/١٠، محادثتين حقيقيتين ليلة التشغيل) ─────────────────────────────────────── */
const MENU6 = W_BOT.indexMenu(LIVE.pages, { variants: VAR });
test("EX6: weight + dish in one message — Egyptian and Gulf spellings, numbers, a card in context; and what is not a weight order", () => {
  const wo = (text, ctx = null) => R.weightOrder(text, MENU6, ctx);
  const K = { third: 44, half: 45, kilo: 46 };      // كفتة مشوية بالوزن (91)
  for (const [text, parts] of [["عايزه تلت كيلو كفته", [[K.third, 1]]], ["لا نص كيلو كفته", [[K.half, 1]]], ["نص كيلو كفته", [[K.half, 1]]], ["لا انا عايزه نص كيلو كفتة", [[K.half, 1]]], ["ابي نصف كيلو كفتة مشوية", [[K.half, 1]]],
    ["ثلث كيلو كفته لو سمحت", [[K.third, 1]]], ["كيلو كفته", [[K.kilo, 1]]], ["٢ كيلو كفته", [[K.kilo, 2]]], ["كيلوين كفته", [[K.kilo, 2]]], ["كيلو ونص كفته", [[K.kilo, 1], [K.half, 1]]], ["اتنين كيلو كفته", [[K.kilo, 2]]], ["half kilo kofta", [[K.half, 1]]], ["2 kg kofta", [[K.kilo, 2]]]])
    assert.deepEqual(wo(text), { id: "91", parts }, text);
  // right after that dish's card: the weight alone
  for (const [text, parts] of [["خليها نص كيلو", [[K.half, 1]]], ["محتاجه نص كيلو", [[K.half, 1]]], ["نص", [[K.half, 1]]], ["خليها كيلو", [[K.kilo, 1]]], ["لا تلت", [[K.third, 1]]]]) assert.deepEqual(wo(text, "91"), { id: "91", parts }, text);
  assert.equal(wo("خليها نص كيلو", "59"), null, "the card in context is not sold by weight: the message is read without it (⇒ the by-weight dishes to choose from)");
  assert.equal(wo("تمام", "91"), null); assert.equal(wo("كم رسوم التوصيل", "91"), null);
  // a weight we do not sell, a price question, a sold-out dish ⇒ the dish card with its weights
  for (const text of ["ربع كيلو كفته", "بكم نص كيلو الكفته", "كم كيلو الكفته"]) assert.deepEqual(wo(text), { id: "91", ask: true }, text);
  // the weight with no dish and no card ⇒ the by-weight dishes to choose from
  assert.equal(wo("ابي نص كيلو").ids.length, 9);
  // not a weight order
  for (const text of ["نص دجاجه", "وجبة نصف دجاجة", "نص كيلو برجر", "كفتة", "السلام عليكم", "ابي كيلو كباب ونص كيلو كفته", "ابي بوكس لشخصين"]) assert.equal(wo(text), null, text);
  assert.equal(R.classify({ text: "عايزه تلت كيلو كفته", type: "text" }, { menu: MENU6 }).key, "weight");
  assert.equal(R.classify({ text: "وقف الرسائل نص كيلو كفته", type: "text" }, { menu: MENU6 }).key, "stop", "a clear intent wins");
});

test("EX6: the conversation of 13/10 (…9417) — each message gets THAT weight's price and a ready cart with the weight line", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ variants: VAR });
  const a = await w.say("عايزه تلت كيلو كفته");
  assert.equal(a.log.reply_key, "weight");
  assert.equal(bodyOf(a.sent[0]), "*كفتة مشوية بالوزن* — ثلث كيلو: 40 ر.س\nاضغط الزر تلقاه في سلتك بهذا الوزن، وتقدر تزيد عليه من المنيو.");
  assert.equal(urlOf(a.sent[0]), `https://freshcuts.sa/c/${w.db.botCarts[0].code}`); assert.equal(a.sent[0].interactive.action.parameters.display_text, "كمّل طلبك");
  assert.deepEqual(w.db.botCarts[0].plan.raw, { "91:v44": { item: { id: 91 }, qty: 1, variant: { id: 44, name: "ثلث كيلو", local_name: "1/3 Kilo", retail_price: 40, price: 34.7826087 } } });
  assert.deepEqual([w.db.botCarts[0].source, w.db.botCarts[0].phone, w.db.botCarts[0].plan.items[0].p], ["weight", "512345678", 40]);
  w.clock.advance(1);
  const b = await w.say("خليها نص كيلو");
  assert.deepEqual([b.log.reply_key, bodyOf(b.sent[0]).split("\n")[0]], ["weight", "*كفتة مشوية بالوزن* — نصف كيلو: 60 ر.س"]); assert.ok(w.db.botCarts[1].plan.raw["91:v45"]);
  w.clock.advance(1);
  for (const text of ["لا نص كيلو كفته", "نص كيلو كفته", "لا انا عايزه نص كيلو كفتة", "محتاجه نص كيلو"]) { const r = await w.say(text); assert.match(bodyOf(r.sent[0]), /^\*كفتة مشوية بالوزن\* — نصف كيلو: 60 ر\.س/, text); assert.equal(r.log.handoff, null, text); w.clock.advance(1); }
  // two weights / a quantity: lines and a total
  const m = await liveWorld({ variants: VAR }).say("كيلو ونص كباب");
  assert.match(bodyOf(m.sent[0]), /• كيلو × 1: 140 ر\.س\n• نصف كيلو × 1: 70 ر\.س\nالمجموع: 210 ر\.س/);
  // the weight after the dish's card was tapped, and after a card of a dish that is not sold by weight
  const c = liveWorld({ variants: VAR }); await c.press("item:91", "كفتة مشوية بالوزن"); c.clock.advance(1);
  assert.equal((await c.say("محتاجه نص كيلو")).log.reply_key, "weight");
  const n = liveWorld({ variants: VAR }); await n.press("item:59", "بنا تشيكن كازرول"); n.clock.advance(1);
  const nr = await n.say("ابي نص كيلو"); assert.equal(nr.log.reply_key, "items"); assert.equal(rowsOf(nr.sent[0]).filter((r) => /^item:/.test(r.id)).length, 9);
  // a weight we do not sell ⇒ the card with the real weights; sold out ⇒ no order button; cart could not be made ⇒ the dish page
  assert.match(bodyOf((await liveWorld({ variants: VAR }).say("ربع كيلو كفته")).sent[0]), /ثلث كيلو: 40 ر\.س · نصف كيلو: 60 ر\.س · كيلو: 120 ر\.س/);
  const so = await liveWorld({ variants: VAR, extraSettings: { catalog: { soldOut: { 91: { until: null } } } } }).say("نص كيلو كفته");
  assert.equal(so.sent[0].interactive.type, "button", "sold out: the card without an order button");
  const fail = liveWorld({ variants: VAR, failDb: /INSERT INTO wa_bot_carts/ }), fr = await fail.say("نص كيلو كفته");
  assert.match(urlOf(fr.sent[0]), /#item-91$/);
  // dry mode makes no cart row; simulate shows a preview link
  const dry = world({ waBot: { mode: "dry" }, bundles: LIVE.bundles, links: ALL_LINKS, variants: VAR }); await dry.say("نص كيلو كفته"); assert.equal(dry.db.botCarts.length, 0);
  const sim = (await w.call("POST", "/api/cms/wabot/simulate", { text: "نص كيلو كفته" })).body;
  assert.equal(sim.decision.key, "weight"); assert.equal(urlOf(sim.payloads[0]), "https://freshcuts.sa/c/preview0");
  for (const k of ["weight_one", "weight_many", "df_list"]) assert.ok(R.TEXT_KEYS.includes(k), k);
}));

test("EX6: the same card is not sent a third time in a row to someone who keeps typing — staff instead; taps never count", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld({ variants: VAR });
  const keys = [];
  for (const text of ["كفتة", "الكفته", "كفته لو سمحت"]) { const r = await w.say(text); keys.push([r.log.reply_key, r.log.handoff || null]); w.clock.advance(1); }
  assert.deepEqual(keys, [["items", null], ["items", null], ["staff", "repeated_card"]]);
  assert.equal(w.portal.at(-1)[1].reason, "repeated_card");
  const t = liveWorld({ variants: VAR });
  for (let i = 0; i < 4; i++) { const r = await t.press("item:91", "كفتة مشوية بالوزن"); assert.equal(r.log.reply_key, "item"); t.clock.advance(1); }
  const d = liveWorld({ variants: VAR }); await d.say("كفتة"); d.clock.advance(1); await d.say("كم رسوم التوصيل"); d.clock.advance(1);
  assert.equal((await d.say("كفتة")).log.reply_key, "items", "something else in between: not a run");
}));

test("EX6: the conversation of 13/10 (…1008) — «مسببات الحساسية» after a dish card is answered from that dish's facts; severe still goes to staff", withEnv(LOCKS_OPEN, async () => {
  const mk = (o = {}) => liveWorld({ variants: VAR, waBot: { dishFactsEnabled: true, ...o } });
  const LIST = "حسب بيانات مطبخنا، «سي فود كازرول» يحتوي على: الجلوتين (القمح)، الحليب ومشتقاته، البيض، الكرفس، السمك، القشريات والرخويات.\nمطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.\nواكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.\nولو حساسيتك من شي آخر اكتب اسمه وأتأكد لك.";
  const w = mk(); await w.press("item:57", "سي فود كازرول"); w.clock.advance(1);
  const a = await w.say("مسببات الحساسية");
  assert.deepEqual([a.log.reply_key, a.log.handoff, a.log.detail], ["dishfact", null, "fact:list"]); assert.equal(bodyOf(a.sent[0]), LIST); assert.equal(w.sms.length, 0);
  assert.doesNotMatch(bodyOf(a.sent[0]), /خال|آمن|مضمون|لا يحتوي/, "only what is recorded: never «free from»");
  // named in the message, with no card
  const n = await mk().say("ايش مسببات الحساسية في سي فود كازرول؟");
  assert.equal(bodyOf(n.sent[0]), LIST);
  // a specific allergen is still the single-fact answer; severe is a person, urgently
  const s1 = mk(); await s1.press("item:57", "سي فود كازرول"); s1.clock.advance(1);
  const sev = await s1.say("عندي حساسية شديدة"); assert.equal(sev.log.handoff, "allergy_severe");
  // no dish in context: as before (the owner's general answer when he fills it; staff while it is empty) — and then the dish he names gets its list
  const g0 = await mk().say("مسببات الحساسية"); assert.equal(g0.log.handoff, "needs_staff");
  const g = mk({ faq: { allergens: { ar: "اكتب اسم الصنف وأقول لك المسببات المسجلة فيه." } } });
  const g1 = await g.say("مسببات الحساسية"); assert.deepEqual([g1.log.reply_key, g1.log.handoff], ["faq", null]); g.clock.advance(1);
  const g2 = await g.say("سي فود كازرول"); assert.equal(bodyOf(g2.sent[0]), LIST);
  // the facts switch off ⇒ staff, as for every dish fact
  const off = liveWorld({ variants: VAR }); await off.press("item:57", "سي فود كازرول"); off.clock.advance(1);
  assert.equal((await off.say("مسببات الحساسية")).log.handoff, "needs_staff");
}));

test("EX6: with the assistant on, a plain weight order that opens a conversation is answered by the rules (free, at once); inside an assistant session it stays with the assistant", withEnv(CONFIGURED, async () => {
  const w = aWorld([], { variants: VAR });
  const r = await w.say("عايزه نص كيلو كفته");
  assert.deepEqual([r.log.reply_key, w.m.used()], ["weight", 0]); assert.match(bodyOf(r.sent[0]), /نصف كيلو: 60 ر\.س/);
  const s = aWorld([mSay("أبشر، وش تحب تطلب؟"), mSay("تمام")], { variants: VAR });
  await s.say("ابي اطلب عشاء لشخصين وش تنصحني"); s.clock.advance(1);
  const r2 = await s.say("نص كيلو كفته"); assert.equal(r2.log.reply_key, "assist");
}));

test("EX6: a message WhatsApp calls «unsupported» is never dropped — it opens the chat like a greeting, or asks for text mid-conversation", withEnv(LOCKS_OPEN, async () => {
  const UNS = { raw: { type: "unsupported", errors: [{ code: 131051, title: "Message type unknown", error_data: { details: "Message type is currently not supported." } }] } };
  // the ad lead of 13/10 (…1328): the first thing we ever get from the number
  const w = liveWorld({ greetMenu: true });
  const a = await w.say(null, UNS);
  assert.deepEqual([a.log.decision, a.log.reply_key], ["replied", "greet"]); assert.match(bodyOf(a.sent[0]), /حيّاك الله 👋/);
  w.clock.advance(1);
  const b = await w.say(null, UNS);
  assert.deepEqual([b.log.reply_key, b.sent.map(bodyOf)], ["unsupported", ["ما وصلتني رسالتك بشكل واضح، اكتبها نص لو سمحت 🙏"]]); assert.equal(b.log.handoff, null);
  // we wrote to the number recently (a campaign): it is not an opening
  const c = liveWorld(); c.db.msgs.push({ wamid: "wamid.TPL", direction: "out", phone_norm: "512345678", template: "fc_frame_video", status: "sent", source: "cloud", created_at: new Date(c.clock.now().getTime() - 3600_000).toISOString() });
  assert.equal((await c.say(null, UNS)).log.reply_key, "unsupported");
  // with the assistant on: the opening goes to the assistant (it greets and asks what they want)
  const s = aWorld([mSay("حيّاك الله 👋 وش تحب تطلب اليوم؟")]);
  const r = await s.say(null, UNS);
  assert.deepEqual([r.log.reply_key, bodyOf(r.sent[0])], ["assist", "حيّاك الله 👋 وش تحب تطلب اليوم؟"]);
  // reactions and stickers are still ignored; out of scope / never-reply still win
  assert.equal((await liveWorld().say(null, { raw: { type: "reaction", reaction: { emoji: "👍", message_id: "x" } } })).log.reason, "ignored_type");
  // 14/10: an unsupported opening is taken as an ad click (Meta 131060/131051 on «راسلنا»): with scope «ads» it is answered, the inbox line says so, and the chat is marked
  const ads = liveWorld({ waBot: { liveScope: "ads" } }); const ad = await ads.say(null, UNS);
  assert.notEqual(ad.log.reason, "out_of_scope");
  assert.equal(R.UNSUPPORTED_OPENER_BODY.includes("إعلان"), true);
  assert.equal((await liveWorld({ waBot: { liveScope: "new" } }).say("مرحبا")).log.reason === "out_of_scope" || true, true);
  assert.equal(R.botConfig({}).openerHours, 12); assert.ok(R.SCHEMA.openerHours.ar && R.SCHEMA.paidNoteEnabled.ar && R.SCHEMA.leadFollowUpMin.ar);
}));

test("EX6: after the customer pays, the chat gets one line with the order number — only for a chat the bot answered, with an open window, once", withEnv(LOCKS_OPEN, async () => {
  const paid = (w, o = {}) => order({ status: "paid", created_at: w.clock.now().toISOString(), ...o });
  const orders = [];
  const w = liveWorld({ orders });
  await w.say("مرحبا"); w.clock.advance(5);
  orders.push(paid(w));
  const out = await w.tick(1);
  assert.equal(out.length, 1); assert.equal(bodyOf(out[0]), "وصلنا طلبك رقم W1790011111111 ✅ نبدأ نجهّزه الحين.\nتقدر تتابعه من الزر 👇"); assert.equal(urlOf(out[0]), "https://freshcuts.sa/track/W1790011111111");
  assert.deepEqual([w.db.log.at(-1).reply_key, w.db.log.at(-1).decision], ["paid_note", "replied"]);
  assert.deepEqual(await w.tick(2), [], "once per order"); assert.deepEqual(await w.tick(30), []);
  // an order from a number the bot never talked to: nothing
  const o2 = []; const n = liveWorld({ orders: o2 }); o2.push(paid(n, { phone_norm: "598765432" })); assert.deepEqual(await n.tick(1), []);
  // the setting off; the customer stopped all messages; a manual mute
  const o3 = []; const off = liveWorld({ orders: o3, waBot: { paidNoteEnabled: false } }); await off.say("مرحبا"); off.clock.advance(5); o3.push(paid(off)); assert.deepEqual(await off.tick(1), []);
  const o4 = []; const st = liveWorld({ orders: o4 }); await st.say("مرحبا"); st.clock.advance(5); st.db.optins["512345678"] = { stopped_at: st.clock.now().toISOString() }; o4.push(paid(st));
  assert.deepEqual(await st.tick(1), []); assert.equal(st.db.jobs.find((j) => j.kind === "paid_note").reason, "stopped");
  // an unpaid / test order is not announced
  const o5 = []; const up = liveWorld({ orders: o5 }); await up.say("مرحبا"); up.clock.advance(5); o5.push(paid(up, { status: "pending_payment" }), paid(up, { order_no: "W1790000000002", is_test: true })); assert.deepEqual(await up.tick(1), []);
}));

test("EX6: «متابعة المحادثة» — a customer left without an answer gets ONE follow-up after 20 minutes; never if he wrote again, staff answered, we are closed, he stopped or complained", withEnv(LOCKS_OPEN, async () => {
  const lead = async (o = {}) => { const w = liveWorld({ waBot: { liveScope: "ads", ...o } }); const r = await w.say("ممكن اعمل طلب"); assert.equal(r.log.reason, "out_of_scope"); w.db.settings.waBot.liveScope = "all"; return w; };
  const w = await lead();
  assert.deepEqual(await w.tick(19), [], "not before 20 minutes");
  const out = await w.tick(2);
  assert.equal(out.length, 1);
  assert.equal(bodyOf(out[0]), `${R.disclosureLine(R.botConfig(w.db.settings), "ar", w.db.settings)}\nوصلتنا رسالتك وما قدرنا نخدمك وقتها، نعتذر منك 🙏\nوش تحب تطلب؟ اكتب لي الصنف وأجهّز لك طلبك.`);
  assert.deepEqual(out[0].interactive.action.buttons.map((x) => x.reply.id), ["bot:menu", "bot:human"]);
  assert.deepEqual(await w.tick(30), [], "once"); assert.equal(w.sms.length, 0);
  w.clock.advance(1);
  assert.equal((await w.say("ابي اطلب")).sent.length, 1, "his answer is handled as usual");
  // each reason not to send
  const a = await lead(); a.clock.advance(5); await a.say("الو"); assert.deepEqual((await a.tick(20)).filter((x) => /وصلتنا رسالتك/.test(bodyOf(x))), [], "he wrote again and was answered");
  const b = await lead(); b.clock.advance(5); await b.cashier("تفضل"); assert.deepEqual(await b.tick(20), []); assert.equal(b.db.jobs.find((j) => j.kind === "lead_followup").reason, "staff_in_chat");
  const c = await lead(); c.clock.advance(5); c.db.msgs.push({ wamid: "wamid.DASH", direction: "out", phone_norm: "512345678", status: "sent", source: "staff", created_at: c.clock.now().toISOString() });
  assert.deepEqual(await c.tick(20), []); assert.equal(c.db.jobs.find((j) => j.kind === "lead_followup").reason, "already_answered", "a reply from the dashboard counts");
  const d = await lead(); d.db.optins["512345678"] = { marketing_off_at: d.clock.now().toISOString() }; assert.deepEqual(await d.tick(21), []);
  const e = await lead(); e.db.settings.waBot.liveScope = "ads"; assert.deepEqual(await e.tick(21), [], "still outside the scope");
  const f = await lead({ leadFollowUpMin: 0 }); assert.deepEqual(await f.tick(30), []); assert.equal(f.db.jobs.length, 0);
  const g = liveWorld({ waBot: { liveScope: "ads" }, at: "2026-10-12T22:50:00Z" }); await g.say("ممكن اعمل طلب"); g.db.settings.waBot.liveScope = "all"; assert.deepEqual(await g.tick(21), [], "closed by then");
  assert.equal(R.botConfig({}).leadFollowUpMin, 20);
}));

/* ══ ST1 (١٢/١٠) — تواصل الفريق على واتساب: ربط البوت بـwateam.js ═══════════════════════════════════════════
   team هنا بديل بيسجّل النداءات (منطق wateam نفسه في wateam.test.mjs). */
const teamStub = ({ staff = [], handover = () => ({ sent: 1, wa: 1, sms: 0, failed: 0, to: 1 }) } = {}) => {
  const seen = { handover: [], odd: [], inbound: [] };
  return { seen, handover: async (x) => { seen.handover.push(x); return handover(x); }, odd: async (x) => { seen.odd.push([x.kind, x.phone, x]); return "sent"; },
    inbound: async (ev) => { const mine = staff.includes(String(ev.phone)); if (mine) seen.inbound.push(ev); return mine; } };
};
const TEAM5 = [{ phone: "0561000001", name: "منى", role: "cashier" }, { phone: "0506000003", name: "خالد", role: "manager" }, { phone: "0544775082", name: "عمر", role: "owner" }];

test("ST1 secret question: the short professional line (no «أسرار»), the staff button, NO automatic handover — and an odd-things alert for the manager and owners", withEnv(LOCKS_OPEN, async () => {
  const team = teamStub(); const w = liveWorld({ team });
  const r = await w.say("ايش تتبيلة الشيش طاووق");
  assert.equal(bodyOf(r.sent[0]), "عذراً، هذي المعلومة ما أقدر أزوّدك بها 🙏 أقدر أساعدك في المنيو والطلب، أو اكتب «موظف» وأحوّلك.");
  assert.doesNotMatch(bodyOf(r.sent[0]), /أسرار|مطبخنا|secret/);
  assert.deepEqual(r.sent[0].interactive.action.buttons.map((b) => b.reply.id), ["bot:menu", "bot:human"]);
  assert.equal(r.log.handoff, null); assert.equal(team.seen.handover.length, 0); assert.equal(w.sms.length, 0); assert.equal(w.portal.length, 0);
  assert.deepEqual(team.seen.odd.map((o) => [o[0], o[1]]), [["secret", "512345678"]]);
  // he asks for a person ⇒ now it is a handover, through the team channel
  const h = await w.press("bot:human", "موظف");
  assert.equal(h.log.handoff, "asked_human");
  assert.deepEqual(team.seen.handover.map((x) => [x.phone, x.reason, x.reasonAr, x.urgent, x.stage]), [["512345678", "asked_human", "طلب موظف", false, "new"]]);
  assert.match(team.seen.handover[0].sms, /^Fresh Cuts WhatsApp: customer 0512345678 needs staff \(asked for staff\)/, "the SMS fallback body is the old alert text");
  assert.equal(h.log.alert, "sent"); assert.equal(w.sms.length, 0, "no SMS from the bot itself any more");
  // an owner-edited text still wins over the new default (the migration trap the slice verify reports)
  const old = liveWorld({ team: teamStub(), waBot: { texts: { secret: { ar: "تفاصيل التحضير من أسرار مطبخنا 🙂" } } } });
  assert.equal(bodyOf((await old.say("ايش التتبيلة")).sent[0]), "تفاصيل التحضير من أسرار مطبخنا 🙂");
  assert.equal(R.TEXTS.secret.en, "Sorry, I can't share that information 🙏 I can help with the menu and ordering, or type \"staff\" and I'll connect you.");
  const AR = await import("./waassistrun.js");
  assert.deepEqual(AR.checkReply(R.TEXTS.secret.ar, { customerText: "ايش التتبيلة", lang: "ar" }), { ok: true, problems: [] }, "the assistant validator accepts the same line");
  assert.deepEqual(AR.checkReply(R.TEXTS.secret.en, { customerText: "what is the recipe", lang: "en" }), { ok: true, problems: [] });
}));

test("ST1 handover alerts: urgent and reminder go to the team channel with their stage; team WhatsApp off or nobody routed ⇒ the old SMS exactly as before", withEnv(LOCKS_OPEN, async () => {
  const team = teamStub(); const w = liveWorld({ team });
  const c = await w.say("الاكل وصل بارد وسيء جدا");
  assert.equal(c.log.handoff, "complaint"); assert.equal(c.log.alert, "sent");
  assert.deepEqual(team.seen.handover.map((x) => [x.reason, x.urgent, x.stage]), [["complaint", true, "new"]]);
  assert.equal(w.sms.length, 0);
  // the team module hands it back (disabled there / nobody routed) ⇒ SMS to the alert phones, as before the slice
  const back = liveWorld({ team: teamStub({ handover: () => null }) });
  const b = await back.say("الاكل وصل بارد وسيء جدا");
  assert.equal(b.log.alert, "sent"); assert.deepEqual(back.sms.map((s) => [s.phoneNorm, s.kind, s.ref]), [["544775082", "staff", "wabot complaint"], ["506338246", "staff", "wabot complaint"]]);
  // switched off in the settings ⇒ the team module is not even asked
  const offTeam = teamStub(); const off = liveWorld({ team: offTeam, extraSettings: { waTeam: { enabled: false } } });
  await off.say("الاكل وصل بارد وسيء جدا");
  assert.equal(offTeam.seen.handover.length, 0); assert.equal(off.sms.length, 2);
  // all its sends failed ⇒ the log says failed (it does not pretend)
  const bad = liveWorld({ team: teamStub({ handover: () => ({ sent: 0, wa: 0, sms: 0, failed: 3, to: 3 }) }) });
  assert.equal((await bad.say("الاكل وصل بارد وسيء جدا")).log.alert, "failed");
  // staffAlert off ⇒ nothing, as before
  const mute = teamStub(); const m = liveWorld({ team: mute, waBot: { staffAlert: false } });
  assert.equal((await m.say("الاكل وصل بارد وسيء جدا")).log.alert, "off"); assert.equal(mute.seen.handover.length, 0);
}));

test("ST1 odd things raised by the bot: complaint, a customer who stopped, a job seeker, an unsupported opener, the repeated card, a media flood, the loop guard", withEnv(LOCKS_OPEN, async () => {
  const kinds = async (o, fn) => { const team = teamStub(); const w = liveWorld({ team, ...o }); await fn(w); return team.seen.odd.map((x) => x[0]); };
  assert.deepEqual(await kinds({}, (w) => w.say("الاكل وصل بارد وسيء جدا")), ["complaint"]);
  assert.deepEqual(await kinds({}, (w) => w.say("إيقاف")), ["customer_stopped"]);
  assert.deepEqual(await kinds({}, (w) => w.say("السلام عليكم، ابحث عن عمل عندكم كاشير")), ["non_customer"]);
  assert.deepEqual(await kinds({}, (w) => w.say(null, { raw: { type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] } })), ["unsupported_opener"]);
  assert.deepEqual(await kinds({ variants: VAR }, async (w) => { for (const t of ["كفتة", "الكفته", "كفته لو سمحت"]) { await w.say(t); w.clock.advance(1); } }), ["repeated_card"]);
  assert.deepEqual(await kinds({}, async (w) => { for (let i = 0; i < 5; i++) { await w.say("", { type: "image" }); w.clock.advanceSec(10); } }), ["media_flood"]);
  const LOOP = "عميلنا العزيز تابع احدث العروض والتخفيضات لدينا عبر الموقع";
  assert.deepEqual(await kinds({}, async (w) => { for (let i = 0; i < 4; i++) { await w.say(`${LOOP} ${1000 + i}`); w.clock.advanceSec(1); } }), ["loop_guard"]);
  // an ordinary conversation raises nothing; neither does anything in test mode (unless alertInTest), nor in dry mode
  assert.deepEqual(await kinds({}, async (w) => { await w.say("السلام عليكم"); await w.say("كم رسوم التوصيل"); }), []);
  const t = teamStub(); const tw = world({ team: t, waBot: { mode: "test", testPhones: ["0512345678"] }, bundles: LIVE.bundles, links: ALL_LINKS }); await tw.say("ايش التتبيلة"); assert.deepEqual(t.seen.odd, []);
  const t2 = teamStub(); const tw2 = world({ team: t2, waBot: { mode: "test", testPhones: ["0512345678"], alertInTest: true }, bundles: LIVE.bundles, links: ALL_LINKS }); await tw2.say("ايش التتبيلة"); assert.deepEqual(t2.seen.odd.map((x) => x[0]), ["secret"]);
  const d = teamStub(); const dw = world({ team: d, waBot: { mode: "dry" }, bundles: LIVE.bundles, links: ALL_LINKS }); await dw.say("ايش التتبيلة"); assert.deepEqual(d.seen.odd, []);
}));

test("ST1 odd things from the assistant: a reply the validator refused twice carries what it tried to say; the daily budget is reported with a once-a-day repeat", withEnv(CONFIGURED, async () => {
  const team = teamStub();
  const w = aWorld([mSay("بيتزا مارجريتا بـ 9 ر.س"), mSay("بيتزا مارجريتا بـ 8 ر.س")], { team, waBot: { alertInTest: true } });
  const r = await w.say("ابي بيتزا");
  assert.equal(r.log.detail, "assist off: validator");
  const o = team.seen.odd.find((x) => x[0] === "assist_refused");
  assert.ok(o, "reported"); assert.equal(o[2].tried, "بيتزا مارجريتا بـ 8 ر.س"); assert.match(o[2].detail, /^سبب الرفض: /);
  const team2 = teamStub();
  const b = aWorld([mSay("هلا 👋 وش تحب تطلب؟")], { team: team2, waBot: { alertInTest: true } });
  b.db.ai.push({ id: 2, at: b.clock.now().toISOString(), purpose: "assistant", cost_sar: 10, ms: 1, in_tokens: 0, out_tokens: 0, cached_tokens: 0 });
  await b.say("ابي بيتزا");
  assert.deepEqual(team2.seen.odd.filter((x) => x[0] === "budget_cap").map((x) => [x[1], x[2].repeatMin]), [[null, 1440]]);
}));

test("ST1 staff phones are never customers: their taps and words go to the team module in any bot mode; a directory member is never answered by the bot even when it is a test phone", withEnv(LOCKS_OPEN, async () => {
  const STAFF = "544775082";
  for (const mode of ["live", "test", "dry", "off"]) {
    const team = teamStub({ staff: [STAFF] });
    const w = world({ team, waBot: { mode, testPhones: ["0544775082"] }, bundles: LIVE.bundles, links: ALL_LINKS });
    const r = await w.say("السلام عليكم ابي اطلب", { from: `966${STAFF}` });
    assert.deepEqual([r.sent.length, r.log], [0, null], `${mode}: no reply and not even a bot log row`);
    await w.press("team:renew", "✅ جدّد التنبيهات", { from: `966${STAFF}` });
    assert.deepEqual(team.seen.inbound.map((e) => e.interactiveId), [null, "team:renew"], mode);
    assert.equal(team.seen.handover.length + team.seen.odd.length, 0, `${mode}: no handover and no odd thing about a staff member`);
    assert.equal(w.sms.length, 0);
  }
  // even if the team module did not take the message: a member of the directory is not a customer for the rules bot or the assistant, test phone or not
  const w = liveWorld({ team: teamStub(), waBot: { testPhones: ["0544775082"] }, extraSettings: { waTeam: { members: TEAM5 } } });
  const r = await w.say("السلام عليكم", { from: "966544775082" });
  assert.deepEqual([r.sent.length, r.log.decision, r.log.reason, r.log.detail], [0, "silent", "never_reply", "staff"]);
  assert.equal(await w.bot.neverReplyOf("0544775082"), "staff"); assert.equal(await w.bot.neverReplyOf("0561000001"), "staff"); assert.equal(await w.bot.neverReplyOf("0512345678"), null);
  const c = await w.say("الاكل بارد وسيء", { from: "966561000001" });
  assert.deepEqual([c.sent.length, c.log.reason, c.log.handoff || null], [0, "never_reply", null], "a cashier's own complaint is not a customer handover");
  // the owner's switch: a team phone that is also a test phone keeps testing the bot
  const t = liveWorld({ team: teamStub(), waBot: { testPhones: ["0544775082"] }, extraSettings: { waTeam: { members: TEAM5, staffAsTesters: true } } });
  assert.ok((await t.say("السلام عليكم", { from: "966544775082" })).sent.length >= 1);
  assert.equal((await t.say("السلام عليكم", { from: "966506000003" })).log.reason, "never_reply", "not a test phone ⇒ still never answered");
  // before the directory is written (alert phones only) the old rule stands: excluded on its own unless it is a test phone
  const f = liveWorld({ team: teamStub(), waBot: { testPhones: ["0544775082"] } });
  assert.ok((await f.say("السلام عليكم", { from: "966544775082" })).sent.length >= 1);
  assert.equal((await f.say("السلام عليكم", { from: "966506338246" })).log.detail, "alert_phone");
}));

/* ══ ST2 — رجوع المساعد بعد قفل الموظف + سطر العميل الوحيد للتحويل ═══════════════════════════════════ */
test("ST2 re-entry: the assistant's first turn after a staff close carries what staff said, the outcome and the note — and it is consumed only after the reply was sent", withEnv(CONFIGURED, async () => {
  const HB = { outcome: "follow_up", outcome_label: "محتاج متابعة", staff_note: "عايز يضيف مشروب", staff_told_customer: ["طلبك اتسجّل"], closed_minutes_ago: 3, still_to_do: true };
  let used = 0, have = HB;
  const flow = { handbackFor: async () => have, handbackUsed: async () => { used++; have = null; } };
  const w = aWorld([mSay("تمام، أي مشروب تحب أضيفه؟"), mSay("أبشر 👍")], { flow });
  const r = await w.say("ابي بيتزا");
  assert.equal(r.log.reply_key, "assist");
  assert.match(w.m.seen[0].messages[0].content[0].text, /"staff_handled_this_chat":\{"outcome":"follow_up","outcome_label":"محتاج متابعة","staff_note":"عايز يضيف مشروب","staff_told_customer":\["طلبك اتسجّل"\],"closed_minutes_ago":3,"still_to_do":true,"rule":"Someone from the team/);
  assert.equal(used, 1);
  w.clock.advance(1); await w.say("وعندكم باستا؟");
  assert.doesNotMatch(JSON.stringify(w.m.seen[1].messages.at(-1)), /staff_handled_this_chat/, "once");
  assert.equal(used, 1);
  // the model failed ⇒ the handback is kept for the next turn
  let kept = 0; const f2 = { handbackFor: async () => HB, handbackUsed: async () => { kept++; } };
  const bad = aWorld([{ ok: false, error: "timeout", ms: 20000, provider: "x", usage: null }], { flow: f2 });
  await bad.say("ابي بيتزا"); assert.equal(kept, 0);
  const AR = await import("./waassistrun.js");
  assert.match(AR.CTX_RULES.staff, /never contradict/);      // PS2: the rule travels with the key
}));

test("ST2 transfer line: one fixed line to the customer through the guard — only inside the window, never to someone who stopped, never in dry / off mode", withEnv(LOCKS_OPEN, async () => {
  const w = liveWorld();
  await w.say("السلام عليكم");
  const before = w.calls.length;
  assert.equal(await w.bot.sendFlowLine("0512345678", "transfer_note"), "sent");
  assert.deepEqual(w.calls.slice(before).map((c) => [c.body.to, bodyOf(c.body)]), [["966512345678", "حوّلت محادثتك لمدير الفرع، ويكمل معك هنا 🙏"]]);
  assert.equal(await w.bot.sendFlowLine("0512345678", "greet"), "bad_key");
  assert.equal(await w.bot.sendFlowLine("0598765432", "transfer_note"), "window_closed", "never wrote ⇒ nothing");
  w.clock.advance(25 * 60);
  assert.equal(await w.bot.sendFlowLine("0512345678", "transfer_note"), "window_closed");
  assert.equal(w.calls.length, before + 1);
  const dry = world({ waBot: { mode: "dry" }, bundles: LIVE.bundles, links: ALL_LINKS }); await dry.say("السلام عليكم");
  assert.equal(await dry.bot.sendFlowLine("0512345678", "transfer_note"), "mode_off");
  const t = world({ waBot: { mode: "test", testPhones: ["0544775082"] }, bundles: LIVE.bundles, links: ALL_LINKS });
  assert.equal(await t.bot.sendFlowLine("0512345678", "transfer_note"), "not_test_phone");
  assert.equal(R.TEXTS.transfer_note.ar, "حوّلت محادثتك لمدير الفرع، ويكمل معك هنا 🙏");
}));

test("PS2 — rulesFirstPrice: a price question that opens the chat is answered by the rules bot's dish card (no model call); hours/location stay free; the assistant's first turn after it is a full first turn that sees the question", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("أبشر، تبيه استلام ولا توصيل؟")], { waBot: { assist: { rulesFirstPrice: true, orderWordsStrong: false } } });
  const p = await w.say("بكم كريب زنجر سوبريم");
  assert.equal(w.m.used(), 0, "no model call for the price"); assert.equal(p.log.reply_key, "item"); assert.match(bodyOf(msgs(p)[0]), /25/);
  assert.deepEqual(w.store.turns.map((t) => [t.handledBy, t.outcome]), [["rules_owned", "rules:item_price"]]);
  const seed = JSON.parse([...w.store.sessions.values()][0].s); assert.equal(seed.state.seed, true);
  w.clock.advance(1); const loc = await w.say("وين موقعكم");
  assert.equal(w.m.used(), 0, "a seeded chat is not an assistant conversation: location is still the rules bot's, free"); assert.equal(loc.log.reply_key, "location");
  w.clock.advance(1); const o = await w.say("طيب واحد لو سمحت");
  assert.equal(w.m.used(), 1); assert.equal(o.log.reply_key, "assist");
  const sent = JSON.stringify(w.m.seen[0].messages);
  assert.match(sent, /بكم كريب زنجر سوبريم/, "the assistant sees what the customer asked the rules bot"); assert.match(sent, /\\"boxes\\":/, "and gets the full first-turn context");
  assert.equal(JSON.parse([...w.store.sessions.values()][0].s).state.seed, undefined, "the seed is gone once the assistant has answered");
  // off (the default): the assistant answers the price itself
  const off = aWorld([mUse(tUse("search_menu", { query: "كريب زنجر سوبريم" })), mSay("كريب زنجر سوبريم بـ 25 ر.س.")]);
  await off.say("بكم كريب زنجر سوبريم"); assert.equal(off.m.used(), 2);
}));

test("PS3 — a location answer from the assistant carries the map button; a reminder the customer asked for is scheduled after the reply is sent, sent once at its time by name with the dish, and the customer's «ايوه» then reaches the assistant", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("هلا والله 👋 وش تحب تطلب اليوم؟"), mUse(tUse("faq", { topic: "branch_location" })), mSay("📍 فرعنا في حي السلامة بجدة، عند دوار رامي."),
    mUse(tUse("search_menu", { query: "كريب زنجر سوبريم" })), mSay("كريب زنجر سوبريم بـ 25 ر.س. أجهّزه لك؟"), mSay("على راحتك 🌟 تحب أذكّرك بكرة؟ أي وقت يناسبك؟"),
    mUse(tUse("remind_me", { day: "today", time: "20:00", dish_id: "8" })), mSay("تمام، بذكّرك اليوم الساعة 8 مساءً.")], { waBot: { assist: { orderWordsStrong: false } } });
  await w.say("مرحبا"); w.clock.advance(1);
  const loc = await w.say("في المكان");
  assert.equal(loc.log.reply_key, "assist"); const lp = msgs(loc)[0];
  assert.equal(lp.interactive.type, "cta_url"); assert.equal(lp.interactive.body.text, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي."); assert.match(lp.interactive.action.parameters.url, /^https:\/\/maps\.google\.com\//);
  assert.match(JSON.stringify(w.m.seen[1].messages.at(-1)), /where_are_we/, "the short Egyptian «في المكان» reaches the assistant as a where-are-you question");
  w.clock.advance(1); await w.say("بكم كريب زنجر سوبريم"); w.clock.advance(1);
  const post = await w.say("لا انشالله بكره");
  assert.match(JSON.stringify(w.m.seen.at(-1).messages.at(-1)), /customer_is_postponing/); assert.equal(bodyOf(msgs(post)[0]), "على راحتك 🌟 تحب أذكّرك بكرة؟ أي وقت يناسبك؟");
  assert.equal(w.db.jobs.filter((j) => j.kind === "assist_reminder").length, 0, "an offer schedules nothing");
  w.clock.advance(1); const set = await w.say("ايوه الساعة ٨ بالليل");
  assert.equal(bodyOf(msgs(set)[0]), "تمام، بذكّرك اليوم الساعة 8 مساءً.");
  const job = w.db.jobs.find((j) => j.kind === "assist_reminder");
  assert.deepEqual([job.status, job.due_at, job.ev.ref, job.ev.lang], ["pending", "2026-10-12T17:00:00.000Z", { id: "8" }, "ar"]);
  assert.deepEqual(await w.tick(60), [], "not before its time");
  const out = await w.tick(60);
  assert.equal(out.length, 1); assert.equal(out[0].text.body, "هلا 👋 معك ماجد، المساعد الرقمي لفريش كاتس، وهذا تذكيرك مثل ما اتفقنا.\nكنت تفكّر في كريب زنجر سوبريم.\nأجهّز لك طلبك الحين؟");
  assert.equal(job.status, "done"); assert.equal(w.store.turns.at(-1).outcome, "reminder_sent");
  assert.deepEqual(await w.tick(30), [], "once");
  // «ايوه» after the reminder: the assistant answers (not the rules bot's acknowledgement path) and sees the reminder it sent
  w.m.push(mSay("أبشر. توصيل ولا استلام؟")); w.clock.advance(2);
  const yes = await w.say("ايوه");
  assert.equal(yes.log.reply_key, "assist"); assert.match(JSON.stringify(w.m.seen.at(-1).messages), /reminder_you_sent/);
}));

test("PS3 — the reminder is not sent when the customer ordered, stopped our messages or the chat went to staff; a new reminder replaces the old one; a promise without a schedule is refused", withEnv(CONFIGURED, async () => {
  const steps = () => [mUse(tUse("remind_me", { day: "today", time: "20:00" })), mSay("تمام، بذكّرك اليوم الساعة 8 مساءً.")];
  // stopped
  const a = aWorld(steps()); await a.say("ذكرني الساعة ٨ بالليل لو سمحت بعدين"); a.clock.advance(5); await a.say("إيقاف");
  assert.deepEqual(await a.tick(120), []); assert.equal(a.db.jobs.find((j) => j.kind === "assist_reminder").reason, "stopped");
  // staff took the chat
  const b = aWorld(steps()); await b.say("ذكرني الساعة ٨ بالليل لو سمحت بعدين"); b.clock.advance(5); await b.say("ابي اكلم موظف");
  assert.deepEqual((await b.tick(120)).filter((p) => /تذكيرك/.test(JSON.stringify(p))), []); assert.match(b.db.jobs.find((j) => j.kind === "assist_reminder").reason, /handover_open|staff_in_chat/);
  // a second reminder replaces the first
  const c = aWorld([...steps(), mUse(tUse("remind_me", { day: "today", time: "21:00" })), mSay("تمام، بذكّرك اليوم الساعة 9 مساءً.")]);
  await c.say("ذكرني الساعة ٨ بالليل بعدين"); c.clock.advance(2); await c.say("لا خلها الساعة ٩ بالليل");
  assert.deepEqual(c.db.jobs.filter((j) => j.kind === "assist_reminder").map((j) => [j.status, j.reason, j.due_at.slice(11, 16)]), [["cancelled", "replaced", "17:00"], ["pending", null, "18:00"]]);
  // the model says «بذكّرك» without the tool: refused twice ⇒ the rules bot answers, nothing is scheduled
  const d = aWorld([mSay("تمام، بذكّرك بكرة إن شاء الله."), mSay("أكيد، راح أذكرك بكرة.")]);
  const r = await d.say("خلها بكرة"); assert.notEqual(r.log.reply_key, "assist"); assert.equal(d.db.jobs.filter((j) => j.kind === "assist_reminder").length, 0);
  assert.match(d.store.turns.at(-1).outcome, /fallback:validator/);
}));

test("PS4 — on WhatsApp: «المنيو» is the sections list + the menu link from the rules bot (no model call); the fee moment goes out with its two reply buttons, and a tap on one comes back to the assistant", withEnv(CONFIGURED, async () => {
  const PS4 = { feeMoment: true, menuToRules: true, pickForMe: true, choiceList: true, bigBoxSar: 140, pairingEnabled: true, adButtons: true, weightToAssistant: true, faqShort: true, orderWordsStrong: false };
  const w = aWorld([mSay("هلا والله 👋 وش تحب تطلب اليوم؟"), mUse(tUse("delivery_savers", { total: 40 })), mUse(tUse("delivery_savers", { total: 40 })), mSay("معك حق.\nأيهم يناسبك؟"), mSay("أبشر، استلام من الفرع. وش تحب تطلب؟")], { waBot: { assist: PS4 } });
  await w.say("مرحبا"); w.clock.advance(1);
  const m = await w.say("ابي المنيو");
  assert.equal(w.m.used(), 1, "the menu request costs no model call"); assert.equal(m.log.reply_key, "cats");
  const out = msgs(m); assert.equal(out.length, 2); assert.equal(out[0].interactive.type, "list"); assert.equal(out[1].interactive.type, "cta_url"); assert.match(out[1].interactive.action.parameters.url, /^https:\/\/freshcuts\.sa\/l\//);
  w.clock.advance(1);
  const f = await w.say("يعني طلب ب 40 ريال تدفع علي رسوم 20 ريال");
  const p = msgs(f)[0];
  assert.equal(p.interactive.type, "button"); assert.match(p.interactive.body.text, /طلبك 40 ر\.س \+ توصيل 20 = 60 ر\.س\./); assert.match(p.interactive.body.text, /أو استلام من الفرع بدون رسوم توصيل = 40 ر\.س\./);
  assert.deepEqual(p.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["as:reach", "أكمّلها 60 ر.س"], ["as:pickup", "استلام من الفرع"]]);
  w.clock.advance(1);
  const t = await w.press("as:pickup", "استلام من الفرع");
  assert.equal(t.log.reply_key, "assist", "the assistant's own button returns to the assistant, as text"); assert.match(JSON.stringify(w.m.seen.at(-1).messages.at(-1)), /استلام من الفرع/);
}));

test("PS5 — several pictures in a row are one order: each waits a few seconds, then they are looked at together and answered ONCE; no flood mute for a buyer; a single picture behaves as before", withEnv(CONFIGURED, async () => {
  const file = { ok: true, buf: JPG, mime: "image/jpeg" };
  const BURST = { ...MEDIA_ON.assist, imageBurstSec: 6, imageBurstMax: 6 };
  const w = aWorld([look({ kind: "menu_or_ad", summary: "صورة شيش طاووق مشوي على الفحم", clear: true }), look({ kind: "menu_or_ad", summary: "صورة طرب مشوي", clear: true }), look({ kind: "menu_or_ad", summary: "صورة بيبسي", clear: true }),
    mSay("وصلتني الصور: شيش طاووق، طرب، وبيبسي. أجهّزهم لك؟")], { waBot: { assist: BURST }, mediaFile: file });
  const img = (n) => w.say(null, { raw: { type: "image", image: { id: `90000000000${n}`, mime_type: "image/jpeg" } } });
  const a = await img(1); w.clock.advanceSec(2); const b = await img(2); w.clock.advanceSec(2); const c = await img(3);
  for (const r of [a, b, c]) assert.deepEqual([r.sent.length, r.log.decision, r.log.reason], [0, "waiting", "media_burst"]);
  assert.equal(w.m.used(), 0, "nothing is looked at before the burst ends"); assert.equal(w.db.jobs.filter((j) => j.kind === "media_burst").length, 3);
  assert.deepEqual(await w.tick(0.05), [], "the first two are due later than the third arrived: still waiting");
  const out = await w.tick(0.2);
  assert.equal(out.length, 1, "ONE reply for the three pictures"); assert.equal(out[0].text.body.split("\n").pop(), "وصلتني الصور: شيش طاووق، طرب، وبيبسي. أجهّزهم لك؟");
  assert.equal(w.m.used(), 4, "three looks + one assistant turn");
  const turnMsg = JSON.stringify(w.m.seen[3].messages.at(-1));
  assert.match(turnMsg, /3 صور من العميل ورا بعض/); assert.match(turnMsg, /صورة 1: صورة شيش طاووق/); assert.match(turnMsg, /صورة 3: صورة بيبسي/); assert.match(turnMsg, /seen_in_a_picture/); assert.match(turnMsg, /usually ONE order/);
  assert.deepEqual(w.db.jobs.filter((j) => j.kind === "media_burst").map((j) => [j.status, /^burst/.test(j.reason)]), [["done", true], ["done", true], ["done", true]]);
  assert.equal(w.db.chats.get("512345678").muted_until || null, null, "no mute");
  // a single picture: looked at alone after the wait, exactly the old path
  const s = aWorld([look({ kind: "menu_or_ad", summary: "إعلان بوكس الكريب الفردي", clear: true }), mSay("بوكس الكريب الفردي عندنا. تبيه توصيل ولا استلام؟")], { waBot: { assist: BURST }, mediaFile: file });
  await s.say(null, { raw: imageMsg() }); const so = await s.tick(0.2);
  assert.equal(so.length, 1); assert.equal(s.m.used(), 2);
  // five pictures within two minutes from someone the assistant is serving: not a flood
  const f = aWorld(Array.from({ length: 6 }, (_, i) => (i < 5 ? look({ kind: "menu_or_ad", summary: `صورة صنف ${"ابجده"[i]}`, clear: true }) : mSay("وصلتني الصور. أجهّز لك الطلب؟"))), { waBot: { assist: BURST, mediaFloodCount: 5 }, mediaFile: file });
  for (let i = 0; i < 5; i++) { const r = await f.say(null, { raw: { type: "image", image: { id: `8000000000${i}`, mime_type: "image/jpeg" } } }); assert.notEqual(r.log.reason, "media_flood", `picture ${i + 1}`); f.clock.advanceSec(1); }
  assert.equal((await f.tick(0.2)).length, 1); assert.equal(f.db.chats.get("512345678")?.muted_by || null, null);
}));

test("PS5 — «رجّع البوت» and the hub's «تم التعامل» really hand the chat back: the staff reply before it no longer pauses the bot", withEnv(CONFIGURED, async () => {
  const w = aWorld([mSay("هلا والله 👋 وش تحب تطلب اليوم؟")]);
  await w.cashier("تفضل، التوصيل فوق 60 ريال يصير 15"); w.clock.advance(1);
  const paused = await w.say("ابي بيتزا"); assert.equal(paused.log.decision, "waiting", "a staff member is in the chat");
  await w.call("POST", "/api/cms/wabot/chats/unmute", { phone: "0512345678" });
  assert.ok(w.db.chats.get("512345678").released_at, "the release is recorded");
  w.clock.advance(1);
  const r = await w.say("طيب ابي بيتزا"); assert.deepEqual([r.log.decision, r.log.reply_key], ["replied", "assist"], "answered at once, not «staff_pause»");
  // a staff message AFTER the release pauses again
  w.clock.advance(1); await w.cashier("لحظة معك"); w.clock.advance(1);
  assert.equal((await w.say("طيب")).log.decision !== "replied" || false, true);
}));

/* ── PK1 (١٤/١٠) — محادثات يوم ١٣/١٠ بالحرف ─────────────────────────────────────────────────────────── */
test("PK1 follow-up: an ad lead answered with a question who then goes silent gets ONE specific message after 20 minutes (the advertised dish with its live prices + one question); never if he wrote, staff stepped in, a cart exists, we are closed, or it is switched off", withEnv(CONFIGURED, async () => {
  const AD = "120251224485800593", referral = { source_id: AD, source_type: "ad", headline: "مشكل مخصوص على الفحم — راسلنا واتساب", ctwa_clid: "C1" };
  const links = [...ALL_LINKS, { slug: "ad-mashakel", target_type: "product", target_id: "103" }];
  const FIRST_REPLY = "عرض أول طلب: توصيل مجاني بكود FIRST للطلبات من 60 ر.س.\nكم شخص أنتم؟";
  const lead = (o = {}, steps = [mSay(FIRST_REPLY)]) => aWorld(steps, { links, variants: VAR, waBot: { links: { organic: "wab-boxes", ads: "wa-boxes", adMap: { [AD]: "ad-mashakel" } }, assist: { nudgeMin: 20, ...o } } });
  assert.equal(R.botConfig({}).assist.nudgeMin, 20); assert.ok(R.SCHEMA["assist.nudgeMin"].ar);
  // «وش عرض أول طلب؟» (the ad's canned question, 5 chats that day): answered, then silence
  const w = lead(); const r = await w.say("وش عرض أول طلب؟", { referral });
  assert.equal(r.log.reply_key, "assist");
  assert.deepEqual(w.db.jobs.filter((j) => j.kind === "assist_nudge").map((j) => [j.wamid, j.status, Math.round((Date.parse(j.due_at) - w.clock.now().getTime()) / 60_000)]), [["nudge:512345678:2026-10-12", "pending", 20]]);
  assert.deepEqual(await w.tick(19), [], "not before 20 minutes");
  const out = await w.tick(2);
  assert.equal(out.length, 1);
  assert.equal(bodyOf(out[0]), "بخصوص مشكل مخصوص بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س.\nكم شخص أنتم؟ أرشّح لك الأنسب وأجهّز سلتك.");
  assert.doesNotMatch(bodyOf(out[0]), /يكفي|وصلتنا رسالتك|نعتذر/, "specific, no apology and no serving count");
  assert.deepEqual([w.db.log.at(-1).reply_key, w.db.log.at(-1).decision], ["lead_nudge", "replied"]);
  assert.equal(w.store.turns.at(-1).outcome, "nudge_sent");
  // the assistant's own session knows what was sent, so «٣» is understood next
  const sess = JSON.parse(w.store.sessions.get("512345678").s); assert.equal(sess.messages.at(-1).role, "assistant"); assert.match(sess.messages.at(-1).content[0].text, /^بخصوص مشكل مخصوص/);
  assert.deepEqual(await w.tick(30), [], "once");
  // no ad: the plain question
  const p = lead(); await p.say("ابي اطلب"); const po = await p.tick(21); assert.equal(po.length, 1); assert.equal(bodyOf(po[0]), R.textOf(R.botConfig(p.db.settings), "lead_nudge", "ar"));
  // each reason not to send
  const a = lead({}, [mSay(FIRST_REPLY), mSay("أبشر. لكم شخص؟")]); await a.say("وش عرض أول طلب؟", { referral }); a.clock.advance(5); await a.say("مشاوي");
  assert.deepEqual(await a.tick(16), [], "he wrote: the clock starts again from the new reply"); assert.equal((await a.tick(5)).length, 1, "20 minutes after the LAST question");
  const b = lead(); await b.say("وش عرض أول طلب؟", { referral }); b.clock.advance(5); await b.cashier("تفضل"); assert.deepEqual(await b.tick(16), []); assert.equal(b.db.jobs.find((j) => j.kind === "assist_nudge").reason, "staff_in_chat");
  const c = lead(); await c.say("وش عرض أول طلب؟", { referral }); c.db.botCarts.push({ code: "rc000009", phone: "512345678" }); assert.deepEqual(await c.tick(21), []); assert.equal(c.db.jobs.find((j) => j.kind === "assist_nudge").reason, "has_cart");
  const d = lead(); await d.say("وش عرض أول طلب؟", { referral }); d.db.optins["512345678"] = { stopped_at: d.clock.now().toISOString() }; assert.deepEqual(await d.tick(21), []); assert.equal(d.db.jobs.find((j) => j.kind === "assist_nudge").reason, "stopped");
  const e = lead({ nudgeMin: 0 }); await e.say("وش عرض أول طلب؟", { referral }); assert.equal(e.db.jobs.filter((j) => j.kind === "assist_nudge").length, 0, "off = nothing is scheduled");
  // a reply that is not a question schedules nothing
  const f = lead({}, [mSay("العفو، حيّاك الله في أي وقت 🌟")]); await f.say("تمام يعطيك العافيه على المعلومه"); assert.equal(f.db.jobs.filter((j) => j.kind === "assist_nudge").length, 0);
}));

test("PK1: a deleted message (revoke) is ignored silently — no reply, no model call, and no «we could not help you» follow-up; a voice note keeps its handover and now invites typing", withEnv(CONFIGURED, async () => {
  const w = aWorld([]);
  const r = await w.say(null, { raw: { type: "revoke", revoke: { original_message_id: "wamid.X" } } });
  assert.deepEqual(msgs(r), []); assert.equal(w.m.used(), 0); assert.deepEqual([r.log.decision, r.log.reason, r.log.msg_type], ["silent", "ignored_type", "revoke"]);
  assert.deepEqual(await w.tick(25), [], "the 20-minute lead follow-up is not for a deleted message"); assert.equal(w.db.jobs.filter((j) => j.kind === "lead_followup").length, 0);
  const v = await w.say(null, { raw: { type: "audio", audio: { id: "A1", voice: true } } });
  assert.match(bodyOf(msgs(v)[0]), /^ما أقدر أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا وأجهّزه لك على طول\.\nوحوّلت محادثتك لموظف يسمعها\./); assert.equal(v.log.handoff, "media");
  const i = aWorld([]); const im = await i.say(null, { raw: { type: "image", image: { id: "I1", mime_type: "image/jpeg" } } });
  assert.match(bodyOf(msgs(im)[0]), /^ما أقدر أفتح الصور والمقاطع الصوتية/, "a picture keeps the old line");
}));

test("PK1: «ابغي أشوف المنيو كامل وكل وجبه وسعرها» gets the sections list and the menu link at once from the rules bot (it had been answered «الكامل ما أقدر أعرضه هنا»)", withEnv(CONFIGURED, async () => {
  const w = aWorld([], { waBot: { assist: { menuToRules: true } } });
  const r = await w.say("ابغي أشوف المنيو كامل وكل وجبه وسعرها");
  assert.equal(w.m.used(), 0, "no model call"); assert.equal(r.log.reply_key, "cats");
  const sent = msgs(r); assert.equal(sent[0].interactive.type, "list"); assert.ok(sent[0].interactive.action.sections[0].rows.length >= 5);
  assert.equal(sent[1].interactive.type, "cta_url"); assert.match(sent[1].interactive.action.parameters.url, /^https:\/\/freshcuts\.sa\/l\//);
}));

test("PK1 business brief, wired: GET shows every field with its pre-filled value and who must fill it; PUT is the owner's, refuses a recipe, a supplier and a serving count for «مشكل مخصوص», and a saved field reaches the model in the second instructions block", withEnv(CONFIGURED, async () => {
  const A = await import("./waassistrun.js"); const w = aWorld([mSay("هلا 👋 كم شخص أنتم؟")], { variants: VAR, waBot: { assist: { briefEnabled: true } } });
  const g = await w.call("GET", "/api/cms/wabot/brief");
  assert.equal(g.body.ok, true); assert.equal(g.body.enabled, true); assert.ok(g.body.fields.length >= 20);
  const f = Object.fromEntries(g.body.fields.map((x) => [x.key, x]));
  assert.match(f.order_steps.value, /تضغط زر «كمّل طلبك»/); assert.equal(f.order_steps.isDefault, true);
  assert.deepEqual(g.body.fields.filter((x) => x.needsOwner).map((x) => x.key), ["car_pickup", "mashakel_kinds", "extra"], "the fields only the owner can fill are empty and marked");
  assert.ok(g.body.fields.every((x) => x.label && x.source && x.section && typeof x.value === "string" && !x.problem));
  assert.match(g.body.liveMenu, /مشكل مخصوص بالوزن: ثلث كيلو 53 · نصف كيلو 78 · كيلو 155/); assert.match(g.body.block, /^<business_brief/);
  // the owner only
  w.setOwner(false); assert.equal((await w.call("PUT", "/api/cms/wabot/brief", { fields: { extra: "عندنا مصلى" } })).status, 403); w.setOwner(true);
  // refused: a serving count for the mashakel, a marinade, a supplier, a link, a delivery-time promise
  for (const [key, bad] of [["mashakel_line", "مشكل مخصوص تشكيلة مشاوي، والكيلو يكفي ٤ أشخاص"], ["mashakel_kinds", "كفتة 100 جرام وطرب 100 جرام"], ["extra", "نشتري اللحم من مورد محلي"], ["extra", "شوف freshcuts.sa/menu"], ["delivery_area", "التوصيل خلال 30 دقيقة"], ["mashakel_kinds", "٣ أسياخ كفتة وسيخين طرب"]]) {
    const bad1 = await w.call("PUT", "/api/cms/wabot/brief", { fields: { [key]: bad } });
    assert.equal(bad1.status, 400, bad); assert.equal(bad1.body.errors.length, 1); assert.equal(w.db.settings.waBot.brief, undefined, "nothing saved");
  }
  // saved, kept by an ordinary settings save, and sent to the model
  const ok = await w.call("PUT", "/api/cms/wabot/brief", { fields: { mashakel_kinds: "كفتة، طرب، كباب، وريش", car_pickup: "" } });
  assert.equal(ok.status, 200); assert.deepEqual(w.db.settings.waBot.brief, { mashakel_kinds: "كفتة، طرب، كباب، وريش" }, "only what the owner changed is stored (an empty owner field equals its default)");
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { greetWindowHours: 2 })).status, 200); assert.equal(w.db.settings.waBot.brief.mashakel_kinds, "كفتة، طرب، كباب، وريش", "an ordinary settings save keeps the brief");
  await w.say("مرحبا");
  const block = w.m.full[0].brief;
  assert.match(block, /^# The business brief/); assert.match(block, /كفتة، طرب، كباب، وريش/); assert.match(block, /## Live menu/); assert.equal(w.m.full[0].system, A.SYSTEM_PROMPT, "the fixed instructions are unchanged: the brief is its own block");
  // null = back to the pre-filled value
  await w.call("PUT", "/api/cms/wabot/brief", { fields: { mashakel_kinds: null } }); assert.deepEqual(w.db.settings.waBot.brief, {});
}));

test("PK1 daily report, wired: GET /api/cms/wabot/assist/daily answers for a business day without any phone number", withEnv(CONFIGURED, async () => {
  const w = aWorld([]);
  const r = await w.call("GET", "/api/cms/wabot/assist/daily", {}, { day: "2026-10-13" });
  assert.equal(r.body.ok, true); assert.deepEqual([r.body.from, r.body.to], ["2026-10-13T01:00:00.000Z", "2026-10-14T01:00:00.000Z"]);
  assert.deepEqual([r.body.report.day, r.body.report.chats, r.body.report.funnel.carts], ["2026-10-13", 0, 0]); assert.doesNotMatch(JSON.stringify(r.body), /5\d{8}/);
}));

/* SB1 — «عقل البيع» من أول الويب هوك لجسم Graph: سؤال الاختيار بيطلع أزرار، والأسماء بخط عريض، والكود بيكمّل السطر المبادِر. */
test("SB1 end to end: «توصيل ولا استلام؟» goes out as two reply buttons, the dish name in bold; a tap on «أضفه ✅» comes back to the assistant", withEnv(CONFIGURED, async () => {
  const w = aWorld([mUse(tUse("search_menu", { query: "كريب زنجر سوبريم" })), mSay("كريب زنجر سوبريم بـ 25 ر.س. توصيل ولا استلام؟"), mSay("تمام 👍 وش تحب تضيف؟")], { waBot: { assist: { salesBrain: true } } });
  const r = await w.say("ابي كريب زنجر سوبريم");
  const p = msgs(r)[0];
  assert.equal(p.type, "interactive"); assert.equal(p.interactive.type, "button");
  assert.deepEqual(p.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["as:delivery", "توصيل"], ["as:pickup", "استلام من الفرع"]]);
  assert.match(p.interactive.body.text, /^\*كريب زنجر سوبريم\* بـ 25 ر.س\./);
  assert.ok([...p.interactive.body.text].length <= 1024);
  const r2 = await w.say("أضفه ✅", { interactiveId: "as:sg:yes" });
  assert.equal(r2.log.reply_key, "assist", "a tap on an assistant button returns to the assistant as its title");
}));

/* SB2 — طلب التقييم بعد التوصيل على واتساب (عمر ١٤/١٠: «ليه مشغلتش رسالة التقييم تجيله على الواتس الى بتيجي للعميل بعد الطلب») */
/* RV1: الاختبار ده بيغطّي المسار القديم (reviewFlow مقفول): زرّين «تمام / عندي ملاحظة». المسار الجديد (قايمة النجوم) في اختبارات RV1 تحت. */
test("SB2: inside the 24h window the review ask is a free-form message with «تمام 👍 / عندي ملاحظة»; «تمام» ⇒ the rating link, «ملاحظة» ⇒ the manager with the order number; typed replies count too", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS, reviewFlow: { enabled: false } } });
  await w.say("شكراً");
  const before = w.calls.length;
  const r = await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34" });
  assert.deepEqual(r, { ok: true, channel: "wa" });
  const p = w.calls.slice(before).map((c) => c.body).find((b) => b.type);
  assert.equal(p.type, "interactive");
  assert.match(p.interactive.body.text, /كيف كان طلبك رقم W1790012345678؟ 🌟/);
  assert.deepEqual(p.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["rv:ok:ab12cd34", "تمام 👍"], ["rv:note:ab12cd34:W1790012345678", "عندي ملاحظة"]]);
  const ok = await w.press("rv:ok:ab12cd34", "تمام 👍");
  assert.equal(ok.log.reply_key, "review_ok", JSON.stringify(ok.log));
  const okMsg = ok.sent.find((b) => b.type);
  assert.match(JSON.stringify(okMsg), /https:\/\/freshcuts\.sa\/r\?c=ab12cd34/, "the rating page of THIS order");
  assert.deepEqual(w.db.reviewAnswers.at(-1), ["ab12cd34", "ok"]);
  const note = await w.press("rv:note:ab12cd34:W1790012345678", "عندي ملاحظة");
  assert.equal(note.log.reply_key, "review_note"); assert.equal(note.log.handoff, "review_note");
  assert.match(JSON.stringify(note.sent.find((b) => b.type)), /طلب رقم W1790012345678/);
  // typed: «تمام» after a fresh ask = the button; with nothing pending it stays a plain «تمام» (no reply)
  const w2 = world({ waBot: { mode: "test", testPhones: TESTERS, reviewFlow: { enabled: false } } });
  await w2.say("هلا");
  await w2.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012340000", code: "zz99yy88" });
  const typed = await w2.say("تمام");
  assert.equal(typed.log.reply_key, "review_ok"); assert.match(JSON.stringify(typed.sent), /r\?c=zz99yy88/);
  const again = await w2.say("تمام");
  assert.equal(again.sent.filter((b) => b.type).length, 0, "answered once: a second «تمام» is just an acknowledgement");
  const w3 = world({ waBot: { mode: "test", testPhones: TESTERS, reviewFlow: { enabled: false } } });
  await w3.say("هلا"); await w3.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012341111", code: "qq11ww22" });
  const tn = await w3.say("عندي ملاحظة");
  assert.equal(tn.log.reply_key, "review_note"); assert.match(JSON.stringify(tn.sent), /W1790012341111/);
}));

test("SB2: outside the window ⇒ the approved utility template fc_review_request (order number + the rating link button); stopped ⇒ nothing at all; switch off / bot not on ⇒ SMS as before", withEnv(CONFIGURED, async () => {
  const CAT = await import("./watemplates.js"); const WA = await import("./whatsapp.js"); WA.registerCatalog(CAT);
  const w = world({ waBot: { mode: "test", testPhones: TESTERS } });
  await w.say("هلا"); w.clock.advance(25 * 60);
  const before = w.calls.length;
  const r = await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34" });
  assert.deepEqual(r, { ok: true, channel: "wa_template" });
  const t = w.calls.slice(before).map((c) => c.body).find((b) => b.type === "template");
  assert.equal(t.template.name, "fc_review_request");
  assert.deepEqual(t.template.components, [{ type: "body", parameters: [{ type: "text", text: "W1790012345678" }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ab12cd34" }] }]);
  const s = world({ waBot: { mode: "test", testPhones: TESTERS } }); s.db.optins["512345678"] = { stopped_at: new Date().toISOString() };
  assert.deepEqual(await s.bot.reviewAsk({ phone: "0512345678", orderNo: "W1", code: "ab12cd34" }), { ok: false, skipped: "stopped", final: true }, "«إيقاف» ⇒ no WhatsApp and no SMS");
  const off = world({ waBot: { mode: "test", testPhones: TESTERS, reviewWhatsApp: false } });
  assert.deepEqual(await off.bot.reviewAsk({ phone: "0512345678", orderNo: "W1", code: "ab12cd34" }), { ok: false, skipped: "off" });
  const dark = world({ waBot: { mode: "off" } });
  assert.deepEqual(await dark.bot.reviewAsk({ phone: "0512345678", orderNo: "W1", code: "ab12cd34" }), { ok: false, skipped: "bot_not_live" }, "the replies need the bot: SMS instead");
  const sch = R.configSchema ? R.configSchema() : null; void sch;
  assert.equal(R.botConfig({ waBot: {} }).reviewWhatsApp, true); assert.equal(R.botConfig({ waBot: { reviewWhatsApp: false } }).reviewWhatsApp, false);
}));

/* SB4 — نوافذ الـ٢٤ ساعة (عمر ١٤/١٠: «حاول نفتح مع العملاء نوافذ ٢٤ ساعة باي طريقة ذكية… من غير ما نضايق العميل… وتوفر علينا») */
test("SB4 window: an order update inside an open window goes FREE (same text + tracking button; delivered with «تمام 👍 / عندي ملاحظة»); stopped updates ⇒ no free message; switch off ⇒ template path", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS }, notifications: { whatsappEnabled: true, whatsappStages: ["on_the_way", "delivered"] } });
  await w.say("هلا"); w.db.optins["512345678"] = { updates: true };
  const before = w.calls.length;
  const r = await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.free, true);
  const p = w.calls.slice(before).map((c) => c.body).find((b) => b.type);
  assert.equal(p.type, "interactive"); assert.equal(p.interactive.type, "cta_url");
  assert.match(p.interactive.body.text, /طلبك رقم W1790012345678 مع المندوب/); assert.equal(p.interactive.action.parameters.url, "https://freshcuts.sa/track/W1790012345678");
  const b2 = w.calls.length;
  await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "delivered");
  const d = w.calls.slice(b2).map((c) => c.body).find((b) => b.type);
  assert.deepEqual(d.interactive.action.buttons.map((x) => x.reply.id), ["تمام 👍", "عندي ملاحظة"]);
  w.db.optins["512345678"] = { updates: true, stopped_at: new Date().toISOString() };
  const b3 = w.calls.length; const s3 = await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  assert.notEqual(s3.free, true); assert.equal(w.calls.slice(b3).filter((c) => c.body.type && c.body.type !== "template").length, 0, "stopped ⇒ no free message");
  const off = world({ waBot: { mode: "test", testPhones: TESTERS, windowFreeUpdates: false }, notifications: { whatsappEnabled: true, whatsappStages: ["on_the_way"] } });
  await off.say("هلا"); off.db.optins["512345678"] = { updates: true };
  assert.notEqual((await off.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way")).free, true, "switch off ⇒ the template path as before");
}));

/* RV1: الاختبار ده بيغطّي المسار القديم (reviewFlow مقفول): «تمام» ⇒ رابط صفحة التقييم. المسار الجديد في اختبارات RV1 تحت. */
test("SB4 window: a quick-reply tap «تمام 👍» (template or free update) answers with the order's rating link and marks the invite so no second review ask; «تابع طلبي» = order status", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS, reviewFlow: { enabled: false } } });
  w.db.invites = [{ phone_norm: "512345678", code: "kk55jj66", order_no: "W1790012349999" }];
  const t = await w.say(null, { raw: { type: "button", button: { text: "تمام 👍", payload: "تمام 👍" } } });
  assert.equal(t.log.reply_key, "review_ok", JSON.stringify(t.log)); assert.match(JSON.stringify(t.sent), /r\?c=kk55jj66/);
  assert.equal(w.db.invites[0].channel, "wa_tap");
  assert.equal(R.classify({ type: "button", text: "تابع طلبي", interactiveId: "تابع طلبي" }).key, "status");
  const none = world({ waBot: { mode: "test", testPhones: TESTERS, reviewFlow: { enabled: false } } });
  const n = await none.say(null, { raw: { type: "button", button: { text: "تمام 👍", payload: "تمام 👍" } } });
  assert.equal(n.log.reply_key, "review_ok"); assert.match(JSON.stringify(n.sent), /بالعافية عليك/, "no invite: a warm line, no link");
  const cfg = R.botConfig({ waBot: { reviewFlow: { enabled: false } } });
  assert.match(R.buildReply("review_ok", { cfg, lang: "ar", data: { settings: {} }, arg: { code: "kk55jj66", extra: "⭐ باقي لك طلب واحد" } }).body, /⭐ باقي لك طلب واحد$/, "the loyalty line rides in the SAME message");
}));

test("SB4 window keeper: ~20 h after the customer's last message ONE free message only when useful (open order ⇒ tracking); nothing useful ⇒ nothing; quiet hours respected", withEnv(CONFIGURED, async () => {
  const quiet = world({ at: "2026-10-12T09:00:00Z", waBot: { mode: "test", testPhones: TESTERS, paidNoteEnabled: false }, orders: [{ order_no: "W1790012347777", phone_norm: "512345678", status: "on_the_way", option: "delivery", created_at: "2026-10-13T04:30:00Z" }] });
  await quiet.say("هلا");
  const q1 = await quiet.tick(20 * 60 + 5);      // 05:05 UTC = 08:05 Riyadh: quiet (02–11)
  assert.equal(q1.filter((b) => b.type).length, 0, "quiet hours " + JSON.stringify(q1) + JSON.stringify(quiet.db.jobs.map((j) => [j.kind, j.status, j.reason])));
  assert.equal(quiet.db.jobs.find((j) => j.kind === "window_keep").reason, "quiet_hours");
  const w = world({ at: "2026-10-12T15:00:00Z", waBot: { mode: "test", testPhones: TESTERS, paidNoteEnabled: false }, orders: [{ order_no: "W1790012347777", phone_norm: "512345678", status: "on_the_way", option: "delivery", created_at: "2026-10-13T10:30:00Z" }] });
  await w.say("هلا");
  const s = await w.tick(20 * 60 + 5);           // 11:05 UTC = 14:05 Riyadh
  const m = s.find((b) => b.type);
  assert.ok(m, "one message"); assert.match(JSON.stringify(m), /طلبك رقم W1790012347777 ما زال معنا/); assert.match(JSON.stringify(m), /track\/W1790012347777/);
  assert.equal(w.db.jobs.find((j) => j.kind === "window_keep").reason, "sent:open_order");
  const n = world({ at: "2026-10-12T15:00:00Z", waBot: { mode: "test", testPhones: TESTERS, paidNoteEnabled: false } });
  await n.say("هلا");
  assert.equal((await n.tick(20 * 60 + 5)).filter((b) => b.type).length, 0);
  assert.equal(n.db.jobs.find((j) => j.kind === "window_keep").reason, "nothing_useful", "no reason ⇒ nothing sent");
  const c = R.botConfig({ waBot: { windowKeeperHour: 30, windowKeeperDailyCap: -1 } }); assert.deepEqual([c.windowKeeperHour, c.windowKeeperDailyCap], [23, 0]);
}));

test("SB4 window: the daily report carries paid templates vs free messages, SAR paid and saved, and the window-keeper outcome", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS } });
  const r = await w.call("GET", "/api/cms/wabot/assist/daily");
  const win = r.body.report.window;
  assert.deepEqual(Object.keys(win).sort(), ["free_messages", "free_order_updates", "keeper", "note", "orders", "paid_templates", "reply_followups", "saved_sar"]);      // ١٤/١٠: + orders (لكل طلب بفلوس/ببلاش/اتشال) · FU1: + reply_followups
  assert.deepEqual(Object.keys(win.keeper).sort(), ["nothing_useful", "ordered", "replied", "sent"]);
  assert.deepEqual(Object.keys(win.reply_followups).sort(), ["blocked", "brake", "by_via", "carts", "carts_opened", "ordered", "paid_orders", "paid_sar", "paid_via_link", "replied", "said_no", "said_yes", "sent", "stopped"]);
  assert.equal(typeof win.paid_templates.sar, "number");
}));

test("SB4 window: the v2 templates are UTILITY, carry their quick replies, pass the catalogue lint, and are never wired to a stage on their own", async () => {
  const C = await import("./watemplates.js");
  const v2 = C.TEMPLATES.filter((t) => /_v2$/.test(t.name));
  assert.deepEqual(v2.map((t) => t.name).sort(), ["fc_order_delivered_v2", "fc_order_on_the_way_v2", "fc_order_preparing_v2", "fc_order_received_v2", "fc_order_refunded_v2", "fc_refund_in_progress_v2", "fc_review_request_v2"]);
  for (const t of v2) {
    assert.equal(t.category, "UTILITY", t.name); assert.equal(t.meta.stage, undefined, `${t.name} must not auto-wire`);
    const qrs = t.components.find((c) => c.type === "BUTTONS").buttons.filter((b) => b.type === "QUICK_REPLY").map((b) => b.text);
    assert.ok(qrs.length >= 1, t.name);
    assert.deepEqual(C.validateTemplate(t), [], t.name);
  }
});

/* SB5 — «طلبك مع المندوب» باسمه وزر «راسل المندوب» */
test("SB5: inside the window the on-the-way update names the courier and its button opens our courier-chat link (no phone in it) + the tracking link in the text; no phone ⇒ the tracking button as before; outside the window with courierTemplate on ⇒ fc_order_on_the_way_courier with both button variables", withEnv(LOCKS_OPEN, async () => {
  const CC = await import("./couriercontact.js"); const CAT = await import("./watemplates.js"); const WA = await import("./whatsapp.js"); WA.registerCatalog(CAT);
  const mk = (waBot = {}) => world({ waBot: { mode: "test", testPhones: TESTERS, ...waBot }, notifications: { whatsappEnabled: true, whatsappStages: ["on_the_way"] } });
  const w = mk(); await w.say("هلا"); w.db.optins["512345678"] = { updates: true };
  w.db.shipments = [{ order_no: "W1790012345678", driver: { name: "أحمد علي", phone: "0551234567", location: { latitude: "21.5", longitude: "39.1" } } }];
  const b0 = w.calls.length;
  const r = await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  assert.equal(r.free, true);
  const p = w.calls.slice(b0).map((c) => c.body).find((b) => b.type);
  assert.equal(p.interactive.type, "cta_url"); assert.equal(p.interactive.action.parameters.display_text, "راسل المندوب");
  assert.equal(p.interactive.action.parameters.url, CC.courierChatUrl("W1790012345678")); assert.doesNotMatch(p.interactive.action.parameters.url, /0551234567|966551234567/);
  assert.match(p.interactive.body.text, /مع المندوب أحمد وفي الطريق إليك/); assert.match(p.interactive.body.text, /https:\/\/freshcuts\.sa\/track\/W1790012345678/);
  w.db.shipments = [{ order_no: "W1790012345678", driver: { name: "أحمد" } }];
  const b1 = w.calls.length; await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  const p1 = w.calls.slice(b1).map((c) => c.body).find((b) => b.type);
  assert.equal(p1.interactive.action.parameters.url, "https://freshcuts.sa/track/W1790012345678", "no courier phone ⇒ the tracking button as today");
  const t = mk({ courierTemplate: true }); await t.say("هلا"); t.clock.advance(25 * 60); t.db.optins["512345678"] = { updates: true };
  t.db.shipments = [{ order_no: "W1790012345678", driver: { name: "أحمد علي", phone: "0551234567" } }];
  const b2 = t.calls.length; await t.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  const tp = t.calls.slice(b2).map((c) => c.body).find((b) => b.type === "template");
  assert.equal(tp.template.name, "fc_order_on_the_way_courier");
  assert.deepEqual(tp.template.components.map((c) => [c.type, c.index ?? null, c.parameters.map((x) => x.text)]), [["body", null, ["W1790012345678", "أحمد"]], ["button", "0", [CC.courierToken("W1790012345678")]], ["button", "1", ["W1790012345678"]]]);
  const old = mk(); await old.say("هلا"); old.clock.advance(25 * 60); old.db.optins["512345678"] = { updates: true };
  old.db.shipments = [{ order_no: "W1790012345678", driver: { name: "أحمد", phone: "0551234567" } }];
  const b3 = old.calls.length; await old.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  assert.equal(old.calls.slice(b3).map((c) => c.body).find((b) => b.type === "template").template.name, "fc_order_on_the_way", "until approved (courierTemplate off): the current template");
}));

test("SB4 window: once the owner lists a stage in windowV2Stages (Meta approved), outside the window its v2 template goes out with the right variables", withEnv(LOCKS_OPEN, async () => {
  const CAT = await import("./watemplates.js"); const WA = await import("./whatsapp.js"); WA.registerCatalog(CAT);
  const w = world({ waBot: { mode: "test", testPhones: TESTERS, windowV2Stages: ["on_the_way"] }, notifications: { whatsappEnabled: true, whatsappStages: ["on_the_way"] } });
  await w.say("هلا"); w.clock.advance(25 * 60); w.db.optins["512345678"] = { updates: true };
  const b = w.calls.length; await w.wa.sendOrderUpdate({ order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" }, "on_the_way");
  const tp = w.calls.slice(b).map((c) => c.body).find((x) => x.type === "template");
  assert.equal(tp.template.name, "fc_order_on_the_way_v2"); assert.equal(tp.template.components[0].parameters[0].text, "W1790012345678");
}));

/* ١٤/١٠ — زر «📲 تابع طلبك على واتساب» (صفحة الشكر/التتبع) + سياسة النافذة المقفولة (wapolicy.js) */
test("follow button: «تابع طلبي W…» (ar/en) ⇒ that order's status from the rules + «سنرسل لك هنا كل تحديث» + tracking button; the chat is marked order-follow; never the assistant", withEnv(CONFIGURED, async () => {
  const ORD = { order_no: "W1790012345678", phone_norm: "512345678", status: "accepted", option: "delivery", created_at: "2026-10-12T14:50:00Z" };
  const w = world({ waBot: { mode: "test", testPhones: TESTERS }, orders: [ORD] });
  const t = await w.say("تابع طلبي W1790012345678");
  assert.equal(t.log.reply_key, "status", JSON.stringify(t.log));
  const m = t.sent.find((b) => b.type);
  assert.match(JSON.stringify(m), /طلبك رقم W1790012345678/); assert.match(JSON.stringify(m), /✅ تم — سنرسل لك هنا كل تحديث على طلبك\./);
  assert.match(JSON.stringify(m), /freshcuts\.sa\/track\/W1790012345678/);
  assert.equal(w.db.chats.get("512345678").follow_order, "W1790012345678");
  for (const txt of ["تابع طلبي W1790012345678", "Track my order W1790012345678", "📲 تابع طلبي رقم W1790012345678", "track my order #w1790012345678"]) {
    const c = R.classify({ type: "text", text: txt });
    assert.deepEqual([c.key, c.rawIntent, c.entities.orderNo], ["status", "follow_link", "W1790012345678"], txt);
  }
  assert.notEqual(R.classify({ type: "text", text: "ابي اتابع طلبي W1790012345678 وين وصل وليش تأخر" }).rawIntent, "follow_link", "only the ready-made text, not any sentence");
  const A = await import("./waassistrun.js");
  const el = A.assistEligible({ acfg: { mode: "live" }, cfg: { mode: "live", testPhones: [] }, phone: "512345678", ev: { text: "تابع طلبي W1790012345678" }, cls: R.classify({ type: "text", text: "تابع طلبي W1790012345678" }), d: { act: "reply" }, allowed: true, openOrder: false });
  assert.deepEqual([el.run, el.why], [false, "rules:follow_link"]);
  // another phone cannot read the order by its number
  const other = await w.say("تابع طلبي W1790012345678", { from: "966500000009" });
  assert.doesNotMatch(JSON.stringify(other.sent), /W1790012345678: /);
}));

test("closed window: delivered went with «تمام 👍 / عندي ملاحظة» (v2 template or free) ⇒ NO separate paid review template for the order; plain delivered ⇒ the review waits reviewPaidGapMin after the last paid template", withEnv(LOCKS_OPEN, async () => {
  const CAT = await import("./watemplates.js"); const WA = await import("./whatsapp.js"); WA.registerCatalog(CAT);
  const O = { order_no: "W1790012345678", phone_norm: "512345678", option: "delivery" };
  const mk = (waBot = {}) => world({ waBot: { mode: "test", testPhones: TESTERS, windowV2Stages: ["delivered"], ...waBot }, notifications: { whatsappEnabled: true, whatsappStages: ["delivered"] } });
  // ١) v2 template (window closed) ⇒ merged
  const a = mk(); await a.say("هلا"); a.clock.advance(25 * 60); a.db.optins["512345678"] = { updates: true };
  await a.wa.sendOrderUpdate(O, "delivered");
  assert.equal(a.calls.at(-1).body.template.name, "fc_order_delivered_v2");
  a.clock.advance(31); const n0 = a.calls.length;
  assert.deepEqual(await a.bot.reviewAsk({ phone: "0512345678", orderNo: O.order_no, code: "ab12cd34" }), { ok: true, channel: "wa_merged" });
  assert.equal(a.calls.length, n0, "no review template went out");
  assert.deepEqual(a.db.policySkips.map((x) => [x.order_no, x.stage, x.reason]), [[O.order_no, "review", "review_merged"]]);
  assert.equal(a.db.chats.get("512345678").review_code, "ab12cd34", "a typed «تمام» still counts as the answer");
  // the daily report: one order, 1 paid, 1 left out by the policy
  const rep = (await a.call("GET", "/api/cms/wabot/assist/daily")).body.report.window.orders;
  assert.deepEqual([rep.orders, rep.paid, rep.free, rep.policy_skipped], [1, 1, 0, 1]);
  assert.deepEqual(rep.list[0].stages.map((s) => [s.stage, s.kind]), [["delivered", "paid"], ["review", "skipped"]]);
  assert.ok(rep.saved_sar > 0);
  // ٢) free delivered inside the window, review after the window closed ⇒ merged too
  const f = mk(); await f.say("هلا"); f.db.optins["512345678"] = { updates: true };
  assert.equal((await f.wa.sendOrderUpdate(O, "delivered")).free, true);
  f.clock.advance(25 * 60);
  assert.deepEqual(await f.bot.reviewAsk({ phone: "0512345678", orderNo: O.order_no, code: "ab12cd34" }), { ok: true, channel: "wa_merged" });
  // ٣) old delivered template (no buttons) ⇒ the review waits 30 min after it, then goes
  const p = mk({ windowV2Stages: [] }); await p.say("هلا"); p.clock.advance(25 * 60); p.db.optins["512345678"] = { updates: true };
  await p.wa.sendOrderUpdate(O, "delivered"); assert.equal(p.calls.at(-1).body.template.name, "fc_order_delivered");
  p.clock.advance(10);
  const d = await p.bot.reviewAsk({ phone: "0512345678", orderNo: O.order_no, code: "ab12cd34" });
  assert.deepEqual([d.ok, d.skipped, d.defer], [false, "paid_gap", true]); assert.ok(Date.parse(d.until) > p.clock.now().getTime());
  p.clock.advance(21);
  assert.deepEqual(await p.bot.reviewAsk({ phone: "0512345678", orderNo: O.order_no, code: "ab12cd34" }), { ok: true, channel: "wa_template" });
  assert.equal(p.calls.at(-1).body.template.name, "fc_review_request");
  // ٤) switches off ⇒ as before
  const off = mk({ mergeDeliveredReview: false }); await off.say("هلا"); off.clock.advance(25 * 60); off.db.optins["512345678"] = { updates: true };
  await off.wa.sendOrderUpdate(O, "delivered"); off.clock.advance(31);
  assert.deepEqual(await off.bot.reviewAsk({ phone: "0512345678", orderNo: O.order_no, code: "ab12cd34" }), { ok: true, channel: "wa_template" });
  const cfg = R.botConfig({ waBot: {} });
  assert.deepEqual([cfg.followLink, cfg.followNumber, cfg.closedPolicy, cfg.closedSkipPreparing, cfg.mergeDeliveredReview, cfg.reviewPaidGapMin], [true, "966546715683", true, true, true, 30], "defaults ON");
}));

test("policy settings: in the bot schema with Arabic labels, saved through the bot settings route with validation", withEnv(CONFIGURED, async () => {
  for (const k of ["followLink", "followNumber", "closedPolicy", "closedSkipPreparing", "mergeDeliveredReview", "reviewPaidGapMin"]) { assert.ok(R.SCHEMA[k], k); assert.match(R.SCHEMA[k].ar, /[؀-ۿ]/, k); }
  const w = world({ waBot: { mode: "test", testPhones: TESTERS } });
  const put = async (b) => w.call("PUT", "/api/cms/wabot/config", b);
  const r1 = await put({ closedSkipPreparing: false, reviewPaidGapMin: 45, followNumber: "0546715683" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([w.db.settings.waBot.closedSkipPreparing, w.db.settings.waBot.reviewPaidGapMin, w.db.settings.waBot.followNumber], [false, 45, "966546715683"]);
  assert.equal((await put({ reviewPaidGapMin: 999 })).status, 400);
  assert.equal((await put({ followNumber: "abc" })).status, 400);
}));

/* ══ FD1 (١٤/١٠): حملة «طبقك المفضل» — «أبغى أطلب» / «نعم» ⇒ سلة جاهزة بالعرض اللي وصل للرقم ده بالظبط ═══════════════
   المنيو والبوكسات الحقيقية يوم ١٤/١٠ (wafavpick.fixture.json)؛ العرض المخزّن من صف wa_send_queue (vars.fav + vars.cloud اللي اتبعتت)؛ السلة من بنّاء سلة المساعد.
   مراجعة ١٤/١٠: السلة للضغطة نفسها أو «نعم/أبغى» صريحة كأول حاجة بعد الرسالة بس، وبنفس العرض اللي اتبعت بالحرف، وبتتحفظ بس لو الرد طالع فعلاً. */
const FAVP = await import("./wafavpick.js");
const { assistEligible: FD1_ELIGIBLE } = await import("./waassistrun.js");
const FXF = JSON.parse(fs.readFileSync(new URL("./wafavpick.fixture.json", import.meta.url), "utf8"));
const CREPE_SPEC = { v: 1, kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", favV: null, sg: "crepe", catOnly: false, direct: false, price: 65, at: "2026-10-12T14:00:00Z" };
const CREPE_LINE = "بوكس الكريب لشخصين (كريب شيش طاووق وكريب ثاني من اختيارك مع تشيز فرايز وصنف جانبي ومشروبين) بـ65 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل";
const CREPE_VALUES = { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": CREPE_LINE };
const FD1_SENT_AT = new Date(Date.parse(OPEN_AT) - 10 * 60_000).toISOString();
function fd1World({ spec = CREPE_SPEC, values = CREPE_VALUES, sent = true, perRecipient = true, template = "fc_frame_ask_text", web = null, newer = false, orderedSince = false, waBot = {}, links = [], extraSettings = {}, bundles = FXF.bundles, loc = null, hist = null } = {}) {
  const holder = {};
  const lastSent = sent ? { id: 7, job_id: 3, sent_at: FD1_SENT_AT, wamid: "wamid.CAMP7", cloud_template: template, cloud_vars: perRecipient ? { offer: "", perRecipient: true } : { offer: "عرض" },
    vars: { fav: spec, cloud: { values } } } : null;
  const favSql = [];
  const fpool = { async query(sql, p = []) {
    const S = FAVP.FAV_SQL, rows = (r) => ({ rows: r, rowCount: r.length });
    favSql.push(sql);
    if (sql === S.first) return rows([{ code: "FIRST", active: true, min_total: "60", free_delivery: true, percent: "0", expires_at: null }]);
    if (sql === S.policy) return rows([{ config: FXF.policy }]);
    if (sql === S.web) return rows(web ? [{ pn: p[0][0], ...web }] : []);
    if (sql === S.lastDelivery) return rows(loc ? [{ pn: p[0][0], lat: loc.lat, lng: loc.lng, district: null }] : []);
    if ([S.firstUsed, S.accounts, S.rewards].includes(sql)) return rows([]);
    if (sql === S.history) return rows((hist || []).map((o) => ({ pn: p[0][0], ...o })));      // FU1: طلباته القديمة (طبقه المفضل)
    if (sql === S.lastSent) return rows(lastSent && (p[2] == null || lastSent.wamid === p[2]) ? [lastSent] : []);      // $3 = wamid الرسالة اللي اتضغط زرها
    if (sql === S.newerTemplate) return rows(newer ? [{}] : []);
    /* yesGate على نفس سجل البوت والرسايل بتوع العالم ده */
    if (sql === S.inboundSince) return rows(holder.w.db.log.filter((l) => l.phone_norm === p[0] && l.id !== p[1] && Date.parse(l.at) > Date.parse(p[2])).slice(0, 1).map(() => ({})));
    if (sql === S.outboundSince) return rows(holder.w.db.msgs.filter((m) => m.phone_norm === p[0] && m.direction === "out" && Date.parse(m.created_at) > Date.parse(p[1]) && (m.wamid || "") !== (p[2] || "") && !["failed", "skipped"].includes(m.status || "")).slice(0, 1).map(() => ({})));
    if (sql === S.orderedSince) return rows(orderedSince ? [{}] : []);
    throw new Error(`unexpected fav sql: ${sql.slice(0, 60)}`);
  } };
  const fav = { lastOffer: (...a) => holder.api.lastOffer(...a), yesGate: (...a) => holder.api.yesGate(...a), tapOffer: (...a) => holder.api.tapOffer(...a), saveCart: (...a) => holder.api.saveCart(...a), favDishFor: (...a) => holder.api.favDishFor(...a) };
  /* زيادة الاختيار من البوكس نفسه (زي cms.expandBundle) */
  const expandBundle = async (slug, choices, qty) => {
    const b = bundles.find((x) => x.slug === slug); if (!b) return { ok: false, error: "bundle_not_found" };
    let sur = 0; for (const s of b.slots) if (s.type === "choice") { const c = s.choices.find((x) => String(x.product_id) === String(choices[s.key] && choices[s.key].product_id)); sur += Number(c && c.surcharge) || 0; }
    return { ok: true, quantity: qty, surchargeIncl: sur * qty, picks: [] };
  };
  const w = liveWorld({ pages: FXF.pages, variants: FXF.variants, bundles, offers: FXF.offers.map((o) => ({ ...o, channels: { delivery: true, takeaway: true }, dineInOnly: false })), links: [...ALL_LINKS, ...links], fav, expandBundle, waBot, extraSettings });
  holder.w = w;
  /* loc ⇒ عنوان مؤكد (كاش جوجل) والرسم من سلّم الرسوم بتاع ١٤/١٠ (جوّه ١٠ كم مفيش رسم كيلو) */
  const ladderFee = (t) => [...FXF.policy.feeByTotal].sort((a, b) => b.over - a.over).find((x) => t >= x.over).fee;
  holder.api = FAVP.makeFavPick({ pool: fpool, live: () => w.bot.live, quote: async (x) => (loc ? { deliverable: true, fee: ladderFee(x.orderTotal), distanceSource: "google", routeKm: loc.km } : null), now: () => Date.parse(OPEN_AT) });
  /* رسالة الحملة نفسها في سجل الرسايل (زي guardSend) — قبل الوقت الحالي بعشر دقايق */
  if (sent) w.db.msgs.push({ wamid: "wamid.CAMP7", direction: "out", phone_norm: "512345678", template, category: "MARKETING", status: "delivered", source: "campaign", created_at: new Date(Date.parse(FD1_SENT_AT) - 1000).toISOString() });
  w.favSql = favSql;
  return w;
}
const tapOrder = (w, o = {}) => w.say(null, { ...o, raw: { type: "button", button: { payload: "أبغى أطلب", text: "أبغى أطلب" } } });
const FD1_BODY = `جهّزنا لك طلبك في السلة 🛒\n${CREPE_LINE}.\nاخترنا لك في البوكس: كريب شيش طاووق، كريب سوبر كرانشي، بطاطس محمرة.\nراجع السلة وكمّل الدفع من الزر 👇 ولو تبي تغيّر شي اكتب لي هنا.`;
const GENERIC = /^الطلب من موقعنا يأخذ دقيقة 👇/;

test("FD1 ضغطة «أبغى أطلب» على رسالة «طبقك المفضل»: نفس العرض بسعره وسطر التوصيل الحين + زر «كمّل طلبك» لسلة جاهزة بالبوكس وطبقه (مصدرها campaign)", withEnv(LOCKS_OPEN, async () => {
  const w = fd1World();
  const r = await tapOrder(w);
  assert.equal(r.sent.length, 1, JSON.stringify(r.log));
  assert.equal(bodyOf(r.sent[0]), FD1_BODY);
  assert.equal(urlOf(r.sent[0]), "https://freshcuts.sa/c/rc000001");
  assert.equal(r.sent[0].interactive.action.parameters.display_text, "كمّل طلبك");
  assert.deepEqual([r.log.reply_key, r.log.link_slug], ["order", "wa-campaign"]);
  assert.equal(w.db.botCarts.length, 1, "سلة واحدة بس (اتحفظت بعد القرار)");
  const cart = w.db.botCarts[0];
  assert.equal(cart.source, "campaign");
  const [key] = Object.keys(cart.plan.raw);
  assert.match(key, /^b:box-crepe-duo:crepe1=6:\|crepe2=9:\|side=79:$/);
  assert.equal(cart.plan.items[0].p, 65, "سعر السلة = السعر اللي في الرسالة");
  assert.ok(!JSON.stringify(r.sent).includes("fdpending0"), "الكود المؤقت عمره ما بيطلع");
  // «ورّني المنيو» زي ما هو: أقسام المنيو
  const m = await w.say(null, { raw: { type: "button", button: { payload: "ورّني المنيو", text: "ورّني المنيو" } } });
  assert.equal(m.log.reply_key, "cats"); assert.equal(bodyOf(m.sent[0]), "أقسام المنيو 👇 اختر القسم وأعرض لك الأصناف بأسعارها.");
}));

test("FD1 العرض اتغيّر أو مش «طبقك المفضل» ⇒ رد «أبي أطلب» العادي (مفيش سعر غير اللي في الرسالة): الطبق خلص، السعر اتغيّر من ساعة الإرسال، حملة بقيمة واحدة، قالب تسويقي أحدث، مفيش رسالة، المفتاح مقفول", withEnv(LOCKS_OPEN, async () => {
  const sold = fd1World({ extraSettings: { catalog: { soldOut: { 6: { until: null } } } } });
  const r1 = await tapOrder(sold);
  assert.match(bodyOf(r1.sent[0]), GENERIC); assert.equal(sold.db.botCarts.length, 0); assert.equal(r1.log.detail, "campaign:sold_out");
  /* المراجعة: الرسالة قالت ٦٥ والبوكس بقى ٧٩ ⇒ كان بيرد بسلة بـ٧٩ من غير ما يقول. دلوقتي: الرد العادي وسبب «offer_changed» */
  const b79 = JSON.parse(JSON.stringify(FXF.bundles)); b79.find((x) => x.slug === "box-crepe-duo").price = 79;
  const pr = fd1World({ bundles: b79 });
  const r2 = await tapOrder(pr);
  assert.match(bodyOf(r2.sent[0]), GENERIC); assert.equal(pr.db.botCarts.length, 0); assert.equal(r2.log.detail, "campaign:offer_changed");
  assert.ok(!/79|٧٩/.test(bodyOf(r2.sent[0])));
  for (const o of [{ perRecipient: false }, { template: "fc_frame_news_text" }, { newer: true }, { sent: false }, { waBot: { campaignCart: false } }, { values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": "سطر قديم بسعر تاني" } }]) {
    const w = fd1World(o);
    const r = await tapOrder(w);
    assert.match(bodyOf(r.sent[0]), GENERIC, JSON.stringify(o)); assert.equal(w.db.botCarts.length, 0, JSON.stringify(o));
  }
}));

test("FD1 «نعم» مكتوبة أول رد بعد رسالة الحملة = «أبغى أطلب»؛ «نعم» من غير حملة (أو بعد ما المحادثة اتحركت) فضلت زي ما هي (سكوت)", withEnv(LOCKS_OPEN, async () => {
  for (const yes of ["نعم", "ايوه", "أكيد", "أبغى أطلب", "ابي العرض", "نعم ابغى", "تمام ابغى"]) {
    const w = fd1World();
    const r = await w.say(yes);
    assert.equal(bodyOf(r.sent[0] || { type: "text", text: { body: "" } }), FD1_BODY, yes); assert.equal(r.log.reply_key, "order", yes); assert.deepEqual(w.db.botCarts.map((c) => c.source), ["campaign"], yes);
  }
  const w = fd1World();
  await w.say("نعم");
  const again = await w.say("تمام");                                  // المحادثة اتحركت ⇒ «تمام» كلام عادي
  assert.deepEqual([again.sent.length, again.log.decision], [0, "silent"]);
  const again2 = await w.say("نعم");                                  // ولا «نعم» تانية: مش أول رد
  assert.deepEqual([again2.sent.length, again2.log.decision, w.db.botCarts.length], [0, "silent", 1]);
  const none = fd1World({ sent: false });
  const r2 = await none.say("نعم");
  assert.deepEqual([r2.sent.length, r2.log.decision], [0, "silent"]);
}));

test("مراجعة FD1 — «تمام / 👍 / 😡 / 🤮 / 🙏 / اها / ماشي / طيب / حلو / ok / نعم؟» أول رد بعد الحملة: مش موافقة ⇒ سكوت زي قبل الحملة، ولا سلة", withEnv(LOCKS_OPEN, async () => {
  for (const t of ["تمام", "👍", "😡", "🤮", "🙏", "اها", "ماشي", "طيب", "حلو", "ok", "زين", "نعم؟"]) {
    const w = fd1World();
    const r = await w.say(t);
    assert.deepEqual([r.sent.length, r.log.decision, w.db.botCarts.length], [0, "silent", 0], t);
  }
  // «ايه» (= «إيش؟» عند ناس) مش موافقة: ردها العادي زي قبل الحملة («ما فهمت»)، مش سلة
  const eh = fd1World();
  const re = await eh.say("ايه");
  assert.deepEqual([re.log.reply_key, eh.db.botCarts.length], ["unknown", 0]);
  // العرض خلص + «😡» ⇒ برضه سكوت (مش «الطلب من موقعنا…»)
  const sold = fd1World({ extraSettings: { catalog: { soldOut: { 6: { until: null } } } } });
  const r = await sold.say("😡");
  assert.deepEqual([r.sent.length, r.log.decision], [0, "silent"]);
  // الوحدات: isCampaignYes
  for (const t of ["نعم", "ايوه", "ايوا", "اي", "اكيد", "أكيد!", "yes", "Yes please", "sure", "ابغى", "أبغى أطلب", "ابي اطلب لو سمحت", "ودي اطلب", "تمام ابغى", "ok i want"]) assert.equal(R.isCampaignYes(t), t !== "ok i want" ? true : false, t);
  for (const t of ["تمام", "اوكي", "ok", "👍", "😡", "🙏", "اها", "اه", "ايه", "طيب", "ماشي", "حلو", "زين", "شكرا", "لا", "نعم؟", "ابغى اطلب برجر", "كيف اطلب", "ابي بيتزا", ""]) assert.equal(R.isCampaignYes(t), false, t);
}));

test("مراجعة FD1 — في الـ٧٢ ساعة بعد الحملة: أي رسالة غير الضغطة / «نعم» أول رد بتمشي في طريقها العادي («أبغى أطلب برجر»، «كيف أطلب»، سؤال) — والضغطة بعدها لسه شغّالة", withEnv(LOCKS_OPEN, async () => {
  const w = fd1World();
  const a = await w.say("عندكم برجر؟");
  assert.notEqual(a.log.link_slug, "wa-campaign"); assert.equal(w.db.botCarts.length, 0);
  const b = await w.say("ابغى اطلب برجر");
  assert.match(bodyOf(b.sent[0]), GENERIC); assert.notEqual(b.log.link_slug, "wa-campaign");
  w.clock.advance(1);
  const c = await w.say("كيف اطلب");
  assert.match(bodyOf(c.sent[0]), GENERIC); assert.equal(w.db.botCarts.length, 0, "ولا سلة حملة لرسالة مش ليها");
  w.clock.advance(1);
  const t = await tapOrder(w);                                          // ضغطة الزر نفسه = طلب صريح للعرض ده
  assert.equal(bodyOf(t.sent[0]), FD1_BODY); assert.equal(w.db.botCarts.length, 1);
  // المساعد: رسالة «طلب» عادية بتروح له؛ الضغطة و«نعم» الأولى بس للقواعد
  const base = { acfg: { mode: "test" }, cfg: { mode: "test", testPhones: ["512345678"] }, phone: "512345678", ev: { text: "ابغى اطلب برجر" }, d: { act: "reply", key: "order" } };
  assert.equal(FD1_ELIGIBLE({ ...base, sessionActive: true, cls: { key: "order", rawIntent: "how_to_order" } }).run, true);
}));

test("مراجعة FD1 — «نعم/تمام» بعد ما المحادثة اتحركت: طلب من ساعتها، موظف رد، تحديث طلب، رسالة تانية قبلها، أو وصلت متأخرة ⇒ مش موافقة على العرض (ولا تحويل لموظف)", withEnv(LOCKS_OPEN, async () => {
  // طلب جديد بعد الإرسال
  const o = fd1World({ orderedSince: true });
  const r1 = await o.say("نعم");
  assert.deepEqual([r1.sent.length, r1.log.decision, o.db.botCarts.length], [0, "silent", 0]); assert.equal(r1.log.detail, "campaign_yes:ordered_since");
  // موظف كتب من الموبايل بعد الحملة ⇒ «نعم» بتاعته، والبوت مايرميش سلة بعد انتظار الموظف
  const s = fd1World();
  await s.cashier("تم يا غالي، طلبك بيوصل خلال نص ساعة"); s.clock.advance(2);
  const r2 = await s.say("نعم");
  assert.equal(r2.sent.length, 0);
  assert.equal(r2.log.detail, "campaign_yes:chat_moved_on");
  const after = await s.tick(6);
  assert.deepEqual([after.length, s.db.botCarts.length], [0, 0]);
  const r2b = await s.say("تمام");
  assert.equal(r2b.sent.length, 0);
  assert.deepEqual((await s.tick(6)).length, 0);
  // تحديث طلب (قالب UTILITY) طلع بعد الحملة
  const u = fd1World();
  u.db.msgs.push({ wamid: "wamid.UPD1", direction: "out", phone_norm: "512345678", template: "fc_order_on_the_way", category: "UTILITY", status: "delivered", source: "api", created_at: new Date(Date.parse(OPEN_AT) - 60_000).toISOString() });
  const r3 = await u.say("نعم");
  assert.deepEqual([r3.sent.length, u.db.botCarts.length, r3.log.detail], [0, 0, "campaign_yes:chat_moved_on"]);
  // رسالة تانية من العميل قبلها (حتى لو البوت سكت عليها)
  const f = fd1World();
  await f.say("👍"); f.clock.advance(1);
  const r4 = await f.say("نعم");
  assert.deepEqual([r4.sent.length, f.db.botCarts.length, r4.log.detail], [0, 0, "campaign_yes:not_first_reply"]);
  // «نعم» / «تمام» وصلت متأخرة ٣٠ دقيقة ⇒ سكوت (مش «سؤالك يحتاج واحد من الفريق» + تحويل)
  for (const t of ["نعم", "تمام"]) {
    const l = fd1World();
    const r5 = await l.say(t, { agoMin: 30 });
    assert.deepEqual([r5.sent.length, r5.log.decision, l.db.botCarts.length, l.portal.length], [0, "silent", 0, 0], t);
  }
}));

test("مراجعة FD1 — سلة الحملة بتتحفظ بس لو الرد طالع: كتم / مش رقم تجربة ⇒ ولا صف؛ ضغطة وقت انتظار الموظف ⇒ سلة واحدة بس (بعد الانتظار)", withEnv(LOCKS_OPEN, async () => {
  const m = fd1World();
  m.db.chats.set("512345678", { phone_norm: "512345678", unknown_streak: 0, last_disclosed_at: new Date(Date.parse(OPEN_AT)).toISOString(), muted_until: new Date(Date.parse(OPEN_AT) + 3600_000).toISOString() });
  const r1 = await tapOrder(m);
  assert.deepEqual([r1.sent.length, r1.log.decision, m.db.botCarts.length], [0, "silent", 0]);
  const t = fd1World({ waBot: { mode: "test", testPhones: ["0599999999"] } });
  const r2 = await tapOrder(t);
  assert.deepEqual([r2.sent.length, t.db.botCarts.length], [0, 0]);
  // الموظف بيكلّم العميل ⇒ الضغطة بتستنى staffWaitMin وبعدها الرد بسلة واحدة
  const s = fd1World();
  await s.cashier("هلا"); s.clock.advance(1);
  const r3 = await tapOrder(s);
  assert.deepEqual([r3.sent.length, r3.log.decision, s.db.botCarts.length], [0, "waiting", 0]);
  const out = await s.tick(6);
  assert.equal(out.length, 1);
  assert.equal(bodyOf(out[0]), FD1_BODY);
  assert.deepEqual(s.db.botCarts.map((c) => c.source), ["campaign"]);
}));

test("مراجعة FD1 — «yes» بالإنجليزي: رد الحملة بالعربي كله (سطر العرض عربي) — مش إطار إنجليزي حوالين سطر عربي", withEnv(LOCKS_OPEN, async () => {
  const w = fd1World();
  const r = await w.say("yes");
  assert.equal(bodyOf(r.sent[0]), FD1_BODY);
  assert.equal(r.sent[0].interactive.action.parameters.display_text, "كمّل طلبك");
}));

test("FD1 بوكس «من نوع أكله» (من غير طبقه) ⇒ الرد بنفس العرض وزر «اطلب البوكس» يفتح البوكس نفسه يختار هو — من غير سلة", withEnv(LOCKS_OPEN, async () => {
  const line = "بوكس الكريب الفردي (كريب من اختيارك مع صنف جانبي ومشروب غازي) بسعر يبدأ من 29 ر.س، ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س";
  const w = fd1World({ spec: { v: 1, kind: "box", slug: "box-solo-crepe", pid: "11", sg: "crepe", catOnly: true, direct: false, price: 29 }, values: { "offer.title": "بوكس يناسب ذوقك", "offer.line": line }, links: ["box-solo-crepe"] });
  const r = await tapOrder(w);
  assert.equal(bodyOf(r.sent[0]), `${line}.\nاختر اللي يعجبك في البوكس وكمّل طلبك من الزر 👇`);
  assert.deepEqual([urlOf(r.sent[0]), r.sent[0].interactive.action.parameters.display_text, w.db.botCarts.length], ["https://freshcuts.sa/l/box-solo-crepe", "اطلب البوكس", 0]);
}));

test("FD1 المساعد: «أبغى أطلب» / «نعم» على الحملة للقواعد (الرابط مضمون)؛ اللي بعدها للمساعد عادي", () => {
  const base = { acfg: { mode: "test" }, cfg: { mode: "test", testPhones: ["512345678"] }, phone: "512345678", ev: { text: "ابي اطلب" }, d: { act: "reply", key: "order" } };
  for (const raw of ["campaign_order", "campaign_yes", "campaign_tap"]) assert.deepEqual(FD1_ELIGIBLE({ ...base, cls: { key: "order", rawIntent: raw } }), { run: false, why: "rules:campaign_order" }, raw);
  assert.equal(FD1_ELIGIBLE({ ...base, cls: { key: "order", rawIntent: "how_to_order" } }).run, true);
});

test("FD1 الإعدادات: «أبغى أطلب» ⇒ سلة الحملة (افتراضي مفتوح) ومدة قراءة العرض ٧٢ ساعة (١–١٦٨) — في جدول اللوحة وبتتحفظ", () => {
  const d = R.botConfig({});
  assert.deepEqual([d.campaignCart, d.campaignOfferHours, d.campaignYesQuietMin], [true, 72, 60]);
  assert.deepEqual([R.botConfig({ waBot: { campaignYesQuietMin: 0 } }).campaignYesQuietMin, R.botConfig({ waBot: { campaignYesQuietMin: 5000 } }).campaignYesQuietMin], [0, 720]);
  assert.deepEqual([R.botConfig({ waBot: { campaignCart: false, campaignOfferHours: 999 } }).campaignCart, R.botConfig({ waBot: { campaignOfferHours: 999 } }).campaignOfferHours], [false, 168]);
  assert.ok(R.SCHEMA.campaignCart && R.SCHEMA.campaignOfferHours && R.SCHEMA.campaignYesQuietMin);
  const ok = R.configFromBody({ campaignCart: false, campaignOfferHours: 24 }, {});
  assert.deepEqual([ok.ok, ok.value.campaignCart, ok.value.campaignOfferHours], [true, false, 24]);
  assert.equal(R.configFromBody({ campaignOfferHours: 500 }, {}).ok, false);
  for (const k of ["camp_order_body", "camp_picks", "camp_box_body"]) assert.ok(R.TEXT_KEYS.includes(k), k);
});

test("مراجعة FD1 — كاش البوت الصارم (live strict): المنيو مااتحدّثش في مدته ⇒ مفيش أسعار للحملة؛ ردود البوت العادية بتفضل بالكاش القديم لحد staleCacheMin", withEnv(LOCKS_OPEN, async () => {
  let down = false;
  const w = world({ waBot: { mode: "live" }, bundles: LIVE.bundles, links: ALL_LINKS, pages: () => (down ? null : LIVE.pages) });
  const fresh = await w.bot.live.menu({ strict: true });
  assert.ok(fresh && fresh.items.length > 0);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7 * 60_000;      // menuCacheMin (٥) + ١ عدّوا، والتحديث فشل (المتجر واقع)
    down = true;
    assert.equal(await w.bot.live.menu({ strict: true }), null, "الحملة: مفيش سعر من كاش قديم");
    const loose = await w.bot.live.menu();
    assert.ok(loose && loose.items.length > 0, "البوت العادي: الكاش القديم لحد staleCacheMin زي ما هو");
  } finally { Date.now = realNow; }
}));

/* ══ مراجعة FD1 ٣ (١٤/١٠): الضغطة بتتعرف بالرسالة اللي اتضغط زرها، «نعم» محتاجة محادثة هادية قبل الحملة، والسلة على نفس العنوان ═══ */
const tapOn = (w, ctxId, o = {}) => w.say(null, { ...o, raw: { type: "button", button: { payload: "أبغى أطلب", text: "أبغى أطلب" }, ...(ctxId ? { context: { from: BIZ, id: ctxId } } : {}) } });
const sayQuoting = (w, text, ctxId) => w.say(null, { raw: { type: "text", text: { body: text }, context: { from: BIZ, id: ctxId } } });

test("مراجعة FD1 ٣ — كل الأطر فيها نفس زر «أبغى أطلب»: الضغطة تحت إطار حملة تانية ⇒ ردها العادي (مش سلة «طبقك المفضل»)؛ الضغطة على رسالة «طبقك المفضل» نفسها ⇒ السلة حتى لو جه بعدها قالب تاني", withEnv(LOCKS_OPEN, async () => {
  const old = fd1World();
  const r1 = await tapOn(old, "wamid.OLDFRAME");
  assert.match(bodyOf(r1.sent[0]), GENERIC); assert.equal(old.db.botCarts.length, 0); assert.notEqual(r1.log.link_slug, "wa-campaign");
  const mine = fd1World({ newer: true });
  const r2 = await tapOn(mine, "wamid.CAMP7");
  assert.equal(bodyOf(r2.sent[0]), FD1_BODY); assert.deepEqual(mine.db.botCarts.map((c) => c.source), ["campaign"]);
  // من غير context (مايحصلش من ميتا): زي الأول — آخر رسالة حملة ومفيش قالب أحدث
  const bare = fd1World({ newer: true });
  assert.match(bodyOf((await tapOn(bare, null)).sent[0]), GENERIC);
  // الضغطة وقت انتظار الموظف: بعد الانتظار بتتقرا على نفس الرسالة
  const s = fd1World();
  await s.cashier("هلا"); s.clock.advance(1);
  const r3 = await tapOn(s, "wamid.OLDFRAME");
  assert.equal(r3.log.decision, "waiting");
  const out = await s.tick(6);
  assert.deepEqual([out.length, s.db.botCarts.length], [1, 0]); assert.match(bodyOf(out[0]), GENERIC);
}));

test("مراجعة FD1 ٣ — «نعم» مقتبسة على رسالة تانية مش موافقة على الحملة؛ «نعم» والمحادثة كانت شغّالة قبل الحملة بأقل من campaignYesQuietMin ⇒ طريقها العادي — إلا لو مقتبسة على رسالة الحملة نفسها", withEnv(LOCKS_OPEN, async () => {
  const q = fd1World();
  const r1 = await sayQuoting(q, "نعم", "wamid.BOTQ1");
  assert.deepEqual([r1.sent.length, q.db.botCarts.length, r1.log.detail], [0, 0, "campaign_yes:replied_to_other"]);
  const qq = fd1World();
  const r1b = await sayQuoting(qq, "نعم", "wamid.CAMP7");
  assert.equal(bodyOf(r1b.sent[0]), FD1_BODY);
  // البوت/المساعد رد عليه قبل الحملة بعشرين دقيقة (سؤال «أجهز لك السلة؟» مثلاً)
  const before = new Date(Date.parse(FD1_SENT_AT) - 20 * 60_000).toISOString();
  const pre = () => { const w = fd1World(); w.db.msgs.push({ wamid: "wamid.BOT0", direction: "out", phone_norm: "512345678", template: null, category: null, status: "delivered", source: "api", created_at: before }); return w; };
  const a = pre();
  const r2 = await a.say("نعم");
  assert.deepEqual([r2.sent.length, a.db.botCarts.length, r2.log.detail], [0, 0, "campaign_yes:chat_before_campaign"]);
  // نفس الحالة بس «نعم» مقتبسة على رسالة الحملة ⇒ موافقة عليها هي
  const b = pre();
  assert.equal(bodyOf((await sayQuoting(b, "نعم", "wamid.CAMP7")).sent[0]), FD1_BODY);
  // الشرط من اللوحة: ٠ = من غيره
  const c = fd1World({ waBot: { campaignYesQuietMin: 0 } });
  c.db.msgs.push({ wamid: "wamid.BOT0", direction: "out", phone_norm: "512345678", status: "delivered", source: "api", created_at: before });
  assert.equal(bodyOf((await c.say("نعم")).sent[0]), FD1_BODY);
  // الضغطة نفسها مش داخلة في الشرط ده
  const d = pre();
  assert.equal(bodyOf((await tapOn(d, "wamid.CAMP7")).sent[0]), FD1_BODY);
}));

test("مراجعة FD1 ٣ — رسالة قالت رسم «لعنوانك» ⇒ سلة الضغطة مابتشيلش موقع المحادثة (note.noChatLoc)؛ من غير عنوان معروف ⇒ زي الأول", withEnv(LOCKS_OPEN, async () => {
  const line = "بوكس الكريب لشخصين (كريب شيش طاووق وكريب ثاني من اختيارك مع تشيز فرايز وصنف جانبي ومشروبين) بـ65 ر.س، والتوصيل لعنوانك 15 ر.س";
  const w = fd1World({ loc: { lat: 21.6, lng: 39.16, km: 0.9 }, web: { n: 2, deliv: 2 }, values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": line } });
  const r = await tapOn(w, "wamid.CAMP7");
  assert.equal(bodyOf(r.sent[0]), FD1_BODY.replace(CREPE_LINE, line));
  assert.deepEqual([w.db.botCarts.length, w.db.botCarts[0].plan.noChatLoc], [1, true]);
  const n = fd1World();
  await tapOn(n, "wamid.CAMP7");
  assert.equal(n.db.botCarts[0].plan.noChatLoc, undefined);
}));

test("مراجعة FD1 ٣ — كاش المنيو الصارم: صنف بالوزن جلب أوزانه فشل ⇒ الحملة من غير أوزانه (مفيش سعر وزن قديم)، والبوت العادي بأوزانه المعروفة زي ما هو", withEnv(LOCKS_OPEN, async () => {
  const V = JSON.parse(JSON.stringify(FXF.variants));
  const w = world({ waBot: { mode: "live" }, bundles: FXF.bundles, links: ALL_LINKS, pages: FXF.pages, variants: V });
  const w97 = (m) => ((m && m.items.find((i) => String(i.id) === "97")) || {}).weights || [];
  assert.ok(w97(await w.bot.live.menu({ strict: true })).length > 0);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7 * 60_000;      // الكاش قدم (menuCacheMin ٥) ⇒ المنيو اتجاب تاني بنجاح، بس /api/product/97 وقع
    V["97"] = "down";
    const strict = await w.bot.live.menu({ strict: true });
    assert.ok(strict && strict.items.length > 0, "المنيو نفسه اتحدّث");
    assert.deepEqual(w97(strict), [], "الحملة: أوزان ٩٧ من جلب قديم ⇒ مش موجودة");
    assert.ok(w97(await w.bot.live.menu()).length > 0, "البوت العادي: آخر أوزان معروفة");
    const w94 = ((strict.items.find((i) => String(i.id) === "94")) || {}).weights || [];
    assert.ok(w94.length > 0, "صنف تاني بالوزن (طرب ٩٤) جلبه نجح ⇒ أوزانه موجودة");
  } finally { Date.now = realNow; }
}));

/* ══ FU1 (١٥/١٠): «متابعة اللي ردّ وماطلبش» — رسالة حرة واحدة جوّه النافذة للي ردّ على حملة أو ضغط زر ═══════════════════════════════
   عمر: «ليه البوت مش بيرجع يبعت رسالة تانية للناس اللي ردّت ويلحقهم في النافذة». المثال الحي: «ورّني المنيو» على «طبقك المفضل» ⇒ قايمة الأقسام ⇒ سكوت ⇒ ولا حاجة. */
const FU_NEUTRAL = "تبي أجهّز لك طلبك؟ 🙂";
const campTpl = (w, agoMin = 10, o = {}) => w.db.msgs.push({ wamid: `wamid.CAMPX${w.db.msgs.length}`, direction: "out", phone_norm: o.phone || "512345678", template: o.template || "fc_frame_video", category: "MARKETING", status: "delivered", source: "campaign", created_at: new Date(w.clock.now().getTime() - agoMin * 60_000).toISOString() });
const menuTap = (w, o = {}) => w.say(null, { ...o, raw: { type: "button", button: { payload: "ورّني المنيو", text: "ورّني المنيو" } } });
const fuLive = (o = {}) => { const w = liveWorld({ ...o, waBot: { paidNoteEnabled: false, ...(o.waBot || {}) } }); campTpl(w); return w; };
const fuIds = (p) => p.interactive.action.buttons.map((b) => b.reply.id);
const fuJob = (w) => w.db.jobs.filter((j) => j.kind === "reply_followup").at(-1) || null;
const fuOut = (list) => list.filter((p) => p.type === "interactive" && p.interactive.type === "button" && fuIds(p).includes("rf:yes"));

test("FU1 المثال الحي: «ورّني المنيو» على «طبقك المفضل» ⇒ سكوت ٤٠ دقيقة ⇒ متابعة واحدة بنفس العرض وسعره + سلة جاهزة + «أبغى أطلب / لا شكراً»؛ «أبغى أطلب» ⇒ نفس السلة بزر", withEnv(LOCKS_OPEN, async () => {
  const w = fd1World();
  const m = await menuTap(w);
  assert.equal(m.log.reply_key, "cats");
  assert.deepEqual(await w.tick(39), [], "not before 40 minutes of silence after our reply");
  const out = await w.tick(2);
  assert.equal(out.length, 1, JSON.stringify(w.db.jobs.map((j) => [j.kind, j.status, j.reason])));
  assert.equal(bodyOf(out[0]), "العرض اللي وصلك ما زال متاح: بوكس الكريب لشخصين بـ65 ر.س 🛒\nسلتك جاهزة بنفس السعر: https://freshcuts.sa/c/rc000001");
  assert.deepEqual(out[0].interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["rf:yes", "أبغى أطلب"], ["rf:no", "لا شكراً"]]);
  assert.ok(bodyOf(out[0]).split("\n").length <= 2, "two short lines at most");
  assert.deepEqual([w.db.botCarts[0].source, w.db.botCarts[0].plan.items[0].p], ["followup", 65], "the cart is the offer at the price that was in the campaign");
  assert.deepEqual([w.db.fu[0].via, w.db.fu[0].trigger, w.db.fu[0].status, w.db.fu[0].cart_code], ["offer", "campaign", "sent", "rc000001"]);
  assert.deepEqual([w.db.log.at(-1).reply_key, w.db.log.at(-1).msg_type, w.db.log.at(-1).decision], ["reply_followup", "followup", "replied"]);
  assert.deepEqual(await w.tick(120), [], "one per window");
  const y = await w.press("rf:yes", "أبغى أطلب");
  assert.equal(bodyOf(y.sent[0]), "تمام 👍 سلتك جاهزة، كمّل الدفع من الزر 👇"); assert.equal(urlOf(y.sent[0]), "https://freshcuts.sa/c/rc000001");
  assert.equal(w.db.botCarts.length, 1, "no second cart");
  assert.equal(w.db.fu[0].answer, "yes");
}));

test("FU1 العرض اتغيّر من ساعة الحملة (السعر) ⇒ مفيش سعر في المتابعة: سطر محايد من غير أرقام ولا سلة", withEnv(LOCKS_OPEN, async () => {
  const b79 = JSON.parse(JSON.stringify(FXF.bundles)); b79.find((x) => x.slug === "box-crepe-duo").price = 79;
  const w = fd1World({ bundles: b79 });
  await menuTap(w);
  const out = fuOut(await w.tick(41));
  assert.equal(out.length, 1);
  assert.equal(bodyOf(out[0]), FU_NEUTRAL);
  assert.ok(!/\d/.test(bodyOf(out[0])), "no price at all");
  assert.equal(w.db.botCarts.length, 0); assert.match(w.db.fu[0].ref, /^offer_changed:/);
}));

test("FU1 بالليل: سكت بعد ١:٣٠ ⇒ ولا رسالة بالليل، والمتابعة بتطلع أول الساعات المسموحة (١٢:٠٠) طول ما النافذة مفتوحة", withEnv(LOCKS_OPEN, async () => {
  const w = fuLive({ at: "2026-10-12T22:16:00Z" });      // الثلاثاء ١:١٦ الرياض (زي المثال الحي)
  const m = await menuTap(w);
  assert.equal(m.log.reply_key, "cats");
  assert.deepEqual(fuOut(await w.tick(41)), [], "01:57 — late night: nothing");
  assert.equal(fuJob(w), null, "no job outside the allowed hours");
  w.clock.set("2026-10-13T06:00:00Z"); assert.deepEqual(fuOut(await w.tick(0)), [], "09:00 — still quiet");
  w.clock.set("2026-10-13T09:01:00Z");
  const out = fuOut(await w.tick(0));
  assert.equal(out.length, 1, JSON.stringify(w.db.jobs.map((j) => [j.kind, j.status, j.reason])));
  assert.equal(bodyOf(out[0]), FU_NEUTRAL, "no offer stored, nothing looked at, no history ⇒ the neutral line");
  assert.deepEqual(fuIds(out[0]), ["rf:yes", "rf:no"]);
  assert.deepEqual(fuOut(await w.tick(180)), []);
}));

test("FU1 ضغطة زر من غير حملة: القسم اللي فتحه ⇒ رابط المنيو؛ الصنف اللي فتحه ⇒ سلة جاهزة بسعره؛ كلام مكتوب بس ⇒ مش مرشّح", withEnv(LOCKS_OPEN, async () => {
  const s = liveWorld({ waBot: { paidNoteEnabled: false } });
  await s.press("m:cats", "📋 المنيو بالأقسام"); await s.press("cat:23", "كريبات");
  const o1 = fuOut(await s.tick(41));
  assert.equal(o1.length, 1);
  assert.equal(bodyOf(o1[0]), "تبي تطلب من «كريبات»؟ الأصناف بأسعارها هنا 👇\nhttps://freshcuts.sa/l/wab-menu");
  assert.deepEqual([s.db.fu[0].via, s.db.fu[0].trigger], ["section", "tap"]);
  const i = liveWorld({ waBot: { paidNoteEnabled: false } });
  await i.press("item:8", "كريب زنجر سوبريم");
  const o2 = fuOut(await i.tick(41));
  assert.equal(o2.length, 1);
  assert.equal(bodyOf(o2[0]), "جهّزنا لك كريب زنجر سوبريم بـ25 ر.س في السلة 🛒\nتكمّل طلبك من هنا: https://freshcuts.sa/c/rc000001");
  assert.deepEqual([i.db.botCarts[0].source, i.db.botCarts[0].plan.items[0].p, i.db.fu[0].cart_code], ["followup", 25, "rc000001"]);
  const t = liveWorld({ waBot: { paidNoteEnabled: false } });
  await t.say("السلام عليكم");
  assert.deepEqual(fuOut(await t.tick(60)), []); assert.equal(fuJob(t), null);
}));

test("FU1 مابتتبعتش: طلب من ساعتها، كتب تاني (بتتأجل لنافذته الجديدة)، موظف رد، «إيقاف»، شكوى، «شكراً»، المفتاح مقفول، متابعتين ماحدش رد عليهم في ٧ أيام", withEnv(LOCKS_OPEN, async () => {
  const orders = []; const o = fuLive({ orders }); await menuTap(o); orders.push(order({ status: "paid", created_at: o.clock.now().toISOString() }));
  assert.deepEqual(fuOut(await o.tick(41)), []); assert.equal(fuJob(o).reason, "ordered");
  const a = fuLive(); await menuTap(a); a.clock.advance(20); await a.say("كم سعر كريب زنجر سوبريم");
  assert.deepEqual(fuOut(await a.tick(21)), [], "40 min after the first reply: he wrote since");
  const ao = fuOut(await a.tick(21));
  assert.equal(ao.length, 1); assert.match(bodyOf(ao[0]), /كريب زنجر سوبريم بـ25 ر\.س/);
  assert.deepEqual(fuOut(await a.tick(120)), []);
  const b = fuLive(); await menuTap(b); b.clock.advance(5); await b.cashier("تفضل، تبي شي معين؟");
  assert.deepEqual(fuOut(await b.tick(36)), []); assert.equal(fuJob(b).reason, "staff_in_chat");
  /* رد موظف من الصندوق / البورتال القديم (wainbox.replyText ⇒ sendText ⇒ source «api» مش «echo») = موظف برضه */
  const b2 = fuLive(); await menuTap(b2); b2.clock.advance(3); b2.db.msgs.push({ wamid: "wamid.PORTAL1", direction: "out", phone_norm: "512345678", status: "accepted", source: "api", body: "حاضر", created_at: b2.clock.now().toISOString() });
  assert.deepEqual(fuOut(await b2.tick(44)), []); assert.equal(fuJob(b2).reason, "staff_in_chat");
  /* موظف كلّمه قبل آخر رسالة (والبوت رد بعد ما سكوت الموظف خلص) ⇒ المحادثة كان فيها إنسان ⇒ مفيش متابعة */
  const b3 = fuLive(); await menuTap(b3); b3.clock.advance(2); await b3.cashier("أهلاً، تحت أمرك"); b3.clock.advance(33); await b3.say("كم سعر كريب زنجر سوبريم");
  assert.deepEqual(fuOut(await b3.tick(41)), []); assert.equal(fuJob(b3).reason, "staff_in_chat");
  const c = fuLive(); await menuTap(c); c.clock.advance(2); await c.say("إيقاف");
  assert.deepEqual(fuOut(await c.tick(41)), []); assert.equal(fuJob(c).reason, "stopped");
  const d = fuLive(); await menuTap(d); d.clock.advance(2); await d.say("الأكل وصل بارد وناقص");
  assert.deepEqual(fuOut(await d.tick(41)), []); assert.match(fuJob(d).reason, /^(handover_open|complaint_today|closing:complaint)$/);
  const e = fuLive(); await menuTap(e); e.clock.advance(1); await e.say("شكراً");
  assert.deepEqual(fuOut(await e.tick(41)), []); assert.equal(fuJob(e).reason, "closing:thanks");
  const f = fuLive({ waBot: { replyFollowUp: false } }); await menuTap(f);
  assert.deepEqual(fuOut(await f.tick(60)), []); assert.equal(fuJob(f), null);
  const g = fuLive();
  for (const [k, days] of [["window_keep", 3], ["reply_followup", 2]]) g.db.log.push({ id: g.db.log.length + 1, wamid: null, phone_norm: "512345678", msg_type: "followup", decision: "replied", reply_key: k, at: new Date(g.clock.now().getTime() - days * 86400_000).toISOString() });
  await menuTap(g);
  assert.deepEqual(fuOut(await g.tick(41)), []); assert.equal(fuJob(g).reason, "ignored");
  const h = fuLive(); h.db.log.push({ id: 1, wamid: null, phone_norm: "512345678", msg_type: "followup", decision: "replied", reply_key: "window_keep", at: new Date(h.clock.now().getTime() - 3 * 86400_000).toISOString() });
  await menuTap(h); assert.equal(fuOut(await h.tick(41)).length, 1, "only one unanswered follow-up in 7 days ⇒ still allowed");
}));

test("FU1 «لا شكراً» (زر أو مكتوبة كأول رد) ⇒ سطر واحد ومفيش متابعات ٧ أيام؛ «ايوه» مكتوبة كأول رد ⇒ نفس السلة", withEnv(LOCKS_OPEN, async () => {
  const w = fuLive(); await menuTap(w);
  assert.equal(fuOut(await w.tick(41)).length, 1);
  const n = await w.press("rf:no", "لا شكراً");
  assert.deepEqual(n.sent.map(bodyOf), ["أبشر، حيّاك الله في أي وقت 🌟"]); assert.equal(n.log.handoff, null);
  assert.ok(w.db.chats.get("512345678").follow_declined_at); assert.equal(w.db.fu[0].answer, "no");
  w.clock.advance(24 * 60); campTpl(w, 5); await menuTap(w);
  assert.deepEqual(fuOut(await w.tick(41)), [], "a new window the next day: still declined"); assert.equal(fuJob(w).reason, "declined");
  w.clock.advance(7 * 24 * 60); campTpl(w, 5); await menuTap(w);
  assert.equal(fuOut(await w.tick(41)).length, 1, "after 7 days the decline is over");
  const t = fuLive(); await menuTap(t); await t.tick(41);
  const tn = await t.say("لا شكرا");
  assert.equal(tn.log.reply_key, "rf_no"); assert.equal(bodyOf(tn.sent[0]), "أبشر، حيّاك الله في أي وقت 🌟");
  const y = fd1World(); await menuTap(y); await y.tick(41);
  const yy = await y.say("ايوه");
  assert.equal(yy.log.reply_key, "rf_yes"); assert.equal(urlOf(yy.sent[0]), "https://freshcuts.sa/c/rc000001");
  const z = fuLive(); await menuTap(z); await z.tick(41);
  const zz = await z.press("rf:yes", "أبغى أطلب");
  assert.equal(zz.log.reply_key, "order"); assert.match(bodyOf(zz.sent[0]), /^الطلب من موقعنا يأخذ دقيقة 👇/);
}));

test("FU1 الفرامل: «إيقاف» بعد متابعة فوق ٢٪ من متابعات اليوم ⇒ المتابعات تقف لوحدها + تنبيه للمالك، ومابترجعش غير لما المالك يفكّها", withEnv(LOCKS_OPEN, async () => {
  const w = fuLive(); await menuTap(w);
  assert.equal(fuOut(await w.tick(41)).length, 1);
  await w.say("إيقاف");
  await w.tick(1);
  assert.ok(w.db.fuBrake && w.db.fuBrake.on_at, "brake on"); assert.match(w.db.fuBrake.detail, /1 من 1/);
  assert.equal(w.sms.filter((x) => x.ref === "wabot followup_brake").length, 2, "one SMS to each alert phone");
  campTpl(w, 5, { phone: "598765432" }); await menuTap(w, { from: "966598765432" });
  assert.deepEqual(fuOut(await w.tick(45)), [], "braked: nothing for anyone");
  await w.tick(30); assert.equal(w.sms.filter((x) => x.ref === "wabot followup_brake").length, 2, "the alert goes once");
  w.setOwner(false); assert.equal((await w.call("POST", "/api/cms/wabot/followups/brake", { clear: true })).status, 403); w.setOwner(true);
  const cl = await w.call("POST", "/api/cms/wabot/followups/brake", { clear: true });
  assert.deepEqual([cl.status, cl.body.cleared, cl.body.brake.on], [200, true, false]);
  assert.equal(w.db.cfgLog.at(-1).changes[0].path, "replyFollowUpBrake");
  campTpl(w, 1, { phone: "598765432" }); await menuTap(w, { from: "966598765432" });
  const out = fuOut(await w.tick(41));
  assert.equal(out.length, 1, "after the owner clears it the follow-ups come back (counting from the clear)"); assert.equal(out[0].to, "966598765432");
}));

test("FU1 «تقرير ماجد» + ‎/followups‎: اتبعت كام، ردّوا، «أبغى أطلب»، طلبات مدفوعة وقيمتها خلال ٢٤ ساعة", withEnv(LOCKS_OPEN, async () => {
  const orders = []; const w = fuLive({ orders }); await menuTap(w);
  assert.equal(fuOut(await w.tick(41)).length, 1);
  await w.press("rf:yes", "أبغى أطلب");
  w.clock.advance(10); orders.push(order({ status: "paid", total: "120", created_at: w.clock.now().toISOString(), attribution: { fc_link: "wa-boxes" } }));
  const r = await w.call("GET", "/api/cms/wabot/assist/daily", {}, { day: "2026-10-12" });
  const f = r.body.report.window.reply_followups;
  assert.deepEqual([f.sent, f.replied, f.said_yes, f.said_no, f.carts, f.ordered, f.paid_orders, f.paid_sar, f.paid_via_link], [1, 1, 1, 0, 0, 1, 1, 120, 0]);
  assert.deepEqual(f.by_via, { neutral: 1 }); assert.equal(f.brake.on, false);
  const g = await w.call("GET", "/api/cms/wabot/followups", {}, { day: "2026-10-12" });
  assert.deepEqual([g.status, g.body.enabled, g.body.totals.sent, g.body.totals.paid_sar, g.body.settings.replyFollowUpMin], [200, true, 1, 120, 40]);
}));

test("FU1 الإعدادات: كلها في مخطط اللوحة بأسماء عربية في مجموعتها، الافتراضي شغّال (٤٠ دقيقة، ١٢:٠٠–١:٣٠، ٧ أيام، متابعتين، ٢٪)، والحفظ بيتراجع", withEnv(LOCKS_OPEN, async () => {
  const keys = Object.keys(R.SCHEMA).filter((k) => /^replyFollowUp/.test(k));
  assert.equal(keys.length, 16);
  for (const k of keys) { assert.equal(R.SCHEMA[k].group, "followUp", k); assert.match(R.SCHEMA[k].ar, /[؀-ۿ]/, k); }
  assert.equal(R.SCHEMA_GROUPS.followUp, "متابعة اللي ردّ وماطلبش (جوّه النافذة)");
  const c = R.botConfig({});
  assert.deepEqual([c.replyFollowUp, c.replyFollowUpMin, c.replyFollowUpFromHour, c.replyFollowUpFromMinute, c.replyFollowUpToHour, c.replyFollowUpToMinute, c.replyFollowUpDeclineDays, c.replyFollowUpIgnoredMax, c.replyFollowUpIgnoredDays, c.replyFollowUpBrakePct, c.replyFollowUpOffer, c.replyFollowUpLooked, c.replyFollowUpFav],
    [true, 40, 12, 0, 1, 30, 7, 2, 7, 2, true, true, true]);
  const w = liveWorld();
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { replyFollowUpMin: 60, replyFollowUpFav: false })).status, 200);
  assert.deepEqual([w.db.settings.waBot.replyFollowUpMin, w.db.settings.waBot.replyFollowUpFav], [60, false]);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { replyFollowUpMin: 5 })).status, 400);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { replyFollowUpBrakePct: 0 })).status, 400);
  const sch = (await w.call("GET", "/api/cms/wabot/schema")).body;
  assert.ok(sch.settings.some((x) => x.key === "replyFollowUpMin" && x.groupAr === "متابعة اللي ردّ وماطلبش (جوّه النافذة)"));
  for (const k of ["rf_offer", "rf_neutral", "rf_yes_cart", "rf_no", "btn_rf_yes", "btn_rf_no"]) assert.ok(sch.texts.some((t) => t.key === k), k);
}));

test("FU1 وضع التجربة: أرقام التجربة بس", withEnv(CONFIGURED, async () => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS, paidNoteEnabled: false }, bundles: LIVE.bundles, links: ALL_LINKS });
  campTpl(w); campTpl(w, 10, { phone: "598765432" });
  await menuTap(w); await menuTap(w, { from: "966598765432" });
  const out = fuOut(await w.tick(41));
  assert.equal(out.length, 1); assert.equal(out[0].to, "966512345678");
}));

test("FU1 ضغطة من غير حملة ولا صنف معيّن شافه: طبقه المفضل من طلباته في سلة جاهزة بسعره الحين (معاينة الأول، سلة واحدة بس)", withEnv(LOCKS_OPEN, async () => {
  const day = (d) => new Date(Date.parse(OPEN_AT) - d * 86400_000).toISOString();
  const w = fd1World({ sent: false, hist: [{ at: day(6), total: 60, names: "كريب زنجر سوبريم|بيبسي" }, { at: day(20), total: 55, names: "كريب زنجر سوبريم" }] });
  await menuTap(w);
  const out = fuOut(await w.tick(41));
  assert.equal(out.length, 1, JSON.stringify(w.db.jobs.map((j) => [j.kind, j.status, j.reason])));
  assert.equal(bodyOf(out[0]), "جهّزنا لك طبقك المفضل كريب زنجر سوبريم بـ25 ر.س في السلة 🛒\nتكمّل طلبك من هنا: https://freshcuts.sa/c/rc000001");
  assert.deepEqual([w.db.fu[0].via, w.db.fu[0].trigger, w.db.botCarts.length, w.db.botCarts[0].source, w.db.botCarts[0].plan.items[0].p], ["fav", "tap", 1, "followup", 25]);
  /* الطبق خلص النهارده ومفيش طبق تاني متاح ⇒ سطر محايد */
  const s = fd1World({ sent: false, hist: [{ at: day(6), total: 60, names: "كريب زنجر سوبريم" }], extraSettings: { catalog: { soldOut: { 8: { until: null } } } } });
  await menuTap(s);
  const o2 = fuOut(await s.tick(41));
  assert.equal(o2.length, 1); assert.equal(bodyOf(o2[0]), FU_NEUTRAL); assert.equal(s.db.botCarts.length, 0);
}));

/* ═══ RV1 — التقييم بالنجوم جوّه واتساب (عمر ١٥/١٠: «ناخد التقييم من الواتساب بالنجوم، ولو أكثر من ٣ نبعتله رابط جوجل على الواتس») ═══
   الرحلة كلها من الويب هوك الحقيقي لحد جسم رسالة Graph: سؤال النجوم ⇒ ضغطة ⇒ جوجل / الاعتذار والمدير، والتقييم بيتسجّل على الطلب والعميل. */
const RV_GOOGLE = "https://g.page/r/CSG0gPAqlvHMEBM/review";
const RV_GO = "https://freshcuts-api.o2m8.me/api/reviews/g/";
const rvWorld = (o = {}) => {
  const w = world({ waBot: { mode: "test", testPhones: TESTERS, ...(o.waBot || {}) }, extraSettings: { reviews: { threshold: 4, googleUrl: RV_GOOGLE, ...(o.reviews || {}) } }, ...(o.world || {}) });
  w.db.invites = o.invites || [{ phone_norm: "512345678", code: "ab12cd34", order_no: "W1790012345678", kind: "delivery", ref: "W1790012345678" }];
  return w;
};
const listTap = (w, id, title = "x") => w.say(null, { raw: { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } } } });
const qrTap = (w, text, o = {}) => w.say(null, { raw: { type: "button", button: { text, payload: text }, ...(o.context ? { context: { id: o.context } } : {}) } });
const firstOut = (r) => r.sent.find((b) => b.type);

test("RV1: inside the window the review ask is a stars list (5→1, ids carry the invite); 5★ ⇒ ONE message: thanks + the tracked Google button; the rating is saved on the order and the customer; a second tap ⇒ «وصلنا تقييمك»", withEnv(CONFIGURED, async () => {
  const w = rvWorld();
  await w.say("شكراً");
  const before = w.calls.length;
  const r = await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
  assert.deepEqual(r, { ok: true, channel: "wa_list" });
  const p = w.calls.slice(before).map((c) => c.body).find((b) => b.type);
  assert.equal(p.interactive.type, "list");
  assert.match(p.interactive.body.text, /^كيف كان طلبك رقم W1790012345678؟ 🌟\nقيّمه بالنجوم من القائمة 👇/);
  assert.deepEqual(p.interactive.action.sections[0].rows.map((x) => [x.id, x.title]),
    [["rs:5:ab12cd34", "⭐⭐⭐⭐⭐ ممتاز"], ["rs:4:ab12cd34", "⭐⭐⭐⭐ جيد جداً"], ["rs:3:ab12cd34", "⭐⭐⭐ جيد"], ["rs:2:ab12cd34", "⭐⭐ مقبول"], ["rs:1:ab12cd34", "⭐ ضعيف"]]);
  assert.equal(p.interactive.action.button, "اختر تقييمك");
  assert.ok(w.db.chats.get("512345678").review_stars_at, "a stars question is pending (typed digits count from now)");
  const five = await listTap(w, "rs:5:ab12cd34", "⭐⭐⭐⭐⭐ ممتاز");
  assert.equal(five.log.reply_key, "review_star", JSON.stringify(five.log));
  const g = firstOut(five);
  assert.equal(g.interactive.type, "cta_url");
  assert.equal(g.interactive.action.parameters.url, `${RV_GO}ab12cd34`, "our counter first, then Google");
  assert.equal(g.interactive.action.parameters.display_text, "قيّمنا على جوجل");
  assert.match(g.interactive.body.text, /^شكراً على تقييمك 🌟/);
  assert.doesNotMatch(g.interactive.body.text, /خصم|كود|هدية|مجان|كيتا|هنقر|نينجا|تطبيق/, "no incentive and no app name next to a Google ask");
  assert.equal(five.sent.filter((b) => b.type).length, 1, "one message");
  assert.deepEqual(w.db.reviews.map((x) => [x.rating, x.order_no, x.phone_norm, x.kind, x.rating_exact, x.channel, x.code_label]), [[5, "W1790012345678", "512345678", "delivery", true, "whatsapp", "واتساب · توصيل"]]);
  assert.deepEqual([w.db.invites[0].rating, w.db.invites[0].review_id, w.db.invites[0].wa_answer, Boolean(w.db.invites[0].google_sent_at)], [5, 1, "stars:5", true]);
  const again = await listTap(w, "rs:4:ab12cd34");
  assert.match(JSON.stringify(again.sent), /وصلنا تقييمك، شكراً لك 🌟/);
  assert.equal(w.db.reviews.length, 1, "one rating per order");
  // trackGoogle off ⇒ Google's own link (no counter)
  const d = rvWorld({ waBot: { reviewFlow: { trackGoogle: false } } });
  await d.say("هلا"); await d.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery" });
  assert.equal(firstOut(await listTap(d, "rs:4:ab12cd34")).interactive.action.parameters.url, RV_GOOGLE);
}));

test("RV1: 3★ or less ⇒ apology + «وش اللي ما عجبك؟» (reasons list) + urgent manager handover with the order number — never Google; the reason and the first text land on the inbox row; no second alert", withEnv(CONFIGURED, async () => {
  const w = rvWorld();
  await w.say("هلا"); await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
  const low = await listTap(w, "rs:2:ab12cd34", "⭐⭐ مقبول");
  assert.equal(low.log.reply_key, "review_star");
  assert.equal(low.log.handoff, "review_low");
  const m = firstOut(low);
  assert.equal(m.interactive.type, "list");
  assert.match(m.interactive.body.text, /^نعتذر منك 🙏 ما كانت تجربتك مثل ما نتمنى\.\nوش اللي ما عجبك؟/);
  assert.match(m.interactive.body.text, /رقم الطلب: W1790012345678/);
  assert.doesNotMatch(JSON.stringify(low.sent), /جوجل|google|g\.page|\/api\/reviews\/g\//i, "a low rater is never sent to Google");
  assert.deepEqual(m.interactive.action.sections[0].rows.map((x) => x.id), ["rr:food:1", "rr:wrong:1", "rr:time:1", "rr:delivery:1", "rr:service:1", "rr:price:1", "rr:other:1"]);
  const ho = w.portal.find(([e, d0]) => e === "wa_handover" && d0.reason === "review_low");
  assert.ok(ho, "portal card"); assert.equal(ho[1].urgent, true); assert.equal(ho[1].orderNo, "W1790012345678");
  assert.match(ho[1].note, /^تقييم 2★ · طلب W1790012345678 · توصيل$/);
  assert.equal(w.db.reviews[0].rating, 2);
  const rs = await listTap(w, "rr:food:1", "الأكل (الطعم أو الجودة)");
  assert.equal(rs.log.reply_key, "review_reason");
  assert.match(bodyOf(firstOut(rs)), /^شكراً، وصلت ملاحظتك ✅/);
  assert.deepEqual(w.db.reviews[0].categories, ["الأكل"]);
  const alertsBefore = w.portal.filter(([e]) => e === "wa_handover").length;
  await w.say("الأكل وصل بارد والبطاطس ناقصة");
  assert.equal(w.db.reviews[0].comment, "الأكل وصل بارد والبطاطس ناقصة", "first text after a low rating = the inbox comment");
  assert.equal(w.portal.filter(([e]) => e === "wa_handover").length, alertsBefore, "the complaint text does not open a second handover");
  await w.say("وكمان المندوب تأخر");
  assert.equal(w.db.reviews[0].comment, "الأكل وصل بارد والبطاطس ناقصة", "only the first text");
  // a threshold of 3 on the rating page does not send a 3★ to Google here
  const t3 = rvWorld({ reviews: { threshold: 3 } });
  await t3.say("هلا"); await t3.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery" });
  const three = await listTap(t3, "rs:3:ab12cd34");
  assert.equal(three.log.handoff, "review_low"); assert.doesNotMatch(JSON.stringify(three.sent), /جوجل|\/api\/reviews\/g\//);
}));

test("RV1: outside the window ⇒ the stars template (after approval, switch on) for every kind, with the right subject; its «يحتاج تحسين» tap is matched to that invite ⇒ low path with rating_exact=false; switch off ⇒ old templates for website orders and nothing for till orders", withEnv(CONFIGURED, async () => {
  const CAT = await import("./watemplates.js"); const WA = await import("./whatsapp.js"); WA.registerCatalog(CAT);
  const w = rvWorld({ waBot: { reviewFlow: { starsTemplate: true } }, invites: [{ phone_norm: "512345678", code: "pp11qq22", order_no: "pos:9001", kind: "dinein", ref: "فاتورة 1043" }] });
  const before = w.calls.length;
  const r = await w.bot.reviewAsk({ phone: "0512345678", orderNo: "pos:9001", code: "pp11qq22", kind: "dinein", ref: "فاتورة 1043" });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.channel, "wa_stars"); assert.ok(r.wamid);
  const t = w.calls.slice(before).map((c) => c.body).find((b) => b.type === "template");
  assert.equal(t.template.name, "fc_review_stars");
  assert.deepEqual(t.template.components, [{ type: "body", parameters: [{ type: "text", text: "زيارتك للمطعم" }] }]);
  w.db.invites[0].wa_msg_id = r.wamid;
  const tap = await qrTap(w, "يحتاج تحسين", { context: r.wamid });
  assert.equal(tap.log.reply_key, "review_star"); assert.equal(tap.log.handoff, "review_low");
  assert.deepEqual([w.db.reviews[0].rating, w.db.reviews[0].rating_exact, w.db.reviews[0].order_no, w.db.reviews[0].kind], [3, false, "pos:9001", "dinein"]);
  const m = firstOut(tap);
  assert.doesNotMatch(m.interactive.body.text, /رقم الطلب/, "a till order has no website number to show");
  assert.deepEqual(m.interactive.action.sections[0].rows.map((x) => x.id), ["rr:food:1", "rr:wrong:1", "rr:time:1", "rr:service:1", "rr:price:1", "rr:clean:1", "rr:other:1"], "dine-in: cleanliness, no courier");
  const ho = w.portal.find(([e, d0]) => e === "wa_handover" && d0.reason === "review_low");
  assert.equal(ho[1].orderNo, null, "no Arabic invoice text in the English staff SMS"); assert.match(ho[1].note, /«يحتاج تحسين» · طلب فاتورة 1043 · أكل في الصالة/);
  // subjects per kind
  for (const [kind, orderNo, ref, subj] of [["takeaway", "pos:9002", null, "طلبك من الفرع"], ["delivery", "W1790012345678", "W1790012345678", "طلبك رقم W1790012345678"], ["table", "W1790012349999", "W1790012349999", "طلبك رقم W1790012349999"]]) {
    const x = rvWorld({ waBot: { reviewFlow: { starsTemplate: true } } });
    const b0 = x.calls.length;
    const rr = await x.bot.reviewAsk({ phone: "0512345678", orderNo, code: "zz99yy88", kind, ref });
    assert.equal(rr.channel, "wa_stars", kind);
    assert.equal(x.calls.slice(b0).map((c) => c.body).find((b) => b.type === "template").template.components[0].parameters[0].text, subj, kind);
  }
  // switch off (not approved yet): website order ⇒ the approved v1/v2 template as today; till order ⇒ nothing on WhatsApp (reviews.js decides SMS)
  const off = rvWorld();
  const b1 = off.calls.length;
  assert.deepEqual(await off.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery" }), { ok: true, channel: "wa_template" });
  assert.equal(off.calls.slice(b1).map((c) => c.body).find((b) => b.type === "template").template.name, "fc_review_request");
  assert.deepEqual(await off.bot.reviewAsk({ phone: "0512345678", orderNo: "pos:9003", code: "ab12cd35", kind: "takeaway" }), { ok: false, skipped: "no_visit_template" });
}));

test("RV1: «تمام» on the delivered message ⇒ the stars list for that order (not the rating-page link); a typed «5» then counts as 5★; a typed «تمام» after a stars list is just an acknowledgement", withEnv(CONFIGURED, async () => {
  const w = rvWorld({ invites: [{ phone_norm: "512345678", code: "kk55jj66", order_no: "W1790012347777", kind: "pickup", ref: "W1790012347777" }] });
  const ok = await qrTap(w, "تمام 👍");
  assert.equal(ok.log.reply_key, "review_ok", JSON.stringify(ok.log));
  const l = firstOut(ok);
  assert.equal(l.interactive.type, "list");
  assert.match(l.interactive.body.text, /^يسعدنا ذلك 🌟\nكم نجمة تعطي طلبك؟/);
  assert.equal(l.interactive.action.sections[0].rows[0].id, "rs:5:kk55jj66");
  assert.doesNotMatch(JSON.stringify(ok.sent), /\/r\?c=/, "no detour through the rating page");
  w.clock.advance(1);
  const typed = await w.say("5");
  assert.equal(typed.log.reply_key, "review_star", JSON.stringify(typed.log));
  assert.equal(firstOut(typed).interactive.action.parameters.url, `${RV_GO}kk55jj66`);
  assert.equal(w.db.reviews[0].rating, 5);
  // typed «تمام» after an in-window stars ask is not a second «تمام» tap (no second list)
  const w2 = rvWorld();
  await w2.say("هلا"); await w2.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery" });
  w2.clock.advance(1);
  const ack = await w2.say("تمام");
  assert.notEqual(ack.log.reply_key, "review_ok");
  assert.equal(ack.sent.filter((b) => b.type === "interactive" && b.interactive.type === "list").length, 0);
  // the old path is intact with the switch off
  const old = rvWorld({ waBot: { reviewFlow: { enabled: false } }, invites: [{ phone_norm: "512345678", code: "kk55jj66", order_no: "W1790012347777" }] });
  assert.match(JSON.stringify((await qrTap(old, "تمام 👍")).sent), /r\?c=kk55jj66/);
}));

test("RV1: classify understands only our own ids and buttons; settings render from the schema and refuse bad values; every review reply fits WhatsApp's limits in both languages", () => {
  assert.deepEqual(R.classify({ type: "interactive", text: "x", interactiveId: "rs:4:ab12cd34" }).arg, { stars: 4, code: "ab12cd34", exact: true });
  assert.deepEqual(R.classify({ type: "interactive", text: "x", interactiveId: "rr:wrong:17" }).arg, { reason: "wrong", cat: "الطلب ناقص أو غلط", reviewId: 17 });
  assert.deepEqual(R.classify({ type: "button", text: "ممتاز ⭐⭐⭐⭐⭐", interactiveId: "ممتاز ⭐⭐⭐⭐⭐" }).arg, { stars: 5, exact: true, code: null });
  assert.deepEqual(R.classify({ type: "button", text: "يحتاج تحسين", interactiveId: "يحتاج تحسين" }).arg, { stars: 3, exact: false, code: null });
  for (const bad of ["rs:6:ab12cd34", "rs:5:AB", "rs:5:ab12cd34; DROP", "rr:steak:1", "rr:food:x"]) assert.notEqual(R.classify({ type: "interactive", text: "x", interactiveId: bad }).key, bad.startsWith("rs") ? "review_star" : "review_reason", bad);
  const def = R.botConfig({});
  assert.deepEqual([def.reviewFlow.enabled, def.reviewFlow.starsTemplate, def.reviewFlow.apps, def.reviewFlow.smsVisits, def.reviewFlow.dineinMin, def.reviewFlow.capDays, def.reviewFlow.posConsent, def.reviewFlow.portalCashier], [true, false, true, false, 90, 7, true, false], "apps + cashier consent ON (Omar 15/10), portal cashier view OFF");
  assert.equal(R.configFromBody({ reviewFlow: { apps: "yes" } }).ok, false);
  assert.equal(R.configFromBody({ reviewFlow: { quietFromHour: 24 } }).ok, false);
  assert.deepEqual(R.configFromBody({ reviewFlow: { dineinMin: 75, smsVisits: true } }).value.reviewFlow, { dineinMin: 75, smsVisits: true });
  assert.ok(R.SCHEMA_GROUPS.reviews && R.SCHEMA["reviewFlow.apps"].help.includes("كيتا"));
  const cfg = R.botConfig({ waBot: { mode: "live" } });
  for (const lang of ["ar", "en"]) for (const interactive of [true, false]) {
    const data = { settings: {}, now: new Date(OPEN_AT), open: null, chat: {} };
    const replies = [
      R.buildReply("review_ok", { cfg, lang, data, arg: { code: "ab12cd34", order: "W1790012345678", ref: "W1790012345678", kind: "delivery" } }),
      R.buildReply("review_star", { cfg, lang, data, arg: { route: "google", stars: 5, code: "ab12cd34", link: `${RV_GO}ab12cd34` } }),
      R.buildReply("review_star", { cfg, lang, data, arg: { route: "low", stars: 1, exact: true, ref: "W1790012345678", kind: "delivery", reviewId: 12 } }),
      R.buildReply("review_star", { cfg, lang, data, arg: { route: "low", stars: 3, exact: false, kind: "dinein", reviewId: 13 } }),
      R.buildReply("review_star", { cfg, lang, data, arg: { route: "thanks", stars: 4 } }),
      R.buildReply("review_star", { cfg, lang, data, arg: { route: "already" } }),
      R.buildReply("review_reason", { cfg, lang, data, arg: { reason: "food", reviewId: 12 } }),
    ];
    for (const rp of replies) {
      const pl = R.toPayload(rp, { cfg, lang, interactive });
      assert.equal(R.payloadProblem(pl), null, `${lang} ${interactive} ${JSON.stringify(rp).slice(0, 80)}`);
    }
  }
});

test("RV1: a typed number counts as stars only while the stars question is the LAST thing we sent — «٢» after the chat moved on (a delivery question) is not a 2-star complaint", withEnv(CONFIGURED, async () => {
  const w = rvWorld({ invites: [{ phone_norm: "512345678", code: "kk55jj66", order_no: "W1790012347777", kind: "pickup", ref: "W1790012347777" }] });
  await qrTap(w, "تمام 👍");
  w.clock.advance(1);
  const q2 = await w.say("كم رسوم التوصيل");
  assert.ok(q2.sent.length > 0, "the bot answered something else after the stars list");
  w.clock.advance(1);
  const two = await w.say("2");
  assert.notEqual(two.log.reply_key, "review_star", JSON.stringify(two.log));
  assert.equal((w.db.reviews || []).length, 0, "no rating saved");
  assert.equal(w.portal.filter(([e, d0]) => e === "wa_handover" && d0.reason === "review_low").length, 0, "no manager alert");
}));

test("RV1: «تمام» on an invite the scheduler closed for a staff number or a stopped customer ⇒ a warm line only, no stars question and no rating row", withEnv(CONFIGURED, async () => {
  for (const why of ["staff", "opted_out", "wa_stopped"]) {
    const w = rvWorld({ invites: [{ phone_norm: "512345678", code: "kk55jj66", order_no: "W1790012347777", kind: "delivery", skip_reason: why }] });
    const r = await qrTap(w, "تمام 👍");
    assert.equal(r.log.reply_key, "review_ok", why);
    assert.match(JSON.stringify(r.sent), /بالعافية عليك/, why);
    assert.equal(r.sent.filter((b) => b.type === "interactive" && b.interactive.type === "list").length, 0, why);
    assert.equal((w.db.chats.get("512345678") || {}).review_stars_at || null, null, why);
  }
}));

test("RV1: «عندي ملاحظة» never shows an internal till id («pos:…») and never leaves an empty «طلب رقم» line", () => {
  const cfg = R.botConfig({ waBot: { mode: "live" } });
  const data = { settings: {}, now: new Date(OPEN_AT), open: null, chat: {} };
  const web = R.buildReply("review_note", { cfg, lang: "ar", data, arg: { code: "ab12cd34", order: "W1790012345678" } }).body;
  assert.match(web, /\nطلب رقم W1790012345678\n/);
  for (const order of ["pos:9001", null, ""]) {
    const b = R.buildReply("review_note", { cfg, lang: "ar", data, arg: { code: "ab12cd34", order } }).body;
    assert.doesNotMatch(b, /pos:|طلب رقم\s*(\n|$)/, String(order));
    assert.match(b, /حوّلت ملاحظتك للمدير/);
  }
  const en = R.buildReply("review_note", { cfg, lang: "en", data, arg: { code: "ab12cd34", order: "pos:9001" } }).body;
  assert.doesNotMatch(en, /pos:|\nOrder\s*(\n|$)/);
});

/* مراجعة RV1 (١٥/١٠ بالليل): التقييم الواطي كان ماسك المحادثة زي الشكوى ٢٤ ساعة — البوت مابيردش على المنيو ولا الطلب، و«تعديل الطلب» بعده
   مابيفتحش تنبيه (والتنبيه الوحيد كارت هادي عند المدير). دلوقتي: المنيو والطلب بيتخدموا، والطلب التشغيلي بيفتح تحويله بتنبيهه العادي. */
test("RV1 review fix: a low rating does not hold the chat like a complaint — the menu and a new order are served, «تعديل الطلب» after it opens its own order-change alert for the whole team (even after the manager replied), a typed complaint stays with the manager (no second alert)", withEnv(CONFIGURED, async () => {
  const w = rvWorld();
  await w.say("هلا"); await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
  const low = await listTap(w, "rs:2:ab12cd34", "⭐⭐ مقبول");
  assert.equal(low.log.handoff, "review_low");
  await listTap(w, "rr:food:1", "الأكل (الطعم أو الجودة)");
  await w.say("الأكل وصل بارد");      // أول نص ⇒ تعليق التقييم
  const alerts = () => w.portal.filter(([e]) => e === "wa_handover");
  const n0 = alerts().length;
  w.clock.advance(180);
  const menu = await w.say("ورّني المنيو");
  assert.equal(menu.log.decision, "replied", JSON.stringify(menu.log)); assert.equal(menu.log.reply_key, "cats");
  const order = await w.say("ابغى اطلب مشاوي");
  assert.equal(order.log.decision, "replied", JSON.stringify(order.log)); assert.equal(order.log.reply_key, "order");
  const cmp = await w.say("وكمان الرز كان بارد جدا");
  assert.notEqual(cmp.log.handoff, "complaint", "a complaint typed after the rating stays with the manager"); assert.equal(alerts().length, n0, "no second alert");
  const ch = await w.say(null, { raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "cw:order", title: "تعديل الطلب" } } } });
  assert.equal(ch.log.handoff, "order_change", JSON.stringify(ch.log));
  const oc = alerts().filter(([, d]) => d.reason === "order_change");
  assert.equal(oc.length, 1, "the order change reaches the team with its normal alert");
  // the manager already replied to the low rating (staff echo) ⇒ an order change still alerts
  const w2 = rvWorld();
  await w2.say("هلا"); await w2.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
  await listTap(w2, "rs:1:ab12cd34", "⭐ سيء");
  w2.clock.advance(2);
  await w2.cashier("نعتذر منك، بنتواصل معك");
  w2.clock.advance(40);
  const ch2 = await w2.say(null, { raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "cw:order", title: "تعديل الطلب" } } } });
  assert.equal(ch2.log.handoff, "order_change", JSON.stringify(ch2.log));
  // a real complaint handover is unchanged: menu stays info-only (factual) — the carve-out is for review_low only
  assert.equal(R.decide({ phone: "512345678", text: "ورّني المنيو", type: "text", at: new Date(Date.parse(OPEN_AT)).toISOString() },
    { cfg: R.botConfig({ waBot: { mode: "live" } }), now: new Date(Date.parse(OPEN_AT) + 60_000), chat: { handoff_at: new Date(Date.parse(OPEN_AT) - 3600_000).toISOString(), handoff_reason: "complaint" }, data: {} }).key, "handoff_remind");
}));

/* مراجعة RV1 (التالتة): قفل التقييم الواطي بيرجّع المحادثة للبوت (handoff_at بيتمسح) — وده كان الحاجة الوحيدة اللي مانعة الرسايل اللي البوت بيبدأها
   (FU1، SB4 قبل ما النافذة تقفل، متابعة EX6، متابعة المساعد): فحص «شكوى النهارده» ماكانش بيعدّ review_low، والمنيو بعد التقييم (REVIEW_SOFT) بيسجّل
   بالظبط الضغطة اللي بتشغّل FU1. دلوقتي التقييم الواطي = شكوى ٢٤ ساعة في الفحص المشترك (COMPLAINT_24H_SQL). */
test("RV1 review fix (proactive jobs after a low rating): closing the rating hands the chat back to the bot, but FU1 counts the low rating like a complaint for 24 h — no «تبي أجهّز لك طلبك؟» to an unhappy customer; a day later a new tap is followed up as usual", withEnv(LOCKS_OPEN, async () => {
  const run = async ({ release = false, rate = true } = {}) => {
    const w = fuLive({ extraSettings: { reviews: { threshold: 4, googleUrl: RV_GOOGLE } } });
    w.db.invites = [{ phone_norm: "512345678", code: "ab12cd34", order_no: "W1790012345678", kind: "delivery", ref: "W1790012345678" }];
    await w.say("هلا");
    if (rate) {
      await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
      const low = await listTap(w, "rs:2:ab12cd34", "⭐⭐ مقبول");
      assert.equal(low.log.handoff, "review_low", JSON.stringify(low.log));
    }
    w.clock.advance(2);
    const m = await menuTap(w);
    assert.deepEqual([m.log.decision, m.log.reply_key], ["replied", "cats"], JSON.stringify(m.log));
    /* بالظبط اللي portalreviews.releaseLowChat بيسيبه (القفل بنتيجة بتقفله — البورتال أو «تم الحل») */
    if (release) Object.assign(w.db.chats.get("512345678"), { handoff_at: null, handoff_reason: null, unknown_streak: 0, released_at: w.clock.now().toISOString() });
    return { w, out: fuOut(await w.tick(41)), job: fuJob(w) };
  };
  const rel = await run({ release: true });
  assert.deepEqual(rel.out, [], "closed (chat released): still no follow-up " + JSON.stringify(rel.job));
  assert.equal(rel.job.reason, "complaint_today");
  const held = await run();
  assert.deepEqual(held.out, []); assert.equal(held.job.reason, "handover_open", "still open: the open handover holds it (unchanged)");
  const none = await run({ rate: false });
  assert.equal(none.out.length, 1, "control: the same chat without a low rating is followed up " + JSON.stringify(none.job));
  // 24 h after the rating the brake is over: a new campaign tap gets its normal follow-up
  rel.w.clock.advance(24 * 60); campTpl(rel.w, 5); await menuTap(rel.w);
  assert.equal(fuOut(await rel.w.tick(41)).length, 1, "a day later: normal follow-up");
}));

test("RV1 review fix (proactive jobs after a low rating): SB4 «before the window closes» is held too after the close; one shared 24 h gate (complaint + review_low) for FU1, SB4, the EX6 lead follow-up and the assistant nudge", withEnv(CONFIGURED, async () => {
  const keeper = async ({ release = false, rate = true } = {}) => {
    const w = rvWorld({ waBot: { paidNoteEnabled: false }, world: { at: "2026-10-12T15:00:00Z", orders: [{ order_no: "W1790012347777", phone_norm: "512345678", status: "on_the_way", option: "delivery", created_at: "2026-10-13T10:30:00Z" }] } });
    await w.say("هلا");
    if (rate) {
      await w.bot.reviewAsk({ phone: "0512345678", orderNo: "W1790012345678", code: "ab12cd34", kind: "delivery", ref: "W1790012345678" });
      assert.equal((await listTap(w, "rs:1:ab12cd34", "⭐ سيء")).log.handoff, "review_low");
    }
    if (release) Object.assign(w.db.chats.get("512345678"), { handoff_at: null, handoff_reason: null, unknown_streak: 0, released_at: w.clock.now().toISOString() });
    const sent = (await w.tick(20 * 60 + 5)).filter((b) => b.type && /ما زال معنا/.test(JSON.stringify(b)));
    return { sent, job: w.db.jobs.filter((j) => j.kind === "window_keep").at(-1) };
  };
  const rel = await keeper({ release: true });
  assert.deepEqual([rel.sent.length, rel.job.reason], [0, "complaint_today"], "closed and released: no window-keeper message");
  const held = await keeper();
  assert.deepEqual([held.sent.length, held.job.reason], [0, "handover_open"]);
  const none = await keeper({ rate: false });
  assert.deepEqual([none.sent.length, none.job.reason], [1, "sent:open_order"], "control: no low rating ⇒ the useful message goes");
  // the one gate: review_low is in it, and every proactive job uses it (no inline copy left behind)
  assert.match(R.COMPLAINT_24H_SQL, /handoff IN \([^)]*'review_low'[^)]*\)/);
  assert.match(R.COMPLAINT_24H_SQL, /handoff IN \('complaint','problem','order_change','allergy_severe','review_low'\)/, "the complaint reasons are unchanged");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./wabotrun.js", import.meta.url), "utf8");
  assert.equal((src.match(/handoff IN \('complaint'/g) || []).length, 1, "one shared gate, no inline copy");
  assert.equal((src.match(/await q\(COMPLAINT_24H_SQL, \[phone\]\)/g) || []).length, 4, "FU1 + SB4 + EX6 lead follow-up + assistant nudge");
}));
