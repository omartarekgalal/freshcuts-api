import { test } from "node:test";
import assert from "node:assert/strict";
import { senderCfg, pacing, inWindow, withFooter, MIN_GAP_DAYS } from "./wasender.js";

// ٢٦/٩ ٥ العصر الرياض = ١٤:٠٠ UTC (يوم سبت)
const AT_17 = Date.parse("2026-09-26T14:00:00Z");
const AT_03 = Date.parse("2026-09-26T00:00:00Z"); // ٣ الفجر الرياض
const on = (x = {}) => senderCfg({ waSender: { enabled: true, ...x } });
const idle = { today: 0, lastHour: 0, failStreak: 0, sinceBreak: 0, lastSentAt: null };

test("قاعدة عمر: الفاصل لكل رقم مابيقلّش عن ٣ أيام أبداً", () => {
  assert.equal(MIN_GAP_DAYS, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 1 } }).gapDays, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 0 } }).gapDays, 3);
  assert.equal(senderCfg({ waSender: { gapDays: 7 } }).gapDays, 7);
  assert.equal(senderCfg({}).gapDays, 3);
});

test("مقفول افتراضياً", () => {
  assert.equal(senderCfg({}).enabled, false);
  assert.equal(pacing(senderCfg({}), idle, AT_17).reason, "disabled");
});

test("ساعات الإرسال بتوقيت الرياض", () => {
  assert.equal(inWindow(on(), AT_17), true);
  assert.equal(inWindow(on(), AT_03), false);
  assert.equal(pacing(on(), idle, AT_03).reason, "outside_hours");
  assert.equal(inWindow(on({ days: ["fri"] }), AT_17), false); // السبت مش في الأيام
  assert.equal(inWindow(on({ startHour: 20, endHour: 2 }), AT_03 - 2 * 3600e3), true); // ١ الفجر
});

test("السقف اليومي وسقف الساعة وإيقاف الفشل", () => {
  assert.equal(pacing(on({ dailyCap: 40 }), { ...idle, today: 40 }, AT_17).reason, "daily_cap");
  assert.equal(pacing(on({ hourCap: 15 }), { ...idle, lastHour: 15 }, AT_17).reason, "hour_cap");
  const f = pacing(on({ failStop: 3 }), { ...idle, failStreak: 3 }, AT_17);
  assert.equal(f.reason, "fail_stop"); assert.equal(f.wait, null);
});

test("الفاصل العشوائي بين رسالتين + استراحة بعد الدفعة", () => {
  const cfg = on({ minDelaySec: 60, maxDelaySec: 120, batchSize: 10, batchPauseMin: 12 });
  const ok = pacing(cfg, idle, AT_17, () => 0.5);
  assert.equal(ok.wait, 0); assert.equal(ok.nextGapSec, 90);
  const early = pacing(cfg, { ...idle, lastSentAt: new Date(AT_17 - 30e3).toISOString(), nextGapSec: 90, sinceBreak: 3 }, AT_17);
  assert.equal(early.reason, "delay"); assert.equal(early.wait, 60);
  const brk = pacing(cfg, { ...idle, lastSentAt: new Date(AT_17 - 100e3).toISOString(), nextGapSec: 90, sinceBreak: 10 }, AT_17);
  assert.equal(brk.reason, "batch_pause"); assert.equal(brk.wait, 12 * 60 - 100);
});

test("الحدود بتتظبط لو اتكتبت غلط", () => {
  const c = senderCfg({ waSender: { minDelaySec: 5, maxDelaySec: 1, dailyCap: 99999 } });
  assert.equal(c.minDelaySec, 20); assert.equal(c.maxDelaySec, 20); assert.equal(c.dailyCap, 300);
});

test("سطر آخر الرسالة", () => {
  assert.equal(withFooter("أهلاً", ""), "أهلاً");
  assert.equal(withFooter("أهلاً", "للإيقاف ردّ: إيقاف"), "أهلاً\n\nللإيقاف ردّ: إيقاف");
});

/* ── مرحلة ٠ (٢٦/٩): نص لكل حملة + رابط متتبّع + holdout + صورة + كوبون ── */
import { jobInput, messageFor, imageUrlOk, newLinkCode, newCouponCode, DEFAULTS, SLUG_RE } from "./wasender.js";

const HOSTS = ["freshcuts-api.o2m8.me", "freshcuts.sa"];

test("سطر الإيقاف الافتراضي (قرار عمر)", () => {
  assert.equal(DEFAULTS.footer, "لو ما تبي رسايلنا ردّ بكلمة: إيقاف");
  assert.equal(senderCfg({}).footer, DEFAULTS.footer);
  assert.equal(senderCfg({ waSender: { footer: "" } }).footer, "", "المالك يقدر يشيله");
});

test("حملة: النص لازم فيه {name}، والفاضي = القالب العام", () => {
  assert.deepEqual(jobInput({}).errs, []);
  assert.equal(jobInput({ template: "أهلاً" }).errs[0][0], "name_required");
  assert.equal(jobInput({ template: "هلا {name} {lnk}" }).errs[0][0], "unknown_var");
  assert.deepEqual(jobInput({ template: "هلا {name} {link}" }).errs, []);
});

test("حملة: الرابط والهدف والكوبون", () => {
  const a = jobInput({ link: { slug: "WA-Sept", target_type: "offer", target_id: "nd96_box", coupon: "first" } });
  assert.deepEqual(a.link, { slug: "wa-sept", target_type: "offer", target_id: "nd96_box", coupon: "FIRST" });
  assert.equal(jobInput({ link: { target_type: "offer" } }).errs[0][0], "target_missing");
  assert.equal(jobInput({ link: { slug: "بالعربي" } }).errs[0][0], "bad_slug");
  assert.equal(jobInput({ link: { target_type: "weird" } }).link.target_type, "home");
  assert.ok(SLUG_RE.test("w12") && !SLUG_RE.test("-w12") && !SLUG_RE.test("w12-"));
});

test("حملة: holdout بين ٠ و٥٠٪", () => {
  assert.equal(jobInput({ holdoutPct: 10 }).holdoutPct, 10);
  assert.equal(jobInput({ holdoutPct: 90 }).holdoutPct, 50);
  assert.equal(jobInput({ holdoutPct: -3 }).holdoutPct, 0);
  assert.equal(jobInput({}).holdoutPct, 0);
});

test("حملة: الصورة من دوميناتنا بس وhttps", () => {
  assert.equal(imageUrlOk("https://freshcuts-api.o2m8.me/api/content/media/md_1.jpg", HOSTS), true);
  assert.equal(imageUrlOk("http://freshcuts-api.o2m8.me/x.jpg", HOSTS), false);
  assert.equal(imageUrlOk("https://evil.example/x.jpg", HOSTS), false);
  assert.equal(imageUrlOk("javascript:alert(1)", HOSTS), false);
  assert.equal(jobInput({ imageUrl: "https://evil.example/x.jpg" }, { hosts: HOSTS }).errs[0][0], "bad_image");
  assert.deepEqual(jobInput({ imageUrl: "https://freshcuts.sa/a.png" }, { hosts: HOSTS }).errs, []);
});

test("حملة: كوبون مرة واحدة", () => {
  const o = jobInput({ offer: { oneTime: true, freeDelivery: true, validDays: 99 } });
  assert.deepEqual(o.errs, []);
  assert.equal(o.offer.validDays, 30);
  assert.equal(jobInput({ offer: { oneTime: true } }).errs[0][0], "offer_empty");
  assert.equal(jobInput({ offer: { oneTime: true, percent: 10 }, link: { coupon: "FIRST" } }).errs[0][0], "two_coupons");
  assert.equal(jobInput({ offer: { oneTime: false, percent: 10 } }).offer, null);
  assert.match(newCouponCode(12), /^W12[A-HJ-NP-Z2-9]{5}$/);
  assert.match(newLinkCode(), /^[a-z0-9]{6}$/);
});

test("الرسالة لكل مستلم: متغيراته + رابطه + كوبونه + سطر الإيقاف", () => {
  const row = { vars: { name: "محمد", fav_dish: "كريب ستربس" }, message: "القديمة" };
  const m = messageFor(row, { template: "هلا {name}، {fav_dish} بانتظارك: {link} كوبونك {coupon} ({coupon_days} أيام)",
    footer: "لو ما تبي رسايلنا ردّ بكلمة: إيقاف", host: "https://freshcuts.sa", slug: "w12", code: "abc123", coupon: "W12ABCDE", couponDays: 7 });
  assert.equal(m, "هلا محمد، كريب ستربس بانتظارك: freshcuts.sa/l/w12-abc123 كوبونك W12ABCDE (7 أيام)\n\nلو ما تبي رسايلنا ردّ بكلمة: إيقاف");
  assert.equal(messageFor(row, { template: "", footer: "", host: "freshcuts.sa", slug: "w1", code: "x" }), "القديمة");
});

test("التجميع التدريجي في الإيقاع", () => {
  const cfg = on({ dailyCap: 40, warmup: { enabled: true, startedAt: new Date(AT_17 - 2 * 86400e3).toISOString(), from: 10, step: 5 } });
  assert.equal(pacing(cfg, { ...idle, today: 20 }, AT_17).reason, "warmup_cap");
  assert.equal(pacing(cfg, { ...idle, today: 19 }, AT_17).wait, 0);
  assert.equal(senderCfg({}).warmup.enabled, false);
});
