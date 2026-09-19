/* ═══════════════════════════════════════════════════════════════════════════
   TTCONNECT — ربط تيك توك (Marketing API) من اللوحة، دايم ومن غير Coolify (١٩/٩)

   المالك بيعمل الربط بنفسه من «حالة النظام»:
     ١. يلصق App Secret بتاع تطبيق «FreshCuts Ads» (بيتخزّن مشفّر، وماينفعش يرجع).
     ٢. «اربط الحساب» → https://business-api.tiktok.com/portal/auth?app_id&state&redirect_uri
        الـstate عشوائي ومتخزّن (fctt_…، صالح ٣٠ دقيقة، مرة واحدة).
     ٣. تيك توك بترجّع على الـredirect المسجّل (https://freshcuts.sa/?auth_code&code&state)
        → المتجر شايف state بيبدأ بـ fctt_ فبيحوّل فوراً على اللوحة
        (#store/settings/system?tt_code&tt_state) → اللوحة بتنادي /exchange.
     ٤. /exchange → oauth2/access_token → access_token + advertiser_ids + scope،
        بنخزّنهم (التوكن مشفّر) وبنجرّب كل صلاحية فعلياً (advertiser/campaigns/
        reporting/pixels/audiences) ونرجّع أنهي شغّالة.

   التشفير: AES-256-GCM، المفتاح = sha256("fc-secrets-v1|" + (SECRETS_KEY || ADMIN_TOKEN))
   — نفس نمط «X_SECRET || ADMIN_TOKEN» اللي في customer360/portal-core. بنخزّن
   بصمة المفتاح؛ لو المفتاح اتغيّر القيم بتبان «محتاجة تتلصق تاني» بدل ما تكسر.
   مفيش endpoint بيرجّع السر أو التوكن — بس set + آخر ٤ حروف.

   ttMktToken() (sync) = توكن الداتابيز ← TIKTOK_MARKETING_TOKEN ← TIKTOK_ACCESS_TOKEN.
   ده للإدارة/التقارير/الجماهير بس. event/track (funnel.js + ads.js) فاضل على
   TIKTOK_ACCESS_TOKEN (توكن الأحداث) — ماتلمسوش.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

export const TT_API = "https://business-api.tiktok.com/open_api/v1.3";
export const STATE_PREFIX = "fctt_";
const env = (k) => (process.env[k] || "").trim();
export const ttAppId = () => env("TIKTOK_APP_ID") || "7673553737050898452";
const DEFAULT_REDIRECT = "https://freshcuts.sa/";

/* ── الكاش (sync للاستخدام في كل الموديولات) ─────────────────────────── */
const cache = { token: "", advertiserId: "", loadedAt: 0 };
export function ttMktToken() {
  return cache.token || env("TIKTOK_MARKETING_TOKEN") || env("TIKTOK_ACCESS_TOKEN");
}
export function ttMktTokenSource() {
  return cache.token ? "db" : env("TIKTOK_MARKETING_TOKEN") ? "env:TIKTOK_MARKETING_TOKEN" : env("TIKTOK_ACCESS_TOKEN") ? "env:TIKTOK_ACCESS_TOKEN (events)" : "none";
}
/** المعلن: متغيّر البيئة لو موجود (هو الأساس)، وإلا اللي رجع من الربط. */
export function ttAdvertiserId() { return env("TIKTOK_ADVERTISER_ID") || cache.advertiserId; }
export function _setCacheForTest(v) { Object.assign(cache, v); }

/* ── التشفير ─────────────────────────────────────────────────────────── */
const keyMaterial = () => env("SECRETS_KEY") || env("ADMIN_TOKEN");
const deriveKey = (m) => crypto.createHash("sha256").update(`fc-secrets-v1|${m}`).digest();
export const keyFingerprint = (m = keyMaterial()) => (m ? crypto.createHash("sha256").update(deriveKey(m)).digest("hex").slice(0, 12) : "");

export function encryptSecret(plain, m = keyMaterial()) {
  if (!m) throw new Error("no server key (SECRETS_KEY/ADMIN_TOKEN)");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", deriveKey(m), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}
export function decryptSecret(blob, m = keyMaterial()) {
  if (!blob || !m) return null;
  const [v, iv, tag, ct] = String(blob).split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", deriveKey(m), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}
const last4 = (s) => (s ? String(s).slice(-4) : null);

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */
export const newState = () => STATE_PREFIX + crypto.randomBytes(16).toString("hex");
export const isOurState = (s) => new RegExp(`^${STATE_PREFIX}[a-f0-9]{32}$`).test(String(s || ""));
export function buildAuthUrl({ appId, state, redirectUri }) {
  const q = new URLSearchParams({ app_id: appId, state, redirect_uri: redirectUri });
  return `https://business-api.tiktok.com/portal/auth?${q.toString()}`;
}
/** نختار المعلن: متغيّر البيئة لو هو من ضمن اللي اتفوّضوا، وإلا أول واحد. */
export function pickAdvertiser(ids, envAdv) {
  const list = (ids || []).map(String);
  if (envAdv && list.includes(String(envAdv))) return { id: String(envAdv), envMatches: true };
  return { id: list[0] || null, envMatches: envAdv ? false : null };
}

/* ── نداءات تيك توك ──────────────────────────────────────────────────── */
async function ttFetch(url, opts = {}, fetchImpl = fetch) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetchImpl(url, { ...opts, signal: ctl.signal });
    const j = await r.json().catch(() => null);
    return { status: r.status, json: j };
  } catch (e) { return { status: 0, json: null, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

export async function exchangeCode({ appId, secret, authCode }, fetchImpl = fetch) {
  const r = await ttFetch(`${TT_API}/oauth2/access_token/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
  }, fetchImpl);
  const d = r.json?.data || {};
  if (r.json?.code !== 0 || !d.access_token) {
    return { ok: false, error: `${r.json?.message || r.error || `HTTP ${r.status}`}${r.json?.code != null ? ` (code ${r.json.code})` : ""}` };
  }
  return { ok: true, accessToken: d.access_token, advertiserIds: (d.advertiser_ids || []).map(String), scope: d.scope || [] };
}

const dayISO = (ms) => new Date(ms).toISOString().slice(0, 10);
/** كل صلاحية بنداء قراءة حقيقي. code 0 = شغّالة. */
export async function checkScopes(token, adv, fetchImpl = fetch) {
  const H = { headers: { "Access-Token": token } };
  const y = dayISO(Date.now() - 864e5);
  const enc = encodeURIComponent;
  const checks = {
    advertiser: `${TT_API}/advertiser/info/?advertiser_ids=${enc(JSON.stringify([adv]))}`,
    campaigns: `${TT_API}/campaign/get/?advertiser_id=${enc(adv)}&page_size=1`,
    reporting: `${TT_API}/report/integrated/get/?advertiser_id=${enc(adv)}&report_type=BASIC&data_level=AUCTION_ADVERTISER&dimensions=${enc(JSON.stringify(["advertiser_id"]))}&metrics=${enc(JSON.stringify(["spend"]))}&start_date=${y}&end_date=${y}`,
    pixels: `${TT_API}/pixel/list/?advertiser_id=${enc(adv)}&page_size=20`,
    audiences: `${TT_API}/dmp/custom_audience/list/?advertiser_id=${enc(adv)}&page_size=1`,
  };
  const out = {};
  await Promise.all(Object.entries(checks).map(async ([k, url]) => {
    const r = await ttFetch(url, H, fetchImpl);
    const code = r.json?.code;
    out[k] = code === 0
      ? { ok: true, ...(k === "advertiser" ? { name: r.json?.data?.list?.[0]?.name || null, status: r.json?.data?.list?.[0]?.status || null } : {}),
          ...(k === "pixels" ? { count: (r.json?.data?.pixels || []).length } : {}) }
      : { ok: false, code: code ?? null, message: String(r.json?.message || r.error || `HTTP ${r.status}`).slice(0, 200) };
  }));
  return out;
}

/* ── الموديول ────────────────────────────────────────────────────────── */
export function register(app, ctx) {
  const { pool, requireAdmin } = ctx;
  let ready = null;
  const ensure = () => (ready ||= pool.query(`CREATE TABLE IF NOT EXISTS tt_connect (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      app_secret_enc TEXT, secret_last4 TEXT, secret_set_at TIMESTAMPTZ,
      access_token_enc TEXT, token_last4 TEXT, key_fp TEXT,
      advertiser_id TEXT, advertiser_ids JSONB, scopes JSONB, scope_check JSONB,
      redirect_uri TEXT, oauth_state TEXT, oauth_state_exp TIMESTAMPTZ,
      connected_at TIMESTAMPTZ, checked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO tt_connect(id) VALUES (1) ON CONFLICT DO NOTHING;`).catch((e) => { ready = null; throw e; }));

  const row = async () => { await ensure(); return (await pool.query("SELECT * FROM tt_connect WHERE id=1")).rows[0] || {}; };

  async function loadCache() {
    try {
      const r = await row();
      cache.token = decryptSecret(r.access_token_enc) || "";
      cache.advertiserId = r.advertiser_id || "";
      cache.loadedAt = Date.now();
    } catch (e) { console.error("[ttconnect] load", e.message); }
  }
  loadCache();
  const iv = setInterval(loadCache, 10 * 60_000); if (iv.unref) iv.unref();

  const bearer = (c) => (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  /** أي أدمن يشوف الحالة؛ الكتابة (السر/الربط/الفصل) للمالك بس. */
  async function requireOwner(c) {
    const err = await requireAdmin(c); if (err) return err;
    const tok = bearer(c);
    if (tok.startsWith("cms:")) {
      const h = crypto.createHash("sha256").update(tok).digest("hex");
      const r = await pool.query(`SELECT u.role FROM cms_sessions s JOIN cms_users u ON u.id=s.user_id WHERE s.token_hash=$1`, [h]).catch(() => ({ rows: [] }));
      if (r.rows[0]?.role !== "owner") return c.json({ ok: false, error: "owner_only", message: "ربط تيك توك للمالك بس" }, 403);
    }
    return null;
  }
  const redirectOf = (r) => env("TIKTOK_REDIRECT_URI") || r.redirect_uri || DEFAULT_REDIRECT;

  function publicStatus(r) {
    const fp = keyFingerprint();
    const keyOk = !r.key_fp || r.key_fp === fp;
    return {
      ok: true,
      appId: ttAppId(),
      redirectUri: redirectOf(r),
      serverKey: Boolean(keyMaterial()),
      keyChanged: !keyOk,
      secret: { set: Boolean(r.app_secret_enc), readable: Boolean(r.app_secret_enc) && keyOk && decryptSecret(r.app_secret_enc) != null, last4: r.secret_last4 || null, setAt: r.secret_set_at || null },
      token: { set: Boolean(r.access_token_enc), readable: Boolean(cache.token), last4: r.token_last4 || null, source: ttMktTokenSource(), connectedAt: r.connected_at || null },
      advertiserId: ttAdvertiserId() || null,
      advertiserIdDb: r.advertiser_id || null,
      advertiserIdEnv: env("TIKTOK_ADVERTISER_ID") || null,
      advertiserIds: r.advertiser_ids || [],
      scopes: r.scopes || [],
      scopeCheck: r.scope_check || null,
      checkedAt: r.checked_at || null,
      eventsToken: Boolean(env("TIKTOK_ACCESS_TOKEN")),
    };
  }

  app.get("/api/tiktok/connect/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(publicStatus(await row())); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 500); }
  });

  app.post("/api/tiktok/connect/secret", async (c) => {
    const err = await requireOwner(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const secret = String(b.secret || "").trim();
    const redirectUri = b.redirectUri != null ? String(b.redirectUri).trim() : null;
    if (redirectUri && !/^https:\/\/[^\s]+$/.test(redirectUri)) return c.json({ ok: false, error: "redirect لازم يبدأ بـ https://" }, 400);
    if (!secret && !redirectUri) return c.json({ ok: false, error: "الصق الـApp Secret" }, 400);
    if (secret && (secret.length < 16 || secret.length > 200 || /\s/.test(secret))) return c.json({ ok: false, error: "شكل السر مش مظبوط — انسخه تاني من بوابة تيك توك" }, 400);
    if (secret && !keyMaterial()) return c.json({ ok: false, error: "مفيش مفتاح تشفير على السيرفر (SECRETS_KEY/ADMIN_TOKEN)" }, 500);
    await ensure();
    if (secret) {
      await pool.query(`UPDATE tt_connect SET app_secret_enc=$1, secret_last4=$2, secret_set_at=now(), key_fp=$3, updated_at=now() WHERE id=1`,
        [encryptSecret(secret), last4(secret), keyFingerprint()]);
    }
    if (redirectUri) await pool.query(`UPDATE tt_connect SET redirect_uri=$1, updated_at=now() WHERE id=1`, [redirectUri]);
    return c.json(publicStatus(await row()));
  });

  app.get("/api/tiktok/connect/url", async (c) => {
    const err = await requireOwner(c); if (err) return err;
    const r = await row();
    if (!r.app_secret_enc || decryptSecret(r.app_secret_enc) == null) return c.json({ ok: false, error: "الصق الـApp Secret الأول" }, 400);
    const state = newState();
    await pool.query(`UPDATE tt_connect SET oauth_state=$1, oauth_state_exp=now() + interval '30 minutes' WHERE id=1`, [state]);
    return c.json({ ok: true, url: buildAuthUrl({ appId: ttAppId(), state, redirectUri: redirectOf(r) }), expiresInMin: 30 });
  });

  async function verifyAndStore(token, adv) {
    const check = adv ? await checkScopes(token, adv) : { advertiser: { ok: false, message: "مفيش معلن" } };
    await pool.query(`UPDATE tt_connect SET scope_check=$1, checked_at=now() WHERE id=1`, [JSON.stringify(check)]);
    return check;
  }

  app.post("/api/tiktok/connect/exchange", async (c) => {
    const err = await requireOwner(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const authCode = String(b.auth_code || b.code || "").trim(), state = String(b.state || "").trim();
    if (!authCode || authCode.length > 512) return c.json({ ok: false, error: "auth_code ناقص" }, 400);
    if (!isOurState(state)) return c.json({ ok: false, error: "state مش بتاعنا" }, 400);
    // الـstate مرة واحدة: بنمسحه ذرّياً ولو مكانش هو الحالي أو انتهى بنرفض.
    const hit = await pool.query(`UPDATE tt_connect SET oauth_state=NULL, oauth_state_exp=NULL
        WHERE id=1 AND oauth_state=$1 AND oauth_state_exp > now() RETURNING app_secret_enc`, [state]);
    if (!hit.rowCount) return c.json({ ok: false, error: "الرابط انتهى أو اتستخدم — دوس «اربط الحساب» تاني" }, 400);
    const secret = decryptSecret(hit.rows[0].app_secret_enc);
    if (!secret) return c.json({ ok: false, error: "الـApp Secret محتاج يتلصق تاني" }, 400);
    const ex = await exchangeCode({ appId: ttAppId(), secret, authCode });
    if (!ex.ok) return c.json({ ok: false, error: `تيك توك رفضت: ${ex.error}` }, 502);
    const pick = pickAdvertiser(ex.advertiserIds, env("TIKTOK_ADVERTISER_ID"));
    await pool.query(`UPDATE tt_connect SET access_token_enc=$1, token_last4=$2, key_fp=$3, advertiser_id=$4, advertiser_ids=$5, scopes=$6,
        connected_at=now(), updated_at=now() WHERE id=1`,
      [encryptSecret(ex.accessToken), last4(ex.accessToken), keyFingerprint(), pick.id, JSON.stringify(ex.advertiserIds), JSON.stringify(ex.scope)]);
    cache.token = ex.accessToken; cache.advertiserId = pick.id || "";
    const check = await verifyAndStore(ex.accessToken, ttAdvertiserId() || pick.id);
    return c.json({ ...publicStatus(await row()), connected: true, envAdvertiserMatches: pick.envMatches, scopeCheck: check });
  });

  app.post("/api/tiktok/connect/verify", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await loadCache();
    const tok = ttMktToken(), adv = ttAdvertiserId();
    if (!tok || !adv) return c.json({ ok: false, error: "مفيش توكن أو معلن" }, 400);
    await verifyAndStore(tok, adv);
    return c.json(publicStatus(await row()));
  });

  app.post("/api/tiktok/connect/disconnect", async (c) => {
    const err = await requireOwner(c); if (err) return err;
    await ensure();
    await pool.query(`UPDATE tt_connect SET access_token_enc=NULL, token_last4=NULL, scope_check=NULL, connected_at=NULL, updated_at=now() WHERE id=1`);
    cache.token = "";
    return c.json(publicStatus(await row()));
  });

  return { loadCache, status: async () => publicStatus(await row()) };
}
