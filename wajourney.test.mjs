/* CJ1a — رحلة العميل في النافذة: القرارات الصافية (wajourney.js). node --test wajourney.test.mjs — مفيش قاعدة ولا شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import * as J from "./wajourney.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-16T19:00:00Z");

test("الإعدادات: كل افتراضي له صف في المخطط (نفس قاعدة FU1)، والغلط ⇒ الافتراضي، وبره الحدود ⇒ للحد، والمحجوز مايزيدش عن السقف", () => {
  assert.deepEqual(Object.keys(J.JOURNEY_SCHEMA).sort(), Object.keys(J.JOURNEY_DEFAULTS).sort());
  for (const [k, s] of Object.entries(J.JOURNEY_SCHEMA)) { assert.equal(s.group, J.JOURNEY_GROUP); assert.ok(s.ar && s.help, k); if (s.type === "number") assert.ok(s.min <= J.JOURNEY_DEFAULTS[k] && J.JOURNEY_DEFAULTS[k] <= s.max, k); }
  const d = J.journeyCfg({});
  assert.deepEqual(d, { journeyBursts: true, burstHoldMin: 10, burstHoldMaxMin: 120, paidNoteDedupeMin: 30, courierSmsWaMin: 30, orderMsgCap: 4, orderMsgTail: 3 });
  const c = J.journeyCfg({ journeyBursts: false, burstHoldMin: "abc", burstHoldMaxMin: 99999, paidNoteDedupeMin: -5, orderMsgCap: 2, orderMsgTail: 5 });
  assert.equal(c.journeyBursts, false); assert.equal(c.burstHoldMin, 10); assert.equal(c.burstHoldMaxMin, 720); assert.equal(c.paidNoteDedupeMin, 0);
  assert.equal(c.orderMsgCap, 2); assert.equal(c.orderMsgTail, 5, "الإعداد بيتخزّن زي ما اتكتب (الحد ٦)؛ القصّ على السقف وقت القرار");
  assert.equal(J.orderCapDecision({ sent: 0, stage: "accepted", cap: 2, tail: 5 }).ok, false, "محجوز أكبر من السقف = كل الباقي محجوز ⇒ الخفيفة بتتشال من الأول");
  assert.equal(J.orderCapDecision({ sent: 0, stage: "on_the_way", cap: 2, tail: 5 }).ok, true);
  assert.equal(J.journeyCfg(null).burstHoldMin, 10);
});

test("(١) الهدوء: رسالة طالعة من ٣ دقايق ⇒ استنى لحد الدقيقة ١٠؛ من ١٥ دقيقة ⇒ ابعت؛ صفر دقايق أو مفيش رسالة ⇒ ابعت", () => {
  const h = J.holdDecision({ lastOut: new Date(T0 - 3 * MIN).toISOString(), now: T0, holdMin: 10 });
  assert.equal(h.hold, true); assert.equal(h.until.getTime(), T0 + 7 * MIN);
  assert.equal(J.holdDecision({ lastOut: new Date(T0 - 15 * MIN), now: T0, holdMin: 10 }).hold, false);
  assert.equal(J.holdDecision({ lastOut: new Date(T0 - 1 * MIN), now: T0, holdMin: 0 }).hold, false);
  assert.equal(J.holdDecision({ lastOut: null, now: T0, holdMin: 10 }).hold, false);
  assert.equal(J.holdDecision({ lastOut: "garbage", now: T0, holdMin: 10 }).hold, false);
  // الحالة الحيّة ١٦/١٠: «استلمنا طلبك» ١٩:٣٤:١٠ ثم «وصلنا طلبك» ١٩:٣٦ ⇒ التانية تستنى لحد ١٩:٤٤:١٠
  const live = J.holdDecision({ lastOut: "2026-10-16T19:34:10Z", now: Date.parse("2026-10-16T19:36:00Z"), holdMin: 10 });
  assert.equal(live.hold, true); assert.equal(live.until.toISOString(), "2026-10-16T19:44:10.000Z");
});

test("(١) التأجيل: جوّه burstHoldMaxMin ⇒ ترجع pending لميعاد الهدوء وأول تأجيل بيتحفظ؛ عدّاه ⇒ تتلغي", () => {
  const first = J.deferDecision({ until: new Date(T0 + 7 * MIN), firstHold: null, now: T0, maxMin: 120 });
  assert.equal(first.defer, true); assert.equal(first.until.getTime(), T0 + 7 * MIN); assert.equal(first.firstHold.getTime(), T0);
  const again = J.deferDecision({ until: new Date(T0 + 100 * MIN), firstHold: first.firstHold.toISOString(), now: T0 + 95 * MIN, maxMin: 120 });
  assert.equal(again.defer, true); assert.equal(again.firstHold.getTime(), T0, "أول تأجيل زي ما هو");
  const late = J.deferDecision({ until: new Date(T0 + 125 * MIN), firstHold: first.firstHold.toISOString(), now: T0 + 120 * MIN, maxMin: 120 });
  assert.equal(late.defer, false); assert.equal(late.expired, true);
  assert.equal(J.deferDecision({ until: "nope", firstHold: null, now: T0, maxMin: 120 }).defer, false);
});

test("(٤) سقف الطلب ٤ ومحجوز ٣: استلمنا ✓ ⇒ «بنجهّز» ✗ (خفيفة) ⇒ مع المندوب ✓ ⇒ وصل ✓ ⇒ التقييم ✓ = ٤ بالظبط؛ الخامسة ✗ إلا التوصيل/الاسترداد/جاهز", () => {
  const cap = { cap: 4, tail: 3 };
  assert.equal(J.orderCapDecision({ sent: 0, stage: "pos_created", ...cap }).ok, true);
  assert.deepEqual(J.orderCapDecision({ sent: 1, stage: "accepted", ...cap }), { ok: false, reason: "order_cap_low" });
  assert.deepEqual(J.orderCapDecision({ sent: 1, stage: "paid_note", ...cap }), { ok: false, reason: "order_cap_low" });
  assert.equal(J.orderCapDecision({ sent: 1, stage: "on_the_way", ...cap }).ok, true);
  assert.equal(J.orderCapDecision({ sent: 2, stage: "delivered", ...cap }).ok, true);
  assert.equal(J.orderCapDecision({ sent: 3, stage: "review", ...cap }).ok, true);
  assert.deepEqual(J.orderCapDecision({ sent: 4, stage: "review", ...cap }), { ok: false, reason: "order_cap" });
  assert.deepEqual(J.orderCapDecision({ sent: 4, stage: "on_the_way", ...cap }), { ok: false, reason: "order_cap" });
  for (const st of ["delivered", "rejected_refunded", "refund_failed", "ready", "pickup_ready"]) assert.equal(J.orderCapDecision({ sent: 9, stage: st, ...cap }).ok, true, st);
  // طلب استلام: استلمنا ✓ ⇒ «بنجهّز» ✗ ⇒ جاهز للاستلام ✓ (أساسية) ⇒ التقييم ✓
  assert.equal(J.orderCapDecision({ sent: 1, stage: "ready", ...cap }).ok, true);
  assert.equal(J.orderCapDecision({ sent: 2, stage: "review", ...cap }).ok, true);
  // السقف صفر = من غير سقف؛ محجوز صفر = الخفيفة بتتعامل زي الباقي
  assert.equal(J.orderCapDecision({ sent: 40, stage: "accepted", cap: 0, tail: 3 }).ok, true);
  assert.equal(J.orderCapDecision({ sent: 1, stage: "accepted", cap: 4, tail: 0 }).ok, true);
  assert.equal(J.orderCapDecision({ sent: 4, stage: "accepted", cap: 4, tail: 0 }).ok, false);
});

test("holdUntil: واتساب + SMS استعلامين، الأحدث فيهم هو اللي بيحكم؛ واتساب مش مقروء ⇒ هدوء دقيقة؛ SMS مش مقروء (جدول ناقص) ⇒ واتساب بس؛ المفتاح مقفول ⇒ ولا قراءة", async () => {
  const calls = [];
  const q = (sql, p) => { calls.push([sql, p]); return [{ last_out: sql === J.LAST_OUT_WA_SQL ? new Date(T0 - 2 * MIN).toISOString() : new Date(T0 - 9 * MIN) }]; };
  const u = await J.holdUntil(q, { phone: "512345678", cfg: {}, now: T0 });
  assert.equal(u.getTime(), T0 + 8 * MIN, "واتساب من دقيقتين هو الأحدث");
  assert.equal(calls.length, 2); assert.equal(calls[0][0], J.LAST_OUT_WA_SQL); assert.equal(calls[1][0], J.LAST_OUT_SMS_SQL); assert.deepEqual(calls[0][1], ["512345678"]);
  const smsNewer = (sql) => [{ last_out: sql === J.LAST_OUT_SMS_SQL ? new Date(T0 - 1 * MIN) : new Date(T0 - 30 * MIN) }];
  assert.equal((await J.holdUntil(smsNewer, { phone: "512345678", cfg: {}, now: T0 })).getTime(), T0 + 9 * MIN, "SMS من دقيقة هي الأحدث");
  assert.equal(await J.holdUntil(() => [{ last_out: null }], { phone: "512345678", cfg: {}, now: T0 }), null);
  assert.equal(await J.holdUntil(() => [], { phone: "512345678", cfg: {}, now: T0 }), null);
  assert.equal((await J.holdUntil(() => { throw new Error("db"); }, { phone: "512345678", cfg: {}, now: T0 })).getTime(), T0 + MIN, "واتساب مش مقروء ⇒ دقيقة");
  assert.equal((await J.holdUntil(() => null, { phone: "512345678", cfg: {}, now: T0 })).getTime(), T0 + MIN);
  const noSmsTable = (sql) => { if (sql === J.LAST_OUT_SMS_SQL) throw Object.assign(new Error("missing"), { code: "42P01" }); return [{ last_out: new Date(T0 - 30 * MIN) }]; };
  assert.equal(await J.holdUntil(noSmsTable, { phone: "512345678", cfg: {}, now: T0 }), null, "جدول SMS ناقص ⇒ القرار على واتساب بس (مفيش هدوء وهمي)");
  const noSmsRecent = (sql) => { if (sql === J.LAST_OUT_SMS_SQL) return null; return [{ last_out: new Date(T0 - 3 * MIN) }]; };
  assert.equal((await J.holdUntil(noSmsRecent, { phone: "512345678", cfg: {}, now: T0 })).getTime(), T0 + 7 * MIN);
  let n = 0;
  assert.equal(await J.holdUntil(() => { n++; return []; }, { phone: "512345678", cfg: { journeyBursts: false }, now: T0 }), null);
  assert.equal(await J.holdUntil(() => { n++; return []; }, { phone: "512345678", cfg: { burstHoldMin: 0 }, now: T0 }), null);
  assert.equal(n, 0, "المفتاح مقفول = ولا استعلام");
});

test("مين مبادِر: رسايل البوت المبادِرة بس (مش سطر التحويل ولا سطر السيل)، وشغلات التأجيل، ومصادر سقف الطلب المستثناة", () => {
  for (const k of ["paid_note", "window_keep", "lead_followup", "reply_followup", "lead_nudge", "review_ask", "review_stars_ask"]) assert.ok(J.PROACTIVE_KEYS.has(k), k);
  for (const k of ["transfer_note", "media_flood_line", "L5", "main", "status"]) assert.ok(!J.PROACTIVE_KEYS.has(k), k);
  assert.deepEqual([...J.PROACTIVE_JOB_KINDS].sort(), ["assist_nudge", "lead_followup", "open_followup", "paid_note", "reply_followup", "window_keep"]);      // WO1: «نكمّل لما نفتح» بتستنى الهدوء زيهم
  assert.ok(!J.PROACTIVE_JOB_KINDS.includes("assist_reminder"), "التذكير اللي العميل طلبه بنفسه مش دفعة");
  assert.ok(!J.PROACTIVE_JOB_KINDS.includes("handover_check") && !J.PROACTIVE_JOB_KINDS.includes("staff_wait"));
  for (const s of ["reply", "team", "test"]) assert.ok(J.CAP_EXEMPT_SOURCES.has(s), s);
  assert.ok(!J.CAP_EXEMPT_SOURCES.has("window") && !J.CAP_EXEMPT_SOURCES.has("bot") && !J.CAP_EXEMPT_SOURCES.has("review"));
});

test("الـSQL: آخر رسالة طالعة بتجمع واتساب (من غير الفاشل/المتخطّى/المستورد) + SMS المتبعتة؛ تأكيد الاستلام = القالب أو مرحلة pos_created/paid؛ تغطية واتساب = نافذة مفتوحة + تحديث للطلب", () => {
  assert.match(J.LAST_OUT_WA_SQL, /wa_messages[\s\S]*direction='out'[\s\S]*NOT IN \('failed','skipped'\)[\s\S]*<> 'history'/);
  assert.match(J.LAST_OUT_SMS_SQL, /sms_log[\s\S]*status='sent'/);
  assert.ok(!/sms_log/.test(J.LAST_OUT_WA_SQL), "استعلام واتساب مابيلمسش جدول SMS (ممكن مايكونش موجود)");
  assert.match(J.PAID_CONFIRM_SQL, /template LIKE 'fc_order_received%' OR stage IN \('pos_created','paid'\)/);
  assert.match(J.PAID_CONFIRM_SQL, /make_interval\(mins => \$2::int\)/);
  assert.match(J.WA_COVERS_ORDER_SQL, /direction='in'[\s\S]*24 hours/);
  assert.match(J.WA_COVERS_ORDER_SQL, /order_no=\$1 AND direction='out'[\s\S]*make_interval\(mins => \$3::int\)/);
  assert.match(J.ORDER_SENT_SQL, /count\(\*\)::int AS n FROM wa_messages WHERE order_no=\$1 AND direction='out'/);
  assert.match(J.QUEUE_HOLD_DDL, /hold_until TIMESTAMPTZ/);
});
