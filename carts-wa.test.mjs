/* CR3 (١٨/١٠ — عمر: «ابعتلهم واتساب يكملوا سلتهم»): السلة المتروكة على واتساب قبل الـSMS.
   بول وهمي + واتساب وهمي + أرقام وهمية (5000000xx) — مفيش شبكة ولا رسالة حقيقية.
   node --test carts-wa.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };
process.env.CART_RECOVERY_MINUTES = "0";
delete process.env.TAQNYAT_API_KEY; delete process.env.TAQNYAT_SENDER_AD;      // مسار الـSMS بيفشل محلياً (مفيش مفتاح) = اتجرّب ومفيش شبكة
const carts = await import("./carts.js");
const { register, cartCfg, CART_DEFAULTS, CART_WA_TEMPLATES, CART_FIELDS, cartWaParams, cartWaTemplate, cartWaText, smsAfterWa } = carts;
const { TEMPLATES: CATALOG } = await import("./watemplates.js");

const PHONE = "500000011";
/* الرياض = UTC+3 */
const riyadh = (day, hh, mm = 0) => new Date(Date.UTC(2026, 9, day, hh - 3, mm));
const HOURS = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "12:00", close: "02:00" }])) };

function setup({ settings = {}, step1 = [], step2 = [], first = false, stopped = false, wa = {}, push = false } = {}) {
  const db = { updates: [], marks: [], notes: [], deleted: [], flows: 0, waCalls: [], pushCalls: 0, queries: [] };
  let s1 = step1.map((r) => ({ ...r })), s2 = step2.map((r) => ({ ...r }));
  const pool = {
    query: async (sql, p = []) => {
      const s = String(sql);
      db.queries.push(s);
      if (s.includes("FROM shop_carts c") && s.includes("c.rec_step = 0")) { const r = s1; s1 = []; return { rows: r, rowCount: r.length }; }
      if (s.includes("FROM shop_carts c") && s.includes("c.rec_step IN (1, -2)")) { const r = s2; s2 = []; return { rows: r, rowCount: r.length }; }
      if (s.includes("INSERT INTO cart_recovery")) { db.flows++; return { rows: [{ id: 70 + db.flows, code: p[0] }], rowCount: 1 }; }
      if (s.includes("DELETE FROM cart_recovery")) { db.deleted.push(p[0]); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE cart_recovery SET step")) { db.updates.push({ sql: s, p }); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE shop_carts SET rec_step")) { db.marks.push({ device: p[0], step: p[1], reason: p[2] }); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE shop_carts SET rec_note")) { db.notes.push({ device: p[0], reason: p[1] }); return { rows: [], rowCount: 1 }; }
      if (s.includes("SELECT code, percent, active, expires_at, free_delivery FROM shop_coupons")) {
        return first ? { rows: [{ code: "FIRST", percent: 0, active: true, expires_at: null, free_delivery: true }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.includes("SELECT code, min_total FROM shop_coupons")) return { rows: [{ code: "FIRST", min_total: "60" }], rowCount: 1 };
      if (s.includes("FROM wa_optins WHERE phone_norm=$1 AND (stopped_at")) return { rows: [{ stopped }], rowCount: 1 };
      if (s.includes("SELECT optout_code, opted_out_at FROM cms_contacts")) return { rows: [{ optout_code: "abcdefghij", opted_out_at: null }], rowCount: 1 };
      if (s.includes("RETURNING phone_norm, step1_channel")) {
        return { rows: [{ phone_norm: PHONE, step1_channel: "whatsapp", step2_channel: null, step2_at: null }], rowCount: 1 };
      }
      if (s.includes("count(*)::int AS n, COALESCE(sum(subtotal),0)::float AS value")) return { rows: [{ n: 0, value: 0 }], rowCount: 1 };
      if (s.includes("count(*)::int AS flows")) return { rows: [{ flows: 0, sms: 0, push: 0, wa: 0, opened: 0, recovered: 0, revenue: 0, cost: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const fakeWa = {
    sendFreeform: async (a) => { db.waCalls.push({ kind: "free", ...a }); return wa.free ? wa.free(a) : { ok: false, skipped: "window_closed" }; },
    sendTemplate: async (a) => { db.waCalls.push({ kind: "tpl", ...a }); return wa.tpl ? wa.tpl(a) : { ok: true, wamid: "wamid.TEST1" }; },
    templateStatusOf: async (name) => (wa.status ? wa.status(name) : "APPROVED"),
  };
  const notify = { sendToAudience: async () => { db.pushCalls++; return push; } };
  const app = new Hono();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (v) => JSON.stringify(v),
    normPhone: (v) => String(v || "").replace(/\D/g, "").replace(/^(966|0)/, "") };
  const api = register(app, ctx, { notify, wa: wa === null ? undefined : () => fakeWa });
  return { api, app, db };
}
const CART = (o = {}) => ({ device_id: "dev-cr3-0001", phone_norm: PHONE, item_count: 2, subtotal: 95, items: [], cart_raw: null, option: "delivery",
  updated_at: new Date(riyadh(18, 14) - 40 * 60000).toISOString(), rec_flow: null, ...o });

/* ── القواعد الصافية ─────────────────────────────────────────────── */

test("الإعدادات: واتساب شغّال افتراضياً بقوالب السلة الـ٣، والـSMS بديل؛ قالب مش قالب سلة = الافتراضي", () => {
  const c = cartCfg({});
  assert.equal(c.waEnabled, true);
  assert.equal(c.waInWindowText, true);
  assert.equal(c.smsFallback, true);
  assert.equal(c.smsEnabled, false, "مفتاح SMS نفسه زي ما هو");
  assert.deepEqual([c.waTemplate1, c.waTemplate2, c.waTemplate2First], ["fc_cart_1h", "fc_cart_24h", "fc_cart_24h_first"]);
  assert.deepEqual(Object.keys(c).sort(), Object.keys(CART_DEFAULTS).sort());
  for (const n of ["fc_cart_1h", "fc_cart_24h", "fc_cart_24h_first"]) assert.ok(CART_WA_TEMPLATES.includes(n), n);
  assert.ok(!CART_WA_TEMPLATES.includes("fc_birthday"), "قالب من غير زر /c/ مايتقبلش");
  const bad = cartCfg({ abandonedCarts: { waTemplate1: "fc_birthday", waTemplate2: 5, waEnabled: "no", waText1: "  نص  ".padEnd(400, "x") } });
  assert.equal(bad.waTemplate1, "fc_cart_1h");
  assert.equal(bad.waTemplate2, "fc_cart_24h");
  assert.equal(bad.waEnabled, true, "مش boolean = الافتراضي");
  assert.equal(bad.waText1.length, 300);
  for (const k of ["waEnabled", "waInWindowText", "waTemplate1", "waTemplate2", "waTemplate2First", "waText1", "waText2", "smsFallback"]) {
    assert.ok(CART_FIELDS[k] && /[؀-ۿ]/.test(CART_FIELDS[k].ar), `تسمية عربي لـ${k}`);
  }
});

test("متغيّرات القوالب من الكتالوج نفسه: زر /c/<code>، وقالب أول طلب = FIRST + الحد الأدنى", () => {
  assert.deepEqual(cartWaParams("fc_cart_1h", "ab12cd34"), { body: [], button: ["ab12cd34"], missing: [] });
  assert.deepEqual(cartWaParams("fc_cart_24h", "ab12cd34"), { body: [], button: ["ab12cd34"], missing: [] });
  assert.deepEqual(cartWaParams("fc_cart_24h_first", "ab12cd34", { coupon: { code: "FIRST", min_total: 60 } }),
    { body: ["FIRST", "60"], button: ["ab12cd34"], missing: [] });
  assert.ok(cartWaParams("fc_cart_24h_first", "ab12cd34").missing.length, "من غير كوبون = ناقص (مايتبعتش)");
  // الزر في الكتالوج فعلاً رابط /c/{{1}}
  const t = CATALOG.find((x) => x.name === "fc_cart_1h");
  assert.match(JSON.stringify(t.components), /freshcuts\.sa\/c\/\{\{1\}\}/);
  // اختيار القالب
  assert.equal(cartWaTemplate(1, cartCfg({}), { code: "FIRST", min_total: 60 }).name, "fc_cart_1h", "خطوة ١ قالب واحد للكل");
  assert.equal(cartWaTemplate(2, cartCfg({}), { code: "FIRST", min_total: 60 }).name, "fc_cart_24h_first");
  assert.equal(cartWaTemplate(2, cartCfg({}), null).name, "fc_cart_24h");
});

test("الرسالة الحرة: لهجة بيضا + الرابط آخر سطر، ونص المالك لو موجود", () => {
  for (const step of [1, 2]) for (const first of [true, false]) {
    const t = cartWaText(step, first, "https://freshcuts.sa/c/ab12cd34?s=wa", {});
    assert.match(t, /\nhttps:\/\/freshcuts\.sa\/c\/ab12cd34\?s=wa$/);
    assert.doesNotMatch(t, /دلوقتي|عشان|عايز|إزاي|%|٪/);
    if (first) assert.match(t, /التوصيل مجاني/);
  }
  assert.equal(cartWaText(1, false, "L", { waText1: "هلا! سلتك تنتظرك" }), "هلا! سلتك تنتظرك\nL");
});

test("SMS بعد واتساب: الإيقاف والهدوء لأ، 131049 بس لو المالك فعّل cappedFallbackSms، الباقي أيوه", () => {
  assert.equal(smsAfterWa({ ok: true }), false);
  assert.equal(smsAfterWa({ ok: false, skipped: "opted_out" }), false);
  assert.equal(smsAfterWa({ ok: false, skipped: "burst_hold" }), false);
  assert.equal(smsAfterWa({ ok: false, error: "WA_131049", code: 131049 }, {}), false);
  assert.equal(smsAfterWa({ ok: false, error: "WA_131049", code: 131049 }, { waCloud: { cappedFallbackSms: true } }), true);
  assert.equal(smsAfterWa({ ok: false, skipped: "template_not_approved" }), true);
  assert.equal(smsAfterWa({ ok: false, error: "WA_131026", code: 131026 }), true);
  assert.equal(smsAfterWa({ ok: false, skipped: "marketing_cap_7d" }), true);
});

/* ── الدورة (runRecovery) ──────────────────────────────────────── */

test("خطوة ١ والنافذة مفتوحة: رسالة حرة ببلاش برابط /c/<code>?s=wa، مفيش قالب، والقناة whatsapp بتتسجّل", async () => {
  const { api, db } = setup({ step1: [CART()], wa: { free: () => ({ ok: true, wamid: "wamid.FREE1" }) } });
  const out = await api.runRecovery(riyadh(18, 14));
  assert.equal(out.step1, 1);
  assert.equal(db.waCalls.length, 1);
  const f = db.waCalls[0];
  assert.equal(f.kind, "free");
  assert.equal(f.phoneNorm, PHONE);
  assert.equal(f.source, "cart_recovery");
  assert.equal(f.proactive, true, "مبادِرة ⇒ قاعدة الهدوء CJ1a");
  assert.match(f.payload.text.body, /https:\/\/freshcuts\.sa\/c\/[a-z0-9]{8}\?s=wa$/);
  const u = db.updates[0];
  assert.match(u.sql, /step1_channel/);
  assert.deepEqual(u.p.slice(1), ["whatsapp", "wamid.FREE1", 0]);
  assert.deepEqual(db.marks.map((m) => [m.step, m.reason]), [[1, "whatsapp"]]);
});

test("خطوة ١ والنافذة مقفولة: قالب fc_cart_1h بزر الكود، source cart_recovery، والتكلفة = سعر التسويق", async () => {
  const { api, db } = setup({ step1: [CART()] });
  await api.runRecovery(riyadh(18, 14));
  assert.deepEqual(db.waCalls.map((c) => c.kind), ["free", "tpl"]);
  const t = db.waCalls[1];
  assert.equal(t.template, "fc_cart_1h");
  assert.deepEqual(t.params.body, []);
  assert.match(t.params.button[0], /^[a-z0-9]{8}$/);
  assert.equal(t.source, "cart_recovery");
  assert.equal(t.proactive, true);
  assert.deepEqual(db.updates[0].p.slice(1), ["whatsapp", "wamid.TEST1", 0.2159]);
});

test("waInWindowText مقفول ⇒ القالب على طول؛ سعر التسويق من waBot.waRates", async () => {
  const { api, db } = setup({ step1: [CART()], settings: { abandonedCarts: { waInWindowText: false }, waBot: { waRates: { marketing: 0.25 } } } });
  await api.runRecovery(riyadh(18, 14));
  assert.deepEqual(db.waCalls.map((c) => c.kind), ["tpl"]);
  assert.equal(db.updates[0].p[3], 0.25);
});

test("العميل مشترك في الإشعارات: الإشعار الأول ومفيش واتساب", async () => {
  const { api, db } = setup({ step1: [CART()], push: true });
  await api.runRecovery(riyadh(18, 14));
  assert.equal(db.pushCalls, 1);
  assert.equal(db.waCalls.length, 0);
  assert.equal(db.updates[0].p[1], "push");
});

test("موقِّف التسويق: ولا واتساب ولا SMS", async () => {
  const { api, db } = setup({ step1: [CART()], stopped: true, settings: { abandonedCarts: { smsEnabled: true } } });
  const out = await api.runRecovery(riyadh(18, 14));
  assert.equal(out.step1, 0);
  assert.equal(db.waCalls.length, 0);
  assert.equal(db.marks[0].reason, "wa_opted_out");
  assert.ok(!db.queries.some((q) => q.includes("sms_ad_blocked")), "مسار الـSMS ماتلمسش");
  assert.equal(db.deleted.length, 1, "الفلو اتمسح (مااستهلكش فترة السماح)");
});

test("القالب مش معتمد عند ميتا ⇒ مفيش نداء قالب، والـSMS بديل لو مفتاحها شغّال", async () => {
  const off = setup({ step1: [CART()], wa: { status: () => "REJECTED" } });
  await off.api.runRecovery(riyadh(18, 14));
  assert.deepEqual(off.db.waCalls.map((c) => c.kind), ["free"]);
  assert.equal(off.db.marks[0].reason, "wa_template_not_approved|sms_disabled");
  const on = setup({ step1: [CART()], wa: { status: () => "REJECTED" }, settings: { abandonedCarts: { smsEnabled: true } } });
  await on.api.runRecovery(riyadh(18, 14));
  assert.match(on.db.marks[0].reason, /^wa_template_not_approved\|sms_failed: ad sender not configured/, "الـSMS اتجرّبت (محلياً من غير مفتاح)");
  const noFb = setup({ step1: [CART()], wa: { status: () => "REJECTED" }, settings: { abandonedCarts: { smsEnabled: true, smsFallback: false } } });
  await noFb.api.runRecovery(riyadh(18, 14));
  assert.equal(noFb.db.marks[0].reason, "wa_template_not_approved|sms_fallback_off");
});

test("131049 (ميتا حدّت تسويق العميل): مفيش SMS إلا لو cappedFallbackSms", async () => {
  const tpl = () => ({ ok: false, error: "WA_131049", code: 131049 });
  const a = setup({ step1: [CART()], wa: { tpl }, settings: { abandonedCarts: { smsEnabled: true } } });
  await a.api.runRecovery(riyadh(18, 14));
  assert.equal(a.db.marks[0].reason, "wa_WA_131049:131049");
  assert.ok(!a.db.queries.some((q) => q.includes("sms_ad_blocked")));
  const b = setup({ step1: [CART()], wa: { tpl }, settings: { abandonedCarts: { smsEnabled: true }, waCloud: { cappedFallbackSms: true } } });
  await b.api.runRecovery(riyadh(18, 14));
  assert.match(b.db.marks[0].reason, /^wa_WA_131049:131049\|sms_failed/);
});

test("الحارس قال burst_hold ⇒ تأجيل: الفلو بيتمسح والسلة تفضل rec_step=0 للدورة الجاية (مش -2)", async () => {
  const { api, db } = setup({ step1: [CART()], wa: { free: () => ({ ok: false, skipped: "burst_hold", until: "x" }) } });
  await api.runRecovery(riyadh(18, 14));
  assert.equal(db.marks.length, 0);
  assert.deepEqual(db.notes, [{ device: "dev-cr3-0001", reason: "burst_hold" }]);
  assert.equal(db.deleted.length, 1);
});

test("waEnabled مقفول ⇒ زي الأول (إشعار ثم SMS) ومفيش نداء واتساب", async () => {
  const { api, db } = setup({ step1: [CART()], settings: { abandonedCarts: { waEnabled: false, smsEnabled: true } } });
  await api.runRecovery(riyadh(18, 14));
  assert.equal(db.waCalls.length, 0);
  assert.match(db.marks[0].reason, /^sms_failed/);
});

test("خطوة ٢: أول طلب ⇒ fc_cart_24h_first بـ FIRST و60، وعميل قديم ⇒ fc_cart_24h؛ step2_channel = whatsapp", async () => {
  const row = CART({ rec_step: 1, rec_flow: 71, flow_code: "ab12cd34", updated_at: riyadh(17, 20).toISOString() });
  const f = setup({ step2: [row], first: true });
  const out = await f.api.runRecovery(riyadh(18, 17, 30));
  assert.equal(out.step2, 1);
  const t = f.db.waCalls.find((c) => c.kind === "tpl");
  assert.equal(t.template, "fc_cart_24h_first");
  assert.deepEqual(t.params, { body: ["FIRST", "60"], button: ["ab12cd34"] });
  assert.match(f.db.updates[0].sql, /step2_channel/);
  assert.deepEqual(f.db.updates[0].p, [71, "whatsapp", "wamid.TEST1", 0.2159]);
  const o = setup({ step2: [row], first: false });
  await o.api.runRecovery(riyadh(18, 17, 30));
  assert.equal(o.db.waCalls.find((c) => c.kind === "tpl").template, "fc_cart_24h");
});

test("ساعات الهدوء (٢٣:٠٠) والمطعم مفتوح: واتساب بيطلع (sendhours) والإشعار لأ؛ من غير واتساب = الدورة واقفة زي الأول", async () => {
  const at = riyadh(18, 23);
  const row = CART({ updated_at: new Date(at - 40 * 60000).toISOString() });
  const w = setup({ step1: [row], push: true, settings: { hours: HOURS } });
  const out = await w.api.runRecovery(at);
  assert.equal(out.step1, 1);
  assert.equal(w.db.pushCalls, 0, "الإشعار ليه ساعات الهدوء");
  assert.equal(w.db.updates[0].p[1], "whatsapp");
  const off = setup({ step1: [row], settings: { hours: HOURS, abandonedCarts: { waEnabled: false } } });
  assert.deepEqual(await off.api.runRecovery(at), { skipped: "quiet_hours" });
});

test("آخر نص ساعة قبل القفل: سكوت (لا واتساب ولا SMS) والسلة تستنى", async () => {
  const at = riyadh(19, 1, 45);      // القفل ٠٢:٠٠، stopBeforeCloseMin ٣٠
  const row = CART({ updated_at: new Date(at - 40 * 60000).toISOString() });
  // ساعات هدوء الـSMS متعدّلة (٣→١١) عشان ٠١:٤٥ تبقى مسموحة للـSMS — واتساب لوحده اللي واقف
  const { api, db } = setup({ step1: [row], settings: { hours: HOURS, abandonedCarts: { smsEnabled: true }, cms: { campaigns: { quietStart: 3, quietEnd: 11 } } } });
  await api.runRecovery(at);
  assert.equal(db.waCalls.length, 0);
  assert.equal(db.marks.length, 0);
  assert.deepEqual(db.notes.map((n) => n.reason), ["wa_closed_hours"]);
});

test("مفيش موديول واتساب (wa مش متوصّل) ⇒ المسار القديم زي ما هو", async () => {
  const { api, db } = setup({ step1: [CART()], wa: null, settings: { abandonedCarts: { smsEnabled: true } } });
  await api.runRecovery(riyadh(18, 14));
  assert.match(db.marks[0].reason, /^sms_failed/);
});

/* ── المسارات ───────────────────────────────────────────────── */

test("فتح رابط /c/ من واتساب ⇒ utm_source=whatsapp (من ?s=wa أو من قناة الفلو لزر القالب)", async () => {
  const { app } = setup({});
  const open = async (body) => (await (await app.request("/api/carts/restore/ab12cd34/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json());
  for (const b of [{ s: "wa" }, {}]) {
    const r = await open(b);
    assert.equal(r.ok, true);
    assert.equal(new URLSearchParams(r.url.slice(2)).get("utm_source"), "whatsapp");
  }
  const p = await open({ s: "push" });
  assert.equal(new URLSearchParams(p.url.slice(2)).get("utm_source"), "push");
});

test("اللوحة: GET بيرجّع التسميات وقوالب السلة، وPUT بيحفظ المفاتيح الجديدة بنفس الدمج", async () => {
  const { app, db } = setup({});
  const g = await (await app.request("/api/carts/recovery")).json();
  assert.equal(g.ok, true);
  assert.equal(g.config.waEnabled, true);
  assert.ok(g.fields.waEnabled.ar);
  assert.ok(g.waTemplates.includes("fc_cart_24h_first"));
  assert.ok(db.queries.some((q) => q.includes("step2_channel='whatsapp'")), "عدّاد واتساب في الأرقام");
  const r = await (await app.request("/api/carts/recovery", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ waEnabled: false, waTemplate1: "fc_birthday", smsFallback: false }) })).json();
  assert.equal(r.config.waEnabled, false);
  assert.equal(r.config.waTemplate1, "fc_cart_1h", "قالب مش للسلة بيترفض للافتراضي");
  assert.equal(r.config.smsFallback, false);
});
