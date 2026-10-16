/* ═══════════════════════════════════════════════════════════════════════════
   جلسات بوابات التوصيل — تجديد استباقي + تنبيه + إعادة ربط بضغطة (٢٠٢٦-١٠-١٥)

   عمر (١٥/١٠): «عايزين نشوف حل دايم لموضوع بوابات هنجر ونينجا ده».

   المشكلة اللي بتتكرر:
     • هنقرستيشن (بوابة الشركاء، للعروض): توكن الوصول RS256 عمره ٤ ساعات بس،
       وبيتجدّد كسول (بس لما حد يفتح العروض). بين لفّة عروض ولفّة ممكن تعدّي
       أيام، فالتوكن بيموت في صمت ومانعرفش غير لما عمر يحاول يطلّع عرض.
     • نينجا: دخولها MFA (كود على موبايل/إيميل عمر)، فالسيرفر مايقدرش يدخل.
       بنشيل jwt (٢٤ ساعة) + refresh (٧ أيام). التجديد بيدوّر الـrefresh، بس
       القديم ما كانش بيتحفظ — فساعة الـ٧ أيام ما كانتش بترجع، والجلسة ماتت
       يوم ٦/٨ وفضلت ميتة. (ninja.js دلوقتي بيحفظ الدوران — الملف ده بيجدّد
       استباقي قبل ما الـ٧ أيام يخلصوا عشان ماتموتش تاني.)

   اللي بيعمله الملف (كله قراءة/تجديد — مفيش أي كتابة على منصة، ولا خطر على
   حساب التاجر):
     ١) مسح دوري (كل ٣٠ دقيقة افتراضي): هنقرستيشن — جدّد توكن الوصول قبل ما
        يخلص بساعة ونص (التجديد بيدوّر الـrefresh كمان فبيفضل طازة). نينجا —
        جدّد لو فاضل على الـjwt أقل من ٦ ساعات أو عدّى على آخر تجديد أكتر من
        ٤٨ ساعة (جوّه نافذة الـ٧ أيام بأمان).
     ٢) تنبيه SMS لأرقام الإنذارات (staffalerts.js — نفس لغة «رسايل الإدارة»
        عربي/إنجليزي، رسالة واحدة دايماً): «هتخلص قريب» قبل ما تموت، و«وقفت»
        لو التجديد اترفض أو فشل ٣ مرات ورا بعض. مرة كل N ساعة بالكتير لكل نوع
        (من اللوحة)، والكتم محفوظ في الداتابيز فـrestart الـAPI مابيكررش الرسالة.
     ٣) إعادة ربط بضغطة من غير نشر: endpoints (للمالك بس) بتاخد الجلسة اللي
        عمر لصقها من صفحة المنصة نفسها بعد ما سجّل دخوله بنفسه، وبتحطها في
        الداتابيز على طول. إحنا مابنلمسش باسوورد ولا كود تحقّق — بناخد التوكن
        اللي صفحة المنصة طلّعته بس.

   الإعدادات (settings.portals — من اللوحة ← الإعدادات ← جلسات البوابات،
   POST /api/portals/settings للمالك): renewEnabled, renewSweepMin, hsLeadMin,
   ninjaLeadHours, ninjaMaxAgeHours, alertsEnabled, alertRepeatHours, soonHours.

   جداوله: portal_sessions — صف 'ninja' (jwt/refresh/meta) وصف '_sweep' (حالة
   المسح: آخر تجديد/خطأ/تنبيه لكل منصة — عشان كارت الحالة مايتصفّرش بعد
   restart). هنقرستيشن ليها جدولها (hs_portal_session) وإحنا بنكتب فيه عن
   طريق hsPortal.setSession.
═══════════════════════════════════════════════════════════════════════════ */
import { smsInfo } from "./staffalerts.js";

const MIN = 60_000;
const H = 60 * MIN;
const PLATFORMS = ["hungerstation", "ninja"];
const STATE_KEY = "_sweep";

/* ── أدوات صافية (تتختبر بدون شبكة ولا داتابيز) ─────────────────────────── */

/** exp بتاع JWT بالملّي — null لو مش JWT صالح. */
export function jwtExpMs(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

/** من مجموعة توكنات (نفس النوع)، اختار الأطول صلاحية — يفضّل اللي لسه صالح.
 *  ⇒ { token, expMs } أو null لو مفيش ولا واحد. */
export function pickToken(list, now = Date.now()) {
  const cands = (list || [])
    .filter((t) => typeof t === "string" && t)
    .map((t) => ({ token: t, expMs: jwtExpMs(t) }));
  if (!cands.length) return null;
  const valid = cands.filter((c) => c.expMs != null && c.expMs > now);
  const pool = valid.length ? valid : cands;
  // الأطول صلاحية (أو غير JWT = expMs null يروح الآخر)
  pool.sort((a, b) => (b.expMs ?? -Infinity) - (a.expMs ?? -Infinity));
  return pool[0];
}

/** هل التجديد مستحق؟ true لو خلص / قرّب يخلص (أقل من leadMin) أو عدّى على آخر
 *  تجديد ناجح أكتر من maxAgeMin (عشان توكن طويل العمر يتجدّد بردو قبل ما يبوظ). */
export function renewDue({ expMs, lastRefreshAt = null, now = Date.now(), leadMin = 90, maxAgeMin = null }) {
  if (expMs != null && expMs - now < leadMin * MIN) return true;
  if (maxAgeMin != null) {
    const last = lastRefreshAt ? new Date(lastRefreshAt).getTime() : NaN;
    if (!Number.isFinite(last) || now - last > maxAgeMin * MIN) return true;
  }
  return false;
}

/** خطأ معناه إن المنصة رفضت الجلسة نفسها (مش شبكة واقعة لحظة) ⇒ لازم إنسان.
 *  ملاحظة: رسايل هنقرستيشن فيها رابط «token-refresh» فمانقدرش نعتمد على كلمة refresh. */
export function isRejection(err) {
  const e = String(err || "");
  return /HTTP (400|401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(grant|token)|token[_ ]?expired|انتهت صلاحية|صلاحية التجديد انتهت|مفيش refresh/i.test(e);
}

/** حالة جلسة واحدة للعرض والتنبيه. صافية.
 *  session: { jwt?, refresh?, accessExp?, refreshExp?, lastRefreshAt?, lastError?, failCount?, hasSession }
 *  opts: { soonMin = 24h, failLimit = 3 }
 *  ⇒ { tone: good|warn|bad|unknown, state, accessLeftMin, refreshLeftMin, needsReconnect, line } */
export function sessionHealth(platform, session, now = Date.now(), opts = {}) {
  const s = session || {};
  const soonMin = Number.isFinite(opts.soonMin) ? opts.soonMin : 24 * 60;
  const failLimit = Number.isFinite(opts.failLimit) ? opts.failLimit : 3;
  const toMin = (ms) => (ms == null ? null : Math.round((ms - now) / MIN));
  const accessLeftMin = toMin(s.accessExp ?? jwtExpMs(s.jwt));
  const refreshLeftMin = toMin(s.refreshExp ?? jwtExpMs(s.refresh));
  const base = { platform, accessLeftMin, refreshLeftMin };
  if (!s.hasSession) {
    return { ...base, tone: "bad", state: "no_session", needsReconnect: true,
      line: "مفيش جلسة محفوظة — محتاجة ربط من صفحة المنصة." };
  }
  // الـrefresh هو اللي بيحيي كل حاجة؛ لو مات (أو التجديد بيترفض / بيفشل كتير) ⇒ لازم إنسان.
  const refreshDead = refreshLeftMin != null && refreshLeftMin <= 0;
  const rejected = !!s.lastError && isRejection(s.lastError);
  const keepsFailing = !!s.lastError && (Number(s.failCount) || 0) >= failLimit;
  if (refreshDead || rejected || keepsFailing) {
    return { ...base, tone: "bad", state: "needs_reconnect", needsReconnect: true,
      line: refreshDead ? "صلاحية التجديد انتهت — لازم تسجيل دخول جديد (كود تحقّق)."
        : `التجديد ${rejected ? "بيترفض" : `فشل ${Number(s.failCount) || 0} مرات ورا بعض`} — لازم تسجيل دخول جديد. آخر خطأ: ${String(s.lastError).slice(0, 80)}` };
  }
  // refresh قرّب يخلص ⇒ أصفر: نبّه قبل ما يموت
  if (refreshLeftMin != null && refreshLeftMin < soonMin) {
    return { ...base, tone: "warn", state: "refresh_soon", needsReconnect: false,
      line: `صلاحية التجديد هتخلص خلال ${Math.max(1, Math.round(refreshLeftMin / 60))} ساعة — اربطها من جديد قبلها.` };
  }
  if (s.lastError) {
    return { ...base, tone: "warn", state: "last_error", needsReconnect: false,
      line: `شغّالة بس آخر محاولة فيها خطأ (هنجرّب تاني في اللفّة الجاية): ${String(s.lastError).slice(0, 80)}` };
  }
  if (accessLeftMin != null && accessLeftMin <= 0) {
    return { ...base, tone: "warn", state: "access_expired", needsReconnect: false,
      line: "توكن الوصول خلص والتجديد لسه شغّال — هيتجدّد في اللفّة الجاية (أو اضغط «جرّب التجديد»)." };
  }
  return { ...base, tone: "good", state: "ok", needsReconnect: false,
    line: accessLeftMin != null ? `متصلة — توكن الوصول صالح ${Math.max(0, Math.round(accessLeftMin / 60 * 10) / 10)} ساعة.` : "متصلة." };
}

/* ── نص التنبيه (SMS لأرقام الإنذارات) ───────────────────────────────────────
   نفس قواعد staffalerts.js: الإنجليزي هو الافتراضي (GSM-7، ١٦٠ حرف)، والعربي
   لو «لغة رسايل الإدارة» = عربي (UCS-2، ٧٠ حرف). مفيش إيموجي ولا «—».
   fitWords بتشيل كلمات كاملة من الآخر لو حصل وزادت (القوالب مصممة إنها
   ماتوصلش لكده) — عشان fitOneSms (اللي بتقص حروف) ماتقطعش كلمة من النص. */
const PORTAL_NAME = {
  hungerstation: { ar: "هنقرستيشن", en: "HungerStation" },
  ninja: { ar: "نينجا", en: "Ninja" },
};
export function fitWords(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (smsInfo(t).segments <= 1) return t;
  const words = t.split(" ");
  while (words.length > 1 && smsInfo(words.join(" ")).segments > 1) words.pop();
  return words.join(" ");
}
/** kind: "down" (وقفت — لازم ربط دلوقتي) | "soon" (هتخلص خلال hoursLeft ساعة). */
export function portalAlertText(platform, kind, lang = "en", hoursLeft = null) {
  const n = PORTAL_NAME[platform] || { ar: String(platform), en: String(platform) };
  const h = Math.max(1, Math.round(Number(hoursLeft) || 0));
  if (lang === "ar") {
    return fitWords(kind === "soon"
      ? `فريش كاتس: جلسة ${n.ar} هتخلص خلال ${h} ساعة - اربطها من اللوحة`
      : `فريش كاتس عاجل: جلسة ${n.ar} وقفت - اربطها من اللوحة`);
  }
  return fitWords(kind === "soon"
    ? `Fresh Cuts: ${n.en} portal session expires in ${h}h. Reconnect: Dashboard > Settings > Portal sessions.`
    : `Fresh Cuts ALERT: ${n.en} portal session stopped. Reconnect: Dashboard > Settings > Portal sessions.`);
}

/** إعدادات المسح من settings.portals — كل قيمة ليها حدود (القيمة الغلط بترجع للافتراضي). */
export function sweepConfig(settings) {
  const p = (settings && settings.portals) || {};
  const n = (v, d, lo, hi) => { const x = Number(v); return v !== "" && v != null && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    enabled: p.renewEnabled !== false,
    sweepMin: n(p.renewSweepMin, 30, 5, 240),
    hsLeadMin: n(p.hsLeadMin, 90, 15, 200),                // توكن هنقرستيشن ٤ ساعات ⇒ أقل من ٢٠٠ د دايماً
    ninjaLeadHours: n(p.ninjaLeadHours, 6, 1, 20),          // jwt نينجا ٢٤ ساعة
    ninjaMaxAgeHours: n(p.ninjaMaxAgeHours, 48, 6, 120),    // أقل من ٧ أيام (عمر الـrefresh) دايماً
    alertsEnabled: p.alertsEnabled !== false,
    alertRepeatHours: n(p.alertRepeatHours, 12, 2, 72),
    soonHours: n(p.soonHours, 24, 6, 72),
  };
}

/** بيفحص {key:value} اللي جاي من اللوحة ⇒ { ok, values } أو { ok:false, error }. */
export const PORTAL_SETTING_KEYS = {
  renewEnabled: "bool", alertsEnabled: "bool",
  renewSweepMin: [5, 240], hsLeadMin: [15, 200], ninjaLeadHours: [1, 20], ninjaMaxAgeHours: [6, 120],
  alertRepeatHours: [2, 72], soonHours: [6, 72],
};
export function validatePortalSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "شكل الطلب غلط" };
  const values = {};
  for (const [k, v] of Object.entries(body)) {
    const rule = PORTAL_SETTING_KEYS[k];
    if (!rule) return { ok: false, error: `إعداد مش معروف: ${k}` };
    if (rule === "bool") { if (typeof v !== "boolean") return { ok: false, error: `${k} لازم يبقى تشغيل/إيقاف` }; values[k] = v; continue; }
    const x = Number(v);
    if (v === "" || v == null || !Number.isFinite(x)) return { ok: false, error: `${k} لازم يبقى رقم` };
    if (x < rule[0] || x > rule[1]) return { ok: false, error: `${k} لازم بين ${rule[0]} و${rule[1]}` };
    values[k] = Math.round(x);
  }
  if (!Object.keys(values).length) return { ok: false, error: "مفيش تغييرات" };
  return { ok: true, values };
}

const freshState = () => ({ lastError: null, lastRefreshAt: null, lastTickAt: null, failCount: 0, alerts: {} });
/** حالة محفوظة ⇒ حالة نضيفة (أنواع صح بس — الصف ممكن يكون قديم أو متلخبط). */
export function reviveState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const str = (v) => (typeof v === "string" && v ? v.slice(0, 300) : null);
  const alerts = {};
  if (r.alerts && typeof r.alerts === "object") for (const [k, v] of Object.entries(r.alerts)) if (Number.isFinite(Number(v))) alerts[k] = Number(v);
  return { lastError: str(r.lastError), lastRefreshAt: str(r.lastRefreshAt), lastTickAt: str(r.lastTickAt),
    failCount: Math.max(0, Math.min(1000, Number(r.failCount) || 0)), alerts };
}

/** مين يستاهل تنبيه دلوقتي؟ صافية. health من sessionHealth، st من state[platform].
 *  ⇒ { kind, hoursLeft } أو null. «وقفت» مالهاش علاقة بكتم «قريب» (تصعيد). */
export function alertDue(health, st, cfg, now = Date.now()) {
  if (!cfg.alertsEnabled || !health) return null;
  let kind = null;
  if (health.state === "needs_reconnect") kind = "down";
  else if (health.state === "refresh_soon") kind = "soon";
  if (!kind) return null;
  const last = Number((st && st.alerts && st.alerts[kind]) || 0);
  if (now - last < cfg.alertRepeatHours * H) return null;
  return { kind, hoursLeft: health.refreshLeftMin != null ? health.refreshLeftMin / 60 : null };
}

/* ── التسجيل ─────────────────────────────────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, isOwner } = ctx;
  const hsPortal = deps.hsPortal || (() => null);     // () => { accessToken, load, setSession }
  const ninja = deps.ninja || (() => null);           // () => { refreshNow, setSession, sessionInfo }
  const setNinjaTile = deps.setNinjaTile || (() => {}); // portals.js setNinjaSession (تحديث كارت الحالة الحي)
  const getSettingsData = ctx.getSettingsData || (async () => ({}));
  const auditNote = ctx.auditNote || (async () => {});
  const alert = deps.alert || null;                   // async (platform, kind, hoursLeft) => void
  const log = deps.log || console;

  const tableReady = pool.query(`CREATE TABLE IF NOT EXISTS portal_sessions (
      platform TEXT PRIMARY KEY, jwt TEXT, refresh TEXT, meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    .catch((e) => log.error("[portal-sessions] table:", e.message));

  const state = { hungerstation: freshState(), ninja: freshState() };

  /* ── حالة المسح محفوظة (صف '_sweep') — كارت الحالة وكتم التنبيه يعيشوا بعد restart ── */
  let stateLoaded = null;
  function loadState() {
    if (!stateLoaded) {
      stateLoaded = (async () => {
        await tableReady;
        const r = await pool.query("SELECT meta FROM portal_sessions WHERE platform=$1", [STATE_KEY]).catch(() => ({ rows: [] }));
        const m = (r.rows[0] && r.rows[0].meta) || {};
        for (const p of PLATFORMS) if (m[p]) state[p] = reviveState(m[p]);
      })().catch((e) => log.error("[portal-sessions] state load:", e.message));
    }
    return stateLoaded;
  }
  async function saveState() {
    await pool.query(
      `INSERT INTO portal_sessions(platform, meta, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (platform) DO UPDATE SET meta=$2, updated_at=NOW()`,
      [STATE_KEY, JSON.stringify({ hungerstation: state.hungerstation, ninja: state.ninja })])
      .catch((e) => log.error("[portal-sessions] state save:", e.message));
  }
  const markOk = (p) => { state[p].lastError = null; state[p].failCount = 0; state[p].lastRefreshAt = new Date().toISOString(); state[p].alerts = {}; };
  const markFail = (p, e) => { state[p].lastError = String((e && e.message) || e).slice(0, 160); state[p].failCount = (state[p].failCount || 0) + 1; };

  /* ── مخزن جلسة نينجا للـninja.js ── */
  const ninjaStore = {
    async load() {
      const r = await pool.query("SELECT jwt, refresh, meta, updated_at FROM portal_sessions WHERE platform='ninja'").catch(() => ({ rows: [] }));
      const row = r.rows[0];
      return row ? { jwt: row.jwt || null, refresh: row.refresh || null, meta: row.meta || {}, updatedAt: row.updated_at } : null;
    },
    async save({ jwt = null, refresh = null, meta = {} } = {}) {
      await pool.query(
        `INSERT INTO portal_sessions(platform, jwt, refresh, meta, updated_at) VALUES ('ninja',$1,$2,$3,NOW())
         ON CONFLICT (platform) DO UPDATE SET
           jwt = COALESCE($1, portal_sessions.jwt),
           refresh = COALESCE($2, portal_sessions.refresh),
           meta = portal_sessions.meta || $3, updated_at = NOW()`,
        [jwt, refresh, JSON.stringify(meta || {})]).catch((e) => log.error("[portal-sessions] ninja save:", e.message));
    },
  };

  /* ── تجديد هنقرستيشن (توكن الوصول ٤ ساعات، التجديد بيدوّر الـrefresh) ── */
  async function tickHungerstation(cfg) {
    const api = hsPortal();
    if (!api || typeof api.accessToken !== "function") return;
    const st = state.hungerstation;
    st.lastTickAt = new Date().toISOString();
    let mem = null;
    try { mem = (typeof api.load === "function" ? await api.load() : null) || null; } catch { mem = null; }
    if (!mem) return;                                                // مفيش جلسة ⇒ الحالة بتقول «محتاجة ربط»
    const exp = mem.accessExp || jwtExpMs(mem.access);
    // جلسة لسه ملصوقة (مفيش توكن وصول خالص) ⇒ مستحقة على طول
    if (exp && !renewDue({ expMs: exp, leadMin: cfg.hsLeadMin })) return;
    try {
      await api.accessToken(true);                                   // بيحفظ الـrefresh المدوّر جوّه hs_portal.js
      markOk("hungerstation");
    } catch (e) { markFail("hungerstation", e); }
  }

  /* ── تجديد نينجا (jwt ٢٤ ساعة · refresh ٧ أيام — نجدّد جوّه النافذة بأمان) ── */
  async function tickNinja(cfg) {
    const api = ninja();
    if (!api || typeof api.refreshNow !== "function") return;
    const st = state.ninja;
    st.lastTickAt = new Date().toISOString();
    let info = null;
    try { info = (typeof api.sessionInfo === "function" ? await api.sessionInfo() : null) || null; } catch { info = null; }
    if (!info || !info.hasSession) return;
    // كارت الحالة الحي (portals.js) بيبدأ بعد كل restart بتوكن الـenv القديم — نضخّله المحفوظ كل لفّة
    if (info.jwt || info.refresh) setNinjaTile({ jwt: info.jwt || null, refresh: info.refresh || null });
    // الـrefresh نفسه مات ⇒ مفيش فايدة نخبط على نينجا كل نص ساعة؛ محتاجة دخول من إنسان
    if (info.refreshExp != null && info.refreshExp <= Date.now()) {
      if (st.lastError !== "صلاحية التجديد انتهت") { st.lastError = "صلاحية التجديد انتهت"; st.failCount = (st.failCount || 0) + 1; }
      return;
    }
    const due = renewDue({ expMs: info.jwtExp, lastRefreshAt: st.lastRefreshAt || info.lastRefreshAt,
      leadMin: cfg.ninjaLeadHours * 60, maxAgeMin: cfg.ninjaMaxAgeHours * 60 });
    if (!due) return;
    try {
      const r = await api.refreshNow();                              // ninja.js بيحفظ الدوران في ninjaStore
      if (!r || !r.jwt) throw new Error(r && r.error ? r.error : "التجديد ما رجّعش توكن");
      setNinjaTile({ jwt: r.jwt, refresh: r.refresh || null });
      markOk("ninja");
    } catch (e) { markFail("ninja", e); }
  }

  /* ── الحالة لكل منصة (للشاشة + التنبيه) ── */
  async function healthOf(platform, cfg) {
    const st = state[platform];
    const opts = { soonMin: cfg.soonHours * 60 };
    if (platform === "hungerstation") {
      const api = hsPortal();
      const mem = api && typeof api.load === "function" ? await api.load() : null;
      return sessionHealth("hungerstation", {
        hasSession: !!mem, jwt: mem?.access || null, refresh: mem?.refreshToken || null,
        accessExp: mem?.accessExp || jwtExpMs(mem?.access), refreshExp: jwtExpMs(mem?.refreshToken),
        lastRefreshAt: st.lastRefreshAt, lastError: st.lastError, failCount: st.failCount,
      }, Date.now(), opts);
    }
    const api = ninja();
    const info = api && typeof api.sessionInfo === "function" ? await api.sessionInfo() : null;
    return sessionHealth("ninja", {
      hasSession: !!(info && info.hasSession), jwt: info?.jwt || null, refresh: info?.refresh || null,
      accessExp: info?.jwtExp, refreshExp: info?.refreshExp,
      lastRefreshAt: st.lastRefreshAt || info?.lastRefreshAt, lastError: st.lastError || info?.lastError, failCount: st.failCount,
    }, Date.now(), opts);
  }

  async function checkAlerts(cfg) {
    if (!alert) return;
    for (const p of PLATFORMS) {
      let h = null;
      try { h = await healthOf(p, cfg); } catch { h = null; }
      const due = alertDue(h, state[p], cfg);
      if (!due) continue;
      state[p].alerts = { ...state[p].alerts, [due.kind]: Date.now() };
      await saveState();                                             // الكتم يتحفظ قبل الإرسال — restart ورا restart مايكررش
      try { await alert(p, due.kind, due.hoursLeft); } catch (e) { log.error(`[portal-sessions] alert ${p}:`, e.message); }
    }
  }

  let sweeping = false;
  let nextSweepAt = null;
  async function sweepOnce({ force = false } = {}) {
    if (sweeping) return;
    sweeping = true;
    try {
      await loadState();
      const cfg = sweepConfig(await getSettingsData().catch(() => ({})));
      if (cfg.enabled || force) {                                    // التجديد مقفول من اللوحة ⇒ التنبيه بس
        await tickHungerstation(cfg);
        await tickNinja(cfg);
        await saveState();
      }
      await checkAlerts(cfg);
    } catch (e) { log.error("[portal-sessions] sweep:", e.message); }
    finally { sweeping = false; }
  }

  let timer = null;
  function startSweep() {
    if (timer) return;
    const kick = async () => {
      await sweepOnce();
      const cfg = sweepConfig(await getSettingsData().catch(() => ({})));
      nextSweepAt = new Date(Date.now() + cfg.sweepMin * MIN).toISOString();
      timer = setTimeout(kick, cfg.sweepMin * MIN);
    };
    // أول لفّة بعد دقيقة من الإقلاع (نسيب الموديولات تتسجّل)
    nextSweepAt = new Date(Date.now() + MIN).toISOString();
    timer = setTimeout(kick, MIN);
  }

  /* ── الحالة المجمّعة للشاشة ── */
  const RECONNECT = {
    hungerstation: { label: "هنقرستيشن (بوابة الشركاء — العروض)", reconnect: { how: "incognito", url: "https://partner-app.hungerstation.com", seedPath: "/api/hs/portal/session" } },
    ninja: { label: "نينجا (بوابة المطعم)", reconnect: { how: "mfa", url: "https://restaurant-portal.ananinja.com", seedPath: "/api/portals/ninja/session" } },
  };
  async function statusPayload() {
    await loadState();
    const cfg = sweepConfig(await getSettingsData().catch(() => ({})));
    const out = { ok: true, at: new Date().toISOString(), nextSweepAt, config: cfg, sessions: [] };
    for (const p of PLATFORMS) {
      const st = state[p];
      const extra = { ...RECONNECT[p], lastTickAt: st.lastTickAt, lastRefreshAt: st.lastRefreshAt, failCount: st.failCount,
        lastAlertAt: Math.max(0, ...Object.values(st.alerts || {})) ? new Date(Math.max(...Object.values(st.alerts))).toISOString() : null };
      try { out.sessions.push({ ...(await healthOf(p, cfg)), ...extra }); }
      catch (e) { out.sessions.push({ platform: p, tone: "unknown", state: "unknown", line: `مقدرناش نقرا: ${String(e.message).slice(0, 100)}`, ...extra }); }
    }
    const order = ["bad", "warn", "good", "unknown"];
    out.worst = out.sessions.reduce((w, s) => (order.indexOf(s.tone) < order.indexOf(w) ? s.tone : w), "good");
    return out;
  }

  app.get("/api/portals/sessions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await statusPayload()); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  /* تجديد فوري بالإيد (للمالك) — للزرار «جرّب التجديد دلوقتي» (بيشتغل حتى لو التجديد التلقائي مقفول) */
  app.post("/api/portals/sweep", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    await sweepOnce({ force: true });
    return c.json(await statusPayload());
  });

  /* إعدادات التجديد والتنبيه (للمالك) — settings.portals بـjsonb_set (مفتاح بيملكه السيرفر). */
  app.post("/api/portals/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const v = validatePortalSettings(await c.req.json().catch(() => null));
    if (!v.ok) return c.json(v, 400);
    try {
      await pool.query(
        `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{portals}',
           COALESCE(data->'portals','{}'::jsonb) || $1::jsonb, true), updated_at = NOW() WHERE id=1`,
        [JSON.stringify(v.values)]);
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }, 500); }
    await auditNote(c, `🔁 جلسات البوابات: ${Object.entries(v.values).map(([k, x]) => `${k}=${x}`).join(" · ")}`).catch(() => {});
    return c.json({ ok: true, status: await statusPayload() });
  });

  /* إعادة ربط نينجا — عمر بيسجّل دخوله بنفسه على بوابة نينجا (الكود على موبايله)
     وبيلصق التوكنين من صفحتها. إحنا مابناخدش باسوورد ولا كود. */
  app.post("/api/portals/ninja/session", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const jwt = typeof b.jwt === "string" ? b.jwt.trim().replace(/^"|"$/g, "") : "";
    const refresh = typeof b.refresh === "string" ? b.refresh.trim().replace(/^"|"$/g, "") : "";
    if (jwtExpMs(jwt) == null) return c.json({ ok: false, error: "التوكن (jwt) مش صالح — انسخه من صفحة بوابة نينجا بعد تسجيل الدخول" });
    if (!refresh) return c.json({ ok: false, error: "ناقص refresh token" });
    const rExp = jwtExpMs(refresh);
    if (rExp != null && rExp <= Date.now()) return c.json({ ok: false, error: "صلاحية الـrefresh انتهت بالفعل — سجّل دخول من جديد وانسخ التوكنين الطازة" });
    await loadState();
    await ninjaStore.save({ jwt, refresh, meta: { seededAt: new Date().toISOString(), lastRefreshAt: new Date().toISOString() } });
    const api = ninja(); if (api && typeof api.setSession === "function") api.setSession({ jwt, refresh });
    setNinjaTile({ jwt, refresh });
    markOk("ninja");
    await saveState();
    await auditNote(c, "🔁 جلسات البوابات: نينجا اتربطت من جديد").catch(() => {});
    return c.json({ ok: true, saved: true, status: await statusPayload() });
  });

  /* إعادة ربط هنقرستيشن — عمر بيلصق جلسة البوابة (JSON من localStorage زي الأول)
     وبنحطها في جدول hs_portal_session على طول (من غير ما نعدّل Coolify وننشر). */
  app.post("/api/hs/portal/session", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const api = hsPortal();
    if (!api || typeof api.setSession !== "function") return c.json({ ok: false, error: "موديول هنقرستيشن مش جاهز" });
    const b = await c.req.json().catch(() => ({}));
    const raw = typeof b.session === "string" ? b.session : JSON.stringify(b.session || b);
    try {
      await loadState();
      const res = await api.setSession(raw);     // بيتأكد من الشكل، بيكتب الداتابيز، وبيجرّب توكن وصول
      if (!res || res.ok === false) return c.json({ ok: false, error: (res && res.error) || "الجلسة اللي اتلصقت مش مكتملة" });
      markOk("hungerstation");
      await saveState();
      await auditNote(c, "🔁 جلسات البوابات: هنقرستيشن اتربطت من جديد").catch(() => {});
      return c.json({ ok: true, saved: true, status: await statusPayload() });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  if (deps.autoStart !== false) startSweep();
  log.log && log.log("[portal-sessions] ready (proactive renewal + reconnect)");
  return { ninjaStore, statusPayload, sweepOnce, sessionHealth, state, stop: () => { if (timer) { clearTimeout(timer); timer = null; } } };
}
