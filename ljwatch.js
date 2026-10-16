/* ═══════════════════════════════════════════════════════════════════════════
   🛵 ljwatch.js — LJ2a (١٦/١٠): «حساب لاجلك لسه موقوف ولا رجع؟» من غير ما نعمل طلب

   ١٦/١٠ مساءً لاجلك وقّفت حسابنا: GET /shops و GET /orders/<id> الاتنين بيرجّعوا
     401 {"message":"Client is not active or may be suspended. If you think this is an error, please contact Leajlak …"}
   الطلب الآلي اتقفل (settings.shop.autoDispatch=false) والفريق شغّال بالمندوب الخارجي من البوابة. عمر عايز يعرف
   أول ما الحساب يرجع — من غير ما نعمل طلب عندهم عشان نجرّب.

   كل everyMin دقيقة (settings.delivery.ljWatch، الافتراضي ١٠) سؤال واحد **GET /shops** — قراءة بس. مفيش POST ولا DELETE
   في الملف ده خالص (probe مكتوب فيه method: "GET" ثابت، والتست بيتأكد).
     200 + JSON                         ⇒ «شغّال»            (up)
     401 + «not active / suspended»     ⇒ «موقوف من لاجلك»   (suspended)
     أي حاجة تانية (شبكة، مهلة، 401 تاني، 5xx، 200 مش JSON) ⇒ «مش عارفين (…)» (unknown) + كود HTTP
   الحالة في lj_watch_state (صف واحد): { state, label, since, lastCheck, httpStatus, message, lastKnown, log[] }.
   «unknown» مابيغيّرش آخر حالة معروفة — فموقوف ⇒ خطأ شبكة ⇒ شغّال لسه بيتحسب «رجع».

   التنبيه: لما آخر حالة معروفة «موقوف» والفحص يقول «شغّال» ⇒ SMS واحدة بالعربي للمالك (نفس مسار wahealth.recipientsOf:
   المالك اللي في دليل الفريق وفي أرقام الإنذارات ⇒ المالكين ⇒ أرقام الإنذارات)، + رسالة واتساب حرة (ببلاش) بس لو نافذة
   الـ٢٤ ساعة مفتوحة (sendFreeform بيرفض لوحده لو مقفولة؛ عمره ما بيبعت قالب مدفوع).
   ضد العاصفة: (١) التنبيه على التحويل بس، (٢) تنبيه «رجع» واحد كل ٦ ساعات بالكتير حتى لو الحالة رقصت، (٣) الحجز بـver على
   الصف عشان حاويتين وقت النشر مايبعتوش مرتين، (٤) لو الإرسال فشل لكل الأرقام: إعادة مع الفحص الجاي، ٣ مرات بالكتير.
   الملف ده **مابيكتبش في settings خالص** — مابيرجّعش shop.autoDispatch (القرار للمالك).
   البداية: الصف بيتزرع «موقوف» (اللي اتشاف ١٦/١٠)، فلو أول فحص بعد النشر لقاه شغّال ⇒ تنبيه «رجع» واحد.

   GET  /api/delivery/leajlak/account        (admin) — الحالة + السجل
   POST /api/delivery/leajlak/account/check  (admin) — «افحص دلوقتي» (نفس GET /shops، مرة كل ٣٠ ث بالكتير)
   والحالة كمان في /api/system/health (مكوّن leajlak_account) وفي /api/delivery/control (سطر فوق مفتاح المراقبة).
═══════════════════════════════════════════════════════════════════════════ */
import { fitOneSms } from "./staffalerts.js";
import { recipientsOf } from "./wahealth.js";

export const LJ_WATCH_DEFAULTS = Object.freeze({ enabled: true, everyMin: 10 });
export const LJ_WATCH_LIMITS = Object.freeze({ everyMin: [5, 120] });
export const REOPEN_COOLDOWN_MS = 6 * 3600_000;    // تنبيه «رجع» واحد كل ٦ ساعات بالكتير
export const MAX_ALERT_ATTEMPTS = 3;               // الإرسال فشل لكل الأرقام ⇒ نعيد مع الفحص الجاي لحد ٣ مرات
export const MANUAL_GAP_MS = 30_000;               // «افحص دلوقتي» مرة كل ٣٠ ثانية بالكتير
export const SUSPEND_RE = /not active|suspended/i;
export const STATE_AR = Object.freeze({ up: "شغّال", suspended: "موقوف من لاجلك", unknown: "مش عارفين" });
export const SEED = Object.freeze({
  state: "suspended", label: STATE_AR.suspended, since: null, lastCheck: null, httpStatus: 401,
  message: "Client is not active or may be suspended.", lastKnown: "suspended", knownSince: null, checks: 0, log: [],
  seeded: "١٦/١٠: GET /shops و GET /orders رجّعوا 401 «Client is not active or may be suspended» (فحص يدوي قبل المراقب)",
});

const ljBase = () => String(process.env.LEAJLAK_BASE || "https://app.leajlak.com/api/partner").trim().replace(/\/+$/, "");
const ljToken = () => String(process.env.LEAJLAK_TOKEN || "").trim();
const mask = (p) => `***${String(p || "").slice(-4)}`;
/* الرياض UTC+3 طول السنة (مفيش توقيت صيفي) */
export const riyadhHM = (ms) => new Date(Number(ms) + 3 * 3600_000).toISOString().slice(11, 16);
export const riyadhDayHM = (iso) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 3 * 3600_000).toISOString();
  return `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))} ${d.slice(11, 16)}`;
};

export function ljWatchCfg(settings) {
  const raw = ((settings || {}).delivery || {}).ljWatch;
  const o = raw && typeof raw === "object" ? raw : {};
  const v = o.everyMin, n = Number(v);
  const [lo, hi] = LJ_WATCH_LIMITS.everyMin;
  const ok = v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(n);
  return { enabled: o.enabled !== false, everyMin: ok ? Math.min(hi, Math.max(lo, Math.round(n))) : LJ_WATCH_DEFAULTS.everyMin };
}

/* ── التصنيف (صافية) ── */
export function classify({ status = null, body = null, text = null, error = null } = {}) {
  if (error) {
    const e = String(error).slice(0, 200);
    if (e === "no_token") return { state: "unknown", label: "مش عارفين (مفيش LEAJLAK_TOKEN)", httpStatus: null, message: e };
    if (e === "timeout") return { state: "unknown", label: "مش عارفين (لاجلك مارديتش في ٢٠ ثانية)", httpStatus: null, message: e };
    return { state: "unknown", label: "مش عارفين (خطأ شبكة)", httpStatus: null, message: e };
  }
  const msg = String((body && typeof body === "object" ? (body.message || body.error || "") : "") || text || "")
    .replace(/\s+/g, " ").trim().slice(0, 200) || null;
  if (status === 200 && body && typeof body === "object") return { state: "up", label: STATE_AR.up, httpStatus: 200, message: null };
  if (status === 200) return { state: "unknown", label: "مش عارفين (HTTP 200 بس الرد مش JSON)", httpStatus: 200, message: msg };
  if (status === 401 && SUSPEND_RE.test(msg || "")) return { state: "suspended", label: STATE_AR.suspended, httpStatus: 401, message: msg };
  return { state: "unknown", label: `مش عارفين (HTTP ${status == null ? "؟" : status})`, httpStatus: status, message: msg };
}

/* ── السؤال الوحيد اللي بيروح للاجلك: GET /shops. method ثابت — مفيش طريقة الملف ده يكتب عندهم. ── */
export async function probe({ fetchImpl = globalThis.fetch, base = ljBase(), token = ljToken(), timeoutMs = 20_000 } = {}) {
  if (!token) return { error: "no_token" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${base}/shops`, {
      method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: ctl.signal,
    });
    const text = await r.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    /* رد الـ200 فيه بيانات المحلات — مابنحتفظش بيه، بس بنقول إنه JSON */
    return { status: Number(r.status), body: body && typeof body === "object" ? body : null, text: body ? null : String(text || "").slice(0, 200) };
  } catch (e) {
    return { error: e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e || "fetch_failed") };
  } finally { clearTimeout(t); }
}

/* ── الانتقال (صافية): الحالة الجاية + هل نبعت تنبيه ── */
export function nextState(prev, res, nowMs, { cooldownMs = REOPEN_COOLDOWN_MS, alerting = true } = {}) {
  const p = prev && typeof prev === "object" ? prev : {};
  const at = new Date(nowMs).toISOString();
  const changed = p.state !== res.state;
  const known = res.state !== "unknown";
  const reopened = res.state === "up" && p.lastKnown === "suspended";
  const lastAlertMs = Date.parse(p.lastAlertAt || "");
  const coolingDown = reopened && Number.isFinite(lastAlertMs) && nowMs - lastAlertMs < cooldownMs;
  const pending = Number(p.alertPending) || 0;
  const retry = !reopened && res.state === "up" && pending > 0 && pending < MAX_ALERT_ATTEMPTS;
  const alert = alerting && ((reopened && !coolingDown) || retry);
  const next = {
    ...p,
    state: res.state, label: res.label, httpStatus: res.httpStatus ?? null, message: res.message ?? null,
    since: changed || !p.since ? at : p.since,
    lastCheck: at, checks: (Number(p.checks) || 0) + 1,
    lastKnown: known ? res.state : (p.lastKnown || null),
    knownSince: known ? (p.lastKnown === res.state && p.knownSince ? p.knownSince : at) : (p.knownSince || null),
    alertPending: res.state === "up" ? pending : 0,
    lastAlertAt: alert ? at : (p.lastAlertAt || null),
    log: changed
      ? [{ at, from: p.state || null, to: res.state, httpStatus: res.httpStatus ?? null, label: res.label }, ...(Array.isArray(p.log) ? p.log : [])].slice(0, 30)
      : (Array.isArray(p.log) ? p.log : []),
  };
  if (reopened && coolingDown) next.lastSuppressed = { at, why: "cooldown" };
  return { next, changed, reopened, coolingDown, retry, alert };
}

/* ── نصوص التنبيه ── */
export function smsText(nowMs, autoDispatchOn) {
  return fitOneSms(`فريش كاتس: حساب لاجلك رجع شغال ${riyadhHM(nowMs)}. الطلب الآلي ${autoDispatchOn ? "شغال" : "لسه مقفول"}`);
}
export function waText(nowMs, prev, autoDispatchOn) {
  const was = prev && prev.knownSince ? ` (كان موقوف من ${riyadhDayHM(prev.knownSince)})` : "";
  return `✅ حساب لاجلك رجع شغّال — فحص القراءة GET /shops رجّع 200 الساعة ${riyadhHM(nowMs)}${was}.\n`
    + (autoDispatchOn ? "الطلب الآلي للمندوب شغّال."
      : "الطلب الآلي للمندوب لسه مقفول — تشغيله قرارك من اللوحة «التوصيل والمندوبين» (مفتاح «طلب مندوب تلقائي»).");
}

/* ── كارت «حالة النظام» (صافية): {status, line, fix, last, detail} ── */
export function ljHealthOf(v, nowMs = Date.now()) {
  const cfg = (v && v.cfg) || LJ_WATCH_DEFAULTS;
  const s = (v && v.state) || {};
  const detail = { state: s.state || null, label: s.label || null, since: s.since || null, lastCheck: s.lastCheck || null,
    httpStatus: s.httpStatus ?? null, message: s.message || null, lastKnown: s.lastKnown || null, everyMin: cfg.everyMin, enabled: cfg.enabled };
  if (!cfg.enabled) return { status: "unknown", line: "مراقبة حساب لاجلك مقفولة (من «التوصيل والمندوبين»).", fix: null, last: s.lastCheck || null, detail };
  if (!s.lastCheck) return { status: "unknown", line: `لسه مافيش فحص — آخر حالة معروفة: ${STATE_AR[s.lastKnown] || "—"}. أول فحص بعد دقيقتين من التشغيل.`, fix: null, last: null, detail };
  const since = riyadhDayHM(s.since);
  const ageMin = Math.round((nowMs - Date.parse(s.lastCheck)) / 60_000);
  const age = ageMin < 1 ? "من أقل من دقيقة" : `من ${ageMin} د`;
  const stale = ageMin > cfg.everyMin * 3 + 2;
  const auto = v && v.autoDispatch;
  if (s.state === "suspended") {
    return { status: "bad", last: s.lastCheck, detail,
      line: `موقوف من لاجلك${since ? ` من ${since}` : ""} — آخر فحص ${age} (HTTP ${s.httpStatus}).${stale ? " الفحص متأخر." : ""}`,
      fix: `الفريق يستعمل «مندوب خارجي» من البوابة${auto ? " — والطلب الآلي لسه شغّال: اقفله من «التوصيل والمندوبين»" : " والطلب الآلي يفضل مقفول"}. أول ما الحساب يرجع هتوصلك SMS.` };
  }
  if (s.state === "up") {
    return { status: stale ? "warn" : "good", last: s.lastCheck, detail,
      line: `شغّال${since ? ` من ${since}` : ""} — آخر فحص ${age} (GET /shops = 200).${auto ? "" : " الطلب الآلي مقفول."}${stale ? " الفحص متأخر." : ""}`,
      fix: auto ? null : "الحساب شغّال — تشغيل «طلب مندوب تلقائي» قرارك من «التوصيل والمندوبين»." };
  }
  return { status: "warn", last: s.lastCheck, detail,
    line: `${s.label || "مش عارفين"}${s.message ? ` — ${String(s.message).slice(0, 80)}` : ""} · آخر حالة معروفة: ${STATE_AR[s.lastKnown] || "—"} · آخر فحص ${age}.`,
    fix: "لو فضلت كده أكتر من ساعة: افحص من «التوصيل والمندوبين» أو كلّم لاجلك." };
}
/* سطر واحد فوق مفتاح المراقبة في «التوصيل والمندوبين» */
export function controlLine(v, nowMs = Date.now()) {
  const h = ljHealthOf(v, nowMs);
  const dot = { good: "🟢", warn: "🟡", bad: "🔴", unknown: "⚪" }[h.status] || "⚪";
  return `${dot} الحالة دلوقتي: ${h.line}`;
}

/* ═══ التشغيل ═══════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetch || ((...a) => globalThis.fetch(...a));
  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : null;
  const wa = () => { const w = typeof deps.wa === "function" ? deps.wa() : deps.wa; return w && typeof w.sendFreeform === "function" ? w : null; };
  const log = deps.log || console.error;
  const info = deps.info || console.log;
  const J = (v) => JSON.stringify(v);

  const schemaReady = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS lj_watch_state (
        id INT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, ver BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ)`);
    await pool.query("INSERT INTO lj_watch_state(id, data, ver, updated_at) VALUES (1, $1::jsonb, 0, NULL) ON CONFLICT (id) DO NOTHING", [J(SEED)]);
  })().catch((e) => { log("[lj-watch] schema:", e.message); });

  async function readState() {
    await schemaReady;
    const r = await pool.query("SELECT data, ver::text AS ver FROM lj_watch_state WHERE id=1");
    const row = (r.rows || [])[0] || {};
    return { data: row.data && typeof row.data === "object" ? row.data : {}, ver: String(row.ver ?? "0"), exists: Boolean((r.rows || [])[0]) };
  }

  let running = null;
  async function check({ reason = "timer", force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const s = (await getSettingsData().catch(() => ({}))) || {};
      const cfg = ljWatchCfg(s);
      if (!cfg.enabled && !force) return { ok: true, skipped: "disabled" };
      const st = await readState();
      const res = classify(await probe({ fetchImpl }));
      const t = now();
      const { next, changed, reopened, coolingDown, alert } = nextState(st.data, res, t, { alerting: cfg.enabled });
      next.reason = reason;
      const autoOn = ((s.shop || {}).autoDispatch) !== false;
      const rec = recipientsOf(s, { phones: [] });
      /* الحجز: حاوية تانية كتبت بعد ما قرينا ⇒ مانبعتش (هي بعتت أو هتبعت) */
      const claim = st.exists
        ? await pool.query("UPDATE lj_watch_state SET data=$1::jsonb, ver=ver+1, updated_at=NOW() WHERE id=1 AND ver=$2::bigint RETURNING id", [J(next), st.ver])
        : await pool.query("INSERT INTO lj_watch_state(id, data, ver, updated_at) VALUES (1, $1::jsonb, 1, NOW()) ON CONFLICT (id) DO NOTHING RETURNING id", [J(next)]);
      if (!claim.rowCount) return { ok: true, skipped: "claimed_elsewhere", state: res.state };
      if (changed) info(`[lj-watch] لاجلك: ${st.data.label || st.data.state || "—"} ⇒ ${res.label} (HTTP ${res.httpStatus ?? "—"}, ${reason})`);
      if (reopened && coolingDown) info("[lj-watch] رجع شغّال تاني جوّه ٦ ساعات من آخر تنبيه — مفيش SMS (ضد العاصفة)");
      if (!alert) return { ok: true, state: res.state, changed, alerted: false };

      /* ── التنبيه ── */
      const entry = { at: new Date(t).toISOString(), to: rec.phones.map(mask), source: rec.source, sms: 0, failed: 0, wa: 0, waSkipped: [] };
      if (!rec.phones.length) entry.skipped = "no_phones";
      else if (!sendSms) entry.skipped = "no_sender";
      if (rec.phones.length && sendSms) {
        const body = smsText(t, autoOn);
        for (const p of rec.phones) {
          try { const r = await sendSms({ phoneNorm: p, body, kind: "staff", ref: "lj-watch reopened" }); if (!(r && r.suppressed)) entry.sms++; }
          catch (e) { entry.failed++; log(`[lj-watch] sms → ${mask(p)} failed: ${e.message}`); }
        }
      }
      const w = wa();
      if (rec.phones.length && w) {
        const body = waText(t, st.data, autoOn);
        for (const p of rec.phones) {
          try {
            /* رسالة حرة: sendFreeform بيرفضها لوحده لو نافذة الـ٢٤ ساعة مقفولة (window_closed) — مفيش قالب مدفوع هنا */
            const r = await w.sendFreeform({ phoneNorm: p, payload: { type: "text", text: { body, preview_url: false } }, source: "health", preview: body });
            if (r && r.ok) entry.wa++; else entry.waSkipped.push(String((r && (r.skipped || r.error)) || "failed").slice(0, 40));
          } catch { entry.waSkipped.push("error"); }
        }
        entry.waSkipped = [...new Set(entry.waSkipped)];
      }
      /* وصل لحد؟ لو لأ والأرقام موجودة ⇒ نعيد مع الفحص الجاي (٣ مرات بالكتير) ونرجّع وقت آخر تنبيه زي ما كان */
      const delivered = entry.sms > 0 || entry.wa > 0;
      const patch = { lastAlert: entry, alertPending: 0 };
      if (!delivered && rec.phones.length && sendSms) {
        patch.alertPending = (Number(st.data.alertPending) || 0) + 1;
        patch.lastAlertAt = st.data.lastAlertAt || null;
      }
      info(`[lj-watch] تنبيه «رجع»: sms=${entry.sms} wa=${entry.wa}${entry.skipped ? ` (${entry.skipped})` : ""}${patch.alertPending ? ` — هنعيد (محاولة ${patch.alertPending})` : ""}`);
      await pool.query("UPDATE lj_watch_state SET data = data || $1::jsonb WHERE id=1", [J(patch)]).catch((e) => log("[lj-watch] save alert:", e.message));
      return { ok: true, state: res.state, changed, alerted: true, sms: entry.sms, wa: entry.wa };
    })().catch((e) => { log("[lj-watch] check:", e.message); return { ok: false, error: String(e.message || e).slice(0, 200) }; })
      .finally(() => { running = null; });
    return running;
  }

  async function view() {
    const s = (await getSettingsData().catch(() => ({}))) || {};
    const cfg = ljWatchCfg(s);
    const st = await readState();
    const rec = recipientsOf(s, { phones: [] });
    const d = st.data || {};
    return {
      ok: true, cfg, defaults: LJ_WATCH_DEFAULTS, limits: LJ_WATCH_LIMITS,
      state: { state: d.state || null, label: d.label || null, since: d.since || null, lastCheck: d.lastCheck || null,
        httpStatus: d.httpStatus ?? null, message: d.message || null, lastKnown: d.lastKnown || null, knownSince: d.knownSince || null,
        checks: Number(d.checks) || 0, seeded: d.seeded || null },
      autoDispatch: ((s.shop || {}).autoDispatch) !== false,
      recipients: { phones: rec.phones.map(mask), source: rec.source },
      lastAlert: d.lastAlert || null, lastAlertAt: d.lastAlertAt || null,
      log: (Array.isArray(d.log) ? d.log : []).slice(0, 10),
      probe: "GET /shops (قراءة بس)",
    };
  }

  app.get("/api/delivery/leajlak/account", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { const v = await view(); return c.json({ ...v, health: ljHealthOf(v, now()) }); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });
  let lastManual = 0;
  app.post("/api/delivery/leajlak/account/check", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (now() - lastManual < MANUAL_GAP_MS) return c.json({ ok: false, error: "too_soon", message: "استنى ٣٠ ثانية بين كل فحص والتاني" });
    lastManual = now();
    const r = await check({ reason: "manual", force: true });
    if (!r.ok) return c.json(r);
    try { const v = await view(); return c.json({ ...v, health: ljHealthOf(v, now()), result: r }); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  /* الجدولة: نبضة كل دقيقة، والفحص نفسه لما يعدّي everyMin من آخر فحص **في الداتابيز** (فإعادة التشغيل أو حاويتين وقت النشر
     مابيكترّوش الأسئلة للاجلك). أول نبضة بعد دقيقتين من التشغيل. */
  if (deps.schedule !== false) {
    const tick = async () => {
      try {
        const cfg = ljWatchCfg((await getSettingsData().catch(() => ({}))) || {});
        if (!cfg.enabled) return;
        const st = await readState();
        const last = Date.parse(st.data.lastCheck || "");
        if (Number.isFinite(last) && now() - last < cfg.everyMin * 60_000 - 5_000) return;
        await check({ reason: "timer" });
      } catch (e) { log("[lj-watch] tick:", e.message); }
    };
    const t0 = setTimeout(() => { tick(); const iv = setInterval(tick, 60_000); if (iv.unref) iv.unref(); }, deps.bootDelayMs ?? 120_000);
    if (t0.unref) t0.unref();
  }
  return { check, view, readState };
}
