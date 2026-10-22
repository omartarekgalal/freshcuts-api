/* ═══════════════════════════════════════════════════════════════════════════
   MJ2 (٢٢/١٠/٢٠٢٦) — ٥ تصليحات صغيرة من حالات حقيقية (قراية بس من wa_messages / wa_assist_turns / wa_bot_log / sms_log + Graph GET للقالب).
   الأرقام مقنّعة 5000000xx. من غير أي نداء موديل ولا شبكة.

     ١) …3177 17:49:40 — العميلة عدّلت رسالتها (edit) ⇒ «[edit]» وماجد رد «ما وصلتني رسالتك بعد التعديل…» ⇒ سكوت.
     ٢) …3177 17:49:24 — «أسعاركم على تطبيقات التواصل مبالغ فيها» ⇒ faq(apps) بالحرف «نعم، تجدنا على كيتا…» + FIRST للمرة التانية
        ⇒ النص كله للسؤال المباشر بس؛ الرأي ⇒ سطر المقارنة من غير «نعم» ولا قايمة؛ FIRST مرة في المحادثة (oneOfferPerChat).
     ٣) …3177 17:51:37 — تحويل شكوى ⇒ «اكتب رقم الطلب (يبدأ بحرف W)» ومالهاش ولا طلب ⇒ السطر بيتشال (التغطية في wabotrun.test + eval/majed-context).
        …3177 17:46:25 — «نعم نوصل داخل جدة 👍» قبل الموقع ⇒ المراجِع بيرفض «نوصل» لحد ما quote_delivery تقول deliverable.
     ٤) …9470 W1792684427899 22/10 16:05 — fc_order_pickup_ready ⇒ WA_132018: ميتا معتمداه BODY بس ({{1}})، وإحنا بنبعت زر URL بمتغيّر.
        الـSMS البديل اتبعت (sms_log ref W…:pickup_ready بعد ٠٫٣ ث). ٥ فشلات بنفس الكود ١٩–٢٢/١٠.
     ٥) settings-integrity.test.mjs:100 كان معتمد على تاريخ النهارده (اتصلّح هناك بتواريخ ٢٠٩٩).

     node --test mj2-small-fixes.test.mjs
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "./waguard.js";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import * as L from "./walearn.js";
import { makeWorld } from "./eval/world.mjs";

const W = await import("./whatsapp.js");
const CAT = await import("./watemplates.js");
const { templateDiff } = await import("./wacloud.js");      // TS1: نفس مقارنة «الكتالوج ⇄ ميتا» اللي الحملات بتستعملها
W.registerCatalog(CAT);
const { register: registerNotify } = await import("./notify.js");
const { bus, CHANNEL } = await import("./order-events.js");

const ME = "500000041";      // …3177 مقنّع
const APPS_LIVE = "نعم، تجدنا على كيتا وهنقرستيشن ونينجا.\nوالطلب من موقعنا freshcuts.sa بسعر المطعم نفسه، وأسعار الأصناف في التطبيقات أعلى.\nوأول طلب توصيل من الموقع توصيله مجاني للطلبات من 60 ر.س بكود FIRST.";      // settings.waBot.faq.apps.ar الحي ٢٢/١٠
const APPS_CMP = "الطلب من موقعنا freshcuts.sa بسعر المطعم نفسه، وأسعار الأصناف في التطبيقات أعلى.";
const OPINION = "لا أبغى توصيل\nلأن أسعاركم على تطبيقات التواصل مبالغ فيها";      // بالحرف (حتى «التواصل»)
const PIN_ASK = "عشان أتأكد إن التوصيل يوصل لموقعك ورسومه، شارك موقعك هنا في الواتساب (📎 ثم «الموقع»).";

const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function majed(steps, world = {}) {
  let i = 0;
  const W0 = makeWorld(world, { callModel: async () => { const s = steps[i++]; if (!s) throw new Error("no step left"); return s; }, onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg: { pairingEnabled: false, forceSuggestion: false } });
  const session = AR.newSession(W0.now());
  const turn = async (text, acfg = {}) => { const hours = await W0.tools.get_hours(); const cls = R.classify({ phone: ME, text, type: "text" }, W0.know);
    return W0.loop.runTurn({ phone: ME, text, lang: "ar", session, acfg: { ...W0.acfg, routing: "strong", salesBrain: false, ...acfg }, context: AR.buildContext({ first: true, hours, boxes: W0.boxes, hint: AR.hintOf(cls) }) }); };
  return { W: W0, session, turn, used: () => i };
}

/* ═════════ ١) رسالة اتعدّلت (edit) ═════════ */
test("١ edit (…3177 17:49:40): «[edit]» is an ignored type — no class, the assistant is not eligible, the bot stays silent; the webhook keeps the new text when Meta sends it", () => {
  const cfg = R.botConfig({ waBot: { mode: "live" } });
  for (const text of ["[edit]", "[رسالة اتعدّلت]", "[عدّل رسالته] لا أبغى توصيل"]) {
    const ev = { phone: ME, text, type: "edit" }, cls = R.classify(ev, null);
    assert.deepEqual([cls.key, cls.rawIntent], [null, "type:edit"], text);
    assert.equal(AR.assistEligible({ acfg: AR.assistConfig({ mode: "live", liveAudience: "all" }), cfg, phone: ME, ev, cls, d: null, allowed: true }).why, "no_class");
    const d = R.decide(ev, { cfg, now: new Date("2026-10-22T17:49:41Z"), cls, chat: {}, data: {} });
    assert.deepEqual([d.act, d.reason], ["silent", "ignored_type"]);
  }
  // الويب هوك: «[edit]» القديمة ⇒ «[رسالة اتعدّلت]»، والنص الجديد لو ميتا بعتته + المرجع، ومفيش نية (تعديل لـ«إيقاف» مايوقّفش الرسايل)
  const hook = (m) => ({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P1" }, messages: [{ from: `966${ME}`, id: "wamid.E1", timestamp: "1792691380", ...m }] } }] }] });
  const bare = W.parseWebhook(hook({ type: "edit" }), { phoneId: "P1" }).messages[0];
  assert.deepEqual([bare.type, bare.text, bare.intent], ["edit", "[رسالة اتعدّلت]", null]);
  const full = W.parseWebhook(hook({ type: "edit", edit: { original_message_id: "wamid.ORIG", message: { type: "text", text: { body: "إيقاف" } } } }), { phoneId: "P1" }).messages[0];
  assert.deepEqual([full.text, full.intent, full.edit.original, full.edit.text], ["[عدّل رسالته] إيقاف", null, "wamid.ORIG", "إيقاف"]);
  assert.equal(W.editOf({ type: "text" }), null);
});

/* ═════════ ٢) faq(apps) على قد الكلام ═════════ */
test("٢ appsAnswer: the direct question gets the approved text as it is; the price opinion of …3177 gets the comparison line only (no «نعم», no app list); a FIRST line already said is dropped", () => {
  const op = G.appsAnswer(APPS_LIVE, { asked: OPINION, firstSaid: true });
  assert.deepEqual([op.text, op.direct, op.dropped], [APPS_CMP, false, ["list", "first"]]);
  assert.equal(G.appsAnswer(APPS_LIVE, { asked: OPINION }).text, `${APPS_CMP}\nوأول طلب توصيل من الموقع توصيله مجاني للطلبات من 60 ر.س بكود FIRST.`, "FIRST not said yet: kept");
  for (const q of ["أنتم على التطبيقات؟", "موجودين في هنقرستيشن؟", "عندكم كيتا", "هل انتم على نينجا", "are you on keeta?"]) {
    assert.equal(G.appsDirectQuestion(q), true, q); assert.equal(G.appsAnswer(APPS_LIVE, { asked: q }).text, APPS_LIVE, q);
  }
  for (const q of [OPINION, "الأسعار على تطبيقات التوصيل لمطعمكم مبالغ فيها", "و ذا على هنقرستيشن", "التطبيقات أغلى منكم بكثير", "the prices on the apps are too high"]) assert.equal(G.appsDirectQuestion(q), false, q);
  const d = G.appsAnswer(APPS_LIVE, { asked: "أنتم على التطبيقات؟", firstSaid: true });
  assert.equal(d.text, "نعم، تجدنا على كيتا وهنقرستيشن ونينجا.\nوالطلب من موقعنا freshcuts.sa بسعر المطعم نفسه، وأسعار الأصناف في التطبيقات أعلى.", "direct + FIRST already said: «نعم» stays, FIRST goes");
  // نص المالك من غير سطر مقارنة ⇒ text null (المنادي بيرجع للنص المعتمد من غير «نعم»)
  assert.equal(G.appsAnswer("نعم، تجدنا على كيتا وهنقرستيشن.", { asked: OPINION }).text, null);
});

test("٢ Majed (…3177): faq(apps) on a price opinion returns the comparison line with its own rule; with the FIRST line already said in this chat it is not repeated; the direct question is unchanged", async () => {
  const a = majed([use(["faq", { topic: "apps" }]), say(`معك حق، الفرق واضح في التطبيقات 🙏\n${APPS_CMP}`)], { faq: { apps: { ar: APPS_LIVE } } });
  a.session.state.proactive = "first";      // ١٧:٤٦:٣٠ «🎁 أول طلب توصيل لك من موقعنا مجاني… بكود FIRST» (السطر المبادِر)
  const r = await a.turn(OPINION, { oneOfferPerChat: true });
  assert.equal(r.ok, true); const res = r.trace.tools.find((t) => t.name === "faq").result;
  assert.equal(res.say, APPS_CMP); assert.match(res.rule, /did not ask whether we are on the apps/); assert.match(res.rule, /no «نعم»/);
  assert.deepEqual(r.trace.apps, { direct: false, dropped: ["list", "first"] });
  assert.doesNotMatch(r.text, /^نعم|تجدنا على كيتا|FIRST/);
  // FIRST اتقال في رد سابق لماجد نفسه (مش السطر المبادِر)
  const b = majed([use(["faq", { topic: "apps" }]), say(APPS_LIVE.split("\n").slice(0, 2).join("\n"))], { faq: { apps: { ar: APPS_LIVE } } });
  b.session.messages.push({ role: "user", content: [{ type: "text", text: "وش عرض أول طلب؟" }] }, { role: "assistant", content: [{ type: "text", text: "عرض أول طلب: توصيل مجاني بكود FIRST للطلبات من 60 ر.س." }] });
  const rb = await b.turn("أنتم على التطبيقات؟", { oneOfferPerChat: true });
  assert.equal(rb.trace.tools.find((t) => t.name === "faq").result.say, APPS_LIVE.split("\n").slice(0, 2).join("\n"));
  assert.equal(rb.trace.tools.find((t) => t.name === "faq").result.rule, "send this text as it is");
  // المفتاح مقفول ⇒ FIRST بيفضل (زي الأول)
  const c = majed([use(["faq", { topic: "apps" }]), say(APPS_LIVE)], { faq: { apps: { ar: APPS_LIVE } } }); c.session.state.proactive = "first";
  assert.equal((await c.turn("أنتم على التطبيقات؟", { oneOfferPerChat: false })).trace.tools[0].result.say, APPS_LIVE);
});

test("٢ rules bot faq:apps: the same on-point rule (no «نعم، تجدنا…» on a price comparison)", () => {
  const cfg = R.botConfig({ waBot: { mode: "live", faq: { apps: { ar: APPS_LIVE } } } });
  const body = (asked) => R.buildReply("faq", { cfg, lang: "ar", data: { settings: {} }, referral: null, factual: false, arg: "apps", asked }).body;
  assert.match(body("الأسعار على تطبيقات التوصيل لمطعمكم مبالغ فيها"), new RegExp(`^${APPS_CMP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(body("انتم في هنقرستيشن؟"), /^نعم، تجدنا على كيتا وهنقرستيشن ونينجا\./);
});

/* ═════════ ٣) «نعم نوصل» قبل الموقع ═════════ */
test("٣ deliveryClaim: «نعم نوصل داخل جدة 👍» and «نوصل لحيك» are claims; a negation, a condition or an ask for the pin is not", () => {
  for (const t of ["نعم نوصل داخل جدة 👍 شارك موقعك هنا في الواتساب", "أكيد نوصل لحيك", "ايوه بنوصل لكم", "Yes, we deliver to your area"]) assert.ok(G.deliveryClaim(t), t);
  for (const t of [PIN_ASK, "للأسف ما نوصل لموقعك، تقدر تستلم من الفرع", "عشان أتأكد إذا نوصل لموقعك شارك الموقع", "We can check if we deliver to you once you share your location"]) assert.equal(G.deliveryClaim(t), null, t);
  const p = (t, o) => AR.checkReply(t, { facts: [], know: {}, lang: "ar", ...o }).problems.map((x) => x.type);
  assert.ok(p("نعم نوصل داخل جدة 👍 شارك موقعك هنا في الواتساب (📎 ثم «الموقع»).", { coverage: false }).includes("delivery_unconfirmed"));
  assert.ok(!p("نعم نوصل لك 👍 شارك موقعك.", { coverage: true }).includes("delivery_unconfirmed"), "quote_delivery said deliverable");
  assert.ok(!p("نعم نوصل لك 👍", { coverage: false, existingOrder: true }).includes("delivery_unconfirmed"), "an order already on its way");
  assert.ok(!p("نعم نوصل داخل جدة 👍", {}).includes("delivery_unconfirmed"), "older callers (no coverage) unchanged");
  assert.match(AR.retryNote([{ type: "delivery_unconfirmed", value: "نعم نوصل" }]), /location has not been checked/);
});

test("٣ Majed (…3177 17:46:25): «و هل يوجد توصيل لحي المنار» ⇒ the «نعم نوصل داخل جدة» reply is refused and rewritten as the pin request; after a deliverable quote «نعم نوصل لك» passes", async () => {
  const a = majed([say("نعم نوصل داخل جدة 👍 شارك موقعك هنا في الواتساب (📎 ثم «الموقع») وأتأكد لك من العنوان ورسوم التوصيل."), say(PIN_ASK)]);
  const r = await a.turn("و هل يوجد توصيل لحي المنار");
  assert.equal(r.text, PIN_ASK); assert.equal(a.used(), 2);
  assert.ok(r.trace.verdicts[0].problems.some((x) => x.type === "delivery_unconfirmed"));
  const b = majed([use(["quote_delivery", { total: 0 }]), say("نعم نوصل لك 👍 رسوم التوصيل 20 ر.س. وش تحب تطلب؟")]);
  b.W.state.loc = { lat: 21.58, lng: 39.15, at: new Date().toISOString() };
  const rb = await b.turn("📍"); assert.equal(rb.ok, true); assert.match(rb.text, /^نعم نوصل لك 👍/); assert.equal(rb.session.state.coverage, true);
  const c = majed([use(["quote_delivery", { total: 0 }]), say("نعم نوصل لك 👍"), say("للأسف موقعك خارج نطاق التوصيل عندنا، تقدر تستلم من الفرع بدون رسوم.")], { loc: "out" });
  c.W.state.loc = { lat: 21.7, lng: 39.3, at: new Date().toISOString() };
  const rc = await c.turn("📍"); assert.match(rc.text, /^للأسف موقعك خارج نطاق التوصيل/); assert.equal(rc.session.state.coverage, false);
});

/* ═════════ ٤) fc_order_pickup_ready = المعتمد عند ميتا ═════════ */
/* Graph GET /{WABA}/message_templates?name=fc_order_pickup_ready (من حاوية الـAPI، ٢٢/١٠، قراية بس) — المكوّنات بالحرف */
const LIVE_META = Object.freeze([
  { name: "fc_order_pickup_ready", status: "APPROVED", category: "UTILITY", language: "ar", components: [{ type: "BODY", text: "تحديث طلبك رقم {{1}}: طلبك جاهز للاستلام من الفرع. يرجى ذكر رقم الطلب عند الاستلام.", example: { body_text: [["W1792251412023"]] } }] },
  { name: "fc_order_pickup_ready", status: "APPROVED", category: "UTILITY", language: "en", components: [{ type: "BODY", text: "Order {{1}} update: your order is ready for pickup at the branch. Please mention your order number when collecting.", example: { body_text: [["W1792251412023"]] } }] },
]);
/* اللي ميتا بتقارنه (132018): عدد متغيّرات كل مكوّن في الحمولة = عدد {{n}} في المعتمد، ومفيش مكوّن مالوش مقابل */
function metaParamProblems(payload, live) {
  const out = [], comps = payload.template.components || [];
  const liveOf = (type) => live.components.find((c) => c.type === type);
  for (const c of comps) {
    if (c.type === "body") { const n = ((liveOf("BODY") || {}).text || "").match(/\{\{\d+\}\}/g)?.length || 0; if (c.parameters.length !== n) out.push(`body ${c.parameters.length}≠${n}`); }
    else if (c.type === "button") { const b = ((liveOf("BUTTONS") || {}).buttons || [])[Number(c.index)]; if (!b || !/\{\{1\}\}/.test(b.url || "")) out.push(`button ${c.index} not in the approved template`); }
    else if (c.type === "header" && !liveOf("HEADER")) out.push("header not in the approved template");
  }
  return out;
}
test("٤ WA_132018 (…9470 W1792684427899): the payload we send for fc_order_pickup_ready matches the components Meta approved — body {{1}} only, no button — in both languages", () => {
  const NO = "W1792684427899";
  for (const live of LIVE_META) {
    const t = CAT.findTemplate("fc_order_pickup_ready", live.language);
    assert.equal(CAT.bodyOf(t), live.components[0].text, `${live.language}: the catalogue body is the approved body, word for word`);
    assert.deepEqual(t.components.map((c) => c.type), live.components.map((c) => c.type));
    assert.deepEqual(templateDiff(W.TEMPLATES.fc_order_pickup_ready.variants[live.language], live.components), [], `${live.language}: catalogue ⇄ Meta = same`);
    const params = W.TEMPLATES.fc_order_pickup_ready.bind({ order: { order_no: NO }, customer: { name: "" } });
    assert.deepEqual([params.body, params.button, params.missing], [[NO], [], []]);
    const payload = W.buildTemplatePayload("fc_order_pickup_ready", "966500000047", params, live.language);
    assert.deepEqual(payload.template.components, [{ type: "body", parameters: [{ type: "text", text: NO }] }]);
    assert.deepEqual(metaParamProblems(payload, live), [], live.language);
  }
  // الحمولة القديمة (زر URL بمتغيّر) ⇒ نفس الفحص بيمسكها — ده كان سبب الرفض
  const old = { template: { components: [{ type: "body", parameters: [{ type: "text", text: NO }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: NO }] }] } };
  assert.deepEqual(metaParamProblems(old, LIVE_META[0]), ["button 0 not in the approved template"]);
  const before = [{ type: "BODY", text: "طلبك رقم {{1}} جاهز للاستلام من فريش كاتس 📍 تفضّل إلى الفرع واذكر رقم طلبك." }, { type: "BUTTONS", buttons: [{ type: "URL", text: "تفاصيل الطلب", url: "https://freshcuts.sa/track/{{1}}" }] }];
  assert.deepEqual(templateDiff(before, LIVE_META[0].components), ["body", "buttons"], "the catalogue before MJ2 differed from Meta in body and buttons");
});

/* ٤ ب: الـSMS البديل — notify.orderReady بإعدادات ٢٢/١٠ الحيّة ووحدة واتساب بترجع خطأ ميتا */
const LIVE_N_2210 = Object.freeze({ smsEnabled: true, whatsappEnabled: true, pushEnabled: false,
  smsStages: ["on_the_way", "rejected_refunded", "refund_failed", "pickup_ready"],
  whatsappStages: ["pos_created", "accepted", "on_the_way", "pickup_ready", "delivered", "rejected_refunded", "refund_failed", "collected"],
  whatsappReplacesSmsStages: ["pos_created", "accepted", "on_the_way", "pickup_ready", "delivered", "rejected_refunded", "refund_failed"] });
function notifyWith({ waResult, notifications, order }) {
  const sms = [], calls = [];
  const pool = { async query(sql) { return /FROM shop_orders/.test(String(sql)) ? { rows: [order] } : { rows: [], rowCount: 0 }; } };
  const api = registerNotify({ get() {}, post() {}, put() {}, delete() {} }, { pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: String,
    webpush: { generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }), setVapidDetails() {}, async sendNotification() {} },
    getSettingsData: async () => ({ webPushKeys: { publicKey: "p", privateKey: "q" }, notifications }), sendSms: async (x) => { sms.push(x); } },
  { wa: { sendOrderUpdate: async (o, st, opts) => { calls.push({ st, opts }); return waResult; } } });
  return { api, sms, calls };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
test("٤ the SMS fallback for a pickup-ready template that Meta refuses (…9470 22/10 16:05: WA_132018 ⇒ «فريش كاتس: طلبك … جاهز للاستلام من الفرع» 0.3 s later) — and for a late «failed» webhook", async () => {
  const NO = "W1792684427899", order = { order_no: NO, phone_norm: "500000047", option: "pickup", total: 29, table_no: null, created_at: new Date(Date.now() - 12 * 60_000).toISOString(), is_test: false };
  const ev = []; const fn = (e) => { if (e.name === "notify_sent") ev.push(e); }; bus.on(CHANNEL, fn);
  try {
    const { api, sms, calls } = notifyWith({ waResult: { ok: false, error: "WA_132018", code: 132018, message: "(#132018) There was an issue with the parameters in your template." }, notifications: LIVE_N_2210, order });
    await api.orderReady(NO); await flush();
    assert.deepEqual(sms.map((x) => [x.phoneNorm, x.body, x.kind, x.ref]), [["500000047", `فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع`, "order_status", `${NO}:pickup_ready`]]);
    assert.deepEqual(ev.filter((e) => e.data.stage === "pickup_ready").map((e) => [e.channel, e.ok, e.data.error || null]), [["whatsapp", false, "WA_132018"], ["sms", true, null]]);
    // نفس الطلب لو ميتا قبلته وبعدين الويب هوك قال «failed»: النص البديل مربوط بالرسالة (fallback_sms) ⇒ handleStatus بيبعته
    assert.equal(calls[0].opts.fallbackSms, `فريش كاتس: طلبك ${NO} جاهز للاستلام من الفرع`);
  } finally { bus.off(CHANNEL, fn); }
});

/* ═════════ سجل الأخطاء ═════════ */
test("registry: the four MJ2 rows of …3177 (masked), the new types in Arabic, one lesson for Majed, and every lesson still fits in 2000", () => {
  const rows = L.REVIEW_SEED.filter((r) => r.mkey.startsWith("mj2:"));
  assert.deepEqual(rows.map((r) => [r.mkey, r.type, r.lesson_on]), [["mj2:D:3177", "delivery_unchecked", true], ["mj2:F:3177", "faq_off_point", false], ["mj2:E:3177", "edited_reply", false], ["mj2:W:3177", "order_no_without_order", false]]);
  for (const r of rows) { assert.match(L.MISTAKE_TYPES[r.type], /[؀-ۿ]/); assert.equal(r.phone_masked, "…3177"); assert.equal(r.day, "2026-10-22"); assert.ok(r.example && r.wrong_reply && r.correct && r.guard);
    assert.doesNotMatch(`${r.example} ${r.wrong_reply} ${r.correct}`, /05\d{8}|9665\d{8}|\b5\d{8}\b/); }
  const all = L.REVIEW_SEED.filter((r) => r.lesson_on).map((r, i) => ({ ...r, id: i + 1, status: "confirmed" })).reverse();
  const t = L.lessonsText(all, L.LEARN_DEFAULTS.lessonsMaxChars);
  assert.equal(t.ids.length, all.length, `${t.text.length} chars`); assert.match(t.text, /Never: تقول «نعم نوصل» قبل ما quote_delivery تأكد موقعه/);
});
