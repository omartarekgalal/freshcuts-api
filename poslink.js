/* ═══════════════════════════════════════════════════════════════════════════
   🧾 PC1 — ربط عميل نقطة البيع بالطلب لحظياً (عمر ١٧/١٠ ٢٠:١٥)

   «بيظهرلي في طلبات نقطة البيع طلبات بدون عميل وهي على السيستم ليها عميل».

   السبب (اتأكدنا منه في الكود والداتا): قايمة /orders في لوحة تاب سينس
   مافيهاش عمود العميل أصلاً (اتفحصت قبل كده بأعمدة إضافية — مفيش؛ راجع
   tabsense.js فوق fetchOrdersSince)، فالسحب كل ٥ دقايق بيكتب الطلب في
   ts_orders من غير customer_id. العميل بيتربط بس لما نمسح /customers/{id}/orders
   لكل عميل نشط (طلب لكل عميل بفاصل ١٫١ ث عشان حد تاب سينس ٦٠/دقيقة) — وده
   كان بيحصل كل ٣٠ دقيقة ثابتة في الكود. يعني الطلب بيقعد لحد ~٣٥ دقيقة في
   اللوحة «بدون عميل» وهو في تاب سينس معاه عميل من أول ثانية.

   اللي هنا:
     ١) الإيقاع إعدادات في اللوحة (settings.insights — المالك):
        syncEveryMin (سحب الطلبات)، linkEveryMin (المسح الكامل لعملاء آخر
        يومين)، todayPass (مسح رخيص لعملاء النهارده كل دورة)،
        customersEveryMin (تحديث دليل العملاء بتواريخ التسجيل).
     ٢) runLinkPass: مسح النهارده كل دورة + المسح الكامل على إيقاعه، وبيتنادى
        كمان فوراً لما السحب يلاقي طلبات جديدة ⇒ الطلب بياخد عميله في نفس
        الدورة. العميل اللي لسه مش في دليلنا بياخد صف أدنى في ts_customers
        (اسم/جوال من تقرير المبيعات) عشان الـjoin يشتغل من أول لحظة.
     ٣) customerPending: الطلب اللي لسه جوّه نافذة الربط (linkEveryMin +
        syncEveryMin) من غير عميل = «⏳ بيتربط» مش «بدون عميل».

   صافي: مفيش استيراد من index.js — كل حاجة بتتحقن (pool/ts/state) عشان
   الاختبارات تشتغل من غير سيرفر.
═══════════════════════════════════════════════════════════════════════════ */

/* ═══ ⚙️ الإعدادات (settings.insights — من اللوحة) ═══════════════════════ */
export const POSLINK_DEFAULTS = Object.freeze({
  syncEveryMin: 5,        // كان TABSENSE_SYNC_MINUTES في البيئة بس
  linkEveryMin: 5,        // كان THIRTY_MIN ثابتة في الكود
  todayPass: true,        // مسح عملاء النهارده كل دورة (لو المسح الكامل مش مستحق)
  customersEveryMin: 30,  // دليل العملاء (الأسماء + تاريخ التسجيل) — نفس الـ٣٠ القديمة، بس من اللوحة
});
export const POSLINK_GROUPS = Object.freeze({
  sync: "🔄 سحب طلبات نقطة البيع",
  link: "👤 ربط العميل بالطلب",
});
export const POSLINK_SCHEMA = Object.freeze([
  { key: "syncEveryMin", group: "sync", ar: "سحب طلبات نقطة البيع كل", unit: "دقيقة", min: 1, max: 30,
    help: "كل دورة بتسحب طلبات آخر ٣ أيام من تاب سينس وبعدها بتربط العملاء. أقل من ٣ دقايق بيزوّد الضغط على تاب سينس من غير فايدة واضحة." },
  { key: "linkEveryMin", group: "link", ar: "المسح الكامل لعملاء آخر يومين كل", unit: "دقيقة", min: 2, max: 60,
    help: "طلب واحد لتاب سينس لكل عميل نشط (≈ ٤٠–٧٠ عميل في يومين ⇒ دقيقة تقريباً). كان ٣٠ دقيقة ثابتة، وده اللي كان بيخلي الطلب يبان «بدون عميل» نص ساعة." },
  { key: "todayPass", group: "link", type: "bool", ar: "اربط عملاء النهارده كل دورة",
    help: "مسح رخيص (عملاء النهارده بس، ≈ ١٥–٢٥ عميل) كل دورة سحب، وكمان فوراً لما يوصل طلب جديد. اقفله بس لو تاب سينس اشتكى من كتر الطلبات." },
  { key: "customersEveryMin", group: "link", ar: "تحديث دليل العملاء (الأسماء وتاريخ التسجيل) كل", unit: "دقيقة", min: 5, max: 240,
    help: "العميل الجديد بياخد صف مؤقت باسمه وجواله أول ما يتربط بطلب، وتاريخ تسجيله بيتملي من الدليل في التحديث ده." },
].map((x) => Object.freeze({ type: "number", ...x, default: POSLINK_DEFAULTS[x.key] })));

/* أقصى عدد عملاء في المسح الواحد — حماية من حد تاب سينس (٦٠ طلب/دقيقة)، مش إعداد تشغيل */
export const FULL_PASS_CAP = 150;   // زي القديم
export const TODAY_PASS_CAP = 60;   // النهارده ≈ ١٥–٢٥؛ ٦٠ = أسوأ يوم ⇒ ~٦٦ ث

const clampN = (v, lo, hi, d) => { const n = Number(v); return v === null || v === "" || v === undefined || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, Math.round(n))); };
const asBool = (v, d) => (v === true || v === false ? v : v === 1 || v === "1" || v === "true" ? true : v === 0 || v === "0" || v === "false" ? false : d);

/* الإعدادات الفعلية: الداتابيز ⇒ ولو مش موجودة الـfallback (مثلاً إيقاع البيئة) ⇒ الافتراضي. الأرقام متقصقصة على الحدود. */
export function poslinkCfg(settings, fallback = {}) {
  const raw = (settings || {}).insights;
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const c = {};
  for (const x of POSLINK_SCHEMA) {
    const d = fallback[x.key] !== undefined ? fallback[x.key] : POSLINK_DEFAULTS[x.key];
    c[x.key] = x.type === "bool" ? asBool(src[x.key], asBool(d, POSLINK_DEFAULTS[x.key])) : clampN(src[x.key], x.min, x.max, clampN(d, x.min, x.max, POSLINK_DEFAULTS[x.key]));
  }
  return c;
}

/* حفظ من اللوحة: مفاتيح معروفة بس، أرقام جوّه الحدود (من غير تقريب في صمت) ⇒ {ok, cfg} أو {ok:false, errors:[[key, msg]]} */
export function cleanPoslinkSettings(body, prevSettings, fallback = {}) {
  const errors = [];
  const next = { ...poslinkCfg(prevSettings, fallback) };
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const [k, v] of Object.entries(b)) {
    const x = POSLINK_SCHEMA.find((s) => s.key === k);
    if (!x) { errors.push([k, `إعداد مش معروف: ${k}`]); continue; }
    if (x.type === "bool") { const bv = asBool(v, null); if (bv === null) errors.push([k, `«${x.ar}»: شغّال أو مقفول`]); else next[k] = bv; continue; }
    const n = Number(v);
    if (v === "" || v === null || v === undefined || !Number.isFinite(n)) { errors.push([k, `«${x.ar}»: اكتب رقم`]); continue; }
    if (n < x.min || n > x.max) { errors.push([k, `«${x.ar}»: المسموح من ${x.min} لـ${x.max}`]); continue; }
    next[k] = Math.round(n);
  }
  return errors.length ? { ok: false, errors } : { ok: true, cfg: next };
}

export const schemaView = (settings, fallback = {}) => { const c = poslinkCfg(settings, fallback); return POSLINK_SCHEMA.map((x) => ({ ...x, value: c[x.key] })); };

/* ═══ ⏱ الإيقاع ═══════════════════════════════════════════════════════════ */
/* مستحق لو عمره ما اتعمل أو عدّى عليه everyMin دقيقة */
export function linkDue(lastAt, everyMin, nowMs = Date.now()) {
  if (!lastAt) return true;
  const t = typeof lastAt === "number" ? lastAt : Date.parse(lastAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= Math.max(1, Number(everyMin) || 0) * 60_000;
}

/* نافذة «لسه بيتربط»: دورة سحب + دورة ربط كاملة — بعدها «بدون عميل» بجد */
export const pendingWindowMin = (cfg) => (Number(cfg?.linkEveryMin) || POSLINK_DEFAULTS.linkEveryMin) + (Number(cfg?.syncEveryMin) || POSLINK_DEFAULTS.syncEveryMin);

/* الطلب من غير عميل ولسه جوّه النافذة ⇒ true (اللوحة تكتب «⏳ بيتربط»). orderDate: Date أو نص ISO. */
export function customerPending(orderDate, hasCustomer, cfg, nowMs = Date.now()) {
  if (hasCustomer) return false;
  const t = orderDate instanceof Date ? orderDate.getTime() : Date.parse(orderDate);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < pendingWindowMin(cfg) * 60_000;
}

/* نطاق مسح «النهارده» لتقرير sales-by-customer: اليوم بتوقيت الرياض، وقبل ٦ الصبح
   بنضيف إمبارح كمان — الوردية بتقفل ~٤ الفجر وتاب سينس بيحسب الطلب على يوم
   الوردية (calendar_day)، فطلب ١ الفجر ممكن يبقى على تاريخ إمبارح عنده وعلى
   تاريخ النهارده عندنا (UTC). يومين قبل ٦ الصبح أرخص من طلب بيفضل «بدون عميل». */
const RIYADH_MS = 3 * 3600_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export function todayPassRange(nowMs = Date.now()) {
  const ry = nowMs + RIYADH_MS;
  const to = isoDay(ry);
  const hour = new Date(ry).getUTCHours();
  const from = hour < 6 ? isoDay(ry - 86_400_000) : to;
  return { from, to };
}

/* ═══ 🗂 كتابة الطلبات في ts_orders ═══════════════════════════════════════ */
/* قايمة /orders مافيهاش عميل ⇒ الـupsert ماعندوش عمود customer_id خالص، وبالتالي
   عمره ما يمسح ربط موجود (الـSET مابيلمسوش). الاختبار بيتأكد من كده بالنص. */
export const ORDER_UPSERT_SQL =
  `INSERT INTO ts_orders (order_id, receipt, order_date, calendar_day, order_option, order_type,
                          order_status, gross, discount, promotion, net, tax, gross_incl, discount_incl,
                          total, payments, branch, staff_name, updated_at)
   VALUES ($1,$2,$3::timestamptz,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,NOW())
   ON CONFLICT (order_id) DO UPDATE SET
     receipt=EXCLUDED.receipt, order_date=EXCLUDED.order_date, calendar_day=EXCLUDED.calendar_day,
     order_option=EXCLUDED.order_option, order_type=EXCLUDED.order_type, order_status=EXCLUDED.order_status,
     gross=EXCLUDED.gross, discount=EXCLUDED.discount, promotion=EXCLUDED.promotion,
     net=EXCLUDED.net, tax=EXCLUDED.tax, gross_incl=EXCLUDED.gross_incl, discount_incl=EXCLUDED.discount_incl,
     total=EXCLUDED.total, payments=EXCLUDED.payments, branch=EXCLUDED.branch,
     staff_name=COALESCE(NULLIF(EXCLUDED.staff_name,''), ts_orders.staff_name), updated_at=NOW()
   RETURNING order_id, (xmax = 0) AS inserted`;

/* باراميترات الـupsert من صف tabsense.mapOrderRow. الأرقام شاملة الضريبة بتتحسب من
   نسبة ضريبة الطلب نفسه (مش ١٥٪ ثابتة): gross×(1+rate) = السعر قبل الخصم اللي
   العميل شافه، والفرق عن total = الخصم اللي خده. */
export function orderUpsertParams(o, jb = JSON.stringify) {
  const rate = o.net > 0 ? o.tax / o.net : 0.15;
  const grossIncl = Math.round(o.gross * (1 + rate) * 1000) / 1000;
  const discountIncl = Math.max(0, Math.round((grossIncl - o.total) * 1000) / 1000);
  return [o.orderId, o.receipt, o.orderDate, o.calendarDay, o.orderOption, o.orderType,
    o.orderStatus, o.gross, o.discount, o.promotion, o.net, o.tax, grossIncl, discountIncl,
    o.total, jb(o.payments), o.branch, o.staffName || ""];
}

/* ═══ 👤 صف أدنى للعميل اللي لسه مش في الدليل ═══════════════════════════ */
/* تقرير sales-by-customer بيرجّع id + اسم + جوال + نقاط. لو العميل اتسجّل النهارده
   دليلنا (ts_customers) مايعرفوش لحد تحديث الدليل، فالـjoin بيطلع الطلب من غير
   اسم ⇒ اللوحة تكتب «بدون عميل» رغم إن customer_id اتربط. الصف الأدنى بيحل ده؛
   الدليل هو المرجع: مابنكتبش فوق اسم/جوال موجودين، وregistered_at بيفضل NULL لحد الدليل. */
export async function ensureCustomerRows(pool, customers, normPhone = (s) => String(s || "")) {
  const rows = (customers || []).filter((c) => c && c.id != null);
  if (!rows.length) return 0;
  const ids = rows.map((c) => String(c.id));
  const names = rows.map((c) => { const n = String(c.name || "").trim(); return n === "(بدون اسم)" ? "" : n; });
  const phones = rows.map((c) => String(c.phone || "").trim());
  const norms = phones.map((p) => (p ? String(normPhone(p) || "") : ""));
  const points = rows.map((c) => Number(c.points) || 0);
  const r = await pool.query(
    `INSERT INTO ts_customers (customer_id, name, phone, phone_norm, points, updated_at)
     SELECT c.id, c.name, c.phone, c.phone_norm, c.points, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) AS c(id, name, phone, phone_norm, points)
     ON CONFLICT (customer_id) DO UPDATE SET
       name = COALESCE(NULLIF(ts_customers.name,''), EXCLUDED.name),
       phone = COALESCE(NULLIF(ts_customers.phone,''), EXCLUDED.phone),
       phone_norm = COALESCE(NULLIF(ts_customers.phone_norm,''), EXCLUDED.phone_norm)`,
    [ids, names, phones, norms, points]
  );
  return r?.rowCount || 0;
}

/* ═══ 🔗 مسح الربط ════════════════════════════════════════════════════════ */
/* قرار واحد لكل نداء: المسح الكامل (آخر يومين، ≤١٥٠ عميل) لو مستحق على linkEveryMin،
   وإلا مسح النهارده (≤٦٠) لو todayPass شغّال. دليل العملاء بيتحدّث على إيقاعه
   الخاص (customersEveryMin) قبل الربط. بيكتب في insightsState:
     lastLinkAt / lastLinkCount / lastLinked        — المسح الكامل
     lastTodayLinkAt / lastTodayLinkCount / lastTodayLinked — أي مسح (النهارده أو الكامل)
     lastLinkMode ("full" | "today") / lastLinkReason ("cycle" | "new_orders" | …)
   بيرجع { ran, mode, customers, linked, from, to, reason }. */
export async function runLinkPass(deps, { reason = "cycle", force = null } = {}) {
  const { pool, ts, insightsState, cfg, linkCustomersOrders, syncCustomersCache, daysAgoISO, todayISO, normPhone, now = Date.now, log = console } = deps;
  const t0 = now();
  const full = force === "full" || (force !== "today" && linkDue(insightsState.lastLinkAt, cfg.linkEveryMin, t0));
  if (!full && !cfg.todayPass) return { ran: false, reason, mode: null };

  // دليل العملاء (أسماء + تاريخ التسجيل) — على إيقاعه، وفشله مايوقّفش الربط
  if (syncCustomersCache && linkDue(insightsState.lastCustomersSyncAt, cfg.customersEveryMin, t0)) {
    try { await syncCustomersCache(); insightsState.lastCustomersSyncAt = new Date(now()).toISOString(); }
    catch (e) { log.error("[insights] customers directory sync failed:", e.message); }
  }

  let from, to, cap;
  if (full) { from = daysAgoISO(2); to = todayISO(); cap = FULL_PASS_CAP; }
  else { ({ from, to } = todayPassRange(t0)); cap = TODAY_PASS_CAP; }
  const actives = (await ts.fetchCustomerSales(from, to)).filter((c) => c && c.id != null);
  const picked = actives.slice(0, cap);
  try { await ensureCustomerRows(pool, picked, normPhone); }
  catch (e) { log.error("[insights] ensure customer rows failed:", e.message); }   // الربط نفسه أهم من الاسم
  const linked = picked.length ? await linkCustomersOrders(picked.map((c) => String(c.id))) : 0;

  const at = new Date(now()).toISOString();
  insightsState.lastTodayLinkAt = at;
  insightsState.lastTodayLinkCount = picked.length;
  insightsState.lastTodayLinked = linked;
  insightsState.lastLinkMode = full ? "full" : "today";
  insightsState.lastLinkReason = reason;
  if (full) { insightsState.lastLinkAt = at; insightsState.lastLinkCount = actives.length; insightsState.lastLinked = linked; }
  return { ran: true, mode: full ? "full" : "today", customers: picked.length, linked, from, to, reason };
}
