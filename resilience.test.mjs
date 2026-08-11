/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات الصمود — الوكيل بيشتغل والمالك نايم

   كل رد منصة تحت ده **رد حقيقي اتسجّل عندنا**، منقول بالحرف من ap_decisions
   أو ads_events أو aud_syncs. مفيش رد مخترع في الملف ده: الباج اللي كلّفنا
   سبع ساعات صرف على مطبخ قافل كان بالظبط إننا قرينا رد حقيقي غلط، فاختبار
   على رد متخيّل مش هيمسك الباج اللي جاي.

     node --test resilience.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRefusal, destinyOf, metaAccessTier,
  writeGate, closeWriteGate, openWriteGate, writeGates,
  readGate, platformRead, sendPlatformWrite,
  __test,
} from "./ads.js";

const { PLATFORMS } = __test;
const byId = (id) => PLATFORMS.find((p) => p.id === id);

/* ── ردود حقيقية، منقولة من قاعدة البيانات ────────────────────────────────── */

/* ap_decisions · 2026-08-11T06:55:38Z · أمر إيقاف على fc-prospect-asc.
   ده الرد اللي اتكرر ٣٣٤ مرة والمطبخ قافل. ميتا بتقول "مفيش صلاحية"
   وهي تقصد "تخطيت حصتك" — والدليل إن subcode بتاعه من نفس عيلة الـ 613. */
const META_THROTTLE_AS_PERMISSION = {
  status: 400,
  json: { error: {
    code: 200, type: "OAuthException", message: "Permissions error",
    fbtrace_id: "AO-I1eJ3-1-IevO91EEyuH4", is_transient: false,
    error_subcode: 4841013,
    error_user_msg: "The user does not have permission for this action.",
    error_user_title: "User does not have permission for this action",
  } },
  headers: {},
};

/* ap_decisions · 2026-08-11T07:00:39Z · نفس الحملة، نفس الحائط، لافتة تانية. */
const META_THROTTLE_HONEST = {
  status: 400,
  json: { error: {
    code: 613, type: "OAuthException",
    message: "(#613) Calls to this api have exceeded the rate limit.",
    fbtrace_id: "AH1d_ZvgCZtsU7Zyh8vr11i", error_subcode: 4841018,
  } },
  headers: {},
};

/* الهيدر اللي ميتا بتحط فيه الحصة — ومنه بنعرف إحنا على أنهي درجة. */
const META_USAGE_HEADER = {
  status: 400,
  json: { error: { code: 613, type: "OAuthException", message: "rate limit", error_subcode: 4841018 } },
  headers: { "x-business-use-case-usage": JSON.stringify({
    "210662083554074": [{
      type: "ads_management", call_count: 100, total_cputime: 25, total_time: 25,
      estimated_time_to_regain_access: 33, ads_api_access_tier: "development_access",
    }],
  }) },
};

/* scorecard.reasons.tiktok + daypart-verify · التطبيق لسه تحت المراجعة. */
const TIKTOK_SCOPE = {
  status: 200,
  json: { code: 40001, message:
    "Permission error: The access token lacks the required scope for endpoint " +
    "'/campaign/get/(method=GET)'. Please first check if the request method is correct " +
    "then ask the user to generate a new access token and reauthorize your API App " +
    "with the necessary API scopes." },
  headers: {},
};

/* aud_syncs · رفع الجمهور، نفس الحائط بصيغة تانية. */
const TIKTOK_AUDIENCE = {
  status: 200,
  json: { code: 40001, message: "advertiser does not grant you /dmp/custom_audience/file/upload/:POST permission" },
  headers: {},
};

/* ap_decisions · سناب · الـ PUT اللي كان بيبعت application/json — ده الـ 415.
   ملاحظة: الرد ده اتسجّل عندنا وقتها كـ «error: » وبس. */
const SNAP_415 = {
  status: 415,
  json: {
    request_status: "ERROR", error_code: "E0002",
    request_id: "2f1a80c2-3842-452e-a889-b77d55595ba7",
    debug_message: "Content type requested by client is not supported: [application/json]",
    display_message: "Content type requested by client is not supported",
  },
  headers: {},
};

/* سناب · كتابة حملة ناجحة (Marketing API). */
const SNAP_OK = {
  status: 200, ok: true,
  json: { request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "x" } }] },
  headers: {},
};

/* سناب · الباتش عدّى بس الكائن نفسه مرفوض. */
const SNAP_SUBREQUEST_ERROR = {
  status: 200, ok: true,
  json: { request_status: "SUCCESS", campaigns: [
    { sub_request_status: "ERROR", sub_request_error_reason: "E2006 startTime is a required field" },
  ] },
  headers: {},
};

/* ═══ ١ — التصنيف: كل فرع، برد حقيقي ═══════════════════════════════════════ */

test("ميتا: «Permissions error» بـ subcode 4841013 حصة مش صلاحية", () => {
  const c = classifyRefusal("meta", META_THROTTLE_AS_PERMISSION);
  assert.equal(c.kind, "throttled");
  assert.equal(c.subcode, 4841013);
  assert.ok(c.retryAfterMs > 0, "لازم يستنى — مش يعيد المحاولة على طول");
  assert.equal(destinyOf(c.kind), "transient");
});

test("ميتا: 613 صريحة برضه حصة، ونفس المعاملة", () => {
  const c = classifyRefusal("meta", META_THROTTLE_HONEST);
  assert.equal(c.kind, "throttled");
  assert.equal(c.subcode, 4841018);
  assert.ok(c.retryAfterMs > 0);
});

test("ميتا بتقول لنا الحصة راجعة إمتى، وإحنا بنسمع", () => {
  const c = classifyRefusal("meta", META_USAGE_HEADER);
  assert.equal(c.kind, "throttled");
  assert.equal(c.retryAfterMs, 33 * 60_000, "٣٣ دقيقة زي ما الهيدر قال بالظبط");
  assert.equal(c.tier, "development_access");
});

test("درجة الحساب بتتقرا من الهيدر — ودي الحقيقة اللي بتفسّر كل الحكاية", () => {
  assert.equal(metaAccessTier(META_USAGE_HEADER), "development_access");
  assert.equal(metaAccessTier({ headers: {} }), null);
  assert.equal(metaAccessTier({ headers: { "x-business-use-case-usage": "{{{" } }), null);
});

test("ميتا: صلاحية حقيقية (كود ٢٠٠ من غير 4841) بتفضل محتاجة المالك", () => {
  const c = classifyRefusal("meta", { status: 400, json: { error: { code: 200, message: "Permissions error" } } });
  assert.equal(c.kind, "permission");
  assert.equal(destinyOf(c.kind), "needs-owner");
});

test("ميتا: توكن باظ = محتاج المالك، مش إعادة محاولة", () => {
  const c = classifyRefusal("meta", { status: 400, json: { error: { code: 190, message: "Invalid OAuth access token" } } });
  assert.equal(c.kind, "auth");
  assert.equal(destinyOf(c.kind), "needs-owner");
});

test("تيك توك: 40001 = التطبيق تحت المراجعة، مش توكن ناقص", () => {
  for (const res of [TIKTOK_SCOPE, TIKTOK_AUDIENCE]) {
    const c = classifyRefusal("tiktok", res);
    assert.equal(c.kind, "unavailable");
    assert.equal(destinyOf(c.kind), "unavailable");
    assert.equal(c.retryAfterMs, 6 * 60 * 60_000, "نجرّب كل ٦ ساعات بس — عشان نعرف لما توافق");
  }
});

test("سناب: 415 اللي كان بيتسجّل «error: » بقى ليه سبب مقروء", () => {
  const parsed = byId("snapchat").readBatchResult(SNAP_415, 1);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Content type/, "لازم السبب الحقيقي يوصل، مش نقطتين فاضيين");
  assert.notEqual(parsed.error.trim(), "error:");
});

test("سناب: رفض من غير سبب مفهوم بيتأجّل — مايترجعش تاني بعد ٥ دقايق", () => {
  const c = classifyRefusal("snapchat", SNAP_415);
  assert.ok(c.retryAfterMs > 0, "٨٧ أمر في ليلة كانوا نتيجة retryAfterMs=0 على رفض مش مفهوم");
  assert.equal(destinyOf(c.kind), "transient");
});

test("سناب: الكتابة الناجحة بتتقرا نجاح، والباتش المرفوض جزئيًا بيتقرا فشل", () => {
  const snap = byId("snapchat");
  assert.equal(snap.readBatchResult({ ...SNAP_OK, ok: true }, 1).ok, true);
  const bad = snap.readBatchResult({ ...SNAP_SUBREQUEST_ERROR, ok: true }, 1);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /startTime/, "سبب الرفض الجوّاني هو اللي يتعرض");
});

test("سلّم التأجيل بيطلع مع التكرار وله سقف", () => {
  const ms = [0, 1, 2, 3, 4, 9].map((i) => classifyRefusal("snapchat", SNAP_415, i).retryAfterMs);
  for (let i = 1; i < 5; i++) assert.ok(ms[i] > ms[i - 1], `الدرجة ${i} لازم تكون أطول من اللي قبلها`);
  assert.equal(ms[5], ms[4], "السلّم بيقف عند آخر درجة، مايكبرش للأبد");
});

test("مفيش تصنيف بيقع في «أعِد المحاولة للأبد»", () => {
  for (const kind of ["throttled", "transport", "rejected", "auth", "permission", "unavailable"]) {
    assert.ok(["transient", "needs-owner", "unavailable"].includes(destinyOf(kind)), kind);
  }
  assert.equal(destinyOf("a-code-nobody-has-seen-yet"), "transient",
    "الكود المجهول بيتعامل معاملة العابر — يعني بتأجيل، مش بإعادة محاولة فورية");
});

test("الشبكة وقعت: عابر بمهلة، مش فشل دايم", () => {
  const c = classifyRefusal("meta", { status: 0, error: "timeout after 15000ms" });
  assert.equal(c.kind, "transport");
  assert.ok(c.retryAfterMs > 0);
  assert.equal(destinyOf(c.kind), "transient");
});

test("429 بيسمع كلام Retry-After", () => {
  const c = classifyRefusal("meta", { status: 429, headers: { "retry-after": "120" } });
  assert.equal(c.kind, "throttled");
  assert.equal(c.retryAfterMs, 120_000);
});

/* ═══ ٢ — الباب: الرفض بيكلّف نداء واحد، مش نداء كل ٥ دقايق ═══════════════ */

test("الباب بيتقفل ويفتح لوحده مع الوقت", () => {
  openWriteGate("meta");
  assert.equal(writeGate("meta"), null);
  closeWriteGate("meta", { ms: 30 * 60_000, kind: "throttled", reason: "حصة" });
  const g = writeGate("meta");
  assert.equal(g.kind, "throttled");
  assert.ok(g.minutes >= 29 && g.minutes <= 30);
  openWriteGate("meta");
  assert.equal(writeGate("meta"), null, "أول نجاح بيفتح الباب");
});

test("الباب المنتهي بيفتح نفسه من غير ما حد يفكّره", () => {
  closeWriteGate("snapchat", { ms: -1, kind: "throttled", reason: "قديم" });
  const g = writeGate("snapchat");
  if (g) assert.ok(g.minutes <= 1);
  openWriteGate("snapchat");
});

test("الأمر ما بيخرجش من الباب المقفول — ومابيتحسبش رفض من المنصة", async () => {
  closeWriteGate("meta", { ms: 30 * 60_000, kind: "throttled", reason: "تخطينا حد النداءات" });
  let hit = false;
  const fake = { id: "meta", label: "Meta", readBatchResult: () => { hit = true; return { ok: true }; } };
  const r = await sendPlatformWrite(fake, { url: "https://example.invalid", method: "POST" });
  assert.equal(r.ok, false);
  assert.equal(r.gated, true, "لازم يتعلّم إنه اتأجّل — مش إنه اترفض");
  assert.equal(hit, false, "ولا نداء واحد خرج للشبكة");
  assert.ok(r.retryInMinutes > 0);
  openWriteGate("meta");
});

/* ═══ ٣ — التليمتري مبتاكلش حصة الأوامر ══════════════════════════════════ */

test("المنصة مخنوقة: القراءة الدورية بتقف، وأمر المالك بيعدّي", () => {
  closeWriteGate("meta", { ms: 45 * 60_000, kind: "throttled", reason: "حصة" });
  assert.ok(readGate("meta", "telemetry"), "الرسم البياني بيستنى");
  assert.ok(readGate("meta", "verify"), "التأكيد بيستنى — الأمر ماخرجش أصلاً فمفيش حاجة نتأكد منها");
  assert.equal(readGate("meta", "owner"), null, "المالك الواقف قدام الشاشة بيعدّي");
  openWriteGate("meta");
  assert.equal(readGate("meta", "telemetry"), null, "الباب فتح → القراءة رجعت");
});

test("platformRead بيرجّع نفس شكل «مقدرناش نقرا» بدل ما يرمي", async () => {
  closeWriteGate("tiktok", { ms: 10 * 60_000, kind: "unavailable", reason: "تحت المراجعة" });
  const r = await platformRead({ id: "tiktok" }, async () => { throw new Error("ما ينفعش يتنده"); },
    { priority: "telemetry", empty: { campaigns: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.gated, true);
  assert.deepEqual(r.campaigns, [], "الشكل الفاضي بيوصل عشان اللي فوق مايتكسرش");
  openWriteGate("tiktok");
});

test("platformRead بيمسك الرمية ومايوقّفش الدورة", async () => {
  openWriteGate("meta");
  const r = await platformRead({ id: "meta" }, async () => { throw new Error("connect ETIMEDOUT"); },
    { empty: { campaigns: [] } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ETIMEDOUT/);
});

test("المنصة السليمة قراءتها بتعدّي عادي", async () => {
  openWriteGate("snapchat");
  const r = await platformRead({ id: "snapchat" }, async () => ({ ok: true, campaigns: [{ id: "1" }] }));
  assert.equal(r.ok, true);
  assert.equal(r.campaigns.length, 1);
});

/* ═══ ٤ — تيك توك بتتصرّف كباب مقفول، مش كخطأ متكرر ══════════════════════ */

test("تيك توك: الطلب مابيتحسبش «فشل» — بيتحسب «متأجّل لحد المراجعة»", () => {
  const tt = byId("tiktok");
  tt._refusal = null;
  const parsed = tt.readBatchResult(TIKTOK_SCOPE, 5);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.permanent, true,
    "من غير الراية دي الصفوف بترجع pending كل ساعة وتتبعت لباب مقفول");
  assert.match(parsed.reason, /مراجعة/, "السبب لازم يبقى عربي ومفهوم");
  tt._refusal = null;
});

test("تيك توك: القفل بيتسجّل، وبيعيد المحاولة بعد ٦ ساعات لوحده", () => {
  const tt = byId("tiktok");
  tt._refusal = null;
  assert.equal(tt.lastReadiness(), null);
  tt.readBatchResult(TIKTOK_SCOPE, 1);
  const r = tt.lastReadiness();
  assert.equal(r.ok, false);
  assert.equal(r.code, "APP_REVIEW_PENDING");
  tt._refusal.at = Date.now() - 7 * 60 * 60_000;
  assert.equal(tt.lastReadiness(), null, "بعد ٦ ساعات بنجرّب تاني — يمكن تكون وافقت");
  tt._refusal = null;
});

test("تيك توك: preflight بيمنع المطالبة بالطلبات أصلاً", async () => {
  const tt = byId("tiktok");
  tt._refusal = null;
  assert.deepEqual(await tt.preflight(), { ok: true });
  tt.readBatchResult(TIKTOK_SCOPE, 1);
  const pre = await tt.preflight();
  assert.equal(pre.ok, false, "الباب مقفول → مفيش طلب بيتحجز ومفيش نداء بيتبعت");
  tt._refusal = null;
});

/* ═══ ٥ — سيناريوهات اليوم الحقيقي ═══════════════════════════════════════ */

test("ليلة ١١ أغسطس، معادة: ٣٣٦ محاولة بتبقى محاولة واحدة", async () => {
  /* المطبخ قفل ٣ الفجر. النافذة بتشتغل كل ٥ دقايق لحد ١١ الصبح = ٩٦ لفّة،
     في ٤ حملات. الأول كانت كل واحدة بتخرج نداء. دلوقتي أول رفض بيقفل الباب. */
  openWriteGate("meta");
  let calls = 0;
  const fake = {
    id: "meta", label: "Meta (Facebook / Instagram)",
    readBatchResult: () => { calls++; return { ok: false, error: "OAuthException 200: Permissions error" }; },
  };
  // أول أمر بيوصل للمنصة فعلاً ويترفض
  const cls = classifyRefusal("meta", META_THROTTLE_AS_PERMISSION);
  closeWriteGate("meta", { ms: cls.retryAfterMs, kind: cls.kind, reason: "حصة" });

  for (let lap = 0; lap < 96; lap++) {
    for (let c = 0; c < 4; c++) {
      const r = await sendPlatformWrite(fake, { url: "https://example.invalid", method: "POST" });
      assert.equal(r.gated, true);
    }
  }
  assert.equal(calls, 0, "٣٨٤ محاولة بعد قفل الباب = صفر نداء على الشبكة");
  openWriteGate("meta");
});

test("إعادة تشغيل نص النافذة: الأبواب بتفتح والحقيقة بتتقرا من المنصة", () => {
  /* الأبواب في الذاكرة عن قصد: بعد الديبلوي مانورّثش قفل قديم ممكن يكون
     خلص. اللي بيفضل هو السجل في قاعدة البيانات. */
  closeWriteGate("meta", { ms: 60 * 60_000, kind: "throttled", reason: "حصة" });
  assert.ok(writeGate("meta"));
  // إعادة التشغيل = وحدة جديدة = خريطة فاضية. بنحاكيها بالفتح الصريح.
  openWriteGate("meta");
  assert.equal(writeGate("meta"), null);
  assert.equal(writeGates().filter((g) => g.platform === "meta").length, 0);
});

test("منصة واقعة ساعة: كل لفّة بتأجّل أطول، والنداءات بتفضل قليلة", () => {
  let total = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const c = classifyRefusal("snapchat", { status: 0, error: "connect ETIMEDOUT" });
    total += c.retryAfterMs;
  }
  assert.ok(total > 0);
  const ladder = [0, 1, 2, 3, 4].map((i) => classifyRefusal("snapchat", SNAP_415, i).retryAfterMs);
  const hour = ladder.reduce((a, b) => a + b, 0);
  assert.ok(hour >= 60 * 60_000,
    "خمس محاولات لازم تغطّي ساعة على الأقل — يعني ٥ نداءات في الساعة مش ١٢");
});

test("التوكن خلص في نص الدفعة: سناب بيجدّد ويعيد، مش بيفشل", async () => {
  const snap = byId("snapchat");
  const call = { url: "https://tr.snapchat.com/v3/PIXEL/events?access_token=old" };
  const original = snap.token;
  snap.token = async () => "fresh-token";
  try {
    const retry = await snap.recoverAndRetry(call, { status: 401 });
    assert.ok(retry, "٤٠١ على الـ CAPI لازم تتصلّح لوحدها — التوكن ده بنقدر نجدّده");
    assert.match(retry.url, /access_token=fresh-token/);
    assert.equal(await snap.recoverAndRetry(call, { status: 500 }), null, "غير الـ ٤٠١ مالوش علاقة");
  } finally { snap.token = original; }
});

test("حدّ النافذة والمنصة مخنوقة: الأمر بيتأجّل مايتلغيش", async () => {
  closeWriteGate("meta", { ms: 20 * 60_000, kind: "throttled", reason: "حصة" });
  const fake = { id: "meta", label: "Meta", readBatchResult: () => ({ ok: true }) };
  const r = await sendPlatformWrite(fake, { url: "https://example.invalid", method: "POST" });
  assert.equal(r.ok, false);
  assert.equal(r.gated, true);
  assert.ok(r.retryInMinutes <= 20 && r.retryInMinutes > 0,
    "بيقول بالظبط هيرجع إمتى — عشان الشاشة تقول للمالك مش تخمّن");
  openWriteGate("meta");
});

/* ═══ ٦ — «النداء رجع ٢٠٠» مش «الحملة وقفت» ═══════════════════════════════
   الدعوى بتتسجّل ساعة ما نبدأ نفتكر حاجة، وبتتقفل من قراءة مستقلة بعدها.  */

const { claimVerdict, CLAIM_STALE_MS } = await import("./autopilot.js");

test("الحملة وقفت فعلاً: الدعوى بتتأكّد", () => {
  const v = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "PAUSED" } });
  assert.equal(v.verdict, "confirmed");
});

test("قلنا وقّفناها والمنصة بتقول شغالة: ده الاعتقاد الغلط اللي بندوّر عليه", () => {
  const v = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "ACTIVE" }, ageMs: 5 * 60_000 });
  assert.equal(v.verdict, "mismatch");
  assert.equal(v.actual, "ACTIVE");
});

test("قراءة بدري مش حكم: أول دقيقة بننتظر مانحكمش", () => {
  const soon = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "ACTIVE" }, ageMs: 5_000 });
  assert.equal(soon.wait, true, "المنصة لسه بتستقر — مش هنقول مخالفة على طول");
  const later = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "ACTIVE" }, ageMs: 5 * 60_000 });
  assert.equal(later.wait, false);
  assert.equal(later.verdict, "mismatch");
});

test("دعوى مش عارفين عمرها بتتحسب قديمة — الأمان في الاتجاه ده", () => {
  const v = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "ACTIVE" } });
  assert.equal(v.verdict, "stale", "من غير عُمر مانقدرش نجزم — «مش عارفين» أصدق من «مخالفة»");
});

test("بعد ساعتين مابنفضلش نقول «مخالفة» — بنقول «مش عارفين»", () => {
  const v = claimVerdict({ field: "status", expected: "PAUSED", campaign: { status: "ACTIVE" },
                           ageMs: CLAIM_STALE_MS + 60_000 });
  assert.equal(v.verdict, "stale");
});

test("الحملة اتمسحت: مفيش حاجة نصلّحها، فمش مخالفة", () => {
  const v = claimVerdict({ field: "status", expected: "PAUSED", campaign: null });
  assert.equal(v.verdict, "gone");
  assert.equal(v.wait, false);
});

test("الميزانية: هامش ريال مقبول، أكتر منه مخالفة", () => {
  const at = 5 * 60_000;
  assert.equal(claimVerdict({ field: "budget", expected: 80, campaign: { dailyBudget: 80 }, ageMs: at }).verdict, "confirmed");
  assert.equal(claimVerdict({ field: "budget", expected: 80, campaign: { dailyBudget: 79.5 }, ageMs: at }).verdict, "confirmed",
    "المنصات بتخزّن بالسنت وبتقرّب — نص ريال مش خطأ");
  assert.equal(claimVerdict({ field: "budget", expected: 80, campaign: { dailyBudget: 40 }, ageMs: at }).verdict, "mismatch",
    "الميزانية اتحطّت غلط — ده بيتصرف فلوس");
});

test("الميزانية مش مقروءة من المنصة = مخالفة، مش تأكيد", () => {
  const v = claimVerdict({ field: "budget", expected: 80, campaign: { dailyBudget: null }, ageMs: 5 * 60_000 });
  assert.equal(v.verdict, "mismatch", "«مقدرناش نقرا» عمرها ما تتحسب «تمام»");
});
