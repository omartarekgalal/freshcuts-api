/* ═══════════════════════════════════════════════════════════════════════════
   📇 قايمة التواصل اليدوي — واتساب من موبايل المحل (طلب عمر ٢٥/٩)

   ── ليه ده موجود ───────────────────────────────────────────────────────────
   ٣١٪ من الرسايل الدعائية مابتوصلش (تقرير تقنيات: ٥٦٠ من ١٬٨٢٢ في ٣ أيام).
   الأرقام دي حاجبة **قناة الإعلانات** عند المشغّل — وده اختيار محترم،
   ومابنحاولش نلفّ حواليه بإرسال نفس الإعلان من المرسِل الخدمي.

   الطريق النضيف: واتساب. قناة تانية بموافقة منفصلة، والرسالة بتتبعت **يدوي
   من موبايل المحل** لعميل اشترى مننا فعلاً، باسمه وبآخر طلب طلبه. ده تواصل
   شخصي من مطعم لعميله، مش حملة تسويق جماعية.

   ── اللي بنضمنه ────────────────────────────────────────────────────────────
   • **اللي عامل إلغاء اشتراك عندنا مايظهرش هنا خالص.** الاختيار ده صريح
     ومابيتفرّقش حسب القناة.
   • مفيش إرسال من السيرفر. المسار ده بيجهّز نص ورابط `wa.me` وبس —
     الإرسال بيد إنسان، وده اللي بيخلّيه شخصي مش جماعي.
   • الجوال الكامل بيبان بقاعدة الصلاحيات الموجودة (`canSeePhones`)، زي
     أي شاشة عملاء تانية.

   ── الترتيب ────────────────────────────────────────────────────────────────
   الأولوية = اللي يستاهل المجهود اليدوي: صرف أكتر، وغياب أطول، وجرّب
   الموقع قبل كده ولا لأ. مش ترتيب أبجدي ولا عشوائي.
═══════════════════════════════════════════════════════════════════════════ */
import { QUICK_STATS_SQL } from "./customer360.js";

/* شرايح التواصل — كل واحدة بتجاوب على سؤال مختلف */
export const AUDIENCES = {
  /* ٢٥/٩: حاجبين الإعلانات عند المشغّل (smsblock.js). رسالة FreshCut-AD
     مابتوصلهمش أصلاً — فالقناة الوحيدة اللي تكلّمهم بيها عن الموقع هي
     واتساب يدوي من موبايل المحل. */
  ad_blocked: {
    label: "حاجبين رسايل الإعلانات (مابيوصلهمش SMS دعائي)",
    hint: "واتساب هو الطريق الوحيد ليهم — كل رسالة دعائية ليهم كانت بتضيع",
  },
  never_online: {
    label: "اشتروا من المحل وعمرهم ما طلبوا أونلاين",
    hint: "أكبر فرصة: بيعرفوا الأكل وبيحبوه، ناقص بس يجرّبوا الموقع مرة",
  },
  lapsed: { label: "غايبين من أكتر من ٣٠ يوم", hint: "كانوا بيرجعوا ووقفوا" },
  vip_lapsed: { label: "عملاء كبار غايبين", hint: "صرفوا كتير وغابوا — أولوية قصوى" },
  online_once: { label: "طلبوا أونلاين مرة واحدة بس", hint: "التجربة عدّت، محتاجين سبب يرجعوا" },
};

/* نص الرسالة — اسم العميل وآخر طلب. بنكتبها مرة هنا عشان تفضل متسقة،
   والمالك يقدر يعدّلها من الإعدادات (`settings.outreach.template`).
   المتغيرات: {name} {last_items} {last_when} {site} */
export const DEFAULT_TEMPLATE =
  "أهلاً {name} 👋\n" +
  "معاك فريش كاتس. آخر مرة طلبت {last_items} ({last_when}) — عاملين إيه؟\n" +
  "حبينا نقولك إن الطلب من موقعنا بقى أسهل وبيوصلك أسرع: {site}\n" +
  "أي طلب خاص قولنا وإحنا نظبطه 🙏";

const nz = (v) => (v == null ? "" : String(v));

/* «من ٣ أيام» / «من شهر» — أقرب للكلام الطبيعي من تاريخ ميلادي */
export function agoAr(iso, now = Date.now()) {
  const t = Date.parse(nz(iso));
  if (!Number.isFinite(t)) return "";
  const d = Math.floor((now - t) / 86400000);
  if (d <= 0) return "النهاردة";
  if (d === 1) return "امبارح";
  if (d < 7) return `من ${d} أيام`;
  if (d < 14) return "من أسبوع";
  if (d < 31) return `من ${Math.round(d / 7)} أسابيع`;
  if (d < 60) return "من شهر";
  return `من ${Math.round(d / 30)} شهور`;
}

/* أصناف آخر طلب في جملة قصيرة — صنفين وبعدين «و٣ أصناف تانية».
   القايمة الطويلة في رسالة واتساب بتبان زي الإعلان الآلي. */
export function itemsPhrase(names, max = 2) {
  const list = (names || []).map((x) => nz(x).trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length <= max) return list.join(" و");
  const rest = list.length - max;
  return `${list.slice(0, max).join(" و")} و${rest} ${rest === 1 ? "صنف" : "أصناف"} تانية`;
}

export function renderMessage(tpl, vars) {
  return nz(tpl || DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] != null ? String(vars[k]) : ""));
}

/* رابط واتساب. الجوال عندنا محفوظ 5XXXXXXXX، وواتساب عايز 9665XXXXXXXX. */
export function waLink(phoneNorm, text) {
  const d = nz(phoneNorm).replace(/\D/g, "");
  if (!/^5\d{8}$/.test(d)) return null;
  return `https://wa.me/966${d}?text=${encodeURIComponent(nz(text))}`;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  const now = deps.now || (() => Date.now());

  const cfg = async () => {
    let s = {};
    try { s = (await getSettingsData()) || {}; } catch { s = {}; }
    const o = (s.outreach && typeof s.outreach === "object") ? s.outreach : {};
    return {
      template: nz(o.template) || DEFAULT_TEMPLATE,
      site: nz(o.site) || "freshcuts.sa",
      limit: Math.min(300, Math.max(1, Number(o.limit) || 60)),
    };
  };

  /* الاستعلام: العميل + آخر طلب + أصنافه.
     بنقرا من ts_orders (نقطة البيع) و shop_orders (الموقع) — الاتنين،
     لأن العميل ممكن يكون معروف من المحل بس. */
  const SQL = `
    WITH people AS (
      SELECT DISTINCT phone_norm AS pn FROM ts_customers WHERE phone_norm ~ '^5[0-9]{8}$'
      UNION SELECT DISTINCT phone_norm FROM order_sources WHERE phone_norm ~ '^5[0-9]{8}$'
      UNION SELECT DISTINCT phone_norm FROM shop_orders   WHERE phone_norm ~ '^5[0-9]{8}$'
    ),
    -- اللي عامل إلغاء اشتراك: اختيار صريح، بيتشال من القايمة كلها
    opted AS (SELECT phone_norm FROM cms_contacts WHERE opted_out_at IS NOT NULL),
    blk AS (SELECT phone_norm FROM sms_ad_blocked),
    web AS (
      SELECT phone_norm AS pn, count(*)::int n, max(created_at) last_at
        FROM shop_orders
       WHERE phone_norm ~ '^5[0-9]{8}$'
         AND status NOT IN ('pending_payment','payment_failed','expired','cancelled','rejected')
       GROUP BY 1
    ),
    nm AS (
      SELECT pn, (array_agg(name ORDER BY len DESC))[1] AS name FROM (
        SELECT phone_norm pn, btrim(name) name, length(btrim(name)) len FROM ts_customers
         WHERE COALESCE(btrim(name),'') <> ''
        UNION ALL SELECT phone_norm, btrim(customer_name), length(btrim(customer_name)) FROM order_sources
         WHERE COALESCE(btrim(customer_name),'') <> ''
        UNION ALL SELECT phone_norm, btrim(customer->>'name'), length(btrim(customer->>'name')) FROM shop_orders
         WHERE COALESCE(btrim(customer->>'name'),'') <> ''
      ) x WHERE pn ~ '^5[0-9]{8}$' GROUP BY pn
    )
    SELECT p.pn, nm.name, COALESCE(w.n,0) AS web_orders, w.last_at AS web_last_at,
           (p.pn IN (SELECT phone_norm FROM blk)) AS ad_blocked
      FROM people p LEFT JOIN web w ON w.pn = p.pn LEFT JOIN nm ON nm.pn = p.pn
     WHERE p.pn NOT IN (SELECT phone_norm FROM opted)`;

  /* آخر طلبات كل رقم (لحد ٨ من كل مصدر) وأصنافها — من الموقع أو من نقطة البيع.
     ٢٦/٩: مش آخر طلب بس — عشان فلتر «تجاهل الطلبات الأقل من X» يلاقي
     الطلب اللي قبل إزازة المية/البيبسي (عمر: «مش عايز أفكّره بالمياه»). */
  const LAST_SQL = `
    WITH w AS (
      SELECT pn, at, total, names FROM (
        SELECT phone_norm pn, created_at at, total,
               (SELECT string_agg(COALESCE(i->>'name',''), '|') FROM jsonb_array_elements(items) i) names,
               row_number() OVER (PARTITION BY phone_norm ORDER BY created_at DESC) rn
          FROM shop_orders
         WHERE phone_norm = ANY($1::text[])
           AND status NOT IN ('pending_payment','payment_failed','expired','cancelled','rejected')
      ) w0 WHERE rn <= 8
    ), t AS (
      /* أصناف طلبات المحل من ts_order_items — من غيرها الرسالة بتقول
         «طلبت من عندنا» بدل «طلبت كيلو مشاوي»، والفرق كبير في رسالة شخصية.
         أغلب عملائنا طلباتهم من المحل مش من الموقع، فده المصدر الأهم. */
      SELECT pn, at, total,
             (SELECT string_agg(i.name, '|' ORDER BY i.idx)
                FROM ts_order_items i WHERE i.order_id = oid) AS names
        FROM (
          SELECT pn, at, total, oid, row_number() OVER (PARTITION BY pn ORDER BY at DESC) rn FROM (
            SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn,
                   o.order_date at, o.total, o.order_id AS oid
              FROM ts_orders o
              LEFT JOIN order_sources s ON s.order_id = o.order_id
              LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
             WHERE (s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[]))
               AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
          ) z0 WHERE pn IS NOT NULL
        ) z WHERE rn <= 8
    )
    SELECT pn, at, total, names FROM (
      SELECT * FROM w UNION ALL SELECT * FROM t
    ) u ORDER BY pn, at DESC`;

  /* الشريحة كلها بالرسالة الجاهزة لكل عميل — الشاشة اليدوية والإرسال الآلي
     (wasender.js) بيستخدموا نفس الدالة، فالفلاتر والنص واحد. */
  async function audienceRows(aud, { canSee = false, C: Cin = null, minLastOrder = 0 } = {}) {
    const C = Cin || await cfg();
    const base = (await pool.query(SQL)).rows;
    const pns = base.map((x) => x.pn);
    if (!pns.length) return [];

    const stats = new Map((await pool.query(QUICK_STATS_SQL, [pns])).rows.map((x) => [x.pn, x]));
    const hist = new Map();                          // pn → طلباته من الأحدث للأقدم
    for (const r of (await pool.query(LAST_SQL, [pns])).rows) {
      if (!hist.has(r.pn)) hist.set(r.pn, []);
      hist.get(r.pn).push(r);
    }
    const minT = Number(minLastOrder) > 0 ? Number(minLastOrder) : 0;

    const T = now();
    const DAY = 86400000;
    const rows = [];
    for (const b of base) {
      const st = stats.get(b.pn) || {};
      const orders = Number(st.orders) || 0;
      if (!orders) continue;                       // عميل من غير طلب = مش عميل
      const spend = Number(st.spend) || 0;
      const lastAt = st.last_at || b.web_last_at || null;
      const daysAgo = lastAt ? Math.floor((T - Date.parse(lastAt)) / DAY) : 9999;
      const web = Number(b.web_orders) || 0;

      const inAud =
        aud === "ad_blocked" ? b.ad_blocked === true :
        aud === "never_online" ? web === 0 :
        aud === "lapsed" ? daysAgo >= 30 :
        aud === "vip_lapsed" ? (spend >= 300 || orders >= 4) && daysAgo >= 21 :
        aud === "online_once" ? web === 1 : false;
      if (!inAud) continue;

      /* الطلب اللي الرسالة بتفكّر بيه: آخر طلب قيمته ≥ minT. إزازة مية أو
         بيبسي بعد طلب كبير مابيتحسبوش — بنرجع للطلب اللي قبلهم. */
      const H = hist.get(b.pn) || [];
      const meaningful = minT ? H.find((o) => Number(o.total) >= minT) : H[0];
      const L = meaningful || H[0] || {};
      const items = itemsPhrase(nz(L.names).split("|").filter(Boolean));
      const name = nz(b.name).trim();
      const msg = renderMessage(C.template, {
        name: name || "أستاذنا",
        last_items: items || "من عندنا",
        last_when: agoAr(L.at || lastAt, T),
        site: C.site,
      });
      rows.push({
        name: name || null,
        pn: b.pn,
        phone: canSee ? b.pn : `${b.pn.slice(0, 3)}••••${b.pn.slice(-2)}`,
        orders, spend: Math.round(spend), webOrders: web,
        lastAt: lastAt || null, daysAgo: daysAgo === 9999 ? null : daysAgo,
        lastItems: items || null,
        lastTotal: L.total != null ? Math.round(Number(L.total)) : null,
        skippedSmall: minT && meaningful ? H.indexOf(meaningful) : 0,   // كام طلب صغير اتعدّى
        noMeaningfulOrder: Boolean(minT) && !meaningful,
        adBlocked: b.ad_blocked === true,
        message: msg,
        wa: canSee ? waLink(b.pn, msg) : null,
        /* الأولوية: الفلوس × الغياب. اللي صرف كتير وغاب كتير الأول. */
        score: Math.round(spend * Math.min(3, 1 + daysAgo / 60)),
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  app.get("/api/cms/outreach", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const C = await cfg();
    const aud = String(c.req.query("audience") || "never_online");
    if (!AUDIENCES[aud]) return c.json({ ok: false, error: "unknown_audience", audiences: Object.keys(AUDIENCES) }, 400);
    const limit = Math.min(300, Math.max(1, Number(c.req.query("limit")) || C.limit));
    const canSee = typeof ctx.canSeePhones === "function" ? await ctx.canSeePhones(c) : false;

    try {
      const rows = (await audienceRows(aud, { canSee, C })).map(({ pn, ...r }) => r);
      if (!rows.length) return c.json({ ok: true, audience: aud, rows: [] });
      return c.json({
        ok: true, audience: aud, label: AUDIENCES[aud].label, hint: AUDIENCES[aud].hint,
        total: rows.length, canSeePhones: canSee,
        template: C.template, site: C.site,
        audiences: Object.entries(AUDIENCES).map(([id, a]) => ({ id, ...a })),
        rows: rows.slice(0, limit),
      });
    } catch (e) {
      try { log.error(`[outreach] failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
    }
  });

  /* نص الرسالة يتعدّل من اللوحة — من غير نشر */
  app.post("/api/cms/outreach/template", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const tpl = nz(b.template).slice(0, 900);
    if (tpl && !/\{name\}/.test(tpl)) {
      return c.json({ ok: false, error: "name_required",
        message: "الرسالة لازم تحتوي على {name} — من غير الاسم بتبقى رسالة جماعية مش شخصية" }, 422);
    }
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'outreach' THEN data ELSE jsonb_set(data,'{outreach}','{}'::jsonb,true) END,
         '{outreach,template}', $1::jsonb, true) WHERE id=1`,
      [JSON.stringify(tpl || DEFAULT_TEMPLATE)]);
    return c.json({ ok: true, template: tpl || DEFAULT_TEMPLATE });
  });

  return { AUDIENCES, audienceRows, cfg };
}
