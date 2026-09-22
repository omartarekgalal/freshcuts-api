/* ═══════════════════════════════════════════════════════════════════════════
   تجربة Cervo — «نبدا نديلهم طلبات حقيقية من المتجر بتاعنا» (عمر، ٢٢/٩)

   Cervo بعتت توكن الإنتاج مظبوط على مطعمنا الحقيقي، وعمر عايز يجرّبهم على
   عدد محدود من الطلبات الحقيقية (١٠) عشان يحكم عليهم بأرقام مش بكلام.

   ── الخطر اللي الملف ده موجود عشانه ────────────────────────────────────
   كل اختبار عملناه معاهم كان على **بيئة تجارب في الرياض**. أسطول التجارب
   بتاعهم هناك، والكابتن الوهمي بيتعيّن في ٥ ثواني. تغطيتهم في **جدة** —
   اللي المطعم فيها — **لسه مش مؤكدة**، وأول تجربة جدة عندهم رجعت
   «No available drivers found within the specified range».

   يعني الاحتمال الحقيقي إن طلب حقيقي يروح لهم ويقعد من غير كابتن. ولأن
   العميل دافع والأكل جاهز، **مينفعش العميل يستنى عشان إحنا بنجرّب**. فكل
   الملف ده مبني حوالين شبكة أمان واحدة:

     لو مافيش كابتن خلال X دقيقة (افتراضي ٦) → نلغي عند Cervo، ونبعت
     للاجلك فوراً، وننبّه المدير SMS + البوابة.

   ── قواعد الاستبعاد (طلبات مش بتدخل التجربة) ───────────────────────────
   • المدير اختار شركة بنفسه للطلب ده — اختياره بيغلب أي أتمتة، دايماً.
   • مشوار فوق حد التغطية المؤكدة (افتراضي ١٠ كم).
   • مشوار بعيد (far zone) أو توصيل بالحي — دول أصلاً مسارات خاصة.
   • مسافة مش معروفة — مانجرّبش على طلب إحنا نفسنا مش عارفين بعده.
   • طلب تجريبي (is_test).
   • العدّاد خلص (١٠ من ١٠) → التوجيه بيرجع طبيعي **لوحده**، من غير ما حد
     يقفل حاجة.

   ── التكلفة ────────────────────────────────────────────────────────────
   الـAPI بتاعهم مافيهوش سعر في أي مرحلة (اتأكدنا على الحالات ١،٢،٢٠،٣،٤،٧).
   فالتكلفة تقدير من اللوحة (`settings.delivery.cervoContract`، الافتراضي =
   نفس لاجلك ١٩٫٥٥) ومتعلّمة `costAssumed` — بتتحسب في الأرقام عشان
   المالية ماتبقاش فاضية، وبرضه بتتعدّ في «شحنات من غير تكلفة مؤكدة».
═══════════════════════════════════════════════════════════════════════════ */

import { PROVIDERS, farZoneOfRow } from "./couriers.js";
import { cervoContract } from "./cervo.js";
import { districtOfRow } from "./districts.js";
import { routeKmOfRow } from "./delivery.js";

/* ── الإعدادات (settings.delivery.cervoTrial) ───────────────────────────
   العدّاد **مش** هنا. الرقم الحقيقي بيتعدّ من dl_shipments (شحنات Cervo
   متعلّمة `trial`) — عشان ما يبقاش فيه رقمين للحقيقة الواحدة، ولأن
   الإعدادات كائن JSON واحد وكتابته من كذا طلب في نفس اللحظة بتضيّع كتابات. */
export const DEFAULT_CERVO_TRIAL = Object.freeze({
  enabled: false,
  target: 10,          // كام طلب حقيقي
  maxKm: 10,           // حد التغطية اللي هم أكّدوها — فوقه مانجرّبش
  fallbackMin: 6,      // مافيش كابتن خلال كده ⇒ إلغاء + لاجلك
  startedAt: null,     // بداية العدّ (الشحنات قبلها مابتتحسبش)
  stoppedAt: null,
  stopReason: null,
});

const num = (v, dflt, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function cervoTrialCfg(settings = {}) {
  const raw = ((settings || {}).delivery || {}).cervoTrial;
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled === true || src.enabled === "true",
    target: Math.round(num(src.target, DEFAULT_CERVO_TRIAL.target, 1, 500)),
    maxKm: num(src.maxKm, DEFAULT_CERVO_TRIAL.maxKm, 0.5, 50),
    fallbackMin: num(src.fallbackMin, DEFAULT_CERVO_TRIAL.fallbackMin, 1, 60),
    startedAt: src.startedAt || null,
    stoppedAt: src.stoppedAt || null,
    stopReason: src.stopReason || null,
  };
}

/* ── قرار: الطلب ده يدخل التجربة ولا لأ؟ ────────────────────────────────
   دالة صافية. كل مُدخل بيتحسب برّه (المسافة، العدّاد، هل المدير اختار)،
   عشان القرار يكون قابل للاختبار من غير قاعدة بيانات ولا شبكة. */
export function trialDecision({
  cfg, km = null, count = 0, explicitProvider = null,
  configured = false, isTest = false, farZone = false, district = false,
} = {}) {
  const c = cfg || cervoTrialCfg({});
  const seq = Number(count) + 1;
  const no = (code, why) => ({ take: false, code, why, seq: null, count: Number(count) || 0, target: c.target });
  if (!c.enabled) return no("off", "تجربة Cervo مقفولة");
  if (explicitProvider) return no("manager_choice", `المدير اختار ${explicitProvider} للطلب ده — اختياره بيغلب التجربة`);
  if (!configured) return no("unconfigured", "مفاتيح Cervo ناقصة");
  if (Number(count) >= c.target) return no("done", `التجربة خلصت (${c.target} من ${c.target}) — التوجيه رجع طبيعي`);
  if (isTest) return no("test_order", "طلب تجريبي — التجربة على طلبات حقيقية بس");
  if (district) return no("district", "توصيل بالحي — مسار المندوب بتاع الحي");
  if (farZone) return no("far_zone", "مشوار بعيد (رسم مسافة إضافية) — بره التجربة");
  if (km == null || !Number.isFinite(Number(km)) || Number(km) <= 0) {
    return no("no_km", "مسافة المشوار مش معروفة — مانجرّبش على طلب مش عارفين بعده");
  }
  if (Number(km) > c.maxKm) {
    return no("beyond_coverage", `${Math.round(Number(km) * 10) / 10} كم فوق حد التغطية المؤكدة (${c.maxKm} كم)`);
  }
  return {
    take: true, code: "trial", seq, count: Number(count) || 0, target: c.target,
    why: `تجربة Cervo — الطلب ${seq} من ${c.target}`,
    km: Math.round(Number(km) * 10) / 10,
  };
}

/* المدخلات الجاهزة لـtrialDecision من صف الطلب. */
export function trialInputsOf(order = {}) {
  let km = null;
  try { km = routeKmOfRow(order); } catch { km = null; }
  let farZone = false;
  try { farZone = Boolean(farZoneOfRow(order)); } catch { farZone = false; }
  let district = false;
  try { district = Boolean(districtOfRow(order)); } catch { district = false; }
  return { km, farZone, district, isTest: Boolean(order.is_test) };
}

/* ── شبكة الأمان: الشحنة دي محتاجة ترجع للاجلك؟ ─────────────────────────
   دالة صافية برضه. «مفيش كابتن» = الحالة لسه pending ومفيش كابتن مخزّن،
   وعدّى `fallbackMin` من وقت الإنشاء. */
export function trialFallbackDue({ sh = {}, cfg, now = Date.now() } = {}) {
  const c = cfg || cervoTrialCfg({});
  const t = new Date(sh.created_at || 0).getTime();
  if (!Number.isFinite(t) || !t) return { due: false, reason: "مفيش وقت إنشاء" };
  if (String(sh.provider) !== "cervo") return { due: false, reason: "مش شحنة Cervo" };
  if (String(sh.status) !== "pending") return { due: false, reason: `الحالة ${sh.status}` };
  if (sh.driver && (sh.driver.name || sh.driver.phone)) return { due: false, reason: "الكابتن اتعيّن" };
  const waitedMin = Math.round(((now - t) / 60_000) * 10) / 10;
  if (waitedMin < c.fallbackMin) return { due: false, waitedMin, reason: `لسه ${waitedMin} د من ${c.fallbackMin}` };
  return { due: true, waitedMin, reason: `مافيش كابتن بعد ${waitedMin} د (الحد ${c.fallbackMin} د)` };
}

/* الطلب لسه محتاج توصيل؟ (مانبعتش لاجلك على طلب اتلغى أو اتوصّل) */
const NEEDS_DELIVERY = new Set(["accepted", "courier_requested", "courier_assigned", "courier_cancelled", "pos_created"]);
export const stillNeedsCourier = (orderStatus) => NEEDS_DELIVERY.has(String(orderStatus || ""));

/* ── بطاقة نتيجة التجربة ────────────────────────────────────────────────
   لكل شحنة: الزمن للتعيين، الزمن للوصول للمطعم، من الاستلام للتسليم،
   الإجمالي، واتلغت ولا لأ. الأرقام بالدقايق بفاصلة عشرية واحدة. */
const mins = (a, b) => {
  const x = a ? new Date(a).getTime() : NaN, y = b ? new Date(b).getTime() : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const v = (y - x) / 60_000;
  return v < 0 ? null : Math.round(v * 10) / 10;
};

export function shipmentMetrics(sh = {}) {
  const created = sh.created_at || null;
  return {
    orderNo: sh.shop_order_no || null,
    provider: sh.provider || null,
    ref: sh.provider_ref || null,
    requestedAt: created ? new Date(created).toISOString() : null,
    status: sh.status || null,
    cancelled: String(sh.status) === "cancelled",
    delivered: String(sh.status) === "delivered",
    km: sh.route_km != null ? Number(sh.route_km) : null,
    driver: sh.driver && sh.driver.name ? String(sh.driver.name).slice(0, 60) : null,
    toAssignMin: mins(created, sh.assigned_at),
    toArriveMin: mins(created, sh.arrived_at),
    pickupToDeliverMin: mins(sh.picked_at, sh.delivered_at),
    totalMin: mins(created, sh.delivered_at),
    cost: sh.cost != null ? Number(sh.cost) : null,
    costAssumed: Boolean(sh.dispatch && sh.dispatch.costAssumed),
    trial: Boolean(sh.dispatch && sh.dispatch.trial),
    fellBackTo: (sh.dispatch && sh.dispatch.fellBackTo) || null,
  };
}

const avg = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
};

export function summarize(rows = []) {
  const n = rows.length;
  const done = rows.filter((r) => r.delivered);
  const cancelled = rows.filter((r) => r.cancelled);
  const assigned = rows.filter((r) => r.toAssignMin != null);
  const costs = rows.filter((r) => !r.cancelled && r.cost != null).map((r) => r.cost);
  return {
    shipments: n,
    delivered: done.length,
    cancelled: cancelled.length,
    cancelRatePct: n ? Math.round((cancelled.length / n) * 1000) / 10 : 0,
    noDriver: rows.filter((r) => r.toAssignMin == null && !r.delivered).length,
    assignedPct: n ? Math.round((assigned.length / n) * 1000) / 10 : 0,
    avgAssignMin: avg(rows.map((r) => r.toAssignMin)),
    medAssignMin: median(rows.map((r) => r.toAssignMin)),
    avgArriveMin: avg(rows.map((r) => r.toArriveMin)),
    medArriveMin: median(rows.map((r) => r.toArriveMin)),
    avgPickupToDeliverMin: avg(rows.map((r) => r.pickupToDeliverMin)),
    avgTotalMin: avg(rows.map((r) => r.totalMin)),
    medTotalMin: median(rows.map((r) => r.totalMin)),
    avgKm: avg(rows.map((r) => r.km)),
    cost: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    costAssumedShipments: rows.filter((r) => r.costAssumed).length,
    fellBack: rows.filter((r) => r.fellBackTo).length,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   التسجيل: الكنس (شبكة الأمان) + مسارات اللوحة
   ═══════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, requireAdmin, jb } = ctx;
  const log = ctx.log || console;
  const J = jb || ((v) => JSON.stringify(v));
  const delivery = typeof deps.delivery === "function" ? deps.delivery : () => deps.delivery || null;
  const courierOps = typeof deps.courierOps === "function" ? deps.courierOps : () => deps.courierOps || null;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const now = deps.now || (() => Date.now());

  const cfgOf = async () => cervoTrialCfg(await getSettingsData());

  /* عدّاد التجربة = شحنات Cervo متعلّمة trial من وقت البداية. مصدر واحد
     للحقيقة، وبيعدّ الطلب اللي رجع للاجلك برضه: هو **نتيجة** في التجربة
     مش طلب ملغي. */
  async function trialCount(cfg) {
    const c = cfg || (await cfgOf());
    try {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM dl_shipments
          WHERE provider='cervo' AND (dispatch->>'trial') = 'true'
            AND created_at >= COALESCE($1::timestamptz, created_at)`,
        [c.startedAt || null]);
      return Number(r.rows[0]?.n) || 0;
    } catch (e) {
      /* مانقدرش نعدّ ⇒ مانجرّبش. الفشل هنا بيرجّع الطلب للمسار العادي،
         مش بيفتح التجربة على الآخر. */
      try { log.error(`[cervotrial] count failed: ${e?.message || e}`); } catch {}
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /* delivery.dispatchInner بينده دي قبل أي نداء شبكة. */
  async function decide(order, { explicitProvider = null } = {}) {
    try {
      const cfg = await cfgOf();
      if (!cfg.enabled) return trialDecision({ cfg });
      const inputs = trialInputsOf(order || {});
      const configured = Boolean(PROVIDERS.cervo && PROVIDERS.cervo.configured());
      const count = await trialCount(cfg);
      return trialDecision({ cfg, ...inputs, configured, explicitProvider, count });
    } catch (e) {
      try { log.error(`[cervotrial] decide ${order?.order_no} failed: ${e?.message || e}`); } catch {}
      return { take: false, code: "error", why: String(e?.message || e).slice(0, 120), seq: null };
    }
  }

  /* ── شبكة الأمان ───────────────────────────────────────────────────── */
  let sweeping = false;
  async function sweep() {
    if (sweeping) return { skipped: true };
    sweeping = true;
    const out = { checked: 0, fellBack: 0, failed: 0 };
    try {
      const cfg = await cfgOf();
      const rows = (await pool.query(
        `SELECT sh.id, sh.shop_order_no, sh.provider, sh.provider_ref, sh.status, sh.driver,
                sh.created_at, sh.dispatch, s.status AS order_status, s.is_test
           FROM dl_shipments sh JOIN shop_orders s ON s.order_no = sh.shop_order_no
          WHERE sh.provider='cervo' AND (sh.dispatch->>'trial') = 'true'
            AND sh.status = 'pending'
            AND sh.created_at > NOW() - INTERVAL '6 hours'
          ORDER BY sh.id`)).rows;
      for (const sh of rows) {
        out.checked++;
        const due = trialFallbackDue({ sh, cfg, now: now() });
        if (!due.due) continue;
        if (!stillNeedsCourier(sh.order_status)) continue;
        if (sh.is_test) continue;
        await fallback(sh, due, out);
      }
      return out;
    } catch (e) {
      try { log.error(`[cervotrial] sweep failed: ${e?.message || e}`); } catch {}
      return out;
    } finally {
      sweeping = false;
    }
  }

  /* إلغاء عند Cervo + إرسال للاجلك + تنبيه.

     القفل: الحادثة نفسها. `openIncident` بيعمل INSERT … ON CONFLICT DO
     NOTHING على (order_no, shipment_id, kind) وبيرجّع null لو الصف موجود
     — يعني كنستين في نفس اللحظة، واحدة بس بتكمّل. مفيش قفل تاني محتاجينه. */
  async function fallback(sh, due, out = {}) {
    const ops = courierOps();
    const dl = delivery();
    const orderNo = sh.shop_order_no;
    if (!ops || !dl) return null;
    const cfg = await cfgOf();
    const id = await ops.openIncident(orderNo, "cervo_trial_fallback", {
      shipmentId: Number(sh.id), provider: "cervo",
      reason: `تجربة Cervo: ${due.reason} — بنلغي عندهم وبنبعت للاجلك فوراً`,
      detail: { waitedMin: due.waitedMin, fallbackMin: cfg.fallbackMin, to: "leajlak", ref: sh.provider_ref || null },
      alert: true,
    });
    if (!id) return null;   // كنسة تانية سبقتنا

    let cancelErr = null;
    try {
      await dl.cancelShipment(orderNo, `Cervo trial: no driver within ${cfg.fallbackMin} min — switching to Leajlak`);
    } catch (e) { cancelErr = String(e?.message || e).slice(0, 200); }

    /* علامة على الشحنة نفسها عشان بطاقة النتيجة تقول «ده رجع للاجلك». */
    await pool.query(
      `UPDATE dl_shipments SET dispatch = dispatch || $2::jsonb WHERE id=$1`,
      [sh.id, J({ fellBackTo: "leajlak", fellBackAt: new Date().toISOString(), waitedMin: due.waitedMin })]
    ).catch(() => {});

    let row = null;
    try { row = await shop()?.getOrderRow?.(orderNo); } catch { row = null; }
    if (!row) {
      row = (await pool.query("SELECT * FROM shop_orders WHERE order_no=$1", [orderNo])).rows[0] || null;
    }
    if (!row) {
      await ops.openIncident(orderNo, "cervo_trial_fallback_failed", {
        shipmentId: Number(sh.id), provider: "cervo",
        reason: "تجربة Cervo: مالقيناش صف الطلب عشان نبعته للاجلك — ابعت من البوابة يدوي",
        detail: { cancelErr }, alert: true,
      });
      out.failed = (out.failed || 0) + 1;
      return { ok: false };
    }
    try {
      const res = await dl.dispatch(row, {
        provider: "leajlak", trigger: "cervo_trial_fallback", actor: "system",
        allowExisting: true, force: true,
      });
      /* الحادثة بتتقفل بـ«switch» ورسالة للعميل («بنرتّب مندوب — نعتذر عن
         التأخير») — نفس مسار «بدّل الشركة» اليدوي في البوابة بالظبط. */
      try { await ops.onRedispatch(orderNo, { provider: "leajlak", by: "system", switched: true }); } catch {}
      out.fellBack = (out.fellBack || 0) + 1;
      try { log.error(`[cervotrial] ${orderNo}: Cervo ${due.reason} → Leajlak (${res?.faOrderId || "?"})`); } catch {}
      return { ok: true, res };
    } catch (e) {
      const err = String(e?.message || e).slice(0, 250);
      await ops.openIncident(orderNo, "cervo_trial_fallback_failed", {
        shipmentId: Number(sh.id), provider: "cervo",
        reason: `تجربة Cervo: الإلغاء تم بس لاجلك رفضت الإرسال — ${err}`,
        detail: { cancelErr, error: err }, alert: true,
      });
      out.failed = (out.failed || 0) + 1;
      try { log.error(`[cervotrial] ${orderNo}: fallback to Leajlak FAILED: ${err}`); } catch {}
      return { ok: false, error: err };
    }
  }

  if (deps.timers !== false) {
    /* كل دقيقة، بإزاحة ٣٠ ث عن كنسة courierops عشان ما يتخانقوش على نفس
       الصفوف في نفس اللحظة. */
    const t = setInterval(() => { sweep(); }, 60_000);
    t.unref?.();
    const t0 = setTimeout(() => { sweep(); }, 50_000);
    t0.unref?.();
  }

  /* ═══ بطاقة النتيجة ═══════════════════════════════════════════════════
     شحنات التجربة + شحنات لاجلك في **نفس الفترة** على نفس المقاييس. */
  async function report({ days = 30 } = {}) {
    const all = await getSettingsData();
    const cfg = cervoTrialCfg(all);
    const since = cfg.startedAt || new Date(now() - Number(days) * 86400_000).toISOString();
    const q = `SELECT sh.id, sh.shop_order_no, sh.provider, sh.provider_ref, sh.status, sh.driver, sh.cost,
                      sh.created_at, sh.assigned_at, sh.arrived_at, sh.picked_at, sh.delivered_at, sh.dispatch,
                      (s.delivery_quote->>'routeKm')::float AS route_km
                 FROM dl_shipments sh JOIN shop_orders s ON s.order_no = sh.shop_order_no
                WHERE sh.created_at >= $1::timestamptz AND NOT COALESCE(s.is_test,false)
                  AND sh.provider = $2
                ORDER BY sh.id`;
    const cerv = (await pool.query(q, [since, "cervo"])).rows.map(shipmentMetrics);
    const lj = (await pool.query(q, [since, "leajlak"])).rows.map(shipmentMetrics);
    const trial = cerv.filter((r) => r.trial);
    const count = trial.length;
    return {
      cfg, since, count, target: cfg.target,
      remaining: Math.max(0, cfg.target - count),
      progress: `${count} من ${cfg.target}`,
      armed: cfg.enabled && count < cfg.target,
      /* التسعيرة المستعملة في حساب التكلفة — الشاشة بتقول «تقديري» بصوت
         عالي طول ما known=false. */
      contract: cervoContract(all.delivery || {}),
      cervo: { rows: trial, summary: summarize(trial) },
      cervoAll: { count: cerv.length, summary: summarize(cerv) },
      leajlak: { count: lj.length, summary: summarize(lj) },
      note: "المقارنة على نفس الفترة. تكلفة Cervo تقدير — شوف avgKm في الجنبين قبل الحكم.",
    };
  }

  app.get("/api/delivery/cervo-trial", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(120, Math.max(1, Number(c.req.query("days")) || 30));
    try { return c.json({ ok: true, ...(await report({ days })) }); }
    catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 500); }
  });

  /* المفتاح الواحد: إيقاف فوري. مابيلغيش شحنة شغّالة — بيوقف **الطلبات
     الجاية** بس، وشبكة الأمان بتفضل شغّالة على اللي في الطريق. */
  async function setEnabled(on, patch = {}, reason = null) {
    const cur = cervoTrialCfg(await getSettingsData());
    const next = {
      ...cur, ...patch,
      enabled: Boolean(on),
      startedAt: on ? (patch.startedAt || cur.startedAt || new Date(now()).toISOString()) : cur.startedAt,
      stoppedAt: on ? null : new Date(now()).toISOString(),
      stopReason: on ? null : (reason || "إيقاف يدوي من اللوحة"),
    };
    /* كتابة موضعية على الفرع بتاعنا بس. قراءة-تعديل-كتابة للكائن كله كانت
       هتدوس على أي إعداد تاني اتحفظ من اللوحة في نفس اللحظة. */
    await pool.query(
      `UPDATE settings
          SET data = jsonb_set(
                CASE WHEN COALESCE(data,'{}'::jsonb) ? 'delivery'
                     THEN data ELSE COALESCE(data,'{}'::jsonb) || '{"delivery":{}}'::jsonb END,
                '{delivery,cervoTrial}', $1::jsonb, true),
              updated_at = NOW()
        WHERE id=1`, [J(next)]);
    return cervoTrialCfg({ delivery: { cervoTrial: next } });
  }

  app.post("/api/delivery/cervo-trial/stop", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const cfg = await setEnabled(false, {}, b.reason ? String(b.reason).slice(0, 200) : null);
    return c.json({ ok: true, cfg, note: "التجربة اتوقفت — الطلبات الجاية بتروح للمسار العادي. شبكة الأمان لسه شغّالة على اللي في الطريق." });
  });

  app.post("/api/delivery/cervo-trial/start", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const patch = {};
    if (b.target != null) patch.target = Math.round(num(b.target, DEFAULT_CERVO_TRIAL.target, 1, 500));
    if (b.maxKm != null) patch.maxKm = num(b.maxKm, DEFAULT_CERVO_TRIAL.maxKm, 0.5, 50);
    if (b.fallbackMin != null) patch.fallbackMin = num(b.fallbackMin, DEFAULT_CERVO_TRIAL.fallbackMin, 1, 60);
    if (b.restart === true) patch.startedAt = new Date(now()).toISOString();
    if (!PROVIDERS.cervo || !PROVIDERS.cervo.configured()) {
      return c.json({ ok: false, error: "CERVO_TOKEN ناقص — مش هينفع نشغّل التجربة" }, 400);
    }
    const cfg = await setEnabled(true, patch);
    return c.json({ ok: true, cfg, ...(await report({})) });
  });

  app.post("/api/delivery/cervo-trial/sweep", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await sweep()) });
  });

  return { decide, sweep, fallback, report, trialCount, cfg: cfgOf, setEnabled };
}

export default { register, cervoTrialCfg, trialDecision, trialFallbackDue };
