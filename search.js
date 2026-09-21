/* ═══════════════════════════════════════════════════════════════════════════
   🔎 البحث الشامل في لوحة التحكم — GET /api/cms/search  (٢١/٩)

   طلب عمر: «محتاج البحث في لوحة التحكم يكون على كل التفاصيل».

   بندوّر في مصدر واحد على:
     • العميل: الاسم (عربي/إنجليزي، أي جزء) والجوال (بأي صيغة: 05…، ‎+9665…،
       9665…، آخر ٤ أرقام، وبالأرقام العربية ٠٥…).
     • طلب الموقع: رقم الطلب (W…)، الكوبون، الملاحظات.
     • طلب نقطة البيع: رقم الطلب ورقم الفاتورة.
     • الأصناف جوّه الطلبات (نقطة البيع والموقع) + الباقات والعروض.
     • العنوان: الحي/الشارع/المبنى/العلامة المميزة.
     • الكوبونات وأكواد العروض، وروابط الحملات، وحملات الرسايل.
     • التقييمات بنصّها، وشحنات المندوب بأرقامها (لاجلك/السهم/يدوي).

   الصلاحيات: كل نوع نتيجة مربوط بقسم من أقسام cms.js العشرة، والاستعلام
   بتاعه مابيتشغّلش أصلاً لو دور المستخدم مالوش «عرض» على القسم ده — فالبحث
   مابيسرّبش حاجة الدور مايشوفهاش. الجوال الكامل بيتحكم فيه نفس قاعدة
   phones.js (قسم «العملاء»).

   السرعة: كل مصدر استعلام صغير بـLIMIT، كلهم بالتوازي، وفيه مهلة قصوى —
   المصدر اللي يتأخر بيتساب والباقي بيرجع. الفهارس بتتعمل مرة في الإقلاع.
═══════════════════════════════════════════════════════════════════════════ */

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** تطبيع عربي: تشكيل، همزات، تاء مربوطة، وأرقام عربية/فارسية → لاتيني. */
export function normalizeAr(s) {
  return String(s || "")
    .replace(/[ً-ْٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[«»""'`]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

/** الأرقام اللي في النص بعد تحويل العربي للاتيني. */
export const digitsOf = (q) => normalizeAr(q).replace(/\D/g, "");

/** تحليل اللي اتكتب: إيه ده؟ (ممكن يطلع أكتر من احتمال مع بعض) */
export function parseQuery(raw) {
  const q = String(raw || "").trim().slice(0, 80);
  const n = normalizeAr(q);
  const compact = n.replace(/[\s()\-‑–]/g, "");
  const dg = compact.replace(/\D/g, "");
  const onlyDigits = dg.length > 0 && /^[+\d]+$/.test(compact);
  const out = { q, norm: n, digits: dg, onlyDigits, kinds: [] };

  if (/^w\d{4,}$/i.test(compact)) { out.kinds.push("web_order"); out.orderNo = compact.toUpperCase(); }
  if (onlyDigits) {
    // جوال كامل بأي صيغة: 05xxxxxxxx | 5xxxxxxxx | 9665xxxxxxxx | 009665xxxxxxxx
    const pn = normPhone(dg);
    if (pn && /^5\d{8}$/.test(pn)) { out.kinds.push("phone"); out.phone = pn; }
    // جزء من رقم (آخر ٤ أرقام مثلاً)
    if (!out.phone && dg.length >= 3) { out.kinds.push("phone_part"); out.phoneTail = dg.replace(/^(00966|966|0)/, ""); }
    /* رقم فاتورة / رقم طلب نقطة بيع. فواتير تاب سينس ١٢ رقم (101000004166)
       والـorder_id ٤ أرقام (4299) — الاتنين لازم يلاقوا. */
    if (dg.length >= 2 && dg.length <= 18) { out.kinds.push("receipt"); out.receipt = dg.replace(/^0+(?=\d)/, ""); }
  }
  if (n.length >= 2 && !onlyDigits) out.kinds.push("text");
  // كود كوبون/عرض: حروف لاتينية وأرقام من غير مسافات
  if (/^[a-z0-9][a-z0-9_-]{1,29}$/i.test(compact)) out.kinds.push("code");
  return out;
}

/** تطبيع الجوال السعودي (نفس قاعدة index.js/identity.js). */
export function normPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) return d.slice(5);
  if (d.startsWith("966")) return d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d.slice(1);
  return d;
}

/* ── الأنواع: كل نوع ← قسم الصلاحية + الشاشة اللي بيفتحها ─────────────── */
export const TYPES = {
  customer: { section: "customers", label: "العملاء", icon: "👤", screen: "customers/profile", order: 1 },
  web_order: { section: "orders", label: "طلبات الموقع", icon: "🧾", screen: "ops/online", order: 2 },
  pos_order: { section: "orders", label: "طلبات نقطة البيع", icon: "🗂", screen: "ops/pos", order: 3 },
  item: { section: "products", label: "الأصناف", icon: "🍔", screen: "menu/catalog", order: 4 },
  offer: { section: "products", label: "العروض والباقات", icon: "🎉", screen: "menu/offers", order: 5 },
  coupon: { section: "discounts", label: "الكوبونات", icon: "🎟", screen: "menu/coupons", order: 6 },
  promo: { section: "growth", label: "أكواد العروض", icon: "🏷", screen: "grow/links", order: 7 },
  campaign: { section: "customers", label: "حملات الرسايل", icon: "✉️", screen: "grow/campaigns", order: 8 },
  link: { section: "growth", label: "روابط الحملات", icon: "🔗", screen: "grow/links", order: 9 },
  review: { section: "customers", label: "التقييمات", icon: "⭐", screen: "grow/reviews", order: 10 },
  shipment: { section: "delivery", label: "شحنات المندوب", icon: "🛵", screen: "ops/online", order: 11 },
  address: { section: "orders", label: "العناوين", icon: "📍", screen: "ops/online", order: 12 },
};

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** درجة التطابق: تطابق تام > بداية > جزء. (صافية — متجرّبة أوفلاين) */
export function scoreOf(hay, needle, base = 0) {
  const h = normalizeAr(hay), n = normalizeAr(needle);
  if (!h || !n) return base;
  if (h === n) return base + 100;
  if (h.startsWith(n)) return base + 70;
  if (h.split(/[\s\-_/]+/).some((w) => w.startsWith(n))) return base + 55;
  if (h.includes(n)) return base + 35;
  return base;
}

/** بيلمّ النتايج في مجموعات مرتّبة: الأعلى تطابقاً الأول. */
export function groupResults(items, limitPerGroup = 6) {
  const by = new Map();
  for (const it of items) {
    const a = by.get(it.type) || [];
    a.push(it); by.set(it.type, a);
  }
  const groups = [];
  for (const [type, rows] of by) {
    const t = TYPES[type] || { label: type, icon: "•", order: 99 };
    rows.sort((a, b) => b.score - a.score || String(b.at || "").localeCompare(String(a.at || "")));
    groups.push({
      type, label: t.label, icon: t.icon, section: t.section,
      top: rows[0].score, order: t.order,
      total: rows.length, items: rows.slice(0, limitPerGroup),
    });
  }
  groups.sort((a, b) => b.top - a.top || a.order - b.order);
  return groups;
}

const hash = (key, params) => {
  const qs = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `#store/${key}${qs ? "?" + qs : ""}`;
};

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((res) => setTimeout(() => res(fallback), ms))]);

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const cms = deps.cms || (() => null);
  const c360 = deps.c360 || (() => null);

  /* فهارس البحث — مرة واحدة في الإقلاع، وكل واحد لوحده عشان فشل واحد
     مايوقّفش الباقي (pg_trgm ممكن ماتكونش متاحة على قاعدة تانية). */
  const ready = (async () => {
    const one = (sql) => pool.query(sql).catch((e) => console.error("[search] idx:", e.message.slice(0, 120)));
    await one("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    for (const sql of [
      "CREATE INDEX IF NOT EXISTS ts_customers_phone_idx ON ts_customers(phone_norm)",
      "CREATE INDEX IF NOT EXISTS ts_orders_receipt_idx ON ts_orders(receipt)",
      "CREATE INDEX IF NOT EXISTS shop_orders_coupon_idx ON shop_orders(upper(coupon))",
      "CREATE INDEX IF NOT EXISTS ts_customers_name_trgm ON ts_customers USING gin (name gin_trgm_ops)",
      "CREATE INDEX IF NOT EXISTS acct_customers_name_trgm ON acct_customers USING gin (name gin_trgm_ops)",
      "CREATE INDEX IF NOT EXISTS order_sources_name_trgm ON order_sources USING gin (customer_name gin_trgm_ops)",
      "CREATE INDEX IF NOT EXISTS ts_order_items_name_trgm ON ts_order_items USING gin (name gin_trgm_ops)",
      "CREATE INDEX IF NOT EXISTS reviews_comment_trgm ON reviews USING gin (comment gin_trgm_ops)",
      "CREATE INDEX IF NOT EXISTS cms_links_slug_trgm ON cms_links USING gin (slug gin_trgm_ops)",
    ]) await one(sql);
  })().then(() => console.log("[search] indexes ready")).catch((e) => console.error("[search] init:", e.message));

  const Q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows).catch((e) => {
    console.error("[search] q:", e.message.slice(0, 140)); return [];
  });

  /* ═══ مين بيشوف إيه ═══════════════════════════════════════════════════ */
  async function permsOf(c) {
    const api = cms();
    if (!api) return { role: "owner", perms: null, all: true };
    const u = await api.whoami(c).catch(() => null);
    if (!u || u.role === "owner") return { role: "owner", perms: null, all: true };
    const perms = await api.effectivePerms().catch(() => null);
    return { role: u.role, perms: perms?.[u.role] || null, all: false };
  }
  const canView = (p, section) => p.all || ((p.perms?.[section] || "none") !== "none");

  /* ═══ 🔎 البحث ════════════════════════════════════════════════════════ */
  app.get("/api/cms/search", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const started = Date.now();
    const parsed = parseQuery(c.req.query("q"));
    const limit = Math.min(10, Math.max(3, Number(c.req.query("limit")) || 6));
    if (parsed.norm.length < 2) return c.json({ ok: true, q: parsed.q, groups: [], took: 0 });

    const p = await permsOf(c);
    const fullPhones = canView(p, "customers") && (await (ctx.canSeePhones ? ctx.canSeePhones(c) : true));
    const may = (type) => canView(p, TYPES[type].section);

    const tasks = [];
    const push = (type, fn) => { if (may(type)) tasks.push(fn().catch(() => [])); };

    push("customer", () => findCustomers(parsed, fullPhones));
    push("web_order", () => findWebOrders(parsed));
    push("pos_order", () => findPosOrders(parsed));
    push("item", () => findItems(parsed));
    push("offer", () => findOffers(parsed));
    push("coupon", () => findCoupons(parsed));
    push("promo", () => findPromos(parsed));
    push("campaign", () => findCampaigns(parsed));
    push("link", () => findLinks(parsed));
    push("review", () => findReviews(parsed, fullPhones));
    push("shipment", () => findShipments(parsed));
    push("address", () => findAddresses(parsed));

    const settled = await withTimeout(Promise.all(tasks), 3500, []);
    const items = settled.flat().filter(Boolean);
    const groups = groupResults(items, limit);
    return c.json({
      ok: true, q: parsed.q, kinds: parsed.kinds, fullPhones,
      groups, count: items.length, took: Date.now() - started,
    });
  });

  /* ── 👤 العملاء: الاسم أو الجوال ─────────────────────────────────────── */
  const PEOPLE = `
    people AS (
      SELECT phone_norm AS pn, name, 'tabsense' AS src FROM ts_customers WHERE COALESCE(phone_norm,'') <> ''
      UNION ALL SELECT phone_norm, name, 'account' FROM acct_customers WHERE COALESCE(phone_norm,'') <> ''
      UNION ALL SELECT phone_norm, customer->>'name', 'web' FROM shop_orders WHERE COALESCE(phone_norm,'') <> ''
      UNION ALL SELECT phone_norm, customer_name, 'cashier' FROM order_sources WHERE COALESCE(phone_norm,'') <> ''
      UNION ALL SELECT phone_norm, name, 'review' FROM reviews WHERE COALESCE(phone_norm,'') <> ''
    )`;

  async function findCustomers(parsed, fullPhones) {
    const api = c360();
    const hits = new Map(); // pn → {how, score}
    const add = (pn, how, score) => {
      if (!pn) return;
      const cur = hits.get(pn);
      if (!cur || cur.score < score) hits.set(pn, { how, score });
    };
    if (parsed.phone) add(parsed.phone, "phone", 100);
    if (parsed.phoneTail) {
      for (const r of await Q(`WITH ${PEOPLE} SELECT DISTINCT pn FROM people WHERE pn LIKE '%' || $1 LIMIT 15`, [parsed.phoneTail])) {
        add(r.pn, "phone", 72);
      }
      for (const r of await Q(`WITH ${PEOPLE} SELECT DISTINCT pn FROM people WHERE pn LIKE '%' || $1 || '%' LIMIT 15`, [parsed.phoneTail])) {
        add(r.pn, "phone", 50);
      }
    }
    if (parsed.kinds.includes("text")) {
      const words = parsed.norm.split(" ").filter(Boolean).slice(0, 4);
      const conds = words.map((_, i) => `name ILIKE '%' || $${i + 1} || '%'`).join(" AND ");
      for (const r of await Q(
        `WITH ${PEOPLE} SELECT pn, max(name) AS name, count(*)::int AS n FROM people
          WHERE ${conds} GROUP BY pn ORDER BY n DESC LIMIT 25`, words)) {
        add(r.pn, "name", scoreOf(r.name, parsed.norm, 0) || 30);
      }
    }
    // رقم طلب موقع → صاحبه
    if (parsed.orderNo) {
      for (const r of await Q("SELECT phone_norm FROM shop_orders WHERE order_no=$1", [parsed.orderNo])) add(r.phone_norm, "order", 90);
    }
    if (parsed.receipt) {
      for (const r of await Q(
        `SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id=o.order_id LEFT JOIN ts_customers tc ON tc.customer_id=o.customer_id
          WHERE o.order_id=$1 OR o.receipt=$1 LIMIT 5`, [parsed.receipt])) add(r.pn, "pos_order", 85);
    }
    const pns = [...hits.keys()].filter(Boolean).slice(0, 30);
    if (!pns.length || !api) return [];
    await api.remember(pns).catch(() => {});
    const [stats, names] = await Promise.all([
      api.quickStats(pns).catch(() => new Map()),
      Q(`WITH ${PEOPLE}
         SELECT pn, array_agg(DISTINCT btrim(name)) FILTER (WHERE COALESCE(btrim(name),'') <> '') AS names
           FROM people WHERE pn = ANY($1::text[]) GROUP BY pn`, [pns]),
    ]);
    const nameBy = new Map(names.map((x) => [x.pn, (x.names || [])[0] || null]));
    const MATCHED = { phone: "الجوال", name: "الاسم", order: "رقم طلب الموقع", pos_order: "رقم فاتورة نقطة البيع" };
    return pns.map((pn) => {
      const h = hits.get(pn), st = stats.get(pn) || {};
      const nm = nameBy.get(pn);
      return {
        type: "customer", id: pn, score: h.score + Math.min(20, (st.orders || 0)),
        title: nm || "عميل بدون اسم",
        phone: fullPhones ? "0" + pn : null,
        phoneMasked: `05${"•".repeat(5)}${String(pn).slice(-2)}`,
        subtitle: `${st.orders || 0} طلب · ${r2(st.spend)} ر.س`,
        badge: MATCHED[h.how] || h.how, at: st.last_at || null,
        href: hash("customers/profile", { ref: api.refOf(pn) }), screen: "customers/profile",
      };
    });
  }

  /* ── 🧾 طلبات الموقع: رقم الطلب، الكوبون، الملاحظات، الأصناف ────────── */
  async function findWebOrders(parsed) {
    const out = [];
    const rowOf = (o, score, badge) => ({
      type: "web_order", id: o.order_no, score,
      title: `طلب ${o.order_no}`,
      subtitle: `${o.status || ""} · ${r2(o.total)} ر.س${o.name ? ` · ${o.name}` : ""}`,
      badge, at: o.created_at,
      href: hash("ops/online", { order: o.order_no }), screen: "ops/online",
    });
    const base = `SELECT order_no, status, total, created_at, coupon, notes, customer->>'name' AS name FROM shop_orders`;
    if (parsed.orderNo) {
      for (const o of await Q(`${base} WHERE order_no = $1`, [parsed.orderNo])) out.push(rowOf(o, 120, "رقم الطلب"));
    }
    if (parsed.onlyDigits && parsed.digits.length >= 3) {
      for (const o of await Q(`${base} WHERE order_no ILIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT 6`, [parsed.digits])) {
        if (!out.some((x) => x.id === o.order_no)) out.push(rowOf(o, 60, "رقم الطلب"));
      }
    }
    if (parsed.phone) {
      for (const o of await Q(`${base} WHERE phone_norm = $1 ORDER BY created_at DESC LIMIT 6`, [parsed.phone])) {
        if (!out.some((x) => x.id === o.order_no)) out.push(rowOf(o, 80, "جوال العميل"));
      }
    }
    if (parsed.kinds.includes("code")) {
      for (const o of await Q(`${base} WHERE upper(coupon) = upper($1) ORDER BY created_at DESC LIMIT 6`, [parsed.norm])) {
        if (!out.some((x) => x.id === o.order_no)) out.push(rowOf(o, 65, `كوبون ${o.coupon}`));
      }
    }
    if (parsed.kinds.includes("text")) {
      for (const o of await Q(
        `${base} WHERE notes ILIKE '%' || $1 || '%' OR items::text ILIKE '%' || $1 || '%'
          ORDER BY created_at DESC LIMIT 6`, [parsed.q])) {
        if (!out.some((x) => x.id === o.order_no)) out.push(rowOf(o, 40, "صنف أو ملاحظة في الطلب"));
      }
    }
    return out;
  }

  /* ── 🗂 طلبات نقطة البيع: رقم الطلب/الفاتورة + الأصناف ───────────────── */
  async function findPosOrders(parsed) {
    const out = [];
    const rowOf = (o, score, badge) => ({
      type: "pos_order", id: String(o.order_id), score,
      title: `فاتورة ${o.receipt || o.order_id}`,
      subtitle: `${o.order_type || ""} · ${r2(o.total)} ر.س${o.customer_name ? ` · ${o.customer_name}` : ""}`,
      badge, at: o.order_date,
      href: hash("ops/pos", { q: String(o.receipt || o.order_id) }), screen: "ops/pos",
    });
    const base = `SELECT o.order_id, o.receipt, o.order_date, o.order_type, o.total, s.customer_name
                    FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id`;
    if (parsed.receipt) {
      for (const o of await Q(`${base} WHERE o.receipt = $1 OR o.order_id = $1 ORDER BY o.order_date DESC LIMIT 6`, [parsed.receipt])) {
        out.push(rowOf(o, 110, "رقم الفاتورة"));
      }
      if (!out.length) {
        for (const o of await Q(`${base} WHERE o.receipt LIKE '%' || $1 ORDER BY o.order_date DESC LIMIT 5`, [parsed.receipt])) {
          out.push(rowOf(o, 55, "رقم الفاتورة"));
        }
      }
    }
    if (parsed.phone) {
      for (const o of await Q(
        `${base} LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE s.phone_norm = $1 OR tc.phone_norm = $1 ORDER BY o.order_date DESC LIMIT 6`, [parsed.phone])) {
        if (!out.some((x) => x.id === String(o.order_id))) out.push(rowOf(o, 78, "جوال العميل"));
      }
    }
    if (parsed.kinds.includes("text")) {
      for (const o of await Q(
        `${base} WHERE EXISTS (SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id AND i.name ILIKE '%' || $1 || '%')
          ORDER BY o.order_date DESC LIMIT 6`, [parsed.q])) {
        if (!out.some((x) => x.id === String(o.order_id))) out.push(rowOf(o, 38, "صنف جوّه الطلب"));
      }
    }
    return out;
  }

  /* ── 🍔 الأصناف نفسها (من الطلبات) ───────────────────────────────────── */
  async function findItems(parsed) {
    if (!parsed.kinds.includes("text")) return [];
    const rows = await Q(
      `SELECT i.name, count(*)::int AS n, max(o.order_date) AS last_at
         FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
        WHERE i.name ILIKE '%' || $1 || '%' GROUP BY i.name ORDER BY n DESC LIMIT 8`, [parsed.q]);
    return rows.map((r) => ({
      type: "item", id: r.name, score: scoreOf(r.name, parsed.norm, 0) || 30,
      title: r.name, subtitle: `${r.n} مرة في الطلبات`, badge: "صنف",
      at: r.last_at, href: hash("menu/catalog", { focus: r.name }), screen: "menu/catalog",
    }));
  }

  /* ── 🎉 العروض والباقات ──────────────────────────────────────────────── */
  async function findOffers(parsed) {
    if (!parsed.kinds.includes("text") && !parsed.kinds.includes("code")) return [];
    const term = parsed.q;
    const [offers, bundles] = await Promise.all([
      Q(`SELECT id, title, description, enabled FROM offer_registry
          WHERE id ILIKE '%'||$1||'%' OR title ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' LIMIT 6`, [term]),
      Q(`SELECT id, slug, name, description, active FROM cms_bundles
          WHERE slug ILIKE '%'||$1||'%' OR name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' LIMIT 6`, [term]),
    ]);
    return [
      ...offers.map((o) => ({
        type: "offer", id: o.id, score: scoreOf(`${o.title} ${o.id}`, parsed.norm, 0) || 30,
        title: o.title || o.id, subtitle: o.enabled ? "عرض شغّال" : "عرض متوقف", badge: "عرض",
        href: hash("menu/offers", { focus: o.title || o.id }), screen: "menu/offers",
      })),
      ...bundles.map((b) => ({
        type: "offer", id: b.slug, score: scoreOf(`${b.name} ${b.slug}`, parsed.norm, 0) || 30,
        title: b.name || b.slug, subtitle: b.active ? "باقة شغّالة" : "باقة متوقفة", badge: "باقة",
        href: hash("menu/offers", { focus: b.name || b.slug }), screen: "menu/offers",
      })),
    ];
  }

  /* ── 🎟 الكوبونات ────────────────────────────────────────────────────── */
  async function findCoupons(parsed) {
    if (!parsed.kinds.includes("text") && !parsed.kinds.includes("code")) return [];
    const rows = await Q(
      `SELECT code, percent, active, used_count, max_uses, expires_at, note, free_delivery FROM shop_coupons
        WHERE code ILIKE '%'||$1||'%' OR note ILIKE '%'||$1||'%' LIMIT 8`, [parsed.q]);
    return rows.map((r) => ({
      type: "coupon", id: r.code, score: scoreOf(r.code, parsed.norm, 0) || scoreOf(r.note || "", parsed.norm, 0) || 30,
      title: r.code,
      subtitle: `${Number(r.percent) > 0 ? `−${r.percent}٪ ` : ""}${r.free_delivery ? "توصيل مجاني " : ""}· استُخدم ${r.used_count || 0}${r.active ? "" : " · متوقف"}`,
      badge: "كوبون", href: hash("menu/coupons", { focus: r.code }), screen: "menu/coupons",
    }));
  }

  /* ── 🏷 أكواد العروض (promo_codes) ───────────────────────────────────── */
  async function findPromos(parsed) {
    if (!parsed.kinds.includes("text") && !parsed.kinds.includes("code")) return [];
    const rows = await Q(
      `SELECT id, code, label, discount_text, active, utm_campaign FROM promo_codes
        WHERE code ILIKE '%'||$1||'%' OR label ILIKE '%'||$1||'%' OR utm_campaign ILIKE '%'||$1||'%' LIMIT 6`, [parsed.q]);
    return rows.map((r) => ({
      type: "promo", id: r.id, score: scoreOf(`${r.code} ${r.label || ""}`, parsed.norm, 0) || 28,
      title: r.code, subtitle: `${r.label || ""}${r.discount_text ? ` · ${r.discount_text}` : ""}${r.active ? "" : " · متوقف"}`,
      badge: "كود عرض", href: hash("grow/links", { q: r.code }), screen: "grow/links",
    }));
  }

  /* ── ✉️ حملات الرسايل ────────────────────────────────────────────────── */
  async function findCampaigns(parsed) {
    if (!parsed.kinds.includes("text") && !parsed.kinds.includes("code") && !parsed.onlyDigits) return [];
    const rows = await Q(
      `SELECT id, name, channel, status, segment, sent, audience, coupon, sent_at, created_at FROM cms_campaigns
        WHERE name ILIKE '%'||$1||'%' OR message ILIKE '%'||$1||'%' OR coupon ILIKE '%'||$1||'%' OR segment ILIKE '%'||$1||'%'
        ORDER BY id DESC LIMIT 8`, [parsed.q]);
    return rows.map((r) => ({
      type: "campaign", id: r.id, score: scoreOf(r.name || "", parsed.norm, 0) || 30,
      title: r.name || `حملة ${r.id}`,
      subtitle: `${r.channel || ""} · ${r.status || ""}${r.sent ? ` · اتبعت ${r.sent}` : ""}`,
      badge: "حملة", at: r.sent_at || r.created_at,
      href: hash("grow/campaigns", { focus: r.name || String(r.id) }), screen: "grow/campaigns",
    }));
  }

  /* ── 🔗 روابط الحملات ────────────────────────────────────────────────── */
  async function findLinks(parsed) {
    if (!parsed.kinds.includes("text") && !parsed.kinds.includes("code")) return [];
    const term = parsed.norm.replace(/^.*\/l\//, "");
    const rows = await Q(
      `SELECT slug, label, coupon, utm_source, utm_campaign, clicks, active FROM cms_links
        WHERE slug ILIKE '%'||$1||'%' OR label ILIKE '%'||$1||'%' OR coupon ILIKE '%'||$1||'%' OR utm_campaign ILIKE '%'||$1||'%'
        ORDER BY clicks DESC NULLS LAST LIMIT 8`, [term]);
    return rows.map((r) => ({
      type: "link", id: r.slug, score: scoreOf(r.slug, term, 0) || scoreOf(r.label || "", term, 0) || 28,
      title: `/l/${r.slug}`, ltr: true,
      subtitle: `${r.label || "رابط حملة"}${r.coupon ? ` · ${r.coupon}` : ""} · ${r.clicks || 0} ضغطة`,
      badge: r.active ? "رابط" : "متوقف", href: hash("grow/links", { q: r.slug }), screen: "grow/links",
    }));
  }

  /* ── ⭐ التقييمات بنصّها ─────────────────────────────────────────────── */
  async function findReviews(parsed, fullPhones) {
    const out = [];
    const rowOf = (r, score, badge) => ({
      type: "review", id: r.id, score,
      title: `${"★".repeat(Math.max(1, Math.min(5, r.rating || 0)))} ${r.name || "بدون اسم"}`,
      subtitle: String(r.comment || r.code_label || "").slice(0, 90),
      phone: fullPhones && r.phone_norm ? "0" + r.phone_norm : null,
      badge, at: r.created_at,
      href: hash("grow/reviews", { focus: String(r.comment || r.name || r.order_no || "").slice(0, 40) }), screen: "grow/reviews",
    });
    const base = `SELECT id, rating, comment, name, phone_norm, order_no, code_label, created_at FROM reviews WHERE hidden_at IS NULL AND NOT COALESCE(is_test,false)`;
    if (parsed.kinds.includes("text")) {
      for (const r of await Q(`${base} AND (comment ILIKE '%'||$1||'%' OR name ILIKE '%'||$1||'%' OR resolution_note ILIKE '%'||$1||'%')
                                ORDER BY created_at DESC LIMIT 8`, [parsed.q])) out.push(rowOf(r, scoreOf(r.comment || "", parsed.norm, 0) || 30, "نص التقييم"));
    }
    if (parsed.phone) {
      for (const r of await Q(`${base} AND phone_norm = $1 ORDER BY created_at DESC LIMIT 5`, [parsed.phone])) {
        if (!out.some((x) => x.id === r.id)) out.push(rowOf(r, 70, "جوال العميل"));
      }
    }
    if (parsed.orderNo) {
      for (const r of await Q(`${base} AND order_no = $1 LIMIT 5`, [parsed.orderNo])) {
        if (!out.some((x) => x.id === r.id)) out.push(rowOf(r, 80, "رقم الطلب"));
      }
    }
    return out;
  }

  /* ── 🛵 شحنات المندوب ────────────────────────────────────────────────── */
  async function findShipments(parsed) {
    if (!parsed.digits && !parsed.kinds.includes("text") && !parsed.kinds.includes("code")) return [];
    const term = parsed.q.trim();
    const rows = await Q(
      `SELECT id, shop_order_no, provider, provider_ref, provider_order_no, fa_order_id, fa_order_number,
              status, driver->>'name' AS driver, created_at, cost
         FROM dl_shipments
        WHERE shop_order_no ILIKE '%'||$1||'%' OR provider_ref ILIKE '%'||$1||'%' OR provider_order_no ILIKE '%'||$1||'%'
           OR fa_order_id ILIKE '%'||$1||'%' OR fa_order_number ILIKE '%'||$1||'%' OR driver->>'name' ILIKE '%'||$1||'%'
        ORDER BY id DESC LIMIT 8`, [term]);
    return rows.map((r) => {
      const ref = r.provider_order_no || r.provider_ref || r.fa_order_number || r.fa_order_id || String(r.id);
      return {
        type: "shipment", id: r.id,
        score: scoreOf(ref, parsed.norm, 0) || scoreOf(r.shop_order_no || "", parsed.norm, 0) || 30,
        title: `شحنة ${ref}`,
        subtitle: `${r.provider || ""} · ${r.status || ""} · طلب ${r.shop_order_no || "—"}${r.driver ? ` · ${r.driver}` : ""}`,
        badge: "شحنة", at: r.created_at,
        href: hash("ops/online", { order: r.shop_order_no || "" }), screen: "ops/online",
      };
    });
  }

  /* ── 📍 العناوين (حي/شارع/مبنى/علامة) ────────────────────────────────── */
  async function findAddresses(parsed) {
    if (!parsed.kinds.includes("text")) return [];
    const rows = await Q(
      `SELECT order_no, created_at, total, status,
              COALESCE(address->>'area','') AS area, COALESCE(address->>'city','') AS city,
              COALESCE(address->>'street','') AS street, COALESCE(address->>'building','') AS building,
              COALESCE(address->>'landmark','') AS landmark, customer->>'name' AS name
         FROM shop_orders
        WHERE address->>'area' ILIKE '%'||$1||'%' OR address->>'city' ILIKE '%'||$1||'%'
           OR address->>'street' ILIKE '%'||$1||'%' OR address->>'building' ILIKE '%'||$1||'%'
           OR address->>'apartment' = $1 OR address->>'landmark' ILIKE '%'||$1||'%'
           OR address->>'delivery_notes' ILIKE '%'||$1||'%'
        ORDER BY created_at DESC LIMIT 8`, [parsed.q]);
    return rows.map((r) => ({
      type: "address", id: r.order_no, score: scoreOf(r.area || r.street || "", parsed.norm, 0) || 30,
      title: [r.area, r.street, r.building && `مبنى ${r.building}`].filter(Boolean).join(" · ") || r.landmark || r.city,
      subtitle: `طلب ${r.order_no}${r.name ? ` · ${r.name}` : ""} · ${r2(r.total)} ر.س`,
      badge: "عنوان", at: r.created_at,
      href: hash("ops/online", { order: r.order_no }), screen: "ops/online",
    }));
  }

  console.log("[search] routes registered");
  return { ready, parseQuery, TYPES };
}
