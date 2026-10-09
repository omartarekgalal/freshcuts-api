/* ═══════════════════════════════════════════════════════════════════════════
   🛡 حماية صف الإعدادات (settings id=1) — المرحلة ٠ «وقف النزيف» (٢٩/٩)
   الخطة: freshcuts invite/docs/build-2026-09/08-settings-center-plan.md §١ و§٥

   المشكلة: ٦ شاشات بتبعت كائن الإعدادات كله في PUT /api/settings من نسخة
   اتحمّلت بدري، فأي حاجة اتكتبت من مكان تاني في النص (صنف خلصان من البورتال،
   مهلة تحضير، فرملة SMS، تجربة Cervo، مفاتيح web-push…) كانت بترجع زي ما
   كانت من غير ما حد يحس. وGET كان بيرجّع الأسرار لأي توكن سفير.

   الحل هنا (من غير ما نلمس أي شاشة قديمة):
     ١) SERVER_OWNED_PATHS: مفاتيح السيرفر هو اللي بيكتبها (مسارات jsonb_set
        مخصوصة أو سكربتات السيرفر). الـPUT الكامل عمره ما بيغيّرها — بنرجّع
        قيمتها من الداتابيز جوّه نفس الـtransaction (SELECT … FOR UPDATE).
     ٢) rev: بصمة الجزء اللي الشاشات بتملكه. شاشة بتبعت rev قديم ⇒ 409 ومعاها
        الـrev الحالي. شاشة قديمة مابتبعتش rev ⇒ بتشتغل زي الأول (والحماية ١
        شغّالة عليها).
     ٣) GET لغير المالك: الأسرار وأرقام الموظفين بتتشال. ولأن ١ بترجّع مفاتيح
        السيرفر من الداتابيز، وrestoreSecrets بترجّع أي سر ناقص، GET متقصقص
        وبعده PUT كامل مابيمسحش حاجة.
     ٤) POST /api/settings/patch: تعديل مسارات محددة (allowlist) بـjsonb_set،
        للمالك بس، ومتسجّل في cms_audit — لأرضية الإعلانات والمهام المجدولة.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

/* ── مين بيملك إيه ─────────────────────────────────────────────────────────
   كل مسار هنا اتأكدنا إن مفيش شاشة من شاشات الـPUT الكامل بتعدّله (App.jsx
   SettingsPanel/marketingBenchmarks/cashierPin، ShopPage، CourierViolations،
   SmsCenter)، وإن له كاتب مخصوص على السيرفر (الملف بين القوسين). */
export const SERVER_OWNED_PATHS = [
  "catalog.soldOut",            // soldout.js (البورتال + خلص النهارده)
  "catalog.pausedOffers",       // soldout.js
  "catalog.hiddenBySoldOut",    // fc-unhide (سكربت السيرفر)
  "delivery.dispatchDelayTemp", // portal.js (مهلة التحضير المؤقتة)
  "delivery.cervoTrial",        // cervotrial.js
  "delivery.districtCouriers",  // districts.js
  "cms",                        // cms.js (perms, campaigns + brake, loyalty, dailyTarget)
  "staffAlerts",                // staffcontrol.js
  "googlePlace",                // reviews.js (كاش تقييم جوجل)
  "reviews",                    // reviews.js
  "webPushKeys",                // notify.js (مفاتيح VAPID — سر)
  "portal",                     // portal.js (portal.staff[].pinHash — سر)
  "tsDiscountSync",             // index.js /api/discounts/refresh
  "seoStatus",                  // seostatus.js
  "waSender",                   // wasender.js (agentHash — سر)
  "waCloud",                    // wacloud.js / wasender.js
  "jobs",                       // fc-job-gate + /api/settings/patch
  "adsGuard",                   // fc-adsentry + /api/settings/patch
  "adsPacer",                   // fc-pacer
  "adsPacing",                  // adspacing.js
  "adsControl",                 // adsctl.js
  "adsReport",                  // adsreport.js
  "scorecard",                  // scorecard.js + menuplan.js
  "menuplan",                   // menuplan.js
  "kitchen",                    // kitchen.js
  "service",                    // service.js
  "preorder",                   // preorder.js
  "openWait",                   // openwait.js
  "abandonedCarts",             // carts.js
  "outreach",                   // outreach.js
  "shop.modifiers",             // modifiers.js
  "tables",                     // table-order.js (QR الطاولات — /api/tables/admin/config)
  "shop.recommendations",       // recs.js
  "shop.checkout2Default",      // recs.js (مفتاح «التجربة الجديدة لكل العملاء»)
];

/* مسارات ليها كاتبين: شاشة PUT كاملة + السيرفر (catalog.hiddenIds: شاشة
   «شكل المتجر» + /api/cms/products + fc-unhide). بنقبل قيمة الشاشة بس لو
   بعتت rev مطابق (يعني نسختها طازة)؛ من غير rev بنحافظ على قيمة الداتابيز. */
export const DUAL_OWNED_PATHS = ["catalog.hiddenIds"];

/* ── أدوات المسارات ───────────────────────────────────────────────────── */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const parts = (p) => (Array.isArray(p) ? p : String(p).split("."));

export function hasAt(obj, path) {
  let cur = obj;
  for (const k of parts(path)) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return false;
    cur = cur[k];
  }
  return true;
}
export function getAt(obj, path) {
  let cur = obj;
  for (const k of parts(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}
export function setAt(obj, path, value) {
  const ks = parts(path);
  let cur = obj;
  for (const k of ks.slice(0, -1)) {
    if (!isObj(cur[k]) && !Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[ks.at(-1)] = value;
  return obj;
}
export function delAt(obj, path) {
  const ks = parts(path);
  const parent = getAt(obj, ks.slice(0, -1));
  if (parent && typeof parent === "object") delete parent[ks.at(-1)];
  return obj;
}

/* JSON بترتيب مفاتيح ثابت — نفس المحتوى = نفس البصمة مهما كان الترتيب. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/* rev = بصمة الجزء اللي الشاشات بتملكه بس. تغييرات السيرفر في مفاتيحه (خلص،
   تقييم جوجل، المهام…) مابتغيّرش الـrev، فالشاشة المفتوحة مابتاخدش 409 على
   حاجة الـPUT أصلاً مش هيلمسها. updated_at مش صالح هنا: أغلب كتّاب
   jsonb_set مابيحدّثوهوش. */
export function settingsRev(data) {
  const d = isObj(data) ? clone(data) : {};
  for (const p of SERVER_OWNED_PATHS) delAt(d, p);
  return crypto.createHash("sha1").update(stableStringify(d)).digest("hex").slice(0, 16);
}

/* ── الأسرار وأرقام الموظفين ──────────────────────────────────────────── */
export const SECRET_KEY_RE = /(privatekey|pinhash|agenthash|hash|token|secret|password|passwd|apikey|api_key|cashierpin)$/i;
export const PHONE_KEY_RE = /(phones|phonenames|contactphone)$/i;

/* بيمشي على كل المفاتيح (والمصفوفات) ويرجّع مسارات اللي اسمها بيطابق. */
function findKeys(obj, re, base = [], out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => findKeys(v, re, [...base, String(i)], out));
  else if (isObj(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k)) out.push([...base, k]);
      else findKeys(v, re, [...base, k], out);
    }
  }
  return out;
}
export const secretPaths = (data) => findKeys(data, SECRET_KEY_RE);

/* النسخة اللي بتتبعت لغير المالك (توكن سفير): من غير أسرار ولا أرقام موظفين. */
export function redactForViewer(data) {
  const d = isObj(data) ? clone(data) : {};
  for (const p of findKeys(d, SECRET_KEY_RE)) delAt(d, p);
  for (const p of findKeys(d, PHONE_KEY_RE)) delAt(d, p);
  return d;
}

/* ── دمج الـPUT الكامل ────────────────────────────────────────────────────
   current = الصف الحالي (متقفل FOR UPDATE)، incoming = جسم الطلب.
   trusted = الشاشة بعتت rev مطابق ⇒ نقبل منها المسارات المشتركة كمان. */
export function mergeForPut(current, incoming, { trusted = false } = {}) {
  const cur = isObj(current) ? current : {};
  const out = isObj(incoming) ? clone(incoming) : {};
  const keep = trusted ? SERVER_OWNED_PATHS : [...SERVER_OWNED_PATHS, ...DUAL_OWNED_PATHS];
  for (const p of keep) {
    if (hasAt(cur, p)) setAt(out, p, clone(getAt(cur, p)));
    else if (hasAt(out, p)) delAt(out, p);
  }
  /* أي سر موجود في الداتابيز وناقص من الجسم (لأن GET اتقصقص) بيرجع مكانه —
     الـPUT مابيمسحش سر أبداً. تغيير سر بيبقى من مساره المخصوص. */
  for (const p of secretPaths(cur)) {
    if (!hasAt(out, p) && (p.length === 1 || hasAt(out, p.slice(0, -1)))) setAt(out, p, clone(getAt(cur, p)));
  }
  return out;
}

/* ── التعديل المحدد (PATCH) ───────────────────────────────────────────────
   كل مسار مسموح ليه فاحص بيرجّع {ok, value} أو {ok:false, error} بالعربي. */
const num = (lo, hi, { int = false, label } = {}) => (v) => {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n)) return { ok: false, error: `${label}: لازم رقم` };
  if (n < lo || n > hi) return { ok: false, error: `${label}: لازم بين ${lo} و${hi}` };
  return { ok: true, value: int ? Math.round(n) : Math.round(n * 10000) / 10000 };
};
const JOB_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUDGET_ID_RE = /^(google|meta|tiktok|snapchat)\/[A-Za-z0-9_-]{1,40}$/;

/* ── حارس الإعلانات «الوضع المحصور» (٩/١٠، إطلاق أكتوبر FIRST) ─────────────
   fc-adsentry (سكربت السيرفر) بيقرا المفاتيح دي من settings.adsGuard كل ربع
   ساعة. كل فاحص هنا بيرجّع الشكل اللي السكربت متوقعه بالظبط. */
const PLATFORMS = ["meta", "google", "tiktok", "snapchat"];
const bool = (label) => (v) => (typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: `${label}: لازم true أو false` });
/* "14" / 14 / "1:30" / "01:30" ⇒ "HH:MM" (الدقايق ٠٠ أو ١٥ أو ٣٠ أو ٤٥ — نفس خطوات جدولة جوجل) */
export function normHHMM(v) {
  if (typeof v === "number" && Number.isInteger(v)) v = `${v}:00`;
  const m = String(v ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 23 || ![0, 15, 30, 45].includes(mi)) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
const hhmm = (label) => (v) => {
  const s = normHHMM(v);
  return s ? { ok: true, value: s } : { ok: false, error: `${label}: لازم ساعة بالشكل HH:MM (٠٠–٢٣، والدقايق ٠٠/١٥/٣٠/٤٥)` };
};
const isDay = (d) => typeof d === "string" && DAY_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
  && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/* {meta, google, …} ⇒ أرقام صحيحة ٠–٥٠٠٠؛ أي منصة مش معروفة بترفض */
function platformBudgets(v, label) {
  if (!isObj(v)) return { ok: false, error: `${label}: لازم {meta, google}` };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!PLATFORMS.includes(k)) return { ok: false, error: `${label}: منصة مش معروفة «${k}»` };
    if (x === null || x === "") continue;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0 || n > 5000) return { ok: false, error: `${label} (${k}): لازم رقم بين ٠ و٥٠٠٠` };
    out[k] = Math.round(n);
  }
  return { ok: true, value: out };
}
const capNum = num(0, 20000, { int: true, label: "سقف اليوم" });
const dayMap = (label, max, each) => (v) => {
  if (!isObj(v)) return { ok: false, error: `${label}: لازم {YYYY-MM-DD: …}` };
  const keys = Object.keys(v);
  if (keys.length > max) return { ok: false, error: `${label}: ${max} يوم بالكتير` };
  const out = {};
  for (const d of keys) {
    if (!isDay(d)) return { ok: false, error: `${label}: التاريخ «${d}» لازم YYYY-MM-DD` };
    if (v[d] === null) continue;               // null = امسح اليوم ده (يرجع للافتراضي)
    const r = each(v[d], `${label} ${d}`);
    if (!r.ok) return r;
    out[d] = r.value;
  }
  return { ok: true, value: out };
};
export function normSaPhone(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  const m = d.match(/^(?:00966|966|0)?(5\d{8})$/);
  return m ? `966${m[1]}` : null;
}

export const PATCH_RULES = [
  { re: /^adsGuard\.stopAll$/, check: bool("إيقاف كل الإعلانات") },
  {
    re: /^adsGuard\.window$/, check: (v) => {
      if (!isObj(v)) return { ok: false, error: "نافذة الإعلانات: لازم {from, to}" };
      const a = hhmm("بداية النافذة")(v.from); if (!a.ok) return a;
      const b = hhmm("نهاية النافذة")(v.to); if (!b.ok) return b;
      if (a.value === b.value) return { ok: false, error: "نافذة الإعلانات: البداية والنهاية نفس الساعة" };
      return { ok: true, value: { from: a.value, to: b.value } };   // النهاية ممكن تبقى بعد نص الليل (مثلاً 01:30)
    },
  },
  { re: /^adsGuard\.window\.from$/, check: hhmm("بداية النافذة") },
  { re: /^adsGuard\.window\.to$/, check: hhmm("نهاية النافذة") },
  { re: /^adsGuard\.defaultCap$/, check: capNum },
  { re: /^adsGuard\.dailyCaps$/, check: dayMap("سقف الأيام", 62, (x) => capNum(x)) },
  { re: /^adsGuard\.dailyCaps\.(\d{4}-\d{2}-\d{2})$/, day: true, check: (v) => (v === null ? { ok: true, value: null } : capNum(v)) },
  { re: /^adsGuard\.defaultBudgets$/, check: (v) => platformBudgets(v, "الميزانية الافتراضية") },
  { re: /^adsGuard\.budgets$/, check: dayMap("ميزانيات الأيام", 62, (x, l) => platformBudgets(x, l)) },
  { re: /^adsGuard\.budgets\.(\d{4}-\d{2}-\d{2})$/, day: true, check: (v) => (v === null ? { ok: true, value: null } : platformBudgets(v, "ميزانية اليوم")) },
  {
    /* scope: الحملات نفسها بيحددها اللي بيطلق الحملة — من هنا بيتغيّر enabled بس.
       الفاحص بيبني القيمة من النسخة الحالية (merge) فالروابط والأسماء ماتضيعش. */
    re: /^adsGuard\.scope$/, withCurrent: true, check: (v, current) => {
      const cur = getAt(current, ["adsGuard", "scope"]);
      if (!Array.isArray(cur) || !cur.length) return { ok: false, error: "مفيش حملات في نطاق الحارس" };
      if (!Array.isArray(v)) return { ok: false, error: "حملات الحارس: لازم قايمة" };
      const want = new Map();
      for (const s of v) {
        const key = String(s?.key || "");
        if (!cur.some((c) => c?.key === key)) return { ok: false, error: `الحملة «${key || "فاضي"}» مش في نطاق الحارس` };
        if (typeof s.enabled !== "boolean") return { ok: false, error: `الحملة ${key}: enabled لازم true أو false` };
        want.set(key, s.enabled);
      }
      return { ok: true, value: cur.map((c) => (want.has(c?.key) ? { ...c, enabled: want.get(c.key) } : c)) };
    },
  },
  {
    re: /^adsGuard\.intraday$/, withCurrent: true, check: (v, current) => {
      if (!isObj(v)) return { ok: false, error: "قاعدة الساعة ٨: لازم كائن" };
      const out = { ...(getAt(current, ["adsGuard", "intraday"]) || {}) };
      if ("enabled" in v) { const r = bool("قاعدة الساعة ٨")(v.enabled); if (!r.ok) return r; out.enabled = r.value; }
      if ("after" in v) { const r = hhmm("قاعدة الساعة ٨ — من الساعة")(v.after); if (!r.ok) return r; out.after = r.value; }
      if ("spendOver" in v) { const r = num(0, 20000, { int: true, label: "قاعدة الساعة ٨ — صرف أكتر من" })(v.spendOver); if (!r.ok) return r; out.spendOver = r.value; }
      if ("minNewOrders" in v) { const r = num(1, 50, { int: true, label: "قاعدة الساعة ٨ — أقل عدد عملاء جداد" })(v.minNewOrders); if (!r.ok) return r; out.minNewOrders = r.value; }
      return { ok: true, value: out };
    },
  },
  {
    re: /^adsGuard\.killRule$/, withCurrent: true, check: (v, current) => {
      if (!isObj(v)) return { ok: false, error: "قاعدة الـ٣ أيام: لازم كائن" };
      const out = { ...(getAt(current, ["adsGuard", "killRule"]) || {}) };
      if ("auto" in v) { const r = bool("قاعدة الـ٣ أيام")(v.auto); if (!r.ok) return r; out.auto = r.value; }
      if ("start" in v) { if (!isDay(v.start)) return { ok: false, error: "قاعدة الـ٣ أيام — البداية: لازم YYYY-MM-DD" }; out.start = v.start; }
      if ("afterDays" in v) { const r = num(1, 30, { int: true, label: "قاعدة الـ٣ أيام — بعد كام يوم" })(v.afterDays); if (!r.ok) return r; out.afterDays = r.value; }
      if ("stopIfCpaOver" in v) { const r = num(1, 1000, { label: "تكلفة العميل — إيقاف فوق" })(v.stopIfCpaOver); if (!r.ok) return r; out.stopIfCpaOver = r.value; }
      if ("scaleIfCpaAtMost" in v) { const r = num(1, 1000, { label: "تكلفة العميل — توسيع لحد" })(v.scaleIfCpaAtMost); if (!r.ok) return r; out.scaleIfCpaAtMost = r.value; }
      if (out.scaleIfCpaAtMost != null && out.stopIfCpaOver != null && Number(out.scaleIfCpaAtMost) > Number(out.stopIfCpaOver)) {
        return { ok: false, error: "حد التوسيع لازم يبقى أقل من أو يساوي حد الإيقاف" };
      }
      return { ok: true, value: out };
    },
  },
  {
    /* creditProtect (٩/١٠ — رصيد جوجل ٦٥٠ ريال): لحد ما الشروط تتحقق، الحارس بينزّل
       ميزانية المنصة دي للأرضية بدل ما يوقفها (الساعة ٨ / الـ٣ أيام / السقف).
       platform/promo/note بيحطّهم اللي بيظبط العرض — من هنا الأرضية والتواريخ والتشغيل. */
    re: /^adsGuard\.creditProtect$/, withCurrent: true, check: (v, current) => {
      if (!isObj(v)) return { ok: false, error: "حماية الرصيد: لازم كائن" };
      const cur = getAt(current, ["adsGuard", "creditProtect"]);
      if (!isObj(cur) || !cur.platform) return { ok: false, error: "مفيش عرض رصيد متسجّل في الحارس" };
      const out = { ...cur };
      if ("enabled" in v) { const r = bool("حماية الرصيد")(v.enabled); if (!r.ok) return r; out.enabled = r.value; }
      if ("floor" in v) { const r = num(5, 500, { int: true, label: "حماية الرصيد — الأرضية" })(v.floor); if (!r.ok) return r; out.floor = r.value; }
      if ("from" in v) { if (!isDay(v.from)) return { ok: false, error: "حماية الرصيد — من يوم: لازم YYYY-MM-DD" }; out.from = v.from; }
      if ("until" in v) { if (!isDay(v.until)) return { ok: false, error: "حماية الرصيد — آخر موعد: لازم YYYY-MM-DD" }; out.until = v.until; }
      if ("targetSpend" in v) { const r = num(0, 100000, { int: true, label: "حماية الرصيد — الصرف المطلوب" })(v.targetSpend); if (!r.ok) return r; out.targetSpend = r.value; }
      if ("activeDays" in v) { const r = num(1, 120, { int: true, label: "حماية الرصيد — عدد الأيام" })(v.activeDays); if (!r.ok) return r; out.activeDays = r.value; }
      if (out.from && out.until && out.until < out.from) return { ok: false, error: "حماية الرصيد: آخر موعد قبل البداية" };
      return { ok: true, value: out };
    },
  },
  /* platformStopped: من هنا بس «امسح» (null) — الإيقاف نفسه بيحطّه السكربت */
  { re: /^adsGuard\.platformStopped\.(meta|google|tiktok|snapchat)$/, check: (v) => (v === null ? { ok: true, value: null } : { ok: false, error: "إيقاف المنصة بيتمسح بس من هنا (null)" }) },
  {
    re: /^adsGuard\.smsPhones$/, check: (v) => {
      if (!Array.isArray(v)) return { ok: false, error: "أرقام رسايل الحارس: لازم قايمة" };
      if (!v.length) return { ok: false, error: "أرقام رسايل الحارس: لازم رقم واحد على الأقل" };
      if (v.length > 5) return { ok: false, error: "أرقام رسايل الحارس: ٥ أرقام بالكتير" };
      const out = [];
      for (const p of v) {
        const n = normSaPhone(p);
        if (!n) return { ok: false, error: `الرقم «${String(p).slice(0, 20)}» مش جوال سعودي (05xxxxxxxx)` };
        if (!out.includes(n)) out.push(n);
      }
      return { ok: true, value: out };
    },
  },
  { re: /^adsGuard\.floor$/, check: num(0, 100000, { label: "أرضية الإعلانات" }) },
  { re: /^adsGuard\.ratio$/, check: num(0.01, 1, { label: "نسبة الإعلانات من المبيعات" }) },
  { re: /^adsGuard\.hardCap$/, check: num(0, 100000, { label: "السقف اليومي" }) },
  { re: /^adsGuard\.keepBest$/, check: num(0, 20, { int: true, label: "عدد أحسن الحملات" }) },
  { re: /^jobs\.([^.]+)\.enabled$/, job: true, check: (v) => (typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "تشغيل المهمة: لازم true أو false" }) },
  {
    re: /^jobs\.([^.]+)\.until$/, job: true, check: (v) => {
      if (v === null || v === "") return { ok: true, value: null };
      if (typeof v !== "string" || !DAY_RE.test(v) || Number.isNaN(Date.parse(v))) return { ok: false, error: "تاريخ الانتهاء: لازم YYYY-MM-DD" };
      return { ok: true, value: v };
    },
  },
  {
    re: /^jobs\.morningBudgets\.budgets$/, check: (v) => {
      if (!Array.isArray(v)) return { ok: false, error: "ميزانيات الصبح: لازم قايمة" };
      if (v.length > 30) return { ok: false, error: "ميزانيات الصبح: ٣٠ حملة بالكتير" };
      const out = [];
      const seen = new Set();
      for (const b of v) {
        const id = String(b?.id || "").trim();
        if (!BUDGET_ID_RE.test(id)) return { ok: false, error: `رقم الحملة «${id || "فاضي"}» لازم يكون بالشكل meta/123 أو google/123` };
        if (seen.has(id)) return { ok: false, error: `الحملة ${id} متكررة` };
        seen.add(id);
        const daily = Number(b?.daily);
        if (!Number.isFinite(daily) || daily < 0 || daily > 5000) return { ok: false, error: `ميزانية ${id}: لازم رقم بين ٠ و٥٠٠٠` };
        out.push({ id, name: String(b?.name || "").trim().slice(0, 60), daily: Math.round(daily) });
      }
      return { ok: true, value: out };
    },
  },
];

/* بيفحص {changes:[{path,value}]} على الـallowlist والصف الحالي. */
export function validatePatch(changes, current = {}) {
  const errors = [];
  const values = [];
  if (!Array.isArray(changes) || !changes.length) return { ok: false, errors: [{ path: "", error: "مفيش تغييرات" }], values };
  if (changes.length > 40) return { ok: false, errors: [{ path: "", error: "تغييرات كتير في طلب واحد" }], values };
  for (const ch of changes) {
    const path = String(ch?.path || "");
    const rule = PATCH_RULES.find((r) => r.re.test(path));
    if (!rule) { errors.push({ path, error: "المسار ده مش مسموح يتعدّل من هنا" }); continue; }
    if (rule.job) {
      const name = path.match(rule.re)[1];
      if (!JOB_NAME_RE.test(name) || !isObj(getAt(current, ["jobs", name]))) {
        errors.push({ path, error: `مفيش مهمة مجدولة اسمها «${name}»` }); continue;
      }
    }
    if (rule.day && !isDay(path.match(rule.re)[1])) { errors.push({ path, error: "التاريخ لازم YYYY-MM-DD" }); continue; }
    const r = rule.check(ch?.value, current);
    if (!r.ok) { errors.push({ path, error: r.error }); continue; }
    values.push({ path, value: r.value });
  }
  /* حارس منطقي: الأرضية مايبقاش فوق السقف بعد التعديل. */
  if (!errors.length) {
    const after = clone(current) || {};
    for (const v of values) setAt(after, v.path, v.value);
    const g = after.adsGuard || {};
    if (values.some((v) => v.path === "adsGuard.floor" || v.path === "adsGuard.hardCap") && Number.isFinite(Number(g.floor)) && Number.isFinite(Number(g.hardCap))
      && g.floor != null && g.hardCap != null && Number(g.floor) > Number(g.hardCap)) {
      errors.push({ path: "adsGuard.floor", error: "الأرضية أكبر من السقف اليومي — السقف لازم يبقى أكبر أو يساوي" });
    }
  }
  return { ok: errors.length === 0, errors, values };
}

/* UPDATE واحد لمسار واحد بـjsonb_set، وبيعمل الآباء الناقصين كـ{} في نفس
   الجملة (jsonb_set لوحده مابيعملش غير آخر مستوى). الآباء بيتقروا من data
   الحالية وقت تنفيذ الجملة، فجمل ورا بعض في نفس الـtransaction بتبني على
   بعض. البارامترات: مسار كل أب، ثم مسار الورقة، ثم القيمة. */
export function deepSetStatement(path, value) {
  const ks = parts(path).map(String);
  const params = [];
  let expr = "COALESCE(data,'{}'::jsonb)";
  for (let i = 1; i < ks.length; i++) {
    params.push(ks.slice(0, i));
    const p = `$${params.length}::text[]`;
    expr = `jsonb_set(${expr}, ${p}, CASE WHEN jsonb_typeof(data #> ${p}) = 'object' THEN data #> ${p} ELSE '{}'::jsonb END, true)`;
  }
  params.push(ks);
  const leaf = `$${params.length}::text[]`;
  params.push(JSON.stringify(value === undefined ? null : value));
  expr = `jsonb_set(${expr}, ${leaf}, $${params.length}::jsonb, true)`;
  return { sql: `UPDATE settings SET data = ${expr}, updated_at = NOW() WHERE id=1`, params };
}

/* كذا مسار في transaction واحد (والصف متقفل). changes: [{path,value}] */
export async function applyPathChanges(pool, changes, { lock = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (lock) await client.query("SELECT data FROM settings WHERE id=1 FOR UPDATE");
    for (const ch of changes) {
      const st = deepSetStatement(ch.path, ch.value);
      await client.query(st.sql, st.params);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v));

/* ── المسارات ───────────────────────────────────────────────────────────── */
export function register(app, ctx) {
  const { pool, requireAdmin, requireAmbassadorOrAdmin, isOwner, auditNote } = ctx;
  const note = (c, s) => (typeof auditNote === "function" ? auditNote(c, s) : Promise.resolve());

  app.get("/api/settings", async (c) => {
    const err = await requireAmbassadorOrAdmin(c); if (err) return err;
    const r = await pool.query("SELECT data FROM settings WHERE id=1");
    const data = r.rows[0]?.data || {};
    const owner = isOwner(c);
    const body = owner ? data : redactForViewer(data);
    const rev = settingsRev(data);
    c.header("X-Settings-Rev", rev);
    if (c.req.query("withRev") === "1") return c.json({ settings: body, rev, owner });
    return c.json(body);
  });

  /* الـPUT الكامل: متوافق مع كل الشاشات القديمة. rev اختياري:
       ?rev=… أو هيدر X-Settings-Rev. rev قديم ⇒ 409 {error:"stale", rev}. */
  app.put("/api/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let body;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!isObj(body)) return c.json({ ok: false, error: "bad body" }, 400);
    const sent = String(c.req.query("rev") || c.req.header("X-Settings-Rev") || "").trim();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT data FROM settings WHERE id=1 FOR UPDATE");
      const current = r.rows[0]?.data || {};
      const curRev = settingsRev(current);
      if (sent && sent !== curRev) {
        await client.query("ROLLBACK");
        return c.json({ ok: false, error: "stale", rev: curRev,
          message: "الإعدادات اتغيّرت من مكان تاني بعد ما فتحت الشاشة — حدّث الصفحة وعدّل تاني" }, 409);
      }
      const merged = mergeForPut(current, body, { trusted: Boolean(sent) });
      await client.query("UPDATE settings SET data=$1::jsonb, updated_at=NOW() WHERE id=1", [JSON.stringify(merged)]);
      await client.query("COMMIT");
      return c.json({ ok: true, rev: settingsRev(merged) });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      return c.json({ ok: false, error: String(e?.message || e) }, 500);
    } finally {
      client.release();
    }
  });

  /* حالة حارس الإعلانات (fc-adsentry بيكتبها في ads_sentry_state كل دورة):
     آخر تشغيل (صرف/سقف/النافذة)، آخر أمر بعته لحملة، وقفلات الساعة ٨ النهارده،
     ونتيجة قاعدة الـ٣ أيام والمنصات الموقوفة من settings. للقراية بس. */
  app.get("/api/settings/ads-guard/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let state = null, updatedAt = null;
    try {
      const r = await pool.query("SELECT data, updated_at FROM ads_sentry_state WHERE id=1");
      state = r.rows[0]?.data || null; updatedAt = r.rows[0]?.updated_at || null;
    } catch { /* الجدول لسه ماتعملش — الحارس عمره ما اشتغل */ }
    const g = ((await pool.query("SELECT data FROM settings WHERE id=1")).rows[0]?.data || {}).adsGuard || {};
    return c.json({
      ok: true, updatedAt,
      lastRun: state?.lastRun || null, lastAction: state?.lastAction || null,
      intraday: state?.day && state?.lastRun?.day === state.day ? state.intraday || {} : {},
      capSms: !!state?.capSms, day: state?.day || null, reason: state?.reason || null,
      killRuleLast: g.killRuleLast || null, platformStopped: g.platformStopped || {},
      creditProtect: state?.creditProtect || null, cpYesterday: state?.cpYesterday || null,
    });
  });

  /* تعديل مسارات محددة — للمالك بس. {changes:[{path,value}]} */
  app.post("/api/settings/patch", async (c) => {
    if (!isOwner(c)) return c.json({ ok: false, error: "owner_only", message: "التعديل ده للمالك بس" }, 403);
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const current = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0]?.data || {};
    const v = validatePatch(b?.changes, current);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    try {
      await applyPathChanges(pool, v.values);
    } catch (e) {
      return c.json({ ok: false, error: String(e?.message || e) }, 500);
    }
    const line = `⚙️ إعدادات: ${v.values.map((x) => `${x.path}: ${fmt(getAt(current, x.path))} → ${fmt(x.value)}`).join(" · ")}`.slice(0, 500);
    await note(c, line);
    const after = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0]?.data || {};
    return c.json({ ok: true, changed: v.values.map((x) => x.path), note: line,
      adsGuard: after.adsGuard || {}, jobs: after.jobs || {}, rev: settingsRev(after) });
  });
}
