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

/* العقد (On Demand Contract — Standard، ٢٤/٨): ١٧ ر.س قبل الضريبة لأي طلب
   لحد ١٠ كم، وبعدها ٢ ر.س/كم قبل الضريبة (مادة ١٢). عمر قال مرة ٢٫٥ —
   فالقيم كلها قابلة للتعديل من اللوحة (settings.delivery.leajlakContract).
   kmRounding: «ceil» = كل جزء من كيلو بيتحسب كيلو (الأحوط — مابيطلّعش شذوذ
   وهمي)، «exact» = بالكسور. */
export const DEFAULT_LJ_CONTRACT = Object.freeze({
  flatExVat: 17,
  includedKm: 10,
  perKmExVat: 2,
  vatPct: 15,
  kmRounding: "ceil",
  cancelFeeExVat: 0,          // مش مذكورة في العقد — الإلغاء قبل الاستلام مجاني لحد ما يثبت العكس
  tolerance: 0.1,             // فرق هللات مايتعدّش شذوذ
  distanceGapKm: 2,           // فرق مسافتهم عن مسافتنا اللي يستاهل ننبّه عليه
});

export function ljContract(settings) {
  const c = { ...DEFAULT_LJ_CONTRACT, ...((settings && settings.leajlakContract) || {}) };
  for (const k of ["flatExVat", "includedKm", "perKmExVat", "vatPct", "cancelFeeExVat", "tolerance", "distanceGapKm"]) {
    const n = num(c[k]);
    c[k] = n == null ? DEFAULT_LJ_CONTRACT[k] : n;
  }
  c.kmRounding = c.kmRounding === "exact" ? "exact" : "ceil";
  return c;
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
export function reconcile({ shipments = [], orphanOrders = [], lines = [], contract } = {}) {
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

  const rows = shipments.map((s) => {
    const picked = Boolean(s.pickedAt) || s.status === "delivered";
    const exp = expectedLeajlakFee({ km: s.ourKm, status: s.status, picked }, c);
    const ls = lineOf.get(s.id) || [];
    const invoiced = ls.length ? r2(ls.reduce((a, l) => a + (Number(l.total) || 0) + (Number(l.cancelFee) || 0), 0)) : null;
    // المفوتَر: الفاتورة أولاً، بعدها المسجّل يدوي/من الـAPI على الشحنة
    const charged = invoiced != null ? invoiced : (s.feeActual != null ? r2(s.feeActual) : null);
    const chargedSource = invoiced != null ? "invoice" : (s.feeActual != null ? (s.feeSource || "manual") : null);
    const theirKm = ls.find((l) => l.distanceKm != null)?.distanceKm ?? s.feeDistanceKm ?? null;
    const cost = charged != null ? charged : exp.total;
    const flags = [];
    if (charged != null && charged > exp.total + tol) flags.push("over_expected");
    if (charged != null && charged < exp.total - tol) flags.push("under_expected");
    if (s.status === "cancelled" && charged != null && charged > tol) flags.push("charged_cancelled");
    if (ls.length > 1 || ls.some((l) => (lineCount.get(l.ref) || 0) > 1)) flags.push("duplicate_invoice_line");
    if ((byOrder.get(s.orderNo) || 0) > 1 && s.status !== "cancelled") flags.push("duplicate_shipment");
    if (theirKm != null && s.ourKm != null && Math.abs(Number(theirKm) - Number(s.ourKm)) > c.distanceGapKm) flags.push("distance_gap");
    if (s.ourKm == null) flags.push("no_distance");
    if (ls.some((l) => l.status && CANCEL_RX.test(l.status)) && s.status !== "cancelled") flags.push("status_mismatch");
    if (s.status !== "cancelled" && s.status !== "delivered") flags.push("in_flight");
    const customerFee = r2(s.customerFee);
    return {
      id: s.id, orderNo: s.orderNo, providerRef: s.providerRef, at: s.createdAt, period: s.period,
      status: s.status, orderStatus: s.orderStatus || null, isTest: Boolean(s.isTest),
      ourKm: s.ourKm != null ? r2(s.ourKm) : null, distanceSource: s.distanceSource || null,
      theirKm: theirKm != null ? r2(theirKm) : null,
      expected: exp, charged, chargedSource, invoiceLines: ls.length,
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
    + totals.strayTotal);
  totals.disputeCandidate = dispute;
  const anomalies = {};
  for (const r of rows) for (const f of r.flags) anomalies[f] = (anomalies[f] || 0) + 1;
  for (const l of unmatched) for (const f of l.flags) anomalies[f] = (anomalies[f] || 0) + 1;
  return { contract: c, totals, anomalies, rows, unmatched };
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
};

const STATUS_AR = { delivered: "تم التوصيل", cancelled: "ملغية", pending: "جديد", assigned: "مع كابتن", picked: "في الطريق" };

/* CSV بترتيب الفاتورة (بالتاريخ) + BOM عشان إكسل يقرا العربي. */
export function toCsv(rec, { month } = {}) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["#", "مرجع لاجلك (dsp_order_id)", "رقم طلبنا", "التاريخ (الرياض)", "الحالة", "تجريبي",
    "مسافتنا كم", "مسافتهم كم", "كم إضافي", "المتوقع قبل الضريبة", "ضريبة المتوقع", "المتوقع شامل",
    "المفوتر شامل", "مصدر المفوتر", "الفرق", "رسوم العميل", "الهامش", "ملاحظات", "✓ مطابق"];
  const fmtDate = (d) => {
    if (!d) return "";
    try {
      return new Date(d).toLocaleString("sv-SE", { timeZone: "Asia/Riyadh" }).slice(0, 16);
    } catch { return String(d); }
  };
  const lines = [head.map(esc).join(",")];
  let i = 0;
  for (const r of rec.rows) {
    i += 1;
    lines.push([i, r.providerRef || "", r.orderNo, fmtDate(r.at), r.status ? (STATUS_AR[r.status] || r.status) : "—",
      r.isTest ? "نعم" : "", r.ourKm ?? "", r.theirKm ?? "", r.expected?.extraKm ?? "",
      r.expected?.exVat ?? "", r.expected?.vat ?? "", r.expected?.total ?? "",
      r.charged ?? "", r.chargedSource || "", r.diff ?? "", r.customerFee, r.margin ?? "",
      r.flags.map((f) => FLAG_AR[f] || f).join(" · "), r.ticked ? "✓" : ""].map(esc).join(","));
  }
  for (const l of rec.unmatched || []) {
    i += 1;
    lines.push([i, l.ref, "", l.date || "", l.status || "", "", "", l.distanceKm ?? "", "", "", "", "",
      l.total ?? "", "invoice", "", "", "", l.flags.map((f) => FLAG_AR[f] || f).join(" · "), ""].map(esc).join(","));
  }
  const t = rec.totals;
  lines.push("");
  lines.push(["", "الإجمالي", month || "", "", `${t.shipments} شحنة`, "", "", "", t.extraKmTotal,
    t.expectedExVat, t.expectedVat, t.expectedTotal, t.charged + t.unmatchedTotal, "", "", t.customerFees, t.margin, "", ""].map(esc).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

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
    `);
  }

  /* backfill: مسافتنا + المتوقَّع + شهر الفاتورة لكل الشحنات (القديمة
     والجديدة). رخيص — بيتنادى في كل قراءة للشاشة وعند الإقلاع. */
  async function backfill() {
    const c = ljContract((await getSettingsData())?.delivery || {});
    const rows = (await pool.query(
      `SELECT sh.id, sh.status, sh.picked_at, sh.created_at,
              NULLIF(s.delivery_quote->>'routeKm','')::numeric AS route_km
         FROM dl_shipments sh LEFT JOIN shop_orders s ON s.order_no = sh.shop_order_no
        WHERE sh.provider = 'leajlak'`)).rows;
    let n = 0;
    for (const r of rows) {
      const km = r.route_km != null ? Number(r.route_km) : null;
      const exp = expectedLeajlakFee({ km, status: r.status, picked: Boolean(r.picked_at) || r.status === "delivered" }, c);
      const u = await pool.query(
        `UPDATE dl_shipments SET our_km = $2, expected_fee = $3,
                invoice_period = COALESCE(invoice_period, to_char(created_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM'))
          WHERE id = $1 AND (our_km IS DISTINCT FROM $2 OR expected_fee IS DISTINCT FROM $3 OR invoice_period IS NULL)`,
        [r.id, km, exp.total]);
      n += u.rowCount;
    }
    return { scanned: rows.length, updated: n };
  }

  ensureSchema()
    .then(() => backfill())
    .then((r) => console.log(`[ljrecon] schema ready, backfill ${r.updated}/${r.scanned}`))
    .catch((e) => console.error("[ljrecon] schema/backfill failed:", e.message));

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
      reconOk: r.recon_ok, feeNote: r.fee_note,
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
          AND NOT EXISTS (SELECT 1 FROM dl_shipments sh WHERE sh.shop_order_no = s.order_no AND sh.provider = 'leajlak')`,
      [month])).rows.map((r) => ({
      orderNo: r.order_no, createdAt: r.created_at, orderStatus: r.status, isTest: r.is_test,
      customerFee: Number(r.delivery_fee) || 0, ourKm: r.route_km != null ? Number(r.route_km) : null,
      distanceSource: r.distance_source, period: month,
    }));
    const lines = (await pool.query(
      `SELECT * FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 ORDER BY id`, [month])).rows.map((l) => ({
      id: Number(l.id), ref: l.ref, shipmentId: l.shipment_id != null ? Number(l.shipment_id) : null,
      total: l.total != null ? Number(l.total) : null, exVat: l.ex_vat != null ? Number(l.ex_vat) : null,
      vat: l.vat != null ? Number(l.vat) : null, distanceKm: l.distance_km != null ? Number(l.distance_km) : null,
      cancelFee: l.cancel_fee != null ? Number(l.cancel_fee) : null, status: l.status, date: l.line_date,
    }));
    return reconcile({ shipments, orphanOrders, lines, contract: c });
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
         FROM dl_invoice_lines WHERE provider='leajlak' GROUP BY 1`)).rows;
    const invBy = Object.fromEntries(inv.map((x) => [x.period, x]));
    return c.json({
      ok: true, current: riyadhMonth(),
      months: r.map((x) => ({
        month: x.month, shipments: x.shipments, delivered: x.delivered, cancelled: x.cancelled,
        expected: r2(x.expected), withFee: x.with_fee, ticked: x.ticked,
        invoiceLines: invBy[x.month]?.n || 0, invoiceTotal: r2(invBy[x.month]?.t || 0),
        invoiceImportedAt: invBy[x.month]?.at || null,
      })),
    });
  });

  app.get("/api/delivery/leajlak/recon", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const month = c.req.query("month") || riyadhMonth();
    if (!monthOk(month)) return c.json({ ok: false, error: "month لازم YYYY-MM" }, 400);
    await backfill().catch(() => {});
    const rec = await load(month);
    return c.json({ ok: true, month, flagLabels: FLAG_AR, ...rec,
      apiFacts: {
        feeInApi: false,
        note: "API الشركاء عند لاجلك مابيرجّعش رسوم ولا مسافة (مجرّب ١٩/٩ على POST/GET/DELETE والويبهوك). المفوتَر بييجي من ملف الفاتورة أو تصدير لوحتهم أو إدخال يدوي.",
      } });
  });

  app.get("/api/delivery/leajlak/recon.csv", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const month = c.req.query("month") || riyadhMonth();
    if (!monthOk(month)) return c.text("bad month", 400);
    await backfill().catch(() => {});
    const csv = toCsv(await load(month), { month });
    return new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leajlak-recon-${month}.csv"`,
    } });
  });

  /* استيراد الفاتورة: اللوحة بتقرا الملف (CSV/XLSX) وبتبعت الصفوف خام.
     استيراد نفس الشهر تاني بيستبدل سطوره — آمن تعيده. */
  app.post("/api/delivery/leajlak/import", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const month = String(b.month || "");
    if (!monthOk(month)) return c.json({ ok: false, error: "month لازم YYYY-MM" });
    const raw = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    if (!raw.length) return c.json({ ok: false, error: "الملف فاضي" });
    const cfg = ljContract((await getSettingsData())?.delivery || {});
    const mapped = raw.map((r) => ({ ...mapInvoiceRow(r, cfg), raw: r }))
      .filter((l) => l.ref || l.total != null);
    const withRef = mapped.filter((l) => l.ref);
    if (!withRef.length) {
      return c.json({ ok: false, error: "مالقيناش عمود رقم الطلب في الملف", sampleColumns: Object.keys(raw[0] || {}) });
    }
    if (!mapped.some((l) => l.total != null)) {
      return c.json({ ok: false, error: "مالقيناش عمود المبلغ/الرسوم في الملف", sampleColumns: Object.keys(raw[0] || {}) });
    }
    // مطابقة المرجع: رقم طلبنا (W…) أو الـUUID بتاعهم — على كل الشهور، مش
    // الشهر ده بس (طلب ١١:٥٩ بالليل ممكن يقع في فاتورة الشهر اللي بعده).
    const refs = [...new Set(withRef.map((l) => l.ref))];
    const sh = (await pool.query(
      `SELECT id, shop_order_no, provider_ref, status FROM dl_shipments
        WHERE provider='leajlak' AND (provider_ref = ANY($1) OR shop_order_no = ANY($1))
        ORDER BY (status='cancelled'), id DESC`, [refs])).rows;
    const idx = new Map();
    for (const s of sh) {
      if (s.provider_ref && !idx.has(s.provider_ref)) idx.set(s.provider_ref, Number(s.id));
      if (!idx.has(s.shop_order_no)) idx.set(s.shop_order_no, Number(s.id));
    }
    const client = await pool.connect();
    let matched = 0;
    try {
      await client.query("BEGIN");
      // سطور الشهر القديمة هتتمسح → الرسوم اللي جت منها على الشحنات ترجع فاضية
      await client.query(
        `UPDATE dl_shipments SET fee_actual=NULL, fee_vat=NULL, fee_distance_km=NULL, fee_extra_km_charge=NULL,
                fee_cancel=NULL, fee_source=NULL, fee_updated_at=NOW()
          WHERE provider='leajlak' AND fee_source='invoice'
            AND id IN (SELECT shipment_id FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1 AND shipment_id IS NOT NULL)`, [month]);
      await client.query("DELETE FROM dl_invoice_lines WHERE provider='leajlak' AND period=$1", [month]);
      const agg = new Map();
      for (const l of mapped) {
        const sid = l.ref ? idx.get(l.ref) ?? null : null;
        if (sid != null) {
          matched += 1;
          const a = agg.get(sid) || { total: 0, vat: 0, km: null, extra: null, cancel: null };
          a.total += Number(l.total) || 0; a.vat += Number(l.vat) || 0;
          if (l.distanceKm != null) a.km = l.distanceKm;
          if (l.extraKmCharge != null) a.extra = (a.extra || 0) + l.extraKmCharge;
          if (l.cancelFee != null) a.cancel = (a.cancel || 0) + l.cancelFee;
          agg.set(sid, a);
        }
        await client.query(
          `INSERT INTO dl_invoice_lines(provider, period, ref, shipment_id, total, ex_vat, vat, distance_km,
                                        extra_km_charge, cancel_fee, status, line_date, raw, source)
           VALUES ('leajlak',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [month, l.ref || null, sid, l.total, l.exVat, l.vat, l.distanceKm, l.extraKmCharge, l.cancelFee,
           l.status, l.date, jb(l.raw), String(b.source || "invoice").slice(0, 30)]);
      }
      for (const [sid, a] of agg) {
        await client.query(
          `UPDATE dl_shipments SET fee_actual=$2, fee_vat=$3, fee_distance_km=$4, fee_extra_km_charge=$5,
                  fee_cancel=$6, fee_source='invoice', fee_updated_at=NOW() WHERE id=$1`,
          [sid, r2(a.total), r2(a.vat), a.km, a.extra, a.cancel]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return c.json({ ok: false, error: `فشل الحفظ: ${e.message}` });
    }
    client.release();
    return c.json({ ok: true, month, lines: mapped.length, matched, unmatched: mapped.length - matched,
                    columns: mapped[0]?.columns || null });
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

  return { backfill, load };
}
