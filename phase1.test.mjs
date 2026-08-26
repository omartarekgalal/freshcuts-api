/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات المرحلة الأولى — «مفيش حاجة بتتبعت لحد لوحدها»

   قرار عمر (2026-08-26): المرحلة الأولى يدوية بالكامل. العميل يطلب ويدفع،
   والكاشير يدخّل الطلب بإيده على لوحة شركة التوصيل. «مش هنعلن على التوصيل
   غير لما نتأكد إن كل حاجة تمام».

   الملف ده مش بيوصف النية — بيثبتها. أهم اختبار فيه بيبدّل `fetch` نفسه
   بدالة بترسّب الاختبار لو حد نداها: يعني الإثبات مش «الكود شكله صح»، ده
   «مفيش بايت خرج على الشبكة».

     node --test phase1.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDeliveryFee, dispatchMode, canAutoDispatch, contractCourierCost,
  orderEconomics, freeThresholdFor, DEFAULT_POLICY, BENCHMARKS,
  register as registerDelivery,
} from "./delivery.js";
import { PROVIDERS } from "./couriers.js";
import { refundDecision, slaCheck, DEFAULT_SLA, register as registerShop } from "./shop.js";

/* ── أدوات: بيئة وهمية بدل process.env، وتطبيق وهمي بدل Hono ───────────── */
const fakeEnv = (map) => (k) => (map[k] || "").toString().trim();
const fakeApp = () => ({ get() {}, post() {}, put() {}, delete() {} });

/* قاعدة بيانات وهمية بترد على أنماط الاستعلامات اللي الوحدات دي بتعملها */
function fakePool(handler) {
  return { query: async (sql, vals) => (await handler(String(sql), vals)) || { rows: [], rowCount: 0 } };
}
const jb = (v) => JSON.stringify(v);

/* ═══════════════════════════════════════════════════════════════════════════
   ١) البوابة: القرار نفسه
═══════════════════════════════════════════════════════════════════════════ */

test("الافتراضي في غياب أي إعداد = يدوي", () => {
  const g = dispatchMode({}, fakeEnv({}));
  assert.equal(g.mode, "manual");
  assert.equal(g.source, "default");
});

test("الإعدادات تقدر تفتح الوضع الآلي (للمرحلة التانية)", () => {
  assert.equal(dispatchMode({ delivery: { dispatchMode: "auto" } }, fakeEnv({})).mode, "auto");
});

test("DELIVERY_FORCE_MANUAL بيكسب على الإعدادات مهما قالت", () => {
  const g = dispatchMode({ delivery: { dispatchMode: "auto" } }, fakeEnv({ DELIVERY_FORCE_MANUAL: "1" }));
  assert.equal(g.mode, "manual");
  assert.equal(g.forced, true);
});

test("قيمة غلط في الإعدادات بترجع لليدوي، مش للآلي", () => {
  // «إعداد مكتوب غلط» ما ينفعش يبقى معناه «ابعت لشركة حقيقية»
  assert.equal(dispatchMode({ delivery: { dispatchMode: "AUTOMATIC" } }, fakeEnv({})).mode, "manual");
  assert.equal(dispatchMode({ delivery: { dispatchMode: "" } }, fakeEnv({})).mode, "manual");
  assert.equal(dispatchMode(null, fakeEnv({})).mode, "manual");
});

test("متغيّر البيئة احتياطي لما الإعدادات فاضية", () => {
  assert.equal(dispatchMode({}, fakeEnv({ DELIVERY_DISPATCH_MODE: "auto" })).mode, "auto");
  // ولكن الإعدادات هي المرجع لو موجودة
  assert.equal(
    dispatchMode({ delivery: { dispatchMode: "manual" } }, fakeEnv({ DELIVERY_DISPATCH_MODE: "auto" })).mode,
    "manual");
});

test("canAutoDispatch مختصر أمين للبوابة", () => {
  assert.equal(canAutoDispatch({}, fakeEnv({})), false);
  assert.equal(canAutoDispatch({ delivery: { dispatchMode: "auto" } }, fakeEnv({})), true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٢) المزوّد اليدوي: مش بيعرف يبعت أصلاً
═══════════════════════════════════════════════════════════════════════════ */

test("المزوّد اليدوي بيرمي لو حد حاول يبعت بيه", async () => {
  await assert.rejects(() => PROVIDERS.manual.dispatch({}, {}), (e) => e.code === "MANUAL_DISPATCH_ONLY");
});

test("المزوّد اليدوي: مفيش تتبع ولا ويبهوك يتصدّق", async () => {
  assert.equal(await PROVIDERS.manual.track({}), null);
  assert.equal(PROVIDERS.manual.parseWebhook({ id: "W1", status: "Delivered" }), null);
});

test("المزوّد اليدوي مسجّل في القايمة — عشان الرجوع الافتراضي ما يوقعش على Flying Arrow", () => {
  // delivery.js بيعمل PROVIDERS[sh.provider] || PROVIDERS.flyingarrow.
  // من غير 'manual' في القايمة، شحنة يدوية كانت هتتتبّع على API شركة تانية
  // برقم مرجعي مش بتاعهم.
  assert.ok(PROVIDERS.manual, "المزوّد اليدوي مش موجود في PROVIDERS");
  assert.equal(PROVIDERS.manual.manual, true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٣) الإثبات الحقيقي: مفيش نداء شبكة في الوضع اليدوي

   بنبني وحدة التوصيل بقاعدة بيانات وهمية، وبنستبدل `fetch` العام بدالة
   بتفشّل الاختبار فوراً لو اتنادت. الاختبار بيغطي الطريقين اللي في السيستم
   (زرار الكاشير، والكنس التلقائي) لأن الاتنين بينادوا نفس delivery.dispatch.
═══════════════════════════════════════════════════════════════════════════ */

function buildDelivery(settings, envMap = {}) {
  const prev = {};
  for (const [k, v] of Object.entries({ FA_POLL_MINUTES: "0", ...envMap })) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  const pool = fakePool(async (sql) => {
    if (/count\(\*\)::int AS n FROM dl_policies/i.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const api = registerDelivery(fakeApp(), {
    pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb,
  }, {});
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return { api, restore };
}

const ORDER = {
  order_no: "W1756000000", total: 128.5, notes: "شقة 4",
  customer: { name: "محمد", phone: "0546715683" },
  address: { latitude: 21.633, longitude: 39.152, street: "شارع صاري", area: "السلامة" },
};

test("الوضع اليدوي: dispatch بترمي **قبل** أي اتصال بالشبكة", async () => {
  const { api, restore } = buildDelivery(
    { delivery: { provider: "flyingarrow" } },
    { FLYINGARROW_API_KEY: "a-real-looking-key", LEAJLAK_TOKEN: "tok", LEAJLAK_SHOP_ID: "821015895" });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; throw new Error(`ما كانش المفروض نكلّم حد: ${url}`); };
  try {
    await assert.rejects(() => api.dispatch(ORDER), (e) => e.code === "MANUAL_MODE");
    assert.equal(calls, 0, "خرج نداء شبكة والوضع يدوي — ده بالظبط اللي المفروض مستحيل");
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("المفاتيح موجودة والوضع يدوي؟ برضه ما بيبعتش", async () => {
  // الترتيب مقصود: البوابة قبل فحص المفاتيح. لو العكس، حد يحط المفاتيح
  // ويفتكر إنه حلّ المشكلة، وأول طلب حقيقي يروح لشركة لسه ما اتأكدناش منها.
  const { api, restore } = buildDelivery(
    { delivery: { provider: "leajlak" } },
    { LEAJLAK_TOKEN: "tok", LEAJLAK_SHOP_ID: "821015895" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("نداء شبكة ممنوع"); };
  try {
    await assert.rejects(() => api.dispatch(ORDER), (e) => {
      assert.equal(e.code, "MANUAL_MODE", `الخطأ الراجع: ${e.code} — ${e.message}`);
      return true;
    });
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("حتى لو الإعدادات فتحت الآلي، DELIVERY_FORCE_MANUAL بيقفل الطريق", async () => {
  const { api, restore } = buildDelivery(
    { delivery: { provider: "flyingarrow", dispatchMode: "auto" } },
    { FLYINGARROW_API_KEY: "k", DELIVERY_FORCE_MANUAL: "1" });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no"); };
  try {
    await assert.rejects(() => api.dispatch(ORDER), (e) => e.code === "MANUAL_MODE");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("المزوّد «يدوي» مختار صراحةً: برضه ممنوع الإرسال", async () => {
  const { api, restore } = buildDelivery({ delivery: { provider: "manual", dispatchMode: "auto" } }, {});
  try {
    await assert.rejects(() => api.dispatch(ORDER), (e) => e.code === "MANUAL_MODE");
  } finally { restore(); }
});

/* الاختبار المضاد — من غيره، «مفيش نداء شبكة» ممكن يكون معناه إن الدالة
   مكسورة أصلاً. ده بيثبت إن البوابة هي اللي بتمنع، ومفيش حاجة تانية. */
test("الوضع الآلي: نفس الطلب بيوصل للشبكة فعلاً (إثبات إن البوابة هي المانع)", async () => {
  const { api, restore } = buildDelivery(
    { delivery: { provider: "flyingarrow", dispatchMode: "auto" } },
    { FLYINGARROW_API_KEY: "k" });
  const realFetch = globalThis.fetch;
  let reached = null;
  globalThis.fetch = async (url) => { reached = String(url); throw new Error("boom"); };
  try {
    await api.dispatch(ORDER).catch(() => {});
    assert.ok(reached && reached.includes("/orders"), `ما وصلش للشبكة: ${reached}`);
  } finally { globalThis.fetch = realFetch; restore(); }
});

test("canAutoDispatch المربوطة بالإعدادات الحية بترجع false في المرحلة دي", async () => {
  const { api, restore } = buildDelivery({ delivery: { provider: "flyingarrow" } }, {});
  try {
    assert.equal(await api.canAutoDispatch(), false);
    assert.equal((await api.dispatchGate()).mode, "manual");
  } finally { restore(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٤) المنطقة: سقفان مستقلان (٧ كم هوائي، ١٠ كم مشوار)
═══════════════════════════════════════════════════════════════════════════ */

const ZONE = {
  baseKm: 4, baseFee: 12, perKm: 3, feeCap: 24,
  maxStraightKm: 7, maxKm: 10, routeFactor: 1.3,
  freeOverTotal: null, freeCoverMax: 12, minOrderTotal: 45,
};

test("جوّه الدايرة وجوّه المشوار: مقبول", () => {
  const r = computeDeliveryFee(ZONE, { straightKm: 5, distanceKm: 6.5, orderTotal: 90 });
  assert.equal(r.deliverable, true);
});

test("بره الدايرة الهوائية (٧ كم) مرفوض حتى لو المشوار قصير", () => {
  // حالة نظرية بس بتثبت إن الفحصين مستقلين فعلاً
  const r = computeDeliveryFee(ZONE, { straightKm: 7.4, distanceKm: 8, orderTotal: 90 });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_zone");
  assert.equal(r.maxStraightKm, 7);
});

test("جوّه الدايرة بس المشوار عدّى ١٠ كم: مرفوض بسبب تاني", () => {
  // شوارع وحشة: 6.9 كم هوائي بس الطريق 11 كم
  const r = computeDeliveryFee(ZONE, { straightKm: 6.9, distanceKm: 11, orderTotal: 90 });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
  assert.equal(r.maxKm, 10);
});

test("السقفان بيرجّعوا سبب مختلف — الشاشة تقدر تشرح للعميل", () => {
  const a = computeDeliveryFee(ZONE, { straightKm: 9, distanceKm: 9, orderTotal: 90 });
  const b = computeDeliveryFee(ZONE, { straightKm: 6, distanceKm: 12, orderTotal: 90 });
  assert.notEqual(a.reason, b.reason);
});

test("توافق خلفي: من غير straightKm الفحص الهوائي بيتخطى (اختبارات وسياسات قديمة)", () => {
  const r = computeDeliveryFee(ZONE, { distanceKm: 6, orderTotal: 90 });
  assert.equal(r.deliverable, true);
});

test("الحد الأدنى للطلب بيرفض قبل أي حساب رسوم", () => {
  const r = computeDeliveryFee(ZONE, { straightKm: 2, distanceKm: 2.6, orderTotal: 44 });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "under_minimum");
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٥) الاقتصاديات: التنازل المسقوف والعتبة
═══════════════════════════════════════════════════════════════════════════ */

test("تكلفة الكابتن بالاتفاق المطبّق (٩ لأول ٤ كم + ١.٨/كم + ضريبة)", () => {
  assert.equal(contractCourierCost(4), 10.35);            // 9 × 1.15
  assert.equal(contractCourierCost(3), 10.35);            // أقل من الباقة = نفس السعر
  // الطلب الحقيقي اللي اتأكدنا منه: 4.99 كم رجع 12.40 شامل الضريبة
  assert.equal(contractCourierCost(4.99), 12.4);
  assert.equal(contractCourierCost(9.1), 20.91);
});

test("التنازل المسقوف: «مجاني» بيشيل ١٢ ر.س بس، والباقي على العميل", () => {
  const cfg = { ...ZONE, freeOverTotal: 70 };
  // 8 كم مشوار: 12 + ceil(8-4)=4 × 3 = 24 (= السقف)
  const paid = computeDeliveryFee(cfg, { straightKm: 6, distanceKm: 8, orderTotal: 60 });
  assert.equal(paid.fee, 24);
  const free = computeDeliveryFee(cfg, { straightKm: 6, distanceKm: 8, orderTotal: 80 });
  assert.equal(free.fee, 12, "التنازل المفروض ١٢ بس مش الرسوم كلها");
});

test("قرب المطعم التنازل بيغطي الرسوم كلها فتبقى صفر", () => {
  const cfg = { ...ZONE, freeOverTotal: 70 };
  const r = computeDeliveryFee(cfg, { straightKm: 2, distanceKm: 2.6, orderTotal: 80 });
  assert.equal(r.fee, 0);
  assert.equal(r.breakdown.at(-1).includes("مجاني"), true);
});

test("من غير سقف تنازل السلوك القديم زي ما هو (التوصيل كله مجاني)", () => {
  const cfg = { ...ZONE, freeOverTotal: 70, freeCoverMax: null };
  const r = computeDeliveryFee(cfg, { straightKm: 6, distanceKm: 8, orderTotal: 80 });
  assert.equal(r.fee, 0);
});

test("اقتصاديات الطلب: الرسوم المدفوعة بتغطي الكابتن وتسيب هامش الصالة", () => {
  const e = orderEconomics({ foodTotal: 90, feeCharged: 18, routeKm: 6 });
  assert.equal(e.courierCost, 14.49);
  assert.ok(e.courierGap > 0, `الرسوم ما غطتش الكابتن: ${e.courierGap}`);
  assert.ok(e.contributionPct > BENCHMARKS.dineInContribution * 100,
    `المفروض أعلى من الصالة لما العميل بيدفع التوصيل: ${e.contributionPct}`);
});

test("العتبة المحسوبة بتحقق الهدف عند أسوأ نقطة في المنطقة", () => {
  const policy = { ...ZONE, freeOverTotal: null };
  const res = freeThresholdFor({ policy, target: 0.30 });
  assert.equal(res.ok, true);
  // التحقق المستقل: عند العتبة، أسوأ نقطة لازم توصل الهدف
  const w = res.worstPoint;
  const e = orderEconomics({ foodTotal: res.threshold, feeCharged: w.collected, routeKm: w.km });
  assert.ok(e.contributionPct >= 30,
    `العتبة ${res.threshold} بتدي ${e.contributionPct}% عند ${w.km} كم — تحت الهدف`);
  // ولازم تفضل تكسب كيتا بفارق مريح
  assert.ok(e.contributionPct > BENCHMARKS.keetaNet * 100 + 4);
});

test("هدف = صافي كيتا بيدي عتبة أقل — والعلاقة في الاتجاه الصح", () => {
  const policy = { ...ZONE, freeOverTotal: null };
  const low = freeThresholdFor({ policy, target: BENCHMARKS.keetaNet });
  const high = freeThresholdFor({ policy, target: 0.35 });
  assert.ok(low.threshold < high.threshold,
    `هدف أعلى لازم يطلب عتبة أعلى: ${low.threshold} مقابل ${high.threshold}`);
});

test("هدف أعلى من هامش الصالة مستحيل — بترفض بدل ما ترجّع رقم وهمي", () => {
  const res = freeThresholdFor({ policy: ZONE, target: 0.60 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "target_above_dine_in");
});

test("تنازل كامل (من غير سقف) بيطلب عتبة أعلى بكتير — ده سبب اختيار السقف", () => {
  const capped = freeThresholdFor({ policy: { ...ZONE, freeOverTotal: null }, target: 0.30 });
  const uncapped = freeThresholdFor({ policy: { ...ZONE, freeOverTotal: null, freeCoverMax: null }, target: 0.30 });
  assert.ok(uncapped.threshold > capped.threshold * 1.3,
    `المسقوف ${capped.threshold} / غير المسقوف ${uncapped.threshold}`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٦) الاسترجاع: القرار
═══════════════════════════════════════════════════════════════════════════ */

const PAID = { order_no: "W1", total: 128.5, mf_payment_id: "PID-9", refund_id: null, refund_attempts: 0 };

test("طلب مدفوع مرفوض: نسترجع بالمبلغ اللي العميل دفعه كامل", () => {
  const d = refundDecision(PAID);
  assert.equal(d.act, true);
  assert.equal(d.amount, 128.5, "المبلغ لازم يكون total مش subtotal — التوصيل والبقشيش يرجعوا كمان");
});

test("مرة واحدة بس: refund_id موجود يعني وقف", () => {
  const d = refundDecision({ ...PAID, refund_id: "R-1" });
  assert.equal(d.act, false);
  assert.equal(d.reason, "already_refunded");
});

test("من غير دفعة مفيش استرجاع", () => {
  assert.equal(refundDecision({ ...PAID, mf_payment_id: null }).reason, "never_paid");
  assert.equal(refundDecision({ ...PAID, total: 0 }).reason, "zero_amount");
  assert.equal(refundDecision(null).reason, "no_order");
});

test("سقف المحاولات بيوقف الضرب على البوابة", () => {
  assert.equal(refundDecision({ ...PAID, refund_attempts: 3 }).act, false);
  assert.equal(refundDecision({ ...PAID, refund_attempts: 2 }).act, true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٧) الاسترجاع: التنفيذ — وأهم حاجة، إنه ما يكدبش

   بنبني shop.js على قاعدة بيانات وهمية وبوابة دفع وهمية، وبنتأكد إن فشل
   الاسترجاع بيروح لحالة `refund_failed` مش `rejected_refunded`. الحالة
   التانية بتبعت للعميل «تم استرجاع المبلغ كاملاً لبطاقتك» — وفلوسه معانا.
═══════════════════════════════════════════════════════════════════════════ */

function buildShop({ order, pay }) {
  const db = { ...order };
  const prev = process.env.SHOP_SWEEP_SECONDS;
  process.env.SHOP_SWEEP_SECONDS = "0";
  const pool = fakePool(async (sql, vals) => {
    if (/^\s*SELECT \* FROM shop_orders WHERE order_no/i.test(sql)) return { rows: [{ ...db }], rowCount: 1 };
    if (/refund_attempts = refund_attempts \+ 1/i.test(sql)) { db.refund_attempts = (db.refund_attempts || 0) + 1; return { rowCount: 1 }; }
    if (/^\s*UPDATE shop_orders SET status=\$2/i.test(sql)) {
      db.status = vals[1];
      // الأعمدة الزيادة بتيجي بعد الـ3 الأساسيين، بالترتيب اللي setStatus بيبنيه
      const cols = sql.match(/, (\w+)=\$(\d+)/g) || [];
      for (const m of cols) {
        const [, col, idx] = m.match(/, (\w+)=\$(\d+)/);
        db[col] = vals[Number(idx) - 1];
      }
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const api = registerShop(fakeApp(), {
    pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
    getSettingsData: async () => ({}), jb, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
  }, { pay, delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null,
                        dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false } });
  const restore = () => {
    if (prev === undefined) delete process.env.SHOP_SWEEP_SECONDS; else process.env.SHOP_SWEEP_SECONDS = prev;
  };
  return { api, db, restore };
}

test("استرجاع ناجح: الحالة بتبقى «مسترجع» ورقم الاسترجاع بيتخزّن", async () => {
  const { api, db, restore } = buildShop({
    order: { ...PAID, status: "pos_created", option: "delivery" },
    pay: { makeRefund: async ({ amount }) => ({ RefundId: "RF-77", amount }) },
  });
  try {
    const res = await api.refundOrder({ ...PAID, status: "pos_created" }, "rejected");
    assert.equal(res.ok, true);
    assert.equal(db.status, "rejected_refunded");
    assert.equal(db.refund_id, "RF-77");
  } finally { restore(); }
});

test("فشل الاسترجاع **ما يقولش** للعميل إن فلوسه رجعت", async () => {
  const { api, db, restore } = buildShop({
    order: { ...PAID, status: "pos_created", option: "delivery" },
    pay: { makeRefund: async () => { throw new Error("MyFatoorah: refund window closed"); } },
  });
  try {
    const res = await api.refundOrder({ ...PAID, status: "pos_created" }, "rejected");
    assert.equal(res.ok, false);
    assert.equal(db.status, "refund_failed",
      "الحالة رجعت rejected_refunded — دي بتبعت للعميل «تم استرجاع المبلغ» وهو ما رجعش");
    assert.ok(!db.refund_id, "ما ينفعش نسجّل رقم استرجاع لاسترجاع ما تمّش");
    // ولازم يفضل قابل لإعادة المحاولة: refund_id فاضي معناه القرار لسه «اعمل»
    assert.equal(refundDecision({ ...PAID, refund_attempts: 1 }).act, true);
  } finally { restore(); }
});

test("الاسترجاع الفاشل بيفضل إنذار درجة ٣ لحد ما بني آدم يشوفه", () => {
  const v = slaCheck({ status: "refund_failed", created_at: Date.now(), updated_at: Date.now() });
  assert.equal(v.level, 3);
  assert.equal(v.action, "manual_refund");
});

test("عدّاد المحاولات بيزيد مع كل محاولة — سقف الثلاثة بيشتغل فعلاً", async () => {
  const { api, db, restore } = buildShop({
    order: { ...PAID, status: "pos_created" },
    pay: { makeRefund: async () => { throw new Error("nope"); } },
  });
  try {
    await api.refundOrder({ ...PAID, status: "pos_created" }, "x");
    assert.equal(db.refund_attempts, 1);
  } finally { restore(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٨) شبكة الأمان: مراقب المهل
═══════════════════════════════════════════════════════════════════════════ */

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

test("طلب اتقبل والكاشير ما دخّلوش على لوحة الشركة: تنبيه ثم تصعيد", () => {
  const base = { status: "accepted", option: "delivery", created_at: ago(30) };
  assert.equal(slaCheck({ ...base, updated_at: ago(5) }).level, 0);
  const late = slaCheck({ ...base, updated_at: ago(12) });
  assert.equal(late.level, 1);
  assert.equal(late.action, "manual_handoff");
  assert.equal(slaCheck({ ...base, updated_at: ago(25) }).level, 2);
});

test("الاستلام مش بيصعّد لطلبات الاستلام من الفرع", () => {
  // ما فيش لوحة شركة توصيل نكتب عليها أصلاً
  assert.equal(slaCheck({ status: "accepted", option: "pickup", created_at: ago(60), updated_at: ago(60) }).level, 0);
});

test("طلب مدفوع ومحدش قبله: تنبيه، تصعيد، وبعدين استرجاع تلقائي", () => {
  const at = (m) => slaCheck({ status: "pos_created", option: "delivery", created_at: ago(m), updated_at: ago(m) });
  assert.equal(at(4).level, 0);
  assert.equal(at(10).level, 1);
  assert.equal(at(17).level, 2);
  const dead = at(30);
  assert.equal(dead.level, 3);
  assert.equal(dead.action, "auto_refund");
});

test("الاسترجاع التلقائي بيحصل بس لو المطعم **ما قبلش** — مش بعد ما الأكل اتعمل", () => {
  // اتقبل ⇒ في أكل اتجهّز وممكن كابتن ماسكه. القرار لبني آدم مش لكود.
  const accepted = slaCheck({ status: "accepted", option: "delivery", created_at: ago(120), updated_at: ago(120) });
  assert.notEqual(accepted.action, "auto_refund");
  const onWay = slaCheck({ status: "on_the_way", option: "delivery", created_at: ago(200), updated_at: ago(200) });
  assert.notEqual(onWay.action, "auto_refund");
});

test("مدفوع وما وصلش النظام = تصعيد فوري (الفلوس اتاخدت والمطبخ ما يعرفش)", () => {
  const v = slaCheck({ status: "paid_pos_failed", created_at: ago(7), updated_at: ago(7) });
  assert.equal(v.level, 2);
  assert.equal(v.action, "retry_pos");
});

test("الكابتن اتأخر على المطعم: تنبيه ثم تصعيد", () => {
  const at = (m) => slaCheck({ status: "courier_requested", option: "delivery", created_at: ago(m + 20), updated_at: ago(m) });
  assert.equal(at(10).level, 0);
  assert.equal(at(30).level, 1);
  assert.equal(at(50).level, 2);
});

test("المهل قابلة للتعديل من الإعدادات من غير ما نلمس كود", () => {
  const strict = slaCheck({ status: "accepted", option: "delivery", created_at: ago(30), updated_at: ago(4) },
    { handoffMinutes: 3 });
  assert.equal(strict.level, 1);
  assert.ok(DEFAULT_SLA.handoffMinutes > 3);
});

test("طلب خلص بسلام ما بيزعقش", () => {
  assert.equal(slaCheck({ status: "delivered", created_at: ago(300), updated_at: ago(200) }).level, 0);
  assert.equal(slaCheck({ status: "rejected_refunded", created_at: ago(300), updated_at: ago(200) }).level, 0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ٩) السياسة الافتراضية ما اتغيّرتش من تحت إيد عمر
═══════════════════════════════════════════════════════════════════════════ */

test("الافتراضي لسه من غير سقف هوائي — المنطقة بتتفعّل بقرار مش بنشر", () => {
  // عمر قال «مش هنعلن على التوصيل غير لما نتأكد». تغيير الافتراضي كان
  // هيطبّق دايرة ٧ كم على السياسة الشغالة من غير ما يضغط حاجة.
  assert.equal(DEFAULT_POLICY.maxStraightKm, null);
  assert.equal(DEFAULT_POLICY.freeCoverMax, null);
  assert.equal(DEFAULT_POLICY.freeOverTotal, null);
});
