/* ════════════════════════════════════════════════════════════════════════════
   مراجعة ١٢/١٠/٢٠٢٦ — «ولا غلطة توصل لعميل».
   كل قالب مربوط بمُرسل بيتعبّى هنا ببيانات واقعية ونتأكد من النص النهائي حرفياً: مفيش متغيّر فاضي،
   مفيش «-»، مفيش متغيّرين متبدّلين، والرابط هو رابط الطلب نفسه. وكل قوالب الكتالوج (بكل لغة):
   المسار رقم i بيروح للمتغيّر رقم i، والنص عربي أبيض، والتسويق برابط متتبَّع وزر إيقاف.
     node --test wa-wired.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./watemplates.js");
const CL = await import("./wacloud.js");
const { register: registerNotify } = await import("./notify.js");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function fakeApp() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
const ctxOf = (json = {}) => ({ req: { json: async () => json, text: async () => "", header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }), text: (b, s = 200) => ({ body: b, status: s }) });
function memPool({ optins = {}, orders = {} } = {}) {
  const msgs = [];
  return {
    msgs,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: optins[p[0]] ? [optins[p[0]]] : [] };
      if (/FROM cms_contacts/i.test(s)) return { rowCount: 0, rows: [] };
      if (/FROM shop_orders/i.test(s)) return { rows: orders[p[0]] ? [orders[p[0]]] : [] };
      if (/^INSERT INTO wa_messages/i.test(s) && /'out'/.test(s)) { msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6], error: p[7], body: p[8] }); return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
  };
}
function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.T${calls.length}` }] }) }; };
  fn.calls = calls;
  return fn;
}
const ENV = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "WHATSAPP_TEMPLATES_WRITE", "META_CAPI_TOKEN"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const ON = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
/* SW1: تحديثات الطلب بقت لكل مرحلة (notifications.whatsappStages، الافتراضي فاضي) — الاختبارات دي عن النص والحارس، فكل المراحل مشغّلة فيها. */
const ALL_STAGES = Object.keys(W.STAGE_TEMPLATES);
function setup({ pool, fetch, settings = { notifications: { whatsappEnabled: true, whatsappStages: ALL_STAGES }, waMaster: { enabled: true } } } = {}) {
  const app = fakeApp();
  const f = fetch || fakeFetch();
  const p = pool || memPool();
  const api = W.register(app, { pool: p, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") }, { fetch: f, sendSms: async () => ({ ok: true }) });
  return { app, api, pool: p, fetch: f };
}

/* ── طلبات واقعية ─────────────────────────────────────────────────────── */
const PHONE = "512345678";
const ORDERS = {
  W1790011111111: { name: "محمد العتيبي", option: "delivery", total: "86.50", refund_id: null, table_no: null },
  W1790022222222: { name: "", option: "pickup", total: "65.00", refund_id: null, table_no: null },          // من غير اسم
  W1790033333333: { name: "Sara", option: "pickup", total: "29", refund_id: null, table_no: 4 },             // طاولة
  W1790044444444: { name: "عبدالله", option: "delivery", total: "125.00", refund_id: "RF-778", table_no: null },
};
const order = (no) => ({ order_no: no, phone_norm: PHONE, option: ORDERS[no].option, total: ORDERS[no].total });
const optedIn = () => memPool({ optins: { [PHONE]: { updates: true, marketing: true } }, orders: ORDERS });

/* النص اللي العميل يشوفه بالظبط */
const EXPECT = {
  pos_created: { no: "W1790011111111", name: "fc_order_received",
    text: "أهلاً محمد، استلمنا طلبك رقم W1790011111111 وتم الدفع بنجاح ✅\nالإجمالي: 86.50 ر.س\nنبلّغك هنا بكل تحديث على طلبك.", button: "W1790011111111" },
  accepted: { no: "W1790011111111", name: "fc_order_preparing",
    text: "طلبك رقم W1790011111111 صار في المطبخ 👨‍🍳\nنطبخ الأكل طازج عند الطلب، ونبلّغك أول ما يجهز.", button: "W1790011111111" },
  on_the_way: { no: "W1790011111111", name: "fc_order_on_the_way",
    text: "طلبك رقم W1790011111111 مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.", button: "W1790011111111" },
  delivered: { no: "W1790011111111", name: "fc_order_delivered",
    text: "تم توصيل طلبك رقم W1790011111111 ✅ بالعافية عليك.\nلو عندك أي ملاحظة على الطلب ردّ على هذي الرسالة ونخدمك.", button: null },
  pickup_ready: { no: "W1790022222222", name: "fc_order_ready_pickup",
    text: "طلبك رقم W1790022222222 جاهز للاستلام ✅\nاذكر رقم الطلب للكاشير عند الاستلام.", button: "W1790022222222" },
  rejected_refunded: { no: "W1790044444444", name: "fc_order_refunded",
    text: "نعتذر منك، ما قدرنا ننفّذ طلبك رقم W1790044444444 وتم استرجاع المبلغ كاملاً لوسيلة الدفع 💳\nيظهر المبلغ في حسابك حسب إجراءات البنك.", button: null },
  refund_failed: { no: "W1790011111111", name: "fc_refund_in_progress",
    text: "نعتذر منك بخصوص طلبك رقم W1790011111111 🙏\nاسترجاع المبلغ جاري وفريقنا يتابعه، وبنتواصل معك للتأكيد.", button: null },
};

test("order stages: every wired stage renders its exact final text for a realistic order", withEnv(ON, async () => {
  assert.deepEqual(Object.keys(W.STAGE_TEMPLATES).sort(), Object.keys(EXPECT).sort(), "every wired stage is covered here");
  for (const [stage, x] of Object.entries(EXPECT)) {
    const { api, pool, fetch } = setup({ pool: optedIn() });
    const r = await api.sendOrderUpdate(order(x.no), stage);
    assert.equal(r.ok, true, `${stage}: ${JSON.stringify(r)}`);
    assert.equal(fetch.calls.length, 1, stage);
    const sent = fetch.calls[0].body;
    assert.equal(sent.to, `966${PHONE}`);
    assert.equal(sent.template.name, x.name, stage);
    assert.equal(sent.template.language.code, "ar");
    assert.equal(pool.msgs[0].body, x.text, `${stage}: text shown to the customer`);
    assert.doesNotMatch(pool.msgs[0].body, /\{\{|\}\}|undefined|null|NaN/, stage);
    const body = sent.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
    assert.ok(body.every((v) => v && v !== "-"), `${stage}: no empty variable`);
    const btn = sent.template.components.find((c) => c.type === "button");
    if (x.button) {
      assert.equal(btn.parameters[0].text, x.button, `${stage}: track link is the order's own`);
      const def = W.templateSubmission(x.name).components.find((c) => c.type === "BUTTONS").buttons[Number(btn.index)];
      assert.equal(def.url.replace("{{1}}", btn.parameters[0].text), `https://freshcuts.sa/track/${x.no}`);
    } else assert.equal(btn, undefined, `${stage}: no dynamic button`);
  }
}));

test("order stages: no name ⇒ «عميلنا», never an empty first variable", withEnv(ON, async () => {
  const { api, pool } = setup({ pool: optedIn() });
  const r = await api.sendOrderUpdate(order("W1790022222222"), "pos_created");
  assert.equal(r.ok, true);
  assert.equal(pool.msgs[0].body, "أهلاً عميلنا، استلمنا طلبك رقم W1790022222222 وتم الدفع بنجاح ✅\nالإجمالي: 65 ر.س\nنبلّغك هنا بكل تحديث على طلبك.");
}));

test("order stages: a stage that does not fit the order is not sent", withEnv(ON, async () => {
  const cases = [
    ["W1790022222222", "delivered", "pickup order must not get «تم توصيل طلبك»"],
    ["W1790022222222", "on_the_way", "pickup order has no courier"],
    ["W1790033333333", "delivered", "table order is served, not delivered"],
    ["W1790033333333", "pickup_ready", "table order is not collected from the counter"],
    ["W1790011111111", "pickup_ready", "delivery order is not «ready for pickup»"],
    ["W1790011111111", "rejected_refunded", "no refund id ⇒ never say the money was refunded"],
  ];
  for (const [no, stage, why] of cases) {
    const { api, fetch } = setup({ pool: optedIn() });
    const r = await api.sendOrderUpdate(order(no), stage);
    assert.equal(r.skipped, "stage_not_applicable", why);
    assert.equal(fetch.calls.length, 0, why);
  }
  // a stage with no template at all (courier_assigned, paid_pos_failed …) stays silent
  const { api, fetch } = setup({ pool: optedIn() });
  assert.equal((await api.sendOrderUpdate(order("W1790011111111"), "courier_assigned")).skipped, "no_template_for_stage");
  assert.equal(fetch.calls.length, 0);
}));

test("sendTemplate refuses an empty, «-», short, unsafe or missing parameter before any network call", withEnv(ON, async () => {
  const { api, pool, fetch } = setup({ pool: optedIn() });
  const bad = [
    ["fc_order_received", { body: ["محمد", "W1", ""], button: ["W1"] }],
    ["fc_order_received", { body: ["محمد", "W1"], button: ["W1"] }],
    ["fc_order_received", { body: ["محمد", "-", "86"], button: ["W1"] }],
    ["fc_order_received", { body: ["محمد", "W1", "86"], button: [""] }],
    ["fc_order_received", { body: ["محمد", "W1", "86"] }],
    ["fc_order_received", { body: ["محمد", "W1", "86"], button: ["W1?x=1#a"] }],
    ["fc_winback", W.TEMPLATES.fc_winback.bind({ name: "محمد", coupon: "WB1", linkSuffix: "w1-abc123" })],          // no dish
    ["fc_winback", W.TEMPLATES.fc_winback.bind({ name: "محمد", dish: "كفتة", linkSuffix: "w1-abc123" })],           // no coupon
    ["fc_offer_img", W.TEMPLATES.fc_offer_img.bind({ name: "محمد", offer: "بوكس التشكيلة بـ105 ريال", linkSuffix: "w1-abc123" })], // no image
    ["fc_otp", W.TEMPLATES.fc_otp.bind({})],
    ["fc_otp", W.TEMPLATES.fc_otp.bind({ code: "1234567890123456" })],
  ];
  for (const [name, params] of bad) {
    const r = await api.sendTemplate({ phoneNorm: PHONE, template: name, params });
    assert.equal(r.skipped, "missing_param", `${name} ${JSON.stringify(params)} → ${JSON.stringify(r)}`);
  }
  assert.equal(fetch.calls.length, 0);
  assert.ok(pool.msgs.every((m) => m.status === "skipped" && /^param:/.test(m.error)));
}));

test("OTP and the two campaign templates: exact text and parameters", withEnv(ON, async () => {
  const { api, pool, fetch } = setup({ pool: optedIn() });
  assert.equal((await api.sendTemplate({ phoneNorm: PHONE, template: "fc_otp", params: W.TEMPLATES.fc_otp.bind({ code: 4821 }) })).ok, true);
  const otp = fetch.calls[0].body.template;
  assert.deepEqual(otp.components.map((c) => [c.type, c.parameters[0].text]), [["body", "4821"], ["button", "4821"]]);
  const row = { vars: { first_name: "محمد", fav_dish: "كفتة مشوية" }, link_code: "a1b2c3", coupon: "WB4Q7M" };
  const job = { link_slug: "w12", image_url: "https://freshcuts-api.o2m8.me/api/content/media/9.jpg", cloud_vars: { offer: "بوكس التشكيلة بـ105 ريال" } };
  const a = CL.campaignParams("fc_winback", row, job);
  assert.equal(a.text, "اشتقنا لك يا محمد 🙌\nآخر مرة طلبت كفتة مشوية، وجهّزنا لك كود WB4Q7M على طلبك الجاي من موقعنا.\nالكود لك أنت بس ولفترة محدودة.");
  assert.equal(W.paramProblem("fc_winback", a.params), null);
  assert.deepEqual(a.params.button, ["w12-a1b2c3"]);
  const b = CL.campaignParams("fc_offer_img", row, job);
  assert.equal(b.text, "أهلاً محمد 👋\nبوكس التشكيلة بـ105 ريال\nاطلبه من موقع فريش كاتس للتوصيل أو الاستلام 🔥");
  assert.equal(W.paramProblem("fc_offer_img", b.params), null);
  assert.equal(pool.msgs.length, 1);
}));

test("notify: «جاهز» on a pickup order sends fc_order_ready_pickup; table and delivery orders do not", withEnv(ON, async () => {
  for (const [no, expectSend] of [["W1790022222222", true], ["W1790033333333", false]]) {
    const pool = optedIn();
    const orig = pool.query.bind(pool);
    pool.query = async (sql, p) => (/FROM shop_orders WHERE order_no/.test(String(sql)) && /phone_norm, option/.test(String(sql))
      ? { rows: [{ order_no: no, phone_norm: PHONE, option: ORDERS[no].option, total: ORDERS[no].total, table_no: ORDERS[no].table_no }] } : orig(sql, p));
    const { api, fetch } = setup({ pool });
    const notify = registerNotify(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => ({ notifications: { whatsappEnabled: true, whatsappStages: ["pickup_ready"], pushEnabled: false } }),
      jb: (x) => JSON.stringify(x), normPhone: (x) => x }, { wa: api, sendSms: async () => ({ ok: true }) });
    await notify.orderReady(no);
    await flush();
    assert.equal(fetch.calls.filter((c) => /\/messages$/.test(c.url)).length, expectSend ? 1 : 0, no);
    if (expectSend) assert.equal(fetch.calls[0].body.template.name, "fc_order_ready_pickup");
  }
}));

/* ── الكتالوج كله ─────────────────────────────────────────────────────── */
const sentinel = (path) => `S_${path.replace(/[^a-z]/gi, "")}`.slice(0, 40);
function setPath(obj, path, v) { const ks = path.split("."); let o = obj; ks.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; }); o[ks.at(-1)] = v; }

test("catalogue: variable i is filled from path i (no swap), in every language", () => {
  for (const t of C.TEMPLATES) {
    if (t.category === "AUTHENTICATION") continue;
    const data = {};
    for (const v of t.meta.vars) setPath(data, v.path, v.fmt === "money" ? 123.5 : sentinel(v.path));
    for (const b of t.meta.buttonVars) if (getPathOf(data, b.path) === undefined) setPath(data, b.path, "slug-abc123");
    const r = C.bindTemplate(t, data);
    assert.deepEqual(r.missing, [], C.templateKey(t));
    t.meta.vars.forEach((v, i) => {
      const want = v.fmt === "money" ? "123.50" : v.fmt === "firstName" ? sentinel(v.path) : sentinel(v.path);
      assert.equal(r.body[i], want, `${C.templateKey(t)} {{${i + 1}}} ← ${v.path}`);
    });
    assert.equal(r.body.length, new Set([...C.bodyOf(t).matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size, C.templateKey(t));
    // every missing path is reported, never an empty string sent
    for (const v of t.meta.vars) {
      if (v.fmt === "firstName") continue;   // falls back to «عميلنا»
      const d2 = JSON.parse(JSON.stringify(data)); setPath(d2, v.path, "");
      assert.ok(C.bindTemplate(t, d2).missing.includes(v.path), `${C.templateKey(t)}: empty ${v.path} must block the send`);
    }
  }
});
function getPathOf(obj, path) { return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj); }

test("catalogue: the label of each variable matches the words around it in the text", () => {
  // order number variables sit after «رقم» / "order"; money variables sit before «ر.س» / "SAR"
  for (const t of C.TEMPLATES) {
    if (t.category === "AUTHENTICATION") continue;
    const body = C.bodyOf(t);
    t.meta.vars.forEach((v, i) => {
      const n = `{{${i + 1}}}`;
      if (v.fmt === "money") assert.match(body, new RegExp(`${n.replace(/[{}]/g, "\\$&")} (ر\\.س|SAR)`), `${C.templateKey(t)}: ${n} is money`);
      if (/order_no$/.test(v.path)) assert.match(body, new RegExp(`(رقم|الطلب|جديد|order|Order|on order) ${n.replace(/[{}]/g, "\\$&")}`), `${C.templateKey(t)}: ${n} is the order number`);
      if (v.fmt === "firstName") assert.match(body, new RegExp(`(أهلاً|يا|مبروك|هلا|شكراً) ${n.replace(/[{}]/g, "\\$&")}`), `${C.templateKey(t)}: ${n} is a name`);
      if (/coupon\.code$|referral\.code$/.test(v.path)) assert.match(body, new RegExp(`(كود|كودك|بكود|كودك الخاص|خاص فيك|لمرة وحدة) ${n.replace(/[{}]/g, "\\$&")}`), `${C.templateKey(t)}: ${n} is a code`);
    });
  }
});

test("catalogue: all valid; marketing = tracked link + working opt-out; copy rules", () => {
  const EGY = /وحشتنا|وحشتني|دلوقتي|عايز|عاوز|بتاع|امبارح|إزاي|ازاي|كده|مفيش|\sمش\s|عشان كده|النهارده|بكام|لسه/;
  for (const t of C.TEMPLATES) {
    assert.deepEqual(C.validateTemplate(t), [], C.templateKey(t));
    const body = C.bodyOf(t);
    if (t.language === "ar" && t.meta.audience !== "staff") assert.doesNotMatch(body, EGY, `${t.name}: Egyptian wording`);
    assert.doesNotMatch(body, /أرخص من التطبيقات|ارخص من التطبيقات|ستيك/, t.name);
    assert.doesNotMatch(body, /\d+\s*(جرام|غرام|كيلو)|يكفي \d|\d+ (أشخاص|اشخاص)/, `${t.name}: no weights / serving counts in template text`);
    for (const b of C.buttonsOf(t)) {
      if (b.type !== "URL") continue;
      assert.match(b.url, /^https:\/\/(freshcuts\.sa\/|maps\.google\.com\/\?cid=14767749764292326433$|freshcuts-invite\.o2m8\.me\/)/, `${t.name}: button domain ${b.url}`);
    }
    if (t.category === "MARKETING") {
      /* FR1: القالب الإنجليزي بياخد كلمة الإيقاف الإنجليزي (STOP) — والاتنين الويب هوك بيفهمهم */
      const stopWord = t.language === "en" ? "STOP" : "إيقاف";
      assert.equal(C.footerOf(t), t.language === "en" ? "To stop, reply: STOP" : "للإيقاف ردّ: إيقاف", t.name);
      assert.ok(C.buttonsOf(t).some((b) => b.type === "QUICK_REPLY" && b.text === stopWord), t.name);
      assert.equal(W.intentOf(stopWord), "stop", "the quick reply text is an opt-out keyword the webhook understands");
    }
    if (t.category === "UTILITY") assert.equal(C.footerOf(t), "", `${t.name}: utility carries no marketing footer`);
  }
  // sample values quote only offers that exist today (free delivery, FIRST from 60) — no invented percentages
  for (const t of C.TEMPLATES) for (const v of t.meta.vars) {
    assert.doesNotMatch(String(v.example), /خصم|٪|%/, `${t.name}: sample «${v.example}»`);
    if (/min_total$/.test(v.path)) assert.equal(v.example, "60", `${t.name}: FIRST minimum sample`);
  }
});

test("every UTILITY order template for the customer has only the order's own tracking link as its button (Meta rejected a maps button as INCORRECT_CATEGORY)", () => {
  for (const t of C.TEMPLATES.filter((x) => x.category === "UTILITY" && x.meta.group === "order" && !C.HOLD[x.name])) {
    for (const b of C.buttonsOf(t)) {
      if (b.type !== "URL") continue;
      assert.match(b.url, /^https:\/\/freshcuts\.sa\/(track\/\{\{1\}\}|r\?c=\{\{1\}\})$/, `${t.name}: ${b.url}`);
    }
  }
  const p = C.findTemplate("fc_order_ready_pickup");
  assert.deepEqual(C.buttonsOf(p), [{ type: "URL", text: "تفاصيل الطلب", url: "https://freshcuts.sa/track/{{1}}", example: ["https://freshcuts.sa/track/W1790012345678"] }]);
  assert.doesNotMatch(C.bodyOf(p), /تقدر|موقع|خرائط|خريطة|فرع|حي |جدة/);   // رفض ميتا التاني: جملة الفرع والحي
});

test("fc_winback_45 is byte-identical to what Meta approved on 12/10", () => {
  const t = C.findTemplate("fc_winback_45");
  assert.equal(C.bodyOf(t), "اشتقنا لك يا {{1}} 🙌\nجهّزنا لك {{2}} على طلبك الجاي من موقع فريش كاتس بكود {{3}}، والكود صالح لين {{4}} لا يفوتك.");
  assert.deepEqual(C.buttonsOf(t), [{ type: "URL", text: "اطلب بالكود", url: "https://freshcuts.sa/?c={{1}}", example: ["https://freshcuts.sa/?c=WB-4Q7M"] }, { type: "QUICK_REPLY", text: "إيقاف" }]);
  assert.equal(C.footerOf(t), "للإيقاف ردّ: إيقاف");
});

test("the eight names that lived in both files now carry one wording (the catalogue's)", () => {
  for (const n of ["fc_order_received", "fc_order_preparing", "fc_order_ready_pickup", "fc_order_on_the_way", "fc_order_delivered", "fc_order_refunded", "fc_refund_in_progress", "fc_otp"]) {
    assert.deepEqual(W.templateSubmission(n), C.submissionBody(C.findTemplate(n)), n);
    assert.equal(W.isCatalogTemplate(n), false, `${n} stays a built-in (keeps its stage wiring)`);
  }
  const r = W.registerCatalog(C);
  assert.equal(r.skipped.length, 8);
});

test("submit: held and retired templates are refused; batches cover every other template exactly once", withEnv({ WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "P", WHATSAPP_WABA_ID: "WABA", WHATSAPP_TEMPLATES_WRITE: "1" }, async () => {
  W.registerCatalog(C);
  const names = [...new Set(C.TEMPLATES.map((t) => t.name))];
  const flat = C.SUBMIT_BATCHES.flat();
  assert.equal(new Set(flat).size, flat.length, "no template in two batches");
  assert.deepEqual([...flat, ...Object.keys(C.HOLD), "fc_winback_45"].sort(), names.slice().sort());
  for (const n of Object.keys(C.HOLD)) assert.ok(C.HOLD[n].length > 10, n);
  const { app, fetch } = setup();
  const submit = app.routes["POST /api/wa/templates/submit"];
  for (const n of [...Object.keys(C.HOLD), "fc_cart_reminder"]) {
    const r = await submit(ctxOf({ names: [n] }));
    assert.equal(r.body.results[0].error, "held", n);
  }
  assert.equal(fetch.calls.length, 0, "nothing reached Meta");
  const ok = await submit(ctxOf({ names: ["fc_cart_1h"] }));
  assert.equal(ok.body.results[0].ok, true);
  assert.equal(fetch.calls[0].body.name, "fc_cart_1h");
  assert.match(fetch.calls[0].url, /\/WABA\/message_templates$/);
}));

test("submit {edit:true}: a rejected template is edited in place by its id at Meta (components only), not re-created", withEnv({ WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "P", WHATSAPP_WABA_ID: "WABA", WHATSAPP_TEMPLATES_WRITE: "1" }, async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET") return { ok: true, status: 200, json: async () => ({ data: [{ id: "777", name: "fc_order_ready_pickup", language: "ar", status: "REJECTED" }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const { app } = setup({ fetch });
  const r = await app.routes["POST /api/wa/templates/submit"](ctxOf({ names: ["fc_order_ready_pickup"], edit: true }));
  assert.deepEqual(r.body.results, [{ name: "fc_order_ready_pickup", ok: true, edited: true, id: "777", was: "REJECTED" }]);
  assert.match(calls[0].url, /\/WABA\/message_templates\?name=fc_order_ready_pickup&fields=/);
  assert.match(calls[1].url, /\/v23\.0\/777$/); assert.equal(calls[1].method, "POST");
  assert.deepEqual(Object.keys(calls[1].body), ["components"]);
  assert.equal(calls[1].body.components.find((c) => c.type === "BUTTONS").buttons[0].url, "https://freshcuts.sa/track/{{1}}");
  // a name Meta does not have is not created by an edit request
  const none = async (url, init) => ({ ok: true, status: 200, json: async () => (init.method === "GET" ? { data: [] } : { success: true }) });
  const r2 = await setup({ fetch: none }).app.routes["POST /api/wa/templates/submit"](ctxOf({ names: ["fc_cart_1h"], edit: true }));
  assert.equal(r2.body.results[0].error, "not_at_meta");
}));

test("allow-list test send: only the listed phones, without any customer switch", withEnv({ WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" }, async () => {
  // WHATSAPP_ENABLED is NOT set and the dashboard switch is off
  const { api, fetch } = setup({ settings: { notifications: {}, waBot: { testPhones: ["0544775082", "0561186075"] } } });
  const params = W.TEMPLATES.fc_order_preparing.bind({ order_no: "W1790011111111" });
  assert.equal((await api.sendTemplate({ phoneNorm: "544775082", template: "fc_order_preparing", params })).skipped, "disabled", "normal path stays locked");
  assert.equal((await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params, allowList: ["544775082", "561186075"] })).skipped, "not_in_allow_list");
  assert.equal((await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params, allowList: [] })).skipped, "not_in_allow_list");
  assert.equal(fetch.calls.length, 0);
  const r = await api.sendTemplate({ phoneNorm: "544775082", template: "fc_order_preparing", params, allowList: ["544775082", "561186075"] });
  assert.equal(r.ok, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.to, "966544775082");
}));


/* ── ١٢/١٠ «خدمي ولا تسويقي» ─────────────────────────────────────────────
   النسخ الخدمية الجديدة: نص نهائي حرفي ببيانات واقعية، ولا كلمة ترويج، ولا زر غير رابط الطلب نفسه. */
const render = (name, data, lang = "ar") => {
  const t = C.findTemplate(name, lang);
  const r = C.bindTemplate(t, data);
  assert.deepEqual(r.missing, [], name);
  return { t, text: C.bodyOf(t).replace(/\{\{(\d+)\}\}/g, (m, n) => r.body[Number(n) - 1]), buttons: r.buttons.map((b) => b.text) };
};
test("utility versions render their exact final text with realistic data, no empty variable", () => {
  const order = { order_no: "W1790011111111" };
  assert.equal(render("fc_loyalty_status", { order, loyalty: { progress: 2, every: 3, statusText: "باقي طلب واحد" } }).text,
    "تم احتساب طلبك رقم W1790011111111 في برنامج ولاء فريش كاتس ✅\nرصيدك من الطلبات الآن 2 من 3: باقي طلب واحد.\nالتفاصيل في صفحة الطلب.");
  assert.deepEqual(render("fc_loyalty_status", { order, loyalty: { progress: 1, every: 3, statusText: "باقي طلبين" } }).buttons, ["W1790011111111"]);
  assert.equal(render("fc_feedback_received", { order }).text,
    "شكراً على ملاحظتك بخصوص طلبك رقم W1790011111111 🙏\nوصلت ملاحظتك للفريق وراجعناها، ولو احتجنا تفاصيل أكثر نتواصل معك على هذا الرقم.");
  assert.equal(render("fc_payment_failed", { order }).text,
    "ما اكتملت عملية الدفع لطلبك رقم W1790011111111 من فريش كاتس، والطلب ما تأكّد.\nلو ظهر مبلغ معلّق في حسابك يرجع تلقائياً حسب إجراءات البنك، ولأي استفسار ردّ على هذي الرسالة.");
  assert.equal(render("fc_open_notice", { waitlist: { ref: "N-1042", requestedText: "يوم 12/10 الساعة 4:35 ص" }, hours: { closeText: "2:00 ص" } }).text,
    "تنبيه الفتح رقم N-1042 المسجَّل يوم 12/10 الساعة 4:35 ص 🔔\nطلبت منّا تنبيهك عند فتح المطعم: فريش كاتس مفتوح الآن ويستقبل الطلبات حتى الساعة 2:00 ص.");
  assert.equal(render("fc_staff_payment_alert", { watch: { problem: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة", lastOrderAgo: "قبل ٩٥ دقيقة" } }).text,
    "تنبيه تشغيلي في نظام طلبات فريش كاتس: ٣ محاولات دفع فشلت خلال ٢٠ دقيقة. آخر طلب مدفوع على النظام: قبل ٩٥ دقيقة. تابع من البورتال.");
  assert.equal(render("fc_staff_day_report", { day: { label: "11 Oct", orders: 14, sales: 1240, rating: "4.6" } }, "en").text,
    "End-of-day operations report for 11 Oct: 14 online orders handled, 1240 SAR collected, average customer rating 4.6. The full report is in the dashboard.");
  // a zero balance or a missing number never goes out as an empty variable
  for (const bad of [{ order, loyalty: { every: 3, statusText: "باقي طلبين" } }, { order: {}, loyalty: { progress: 1, every: 3, statusText: "باقي طلبين" } }, { order, loyalty: { progress: 1, every: 3 } }]) {
    assert.ok(C.bindTemplate(C.findTemplate("fc_loyalty_status"), bad).missing.length > 0);
  }
  assert.ok(C.bindTemplate(C.findTemplate("fc_open_notice"), { waitlist: { ref: "N-1" }, hours: {} }).missing.includes("hours.closeText"));
});

test("utility versions carry nothing promotional: no offer words, no order push, no cart or landing link, no opt-out footer", () => {
  const PROMO = /اطلب|جرّب|كمّل|سلتك|سلة|هدية|مكافأ|توصيل مجاني|كود|عرض|خصم|order now|offer|discount|coupon|test the website/i;
  const names = ["fc_loyalty_status", "fc_feedback_received", "fc_payment_failed", "fc_open_notice", "fc_welcome_account", "fc_staff_payment_alert", "fc_staff_day_report"];
  for (const n of names) for (const t of C.TEMPLATES.filter((x) => x.name === n)) {
    assert.equal(t.category, "UTILITY", n);
    assert.doesNotMatch(C.bodyOf(t), PROMO, `${C.templateKey(t)}: promotional wording`);
    assert.equal(C.footerOf(t), "", n);
    for (const b of C.buttonsOf(t)) {
      assert.equal(b.type, "URL", `${n}: no quick replies`);
      assert.match(b.url, /^https:\/\/(freshcuts\.sa\/track\/\{\{1\}\}|freshcuts-invite\.o2m8\.me\/(portal\/|#store))$/, `${n}: ${b.url}`);
    }
  }
  assert.deepEqual(C.buttonsOf(C.findTemplate("fc_payment_failed")), [], "no «كمّل الدفع» cart link: that is a cart reminder");
  assert.deepEqual(C.buttonsOf(C.findTemplate("fc_welcome_account")), [], "no «فتح الموقع» button");
  assert.deepEqual(C.buttonsOf(C.findTemplate("fc_open_notice")), []);
});

test("each utility version keeps its marketing twin: the promotional wording is still there for consenting customers", () => {
  for (const [util, mkt] of [["fc_loyalty_status", "fc_loyalty_progress"], ["fc_open_notice", "fc_waitlist_open"], ["fc_feedback_received", "fc_review_thanks_coupon"]]) {
    assert.equal(C.findTemplate(util).category, "UTILITY");
    assert.equal(C.findTemplate(util).meta.pairedWith, mkt);
    assert.equal(C.findTemplate(mkt).category, "MARKETING", mkt);
  }
  // approved marketing texts are not touched by this slice (an edit would send them back to review)
  assert.equal(C.bodyOf(C.findTemplate("fc_loyalty_progress")), "باقي لك {{1}} وتحصل على {{2}} 🎁\nكل طلب من موقع فريش كاتس يقرّبك من مكافأتك.");
  assert.equal(C.bodyOf(C.findTemplate("fc_waitlist_open")), "فتحنا الحين 🎉\nطلبت منّا نذكّرك أول ما يفتح المطعم، وسلتك محفوظة مثل ما تركتها.");
  assert.equal(C.bodyOf(C.findTemplate("fc_loyalty_reward")), "مبروك {{1}} 🎉 وصلت لمكافأتك في فريش كاتس: {{2}}.\nكودك الخاص {{3}} صالح لين {{4}}، استخدمه في طلبك الجاي من الموقع.");
});

test("templates Meta filed as MARKETING are billed as marketing and are wired to no sender", () => {
  assert.deepEqual(Object.keys(C.META_CATEGORY).sort(), ["fc_staff_checkout_watchdog:ar", "fc_staff_checkout_watchdog:en", "fc_staff_daily_summary:ar"]);
  for (const key of Object.keys(C.META_CATEGORY)) {
    const [name, lang] = key.split(":");
    const t = C.findTemplate(name, lang);
    assert.ok(t, key);
    assert.equal(C.billedCategory(t), "MARKETING");
    assert.ok(!Object.values(W.STAGE_TEMPLATES).includes(name), `${name} must not be sent by an order stage`);
  }
  assert.equal(C.billedCategory(C.findTemplate("fc_staff_daily_summary", "en")), "UTILITY");
  assert.equal(C.billedCategory(C.findTemplate("fc_order_received")), "UTILITY");
  assert.equal(C.billedCategory(C.findTemplate("fc_cart_1h")), "MARKETING");
  // the reworded replacements exist in both languages and are not the old names
  for (const n of ["fc_staff_payment_alert", "fc_staff_day_report"]) assert.equal(C.TEMPLATES.filter((t) => t.name === n).length, 2, n);
});
