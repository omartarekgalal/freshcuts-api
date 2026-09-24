import test from "node:test";
import assert from "node:assert/strict";
import {
  KM_BANDS, ETA_DEFAULTS, bandOf, quantile, summarise, roundWindow, windowText,
  promiseText, safetyFor, buildModel, modelVersion, estimate, renderPromise,
  scoreModel, evaluate, rowsToSamples, SAMPLES_SQL,
  register,
} from "./eta.js";

/* عيّنة مصنوعة على شكل اللي قسناه فعلاً (٢٤ سبتمبر ٢٠٢٦، ٧٠ طلب):
   الوسيط ~٦٠ دقيقة، وبيكبر مع المسافة، وفيه ذيل. مش نسخة من الداتا
   الحقيقية — الغرض إن الاختبار يمسك المنطق مش الأرقام. */
function sampleSet({ days = 10, perDay = 8, incident = false } = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const bizDay = `2026-09-${String(10 + d).padStart(2, "0")}`;
    for (let i = 0; i < perDay; i++) {
      const km = [2, 3, 5, 6, 8, 9, 12, 13][i % 8];
      const base = 45 + km * 1.8;
      out.push({ orderNo: `T${d}-${i}`, km, bizDay, provider: "leajlak",
                 totalMin: base + (i % 4) * 6 + (d % 3) * 3 });
    }
  }
  if (incident) out.push({ orderNo: "INC", km: 5, bizDay: "2026-09-19", provider: "external", totalMin: 766 });
  return out;
}

test("bandOf: المسافة بتتقسّم لخانات، والحدود ثابتة", () => {
  assert.equal(bandOf(0)?.id, "0-4");
  assert.equal(bandOf(3.99)?.id, "0-4");
  assert.equal(bandOf(4)?.id, "4-7");
  assert.equal(bandOf(6.9)?.id, "4-7");
  assert.equal(bandOf(7)?.id, "7-10");
  assert.equal(bandOf(10)?.id, "10-15");
  assert.equal(bandOf(15)?.id, "15+");
  assert.equal(bandOf(99)?.id, "15+");
  assert.equal(KM_BANDS.length, 5);
});

test("bandOf: «مش عارفين المسافة» مش زي «المسافة صفر»", () => {
  assert.equal(bandOf(null), null);
  assert.equal(bandOf(undefined), null);
  assert.equal(bandOf(""), null);
  assert.equal(bandOf("abc"), null);
  assert.equal(bandOf(-1), null);
  assert.equal(bandOf(0)?.id, "0-4");     // صفر مسافة معروفة
  assert.equal(bandOf("7.5")?.id, "7-10"); // نص من الـquery string
});

test("quantile: تداخل خطي على مصفوفة مرتّبة", () => {
  const v = [10, 20, 30, 40, 50];
  assert.equal(quantile(v, 0), 10);
  assert.equal(quantile(v, 0.5), 30);
  assert.equal(quantile(v, 1), 50);
  assert.equal(quantile(v, 0.25), 20);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.5), null);
});

test("summarise: الوسيط والأطراف — والمتوسط موجود للمقارنة مش للوعد", () => {
  const s = summarise([10, 10, 20, 30, 40, 100]);
  assert.equal(s.n, 6);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.p50, 25);
  // المتوسط (35) أكبر من الوسيط (25) — ده بالظبط سبب إن الوعد كوانتايل
  assert.ok(s.mean > s.p50);
  assert.ok(s.sd > 0);
  assert.equal(summarise([]).n, 0);
  assert.equal(summarise([]).p50, null);
  assert.equal(summarise([NaN, undefined, 5]).n, 1);
});

test("roundWindow: التقريب دايماً في اتجاه الأمان", () => {
  const w = roundWindow(53, 79);
  assert.equal(w.lowMin, 50);  // لتحت
  assert.equal(w.highMin, 80); // لفوق — التقريب مايكسرش وعد
  const tight = roundWindow(58, 62);
  assert.equal(tight.highMin - tight.lowMin, ETA_DEFAULTS.minWindowMin);
  const exact = roundWindow(55, 80);
  assert.deepEqual(exact, { lowMin: 55, highMin: 80 });
});

test("roundWindow: مابيرجّعش صفر ولا نطاق مقلوب", () => {
  const w = roundWindow(0, 1);
  assert.ok(w.lowMin >= ETA_DEFAULTS.roundStepMin);
  assert.ok(w.highMin > w.lowMin);
  assert.ok(w.highMin - w.lowMin >= ETA_DEFAULTS.minWindowMin);
});

test("النصوص: أرقام لاتينية زي باقي نصوص السيستم، والوعد هو الحد الأقصى", () => {
  assert.equal(windowText(45, 60), "45–60 دقيقة");
  assert.equal(promiseText(90), "نوصلك خلال 90 دقيقة");
});

test("safetyFor: الهامش تمن الشك — بيصغر لما العيّنة تكبر", () => {
  assert.equal(safetyFor(70), ETA_DEFAULTS.safetyMin);
  assert.equal(safetyFor(ETA_DEFAULTS.minTotalSamples), Math.round(ETA_DEFAULTS.safetyMin / 2));
  assert.equal(safetyFor(ETA_DEFAULTS.minTotalSamples * 3), 0);
  assert.equal(safetyFor(0), ETA_DEFAULTS.safetyMin);
});

test("buildModel: الجدول فيه صف لكل خانة، والوعد بيكبر مع المسافة", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  for (const b of KM_BANDS) assert.ok(m.bands[b.id], `خانة ${b.id} ناقصة`);
  assert.ok(m.bands["0-4"].highMin < m.bands["10-15"].highMin);
  assert.ok(m.bands["0-4"].n > 0);
  assert.equal(m.bands["15+"].n, 0);            // مافيش طلبات فوق ١٥ كم
  assert.equal(m.bands["15+"].thin, true);
  assert.equal(m.bands["15+"].source, "pool+pad");
  assert.match(m.version, /^v1-[a-z0-9]+$/);
});

test("buildModel: الحوادث بتتشال من الأرقام بس بتتعدّ — مش بتختفي", () => {
  const clean = buildModel(sampleSet({ days: 10, perDay: 8 }));
  const dirty = buildModel(sampleSet({ days: 10, perDay: 8, incident: true }));
  assert.equal(dirty.samples.incidents, 1);
  assert.equal(clean.samples.incidents, 0);
  // الحادثة (٧٦٦ دقيقة) مادخلتش في الكوانتايلات، فالجدول مااتحركش
  assert.equal(dirty.bands["4-7"].highMin, clean.bands["4-7"].highMin);
  assert.equal(dirty.samples.total, clean.samples.total);
});

test("buildModel: خانة رقيقة بتوسّع مش بتخترع دقّة", () => {
  // خانتين بس فيهم بيانات، و«7-10» فيها ٣ طلبات بس
  const s = [
    ...Array.from({ length: 20 }, (_, i) => ({ km: 2, bizDay: "2026-09-10", totalMin: 50 + i })),
    { km: 8, bizDay: "2026-09-10", totalMin: 70 },
    { km: 8, bizDay: "2026-09-11", totalMin: 75 },
    { km: 8, bizDay: "2026-09-12", totalMin: 80 },
  ];
  const m = buildModel(s);
  assert.equal(m.bands["7-10"].thin, true);
  assert.equal(m.bands["7-10"].n, 3);
  assert.equal(m.bands["0-4"].thin, false);
  // الرقيقة لازم تبقى **أوسع** من السمينة، مش أضيق
  const thinW = m.bands["7-10"].highMin - m.bands["7-10"].lowMin;
  const fatW = m.bands["0-4"].highMin - m.bands["0-4"].lowMin;
  assert.ok(thinW >= fatW, `الخانة الرقيقة (${thinW}) لازم تبقى أوسع من (${fatW})`);
  assert.match(m.bands["7-10"].source, /pool/);
});

test("estimate: استقرار — عميلين في نفس الخانة بياخدوا نفس الرد بالحرف", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const a = estimate(m, { km: 4.01 });
  const b = estimate(m, { km: 6.99 });
  assert.deepEqual({ ...a, why: null }, { ...b, why: null });
  assert.equal(a.promiseKey, b.promiseKey);
  // و٣٬٩٩ لازم تبقى خانة تانية — الحدود حقيقية
  assert.notEqual(estimate(m, { km: 3.99 }).promiseKey, a.promiseKey);
});

test("estimate: حجم السلة والساعة مالهمش أي أثر (مش مدخلات أصلاً)", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const plain = estimate(m, { km: 5 });
  const noisy = estimate(m, { km: 5, subtotal: 900, hour: 23, lines: 14, load: 9 });
  assert.equal(plain.promiseKey, noisy.promiseKey);
  assert.equal(plain.text, noisy.text);
});

test("estimate: مسافة مش معروفة = رد أوسع، مش رد واثق", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const near = estimate(m, { km: 2 });
  const blind = estimate(m, {});
  assert.equal(blind.ok, true);
  assert.equal(blind.why.band, null);
  assert.ok(blind.highMin - blind.lowMin >= near.highMin - near.lowMin);
  assert.equal(blind.confidence, "low");
  assert.equal(blind.showToCustomer, false); // خانة رقيقة عمرها ما تتعرض
});

test("estimate: المدخلات والمخرجات مكشوفة — المالك يقدر يشوف الرقم جاب منين", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const e = estimate(m, { km: 8.4 });
  assert.equal(e.why.km, 8.4);
  assert.equal(e.why.band, "7-10");
  assert.ok(e.why.basedOn > 0);
  assert.equal(e.why.quantiles.low, ETA_DEFAULTS.lowQuantile);
  assert.equal(e.why.quantiles.high, ETA_DEFAULTS.highQuantile);
  assert.equal(e.why.modelVersion, m.version);
  assert.ok(e.why.bandStats.p50 > 0);
  assert.ok(e.why.sampleWindow.bizDays > 0);
});

test("estimate: موديل فاضي مابيرجّعش رقم واثق", () => {
  const m = buildModel([]);
  const e = estimate(m, { km: 5 });
  assert.equal(e.showToCustomer, false);
  assert.equal(e.confidence, "low");
  assert.equal(estimate({}, { km: 5 }).ok, false);
});

test("renderPromise: الوعد المخزّن يرجع بالحرف — مايرقصش والطلب حيّ", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const e = estimate(m, { km: 5 });
  const again = renderPromise(e.promiseKey);
  assert.equal(again.lowMin, e.lowMin);
  assert.equal(again.highMin, e.highMin);
  assert.equal(again.text, e.text);
  assert.equal(again.promise, e.promise);
  assert.equal(again.band, "4-7");
});

test("renderPromise: مفتاح بايظ = null، مش رقم مختلق", () => {
  assert.equal(renderPromise(null), null);
  assert.equal(renderPromise("garbage"), null);
  assert.equal(renderPromise("v2-abc|4-7|45-60"), null);
  assert.equal(renderPromise("v1-abc|4-7|45"), null);
  assert.equal(renderPromise("v1-abc|unknown|45-60").band, null);
});

test("modelVersion: بيتغيّر لما الجدول يتغيّر، وبيثبت لما مايتغيّرش", () => {
  const a = buildModel(sampleSet({ days: 12, perDay: 10 }), { now: "2026-09-24T10:00:00Z" });
  const b = buildModel(sampleSet({ days: 12, perDay: 10 }), { now: "2026-09-24T10:30:00Z" });
  assert.equal(a.version, b.version); // نفس الساعة ونفس الجدول
  const c = buildModel(sampleSet({ days: 12, perDay: 12 }), { now: "2026-09-24T10:00:00Z" });
  assert.notEqual(a.version, c.version);
  assert.equal(modelVersion(a), a.version);
});

test("scoreModel: بيعدّ المحفوظ والمتأخر والذيل", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const r = scoreModel(m, sampleSet({ days: 12, perDay: 10 }));
  assert.equal(r.n, 120);
  assert.equal(r.kept + r.late, r.n);
  assert.ok(r.hitRate > 0.8);
  assert.ok(r.avgWindowMin > 0);
});

test("scoreModel: الحادثة بتتحسب متأخرة مهما كانت مستثناة من البناء", () => {
  const train = sampleSet({ days: 12, perDay: 10 });
  const m = buildModel([...train, { km: 5, bizDay: "2026-09-19", totalMin: 766 }]);
  const r = scoreModel(m, [{ km: 5, bizDay: "2026-09-19", totalMin: 766 }]);
  assert.equal(r.n, 1);
  assert.equal(r.late, 1);
  assert.equal(r.hitRate, 0);
  assert.ok(r.worstLateMin > 600);
});

test("scoreModel: «اللي وصل قبل بداية النطاق» بيتعدّ — التحفّظ بيضيّع بيع", () => {
  const m = buildModel(sampleSet({ days: 12, perDay: 10 }));
  const r = scoreModel(m, [{ km: 5, bizDay: "2026-09-19", totalMin: 10 }]);
  assert.equal(r.earlierThanLow, 1);
  assert.equal(r.kept, 1); // وصل بدري = الوعد اتحفظ برضه
});

test("evaluate: التقييم الخارجي موجود، والبوابة مقفولة على عيّنة صغيرة", () => {
  const m = evaluate(sampleSet({ days: 10, perDay: 7 })); // ٧٠ طلب = واقعنا
  assert.ok(m.quality.inSample.n > 0);
  assert.ok(m.quality.holdout, "لازم يكون فيه تقييم خارجي");
  assert.equal(m.quality.holdout.days, ETA_DEFAULTS.holdoutDays);
  assert.equal(m.showToCustomer, false);
  assert.ok(m.reasons.some((r) => r.includes("العيّنة")), m.reasons.join(" | "));
});

test("evaluate: البوابة تفتح لما العيّنة تكبر والوعد يتحفظ", () => {
  const m = evaluate(sampleSet({ days: 40, perDay: 16 })); // ٦٤٠ طلب
  assert.ok(m.samples.total >= ETA_DEFAULTS.minTotalSamples);
  assert.ok(m.quality.holdout.hitRate >= ETA_DEFAULTS.targetHitRate,
    `hitRate=${m.quality.holdout.hitRate}`);
  assert.equal(m.showToCustomer, true, m.reasons.join(" | "));
  assert.deepEqual(m.reasons, []);
});

test("evaluate: نطاق أوسع من الحد بيقفل البوابة لوحده", () => {
  // توزيع بذيل وحش: نفس المسافة، أزمنة من ٣٠ لـ٢٠٠ دقيقة
  const s = [];
  for (let d = 0; d < 40; d++) {
    for (let i = 0; i < 16; i++) {
      s.push({ km: 5, bizDay: `2026-08-${String(1 + (d % 28)).padStart(2, "0")}`,
               totalMin: 30 + (i * 11) % 170 });
    }
  }
  const m = evaluate(s);
  assert.ok(m.quality.widestBandWindowMin > ETA_DEFAULTS.maxWindowMin);
  assert.equal(m.showToCustomer, false);
  assert.ok(m.reasons.some((r) => r.includes("نطاق")), m.reasons.join(" | "));
});

test("evaluate: الخانة الرقيقة عمرها ما تتعرض للعميل حتى لو البوابة مفتوحة", () => {
  const m = evaluate(sampleSet({ days: 40, perDay: 16 }));
  assert.equal(m.showToCustomer, true);
  assert.equal(m.bands["15+"].thin, true);
  assert.equal(estimate(m, { km: 20 }).showToCustomer, false);
  assert.equal(estimate(m, { km: 5 }).showToCustomer, true);
});

test("evaluate: مفيش أيام كفاية = سبب صريح مش رقم واثق", () => {
  const m = evaluate(sampleSet({ days: 2, perDay: 30 }));
  assert.equal(m.quality.holdout, null);
  assert.equal(m.showToCustomer, false);
  assert.ok(m.reasons.some((r) => r.includes("تقييم خارجي")), m.reasons.join(" | "));
});

test("rowsToSamples: بيقرا صفوف الاستعلام ويرمي الناقص", () => {
  const s = rowsToSamples([
    { order_no: "W1", provider: "leajlak", km: "8.63", subtotal: "120", total_min: 58.8, biz_day: "2026-09-18" },
    { order_no: "W2", provider: "external", km: null, subtotal: null, total_min: null, biz_day: "2026-09-18" },
    { order_no: "W3", provider: "leajlak", km: "0.78", subtotal: "90", total_min: -3, biz_day: "2026-09-18" },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].orderNo, "W1");
  assert.equal(s[0].km, 8.63);
  assert.equal(s[0].bizDay, "2026-09-18");
});

test("SAMPLES_SQL: قراية بس، وباليوم التشغيلي بتوقيت الرياض", () => {
  assert.doesNotMatch(SAMPLES_SQL, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(SAMPLES_SQL, /Asia\/Riyadh/);
  assert.match(SAMPLES_SQL, /4 hours/);              // قطع اليوم التشغيلي
  assert.match(SAMPLES_SQL, /provider <> 'manual'/); // الشحنة اليدوية مستثناة
  assert.match(SAMPLES_SQL, /is_test/);              // طلبات الاختبار مستثناة
});

/* ── الراوتات: بـapp وpool مزيّفين. الغرض مش اختبار Hono، الغرض إن اللقطة
   تتبنى مرة واحدة وكل الطلبات تقرا منها — «طريقة ثابتة» على مستوى الراوت. */
function fakeHost(rows) {
  const routes = new Map();
  let queries = 0;
  const app = { get: (p, h) => routes.set(p, h) };
  const pool = { query: async () => { queries += 1; return { rows }; } };
  const call = async (path, query = {}) => {
    let body = null, status = 200;
    const c = {
      req: { query: (k) => (k == null ? query : query[k]), param: () => null, header: () => null },
      json: (b, s) => { body = b; status = s || 200; return { body, status }; },
    };
    await routes.get(path)(c);
    return { body, status };
  };
  return { app, pool, call, routes, queries: () => queries };
}

const ROWS = Array.from({ length: 60 }, (_, i) => ({
  order_no: `W${i}`, provider: "leajlak", km: [2, 5, 8, 12][i % 4],
  subtotal: 120, total_min: 50 + (i % 5) * 7 + [0, 4, 9, 14][i % 4],
  biz_day: `2026-09-${String(1 + (i % 12)).padStart(2, "0")}`,
}));

test("register: اللقطة بتتبنى مرة واحدة — الطلبات مابتضربش على قاعدة البيانات", async () => {
  const h = fakeHost(ROWS);
  const api = register(h.app, { pool: h.pool, requireAdmin: async () => null, log: { log() {}, error() {} } });
  await api.ready();
  const before = h.queries();
  await api.ready(); await api.ready();
  assert.equal(h.queries(), before, "اللقطة المفروض تتعاد من الكاش");
  assert.ok(before >= 1);
});

test("register: عميلين في نفس الخانة بياخدوا نفس الرد من الراوت العام", async () => {
  const h = fakeHost(ROWS);
  register(h.app, { pool: h.pool, requireAdmin: async () => null, log: { log() {}, error() {} } });
  const a = await h.call("/api/delivery/eta", { km: "4.2" });
  const b = await h.call("/api/delivery/eta", { km: "6.8" });
  assert.equal(a.body.ok, true);
  assert.deepEqual(a.body, b.body);
  // الراوت العام مابيسرّبش عدد العيّنة ولا إحصاءات الخانة
  assert.equal(a.body.why, undefined);
  assert.ok(a.body.modelVersion);
});

test("register: راوت الموديل بيكشف كل حاجة — الجدول والتقييم وأسباب المنع", async () => {
  const h = fakeHost(ROWS);
  register(h.app, { pool: h.pool, requireAdmin: async () => null, log: { log() {}, error() {} } });
  const r = await h.call("/api/delivery/eta/model");
  assert.equal(r.body.ok, true);
  assert.ok(r.body.model.bands["0-4"]);
  assert.ok(r.body.model.quality.inSample.n > 0);
  assert.ok(Array.isArray(r.body.model.reasons));
  assert.equal(typeof r.body.model.showToCustomer, "boolean");
  const ex = await h.call("/api/delivery/eta/explain", { km: "9" });
  assert.equal(ex.body.ladder.length, KM_BANDS.length);
  assert.equal(ex.body.asked.why.band, "7-10");
  assert.ok(ex.body.unknownLocation.ok);
});

test("register: قاعدة البيانات واقعة = 503 صريح، مش رقم مختلق", async () => {
  const routes = new Map();
  const app = { get: (p, hh) => routes.set(p, hh) };
  const pool = { query: async () => { throw new Error("connection refused"); } };
  register(app, { pool, requireAdmin: async () => null, log: { log() {}, error() {} } });
  let body = null, status = 0;
  await routes.get("/api/delivery/eta")({
    req: { query: () => null },
    json: (b, s) => { body = b; status = s || 200; },
  });
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "model_unavailable");
});
