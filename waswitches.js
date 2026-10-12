/* ═══════════════════════════════════════════════════════════════════════════
   🔀 waswitches.js — SW1 (١٣/١٠): مفاتيح واتساب المستقلة (M6 من مراجعة الخبير). دوال صافية بس.

   قبل SW1: مفتاح واحد (notifications.whatsappEnabled) كان لازم للرد الحر (البوت والموظف) **و** كان بيشغّل كل مراحل
   تحديثات الطلب مرة واحدة. دلوقتي:
     • الرد الحر جوّه نافذة الـ٢٤ ساعة (بوت + موظف) = مفتاح الخادم + الإعداد + مفتاح المالك. بس.
     • تحديثات الطلب (قوالب) = نفس التلاتة + notifications.whatsappEnabled + **المرحلة نفسها متعلّم عليها**
       في notifications.whatsappStages (الافتراضي [] ⇒ ولا قالب تحديث بيطلع لحد ما المالك يختار مرحلة).
     • «يغني عن الـSMS» بقى لكل مرحلة: notifications.whatsappReplacesSmsStages. لو مش مكتوبة، المفتاح القديم
       whatsappReplacesSms بيتطبّق على كل المراحل زي الأول.
═══════════════════════════════════════════════════════════════════════════ */

const STAGE_RE = /^[a-z_]{2,40}$/;
const uniq = (l) => [...new Set((Array.isArray(l) ? l : []).map((x) => String(x || "").trim()).filter((x) => STAGE_RE.test(x)))];

/* المراحل اللي المالك شغّلها (settings.notifications.whatsappStages). الافتراضي: ولا مرحلة. */
export const waStagesOf = (notifications) => uniq(notifications && notifications.whatsappStages);
export const waStageOn = (notifications, stage) => waStagesOf(notifications).includes(String(stage));
/* واتساب «يغني عن الـSMS» للمرحلة دي؟ القايمة الجديدة لو مكتوبة، وإلا المفتاح القديم على الكل. */
export function waReplacesSms(notifications, stage) {
  const n = notifications || {};
  if (Array.isArray(n.whatsappReplacesSmsStages)) return uniq(n.whatsappReplacesSmsStages).includes(String(stage));
  return n.whatsappReplacesSms === true;
}

/* مراحل الـSMS بتاعها إجباري (نفس قايمة notify.js MANDATORY_SMS_STAGES — الاختبار بيتأكد إنهم متطابقين) */
export const MANDATORY_SMS_STAGES = Object.freeze(["rejected_refunded", "refund_failed"]);

/* اسم كل مرحلة للمالك */
export const STAGE_LABELS = Object.freeze({
  pos_created: "استلمنا الطلب (بعد الدفع)", accepted: "الطلب دخل المطبخ", on_the_way: "المندوب في الطريق", pickup_ready: "جاهز للاستلام",
  delivered: "الطلب اتوصّل", rejected_refunded: "الطلب اترفض والمبلغ رجع", refund_failed: "الاسترجاع تحت المراجعة",
});

/* حالة قالب المرحلة عند ميتا (النسخة العربي). metaOk=false ⇒ مانعرفش (null). */
function metaOf(template, metaList, metaOk) {
  if (!metaOk) return { status: null, category: null };
  const rows = (metaList || []).filter((t) => t.name === template);
  const row = rows.find((t) => String(t.language || "").slice(0, 2) === "ar") || rows[0] || null;
  return row ? { status: String(row.status || "").toUpperCase() || null, category: String(row.category || "").toUpperCase() || null } : { status: "NOT_SUBMITTED", category: null };
}
/* ليه المرحلة دي ماينفعش تتشغّل على واتساب دلوقتي؟ (null = تنفع) */
function blockOf(meta) {
  if (meta.status === null) return "meta_unreadable";
  if (meta.status !== "APPROVED") return "template_not_approved";
  if (meta.category && meta.category !== "UTILITY") return "template_not_utility";      // ميتا صنّفته تسويق ⇒ مايتبعتش كتحديث طلب
  return null;
}
const BLOCK_AR = { meta_unreadable: "ماقدرناش نقرا حالة القالب من ميتا دلوقتي", template_not_approved: "القالب لسه مش معتمد عند ميتا — المرحلة دي SMS بس لحد ما يتوافق عليه",
  template_not_utility: "ميتا صنّفت القالب ده «تسويق» — مايتبعتش كتحديث طلب" };

/* صف لكل مرحلة ليها قالب: للشاشة (خانة لكل مرحلة + حالة ميتا + «يغني عن الـSMS»). */
export function stageRows({ stageTemplates = {}, notifications = {}, metaList = [], metaOk = false, mandatorySms = [] } = {}) {
  const on = waStagesOf(notifications);
  return Object.entries(stageTemplates).map(([stage, template]) => {
    const meta = metaOf(template, metaList, metaOk), block = blockOf(meta);
    return { stage, label: STAGE_LABELS[stage] || stage, template, metaStatus: meta.status, metaCategory: meta.category, canEnable: !block,
      blockedBy: block, note: block ? BLOCK_AR[block] : null, enabled: on.includes(stage), replacesSms: on.includes(stage) && waReplacesSms(notifications, stage),
      smsOnly: !on.includes(stage), mandatorySms: mandatorySms.includes(stage) };
  });
}

/* حفظ المراحل: إيه اللي يمنع؟ القفل والشيل مسموحين دايماً؛ **إضافة** مرحلة محتاجة قالبها معتمد وخدمي عند ميتا.
   بترجع null أو { error, stage?, template?, message }. */
export function stagesProblem({ want, replaces, stageTemplates = {}, current = [], metaList = [], metaOk = false } = {}) {
  if (!Array.isArray(want)) return { error: "bad_stages", message: "stages لازم قايمة" };
  if (replaces !== undefined && !Array.isArray(replaces)) return { error: "bad_replaces", message: "replacesSms لازم قايمة" };
  const w = uniq(want);
  if (w.length !== want.length) return { error: "bad_stages", message: "فيه مرحلة مكتوبة غلط أو متكررة" };
  for (const s of w) if (!stageTemplates[s]) return { error: "unknown_stage", stage: s, message: `المرحلة «${s}» مالهاش قالب واتساب` };
  for (const s of uniq(replaces || [])) if (!w.includes(s)) return { error: "replaces_needs_stage", stage: s, message: "«يغني عن الـSMS» لمرحلة مش مشغّلة على واتساب" };
  if (replaces && uniq(replaces).length !== replaces.length) return { error: "bad_replaces", message: "فيه مرحلة مكتوبة غلط أو متكررة" };
  for (const s of w.filter((x) => !current.includes(x))) {
    const block = blockOf(metaOf(stageTemplates[s], metaList, metaOk));
    if (block) return { error: block, stage: s, template: stageTemplates[s], message: `${STAGE_LABELS[s] || s}: ${BLOCK_AR[block]}` };
  }
  return null;
}

/* شاشة «قبل ما تشغّل»: الأقفال الأربعة، حالة مفتاح الخادم، وإيه اللي هيبدأ يتبعت لو المفتاح الرئيسي اتفتح.
   كل المدخلات جاهزة من المنادي (wacloud.js) — مفيش قراءة هنا. */
export function checklistView({ envState = "unset", configured = false, settingsReadable = true, master = {}, notifications = {}, waBot = {}, waCloud = {}, stages = [],
  sessionBlock = null, templateBlock = null, queued = null, stoppedReason = null, testPhones = 0 } = {}) {
  const n = notifications || {}, masterOn = master.enabled === true, updatesOn = n.whatsappEnabled === true;
  const on = stages.filter((s) => s.enabled);
  const locks = [
    { id: "env", label: "مفتاح الخادم (WHATSAPP_ENABLED في Coolify)", ok: envState === "allow", state: envState, where: "server",
      note: envState === "kill" ? "مقفول صريح: ولا رسالة، ولا حتى لأرقام التجربة" : envState === "unset" ? "مش مكتوب: العملاء مقفولين، أرقام التجربة بس شغّالة" : null },
    { id: "configured", label: "الرقم والتوكن متظبطين", ok: configured === true, where: "server", note: null },
    { id: "master", label: "مفتاح المالك الرئيسي", ok: masterOn, where: "dashboard", by: master.by || null, at: master.at || null, note: settingsReadable ? null : "ماقدرناش نقرا الإعدادات" },
    { id: "orderUpdates", label: "تحديثات الطلب على واتساب", ok: updatesOn, where: "dashboard", appliesTo: "templates",
      note: "للقوالب بس (تحديثات الطلب والحملات). رد البوت والموظف مش محتاجه." },
  ];
  const bot = { mode: String(waBot.mode || "off"), liveScope: waBot.liveScope || null, assistMode: String((waBot.assist && waBot.assist.mode) || "off") };
  return {
    locks, envState,
    paths: {
      session: { needs: ["env", "configured", "master"], blockedBy: sessionBlock, open: !sessionBlock, what: "رد البوت ورد الموظف جوّه نافذة الـ٢٤ ساعة" },
      template: { needs: ["env", "configured", "master", "orderUpdates"], blockedBy: templateBlock, open: !templateBlock, what: "القوالب: تحديثات الطلب والحملات" },
    },
    stages,
    replacesSmsLegacy: !Array.isArray(n.whatsappReplacesSmsStages) && n.whatsappReplacesSms === true,
    /* لو المفتاح الرئيسي اتفتح (والخادم سامح): إيه اللي يبدأ يطلع للعملاء */
    masterOnWouldStart: {
      needsServerSwitch: envState !== "allow",
      session: { staffReplies: true, bot, botRepliesToCustomers: bot.mode === "live", autoReply: n.whatsappAutoReply === true },
      orderUpdates: { switchOn: updatesOn, stages: updatesOn ? on.map((s) => ({ stage: s.stage, label: s.label, template: s.template, replacesSms: s.replacesSms })) : [],
        sends: updatesOn && on.length > 0, loyaltyStatus: updatesOn && n.whatsappLoyaltyStatus === true },
      campaigns: { channelEnabled: waCloud.enabled === true, needsOrderUpdatesSwitch: !updatesOn, stoppedReason: stoppedReason || null, queued,
        sends: waCloud.enabled === true && updatesOn && !stoppedReason && Boolean(queued && queued.runningMessages > 0) },
      testPhones,
    },
  };
}
