/* ═══════════════════════════════════════════════════════════════════════════
   PS1 (عمر ١٧/١٠): «في البورتال عند المدير ممكن نضيف كمان في الخدمة البيانات فقط اللي محتاجها المدير يعدّلها بخصوص
   المناديب وشركات التوصيل».

   مش مخزن تاني ولا شاشة إعدادات تانية: نفس مفاتيح «التوصيل والمندوبين» (deliverycontrol.js — المواصفة والتحقق والقيمة
   الفعّالة) ونفس مفتاح «أزرار المندوب الخارجي» (settings.waBot.courierJob.enabled)، بس الخمسة اللي المدير محتاجهم:

     ١. الشركة الفعّالة (لأجلك / Cervo / Flying Arrow) — والفعّال اللي الكود بيستعمله فعلاً (مع قفل البيئة لو موجود).
     ٢. طلب مندوب تلقائي للطلبات الأونلاين — تشغيل/إيقاف + سبب مكتوب (بيتسجّل مع الاسم).
     ٣. مهلة التحضير الدايمة قبل طلب المندوب (دقايق) — المؤقتة ليها مسارها القديم /api/portal/prep-delay.
     ٤. تسليم المندوب الخارجي: أزرار واتساب من رقم المطعم ولا رابط المتابعة بس.
     ٥. حساب لاجلك (LJ2a): الحالة + «افحص دلوقتي».

   القراية للكاشير والمدير (canEdit للمدير بس)، والكتابة للمدير بس (requirePortal manager). كل تغيير بيتكتب في
   portal_audit باسم المدير + سطر في cms_audit (سجل النشاط في اللوحة) بنفس نص deliverycontrol.auditLine، فالمالك بيشوف
   «مين غيّر إيه من إيه لإيه» في المكانين. المفاتيح الخطيرة (تبديل الشركة، إيقاف الإرسال الآلي) محتاجة confirm:true.
═══════════════════════════════════════════════════════════════════════════ */
import { FIELD_BY_PATH, validatePatch, dangerousChanges, effectiveSettings, sourceOf, auditLine, patchChanges } from "./deliverycontrol.js";
import { dispatchDelayOverride } from "./delivery.js";
import { courierJobConfig } from "./courierwa-cfg.js";
import { applyPathChanges } from "./settings-guard.js";
import { ljHealthOf } from "./ljwatch.js";

/* الحقول المسموحة للمدير ← مسارها في الإعدادات */
export const MANAGER_FIELDS = Object.freeze({
  provider: "delivery.provider",
  autoDispatch: "shop.autoDispatch",
  dispatchDelayMin: "delivery.dispatchDelayMin",
});
export const HANDOFF_PATH = "waBot.courierJob.enabled";
export const PROVIDER_LABELS = Object.freeze({ leajlak: "لأجلك", cervo: "Cervo", flyingarrow: "Flying Arrow" });

const envRead = (k) => (process.env[k] || "").trim();

/** الحالة اللي الشاشة بتعرضها — من نفس دوال الإعداد اللي الكود بيستعملها. صافية (متختبرة). */
export function serviceView(settings, { env = envRead, lj = null, canEdit = false } = {}) {
  const e = effectiveSettings(settings, env);
  const d = (settings || {}).delivery || {};
  const cj = courierJobConfig(((settings || {}).waBot || {}).courierJob);
  const provSpec = FIELD_BY_PATH["delivery.provider"];
  const dispatchLock = e.dispatch.source.startsWith("env:") ? { source: e.dispatch.source.slice(4), forced: Boolean(e.dispatch.forced), reason: e.dispatch.reason || null } : null;
  const effProvider = e.provider;
  const notes = [];
  if (e.dispatch.mode === "manual") notes.push(dispatchLock && dispatchLock.forced
    ? "بوابة الإرسال مقفولة يدوي من السيرفر (DELIVERY_FORCE_MANUAL) — مفيش أي طلب مندوب بيخرج مهما كانت المفاتيح هنا."
    : "بوابة الإرسال «يدوي» من اللوحة — مفيش طلب مندوب بيخرج من السيرفر. المالك بيفتحها من «التوصيل والمندوبين».");
  if (e.routing.enabled) notes.push("التوجيه بالمسافة شغّال: الطلبات بتتوزّع على شركات بالمسافة، فالشركة الفعّالة هنا مش الوحيدة.");
  return {
    canEdit,
    provider: {
      effective: effProvider, label: PROVIDER_LABELS[effProvider] || effProvider,
      stored: d.provider || null, source: sourceOf("delivery.provider", settings, env),
      options: (provSpec.options || []).map((o) => ({ v: o.v, label: PROVIDER_LABELS[o.v] || o.label })),
      hint: provSpec.hint || null,
    },
    dispatchMode: { effective: e.dispatch.mode, lock: dispatchLock },
    autoDispatch: {
      effective: e.autoDispatch, source: sourceOf("shop.autoDispatch", settings, env),
      reason: typeof d.autoDispatchReason === "string" && d.autoDispatchReason ? d.autoDispatchReason : null,
      changedBy: d.autoDispatchBy || null, changedAt: d.autoDispatchAt || null,
    },
    prepDelay: { base: e.dispatchDelayMin, temp: dispatchDelayOverride(settings || {}), min: 0, max: 90 },
    handoff: { mode: cj.enabled ? "buttons" : "link", buttons: Boolean(cj.enabled), templateOn: Boolean(cj.useTemplate), templateName: cj.templateName || null },
    leajlak: lj ? {
      state: lj.state?.state || null, label: lj.state?.label || null, since: lj.state?.since || null, lastCheck: lj.state?.lastCheck || null,
      httpStatus: lj.state?.httpStatus ?? null, line: lj.health?.line || null, status: lj.health?.status || null, fix: lj.health?.fix || null,
      enabled: lj.cfg?.enabled !== false, everyMin: lj.cfg?.everyMin ?? null,
    } : null,
    notes,
  };
}

/** body → {ok, values(path→value), extra(path→value for الحقول اللي مش في deliverycontrol), errors} */
export function managerPatch(body) {
  const src = body && typeof body.patch === "object" && body.patch ? body.patch : (body || {});
  const dc = {}, extra = {}, errors = [];
  for (const [k, v] of Object.entries(src)) {
    if (MANAGER_FIELDS[k]) dc[MANAGER_FIELDS[k]] = v;
    else if (k === "handoffButtons") {
      if (v === true || v === false || v === "true" || v === "false") extra[HANDOFF_PATH] = v === true || v === "true";
      else errors.push({ path: k, error: "لازم صح أو غلط", label: "تسليم المندوب الخارجي" });
    } else errors.push({ path: k, error: "الحقل ده مش من صلاحيات المدير", label: k });
  }
  let values = {};
  if (Object.keys(dc).length) {
    const v = validatePatch(dc);
    errors.push(...v.errors);
    values = v.values;
  }
  if (!errors.length && !Object.keys(values).length && !Object.keys(extra).length) errors.push({ path: "", error: "مفيش أي حقل في الطلب" });
  return { ok: errors.length === 0, values, extra, errors };
}

/** سطر السجل: deliverycontrol.auditLine + الأزرار + السبب + اسم المدير */
export function managerAuditLine({ values, extra, settings, reason, who }) {
  const parts = [];
  if (Object.keys(values || {}).length) parts.push(auditLine(values, settings).replace(/^🛵 التوصيل والمندوبين — /, ""));
  if (extra && Object.prototype.hasOwnProperty.call(extra, HANDOFF_PATH)) {
    const cur = courierJobConfig(((settings || {}).waBot || {}).courierJob).enabled;
    parts.push(`تسليم المندوب الخارجي: ${cur ? "أزرار واتساب" : "رابط بس"} → ${extra[HANDOFF_PATH] ? "أزرار واتساب" : "رابط بس"}`);
  }
  const r = String(reason || "").trim();
  return `🛵 الخدمة (بوابة المدير${who ? ` · ${who}` : ""}) — ${parts.join(" · ")}${r ? ` — السبب: ${r.slice(0, 120)}` : ""}`.slice(0, 500);
}

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData } = ctx;
  const log = ctx.log || console;
  const portal = () => (typeof deps.portal === "function" ? deps.portal() : deps.portal) || null;
  const lj = () => (typeof deps.ljWatch === "function" ? deps.ljWatch() : deps.ljWatch) || null;
  const requirePortal = (c, role) => {
    const p = portal();
    if (!p || typeof p.requirePortal !== "function") return Promise.resolve({ res: c.json({ ok: false, error: "unavailable", message: "البوابة لسه بتقوم" }, 503) });
    return p.requirePortal(c, role);
  };
  const audit = (user, action, detail) => { try { portal()?.audit?.(user, action, null, true, detail, null, { emit: false }); } catch { /* */ } };
  async function cmsAudit(user, note) {
    try {
      await pool.query(
        `INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [null, user?.name || user?.id || "المدير", `portal:${user?.role || "manager"}`, "PUT", "/api/portal/delivery-service", "delivery", note]);
    } catch (e) { try { log.error?.(`[portal-service] cms_audit: ${e?.message || e}`); } catch { /* */ } }
  }
  async function ljView() {
    const w = lj(); if (!w || typeof w.view !== "function") return null;
    try { const v = await w.view(); return { ...v, health: ljHealthOf(v, Date.now()) }; }
    catch { return null; }
  }
  async function view(a) {
    const s = (await getSettingsData().catch(() => ({}))) || {};
    return serviceView(s, { lj: await ljView(), canEdit: a.user.role === "manager" });
  }

  app.get("/api/portal/delivery-service", async (c) => {
    const a = await requirePortal(c, "cashier"); if (a.res) return a.res;
    return c.json({ ok: true, ...(await view(a)) });
  });

  app.put("/api/portal/delivery-service", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const body = await c.req.json().catch(() => ({}));
    const p = managerPatch(body);
    if (!p.ok) return c.json({ ok: false, error: "invalid", errors: p.errors, message: p.errors.map((e) => `${e.label || e.path}: ${e.error}`).join(" · ") }, 400);
    const settings = (await getSettingsData().catch(() => ({}))) || {};
    const danger = dangerousChanges(p.values, settings);
    if (danger.length && body.confirm !== true) {
      return c.json({ ok: false, error: "confirm_required", needConfirm: danger, message: danger.map((d) => d.warn).join(" ") }, 409);
    }
    /* إيقاف الإرسال الآلي من غير سبب — نرفض: المالك لازم يعرف ليه (طلب عمر «مع السبب») */
    const reason = String(body.reason || "").trim().slice(0, 120);
    if (p.values["shop.autoDispatch"] === false && !reason) {
      return c.json({ ok: false, error: "reason_required", message: "اكتب سبب إيقاف الطلب التلقائي للمندوب (بيتسجّل باسمك)" }, 400);
    }
    const changes = patchChanges(p.values);
    for (const [path, value] of Object.entries(p.extra)) changes.push({ path, value });
    if (Object.prototype.hasOwnProperty.call(p.values, "shop.autoDispatch")) {
      changes.push({ path: "delivery.autoDispatchReason", value: reason || null });
      changes.push({ path: "delivery.autoDispatchBy", value: a.user.name || a.user.id || null });
      changes.push({ path: "delivery.autoDispatchAt", value: new Date().toISOString() });
    }
    const note = managerAuditLine({ values: p.values, extra: p.extra, settings, reason, who: a.user.name });
    try { await applyPathChanges(pool, changes); }
    catch (e) { log.error?.(`[portal-service] save: ${e?.message || e}`); return c.json({ ok: false, error: "save_failed", message: "الحفظ فشل — جرّب تاني" }, 500); }
    audit(a.user, "delivery_service_change", { changed: changes.map((x) => x.path), note, reason: reason || null, danger: danger.map((d) => d.path) });
    await cmsAudit(a.user, note);
    try { log.log?.(`[portal-service] ${note}`); } catch { /* */ }
    return c.json({ ok: true, changed: changes.map((x) => x.path), note, ...(await view(a)) });
  });

  /* «افحص دلوقتي» (LJ2a): نفس GET /shops الواحد، ونفس فاصل الـ٣٠ ثانية بتاع لوحة المالك */
  let lastManual = 0;
  app.post("/api/portal/delivery-service/leajlak-check", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const w = lj();
    if (!w || typeof w.check !== "function") return c.json({ ok: false, error: "unavailable", message: "مراقب لاجلك مش شغّال على السيرفر" }, 503);
    if (Date.now() - lastManual < 30_000) return c.json({ ok: false, error: "too_soon", message: "استنى ٣٠ ثانية بين كل فحص والتاني" }, 429);
    lastManual = Date.now();
    const r = await w.check({ reason: `portal:${a.user.name || a.user.id || "manager"}`, force: true });
    audit(a.user, "leajlak_check", { result: r?.state || r?.error || null });
    return c.json({ ok: r?.ok !== false, result: r, ...(await view(a)) });
  });

  return { serviceView, managerPatch };
}

export default { register };
