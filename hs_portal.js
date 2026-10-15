/* ═══════════════════════════════════════════════════════════════════════════
   HS PORTAL SESSION — دخول بوابة شركاء هنقرستيشن للعروض (٢٠٢٦-١٠-١٤)

   العروض في هنقرستيشن على vfd-offer-api.eu.prd.portal.restaurant، وده مابيقبلش
   توكن vendor-api (hs_control.js) — محتاج توكن بوابة الشركاء نفسها. دخول
   البوابة بكود على الإيميل، فالسيرفر مايقدرش يدخل لوحده. اللي بيحصل:
     • عمر دخل بيوزر الـAPI (hestoriamarketing) في نافذة خفية ونسخ من
       localStorage['persist:root'].authentication: userId, refreshToken,
       deviceToken, deviceUuid ← Coolify env HS_PORTAL_SESSION (JSON).
     • التجديد: POST <auth>/token-refresh {refresh_token, device_token}
       (بيئة stg بتستخدم /refresh) بهيدرز X-Global-Entity-Id / X-User-Id /
       X-RPS-Device — بيرجّع access_token + refresh_token **جديد** (بيتلف)،
       فلازم يتحفظ في الداتابيز فوراً (hs_portal_session) وإلا الجلسة تموت.
     • لو عمر لصق جلسة جديدة في الـenv، بصمتها بتتغيّر فبنبدأ منها.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const PLATFORM = process.env.HS_GLOBAL_ENTITY || "HS_SA";
const OFFERS = (process.env.HS_OFFERS_BASE || "https://vfd-offer-api.eu.prd.portal.restaurant/v1").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
/* أماكن التجديد بالترتيب — اللي ينجح بيتحفظ ويتجرّب الأول بعد كده. */
const REFRESH_CANDIDATES = [
  "https://bff-api.eu.prd.portal.restaurant/auth/v4/token-refresh",
  "https://partner-auth.eu.prd.portal.restaurant/auth/v5/token-refresh",
  "https://partner-auth.eu.prd.portal.restaurant/auth/v5/refresh",
  "https://bff-api.eu.prd.portal.restaurant/auth/v4/refresh",
];

export function parseEnvSession(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j.refreshToken || !j.deviceToken || !j.userId) return null;
    return { userId: String(j.userId), refreshToken: String(j.refreshToken), deviceToken: String(j.deviceToken), deviceUuid: j.deviceUuid ? String(j.deviceUuid) : null };
  } catch { return null; }
}
export const fingerprint = (s) => crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 16);

/** exp بتاع JWT بالملّي — null لو مش JWT. */
export function jwtExpMs(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

/** شكل رد التجديد: {access_token, refresh_token} أو {keymaker:{…}}. */
export function readRefreshReply(j) {
  const src = j?.keymaker || j || {};
  const access = src.access_token || src.accessToken || null;
  const refresh = src.refresh_token || src.refreshToken || null;
  return access ? { access, refresh } : null;
}

export function register(app, ctx) {
  const { pool, requireAdmin, isOwner } = ctx;
  pool.query(`CREATE TABLE IF NOT EXISTS hs_portal_session (
      id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    .catch((e) => console.error("[hs-portal] table:", e.message));

  const state = { lastError: null, lastRefreshAt: null, refreshUrl: null };
  let mem = null;          // { userId, refreshToken, deviceToken, deviceUuid, access, accessExp, refreshUrl, envFp }
  let refreshing = null;

  async function load() {
    if (mem) return mem;
    const env = parseEnvSession(process.env.HS_PORTAL_SESSION);
    const envFp = env ? fingerprint(process.env.HS_PORTAL_SESSION) : null;
    const r = await pool.query("SELECT data FROM hs_portal_session WHERE id=1").catch(() => ({ rows: [] }));
    const db = r.rows[0]?.data || null;
    // جلسة جديدة اتلصقت في الـenv؟ نبدأ منها. غير كده الداتابيز (فيها آخر توكن اتلف).
    if (db && (!envFp || db.envFp === envFp)) mem = db;
    else if (env) mem = { ...env, access: null, accessExp: null, refreshUrl: null, envFp };
    return mem;
  }
  async function save() {
    await pool.query(`INSERT INTO hs_portal_session(id, data, updated_at) VALUES (1,$1,NOW())
      ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=NOW()`, [JSON.stringify(mem)]);
  }
  const headers = (extra = {}) => ({
    "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json",
    Origin: "https://partner-app.hungerstation.com", Referer: "https://partner-app.hungerstation.com/",
    "X-Global-Entity-Id": PLATFORM, "X-User-Id": mem?.userId || "", ...(mem?.deviceUuid ? { "X-RPS-Device": mem.deviceUuid } : {}), ...extra,
  });

  async function doRefresh() {
    await load();
    if (!mem) throw new Error("مفيش جلسة لبوابة هنقرستيشن — حط HS_PORTAL_SESSION في Coolify");
    const urls = [...new Set([mem.refreshUrl, ...REFRESH_CANDIDATES].filter(Boolean))];
    const tried = [];
    for (const url of urls) {
      let res, text;
      try {
        res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: mem.refreshToken, device_token: mem.deviceToken }) });
        text = await res.text();
      } catch (e) { tried.push(`${url} → ${e.message}`); continue; }
      let j = null; try { j = JSON.parse(text); } catch { /* */ }
      const got = res.ok ? readRefreshReply(j) : null;
      if (got) {
        mem = { ...mem, access: got.access, accessExp: jwtExpMs(got.access), refreshToken: got.refresh || mem.refreshToken, refreshUrl: url };
        await save();           // التوكن بيتلف — لازم يتحفظ قبل أي حاجة تانية
        state.lastRefreshAt = new Date().toISOString(); state.refreshUrl = url; state.lastError = null;
        return mem.access;
      }
      tried.push(`${url} → HTTP ${res.status} ${text.slice(0, 120)}`);
      // 401/400 على مكان صح = التوكن نفسه مرفوض — مانكمّلش نحرق محاولات
      if ([400, 401, 403].includes(res.status) && /token|refresh|unauthor|invalid|expired/i.test(text) && !/not found|no route/i.test(text)) break;
    }
    state.lastError = tried.join(" | ");
    throw new Error(`تعذر تجديد دخول بوابة هنقرستيشن: ${tried[tried.length - 1] || "مفيش رد"}`);
  }
  async function accessToken(force = false) {
    await load();
    if (!force && mem?.access && mem.accessExp && mem.accessExp - Date.now() > 120_000) return mem.access;
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** نداء لخدمة العروض بتوكن البوابة — مع تجديد مرة لو رجع 401. */
  async function offers(path, { method = "GET", body } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await accessToken(attempt > 0);
      const res = await fetch(OFFERS + path, { method, headers: headers({ Authorization: `Bearer ${tok}` }), body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      if (res.status === 401 && attempt === 0) continue;
      let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* */ }
      if (!res.ok) { const e = new Error(`عروض هنقرستيشن (HTTP ${res.status}): ${text.slice(0, 200)}`); e.status = res.status; e.body = j; throw e; }
      return j ?? text;
    }
  }

  /* حالة الربط — للشاشة وللتشخيص */
  app.get("/api/hs/portal/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await load().catch(() => null);
    return c.json({ ok: true, hasSession: !!mem, userId: mem?.userId || null, refreshUrl: mem?.refreshUrl || null,
      accessValidFor: mem?.accessExp ? Math.round((mem.accessExp - Date.now()) / 1000) : null, ...state });
  });

  /* تشخيص للمالك بس: GET/POST على خدمة العروض بنفس الدخول — عشان نكتشف
     باقي المسارات من غير نشر كل مرة. مقفول على vfd-offer-api و/global-entity/HS_SA. */
  app.post("/api/hs/portal/probe", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const path = String(b.path || "");
    if (!path.startsWith(`/global-entity/${PLATFORM}/`)) return c.json({ ok: false, error: "المسار لازم يبدأ بـ/global-entity/HS_SA/" });
    const method = ["GET", "POST"].includes(String(b.method || "GET").toUpperCase()) ? String(b.method || "GET").toUpperCase() : "GET";
    if (method === "POST" && !/\/(deals\/search|deal-templates|menu-products)/.test(path)) return c.json({ ok: false, error: "POST مسموح للبحث بس" });
    try { return c.json({ ok: true, data: await offers(path, { method, body: b.body }) }); }
    catch (e) { return c.json({ ok: false, error: e.message, status: e.status || null, body: e.body || null }); }
  });

  /* إعادة ربط من غير نشر: عمر بيلصق جلسة البوابة (نفس شكل HS_PORTAL_SESSION) من
     صفحة هنقرستيشن بعد ما سجّل دخوله بنفسه. بنكتبها في الداتابيز وبنجرّب توكن
     وصول على طول. envFp = بصمة الـenv الحالي عشان load() تفضّل الصف ده. */
  async function setSession(raw) {
    const parsed = parseEnvSession(typeof raw === "string" ? raw : JSON.stringify(raw || {}));
    if (!parsed) return { ok: false, error: "الجلسة لازم تحتوي userId و refreshToken و deviceToken" };
    mem = { ...parsed, access: null, accessExp: null, refreshUrl: null, envFp: fingerprint(process.env.HS_PORTAL_SESSION || "") };
    await save();
    try { await accessToken(true); state.lastError = null; return { ok: true, accessValidFor: mem.accessExp ? Math.round((mem.accessExp - Date.now()) / 1000) : null }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  console.log(`[hs-portal] ready (${parseEnvSession(process.env.HS_PORTAL_SESSION) ? "env session present" : "no env session"})`);
  return { offers, accessToken, load: () => load(), setSession };
}
