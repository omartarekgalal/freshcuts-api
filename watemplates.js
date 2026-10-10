/* ═══════════════════════════════════════════════════════════════════════════
   كتالوج قوالب واتساب (Cloud API) — فريش كاتس، جدة. (٢٨/٩/٢٠٢٦)

   كل قالب هنا = جسم التقديم لميتا بالظبط (POST /{WABA_ID}/message_templates:
   name · language · category · components مع أمثلة لكل متغيّر) + بياناتنا:
   الغرض، إيش يطلقه، ربط كل متغيّر بحقل عندنا، نص SMS البديل، وهل يترسل
   تلقائياً ولا يدوي.

   هذا الملف **كتالوج بس**: ما يرسل شي، ما يقدّم شي لميتا، وما يلمس قاعدة
   البيانات. الإرسال عند whatsapp.js (فرع wa-cloud)، والتقديم لميتا قرار عمر.

   قواعد ميتا اللي validateTemplate() تفحصها (واختبار watemplates.test.mjs
   يمشي على الكتالوج كله):
     • الاسم snake_case صغير [a-z0-9_] ≤512 · اللغة ar (قوالب الفريق en+ar)
     • الفئة UTILITY | MARKETING | AUTHENTICATION — ميتا تعيد تصنيف أي نص فيه
       ترويج (خصم/كود/«اطلب الحين») لـMARKETING، فالقوالب التشغيلية هنا ما فيها
       أي ترويج، واللي حدّها رمادي معلَّم reclassRisk.
     • الجسم ≤1024 حرف، ما يبدأ ولا ينتهي بمتغيّر، المتغيّرات {{1}}..{{n}}
       بالترتيب، ولا متغيّرين جنب بعض بمسافة بس، ومثال لكل متغيّر.
     • الهيدر نص ≤60 أو صورة (مثالها handle يتجاب وقت الرفع ⇒ needsUpload).
     • الفوتر ≤60 ومن غير متغيّرات.
     • الأزرار: ردود سريعة ≤3، أزرار CTA (رابط/اتصال) ≤2، نص الزر ≤25.
       زر الرابط الديناميكي: {{1}} آخر الرابط + مثال **كامل** للرابط.
     • قيمة المتغيّر وقت الإرسال ما فيها سطر جديد ولا tab ولا ٤ مسافات
       ورا بعض ⇒ bindTemplate() تنظّفها.
     • كل قالب تسويقي: فوتر «للإيقاف ردّ: إيقاف» + زر رد سريع «إيقاف».

   حقائق ثابتة متأكدين منها (ما تتغيّر مع المنيو):
     • الاسم «فريش كاتس» · الموقع freshcuts.sa · الفرع حي السلامة بجدة عند
       دوار رامي (settings.storefront.seo.faq) · خرائط جوجل cid 14767749764292326433.
     • أي رقم/سعر/كود/عرض = متغيّر يتعبّى من البيانات الحية وقت الإرسال،
       ما ينكتب في نص القالب.
     • ممنوع: «ستيك» (ما عندنا)، عدد أشخاص لـ«مشكل مخصوص»، «أرخص من
       التطبيقات» (الحارس مقفول من ١٣/٩) — الجملة الصحيحة «بأسعار المنيو الأصلية».
═══════════════════════════════════════════════════════════════════════════ */

export const STORE = "https://freshcuts.sa";
export const MAPS_URL = "https://maps.google.com/?cid=14767749764292326433";
export const PORTAL_URL = "https://freshcuts-invite.o2m8.me/portal/";
export const OPTOUT_FOOTER = "للإيقاف ردّ: إيقاف";
export const OPTOUT_BUTTON = "إيقاف";

export const CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"];
export const GROUPS = {
  order: "دورة الطلب (للعميل)",
  account: "الحساب والولاء",
  staff: "الإدارة والمتابعة (للفريق)",
  marketing: "تسويق وعروض",
  ads: "إعلانات «راسلنا على واتساب»",
};

/* ── بنّاء القالب ────────────────────────────────────────────────────────────
   vars: [{ path, ex, label, fmt? }] — path = مسار الحقل في كائن البيانات اللي
   يمرّره المُرسِل (order.order_no …)، ex = المثال اللي يروح لميتا.
   buttons: url(text, base, {path, ex}) | link(text, url) | qr(text) | otp(). */
const url = (text, base, v) => ({ kind: "url", text, base, var: v || null });
const link = (text, u) => ({ kind: "url", text, base: u, var: null });
const qr = (text) => ({ kind: "qr", text });

function T(def) {
  const { name, category, language = "ar", group, header, body, vars = [], footer, buttons = [], meta = {} } = def;
  const components = [];
  if (header?.image) {
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: ["<UPLOAD_REQUIRED>"] } });
  } else if (header?.text) {
    components.push({ type: "HEADER", format: "TEXT", text: header.text });
  }
  if (category === "AUTHENTICATION") {
    components.push({ type: "BODY", add_security_recommendation: true });
    components.push({ type: "FOOTER", code_expiration_minutes: def.expiryMinutes || 5 });
    components.push({ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: def.copyText || "نسخ الرمز" }] });
  } else {
    const b = { type: "BODY", text: body };
    if (vars.length) b.example = { body_text: [vars.map((v) => String(v.ex))] };
    components.push(b);
    if (footer) components.push({ type: "FOOTER", text: footer });
    if (buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.map((x) => {
          if (x.kind === "qr") return { type: "QUICK_REPLY", text: x.text };
          if (x.var) return { type: "URL", text: x.text, url: `${x.base}{{1}}`, example: [`${x.base}${x.var.ex}`] };
          return { type: "URL", text: x.text, url: x.base };
        }),
      });
    }
  }
  return {
    name, language, category, components,
    meta: {
      group,
      vars: vars.map((v, i) => ({ n: i + 1, path: v.path, label: v.label || v.path, example: String(v.ex), fmt: v.fmt || null })),
      buttonVars: buttons.filter((x) => x.var).map((x) => ({ button: x.text, path: x.var.path, example: String(x.var.ex), base: x.base })),
      needsUpload: Boolean(header?.image),
      ...meta,
    },
  };
}

/* ═══ الكتالوج ═══════════════════════════════════════════════════════════ */
const ORDER_NO = { path: "order.order_no", label: "رقم الطلب", ex: "W1790012345678" };
const FIRST_NAME = { path: "customer.name", label: "الاسم الأول (افتراضي «عميلنا»)", ex: "محمد", fmt: "firstName" };
const TRACK = (text = "تتبّع الطلب") => url(text, `${STORE}/track/`, { path: "order.order_no", ex: "W1790012345678" });
const CART = (text = "كمّل طلبك") => url(text, `${STORE}/c/`, { path: "cart.code", ex: "ab12cd34" });
const LAND = (text = "اطلب الآن", ex = "wa-first") => url(text, `${STORE}/l/`, { path: "link.slug", ex });
const COUPON_LINK = (text = "استخدم الكود") => url(text, `${STORE}/?c=`, { path: "coupon.code", ex: "WA-7K2Q" });
const MKT = { footer: OPTOUT_FOOTER };

export const TEMPLATES = [
  /* ── ١) دورة الطلب — UTILITY ─────────────────────────────────────────── */
  T({ name: "fc_order_received", category: "UTILITY", group: "order",
    body: "أهلاً {{1}}، استلمنا طلبك رقم {{2}} وتم الدفع بنجاح ✅\nالإجمالي: {{3}} ر.س\nنبلّغك هنا بكل تحديث على طلبك.",
    vars: [FIRST_NAME, ORDER_NO, { path: "order.total", label: "الإجمالي", ex: "86.50", fmt: "money" }],
    buttons: [TRACK()],
    meta: { purpose: "تأكيد الطلب بعد الدفع ونزوله نقطة البيع", trigger: "shop.js حالة pos_created (notify.orderStatusChanged)",
      stage: "pos_created", send: "auto", fallbackSms: "order.pos_created (smstemplates.js)", existing: "whatsapp.js fc_order_received (نص أقدم)" } }),

  T({ name: "fc_payment_received", category: "UTILITY", group: "order",
    body: "تم استلام دفعتك لطلب رقم {{1}} بمبلغ {{2}} ر.س ✅\nنأكّد الطلب مع المطعم الحين، ونرسل لك التأكيد هنا.",
    vars: [ORDER_NO, { path: "order.total", label: "المبلغ", ex: "86.50", fmt: "money" }],
    meta: { purpose: "الدفع تم لكن نقطة البيع ما أكّدت بعد (تأخير أو فشل مؤقت)", trigger: "حالة paid_pos_failed أو paid لأكثر من دقيقتين",
      stage: "paid_pos_failed", send: "auto", fallbackSms: "فريش كاتس: استلمنا دفعتك لطلب {order_no} ونأكّده مع المطعم الحين" } }),

  T({ name: "fc_order_preparing", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} صار في المطبخ 👨‍🍳\nنطبخ الأكل طازج عند الطلب، ونبلّغك أول ما يجهز.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "الكاشير قبل الطلب", trigger: "حالة accepted", stage: "accepted", send: "auto",
      fallbackSms: "order.accepted", existing: "whatsapp.js fc_order_preparing" } }),

  T({ name: "fc_order_ready_pickup", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} جاهز للاستلام ✅\nتقدر تستلمه من فرعنا في {{2}}، واعرض رقم الطلب على الكاشير.",
    vars: [ORDER_NO, { path: "branch.area", label: "منطقة الفرع (من الإعدادات)", ex: "حي السلامة عند دوار رامي" }],
    buttons: [link("موقع الفرع", MAPS_URL)],
    meta: { purpose: "طلب استلام صار جاهز", trigger: "pos_ready_at لطلب option=pickup (أو pickupReadyMinutes بعد القبول)",
      stage: "pickup_ready", send: "auto", fallbackSms: "فريش كاتس: طلبك {order_no} جاهز للاستلام من الفرع", existing: "whatsapp.js fc_order_ready_pickup" } }),

  T({ name: "fc_courier_assigned", category: "UTILITY", group: "order",
    body: "رتّبنا مندوب لطلبك رقم {{1}} 🛵\nيستلم الطلب أول ما يجهز من المطبخ، وتقدر تتابع من الرابط.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "شركة التوصيل عيّنت مندوب — صياغة محايدة (الأكل ممكن لسه يتجهّز)", trigger: "حالة courier_assigned",
      stage: "courier_assigned", send: "auto", fallbackSms: "order.courier_assigned",
      notes: "قرار عمر ١١/٩: لا نقول «المندوب في الطريق» قبل ما الأكل يجهز" } }),

  T({ name: "fc_order_on_the_way", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.",
    vars: [ORDER_NO], buttons: [TRACK("تتبّع المندوب")],
    meta: { purpose: "المندوب استلم الطلب", trigger: "حالة on_the_way (المندوب الخارجي: /d/<token> «ابدأ التوصيل»)",
      stage: "on_the_way", send: "auto", fallbackSms: "order.on_the_way", existing: "whatsapp.js fc_order_on_the_way" } }),

  T({ name: "fc_order_delivered", category: "UTILITY", group: "order",
    body: "تم توصيل طلبك رقم {{1}} ✅ بالعافية عليك.\nلو عندك أي ملاحظة على الطلب ردّ على هذي الرسالة ونخدمك.",
    vars: [ORDER_NO],
    meta: { purpose: "تأكيد التوصيل — ويفتح نافذة ٢٤ ساعة لو العميل ردّ", trigger: "حالة delivered",
      stage: "delivered", send: "auto", fallbackSms: "order.delivered", existing: "whatsapp.js fc_order_delivered" } }),

  T({ name: "fc_review_request", category: "UTILITY", group: "order",
    body: "نتمنى الأكل عجبك 🌟\nكيف كانت تجربتك مع طلب رقم {{1}}؟ التقييم ياخذ أقل من دقيقة ويساعدنا نتحسّن.",
    vars: [ORDER_NO], buttons: [url("قيّم طلبك", `${STORE}/r?c=`, { path: "review.code", ex: "ab12cd" })],
    meta: { purpose: "طلب التقييم بعد التوصيل", trigger: "reviews.js review_invites — بعد ٣٠ دقيقة من التوصيل، خارج ٢ص–١١ص",
      send: "auto", fallbackSms: "review.invite", reclassRisk: "medium",
      notes: "مرتبط بطلب محدد ⇒ UTILITY، لكن ميتا أحياناً تصنّف الاستبيانات تسويق. صفحة /r فيها التوجيه الحالي (٤–٥★ جوجل) — انتبه لملاحظة review gating في freshcuts-seo-compliance" } }),

  T({ name: "fc_order_delayed", category: "UTILITY", group: "order",
    body: "نعتذر منك، طلبك رقم {{1}} تأخر عن الوقت المتوقع 🙏\nفريقنا يتابعه الحين ونبلّغك أول ما يتحرك، وتقدر تتابع حالته من الرابط.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "اعتذار استباقي عن التأخير", trigger: "slaCheck مستوى ≥2 (handoff_breach/pickup_breach/deliver_breach) — مرة وحدة للطلب",
      send: "auto-candidate", fallbackSms: "فريش كاتس: نعتذر عن تأخر طلبك {order_no}، فريقنا يتابعه الحين",
      notes: "ما فيه وعد بدقائق — ما عندنا ETA حقيقي (لاجلك ما يرجّع ETA)" } }),

  T({ name: "fc_order_refunded", category: "UTILITY", group: "order",
    body: "نعتذر منك، ما قدرنا ننفّذ طلبك رقم {{1}} وتم استرجاع مبلغ {{2}} ر.س كاملاً لوسيلة الدفع 💳\nيظهر المبلغ في حسابك حسب إجراءات البنك.",
    vars: [ORDER_NO, { path: "order.total", label: "المبلغ المسترجع", ex: "86.50", fmt: "money" }],
    meta: { purpose: "الطلب اترفض والاسترجاع نجح", trigger: "حالة rejected_refunded", stage: "rejected_refunded",
      send: "auto", mandatory: true, fallbackSms: "order.rejected_refunded", existing: "whatsapp.js fc_order_refunded" } }),

  T({ name: "fc_refund_in_progress", category: "UTILITY", group: "order",
    body: "نعتذر منك بخصوص طلبك رقم {{1}} 🙏\nاسترجاع المبلغ جاري وفريقنا يتابعه، وبنتواصل معك للتأكيد.",
    vars: [ORDER_NO],
    meta: { purpose: "الاسترجاع الآلي فشل — لا نقول «تم»", trigger: "حالة refund_failed", stage: "refund_failed",
      send: "auto", mandatory: true, fallbackSms: "order.refund_failed", existing: "whatsapp.js fc_refund_in_progress" } }),

  T({ name: "fc_order_cancelled", category: "UTILITY", group: "order",
    body: "تم إلغاء طلبك رقم {{1}} حسب طلبك.\nلو دفعت المبلغ يرجع لوسيلة الدفع حسب إجراءات البنك، ولأي استفسار ردّ على هذي الرسالة.",
    vars: [ORDER_NO],
    meta: { purpose: "إلغاء بطلب العميل (الموظف ألغى من البورتال)", trigger: "إلغاء يدوي من المدير بعد طلب العميل",
      send: "manual", fallbackSms: "فريش كاتس: تم إلغاء طلبك {order_no} حسب طلبك" } }),

  T({ name: "fc_payment_failed", category: "UTILITY", group: "order",
    body: "ما اكتملت عملية الدفع لطلبك من فريش كاتس.\nسلتك محفوظة وتقدر تكمّل الدفع من الرابط، ولو ظهر مبلغ معلّق يرجع تلقائياً حسب البنك.",
    buttons: [CART("كمّل الدفع")],
    meta: { purpose: "جلسة الدفع فشلت/انتهت (رفض بنك)", trigger: "shop_orders pending_payment → expired مع cart_recovery code (مرة وحدة)",
      send: "auto-candidate", reclassRisk: "medium", fallbackSms: "فريش كاتس: ما اكتمل الدفع، سلتك محفوظة: freshcuts.sa/c/{code}",
      notes: "نبرة محايدة بدون عرض عشان يبقى UTILITY. لو ميتا صنّفته تسويق نرجع لـfc_cart_1h" } }),

  T({ name: "fc_otp", category: "AUTHENTICATION", group: "order", expiryMinutes: 5, copyText: "نسخ الرمز",
    meta: { purpose: "رمز الدخول في الشيك أوت", trigger: "accounts.js /api/account/otp/request (قناة واتساب اختيارية)",
      send: "auto", fallbackSms: "account.otp",
      notes: "نص قوالب التحقق ثابت من ميتا («{{1}} هو رمز التحقق الخاص بك»). الإرسال: body=[code] + button url param=[code]",
      bind: [{ n: 1, path: "otp.code", label: "الرمز", example: "4821" }], existing: "whatsapp.js fc_otp" } }),

  T({ name: "fc_address_confirm", category: "UTILITY", group: "order",
    body: "قبل ما نرسل طلبك رقم {{1}} للمندوب نبي نتأكد من العنوان:\n{{2}}\nهل العنوان صحيح؟",
    vars: [ORDER_NO, { path: "order.addressText", label: "العنوان المقروء (سطر واحد)", ex: "حي الصفا، شارع الأمير سلطان، عمارة 12" }],
    buttons: [qr("العنوان صحيح"), qr("تعديل العنوان")],
    meta: { purpose: "تأكيد العنوان لما الدبوس بعيد عن الحي المكتوب أو ناقص", trigger: "يدوي من البورتال (أو مستقبلاً: فرق الدبوس/النص)",
      send: "manual", fallbackSms: "فريش كاتس: نبي نتأكد من عنوان طلبك {order_no}، اتصل علينا 0546715683",
      replies: { "العنوان صحيح": "addr:ok", "تعديل العنوان": "addr:edit → handoff" } } }),

  T({ name: "fc_scheduled_reminder", category: "UTILITY", group: "order",
    body: "تذكير بطلبك المجدول رقم {{1}} ⏰\nنجهّزه ويوصلك في موعده: {{2}}.\nلو تبي تعدّل أي شي ردّ على هذي الرسالة قبل الموعد بساعة.",
    vars: [ORDER_NO, { path: "order.slotText", label: "الموعد (من scheduled_slot)", ex: "اليوم 8:00 – 11:00 م" }],
    buttons: [TRACK()],
    meta: { purpose: "تذكير الطلب المجدول", trigger: "preorder.js قبل scheduled_for بـprepLeadMin",
      send: "auto-candidate", fallbackSms: "فريش كاتس: تذكير بطلبك المجدول {order_no}",
      notes: "settings.preorder.enabled=false حالياً — يشتغل لما يتفعّل" } }),

  T({ name: "fc_waitlist_open", category: "UTILITY", group: "order",
    body: "فتحنا الحين 🎉\nطلبت منّا نذكّرك أول ما يفتح المطعم، وسلتك محفوظة زي ما تركتها.",
    buttons: [CART()],
    meta: { purpose: "«نبّهني لما تفتحوا» — تنبيه طلبه العميل بنفسه", trigger: "openwait.js عند الفتح (نافذة openWindowMinutes)",
      send: "auto", reclassRisk: "medium", fallbackSms: "waitlist.open",
      notes: "العميل طلب التنبيه ⇒ UTILITY. لو ميتا رفضت: نفس النص MARKETING مع فوتر الإيقاف" } }),

  /* ── ٢) الحساب والولاء ───────────────────────────────────────────────── */
  T({ name: "fc_welcome_account", category: "UTILITY", group: "account",
    body: "أهلاً {{1}}، تم تفعيل حسابك في فريش كاتس ✅\nتقدر تتابع طلباتك وعناوينك المحفوظة من الموقع، وأي استفسار ردّ على هذي الرسالة.",
    vars: [FIRST_NAME], buttons: [link("فتح الموقع", `${STORE}/`)],
    meta: { purpose: "ترحيب بعد أول تحقق OTP/إنشاء حساب — بدون عرض (عشان يبقى UTILITY)", trigger: "acct_customers أول تسجيل",
      send: "auto-candidate", fallbackSms: null } }),

  T({ name: "fc_loyalty_progress", category: "MARKETING", group: "account", ...MKT,
    body: "باقي لك {{1}} طلبات وتحصل على {{2}} 🎁\nكل طلب من موقع فريش كاتس يقرّبك من مكافأتك.",
    vars: [{ path: "loyalty.remaining", label: "الطلبات الباقية", ex: "2" }, { path: "loyalty.rewardText", label: "المكافأة (من cms.loyalty)", ex: "توصيل مجاني" }],
    buttons: [LAND("اطلب الآن", "wa-loyalty"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "تقدّم الولاء", trigger: "بعد كل طلب مدفوع لو cms.loyalty.enabled و remaining ≤ 2",
      send: "auto-candidate", fallbackSms: null, notes: "cms.loyalty.enabled=false حالياً (every=5, reward=free_delivery)" } }),

  T({ name: "fc_loyalty_reward", category: "MARKETING", group: "account", ...MKT,
    body: "مبروك {{1}} 🎉 وصلت لمكافأتك في فريش كاتس: {{2}}.\nكودك الخاص {{3}} صالح لين {{4}}، استخدمه في طلبك الجاي من الموقع.",
    vars: [FIRST_NAME, { path: "loyalty.rewardText", label: "المكافأة", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "الكود الشخصي (cms_loyalty.coupon)", ex: "LOY-8F3K" }, { path: "coupon.expiresText", label: "تاريخ الانتهاء", ex: "12 أكتوبر" }],
    buttons: [COUPON_LINK(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون الولاء", trigger: "cms.js loyaltyRun يصدر كوبون", send: "auto", fallbackSms: "push/SMS الحالي في loyaltyRun" } }),

  T({ name: "fc_coupon_expiring", category: "MARKETING", group: "account", ...MKT,
    body: "تذكير لطيف: كودك {{1}} ينتهي {{2}} ⏳\nاستخدمه في طلبك من موقع فريش كاتس قبل ما يروح عليك.",
    vars: [{ path: "coupon.code", label: "الكود", ex: "LOY-8F3K" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "بكرة" }],
    buttons: [COUPON_LINK(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون شخصي (ولاء/واتساب مرة وحدة) قرب ينتهي", trigger: "shop_coupons phone_norm غير فاضي، used_count=0، expires_at = بكرة",
      send: "auto-candidate", fallbackSms: null } }),

  /* ── ٣) الإدارة — UTILITY لأرقام الفريق (settings.delivery.staffSmsLanguage) ── */
  ...staffPair("fc_staff_new_order",
    { body: "New online order {{1}}: {{2}}, {{3}} SAR, paid. {{4}} items, follow it on the portal.",
      ar: "طلب أونلاين جديد {{1}}: {{2}} بمبلغ {{3}} ر.س مدفوع. عدد الأصناف {{4}}، تابعه من البورتال." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "order.optionText", ex: "Delivery", exAr: "توصيل", label: "توصيل/استلام" },
      { path: "order.total", ex: "86.50", label: "الإجمالي", fmt: "money" }, { path: "order.itemCount", ex: "3", label: "عدد الأصناف" }],
    { purpose: "طلب أونلاين جديد مدفوع", trigger: "staffalerts.js newOrderText — settings.delivery.newOrderPhones", send: "auto",
      fallbackSms: "staffalerts.newOrderText" }),
  ...staffPair("fc_staff_sla_alert",
    { body: "Order {{1}} needs action now: {{2}}. Please check the portal.",
      ar: "الطلب {{1}} يحتاج تدخل الحين: {{2}}. افتح البورتال وتابعه." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "sla.text", ex: "25min since acceptance, no courier requested", exAr: "٢٥ دقيقة من القبول بدون مندوب", label: "نص slaCheck" }],
    { purpose: "طلب متعطّل (SLA)", trigger: "shop.js slaCheck مستوى ≥2 — نفس أكواد SLA_EN/SLA_AR", send: "auto", fallbackSms: "staffalerts SLA" }),
  ...staffPair("fc_staff_courier_issue",
    { body: "Courier problem on order {{1}}: {{2}}. Request another courier or send an external one from the portal.",
      ar: "مشكلة مندوب في الطلب {{1}}: {{2}}. اطلب مندوب ثاني أو أرسل مندوب خارجي من البورتال." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "courier.issue", ex: "Leajlak refused the order", exAr: "لاجلك رفض الطلب", label: "المشكلة (courierops)" }],
    { purpose: "رفض/تأخر المندوب", trigger: "courierops.js رفض لاجلك أو تأخر الوصول > 20 دقيقة", send: "auto", fallbackSms: "staffalerts courier" }),
  ...staffPair("fc_staff_pos_failed",
    { body: "Order {{1}} is PAID but did not reach the POS ({{2}}). Enter it manually on the POS now.",
      ar: "الطلب {{1}} مدفوع وما نزل نقطة البيع ({{2}}). أدخله يدوي على الكاشير الحين." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "pos.error", ex: "partner token expired", exAr: "انتهت صلاحية الربط", label: "سبب الفشل (last_pos_error مختصر)" }],
    { purpose: "فشل المزامنة مع نقطة البيع", trigger: "paid_pos_failed فوري", send: "auto", fallbackSms: "staffalerts paid_pos_failed" }),
  ...staffPair("fc_staff_daily_summary",
    { body: "Fresh Cuts daily summary for {{1}}: {{2}} online orders, {{3}} SAR sales, average rating {{4}}. Details are in the dashboard.",
      ar: "ملخص فريش كاتس ليوم {{1}}: {{2}} طلب أونلاين، مبيعات {{3}} ر.س، متوسط التقييم {{4}}. التفاصيل في اللوحة." },
    [{ path: "day.label", ex: "27 Sep", exAr: "٢٧ سبتمبر", label: "اليوم التشغيلي (bizday 11→03)" },
      { path: "day.orders", ex: "14", label: "عدد الطلبات" }, { path: "day.sales", ex: "1240", label: "المبيعات", fmt: "money" },
      { path: "day.rating", ex: "4.6", label: "متوسط تقييمنا الداخلي" }],
    { purpose: "ملخص يومي", trigger: "dayreport.js بعد قفلة اليوم التشغيلي (٠٤:٠٠)", send: "auto-candidate", fallbackSms: null },
    [link("Open dashboard", "https://freshcuts-invite.o2m8.me/#store")], [link("فتح اللوحة", "https://freshcuts-invite.o2m8.me/#store")]),
  ...staffPair("fc_staff_low_rating",
    { body: "New low rating: {{1}} stars on order {{2}}. Customer note: {{3}}. Please call the customer today.",
      ar: "تقييم منخفض جديد: {{1}} نجوم على الطلب {{2}}. ملاحظة العميل: {{3}}. اتصل على العميل اليوم." },
    [{ path: "review.rating", ex: "2", label: "النجوم" }, { path: "review.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "review.comment", ex: "the food arrived cold", exAr: "الأكل وصل بارد", label: "التعليق (مختصر ≤120)" }],
    { purpose: "تقييم ≤٣ نجوم", trigger: "reviews.js feedback (alertNegative)", send: "auto", fallbackSms: "reviews manager SMS" }),
  ...staffPair("fc_staff_checkout_watchdog",
    { body: "Checkout alert: {{1}}. Last successful online order was {{2}}. Please test the website now.",
      ar: "تنبيه الدفع: {{1}}. آخر طلب ناجح كان {{2}}. جرّب الموقع الحين." },
    [{ path: "watch.problem", ex: "3 payment sessions failed in 20 min", exAr: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة", label: "المشكلة (checkoutwatch)" },
      { path: "watch.lastOrderAgo", ex: "95 min ago", exAr: "قبل ٩٥ دقيقة", label: "آخر طلب ناجح" }],
    { purpose: "حارس الشيك أوت", trigger: "checkoutwatch.js / ops/checkout-watch-run.mjs", send: "auto", fallbackSms: "checkoutwatch SMS" }),
  ...staffPair("fc_staff_wa_handoff",
    { body: "A WhatsApp customer needs a staff reply ({{1}}): {{2}}. Open the WhatsApp inbox in the portal.",
      ar: "عميل واتساب يحتاج رد موظف ({{1}}): {{2}}. افتح صندوق واتساب في البورتال." },
    [{ path: "handoff.reasonText", ex: "complaint", exAr: "شكوى", label: "السبب (wabot handoff.reason)" },
      { path: "handoff.summary", ex: "order W1790012345678 arrived cold", exAr: "طلب W1790012345678 وصل بارد", label: "ملخص رسالة العميل ≤120" }],
    { purpose: "تحويل من البوت لموظف (شكوى/إلغاء/طلب موظف)", trigger: "wabot action handoff (priority high فوري، normal لو ما رد أحد خلال ١٠ دقائق)",
      send: "auto", fallbackSms: "Fresh Cuts: WhatsApp customer needs a reply ({reason})" },
    [link("Open inbox", PORTAL_URL)], [link("فتح البورتال", PORTAL_URL)]),

  /* ── ٤) تسويق وعروض — MARKETING (فوتر إيقاف + زر إيقاف) ─────────────── */
  T({ name: "fc_welcome_offer", category: "MARKETING", group: "marketing", ...MKT,
    body: "أهلاً {{1}} 👋 حيّاك في فريش كاتس.\nأول طلب لك من موقعنا توصيله مجاني بكود {{2}} للطلبات من {{3}} ر.س وأكثر داخل نطاق التوصيل.\nمشاوي على الفحم، كريبات، بيتزا وباستا نطبخها طازجة عند الطلب.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود أول طلب (shop_coupons FIRST)", ex: "FIRST" },
      { path: "coupon.min_total", label: "الحد الأدنى (shop_coupons.min_total)", ex: "40", fmt: "money" }],
    buttons: [LAND("اطلب الآن", "wa-first"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "ترحيب بعرض أول طلب", trigger: "رقم جديد ما عنده طلب موقع مدفوع (identity.js) ووافق على التسويق",
      send: "auto-candidate", fallbackSms: "حملة SMS w_recent_new", notes: "FIRST: free_delivery + once_per_customer + min 40 — لا يغطي رسوم المسافة البعيدة" } }),

  T({ name: "fc_winback_21", category: "MARKETING", group: "marketing", ...MKT,
    body: "اشتقنا لك يا {{1}} 🔥\nصار لك فترة ما طلبت من فريش كاتس، ومشاوينا على الفحم تنتظرك. اطلب من موقعنا بأسعار المنيو الأصلية.",
    vars: [FIRST_NAME], buttons: [LAND("اطلب الآن", "wa-wb21"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "استرجاع ٢١ يوم (بدون كوبون)", trigger: "آخر طلب (أي قناة، identity.js) قبل ٢١–٤٤ يوم", send: "auto-candidate",
      fallbackSms: "w_lapsed", notes: "يحترم فجوة ٢١ يوم وقواعد smsrules (ساعات الهدوء، الموقوفين، الفريق)" } }),

  T({ name: "fc_winback_45", category: "MARKETING", group: "marketing", ...MKT,
    body: "وحشتنا يا {{1}} 🙌\nجهّزنا لك {{2}} على طلبك الجاي من موقع فريش كاتس بكود {{3}}، والكود صالح لين {{4}} لا يفوتك.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "خصم 10٪" },
      { path: "coupon.code", label: "كود شخصي لمرة وحدة", ex: "WB-4Q7M" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "5 أكتوبر" }],
    buttons: [COUPON_LINK("اطلب بالكود"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "استرجاع ٤٥ يوم بكوبون شخصي", trigger: "آخر طلب قبل ٤٥–٨٩ يوم", send: "auto-candidate", fallbackSms: "w_lapsed" } }),

  T({ name: "fc_winback_90", category: "MARKETING", group: "marketing", ...MKT,
    body: "من زمان ما شفناك يا {{1}}!\nعشان ترجع تجرّبنا هذي هدية منّا: {{2}} على طلبك من الموقع بكود {{3}}. الكود لمرة وحدة وصالح لين {{4}} بس.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي", ex: "WB-9Z2P" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "5 أكتوبر" }],
    buttons: [COUPON_LINK("اطلب بالكود"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "آخر محاولة استرجاع ٩٠ يوم", trigger: "آخر طلب قبل ٩٠–١٨٠ يوم (مرة وحدة)", send: "auto-candidate", fallbackSms: "w_last_call" } }),

  T({ name: "fc_vip_lapsed", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} ⭐ أنت من أغلى عملائنا ولاحظنا غيابك من فترة.\nجهّزنا لك {{2}} بكود خاص فيك {{3}} صالح لين {{4}}، ونتمنى نشوف طلبك قريب.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "خصم 15٪" },
      { path: "coupon.code", label: "كود شخصي", ex: "VIP-3H8D" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "10 أكتوبر" }],
    buttons: [COUPON_LINK("اطلب بالكود"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "VIP غايب", trigger: "أعلى ١٠٪ إنفاق (customer360) وآخر طلب قبل ≥٣٠ يوم", send: "manual", fallbackSms: null } }),

  T({ name: "fc_fav_dish", category: "MARKETING", group: "marketing", ...MKT,
    body: "مشتهي {{1}} اليوم؟ 😋\nطلبته منّا قبل، وهو متوفر الحين بـ{{2}} ر.س في موقع فريش كاتس. اطلبه بضغطة ويوصلك حار.",
    vars: [{ path: "dish.name", label: "الطبق المفضّل (أكثر صنف طلبه — من المنيو الحي فقط)", ex: "وجبة ميكس جريل" },
      { path: "dish.price", label: "السعر الحي من /api/menu", ex: "37", fmt: "money" }],
    buttons: [url("اطلبه الآن", `${STORE}/`, { path: "dish.linkSuffix", ex: "?utm_source=whatsapp#item-18" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "توصية بالطبق المفضّل", trigger: "ts_order_items/shop_orders — الصنف الأكثر للعميل، بشرط موجود في المنيو الحي ومش «خلص»",
      send: "auto-candidate", fallbackSms: null, notes: "الحارس: لو الصنف مش في المنيو الحي أو السعر اختلف ⇒ لا ترسل" } }),

  T({ name: "fc_new_item", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "جديد في فريش كاتس 🔥\nجرّب {{1}}: {{2}}.\nالسعر {{3}} ر.س ومتوفر الحين في الموقع.",
    vars: [{ path: "item.name", label: "اسم الصنف (المنيو الحي)", ex: "طاسة كرانشي" },
      { path: "item.description", label: "الوصف من المنيو ≤120", ex: "طاسة جبن مع سترِبس دجاج ورومي مدخن" },
      { path: "item.price", label: "السعر الحي", ex: "38", fmt: "money" }],
    buttons: [url("اطلبه الآن", `${STORE}/`, { path: "item.linkSuffix", ex: "?utm_source=whatsapp#item-50" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "إطلاق صنف جديد (صورة)", trigger: "يدوي من اللوحة عند إضافة صنف", send: "manual", fallbackSms: null,
      notes: "الصورة: صورة الصنف الحقيقية من المنيو (قرار ١٨/٩: بدون نص/سعر داخل الصورة)" } }),

  T({ name: "fc_weekend_offer", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "عرض نهاية الأسبوع في فريش كاتس 🎉\n{{1}} بـ{{2}} ر.س، والعرض لين {{3}} فقط. اطلبه من الموقع للتوصيل أو الاستلام.",
    vars: [{ path: "offer.title", label: "عنوان العرض (offer_registry)", ex: "باقة تجمّع ٤–٦ أشخاص" },
      { path: "offer.price", label: "السعر", ex: "225", fmt: "money" }, { path: "offer.untilText", label: "آخر يوم", ex: "السبت" }],
    buttons: [url("شوف العرض", `${STORE}/?offer=`, { path: "offer.id", ex: "gathering_4" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عرض الويكند (صورة)", trigger: "الخميس ١٦:٠٠ لعرض شغّال في offer_registry (enabled + التاريخ + قناة delivery)",
      send: "manual", fallbackSms: null, notes: "offers-cache-chain: تأكد العرض enabled في offer_registry مو بس الباقة" } }),

  T({ name: "fc_bundle_offer", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "لمّة الأهل والأصحاب؟ 🍢\n{{1}} بـ{{2}} ر.س وفيها {{3}}.\nاطلبها من الموقع للتوصيل أو الاستلام.",
    vars: [{ path: "offer.title", label: "اسم الباقة", ex: "باقة تجمّع ٨–١٠ أشخاص" }, { path: "offer.price", label: "السعر", ex: "395", fmt: "money" },
      { path: "offer.line", label: "المحتوى (extra.copy.line)", ex: "٣ كيلو مشاوي ودجاجة كاملة على الفحم مع الأرز والبطاطس والكولسلو و٨ مشروبات" }],
    buttons: [url("كوّن الباقة", `${STORE}/?offer=`, { path: "offer.id", ex: "gathering_8" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عرض الباقات/البوكس (صورة)", trigger: "يدوي أو شريحة «طلبات كبيرة»", send: "manual", fallbackSms: null,
      notes: "المحتوى من offer_registry كما هو — لا نضيف عدد أشخاص لأي صنف بالوزن («مشكل مخصوص» خصوصاً)" } }),

  T({ name: "fc_cart_1h", category: "MARKETING", group: "marketing", ...MKT,
    body: "سلتك في فريش كاتس محفوظة 🛒\nكمّل طلبك بضغطة من الرابط، ولو عندك سؤال ردّ علينا هنا.",
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ١", trigger: "carts.js sms1AfterMinutes (٣٥ د) — واتساب بدل SMS لو الرقم عنده موافقة",
      send: "auto", fallbackSms: "cart.sms1", existing: "whatsapp.js fc_cart_reminder (نص أقدم، رابط ?resume=)" } }),

  T({ name: "fc_cart_24h", category: "MARKETING", group: "marketing", ...MKT,
    body: "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nكمّل الحين من الرابط ونبدأ نجهّزه لك طازج.",
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ٢ (عميل قديم)", trigger: "carts.js sms2 (تاني يوم ١٧:٠٠، سلة ≥ ٦٠)", send: "auto", fallbackSms: "cart.sms2" } }),

  T({ name: "fc_cart_24h_first", category: "MARKETING", group: "marketing", ...MKT,
    body: "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nوبما إنه أول طلب لك من الموقع، التوصيل مجاني بكود {{1}} داخل نطاق التوصيل.",
    vars: [{ path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }],
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ٢ (عميل جديد)", trigger: "carts.js sms2_first", send: "auto", fallbackSms: "cart.sms2_first" } }),

  T({ name: "fc_birthday", category: "MARKETING", group: "marketing", ...MKT,
    body: "كل عام وأنت بخير يا {{1}} 🎂\nهديتك من فريش كاتس: {{2}} بكود {{3}}، صالح لين {{4}} على طلبك من الموقع.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الهدية", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي", ex: "BD-6T1R" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "نهاية الأسبوع" }],
    buttons: [COUPON_LINK("استخدم الهدية"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عيد ميلاد (قالب جاهز)", trigger: "لا يوجد تاريخ ميلاد في بياناتنا حالياً — placeholder", send: "manual", fallbackSms: null,
      needsOmar: "هل نجمع تاريخ الميلاد؟" } }),

  T({ name: "fc_occasion", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "بمناسبة {{1}} نقول لك كل عام وأنت بخير 🎉\nجهّزنا لك {{2}} على طلبك من موقع فريش كاتس لين {{3}}.",
    vars: [{ path: "occasion.name", label: "المناسبة", ex: "اليوم الوطني" }, { path: "occasion.offerText", label: "العرض (من offer_registry)", ex: "كيلو مشاوي بـ96 ر.س" },
      { path: "occasion.untilText", label: "آخر يوم", ex: "30 سبتمبر" }],
    buttons: [url("اطلب الآن", `${STORE}/l/`, { path: "link.slug", ex: "wa-occasion" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "مناسبة وطنية/موسمية عامة", trigger: "يدوي", send: "manual", fallbackSms: null,
      notes: "اليوم الوطني: الهوية الرسمية (saudi-national-day-identity). رمضان/العيد: نفس القالب" } }),

  T({ name: "fc_review_thanks_coupon", category: "MARKETING", group: "marketing", ...MKT,
    body: "شكراً {{1}} على ملاحظتك لفريش كاتس 🙏\nكلامك يوصل للفريق كامل، وهذي هدية بسيطة لطلبك الجاي: {{2}} بكود {{3}} على طلبك من الموقع.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الهدية", ex: "خصم 10٪" }, { path: "coupon.code", label: "كود شخصي", ex: "TY-2M5W" }],
    buttons: [COUPON_LINK("استخدم الهدية"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "شكر على الملاحظة الداخلية", trigger: "يدوي من صندوق التقييمات بعد حل المشكلة", send: "manual", fallbackSms: null,
      notes: "للملاحظات الداخلية بس — لا ترسله مقابل تقييم جوجل (سياسة جوجل تمنع الحوافز)" } }),

  T({ name: "fc_referral_invite", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} 👋 عندك صديق يحب المشاوي؟\nشارك معه كودك {{2}} ويحصل على {{3}} في أول طلب له من موقع فريش كاتس.",
    vars: [FIRST_NAME, { path: "referral.code", label: "كود السفير (batches)", ex: "AMB-OMAR" }, { path: "referral.benefitText", label: "ميزة الصديق", ex: "خصم 15٪" }],
    buttons: [url("انسخ رابطك", `${STORE}/?c=`, { path: "referral.code", ex: "AMB-OMAR" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "دعوة صديق / سفير", trigger: "يدوي أو بعد ٣ طلبات ناجحة", send: "manual", fallbackSms: null,
      needsOmar: "برنامج الإحالة — المكافأة وقواعدها" } }),

  T({ name: "fc_try_website", category: "MARKETING", group: "marketing", ...MKT,
    body: "شكراً إنك اخترت فريش كاتس 🙏\nتقدر الحين تطلب مباشرة من موقعنا بأسعار المنيو الأصلية، وأول طلب توصيله مجاني بكود {{1}} للطلبات من {{2}} ر.س وأكثر.",
    vars: [{ path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }, { path: "coupon.min_total", label: "الحد الأدنى", ex: "40", fmt: "money" }],
    buttons: [LAND("جرّب الموقع", "wa-site"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "تحويل عملاء الصالة/التطبيقات للموقع", trigger: "رقم له طلبات POS/كيتا وما له طلب موقع (O6 app segments)",
      send: "auto-candidate", fallbackSms: "k_app_* waves", notes: "لا «أرخص من التطبيقات» — الحارس مقفول" } }),

  T({ name: "fc_one_time_coupon", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} 🎁\nهذا كود خاص فيك لمرة وحدة {{2}} ويعطيك {{3}} على طلبك من موقع فريش كاتس، صالح لين {{4}} فقط.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود مقفول على الجوال (shop_coupons.phone_norm)", ex: "WA-7K2Q" },
      { path: "coupon.benefitText", label: "الميزة", ex: "خصم 15٪" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "3 أكتوبر" }],
    buttons: [COUPON_LINK(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون شخصي لمرة وحدة", trigger: "wasender.js عروض واتساب (مرة لكل عميل)", send: "auto-candidate", fallbackSms: null } }),

  /* ── ٥) إعلانات «راسلنا على واتساب» ─────────────────────────────────── */
  T({ name: "fc_ad_lead_followup", category: "MARKETING", group: "ads", ...MKT,
    body: "أهلاً {{1}} 👋 تواصلت معنا من إعلان فريش كاتس.\nالمنيو كامل بأسعاره في موقعنا، وأول طلب توصيله مجاني بكود {{2}} داخل نطاق التوصيل.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }],
    buttons: [LAND("شوف المنيو", "wa-ad"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "متابعة عميل إعلان ما طلب (بعد قفل نافذة ٢٤ ساعة)", trigger: "wa conversation بـreferral، بدون طلب خلال ٢٤–٤٨ ساعة",
      send: "auto-candidate", fallbackSms: null } }),

  T({ name: "fc_ad_lead_last_call", category: "MARKETING", group: "ads", ...MKT,
    body: "آخر تذكير منّا يا {{1}} 😊\nعرض {{2}} لسا شغّال لين {{3}}، ولو عندك أي سؤال ردّ هنا ونخدمك.",
    vars: [FIRST_NAME, { path: "offer.title", label: "العرض الشغّال", ex: "باقة تجمّع ٤–٦ أشخاص" }, { path: "offer.untilText", label: "آخر يوم", ex: "15 أكتوبر" }],
    buttons: [url("شوف العرض", `${STORE}/?offer=`, { path: "offer.id", ex: "gathering_4" }), qr(OPTOUT_BUTTON)],
    meta: { purpose: "آخر محاولة لعميل الإعلان", trigger: "بعد ٧٢ ساعة من fc_ad_lead_followup بدون طلب — مرة وحدة", send: "auto-candidate", fallbackSms: null } }),
];

/* قوالب الفريق: نفس الاسم بلغتين (en افتراضي، ar لو staffSmsLanguage="ar") */
function staffPair(name, texts, vars, meta, buttonsEn = [link("Open portal", PORTAL_URL)], buttonsAr = [link("فتح البورتال", PORTAL_URL)]) {
  const m = { ...meta, audience: "staff", langSetting: "settings.delivery.staffSmsLanguage" };
  return [
    T({ name, category: "UTILITY", group: "staff", language: "en", body: texts.body, vars, buttons: buttonsEn, meta: m }),
    T({ name, category: "UTILITY", group: "staff", language: "ar", body: texts.ar,
      vars: vars.map((v) => ({ ...v, ex: v.exAr || v.ex })), buttons: buttonsAr, meta: m }),
  ];
}

/* أول ٨ نقدّمهم لميتا (الأثر الأكبر × أقل مخاطرة تصنيف) — مرتبين */
export const RECOMMENDED_FIRST = [
  "fc_otp",                 // يقلّل تكلفة SMS الرمز ويوصل أضمن
  "fc_order_received",      // أول لمسة بعد الدفع
  "fc_order_on_the_way",    // الرسالة الوحيدة المفعّلة SMS اليوم
  "fc_order_delivered",     // يفتح نافذة الـ٢٤ ساعة للملاحظات
  "fc_order_refunded",      // إجباري (فلوس العميل)
  "fc_staff_new_order",     // يغني عن SMS المدير
  "fc_cart_1h",             // أعلى عائد تسويقي (سلة جاهزة)
  "fc_welcome_offer",       // FIRST — تحويل عملاء الإعلان/التطبيقات
];

/* ═══ أدوات ══════════════════════════════════════════════════════════════ */
export const bodyOf = (t) => (t.components.find((c) => c.type === "BODY") || {}).text || "";
export const footerOf = (t) => (t.components.find((c) => c.type === "FOOTER") || {}).text || "";
export const buttonsOf = (t) => (t.components.find((c) => c.type === "BUTTONS") || {}).buttons || [];
export const templateKey = (t) => `${t.name}:${t.language}`;
export const findTemplate = (name, language = "ar") =>
  TEMPLATES.find((t) => t.name === name && t.language === language) || null;

const varNums = (s) => [...String(s || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));

/* فحص قواعد ميتا — يرجّع قائمة أخطاء (فاضية = صالح) */
export function validateTemplate(t) {
  const e = [];
  if (!/^[a-z0-9_]{1,512}$/.test(t.name || "")) e.push("name: snake_case صغير فقط");
  if (!CATEGORIES.includes(t.category)) e.push(`category غير معروفة: ${t.category}`);
  if (!["ar", "en"].includes(t.language)) e.push(`language: ${t.language}`);
  const comps = t.components || [];
  const body = comps.find((c) => c.type === "BODY");
  if (!body) e.push("BODY مفقود");
  if (t.category === "AUTHENTICATION") {
    if (!body?.add_security_recommendation) e.push("auth: add_security_recommendation");
    const b = buttonsOf(t);
    if (b.length !== 1 || b[0].type !== "OTP") e.push("auth: زر OTP واحد");
    return e;
  }
  const text = body?.text || "";
  if (!text.trim()) e.push("BODY فاضي");
  if ([...text].length > 1024) e.push("BODY > 1024");
  if (/^\s*\{\{\d+\}\}/.test(text)) e.push("BODY يبدأ بمتغيّر");
  if (/\{\{\d+\}\}\s*$/.test(text)) e.push("BODY ينتهي بمتغيّر");
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) e.push("متغيّرين جنب بعض");
  if (/\n{3,}/.test(text)) e.push("أسطر فاضية كثيرة");
  const nums = varNums(text);
  const uniq = [...new Set(nums)];
  if (uniq.some((n, i) => n !== i + 1) || uniq.length !== nums.length) e.push("المتغيّرات لازم {{1}}..{{n}} بالترتيب وبدون تكرار");
  const ex = body?.example?.body_text?.[0] || [];
  if (nums.length && ex.length !== uniq.length) e.push(`أمثلة المتغيّرات ${ex.length} ≠ ${uniq.length}`);
  if (ex.some((v) => !String(v).trim() || /[\n\t]|\s{4,}/.test(String(v)))) e.push("مثال متغيّر فاضي أو فيه سطر جديد");
  // ميتا ترفض النص اللي متغيّراته كثيرة بالنسبة لطوله
  const words = text.replace(/\{\{\d+\}\}/g, " ").split(/\s+/).filter(Boolean).length;
  if (uniq.length && words < uniq.length * 3) e.push("نسبة المتغيّرات للنص عالية");
  const header = comps.find((c) => c.type === "HEADER");
  if (header) {
    if (header.format === "TEXT" && [...(header.text || "")].length > 60) e.push("HEADER > 60");
    if (header.format === "IMAGE" && !header.example?.header_handle?.length) e.push("HEADER IMAGE بدون مثال");
  }
  const footer = comps.find((c) => c.type === "FOOTER");
  if (footer) {
    if ([...(footer.text || "")].length > 60) e.push("FOOTER > 60");
    if (/\{\{/.test(footer.text || "")) e.push("FOOTER فيه متغيّر");
  }
  const btns = buttonsOf(t);
  const qrs = btns.filter((b) => b.type === "QUICK_REPLY");
  const ctas = btns.filter((b) => b.type === "URL" || b.type === "PHONE_NUMBER");
  if (qrs.length > 3) e.push("ردود سريعة > 3");
  if (ctas.length > 2) e.push("أزرار CTA > 2");
  if (btns.filter((b) => b.type === "URL").length > 2) e.push("روابط > 2");
  for (const b of btns) {
    if (!b.text || [...b.text].length > 25) e.push(`نص الزر «${b.text}» > 25`);
    if (b.type === "URL") {
      if (!/^https:\/\//.test(b.url)) e.push(`رابط غير https: ${b.url}`);
      const vn = varNums(b.url);
      if (vn.length > 1 || (vn.length && vn[0] !== 1)) e.push("الرابط: متغيّر واحد {{1}} فقط");
      if (vn.length && !/\{\{1\}\}$/.test(b.url)) e.push("الرابط: {{1}} لازم في الآخر");
      if (vn.length && !(Array.isArray(b.example) && /^https:\/\//.test(b.example[0] || ""))) e.push("الرابط: مثال كامل مطلوب");
    }
  }
  // ترتيب الأزرار: ميتا تطلب تجميع الردود السريعة مع بعض والـCTA مع بعض
  const kinds = btns.map((b) => (b.type === "QUICK_REPLY" ? "q" : "c")).join("");
  if (/q+c+q|c+q+c/.test(kinds)) e.push("الأزرار مخلوطة (لازم مجموعات)");
  if (t.category === "MARKETING") {
    if (footerOf(t) !== OPTOUT_FOOTER) e.push("التسويق: فوتر الإيقاف مطلوب");
    if (!qrs.some((b) => b.text === OPTOUT_BUTTON)) e.push("التسويق: زر «إيقاف» مطلوب");
  }
  if (t.category === "UTILITY" && /(^|[\s،.])(خصم|كود|كوبون|عرض|العرض|عروض|مجاني|مجانا)|٪|%|discount|coupon|offer|promo/i.test(text)) {
    e.push("UTILITY فيه كلام ترويجي — ميتا بتصنّفه تسويق");
  }
  if (/ستيك|steak/i.test(text)) e.push("ادعاء ستيك — مو في المنيو");
  if (/أرخص من التطبيقات|ارخص من التطبيقات/.test(text)) e.push("ادعاء «أرخص من التطبيقات» ممنوع");
  if (!t.meta?.purpose || !t.meta?.trigger || !t.meta?.send) e.push("meta: purpose/trigger/send مطلوبة");
  if (!["auto", "auto-candidate", "manual"].includes(t.meta?.send)) e.push(`meta.send: ${t.meta?.send}`);
  return e;
}

/* جسم التقديم لميتا (بدون بياناتنا) */
export function submissionBody(t) {
  return { name: t.name, language: t.language, category: t.category, components: t.components };
}

const getPath = (obj, path) => String(path || "").split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
/* ميتا ترفض قيمة فيها سطر جديد/tab/أكثر من ٤ مسافات */
export const cleanParam = (v, max = 1000) => String(v ?? "")
  .replace(/[\r\n\t]+/g, " - ").replace(/\s{4,}/g, "   ").trim().slice(0, max);
function fmtVal(v, fmt) {
  if (fmt === "firstName") {
    const w = String(v || "").trim().split(/\s+/)[0] || "";
    return w.length >= 2 && w.length <= 20 ? w : "عميلنا";
  }
  if (fmt === "money") {
    const n = Number(v);
    return Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : "";
  }
  return v;
}

/* البيانات → باراميترات الإرسال {body:[...], buttons:[{index, text}], missing:[...]}
   (نفس الترتيب اللي buildTemplatePayload في whatsapp.js يستعمله). أي متغيّر
   فاضي = missing ⇒ المُرسل لازم ما يرسل (لا نرسل «{{2}}» فاضي للعميل). */
export function bindTemplate(t, data = {}) {
  const missing = [];
  if (t.category === "AUTHENTICATION") {
    const code = cleanParam(getPath(data, "otp.code"));
    if (!code) missing.push("otp.code");
    return { body: [code], buttons: [{ index: 0, sub_type: "url", text: code }], missing };
  }
  const body = (t.meta.vars || []).map((v) => {
    const raw = fmtVal(getPath(data, v.path), v.fmt);
    const s = cleanParam(raw);
    if (!s) missing.push(v.path);
    return s;
  });
  const buttons = [];
  buttonsOf(t).forEach((b, index) => {
    if (b.type !== "URL" || !/\{\{1\}\}/.test(b.url)) return;
    const bv = (t.meta.buttonVars || []).find((x) => x.button === b.text);
    const s = cleanParam(getPath(data, bv?.path), 2000);
    if (!s) missing.push(bv?.path || `button:${index}`);
    buttons.push({ index, sub_type: "url", text: s });
  });
  return { body, buttons, missing };
}

/* معاينة النص بقيم الأمثلة (أو بيانات حقيقية) */
export function previewText(t, data = null) {
  if (t.category === "AUTHENTICATION") return "{{1}} هو رمز التحقق الخاص بك. لأمانك، لا تشاركه مع أي شخص.\nتنتهي صلاحية هذا الرمز خلال 5 دقائق.";
  const vals = data ? bindTemplate(t, data).body : (t.meta.vars || []).map((v) => v.example);
  return bodyOf(t).replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] ?? m);
}

export function summary() {
  const byCategory = {};
  for (const t of TEMPLATES) byCategory[t.category] = (byCategory[t.category] || 0) + 1;
  return {
    total: TEMPLATES.length,
    names: new Set(TEMPLATES.map((t) => t.name)).size,
    byCategory,
    byGroup: Object.fromEntries(Object.keys(GROUPS).map((g) => [g, TEMPLATES.filter((t) => t.meta.group === g).length])),
    needsUpload: TEMPLATES.filter((t) => t.meta.needsUpload).map((t) => t.name),
    invalid: TEMPLATES.map((t) => ({ key: templateKey(t), errors: validateTemplate(t) })).filter((x) => x.errors.length),
  };
}
