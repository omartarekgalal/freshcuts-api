/* ═══════════════════════════════════════════════════════════════════════════
   ☁️ واتساب Cloud API — Coexistence (نفس الرقم على تطبيق واتساب بزنس + الـAPI)
   ٢٨/٩

   ليه: الرقم +966 54 671 5683 شغّال على تطبيق واتساب بزنس في المطعم، وعمر
   عايز يفضل كده (الكاشير يرد من الموبايل) وفي نفس الوقت نبعت قوالب معتمدة
   من السيرفر (حملات بصورة وزرار، تحديثات الطلب). ميتا بتسمح بده من غير ما
   الرقم يسيب التطبيق: Embedded Signup بنوع «whatsapp_business_app_onboarding»
   (مسح QR من التطبيق).

   الملف ده:
   ١) دوال صافية (متجرّبة): إعدادات قناة الـCloud وحدودها (cloudCfg/cloudPacing)،
      تصنيف أكواد أخطاء ميتا (classifyError)، باراميترات قالب الحملة لكل عميل
      (campaignParams)، والتحقق من حملة Cloud (cloudJobProblem).
   ٢) مساعد ما بعد الربط (POST /api/cms/wa-cloud/onboard) — مقفول بـ
      WHATSAPP_ONBOARD_WRITE=1: تبديل الكود بتوكن بزنس (احتياطي)، اشتراك
      التطبيق في الـWABA ‏(subscribed_apps)، وبعدين مزامنة جهات الاتصال
      والتاريخ (smb_app_data) — ميتا بتطلب الاتنين خلال ٢٤ ساعة من الربط.
      الإرسال بعد كده بتوكن مستخدم النظام الدائم (META_CAPI_TOKEN)؛ توكن
      البزنس (٦٠ يوم) بيتستخدم بس لو توكن النظام اترفض في خطوة.
   ٣) حالة للقراية بس (GET /api/cms/wa-cloud/status): حالة الرقم، is_on_biz_app،
      المنصة، الجودة، الحد، السرعة، التطبيقات المشتركة، عدد القوالب، صحة
      الويب هوك (آخر حدث)، ومفاتيح الـenv.
   كل ردود التشخيص HTTP 200 مع ok:false (Cloudflare بيبلع الـ5xx).
═══════════════════════════════════════════════════════════════════════════ */
import { GRAPH_VERSION, TEMPLATES, renderTemplateText } from "./whatsapp.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
export const APP_ID = "1073414588466040";
export const DEFAULT_CONFIG_ID = "1100099832721217";   // Facebook Login for Business — WA Embedded Signup (٢٨/٩)
export const KNOWN_PHONE_ID = "1102069402989468";       // +966 54 671 5683
export const KNOWN_WABA_ID = "2047231412843417";
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

/* ── إعدادات قناة الـCloud (settings.waCloud) ────────────────────────────
   tierLimit: البزنس مش موثّق ⇒ ميتا بتسمح بـ٢٥٠ عميل مختلف في ٢٤ ساعة
   (رسايل بتبدأ منّا = قوالب). reserveUtility: بنسيب جزء لتحديثات الطلبات
   عشان الحملة ماتاكلش الحد وطلب عميل مايوصلوش تحديث. */
export const CLOUD_DEFAULTS = {
  enabled: false, dailyCap: 150, hourCap: 60, perTick: 5, tierLimit: 250, reserveUtility: 50,
  configId: DEFAULT_CONFIG_ID,
};
export function cloudCfg(settings) {
  const x = { ...CLOUD_DEFAULTS, ...(((settings || {}).waCloud) || {}) };
  const tier = clampN(x.tierLimit, 1, 100000, 250);
  return {
    enabled: x.enabled === true,
    dailyCap: clampN(x.dailyCap, 1, 100000, 150),
    hourCap: clampN(x.hourCap, 1, 10000, 60),
    perTick: clampN(x.perTick, 1, 50, 5),
    tierLimit: tier,
    reserveUtility: clampN(x.reserveUtility, 0, tier, 50),
    configId: /^\d{6,25}$/.test(String(x.configId || "")) ? String(x.configId) : DEFAULT_CONFIG_ID,
  };
}

/* كام رسالة نبعت في الدورة دي؟ (دالة صافية)
   st = { today, lastHour, uniq24h, stoppedReason }
   inHours = ساعات/أيام الإرسال (wasender.inWindow — نفس مواعيد واتساب ويب) */
export function cloudPacing(cc, st, inHours) {
  if (!cc.enabled) return { allow: 0, reason: "disabled" };
  if (st.stoppedReason) return { allow: 0, reason: "stopped", detail: st.stoppedReason };
  if (!inHours) return { allow: 0, reason: "outside_hours" };
  const day = cc.dailyCap - (st.today || 0);
  if (day <= 0) return { allow: 0, reason: "daily_cap" };
  const hour = cc.hourCap - (st.lastHour || 0);
  if (hour <= 0) return { allow: 0, reason: "hour_cap" };
  const tier = cc.tierLimit - cc.reserveUtility - (st.uniq24h || 0);
  if (tier <= 0) return { allow: 0, reason: "tier_limit" };
  return { allow: Math.max(0, Math.min(cc.perTick, day, hour, tier)), reason: null };
}

/* ── أكواد أخطاء ميتا → قرار ──────────────────────────────────────────────
   reason  اللي بيتكتب على صف الطابور (اللوحة بتترجمه)
   stop    غلطة إعداد/حساب ⇒ نوقّف الإرسال كله لحد ما حد يبص (مش هتتصلّح لوحدها)
   retry   مؤقتة ⇒ الصف يرجع للطابور
   invalid الرقم مش على واتساب ⇒ مايدخلش حملات تانية
   optout  العميل وقّف التسويق من واتساب نفسه ⇒ إيقاف عندنا كمان
   fallback تنفع قناة بديلة (sms = بس؛ both = واتساب ويب أو SMS) */
export const META_ERRORS = {
  131026: { reason: "undeliverable", invalid: true, fallback: "sms" },
  131049: { reason: "meta_marketing_limit", fallback: "both" },
  130472: { reason: "meta_experiment", fallback: "both" },
  131050: { reason: "user_stopped_marketing", optout: true },
  131047: { reason: "window_closed" },
  131056: { reason: "pair_rate_limit", retry: true },
  130429: { reason: "rate_limited", retry: true },
  80007: { reason: "rate_limited", retry: true },
  4: { reason: "rate_limited", retry: true },
  131016: { reason: "meta_unavailable", retry: true },
  131000: { reason: "meta_error" },
  131021: { reason: "recipient_is_sender", invalid: true },
  131048: { reason: "spam_rate_limit", stop: true },
  131042: { reason: "payment_issue", stop: true },
  131031: { reason: "account_locked", stop: true },
  368: { reason: "policy_block", stop: true },
  131045: { reason: "phone_not_registered", stop: true },
  133010: { reason: "phone_not_registered", stop: true },
  132000: { reason: "template_params", stop: true },
  132001: { reason: "template_missing", stop: true },
  132005: { reason: "template_too_long", stop: true },
  132007: { reason: "template_policy", stop: true },
  132012: { reason: "template_params", stop: true },
  132015: { reason: "template_paused", stop: true },
  132016: { reason: "template_disabled", stop: true },
  132018: { reason: "template_params", stop: true },
  131053: { reason: "media_error", stop: true },
  131008: { reason: "template_params", stop: true },
  131009: { reason: "template_params", stop: true },
  100: { reason: "bad_request", stop: true },
  190: { reason: "token_invalid", stop: true },
  10: { reason: "permission_denied", stop: true },
  200: { reason: "permission_denied", stop: true },
};
export function classifyError(code) {
  const n = Number(code);
  const m = META_ERRORS[n];
  if (m) return { code: n, stop: false, retry: false, invalid: false, optout: false, fallback: null, ...m };
  return { code: Number.isFinite(n) ? n : null, reason: Number.isFinite(n) && n ? `meta_${n}` : "send_failed",
    stop: false, retry: false, invalid: false, optout: false, fallback: null };
}
/* القناة البديلة المسموحة للصف ده: job.fallback × نوع الغلطة */
export function fallbackFor(cls, jobFallback) {
  if (!cls?.fallback || !jobFallback || jobFallback === "none") return null;
  if (jobFallback === "sms") return "sms";
  if (jobFallback === "wa_web") return cls.fallback === "both" ? "wa_web" : null;
  return null;
}

/* ── قالب الحملة لكل عميل ──────────────────────────────────────────────────
   row: صف wa_send_queue (vars, link_code, coupon)  ·  job: wa_send_jobs
   زرار الرابط = /l/<slug>-<code> نفس روابط الحملة المتتبّعة (cms.js). */
export const CAMPAIGN_TEMPLATES = () => Object.entries(TEMPLATES).filter(([, t]) => t.campaign && t.category === "MARKETING").map(([n]) => n);
export function campaignParams(template, row, job) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template ${template}`);
  const v = row.vars || {};
  const first = String(v.first_name || "").trim() || String(v.name || row.name || "").trim().split(/\s+/)[0] || "";
  const slug = job.link_slug || "";
  const params = t.bind({
    name: first || "عميلنا",
    offer: (job.cloud_vars && job.cloud_vars.offer) || "",
    imageUrl: job.image_url || null,
    linkSuffix: slug && row.link_code ? `${slug}-${row.link_code}` : slug,
    dish: String(v.fav_dish || v.last_items || "").trim(),
    coupon: row.coupon || "",
  });
  return { params, text: renderTemplateText(template, params) };
}

/* حملة على قناة Cloud: القالب لازم يبقى قالب حملة، وكل اللي محتاجه موجود. */
export function cloudJobProblem({ cloudTemplate, cloudVars, imageUrl, offer, link }) {
  const t = TEMPLATES[cloudTemplate];
  if (!t || !t.campaign || t.category !== "MARKETING") return ["bad_template", "اختار قالب واتساب معتمد للحملة"];
  const needs = t.campaign.needs || [];
  if (needs.includes("image") && !imageUrl) return ["image_required", "القالب ده بصورة — اختار صورة العرض"];
  if (needs.includes("coupon") && !(offer && offer.oneTime) && !(link && link.coupon)) {
    return ["coupon_required", "القالب ده فيه كود — فعّل «كوبون مرة واحدة لكل عميل» أو حط كوبون ثابت"];
  }
  if (cloudTemplate === "fc_offer_img") {
    const o = String(cloudVars?.offer || "").trim();
    if (!o) return ["offer_line_required", "اكتب سطر العرض اللي هيظهر في الرسالة"];
    if (o.length > 200) return ["offer_line_long", "سطر العرض طويل (أقصى ٢٠٠ حرف)"];
    if (/[\n\t]/.test(o)) return ["offer_line_newline", "سطر العرض لازم يبقى سطر واحد"];
  }
  return null;
}

/* القناة الافتراضية لحملة جديدة: Cloud لو كله جاهز، وإلا واتساب ويب */
export function defaultChannel({ gate, phoneStatus }) {
  return !gate && String(phoneStatus || "").toUpperCase() === "CONNECTED" ? "wa_cloud" : "wa_web";
}

/* ═══════════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const doFetch = deps.fetch || globalThis.fetch;
  const wa = deps.wa || null;                 // الراجع من whatsapp.js
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);

  const sysToken = () => (wa?.token ? wa.token() : (env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN")));
  const phoneId = () => env("WHATSAPP_PHONE_ID");
  const wabaId = () => env("WHATSAPP_WABA_ID");
  const appSecret = () => env("WHATSAPP_APP_SECRET") || env("META_APP_SECRET");
  const onboardWrite = () => env("WHATSAPP_ONBOARD_WRITE") === "1";

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_onboarding (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        event TEXT,                 -- FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING | CANCEL | ERROR | code
        waba_id TEXT, phone_id TEXT, business_id TEXT,
        same_phone BOOLEAN, same_waba BOOLEAN,
        biz_token TEXT,             -- توكن البزنس (٦٠ يوم) — احتياطي، عمره ما بيطلع من السيرفر
        biz_token_at TIMESTAMPTZ,
        steps JSONB NOT NULL DEFAULT '{}'::jsonb,
        info JSONB,
        status TEXT                 -- recorded | running | done | partial | failed | write_disabled
      );
    `);
  }
  const ready = ensureSchema().catch((e) => console.error("[wa-cloud] schema:", e.message));

  const who = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return { name: (u && (u.name || u.username)) || "المالك", owner: !u || u.role === "owner" };
    } catch { return { name: "المالك", owner: false }; }
  };
  const ownerOnly = async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const w = await who(c);
    if (!w.owner) return c.json({ ok: false, error: "owner_only", message: "المالك بس" }, 403);
    return null;
  };

  async function graph(method, path, { token = sysToken(), body = null, query = null } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const resp = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}${qs}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      const e = new Error(data.error?.message || `HTTP ${resp.status}`);
      e.code = data.error?.code ?? resp.status; e.sub = data.error?.error_subcode ?? null;
      throw e;
    }
    return data;
  }
  const errJ = (e) => ({ ok: false, code: e.code ?? null, sub: e.sub ?? null, error: String(e.message || e).slice(0, 300) });
  // غلطة صلاحية/توكن ⇒ نجرّب توكن البزنس
  const authish = (e) => [10, 100, 190, 200, 3, 33].includes(Number(e.code)) || /permission|access token|not authorized/i.test(String(e.message));

  /* خطوة بتوكن النظام، ولو اترفضت صلاحية ⇒ بتوكن البزنس (لو عندنا) */
  async function step(fn, bizToken) {
    try { return { ok: true, via: "system", at: new Date(now()).toISOString(), data: await fn(sysToken()) }; }
    catch (e) {
      if (bizToken && authish(e)) {
        try { return { ok: true, via: "business", at: new Date(now()).toISOString(), data: await fn(bizToken), systemError: errJ(e) }; }
        catch (e2) { return { ...errJ(e2), via: "business", at: new Date(now()).toISOString(), systemError: errJ(e) }; }
      }
      return { ...errJ(e), via: "system", at: new Date(now()).toISOString() };
    }
  }

  const STEPS = {
    subscribe: (waba) => (tok) => graph("POST", `${waba}/subscribed_apps`, { token: tok }),
    sync_contacts: (phone) => (tok) => graph("POST", `${phone}/smb_app_data`, { token: tok, body: { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" } }),
    sync_history: (phone) => (tok) => graph("POST", `${phone}/smb_app_data`, { token: tok, body: { messaging_product: "whatsapp", sync_type: "history" } }),
  };

  async function runSteps(rec, names) {
    const steps = { ...(rec.steps || {}) };
    for (const n of names) {
      const target = n === "subscribe" ? rec.waba_id : rec.phone_id;
      if (!target) { steps[n] = { ok: false, error: "missing_id", at: new Date(now()).toISOString() }; continue; }
      steps[n] = await step(STEPS[n](target), rec.biz_token);
      // المزامنة التانية بعد الأولى — ميتا: جهات الاتصال الأول وبعدين التاريخ
    }
    const all = ["subscribe", "sync_contacts", "sync_history"].map((k) => steps[k]).filter(Boolean);
    const status = all.length === 3 && all.every((s) => s.ok) ? "done" : all.some((s) => s.ok) ? "partial" : "failed";
    await pool.query("UPDATE wa_onboarding SET steps=$2, status=$3 WHERE id=$1", [rec.id, J(steps), status]);
    return { steps, status };
  }

  const pubRec = (r) => (r ? { id: Number(r.id), at: r.created_at, by: r.created_by, event: r.event, wabaId: r.waba_id,
    phoneId: r.phone_id, businessId: r.business_id, samePhone: r.same_phone, sameWaba: r.same_waba,
    hasBusinessToken: Boolean(r.biz_token), businessTokenAt: r.biz_token_at, steps: r.steps || {}, status: r.status,
    syncDeadline: r.created_at ? new Date(new Date(r.created_at).getTime() + 24 * 3600e3).toISOString() : null } : null);
  const lastRec = async () => (await pool.query("SELECT * FROM wa_onboarding WHERE waba_id IS NOT NULL OR phone_id IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0] || null;

  // ── الإعدادات اللي صفحة الربط محتاجاها (من غير أسرار) ───────────────────
  app.get("/api/cms/wa-cloud/config", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const cc = cloudCfg(await getSettingsData());
    return c.json({ ok: true, appId: env("WHATSAPP_APP_ID", APP_ID), configId: env("WHATSAPP_ES_CONFIG_ID") || cc.configId,
      graphVersion: GRAPH_VERSION, onboardWrite: onboardWrite(), appSecret: Boolean(appSecret()),
      phoneId: phoneId() || null, wabaId: wabaId() || null, knownPhoneId: KNOWN_PHONE_ID, knownWabaId: KNOWN_WABA_ID,
      last: pubRec(await lastRec()) });
  });

  // أحداث الـpopup (إلغاء/غلط/خلص) — تسجيل بس، مفيش أي طلب لميتا
  app.post("/api/cms/wa-cloud/signup-event", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const ev = String(b.event || "").slice(0, 60);
    if (!ev) return c.json({ ok: false, error: "no_event" });
    const w = await who(c);
    await pool.query("INSERT INTO wa_onboarding(created_by, event, waba_id, phone_id, business_id, info, status) VALUES ($1,$2,$3,$4,$5,$6,'recorded')",
      [w.name, ev, b.waba_id ? String(b.waba_id).slice(0, 30) : null, b.phone_number_id ? String(b.phone_number_id).slice(0, 30) : null,
        b.business_id ? String(b.business_id).slice(0, 30) : null, J({ data: b.data || null, ua: String(c.req.header("user-agent") || "").slice(0, 160) })]);
    return c.json({ ok: true });
  });

  /* ── مساعد ما بعد الربط ─────────────────────────────────────────────────
     {code, waba_id, phone_number_id, business_id?} من Embedded Signup.
     مقفول بـ WHATSAPP_ONBOARD_WRITE=1 — من غيره بنسجّل الأرقام بس (الكود
     بيبوظ بعد دقايق، فلازم المفتاح يتفتح **قبل** مسح الـQR). */
  app.post("/api/cms/wa-cloud/onboard", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const waba = String(b.waba_id || "").replace(/\D/g, "").slice(0, 30) || null;
    const phone = String(b.phone_number_id || "").replace(/\D/g, "").slice(0, 30) || null;
    const biz = String(b.business_id || "").replace(/\D/g, "").slice(0, 30) || null;
    if (!waba && !phone) return c.json({ ok: false, error: "missing_ids", message: "مفيش waba_id ولا phone_number_id" });
    const samePhone = phone ? phone === (phoneId() || KNOWN_PHONE_ID) : null;
    const sameWaba = waba ? waba === (wabaId() || KNOWN_WABA_ID) : null;
    const w = await who(c);
    const rec = (await pool.query(
      `INSERT INTO wa_onboarding(created_by, event, waba_id, phone_id, business_id, same_phone, same_waba, status)
       VALUES ($1,'onboard',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [w.name, waba, phone, biz, samePhone, sameWaba, onboardWrite() ? "running" : "write_disabled"])).rows[0];
    const envHint = { WHATSAPP_PHONE_ID: phone, WHATSAPP_WABA_ID: waba,
      changePhone: phone && phoneId() !== phone, changeWaba: waba && wabaId() !== waba };
    if (!onboardWrite()) {
      return c.json({ ok: false, error: "onboard_write_disabled", recorded: pubRec(rec), envHint,
        message: "الأرقام اتسجّلت، بس المزامنة مااشتغلتش — WHATSAPP_ONBOARD_WRITE مقفول" });
    }
    // ١) تبديل الكود بتوكن بزنس — احتياطي (الإرسال بتوكن النظام)
    const steps = {};
    if (b.code && appSecret()) {
      try {
        const d = await graph("GET", "oauth/access_token", { token: null,
          query: { client_id: env("WHATSAPP_APP_ID", APP_ID), client_secret: appSecret(), code: String(b.code).slice(0, 2000) } });
        if (d.access_token) {
          await pool.query("UPDATE wa_onboarding SET biz_token=$2, biz_token_at=NOW() WHERE id=$1", [rec.id, d.access_token]);
          rec.biz_token = d.access_token;
        }
        steps.exchange = { ok: Boolean(d.access_token), at: new Date(now()).toISOString() };
      } catch (e) { steps.exchange = { ...errJ(e), at: new Date(now()).toISOString() }; }
    } else {
      steps.exchange = { ok: false, skipped: b.code ? "no_app_secret" : "no_code", at: new Date(now()).toISOString() };
    }
    rec.steps = steps;
    const r = await runSteps(rec, ["subscribe", "sync_contacts", "sync_history"]);
    return c.json({ ok: r.status === "done", status: r.status, onboarding: pubRec({ ...rec, steps: r.steps, status: r.status }), envHint });
  });

  // إعادة خطوة (مثلاً المزامنة فشلت) — نفس المفتاح، وعلى آخر ربط
  app.post("/api/cms/wa-cloud/onboard/retry", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    if (!onboardWrite()) return c.json({ ok: false, error: "onboard_write_disabled" });
    const b = await c.req.json().catch(() => ({}));
    const names = (Array.isArray(b.steps) ? b.steps : [b.step]).filter((s) => STEPS[s]);
    if (!names.length) return c.json({ ok: false, error: "bad_step" });
    const rec = (await pool.query("SELECT * FROM wa_onboarding WHERE event='onboard' ORDER BY id DESC LIMIT 1")).rows[0];
    if (!rec) return c.json({ ok: false, error: "no_onboarding" });
    const late = now() - new Date(rec.created_at).getTime() > 24 * 3600e3;
    const r = await runSteps(rec, names);
    return c.json({ ok: names.every((n) => r.steps[n]?.ok), status: r.status, late, onboarding: pubRec({ ...rec, steps: r.steps, status: r.status }) });
  });

  /* ── الحالة (قراية بس) ──────────────────────────────────────────────────
     حالة الرقم متخزّنة ١٠ دقايق عشان wasender يعرف القناة الافتراضية من غير
     ما يسأل ميتا كل شوية. */
  let phoneCache = { at: 0, data: null };
  const PHONE_FIELDS = "display_phone_number,verified_name,status,quality_rating,platform_type,throughput,messaging_limit_tier,code_verification_status,name_status,is_on_biz_app,health_status";
  const PHONE_FIELDS_MIN = "display_phone_number,verified_name,status,quality_rating,platform_type,throughput,messaging_limit_tier,code_verification_status";
  async function phoneInfo({ fresh = false } = {}) {
    const pid = phoneId() || KNOWN_PHONE_ID;
    if (!fresh && phoneCache.data && now() - phoneCache.at < 10 * 60e3 && phoneCache.data.id === pid) return phoneCache.data;
    if (!sysToken()) return { ok: false, error: "no_token", id: pid };
    let d;
    try { d = await graph("GET", pid, { query: { fields: PHONE_FIELDS } }); }
    catch (e) {
      if (Number(e.code) !== 100) { const x = { ...errJ(e), id: pid }; phoneCache = { at: now(), data: x }; return x; }
      try { d = await graph("GET", pid, { query: { fields: PHONE_FIELDS_MIN } }); }
      catch (e2) { const x = { ...errJ(e2), id: pid }; phoneCache = { at: now(), data: x }; return x; }
    }
    const x = { ok: true, id: pid, number: d.display_phone_number || null, name: d.verified_name || null,
      status: d.status || null, quality: d.quality_rating || null, platform: d.platform_type || null,
      throughput: d.throughput?.level || null, tier: d.messaging_limit_tier || null,
      verification: d.code_verification_status || null, nameStatus: d.name_status || null,
      isOnBizApp: d.is_on_biz_app ?? null, health: d.health_status?.can_send_message || null };
    phoneCache = { at: now(), data: x };
    return x;
  }

  let tplCache = { at: 0, data: null };
  async function templateInfo({ fresh = false } = {}) {
    const waba = wabaId() || KNOWN_WABA_ID;
    if (!fresh && tplCache.data && now() - tplCache.at < 10 * 60e3) return tplCache.data;
    if (!sysToken()) return { ok: false, error: "no_token" };
    try {
      const d = await graph("GET", `${waba}/message_templates`, { query: { fields: "name,status,category,language", limit: "200" } });
      const list = (d.data || []).map((t) => ({ name: t.name, status: t.status, category: t.category, language: t.language }));
      const byStatus = {};
      for (const t of list) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      const x = { ok: true, total: list.length, byStatus, list,
        ours: Object.keys(TEMPLATES).map((n) => ({ name: n, category: TEMPLATES[n].category,
          campaign: Boolean(TEMPLATES[n].campaign), label: TEMPLATES[n].campaign?.label || null,
          status: list.find((t) => t.name === n)?.status || "NOT_SUBMITTED" })) };
      tplCache = { at: now(), data: x };
      return x;
    } catch (e) { const x = errJ(e); tplCache = { at: now(), data: x }; return x; }
  }

  app.get("/api/cms/wa-cloud/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const fresh = c.req.query("fresh") === "1";
    const waba = wabaId() || KNOWN_WABA_ID;
    const [phone, tpl, subs, hooks, hist, last, gate] = await Promise.all([
      phoneInfo({ fresh }),
      templateInfo({ fresh }),
      sysToken() ? graph("GET", `${waba}/subscribed_apps`).then((d) => ({ ok: true,
        apps: (d.data || []).map((a) => ({ id: a.whatsapp_business_api_data?.id || a.id || null, name: a.whatsapp_business_api_data?.name || a.name || null })) }))
        .catch(errJ) : Promise.resolve({ ok: false, error: "no_token" }),
      pool.query("SELECT field, last_at, n, last_note FROM wa_webhook_health ORDER BY last_at DESC").then((r) => r.rows).catch(() => []),
      pool.query("SELECT imported, skipped, chunks, last_meta, errors, updated_at FROM wa_history_state WHERE id=1").then((r) => r.rows[0] || null).catch(() => null),
      lastRec().catch(() => null),
      wa ? wa.gate() : Promise.resolve("disabled"),
    ]);
    const lastEvent = hooks.filter((h) => !String(h.field).startsWith("_")).map((h) => h.last_at).sort().pop() || null;
    const ourApp = subs.ok ? subs.apps.some((a) => String(a.id) === env("WHATSAPP_APP_ID", APP_ID)) : null;
    return c.json({ ok: true, phone, templates: tpl, subscribedApps: { ...subs, ours: ourApp },
      webhook: { lastEventAt: lastEvent, fields: hooks, callback: "/api/wa/webhook" }, history: hist,
      onboarding: pubRec(last), gate: gate || null,
      env: { WHATSAPP_ENABLED: env("WHATSAPP_ENABLED") === "1", WHATSAPP_PHONE_ID: phoneId() || null, WHATSAPP_WABA_ID: wabaId() || null,
        token: env("WHATSAPP_TOKEN") ? "WHATSAPP_TOKEN" : env("META_CAPI_TOKEN") ? "META_CAPI_TOKEN" : null,
        WHATSAPP_APP_SECRET: Boolean(env("WHATSAPP_APP_SECRET")), WHATSAPP_VERIFY_TOKEN: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
        WHATSAPP_ONBOARD_WRITE: onboardWrite(), WHATSAPP_TEMPLATES_WRITE: env("WHATSAPP_TEMPLATES_WRITE") === "1" },
      defaultChannel: defaultChannel({ gate, phoneStatus: phone?.status }) });
  });

  /* 🎬 عرض مراجعة التطبيق (App Review) — ٢٩/٩
     ميتا بتطلب فيديوهين عشان تدّي Advanced Access (شرط الـEmbedded Signup):
     ١) whatsapp_business_messaging: التطبيق بيبعت رسالة وبتوصل على واتساب.
     ٢) whatsapp_business_management: التطبيق بيعمل قالب رسالة.
     الإرسال من رقم ميتا التجريبي (بيبعت بس للأرقام المسجّلة في قايمة المستلمين)
     أو من رقمنا لما يتربط. إنشاء القالب على الـWABA الحقيقي — مقفول بـ
     WHATSAPP_TEMPLATES_WRITE=1 زي تقديم القوالب. */
  const TEST_PHONE_ID = () => env("WHATSAPP_TEST_PHONE_ID", "1376437515542744");
  app.post("/api/cms/wa-cloud/demo/send", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const to = String(b.to || "").replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(to)) return c.json({ ok: false, error: "bad_to", message: "Enter the full number with country code" });
    const from = b.sender === "live" ? (phoneId() || KNOWN_PHONE_ID) : TEST_PHONE_ID();
    const template = /^[a-z0-9_]{1,512}$/.test(String(b.template || "")) ? String(b.template) : "hello_world";
    const language = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.language || "")) ? String(b.language) : "en_US";
    try {
      const d = await graph("POST", `${from}/messages`, { body: { messaging_product: "whatsapp", to, type: "template",
        template: { name: template, language: { code: language } } } });
      return c.json({ ok: true, from, to, template, messageId: d.messages?.[0]?.id || null, status: d.messages?.[0]?.message_status || "accepted" });
    } catch (e) { return c.json(errJ(e)); }
  });
  app.post("/api/cms/wa-cloud/demo/template", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    if (env("WHATSAPP_TEMPLATES_WRITE") !== "1") return c.json({ ok: false, error: "templates_write_disabled", message: "Set WHATSAPP_TEMPLATES_WRITE=1" });
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || "").trim().toLowerCase();
    const text = String(b.body || "").trim();
    const category = ["UTILITY", "MARKETING"].includes(b.category) ? b.category : "UTILITY";
    const language = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.language || "")) ? String(b.language) : "en_US";
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return c.json({ ok: false, error: "bad_name", message: "Use lowercase letters, numbers and _" });
    if (!text || text.length > 1024) return c.json({ ok: false, error: "bad_body", message: "Body is required (max 1024)" });
    try {
      const d = await graph("POST", `${wabaId() || KNOWN_WABA_ID}/message_templates`, { body: { name, language, category,
        components: [{ type: "BODY", text }] } });
      tplCache = { at: 0, data: null };
      return c.json({ ok: true, id: d.id || null, status: d.status || null, category: d.category || category, name });
    } catch (e) { return c.json(errJ(e)); }
  });

  // إعدادات قناة الـCloud + config_id (المالك)
  app.post("/api/cms/wa-cloud/settings", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const s = await getSettingsData();
    const cur = (s.waCloud && typeof s.waCloud === "object") ? s.waCloud : {};
    const next = { ...cur };
    for (const k of ["enabled", "dailyCap", "hourCap", "perTick", "tierLimit", "reserveUtility", "configId"]) if (b[k] !== undefined) next[k] = b[k];
    const clean = cloudCfg({ waCloud: next });
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waCloud}', $1::jsonb, true) WHERE id=1`, [J(clean)]);
    // التشغيل من تاني بيمسح «اتوقف» (المالك بص وقرر)
    if (b.enabled === true) await pool.query("UPDATE wa_sender_state SET stopped_reason=NULL, fail_streak=0 WHERE id=2").catch(() => {});
    return c.json({ ok: true, cfg: clean });
  });

  return { phoneInfo, templateInfo, ready, cloudCfg };
}
