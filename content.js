/* ═══════════════════════════════════════════════════════════════════════════
   CONTENT — تقويم واحد لكل قنوات المحتوى، وناشر انستجرام بتاعنا.

   المشكلة اللي الملف ده بيحلّها: عمر قال «الانستجرام منزلش عليه حاجة»
   والحقيقة إنه نزل — ٣ بوستات اتنشروا فعلاً. المشكلة مكانتش في النشر،
   المشكلة إنه معندهوش أي طريقة يشوف بيها إيه المجدول وإيه اللي طلع. العمى
   ده هو الباج. فالملف ده بيبني «مصدر حقيقة» واحد:

   ١) جدول content_posts — كل بوست على أي قناة (فيسبوك/انستجرام/تيك توك/
      سناب) بحالته وميعاده وصورته ورابطه بعد النشر. البوستات اللي موجودة
      أصلاً على فيسبوك وانستجرام بتتسحب جوّه الجدول ده (sync) عشان التقويم
      يقول الحقيقة من أول يوم، مش يبدأ فاضي.

   ٢) ناشر انستجرام. انستجرام API ملهوش جدولة أصلاً — عشان كده البوستات
      اتنشرت بالإيد. فبنعمل الجدولة بنفسنا: عامل بيلف كل ٥ دقايق، ياخد
      الصفوف اللي ميعادها جه، ينشرها عن طريق /media ثم /media_publish،
      ويكتب الرابط أو سبب الفشل في نفس الصف. الحجز (claimed_at) بيمنع
      النشر مرتين لو العامل اشتغل مرتين بالغلط.

   ٣) تعديل بوست فيسبوك مجدول بيتبعت لفيسبوك كمان (POST /{post-id})، ولو
      المنصة رفضت بنرجّع نص رفضها زي ما هو — مش «فشل».

   ٤) استضافة الصور: انستجرام لازم ياخد رابط https عام لصورة JPEG. فبنخزن
      الصور في الداتابيز ونقدّمها على /api/content/media/:id (مسار عام من
      غير توكن). ولو الصورة موجودة أصلاً على أي رابط عام (زي صور المتجر على
      order.o2m8.me/static/social/) بنستعملها زي ما هي من غير رفع.

   ٥) أفكار تيك توك — جدول منفصل. النشر على تيك توك بالإيد لحد دلوقتي لأن
      طلب الـ API بتاع الحساب اترفض، والواجهة بتقول ده صراحة.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { httpJson } from "./ads.js";
import { activeOffers, offerById } from "./offers.js";

/* أي فكرة محتوى بتبيع عرض له تاريخ انتهاء. الربط بس — تعريف العرض نفسه
   (السعر، الصالة، التاريخ) عند offers.js ومش بيتكرر هنا.

   ملحوظة مقصودة: `tt_delivery_vs_hall` **مش** هنا. الفيديو ده بيشرح ليه
   العروض داخل الصالة، وصينية اللمّة عرض دايم — فهو بيفضل صالح بعد ما عرض
   الـ٧٠ يخلص. */
const IDEA_OFFER = {
  tt_70_combo: "combo70",
};

const newId = (p) => `${p}_${crypto.randomBytes(6).toString("hex")}`;

const GRAPH_VER = () => (process.env.META_API_VERSION || "v25.0").trim();
const GRAPH = () => `https://graph.facebook.com/${GRAPH_VER()}`;
const FB_PAGE_ID = () => (process.env.FB_PAGE_ID || "1193489887177708").trim();
const IG_USER_ID = () => (process.env.IG_USER_ID || "17841414510113806").trim();
const USER_TOKEN = () => (process.env.META_CAPI_TOKEN || "").trim();

/* الرابط العام اللي انستجرام هيجيب منه الصورة. لازم يكون من برّه — سيرفرات
   ميتا بتحمّل الصورة بنفسها، فـ localhost مش هينفع. */
const PUBLIC_BASE = () =>
  (process.env.CONTENT_PUBLIC_BASE || process.env.COOLIFY_URL || "https://freshcuts-api.o2m8.me")
    .trim().replace(/\/+$/, "");

const CHANNELS = ["facebook", "instagram", "tiktok", "snapchat"];
const STATUSES = ["draft", "scheduled", "published", "failed", "cancelled"];

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/* كل قد إيه العامل بيلف. ٥ دقايق = أسوأ تأخير عن الميعاد ٥ دقايق، وده
   مقبول لبوست مطعم ورخيص في عدد النداءات على ميتا. المزامنة أبطأ (ساعة)
   لأن غرضها تجديد روابط صور فيسبوك الموقّتة والتقاط أي بوست اتعمل من
   على فيسبوك نفسه. */
export const WORKER_MINUTES = Math.max(1, Number(process.env.CONTENT_WORKER_MINUTES || 5));
export const SYNC_MINUTES = Math.max(10, Number(process.env.CONTENT_SYNC_MINUTES || 60));

/* أفكار تيك توك الأولى — كل فكرة مربوطة بحقيقة من المطعم نفسه (صنف من
   الأكثر مبيعًا، أو عرض حقيقي، أو ميزة مفيش حد تاني في الحي عنده). بتتزرع
   مرة واحدة وبعدها الجدول هو المرجع؛ لو عمر عدّل أو مسح، الزرع مش بيرجّعها. */
const SEED_IDEAS = [
  {
    id: "tt_lamma_pour", title: "صينية اللمة — اللقطة اللي بتوقّف الإصبع",
    hook: "صينية بـ١٠٠ ريال… عدّ معايا وش فيها 👀",
    script: "الكاميرا فوق الصينية من أول لحظة. صوت واحد يعدّ بالعربي وإيد بتشاور: «٦ كفتة… ٣ طرب… ٤ شيش طاووق… صدرين مشوية… وحواوشي». آخر ٣ ثواني: صبّة الطحينة على البطاطس + جملة «داخل الصالة بس — ١٠٠ ريال».",
    shots: "١) لقطة علوية للصينية كاملة ٢) كلوز على كل صنف مع العدّ ٣) صبّة طحينة سلو-موشن ٤) لقطة السفرة وإيدين بتمدّ",
    dish: "صينية اللمة", length_sec: 22, status: "idea",
    fact: "عرض حقيقي: صينية اللمة ١٠٠ ر.س داخل الصالة — ٦ كفتة + ٣ طرب + ٤ شيش طاووق + ٢ صدور مشوية + حواوشي + بطاطس وأرز وسلطة وطحينة",
    hashtags: "#صينية_اللمة #فريش_كاتس #مطاعم_جدة #حي_السلامة #مشاوي #لمة_العيال", sort: 1,
  },
  {
    id: "tt_late_night", title: "٢ الفجر — المشواة لسه شغالة",
    hook: "الساعة ٢ الفجر في حي السلامة… وش مفتوح؟",
    script: "تصوير ليلي: الشارع فاضي، اللوحات مطفية واحدة ورا التانية. تقطع على لوحة فريش كاتس منوّرة والفحم شغّال. جملة على الشاشة: «مفتوحين لين ٢ — والخميس والجمعة لين ٣».",
    shots: "١) الشارع الفاضي ليلاً ٢) بان على المطعم المنوّر ٣) الفحم والشوي كلوز ٤) طبق يوصل الطاولة",
    dish: "ميكس جريل", length_sec: 18, status: "idea",
    fact: "المطعم مفتوح لين ٢ الفجر، والخميس والجمعة لين ٣ — مفيش مطعم تاني في حي السلامة بيقفل بدري كده",
    hashtags: "#سهرات_جدة #مطاعم_مفتوحة #فريش_كاتس #حي_السلامة #جدة_بالليل", sort: 2,
  },
  {
    id: "tt_kilo_price", title: "مقارنة سعر الكيلو — الأرقام على الشاشة",
    hook: "نفس الكيلو… بنص السعر. جد.",
    script: "سبليت سكرين: يمين سعر الكيلو عندنا، شمال متوسط المنطقة. الأرقام تظهر واحد ورا التاني. آخر لقطة: الكيلو مترصّ على الصينية والدخان طالع. مفيش مبالغة — الأرقام بس.",
    shots: "١) الكيلو على الميزان ٢) جرافيك الأرقام ٣) الكيلو مشوي على الصينية",
    dish: "كيلو مشكل", length_sec: 20, status: "idea",
    fact: "أسعار الكيلو عندنا أقل من المنافسين بـ٤٠٪ إلى ٥٦٪",
    hashtags: "#أسعار_الكيلو #مشاوي_جدة #فريش_كاتس #وفّر #مطاعم_جدة", sort: 3,
  },
  {
    id: "tt_banna_casserole", title: "بنا تشيكن كازرول — سحبة الجبنة",
    hook: "لو الجبنة ما انسحبت، ما نستاهل المتابعة 🧀",
    script: "الطبق طالع سخن من الفرن، بخار. ملعقة تدخل وتطلع بسحبة جبنة طويلة بالسلو-موشن. صوت الطقطقة عالي. آخر فريم: اسم الطبق والسعر.",
    shots: "١) الطبق طالع من الفرن ٢) كلوز على الوش وهو بيغلي ٣) سحبة الجبنة سلو-موشن ٤) اللقمة الأولى",
    dish: "بنا تشيكن كازرول", length_sec: 15, status: "idea",
    fact: "بنا تشيكن كازرول من أكثر ٥ أصناف مبيعًا في المطعم",
    hashtags: "#بنا_تشيكن #كازرول #جبنة #فريش_كاتس #مطاعم_جدة", sort: 4,
  },
  {
    id: "tt_half_chicken", title: "وجبة نص دجاجة — من الفحم للطبق في فيديو واحد",
    hook: "نص دجاجة… من الفحم لطبقك",
    script: "تايم-لابس قصير: الدجاجة على الفحم، تتقلب، تتفرّد، تتحطّ على الرز مع السلطة والطحينة. بدون كلام — صوت الفحم بس، وجملة واحدة في الآخر بالسعر.",
    shots: "١) الدجاجة نية على الشبك ٢) تايم-لابس الشوي ٣) التفريد ٤) الطبق كامل من فوق",
    dish: "وجبة نصف دجاجة", length_sec: 25, status: "idea",
    fact: "وجبة نصف دجاجة من أكثر ٥ أصناف مبيعًا",
    hashtags: "#نص_دجاجة #فحم #فريش_كاتس #مطاعم_جدة #حي_السلامة", sort: 5,
  },
  {
    id: "tt_crepe_battle", title: "كريب دجاج ولا كريب لحوم؟ — تصويت",
    hook: "اختار: دجاج ولا لحوم؟ الكومنتات تحكم 🥊",
    script: "الاتنين جنب بعض على الرخامة. كل واحد بياخد ٥ ثواني: الحشوة، اللف، القطعة المقطوعة والحشو بيطلع. تنتهي بسؤال مباشر للكاميرا وتثبيت كومنت للتصويت.",
    shots: "١) الاتنين جنب بعض ٢) حشو الدجاج ٣) حشو اللحوم ٤) قطعة عرضية للاتنين",
    dish: "كريب ميكس دجاج / كريب ميكس لحوم", length_sec: 20, status: "idea",
    fact: "كريب ميكس دجاج وكريب ميكس لحوم الاتنين من أكثر ٥ أصناف مبيعًا — فالمقارنة بينهم مقارنة حقيقية مش مفتعلة",
    hashtags: "#كريب #فريش_كاتس #مطاعم_جدة #دجاج_ولا_لحوم #حي_السلامة", sort: 6,
  },
  {
    id: "tt_70_combo", title: "٧٠ ريال لثلاثة — بيتزا وباستا وكريب",
    hook: "٧٠ ريال… وثلاث أطباق على الطاولة",
    script: "الطاولة فاضية. طبق ينزل، وطبق، وتالت — كل واحد مع بيت من الصوت. الكاميرا تطلع لفوق وتبيّن الثلاثة مع بعض ورقم ٧٠ على الشاشة. جملة: «داخل الصالة بس».",
    shots: "١) طاولة فاضية ٢) نزول ٣ أطباق واحد ورا التاني ٣) لقطة علوية للثلاثة ٤) إيدين بتاخد من كل طبق",
    dish: "بيتزا + باستا + كريب", length_sec: 18, status: "idea",
    fact: "عرض حقيقي: بيتزا + باستا + كريب بـ٧٠ ر.س داخل الصالة",
    hashtags: "#عروض_جدة #بيتزا #باستا #كريب #فريش_كاتس #مطاعم_جدة", sort: 7,
  },
  {
    id: "tt_mix_grill_37", title: "٣٧ ريال — وش تجيب بالظبط؟",
    hook: "٣٧ ريال. شوف وش تجيب 👇",
    script: "طبق ميكس جريل على الطاولة والكاميرا فوقه. إيد بتشاور على كل صنف واسمه يظهر: كفتة، طرب، صدور مشوية، شيش طاووق — وتحتهم الرز والسلطة والطحينة. آخر فريم: الرقم ٣٧ كبير.",
    shots: "١) لقطة علوية ٢) كلوز مع أسماء الأصناف ٣) لقمة",
    dish: "وجبة ميكس جريل", length_sec: 16, status: "idea",
    fact: "وجبة ميكس جريل من أكثر ٥ أصناف مبيعًا — ونُشر سعرها ٣٧ ر.س في إعلانات الصفحة",
    hashtags: "#ميكس_جريل #فريش_كاتس #مطاعم_جدة #مشاوي #حي_السلامة", sort: 8,
  },
  {
    id: "tt_nothing_prepped", title: "ما عندنا شي محضّر — الرد على السؤال",
    hook: "«اللحمة عندكم متجمدة؟» — تعال شوف بنفسك",
    script: "لقطة واحدة متواصلة (one-take) من الثلاجة للتقطيع للشبك: لحمة طازة تتقطّع قدام الكاميرا، تتتبّل، تروح على الفحم على طول. مفيش قطع — ده اللي بيخلي الفيديو مقنع.",
    shots: "لقطة واحدة متواصلة ٣٠ ثانية: ثلاجة → تقطيع → تتبيل → فحم",
    dish: "مشاوي طازة", length_sec: 30, status: "idea",
    fact: "المطعم بيشوي بعد الطلب — مفيش أصناف محضّرة مقدّمًا، وده مكتوب في محتوى الصفحة",
    hashtags: "#طازة #مشاوي #فريش_كاتس #مطاعم_جدة #وراء_الكواليس", sort: 9,
  },
  {
    id: "tt_pov_2am", title: "POV: جعان ٢ الفجر",
    hook: "POV: الساعة ٢ وأنت جعان في جدة",
    script: "بوف من نظر السواق: شارع فاضي، خرايط، مطاعم مقفولة. يوقف قدام فريش كاتس. باب يفتح، ريحة وصوت الفحم. يقعد، الطبق يوصل. مفيش تعليق صوتي — تراك ترند بس.",
    shots: "١) داخل العربية ليلاً ٢) لوحات مطاعم مقفولة ٣) الوقوف والدخول ٤) الطبق على الطاولة",
    dish: "أي طبق مشاوي", length_sec: 22, status: "idea",
    fact: "مفيش مطعم في حي السلامة بيفضل فاتح لـ٢ الفجر غيرنا",
    hashtags: "#POV #سهرات_جدة #فريش_كاتس #حي_السلامة #مطاعم_مفتوحة", sort: 10,
  },
  {
    id: "tt_family_reaction", title: "ردّة فعل السفرة على صينية اللمة",
    hook: "حطّينا الصينية… وشوفوا ردّة الفعل",
    script: "كاميرا ثابتة على السفرة والعيلة قاعدة. الصينية تنزل في النص. الكاميرا تمسك الوشوش في اللحظة دي. من غير تمثيل — عميل حقيقي بإذنه.",
    shots: "١) السفرة قبل ٢) نزول الصينية ٣) الوشوش ٤) الإيدين بتمد",
    dish: "صينية اللمة", length_sec: 20, status: "idea",
    fact: "صينية اللمة عرض صالة حقيقي بـ١٠٠ ر.س — والفيديو محتاج إذن العميل قبل النشر",
    hashtags: "#لمة #ردة_فعل #فريش_كاتس #مطاعم_جدة_عوائل #حي_السلامة", sort: 11,
  },
  {
    id: "tt_price_menu_scroll", title: "قايمة الأسعار — سكرول واحد بدون كلام",
    hook: "الأسعار كلها في ١٥ ثانية — من غير ما تسأل",
    script: "المنيو مفرود على الطاولة والكاميرا بتعدّي عليه ببطء، والأسعار مكبّرة على الشاشة صنف صنف. آخر فريم: العنوان والواتساب.",
    shots: "١) المنيو من فوق ٢) سكرول بطيء ٣) كارت العنوان",
    dish: "المنيو كامل", length_sec: 15, status: "idea",
    fact: "الأسعار المعروضة لازم تتطابق مع أسعار الكاشير — المصدر جدول العروض في مركز التسويق",
    hashtags: "#منيو #أسعار #فريش_كاتس #مطاعم_جدة #حي_السلامة", sort: 12,
  },
  {
    id: "tt_hawawshi", title: "الحواوشي — الفرقعة",
    hook: "الصوت ده لوحده يكفي 🔊",
    script: "حواوشي طالع سخن، يتقطّع بالنص والبخار طالع. صوت القرمشة عالي جدًا (ASMR). مفيش موسيقى في أول ٣ ثواني — الصوت الطبيعي بس.",
    shots: "١) الحواوشي طالع من الفرن ٢) القطع بالنص كلوز ٣) اللقمة",
    dish: "حواوشي مصري", length_sec: 14, status: "idea",
    fact: "الحواوشي المصري جزء من صينية اللمة — فالفيديو ده بيخدم العرض كمان",
    hashtags: "#حواوشي #ASMR #فريش_كاتس #مطاعم_جدة #أكل_مصري", sort: 13,
  },
  {
    id: "tt_delivery_vs_hall", title: "ليه العرض داخل الصالة بس؟ — رد صريح",
    hook: "ناس كتير سألت: ليه العرض مش على التوصيل؟",
    script: "المدير قدام الكاميرا، لقطة واحدة، يرد بصراحة: العروض دي بسعر التكلفة تقريبًا، وعمولة تطبيقات التوصيل بتاكلها. تعال الصالة تاخدها بسعرها. نبرة هادية، من غير هجوم على حد.",
    shots: "لقطة واحدة ثابتة للمدير، خلفية الصالة",
    dish: "—", length_sec: 28, status: "idea",
    fact: "العرضين (صينية اللمة ١٠٠ وبيتزا+باستا+كريب ٧٠) داخل الصالة فقط",
    hashtags: "#شفافية #عروض #فريش_كاتس #مطاعم_جدة #حي_السلامة", sort: 14,
  },
];

/* ── قراءة أبعاد الصورة من البايتات نفسها ────────────────────────────────
   محتاجينها عشان نحذّر قبل ما نحرق حصة النشر: انستجرام بيرفض أي صورة نسبتها
   برّه ٤:٥ → ١.٩١:١. مفيش مكتبة صور في المشروع، والهيدر بيتقرا في سطور. */
function imageInfo(buf) {
  if (!buf || buf.length < 24) return { kind: "unknown" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: "png", mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 ما عدا DHT(C4) و JPG(C8) و DAC(CC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { kind: "jpeg", mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { kind: "jpeg", mime: "image/jpeg" };
  }
  if (buf.slice(0, 3).toString("latin1") === "GIF") return { kind: "gif", mime: "image/gif" };
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
    return { kind: "webp", mime: "image/webp" };
  }
  return { kind: "unknown" };
}

/* شروط انستجرام على صورة الفيد. بنرجّع تحذيرات نصّية بالعربي — الواجهة
   بتعرضها قبل ما البوست يتجدول، والعامل بيرفض النشر لو فيه خطأ قاطع. */
function igImageProblems({ mime, width, height, url }) {
  const bad = [];
  if (url && !/^https:\/\//i.test(url)) bad.push("انستجرام لازم رابط https — الرابط ده مش https");
  if (mime && !/jpe?g/i.test(mime)) bad.push(`انستجرام بيقبل JPEG بس للصور — الصورة دي ${mime}`);
  if (width && height) {
    const ar = width / height;
    if (ar < 0.8 - 1e-6) bad.push(`النسبة ${ar.toFixed(2)} أضيق من ٤:٥ (٠٫٨٠) — انستجرام هيرفضها`);
    if (ar > 1.91 + 1e-6) bad.push(`النسبة ${ar.toFixed(2)} أعرض من ١٫٩١:١ — انستجرام هيرفضها`);
  }
  return bad;
}

/* الكابشن المعروض للناس = النص + الهاشتاجات. بنفصلهم في الجدول عشان
   التعديل يبقى أسهل، وبنلمّهم تاني وقت النشر. */
function fullCaption(row) {
  const cap = String(row.caption || "").trim();
  const tags = String(row.hashtags || "").trim();
  if (!tags) return cap;
  if (!cap) return tags;
  return `${cap}\n\n${tags}`;
}

/* العكس، وقت الاستيراد: لو آخر سطر في البوست كله هاشتاجات نفصله. لمّة
   الاتنين تاني بتطلع نفس النص بالحرف، فالتعديل مش بيضيّع حاجة. */
function splitCaption(text) {
  const s = String(text || "");
  const lines = s.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) return { caption: s.trim(), hashtags: "" };
  const last = lines[i].trim();
  const onlyTags = last.length > 0 && last.split(/\s+/).every((w) => w.startsWith("#"));
  if (!onlyTags) return { caption: s.trim(), hashtags: "" };
  return { caption: lines.slice(0, i).join("\n").trim(), hashtags: last };
}

export function register(app, ctx) {
  const { pool, requireAdmin, jb } = ctx;

  /* ══ الجداول ══════════════════════════════════════════════════════════ */
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS content_posts (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        caption TEXT NOT NULL DEFAULT '',
        hashtags TEXT NOT NULL DEFAULT '',
        media_url TEXT NOT NULL DEFAULT '',
        media_local_path TEXT NOT NULL DEFAULT '',
        asset_id TEXT,
        external_id TEXT,
        permalink TEXT NOT NULL DEFAULT '',
        error_text TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'local',
        claimed_at TIMESTAMPTZ,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS content_posts_ext_idx
        ON content_posts(channel, external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS content_posts_when_idx
        ON content_posts(COALESCE(published_at, scheduled_at) DESC);
      CREATE INDEX IF NOT EXISTS content_posts_due_idx
        ON content_posts(channel, status, scheduled_at);

      CREATE TABLE IF NOT EXISTS content_media (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT 'image/jpeg',
        bytes BYTEA NOT NULL,
        size INT NOT NULL DEFAULT 0,
        width INT,
        height INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS content_tiktok_ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        hook TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL DEFAULT '',
        shots TEXT NOT NULL DEFAULT '',
        dish TEXT NOT NULL DEFAULT '',
        length_sec INT NOT NULL DEFAULT 20,
        status TEXT NOT NULL DEFAULT 'idea',
        fact TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        hashtags TEXT NOT NULL DEFAULT '',
        permalink TEXT NOT NULL DEFAULT '',
        sort INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS content_sync_runs (
        id TEXT PRIMARY KEY,
        ok BOOL NOT NULL DEFAULT false,
        summary JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      /* ══ إقرار الصنف على الصورة ══════════════════════════════════════
         يوم ١٤ أغسطس ٢٠٢٦ اتنشر بوستر مكتوب عليه «صينية اللمــة ١٠٠ ريال»
         وصورته **نص دجاجة على رز** — صنف تاني بـ٢٥ ريال. الصورة ماكانش
         عليها أي بيان بتقول إنها بتوري إيه، فمافيش فحص كان يقدر يمسكها.
         الأعمدة دي هي البيان: أنهي صنف، إيه مصادره، واتعمل رندر إمتى.
         asset-guard.js في مشروع التصاميم هو اللي بيملاها. */
      ALTER TABLE content_media ADD COLUMN IF NOT EXISTS dish TEXT NOT NULL DEFAULT '';
      ALTER TABLE content_media ADD COLUMN IF NOT EXISTS dish_claim TEXT NOT NULL DEFAULT '';
      ALTER TABLE content_media ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE content_media ADD COLUMN IF NOT EXISTS declared_at TIMESTAMPTZ;
    `);
    for (const i of SEED_IDEAS) {
      await pool.query(
        `INSERT INTO content_tiktok_ideas
           (id, title, hook, script, shots, dish, length_sec, status, fact, hashtags, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [i.id, i.title, i.hook, i.script, i.shots, i.dish, i.length_sec, i.status, i.fact, i.hashtags, i.sort]
      );
    }
  }
  ensureSchema()
    .then(() => console.log("[content] schema ready"))
    .catch((e) => console.error("[content] schema failed:", e.message));

  /* ══ توكن الصفحة ══════════════════════════════════════════════════════
     توكن المستخدم اللي في البيئة مش بيصلح للنشر باسم الصفحة — لازم توكن
     صفحة. بنجيبه مرة ونحتفظ بيه ساعة في الذاكرة (مش في الداتابيز، عشان
     ما يتخزّنش سر على القرص من غير داعي). */
  let pageTokenCache = { token: "", at: 0, err: "" };
  async function pageToken() {
    if (pageTokenCache.token && Date.now() - pageTokenCache.at < 3600_000) return pageTokenCache.token;
    const t = USER_TOKEN();
    if (!t) { pageTokenCache = { token: "", at: Date.now(), err: "META_CAPI_TOKEN غير مضبوط" }; return ""; }
    const r = await httpJson(`${GRAPH()}/${FB_PAGE_ID()}?fields=access_token&access_token=${encodeURIComponent(t)}`);
    const tok = r.json?.access_token || "";
    pageTokenCache = {
      token: tok, at: Date.now(),
      err: tok ? "" : (r.json?.error?.message || r.error || `HTTP ${r.status}`),
    };
    return tok;
  }
  const graphErr = (r) => r.json?.error?.message || r.json?.error?.error_user_msg || r.error || `HTTP ${r.status}`;

  /* ══ الصفوف → JSON ════════════════════════════════════════════════════ */
  const postRow = (r) => ({
    id: r.id,
    channel: r.channel,
    status: r.status,
    scheduledAt: r.scheduled_at,
    publishedAt: r.published_at,
    caption: r.caption || "",
    hashtags: r.hashtags || "",
    mediaUrl: r.media_url || "",
    mediaLocalPath: r.media_local_path || "",
    assetId: r.asset_id || "",
    externalId: r.external_id || "",
    permalink: r.permalink || "",
    errorText: r.error_text || "",
    notes: r.notes || "",
    origin: r.origin || "local",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const ideaRow = (r) => ({
    id: r.id, title: r.title, hook: r.hook || "", script: r.script || "",
    shots: r.shots || "", dish: r.dish || "", lengthSec: r.length_sec || 0,
    status: r.status, fact: r.fact || "", caption: r.caption || "",
    hashtags: r.hashtags || "", permalink: r.permalink || "",
    sort: r.sort || 0, updatedAt: r.updated_at,
  });

  /* ══ ١) التقويم ═══════════════════════════════════════════════════════
     كل القنوات في رد واحد مرتّب بالوقت الفعلي للبوست (وقت النشر لو اتنشر،
     وإلا وقت الجدولة). المسودات من غير ميعاد بتيجي في الآخر. */
  app.get("/api/content/calendar", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = c.req.query("from");   // YYYY-MM-DD
    const to = c.req.query("to");
    const channel = c.req.query("channel");
    const status = c.req.query("status");
    const where = [];
    const params = [];
    if (from) { params.push(`${from} 00:00:00+03`); where.push(`COALESCE(published_at, scheduled_at) >= $${params.length}`); }
    if (to)   { params.push(`${to} 23:59:59+03`);   where.push(`COALESCE(published_at, scheduled_at) <= $${params.length}`); }
    if (channel && CHANNELS.includes(channel)) { params.push(channel); where.push(`channel = $${params.length}`); }
    if (status && STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
    // المسودات من غير ميعاد لازم تفضل ظاهرة حتى لو المدى محدّد
    const dateFilter = where.length ? `(${where.join(" AND ")}) OR (scheduled_at IS NULL AND published_at IS NULL)` : "TRUE";
    const r = await pool.query(
      `SELECT * FROM content_posts WHERE ${dateFilter}
        ORDER BY COALESCE(published_at, scheduled_at) DESC NULLS LAST, created_at DESC
        LIMIT 500`, params);

    const counts = await pool.query(
      `SELECT channel, status, count(*)::int AS n FROM content_posts GROUP BY channel, status`);
    const totals = { byChannel: {}, byStatus: {}, total: 0 };
    for (const x of counts.rows) {
      totals.byChannel[x.channel] = (totals.byChannel[x.channel] || 0) + x.n;
      totals.byStatus[x.status] = (totals.byStatus[x.status] || 0) + x.n;
      totals.total += x.n;
    }
    const last = await pool.query("SELECT * FROM content_sync_runs ORDER BY created_at DESC LIMIT 1");
    return c.json({
      ok: true,
      posts: r.rows.map(postRow),
      totals,
      lastSync: last.rows[0] ? { at: last.rows[0].created_at, ok: last.rows[0].ok, summary: last.rows[0].summary } : null,
    });
  });

  app.get("/api/content/posts/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM content_posts WHERE id=$1", [c.req.param("id")]);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, post: postRow(r.rows[0]) });
  });

  /* ══ ٢) إنشاء / تعديل / إلغاء ═════════════════════════════════════════ */
  app.post("/api/content/posts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const channel = String(b.channel || "").trim();
    if (!CHANNELS.includes(channel)) {
      return c.json({ ok: false, error: "channel required", message: "اختار القناة: فيسبوك / انستجرام / تيك توك / سناب" }, 400);
    }
    const status = STATUSES.includes(b.status) ? b.status : "draft";
    if (status === "scheduled" && !b.scheduledAt) {
      return c.json({ ok: false, error: "scheduledAt required", message: "لازم تحدّد ميعاد النشر" }, 400);
    }
    const r = await pool.query(
      `INSERT INTO content_posts
         (id, channel, status, scheduled_at, caption, hashtags, media_url, media_local_path, asset_id, notes, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'local') RETURNING *`,
      [newId("cp"), channel, status, b.scheduledAt || null,
       String(b.caption || ""), String(b.hashtags || ""), String(b.mediaUrl || ""),
       String(b.mediaLocalPath || ""), b.assetId ? String(b.assetId) : null, String(b.notes || "")]
    );
    return c.json({ ok: true, post: postRow(r.rows[0]) });
  });

  /* تعديل. لو البوست فيسبوك مجدول وله معرّف على المنصة، التعديل بيتبعت
     لفيسبوك كمان — ولو فيسبوك رفض، بنرجّع نص رفضه ومش بنكدب على عمر:
     الصف بيتحفظ محليًا، والرد بيقول إن المنصة لسه على النص القديم. */
  app.put("/api/content/posts/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const cur = (await pool.query("SELECT * FROM content_posts WHERE id=$1", [c.req.param("id")])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);

    const next = {
      status: b.status !== undefined && STATUSES.includes(b.status) ? b.status : cur.status,
      scheduled_at: b.scheduledAt !== undefined ? (b.scheduledAt || null) : cur.scheduled_at,
      caption: b.caption !== undefined ? String(b.caption) : cur.caption,
      hashtags: b.hashtags !== undefined ? String(b.hashtags) : cur.hashtags,
      media_url: b.mediaUrl !== undefined ? String(b.mediaUrl) : cur.media_url,
      media_local_path: b.mediaLocalPath !== undefined ? String(b.mediaLocalPath) : cur.media_local_path,
      asset_id: b.assetId !== undefined ? (b.assetId || null) : cur.asset_id,
      notes: b.notes !== undefined ? String(b.notes) : cur.notes,
    };

    // هل فيه حاجة تخصّ فيسبوك اتغيّرت فعلاً؟
    let platform = null;
    const capChanged = fullCaption(next) !== fullCaption(cur);
    const timeChanged = String(next.scheduled_at || "") !== String(cur.scheduled_at || "");
    if (cur.channel === "facebook" && cur.external_id && cur.status === "scheduled" && (capChanged || timeChanged)) {
      platform = await pushFacebookEdit(cur.external_id, {
        message: capChanged ? fullCaption(next) : undefined,
        scheduledAt: timeChanged ? next.scheduled_at : undefined,
      });
      if (!platform.ok) {
        // بنحفظ التعديل المحلي برضه، بس بنقول الحقيقة: فيسبوك لسه على القديم
        next.error_text = `فيسبوك رفض التعديل: ${platform.error}`;
      }
    }
    if (cur.channel === "instagram" && cur.status === "failed" && (capChanged || timeChanged || b.status)) {
      next.error_text = ""; // إعادة الجدولة بتمسح سبب الفشل القديم
    }

    const r = await pool.query(
      `UPDATE content_posts SET status=$2, scheduled_at=$3, caption=$4, hashtags=$5,
              media_url=$6, media_local_path=$7, asset_id=$8, notes=$9,
              error_text=$10, claimed_at=NULL, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [cur.id, next.status, next.scheduled_at, next.caption, next.hashtags,
       next.media_url, next.media_local_path, next.asset_id, next.notes,
       next.error_text !== undefined ? next.error_text : cur.error_text]
    );
    return c.json({ ok: true, post: postRow(r.rows[0]), platform });
  });

  async function pushFacebookEdit(postId, { message, scheduledAt }) {
    const tok = await pageToken();
    if (!tok) return { ok: false, error: pageTokenCache.err || "مفيش توكن صفحة", target: "facebook" };
    const form = new URLSearchParams();
    if (message !== undefined) form.set("message", message);
    if (scheduledAt) form.set("scheduled_publish_time", String(Math.floor(new Date(scheduledAt).getTime() / 1000)));
    form.set("access_token", tok);
    const r = await httpJson(`${GRAPH()}/${postId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!r.ok || r.json?.success === false) return { ok: false, error: graphErr(r), target: "facebook" };
    return { ok: true, target: "facebook" };
  }

  /* التفاعل اللي البوست جمعه — بيتقري من ميتا وقت الطلب، مش متخزّن.
     محتاجينه قبل أي حذف: لو هنشيل بوست غلط، لازم نعرف كان وصل لكام واحد
     ونقول الرقم بدل ما يضيع مع الصف. */
  app.get("/api/content/posts/:id/engagement", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = (await pool.query("SELECT * FROM content_posts WHERE id=$1", [c.req.param("id")])).rows[0];
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (!row.external_id) return c.json({ ok: false, error: "no_external_id", message: "البوست ده لسه ماتنشرش على المنصة" }, 400);
    const tok = await pageToken();
    if (!tok) return c.json({ ok: false, error: pageTokenCache.err || "مفيش توكن صفحة" }, 502);

    if (row.channel === "instagram") {
      const r = await httpJson(`${GRAPH()}/${row.external_id}?fields=like_count,comments_count,permalink,timestamp&access_token=${encodeURIComponent(tok)}`);
      if (!r.ok) return c.json({ ok: false, error: graphErr(r) }, 502);
      return c.json({ ok: true, channel: "instagram", likes: r.json?.like_count ?? null,
                      comments: r.json?.comments_count ?? null, permalink: r.json?.permalink || row.permalink });
    }
    const fields = "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares,created_time,permalink_url";
    const r = await httpJson(`${GRAPH()}/${row.external_id}?fields=${fields}&access_token=${encodeURIComponent(tok)}`);
    if (!r.ok) return c.json({ ok: false, error: graphErr(r) }, 502);
    const j = r.json || {};
    return c.json({
      ok: true, channel: "facebook",
      reactions: j.reactions?.summary?.total_count ?? null,
      comments: j.comments?.summary?.total_count ?? null,
      shares: j.shares?.count ?? 0,
      createdTime: j.created_time || null,
      permalink: j.permalink_url || row.permalink,
    });
  });

  /* الحذف. لو البوست فيسبوك و`platform=1` اتبعت، بنحذفه من فيسبوك كمان —
     من غير كده بنشيله من التقويم بس وبنسيبه على المنصة.
     ملحوظة: قبل ١٥ أغسطس ده كان شغّال على البوستات **المجدولة** بس، فبوست
     اتنشر بالغلط ماكانش فيه أي طريقة تشيله من هنا — التقويم بيفضّى والبوست
     يفضل عايش على الصفحة، وده أسوأ الاحتمالين. دلوقتي بيشتغل على المنشور
     كمان (`?published=1` تأكيد إضافي، لأن ده إجراء مالوش رجعة). */
  app.delete("/api/content/posts/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cur = (await pool.query("SELECT * FROM content_posts WHERE id=$1", [c.req.param("id")])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);
    let platform = null;
    const wantsPlatform = c.req.query("platform") === "1";
    const isPublished = cur.status === "published";
    if (wantsPlatform && isPublished && c.req.query("published") !== "1") {
      return c.json({
        ok: false, error: "confirm_published",
        message: "البوست ده متنشر فعلاً على المنصة. الحذف مالوش رجعة والتفاعل بيروح معاه — " +
                 "شوف /api/content/posts/:id/engagement الأول، وبعدين ضيف &published=1 لو متأكد.",
      }, 409);
    }
    if (wantsPlatform && cur.channel === "facebook" && cur.external_id && (cur.status === "scheduled" || isPublished)) {
      const tok = await pageToken();
      if (!tok) platform = { ok: false, error: pageTokenCache.err || "مفيش توكن صفحة", target: "facebook" };
      else {
        const r = await httpJson(`${GRAPH()}/${cur.external_id}?access_token=${encodeURIComponent(tok)}`, { method: "DELETE" });
        platform = (r.ok && r.json?.success !== false) ? { ok: true, target: "facebook" } : { ok: false, error: graphErr(r), target: "facebook" };
        if (!platform.ok) {
          // ما نمسحش الصف لو المنصة رفضت — التقويم لازم يفضل بيقول الحقيقة
          await pool.query("UPDATE content_posts SET error_text=$2, updated_at=NOW() WHERE id=$1",
            [cur.id, `فيسبوك رفض الحذف: ${platform.error}`]);
          return c.json({ ok: false, platform, message: `فيسبوك رفض الحذف: ${platform.error}` }, 409);
        }
      }
    }
    await pool.query("DELETE FROM content_posts WHERE id=$1", [cur.id]);
    return c.json({ ok: true, platform });
  });

  /* إلغاء من غير حذف — البوست بيفضل في التقويم بحالة «ملغي» عشان يفضل فيه
     أثر لقرار الإلغاء. */
  app.post("/api/content/posts/:id/cancel", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query(
      `UPDATE content_posts SET status='cancelled', claimed_at=NULL, updated_at=NOW()
        WHERE id=$1 AND status IN ('draft','scheduled','failed') RETURNING *`, [c.req.param("id")]);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found_or_published", message: "البوست ده اتنشر خلاص — مش ينفع يتلغي" }, 409);
    return c.json({ ok: true, post: postRow(r.rows[0]) });
  });

  /* ══ ٣) استيراد اللي موجود فعلاً على المنصات ══════════════════════════
     ده اللي بيخلّي التقويم يقول الحقيقة من أول لحظة بدل ما يفتح فاضي.
     بيتنده من زرار «مزامنة» ومن العامل كل ساعة (روابط صور فيسبوك موقّعة
     وبتنتهي بعد أيام — فالمزامنة بتجدّدها). */
  async function upsertImported(row) {
    const r = await pool.query(
      `INSERT INTO content_posts
         (id, channel, status, scheduled_at, published_at, caption, hashtags,
          media_url, external_id, permalink, origin, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'imported',NOW())
       -- الفهرس الفريد جزئي (external_id IS NOT NULL)، وبوستجرس مش بيستنتجه
       -- إلا لو الشرط اتكتب هنا كمان — من غيره بيرمي «no unique constraint».
       ON CONFLICT (channel, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         status = EXCLUDED.status,
         scheduled_at = EXCLUDED.scheduled_at,
         published_at = COALESCE(EXCLUDED.published_at, content_posts.published_at),
         media_url = EXCLUDED.media_url,
         permalink = COALESCE(NULLIF(EXCLUDED.permalink,''), content_posts.permalink),
         synced_at = NOW(),
         updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [newId("cp"), row.channel, row.status, row.scheduledAt || null, row.publishedAt || null,
       row.caption, row.hashtags, row.mediaUrl, row.externalId, row.permalink || ""]
    );
    return !!r.rows[0]?.inserted;
  }

  async function syncPlatforms() {
    const out = {
      facebook: { scheduled: 0, published: 0, new: 0, error: "" },
      instagram: { published: 0, new: 0, error: "" },
      vanished: 0,
    };
    const tok = await pageToken();
    if (!tok) {
      out.facebook.error = pageTokenCache.err || "مفيش توكن صفحة";
      out.instagram.error = out.facebook.error;
      return out;
    }
    const seenFb = new Set();

    // ── فيسبوك: المجدول ──────────────────────────────────────────────
    const schedFields = "id,message,scheduled_publish_time,created_time,full_picture,permalink_url";
    const sched = await httpJson(
      `${GRAPH()}/${FB_PAGE_ID()}/scheduled_posts?fields=${schedFields}&limit=100&access_token=${encodeURIComponent(tok)}`);
    if (!sched.ok) out.facebook.error = graphErr(sched);
    else {
      for (const p of sched.json?.data || []) {
        const { caption, hashtags } = splitCaption(p.message);
        seenFb.add(p.id);
        const isNew = await upsertImported({
          channel: "facebook", status: "scheduled",
          scheduledAt: p.scheduled_publish_time ? new Date(p.scheduled_publish_time * 1000).toISOString() : null,
          publishedAt: null, caption, hashtags,
          mediaUrl: p.full_picture || "", externalId: p.id, permalink: p.permalink_url || "",
        });
        out.facebook.scheduled++; if (isNew) out.facebook.new++;
      }
    }

    // ── فيسبوك: المنشور ──────────────────────────────────────────────
    const pubFields = "id,message,created_time,full_picture,permalink_url";
    const pub = await httpJson(
      `${GRAPH()}/${FB_PAGE_ID()}/published_posts?fields=${pubFields}&limit=50&access_token=${encodeURIComponent(tok)}`);
    if (!pub.ok) out.facebook.error = out.facebook.error || graphErr(pub);
    else {
      for (const p of pub.json?.data || []) {
        const { caption, hashtags } = splitCaption(p.message);
        seenFb.add(p.id);
        const isNew = await upsertImported({
          channel: "facebook", status: "published",
          scheduledAt: null, publishedAt: p.created_time || null, caption, hashtags,
          mediaUrl: p.full_picture || "", externalId: p.id, permalink: p.permalink_url || "",
        });
        out.facebook.published++; if (isNew) out.facebook.new++;
      }
    }

    /* أي بوست فيسبوك كنّا مستوردينه كمجدول وما بقاش موجود لا في المجدول ولا
       في المنشور = اتمسح من على فيسبوك. بنعلّمه «ملغي» بدل ما يفضل يكدب. */
    if (sched.ok && pub.ok && seenFb.size) {
      const gone = await pool.query(
        `UPDATE content_posts SET status='cancelled', updated_at=NOW(),
                notes = CASE WHEN notes = '' THEN 'اختفى من فيسبوك — اتمسح من هناك' ELSE notes END
          WHERE channel='facebook' AND origin='imported' AND status='scheduled'
            AND external_id IS NOT NULL AND NOT (external_id = ANY($1::text[]))
          RETURNING id`, [[...seenFb]]);
      out.vanished = gone.rowCount;
    }

    // ── انستجرام: المنشور ────────────────────────────────────────────
    const igFields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
    const ig = await httpJson(
      `${GRAPH()}/${IG_USER_ID()}/media?fields=${igFields}&limit=50&access_token=${encodeURIComponent(tok)}`);
    if (!ig.ok) out.instagram.error = graphErr(ig);
    else {
      for (const m of ig.json?.data || []) {
        const { caption, hashtags } = splitCaption(m.caption);
        const isNew = await upsertImported({
          channel: "instagram", status: "published",
          scheduledAt: null, publishedAt: m.timestamp || null, caption, hashtags,
          mediaUrl: m.media_url || m.thumbnail_url || "", externalId: m.id, permalink: m.permalink || "",
        });
        out.instagram.published++; if (isNew) out.instagram.new++;
      }
    }
    return out;
  }

  app.post("/api/content/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let summary, ok = true;
    try { summary = await syncPlatforms(); }
    catch (e) { ok = false; summary = { error: String(e.message || e) }; }
    if (summary.facebook?.error && summary.instagram?.error) ok = false;
    await pool.query("INSERT INTO content_sync_runs (id, ok, summary) VALUES ($1,$2,$3)",
      [newId("sync"), ok, jb(summary)]);
    return c.json({ ok, summary });
  });

  /* ══ ٤) حصة النشر والحالة ═════════════════════════════════════════════ */
  async function igQuota() {
    const tok = await pageToken();
    if (!tok) return { ok: false, error: pageTokenCache.err || "مفيش توكن صفحة" };
    const r = await httpJson(
      `${GRAPH()}/${IG_USER_ID()}/content_publishing_limit?fields=config,quota_usage&access_token=${encodeURIComponent(tok)}`);
    if (!r.ok) return { ok: false, error: graphErr(r) };
    const d = r.json?.data?.[0] || {};
    return {
      ok: true,
      used: Number(d.quota_usage) || 0,
      total: Number(d.config?.quota_total) || 0,
      windowHours: Math.round((Number(d.config?.quota_duration) || 86400) / 3600),
    };
  }

  app.get("/api/content/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const tok = await pageToken();
    const counts = await pool.query(
      `SELECT channel, status, count(*)::int AS n FROM content_posts GROUP BY channel, status ORDER BY channel, status`);
    const nextDue = await pool.query(
      `SELECT id, channel, scheduled_at FROM content_posts
        WHERE status='scheduled' AND scheduled_at IS NOT NULL
        ORDER BY scheduled_at LIMIT 1`);
    const last = await pool.query("SELECT * FROM content_sync_runs ORDER BY created_at DESC LIMIT 1");
    return c.json({
      ok: true,
      meta: { connected: !!tok, pageId: FB_PAGE_ID(), igUserId: IG_USER_ID(), error: tok ? "" : pageTokenCache.err },
      igQuota: tok ? await igQuota() : { ok: false, error: pageTokenCache.err },
      tiktok: { canPublish: false, why: "تطبيق الـ API بتاع حساب تيك توك اترفض — النشر بالإيد لحد ما يتقبل" },
      counts: counts.rows,
      nextDue: nextDue.rows[0] || null,
      lastSync: last.rows[0] ? { at: last.rows[0].created_at, ok: last.rows[0].ok, summary: last.rows[0].summary } : null,
      publicBase: PUBLIC_BASE(),
      workerMinutes: WORKER_MINUTES,
    });
  });

  /* ══ ٥) الصور ═════════════════════════════════════════════════════════
     انستجرام بيحمّل الصورة بنفسه من رابط https عام. عندنا ٣ طرق:
       • رابط جاهز (صور المتجر على order.o2m8.me/static/social/…) — استعمله زي ما هو
       • رفع base64 من الواجهة
       • مسار ملف جوّه الكونتينر (لو وكيل تاني حطّ الصورة هناك)
     الاتنين الأخيرين بيتخزنوا في الداتابيز وبيتقدّموا من /api/content/media/:id
     — مسار عام من غير توكن، لأن سيرفرات ميتا مش هتبعت توكن. */
  app.post("/api/content/upload", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    let buf = null, filename = String(b.filename || ""), mime = String(b.mime || "");

    try {
      if (b.base64) {
        const raw = String(b.base64).replace(/^data:([^;]+);base64,/, (_m, m1) => { mime = mime || m1; return ""; });
        buf = Buffer.from(raw, "base64");
      } else if (b.sourceUrl) {
        const res = await fetch(String(b.sourceUrl));
        if (!res.ok) return c.json({ ok: false, error: `HTTP ${res.status}`, message: `تعذر تحميل الصورة من الرابط (${res.status})` }, 400);
        mime = mime || res.headers.get("content-type") || "";
        buf = Buffer.from(await res.arrayBuffer());
        filename = filename || String(b.sourceUrl).split("/").pop().split("?")[0];
      } else if (b.serverPath) {
        const fs = await import("node:fs/promises");
        buf = await fs.readFile(String(b.serverPath));
        filename = filename || String(b.serverPath).split(/[\\/]/).pop();
      } else {
        return c.json({ ok: false, error: "no source", message: "ابعت base64 أو sourceUrl أو serverPath" }, 400);
      }
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e), message: `تعذر قراءة الصورة: ${e.message || e}` }, 400);
    }

    if (!buf || !buf.length) return c.json({ ok: false, error: "empty", message: "الملف فاضي" }, 400);
    if (buf.length > MAX_UPLOAD_BYTES) {
      return c.json({ ok: false, error: "too large", message: `الصورة ${(buf.length / 1048576).toFixed(1)} ميجا — الحد ٨ ميجا` }, 413);
    }
    const info = imageInfo(buf);
    if (info.kind === "unknown") return c.json({ ok: false, error: "not an image", message: "الملف ده مش صورة معروفة (JPEG/PNG/GIF/WEBP)" }, 400);
    mime = info.mime || mime || "application/octet-stream";
    const ext = info.kind === "jpeg" ? "jpg" : info.kind;
    const id = newId("md");
    /* الإقرار بيتقبل وقت الرفع كمان، مش بس من asset-guard --push: الصورة
       اللي بتتحط في التقويم من غير ما حد يقول بتوري إيه هي بالظبط اللي
       اتنشرت غلط يوم ١٤ أغسطس. */
    const dish = String(b.dish || "").trim();
    const dishClaim = String(b.dishClaim || "").trim() || (dish ? "" : "");
    await pool.query(
      `INSERT INTO content_media (id, filename, mime, bytes, size, width, height, dish, dish_claim, provenance, declared_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, filename || `${id}.${ext}`, mime, buf, buf.length, info.width || null, info.height || null,
       dish, dishClaim, JSON.stringify(b.provenance || {}), (dish || dishClaim) ? new Date() : null]);
    const url = `${PUBLIC_BASE()}/api/content/media/${id}.${ext}`;
    return c.json({
      ok: true, assetId: id, url, mime, size: buf.length,
      width: info.width || null, height: info.height || null,
      igProblems: igImageProblems({ mime, width: info.width, height: info.height, url }),
    });
  });

  /* مسار عام عن قصد: سيرفرات انستجرام هي اللي بتحمّل الصورة، ومش بتبعت
     توكن. المعرّف عشوائي، والرد مفيهوش أي بيانات غير الصورة. */
  app.get("/api/content/media/:id", async (c) => {
    const raw = c.req.param("id");
    const id = raw.replace(/\.(jpg|jpeg|png|gif|webp)$/i, "");
    const r = await pool.query("SELECT mime, bytes FROM content_media WHERE id=$1", [id]);
    if (!r.rowCount) return c.json({ error: "not_found" }, 404);
    return c.body(new Uint8Array(r.rows[0].bytes), 200, {
      "Content-Type": r.rows[0].mime || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  /* الصور اللي تحت إيدنا: المرفوعة + أي رابط مستعمل فعلاً في بوست. الواجهة
     بتعرضهم كمعرض اختيار بدل ما عمر يلزق روابط بإيده. */
  app.get("/api/content/assets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const up = await pool.query(
      `SELECT id, filename, mime, size, width, height, created_at FROM content_media ORDER BY created_at DESC LIMIT 200`);
    const used = await pool.query(
      `SELECT DISTINCT media_url FROM content_posts WHERE media_url <> '' ORDER BY media_url LIMIT 200`);
    const base = PUBLIC_BASE();
    return c.json({
      ok: true,
      uploaded: up.rows.map((r) => ({
        id: r.id, filename: r.filename, mime: r.mime, size: r.size,
        width: r.width, height: r.height, createdAt: r.created_at,
        url: `${base}/api/content/media/${r.id}${/jpe?g/i.test(r.mime) ? ".jpg" : ""}`,
      })),
      used: used.rows.map((r) => r.media_url),
    });
  });

  /* فحص رابط صورة قبل الجدولة — بيقول نوعها ومقاسها وهل انستجرام هيقبلها.
     أرخص من إننا نحرق من حصة النشر ونكتشف الرفض بعدين. */
  app.post("/api/content/check-media", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const url = String(b.url || "").trim();
    if (!url) return c.json({ ok: false, error: "url required" }, 400);
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-131071" } });
      if (!res.ok && res.status !== 206) {
        return c.json({ ok: false, reachable: false, status: res.status, message: `الرابط رجّع ${res.status}` });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const info = imageInfo(buf);
      const mime = info.mime || res.headers.get("content-type") || "";
      return c.json({
        ok: true, reachable: true, status: res.status, mime,
        width: info.width || null, height: info.height || null,
        igProblems: igImageProblems({ mime, width: info.width, height: info.height, url }),
      });
    } catch (e) {
      return c.json({ ok: false, reachable: false, message: `تعذر الوصول للرابط: ${e.message || e}` });
    }
  });

  /* ══ ٥.٥) حارس الصنف — الصورة لازم توري اللي النص بيقوله ══════════════
     ── ليه ده موجود ──────────────────────────────────────────────────────
     ١٤ أغسطس ٢٠٢٦، ٥:٤٥ م: اتنشر على فيسبوك بوستر «عرضين… وبس داخل الصالة»
     مكتوب فيه «صينية اللمــة — ١٠٠ ريال» وجنبها صورة نص دجاجة واحدة على رز
     (صنف تاني بيتباع بـ٢٥ ريال). العميل شاف طبق واتباع له طبق تاني.

     كان فيه حارس أسعار (price-guard.js) بيرفض أي تصميم بسعر مش موثّق، وكانت
     فيه مراجعة إبداعية — بس المراجعة غطّت **إعلانات ميتا المدفوعة** بس،
     والبوستر ده محتوى **عضوي مجدول**. خطّين إنتاج، حارس واحد، والخط اللي
     مالوش حارس هو اللي نشر الغلط.

     الحارس ده بيقفل نفس النوع من الغلط على الخط العضوي:
       · الصورة لازم يكون عليها إقرار «بتوري أنهي صنف» (asset-guard بيرفعه)
       · الصنف المُقَر لازم يكون موجود في نص البوست
       · لو النص بيسمّي صنف والصورة مُقَرّة بصنف تاني → النشر بيتمنع
     المبدأ نفس مبدأ price-guard: سعر مش قادرين نتحقق منه = مايتنشرش. */

  const GUARD_MODE = () => (process.env.CONTENT_DISH_GUARD || "warn").toLowerCase();

  const normDish = (s) => String(s || "")
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();

  /* اسم الصنف «المختصر»: عناوين الكاتالوج بتيجي بالسعر والشروط جواها
     («صينية اللمة 100 ريال — داخل الصالة فقط») وده عمره ما هيظهر بالحرف في
     كابشن. بناخد الجزء اللي قبل أول رقم أو فاصل. */
  const coreName = (title) => String(title || "")
    .split(/[—·|]/)[0]
    .replace(/[\d٠-٩].*$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  let vocabCache = { at: 0, list: [] };
  async function dishVocab() {
    if (vocabCache.list.length && Date.now() - vocabCache.at < 600_000) return vocabCache.list;
    const list = [];
    try {
      const r = await fetch(`${PUBLIC_BASE()}/api/catalog/feed.csv`);
      if (r.ok) {
        const lines = (await r.text()).trim().split("\n").slice(1);
        for (const line of lines) {
          const m = line.match(/^"[^"]*","([^"]*)"/);
          if (m) list.push({ title: m[1], core: coreName(m[1]), source: "المنيو" });
        }
      }
      const r2 = await fetch(`${PUBLIC_BASE()}/api/offers/all`);
      if (r2.ok) {
        const j = await r2.json();
        for (const o of j.offers || []) {
          for (const nm of [o.catalogTitle, o.title]) {
            if (nm) list.push({ title: nm, core: coreName(nm), source: "سجلّ العروض" });
          }
        }
      }
    } catch { /* المفردات فاضية = الحارس هيقول «مش قادر أتحقق» بدل ما يخترع */ }
    const seen = new Set();
    const out = list.filter((d) => d.core.length >= 4 && !seen.has(normDish(d.core)) && seen.add(normDish(d.core)));
    if (out.length) vocabCache = { at: Date.now(), list: out };
    return out;
  }

  /* الأصناف اللي النص بيسمّيها — أطول تطابق الأول عشان «صينية اللمة» ما
     تتبلعش جوّه تطابق أقصر. */
  async function dishesInText(text) {
    const hay = normDish(text);
    if (!hay) return [];
    const vocab = await dishVocab();
    return vocab
      .filter((d) => hay.includes(normDish(d.core)))
      .sort((a, b) => b.core.length - a.core.length);
  }

  /* الصورة المرتبطة بالبوست: إما asset_id صريح، وإما مستخرج من media_url
     (البوستات المحلية بتشاور على /api/content/media/md_xxx.jpg). */
  async function mediaForPost(row) {
    let id = row.asset_id || "";
    if (!id) {
      const m = String(row.media_url || "").match(/\/api\/content\/media\/(md_[a-z0-9]+)/i);
      if (m) id = m[1];
    }
    if (!id) return null;
    const r = await pool.query(
      "SELECT id, filename, dish, dish_claim, provenance, declared_at FROM content_media WHERE id=$1", [id]);
    return r.rows[0] || null;
  }

  /* الحكم على بوست واحد. بيرجّع verdict:
       pass        — الصورة مُقَرّة والصنف موجود في النص
       no-dish     — النص مابيسمّيش صنف (بوست براند/موقع) — مسموح
       mismatch    — الصورة مُقَرّة بصنف والنص بيسمّي صنف تاني → منع
       undeclared  — الصورة مالهاش إقرار → منع في الوضع strict */
  async function dishVerdict(row) {
    const media = await mediaForPost(row);
    const named = await dishesInText(fullCaption(row));

    if (!media || (!media.dish && !media.dish_claim)) {
      return {
        verdict: "undeclared",
        block: GUARD_MODE() === "strict",
        named: named.map((d) => d.core),
        reason: media
          ? `الصورة ${media.id} مالهاش إقرار صنف — شغّل asset-guard.js --push`
          : "البوست مش مربوط بصورة مُقَرّة (رابط خارجي أو صورة مرفوعة من غير إقرار)",
      };
    }
    if (media.dish_claim === "none") {
      return { verdict: "pass", block: false, declared: null, named: named.map((d) => d.core),
               reason: "الصورة مُقَرّة إنها بدون صنف معيّن" };
    }
    const declared = media.dish;
    const declaredCore = normDish(coreName(declared));
    const hay = normDish(fullCaption(row));
    if (declaredCore && hay.includes(declaredCore)) {
      return { verdict: "pass", block: false, declared, named: named.map((d) => d.core),
               reason: `النص بيسمّي «${coreName(declared)}» والصورة مُقَرّة بيه` };
    }
    if (!named.length) {
      return { verdict: "no-dish", block: false, declared, named: [],
               reason: "النص مابيسمّيش صنف معروف — مافيش تعارض" };
    }
    return {
      verdict: "mismatch",
      block: true,
      declared,
      named: named.map((d) => d.core),
      reason: `الصورة مُقَرّة إنها «${coreName(declared)}» والنص بيسمّي «${named[0].core}» — دي نفس غلطة ١٤ أغسطس`,
    };
  }

  /* استقبال الإقرارات من asset-guard.js --push. الربط بالاسم: الكادر
     out/v2_d_lamma_p45.png بيتربط بالصورة اللي اترفعت باسم v2_d_lamma_p45.png */
  app.post("/api/content/declarations", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const decls = Array.isArray(b.declarations) ? b.declarations : [];
    if (!decls.length) return c.json({ ok: false, error: "no declarations" }, 400);

    let matched = 0;
    const unmatched = [];
    for (const d of decls) {
      const base = String(d.render || "").split("/").pop();
      if (!base) continue;
      const dish = (d.dishes || []).filter(Boolean).join(" + ");
      const r = await pool.query(
        `UPDATE content_media
            SET dish = $2, dish_claim = $3, provenance = $4, declared_at = NOW()
          WHERE filename = $1 RETURNING id`,
        [base, dish, dish ? "" : "none", JSON.stringify({ render: d.render, pipeline: d.pipeline, guard: b.guard || {} })]);
      if (r.rowCount) matched += r.rowCount; else unmatched.push(base);
    }
    return c.json({ ok: true, received: decls.length, matched, unmatched });
  });

  /* كشف على كل البوستات المجدولة — الخطين مع بعض.
     مهم: بوستات فيسبوك المجدولة محجوزة عند **فيسبوك** نفسه، والناشر بتاعنا
     مابيلمسهاش، فمنعها وقت النشر مستحيل من هنا. عشان كده الكشف ده بيمشي
     على الاتنين، و`?cancel=1` بيلغي المخالف قبل ميعاده. */
  app.get("/api/content/guard", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT * FROM content_posts WHERE status IN ('scheduled','draft')
        ORDER BY scheduled_at NULLS LAST`)).rows;
    const items = [];
    for (const row of rows) {
      const v = await dishVerdict(row);
      items.push({
        id: row.id, channel: row.channel, scheduledAt: row.scheduled_at,
        origin: row.origin, headline: String(row.caption || "").split("\n")[0].slice(0, 70),
        ...v,
      });
    }
    const tally = items.reduce((a, i) => ((a[i.verdict] = (a[i.verdict] || 0) + 1), a), {});
    return c.json({ ok: true, mode: GUARD_MODE(), checked: items.length, tally,
                    blocking: items.filter((i) => i.block).length, items });
  });

  app.post("/api/content/guard", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const doCancel = c.req.query("cancel") === "1";
    const rows = (await pool.query(
      `SELECT * FROM content_posts WHERE status IN ('scheduled','draft')`)).rows;
    const acted = [];
    for (const row of rows) {
      const v = await dishVerdict(row);
      if (!v.block) continue;
      if (doCancel) {
        await pool.query(
          `UPDATE content_posts SET status='cancelled', claimed_at=NULL,
                  error_text=$2, updated_at=NOW() WHERE id=$1`,
          [row.id, `حارس الصنف: ${v.reason}`]);
      }
      acted.push({ id: row.id, channel: row.channel, ...v, cancelled: doCancel });
    }
    return c.json({ ok: true, mode: GUARD_MODE(), blocking: acted.length, cancelled: doCancel, items: acted });
  });

  /* ══ ٦) ناشر انستجرام ═════════════════════════════════════════════════
     انستجرام API ملوش جدولة — عشان كده البوستات اتنشرت بالإيد. الجدولة
     بنعملها إحنا: العامل بياخد صف واحد ميعاده جه، يحجزه (claimed_at) عشان
     ما يتنشرش مرتين، ينشره على خطوتين، ويكتب النتيجة في نفس الصف.

     مسار ميتا: POST /{ig}/media {image_url, caption} → creation_id
                ثم انتظار حتى status_code = FINISHED
                ثم POST /{ig}/media_publish {creation_id} → media id */
  async function publishInstagram(row) {
    const tok = await pageToken();
    if (!tok) return { ok: false, error: pageTokenCache.err || "مفيش توكن صفحة" };

    const url = String(row.media_url || "").trim();
    if (!url) return { ok: false, error: "البوست من غير صورة — انستجرام لازم صورة" };
    const problems = igImageProblems({ url });
    if (problems.length) return { ok: false, error: problems.join(" · ") };

    /* حارس الصنف — آخر نقطة قبل ما الصورة تخرج للناس. مش retry: ده مش عطل
       مؤقت، ده تصميم غلط لازم إيد بني آدم تصلحه. */
    const dv = await dishVerdict(row);
    if (dv.block) return { ok: false, error: `حارس الصنف منع النشر: ${dv.reason}` };

    const q = await igQuota();
    if (q.ok && q.total && q.used >= q.total) {
      return { ok: false, retry: true, error: `حصة النشر خلصت (${q.used}/${q.total} خلال ${q.windowHours} ساعة) — هنعيد المحاولة` };
    }

    const create = await httpJson(`${GRAPH()}/${IG_USER_ID()}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ image_url: url, caption: fullCaption(row), access_token: tok }).toString(),
    });
    const creationId = create.json?.id;
    if (!creationId) return { ok: false, error: graphErr(create) };

    // الحاوية بتاخد ثواني لحد ما ميتا تحمّل الصورة وتفحصها
    let state = "";
    for (let i = 0; i < 10; i++) {
      const st = await httpJson(
        `${GRAPH()}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`);
      state = st.json?.status_code || "";
      if (state === "FINISHED") break;
      if (state === "ERROR" || state === "EXPIRED") {
        return { ok: false, error: `ميتا رفضت الصورة: ${st.json?.status || state}` };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (state !== "FINISHED") return { ok: false, retry: true, error: `الصورة لسه بتتجهّز عند ميتا (${state || "غير معروف"}) — هنعيد المحاولة` };

    const pubRes = await httpJson(`${GRAPH()}/${IG_USER_ID()}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: String(creationId), access_token: tok }).toString(),
    });
    const mediaId = pubRes.json?.id;
    if (!mediaId) return { ok: false, error: graphErr(pubRes) };

    const perma = await httpJson(
      `${GRAPH()}/${mediaId}?fields=permalink,timestamp&access_token=${encodeURIComponent(tok)}`);
    return {
      ok: true, externalId: String(mediaId),
      permalink: perma.json?.permalink || "",
      publishedAt: perma.json?.timestamp || new Date().toISOString(),
    };
  }

  /* الحجز: صف واحد في المرة، بـ FOR UPDATE SKIP LOCKED، وحجز أقدم من ١٥
     دقيقة بيتعتبر ميت (لو العملية ماتت في النص). ده اللي بيمنع النشر
     مرتين حتى لو العامل اتنده مرتين في نفس اللحظة. */
  async function claimDueInstagram() {
    const r = await pool.query(
      `UPDATE content_posts SET claimed_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM content_posts
           WHERE channel='instagram' AND status='scheduled'
             AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
             AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '15 minutes')
           ORDER BY scheduled_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING *`);
    return r.rows[0] || null;
  }

  let workerBusy = false;
  let lastWorker = { at: null, published: 0, failed: 0, note: "" };

  async function runPublisher({ trigger = "cron" } = {}) {
    if (workerBusy) return { ok: false, skipped: "شغّال بالفعل" };
    workerBusy = true;
    const out = { published: 0, failed: 0, retried: 0, items: [] };
    try {
      // ٥ بوستات كحد أقصى في الدورة — الباقي في الدورة اللي بعدها
      for (let i = 0; i < 5; i++) {
        const row = await claimDueInstagram();
        if (!row) break;
        const res = await publishInstagram(row);
        if (res.ok) {
          await pool.query(
            `UPDATE content_posts SET status='published', published_at=$2, external_id=$3,
                    permalink=$4, error_text='', claimed_at=NULL, updated_at=NOW() WHERE id=$1`,
            [row.id, res.publishedAt, res.externalId, res.permalink]);
          out.published++;
          out.items.push({ id: row.id, ok: true, permalink: res.permalink });
        } else if (res.retry) {
          // مش فشل نهائي — بنسيبه مجدول ونشيل الحجز عشان الدورة الجاية تاخده
          await pool.query(
            `UPDATE content_posts SET error_text=$2, claimed_at=NULL, updated_at=NOW() WHERE id=$1`,
            [row.id, res.error]);
          out.retried++;
          out.items.push({ id: row.id, ok: false, retry: true, error: res.error });
        } else {
          await pool.query(
            `UPDATE content_posts SET status='failed', error_text=$2, claimed_at=NULL, updated_at=NOW() WHERE id=$1`,
            [row.id, res.error]);
          out.failed++;
          out.items.push({ id: row.id, ok: false, error: res.error });
        }
      }
    } catch (e) {
      out.error = String(e.message || e);
    } finally {
      workerBusy = false;
      lastWorker = { at: new Date().toISOString(), published: out.published, failed: out.failed, note: out.error || trigger };
    }
    return { ok: true, ...out };
  }

  app.post("/api/content/run-publisher", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json(await runPublisher({ trigger: "manual" }));
  });

  /* نشر بوست انستجرام دلوقتي حالاً، من غير انتظار الميعاد. */
  app.post("/api/content/posts/:id/publish", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = (await pool.query("SELECT * FROM content_posts WHERE id=$1", [c.req.param("id")])).rows[0];
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.channel !== "instagram") {
      return c.json({ ok: false, error: "instagram only", message: "النشر الفوري من هنا لانستجرام بس — فيسبوك بيتجدول من عنده وتيك توك بالإيد" }, 400);
    }
    if (row.status === "published") return c.json({ ok: false, error: "already", message: "البوست ده اتنشر خلاص" }, 409);
    const res = await publishInstagram(row);
    if (!res.ok) {
      await pool.query("UPDATE content_posts SET status='failed', error_text=$2, updated_at=NOW() WHERE id=$1", [row.id, res.error]);
      return c.json({ ok: false, error: res.error, message: res.error }, 502);
    }
    const r = await pool.query(
      `UPDATE content_posts SET status='published', published_at=$2, external_id=$3,
              permalink=$4, error_text='', claimed_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [row.id, res.publishedAt, res.externalId, res.permalink]);
    return c.json({ ok: true, post: postRow(r.rows[0]) });
  });

  /* ══ ٧) أفكار تيك توك ═════════════════════════════════════════════════ */
  app.get("/api/content/tiktok/ideas", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM content_tiktok_ideas ORDER BY sort, created_at");
    /* فكرة مربوطة بعرض له تاريخ انتهاء بتقع من التقويم يوم ما العرض يخلص.
       بنقولها بصوت عالي في `hidden` مش بنخفيها بالساكت — فكرة بتختفي من غير
       سبب بتخلّي حد يفتكر إن فيه باج ويرجّعها بالإيد. */
    const liveOffers = new Set(activeOffers().map((o) => o.id));
    const shown = [], hidden = [];
    for (const row of r.rows) {
      const offerId = IDEA_OFFER[row.id];
      const o = offerId ? offerById(offerId) : null;
      if (o && !liveOffers.has(offerId)) {
        hidden.push({ id: row.id, title: row.title, offer: offerId, until: o.until });
      } else shown.push(o ? { ...ideaRow(row), offer: offerId, offerUntil: o.until } : ideaRow(row));
    }
    return c.json({
      ok: true, ideas: shown,
      hidden: hidden.length
        ? { count: hidden.length, why: "أفكار لعرض عدّى تاريخه — وقعت من التقويم لوحدها", items: hidden }
        : null,
      publishing: { auto: false, why: "تطبيق الـ API بتاع حساب تيك توك اترفض — التصوير والنشر بالإيد" },
    });
  });

  app.post("/api/content/tiktok/ideas", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const title = String(b.title || "").trim();
    if (!title) return c.json({ ok: false, error: "title required", message: "اكتب عنوان الفكرة" }, 400);
    const r = await pool.query(
      `INSERT INTO content_tiktok_ideas
         (id, title, hook, script, shots, dish, length_sec, status, fact, caption, hashtags, permalink, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, hook=EXCLUDED.hook, script=EXCLUDED.script, shots=EXCLUDED.shots,
         dish=EXCLUDED.dish, length_sec=EXCLUDED.length_sec, status=EXCLUDED.status,
         fact=EXCLUDED.fact, caption=EXCLUDED.caption, hashtags=EXCLUDED.hashtags,
         permalink=EXCLUDED.permalink, sort=EXCLUDED.sort, updated_at=NOW()
       RETURNING *`,
      [b.id || newId("tt"), title, String(b.hook || ""), String(b.script || ""), String(b.shots || ""),
       String(b.dish || ""), Math.trunc(Number(b.lengthSec) || 20),
       ["idea", "filming", "editing", "published"].includes(b.status) ? b.status : "idea",
       String(b.fact || ""), String(b.caption || ""), String(b.hashtags || ""),
       String(b.permalink || ""), Math.trunc(Number(b.sort) || 0)]
    );
    return c.json({ ok: true, idea: ideaRow(r.rows[0]) });
  });

  app.delete("/api/content/tiktok/ideas/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM content_tiktok_ideas WHERE id=$1", [c.req.param("id")]);
    return c.json({ ok: true });
  });

  console.log("[content] routes ready");
  return { runPublisher, syncPlatforms, publishInstagram };
}
