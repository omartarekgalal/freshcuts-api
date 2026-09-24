/* ═══════════════════════════════════════════════════════════════════════════
   حارس الشيك أوت — القاعدة التانية «الطابور واقف» (٢٤ سبتمبر ٢٠٢٦)

   الباج: القاعدة الأولى بتقيس عند خطوة ٥ (العنوان)، لكن الشيك أوت بقى
   «الدخول الأول» من ١٩/٩ — خطوة ٤ (الدخول بالجوال) قبلها. فلو تقنيات
   وقعت، محدش يعدّي الـOTP ⇒ محدش يوصل خطوة ٥ ⇒ ready=0 ⇒ الإنذار عمره
   ما يرن. نفس العمى للـbundle المكسور أو /api/journey/batch.

   الاختبارات دي بتثبّت الحاجتين: إن القاعدة الجديدة بترن في العطل،
   و**الأهم** إنها بتسكت في كل الحالات اللي شكلها عطل وهي مش عطل —
   وفيها fixture من الداتا الحقيقية.

     node --test checkoutwatch-stall.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  decide, stalled, watchCfg, stallText, downText, serviceQuiet, runOnce,
  WATCH_DEFAULTS, ENTRY_STEP, LOGIN_STEP,
} from "./checkoutwatch.js";
import { smsInfo } from "./staffalerts.js";

const cfg = watchCfg(null);
const ok = { state: "ok" };
const alerting = { state: "alerting" };
/* نافذة صحية: الأرقام الطويلة كلها بتتحرك. القاعدة الأولى برضه ساكتة. */
const healthy = { ready: 3, payPage: 2, paid: 1, landed: 150, entered: 14, advanced: 6, paidLong: 2 };
const m = (o) => ({ ...healthy, ...o });

/* ═══ ١) الحدود والإعدادات ═══════════════════════════════════════════════ */

test("الحدود الافتراضية هي اللي الـbacktest طلعها", () => {
  assert.equal(WATCH_DEFAULTS.stallWindowMin, 120);
  assert.equal(WATCH_DEFAULTS.stallEntry, 8);
  assert.equal(WATCH_DEFAULTS.stallLanded, 60);
  assert.equal(ENTRY_STEP, 2, "السلة = أول إشارة نيّة");
  assert.equal(LOGIN_STEP, 4, "الدخول بالجوال = أول خطوة في الشيك أوت من ١٩/٩");
});

test("الإعدادات الجديدة بتتقصّ زي القديمة بالظبط (كلها من اللوحة)", () => {
  assert.equal(watchCfg({ checkoutWatch: { stallWindowMin: 10 } }).stallWindowMin, 30);
  assert.equal(watchCfg({ checkoutWatch: { stallWindowMin: 999 } }).stallWindowMin, 240);
  assert.equal(watchCfg({ checkoutWatch: { stallWindowMin: "x" } }).stallWindowMin, 120);
  assert.equal(watchCfg({ checkoutWatch: { stallEntry: 1 } }).stallEntry, 2);
  assert.equal(watchCfg({ checkoutWatch: { stallEntry: 500 } }).stallEntry, 100);
  assert.equal(watchCfg({ checkoutWatch: { stallLanded: 3 } }).stallLanded, 10);
  assert.equal(watchCfg({ checkoutWatch: { stallEntry: 12, stallWindowMin: 60 } }).stallEntry, 12);
});

/* ═══ ٢) بترن في العطل الحقيقي ═══════════════════════════════════════════ */

test("عطل الرسايل: ناس في السلة ومحدش قدر يدخل ⇒ إنذار", () => {
  const d = decide(m({ ready: 0, payPage: 0, paid: 0, entered: 12, advanced: 0, paidLong: 0 }), ok, cfg, true);
  assert.equal(d.bad, true);
  assert.equal(d.reason, "stall");
  assert.equal(d.action, "alert");
  assert.equal(d.state, "alerting");
});

test("العطل ده بالظبط هو اللي القاعدة الأولى عمياء عنه", () => {
  // ready صفر لإن محدش عدّى الدخول ⇒ القاعدة الأولى (ready>=5) مستحيل ترن
  const outage = m({ ready: 0, payPage: 0, paid: 0, entered: 12, advanced: 0, paidLong: 0 });
  assert.equal(outage.ready >= cfg.threshold && outage.paid === 0, false, "القاعدة الأولى ساكتة");
  assert.equal(stalled(outage, cfg), true, "والتانية شايفة");
});

test("الـbundle ميت: زوار كتير وولا سلة واحدة ⇒ إنذار برسالة مختلفة", () => {
  const dead = m({ ready: 0, payPage: 0, paid: 0, landed: 180, entered: 0, advanced: 0, paidLong: 0 });
  assert.equal(stalled(dead, cfg), true);
  assert.match(stallText(dead, cfg, "en"), /site looks BROKEN/);
  assert.match(stallText(dead, cfg, "ar"), /الموقع مايشتغلش/);
});

test("إنذار واحد للحادثة — الدورة اللي بعدها ساكتة", () => {
  const d = decide(m({ paid: 0, entered: 20, advanced: 0, paidLong: 0 }), alerting, cfg, true);
  assert.equal(d.action, "none");
  assert.equal(d.state, "alerting");
});

/* ═══ ٣) الحالات اللي **ممنوع** ترن فيها ═════════════════════════════════ */

test("مقفول ⇒ عمرها ما ترن", () => {
  const d = decide(m({ paid: 0, entered: 30, advanced: 0, paidLong: 0 }), ok, cfg, false);
  assert.equal(d.bad, false);
  assert.equal(d.action, "none");
});

test("الخدمة موقوفة بإيد المدير ⇒ سكوت تام (ده قرار مش عطل)", () => {
  const broken = m({ ready: 20, payPage: 0, paid: 0, landed: 240, entered: 0, advanced: 0, paidLong: 0 });
  // مفتوح + مش موقوف = إنذار
  assert.equal(decide(broken, ok, cfg, true, false).action, "alert");
  // نفس الأرقام بالظبط والخدمة موقوفة = ولا كلمة (والقاعدة الأولى كمان)
  const q = decide(broken, ok, cfg, true, true);
  assert.equal(q.bad, false);
  assert.equal(q.reason, null);
  assert.equal(q.action, "none");
  // وكنا في إنذار ووقّفوا الخدمة: نرجع نسلّح في صمت، مش رسالة «رجع»
  assert.equal(decide(broken, alerting, cfg, true, true).action, "rearm");
});

test("هدوء حقيقي: ناس قليلة في السلة ⇒ مفيش إنذار", () => {
  for (const entered of [0, 1, 3, 5, 7]) {
    const quiet = m({ ready: 0, payPage: 0, paid: 0, landed: 45, entered, advanced: 0, paidLong: 0 });
    assert.equal(stalled(quiet, cfg), false, `entered=${entered}`);
  }
});

test("ليل هادي: زوار تحت حد الهبوط وولا سلة ⇒ مفيش إنذار", () => {
  assert.equal(stalled(m({ landed: 59, entered: 0, advanced: 0, paidLong: 0 }), cfg), false);
  assert.equal(stalled(m({ landed: 60, entered: 0, advanced: 0, paidLong: 0 }), cfg), true, "الحد نفسه بيرن");
});

test("دخول واحد بس بيكفي يمنع الإنذار (القاعدة بتسأل «صفر؟» مش «قليل؟»)", () => {
  assert.equal(stalled(m({ entered: 40, advanced: 1, paidLong: 0 }), cfg), false);
  assert.equal(stalled(m({ landed: 400, entered: 0, advanced: 1, paidLong: 0 }), cfg), false);
});

test("طلب مدفوع في النافذة الطويلة بيسكّت الإنذار — مستحيل نقول «واقف» والفلوس داخلة", () => {
  assert.equal(stalled(m({ entered: 30, advanced: 0, paidLong: 1 }), cfg), false);
});

test("أرقام قديمة (من غير الحقول الجديدة) مابترنّش — ومابتوقّعش", () => {
  assert.equal(stalled({ ready: 5, payPage: 0, paid: 0 }, cfg), false);
  // والقاعدة الأولى لسه شغّالة زي ما هي على نفس الشكل القديم
  assert.equal(decide({ ready: 5, payPage: 0, paid: 0 }, ok, cfg, true).action, "alert");
  assert.equal(decide({ ready: 5, payPage: 0, paid: 0 }, ok, cfg, true).reason, "pay");
});

/* ═══ ٤) fixture من الداتا الحقيقية (١٩/٩ مسا → ٢٤/٩) ════════════════════
   نوافذ حقيقية بـ١٢٠ دقيقة من /api/service/report — الأرقام: زوار، سلة،
   دخول، مدفوع. دي أصعب النوافذ اللي حصلت فعلاً (أقل دخول مع أكتر سلة،
   وأكبر نوافذ «صفر دخول»). ولا واحدة منهم المفروض ترن.                   */

const REAL_WINDOWS = [
  // [زوار, سلة, دخول, مدفوع]  — التعليق: التاريخ بتوقيت الرياض
  [64, 1, 0, 0],    // ٢٠/٩ ١:٠٠ — آخر ساعة قبل القفل، صفر دخول
  [40, 1, 0, 0],    // ٢٠/٩ ١:٣٠
  [63, 2, 0, 0],    // ٢١/٩ ٠:٣٠
  [240, 1, 0, 0],   // ٢٣/٩ ٢١:٠٠ — الخدمة كانت موقوفة (الحارس بيسكت برضه)
  [199, 1, 0, 0],   // ٢٣/٩ ٢١:٣٠ — نفس الإيقاف
  [140, 1, 0, 0],   // ٢٣/٩ ٢٢:٠٠
  [181, 20, 2, 0],  // ٢٠/٩ ١٥:٠٠ — أقرب حالة للرنّة: ٢٠ سلة و٢ دخول بس
  [263, 20, 2, 1],  // ٢٢/٩ ٢٠:٣٠
  [143, 9, 2, 1],   // ١٩/٩ ٢٢:٣٠
  [68, 11, 3, 0],   // ٢٢/٩ ١٦:٠٠ — وسط عطل ٢٢/٩ نفسه: الدخول كان شغّال
  [384, 29, 21, 5], // ٢٣/٩ ١٥:٣٠ — أعلى ذروة في الداتا
  [2, 0, 0, 0],     // ٢١/٩ ١٢:٣٠ — أول ما نفتح، فاضي
  [6, 0, 0, 0],     // ٢١/٩ ١٣:٠٠
];

test("backtest: ولا نافذة حقيقية من ١٣ نافذة صعبة كانت هترن", () => {
  for (const [landed, entered, advanced, paidLong] of REAL_WINDOWS) {
    const w = { ready: 0, payPage: 0, paid: 0, landed, entered, advanced, paidLong };
    assert.equal(stalled(w, cfg), false, `landed=${landed} cart=${entered} login=${advanced} paid=${paidLong}`);
  }
});

test("backtest: لو الدخول في أصعب نافذة كان صفر، القاعدة كانت هترن — الهامش اتنين", () => {
  // ٢٠/٩ ١٥:٠٠: ٢٠ سلة و٢ دخول. ده أضيق هامش في الداتا كلها، ومكتوب في الرأس.
  assert.equal(stalled({ landed: 181, entered: 20, advanced: 0, paidLong: 0 }, cfg), true);
});

/* ═══ ٥) حارس الإيقاف ════════════════════════════════════════════════════ */

const T = Date.parse("2026-09-24T19:00:00Z");
const from = new Date(T - 120 * 60e3);
const at = new Date(T);

test("serviceQuiet: موقوف دلوقتي ⇒ ساكت", () => {
  assert.equal(serviceQuiet({ service: { delivery: { paused: true, until: null } } }, from, at), true);
  assert.equal(serviceQuiet({ service: { pickup: { paused: true, until: new Date(T + 10 * 60e3).toISOString() } } }, from, at), true);
});

test("serviceQuiet: إيقاف خلص جوّه النافذة ⇒ لسه ساكت لحد ما تنضف", () => {
  // `until` عدّى بـ١٠ دقايق بس — نص النافذة كان إيقاف
  const lapsed = { service: { delivery: { paused: true, until: new Date(T - 10 * 60e3).toISOString() } } };
  assert.equal(serviceQuiet(lapsed, from, at), true);
  // ورجعوا رسمي جوّه النافذة
  assert.equal(serviceQuiet({ service: { resumedAt: new Date(T - 30 * 60e3).toISOString() } }, from, at), true);
});

test("serviceQuiet: إيقاف قديم خارج النافذة ⇒ الحارس شغّال عادي", () => {
  assert.equal(serviceQuiet({ service: { resumedAt: new Date(T - 200 * 60e3).toISOString() } }, from, at), false);
  assert.equal(serviceQuiet({ service: { delivery: { paused: true, until: new Date(T - 200 * 60e3).toISOString() } } }, from, at), false);
  assert.equal(serviceQuiet({}, from, at), false);
  assert.equal(serviceQuiet(null, from, at), false);
});

/* ═══ ٦) الرسايل ═════════════════════════════════════════════════════════ */

test("رسايل «الطابور واقف» رسالة واحدة (مش أكتر من سيجمنت)", () => {
  for (const w of [{ landed: 60, entered: 8 }, { landed: 240, entered: 0 }, { landed: 999, entered: 44 }]) {
    for (const lang of ["en", "ar"]) {
      assert.equal(smsInfo(stallText({ ...w }, cfg, lang)).segments, 1, `${lang} ${JSON.stringify(w)}`);
    }
  }
});

test("الرسالة بتقول الرقم اللي المدير يتصرّف بيه، والنافذة", () => {
  const t = stallText({ landed: 200, entered: 11 }, cfg, "en");
  assert.match(t, /11 carts/);
  assert.match(t, /0 logged in/);
  assert.match(t, /120min/);
  // ورسالة القاعدة الأولى ما اتغيّرتش
  assert.match(downText({ ready: 7, payPage: 0 }, cfg, "en"), /7 customers ready to pay/);
});

/* ═══ ٧) الدورة كاملة (قاعدة بيانات وهمية) ═══════════════════════════════ */

function fakePool(nums) {
  const q = [];
  return {
    queries: q,
    query: async (sql, vals) => {
      const s = String(sql);
      q.push({ sql: s, vals });
      if (/FROM journey_events e/.test(s)) {
        return { rows: [{ ready: nums.ready, pay_page: nums.payPage, entered: nums.entered, advanced: nums.advanced }] };
      }
      if (/count\(\*\)::int AS landed FROM journey_sessions/.test(s)) return { rows: [{ landed: nums.landed }] };
      if (/AS last_paid/.test(s)) return { rows: [{ paid: nums.paid, last_paid: null, paid_long: nums.paidLong }] };
      if (/SELECT \* FROM checkout_watch/.test(s)) return { rows: nums.prev ? [nums.prev] : [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

const OPEN_HOURS = { enabled: true, days: { sun: { open: "12:00", close: "02:00" }, mon: { open: "12:00", close: "02:00" },
  tue: { open: "12:00", close: "02:00" }, wed: { open: "12:00", close: "02:00" }, thu: { open: "12:00", close: "03:00" },
  fri: { open: "12:00", close: "03:00" }, sat: { open: "12:00", close: "02:00" } } };
const OPEN_NOW = new Date("2026-09-24T18:00:00Z");   // ٩ مسا بالرياض
const CLOSED_NOW = new Date("2026-09-24T06:00:00Z"); // ٩ صباحاً بالرياض

async function run(nums, { settings = {}, now = OPEN_NOW } = {}) {
  const pool = fakePool(nums);
  const sent = [];
  const out = await runOnce({
    pool, getSettingsData: async () => ({ hours: OPEN_HOURS, ...settings }),
    staff: { critical: async (t) => { sent.push(typeof t === "function" ? t() : t); return 1; } },
    log: () => {},
  }, { now });
  return { out, sent, pool };
}

test("الدورة: عطل الدخول ⇒ رسالة «الطابور واقف» فعلاً بتتبعت", async () => {
  const { out, sent } = await run({ ready: 0, payPage: 0, paid: 0, landed: 200, entered: 13, advanced: 0, paidLong: 0 });
  assert.equal(out.reason, "stall");
  assert.equal(out.action, "alert");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /checkout STALLED/);
  assert.equal(out.metrics.entered, 13);
  assert.equal(out.metrics.advanced, 0);
  assert.equal(out.metrics.landed, 200);
});

test("الدورة: مقفول ⇒ ولا استعلام إنذار ولا رسالة", async () => {
  const { out, sent } = await run(
    { ready: 30, payPage: 0, paid: 0, landed: 300, entered: 40, advanced: 0, paidLong: 0 }, { now: CLOSED_NOW });
  assert.equal(out.open, false);
  assert.equal(out.action, "none");
  assert.equal(sent.length, 0);
});

test("الدورة: الخدمة موقوفة ⇒ ولا رسالة، واللوج بيقول paused", async () => {
  const { out, sent } = await run(
    { ready: 30, payPage: 0, paid: 0, landed: 300, entered: 40, advanced: 0, paidLong: 0 },
    { settings: { service: { delivery: { paused: true, until: null } } } });
  assert.equal(out.quiet, true);
  assert.equal(out.action, "none");
  assert.equal(sent.length, 0);
  assert.match(out.line, /paused/);
});

test("الدورة: دنيا صحية ⇒ سكوت، والأرقام الاتنين بتتسجّل في اللوج", async () => {
  const { out, sent } = await run({ ready: 4, payPage: 3, paid: 2, landed: 190, entered: 18, advanced: 7, paidLong: 4 });
  assert.equal(out.action, "none");
  assert.equal(out.reason, null);
  assert.equal(sent.length, 0);
  assert.match(out.line, /cart=18 login=7/);
});

test("الدورة: القاعدة الأولى (عطل ٢٢/٩) لسه بترن بنفس رسالتها", async () => {
  const { out, sent } = await run({ ready: 14, payPage: 0, paid: 0, landed: 200, entered: 20, advanced: 9, paidLong: 0 });
  assert.equal(out.reason, "pay");
  assert.match(sent[0], /ready to pay/);
});

test("الدورة: كل قاعدة بنافذتها، ومسحة واحدة بس على journey_events", async () => {
  const { pool } = await run({ ready: 0, payPage: 0, paid: 0, landed: 10, entered: 0, advanced: 0, paidLong: 0 });
  const evQ = pool.queries.filter((x) => /FROM journey_events e/.test(x.sql));
  assert.equal(evQ.length, 1, "مسحة واحدة — الجدول ده مالوش index على at");
  const mins = (a, b) => (new Date(b) - new Date(a)) / 60e3;
  // [scanFrom, now, shortFrom, longFrom]
  assert.equal(mins(evQ[0].vals[2], evQ[0].vals[1]), WATCH_DEFAULTS.windowMin, "القاعدة الأولى ٤٥ د");
  assert.equal(mins(evQ[0].vals[3], evQ[0].vals[1]), WATCH_DEFAULTS.stallWindowMin, "القاعدة التانية ١٢٠ د");
  assert.equal(mins(evQ[0].vals[0], evQ[0].vals[1]), WATCH_DEFAULTS.stallWindowMin, "المسحة على أوسع نافذة");
  const landQ = pool.queries.find((x) => /AS landed FROM journey_sessions/.test(x.sql));
  assert.equal(mins(landQ.vals[0], landQ.vals[1]), WATCH_DEFAULTS.stallWindowMin);
});
