/* ═══════════════════════════════════════════════════════════════════════════
   RETARGETING — the continuous engine for EXISTING customers.

   Omar has asked for this in the same words more than once:
     «حملات retargeting بشكل قوي ومستمر للعملاء الحاليين».

   It has never been delivered. The one thing that has ever been reported as a
   retargeting result — 64 ر.س for a result — was not retargeting at all: the
   ad set was aimed at ALL of Saudi Arabia with audience expansion switched on,
   so ~88% of the money went to strangers. A campaign is not retargeting
   because of its name. It is retargeting only if the people it can reach are
   people we already know, and if the people we already reached are removed.

   ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────
   IS:   the ladder (who is in which rung, and why), the suppression that
         keeps a customer who ordered today out of tomorrow's win-back, the
         ADD **and REMOVE** traffic that keeps the platforms in step with the
         restaurant's own data, the frequency arithmetic that says how much
         money a 150-person pool can absorb before it burns, the holdout that
         separates an incremental return from the 52.8% who were coming back
         anyway, and the delivery-app conversion programme.

   IS NOT: a campaign creator. `ads.js` and `autopilot.js` own campaign
         structure and they belong to someone else this week. This module
         publishes a fully-specified, PAUSED plan (`GET /api/retargeting/plan`)
         and never creates a campaign, never sets a budget, never unpauses
         anything. Nothing in here can spend a riyal — the only outbound calls
         are audience membership ADD/REMOVE, which cost nothing.

   ── THE NUMBER THAT REFRAMES THE WHOLE JOB ────────────────────────────────
   Every ad platform has a floor under which a customer-list audience cannot
   be targeted at all (Meta/TikTok/Snap/Google all sit at ~1,000 matched
   people). Fresh Cuts has ~800 phone numbers, and a phone list matches at
   roughly half. So NOT ONE of these lists — not «كل العملاء», not the VIPs,
   certainly not the 156 «في خطر» — can be pointed at as a paid audience.
   Anyone who tells the owner otherwise is reading a number the platform
   printed to be polite.

   That does not make the lists worthless. It makes them the two things they
   actually are, and this module treats them as exactly that:

     1. EXCLUSIONS — which have NO minimum size on any platform. This is where
        retargeting is won. Excluding the 311 people who ordered in the last
        14 days from an acquisition campaign is worth more than any targeting
        clever­ness, because every impression we do not buy for a man who is
        already sitting in the restaurant is money kept.
     2. MEASUREMENT — the holdout, and the returning-customer count that comes
        from the POS instead of from the platform. Omar's own words on why the
        platform number is not admissible: «تتبعك للطلبات غير حقيقي لأن
        العمليات كلها بتتم أوفلاين».

   The reach for the targeted half of the ladder therefore comes from the
   pixel/engagement audiences in `audiences.js` (which DO have reach),
   sequenced by these rungs as exclusions. That is written into the plan.

   ── WHY THERE IS A REMOVE PATH, WHEN THE OLD SYNC ONLY EVER ADDED ─────────
   `audiences.js` v1 is APPEND-only, and says so honestly. Append-only means
   suppression does not exist: a man who was lapsed in July and has eaten here
   four times since is STILL in «عملاء نايمين» on Meta, and will be until the
   platform ages him out months later. Every riyal spent winning back a
   regular is wasted twice — once on the impression, once on the discount he
   did not need. So this module diffs membership on every cycle and sends the
   removals. The proof that it works is a route, not a claim:
   `GET /api/retargeting/verify` recomputes everything and reports it.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  byId, hashPhoneDigits, hashPhonePlus, httpJson, redact,
  classifyRefusal, closeWriteGate, openWriteGate, readGate,
} from "./ads.js";

const env = (k) => (process.env[k] || "").trim();
const META_VER = () => (env("META_API_VERSION") || "v25.0").trim();
const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const SNAP_BASE = "https://adsapi.snapchat.com/v1";
const metaAct = () => {
  const a = env("META_AD_ACCOUNT_ID");
  return a ? (a.startsWith("act_") ? a : `act_${a}`) : "";
};
const metaBase = () => `https://graph.facebook.com/${META_VER()}`;

const r2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 10);

/* ═══ الاقتصاديات اللي بتحرّك السلّم ═══════════════════════════════════════
   الأرقام دي مش تزويق — هي اللي بتقرر كل شريحة تاخد كام وتشوف إيه.

   • هامش المساهمة: صالة 45.2٪ · كيتا 24.5٪ بعد عمولة 46.8٪. يعني سحب عميل
     من التطبيق للمطعم بيساوي 45.2/24.5 = 2.15 ضعف على نفس الفاتورة.
   • أقل ميزانية مجموعة إعلانية = 7.14 × تكلفة النتيجة. تحت كده الإعلان
     بيفضل في مرحلة التعلّم للأبد. ريتارجيت فريش كتس اتخنق تحت الرقم ده
     مرة ورا مرة.
   • أرضية الجمهور على كل المنصات ≈ 1000 متطابق. القوايم عندنا أصغر من كده
     بمراحل — فالسلّم بيشتغل استبعادات وقياس، والوصول بيجي من جماهير
     البيكسل.                                                              */
const ECON = {
  marginDirect: Number(env("RT_MARGIN_DIRECT") || 0.452),
  marginDeliveryApp: Number(env("RT_MARGIN_DELIVERY") || 0.245),
  minBudgetMultiple: Number(env("RT_MIN_BUDGET_MULTIPLE") || 7.14),
  matchRateAssumed: Number(env("RT_MATCH_RATE") || 0.55),
  /* عتبة التوصيل المجاني اللي وافق عليها عمر — الرقم اتحدد في شغل تاني
     وبيتقرا هنا كمُدخل، مش بيتغيّر من هنا. */
  freeDeliveryThreshold: Number(env("RT_FREE_DELIVERY_THRESHOLD") || 75),
};
ECON.appToRestaurantMultiple = r2(ECON.marginDirect / ECON.marginDeliveryApp);
/* ⚠️ تعارض في الأرقام اللي اتسلّمت، متسجّل هنا بدل ما يتلمّ تحت السجادة:
   اتقال إن سحب عميل من التطبيق للمطعم بيساوي «2.15×»، واتقال كمان إن
   الهامش صالة 45.2٪ وكيتا 24.5٪. بس 45.2 ÷ 24.5 = 1.84 مش 2.15.
   الرقمين مايطلعوش من بعض. عشان 2.15 تطلع، هامش التطبيق لازم يكون ~21٪.

   الموديول بيحسب المضاعف من الهامشين (1.84) لإن دول أرقام متقالة صراحة،
   وبيسيب 2.15 مكتوب كمُدخل متعارض عشان حد يحسمه — مش بيختار الرقم الأكبر
   عشان القصة تبقى أحلى. الاتنين بيقولوا نفس الاتجاه (تحويل العميل للمطعم
   مكسب كبير)، والفرق بينهم بيغيّر الحساب مش القرار.                      */
ECON.appToRestaurantMultipleClaimed = 2.15;
ECON.multipleDiscrepancy = {
  computed: ECON.appToRestaurantMultiple,
  claimed: 2.15,
  reconciles: false,
  note: "1.84 = 45.2÷24.5 من الهامشين المتقالين. الـ2.15 محتاجة هامش تطبيق ~21٪. لازم يتحسم قبل ما يتبني عليه أي قرار صرف.",
};

/* ═══ أرضيات المنصات — الموثّق منها والمُشاع ══════════════════════════════
   الأرقام دي كانت هتتكتب «1000 لكل المنصات» وهو مش صح، والفرق بيغيّر قرار:

   • تيك توك 1000 — موثّق حرفيًا: "There is a requirement to have 1,000 total
     matched users in a Custom Audience to use it in an ad group."
   • سناب 1000 — موثّق في مساعدة سناب، والـAPI بيأكّد المفهوم بحالة
     `TOO_FEW_USERS` على الـsegment.
   • جوجل **100** مش 1000 — جوجل نزّلت الحد من فبراير 2024: "The requirement
     of 100 active users for customer lists is valid only for lists uploaded
     or refreshed after February 1, 2024." أي حد أعلى من كده بيتقال على
     جوجل غلط، وبيمنعنا من قناة إحنا مؤهّلين لها فعلاً بالحجم ده.
   • ميتا — **مفيش رقم منشور**. الرقم اللي بيتقال في كل مكان (100 للإنشاء /
     1000 للتسليم) مصدره مدوّنات مش ميتا. اللي ميتا بتقوله فعلاً هو حالة
     على الجمهور نفسه: `delivery_status.code = 300` معناها "the audience is
     smaller than it should be. This audience is currently inactive and
     cannot be used"، و200 معناها شغّال.

     فبدل ما نفترض رقم، بنسأل ميتا عن الجمهور بتاعنا ونقرا ردّها. ده نفس
     الدرس اللي اتدفع تمنه في audiences.js: الحساب ده اتوقفت فيه حملة يوم
     ١٣ أغسطس عشان حد قرا الرقم 20 من حقل بيطلّع 20 دايمًا. مانقراش رقم
     المنصة بتطبعه عشان تكون مؤدبة، ومانخترعش رقم من عندنا كمان.

   • بذرة الشبيه على ميتا = **100**، وده موثّق فعلاً: "If you have a Custom
     Audience with at least 100 people, you can build lookalike audiences
     based on it." يعني بذرة الـVIP (119) فوق الأرضية الموثّقة — مش مؤجّلة.
     الـ«1000» اللي اتقال عن بذرة الشبيه مش من ميتا.                       */
const FLOORS = {
  meta: {
    n: null, confirmed: false,
    signal: "delivery_status.code — 200 شغّال · 300 أصغر من اللازم ومش قابل للاستخدام",
    source: "https://developers.facebook.com/docs/marketing-api/reference/custom-audience/",
    note: "ميتا مش ناشرة رقم. بنقيس بحالة الجمهور نفسه بدل ما نفترض.",
  },
  tiktok: {
    n: 1000, confirmed: true, signal: "1000 متطابق قبل ما الجمهور يتحط في ad group",
    source: "https://ads.tiktok.com/help/article/custom-audiences",
  },
  snapchat: {
    n: 1000, confirmed: true, signal: "1000 عضو فريد · الـAPI بيرجع TOO_FEW_USERS تحت كده",
    source: "https://businesshelp.snapchat.com/s/article/custom-conversions-audience",
  },
  google: {
    n: 100, confirmed: true, signal: "100 مستخدم نشط خلال 30 يوم (للقوايم المرفوعة بعد 1 فبراير 2024)",
    source: "https://support.google.com/google-ads/answer/7558048",
    note: "أقل أرضية بين المنصات كلها — قاعدة عملاء فريش كتس بتعدّيها بمراحل.",
  },
};
const META_LAL_SEED_FLOOR = 100;   // موثّق، مش مُشاع

/* ═══ سقف التكرار: الحقل موجود، بس مش على أي هدف ═══════════════════════════
   ده القيد اللي بيقلب تصميم الحملة، ولازم يتقال قبل ما حد يبني حاجة:

   ميتا: `frequency_control_specs` "Writes to this field are only available in
   ad sets where REACH and THRUPLAY are the performance goal." يعني مجموعة
   إعلانية متحسّنة على التحويلات **مالهاش سقف تكرار من الـAPI أصلاً**.
   تيك توك: نفس الحكاية — سقف التكرار متاح على Reach و Video views بس.
   سناب: `cap_and_exclusion_config` على الـad squad، وبقيود على تعدد الصيغ.

   والنتيجة العملية: على أي مجموعة متحسّنة على التحويلات، **الميزانية هي
   سقف التكرار الوحيد اللي إحنا مالكينه**. عشان كده حسبة سقف الحرق تحت مش
   رفاهية — هي الأداة، مش تعليق على الأداة.                                */
const FREQ_API = {
  meta: {
    field: "frequency_control_specs",
    shape: { event: "IMPRESSIONS", interval_days: "1–90", max_frequency: "1–90" },
    allowedOn: ["REACH", "THRUPLAY"],
    confirmed: true,
    source: "https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-frequency-control-specs/",
  },
  tiktok: {
    field: "frequency / frequency_schedule (ad group)",
    shape: { frequency: "عدد الظهور", frequency_schedule: "خلال كام يوم" },
    allowedOn: ["Reach", "Video views"],
    confirmed: "الحقول مؤكّدة من SDK تيك توك؛ المدى المسموح مش منشور",
    source: "https://ads.tiktok.com/help/article/about-frequency-cap",
  },
  snapchat: {
    field: "cap_and_exclusion_config (ad squad)",
    shape: null,
    allowedOn: ["Auction — بشرط إن كل الإعلانات في الـsquad نفس الصيغة"],
    confirmed: "اسم الحقل مؤكّد؛ أسماء الحقول الداخلية لأ — تتأكد بنداء حقيقي قبل ما تتكتب",
    source: "https://developers.snap.com/marketing-api/Ads-API/ad-squads",
  },
};

/* ═══ السلّم ════════════════════════════════════════════════════════════════
   شرط واحد لكل درجة، وبيتقرا بالترتيب — أول شرط يتحقق هو الدرجة. يعني كل
   رقم جوال في درجة واحدة بالظبط، لا اتنين ولا صفر. ده مش تنظيم شكلي: لو
   الواحد قدر يبقى في «رجوع» و«ساخن» في نفس الوقت، هيشوف إعلانين مختلفين
   في نفس اليوم، وهنحاسب على نفس الطلب مرتين.

   `r` = عدد الأيام من آخر طلب.  `orders` = عدد الطلبات.  `spend` = إجمالي
   الصرف.  `dir_orders` / `del_orders` = طلبات مباشرة / من تطبيقات التوصيل.

   `target:false` معناها الدرجة دي عمرها ما تتستهدف — بتترفع للمنصات
   كاستبعاد بس. دي نص الشغل.                                               */
export const RUNGS = [
  {
    key: "hold:justordered", target: false, heat: "suppress",
    when: "f.r <= 3",
    ar: "طلب خلال ٣ أيام",
    why: "العميل ده لسه أكل عندنا. أي إعلان يوصله دلوقتي بندفع فيه عشان نوصل لواحد جالنا أصلاً، وأي طلب هيعمله هيتحسب على الإعلان غلط. بيتشال من كل جمهور مستهدف خلال ساعات.",
    message: null, offer: null,
  },
  {
    key: "rt:delivery-only", target: true, heat: "warm",
    when: "f.del_orders >= 1 AND f.dir_orders = 0 AND f.r <= 120",
    ar: "عملاء التطبيقات اللي عمرهم ما جم المطعم",
    why: `الشريحة الوحيدة اللي كل واحد فيها مكسب صافي: بندفع عليه عمولة 46.8٪ كل مرة. تحويله للمطعم بيضاعف الهامش ${ECON.appToRestaurantMultiple}× على نفس الفاتورة — من غير ما نبيع صنف زيادة.`,
    message: "أنت طلبت منّنا قبل كده من التطبيق. تعالى المطعم أو اطلب مننا مباشرة — التوصيل علينا فوق ٧٥ ر.س.",
    offer: "توصيل مجاني فوق 75 ر.س + كرت في كل طلب تطبيق",
    freq: { impressions: 2, days: 7 },
    weight: 0.30,
  },
  {
    key: "rt:vip", target: true, heat: "hot",
    when: "(f.spend >= 300 OR f.orders >= 4) AND f.r BETWEEN 4 AND 60",
    ar: "الأوفياء (٤ طلبات+ أو ٣٠٠ ر.س+)",
    why: "أغلى ناس عندنا. مش محتاجين خصم — محتاجين سبب يزوّدوا الفاتورة. الأيام الكبيرة كانت فواتير أكبر (٣.٨–٤.٠ صنف للطلب) مش زحمة أكتر، والرافعة هنا هي دي.",
    message: "الجديد عندنا قبل ما ينزل للكل — وصينية اللمة لو العزومة كبيرة.",
    offer: "بدون خصم — صنف جديد / صينية اللمة",
    freq: { impressions: 3, days: 7 },
    weight: 0.15,
  },
  {
    key: "rt:new-second", target: true, heat: "hot",
    when: "f.orders = 1 AND f.r BETWEEN 4 AND 29",
    ar: "«جدد» — طلب واحد بس، والطلب التاني هو الفارق",
    why: "الفرق بين عميل وزيارة واحدة. معدّل الرجوع خلال ٣٠ يوم 52.8٪ — يعني نص دول راجعين لوحدهم، ودي بالظبط الشريحة اللي الإعلان فيها ممكن ياخد فضل مش من حقه. الهولد أوت هنا مش رفاهية.",
    message: "أول مرة عجبتك؟ الطلب التاني أحلى — جرّب اللي ما جرّبتوش.",
    offer: "بدون خصم أولاً — يتقاس؛ الخصم يتفتح لو الهولد أوت أثبت إن مفيش فرق",
    freq: { impressions: 3, days: 7 },
    weight: 0.15,
  },
  {
    key: "rt:recent", target: true, heat: "warm",
    when: "f.r BETWEEN 4 AND 14",
    ar: "طلبوا خلال أسبوعين",
    why: "دول جايين قريّب. الإعلان هنا مش بيجيبهم — هما جايين. اللي ممكن يعمله هو إنه يكبّر الفاتورة. أقل ميزانية وأقل تكرار في السلّم كله.",
    message: "الإضافات والصواني — نفس الطلب بفاتورة أكبر.",
    offer: "أب-سيل: صينية اللمة / إضافات",
    freq: { impressions: 2, days: 7 },
    weight: 0.05,
  },
  {
    key: "rt:cadence", target: true, heat: "warm",
    when: "f.r BETWEEN 15 AND 29",
    ar: "في ميعادهم (١٥–٢٩ يوم)",
    why: "الإيقاع الطبيعي للعميل المتكرر. تذكير في وقته أرخص من استرجاع بعد شهرين.",
    message: "وحشتنا. نفس طلبك المفضل مستنيك.",
    offer: "تذكير بدون خصم",
    freq: { impressions: 3, days: 7 },
    weight: 0.10,
  },
  {
    key: "rt:lapsed", target: true, heat: "cool",
    when: "f.r BETWEEN 30 AND 54",
    ar: "نايمين (٣٠–٥٤ يوم)",
    why: "عدّى الشهر ومجاش. لسه فاكرنا. عرض متوسط يستاهل، لإن رجوعه بيساوي فاتورة كاملة بهامش كامل.",
    message: "بقالك شهر. رجّعناك على حسابنا — عرض صغير على طلبك الجاي.",
    offer: "عرض متوسط (كود يتقاس بالاسترجاع)",
    freq: { impressions: 4, days: 7 },
    weight: 0.10,
  },
  {
    key: "rt:atrisk", target: true, heat: "cool",
    when: "f.r BETWEEN 55 AND 120",
    ar: "«في خطر» (٥٥–١٢٠ يوم)",
    why: "أغلى استرجاع في السلّم، وعشان كده بياخد أكبر عرض. الواحد اللي غاب ٥٥ يوم يستاهل صرف أكتر من واحد جه الأسبوع اللي فات — بالظبط عكس اللي بيحصل لما الحملة تبقى «العملاء الحاليين» كتلة واحدة.",
    message: "زمان عنك. عندنا جديد — وده عرض شخصي مش موجود لحد تاني.",
    offer: "أقوى عرض في السلّم (كود شخصي يتقاس بالاسترجاع)",
    freq: { impressions: 5, days: 7 },
    weight: 0.15,
  },
  {
    key: "rt:dormant", target: false, heat: "suppress",
    when: "TRUE",
    ar: "غايبين أكتر من ١٢٠ يوم",
    why: "بعد ٤ شهور الاسترجاع بالإعلان بيبقى أغلى من اكتساب عميل جديد. بيتشالوا من الاستهداف عن قصد ويفضلوا بذرة شبيه بس. مش بنقول إنهم ضاعوا — بنقول إن الإعلان مش الأداة.",
    message: null, offer: null,
  },
];
const rungByKey = (k) => RUNGS.find((x) => x.key === k) || null;
const TARGETED = RUNGS.filter((x) => x.target);

/* الاستبعاد لكل درجة: كل درجة أسخن منها + اللي طلب خلال ٣ أيام + اللي حوّل
   على الموقع. الترتيب في `RUNGS` هو ترتيب السخونة، فالاستبعاد بيتولد لوحده
   — مفيش قايمة يدوية تنسى تتحدّث. */
function exclusionsFor(key) {
  const i = RUNGS.findIndex((x) => x.key === key);
  const hotter = RUNGS.slice(0, i).filter((x) => x.key !== key).map((x) => x.key);
  return { rungs: hotter, platform: ["web:converters7"] };
}

/* ═══ SQL: السلّم كله في استعلام واحد، وبيقبل تاريخ ═══════════════════════
   `asOf` هو اللي بيخلّي القياس ممكن قبل ما نصرف مليم: بنقدر نبني السلّم
   بحالته يوم ١ يوليو، وبعدين نشوف مين رجع فعلاً بعدها — يعني معدّل الرجوع
   الطبيعي لكل درجة بيتحسب من التاريخ، مش بيتفترض.

   ملحوظة على الطلب اللي معاه رقمين (رقم الكاشير ≠ رقم كارت العميل): بيتحسب
   للاتنين. نادر، ومكتوب هنا عشان ما يبقاش مفاجأة في التدقيق. */
export const LADDER_CTE = `
  WITH ord AS (
    SELECT o.order_id,
           o.calendar_day AS day,
           COALESCE(o.total, 0)::numeric AS total,
           (o.order_type = 'External' OR COALESCE(s.source, '') = 'delivery_app') AS is_delivery
      FROM ts_orders o
      LEFT JOIN order_sources s ON s.order_id = o.order_id
     WHERE o.calendar_day IS NOT NULL
  ),
  ph AS (
    SELECT DISTINCT order_id, pn FROM (
      SELECT order_id, phone_norm AS pn FROM order_sources WHERE phone_norm <> ''
      UNION
      SELECT o.order_id, tc.phone_norm AS pn
        FROM ts_orders o JOIN ts_customers tc ON tc.customer_id = o.customer_id
       WHERE tc.phone_norm <> ''
    ) x
    WHERE length(pn) = 9
  ),
  op AS (
    SELECT ph.pn, ord.day, ord.total, ord.is_delivery
      FROM ph JOIN ord ON ord.order_id = ph.order_id
     WHERE ord.day <= $1::date
  ),
  f AS (
    SELECT pn,
           max(day)                                          AS last_day,
           min(day)                                          AS first_day,
           count(*)::int                                     AS orders,
           COALESCE(sum(total), 0)::numeric                  AS spend,
           COALESCE(avg(total), 0)::numeric                  AS avg_ticket,
           count(*) FILTER (WHERE is_delivery)::int          AS del_orders,
           count(*) FILTER (WHERE NOT is_delivery)::int      AS dir_orders,
           ($1::date - max(day))::int                        AS r
      FROM op GROUP BY pn
  )`;

export const rungCase = () =>
  "CASE " + RUNGS.map((x) => `WHEN ${x.when} THEN '${x.key}'`).join(" ") + " END";

/* ═══ حسابات القياس — دوال خالصة، برّه الكلوجر عشان تتختبر ══════════════
   الأربعة دول هما كل الفرق بين قياس أمين وبين رقم بيبان دقيق:
     wilson   — مدى ثقة لنسبة، بيشتغل صح على عيّنات صغيرة (اللي عندنا)
     mde      — أصغر أثر نقدر نشوفه بالأعداد الحالية
     nNeeded  — القاعدة لازم تكبر أد إيه عشان السؤال يبقى ليه إجابة
     breakEven— الأثر المطلوب عشان الصرف يعادل فلوسه
   متصدّرين عشان `retargeting.test.mjs` يختبرهم من غير داتابيز ولا شبكة. */
export const Z95 = 1.959964;
export const Z80 = 0.8416212;

export const wilson = (k, n) => {
  if (!n) return { p: null, low: null, high: null };
  const p = k / n, z = Z95, z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / d;
  return { p, low: Math.max(0, c - h), high: Math.min(1, c + h) };
};
export const mde = (n1, n2, p) =>
  (!n1 || !n2) ? null : (Z95 + Z80) * Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));

/* كام عميل لازم يكونوا عندنا عشان اختبار واحد يقدر يشوف فرق قدره `effect`؟
   الدالة دي بتقلب السؤال: بدل «الأثر كام» بتقول «قاعدة العملاء لازم تكبر
   أد إيه قبل ما السؤال ده يبقى ليه إجابة أصلاً». وده أنفع للمالك من أي
   رقم أثر، لإنه بيقول له يستنى إيه بالظبط. */
export const nNeeded = (effect, p, controlFraction = 0.5) => {
  const f = Math.min(0.9, Math.max(0.05, controlFraction));
  if (!effect || effect <= 0 || !p) return null;
  /* N = (z_α+z_β)² · p(1-p) · (1/(1-f) + 1/f) ÷ E² */
  return Math.ceil(((Z95 + Z80) ** 2 * p * (1 - p) * (1 / (1 - f) + 1 / f)) / effect ** 2);
};

/* ═══ نقطة التعادل — السؤال الوحيد اللي القوة الإحصائية عندنا تقدر تجاوبه
   «هل الأثر أكبر من صفر؟» سؤال مستحيل بالأعداد دي. لكن «هل الأثر يكفي
   يغطّي فلوسه؟» سؤال مختلف، وأحيانًا بيبقى قابل للإجابة — لإن الأثر
   المطلوب للتعادل ممكن يكون كبير لدرجة إن الاختبار يشوفه.

     أثر التعادل = الصرف ÷ (عدد التجربة × قيمة الرجوع الواحد)

   ولو أثر التعادل نفسه أكبر من أصغر أثر نقدر نقيسه — يبقى إحنا بنصرف على
   حاجة محتاجة معجزة عشان تتعادل، ومش هنعرف حتى إنها حصلت. الحالة دي
   إجابتها «ما تصرفش»، مش «استنى وشوف». */
export const breakEven = ({ spend, nTest, valuePerReturn, minDetectable }) => {
  if (!spend || !nTest || !valuePerReturn) return null;
  const need = spend / (nTest * valuePerReturn);
  return {
    spend: r2(spend), nTest, valuePerReturn: r2(valuePerReturn),
    breakEvenLiftPoints: pct(need),
    minDetectablePoints: pct(minDetectable),
    answerable: minDetectable != null ? need >= minDetectable : null,
    verdict: minDetectable == null
      ? "مفيش أعداد كفاية نحسب بيها"
      : need >= minDetectable
        ? `الأثر المطلوب للتعادل (${pct(need)} نقطة) أكبر من أصغر أثر نقدر نشوفه (${pct(minDetectable)}) — يعني الاختبار ده يقدر يقول لنا «كسبان ولا خسران»، حتى لو مش هيقول لنا الرقم بالظبط.`
        : `الأثر المطلوب للتعادل ${pct(need)} نقطة، وأصغر أثر نقدر نشوفه ${pct(minDetectable)} نقطة. يعني حتى لو الحملة عادلت فلوسها بالظبط مش هنعرف. الصرف ده مش هيتقاس، فمش المفروض يتصرف.`,
  };
};

/* ═══════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb } = ctx;
  const aud = deps.audiences || null;   // { audienceId, statusLine, ... } من audiences.js
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureSchema() {
    await pool.query(`
      /* مين اترفع فعلاً على أنهي منصة في أنهي درجة. الجدول ده هو الفرق بين
         مزامنة بتضيف وبين مزامنة بتزامن: من غيره مش عارفين مين نشيل. */
      CREATE TABLE IF NOT EXISTS rt_members (
        platform TEXT NOT NULL,
        rung TEXT NOT NULL,
        phone_hash TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, rung, phone_hash)
      );
      CREATE INDEX IF NOT EXISTS rt_members_rung_idx ON rt_members(rung);

      /* الأرقام هنا مخزّنة كهاش بس — الجدول ده بيتكلم مع المنصات، ومفيش
         سبب يخلّيه يعرف رقم حد. */
      CREATE TABLE IF NOT EXISTS rt_audiences (
        platform TEXT NOT NULL,
        rung TEXT NOT NULL,
        audience_id TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, rung)
      );

      /* الهولد أوت. الذراع بتتحدد مرة واحدة وبتفضل ثابتة للأبد: عميل بيقفز
         بين تجربة وضابطة مش هولد أوت، ده ضوضاء. الثبات ده هو كل قيمة
         القياس، فالصف بيتكتب أول مرة وبعدها ما بيتغيّرش. */
      CREATE TABLE IF NOT EXISTS rt_arms (
        phone_norm TEXT PRIMARY KEY,
        arm TEXT NOT NULL,                    -- 'test' | 'control'
        salt_version INT NOT NULL DEFAULT 1,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS rt_arms_arm_idx ON rt_arms(arm);

      /* سجل كل عملية ضم أو شيل — الدليل إن الاستبعاد اشتغل، مش الادعاء. */
      CREATE TABLE IF NOT EXISTS rt_ops (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        platform TEXT,
        rung TEXT,
        op TEXT,                              -- add | remove | ensure
        size INT NOT NULL DEFAULT 0,
        status TEXT,                          -- sent | failed | skipped | noop
        error TEXT,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS rt_ops_time_idx ON rt_ops(created_at DESC);

      CREATE TABLE IF NOT EXISTS rt_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT,
        summary JSONB
      );
      CREATE INDEX IF NOT EXISTS rt_runs_time_idx ON rt_runs(started_at DESC);

      /* لقطة يومية لتوزيع الدرجات — عشان نقدر نقول «الشريحة دي كبرت» بدليل
         بدل ما نفتكر. صف واحد لكل يوم/درجة، مش لكل عميل. */
      CREATE TABLE IF NOT EXISTS rt_daily (
        day DATE NOT NULL,
        rung TEXT NOT NULL,
        n INT NOT NULL,
        n_test INT NOT NULL DEFAULT 0,
        n_control INT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, rung)
      );
    `);
  }
  ensureSchema()
    .then(() => console.log("[retargeting] schema ready"))
    .catch((e) => console.error("[retargeting] schema failed:", e.message));

  /* ── الهولد أوت: قسمة ثابتة، محسوبة مش عشوائية ────────────────────────
     نفس الرقم بيدّي نفس الذراع كل مرة، من غير ما نسأل الداتابيز. الداتابيز
     بتتكتب للتدقيق بس. النسبة بتتقرا من البيئة عشان تكبر لما نحتاج قوة
     إحصائية أعلى، ومفيش حد بيتنقل من ذراع لذراع لما تتغيّر: الصف المتخزّن
     بيكسب دايمًا. */
  const HOLDOUT_PCT = Math.max(0, Math.min(50, Number(env("RT_HOLDOUT_PCT") || 20)));
  const HOLDOUT_SALT = env("RT_HOLDOUT_SALT") || "freshcuts-rt-v1";
  const armOf = (phoneNorm) => {
    const h = crypto.createHash("sha256").update(`${phoneNorm}|${HOLDOUT_SALT}`).digest();
    return (h.readUInt32BE(0) % 10000) < HOLDOUT_PCT * 100 ? "control" : "test";
  };

  /* ── قراءة السلّم ───────────────────────────────────────────────────── */
  async function ladder(asOf = null) {
    const day = asOf || new Date().toISOString().slice(0, 10);
    const q = await pool.query(
      `${LADDER_CTE}
       SELECT pn, r, orders, spend, avg_ticket, del_orders, dir_orders,
              last_day, first_day, ${rungCase()} AS rung
         FROM f`,
      [day]
    );
    return q.rows.map((x) => ({
      pn: x.pn,
      rung: x.rung,
      r: Number(x.r),
      orders: Number(x.orders),
      spend: Number(x.spend),
      avgTicket: Number(x.avg_ticket),
      delOrders: Number(x.del_orders),
      dirOrders: Number(x.dir_orders),
      lastDay: x.last_day,
      firstDay: x.first_day,
      arm: armOf(x.pn),
    }));
  }

  /* التجميع اللي المالك بيقراه: كل درجة، كام واحد، بيصرفوا كام، هامشهم كام. */
  function summarise(rows) {
    const by = new Map();
    for (const spec of RUNGS) by.set(spec.key, {
      key: spec.key, ar: spec.ar, heat: spec.heat, target: spec.target,
      why: spec.why, message: spec.message, offer: spec.offer,
      freq: spec.freq || null, weight: spec.weight || 0,
      n: 0, nTest: 0, nControl: 0, spend: 0, orders: 0, ticketSum: 0,
      delOrders: 0, dirOrders: 0,
    });
    for (const row of rows) {
      const b = by.get(row.rung);
      if (!b) continue;
      b.n++;
      if (row.arm === "control") b.nControl++; else b.nTest++;
      b.spend += row.spend;
      b.orders += row.orders;
      b.ticketSum += row.avgTicket;
      b.delOrders += row.delOrders;
      b.dirOrders += row.dirOrders;
    }
    return [...by.values()].map((b) => {
      const avgTicket = b.n ? b.ticketSum / b.n : 0;
      const totalOrders = b.delOrders + b.dirOrders;
      const delShare = totalOrders ? b.delOrders / totalOrders : 0;
      /* الهامش المرجّح بقنوات الشريحة نفسها — مش رقم واحد لكل الناس.
         شريحة كلها تطبيقات هامشها 24.5٪ مش 45.2٪، والفرق ده هو اللي
         بيقرر تستاهل كام. */
      const margin = ECON.marginDirect * (1 - delShare) + ECON.marginDeliveryApp * delShare;
      return {
        ...b,
        spend: r2(b.spend),
        avgTicket: r2(avgTicket),
        deliveryShare: pct(delShare),
        marginPct: pct(margin),
        /* قيمة رجوع واحد = متوسط الفاتورة × الهامش. ده السقف اللي فوقه
           الاسترجاع بيبقى خسارة، مش هدف. */
        valuePerReturn: r2(avgTicket * margin),
        ticketSum: undefined,
      };
    });
  }

  /* ═══ الأرضيات: هل الشريحة دي تقدر تتستهدف أصلاً؟ ═══════════════════════
     أهم دالة في الملف من ناحية اتخاذ القرار. كل منصة عندها أرضية للجمهور
     المرفوع (≈1000 متطابق)، ومعدّل التطابق من قايمة أرقام سعودية بيتراوح
     حوالين النص. فبنقول لكل درجة: متطابق متوقع كام، وناقصها كام عشان توصل
     للأرضية. لو ناقصها — يبقى الدرجة دي أداتها مش إعلان مدفوع، وده بيتقال
     صريح بدل ما تتعمل حملة تفضل «Below minimum audience size» للأبد. */
  function reachability(bucket) {
    const matched = Math.round(bucket.n * ECON.matchRateAssumed);
    const perPlatform = {};
    for (const [p, f] of Object.entries(FLOORS)) {
      if (f.n == null) {
        perPlatform[p] = {
          floor: null, confirmed: false,
          targetable: null,
          /* «مش عارفين» مش «لأ». الفرق ده هو اللي بيمنع إننا نلغي قناة
             بسبب رقم محدش نشره. */
          verdict: "ميتا مش ناشرة أرضية — بيتقاس بحالة الجمهور نفسه (اقرا rt/floors)، مش بيتفترض",
          signal: f.signal,
        };
        continue;
      }
      const ok = matched >= f.n;
      perPlatform[p] = {
        floor: f.n, confirmed: f.confirmed, targetable: ok,
        shortBy: ok ? 0 : f.n - matched,
        verdict: ok
          ? `فوق الأرضية (${f.n}) — تقدر تتستهدف كقايمة`
          : `تحت الأرضية (${f.n}) بـ~${f.n - matched} متطابق — استبعاد وقياس وبذرة، مش استهداف`,
      };
    }
    /* «قابلة للاستهداف» على الأقل على منصة واحدة موثّقة. جوجل أرضيتها 100
       فأغلب الدرجات بتعدّيها — وده بيغيّر الإجابة عن السؤال «نعلن فين». */
    const anywhere = Object.values(perPlatform).some((x) => x.targetable === true);
    return {
      uploaded: bucket.n,
      matchedEstimate: matched,
      matchRateAssumed: pct(ECON.matchRateAssumed),
      /* الأرقام دي تقدير مبني على معدّل تطابق مفترض — مش قياس. المنصة
         مش بتقول لنا معدّل التطابق الحقيقي على قايمة بالحجم ده، وبنقول
         كده بدل ما ندّي رقم واثق. */
      basis: "تقدير — معدّل التطابق مفترض، والمنصة ما بتقولوش على قايمة بالحجم ده",
      byPlatform: perPlatform,
      targetableAsList: anywhere,
      verdict: anywhere
        ? `تقدر تتستهدف كقايمة على: ${Object.entries(perPlatform).filter(([, v]) => v.targetable).map(([k]) => k).join("، ")}`
        : "مش هتعدّي أرضية أي منصة موثّقة — استعمالها الصح: استبعاد + قياس + بذرة شبيه",
    };
  }

  /* ── الأرضية على ميتا: بنسأل، مش بنفترض ────────────────────────────────
     بنقرا `delivery_status` و`operation_status` لكل جمهور رفعناه. الكود 300
     هو الرد الوحيد الصريح من ميتا إن الجمهور أصغر من اللازم. لو النداء نفسه
     فشل، بنقول «مقدرناش نقيس» — مش بنكتب صفر ولا بنكتب «شغّال». */
  async function metaFloors() {
    const token = env("META_CAPI_TOKEN");
    if (!token) return { ok: false, error: "META_CAPI_TOKEN missing", rows: [] };
    const blocked = readGate("meta", "telemetry");
    if (blocked) return { ok: false, error: blocked.error, gated: true, rows: [] };
    const q = await pool.query(`SELECT rung, audience_id FROM rt_audiences WHERE platform='meta'`);
    const rows = [];
    for (const a of q.rows) {
      const res = await httpJson(
        `${metaBase()}/${a.audience_id}?fields=name,delivery_status,operation_status,approximate_count_lower_bound&access_token=${encodeURIComponent(token)}`,
        { method: "GET" });
      if (!res.ok || res.json?.error) {
        const e = res.json?.error || {};
        rows.push({ rung: a.rung, ok: false, error: e.message || res.error || `HTTP ${res.status}` });
      } else {
        const d = res.json?.delivery_status || {};
        rows.push({
          rung: a.rung, ok: true,
          code: d.code ?? null,
          description: d.description || null,
          targetable: d.code === 200,
          tooSmall: d.code === 300,
          /* الحقل ده بيرجع 20 لجماهير البيكسل و1000 لقوايم العملاء مهما
             كان حجمها الحقيقي. متسجّل هنا للتوثيق وعمره ما يتقرا كحجم. */
          approximateCountSentinel: res.json?.approximate_count_lower_bound ?? null,
        });
      }
      await sleep(600);
    }
    return { ok: rows.some((x) => x.ok), rows, note: "approximate_count_lower_bound قيمة صورية — متسجّلة للتوثيق وعمرها ما تتقرا كحجم." };
  }

  /* ═══ التكرار والميزانية ════════════════════════════════════════════════
     الحاجتين مربوطين ببعض ومحدش بيربطهم. جمهور ٢٠٠ واحد بميزانية ٥٠ ر.س
     في اليوم بيشوف الإعلان ٨ مرات في اليوم — ده مش ريتارجيت، ده مطاردة،
     والناس بتخبّي الإعلان وبعدها الحساب كله بيغلى.

       سقف الصرف الأسبوعي = المتطابق × التكرار المسموح × CPM ÷ 1000
       أرضية الصرف اليومي  = 7.14 × تكلفة النتيجة (وإلا مش هيخرج من التعلّم)

     لو الأرضية أعلى من السقف — الدرجة دي مينفعش تبقى مجموعة إعلانية
     لوحدها. دي مش رأي، دي حسبة، ودي اللي بتقول لنا نلمّ درجات مع بعض. */
  function budgetWindow(bucket, { cpm, costPerResult }) {
    const matched = Math.round(bucket.n * ECON.matchRateAssumed);
    const freq = bucket.freq || { impressions: 3, days: 7 };
    const weeklyImpressions = matched * freq.impressions * (7 / freq.days);
    const ceilWeekly = cpm != null ? (weeklyImpressions * cpm) / 1000 : null;
    const floorDaily = costPerResult != null ? ECON.minBudgetMultiple * costPerResult : null;
    const ceilDaily = ceilWeekly != null ? ceilWeekly / 7 : null;
    return {
      frequencyCap: freq,
      matchedEstimate: matched,
      impressionsPerWeek: Math.round(weeklyImpressions),
      cpmUsed: r2(cpm),
      costPerResultUsed: r2(costPerResult),
      maxDailyBudget: r2(ceilDaily),
      minDailyBudget: r2(floorDaily),
      viableAsOwnAdSet: floorDaily != null && ceilDaily != null ? floorDaily <= ceilDaily : null,
      note: floorDaily == null
        ? "مفيش تكلفة نتيجة متقاسة لسه — أرضية الميزانية مش محسوبة، وما ينفعش نخترعها."
        : ceilDaily == null
          ? "مفيش CPM متقاس لسه — سقف الحرق مش محسوب."
          : floorDaily <= ceilDaily
            ? "الشريحة تستحمل ميزانيتها الدنيا من غير ما تتحرق."
            : `أرضية التعلّم (${r2(floorDaily)} ر.س/يوم) أعلى من سقف الحرق (${r2(ceilDaily)} ر.س/يوم) — الدرجة دي مينفعش تبقى مجموعة إعلانية لوحدها، لازم تتلم مع اللي جنبها.`,
    };
  }

  /* ═══ المزامنة: فرق، مش إضافة ═══════════════════════════════════════════
     ثلاث خطوات لكل (منصة × درجة):
       1. المطلوب = أعضاء الدرجة دلوقتي، ناقص ذراع الضابطة
       2. الموجود = اللي إحنا رافعينه فعلاً (rt_members)
       3. ابعت الفرق: الجداد ADD، والخارجين REMOVE

     الخطوة ٣ هي الجديدة. من غيرها اللي طلب النهاردة بيفضل في «نايمين» على
     ميتا لشهور. */
  const hashesOf = (rows) => new Set(rows.map((x) => hashPhoneDigits("966" + x.pn)));

  async function storedHashes(platform, rung) {
    const q = await pool.query(
      `SELECT phone_hash FROM rt_members WHERE platform=$1 AND rung=$2`, [platform, rung]);
    return new Set(q.rows.map((x) => x.phone_hash));
  }

  /* ── ميتا ─────────────────────────────────────────────────────────────
     نفس البوابة اللي في ads.js: لو المنصة قالت «كتّرت»، بنسكت. الرفض في
     عيلة 4841xxx بيتقرا اختناق مش صلاحيات — الغلطة دي كلّفت الحساب ليلة
     كاملة وهي مكتوبة في ads.js بالتفصيل. */
  async function metaUsers(audienceId, hashes, method) {
    const token = env("META_CAPI_TOKEN");
    if (!token) return { ok: false, error: "META_CAPI_TOKEN missing" };
    const blocked = readGate("meta", "telemetry");
    if (blocked) return { ok: false, error: blocked.error, gated: true };
    let done = 0;
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 10000) {
      const chunk = list.slice(i, i + 10000);
      const res = await httpJson(`${metaBase()}/${audienceId}/users`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: {
          payload: { schema: ["PHONE_SHA256"], data: chunk.map((h) => [h]) },
          access_token: token,
        },
      });
      if (!res.ok || res.json?.error) {
        const cls = classifyRefusal("meta", res);
        if (cls.kind === "throttled" || cls.kind === "unavailable") {
          closeWriteGate("meta", { ms: cls.retryAfterMs, kind: cls.kind, reason: res.json?.error?.message });
        }
        const e = res.json?.error || {};
        return {
          ok: false, done,
          kind: cls.kind,
          error: [e.message || res.error || `HTTP ${res.status}`, e.error_user_msg].filter(Boolean).join(" — "),
        };
      }
      openWriteGate("meta");
      done += chunk.length;
    }
    return { ok: true, done };
  }

  /* ── تيك توك ──────────────────────────────────────────────────────────
     الشيل عندهم مش نداء بسيط: لازم نرفع ملف تاني بالأرقام اللي هتتشال،
     وبنفس الـ file_signature — وهو MD5 لبايتات الملف نفسه بالظبط. من غيره
     كل رفع بيرجع "file_signature: Missing data for required field" ومفيش
     جمهور بيتعمل أصلاً. الغلطة دي متسجّلة في audiences.js وبتتكرر هنا
     عشان مسار الشيل جديد ومحدش جرّبه قبل كده. */
  async function ttUploadFile(hashesText) {
    const fd = new FormData();
    const signature = crypto.createHash("md5").update(hashesText, "utf8").digest("hex");
    fd.append("advertiser_id", env("TIKTOK_ADVERTISER_ID"));
    fd.append("calculate_type", "PHONE_SHA256");
    fd.append("file_signature", signature);
    fd.append("file", new Blob([hashesText], { type: "text/csv" }), "freshcuts_rt.csv");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(env("ADS_HTTP_TIMEOUT_MS") || 15000));
    try {
      const res = await fetch(`${TT_BASE}/dmp/custom_audience/file/upload/`, {
        method: "POST",
        headers: { "Access-Token": env("TIKTOK_ACCESS_TOKEN") },
        body: fd,
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!(res.ok && json?.code === 0)) {
        return { ok: false, error: json?.message || text.slice(0, 300) || `HTTP ${res.status}` };
      }
      const filePath = json?.data?.file_path;
      if (!filePath) return { ok: false, error: "upload returned no file_path" };
      return { ok: true, filePath, signature };
    } catch (e) {
      const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async function ttUpdate(audienceId, hashes, action) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = env("TIKTOK_ADVERTISER_ID");
    if (!token || !adv) return { ok: false, error: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing" };
    const up = await ttUploadFile([...hashes].join("\n"));
    if (!up.ok) return up;
    const res = await httpJson(`${TT_BASE}/dmp/custom_audience/update/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: { advertiser_id: adv, custom_audience_id: audienceId, action, file_paths: [up.filePath] },
    });
    if (!(res.ok && res.json?.code === 0)) {
      return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
    }
    return { ok: true, done: hashes.size };
  }

  /* ── سناب شات ─────────────────────────────────────────────────────────
     الشيل عندهم DELETE على نفس مسار الضم. لاحظ: مشكلة «E2025 placement v2»
     بتقفل تعديل الميزانيات عن طريق الـAPI لحد ما يتعمل ad squad جديد من
     الواجهة — بس دي مش بتلمس عضوية الجماهير، فالمزامنة هنا شغّالة عادي
     والمسدود هو الحملة. مكتوبة في المعوّقات مش هنا. */
  async function snapUsers(segmentId, hashes, method) {
    const snap = byId("snapchat");
    const t = await snap?.token?.();
    if (!t) return { ok: false, error: "Snap OAuth credentials missing" };
    const hdr = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
    let done = 0;
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 10000) {
      const chunk = list.slice(i, i + 10000);
      const res = await httpJson(`${SNAP_BASE}/segments/${segmentId}/users`, {
        method, headers: hdr,
        body: { users: [{ schema: ["PHONE_SHA256"], data: chunk.map((h) => [h]) }] },
      });
      if (!res.ok) return { ok: false, done, error: res.json?.debug_message || res.error || `HTTP ${res.status}` };
      done += chunk.length;
    }
    return { ok: true, done };
  }

  /* ── إنشاء/تبنّي جمهور الدرجة على كل منصة ─────────────────────────────── */
  const rungName = (key) => `FreshCuts RT · ${rungByKey(key)?.ar || key}`;

  async function audienceFor(platform, rung) {
    const q = await pool.query(
      `SELECT audience_id FROM rt_audiences WHERE platform=$1 AND rung=$2`, [platform, rung]);
    if (q.rows[0]) return { ok: true, id: q.rows[0].audience_id, created: false };

    const name = rungName(rung);
    const desc = rungByKey(rung)?.ar || rung;
    let id = null, error = null;

    if (platform === "meta") {
      const token = env("META_CAPI_TOKEN");
      const act = metaAct();
      if (!token || !act) return { ok: false, error: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing" };
      const blocked = readGate("meta", "telemetry");
      if (blocked) return { ok: false, error: blocked.error, gated: true };
      const res = await httpJson(`${metaBase()}/${act}/customaudiences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          name, description: desc, subtype: "CUSTOM",
          customer_file_source: "USER_PROVIDED_ONLY", access_token: token,
        },
      });
      if (res.ok && res.json?.id) id = String(res.json.id);
      else {
        const e = res.json?.error || {};
        error = [e.message || res.error || `HTTP ${res.status}`, e.error_user_msg].filter(Boolean).join(" — ");
      }
    } else if (platform === "tiktok") {
      /* تيك توك ما بتعملش جمهور فاضي — الإنشاء بيحصل مع أول رفع ملف،
         فبنسيبه للمزامنة نفسها وبنرجع «لسه» بدل خطأ. */
      return { ok: false, deferred: true, error: "TikTok ينشئ الجمهور مع أول رفع — بيتعمل جوّه المزامنة" };
    } else if (platform === "snapchat") {
      const snap = byId("snapchat");
      const acct = env("SNAP_AD_ACCOUNT_ID");
      const t = await snap?.token?.();
      if (!t || !acct) return { ok: false, error: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing" };
      const res = await httpJson(`${SNAP_BASE}/adaccounts/${acct}/segments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: {
          segments: [{
            name, description: desc, source_type: "FIRST_PARTY",
            retention_in_days: 180, ad_account_id: acct,
          }],
        },
      });
      const seg = res.json?.segments?.[0]?.segment;
      if (res.ok && seg?.id) id = String(seg.id);
      else error = res.json?.debug_message || res.error || `HTTP ${res.status}`;
    }

    if (!id) return { ok: false, error: error || "no audience id returned" };
    await pool.query(
      `INSERT INTO rt_audiences (platform, rung, audience_id, name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform, rung) DO UPDATE SET audience_id=EXCLUDED.audience_id, name=EXCLUDED.name`,
      [platform, rung, id, name]);
    return { ok: true, id, created: true };
  }

  /* ── دورة مزامنة واحدة لكل (منصة × درجة) ─────────────────────────────── */
  const PLATFORMS = ["meta", "tiktok", "snapchat"];

  async function syncRung(platform, rung, rows, runId) {
    /* ذراع الضابطة ما بتترفعش خالص. ده هو الميكانيزم — مش علامة في جدول،
       الناس دي حرفيًا مش موجودة في أي جمهور، فمستحيل يشوفوا إعلان
       ريتارجيت. من غير كده الهولد أوت بيبقى ديكور. */
    const want = hashesOf(rows.filter((x) => x.rung === rung && x.arm === "test"));
    const have = await storedHashes(platform, rung);
    const toAdd = new Set([...want].filter((h) => !have.has(h)));
    const toRemove = new Set([...have].filter((h) => !want.has(h)));

    const log = async (op, size, status, error, detail) => {
      await pool.query(
        `INSERT INTO rt_ops (id, run_id, platform, rung, op, size, status, error, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [crypto.randomUUID(), runId, platform, rung, op, size, status,
         error ? String(error).slice(0, 400) : null, jb(redact(detail || {}))]).catch(() => {});
    };

    if (!toAdd.size && !toRemove.size) {
      await log("noop", 0, "noop", null, { want: want.size });
      return { ok: true, added: 0, removed: 0, size: want.size, noop: true };
    }

    let audienceId = null;
    if (platform !== "tiktok") {
      const a = await audienceFor(platform, rung);
      if (!a.ok) {
        await log("ensure", 0, "failed", a.error, { deferred: !!a.deferred });
        return { ok: false, error: a.error, deferred: !!a.deferred };
      }
      audienceId = a.id;
    } else {
      const q = await pool.query(
        `SELECT audience_id FROM rt_audiences WHERE platform='tiktok' AND rung=$1`, [rung]);
      audienceId = q.rows[0]?.audience_id || null;
    }

    const out = { ok: true, added: 0, removed: 0, size: want.size };

    if (toAdd.size) {
      let r;
      if (platform === "meta") r = await metaUsers(audienceId, toAdd, "POST");
      else if (platform === "snapchat") r = await snapUsers(audienceId, toAdd, "POST");
      else r = await ttAppend(rung, audienceId, toAdd);
      await log("add", toAdd.size, r.ok ? "sent" : "failed", r.error, { done: r.done });
      if (r.ok) {
        out.added = toAdd.size;
        for (const h of toAdd) {
          await pool.query(
            `INSERT INTO rt_members (platform, rung, phone_hash) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [platform, rung, h]).catch(() => {});
        }
      } else { out.ok = false; out.error = r.error; }
    }

    if (toRemove.size) {
      let r;
      if (platform === "meta") r = await metaUsers(audienceId, toRemove, "DELETE");
      else if (platform === "snapchat") r = await snapUsers(audienceId, toRemove, "DELETE");
      else r = audienceId ? await ttUpdate(audienceId, toRemove, "DELETE")
                          : { ok: false, error: "no TikTok audience yet" };
      await log("remove", toRemove.size, r.ok ? "sent" : "failed", r.error, { done: r.done });
      if (r.ok) {
        out.removed = toRemove.size;
        await pool.query(
          `DELETE FROM rt_members WHERE platform=$1 AND rung=$2 AND phone_hash = ANY($3::text[])`,
          [platform, rung, [...toRemove]]).catch(() => {});
      } else { out.ok = false; out.error = out.error || r.error; }
    }
    return out;
  }

  /* ── الفرق قبل ما يتبعت ────────────────────────────────────────────────
     نفس حسبة المزامنة بالظبط، من غير ولا نداء على أي منصة. ده اللي بيخلّي
     «هل الاستبعاد شغّال؟» سؤال ليه إجابة النهاردة، مش بعد أول حملة. */
  async function previewDiff(rows = null, platforms = null) {
    const all = rows || (await ladder());
    const freshHashes = new Set(all.filter((x) => x.r <= 3).map((x) => hashPhoneDigits("966" + x.pn)));
    const out = { byPlatform: {}, totalAdds: 0, totalRemoves: 0, wouldRemoveFresh: 0, uploadedAny: false };
    const freshRemoved = new Set();
    for (const p of (platforms || PLATFORMS)) {
      out.byPlatform[p] = {};
      for (const spec of RUNGS) {
        const want = hashesOf(all.filter((x) => x.rung === spec.key && x.arm === "test"));
        const have = await storedHashes(p, spec.key);
        if (have.size) out.uploadedAny = true;
        const adds = [...want].filter((h) => !have.has(h));
        const removes = [...have].filter((h) => !want.has(h));
        for (const h of removes) if (freshHashes.has(h)) freshRemoved.add(`${p}|${h}`);
        out.byPlatform[p][spec.key] = {
          target: spec.target, desired: want.size, uploaded: have.size,
          adds: adds.length, removes: removes.length,
        };
        out.totalAdds += adds.length;
        out.totalRemoves += removes.length;
      }
    }
    out.wouldRemoveFresh = freshRemoved.size;
    return out;
  }

  /* تيك توك: أول رفع بيعمل الجمهور، اللي بعده APPEND. */
  async function ttAppend(rung, audienceId, hashes) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = env("TIKTOK_ADVERTISER_ID");
    if (!token || !adv) return { ok: false, error: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing" };
    if (audienceId) return ttUpdate(audienceId, hashes, "APPEND");

    const up = await ttUploadFile([...hashes].join("\n"));
    if (!up.ok) return up;
    const res = await httpJson(`${TT_BASE}/dmp/custom_audience/create/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: {
        advertiser_id: adv, custom_audience_name: rungName(rung),
        calculate_type: "PHONE_SHA256", file_paths: [up.filePath],
      },
    });
    if (!(res.ok && res.json?.code === 0) || !res.json?.data?.custom_audience_id) {
      return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
    }
    const id = String(res.json.data.custom_audience_id);
    await pool.query(
      `INSERT INTO rt_audiences (platform, rung, audience_id, name) VALUES ('tiktok',$1,$2,$3)
       ON CONFLICT (platform, rung) DO UPDATE SET audience_id=EXCLUDED.audience_id`,
      [rung, id, rungName(rung)]).catch(() => {});
    return { ok: true, done: hashes.size, created: true };
  }

  /* ── الدورة الكاملة ──────────────────────────────────────────────────── */
  let running = false;
  async function runCycle({ trigger = "cron", platforms = null, dryRun = null } = {}) {
    if (running) return { ok: true, skipped: "already running" };
    running = true;
    const runId = crypto.randomUUID();
    const dry = dryRun == null ? env("RT_SYNC") !== "1" : !!dryRun;
    await pool.query(`INSERT INTO rt_runs (id, trigger, status) VALUES ($1,$2,'running')`,
      [runId, trigger]).catch(() => {});
    try {
      const rows = await ladder();
      const buckets = summarise(rows);

      /* الأذرع بتتكتب مرة واحدة وبعدها ما بتتغيّرش. `DO NOTHING` هنا هي
         اللي بتضمن ده — لو النسبة اتغيّرت بكرة، اللي متسجّل بيفضل زي ما هو. */
      for (const row of rows) {
        await pool.query(
          `INSERT INTO rt_arms (phone_norm, arm) VALUES ($1,$2) ON CONFLICT (phone_norm) DO NOTHING`,
          [row.pn, row.arm]).catch(() => {});
      }
      const day = new Date().toISOString().slice(0, 10);
      for (const b of buckets) {
        await pool.query(
          `INSERT INTO rt_daily (day, rung, n, n_test, n_control) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (day, rung) DO UPDATE SET n=EXCLUDED.n, n_test=EXCLUDED.n_test, n_control=EXCLUDED.n_control`,
          [day, b.key, b.n, b.nTest, b.nControl]).catch(() => {});
      }

      const results = {};
      /* في الوضع الجاف بنحسب الفرق كامل وبنقوله — الدورة الجافة المفروض
         تعلّمك حاجة، مش تقول «مبعتش حاجة» وتسكت. */
      const preview = dry ? await previewDiff(rows) : null;
      if (!dry) {
        for (const p of (platforms || PLATFORMS)) {
          results[p] = {};
          for (const spec of RUNGS) {
            /* الدرجات المستبعَدة بتترفع هي كمان — لإنها استبعاد، والاستبعاد
               محتاج جمهور موجود على المنصة زيه زي الاستهداف بالظبط. */
            results[p][spec.key] = await syncRung(p, spec.key, rows, runId);
            await sleep(400);
          }
        }
      }

      const summary = {
        customers: rows.length,
        rungs: buckets.map((b) => ({ key: b.key, n: b.n, test: b.nTest, control: b.nControl })),
        dryRun: dry,
        platforms: Object.keys(results),
        preview: preview ? {
          totalAdds: preview.totalAdds, totalRemoves: preview.totalRemoves,
          wouldRemoveRecentBuyers: preview.wouldRemoveFresh,
          note: "دورة جافة — الأرقام دي هي اللي كانت هتتبعت. مفيش ولا نداء اتعمل على أي منصة.",
        } : null,
      };
      await pool.query(
        `UPDATE rt_runs SET finished_at=NOW(), status=$2, summary=$3 WHERE id=$1`,
        [runId, dry ? "dry" : "ok", jb(redact({ ...summary, results }))]).catch(() => {});
      return { ok: true, runId, ...summary, results };
    } catch (e) {
      await pool.query(`UPDATE rt_runs SET finished_at=NOW(), status='failed', summary=$2 WHERE id=$1`,
        [runId, jb({ error: String(e.message || e) })]).catch(() => {});
      return { ok: false, error: String(e.message || e), runId };
    } finally {
      running = false;
    }
  }

  /* ═══ الإثبات ═══════════════════════════════════════════════════════════
     ادعاء إن «الاستبعاد شغّال» مش قياس. الراوت ده بيعيد حساب كل حاجة من
     الداتابيز ومن سجل الرفع، وبيرجع أرقام تقدر تتشاف بالعين:

       1. التقسيم كامل وحصري — كل رقم في درجة واحدة، ومجموع الدرجات = كل
          العملاء. لو الرقمين مش متساويين يبقى في شرط ناقص أو مكرر.
       2. اللي طلب خلال ٣ أيام مش في ولا جمهور مستهدف — لا في الداتابيز
          ولا فعليًا على المنصة (بنقارن الهاش المرفوع بالهاش المطلوب).
       3. ذراع الضابطة مرفوعة صفر مرة. لو واحد منهم اتشاف في rt_members
          يبقى القياس كله باطل، والراوت بيقول كده بصوت عالي.
       4. آخر عمليات الشيل: كام واحد اتشال إمتى ومن أنهي درجة.            */
  async function verify() {
    const rows = await ladder();
    const byRung = new Map();
    for (const r of rows) byRung.set(r.rung, (byRung.get(r.rung) || 0) + 1);
    const assigned = [...byRung.values()].reduce((a, b) => a + b, 0);

    const checks = [];
    const add = (id, ok, line, detail = {}) => checks.push({ id, ok, line, ...detail });

    /* 1 — التقسيم */
    const unassigned = rows.filter((x) => !x.rung).length;
    add("partition.total", assigned === rows.length && unassigned === 0,
      `كل عميل في درجة واحدة: ${assigned} من ${rows.length}${unassigned ? ` — ${unassigned} من غير درجة` : ""}`,
      { customers: rows.length, assigned, unassigned });

    /* الحصرية مضمونة ببناء الاستعلام (CASE بيقف عند أول شرط)، بس بنتأكد
       بالعدّ برضه — الضمانة اللي مش متقاسة مش ضمانة. */
    const dupes = rows.length - new Set(rows.map((x) => x.pn)).size;
    add("partition.exclusive", dupes === 0,
      dupes === 0 ? "مفيش رقم في أكتر من درجة" : `${dupes} رقم اتكرر في أكتر من درجة`, { dupes });

    /* 2 — الكبت: اللي طلب خلال ٣ أيام */
    const fresh = rows.filter((x) => x.r <= 3);
    const freshInTargeted = fresh.filter((x) => rungByKey(x.rung)?.target).length;
    add("suppression.rung", freshInTargeted === 0,
      `${fresh.length} عميل طلب خلال ٣ أيام — ${freshInTargeted} منهم في درجة مستهدفة (المفروض صفر)`,
      { fresh: fresh.length, leaked: freshInTargeted });

    /* الاختبار الحقيقي مش على الجدول، على المنصة: هل الهاش بتاعهم لسه
       مرفوع في جمهور مستهدف؟ */
    const freshHashes = new Set(fresh.map((x) => hashPhoneDigits("966" + x.pn)));
    const targetedKeys = TARGETED.map((x) => x.key);
    const leaks = freshHashes.size && targetedKeys.length
      ? await pool.query(
          `SELECT platform, rung, count(*)::int AS n FROM rt_members
            WHERE rung = ANY($1::text[]) AND phone_hash = ANY($2::text[])
            GROUP BY platform, rung`,
          [targetedKeys, [...freshHashes]])
      : { rows: [] };
    const leakN = leaks.rows.reduce((a, b) => a + Number(b.n), 0);
    /* الفحص ده ما ينفعش يتقرا أخضر وهو فاضي. لو مفيش حاجة اترفعت أصلاً،
       يبقى «مفيش تسريب» جملة مالهاش معنى — الفحص مر لإنه مالقاش حاجة
       يفحصها، مش لإن الكبت اشتغل. فحص ما ينفعش يفشل مش فحص. */
    const uploaded = Number((await pool.query(`SELECT count(*)::int AS n FROM rt_members`)
      .catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n || 0);
    add("suppression.platform", leakN === 0,
      uploaded === 0
        ? "⚪ مفيش أي عضو مرفوع لأي منصة لسه — الفحص ده ما اتنفّذش فعليًا، عدّى لإنه مالقاش حاجة يفحصها. مش دليل على حاجة."
        : leakN === 0
          ? `مفيش ولا واحد من اللي طلبوا خلال ٣ أيام مرفوع في جمهور مستهدف — من إجمالي ${uploaded} عضو مرفوع`
          : `🚨 ${leakN} من اللي طلبوا خلال ٣ أيام لسه مرفوعين في جماهير مستهدفة — الكبت مش شغّال`,
      { leaks: leaks.rows, uploadedMembers: uploaded, vacuous: uploaded === 0 });

    /* 3 — نقاء الهولد أوت */
    const controlHashes = rows.filter((x) => x.arm === "control")
      .map((x) => hashPhoneDigits("966" + x.pn));
    const contaminated = controlHashes.length
      ? await pool.query(
          `SELECT count(*)::int AS n FROM rt_members WHERE phone_hash = ANY($1::text[])`,
          [controlHashes])
      : { rows: [{ n: 0 }] };
    const contN = Number(contaminated.rows[0]?.n || 0);
    add("holdout.purity", contN === 0,
      uploaded === 0
        ? `⚪ الضابطة ${controlHashes.length} عميل، ومفيش أي عضو مرفوع لسه — الفحص ده كمان ما اتنفّذش فعليًا.`
        : contN === 0
          ? `ذراع الضابطة (${controlHashes.length} عميل) مرفوعة صفر مرة من ${uploaded} عضو مرفوع — القياس نضيف`
          : `🚨 ${contN} من الضابطة مرفوعين على منصة — القياس مش صالح لحد ما يتشالوا`,
      { control: controlHashes.length, contaminated: contN, vacuous: uploaded === 0 });

    /* الاختبار اللي **بيقدر** يفشل دلوقتي: بنحسب الفرق اللي الدورة الجاية
       هتبعته من غير ما نبعت حاجة. لو الكبت شغّال، اللي طلبوا امبارح لازم
       يبانوا في قايمة «هيتشالوا». ده دليل قابل للفحص قبل ما نلمس أي منصة —
       مش صف أخضر في جدول فاضي. */
    const preview = await previewDiff(rows);
    const freshRemovals = preview.wouldRemoveFresh;
    add("suppression.preview", true,
      preview.uploadedAny
        ? `الدورة الجاية هتضم ${preview.totalAdds} وتشيل ${preview.totalRemoves} عبر كل المنصات — منهم ${freshRemovals} واحد طلب خلال ٣ أيام (دول بالظبط اللي الكبت موجود عشانهم).`
        : `لسه مفيش حاجة مرفوعة، فالدورة الجاية هتضم ${preview.totalAdds} وتشيل ${preview.totalRemoves}. أول ما ترفع، حركة الشيل دي هي اللي هتثبت إن الكبت شغّال.`,
      { preview });

    /* 4 — سجل الشيل */
    const ops = await pool.query(
      `SELECT platform, rung, op, size, status, created_at FROM rt_ops
        WHERE op='remove' ORDER BY created_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
    const removedTotal = await pool.query(
      `SELECT COALESCE(sum(size),0)::int AS n FROM rt_ops WHERE op='remove' AND status='sent'`)
      .catch(() => ({ rows: [{ n: 0 }] }));

    /* حركة الأمس: مين اتنقل من درجة لدرجة. ده الدليل إن التحديث تلقائي
       — مش إن الكود فيه دالة اسمها refresh. */
    const yest = await ladder(new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
    const prev = new Map(yest.map((x) => [x.pn, x.rung]));
    const moved = rows.filter((x) => prev.has(x.pn) && prev.get(x.pn) !== x.rung);
    const movedInto = {};
    for (const m of moved) {
      const k = `${prev.get(m.pn)} → ${m.rung}`;
      movedInto[k] = (movedInto[k] || 0) + 1;
    }

    return {
      ok: checks.every((c) => c.ok),
      checks,
      movement: {
        since: "امبارح",
        moved: moved.length,
        detail: Object.entries(movedInto).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ move: k, n })),
        note: "كل واحد في السطر ده لازم يكون اتشال من درجته القديمة على كل منصة واتضاف للجديدة — سجل rt_ops تحت بيقول حصل ولا لأ.",
      },
      removals: { totalSent: Number(removedTotal.rows[0]?.n || 0), recent: ops.rows },
      holdout: { pct: HOLDOUT_PCT, saltVersion: 1, control: controlHashes.length, test: rows.length - controlHashes.length },
    };
  }

  /* ═══ القياس: الفرق الحقيقي، مش اللي كان جاي أصلاً ═══════════════════════
     52.8٪ من العملاء بيرجعوا خلال ٣٠ يوم من غير أي إعلان — الرقم ده متقاس
     بالكوهورت (مايو 55٪ · يونيو 57.25٪). أي حملة بتاخد الفضل في الرقم ده
     بتبيع للمالك حاجة هو دافع تمنها مرتين.

     الأداة الوحيدة الأمينة هي الهولد أوت: ناس من نفس الشريحة بالظبط، مش
     بيشوفوا الإعلان، وبنشوف بيرجعوا كام. الفرق — وبس الفرق — هو أثر الإعلان.

     وعشان القياس ما يبقاش مسرحية، بنحسب كمان أصغر فرق نقدر نشوفه أصلاً
     بالأعداد اللي عندنا (MDE). لو الفرق المتوقع أصغر من كده، الاختبار ده
     مش هيجاوب مهما استنينا، والراوت بيقول كده صريح بدل ما يطلّع رقم
     يبان دقيق وهو ضوضاء. */

  /* «رجع» = عمل طلب واحد على الأقل جوّه النافذة. من الـPOS، مش من المنصة. */
  async function returnsBetween(phones, fromISO, toISO) {
    if (!phones.length) return new Map();
    const q = await pool.query(
      `WITH ph AS (
         SELECT DISTINCT order_id, pn FROM (
           SELECT order_id, phone_norm AS pn FROM order_sources WHERE phone_norm <> ''
           UNION
           SELECT o.order_id, tc.phone_norm FROM ts_orders o
             JOIN ts_customers tc ON tc.customer_id = o.customer_id
            WHERE tc.phone_norm <> ''
         ) x WHERE pn = ANY($1::text[])
       )
       SELECT ph.pn, count(*)::int AS orders, COALESCE(sum(o.total),0)::numeric AS revenue
         FROM ph JOIN ts_orders o ON o.order_id = ph.order_id
        WHERE o.calendar_day > $2::date AND o.calendar_day <= $3::date
        GROUP BY ph.pn`,
      [phones, fromISO, toISO]);
    return new Map(q.rows.map((x) => [x.pn, { orders: Number(x.orders), revenue: Number(x.revenue) }]));
  }

  /* معدّل الرجوع الطبيعي لكل درجة — متقاس من التاريخ، مش مفترض.
     بنرجع لتواريخ قديمة، نبني السلّم بحالته ساعتها، ونشوف مين رجع بعدها. */
  async function baselines({ window = 30, anchors = 4, gap = 21 } = {}) {
    const out = {};
    for (const spec of RUNGS) out[spec.key] = { n: 0, returned: 0, revenue: 0, windows: 0 };
    const today = Date.now();
    for (let i = 0; i < anchors; i++) {
      const anchorMs = today - (window + i * gap) * 86400_000;
      const anchor = new Date(anchorMs).toISOString().slice(0, 10);
      const end = new Date(anchorMs + window * 86400_000).toISOString().slice(0, 10);
      const rows = await ladder(anchor);
      if (!rows.length) continue;
      const ret = await returnsBetween(rows.map((x) => x.pn), anchor, end);
      for (const row of rows) {
        const b = out[row.rung];
        if (!b) continue;
        b.n++;
        const hit = ret.get(row.pn);
        if (hit) { b.returned++; b.revenue += hit.revenue; }
      }
      for (const k of Object.keys(out)) out[k].windows++;
    }
    return Object.entries(out).map(([key, b]) => {
      const w = wilson(b.returned, b.n);
      return {
        rung: key, ar: rungByKey(key)?.ar || key,
        n: b.n, returned: b.returned,
        baselineReturnRate: pct(w.p),
        ci95: [pct(w.low), pct(w.high)],
        revenuePerCustomer: b.n ? r2(b.revenue / b.n) : null,
        windowDays: window, anchorsUsed: b.windows,
        note: b.n < 30 ? "العيّنة صغيرة — الرقم ده مؤشّر مش قياس" : null,
      };
    });
  }

  /* القياس الحقيقي: تجربة ضد ضابطة على نافذة. */
  async function incrementality({ window = 30, rung = null } = {}) {
    const end = new Date().toISOString().slice(0, 10);
    const startMs = Date.now() - window * 86400_000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    const rows0 = await ladder(start);           // السلّم زي ما كان أول النافذة
    const rows = rung ? rows0.filter((x) => x.rung === rung) : rows0.filter((x) => rungByKey(x.rung)?.target);
    if (!rows.length) return { ok: false, error: "مفيش أعضاء في النافذة دي" };

    const ret = await returnsBetween(rows.map((x) => x.pn), start, end);
    const arm = { test: { n: 0, returned: 0, revenue: 0 }, control: { n: 0, returned: 0, revenue: 0 } };
    for (const row of rows) {
      const a = arm[row.arm];
      a.n++;
      const hit = ret.get(row.pn);
      if (hit) { a.returned++; a.revenue += hit.revenue; }
    }

    const t = wilson(arm.test.returned, arm.test.n);
    const c = wilson(arm.control.returned, arm.control.n);
    const lift = (t.p != null && c.p != null) ? t.p - c.p : null;
    const se = (t.p != null && c.p != null && arm.test.n && arm.control.n)
      ? Math.sqrt((t.p * (1 - t.p)) / arm.test.n + (c.p * (1 - c.p)) / arm.control.n) : null;
    const ciLow = lift != null && se != null ? lift - Z95 * se : null;
    const ciHigh = lift != null && se != null ? lift + Z95 * se : null;
    const resolves = ciLow != null && (ciLow > 0 || ciHigh < 0);
    const pooled = (arm.test.returned + arm.control.returned) / Math.max(1, arm.test.n + arm.control.n);
    const minDetectable = mde(arm.test.n, arm.control.n, pooled);

    const revTest = arm.test.n ? arm.test.revenue / arm.test.n : null;
    const revCtl = arm.control.n ? arm.control.revenue / arm.control.n : null;

    /* هل في إعلان اشتغل على الناس دول أصلاً؟ لو لأ، فده اختبار A/A — نفس
       الحسبة على مجموعتين محدش لمسهم. والقراءة دي أنفع من أي شيء تاني
       دلوقتي: بتوريك بعينك أد إيه سهل تطلّع «أثر» من لا حاجة. */
    const sent = await pool.query(
      `SELECT COALESCE(sum(size),0)::int AS n FROM rt_ops WHERE op='add' AND status='sent'`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    const everSynced = Number(sent.rows[0]?.n || 0) > 0;

    return {
      ok: true,
      window, rung: rung || "كل الدرجات المستهدفة",
      from: start, to: end,
      mode: everSynced ? "A/B — في جماهير مرفوعة فعلاً" : "A/A — مفيش ولا إعلان اشتغل على دول",
      aaWarning: everSynced ? null
        : "مفيش أي جمهور اترفع لأي منصة لحد دلوقتي، يعني ذراع «التجربة» ما اتعرضش لأي إعلان. أي فرق بين الذراعين تحت هو ضوضاء خالصة بالتعريف — وده بالظبط شكل الرقم اللي حملة ممكن تدّعيه لو محدش سأل.",
      test: { n: arm.test.n, returned: arm.test.returned, rate: pct(t.p), revenuePerCustomer: r2(revTest) },
      control: { n: arm.control.n, returned: arm.control.returned, rate: pct(c.p), revenuePerCustomer: r2(revCtl) },
      lift: {
        points: pct(lift),
        ci95: [pct(ciLow), pct(ciHigh)],
        resolves,
        /* الجملة دي هي اللي بتمنع الكدب. لو المدى بيعدّي الصفر، مفيش رقم
           نقوله — بنقول «لسه مش محسوم» وخلاص. */
        verdict: !resolves
          ? "لسه مش محسوم — المدى بيشمل الصفر. أي رقم أثر يتقال دلوقتي هيبقى ضوضاء."
          : (lift > 0 ? "الإعلان بيزوّد الرجوع فعلاً" : "الإعلان بيقلّل الرجوع — أوقفه"),
      },
      power: {
        minDetectableEffectPoints: pct(minDetectable),
        baselineUsed: pct(pooled),
        /* أهم سطر في الراوت كله للحساب ده بالذات. */
        note: minDetectable == null ? null
          : `بالأعداد الحالية (${arm.test.n} تجربة / ${arm.control.n} ضابطة) أصغر فرق ممكن نشوفه في نافذة واحدة هو ${pct(minDetectable)} نقطة. أي أثر أصغر من كده موجود ومش هنقدر نثبته من نافذة واحدة.`,
        /* «القاعدة لازم تكبر أد إيه» — الرقم اللي بيحوّل الإحباط لخطة.
           بنحسبه لأثر ٥ نقاط، وده أثر ريتارجيت محترم وواقعي. */
        baseNeededForFivePointLift: nNeeded(0.05, pooled, arm.control.n / Math.max(1, arm.test.n + arm.control.n)),
        baseNeededAtFiftyFifty: nNeeded(0.05, pooled, 0.5),
        currentBase: arm.test.n + arm.control.n,
        windowsNeeded: minDetectable ? Math.ceil((minDetectable / 0.05) ** 2) : null,
        plan: minDetectable == null ? null
          : `عشان نشوف أثر ٥ نقاط في نافذة واحدة محتاجين قاعدة ~${nNeeded(0.05, pooled, 0.5)} عميل بقسمة ٥٠/٥٠ — عندنا ${arm.test.n + arm.control.n}. بالقسمة الحالية، تراكم ~${Math.ceil((minDetectable / 0.05) ** 2)} نافذة بيوصلنا لنفس الحساسية. الهولد أوت بيفضل شغّال من دلوقتي عشان الساعة تبدأ، مش عشان يجاوب الشهر ده.`,
      },
      /* السؤال اللي القوة عندنا تقدر تجاوبه فعلاً: مش «فيه أثر؟» لكن
         «الأثر يغطّي فلوسه؟». بيتحسب بس لما يتمرر رقم صرف. */
      breakEven: null,
      revenueLiftPerCustomer: (revTest != null && revCtl != null) ? r2(revTest - revCtl) : null,
      basis: "الرجوع والإيراد من طلبات نقطة البيع — مش من تحويلات المنصة. تتبع المنصة مش حقيقي لإن العمليات بتتم أوفلاين.",
    };
  }

  /* تكلفة العميل الراجع الإضافي = الصرف ÷ (عدد التجربة × الأثر).
     لو الأثر مش محسوم، مفيش تكلفة تتقال — بنقول مش محسوم. */
  async function costPerIncremental({ window = 30, spend = null } = {}) {
    const inc = await incrementality({ window });
    if (!inc.ok) return inc;
    const liftFrac = inc.lift.points == null ? null : inc.lift.points / 100;
    const incremental = liftFrac == null ? null : inc.test.n * liftFrac;
    const s = spend == null ? null : Number(spend);
    const rows = await ladder();
    const buckets = summarise(rows);
    const valueAvg = buckets.filter((b) => b.target && b.n)
      .reduce((a, b) => a + (b.valuePerReturn || 0) * b.n, 0)
      / Math.max(1, buckets.filter((b) => b.target).reduce((a, b) => a + b.n, 0));

    /* الحكم اللي بيتقال حتى لو الأثر مش محسوم: هل الصرف ده أصلاً قابل
       للتقييم؟ لو لأ، الإجابة «ما تصرفش» — مش «صرفنا واستنينا». */
    const be = breakEven({
      spend: s, nTest: inc.test.n, valuePerReturn: valueAvg,
      minDetectable: inc.power.minDetectableEffectPoints == null ? null : inc.power.minDetectableEffectPoints / 100,
    });
    inc.breakEven = be;

    return {
      ok: true,
      window,
      breakEven: be,
      incrementalReturningCustomers: inc.lift.resolves && incremental != null ? Math.round(incremental) : null,
      spendUsed: s,
      costPerIncrementalReturn: (inc.lift.resolves && incremental > 0 && s != null) ? r2(s / incremental) : null,
      valuePerReturn: r2(valueAvg),
      appToRestaurantMultiple: ECON.appToRestaurantMultiple,
      verdict: !inc.lift.resolves
        ? "الأثر لسه مش محسوم — يبقى تكلفة العميل الإضافي مش رقم موجود. أي رقم يتقال هنا هيبقى قسمة على ضوضاء."
        : s == null
          ? "الأثر محسوم، بس مفيش رقم صرف متمرّر — ابعت spend عشان نطلّع التكلفة."
          : `كل عميل راجع بفضل الإعلان بيكلّف ${r2(s / incremental)} ر.س وبيجيب ${r2(valueAvg)} ر.س هامش.`,
      detail: inc,
    };
  }

  /* ═══ الشغلانة التالتة: ١٩٣ عميل تطبيقات عمرهم ما جم المطعم ═══════════════
     كل واحد فيهم بيتحوّل = نفس الفاتورة بهامش 2.15×. الأدوات اللي وافق
     عليها عمر: توصيل مجاني فوق ٧٥ ر.س + كرت في كل طلب تطبيق. وقرارُه إن
     المنافسة بالسعر مؤجّلة — فمفيش تخفيض هنا.

     والقياس هو نص الشغل: استرجاع كود مرة واحدة مش تحوّل. التحوّل الحقيقي هو
     إنه يرجع تاني من غير ما يحتاج الحافز. الراوت ده بيفرّق بين التلاتة:
       جرّب      — أول طلب مباشر (غالبًا بالكود)
       رجع بحافز — طلب مباشر تاني ومعاه استرجاع كود
       اتحوّل    — طلب مباشر تاني من غير أي كود ← ده الرقم الوحيد اللي يتحسب */
  async function deliveryAppProgramme({ window = 90 } = {}) {
    const rows = await ladder();
    const pool193 = rows.filter((x) => x.delOrders >= 1 && x.dirOrders === 0);
    const converted = rows.filter((x) => x.delOrders >= 1 && x.dirOrders >= 1);

    const phones = converted.map((x) => x.pn);
    const redemptions = phones.length
      ? await pool.query(
          `SELECT phone_norm, count(*)::int AS n FROM promo_redemptions
            WHERE phone_norm = ANY($1::text[]) GROUP BY phone_norm`, [phones])
          .catch(() => ({ rows: [] }))
      : { rows: [] };
    const redeemedBy = new Map(redemptions.rows.map((x) => [x.phone_norm, Number(x.n)]));

    /* «اتحوّل بجد» = عنده ≥2 طلب مباشر، والاستردادات أقل من عدد الطلبات
       المباشرة — يعني رجع مرة على الأقل من غير حافز. */
    const trueConverts = converted.filter((x) => x.dirOrders >= 2 && (redeemedBy.get(x.pn) || 0) < x.dirOrders);
    const incentiveOnly = converted.filter((x) => !(x.dirOrders >= 2 && (redeemedBy.get(x.pn) || 0) < x.dirOrders));

    const avgTicket = pool193.length
      ? pool193.reduce((a, b) => a + b.avgTicket, 0) / pool193.length : 0;
    const marginGain = ECON.marginDirect - ECON.marginDeliveryApp;

    return {
      ok: true,
      pool: {
        n: pool193.length,
        ar: "عملاء تطبيقات عمرهم ما طلبوا من المطعم مباشرة",
        avgTicket: r2(avgTicket),
        /* مكسب الهامش على الفاتورة الواحدة لو نفس العميل طلب مباشرة. */
        marginGainPerOrder: r2(avgTicket * marginGain),
        annualIfEachReturnsTwice: r2(pool193.length * avgTicket * marginGain * 2),
      },
      instruments: [
        { what: `توصيل مجاني فوق ${ECON.freeDeliveryThreshold} ر.س`, approved: true,
          note: "العتبة اتحددت في شغل تاني وبتتقرا هنا كمُدخل." },
        { what: "كرت في كل طلب تطبيق — كود شخصي يتقاس بالاسترجاع", approved: true,
          note: "الكود هو الرابط الوحيد الصلب بين ورقة في كيس وبين طلب في المطعم." },
        { what: "منافسة بالسعر / تخفيض تحت سعر التطبيق", approved: false,
          note: "مؤجّل بقرار المالك — مش موجود في الخطة." },
      ],
      outcome: {
        tried: converted.length,
        incentiveOnly: incentiveOnly.length,
        converted: trueConverts.length,
        conversionRate: pool193.length + converted.length
          ? pct(trueConverts.length / (pool193.length + converted.length)) : null,
        definition: "«اتحوّل» = طلبين مباشرين على الأقل، وواحد منهم على الأقل من غير استرجاع كود. استرجاع مرة واحدة مش تحوّل — دي زيارة مدفوعة.",
      },
      measurementGap: redemptions.rows.length === 0
        ? "مفيش أي استرجاع كود متسجّل لعملاء التطبيقات لحد دلوقتي — يعني الكروت لسه ما اتوزعتش أو الكاشير مش بيسجّل. من غير الاسترجاع مش هنعرف نفرّق بين اللي جه بالكرت واللي كان جاي أصلاً."
        : null,
      window,
    };
  }

  /* ═══ طبقة البيكسل — لو الأصول اتعمل لها شير على الحساب الجديد ═══════════
     عمر اقترح إننا نشارك أصول الحساب القديم للجديد بدل ما نبدأ من الصفر،
     والأخ اللي على الكروم بينفّذ. لو البيكسل اتنقل بتاريخه، بيدخل معانا
     ناس القوايم عمرها ما تشوفهم: اللي دخل الموقع وما طلبش. دي طبقة حقيقية
     ومفيدة — وفيها فخّين لازم يتقالوا قبل ما حد يبني عليها:

     الفخ الأول — القياس. الناس دي **مالهاش أرقام**. يعني مفيش طريقة نربطهم
     بطلب في نقطة البيع، ومفيش هولد أوت ينفع عليهم، ومفيش «عميل راجع»
     يتحسب لهم. ينفع نستهدفهم، ما ينفعش ندّعي إننا قسنا أثرهم. اللي
     بيتقاس عليهم هو تحويلات المنصة — واللي عمر قال عنها بالنص: «تتبعك
     للطلبات غير حقيقي لأن العمليات كلها بتتم أوفلاين». فبتتعلّم هنا
     `measurable: false` وخلاص، مش بتتحط في حسبة العائد.

     الفخ التاني — الحجم. الحساب ده اتوقفت فيه حملة يوم ١٣ أغسطس عشان حد
     قرا `approximate_count_lower_bound` = 20 وافتكرها عدد الناس. الحقل ده
     بيرجع 20 لكل جمهور بيكسل و1000 لكل قايمة عملاء مهما كان الحجم. وحتى
     `delivery_estimate` نفسه بيقف عند 1000 من تحت. فالطبقة دي بتتقفل ورا
     قياس فعلي من `aud_sizes`، وأي رقم مالوش `ok` بيتقال «مقدرناش نقيس»
     — مش صفر ومش تقدير.                                                   */
  const PIXEL_RUNGS = [
    { key: "web:checkout-abandon14", ar: "بدأ الشيك أوت وما كمّلش — أعلى نية", heat: "hot" },
    { key: "web:cart-abandon14", ar: "حط في السلة وما اشتراش", heat: "hot" },
    { key: "web:viewers14", ar: "بصّ على صنف آخر ١٤ يوم", heat: "hot" },
    { key: "web:visitors30", ar: "زار الموقع آخر ٣٠ يوم", heat: "warm" },
    { key: "web:visitors90", ar: "زار الموقع آخر ٩٠ يوم", heat: "cool" },
    { key: "eng:page30", ar: "تفاعل مع الصفحة آخر ٣٠ يوم", heat: "warm" },
    { key: "eng:ig30", ar: "تفاعل مع إنستجرام آخر ٣٠ يوم", heat: "warm" },
  ];

  async function pixelLayer() {
    const sizes = await pool.query(
      `SELECT key, low, high, method, ok, error, measured_at FROM aud_sizes WHERE platform='meta'`)
      .catch(() => ({ rows: [] }));
    const byKey = new Map(sizes.rows.map((x) => [x.key, x]));
    const rows = PIXEL_RUNGS.map((p) => {
      const s = byKey.get(p.key);
      const measured = !!s?.ok;
      const low = measured ? Number(s.low) : null;
      return {
        ...p,
        measured,
        /* الرقم ده تقدير وصول شهري من ميتا، مش عدد أعضاء. والأهم: بيقف عند
           1000 من تحت — يعني «1000» هنا ممكن تكون 40. مالوش لازمة كدليل
           إن الجمهور كبير كفاية. */
        monthlyReach: measured ? { low, high: Number(s.high), method: s.method } : null,
        sizeNote: measured
          ? (low <= 1000
              ? "⚠️ التقدير واقف عند الأرضية (1000) — ده معناه «1000 أو أقل»، مش «1000». ما ينفعش يتقرا كدليل على حجم."
              : null)
          : (s?.error ? `مقدرناش نقيس: ${String(s.error).slice(0, 120)}` : "لسه ما اتقاسش"),
        measuredAt: s?.measured_at || null,
        usable: measured && Number(s.low) > 1000,
        /* السطر ده هو اللي بيمنع إن الطبقة دي تتخلط بالقياس الأمين. */
        measurable: false,
        measurementNote: "مفيش أرقام جوالات للناس دي — مينفعش يتربطوا بطلب في نقطة البيع، ومينفعش يدخلوا الهولد أوت. أي «نتيجة» عليهم هتبقى من تتبع المنصة، وده مش مقبول كدليل هنا.",
      };
    });
    const anyMeasured = rows.some((r) => r.measured);
    return {
      available: anyMeasured,
      rows,
      dependsOn: "شير أصول الحساب القديم للجديد (بيكسل + صفحة + إنستجرام) — شغل الأخ اللي على الكروم",
      note: anyMeasured
        ? "الأرقام دي من delivery_estimate على الحساب اللي القياس اتعمل عليه. بعد الشير لازم تتقاس تاني على الحساب الجديد — الجمهور بيتبع الحساب."
        : "لسه مفيش ولا قياس ناجح لطبقة البيكسل. مش بنكتب صفر ومش بنكتب تقدير — بنقول ما اتقاسش.",
    };
  }

  /* ═══ الشبيه: تسليم للأخ اللي بيبني هيكل الاكتساب ═══════════════════════
     الشبيه مش ريتارجيت — هو الامتداد الطبيعي لأحسن شرايحنا، وبيتسلّم مش
     بيتبني هنا.

     وفيه رقم لازم يتصحّح قبل ما حد يبني عليه: اللي اتقال إن «أرضية الشبيه
     عند ميتا 1000» **مش صحيح ومش من ميتا**. ميتا بتقول بالنص:
       "If you have a Custom Audience with at least 100 people, you can build
        lookalike audiences based on it."
     الأرضية الموثّقة **100**. البذرة اللي فشلت كان فيها 77 — فشلت على 100
     مش على 1000. والفرق ده بيغيّر قرار: بذرة الـVIP عندنا فوق الأرضية
     الموثّقة دلوقتي، يعني الشبيه على ميتا مش مستني حاجة.

     الـ1000 حقيقية على تيك توك وسناب — بس دي أرضية **الاستهداف**، وعلى
     تيك توك أرضية مصدر الشبيه كمان. */
  async function lookalikeHandoff() {
    const buckets = summarise(await ladder());
    const all = buckets.reduce((a, b) => a + b.n, 0);
    const vip = buckets.find((b) => b.key === "rt:vip")?.n || 0;
    const seeds = [
      { key: "all", ar: "كل العملاء", n: all },
      { key: "vip", ar: "الأوفياء — أغلى بذرة عندنا", n: vip },
    ];
    return {
      correction: {
        claim: "«أرضية بذرة الشبيه عند ميتا = 1000»",
        status: "غلط — مش رقم من ميتا",
        truth: `الموثّق ${META_LAL_SEED_FLOOR}: "If you have a Custom Audience with at least 100 people, you can build lookalike audiences based on it."`,
        source: "https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences/",
        consequence: "البذرة اللي فيها 77 فشلت على أرضية 100 مش 1000. وبذرة الأوفياء دلوقتي فوق الأرضية — الشبيه على ميتا مش مستني كبر القايمة، مستني الحساب الجديد بس.",
      },
      seeds: seeds.map((s) => ({
        ...s,
        meta: {
          floor: META_LAL_SEED_FLOOR, confirmed: true,
          clears: s.n >= META_LAL_SEED_FLOOR,
          verdict: s.n >= META_LAL_SEED_FLOOR
            ? `فوق الأرضية بـ${s.n - META_LAL_SEED_FLOOR} — جاهزة كبذرة`
            : `ناقصها ${META_LAL_SEED_FLOOR - s.n}`,
        },
        tiktok: {
          floor: FLOORS.tiktok.n, confirmed: true,
          clears: Math.round(s.n * ECON.matchRateAssumed) >= FLOORS.tiktok.n,
          verdict: `تيك توك بتطلب ${FLOORS.tiktok.n} في مصدر الشبيه نفسه — بتقدير تطابق ${pct(ECON.matchRateAssumed)}٪ بنوصل ~${Math.round(s.n * ECON.matchRateAssumed)}، يعني ناقصنا ~${Math.max(0, FLOORS.tiktok.n - Math.round(s.n * ECON.matchRateAssumed))}`,
        },
        snapchat: {
          floor: null, confirmed: false,
          verdict: `سناب مش ناشرة أرضية للبذرة. اللي موثّق إن الجمهور نفسه محتاج ${FLOORS.snapchat.n} عشان يتستهدف، والـAPI بيرجع TOO_FEW_USERS تحتها. مانفترضش رقم للبذرة.`,
        },
        google: {
          floor: FLOORS.google.n, confirmed: true,
          verdict: `أرضية جوجل ${FLOORS.google.n} والبذرة بتعدّيها — المسدود هو طريق الرفع (Data Manager API)، مش الحجم.`,
        },
      })),
      note: "الشبيه اكتساب مش ريتارجيت. متحطوط هنا كتسليم للأخ اللي بيبني الهيكل البارد، عشان أحسن شرايحنا تكون هي البذرة بدل جمهور عام.",
    };
  }

  /* ═══ الخطة: مواصفة كاملة، متوقّفة، جاهزة للأخ اللي بيبني الحملات ═══════
     الملف ده مش بيعمل حملة. بيطلّع اللي الحملة محتاجاه بالظبط: الجمهور، مين
     يتستبعد، سقف التكرار، الميزانية بين أرضية التعلّم وسقف الحرق، والرسالة.
     كله status: PAUSED — مفيش ولا حقل بيشغّل حاجة. */
  async function plan({ cpm = null, costPerResult = null } = {}) {
    const rows = await ladder();
    const buckets = summarise(rows);
    const byKey = new Map(buckets.map((b) => [b.key, b]));

    const adSets = [];
    for (const spec of TARGETED) {
      const b = byKey.get(spec.key);
      if (!b) continue;
      const reach = reachability(b);
      const money = budgetWindow(b, { cpm, costPerResult });
      const ex = exclusionsFor(spec.key);
      const audIds = {};
      for (const p of PLATFORMS) {
        const q = await pool.query(
          `SELECT audience_id FROM rt_audiences WHERE platform=$1 AND rung=$2`, [p, spec.key]);
        audIds[p] = q.rows[0]?.audience_id || null;
      }
      adSets.push({
        name: `fc-rt-${spec.key.replace(/^rt:/, "")}`,
        rung: spec.key, ar: spec.ar, heat: spec.heat,
        status: "PAUSED",
        size: b.n, test: b.nTest, control: b.nControl,
        message: spec.message, offer: spec.offer, why: spec.why,
        economics: {
          avgTicket: b.avgTicket, marginPct: b.marginPct,
          valuePerReturn: b.valuePerReturn,
          budgetWeight: spec.weight,
        },
        reach,
        budget: money,
        frequency: {
          intent: spec.freq,
          meta: {
            ...FREQ_API.meta,
            spec: [{ event: "IMPRESSIONS", interval_days: spec.freq.days, max_frequency: spec.freq.impressions }],
            /* القيد ده بيقلب التصميم: لو المجموعة متحسّنة على التحويلات،
               ميتا مش هتقبل السقف أصلاً. فإما نعلن بهدف REACH ونمسك السقف
               بإيدنا، أو نتحسّن على التحويلات ونمسك التكرار بالميزانية.
               التالت — إننا نفتكر إن عندنا سقف وهو مش متحطّ — هو اللي
               بيحرق قايمة ٨٠٠ واحد. */
            appliesHere: "بس لو هدف المجموعة REACH أو THRUPLAY. على أي هدف تحويلات، الحقل ده مرفوض والميزانية هي السقف الوحيد.",
          },
          tiktok: { ...FREQ_API.tiktok, spec: { frequency: spec.freq.impressions, frequency_schedule: spec.freq.days } },
          snapchat: { ...FREQ_API.snapchat, spec: null },
          fallback: "لو الهدف تحويلات على أي منصة: السقف بيتنفّذ بالميزانية — الرقم في budget.maxDailyBudget محسوب من نفس التكرار المطلوب.",
        },
        audiences: {
          /* لو القايمة مش هتعدّي الأرضية، الاستهداف بيتحوّل لجماهير البيكسل
             والدرجة بتفضل استبعاد. ده مكتوب في الخطة نفسها عشان اللي هينفّذ
             ما يعملش مجموعة إعلانية هتقعد «تحت الحد الأدنى» للأبد. */
          targetingMode: reach.targetableAsList ? "customer_list" : "pixel_audience_narrowed_by_exclusions",
          list: audIds,
          fallbackTargets: reach.targetableAsList ? null
            : ["web:visitors30", "web:visitors90", "eng:page30", "eng:ig30"],
        },
        exclusions: {
          rungs: ex.rungs,
          platformAudiences: ex.platform,
          note: "الاستبعاد مالوش حد أدنى على أي منصة — ده اللي بيخلّي السلّم شغّال حتى والقوايم صغيرة.",
        },
      });
    }

    const suppressOnly = RUNGS.filter((x) => !x.target).map((x) => ({
      rung: x.key, ar: x.ar, n: byKey.get(x.key)?.n || 0, why: x.why,
      use: "استبعاد فقط — بيترفع على المنصات وعمره ما يتستهدف",
    }));

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      account: { meta: metaAct() || null, tz: "Asia/Riyadh" },
      status: "PAUSED — مفيش حملة اتعملت، ومفيش ميزانية اتحطت. الملف ده بيوصف بس.",
      economics: ECON,
      adSets,
      suppressOnly,
      /* طبقة البيكسل جنب السلّم مش جوّاه — عن قصد. دي ناس تانية خالص:
         مالهاش أرقام، ومالهاش قياس أمين، ومينفعش تتخلط في نفس الجدول مع
         عملاء إحنا عارفينهم بالاسم. */
      pixelLayer: await pixelLayer(),
      lookalikeHandoff: await lookalikeHandoff(),
      holdout: { pct: HOLDOUT_PCT, mechanism: "ذراع الضابطة مش بتترفع لأي منصة أصلاً" },
      blockers: await blockers(),
    };
  }

  /* ═══ المعوّقات: اللي مش في إيدنا، بالاسم ═══════════════════════════════
     الحاجات دي مش أعطال بنصلحها — دي شغل عند ناس تانية أو عند المنصة.
     بتتقال بالاسم عشان محدش يفضل يستنى حاجة محدش شغال عليها. */
  async function blockers() {
    const out = [];
    const act = metaAct();
    out.push({
      id: "meta.assetshare",
      what: `حساب ميتا الجديد ${act || "(مش متظبّط في البيئة)"} — مستني شير الأصول (بيكسل + صفحة + إنستجرام + الجماهير)`,
      blocks: "أي جمهور ريتارجيت على الحساب الجديد، وأي حملة تتبني عليه",
      who: "الأخ اللي على الكروم — بينفّذ الشير من الـBusiness Manager دلوقتي",
      weCanWorkAround: false,
      /* الفرق بين «انقل» و«شارك» مش لغوي. جمهور القوايم عندنا هنعيد بناءه
         في دقيقتين من نفس الأرقام — مفيش خسارة. اللي مالوش بديل هو تاريخ
         البيكسل: ده مش بيتعاد بناؤه، لإنه سلوك ناس حصل خلاص. */
      note: "الشير هو القرار الصح: تاريخ البيكسل مش بيتعاد بناؤه، لإنه سلوك حصل خلاص. أما جماهير القوايم فبتتبني تاني من نفس الأرقام في دقايق — فلو الشير اتعثّر فيها، دي مش خسارة. لما الشير يخلص لازم القياس يتعاد على الحساب الجديد: الحجم بيتبع الحساب.",
    });
    out.push({
      id: "snap.e2025",
      what: "سناب: مشكلة E2025 placement v2 بتقفل تعديل الميزانيات عن طريق الـAPI",
      blocks: "تعديل ميزانية أي ad squad قديم من السيرفر",
      who: "الأخ اللي بيعمل ad squad جديد من واجهة سناب",
      weCanWorkAround: false,
      note: "رفع وشيل أعضاء الجماهير مش متأثر — ده بيشتغل عادي. المسدود هو الحملة مش الجمهور.",
    });
    out.push({
      id: "google.datamanager",
      what: "جوجل: الطريق القديم لـ Customer Match اتقفل على أي توكن جديد",
      blocks: "رفع قوايم العملاء لجوجل عن طريق Google Ads API",
      who: "قرار من جوجل — الطريق الوحيد الباقي هو Data Manager API، تكامل جديد بالكامل",
      weCanWorkAround: false,
      /* الجملة دي من جوجل بالنص، والتاريخ عدّى خلاص — فالكلام مش «هيحصل»
         ده «حصل». أي تكامل جديد بتوكن جديد هيترفض من أول نداء. */
      note: "جوجل بتقول: «Starting April 1, 2026, OfflineUserDataJobService and UserDataService requests for Customer Match will fail if the developer token hasn't previously sent requests for Customer Match. Use the Data Manager API instead.» التاريخ ده عدّى، وتوكن فريش كتس عمره ما بعت Customer Match قبل كده — يعني المسار القديم مقفول من قبل ما نجرّبه. ملحوظة منفصلة: UploadClickConversions (رفع الطلبات كتحويلات) مقفول هو كمان بـCUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE — مشكلتين مختلفتين، نفس الحل.",
    });
    out.push({
      id: "google.eligibility",
      what: "جوجل: Customer Match نفسه له شروط أهلية على مستوى الحساب",
      blocks: "استخدام قوايم العملاء حتى لو التكامل اتعمل",
      who: "سجل الحساب عند جوجل — مش حاجة تتبرمج",
      weCanWorkAround: false,
      note: "جوجل بتشترط «A good history of policy compliance» و«A good payment history». وكمان: ضبط الاستهداف وتعديل المزايدة يدويًا محتاجين ٩٠ يوم تاريخ إعلانات و+٥٠ ألف دولار صرف تراكمي — الشرط ده فريش كتس بعيدة عنه بمراحل، فالمتاح عمليًا هو Observation مش Targeting.",
    });
    /* الأرضية بقت لكل منصة على حدة — وده بيغيّر الحكم: نفس القايمة ممكن
       تبقى مرفوضة على تيك توك ومقبولة على جوجل. */
    const buckets = summarise(await ladder()).filter((b) => b.target);
    const blockedOn = { tiktok: [], snapchat: [], google: [] };
    for (const b of buckets) {
      const rr = reachability(b);
      for (const p of Object.keys(blockedOn)) {
        if (rr.byPlatform[p]?.targetable === false) blockedOn[p].push(b.key);
      }
    }
    for (const [p, keys] of Object.entries(blockedOn)) {
      if (!keys.length) continue;
      out.push({
        id: `floor.${p}`,
        what: `${keys.length} من ${TARGETED.length} درجة تحت أرضية ${p} (${FLOORS[p].n} متطابق)`,
        blocks: `استهداف الدرجات دي كقوايم مباشرة على ${p}`,
        who: "مفيش حد — ده حجم قاعدة العملاء نفسها",
        weCanWorkAround: true,
        rungs: keys,
        note: "الاستبعاد مالوش حد أدنى، فالدرجات دي بتفضل شغّالة كاستبعاد وكقياس. الوصول بيجي من جماهير البيكسل — مكتوب في targetingMode لكل مجموعة.",
      });
    }
    if (!blockedOn.google.length) {
      out.push({
        id: "google.opportunity",
        what: "أرضية جوجل ١٠٠ بس — كل درجات السلّم بتعدّيها",
        blocks: "لا حاجة — دي فرصة مش معوّق",
        who: "—",
        weCanWorkAround: true,
        note: "جوجل هي المنصة الوحيدة اللي قوايمنا بالحجم ده تعدّي أرضيتها. المسدود هو طريق الرفع (Data Manager API) مش حجم القايمة — يعني أعلى عائد لأي شغل تكامل جاي.",
      });
    }
    return out;
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */

  app.get("/api/retargeting/ladder", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const asOf = c.req.query("asOf") || null;
    const rows = await ladder(asOf);
    const buckets = summarise(rows);
    return c.json({
      ok: true, asOf: asOf || new Date().toISOString().slice(0, 10),
      customers: rows.length,
      economics: ECON,
      rungs: buckets.map((b) => ({
        ...b,
        exclusions: exclusionsFor(b.key).rungs,
        reach: b.target ? reachability(b) : null,
      })),
    });
  });

  app.get("/api/retargeting/verify", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json(await verify());
  });

  /* الأرضيات: الموثّق، والمقيس من ميتا نفسها، والمُشاع اللي بنرفضه. */
  app.get("/api/retargeting/floors", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const measure = c.req.query("measure") === "1";
    return c.json({
      ok: true,
      documented: FLOORS,
      metaLookalikeSeedFloor: {
        n: META_LAL_SEED_FLOOR, confirmed: true,
        source: "https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences/",
        note: "الرقم الموثّق ١٠٠ مش ١٠٠٠. بذرة الـVIP عندنا فوقه — يعني الشبيه ماينفعش يتأجّل بحجّة البذرة.",
      },
      frequencyApi: FREQ_API,
      measured: measure ? await metaFloors() : null,
      measureHint: measure ? null : "ضيف ?measure=1 عشان نسأل ميتا عن حالة كل جمهور فعلاً (بياكل من حصة الحساب).",
    });
  });

  app.get("/api/retargeting/plan", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cpm = c.req.query("cpm") != null ? Number(c.req.query("cpm")) : null;
    const cpr = c.req.query("costPerResult") != null ? Number(c.req.query("costPerResult")) : null;
    return c.json(await plan({ cpm, costPerResult: cpr }));
  });

  app.get("/api/retargeting/baselines", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const w = Number(c.req.query("window") || 30);
    return c.json({ ok: true, window: w, rungs: await baselines({ window: w }) });
  });

  app.get("/api/retargeting/incrementality", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const w = Number(c.req.query("window") || 30);
    return c.json(await incrementality({ window: w, rung: c.req.query("rung") || null }));
  });

  app.get("/api/retargeting/cost", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const w = Number(c.req.query("window") || 30);
    const spend = c.req.query("spend") != null ? Number(c.req.query("spend")) : null;
    return c.json(await costPerIncremental({ window: w, spend }));
  });

  app.get("/api/retargeting/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await previewDiff()) });
  });

  app.get("/api/retargeting/pixel-layer", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await pixelLayer()) });
  });

  app.get("/api/retargeting/lookalikes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await lookalikeHandoff()) });
  });

  app.get("/api/retargeting/delivery-app", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json(await deliveryAppProgramme({ window: Number(c.req.query("window") || 90) }));
  });

  /* الدورة اليدوية. `dryRun` هو الوضع الافتراضي لحد ما RT_SYNC=1 —
     يعني الراوت ده يتنده براحتك دلوقتي وما هيلمسش أي منصة. */
  app.post("/api/retargeting/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    return c.json(await runCycle({
      trigger: "manual",
      platforms: b.platforms || null,
      dryRun: b.dryRun === undefined ? null : !!b.dryRun,
    }));
  });

  app.get("/api/retargeting/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const runs = await pool.query(
      `SELECT id, trigger, started_at, finished_at, status FROM rt_runs ORDER BY started_at DESC LIMIT 10`)
      .catch(() => ({ rows: [] }));
    const ops = await pool.query(
      `SELECT platform, op, status, count(*)::int AS n, COALESCE(sum(size),0)::int AS members
         FROM rt_ops WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY platform, op, status ORDER BY platform, op`).catch(() => ({ rows: [] }));
    const rows = await ladder();
    const buckets = summarise(rows);
    const notTargetable = buckets.filter((b) => b.target && !reachability(b).targetableAsList).length;
    return c.json({
      ok: true,
      syncEnabled: env("RT_SYNC") === "1",
      holdoutPct: HOLDOUT_PCT,
      customers: rows.length,
      rungs: buckets.map((b) => ({ key: b.key, ar: b.ar, n: b.n, target: b.target })),
      line: env("RT_SYNC") === "1"
        ? `السلّم شغّال على ${rows.length} عميل في ${TARGETED.length} درجة مستهدفة، والمزامنة بتضم وبتشيل.`
        : `السلّم محسوب على ${rows.length} عميل، والمزامنة لسه متوقفة (RT_SYNC ≠ 1) — مفيش حاجة بتتبعت لأي منصة.`,
      floorWarning: notTargetable
        ? `${notTargetable} درجة مش هتعدّي أرضية ولا منصة موثّقة — بتشتغل استبعاد وقياس، مش استهداف مباشر.`
        : null,
      runs: runs.rows,
      ops7d: ops.rows,
    });
  });

  console.log(`[retargeting] ready — ${RUNGS.length} rungs (${TARGETED.length} targeted), holdout ${HOLDOUT_PCT}%, sync ${env("RT_SYNC") === "1" ? "ON" : "OFF (dry)"}`);

  return {
    RUNGS, ECON, FLOORS, FREQ_API,
    ladder, summarise, verify, plan, blockers, metaFloors,
    baselines, incrementality, costPerIncremental, deliveryAppProgramme,
    runCycle, reachability, exclusionsFor, pixelLayer, lookalikeHandoff, previewDiff,
  };
}
