/* ═══════════════════════════════════════════════════════════════════════════
   الوقت المتوقع الذكي — الجزء الحسابي الصافي (من غير DB) — smarteta.js بيلفّه بالـDB والراوتات والجوب الليلي.

   طلب عمر (١٤/١٠): «نحط وقت وصول متوقع بس نحسبه بزيادة عشان العميل ميتضايقش… وقت التجهيز بحسب التاريخ… في أوردرات معينة
   في أوقات معينة وقت التجهيز عالي وأوقات تانية أقل وطلبات معينة أقل… ووقت التوصيل هو الوقت من جوجل بالمسافة… وبعدها يتجمعوا».

   الشكل (كل رقم هنا متعلّم من التاريخ كل ليلة، والافتراضي COLD_START من التحليل — ETA1/ANALYSIS.md):
     ١) **الوسيط** لكل مرحلة (الطلب «العادي»):
          تحضير = أساس نوع الطلب (مشويات كيلو+ / مشويات / بيتزا / باستا / كريب-حواوشي-طاسات / جانبي)
                  + تعديل الساعة (نهار ١١–١٨ / ذروة ١٨–٢١ / ذروة ٢٣–٠١ / باقي الليل) + تعديل خميس/جمعة
                  + دقايق لكل صنف فوق ٣ + دقايق لكل طلب زيادة في المطبخ (كل القنوات من ts_orders، آخر ٣٠ د)
          المندوب = بيتطلب أول لحظة من (جاهز، القبول + مهلة التحضير) ⇒ تعيين ⇒ يوصل المطعم ⇒ استلام بعد max(جاهز، وصل)
          المشوار = a + b × مدة جوجل (من غير زحمة، محفوظة وقت التسعير) + تعديل الساعة — متعايَر على picked→delivered بتاعنا
     ٢) **الوعد** = الوسيط + كوانتايل البواقي (الافتراضي P80) للمرحلة اللي الطلب فيها + هامش ثابت (٥ د)، ومقرّب لفوق لـ٥ دقايق.
        البواقي بتتحسب لكل مرحلة لوحدها (عند الدفع / عند «جاهز» أو وصول المندوب / بعد الاستلام) — الشك بيقل كل ما الطلب يتقدّم.
     ٣) العميل بيشوف **الحد الأعلى**. الوسيط هو بداية النطاق بس.
   مفيش انحدار تقيل ولا مكتبات: جداول وسيط + انكماش ناحية المتوسط العام لما العيّنة صغيرة (k)، عشان عمر يقرا الموديل كله في دقيقة.
═══════════════════════════════════════════════════════════════════════════ */

export const MIX_KEYS = Object.freeze(["grill_heavy", "grill", "pizza", "pasta", "light", "side"]);
export const MIX_LABELS = Object.freeze({
  grill_heavy: "مشويات بالوزن (كيلو أو أكتر) / بوكسات",
  grill: "مشويات أقل من كيلو / وجبات مشوية",
  pizza: "بيتزا (من غير مشويات)",
  pasta: "باستا وكازرول (من غير مشويات/بيتزا)",
  light: "كريب / حواوشي / طاسات بس",
  side: "جانبي ومشروبات بس",
});
export const HOUR_BANDS = Object.freeze(["day", "peak1", "peak2", "night"]);
export const HOUR_BAND_LABELS = Object.freeze({ day: "نهار ١١–١٨", peak1: "ذروة ١٨–٢١", peak2: "ذروة ٢٣–٠١", night: "باقي الليل" });
export const STAGES = Object.freeze(["s0", "s1", "s2"]);       // s0 عند الدفع · s1 جاهز أو المندوب وصل · s2 بعد الاستلام
export const PERCENTILES = Object.freeze([50, 70, 80, 85, 90, 95]);

export const SMART_ETA_DEFAULTS = Object.freeze({
  enabled: true,        // الوقت الذكي على صفحة التتبع (مقفول ⇒ حساب TR1 القديم)
  percentile: 80,       // الوعد عند كوانتايل كام من البواقي
  bufferMin: 5,         // هامش ثابت فوق الكوانتايل
  roundMin: 5,          // التقريب لفوق
  minTotalMin: 35,      // أقل وعد من الدفع (د) — قبل الاستلام
  maxTotalMin: 120,     // فوق كده من الدفع مانقولش وقت (الطلب فيه مشكلة — رقم هنا كذب)
  maxRangeMin: 10,      // عرض النطاق بالدقايق اللي العميل بيشوفه («20~30 دقيقة» = 10) — النهاية = الدقايق لحد «قبل الساعة»
  learn: true,          // استخدم المعاملات المتعلّمة كل ليلة (مقفول ⇒ الافتراضي من التحليل)
  minSamples: 60,       // أقل عدد طلبات متسلّمة عشان المتعلّم يتستخدم
  whatsappLine: true,   // «⏱ يوصلك خلال 20~30 دقيقة · قبل 4:00» في رسالة «في الطريق» الحرة (جوّه النافذة بس)
  /* قواعد المالك (عمر ١٤/١٠) — أرضيات فوق الموديل المتعلّم، كلها من اللوحة */
  ownerRules: true,          // مفتاح القواعد كلها
  grillFloorMin: 30,         // أي طلب فيه مشاوي/وجبات مشوية: التحضير مش أقل من كده
  bigOrderSar: 200,          // «طلب كبير» = قيمة الأصناف من كده وفوق (٠ = مقفول)
  bigOrderExtraMin: 10,      // … + الدقايق دي على التحضير
  manyItemsQty: 6,           // «طلب مجمّع» = أكتر من كده صنف (بالكمية)
  manyItemsFloorMin: 40,     // … التحضير مش أقل من كده
  manyItemsBusyOnly: false,  // الأرضية دي وقت الزحمة بس (ذروة أو طلبات المطبخ ≥ busyLoad)
  busyLoad: 4,               // «زحمة» = طلبات المطبخ آخر ٣٠ د (نقطة البيع كل القنوات + طلبات الموقع المفتوحة) من كده وفوق
  stickyStepMin: 5,          // «قبل الساعة» مابيتحركش لقدّام غير بعد الاستلام ولو الفرق ٥ د أو أكتر — مفيش رقص
  prepOverride: Object.freeze(Object.fromEntries(MIX_KEYS.map((k) => [k, 0]))),   // ٠ = المتعلّم
});
export const SMART_ETA_LIMITS = Object.freeze({
  bufferMin: [0, 30], roundMin: [1, 10], minTotalMin: [0, 90], maxTotalMin: [45, 240], maxRangeMin: [5, 60], minSamples: [20, 1000],
  grillFloorMin: [0, 90], bigOrderSar: [0, 5000], bigOrderExtraMin: [0, 60], manyItemsQty: [2, 50], manyItemsFloorMin: [0, 120], busyLoad: [1, 50], stickyStepMin: [1, 30],
});

const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const isOn = (v, dflt = true) => (v === undefined || v === null || v === "" ? dflt : !(v === false || v === "false" || v === 0 || v === "0"));

export function smartEtaCfg(settings = {}) {
  const raw = (((settings || {}).delivery || {}).smartEta) || {};
  const out = { ...SMART_ETA_DEFAULTS, prepOverride: { ...SMART_ETA_DEFAULTS.prepOverride } };
  out.enabled = isOn(raw.enabled);
  out.learn = isOn(raw.learn);
  out.whatsappLine = isOn(raw.whatsappLine);
  out.ownerRules = isOn(raw.ownerRules);
  out.manyItemsBusyOnly = isOn(raw.manyItemsBusyOnly, false);
  const p = num(raw.percentile);
  if (p != null && PERCENTILES.includes(p)) out.percentile = p;
  for (const [k, [lo, hi]] of Object.entries(SMART_ETA_LIMITS)) {
    const n = num(raw[k]);
    if (n != null && n >= lo && n <= hi) out[k] = n;
  }
  const po = raw.prepOverride && typeof raw.prepOverride === "object" ? raw.prepOverride : {};
  for (const k of MIX_KEYS) { const n = num(po[k]); if (n != null && n >= 0 && n <= 120) out.prepOverride[k] = n; }
  return out;
}

/* ── تصنيف الطلب ─────────────────────────────────────────────────────────
   الأسماء جاية من كتالوج تاب سينس بالعربي. «بالوزن» = مشويات بالكيلو (الوزن من الـvariant). */
export function itemCat(name = "") {
  const n = String(name || "");
  if (/بوكس|صينية|صندوق/.test(n)) return "box";
  if (/بالوزن/.test(n)) return "grill_kg";
  if (/^وجبة|دجاجة|ميكس جريل|مشوي/.test(n)) return "grill_meal";
  if (/كريب/.test(n)) return "crepe";
  if (/بيتزا/.test(n)) return "pizza";
  if (/باستا|بنا |بنا$|الفريدو|كازرول|ماك اند|نجرسكو/.test(n)) return "pasta";
  if (/حواوشي|ورقة سجق/.test(n)) return "hawawshi";
  if (/برجر|طاسة|ساندوتش|كبدة اسكندراني/.test(n)) return "pan";
  return "side";
}
export function kgOf(variant = "") {
  const v = String(variant || "");
  if (/ثلث/.test(v)) return 1 / 3;
  if (/نصف/.test(v)) return 0.5;
  if (/ربع/.test(v)) return 0.25;
  if (/كيلو/.test(v)) return 1;
  return 0.5;
}
export function classifyItems(items) {
  let arr = items;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) arr = [];
  const cats = {}; let qty = 0, kg = 0;
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const c = itemCat(it.name || it.title || "");
    const q = Math.max(1, Math.min(50, Number(it.quantity ?? it.qty) || 1));
    cats[c] = (cats[c] || 0) + q; qty += q;
    if (c === "grill_kg") kg += kgOf(it.variant_name || it.variant || "") * q;
  }
  const mix = cats.box || kg >= 1 ? "grill_heavy"
    : cats.grill_kg || cats.grill_meal ? "grill"
      : cats.pizza ? "pizza"
        : cats.pasta ? "pasta"
          : cats.crepe || cats.hawawshi || cats.pan ? "light" : "side";
  return { mix, qty, kg: Math.round(kg * 100) / 100, cats };
}

/** ساعة الرياض (UTC+3، مفيش توقيت صيفي). */
export const riyadh = (t) => { const d = new Date(Number(t) + 3 * 3600_000); return { hour: d.getUTCHours(), dow: d.getUTCDay(), min: d.getUTCMinutes() }; };
export function hourBand(hour) {
  const h = Number(hour);
  if (h >= 11 && h <= 17) return "day";
  if (h >= 18 && h <= 20) return "peak1";
  if (h === 23 || h === 0) return "peak2";
  return "night";
}
export const isThuFri = (dow) => dow === 4 || dow === 5;

/* ── إحصاء صغير ─────────────────────────────────────────────────────── */
export function quantile(values, p) {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const k = (a.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(k), hi = Math.min(lo + 1, a.length - 1);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}
const median = (v) => quantile(v, 0.5);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** وسيط منكمش ناحية مرجع: عيّنة ٥ طلبات مابتقدرش تشد الرقم بعيد. */
const shrink = (med, n, ref, k) => (med == null ? ref : (n * med + k * ref) / (n + k));
/** ميل بالوسيط الموزون (LAD من غير ثابت): مقاوم للطلبات الشاذة. */
function ladSlope(xs, ys) {
  const pts = [];
  for (let i = 0; i < xs.length; i++) if (xs[i] > 0 && Number.isFinite(ys[i])) pts.push({ s: ys[i] / xs[i], w: xs[i] });
  if (pts.length < 8) return 0;
  pts.sort((a, b) => a.s - b.s);
  const tot = pts.reduce((a, p) => a + p.w, 0);
  let acc = 0;
  for (const p of pts) { acc += p.w; if (acc >= tot / 2) return p.s; }
  return 0;
}
/** خط بالوسيط (LAD عن طريق IRLS): y ≈ a + b·x. */
function ladLine(xs, ys) {
  const n = xs.length; if (n < 8) return null;
  let a = 0, b = 1;
  for (let it = 0; it < 30; it++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const w = 1 / Math.max(0.5, Math.abs(ys[i] - (a + b * xs[i])));
      sw += w; sx += w * xs[i]; sy += w * ys[i]; sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i];
    }
    const det = sw * sxx - sx * sx; if (Math.abs(det) < 1e-9) break;
    b = (sw * sxy - sx * sy) / det; a = (sy - b * sx) / sw;
  }
  return { a, b };
}

/* ── الافتراضي (cold start) ────────────────────────────────────────────
   ناتج fitModel على ١٧١ طلب توصيل + ٣٩ استلام (١٦/٩ → ١٤/١٠). بيتستخدم لما مفيش موديل متعلّم أو العيّنة أقل من minSamples. */
export const COLD_START = Object.freeze({
  version: "cold-2026-10-14", source: "cold", builtAt: "2026-10-14T00:00:00.000Z", n: { delivery: 171, prep: 210, drive: 156 },
  prep: {
    pool: 24.7, k: 10,
    base: { grill_heavy: 25.8, grill: 22.9, pizza: 25.6, pasta: 23.8, light: 21.3, side: 25.1 },
    hourAdj: { day: 2.8, peak1: -0.8, peak2: -2.2, night: -2 }, thuFriAdj: -1.1,
    qtyFrom: 3, qtySlope: 0.42, loadRef: 2, loadSlope: 0, overdueMin: 3,
  },
  courier: { assignMin: 1, arriveMin: 9, handoverMin: 3.6 },
  drive: { a: 2.7, b: 1.42, kmA: 5.7, kmB: 2.4, hourAdj: { day: -0.3, peak1: 1.5, peak2: -0.6, night: -0.7 }, minMin: 4 },
  resid: {
    s0: { 50: 4.6, 70: 11, 80: 16.5, 85: 20.6, 90: 30.6, 95: 42.2, n: 171 },
    s1: { 50: 4.9, 70: 11.9, 80: 16.5, 85: 19.1, 90: 25.4, 95: 42.2, n: 169 },
    s2: { 50: -0.1, 70: 2.4, 80: 6, 85: 8.4, 90: 12.6, 95: 20.9, n: 171 },
  },
});

/* ── التعلّم ──────────────────────────────────────────────────────────────
   sample (طلب واحد متسلّم أو مستلم):
     { orderNo, option, paidAt, acceptedAt, readyAt, requestedAt, assignedAt, arrivedAt, pickedAt, deliveredAt, provider,
       items | {mix, qty, kg}, load, gMin, routeKm }  — الأوقات ms. */
const mn = (a, b) => (a != null && b != null ? (b - a) / 60000 : null);
export function sampleFacts(s) {
  const c = s.mix ? { mix: s.mix, qty: s.qty || 1, kg: s.kg || 0 } : classifyItems(s.items);
  const z = riyadh(s.paidAt);
  return { ...s, ...c, hour: z.hour, dow: z.dow, band: hourBand(z.hour) };
}

export function fitModel(rawSamples = [], { now = Date.now(), dispatchDelayMin = 15 } = {}) {
  const S = rawSamples.map(sampleFacts);
  const P = S.filter((s) => { const p = mn(s.paidAt, s.readyAt); return p != null && p > 3 && p < 120; })
    .map((s) => ({ ...s, prep: mn(s.paidAt, s.readyAt) }));
  const K = 10, KA = 20;
  const pool = median(P.map((s) => s.prep)) ?? COLD_START.prep.pool;
  const base = {};
  for (const k of MIX_KEYS) { const v = P.filter((s) => s.mix === k).map((s) => s.prep); base[k] = r1(shrink(median(v), v.length, pool, K)); }
  const res1 = P.map((s) => s.prep - base[s.mix]);
  const hourAdj = {};
  for (const b of HOUR_BANDS) { const v = P.map((s, i) => (s.band === b ? res1[i] : null)).filter((x) => x != null); hourAdj[b] = r1(shrink(median(v), v.length, 0, KA)); }
  const res2 = P.map((s, i) => res1[i] - hourAdj[s.band]);
  const tf = P.map((s, i) => (isThuFri(s.dow) ? res2[i] : null)).filter((x) => x != null);
  const thuFriAdj = r1(shrink(median(tf), tf.length, 0, KA));
  const res3 = P.map((s, i) => res2[i] - (isThuFri(s.dow) ? thuFriAdj : 0));
  const qtyFrom = 3;
  const qtySlope = r2(clamp(ladSlope(P.map((s) => Math.max(0, s.qty - qtyFrom)), res3), 0, 3));
  const res4 = P.map((s, i) => res3[i] - qtySlope * Math.max(0, s.qty - qtyFrom));
  const loadRef = Math.round(median(P.map((s) => s.load || 0)) ?? 2);
  const loadSlope = r2(clamp(ladSlope(P.map((s) => Math.max(0, (s.load || 0) - loadRef)), res4), 0, 3));

  const D = S.filter((s) => s.option !== "pickup" && s.deliveredAt && s.pickedAt);
  const L = D.filter((s) => s.provider !== "external");
  const assignMin = r1(median(L.map((s) => mn(s.requestedAt, s.assignedAt)).filter((x) => x != null && x >= 0 && x < 30)) ?? COLD_START.courier.assignMin);
  const arriveMin = r1(median(L.map((s) => mn(s.assignedAt, s.arrivedAt)).filter((x) => x != null && x >= 0 && x < 60)) ?? COLD_START.courier.arriveMin);
  const handoverMin = r1(median(L.map((s) => (s.readyAt && s.arrivedAt ? mn(Math.max(s.readyAt, s.arrivedAt), s.pickedAt) : null)).filter((x) => x != null && x >= 0 && x < 60)) ?? COLD_START.courier.handoverMin);

  const G = L.map((s) => ({ s, d: mn(s.pickedAt, s.deliveredAt) })).filter((x) => x.d != null && x.d > 0 && x.d < 120);
  const gl = ladLine(G.filter((x) => x.s.gMin != null).map((x) => x.s.gMin), G.filter((x) => x.s.gMin != null).map((x) => x.d));
  const kl = ladLine(G.filter((x) => x.s.routeKm != null).map((x) => x.s.routeKm), G.filter((x) => x.s.routeKm != null).map((x) => x.d));
  const drive = {
    a: r1(gl ? clamp(gl.a, 0, 15) : COLD_START.drive.a), b: r2(gl ? clamp(gl.b, 0.8, 3) : COLD_START.drive.b),
    kmA: r1(kl ? clamp(kl.a, 0, 15) : COLD_START.drive.kmA), kmB: r2(kl ? clamp(kl.b, 1, 6) : COLD_START.drive.kmB),
    hourAdj: {}, minMin: COLD_START.drive.minMin,
  };
  const dres = G.map((x) => ({ band: x.s.band, r: x.d - driveMedRaw(drive, x.s) }));
  for (const b of HOUR_BANDS) { const v = dres.filter((x) => x.band === b).map((x) => x.r); drive.hourAdj[b] = r1(shrink(median(v), v.length, 0, KA)); }

  const model = {
    version: null, source: "learned", builtAt: new Date(now).toISOString(),
    n: { delivery: D.length, prep: P.length, drive: G.length },
    window: { from: S.length ? new Date(Math.min(...S.map((s) => s.paidAt))).toISOString() : null, to: S.length ? new Date(Math.max(...S.map((s) => s.paidAt))).toISOString() : null },
    prep: { pool: r1(pool), k: K, base, hourAdj, thuFriAdj, qtyFrom, qtySlope, loadRef, loadSlope, overdueMin: COLD_START.prep.overdueMin },
    courier: { assignMin, arriveMin, handoverMin },
    drive, resid: null,
  };
  /* البواقي لكل مرحلة: الطلب اللي اتسلّم فعلاً، لو وقفنا عند المرحلة دي وتوقّعنا — كان الفرق كام؟ */
  /* البواقي على الموديل المتعلّم **من غير** قواعد المالك — عشان الأرضيات تفضل تحفّظ زيادة فوق الـP80، مش تتاكل في الهامش */
  const cfg = { ...SMART_ETA_DEFAULTS, dispatchDelayMin, ownerRules: false };
  const resid = { s0: [], s1: [], s2: [] };
  for (const s of D) {
    for (const st of STAGES) {
      const state = stateAt(s, st); if (!state) continue;
      const tl = timeline(model, cfg, state, s);
      resid[st].push((s.deliveredAt - tl.deliveredAt) / 60000);
    }
  }
  model.resid = {};
  for (const st of STAGES) {
    const v = resid[st];
    model.resid[st] = v.length >= 20
      ? Object.fromEntries(PERCENTILES.map((p) => [p, r1(quantile(v, p / 100))]))
      : { ...COLD_START.resid[st] };
    model.resid[st].n = v.length;
  }
  model.version = modelVersion(model);
  return model;
}

export function modelVersion(m) {
  const key = JSON.stringify([m.builtAt?.slice(0, 13), m.n, m.prep?.base, m.drive?.a, m.drive?.b, m.resid?.s0]);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `se1-${(h >>> 0).toString(36)}`;
}

/** حالة الطلب التاريخي كما كانت لحظة المرحلة (اللي كان معروف ساعتها بس). */
export function stateAt(s, stage) {
  if (stage === "s0") return { paidAt: s.paidAt, acceptedAt: s.acceptedAt && s.acceptedAt - s.paidAt <= 120000 ? s.acceptedAt : null, now: s.paidAt };
  if (stage === "s1") {
    const t = s.readyAt && s.arrivedAt ? Math.min(s.readyAt, s.arrivedAt) : (s.readyAt || s.arrivedAt);
    if (!t || (s.pickedAt && t >= s.pickedAt)) return null;
    const k = (v) => (v != null && v <= t ? v : null);
    return { paidAt: s.paidAt, acceptedAt: k(s.acceptedAt), readyAt: k(s.readyAt), requestedAt: k(s.requestedAt), assignedAt: k(s.assignedAt), arrivedAt: k(s.arrivedAt), now: t };
  }
  if (!s.pickedAt) return null;
  return { paidAt: s.paidAt, acceptedAt: s.acceptedAt, readyAt: s.readyAt, requestedAt: s.requestedAt, assignedAt: s.assignedAt, arrivedAt: s.arrivedAt, pickedAt: s.pickedAt, now: s.pickedAt };
}

/* ── التوقّع ─────────────────────────────────────────────────────────── */
export function predictPrep(model, x, cfg = SMART_ETA_DEFAULTS) {
  const p = model.prep;
  const ov = cfg.prepOverride && Number(cfg.prepOverride[x.mix]) > 0 ? Number(cfg.prepOverride[x.mix]) : null;
  const base = ov ?? p.base[x.mix] ?? p.pool;
  const hour = p.hourAdj[x.band] || 0, day = isThuFri(x.dow) ? (p.thuFriAdj || 0) : 0;
  const qty = (p.qtySlope || 0) * Math.max(0, (x.qty || 1) - (p.qtyFrom || 3));
  const load = (p.loadSlope || 0) * Math.max(0, (x.load || 0) - (p.loadRef || 0));
  /* التعديلات السالبة (ذروة أسرع!) متقاسة، بس الأساس مابينزلش تحت ٧٠٪ منه — مايصحش التعديل يخلي التحضير ٥ دقايق. */
  const learned = Math.max(base * 0.7, base + hour + day + qty + load);
  /* قواعد المالك: أرضيات + إضافة فوق المتعلّم (مابتنزّلش رقم أبداً). */
  let med = learned; const rules = [];
  if (cfg.ownerRules !== false) {
    if ((x.mix === "grill_heavy" || x.mix === "grill") && cfg.grillFloorMin > 0 && med < cfg.grillFloorMin) { med = cfg.grillFloorMin; rules.push("grill_floor"); }
    const busy = Number(x.load || 0) >= (cfg.busyLoad || 4) || x.band === "peak1" || x.band === "peak2";
    if ((x.qty || 0) > (cfg.manyItemsQty || 6) && cfg.manyItemsFloorMin > 0 && (!cfg.manyItemsBusyOnly || busy) && med < cfg.manyItemsFloorMin) { med = cfg.manyItemsFloorMin; rules.push("many_items_floor"); }
    if (cfg.bigOrderSar > 0 && Number(x.subtotal) >= cfg.bigOrderSar && cfg.bigOrderExtraMin > 0) { med += cfg.bigOrderExtraMin; rules.push("big_order"); }
  }
  return { med, learned, base, override: ov != null, hour, day, qty, load, rules };
}
function driveMedRaw(d, x) {
  const g = num(x.gMin), km = num(x.routeKm);
  if (g != null && g > 0) return d.a + d.b * g;
  if (km != null && km > 0) return d.kmA + d.kmB * km;
  return d.kmA + d.kmB * 5;   // مفيش مسافة خالص: ٥ كم (الوسيط)
}
export function predictDrive(model, x) {
  const d = model.drive;
  return Math.max(d.minMin || 3, driveMedRaw(d, x) + (d.hourAdj?.[x.band] || 0));
}
/** من كيلو طريق متبقّي (موقع المندوب) — نفس معايرة المشوار بس بالكيلو. */
export function driveFromKm(model, km, band) {
  const d = model.drive;
  return Math.max(1, d.kmA * 0.5 + d.kmB * Math.max(0, km) + (d.hourAdj?.[band] || 0));
}

/**
 * الجدول الزمني «العادي» (وسيط كل مرحلة) لحالة طلب. أي محطة معروفة بتتاخد زي ما هي، والمجهولة مابتبقاش قبل دلوقتي.
 * state: { paidAt, acceptedAt, readyAt, requestedAt, assignedAt, arrivedAt, pickedAt, now }
 * x: { mix, qty, kg, load, gMin, routeKm }  (sampleFacts أو orderFacts)
 */
export function timeline(model, cfg, state, x) {
  const now = state.now ?? Date.now();
  const M = 60000;
  const z = riyadh(state.paidAt ?? now);
  const fx = { ...x, band: x.band || hourBand(z.hour), dow: x.dow ?? z.dow };
  const paid = state.paidAt ?? now;
  const accepted = state.acceptedAt ?? Math.max(now, paid);
  const prep = predictPrep(model, fx, cfg);
  let ready = state.readyAt;
  if (ready == null) {
    const est = accepted + prep.med * M;
    ready = est > now ? est : now + (model.prep.overdueMin || 3) * M;   // متأخر عن المتوقّع ولسه مش جاهز ⇒ مش «دلوقتي»
  }
  const delay = Number(cfg.dispatchDelayMin);
  const requested = state.requestedAt ?? Math.max(now, Math.min(ready, accepted + (Number.isFinite(delay) ? delay : 15) * M));
  const c = model.courier;
  const assigned = state.assignedAt ?? Math.max(now, requested + c.assignMin * M);
  const arrived = state.arrivedAt ?? (state.pickedAt ? state.pickedAt : Math.max(now, assigned + c.arriveMin * M));
  const picked = state.pickedAt ?? Math.max(now, Math.max(ready, arrived) + c.handoverMin * M);
  const driveMed = predictDrive(model, fx);
  const deliveredAt = picked + driveMed * M;
  const stage = state.pickedAt ? "s2" : (state.readyAt || state.arrivedAt) ? "s1" : "s0";
  return {
    stage, readyAt: ready, requestedAt: requested, arrivedAt: arrived, pickedAt: picked, deliveredAt,
    prep, driveMin: driveMed,
    parts: { prep: Math.max(0, (ready - now) / M), wait: Math.max(0, (picked - Math.max(ready, now)) / M), drive: (deliveredAt - Math.max(picked, now)) / M },
  };
}

const ceilTo = (t, step) => Math.ceil(t / (step * 60000)) * step * 60000;
const floorTo = (t, step) => Math.floor(t / (step * 60000)) * step * 60000;
export const padOf = (model, cfg, stage) => {
  const r = (model.resid && model.resid[stage]) || COLD_START.resid[stage];
  const q = num(r[cfg.percentile]) ?? num(COLD_START.resid[stage][cfg.percentile]) ?? 0;
  return Math.max(0, q) + (Number(cfg.bufferMin) || 0);
};

/**
 * الوعد (قبل أو بعد الاستلام، من غير موقع): { lowAt, highAt, medAt, stage, padMin, parts } أو null لو فوق الحد.
 * الحد الأعلى = اللي العميل بيشوفه. مقرّب لفوق، ومابيبقاش أقل من minTotalMin من الدفع ولا أقرب من ٥ د من دلوقتي.
 */
export function promise(model, cfg, state, x) {
  const now = state.now ?? Date.now();
  const tl = timeline(model, cfg, state, x);
  const pad = padOf(model, cfg, tl.stage);
  const step = Math.max(1, Number(cfg.roundMin) || 5);
  const rawHighAt = tl.deliveredAt + pad * 60000;
  let high = ceilTo(rawHighAt, step);
  if (tl.stage !== "s2" && state.paidAt && cfg.minTotalMin > 0) high = Math.max(high, ceilTo(state.paidAt + cfg.minTotalMin * 60000, step));
  high = Math.max(high, ceilTo(now + 5 * 60000, step));
  if (state.paidAt && cfg.maxTotalMin > 0 && high - state.paidAt > cfg.maxTotalMin * 60000) return { hidden: true, reason: "over_max", stage: tl.stage, highAt: high, timeline: tl };
  /* بداية النطاق = الوسيط الحقيقي (الجدول الزمني + وسيط البواقي: مجموع وسطاء المراحل بيطلع أقل من وسيط المجموع بـ~٥ د). */
  const q50 = num(((model.resid && model.resid[tl.stage]) || COLD_START.resid[tl.stage])[50]) || 0;
  const medAt = tl.deliveredAt + Math.max(0, q50) * 60000;
  let low = Math.max(floorTo(medAt, step), ceilTo(now, step));
  low = Math.max(low, high - (Number(cfg.maxRangeMin) || 20) * 60000);
  if (low >= high) low = high - step * 60000;
  return { hidden: false, stage: tl.stage, lowAt: low, highAt: high, rawHighAt, medAt, padMin: r1(pad), timeline: tl, parts: tl.parts };
}

/** بعد الاستلام ومعانا موقع حيّ للمندوب: الباقي من الكيلو + هامش متناسب مع الجزء الفاضل من المشوار. */
export function promiseFromPosition(model, cfg, { now = Date.now(), remKm, tripKm, band, doorMin = 2 }) {
  const step = Math.max(1, Number(cfg.roundMin) || 5);
  const med = driveFromKm(model, remKm, band) + doorMin;
  const f = tripKm > 0 ? clamp(remKm / tripKm, 0, 1) : 1;
  const pad = Math.max(0, padOf(model, cfg, "s2") - (Number(cfg.bufferMin) || 0)) * Math.max(0.3, f) + (Number(cfg.bufferMin) || 0);
  const medAt = now + med * 60000;
  const rawHighAt = medAt + pad * 60000;
  const high = Math.max(ceilTo(rawHighAt, step), ceilTo(now + 3 * 60000, step));
  const low = Math.max(floorTo(medAt, step), ceilTo(now, step), high - (Number(cfg.maxRangeMin) || 20) * 60000);
  return { stage: "s2", lowAt: Math.min(low, high - step * 60000), highAt: high, rawHighAt, medAt, padMin: r1(pad), parts: { prep: 0, wait: 0, drive: med - doorMin, door: doorMin } };
}

/** أي موديل يتستخدم: المتعلّم لو مفتوح وعيّنته كفاية، وإلا الافتراضي. */
export function activeModel(learned, cfg = SMART_ETA_DEFAULTS) {
  if (cfg.learn && learned && learned.resid && (learned.n?.delivery || 0) >= cfg.minSamples) return learned;
  return COLD_START;
}

/* ── الاختبار على التاريخ (walk-forward) ──────────────────────────────────
   لكل يوم تشغيلي في آخر N يوم: نتعلّم من كل اللي قبله بس، ونحكم على وعد «عند الدفع» (أصعب نقطة) لطلبات اليوم ده.
   ده أقرب حاجة للواقع: الموديل دايماً بيتوقّع بكرة من امبارح. */
export function backtest(rawSamples, { days = 14, cfg = SMART_ETA_DEFAULTS, dispatchDelayMin = 15, minTrain = 40, bizDayOf } = {}) {
  const S = rawSamples.filter((s) => s.option !== "pickup" && s.deliveredAt && s.paidAt).sort((a, b) => a.paidAt - b.paidAt);
  const day = bizDayOf || ((t) => { const d = new Date(t + 3 * 3600_000 - 4 * 3600_000); return d.toISOString().slice(0, 10); });
  const allDays = [...new Set(S.map((s) => day(s.paidAt)))].sort();
  const testDays = allDays.slice(-days);
  const rows = [];
  for (const d of testDays) {
    const train = rawSamples.filter((s) => s.paidAt && day(s.paidAt) < d);
    if (train.filter((s) => s.deliveredAt).length < minTrain) continue;
    const m = fitModel(train, { now: Math.max(...train.map((s) => s.paidAt)), dispatchDelayMin });
    for (const s of S.filter((x) => day(x.paidAt) === d)) {
      const f = sampleFacts(s);
      for (const st of ["s0", "s1", "s2"]) {
        const state = stateAt(f, st); if (!state) continue;
        const p = promise(m, { ...cfg, dispatchDelayMin }, state, f);
        if (p.hidden) { rows.push({ day: d, stage: st, hidden: true, actualMin: (s.deliveredAt - s.paidAt) / 60000 }); continue; }
        rows.push({ day: d, stage: st, hit: s.deliveredAt <= p.highAt, slackMin: (p.highAt - s.deliveredAt) / 60000,
          promisedMin: (p.highAt - state.now) / 60000, actualMin: (s.deliveredAt - state.now) / 60000, inRange: s.deliveredAt >= p.lowAt && s.deliveredAt <= p.highAt });
      }
    }
  }
  const summary = {};
  for (const st of STAGES) {
    const r = rows.filter((x) => x.stage === st && !x.hidden);
    const late = r.filter((x) => !x.hit).map((x) => -x.slackMin);
    summary[st] = {
      n: r.length, hidden: rows.filter((x) => x.stage === st && x.hidden).length,
      hitRate: r.length ? r2(r.filter((x) => x.hit).length / r.length) : null,
      medianSlackMin: r1(quantile(r.map((x) => x.slackMin), 0.5)),
      medianPromisedMin: r1(quantile(r.map((x) => x.promisedMin), 0.5)),
      medianActualMin: r1(quantile(r.map((x) => x.actualMin), 0.5)),
      lateN: late.length, lateMedianMin: r1(quantile(late, 0.5)), worstLateMin: late.length ? r1(Math.max(...late)) : 0,
      inRangeRate: r.length ? r2(r.filter((x) => x.inRange).length / r.length) : null,
    };
  }
  return { days: testDays.length, from: testDays[0] || null, to: testDays[testDays.length - 1] || null, cfg: { percentile: cfg.percentile, bufferMin: cfg.bufferMin, roundMin: cfg.roundMin }, summary };
}

/* ── نص الوقت للعميل: «9:45 م» (أرقام لاتينية زي باقي النصوص) ── */
export function hmArabic(t) {
  const z = new Date(Number(t) + 3 * 3600_000);
  const h = z.getUTCHours(), m = z.getUTCMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "ص" : "م"}`;
}

/* ── «قبل الساعة» ثابت (عمر ١٤/١٠: يتحدّث بهدوء، من غير «اتأخر/اتحدّث»، ومن غير رقص) ──────────────────────
   prevAt = آخر «قبل الساعة» العميل شافه. القواعد:
     • مفيش سابق، أو السابق فات/قرّب أوي (أقل من دقيقتين) ⇒ الجديد.
     • التقدير الخام عدّى السابق ⇒ نأخّر للجديد (الصدق أهم — والتأخير بيبقى بخطوة ٥ د على الأقل بالتقريب).
     • نقدّم (أبكر) بس بعد الاستلام (s2) ولو الجديد أبكر بـstickyStepMin أو أكتر والخام أبكر بدقيقتين زيادة (هامش ضد الرقص).
     • غير كده السابق زي ما هو. */
export function stickDeadline({ prevAt = null, nextAt, rawAt = nextAt, stage, now = Date.now(), cfg = SMART_ETA_DEFAULTS }) {
  const step = (Number(cfg.stickyStepMin) || 5) * 60000;
  const p = num(prevAt);
  if (p == null || p <= now + 2 * 60000) return { at: nextAt, moved: p == null ? "first" : "expired" };
  if (rawAt > p) return { at: Math.max(nextAt, p), moved: nextAt > p ? "later" : "kept" };
  if (stage === "s2" && nextAt <= p - step && rawAt <= p - step - 2 * 60000) return { at: nextAt, moved: "earlier" };
  return { at: p, moved: "kept" };
}
/** «20~30 دقيقة · قبل 4:00 م»: النهاية = الدقايق لحد «قبل الساعة» بالظبط (لتحت)، والبداية = النهاية − عرض النطاق. */
export function displayWindow(beforeAt, now = Date.now(), cfg = SMART_ETA_DEFAULTS) {
  const toMin = Math.max(1, Math.floor((beforeAt - now) / 60000));
  const width = Number(cfg.maxRangeMin) || 10;
  const fromMin = Math.max(1, toMin - width);
  return { fromMin, toMin, widthMin: width, before: new Date(beforeAt).toISOString(), beforeText: hmArabic(beforeAt),
    text: `${fromMin === toMin ? toMin : `${fromMin}~${toMin}`} دقيقة · قبل ${hmArabic(beforeAt)}` };
}
