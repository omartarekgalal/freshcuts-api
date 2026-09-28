/* الرد الآلي على واتساب — الاختبارات (٢٨/٩).
   اللقطة في fixtures/wabot-context.json = المنيو والإعدادات والسياسة الحية يوم
   ٢٨/٩. البوت نفسه يقرا الحي؛ اللقطة للاختبار بس. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  INTENTS, matchIntent, buildReply, indexMenu, normalize, detectLang, extractDistrict, findItems, hoursLines, fmtTime,
  openState, createState, handleInbound, LIMITS, ACTIVE_STATUSES,
} from "./wabot.js";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/wabot-context.json", import.meta.url), "utf8"));
const MENU = indexMenu(FX.pages);
/* لحظة بتوقيت الرياض */
const at = (iso) => new Date(Date.parse(iso + "+03:00"));
const OPEN = at("2026-09-28T20:00:00");     // الإثنين ٨ مساءً
const CLOSED = at("2026-09-28T05:00:00");   // الإثنين ٥ الفجر
const baseCtx = (over = {}) => ({
  settings: FX.settings, menu: MENU, policy: FX.policy, coupons: FX.coupons, offers: FX.offers,
  order: null, orderHistory: { paid: 0 }, now: OPEN, ...over,
});
const ACTIVE_ORDER = { order_no: "W1790012345678", status: "accepted", option: "delivery", total: 86.5,
  created_at: new Date(OPEN.getTime() - 20 * 60000).toISOString(), active: true, label: "المطعم بيجهّز طلبك 👨‍🍳" };

/* ── ١) كل أمثلة جدول النوايا ─────────────────────────────────────────── */
const SPECIAL = new Set(["ad_welcome", "media", "unknown", "cancel_or_stop"]);
test("جدول النوايا: ≥٨ أمثلة لكل نية وكل مثال يطلع نيته", () => {
  let n = 0;
  for (const it of INTENTS) {
    assert.ok(it.examples.length >= 8, `${it.name}: ${it.examples.length}`);
    assert.ok(it.label && it.reply && Array.isArray(it.sources), it.name);
    if (SPECIAL.has(it.name)) continue;
    for (const ex of it.examples) { n++; assert.equal(matchIntent(ex, { menu: MENU }).intent, it.name, `«${ex}»`); }
  }
  assert.ok(n >= 350, `${n}`);
});

/* ── ٢) عبارات صعبة ومخلوطة ───────────────────────────────────────────── */
export const TRICKY = [
  ["السلام عليكم وين طلبي", "order_status"], ["مرحبا ابي المنيو", "menu"], ["هلا، كم سعر وجبة ميكس جريل؟", "item_price"],
  ["السلام عليكم ابي الغي الطلب", "cancel_order"], ["شكرا بس الاكل وصل بارد", "complaint"], ["الاكل لذيذ بس وصل بارد", "complaint"],
  ["طلبي تأخر ساعة ووصل بارد", "complaint"], ["وين طلبي صار له ساعة", "complaint"], ["متى يوصل طلبي؟", "order_status"],
  ["متى يوصل الطلب عادة؟ كم ياخذ", "delivery_time"], ["كم التوصيل لحي الروضة", "delivery_fee"], ["توصلون حي الروضة وكم الرسوم", "delivery_fee"],
  ["توصلون الشاطئ؟", "delivery_area"], ["الكود FIRST ما اشتغل معي", "coupon_help"], ["عندكم كود خصم؟", "offers"], ["كوبون", "offers"],
  ["الغي الاشتراك", "stop"], ["لا ترسلون لي عروض", "stop"], ["STOP", "stop"], ["Stop!", "stop"], ["إيقاف.", "stop"], ["ايقاف العروض", "stop"],
  ["اشتراك", "start"], ["ابي اكلم موظف بخصوص طلبي", "human"], ["ابي المدير الاكل فيه شعرة", "complaint"], ["فيه مواقف ولا لا", "parking"],
  ["تقبلون كاش عند الاستلام؟", "payment"], ["دفعت بأبل باي وما وصلني تاكيد", "payment_issue"], ["انخصم مني مرتين", "payment_issue"],
  ["ابغى اعدل العنوان", "modify_order"], ["غلطت في العنوان", "modify_order"], ["ابي استرجاع لان الطلب ناقص", "refund"],
  ["نص فرخة بكم", "item_price"], ["بكم نص دجاجه على الفحم", "item_price"], ["دجاجة كاملة كم", "item_info"], ["ابغى كيلو كفتة", "item_info"],
  ["كم سعر كيلو الريش", "item_price"], ["المشكل المخصوص وش فيه", "item_info"], ["بيتزا بيبروني حجم وسط بكم", "item_price"],
  ["عندكم شاورما؟", "item_price"], ["ستيك؟", "item_price"], ["عندكم ستيك لحم", "item_price"], ["كريب", "menu"], ["باستا", "menu"],
  ["برقر", "menu"], ["عندكم برجر دجاج؟", "item_info"], ["how much is delivery", "delivery_fee"], ["do you deliver to obhur", "delivery_area"],
  ["where r u", "location"], ["whats ur location", "location"], ["r u open", "open_now"], ["wen talabi ya jama3a", "order_status"],
  ["3ayez el menu", "menu"], ["bkam el pizza", "item_price"], ["fe offers?", "offers"], ["ana 3ayez atlob", "how_to_order"],
  ["mawa3eed el fat7", "hours"], ["menu pls", "menu"], ["i want to cancel", "cancel_order"], ["my food is cold", "complaint"],
  ["where is my order?? its been an hour", "complaint"], ["can i pay cash", "payment"], ["is the chicken halal", "dietary"],
  ["no onions please", "special_request"], ["متى تفتحون بكرة", "hours"], ["فاتحين ولا مسكرين", "open_now"], ["ليش مسكرين", "open_now"],
  ["الحين مفتوح المطعم؟ ابي اطلب", "open_now"], ["كم الحد الادنى للتوصيل المجاني", "min_order"], ["التوصيل مجاني لو طلبت ب 150؟", "delivery_fee"],
  ["اذا طلبت ١٠٠ ريال كم التوصيل", "delivery_fee"], ["طلب لـ ٣٠ شخص يوم الخميس", "catering"], ["عزيمة ١٠ اشخاص وش تنصحون", "recommend"],
  ["ابي شي يكفي ٤ اشخاص", "servings"], ["وش احسن شي للعيال", "kids_menu"], ["هل عندكم قسم عائلات وجلسات", "dine_in"],
  ["ابي احجز طاولة لـ٦ اشخاص", "reservation"], ["ابي وظيفة كاشير", "jobs"], ["نبي نعلن عندكم", "partnership"],
  ["انا مشهور سناب ابي تعاون", "partnership"], ["الاسعار في كيتا غير الموقع ليش", "delivery_apps"], ["اطلب من هنقرستيشن ولا منكم", "delivery_apps"],
  ["ابي فاتورة ضريبية للشركة", "invoice"], ["الاكل روعة الله يعطيكم العافية", "feedback"], ["مشكورين ما قصرتوا", "thanks"], ["باي", "bye"],
  ["ذكروني اذا فتحتوا", "waitlist_join"], ["الموقع ما يفتح عندي", "site_issue"], ["ما قدرت اطلب يطلع خطأ", "site_issue"],
  ["طلبي W1790012345678 وينه", "order_status"], ["w1790012345678", "order_status"], ["ابي اطلب لبكرة الظهر", "preorder"],
  ["عندكم اكل نباتي او خضار", "dietary"], ["فيه جلوتين في البيتزا", "dietary"], ["هل الكريب حار", "dietary"], ["السعرات في وجبة الصدور", "dietary"],
  ["تسممت من اكلكم", "complaint"], ["ابي رقم المطعم", "human"], ["ابي اتصل عليكم", "human"], ["ممكن ترسلون لوكيشن المطعم", "location"],
  ["فين مكانكم بالظبط", "location"], ["ينفع استلم الطلب بنفسي", "how_to_order"], ["عندكم سفري ولا توصيل بس", "how_to_order"],
  ["وش طرق الدفع وفيه تابي", "payment"], ["في دوام رمضان تفتحون متى", "special_hours"], ["عيدكم مبارك", "greeting"], ["رمضان كريم", "greeting"],
  ["هلا والله", "greeting"], ["👍", "unknown"], ["؟", "unknown"], ["ok", "unknown"],
  ["مرحباااا", "greeting"], ["السلااام عليكم", "greeting"], ["المنيووو", "menu"], ["بكمممم الكفته", "item_price"],
];
test(`عبارات صعبة ومخلوطة (${TRICKY.length})`, () => {
  for (const [t, want] of TRICKY) assert.equal(matchIntent(t, { menu: MENU }).intent, want, `«${t}»`);
});

test("إجمالي عبارات الاختبار ≥ ١٥٠", () => {
  const n = INTENTS.reduce((a, i) => a + i.examples.length, 0) + TRICKY.length;
  assert.ok(n >= 150, `${n}`);
});

/* ── ٣) سياق: أزرار، أنواع، متابعة ────────────────────────────────────── */
test("«إلغاء» لوحدها: فيه طلب نشط ⇒ نسأل، مافيه ⇒ إيقاف", () => {
  for (const t of ["الغاء", "إلغاء", "cancel", "الغاااء"]) {
    assert.equal(matchIntent(t, { menu: MENU, order: ACTIVE_ORDER }).intent, "cancel_or_stop", t);
    assert.equal(matchIntent(t, { menu: MENU }).intent, "stop", t);
  }
  const r = buildReply(matchIntent("الغاء", { order: ACTIVE_ORDER }), baseCtx({ order: ACTIVE_ORDER }));
  assert.deepEqual(r.messages[0].interactive.action.buttons.map((b) => b.reply.id), ["cancel_order", "stop"]);
});

test("معرّف الزر/القائمة يحسم النية", () => {
  const cases = [["menu", "menu"], ["cat:21", "menu"], ["item:13", "item_info"], ["status", "order_status"], ["human", "human"],
    ["waitlist", "waitlist_join"], ["stop", "stop"], ["rec:budget", "recommend"], ["fee", "delivery_fee"], ["addr:ok", "thanks"], ["addr:edit", "modify_order"]];
  for (const [id, want] of cases) assert.equal(matchIntent("أي شي", { replyId: id }).intent, want, id);
});

test("الموقع المرسَل ⇒ نطاق التوصيل بالتسعير الحي", () => {
  const m = matchIntent("", { type: "location", location: { lat: 21.5, lng: 39.2 } });
  assert.equal(m.intent, "delivery_area");
  const ok = buildReply(m, baseCtx({ quote: { deliverable: true, fee: 20, routeKm: 6.2 } }));
  assert.match(ok.messages[0].interactive.body.text, /داخل نطاق التوصيل/);
  const no = buildReply(m, baseCtx({ quote: { deliverable: false } }));
  assert.match(no.messages[0].interactive.body.text, /برّه نطاق التوصيل/);
});

test("وسائط ⇒ رد + تحويل؛ إعلان ⇒ ترحيب بالعرض", () => {
  const m = matchIntent("", { type: "image" });
  assert.equal(m.intent, "media");
  assert.equal(buildReply(m, baseCtx()).actions[0].type, "handoff");
  const ad = matchIntent("مرحبا", { referral: { source_type: "ad", headline: "كيلو" } });
  assert.equal(ad.intent, "ad_welcome");
  const r = buildReply(ad, baseCtx({ referral: { source_type: "ad" } }));
  assert.match(r.messages[0].interactive.body.text, /باقة تجمّع/);
  assert.match(r.messages[0].interactive.body.text, /FIRST/);
  assert.equal(r.actions[0].type, "ad_lead");
  // عميل إعلان يسأل عن طلبه ⇒ مو ترحيب
  assert.equal(matchIntent("وين طلبي", { referral: { source_type: "ad" } }).intent, "order_status");
});

test("«ايوه» بعد «تبي نذكّرك؟» ⇒ ذكّرني، «لا» ⇒ شكر", () => {
  assert.equal(matchIntent("ايوه", { lastPrompt: "waitlist_join" }).intent, "waitlist_join");
  assert.equal(matchIntent("لا شكرا", { lastPrompt: "waitlist_join" }).intent, "thanks");
  assert.equal(matchIntent("ايوه", {}).intent, "unknown");
});

test("اللغة: عربي/فرانكو ⇒ عربي، إنجليزي ⇒ إنجليزي", () => {
  assert.equal(detectLang("وين طلبي"), "ar");
  assert.equal(detectLang("wen talabi"), "ar");
  assert.equal(detectLang("3ayez el menu"), "ar");
  assert.equal(detectLang("where is my order"), "en");
  const r = buildReply(matchIntent("what are your opening hours", { menu: MENU }), baseCtx());
  assert.match(r.messages[0].text.body, /Our hours/);
});

test("التطبيع: تشكيل، همزات، أرقام هندية، تكرار حروف", () => {
  assert.equal(normalize("إِلْغَاءُ   الطَّلَبِ!!"), "الغاء الطلب");
  assert.equal(normalize("١٥٠ ريال"), "150 ريال");
  assert.equal(normalize("هلااااا"), "هلا");
});

test("الأحياء: من «حي X» ومن «توصلون X»", () => {
  assert.equal(extractDistrict("توصلون حي الصفا؟").name, "الصفا");
  assert.equal(extractDistrict("هل توصلون لحي النزهة").name, "النزهة");
  assert.equal(extractDistrict("توصلون الروضة").name, "الروضة");
  assert.equal(extractDistrict("توصلون ابحر؟").known, true);
  assert.equal(extractDistrict("وين طلبي"), null);
});

test("مطابقة الأصناف: الكلمة المميزة تحسم، والفئة لوحدها ما تصير صنف", () => {
  assert.deepEqual(findItems(MENU, "نص دجاجة").items.map((i) => i.id), ["13"]);
  assert.deepEqual(findItems(MENU, "ريش").items.map((i) => i.id), ["100"]);
  assert.equal(findItems(MENU, "بيتزا").items.length, 0);
  assert.ok(findItems(MENU, "كفتة").items.length >= 3);
});

/* ── ٤) الردود: حدود ميتا، لغة، حقائق ─────────────────────────────────── */
const len = (s) => [...String(s || "")].length;
function checkPayload(p, where) {
  assert.ok(["text", "interactive"].includes(p.type), where);
  if (p.type === "text") { assert.ok(len(p.text.body) > 0 && len(p.text.body) <= LIMITS.text, where); return; }
  const i = p.interactive;
  assert.ok(len(i.body.text) > 0 && len(i.body.text) <= LIMITS.ibody, `${where} body ${len(i.body.text)}`);
  if (i.header?.type === "text") assert.ok(len(i.header.text) <= LIMITS.header, where);
  if (i.footer) assert.ok(len(i.footer.text) <= LIMITS.footer, where);
  if (i.type === "button") {
    const b = i.action.buttons;
    assert.ok(b.length >= 1 && b.length <= 3, where);
    for (const x of b) assert.ok(len(x.reply.title) <= LIMITS.btnTitle && x.reply.id, `${where} «${x.reply.title}»`);
    assert.equal(new Set(b.map((x) => x.reply.id)).size, b.length, `${where} ids`);
  } else if (i.type === "list") {
    assert.ok(len(i.action.button) <= LIMITS.listButton, where);
    const rows = i.action.sections.flatMap((s) => s.rows);
    assert.ok(rows.length >= 1 && rows.length <= LIMITS.rows, `${where} rows ${rows.length}`);
    for (const r of rows) {
      assert.ok(len(r.title) <= LIMITS.rowTitle, `${where} «${r.title}»`);
      if (r.description) assert.ok(len(r.description) <= LIMITS.rowDesc, `${where} desc`);
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, `${where} row ids`);
  } else if (i.type === "cta_url") {
    assert.ok(len(i.action.parameters.display_text) <= LIMITS.ctaText, where);
    assert.match(i.action.parameters.url, /^https:\/\//, where);
  } else assert.fail(`${where}: نوع ${i.type}`);
}
const textsOf = (r) => r.messages.map((p) => p.type === "text" ? p.text.body
  : [p.interactive.body.text, p.interactive.footer?.text, ...(p.interactive.action.buttons || []).map((b) => b.reply.title),
    ...((p.interactive.action.sections || []).flatMap((s) => s.rows.flatMap((x) => [x.title, x.description])))].join(" ")).join("\n");
const EGYPTIAN = /دلوقتي|عايز|عاوز|ازاي|إزاي|كده|بتاع|امبارح|النهاردة|خالص|أوي|(^|\s)مش(\s|$)|(^|\s)ده(\s|$)/;

test("كل نية × (مفتوح/مقفول) × (عربي/إنجليزي) ⇒ رد صالح بحدود ميتا وسعودي", () => {
  for (const it of INTENTS) {
    for (const now of [OPEN, CLOSED]) for (const order of [null, ACTIVE_ORDER]) {
      const ex = it.examples.find((e) => !e.startsWith("[")) || "";
      const m = matchIntent(ex, { menu: MENU, order });
      const forced = { ...m, intent: it.name };
      for (const lang of ["ar", "en"]) {
        const r = buildReply(forced, baseCtx({ now, order, lang, text: ex, entities: it.name === "item_info" ? { itemId: "103" } : {} }));
        const where = `${it.name}/${lang}/${now === OPEN ? "open" : "closed"}/${order ? "order" : "-"}`;
        assert.ok(r.messages.length >= 1, where);
        for (const p of r.messages) checkPayload(p, where);
        const txt = textsOf(r);
        if (lang === "ar") assert.ok(!EGYPTIAN.test(txt.replace(/أكتر/g, "")), `${where}: ${txt}`);
        assert.ok(!/أرخص من التطبيقات|cheaper than the apps/i.test(txt), where);
        if (/ستيك|steak/i.test(txt)) assert.match(txt, /ما عندنا|don't serve/, where);
      }
    }
  }
});

test("الأسعار من المنيو الحي — تغيّر السعر يتغيّر الرد", () => {
  const m = matchIntent("بكم نص دجاجة", { menu: MENU });
  assert.match(buildReply(m, baseCtx()).messages[0].interactive.body.text, /28 ر\.س/);
  const pages = JSON.parse(JSON.stringify(FX.pages));
  for (const p of pages) for (const i of p.items) if (i.id === 13) i.retail_price = 31;
  const menu2 = indexMenu(pages);
  assert.match(buildReply(matchIntent("بكم نص دجاجة", { menu: menu2 }), baseCtx({ menu: menu2 })).messages[0].interactive.body.text, /31 ر\.س/);
});

test("الصنف المخفي أو «خلص» يتعامل صح", () => {
  const hidden = indexMenu(FX.pages, { hiddenIds: ["13"] });
  assert.equal(hidden.items.some((i) => i.id === "13"), false);
  const so = indexMenu(FX.pages, { soldOut: { 13: true } });
  const r = buildReply({ intent: "item_info", entities: { itemId: "13" } }, baseCtx({ menu: so }));
  assert.match(r.messages[0].interactive.body.text, /خلص اليوم/);
});

test("«مشكل مخصوص» ما ياخذ عدد أشخاص أبداً", () => {
  for (const t of ["المشكل يكفي كم شخص", "مشكل مخصوص بالوزن", "بكم المشكل المخصوص"]) {
    const m = matchIntent(t, { menu: MENU });
    const txt = textsOf(buildReply(m, baseCtx({ offers: [] })));
    assert.ok(!/يكفي\s*\d|\d+\s*(أشخاص|اشخاص|شخص|نفر)/.test(txt), `${t}: ${txt}`);
  }
});

test("الكيلو يقول «من» ويوضح إنه لأصغر كمية", () => {
  const r = buildReply({ intent: "item_info", entities: { itemId: "97" } }, baseCtx());
  const b = r.messages[0].interactive.body.text;
  assert.match(b, /من 47 ر\.س/);
  assert.match(b, /ثلث/);
  assert.equal(r.messages[0].interactive.header.type, "image");
});

test("المواعيد من settings.hours (الخميس والجمعة لين ٣)", () => {
  const lines = hoursLines(FX.settings.hours);
  assert.deepEqual(lines, ["السبت – الأربعاء: 12 ظهراً – 2 فجراً", "الخميس – الجمعة: 12 ظهراً – 3 فجراً"]);
  assert.equal(fmtTime("00:30"), "12:30 فجراً");
  assert.equal(fmtTime("19:00", "en"), "7 PM");
  assert.equal(openState(FX.settings, at("2026-10-02T02:30:00")).open, true);   // الجمعة ٢:٣٠ (وردية الخميس)
  assert.equal(openState(FX.settings, at("2026-10-01T02:30:00")).open, false);  // الخميس ٢:٣٠ (وردية الأربعاء خلصت ٢)
  assert.equal(openState(FX.settings, at("2026-10-02T02:30:00")).closesAt, "03:00");
});

test("برّه الدوام: التحية تقول متى نفتح + زر «ذكّرني»", () => {
  const r = buildReply("greeting", baseCtx({ now: CLOSED }));
  const i = r.messages[0].interactive;
  assert.match(i.body.text, /نفتح اليوم الساعة 12 ظهراً/);
  assert.ok(i.action.buttons.some((b) => b.reply.id === "waitlist"));
  assert.equal(r.prompt, "waitlist_join");
  const w = buildReply("waitlist_join", baseCtx({ now: CLOSED }));
  assert.equal(w.actions[0].type, "waitlist_join");
  assert.match(w.actions[0].opensAt, /^2026-09-28T09:00:00/);
});

test("الخدمة موقوفة (service.js) ⇒ البوت يقولها", () => {
  const settings = { ...FX.settings, service: { delivery: { paused: true, until: "2026-09-28T19:00:00Z" } } };
  const r = buildReply("open_now", baseCtx({ settings }));
  assert.match(r.messages[0].interactive.body.text, /التوصيل متوقف مؤقتاً/);
});

test("رسوم التوصيل من dl_policies — والسلم كامل", () => {
  const b = buildReply("delivery_fee", baseCtx()).messages[0].interactive.body.text;
  for (const s of ["أقل من 60 ر.س: 20 ر.س", "60–80 ر.س: 15 ر.س", "من 150 ر.س وفوق: توصيل مجاني", "10 كم", "15 كم", "FIRST", "40 ر.س"]) assert.ok(b.includes(s), `${s}\n${b}`);
  const pol = { ...FX.policy, feeByTotal: [{ over: 0, fee: 18 }, { over: 120, fee: 0 }] };
  assert.match(buildReply("delivery_fee", baseCtx({ policy: pol })).messages[0].interactive.body.text, /أقل من 120 ر\.س: 18 ر\.س/);
});

test("الكود: شروط FIRST من shop_coupons + تنبيه لو الرقم له طلب سابق", () => {
  const r = buildReply("coupon_help", baseCtx({ orderHistory: { paid: 2 } }));
  const b = r.messages[0].interactive.body.text;
  assert.match(b, /الحد الأدنى للطلب 40/);
  assert.match(b, /مرة وحدة لكل رقم/);
  assert.match(b, /رقمك له طلب سابق/);
  const none = buildReply("coupon_help", baseCtx({ coupons: [] }));
  assert.equal(none.actions[0].type, "handoff");
});

test("وين طلبي: الطلب الحي + رابط التتبع؛ متأخر ⇒ تحويل عاجل؛ مافيه ⇒ نطلب الرقم", () => {
  const r = buildReply("order_status", baseCtx({ order: ACTIVE_ORDER }));
  assert.match(r.messages[0].interactive.body.text, /W1790012345678/);
  assert.equal(r.messages[0].interactive.action.parameters.url, "https://freshcuts.sa/track/W1790012345678");
  assert.equal(r.actions.length, 0);
  const late = { ...ACTIVE_ORDER, created_at: new Date(OPEN.getTime() - 95 * 60000).toISOString() };
  const r2 = buildReply("order_status", baseCtx({ order: late }));
  assert.equal(r2.actions[0].reason, "late_order");
  assert.equal(r2.actions[0].priority, "high");
  const r3 = buildReply("order_status", baseCtx());
  assert.match(r3.messages[0].interactive.body.text, /ما لقيت طلب/);
});

test("الشكوى تفتح تذكرة للمدير بالأولوية الصح", () => {
  const cold = buildReply(matchIntent("الاكل وصل بارد", { menu: MENU }), baseCtx({ order: ACTIVE_ORDER, text: "الاكل وصل بارد" }));
  assert.equal(cold.actions[0].type, "handoff");
  assert.equal(cold.actions[0].ticket, true);
  assert.equal(cold.actions[0].reason, "complaint:cold");
  assert.equal(cold.actions[0].orderNo, "W1790012345678");
  const sick = buildReply(matchIntent("صار عندي تسمم", { menu: MENU }), baseCtx());
  assert.equal(sick.actions[0].priority, "high");
  assert.match(sick.messages[0].text.body, /المدير بيتواصل معك/);
});

test("معلومة ناقصة (مواقف/حلال/حجز) ⇒ «أتأكد من الفريق» + تحويل — ولو موجودة في الإعدادات ⇒ نقولها", () => {
  for (const intent of ["parking", "reservation", "dine_in"]) {
    const r = buildReply(intent, baseCtx());
    assert.ok(r.actions.some((a) => a.type === "handoff" && /missing_fact/.test(a.reason)), intent);
  }
  const halal = buildReply(matchIntent("الاكل حلال؟", { menu: MENU }), baseCtx());
  assert.ok(halal.actions.some((a) => a.reason === "missing_fact:halal"));
  const settings = { ...FX.settings, waBot: { facts: { parking: "فيه مواقف قدام المطعم 🚗", halal: { ar: "كل لحومنا ودجاجنا حلال 100٪", en: "All our meat is halal" } } } };
  const p = buildReply("parking", baseCtx({ settings }));
  assert.match(p.messages[0].interactive.body.text, /مواقف قدام المطعم/);
  assert.equal(p.actions.length, 0);
  const h = buildReply(matchIntent("is it halal", { menu: MENU }), baseCtx({ settings, lang: "en" }));
  assert.match(h.messages[0].text.body, /All our meat is halal/);
});

test("الموقع من FAQ + رابط خرائط من googlePlace", () => {
  const r = buildReply("location", baseCtx());
  assert.match(r.messages[0].interactive.body.text, /حي السلامة/);
  assert.equal(r.messages[0].interactive.action.parameters.url, "https://maps.google.com/?cid=14767749764292326433");
});

test("تطبيقات التوصيل: نذكر اللي نشتغل معهم ونوجّه للموقع بدون ادعاء «أرخص»", () => {
  const b = buildReply("delivery_apps", baseCtx()).messages[0].interactive.body.text;
  assert.match(b, /هنقرستيشن وكيتا ونينجا/);
  assert.match(b, /أسعار المنيو الأصلية/);
});

test("الإيقاف والاشتراك ⇒ أكشن optout/optin", () => {
  assert.deepEqual(buildReply("stop", baseCtx()).actions, [{ type: "optout", scope: "marketing" }]);
  assert.deepEqual(buildReply("start", baseCtx()).actions, [{ type: "optin", scope: "marketing" }]);
});

test("المنيو: قائمة فئات ≤١٠ من الصفحات الحية، والفئة ⇒ أصنافها بأسعارها", () => {
  const r = buildReply("menu", baseCtx());
  const rows = r.messages[0].interactive.action.sections[0].rows;
  assert.ok(rows.length >= 8 && rows.length <= 10);
  assert.ok(rows.some((x) => x.title === "مشاوي بالوزن" && /بالوزن/.test(x.description)));
  const pizza = buildReply({ intent: "menu", entities: { categoryId: "40" } }, baseCtx());
  const prow = pizza.messages[0].interactive.action.sections[0].rows;
  assert.equal(prow.length, 10);
  assert.match(pizza.messages[0].interactive.body.text, /و3 أصناف ثانية/);
});

/* ── ٥) handleInbound: السكوت بعد الموظف، التحويل، حد الردود ────────────── */
const load = (over = {}) => async () => baseCtx(over);
test("بعد رد الموظف من الجوال البوت يسكت — إلا «إيقاف»", async () => {
  const state = createState();
  const t0 = OPEN.getTime();
  state.staffReplied("966500000001", t0);
  const r = await handleInbound({ from: "966500000001", type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 + 60_000 });
  assert.equal(r.skip, "staff_active");
  const s = await handleInbound({ from: "966500000001", type: "text", text: "إيقاف" }, { state, loadContext: load(), now: t0 + 120_000 });
  assert.equal(s.intent, "stop");
  assert.equal(s.actions[0].type, "optout");
  assert.equal(s.actions[0].phone, "500000001");
  // بعد ٤ ساعات يرجع
  const back = await handleInbound({ from: "966500000002", type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 + 5 * 3600_000 });
  assert.equal(back.skip, null);
});

test("بعد التحويل لموظف: سكوت ٣٠ دقيقة إلا حالة الطلب", async () => {
  const state = createState();
  const t0 = OPEN.getTime();
  const a = await handleInbound({ from: "966500000003", type: "text", text: "ابي اكلم موظف" }, { state, loadContext: load(), now: t0 });
  assert.equal(a.actions[0].type, "handoff");
  const b = await handleInbound({ from: "966500000003", type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 + 60_000 });
  assert.equal(b.skip, "awaiting_staff");
  const c = await handleInbound({ from: "966500000003", type: "text", text: "وين طلبي" }, { state, loadContext: load({ order: ACTIVE_ORDER }), now: t0 + 120_000 });
  assert.equal(c.intent, "order_status");
  const d = await handleInbound({ from: "966500000003", type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 + 31 * 60_000 });
  assert.equal(d.skip, null);
});

test("حد الردود: نفس الرسالة خلال ٩٠ ثانية تتجاهل، وبعد ٦ ردود ننبه مرة ونحوّل", async () => {
  const state = createState();
  const t0 = OPEN.getTime();
  const id = "966500000004";
  await handleInbound({ from: id, type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 });
  const dup = await handleInbound({ from: id, type: "text", text: "المنيو" }, { state, loadContext: load(), now: t0 + 30_000 });
  assert.equal(dup.skip, "duplicate");
  const texts = ["العروض", "المواعيد", "الموقع", "طرق الدفع", "رسوم التوصيل"];
  for (let i = 0; i < texts.length; i++) {
    const r = await handleInbound({ from: id, type: "text", text: texts[i] }, { state, loadContext: load(), now: t0 + (i + 1) * 20_000 });
    assert.equal(r.skip, null, texts[i]);
  }
  const notice = await handleInbound({ from: id, type: "text", text: "كيف اطلب" }, { state, loadContext: load(), now: t0 + 150_000 });
  assert.equal(notice.intent, "rate_notice");
  const silent = await handleInbound({ from: id, type: "text", text: "بكم الكفتة" }, { state, loadContext: load(), now: t0 + 160_000 });
  assert.ok(["rate_limited", "awaiting_staff"].includes(silent.skip));
});

test("مرسل غير صالح يتجاهل، وحالة الطلب النشطة معرّفة", async () => {
  const r = await handleInbound({ from: "abc", text: "هلا" }, { state: createState(), loadContext: load() });
  assert.equal(r.skip, "bad_sender");
  assert.ok(ACTIVE_STATUSES.includes("on_the_way") && !ACTIVE_STATUSES.includes("delivered"));
});

test("مرتين «ما فهمت» ⇒ الثالثة تحوّل لموظف", async () => {
  const state = createState();
  const t0 = OPEN.getTime(), id = "966500000005";
  const a = await handleInbound({ from: id, text: "zzz" }, { state, loadContext: load(), now: t0 });
  const b = await handleInbound({ from: id, text: "qqq" }, { state, loadContext: load(), now: t0 + 10_000 });
  const c = await handleInbound({ from: id, text: "xxx" }, { state, loadContext: load(), now: t0 + 20_000 });
  assert.equal(a.actions.length + b.actions.length, 0);
  assert.equal(c.actions[0]?.reason, "bot_not_understood");
});

test("نص صفحة التتبع يتحوّل لصياغة سعودية، والكلام اللاتيني العشوائي يرجع عربي", async () => {
  const { saudize } = await import("./wabot.js");
  assert.equal(saudize("المطعم بيجهّز طلبك 👨‍🍳"), "المطعم يجهّز طلبك 👨‍🍳");
  assert.equal(saudize("طلبك جاهز وبنسلّمه للمندوب 🛵"), "طلبك جاهز ونسلّمه للمندوب 🛵");
  const r = buildReply("order_status", baseCtx({ order: ACTIVE_ORDER }));
  assert.ok(!/بيجهّز/.test(r.messages[0].interactive.body.text));
  assert.equal(detectLang("asdkjh"), "ar");
  assert.equal(detectLang("hello"), "en");
});

test("مهايئ setBot: نفس عقد runBot في whatsapp.js (phone=5XXXXXXXX، interactiveId)", async () => {
  const { makeBotAdapter } = await import("./wabot.js");
  const seen = [];
  const bot = makeBotAdapter({ state: createState(), loadContext: load(), onAction: (a) => seen.push(...a) });
  const i = await bot.matchIntent("بكم نص دجاجة", { phone: "500000009", now: OPEN });
  assert.equal(i.intent, "item_price");
  const out = await bot.buildReply(i, { phone: "500000009" });
  assert.ok(Array.isArray(out) && out[0].type === "interactive" && !out[0].to);
  const b = await bot.matchIntent("", { phone: "500000009", interactiveId: "status", now: OPEN });
  assert.equal(b.intent, "order_status");
  const h = await bot.matchIntent("ابي اكلم موظف", { phone: "500000010", now: OPEN });
  await bot.buildReply(h, { phone: "500000010" });
  assert.equal(seen[0].type, "handoff");
  assert.equal(await bot.matchIntent("المنيو", { phone: "500000010", now: OPEN }), null); // سكوت بعد التحويل
  assert.equal(await bot.matchIntent("", { phone: "500000011" }), null);
  assert.equal(await bot.matchIntent("هلا", { phone: "123" }), null);
});
