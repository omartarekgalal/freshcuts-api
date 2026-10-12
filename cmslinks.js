/* ═══════════════════════════════════════════════════════════════════════════
   cmslinks.js — LK1 (١٣/١٠): أنواع «الرابط بيفتح إيه» في مكان واحد (دوال صافية).

   العطل: wasender.js كان عنده قايمة تانية ناقصة (home / collection / product / offer). رابط حملة نوعه «box» أو «gather»
   كان بيتخزّن «home» من غير أي تنبيه، فأزرار أول موجة حملة فتحت الصفحة الرئيسية بدل البوكس.
   دلوقتي محرر الروابط (cms.js)، محوّل ‎/l/<slug>‎ (cms.js)، وحملات واتساب (wasender.js) بيقروا من هنا.
═══════════════════════════════════════════════════════════════════════════ */

export const LINK_TARGET_TYPES = Object.freeze(["home", "collection", "product", "offer", "cart", "box", "gather"]);
/* أنواع مالهاش رقم/اسم هدف */
export const LINK_TARGETS_NO_ID = Object.freeze(["home", "gather"]);
const CART_RE = /^[a-z0-9]{6,16}$/;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/* تنضيف هدف الرابط بنفس قواعد محرر الروابط. unknown: "home" = الرجوع للرئيسية (سلوك المحرر القديم) · "refuse" = خطأ.
   بترجع { ok:true, target_type, target_id } أو { ok:false, error:"bad_target"|"target_missing"|"bad_cart_code", type } */
export function linkTarget(type, id, { unknown = "refuse" } = {}) {
  const raw = String(type ?? "").trim();
  let t = raw || "home";
  if (!LINK_TARGET_TYPES.includes(t)) {
    if (unknown !== "home") return { ok: false, error: "bad_target", type: raw.slice(0, 40) };
    t = "home";
  }
  if (LINK_TARGETS_NO_ID.includes(t)) return { ok: true, target_type: t, target_id: null };
  const tid = t === "cart" ? clip(id, 16).toLowerCase() : clip(id, 64);
  if (!tid) return { ok: false, error: "target_missing", type: t };
  if (t === "cart" && !CART_RE.test(tid)) return { ok: false, error: "bad_cart_code", type: t };
  return { ok: true, target_type: t, target_id: tid };
}

/* باراميترات المتجر اللي الهدف بيضيفها على رابط الهبوط (بالترتيب). «cart» مش هنا: محتاج قراءة السلة من القاعدة (cms.js). */
export function linkTargetParams(l) {
  const t = l && l.target_type, id = l && l.target_id;
  if (t === "collection" && id) return [["col", id]];
  if (t === "product" && id) return [["p", id]];
  if (t === "offer" && id) return [["go", "offers"], ["offer", id]];                 // المتجر بيفتح منتقي العرض على طول
  if (t === "box" && id) return [["go", "offers"], ["box", id], ...(l.autocart === true ? [["bxadd", "1"]] : [])];   // منتقي البوكس
  if (t === "gather") return [["go", "offers"], ["gather", "1"]];
  return [];
}

/* شكل رابط الهبوط للعرض في المعاينة (من غير UTM ولا كوبون): "/?go=offers&box=<id>" · "/" للرئيسية · "/?cart=<code>" للسلة */
export function linkTargetPath(l) {
  const q = new URLSearchParams();
  if (l && l.target_type === "cart" && l.target_id) q.set("cart", l.target_id);
  for (const [k, v] of linkTargetParams(l)) q.set(k, v);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
