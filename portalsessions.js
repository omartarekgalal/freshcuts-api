/* ═══════════════════════════════════════════════════════════════════════════
   جلسات بوابات التوصيل — تجديد استباقي + تنبيه + إعادة ربط بضغطة (٢٠٢٦-١٠-١٥)

   عمر (١٥/١٠): «عايزين نشوف حل دايم لموضوع بوابات هنجر ونينجا ده».

   المشكلة اللي بتتكرر:
     • هنقرستيشن (بوابة الشركاء، للعروض): توكن الوصول RS256 عمره ٤ ساعات بس،
       وبيتجدّد كسول (بس لما حد يفتح العروض). بين لفّة عروض ولفّة ممكن تعدّي
       أيام، فالتوكن بيموت في صمت ومانعرفش غير لما عمر يحاول يطلّع عرض.
     • نينجا: دخولها MFA (كود على موبايل/إيميل عمر)، فالسيرفر مايقدرش يدخل.
       بنشيل jwt (٢٤ ساعة) + refresh (٧ أيام). التجديد بيدوّر الـrefresh، بس
       القديم ما كانش بيتحفظ — فساعة الـ٧ أيام ما كانتش بتترجع، والجلسة ماتت
       يوم ٦/٨ وفضلت ميتة. (ninja.js دلوقتي بيحفظ الدوران — الملف ده بيجدّد
       استباقي قبل ما الـ٧ أيام يخلصوا عشان ماتموتش تاني.)

   اللي بيعمله الملف (كله قراءة/تجديد — مفيش أي كتابة على منصة، ولا خطر على
   حساب التاجر):
     ١) مسح دوري (كل ٣٠ دقيقة افتراضي): هنقرستيشن — جدّد توكن الوصول قبل ما
        يخلص بساعة ونص (التجديد بيدوّر الـrefresh كمان فبيفضل طازة). نينجا —
        جدّد لو فاضل على الـjwt أقل من ٦ ساعات أو عدّى على آخر تجديد أكتر من
        ٤٨ ساعة (جوّه نافذة الـ٧ أيام بأمان).
     ٢) تنبيه للمالك (مرة كل ٦ ساعات بالكتير) لو جلسة محتاجة إعادة ربط بإيد
        إنسان (التجديد فشل / الـrefresh نفسه مات) — عشان ماحدش يكتشفها بالصدفة.
     ٣) إعادة ربط بضغطة من غير نشر: endpoints (للمالك بس) بتاخد الجلسة اللي
        عمر لصقها من صفحة المنصة نفسها بعد ما سجّل دخوله بنفسه، وبتحطها في
        الداتابيز على طول. إحنا مابنلمسش باسوورد ولا كود تحقّق — بناخد التوكن
        اللي صفحة المنصة طلّعته بس.

   جداوله: portal_sessions (نينجا — jwt/refresh/meta). هنقرستيشن ليها جدولها
   (hs_portal_session) وإحنا بنكتب فيه عن طريق hsPortal.setSession.
═══════════════════════════════════════════════════════════════════════════ */

const MIN = 60_000;
const H = 60 * MIN;

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

/** حالة جلسة واحدة للعرض والتنبيه. صافية.
 *  session: { jwt?, refresh?, accessExp?, refreshExp?, lastRefreshAt?, lastError?, hasSession }
 *  ⇒ { tone: good|warn|bad|unknown, state, accessLeftMin, refreshLeftMin, needsReconnect, line } */
export function sessionHealth(platform, session, now = Date.now()) {
  const s = session || {};
  const toMin = (ms) => (ms == null ? null : Math.round((ms - now) / MIN));
  const accessLeftMin = toMin(s.accessExp ?? jwtExpMs(s.jwt));
  const refreshLeftMin = toMin(s.refreshExp ?? jwtExpMs(s.refresh));
  if (!s.hasSession) {
    return { platform, tone: "bad", state: "no_session", accessLeftMin, refreshLeftMin, needsReconnect: true,
      line: "مفيش جلسة محفوظة — محتاجة ربط من صفحة المنصة." };
  }
  // الـrefresh هو اللي بيحيي كل حاجة؛ لو مات (أو التجديد بيرجّع مرفوض) ⇒ لازم إنسان.
  const refreshDead = refreshLeftMin != null && refreshLeftMin <= 0;
  const errRejects = /401|403|unauthor|invalid|expired|refresh|forbidden/i.test(String(s.lastError || ""));
  if (refreshDead || (s.lastError && errRejects)) {
    return { platform, tone: "bad", state: "needs_reconnect", accessLeftMin, refreshLeftMin, needsReconnect: true,
      line: refreshDead ? "صلاحية التجديد انتهت — لازم تسجيل دخول جديد (كود تحقّق)." : `التجديد بيترفض — لازم تسجيل دخول جديد. آخر خطأ: ${String(s.lastError).slice(0, 80)}` };
  }
  // refresh قرّب يخلص (أقل من يوم) ⇒ أصفر: نبّه قبل ما يموت
  if (refreshLeftMin != null && refreshLeftMin < 24 * 60) {
    return { platform, tone: "warn", state: "refresh_soon", accessLeftMin, refreshLeftMin, needsReconnect: false,
      line: `صلاحية التجديد هتخلص خلال ${Math.max(0, Math.round(refreshLeftMin / 60))} ساعة — جدّد الربط قريب.` };
  }
  if (s.lastError) {
    return { platform, tone: "warn", state: "last_error", accessLeftMin, refreshLeftMin, needsReconnect: false,
      line: `شغّالة بس آخر محاولة فيها خطأ: ${String(s.lastError).slice(0, 80)}` };
  }
  return { platform, tone: "good", state: "ok", accessLeftMin, refreshLeftMin, needsReconnect: false,
    line: accessLeftMin != null ? `متصلة — توكن الوصول صالح ${Math.max(0, Math.round(accessLeftMin / 60 * 10) / 10)} ساعة.` : "متصلة." };
}

/* ── التسجيل ─────────────────────────────────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, isOwner } = ctx;
  const hsPortal = deps.hsPortal || (() => null);     // () => { accessToken, load, setSession }
  const ninja = deps.ninja || (() => null);           // () => { refreshNow, setSession, sessionInfo }
  const setNinjaTile = deps.setNinjaTile || (() => {}); // portals.js setNinjaSession (تحديث كارت الحالة الحي)
  const getSettingsData = ctx.getSettingsData || (() => ({}));
  const alert = deps.alert || null;                   // async (platform, line) => void
  const log = deps.log || console;

  pool.query(`CREATE TABLE IF NOT EXISTS portal_sessions (
      platform TEXT PRIMARY KEY, jwt TEXT, refresh TEXT, meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    .catch((e) => log.error("[portal-sessions] table:", e.message));

  const state = {
    hungerstation: { lastError: null, lastRefreshAt: null, lastTickAt: null },
    ninja: { lastError: null, lastRefreshAt: null, lastTickAt: null },
    lastAlertAt: {},            // { platform: ms } — كتم التنبيه ٦ ساعات
  };

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

  async function maybeAlert(platform, line) {
    if (!alert) return;
    const now = Date.now();
    if (now - (state.lastAlertAt[platform] || 0) < 6 * H) return;    // مرة كل ٦ ساعات بالكتير
    state.lastAlertAt[platform] = now;
    try { await alert(platform, line); } catch (e) { log.error(`[portal-sessions] alert ${platform}:`, e.message); }
  }

  /* ── تجديد هنقرستيشن (توكن الوصول ٤ ساعات، التجديد بيدوّر الـrefresh) ── */
  async function tickHungerstation(cfg) {
    const api = hsPortal();
    if (!api || typeof api.accessToken !== "function") return;
    state.hungerstation.lastTickAt = new Date().toISOString();
    let mem = null;
    try { mem = (typeof api.load === "function" ? await api.load() : null) || null; } catch { mem = null; }
    if (!mem) { state.hungerstation.lastError = "مفيش جلسة"; return; }
    const due = renewDue({ expMs: mem.accessExp || jwtExpMs(mem.access), leadMin: cfg.hsLeadMin });
    if (!due) return;
    try {
      await api.accessToken(true);                                   // بيحفظ الـrefresh المدوّر جوّه hs_portal.js
      state.hungerstation.lastRefreshAt = new Date().toISOString();
      state.hungerstation.lastError = null;
    } catch (e) {
      state.hungerstation.lastError = String(e.message || e).slice(0, 160);
      await maybeAlert("hungerstation", `هنقرستيشن: تجديد جلسة العروض فشل — ${state.hungerstation.lastError}. محتاجة إعادة ربط.`);
    }
  }

  /* ── تجديد نينجا (jwt ٢٤ ساعة · refresh ٧ أيام — نجدّد جوّه النافذة بأمان) ── */
  async function tickNinja(cfg) {
    const api = ninja();
    if (!api || typeof api.refreshNow !== "function") return;
    state.ninja.lastTickAt = new Date().toISOString();
    let info = null;
    try { info = (typeof api.sessionInfo === "function" ? await api.sessionInfo() : null) || null; } catch { info = null; }
    if (!info || !info.hasSession) { state.ninja.lastError = info ? null : "مفيش جلسة"; return; }
    const due = renewDue({ expMs: info.jwtExp, lastRefreshAt: info.lastRefreshAt, leadMin: cfg.ninjaLeadMin, maxAgeMin: cfg.ninjaMaxAgeMin });
    if (!due) return;
    try {
      const r = await api.refreshNow();                              // ninja.js بيحفظ الدوران في ninjaStore
      if (r && r.jwt) { setNinjaTile({ jwt: r.jwt, refresh: r.refresh || null }); state.ninja.lastRefreshAt = new Date().toISOString(); state.ninja.lastError = null; }
      else { throw new Error(r && r.error ? r.error : "التجديد ما رجّعش توكن"); }
    } catch (e) {
      state.ninja.lastError = String(e.message || e).slice(0, 160);
      await maybeAlert("ninja", `نينجا: تجديد الجلسة فشل — ${state.ninja.lastError}. لازم تسجيل دخول جديد (كود تحقّق على موبايلك).`);
    }
  }

  function sweepConfig(settings) {
    const p = (settings && settings.portals) || {};
    const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    return {
      enabled: p.renewEnabled !== false,
      sweepMin: n(p.renewSweepMin, 30, 5, 240),
      hsLeadMin: n(p.hsLeadMin, 90, 15, 720),
      ninjaLeadMin: n(p.ninjaLeadMin, 6 * 60, 60, 72 * 60),
      ninjaMaxAgeMin: n(p.ninjaMaxAgeMin, 48 * 60, 6 * 60, 6 * 24 * 60),   // أقل من ٧ أيام دايماً
    };
  }

  let sweeping = false;
  async function sweepOnce() {
    if (sweeping) return;
    sweeping = true;
    try {
      const cfg = sweepConfig(await getSettingsData().catch(() => ({})));
      if (!cfg.enabled) return;
      await tickHungerstation(cfg);
      await tickNinja(cfg);
    } catch (e) { log.error("[portal-sessions] sweep:", e.message); }
    finally { sweeping = false; }
  }

  let timer = null;
  function startSweep() {
    if (timer) return;
    const kick = async () => {
      await sweepOnce();
      const cfg = sweepConfig(await getSettingsData().catch(() => ({})));
      timer = setTimeout(kick, cfg.sweepMin * MIN);
    };
    // أول لفّة بعد دقيقة من الإقلاع (نسيب الموديولات تتسجّل)
    timer = setTimeout(kick, MIN);
  }

  /* ── الحالة المجمّعة للشاشة ── */
  async function statusPayload() {
    const out = { ok: true, at: new Date().toISOString(), sessions: [] };
    // هنقرستيشن
    try {
      const api = hsPortal();
      const mem = api && typeof api.load === "function" ? await api.load() : null;
      const h = sessionHealth("hungerstation", {
        hasSession: !!mem, jwt: mem?.access || null, refresh: mem?.refreshToken || null,
        accessExp: mem?.accessExp || jwtExpMs(mem?.access), refreshExp: jwtExpMs(mem?.refreshToken),
        lastRefreshAt: state.hungerstation.lastRefreshAt, lastError: state.hungerstation.lastError,
      });
      out.sessions.push({ ...h, label: "هنقرستيشن (بوابة الشركاء — العروض)",
        reconnect: { how: "incognito", url: "https://partner-app.hungerstation.com", seedPath: "/api/hs/portal/session" },
        lastTickAt: state.hungerstation.lastTickAt });
    } catch (e) { out.sessions.push({ platform: "hungerstation", tone: "unknown", line: `مقدرناش نقرا: ${String(e.message).slice(0, 100)}` }); }
    // نينجا
    try {
      const api = ninja();
      const info = api && typeof api.sessionInfo === "function" ? await api.sessionInfo() : null;
      const h = sessionHealth("ninja", {
        hasSession: !!(info && info.hasSession), jwt: info?.jwt || null, refresh: info?.refresh || null,
        accessExp: info?.jwtExp, refreshExp: info?.refreshExp,
        lastRefreshAt: state.ninja.lastRefreshAt || info?.lastRefreshAt, lastError: state.ninja.lastError || info?.lastError,
      });
      out.sessions.push({ ...h, label: "نينجا (بوابة المطعم)",
        reconnect: { how: "mfa", url: "https://restaurant-portal.ananinja.com", seedPath: "/api/portals/ninja/session" },
        lastTickAt: state.ninja.lastTickAt });
    } catch (e) { out.sessions.push({ platform: "ninja", tone: "unknown", line: `مقدرناش نقرا: ${String(e.message).slice(0, 100)}` }); }
    out.worst = out.sessions.reduce((w, s) => (["bad", "warn", "good", "unknown"].indexOf(s.tone) < ["bad", "warn", "good", "unknown"].indexOf(w) ? s.tone : w), "good");
    return out;
  }

  app.get("/api/portals/sessions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await statusPayload()); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  /* تجديد فوري بالإيد (للمالك) — للزرار «جرّب التجديد دلوقتي» */
  app.post("/api/portals/sweep", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    await sweepOnce();
    return c.json(await statusPayload());
  });

  /* إعادة ربط نينجا — عمر بيسجّل دخوله بنفسه على بوابة نينجا (الكود على موبايله)
     وبيلصق التوكنين من صفحتها. إحنا مابناخدش باسوورد ولا كود. */
  app.post("/api/portals/ninja/session", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const jwt = typeof b.jwt === "string" ? b.jwt.trim() : "";
    const refresh = typeof b.refresh === "string" ? b.refresh.trim() : "";
    if (jwtExpMs(jwt) == null) return c.json({ ok: false, error: "التوكن (jwt) مش صالح — انسخه من صفحة بوابة نينجا بعد تسجيل الدخول" });
    if (!refresh) return c.json({ ok: false, error: "ناقص refresh token" });
    const rExp = jwtExpMs(refresh);
    if (rExp != null && rExp <= Date.now()) return c.json({ ok: false, error: "صلاحية الـrefresh انتهت بالفعل — سجّل دخول من جديد وانسخ التوكنين الطازة" });
    await ninjaStore.save({ jwt, refresh, meta: { seededAt: new Date().toISOString() } });
    const api = ninja(); if (api && typeof api.setSession === "function") api.setSession({ jwt, refresh });
    setNinjaTile({ jwt, refresh });
    state.ninja.lastError = null; state.ninja.lastRefreshAt = new Date().toISOString();
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
      const res = await api.setSession(raw);     // بيتأكد من الشكل، بيكتب الداتابيز، وبيجرّب توكن وصول
      if (!res || res.ok === false) return c.json({ ok: false, error: (res && res.error) || "الجلسة اللي اتلصقت مش مكتملة" });
      state.hungerstation.lastError = null; state.hungerstation.lastRefreshAt = new Date().toISOString();
      return c.json({ ok: true, saved: true, status: await statusPayload() });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  startSweep();
  log.log && log.log("[portal-sessions] ready (proactive renewal + reconnect)");
  return { ninjaStore, statusPayload, sweepOnce, sessionHealth, stop: () => { if (timer) { clearTimeout(timer); timer = null; } } };
}
