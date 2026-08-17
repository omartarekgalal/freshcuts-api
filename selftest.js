/* ═══════════════════════════════════════════════════════════════════════════
   SELFTEST — «هل الطلب أونلاين شغال من أوله لآخره؟»

   طلب عمر (2026-08-17): «نتأكد دلوقتي من الفلو كامل — الطلب والدفع وتاب
   سينس ورد الـPOS ورد شركة الشحن وكل حاجة».

   السلسلة فيها ٦ حلقات، وكل واحدة فيهم لو وقعت الطلب بيقف في مكان مختلف:

     ١) المنيو والحساب  → لو وقعت، العميل مش هيقدر يضيف حاجة أصلاً
     ٢) بوابة الدفع     → لو وقعت، العميل مش هيقدر يدفع
     ٣) الطلبات الخارجية → لو وقعت، **العميل دفع والمطعم مش عارف** ← الأخطر
     ٤) رد الكاشير      → لو وقفت، الطلب معلّق بلا قبول ولا رفض
     ٥) شركة الشحن      → لو وقعت، الأكل جاهز ومحدش هياخده
     ٦) إبلاغ العميل    → لو وقعت، العميل قاعد قدام شاشة مش بتتحرك

   الفحص ده بيجرّب كل حلقة **من غير ما يصرف قرش** ولا يعمل طلب حقيقي:
   بيحسب سلة وهمية على تاب سينس، بيسأل ماي فاتورة عن وسائل الدفع المتاحة،
   بيسأل Flying Arrow عن مدنه، ويقرا الإعدادات ويقول الناقص بالاسم.

   كل بند بيرجع: ok (تمام) / warn (شغال بس ناقصه حاجة) / fail (واقف).
═══════════════════════════════════════════════════════════════════════════ */

import * as tsstore from "./tsstore.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* نتيجة بند واحد — الرسالة بالعربي لأن اللي بيقراها عمر مش مبرمج */
const ok = (label, detail, extra) => ({ status: "ok", label, detail, ...extra });
const warn = (label, detail, fix, extra) => ({ status: "warn", label, detail, fix, ...extra });
const fail = (label, detail, fix, extra) => ({ status: "fail", label, detail, fix, ...extra });

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const delivery = deps.delivery || (() => null);

  /* ١) المنيو + حساب السلة على تاب سينس (المصدر الوحيد للأسعار) */
  async function checkMenu() {
    try {
      const menu = await tsstore.fetchMenu("1");
      const pages = menu?.pages || menu?.data?.pages || [];
      let item = null;
      for (const p of pages) for (const it of (p.items || [])) {
        if (!item && Number(it.retail_price ?? it.price) > 0) item = it;
      }
      if (!item) return warn("المنيو", "القائمة رجعت من غير أصناف بأسعار", "راجع المنيو على تاب سينس");
      // بنجيب الصنف بتفاصيله عشان ناخد `price` (السعر قبل الضريبة) — دي
      // الخانة اللي تاب سينس بيتحقق منها، مش retail_price المعروض للعميل.
      // ونفس المصدر اللي الشيك أوت الحقيقي بيقرا منه، عشان الفحص يجرّب
      // المسار الفعلي مش مسار تاني شبهه.
      const prod = await tsstore.findProduct(item.id, "1");
      const pre = Number(prod?.price ?? item.price);
      if (!(pre > 0)) return warn("المنيو", "الصنف رجع من غير سعر قبل الضريبة", "راجع المنيو على تاب سينس");
      // سلة وهمية: بنحسبها بس، مفيش أي طلب بيتعمل
      const calc = await tsstore.calculateOrder({
        branchId: "1", orderOptionId: 3,
        purchases: [{
          product_id: item.id, quantity: 1,
          tax_id: prod?.tax_id ?? 1,
          unit_amount: Math.round(pre * tsstore.MULTIPLY),
        }],
      });
      // calculateOrder بترجع `data` مفكوكة وبترمي استثناء لو فاضية —
      // فالقراءة من calc.totals مباشرة، مش calc.data.totals
      const total = calc?.totals?.total_amount;
      if (total == null) return fail("حساب السلة", "تاب سينس ما رجّعش إجمالي", "جرّب تاني، ولو فضلت كلّم دعم تاب سينس", { raw: calc });
      return ok("المنيو وحساب السلة", `شغال — جرّبنا «${item.name || item.local_name}» والإجمالي رجع صح`);
    } catch (e) {
      return fail("المنيو وحساب السلة", e.message, "من غير ده العميل مش هيقدر يطلب أصلاً");
    }
  }

  /* ٢) بوابة الدفع — بنسأل عن الوسائل المفعّلة، ومفيش فاتورة بتتعمل */
  async function checkPay() {
    if (!env("MYFATOORAH_API_KEY")) {
      return fail("بوابة الدفع", "مفتاح ماي فاتورة مش متسجّل", "ضيف MYFATOORAH_API_KEY في إعدادات السيرفر");
    }
    try {
      const base = env("MYFATOORAH_BASE", "https://api.myfatoorah.com");
      const r = await fetch(`${base}/v2/InitiatePayment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env("MYFATOORAH_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ InvoiceAmount: 100, CurrencyIso: "SAR" }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(() => ({}));
      const methods = d?.Data?.PaymentMethods || [];
      if (!methods.length) {
        return fail("بوابة الدفع", d?.Message || "مفيش وسائل دفع مفعّلة", "كلّم ماي فاتورة يفعّلوا الوسائل على حسابك");
      }
      const names = methods.map((m) => m.PaymentMethodAr || m.PaymentMethodEn);
      const hasApple = methods.some((m) => /apple/i.test(m.PaymentMethodCode || m.PaymentMethodEn || ""));
      return ok("بوابة الدفع", `${methods.length} وسيلة مفعّلة: ${names.slice(0, 6).join("، ")}`,
        { applePay: hasApple, live: !/test|demo/i.test(base) });
    } catch (e) {
      return fail("بوابة الدفع", e.message, "الاتصال بماي فاتورة مش شغال");
    }
  }

  /* ٣) الطلبات الخارجية — أخطر حلقة: هنا العميل بيبقى دفع فعلاً */
  async function checkPos() {
    const s = (await getSettingsData()).shop || {};
    const issues = [];
    if (!s.posPaymentMethod) {
      issues.push("طريقة الدفع اللي هتتسجل في الـPOS مش متحددة (settings.shop.posPaymentMethod)");
    }
    // آخر ٧ أيام: كام طلب مدفوع وقف قبل ما يوصل المطعم؟
    const stuck = (await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders
        WHERE status='paid_pos_failed' AND created_at > NOW() - INTERVAL '7 days'`)).rows[0].n;
    const done = (await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders
        WHERE pos_order_id IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'`)).rows[0].n;
    if (stuck) {
      return fail("الطلبات الخارجية", `${stuck} طلب مدفوع ما وصلش المطعم في آخر ٧ أيام`,
        "افتح تبويب الطلبات واضغط «إعادة الإرسال» على كل طلب أحمر", { stuck, done });
    }
    if (issues.length) return warn("الطلبات الخارجية", issues.join(" · "), "من تبويب الإعدادات", { done });
    return ok("الطلبات الخارجية", done ? `${done} طلب وصل المطعم في آخر ٧ أيام` : "الإعدادات مظبوطة — لسه مفيش طلبات نقيس عليها", { done });
  }

  /* ٤) رد الكاشير — الحارس بيتابع القبول والرفض */
  async function checkCashier() {
    const waiting = (await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders
        WHERE status='pos_created' AND created_at < NOW() - INTERVAL '20 minutes'
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows[0].n;
    if (waiting) {
      return warn("رد الكاشير", `${waiting} طلب عدى عليه أكتر من ٢٠ دقيقة من غير قبول ولا رفض`,
        "الكاشير لازم يقبل أو يرفض من شاشة الطلبات الخارجية");
    }
    return ok("رد الكاشير", "مفيش طلبات متعلّقة");
  }

  /* ٥) شركة الشحن */
  async function checkCourier() {
    const api = delivery();
    if (!api) return warn("شركة الشحن", "وحدة التوصيل مش محمّلة", "—");
    if (!api.isLive()) {
      return fail("شركة الشحن", "مفتاح Flying Arrow مش متسجّل",
        "ضيف FLYINGARROW_API_KEY في إعدادات السيرفر");
    }
    const s = (await getSettingsData()).delivery || {};
    try {
      const byId = await api.faVehicles();
      const vid = String(s.faVehicleId || 3);
      const veh = byId[vid];
      const notes = [];
      if (!veh) notes.push(`نوع الخدمة رقم ${vid} مش موجود عندهم`);
      if (!s.faCityId) notes.push("المدينة مش متحددة — هيستخدم جدة (٢٠) افتراضياً");
      if ((s.faPaymentMethod || "wallet") === "cash") notes.push("الدفع للمندوب «نقدي» — الفرع هيدفع كاش كل طلب");
      if (!s.pickupContactPhone) notes.push("تليفون الفرع مش متسجّل — الكابتن مش هيعرف يتصل");
      const svc = veh ? (veh.service?.name_ar || veh.service?.name_en) : "?";
      if (veh && !/مبرد|ساخن|Refrigerated|Hot/i.test(svc)) {
        notes.push(`الخدمة المختارة «${svc}» — في خدمة «التوصيل المبرد والساخن» أنسب للأكل بنفس السعر`);
      }
      if (notes.length) return warn("شركة الشحن", `الاتصال شغال · ${notes.join(" · ")}`, "من تبويب Flying Arrow");
      return ok("شركة الشحن", `الاتصال شغال — الخدمة: ${svc}`);
    } catch (e) {
      return fail("شركة الشحن", e.message, "المفتاح مرفوض أو الخدمة عندهم واقفة");
    }
  }

  /* ٦) إبلاغ العميل */
  async function checkNotify() {
    const s = await getSettingsData();
    const n = s.notifications || {};
    const bits = [], missing = [];
    const subs = (await pool.query(
      "SELECT count(*)::int AS n FROM push_subs WHERE NOT disabled")).rows[0].n;
    if ((s.webPushKeys || {}).publicKey) bits.push(`إشعارات المتصفح مفعّلة (${subs} مشترك)`);
    else missing.push("مفاتيح إشعارات المتصفح مش متولّدة");
    if (env("TAQNYAT_API_KEY") && env("TAQNYAT_SENDER")) bits.push("الرسائل النصية جاهزة");
    else missing.push("تقنيات (SMS) مش متسجّلة — ودي بتوقف تسجيل الدخول كمان");
    if (n.whatsappEnabled) bits.push("واتساب مفعّل");
    if (missing.length) return warn("إبلاغ العميل", [...bits, ...missing].join(" · "), "من تبويب الإعدادات");
    return ok("إبلاغ العميل", bits.join(" · "));
  }

  /* ٧) الإعدادات اللي بتوقف البيع لو غلط */
  async function checkShopConfig() {
    const s = await getSettingsData();
    const shop = s.shop || {}, notes = [];
    /* وضع تجربة الرمز: خطر حقيقي لو الرسائل شغالة (الرمز بيتعرض على الشاشة
       لأي حد)، لكن قبل ما تقنيات تتفعّل هو **الطريقة الوحيدة** اللي بيها حد
       يقدر يسجّل دخول أصلاً. فالتقييم بيتغير على حسب حالة الرسائل بدل ما
       نقول «اقفله» ونحن عارفين إن قفله بيكسر الدخول. */
    const smsLive = Boolean(env("TAQNYAT_API_KEY") && env("TAQNYAT_SENDER"));
    if (shop.otpDevMode === true && smsLive) {
      notes.push("🚨 وضع تجربة رمز الدخول شغال والرسائل شغالة — الرمز بيظهر على الشاشة لأي حد");
    } else if (shop.otpDevMode === true) {
      notes.push("وضع تجربة رمز الدخول شغال (مقبول مؤقتاً — هو الطريقة الوحيدة للدخول لحد ما تقنيات تتفعّل، ولازم يتقفل نفس يوم التفعيل)");
    }
    if (!s.hours || s.hours.enabled === false) notes.push("مواعيد العمل مش مفعّلة — المتجر هيقبل طلبات في أي وقت");
    const pol = (await pool.query("SELECT count(*)::int AS n FROM dl_policies WHERE active")).rows[0].n;
    if (!pol) notes.push("مفيش سياسة تسعير توصيل مفعّلة");
    if (shop.allowCash === true) notes.push("الدفع عند الاستلام مفتوح");
    if (notes.some((x) => x.startsWith("🚨"))) return fail("إعدادات المتجر", notes.join(" · "), "اقفل وضع التجربة قبل أول عميل حقيقي");
    if (notes.length) return warn("إعدادات المتجر", notes.join(" · "), "من تبويب الإعدادات");
    return ok("إعدادات المتجر", "مظبوطة");
  }

  app.get("/api/shop/selftest", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const run = async (fn, label) => {
      try { return await fn(); }
      catch (e) { return fail(label, e.message, "خطأ غير متوقع أثناء الفحص"); }
    };
    const checks = await Promise.all([
      run(checkMenu, "المنيو"), run(checkPay, "بوابة الدفع"), run(checkPos, "الطلبات الخارجية"),
      run(checkCashier, "رد الكاشير"), run(checkCourier, "شركة الشحن"),
      run(checkNotify, "إبلاغ العميل"), run(checkShopConfig, "إعدادات المتجر"),
    ]);
    const fails = checks.filter((x) => x.status === "fail").length;
    const warns = checks.filter((x) => x.status === "warn").length;
    return c.json({
      ok: true, at: new Date().toISOString(),
      ready: fails === 0,
      summary: fails ? `${fails} حلقة واقفة` : warns ? `شغال مع ${warns} ملاحظة` : "كل حاجة تمام",
      fails, warns, checks,
    });
  });

  console.log("[selftest] ready");
}
