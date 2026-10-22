/* CC1 (٢٣/١٠ — عمر: «الكود يكون bold ويكون قابل للنسخ بسهولة»): قالب fc_offer_code_copy — صورة + الكود عريض في سطر لوحده
   + زر ميتا «نسخ الكود» بكوبون كل مستلم + زر الرابط المتتبّع. node --test cc1-copy-code.test.mjs — مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);

const NAME = "fc_offer_code_copy";
const IMG = "https://freshcuts-api.o2m8.me/api/content/media/md_8763a320ca72.jpg";
const OFFER = { oneTime: true, percent: 10, freeDelivery: false, validDays: 7, minTotal: 60 };
const VALUES = { "offer.line": "اشتقنا لك، وجهّزنا لك خصم 10٪ على طلبك الجاي", "coupon.expiresText": "الخميس 29 أكتوبر" };
const JOB = { link_slug: "wk22-back10", image_url: IMG, cloud_vars: { values: VALUES }, offer: OFFER };

test("الكتالوج: القالب صالح لقواعد ميتا — صورة، الكود بين نجمتين في سطر لوحده، زر نسخ + رابط متتبّع، فوتر الإيقاف، ومن غير زر إيقاف", () => {
  const t = CAT.findTemplate(NAME, "ar");
  assert.ok(t);
  assert.deepEqual(CAT.validateTemplate(t), []);
  assert.equal(t.category, "MARKETING");
  assert.equal(CAT.findTemplate(NAME, "en"), null);      // عربي بس
  const body = CAT.bodyOf(t);
  assert.match(body, /\nكود الخصم الخاص فيك: \*\{\{3\}\}\*\n/);
  const sub = CAT.submissionBody(t);
  assert.equal(sub.components[0].format, "IMAGE");
  const btns = CAT.buttonsOf(t);
  assert.deepEqual(btns.map((b) => b.type), ["COPY_CODE", "URL"]);
  assert.deepEqual(btns[0], { type: "COPY_CODE", example: "W712K7Q9M" });
  assert.equal(btns[1].url, "https://freshcuts.sa/l/{{1}}");
  assert.equal(CAT.footerOf(t), CAT.OPTOUT_FOOTER);
  assert.ok(!btns.some((b) => b.type === "QUICK_REPLY"));
  assert.deepEqual(t.meta.copyVar, { path: "coupon.code", example: "W712K7Q9M" });
  // المسجّل في whatsapp.js هو نفس الجسم اللي بيتقدّم
  assert.deepEqual(W.templateSubmission(NAME).components, t.components);
});

test("الفحص: زر نسخ الكود واحد بس، تسويق بس، ومثاله حروف وأرقام ≤15", () => {
  const t = CAT.findTemplate(NAME, "ar");
  const withBtns = (buttons, extra = {}) => ({ ...t, ...extra, components: t.components.map((c) => (c.type === "BUTTONS" ? { ...c, buttons } : c)) });
  const [cp, url] = CAT.buttonsOf(t);
  assert.ok(CAT.validateTemplate(withBtns([cp, cp, url])).some((e) => /واحد بس/.test(e)));
  assert.ok(CAT.validateTemplate(withBtns([{ type: "COPY_CODE", example: "WB-4Q7M" }, url])).some((e) => /المثال/.test(e)));
  assert.ok(CAT.validateTemplate(withBtns([{ type: "COPY_CODE", example: "A".repeat(16) }, url])).some((e) => /المثال/.test(e)));
  assert.ok(CAT.validateTemplate({ ...t, category: "UTILITY" }).some((e) => /لقوالب التسويق/.test(e)));
});

test("مواصفات الحملة: كتالوج بصورة ورابط، محتاج كوبون مرة واحدة، الخانات اللي بتتكتب = العرض وآخر يوم بس", () => {
  const s = C.campaignSpec(NAME);
  assert.ok(C.campaignTemplateNames().includes(NAME));
  assert.deepEqual([s.kind, s.header, s.button, s.needsCoupon, s.copyCode], ["catalog", "image", "link", true, true]);
  assert.deepEqual(s.fields.map((f) => f.key), ["offer.line", "coupon.expiresText"]);
  assert.deepEqual(s.auto.sort(), ["coupon", "couponMin", "name"]);
  assert.equal(s.held, false);
});

test("باراميترات المستلم: الكود في الجسم وفي زر النسخ، الرابط /l/<slug>-<code>، الحد الأدنى من كوبون الحملة، والصورة", () => {
  const r = C.campaignParams(NAME, { name: "محمد علي", link_code: "ab12cd", coupon: "W712K7Q9M" }, JOB);
  assert.deepEqual(r.params.body, ["محمد", VALUES["offer.line"], "W712K7Q9M", "الخميس 29 أكتوبر", "60"]);
  assert.equal(r.params.copyCode, "W712K7Q9M");
  assert.deepEqual(r.params.button, ["wk22-back10-ab12cd"]);
  assert.deepEqual(r.params.header, { image: IMG });
  assert.deepEqual(r.params.missing, []);
  assert.equal(W.paramProblem(NAME, r.params), null);
  assert.match(r.text, /كود الخصم الخاص فيك: \*W712K7Q9M\*\nصالح لين الخميس 29 أكتوبر .* من 60 ر\.س\./);
  const pay = W.buildTemplatePayload(NAME, "966512345678", r.params);
  const comps = pay.template.components;
  assert.deepEqual(comps[0], { type: "header", parameters: [{ type: "image", image: { link: IMG } }] });
  assert.equal(comps[1].parameters[2].text, "W712K7Q9M");
  assert.deepEqual(comps.filter((c) => c.type === "button"), [
    { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "wk22-back10-ab12cd" }] },
    { type: "button", sub_type: "copy_code", index: "0", parameters: [{ type: "coupon_code", coupon_code: "W712K7Q9M" }] },
  ]);
});

test("من غير كوبون (المحجوز/صف قديم) أو كود فيه رموز ⇒ الحارس مابيبعتش", () => {
  const none = C.campaignParams(NAME, { name: "س", link_code: "x1y2z3", coupon: null }, JOB);
  assert.match(W.paramProblem(NAME, none.params), /^missing:/);
  const bad = C.campaignParams(NAME, { name: "س", link_code: "x1y2z3", coupon: "WB-4Q7M" }, JOB);
  assert.match(W.paramProblem(NAME, bad.params), /^missing:.*copy:coupon\.code/);
  // من غير missing (باراميترات متجمّعة بالإيد) ⇒ نفس الحارس بيمسك الكود الناقص
  assert.equal(W.paramProblem(NAME, { ...bad.params, missing: [], copyCode: "" }), "missing_copy_code");
  // حملة من غير حد أدنى في الكوبون ⇒ «من  ر.س» مابتطلعش
  const noMin = C.campaignParams(NAME, { name: "س", link_code: "x1y2z3", coupon: "W712K7Q9M" }, { ...JOB, offer: { ...OFFER, minTotal: 0 } });
  assert.match(W.paramProblem(NAME, noMin.params), /coupon\.minTotal/);
});

test("فحص الحملة قبل ما تتعمل: كوبون مرة واحدة مطلوب، والحد الأدنى، والصورة، والخانتين", () => {
  const P = (x) => (C.cloudJobProblem(x) || [null])[0];
  const base = { cloudTemplate: NAME, imageUrl: IMG, cloudVars: { values: VALUES }, offer: OFFER, link: {} };
  assert.equal(P(base), null);
  assert.equal(P({ ...base, imageUrl: null }), "image_required");
  assert.equal(P({ ...base, offer: null }), "coupon_required");
  assert.equal(P({ ...base, offer: null, link: { coupon: "FIRST" } }), "coupon_required");      // كوبون ثابت مايملاش زر النسخ لكل مستلم
  assert.equal(P({ ...base, offer: { ...OFFER, minTotal: 0 } }), "min_total_required");
  assert.equal(P({ ...base, cloudVars: { values: { "offer.line": "خصم" } } }), "value_required");
});

test("مطابقة القالب مع ميتا: نص زر النسخ اللي ميتا بتحطه مايعتبرش اختلاف", () => {
  const t = CAT.findTemplate(NAME, "ar");
  const theirs = t.components.map((c) => (c.type === "BUTTONS" ? { ...c, buttons: [{ type: "COPY_CODE", text: "Copy offer code" }, c.buttons[1]] }
    : c.type === "HEADER" ? { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/x"] } } : c));
  assert.deepEqual(C.templateDiff(t.components, theirs), []);
  const noCopy = theirs.map((c) => (c.type === "BUTTONS" ? { ...c, buttons: [c.buttons[1]] } : c));
  assert.deepEqual(C.templateDiff(t.components, noCopy), ["buttons"]);
});

test("القوالب القديمة ماتغيّرتش: مفيش copyCode في باراميتراتها ولا زر نسخ في رسالتها", () => {
  const r = C.campaignParams("fc_weekend_offer", { name: "محمد", link_code: "ab12cd" },
    { link_slug: "w9", image_url: IMG, cloud_vars: { values: { "offer.title": "باقة", "offer.price": "225", "offer.untilText": "السبت" } } });
  assert.equal("copyCode" in r.params, false);
  assert.ok(!W.buildTemplatePayload("fc_weekend_offer", "966512345678", r.params).template.components.some((c) => c.sub_type === "copy_code"));
  const v = CAT.bindTemplate(CAT.findTemplate("fc_vip_lapsed"), { customer: { name: "س" }, coupon: { code: "W1ABCDE", benefitText: "خصم", expiresText: "الخميس" }, link: { suffix: "a-b" } });
  assert.equal("copyCode" in v, false);
  for (const t of CAT.TEMPLATES) assert.ok(CAT.buttonsOf(t).filter((b) => b.type === "COPY_CODE").length === (t.name === NAME ? 1 : 0), t.name);
});
