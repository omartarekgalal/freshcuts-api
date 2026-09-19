/* ═══════════════════════════════════════════════════════════════════════════
   اسم العميل في الشيك أوت — «الاسم الثنائي» (عمر ١٩ سبتمبر ٢٠٢٦).

   قبل كده الاسم بقى اختياري والفاضي بيتسجّل «عميل» — والنتيجة طلبات في نقطة
   البيع وعند المندوب من غير اسم. القاعدة دلوقتي:
     • كلمتين على الأقل (الاسم + اسم العائلة)
     • حروف عربي أو إنجليزي بس (مسافة/شرطة/فاصلة عليا بين الحروف مسموحة)
     • كل كلمة حرفين على الأقل، والاسم كله من ٥ لـ٤٠ حرف
   نفس القاعدة بالظبط في المتجر (checkout2.js H.nameCheck + app.js) عشان
   العميل يشوف الغلط تحت الخانة قبل ما يوصل للسيرفر أصلاً. السيرفر هو الحَكَم.
═══════════════════════════════════════════════════════════════════════════ */

export const NAME_MIN = 5;
export const NAME_MAX = 40;

// حروف عربي (من غير الأرقام ٠-٩ والرموز) + تشكيل + تطويل + لاتيني
const WORD = /^[A-Za-zء-غف-يٱ-ۓۺ-ۼً-ْـ]+(?:['’-][A-Za-zء-غف-يٱ-ۓۺ-ۼً-ْـ]+)*$/;
const LETTERS = /[A-Za-zء-غف-يٱ-ۓۺ-ۼ]/g;

export const NAME_MSG = {
  ar: "اكتب اسمك الثنائي (الاسم واسم العائلة) بالحروف",
  en: "Please enter your first and last name (letters only)",
};

/* يرجّع {ok, name, error}. name = الاسم بعد تنظيف المسافات. */
export function checkPersonName(raw) {
  const name = String(raw == null ? "" : raw).replace(/[‌-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, name, error: "name_required" };
  if (name.length > NAME_MAX) return { ok: false, name, error: "name_too_long" };
  const words = name.split(" ");
  if (!words.every((w) => WORD.test(w))) return { ok: false, name, error: "name_letters" };
  if (words.length < 2) return { ok: false, name, error: "name_two_words" };
  if (!words.every((w) => (w.match(LETTERS) || []).length >= 2)) return { ok: false, name, error: "name_two_words" };
  if (name.length < NAME_MIN) return { ok: false, name, error: "name_two_words" };
  return { ok: true, name, error: null };
}
