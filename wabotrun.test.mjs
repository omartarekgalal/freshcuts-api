/* ════════════════════════════════════════════════════════════════════════════
   اختبارات بوت واتساب v1 (wabotrun.js) — ١٢/١٠/٢٠٢٦
   المحادثات هنا بتعدّي من الويب هوك الحقيقي (whatsapp.processWebhook) لحد طلب Graph نفسه (fetch مزيّف)،
   فالتأكيد على **جسم الرسالة الخارجة بالظبط**، وعلى إن مفيش ولا طلب شبكة لما المفروض نسكت.
     node --test wabotrun.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const R = await import("./wabotrun.js");

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
const FOOTER = "رد آلي · للموظف اكتب: موظف";
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
  at = OPEN_AT, graph = null, failDb = null, extraSettings = {}, disclosure = false } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; }, set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { msgs: [], log: [], jobs: [], chats: new Map(), optouts: [], optins: {}, links: links.map((s) => ({ slug: s, active: true, clicks: 0 })), settings: null };
  db.settings = { hours: HOURS, notifications, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: FAQ } },
    cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 } }, delivery: { alertPhones: ["0544775082", "0506338246"], staffSmsLanguage: "en" }, waBot, ...extraSettings };
  const iso = () => new Date(nowMs).toISOString();
  const chat = (p) => { if (!db.chats.has(p)) db.chats.set(p, { phone_norm: p, unknown_streak: 0, ...(disclosure ? {} : { last_disclosed_at: iso() }) }); return db.chats.get(p); };
  const pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (failDb && failDb.test(s)) throw new Error("db down");
      if (/^CREATE TABLE|^DELETE FROM wa_bot_log|wa_webhook_health|wa_contact_names|wa_threads/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO cms_links/i.test(s)) { if (!db.links.find((l) => l.slug === p[0])) db.links.push({ slug: p[0], active: true, clicks: 0, seeded: true }); return { rows: [] }; }
      if (/FROM cms_links WHERE slug = ANY/i.test(s)) return { rows: db.links.filter((l) => p[0].includes(l.slug) && l.active) };
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
      if (/^INSERT INTO wa_optins/i.test(s)) { const cur = db.optins[p[0]] || {}; db.optins[p[0]] = { updates: p[1] ?? cur.updates ?? false, marketing: p[2] ?? cur.marketing ?? false }; return { rows: [] }; }
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
        Object.assign(l, { decision: p[1], reason: p[2], detail: p[3], reply_key: p[4] || l.reply_key, replies: p[5] ? JSON.parse(p[5]) : null, sent: p[6], error: p[7], handoff: p[8], alert: p[9], link_slug: p[10], resume_at: p[11] || null });
        return { rows: [], rowCount: 1 };
      }
      if (/count\(\*\) FILTER \(WHERE decision IN \('replied','dry'\) AND at > NOW\(\) - INTERVAL '1 hour'\)/i.test(s)) {
        const rows = db.log.filter((l) => l.phone_norm === p[0] && ["replied", "dry"].includes(l.decision) && nowMs - Date.parse(l.at) < 3600_000);
        const same = rows.filter((l) => l.reply_key === p[1]).map((l) => l.at).sort().pop() || null;
        const failed = db.log.filter((l) => l.phone_norm === p[0] && l.decision === "failed" && !/^skipped:/.test(l.error || "") && nowMs - Date.parse(l.at) < 600_000).map((l) => l.at).sort().pop() || null;
        return { rows: [{ n: rows.length, same_at: same, failed_at: failed }] };
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
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""), isOwner: () => owner };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const sms = [];
  const bot = R.register(app, ctx, { app, wa, now: clock.now, noTimer: true, sendSms: async (x) => { sms.push(x); return { ok: true }; } });
  let seq = 0;
  const hook = (field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: BIZ, phone_number_id: "PHONE1" }, ...value } }] }] });
  const ts = (agoMin = 0) => String(Math.floor((nowMs - agoMin * 60_000) / 1000));
  async function say(text, { from = "966512345678", id = null, type = "text", referral = null, agoMin = 0, raw = null } = {}) {
    const wamid = id || `wamid.IN${++seq}`;
    const msg = raw ? { from, id: wamid, timestamp: ts(agoMin), ...raw } : { from, id: wamid, timestamp: ts(agoMin), type, text: { body: text }, ...(referral ? { referral } : {}) };
    const before = calls.length;
    await wa.processWebhook(hook("messages", { messages: [msg] }));
    return { wamid, sent: calls.slice(before).map((c) => c.body), log: db.log.find((l) => l.wamid === wamid) || null };
  }
  const press = (buttonId, title, o = {}) => say(null, { ...o, raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title } } } });
  const cashier = (text, to = "966512345678") => wa.processWebhook(hook("smb_message_echoes", { message_echoes: [{ from: BIZ, to, id: `wamid.ECHO${++seq}`, timestamp: ts(), type: "text", text: { body: text } }] }));
  const call = async (method, path, json = {}, query = {}) => routes[`${method} ${path}`]({ req: { json: async () => json, query: (k) => query[k], header: () => undefined, text: async () => "" }, json: (body, status = 200) => ({ body, status }) });
  /* وقت الرد المؤجّل: نقدّم الساعة ونشغّل دورة الردود المؤجّلة؛ بيرجّع اللي اتبعت فيها */
  const tick = async (min = 0) => { clock.advance(min); const before = calls.length; await bot.runDueJobs(); return calls.slice(before).map((c) => c.body); };
  return { db, clock, calls, sms, say, press, cashier, call, wa, bot, tick, setOwner: (v) => { owner = v; }, setMode: (m) => { db.settings.waBot = { ...db.settings.waBot, mode: m }; } };
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
test("conversation: greeting → order → delivery → hours → location → payment → thanks (exact payloads)", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const g = await w.say("السلام عليكم");
  assert.deepEqual(g.sent, [cta(ME, `حيّاك الله في فريش كاتس 👋\n${BOXES}\n${FIRST_LINE}`, "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  assert.equal(w.calls[0].url, "https://graph.facebook.com/v23.0/PHONE1/messages");
  w.clock.advance(1);
  const again = await w.say("هلا");
  assert.equal(again.sent.length, 0); assert.equal(again.log.reason, "already_greeted");
  w.clock.advance(1);
  assert.deepEqual((await w.say("ابي اطلب")).sent, [cta(ME, `الطلب من موقعنا يأخذ دقيقة 👇\nاختر طلبك، حدّد موقعك على الخريطة وادفع إلكترونياً، ونبلّغك بكل تحديث.\n${FIRST_LINE}`, "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("كم رسوم التوصيل؟")).sent, [cta(ME,
    `🛵 نوصّل لمسافة 10 كم من فرعنا في حي السلامة بجدة.\nومن 10 إلى 15 كم برسوم مسافة إضافية 3 ر.س لكل كم.\nرسوم التوصيل حسب قيمة الطلب:\n• أقل من 60 ر.س: 20 ر.س\n• من 60 ر.س: 15 ر.س\n• من 80 ر.س: 10 ر.س\n• من 100 ر.س: 5 ر.س\n• من 150 ر.س: مجاني\n${FIRST_LINE}\nحدّد موقعك على الخريطة في صفحة الطلب وتظهر لك الرسوم قبل الدفع.`,
    "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("متى تقفلون")).sent, [txt(ME, "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🟢 مفتوحين الحين لين 2 فجراً.")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("وين موقعكم")).sent, [cta(ME, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.", "افتح الخريطة", "https://maps.google.com/?cid=14767749764292326433")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("تقبلون كاش؟")).sent, [txt(ME, "💳 الدفع الإلكتروني عبر Apple Pay وmada والبطاقات الائتمانية وSTC Pay.")]);
  w.clock.advance(1);
  assert.deepEqual((await w.say("يعطيك العافية")).sent, [txt(ME, "العفو، حيّاك الله 🌟")]);
  assert.equal(w.sms.length, 0, "no handover in a normal conversation");
  assert.ok(w.db.msgs.filter((m) => m.source === "bot").length === 7, "every bot reply is in the chat history the cashier sees");
}));

test("menu and offers answers carry the live box prices, and an English customer gets English", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  assert.deepEqual((await w.say("ممكن المنيو")).sent, [cta(ME, `${BOXES}\nوالمنيو كامل بالصور والأسعار في موقعنا 👇`, "شوف المنيو", "https://freshcuts.sa/l/wab-boxes")]);
  w.clock.advance(3);
  assert.deepEqual((await w.say("عندكم عروض؟")).sent, [cta(ME, `${FIRST_LINE}\n⭐ وكل 3 طلبات من الموقع لك توصيل مجاني على طلب من 60 ر.س وأكثر.\n${BOXES}`, "اطلب الآن", "https://freshcuts.sa/l/wab-boxes")]);
  const e = await w.say("hello, do you deliver?", { from: "966598765432" });
  assert.equal(e.log.lang, "en");
  assert.match(e.sent[0].interactive.body.text, /^🛵 We deliver up to 10 km from our branch in Al Salamah, Jeddah\.\nFrom 10 to 15 km there is an extra distance charge of SAR 3 per km\.\nDelivery fee by order total:\n• under SAR 60: SAR 20\n• SAR 60\+: SAR 15/);
  assert.equal(e.sent[0].interactive.action.parameters.display_text, "Order now");
  assert.equal(e.sent[0].interactive.footer.text, "Automated reply · type: staff");
  // a price change in the dashboard shows up in the next answer (no number lives in the code)
  const w2 = world({ waBot: { mode: "live" }, bundles: [{ price: 31, section: "بوكسات فردية" }], first: { ...FIRST, min_total: "75" } });
  assert.equal((await w2.say("المنيو")).sent[0].interactive.body.text, "🎁 بوكساتنا:\n• بوكسات فردية من 31 ر.س\nوالمنيو كامل بالصور والأسعار في موقعنا 👇");
  w2.clock.advance(3);
  assert.match((await w2.say("ابي اطلب")).sent[0].interactive.body.text, /للطلبات من 75 ر\.س وأكثر/);
}));

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
test("idempotency: Meta re-delivers the same webhook — one reply, one log row", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  for (let i = 0; i < 4; i++) await w.say("السلام عليكم", { id: "wamid.SAME" });
  assert.equal(w.calls.length, 1); assert.equal(w.db.log.length, 1);
  // even if the first dedupe layer (wa_messages) is bypassed, the bot's own claim on the wamid holds
  const ev = { phone: "512345678", wamid: "wamid.SAME", text: "السلام عليكم", type: "text", at: w.clock.now().toISOString(), isEcho: false, intent: null };
  assert.equal(await w.bot.handle(ev), true);
  assert.equal(w.calls.length, 1);
}));

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
  assert.equal(h.sent[0].text.body, "أبشر 🙏 حوّلت محادثتك لموظف.\nالمطعم مقفل الحين، والرد يوصلك أول ما نفتح اليوم الساعة 12 ظهراً.");
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

test("media: voice notes / photos go to a human; reactions and stickers are ignored; a caption is read", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const v = await w.say(null, { raw: { type: "audio", audio: { id: "A1", voice: true } } });
  assert.deepEqual(v.sent, [txt(ME, "ما أقدر أفتح الصور والمقاطع الصوتية 🙏 حوّلت محادثتك لموظف.\nيرد عليك هنا في أقرب وقت.")]); assert.equal(v.log.handoff, "media");
  const w2 = world({ waBot: { mode: "live" } });
  const re = await w2.say(null, { raw: { type: "reaction", reaction: { message_id: "x", emoji: "👍" } } });
  assert.equal(re.sent.length, 0); assert.equal(re.log.reason, "ignored_type");
  assert.equal((await w2.say(null, { raw: { type: "sticker", sticker: { id: "S" } } })).log.reason, "ignored_type");
  const cap = await w2.say(null, { from: "966577777777", raw: { type: "image", image: { id: "I", caption: "الطلب وصل ناقص" } } });
  assert.equal(cap.log.reply_key, "complaint");
  const loc = await w2.say(null, { from: "966598765432", raw: { type: "location", location: { latitude: 21.58, longitude: 39.15 } } });
  assert.equal(loc.log.reply_key, "media");
}));

/* ── ١٠) النوايا: صياغات ولهجات وأخطاء إملائية ──────────────────────────── */
test("intent detection across Saudi/Gulf, Egyptian, fusha, English, franco and typos", () => {
  const T = {
    greet: ["السلام عليكم", "سلام عليكم ورحمة الله", "هلا والله", "مرحبا", "مساء الخير", "صباح الخير", "hi", "Hello", "hey", "salam", "هااااي", "يا هلا"],
    menu: ["المنيو", "ممكن المنيو لو سمحت", "وش عندكم", "ايش عندكم", "عندكم ايه", "ارسل المنيو", "menu please", "send me the menu", "el menu law sama7t", "بكم الكفتة", "كم سعر البرجر", "بكام الحواوشي", "اسعاركم", "عندكو ايه", "عايز اكل", "how much is the pizza", "وش تنصحني", "ايش الاكثر طلب", "what do you recommend", "قائمة الطعام"],
    order: ["ابي اطلب", "ابغى اطلب", "عايز اطلب", "عاوز اطلب", "اريد اطلب", "كيف اطلب", "رابط الطلب", "ارسل اللينك", "i want to order", "how can i order", "abi atlob", "3ayez atlob", "ابي استلم من الفرع", "عندكم سفري؟", "اطلب اونلاين"],
    offers: ["عندكم عروض؟", "فيه عروض", "عروض اليوم", "وش العروض", "any offers?", "discount", "في كود خصم؟", "كوبون", "deals today", "فيه خصم"],
    delivery: ["توصيل؟", "عندكم توصيل", "توصلون حي الصفا؟", "هل توصلون لحي النزهة", "do you deliver to al rawdah", "كم رسوم التوصيل", "التوصيل بكم", "سعر التوصيل", "is delivery free", "التوصيل مجاني؟", "الحد الادنى للطلب", "كم ياخذ التوصيل", "delivery fee?", "twseel", "مناطق التوصيل", "بكام التوصيل"],
    hours: ["متى تفتحون", "متى تقفلون", "مواعيد الدوام", "ساعات العمل", "مفتوحين؟", "فاتحين الحين", "are you open now", "opening hours", "what time do you close", "شغالين الحين", "لسه فاتحين؟", "لين متى فاتحين", "ذكرني لما تفتحون", "مواعيدكم في رمضان"],
    location: ["وين موقعكم", "وين المطعم", "فين المطعم", "ارسل اللوكيشن", "العنوان", "location", "where are you located", "address?", "عندكم فروع؟", "كيف اوصلكم", "ابي الموقع على الخريطة"],
    payment: ["طرق الدفع", "اقدر ادفع كاش؟", "الدفع عند الاستلام؟", "تقبلون مدى", "apple pay?", "cash on delivery", "payment methods", "stc pay متوفر"],
    status: ["وين طلبي", "وين الطلب", "فين طلبي", "متى يوصل طلبي", "حالة الطلب", "تتبع الطلب", "where is my order", "track my order", "wen talabi", "طلبي W1790012345678", "وين المندوب", "فين الاوردر"],
    complaint: ["الاكل وصل بارد", "الطلب ناقص", "جاني طلب غلط", "طلبي متأخر ساعة", "the food was cold", "missing item", "الاكل محروق", "عندي شكوى", "تجربة سيئة", "ابي استرجاع المبلغ", "رجعوا فلوسي", "refund please"],
    problem: ["ما قدرت ادفع", "انخصم المبلغ وما وصل تاكيد", "payment failed", "charged twice", "الموقع ما يفتح", "website not working", "الكود ما يشتغل", "كود FIRST مرفوض"],
    change: ["ابي الغي الطلب", "كنسل الطلب", "cancel my order", "ابي اعدل الطلب", "نسيت اضيف بيبسي", "ابي اغير العنوان", "wrong address", "بدون بصل لو سمحت"],
    human: ["موظف", "ابي اكلم موظف", "كلموني", "خدمة العملاء", "talk to a human", "customer service", "ابي المدير", "محد يرد", "call me", "agent", "رقمكم"],
    thanks: ["شكرا", "مشكور", "يعطيك العافية", "thanks", "thank you", "تسلم", "مع السلامة", "bye"],
    stop: ["لا ترسلون لي", "الغاء الاشتراك", "unsubscribe", "وقفوا الرسايل", "احذفوا رقمي"],
    unknown: ["asdkjh", "؟؟", "١٢٣", "zzz", "......"],
    staff: ["فيه وظايف؟", "ابي احجز طاولة", "عندي حساسية من المكسرات", "ابي فاتورة ضريبية", "نبي نتعاون معكم", "فيه مواقف؟", "عندكم جلسات؟"],
  };
  const wrong = [];
  let n = 0;
  for (const [key, phrases] of Object.entries(T)) for (const p of phrases) { n++; const c = R.classify({ text: p, type: "text" }); if (c.key !== key) wrong.push(`«${p}» → ${c.key} (${c.rawIntent}), expected ${key}`); }
  assert.deepEqual(wrong, [], `${wrong.length}/${n} misclassified`);
  assert.ok(n >= 170);
  // whatsapp.js already recognised the opt-out keyword
  assert.equal(R.classify({ text: "إيقاف", type: "text", intent: "stop" }).key, "stop");
  assert.equal(R.classify({ text: "[صورة]", type: "image" }).key, "media");
  assert.equal(R.classify({ text: "[تفاعل 👍]", type: "reaction" }).key, null);
  // every wabot intent maps to a v1 key or to staff — none is left to chance
  for (const k of Object.values(R.INTENT_MAP)) assert.ok(R.REPLY_KEYS.includes(k), k);
});

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
  assert.deepEqual([c.humanPauseMin, c.maxRepliesPerHour, c.maxAgeMinutes, c.staffWaitMin, c.unknownWaitMin], [1, 30, 1, 15, 0]);

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
const SOON = "\nيرد عليك هنا في أقرب وقت.";
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
test("rule 4b: with an open complaint the bot answers facts only — no order link, no first-order line, no second alert", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, at: CLOSED_AT, orders: [order({ status: "delivered" })] });
  const c = await w.say("الطلب وصل بارد وناقص");
  assert.deepEqual(c.sent, [txt(ME, "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nطلبك رقم W1790011111111 قدّامنا.\nالمطعم مقفل الحين، والرد يوصلك أول ما نفتح اليوم الساعة 12 ظهراً.")]);
  assert.equal(w.sms.length, 2, "the alert still goes out while closed");
  w.clock.advance(2);
  const h = await w.say("متى تفتحون");
  assert.deepEqual(h.sent, [txt(ME, "⏰ مواعيدنا:\nالسبت – الأربعاء: 12 ظهراً – 2 فجراً\nالخميس – الجمعة: 12 ظهراً – 3 فجراً\n🌙 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً.")], "hours without the cart link");
  w.clock.advance(2);
  assert.equal((await w.say("وين موقعكم")).sent[0].interactive.action.parameters.url, "https://maps.google.com/?cid=14767749764292326433");
  w.clock.advance(2);
  assert.match((await w.say("وين طلبي")).sent[0].interactive.body.text, /^طلبك رقم W1790011111111: تم توصيل طلبك ✅$/);
  for (const promo of ["السلام عليكم", "عندكم عروض؟", "ابي اطلب", "كم رسوم التوصيل", "المنيو", "ابي اكلم موظف", "الاكل كان محروق"]) {
    w.clock.advance(2);
    const x = await w.say(promo);
    assert.equal(x.sent.length, 0, promo); assert.equal(x.log.reason, "handoff_open", promo); assert.equal(x.log.detail, "complaint");
  }
  assert.equal(w.sms.length, 2, "staff were alerted once");
  assert.ok(w.calls.every((k) => !/FIRST|wab-boxes|اطلب الآن|جهّز سلتك/.test(JSON.stringify(k.body))), "nothing promotional went to the unhappy customer");
  w.clock.advance(24 * 60);
  assert.equal((await w.say("المنيو")).sent.length, 1, "after handoffOpenHours the chat is normal again");
  // «رجّع البوت» closes the handover at once
  const w2 = world({ waBot: { mode: "live" } });
  await w2.say("عندي شكوى"); w2.clock.advance(3);
  assert.equal((await w2.say("المنيو")).log.reason, "handoff_open");
  await w2.call("POST", "/api/cms/wabot/chats/unmute", { phone: "0512345678" });
  w2.clock.advance(3);
  assert.equal((await w2.say("المنيو")).sent.length, 1);
}));

test("after «موظف»: questions the bot knows are still answered, the handover is not repeated, a complaint still escalates", withEnv(LOCKS_OPEN, async () => {
  for (const phrase of ["موظف", "كلموني", "ابي اكلم موظف", "ابغى خدمة العملاء", "agent", "customer service please", "ابي المدير", "محد يرد علي"]) {
    const w = world({ waBot: { mode: "live" } });
    const r = await w.say(phrase);
    assert.equal(r.log.reply_key, "human", phrase); assert.equal(r.log.handoff, "asked_human", phrase);
    assert.equal(r.sent.length, 1, phrase); assert.equal(w.sms.length, 2, phrase);
    assert.match(w.sms[0].body, /needs staff \(asked for staff\)\. Reply from the restaurant phone\.$/);
  }
  const w = world({ waBot: { mode: "live" } });
  assert.deepEqual((await w.say("ابي اكلم موظف")).sent, [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.${SOON}`)]);
  w.clock.advance(1);
  const again = await w.say("موظف");
  assert.equal(again.sent.length, 0); assert.equal(again.log.reason, "handoff_open"); assert.equal(w.sms.length, 2, "no second alert");
  w.clock.advance(1);
  const q = await w.say("كم رسوم التوصيل");
  assert.equal(q.sent.length, 1, "a known question is answered while the customer waits for staff");
  assert.equal(q.sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
  w.clock.advance(1);
  const c = await w.say("الطلب وصل بارد");
  assert.equal(c.sent.length, 1); assert.equal(c.log.handoff, "complaint"); assert.equal(w.sms.length, 4, "a complaint after «موظف» is a new, more serious alert");
  const b = await w.press("bot:human", "👤 كلّم موظف", { from: "966598765432" });
  assert.equal(b.log.handoff, "asked_human");
}));

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
test("rule 5: open hours — known questions at once; an unrecognised message waits 3 min for staff, then the menu + «موظف»; closed — at once", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  assert.equal((await w.say("كم رسوم التوصيل")).sent.length, 1, "recognised: immediately");
  const u = await w.say("قفغفغ", { from: "966598765432" });
  assert.equal(u.sent.length, 0); assert.equal(u.log.decision, "waiting"); assert.equal(u.log.reason, "unknown_wait");
  assert.equal(mins(u.log.resume_at, w.clock.now().toISOString()), 3);
  assert.deepEqual(await w.tick(2), []);
  assert.deepEqual(await w.tick(1), [FALLBACK("966598765432")]);
  assert.equal(u.log.decision, "replied"); assert.equal(u.log.handoff, null);
  // the staff member answered inside the 3 minutes ⇒ no fallback
  const w2 = world({ waBot: { mode: "live" } });
  const v = await w2.say("قفغفغ");
  w2.clock.advance(1); await w2.cashier("تفضل كيف أخدمك");
  assert.deepEqual(await w2.tick(5), []); assert.equal(v.log.reason, "staff_answered");
  // second unrecognised message in a row ⇒ a human (also after the wait), with the alert
  const w3 = world({ waBot: { mode: "live" } });
  await w3.say("قفغفغ"); await w3.tick(3); w3.clock.advance(1);
  const s = await w3.say("ثصضص");
  assert.equal(s.sent.length, 0);
  const out = await w3.tick(3);
  assert.deepEqual(out, [txt(ME, `أبشر 🙏 حوّلت محادثتك لموظف.${SOON}`)]); assert.equal(s.log.handoff, "not_understood_twice"); assert.equal(w3.sms.length, 2);
  // a button press after the fallback is understood at once and resets the count
  const w4 = world({ waBot: { mode: "live" } });
  await w4.say("قفغفغ"); await w4.tick(3); w4.clock.advance(1);
  assert.equal((await w4.press("bot:menu", "🎁 البوكسات والمنيو")).log.reply_key, "menu");
  // closed: the fallback goes immediately
  const c = world({ waBot: { mode: "live" }, at: CLOSED_AT });
  assert.deepEqual((await c.say("قفغفغ")).sent, [FALLBACK(ME)]);
  // unknownWaitMin = 0 ⇒ immediately in open hours too
  const z = world({ waBot: { mode: "live", unknownWaitMin: 0 } });
  assert.equal((await z.say("قفغفغ")).sent.length, 1);
  // questions outside v1 are recognised (not «unknown»): straight to staff, no wait
  for (const phrase of ["فيه وظايف عندكم؟", "ابي احجز طاولة", "عندي حساسية من المكسرات", "ابي فاتورة ضريبية", "طلب لـ ٥٠ شخص"]) {
    const x = world({ waBot: { mode: "live" } });
    const y = await x.say(phrase);
    assert.equal(y.log.reply_key, "staff", phrase); assert.equal(y.log.handoff, "needs_staff", phrase);
    assert.deepEqual(y.sent, [txt(ME, `سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.${SOON}`)], phrase);
  }
}));

test("delayed replies: stored in the database, re-checked at send time, sent exactly once", withEnv(LOCKS_OPEN, async () => {
  const mk = async (opts = {}) => { const w = world({ waBot: { mode: "live" }, ...opts }); await w.cashier("هلا"); const r = await w.say("المنيو"); return { w, r }; };
  // the job row carries everything needed after a restart; two runners can not both send it
  let { w, r } = await mk();
  assert.equal(w.db.jobs.length, 1);
  assert.deepEqual([w.db.jobs[0].kind, w.db.jobs[0].status, w.db.jobs[0].wamid, w.db.jobs[0].ev.text], ["staff_wait", "pending", r.wamid, "المنيو"]);
  w.clock.advance(5);
  const [a, b] = await Promise.all([w.bot.runDueJobs(), w.bot.runDueJobs()]);
  assert.equal(a + b, 1); assert.equal(w.calls.length, 1); assert.equal(w.db.jobs[0].status, "done");
  assert.deepEqual(await w.tick(60), []);
  // a webhook re-delivery of the same message does not create a second delayed reply
  ({ w, r } = await mk());
  await w.say("المنيو", { id: r.wamid });
  assert.equal(w.db.jobs.length, 1); assert.equal(w.db.log.length, 1);
  // mode switched off while waiting ⇒ cancelled
  ({ w, r } = await mk());
  w.setMode("off");
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "mode_off"); assert.equal(w.db.jobs[0].status, "cancelled");
  // test mode at send time and the phone is not on the list ⇒ silent
  ({ w, r } = await mk());
  w.db.settings.waBot = { mode: "test", testPhones: ["0544775082"] };
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "test_mode_not_listed");
  // the server was down past the message's useful age ⇒ dropped, not sent hours later
  ({ w, r } = await mk());
  assert.deepEqual(await w.tick(60), []); assert.equal(r.log.reason, "stale");
  // a row left «running» by a crash is never sent again
  ({ w, r } = await mk());
  w.db.jobs[0].status = "running";
  assert.deepEqual(await w.tick(10), []);
  // the echo check itself fails ⇒ we do not know if staff answered ⇒ no reply
  ({ w, r } = await mk({ failDb: /^SELECT 1 FROM wa_messages/ }));
  assert.deepEqual(await w.tick(5), []); assert.equal(r.log.reason, "echo_check_failed");
  // dry mode: the delayed reply is logged as «would send», nothing goes out
  const d = world({ waBot: { mode: "dry" } });
  await d.cashier("هلا"); const dr = await d.say("المنيو");
  assert.deepEqual(await d.tick(5), []); assert.equal(dr.log.decision, "dry"); assert.equal(dr.log.replies[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
}));

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
test("no loops: same answer is not repeated inside the duplicate window; the hourly cap ends in one handover", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  assert.equal((await w.say("المنيو")).sent.length, 1);
  const d = await w.say("ارسل المنيو");
  assert.equal(d.sent.length, 0); assert.equal(d.log.reason, "duplicate");
  w.clock.advance(3);
  assert.equal((await w.say("المنيو")).sent.length, 1);
  const cap = world({ waBot: { mode: "live", maxRepliesPerHour: 4, duplicateSeconds: 0 } });
  const keys = [];
  for (const q of ["المنيو", "كم رسوم التوصيل", "وين موقعكم", "متى تفتحون", "ابي اطلب", "طرق الدفع"]) { const r = await cap.say(q); keys.push([r.log.reply_key, r.sent.length, r.log.reason || null]); cap.clock.advance(1); }
  assert.deepEqual(keys, [["menu", 1, null], ["delivery", 1, null], ["location", 1, null], ["rate", 1, null], ["order", 0, "rate_limited"], ["payment", 0, "rate_limited"]]);
  assert.equal(cap.sms.length, 2, "one alert for the rate-limit handover");
}));

test("missing data: never a partial or placeholder text — a plain «handed to staff» and an alert", withEnv(LOCKS_OPEN, async () => {
  const MISSING = [txt(ME, `ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.${SOON}`)];
  const cases = [
    [{ bundles: [] }, "المنيو"], [{ bundles: null }, "السلام عليكم"], [{ bundles: [{ price: 0, section: "x" }, { price: 20 }] }, "المنيو"],
    [{ policy: null }, "كم رسوم التوصيل"], [{ policy: { maxKm: 10, feeByTotal: [] } }, "كم التوصيل"], [{ policy: { maxKm: 0, feeByTotal: POLICY.feeByTotal } }, "توصلون؟"],
    [{ policy: { maxKm: 10, feeByTotal: [{ fee: "x", over: 0 }] } }, "رسوم التوصيل"],
    [{ failDb: /FROM cms_links WHERE slug = ANY/ }, "ابي اطلب"], [{ extraSettings: { storefront: { seo: { faq: [] } } } }, "طرق الدفع"],
    [{ failDb: /FROM shop_orders/ }, "وين طلبي"],
  ];
  for (const [opts, q] of cases) {
    const w = world({ waBot: { mode: "live" }, ...opts });
    const r = await w.say(q);
    assert.deepEqual(r.sent, MISSING, `${q} ${JSON.stringify(Object.keys(opts))}`);
    assert.equal(r.log.handoff, "data_missing"); assert.equal(r.log.reply_key, "data_missing");
    assert.match(w.sms[0].body, /needs staff \(bot could not answer\)/);
  }
  // the opening hours themselves are unknown ⇒ no promise about when anyone replies
  const nh = world({ waBot: { mode: "live" }, extraSettings: { hours: null } });
  assert.deepEqual((await nh.say("متى تفتحون")).sent, [txt(ME, "ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.")]);
  const w = world({ waBot: { mode: "live" }, first: null, extraSettings: { cms: { loyalty: { enabled: false } } } });
  assert.equal((await w.say("السلام عليكم")).sent[0].interactive.body.text, `حيّاك الله في فريش كاتس 👋\n${BOXES}`);
  w.clock.advance(3);
  assert.equal((await w.say("عندكم عروض")).sent[0].interactive.body.text, BOXES);
  const w2 = world({ waBot: { mode: "live" }, links: ["wab-boxes"] });
  assert.equal((await w2.say("ابي اطلب", { referral: { source_id: "1234567", source_type: "ad" } })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
}));

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
