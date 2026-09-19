/* ═══════════════════════════════════════════════════════════════════════════
   CONSENT — موافقة العميل على استخدام رقمه في الإعلانات (PDPL)

   ليه الملف ده موجود:
   قرار O6 (١٧/٩) وقّف رفع أي قايمة جوالات (مشفّرة) لميتا/سناب/تيك توك/جوجل
   لحد ما محامي يرد. أغلب الأرقام اللي عندنا جاية من الصالة/نقطة البيع/تطبيقات
   التوصيل — ناس عمرها ما وافقت إن رقمها يروح لمنصة إعلانات. فالموديول ده
   بيبني «السباكة» اللي تخلّي الرفع يرجع بعدين **للي وافق بس**:

     ١) خانة في الشيك أوت (مش متعلّمة افتراضياً) — نص عربي بإصدار ثابت.
     ٢) خانة في بوابة المطعم: الكاشير يسأل العميل ويسجّل «وافق/رفض».
     ٣) جدول واحد mk_consent (آخر حالة لكل رقم) + سجل mk_consent_log لكل تغيير
        (مين، إمتى، من أنهي شاشة، أنهي نص بالظبط).
     ٤) audiences.js بيسأل consentedOnly() — لو المفتاح اتفتح، أي قايمة
        بتترفع بتتفلتر على اللي وافق بس. **المفتاح مقفول** (ads.consentOnly
        في ap_settings = false/مش موجود) — ورفع القوايم نفسه مقفول بـO6
        (syncAudiences=false). يعني الملف ده النهارده مابيبعتش أي حاجة لأي حد.

   مفيش أي رقم بيطلع من هنا لبرّه. الموافقة بتتخزّن عندنا بس.

   ── السؤال القانوني (نصه بالحرف، للمحامي) ─────────────────────────────── */
export const LEGAL_QUESTION_AR = `سؤال للمستشار القانوني — نظام حماية البيانات الشخصية السعودي (PDPL) ولائحته التنفيذية:

مطعم فريش كتس (جدة) عنده أرقام جوالات عملاء من ٣ مصادر:
(أ) نقطة البيع/الصالة والكاشير — العميل بيدي رقمه عشان الطلب أو الفاتورة، ومفيش أي موافقة على التسويق.
(ب) تطبيقات التوصيل (كيتا/هنقرستيشن/جاهز…) — الرقم بيوصلنا من التطبيق مع الطلب.
(ج) المتجر الإلكتروني freshcuts.sa — العميل بيأكد رقمه برمز OTP عشان يطلب ويدفع.

المطلوب: رفع هذه الأرقام بعد تشفيرها (SHA-256، من غير الاسم أو العنوان) إلى ميتا وسناب شات وتيك توك وجوجل،
لغرضين: (١) مطابقة العملاء لعرض إعلانات لهم أو استبعادهم منها (Custom Audiences / Customer Match)،
و(٢) رفع «تحويلات أوفلاين» — أي إن العميل اللي شاف الإعلان اشترى من المطعم (رقم مشفّر + قيمة الطلب + وقته).
الشركات دي بتعالج البيانات خارج المملكة.

الأسئلة:
١) هل رفع رقم الجوال المشفّر (hash) يعتبر «معالجة بيانات شخصية» و«إفصاح/نقل خارج المملكة» حسب النظام، ولا التشفير يخرجه من التعريف؟
٢) هل يجوز رفع أرقام المصدرين (أ) و(ب) — اللي ماوافقوش صراحة — على أساس «المصلحة المشروعة»، ولا لازم موافقة صريحة مسبقة؟
٣) لو لازم موافقة: هل الصيغة دي كافية كخانة اختيارية (مش متعلّمة افتراضياً) في صفحة الدفع، وكسؤال شفهي من الكاشير يتسجّل في النظام مع التاريخ ونص الموافقة؟
   «أوافق على استخدام رقم جوالي بعد تشفيره لعرض عروض فريش كتس لي على منصات التواصل (ميتا، سناب شات، تيك توك، جوجل) ولقياس نتائج الإعلانات. أقدر ألغي موافقتي في أي وقت.»
٤) هل نقل البيانات للمنصات دي محتاج إجراء إضافي (تقييم أثر، ضمانات نقل خارج المملكة، تسجيل في منصة «سدايا»/الجهة المختصة، تحديث سياسة الخصوصية)؟
٥) الأرقام اللي اترفعت قبل كده (قبل ١٧/٩) — هل لازم نطلب من المنصات حذفها؟ (عندنا جماهير عملاء على ميتا/سناب/تيك توك.)
٦) رفع «التحويلات الأوفلاين» (رقم مشفّر + قيمة الطلب) — نفس حكم الجماهير ولا مختلف؟
٧) إلغاء الموافقة: هل يكفي زر إلغاء + إن الكاشير يسجّل الرفض، مع إزالة الرقم من الجماهير في الرفع اللي بعده؟`;

/* النص اللي العميل بيشوفه. الإصدار بيتخزّن مع كل موافقة — تغيير حرف في النص
   = إصدار جديد، عشان نقدر نقول بالظبط العميل وافق على إيه. */
export const CONSENT_TEXTS = {
  "ads-v1": "أوافق على استخدام رقم جوالي بعد تشفيره لعرض عروض فريش كتس لي على منصات التواصل (ميتا، سناب شات، تيك توك، جوجل) ولقياس نتائج الإعلانات. أقدر ألغي موافقتي في أي وقت.",
};
export const CURRENT_VERSION = "ads-v1";
/* سطر الشيك أوت — أقصر، والنص الكامل تحته في «التفاصيل». نفس الإصدار. */
export const CHECKOUT_LABEL = "أبغى توصلني عروض فريش كتس في سناب وإنستجرام وتيك توك (اختياري)";

const SOURCES = new Set(["checkout", "portal", "pos", "staff", "withdraw"]);

let schemaP = null;
function ensureSchema(pool) {
  if (!schemaP) {
    schemaP = pool.query(`
      CREATE TABLE IF NOT EXISTS mk_consent (
        phone_norm TEXT PRIMARY KEY,
        ads_consent BOOLEAN NOT NULL,
        source TEXT,
        text_version TEXT,
        order_no TEXT,
        actor TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mk_consent_log (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        ads_consent BOOLEAN NOT NULL,
        source TEXT,
        text_version TEXT,
        text TEXT,
        order_no TEXT,
        actor TEXT,
        ip TEXT,
        ua TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS mk_consent_log_phone_idx ON mk_consent_log(phone_norm, at DESC);
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS marketing_consent JSONB;
    `).catch((e) => { schemaP = null; throw e; });
  }
  return schemaP;
}

const normPn = (s) => {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0") && d.length === 10) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? d : null;
};

/** اللي المتصفح بعته في body.marketing_consent → { ads, version } أو null.
 *  أي حاجة مش true صريحة = مفيش موافقة. إصدار مش معروف = مفيش موافقة (مانخزّنش
 *  موافقة على نص مانعرفوش). */
export function parseCheckoutConsent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = String(raw.version || raw.v || "").slice(0, 20);
  if (!CONSENT_TEXTS[version]) return null;
  return { ads: raw.ads === true || raw.checked === true, version };
}

/** بيسجّل حالة. بيرجع { ok, changed }. مابيرميش. */
export async function recordConsent(pool, { phone, ads, source, version = CURRENT_VERSION, orderNo = null, actor = null, ip = null, ua = null }) {
  try {
    const pn = normPn(phone);
    if (!pn) return { ok: false, error: "bad_phone" };
    if (!SOURCES.has(source)) return { ok: false, error: "bad_source" };
    if (!CONSENT_TEXTS[version]) return { ok: false, error: "bad_version" };
    await ensureSchema(pool);
    const cur = (await pool.query(`SELECT ads_consent FROM mk_consent WHERE phone_norm=$1`, [pn])).rows[0];
    await pool.query(
      `INSERT INTO mk_consent (phone_norm, ads_consent, source, text_version, order_no, actor, at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (phone_norm) DO UPDATE SET ads_consent=EXCLUDED.ads_consent, source=EXCLUDED.source,
         text_version=EXCLUDED.text_version, order_no=EXCLUDED.order_no, actor=EXCLUDED.actor, at=NOW()`,
      [pn, !!ads, source, version, orderNo, actor ? String(actor).slice(0, 80) : null]);
    await pool.query(
      `INSERT INTO mk_consent_log (phone_norm, ads_consent, source, text_version, text, order_no, actor, ip, ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [pn, !!ads, source, version, CONSENT_TEXTS[version], orderNo, actor ? String(actor).slice(0, 80) : null,
       ip ? String(ip).slice(0, 64) : null, ua ? String(ua).slice(0, 300) : null]);
    return { ok: true, changed: !cur || cur.ads_consent !== !!ads };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** من الشيك أوت: الخانة متعلّمة ⇒ موافقة. **مش متعلّمة ⇒ مابنغيّرش حاجة** —
 *  عميل وافق قبل كده ونسي يعلّمها المرة دي مايتلغيش من غير ما يقصد. الإلغاء
 *  له طريق صريح (/api/consent/withdraw أو الكاشير). بيتسجّل على الطلب نفسه
 *  في الحالتين عشان يبقى فيه دليل على اللي اتعرض. fire-and-forget. */
export async function recordCheckoutConsent(pool, { phoneNorm, orderNo, raw, ip = null, ua = null }) {
  const p = parseCheckoutConsent(raw);
  if (!p) return { ok: false, skipped: "no_consent_payload" };
  try {
    await ensureSchema(pool);
    await pool.query(`UPDATE shop_orders SET marketing_consent=$2 WHERE order_no=$1`,
      [orderNo, JSON.stringify({ ads: p.ads, version: p.version, at: new Date().toISOString() })]);
  } catch { /* العمود مش مهم للطلب */ }
  if (!p.ads) return { ok: true, skipped: "unchecked" };
  return recordConsent(pool, { phone: phoneNorm, ads: true, source: "checkout", version: p.version, orderNo, ip, ua });
}

/** قايمة الأرقام (٩ أرقام) اللي آخر حالة ليها = موافقة. للفلترة في audiences.js. */
export async function consentedSet(pool) {
  await ensureSchema(pool);
  const r = await pool.query(`SELECT phone_norm FROM mk_consent WHERE ads_consent`);
  return new Set(r.rows.map((x) => x.phone_norm));
}

/** المفتاح: ap_settings.data.consentOnly. الافتراضي **مقفول** (false). لو
 *  القراءة فشلت بنرجّع true — يعني «فلتر على الموافقين» (الأضيق = الأأمن). */
export async function consentOnlyFlag(pool) {
  try {
    const r = await pool.query(`SELECT data->>'consentOnly' AS v FROM ap_settings WHERE id=1`);
    return String(r.rows[0]?.v || "").toLowerCase() === "true";
  } catch {
    return true;
  }
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const requirePortal = deps.requirePortal || null;
  ensureSchema(pool).then(() => console.log("[consent] schema ready")).catch((e) => console.error("[consent] schema failed:", e.message));

  const ipOf = (c) => (c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "").split(",")[0].trim() || null;

  /* إعدادات الخانة للمتجر — عام. settings.consent.checkoutBox=false بيخفيها. */
  async function checkoutBoxOn() {
    try { return (await getSettingsData())?.consent?.checkoutBox !== false; } catch { return true; }
  }
  app.get("/api/consent/config", async (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      ok: true, checkout: await checkoutBoxOn(),
      version: CURRENT_VERSION, label: CHECKOUT_LABEL, text: CONSENT_TEXTS[CURRENT_VERSION],
    });
  });

  /* العميل يلغي موافقته بنفسه (بتوكن حسابه بعد الـOTP). */
  app.post("/api/consent/withdraw", async (c) => {
    const h = c.req.header("Authorization") || "";
    const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (!m) return c.json({ ok: false, error: "unauthorized" }, 401);
    const s = await pool.query(`SELECT phone_norm FROM acct_sessions WHERE token=$1`, [m[1]]).catch(() => ({ rows: [] }));
    const pn = s.rows[0]?.phone_norm;
    if (!pn) return c.json({ ok: false, error: "unauthorized" }, 401);
    const r = await recordConsent(pool, { phone: pn, ads: false, source: "withdraw", ip: ipOf(c), ua: c.req.header("user-agent") });
    return c.json({ ok: r.ok });
  });

  /* بوابة المطعم: الكاشير سأل العميل. consent true/false لازم يبقى صريح. */
  if (requirePortal) {
    app.post("/api/portal/ad-consent", async (c) => {
      const a = await requirePortal(c); if (a.res) return a.res;
      const b = await c.req.json().catch(() => ({}));
      if (typeof b?.consent !== "boolean") {
        return c.json({ ok: false, error: "consent_required", message: "اختار: العميل وافق ولا رفض" }, 400);
      }
      const r = await recordConsent(pool, {
        phone: b.phone, ads: b.consent, source: "portal",
        actor: a.user?.name || a.user?.id || "portal", ip: ipOf(c), ua: c.req.header("user-agent"),
      });
      if (!r.ok) return c.json({ ok: false, error: r.error, message: r.error === "bad_phone" ? "رقم الجوال مش صحيح (05xxxxxxxx)" : "مقدرناش نسجّل" }, 400);
      return c.json({ ok: true, changed: r.changed });
    });
  }

  /* للّوحة: الأعداد + حالة المفتاحين + السؤال القانوني بالحرف. من غير أرقام. */
  app.get("/api/consent/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ensureSchema(pool).catch(() => {});
    const counts = (await pool.query(
      `SELECT count(*) FILTER (WHERE ads_consent)::int yes, count(*) FILTER (WHERE NOT ads_consent)::int no,
              count(*) FILTER (WHERE ads_consent AND source='checkout')::int yes_checkout,
              count(*) FILTER (WHERE ads_consent AND source='portal')::int yes_portal
         FROM mk_consent`).catch(() => ({ rows: [{}] }))).rows[0] || {};
    const flags = (await pool.query(
      `SELECT data->>'consentOnly' co, data->>'syncAudiences' sa FROM ap_settings WHERE id=1`).catch(() => ({ rows: [{}] }))).rows[0] || {};
    return c.json({
      ok: true, counts,
      consentOnly: String(flags.co || "").toLowerCase() === "true",
      listsUpload: !(String(flags.sa || "").toLowerCase() === "false"),
      checkoutBox: await checkoutBoxOn(),
      version: CURRENT_VERSION, text: CONSENT_TEXTS[CURRENT_VERSION], checkoutLabel: CHECKOUT_LABEL,
      legalQuestion: LEGAL_QUESTION_AR,
      note: "رفع قوايم الجوال واقف (O6) لحد رد المحامي. الموافقات بتتجمع عندنا بس. لما المحامي يرد: consentOnly=true في إعدادات الطيار، وبعدين syncAudiences=true — كده اللي هيترفع = اللي وافق بس.",
    });
  });

  console.log("[consent] routes ready");
  return { recordConsent: (x) => recordConsent(pool, x), consentedSet: () => consentedSet(pool), consentOnlyFlag: () => consentOnlyFlag(pool) };
}
