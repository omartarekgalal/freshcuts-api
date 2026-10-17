/* ═══════════════════════════════════════════════════════════════════════════
   📍 PK1 — تتبّع طلبات الاستلام: «جاهز» من الكاشير بس (عمر ١٧/١٠ ١٩:٠٧)

   الحادثة: طلب استلام W1792251412023 — صفحة التتبع قالت «طلبك جاهز للاستلام 📍»
   والكاشير ماضغطش «جاهز» في نقطة البيع (pos_ready_at فاضي، الحالة accepted).
   السبب: مؤقّت قديم في shop.js (shop.pickupReadyMinutes، افتراضي ٢٠ د) كان
   بيرفع الطلب لخطوة ٤ بالوقت — اتكتب قبل ما إشارة «جاهز» من نقطة البيع/المطبخ
   والوقت المتوقع الذكي يبقوا موجودين، ومكانش له خانة في اللوحة.

   القاعدة (نفس «المطعم أولاً» بتاعة التوصيل في shop.js): مانقولش للعميل حاجة
   المطعم ماأكّدهاش. «جاهز» = pos_ready_at بس. اللي بيتغيّر بالوقت هو الصراحة:
   لو الوعد (أو المهلة من اللوحة لو مفيش وعد) فات ومفيش «جاهز» ⇒ «طلبك بياخذ
   وقت أطول شوية» — الخطوة تفضل ٢، وعمرها ما تبقى ٤.

   المفتاح: settings.shop.pickupLateAfterMin (اللوحة ← التوصيل والمندوبين ←
   النطاق والرسوم، جنب باقي صفوف «صفحة التتبع — …» في deliverycontrol.js).
   القديم shop.pickupReadyMinutes بيتقرا كاحتياطي **بالمعنى الجديد** (المهلة
   قبل «أطول شوية»، مش «جاهز») — عشان القيمة المؤقتة ١٨٠ اللي اتحطّت في
   الإنتاج يوم الحادثة ماتكسرش حاجة. مفيش ولا الاتنين ⇒ ٤٥ دقيقة.

   رسالة واتساب «جاهز للاستلام» مش من هنا أصلاً (notify.orderReady على
   pos_ready_at) — ماتغيّرتش. والبوت («وين طلبي») بيقرا label من نفس المسار،
   فبياخد نفس الصراحة تلقائياً.
═══════════════════════════════════════════════════════════════════════════ */
export const PICKUP_TRACK_DEFAULTS = Object.freeze({ lateAfterMin: 45 });
export const PICKUP_TRACK_LIMITS = Object.freeze({ lateAfterMin: [10, 240] });

/* نصوص العميل — لهجة بيضاء، من غير لوم ومن غير وعد مش متأكدين منه */
export const PICKUP_LABELS = Object.freeze({
  preparing: "جاري تجهيز طلبك — جاهز للاستلام قريباً",
  preparingIn: (text) => `جاري تجهيز طلبك — جاهز للاستلام خلال ${text}`,
  late: "طلبك بياخذ وقت أطول شوية — لو وصلت الفرع اسأل عن رقم طلبك",
  ready: "جاهز للاستلام من الفرع 📍",
  collected: "استلمت طلبك — بالهنا والشفا 🌟",
});

const ms = (v) => { if (v == null || v === "") return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const iso = (t) => (t == null ? null : new Date(t).toISOString());

/* المهلة الفعّالة ومصدرها: الجديد ← القديم ← الافتراضي.
   رقم بره المدى بيتجاهل (مش بيتقصّ بالسكات) — نفس أسلوب trackEtaCfg. */
export function pickupLateCfg(settings = {}) {
  const shop = (settings && settings.shop) || {};
  const [lo, hi] = PICKUP_TRACK_LIMITS.lateAfterMin;
  const pick = (v) => { if (v === undefined || v === null || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const fresh = pick(shop.pickupLateAfterMin);
  if (fresh != null) return { lateAfterMin: fresh, source: "setting" };
  const legacy = pick(shop.pickupReadyMinutes);
  if (legacy != null) return { lateAfterMin: legacy, source: "legacy" };
  return { lateAfterMin: PICKUP_TRACK_DEFAULTS.lateAfterMin, source: "default" };
}

function historyAt(row, status) {
  let h = row && row.history;
  if (typeof h === "string") { try { h = JSON.parse(h); } catch { h = null; } }
  if (!Array.isArray(h)) return null;
  for (const e of h) if (e && e.status === status && ms(e.at) != null) return ms(e.at);
  return null;
}

/* بداية العدّ: وقت القبول (accepted_at، وإلا من سجل الطلب)، وإلا وقت الطلب.
   الطلب المسبق: من موعده لو بعد كده (المطبخ مايبدأش قبله — نفس prepstatus.prepCheck).
   مش updated_at (اللي كان المؤقّت القديم بيعدّ منه): ده بيتحرّك مع أي كتابة
   على الصف (إنذار، ملاحظة) وكان بيرجّع العدّاد من غير ما حد يحس. */
export function pickupAnchorAt(row = {}) {
  let start = ms(row.accepted_at) ?? historyAt(row, "accepted") ?? ms(row.created_at);
  if (start == null) return null;
  const sched = ms(row.scheduled_for);
  if (sched != null && sched > start) start = sched;
  return start;
}

const OPEN = new Set(["accepted", "pos_created"]);

/* ⇒ null لو مش طلب استلام (أو طلب طاولة — ده بتاع tableTrackLabel) أو حالة مش من مراحل الاستلام (الدفع، الرفض، …)،
   وإلا { label, step, late, promiseAt, promiseText, promiseBasis, readyAt, anchorAt }:
     • pos_ready_at موجود ⇒ «جاهز للاستلام من الفرع» خطوة ٤ — مهما كان الوقت (دقيقة أو ٣ ساعات).
     • مفيش ⇒ خطوة ٢ دايماً. promiseAt = وعد الوقت المتوقع لو اتبعت (eta.promise — ISO، ونصه eta.window.text)،
       وإلا بداية العدّ + المهلة من اللوحة. فات الوعد ⇒ late:true والنص «بياخذ وقت أطول شوية».
     • delivered ⇒ «استلمت طلبك» خطوة ٥.
   لحد النهارده مفيش وقت متوقع لطلبات الاستلام (computeTrackEta بيرجّع null لغير التوصيل) ⇒ المهلة هي اللي شغّالة؛
   لما يبقى فيه وعد للاستلام (PK2) بيتمرّر هنا ويتقدّم على المهلة من غير تعديل. */
export function pickupTrackState({ row, now = Date.now(), cfg = null, eta = null } = {}) {
  if (!row || row.option !== "pickup" || Number(row.table_no) > 0) return null;
  const status = String(row.status || "");
  const readyAt = ms(row.pos_ready_at);
  const base = { late: false, promiseAt: null, promiseText: null, promiseBasis: null, readyAt: iso(readyAt), anchorAt: null };
  if (status === "delivered") return { ...base, label: PICKUP_LABELS.collected, step: 5 };
  if (!OPEN.has(status)) return null;
  if (readyAt != null) return { ...base, label: PICKUP_LABELS.ready, step: 4 };
  const c = cfg && Number.isFinite(Number(cfg.lateAfterMin)) && Number(cfg.lateAfterMin) > 0 ? cfg : pickupLateCfg({});
  const anchor = pickupAnchorAt(row) ?? now;
  const etaAt = eta && eta.promise ? ms(eta.promise) : null;
  const promiseAt = etaAt ?? anchor + Number(c.lateAfterMin) * 60_000;
  const promiseText = etaAt != null ? (eta.window && eta.window.text) || null : null;
  const promiseBasis = etaAt != null ? "eta" : (c.source || "setting");
  const late = now >= promiseAt;
  const label = late ? PICKUP_LABELS.late : promiseText ? PICKUP_LABELS.preparingIn(promiseText) : PICKUP_LABELS.preparing;
  return { ...base, label, step: 2, late, promiseAt: iso(promiseAt), promiseText, promiseBasis, anchorAt: iso(anchor) };
}
