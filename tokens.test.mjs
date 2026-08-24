/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات فاتورة التوكنز + الدروس اللي اتعلمناها من دفتر الإيقاع

   الجزء الأول (المحاسبة) بيثبت إن العدّاد بيقرا الشكلين اللي المزوّدين
   بيرجّعوهم — أنثروبيك الأصلي و OpenAI-compatible بتاع LiteLLM — وإن
   التوكنز المكاشّية مابتتحاسبش بنفس تمن الجديدة. من غير ده الميزانية
   اليومية هتقفل الطيار وهو بيصرف عُشر اللي فاكرينه.

   الجزء التاني (الإيقاع) بيقفل على السلوك اللي غيّرناه يوم ٢٤ أغسطس بعد
   ما قرينا ثلاث أسابيع دفتر:
     • تسع رفعات ١٥٪ يوم ١٢ أغسطس طلّعوا **صفر** صرف إضافي (٣٠٤٫٣٩ ر.س
       مقابل ٣١٢٫٢١ امبارحها و٣٠٦٫٩١ بكرتها) — فبقى فيه سقف لمسات يومي.
     • كل الزيادات راحت للحملات اللي تكلفة نتيجتها ١٦–٣٤ ر.س، وحملة
       الواتساب (٢٫٧٥ ر.س للنتيجة، ٨٧٪ من نتايج الحساب) مخدتش ولا رفعة —
       فالترتيب بقى بالأرخص مش بالأكتر صرفاً.

     node --test tokens.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseUsage, billableTokens, isCacheShapeError, decidePace, PACE_DEFAULTS,
} from "./autopilot.js";

/* ── ١. المحاسبة ─────────────────────────────────────────────────────── */

test("شكل أنثروبيك: كل حقل بيروح مكانه", () => {
  const u = normaliseUsage({
    input_tokens: 1200, output_tokens: 300,
    cache_read_input_tokens: 9000, cache_creation_input_tokens: 400,
  }, "anthropic");
  assert.deepEqual(u, { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 400 });
});

test("شكل LiteLLM: المكاشّي بيتشال من prompt_tokens مش بيتعدّ مرتين", () => {
  /* OpenAI بتحط الكاش **جوّه** prompt_tokens، عكس أنثروبيك اللي بتفصله.
     لو مافصلناهوش كنا هنحسب ١٠٬٢٠٠ توكن جديد بدل ١٬٢٠٠. */
  const u = normaliseUsage({
    prompt_tokens: 10200, completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 9000 },
  }, "litellm");
  assert.equal(u.input, 1200);
  assert.equal(u.cacheRead, 9000);
  assert.equal(u.output, 300);
});

test("مفيش usage في الرد = أصفار، مش انفجار", () => {
  assert.deepEqual(normaliseUsage(null, "anthropic"),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(normaliseUsage(undefined, "litellm"),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("الكاش بيتحاسب بعُشر التمن — وده بيت القصيد", () => {
  const withCache = billableTokens({ input: 1200, output: 300, cacheRead: 9000, cacheWrite: 0 });
  const without = billableTokens({ input: 10200, output: 300, cacheRead: 0, cacheWrite: 0 });
  assert.equal(withCache, 1200 + 300 + 900);
  assert.equal(without, 10500);
  assert.ok(withCache < without / 4,
    `نفس المحادثة بالكاش المفروض تبقى أرخص بكتير: ${withCache} مقابل ${without}`);
});

test("كتابة الكاش أغلى شوية من العادي — عشان ما نتفاجأش بأول نداء", () => {
  assert.equal(billableTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 }), 1250);
});

/* ── ٢. الإيقاع: سقف اللمسات اليومي ──────────────────────────────────── */

const PULSE_HOT = {
  riyadhHour: 18, riyadhMinute: 0, elapsedH: 14, dow: 3, pacePct: 30, pace: 0.3,
  today: { orders: 20, revenue: 1200 }, baseline: { orders: 14, revenue: 900, days: 4 },
  confidence: { level: "عالي", note: "" },
};
const S = { ...PACE_DEFAULTS, maxTotalBudget: 1000, maxCampaignBudget: 500, maxChangePct: 30 };
const runPace = (rows, state = new Map(), s = S) => decidePace({
  rows, state, s, now: new Date(), accountDay: "2026-08-13",
  msToRoll: 12 * 3600_000, pulse: PULSE_HOT, hardCap: 2000,
});

test("الهدف اللي خد سقف رفعات اليوم مبياخدش رفعة زيادة", () => {
  const rows = [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE",
    dailyBudget: 120, spend: 60, spendToday: 60, results: 4 }];
  const state = new Map([["meta:campaign:1", {
    platform: "meta", campaignId: "1", campaignName: "fc-prospect-asc", level: "campaign",
    accountDay: "2026-08-13", baseBudget: 80, currentBudget: 120,
    steps: PACE_DEFAULTS.paceMaxStepsPerDay,
    lastActionAt: Date.now() - 6 * 3600_000,   // التبريد عدّى خلاص
  }]]);
  const out = runPace(rows, state);
  assert.equal(out.actions.filter((a) => a.op === "up").length, 0, "مفيش رفعة رابعة");
  const note = out.notes.find((n) => n.op === "step-budget");
  assert.ok(note, `المفروض سبب مكتوب: ${JSON.stringify(out.notes)}`);
  assert.match(note.text, /سقف اليوم/);
});

test("وتحت السقف بترفع عادي", () => {
  const rows = [{ platform: "meta", id: "1", name: "fc-prospect-asc", status: "ACTIVE",
    dailyBudget: 100, spend: 60, spendToday: 60, results: 4 }];
  const state = new Map([["meta:campaign:1", {
    platform: "meta", campaignId: "1", campaignName: "fc-prospect-asc", level: "campaign",
    accountDay: "2026-08-13", baseBudget: 80, currentBudget: 100, steps: 1,
    lastActionAt: Date.now() - 6 * 3600_000,
  }]]);
  const out = runPace(rows, state);
  assert.equal(out.actions.filter((a) => a.op === "up").length, 1);
});

test("خطوة ميتا فضلت تحت عتبة الـ ٢٠٪ بعد ما رفعنا الخطوة العامة لـ ١٩٪", () => {
  /* ميتا بتعتبر ٢٠٪ أو أكتر «تعديل جوهري» وبتصفّر التعلّم. الرقم ١٩ مقصود:
     أكبر خطوة مش بتصفّر، ولازم يفضل كده مهما اتغيّرت الإعدادات. */
  const rows = [{ platform: "meta", id: "1", name: "x", status: "ACTIVE",
    dailyBudget: 100, spend: 60, spendToday: 60, results: 4 }];
  const out = runPace(rows, new Map(), { ...S, paceStepPct: 40, maxChangePct: 40 });
  const up = out.actions.find((a) => a.op === "up");
  assert.ok(up, "المفروض ترفع");
  assert.ok(up.stepPct <= 19, `خطوة ميتا ${up.stepPct}٪ — لازم تفضل تحت ٢٠`);
});

/* ── ٣. الإيقاع: الأرخص قبل الأغلى ───────────────────────────────────── */

test("لما السقف يضيق، الفلوس بتروح للنتيجة الأرخص مش للأكتر صرفاً", () => {
  /* الحالة الحقيقية من الحساب: حملة واتساب بتجيب النتيجة بـ ٢٫٧٥ ر.س،
     وحملة ليدز بتجيبها بـ ٣٣ ر.س وبتصرف أكتر. الترتيب القديم (بالصرف)
     كان بيدّي المساحة للتانية. */
  const rows = [
    { platform: "meta", id: "expensive", name: "fc-prospect-lal", status: "ACTIVE",
      dailyBudget: 200, spend: 200, spendToday: 200, results: 6 },     // ٣٣٫٣ ر.س/نتيجة
    { platform: "meta", id: "cheap", name: "fc-wa-orders", status: "ACTIVE",
      dailyBudget: 100, spend: 100, spendToday: 100, results: 36 },    // ٢٫٧٨ ر.س/نتيجة
  ];
  /* سقف كلي ضيق: فيه مساحة لرفعة واحدة بس. */
  const out = runPace(rows, new Map(), { ...S, maxTotalBudget: 310 });
  const ups = out.actions.filter((a) => a.op === "up");
  assert.ok(ups.length >= 1, "المفروض ترفع واحدة على الأقل");
  assert.equal(ups[0].campaignId, "cheap",
    `أول رفعة المفروض تروح للأرخص، راحت لـ ${ups[0].campaignId}`);
  assert.ok(ups[0].to > ups[0].from);
});

test("اللي لسه ملوش نتايج بيتحط بعد اللي ليه رقم — معرفناش ≠ رخيص", () => {
  const rows = [
    { platform: "meta", id: "unknown", name: "fc-new", status: "ACTIVE",
      dailyBudget: 100, spend: 100, spendToday: 100, results: 0 },
    { platform: "meta", id: "known", name: "fc-wa-orders", status: "ACTIVE",
      dailyBudget: 100, spend: 100, spendToday: 100, results: 20 },
  ];
  const out = runPace(rows, new Map(), { ...S, maxTotalBudget: 210 });
  const ups = out.actions.filter((a) => a.op === "up");
  assert.ok(ups.length >= 1);
  assert.equal(ups[0].campaignId, "known");
});

test("التقريب مايكسرش سور الـ ١٩٪ — ٣٥ × ١٫١٩ لازم تطلع ٤١ مش ٤٢", () => {
  /* ٤٢ من ٣٥ = ٢٠٪ بالظبط، وهي العتبة اللي ميتا بتصفّر عندها التعلّم.
     الباج ده مكانش بيبان وإحنا على خطوة ١٥٪، وبقى بيبان أول ما قرّبنا
     الخطوة من العتبة. الاختبار ده بيمنع رجوعه. */
  const rows = [{ platform: "meta", id: "1", name: "x", status: "ACTIVE",
    dailyBudget: 35, spend: 35, spendToday: 35, results: 10 }];
  const out = runPace(rows, new Map());
  const up = out.actions.find((a) => a.op === "up");
  assert.ok(up, "المفروض ترفع");
  assert.equal(up.to, 41);
  assert.ok((up.to - up.from) / up.from * 100 < 20,
    `الخطوة المتنفّذة ${((up.to - up.from) / up.from * 100).toFixed(1)}٪ لازم تفضل تحت ٢٠`);
});

/* ── ٤. رفض الكاش ≠ أي رفض ───────────────────────────────────────────── */

test("رسالة الرصيد الخالص مش رفض كاش — مايتعملهاش نداء تاني", () => {
  /* اللي حصل فعلاً على السيرفر: أنثروبيك بترجّع 400 لما الرصيد يخلص، وأول
     نسخة من كود الكاش كانت بتعيد المحاولة على أي 400 — يعني نداءين بدل
     واحد، والكاش بيتقفل غلط لباقي عمر العملية. */
  assert.equal(isCacheShapeError(
    'litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}'), false);
  assert.equal(isCacheShapeError("LLM 400: rate limit"), false);
  assert.equal(isCacheShapeError(""), false);
});

test("رفض شكل الكاش بيتعرف ويتعمله محاولة من غير كاش", () => {
  assert.equal(isCacheShapeError('Extra inputs are not permitted: tools.0.cache_control'), true);
  assert.equal(isCacheShapeError('unexpected field "ephemeral"'), true);
});
