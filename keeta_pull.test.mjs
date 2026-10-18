/* KA2 — بعد طلب كيتا: التقييم الأول، وبعدين «اطلب مباشرة من موقعنا» بشرط (عمر ١٨/١٠/٢٠٢٦)
   node --test keeta_pull.test.mjs  (قاعدة مزيّفة في الذاكرة، أرقام وهمية، من غير شبكة) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REVIEW_INVITE_MINUTES = "0";
process.env.REVIEWS_GOOGLE_JOB = "0";
const K = await import("./keeta_pull.js");
const { parseRecipientSlug } = await import("./wamsg.js");
const { inHoldout } = await import("./smsrules.js");
const { bizDayStart } = await import("./wafollow.js");
const { SERVER_OWNED_PATHS } = await import("./settings-guard.js");
const { sectionOf } = await import("./cms.js");
const CAT = await import("./watemplates.js");
const WC = await import("./waconsent.js");

const R = (hh, mm = 0, day = 18) => new Date(Date.UTC(2026, 9, day, hh - 3, mm));      // الرياض ⇒ UTC
const D = (open, close) => ({ open, close });
const HOURS = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, D("13:00", d === "thu" || d === "fri" ? "03:00" : "02:00")])) };
const CFG = K.pullCfg({ keeta: { pull: { enabled: true } } });

test("الإعدادات: مقفول افتراضياً، ٥٠ دقيقة، ٢٠/يوم، ١٠٪ محجوزين، فرملة ٣٪ بعد ٥٠ — والحدود", () => {
  const d = K.pullCfg({});
  assert.equal(d.enabled, false); assert.equal(d.reviewDelayMin, 50); assert.equal(d.dailyCap, 20); assert.equal(d.holdoutPct, 10);
  assert.equal(d.autoPauseOptoutPct, 3); assert.equal(d.autoPauseMinSends, 50); assert.equal(d.campaignGapDays, 7); assert.equal(d.template, "fc_try_website");
  assert.equal(K.pullCfg({ keeta: { pull: { enabled: "yes" } } }).enabled, false, "مفتوح بس بـtrue");
  assert.equal(K.pullCfg({ keeta: { pull: { dailyCap: 999, campaignGapDays: 1, holdoutPct: 80 } } }).dailyCap, 100);
  assert.equal(K.pullCfg({ keeta: { pull: { campaignGapDays: 1 } } }).campaignGapDays, 3, "أرضية الفاصل ٣");
  assert.equal(K.pullCfg({ keeta: { pull: { holdoutPct: 80 } } }).holdoutPct, 50);
  assert.equal(K.pullCfg({ keeta: { pull: { template: "fc_other" } } }).template, "fc_try_website");
  assert.equal(K.pullCfg({ keeta: { pull: { rulesReadAt: "2026-10-01", agreementNote: "x" } } }).rulesReadAt, undefined, "المالك شال الامتثال من اللوحة");
});

test("من اللوحة: أول تشغيل بيسجّل enabledAt (حماية أول تشغيل)، فكّ الإيقاف بيمسح السبب، والغلط مرفوض", () => {
  const now = R(15);
  const on = K.pullFromBody({ enabled: true }, {}, now);
  assert.equal(on.ok, true); assert.equal(on.value.enabledAt, now.toISOString());
  const again = K.pullFromBody({ dailyCap: 15 }, on.value, R(18));
  assert.equal(again.value.enabledAt, now.toISOString(), "مفتوح أصلاً ⇒ enabledAt مابيتغيّرش");
  const unp = K.pullFromBody({ paused: false }, { ...on.value, paused: true, pauseReason: "optout_4pct_of_50" }, R(18));
  assert.equal(unp.value.paused, false); assert.equal(unp.value.pauseReason, null);
  assert.equal(K.pullFromBody({ dailyCap: 0 }, {}).ok, false);
  assert.equal(K.pullFromBody({ enabled: 1 }, {}).ok, false);
  assert.equal(K.pullFromBody({ rulesReadAt: "2026-10-18" }, {}).ok, false, "مفيش حقول امتثال");
  const keys = K.pullSchemaRows({}).map((r) => r.key);
  for (const k of Object.keys(K.DEFAULT_PULL).filter((x) => !["enabledAt", "pauseReason", "pausedAt"].includes(x))) assert.ok(keys.includes(k), k);
  for (const r of K.pullSchemaRows({})) assert.match(r.ar, /[؀-ۿ]/, `${r.key} بتسمية عربي`);
});

test("طلب التقييم بعد طلب كيتا بـ٥٠ دقيقة (المرجع «وقت الطلب»)", () => {
  assert.equal(K.reviewDueOf(R(19, 40).toISOString(), CFG).toISOString(), R(20, 30).toISOString());
});

/* ═══ KA2c — «بعد ٥٠ دقيقة من تسليم الطلب للمندوب» (عمر ١٨/١٠) ═══════════════ */
test("KA2c الإعدادات: المرجع «التسليم» افتراضياً، ٥٠ د منه، انتظار ٩٠، احتياطي ٨٠ من الطلب، تجاهل قفل قبل ٥ د — والحدود واللوحة", () => {
  const d = K.pullCfg({});
  assert.equal(d.reviewAnchor, "handoff"); assert.equal(d.reviewDelayMin, 50); assert.equal(d.handoffWaitMin, 90); assert.equal(d.fallbackDelayMin, 80); assert.equal(d.handoffMinAfterOrderMin, 5);
  assert.equal(K.pullCfg({ keeta: { pull: { reviewAnchor: "order" } } }).reviewAnchor, "order");
  assert.equal(K.pullCfg({ keeta: { pull: { reviewAnchor: "x" } } }).reviewAnchor, "handoff");
  assert.equal(K.pullCfg({ keeta: { pull: { handoffWaitMin: 5 } } }).handoffWaitMin, 30, "أرضية الانتظار ٣٠");
  assert.equal(K.pullFromBody({ reviewAnchor: "order", handoffWaitMin: 120, fallbackDelayMin: 70 }, {}).ok, true);
  assert.equal(K.pullFromBody({ reviewAnchor: "pickup" }, {}).ok, false);
  assert.equal(K.pullFromBody({ fallbackDelayMin: 5 }, {}).ok, false);
  const rows = K.pullSchemaRows({});
  const a = rows.find((r) => r.key === "reviewAnchor");
  assert.equal(a.type, "enum"); assert.deepEqual(a.options, ["handoff", "order"]); assert.match(a.optionsAr.handoff, /تسليم/);
  for (const k of ["handoffWaitMin", "fallbackDelayMin", "handoffMinAfterOrderMin"]) assert.equal(rows.find((r) => r.key === k).type, "number", k);
  assert.ok(rows.findIndex((r) => r.key === "reviewAnchor") < rows.findIndex((r) => r.key === "reviewDelayMin"), "المرجع قبل المدة في الكارت");
  assert.equal(K.reasonAr("handoff_unknown"), K.KA2_REASON_AR.handoff_unknown);
});

test("KA2c التسليم من ويبهوكات نقطة البيع: قفل الطلب أو approval «اتسلّم/اتوصّل» — مش «جاهز»، مش رفض، ومش قفل بالغلط أول ما نزل", () => {
  const O = R(19).toISOString();
  const W = (mm, x) => ({ received_at: R(19, mm).toISOString(), ...x });
  assert.equal(K.handoffOf([], { orderAt: O }), null);
  assert.equal(K.handoffOf([W(1, { approval: "accepted", order_status: "processing" }), W(20, { approval: "pickup_ready" })], { orderAt: O }), null, "جاهز مش تسليم");
  assert.deepEqual(K.handoffOf([W(1, { approval: "accepted" }), W(20, { approval: "pickup_ready" }), W(26, { approval: "pickup_ready", order_status: "completed" })], { orderAt: O }),
    { at: R(19, 26).toISOString(), basis: "pos_closed" });
  assert.deepEqual(K.handoffOf([W(24, { approval: "picked_up" }), W(30, { order_status: "completed" })], { orderAt: O }), { at: R(19, 24).toISOString(), basis: "pos_approval" });
  assert.equal(K.handoffOf([W(24, { approval: "delivered" })], { orderAt: O }).basis, "pos_approval");
  assert.equal(K.handoffOf([W(24, { approval: "delivery_ready" })], { orderAt: O }), null, "delivery_* مش delivered");
  assert.equal(K.handoffOf([W(24, { approval: "rejected_delivered" })], { orderAt: O }), null, "رفض/إلغاء");
  assert.equal(K.handoffOf([W(2, { order_status: "completed" })], { orderAt: O }), null, "قفل بعد دقيقتين = غلط");
  assert.equal(K.handoffOf([W(2, { order_status: "completed" })], { orderAt: O, cfg: { ...CFG, handoffMinAfterOrderMin: 0 } }).basis, "pos_closed");
  assert.equal(K.handoffOf([W(30, { order_status: "completed" }), W(25, { approval: "picked" })], { orderAt: O }).at, R(19, 25).toISOString(), "الأقدم بالترتيب");
  assert.deepEqual([...K.groupHandoffRows([{ tid: "5901", pid: "La84" }, { tid: null, pid: "5902" }, { tid: "77" }], ["5901", "5902"]).keys()], ["5901", "5902"]);
  assert.match(K.HANDOFF_SQL, /tenant_order_id/); assert.match(K.HANDOFF_SQL, /w\.received_at > \$2::timestamptz/, "نافذة received_at (الفهرس)");
});

test("KA2c الخطة: التسليم + ٥٠؛ مستني ⇒ «حجز» أبعد من أي تسليم + ٥٠ جوّه الانتظار؛ بعد ٩٠ من غير تسليم ⇒ الطلب + ٨٠ (handoff_unknown)؛ «وقت الطلب» ⇒ الطلب + ٥٠", () => {
  const O = R(19).toISOString();
  const H = (mm) => ({ at: R(19, mm).toISOString(), basis: "pos_closed" });
  const CF = K.pullCfg({ keeta: { pull: { enabled: true } } });
  assert.deepEqual(K.reviewPlanOf({ orderAt: O, handoff: H(25), cfg: CF, now: R(19, 30) }), { anchor: "handoff", final: true, dueAt: R(20, 15).toISOString(), handoffAt: R(19, 25).toISOString(), basis: "pos_closed", reason: null });
  const pend = K.reviewPlanOf({ orderAt: O, cfg: CF, now: R(19, 30) });
  assert.equal(pend.anchor, "pending"); assert.equal(pend.final, false); assert.equal(pend.dueAt, R(21, 20).toISOString(), "الطلب + ٩٠ + ٥٠");
  for (let mm = 0; mm <= 90; mm += 5) assert.ok(Date.parse(pend.dueAt) >= Date.parse(K.reviewPlanOf({ orderAt: O, handoff: { at: new Date(Date.parse(O) + mm * 60_000).toISOString() }, cfg: CF }).dueAt), `الحجز مش قبل تسليم +${mm}`);
  const unk = K.reviewPlanOf({ orderAt: O, cfg: CF, now: R(20, 30) });
  assert.deepEqual([unk.anchor, unk.reason, unk.dueAt, unk.final], ["handoff_unknown", "handoff_unknown", R(20, 20).toISOString(), true]);
  assert.equal(K.reviewPlanOf({ orderAt: O, cfg: CF, now: R(20, 29) }).anchor, "pending", "قبل ٩٠ لسه مستني");
  assert.equal(K.reviewPlanOf({ orderAt: O, handoff: H(100), cfg: CF, now: R(20, 45) }).dueAt, R(21, 30).toISOString(), "التسليم ظهر متأخّر ⇒ منه");
  assert.deepEqual(K.reviewPlanOf({ orderAt: O, handoff: H(25), cfg: { ...CF, reviewAnchor: "order" }, now: R(19, 30) }).dueAt, R(19, 50).toISOString(), "المرجع «وقت الطلب» بيتجاهل التسليم");
  assert.equal(K.reviewPlanOf({ orderAt: O, handoff: H(25), cfg: { ...CF, reviewDelayMin: 30 }, now: R(19, 30) }).dueAt, R(19, 55).toISOString());
  assert.equal(K.reviewPlanOf({ orderAt: R(19), handoff: { at: R(19, 25) }, cfg: CF, now: R(19, 30) }).dueAt, R(20, 15).toISOString(), "أعمدة pg بترجع Date");
});

test("KA2c التغطية (قراءة بس): كام طلب كيتا ليه تسليم ووسيط الدقايق", () => {
  const rows = [
    { order_id: "1", order_date: R(19).toISOString(), received_at: R(19, 1).toISOString(), approval: "accepted" },
    { order_id: "1", order_date: R(19).toISOString(), received_at: R(19, 30).toISOString(), order_status: "completed" },
    { order_id: "2", order_date: R(20).toISOString(), received_at: R(20, 1).toISOString(), approval: "accepted" },
    { order_id: "3", order_date: R(21).toISOString(), received_at: null },
    { order_id: "4", order_date: R(22).toISOString(), received_at: R(22, 20).toISOString(), approval: "picked_up" },
  ];
  const c = K.handoffCoverage(rows, CFG);
  assert.equal(c.orders, 4); assert.equal(c.withWebhooks, 3); assert.equal(c.withHandoff, 2); assert.equal(c.pct, 50);
  assert.deepEqual(c.basis, { pos_closed: 1, pos_approval: 1 }); assert.equal(c.minutesFromOrder.max, 30); assert.equal(c.within, 2);
  assert.match(K.HANDOFF_COVERAGE_SQL, /delivery_app/); assert.match(K.HANDOFF_COVERAGE_SQL, /'keeta'/);
});

test("التقييم ⇒ القرار: ٤–٥ نجوم ⇒ السحب؛ واطي ⇒ بس لو اتقفل «اتحلت» خلال المدة؛ مفيش تقييم ⇒ لأ", () => {
  const now = R(21);
  const sent = { sent_at: R(20).toISOString(), skip_reason: null, rating: null };
  assert.deepEqual(K.verdictOf({ invite: null, cfg: CFG, now }), { act: "skip", reason: "review_missing" });
  assert.deepEqual(K.verdictOf({ invite: { skip_reason: "cap_days" }, cfg: CFG, now }), { act: "skip", reason: "review:cap_days" });
  assert.equal(K.verdictOf({ invite: { sent_at: null }, cfg: CFG, now }).act, "wait");
  assert.equal(K.verdictOf({ invite: sent, cfg: CFG, now }).act, "wait");
  assert.deepEqual(K.verdictOf({ invite: sent, cfg: CFG, now: R(21, 0, 19) }), { act: "skip", reason: "no_rating" });
  const rv = (x) => ({ rating: 5, rating_exact: true, resolved: false, outcome: null, resolved_at: null, created_at: R(20, 10).toISOString(), ...x });
  assert.equal(K.verdictOf({ invite: sent, rv: rv({}), cfg: CFG, now }).act, "eligible");
  assert.equal(K.verdictOf({ invite: sent, rv: rv({ rating: 4 }), cfg: CFG, now }).high, true);
  assert.equal(K.verdictOf({ invite: sent, rv: rv({ rating: 3, rating_exact: false }), cfg: CFG, now }).act, "wait", "«يحتاج تحسين» مفتوح ⇒ نستنى");
  assert.deepEqual(K.verdictOf({ invite: sent, rv: rv({ rating: 2 }), cfg: CFG, now: R(21, 0, 22) }), { act: "skip", reason: "low_open" });
  const ok = K.verdictOf({ invite: sent, rv: rv({ rating: 2, resolved: true, outcome: "resolved", resolved_at: R(23).toISOString() }), cfg: CFG, now });
  assert.equal(ok.act, "eligible"); assert.equal(ok.high, false); assert.equal(ok.at, R(23).toISOString());
  assert.deepEqual(K.verdictOf({ invite: sent, rv: rv({ rating: 2, resolved: true, outcome: "closed", resolved_at: R(23).toISOString() }), cfg: CFG, now }), { act: "skip", reason: "low_closed" });
  assert.equal(K.verdictOf({ invite: sent, rv: rv({ rating: 2, resolved: true, outcome: "closed", resolved_at: R(23).toISOString() }), cfg: { ...CFG, lowCloseRule: "any_close" }, now }).act, "eligible");
  assert.deepEqual(K.verdictOf({ invite: sent, rv: rv({ rating: 1, resolved: true, outcome: "not_customer", resolved_at: R(23).toISOString() }), cfg: { ...CFG, lowCloseRule: "any_close" }, now }), { act: "skip", reason: "low_closed" }, "«مش عميل» عمره ما يعدّي");
  assert.deepEqual(K.verdictOf({ invite: sent, rv: rv({ rating: 2, resolved: true, outcome: "resolved", resolved_at: R(23, 0, 22).toISOString() }), cfg: CFG, now }), { act: "skip", reason: "low_open" }, "اتقفلت بعد المدة");
  assert.deepEqual(K.verdictOf({ invite: { ...sent, skip_reason: "opted_out" }, rv: rv({}), cfg: CFG, now }), { act: "skip", reason: "review:opted_out" });
});

test("أخطاء ميتا (جدول §٢-د): 131049 نهائي من غير بديل، 131026 مش على واتساب، 131050 إيقاف، 131048 وقف الكل، 131056 إعادة", () => {
  assert.deepEqual([K.failureOf({ ok: false, code: 131049 }).act, K.failureOf({ ok: false, code: 131049 }).reason], ["final", "meta_marketing_limit"]);
  assert.equal(K.failureOf({ ok: false, code: 131026 }).invalid, true);
  assert.equal(K.failureOf({ ok: false, code: 131050 }).optout, true);
  for (const c of [131048, 131042, 131031, 368]) assert.equal(K.failureOf({ ok: false, code: c }).act, "pause", String(c));
  for (const c of [131056, 130429, 80007, 4, 131016]) assert.equal(K.failureOf({ ok: false, code: c }).act, "retry", String(c));
  assert.equal(K.failureOf({ ok: false, skipped: "burst_hold", until: "x" }).act, "wait");
  assert.equal(K.failureOf({ ok: false, skipped: "opted_out" }).reason, "opted_out");
  assert.equal(K.failureOf({ ok: false, skipped: "marketing_cap_7d" }).reason, "marketing_cap");
  assert.equal(K.failureOf({ ok: true }), null);
});

test("الفرملة: ≥ ٣٪ إيقاف على آخر ٥٠ عميل وصلته رسالة KA2 — مش قبل ٥٠", () => {
  const rows = (n, bad) => Array.from({ length: n }, (_, i) => ({ opted_out: i < bad }));
  assert.equal(K.brakeOf(rows(50, 2), CFG).trip, true, "٢ من ٥٠ = ٤٪");
  assert.equal(K.brakeOf(rows(50, 1), CFG).trip, false, "١ من ٥٠ = ٢٪");
  assert.equal(K.brakeOf(rows(49, 10), CFG).trip, false, "قبل ٥٠");
  assert.equal(K.brakeOf(rows(80, 2), CFG).n, 50, "على آخر ٥٠ بس");
});

test("الرسالة: fc_try_website — {{1}} FIRST، {{2}} الحد الأدنى من الكوبون، والزرار /l/keeta-first-<٦ حروف> اللي المحلّل بيفهمه؛ ومن غير اسم كيتا ولا مقارنة سعر", () => {
  const code = K.linkCodeOf();
  assert.match(code, /^[a-z0-9]{6}$/);
  const p = K.pullParams("fc_try_website", { code: "FIRST", min_total: "60.00" }, code);
  assert.deepEqual(p.body, ["FIRST", "60"]);
  assert.match(p.button[0], /^keeta-first-[a-z0-9]{6}$/);
  assert.deepEqual(parseRecipientSlug(p.button[0]), { base: "keeta-first", code });
  assert.throws(() => K.pullParams("fc_try_website", null, code), /ka2_coupon/);
  assert.throws(() => K.pullParams("fc_other", { code: "FIRST", min_total: 60 }, code), /ka2_template/);
  const t = CAT.findTemplate("fc_try_website");
  assert.equal(t.category, "MARKETING");
  assert.doesNotMatch(CAT.previewText(t), /كيتا|keeta|أرخص|أقل سعر/i);
  assert.match(CAT.findTemplate("fc_review_stars").category, /UTILITY/);
});

test("المرشّح: الفريق، التجربة، الحشو، الموقِّف، عميل الموقع، اللي بيدفع، المباشر ⇒ تخطّي بسببه؛ والاستعلام فيه حماية أول تشغيل وأول طلب كيتا", () => {
  const staff = new Set(["544775082"]);
  const c = (x) => ({ pn: "561839274", ...x });
  assert.equal(K.candidateSkip(c({}), { cfg: CFG, staff }), null);
  assert.equal(K.candidateSkip(c({ pn: "544775082" }), { cfg: CFG, staff }), "staff");
  assert.equal(K.candidateSkip(c({ is_test: true }), { cfg: CFG, staff }), "test_contact");
  assert.equal(K.candidateSkip(c({ pn: "555555555" }), { cfg: CFG, staff }), "invalid");
  assert.equal(K.candidateSkip(c({ opted_out: true }), { cfg: CFG, staff }), "opted_out");
  assert.equal(K.candidateSkip(c({ web_paid: true }), { cfg: CFG, staff }), "web_customer");
  assert.equal(K.candidateSkip(c({ pending_checkout: true }), { cfg: CFG, staff }), "pending_checkout");
  assert.equal(K.candidateSkip(c({ direct: true }), { cfg: CFG, staff }), "direct");
  assert.equal(K.candidateSkip(c({ direct: true }), { cfg: { ...CFG, skipDirectCustomers: false }, staff }), null);
  assert.match(K.CANDIDATES_SQL, /GREATEST\(\$1::timestamptz/);
  assert.match(K.CANDIDATES_SQL, /o2\.order_date < c\.order_date/);
  assert.match(K.CANDIDATES_SQL, /NOT EXISTS \(SELECT 1 FROM ka2_sends k WHERE k\.phone_norm = c\.pn/, "مرة واحدة في العمر");
  assert.equal(inHoldout("ka2", "561839274", 10), inHoldout("ka2", "561839274", 10));
  assert.equal(inHoldout("ka2", "561839274", 0), false);
  assert.notEqual(bizDayStart(R(3, 30, 19)).toISOString(), bizDayStart(R(4, 30, 19)).toISOString(), "يوم العمل بيقلب ٤ الفجر");
});

test("كل سبب الموديول بيكتبه له تسمية عربي", () => {
  const src = readFileSync(new URL("./keeta_pull.js", import.meta.url), "utf8");
  const lit = new Set();
  for (const m of src.matchAll(/(?:reason: |fin\("(?:skipped|failed)", |return )"([a-z_]+)"/g)) lit.add(m[1]);
  for (const r of ["staff", "test_contact", "invalid", "opted_out", "web_customer", "pending_checkout", "direct", "cap", "disabled", "review_missing", "no_rating", "low_open", "low_closed",
    "holdout", "gap", "late", "ordered", "marketing_cap", "meta_marketing_limit", "undeliverable", "user_stopped", "burst_hold", "send_failed"]) lit.add(r);
  for (const r of lit) if (!["act", "wait", "skip", "final", "retry", "pause", "eligible"].includes(r)) assert.ok(K.KA2_REASON_AR[r] || K.reasonAr(r) !== r || /^meta_/.test(r), `سبب بلا تسمية: ${r}`);
  assert.equal(K.reasonAr("review:cap_days"), "طلب التقييم ماطلعش (cap_days)");
});

test("الملكية والصلاحيات: keeta ملك السيرفر، /api/keeta/pull = «العملاء»، وموافقة keeta_order لطلب التقييم بس", () => {
  assert.ok(SERVER_OWNED_PATHS.includes("keeta"));
  assert.equal(sectionOf("/api/keeta/pull"), "customers");
  assert.equal(sectionOf("/api/keeta/pull/settings"), "customers");
  assert.equal(sectionOf("/api/keeta/control/settings"), "settings");
  assert.deepEqual(WC.KA2_REVIEW_CONSENT.templates, ["fc_review_stars"]);
  assert.equal(WC.ka2ReviewConsentOn({ keeta: { pull: { enabled: true } } }), true);
  assert.equal(WC.ka2ReviewConsentOn({}), false);
});

/* ═══ الدورة كاملة على قاعدة مزيّفة ═══════════════════════════════════════ */
function rig({ cands = [], settings = {}, coupon = { code: "FIRST", min_total: 60, active: true }, link = { slug: "keeta-first", active: true, coupon: "FIRST" }, waReply = { ok: true, wamid: "wamid.KA2" }, recent = new Set(), now = R(20), webhooks = [], invites = [] } = {}) {
  const db = { k: [], inv: [...invites], reviews: [], contactLog: [], consent: [], sent: [], optouts: {}, settingsWrites: [], webhooks: [...webhooks], migrations: 0 };
  let id = 0;
  const S = { hours: HOURS, waCloud: { enabled: true }, keeta: { pull: { enabled: true, enabledAt: R(12).toISOString() } }, ...settings };
  const rowOf = (x) => db.k.find((r) => r.id === Number(x));
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^(CREATE|ALTER)/i.test(s) || /^CREATE TABLE IF NOT EXISTS wa_optins/i.test(s)) return { rows: [] };
    if (/WITH cand AS/.test(s)) return { rows: cands.filter((c) => !db.k.some((k) => k.phone_norm === c.pn || k.keeta_order_id === String(c.order_id))) };
    if (/^SELECT count\(\*\)::int AS n FROM ka2_sends WHERE created_at >= /.test(s)) return { rows: [{ n: db.k.filter((k) => k.review_order_no).length }] };
    if (/^INSERT INTO ka2_sends\(phone_norm, keeta_order_id, order_at, status, reason\)/.test(s)) { db.k.push({ id: ++id, phone_norm: p[0], keeta_order_id: p[1], order_at: p[2], status: "skipped", reason: p[3] }); return { rows: [] }; }
    if (/^INSERT INTO ka2_sends\(phone_norm, keeta_order_id, order_at, status, review_order_no, review_due_at, review_anchor, handoff_at, handoff_basis\)/.test(s)) {
      if (db.k.some((k) => k.phone_norm === p[0])) return { rows: [] };
      db.k.push({ id: ++id, phone_norm: p[0], keeta_order_id: p[1], order_at: p[2], status: "review_wait", review_order_no: p[3], review_due_at: p[4], review_anchor: p[5], handoff_at: p[6], handoff_basis: p[7], attempts: 0 }); return { rows: [{ id }] };
    }
    /* KA2c: ويبهوكات تاب سينس (tenant_order_id = freshcuts-<رقم>) */
    if (/FROM tsp_webhooks w WHERE w\.received_at > \$2::timestamptz/.test(s)) {
      return { rows: db.webhooks.filter((w) => Date.parse(w.received_at) > Date.parse(p[1])).map((w) => ({ tid: (String(w.tenant_order_id || "").match(/(\d+)\s*$/) || [])[1] || null, pid: w.id || null, received_at: w.received_at, approval: w.approval || null, order_status: w.order_status || null }))
        .filter((w) => p[0].includes(w.tid) || p[0].includes(w.pid)).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at)) };
    }
    if (/FROM ka2_sends k JOIN review_invites iv ON iv\.order_no = k\.review_order_no WHERE k\.status = 'review_wait' AND k\.review_anchor IN \('pending','handoff_unknown'\)/.test(s)) {
      return { rows: db.k.filter((k) => k.status === "review_wait" && ["pending", "handoff_unknown"].includes(k.review_anchor)).filter((k) => { const iv = db.inv.find((i) => i.order_no === k.review_order_no); return iv && !iv.sent_at && !iv.skip_reason; })
        .map((k) => ({ id: k.id, keeta_order_id: k.keeta_order_id, order_at: k.order_at, review_order_no: k.review_order_no, review_anchor: k.review_anchor, review_due_at: k.review_due_at, handoff_at: k.handoff_at })) };
    }
    if (/^UPDATE ka2_sends SET review_anchor=\$2, review_due_at=\$3/.test(s)) { const r = rowOf(p[0]); if (!r || r.status !== "review_wait") return { rows: [] }; Object.assign(r, { review_anchor: p[1], review_due_at: p[2], handoff_at: p[3], handoff_basis: p[4] }); return { rows: [{ id: r.id }] }; }
    if (/^UPDATE review_invites SET due_at=\$2 WHERE order_no=\$1 AND ka2 AND sent_at IS NULL/.test(s)) { const i = db.inv.find((x) => x.order_no === p[0]); if (i && i.ka2 && !i.sent_at && !i.skip_reason) i.due_at = p[1]; return { rows: [] }; }
    if (/'\{keeta,pull,reviewAnchor\}'/.test(s)) {      // ANCHOR_MIGRATION_SQL
      const x = S.keeta && S.keeta.pull;
      if (x && typeof x === "object" && String(x.reviewDelayMin) === "80" && !("reviewAnchor" in x)) { x.reviewDelayMin = 50; x.reviewAnchor = "handoff"; db.migrations++; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref, ka2\)/.test(s)) {
      const ex = db.inv.find((i) => i.order_no === p[0]);
      if (ex) { if (!ex.sent_at && !ex.skip_reason) { ex.ka2 = true; ex.due_at = p[3]; } }
      else db.inv.push({ order_no: p[0], code: p[1], phone_norm: p[2], due_at: p[3], kind: "app", ka2: true });
      return { rows: [] };
    }
    if (/INSERT INTO wa_optin_log/.test(s)) { db.consent.push({ pn: p[0], order: p[3], source: "keeta_order" }); return { rows: [], rowCount: 1 }; }
    if (/FROM ka2_sends k LEFT JOIN review_invites iv ON iv.order_no = k.review_order_no LEFT JOIN reviews r/.test(s)) {
      return { rows: db.k.filter((k) => k.status === "review_wait").map((k) => { const iv = db.inv.find((i) => i.order_no === k.review_order_no); const r = iv && iv.review_id ? db.reviews.find((x) => x.id === iv.review_id) : null;
        return { id: k.id, phone_norm: k.phone_norm, review_order_no: k.review_order_no, iv_no: iv ? iv.order_no : null, sent_at: iv ? iv.sent_at || null : null, skip_reason: iv ? iv.skip_reason || null : null,
          iv_rating: iv ? iv.rating ?? null : null, wa_answered_at: null, review_id: iv ? iv.review_id || null : null,
          rating: r ? r.rating : null, rating_exact: r ? r.rating_exact : null, resolved: r ? r.resolved : null, outcome: r ? r.outcome : null, resolved_at: r ? r.resolved_at : null, rated_at: r ? r.created_at : null }; }) };
    }
    if (/^UPDATE ka2_sends SET status='skipped', reason=\$2, rating=\$3/.test(s)) { const r = rowOf(p[0]); Object.assign(r, { status: "skipped", reason: p[1], rating: p[2] }); return { rows: [] }; }
    if (/^UPDATE ka2_sends SET status=\$2, reason=\$3, holdout=\$4/.test(s)) { const r = rowOf(p[0]); Object.assign(r, { status: p[1], reason: p[2], holdout: p[3], rating: p[4], high: p[8], eligible_at: p[9], due_at: p[10] }); return { rows: [] }; }
    if (/^UPDATE ka2_sends SET status='skipped', reason='late'/.test(s)) { const out = []; for (const r of db.k) if (r.status === "queued" && Date.parse(r.eligible_at) < Date.parse(p[0]) - p[1] * 3600_000) { r.status = "skipped"; r.reason = "late"; out.push({ id: r.id }); } return { rows: out }; }
    if (/^UPDATE ka2_sends SET status='skipped', reason='disabled'/.test(s)) { const out = []; for (const r of db.k) if (["review_wait", "queued"].includes(r.status)) { r.status = "skipped"; r.reason = "disabled"; out.push({ id: r.id }); } return { rows: out }; }
    if (/^UPDATE review_invites SET ka2=FALSE/.test(s)) { for (const i of db.inv) if (i.ka2 && !i.sent_at && !i.skip_reason) i.ka2 = false; return { rows: [] }; }
    if (/^SELECT id, phone_norm, eligible_at, attempts, link_code FROM ka2_sends WHERE status='queued'/.test(s)) return { rows: db.k.filter((r) => r.status === "queued" && Date.parse(r.due_at) <= Date.parse(p[0])) };
    if (/^SELECT count\(\*\) FILTER \(WHERE sent_at >= \$1::timestamptz\)::int AS today/.test(s)) return { rows: [{ today: db.k.filter((r) => r.sent_at).length, hour: 0 }] };
    if (/FROM shop_coupons/.test(s)) return { rows: coupon ? [coupon] : [] };
    if (/FROM cms_links WHERE slug=\$1/.test(s)) return { rows: link ? [link] : [] };
    if (/^SELECT \(SELECT opted_out_at FROM cms_contacts/.test(s)) return { rows: [{ oo: db.optouts[p[0]] || null, st: null, mo: null, paid: false, invalid: false }] };
    if (/^UPDATE ka2_sends SET link_code=\$2/.test(s)) { Object.assign(rowOf(p[0]), { link_code: p[1], template: p[2], coupon: p[3] }); return { rows: [] }; }
    if (/^UPDATE ka2_sends SET status='sent'/.test(s)) { Object.assign(rowOf(p[0]), { status: "sent", wamid: p[1], sent_at: now.toISOString() }); return { rows: [] }; }
    if (/^INSERT INTO wa_contact_log/.test(s)) { db.contactLog.push({ pn: p[0], by: "ka2" }); return { rows: [] }; }
    if (/^UPDATE ka2_sends SET status=\$2, reason=\$3, updated_at=NOW\(\)/.test(s)) { Object.assign(rowOf(p[0]), { status: p[1], reason: p[2] }); return { rows: [] }; }
    if (/^UPDATE settings SET data = jsonb_set/.test(s)) { db.settingsWrites.push(JSON.parse(p[0])); S.keeta.pull = JSON.parse(p[0]); return { rows: [] }; }
    if (/ORDER BY COALESCE\(k\.sent_at, iv\.sent_at\) DESC LIMIT/.test(s)) return { rows: [] };      // الفرملة
    if (/JOIN wa_messages m ON m\.wamid = k\.wamid WHERE k\.status='sent' AND m\.status='failed'/.test(s)) return { rows: [] };
    return { rows: [] };
  } };
  const routes = {}; const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT") };
  const wa = { sendTemplate: async (x) => { db.sent.push(x); return typeof waReply === "function" ? waReply(x) : waReply; } };
  const sender = { recentMap: async (pns) => new Map(pns.filter((pn) => recent.has(pn)).map((pn) => [pn, "wa"])), optOut: async (pn) => { db.optouts[pn] = "now"; return true; } };
  const api = K.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => S, isOwner: async () => true, auditNote: async () => {} }, { wa, sender, now: () => now });
  return { api, db, S, routes, setNow: (d) => { now = d; } };
}
const CAND = (pn, order_id, at) => ({ order_id, pn, order_date: at, web_paid: false, pending_checkout: false, opted_out: false, is_staff: false, is_test: false, direct: false, invalid: false });

test("الدورة (المرجع «وقت الطلب»): طلب كيتا جديد ⇒ دعوة تقييم «pos:<الطلب>» بعد ٥٠ د (ka2) + صف موافقة keeta_order؛ ٥ نجوم ⇒ «اطلب من موقعنا» برابط شخصي و«رسالة الأسبوع»", async () => {
  const r = rig({ cands: [CAND("561112223", "T900", R(19, 30).toISOString()), CAND("562223334", "T901", R(19, 35).toISOString())], now: R(19, 40),
    settings: { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), reviewAnchor: "order" } } } });
  r.db.k.push({ id: 99, phone_norm: "562223334", keeta_order_id: "OLD", status: "skipped", reason: "gap" });      // الرقم ده خد KA2 قبل كده ⇒ مرة في العمر
  const o1 = await r.api.tick({ now: R(19, 40) });
  assert.equal(o1.enroll, 1, JSON.stringify(o1));
  const inv = r.db.inv.find((i) => i.order_no === "pos:T900");
  assert.ok(inv && inv.ka2); assert.equal(inv.due_at, R(20, 20).toISOString(), "٥٠ دقيقة بعد الطلب");
  assert.deepEqual(r.db.consent, [{ pn: "561112223", order: "pos:T900", source: "keeta_order" }]);
  assert.equal(r.db.sent.length, 0, "مفيش رسالة سحب قبل التقييم");
  /* طلب التقييم اتبعت (reviews.js) والعميل قيّم ٥ نجوم */
  Object.assign(inv, { sent_at: R(20, 20).toISOString(), rating: 5, review_id: 7 });
  r.db.reviews.push({ id: 7, rating: 5, rating_exact: true, resolved: false, created_at: R(20, 25).toISOString() });
  r.setNow(R(20, 26));
  const o2 = await r.api.tick({ now: R(20, 26) });
  const row = r.db.k.find((k) => k.phone_norm === "561112223");
  if (row.holdout) { assert.equal(row.status, "holdout"); return; }
  assert.equal(row.status, "queued"); assert.equal(row.due_at, R(20, 35).toISOString(), "بعد التقييم بـ١٠ د"); assert.equal(o2.send.sent, 0);
  r.setNow(R(20, 36));
  const o3 = await r.api.tick({ now: R(20, 36) });
  assert.equal(o3.send.sent, 1, JSON.stringify(o3));
  const m = r.db.sent[0];
  assert.equal(m.template, "fc_try_website"); assert.equal(m.source, "ka2"); assert.equal(m.proactive, true);
  assert.deepEqual(m.params.body, ["FIRST", "60"]); assert.match(m.params.button[0], /^keeta-first-[a-z0-9]{6}$/);
  assert.equal(row.status, "sent"); assert.deepEqual(r.db.contactLog, [{ pn: "561112223", by: "ka2" }]);
  const o4 = await r.api.tick({ now: R(21) });
  assert.equal(o4.send.sent, 0, "رسالة واحدة في العمر");
});

test("الدورة: تقييم واطي مفتوح ⇒ مفيش رسالة؛ اتقفل «اتحلت» ⇒ الرسالة؛ المطعم مقفول ⇒ تستنى؛ وصله تسويق قريب ⇒ تخطّي نهائي", async () => {
  const pn = "563334445";
  const r = rig({ cands: [CAND(pn, "T902", R(19).toISOString())], now: R(19, 10), settings: { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), holdoutPct: 0 } } } });
  await r.api.tick({ now: R(19, 10) });
  const inv = r.db.inv[0];
  Object.assign(inv, { sent_at: R(19, 50).toISOString(), rating: 2, review_id: 8 });
  const rv = { id: 8, rating: 2, rating_exact: true, resolved: false, outcome: null, created_at: R(19, 55).toISOString() };
  r.db.reviews.push(rv);
  await r.api.tick({ now: R(20, 30) });
  assert.equal(r.db.k[0].status, "review_wait", "الشكوى مفتوحة ⇒ نستنى"); assert.equal(r.db.sent.length, 0);
  Object.assign(rv, { resolved: true, outcome: "resolved", resolved_at: R(1, 50, 19).toISOString() });
  await r.api.tick({ now: R(1, 52, 19) });      // ٢:٠٠ قفل الأحد ⇒ آخر ٣٠ د ⇒ مقفول
  assert.equal(r.db.k[0].status, "queued"); assert.equal(r.db.sent.length, 0, "المطعم في آخر نص ساعة ⇒ تستنى");
  await r.api.tick({ now: R(13, 5, 19) });
  assert.equal(r.db.sent.length, 1, "أول ما المطعم يفتح"); assert.equal(r.db.k[0].status, "sent");

  const pn2 = "564445556";
  const g = rig({ cands: [CAND(pn2, "T903", R(19).toISOString())], recent: new Set([pn2]), now: R(19, 10), settings: { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), holdoutPct: 0 } } } });
  await g.api.tick({ now: R(19, 10) });
  Object.assign(g.db.inv[0], { sent_at: R(19, 50).toISOString(), rating: 5, review_id: 9 });
  g.db.reviews.push({ id: 9, rating: 5, rating_exact: true, created_at: R(19, 55).toISOString() });
  await g.api.tick({ now: R(20, 30) });
  assert.equal(g.db.k[0].status, "skipped"); assert.equal(g.db.k[0].reason, "gap"); assert.equal(g.db.sent.length, 0);
});

test("الدورة: حماية أول تشغيل (مقفول ⇒ ولا حاجة، والقفل بيلغي الطابور)، السقف اليومي، و131048 بيوقف KA2 كلها", async () => {
  const off = rig({ cands: [CAND("565556667", "T904", R(19).toISOString())], settings: { keeta: { pull: { enabled: false } } } });
  const o = await off.api.tick({ now: R(19, 10) });
  assert.equal(o.skipped, "disabled"); assert.equal(off.db.k.length, 0); assert.equal(off.db.inv.length, 0);
  const cap = rig({ cands: Array.from({ length: 3 }, (_, i) => CAND(`5672814${i}9`, `C${i}`, R(19, i).toISOString())), settings: { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), dailyCap: 2 } } } });
  await cap.api.tick({ now: R(19, 10) });
  assert.deepEqual(cap.db.k.map((k) => k.status).sort(), ["review_wait", "review_wait", "skipped"]);
  assert.equal(cap.db.k.find((k) => k.status === "skipped").reason, "cap");
  const stop = rig({ cands: [CAND("567778889", "T905", R(19).toISOString())], waReply: { ok: false, code: 131048 }, settings: { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), holdoutPct: 0 } } } });
  await stop.api.tick({ now: R(19, 10) });
  Object.assign(stop.db.inv[0], { sent_at: R(19, 50).toISOString(), rating: 4, review_id: 10 });
  stop.db.reviews.push({ id: 10, rating: 4, rating_exact: true, created_at: R(19, 55).toISOString() });
  await stop.api.tick({ now: R(20, 30) });
  assert.equal(stop.db.k[0].status, "failed"); assert.equal(stop.db.k[0].reason, "meta_131048");
  assert.equal(stop.S.keeta.pull.paused, true); assert.equal(stop.S.keeta.pull.pauseReason, "meta_131048");
  const after = await stop.api.tick({ now: R(20, 40) });
  assert.equal(after.enroll, undefined, "متوقّفة ⇒ مفيش دخول جديد"); assert.equal(after.send.waited, "paused");
  const dis = rig({ cands: [CAND("568889990", "T906", R(19).toISOString())] });
  await dis.api.tick({ now: R(19, 10) });
  dis.S.keeta.pull.enabled = false;
  const d = await dis.api.tick({ now: R(19, 20) });
  assert.equal(d.cancelled, 1); assert.equal(dis.db.k[0].reason, "disabled"); assert.equal(dis.db.inv[0].ka2, false, "طلب التقييم يكمّل كأي طلب تقييم عادي");
});

test("المحلّل: /l/keeta-first-<code> ⇒ صف المستلم (أو التجربة)، وأي حاجة تانية ⇒ null", async () => {
  const pool = { async query(sql, p) { if (/FROM ka2_sends WHERE link_code=\$1/.test(sql)) return { rows: p[0] === "abc234" ? [{ id: 5, coupon: "FIRST" }] : [] }; if (/FROM ka2_tests/.test(sql)) return { rows: p[0] === "tst234" ? [{ id: 2 }] : [] }; return { rows: [] }; } };
  assert.deepEqual(await K.resolveKa2Link(pool, "keeta-first-abc234"), { table: "ka2_sends", id: 5, coupon: "FIRST", base: "keeta-first" });
  assert.deepEqual(await K.resolveKa2Link(pool, "keeta-first-tst234"), { table: "ka2_tests", id: 2, coupon: "FIRST", base: "keeta-first" });
  assert.equal(await K.resolveKa2Link(pool, "keeta-first-zzz999"), null);
  assert.equal(await K.resolveKa2Link(pool, "wa-first-abc234"), null);
  const src = readFileSync(new URL("./cms.js", import.meta.url), "utf8");
  assert.match(src, /resolveKa2Link\(pool, slug\)/, "فرع المحلّل في cms.js");
});

test("مسارات تانية لمسها KA2: reviewAsk بيستعمل قالب النجوم لدعوة KA2، reviews.js مابيبعتش SMS لها ومابيقفلهاش بمفتاح التطبيقات، والإحصائيات فيها KA2", () => {
  const w = readFileSync(new URL("./wabotrun.js", import.meta.url), "utf8");
  assert.match(w, /flow\.starsTemplate \|\| ka2 === true/);
  const r = readFileSync(new URL("./reviews.js", import.meta.url), "utf8");
  assert.match(r, /iv\.ka2 === true\) \{ await skip\(`ka2_no_sms/);
  assert.match(r, /!kindOn\(kind, flow\) && iv\.ka2 !== true/);
  assert.match(r, /ka2: await ka2ReviewSummary\(qq/);
  const g = readFileSync(new URL("./whatsapp.js", import.meta.url), "utf8");
  assert.match(g, /source === "ka2"/, "KA2 مبادِرة (CJ1a)");
  assert.match(g, /ka2ReviewConsentCovers\(pool, pn, orderNo\)/);
});

/* ═══ KA2c — الدورة على قاعدة مزيّفة ═══════════════════════════════════════ */
const WH = (oid, at, x) => ({ tenant_order_id: `freshcuts-${oid}`, id: `h${oid}${Date.parse(at)}`, received_at: at, ...x });
const ON = { keeta: { pull: { enabled: true, enabledAt: R(12).toISOString(), holdoutPct: 0 } } };

test("KA2c الدورة: الدعوة «محجوزة» لحد التسليم، أول ما الكاشير يقفل الطلب ⇒ الميعاد = التسليم + ٥٠ (ومش قبله)", async () => {
  const r = rig({ cands: [CAND("561728394", "5901", R(19, 30).toISOString())], now: R(19, 40), settings: ON,
    webhooks: [WH("5901", R(19, 31).toISOString(), { approval: "accepted" }), WH("5901", R(19, 55).toISOString(), { approval: "pickup_ready" })] });
  const o1 = await r.api.tick({ now: R(19, 40) });
  assert.equal(o1.enroll, 1);
  const inv = r.db.inv[0], row = r.db.k[0];
  assert.equal(row.review_anchor, "pending"); assert.equal(inv.due_at, R(21, 50).toISOString(), "حجز: الطلب + ٩٠ + ٥٠"); assert.equal(inv.ka2, true);
  await r.api.tick({ now: R(20) });
  assert.equal(row.review_anchor, "pending", "جاهز (pickup_ready) مش تسليم"); assert.equal(inv.due_at, R(21, 50).toISOString());
  r.db.webhooks.push(WH("5901", R(20, 5).toISOString(), { approval: "pickup_ready", order_status: "completed" }));
  const o3 = await r.api.tick({ now: R(20, 6) });
  assert.equal(o3.anchored, 1);
  assert.equal(row.review_anchor, "handoff"); assert.equal(row.handoff_at, R(20, 5).toISOString()); assert.equal(row.handoff_basis, "pos_closed");
  assert.equal(inv.due_at, R(20, 55).toISOString(), "التسليم ٢٠:٠٥ + ٥٠"); assert.equal(row.review_due_at, inv.due_at);
  const o4 = await r.api.tick({ now: R(20, 30) });
  assert.equal(o4.anchored, 0, "نهائي ⇒ مابيتلمسش تاني"); assert.equal(inv.due_at, R(20, 55).toISOString());
  assert.equal(r.db.sent.length, 0);
});

test("KA2c الدورة: التسليم ماظهرش خلال ٩٠ ⇒ الطلب + ٨٠ وسبب handoff_unknown؛ ظهر بعدها والدعوة لسه ماطلعتش ⇒ الميعاد يرجع للتسليم + ٥٠؛ اتبعتت ⇒ مابنلمسهاش", async () => {
  const r = rig({ cands: [CAND("562817465", "5902", R(19).toISOString()), CAND("563918274", "5903", R(19).toISOString())], now: R(19, 10), settings: ON });
  await r.api.tick({ now: R(19, 10) });
  const [a, b] = ["5902", "5903"].map((o) => r.db.k.find((k) => k.keeta_order_id === o));
  const ia = r.db.inv.find((i) => i.order_no === "pos:5902"), ib = r.db.inv.find((i) => i.order_no === "pos:5903");
  assert.equal(ia.due_at, R(21, 20).toISOString());
  await r.api.tick({ now: R(20, 29) });
  assert.equal(a.review_anchor, "pending");
  const o = await r.api.tick({ now: R(20, 31) });
  assert.equal(o.anchored, 2);
  assert.equal(a.review_anchor, "handoff_unknown"); assert.equal(ia.due_at, R(20, 20).toISOString(), "الطلب + ٨٠ (فات ⇒ reviews.js يبعته أول ما المطعم مفتوح)");
  /* الدعوة بتاعة b اتبعتت؛ a لسه (مثلاً البوابة) — وبعدين الكاشير قفل الاتنين */
  ib.sent_at = R(20, 32).toISOString();
  r.db.webhooks.push(WH("5902", R(20, 40).toISOString(), { order_status: "completed" }), WH("5903", R(20, 40).toISOString(), { order_status: "completed" }));
  await r.api.tick({ now: R(20, 45) });
  assert.equal(a.review_anchor, "handoff"); assert.equal(ia.due_at, R(21, 30).toISOString(), "التسليم ٢٠:٤٠ + ٥٠");
  assert.equal(b.review_anchor, "handoff_unknown", "الدعوة اتبعتت ⇒ مفيش تعديل"); assert.equal(ib.due_at, R(20, 20).toISOString());
});

test("KA2c الدورة: التسليم معروف وقت الدخول ⇒ منه على طول؛ دعوة reviews.js الأقدم بتاخد ميعاد KA2 (مش LEAST)؛ قفل بالغلط بعد دقيقة مايتحسبش؛ المرجع «وقت الطلب» بيحسم المستنيين", async () => {
  const r = rig({ cands: [CAND("561947382", "5904", R(19).toISOString()), CAND("568127394", "5905", R(19).toISOString())], now: R(19, 40), settings: ON,
    invites: [{ order_no: "pos:5905", code: "x", phone_norm: "568127394", due_at: R(19, 30).toISOString(), kind: "app", ka2: false }],
    webhooks: [WH("5904", R(19, 25).toISOString(), { approval: "picked_up" }), WH("5905", R(19, 1).toISOString(), { order_status: "completed" })] });
  await r.api.tick({ now: R(19, 40) });
  const a = r.db.k.find((k) => k.keeta_order_id === "5904"), b = r.db.k.find((k) => k.keeta_order_id === "5905");
  assert.equal(a.review_anchor, "handoff"); assert.equal(r.db.inv.find((i) => i.order_no === "pos:5904").due_at, R(20, 15).toISOString());
  const ib = r.db.inv.find((i) => i.order_no === "pos:5905");
  assert.equal(b.review_anchor, "pending", "قفل بعد دقيقة من الطلب = غلط"); assert.equal(ib.ka2, true);
  assert.equal(ib.due_at, R(21, 20).toISOString(), "ميعاد reviews.js (١٩:٣٠) كان هيطلّعها قبل التسليم ⇒ ميعاد KA2");
  r.S.keeta.pull.reviewAnchor = "order";
  await r.api.tick({ now: R(19, 45) });
  assert.equal(b.review_anchor, "order"); assert.equal(ib.due_at, R(19, 50).toISOString(), "الطلب + ٥٠");
});

test("KA2c الترحيل مرة واحدة: reviewDelayMin 80 (الحل المؤقت) من غير reviewAnchor ⇒ 50 من التسليم؛ أي حاجة تانية ⇒ زي ما هي", async () => {
  const m = rig({ settings: { keeta: { pull: { enabled: false, reviewDelayMin: 80 } } } });
  await m.api.ready;
  assert.equal(m.S.keeta.pull.reviewDelayMin, 50); assert.equal(m.S.keeta.pull.reviewAnchor, "handoff"); assert.equal(m.db.migrations, 1);
  const keep = rig({ settings: { keeta: { pull: { enabled: false, reviewDelayMin: 80, reviewAnchor: "order" } } } });
  await keep.api.ready;
  assert.equal(keep.S.keeta.pull.reviewDelayMin, 80, "المالك اختار المرجع ⇒ مانلمسش"); assert.equal(keep.db.migrations, 0);
  const other = rig({ settings: { keeta: { pull: { enabled: false, reviewDelayMin: 60 } } } });
  await other.api.ready;
  assert.equal(other.S.keeta.pull.reviewDelayMin, 60); assert.equal(other.db.migrations, 0);
  assert.match(K.ANCHOR_MIGRATION_SQL, /#>> '\{keeta,pull,reviewDelayMin\}' = '80'/);
  assert.match(K.ANCHOR_MIGRATION_SQL, /NOT \(\(data->'keeta'->'pull'\) \? 'reviewAnchor'\)/);
});
