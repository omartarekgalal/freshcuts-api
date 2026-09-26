/* ═══════════════════════════════════════════════════════════════════════════
   📟 التحكم في رسايل الإدارة + تقريرها (٢٦/٩)

   طلب عمر: «عايز اعرف كل التنبيهات الى بتوصل مدير الفرع في sms واتحكم فيها
   من لوحة التحكم بشكل سهل ويكون في تقرير بيها عشان نبدا نقللها … الفترة الى
   فاتت كنا بنشغلها عشان نشوف المشاكل اول باول».

   القياس اللي بدأنا منه (sms_log من ١٩/٩ لـ٢٥/٩، ٧ أيام):
     ٣٤٩ رسالة ≈ ٢٦٫٨ ر.س — المندوب ١٧٠ (٤٩٪، وكل واحدة لرقمين)، طلب جديد
     ١٠٥، تأخير التشغيل ٣٠، ربط الإعلانات ٢٢، تقرير يومي ١٢، تقييم سلبي ٦.
     المدير استلم ٢٢٠ والمالك ١٢٩.

   ── ليه هنا ────────────────────────────────────────────────────────────────
   فيه ١٢ مصدر بيبعتوا للإدارة (shop، courierops، checkoutwatch، adconnect،
   adsreport، reviews، content، cms…). كلهم بيعدّوا على accounts.sendSms بـ
   kind:"staff" ومرجع (ref) — فالبوابة في مكان واحد بتغطيهم كلهم، وأي مصدر
   جديد بيتغطّى لوحده.

   ── القواعد ────────────────────────────────────────────────────────────────
   • البوابة fail-open: أي خطأ فيها ⇒ الرسالة تتبعت. تنبيه حرج مايتقفلش بباج.
   • «test» دايماً بيعدّي (زرار التجربة في اللوحة).
   • التحكم على ٣ مستويات: النوع كله · كود جوّاه (مثلاً «المندوب بطيء») ·
     رقم معيّن (مثلاً المالك مايستلمش تأخير المندوب).
   • اللي اتمنع بيتعدّ في staff_alert_suppressed — عشان التقرير يقول «وفّرنا كام».
   • كل الإعدادات في settings.staffAlerts، والصلاحية «الإعدادات» (المالك).
═══════════════════════════════════════════════════════════════════════════ */
import { normStaffPhone, staffPhones } from "./staffalerts.js";

/* كتالوج الأنواع — الترتيب هنا هو ترتيب الشاشة. `critical` = قفله معناه إنك
   مش هتعرف بمشكلة بتضيّع فلوس دلوقتي؛ الشاشة بتنبّه قبل القفل. */
export const ALERT_TYPES = [
  { id: "new_order", label: "طلب جديد مدفوع", source: "shop.js",
    hint: "رسالة مع كل طلب أونلاين مدفوع. بتكبر مع عدد الطلبات — ٢٠٠ طلب في اليوم = ٢٠٠ رسالة في اليوم." },
  { id: "courier", label: "المندوب: تأخير أو رفض", source: "courierops.js",
    hint: "أكبر مصدر. بيتبعت لكل أرقام الإنذارات (المدير والمالك)، فكل تنبيه = رسالتين.",
    codes: {
      deliver_late: "التوصيل اتأخر عن المتوقع", arrive_slow: "المندوب بطيء في الطريق للمطعم",
      arrive_late: "المندوب وصل المطعم متأخر", far_risk: "العنوان بعيد — خطر رفض",
      refused_far: "لاجلك رفض العنوان البعيد",
    } },
  { id: "sla", label: "تأخير التشغيل (SLA)", source: "shop.js",
    hint: "الطلب عدّى الوقت المسموح في مرحلة معيّنة.",
    codes: {
      delivery_failed: "التوصيل فشل", handoff_breach: "التسليم للمندوب اتأخر",
      pickup_breach: "الاستلام من الفرع اتأخر", deliver_breach: "التوصيل عدّى الوقت",
    } },
  { id: "pos_failed", label: "طلب مدفوع مانزلش نقطة البيع", source: "shop.js", critical: true,
    hint: "العميل دفع والمطبخ مش شايف الطلب. لو اتقفل هتعرف من العميل." },
  { id: "total_mismatch", label: "إجمالي نقطة البيع مختلف عن المدفوع", source: "shop.js", critical: true,
    hint: "الفاتورة في نقطة البيع مش مطابقة للي العميل دفعه." },
  { id: "tabsense_down", label: "الربط مع تاب سينس وقع", source: "shop.js", critical: true,
    hint: "الطلبات مش هتنزل نقطة البيع لحد ما يرجع. بيتبعت مرة في الساعة بالكتير." },
  { id: "checkout", label: "الدفع في الموقع واقف / رجع", source: "checkoutwatch.js", critical: true,
    hint: "الحارس اللي اتعمل بعد عطل ٢٢/٩ (ساعتين من غير دفع).",
    codes: { down: "الدفع واقف", stalled: "الدفع متعطّل (ناس بتوصل ومحدش بيدفع)", up: "الدفع رجع" } },
  { id: "adconnect", label: "ربط منصات الإعلانات", source: "adconnect.js",
    hint: "توكن منصة إعلانات انتهى أو الربط وقع." },
  { id: "daily_report", label: "التقرير اليومي", source: "adsreport.js",
    hint: "ملخّص اليوم (مبيعات وإعلانات) — رسالة أو اتنين في اليوم." },
  { id: "review", label: "تقييم سلبي جديد", source: "reviews.js",
    hint: "عميل قيّم أقل من المطلوب على صفحة التقييم." },
  { id: "content_alert", label: "تنبيه المحتوى والسوشال", source: "content.js",
    hint: "مشكلة في النشر التلقائي على السوشال." },
  { id: "optout_brake", label: "فرملة إيقاف الاشتراك", source: "cms.js", critical: true,
    hint: "حملة SMS اتوقفت لوحدها لأن ناس كتير ألغت الاشتراك." },
];
const TYPE_BY_ID = Object.fromEntries(ALERT_TYPES.map((t) => [t.id, t]));

/* المرجع (ref) ⇒ { type, code }. لازم يطابق كل مكان بينادي sendSms بـkind:"staff". */
export function typeOfRef(ref) {
  const r = String(ref || "").trim();
  const w = r.split(/\s+/);
  if (/^test$/.test(r)) return { type: "test", code: null };
  if (/^new-order\b/.test(r)) return { type: "new_order", code: null };
  if (/^pos-failed\b/.test(r)) return { type: "pos_failed", code: null };
  if (/^total-mismatch\b/.test(r)) return { type: "total_mismatch", code: null };
  if (/^sla\s/.test(r)) return { type: "sla", code: w[2] || null };              // sla <order> <code>
  if (/^courier\s/.test(r)) return { type: "courier", code: w[1] || null };      // courier <code> <order>
  if (/^tabsense-down$/.test(r)) return { type: "tabsense_down", code: null };
  if (/^checkout-/.test(r)) return { type: "checkout", code: r.slice(9) || null }; // checkout-down|stalled|up
  if (/^adconnect\b/.test(r)) return { type: "adconnect", code: null };
  if (/^daily_report$/.test(r)) return { type: "daily_report", code: null };
  if (/^optout_brake$/.test(r)) return { type: "optout_brake", code: null };
  if (/^content_alert$/.test(r)) return { type: "content_alert", code: null };
  if (/^review:/.test(r)) return { type: "review", code: null };
  return { type: "other", code: w[0] || null };
}

/* settings.staffAlerts ⇒ شكل ثابت */
export function controlCfg(settings) {
  const s = (settings && settings.staffAlerts) || {};
  const types = {};
  for (const [id, v] of Object.entries(s.types || {})) {
    if (!v || typeof v !== "object") continue;
    types[id] = {
      enabled: v.enabled !== false,
      mute: staffPhones(v.mute || []),
      codes: Object.fromEntries(Object.entries(v.codes || {}).map(([k, on]) => [k, on !== false])),
    };
  }
  const phoneNames = {};
  for (const [p, n] of Object.entries(s.phoneNames || {})) {
    const pn = normStaffPhone(p);
    if (pn && n) phoneNames[pn] = String(n).slice(0, 40);
  }
  return { types, phoneNames };
}

/* القرار: الرسالة دي للرقم ده تتبعت ولا لأ؟ */
export function allowStaff(settings, ref, phoneNorm) {
  const { type, code } = typeOfRef(ref);
  if (type === "test") return true;
  const t = controlCfg(settings).types[type];
  if (!t) return true;
  if (!t.enabled) return false;
  if (code && t.codes[code] === false) return false;
  const pn = normStaffPhone(phoneNorm);
  if (pn && t.mute.includes(pn)) return false;
  return true;
}

/* تجميع صفوف sms_log (kind='staff') للتقرير. نفس typeOfRef اللي بتقرر البوابة
   بيها — فالتقرير والتحكم مايختلفوش أبداً على «النوع ده إيه». */
export function aggregate(rows, suppressedRows, days, now = Date.now()) {
  const byType = new Map();
  const daily = new Map();
  const phones = new Map();
  let n = 0, cost = 0;
  const T = (id) => {
    if (!byType.has(id)) byType.set(id, { id, n: 0, parts: 0, cost: 0, lastAt: null, byPhone: {}, byCode: {}, suppressed: 0 });
    return byType.get(id);
  };
  for (const r of rows || []) {
    const { type, code } = typeOfRef(r.ref);
    const t = T(type);
    const c = Number(r.cost) || 0;
    t.n++; t.parts += Number(r.parts) || 1; t.cost += c;
    if (!t.lastAt || String(r.at) > String(t.lastAt)) t.lastAt = r.at;
    const pn = normStaffPhone(r.phone_norm) || "?";
    t.byPhone[pn] = (t.byPhone[pn] || 0) + 1;
    if (code) t.byCode[code] = (t.byCode[code] || 0) + 1;
    phones.set(pn, (phones.get(pn) || 0) + 1);
    const d = new Date(new Date(r.at).getTime() + 3 * 3600_000).toISOString().slice(0, 10);   // يوم الرياض
    const dd = daily.get(d) || { d, n: 0, cost: 0 };
    dd.n++; dd.cost += c; daily.set(d, dd);
    n++; cost += c;
  }
  let suppressed = 0;
  for (const s of suppressedRows || []) {
    const k = Number(s.n) || 0;
    T(s.type).suppressed += k; suppressed += k;
  }
  const avgCost = n ? cost / n : 0.0765;
  const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  const spanDays = Math.max(1, Math.min(days, daily.size || 1));
  return {
    totals: { n, cost: round(cost), perDay: round(n / spanDays, 1), costPerDay: round(cost / spanDays),
      monthly: round((cost / spanDays) * 30, 2), suppressed, saved: round(suppressed * avgCost), spanDays },
    types: [...byType.values()].map((t) => ({ ...t, cost: round(t.cost) })).sort((a, b) => b.n - a.n),
    daily: [...daily.values()].map((x) => ({ ...x, cost: round(x.cost) })).sort((a, b) => a.d.localeCompare(b.d)),
    phones: [...phones.entries()].map(([pn, k]) => ({ pn, n: k })).sort((a, b) => b.n - a.n),
  };
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS staff_alert_suppressed (
      day DATE NOT NULL, type TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      n INT NOT NULL DEFAULT 0, PRIMARY KEY (day, type, code, phone)
    );`).catch((e) => log.error?.(`[staffcontrol] schema: ${e.message}`));

  /* البوابة — accounts.setStaffGate(gate). fail-open في كل خطوة. */
  async function gate({ ref, phoneNorm }) {
    let ok = true;
    try { ok = allowStaff(await getSettingsData(), ref, phoneNorm); } catch { return true; }
    if (!ok) {
      const { type, code } = typeOfRef(ref);
      ready.then(() => pool.query(
        `INSERT INTO staff_alert_suppressed(day, type, code, phone, n)
         VALUES ((NOW() AT TIME ZONE 'Asia/Riyadh')::date, $1, $2, $3, 1)
         ON CONFLICT (day, type, code, phone) DO UPDATE SET n = staff_alert_suppressed.n + 1`,
        [type, code || "", normStaffPhone(phoneNorm) || ""])).catch(() => {});
    }
    return ok;
  }

  app.get("/api/cms/staff-alerts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
    const s = (await getSettingsData()) || {};
    const rows = (await pool.query(
      `SELECT at, phone_norm, ref, parts, cost FROM sms_log
        WHERE kind='staff' AND status='sent' AND at > NOW() - ($1 || ' days')::interval`, [String(days)])).rows;
    const sup = (await pool.query(
      `SELECT type, sum(n)::int n FROM staff_alert_suppressed
        WHERE day > (NOW() AT TIME ZONE 'Asia/Riyadh')::date - $1::int GROUP BY 1`, [days])).rows;
    const first = (await pool.query(`SELECT min(at) f FROM sms_log WHERE kind='staff'`)).rows[0]?.f || null;
    const agg = aggregate(rows, sup, days);
    const cfg = controlCfg(s);
    const d = s.delivery || {};
    const known = new Set([...staffPhones(d.alertPhones), ...staffPhones(d.newOrderPhones), ...agg.phones.map((p) => p.pn)]);
    known.delete("?");
    return c.json({
      ok: true, days, logSince: first,
      catalogue: ALERT_TYPES,
      cfg,
      recipients: {
        alertPhones: staffPhones(d.alertPhones), newOrderPhones: staffPhones(d.newOrderPhones),
        newOrderSms: d.newOrderSms !== false,
      },
      phones: [...known].map((pn) => ({ pn, name: cfg.phoneNames[pn] || null, n: agg.phones.find((p) => p.pn === pn)?.n || 0 })),
      ...agg,
    });
  });

  /* بيدمج: types[id] بيتبدّل كله للنوع اللي اتبعت بس، والباقي زي ما هو. */
  app.post("/api/cms/staff-alerts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const cur = ((await getSettingsData()) || {}).staffAlerts || {};
    const next = { ...cur, types: { ...(cur.types || {}) }, phoneNames: { ...(cur.phoneNames || {}) } };
    for (const [id, v] of Object.entries((b && b.types) || {})) {
      if (!TYPE_BY_ID[id] || !v || typeof v !== "object") continue;
      next.types[id] = {
        enabled: v.enabled !== false,
        mute: staffPhones(v.mute || []),
        codes: Object.fromEntries(Object.entries(v.codes || {}).filter(([k]) => /^[a-z_]{2,30}$/.test(k)).map(([k, on]) => [k, on !== false])),
      };
    }
    for (const [p, n] of Object.entries((b && b.phoneNames) || {})) {
      const pn = normStaffPhone(p);
      if (!pn) continue;
      if (n) next.phoneNames[pn] = String(n).slice(0, 40); else delete next.phoneNames[pn];
    }
    next.updatedAt = new Date().toISOString();
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{staffAlerts}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
    return c.json({ ok: true, cfg: controlCfg({ staffAlerts: next }) });
  });

  return { gate };
}
