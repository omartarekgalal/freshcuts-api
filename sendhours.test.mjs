/* عمر ١٨/١٠: «ارسال الواتس كله … كل الرسايل المربوطة إن المطعم مفتوح تتبعت عادي في وقتها» — البوابة الواحدة (sendhours.js) ومين بيستعملها.
   node --test sendhours.test.mjs  (صافي: مفيش قاعدة ولا شبكة؛ كل الأوقات UTC والرياض +٣) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendHoursCfg, isRestaurantOpenAt, nextSendOpenAt, sendAllowed, sendHoursFromBody, hoursKnown, sendHoursView, SEND_HOURS_DEFAULTS, SEND_HOURS_PATHS } from "./sendhours.js";
import { senderCfg, inWindow, pacing } from "./wasender.js";
import { followHoursOk, followNext } from "./wabotrun.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";

/* المواعيد الحيّة (شكل settings.hours): كل يوم ١٣:٠٠ → ٢:٠٠، الخميس والجمعة لحد ٣:٠٠ */
const D = (open, close) => ({ open, close });
const HOURS = { enabled: true, days: { sun: D("13:00", "02:00"), mon: D("13:00", "02:00"), tue: D("13:00", "02:00"), wed: D("13:00", "02:00"), thu: D("13:00", "03:00"), fri: D("13:00", "03:00"), sat: D("13:00", "02:00") } };
const S = (x = {}) => ({ hours: HOURS, ...x });
/* الأحد ١٨/١٠/٢٠٢٦ بتوقيت الرياض ⇒ UTC */
const R = (hh, mm = 0, day = 18) => new Date(Date.UTC(2026, 9, day, hh - 3, mm));

test("الإعدادات: الافتراضي مفتوح + ٣٠ دقيقة، الحدود، والمواعيد لازم تكون متعرّفة", () => {
  assert.deepEqual(SEND_HOURS_DEFAULTS, { enabled: true, stopBeforeCloseMin: 30 });
  const c = sendHoursCfg(S());
  assert.equal(c.enabled, true); assert.equal(c.stopBeforeCloseMin, 30); assert.equal(c.active, true);
  assert.equal(sendHoursCfg(S({ waSendHours: { stopBeforeCloseMin: 999 } })).stopBeforeCloseMin, 180);
  assert.equal(sendHoursCfg(S({ waSendHours: { stopBeforeCloseMin: -5 } })).stopBeforeCloseMin, 0);
  assert.equal(sendHoursCfg(S({ waSendHours: { enabled: false } })).active, false);
  assert.equal(sendHoursCfg({}).active, false, "مواعيد مش متعرّفة ⇒ مش شغّال (الساعات القديمة)");
  assert.equal(hoursKnown({ enabled: false, days: HOURS.days }), false);
  assert.equal(hoursKnown({ days: { sun: { closed: true } } }), false);
});

test("isRestaurantOpenAt: مفتوح، مقفول، آخر ٣٠ دقيقة قبل القفل، ذيل بعد نص الليل، الخميس لحد ٣", () => {
  const s = S();
  assert.equal(isRestaurantOpenAt(R(12, 59), s), false, "قبل الفتح");
  assert.equal(isRestaurantOpenAt(R(13, 0), s), true, "الفتح");
  assert.equal(isRestaurantOpenAt(R(22, 30), s), true, "العشا — كانت بتتمنع بساعات ١٣→٢٢");
  assert.equal(isRestaurantOpenAt(R(1, 20, 19), s), true, "١:٢٠ بعد نص الليل (وردية الأحد لحد ٢)");
  assert.equal(isRestaurantOpenAt(R(1, 31, 19), s), false, "آخر ٣٠ دقيقة قبل ٢:٠٠");
  assert.equal(isRestaurantOpenAt(R(2, 30, 23), s), false, "الجمعة ٢:٣٠ الفجر = آخر نص ساعة في وردية الخميس (لحد ٣)");
  assert.equal(isRestaurantOpenAt(R(2, 20, 23), s), true, "الجمعة ٢:٢٠ الفجر = لسه وردية الخميس");
  assert.equal(isRestaurantOpenAt(R(1, 45, 19), S({ waSendHours: { stopBeforeCloseMin: 0 } })), true, "هامش صفر ⇒ لحد القفل");
  assert.equal(isRestaurantOpenAt(R(20), S({ waSendHours: { enabled: false } })), null, "مقفول ⇒ null (المنادي يرجع لساعاته)");
  assert.equal(isRestaurantOpenAt(R(20), {}), null, "مواعيد مش متعرّفة ⇒ null");
});

test("nextSendOpenAt: أول لحظة مسموحة بالدقيقة، ودلوقتي لو مسموح", () => {
  const s = S();
  assert.equal(nextSendOpenAt(R(9, 2), s).toISOString(), R(13, 0).toISOString());
  assert.equal(nextSendOpenAt(R(1, 40, 19), s).toISOString(), R(13, 0, 19).toISOString(), "آخر الليل ⇒ فتح بكرة");
  assert.equal(nextSendOpenAt(R(18, 7), s).toISOString(), R(18, 7).toISOString());
  const odd = S({ hours: { enabled: true, days: { ...HOURS.days, mon: D("13:07", "02:00") } } });
  assert.equal(nextSendOpenAt(R(11, 0, 19), odd).toISOString(), R(13, 7, 19).toISOString(), "الفتح ١٣:٠٧ ⇒ ١٣:٠٧ مش ١٣:١٠");
  assert.equal(nextSendOpenAt(R(9), S({ waSendHours: { enabled: false } })), null);
});

test("sendAllowed: البوابة شغّالة ⇒ مواعيد المطعم؛ مقفولة ⇒ الساعات القديمة (legacy)", () => {
  assert.equal(sendAllowed(R(23), S(), () => false), true);
  assert.equal(sendAllowed(R(11), S(), () => true), false);
  assert.equal(sendAllowed(R(23), S({ waSendHours: { enabled: false } }), () => false), false);
});

test("من اللوحة: النوع والحدود ومفاتيح مش معروفة", () => {
  assert.deepEqual(sendHoursFromBody({ enabled: false }, {}).value, { enabled: false, stopBeforeCloseMin: 30 });
  assert.equal(sendHoursFromBody({ stopBeforeCloseMin: 45 }, { enabled: false }).value.enabled, false, "دمج مع المتخزّن");
  assert.equal(sendHoursFromBody({ stopBeforeCloseMin: 181 }, {}).ok, false);
  assert.equal(sendHoursFromBody({ enabled: "yes" }, {}).ok, false);
  assert.equal(sendHoursFromBody({ startHour: 13 }, {}).ok, false);
  assert.ok(SERVER_OWNED_PATHS.includes("waSendHours"), "الحفظ العام للإعدادات مايمسحش الإعداد");
});

test("الإرسال الآلي (Cloud + واتساب ويب): inWindow بمواعيد المطعم بدل ١٣→٢٢، والأيام لسه فوقه", () => {
  const on = (x = {}) => senderCfg({ ...S(), waSender: { enabled: true, ...x } });
  assert.equal(inWindow(on(), R(23).getTime()), true, "١١ بالليل — كانت بره ساعات ١٣→٢٢");
  assert.equal(inWindow(on(), R(1, 15, 19).getTime()), true, "١:١٥ الفجر والمطعم فاتح");
  assert.equal(inWindow(on(), R(11).getTime()), false, "١١ الصبح والمطعم مقفول");
  assert.equal(inWindow(on({ days: ["mon"] }), R(20).getTime()), false, "الأحد مش في أيام الإرسال");
  const legacy = senderCfg({ ...S({ waSendHours: { enabled: false } }), waSender: { enabled: true } });
  assert.equal(inWindow(legacy, R(23).getTime()), false, "الإعداد مقفول ⇒ ١٣→٢٢ زي الأول");
  assert.equal(pacing(on(), { today: 0, lastHour: 0, failStreak: 0 }, R(11).getTime()).reason, "outside_hours");
  assert.equal(JSON.stringify(on()).includes("gate"), false, "البوابة مابتتخزّنش مع waSender");
  assert.equal(Object.keys(on()).includes("gate"), false);
});

test("FU1 متابعة اللي ردّ: الساعات = مواعيد المطعم، والتأجيل لأول فتح", () => {
  const cfg = { replyFollowUpFromHour: 12, replyFollowUpFromMinute: 0, replyFollowUpToHour: 1, replyFollowUpToMinute: 30 };
  assert.equal(followHoursOk(R(1, 40, 19), cfg, S()), false, "قبل القفل بأقل من ٣٠ د");
  assert.equal(followHoursOk(R(12, 30), cfg, S()), false, "١٢:٣٠ — الساعات القديمة كانت بتسمح والمطعم لسه مقفول");
  assert.equal(followHoursOk(R(12, 30), cfg, S({ waSendHours: { enabled: false } })), true, "الإعداد مقفول ⇒ ١٢→١:٣٠");
  assert.equal(followNext(R(10), cfg, S()).toISOString(), R(13).toISOString());
});

test("كل مسار اتحوّل بيستعمل البوابة (قراية الكود) — والمسارات اللي فضلت زي ما هي مكتوبة", () => {
  const src = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  assert.match(src("wasender.js"), /isRestaurantOpenAt\(now, cfg\.gate\)/);
  assert.match(src("reviews.js"), /isRestaurantOpenAt\(now, s\)/);
  assert.match(src("reviews.js"), /nextSendOpenAt\(now, s\)/);
  const w = src("wabotrun.js");
  assert.match(w, /const wkOpen = isRestaurantOpenAt\(now, settings\)/, "حارس النافذة");
  assert.match(w, /const rmOpen = isRestaurantOpenAt\(now, settings\)/, "إرسال التذكير");
  assert.match(w, /followHoursOk\(now, cfg, settings\)/, "FU1");
  assert.match(w, /quietStart: gate \? 0 :/, "تخطيط التذكير");
  assert.ok(SEND_HOURS_PATHS.map((p) => p.id).join(",") === "campaigns,reviews,window_keep,reply_followup,assist_reminder,ka2");
  const v = sendHoursView(S(), R(20));
  assert.equal(v.sendNow, true); assert.equal(v.active, true); assert.equal(v.nextSendAt, null);
  assert.equal(sendHoursView(S(), R(10)).nextSendAt, R(13).toISOString());
});
