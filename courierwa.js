/* ═══════════════════════════════════════════════════════════════════════════
   CW1 — أزرار المندوب الخارجي على واتساب (عمر ١٦/١٠ ١٤:٢٥):
   «المندوب بيكون عنده صعوبة انه يضغط ع اللينك. لو ينفع نبعتله رسالة على الواتس فيها الأزرار
    اللي بنحتاجها بحيث يكون سهل عليه من الواتساب».

   اللي بيحصل:
   ١) المدير بيسجّل «🛵 مندوب من بره» (اسم + جوال) في البوابة ⇒ courierops بيعمل الشحنة والرابط زي الأول،
      وبعدها sendJob() بيبعت للمندوب **من رقم المطعم**:
        • النافذة مفتوحة (المندوب كلّمنا آخر ٢٤ ساعة) ⇒ رسالة حرة ببلاش: بيانات الطلب (نفس نص couriers.js:
          العنوان المقروء + دبوس الخريطة + ملاحظات التوصيل + الباب + «مدفوع مسبقاً») + أزرار المرحلة.
        • النافذة مقفولة + القالب fc_courier_job_v1 اتعتمد واتفتح من اللوحة ⇒ القالب بـ٣ ردود سريعة.
        • غير كده ⇒ مابنبعتش، والبوابة بتفتح الواتساب اليدوي (wa.me) زي النهارده بالظبط — ومعاه سطر
          «تبي الأزرار على الواتساب؟» برابط لرقمنا ورسالة جاهزة فيها رمز الرحلة: المندوب يضغط إرسال ⇒
          النافذة بتتفتح ⇒ بنرد عليه بالأزرار ببلاش.
   ٢) الأزرار (أقصى ٣ في الرسالة — قيد ميتا): «استلمت الطلب» ⇒ بعدها «وصلت عند العميل» + «تم التسليم» ⇒ …
      كل ضغطة بتمشي على **نفس** دوال صفحة /d/ (courierlive.extStart/extArrived/extDelivered) ⇒ البوابة
      وصفحة تتبّع العميل ورسايل العميل بيتحرّكوا زي ما المندوب ضغط من الرابط. «تم التسليم» بدري (قبل
      confirmMin دقيقة من الاستلام) بتسأل تأكيد الأول — درس ١٠/١٠ («العميل استلم» اتضغطت مع «استلم»).
      «عندي مشكلة» ⇒ إشعار لأجهزة المديرين + سطر في سجل الطلب.
   ٣) الـpayload بتاع كل زر: cw1.<رقم الرحلة>.<الفعل>.<توقيع> — HMAC بسر السيرفر + hash توكن الرحلة.
      يعني: محدش يقدر يولّد زر لرحلة تانية، و«رابط جديد» من البوابة (توكن جديد) بيموّت الأزرار القديمة.
      وقواعد التوكن نفس /d/: ملغي ⇒ ولا حاجة · اتسلّم ⇒ خلاص · انتهى ⇒ «تم التسليم» بس اللي بيعدّي.
   ٤) رقم المندوب بيتعامل كمندوب: أي رسالة منه على رحلة شغّالة البوت مابيردّش عليها (claim في whatsapp.js)،
      والرسالة بتفضل في صندوق واتساب للموظفين.
      حارس (مراجعة CW1): جوال عميل الطلب نفسه عمره ما بياخد كارت/أزرار/رابط /d/ (reason customer_phone ⇒ البوابة بتقول
      «ده جوال العميل نفسه — اكتب جوال المندوب»)، ورسايله العادية مابتتسحبش من البوت. ورقم الفريق (teamPhones) رسايله العادية
      وأزرار wateam بتروح للبوت/wateam زي الأول — الضغطات الموقّعة cw1.* بس هي اللي بتتمسك.
   كل رسالة رايحة للمندوب ليها صف في wa_messages برقم الطلب + سطر في سجل الطلب (courier_manual).
   المفاتيح كلها في اللوحة: «كل إعدادات البوت ← 🛵 المندوب الخارجي: الأزرار على واتساب» (waBot.courierJob).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { handoffText, localPhone } from "./courierlive.js";
import { readableAddress } from "./couriers.js";
import { emitOrder } from "./order-events.js";
import { pushPayload } from "./portal-core.js";
import { teamPhones } from "./phonelists.js";

export { CW_TEMPLATE, COURIER_JOB_TEMPLATES, COURIER_JOB_DEFAULTS, courierJobConfig, courierJobFromBody, COURIER_JOB_SCHEMA, COURIER_JOB_SCHEMA_GROUP } from "./courierwa-cfg.js";
import { courierJobConfig, COURIER_JOB_DEFAULTS } from "./courierwa-cfg.js";
export const OUR_NUMBER = "966546715683";
const PORTAL_URL = "https://freshcuts-invite.o2m8.me/portal/";

/* ── الأزرار والتوقيع ─────────────────────────────────────────────────────
   نص الزر ≤ ٢٠ حرف (حد ميتا للأزرار الحرة)، من غير إيموجي (عشان نفس النص ينفع في القالب). */
export const BTN = Object.freeze({ p: "استلمت الطلب", a: "وصلت عند العميل", d: "تم التسليم", D: "إيه، سلّمته", n: "لا، لسا", x: "عندي مشكلة" });
const ACTS = Object.keys(BTN).join("");
const secret = () => String(process.env.SECRETS_KEY || process.env.ADMIN_TOKEN || "fc-courier-wa");
export function cwSig(runId, act, tokenHash, len = 16) {
  return crypto.createHmac("sha256", secret()).update(`cw1|${runId}|${act}|${tokenHash || ""}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, len);
}
export const cwPayload = (run, act) => `cw1.${Number(run.id)}.${act}.${cwSig(Number(run.id), act, run.token_hash)}`;
const PAYLOAD_RE = new RegExp(`^cw1\\.(\\d{1,15})\\.([${ACTS}])\\.([A-Za-z0-9]{16})$`);
export function parseCwPayload(s) {
  const m = PAYLOAD_RE.exec(String(s || "").trim());
  return m ? { runId: Number(m[1]), act: m[2], sig: m[3] } : null;
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const verifyCw = (p, run) => Boolean(p && run && Number(run.id) === p.runId && run.token_hash && same(p.sig, cwSig(p.runId, p.act, run.token_hash)));

/* رمز «ابعتلي الأزرار» في رسالة الواتساب اليدوي: FC-<رقم الرحلة>-<توقيع ١٠> */
export const openerCode = (run) => `FC-${Number(run.id)}-${cwSig(Number(run.id), "o", run.token_hash, 10)}`;
export function parseOpener(text) {
  const m = /FC-(\d{1,15})-([A-Za-z0-9]{10})/.exec(String(text || ""));
  return m ? { runId: Number(m[1]), sig: m[2] } : null;
}
export const verifyOpener = (o, run) => Boolean(o && run && Number(run.id) === o.runId && run.token_hash && same(o.sig, cwSig(o.runId, "o", run.token_hash, 10)));
export function openerLine(run, orderNo, number = OUR_NUMBER) {
  const n = String(number || OUR_NUMBER).replace(/\D/g, "") || OUR_NUMBER;
  const msg = `أبي أزرار توصيل الطلب ${orderNo} (${openerCode(run)})`;
  return `📲 تبي أزرار «استلمت الطلب» و«تم التسليم» على الواتساب بدل الرابط؟ اضغط هنا وأرسل الرسالة:\nhttps://wa.me/${n}?text=${encodeURIComponent(msg)}`;
}

/* سعودي ⇒ ٥XXXXXXXX، غير كده null (قنوات واتساب عندنا كلها على phone_norm السعودي) */
export function pn9(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? d : null;
}

/* جوال عميل الطلب نفسه (٩ أرقام) — مراجعة CW1: لو المدير كتب جوال العميل في «جواله» بالغلط، الكارت بأزرار «تم التسليم» ورابط /d/
   كان هيروح للعميل نفسه، ورسايل العميل («وين طلبي؟») كانت هتتسحب من البوت. ده الحارس. */
export function customerPn(row) {
  if (!row) return null;
  const c = row.customer && typeof row.customer === "object" ? row.customer : {};
  return pn9(row.phone_norm) || pn9(c.phone) || null;
}

export const stageOf = (run) => (run.delivered_at ? "delivered" : run.arrived_at ? "arrived" : run.started_at ? "started" : "new");
export function buttonsFor(stage, cfg = COURIER_JOB_DEFAULTS) {
  const x = cfg.problemButton ? ["x"] : [];
  if (stage === "new") return ["p", ...x];
  if (stage === "started") return [...(cfg.arrivedButton ? ["a"] : []), "d", ...x];
  if (stage === "arrived") return ["d", ...x];
  return [];
}
const cut = (s, n) => { const a = [...String(s || "")]; return a.length > n ? `${a.slice(0, n - 1).join("")}…` : a.join(""); };
const pinOf = (order) => {
  const a = (order && order.address) || {};
  const lat = Number(a.latitude ?? a.lat), lng = Number(a.longitude ?? a.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}` : null;
};

/* ── النصوص (للمندوب ⇒ لهجة بيضا) ─────────────────────────────────────── */
export function jobCardText(order, { link = null, stage = "new" } = {}) {
  const L = [handoffText(order, { link: null })];
  L.push("");
  if (stage === "new") L.push("👇 اضغط «استلمت الطلب» أول ما تستلمه من المطعم، وبعدها نرسل لك زر «تم التسليم».");
  else if (stage === "started") L.push("✅ مسجّل إنك استلمت الطلب. بعد ما تسلّمه للعميل اضغط «تم التسليم» 👇");
  else if (stage === "arrived") L.push("📍 مسجّل إنك عند العميل. بعد ما تسلّمه اضغط «تم التسليم» 👇");
  if (link) { L.push(""); L.push(`(اختياري) شارك موقعك المباشر من هنا: ${link}`); }
  return cut(L.join("\n"), 1024);
}
export function stageReply(kind, order, { no = null } = {}) {
  const n = no || (order && order.order_no) || "";
  const pin = order ? pinOf(order) : null;
  const addr = order ? readableAddress({ ...((order && order.address) || {}), leave_at_door: false }, { withPin: false }) : "";
  switch (kind) {
    case "started": return [`تمام ✅ سجّلنا إنك استلمت الطلب ${n}.`, pin ? `📍 الموقع: ${pin}` : null, addr && addr !== "موقع العميل — اتبع الإحداثيات" ? `العنوان: ${addr}` : null,
      "لما توصل عند العميل اضغط «وصلت عند العميل»، وبعد التسليم اضغط «تم التسليم»."].filter(Boolean).join("\n");
    case "arrived": return `تمام 📍 سجّلنا وصولك عند العميل (الطلب ${n}). بعد ما تسلّمه اضغط «تم التسليم».`;
    case "confirm": return `متأكد إنك سلّمت الطلب ${n} للعميل؟ الزر هذا يبلّغ العميل إن طلبه وصل.`;
    case "delivered": return `شكراً لك 🙏 تم تسجيل تسليم الطلب ${n}.`;
    case "notyet": return `تمام، اضغط «تم التسليم» بعد ما تسلّم الطلب ${n} للعميل.`;
    case "problem": return `وصلنا بلاغك 🙏 المطعم راح يتواصل معك الحين بخصوص الطلب ${n}، وتقدر تكتب المشكلة هنا.`;
    case "revoked": return `الطلب ${n} ما عاد مسجّل عليك. لو فيه شي كلّم المطعم.`;
    case "expired": return `انتهت صلاحية أزرار الطلب ${n}. كلّم المطعم لو تحتاج شي.`;
    case "done": return `الطلب ${n} مسجّل متسلّم من قبل ✅ شكراً لك.`;
    case "taken": return `الطلب ${n} مسجّل على مندوب ثاني. لو فيه شي كلّم المطعم.`;
    default: return "";
  }
}
export function cwMessage(body, acts, run) {
  const list = (acts || []).slice(0, 3);
  if (!list.length || !run) return { type: "text", text: { body: cut(body, 4096), preview_url: false } };
  return { type: "interactive", interactive: { type: "button", body: { text: cut(body, 1024) },
    action: { buttons: list.map((a) => ({ type: "reply", reply: { id: cwPayload(run, a), title: BTN[a] } })) } } };
}
export function templateParams(order, run) {
  const cust = (order && order.customer && typeof order.customer === "object") ? order.customer : {};
  const addr = readableAddress({ ...((order && order.address) || {}), leave_at_door: false }, { withPin: false });
  return {
    body: [order.order_no, cust.name || "العميل", localPhone(order.phone_norm || cust.phone) || "—",
      addr || "اتبع الموقع على الخريطة", pinOf(order) || "ما فيه دبوس، كلّم العميل"],
    button: [],
    quickReplies: ["p", "a", "d"].map((a) => cwPayload(run, a)),
  };
}
export const REASON_AR = Object.freeze({
  disabled: "الأزرار مقفولة من اللوحة", no_run: "مفيش رابط مندوب على الطلب", not_live: "رحلة المندوب خلصت أو اتلغت",
  no_phone: "مفيش جوال للمندوب", not_saudi_mobile: "جوال المندوب مش سعودي — واتساب يدوي بس",
  window_closed: "المندوب ماكلّمناش آخر ٢٤ ساعة والقالب لسه مش متفعّل — اتفتح الواتساب اليدوي",
  not_courier: "الحارس مالقاش الرقم على رحلة شغّالة", unknown_template: "القالب مش متسجّل",
  customer_phone: "ده جوال العميل نفسه — اكتب جوال المندوب",
});
export const reasonAr = (r) => REASON_AR[r] || (r ? `ماوصلش (${String(r).slice(0, 40)})` : null);

/* ═══════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, jb } = ctx;
  const log = ctx.log || console;
  const wa = typeof deps.wa === "function" ? deps.wa : () => deps.wa || null;
  const cl = typeof deps.courierLive === "function" ? deps.courierLive : () => deps.courierLive || null;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const portal = typeof deps.portal === "function" ? deps.portal : () => deps.portal || null;
  const emit = deps.emitOrder || emitOrder;
  const now = deps.now || (() => Date.now());
  const J = jb || ((v) => JSON.stringify(v));

  const settingsNow = async () => { try { return (await getSettingsData()) || {}; } catch { return {}; } };
  const cfgOf = (s) => courierJobConfig(s && s.waBot && s.waBot.courierJob);

  let schemaOk = null;
  async function ensureSchema() {
    if (schemaOk) return true;
    try {
      const base = cl();
      if (base && base.ensureSchema && !(await base.ensureSchema())) return false;
      await pool.query(`
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_phone TEXT;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_sent_at TIMESTAMPTZ;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_via TEXT;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_error TEXT;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_last_tap TEXT;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS wa_last_tap_at TIMESTAMPTZ;
        ALTER TABLE dl_ext_runs ADD COLUMN IF NOT EXISTS problem_at TIMESTAMPTZ;
      `);
      schemaOk = true;
    } catch (e) {
      log.error?.(`[courierwa] schema failed: ${e?.message || e}`);
      schemaOk = null;      // نحاول تاني المرة الجاية
      return false;
    }
    return true;
  }
  if (deps.boot !== false) setTimeout(() => { ensureSchema().catch(() => {}); }, 1500).unref?.();

  const isExpired = (run) => new Date(run.expires_at).getTime() <= now();
  const isLive = (run) => run && !run.revoked_at && !run.delivered_at && !isExpired(run);
  const timeline = (orderNo, summary, data = {}) => {
    try { emit("courier_manual", { orderNo, source: "staff", ok: data.ok !== false, summary, data: { provider: "external", via: "courier_wa", ...data } }); } catch {}
  };
  const shipEvent = (run, event, note) => pool.query(
    "UPDATE dl_shipments SET events = events || $2::jsonb WHERE id=$1",
    [run.shipment_id, J([{ at: new Date(now()).toISOString(), provider: "external", event, via: "courier_wa", note: note || null }])]).catch(() => {});

  async function latestRun(orderNo) {
    const r = await pool.query(
      `SELECT r.*, sh.status AS ship_status FROM dl_ext_runs r JOIN dl_shipments sh ON sh.id = r.shipment_id
        WHERE r.order_no=$1 AND sh.provider='external' ORDER BY r.id DESC LIMIT 1`, [String(orderNo)]);
    return r.rows[0] || null;
  }
  async function liveRunForPhone(pn) {
    const r = await pool.query(
      `SELECT r.* FROM dl_ext_runs r
        WHERE right(regexp_replace(COALESCE(r.courier_phone,''), '[^0-9]', '', 'g'), 9) = $1
          AND r.revoked_at IS NULL AND r.delivered_at IS NULL AND r.expires_at > NOW()
          AND r.created_at > NOW() - INTERVAL '12 hours'
        ORDER BY r.id DESC LIMIT 1`, [pn]);
    return r.rows[0] || null;
  }

  /* رسايل المندوب بتتسجّل في wa_messages بمصدر "courier" ومن غير order_no/stage عن قصد: تقارير «رسايل الطلب» (wapolicy.orderMessagesReport)
     وفاصل «قالب مدفوع قريب» قبل طلب التقييم (reviewDecision) بيعدّوا صفوف الطلب — ورسالة المندوب مش رسالة للعميل. سجل الطلب نفسه بياخد سطر
     لكل رسالة من timeline() (courier_manual). */
  async function freeSend(pn, run, body, acts) {
    const w = wa();
    if (!w || !w.sendFreeform) return { ok: false, skipped: "unavailable" };
    const payload = cwMessage(body, acts, run);
    try {
      return await w.sendFreeform({ phoneNorm: pn, payload, source: "courier", preview: cut(body, 500) });
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }

  /* رسالة الطلب الكاملة بأزرار المرحلة الحالية: حرة جوّه النافذة، أو القالب بره النافذة (لو متفعّل). */
  async function sendCard(run, pn, { link = null, cfg, allowTemplate = true, why = "register" } = {}) {
    const sp = shop();
    const row = sp ? await sp.getOrderRow(run.order_no) : null;
    if (!row) return { sent: false, reason: "not_found" };
    if (pn === customerPn(row)) {
      /* جوال المندوب = جوال العميل ⇒ مانبعتش للعميل كارت «تم التسليم» ولا رابط /d/ — البوابة بترجع للواتساب اليدوي وبتعرض السبب */
      await pool.query("UPDATE dl_ext_runs SET wa_error=$2 WHERE id=$1", [run.id, "customer_phone"]).catch(() => {});
      timeline(run.order_no, `واتساب الأزرار ماتبعتش: ${reasonAr("customer_phone")}`, { ok: false, stage: "wa_job", reason: "customer_phone", why });
      try { portal()?.scheduleRefresh?.(run.order_no); } catch {}
      return { sent: false, via: null, reason: "customer_phone", reasonAr: reasonAr("customer_phone"), wamid: null };
    }
    const stage = stageOf(run);
    const body = jobCardText(row, { link, stage });
    let r = await freeSend(pn, run, body, buttonsFor(stage, cfg));
    let via = "free";
    if (!r.ok && r.skipped === "window_closed" && allowTemplate && cfg.useTemplate && stage !== "delivered") {
      const w = wa();
      via = "template";
      try {
        r = await w.sendTemplate({ phoneNorm: pn, template: cfg.templateName, params: templateParams(row, run), source: "courier", courier: true });
      } catch (e) { r = { ok: false, error: String(e?.message || e).slice(0, 120) }; }
    }
    const reason = r.ok ? null : String(r.skipped || r.error || "send_failed").slice(0, 60);
    await pool.query(
      `UPDATE dl_ext_runs SET wa_phone=$2, wa_via=$3, wa_error=$4, wa_sent_at = CASE WHEN $5 THEN NOW() ELSE wa_sent_at END WHERE id=$1`,
      [run.id, pn, r.ok ? via : null, reason, Boolean(r.ok)]).catch(() => {});
    await shipEvent(run, r.ok ? "wa_job_sent" : "wa_job_failed", r.ok ? (via === "template" ? "قالب" : "رسالة حرة") : reason);
    timeline(run.order_no, r.ok
      ? `اتبعت للمندوب الخارجي واتساب بالأزرار من رقم المطعم (${via === "template" ? "قالب" : "رسالة حرة"})`
      : `واتساب الأزرار ماوصلش للمندوب: ${reasonAr(reason)}`, { ok: Boolean(r.ok), stage: "wa_job", channel: via, reason, why });
    try { portal()?.scheduleRefresh?.(run.order_no); } catch {}
    return { sent: Boolean(r.ok), via: r.ok ? via : null, reason, reasonAr: reasonAr(reason), wamid: r.wamid || null };
  }

  /* المدخل من البوابة: بعد تسجيل «مندوب من بره» / كتابة جوال المندوب / زر «ابعتله الأزرار». مابيرميش. */
  async function sendJob(orderNo, { link = null, by = null, why = "register" } = {}) {
    try {
      const cfg = cfgOf(await settingsNow());
      if (!cfg.enabled) return { sent: false, reason: "disabled", reasonAr: reasonAr("disabled") };
      if (!(await ensureSchema())) return { sent: false, reason: "unavailable" };
      const run = await latestRun(orderNo);
      if (!run) return { sent: false, reason: "no_run", reasonAr: reasonAr("no_run") };
      if (!isLive(run)) return { sent: false, reason: "not_live", reasonAr: reasonAr("not_live") };
      const pn = pn9(run.courier_phone);
      if (!pn) {
        const reason = run.courier_phone ? "not_saudi_mobile" : "no_phone";
        return { sent: false, reason, reasonAr: reasonAr(reason) };
      }
      const r = await sendCard(run, pn, { link, cfg, why });
      return { ...r, by: by || null, opener: !r.sent && cfg.openerLink && r.reason !== "customer_phone" };
    } catch (e) {
      log.error?.(`[courierwa] sendJob ${orderNo} failed: ${e?.message || e}`);
      return { sent: false, reason: "failed" };
    }
  }

  /* سطر «تبي الأزرار على الواتساب؟» لرسالة الواتساب اليدوي (courierlive.makeHandoff بينادي هنا) */
  async function openerFor(run, orderNo, settings = null) {
    try {
      const s = settings || await settingsNow();
      const cfg = cfgOf(s);
      if (!cfg.enabled || !cfg.openerLink || !run || !run.token_hash) return null;
      const cpn = pn9(run.courier_phone);
      if (cpn) {
        const sp = shop();
        const row = sp ? await sp.getOrderRow(orderNo).catch(() => null) : null;
        if (cpn === customerPn(row)) return null;      // جوال العميل نفسه — مانحطّلوش رابط أزرار المندوب
      }
      const num = String((s.waBot && s.waBot.followNumber) || OUR_NUMBER).replace(/\D/g, "");
      return openerLine(run, orderNo, /^9665\d{8}$/.test(num) ? num : OUR_NUMBER);
    } catch { return null; }
  }

  async function alertManagers(run, row) {
    const no = run.order_no;
    try {
      const p = portal();
      if (p && p.push && p.push.sendToSubs) {
        await p.push.sendToSubs(pushPayload("courier_problem", { orderNo: no,
          title: `⚠️ المندوب الخارجي عنده مشكلة — ${no}`,
          body: `${run.courier_name || "المندوب"} ضغط «عندي مشكلة» من الواتساب — كلّمه${run.courier_phone ? ` (${localPhone(run.courier_phone)})` : ""}` }, PORTAL_URL),
        { role: "manager" });
      }
    } catch (e) { log.error?.(`[courierwa] problem push ${no}: ${e?.message || e}`); }
    void row;
  }

  /* ضغطة زر من المندوب */
  async function handleTap(ev, p) {
    const base = cl();
    if (!base || !base.runById) return;
    const run = await base.runById(p.runId);
    if (!run || !verifyCw(p, run)) { log.warn?.(`[courierwa] bad payload run=${p.runId}`); return; }
    const pn = ev.phoneNorm;
    const owner = pn9(run.wa_phone || run.courier_phone);
    if (!owner || owner !== pn) { log.warn?.(`[courierwa] tap from another phone on run ${run.id}`); return; }
    const sp = shop();
    const row = sp ? await sp.getOrderRow(run.order_no) : null;
    if (pn === customerPn(row)) { log.warn?.(`[courierwa] tap from the order's own customer on run ${run.id} — ignored`); return; }
    await ensureSchema();
    await pool.query("UPDATE dl_ext_runs SET wa_last_tap=$2, wa_last_tap_at=NOW() WHERE id=$1", [run.id, p.act]).catch(() => {});
    const cfg = cfgOf(await settingsNow());
    const no = run.order_no;
    const say = (kind, acts = []) => freeSend(pn, run, stageReply(kind, row, { no }), acts);
    if (run.revoked_at) { await say("revoked"); return; }
    if (run.delivered_at) { await say("done"); return; }
    if (isExpired(run) && !["d", "D", "x", "n"].includes(p.act)) { await say("expired"); return; }
    const fresh = async () => (await base.runById(run.id)) || run;
    if (p.act === "p") {
      await base.extStart(run, { via: "wa_button" });
      const r2 = await fresh();
      await say("started", buttonsFor(stageOf(r2), cfg));
    } else if (p.act === "a") {
      if (!run.started_at) await base.extStart(run, { via: "wa_button" });
      await base.extArrived(run, { via: "wa_button" });
      const r2 = await fresh();
      await say("arrived", buttonsFor(stageOf(r2), cfg));
    } else if (p.act === "d" || p.act === "D") {
      const started = run.started_at ? new Date(run.started_at).getTime() : null;
      const early = cfg.confirmMin > 0 && (!started || now() - started < cfg.confirmMin * 60_000);
      if (p.act === "d" && early) { await say("confirm", ["D", "n"]); return; }
      const r = await base.extDelivered(run, { via: "wa_button" });
      if (!r.ok) { log.error?.(`[courierwa] deliver ${no}: ${r.error}`); return; }
      await say("delivered");
    } else if (p.act === "n") {
      await say("notyet", buttonsFor(stageOf(run), cfg));
    } else if (p.act === "x") {
      await pool.query("UPDATE dl_ext_runs SET problem_at=NOW() WHERE id=$1", [run.id]).catch(() => {});
      await shipEvent(run, "ext_problem", "المندوب ضغط «عندي مشكلة» من الواتساب");
      timeline(no, "المندوب الخارجي ضغط «عندي مشكلة» من الواتساب — كلّمه", { stage: "problem" });
      await alertManagers(run, row);
      try { portal()?.scheduleRefresh?.(no); } catch {}
      await say("problem", buttonsFor(stageOf(run), cfg).filter((a) => a !== "x"));
    }
  }

  /* المندوب بعت رسالة «أبي أزرار توصيل الطلب … (FC-…)» من رابط الواتساب اليدوي */
  async function handleOpener(ev, o, cfg) {
    const base = cl();
    const run = base && base.runById ? await base.runById(o.runId) : null;
    if (!run || !verifyOpener(o, run)) return false;
    const pn = ev.phoneNorm;
    const sp = shop();
    const row = sp ? await sp.getOrderRow(run.order_no) : null;
    if (pn === customerPn(row)) {
      /* العميل نفسه بعت الرمز (وصله نص المندوب بالغلط) ⇒ مانربطوش كمندوب ولا نبعتله أزرار — البوت بيرد عليه كعميل عادي */
      timeline(run.order_no, "جوال العميل نفسه بعت رمز أزرار المندوب — مارديناش بالأزرار وسيبناه للبوت", { ok: false, stage: "opener", reason: "customer_phone" });
      return false;
    }
    const say = (kind) => freeSend(pn, run, stageReply(kind, row, { no: run.order_no }), []);
    if (run.revoked_at) { await say("revoked"); return true; }
    if (run.delivered_at) { await say("done"); return true; }
    if (isExpired(run)) { await say("expired"); return true; }
    const raw = String(run.courier_phone || "").replace(/\D/g, "");
    const cur = pn9(run.courier_phone);
    if (raw && cur !== pn) { await say("taken"); timeline(run.order_no, "رقم تاني طلب أزرار الطلب ده من الواتساب ومارديناش بالأزرار (الطلب على مندوب تاني)", { ok: false, stage: "opener" }); return true; }
    await ensureSchema();
    if (!raw) {
      /* الطلب كان منشور في جروب ومالوش جوال — أول واحد بعت الرمز هو المندوب (نفس قاعدة الرابط: «أول واحد يفتحه هو اللي استلمه») */
      await pool.query("UPDATE dl_ext_runs SET courier_phone=$2 WHERE id=$1", [run.id, `0${pn}`]).catch(() => {});
      await pool.query(
        `UPDATE dl_shipments SET driver = COALESCE(driver,'{}'::jsonb) || $2::jsonb, events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
        [run.shipment_id, J({ phone: `0${pn}` }), J([{ at: new Date(now()).toISOString(), provider: "external", event: "driver_named", by: "courier_wa", note: `0${pn}` }])]).catch(() => {});
      run.courier_phone = `0${pn}`;
    }
    await sendCard(run, pn, { cfg, allowTemplate: false, why: "opener" });
    return true;
  }

  /* مستمع claim في whatsapp.js: true = الرسالة دي بتاعتنا (البوت والرد الآلي مايردّوش) */
  async function onClaim(ev) {
    if (!ev || ev.isEcho || !ev.phoneNorm) return false;
    const id = ev.interactiveId ? String(ev.interactiveId) : "";
    const p = parseCwPayload(id);
    if (p) { await handleTap(ev, p); return true; }
    if (/^cw1\./.test(id)) return true;      // payload بتاعنا بس بايظ — نسكت بدل ما البوت يرد على «استلمت الطلب»
    if (id) return false;                    // زر مش بتاعنا (wateam «✅ جدّد التنبيهات» / أزرار المحادثات / زر بوت) ⇒ صاحبه يرد عليه، حتى لو الرقم على رحلة
    const s = await settingsNow();
    const cfg = cfgOf(s);
    if (!cfg.enabled) return false;
    if (!(await ensureSchema())) return false;
    const o = parseOpener(ev.text);
    if (o && (await handleOpener(ev, o, cfg))) return true;
    const run = await liveRunForPhone(ev.phoneNorm);
    if (!run) return false;
    /* مراجعة CW1: الرسالة العادية (مش ضغطة cw1 موقّعة) من رقم الفريق أو من عميل الطلب نفسه مش بتاعتنا:
       • الفريق (مدير بيوصّل بنفسه / موظف معاه الرابط) ⇒ «✅ جدّد التنبيهات» وأزرار المحادثات وأوامر حالة/مساعدة لازم توصل لـwateam جوّه البوت.
       • العميل (المدير كتب جواله في «جواله» بالغلط) ⇒ البوت يرد عليه زي أي عميل. */
    const me = pn9(ev.phoneNorm);
    if (me && teamPhones(s).has(me)) return false;
    {
      const sp = shop();
      const row = sp ? await sp.getOrderRow(run.order_no).catch(() => null) : null;
      if (me && me === customerPn(row)) return false;
    }
    /* رسالة المندوب نفسها في سجل الطلب (من غير أرقام طويلة — ممكن يكون كاتب جوال) */
    const said = String(ev.text || "").replace(/\d[\d\s-]{6,}\d/g, "…").replace(/\s+/g, " ").trim().slice(0, 120);
    if (said) timeline(run.order_no, `رسالة من المندوب الخارجي على الواتساب: «${said}»`, { stage: "courier_said" });
    if (cfg.openerReply && (!run.wa_sent_at || now() - new Date(run.wa_sent_at).getTime() > 10 * 60_000)) {
      await sendCard(run, ev.phoneNorm, { cfg, allowTemplate: false, why: "inbound" });
    }
    return true;
  }
  try { const w = wa(); if (w && typeof w.on === "function") w.on("claim", onClaim); } catch {}

  /* زر «📲 ابعتله الأزرار من رقم المطعم» في البوابة (المدير بس) */
  app.post("/api/portal/orders/:orderNo/courier/wa-job", async (c) => {
    const p = portal();
    if (!p || !p.requirePortal) return c.json({ ok: false, error: "unavailable" }, 503);
    const a = await p.requirePortal(c, "manager"); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const r = await sendJob(orderNo, { by: a.user?.name || "manager", why: "manual" });
    try { p.audit?.(a.user, "courier_wa_job", orderNo, Boolean(r.sent), { via: r.via || null, reason: r.reason || null }, c.req.header("cf-connecting-ip") || null); } catch {}
    return c.json({ ok: true, ...r });
  });

  return { sendJob, sendCard, openerFor, onClaim, handleTap, ensureSchema };
}
