/* ═══════════════════════════════════════════════════════════════════════════
   منطقة التوصيل على الخريطة — مضلّع تقريبي لـ«مشوار ≤ maxKm بالعربية»

   الهدف: الخريطة في المتجر تضلّل اللي برّه التوصيل بالأحمر. المضلّع تقريبي
   وللعرض بس — التسعيرة لكل عنوان (/api/delivery/quote) هي اللي بتقرّر، ومفيش
   حاجة بتتقفل بسبب المضلّع.

   الطريقة: ٣٦ شعاع (كل ١٠°) من المطعم. على كل شعاع بحث ثنائي بين 0 و السقف
   الهوائي (المشوار عمره ما يبقى أقصر من الخط المستقيم، فأبعد نقطة ممكنة =
   maxKm). كل لفّة = طلب مصفوفة واحد (٣٦ عنصر) من drivedist.getMany (بكاش
   geo_drive_cache). ٦ لفّات = ٢١٦ عنصر كحد أقصى، ودقة ~١٦٠ م على سقف ١٠ كم.

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

export const ZONE_ALGO = "v2"; // غيّره لما طريقة الرسم تتغيّر → إعادة بناء (من الكاش، ببلاش)
export const zoneKey = (cfg, store) =>
  [ZONE_ALGO, Number(cfg.maxKm), cfg.maxStraightKm == null ? "-" : Number(cfg.maxStraightKm),
   Number(store.lat).toFixed(5), Number(store.lng).toFixed(5)].join("|");

/* buildDriveZone — البحث الثنائي على الأشعة.
   distMany(points) → {results:[{km}|{noRoute:true}|null], billed}
   بيرمي zone_google_failed لو أكتر من نص الأشعة مالهاش إجابة في لفّة، أو
   zone_budget لو الميزانية ماتكفيش ولا ٣ لفّات. */
export async function buildDriveZone({
  center, maxKm, capKm = maxKm, distMany, rays = 36, iterations = 6, maxElements = 300, minKm = 0.3,
}) {
  const lo = new Array(rays).fill(0), hi = new Array(rays).fill(capKm);
  let elements = 0, done = 0;
  for (let it = 0; it < iterations; it++) {
    if (elements + rays > maxElements) break; // أسوأ حالة: كل النقط مش في الكاش
    const mids = lo.map((l, i) => (l + hi[i]) / 2);
    const pts = mids.map((km, i) => destPoint(center.lat, center.lng, (360 / rays) * i, km));
    const { results, billed } = await distMany(pts);
    elements += Number(billed) || 0;
    let unknown = 0;
    for (let i = 0; i < rays; i++) {
      const r = results[i];
      if (!r) { unknown++; continue; }
      if (!r.noRoute && isFinite(r.km) && r.km <= maxKm) lo[i] = mids[i];
      else hi[i] = mids[i];
    }
    if (unknown > rays / 2) throw Object.assign(new Error("zone_google_failed"), { elements });
    done++;
  }
  if (done < 3) throw Object.assign(new Error("zone_budget"), { elements });
  const radii = clampSpikes(lo).map((l) => Math.max(l, minKm));
  return { polygon: ringOf(center, radii), radiiKm: radii.map((x) => Math.round(x * 100) / 100), elements, iterations: done };
}

/* شعاع واحد أطول بكتير من جيرانه = غالباً نقطة في البحر جوجل «لزقها» على
   الكورنيش (اتشاف فعلاً: الغرب 9.7 كم وجيرانه 4.1/4.4)، أو طريق سريع ضيق.
   على الخريطة بيبان مثلث غريب، فبنقصّه لـ×1.25 من أطول جار. التسعيرة مش متأثرة. */
export function clampSpikes(radii, ratio = 1.25) {
  const n = radii.length;
  return radii.map((r, i) => Math.min(r, Math.max(radii[(i - 1 + n) % n], radii[(i + 1) % n]) * ratio));
}

/* makeZoneService — الجدول + الجدولة + ردّ الـendpoint. */
export function makeZoneService({
  pool, drive, getCfg, store, now = () => Date.now(), log = (...a) => console.error(...a),
  ttlDays = 30, retryMs = 6 * 3600_000, maxElements = 300,
}) {
  let inflight = null, lastFailAt = -Infinity, row = null, rowLoaded = false;

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
      const key = zoneKey(cfg, st);
      const cur = rowLoaded ? row : await loadRow();
      if (!force && fresh(cur, key)) return { skipped: "fresh" };
      if (!force && now() - lastFailAt < retryMs) return { skipped: "retry_later" };
      if (!drive || !drive.getMany || !drive.configured()) return { skipped: "google_not_configured" };
      try {
        const z = await buildDriveZone({
          center: st, maxKm: Number(cfg.maxKm), capKm: rayCapKm(cfg), maxElements,
          distMany: (pts) => drive.getMany(st, pts),
        });
        const meta = { radiiKm: z.radiiKm, elements: z.elements, iterations: z.iterations, rays: z.radiiKm.length };
        await pool.query(
          `INSERT INTO dl_delivery_zone(id, zone_key, max_km, polygon, meta, computed_at)
           VALUES (1,$1,$2,$3::jsonb,$4::jsonb,NOW())
           ON CONFLICT (id) DO UPDATE SET zone_key=EXCLUDED.zone_key, max_km=EXCLUDED.max_km,
             polygon=EXCLUDED.polygon, meta=EXCLUDED.meta, computed_at=NOW()`,
          [key, Number(cfg.maxKm), JSON.stringify(z.polygon), JSON.stringify(meta)]);
        await loadRow();
        log(`[zone] built: ${z.iterations} iterations, ${z.elements} route elements`);
        return { built: true, ...meta };
      } catch (e) {
        lastFailAt = now();
        log("[zone] build failed, keeping previous/circle:", e.message);
        return { failed: e.message };
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
    if (cfg.useDrivingDistance !== false && rw && rw.zone_key === zoneKey(cfg, st) && Array.isArray(rw.polygon)) {
      return { store: storeOut, maxKm: Number(cfg.maxKm), polygon: rw.polygon, approx: true,
               source: "drive", computedAt: new Date(rw.computed_at).toISOString() };
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
