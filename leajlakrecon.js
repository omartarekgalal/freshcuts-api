/* ═══════════════════════════════════════════════════════════════════════════
   مطابقة فاتورة لاجلك — LEAJLAK FEE RECONCILIATION (١٩ سبتمبر ٢٠٢٦)

   طلب عمر: «لاجلك بتسجّل كل طلب ورسوم التوصيل عليه … حاول تشوفها بشكل سليم
   وتتأكد منها عشان المطابقة آخر الشهر لما يبعتولنا الفاتورة».

   الحقيقة اللي لقيناها (مجرّبة على اللايف ١٩/٩، ومطابقة لوثيقتهم في
   docs.leajlak.com — صفحات Create/Get/Delete/WebHook):
     • API الشركاء (app.leajlak.com/api/partner) **مابيرجّعش أي رسوم**.
       POST /orders → {dsp_order_id, status}، GET /orders/<uuid> → {id, status,
       dsp_order_id, driver{name,phone,location}}، DELETE → 202 فاضي،
       والويبهوك نفس شكل GET. مفيش سعر ولا مسافة ولا ضريبة ولا رسوم إلغاء.
     • مفيش مسار فواتير/محفظة/كشف حساب (/invoices /wallet /balance
       /transactions /statements … كلها 404 route not found). الموجود بس
       /shops و /orders.
     • الرسوم ظاهرة في لوحة التاجر بتاعتهم (جلسة دخول، مش التوكن)، وفي
       الفاتورة الشهرية.

   فالتصميم:
     ١) «المتوقَّع» لكل شحنة من العقد (١٧ + ضريبة = ١٩٫٥٥ لحد ١٠ كم، وبعدها
        لكل كم إضافي) على مسافة القيادة بتاعتنا (Google Routes).
     ٢) «المفوتَر» بييجي من استيراد ملف الفاتورة/تصدير لوحتهم (CSV/XLSX)،
        أو يتكتب بإيد لشحنة واحدة — وأي حقل رسوم يظهر في ردّ الـAPI يوماً ما
        بيتلقط تلقائياً (feeFromApi) من غير ما نغيّر حاجة.
     ٣) الشذوذ: مفوتَر > متوقَّع، رسوم على شحنة ملغية، سطر مكرر في الفاتورة،
        شحنتين لنفس الطلب، طلب توصيل اتوصّل من غير شحنة، سطر في الفاتورة مش
        لاقيين له طلب عندنا، فرق مسافة كبير.
     ٤) تصدير CSV بترتيب الفاتورة عشان عمر يعلّم عليها سطر سطر.
═══════════════════════════════════════════════════════════════════════════ */

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // «١٩٫٥٥ ر.س» / "19.55 SAR" / "1,234.50"
  const s = String(v).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/٫/g, ".").replace(/[,،]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!s) return null;
  const n = Number(s[0]);
  return Number.isFinite(n) ? n : null;
};

/* العقد (On Demand Contract — Standard، ٢٤/٨) + تأكيد عمر ١٩/٩ + تصدير
   لوحتهم (client-order-export، ٢٧ سطر، ٣٠/٨→١٨/٩):
     • ١٧ ر.س قبل الضريبة (١٩٫٥٥ شامل) لأي طلب لحد ١٠ كم.
     • بعد ١٠ كم: ٢ ر.س/كم قبل الضريبة = **٢٫٣٠ شامل** (عمر: «٢٫٣ شامل الضريبة»).
     • الكسر بيتحسب كسر (مش تقريب لفوق): 17.80 = 17 + 0.40كم×2،
       17.78 = 17 + 0.39كم×2، 28.52 = 17 + 5.76كم×2 — بدقة ٠٫٠١ كم.
     • مفيش رسوم إلغاء (الملغي في لوحتهم 0.00).
     • السعر بيتحسب بعد التوصيل على مسافتهم هم (بتفرق عن جوجل بتاعتنا
       ±٠٫٠٥ كم) — عشان كده kmTolerance تحت.
   كل القيم بتتعدّل من اللوحة (settings.delivery.leajlakContract). */
export const DEFAULT_LJ_CONTRACT = Object.freeze({
  flatExVat: 17,
  includedKm: 10,
  perKmExVat: 2,
  vatPct: 15,
  kmRounding: "exact",
  cancelFeeExVat: 0,          // عمر ١٩/٩: «غالباً مفيش رسوم إلغاء» — والملغي في لوحتهم 0.00
  tolerance: 0.1,             // فرق هللات مايتعدّش شذوذ
  kmTolerance: 0.2,           // مسافتهم ≠ مسافتنا بشوية — فوق ١٠ كم بنسمح بالفرق ده قبل ما نقول «أغلى من العقد»
  distanceGapKm: 2,           // فرق مسافتهم عن مسافتنا اللي يستاهل ننبّه عليه
});

export function ljContract(settings) {
  const c = { ...DEFAULT_LJ_CONTRACT, ...((settings && settings.leajlakContract) || {}) };
  for (const k of ["flatExVat", "includedKm", "perKmExVat", "vatPct", "cancelFeeExVat", "tolerance", "kmTolerance", "distanceGapKm"]) {
    const n = num(c[k]);
    c[k] = n == null ? DEFAULT_LJ_CONTRACT[k] : n;
  }
  c.kmRounding = c.kmRounding === "ceil" ? "ceil" : "exact";
  c.flatInclVat = r2(c.flatExVat * (1 + c.vatPct / 100));
  c.perKmInclVat = r2(c.perKmExVat * (1 + c.vatPct / 100));
  return c;
}

/* الكم اللي لاجلك حاسباه، مستنتج من الرسوم في لوحتهم (هي مابتطلّعش
   المسافة): 17.80 → 10.40. للأجرة الثابتة مانقدرش نعرف (أي مسافة ≤ ١٠). */
export function impliedKmFromFee(exVat, contractIn) {
  const c = contractIn || ljContract();
  const ex = num(exVat);
  if (ex == null || !(c.perKmExVat > 0) || ex <= c.flatExVat + 0.005) return null;
  return Math.round((c.includedKm + (ex - c.flatExVat) / c.perKmExVat) * 100) / 100;
}

/* السماح قبل ما نقول «مفوتَر أكتر/أقل من العقد»: هللات + فرق مسافة بسيط
   لو المشوار حوالين/فوق الـ١٠ كم (مسافتهم مش مسافتنا بالظبط). */
export function feeSlack(ourKm, c) {
  const km = num(ourKm);
  const nearEdge = km != null && km + c.kmTolerance > c.includedKm;
  return r2(c.tolerance + (nearEdge ? c.kmTolerance * c.perKmExVat * (1 + c.vatPct / 100) : 0));
}

/* الرسوم المتوقعة لشحنة واحدة حسب العقد.
   status: الحالة الموحّدة. picked: هل الكابتن استلم (picked_at أو delivered).
   الشحنة الملغية قبل الاستلام = رسوم الإلغاء (٠ افتراضياً)؛ بعد الاستلام =
   الأجرة كاملة (العقد: رفض العميل بسببنا بيتحاسب أجرة كاملة). */
export function expectedLeajlakFee({ km, status, picked } = {}, contractIn) {
  const c = contractIn || ljContract();
  const vat = c.vatPct / 100;
  const cancelled = status === "cancelled";
  if (cancelled && !picked) {
    const ex = r2(c.cancelFeeExVat || 0);
    return { exVat: ex, vat: r2(ex * vat), total: r2(ex * (1 + vat)), extraKm: 0, extraExVat: 0,
             basis: "cancel_before_pickup" };
  }
  const d = num(km);
  const over = d == null ? 0 : Math.max(0, d - c.includedKm);
  const extraKm = over <= 0 ? 0 : (c.kmRounding === "ceil" ? Math.ceil(over - 1e-9) : r2(over));
  const extraExVat = r2(extraKm * c.perKmExVat);
  const ex = r2(c.flatExVat + extraExVat);
  return { exVat: ex, vat: r2(ex * vat), total: r2(ex * (1 + vat)), extraKm, extraExVat,
           basis: d == null ? "flat_no_distance" : (cancelled ? "cancel_after_pickup" : "contract") };
}

/* أي حقل رسوم في ردّ API لاجلك. النهارده مفيش — بس لو ضافوه بكرة
   بيتلقط من غير تعديل. `total` مقصود إنه **مش** هنا: ده إجمالي الطلب اللي
   إحنا باعتينه (order.total)، ولو اترجع كان هيتسجّل كتكلفة مندوب غلط. */
const FEE_KEYS = ["delivery_fee", "delivery_charge", "delivery_cost", "shipping_fee", "shipping_cost",
  "courier_fee", "fee", "fees", "price", "cost", "charge", "charges", "amount_due", "total_fee", "total_price"];
const DIST_KEYS = ["distance", "distance_km", "total_distance", "total_distance_km", "km"];
export function feeFromApi(d) {
  if (!d || typeof d !== "object") return { fee: null, distanceKm: null, keys: [] };
  const src = { ...d, ...(d.pricing && typeof d.pricing === "object" ? d.pricing : {}),
                ...(d.order && typeof d.order === "object" ? d.order : {}) };
  let fee = null; let distanceKm = null;
  for (const k of FEE_KEYS) { const n = num(src[k]); if (n != null && n > 0) { fee = n; break; } }
  for (const k of DIST_KEYS) { const n = num(src[k]); if (n != null && n > 0) { distanceKm = n; break; } }
  return { fee, distanceKm, keys: Object.keys(d).sort() };
}

/* ── استيراد الفاتورة/تصدير لوحتهم ─────────────────────────────────────────
   مانعرفش شكل ملفهم بالظبط لسه (أول فاتورة أول أكتوبر)، فبنتعرّف على
   الأعمدة بالاسم عربي/إنجليزي. كل عمود ليه قايمة أنماط بالأولوية. */
const normKey = (k) => String(k || "").toLowerCase().replace(/[\s_\-.:()\/]+/g, " ").trim();
const COLS = {
  ref: [/dsp/, /client order|order id|order no|order number|order ref|reference|tracking|^ref$|^id$|^order$/,
        /رقم الطلب|رقم الشحنة|المرجع|رقم الطلبية|^الطلب$|رقم العميل للطلب/],
  exVat: [/(excl|before|without|ex) ?(vat|tax)|subtotal|net amount/, /قبل الضريبة|بدون ضريبة|بدون الضريبة|الصافي/],
  vat: [/^vat$|^tax$|vat amount|tax amount|^vat 15|vat \(/, /^الضريبة$|ضريبة القيمة|قيمة الضريبة|^ضريبة$/],
  total: [/(incl|with|including) ?(vat|tax)|grand total|total amount|^total$|^amount$|net payable/,
          /شامل|الإجمالي|الاجمالي|المجموع|^المبلغ$|المستحق/],
  fee: [/delivery (fee|charge|cost)|shipping|^fee$|^price$|^cost$|^charge$|trip (fee|cost)/, /رسوم التوصيل|رسوم|التكلفة|السعر|الأجرة|الاجرة/],
  extra: [/extra|additional|excess/, /إضافي|اضافي|زيادة/],
  cancelFee: [/cancel/, /إلغاء|الغاء/],
  distance: [/distance|^km$|kilomet/, /المسافة|مسافة|^كم$|كيلو/],
  status: [/status|state/, /الحالة|حالة/],
  date: [/date|created|time|day/, /التاريخ|تاريخ|الوقت|اليوم/],
};
function pick(obj, keys, patterns) {
  for (const p of patterns) {
    for (const k of keys) if (p.test(normKey(k))) return { key: k, value: obj[k] };
  }
  return null;
}
/* بيحوّل صف خام (أي أسماء أعمدة) لسطر فاتورة موحّد. */
export function mapInvoiceRow(obj, contractIn) {
  const c = contractIn || ljContract();
  const vatRate = c.vatPct / 100;
  const keys = Object.keys(obj || {});
  const used = new Set();
  const take = (name, filter) => {
    const ks = keys.filter((k) => !used.has(k) && (!filter || filter(k)));
    const hit = pick(obj, ks, COLS[name]);
    if (hit) used.add(hit.key);
    return hit;
  };
  // الترتيب مهم: «رسوم الإلغاء» و«المسافة الإضافية» قبل «الرسوم» العامة،
  // و«قبل الضريبة» قبل «الإجمالي» عشان «الإجمالي قبل الضريبة» مايتاخدش إجمالي.
  const ref = take("ref");
  const cancelFee = take("cancelFee", (k) => !/status|الحالة/.test(normKey(k)));
  const extra = take("extra");
  const distance = take("distance");
  const exVat = take("exVat");
  const vat = take("vat");
  const total = take("total");
  const fee = take("fee");
  const status = take("status");
  const date = take("date");

  let tot = num(total?.value);
  let ex = num(exVat?.value);
  let v = num(vat?.value);
  const f = num(fee?.value);
  if (tot == null && f != null) tot = ex == null && v == null ? f : null;   // عمود «رسوم» لوحده = شامل
  if (ex == null && f != null && tot != null && f !== tot) ex = f;          // رسوم + إجمالي → الرسوم قبل الضريبة
  if (tot == null && ex != null) tot = r2(ex + (v != null ? v : ex * vatRate));
  if (ex == null && tot != null) ex = r2(v != null ? tot - v : tot / (1 + vatRate));
  if (v == null && tot != null && ex != null) v = r2(tot - ex);
  return {
    ref: ref && ref.value != null ? String(ref.value).trim() : "",
    total: tot != null ? r2(tot) : null,
    exVat: ex != null ? r2(ex) : null,
    vat: v != null ? r2(v) : null,
    distanceKm: num(distance?.value),
    extraKmCharge: num(extra?.value),
    cancelFee: num(cancelFee?.value),
    status: status && status.value != null ? String(status.value).trim() : null,
    date: date && date.value != null ? String(date.value).trim() : null,
    columns: { ref: ref?.key || null, total: total?.key || fee?.key || null, exVat: exVat?.key || null,
               vat: vat?.key || null, distance: distance?.key || null, status: status?.key || null, date: date?.key || null },
  };
}

/* ── المطابقة نفسها (دالة صافية — بتتجرب أوفلاين) ──────────────────────────
   shipments: صفوف dl_shipments (+ بيانات الطلب)، orphanOrders: طلبات توصيل
   اتوصّلت من غير شحنة، lines: سطور الفاتورة المستوردة للشهر. */
const CANCEL_RX = /cancel|ملغ|الغاء|إلغاء|rejected|مرفوض/i;
export function reconcile({ shipments = [], orphanOrders = [], lines = [], dashLines = [], contract, invoice = null } = {}) {
  const c = contract || ljContract();
  const tol = c.tolerance;
  const byOrder = new Map();
  for (const s of shipments) {
    const k = s.orderNo;
    byOrder.set(k, (byOrder.get(k) || 0) + (s.status === "cancelled" ? 0 : 1));
  }
  // سطور الفاتورة: عدّ المرجع عشان المكرر، وربطها بالشحنة
  const lineCount = new Map();
  for (const l of lines) if (l.ref) lineCount.set(l.ref, (lineCount.get(l.ref) || 0) + 1);
  const lineOf = new Map();       // shipmentId → [lines]
  const unmatched = [];
  const idxRef = new Map();
  for (const s of shipments) {
    if (s.providerRef) idxRef.set(String(s.providerRef), s.id);
    if (s.orderNo) idxRef.set(String(s.orderNo), idxRef.get(String(s.orderNo)) ?? s.id);
  }
  // لو لطلب واحد أكتر من شحنة، رقم طلبنا يروح لآخر شحنة مش ملغية
  for (const s of shipments) if (s.status !== "cancelled" && s.orderNo) idxRef.set(String(s.orderNo), s.id);
  const ids = new Set(shipments.map((s) => s.id));
  for (const l of lines) {
    const sid = l.shipmentId ?? idxRef.get(String(l.ref || ""));
    if (sid == null) { unmatched.push({ ...l, flags: ["invoice_line_unmatched"] }); continue; }
    // سطر في فاتورة الشهر ده لشحنة من شهر تاني (طلب آخر الليل على حدود الشهر)
    if (!ids.has(sid)) { unmatched.push({ ...l, flags: ["invoice_line_other_month"] }); continue; }
    if (!lineOf.has(sid)) lineOf.set(sid, []);
    lineOf.get(sid).push(l);
  }
  /* تصدير لوحتهم (سعر كل طلب بعد التوصيل) — مصدر تاني للمفوتَر، أقل من
     الفاتورة وأعلى من «المتوقَّع». السطور الملغية بصفر اللي مش بتاعتنا
     (تجارب التفعيل ٣٠/٨) مابتتعرضش. */
  const dashOf = new Map();
  for (const l of dashLines) {
    const sid = l.shipmentId;
    if (sid == null || !ids.has(sid)) {
      if ((Number(l.total) || 0) > tol) unmatched.push({ ...l, flags: [sid == null ? "dashboard_line_unmatched" : "invoice_line_other_month"] });
      continue;
    }
    if (!dashOf.has(sid)) dashOf.set(sid, []);
    dashOf.get(sid).push(l);
  }

  const rows = shipments.map((s) => {
    const picked = Boolean(s.pickedAt) || s.status === "delivered";
    const exp = expectedLeajlakFee({ km: s.ourKm, status: s.status, picked }, c);
    const ls = lineOf.get(s.id) || [];
    const invoiced = ls.length ? r2(ls.reduce((a, l) => a + (Number(l.total) || 0) + (Number(l.cancelFee) || 0), 0)) : null;
    const dl = dashOf.get(s.id) || [];
    const dash = dl.length ? r2(dl.reduce((a, l) => a + (Number(l.total) || 0), 0)) : null;
    // المفوتَر: الفاتورة أولاً، بعدها المسجّل يدوي/من الـAPI، بعدها لوحتهم
    const charged = invoiced != null ? invoiced : (s.feeActual != null ? r2(s.feeActual) : dash);
    const chargedSource = invoiced != null ? "invoice" : (s.feeActual != null ? (s.feeSource || "manual") : (dash != null ? "dashboard" : null));
    const theirKm = ls.find((l) => l.distanceKm != null)?.distanceKm ?? dl.find((l) => l.distanceKm != null)?.distanceKm
      ?? s.feeDistanceKm ?? null;
    const cost = charged != null ? charged : exp.total;
    const slack = feeSlack(s.ourKm, c);
    const flags = [];
    if (charged != null && charged > exp.total + slack) flags.push("over_expected");
    if (charged != null && charged < exp.total - slack) flags.push("under_expected");
    if (invoiced != null && dash != null && Math.abs(invoiced - dash) > tol) flags.push("dashboard_vs_invoice");
    if (s.status === "cancelled" && charged != null && charged > tol) flags.push("charged_cancelled");
    if (ls.length > 1 || ls.some((l) => (lineCount.get(l.ref) || 0) > 1)) flags.push("duplicate_invoice_line");
    if ((byOrder.get(s.orderNo) || 0) > 1 && s.status !== "cancelled") flags.push("duplicate_shipment");
    if (theirKm != null && s.ourKm != null && Math.abs(Number(theirKm) - Number(s.ourKm)) > c.distanceGapKm) flags.push("distance_gap");
    if (s.ourKm == null) flags.push("no_distance");
    if (ls.some((l) => l.status && CANCEL_RX.test(l.status)) && s.status !== "cancelled") flags.push("status_mismatch");
    if (s.status !== "cancelled" && s.status !== "delivered") flags.push("in_flight");
    // الفاتورة اتستوردت والشحنة الموصّلة مش فيها — لصالحنا، بس ممكن تيجي الشهر الجاي
    if (lines.length && !ls.length && s.status === "delivered" && s.feeActual == null) flags.push("missing_from_invoice");
    const invoicedEx = ls.length && ls.every((l) => l.exVat != null) ? r2(ls.reduce((a, l) => a + Number(l.exVat), 0)) : null;
    const customerFee = r2(s.customerFee);
    return {
      id: s.id, orderNo: s.orderNo, providerRef: s.providerRef, at: s.createdAt, period: s.period,
      status: s.status, orderStatus: s.orderStatus || null, isTest: Boolean(s.isTest),
      ourKm: s.ourKm != null ? r2(s.ourKm) : null, distanceSource: s.distanceSource || null,
      // مسافتهم بـ٣ خانات زي ملفهم (0.017) — r2 كانت هتخليها 0.02
      theirKm: theirKm != null ? Math.round(Number(theirKm) * 1000) / 1000 : null,
      expected: exp, charged, chargedSource, invoiceLines: ls.length, dashboard: dash,
      chargedExVat: invoicedEx != null ? invoicedEx : (charged != null ? r2(charged / (1 + c.vatPct / 100)) : null),
      line: ls[0] ? { date: ls[0].date, theirNo: ls[0].theirNo || null, status: ls[0].status || null, shop: ls[0].shop || null,
                      client: ls[0].client || null, paymentType: ls[0].paymentType || null } : null,
      theirNo: (ls[0] && ls[0].theirNo) || (dl[0] && dl[0].theirNo) || s.providerOrderNo || null,
      diff: charged != null ? r2(charged - exp.total) : null,
      customerFee, margin: r2(customerFee - cost), marginBasis: charged != null ? "charged" : "expected",
      farSurcharge: s.farSurcharge != null ? r2(s.farSurcharge) : null,
      ticked: Boolean(s.reconOk), note: s.feeNote || null, flags,
    };
  });
  for (const o of orphanOrders) {
    rows.push({
      id: null, orderNo: o.orderNo, providerRef: null, at: o.createdAt, period: o.period,
      status: null, orderStatus: o.orderStatus, isTest: Boolean(o.isTest),
      ourKm: o.ourKm != null ? r2(o.ourKm) : null, distanceSource: o.distanceSource || null, theirKm: null,
      expected: null, charged: null, chargedSource: null, invoiceLines: 0, diff: null,
      customerFee: r2(o.customerFee), margin: null, marginBasis: null, farSurcharge: null,
      ticked: false, note: null, flags: ["missing_shipment"],
    });
  }
  rows.sort((a, b) => new Date(a.at) - new Date(b.at));

  const real = rows.filter((r) => r.id != null);
  const sum = (arr, f) => r2(arr.reduce((a, r) => a + (Number(f(r)) || 0), 0));
  const billable = real.filter((r) => r.expected && r.expected.total > 0);
  const totals = {
    shipments: real.length,
    delivered: real.filter((r) => r.status === "delivered").length,
    cancelled: real.filter((r) => r.status === "cancelled").length,
    test: real.filter((r) => r.isTest).length,
    billable: billable.length,
    expectedExVat: sum(real, (r) => r.expected.exVat),
    expectedVat: sum(real, (r) => r.expected.vat),
    expectedTotal: sum(real, (r) => r.expected.total),
    extraKmTotal: sum(real, (r) => r.expected.extraKm),
    charged: sum(real, (r) => r.charged),
    chargedCount: real.filter((r) => r.charged != null).length,
    invoiceLines: lines.length,
    invoiceTotal: sum(lines, (l) => (Number(l.total) || 0) + (Number(l.cancelFee) || 0)),
    unmatchedLines: unmatched.length,
    unmatchedTotal: sum(unmatched, (l) => (Number(l.total) || 0) + (Number(l.cancelFee) || 0)),
    strayTotal: sum(unmatched.filter((l) => l.flags.includes("invoice_line_unmatched")), (l) => (Number(l.total) || 0) + (Number(l.cancelFee) || 0)),
    dashboardLines: dashLines.length,
    dashboardCount: real.filter((r) => r.dashboard != null).length,
    dashboardStray: sum(unmatched.filter((l) => l.flags.includes("dashboard_line_unmatched")), (l) => l.total),
    customerFees: sum(real, (r) => r.customerFee),
    // الهامش على المفوتَر لو موجود وإلا المتوقَّع — عشان الرقم مايبقاش صفر قبل الفاتورة
    margin: sum(real, (r) => r.margin),
    ticked: real.filter((r) => r.ticked).length,
    missingShipments: rows.filter((r) => r.flags.includes("missing_shipment")).length,
  };
  // اللي هنطالب بيه لاجلك = المفوتَر زيادة عن المتوقَّع + رسوم على ملغي + المكرر + سطور مش بتاعتنا
  const dispute = r2(
    real.reduce((a, r) => a + (r.flags.includes("charged_cancelled") ? (r.charged || 0)
      : r.flags.includes("over_expected") ? (r.diff || 0) : 0), 0)
    + totals.strayTotal
    // طلب متسعّر في لوحتهم ومش بتاعنا — لحد ما الفاتورة توصل هو المرشّح للسؤال
    + (lines.length ? 0 : totals.dashboardStray));
  totals.disputeCandidate = dispute;
  const anomalies = {};
  for (const r of rows) for (const f of r.flags) anomalies[f] = (anomalies[f] || 0) + 1;
  for (const l of unmatched) for (const f of l.flags) anomalies[f] = (anomalies[f] || 0) + 1;
  totals.chargedExVat = sum(real, (r) => r.chargedExVat);
  return { contract: c, totals, anomalies, rows, unmatched, invoice };
}

export const FLAG_AR = {
  over_expected: "مفوتَر أكتر من العقد",
  under_expected: "مفوتَر أقل من المتوقَّع",
  charged_cancelled: "رسوم على شحنة ملغية",
  duplicate_invoice_line: "سطر مكرر في الفاتورة",
  duplicate_shipment: "أكتر من شحنة شغّالة لنفس الطلب",
  distance_gap: "مسافتهم بعيدة عن مسافتنا",
  no_distance: "مفيش مسافة محفوظة عندنا",
  status_mismatch: "ملغية عندهم ومتوصّلة عندنا",
  in_flight: "لسه في الطريق",
  missing_shipment: "طلب توصيل من غير شحنة",
  invoice_line_unmatched: "سطر في الفاتورة مش لاقيين طلبه",
  invoice_line_other_month: "سطر لشحنة من شهر تاني",
  dashboard_line_unmatched: "متسعّر في لوحتهم ومش لاقيين طلبه",
  dashboard_vs_invoice: "سعر لوحتهم ≠ الفاتورة",
  missing_from_invoice: "موصّلة ومش في فاتورتهم",
};

const STATUS_AR = { delivered: "تم التوصيل", cancelled: "ملغية", pending: "جديد", assigned: "مع كابتن", picked: "في الطريق" };

/* ── ملف لاجلك الشهري «<CLIENT> <Month> Order Details.xlsx» ─────────────────
   الشكل الحقيقي (فاتورة أغسطس ٢٠٢٦، INV/2026/00598):
     Order Date | Order No | Client Name | Shop Name | AWB | Dist. b/w Shop & Dlvry | Order Status | Payment Type
     8/30/26    | 3142728  | FRESH CUTS  | FRESH CUTS-JED-SALAMAH | W1788110759469 | 0.017 | Delivered | Pre Paid
   وتحت الجدول ملخص (مش سطور):
     Total Order Delivered 1 · Financial request for delivery SAR 17.00 · COD Charge ·
     Cash in Hand · Extra km 0.00 · Financial request Extra km · Payment SAR 17.00
   • AWB = رقم طلبنا (W…). Order No = رقمهم الداخلي (مش الـdsp_order_id).
   • مفيش سعر لكل سطر — الفلوس في الملخص قبل الضريبة، والفاتورة الضريبية
     (PDF) = Delivered 3PL كمية × ١٧ + ١٥٪.
   فسعر السطر = (Financial request for delivery ÷ Total Order Delivered) للموصّل
   + الكم الإضافي من مسافتهم × سعر الكم (من الملخص لو موجود، وإلا العقد). */
export const LJ_EXPORT_COLS = ["Order Date", "Order No", "Client Name", "Shop Name", "AWB",
  "Dist. b/w Shop & Dlvry", "Order Status", "Payment Type"];
const SUMMARY_KEYS = [
  ["delivered", /total order delivered/],
  ["extraKmExVat", /financial request extra ?km/],
  ["deliveryExVat", /financial request for delivery/],
  ["codCharge", /cod charge/],
  ["cashInHand", /cash in hand/],
  ["extraKm", /^extra ?km$/],
  ["paymentExVat", /^payment$/],
];

/* "8/30/26" (M/D/YY زي ملفهم) / "2026-08-30" / "30/08/2026" → YYYY-MM-DD */
export function parseLjDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {           // رقم تاريخ إكسل
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    y = y.length === 2 ? `20${y}` : y;
    // ملفهم M/D/YY؛ لو الأول > ١٢ يبقى D/M
    let mo = Number(a), d = Number(b);
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/* ── تصدير لوحة لاجلك «client-order-export-<client>.csv» ───────────────────
   الشكل الحقيقي (عمر صدّره ١٩/٩):
     Order ID | Client ID | Shop Name | Area | Zone | Amount | Delivery Charge | Order Date | Status | Assigned Captain
     OR#3245496 | #W1789733313648 | FRESH CUTS-JED-SALAMAH | NORTH JEDDAH | AL SALAMAH(JED) | 96.00 SAR | 17.80 SAR | 2026-09-18 | Delivered | …
   • Client ID = «#» + رقم طلبنا. Order ID = «OR#» + رقمهم الداخلي (نفس Order No في ملف الفاتورة).
   • Amount = إجمالي طلبنا اللي بعتناه (order.total) — **مش** رسوم.
   • Delivery Charge = رسوم التوصيل **قبل الضريبة**، بتتحسب بعد التوصيل (الملغي 0.00).
   • مفيش مسافة — بنستنتجها من الرسوم لما تعدّي الأجرة الثابتة (impliedKmFromFee).
   • اسم الكابتن مابنخزّنوش (مش محتاجينه للمطابقة). */
export function isDashboardExportHeader(row) {
  const h = (row || []).map((x) => normKey(x));
  return h.includes("client id") && h.some((x) => /^delivery charge$/.test(x));
}
export function parseLeajlakDashboardExport(grid, contractIn) {
  const c = contractIn || ljContract();
  const vatRate = c.vatPct / 100;
  const cell = (x) => (x == null ? "" : String(x).trim());
  const hi = (grid || []).findIndex((r) => isDashboardExportHeader(r));
  if (hi < 0) return null;
  const head = grid[hi].map((h, i) => cell(h) || `col${i + 1}`);
  const col = (rx) => head.findIndex((h) => rx.test(normKey(h)));
  const iNo = col(/^order id$/), iRef = col(/^client id$/), iAmt = col(/^amount$/), iFee = col(/^delivery charge$/),
    iDate = col(/^order date$|date/), iStatus = col(/^status$/), iShop = col(/^shop name$/), iArea = col(/^area$/), iZone = col(/^zone$/);
  const lines = [];
  for (let k = hi + 1; k < grid.length; k += 1) {
    const r = grid[k] || [];
    if (!r.some((x) => cell(x))) continue;
    const ref = cell(r[iRef]).replace(/^#+/, "").trim();
    const theirNo = iNo >= 0 ? cell(r[iNo]).replace(/^OR#?/i, "").replace(/^#/, "").trim() || null : null;
    const ex = num(r[iFee]);
    const status = iStatus >= 0 ? cell(r[iStatus]) : null;
    const exVat = ex == null ? null : r2(ex);
    lines.push({
      ref, theirNo, status, date: parseLjDate(iDate >= 0 ? r[iDate] : null),
      exVat, vat: exVat == null ? null : r2(exVat * vatRate), total: exVat == null ? null : r2(exVat * (1 + vatRate)),
      distanceKm: impliedKmFromFee(exVat, c), distanceImplied: true,
      extraKm: exVat != null && exVat > c.flatExVat ? r2((exVat - c.flatExVat) / (c.perKmExVat || 1)) : 0,
      extraKmCharge: exVat != null && exVat > c.flatExVat ? r2((exVat - c.flatExVat) * (1 + vatRate)) : null,
      cancelFee: null, orderAmount: iAmt >= 0 ? num(r[iAmt]) : null,
      shop: iShop >= 0 ? cell(r[iShop]) : null,
      raw: { "Order ID": iNo >= 0 ? cell(r[iNo]) : "", "Client ID": iRef >= 0 ? cell(r[iRef]) : "",
             "Shop Name": iShop >= 0 ? cell(r[iShop]) : "", Area: iArea >= 0 ? cell(r[iArea]) : "", Zone: iZone >= 0 ? cell(r[iZone]) : "",
             Amount: iAmt >= 0 ? cell(r[iAmt]) : "", "Delivery Charge": iFee >= 0 ? cell(r[iFee]) : "",
             "Order Date": iDate >= 0 ? cell(r[iDate]) : "", Status: status || "" },
    });
  }
  // «بيفسّر» كل سطر بالعقد: الأجرة الثابتة، أو ثابتة + كسر كيلو، أو صفر للملغي
  const fits = (l) => {
    if (l.exVat == null) return false;
    if (CANCEL_RX.test(l.status || "")) return Math.abs(l.exVat - c.cancelFeeExVat) < 0.01;
    return l.exVat >= c.flatExVat - 0.005;
  };
  const checks = {
    rows: lines.length,
    delivered: lines.filter((l) => /deliver/i.test(l.status || "")).length,
    cancelled: lines.filter((l) => CANCEL_RX.test(l.status || "")).length,
    flatRows: lines.filter((l) => l.exVat != null && Math.abs(l.exVat - c.flatExVat) < 0.005).length,
    extraRows: lines.filter((l) => l.exVat != null && l.exVat > c.flatExVat + 0.005).length,
    notFitting: lines.filter((l) => !fits(l)).map((l) => ({ ref: l.ref, theirNo: l.theirNo, exVat: l.exVat, status: l.status })),
    exVatTotal: r2(lines.reduce((a, l) => a + (l.exVat || 0), 0)),
  };
  return { format: "leajlak_dashboard_export", lines, summary: null, checks, header: head };
}

/* شبكة الشيت (صفوف × خلايا) → سطور + ملخص. بيتعرّف على ملف لاجلك
   الحقيقي؛ لو الملف شكل تاني (فيه عمود سعر) بيرجع للمطابقة العامة. */
export function parseLeajlakSheet(grid, contractIn) {
  const c = contractIn || ljContract();
  const vatRate = c.vatPct / 100;
  const dash = parseLeajlakDashboardExport(grid, c);
  if (dash) return dash;
  const cell = (x) => (x == null ? "" : String(x).trim());
  const hi = (grid || []).findIndex((r) => (r || []).some((x) => /^awb$/i.test(cell(x)))
    || ((r || []).some((x) => /order ?no|رقم الطلب/i.test(cell(x))) && (r || []).filter((x) => cell(x)).length >= 3));
  if (hi < 0) return { format: "unknown", lines: [], summary: null, checks: null };
  const head = grid[hi].map((h, i) => cell(h) || `col${i + 1}`);
  const col = (rx) => head.findIndex((h) => rx.test(normKey(h)));
  const iAwb = col(/^awb$/), iNo = col(/^order no$|^order number$/), iDate = col(/date/),
    iDist = col(/dist/), iStatus = col(/status/), iPay = col(/payment type/), iShop = col(/shop name/),
    iClient = col(/client name/);
  const body = [];
  let k = hi + 1;
  for (; k < grid.length; k += 1) {
    const r = grid[k] || [];
    if (!r.some((x) => cell(x))) break;             // أول سطر فاضي = نهاية الجدول
    body.push(r);
  }
  // الملخص: أي صف بعد الجدول فيه عنوان معروف — القيمة = آخر خلية مش فاضية
  const summary = {};
  for (; k < grid.length; k += 1) {
    const r = (grid[k] || []).map(cell);
    const labelIdx = r.findIndex((x) => x && SUMMARY_KEYS.some(([, rx]) => rx.test(normKey(x))));
    if (labelIdx < 0) continue;
    const key = SUMMARY_KEYS.find(([, rx]) => rx.test(normKey(r[labelIdx])))[0];
    const vals = r.slice(labelIdx + 1).filter((x) => x);
    const v = vals.length ? num(vals[vals.length - 1]) : null;
    summary[key] = v == null ? 0 : v;               // «SAR -» = صفر
  }
  const hasSummary = Object.keys(summary).length > 0;
  const priceCol = head.findIndex((h) => /fee|price|amount|total|charge|cost|رسوم|المبلغ|الإجمالي|السعر/i.test(h));
  if (iAwb < 0 || priceCol >= 0) {
    // شكل تاني فيه سعر لكل سطر → المطابقة العامة بالأسماء
    const rows = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
    const lines = rows.map((o) => ({ ...mapInvoiceRow(o, c), raw: o })).filter((l) => l.ref || l.total != null)
      .map((l) => ({ ...l, date: parseLjDate(l.date) || l.date }));
    return { format: "generic", lines, summary: hasSummary ? summary : null, checks: null, header: head };
  }
  const isDelivered = (s) => /deliver|تم التوصيل|موصل/i.test(s);
  const delivered = body.filter((r) => isDelivered(cell(r[iStatus])));
  const nDel = summary.delivered || delivered.length;
  const rate = summary.deliveryExVat > 0 && nDel > 0 ? r2(summary.deliveryExVat / nDel) : c.flatExVat;
  const extraRate = summary.extraKm > 0 && summary.extraKmExVat > 0 ? summary.extraKmExVat / summary.extraKm : c.perKmExVat;
  const lines = body.map((r) => {
    const status = cell(r[iStatus]);
    const dist = iDist >= 0 ? num(r[iDist]) : null;
    const over = dist == null ? 0 : Math.max(0, dist - c.includedKm);
    const extraKm = over <= 0 ? 0 : (c.kmRounding === "ceil" ? Math.ceil(over - 1e-9) : r2(over));
    const billed = isDelivered(status);
    const ex = billed ? r2(rate + extraKm * extraRate) : 0;
    return {
      ref: iAwb >= 0 ? cell(r[iAwb]) : "", theirNo: iNo >= 0 ? cell(r[iNo]) : null,
      date: parseLjDate(iDate >= 0 ? r[iDate] : null), status, distanceKm: dist, extraKm: billed ? extraKm : 0,
      exVat: ex, vat: r2(ex * vatRate), total: r2(ex * (1 + vatRate)), extraKmCharge: billed && extraKm ? r2(extraKm * extraRate) : null,
      cancelFee: null, shop: iShop >= 0 ? cell(r[iShop]) : null, client: iClient >= 0 ? cell(r[iClient]) : null,
      paymentType: iPay >= 0 ? cell(r[iPay]) : null,
      raw: Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])),
    };
  });
  const linesExVat = r2(lines.reduce((a, l) => a + l.exVat, 0));
  const expectedPayment = hasSummary
    ? r2((summary.deliveryExVat || 0) + (summary.codCharge || 0) + (summary.extraKmExVat || 0) - (summary.cashInHand || 0)) : null;
  const checks = {
    rows: lines.length, deliveredRows: delivered.length, perOrderExVat: rate, extraKmRate: r2(extraRate),
    linesExVat,
    deliveredCountMatches: summary.delivered == null ? null : summary.delivered === delivered.length,
    paymentMatchesSummary: expectedPayment == null || summary.paymentExVat == null ? null : Math.abs(expectedPayment - summary.paymentExVat) < 0.01,
    linesMatchPayment: summary.paymentExVat == null ? null : Math.abs(linesExVat - (summary.paymentExVat + (summary.cashInHand || 0) - (summary.codCharge || 0))) < 0.05,
    rateMatchesContract: Math.abs(rate - c.flatExVat) < 0.01,
  };
  return { format: "leajlak_order_details", lines, summary: hasSummary ? summary : null, checks, header: head };
}

/* الشهر الغالب في تواريخ السطور — عشان ملف أغسطس مايتحطّش على سبتمبر غلط. */
export function dominantMonth(lines) {
  const n = {};
  for (const l of lines || []) { const m = /^\d{4}-\d{2}/.exec(String(l.date || "")); if (m) n[m[0]] = (n[m[0]] || 0) + 1; }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const STATUS_EN = { delivered: "Delivered", cancelled: "Cancelled", pending: "New Order", assigned: "Order Accept", picked: "Shipped" };
const mdY = (iso) => {                               // نفس شكل تاريخهم: 8/30/26
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : "";
};
const riyadhDate = (d) => {
  try { return new Date(d).toLocaleString("sv-SE", { timeZone: "Asia/Riyadh" }).slice(0, 10); } catch { return null; }
};

/* جدول التصدير: نفس أعمدة ملفهم بالظبط (بنفس الترتيب) + أعمدتنا جنبها،
   وتحت نفس ملخصهم بعمودين «لاجلك» و«إحنا» — آخر الشهر تحط الملفين جنب
   بعض وتعلّم سطر سطر. */
export function exportTable(rec, { shopName = "FRESH CUTS-JED-SALAMAH", clientName = "FRESH CUTS" } = {}) {
  const L = FLAG_AR;
  const rows = rec.rows.map((r) => {
    const ln = r.line || {};
    return {
      "Order Date": ln.date ? mdY(ln.date) : mdY(riyadhDate(r.at)),
      "Order No": r.theirNo || ln.theirNo || "",
      "Client Name": ln.client || clientName,
      "Shop Name": ln.shop || shopName,
      "AWB": r.orderNo,
      "Dist. b/w Shop & Dlvry": r.theirKm ?? "",
      "Order Status": ln.status || (r.status ? STATUS_EN[r.status] || r.status : ""),
      "Payment Type": ln.paymentType || "Pre Paid",
      "✓": r.ticked ? "✓" : "",
      "مسافتنا كم": r.ourKm ?? "",
      "كم إضافي": r.expected?.extraKm ?? "",
      "المتوقع قبل الضريبة": r.expected?.exVat ?? "",
      "المفوتر قبل الضريبة": r.chargedExVat ?? "",
      "الفرق قبل الضريبة": r.chargedExVat != null && r.expected ? r2(r.chargedExVat - r.expected.exVat) : "",
      "المفوتر شامل": r.charged ?? "",
      "رسوم العميل": r.customerFee,
      "الهامش": r.margin ?? "",
      "مرجع لاجلك (dsp)": r.providerRef || "",
      "ملاحظات": [r.isTest ? "طلب تجريبي" : "", ...r.flags.map((f) => L[f] || f)].filter(Boolean).join(" · "),
    };
  });
  for (const l of rec.unmatched || []) {
    rows.push({
      "Order Date": mdY(l.date), "Order No": l.theirNo || "", "Client Name": l.client || clientName,
      "Shop Name": l.shop || shopName, "AWB": l.ref || "", "Dist. b/w Shop & Dlvry": l.distanceKm ?? "",
      "Order Status": l.status || "", "Payment Type": l.paymentType || "",
      "✓": "", "مسافتنا كم": "", "كم إضافي": l.extraKm ?? "", "المتوقع قبل الضريبة": "",
      "المفوتر قبل الضريبة": l.exVat ?? "", "الفرق قبل الضريبة": "", "المفوتر شامل": l.total ?? "",
      "رسوم العميل": "", "الهامش": "", "مرجع لاجلك (dsp)": "",
      "ملاحظات": l.flags.map((f) => L[f] || f).join(" · "),
    });
  }
  const t = rec.totals; const s = rec.invoice?.summary || {};
  const ours = rec.rows.filter((r) => r.status === "delivered");
  const ourExtraKm = r2(ours.reduce((a, r) => a + (r.expected?.extraKm || 0), 0));
  const ourExtraEx = r2(ours.reduce((a, r) => a + (r.expected?.extraExVat || 0), 0));
  const ourDelEx = r2(ours.reduce((a, r) => a + ((r.expected?.exVat || 0) - (r.expected?.extraExVat || 0)), 0));
  const summary = [
    { label: "Total Order Delivered", leajlak: s.delivered ?? "", ours: ours.length },
    { label: "Financial request for delivery", leajlak: s.deliveryExVat ?? "", ours: ourDelEx },
    { label: "COD Charge", leajlak: s.codCharge ?? "", ours: 0 },
    { label: "Cash in Hand", leajlak: s.cashInHand ?? "", ours: 0 },
    { label: "Extra km", leajlak: s.extraKm ?? "", ours: ourExtraKm },
    { label: "Financial request Extra km", leajlak: s.extraKmExVat ?? "", ours: ourExtraEx },
    { label: "Payment", leajlak: s.paymentExVat ?? "", ours: r2(ourDelEx + ourExtraEx) },
    { label: "VAT 15%", leajlak: rec.invoice?.taxInvoice?.vat ?? "", ours: r2((ourDelEx + ourExtraEx) * (rec.contract.vatPct / 100)) },
    { label: "Invoice Total (incl. VAT)", leajlak: rec.invoice?.taxInvoice?.total ?? "", ours: r2((ourDelEx + ourExtraEx) * (1 + rec.contract.vatPct / 100)) },
  ];
  return { columns: rows.length ? Object.keys(rows[0]) : [...LJ_EXPORT_COLS], rows, summary, totals: t };
}

export function toCsv(rec, opts = {}) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const tb = exportTable(rec, opts);
  const cols = tb.columns;
  const out = [cols.map(esc).join(",")];
  for (const r of tb.rows) out.push(cols.map((k) => esc(r[k])).join(","));
  out.push("");
  out.push(["", "", "", "", "", "", "Leajlak", "Fresh Cuts (expected)"].map(esc).join(","));
  for (const s of tb.summary) out.push(["", "", "", s.label, "", "", s.leajlak, s.ours].map(esc).join(","));
  return "﻿" + out.join("\r\n") + "\r\n";
}

/* مصدر سطور «تصدير لوحة لاجلك» في dl_invoice_lines — منفصلة عن سطور الفاتورة */
export const DASH_SOURCE = "dashboard_export";

/* ═══ التسجيل ═════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const providers = deps.providers || (() => ({}));

  async function ensureSchema() {
    await pool.query(`
      -- رسوم لاجلك على كل شحنة. fee_actual = المفوتَر شامل الضريبة (من
      -- الفاتورة/اللوحة/إدخال يدوي/الـAPI لو ضافوه). expected_* = من العقد
      -- على مسافتنا، بتتحسب في الـbackfill وقت ما نقرا.
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_actual NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_vat NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_distance_km NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_extra_km_charge NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_cancel NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_source TEXT;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_updated_at TIMESTAMPTZ;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_note TEXT;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS our_km NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS expected_fee NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS invoice_period TEXT;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS recon_ok BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS recon_ok_at TIMESTAMPTZ;
      -- مفاتيح ردّ الـAPI آخر مرة سألنا — عشان لو لاجلك ضافت حقل سعر نعرف.
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS provider_fields TEXT[];
      CREATE INDEX IF NOT EXISTS dl_shipments_period_idx ON dl_shipments(invoice_period);
      -- سطور فاتورة لاجلك المستوردة (استيراد الشهر بيستبدل سطوره كلها).
      CREATE TABLE IF NOT EXISTS dl_invoice_lines (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'leajlak',
        period TEXT NOT NULL,
        ref TEXT,
        shipment_id BIGINT,
        total NUMERIC,
        ex_vat NUMERIC,
        vat NUMERIC,
        distance_km NUMERIC,
        extra_km_charge NUMERIC,
        cancel_fee NUMERIC,
        status TEXT,
        line_date TEXT,
        raw JSONB,
        source TEXT,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS dl_invoice_lines_period_idx ON dl_invoice_lines(provider, period);
      -- «Order No» في ملفهم = رقمهم الداخلي (مش الـdsp uuid)، AWB = رقم طلبنا
      ALTER TABLE dl_invoice_lines ADD COLUMN IF NOT EXISTS their_no TEXT;
      ALTER TABLE dl_invoice_lines ADD COLUMN IF NOT EXISTS extra_km NUMERIC;
      ALTER TABLE dl_invoice_lines ADD COLUMN IF NOT EXISTS match_by TEXT;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS provider_order_no TEXT;
      -- سعر الطلب من تصدير لوحتهم (بعد التوصيل) — منفصل عن fee_actual
      -- (فاتورة/يدوي) عشان إعادة استيراد الفاتورة ماتمسحوش والعكس.
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_dash NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_dash_ex NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_dash_km NUMERIC;
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS fee_dash_at TIMESTAMPTZ;
      -- cost (اللي التقارير/المالية بتجمعه) = أحسن رقم معروف؛ ده مصدره
      ALTER TABLE dl_shipments ADD COLUMN IF NOT EXISTS cost_basis TEXT;
      -- رأس فاتورة الشهر: ملخص ملف Order Details + الفاتورة الضريبية (PDF)
      CREATE TABLE IF NOT EXISTS dl_invoices (
        provider TEXT NOT NULL DEFAULT 'leajlak',
        period TEXT NOT NULL,
        format TEXT,
        file_name TEXT,
        summary JSONB,
        checks JSONB,
        tax_invoice JSONB,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, period)
      );
    `);
  }

  /* backfill: مسافتنا + المتوقَّع + شهر الفاتورة لكل الشحنات (القديمة
     والجديدة). رخيص — بيتنادى في كل قراءة للشاشة وعند الإقلاع. */
  async function backfill() {
    const c = ljContract((await getSettingsData())?.delivery || {});
    const rows = (await pool.query(
      `SELECT sh.id, sh.status, sh.picked_at, sh.created_at, sh.fee_actual, sh.fee_source, sh.fee_dash, sh.cost, sh.cost_basis,
              NULLIF(s.delivery_quote->>'routeKm','')::numeric AS route_km
         FROM dl_shipments sh LEFT JOIN shop_orders s ON s.order_no = sh.shop_order_no
        WHERE sh.provider = 'leajlak'`)).rows;
    let n = 0;
    for (const r of rows) {
      const km = r.route_km != null ? Number(r.route_km) : null;
      const exp = expectedLeajlakFee({ km, status: r.status, picked: Boolean(r.picked_at) || r.status === "delivered" }, c);
      /* تكلفة الشحنة اللي المالية/تقرير المدير/الاقتصاديات بتجمعها (sh.cost):
         الفاتورة/اليدوي ← سعر لوحتهم ← العقد على مسافتنا. قبل كده كانت
         فاضية لكل شحنات لاجلك فتكلفة التوصيل في التقارير كانت صفر. */
      const [cost, basis] = r.fee_actual != null ? [Number(r.fee_actual), r.fee_source || "manual"]
        : r.fee_dash != null ? [Number(r.fee_dash), "dashboard"]
        : r.status === "cancelled" || r.status === "delivered" || r.picked_at ? [exp.total, "expected"] : [null, null];
      const u = await pool.query(
        `UPDATE dl_shipments SET our_km = $2, expected_fee = $3, cost = $4, cost_basis = $5,
                invoice_period = COALESCE(invoice_period, to_char(created_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM'))
          WHERE id = $1 AND (our_km IS DISTINCT FROM $2 OR expected_fee IS DISTINCT FROM $3 OR invoice_period IS NULL
                OR cost IS DISTINCT FROM $4 OR cost_basis IS DISTINCT FROM $5)`,
        [r.id, km, exp.total, cost, basis]);
      n += u.rowCount;
    }
    return { scanned: rows.length, updated: n };
  }

  ensureSchema()
    .then(() => backfill())
    .then((r) => console.log(`[ljrecon] schema ready, backfill ${r.updated}/${r.scanned}`))
    .catch((e) => console.error("[ljrecon] schema/backfill failed:", e.message));
  // الشحنات الجديدة تاخد تكلفتها من غير ما حد يفتح الشاشة (التقارير بتقرا sh.cost)
  if (!deps.noTimer) {
    const t = setInterval(() => { backfill().catch(() => {}); }, 20 * 60_000);
    if (t.unref) t.unref();
  }

  async function load(month) {
    const c = ljContract((await getSettingsData())?.delivery || {});
    const shipments = (await pool.query(
      `SELECT sh.*, s.delivery_fee AS customer_fee, s.status AS order_status, s.is_test,
              s.delivery_quote->>'distanceSource' AS distance_source,
              NULLIF(s.delivery_quote#>>'{farZone,surcharge}','')::numeric AS far_surcharge
         FROM dl_shipments sh LEFT JOIN shop_orders s ON s.order_no = sh.shop_order_no
        WHERE sh.provider = 'leajlak' AND sh.invoice_period = $1
        ORDER BY sh.created_at`, [month])).rows.map((r) => ({
      id: Number(r.id), orderNo: r.shop_order_no, providerRef: r.provider_ref, createdAt: r.created_at,
      period: r.invoice_period, status: r.status, pickedAt: r.picked_at, orderStatus: r.order_status,
      isTest: r.is_test, ourKm: r.our_km != null ? Number(r.our_km) : null, distanceSource: r.distance_source,
      customerFee: Number(r.customer_fee) || 0, farSurcharge: r.far_surcharge,
      feeActual: r.fee_actual != null ? Number(r.fee_actual) : null, feeSource: r.fee_source,
      feeDistanceKm: r.fee_distance_km != null ? Number(r.fee_distance_km) : null,
      reconOk: r.recon_ok, feeNote: r.fee_note, providerOrderNo: r.provider_order_no,
    }));
    // طلب توصيل اتوصّل/في الطريق من غير أي شحنة لاجلك = يا اتدخّل يدوي على
    // لوحتهم (وهيظهر في الفاتورة من غير ما نعرفه) يا مندوب تاني.
    const orphanOrders = (await pool.query(
      `SELECT s.order_no, s.created_at, s.status, s.is_test, s.delivery_fee,
              NULLIF(s.delivery_quote->>'routeKm','')::numeric AS route_km,
              s.delivery_quote->>'distanceSource' AS distance_source
         FROM shop_orders s
        WHERE s.option = 'delivery'
          AND s.status IN ('courier_requested','courier_assigned','on_the_way','delivered')
          AND to_char(s.created_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM') = $1
          -- أي شحنة (حتى مع شركة تانية زي Flying Arrow) = مش «من غير شحنة»
          AND NOT EXISTS (SELECT 1 FROM dl_shipments sh WHERE sh.shop_order_no = s.order_no)`,
      [month])).rows.map((r) => ({
      orderNo: r.order_no, createdAt: r.created_at, orderStatus: r.status, isTest: r.is_test,
      customerFee: Number(r.delivery_fee) || 0, ourKm: r.route_km != null ? Number(r.route_km) : null,
      distanceSource: r.distance_source, period: month,
    }));
    const allLines = (await pool.query(
      `SELECT * FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 ORDER BY id`, [month])).rows.map((l) => ({
      id: Number(l.id), ref: l.ref, shipmentId: l.shipment_id != null ? Number(l.shipment_id) : null,
      total: l.total != null ? Number(l.total) : null, exVat: l.ex_vat != null ? Number(l.ex_vat) : null,
      vat: l.vat != null ? Number(l.vat) : null, distanceKm: l.distance_km != null ? Number(l.distance_km) : null,
      cancelFee: l.cancel_fee != null ? Number(l.cancel_fee) : null, status: l.status, date: l.line_date,
      theirNo: l.their_no, extraKm: l.extra_km != null ? Number(l.extra_km) : null, matchBy: l.match_by,
      shop: l.raw?.["Shop Name"] || null, client: l.raw?.["Client Name"] || null, paymentType: l.raw?.["Payment Type"] || null,
      source: l.source,
    }));
    const lines = allLines.filter((l) => l.source !== DASH_SOURCE);
    const dashLines = allLines.filter((l) => l.source === DASH_SOURCE);
    const inv = (await pool.query(`SELECT * FROM dl_invoices WHERE provider='leajlak' AND period=$1`, [month])).rows[0];
    const invoice = inv ? { format: inv.format, fileName: inv.file_name, summary: inv.summary, checks: inv.checks,
                            taxInvoice: inv.tax_invoice, importedAt: inv.imported_at } : null;
    return reconcile({ shipments, orphanOrders, lines, dashLines, contract: c, invoice });
  }

  const monthOk = (m) => /^\d{4}-\d{2}$/.test(String(m || ""));
  const riyadhMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);

  /* قايمة الشهور + ملخص كل شهر (للجدول العلوي) */
  app.get("/api/delivery/leajlak/months", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await backfill().catch(() => {});
    const r = (await pool.query(
      `SELECT invoice_period AS month, count(*)::int AS shipments,
              count(*) FILTER (WHERE status='delivered')::int AS delivered,
              count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
              COALESCE(sum(expected_fee),0)::numeric AS expected,
              COALESCE(sum(fee_actual),0)::numeric AS charged_manual,
              count(fee_actual)::int AS with_fee,
              count(*) FILTER (WHERE recon_ok)::int AS ticked
         FROM dl_shipments WHERE provider='leajlak' AND invoice_period IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC`)).rows;
    const inv = (await pool.query(
      `SELECT period, count(*)::int n, COALESCE(sum(COALESCE(total,0)+COALESCE(cancel_fee,0)),0)::numeric t,
              max(imported_at) at
         FROM dl_invoice_lines WHERE provider='leajlak' AND source IS DISTINCT FROM '${DASH_SOURCE}' GROUP BY 1`)).rows;
    const dsh = (await pool.query(
      `SELECT period, count(*)::int n, COALESCE(sum(total),0)::numeric t FROM dl_invoice_lines
        WHERE provider='leajlak' AND source = '${DASH_SOURCE}' GROUP BY 1`)).rows;
    const dshBy = Object.fromEntries(dsh.map((x) => [x.period, x]));
    const invBy = Object.fromEntries(inv.map((x) => [x.period, x]));
    return c.json({
      ok: true, current: riyadhMonth(),
      months: r.map((x) => ({
        month: x.month, shipments: x.shipments, delivered: x.delivered, cancelled: x.cancelled,
        expected: r2(x.expected), withFee: x.with_fee, ticked: x.ticked,
        invoiceLines: invBy[x.month]?.n || 0, invoiceTotal: r2(invBy[x.month]?.t || 0),
        invoiceImportedAt: invBy[x.month]?.at || null,
        dashboardLines: dshBy[x.month]?.n || 0, dashboardTotal: r2(dshBy[x.month]?.t || 0),
      })),
    });
  });

  app.get("/api/delivery/leajlak/recon", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const month = c.req.query("month") || riyadhMonth();
    if (!monthOk(month)) return c.json({ ok: false, error: "month لازم YYYY-MM" }, 400);
    await backfill().catch(() => {});
    const rec = await load(month);
    return c.json({ ok: true, month, flagLabels: FLAG_AR, ...rec, export: exportTable(rec),
      apiFacts: {
        feeInApi: false,
        note: "API الشركاء عند لاجلك مابيرجّعش رسوم ولا مسافة — حتى بعد التوصيل (مجرّب تاني ١٩/٩ على طلب موصّل بـ17.80 في لوحتهم: GET رجّع id/status/dsp_order_id/driver بس، ومفيش مسارات history/details/price/invoice). السعر بعد التوصيل بييجي من تصدير لوحتهم (client-order-export CSV) أو الفاتورة أو إدخال يدوي.",
      } });
  });

  app.get("/api/delivery/leajlak/recon.csv", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const month = c.req.query("month") || riyadhMonth();
    if (!monthOk(month)) return c.text("bad month", 400);
    await backfill().catch(() => {});
    const csv = toCsv(await load(month));
    return new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leajlak-recon-${month}.csv"`,
    } });
  });

  /* استيراد ملف لاجلك الشهري (Order Details.xlsx أو CSV). اللوحة بتبعت
     الشيت خام كشبكة (grid) عشان الملخص اللي تحت الجدول يوصل كمان.
     month = "auto" → الشهر الغالب في تواريخ السطور. إعادة الاستيراد لنفس
     الشهر بتستبدل سطوره — آمنة.
     المطابقة: AWB/رقم طلبنا/الـuuid → رقمهم (Order No) المحفوظ → نفس اليوم
     لو فيه شحنة واحدة بس موصّلة ومش متطابقة في اليوم ده. */
  async function importSheet({ month, grid, rows, fileName, source }) {
    const cfg = ljContract((await getSettingsData())?.delivery || {});
    let parsed;
    if (Array.isArray(grid) && grid.length) parsed = parseLeajlakSheet(grid.slice(0, 6000), cfg);
    else if (Array.isArray(rows) && rows.length) {
      const lines = rows.slice(0, 5000).map((r) => ({ ...mapInvoiceRow(r, cfg), raw: r }))
        .filter((l) => l.ref || l.total != null).map((l) => ({ ...l, date: parseLjDate(l.date) || l.date }));
      parsed = { format: "generic", lines, summary: null, checks: null };
    } else return { ok: false, error: "الملف فاضي" };
    if (parsed.format === "leajlak_dashboard_export") return importDashboard(parsed, fileName, cfg);
    const lines = parsed.lines;
    if (!lines.length) return { ok: false, error: "مالقيناش جدول طلبات في الملف (عمود AWB / Order No)", header: parsed.header || null };
    if (!lines.some((l) => l.ref)) return { ok: false, error: "مالقيناش عمود رقم الطلب (AWB)", header: parsed.header || null };
    if (!lines.some((l) => l.total != null)) return { ok: false, error: "مالقيناش مبالغ في الملف", header: parsed.header || null };
    const detected = dominantMonth(lines);
    const period = month === "auto" || !monthOk(month) ? (detected || riyadhMonth()) : month;

    const refs = [...new Set(lines.flatMap((l) => [l.ref, l.theirNo]).filter(Boolean))];
    const sh = (await pool.query(
      `SELECT id, shop_order_no, provider_ref, provider_order_no, status,
              to_char(created_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM-DD') AS day
         FROM dl_shipments
        WHERE provider='leajlak' AND (provider_ref = ANY($1) OR shop_order_no = ANY($1) OR provider_order_no = ANY($1)
              OR invoice_period = $2)
        ORDER BY (status='cancelled'), id DESC`, [refs, period])).rows;
    const idx = new Map();
    for (const x of sh) {
      for (const k of [x.provider_ref, x.shop_order_no, x.provider_order_no]) if (k && !idx.has(k)) idx.set(k, Number(x.id));
    }
    const used = new Set();
    for (const l of lines) {
      let sid = (l.ref && idx.get(l.ref)) ?? null; let by = sid != null ? "awb" : null;
      if (sid == null && l.theirNo && idx.has(l.theirNo)) { sid = idx.get(l.theirNo); by = "their_no"; }
      l.shipmentId = sid; l.matchBy = by;
      if (sid != null) used.add(sid);
    }
    for (const l of lines) {
      if (l.shipmentId != null || !l.date) continue;
      const cands = sh.filter((x) => x.day === l.date && !used.has(Number(x.id)) && x.status !== "cancelled");
      if (cands.length === 1) { l.shipmentId = Number(cands[0].id); l.matchBy = "date"; used.add(l.shipmentId); }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // سطور الشهر القديمة هتتمسح → الرسوم اللي جت منها على الشحنات ترجع فاضية
      await client.query(
        `UPDATE dl_shipments SET fee_actual=NULL, fee_vat=NULL, fee_distance_km=NULL, fee_extra_km_charge=NULL,
                fee_cancel=NULL, fee_source=NULL, fee_updated_at=NOW()
          WHERE provider='leajlak' AND fee_source='invoice'
            AND id IN (SELECT shipment_id FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 AND shipment_id IS NOT NULL
                          AND source IS DISTINCT FROM '${DASH_SOURCE}')`, [period]);
      await client.query(`DELETE FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 AND source IS DISTINCT FROM '${DASH_SOURCE}'`, [period]);
      const agg = new Map();
      for (const l of lines) {
        if (l.shipmentId != null) {
          const a = agg.get(l.shipmentId) || { total: 0, vat: 0, km: null, extra: null, cancel: null, theirNo: null };
          a.total += Number(l.total) || 0; a.vat += Number(l.vat) || 0;
          if (l.distanceKm != null) a.km = l.distanceKm;
          if (l.extraKmCharge != null) a.extra = (a.extra || 0) + l.extraKmCharge;
          if (l.cancelFee != null) a.cancel = (a.cancel || 0) + l.cancelFee;
          if (l.theirNo) a.theirNo = l.theirNo;
          agg.set(l.shipmentId, a);
        }
        await client.query(
          `INSERT INTO dl_invoice_lines(provider, period, ref, shipment_id, total, ex_vat, vat, distance_km,
                                        extra_km_charge, cancel_fee, status, line_date, raw, source, their_no, extra_km, match_by)
           VALUES ('leajlak',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [period, l.ref || null, l.shipmentId, l.total, l.exVat, l.vat, l.distanceKm, l.extraKmCharge ?? null, l.cancelFee ?? null,
           l.status, l.date, jb(l.raw || {}), (String(source || "invoice") === DASH_SOURCE ? "invoice" : String(source || "invoice")).slice(0, 30),
           l.theirNo || null, l.extraKm ?? null, l.matchBy]);
      }
      for (const [sid, a] of agg) {
        await client.query(
          `UPDATE dl_shipments SET fee_actual=$2, fee_vat=$3, fee_distance_km=$4, fee_extra_km_charge=$5,
                  fee_cancel=$6, fee_source='invoice', fee_updated_at=NOW(),
                  provider_order_no=COALESCE($7, provider_order_no) WHERE id=$1`,
          [sid, r2(a.total), r2(a.vat), a.km, a.extra, a.cancel, a.theirNo]);
      }
      await client.query(
        `INSERT INTO dl_invoices(provider, period, format, file_name, summary, checks, imported_at)
         VALUES ('leajlak',$1,$2,$3,$4,$5,NOW())
         ON CONFLICT (provider, period) DO UPDATE SET format=EXCLUDED.format, file_name=EXCLUDED.file_name,
           summary=EXCLUDED.summary, checks=EXCLUDED.checks, imported_at=NOW()`,
        [period, parsed.format, fileName ? String(fileName).slice(0, 200) : null, jb(parsed.summary), jb(parsed.checks)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return { ok: false, error: `فشل الحفظ: ${e.message}` };
    }
    client.release();
    const matched = lines.filter((l) => l.shipmentId != null).length;
    return { ok: true, month: period, detectedMonth: detected, format: parsed.format, lines: lines.length, matched,
             unmatched: lines.length - matched, byMethod: lines.reduce((a, l) => { if (l.matchBy) a[l.matchBy] = (a[l.matchBy] || 0) + 1; return a; }, {}),
             summary: parsed.summary, checks: parsed.checks };
  }

  /* تصدير لوحتهم: سعر كل طلب بعد التوصيل. الملف ممكن يغطي كذا شهر → كل
     شهر لوحده، وإعادة الاستيراد بتستبدل سطور اللوحة بس (الفاتورة مابتتلمسش).
     الرد فيه المطابقة على العقد: أي طلب سعره بعيد عن المتوقَّع على مسافتنا. */
  async function importDashboard(parsed, fileName, cfg) {
    const lines = parsed.lines.filter((l) => l.ref || l.theirNo);
    if (!lines.length) return { ok: false, error: "مالقيناش طلبات في تصدير لوحة لاجلك", header: parsed.header || null };
    const refs = [...new Set(lines.flatMap((l) => [l.ref, l.theirNo]).filter(Boolean))];
    const sh = (await pool.query(
      `SELECT id, shop_order_no, provider_ref, provider_order_no, status, invoice_period
         FROM dl_shipments WHERE provider='leajlak'
          AND (shop_order_no = ANY($1) OR provider_ref = ANY($1) OR provider_order_no = ANY($1))
        ORDER BY (status='cancelled'), id DESC`, [refs])).rows;
    const idx = new Map();
    for (const x of sh) for (const k of [x.shop_order_no, x.provider_ref, x.provider_order_no]) if (k && !idx.has(k)) idx.set(k, x);
    const byMonth = new Map();
    for (const l of lines) {
      const x = (l.ref && idx.get(l.ref)) || (l.theirNo && idx.get(l.theirNo)) || null;
      l.shipmentId = x ? Number(x.id) : null;
      l.matchBy = x ? (idx.get(l.ref) === x ? "awb" : "their_no") : null;
      // الشهر = شهر الشحنة عندنا (نفس مفتاح الفاتورة)، وإلا تاريخ السطر
      const m = (x && x.invoice_period) || (/^\d{4}-\d{2}/.exec(l.date || "") || [])[0] || riyadhMonth();
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(l);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [m, ls] of byMonth) {
        await client.query(
          `UPDATE dl_shipments SET fee_dash=NULL, fee_dash_ex=NULL, fee_dash_km=NULL, fee_dash_at=NULL
            WHERE provider='leajlak' AND id IN (SELECT shipment_id FROM dl_invoice_lines
                   WHERE provider='leajlak' AND period=$1 AND source=$2 AND shipment_id IS NOT NULL)`, [m, DASH_SOURCE]);
        await client.query("DELETE FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 AND source=$2", [m, DASH_SOURCE]);
        for (const l of ls) {
          await client.query(
            `INSERT INTO dl_invoice_lines(provider, period, ref, shipment_id, total, ex_vat, vat, distance_km,
                                          extra_km_charge, cancel_fee, status, line_date, raw, source, their_no, extra_km, match_by)
             VALUES ('leajlak',$1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15)`,
            [m, l.ref || null, l.shipmentId, l.total, l.exVat, l.vat, l.distanceKm, l.extraKmCharge ?? null,
             l.status, l.date, jb(l.raw || {}), DASH_SOURCE, l.theirNo || null, l.extraKm ?? null, l.matchBy]);
          if (l.shipmentId != null) {
            await client.query(
              `UPDATE dl_shipments SET fee_dash=$2, fee_dash_ex=$3, fee_dash_km=$4, fee_dash_at=NOW(),
                      provider_order_no=COALESCE(provider_order_no, $5) WHERE id=$1`,
              [l.shipmentId, l.total, l.exVat, l.distanceKm, l.theirNo || null]);
          }
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return { ok: false, error: `فشل الحفظ: ${e.message}` };
    }
    client.release();
    await backfill().catch(() => {});
    // المطابقة على العقد لكل شهر اتلمس
    const months = [];
    const mismatches = [];
    for (const m of [...byMonth.keys()].sort()) {
      const rec = await load(m);
      const bad = rec.rows.filter((r) => r.chargedSource === "dashboard"
        && (r.flags.includes("over_expected") || r.flags.includes("under_expected")));
      for (const r of bad) mismatches.push({ month: m, orderNo: r.orderNo, theirNo: r.theirNo, ourKm: r.ourKm, theirKm: r.theirKm,
        charged: r.charged, expected: r.expected?.total, diff: r.diff, flags: r.flags });
      const stray = rec.unmatched.filter((l) => l.flags.includes("dashboard_line_unmatched"));
      for (const l of stray) mismatches.push({ month: m, orderNo: l.ref || null, theirNo: l.theirNo || null, theirKm: l.distanceKm,
        charged: l.total, expected: null, diff: null, flags: l.flags });
      months.push({ month: m, lines: byMonth.get(m).length, matched: byMonth.get(m).filter((l) => l.shipmentId != null).length,
        dashboardTotal: r2(byMonth.get(m).reduce((a, l) => a + (l.total || 0), 0)), expectedTotal: rec.totals.expectedTotal });
    }
    const matched = lines.filter((l) => l.shipmentId != null).length;
    return { ok: true, format: parsed.format, month: [...byMonth.keys()].sort().pop(), months, lines: lines.length, matched,
             unmatched: lines.length - matched, checks: parsed.checks, mismatches };
  }

  app.post("/api/delivery/leajlak/import", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    return c.json(await importSheet(b));
  });

  /* الفاتورة الضريبية (PDF) — أرقامها بتتكتب من اللوحة: رقم الفاتورة، الخاضع
     للضريبة، الضريبة، الإجمالي، تاريخ الاستحقاق. بتتقارن بملخص الملف وبالمتوقَّع. */
  app.post("/api/delivery/leajlak/invoice", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!monthOk(b.month)) return c.json({ ok: false, error: "month لازم YYYY-MM" });
    const ti = {
      no: b.no ? String(b.no).slice(0, 60) : null, taxable: num(b.taxable), vat: num(b.vat), total: num(b.total),
      qty: num(b.qty), date: b.date ? String(b.date).slice(0, 20) : null, due: b.due ? String(b.due).slice(0, 20) : null,
      paid: Boolean(b.paid),
    };
    await pool.query(
      `INSERT INTO dl_invoices(provider, period, tax_invoice) VALUES ('leajlak',$1,$2)
       ON CONFLICT (provider, period) DO UPDATE SET tax_invoice=EXCLUDED.tax_invoice`, [b.month, jb(ti)]);
    return c.json({ ok: true, taxInvoice: ti });
  });


  /* تعديل شحنة واحدة: رسوم يدوي (من لوحتهم)، ملاحظة، علامة «مطابق». */
  app.post("/api/delivery/leajlak/shipment/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ ok: false, error: "id" }, 400);
    const b = await c.req.json().catch(() => ({}));
    const sets = []; const vals = [id];
    const add = (sql, v) => { vals.push(v); sets.push(sql.replace("?", `$${vals.length}`)); };
    if ("fee" in b) {
      const f = num(b.fee);
      add("fee_actual = ?", f);
      add("fee_source = ?", f == null ? null : "manual");
      if (f != null) {
        const cfg = ljContract((await getSettingsData())?.delivery || {});
        add("fee_vat = ?", r2(f - f / (1 + cfg.vatPct / 100)));
      } else add("fee_vat = ?", null);
      sets.push("fee_updated_at = NOW()");
    }
    if ("distanceKm" in b) add("fee_distance_km = ?", num(b.distanceKm));
    if ("cancelFee" in b) add("fee_cancel = ?", num(b.cancelFee));
    if ("note" in b) add("fee_note = ?", b.note ? String(b.note).slice(0, 300) : null);
    if ("ok" in b) { add("recon_ok = ?", Boolean(b.ok)); sets.push(b.ok ? "recon_ok_at = NOW()" : "recon_ok_at = NULL"); }
    if (!sets.length) return c.json({ ok: false, error: "مفيش تعديل" });
    const r = await pool.query(`UPDATE dl_shipments SET ${sets.join(", ")} WHERE id=$1 AND provider='leajlak'`, vals);
    return c.json({ ok: r.rowCount === 1 });
  });

  /* فحص الـAPI: بيسأل لاجلك عن آخر شحنات ويسجّل المفاتيح اللي في الرد، ولو
     ظهر أي حقل رسوم بيتحفظ (fee_source='api') من غير ما يدوس على فاتورة. */
  app.post("/api/delivery/leajlak/probe", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const p = providers().leajlak;
    if (!p || !p.configured()) return c.json({ ok: false, error: "لاجلك مش متظبطة" });
    const limit = Math.min(50, Number(c.req.query("limit")) || 10);
    const rows = (await pool.query(
      `SELECT id, shop_order_no, provider_ref FROM dl_shipments
        WHERE provider='leajlak' AND provider_ref IS NOT NULL ORDER BY id DESC LIMIT $1`, [limit])).rows;
    const out = [];
    for (const r of rows) {
      try {
        const d = await p.call(`/orders/${encodeURIComponent(r.provider_ref)}`);
        const f = feeFromApi(d);
        await pool.query(
          `UPDATE dl_shipments SET provider_fields=$2,
                  fee_actual = CASE WHEN $3::numeric IS NOT NULL AND (fee_source IS NULL OR fee_source='api') THEN $3 ELSE fee_actual END,
                  fee_distance_km = COALESCE(fee_distance_km, $4),
                  fee_source = CASE WHEN $3::numeric IS NOT NULL AND fee_source IS NULL THEN 'api' ELSE fee_source END
            WHERE id=$1`, [r.id, f.keys, f.fee, f.distanceKm]);
        out.push({ orderNo: r.shop_order_no, keys: f.keys, fee: f.fee, distanceKm: f.distanceKm });
      } catch (e) {
        out.push({ orderNo: r.shop_order_no, error: String(e.message || e).slice(0, 120) });
      }
    }
    return c.json({ ok: true, feeFound: out.some((o) => o.fee != null), results: out });
  });

  return { backfill, load, importSheet };
}
