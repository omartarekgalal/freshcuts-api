/* ═══════════════════════════════════════════════════════════════════════════
   سلة جاهزة من البوت — «نفس طلبك الأخير؟» بضغطة (١٢/١٠/٢٠٢٦)

   طلب عمر: «ايوه بضغطة واحدة يتبعتله رابط سلة جاهز». الرابط هو نفس صفحة الاسترداد الموجودة freshcuts.sa/c/<code>
   (carts.js بيسأل هنا لو الكود مش رابط استرداد ولا سلة إعلان) — مفيش أي تعديل في المتجر.

   المصدر: لقطة سلة العميل نفسه وقت طلبه الأخير (shop_carts.cart_raw المربوطة بالطلب بـrecovered_order) — نفس السطور بالظبط
   (الباقات باختياراتها، الأوزان، الملاحظات). مش بنعيد تركيب السلة من سطور الطلب: سطور الطلب متوسّعة على السيرفر ومايترجعش منها
   اختيار العميل بأمان.

   قبل ما الرابط يتبعت كل سطر بيتراجع على المنيو والباقات الحيّة: صنف اتشال أو مخفي أو خلص اليوم ⇒ بيتشال من السلة ويتقال
   للعميل بالاسم؛ باقة سعرها اتغيّر ⇒ بيتقال السعر القديم والجديد؛ صنف كان عليه إضافات (اللقطة مابتحفظش إضافات الصنف العادي) ⇒
   بيتقال للعميل يراجعها. المتجر نفسه بيعيد التسعير من المنيو الحي وقت الفتح، والدفع بيتأكد تاني.

   جدول لوحده (wa_bot_carts) عشان مايلمسش منطق «السلات المتروكة» (التهدئة، الإحصائيات، ربط الطلب بالاسترداد).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

export const BOT_CART_CODE_RE = /^[a-z0-9]{6,16}$/;
export const BOT_CART_DDL = `
  CREATE TABLE IF NOT EXISTS wa_bot_carts (
    id BIGSERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    phone_norm TEXT NOT NULL,
    source TEXT NOT NULL,               -- reorder | assistant
    from_order TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    cart_raw JSONB,
    option TEXT,
    note JSONB,                         -- اللي اتشال / اتغيّر سعره / محتاج مراجعة وقت التجهيز
    opens INT NOT NULL DEFAULT 0,
    opened_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wa_bot_carts_phone_idx ON wa_bot_carts(phone_norm, created_at DESC);
`;
const newCode = () => crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 8).padEnd(8, "x");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const qtyOf = (v) => Math.min(99, Math.max(1, Math.round(Number(v) || 1)));
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/* لقطة سلة الطلب الأخير ⇒ خطة السلة الجاهزة على المنيو والباقات الحيّة.
   snap = { raw (state.cart من المتجر), items [{id,n,q,p}] (اسم وسعر الوحدة وقت اللقطة) }
   live = { menu (wabot.indexMenu), bundles ([{slug,name,name_en,price}]) }
   ⇒ { ok, lines:[{name,nameEn,q}], removed:[{name,why:"gone"|"sold_out"}], repriced:[{name,was,now}], review:[name], raw, items }
   ok=false لو مفيش حاجة تتجهّز (مفيش لقطة، المنيو أو الباقات مش متاحة، أو كل الأصناف اتشالت). مفيش تخمين: مصدر ناقص ⇒ مفيش خطة. */
export function reorderPlan(snap, live) {
  const out = { ok: false, lines: [], removed: [], repriced: [], review: [], raw: {}, items: [] };
  const raw = snap && isObj(snap.raw) ? snap.raw : null;
  const menu = live && live.menu, bundles = live && Array.isArray(live.bundles) ? live.bundles : null;
  if (!raw || !Object.keys(raw).length) return { ...out, why: "no_snapshot" };
  if (!menu || !Array.isArray(menu.items) || !menu.items.length) return { ...out, why: "menu_unavailable" };
  const shot = new Map((Array.isArray(snap.items) ? snap.items : []).map((x) => [String(x.id), x]));
  const byId = new Map(menu.items.map((i) => [String(i.id), i]));
  for (const [key, e] of Object.entries(raw).slice(0, 60)) {
    if (!isObj(e)) continue;
    const q = qtyOf(e.qty);
    if (isObj(e.bundle) && e.bundle.slug) {
      if (!bundles) return { ...out, lines: [], why: "bundles_unavailable" };
      const b = bundles.find((x) => String(x.slug) === String(e.bundle.slug));
      const oldName = String(e.bundle.name || e.bundle.slug);
      if (!b || !(Number(b.price) > 0)) { out.removed.push({ name: oldName, why: "gone" }); continue; }
      if (Number(e.bundle.price) > 0 && !same(b.price, e.bundle.price)) out.repriced.push({ name: String(b.name), was: Number(e.bundle.price), now: Number(b.price) });
      out.raw[key] = { ...e, qty: q, bundle: { ...e.bundle, name: b.name, name_en: b.name_en, price: b.price } };
      out.lines.push({ name: String(b.name), nameEn: String(b.name_en || b.name), q });
      out.items.push({ id: `b:${b.slug}`, n: String(b.name).slice(0, 60), q, p: Number(b.price) });
      continue;
    }
    const id = String((isObj(e.item) && e.item.id != null ? e.item.id : String(key).split(":")[0]) ?? "");
    const was = shot.get(id) || shot.get(String(key));
    const it = byId.get(id);
    if (!it) { out.removed.push({ name: String((was && was.n) || "").trim() || `#${id}`, why: "gone" }); continue; }
    if (it.soldOut) { out.removed.push({ name: it.name, why: "sold_out" }); continue; }
    /* صنف عادي من غير حجم/وزن: سعر اللقطة لازم يساوي سعر المنيو. لو مختلف: يا السعر اتغيّر يا كان عليه إضافات (اللقطة مابتحفظهاش)
       ⇒ مانقولش «السعر اتغيّر» (ممكن يبقى غلط) — نقول للعميل يراجع الصنف ده في السلة. */
    if (!e.variant && was && Number(was.p) > 0 && !same(was.p, it.price)) out.review.push(it.name);
    out.raw[key] = { item: { id: it.id }, qty: q, ...(e.note ? { note: e.note } : {}), ...(e.variant ? { variant: e.variant } : {}) };
    out.lines.push({ name: it.name, nameEn: it.nameEn || it.name, q });
    out.items.push({ id, n: String(it.name).slice(0, 60), q, p: Number(it.price) });
  }
  out.ok = out.lines.length > 0;
  if (!out.ok) out.why = "nothing_left";
  return out;
}
/* وصف قصير للسلة لصف القائمة (حد واتساب ٧٢ حرف) */
export function planSummary(plan, lang = "ar", max = 72) {
  const parts = (plan?.lines || []).map((l) => `${l.q > 1 ? `${l.q}× ` : ""}${lang === "en" ? l.nameEn : l.name}`);
  let s = "";
  for (let i = 0; i < parts.length; i++) {
    const next = s ? `${s}، ${parts[i]}` : parts[i];
    const more = parts.length - i - 1;
    if ([...next].length + (more ? 4 : 0) > max) { s = s ? `${s} +${parts.length - i}` : `${[...parts[i]].slice(0, max - 1).join("")}…`; break; }
    s = next;
  }
  return s;
}

export function makeBotCarts({ pool, log = console.error }) {
  let schemaP = null;
  const ensure = () => (schemaP ||= pool.query(BOT_CART_DDL).catch((e) => { schemaP = null; throw e; }));
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { log("[wabot-cart] db:", e.message); return null; } };

  /* آخر طلب للعميل ولقطة سلته: لازم اللقطة تكون مربوطة **بآخر طلب مدفوع** لنفس الرقم، وإجماليها يساوي إجمالي أصناف الطلب.
     أي اختلاف ⇒ null (مانعرضش «نفس الطلب» على سلة مش متأكدين إنها هي). */
  async function lastOrderCart(phone, maxDays) {
    if (!/^5\d{8}$/.test(String(phone || ""))) return null;
    const o = await q(`SELECT order_no, option, subtotal, created_at FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false)
                         AND status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')
                         AND created_at > NOW() - make_interval(days => $2::int) ORDER BY created_at DESC LIMIT 1`, [phone, Math.ceil(maxDays)]);
    if (!o || !o[0]) return null;
    const c = await q(`SELECT items, cart_raw, subtotal, option FROM shop_carts WHERE phone_norm=$1 AND recovered_order=$2 AND cart_raw IS NOT NULL ORDER BY recovered_at DESC LIMIT 1`, [phone, o[0].order_no]);
    if (!c || !c[0] || !isObj(c[0].cart_raw)) return null;
    if (!same(c[0].subtotal, o[0].subtotal)) return null;
    return { orderNo: o[0].order_no, option: o[0].option || c[0].option || null, at: o[0].created_at, raw: c[0].cart_raw, items: Array.isArray(c[0].items) ? c[0].items : [] };
  }
  async function taken(code) {
    const r = await q(`SELECT 1 FROM cart_recovery WHERE code=$1 UNION ALL SELECT 1 FROM cart_presets WHERE code=$1 LIMIT 1`, [code]);
    return r === null || r.length > 0;      // مانعرفش ⇒ نعتبره محجوز ونجرّب كود تاني
  }
  /* سلة جاهزة جديدة ⇒ { code } أو null */
  async function create({ phone, source, fromOrder = null, plan, option = null, days = 7 }) {
    if (!/^5\d{8}$/.test(String(phone || "")) || !plan || !plan.ok) return null;
    await ensure();
    for (let i = 0; i < 6; i++) {
      const code = newCode();
      if (await taken(code)) continue;
      const r = await q(`INSERT INTO wa_bot_carts(code, phone_norm, source, from_order, items, cart_raw, option, note, expires_at)
                         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb, NOW() + make_interval(days => $9::int)) ON CONFLICT (code) DO NOTHING RETURNING code`,
        [code, phone, String(source).slice(0, 20), fromOrder, JSON.stringify(plan.items || []), JSON.stringify(plan.raw || {}), option ? String(option).slice(0, 12) : null,
          JSON.stringify({ removed: plan.removed || [], repriced: plan.repriced || [], review: plan.review || [] }), Math.max(1, Math.ceil(days))]);
      if (r && r[0]) return { code: r[0].code };
    }
    return null;
  }
  /* اللي carts.js بينده عليه: فتح الرابط (عدّ + رابط الهبوط) واسترجاع السلة. منتهي أو مش موجود ⇒ null. */
  async function open(code) {
    if (!BOT_CART_CODE_RE.test(String(code || ""))) return null;
    const r = await q(`UPDATE wa_bot_carts SET opens = opens + 1, opened_at = COALESCE(opened_at, NOW()) WHERE code=$1 AND expires_at > NOW() RETURNING source`, [code]);
    if (!r || !r[0]) return null;
    const p = new URLSearchParams();
    p.set("cart", code); p.set("utm_source", "whatsapp"); p.set("utm_medium", "bot");
    p.set("utm_campaign", r[0].source === "assistant" ? "wa_assistant" : "wa_reorder"); p.set("fc_link", r[0].source === "assistant" ? "wa-assistant" : "wa-reorder");
    return "/?" + p.toString();
  }
  async function restore(code) {
    if (!BOT_CART_CODE_RE.test(String(code || ""))) return null;
    const r = await q(`SELECT items, cart_raw, option FROM wa_bot_carts WHERE code=$1 AND expires_at > NOW()`, [code]);
    if (!r || !r[0]) return null;
    return { ok: true, items: Array.isArray(r[0].items) ? r[0].items : [], raw: isObj(r[0].cart_raw) && Object.keys(r[0].cart_raw).length ? r[0].cart_raw : null, option: r[0].option || "delivery", subtotal: 0, ordered: false };
  }
  return { ensure, lastOrderCart, create, open, restore };
}
