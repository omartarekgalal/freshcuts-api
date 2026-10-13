/* ═══════════════════════════════════════════════════════════════════════════
   wabrief.js — «ملف معرفة البيزنس» لمساعد واتساب (PK1 — ١٤/١٠/٢٠٢٦)

   عمر (١٣/١٠ بالليل): «حاسس انه مش بالذكاء الكافي ولا عنده علم كافي بالبيزنس والمبيعات». محادثات يوم ١٣/١٠ أثبتتها:
   «كيف أطلب من الموقع؟» ⇒ «ما عندي تفاصيل مؤكدة…»، «المشكل مكوّن من ايه ويكفي كم شخص» ⇒ «ما أقدر أفصّل…»، والعميل مشي.
   غيّرنا الموديل للقوي وجرّبنا نفس السؤال: نفس الرد ⇒ الناقص معرفة، مش حجم موديل.

   الملف ده فيه:
     ١) الحقول: نص عربي عادي لكل حقل (مش JSON)، بعنوانه وشرحه وقيمته الافتراضية اللي اتملت من المنيو الحي والإعدادات وإجابات المالك السابقة،
        والحقول اللي مايعرفهاش غير المالك متعلّم عليها (owner: true) وفاضية.
     ٢) المراجعة: أي حقل فيه وصفة / مقادير / مورّد / ادعاء صحي / وعد وقت / رابط / خصم (نفس مراجعة قاعدة معرفة المدير)، أو عدد أشخاص للمشكل المخصوص،
        مابيتحفظش — ولو اتخزّن بأي طريقة مابيتبعتش للموديل (المراجعة بتتعاد وقت القراءة).
     ٣) «المنيو الحي في سطور»: الأقسام والأصناف والبوكسات بأسعارها **وقت الرسالة** (من نفس مصدر أدوات المساعد). مابيتكتبش في الإعدادات.
     ٤) الكتلة اللي بتتبعت للموديل (كتلة تعليمات تانية، بتتخزّن في كاش المزوّد مع التعليمات): الحقول + المنيو الحي.

   التخزين: settings.waBot.brief = { key: نص } للحقول اللي المالك غيّرها بس. حقل مش مخزّن ⇒ القيمة الافتراضية. نص فاضي مخزّن ⇒ الحقل مقفول.
   الموديول ده مابيبعتش أي رسالة ومابيكلّمش أي موديل.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize } from "./wabot.js";
import { kbCheck, KB_PROBLEM_AR } from "./wakb.js";
import { servingClaim } from "./waassist.js";

export const BRIEF_LIMITS = Object.freeze({ field: 500, total: 6000 });
export const BRIEF_SECTIONS = Object.freeze([
  { id: "order", ar: "الطلب خطوة بخطوة", en: "How ordering works" },
  { id: "pay", ar: "الدفع", en: "Payment" },
  { id: "delivery", ar: "التوصيل والمواعيد", en: "Delivery and opening hours" },
  { id: "grill", ar: "المشاوي (العيلتين) والمشكل المخصوص", en: "The two grill families and «مشكل مخصوص»" },
  { id: "sell", ar: "أقترح إيه لكام شخص", en: "What to propose, by number of people" },
  { id: "menu", ar: "الحلى والمشروبات واللي مش عندنا", en: "Desserts, drinks and what we do not sell" },
  { id: "offers", ar: "أول طلب والولاء وكود التوصيل المجاني", en: "First order, loyalty and the free-delivery code" },
  { id: "more", ar: "أي حاجة تانية", en: "Anything else" },
]);
/* src = منين اتملت القيمة الافتراضية (بيتعرض للمالك). owner: true = مايعرفهاش غير المالك (فاضية لحد ما يكتبها). mashakel: true = أي عدد أشخاص فيها مرفوض حتى من غير كلمة «مشكل». */
const F = (key, section, ar, help, def, src, extra = {}) => Object.freeze({ key, section, ar, help, def, src, rows: 3, ...extra });
export const BRIEF_FIELDS = Object.freeze([
  F("order_steps", "order", "خطوات الطلب (٣ خطوات)", "إجابة «كيف أطلب؟». ماجد بيقولها بثقة وبعدها «وش تحب تطلب؟».",
    "١) تكتب لي هنا اللي تبيه وأجهّز لك سلة جاهزة بالأسعار.\n٢) تضغط زر «كمّل طلبك» ويفتح لك موقعنا والسلة فيه.\n٣) تحدد موقعك على الخريطة (أو تختار استلام من الفرع) وتدفع أونلاين، ويوصلك تأكيد الطلب ورابط التتبّع.",
    "من مسار السلة الجاهزة في النظام + نص «أبي أطلب» في البوت"),
  F("order_modes", "order", "طرق الطلب المتاحة", "توصيل / استلام / أكل في الصالة. اكتب اللي متاح فعلاً بس.",
    "توصيل داخل جدة، أو استلام من الفرع في حي السلامة (بدون رسوم توصيل).\nوللي يأكل عندنا في الصالة: يمسح رمز QR اللي على الطاولة ويطلب من جواله.",
    "من إعدادات المتجر (التوصيل + الاستلام) وطلب الطاولات اللي اشتغل ٥/١٠"),
  F("car_pickup", "order", "الاستلام من السيارة", "لو متاح: العميل يعمل إيه لما يوصل؟ لو مش متاح سيبها فاضية وماجد مايعرضهاش.", "", "قرار المالك", { owner: true, rows: 2 }),
  F("payment", "pay", "طرق الدفع المقبولة", "", "الدفع أونلاين على موقعنا عند إتمام الطلب: Apple Pay، مدى، البطاقات الائتمانية، وSTC Pay.", "من أسئلة المتجر الشائعة (طرق الدفع)", { rows: 2 }),
  F("payment_not", "pay", "اللي مش مقبول", "بيتقال بس لو العميل سأل عنه.", "طلبات الموقع (توصيل أو استلام) دفعها أونلاين فقط: ما فيه دفع كاش عند الاستلام أو التوصيل، وما نستقبل تحويل بنكي.", "من إعداد المتجر (الكاش مقفول، قرار ١٢/٨) ونص البوت «ادفع تحويل / كاش؟»", { rows: 2 }),
  F("delivery_area", "delivery", "نطاق التوصيل", "", "نوصّل داخل جدة فقط من فرعنا في حي السلامة. التغطية تتأكد من موقع العميل نفسه (الدبوس) مو من اسم الحي.", "من سياسة التوصيل ونص البوت", { rows: 2 }),
  F("delivery_fees", "delivery", "رسوم التوصيل بالكلام", "من غير أرقام: الأرقام بتتقري من سياسة التوصيل وقت السؤال.", "رسوم التوصيل حسب قيمة الطلب: كل ما كبر الطلب قلّت الرسوم، ومن حد معيّن يصير التوصيل مجاني. الرقم الدقيق يطلع بعد مشاركة الموقع، ويظهر مرة ثانية في الموقع قبل الدفع. والاستلام من الفرع بدون رسوم.", "من سلّم الرسوم في سياسة التوصيل"),
  F("hours_note", "delivery", "وإحنا مقفولين", "المواعيد نفسها بتتقري من النظام.", "لو مقفلين: نقول متى نفتح، ونجهّز السلة من الحين والعميل يكمّل طلبه وقت ما نفتح.", "من سلوك البوت الحالي", { rows: 2 }),
  F("grill_meals", "grill", "وجبات المشاوي", "الوجبة فيها إيه وبتتقدم مع إيه.", "الوجبات: مشوي على الفحم لشخص واحد، تُقدَّم مع الأرز والسلطة والطحينة (مثل وجبة كفتة، وجبة طرب، وجبة شيش طاووق، وجبة ميكس جريل).", "من وصف الوجبات في المنيو الحي"),
  F("grill_weight", "grill", "المشاوي بالوزن", "بتتقدم مع إيه؟ فيها أرز؟", "المشاوي بالوزن: ثلث كيلو أو نصف كيلو أو كيلو من النوع اللي يختاره العميل، تُقدَّم مع السلطة والطحينة والخبز. الأرز مو معها: يجي مع الوجبات وداخل البوكسات.", "من كلام المالك (٢٦/٨: بالوزن من غير أرز، سلطة وطحينة · ١٤/٩: الخبز مع المشاوي) ووصف بوكسات المشاوي الحي"),
  F("mashakel_line", "grill", "المشكل المخصوص في سطر (للعميل)", "سطر عام واحد. ممنوع فيه: عدد أشخاص، أوزان المكونات، عدد القطع أو الأسياخ.", "مشكل مخصوص: تشكيلة من مشاوينا على الفحم، تُباع بالوزن (ثلث كيلو، نصف كيلو، كيلو) وتُقدَّم مع السلطة والطحينة والخبز.", "من اسم الصنف ووصفه في المنيو الحي + اللي بيتقدم مع المشاوي بالوزن", { mashakel: true, rows: 2 }),
  F("mashakel_kinds", "grill", "أنواع المشاوي اللي في المشكل المخصوص", "الأنواع بالاسم بس (مثال: كفتة، طرب…). من غير أوزان ولا عدد. لو فاضية: ماجد مايقولش الأنواع.", "", "مايعرفها غير المالك", { owner: true, mashakel: true, rows: 2 }),
  F("mashakel_steer", "grill", "بدل «يكفي كم شخص»", "ماجد مابيقولش الوزن يكفي كام. بيعمل إيه بدالها؟", "لما العميل يسأل المشكل يكفي كم شخص: نسأله كم شخص هم، ونقترح عليه بوكس معمول لعددهم بسعره ومحتواه. ولو يبيه بالوزن: يختار الوزن بنفسه، ويقدر يبدأ بوزن ويزيد.", "من قرار المالك (١٠/١٠: المشكل مايتقالش يكفي كام) + البوكسات الحية", { mashakel: true }),
  F("sell_one", "sell", "لشخص واحد", "اكتب أسماء الأصناف والبوكسات زي المنيو بالظبط: السعر بيتحط لوحده من المنيو الحي.", "مشاوي: وجبة من الوجبات، أو «بوكس وجبة المشاوي الفردي» / «بوكس الميكس جريل الفردي» (الوجبة + جانبي + مشروب).\nكريب / برجر / باستا / حواوشي: البوكس الفردي من نفس النوع (الصنف + جانبي + مشروب).", "من قسم «بوكسات فردية» في المنيو الحي"),
  F("sell_two", "sell", "لشخصين", "", "مشاوي: «ميكس جريل لشخصين» أو «وجبتين مشاوي لشخصين».\nكريب: «بوكس الكريب لشخصين». برجر: «بوكس البرجر لشخصين». بيتزا وباستا: «بيتزا وباستا لشخصين». سهرة: «بوكس السهرة».", "من قسم «بوكسات لشخصين» في المنيو الحي"),
  F("sell_family", "sell", "لعائلة (٣ إلى ٥)", "", "مشاوي: «بوكس المشاوي نص ونص»، أو «بوكس المشكل المخصوص»، أو «بوكس الريش والمشاوي».\nمشاوي مع بيتزا وباستا: «بوكس العائلة — مشاوي وبيتزا وباستا». تشكيلة: «بوكس التشكيلة». بيتزا: «بوكس سهرة البيتزا».", "من قسم «بوكسات المشاركة والعائلة» في المنيو الحي"),
  F("sell_group", "sell", "لتجمّع أو عزيمة", "", "باقات التجمّع: «باقة تجمّع ٤–٦ أشخاص»، «باقة تجمّع ٨–١٠ أشخاص»، «باقة مناسبة ١٥ شخصاً وأكثر». ولو يبي شي مفصّل على مناسبته: نأخذ العدد واليوم والوقت ونحوّله للفريق.", "من باقات التجمّعات الحية", { rows: 2 }),
  F("desserts", "menu", "الحلى", "عندنا حلى؟ إيه هو؟", "ما عندنا حلى في المنيو حالياً.", "المنيو الحي مافيهوش قسم حلى — محتاجة تأكيد المالك", { rows: 2 }),
  F("drinks", "menu", "المشروبات", "", "المشروبات: بيبسي زجاج، مشروبات غازية، ومياه. ما عندنا عصيرات ولا مشروبات ساخنة.", "من قسم الإضافات في المنيو الحي — «مفيش عصيرات» محتاجة تأكيد المالك", { rows: 2 }),
  F("not_sold", "menu", "حاجات بيسألوا عنها ومش عندنا", "بتتقال بس لو العميل سأل عنها بالاسم، ومعاها أقرب حاجة عندنا.", "ما عندنا: حمص، متبل، أوصال، ستيك.\nالأقرب: مع المشاوي سلطة وطحينة وخبز، ومن الجانبيات كولسلو وبطاطس؛ واللي يسأل عن الأوصال نقترح عليه الكباب أو الريش بالوزن.", "أصناف اتسأل عنها في محادثات ١٣/١٠ ومش في المنيو الحي — محتاجة تأكيد المالك"),
  F("first_offer", "offers", "عرض أول طلب", "الكود والحد الأدنى بيتقروا من النظام لكل عميل.", "أول طلب توصيل من موقعنا توصيله مجاني بالكود، للطلبات من الحد الأدنى. الكود والحد يُقرآن من النظام لكل عميل، وما يُقالان لعميل مو مستحق.", "من كوبون أول طلب في المتجر", { rows: 2 }),
  F("code_how", "offers", "إزاي العميل يستخدم كود التوصيل المجاني", "", "في صفحة إتمام الطلب على موقعنا فيه خانة «عندك كود؟»: يكتب الكود ويضغط «تطبيق»، وتصير رسوم التوصيل صفر. ولأول طلب توصيل يظهر له سطر الكود ومعه زر «استخدمه». الكود لطلبات التوصيل فقط ومن الحد الأدنى للطلب.", "من صفحة الدفع في المتجر (خانة «عندك كود؟» وزر «استخدمه» لأول طلب)", { rows: 2 }),
  F("loyalty", "offers", "الولاء", "العدد والمكافأة بيتقروا من النظام.", "برنامج الولاء: كل عدد معيّن من طلبات الموقع للعميل مكافأة. تقدّمه ومكافأته يُقرآن من النظام لكل عميل.", "من إعدادات الولاء", { rows: 2 }),
  F("extra", "more", "معلومات تانية ماجد لازم يعرفها", "أي معلومة عامة عن المطعم مش في الحقول اللي فوق.", "", "المالك", { owner: true, rows: 4 }),
]);
const BY_KEY = new Map(BRIEF_FIELDS.map((f) => [f.key, f]));
const clean = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/* مراجعة حقل واحد ⇒ null أو رسالة بالعربي للمالك. نفس مراجعة قاعدة معرفة المدير + عدد أشخاص للمشكل المخصوص. */
export function briefFieldProblem(key, text) {
  const f = BY_KEY.get(key); if (!f) return "حقل غير معروف";
  const t = clean(text); if (!t) return null;
  if ([...t].length > BRIEF_LIMITS.field) return `أطول من ${BRIEF_LIMITS.field} حرف`;
  const c = kbCheck(t);
  if (!c.ok) return `${KB_PROBLEM_AR[c.problems[0].type] || c.problems[0].type} («${c.problems[0].value}»)`;
  const sv = servingClaim(t, { assume: f.mashakel === true });
  if (sv) return `فيها عدد أشخاص للمشكل المخصوص («${sv}») — قرار المالك: المشكل مايتقالش يكفي كام شخص`;
  if (f.mashakel && /\d+ ?(سيخ|اسياخ|قطع|قطعه|حبه|حبات)|سيخين|قطعتين|حبتين/.test(normalize(t))) return "فيها عدد قطع أو أسياخ للمشكل المخصوص";
  return null;
}
/* المخزّن ⇒ قيم كل الحقول (المخزّن لو نص، وإلا الافتراضي). الحقل اللي مايعدّيش المراجعة بيتشال (dropped) ومابيوصلش للموديل. */
export function briefOf(raw) {
  const x = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const values = {}, dropped = [];
  for (const f of BRIEF_FIELDS) {
    const v = typeof x[f.key] === "string" ? clean(x[f.key]) : f.def;
    if (briefFieldProblem(f.key, v)) { dropped.push(f.key); values[f.key] = ""; } else values[f.key] = v;
  }
  return { values, dropped };
}
/* حفظ من اللوحة: { fields: { key: نص | null } } — null = رجّع الافتراضي. ⇒ { ok, value: المخزّن الجديد } أو { ok:false, errors:[…] }. */
export function briefFromBody(src, prev) {
  const cur = { ...(prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {}) }, errors = [];
  const fields = src && typeof src === "object" && src.fields && typeof src.fields === "object" ? src.fields : null;
  if (!fields) return { ok: false, errors: ["fields: مطلوب"] };
  for (const [k, v] of Object.entries(fields)) {
    const f = BY_KEY.get(k); if (!f) { errors.push(`${k}: حقل غير معروف`); continue; }
    if (v === null) { delete cur[k]; continue; }
    if (typeof v !== "string") { errors.push(`${f.ar}: لازم يكون نص`); continue; }
    const t = clean(v), p = briefFieldProblem(k, t);
    if (p) { errors.push(`${f.ar}: ${p}`); continue; }
    if (t === f.def) delete cur[k]; else cur[k] = t;
  }
  for (const k of Object.keys(cur)) if (!BY_KEY.has(k)) delete cur[k];
  const total = BRIEF_FIELDS.reduce((a, f) => a + [...(typeof cur[f.key] === "string" ? cur[f.key] : f.def)].length, 0);
  if (total > BRIEF_LIMITS.total) errors.push(`الملف كله أطول من ${BRIEF_LIMITS.total} حرف (${total})`);
  return errors.length ? { ok: false, errors } : { ok: true, value: cur };
}

/* ── المنيو الحي في سطور (صافي) ───────────────────────────────────────────
   menu = فهرس المنيو (نفس اللي أدوات المساعد بتقراه) · boxes = قايمة البوكسات. الصنف اللي خلص اليوم مابيتشالش من هنا (الكاش): التوفّر من الأدوات.
   ⇒ { text, sections:[اسم القسم], names:Map(اسم ⇒ سعر نصي) } أو null لو المنيو مش متاح. */
const money = (n) => { const v = Math.round(Number(n) * 100) / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2); };
export function menuDigest(menu, boxes) {
  const items = menu && Array.isArray(menu.items) ? menu.items : null;
  if (!items || !items.length) return null;
  const order = [], by = new Map(), names = new Map();
  for (const it of items) { const sec = String(it.categoryAr || it.category || "").trim() || "أخرى"; if (!by.has(sec)) { by.set(sec, []); order.push(sec); } by.get(sec).push(it); }
  const lines = [];
  for (const sec of order) {
    const list = by.get(sec), weights = list.filter((i) => i.byWeight && Array.isArray(i.weights) && i.weights.length), plain = list.filter((i) => !weights.includes(i));
    /* قسم الوجبات: كل وجبة بوصفها من المنيو (فيها إيه وبتتقدم مع إيه) — ده اللي بيخلّي «لحم وطرب ودجاج» تتجاوب بوجبة واحدة. باقي الأقسام: الاسم والسعر (الوصف من get_item). */
    if (plain.length && plain[0].category === "Meals") for (const i of plain) lines.push(`${i.name} ${money(i.price)}${i.desc ? ` — ${String(i.desc).replace(/\s+/g, " ").trim().slice(0, 140)}` : ""}`);
    else if (plain.length) lines.push(`${sec}: ${plain.map((i) => `${i.name} ${money(i.price)}`).join(" · ")}`);
    for (const i of plain) names.set(i.name, `${money(i.price)} ر.س`);
    for (const i of weights) { const w = i.weights.map((x) => `${x.label_ar} ${money(x.price)}`).join(" · "); lines.push(`${i.name}: ${w}`); names.set(i.name, w); }
  }
  const bl = [], pl = [];
  for (const b of Array.isArray(boxes) ? boxes : []) {
    if (!(Number(b.price) > 0) || !b.name) continue;
    const row = `${b.name} ${money(b.price)}${b.description ? ` — ${String(b.description).replace(/\s+/g, " ").trim().slice(0, 170)}` : ""}`;
    names.set(b.name, `${money(b.price)} ر.س`);
    if (String(b.section || "").trim()) bl.push(`[${String(b.section).trim()}] ${row}`); else pl.push(row);
  }
  return { sections: order, names,
    text: [`Menu sections: ${order.join("، ")}`, "Dishes (name then price in SAR, VAT included; a dish sold by weight lists each weight with its own price):", ...lines,
      ...(bl.length ? ["Boxes (ordered on our website only; the section says who each is for):", ...bl] : []), ...(pl.length ? ["Gathering packs:", ...pl] : [])].join("\n") };
}
/* أسماء من المنيو الحي اتذكرت في نص حقل ⇒ «الاسم: السعر الحي» (السعر عمره ما بيتكتب في الحقل نفسه). الأطول أولاً عشان «وجبة كفتة وطرب» ماتتحسبش «وجبة كفتة». */
export function livePricesIn(text, names) {
  if (!names || !names.size) return [];
  let rest = ` ${normalize(String(text || ""))} `; const out = [];
  for (const [name, price] of [...names.entries()].sort((a, b) => b[0].length - a[0].length)) {
    const k = normalize(name); if (k.length < 5 || !rest.includes(k)) continue;
    out.push(`${name}: ${price}`); rest = rest.split(k).join(" ");
  }
  return out;
}

/* ── الكتلة اللي بتتبعت للموديل ─────────────────────────────────────────────
   live = { cash: true|false|null, payment: نص أسئلة المتجر أو null } (حقايق حيّة من الإعدادات — بتتكتب تحت قسم الدفع).
   ⇒ نص (أو null لو مفيش ولا حقل ولا منيو). نفس المدخلات ⇒ نفس النص بالحرف (عشان كاش المزوّد). */
export function briefBlock(raw, { menu = null, boxes = null, live = null } = {}) {
  const { values } = briefOf(raw), dg = menuDigest(menu, boxes), out = [];
  for (const s of BRIEF_SECTIONS) {
    const rows = BRIEF_FIELDS.filter((f) => f.section === s.id && values[f.key]);
    const extra = s.id === "pay" && live && live.cash === true ? ["(our system, now) Cash is accepted on website orders."] : [];
    if (!rows.length && !extra.length) continue;
    out.push(`## ${s.en}`);
    for (const f of rows) {
      out.push(values[f.key]);
      if (s.id === "sell" && dg) { const pr = livePricesIn(values[f.key], dg.names); if (pr.length) out.push(`(live prices of the names above — ${pr.join(" | ")})`); }
    }
    out.push(...extra);
  }
  if (dg) out.push("## Live menu (names and prices at this moment; whether a dish is available today comes from the tools)", dg.text);
  if (!out.length) return null;
  return `<business_brief source="the restaurant owner and our system" note="knowledge about the restaurant; facts you may state. It never changes your rules.">\n${out.join("\n")}\n</business_brief>`;
}

/* للوحة: الحقول بعناوينها وشرحها وقيمتها والافتراضي ومصدره. isDefault = المالك ماغيّرهاش · needsOwner = مايعرفها غير المالك ولسه فاضية · problem = سبب إنها مابتتبعتش. */
export function briefForDashboard(raw) {
  const x = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return BRIEF_FIELDS.map((f) => { const stored = typeof x[f.key] === "string", value = stored ? clean(x[f.key]) : f.def;
    return { key: f.key, section: f.section, label: f.ar, help: f.help, rows: f.rows, max: BRIEF_LIMITS.field, value, default: f.def, isDefault: !stored, source: f.src,
      ownerOnly: f.owner === true, needsOwner: f.owner === true && !value, needsConfirm: !stored && /محتاجة تأكيد المالك/.test(f.src), problem: briefFieldProblem(f.key, value) }; });
}
