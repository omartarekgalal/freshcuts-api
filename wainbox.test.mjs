/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات wainbox.js — صندوق محادثات واتساب بتاع البورتال.
     ١) نافذة الـ٢٤ ساعة: عمره ماكلّمنا / مفتوحة / خلصت / على الحدّ بالظبط
     ٢) مقفول افتراضياً: من غير WHATSAPP_ENABLED=1 مفيش قراية ولا إرسال ولا شبكة
     ٣) الرد الحر بره النافذة بيترفض **قبل** أي طلب شبكة (ودي قاعدة ميتا)
     ٤) الرد جوّه النافذة بيبعت وبيحدّث المحادثة
     ٥) وارد جديد بيفتح النافذة ويرفع «غير مقروء»، والقراية بتصفّره
     ٦) whatsapp.js بيعدّي الوارد على الصندوق (الربط مش بالنية)
   node --test wainbox.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const WI = await import("./wainbox.js");
const W = await import("./whatsapp.js");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const HOUR = 3600_000;

function withEnv(vars, fn) {
  return async (t) => {
    const old = { ...process.env };
    Object.assign(process.env, vars);
    try { await fn(t); } finally { process.env = old; }
  };
}
const ON = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "pid", WHATSAPP_WABA_ID: "waba" };

/* ── نافذة الـ٢٤ ساعة (دالة صافية) ───────────────────────────────────────── */

test("window: never messaged → closed, no expiry", () => {
  const w = WI.windowState(null);
  assert.equal(w.open, false);
  assert.equal(w.reason, "never");
  assert.equal(w.expiresAt, null);
});

test("window: inside 24h → open with the right time left", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const w = WI.windowState(new Date(now - 3 * HOUR).toISOString(), now);
  assert.equal(w.open, true);
  assert.equal(w.msLeft, 21 * HOUR);
  assert.equal(w.expiresAt, new Date(now + 21 * HOUR).toISOString());
});

test("window: past 24h → closed and says expired", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const w = WI.windowState(new Date(now - 25 * HOUR).toISOString(), now);
  assert.equal(w.open, false);
  assert.equal(w.reason, "expired");
  assert.equal(w.msLeft, 0);
});

test("window: the exact boundary is closed, one ms earlier is open", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const at = new Date(now - 24 * HOUR).toISOString();
  assert.equal(WI.windowState(at, now).open, false);
  assert.equal(WI.windowState(at, now - 1).open, true);
});

test("window: garbage timestamp is treated as never, not as open", () => {
  assert.equal(WI.windowState("not-a-date").open, false);
  assert.equal(WI.windowState("not-a-date").reason, "never");
});

test("preview truncates and collapses whitespace", () => {
  assert.equal(WI.preview("  a\n\n b  "), "a b");
  const long = "x".repeat(200);
  assert.equal(WI.preview(long, 10).length, 10);
  assert.ok(WI.preview(long, 10).endsWith("…"));
});

test("only Saudi mobiles are inbox-able", () => {
  assert.equal(WI.validPhone("512345678"), true);
  assert.equal(WI.validPhone("541234567"), true);
  assert.equal(WI.validPhone("51234567"), false);    // ناقص رقم
  assert.equal(WI.validPhone("412345678"), false);   // مش جوال سعودي
  assert.equal(WI.validPhone("0512345678"), false);
  assert.equal(WI.validPhone("966512345678"), false);
  assert.equal(WI.validPhone(""), false);
});

/* ── بول في الذاكرة ─────────────────────────────────────────────────────── */
function memPool({ threads = {}, messages = [], contacts = {} } = {}) {
  return {
    threads, messages, contacts,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE TABLE|^CREATE INDEX/i.test(s)) return { rows: [] };
      if (/^INSERT INTO wa_threads/i.test(s)) {
        const [phone, inbound, at, text, dir, orderNo] = p;
        const when = at || new Date().toISOString();
        const cur = threads[phone] || { phone_norm: phone, unread: 0, last_in_at: null, last_out_at: null };
        threads[phone] = {
          ...cur,
          last_in_at: inbound ? when : cur.last_in_at,
          last_out_at: inbound ? cur.last_out_at : when,
          last_at: when, last_text: text, last_dir: dir,
          unread: inbound ? (cur.unread || 0) + 1 : 0,
          order_no: orderNo || cur.order_no || null,
        };
        return { rows: [] };
      }
      if (/^UPDATE wa_threads SET unread=0/i.test(s)) {
        if (threads[p[0]]) threads[p[0]].unread = 0;
        return { rows: [] };
      }
      if (/SELECT last_in_at FROM wa_threads/i.test(s)) {
        return { rows: threads[p[0]] ? [{ last_in_at: threads[p[0]].last_in_at }] : [] };
      }
      if (/FROM wa_threads t LEFT JOIN cms_contacts c ON c.phone_norm = t.phone_norm WHERE t.phone_norm/i.test(s)) {
        const t = threads[p[0]];
        return { rows: t ? [{ ...t, name: contacts[p[0]]?.name || null, orders: contacts[p[0]]?.orders || 0 }] : [] };
      }
      if (/FROM wa_threads t LEFT JOIN cms_contacts/i.test(s)) {
        const list = Object.values(threads).sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
        return { rows: list.map((t) => ({ ...t, name: contacts[t.phone_norm]?.name || null, orders: 0 })) };
      }
      if (/sum\(unread\)/i.test(s)) {
        return { rows: [{ n: Object.values(threads).reduce((a, t) => a + (t.unread || 0), 0) }] };
      }
      if (/FROM wa_messages WHERE phone_norm/i.test(s)) {
        return { rows: messages.filter((m) => m.phone_norm === p[0]) };
      }
      if (/^INSERT INTO wa_messages/i.test(s)) {
        messages.push({ wamid: p[0], phone_norm: p[1], direction: /'out'/.test(s) ? "out" : "in",
          body: /'out'/.test(s) ? p[8] : p[2], created_at: new Date().toISOString(), status: "accepted" });
        return { rows: [] };
      }
      if (/FROM wa_optins/i.test(s)) return { rows: [] };
      if (/FROM cms_contacts/i.test(s)) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

/* wa مزيّف: بيسجّل النداءات من غير أي شبكة. */
function fakeWa({ sendOk = true } = {}) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    gate: async () => null,
    sendText: async (a) => { calls.push({ kind: "text", ...a }); return sendOk ? { ok: true, wamid: "wamid.X" } : { ok: false, error: "boom" }; },
    sendTemplate: async (a) => { calls.push({ kind: "template", ...a }); return { ok: true, wamid: "wamid.T" }; },
  };
}

const ctxOf = (pool, waOn = true) => ({ pool, getSettingsData: async () => ({ notifications: { whatsappEnabled: waOn } }) });

/* ── المفتاح الرئيسي ─────────────────────────────────────────────────────── */

test("master switch off → empty inbox, no reply, zero network", withEnv({ WHATSAPP_ENABLED: "", WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "p" }, async () => {
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: new Date().toISOString(), last_at: new Date().toISOString(), unread: 3 } } });
  const wa = fakeWa();
  let fetched = 0;
  const wi = WI.register(ctxOf(pool), { wa, fetch: async () => { fetched++; return { ok: true, json: async () => ({}) }; } });

  const list = await wi.listThreads();
  assert.equal(list.disabled, true);
  assert.deepEqual(list.threads, []);

  assert.equal((await wi.getThread("512345678")).error, "disabled");
  assert.equal((await wi.replyText({ phoneNorm: "512345678", text: "hi" })).error, "disabled");
  assert.equal((await wi.replyTemplate({ phoneNorm: "512345678", template: "fc_order_received" })).error, "disabled");
  assert.equal((await wi.liveTemplates()).error, "disabled");

  assert.equal(wa.calls.length, 0, "مفيش ولا نداء إرسال");
  assert.equal(fetched, 0, "مفيش ولا طلب شبكة");

  const st = await wi.status();
  assert.equal(st.enabled, false);
}));

/* ── الرد والنافذة ───────────────────────────────────────────────────────── */

test("reply outside the 24h window is refused before any network call", withEnv(ON, async () => {
  const old = new Date(Date.now() - 30 * HOUR).toISOString();
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: old, last_at: old, unread: 0 } } });
  const wa = fakeWa();
  const wi = WI.register(ctxOf(pool), { wa });

  const r = await wi.replyText({ phoneNorm: "512345678", text: "أهلاً" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "window_closed");
  assert.equal(r.window.open, false);
  assert.equal(r.window.reason, "expired");
  assert.equal(wa.calls.length, 0, "مابعتناش حاجة");
}));

test("a customer who never wrote us cannot get a free-form reply", withEnv(ON, async () => {
  const wa = fakeWa();
  const wi = WI.register(ctxOf(memPool()), { wa });
  const r = await wi.replyText({ phoneNorm: "512345678", text: "hi" });
  assert.equal(r.error, "window_closed");
  assert.equal(r.window.reason, "never");
  assert.equal(wa.calls.length, 0);
}));

test("reply inside the window sends and lands in the thread", withEnv(ON, async () => {
  const recent = new Date(Date.now() - 2 * HOUR).toISOString();
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: recent, last_at: recent, unread: 2 } } });
  const wa = fakeWa();
  const wi = WI.register(ctxOf(pool), { wa });

  const r = await wi.replyText({ phoneNorm: "512345678", text: "تمام، جاهز خلال ١٥ دقيقة" });
  assert.equal(r.ok, true);
  assert.equal(wa.calls.length, 1);
  assert.equal(wa.calls[0].kind, "text");
  assert.equal(wa.calls[0].text, "تمام، جاهز خلال ١٥ دقيقة");

  const t = pool.threads["512345678"];
  assert.equal(t.last_dir, "out");
  assert.equal(t.unread, 0, "الرد بيصفّر غير المقروء");
  assert.equal(t.last_text, "تمام، جاهز خلال ١٥ دقيقة");
}));

test("empty / oversized / non-Saudi replies are rejected locally", withEnv(ON, async () => {
  const recent = new Date().toISOString();
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: recent, last_at: recent } } });
  const wa = fakeWa();
  const wi = WI.register(ctxOf(pool), { wa });

  assert.equal((await wi.replyText({ phoneNorm: "512345678", text: "   " })).error, "empty");
  assert.equal((await wi.replyText({ phoneNorm: "512345678", text: "x".repeat(5000) })).error, "too_long");
  assert.equal((await wi.replyText({ phoneNorm: "0512345678", text: "hi" })).error, "bad_phone");
  assert.equal(wa.calls.length, 0);
}));

test("template send does not need the window and does not need an opt-in", withEnv(ON, async () => {
  const old = new Date(Date.now() - 40 * HOUR).toISOString();
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: old, last_at: old } } });
  const wa = fakeWa();
  const wi = WI.register(ctxOf(pool), { wa });

  const r = await wi.replyTemplate({ phoneNorm: "512345678", template: "fc_order_received", params: { body: ["a", "b", "c"] } });
  assert.equal(r.ok, true);
  assert.equal(wa.calls[0].kind, "template");
  assert.equal(wa.calls[0].requireOptIn, false, "رد خدمة عملاء مش تسويق");
  assert.equal(pool.threads["512345678"].last_text, "[قالب: fc_order_received]");
}));

test("a failed send does not fake a thread update", withEnv(ON, async () => {
  const recent = new Date().toISOString();
  const pool = memPool({ threads: { 512345678: { phone_norm: "512345678", last_in_at: recent, last_at: recent, last_text: "قبل", unread: 1 } } });
  const wi = WI.register(ctxOf(pool), { wa: fakeWa({ sendOk: false }) });
  const r = await wi.replyText({ phoneNorm: "512345678", text: "مش هتوصل" });
  assert.equal(r.ok, false);
  assert.equal(pool.threads["512345678"].last_text, "قبل");
  assert.equal(pool.threads["512345678"].unread, 1);
}));

/* ── غير المقروء ─────────────────────────────────────────────────────────── */

test("inbound raises unread and opens the window; marking read clears it", withEnv(ON, async () => {
  const pool = memPool();
  const wi = WI.register(ctxOf(pool), { wa: fakeWa() });

  await wi.touch({ phoneNorm: "512345678", direction: "in", text: "وين طلبي؟" });
  await wi.touch({ phoneNorm: "512345678", direction: "in", text: "؟؟" });
  let list = await wi.listThreads();
  assert.equal(list.unread, 2);
  assert.equal(list.threads[0].unread, 2);
  assert.equal(list.threads[0].window.open, true, "وارد جديد = نافذة مفتوحة");
  assert.equal(list.threads[0].lastText, "؟؟");

  await wi.markRead("512345678", "الكاشير");
  list = await wi.listThreads();
  assert.equal(list.unread, 0);
}));

test("touch ignores phones we could never message", withEnv(ON, async () => {
  const pool = memPool();
  const wi = WI.register(ctxOf(pool), { wa: fakeWa() });
  await wi.touch({ phoneNorm: "0000", direction: "in", text: "x" });
  assert.deepEqual(Object.keys(pool.threads), []);
}));

/* ── القوالب الحيّة ──────────────────────────────────────────────────────── */

test("live templates come back with Meta's approval status", withEnv(ON, async () => {
  const wi = WI.register(ctxOf(memPool()), {
    wa: fakeWa(),
    fetch: async (url, opt) => {
      assert.ok(String(url).includes("/waba/message_templates"), "بيسأل على الـWABA");
      assert.equal(opt.headers.Authorization, "Bearer tok");
      return { ok: true, json: async () => ({ data: [
        { name: "fc_order_received", status: "APPROVED", category: "UTILITY", language: "ar" },
        { name: "fc_cart_reminder", status: "REJECTED", category: "MARKETING", language: "ar", rejected_reason: "ABUSIVE_CONTENT" },
      ] }) };
    },
  });
  const r = await wi.liveTemplates();
  assert.equal(r.ok, true);
  assert.equal(r.templates.length, 2);
  assert.equal(r.templates[0].status, "APPROVED");
  assert.equal(r.templates[1].rejected, "ABUSIVE_CONTENT");
}));

test("live templates: a Graph error is reported, never thrown", withEnv(ON, async () => {
  const wi = WI.register(ctxOf(memPool()), { wa: fakeWa(), fetch: async () => { throw new Error("ECONNRESET"); } });
  const r = await wi.liveTemplates();
  assert.equal(r.ok, false);
  assert.deepEqual(r.templates, []);
}));

test("live templates without a WABA id say unconfigured, no network", withEnv({ WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "t" }, async () => {
  let hits = 0;
  const wi = WI.register(ctxOf(memPool()), { wa: fakeWa(), fetch: async () => { hits++; return { ok: true, json: async () => ({}) }; } });
  assert.equal((await wi.liveTemplates()).error, "unconfigured");
  assert.equal(hits, 0);
}));

/* ── الربط الحقيقي مع whatsapp.js ───────────────────────────────────────── */

function fakeApp() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
function fakeCtx({ raw = "", headers = {} } = {}) {
  return {
    req: { text: async () => raw, json: async () => ({}), header: (n) => headers[String(n).toLowerCase()], query: () => undefined },
    json: (body, status = 200) => ({ body, status }),
    text: (body, status = 200) => ({ body, status }),
  };
}

test("a real inbound webhook reaches the inbox and opens the window", withEnv({ ...ON, WHATSAPP_APP_SECRET: "sek" }, async () => {
  const pool = memPool();
  const app = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => ({ notifications: { whatsappEnabled: true } }),
    jb: (x) => JSON.stringify(x), normPhone: (p) => String(p || "").replace(/\D/g, "").replace(/^966/, "") };

  const waApi = W.register(app, ctx, { fetch: async () => ({ ok: true, json: async () => ({ messages: [{ id: "wamid.1" }] }) }) });
  const wi = WI.register(ctxOf(pool), { wa: waApi });
  waApi.setInbox(wi);          // نفس الربط اللي في index.js

  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
    { id: "wamid.in1", from: "966512345678", type: "text", text: { body: "الطلب وصل بارد" }, timestamp: String(Math.floor(Date.now() / 1000)) },
  ] } }] }] });
  const sig = "sha256=" + crypto.createHmac("sha256", "sek").update(body, "utf8").digest("hex");
  const res = await app.routes["POST /api/wa/webhook"](fakeCtx({ raw: body, headers: { "x-hub-signature-256": sig } }));
  assert.equal(res.body.ok, true);
  await flush();

  const list = await wi.listThreads();
  assert.equal(list.threads.length, 1, "المحادثة اتعملت من الويب هوك");
  assert.equal(list.threads[0].phone, "512345678");
  assert.equal(list.threads[0].unread, 1);
  assert.equal(list.threads[0].window.open, true);
  assert.equal(list.threads[0].lastText, "الطلب وصل بارد");

  // ودلوقتي الرد الحر مسموح — لأن العميل هو اللي بدأ
  const r = await wi.replyText({ phoneNorm: "512345678", text: "نعتذر، بنعوّضك" });
  assert.equal(r.ok, true);
}));
