/* RV4 (١٦/١٠/٢٠٢٦) — ميتا رفضت تقديم fc_review_stars: code 100 / subcode 2388060 «Button format is incorrect — Buttons can't have any
   variables, newlines, emojis or formatting characters.» الأزرار كانت «ممتاز ⭐⭐⭐⭐⭐» / «جيد جداً ⭐⭐⭐⭐» / «يحتاج تحسين».
     ١. الأزرار من غير إيموجي، والضغطة بالنص الجديد **أو القديم بالنجوم** (رسالة قديمة في الجوال) بتدّي نفس النجوم.
     ٢. validateTemplate بيرفض أي زر فيه إيموجي/سطر جديد/متغيّر/رموز تنسيق — والكتالوج كله (watemplates + سجل whatsapp.js) نضيف.
     ٣. POST /api/wa/templates/submit بيرجّع سبب ميتا (error_user_title / error_user_msg + code/subcode) بدل «Invalid parameter» بس،
        من غير التوكن ولا أي رابط فيه توكن.
   node --test wa-rv4-stars-buttons.test.mjs      (من غير شبكة: Graph = fetch مزيّف؛ مفيش حاجة بتروح لميتا) */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
const W = await import("./whatsapp.js");
const WT = await import("./watemplates.js");
const RV = await import("./wareviews.js");
W.registerCatalog(WT);

/* ═══ ١) الأزرار والربط بالنجوم ═══════════════════════════════════════ */
test("the stars template's buttons are emoji-free «ممتاز» / «جيد جداً» / «يحتاج تحسين» and pass Meta's button rule; the old starred texts are kept as legacy", () => {
  assert.deepEqual(WT.STAR_BUTTONS.map((b) => b.text), ["ممتاز", "جيد جداً", "يحتاج تحسين"]);
  for (const b of WT.STAR_BUTTONS) assert.equal(WT.buttonTextProblem(b.text), null, b.text);
  assert.deepEqual(WT.STAR_BUTTONS.map((b) => [...b.legacy]), [["ممتاز ⭐⭐⭐⭐⭐"], ["جيد جداً ⭐⭐⭐⭐"], []]);
  const t = WT.findTemplate("fc_review_stars");
  assert.deepEqual(WT.buttonsOf(t).map((b) => [b.type, b.text]), [["QUICK_REPLY", "ممتاز"], ["QUICK_REPLY", "جيد جداً"], ["QUICK_REPLY", "يحتاج تحسين"]]);
  assert.deepEqual(WT.validateTemplate(t), []);
  assert.deepEqual(W.templateSubmission("fc_review_stars").components.find((c) => c.type === "BUTTONS").buttons,
    [{ type: "QUICK_REPLY", text: "ممتاز" }, { type: "QUICK_REPLY", text: "جيد جداً" }, { type: "QUICK_REPLY", text: "يحتاج تحسين" }], "the body Meta gets on the next submission");
  assert.equal(t.category, "UTILITY");
  assert.ok(WT.HOLD.fc_review_stars, "still owner-only (force:true)");
});

test("starOfQr: the new texts AND the old starred texts map to the same stars; variation selectors, extra spaces and Arabic marks do not matter; anything else is not a rating", () => {
  const cases = [
    ["ممتاز", 5, true], ["جيد جداً", 4, true], ["يحتاج تحسين", 3, false],                       // الجديد (بعد RV4)
    ["ممتاز ⭐⭐⭐⭐⭐", 5, true], ["جيد جداً ⭐⭐⭐⭐", 4, true],                                   // القديم (رسايل في الجوال)
    ["ممتاز ⭐️⭐️⭐️⭐️⭐️", 5, true], ["جيد جداً ⭐️⭐️⭐️⭐️", 4, true],                               // نفس القديم بـ U+FE0F
    ["  ممتاز  ", 5, true], ["جيد  جداً", 4, true], ["جيد جدا", 4, true], ["جيد جدا ⭐⭐⭐⭐", 4, true], ["يحتاج  تحسين", 3, false],
  ];
  for (const [txt, stars, exact] of cases) assert.deepEqual(RV.starOfQr(txt), { stars, exact }, JSON.stringify(txt));
  for (const bad of ["", null, undefined, "تمام", "عندي ملاحظة", "⭐⭐⭐⭐⭐", "⭐⭐⭐⭐⭐ ممتاز", "ممتاز ⭐⭐⭐", "ممتاز جداً", "جيد", "excellent", "rs:5:ab12cd34"]) {
    assert.equal(RV.starOfQr(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([...RV.STAR_QR_TEXTS], ["ممتاز", "ممتاز ⭐⭐⭐⭐⭐", "جيد جداً", "جيد جداً ⭐⭐⭐⭐", "يحتاج تحسين"]);
  const a = RV.starOfQr("ممتاز"); a.stars = 1;
  assert.equal(RV.starOfQr("ممتاز").stars, 5, "the returned object is a copy (a caller cannot change the map)");
});

test("every text that maps to stars is a tap the bot classifies as review_star (new + legacy), with code null — the invite is found later from the message context", async () => {
  const R = await import("./wabotrun.js");
  for (const txt of RV.STAR_QR_TEXTS) {
    const c = R.classify({ type: "button", text: txt, interactiveId: txt });
    const want = RV.starOfQr(txt);
    assert.equal(c.key, "review_star", txt);
    assert.deepEqual(c.arg, { stars: want.stars, exact: want.exact, code: null }, txt);
  }
  /* a TYPED «ممتاز» (no tap) is not a star tap — typed stars count only as digits/⭐ while a stars question waits (typedStar) */
  assert.notEqual(R.classify({ type: "text", text: "ممتاز" }).key, "review_star");
  assert.equal(RV.typedStar("ممتاز"), null);
});

/* ═══ ٢) قاعدة ميتا على كل الأزرار ═══════════════════════════════════════ */
test("buttonTextProblem: emoji, newline, variable, formatting characters ⇒ a reason; Arabic marks (shadda/tanween — already APPROVED in «تتبّع الطلب» / «كمّل طلبك») are fine", () => {
  for (const [txt, why] of [["ممتاز ⭐", "إيموجي"], ["تمام 👍", "إيموجي"], ["✅ جدّد التنبيهات", "إيموجي"], ["ممتاز ⭐️", "إيموجي"], ["سطر\nتاني", "سطر جديد"], ["اطلب {{1}}", "متغيّر"], ["*اطلب*", "رموز تنسيق"], ["اطلب_الآن", "رموز تنسيق"], ["~x~", "رموز تنسيق"]]) {
    assert.equal(WT.buttonTextProblem(txt), why, JSON.stringify(txt));
  }
  for (const ok of ["تتبّع الطلب", "كمّل طلبك", "جيد جداً", "يحتاج تحسين", "Order now", "I want to order", "إيقاف", "STOP", "قيّم طلبك", "Track order 2"]) assert.equal(WT.buttonTextProblem(ok), null, ok);
  /* validateTemplate catches it (so the catalogue test and registerCatalog refuse such a template before Meta does) */
  const bad = { ...WT.findTemplate("fc_review_stars") };
  bad.components = bad.components.map((c) => (c.type === "BUTTONS" ? { ...c, buttons: [{ type: "QUICK_REPLY", text: "ممتاز ⭐⭐⭐⭐⭐" }, { type: "QUICK_REPLY", text: "يحتاج تحسين" }] } : c));
  assert.ok(WT.validateTemplate(bad).some((e) => /ممتاز ⭐⭐⭐⭐⭐.*إيموجي.*2388060/.test(e)), JSON.stringify(WT.validateTemplate(bad)));
});

test("the whole catalogue: no button text in watemplates.js or in the whatsapp.js registry (built-ins + every language variant) breaks Meta's button rule", () => {
  const seen = [];
  for (const t of WT.TEMPLATES) for (const b of WT.buttonsOf(t)) seen.push([`watemplates ${t.name}:${t.language}`, b.text]);
  for (const [n, t] of Object.entries(W.TEMPLATES)) {
    const variants = t.variants ? Object.entries(t.variants) : [[t.language || "ar", t.components]];
    for (const [l, comps] of variants) for (const c of comps || []) if (c.type === "BUTTONS") for (const b of c.buttons || []) seen.push([`whatsapp ${n}:${l}`, b.text]);
  }
  assert.ok(seen.length > 200, `scanned ${seen.length} buttons`);
  const bad = seen.filter(([, txt]) => WT.buttonTextProblem(txt));
  assert.deepEqual(bad, [], "buttons Meta would reject with 2388060");
  assert.deepEqual(WT.summary().invalid, [], "the catalogue validates");
});

/* ═══ ٣) سبب ميتا في نتيجة التقديم ═══════════════════════════════════════ */
const TOKEN = "EAAGfakeTOKEN0123456789abcdefXYZ";      // مزيّف — بس لازم مايظهرش في أي رد
const META_2388060 = {
  message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 2388060, is_transient: false,
  error_user_title: "Button format is incorrect",
  error_user_msg: "Buttons can't have any variables, newlines, emojis or formatting characters.",
  fbtrace_id: "AbCdEf123",
};
function mkApp(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body && typeof init.body === "string" ? JSON.parse(init.body) : null });
    const r = reply(String(url), init);
    return { ok: r.status < 400, status: r.status, json: async () => r.json, headers: { get: () => "application/json" } };
  };
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const app = new Hono();
  W.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ notifications: {} }), jb: (x) => JSON.stringify(x), normPhone: (x) => String(x || "") },
    { fetch, sendSms: async () => ({ ok: true }) });
  const call = async (method, path, body) => { const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) }; };
  return { call, calls };
}
const ENV = ["WHATSAPP_TEMPLATES_WRITE", "WHATSAPP_TOKEN", "WHATSAPP_WABA_ID", "WHATSAPP_ENABLED", "META_CAPI_TOKEN", "WHATSAPP_PHONE_ID"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const WRITE = { WHATSAPP_TEMPLATES_WRITE: "1", WHATSAPP_TOKEN: TOKEN, WHATSAPP_WABA_ID: "WABA1" };

test("submit: Meta's 2388060 comes back with its title and message (not only «Invalid parameter») + code/subcode — and the request carried the emoji-free buttons", withEnv(WRITE, async () => {
  const { call, calls } = mkApp(() => ({ status: 400, json: { error: META_2388060 } }));
  const r = await call("POST", "/api/wa/templates/submit", { names: ["fc_review_stars"], force: true });
  assert.equal(r.status, 200);
  const x = r.body.results[0];
  assert.equal(x.ok, false);
  assert.equal(x.error, "Invalid parameter — Button format is incorrect: Buttons can't have any variables, newlines, emojis or formatting characters.");
  assert.deepEqual(x.meta, { code: 100, subcode: 2388060, title: "Button format is incorrect", detail: "Buttons can't have any variables, newlines, emojis or formatting characters.", type: "OAuthException", fbtrace: "AbCdEf123" });
  const sent = calls.find((c) => c.method === "POST" && /message_templates$/.test(c.url)).body;
  assert.deepEqual(sent.components.find((c) => c.type === "BUTTONS").buttons.map((b) => b.text), ["ممتاز", "جيد جداً", "يحتاج تحسين"]);
  assert.ok(!r.text.includes(TOKEN));
}));

test("submit: the token and any link carrying a token never reach the result, even when Meta's text echoes them", withEnv(WRITE, async () => {
  const leaky = { ...META_2388060, message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`,
    error_user_msg: `See https://graph.facebook.com/v21.0/WABA1/message_templates?access_token=${TOKEN}&x=1 and https://example.com/cb?token=abc123secret for details. Bearer ${TOKEN}` };
  const { call } = mkApp(() => ({ status: 400, json: { error: leaky } }));
  const r = await call("POST", "/api/wa/templates/submit", { names: ["fc_review_stars"], force: true });
  const x = r.body.results[0];
  assert.ok(!r.text.includes(TOKEN), r.text);
  assert.ok(!r.text.includes("EAAG"), "no token prefix either");
  assert.ok(!/access_token=(?!\[token\])/.test(r.text) && !r.text.includes("abc123secret") && !r.text.includes("graph.facebook.com"), r.text);
  assert.match(x.error, /\[token\]/); assert.match(x.meta.detail, /\[link\]/);
  assert.match(x.error, /^Invalid OAuth access token/);
}));

test("submit edit:true — a lookup failure carries Meta's reason too (graphGet keeps the Graph error); a plain network failure stays its message; held without force is unchanged", withEnv(WRITE, async () => {
  const { call } = mkApp(() => ({ status: 400, json: { error: { message: "Invalid parameter", code: 100, error_subcode: 33, error_user_title: "Template not found", error_user_msg: "The template does not exist." } } }));
  const r = await call("POST", "/api/wa/templates/submit", { names: ["fc_order_ready_pickup"], edit: true });
  assert.equal(r.body.results[0].error, "Invalid parameter — Template not found: The template does not exist.");
  assert.deepEqual([r.body.results[0].meta.code, r.body.results[0].meta.subcode], [100, 33]);
  const net = mkApp(() => { throw new Error("fetch failed"); });
  const r2 = await net.call("POST", "/api/wa/templates/submit", { names: ["fc_review_stars"], force: true });
  assert.deepEqual([r2.body.results[0].ok, r2.body.results[0].error, r2.body.results[0].meta.code], [false, "fetch failed", null]);
  const held = mkApp(() => ({ status: 200, json: { id: "1" } }));
  const r3 = await held.call("POST", "/api/wa/templates/submit", { names: ["fc_review_stars"] });
  assert.deepEqual([r3.body.results[0].error, held.calls.length], ["held", 0], "HOLD still needs force:true and nothing is sent");
}));

test("metaErrorOf: message only when there is no Graph body; title equal to the message is not repeated; numbers stay numbers", () => {
  assert.deepEqual(W.metaErrorOf(new Error("sample image HTTP 404")), { error: "sample image HTTP 404", meta: { code: null, subcode: null, title: null, detail: null, type: null, fbtrace: null } });
  assert.equal(W.metaErrorOf(Object.assign(new Error("Invalid parameter"), { graph: { message: "Invalid parameter", code: "100", error_user_title: "Invalid parameter" } })).error, "Invalid parameter");
  assert.equal(W.metaErrorOf(Object.assign(new Error(""), { graph: { code: 100 } })).error, "meta_error");
  assert.equal(W.metaErrorOf(Object.assign(new Error("x"), { graph: { code: "100", error_subcode: "2388060" } })).meta.subcode, 2388060);
  const long = W.metaErrorOf(Object.assign(new Error("m"), { graph: { error_user_msg: "y".repeat(2000) } }));
  assert.ok(long.meta.detail.length <= 600 && long.error.length < 1000);
  assert.ok(!JSON.stringify(W.metaErrorOf(new Error(`bad ${TOKEN}`), [TOKEN])).includes(TOKEN));
});
