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

/* ══ CR4 (عمر ١٩/١٠: «خلي السلات تاخد رسالتين ف الاسبوع ولو اشترى ميجلوش رسالة تاني غير لو عمل سلة في جلسة جديدة») ══
   محاكاة صغيرة بالذاكرة لجداول shop_carts / cart_recovery / shop_orders — نفس الاستعلامات اللي carts.js بيبعتها،
   عشان نمشي أسبوع كامل: لقطات من المتجر ⇒ دورات الحارس ⇒ طلب ⇒ سلة جديدة. أرقام وهمية، مفيش شبكة. */
const RIYADH_DAY = (d) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
function sim({ settings = {}, push = false } = {}) {
  const st = { carts: new Map(), flows: [], orders: [], now: riyadh(18, 12), wa: [], pushes: 0, seq: 0 };
  const T = (v) => new Date(v).getTime();
  const pool = {
    query: async (sql, p = []) => {
      const s = String(sql), now = st.now;
      if (s.includes("INSERT INTO shop_carts")) {
        const [device, phone, stage] = p, ex = st.carts.get(device);
        const base = ex || { device_id: device, rec_step: 0, rec_flow: null, rec_note: null, recovered_order: null, items: [], cart_raw: null };
        if (ex && ex.recovered_order && stage !== "ordered") Object.assign(base, { rec_step: 0, rec_flow: null, recovered_order: null });
        Object.assign(base, { phone_norm: phone || base.phone_norm || null, stage, item_count: p[4], subtotal: p[5], option: p[6], updated_at: now.toISOString() });
        st.carts.set(device, base);
        return { rows: [], rowCount: 1 };
      }
      if (s.includes("FROM shop_carts c") && s.includes("c.rec_step = 0")) {
        const rows = [...st.carts.values()].filter((c) => !c.recovered_order && c.item_count > 0 && c.phone_norm && c.rec_step === 0 && c.subtotal >= p[0]
          && T(c.updated_at) < T(p[1]) - Number(p[2]) * 60000 && T(c.updated_at) > T(p[1]) - 3 * 86400000);
        return { rows: rows.map((c) => ({ ...c })), rowCount: rows.length };
      }
      if (s.includes("FROM shop_carts c") && s.includes("c.rec_step IN (1, -2)")) {
        const rows = [...st.carts.values()].filter((c) => !c.recovered_order && c.item_count > 0 && c.phone_norm && [1, -2].includes(c.rec_step) && c.subtotal >= p[0]
          && RIYADH_DAY(T(c.updated_at) + 86400000) === p[1]);
        return { rows: rows.map((c) => ({ ...c, flow_code: (st.flows.find((f) => f.id === c.rec_flow) || {}).code || null })), rowCount: rows.length };
      }
      if (s.includes("FROM shop_orders WHERE phone_norm=$1 AND")) {
        const r = st.orders.filter((o) => o.phone === p[0] && T(o.created_at) > T(p[1]));
        return { rows: r.slice(0, 1).map((o) => ({ order_no: o.no, total: 100 })), rowCount: r.length ? 1 : 0 };
      }
      if (s.includes("INSERT INTO cart_recovery")) { const f = { id: ++st.seq, code: p[0], phone: p[1], device: p[2], started_at: now.toISOString() }; st.flows.push(f); return { rows: [{ id: f.id, code: f.code }], rowCount: 1 }; }
      if (s.includes("DELETE FROM cart_recovery")) { st.flows = st.flows.filter((f) => f.id !== p[0]); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE cart_recovery SET step1_channel")) { Object.assign(st.flows.find((f) => f.id === p[0]), { step1_channel: p[1], step1_at: now.toISOString() }); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE cart_recovery SET step2_channel")) { Object.assign(st.flows.find((f) => f.id === p[0]), { step2_channel: p[1], step2_at: now.toISOString() }); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE shop_carts SET rec_step")) { const c = st.carts.get(p[0]); Object.assign(c, { rec_step: p[1], rec_note: p[2], rec_flow: p[3] || c.rec_flow }); return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE shop_carts SET rec_note")) { st.carts.get(p[0]).rec_note = p[1]; return { rows: [], rowCount: 1 }; }
      if (s.includes("UPDATE shop_carts SET stage='ordered'")) {
        let n = 0;
        for (const c of st.carts.values()) if ((c.device_id === p[1] || (c.phone_norm && c.phone_norm === p[0])) && !c.recovered_order) {
          Object.assign(c, { stage: "ordered", recovered_order: p[2], updated_at: now.toISOString() }); n++;
        }
        return { rows: [], rowCount: n };
      }
      if (s.includes("/*cr4:cap*/")) {
        const from = T(p[1]) - Number(p[2]) * 86400000;
        let n = 0;
        for (const f of st.flows.filter((x) => x.phone === p[0])) {
          if (["whatsapp", "sms"].includes(f.step1_channel) && T(f.step1_at) > from) n++;
          if (["whatsapp", "sms"].includes(f.step2_channel) && T(f.step2_at) > from) n++;
        }
        return { rows: [{ n }], rowCount: 1 };
      }
      if (s.includes("FROM wa_optins WHERE phone_norm=$1 AND (stopped_at")) return { rows: [{ stopped: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const fakeWa = {
    sendFreeform: async () => ({ ok: false, skipped: "window_closed" }),
    sendTemplate: async (a) => { st.wa.push({ at: st.now.toISOString(), template: a.template, phone: a.phoneNorm }); return { ok: true, wamid: "wamid.CR4" }; },
    templateStatusOf: async () => "APPROVED",
  };
  const notify = { sendToAudience: async () => { st.pushes++; return push; } };
  const app = new Hono();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (v) => JSON.stringify(v),
    normPhone: (v) => String(v || "").replace(/\D/g, "").replace(/^(966|0)/, "") };
  const api = register(app, ctx, { notify, wa: () => fakeWa });
  const at = (d) => { st.now = d; };
  const snap = async (deviceId, stage = "cart", subtotal = 95) => {
    const r = await app.request("/api/carts/snapshot", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, phone: "0" + PHONE, stage, subtotal, items: [{ id: 1, name: "مشكل", qty: 2, price: subtotal / 2 }] }) });
    assert.equal(r.status, 200);
  };
  const tick = () => api.runRecovery(st.now);
  const order = async (deviceId, no) => { st.orders.push({ phone: PHONE, no, created_at: st.now.toISOString() }); await api.markOrdered({ phoneNorm: PHONE, deviceId, orderNo: no }); };
  return { st, api, app, at, snap, tick, order, cart: (d) => st.carts.get(d) };
}

test("CR4 الإعداد: maxPerWeek افتراضي ٢ (من ١ لـ١٠) وليه تسمية عربي في اللوحة، والـGET بيرجّعه والـPUT بيحفظه", async () => {
  assert.equal(CART_DEFAULTS.maxPerWeek, 2);
  assert.equal(cartCfg({}).maxPerWeek, 2);
  assert.equal(cartCfg({ abandonedCarts: { maxPerWeek: 0 } }).maxPerWeek, 1);
  assert.equal(cartCfg({ abandonedCarts: { maxPerWeek: 99 } }).maxPerWeek, 10);
  assert.equal(cartCfg({ abandonedCarts: { maxPerWeek: "x" } }).maxPerWeek, 2);
  assert.deepEqual(CART_FIELDS.maxPerWeek && [CART_FIELDS.maxPerWeek.type, CART_FIELDS.maxPerWeek.min, CART_FIELDS.maxPerWeek.max], ["int", 1, 10]);
  assert.match(CART_FIELDS.maxPerWeek.ar, /أقصى رسايل للعميل في الأسبوع/);
  assert.match(CART_FIELDS.maxPerWeek.hint, /الإشعار/, "الهينت بيقول إن الإشعار مش محسوب");
  const { app } = setup({ settings: { abandonedCarts: { maxPerWeek: 3 } } });
  const g = await (await app.request("/api/carts/recovery")).json();
  assert.equal(g.config.maxPerWeek, 3);
  assert.equal(g.defaults.maxPerWeek, 2);
  assert.ok(g.fields.maxPerWeek.ar);
  const r = await (await app.request("/api/carts/recovery", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPerWeek: 1 }) })).json();
  assert.equal(r.config.maxPerWeek, 1);
});

test("CR4: سلتين في نفس الأسبوع (جهازين، نفس الجوال) ⇒ رسالتين بالكتير؛ التالتة لأ؛ وبعد ما الأسبوع يعدّي السلة الجديدة تاخد تاني", async () => {
  const w = sim();
  w.at(riyadh(18, 13)); await w.snap("dev-cr4-aaaa"); await w.snap("dev-cr4-bbbb");
  w.at(riyadh(18, 14)); await w.tick();
  assert.equal(w.st.wa.length, 2, "خطوة ١ للسلتين");
  w.at(riyadh(19, 17, 30)); const o2 = await w.tick();
  assert.equal(o2.step2, 0);
  assert.equal(w.st.wa.length, 2, "خطوة ٢ اتمنعت للاتنين (السقف)");
  assert.deepEqual([w.cart("dev-cr4-aaaa").rec_step, w.cart("dev-cr4-aaaa").rec_note], [-3, "weekly_cap"]);
  w.at(riyadh(20, 13)); await w.snap("dev-cr4-cccc");
  w.at(riyadh(20, 14)); await w.tick();
  assert.equal(w.st.wa.length, 2, "سلة تالتة في نفس الأسبوع ⇒ سكوت");
  assert.deepEqual([w.cart("dev-cr4-cccc").rec_step, w.cart("dev-cr4-cccc").rec_note], [-1, "weekly_cap"], "-1 = خلصت، مفيش خطوة ٢");
  assert.equal(w.st.flows.length, 2, "مفيش فلو اتعمل للسلة الممنوعة (والإشعار اتجرّب ورجع لأ)");
  w.at(riyadh(25, 13)); await w.snap("dev-cr4-dddd");
  w.at(riyadh(25, 14, 30)); await w.tick();
  assert.equal(w.st.wa.length, 3, "بعد ٧ أيام من أول رسالتين ⇒ السلة الجديدة تاخد");
});

test("CR4: خطوة ٢ بتتمنع لما السقف يتملي (maxPerWeek=١)، وبالافتراضي (٢) بتطلع", async () => {
  const one = sim({ settings: { abandonedCarts: { maxPerWeek: 1 } } });
  one.at(riyadh(18, 13)); await one.snap("dev-cr4-aaaa");
  one.at(riyadh(18, 14)); await one.tick();
  one.at(riyadh(19, 17, 30)); await one.tick();
  assert.deepEqual(one.st.wa.map((x) => x.template), ["fc_cart_1h"]);
  assert.deepEqual([one.cart("dev-cr4-aaaa").rec_step, one.cart("dev-cr4-aaaa").rec_note], [-3, "weekly_cap"]);
  const two = sim();
  two.at(riyadh(18, 13)); await two.snap("dev-cr4-aaaa");
  two.at(riyadh(18, 14)); await two.tick();
  two.at(riyadh(19, 17, 30)); await two.tick();
  assert.deepEqual(two.st.wa.map((x) => x.template), ["fc_cart_1h", "fc_cart_24h"]);
});

test("CR4: الإشعار مش محسوب — السقف مليان والعميل مشترك ⇒ الإشعار بيطلع، وخطوة ٢ (واتساب) لأ؛ مش مشترك ⇒ ولا حاجة", async () => {
  const prior = (w) => { for (const id of [901, 902]) w.st.flows.push({ id, code: "old" + id, phone: PHONE, started_at: riyadh(17, 14).toISOString(), step1_channel: "whatsapp", step1_at: riyadh(17, 14).toISOString() }); };
  const p = sim({ push: true }); prior(p);
  p.at(riyadh(18, 13)); await p.snap("dev-cr4-aaaa");
  p.at(riyadh(18, 14)); const o = await p.tick();
  assert.equal(o.step1, 1); assert.equal(p.st.pushes, 1); assert.equal(p.st.wa.length, 0);
  p.at(riyadh(19, 17, 30)); await p.tick();
  assert.equal(p.st.wa.length, 0, "خطوة ٢ واتساب ⇒ السقف");
  assert.equal(p.cart("dev-cr4-aaaa").rec_note, "weekly_cap");
  const n = sim({ push: false }); prior(n);
  n.at(riyadh(18, 13)); await n.snap("dev-cr4-aaaa");
  n.at(riyadh(18, 14)); await n.tick();
  assert.equal(n.st.pushes, 1, "الإشعار اتجرّب (ببلاش)"); assert.equal(n.st.wa.length, 0);
  assert.deepEqual([n.cart("dev-cr4-aaaa").rec_step, n.cart("dev-cr4-aaaa").rec_note], [-1, "weekly_cap"]);
  assert.equal(n.st.flows.length, 2, "الفلو اللي اتعمل للمحاولة اتمسح");
  // الإشعار مقفول من اللوحة ⇒ مفيش فلو أصلاً
  const off = sim({ settings: { abandonedCarts: { pushEnabled: false } } }); prior(off);
  off.at(riyadh(18, 13)); await off.snap("dev-cr4-aaaa");
  off.at(riyadh(18, 14)); await off.tick();
  assert.equal(off.st.pushes, 0); assert.equal(off.st.flows.length, 2);
});

test("CR4: الشراء بيوقف خطوة ٢ (markOrdered بيقفل السلة، ولو ماتنداش orderedSince بيمسكها)", async () => {
  const w = sim();
  w.at(riyadh(18, 13)); await w.snap("dev-cr4-aaaa");
  w.at(riyadh(18, 14)); await w.tick();
  w.at(riyadh(18, 15)); await w.order("dev-cr4-aaaa", "W100");
  assert.equal(w.cart("dev-cr4-aaaa").recovered_order, "W100");
  w.at(riyadh(19, 17, 30)); const o = await w.tick();
  assert.equal(o.step2, 0); assert.equal(w.st.wa.length, 1, "رسالة خطوة ١ بس");
  // markOrdered ماوصلش (طلب من مسار تاني) ⇒ orderedSince ⇒ rec_step 9
  const x = sim();
  x.at(riyadh(18, 13)); await x.snap("dev-cr4-aaaa");
  x.at(riyadh(18, 14)); await x.tick();
  x.at(riyadh(18, 15)); x.st.orders.push({ phone: PHONE, no: "W200", created_at: x.st.now.toISOString() });
  x.at(riyadh(19, 17, 30)); await x.tick();
  assert.equal(x.st.wa.length, 1);
  assert.deepEqual([x.cart("dev-cr4-aaaa").rec_step, x.cart("dev-cr4-aaaa").rec_note], [9, "ordered"]);
});

test("CR4: بعد الشراء — سلة قديمة على جهاز تاني مابتاخدش رسالة؛ سلة جديدة (لقطة بعد الطلب) بس هي اللي ترجع، وتحت السقف", async () => {
  const w = sim();
  w.at(riyadh(18, 13)); await w.snap("dev-cr4-aaaa");
  w.at(riyadh(18, 14)); await w.tick();
  assert.equal(w.st.wa.length, 1);
  w.at(riyadh(18, 14, 10)); await w.snap("dev-cr4-bbbb");           // سلة على جهاز تاني بنفس الجوال
  w.at(riyadh(18, 14, 20)); await w.order("dev-cr4-aaaa", "W300");  // اشترى من الجهاز الأول
  assert.equal(w.cart("dev-cr4-bbbb").recovered_order, "W300", "markOrdered قفل كل سلات الجوال");
  w.at(riyadh(18, 16)); await w.tick();
  w.at(riyadh(19, 17, 30)); await w.tick();
  assert.equal(w.st.wa.length, 1, "السلة القديمة ماخدتش ولا خطوة ١ ولا ٢");
  // سلة جديدة في جلسة جديدة على الجهاز الأول ⇒ اللقطة بتصفّر rec_step ⇒ مؤهلة (الرسالة التانية في الأسبوع)
  w.at(riyadh(20, 13)); await w.snap("dev-cr4-aaaa");
  assert.deepEqual([w.cart("dev-cr4-aaaa").rec_step, w.cart("dev-cr4-aaaa").recovered_order], [0, null]);
  w.at(riyadh(20, 14)); await w.tick();
  assert.equal(w.st.wa.length, 2);
  w.at(riyadh(21, 17, 30)); await w.tick();
  assert.equal(w.st.wa.length, 2, "خطوة ٢ للسلة الجديدة ⇒ السقف (٢ في الأسبوع)");
  // لقطة «ordered» بعد الطلب مابتفتحش السلة
  const y = sim();
  y.at(riyadh(18, 13)); await y.snap("dev-cr4-aaaa");
  y.at(riyadh(18, 13, 20)); await y.order("dev-cr4-aaaa", "W400");
  y.at(riyadh(18, 13, 21)); await y.snap("dev-cr4-aaaa", "ordered");
  y.at(riyadh(18, 15)); await y.tick();
  assert.equal(y.st.wa.length, 0);
  assert.equal(y.cart("dev-cr4-aaaa").recovered_order, "W400");
});

test("CR4: الطريق الوحيد لرجوع سلة لـrec_step=0 هو اللقطة (upsert لما recovered_order موجود والمرحلة مش ordered)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./carts.js", import.meta.url), "utf8");
  // كل كتابة في rec_step: يا الـupsert (CASE) يا mark() بـ$2 — مفيش «SET rec_step=0» في أي حتة
  const writes = (src.match(/SET[^`"]*?rec_step\s*=\s*[^,\s]+|rec_step\s*=\s*CASE/g) || []).map((x) => x.replace(/^SET[^]*?rec_step/, "SET rec_step").replace(/\s+/g, " "));
  assert.deepEqual(writes, ["SET rec_step = CASE", "SET rec_step=$2"], writes.join(" | "));
  assert.match(src, /rec_step = CASE WHEN EXCLUDED\.stage <> 'ordered' AND shop_carts\.recovered_order IS NOT NULL\s+THEN 0 ELSE shop_carts\.rec_step END/);
  for (const m of src.matchAll(/mark\(row\.device_id,\s*([^,]+),/g)) assert.notEqual(m[1].trim(), "0", m[0]);
});
