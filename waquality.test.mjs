/* QP1 (١٣/١٠) — حماية جودة رقم واتساب في حملات Cloud (M7 من مراجعة الخبير):
   حدود الفرامل الجديدة + التحذير، فرملة القراءة الضعيفة، 131049 بره نسبة الفشل ومن غير SMS بديل، بوابة الجودة (وبتقفل لو ماقدرتش تقرا)،
   سلّم التسخين، سقف العميل عبر الحملات والأتمتة، وتأكيد أرقام تطبيقات التوصيل.
   node --test waquality.test.mjs — قاعدة وهمية وfetch وهمي؛ مفيش شبكة حقيقية ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");
const Q = await import("./waquality.js");
const CAT = await import("./watemplates.js");
const ID = await import("./identity.js");
const { smsInfo } = await import("./staffalerts.js");
W.registerCatalog(CAT);
C.registerCampaignTemplates();

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
function withEnv(vals, fn) {
  return async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}
const ALLOW = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
const IMG = "https://freshcuts-api.o2m8.me/api/content/media/1.jpg";
const AT_17 = Date.parse("2026-10-13T14:00:00Z");      // ١٧:٠٠ الرياض، يوم ١٣/١٠
const TODAY = "2026-10-13";
const iso = (ms) => new Date(ms).toISOString();

// ═════════ دوال صافية ═════════
test("الإعدادات: الإيقاف ٢٪ بعد ٣٠، التحذير ١٪، القراءة ٤٠٪ بعد ٥٠ و٦ ساعات، سقف العميل ١/٧ و٣/٣٠ — وكلها بحدود", () => {
  const d = C.cloudCfg({});
  assert.deepEqual([d.brakeStopPct, d.brakeMinSends, d.brakeWarnPct, d.lowReadMinDelivered, d.lowReadHours, d.lowReadPct], [2, 30, 1, 50, 6, 40]);
  assert.deepEqual([d.cappedFallbackSms, d.allowUnknownQuality, d.qualityMaxAgeMin, d.custCap7d, d.custCap30d], [false, false, 10, 1, 3]);
  assert.deepEqual(d.warmup, { steps: [{ days: 3, cap: 30 }, { days: 4, cap: 50 }, { days: 7, cap: 100 }], stepUpStopPct: 1, minStepSends: 20 });
  for (const k of ["brakeWarnPct", "lowReadMinDelivered", "lowReadHours", "lowReadPct", "cappedFallbackSms", "allowUnknownQuality", "qualityMaxAgeMin", "custCap7d", "custCap30d", "warmup"]) {
    assert.ok(C.CLOUD_KEYS.includes(k), `${k} saveable`); assert.ok(C.CLOUD_CEILINGS.includes(k), `${k} owner-only`);
  }
  // حدود: التحذير مايعدّيش حد الإيقاف، قراءة الجودة مش أقدم من ١٠ دقايق، سقف العميل ١–٣ و١–١٠ وسقف الشهر مايقلّش عن الأسبوع
  const x = C.cloudCfg({ waCloud: { brakeStopPct: 1.5, brakeWarnPct: 9, qualityMaxAgeMin: 99, custCap7d: 50, custCap30d: 0, lowReadHours: 0, lowReadMinDelivered: 1, lowReadPct: 400, allowUnknownQuality: "yes", cappedFallbackSms: 1 } });
  assert.deepEqual([x.brakeWarnPct, x.qualityMaxAgeMin, x.custCap7d, x.custCap30d, x.lowReadHours, x.lowReadMinDelivered, x.lowReadPct, x.allowUnknownQuality, x.cappedFallbackSms], [1.5, 10, 3, 3, 1, 10, 100, false, false]);
  // السلّم: مالوش مفتاح إلغاء، درجاته بحدود، وسقوفه مابتنزلش
  const w = C.cloudCfg({ waCloud: { warmup: { enabled: false, steps: [{ days: 0, cap: 5000 }, { days: 2, cap: 10 }, { days: 99, cap: "x" }], stepUpStopPct: 80, minStepSends: 0 } } }).warmup;
  assert.deepEqual(w, { steps: [{ days: 1, cap: 1000 }, { days: 2, cap: 1000 }], stepUpStopPct: 5, minStepSends: 1 });
  assert.deepEqual(C.cloudCfg({ waCloud: { warmup: { steps: [] } } }).warmup.steps.map((s) => s.cap), [30, 50, 100]);
});

test("الترحيل: ٥٪/٢٠ المخزّنين (الافتراضي القديم) بيتشدّدوا مرة واحدة لـ٢٪/٣٠، وأي رقم تاني يفضل، وبعدها رقم المالك يفضل", () => {
  const m = Q.migrateQuality({ enabled: false, dailyCap: 200, brakeStopPct: 5, brakeMinSends: 20, brakeFailPct: 10 });
  assert.equal(m.changed, true); assert.deepEqual([m.next.brakeStopPct, m.next.brakeMinSends, m.next.rev, m.next.dailyCap, m.next.enabled], [2, 30, 2, 200, false]);
  const kept = Q.migrateQuality({ brakeStopPct: 3, brakeMinSends: 40 });
  assert.deepEqual([kept.next.brakeStopPct, kept.next.brakeMinSends, kept.next.rev], [3, 40, 2]);
  assert.equal(Q.migrateQuality({ brakeStopPct: 5, brakeMinSends: 20, rev: 2 }).changed, false);      // المالك رجّعها ٥ بعد الترحيل ⇒ تفضل
  assert.equal(Q.migrateQuality(undefined).changed, false);
  assert.equal(C.cloudCfg({ waCloud: m.next }).rev, 2, "العلامة بتفضل مع كل حفظ"); assert.equal(C.cloudCfg({}).rev, undefined);
});

test("الفرامل: الإيقاف عند ٢٪ بعد ٣٠، والتحذير بين ١٪ و٢٪، و131049 مش فشل", () => {
  const cc = C.cloudCfg({});
  assert.equal(C.brakeCheck({ sent: 29, failed: 0, stopped: 5 }, cc), null);                              // أقل من ٣٠
  assert.deepEqual(C.brakeCheck({ sent: 30, failed: 0, stopped: 1 }, cc), { reason: "stop_rate", pct: 3.3, limit: 2 });
  assert.deepEqual(C.brakeCheck({ sent: 100, failed: 0, stopped: 2 }, cc), { reason: "stop_rate", pct: 2, limit: 2 });
  assert.equal(C.brakeCheck({ sent: 100, failed: 0, stopped: 1 }, cc), null);
  assert.deepEqual(Q.brakeWarn({ sent: 100, failed: 0, stopped: 1 }, cc), { reason: "stop_warn", pct: 1, limit: 1 });
  assert.equal(Q.brakeWarn({ sent: 200, failed: 0, stopped: 1 }, cc), null);                              // ٠٫٥٪
  assert.equal(Q.brakeWarn({ sent: 100, failed: 0, stopped: 2 }, cc), null);                              // دي إيقاف مش تحذير
  assert.equal(Q.brakeWarn({ sent: 20, failed: 0, stopped: 1 }, cc), null);                               // قبل ٣٠
  // 131049: المنادي بيعدّه في capped، فمابيدخلش في نسبة الفشل
  assert.equal(C.brakeCheck({ sent: 27, failed: 0, capped: 10, stopped: 0 }, cc), null);
  assert.equal(C.brakeCheck({ sent: 27, failed: 3, capped: 0, stopped: 0 }, cc).reason, "fail_rate");
  const e = C.classifyError(131049);
  assert.deepEqual([e.reason, e.capped, e.stop, e.retry], ["meta_marketing_limit", true, false, false]);
  assert.equal(C.classifyError(131026).capped, false); assert.equal(C.classifyError(999999).capped, false);
  assert.equal(C.fallbackFor(e, "sms"), null, "من غير SMS بديل افتراضياً");
  assert.equal(C.fallbackFor(e, "sms", { cappedSms: true }), "sms");
  assert.equal(C.fallbackFor(e, "wa_web"), null, "ولا من واتساب ويب");
  assert.equal(C.fallbackFor(e, "wa_web", { cappedSms: true }), null, "مفيش مفتاح بيفتح واتساب ويب لعميل ميتا حدّته");
  assert.equal(C.fallbackFor(C.classifyError(130472), "wa_web"), "wa_web");                                // باقي الأكواد زي ما هي
  assert.equal(C.fallbackFor(C.classifyError(131026), "sms"), "sms");                                     // الرقم مش على واتساب: الـSMS زي ما هو
  assert.equal(Q.META_CAPPED_CODE, 131049);
});

test("فرملة القراءة الضعيفة: بعد ٥٠ وصلت و٦ ساعات، أقل من ٤٠٪ مقروء", () => {
  const cc = C.cloudCfg({}), h = 3600_000;
  const n = (delivered, read, hoursAgo) => ({ delivered, read, firstSentAt: iso(AT_17 - hoursAgo * h) });
  assert.deepEqual(Q.lowReadCheck(n(50, 19, 6), cc, AT_17), { reason: "low_read", pct: 38, limit: 40 });
  assert.equal(Q.lowReadCheck(n(50, 20, 6), cc, AT_17), null);                 // ٤٠٪ بالظبط = تمام
  assert.equal(Q.lowReadCheck(n(49, 0, 30), cc, AT_17), null);                 // أقل من ٥٠ وصلت
  assert.equal(Q.lowReadCheck(n(200, 0, 5.9), cc, AT_17), null);               // أقل من ٦ ساعات
  assert.equal(Q.lowReadCheck({ delivered: 200, read: 0, firstSentAt: null }, cc, AT_17), null);
  assert.equal(Q.lowReadCheck(n(200, 0, 30), { ...cc, lowReadPct: 0 }, AT_17), null);      // صفر = مقفولة
});

test("السلّم: ٣٠ ثم ٥٠ ثم ١٠٠ ثم السقف اليومي — بالأيام، وعمره ما يعدّي السقف اليومي", () => {
  const wc = C.cloudCfg({}).warmup;
  const v0 = Q.warmupView(null, wc, { today: TODAY, dailyCap: 200 });
  assert.deepEqual([v0.started, v0.step, v0.cap, v0.day, v0.finished, v0.stepsTotal], [false, 1, 30, 0, false, 3]);
  const st = Q.warmupStart("2026-10-10");
  const v = (today, state = st, dailyCap = 200) => Q.warmupView(state, wc, { today, dailyCap });
  assert.deepEqual([v("2026-10-10").day, v("2026-10-10").cap, v("2026-10-12").dayInStep, v("2026-10-12").due], [1, 30, 3, false]);
  assert.equal(v("2026-10-13").due, true, "اليوم الرابع: الدرجة خلصت مدتها");
  assert.equal(v("2026-10-13").cap, 30, "وبتفضل ٣٠ لحد ما الطلوع يتوافق عليه");
  assert.deepEqual([v(TODAY, { step: 1, since: TODAY, startedAt: "2026-10-10" }).cap, v(TODAY, { step: 2, since: TODAY, startedAt: "2026-10-01" }).cap], [50, 100]);
  const done = v(TODAY, { step: 3, since: "2026-10-01", startedAt: "2026-09-15" });
  assert.deepEqual([done.finished, done.cap, done.refused], [true, 200, null]);
  assert.equal(v(TODAY, { step: 2, since: TODAY, startedAt: TODAY }, 60).cap, 60, "سقف الدرجة ١٠٠ بس السقف اليومي ٦٠");
  assert.equal(v(TODAY, st, 10).cap, 10);
  assert.deepEqual(v0.steps, [{ step: 1, days: 3, cap: 30 }, { step: 2, days: 4, cap: 50 }, { step: 3, days: 7, cap: 100 }]);
});

test("الطلوع درجة: محتاج نسبة «إيقاف» الدرجة < ١٪ وجودة GREEN ورسايل كفاية — وإلا بنقول ليه", () => {
  const wc = C.cloudCfg({}).warmup, st = Q.warmupStart("2026-10-10");
  const adv = (today, stats, quality, state = st) => Q.warmupAdvance(state, wc, { today, stats, quality });
  assert.equal(adv("2026-10-12", { sent: 90, stopped: 0 }, "GREEN").changed, false, "لسه في أيام الدرجة");
  const up = adv(TODAY, { sent: 90, stopped: 0 }, "GREEN");
  assert.deepEqual([up.changed, up.steppedUp, up.state.step, up.state.since, up.state.refused], [true, true, 1, TODAY, null]);
  assert.deepEqual(up.state.history, [{ at: TODAY, from: 1, to: 2, sent: 90, stopPct: 0 }]);
  const bad = adv(TODAY, { sent: 90, stopped: 1 }, "GREEN");                         // ١٫١٪
  assert.deepEqual([bad.state.step, bad.refused], [0, { at: TODAY, why: "stop_rate", stopPct: 1.1, sent: 90 }]);
  assert.equal(adv(TODAY, { sent: 90, stopped: 0 }, "YELLOW").refused.why, "quality_YELLOW");
  assert.equal(adv(TODAY, { sent: 90, stopped: 0 }, "UNKNOWN").refused.why, "quality_UNKNOWN");
  assert.equal(adv(TODAY, { sent: 90, stopped: 0 }, null).refused.why, "quality_unreadable");
  assert.equal(adv(TODAY, { sent: 19, stopped: 0 }, "GREEN").refused.why, "not_enough_sends");
  // نفس الرفض مرتين مايتحفظش تاني؛ وبعد آخر درجة مفيش طلوع
  assert.equal(adv(TODAY, { sent: 90, stopped: 1 }, "GREEN", bad.state).changed, false);
  assert.equal(adv(TODAY, { sent: 900, stopped: 0 }, "GREEN", { step: 3, since: "2026-09-01", startedAt: "2026-09-01" }).changed, false);
  // درجة واحدة في المرة حتى لو فات شهر
  assert.equal(adv("2026-12-01", { sent: 900, stopped: 0 }, "GREEN").state.step, 1);
  assert.equal(Q.warmupView(bad.state, wc, { today: TODAY, dailyCap: 200 }).refused.why, "stop_rate");
});

test("حد الرقم: مقارنة الدرجات، والصيغ اللي مانعرفهاش مابتتقارنش", () => {
  assert.deepEqual(["TIER_250", "TIER_1K", "TIER_2K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED"].map(Q.tierRank), [250, 1000, 2000, 10000, 100000, Infinity]);
  assert.equal(Q.tierRank(null), null); assert.equal(Q.tierRank("???"), null);
  assert.equal(Q.tierDown("TIER_1K", "TIER_250"), true); assert.equal(Q.tierDown("TIER_250", "TIER_1K"), false);
  assert.equal(Q.tierDown("TIER_250", "TIER_250"), false); assert.equal(Q.tierDown(null, "TIER_250"), false); assert.equal(Q.tierDown("TIER_1K", null), false);
});

const PHONE = (x = {}) => ({ ok: true, quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, health: "AVAILABLE", checkedAt: iso(AT_17 - 60_000), ...x });
const verdict = (x) => Q.qualityVerdict({ phone: PHONE(), now: AT_17, ...x });

test("بوابة الجودة: GREEN بس اللي يعدّي؛ YELLOW/RED/نزول الحد/قالب جودته نزلت = إيقاف؛ وماقدرناش نقرا = مفيش إرسال (مش «تمام»)", () => {
  assert.deepEqual(verdict({}), { ok: true, state: "GREEN", tier: "TIER_250", portfolio: "TIER_250" });
  for (const [q, reason] of [["YELLOW", "quality_YELLOW"], ["RED", "quality_RED"], ["UNKNOWN", "quality_UNKNOWN"], ["yellow", "quality_YELLOW"]]) {
    const v = verdict({ phone: PHONE({ quality: q }) });
    assert.deepEqual([v.ok, v.stop, v.reason], [false, true, reason], q);
  }
  assert.equal(verdict({ phone: PHONE({ quality: "UNKNOWN" }), allowUnknown: true }).ok, true, "المالك سمح بـUNKNOWN صريح");
  assert.equal(verdict({ phone: PHONE({ quality: "YELLOW" }), allowUnknown: true }).reason, "quality_YELLOW");
  assert.equal(verdict({ phone: PHONE({ health: "BLOCKED" }) }).reason, "quality_blocked");
  // نزول الحد (الرقم أو المحفظة)
  assert.deepEqual(verdict({ prev: { tier: "TIER_1K", portfolio: null } }), { ok: false, stop: true, reason: "quality_tier_down", detail: "TIER_1K>TIER_250" });
  assert.equal(verdict({ prev: { tier: "TIER_250", portfolio: "TIER_1K" } }).reason, "quality_tier_down");
  assert.equal(verdict({ prev: { tier: "TIER_250", portfolio: "TIER_250" } }).ok, true);
  assert.equal(verdict({ phone: PHONE({ tier: "TIER_1K" }), prev: { tier: "TIER_250" } }).ok, true, "طلوع الحد مش مشكلة");
  // قوالب الحملات الشغّالة بس
  const tpl = (quality, status = "APPROVED", name = "fc_offer_img") => [{ name, status, quality }];
  assert.deepEqual(verdict({ running: ["fc_offer_img"], templates: tpl("YELLOW") }), { ok: false, stop: true, reason: "quality_template_YELLOW", detail: "fc_offer_img" });
  assert.equal(verdict({ running: ["fc_offer_img"], templates: tpl("RED") }).reason, "quality_template_RED");
  assert.equal(verdict({ running: ["fc_offer_img"], templates: tpl("UNKNOWN") }).ok, true);
  assert.equal(verdict({ running: ["fc_offer_img"], templates: tpl(null) }).ok, true);
  assert.equal(verdict({ running: ["fc_offer_img"], templates: tpl("GREEN", "PAUSED") }).reason, "quality_template_PAUSED");
  assert.equal(verdict({ running: ["fc_offer_img"], templates: tpl("RED", "APPROVED", "fc_winback") }).ok, true, "قالب مش في حملة شغّالة");
  // مش قادرين نقرا ⇒ hold
  for (const [x, detail] of [[{ phone: null }, "phone_not_read"], [{ phone: { ok: false, error: "HTTP 500" } }, "phone:HTTP 500"], [{ phone: PHONE({ checkedAt: iso(AT_17 - 11 * 60_000) }) }, "phone_read_stale"],
    [{ phone: PHONE({ checkedAt: null }) }, "phone_read_stale"], [{ phone: PHONE({ quality: null }) }, "quality_missing"], [{ running: ["fc_offer_img"], tplOk: false }, "templates_not_read"]]) {
    assert.deepEqual(verdict(x), { ok: false, hold: true, reason: "quality_unreadable", detail }, detail);
  }
  assert.equal(verdict({ phone: PHONE({ checkedAt: iso(AT_17 - 3 * 60_000) }), maxAgeMs: 2 * 60_000 }).detail, "phone_read_stale");
});

test("أحداث الويب هوك: آخر حدث لكل موضوع هو اللي بيتحسب، وبتوقّف حتى لو القراءة من ميتا لسه GREEN", () => {
  const ev = (kind, x) => ({ kind, event: null, state: null, name: null, ...x });
  assert.equal(verdict({ events: [ev("phone", { event: "FLAGGED" })] }).reason, "quality_flagged");
  assert.equal(verdict({ events: [ev("phone", { event: "FLAGGED" }), ev("phone", { event: "UNFLAGGED" })] }).ok, true);
  assert.deepEqual(verdict({ events: [ev("phone", { event: "DOWNGRADE", tier: "TIER_250" })] }), { ok: false, stop: true, reason: "quality_tier_down", detail: "TIER_250" });
  assert.equal(verdict({ events: [ev("phone", { event: "UPGRADE", tier: "TIER_1K" })] }).ok, true);
  assert.deepEqual(verdict({ events: [ev("account", { event: "ACCOUNT_VIOLATION" })] }), { ok: false, stop: true, reason: "quality_account", detail: "ACCOUNT_VIOLATION" });
  assert.equal(verdict({ events: [ev("account", { event: "PARTNER_ADDED" })] }).ok, true, "حدث حساب عادي مش إيقاف");
  const y = ev("template", { state: "YELLOW", name: "fc_offer_img" });
  assert.deepEqual(verdict({ events: [y], running: ["fc_offer_img"], templates: [{ name: "fc_offer_img", status: "APPROVED", quality: "GREEN" }] }), { ok: false, stop: true, reason: "quality_template_YELLOW", detail: "fc_offer_img" });
  assert.equal(verdict({ events: [y], running: ["fc_winback"] }).ok, true, "قالب مش في حملة شغّالة");
  assert.equal(verdict({ events: [y, ev("template", { state: "GREEN", name: "fc_offer_img" })], running: ["fc_offer_img"] }).ok, true);
  assert.equal(verdict({ events: [ev("template", { event: "PAUSED", name: "fc_offer_img" })], running: ["fc_offer_img"] }).reason, "quality_template_PAUSED");
  assert.equal(verdict({ events: [ev("template", { event: "APPROVED", name: "fc_offer_img" })], running: ["fc_offer_img"] }).ok, true);
  // الحدث الخام ⇒ صف
  assert.deepEqual(Q.qualityEventRow({ kind: "phone", event: "flagged", tier: "tier_250" }), { kind: "phone", event: "FLAGGED", state: null, name: null, language: null, tier: "TIER_250" });
  assert.equal(Q.qualityEventRow({ kind: "template", state: "YELLOW" }), null, "قالب من غير اسم");
  assert.equal(Q.qualityEventRow({ kind: "account", event: null }), null); assert.equal(Q.qualityEventRow({ kind: "weird", event: "X" }), null); assert.equal(Q.qualityEventRow(null), null);
});

test("الويب هوك: أحداث الجودة والحساب بتتفرد من الحمولة", () => {
  const body = (field, value) => ({ entry: [{ id: "WABA1", changes: [{ field, value }] }] });
  assert.deepEqual(W.parseWebhook(body("phone_number_quality_update", { display_phone_number: "966546715683", event: "FLAGGED", current_limit: "TIER_250" })).qualityEvents, [{ kind: "phone", event: "FLAGGED", tier: "TIER_250" }]);
  assert.deepEqual(W.parseWebhook(body("message_template_quality_update", { previous_quality_score: "GREEN", new_quality_score: "YELLOW", message_template_name: "fc_offer_img", message_template_language: "ar" })).qualityEvents,
    [{ kind: "template", state: "YELLOW", name: "fc_offer_img", language: "ar" }]);
  assert.deepEqual(W.parseWebhook(body("message_template_status_update", { event: "PAUSED", message_template_name: "fc_offer_img", message_template_language: "ar" })).qualityEvents, [{ kind: "template", event: "PAUSED", name: "fc_offer_img", language: "ar" }]);
  assert.deepEqual(W.parseWebhook(body("account_update", { event: "ACCOUNT_VIOLATION" })).qualityEvents, [{ kind: "account", event: "ACCOUNT_VIOLATION" }]);
  assert.deepEqual(W.parseWebhook(body("messages", { messages: [] })).qualityEvents, []);
  // رقم تاني على نفس الحساب: حدثه مايوقّفش حملاتنا (لما رقمنا معروف)؛ ورقمنا بيتحسب
  const other = body("phone_number_quality_update", { display_phone_number: "966500000000", event: "FLAGGED", current_limit: "TIER_250" });
  assert.deepEqual(W.parseWebhook(other, { ownNumbers: ["966546715683"] }).qualityEvents, []);
  assert.equal(W.parseWebhook(other).qualityEvents.length, 1, "رقمنا مش معروف ⇒ الأحوط إنه يتحسب");
  assert.equal(W.parseWebhook(body("phone_number_quality_update", { display_phone_number: "+966 54 671 5683", event: "FLAGGED" }), { ownNumbers: ["966546715683"] }).qualityEvents.length, 1);
});

test("الإيقاع: سقف السلّم تحت السقف اليومي وله سببه، والتحذير بينصّف عدد الدورة", () => {
  const cc = C.cloudCfg({ waCloud: { enabled: true } });
  assert.deepEqual(C.cloudPacing(cc, { today: 29, warmCap: 30 }, true), { allow: 1, reason: null });
  assert.deepEqual(C.cloudPacing(cc, { today: 30, warmCap: 30 }, true), { allow: 0, reason: "warmup_cap" });
  assert.equal(C.cloudPacing(cc, { today: 200, warmCap: 5000 }, true).reason, "daily_cap", "السلّم عمره ما يرفع السقف اليومي");
  assert.equal(C.cloudPacing(cc, { today: 0 }, true).allow, 5);
  assert.equal(C.cloudPacing(cc, { today: 0, halve: true }, true).allow, 2);
  assert.equal(C.cloudPacing({ ...cc, perTick: 1 }, { today: 0, halve: true }, true).allow, 1);
});

test("سقف العميل وقاعدة أرقام التطبيقات ونصوص التنبيه", () => {
  const cap = Q.custCapOf({});
  assert.deepEqual(cap, { d7: 1, d30: 3 });
  assert.equal(Q.custCapReason({ d7: 0, d30: 0 }, cap), null); assert.equal(Q.custCapReason(undefined, cap), null);
  assert.equal(Q.custCapReason({ d7: 1, d30: 1 }, cap), "marketing_cap_7d");
  assert.equal(Q.custCapReason({ d7: 0, d30: 3 }, cap), "marketing_cap_30d");
  assert.equal(Q.custCapReason({ d7: 1, d30: 2 }, Q.custCapOf({ waCloud: { custCap7d: 2 } })), null);
  assert.equal(Q.CLOUD_MIN_GAP_DAYS, 7); assert.equal(S.MIN_GAP_DAYS, 3, "فاصل الـSMS / واتساب ويب زي ما هو");
  // «تطبيق بس» = قاعدة identity.js: مصدره delivery_app + مالوش مصدر تاني ولا طلب موقع مدفوع ولا حساب
  const sql = ID.appOnlyPhonesSql("$1").replace(/\s+/g, " ");
  assert.ok(sql.includes(ID.appSourceSql("s"))); assert.match(sql, /d\.source <> 'delivery_app'/); assert.ok(sql.includes(ID.shopPaidSql("so"))); assert.match(sql, /FROM acct_customers a/);
  // التنبيه: رسالة SMS واحدة بالعربي والإنجليزي، لكل سبب
  for (const r of [...Q.QUALITY_REASONS, "quality_template_YELLOW", "quality_whatever"]) for (const l of ["ar", "en"]) assert.equal(smsInfo(Q.qualityAlertText(r, "fc_weekend_offer", l)).segments, 1, `${r} ${l}`);
  for (const l of ["ar", "en"]) assert.equal(smsInfo(Q.warnAlertText(1.4, l)).segments, 1);
  assert.match(Q.qualityAlertText("quality_YELLOW", null, "ar"), /اتوقفت/); assert.match(Q.qualityAlertText("quality_YELLOW", null, "en"), /Only the owner can resume/);
});

// ═════════ الدورة والمسارات ═════════
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, param = {}, auth = "Bearer cms:own" } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: () => undefined, param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });
const MK = "Bearer cms:mk";
const J = (x = {}) => ({ id: 1, name: "عرض الويكند", status: "running", channel: "wa_cloud", cloud_template: "fc_offer_img", cloud_vars: { offer: "كيلو بـ96" }, image_url: IMG, video_url: null, link_slug: "w1", offer: null, fallback: "none", spend_cap_sar: null, rate_sar: 0.2159, stop_reason: null, warn_at: null, brake_ack_at: null, ...x });
const R = (id, x = {}) => ({ id, job_id: 1, phone_norm: `52000${String(id).padStart(4, "0")}`, status: "pending", channel: "wa_cloud", name: "محمد", vars: { first_name: "محمد" }, link_code: `c${id}`, coupon: null, attempts: 0, message: "نص الحملة", ...x });
const sentRows = (n, x = () => ({})) => Array.from({ length: n }, (_, i) => R(i + 1, { status: "sent", cloud_status: "delivered", sent_at: iso(AT_17 - 7 * 3600_000), ...x(i) }));
const GREEN = () => ({ ok: true, status: "CONNECTED", quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, checkedAt: iso(AT_17) });
const WARM_DONE = { step: 3, since: "2026-09-01", startedAt: "2026-09-01" };

function world({ jobs = [], queue = [], settings = {}, warmup = WARM_DONE, quality = null, phone = GREEN, templates = [], tplOk = true, cloud = true, sentToday = null, mk = {}, mkThrows = false,
  tplSync = { state: "same", status: "APPROVED", diffs: [] }, appOnly = [], appOnlyThrows = false, people = 3, waContacts = [], stopped = null, linkClicks = 0, fav = null } = {}) {
  const db = { jobs, queue, state: { stopped_reason: stopped, warmup, quality }, events: [], sms: [], broadcasts: [], gapDays: [], newJobs: [], newQueue: [], smsFallback: [], msgs: [], unmatched: [], replies: [], sqlLog: [],
    settings: { waCloud: { enabled: true }, waSender: {}, waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, delivery: { alertPhones: ["0500000001"] }, ...settings } };
  const job = (id) => db.jobs.find((j) => j.id === Number(id));
  const qrow = (id) => db.queue.find((q) => q.id === Number(id));
  const pool = { db, connect: async () => ({ query: (s, p) => pool.query(s, p), release() {} }), async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sqlLog.push(s);
    /* RF1: رسايل صادرة وحالاتها، ردود العملاء على الحملة، ونتايج الحملة */
    if (/^INSERT INTO wa_messages\(wamid, direction, phone_norm, template/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], category: p[3], status: p[6], body: p[8], source: p[10], updated_at: null }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO wa_messages\(wamid, direction, phone_norm, status, body, pricing/i.test(s)) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/^UPDATE wa_messages SET status = CASE/i.test(s)) { const m = db.msgs.find((x) => x.wamid === p[0]); if (!m) return { rows: [], rowCount: 0 }; m.status = W.nextStatus(m.status, p[1]);
      return { rows: [{ id: 1, phone_norm: m.phone_norm, order_no: null, fallback_sms: null, fallback_done: false, status: m.status }], rowCount: 1 }; }
    if (/^INSERT INTO wa_webhook_health\(field, last_at, n, last_note\) VALUES \('_status_unmatched'/i.test(s)) { db.unmatched.push(p[0]); return { rows: [] }; }
    if (/^UPDATE wa_send_queue q SET cloud_status = m\.status/i.test(s)) { const rank = { accepted: 0, sent: 1, delivered: 2, read: 3 }; let n = 0;
      for (const q of db.queue) { const m = q.wamid && db.msgs.find((x) => x.wamid === q.wamid); if (!m || q.status !== "sent" || !["delivered", "read"].includes(m.status)) continue;
        if (rank[m.status] > (rank[q.cloud_status || "accepted"] ?? 9)) { q.cloud_status = m.status; q.delivered_at = q.delivered_at || m.updated_at; if (m.status === "read") q.read_at = q.read_at || m.updated_at; n++; } }
      return { rows: [], rowCount: n }; }
    if (/^SELECT id, job_id FROM wa_send_queue WHERE phone_norm=\$1 AND status='sent'/i.test(s)) return { rows: db.queue.filter((q) => q.phone_norm === p[0] && q.status === "sent").slice(-1) };
    if (/^INSERT INTO wa_replies/i.test(s)) { db.replies.push({ pn: p[0], text: p[1], job_id: p[3], optout: p[5] }); return { rows: [{ id: db.replies.length }], rowCount: 1 }; }
    if (/^UPDATE wa_send_queue SET replied_at = COALESCE\(replied_at, NOW\(\)\) WHERE id=\$1/i.test(s)) { qrow(p[0]).replied_at = iso(AT_17); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET optout_at = COALESCE\(optout_at, NOW\(\)\) WHERE id = \(SELECT id FROM wa_send_queue WHERE phone_norm=\$1/i.test(s)) { const q = db.queue.filter((x) => x.phone_norm === p[0] && x.status === "sent").slice(-1)[0]; if (q) q.optout_at = iso(AT_17); return { rows: [] }; }
    if (/^SELECT \* FROM wa_send_jobs WHERE id=\$1/i.test(s)) return { rows: job(p[0]) ? [job(p[0])] : [] };
    if (/^SELECT phone_norm pn, status, reason, sent_at, clicks, replied_at/i.test(s)) return { rows: db.queue.filter((q) => q.job_id === Number(p[0])).map((q) => ({ ...q, pn: q.phone_norm })) };
    if (/^SELECT clicks FROM cms_links WHERE slug=\$1/i.test(s)) return { rows: [{ clicks: linkClicks }] };
    if (/^SELECT count\(DISTINCT so\.order_no\)::int n/i.test(s)) return { rows: [{ n: 0, rev: 0 }] };
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return { rows: [Number(p[0]) === 2 ? { ...db.state } : {}] };
    if (/^UPDATE wa_sender_state SET quality=\$1/i.test(s)) { db.state.quality = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_sender_state SET warmup=\$1/i.test(s)) { db.state.warmup = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_sender_state SET stopped_reason=\$1 WHERE id=2 AND stopped_reason IS NULL/i.test(s)) { if (db.state.stopped_reason) return { rows: [], rowCount: 0 }; db.state.stopped_reason = p[0]; return { rows: [{ id: 2 }], rowCount: 1 }; }
    if (/^UPDATE wa_sender_state SET stopped_reason=NULL, fail_streak=0 WHERE id=2/i.test(s)) { db.state.stopped_reason = null; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_sender_state SET stopped_reason=\$1, fail_streak/i.test(s)) { db.state.stopped_reason = p[0]; return { rows: [] }; }
    if (/^INSERT INTO wa_quality_events/i.test(s)) { db.events.push({ id: db.events.length + 1, kind: p[0], event: p[1], state: p[2], name: p[3], language: p[4], tier: p[5] }); return { rows: [], rowCount: 1 }; }
    if (/FROM wa_quality_events WHERE id > \$1/i.test(s)) return { rows: db.events.filter((e) => e.id > Number(p[0])) };
    if (/FROM wa_send_queue WHERE status='sent' AND sent_at > NOW\(\) - INTERVAL '2 days'/i.test(s)) return { rows: [{ today: sentToday != null ? sentToday + db.queue.filter((q) => q._now).length : db.queue.filter((q) => q._now).length, last_hour: 0 }] };
    if (/^SELECT count\(DISTINCT phone_norm\)::int AS n FROM wa_messages/i.test(s)) return { rows: [{ n: 0 }] };
    if (/^SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running' AND channel='wa_cloud'/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "running" && j.channel === "wa_cloud") };
    if (/^SELECT count\(\*\) FILTER \(WHERE status='sent' AND COALESCE\(cloud_status/i.test(s)) {
      const r = db.queue.filter((q) => q.job_id === Number(p[0])), ack = p[1] ? Date.parse(p[1]) : null, after = (q) => !ack || Date.parse(q.sent_at || 0) > ack;
      const isFail = (q) => q.status === "failed" || q.cloud_status === "failed";
      const firsts = r.filter((q) => q.status === "sent" && q.sent_at && after(q)).map((q) => q.sent_at).sort();
      return { rows: [{ sent: r.filter((q) => q.status === "sent" && q.cloud_status !== "failed").length, failed: r.filter((q) => isFail(q) && Number(q.error_code) !== 131049).length,
        capped: r.filter((q) => isFail(q) && Number(q.error_code) === 131049).length, stopped: r.filter((q) => q.optout_at).length,
        delivered: r.filter((q) => ["delivered", "read"].includes(q.cloud_status) && after(q)).length, read_n: r.filter((q) => q.cloud_status === "read" && after(q)).length, first_sent: firsts[0] || null }] };
    }
    if (/^SELECT count\(\*\)::int AS sent, count\(\*\) FILTER \(WHERE optout_at IS NOT NULL\)::int AS stopped FROM wa_send_queue WHERE channel='wa_cloud' AND status='sent' AND sent_at >=/i.test(s)) {
      const from = Date.parse(`${p[0]}T00:00:00+03:00`), r = db.queue.filter((q) => q.status === "sent" && (q._now || Date.parse(q.sent_at || 0) >= from));
      return { rows: [{ sent: r.length, stopped: r.filter((q) => q.optout_at).length }] };
    }
    if (/^UPDATE wa_send_jobs SET status='paused', stop_reason=\$2 WHERE id=\$1 AND status='running'/i.test(s)) { const j = job(p[0]); if (j && j.status === "running") { j.status = "paused"; j.stop_reason = p[1]; } return { rows: [] }; }
    if (/^UPDATE wa_send_jobs SET status='paused', stop_reason=\$1 WHERE status='running' AND channel='wa_cloud'/i.test(s)) { const hit = db.jobs.filter((j) => j.status === "running" && j.channel === "wa_cloud"); for (const j of hit) { j.status = "paused"; j.stop_reason = p[0]; } return { rows: hit.map((j) => ({ id: j.id })), rowCount: hit.length }; }
    if (/^UPDATE wa_send_jobs SET warn_at=NOW\(\) WHERE id=\$1 AND warn_at IS NULL/i.test(s)) { const j = job(p[0]); if (!j || j.warn_at) return { rows: [], rowCount: 0 }; j.warn_at = iso(AT_17); return { rows: [{ id: j.id }], rowCount: 1 }; }
    if (/^UPDATE wa_send_jobs SET status=\$2, finished_at/i.test(s)) { const j = job(p[0]); if (!j || ["done", "cancelled"].includes(j.status)) return { rows: [], rowCount: 0 }; j.status = p[1]; if (p[1] === "running") { j.stop_reason = null; j.brake_ack_at = /brake_ack_at = CASE WHEN \$2='running' THEN NOW\(\)/.test(s) ? iso(AT_17) : j.brake_ack_at; } return { rows: [{ id: j.id }], rowCount: 1 }; }
    if (/^UPDATE wa_send_jobs SET status=\$2, stop_reason = CASE/i.test(s)) { const hit = db.jobs.filter((j) => j.status === p[0] && (p[2] || j.channel !== "wa_cloud")); for (const j of hit) { j.status = p[1]; if (p[1] === "running") { j.stop_reason = null; j.brake_ack_at = iso(AT_17); } } return { rows: hit.map((j) => ({ id: j.id })), rowCount: hit.length }; }
    if (/^SELECT channel FROM wa_send_jobs WHERE id=\$1/i.test(s)) return { rows: job(p[0]) ? [{ channel: job(p[0]).channel }] : [] };
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) { const q = db.queue.find((x) => x.status === "pending" && job(x.job_id)?.status === "running"); if (!q) return { rows: [] }; q.status = "sending"; q.attempts = (q.attempts || 0) + 1; return { rows: [q] }; }
    if (/^SELECT id, cloud_template, cloud_vars, image_url, video_url/i.test(s)) return { rows: [job(p[0])] };
    if (/^SELECT id, fallback FROM wa_send_jobs/i.test(s)) return { rows: [job(p[0])] };
    if (/^SELECT id, job_id, phone_norm, status, cloud_status, channel, coupon, message FROM wa_send_queue WHERE wamid=\$1/i.test(s)) return { rows: db.queue.filter((q) => q.wamid === p[0]) };
    if (/^UPDATE wa_send_queue SET cloud_status=\$2/i.test(s)) { const q = qrow(p[0]), at = p[2] ? new Date(p[2]).toISOString() : iso(AT_17); q.cloud_status = p[1];
      if (["delivered", "read"].includes(p[1])) q.delivered_at = q.delivered_at || at; if (p[1] === "read") q.read_at = q.read_at || at; return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='pending', attempts=GREATEST/i.test(s)) { qrow(p[0]).status = "pending"; return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='sent'/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent", _now: true, wamid: p[4] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_send_queue SET status='failed', reason=\$2, error_code=\$3, cloud_status='failed'/i.test(s)) { Object.assign(qrow(p[0]), { status: "failed", reason: p[1], error_code: p[2], cloud_status: "failed" }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return { rows: [] }; }
    { const m = /^UPDATE wa_send_queue SET status='skipped', reason='([a-z_]+)' WHERE id=\$1$/i.exec(s); if (m) { Object.assign(qrow(p[0]), { status: "skipped", reason: m[1] }); return { rows: [] }; } }      // FD1
    /* مراجعة FD1 ٣: تعديل صف واحد — نوع الحملة الأول، وبعدين التعديل */
    if (/^SELECT j\.cloud_vars FROM wa_send_queue q JOIN wa_send_jobs j ON j\.id = q\.job_id WHERE q\.id=\$1/i.test(s)) { const q = qrow(p[0]); const jj = q && job(q.job_id); return { rows: jj ? [{ cloud_vars: jj.cloud_vars }] : [] }; }
    if (/^UPDATE wa_send_queue SET message=\$2, edited_by=\$3 WHERE id=\$1 AND status='pending'/i.test(s)) { const q = qrow(p[0]); if (!q || q.status !== "pending") return { rows: [], rowCount: 0 }; q.message = p[1]; q.edited_by = p[2]; return { rows: [{ id: q.id }], rowCount: 1 }; }
    if (/^UPDATE wa_send_queue SET note=\$2, fallback_from=\$3/i.test(s)) { Object.assign(qrow(p[0]), { note: p[1], fallback_from: p[2] }); return { rows: [] }; }
    if (/FROM wa_contact_log WHERE phone_norm = ANY/i.test(s)) { db.gapDays.push(p[1]); return { rows: p[0].filter((x) => waContacts.includes(x)).map((x) => ({ pn: x })) }; }
    if (/sms_ad_blocked|cms_campaign_sends|cms_flow_log|FROM sms_log/i.test(s)) throw Object.assign(new Error("missing"), { code: "42P01" });
    /* سقف العميل: نفس الاستعلام في الحارس (رقم واحد) وفي بناء الحملة (قايمة) */
    if (/FROM wa_messages WHERE phone_norm=\$1 AND direction='out' AND template IS NOT NULL AND \(category='MARKETING' OR source='campaign'\) AND COALESCE\(status,''\) NOT IN \('failed','skipped'\)/i.test(s)) {
      if (mkThrows) throw new Error("db down");
      return { rows: [mk[p[0]] || { d7: 0, d30: 0 }] };
    }
    if (/FROM wa_messages WHERE phone_norm = ANY\(\$1::text\[\]\) AND direction='out' AND template IS NOT NULL AND \(category='MARKETING' OR source='campaign'\)/i.test(s)) return { rows: p[0].filter((x) => mk[x]).map((x) => ({ pn: x, ...mk[x] })) };
    if (/FROM order_sources s WHERE s\.phone_norm = ANY/i.test(s)) { if (appOnlyThrows) throw new Error("no table"); return { rows: p[0].filter((x) => appOnly.includes(x)).map((x) => ({ pn: x })) }; }
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_send_jobs/i.test(s)) { db.newJobs.push(p); return { rows: [{ id: 77 }] }; }
    if (/^INSERT INTO wa_send_queue\(job_id, phone_norm, name, message/i.test(s)) { db.newQueue.push(p); return { rows: [], rowCount: 1 }; }      // FD1
    if (/^SELECT \(SELECT count\(\*\)::int FROM wa_invalid_numbers\) AS invalid/i.test(s)) return { rows: [{ invalid: 0, replies7: 0, optouts7: 0 }] };
    if (/^SELECT 1 FROM cms_links WHERE slug=\$1/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waCloud\}'/i.test(s)) { db.settings.waCloud = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  let failWith = null;
  const fetch = async (url, init = {}) => {
    if (init.method === "HEAD") return { ok: true, status: 200, headers: { get: (h) => (h === "content-type" ? "image/jpeg" : "300000") } };
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (failWith) return { ok: false, status: 400, json: async () => ({ error: { code: failWith, message: "meta says no" } }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.Q${calls.length}` }] }) };
  };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const app = fakeApp();
  const reads = { phone: 0, fresh: 0, tpl: 0 };
  const cloudApi = { phoneInfo: async (o = {}) => { reads.phone++; if (o.fresh) reads.fresh++; const x = typeof phone === "function" ? phone() : phone; if (x instanceof Error) throw x; return x; },
    templateInfo: async () => { reads.tpl++; return tplOk ? { ok: true, list: templates } : { ok: false, error: "HTTP 500" }; },
    templateSync: async () => ({ ...tplSync }) };
  const rows = Array.from({ length: people }, (_, i) => ({ pn: `51000000${i}`, name: `عميل ${i}`, orders: 2, spend: 100, daysAgo: 40, lastTotal: 60, score: 1, vars: { first_name: `عميل${i}` } }));
  const outreach = { AUDIENCES: { lapsed: { label: "غايبين" } }, audienceRows: async () => rows, cfg: async () => ({ template: "أهلاً {name}" }) };
  const cms = { waFallbackSms: async (x) => { db.smsFallback.push(x); return { ok: true }; } };
  const api = S.register(app, ctx, { wa, fetch, outreach, cloudLoop: false, lock: false, now: () => AT_17, cms: () => cms, ...(cloud ? { cloud: () => cloudApi } : {}), ...(fav ? { fav: () => fav } : {}),
    sendSms: async (m) => { db.sms.push(m); return { ok: true }; }, broadcast: (ev, x) => db.broadcasts.push([ev, x]),
    sessionUser: async (t) => (t === "cms:mk" ? { name: "تسويق", role: "marketing" } : { name: "عمر", role: "owner" }) });
  return { db, pool, app, api, wa, calls, reads, fail: (code) => { failWith = code; } };
}

test("البوابة بتقفل لو ماقدرتش تقرا: مفيش قارئ / ميتا واقعة / القراءة قديمة ⇒ ولا رسالة الدورة دي، ومن غير إيقاف دائم ولا تنبيه", withEnv(ALLOW, async () => {
  for (const [x, detail] of [[{ cloud: false }, "no_reader"], [{ phone: () => ({ ok: false, error: "HTTP 500" }) }, "phone:HTTP 500"], [{ phone: () => new Error("socket hang up") }, "socket hang up"],
    [{ phone: () => ({ ...GREEN(), checkedAt: iso(AT_17 - 20 * 60_000) }) }, "phone_read_stale"], [{ tplOk: false }, "templates_not_read"]]) {
    const w = world({ jobs: [J()], queue: [R(1), R(2)], ...x });
    const r = await w.api.cloudTick();
    assert.deepEqual([r.reason, r.detail, r.held], ["quality_unreadable", detail, true], detail);
    assert.equal(w.calls.length, 0, `${detail}: nothing sent`);
    assert.deepEqual([w.db.jobs[0].status, w.db.state.stopped_reason, w.db.sms.length], ["running", null, 0], `${detail}: hold, not a stop`);
  }
  // قراءة قديمة ⇒ بنطلب قراءة جديدة مرة قبل ما نرفض
  const stale = world({ jobs: [J()], queue: [R(1)], phone: () => ({ ...GREEN(), checkedAt: iso(AT_17 - 20 * 60_000) }) });
  await stale.api.cloudTick();
  assert.deepEqual([stale.reads.phone, stale.reads.fresh], [2, 1]);
}));

test("جودة الرقم YELLOW: كل حملات Cloud تقف في نفس الدورة، السبب quality_YELLOW، وتنبيه واحد للمالك (SMS + بورتال) — ومن غير أرقام عملاء", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J(), J({ id: 2 }), J({ id: 3, channel: "wa_web" })], queue: [R(1), R(2, { job_id: 2 })], phone: () => ({ ...GREEN(), quality: "YELLOW" }) });
  const r = await w.api.cloudTick();
  assert.deepEqual([r.reason, r.stopped, r.paused], ["quality_YELLOW", true, 2]);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.db.jobs.map((j) => [j.status, j.stop_reason]), [["paused", "quality_YELLOW"], ["paused", "quality_YELLOW"], ["running", null]], "حملة واتساب ويب مالهاش دعوة");
  assert.equal(w.db.state.stopped_reason, "quality_YELLOW");
  assert.equal(w.db.sms.length, 1); assert.equal(w.db.sms[0].phoneNorm, "500000001"); assert.equal(w.db.sms[0].kind, "staff"); assert.match(w.db.sms[0].body, /WhatsApp campaigns paused/);
  assert.deepEqual(w.db.broadcasts.map(([ev, x]) => [ev, x.kind, x.reason, x.paused]), [["wa_quality", "quality_stop", "quality_YELLOW", 2]]);
  assert.ok(!JSON.stringify(w.db.broadcasts).includes("5200"), "no customer phone in the alert");
  assert.deepEqual([w.db.state.quality.lastStop.reason, w.db.state.quality.lastStop.paused], ["quality_YELLOW", 2]);
  // دورة تانية: واقفة، ومفيش تنبيه تاني
  const r2 = await w.api.cloudTick();
  assert.equal(r2.reason, "stopped"); assert.equal(w.db.sms.length, 1); assert.equal(w.calls.length, 0);
}));

test("ويب هوك جودة YELLOW لقالب حملة شغّالة ⇒ الحملة تقف في أول دورة (حتى لو قراءة ميتا لسه GREEN)", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1), R(2)], templates: [{ name: "fc_offer_img", status: "APPROVED", quality: "GREEN" }] });
  const ok = await w.api.cloudTick();
  assert.equal(ok.sent, 2); assert.equal(w.calls.length, 2);
  w.db.queue.push(R(3), R(4));
  await w.wa.processWebhook({ entry: [{ id: "WABA1", changes: [{ field: "message_template_quality_update",
    value: { previous_quality_score: "GREEN", new_quality_score: "YELLOW", message_template_id: 99, message_template_name: "fc_offer_img", message_template_language: "ar" } }] }] });
  assert.deepEqual(w.db.events.map((e) => [e.kind, e.state, e.name]), [["template", "YELLOW", "fc_offer_img"]]);
  const r = await w.api.cloudTick();
  assert.deepEqual([r.reason, r.detail, r.stopped], ["quality_template_YELLOW", "fc_offer_img", true]);
  assert.equal(w.calls.length, 2, "ولا رسالة بعد الحدث");
  assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].stop_reason, w.db.state.stopped_reason], ["paused", "quality_template_YELLOW", "quality_template_YELLOW"]);
  assert.equal(w.db.sms.length, 1);
  assert.equal(w.db.state.quality.lastEventId, 1, "الحدث اتعلّم «اتعالج» — مايوقّفش تاني بعد ما المالك يرجّع");
}));

test("ويب هوك «الرقم اتعلّم عليه» أو مخالفة حساب ⇒ إيقاف؛ والرجوع للمالك بس، وبقراءة جديدة من ميتا", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1), R(2)] });
  await w.wa.processWebhook({ entry: [{ id: "WABA1", changes: [{ field: "phone_number_quality_update", value: { display_phone_number: "966546715683", event: "FLAGGED", current_limit: "TIER_250" } }] }] });
  const r = await w.api.cloudTick();
  assert.deepEqual([r.reason, w.db.jobs[0].status, w.calls.length], ["quality_flagged", "paused", 0]);
  // التسويق مايقدرش يرجّع القناة ولا الحملة
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { enabled: true }, auth: MK })).status, 403);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" }, auth: MK })).status, 403);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/all/:action", { param: { action: "resume" }, auth: MK })).body.changed, 0);
  assert.deepEqual([w.db.jobs[0].status, w.db.state.stopped_reason], ["paused", "quality_flagged"]);
  // المالك: يرجّع القناة ويكمّل الحملة
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { enabled: true } })).status, 200);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" } })).status, 200);
  assert.deepEqual([w.db.jobs[0].status, w.db.state.stopped_reason], ["running", null]);
  const before = w.reads.fresh;
  const again = await w.api.cloudTick();
  assert.equal(w.reads.fresh, before + 1, "أول دورة بعد الرجوع بتقرا من ميتا مش من الكاش");
  assert.equal(again.sent, 2, JSON.stringify(again)); assert.ok(w.db.state.quality.lastStop.resumedAt);
  // مخالفة حساب
  const a = world({ jobs: [J()], queue: [R(1)] });
  await a.wa.processWebhook({ entry: [{ id: "WABA1", changes: [{ field: "account_update", value: { event: "ACCOUNT_VIOLATION" } }] }] });
  assert.equal((await a.api.cloudTick()).reason, "quality_account");
}));

test("نزول حد الرسايل بين دورتين ⇒ إيقاف؛ وطلوعه مش مشكلة", withEnv(ALLOW, async () => {
  let tier = "TIER_1K";
  const w = world({ jobs: [J()], queue: [R(1), R(2), R(3)], settings: { waCloud: { enabled: true, perTick: 1 } }, phone: () => ({ ...GREEN(), tier }) });
  assert.equal((await w.api.cloudTick()).sent, 1); assert.equal(w.db.state.quality.tier, "TIER_1K");
  tier = "TIER_250";
  const r = await w.api.cloudTick();
  assert.deepEqual([r.reason, r.detail, w.db.jobs[0].status], ["quality_tier_down", "TIER_1K>TIER_250", "paused"]);
  assert.equal(w.db.state.quality.tier, "TIER_250", "الحد الجديد اتسجّل: النزول مايتحسبش مرتين بعد ما المالك يرجّع");
}));

test("السلّم في الدورة: ٣٠ في اليوم أول ٣ أيام، بيبدأ مع أول رسالة، والطلوع المرفوض بيتسجّل بسببه ويظهر في اللوحة", withEnv(ALLOW, async () => {
  // أول مرة: مفيش حالة ⇒ سقف ٣٠ والسلّم بيبدأ النهارده
  const a = world({ jobs: [J()], queue: [R(1), R(2)], warmup: null });
  assert.equal((await a.api.cloudTick()).sent, 2);
  assert.deepEqual([a.db.state.warmup.step, a.db.state.warmup.since, a.db.state.warmup.startedAt], [0, TODAY, TODAY]);
  // ٣٠ اتبعتوا النهارده ⇒ خلاص لبكرة
  const b = world({ jobs: [J()], queue: [R(1)], warmup: Q.warmupStart(TODAY), sentToday: 30 });
  const rb = await b.api.cloudTick();
  assert.deepEqual([rb.reason, rb.warmup.cap, b.calls.length], ["warmup_cap", 30, 0]);
  const b29 = world({ jobs: [J()], queue: [R(1), R(2), R(3)], warmup: Q.warmupStart(TODAY), sentToday: 29 });
  assert.equal((await b29.api.cloudTick()).sent, 1, "باقي رسالة واحدة تحت سقف الدرجة"); assert.equal(b29.calls.length, 1);
  // اليوم الرابع ونسبة «إيقاف» الدرجة ٢٪ ⇒ الطلوع مرفوض، بنفضل على ٣٠
  const since = "2026-10-10";
  const c = world({ jobs: [J()], queue: [...sentRows(50, (i) => ({ cloud_status: "read", sent_at: "2026-10-11T12:00:00Z", ...(i < 1 ? { optout_at: "2026-10-11T13:00:00Z" } : {}) })), R(60)],
    warmup: Q.warmupStart(since), sentToday: 30, settings: { waCloud: { enabled: true, brakeStopPct: 50 } } });
  const rc = await c.api.cloudTick();
  assert.deepEqual([rc.reason, rc.warmup.cap, rc.warmup.refused.why, c.db.state.warmup.step], ["warmup_cap", 30, "stop_rate", 0]);
  assert.equal(c.db.jobs[0].status, "running", "الرفض بيثبّت السقف بس — مابيوقّفش الحملة");
  const info = (await call(c.app, "GET /api/cms/wa-sender")).body.cloud;
  assert.deepEqual([info.warmup.step, info.warmup.cap, info.warmup.day, info.warmup.due, info.warmup.refused.why, info.warmup.refused.stopPct, info.effectiveDailyCap], [1, 30, 4, true, "stop_rate", 2, 30]);
  assert.equal(info.pace.reason, "warmup_cap");
  // نسبة نضيفة ⇒ يطلع ٥٠ في نفس الدورة ويكمّل
  const d = world({ jobs: [J()], queue: [...sentRows(50, () => ({ cloud_status: "read", sent_at: "2026-10-11T12:00:00Z" })), R(60)], warmup: Q.warmupStart(since), sentToday: 30 });
  const rd = await d.api.cloudTick();
  assert.equal(rd.sent, 1, JSON.stringify(rd)); assert.deepEqual([d.db.state.warmup.step, d.db.state.warmup.since], [1, TODAY]);
}));

test("سقف العميل في الحارس: قالب تسويقي واحد في ٧ أيام و٣ في ٣٠ يوم — من أي مصدر؛ الخدمي والتجربة مش داخلين؛ وماقدرناش نعدّ = مانبعتش", withEnv(ALLOW, async () => {
  const pn = "520000001";
  const g = (w, x = {}) => w.wa.guardSend({ phoneNorm: pn, kind: "template", template: "fc_offer_img", source: "campaign", purpose: "marketing", ...x });
  assert.equal((await g(world())).ok, true);
  assert.deepEqual(await g(world({ mk: { [pn]: { d7: 1, d30: 1 } } })), { ok: false, reason: "marketing_cap_7d" });
  assert.deepEqual(await g(world({ mk: { [pn]: { d7: 0, d30: 3 } } })), { ok: false, reason: "marketing_cap_30d" });
  assert.equal((await g(world({ mk: { [pn]: { d7: 0, d30: 2 } } }))).ok, true);
  // أتمتة (قالب تسويقي من غير source=campaign) بتتعدّ برضه
  assert.equal((await g(world({ mk: { [pn]: { d7: 1, d30: 1 } } }), { source: null, purpose: null })).reason, "marketing_cap_7d");
  assert.deepEqual(await g(world({ mkThrows: true })), { ok: false, reason: "marketing_cap_unreadable" });
  // المالك وسّع السقف من الإعدادات
  assert.equal((await g(world({ mk: { [pn]: { d7: 1, d30: 1 } }, settings: { waCloud: { enabled: true, custCap7d: 2 } } }))).ok, true);
  // قالب خدمي: السقف مالوش دعوة (بيقف على موافقة التحديثات زي الأول)
  assert.equal((await world({ mk: { [pn]: { d7: 5, d30: 9 } } }).wa.guardSend({ phoneNorm: pn, kind: "template", template: "fc_order_received", orderNo: "W1" })).reason, "no_optin");
  // تجربة لرقم تجربة: مش داخلة في السقف
  const t = world({ mk: { 544775082: { d7: 9, d30: 9 } }, settings: { waBot: { testPhones: ["0544775082"] } } });
  assert.equal((await t.wa.guardSend({ phoneNorm: "544775082", kind: "template", template: "fc_offer_img", source: "campaign", test: true })).ok, true);
}));

test("الدورة: اللي وصل سقفه بيتخطّى بسببه والباقي يكمّل؛ وماقدرناش نعدّ ⇒ الدورة تقف والصف يرجع للطابور", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1), R(2), R(3)], mk: { 520000001: { d7: 1, d30: 1 }, 520000002: { d7: 0, d30: 3 } } });
  const r = await w.api.cloudTick();
  assert.deepEqual([r.sent, r.skipped], [1, 2]);
  assert.deepEqual(w.db.queue.map((q) => [q.status, q.reason || null]), [["skipped", "marketing_cap_7d"], ["skipped", "marketing_cap_30d"], ["sent", null]]);
  assert.equal(w.calls.length, 1); assert.equal(w.db.jobs[0].status, "running");
  const x = world({ jobs: [J()], queue: [R(1), R(2)], mkThrows: true });
  const rx = await x.api.cloudTick();
  assert.deepEqual([rx.reason, rx.sent, x.calls.length, x.db.queue[0].status], ["marketing_cap_unreadable", 0, 0, "pending"]);
}));

test("فاصل واتساب على Cloud ٧ أيام (الـSMS وواتساب ويب ٣ زي ما هم)، والمعاينة بتشيل اللي وصل سقفه", withEnv(ALLOW, async () => {
  const CL = { channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "كيلو بـ96" }, filters: { audience: "lapsed" } };
  const w = world({ mk: { 510000001: { d7: 1, d30: 1 } } });
  const r = await call(w.app, "POST /api/cms/wa-sender/preview", { json: CL, auth: MK });
  assert.equal(r.status, 200); assert.deepEqual([r.body.willQueue, r.body.excluded.waCap], [2, 1]);
  assert.deepEqual(w.db.gapDays, ["7"]);
  assert.deepEqual(r.body.capacity.custCap, { d7: 1, d30: 3, gapDays: 7 });
  assert.deepEqual([r.body.capacity.warmup.finished, r.body.capacity.perDay], [true, 200]);
  const web = world({ mk: { 510000001: { d7: 1, d30: 1 } } });
  const rw = await call(web.app, "POST /api/cms/wa-sender/preview", { json: { channel: "wa_web", filters: { audience: "lapsed" } }, auth: MK });
  assert.deepEqual([rw.body.willQueue, rw.body.excluded.waCap, rw.body.appOnly], [3, undefined, undefined], "واتساب ويب زي ما هو");
  assert.deepEqual(web.db.gapDays, ["3"]);
  // وقت الإرسال: اتكلّم على واتساب من ٥ أيام ⇒ gap_7d
  const t = world({ jobs: [J()], queue: [R(1), R(2)], waContacts: ["520000001"] });
  await t.api.cloudTick();
  assert.deepEqual(t.db.queue.map((q) => [q.status, q.reason || null]), [["skipped", "gap_7d"], ["sent", null]]);
  // سلّم لسه في أوله ⇒ السعة في المعاينة ٣٠ في اليوم
  const fresh = world({ warmup: null });
  assert.equal((await call(fresh.app, "POST /api/cms/wa-sender/preview", { json: CL, auth: MK })).body.capacity.perDay, 30);
}));

test("131049 (ميتا حدّت العميل): مش فشل — مابيوقّفش الحملة، مابيبعتش SMS بديل إلا لو المالك فعّله، وبيتعدّ لوحده", withEnv(ALLOW, async () => {
  // ٢٧ اتبعتوا + ١٠ ميتا حدّتهم: بالحساب القديم ٢٧٪ فشل ⇒ تقف. دلوقتي بتكمّل.
  const capped = (i) => R(100 + i, { status: "failed", cloud_status: "failed", error_code: 131049, reason: "meta_marketing_limit" });
  const w = world({ jobs: [J()], queue: [...sentRows(27), ...Array.from({ length: 10 }, (_, i) => capped(i)), R(200)], settings: { waCloud: { enabled: true, lowReadPct: 0 } } });
  const r = await w.api.cloudTick();
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(w.db.jobs[0].status, "running");
  // نفس العدد بفشل حقيقي ⇒ تقف
  const real = world({ jobs: [J()], queue: [...sentRows(27), ...Array.from({ length: 10 }, (_, i) => ({ ...capped(i), error_code: 131026 })), R(200)], settings: { waCloud: { enabled: true, lowReadPct: 0 } } });
  await real.api.cloudTick();
  assert.match(real.db.jobs[0].stop_reason, /^fail_rate:/);
  // الإرسال نفسه رجع 131049 والحملة بديلها SMS ⇒ مفيش SMS
  const s1 = world({ jobs: [J({ fallback: "sms" })], queue: [R(1)] }); s1.fail(131049);
  const r1 = await s1.api.cloudTick();
  assert.deepEqual([r1.failed, s1.db.queue[0].reason, s1.db.queue[0].error_code, s1.db.smsFallback.length], [1, "meta_marketing_limit", 131049, 0]);
  // المالك فعّل cappedFallbackSms ⇒ الـSMS البديل يرجع
  const s2 = world({ jobs: [J({ fallback: "sms" })], queue: [R(1)], settings: { waCloud: { enabled: true, cappedFallbackSms: true } } }); s2.fail(131049);
  await s2.api.cloudTick();
  assert.equal(s2.db.smsFallback.length, 1);
  // حملة بديلها واتساب ويب: الصف يفضل «فشل» ومايرجعش للإضافة
  const s4 = world({ jobs: [J({ fallback: "wa_web" })], queue: [R(1)] }); s4.fail(131049);
  await s4.api.cloudTick();
  assert.deepEqual([s4.db.queue[0].status, s4.db.queue[0].channel, s4.db.queue[0].fallback_from || null], ["failed", "wa_cloud", null]);
  // رقم مش على واتساب (131026): الـSMS البديل زي ما كان
  const s3 = world({ jobs: [J({ fallback: "sms" })], queue: [R(1)] }); s3.fail(131026);
  await s3.api.cloudTick();
  assert.equal(s3.db.smsFallback.length, 1);
}));

test("قراءة ضعيفة: الحملة تقف بسبب low_read؛ وبعد «كمّل» من المالك العدّ بيبدأ من جديد", withEnv(ALLOW, async () => {
  const rows = sentRows(60, (i) => ({ cloud_status: i < 20 ? "read" : "delivered" }));      // ٣٣٪ مقروء، من ٧ ساعات
  const w = world({ jobs: [J()], queue: [...rows, R(100)] });
  const r = await w.api.cloudTick();
  assert.equal(w.db.jobs[0].status, "paused"); assert.equal(w.db.jobs[0].stop_reason, "low_read:33.3"); assert.equal(w.calls.length, 0, JSON.stringify(r));
  // المالك كمّلها ⇒ الرسايل القديمة مابتتحسبش تاني
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" } })).status, 200);
  assert.equal(w.db.jobs[0].brake_ack_at, iso(AT_17));
  const again = await w.api.cloudTick();
  assert.equal(again.sent, 1, JSON.stringify(again)); assert.equal(w.db.jobs[0].status, "running");
  // لسه ماعدّاش ٦ ساعات ⇒ مفيش فرملة
  const early = world({ jobs: [J()], queue: [...sentRows(60, () => ({ sent_at: iso(AT_17 - 2 * 3600_000) })), R(100)] });
  assert.equal((await early.api.cloudTick()).sent, 1);
}));

test("التحذير ١٪: الحملة تكمّل بنص السرعة، والمالك ياخد تنبيه واحد بس للحملة", withEnv(ALLOW, async () => {
  const rows = sentRows(100, (i) => ({ cloud_status: "read", ...(i < 1 ? { optout_at: "x" } : {}) }));      // ١٪ «إيقاف»
  const w = world({ jobs: [J()], queue: [...rows, ...Array.from({ length: 8 }, (_, i) => R(200 + i))] });
  const r = await w.api.cloudTick();
  assert.deepEqual([r.sent, r.halved, w.db.jobs[0].status], [2, true, "running"], "perTick ٥ ⇒ ٢");
  assert.equal(w.db.sms.length, 1); assert.match(w.db.sms[0].body, /1% stop rate/);
  assert.deepEqual(w.db.broadcasts.map(([ev, x]) => [ev, x.kind, x.jobId, x.pct]), [["wa_quality", "campaign_warn", 1, 1]]);
  await w.api.cloudTick();
  assert.equal(w.db.sms.length, 1, "تنبيه واحد للحملة");
  // تحت ١٪ ⇒ السرعة الكاملة
  const ok = world({ jobs: [J()], queue: [...sentRows(100, () => ({ cloud_status: "read" })), ...Array.from({ length: 8 }, (_, i) => R(200 + i))] });
  const ro = await ok.api.cloudTick();
  assert.deepEqual([ro.sent, ro.halved, ok.db.sms.length], [5, undefined, 0]);
}));

test("أرقام تطبيقات التوصيل: المعاينة بتعرض العدد والنص، والبدء محتاج تأكيد المالك بنفس العدد", withEnv(ALLOW, async () => {
  const CL = { channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "كيلو بـ96" }, filters: { audience: "lapsed" } };
  const w = world({ appOnly: ["510000000", "510000002"] });
  const pv = await call(w.app, "POST /api/cms/wa-sender/preview", { json: CL, auth: MK });
  assert.deepEqual(pv.body.appOnly, { count: 2, label: "أرقام من تطبيقات التوصيل — لم يعطونا رقمهم مباشرة", needsConfirm: true });
  const no = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...CL, confirmCount: 3 } });
  assert.equal(no.status, 409); assert.equal(no.body.error, "app_only_confirm_required"); assert.equal(no.body.appOnly.count, 2);
  assert.match(no.body.message, /2 رقم «أرقام من تطبيقات التوصيل — لم يعطونا رقمهم مباشرة»/);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...CL, confirmAppOnly: 1 } })).body.error, "app_only_confirm_required");
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...CL, confirmAppOnly: true } })).body.error, "app_only_confirm_required", "true مش عدد");
  assert.equal(w.db.newJobs.length, 0);
  const ok = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...CL, confirmAppOnly: 2 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(w.db.newJobs[0][16], 2, "العدد اللي اتأكد عليه بيتحفظ مع الحملة");
  assert.equal(w.calls.length, 0);
  // مفيش أرقام تطبيقات ⇒ مفيش تأكيد
  const none = world();
  assert.deepEqual((await call(none.app, "POST /api/cms/wa-sender/preview", { json: CL, auth: MK })).body.appOnly, { count: 0, label: "أرقام من تطبيقات التوصيل — لم يعطونا رقمهم مباشرة", needsConfirm: false });
  assert.equal((await call(none.app, "POST /api/cms/wa-sender/jobs", { json: CL })).status, 200);
  // ماقدرناش نعدّ ⇒ مانبدأش
  const bad = world({ appOnlyThrows: true });
  const rb = await call(bad.app, "POST /api/cms/wa-sender/jobs", { json: { ...CL, confirmAppOnly: 0 } });
  assert.equal(rb.status, 409); assert.equal(rb.body.error, "app_only_unreadable"); assert.equal(bad.db.newJobs.length, 0);
  // حملة واتساب ويب: مفيش السؤال ده (زي ما كانت)
  const web = world({ appOnly: ["510000000"] });
  assert.equal((await call(web.app, "POST /api/cms/wa-sender/jobs", { json: { channel: "wa_web", filters: { audience: "lapsed" } }, auth: MK })).status, 200);
}));

test("اللوحة: حالة البوابة والسلّم وسقف العميل في رد الحالة؛ ورفع أي حد للمالك بس", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1)], warmup: Q.warmupStart(TODAY) });
  await w.api.cloudTick();
  const c = (await call(w.app, "GET /api/cms/wa-sender", { auth: MK })).body.cloud;
  assert.deepEqual([c.qualityGate.last.ok, c.qualityGate.last.state, c.qualityGate.stoppedByQuality, c.qualityGate.ownerResumeOnly, c.qualityGate.seen.tier], [true, "GREEN", false, true, "TIER_250"]);
  assert.deepEqual([c.warmup.started, c.warmup.step, c.warmup.cap, c.warmup.day, c.warmup.stepDays, c.warmup.stepsTotal], [true, 1, 30, 1, 3, 3]);
  assert.deepEqual(c.custCap, { d7: 1, d30: 3, gapDays: 7 });
  assert.deepEqual([c.cfg.brakeStopPct, c.cfg.brakeMinSends, c.cfg.brakeWarnPct, c.defaults.brakeStopPct, c.defaults.custCap7d], [2, 30, 1, 2, 1]);
  for (const k of ["custCap7d", "allowUnknownQuality", "warmup", "lowReadPct"]) assert.ok(c.ceilingKeys.includes(k));
  // التسويق مايقدرش يغيّر ولا حد؛ المالك يقدر، وبحدود
  for (const json of [{ custCap7d: 3 }, { allowUnknownQuality: true }, { brakeStopPct: 50 }, { warmup: { steps: [{ days: 1, cap: 1000 }] } }, { cappedFallbackSms: true }, { enabled: false, lowReadPct: 0 }]) {
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json, auth: MK })).status, 403, JSON.stringify(json));
  }
  assert.equal(w.db.settings.waCloud.custCap7d, undefined);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { enabled: false }, auth: MK })).status, 200, "الإيقاف لأي حد");
  const own = await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { custCap7d: 9, allowUnknownQuality: true, warmup: { steps: [{ days: 2, cap: 40 }] } } });
  assert.deepEqual([own.status, own.body.cfg.custCap7d, own.body.cfg.allowUnknownQuality, own.body.cfg.warmup.steps], [200, 3, true, [{ days: 2, cap: 40 }]]);
  // UNKNOWN: افتراضياً إيقاف، وبمفتاح المالك يعدّي
  const u = world({ jobs: [J()], queue: [R(1)], phone: () => ({ ...GREEN(), quality: "UNKNOWN" }) });
  assert.equal((await u.api.cloudTick()).reason, "quality_UNKNOWN");
  const u2 = world({ jobs: [J()], queue: [R(1)], phone: () => ({ ...GREEN(), quality: "UNKNOWN" }), settings: { waCloud: { enabled: true, allowUnknownQuality: true } } });
  assert.equal((await u2.api.cloudTick()).sent, 1);
}));

test("جودة القوالب من ميتا: لو الحقل اترفض شاشات القوالب تفضل شغّالة بالحقول القديمة، والبوابة توقف التسويق وتقول ليه", withEnv(ALLOW, async () => {
  const urls = [];
  const fetch = async (url) => { const u = String(url); urls.push(u);
    if (/quality_score/.test(u)) return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (quality_score)" } }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ name: "fc_offer_img", status: "APPROVED", category: "MARKETING", language: "ar" }] }) }; };
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const api = C.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify }, { fetch, wa: { token: () => "tok", wabaId: () => "WABA1", phoneId: () => "P1" } });
  const t = await api.templateInfo({ fresh: true });
  assert.deepEqual([t.ok, t.qualityRead, t.total, t.list[0].status, t.list[0].quality], [true, false, 1, "APPROVED", null]);
  assert.equal(urls.filter((u) => /message_templates/.test(u)).length, 3, "بالمكوّنات والجودة ⇒ بالجودة ⇒ الحقول القديمة");
  // الحقل مقبول ⇒ الجودة بتتقري
  const ok = C.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify },
    { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ name: "fc_offer_img", status: "APPROVED", category: "MARKETING", language: "ar", quality_score: { score: "YELLOW" } }] }) }), wa: { token: () => "tok", wabaId: () => "WABA1", phoneId: () => "P1" } });
  const t2 = await ok.templateInfo({ fresh: true });
  assert.deepEqual([t2.qualityRead, t2.list[0].quality], [true, "YELLOW"]);
}));

test("الدورة: جودة القوالب مش مقروءة (qualityRead=false) ⇒ ولا رسالة، والسبب template_quality_not_read؛ ولو الرقم YELLOW الإيقاف بيغلب", withEnv(ALLOW, async () => {
  // world بيبني قارئ ميتا جوّاه، فبنسجّل مُرسل تاني على نفس القاعدة بقارئ «حالات القوالب مقروءة بس جودتها لأ»
  const build = (phone) => { const w = world({ jobs: [J()], queue: [R(1)] });
    const api = S.register(fakeApp(), { pool: w.pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(w.db.settings)), jb: JSON.stringify, normPhone: String },
      { wa: w.wa, cloudLoop: false, lock: false, now: () => AT_17, cms: () => null, sendSms: async (m) => { w.db.sms.push(m); return { ok: true }; },
        cloud: () => ({ phoneInfo: async () => (phone ? phone() : GREEN()), templateInfo: async () => ({ ok: true, qualityRead: false, list: [{ name: "fc_offer_img", status: "APPROVED", quality: null }] }) }) });
    return { w, api }; };
  const a = build(null);
  const r = await a.api.cloudTick();
  assert.deepEqual([r.reason, r.detail, r.held, a.w.calls.length, a.w.db.jobs[0].status], ["quality_unreadable", "template_quality_not_read", true, 0, "running"]);
  const b = build(() => ({ ...GREEN(), quality: "YELLOW" }));
  const rb = await b.api.cloudTick();
  assert.deepEqual([rb.reason, rb.stopped, b.w.db.jobs[0].status], ["quality_YELLOW", true, "paused"]);
}));

test("ترحيل الإقلاع: ٥٪/٢٠ المخزّنين بيتكتبوا ٢٪/٣٠ مرة واحدة", async () => {
  const saved = [];
  const mk = (waCloud) => { const settings = { waCloud };
    const pool = { query: async (sql, p = []) => { if (/^\s*UPDATE settings SET data = jsonb_set/.test(String(sql))) { settings.waCloud = JSON.parse(p[0]); saved.push(settings.waCloud); } return { rows: [], rowCount: 0 }; } };
    return { settings, api: C.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(settings)), jb: JSON.stringify }, {}) }; };
  const a = mk({ enabled: false, dailyCap: 200, brakeStopPct: 5, brakeMinSends: 20, spendDaySar: 50 });
  assert.equal(await a.api.qualityMigrated, true);
  assert.deepEqual([a.settings.waCloud.brakeStopPct, a.settings.waCloud.brakeMinSends, a.settings.waCloud.rev, a.settings.waCloud.dailyCap, a.settings.waCloud.enabled], [2, 30, 2, 200, false]);
  const b = mk({ ...a.settings.waCloud, brakeStopPct: 5 });          // المالك رجّعها ٥ بعد الترحيل
  assert.equal(await b.api.qualityMigrated, false); assert.equal(b.settings.waCloud.brakeStopPct, 5);
  assert.equal(await mk(undefined).api.qualityMigrated, false, "مفيش حاجة مخزّنة ⇒ الافتراضي الجديد لوحده");
  assert.equal(saved.length, 1);
});

/* ══ RF1 (١٤/١٠): «اتقرت» في الحملات + الضغطات بصدق + إطارات «الرد أولاً» ═══════════════ */
const BOTRUN = await import("./wabotrun.js");
const statusHook = (wamid, status, at = null) => ({ entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1", display_phone_number: "966546715683" },
  statuses: [{ id: wamid, status, recipient_id: "966520000001", ...(at ? { timestamp: String(Math.floor(Date.parse(at) / 1000)) } : {}) }] } }] }] });
const typedHook = (from, text, id) => ({ entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1", display_phone_number: "966546715683" },
  messages: [{ id, from, type: "text", timestamp: String(Math.floor(AT_17 / 1000)), text: { body: text } }] } }] }] });
const tapHook = (from, text, id) => ({ entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PHONE1", display_phone_number: "966546715683" },
  messages: [{ id, from, type: "button", timestamp: String(Math.floor(AT_17 / 1000)), button: { text, payload: text } }] } }] }] });

test("RF1 «اتقرت»: حالة read لرسالة حملة بتوصل للجدولين (wa_messages + صف الطابور) بأي ترتيب، ومفيش فلتر على المصدر ولا رجوع للحالة", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1), R(2), R(3)] });
  assert.equal((await w.api.cloudTick()).sent, 3);
  const [a, b, c] = w.db.queue.map((q) => q.wamid);
  assert.deepEqual(w.db.msgs.map((m) => [m.wamid, m.template, m.source, m.status]), [[a, "fc_offer_img", "campaign", "accepted"], [b, "fc_offer_img", "campaign", "accepted"], [c, "fc_offer_img", "campaign", "accepted"]]);
  // الترتيب العادي: sent ⇒ delivered ⇒ read
  for (const st of ["sent", "delivered", "read"]) await w.wa.processWebhook(statusHook(a, st, "2026-10-13T14:05:00Z"));
  assert.equal(w.db.msgs[0].status, "read");
  assert.deepEqual([w.db.queue[0].cloud_status, w.db.queue[0].delivered_at, w.db.queue[0].read_at], ["read", "2026-10-13T14:05:00.000Z", "2026-10-13T14:05:00.000Z"]);
  // read قبل delivered (ميتا بتعملها): تفضل read
  await w.wa.processWebhook(statusHook(b, "read", "2026-10-13T14:06:00Z")); await w.wa.processWebhook(statusHook(b, "delivered", "2026-10-13T14:07:00Z"));
  assert.deepEqual([w.db.msgs[1].status, w.db.queue[1].cloud_status, w.db.queue[1].read_at, w.db.queue[1].delivered_at], ["read", "read", "2026-10-13T14:06:00.000Z", "2026-10-13T14:06:00.000Z"]);
  // delivered بس: مش مقروءة
  await w.wa.processWebhook(statusHook(c, "delivered"));
  assert.deepEqual([w.db.msgs[2].status, w.db.queue[2].cloud_status, w.db.queue[2].read_at || null], ["delivered", "delivered", null]);
  // read متكررة مابتغيّرش وقت القراءة الأول
  await w.wa.processWebhook(statusHook(a, "read", "2026-10-13T15:00:00Z"));
  assert.equal(w.db.queue[0].read_at, "2026-10-13T14:05:00.000Z");
  assert.equal(w.db.unmatched.length, 0);
  // حالة لرسالة مالهاش صف عندنا: بتتعدّ في صحة الويب هوك بدل ما تضيع من غير أثر
  await w.wa.processWebhook(statusHook("wamid.UNKNOWN", "read"));
  assert.deepEqual(w.db.unmatched, ["read"]);
}));

test("RF1 التسوية: حالة وصلت لـwa_messages قبل ما الـwamid يتكتب على صف الطابور بتتنقل للصف — للأمام بس", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J()], queue: [R(1), R(2)] });
  await w.api.cloudTick();
  const [a, b] = w.db.queue.map((q) => q.wamid);
  // محاكاة السباق: wa_messages اتحدّثت والطابور لأ
  w.db.msgs[0].status = "read"; w.db.msgs[0].updated_at = "2026-10-13T14:09:00.000Z";
  w.db.msgs[1].status = "delivered"; w.db.msgs[1].updated_at = "2026-10-13T14:08:00.000Z";
  w.db.queue[1].cloud_status = "read"; w.db.queue[1].read_at = "2026-10-13T14:01:00.000Z";      // الطابور سابق: مايرجعش
  assert.equal(await w.api.reconcileStatuses(), 1);
  assert.deepEqual([w.db.queue[0].cloud_status, w.db.queue[0].read_at, w.db.queue[0].delivered_at], ["read", "2026-10-13T14:09:00.000Z", "2026-10-13T14:09:00.000Z"]);
  assert.deepEqual([w.db.queue[1].cloud_status, w.db.queue[1].read_at], ["read", "2026-10-13T14:01:00.000Z"]);
  assert.equal(await w.api.reconcileStatuses(), 0, "مرة تانية مفيش حاجة تتنقل");
  const sql = w.db.sqlLog.find((x) => /^UPDATE wa_send_queue q SET cloud_status = m\.status/.test(x));
  assert.ok(sql.includes("m.wamid = q.wamid") && sql.includes("m.status IN ('delivered','read')") && sql.includes("q.channel = 'wa_cloud'"));
  assert.ok(a && b);
}));

test("RF1 النتايج: ضغطات المستلمين (برابط العميل نفسه) لوحدها، وضغطات الرابط العام لوحدها", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J({ created_at: "2026-10-13T13:00:00Z" })], linkClicks: 9,
    queue: [R(1, { status: "sent", sent_at: "2026-10-13T13:10:00Z", clicks: 2 }), R(2, { status: "sent", sent_at: "2026-10-13T13:11:00Z", clicks: 1 }), R(3, { status: "sent", sent_at: "2026-10-13T13:12:00Z", clicks: 0 })] });
  const r = (await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } })).body;
  assert.deepEqual([r.clicks, r.recipientClicks, r.otherClicks, r.clickers, r.linkButton], [9, 3, 6, 2, true]);
  // قالب «الرد أولاً»: مفيش زر رابط
  const a = world({ jobs: [J({ cloud_template: "fc_frame_ask_text", image_url: null, created_at: "2026-10-13T13:00:00Z" })], linkClicks: 0, queue: [R(1, { status: "sent", sent_at: "2026-10-13T13:10:00Z", replied_at: "2026-10-13T13:20:00Z" })] });
  const ra = (await call(a.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } })).body;
  assert.deepEqual([ra.linkButton, ra.replies, ra.recipientClicks, ra.sent], [false, 1, 0, 1]);
}));

test("RF1 إطارات «الرد أولاً»: في الكتالوج بالعربي والإنجليزي، قابلة للتقديم، ٣ أزرار رد بس ومفيش زر رابط، والنص بالحرف", () => {
  const BODY = {
    "fc_frame_ask_video:ar": "من فريش كاتس 🎬\n{{1}}: {{2}}.\nتبي نجهز لك الطلب هنا؟ اضغط الزر وكمّل معنا في المحادثة.",
    "fc_frame_ask_video:en": "From Fresh Cuts 🎬\n{{1}}: {{2}}.\nWant us to prepare your order here? Tap a button and continue with us in this chat.",
    "fc_frame_ask_text:ar": "جديد من فريش كاتس 👋\n{{1}}: {{2}}.\nتبي نجهز لك الطلب هنا؟ اضغط الزر وكمّل معنا في المحادثة.",
    "fc_frame_ask_text:en": "New from Fresh Cuts 👋\n{{1}}: {{2}}.\nWant us to prepare your order here? Tap a button and continue with us in this chat." };
  for (const name of ["fc_frame_ask_video", "fc_frame_ask_text"]) {
    assert.ok(!CAT.HOLD[name], `${name} not held`); assert.ok(CAT.ASK_FRAME_BATCH.includes(name)); assert.equal(CAT.SUBMIT_BATCHES.flat().filter((n) => n === name).length, 1);
    for (const lang of ["ar", "en"]) {
      const t = CAT.findTemplate(name, lang);
      assert.deepEqual(CAT.validateTemplate(t), [], `${name} ${lang}`);
      assert.equal(t.category, "MARKETING"); assert.equal(CAT.bodyOf(t), BODY[`${name}:${lang}`]);
      assert.deepEqual(CAT.buttonsOf(t).map((b) => [b.type, b.text]), lang === "ar"
        ? [["QUICK_REPLY", "أبغى أطلب"], ["QUICK_REPLY", "ورّني المنيو"]] : [["QUICK_REPLY", "I want to order"], ["QUICK_REPLY", "Show me the menu"]]);      // TS1: من غير زر «إيقاف»
      assert.equal(CAT.footerOf(t), lang === "ar" ? "للإيقاف ردّ: إيقاف" : "To stop, reply: STOP");
      assert.deepEqual(t.meta.vars.map((v) => v.path), ["offer.title", "offer.line"]); assert.deepEqual(t.meta.buttonVars, []);
    }
    assert.deepEqual(W.templateLanguages(name).sort(), ["ar", "en"]);
  }
  assert.deepEqual([...CAT.FRAME_BATCH], ["fc_frame_news_text", "fc_frame_offer_img", "fc_frame_limited_img", "fc_frame_video"], "دفعة إطارات الرابط زي ما هي");
  // في محرّك الحملات: قالب حملة من غير زر رابط
  const v = C.campaignSpec("fc_frame_ask_video"), t = C.campaignSpec("fc_frame_ask_text");
  assert.deepEqual([v.kind, v.header, v.button, v.needsCoupon, v.fields.map((f) => f.key)], ["catalog", "video", null, false, ["offer.title", "offer.line"]]);
  assert.deepEqual([t.header, t.button, t.held], [null, null, false]);
  const P = (x) => (C.cloudJobProblem(x) || [null])[0], vals = { values: { "offer.title": "بوكس التشكيلة", "offer.line": "مشاوي على الفحم، بـ105 ر.س" } };
  assert.equal(P({ cloudTemplate: "fc_frame_ask_text", cloudVars: vals }), null, "من غير صورة ولا رابط ولا كوبون");
  assert.equal(P({ cloudTemplate: "fc_frame_ask_video", cloudVars: vals }), "video_required");
  assert.equal(P({ cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "بوكس" } } }), "value_required");
  // أزرار الرد بنصها: البوت بيفهمها — «أبغى أطلب» طلب، «ورّني المنيو» المنيو، «إيقاف» إيقاف
  const key = (text) => BOTRUN.classify({ text, type: "button" }, {}).key;
  assert.deepEqual(["أبغى أطلب", "I want to order"].map(key), ["order", "order"]);
  assert.deepEqual(["ورّني المنيو", "ورني المنيو", "Show me the menu"].map(key), ["cats", "cats", "cats"]);
  assert.deepEqual(["أبغى أطلب", "ورّني المنيو", "I want to order", "Show me the menu"].map((x) => W.intentOf(x)), [null, null, null, null], "أزرار الطلب والمنيو مش إيقاف");
  assert.deepEqual(["إيقاف", "STOP"].map((x) => W.intentOf(x)), ["stop", "stop"]);
});

test("RF1 حملة «الرد أولاً»: بتتبعت من غير أي زر رابط؛ وضغطة العميل على زر الرد بتتحسب رد على الحملة (و«إيقاف» إيقاف)", withEnv(ALLOW, async () => {
  const ASK = { cloud_template: "fc_frame_ask_text", image_url: null, cloud_vars: { values: { "offer.title": "بوكسات فردية", "offer.line": "كريب أو برجر مع صنف جانبي ومشروب، من 29 ر.س" } } };
  for (const link_slug of ["w1", null]) {
    const w = world({ jobs: [J({ ...ASK, link_slug })], queue: [R(1), R(2)] });
    const r = await w.api.cloudTick();
    assert.equal(r.sent, 2, JSON.stringify(r));
    const p = w.calls[0].body;
    assert.deepEqual([p.type, p.template.name, p.template.language.code, p.to], ["template", "fc_frame_ask_text", "ar", "966520000001"]);
    assert.deepEqual(p.template.components, [{ type: "body", parameters: [{ type: "text", text: "بوكسات فردية" }, { type: "text", text: "كريب أو برجر مع صنف جانبي ومشروب، من 29 ر.س" }] }], "مفيش مكوّن زر: أزرار الرد ثابتة في القالب");
    assert.match(w.db.msgs[0].body, /تبي نجهز لك الطلب هنا؟/);
    // العميل ضغط «أبغى أطلب»
    await w.wa.processWebhook(tapHook("966520000001", "أبغى أطلب", "wamid.TAP1"));
    assert.deepEqual(w.db.replies.map((x) => [x.pn, x.text, x.job_id, x.optout]), [["520000001", "أبغى أطلب", 1, false]]);
    assert.ok(w.db.queue[0].replied_at); assert.equal(w.db.queue[0].optout_at || null, null);
    // التاني ضغط «إيقاف»
    await w.wa.processWebhook(typedHook("966520000002", "إيقاف", "wamid.TAP2"));      // TS1: «إيقاف» بقت بالكتابة (مفيش زر)
    assert.deepEqual(w.db.replies[1].optout, true); assert.ok(w.db.queue[1].optout_at);
  }
  // بدء حملة «الرد أولاً» من اللوحة: من غير link خالص، ومعاينتها بتقول إن مفيش زر رابط
  const s = world();
  const body = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: ASK.cloud_vars, filters: { audience: "lapsed" } };
  const pv = (await call(s.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
  assert.deepEqual([pv.problems, pv.spec.button, pv.link.button], [[], null, false]);
  assert.match(pv.sample[0].cloud.text, /تبي نجهز لك الطلب هنا؟/); assert.deepEqual(pv.sample[0].cloud.buttons, ["أبغى أطلب", "ورّني المنيو"]);
  const ok = await call(s.app, "POST /api/cms/wa-sender/jobs", { json: body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(s.db.newJobs[0][10], "fc_frame_ask_text");
}));

/* ══ TS1 (١٤/١٠): الإطارات من غير زر «إيقاف» + الكتالوج لازم يطابق نسخة ميتا ═══════════════ */
const FRAMES6 = ["fc_frame_offer_img", "fc_frame_limited_img", "fc_frame_video", "fc_frame_news_text", "fc_frame_ask_video", "fc_frame_ask_text"];

test("TS1 الإطارات الستة (عربي + إنجليزي) من غير زر «إيقاف»؛ الفوتر باقي، والكلمة المكتوبة لسه إيقاف؛ وباقي القوالب التسويقية بزرها", () => {
  for (const name of FRAMES6) for (const lang of ["ar", "en"]) {
    const t = CAT.findTemplate(name, lang), btns = CAT.buttonsOf(t);
    assert.deepEqual(CAT.validateTemplate(t), [], `${name} ${lang}`);
    assert.ok(!btns.some((b) => ["إيقاف", "STOP"].includes(b.text)), `${name} ${lang}: no stop button`);
    assert.equal(CAT.footerOf(t), lang === "ar" ? "للإيقاف ردّ: إيقاف" : "To stop, reply: STOP");
    assert.equal(t.meta.stopButton, false);
    const want = name.includes("_ask_") ? (lang === "ar" ? ["QUICK_REPLY:أبغى أطلب", "QUICK_REPLY:ورّني المنيو"] : ["QUICK_REPLY:I want to order", "QUICK_REPLY:Show me the menu"])
      : ["URL", lang === "ar" ? "QUICK_REPLY:أبغى أطلب" : "QUICK_REPLY:I want to order"];
    assert.deepEqual(btns.map((b) => (b.type === "URL" ? "URL" : `${b.type}:${b.text}`)), want, `${name} ${lang}`);
  }
  // الكلمة المكتوبة شغّالة زي ما هي
  for (const x of ["إيقاف", "ايقاف", "STOP", "stop", " إيقاف "]) assert.equal(W.intentOf(x), "stop", x);
  // القاعدة في الفاحص: إطار رجع له الزر = خطأ؛ وقالب تسويقي تاني من غير الزر = خطأ
  const f = CAT.findTemplate("fc_frame_ask_text", "ar");
  const withStop = { ...f, components: f.components.map((c) => (c.type === "BUTTONS" ? { ...c, buttons: [...c.buttons, { type: "QUICK_REPLY", text: "إيقاف" }] } : c)) };
  assert.deepEqual(CAT.validateTemplate(withStop), ["التسويق: القالب ده من غير زر «إيقاف» (الإيقاف بالكتابة)"]);
  const other = CAT.findTemplate("fc_weekend_offer", "ar");
  assert.ok(CAT.buttonsOf(other).some((b) => b.text === "إيقاف"), "القوالب التانية زي ما هي");
  const noStop = { ...other, components: other.components.map((c) => (c.type === "BUTTONS" ? { ...c, buttons: c.buttons.filter((b) => b.text !== "إيقاف") } : c)) };
  assert.deepEqual(CAT.validateTemplate(noStop), ["التسويق: زر «إيقاف» مطلوب"]);
});

test("TS1 مقارنة الكتالوج بنسخة ميتا: نفس النص والأزرار = متطابق؛ زر زيادة عند ميتا / نص مختلف / هيدر مختلف = مختلف", () => {
  const ours = W.TEMPLATES.fc_frame_ask_text.variants.ar;
  const meta = (extra = [], body = null) => [{ type: "BODY", text: body || ours.find((c) => c.type === "BODY").text, example: { body_text: [["a", "b"]] } }, { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "أبغى أطلب" }, { type: "QUICK_REPLY", text: "ورّني المنيو" }, ...extra] }];
  assert.deepEqual(C.templateDiff(ours, meta()), []);
  assert.deepEqual(C.templateDiff(ours, meta([{ type: "QUICK_REPLY", text: "إيقاف" }])), ["buttons"], "النسخة المعتمدة لسه فيها زر إيقاف");
  assert.deepEqual(C.templateDiff(ours, meta([], "نص تاني")), ["body"]);
  assert.deepEqual(C.templateDiff(ours, [{ type: "HEADER", format: "VIDEO" }, ...meta()]), ["header"]);
  assert.deepEqual(C.templateDiff(ours, meta().filter((c) => c.type !== "FOOTER")), ["footer"]);
  assert.deepEqual(C.templateDiff(ours, []), ["body", "footer", "buttons"]);
  // رابط الزر جزء من المقارنة
  const link = W.TEMPLATES.fc_frame_news_text.variants.ar, lm = JSON.parse(JSON.stringify(link));
  assert.deepEqual(C.templateDiff(link, lm), []);
  lm.find((c) => c.type === "BUTTONS").buttons[0].url = "https://freshcuts.sa/?c={{1}}";
  assert.deepEqual(C.templateDiff(link, lm), ["buttons"]);
});

test("TS1 حالة القالب قصاد ميتا من القراءة الحية: same / differs / missing / unknown — وبتظهر في قايمة الكتالوج", withEnv(ALLOW, async () => {
  const ours = (n, l = "ar") => JSON.parse(JSON.stringify(W.TEMPLATES[n].variants[l]));
  const old = ours("fc_frame_ask_text"); old.find((c) => c.type === "BUTTONS").buttons.push({ type: "QUICK_REPLY", text: "إيقاف" });
  const data = [{ name: "fc_frame_ask_text", language: "ar", status: "APPROVED", category: "MARKETING", components: old },
    { name: "fc_frame_news_text", language: "ar", status: "APPROVED", category: "MARKETING", components: ours("fc_frame_news_text") }];
  const mk = (fetch) => C.register(fakeApp(), { pool: { query: async () => ({ rows: [], rowCount: 0 }) }, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: JSON.stringify },
    { fetch, wa: { token: () => "tok", wabaId: () => "WABA1", phoneId: () => "P1" } });
  const api = mk(async () => ({ ok: true, status: 200, json: async () => ({ data }) }));
  assert.deepEqual(await api.templateSync("fc_frame_ask_text", "ar"), { state: "differs", status: "APPROVED", diffs: ["buttons"] });
  assert.deepEqual(await api.templateSync("fc_frame_news_text", "ar"), { state: "same", status: "APPROVED", diffs: [] });
  assert.deepEqual(await api.templateSync("fc_frame_video", "ar"), { state: "missing", status: "NOT_SUBMITTED", diffs: [] });
  assert.equal((await api.templateSync("fc_frame_news_text", "en")).state, "missing");
  const info = await api.templateInfo();
  assert.ok(!JSON.stringify(info.list).includes("components"), "مكوّنات ميتا مش في رد الحالة");
  const row = (n) => info.catalog.find((x) => x.name === n).sync;
  assert.deepEqual([row("fc_frame_ask_text"), row("fc_frame_news_text"), row("fc_frame_video")], [{ ar: "differs", en: "missing" }, { ar: "same", en: "missing" }, { ar: "missing", en: "missing" }]);
  // ميتا رفضت حقل components ⇒ الشاشات تفضل شغّالة والمقارنة «مش معروف»
  const noComps = mk(async (url) => (/components/.test(String(url)) ? { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "nope" } }) }
    : { ok: true, status: 200, json: async () => ({ data: data.map(({ components, ...x }) => x) }) }));
  assert.deepEqual(await noComps.templateSync("fc_frame_ask_text", "ar"), { state: "unknown", status: null, diffs: [], why: "components_not_read" });
  assert.equal((await noComps.templateInfo()).ok, true);
  const down = mk(async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 2, message: "down" } }) }));
  assert.equal((await down.templateSync("fc_frame_ask_text", "ar")).why, "meta_not_read");
}));

test("TS1 الحملة: قالب نسخته عند ميتا لسه مختلفة ⇒ المعاينة بتقول والبدء بيترفض؛ متطابق أو مش معروف ⇒ مفيش منع", withEnv(ALLOW, async () => {
  const body = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "بوكسات فردية", "offer.line": "كريب أو برجر، من 29 ر.س" } }, filters: { audience: "lapsed" } };
  const d = world({ tplSync: { state: "differs", status: "APPROVED", diffs: ["buttons"] } });
  const pv = (await call(d.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
  assert.deepEqual([pv.templateSync.state, pv.templateSync.diffs, pv.problems.map((p) => p.error)], ["differs", ["buttons"], ["template_differs"]]);
  assert.match(pv.templateSync.message, /لسه بالنسخة القديمة/);
  const no = await call(d.app, "POST /api/cms/wa-sender/jobs", { json: body });
  assert.deepEqual([no.status, no.body.error, no.body.templateSync.state], [409, "template_differs", "differs"]); assert.equal(d.db.newJobs.length, 0);
  for (const st of ["same", "unknown", "missing"]) {
    const w = world({ tplSync: { state: st, status: st === "same" ? "APPROVED" : null, diffs: [] } });
    const p = (await call(w.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
    assert.deepEqual([p.templateSync.state, p.problems], [st, []], st);
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs", { json: body })).status, 200, st);
  }
  // بعد التعديل: النص بقى زي الكتالوج بس ميتا لسه بتراجعه ⇒ ممنوع برضه (الإرسال بقالب مش معتمد بيوقّف القناة)
  const rv = world({ tplSync: { state: "same", status: "PENDING", diffs: [] } });
  const prv = (await call(rv.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
  assert.deepEqual(prv.problems.map((p) => p.error), ["template_not_approved"]); assert.match(prv.templateSync.message, /تحت المراجعة/);
  assert.deepEqual([(await call(rv.app, "POST /api/cms/wa-sender/jobs", { json: body })).status, rv.db.newJobs.length], [409, 0]);
  // من غير قارئ ميتا خالص: «مش معروف»
  assert.equal((await call(world({ cloud: false }).app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body.templateSync.state, "unknown");
  // حملة واتساب ويب: مفيش الفحص ده
  assert.equal((await call(d.app, "POST /api/cms/wa-sender/preview", { json: { channel: "wa_web", filters: { audience: "lapsed" } }, auth: MK })).body.templateSync, undefined);
}));

/* ══ FD1 (١٤/١٠): حملة «طبقك المفضل» — قيم القالب لكل مستلم + إعادة الحساب قبل كل رسالة ═══════════════ */
const FAVROW = (i, x = {}) => ({ pn: `56000000${i}`, name: `عميل ${i}`, orders: 5, spend: 400 - i, daysAgo: 12, webOrders: 0, lastTotal: 70, skippedSmall: 0, noMeaningfulOrder: false, adBlocked: false,
  favDish: "بيتزا تشيكن رانش", favGroup: "pizza",
  vars: { name: `عميل ${i}`, first_name: `عميل${i}`, fav_dish: "بيتزا تشيكن رانش", cloud: { values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": `عرض العميل ${i} بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST` } },
    fav: { v: 1, kind: "box", slug: "box-pizza-pasta", pid: "43", slot: "pizza", price: 69, at: iso(AT_17) } },
  favView: { kind: "box", catOnly: false, ref: "box-pizza-pasta", price: 69, delivery: "no_location", via: "FIRST", fee: null, far: false, loc: null, km: null },
  message: "", score: 1000 - i, ...x });
const favStub = (rows, checks = {}) => ({ audienceRows: async () => Object.assign([...rows], { stats: { phones: rows.length } }), recheck: async (q) => (q.phone_norm in checks ? checks[q.phone_norm] : null) });
const ASK_TEXT = (title, line) => `جديد من فريش كاتس 👋\n${title}: ${line}.\nتبي نجهز لك الطلب هنا؟ اضغط الزر وكمّل معنا في المحادثة.`;

test("FD1 الحملة: قالب «الرد أولاً» بس، على Cloud ومن غير كوبون؛ القيم لكل صف (perRecipient) ماتتبعتش من بره من غير الشريحة؛ campaignParams بياخد قيم الصف بس في الحملة دي", () => {
  const P = (b) => (S.jobInput({ filters: { audience: "fav_pick" }, ...b }, { hosts: [] }).errs[0] || [null])[0];
  assert.equal(P({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text" }), null);
  const fi = S.jobInput({ filters: { audience: "fav_pick" }, channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", fallback: "sms", cloudVars: { values: { "offer.title": "عام", "offer.line": "عام" } } }, { hosts: [] });
  assert.deepEqual([fi.cloudVars, fi.fallback, fi.perRecipient], [{ offer: "", perRecipient: true }, "none", true], "القيم العامة بتتجاهل، ومفيش قناة بديلة");
  assert.equal(P({ channel: "wa_web" }), "fav_cloud_only");
  assert.equal(P({ channel: "wa_cloud", cloudTemplate: "fc_frame_news_text" }), "fav_template");
  assert.equal(P({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", link: { coupon: "FIRST" } }), "fav_no_coupon");
  const plain = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { perRecipient: true, values: { "offer.title": "a", "offer.line": "b" } } }, { hosts: [] });
  assert.deepEqual([plain.cloudVars.perRecipient, plain.perRecipient], [undefined, false]);
  const per = { link_slug: "w1", cloud_vars: { offer: "", perRecipient: true } }, row = { vars: { cloud: { values: { "offer.title": "T", "offer.line": "L" } } } };
  assert.deepEqual(C.campaignParams("fc_frame_ask_text", row, per).params.body, ["T", "L"]);
  assert.deepEqual(C.campaignParams("fc_frame_ask_text", row, { link_slug: "w1", cloud_vars: { offer: "", values: { "offer.title": "J", "offer.line": "K" } } }).params.body, ["J", "K"], "حملة عادية: قيم الحملة مش الصف");
  assert.deepEqual(C.campaignParams("fc_frame_ask_text", { vars: {} }, per).params.missing, ["offer.title", "offer.line"], "صف من غير قيمه = متغيّر ناقص (مايتبعتش)");
  assert.equal(C.cloudJobProblem({ cloudTemplate: "fc_frame_ask_text", cloudVars: { offer: "", perRecipient: true } }), null);
});

test("FD1 المعاينة والبدء: رسالة كل عميل بقيمه، الفاصل الافتراضي ٥–٩٠ يوم، والبدء بيخزّن القيم والعرض مع كل صف ونص الصف = الرسالة نفسها", withEnv(ALLOW, async () => {
  const rows = [FAVROW(1), FAVROW(2), FAVROW(3, { daysAgo: 2 }), FAVROW(4, { daysAgo: 95 })];
  const s = world({ fav: favStub(rows) });
  const body = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", filters: { audience: "fav_pick", limit: 100 } };
  const res = await call(s.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK });
  const pv = res.body;
  assert.equal(res.status, 200, JSON.stringify(pv));
  assert.deepEqual([pv.problems, pv.perRecipient, pv.fav.filters], [[], true, { minDaysSince: 5, maxDaysSince: 90 }]);
  assert.equal(pv.willQueue, 2, "٢ و٩٥ يوم بره الفاصل الافتراضي");
  assert.deepEqual(pv.sample.map((x) => x.cloud.text), [1, 2].map((i) => ASK_TEXT("بوكس فيه طبقك المفضل", `عرض العميل ${i} بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST`)));
  assert.deepEqual([pv.sample[0].fav.ref, pv.sample[0].cloud.buttons], ["box-pizza-pasta", ["أبغى أطلب", "ورّني المنيو"]]);
  assert.deepEqual(pv.texts.map((t) => [t.phone, t.title, t.line]), [1, 2].map((i) => [`560••••0${i}`, "بوكس فيه طبقك المفضل", `عرض العميل ${i} بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST`]), "كل الرسايل اللي هتتبعت، والجوال مخفي");
  // فلتر صريح بيغلب الافتراضي
  assert.equal((await call(s.app, "POST /api/cms/wa-sender/preview", { json: { ...body, filters: { audience: "fav_pick", minDaysSince: 0, maxDaysSince: 120 } }, auth: MK })).body.willQueue, 4);
  // البدء: للمالك بس + العدد لازم يطابق المعاينة
  assert.equal((await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2 }, auth: MK })).status, 403);
  assert.equal((await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 3 } })).body.error, "count_changed");
  /* مراجعة FD1 ٣: من غير بصمة المعاينة مايبدأش (اللوحة بتعرض رسالة واحدة ومابتبعتش البصمة) */
  const nod = await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2 } });
  assert.deepEqual([nod.status, nod.body.error, s.db.newJobs.length], [409, "digest_required", 0]);
  assert.equal((await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2, confirmDigest: "" } })).body.error, "digest_required");
  const ok = await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2, confirmDigest: pv.fav.digest } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const j = s.db.newJobs[s.db.newJobs.length - 1];
  assert.deepEqual([j[9], j[10], JSON.parse(j[11]), j[12]], ["wa_cloud", "fc_frame_ask_text", { offer: "", perRecipient: true }, "none"]);
  assert.equal(s.db.newQueue.length, 2);
  const [q0] = s.db.newQueue;
  assert.equal(q0[1], "560000001");
  assert.equal(q0[3], ASK_TEXT("بوكس فيه طبقك المفضل", "عرض العميل 1 بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST"));
  const v0 = JSON.parse(q0[9]);
  assert.deepEqual([v0.cloud.values["offer.title"], v0.fav.slug, v0.fav.price], ["بوكس فيه طبقك المفضل", "box-pizza-pasta", 69]);
  // الشريحة مش متوصّلة ⇒ رد واضح، مش شريحة تانية في صمت
  const none = await call(world().app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK });
  assert.deepEqual([none.status, none.body.error], [503, "fav_unavailable"]);
}));

test("FD1 الإرسال: كل صف بقيمه هو، والعرض بيتحسب تاني قبل كل رسالة — اتغيّر/خلص ⇒ الصف يتخطّى بسببه والباقي يكمل؛ من غير التحقق ⇒ ولا رسالة", withEnv(ALLOW, async () => {
  const JOBF = J({ cloud_template: "fc_frame_ask_text", image_url: null, cloud_vars: { offer: "", perRecipient: true } });
  const V = (i) => ({ first_name: "محمد", cloud: { values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": `عرض ${i} بـ65 ر.س، والتوصيل لعنوانك 15 ر.س` } }, fav: { v: 1, kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", price: 65, at: iso(AT_17 - 3600_000) } });
  const w = world({ jobs: [JOBF], queue: [R(1, { vars: V(1) }), R(2, { vars: V(2) }), R(3, { vars: V(3) }), R(4, { vars: { first_name: "x" } })], fav: favStub([], { "520000002": "offer_changed", "520000003": "offer_gone:sold_out" }) });
  const r = await w.api.cloudTick();
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.calls[0].body.template.components, [{ type: "body", parameters: [{ type: "text", text: "بوكس فيه طبقك المفضل" }, { type: "text", text: "عرض 1 بـ65 ر.س، والتوصيل لعنوانك 15 ر.س" }] }]);
  assert.match(w.db.msgs[0].body, /^جديد من فريش كاتس 👋\nبوكس فيه طبقك المفضل: عرض 1 بـ65 ر.س/);
  assert.deepEqual(w.db.queue.map((q) => [q.status, q.reason || null]), [["sent", null], ["skipped", "offer_changed"], ["skipped", "offer_gone:sold_out"], ["skipped", "missing_param"]], "صف من غير قيمه مابيتبعتش بقيمة عامة");
  // من غير «طبقك المفضل» متوصّلة: مفيش تأكيد ⇒ مفيش إرسال
  const w2 = world({ jobs: [JOBF], queue: [R(1, { vars: V(1) })] });
  await w2.api.cloudTick();
  assert.deepEqual([w2.calls.length, w2.db.queue[0].status, w2.db.queue[0].reason], [0, "skipped", "offer_unverified"]);
}));

test("مراجعة FD1 — البدء مربوط بالرسايل اللي اتقرت في المعاينة (confirmDigest: نفس العدد بسطر مختلف ⇒ 409)، والفاصل بيتبعت للشريحة قبل التسعير", withEnv(ALLOW, async () => {
  let rows = [FAVROW(1), FAVROW(2)];
  const seenWin = [];
  const fav = { audienceRows: async (win) => { seenWin.push(win); return Object.assign(rows.map((r) => JSON.parse(JSON.stringify(r))), { stats: { phones: rows.length } }); }, recheck: async () => null };
  const s = world({ fav });
  const body = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", filters: { audience: "fav_pick", limit: 100 } };
  const pv = (await call(s.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
  assert.match(pv.fav.digest, /^[0-9a-f]{16}$/);
  assert.deepEqual(seenWin[0], { minDaysSince: 5, maxDaysSince: 90 }, "الفاصل الافتراضي بيوصل للشريحة");
  // نفس البيانات ⇒ نفس البصمة
  assert.equal((await call(s.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body.fav.digest, pv.fav.digest);
  // سطر عميل اتغيّر بين المعاينة والبدء (سعر / توصيل) والعدد زي ما هو ⇒ مايبدأش
  rows = [FAVROW(1), FAVROW(2, { vars: { ...FAVROW(2).vars, cloud: { values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": "عرض العميل 2 بـ75 ر.س، والتوصيل لعنوانك 15 ر.س" } } } })];
  const bad = await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2, confirmDigest: pv.fav.digest } });
  assert.deepEqual([bad.status, bad.body.error], [409, "offers_changed"]);
  assert.equal(s.db.newJobs.length, 0);
  // معاينة جديدة ⇒ بصمة جديدة ⇒ يبدأ
  const pv2 = (await call(s.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body;
  assert.notEqual(pv2.fav.digest, pv.fav.digest);
  const ok = await call(s.app, "POST /api/cms/wa-sender/jobs", { json: { ...body, confirmCount: 2, confirmDigest: pv2.fav.digest } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // فلتر صريح بيتبعت زي ما هو
  await call(s.app, "POST /api/cms/wa-sender/preview", { json: { ...body, filters: { audience: "fav_pick", minDaysSince: 0, maxDaysSince: 120 } }, auth: MK });
  assert.deepEqual(seenWin[seenWin.length - 1], { minDaysSince: 0, maxDaysSince: 120 });
}));

test("مراجعة FD1 ٣ — التوصيل موقوف من البوابة وقت الإرسال ⇒ الصف بيرجع للطابور والدورة تقف (مش تخطّي ولا إرسال)؛ الخدمة رجعت ⇒ بيتبعت", withEnv(ALLOW, async () => {
  const JOBF = J({ cloud_template: "fc_frame_ask_text", image_url: null, cloud_vars: { offer: "", perRecipient: true } });
  const V = (i) => ({ first_name: "x", cloud: { values: { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": `عرض ${i} بـ65 ر.س، والتوصيل لعنوانك 15 ر.س` } }, fav: { v: 1, kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", price: 65, at: iso(AT_17 - 3600_000) } });
  let hold = "delivery_paused";
  const fav = { audienceRows: async () => [], recheck: async () => hold };
  const w = world({ jobs: [JOBF], queue: [R(1, { vars: V(1) }), R(2, { vars: V(2) })], fav });
  const r = await w.api.cloudTick();
  assert.deepEqual([r.sent || 0, r.reason, w.calls.length], [0, "delivery_paused", 0], JSON.stringify(r));
  assert.deepEqual(w.db.queue.map((q) => [q.status, q.reason || null]), [["pending", null], ["pending", null]], "مااتخطّاش ولا اتبعت");
  hold = "pickup_paused";
  assert.equal((await w.api.cloudTick()).reason, "pickup_paused");
  hold = null;
  const r2 = await w.api.cloudTick();
  assert.equal(r2.sent, 2, JSON.stringify(r2));
  // سبب تاني (العرض اتغيّر) ⇒ تخطّي زي الأول
  hold = "offer_changed";
  const w2 = world({ jobs: [JOBF], queue: [R(1, { vars: V(1) })], fav });
  await w2.api.cloudTick();
  assert.deepEqual([w2.db.queue[0].status, w2.db.queue[0].reason], ["skipped", "offer_changed"]);
}));

test("مراجعة FD1 ٣ — تعديل رسالة صف واحد مقفول لحملة قيمها لكل عميل (اللي بيتبعت قيم القالب مش النص)؛ الحملات التانية زي ما هي", withEnv(ALLOW, async () => {
  const JOBF = J({ cloud_template: "fc_frame_ask_text", image_url: null, cloud_vars: { offer: "", perRecipient: true } });
  const w = world({ jobs: [JOBF], queue: [R(1, { message: "نص القالب بقيم العميل" })] });
  const r = await call(w.app, "POST /api/cms/wa-sender/items/:id/edit", { json: { message: "نص جديد" }, param: { id: "1" } });
  assert.deepEqual([r.status, r.body.error, w.db.queue[0].message], [409, "per_recipient", "نص القالب بقيم العميل"]);
  const n = world({ jobs: [J()], queue: [R(1)] });
  const r2 = await call(n.app, "POST /api/cms/wa-sender/items/:id/edit", { json: { message: "نص جديد" }, param: { id: "1" } });
  assert.deepEqual([r2.status, n.db.queue[0].message], [200, "نص جديد"]);
}));
