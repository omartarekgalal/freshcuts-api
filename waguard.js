/* ═══════════════════════════════════════════════════════════════════════════
   waguard.js — BF1 (١٩/١٠/٢٠٢٦): حرّاس ماجد والبوت من مراجعة ١٩/١٠ (docs/designs-2026-10/whatsapp/bot-review-2026-10-19.md)

   ملف صافي (مفيش قاعدة ولا شبكة): كل دالة بتاخد نص وترجع حكم. بيستخدمه wabotrun.js وwaassistrun.js والفحص الليلي (walearn.js).

   ١) promiseProblems — «وعد ماحصلش» (D): ماجد قال «كتبت للمطبخ ملاحظة» / «أضفت كريب» / «أجهّز لك السلة من الحين» ومفيش سلة اتعملت.
      • جملة «المطبخ» (كتبت / بلّغت / وصل / نزل … للمطبخ) ممنوعة دايماً: مفيش حاجة بتوصل المطبخ من المحادثة — المطبخ بيشوف الطلب بعد الدفع بس.
      • «طلبك جاهز / اتأكد / اتسجّل / بدأنا التجهيز» ممنوعة دايماً من ماجد (ده كلام الطلب المدفوع، ورسايله من نظام الطلبات).
      • «جهّزت / سلتك جاهزة / أجهّز لك (كخبر مش سؤال)» مسموحة بس لو build_cart اتعمل في نفس الدور.
      • «أضفت / حطيت لك» مسموحة لو السلة اتسعّرت أو اتعملت في نفس الدور (preview_cart / build_cart).
      • السؤال («أجهّزه لك؟»، «تحب أضيف…؟») مش وعد.
   ٢) isGoAhead — «جهّزه / جهّزها على ما أوصل / أبغى أطلب / اطلب لي / اعتمد» = العميل وافق ⇒ السلة في نفس الرد (H).
   ٣) spamKind — رابط دعوة / تيمو / شي إن / ربح… (I) ⇒ سطر واحد، ولا «أنا معك» ولا تنبيه فريق.
   ٤) comingKind — «أنا جاي / دقيقتين وأكون عندكم / وصلت» (…0558) ⇒ «حيّاك، نستناك» مرة وسكوت.
   ٥) loneLatinGreeting / adPrefillEn — «Hello» لوحدها أو نص إعلان «راسلنا» الجاهز بالإنجليزي (J) ⇒ الرد بالعربي.
   ٦) locationConfirm — «ده الموقع مظبوط» بعد ما العميل شارك موقعه (E …7271) ⇒ مش سؤال عن موقع الفرع.
   ٧) socialLink — رابط ريل / بوست (…7858) ⇒ سياق للمساعد: «لو ده من إعلاننا قول لي اسم الطبق».
   ٨) asksStaffByName — «أستاذ محمد حضرتك؟» (F …2488) ⇒ تحويل، مش بيع.
   ٩) partySizeOf / altBoxFor — عرض الحملة خلص (G …4333) ⇒ أقرب بوكس حي لنفس العدد بسعره.
   BF3 (٢٠/١٠): latinShort / notRealEnglish — «Online» / «Offers» / «Menu» لوحدها (…4268) ⇒ الرد بالعربي؛
                complimentOnly / praiseWhat — «الشوي انهارده احسن من امبارح» (…5082) = مدح ⇒ شكر قصير، مش تحويل لموظف.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize, latinShort } from "./wabot.js";

const N = (s) => normalize(String(s || ""));
const AR_DIGITS = (s) => String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));

/* ── ١) الوعود ─────────────────────────────────────────────────────────────── */
/* بعد normalize: الشدّة والتشكيل اتشالوا، أ/إ/آ ⇒ ا، ة ⇒ ه، ى ⇒ ي. */
const KITCHEN_RE = /(?:^| )[وف]?(?:كتبت|كتبتها|كتبته|كتبنا|كتبناها|بلغت|بلغنا|بلغتهم|ارسلت|ارسلنا|ارسلته|ارسلتها|حولت|حولته|حولتها|وصلت|وصلنا|وصل|وصلته|نزلت|نزلته|نزلناه|سجلت|سجلتها|سجلته|اعطيت|عطيت|قلت)(?: \S+){0,4} (?:لل|ل|ال|في ال|بال)?مطبخ(?: |$)|(?:^| )(?:المطبخ|مطبخنا) (?:بدا|بدء|يجهز|شغال|استلم|وصله|عنده|يحضر|جاري)(?: |$)|(?:to|for) the kitchen|kitchen (?:has|got|is preparing|received)|(?:sent|passed|told|noted|wrote) (?:it |this |that )?(?:to|for) the kitchen/;
const ORDER_STATE_RE = /(?:^| )[وف]?(?:طلبك|طلبكم|الطلب) (?:جاهز|صار جاهز|اتاكد|تاكد|تم تاكيده|اتسجل|تسجل|انسجل|قيد التجهيز|جاري تجهيزه|بدينا فيه|بدانا فيه|نزل|وصلنا|في المطبخ|عند المطبخ|تم)(?: |$)|(?:^| )(?:بدينا|بدانا|بدا|جاري) (?:ال)?تجهيز|(?:^| )(?:اكدت|سجلت|ثبت) (?:لك )?(?:ال)?طلب|(?:^| )تم (?:تاكيد|تسجيل|ارسال) (?:ال)?طلب|your order (?:is (?:ready|confirmed|placed|being prepared)|has been (?:placed|confirmed|sent))|(?:i|we) (?:have )?(?:placed|confirmed) your order/;
const PREPARED_RE = /(?:^| )[وف]?(?:جهزت|جهزتها|جهزته|جهزتهم|جهزنا|جهزناها|جهزناه)(?: |$)|(?:^| )[وف]?(?:سلتك|السله|سلتكم) (?:جاهزه|جاهز|صارت جاهزه)(?: |$)|(?:^| )[وف]?(?:اجهز|نجهز|بجهز|راح اجهز|حجهز|سوف اجهز|ساجهز|نجهزه|اجهزه|اجهزها|نجهزها|اجهزهم)(?: (?:لك|لكم|لك ال|الحين|من الحين|سلتك|السله|طلبك|الطلب|الطلب الحين))+|i(?:'?ve| have) (?:prepared|made|set up) your (?:cart|order)|your cart is ready|i(?:'?ll| will) prepare (?:your|the) (?:cart|order)/;
const ADDED_RE = /(?:^| )[وف]?(?:اضفت|ضفت|اضفته|اضفتها|اضفتهم|ضفته|ضفتها|حطيت|حطيته|حطيتها|ضفنا|اضفنا|حطينا)(?: |$)|(?:^| )تم (?:اضافه|اضافته|اضافتها)(?: |$)|i(?:'?ve| have) added|added (?:it|them|that) to your (?:cart|order)/;
const ASKING_RE = /(?:^| )(?:اذا|واذا|لو|ولو|تحب|تحبين|تبي|تبين|تبغى|تبغي|تبغين|ودك|ودكم|هل|اذا تبي|لو تبي|لو حاب|لو تحب|متى ما|ابشر لو)(?: |$)|\b(?:would you|shall i|do you want|want me|should i|if you (?:want|like))\b/;
/* الجملة اللي فيها الكلمة: من آخر فاصل جملة قبلها لأول فاصل بعدها. علامة الاستفهام في آخرها أو «تحب / تبي / هل» قبلها ⇒ سؤال/عرض مش وعد. */
function sentenceAround(raw, idx, len) {
  const s = String(raw || "");
  const startCut = Math.max(s.lastIndexOf("\n", idx), (() => { const m = s.slice(0, idx).match(/[.!؟?][^.!؟?]*$/); return m ? s.slice(0, idx).length - m[0].length + 1 : 0; })());
  const rest = s.slice(idx + len); const e = rest.search(/[.!؟?\n]/);
  const end = e < 0 ? s.length : idx + len + e + 1;
  return { text: s.slice(Math.max(0, startCut), end), question: e >= 0 && /[؟?]/.test(rest[e]) };
}
function firstHit(re, raw) {
  const n = N(raw);
  const m = re.exec(n); if (!m) return null;
  /* موقع تقريبي في النص الأصلي: الكلمة الأولى من التطابق */
  const word = m[0].trim().split(" ")[0];
  const rawN = String(raw || "");
  let idx = -1;
  for (const cand of rawN.split(/(\s+)/)) { if (N(cand) === word) { idx = rawN.indexOf(cand); break; } }
  return { value: m[0].trim(), idx: idx < 0 ? 0 : idx, len: idx < 0 ? 0 : word.length };
}
/* ⇒ [{ type: "promise_not_done", value, kind }] — kind: kitchen | order_state | prepared | added
   actions = { cartBuilt, cartTouched } (الدور ده). */
export function promiseProblems(text, { cartBuilt = false, cartTouched = false } = {}) {
  const raw = String(text || ""), out = [];
  if (!raw.trim()) return out;
  const k = firstHit(KITCHEN_RE, raw); if (k) out.push({ type: "promise_not_done", kind: "kitchen", value: k.value.slice(0, 50) });
  const o = firstHit(ORDER_STATE_RE, raw); if (o) out.push({ type: "promise_not_done", kind: "order_state", value: o.value.slice(0, 50) });
  if (!cartBuilt) {
    const p = firstHit(PREPARED_RE, raw);
    if (p) { const s = sentenceAround(raw, p.idx, p.len); if (!s.question && !ASKING_RE.test(N(s.text))) out.push({ type: "promise_not_done", kind: "prepared", value: p.value.slice(0, 50) }); }
  }
  if (!cartBuilt && !cartTouched) {
    const a = firstHit(ADDED_RE, raw);
    if (a) { const s = sentenceAround(raw, a.idx, a.len); if (!s.question && !ASKING_RE.test(N(s.text))) out.push({ type: "promise_not_done", kind: "added", value: a.value.slice(0, 50) }); }
  }
  return out;
}
export const PROMISE_HELP = "you said something happened that did NOT happen in this turn (that you prepared or added to the cart, that you wrote to the kitchen, or that the order is confirmed/ready). Nothing reaches the kitchen from this chat: the kitchen sees an order only after the customer pays on the website. Say only what really happened: if the customer agreed, call build_cart now (the button is attached); if you only priced it, say the price; a note goes «في سلتك» (in their cart), never «للمطبخ»";

/* ── ٢) الموافقة على التجهيز ───────────────────────────────────────────────── */
const GA_LEAD = "(?:ايه|ايوه|ايوا|اي|نعم|تمام|اوكي|اوك|ok|okay|يلا|يالله|خلاص|طيب|زين|ابشر|اكيد|يب|yes|yeah|اوكيه|تم)";
const GA_CORE = "(?:جهزه|جهزها|جهزهم|جهزو|جهزوه|جهزوها|جهزلي|جهزيه|جهزيها|جهز|جهز الطلب|جهز طلبي|جهزه لي|جهزها لي|اطلب|اطلبه|اطلبها|اطلبهم|اطلب لي|اطلبلي|اطلبه لي|اطلبها لي|ابغي اطلب|ابي اطلب|ابغا اطلب|ابا اطلب|نبي نطلب|نبغي نطلب|ودي اطلب|اعتمد|اعتمده|اعتمدها|اعتمدهم|ثبت|ثبته|ثبتها|كمل|كمله|كملها|كمل الطلب|سوه|سويه|سويها|ارسل السله|ابعت السله|ارسل الرابط|ابغي السله|ابي السله|i want to order|order it|go ahead|confirm|place (?:the|my) order)";
const GA_TAIL = "(?:علي ما اوصل|على ما اوصل|لين اوصل|لحد ما اوصل|لو سمحت|من فضلك|الحين|بسرعه|يا ماجد|يا غالي|الله يعافيك|please|pls|now|كذا|هيك|زي ما هو|زي ماهو|مثل ما هو|نفسه|نفس الشي)";
export const GO_AHEAD_RE = new RegExp(`^(?:${GA_LEAD} )*${GA_CORE}(?: ${GA_TAIL})*$`);
export function isGoAhead(text, tapId = null) {
  const id = String(tapId || "").trim();
  if (id === "أبغى أطلب" || id === "I want to order" || id === "as:yes") return true;
  const n = N(text);
  return Boolean(n) && n.length <= 60 && GO_AHEAD_RE.test(n);
}

/* ── ٣) سبام ─────────────────────────────────────────────────────────────────── */
const SPAM_RE = /temu\.(?:com|to)|tem\.?u\b|تيمو|shein\.|شي ان|علي اكسبريس|aliexpress|invite(?:d)? (?:you|code)|referral code|join (?:me|now)|free gift|claim (?:your|now)|earn \$|make money|crypto|bitcoin|forex|investment opportunity|اربح|ربح مضمون|هديه مجانيه|اضغط الرابط|سجل الان واحصل|كود الدعوه|رابط الدعوه|استثمار مضمون/i;
const SPAM_HOST_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:temu|shein|aliexpress|bit\.ly|tinyurl|t\.co|cutt\.ly|s\.click)\b/i;
export function spamKind(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  if (SPAM_HOST_RE.test(raw)) return "link";
  if (SPAM_RE.test(raw) || SPAM_RE.test(N(raw))) return "promo";
  return null;
}

/* ── ٤) العميل جاي للفرع ───────────────────────────────────────────────────── */
const COMING_RE = /^(?:(?:انا|احنا|اني|طيب|تمام|اوكي|خلاص|حبيبي|حبيبنا|يا غالي)\s)*(?:جاي|جايه|جايين|جيت|جاك|جايك|جايكم|جايينكم|بجي|راح اجي|حاجي|بمر|بمرك|في الطريق|بالطريق|على الطريق|علي الطريق|وصلت|وصلنا|قريب منكم|قريب|قدام المحل|عند الباب|عند المحل|برا|بره|انا تحت|i'?m coming|on my way|coming|i'?m here|arrived)(?:\s(?:ل(?:ل)?محل|ل(?:ل)?مطعم|ل(?:ل)?فرع|لكم|عندكم|اليكم|الحين|خلاص|دقيقه|دقيقتين|\d+ (?:دقيقه|دقايق|دقيقة|min|mins|minutes)|وراح استلم|واستلم|استلم|بستلم))*$|^(?:\d+|دقيقه|دقيقتين|خمس|عشر|ربع ساعه|نص ساعه)\s?(?:دقيقه|دقايق|دقيقة|دقائق|min|mins|minutes)?\s?(?:و|and)\s?(?:اكون|بكون|نكون|i'?ll be)\s?(?:عندكم|عندك|هناك|there)$/;
export function comingKind(text) {
  const n = N(AR_DIGITS(text));
  return n && n.length <= 60 && COMING_RE.test(n) ? "coming" : null;
}

/* ── ٥) اللغة ─────────────────────────────────────────────────────────────── */
const LONE_GREET_RE = /^(?:hi|hii|hiii|hello|helo|hellow|hey|heya|hai|hallo|good (?:morning|evening|afternoon|night)|morning|evening|yo|sup)(?: (?:there|sir|all|guys|team|fresh cuts))?$/;
export const loneLatinGreeting = (text) => LONE_GREET_RE.test(N(text));
/* نص زر إعلانات «راسلنا» الجاهز عند ميتا (بالإنجليزي) — العميل ماكتبهوش بنفسه، وعميلنا في جدة ⇒ الرد بالعربي */
const AD_PREFILL_RE = /^(?:hello|hi|hey)?\s?(?:can i get|could i get|i(?:'d| would) like|i want|tell me|send me) (?:more )?(?:info|information|details|more details)(?: (?:on|about) (?:this|that|it|the offer|your offer))?$|^(?:is this|is it) (?:still )?available$|^(?:i(?:'m| am) interested(?: in this)?)$|^(?:what(?:'s| is) the price)$/;
export const adPrefillEn = (text) => AD_PREFILL_RE.test(N(text));
/* نص إعلان جاهز بالعربي («أبغى أعرف أكثر») — نية مهتم (نكمّل لما نفتح بيعدّها نية طلب) */
const AD_PREFILL_AR_RE = /^(?:مرحبا|السلام عليكم|هلا)?\s?(?:ابغي|ابي|اريد|ممكن|ودي) (?:اعرف|معلومات|تفاصيل) (?:اكثر|اكتر|عن العرض|عن هذا)$|^(?:مهتم|مهتمه)(?: بالعرض)?$/;
export const adPrefill = (text) => adPrefillEn(text) || AD_PREFILL_AR_RE.test(N(text));
/* BF3 (…4268 ٢٠/١٠ «Online» ثم «Offers» ⇒ رد إنجليزي كامل): كلمة أو كلمتين لاتيني / نص زر قصير / تحية / نص إعلان جاهز = مش جملة إنجليزي حقيقية */
export { latinShort };
export const notRealEnglish = (text) => loneLatinGreeting(text) || adPrefillEn(text) || latinShort(text);

/* ── ٦) «ده الموقع مظبوط» بعد ما شارك موقعه ────────────────────────────────── */
const LOC_ASK_RE = /(?:^| )(?:وين|فين|اين|ارسل|ارسلي|ارسلو|ابعت|ابعتلي|عطني|اعطني|ابي|ابغي|ودي|ممكن|رابط|لوكيشنكم|موقعكم|مكانكم|عنوانكم|المحل|المطعم|الفرع|محلكم|مطعمكم|فرعكم|where|send|share|your location|link)(?: |$)/;
const LOC_CONFIRM_RE = /(?:^| )(?:الموقع|موقعي|اللوكيشن|لوكيشني|العنوان|عنواني|ده|دا|هذا|هذي|هدا)(?: |$).*(?:^| )(?:صح|مظبوط|مضبوط|صحيح|تمام|بالضبط|هو|هذا هو|ده هو|correct|right)(?: |$)|^(?:صح|مظبوط|مضبوط|صحيح|تمام|ايوه هذا|ايوه هو|نعم هذا|correct|that'?s (?:it|right|correct))$/;
export function locationConfirm(text) {
  const n = N(text);
  if (!n || n.length > 60 || /[?؟]/.test(String(text || ""))) return false;
  return LOC_CONFIRM_RE.test(n) && !LOC_ASK_RE.test(n);
}

/* ── ٧) رابط ريل / بوست ───────────────────────────────────────────────────── */
const SOCIAL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch|fb\.com|instagram\.com|instagr\.am|tiktok\.com|vm\.tiktok\.com|snapchat\.com|x\.com|twitter\.com|youtube\.com|youtu\.be)\/\S*/i;
export const socialLink = (text) => SOCIAL_RE.test(String(text || ""));

/* ── ٨) سؤال عن موظف بالاسم ────────────────────────────────────────────────── */
const STAFF_NAME_RE = /(?:^| )(?:استاذ|الاستاذ|ا|استاذه|يا استاذ|مستر|كابتن|ابو|الاخ|اخ)\s?(?:محمد|احمد|علي|عمر|خالد|عبدالله|عبد الله|محمود|مصطفي|ابراهيم|يوسف|حسن|حسين|سعيد|مايكل|مينا|\S{3,12})(?: |$).{0,20}(?:حضرتك|انت|موجود|معي|معاي|عندكم|فين|وين)|(?:حضرتك|انت) (?:استاذ|الاستاذ|مستر) \S+/;
export const asksStaffByName = (text) => STAFF_NAME_RE.test(N(text)) && /[?؟]|حضرتك|انت|موجود/.test(String(text || "") + N(text));

/* ── ٩) العرض خلص ⇒ بديل لنفس العدد ───────────────────────────────────────── */
const NUM_W = { واحد: 1, شخص: 1, اثنين: 2, اتنين: 2, شخصين: 2, نفرين: 2, ثلاثه: 3, تلاته: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, ثمانيه: 8, عشره: 10 };
/* عدد الأشخاص من اسم العرض/الحملة («باقة التجمّع 4–6 أشخاص» ⇒ 5، «لشخصين» ⇒ 2، «الفردي» ⇒ 1، «العائلة» ⇒ 4). مش معروف ⇒ null */
export function partySizeOf(text) {
  const n = N(AR_DIGITS(text));
  if (!n) return null;
  let m = /(\d{1,2})\s?(?:-|الي|لـ|ل|to)?\s?(\d{1,2})\s?(?:اشخاص|شخص|افراد|نفر|persons|people|pax)/.exec(n);
  if (m) { const a = Number(m[1]), b = Number(m[2]); if (a > 0 && b >= a && b <= 60) return Math.round((a + b) / 2); }
  m = /(\d{1,2})\s?(?:اشخاص|شخص|افراد|نفر|persons|people|pax)/.exec(n);
  if (m && Number(m[1]) > 0 && Number(m[1]) <= 60) return Number(m[1]);
  for (const [w, v] of Object.entries(NUM_W)) if (new RegExp(`(?:^| )(?:ل|لل)?${w}(?: (?:اشخاص|شخص|افراد))?(?: |$)`).test(n) && /شخص|اشخاص|افراد|نفر|شخصين|نفرين/.test(n)) return v;
  if (/(?:^| )(?:ال)?(?:فردي|فرديه)(?: |$)|لشخص واحد|لوحدي|solo|single/.test(n)) return 1;
  if (/شخصين|لاثنين|نفرين|couple|for two/.test(n)) return 2;
  if (/عائل|عايل|عيله|عيلة|family/.test(n)) return 4;
  if (/تجمع|عزيمه|عزومه|جمعه|gathering/.test(n)) return 6;
  return null;
}
/* أقرب بوكس حي لنفس العدد: قسم البوكسات (فردي / لشخصين / العائلة والمشاركة) من عدد الأشخاص، وجوّه القسم الأقرب في السعر لسعر العرض اللي خلص
   (مفيش سعر ⇒ الأغلى في قسم العائلة للعدد الكبير، الأرخص غير كده). باقات التجمعات (من غير قسم) للعدد ٧+. ⇒ بوكس أو null */
const TIER_OF = [/فردي|فرديه|solo|single/i, /شخصين|اثنين|two|duo/i, /عائل|عايل|مشارك|family|sharing/i];
export function altBoxFor({ people = null, price = null, bundles = [] } = {}) {
  const list = (Array.isArray(bundles) ? bundles : []).filter((b) => b && b.slug && Number(b.price) > 0 && b.active !== false && b.available !== false);
  if (!list.length || !(Number(people) > 0)) return null;
  const p = Number(people);
  let pool = [];
  if (p >= 7) pool = list.filter((b) => !String(b.section || "").trim());
  if (!pool.length) {
    const tier = p <= 1 ? 0 : p === 2 ? 1 : 2;
    pool = list.filter((b) => TIER_OF[tier].test(`${b.section || ""} ${b.section_en || ""}`));
  }
  if (!pool.length) return null;
  const target = Number(price) > 0 ? Number(price) : null;
  const sorted = [...pool].sort((a, b) => (target != null ? Math.abs(Number(a.price) - target) - Math.abs(Number(b.price) - target) : (p >= 3 ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price))) || String(a.slug).localeCompare(String(b.slug)));
  return sorted[0] || null;
}

/* ── شكر / مدح بعد طلب (…3214: «طلبت خلاص… مطعمكم الأفضل عندي» كلّف ٠٫٢٢ ر.س كأول دور مساعد) ⇒ رد الشكر الثابت ── */
const PRAISE_RE = /(?:^| )(?:شكرا|شكر|مشكور|مشكورين|يعطيك العافيه|يعطيكم العافيه|الله يعطيكم|تسلم|تسلمون|تسلمو|الله يسلمك|الافضل|افضل مطعم|ممتاز|ممتازين|روعه|رهيب|لذيذ|حلو مره|طلبت خلاص|طلبنا خلاص|thanks|thank you|thx|great|delicious|best)(?: |$)/;
export const praiseOnly = (text) => { const raw = String(text || ""), n = N(raw); return Boolean(n) && !/[?؟]/.test(raw) && n.length <= 200 && PRAISE_RE.test(n) && !/(?:^| )(?:ابي|ابغي|ابغا|اريد|عايز|كم|بكم|وين|متى|ليش|ممكن)(?: |$)/.test(n); };

/* ── BF3 (٢٠/١٠ …5082): مدح الأكل / الخدمة («الشوي انهارده احسن من امبارح») ⇒ شكر دافي قصير، مش «سؤالك يحتاج واحد من الفريق» ──
   مدح = (اسم أكل/خدمة + كلمة حلوة في نفس الجملة) أو عبارة مدح معروفة («ما شاء الله»، «تسلم ايدكم») أو كلمة مدح لوحدها («تحفه»).
   أي كلمة سلبية («بس»، «لكن»، «بارد»، «مجاش»، «كان احسن»…) أو سؤال أو طلب ⇒ مش مدح (مسار الشكوى / المساعد زي ما هو). */
const FOOD_W = "(?:ال|و|وال)?(?:اكل|اكلكم|شوي|شويكم|مشاوي|مشاويكم|شواء|لحم|لحمكم|دجاج|كريب|كريبكم|طعم|طعمه|طعمها|طبخ|طبخكم|وجبه|طلب|طلبي|طلبكم|مطعم|مطعمكم|خدمه|خدمتكم|توصيل|توصيلكم|تعامل|تعاملكم|كل شي|food|grill|meal|chicken|meat|service)";
const GOOD_W = "(?:احسن|افضل|الافضل|ممتاز|ممتازه|روعه|رائع|رائعه|رايع|تحفه|تخفه|يجنن|تجنن|خطير|خطيره|فخم|فخمه|لذيذ|لذيذه|حلو|حلوه|طيب|طيبه|نار|رهيب|رهيبه|جميل|جميله|عسل|زاكي|زاكيه|يهبل|اسطوري|excellent|perfect|amazing|delicious|great|awesome|tasty|best)";
/* كلمة لوحدها: بس كلمات المدح الصريحة — «حلو / طيب / زين / ممتاز / great» لوحدها غالباً «تمام» (موافقة / إقفال كلام)، مش مدح */
const GOOD_ALONE = "(?:تحفه|تخفه|يجنن|تجنن|روعه|خطير|فخم|رهيب|لذيذ|اسطوري|يهبل|delicious|amazing)";
const PRAISE_PHRASE = "(?:ما شاء الله|ماشاء الله|تبارك الله|الله يبارك فيكم|الله يبارك لكم|عاشت ايدكم|عاشت ايديكم|تسلم ايدكم|تسلم ايديكم|تسلم ايدك|تسلم يدك|تسلم يدينكم|بيض الله وجيهكم|ابدعتو|ابدعتوا|ابدعتم|مبدعين|كفو|كفو والله)";
const COMPLIMENT_RE = new RegExp(`(?:^| )${FOOD_W}(?: \\S+){0,3} ${GOOD_W}(?: |$)|(?:^| )${GOOD_W}(?: \\S+){0,2} ${FOOD_W}(?: |$)|(?:^| )${PRAISE_PHRASE}(?: |$)|^${GOOD_ALONE}(?: (?:والله|مره|جدا|بجد|كثير|ما شاء الله))*$`);
const COMPLIMENT_NEG_RE = /(?:^| )(?:بس|لكن|بالعكس|مو|مش|مب|ماكان|مكانش|ماكانش|مجاش|ماجا|ما جا|ماجاني|ماوصل|ما وصل|ناقص|نقص|بارد|بارده|ني|نيء|محروق|محروقه|ناشف|ناشفه|مالح|مالحه|حامض|متاخر|تاخر|تاخرتو|تاخرتوا|سيء|سيئ|سيئه|زفت|خايس|خايسه|وحش|وحشه|اسوا|غلط|نسيتو|نسيتوا|شكوي|مشكله|زعلان|زعلانه|للاسف|خساره|مقرف|but|not|cold|late|bad|worst|wrong|missing)(?: |$)|(?:كان|كانت|زمان|قبل) (?:احسن|افضل|الذ)/;
const COMPLIMENT_ASK_RE = /(?:^| )(?:اي|ايش|وش|شو|هل|ولا|او|which|what|any|do|can|ابي|ابغي|ابغا|اريد|عايز|عاوز|كم|بكم|وين|فين|متي|ليش|ممكن|اطلب|بطلب|نطلب|عندكم|فيه|في)(?: |$)/;
export function complimentOnly(text) {
  const raw = String(text || ""), n = N(AR_DIGITS(raw));
  if (!n || n.length > 200 || /[?؟]/.test(raw)) return false;
  return COMPLIMENT_RE.test(n) && !COMPLIMENT_NEG_RE.test(n) && !COMPLIMENT_ASK_RE.test(n);
}
/* اللي العميل مدحه ⇒ متغيّر {what} في رد الشكر («يسعدنا إن الشوي عجبك») */
export function praiseWhat(text) {
  const n = N(text);
  if (/شوي|مشاوي|شواء|grill/.test(n)) return { ar: "الشوي", en: "the grill" };
  if (/كريب/.test(n)) return { ar: "الكريب", en: "the crepe" };
  if (/(?:^| )(?:ال)?(?:خدمه|خدمتكم|تعامل|تعاملكم|توصيل|توصيلكم)(?: |$)|service/.test(n) && !/اكل|طعم|لحم|دجاج|food|meal/.test(n)) return { ar: "التعامل", en: "our service" };
  return { ar: "الأكل", en: "the food" };
}
