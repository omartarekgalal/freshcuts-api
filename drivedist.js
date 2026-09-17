/* ═══════════════════════════════════════════════════════════════════════════
   مسافة المشوار الحقيقية بالعربية — Google Routes API (computeRoutes)

   عمر (2026-09-18): «الشركة بتحاسبنا على 10 كيلو مسافة بالعربية من المطعم
   لبيت العميل». قبل كده كنا بنقدّر المشوار = هوائي × routeFactor (1.3)، فسقف
   10 كم كان عملياً دايرة هوائية 7.7 كم — وده بيقفل أحياء المشوار الحقيقي
   ليها أقل من 10 كم (شارع مستقيم) ويفتح أحياء مشوارها أطول.

   التكلفة: travelMode DRIVE + TRAFFIC_UNAWARE + field mask distance/duration
   بس = Compute Routes **Essentials** ($5 لكل 1000، أول 10,000 شهرياً مجاناً).
   أي حقل زيادة في الـmask (زي polyline بالمرور) بيقلب الـSKU لـPro — ماتزودش.

   عشان مانتحاسبش على نفس النقطة كل ما العميل يحرّك الدبوس أو يأكد الطلب:
     • كاش في Postgres بالنقطة مقرّبة لـ4 أرقام عشرية (~11 م)، صلاحية 30 يوم.
     • لو الهوائي أصلاً أكبر من السقف، مفيش داعي نسأل جوجل (المشوار ≥ الهوائي).

   قاعدة ذهبية: جوجل عمره ما يوقف طلب. أي فشل/مهلة (3 ث)/مفتاح ناقص/حصة
   خلصت → null، والمتصل بيرجع للحساب الهوائي القديم زي ما هو بالظبط. وبعد
   الفشل بنستريح دقيقة من غير ما نسأل، عشان كل تسعيرة ماتستناش 3 ثواني.
═══════════════════════════════════════════════════════════════════════════ */

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const MATRIX_CHUNK = 50;

export const roundCoord = (v) => Math.round(Number(v) * 1e4) / 1e4;
export const cacheKey = (lat, lng) => `${roundCoord(lat).toFixed(4)},${roundCoord(lng).toFixed(4)}`;

/* طلب واحد لجوجل → كيلومترات (رقم) أو رمي خطأ. */
export async function googleDriveKm({ from, to, key, fetchImpl = fetch, timeoutMs = 3000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(ROUTES_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        units: "METRIC",
      }),
    });
    if (!resp.ok) {
      const e = new Error(`routes_http_${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const j = await resp.json();
    const m = j && Array.isArray(j.routes) && j.routes[0] ? Number(j.routes[0].distanceMeters) : NaN;
    if (!isFinite(m) || m <= 0) throw new Error("routes_no_route");
    const secs = j.routes[0].duration ? parseInt(String(j.routes[0].duration), 10) : null;
    return { km: m / 1000, durationSec: isFinite(secs) ? secs : null };
  } finally {
    clearTimeout(t);
  }
}

/* مصفوفة: مصدر واحد → نقط كتير في طلب واحد (Compute Route Matrix **Essentials**:
   originIndex/destinationIndex/distanceMeters/duration/status/condition بس).
   بيرجّع مصفوفة بنفس ترتيب `tos`: {km, durationSec} | {noRoute:true} | null (فشل العنصر ده).
   فشل الطلب كله → رمي خطأ. */
export async function googleDriveMatrix({ from, tos, key, fetchImpl = fetch, timeoutMs = 10000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  try {
    const resp = await fetchImpl(MATRIX_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,status,condition",
      },
      body: JSON.stringify({
        origins: [wp(from)],
        destinations: tos.map(wp),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
    });
    if (!resp.ok) {
      const e = new Error(`matrix_http_${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const arr = await resp.json();
    if (!Array.isArray(arr)) throw new Error("matrix_bad_body");
    const out = tos.map(() => null);
    for (const el of arr) {
      const i = Number(el && el.destinationIndex) || 0; // proto3: الصفر بيتشال من الـJSON
      if (i < 0 || i >= out.length) continue;
      if (el.status && el.status.code) continue;
      if (el.condition === "ROUTE_NOT_FOUND") { out[i] = { noRoute: true }; continue; }
      const m = Number(el.distanceMeters);
      if (!isFinite(m) || m < 0) continue;
      const secs = el.duration ? parseInt(String(el.duration), 10) : null;
      out[i] = { km: m / 1000, durationSec: isFinite(secs) ? secs : null };
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

/* makeDriveDistance — الكاش + الاحتياطي. `pool` اختياري (من غيره: ذاكرة بس). */
export function makeDriveDistance({
  pool = null,
  keyFn = () => (process.env.GOOGLE_ROUTES_KEY || "").trim(),
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = 3000,
  ttlDays = 30,
  cooldownMs = 60_000,
  now = () => Date.now(),
  log = (...a) => console.error(...a),
} = {}) {
  const mem = new Map();          // key → {km, durationSec, at}
  const inflight = new Map();
  let pausedUntil = 0;
  const stats = { google: 0, cache: 0, fail: 0, skipped: 0 };
  const ttlMs = ttlDays * 86400_000;

  async function ensureSchema() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS geo_drive_cache (
        dest_key TEXT PRIMARY KEY,
        km NUMERIC NOT NULL,
        duration_sec INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async function fromCache(k) {
    const m = mem.get(k);
    if (m && now() - m.at < ttlMs) return m;
    if (!pool) return null;
    try {
      const r = await pool.query(
        `SELECT km, duration_sec, created_at FROM geo_drive_cache
          WHERE dest_key=$1 AND created_at > NOW() - make_interval(days => $2)`, [k, ttlDays]);
      const row = r.rows[0];
      if (!row) return null;
      const v = { km: Number(row.km), durationSec: row.duration_sec, at: new Date(row.created_at).getTime() };
      mem.set(k, v);
      return v;
    } catch (e) {
      log("[drivedist] cache read failed:", e.message);
      return null;
    }
  }

  async function toCache(k, v) {
    mem.set(k, v);
    if (mem.size > 5000) mem.delete(mem.keys().next().value);
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO geo_drive_cache(dest_key, km, duration_sec, created_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (dest_key) DO UPDATE SET km=EXCLUDED.km, duration_sec=EXCLUDED.duration_sec, created_at=NOW()`,
        [k, v.km, v.durationSec]);
    } catch (e) {
      log("[drivedist] cache write failed:", e.message);
    }
  }

  /* get(from, to) → {km, durationSec, source:'google'|'cache'} أو null. عمرها ما ترمي. */
  async function get(from, to) {
    try {
      const k = cacheKey(to.lat, to.lng);
      const hit = await fromCache(k);
      if (hit) { stats.cache++; return { km: hit.km, durationSec: hit.durationSec, source: "cache" }; }
      const key = keyFn();
      if (!key || now() < pausedUntil) { stats.skipped++; return null; }
      if (inflight.has(k)) return await inflight.get(k);
      const p = (async () => {
        try {
          const dest = { lat: roundCoord(to.lat), lng: roundCoord(to.lng) };
          const v = await googleDriveKm({ from, to: dest, key, fetchImpl, timeoutMs });
          stats.google++;
          await toCache(k, { ...v, at: now() });
          return { ...v, source: "google" };
        } catch (e) {
          stats.fail++;
          /* «مفيش طريق» مش عطل — مانوقفش جوجل عشانه. */
          if (e.message !== "routes_no_route") pausedUntil = now() + cooldownMs;
          log("[drivedist] google failed, falling back to straight-line:", e.name === "AbortError" ? "timeout" : e.message);
          return null;
        } finally {
          inflight.delete(k);
        }
      })();
      inflight.set(k, p);
      return await p;
    } catch (e) {
      log("[drivedist] unexpected:", e.message);
      return null;
    }
  }

  /* getMany(from, tos) — للخلفية بس (رسم منطقة التوصيل)، مش لمسار العميل:
     الكاش الأول، والباقي في طلبات مصفوفة (٥٠ نقطة للطلب).
     → {results:[{km,source}|{noRoute:true}|null], billed} — عمرها ما ترمي. */
  /* الخيارات للخلفية: chunk أصغر + مهلة أطول، و
     pauseOnFail:false = فشل رسم المنطقة مايوقفش جوجل على تسعير العملاء ٦٠ ثانية. */
  async function getMany(from, tos, { timeoutMs: tmo = 10000, chunk = MATRIX_CHUNK, pauseOnFail = true } = {}) {
    const results = tos.map(() => null);
    let billed = 0;
    const miss = [];
    for (let i = 0; i < tos.length; i++) {
      const hit = await fromCache(cacheKey(tos[i].lat, tos[i].lng));
      if (hit) { stats.cache++; results[i] = { km: hit.km, durationSec: hit.durationSec, source: "cache" }; }
      else miss.push(i);
    }
    const key = keyFn();
    if (!miss.length || !key || now() < pausedUntil) {
      if (miss.length) stats.skipped += miss.length;
      return { results, billed };
    }
    const size = Math.max(1, Math.min(MATRIX_CHUNK, Number(chunk) || MATRIX_CHUNK));
    for (let c = 0; c < miss.length; c += size) {
      const idx = miss.slice(c, c + size);
      const dests = idx.map((i) => ({ lat: roundCoord(tos[i].lat), lng: roundCoord(tos[i].lng) }));
      try {
        billed += dests.length;
        const res = await googleDriveMatrix({ from, tos: dests, key, fetchImpl, timeoutMs: tmo });
        for (let j = 0; j < idx.length; j++) {
          const v = res[j];
          if (!v) continue;
          if (v.noRoute) { results[idx[j]] = { noRoute: true }; continue; }
          stats.google++;
          await toCache(cacheKey(dests[j].lat, dests[j].lng), { ...v, at: now() });
          results[idx[j]] = { ...v, source: "google" };
        }
      } catch (e) {
        stats.fail++;
        log("[drivedist] matrix failed:", e.name === "AbortError" ? "timeout" : e.message);
        if (pauseOnFail) { pausedUntil = now() + cooldownMs; break; }
        // الخلفية: نكمّل باقي الأجزاء، والنقط اللي فشلت بترجع null
      }
    }
    return { results, billed };
  }

  return { ensureSchema, get, getMany, stats, configured: () => Boolean(keyFn()) };
}

/* resolveRouteKm — القرار كله في دالة واحدة عشان quote() تفضل بسيطة:
   بيرجع المسافة اللي التسعير والأهلية بيتحسبوا عليها + مصدرها. */
export async function resolveRouteKm({ cfg, straightKm, from, to, drive }) {
  const estimate = straightKm * (Number(cfg.routeFactor) || 1);
  const fallback = { routeKm: estimate, driveKm: null, distanceSource: "straight" };
  if (!drive || cfg.useDrivingDistance === false) return fallback;
  /* المشوار عمره ما يبقى أقصر من الخط المستقيم — لو الهوائي فات السقف، الطلب
     مرفوض كده كده، فمش هندفع لجوجل علشان يقولنا كده. */
  if (cfg.maxKm != null && straightKm > Number(cfg.maxKm)) return fallback;
  if (cfg.maxStraightKm != null && straightKm > Number(cfg.maxStraightKm)) return fallback;
  const d = await drive.get(from, to);
  if (!d || !isFinite(d.km)) return fallback;
  return { routeKm: d.km, driveKm: d.km, distanceSource: "google", driveCached: d.source === "cache" };
}
