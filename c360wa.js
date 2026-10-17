/* ═══════════════════════════════════════════════════════════════════════════
   C360a — واتساب في ملف العميل + «ملف العميل» من أي مكان + «افتح الطلب» (١٦/١٠)

   طلبات عمر ١٦/١٠:
     • «حدّث اللوحة كاملة وملف العميل بحيث يكون فيه كمان تاريخ الواتساب»
     • «لازم نفتح ملف العميل بسهولة من محادثة الواتس في أي مكان»
     • «في التقييمات نحتاج نفتح الطلب وملف العميل»

   المسارات (قراءة بس — ولا سطر بيتكتب في جداول واتساب/الطلبات من هنا):
     GET /api/cms/customers/360/:ref/whatsapp?before=&limit=   تاريخ واتساب الرقم كله في خط واحد (صفحات):
         الرسايل (العميل / البوت / الموظف من اللوحة أو البورتال أو موبايل المطعم / تحديثات الطلب / قوالب)،
         رسايل الحملات بحالتها (وصلت / اتقرت / ضغط / رد / فشل وسببه بالعربي / إيقاف)، التحويلات للموظف،
         مين استلم المحادثة وسابها وقفلها، تقييمات النجوم، والموافقات/الإيقاف. الملفات = نفس بروكسي المحادثة
         (/api/cms/wa/threads/:key/media/:ref) بمفتاح المحادثة اللي بيرجع في الرد.
         مين يشوفه: المالك دايماً، والعمليات (المدير) لو دوره في «مين يشوف المحادثات» (waHub.inboxRoles من اللوحة).
     GET /api/cms/customers/resolve?wa=|queue=|review=|order=|phone=  ⇒ { ref } لزرار «👤 ملف العميل» في أي شاشة
         (مفتاح محادثة، صف مستلم حملة، تقييم، رقم طلب W… أو pos:…، أو الجوال). الـref بصمة مش الرقم.
     GET /api/cms/customers/order/:no      تفاصيل طلب واحد: موقع (W…) أو فاتورة الكاشير/التطبيقات (pos:<id> أو رقم الفاتورة) —
         الأصناف، الإجمالي، القناة (كيتا/هنقر/صالة…)، الدفع، ووقت الطلب + ref العميل.
     GET /api/portal/customer-card?key=|review=|order=   كارت عميل صغير للمدير في البورتال (عدد الطلبات، القيمة، آخر ٥ طلبات،
         التقييمات). الجوال كامل للمدير (زي كارت التقييم عنده)، والمالك بس بياخد رابط الملف الكامل في اللوحة.
     GET /api/portal/order-peek/:no        نفس تفاصيل الطلب للمدير في البورتال (من «⭐ التقييمات»).

   كل المسارات تحت /api/cms/customers ⇒ قسم «العملاء» في الصلاحيات (cms.js) من غير سطر جديد.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { normPhone, maskPhone } from "./identity.js";
import { tokenSecret } from "./portal-core.js";
import { publicMedia } from "./wamedia.js";
import { reasonText } from "./wacloud.js";
import { hubRoles } from "./wahub.js";
import { windowState } from "./wainbox.js";
import { CHANNEL_LABELS, posChannel, isVoid } from "./customer360.js";
import { KIND_AR } from "./wareviews.js";
import { phoneOut } from "./phones.js";
import { profileView, ENUM_AR } from "./custprofile.js";      // IBX1a: تصنيف العميل في كارت المحادثة

export const WA_FILE_ROLES = Object.freeze(["owner", "operations"]);
export const PAGE_DEFAULT = 40, PAGE_MAX = 100;
const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const ms = (v) => { const t = v instanceof Date ? v.getTime() : Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100) / 100);

/* مين يشوف واتساب في الملف: المالك دايماً؛ العمليات لو في قايمة «مين يشوف المحادثات» */
export function canSeeWaFile(role, settings) {
  if (role === "owner") return true;
  return WA_FILE_ROLES.includes(role) && hubRoles(settings || {}).inbox.includes(role);
}

/* رقم الطلب من أي شكل: W12345 (الموقع) · pos:123 (فاتورة نقطة البيع) · 123 (رقم الطلب/الفاتورة) */
export function parseOrderRef(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (/^w\d{3,}$/i.test(s)) return { kind: "web", no: s.toUpperCase() };
  const m = /^(?:pos:)?(\d{1,12})$/i.exec(s);
  if (m) return { kind: "pos", id: m[1] };
  return null;
}

/* حالة رسالة الحملة (الأقوى تكسب) + الخطوات بأوقاتها */
export const CAMPAIGN_STATE = Object.freeze({
  optout: ["🔕 طلب إيقاف", "danger"], replied: ["💬 رد", "ok"], clicked: ["🔗 ضغط الرابط", "ok"], read: ["👁 اتقرت", "ok"],
  delivered: ["✓✓ وصلت", "info"], sent: ["✓ اتبعتت", ""], failed: ["⚠️ فشلت", "danger"], skipped: ["⏭ اتخطّت", "warn"],
  holdout: ["🧪 مجموعة المقارنة — مااتبعتلوش", ""], pending: ["⏳ لسه في الطابور", ""],
});
export const CHANNEL_AR = Object.freeze({ wa_cloud: "واتساب الرسمي", wa_web: "واتساب ويب (الإضافة)", sms: "SMS بديل" });
export function campaignState(q) {
  const delivered = Boolean(q.delivered_at) || ["delivered", "read"].includes(String(q.cloud_status || ""));
  const read = Boolean(q.read_at) || String(q.cloud_status || "") === "read";
  const id = q.optout_at ? "optout" : q.replied_at ? "replied" : Number(q.clicks) > 0 || q.clicked_at ? "clicked" : read ? "read"
    : delivered ? "delivered" : q.status === "sent" ? "sent" : CAMPAIGN_STATE[q.status] ? q.status : "sent";
  const steps = [
    ["sent", "اتبعتت", q.sent_at], ["delivered", "وصلت", q.delivered_at || (delivered ? q.sent_at : null)], ["read", "اتقرت", q.read_at],
    ["clicked", "ضغط الرابط", q.clicked_at || (Number(q.clicks) > 0 ? true : null)], ["replied", "رد", q.replied_at], ["optout", "طلب إيقاف", q.optout_at],
  ].filter(([, , at]) => at).map(([k, label, at]) => ({ k, label, at: at === true ? null : iso(at) }));
  return { id, label: CAMPAIGN_STATE[id][0], tone: CAMPAIGN_STATE[id][1], steps };
}

/* صف wa_messages ⇒ نفس شكل رسالة المحادثة (wahub.getThread) عشان الشاشة تستخدم messageKind نفسها */
export function messageItem(m) {
  const staff = m.by_name || m.staff_via ? { by: m.by_name || null, role: m.staff_role || null, via: m.staff_via || null } : null;
  const source = staff ? "staff" : (m.source || "api");
  const pr = m.pricing && typeof m.pricing === "object" && "billable" in m.pricing ? { billable: m.pricing.billable === true, category: m.pricing.category || null } : null;
  return {
    type: "msg", id: `m${m.id}`, mid: Number(m.id) || null, wamid: m.wamid || null, at: iso(m.created_at), dir: m.direction === "in" ? "in" : "out",      // IBX1a: mid/wamid ⇒ «افتح الرسالة في المحادثة»
    text: m.body || (m.template ? `[قالب: ${m.template}]` : ""), template: m.template || null, category: m.category || null,
    status: m.status || null, error: clip(m.error, 300), orderNo: m.order_no || null, stage: m.stage || null, msgType: m.msg_type || null,
    source, ...(m.source === "echo" && !staff ? { echoKind: m.echo_kind === "auto" ? "auto" : "staff" } : {}), staff, cost: pr,
    media: publicMedia(m),
  };
}
export function campaignItem(q) {
  const st = campaignState(q);
  const showReason = q.status === "failed" || q.status === "skipped";
  return {
    type: "campaign", id: `q${q.id}`, at: iso(q.sent_at || q.claimed_at || q.job_at), jobId: Number(q.job_id), queueId: Number(q.id),
    name: q.job_name || `حملة ${q.job_id}`, channel: q.channel || q.job_channel || null, channelLabel: CHANNEL_AR[q.channel || q.job_channel] || null,
    text: clip(q.message, 1500), template: q.msg_template || null, coupon: q.coupon || null, image: q.media === "image",
    state: st.id, stateLabel: st.label, tone: st.tone, steps: st.steps, clicks: Number(q.clicks) || 0,
    reason: showReason ? q.reason || null : null, reasonAr: showReason && q.reason ? reasonText(q.reason) : null,
    errorCode: q.error_code == null ? null : Number(q.error_code), fallbackFrom: q.fallback_from || null,
    retried: Boolean(q.retried_at),
  };
}
export const OWNER_ACTION_AR = Object.freeze({ take: "استلم المحادثة", release: "رجّعها للبوت", done: "قفل المحادثة", transfer: "حوّلها للمدير", auto_release: "رجعت للبوت لوحدها", expire: "رجعت للبوت لوحدها" });
export const VIA_AR = Object.freeze({ portal: "البورتال", dashboard: "اللوحة", mute: "كتم", auto: "تلقائي" });
export const CONSENT_KIND_AR = Object.freeze({ updates: "تحديثات الطلب على واتساب", marketing: "العروض على واتساب", terms: "الشروط والأحكام", review: "طلب التقييم" });
export function handoverItem(h) {
  return { type: "handover", id: `h${h.id}`, at: iso(h.at), reason: h.reason || null, reasonAr: h.reason_ar || h.reason || "تحويل لموظف", urgent: h.urgent === true,
    orderNo: h.order_no || null, ackedAt: iso(h.acked_at), ackedBy: h.acked_by || null, test: h.test === true };
}
export function ownerItem(o) {
  return { type: "owner", id: `o${o.id}`, at: iso(o.at), action: o.action, actionAr: OWNER_ACTION_AR[o.action] || o.action, by: o.by_name || null,
    role: o.role || null, via: o.via || null, viaAr: VIA_AR[o.via] || o.via || null, forced: o.forced === true, prevBy: o.prev_by || null };
}
export function ratingItem(r) {
  return { type: "rating", id: `r${r.id}`, at: iso(r.at), reviewId: Number(r.id), rating: Number(r.rating) || null, exact: r.rating_exact !== false,
    orderNo: r.order_no || null, kind: r.kind || null, kindAr: KIND_AR[r.kind] || null, categories: r.categories || [], comment: clip(r.comment, 600),
    resolved: r.resolved === true, hidden: Boolean(r.is_test || r.hidden_at) };
}
export function consentItem(x) {
  return { type: "consent", id: `c${x.id}`, at: iso(x.at), kind: x.kind, kindAr: CONSENT_KIND_AR[x.kind] || x.kind, value: x.value === true,
    source: x.source || null, orderNo: x.order_no || null, version: x.text_version || null };
}

/* دمج المصادر (كل مصدر جاي مترتب من الأحدث، بحد limit+1) ⇒ صفحة واحدة من الأحدث + مؤشر الصفحة الجاية.
   أي عنصر مااتعرضش في الصفحة دي هييجي في اللي بعدها لأن الاستعلام التاني بيبدأ من «أقدم من آخر عنصر اتعرض». */
export function mergePage(lists, limit) {
  const all = lists.flat().filter((x) => x && x.at).sort((a, b) => ms(b.at) - ms(a.at) || String(a.id).localeCompare(String(b.id)));
  const page = all.slice(0, limit);
  return { items: page, nextBefore: all.length > limit && page.length ? page[page.length - 1].at : null };
}

/* ملخص واتساب للرقم (أول صفحة بس) */
export function summaryOf({ counts = {}, camp = {}, optin = null, chat = null, invalid = null, key = null, now = Date.now() }) {
  const lastIn = counts.last_in ? iso(counts.last_in) : null;
  return {
    threadKey: key, hasThread: Boolean(key),
    messages: { in: Number(counts.n_in) || 0, out: Number(counts.n_out) || 0, firstAt: iso(counts.first_at), lastAt: iso(counts.last_at), lastInAt: lastIn,
      media: Number(counts.n_media) || 0 },
    window: windowState(lastIn, now),
    campaigns: { total: Number(camp.total) || 0, sent: Number(camp.sent) || 0, delivered: Number(camp.delivered) || 0, read: Number(camp.read) || 0,
      clicked: Number(camp.clicked) || 0, replied: Number(camp.replied) || 0, failed: Number(camp.failed) || 0, optouts: Number(camp.optouts) || 0,
      holdout: Number(camp.holdout) || 0, lastAt: iso(camp.last_at) },
    optIn: optin ? { updates: optin.updates === true, marketing: optin.marketing === true, stopped: Boolean(optin.stopped_at), stoppedAt: iso(optin.stopped_at),
      source: optin.source || null, since: iso(optin.created_at), updatedAt: iso(optin.updated_at) } : null,
    bot: chat ? { mutedUntil: ms(chat.muted_until) > now ? iso(chat.muted_until) : null, handoffAt: iso(chat.handoff_at), handoffReason: chat.handoff_reason || null,
      fromAd: Boolean(chat.referral) } : null,
    notOnWhatsapp: invalid ? { at: iso(invalid.at), hits: Number(invalid.hits) || 1 } : null,
  };
}

/* كارت البورتال: من ملف العميل (customer360.buildProfile) — صغير وآمن حسب الدور */
export const STATUS_AR = Object.freeze({ repeat: "🔁 عميل متكرر", one_time: "1️⃣ طلب مرة واحدة", lapsed: "💤 غايب", no_orders: "لسه ماطلبش" });
export function cardOf(profile, pn, { owner = false, full = true } = {}) {
  const p = profile || {}, s = p.summary || {}, id = p.identity || {};
  const rv = (p.reviews || []).filter((r) => !r.hidden && Number(r.rating) > 0);
  const avg = rv.length ? Math.round((rv.reduce((a, r) => a + Number(r.rating), 0) / rv.length) * 10) / 10 : null;
  return {
    name: id.name || null,
    phone: full ? `0${pn}` : null, phoneMasked: `…${String(pn).slice(-4)}`,
    orders: s.orders || 0, spend: s.spend || 0, aov: s.aov ?? null, firstOrderAt: s.firstOrderAt || null, lastOrderAt: s.lastOrderAt || null,
    daysSinceLast: s.daysSinceLast ?? null, status: s.status || "no_orders", statusLabel: STATUS_AR[s.status] || STATUS_AR.no_orders,
    channels: (s.channels || []).slice(0, 3).map((c) => ({ label: c.label, orders: c.orders })),
    lastOrders: (p.orders || []).slice(0, 5).map((o) => ({
      no: o.source === "web" ? o.orderNo : `pos:${o.id}`, receipt: o.receipt || null, at: o.at, channel: o.channel, channelLabel: CHANNEL_LABELS[o.channel] || o.channel,
      total: o.total, items: (o.items || []).slice(0, 4).map((i) => ({ name: i.name, qty: i.qty })), more: Math.max(0, (o.items || []).length - 4),
    })),
    reviews: { count: rv.length, avg, low: rv.filter((r) => Number(r.rating) < 4).length },
    tags: (p.tags || []).slice(0, 6),
    ...(owner && p.ref ? { ref: p.ref } : {}),
  };
}

/* ═══ IBX1a (عمر ١٧/١٠: «من الشات لو ضغطنا على العميل يبان التفاصيل بطريقة احترافية والطلبات ولو في طلب حالي أو طلبات سابقة») ═══
   كارت العميل جنب المحادثة في اللوحة: GET /api/cms/wa/threads/:key/customer — قراية بس.
   الطلب الحالي = آخر طلب موقع للرقم في آخر ١٢ ساعة لسه ماخلصش (أو خلص من أقل من ٣ ساعات ⇒ done:true)، بحالته والمندوب والدفع
   والوقت المتوقّع (تقدير — نفس حساب صفحة التتبع). */
export const ORDER_STATUS_AR = Object.freeze({
  pending_payment: "بانتظار الدفع", paid: "مدفوع", pos_created: "وصل نقطة البيع", accepted: "قبله الكاشير", preparing: "في المطبخ", pickup_ready: "جاهز للاستلام",
  courier_requested: "بنطلب مندوب", courier_assigned: "المندوب رايح للمحل", on_the_way: "في الطريق للعميل", delivered: "اتوصّل", collected: "العميل استلمه",
  rejected_refunded: "مرفوض ومسترجع", refund_failed: "فشل الاسترجاع", courier_cancelled: "التوصيل اتعثر", paid_pos_failed: "مدفوع ومش واصل لنقطة البيع",
  expired: "انتهى", cancelled: "ملغي", payment_failed: "الدفع فشل",
});
export const COURIER_STATUS_AR = Object.freeze({ pending: "لسه مفيش مندوب", requested: "بنطلب مندوب", assigned: "اتعيّن مندوب", arrived: "المندوب وصل المحل", picked: "المندوب استلم الطلب", delivered: "اتوصّل", cancelled: "اتلغى", failed: "اتعثر" });
export const PROVIDER_AR = Object.freeze({ leajlak: "لاجلك", cervo: "سيرفو", flying_arrow: "فلاينج أرو", flyingarrow: "فلاينج أرو", external: "مندوب خارجي", manual: "يدوي", district: "مندوب الحي" });
export const OPTION_AR = Object.freeze({ delivery: "توصيل", pickup: "استلام", takeaway: "استلام", dine_in: "صالة", table: "طاولة" });
export const FINAL_ORDER_STATUSES = Object.freeze(["delivered", "collected", "rejected_refunded", "refund_failed", "payment_failed", "cancelled", "expired", "pending_payment", "courier_cancelled"]);
export const CURRENT_ORDER_SQL = `SELECT o.*, NULLIF(to_jsonb(o)->>'table_no','')::int AS table_no_i,
       s.status AS ship_status, s.driver AS ship_driver, s.provider AS ship_provider, s.updated_at AS ship_updated_at, s.arrived_at AS ship_arrived_at,
       s.picked_at AS ship_picked_at, s.delivered_at AS ship_delivered_at, to_jsonb(s)->>'assigned_at' AS ship_assigned_at, s.tracking_url AS ship_tracking_url
  FROM shop_orders o
  LEFT JOIN LATERAL (SELECT * FROM dl_shipments WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE
 WHERE o.phone_norm = $1 AND o.status NOT IN ('pending_payment','expired','payment_failed') AND o.created_at > NOW() - INTERVAL '12 hours'
 ORDER BY (o.status = ANY($2::text[])) ASC, o.created_at DESC LIMIT 1`;
/* الوقت المتوقّع من حساب التتبع ⇒ سطر للموظف (تقدير، معلّم كده) */
export function etaOut(eta) {
  if (!eta) return null;
  if (eta.soon) return { text: "قرّب يوصل", soon: true, at: null };
  if (eta.at && eta.minutes != null) return { text: `خلال ${Math.round(eta.minutes)} دقيقة تقريباً`, soon: false, at: eta.at, minutes: Math.round(eta.minutes) };
  if (eta.range) return { text: `خلال ${eta.range.fromMin}~${eta.range.toMin} دقيقة تقريباً`, soon: false, at: eta.range.to || null, from: eta.range.from || null, to: eta.range.to || null };
  return null;
}
export function currentOrderOut(o, { eta = null, now = Date.now() } = {}) {
  if (!o) return null;
  const status = String(o.status || "");
  const done = FINAL_ORDER_STATUSES.includes(status);
  const ageMin = Math.max(0, Math.round((now - ms(o.created_at)) / 60_000));
  if (done && ageMin > 180) return null;      // خلص من أكتر من ٣ ساعات ⇒ مش «حالي» (بيظهر في آخر الطلبات)
  const drv = o.ship_driver && typeof o.ship_driver === "object" ? o.ship_driver : null;
  const tableNo = Number(o.table_no_i ?? o.table_no) || 0;
  const option = tableNo > 0 ? "table" : (o.option || null);
  const prov = String(o.ship_provider || "").toLowerCase();
  const courier = o.ship_provider || o.ship_status ? {
    provider: o.ship_provider || null, providerLabel: PROVIDER_AR[prov] || o.ship_provider || null,
    status: o.ship_status || null, statusLabel: COURIER_STATUS_AR[String(o.ship_status || "")] || o.ship_status || null,
    driverName: drv ? clip(drv.name || drv.driver_name || drv.full_name, 60) : null, driverPhone: drv ? clip(drv.phone || drv.mobile || drv.driver_phone, 20) : null,
    assignedAt: iso(o.ship_assigned_at), arrivedAt: iso(o.ship_arrived_at), pickedAt: iso(o.ship_picked_at), deliveredAt: iso(o.ship_delivered_at), trackingUrl: o.ship_tracking_url || null,
  } : null;
  const items = Array.isArray(o.items) ? o.items : [];
  const a = o.address && typeof o.address === "object" ? o.address : null;
  return {
    no: o.order_no, at: iso(o.created_at), ageMin, status, statusLabel: ORDER_STATUS_AR[status] || status || "—", done,
    option, optionLabel: OPTION_AR[option] || option || null, tableNo: tableNo > 0 ? tableNo : null,
    total: num(o.total), deliveryFee: num(o.delivery_fee), discount: num(o.discount_amount), coupon: o.coupon || null, isTest: o.is_test === true,
    paid: !["pending_payment", "payment_failed", "expired"].includes(status), payGateway: o.pay_gateway || null,
    acceptedAt: iso(o.accepted_at), readyAt: iso(o.pos_ready_at), scheduledFor: iso(o.scheduled_for), area: a ? clip(a.area || a.district, 80) : null,
    items: items.slice(0, 8).map((i) => ({ name: i.name || i.product_name || `صنف ${i.product_id ?? ""}`, qty: Number(i.quantity ?? i.qty) || 1 })), itemsMore: Math.max(0, items.length - 8),
    courier, eta: done ? null : etaOut(eta),
  };
}
/* تصنيف العميل (cust_profile) ⇒ الشرايح + سطور قصيرة بالعربي للكارت */
export function profileBrief(view, row) {
  if (!view || !row) return null;
  const en = (k, v) => (v == null || v === "" ? null : (ENUM_AR[k] && ENUM_AR[k][v]) || String(v));
  const lines = [
    ["main_channel", "بيطلب من", en("main_channel", row.main_channel)],
    ["daypart", "وقته المعتاد", en("daypart", row.daypart)],
    ["value_tier", "قيمته", row.value_tier && row.value_tier !== "none" ? `${en("value_tier", row.value_tier)}${row.spend_pct != null ? ` · أعلى ${100 - Number(row.spend_pct)}٪` : ""}` : null],
    ["recency_band", "آخر نشاط", row.recency_band && row.recency_band !== "none" ? `${en("recency_band", row.recency_band)}${row.days_since != null ? ` · من ${row.days_since} يوم` : ""}` : null],
    ["freq_band", "التكرار (٩٠ يوم)", en("freq_band", row.freq_band)],
    ["fav_dish", "بيحب", row.fav_dish || null],
    ["service_pref", "الخدمة", en("service_pref", row.service_pref)],
    ["district", "الحي", row.district || null],
    ["lang", "اللغة", en("lang", row.lang)],
    ["wa_reach", "واتساب", en("wa_reach", row.wa_reach)],
    ["price_sensitivity", "حساسية السعر", row.price_sensitivity && row.price_sensitivity !== "unknown" ? en("price_sensitivity", row.price_sensitivity) : null],
    ["loyalty", "الولاء", row.loyalty_left != null && Number(row.loyalty_left) > 0 ? `فاضل ${row.loyalty_left} طلب للمكافأة` : row.reward_code ? `عنده مكافأة ${row.reward_code}` : null],
  ].filter(([, , v]) => v).map(([key, label, value]) => ({ key, label, value: String(value) }));
  return { segments: (view.segments || []).map((s) => ({ id: s.id, icon: s.icon, label: s.label, hint: s.hint })), lines, computedAt: view.computedAt || null, isStaff: Boolean(view.isStaff) };
}

/* تفاصيل طلب من صفّه (من غير I/O) */
export function webOrderOut(o) {
  const a = o.address && typeof o.address === "object" ? o.address : null;
  return {
    source: "web", no: o.order_no, at: iso(o.created_at), channel: "website", channelLabel: CHANNEL_LABELS.website, status: o.status || null,
    option: o.option || null, total: num(o.total), subtotal: num(o.subtotal), deliveryFee: num(o.delivery_fee), discount: num(o.discount_amount),
    coupon: o.coupon || null, isTest: o.is_test === true, posOrderId: o.pos_order_id || null, area: a ? a.area || a.district || null : null,
    items: (Array.isArray(o.items) ? o.items : []).map((i) => ({ name: i.name || i.product_name || `صنف ${i.product_id ?? ""}`, qty: Number(i.quantity ?? i.qty) || 1,
      note: clip(i.note || i.notes, 120) })).slice(0, 40),
    customerName: (o.customer && o.customer.name) || null,
  };
}
export function posOrderOut(o) {
  const ch = posChannel(o);
  return {
    source: "pos", no: `pos:${o.order_id}`, receipt: o.receipt || null, at: iso(o.order_date), channel: ch, channelLabel: CHANNEL_LABELS[ch] || ch,
    orderType: o.order_type || null, option: o.order_option || null, void: isVoid(o), total: num(o.total), discount: num(o.discount_incl),
    payments: Object.keys(o.payments || {}), items: (o.items || []).map((i) => ({ name: i.name, qty: Number(i.qty) || 1, amount: num(i.amount) })).slice(0, 40),
    customerName: o.customer_name || o.tc_name || null,
  };
}

const POS_ORDER_SQL = `SELECT o.order_id, o.receipt, o.order_date, o.order_type, o.order_option, o.total, o.discount_incl, o.payments,
       s.source, s.source_note, s.customer_name, tc.name AS tc_name, COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn,
       COALESCE((SELECT json_agg(json_build_object('name', i.name, 'qty', i.qty, 'amount', i.amount) ORDER BY i.idx)
                   FROM ts_order_items i WHERE i.order_id = o.order_id), '[]'::json) AS items
  FROM ts_orders o
  LEFT JOIN order_sources s ON s.order_id = o.order_id
  LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id`;

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const whoami = deps.whoami || (async () => null);
  const c360 = () => (typeof deps.c360 === "function" ? deps.c360() : deps.c360) || null;
  const SALT = String(deps.keySalt || tokenSecret(process.env) || "");
  const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const Q = (sql, p) => pool.query(sql, p).then((r) => r.rows || []);
  const fullPhones = async (c) => { try { return ctx.canSeePhones ? await ctx.canSeePhones(c) : true; } catch { return false; } };
  const bad = (c, error, status = 400, message) => c.json({ ok: false, error, ...(message ? { message } : {}) }, status);

  async function pnOfWaKey(k) {
    if (!/^[0-9a-f]{32}$/.test(String(k || "")) || !SALT) return null;
    return (await Q("SELECT phone_norm FROM wa_threads WHERE md5($1 || ':' || phone_norm) = $2 LIMIT 1", [SALT, k]))[0]?.phone_norm || null;
  }
  async function pnOfReview(id) {
    const n = Number(id); if (!Number.isInteger(n) || n <= 0) return null;
    return (await Q(`SELECT COALESCE(NULLIF(r.phone_norm,''), so.phone_norm) AS pn FROM reviews r
                       LEFT JOIN shop_orders so ON so.order_no = r.order_no WHERE r.id = $1`, [n]))[0]?.pn || null;
  }
  async function findOrder(raw) {
    const ref = parseOrderRef(raw);
    if (!ref) return null;
    if (ref.kind === "web") {
      const r = (await Q(`SELECT order_no, status, option, total, subtotal, delivery_fee, discount_amount, coupon, items, address, customer,
                                 pos_order_id, created_at, is_test, phone_norm FROM shop_orders WHERE order_no = $1`, [ref.no]))[0];
      return r ? { order: webOrderOut(r), pn: r.phone_norm || null } : null;
    }
    /* pos:<id> = رقم الطلب في نقطة البيع (اللي في التقييم)؛ رقم من غير بادئة ممكن يكون رقم الفاتورة كمان */
    const r = (await Q(`${POS_ORDER_SQL} WHERE o.order_id = $1 ${/^pos:/i.test(String(raw).trim()) ? "" : "OR o.receipt = $1"} ORDER BY (o.order_id = $1) DESC, o.order_date DESC LIMIT 1`, [ref.id]))[0];
    return r ? { order: posOrderOut(r), pn: r.pn || null } : null;
  }
  async function refFor(pn) {
    const x = c360(); if (!pn || !x) return null;
    await x.remember([pn]);
    return x.refOf(pn);
  }

  /* ═══ 👤 ملف العميل من أي مكان ═══ */
  app.get("/api/cms/customers/resolve", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = (k) => String(c.req.query(k) || "").trim().slice(0, 60);
    let pn = null, via = null;
    try {
      if (q("wa")) { pn = await pnOfWaKey(q("wa")); via = "wa"; }
      else if (q("queue")) { const n = Number(q("queue")); pn = Number.isInteger(n) && n > 0 ? (await Q("SELECT phone_norm FROM wa_send_queue WHERE id=$1", [n]))[0]?.phone_norm || null : null; via = "campaign"; }
      else if (q("review")) { pn = await pnOfReview(q("review")); via = "review"; }
      else if (q("order")) { pn = (await findOrder(q("order")))?.pn || null; via = "order"; }
      else if (q("phone")) { pn = normPhone(q("phone")) || null; via = "phone"; }
      else return bad(c, "missing", 400, "محتاج مفتاح محادثة أو رقم طلب أو تقييم أو جوال");
    } catch (e) { log.error("[c360wa] resolve:", e.message); return bad(c, "unavailable", 500); }
    if (!pn) return bad(c, "not_found", 404, "مالقيناش رقم العميل ده");
    const ref = await refFor(pn);
    if (!ref) return bad(c, "unavailable", 503);
    return c.json({ ok: true, ref, via });
  });

  /* ═══ 🧾 تفاصيل طلب (موقع / كاشير / تطبيقات) ═══ */
  app.get("/api/cms/customers/order/:no", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const f = await findOrder(c.req.param("no"));
      if (!f) return bad(c, "not_found", 404, "الطلب مش موجود");
      const full = await fullPhones(c);
      return c.json({ ok: true, order: f.order, ref: await refFor(f.pn), customer: f.pn ? phoneOut(f.pn, full) : null });
    } catch (e) { log.error("[c360wa] order:", e.message); return bad(c, "unavailable", 500); }
  });

  /* ═══ IBX1a: 👤 كارت العميل جنب المحادثة (اللوحة) — قراية بس ═══
     GET /api/cms/wa/threads/:key/customer ⇒ { ok, key, card, current, profile, optouts, reviews, ref, full }
     مين: نفس أدوار المحادثات (settings.waHub.inboxRoles)؛ الرقم كامل للأدوار اللي بتشوفه بس (phoneRoles). تحت /api/cms/wa/threads ⇒ قسم «الطلبات». */
  const profiles = () => (typeof deps.profiles === "function" ? deps.profiles() : deps.profiles) || null;
  app.get("/api/cms/wa/threads/:key/customer", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const u = await whoami(c).catch(() => null);
    const settings = await getSettingsData().catch(() => ({}));
    const roles = hubRoles(settings || {});
    if (!u || !u.role || !roles.inbox.includes(u.role)) return bad(c, "role_not_allowed", 403, "المحادثات مش متاحة لدورك");
    const full = roles.phone.includes(u.role);
    let pn = null;
    try { pn = await pnOfWaKey(c.req.param("key")); } catch (e) { log.error("[c360wa] customer key:", e.message); return bad(c, "unavailable", 500); }
    if (!pn) return bad(c, "not_found", 404, "مفيش محادثة بالمفتاح ده");
    const x = c360(); if (!x) return bad(c, "unavailable", 503);
    const partial = [];
    const part = (name, p, fallback = null) => Promise.resolve().then(() => p).catch((e) => { partial.push(name); log.error(`[c360wa] customer ${name}:`, e.message); return fallback; });
    try {
      const T = now();
      const [profile, cur, pr, sms, wa, invalid] = await Promise.all([
        part("profile", x.buildProfile(pn), null),
        part("current", Q(CURRENT_ORDER_SQL, [pn, [...FINAL_ORDER_STATUSES]]).then((r) => r[0] || null), null),
        part("classification", (async () => { const P = profiles(); if (!P || typeof P.forPhone !== "function") return null; const row = await P.forPhone(pn); if (!row) return null;
          const cfg = typeof P.cfg === "function" ? await P.cfg() : {}; return profileBrief(profileView(row, cfg), row); })(), null),
        part("sms_optout", Q("SELECT opted_out_at, optout_source FROM cms_contacts WHERE phone_norm = $1", [pn]).then((r) => r[0] || null), null),
        part("wa_optin", Q("SELECT updates, marketing, to_jsonb(o)->>'stopped_at' AS stopped_at, to_jsonb(o)->>'marketing_off_at' AS marketing_off_at FROM wa_optins o WHERE phone_norm = $1", [pn]).then((r) => r[0] || null), null),
        part("invalid", Q("SELECT at FROM wa_invalid_numbers WHERE phone_norm = $1", [pn]).then((r) => r[0] || null), null),
      ]);
      /* الوقت المتوقّع: نفس حساب صفحة التتبع (تقدير). أي خطأ ⇒ من غير وقت، الكارت بيطلع عادي. */
      let eta = null;
      if (cur && !FINAL_ORDER_STATUSES.includes(String(cur.status || "")) && cur.option === "delivery") {
        try {
          const [{ computeTrackEta }, se] = await Promise.all([import("./tracketa.js"), import("./smarteta.js")]);
          const sh = cur.ship_status || cur.ship_provider ? { status: cur.ship_status, driver: cur.ship_driver, provider: cur.ship_provider, updated_at: cur.ship_updated_at, arrived_at: cur.ship_arrived_at, picked_at: cur.ship_picked_at, delivered_at: cur.ship_delivered_at, assigned_at: cur.ship_assigned_at } : null;
          const smart = typeof se.smartTrackContext === "function" ? await se.smartTrackContext(cur, settings).catch(() => null) : null;
          eta = computeTrackEta({ row: cur, sh, settings: settings || {}, now: T, smart });
        } catch (e) { partial.push("eta"); log.error("[c360wa] customer eta:", e.message); eta = null; }
      }
      if (u.role === "owner") await x.remember([pn]).catch(() => {});
      const card = cardOf(profile || {}, pn, { owner: true, full });
      const reviews = (profile && profile.reviews ? profile.reviews : []).filter((r) => !r.hidden && Number(r.rating) > 0).slice(0, 3)
        .map((r) => ({ id: r.id, rating: Number(r.rating), comment: clip(r.comment, 300), at: iso(r.at), orderNo: r.orderNo || null, resolved: r.resolved === true, channel: r.channel || null }));
      return c.json({
        ok: true, key: String(c.req.param("key")), full,
        card, current: currentOrderOut(cur, { eta, now: T }), profile: pr, reviews,
        optouts: {
          sms: sms && sms.opted_out_at ? { at: iso(sms.opted_out_at), source: sms.optout_source || null } : null,
          wa: wa ? { updates: wa.updates === true, marketing: wa.marketing === true, stopped: Boolean(wa.stopped_at), stoppedAt: iso(wa.stopped_at), marketingOff: Boolean(wa.marketing_off_at) } : null,
          notOnWhatsapp: Boolean(invalid),
        },
        ref: await refFor(pn).catch(() => null), partial,
      });
    } catch (e) { log.error("[c360wa] customer:", e.message); return bad(c, "unavailable", 500); }
  });

  /* ═══ 💬 تاريخ واتساب في ملف العميل ═══ */
  app.get("/api/cms/customers/360/:ref/whatsapp", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const u = await whoami(c).catch(() => null);
    const settings = await getSettingsData().catch(() => ({}));
    if (!u || !canSeeWaFile(u.role, settings)) return bad(c, "role_not_allowed", 403, "تاريخ واتساب في ملف العميل للمالك والمدير (العمليات) بس");
    const x = c360(); if (!x) return bad(c, "unavailable", 503);
    const pn = await x.pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", 404);
    const lim = Math.min(Math.max(Number(c.req.query("limit")) || PAGE_DEFAULT, 5), PAGE_MAX);
    const b4raw = c.req.query("before");
    const before = b4raw && Number.isFinite(Date.parse(b4raw)) ? new Date(b4raw).toISOString() : null;
    const partial = [];
    const part = (name, p) => p.catch((e) => { partial.push(name); log.error(`[c360wa] ${name}:`, e.message); return []; });
    const B = "COALESCE($2::timestamptz, 'infinity'::timestamptz)";
    const P = [pn, before, lim + 1];
    const [msgs, camps, hos, owners, rates, consents] = await Promise.all([
      part("messages", Q(`SELECT m.id, m.wamid, m.direction, m.status, m.error, m.body, m.template, m.category, m.order_no, m.stage, m.created_at, m.source,
                                 m.msg_type, m.media, m.pricing, to_jsonb(m)->>'echo_kind' AS echo_kind, s.by_name, s.role AS staff_role, s.via AS staff_via
                            FROM wa_messages m LEFT JOIN wa_staff_replies s ON s.wamid = m.wamid
                           WHERE m.phone_norm = $1 AND m.created_at < ${B}
                             AND NOT (m.wamid IS NOT NULL AND EXISTS (SELECT 1 FROM wa_send_queue q WHERE q.wamid = m.wamid AND q.phone_norm = m.phone_norm))
                           ORDER BY m.created_at DESC, m.id DESC LIMIT $3`, P)),
      part("campaigns", Q(`SELECT q.id, q.job_id, j.name AS job_name, j.channel AS job_channel, j.created_at AS job_at, q.status, q.reason, q.sent_at, q.claimed_at,
                                  q.message, q.clicks, q.clicked_at, q.replied_at, q.optout_at, q.media, q.coupon, q.channel, q.cloud_status, q.delivered_at, q.read_at,
                                  q.error_code, q.fallback_from, q.retried_at, wm.template AS msg_template
                             FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
                             LEFT JOIN wa_messages wm ON wm.wamid = q.wamid AND q.wamid IS NOT NULL
                            WHERE q.phone_norm = $1 AND q.status <> 'pending' AND COALESCE(q.sent_at, q.claimed_at, j.created_at) < ${B}
                            ORDER BY COALESCE(q.sent_at, q.claimed_at, j.created_at) DESC, q.id DESC LIMIT $3`, P)),
      part("handovers", Q(`SELECT id, at, reason, reason_ar, urgent, order_no, acked_at, acked_by, test FROM wa_handovers
                            WHERE phone_norm = $1 AND at < ${B} ORDER BY at DESC, id DESC LIMIT $3`, P)),
      part("owners", Q(`SELECT id, at, action, by_name, role, via, forced, prev_by FROM wa_chat_owner_log
                         WHERE phone_norm = $1 AND at < ${B} ORDER BY at DESC, id DESC LIMIT $3`, P)),
      part("ratings", Q(`SELECT id, created_at AS at, rating, rating_exact, order_no, kind, categories, comment, resolved, is_test, hidden_at FROM reviews
                          WHERE phone_norm = $1 AND channel = 'whatsapp' AND created_at < ${B} ORDER BY created_at DESC, id DESC LIMIT $3`, P)),
      part("consent", Q(`SELECT id, at, kind, value, source, order_no, text_version FROM wa_optin_log
                          WHERE phone_norm = $1 AND at < ${B} ORDER BY at DESC, id DESC LIMIT $3`, P)),
    ]);
    const page = mergePage([msgs.map(messageItem), camps.map(campaignItem), hos.map(handoverItem), owners.map(ownerItem), rates.map(ratingItem), consents.map(consentItem)], lim);
    let summary = null;
    if (!before) {
      const one = (name, sql) => part(name, Q(sql, [pn])).then((r) => r[0] || null);
      const [counts, camp, optin, chat, invalid, thread] = await Promise.all([
        one("counts", `SELECT count(*) FILTER (WHERE direction='in') AS n_in, count(*) FILTER (WHERE direction='out') AS n_out,
                              count(*) FILTER (WHERE media IS NOT NULL) AS n_media, min(created_at) AS first_at, max(created_at) AS last_at,
                              max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in
                         FROM wa_messages WHERE phone_norm = $1`),
        one("campaign_counts", `SELECT count(*) FILTER (WHERE status <> 'pending') AS total, count(*) FILTER (WHERE status='sent') AS sent,
                                       count(*) FILTER (WHERE delivered_at IS NOT NULL OR cloud_status IN ('delivered','read')) AS delivered,
                                       count(*) FILTER (WHERE read_at IS NOT NULL OR cloud_status = 'read') AS read,
                                       count(*) FILTER (WHERE clicks > 0) AS clicked, count(*) FILTER (WHERE replied_at IS NOT NULL) AS replied,
                                       count(*) FILTER (WHERE status='failed') AS failed, count(*) FILTER (WHERE optout_at IS NOT NULL) AS optouts,
                                       count(*) FILTER (WHERE status='holdout') AS holdout, max(sent_at) AS last_at
                                  FROM wa_send_queue WHERE phone_norm = $1`),
        one("optin", `SELECT updates, marketing, source, created_at, updated_at, to_jsonb(o)->>'stopped_at' AS stopped_at FROM wa_optins o WHERE phone_norm = $1`),
        one("chat", `SELECT muted_until, handoff_at, handoff_reason, (referral IS NOT NULL) AS referral FROM wa_bot_chats WHERE phone_norm = $1`),
        one("invalid", `SELECT at, hits FROM wa_invalid_numbers WHERE phone_norm = $1`),
        one("thread", `SELECT 1 AS x FROM wa_threads WHERE phone_norm = $1`),
      ]);
      summary = summaryOf({ counts: counts || {}, camp: camp || {}, optin, chat, invalid, key: thread && SALT ? keyOf(pn) : null, now: now() });
    }
    return c.json({ ok: true, ...page, summary, threadKey: SALT ? keyOf(pn) : null, partial, limit: lim });
  });

  /* ═══ البورتال: كارت العميل + تفاصيل الطلب (المدير، والمالك من اللوحة) ═══ */
  const requirePortal = deps.requirePortal || null;
  if (requirePortal) {
    app.get("/api/portal/customer-card", async (c) => {
      const a = await requirePortal(c, "manager"); if (a.res) return a.res;
      const q = (k) => String(c.req.query(k) || "").trim().slice(0, 60);
      let pn = null;
      try {
        if (q("key")) pn = await pnOfWaKey(q("key"));
        else if (q("review")) pn = await pnOfReview(q("review"));
        else if (q("order")) pn = (await findOrder(q("order")))?.pn || null;
        else return bad(c, "missing", 400, "محتاج محادثة أو تقييم أو طلب");
      } catch (e) { log.error("[c360wa] card resolve:", e.message); return bad(c, "unavailable", 500); }
      if (!pn) return bad(c, "not_found", 404, "مالقيناش العميل ده");
      const x = c360(); if (!x) return bad(c, "unavailable", 503);
      try {
        const owner = a.user && a.user.admin === true;
        if (owner) await x.remember([pn]);
        const card = cardOf(await x.buildProfile(pn), pn, { owner, full: true });
        return c.json({ ok: true, card, owner });
      } catch (e) { log.error("[c360wa] card:", e.message); return bad(c, "unavailable", 500); }
    });
    app.get("/api/portal/order-peek/:no", async (c) => {
      const a = await requirePortal(c, "manager"); if (a.res) return a.res;
      try {
        const f = await findOrder(c.req.param("no"));
        if (!f) return bad(c, "not_found", 404, "الطلب مش موجود");
        return c.json({ ok: true, order: f.order });
      } catch (e) { log.error("[c360wa] order-peek:", e.message); return bad(c, "unavailable", 500); }
    });
  }

  return { canSeeWaFile, findOrder, pnOfWaKey };
}
