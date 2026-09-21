/* ═══════════════════════════════════════════════════════════════════════════
   التوصيل بالحي — مندوبين بيسعّروا بالحي مش بالمسافة (٢١ سبتمبر ٢٠٢٦، عمر)

   المشكلة: فوق ١٠٫٥ كم لاجلك **ممكن ترفض** (العقد م٣ بيديهم الحق)، وفوق
   `farZoneMaxKm` إحنا نفسنا بنرفض العنوان. يعني مناطق زي أبحر الشمالية
   وبحرة والساحل مقفولة خالص على المتجر — والعميل بيروح للتطبيقات.

   الحل اللي عمر لقاه: فيه شركات/أفراد بيسعّروا **بالحي** مش بالكيلومتر
   (أغلى شوية، من غير API — واتساب بس). قايمة أسعار منشورة عندهم:
   price.tlbatksa.com/store.html?code=TA79TK — ١٠٤ حي من ١٥ لـ٥٠ ر.س.

   القواعد اللي الملف ده بينفّذها:

   ١) **الجدول ده تكلفة، مش سعر.** الرقم اللي في القايمة = اللي إحنا
      بندفعه للمندوب. اللي العميل بيدفعه = التكلفة + قاعدة هامش صريحة
      وقابلة للتعديل (`margin`): زيادة ثابتة، و/أو تقريب لأعلى ٥.
      من غير الفصل ده أول ما يغيّروا أسعارهم نبقى بنوصّل بالخسارة.

   ٢) **مقفول لحد ما عمر يأكّد.** `enabled:false` افتراضياً، وكل حي
      متسحّب من قايمتهم بييجي `active:false` + `confirmed:false`. يعني
      مفيش ولا ريال بيتحصّل من الجدول ده قبل ما حد بني آدم يفتح اللوحة
      ويقول «آه، الحي ده بالسعر ده».

   ٣) **مابيلمسش المنطقة القريبة ولا المنطقة البعيدة.** الترتيب:
        داخل النطاق (≤ maxKm) → السلّم العادي
        المنطقة البعيدة (≤ farZoneMaxKm) → رسم المسافة الإضافية (زي ما هو)
        غير كده + الحي في الجدول → السعر ده
        غير كده → «خارج النطاق» زي الأول
      (`overrideFarZone:true` بيخلّي الجدول يغلب المنطقة البعيدة كمان.)

   ٤) **الموافقة شرط** — نفس كارت «برّه النطاق» الموجود: من غير `far=1`
      بنرجّع الرفض القديم ومعاه `districtOffer` عشان الواجهة تعرض العرض.

   ٥) **مفيش إرسال تلقائي للاجلك** على الطلبات دي: `districtOfRow()` هي
      اللي البوابة و shop.js بيسألوا عليها، والمدير بيبعت واتساب للمندوب
      بنفس زرار «المندوب الخارجي» الموجود.
═══════════════════════════════════════════════════════════════════════════ */

/* ── تطبيع اسم الحي ──────────────────────────────────────────────────────
   العنوان بييجي من جيوكودر (Nominatim) أو من كتابة العميل، فـ«حيّ الفَيصليّة»
   و«الفيصلية» و«الفيصليه» لازم كلهم يوصلوا لنفس الصف. */
const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
export function normDistrict(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return "";
  s = s.replace(AR_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي").replace(/ؤ/g, "و")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // «حي الفيصلية» → «الفيصلية»؛ «ضاحية الجوهرة» بتفضل زي ما هي (اسم مركّب)
  s = s.replace(/^(حي|حى)\s+/, "");
  return s;
}

/* أجزاء مرشّحة من نص عنوان كامل: «حي الفيصلية، شارع الأمير، جدة» */
export function districtCandidates(v) {
  const raw = String(v == null ? "" : v);
  const parts = raw.split(/[،,\n|—-]+/).map((x) => normDistrict(x)).filter(Boolean);
  const whole = normDistrict(raw);
  const out = [];
  for (const p of [whole, ...parts]) if (p && !out.includes(p)) out.push(p);
  return out;
}

/* ── الإعدادات ─────────────────────────────────────────────────────────── */
export const DEFAULT_MARGIN = Object.freeze({
  mode: "plus_round",   // plus | roundup | plus_round | none
  add: 5,               // + كام ريال فوق تكلفة المندوب
  roundTo: 5,           // تقريب لأعلى لأقرب كام (٠ = بدون)
  min: 0,               // أقل رسم ممكن يتحصّل
  max: null,            // سقف (null = بدون)
});

/* ── مواعيد شغل المندوب (عمر ٢١/٩) ────────────────────────────────────────
   «طلباتك» بيشتغلوا لحد ١:٠٠ بالليل، فآخر طلب نقدر نبعتهولهم ١٢:٤٥.
   الشباك بيلف حوالين نص الليل: من `openHHMM` (الصبح) لـ`lastHHMM` (بعد
   نص الليل) — عشان كده المقارنة تحت بتفرّق بين شباك عادي وشباك لافّ. */
export const DEFAULT_CUTOFF = Object.freeze({
  enabled: true,
  openHHMM: "10:00",     // من إمتى بيردّوا
  lastHHMM: "00:45",     // آخر طلب نبعته (عمر: ١٢:٤٥)
  closesHHMM: "01:00",   // بيقفلوا خالص
  warnMin: 30,           // فاضل أقل من كده → تحذير في البوابة
});

/* ── الترشيح بين «طلباتك» ولاجلك (عمر ٢١/٩) ───────────────────────────────
   لاجلك ثابتة ١٩٫٥٥ شامل الضريبة لحد ١٠ كم، وفوقها +٢٫٣٠/كم بالكسر.
   قاعدة عمر: السلامة (١٥) أرخص من لاجلك — وهي **الحالة الوحيدة** الأرخص.
   وفوق ١٠٫٥ كم لاجلك ممكن ترفض، فـ«طلباتك» هي الافتراضي هناك. */
export const DEFAULT_ROUTING = Object.freeze({
  preferWhenCheaper: true,   // تكلفة الحي < تكلفة لاجلك → ابعت للحي
  preferAboveKm: true,       // فوق farKm → الحي هو الافتراضي (لاجلك بترفض)
  farKm: 10.5,               // نفس رقم عمر في courierSla.farGuard.fromKm
  leajlakFlat: 19.55,        // شامل الضريبة، لحد ١٠ كم
  leajlakPerKm: 2.3,         // شامل، لكل كم فوق ١٠ (بالكسر)
  leajlakBaseKm: 10,
  minSaving: 0.5,            // أقل فرق يستاهل نغيّر بيه الشركة
});

export const DEFAULT_DISTRICT_COURIERS = Object.freeze({
  enabled: false,
  overrideFarZone: false,   // true = الجدول يغلب رسم المسافة الإضافية كمان
  fallbackPrice: null,      // تكلفة افتراضية لحي مفعّل من غير سعر (null = متتحسبش)
  note: "",
  margin: DEFAULT_MARGIN,
  cutoff: DEFAULT_CUTOFF,
  routing: DEFAULT_ROUTING,
  providers: [],            // [{id, name, phone, groupUrl, groupName, note, active}]
  districts: [],            // [{name, price, provider, active, confirmed, source, note}]
});

/* null/""/undefined = «مفيش رقم» — مش صفر. لو رجّعنا ٠ هنا، حي من غير سعر
   كان هيبقى «توصيل ببلاش» بدل ما يتقفل. */
const num = (v) => {
  if (v == null || v === "" || (typeof v === "string" && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v, n = 80) => String(v == null ? "" : v).trim().slice(0, n);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

export function marginCfg(raw) {
  const m = { ...DEFAULT_MARGIN, ...(raw && typeof raw === "object" ? raw : {}) };
  const mode = ["plus", "roundup", "plus_round", "none"].includes(m.mode) ? m.mode : DEFAULT_MARGIN.mode;
  return {
    mode,
    add: Math.max(0, num(m.add) ?? 0),
    roundTo: Math.max(0, num(m.roundTo) ?? 0),
    min: Math.max(0, num(m.min) ?? 0),
    max: num(m.max) != null && num(m.max) > 0 ? num(m.max) : null,
  };
}

/* قاعدة الهامش — صريحة عن قصد عشان عمر يقراها ويغيّرها من اللوحة.
   ١) plus         → التكلفة + add
   ٢) roundup      → تقريب التكلفة لأعلى لأقرب roundTo
   ٣) plus_round   → (التكلفة + add) مقرّبة لأعلى لأقرب roundTo   ← الافتراضي
   ٤) none         → التكلفة زي ما هي (بنوصّل بالتكلفة، من غير ربح)  */
export function applyMargin(cost, rawMargin) {
  const m = marginCfg(rawMargin);
  const c = Math.max(0, num(cost) ?? 0);
  let fee = c;
  if (m.mode === "plus" || m.mode === "plus_round") fee = c + m.add;
  if ((m.mode === "roundup" || m.mode === "plus_round") && m.roundTo > 0) {
    fee = Math.ceil((fee - 1e-9) / m.roundTo) * m.roundTo;
  }
  if (fee < m.min) fee = m.min;
  if (m.max != null && fee > m.max) fee = m.max;
  // الرسم بيدخل فاتورة نقطة البيع ككمية × صنف بريال، فلازم يبقى ريالات صحيحة
  return Math.max(0, Math.round(fee));
}

/* وصف القاعدة بالعربي — بيتعرض في اللوحة وفي تفاصيل الطلب */
export function marginLabel(rawMargin) {
  const m = marginCfg(rawMargin);
  const bits = [];
  if (m.mode === "plus" || m.mode === "plus_round") bits.push(`+ ${m.add} ر.س`);
  if ((m.mode === "roundup" || m.mode === "plus_round") && m.roundTo > 0) bits.push(`تقريب لأعلى ${m.roundTo}`);
  if (!bits.length) bits.push("بالتكلفة (بدون هامش)");
  if (m.min > 0) bits.push(`حد أدنى ${m.min}`);
  if (m.max != null) bits.push(`سقف ${m.max}`);
  return `التكلفة ${bits.join(" · ")}`;
}

/* ═══ مواعيد الشغل ═════════════════════════════════════════════════════════
   الرياض UTC+3 ثابتة طول السنة (مفيش توقيت صيفي) — فالحساب ساعات ثابتة،
   من غير Intl ولا مكتبة. نفس اللي bizday.js بيعمله. */
export const RIYADH_OFFSET_H = 3;
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "00:45" → 45 (دقايق من نص الليل). أي حاجة غلط → null. */
export function hhmmToMin(v) {
  const m = HHMM_RE.exec(String(v == null ? "" : v).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function minToHhmm(v) {
  const n = ((Math.round(Number(v) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
/** دقايق اليوم بتوقيت الرياض للحظة. */
export function riyadhMinutes(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : at ? Date.parse(at) : Date.now();
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + RIYADH_OFFSET_H * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function cutoffCfg(raw) {
  const c = { ...DEFAULT_CUTOFF, ...(raw && typeof raw === "object" ? raw : {}) };
  const open = hhmmToMin(c.openHHMM) ?? hhmmToMin(DEFAULT_CUTOFF.openHHMM);
  const last = hhmmToMin(c.lastHHMM) ?? hhmmToMin(DEFAULT_CUTOFF.lastHHMM);
  const close = hhmmToMin(c.closesHHMM);
  return {
    enabled: c.enabled !== false,
    openHHMM: minToHhmm(open),
    lastHHMM: minToHhmm(last),
    closesHHMM: close == null ? null : minToHhmm(close),
    warnMin: Math.max(0, Math.min(180, num(c.warnMin) ?? DEFAULT_CUTOFF.warnMin)),
  };
}

/* districtCutoff(cfg, at) → حالة الشباك دلوقتي.
     open   — لسه بدري، والدقايق الفاضلة في `minutesLeft`
     soon   — فاضل أقل من warnMin
     closed — عدّى ١٢:٤٥ (أو لسه مافتحوش)

   الشباك لافّ حوالين نص الليل (١٠:٠٠ → ٠٠:٤٥) فالمقارنة `m >= open || m <= last`.
   لو حد ظبّط شباك عادي (٠٩:٠٠ → ١٧:٠٠) بتشتغل صح برضه بـ`m >= open && m <= last`. */
export function districtCutoff(rawCfg, at = Date.now()) {
  const cfg = cutoffCfg(((rawCfg || {}).cutoff) || rawCfg);
  const m = riyadhMinutes(at);
  const open = hhmmToMin(cfg.openHHMM), last = hhmmToMin(cfg.lastHHMM);
  const base = { enabled: cfg.enabled, openHHMM: cfg.openHHMM, lastHHMM: cfg.lastHHMM, closesHHMM: cfg.closesHHMM, nowHHMM: m == null ? null : minToHhmm(m) };
  if (!cfg.enabled || m == null) return { ...base, state: "open", open: true, minutesLeft: null };
  const wraps = open > last;
  const inside = wraps ? (m >= open || m <= last) : (m >= open && m <= last);
  if (!inside) {
    return { ...base, state: "closed", open: false, minutesLeft: 0,
      reason: `«${"المندوب"}» بيستقبل من ${cfg.openHHMM} لـ${cfg.lastHHMM} بس` };
  }
  // الدقايق لحد آخر ميعاد — لو الشباك لافّ والوقت قبل نص الليل، زوّد يوم
  let left = last - m;
  if (left < 0) left += 1440;
  return { ...base, state: left <= cfg.warnMin ? "soon" : "open", open: true, minutesLeft: left };
}

/* ═══ الترشيح بين «طلباتك» ولاجلك ══════════════════════════════════════════ */
export function routingCfg(raw) {
  const r = { ...DEFAULT_ROUTING, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    preferWhenCheaper: r.preferWhenCheaper !== false,
    preferAboveKm: r.preferAboveKm !== false,
    farKm: Math.max(0, num(r.farKm) ?? DEFAULT_ROUTING.farKm),
    leajlakFlat: Math.max(0, num(r.leajlakFlat) ?? DEFAULT_ROUTING.leajlakFlat),
    leajlakPerKm: Math.max(0, num(r.leajlakPerKm) ?? DEFAULT_ROUTING.leajlakPerKm),
    leajlakBaseKm: Math.max(0, num(r.leajlakBaseKm) ?? DEFAULT_ROUTING.leajlakBaseKm),
    minSaving: Math.max(0, num(r.minSaving) ?? DEFAULT_ROUTING.minSaving),
  };
}

/** تكلفة لاجلك لمشوار طوله km — ثابت لحد ١٠، وفوقها بالكسر (العقد م١٢). */
export function leajlakCostFor(km, rawRouting) {
  const r = routingCfg(rawRouting);
  const d = num(km);
  if (d == null || !(d > r.leajlakBaseKm)) return r2(r.leajlakFlat);
  return r2(r.leajlakFlat + (d - r.leajlakBaseKm) * r.leajlakPerKm);
}

/* districtRouting(cfg, {district, km}) → مين يوصّل الطلب ده وليه.
   بيرجّع null لو مفيش تسعيرة حي أصلاً (يعني لاجلك زي ما هي).
   { prefer:true }  = ابعت لـ«طلباتك»
   { prefer:false } = سيبها للاجلك (أرخص وبتغطي المشوار) */
export function districtRouting(cfg, { district, km, at = Date.now(), quote = null } = {}) {
  const q = quote || districtQuote(cfg, district);
  if (!q) return null;
  const r = routingCfg((cfg || {}).routing);
  const cut = districtCutoff(cfg, at);
  const leajlak = leajlakCostFor(km, r);
  const saving = r2(leajlak - q.cost);
  const far = km != null && Number(km) > r.farKm;
  let prefer = false, reason = "لاجلك أرخص وبتغطي المشوار";
  if (r.preferAboveKm && far) {
    prefer = true;
    reason = `المشوار ${r1(km)} كم — فوق ${r.farKm} لاجلك ممكن ترفض (العقد م٣)`;
  } else if (r.preferWhenCheaper && saving >= r.minSaving) {
    prefer = true;
    reason = `${q.district} بـ${q.cost} ر.س — أرخص من لاجلك بـ${saving} ر.س`;
  }
  if (prefer && !cut.open) {
    return { prefer: false, blocked: true, cutoff: cut, reason: `${reason} — بس المندوب قافل (آخر ميعاد ${cut.lastHHMM})`,
      leajlakCost: leajlak, cost: q.cost, saving, far, quote: q };
  }
  return { prefer, blocked: false, cutoff: cut, reason, leajlakCost: leajlak, cost: q.cost, saving, far, quote: q };
}

/* تنظيف/تطبيع الإعدادات الجاية من قاعدة البيانات أو من اللوحة */
export function districtCfg(settings) {
  const raw = ((settings || {}).delivery || {}).districtCouriers;
  const src = raw && typeof raw === "object" ? raw : {};
  const providers = (Array.isArray(src.providers) ? src.providers : [])
    .map((p, i) => ({
      id: str(p && p.id, 40) || `p${i + 1}`,
      name: str(p && p.name, 60),
      phone: String((p && p.phone) || "").replace(/\D/g, "").slice(0, 15),
      /* الطلب بيتبعت في **جروب** واتساب مش لرقم (عمر ٢١/٩): المدير بينشر
         في الجروب، واللي ياخده هو اللي بيكلّمه. فده رابط دعوة الجروب
         (chat.whatsapp.com/...) — بنفتحه بعد ما ننسخ النص. */
      groupUrl: /^https:\/\/(chat\.whatsapp\.com|wa\.me|web\.whatsapp\.com)\//i.test(String((p && p.groupUrl) || "").trim())
        ? String(p.groupUrl).trim().slice(0, 200) : "",
      groupName: str(p && p.groupName, 60),
      note: str(p && p.note, 200),
      active: (p && p.active) !== false,
    }))
    .filter((p) => p.name);
  const seen = new Set();
  const districts = (Array.isArray(src.districts) ? src.districts : [])
    .map((d) => ({
      name: str(d && d.name, 60),
      key: normDistrict(d && d.name),
      price: num(d && d.price),
      provider: str(d && d.provider, 40) || null,
      active: (d && d.active) === true,
      confirmed: (d && d.confirmed) === true,
      source: str(d && d.source, 40) || null,
      note: str(d && d.note, 200),
    }))
    .filter((d) => {
      if (!d.name || !d.key || seen.has(d.key)) return false;
      seen.add(d.key);
      return true;
    });
  return {
    enabled: src.enabled === true,
    overrideFarZone: src.overrideFarZone === true,
    fallbackPrice: num(src.fallbackPrice),
    note: str(src.note, 500),
    margin: marginCfg(src.margin),
    cutoff: cutoffCfg(src.cutoff),
    routing: routingCfg(src.routing),
    providers,
    districts,
  };
}

export function providerOf(cfg, id) {
  const list = (cfg && cfg.providers) || [];
  if (!list.length) return null;
  const hit = id ? list.find((p) => p.id === id) : null;
  return hit || list.find((p) => p.active) || list[0] || null;
}

/* ── البحث عن الحي ──────────────────────────────────────────────────────
   مطابقة تامة على الاسم المطبَّع أولاً. لو فشلت، «يحتوي» — بس بشرط إن
   مرشّح واحد بالظبط هو اللي يطابق، عشان «النزهة» ما تختارش «النزهة
   الشرقية» بالعشوائي. */
export function findDistrict(cfg, name) {
  const list = (cfg && cfg.districts) || [];
  if (!list.length) return null;
  const cands = districtCandidates(name);
  if (!cands.length) return null;
  for (const c of cands) {
    const exact = list.find((d) => d.key === c);
    if (exact) return exact;
  }
  for (const c of cands) {
    if (c.length < 3) continue;
    const near = list.filter((d) => d.key === c || d.key.includes(c) || c.includes(d.key));
    if (near.length === 1) return near[0];
  }
  return null;
}

/* districtQuote(cfg, name) → null لو مفيش تسعيرة بالحي، أو الشكل الكامل.
   بيرجّع null كمان لو الميزة مقفولة أو الحي مش مفعّل أو مفيش سعر. */
export function districtQuote(cfg, name) {
  if (!cfg || cfg.enabled !== true) return null;
  const d = findDistrict(cfg, name);
  if (!d || !d.active) return null;
  const cost = d.price != null ? d.price : cfg.fallbackPrice;
  if (cost == null || !(cost >= 0)) return null;
  const p = providerOf(cfg, d.provider);
  const fee = applyMargin(cost, cfg.margin);
  return {
    district: d.name,
    cost: r2(cost),
    fee,
    margin: r2(fee - cost),
    marginRule: marginLabel(cfg.margin),
    confirmed: d.confirmed === true,
    provider: p ? { id: p.id, name: p.name, phone: p.phone || null, note: p.note || null,
      groupUrl: p.groupUrl || null, groupName: p.groupName || null } : null,
  };
}

/* أسماء الأحياء المفعّلة — للواجهة لما الجيوكودر ما يعرفش الحي */
export function activeDistrictNames(cfg) {
  return ((cfg && cfg.districts) || [])
    .filter((d) => d.active && (d.price != null || cfg.fallbackPrice != null))
    .map((d) => d.name);
}

/* ── قراءة الطلب ────────────────────────────────────────────────────────
   محفوظة جوّه `delivery_quote.districtDelivery` — مفيش عمود جديد، بالظبط
   زي `farZone`، عشان مصدر الرقم يفضل واحد. */
export function districtOfRow(row = {}) {
  let q = row && row.delivery_quote;
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const d = q && q.districtDelivery;
  if (d && typeof d === "object" && d.district) return { ...d, mode: "priced" };
  /* «إرسال بالحي» — الطلب جوّه النطاق والعميل دفع السلّم العادي، بس المندوب
     بالحي أرخص من لاجلك (السلامة ١٥ < ١٩٫٥٥) فالتوصيل بيروحله. الرسم اللي
     العميل دفعه مالوش علاقة بالجدول هنا — `fee` بتفضل رسم السلّم. */
  const s = q && q.districtDispatch;
  if (s && typeof s === "object" && s.district) return { ...s, mode: "dispatch" };
  return null;
}

/* ── قايمة «طلباتك» المنشورة (١٠٤ حي) ─────────────────────────────────────
   مسحوبة من price.tlbatksa.com/store.html?code=TA79TK يوم ٢١/٩/٢٠٢٦.
   دي **بداية** مش حقيقة: بتتحمّل بـactive:false + confirmed:false، وعمر
   بيأكّد السعر ويفعّل الحي من اللوحة.
   ملاحظة: «النزهة» كانت مكرّرة في قايمتهم (٢٥ و٣٠) — خدنا الأغلى (٣٠)
   عشان ما نسعّرش بأقل من التكلفة الحقيقية. */
export const SEED_SOURCE = "tlbatksa-2026-09-21";
export const SEED_PRICE_LIST = Object.freeze({
  15: ["السلامة"],
  20: ["النعيم", "الزهراء", "الروضة", "النهضة", "الفيصلية", "البوادي"],
  25: ["المحمدية", "الخالدية"],
  30: ["الاندلس", "التوفيق", "البغدادية", "الجامعة", "الثغر", "الحمراء", "الوزيرية", "مشرفة",
    "مدائن الفهد", "قويزة", "بريمان", "بني مالك", "الأجواد", "الورود", "الواحة", "النسيم",
    "النزلة اليمانية", "النزلة الشرقية", "النزلة", "المنتزة", "النخيل", "المنار", "المروة",
    "المدائن", "الفيحاء", "العزيزية", "الصفا", "الشرفية", "السامر", "السليمانية", "الرويس",
    "الرغامة", "الروابي", "الرحاب", "الربوة", "البساتين", "المرجان", "الشاطئ", "النزهة"],
  35: ["المشروع", "أبحر الجنوبية", "البشائر", "الحمدانية", "الريان", "الصالحية", "الفلاح",
    "الكوثر", "المطار", "الهنداوية", "حي الاصيل", "ضاحية الجوهرة", "الاصالة", "البلد",
    "التيسير", "الاجاويد", "الجوهرة جنوب", "السبيل", "السنابل", "الكندرة", "الهدى",
    "المنتزهات", "مريخ", "غليل", "حي الشفاء", "كيلو 14"],
  40: ["القوزين", "الحرازات", "أم السلم", "مخطط الرياض", "القوس", "المحاميد", "المرسلات",
    "المحجر", "الفضيلة", "الفضل", "الخمرة", "القرينية", "الفيصل جنوب", "الالفية", "الوفاء",
    "طيبة", "اللؤلؤ", "الياقوت", "الشراع", "الرحمانية", "الفروسية", "أبحر الشمالية"],
  50: ["الساحل", "البحيرات خلف ابحر", "الفنار", "المنارات", "بحرة", "الوادي", "البركة"],
});

export function seedDistricts({ provider = "tlbatksa" } = {}) {
  const out = [], seen = new Set();
  for (const price of Object.keys(SEED_PRICE_LIST).map(Number).sort((a, b) => b - a)) {
    for (const name of SEED_PRICE_LIST[price]) {
      const key = normDistrict(name);
      if (!key || seen.has(key)) continue;   // «النزهة» المكرّرة: الأغلى بيكسب
      seen.add(key);
      out.push({ name, price, provider, active: false, confirmed: false, source: SEED_SOURCE, note: "" });
    }
  }
  return out.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name, "ar"));
}

export function seedConfig() {
  return {
    ...DEFAULT_DISTRICT_COURIERS,
    margin: { ...DEFAULT_MARGIN },
    cutoff: { ...DEFAULT_CUTOFF },
    routing: { ...DEFAULT_ROUTING },
    providers: [{
      id: "tlbatksa", name: "طلباتك", phone: "", groupUrl: "", groupName: "جروب طلباتك", active: true,
      note: "الطلب بيتنشر في جروب الواتساب بتاعهم — اللي ياخده هو اللي بيكلّم المدير. قايمة الأسعار: price.tlbatksa.com/store.html?code=TA79TK",
    }],
    districts: seedDistricts(),
    note: "الأسعار من قايمتهم المنشورة يوم ٢١/٩/٢٠٢٦ — محتاجة تأكيد المالك قبل التفعيل. الأسعار مابتشملش السيارات الكبيرة، وفيه رسوم إضافية لو الطلب محتاج تحميل.",
  };
}

/* ═══ المسارات ═════════════════════════════════════════════════════════ */
export function register(app, ctx) {
  const { pool, getSettingsData, requireAdmin, jb } = ctx;
  const log = ctx.log || console;
  const J = jb || ((v) => JSON.stringify(v));

  const load = async () => districtCfg(await getSettingsData().catch(() => ({})));

  /* الكتابة بـjsonb_set على المفتاح ده بس — اللوحة بتحفظ الإعدادات كلها
     بـPUT واحد، فلو كتبنا البلوب كامل من هنا ممكن ندوس على تعديل حصل في
     نفس اللحظة من شاشة تانية. `delivery` بتتعمل لو مش موجودة. */
  async function saveCfg(next) {
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN COALESCE(data,'{}'::jsonb) ? 'delivery' THEN COALESCE(data,'{}'::jsonb)
              ELSE COALESCE(data,'{}'::jsonb) || '{"delivery":{}}'::jsonb END,
         '{delivery,districtCouriers}', $1::jsonb, true), updated_at=NOW() WHERE id=1`,
      [J(next)]);
  }

  /* عام — الواجهة محتاجة تعرف: الميزة شغّالة؟ وإيه الأحياء اللي نقدر
     نوصّلها؟ (أسماء بس — من غير أسعار التكلفة ولا أرقام المندوبين.) */
  app.get("/api/delivery/districts/public", async (c) => {
    const cfg = await load();
    const cut = districtCutoff(cfg);
    return c.json({
      ok: true,
      enabled: cfg.enabled,
      districts: cfg.enabled && cut.open ? activeDistrictNames(cfg) : [],
      /* الواجهة محتاجة تعرف إن الشباك قفل عشان تقول للعميل ليه — من غير
         ده كان هيشوف «حيّك مش مغطّى» وهو مغطّى بس الوقت متأخر. */
      cutoff: { open: cut.open, state: cut.state, lastHHMM: cut.lastHHMM, openHHMM: cut.openHHMM,
        minutesLeft: cut.minutesLeft, nowHHMM: cut.nowHHMM },
    });
  });

  app.get("/api/delivery/districts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await load();
    const active = cfg.districts.filter((d) => d.active).length;
    const cut = districtCutoff(cfg);
    const r = routingCfg(cfg.routing);
    return c.json({
      ok: true, config: cfg,
      marginLabel: marginLabel(cfg.margin),
      cutoff: cut,
      /* «مين أرخص» لكل سعر في الجدول — عمر بيشوف بعينه إن السلامة (١٥) هي
         الوحيدة اللي تحت لاجلك، من غير ما يحسب. */
      routingPreview: [...new Set(cfg.districts.map((d) => d.price).filter((p) => p != null))]
        .sort((a, b) => a - b)
        .map((cost) => ({ cost, leajlak: r.leajlakFlat, saving: r2(r.leajlakFlat - cost),
          cheaper: r.leajlakFlat - cost >= r.minSaving })),
      counts: { total: cfg.districts.length, active, confirmed: cfg.districts.filter((d) => d.confirmed).length },
      // معاينة الهامش على الأسعار الموجودة — عمر يشوف الرسم قبل ما يفعّل
      preview: [...new Set(cfg.districts.map((d) => d.price).filter((p) => p != null))]
        .sort((a, b) => a - b)
        .map((cost) => ({ cost, fee: applyMargin(cost, cfg.margin), margin: r2(applyMargin(cost, cfg.margin) - cost) })),
    });
  });

  app.put("/api/delivery/districts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const next = districtCfg({ delivery: { districtCouriers: b.config || b } });
    await saveCfg(next);
    log.log?.(`[districts] saved: enabled=${next.enabled} districts=${next.districts.length} active=${next.districts.filter((d) => d.active).length}`);
    return c.json({ ok: true, config: next, marginLabel: marginLabel(next.margin) });
  });

  /* استيراد القايمة المنشورة — بيدمج مع الموجود (السعر المؤكّد ما يتلمسش) */
  app.post("/api/delivery/districts/seed", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const cur = await load();
    const seed = seedConfig();
    const byKey = new Map(cur.districts.map((d) => [d.key, d]));
    let added = 0, updated = 0;
    for (const s of seed.districts) {
      const k = normDistrict(s.name);
      const old = byKey.get(k);
      if (!old) { byKey.set(k, { ...s, key: k }); added++; continue; }
      // حي مؤكّد من عمر: سعره هو المرجع، القايمة ما تدوسش عليه
      if (old.confirmed || b.overwrite !== true) continue;
      byKey.set(k, { ...old, price: s.price, source: s.source, confirmed: false });
      updated++;
    }
    const providers = cur.providers.length ? cur.providers : seed.providers;
    const next = districtCfg({ delivery: { districtCouriers: { ...cur, providers, districts: [...byKey.values()] } } });
    await saveCfg(next);
    return c.json({ ok: true, added, updated, total: next.districts.length, config: next });
  });

  /* تجربة اسم حي زي ما الواجهة هتبعته */
  app.get("/api/delivery/districts/match", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await load();
    const name = c.req.query("name") || "";
    const hit = findDistrict(cfg, name);
    return c.json({
      ok: true, name, normalized: normDistrict(name), candidates: districtCandidates(name),
      match: hit ? { name: hit.name, price: hit.price, active: hit.active, confirmed: hit.confirmed } : null,
      quote: districtQuote(cfg, name),
      routing: districtRouting(cfg, { district: name, km: num(c.req.query("km")) }),
    });
  });

  return { cfg: load, districtQuote, findDistrict, districtRouting, districtCutoff };
}

export default { register, districtCfg, districtQuote, findDistrict, normDistrict, applyMargin, districtOfRow,
  districtCutoff, districtRouting, leajlakCostFor, cutoffCfg, routingCfg };
