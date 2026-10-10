/* ── ميتا: مدفوع ولا مجاني؟ قاعدة واحدة للجلسات والطلبات والتقارير ─────────────
   المشكلة (١٠/١٠): بوستات صفحة فيسبوك المجانية (‎/l/96-fb-c07 ⇒ utm_source=facebook ·
   utm_medium=post · utm_campaign=nd96_organic) بتتفتح في متصفّح فيسبوك الداخلي، وفيسبوك
   بيلزق fbclid على **أي** رابط — إعلان أو بوست عادي. الكود كان بيقرأ «fbclid + مصدر
   فيسبوك» على إنه إعلان، فاللوحة عرضت ٣ طلبات ميتا / ٤٨٨ ر.س والإعلانات جابت ١ / ١٤٢.

   القاعدة: المدفوع يتعرف من **وسم الرابط نفسه**، مش من المتصفّح ولا من fbclid:
     1. utm_medium مدفوع (paid / cpc / paid_social …)            ⇒ مدفوع
     2. utm_medium موجود ومش مدفوع (post / story / bio / cta …)   ⇒ مجاني — الوسم الصريح يكسب
     3. من غير medium: الحملة فيها «organic»                      ⇒ مجاني
     4. من غير medium: رابط إعلان (96-m2-/96-m3-/96-meta-) أو utm_term فيه اسم/رقم
        الإعلان ({{ad.name}} ⇒ FC…، أو رقم الإعلان)               ⇒ مدفوع
        (ده الطلب اللي المتصفّح الداخلي مسح الـutm بتاعه وفضل وسم الإعلان)
     5. غير كده: utm_source=meta بالحرف (اسم بنستعمله في الإعلانات بس) ⇒ مدفوع؛
        وأي مصدر تاني لميتا (facebook / instagram / fb / ig) أو fbclid لوحده ⇒ مجاني
   كل روابط إعلاناتنا متوسّمة utm_medium=paid (cms_links + قوالب الحملات)، فالقاعدة ١ بتمسك
   الإعلانات كلها؛ ٤ شبكة أمان للوسم الناقص. الدالة pure ومختبرة (metatouch.test.mjs). */

const lc = (v) => String(v ?? "").trim().toLowerCase();

export const META_SOURCE_RE = /^(meta|fb|facebook|ig|instagram|messenger|an|msg)$/;
const IG_SOURCE_RE = /^(ig|instagram)$/;
// نفس تعريف journey.classifyChannel للوسيط المدفوع (كان مكتوب هناك)
export const isPaidMedium = (med) => /paid|cpc|ads?$|ppc|paid_social|sponsored/.test(lc(med));
const AD_LINK_RE = /^96-(m2|m3|meta)-/;
/* utm_term = {{ad.name}} في قوالب ميتا: أسماء إعلاناتنا بتبدأ FC، والقوالب الجديدة بتحط رقم الإعلان (١٢+ رقم).
   BGID_* بتاع سناب مش وسم ميتا. */
export const isAdTerm = (term) => {
  const t = String(term ?? "").trim();
  return /^fc/i.test(t) || /^\d{12,}$/.test(t) || /^\{\{ad\./i.test(t);
};

/* input: { utm_source, utm_medium, utm_campaign, utm_term, link (fc_link | link_slug | utm_content), fbclid: bool }
   output: "paid" | "organic" | null (مش زيارة ميتا أصلاً) */
export function metaTouch(x = {}) {
  const src = lc(x.utm_source), med = lc(x.utm_medium), camp = lc(x.utm_campaign), link = lc(x.link);
  const isMetaSrc = META_SOURCE_RE.test(src);
  const fbclid = !!x.fbclid;
  // مصدر تاني صريح (sms / google / qr …) ⇒ مش ميتا حتى لو فيه fbclid قديم محفوظ
  if (src && !isMetaSrc) return null;
  const adTagged = AD_LINK_RE.test(link) || isAdTerm(x.utm_term);
  if (!isMetaSrc && !fbclid && !adTagged) return null;
  if (isPaidMedium(med)) return "paid";
  if (med) return "organic";
  if (/organic/.test(camp)) return "organic";
  if (adTagged) return "paid";
  // utm_source=meta بالاسم ده بنكتبه في روابط الإعلانات بس (المجاني facebook / instagram) ⇒ مدفوع حتى لو الـmedium وقع
  return src === "meta" ? "paid" : "organic";
}

/* اسم القناة المجانية: انستجرام ولا فيسبوك (المصدر الصريح، وإلا المتصفّح الداخلي، وإلا فيسبوك) */
export function metaOrganicName(x = {}) {
  const src = lc(x.utm_source);
  if (IG_SOURCE_RE.test(src)) return "instagram";
  if (META_SOURCE_RE.test(src)) return "facebook";
  return lc(x.in_app) === "instagram" || /(^|\.)instagram\.com$/.test(lc(x.referrer_host)) ? "instagram" : "facebook";
}
