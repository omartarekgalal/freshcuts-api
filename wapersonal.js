/* ═══════════════════════════════════════════════════════════════════════════
   «البيع الشخصي» لماجد — S1 (١٤/١٠/٢٠٢٦) — ملف صافي: مفيش موديل ولا قاعدة ولا إرسال
   التصميم: docs/designs-2026-10/whatsapp/personal-upsell-design-2026-10-14.txt (S1)

   عمر: «… upselling و cross selling بشكل ذكي». البيانات (٩٠ يوم، ٤٦٨ عميل متكرر): ٢٤٫٦٪ عندهم إضافة بيكرروها،
   و٦١٫٦٪ من اللي بيطلبوا مشروب بيطلبوا نفس المشروب. يبقى أقوى اقتراح = «زي العادة» من طلباته هو.

   ١) personalOf(profile360, { menu, now, cfg, staff }) ⇒ سجل صغير (< 1KB) للرقم ده، مرة في المحادثة، من نفس ملف العميل
      اللي أول دور بيقراه أصلاً (customer360.buildProfile: نقطة البيع + الموقع + التطبيقات، من غير تكرار):
        - usual: لكل نوع أكل (كريب، برجر، باستا، بيتزا، وجبة، مشاوي بالوزن، حواوشي، طاسة) الإضافة اللي في ≥٦٠٪ من طلباته من النوع ده و≥ مرتين، بكميته المعتادة
        - sd: الأنواع اللي عادته معاها جانبي ومشروب مع بعض (⇒ البوكس قبل الإضافة)
        - drink: مشروبه المعتاد عموماً · neverSide / neverDrink: ٣ طلبات وأكتر ومافيش ولا مرة · avoid: أصناف طلبات قيّمها ٢ أو أقل
      السطور اللي سعرها صفر (رز اليوم الوطني ببلاش) واللي جوّه البوكسات مابتتحسبش «إضافة». رقم من الفريق ⇒ null.
      السجل للكود بس — **مابيتبعتش للموديل أبداً**.
   ٢) habitPick(cart, rec, ctx) ⇒ عادة العميل للسلة دي (أو null)، وsdFirst لو عادته جانبي ومشروب (البوكس الأول).
   ٣) peopleOf(texts) ⇒ عدد الأشخاص اللي العميل قاله (صف «كم شخص» أو كتابة؛ «٣–٤» = ٣) أو null.
   ٤) declineMemory(rows, now, cfg) ⇒ اللي رفضه في محادثات قبل كده: صنف رفضه ⇒ مايتعرضش ١٤ يوم؛ نوع اقتراح اترفض في
      محادثتين خلال ٦٠ يوم ⇒ يسكت ٦٠ يوم؛ اقتراح اتجاهل في محادثتين = رفض واحد.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize } from "./wabot.js";
import { makeResolver } from "./recs.js";
import { sgPeople } from "./waassist.js";

const DAY = 86400_000;
export const PERSONAL_DEFAULTS = Object.freeze({ habitMinShare: 60, habitMinOrders: 2, habitDays: 180, declineCoolDays: 14, declineMuteAfter: 2, declineMuteDays: 60 });
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const cfgOf = (cfg = {}) => Object.fromEntries(Object.entries(PERSONAL_DEFAULTS).map(([k, d]) => [k, num(cfg && cfg[k], d)]));

/* ── تصنيف أصناف المنيو الحي (من الأقسام بأسمائها الإنجليزية الثابتة) ───────── */
export const DRINK_RE = /بيبسي|سفن|ميرندا|كولا|مياه|ماء|عصير|مشروب|شاي|قهوه|لبن|pepsi|7up|seven|mirinda|cola|water|juice|drink|tea/i;
/* «إضافة …» (إضافة كومبو، رقم 118، متحطوطة في قسم الكريبات): ترقية للصنف = جانبي ومشروب، مش طبق رئيسي.
   قبل S1 كانت بتتحسب كريب: كريب + كومبو = «كريبين» (بوكس الكريب لشخصين)، ومشروب فوق علبة الكومبو. */
const UPGRADE_RE = /^(?:اضافه|اضافة)(?:\s|$)/;
export function isUpgrade(it) { return Boolean(it) && UPGRADE_RE.test(normalize(String(it.name || ""))); }
export function itemKind(it) {
  if (!it) return "main";
  if (isUpgrade(it)) return "side";
  return /Sides|Drinks|إضافات/i.test(`${it.category} ${it.categoryAr}`) ? (DRINK_RE.test(normalize(`${it.name} ${it.nameEn || ""}`)) ? "drink" : "side") : "main";
}
/* الصنف بيغطي إيه: جانبي / مشروب / الاتنين (الكومبو: من وصفه في المنيو الحي «بطاطس محمرة + علبة بيبسي») */
export function coversOf(it) {
  if (!it) return [];
  if (isUpgrade(it)) return DRINK_RE.test(normalize(`${it.desc || ""} ${it.name}`)) ? ["side", "drink"] : ["side"];
  const k = itemKind(it); return k === "main" ? [] : [k];
}
const TYPE_BY_CAT = { Crepes: "crepe", Burgers: "burger", Pasta: "pasta", Pizza: "pizza", Meals: "meal", Hawawshi: "hawawshi", Skillets: "skillet" };
export const DISH_TYPES = Object.freeze(["crepe", "burger", "pasta", "pizza", "meal", "weight", "hawawshi", "skillet"]);
/* نوع الطبق الرئيسي: weight = المشاوي بالوزن (ومنها مشكل مخصوص). null = مش طبق رئيسي (أو قسم مش معروف). */
export function dishType(it) {
  if (!it || itemKind(it) !== "main") return null;
  if (it.byWeight) return "weight";
  return TYPE_BY_CAT[it.category] || null;
}

/* ── أسماء نقطة البيع ⇒ أصناف المنيو الحي ─────────────────────────────────────
   recs.makeResolver (مطابقة تامة ⇒ الاسم قبل « - » ⇒ أطول اسم بيبدأ بيه ⇒ احتواء) + الأسماء الإنجليزية + هجاء نقطة البيع
   اللي ظهر في تحليل ٩٠ يوم (كل سطر اتحل). الهجاء بيشاور على **اسم** في المنيو (مش رقم): لو الصنف اتشال، الهجاء بيقع لوحده. */
export const NAME_ALIASES = Object.freeze([["كلوسلو", "كولسلو"], ["تشيكن بينا الفريدو", "تشيكن بنا الفريدو"], ["حواوشي موتزريلا", "حواوشي موتزاريلا"], ["فرايد موتزريلا", "فرايد موتزاريلا"],
  ["ارز", "طبق أرز بسمتي"], ["ارز ساده", "طبق أرز بسمتي"], ["رز", "طبق أرز بسمتي"], ["pepsi - can", "مشروبات غازية"], ["pepsi can", "مشروبات غازية"]]);
export function resolverFor(items) {
  const list = Array.isArray(items) ? items : [];
  const byName = new Map(list.map((i) => [normalize(String(i.name || "")), String(i.id)]));
  const aliases = [...list.filter((i) => i.nameEn).map((i) => [i.nameEn, String(i.id)]),
    ...NAME_ALIASES.map(([a, to]) => [a, byName.get(normalize(to))]).filter(([, id]) => id)];
  return makeResolver(list.map((i) => ({ id: String(i.id), name: i.name })), aliases);
}

/* ── ١) السجل الشخصي ──────────────────────────────────────────────────────── */
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 1; };
export function personalOf(profile, { menu = null, now = new Date(), cfg = {}, staff = null } = {}) {
  if (!profile || typeof profile !== "object") return null;
  if (staff === true || (profile.identity && profile.identity.isStaff === true)) return null;      // أرقام الفريق: مفيش سجل
  const items = menu && Array.isArray(menu.items) ? menu.items : null;
  if (!items || !items.length) return null;      // من غير المنيو الحي مانعرفش نربط ⇒ مفيش اقتراح شخصي (مايتخمّنش)
  const c = cfgOf(cfg), resolve = resolverFor(items), byId = new Map(items.map((i) => [String(i.id), i]));
  const t0 = now.getTime(), since = t0 - c.habitDays * DAY;
  const orders = (Array.isArray(profile.orders) ? profile.orders : []).filter((o) => o && !o.void && !o.isTest && !o.dupOf && Number.isFinite(Date.parse(o.at)) && Date.parse(o.at) >= since && Date.parse(o.at) <= t0 + DAY);
  const types = {}, drinkOrders = { n: 0, x: new Map() };
  let anySide = false, anyDrink = false;
  for (const o of orders) {
    const kinds = new Set(), boxKinds = new Set(), adds = new Map(), has = { side: false, drink: false }, boxHas = { side: false, drink: false };
    for (const l of Array.isArray(o.items) ? o.items : []) {
      const id = resolve(l && l.name), it = id ? byId.get(String(id)) : null;
      if (!it) continue;
      const q = Math.min(20, Math.max(1, Math.round(Number(l.qty) || 1)));
      const t = dishType(it);
      if (t) { kinds.add(t); if (l.box === true) boxKinds.add(t); continue; }
      if (itemKind(it) === "main") continue;      // طبق من قسم مش معروف
      const cov = coversOf(it);
      if (l.box === true) { for (const k of cov) boxHas[k] = true; continue; }      // جوّه بوكس: مش «إضافة»
      if (l.amount !== null && l.amount !== undefined && !(Number(l.amount) > 0)) continue;      // سعره صفر (رز اليوم الوطني ببلاش…): مش اختيار
      adds.set(String(it.id), (adds.get(String(it.id)) || 0) + q);
      for (const k of cov) has[k] = true;
    }
    if (has.side || boxHas.side) anySide = true;
    if (has.drink || boxHas.drink) anyDrink = true;
    for (const t of kinds) {
      const T = (types[t] ||= { n: 0, sd: 0, x: new Map() });
      T.n += 1;
      if ((has.side && has.drink) || (boxKinds.has(t) && boxHas.side && boxHas.drink)) T.sd += 1;
      for (const [id, q] of adds) { const e = T.x.get(id) || { c: 0, qs: [] }; e.c += 1; e.qs.push(q); T.x.set(id, e); }
    }
    const drinks = [...adds.keys()].filter((id) => coversOf(byId.get(id)).includes("drink") && !isUpgrade(byId.get(id)));
    if (drinks.length) { drinkOrders.n += 1; for (const id of drinks) { const e = drinkOrders.x.get(id) || { c: 0, qs: [] }; e.c += 1; e.qs.push(adds.get(id)); drinkOrders.x.set(id, e); } }
  }
  const habit = (n, e) => e.c >= c.habitMinOrders && n > 0 && (e.c / n) * 100 >= c.habitMinShare;
  const usual = {}, sd = [];
  for (const [t, T] of Object.entries(types)) {
    const list = [...T.x.entries()].filter(([, e]) => habit(T.n, e)).sort((a, b) => b[1].c / T.n - a[1].c / T.n || b[1].c - a[1].c)
      .slice(0, 2).map(([id, e]) => ({ id, qty: median(e.qs), pct: Math.round((e.c / T.n) * 100) }));
    if (list.length) usual[t] = list;
    if (habit(T.n, { c: T.sd })) sd.push(t);
  }
  const dk = [...drinkOrders.x.entries()].filter(([, e]) => habit(drinkOrders.n, e)).sort((a, b) => b[1].c - a[1].c)[0];
  /* أصناف طلب قيّمه ٢ أو أقل (التقييم مربوط برقم طلب الموقع) ⇒ مانقترحهاش عليه */
  const avoid = new Set();
  for (const r of Array.isArray(profile.reviews) ? profile.reviews : []) {
    if (!(Number(r && r.rating) > 0 && Number(r.rating) <= 2) || r.hidden || !r.orderNo) continue;
    const o = (profile.orders || []).find((x) => x && x.orderNo && String(x.orderNo) === String(r.orderNo));
    for (const l of (o && o.items) || []) { const id = resolve(l && l.name); if (id) avoid.add(String(id)); }
  }
  const rec = { v: 1, orders: orders.length, usual, sd, drink: dk ? { id: dk[0], qty: median(dk[1].qs) } : null,
    neverSide: orders.length >= 3 && !anySide, neverDrink: orders.length >= 3 && !anyDrink, avoid: [...avoid].slice(0, 12) };
  if (JSON.stringify(rec).length > 1024) { for (const t of Object.keys(rec.usual)) rec.usual[t] = rec.usual[t].slice(0, 1); rec.avoid = rec.avoid.slice(0, 6); }
  return rec;
}

/* ── ٢) عادة العميل للسلة دي ─────────────────────────────────────────────────
   ctx = { items (المنيو الحي)، ok(it) ⇒ الصنف ينفع يتقترح (متاح، في نطاق السعر، مش في السلة، مش مرفوض قبل كده…)،
           cover = { mains, side, drink, types:[نوع لكل طبق في السلة بالترتيب] }, people }
   ⇒ { pick: { item, kind, qty, type } | null, sdFirst: نوع عادته جانبي ومشروب مع بعض | null } */
export function habitPick(cart, rec, { items = [], ok = () => true, cover = null, people = null } = {}) {
  const out = { pick: null, sdFirst: null };
  if (!rec || !cart || !cover || !Array.isArray(cover.types) || !cover.types.length) return out;
  const byId = new Map((items || []).map((i) => [String(i.id), i]));
  const cap = Math.max(Number(people) > 0 ? Math.round(Number(people)) : 0, Number(cover.mains) || 0, 1);
  for (const t of [...new Set(cover.types)]) {
    if ((rec.sd || []).includes(t)) { out.sdFirst = out.sdFirst || t; continue; }      // عادته جانبي ومشروب ⇒ البوكس قبل الإضافة
    for (const u of (rec.usual && rec.usual[t]) || []) {
      const it = byId.get(String(u.id)); if (!it || !ok(it)) continue;
      const kind = itemKind(it), covered = kind === "drink" ? Number(cover.drink) || 0 : Number(cover.side) || 0;
      const qty = Math.min(Math.max(1, Number(u.qty) || 1), cap) - covered;
      if (qty <= 0) continue;
      out.pick = { item: it, kind: kind === "drink" ? "drink" : "side", qty, type: t };
      return out;
    }
  }
  return out;
}

/* ── ٣) عدد الأشخاص ───────────────────────────────────────────────────────────
   من قايمة «كم شخص» (عنوان الصف بيرجع نص) أو كلام فيه كلمة أشخاص («لشخصين»، «٣ أشخاص»، «احنا ٤»). النطاق = أقل رقم فيه.
   رقم من غير كلمة أشخاص («ثلاث كريب») مش عدد أشخاص. من الأحدث للأقدم: أول عدد يتلاقى. */
const PEOPLE_ROWS = new Map([["شخص واحد", 1], ["شخصين", 2], ["ثلاثه او اربعه", 3], ["خمسه او سته", 5], ["سبعه واكثر", 7], ["just me", 1], ["two", 2], ["three or four", 3], ["five or six", 5], ["seven or more", 7]]);
const PEOPLE_WORD_RE = /(?:^| )(?:ل|لل)?(?:شخص|شخصين|اشخاص|نفر|نفرين|انفار|فرد|فردين|افراد|people|persons?|pax)(?= |$)/;
const WE_RE = /(?:^| )(?:احنا|حنا|نحن|we are|we're)(?: تقريبا)? (\d{1,2}|واحد|اثنين|ثنين|ثلاثه|ثلاث|اربعه|اربع|خمسه|خمس|سته|ست|سبعه|سبع|ثمانيه|عشره)(?= |$)/;
const WORDS = { واحد: 1, اثنين: 2, ثنين: 2, ثلاثه: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, ثمانيه: 8, عشره: 10 };
export function peopleOf(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((x) => String(x || ""));
  for (let i = list.length - 1; i >= 0; i--) {
    const t = normalize(list[i].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))).replace(/[^\p{L}\p{N}\s–—-]/gu, " ").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (PEOPLE_ROWS.has(t)) return PEOPLE_ROWS.get(t);
    if (/(?:^| )(?:كم|كام|يكفي|تكفي|يكفو|يكفوا|يشبع|how many|enough)(?= |$)/.test(t)) continue;      // «يكفي كم شخص؟» سؤال، مش عدد
    const w = WE_RE.exec(t); if (w) { const n = /^\d+$/.test(w[1]) ? Number(w[1]) : WORDS[w[1]]; if (n >= 1 && n <= 50) return n; }
    if (PEOPLE_WORD_RE.test(t)) { const p = sgPeople(t); if (p && p[0] >= 1 && p[0] <= 50) return p[0]; if (/(?:^| )(?:ل|لل)?(?:شخصين|نفرين|فردين)(?= |$)/.test(t)) return 2; }
  }
  return null;
}

/* ── ٤) ذاكرة الرفض بين المحادثات ─────────────────────────────────────────────
   rows = wa_assist_suggestions للرقم ده (assistStore.declinesOf): { kind, rule, ref, outcome, at, session_id }.
   ⇒ { items: [ref…] مايتعرضوش (declineCoolDays)، rules: [نوع…] ساكت (declineMuteDays) }. الصغير ده بيتخزّن في حالة المحادثة. */
export function declineMemory(rows, now = new Date(), cfg = {}) {
  const c = cfgOf(cfg), t0 = now.getTime(), items = new Set(), byRule = new Map();
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.ref != null && Number.isFinite(Date.parse(r.at))).map((r) => ({ ...r, ref: String(r.ref), t: Date.parse(r.at), type: String(r.rule || r.kind || "") }));
  /* اتجاهل (اتعرض ومارجعلوش) في محادثتين = رفض واحد (وقت التاني) */
  const ignored = new Map();
  for (const r of list.filter((x) => x.outcome === "offered")) { const e = ignored.get(r.ref) || { sessions: new Set(), t: 0, type: r.type }; e.sessions.add(String(r.session_id || r.t)); e.t = Math.max(e.t, r.t); ignored.set(r.ref, e); }
  const declines = list.filter((x) => x.outcome === "declined").map((x) => ({ ref: x.ref, t: x.t, type: x.type, session: String(x.session_id || x.t) }));
  for (const [ref, e] of ignored) if (e.sessions.size >= 2) declines.push({ ref, t: e.t, type: e.type, session: `ignored:${ref}` });
  const lastAccept = new Map(); for (const r of list.filter((x) => x.outcome === "accepted")) lastAccept.set(r.ref, Math.max(lastAccept.get(r.ref) || 0, r.t));
  for (const d of declines) {
    if ((lastAccept.get(d.ref) || 0) > d.t) continue;      // قبله بعد ما رفضه ⇒ مش «مرفوض»
    if (c.declineCoolDays > 0 && t0 - d.t <= c.declineCoolDays * DAY) items.add(d.ref);
    if (d.type) { const e = byRule.get(d.type) || []; e.push(d); byRule.set(d.type, e); }
  }
  /* نوع اترفض في declineMuteAfter محادثة خلال أي ٦٠ يوم ⇒ ساكت declineMuteDays من الرفض اللي كمّل العدد */
  const rules = [];
  for (const [type, ds] of byRule) {
    const sorted = ds.sort((a, b) => a.t - b.t);
    const muted = sorted.some((d) => { const inWin = new Set(sorted.filter((x) => x.t <= d.t && d.t - x.t <= 60 * DAY).map((x) => x.session)); return inWin.size >= Math.max(1, c.declineMuteAfter) && t0 - d.t <= c.declineMuteDays * DAY; });
    if (muted) rules.push(type);
  }
  return { items: [...items].slice(0, 40), rules };
}
