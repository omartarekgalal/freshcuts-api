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

/* «يوم الأحد 11/10» بتوقيت الرياض — عشان العميل يعرف أنهي طلب اللي اتجهّز */
export function orderDay(at, lang = "ar") {
  const d = new Date(new Date(at).getTime() + 3 * 3600_000);
  if (Number.isNaN(d.getTime())) return "";
  const AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"], EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dm = `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  return lang === "en" ? `${EN[d.getUTCDay()]} ${dm}` : `يوم ${AR[d.getUTCDay()]} ${dm}`;
}

/* موقع العميل اللي شاركه في محادثة واتساب (wa_bot_chats.last_loc) ⇒ { lat, lng, at } لو سليم وعمره أقل من hours؛ غير كده null.
   at لازم يكون موجود (من غير وقت مشاركة مانعرفش عمره ⇒ مايتبعتش)، والوقت اللي في المستقبل مرفوض. */
export function chatLocation(loc, now = new Date(), hours = 24) {
  if (!isObj(loc)) return null;
  const lat = Number(loc.lat), lng = Number(loc.lng), at = Date.parse(loc.at);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isFinite(at)) return null;
  const age = now.getTime() - at;
  if (age < 0 || age >= Math.max(1, Number(hours) || 24) * 3600_000) return null;
  return { lat, lng, at: new Date(at).toISOString() };
}
/* locationHours: async () ⇒ عدد الساعات (إعداد assist.locationHours من اللوحة)؛ من غيره ٢٤. */
/* M3 — سطر صنف بالوزن في سلة محفوظة شايل سعر الوزن وقت ما السلة اتعملت، والرابط بيعيش أيام. نقطة البيع بترفض وقت الحساب أي سعر مش مطابق لسعرها
   (shop.js: «unit_amount and system price must match»)، فالعميل عمره ما يدفع سعر قديم — بس السلة كانت هتعرض رقم قديم والحساب يفشل. عشان كده وقت فتح الرابط:
   كل سطر بوزن بيتحدّث بسعر الوزن ده **الحين**؛ وزن مابقاش معروض ⇒ السطر بيتشال. أوزان الصنف مش معروفة الحين ⇒ السطر زي ما هو (مانخمّنش).
   byItem = { "<item id>": [{ variant_option_id, price, price_ex, label_ar, label_en }] } ⇒ { raw, repriced, dropped } */
export function repriceVariants(raw, byItem) {
  if (!isObj(raw) || !isObj(byItem)) return { raw, repriced: 0, dropped: 0 };
  const out = {}; let repriced = 0, dropped = 0;
  for (const [k, e] of Object.entries(raw)) {
    const v = isObj(e) && isObj(e.variant) && e.variant.id != null ? e.variant : null, id = isObj(e) && isObj(e.item) ? String(e.item.id) : null;
    const ws = v && id && Array.isArray(byItem[id]) ? byItem[id] : null;
    if (!ws) { out[k] = e; continue; }
    const w = ws.find((x) => String(x.variant_option_id) === String(v.id));
    if (!w) { dropped++; continue; }
    const next = { ...v, name: w.label_ar || v.name, ...(w.label_en ? { local_name: w.label_en } : {}), retail_price: w.price, ...(w.price_ex != null ? { price: w.price_ex } : {}) };
    if (Number(v.retail_price) !== Number(w.price) || (w.price_ex != null && Number(v.price) !== Number(w.price_ex))) repriced++;
    out[k] = { ...e, variant: next };
  }
  return { raw: out, repriced, dropped };
}
export function makeBotCarts({ pool, log = console.error, locationHours = null, weightsNow = null, now = () => new Date() }) {
  let schemaP = null;
  const ensure = () => (schemaP ||= pool.query(BOT_CART_DDL).catch((e) => { schemaP = null; throw e; }));
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { log("[wabot-cart] db:", e.message); return null; } };

  /* طلبات العميل الأخيرة اللي ليها لقطة سلة موثوقة — الأحدث أولاً (لحد limit). لقطة موثوقة = مربوطة بالطلب نفسه لنفس الرقم
     وإجماليها يساوي إجمالي أصناف الطلب. طلبات التجربة (is_test) والطلبات الصغيرة جداً (أقل من minTotal — زي طلب تجربة بنص ريال)
     بتتخطّى. المتصل بياخد أول واحدة خطتها تنفع على المنيو الحي: «آخر طلب يتجهّز»، مش «آخر طلب وخلاص». */
  async function lastOrderCarts(phone, maxDays, { limit = 5, minTotal = 0 } = {}) {
    if (!/^5\d{8}$/.test(String(phone || ""))) return [];
    const os = await q(`SELECT order_no, option, subtotal, created_at FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false)
                          AND status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')
                          AND created_at > NOW() - make_interval(days => $2::int) AND subtotal >= $4::numeric ORDER BY created_at DESC LIMIT $3`,
      [phone, Math.ceil(maxDays), Math.min(10, Math.max(1, Math.round(limit))), Number(minTotal) || 0]);
    const out = [];
    for (const [i, o] of (os || []).entries()) {
      const c = await q(`SELECT items, cart_raw, subtotal, option FROM shop_carts WHERE phone_norm=$1 AND recovered_order=$2 AND cart_raw IS NOT NULL ORDER BY abs(subtotal - $3::numeric), recovered_at DESC LIMIT 1`, [phone, o.order_no, Number(o.subtotal) || 0]);
      if (!c || !c[0] || !isObj(c[0].cart_raw) || !same(c[0].subtotal, o.subtotal)) continue;
      out.push({ orderNo: o.order_no, option: o.option || c[0].option || null, at: o.created_at, latest: i === 0, raw: c[0].cart_raw, items: Array.isArray(c[0].items) ? c[0].items : [] });
    }
    return out;
  }
  const lastOrderCart = async (phone, maxDays, opts) => (await lastOrderCarts(phone, maxDays, { ...opts, limit: 1 }))[0] || null;
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
    /* موقع المحادثة: بتاع **نفس الرقم صاحب السلة** بس (الربط بـphone_norm جوّه الاستعلام — الرقم مابيطلعش في الإجابة)، ولو اتشارك خلال المدة.
       المتجر بيحطه على الخريطة «غير مؤكد» والعميل يأكده. مفيش أي حاجة منه في أي رابط. المفتاح مابيتبعتش أصلاً لو مفيش موقع صالح. */
    const r = await q(`SELECT c.items, c.cart_raw, c.option, ch.last_loc FROM wa_bot_carts c LEFT JOIN wa_bot_chats ch ON ch.phone_norm = c.phone_norm WHERE c.code=$1 AND c.expires_at > NOW()`, [code]);
    if (!r || !r[0]) return null;
    let hours = 24; try { if (typeof locationHours === "function") hours = Number(await locationHours()) || 24; } catch { hours = 24; }
    const location = chatLocation(r[0].last_loc, now(), hours);
    let raw = isObj(r[0].cart_raw) && Object.keys(r[0].cart_raw).length ? r[0].cart_raw : null;
    if (raw && typeof weightsNow === "function") { try { const by = await weightsNow(); if (by) { const rp = repriceVariants(raw, by); raw = Object.keys(rp.raw).length ? rp.raw : null; } } catch (e) { log("[wa-cart] reprice:", e.message); } }
    return { ok: true, items: Array.isArray(r[0].items) ? r[0].items : [], raw, option: r[0].option || "delivery", subtotal: 0, ordered: false, ...(location ? { location } : {}) };
  }
  /* تشخيص (قراءة بس): من طلبات آخر N يوم، كام طلب له لقطة سلة مربوطة بيه، وكام لقطة إجماليها بيساوي إجمالي أصناف الطلب.
     لو التساوي قليل ⇒ العرض مش هيظهر لمعظم العملاء، ولازم نعرف ليه قبل ما نعتمد عليه. أرقام بس، من غير جوالات. */
  async function coverage(days = 30) {
    const r = await q(`SELECT count(*)::int AS orders, count(c.subtotal)::int AS with_snapshot, count(*) FILTER (WHERE c.has_raw)::int AS with_raw,
                              count(*) FILTER (WHERE c.has_raw AND abs(c.subtotal - o.subtotal) < 0.01)::int AS usable,
                              round(avg(c.subtotal - o.subtotal) FILTER (WHERE c.has_raw)::numeric, 2)::float AS avg_diff,
                              count(*) FILTER (WHERE c.has_raw AND abs(c.subtotal - o.subtotal) >= 0.01)::int AS mismatched
                         FROM shop_orders o
                         LEFT JOIN LATERAL (SELECT subtotal, (cart_raw IS NOT NULL) AS has_raw FROM shop_carts WHERE recovered_order = o.order_no AND phone_norm = o.phone_norm
                                             ORDER BY (cart_raw IS NOT NULL) DESC, abs(subtotal - o.subtotal) LIMIT 1) c ON TRUE
                        WHERE o.created_at > NOW() - make_interval(days => $1::int) AND NOT COALESCE(o.is_test,false)
                          AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')`, [Math.min(365, Math.max(1, Math.ceil(days)))]);
    const made = await q(`SELECT count(*)::int AS links, count(*) FILTER (WHERE opens > 0)::int AS opened FROM wa_bot_carts WHERE created_at > NOW() - make_interval(days => $1::int)`, [Math.min(365, Math.max(1, Math.ceil(days)))]);
    return r && r[0] ? { ...r[0], links: Number(made && made[0]?.links) || 0, opened: Number(made && made[0]?.opened) || 0 } : null;
  }
  return { ensure, lastOrderCart, lastOrderCarts, create, open, restore, coverage };
}
