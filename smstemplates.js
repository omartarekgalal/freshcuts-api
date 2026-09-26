/* ═══════════════════════════════════════════════════════════════════════════
   📱 قوالب الـSMS — كل رسالة بيبعتها النظام للعميل في مكان واحد (٢٦/٩)

   طلب عمر: «عايز تاب في لوحة التحكم فيه كل حاجة تخص SMS واعداداتها كلها وكل
   الرسايل — مثلاً محتاج اعدل قالب رسالة معينة».

   • CATALOGUE = كل رسالة: بتتبعت إمتى، من أنهي مرسل، المتغيّرات المتاحة،
     والنص الافتراضي (نفس النص اللي كان مكتوب في الكود بالظبط — فمن غير أي
     تعديل مفيش حاجة بتتغيّر).
   • التعديل بيتحفظ في settings.smsTemplates[id]. فاضي/محذوف = الافتراضي.
   • رسايل ليها مكان إعدادات قديم (طلب التقييم، «نبّهني لما تفتحوا») بتتقرا
     وتتكتب في مكانها الأصلي (store) — مصدر واحد لكل إعداد.
   • المتغيّر «إجباري» (required) لو شيلته الرسالة تبوظ (رمز الدخول من غير
     الرمز، رابط التتبع…) ⇒ السيرفر بيرفض الحفظ، والـrender بيرجع للافتراضي
     لو لقى قالب محفوظ ناقص.
   • رسايل الإدارة (للمدير والمالك) مش هنا — ليها شاشة «رسايل الإدارة» بتقفلها
     وتفتحها بالنوع والرقم. نصها إنجليزي ومحسوب على رسالة واحدة (١٦٠ حرف).
═══════════════════════════════════════════════════════════════════════════ */

import { smsParts, optoutLine } from "./smsrules.js";

export const SENDERS = {
  tx: { id: "tx", label: "معاملاتي", env: "TAQNYAT_SENDER", hint: "بيوصل لكل الشبكات — للطلب والرمز والتقييم" },
  ad: { id: "ad", label: "إعلاني", env: "TAQNYAT_SENDER_AD", hint: "بعض الشبكات بتحجبه (٥٨٫٤٪ بس وصلوا) — للتسويق بس" },
};

export const GROUPS = [
  { id: "order", label: "حالة الطلب", hint: "نفس النص بيروح إشعار (Push) كمان لو العميل مشترك" },
  { id: "courier", label: "المندوب" },
  { id: "account", label: "الحساب" },
  { id: "review", label: "التقييم" },
  { id: "marketing", label: "تسويق وسلة متروكة", hint: "سطر «إيقاف» ورابط السلة بيتضافوا تلقائي آخر الرسالة" },
];

const V = {
  order_no: { key: "order_no", label: "رقم الطلب", sample: "W1790012345678" },
  track_url: { key: "track_url", label: "رابط التتبع", sample: "freshcuts.sa/track/W1790012345678" },
  review_url: { key: "review_url", label: "رابط تقييم جوجل", sample: "https://g.page/r/CSG0gPAqlvHMEBM/review" },
  code: { key: "code", label: "الرمز", sample: "4821" },
  minutes: { key: "minutes", label: "مدة الصلاحية بالدقايق", sample: "5" },
  link: { key: "link", label: "الرابط", sample: "freshcuts.sa/r?c=ab12cd" },
};

/* stage = مرحلة notify (لمعرفة هل مفعّلة في smsStages). store = مكان الحفظ لو
   مش settings.smsTemplates. */
export const CATALOGUE = [
  { id: "order.pos_created", group: "order", stage: "pos_created", sender: "tx", label: "استلمنا الطلب واتدفع",
    when: "أول ما الطلب ينزل نقطة البيع بعد الدفع", vars: [V.order_no],
    def: "فريش كاتس: استلمنا طلبك {order_no} وتم الدفع بنجاح ✅" },
  { id: "order.accepted", group: "order", stage: "accepted", sender: "tx", label: "المطعم بدأ التجهيز",
    when: "الكاشير يقبل الطلب", vars: [V.order_no],
    def: "فريش كاتس: المطعم بدأ تجهيز طلبك {order_no} 👨‍🍳" },
  { id: "order.courier_assigned", group: "order", stage: "courier_assigned", sender: "tx", label: "اترتّب مندوب",
    when: "شركة التوصيل تعيّن مندوب", vars: [],
    def: "فريش كاتس: رتّبنا لك مندوب توصيل 🛵" },
  { id: "order.on_the_way", group: "order", stage: "on_the_way", sender: "tx", label: "المندوب في الطريق",
    when: "المندوب يستلم الطلب من المطعم", vars: [V.track_url], required: ["track_url"],
    def: "فريش كاتس: طلبك مع المندوب بالطريق 🛵 {track_url}",
    note: "الافتراضي بيشيل الإيموجي لو الرسالة هتعدّي ٧٠ حرف (رسالة واحدة)" },
  { id: "order.delivered", group: "order", stage: "delivered", sender: "tx", label: "اتوصّل",
    when: "الطلب يتسلّم", vars: [V.review_url],
    def: "فريش كاتس: تم توصيل طلبك — بالهنا والشفا 🌟 عجبك الأكل؟ قيّمنا على جوجل: {review_url}" },
  { id: "order.rejected_refunded", group: "order", stage: "rejected_refunded", sender: "tx", label: "اترفض واسترجعنا الفلوس",
    when: "الطلب يترفض والاسترجاع ينجح — إجبارية طول ما SMS شغّال", vars: [V.order_no], mandatory: true,
    def: "فريش كاتس: نعتذر، تعذّر تنفيذ طلبك {order_no} وتم استرجاع المبلغ كاملاً لبطاقتك 💳" },
  { id: "order.refund_failed", group: "order", stage: "refund_failed", sender: "tx", label: "الاسترجاع اتأخر",
    when: "الاسترجاع الأوتوماتيك يفشل — إجبارية", vars: [V.order_no], mandatory: true,
    def: "فريش كاتس: نعتذر عن طلبك {order_no}. استرجاع المبلغ جارٍ وفريقنا بيتابعه — هنتواصل معك للتأكيد 🙏" },

  { id: "courier.external", group: "courier", stage: "courier_assigned", sender: "tx", label: "مندوب بديل",
    when: "لاجلك يرفض ونبعت مندوب خارجي", vars: [V.order_no],
    def: "فريش كاتس: رتّبنا مندوب بديل لطلبك {order_no} 🛵" },
  { id: "courier.switched", group: "courier", stage: "courier_assigned", sender: "tx", label: "بنغيّر المندوب",
    when: "المندوب اتأخر وبنحوّل لشركة تانية", vars: [V.order_no],
    def: "فريش كاتس: بنرتّب مندوب لطلبك {order_no} - نعتذر عن التأخير" },

  { id: "account.otp", group: "account", sender: "tx", label: "رمز الدخول",
    when: "العميل يطلب رمز دخول في الشيك أوت", vars: [V.code, V.minutes], required: ["code"], always: true,
    def: "رمز الدخول لفريش كاتس: {code}\nصالح {minutes} دقائق.",
    note: "سطر «@freshcuts.sa #الرمز» بيتضاف تلقائي — ده اللي بيخلّي أندرويد يملا الرمز لوحده" },

  { id: "review.invite", group: "review", sender: "tx", label: "طلب التقييم بعد التوصيل",
    when: "بعد التوصيل بالمدة اللي في إعدادات التقييمات", vars: [V.link], required: ["link"],
    store: ["reviews", "askText"], max: 200,
    def: "كيف كان طلبك من فريش كاتس؟ رأيك يهمنا: {link}" },

  { id: "cart.sms1_first", group: "marketing", sender: "ad", label: "سلة متروكة ١ — عميل جديد",
    when: "أول رسالة سلة متروكة لعميل لسه ماطلبش قبل كده", vars: [], tail: "cart",
    def: "فريش كاتس: سلتك محفوظة والتوصيل مجاني لأول طلب، كمّل طلبك بضغطة" },
  { id: "cart.sms1", group: "marketing", sender: "ad", label: "سلة متروكة ١ — عميل قديم",
    when: "أول رسالة سلة متروكة لعميل طلب قبل كده", vars: [], tail: "cart",
    def: "فريش كاتس: سلتك للحين محفوظة، كمّل طلبك بضغطة" },
  { id: "cart.sms2_first", group: "marketing", sender: "ad", label: "سلة متروكة ٢ — عميل جديد",
    when: "التذكير التاني (اليوم اللي بعده) لعميل جديد", vars: [], tail: "cart",
    def: "طلبك من فريش كاتس للحين في السلة، والتوصيل مجاني لأول طلب" },
  { id: "cart.sms2", group: "marketing", sender: "ad", label: "سلة متروكة ٢ — عميل قديم",
    when: "التذكير التاني لعميل قديم", vars: [], tail: "cart",
    def: "طلبك من فريش كاتس للحين في السلة، تقدر تكمّله الحين" },
  { id: "waitlist.open", group: "marketing", sender: "ad", label: "«نبّهني لما تفتحوا»",
    when: "أول ما المطعم يفتح، للي سجّلوا وهو مقفول", vars: [V.link],
    store: ["openWait", "text"], max: 200,
    def: "فريش كاتس فتح! كمّل طلبك: {link}" },
];

const BY_ID = Object.fromEntries(CATALOGUE.map((t) => [t.id, t]));
export const templateMeta = (id) => BY_ID[id] || null;

const getPath = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/* النص المحفوظ (أو null = الافتراضي) */
export function savedText(settings, id) {
  const t = BY_ID[id]; if (!t) return null;
  const v = t.store ? getPath(settings || {}, t.store) : ((settings || {}).smsTemplates || {})[id];
  const s = typeof v === "string" ? v.trim() : "";
  return s && s !== t.def ? s : null;
}

export function missingRequired(id, text) {
  const t = BY_ID[id]; if (!t) return [];
  return (t.required || []).filter((k) => !String(text || "").includes(`{${k}}`));
}
export function unknownVars(id, text) {
  const t = BY_ID[id]; if (!t) return [];
  const ok = new Set((t.vars || []).map((v) => v.key));
  return [...new Set([...String(text || "").matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))].filter((k) => !ok.has(k));
}

export const fill = (text, vars = {}) =>
  String(text).replace(/\{([a-z_]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

/* القالب الفعلي بعد التعويض. لو المحفوظ بايظ (متغيّر إجباري ناقص) ⇒ الافتراضي.
   custom=true معناها المالك عدّلها (عشان الأماكن اللي عندها منطق خاص للافتراضي
   زي on_the_way تعرف تسيبه). */
export function renderTemplate(settings, id, vars = {}) {
  const t = BY_ID[id]; if (!t) return { text: "", custom: false };
  let s = savedText(settings, id);
  if (s && missingRequired(id, s).length) s = null;
  return { text: fill(s || t.def, vars), custom: Boolean(s) };
}

export function sampleVars(id) {
  const t = BY_ID[id] || { vars: [] };
  return Object.fromEntries((t.vars || []).map((v) => [v.key, v.sample]));
}

/* معاينة: النص بعد التعويض بقيم تجريبية + الذيل اللي بيتضاف تلقائي، وعدد الأجزاء */
export function previewOf(id, text) {
  const t = BY_ID[id];
  let body = fill(text, sampleVars(id));
  if (id === "account.otp") body += "\n\n@freshcuts.sa #4821";
  if (t?.tail === "cart") body += ` freshcuts.sa/c/ab12cd34\n${optoutLine({}, { sender: process.env.TAQNYAT_SENDER_AD || "FreshCut-AD" })}`;
  const parts = smsParts(body);
  return { body, chars: [...body].length, parts, unicode: /[^\x00-\x7F]/.test(body) };
}

/* ── الـroutes ───────────────────────────────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const bad = (c, error, status = 400, extra = {}) => c.json({ ok: false, error, ...extra }, status);

  async function usage(days = 30) {
    // عدد اللي اتبعت فعلاً لكل نوع — من سجل الرسايل (smslog.js)
    try {
      const r = await pool.query(
        `SELECT kind, split_part(COALESCE(ref,''), ':', 2) AS sub, count(*)::int AS n,
                COALESCE(sum(parts),0)::int AS parts, max(at) AS last_at
           FROM sms_log WHERE at > NOW() - ($1 || ' days')::interval AND status='sent'
          GROUP BY 1, 2`, [String(days)]);
      return r.rows;
    } catch { return []; }
  }
  function usageFor(rows, t) {
    const pick = (fn) => rows.filter(fn).reduce((a, r) => ({ n: a.n + r.n, parts: a.parts + (r.parts || 0),
      last_at: !a.last_at || (r.last_at && r.last_at > a.last_at) ? r.last_at : a.last_at }), { n: 0, parts: 0, last_at: null });
    if (t.group === "order") return pick((r) => r.kind === "order_status" && r.sub === t.stage);
    if (t.id === "courier.external") return pick((r) => r.kind === "order_status" && r.sub === "courier_external");
    if (t.id === "courier.switched") return pick((r) => r.kind === "order_status" && r.sub === "courier_switched");
    if (t.id === "account.otp") return pick((r) => r.kind === "otp");
    if (t.id === "review.invite") return pick((r) => r.kind === "review_invite");
    if (t.id === "waitlist.open") return pick((r) => r.kind === "waitlist");
    if (t.id.startsWith("cart.")) {
      const step = t.id.startsWith("cart.sms2") ? "2" : "1";
      // الـref = <code>:<step> — مابنعرفش جديد ولا قديم من السجل، فالعدد للخطوة كلها
      return { ...pick((r) => r.kind === "cart_recovery" && r.sub === step), shared: true };
    }
    return { n: 0, parts: 0, last_at: null };
  }

  app.get("/api/cms/sms/templates", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const notif = s.notifications || {};
    const stages = Array.isArray(notif.smsStages) && notif.smsStages.length ? notif.smsStages
      : ["pos_created", "rejected_refunded", "refund_failed"];
    const rows = await usage(30);
    const items = CATALOGUE.map((t) => {
      const saved = savedText(s, t.id);
      const text = saved || t.def;
      let active;
      if (t.group === "order" || t.group === "courier") active = notif.smsEnabled === true && (t.mandatory || stages.includes(t.stage));
      else if (t.id === "account.otp") active = notif.smsEnabled !== false;
      else if (t.id === "review.invite") active = notif.smsEnabled === true && (s.reviews || {}).askAfterDelivery !== false;
      else if (t.id === "waitlist.open") active = notif.smsEnabled === true && (s.openWait || {}).enabled !== false;
      else if (t.tail === "cart") { const ac = s.abandonedCarts || {}; const cc = { enabled: ac.enabled !== false, smsEnabled: ac.smsEnabled === true, sms2Enabled: ac.sms2Enabled !== false }; active = cc.enabled && cc.smsEnabled && (!t.id.startsWith("cart.sms2") || cc.sms2Enabled); }
      return { ...t, text, custom: Boolean(saved), active: Boolean(active), preview: previewOf(t.id, text), usage30: usageFor(rows, t) };
    });
    return c.json({
      ok: true, groups: GROUPS, items,
      senders: Object.values(SENDERS).map((x) => ({ ...x, value: process.env[x.env] || null })),
      configured: Boolean(process.env.TAQNYAT_API_KEY && process.env.TAQNYAT_SENDER),
    });
  });

  app.post("/api/cms/sms/templates/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const t = BY_ID[b.id]; if (!t) return bad(c, "unknown_template", 404);
    const text = String(b.text ?? "");
    return c.json({ ok: true, ...previewOf(t.id, text || t.def),
      missing: missingRequired(t.id, text || t.def), unknown: unknownVars(t.id, text || t.def) });
  });

  /* {id, text} — text فاضي أو null = رجّع الافتراضي */
  app.post("/api/cms/sms/templates", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const t = BY_ID[b.id]; if (!t) return bad(c, "unknown_template", 404);
    let text = b.text == null ? "" : String(b.text).replace(/\r/g, "").trim();
    const max = t.max || 480;
    if ([...text].length > max) return bad(c, "too_long", 422, { max });
    if (text) {
      const miss = missingRequired(t.id, text);
      if (miss.length) return bad(c, "missing_required", 422, { missing: miss,
        message: `الرسالة لازم يكون فيها ${miss.map((k) => `{${k}}`).join(" و ")} — من غيرها الرسالة ماتشتغلش` });
      const unk = unknownVars(t.id, text);
      if (unk.length) return bad(c, "unknown_vars", 422, { unknown: unk,
        message: `متغيّر مش معروف: ${unk.map((k) => `{${k}}`).join("، ")}` });
      if (text === t.def) text = "";
    }
    const path = t.store || ["smsTemplates", t.id];
    // jsonb_set بيحتاج الأب يكون موجود ⇒ نضمن المستوى الأول
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN COALESCE(data,'{}'::jsonb) ? $3 THEN COALESCE(data,'{}'::jsonb)
              ELSE jsonb_set(COALESCE(data,'{}'::jsonb), ARRAY[$3], '{}'::jsonb, true) END,
         $1::text[], $2::jsonb, true) WHERE id=1`,
      [path, JSON.stringify(text || (t.store ? t.def : "")), path[0]]);
    return c.json({ ok: true, id: t.id, text: text || t.def, custom: Boolean(text), preview: previewOf(t.id, text || t.def) });
  });

  /* رسالة تجربة برقم واحد — نفس النص بقيم تجريبية، من نفس المرسل */
  app.post("/api/cms/sms/templates/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json"); }
    const t = BY_ID[b.id]; if (!t) return bad(c, "unknown_template", 404);
    const phone = String(b.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    if (!/^5\d{8}$/.test(phone)) return bad(c, "invalid_phone");
    const s = await getSettingsData();
    const body = previewOf(t.id, savedText(s, t.id) || t.def).body;
    try {
      if (t.sender === "ad" && deps.sendAdSms) await deps.sendAdSms(phone, body, { kind: "test", ref: `tpl:${t.id}` });
      else await deps.sendSms({ phoneNorm: phone, body, kind: "test", ref: `tpl:${t.id}` });
      return c.json({ ok: true, body });
    } catch (e) { return bad(c, "sms_failed", 502, { message: String(e.message || e).slice(0, 160) }); }
  });
}
