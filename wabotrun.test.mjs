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
  at = OPEN_AT, graph = null, failDb = null, extraSettings = {} } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (min) => { nowMs += min * 60_000; }, set: (iso) => { nowMs = Date.parse(iso); } };
  const db = { msgs: [], log: [], chats: new Map(), optouts: [], optins: {}, links: links.map((s) => ({ slug: s, active: true, clicks: 0 })), settings: null };
  db.settings = { hours: HOURS, notifications, googlePlace: { mapsUrl: "https://maps.google.com/?cid=14767749764292326433" }, storefront: { seo: { faq: FAQ } },
    cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60 } }, delivery: { alertPhones: ["0544775082", "0506338246"], staffSmsLanguage: "en" }, waBot, ...extraSettings };
  const iso = () => new Date(nowMs).toISOString();
  const chat = (p) => { if (!db.chats.has(p)) db.chats.set(p, { phone_norm: p, unknown_streak: 0 }); return db.chats.get(p); };
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
        Object.assign(l, { decision: p[1], reason: p[2], detail: p[3], reply_key: p[4] || l.reply_key, replies: p[5] ? JSON.parse(p[5]) : null, sent: p[6], error: p[7], handoff: p[8], alert: p[9], link_slug: p[10] });
        return { rows: [], rowCount: 1 };
      }
      if (/count\(\*\) FILTER \(WHERE decision IN \('replied','dry'\) AND at > NOW\(\) - INTERVAL '1 hour'\)/i.test(s)) {
        const rows = db.log.filter((l) => l.phone_norm === p[0] && ["replied", "dry"].includes(l.decision) && nowMs - Date.parse(l.at) < 3600_000);
        const same = rows.filter((l) => l.reply_key === p[1]).map((l) => l.at).sort().pop() || null;
        return { rows: [{ n: rows.length, same_at: same }] };
      }
      if (/FROM wa_bot_log WHERE alert='sent'/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.alert === "sent" && nowMs - Date.parse(l.at) < 3600_000).length }] };
      if (/^SELECT \* FROM wa_bot_chats WHERE phone_norm/i.test(s)) return { rows: db.chats.has(p[0]) ? [{ ...db.chats.get(p[0]) }] : [] };
      if (/^INSERT INTO wa_bot_chats\(phone_norm, referral, referral_at\)/i.test(s)) { Object.assign(chat(p[0]), { referral: JSON.parse(p[1]), referral_at: iso() }); return { rows: [] }; }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, last_greet_at, unknown_streak, last_key, last_key_at\)/i.test(s)) {
        const c = chat(p[0]);
        if (p[1]) c.last_greet_at = iso();
        c.unknown_streak = p[2] ? (c.unknown_streak || 0) + 1 : 0;
        c.last_key = p[3]; c.last_key_at = iso();
        return { rows: [] };
      }
      if (/^INSERT INTO wa_bot_chats\(phone_norm, muted_until, mute_reason\)/i.test(s)) { Object.assign(chat(p[0]), { muted_until: new Date(nowMs + p[1] * 3600_000).toISOString(), mute_reason: p[2], unknown_streak: 0 }); return { rows: [] }; }
      if (/^UPDATE wa_bot_chats SET muted_until=NULL/i.test(s)) { if (p[0]) Object.assign(chat(p[0]), { muted_until: null, mute_reason: null, unknown_streak: 0 }); else for (const c of db.chats.values()) Object.assign(c, { muted_until: null, last_greet_at: null, unknown_streak: 0 }); return { rows: [] }; }
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
  const bot = R.register(app, ctx, { app, wa, now: clock.now, sendSms: async (x) => { sms.push(x); return { ok: true }; } });
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
  return { db, clock, calls, sms, say, press, cashier, call, wa, bot, setOwner: (v) => { owner = v; }, setMode: (m) => { db.settings.waBot = { ...db.settings.waBot, mode: m }; } };
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

test("order status: never another person's order; no order ⇒ say so plainly and hand over", withEnv(LOCKS_OPEN, async () => {
  const other = order({ order_no: "W1790099999999", phone_norm: "598765432", status: "on_the_way" });
  const w = world({ waBot: { mode: "live" }, orders: [other] });
  const r = await w.say("وين طلبي W1790099999999");
  assert.deepEqual(r.sent, [txt(ME, "ما لقيت طلب حديث من موقعنا على رقمك هذا 🙏\nحوّلت محادثتك لموظف يتأكد لك.")]);
  assert.doesNotMatch(JSON.stringify(r.sent), /W1790099999999|الطريق/);
  assert.equal(r.log.handoff, "order_not_found");
  assert.equal(w.sms.length, 2);
  assert.equal(w.sms[0].body, "Fresh Cuts WhatsApp: customer 0512345678 needs staff (order not found). Reply from the restaurant phone.");
  assert.deepEqual(w.sms.map((s) => s.phoneNorm), ["544775082", "506338246"]);
  assert.ok(w.sms.every((s) => s.kind === "staff" && s.body.length <= 160));
  // the owner of that order does get it
  const mine = await w.say("وين طلبي", { from: "966598765432" });
  assert.match(mine.sent[0].interactive.body.text, /^طلبك رقم W1790099999999: طلبك مع المندوب وفي الطريق إليك 🛵$/);
}));

test("order status: a late or stuck order gets its status AND a handover; an unknown state is never guessed", withEnv(LOCKS_OPEN, async () => {
  const late = world({ waBot: { mode: "live" }, orders: [order({ status: "accepted", created_at: new Date(Date.parse(OPEN_AT) - 95 * 60_000).toISOString() })] });
  const r = await late.say("طلبي وين");
  assert.equal(r.sent[0].interactive.body.text, "طلبك رقم W1790011111111: المطبخ يجهّز طلبك 👨‍🍳\nنعتذر عن التأخير 🙏 بلّغت الفريق يتابعه معك الحين.");
  assert.equal(r.log.handoff, "order_late");
  assert.match(late.sms[0].body, /needs staff \(LATE order\) order W1790011111111\./);
  const stuck = world({ waBot: { mode: "live" }, orders: [order({ status: "refund_failed" })] });
  const s = await stuck.say("وين طلبي");
  assert.match(s.sent[0].interactive.body.text, /استرجاع المبلغ جاري وفريقنا يتابعه\.$/); assert.equal(s.log.handoff, "order_issue");
  for (const o of [order({ status: "rejected_refunded", refund_id: null }), order({ status: "some_new_status" }), order({ option: "dine_in", status: "accepted" })]) {
    const w = world({ waBot: { mode: "live" }, orders: [o] });
    const x = await w.say("وين طلبي");
    assert.deepEqual(x.sent, [txt(ME, "ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف ويرد عليك هنا.")], o.status);
    assert.equal(x.log.handoff, "data_missing");
  }
}));

/* ── ٤) الإنسان أولاً ────────────────────────────────────────────────────── */
test("the cashier replied from the phone ⇒ the bot is silent in that chat for the window, then speaks again", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  await w.cashier("حياك الله، كيف أخدمك؟");
  const r = await w.say("كم رسوم التوصيل");
  assert.equal(r.sent.length, 0); assert.equal(r.log.reason, "human_active"); assert.equal(r.log.reply_key, "delivery");
  // another customer is not affected
  assert.equal((await w.say("كم رسوم التوصيل", { from: "966598765432" })).sent.length, 1);
  w.clock.advance(11 * 60);
  assert.equal((await w.say("المنيو")).log.reason, "human_active");
  w.clock.advance(62);
  assert.equal((await w.say("المنيو")).sent.length, 1, "window (12 h) passed");
  // the window is a dashboard setting
  const w2 = world({ waBot: { mode: "live", humanWindowHours: 2 } });
  await w2.cashier("تمام");
  w2.clock.advance(121);
  assert.equal((await w2.say("المنيو")).sent.length, 1);
}));

test("asking for a human — any phrasing — hands over once, mutes the chat and alerts staff once", withEnv(LOCKS_OPEN, async () => {
  for (const phrase of ["موظف", "كلموني", "ابي اكلم موظف", "ابغى خدمة العملاء", "agent", "customer service please", "ابي المدير", "محد يرد علي"]) {
    const w = world({ waBot: { mode: "live" } });
    const r = await w.say(phrase);
    assert.equal(r.log.reply_key, "human", phrase); assert.equal(r.log.handoff, "asked_human", phrase);
    assert.equal(r.sent.length, 1, phrase); assert.equal(r.sent[0].type, "text", phrase);
    assert.equal(w.sms.length, 2, phrase);
    assert.match(w.sms[0].body, /needs staff \(asked for staff\)\. Reply from the restaurant phone\.$/);
    w.clock.advance(1);
    const after = await w.say("وين طلبي");
    assert.equal(after.sent.length, 0, phrase); assert.equal(after.log.reason, "muted", phrase);
    assert.equal(w.sms.length, 2, "no second alert");
  }
  const w = world({ waBot: { mode: "live" } });
  assert.deepEqual((await w.say("ابي اكلم موظف")).sent, [txt(ME, "أبشر 🙏 حوّلت محادثتك لموظف ويرد عليك هنا بأسرع وقت.")]);
  const b = await w.press("bot:human", "👤 كلّم موظف", { from: "966598765432" });
  assert.equal(b.log.handoff, "asked_human");
  // unmute from the dashboard
  await w.call("POST", "/api/cms/wabot/chats/unmute", { phone: "0512345678" });
  w.clock.advance(1);
  assert.equal((await w.say("المنيو")).sent.length, 1);
}));

test("complaint or order problem: apology in the house style, order number, immediate handover and staff alert", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" }, orders: [order({ status: "delivered" })] });
  const r = await w.say("الطلب وصل بارد وناقص");
  assert.deepEqual(r.sent, [txt(ME, "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع ويتواصل معك هنا بأسرع وقت.\nطلبك رقم W1790011111111 قدّامنا.")]);
  assert.equal(w.sms[0].body, "Fresh Cuts WhatsApp: customer 0512345678 needs staff (complaint) order W1790011111111. Reply from the restaurant phone.");
  const w2 = world({ waBot: { mode: "live" } });
  assert.deepEqual((await w2.say("جاني طلب غلط")).sent, [txt(ME, "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع ويتواصل معك هنا بأسرع وقت.\nلو تكرّمت اكتب رقم الطلب (يبدأ بحرف W) عشان نخدمك أسرع.")]);
  w2.clock.advance(1);
  const no = await w2.say("W1790011111111");
  assert.equal(no.sent.length, 0, "the order number goes to the human, the bot stays quiet"); assert.equal(no.log.reason, "muted");
  for (const [phrase, key, reason] of [["ابي استرجاع المبلغ", "complaint", "complaint"], ["انخصم المبلغ وما وصل تاكيد", "problem", "problem"], ["الموقع ما يفتح", "problem", "problem"],
    ["ابي الغي الطلب", "change", "order_change"], ["ابي اغير العنوان", "change", "order_change"], ["الكود ما يشتغل", "problem", "problem"], ["صار عندي تسمم", "complaint", "complaint"]]) {
    const x = world({ waBot: { mode: "live" } });
    const y = await x.say(phrase);
    assert.equal(y.log.reply_key, key, phrase); assert.equal(y.log.handoff, reason, phrase); assert.equal(x.sms.length, 2, phrase);
  }
  // Arabic staff language: one UCS-2 segment
  const ar = world({ waBot: { mode: "live" }, extraSettings: { delivery: { alertPhones: ["0544775082"], staffSmsLanguage: "ar" } } });
  await ar.say("عندي شكوى");
  assert.equal(ar.sms[0].body, "فريش كاتس واتساب: 0512345678 يحتاج موظف (شكوى)"); assert.ok(ar.sms[0].body.length <= 70);
}));

test("not understood: buttons the first time, a human the second time; questions outside v1 go straight to staff", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const a = await w.say("قفغفغ");
  assert.deepEqual(a.sent, [{ messaging_product: "whatsapp", recipient_type: "individual", to: ME, type: "interactive", interactive: { type: "button", body: { text: "ما فهمت طلبك تماماً 🙏 اختر من الأزرار، أو اكتب: موظف" }, footer: { text: FOOTER },
    action: { buttons: [{ type: "reply", reply: { id: "bot:menu", title: "🎁 البوكسات والمنيو" } }, { type: "reply", reply: { id: "bot:status", title: "📦 وين طلبي؟" } }, { type: "reply", reply: { id: "bot:human", title: "👤 كلّم موظف" } }] } } }]);
  assert.equal(a.log.handoff, null);
  w.clock.advance(1);
  const b = await w.say("ثصضص");
  assert.equal(b.log.handoff, "not_understood_twice"); assert.equal(b.sent[0].text.body, "أبشر 🙏 حوّلت محادثتك لموظف ويرد عليك هنا بأسرع وقت.");
  // a button press after «unknown» works and resets the count
  const w2 = world({ waBot: { mode: "live" } });
  await w2.say("قفغفغ"); w2.clock.advance(1);
  assert.equal((await w2.press("bot:menu", "🎁 البوكسات والمنيو")).log.reply_key, "menu");
  w2.clock.advance(1);
  assert.equal((await w2.say("ثصضص")).log.reply_key, "unknown", "streak was reset by the understood message");
  for (const phrase of ["فيه وظايف عندكم؟", "ابي احجز طاولة", "عندي حساسية من المكسرات", "ابي فاتورة ضريبية", "طلب لـ ٥٠ شخص"]) {
    const x = world({ waBot: { mode: "live" } });
    const y = await x.say(phrase);
    assert.equal(y.log.reply_key, "staff", phrase); assert.equal(y.log.handoff, "needs_staff", phrase);
    assert.deepEqual(y.sent, [txt(ME, "سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم ويردّون عليك هنا.")], phrase);
  }
}));

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
  assert.deepEqual(keys, [["menu", 1, null], ["delivery", 1, null], ["location", 1, null], ["rate", 1, null], ["order", 0, "muted"], ["payment", 0, "muted"]]);
  assert.equal(cap.sms.length, 2, "one alert for the rate-limit handover");
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
  assert.equal(h.sent[0].text.body, "أبشر 🙏 حوّلت محادثتك لموظف ويرد عليك هنا بأسرع وقت.\nالمطعم مقفل الحين، والرد يوصلك أول ما نفتح اليوم الساعة 12 ظهراً.");
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
test("missing data: never a partial or placeholder text — a plain «handed to staff» and an alert", withEnv(LOCKS_OPEN, async () => {
  const MISSING = [txt(ME, "ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف ويرد عليك هنا.")];
  const cases = [
    [{ bundles: [] }, "المنيو"], [{ bundles: null }, "السلام عليكم"], [{ bundles: [{ price: 0, section: "x" }, { price: 20 }] }, "المنيو"],
    [{ policy: null }, "كم رسوم التوصيل"], [{ policy: { maxKm: 10, feeByTotal: [] } }, "كم التوصيل"], [{ policy: { maxKm: 0, feeByTotal: POLICY.feeByTotal } }, "توصلون؟"],
    [{ policy: { maxKm: 10, feeByTotal: [{ fee: "x", over: 0 }] } }, "رسوم التوصيل"],
    [{ failDb: /FROM cms_links WHERE slug = ANY/ }, "ابي اطلب"], [{ extraSettings: { hours: null } }, "متى تفتحون"], [{ extraSettings: { storefront: { seo: { faq: [] } } } }, "طرق الدفع"],
    [{ failDb: /FROM shop_orders/ }, "وين طلبي"],
  ];
  for (const [opts, q] of cases) {
    const w = world({ waBot: { mode: "live" }, ...opts });
    const r = await w.say(q);
    assert.deepEqual(r.sent, MISSING, `${q} ${JSON.stringify(Object.keys(opts))}`);
    assert.equal(r.log.handoff, "data_missing"); assert.equal(r.log.reply_key, "data_missing");
    assert.match(w.sms[0].body, /needs staff \(bot could not answer\)/);
  }
  // an optional line with no data simply disappears: FIRST switched off / loyalty off
  const w = world({ waBot: { mode: "live" }, first: null, extraSettings: { cms: { loyalty: { enabled: false } } } });
  assert.equal((await w.say("السلام عليكم")).sent[0].interactive.body.text, `حيّاك الله في فريش كاتس 👋\n${BOXES}`);
  w.clock.advance(3);
  assert.equal((await w.say("عندكم عروض")).sent[0].interactive.body.text, BOXES);
  // the ad link was switched off ⇒ the normal tracked link; both off ⇒ handover
  const w2 = world({ waBot: { mode: "live" }, links: ["wab-boxes"] });
  assert.equal((await w2.say("ابي اطلب", { referral: { source_id: "1234567", source_type: "ad" } })).sent[0].interactive.action.parameters.url, "https://freshcuts.sa/l/wab-boxes");
}));

test("Meta refuses the message: one plain-text retry for an interactive message, then stop — never a loop", withEnv(LOCKS_OPEN, async () => {
  // interactive refused, text accepted
  const a = world({ waBot: { mode: "live" }, graph: (body) => (body.type === "interactive" ? { error: { code: 131009, message: "Parameter value is not valid" } } : null) });
  const r = await a.say("ابي اطلب");
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].type, "text");
  assert.match(r.sent[1].text.body, /\nhttps:\/\/freshcuts\.sa\/l\/wab-boxes$/); assert.equal(r.sent[1].text.preview_url, true);
  assert.equal(r.log.decision, "replied"); assert.equal(r.log.handoff, null); assert.equal(r.log.replies[0].type, "text");
  // everything refused: two attempts in total, a handover, an alert, the chat muted
  const b = world({ waBot: { mode: "live" }, graph: () => ({ error: { code: 131000, message: "Something went wrong" } }) });
  const x = await b.say("ابي اطلب");
  assert.equal(x.sent.length, 2); assert.equal(x.log.decision, "failed"); assert.equal(x.log.handoff, "send_failed");
  assert.match(x.log.error, /^WA_131000 Something went wrong/);
  assert.match(b.sms[0].body, /needs staff \(bot reply failed\)/);
  b.clock.advance(1);
  const y = await b.say("ابي اطلب");
  assert.equal(y.sent.length, 0); assert.equal(y.log.reason, "muted");
  assert.equal(b.calls.length, 2, "no further attempts");
  // a plain text reply that fails is not retried at all
  const c = world({ waBot: { mode: "live" }, graph: () => ({ error: { code: 131047, message: "Re-engagement message" } }) });
  assert.equal((await c.say("شكرا")).sent.length, 1);
  // interactive switched off in the dashboard ⇒ text with the link from the start
  const d = world({ waBot: { mode: "live", interactive: false } });
  const t = await d.say("وين موقعكم");
  assert.deepEqual(t.sent, [txt(ME, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.\nhttps://maps.google.com/?cid=14767749764292326433", true)]);
}));

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
  assert.equal(q.sent.length, 0); assert.equal(q.log.reason, "human_active"); assert.deepEqual(w3.db.optouts, ["512345678"]);
}));

test("media: voice notes / photos go to a human; reactions and stickers are ignored; a caption is read", withEnv(LOCKS_OPEN, async () => {
  const w = world({ waBot: { mode: "live" } });
  const v = await w.say(null, { raw: { type: "audio", audio: { id: "A1", voice: true } } });
  assert.deepEqual(v.sent, [txt(ME, "ما أقدر أفتح الصور والمقاطع الصوتية 🙏 حوّلت محادثتك لموظف ويرد عليك هنا.")]); assert.equal(v.log.handoff, "media");
  const w2 = world({ waBot: { mode: "live" } });
  const re = await w2.say(null, { raw: { type: "reaction", reaction: { message_id: "x", emoji: "👍" } } });
  assert.equal(re.sent.length, 0); assert.equal(re.log.reason, "ignored_type");
  assert.equal((await w2.say(null, { raw: { type: "sticker", sticker: { id: "S" } } })).log.reason, "ignored_type");
  const cap = await w2.say(null, { raw: { type: "image", image: { id: "I", caption: "الطلب وصل ناقص" } } });
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
  const c = R.botConfig({ waBot: { humanWindowHours: 0, maxRepliesPerHour: 9999, maxAgeMinutes: -5 } });
  assert.deepEqual([c.humanWindowHours, c.maxRepliesPerHour, c.maxAgeMinutes], [1, 30, 1]);

  const w = world({ waBot: {} });
  w.setOwner(false);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live" })).status, 403);
  w.setOwner(true);
  assert.equal((await w.call("PUT", "/api/cms/wabot/config", { mode: "live", texts: { thanks: { ar: "العفو {x}" } } })).status, 400);
  assert.equal(w.db.settings.waBot.mode, undefined, "a refused save changes nothing");
  const ok = await w.call("PUT", "/api/cms/wabot/config", { mode: "live", humanWindowHours: 6, texts: { thanks: { ar: "حيّاك الله، في خدمتك دائماً 🌟" }, greet: { ar: "أهلاً بك في فريش كاتس 👋\n{boxes}" } } });
  assert.equal(ok.body.ok, true);
  assert.deepEqual((await w.say("شكرا")).sent, [txt(ME, "حيّاك الله، في خدمتك دائماً 🌟")]);
  assert.equal((await w.say("السلام عليكم", { from: "966598765432" })).sent[0].interactive.body.text, `أهلاً بك في فريش كاتس 👋\n${BOXES}`);
  // emptying a text returns it to the default; other settings are kept
  await w.call("PUT", "/api/cms/wabot/config", { texts: { thanks: { ar: "" } } });
  assert.equal(w.db.settings.waBot.texts.thanks, undefined); assert.equal(w.db.settings.waBot.humanWindowHours, 6); assert.equal(w.db.settings.waBot.mode, "live");
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
