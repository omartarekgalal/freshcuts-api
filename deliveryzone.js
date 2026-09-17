/* ═══════════════════════════════════════════════════════════════════════════
   منطقة التوصيل على الخريطة — مضلّع تقريبي لـ«مشوار ≤ maxKm بالعربية»

   الهدف: الخريطة في المتجر تضلّل اللي برّه التوصيل بالأحمر. المضلّع تقريبي
   وللعرض بس — التسعيرة لكل عنوان (/api/delivery/quote) هي اللي بتقرّر، ومفيش
   حاجة بتتقفل بسبب المضلّع.

   الطريقة: ١٢٠ شعاع (كل ٣°، عدد الأشعة قابل للتغيير — ZONE_RAYS) من المطعم.
   على كل شعاع بحث ثنائي بين 0 و السقف الهوائي (المشوار عمره ما يبقى أقصر من
   الخط المستقيم، فأبعد نقطة ممكنة = maxKm). كل لفّة = ١٢٠ عنصر من
   drivedist.getMany (مصفوفة ٥٠/طلب، بكاش geo_drive_cache ٣٠ يوم). ٦ لفّات =
   ٧٢٠ عنصر كحد أقصى (سقف ٩٠٠ للبناء)، ودقة ~١٧٠ م على سقف ١٠٫٩ كم.
   حصة جوجل اليومية ١٥٠٠ عنصر: فيه كمان سقف يومي للبناء التلقائي (٩٠٠/٢٤ ساعة)
   عشان فشل متكرر مايخلّصش الحصة على العملاء.

   بيتحسب في الخلفية بس (بعد الإقلاع + كل ٣٠ دقيقة بنشوف — من غير جوجل لو لسه صالح): لو السقف اتغيّر أو
   الحساب أقدم من ٣٠ يوم. عمره ما بيتحسب على طلب عميل. لو لسه ماتحسبش أو
   جوجل واقع → دايرة هوائية نصف قطرها maxKm/routeFactor، فالواجهة دايماً
   عندها حاجة ترسمها.
═══════════════════════════════════════════════════════════════════════════ */

const R_EARTH = 6371;
const rad = Math.PI / 180;

/* نقطة على بُعد km في اتجاه bearing (درجات، 0 = شمال، مع عقارب الساعة). */
export function destPoint(lat, lng, bearingDeg, km) {
  const d = km / R_EARTH, b = bearingDeg * rad, p1 = lat * rad, l1 = lng * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / rad, lng: l2 / rad };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const ringOf = (center, radii) =>
  radii.map((km, i) => {
    const p = destPoint(center.lat, center.lng, (360 / radii.length) * i, km);
    return [r5(p.lat), r5(p.lng)];
  });

export function circlePolygon(center, radiusKm, n = 72) {
  return ringOf(center, new Array(n).fill(radiusKm));
}

/* السقف الفعلي على الشعاع: maxKm (مشوار) و maxStraightKm (هوائي) لو موجود. */
export function rayCapKm(cfg) {
  const caps = [Number(cfg.maxKm)];
  if (cfg.maxStraightKm != null && isFinite(Number(cfg.maxStraightKm))) caps.push(Number(cfg.maxStraightKm));
  const v = Math.min(...caps.filter((x) => isFinite(x) && x > 0));
  return isFinite(v) ? v : 10;
}

/* دايرة الاحتياطي: نفس حساب quote() لما جوجل مش متاح (هوائي × routeFactor ≤ maxKm). */
export function fallbackRadiusKm(cfg) {
  const f = Number(cfg.routeFactor) || 1;
  let r = Number(cfg.maxKm) / f;
  if (!isFinite(r) || r <= 0) r = 10 / f;
  if (cfg.maxStraightKm != null && isFinite(Number(cfg.maxStraightKm))) r = Math.min(r, Number(cfg.maxStraightKm));
  return r;
}

export const ZONE_ALGO = "v4"; // غيّره لما طريقة الرسم تتغيّر → إعادة بناء (من الكاش، ببلاش)
export const DEFAULT_RAYS = 120;
export const zoneKey = (cfg, store, rays = DEFAULT_RAYS) =>
  [ZONE_ALGO, rays, Number(cfg.maxKm), cfg.maxStraightKm == null ? "-" : Number(cfg.maxStraightKm),
   Number(store.lat).toFixed(5), Number(store.lng).toFixed(5)].join("|");

/* buildDriveZone — البحث الثنائي على الأشعة.
   distMany(points) → {results:[{km}|{noRoute:true}|null], billed}
   بيرمي zone_google_failed لو أكتر من نص الأشعة مالهاش إجابة في لفّة، أو
   zone_budget لو الميزانية ماتكفيش ولا ٣ لفّات. */
export async function buildDriveZone({
  center, maxKm, capKm = maxKm, distMany, rays = DEFAULT_RAYS, iterations = 6, maxElements = 900, minKm = 0.3,
}) {
  rays = Math.max(8, Math.round(Number(rays) || DEFAULT_RAYS));
  const lo = new Array(rays).fill(0), hi = new Array(rays).fill(capKm);
  const loKm = new Array(rays).fill(0); // مسافة المشوار لنقطة lo على كل شعاع
  let elements = 0, done = 0;
  for (let it = 0; it < iterations; it++) {
    if (elements + rays > maxElements) break; // أسوأ حالة: كل النقط مش في الكاش
    const mids = lo.map((l, i) => (l + hi[i]) / 2);
    const pts = mids.map((km, i) => destPoint(center.lat, center.lng, (360 / rays) * i, km));
    const got = await distMany(pts);
    const results = got.results.slice();
    elements += Number(got.billed) || 0;
    /* النقط اللي مارجعلهاش إجابة (مهلة/عطل مؤقت) بنسألها تاني مرة واحدة — اللي
       نجح اتخزّن في الكاش، فالمحاولة بتدفع تمن الناقص بس. */
    const miss = [];
    for (let i = 0; i < rays; i++) if (!results[i]) miss.push(i);
    if (miss.length && elements + miss.length <= maxElements) {
      const again = await distMany(miss.map((i) => pts[i]));
      elements += Number(again.billed) || 0;
      miss.forEach((i, j) => { if (again.results[j]) results[i] = again.results[j]; });
    }
    let unknown = 0;
    for (let i = 0; i < rays; i++) {
      const r = results[i];
      if (!r) { unknown++; continue; }
      if (!r.noRoute && isFinite(r.km) && r.km <= maxKm && !snapped(mids[i] - lo[i], r.km - loKm[i])) {
        lo[i] = mids[i]; loKm[i] = r.km;
      } else hi[i] = mids[i];
    }
    if (unknown > rays / 2) {
      // عندنا دقة كفاية من اللفّات اللي فاتت (الحدود lo/hi لسه صحيحة) → نقف هنا بدل ما نرمي
      if (done >= 3) break;
      throw Object.assign(new Error("zone_google_failed"), { elements });
    }
    done++;
  }
  if (done < 3) throw Object.assign(new Error("zone_budget"), { elements });
  const radii = clampSpikes(lo, 1.25, spikeWindow(rays)).map((l) => Math.max(l, minKm));
  return { polygon: ringOf(center, radii), radiiKm: radii.map((x) => Math.round(x * 100) / 100), elements, iterations: done };
}

/* «لزق» على الطريق: نقطة في البحر (أو أرض من غير طرق) جوجل بيحسب المشوار لأقرب
   طريق، فمهما بعدت على نفس الشعاع المشوار بيفضل ثابت. اتشاف في الإنتاج
   (2026-09-17) على ٢٥٥–٢٧٠°: هوائي 5.45 / 8.17 / 9.54 كم → مشوار 9.71 / 9.71 / 9.71.
   على الأرض الحقيقية لو بعدت d كم هوائي المشوار بيزيد تقريباً d أو أكتر، فلو زاد
   أقل من ربعها على مسافة ≥ 0.4 كم → النقطة الأبعد «ملزوقة» = برّه. */
export function snapped(straightStepKm, driveStepKm, { minStepKm = 0.4, ratio = 0.25 } = {}) {
  return straightStepKm >= minStepKm && driveStepKm < ratio * straightStepKm;
}

/* شعاع أطول بكتير من اللي حواليه = غالباً نقطة في البحر جوجل «لزقها» على
   الكورنيش (اتشاف فعلاً: الغرب 9.7 كم وجيرانه 4.1/4.4)، أو طريق سريع ضيق.
   على الخريطة بيبان مثلث غريب. مع ١٢٠ شعاع (كل ٣°) الشذوذ في البحر بقى عرضه
   كذا شعاع ومتقطّع (snapped فوق بتمسك أغلبه)، فالمقارنة بالجار المباشر
   مابتنفعش: لكل جانب (±halfWindow ≈ ±١٥°) بناخد أوطى قيمة (q=0)، والمرجع =
   الأعلى بين الجانبين، والشعاع بيتقصّ لـ ratio × المرجع. للعرض بس — التسعيرة
   لكل عنوان مش متأثرة. الأشعة مرتّبة بالزاوية ونصف قطرها > 0 ⇒ المضلّع نجمي
   حوالين المطعم ومستحيل يقطع نفسه. */
export const spikeWindow = (n) => Math.max(1, Math.ceil(n / 24));
export function clampSpikes(radii, ratio = 1.25, halfWindow = 1, q = 0) {
  const n = radii.length;
  const w = Math.max(1, Math.min(halfWindow, Math.floor((n - 1) / 2) || 1));
  const quant = (arr) => { arr.sort((a, b) => a - b); return arr[Math.floor((arr.length - 1) * q)]; };
  return radii.map((r, i) => {
    const left = [], right = [];
    for (let d = 1; d <= w; d++) { left.push(radii[(i - d + n) % n]); right.push(radii[(i + d) % n]); }
    // الجانبين لازم يبقوا واطيين الاتنين؛ حافة حقيقية (جانب عالي وجانب واطي) مابتتقصّش
    return Math.min(r, Math.max(quant(left), quant(right)) * ratio);
  });
}

/* makeZoneService — الجدول + الجدولة + ردّ الـendpoint. */
export function makeZoneService({
  pool, drive, getCfg, store, now = () => Date.now(), log = (...a) => console.error(...a),
  ttlDays = 30, retryMs = 12 * 3600_000,
  rays = Number(process.env.ZONE_RAYS) || DEFAULT_RAYS,
  maxElements = Number(process.env.ZONE_MAX_ELEMENTS) || 900,
  dailyElements = Number(process.env.ZONE_DAILY_ELEMENTS) || 900,
}) {
  let inflight = null, lastFailAt = -Infinity, row = null, rowLoaded = false;
  /* العناصر المدفوعة في آخر ٢٤ ساعة (للبناء التلقائي بس؛ force من الأدمن بيعدّي
     بس برضه مقفول بـmaxElements). */
  let spent = [];
  const spentToday = () => {
    const t = now() - 86400_000;
    spent = spent.filter((x) => x.at > t);
    return spent.reduce((a, x) => a + x.n, 0);
  };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dl_delivery_zone (
        id INT PRIMARY KEY DEFAULT 1,
        zone_key TEXT NOT NULL,
        max_km NUMERIC NOT NULL,
        polygon JSONB NOT NULL,
        meta JSONB,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`);
  }

  async function loadRow() {
    const r = await pool.query("SELECT zone_key, max_km, polygon, meta, computed_at FROM dl_delivery_zone WHERE id=1");
    row = r.rows[0] || null;
    rowLoaded = true;
    return row;
  }

  const fresh = (rw, key) => rw && rw.zone_key === key &&
    now() - new Date(rw.computed_at).getTime() < ttlDays * 86400_000;

  /* refresh({force}) — للخلفية بس. */
  async function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const cfg = await getCfg();
      if (!cfg || cfg.useDrivingDistance === false) return { skipped: "no_policy_or_straight_mode" };
      const st = store();
      const key = zoneKey(cfg, st, rays);
      const cur = rowLoaded ? row : await loadRow();
      if (!force && fresh(cur, key)) return { skipped: "fresh" };
      if (!force && now() - lastFailAt < retryMs) return { skipped: "retry_later" };
      if (!drive || !drive.getMany || !drive.configured()) return { skipped: "google_not_configured" };
      if (!force && spentToday() + Math.min(maxElements, rays * 6) > dailyElements) return { skipped: "daily_budget", spentToday: spentToday() };
      let used = 0;
      try {
        const z = await buildDriveZone({
          center: st, maxKm: Number(cfg.maxKm), capKm: rayCapKm(cfg), maxElements, rays,
          distMany: async (pts) => {
            const r = await drive.getMany(st, pts, { chunk: 25, timeoutMs: 20000, pauseOnFail: false });
            used += Number(r && r.billed) || 0;
            return r;
          },
        });
        spent.push({ at: now(), n: used });
        const meta = { radiiKm: z.radiiKm, elements: z.elements, iterations: z.iterations, rays: z.radiiKm.length,
          minRadiusKm: Math.min(...z.radiiKm), maxRadiusKm: Math.max(...z.radiiKm) };
        await pool.query(
          `INSERT INTO dl_delivery_zone(id, zone_key, max_km, polygon, meta, computed_at)
           VALUES (1,$1,$2,$3::jsonb,$4::jsonb,NOW())
           ON CONFLICT (id) DO UPDATE SET zone_key=EXCLUDED.zone_key, max_km=EXCLUDED.max_km,
             polygon=EXCLUDED.polygon, meta=EXCLUDED.meta, computed_at=NOW()`,
          [key, Number(cfg.maxKm), JSON.stringify(z.polygon), JSON.stringify(meta)]);
        await loadRow();
        log(`[zone] built: ${z.radiiKm.length} rays × ${z.iterations} iterations, ${z.elements} route elements`);
        return { built: true, ...meta };
      } catch (e) {
        if (used) spent.push({ at: now(), n: used });
        lastFailAt = now();
        log("[zone] build failed, keeping previous/circle:", e.message);
        return { failed: e.message, elements: used };
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /* current() — ردّ GET /api/delivery/zone. عمره ما يسأل جوجل. */
  async function current() {
    const cfg = await getCfg();
    const st = store();
    const storeOut = { lat: st.lat, lng: st.lng };
    if (!cfg) return { store: storeOut, maxKm: null, polygon: null, approx: true, source: "none", computedAt: null };
    let rw = row;
    try { if (!rowLoaded) rw = await loadRow(); } catch { rw = null; }
    if (cfg.useDrivingDistance !== false && rw && rw.zone_key === zoneKey(cfg, st, rays) && Array.isArray(rw.polygon)) {
      return { store: storeOut, maxKm: Number(cfg.maxKm), polygon: rw.polygon, approx: true,
               source: "drive", computedAt: new Date(rw.computed_at).toISOString(),
               rays: Array.isArray(rw.polygon) ? rw.polygon.length : null };
    }
    return { store: storeOut, maxKm: Number(cfg.maxKm), polygon: circlePolygon(st, fallbackRadiusKm(cfg)),
             approx: true, source: "straight", computedAt: null };
  }

  function schedule({ firstDelayMs = 90_000, everyMs = 30 * 60_000 } = {}) {
    const run = () => refresh().catch((e) => log("[zone] refresh:", e.message));
    const t1 = setTimeout(run, firstDelayMs);
    const t2 = setInterval(run, everyMs);
    t1.unref?.(); t2.unref?.();
  }

  return { ensureSchema, refresh, current, schedule };
}
