/* ═══════════════════════════════════════════════════════════════════════════
   OFFERS — التعريف الوحيد لعروض الصالة: سعرها، تاريخ انتهائها، وإزاي تتقاس.

   ── ليه الملف ده موجود ───────────────────────────────────────────────────
   عرض «بيتزا + باستا + كريب بـ٧٠ ر.س» مش صنف في TabSense ومش هيبقى صنف:
   الكاشير بيعمل **خصم يدوي على كل سطر** لحد ما مجموع التلات أصناف يوصل ٧٠.
   ده اللي خلّى price-guard.js يرفض ينشر تصميم العرض من أيام — وهو كان **محق**:
   ماكانش فيه أي مصدر يقدر يتحقق من الرقم ٧٠، والحارس مبيصدّقش كلام مكتوب في
   ملف تصميم. الحل مش إننا نطفّي الحارس، الحل إننا ندّيله مصدر يتحقق منه.

   فالملف ده هو المصدر. العرض متسجّل هنا **مرة واحدة**: اسمه، مكوّناته،
   سعره، إنه داخل الصالة بس، وتاريخ انتهائه. وكل سطح بيقرا من هنا:

     • الكتالوج اللي بيروح لميتا/تيك توك/سناب  → catalog.js بيدمج العروض
       الشغّالة في feed.csv (بنفس ملاحظة «داخل الصالة فقط»)
     • حارس الأسعار price-guard.js             → بيقرا نفس الـfeed + /api/offers/all
     • شريط العروض في المتجر order.o2m8.me     → server.py بينده /api/offers
     • تقويم المحتوى content.js                 → أفكار العرض بتختفي بعد انتهائه
     • فحص النظام systemcheck.js                → بيقيس إن العرض متسجّل وشغّال
     • جدول mk_offers في مركز التسويق          → hub.js بيقرا التاريخ من هنا

   ── نوعين من العروض، بصمتين مختلفتين ─────────────────────────────────────
   بعد ما عمر قال إن **العرضين** آخرهم ٣١ أغسطس، بقى في الملف ده عرضين:

     • combo70 — مش صنف في نقطة البيع. محتاج صف كتالوج خاص بيه، وبصمته
       تركيبة (`detect.mode = "components"`).
     • lamma (صينية اللمة) — **صنف حقيقي** في نقطة البيع (id 121). الكتالوج
       بياخده من المنيو لوحده فمالوش صف هنا (`catalogRow: false`)، وبصمته
       اسم السطر في الفاتورة (`detect.mode = "item"`) — دقيقة مش تقريبية.

   يعني وجود عرض هنا **مش** معناه إنه مش صنف في نقطة البيع؛ معناه إن ده
   المكان اللي بيتقرر فيه إمتى يقع، وإزاي يتقاس.

   ── الانتهاء بيتنفّذ لوحده ────────────────────────────────────────────────
   العرض شغّال في الصالة **لحد آخر أغسطس ٢٠٢٦**. مفيش سطح بيتحكم في ده بإيده:
   `activeOffers()` بتقارن تاريخ الرياض النهاردة بـ`until`، ولمّا يعدّي اليوم
   ده العرض بيقع من الـfeed ومن الشريط ومن التقويم، وحارس الأسعار يرجع يرفض
   الرقم ٧٠ تاني — لأنه ببساطة مبقاش موثّق. مطعم بيعلن عرض منتهي بيحرج نفسه،
   وعمر طلب إن الحاجات دي تمشي من غير ما يفتكرها.

   ── قياس الاكتساب ────────────────────────────────────────────────────────
   غرض العرض المعلن هو **اكتساب عملاء جدد**، فالغرض ده لازم يتقاس مش يتفترض.
   العرض مش صنف، فمالوش سطر باسمه في الفاتورة — لكن ليه بصمة: طلب فيه صنف من
   البيتزا وصنف من الباستا وصنف من الكريب، ومجموع التلات سطور **بعد خصم
   الفاتورة** يساوي ٧٠. شوف offerImpact() تحت لحدود الطريقة دي بالظبط.
═══════════════════════════════════════════════════════════════════════════ */

/* بنستورد قواعد الأعمال من analytics.js بدل ما نكتب نسخة تانية منها. تعريفين
   لـ«ده بيع» كلّفوا المشروع خطأ ١٫٩٪ مرة قبل كده — مش هنكررها. أما menuRows
   فبتوصل من index.js في deps عشان ما يبقاش فيه استيراد دائري مع catalog.js
   (اللي بيستورد activeOffers من هنا). */
import {
  SALES_ONLY, IDENT_SQL, FIRST_ORDER_DAY_CTE, deliverySql, TZ, BIZ_DAY_START_HOUR,
} from "./analytics.js";

export const DINE_IN_NOTE = "داخل الصالة فقط";
// أول يوم فيه سطور فواتير محفوظة (ts_order_items). قبله القياس مستحيل مش
// ضعيف — الطلبات موجودة لكن من غير أصنافها.
export const ITEMS_FROM = "2026-05-01";

/* ── العروض ────────────────────────────────────────────────────────────────
   `catalogTitle` هو الاسم اللي بيتكتب في feed.csv وفي التصميم بالظبط — أي
   اختلاف حرف واحد بين الاتنين معناه إن حارس الأسعار مش هيلاقي الصنف ويرفض،
   وده تصرف صح منه. خلّي الاسمين واحد.
   `components[].category` لازم تكون نفس قيمة `product_type` في الكتالوج
   (اللي جاية من صفحات المنيو في TabSense) — عشان قياس الاكتساب تحت يعرف
   الأصناف من نفس المصدر مش من قايمة تانية مكتوبة بالإيد.                  */
export const OFFERS = [
  {
    id: "combo70",
    // id المنتج في كتالوج المنصات. بادئة offer- عشان ما يصطدمش بأي product id
    // حقيقي من TabSense (كلها أرقام).
    productId: "offer-combo70",
    catalogTitle: "بيتزا + باستا + كريب ٧٠ ريال",
    title: "بيتزا + باستا + كريب",
    desc: "اختار بيتزا وباستا وكريب — الثلاثة بـ٧٠ ريال، داخل الصالة فقط",
    emoji: "🍕",
    /* صورة صف الكتالوج. ميتا بتحذّر من أي صف من غير صورة وكارت DPA مش
       بيترسم أصلاً من غيرها، وفي نفس الوقت منعنا استعارة صورة من فئة
       "Offers" (أقرب جار هناك صينية اللمّة — صورة مشاوي على عرض بيتزا
       وباستا وكريب كذب بصري). فالصورة هي بوستر العرض نفسه، والميزة إن
       «داخل الصالة فقط» متحروقة جوّه البكسل — يعني المنصة ما تقدرش تقصّها. */
    image: (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa") + "/static/social/offer-combo70.png",
    price: 70,
    currency: "SAR",
    /* داخل الصالة فقط. مش قابل للتوصيل، ومش قابل للطلب أونلاين — المتجر
       بيعرضه للعِلم بس، من غير زرار طلب. */
    dineInOnly: true,
    goal: "acquisition",
    /* `until` **شامل** لليوم نفسه، وبيتحسب بيوم شغل الرياض (تحت).
       `from` = null عن قصد: عمر قال «شغّال في الصالة لحد آخر أغسطس» ومقالش
       بدأ إمتى. وأقدم طلب لاقيناه بيحمل بصمة العرض كان ٢٠٢٦-٠٧-٢١ — يعني
       أي تاريخ بداية نكتبه هنا هيبقى تخمين، والتخمين في سجلّ الحقيقة
       بيتحوّل بعد شهر لحقيقة. اللي بيتحكم في الظهور هو تاريخ **النهاية**
       بس، وهو الرقم الوحيد اللي عندنا من صاحبه. */
    from: null,
    until: "2026-08-31",
    /* إزاي بيتدق على نقطة البيع: خصم يدوي على كل سطر من التلاتة لحد ما
       المجموع يوصل ٧٠. مفيش صنف اسمه كده في المنيو ومش المفروض يتعمل —
       التسجيل هنا هو اللي بيوثّق السعر، مش صنف وهمي في نقطة البيع. */
    ringsAs: "manual_line_discount",
    /* صف مستقل في feed.csv: العرض ده **مش** صنف في نقطة البيع، فلو ماحطناش
       صفه بإيدينا مش هيبقى موجود في الكتالوج أصلاً. */
    catalogRow: true,
    detect: { mode: "components" },
    components: [
      { category: "Pizza", label: "بيتزا" },
      { category: "Pasta", label: "باستا" },
      { category: "crepes", label: "كريب" },
    ],
  },
  /* ── صينية اللمة ────────────────────────────────────────────────────────
     العرض ده **صنف حقيقي** في نقطة البيع (product id 121، فئة "Offers")،
     على عكس عرض الـ٧٠. يعني الكتالوج بياخده من المنيو لوحده — فلو زوّدنا
     له صف تاني هنا الـfeed هيبقى فيه id مكرّر وميتا بترفض المكرر. عشان كده
     `catalogRow: false`: العرض متسجّل هنا عشان **التاريخ** و**القياس**، مش
     عشان صف كتالوج.

     ليه اتسجّل هنا أصلاً؟ لأن عمر قال بالنص إن العرضين آخرهم ٣١ أغسطس. قبل
     كده كان مكتوب في جدول mk_offers إنه «سارٍ حاليًا — من غير تاريخ انتهاء»،
     وده بقى غلط من ساعة ما اتقال الكلام ده. لمّا العرض يبقى متسجّل هنا،
     `activeOffers()` بتسقطه يوم ١ سبتمبر من الشريط ومن التقويم ومن حارس
     الأسعار — من غير ما حد يفتكر.

     ⚠️ ملحوظة تشغيلية: الصنف نفسه هيفضل في المنيو وفي نقطة البيع بعد ٣١
     أغسطس لحد ما عمر يشيله أو يغيّر سعره — إسقاطه من هنا بيوقّف **الإعلان**
     عنه، مش بيعه. ده مقصود: إحنا ما بنعدّلش منيو المطعم من هنا. */
  {
    id: "lamma",
    productId: "121",
    // نفس الاسم بالحرف اللي في المنيو ونقطة البيع. أي فرق حرف = حارس الأسعار
    // مش هيلاقي الصنف، والقياس تحت مش هيشوف ولا طلب.
    catalogTitle: "صينية اللمة 100 ريال",
    title: "صينية اللمة",
    desc: "١٥ قطعة مشوية — ٦ كفتة + ٣ طرب + ٤ شيش طاووق + ٢ صدور مشوية، ومعاهم حواوشي وبطاطس وأرز وسلطة وطحينة. داخل الصالة فقط",
    emoji: "🍖",
    image: "",                 // صورة الصنف بتيجي من المنيو نفسه
    price: 100,
    currency: "SAR",
    dineInOnly: true,
    goal: "acquisition",
    from: null,
    until: "2026-08-31",
    ringsAs: "pos_item",
    catalogRow: false,
    /* البصمة هنا أبسط بكتير من عرض الـ٧٠: سطر باسم الصنف في الفاتورة. مفيش
       تخمين ولا شباك سعر — يا موجود يا لأ. */
    detect: { mode: "item", names: ["صينية اللمة 100 ريال"] },
    components: [
      { label: "٦ كفتة" }, { label: "٣ طرب" }, { label: "٤ شيش طاووق" },
      { label: "٢ صدور مشوية" }, { label: "حواوشي" },
      { label: "بطاطس وأرز وسلطة وطحينة" },
    ],
  },
];

/* ── هل العرض شغّال النهاردة؟ ───────────────────────────────────────────────
   يوم الرياض مش يوم UTC، و**يوم الشغل** مش يوم التقويم. المطبخ بيقفل حوالي
   الـ٣ الفجر، فعميل قاعد على الطاولة الساعة ١ بليل ٣١ أغسطس لسه في ليلة ٣١
   أغسطس — لو قطعنا العرض عند نص الليل بالظبط كنا هنسحبه من تحت طلب شغّال.
   فبنستعمل نفس ساعة تدوير اليوم اللي بيقيس بيها analytics.js كل حاجة تانية
   (BIZ_DAY_START_HOUR = ٤ صباحًا) بدل ما نخترع تعريف تاني لليوم.
   `sv-SE` بتدّي YYYY-MM-DD جاهزة للمقارنة النصية.                          */
export const riyadhDay = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ })
    .format(new Date(now.getTime() - BIZ_DAY_START_HOUR * 3600_000));

export function offerState(o, now = new Date()) {
  const today = riyadhDay(now);
  const started = !o.from || today >= o.from;
  const ended = !!o.until && today > o.until;
  const daysLeft = o.until
    ? Math.round((Date.parse(`${o.until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
    : null;
  return { today, started, ended, active: started && !ended, daysLeft };
}

/** العروض الشغّالة النهاردة فقط. ده اللي كل سطح المفروض يقرا منه. */
export function activeOffers(now = new Date()) {
  return OFFERS.filter((o) => offerState(o, now).active);
}

/* العروض اللي محتاجة **صف خاص بيها** في feed.csv. العرض اللي هو أصلاً صنف
   في المنيو (صينية اللمة) بيتسحب من المنيو، فصف تاني ليه هنا معناه id مكرر
   في الـfeed — وميتا بترفض المكرر وبتسيب واحد منهم بالعشوائي. */
export const catalogOffers = (now = new Date()) =>
  activeOffers(now).filter((o) => o.catalogRow !== false);

export const offerById = (id) => OFFERS.find((o) => o.id === id) || null;

/* تاريخ الانتهاء بالعربي، جاهز للعرض. بيتحسب هنا مرة واحدة عشان المتجر
   والتصميم والفحص يقولوا نفس الجملة بالحرف — مش كل واحد يترجم التاريخ
   بطريقته. */
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export function untilText(o) {
  if (!o?.until) return "";
  const [, m, d] = o.until.split("-");
  return `حتى ${Number(d)} ${AR_MONTHS[Number(m) - 1]}`;
}

/** الشكل اللي بيتبعت لأي واجهة (المتجر، الحارس، الفحص). */
export function publicOffer(o, now = new Date()) {
  const st = offerState(o, now);
  return {
    id: o.id,
    productId: o.productId,
    title: o.title,
    catalogTitle: o.catalogTitle,
    desc: o.desc,
    emoji: o.emoji,
    price: o.price,
    currency: o.currency,
    dineInOnly: !!o.dineInOnly,
    note: o.dineInOnly ? DINE_IN_NOTE : "",
    orderable: false,          // مش قابل للطلب أونلاين ولا للتوصيل
    components: o.components.map((c) => c.label),
    goal: o.goal,
    from: o.from,
    until: o.until,
    untilText: untilText(o),
    active: st.active,
    expired: st.ended,
    daysLeft: st.daysLeft,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   قياس الاكتساب — بصمة العرض في بيانات الطلبات

   العرض مالوش سطر باسمه، فبندوّر على شكله:
     ١) طلب مبيع (مش void/refund) — نفس تعريف analytics.SALES_ONLY
     ٢) مش طلب تطبيق توصيل — نفس تعريف analytics.deliverySql
     ٣) فيه بالظبط صنف واحد من البيتزا + واحد من الباستا + واحد من الكريب،
        والأصناف دي متعرّفة من الكتالوج الحي (catalog.menuRows) مش من قايمة
        أسماء مكتوبة هنا
     ٤) مجموع التلات سطور بسعر المنيو **ناقص خصم الفاتورة** = ٧٠ ± tolerance

   ── مخاطر الخطأ، بصراحة ──────────────────────────────────────────────────
   • **موجب كاذب:** طلب فيه التلات أصناف بالصدفة وخصم على حاجة تانية خلّى
     المعادلة تقع على ٧٠. محتمل لكنه ضيّق: لازم الأصناف التلاتة يبقوا واحد
     واحد بالظبط **و** الرقم يقع في شباك ريال واحد.
   • **سالب كاذب (أخطر):** خصم الفاتورة عندنا رقم واحد للطلب كله، مش لكل سطر.
     فلو الكاشير خصم على العرض **و** على صنف تاني في نفس الفاتورة، المعادلة
     هتقع تحت ٧٠ والطلب هيضيع من العد. برضه أي طلب من قبل ٢٠٢٦-٠٥ مالوش
     سطور محفوظة أصلاً (ts_order_items بيتملّى من ٢٠٢٦-٠٥ وطالع)، فالعد
     بيبتدي من هناك.
   • الطلب اللي فيه العرض + مشروب بيتعدّ صح، لأن إحنا بنجمع سطور العرض بس
     وبنطرح خصم الفاتورة (اللي كله واقع على العرض).

   ولأن الطريقة تقريبية بطبيعتها، الرد بيرجّع `method` و`caveats` جنب الأرقام
   — الرقم من غير حدوده رقم مضلّل.
═══════════════════════════════════════════════════════════════════════════ */

// تطبيع أسماء الأصناف — نفس اللي في ads.js وprice-guard.js وcatalog.js.
const norm = (s) => String(s || "")
  .replace(/[ً-ْـ]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

/* اسم السطر في الفاتورة بيزوّد على اسم الكتالوج مقاس أو إضافة:
   «بيتزا تشيكن رانش» → «بيتزا تشيكن رانش - وسط». فبنطابق بالبادئة، وأطول
   اسم كتالوج بيطابق هو اللي بيكسب (عشان «بيتزا سوبر كرانشي» ما تتحسبش
   «بيتزا سوبر» لو الاتنين موجودين).                                        */
function categoriseNames(itemNames, catalogRows, wantedCats) {
  const cats = new Set(wantedCats);
  const entries = catalogRows
    .filter((r) => cats.has(r.category))
    .map((r) => ({ n: norm(r.title), cat: r.category }))
    .filter((e) => e.n)
    .sort((a, b) => b.n.length - a.n.length);
  const out = new Map();                       // category → [raw names]
  for (const cat of wantedCats) out.set(cat, []);
  for (const raw of itemNames) {
    const n = norm(raw);
    if (!n) continue;
    const hit = entries.find((e) => n === e.n || n.startsWith(`${e.n} `));
    if (hit) out.get(hit.cat).push(raw);
  }
  return out;
}

/* ── الرقم ما بيسافرش من غير عدم يقينه ──────────────────────────────────────
   «٧٠٪ من طلبات العرض جايّة من عملاء جدد» جملة مغرية جدًا لما تكون مبنية على
   ١٠ طلبات. فبنحسب مع النسبة: فترة ثقة ويلسون ٩٥٪، واحتمال إننا نشوف العدد
   ده (أو أكتر) من الجدد بالصدفة لو العرض ما بيغيّرش حاجة عن معدّل المطعم.
   طالما معدّل المطعم لسه جوّه فترة الثقة، الصح إننا نقول «مبشّر، لسه مش
   مثبت» — مش «العرض نجح».                                                   */
const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
export function confidenceOf(successes, n, baselineRate) {
  if (!n) return null;
  const z = 1.96, ph = successes / n, d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  const lo = Math.max(0, c - h), hi = Math.min(1, c + h);
  const pct = (x) => Math.round(x * 1000) / 10;
  let pValue = null;
  if (baselineRate != null && baselineRate > 0 && baselineRate < 1) {
    let t = 0;
    for (let i = successes; i <= n; i++) {
      t += choose(n, i) * Math.pow(baselineRate, i) * Math.pow(1 - baselineRate, n - i);
    }
    pValue = Math.round(t * 10000) / 10000;
  }
  const beatsBaseline = baselineRate != null && lo > baselineRate;
  return {
    sample: n,
    rate: pct(ph),
    ci95: [pct(lo), pct(hi)],
    baselineRate: baselineRate == null ? null : pct(baselineRate),
    pValue,
    beatsBaseline,
    verdict: beatsBaseline
      ? "الفرق عن معدّل المطعم أكبر من عدم اليقين — يعتمد."
      : `مبشّر لكنه **لسه مش مثبت**: العيّنة ${n} طلب بس، وفترة الثقة `
        + `(${pct(lo)}٪–${pct(hi)}٪) لسه شاملة معدّل المطعم العادي. `
        + "متبنيش قرار ميزانية على الرقم ده لوحده لحد ما العيّنة تكبر.",
  };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, todayISO, DEFAULT_DELIVERY_APPS } = ctx;
  const deliveryApps = deps.deliveryApps || (async () => DEFAULT_DELIVERY_APPS);
  const menuRows = deps.menuRows;

  /* ── العروض الشغّالة (عام) ────────────────────────────────────────────────
     المتجر بينده المسار ده كل ما يفتح. عام عن قصد: العرض نفسه معلن في الشارع
     وعلى المنصات، فمفيش سر نحميه — والسر الوحيد هنا إن الرد **مش** بيرجّع
     عرض منتهي مهما حصل. */
  app.get("/api/offers", (c) => {
    const now = new Date();
    c.header("Cache-Control", "public, max-age=120");
    return c.json({
      ok: true,
      note: DINE_IN_NOTE,
      today: riyadhDay(now),
      offers: activeOffers(now).map((o) => publicOffer(o, now)),
    });
  });

  /* كل العروض بحالتها — بيستعمله حارس الأسعار عشان يفرّق بين «الصنف ده مش
     موجود خالص» و«العرض ده خلص يوم كذا»، والرسالتين مش نفس المشكلة. */
  app.get("/api/offers/all", (c) => {
    const now = new Date();
    return c.json({
      ok: true,
      today: riyadhDay(now),
      offers: OFFERS.map((o) => publicOffer(o, now)),
    });
  });

  /* ── هل العرض بيكتسب فعلاً؟ ─────────────────────────────────────────────── */
  app.get("/api/offers/:id/impact", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const offer = offerById(c.req.param("id"));
    if (!offer) return c.json({ ok: false, error: "عرض غير معروف" }, 404);
    // ٢٠٢٦-٠٥-٠١ = أول شهر فيه سطور فواتير محفوظة. أي مدى أقدم من كده مش
    // قابل للقياس، فمالوش لازمة كافتراضي.
    const from = c.req.query("from") || ITEMS_FROM;
    const to = c.req.query("to") || todayISO();
    /* الشباك ± نص ريال، مش ريال. البصمة أحدّ بكتير مما توقّعنا: على البيانات
       الحالية ±٠٫٠٥ و±٣ بيدّوا **نفس** الطلبات بالظبط — يعني الخصم اليدوي
       بينزل على ٧٠٫٠٠ أو ٧٠٫٠١ ولا حاجة تانية. شباك ضيّق كده بيخلّي الموجب
       الكاذب شبه مستحيل (لازم خصم غير مرتبط يقع في حدود هللة من ٧٠ على تلات
       سطور من تلات فئات بعينها) من غير ما نخسر ولا طلب حقيقي. */
    const tol = Math.abs(Number(c.req.query("tolerance") || 0.5)) || 0.5;
    try {
      return c.json({ ok: true, ...(await offerImpact(offer, { from, to, tol })) });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* ── بصمة العرض في سطور الفواتير ────────────────────────────────────────
     العرضين بصمتهم مختلفة اختلاف جوهري، فالدالة دي بترجّع الجزء المتغيّر بس
     (CTE اسمه `picked` فيه عمود order_id) والباقي مشترك:

       • mode "components" — عرض **مش** صنف في نقطة البيع (عرض الـ٧٠).
         بندوّر على تركيبة: صنف واحد من كل فئة، والمجموع ناقص خصم الفاتورة
         يساوي السعر ± شباك. تقريبية بطبيعتها — شوف caveats.

       • mode "item" — عرض **هو** صنف في نقطة البيع (صينية اللمة، id 121).
         السطر موجود باسمه في الفاتورة، فالبصمة هي الاسم نفسه. مفيش شباك سعر
         ولا خصم يتحسب: العميل يقدر يزوّد مشروبات وحلو على نفس الفاتورة
         والطلب يفضل «طلب صينية». ده مش تساهل — ده الصح: إحنا بنعدّ الطلبات
         اللي فيها العرض، مش الفواتير اللي قيمتها ١٠٠ بالظبط. */
  function detectPicked(offer, { catalogRows, itemNames, push, tol }) {
    const mode = offer.detect?.mode || "components";

    if (mode === "item") {
      /* الأسماء المعلنة في التسجيل + اسم الكتالوج، وبنطابق بالبادئة عشان
         «صينية اللمة 100 ريال - كبيرة» تتحسب. بنطابق على أسماء موجودة فعلاً
         في الفواتير بس، فلو الصنف اتسمّى بشكل تاني خالص الرد بيقول
         measurable: false بدل ما يرجّع صفر ويسيب القارئ يفهمه «فشل». */
      const wanted = [...new Set([...(offer.detect.names || []), offer.catalogTitle])]
        .map(norm).filter(Boolean);
      const matched = itemNames.filter((raw) => {
        const n = norm(raw);
        return wanted.some((w) => n === w || n.startsWith(`${w} `));
      });
      if (!matched.length) {
        return {
          error: `مفيش ولا سطر في الفواتير اسمه «${offer.catalogTitle}» — يا إما الصنف`
            + " اتسمّى بشكل تاني في نقطة البيع، يا إما لسه ماتباعش. القياس مش هيبقى صادق.",
        };
      }
      const pNames = push(matched);
      return {
        itemsUsed: { [offer.catalogTitle]: matched.length },
        matchedNames: matched,
        cte: `picked AS (
          SELECT i.order_id, sum(i.qty) AS units
            FROM ts_order_items i
           WHERE i.amount > 0 AND i.name = ANY(${pNames}::text[])
           GROUP BY 1
        )`,
        method:
          `طلب جوّه المطعم (مش تطبيق توصيل) فيه سطر باسم «${offer.catalogTitle}» في الفاتورة.`
          + " الاسم متطابق مع صنف حقيقي في نقطة البيع، فمفيش استنتاج ولا شباك سعر هنا.",
        caveats: [
          "الطلب بيتعدّ لو فيه الصنف — حتى لو الفاتورة فيها أصناف تانية معاه. ده مقصود:"
          + " متوسط الفاتورة تحت بيقيس **قيمة الطلب اللي فيه العرض**، مش سعر العرض.",
          "سطور الفواتير محفوظة من ٢٠٢٦-٠٥ وطالع؛ أي طلب قبل كده غير قابل للقياس أصلاً.",
          "سطر بقيمة صفر (ضيافة أو تصحيح) مش داخل في العد.",
        ],
      };
    }

    // ── الوضع الافتراضي: التركيبة ──────────────────────────────────────
    const wantedCats = offer.components.map((x) => x.category).filter(Boolean);
    const byCat = categoriseNames(itemNames, catalogRows, wantedCats);
    const lists = wantedCats.map((cat) => byCat.get(cat) || []);
    if (lists.some((l) => !l.length)) {
      return {
        error: `مفيش أصناف متطابقة في الفواتير لواحدة من فئات العرض (${wantedCats
          .map((cat, i) => `${cat}: ${lists[i].length}`).join("، ")}) — القياس مش هيبقى صادق.`,
      };
    }
    const partCase = wantedCats
      .map((cat, i) => `WHEN i.name = ANY(${push(lists[i])}::text[]) THEN '${cat}'`).join(" ");
    const pTol = push(tol);
    const pPrice = push(offer.price);
    return {
      itemsUsed: Object.fromEntries(wantedCats.map((cat, i) => [cat, lists[i].length])),
      cte: `parts AS (
          SELECT i.order_id, CASE ${partCase} END AS part, i.qty, i.amount
            FROM ts_order_items i WHERE i.amount > 0
        ),
        combo AS (
          SELECT order_id, count(DISTINCT part)::int AS parts,
                 sum(qty) AS part_qty, sum(amount) AS part_amount
            FROM parts WHERE part IS NOT NULL GROUP BY 1
        ),
        picked AS (
          SELECT cb.order_id, cb.part_qty AS units
            FROM combo cb JOIN ts_orders po ON po.order_id = cb.order_id
           WHERE cb.parts = ${wantedCats.length}
             AND cb.part_qty = ${wantedCats.length}
             AND abs((cb.part_amount - po.discount_incl) - ${pPrice}::numeric) <= ${pTol}::numeric
        )`,
      method:
        "طلب جوّه المطعم (مش تطبيق توصيل) فيه صنف واحد بالظبط من كل فئة من فئات العرض، "
        + `ومجموع التلات سطور بسعر المنيو ناقص خصم الفاتورة = ${offer.price} ± ${tol} ر.س. `
        + "الأصناف متعرّفة من الكتالوج الحي، مش من قايمة أسماء مكتوبة بالإيد.",
      caveats: [
        "خصم الفاتورة رقم واحد للطلب كله. لو الكاشير خصم على العرض وعلى صنف تاني في نفس"
        + " الفاتورة، المعادلة بتقع تحت السعر والطلب بيضيع من العد — يعني الرقم ده **حد أدنى**.",
        "سطور الفواتير محفوظة من ٢٠٢٦-٠٥ وطالع؛ أي طلب قبل كده غير قابل للقياس أصلاً.",
        "موجب كاذب ممكن لو طلب جمع التلات أصناف صدفة وخصم غير مرتبط وقع في نفس الشباك.",
      ],
    };
  }

  async function offerImpact(offer, { from, to, tol }) {
    const [catalogRows, nameRows, apps] = await Promise.all([
      menuRows(),
      pool.query(`SELECT DISTINCT name FROM ts_order_items WHERE amount > 0`),
      deliveryApps(),
    ]);

    /* ترقيم البارامترات بيتبني وإحنا ماشيين بدل ما يتعدّ بالإيد — العدّ
       اليدوي هو اللي بيكسر أول ما يتزوّد وضع تاني للبصمة. */
    const params = [from, to];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    const det = detectPicked(offer, {
      catalogRows, itemNames: nameRows.rows.map((r) => r.name), push, tol,
    });
    if (det.error) return { measurable: false, why: det.error };
    const pApps = `${push(apps)}::text[]`;

    const sql = `
      WITH ${det.cte},
      hits AS (
        SELECT o.order_id, o.calendar_day, o.total, o.order_option, pk.units,
               ${IDENT_SQL} AS ident
          FROM ts_orders o
          JOIN picked pk ON pk.order_id = o.order_id
          LEFT JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
           AND NOT ${deliverySql(pApps)}
      ),
      ${FIRST_ORDER_DAY_CTE}
      SELECT
        (SELECT count(*) FROM hits)::int AS hits,
        (SELECT COALESCE(sum(units), 0) FROM hits) AS units,
        (SELECT count(*) FROM hits WHERE order_option ILIKE '%dine%')::int AS dine_in_hits,
        (SELECT COALESCE(sum(total), 0) FROM hits) AS hits_revenue,
        (SELECT count(*) FROM hits WHERE ident IS NOT NULL)::int AS hits_identified,
        (SELECT count(DISTINCT ident) FROM hits WHERE ident IS NOT NULL)::int AS hits_people,
        (SELECT count(*) FROM hits h JOIN firsts f ON f.pn = h.ident
          WHERE f.first_day = h.calendar_day)::int AS hits_new,
        (SELECT count(*) FROM hits h JOIN firsts f ON f.pn = h.ident
          WHERE f.first_day < h.calendar_day)::int AS hits_returning,
        (SELECT count(*) FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND NOT ${deliverySql(pApps)})::int AS all_inhouse_orders,
        (SELECT COALESCE(avg(o.total), 0) FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND NOT ${deliverySql(pApps)}) AS all_inhouse_avg,
        (SELECT count(*) FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
           JOIN firsts f ON f.pn = ${IDENT_SQL}
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND NOT ${deliverySql(pApps)}
            AND f.first_day = o.calendar_day)::int AS all_inhouse_new,
        (SELECT count(*) FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND NOT ${deliverySql(pApps)}
            AND ${IDENT_SQL} IS NOT NULL)::int AS all_inhouse_identified`;

    const r = (await pool.query(sql, params)).rows[0];

    const days = (await pool.query(`
      WITH ${det.cte}
      SELECT o.calendar_day AS day, count(*)::int AS orders,
             COALESCE(sum(pk.units), 0) AS units,
             COALESCE(sum(o.total), 0) AS revenue
        FROM ts_orders o JOIN picked pk ON pk.order_id = o.order_id
       WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
         AND NOT ${deliverySql(pApps)}
       GROUP BY 1 ORDER BY 1`, params)).rows;

    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const money = (v) => Math.round(n(v) * 100) / 100;
    const hits = n(r.hits);
    const ident = n(r.hits_identified);
    const allIdent = n(r.all_inhouse_identified);
    const st = offerState(offer);

    return {
      measurable: true,
      offer: publicOffer(offer),
      window: { from, to, tolerance: offer.detect?.mode === "item" ? null : tol },
      itemsUsed: det.itemsUsed,
      matchedNames: det.matchedNames || undefined,
      found: {
        orders: hits,
        // «قطع مباعة» ليها معنى في وضع الصنف بس. في وضع التركيبة الرقم ده
        // بيبقى دايمًا عدد الفئات (٣) — يعني مش معلومة، فبنسكت بدل ما نقوله.
        units: offer.detect?.mode === "item" ? n(r.units) : null,
        dineInTagged: n(r.dine_in_hits),
        takeAwayTagged: hits - n(r.dine_in_hits),
        revenue: money(r.hits_revenue),
        avgTicket: hits ? money(n(r.hits_revenue) / hits) : null,
        identified: ident,
        people: n(r.hits_people),
        newCustomerOrders: n(r.hits_new),
        returningCustomerOrders: n(r.hits_returning),
        newShareOfIdentified: ident ? Math.round((n(r.hits_new) / ident) * 1000) / 10 : null,
        confidence: confidenceOf(
          n(r.hits_new), ident,
          allIdent ? n(r.all_inhouse_new) / allIdent : null),
      },
      baseline: {
        label: "كل الطلبات جوّه المطعم في نفس المدة (من غير التطبيقات)",
        orders: n(r.all_inhouse_orders),
        avgTicket: money(r.all_inhouse_avg),
        identified: allIdent,
        newCustomerOrders: n(r.all_inhouse_new),
        newShareOfIdentified: allIdent
          ? Math.round((n(r.all_inhouse_new) / allIdent) * 1000) / 10 : null,
      },
      /* الفرق في متوسط الفاتورة — الرقم اللي المالك بيسأل عنه فعلاً:
         «الطلب اللي فيه العرض بيفرق قد إيه عن الطلب العادي؟» */
      lift: hits && n(r.all_inhouse_avg) ? {
        avgTicketVsNormal: money(n(r.hits_revenue) / hits - n(r.all_inhouse_avg)),
        avgTicketMultiple: Math.round((n(r.hits_revenue) / hits / n(r.all_inhouse_avg)) * 100) / 100,
      } : null,
      daily: days.map((d) => ({
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        orders: n(d.orders),
        units: offer.detect?.mode === "item" ? n(d.units) : null,
        revenue: money(d.revenue),
      })),
      /* حاجات الرقم بيقولها والمالك المفروض يشوفها، مش استنتاجات إحنا
         بنعملها نيابة عنه. */
      flags: [
        ...(hits && hits - n(r.dine_in_hits) > 0
          ? [`العرض متسجّل «${DINE_IN_NOTE}» بس ${hits - n(r.dine_in_hits)} من ${hits}`
             + " طلب اتدقّوا على نقطة البيع كـTake away — يا إما الكاشير بيختار الخيار الغلط،"
             + " يا إما العرض بيتباع فعلاً خارج الصالة. الاتنين محتاجين قرار من المالك."]
          : []),
        ...(hits === 0
          ? ["مفيش ولا طلب بالبصمة دي في المدة — يا إما العرض مش بيتباع، يا إما الكاشير"
             + " بيدقّه بطريقة تانية خالص. متقولش إنه فشل قبل ما تسأل الكاشير."]
          : []),
        ...(st.ended
          ? [`العرض ده انتهى يوم ${offer.until} — الأرقام دي تاريخ، مش حالة شغّالة.`]
          : st.daysLeft != null && st.daysLeft <= 7
            ? [`فاضل ${st.daysLeft} يوم على انتهاء العرض (${offer.until}).`
               + " قرار التمديد أو الإيقاف لازم يتاخد قبل اليوم ده، مش بعده."]
            : []),
      ],
      method: det.method,
      caveats: [
        ...det.caveats,
        "«جديد» هنا بتعريف analytics.js نفسه: طلب في المدة و أول يوم طلب له = يوم الطلب."
        + " الطلبات اللي مالهاش رقم موبايل مش داخلة في نسبة الجدد (اتحسبت على المعرَّفين بس).",
      ],
    };
  }

  console.log(`[offers] routes ready — ${activeOffers().length}/${OFFERS.length} عرض شغّال`);
  return { activeOffers, catalogOffers, offerById, publicOffer, offerImpact };
}
