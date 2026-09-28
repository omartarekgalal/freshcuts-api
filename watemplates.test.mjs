/* كتالوج قوالب واتساب — كل قالب لازم يعدّي قواعد ميتا قبل ما نقدّمه (٢٨/٩). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATES, RECOMMENDED_FIRST, OPTOUT_FOOTER, OPTOUT_BUTTON, validateTemplate, bindTemplate, previewText,
  submissionBody, summary, cleanParam, bodyOf, buttonsOf, footerOf, findTemplate, templateKey,
} from "./watemplates.js";

test("كل القوالب صالحة حسب قواعد ميتا", () => {
  for (const t of TEMPLATES) assert.deepEqual(validateTemplate(t), [], templateKey(t));
  assert.equal(summary().invalid.length, 0);
});

test("الأسماء + اللغة فريدة، والعدد يغطي كل الأقسام", () => {
  const keys = TEMPLATES.map(templateKey);
  assert.equal(new Set(keys).size, keys.length);
  const s = summary();
  assert.ok(s.total >= 50, `total ${s.total}`);
  assert.ok(s.byCategory.UTILITY >= 25 && s.byCategory.MARKETING >= 20 && s.byCategory.AUTHENTICATION === 1, JSON.stringify(s.byCategory));
  for (const g of ["order", "account", "staff", "marketing", "ads"]) assert.ok(s.byGroup[g] > 0, g);
});

test("المطلوب بالاسم موجود", () => {
  const need = ["fc_order_received", "fc_payment_received", "fc_order_preparing", "fc_order_ready_pickup", "fc_courier_assigned",
    "fc_order_on_the_way", "fc_order_delivered", "fc_review_request", "fc_order_delayed", "fc_order_refunded", "fc_order_cancelled",
    "fc_payment_failed", "fc_otp", "fc_address_confirm", "fc_scheduled_reminder", "fc_waitlist_open", "fc_welcome_account",
    "fc_loyalty_progress", "fc_loyalty_reward", "fc_coupon_expiring", "fc_staff_new_order", "fc_staff_sla_alert", "fc_staff_courier_issue",
    "fc_staff_pos_failed", "fc_staff_daily_summary", "fc_staff_low_rating", "fc_staff_checkout_watchdog", "fc_welcome_offer",
    "fc_winback_21", "fc_winback_45", "fc_winback_90", "fc_vip_lapsed", "fc_fav_dish", "fc_new_item", "fc_weekend_offer",
    "fc_bundle_offer", "fc_cart_1h", "fc_cart_24h", "fc_birthday", "fc_occasion", "fc_review_thanks_coupon", "fc_referral_invite",
    "fc_try_website", "fc_one_time_coupon", "fc_ad_lead_followup", "fc_ad_lead_last_call"];
  for (const n of need) assert.ok(TEMPLATES.some((t) => t.name === n), n);
});

test("كل قالب تسويقي: فوتر «للإيقاف ردّ: إيقاف» + زر «إيقاف»", () => {
  for (const t of TEMPLATES.filter((x) => x.category === "MARKETING")) {
    assert.equal(footerOf(t), OPTOUT_FOOTER, t.name);
    assert.ok(buttonsOf(t).some((b) => b.type === "QUICK_REPLY" && b.text === OPTOUT_BUTTON), t.name);
  }
});

test("التشغيلي ما فيه ترويج — وإلا ميتا تصنّفه تسويق", () => {
  for (const t of TEMPLATES.filter((x) => x.category === "UTILITY")) {
    assert.ok(!/(^|[\s،.])(خصم|كود|كوبون|عرض|عروض|مجاني)|٪|%/.test(bodyOf(t)), `${t.name}: ${bodyOf(t)}`);
  }
});

test("قوالب الفريق بلغتين (en افتراضي + ar)", () => {
  const staff = TEMPLATES.filter((t) => t.meta.group === "staff");
  const names = [...new Set(staff.map((t) => t.name))];
  assert.ok(names.length >= 8);
  for (const n of names) {
    assert.ok(findTemplate(n, "en") && findTemplate(n, "ar"), n);
    assert.ok(!/[؀-ۿ]/.test(bodyOf(findTemplate(n, "en"))), `${n} en فيه عربي`);
    assert.equal(findTemplate(n, "en").category, "UTILITY");
  }
});

test("زر الرابط الديناميكي: {{1}} آخر الرابط ومثال كامل", () => {
  for (const t of TEMPLATES) for (const b of buttonsOf(t)) {
    if (b.type !== "URL" || !b.url.includes("{{1}}")) continue;
    assert.ok(b.url.endsWith("{{1}}"), `${t.name} ${b.url}`);
    assert.ok(/^https:\/\/[^{}]+$/.test(b.example[0]), `${t.name} ${b.example}`);
    assert.ok(b.example[0].startsWith(b.url.replace("{{1}}", "")), t.name);
  }
});

test("الجسم ما يبدأ/ينتهي بمتغيّر، والأمثلة بعدد المتغيّرات", () => {
  for (const t of TEMPLATES.filter((x) => x.category !== "AUTHENTICATION")) {
    const b = bodyOf(t);
    assert.ok(!/^\s*\{\{/.test(b) && !/\}\}\s*$/.test(b), t.name);
    const n = new Set([...b.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
    assert.equal(t.meta.vars.length, n, t.name);
  }
});

test("قالب الرمز = قالب تحقق ميتا الرسمي (نسخ الرمز + تحذير + صلاحية)", () => {
  const t = findTemplate("fc_otp");
  assert.equal(t.category, "AUTHENTICATION");
  assert.deepEqual(t.components.map((c) => c.type), ["BODY", "FOOTER", "BUTTONS"]);
  assert.equal(buttonsOf(t)[0].otp_type, "COPY_CODE");
  assert.deepEqual(bindTemplate(t, { otp: { code: "4821" } }), { body: ["4821"], buttons: [{ index: 0, sub_type: "url", text: "4821" }], missing: [] });
});

test("قوالب الصورة معلّمة «تحتاج رفع»", () => {
  const imgs = TEMPLATES.filter((t) => t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE"));
  assert.ok(imgs.length >= 3);
  for (const t of imgs) assert.equal(t.meta.needsUpload, true, t.name);
  assert.deepEqual(summary().needsUpload.sort(), imgs.map((t) => t.name).sort());
});

test("bindTemplate: المسارات + التنسيق + سطر جديد يتنظّف + الناقص يتبلّغ", () => {
  const t = findTemplate("fc_order_received");
  const r = bindTemplate(t, { order: { order_no: "W1790000000001", total: 86.5 }, customer: { name: "محمد أحمد" } });
  assert.deepEqual(r.body, ["محمد", "W1790000000001", "86.50"]);
  assert.deepEqual(r.buttons, [{ index: 0, sub_type: "url", text: "W1790000000001" }]);
  assert.deepEqual(r.missing, []);
  // الاسم الغريب ⇒ «عميلنا» — والعنوان بسطرين يصير سطر واحد
  assert.equal(bindTemplate(t, { order: { order_no: "W1", total: 10 }, customer: { name: "x" } }).body[0], "عميلنا");
  const a = bindTemplate(findTemplate("fc_address_confirm"), { order: { order_no: "W1", addressText: "حي الصفا\nعمارة 3\t\tالدور 2" } });
  assert.ok(!/[\n\t]/.test(a.body[1]));
  const miss = bindTemplate(findTemplate("fc_cart_1h"), {});
  assert.deepEqual(miss.missing, ["cart.code"]);
  assert.equal(cleanParam("a\n\nb     c"), "a - b   c");
});

test("المعاينة ما تترك {{n}} والنص سعودي مو مصري", () => {
  for (const t of TEMPLATES) {
    const p = previewText(t);
    if (t.category !== "AUTHENTICATION") assert.ok(!/\{\{\d+\}\}/.test(p), `${t.name}: ${p}`);
    if (t.language === "ar") assert.ok(!/دلوقتي|عايز|عاوز|ازاي|إزاي|كده|بتاع|امبارح|النهاردة|خالص|أوي|(^|\s)مش(\s|$)|(^|\s)ده(\s|$)|(^|\s)دي(\s|$)/.test(p), `${t.name}: ${p}`);
    assert.ok(!/ستيك|steak|أرخص من التطبيقات/i.test(p), t.name);
  }
});

test("كل قالب له بيانات: الغرض والمُطلق وطريقة الإرسال وبديل SMS (أو null صريح)", () => {
  for (const t of TEMPLATES) {
    assert.ok(t.meta.purpose && t.meta.trigger, t.name);
    assert.ok(["auto", "auto-candidate", "manual"].includes(t.meta.send), t.name);
    assert.ok("fallbackSms" in t.meta, `${t.name}: fallbackSms`);
    for (const v of t.meta.vars) assert.ok(v.path && v.example, `${t.name} {{${v.n}}}`);
  }
});

test("أول ٨ للتقديم موجودين وصالحين", () => {
  assert.equal(RECOMMENDED_FIRST.length, 8);
  for (const n of RECOMMENDED_FIRST) {
    const t = findTemplate(n, n.startsWith("fc_staff") ? "en" : "ar");
    assert.ok(t, n);
    assert.deepEqual(validateTemplate(t), []);
  }
});

test("submissionBody = شكل ميتا بالضبط (بدون بياناتنا)", () => {
  const b = submissionBody(findTemplate("fc_welcome_offer"));
  assert.deepEqual(Object.keys(b), ["name", "language", "category", "components"]);
  assert.equal(JSON.stringify(b).includes("purpose"), false);
});
