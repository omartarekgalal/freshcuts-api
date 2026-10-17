/* 🏅 أداء الفريق (KP1) — node --test staffkpi.test.mjs — قاعدة وهمية، مفيش شبكة ولا كتابة حقيقية */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_DEFS, kpiTargets, parseTargets, kpiRange, directoryOf, makeIndex, AUTO_BY, SQL, SOURCE_AR, shapeKpis, collect, register,
  PRESENCE_DAY_UPSERT, PRESENCE_DAY_DDL, presenceDayParams, MAX_DAYS, PAID_AT,
} from "./staffkpi.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";

const NOW = new Date("2026-10-17T05:30:00Z");       // ٨:٣٠ صباح السبت ١٧/١٠ الرياض ⇒ اليوم التشغيلي ١٧/١٠
const SETTINGS = { portal: { staff: [
  { id: "st_1", name: "منى", role: "cashier", pinHash: "s1$a$b" }, { id: "st_2", name: "أحمد", role: "manager", pinHash: "s1$a$b" },
  { id: "st_3", name: "شيف سامي", role: "kitchen", pinHash: "s1$a$b" }, { id: "st_9", name: "قديم", role: "cashier", pinHash: "s1$a$b", active: false } ] },
  staffKpi: { targets: { ackMin: 3, handoverMin: 999, noticeMin: "abc" } } };

test("الأهداف: افتراضي من TARGET_DEFS، القيم بتتقصّ على المدى، واللي مش رقم بيرجع للافتراضي", () => {
  const t = kpiTargets(SETTINGS);
  assert.equal(t.ackMin, 3); assert.equal(t.handoverMin, 60, "سقف handoverMin"); assert.equal(t.noticeMin, 10); assert.equal(t.readyMin, 30);
  assert.deepEqual(Object.keys(t), TARGET_DEFS.map((d) => d.key));
  assert.equal(kpiTargets({}).ackMin, 2);
  const r = parseTargets({ ackMin: 4, reviewMin: "90" }, t);
  assert.equal(r.ok, true); assert.equal(r.targets.ackMin, 4); assert.equal(r.targets.reviewMin, 90); assert.equal(r.targets.readyMin, 30);
  assert.equal(parseTargets({ ackMin: 0 }, t).error, "out_of_range");
  assert.equal(parseTargets({ tableCallMin: "x" }, t).error, "bad_target");
  assert.ok(SERVER_OWNED_PATHS.includes("staffKpi"), "PUT /api/settings الكامل مايمسحش الأهداف");
  for (const d of TARGET_DEFS) assert.ok(/[؀-ۿ]/.test(d.label) && /[؀-ۿ]/.test(d.hint), d.key);
});

test("الفترة: أمس = يوم تشغيلي واحد، مخصص بالتواريخ، وسقف ١٢٠ يوم", () => {
  const y = kpiRange({ preset: "yesterday" }, NOW);
  assert.deepEqual([y.from, y.to, y.days, y.preset], ["2026-10-16", "2026-10-16", 1, "yesterday"]);
  assert.equal(y.startUtc, "2026-10-16T01:00:00.000Z"); assert.equal(y.endUtc, "2026-10-17T01:00:00.000Z"); assert.equal(y.partial, false);
  const c = kpiRange({ from: "2026-10-01", to: "2026-10-07" }, NOW);
  assert.deepEqual([c.from, c.to, c.days, c.preset], ["2026-10-01", "2026-10-07", 7, "custom"]);
  const big = kpiRange({ from: "2026-01-01", to: "2026-10-16" }, NOW);
  assert.equal(big.days, MAX_DAYS); assert.equal(big.to, "2026-10-16");
  assert.equal(kpiRange({}, NOW).partial, true, "النهارده لسه ماخلصش");
});

test("الدليل: المالك + الفعّالين من settings.portal.staff (المطبخ كمان)، والأسماء الغريبة بتبقى صفوف «مش في الفريق»، وكلام السيرفر مش أشخاص", () => {
  const d = directoryOf(SETTINGS);
  assert.deepEqual(d.map((s) => [s.id, s.role]), [["admin", "owner"], ["st_1", "cashier"], ["st_2", "manager"], ["st_3", "kitchen"]]);
  const idx = makeIndex(d);
  assert.equal(idx.of({ id: "st_1" }).name, "منى");
  assert.equal(idx.of({ name: "أحمد" }).id, "st_2");
  assert.equal(idx.of({ id: "st_77", name: "منى" }).id, "st_1", "id مش معروف بس الاسم معروف ⇒ بالاسم");
  const x = idx.of({ name: "زائر" }); assert.equal(x.inDirectory, false); assert.equal(x.id, "x:زائر"); assert.equal(idx.of({ name: "زائر" }), x);
  for (const a of ["استلمها موظف", "اترد على العميل", "closed", "البورتال اتفتح", "portal"]) { assert.ok(AUTO_BY.has(a)); assert.equal(idx.of({ name: a }), null); }
  assert.equal(idx.of({}), null);
  assert.equal(idx.all().length, 5);
});

test("SQL: كله قراية، معلّم، على $1/$2، ومن غير أرقام أعمدة في GROUPING SETS", () => {
  for (const [k, sql] of Object.entries(SQL)) {
    assert.match(sql, new RegExp(`^/\\*kpi:${k}\\*/`), k);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, k);
    assert.match(sql, /\$1/, k); assert.match(sql, /\$2/, k);
    assert.doesNotMatch(sql, /GROUPING SETS \(\(\d/, `${k}: GROUPING SETS بالتعبير مش بالرقم`);
    assert.ok(SOURCE_AR[k], `${k} ليه اسم عربي`);
  }
  for (const k of ["ack", "handed", "handovers", "firstReply", "reviewFirst", "notices", "tableCalls"]) assert.match(SQL[k], /make_interval\(mins => \$3::int\)/, k);
  assert.match(SQL.orders, /\$4::int/);
  assert.match(SQL.handovers, /NOT test/); assert.match(SQL.ack, /NOT COALESCE\(o\.is_test, false\)/); assert.match(SQL.firstReply, /NOT x\.test/);
  assert.match(SQL.pos, /ILIKE '%void%'/);
});

test("مراجعة ١٧/١٠: «شفته» وقبول نقطة البيع من لحظة الدفع (history status='paid') مش من إنشاء الطلب — واليوم التشغيلي والنافذة لسه على created_at", () => {
  assert.equal(PAID_AT, "COALESCE(pd.paid_at, o.created_at)", "لو مفيش صف «paid» في السجل ⇒ إنشاء الطلب");
  const base = "COALESCE\\(pd\\.paid_at, o\\.created_at\\)";
  for (const k of ["ack", "orders"]) {
    assert.match(SQL[k], /LEFT JOIN LATERAL \(SELECT min\(\(h->>'at'\)::timestamptz\) AS paid_at/, `${k}: أول «paid»`);
    assert.match(SQL[k], /jsonb_typeof\(o\.history\)='array'/, `${k}: history مش مصفوفة مايوقّعش الاستعلام`);
    assert.match(SQL[k], /h->>'status'='paid' AND \(h->>'at'\) ~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\[T \]\[0-9\]\{2\}:\[0-9\]\{2\}'/, `${k}: حماية الـcast بالـregex`);
    assert.match(SQL[k], /o\.created_at >= \$1 AND o\.created_at < \$2/, `${k}: النافذة على created_at`);
    assert.equal((SQL[k].match(/LEFT JOIN LATERAL \(SELECT min\(\(h->>'at'\)::timestamptz\)/g) || []).length, 1, `${k}: الـLATERAL مرة واحدة`);
  }
  // «شفته»: الوسيط و٩٠٪ و«خلال الهدف» كلهم من الدفع، واليوم من created_at
  assert.match(SQL.ack, new RegExp(`percentile_cont\\(0\\.5\\) WITHIN GROUP \\(ORDER BY \\(EXTRACT\\(EPOCH FROM \\(o\\.portal_ack_at - ${base}\\)\\)`));
  assert.match(SQL.ack, new RegExp(`percentile_cont\\(0\\.9\\) WITHIN GROUP \\(ORDER BY \\(EXTRACT\\(EPOCH FROM \\(o\\.portal_ack_at - ${base}\\)\\)`));
  assert.match(SQL.ack, new RegExp(`FILTER \\(WHERE o\\.portal_ack_at <= ${base} \\+ make_interval\\(mins => \\$3::int\\)\\)`));
  assert.doesNotMatch(SQL.ack, /portal_ack_at - o\.created_at\b/, "مفيش زمن من إنشاء الطلب");
  assert.doesNotMatch(SQL.ack, /portal_ack_at <= o\.created_at\b/);
  assert.match(SQL.ack, /GROUPING SETS \(\(o\.portal_ack_by\), \(o\.portal_ack_by, \(\(o\.created_at AT TIME ZONE/, "اليوم التشغيلي من created_at");
  // قبول نقطة البيع (مستوى الفريق): من الدفع؛ «جاهز» لسه من القبول
  assert.match(SQL.orders, new RegExp(`ORDER BY \\(EXTRACT\\(EPOCH FROM \\(o\\.accepted_at - ${base}\\)\\)`));
  assert.doesNotMatch(SQL.orders, /o\.accepted_at - o\.created_at/);
  assert.match(SQL.orders, /o\.pos_ready_at - o\.accepted_at/);
  assert.match(TARGET_DEFS.find((d) => d.key === "ackMin").hint, /لحظة دفع/);
});

const DIR = directoryOf(SETTINGS);
const RANGE = kpiRange({ from: "2026-10-15", to: "2026-10-16" }, NOW);
const T = kpiTargets({});
const ROWS = {
  audit: [
    { staff_id: "st_1", staff_name: "منى", role: "cashier", action: "login", day: "2026-10-15", n: 2, ok: 2 },
    { staff_id: "st_1", staff_name: "منى", role: "cashier", action: "ack", day: "2026-10-15", n: 5, ok: 5 },
    { staff_id: "st_2", staff_name: "أحمد", role: "manager", action: "courier_request", day: "2026-10-16", n: 4, ok: 3 },
    { staff_id: "st_2", staff_name: "أحمد", role: "manager", action: "courier_cancel", day: "2026-10-16", n: 1, ok: 1 },
    { staff_id: "st_1", staff_name: "منى", role: "cashier", action: "sms_optout", day: "2026-10-16", n: 1, ok: 1 },
  ],
  ack: [
    { name: "منى", day: null, n: 5, med: "1.5", p90: "4.2", within: 4 },
    { name: "منى", day: "2026-10-15", n: 5, med: "1.5", p90: "4.2", within: 4 },
    { name: "المالك", day: null, n: 1, med: "12", p90: "12", within: 0 }, { name: "المالك", day: "2026-10-16", n: 1, med: "12", p90: "12", within: 0 },
  ],
  handed: [{ name: "منى", day: null, n: 3, timed: 2, med: "4", within: 2 }, { name: "منى", day: "2026-10-16", n: 3, timed: 2, med: "4", within: 2 }],
  incidents: [{ name: "أحمد", day: "2026-10-16", resolution: "external", n: 2 }, { name: "أحمد", day: "2026-10-16", resolution: "retry", n: 1 }],
  incidentsOpen: [{ n: 4, open: 1 }],
  handovers: [
    { name: "منى", day: null, kind: "other", n: 4, acked: 4, med: "2", within: 3 }, { name: "منى", day: "2026-10-15", kind: "other", n: 4, acked: 4, med: "2", within: 3 },
    { name: "منى", day: null, kind: "note", n: 1, acked: 1, med: "1", within: 1 }, { name: "منى", day: "2026-10-16", kind: "note", n: 1, acked: 1, med: "1", within: 1 },
    { name: null, day: null, kind: "complaint", n: 2, acked: 0, med: null, within: 0 }, { name: null, day: "2026-10-16", kind: "complaint", n: 2, acked: 0, med: null, within: 0 },
    { name: "اترد على العميل", day: null, kind: "other", n: 1, acked: 1, med: "9", within: 0 }, { name: "اترد على العميل", day: "2026-10-16", kind: "other", n: 1, acked: 1, med: "9", within: 0 },
  ],
  firstReply: [{ name: "منى", day: null, n: 3, med: "2.4", within: 2 }, { name: "منى", day: "2026-10-15", n: 3, med: "2.4", within: 2 }],
  replies: [{ name: "منى", day: null, n: 12, chats: 5 }, { name: "منى", day: "2026-10-15", n: 7, chats: 3 }, { name: "منى", day: "2026-10-16", n: 5, chats: 2 }],
  chats: [{ name: "منى", day: "2026-10-15", action: "take", n: 3 }, { name: "منى", day: "2026-10-15", action: "done", n: 2 }, { name: "أحمد", day: "2026-10-16", action: "release", n: 1 }],
  closes: [{ name: "منى", outcome: "answered", n: 2 }, { name: "منى", outcome: "complaint_solved", n: 1 }],
  reviewActions: [{ name: "أحمد", day: "2026-10-16", action: "call", n: 2 }, { name: "أحمد", day: "2026-10-16", action: "outcome", n: 1 }, { name: "زائر", day: "2026-10-16", action: "note", n: 1 }],
  reviewFirst: [{ name: "أحمد", day: null, n: 2, med: "40", within: 2 }],
  reviewClosed: [{ name: "أحمد", day: null, n: 1, med: "95" }],
  reviewsOpen: [{ n: 3, open: 1 }],
  notices: [
    { name: "أحمد", day: null, role: "manager", n: 3, acked: 3, med: "5", within: 3 }, { name: "أحمد", day: "2026-10-16", role: "manager", n: 3, acked: 3, med: "5", within: 3 },
    { name: null, day: null, role: "cashier", n: 1, acked: 0, med: null, within: 0 }, { name: null, day: "2026-10-16", role: "cashier", n: 1, acked: 0, med: null, within: 0 },
    { name: "البورتال اتفتح", day: null, role: "cashier", n: 2, acked: 2, med: "20", within: 0 }, { name: "البورتال اتفتح", day: "2026-10-15", role: "cashier", n: 2, acked: 2, med: "20", within: 0 },
  ],
  tableCalls: [{ name: "منى", day: null, n: 2, done: 2, med: "1", within: 2 }, { name: "منى", day: "2026-10-16", n: 2, done: 2, med: "1", within: 2 },
    { name: null, day: null, n: 1, done: 0, med: null, within: 0 }, { name: null, day: "2026-10-16", n: 1, done: 0, med: null, within: 0 }],
  presence: [{ staff_id: "st_1", staff_name: "منى", role: "cashier", day: "2026-10-15", minutes: 300, visible_minutes: 280, first_at: "2026-10-15T08:00:00Z", last_at: "2026-10-15T14:00:00Z" },
    { staff_id: "st_1", staff_name: "منى", role: "cashier", day: "2026-10-16", minutes: 100, visible_minutes: 90, first_at: "2026-10-16T08:00:00Z", last_at: "2026-10-16T10:00:00Z" }],
  offline: [{ day: "2026-10-16", kind: "cashier", n: 2 }, { day: "2026-10-16", kind: "back", n: 1 }],
  orders: [
    { day: null, n: 30, accepted: 28, accept_med: "3.1", ready: 25, ready_med: "22", ready_p90: "35", ready_within: 20, acked: 6, collected: 4, promised: 20, promise_kept: 15, courier_timed: 18, courier_med: "1.2", courier_within: 17 },
    { day: "2026-10-15", n: 12, accepted: 12, accept_med: "2", ready: 10, ready_med: "20", ready_p90: "30", ready_within: 9, acked: 5, collected: 2, promised: 8, promise_kept: 7, courier_timed: 7, courier_med: "1", courier_within: 7 },
    { day: "2026-10-16", n: 18, accepted: 16, accept_med: "4", ready: 15, ready_med: "24", ready_p90: "36", ready_within: 11, acked: 1, collected: 2, promised: 12, promise_kept: 8, courier_timed: 11, courier_med: "1.5", courier_within: 10 },
  ],
  notes: [{ day: "2026-10-16", n: 3 }],
  pos: [{ name: "Majed", day: null, n: 40, sold: 38, revenue: "4100.5", voids: 1, refunds: 1 }, { name: "Majed", day: "2026-10-16", n: 40, sold: 38, revenue: "4100.5", voids: 1, refunds: 1 }],
};

test("التشكيل: كل موظف بمقاييسه وأيامه، والفريق بالمفتوح والتلقائي، و«غير متاح» صريح", () => {
  const out = shapeKpis({ directory: DIR, targets: T, range: RANGE, rows: { ...ROWS, ext: null }, failed: ["ext"] });
  assert.deepEqual(out.staff.map((s) => s.name), ["المالك", "أحمد", "منى", "شيف سامي", "زائر"], "الترتيب: مالك، مدير، كاشير، مطبخ، مش في الفريق");
  const mona = out.staff.find((s) => s.name === "منى"), ahmed = out.staff.find((s) => s.name === "أحمد"), chef = out.staff.find((s) => s.name === "شيف سامي"), x = out.staff.find((s) => s.name === "زائر");
  assert.equal(mona.metrics.logins, 2); assert.equal(mona.metrics.smsOptouts, 1);
  assert.deepEqual(mona.metrics.ack, { n: 5, medianMin: 1.5, p90Min: 4.2, within: 4, targetMin: 2, pct: 80 });
  assert.deepEqual(mona.metrics.handed, { n: 3, timed: 2, medianMin: 4, p90Min: null, within: 2, targetMin: 5, pct: 100 });
  assert.equal(mona.metrics.handovers.acked, 5); assert.equal(mona.metrics.handovers.notes, 1); assert.equal(mona.metrics.handovers.within, 4);
  assert.equal(mona.metrics.handovers.medianMin, 2, "وسيط مرجّح بالعدد"); assert.equal(mona.metrics.handovers.pct, 80); assert.equal(mona.metrics.handovers.notesMedianMin, 1);
  assert.equal(mona.metrics.handovers._w, undefined);
  assert.deepEqual(mona.metrics.replies, { n: 12, chats: 5, firstReply: { n: 3, medianMin: 2.4, p90Min: null, within: 2, targetMin: 3, pct: 66.7 } });
  assert.deepEqual(mona.metrics.chats, { taken: 3, closed: 2, released: 0, byOutcome: { answered: 2, complaint_solved: 1 } });
  assert.deepEqual(mona.metrics.tableCalls, { n: 2, done: 2, medianMin: 1, p90Min: null, within: 2, targetMin: 3, pct: 100 });
  assert.deepEqual(mona.metrics.presence, { minutes: 400, visibleMinutes: 370, days: 2, firstAt: "2026-10-15T08:00:00Z", lastAt: "2026-10-16T10:00:00Z" });
  assert.deepEqual(mona.daily.map((d) => [d.day, d.ack, d.handed, d.handovers, d.replies, d.presenceMin, d.logins, d.chatsClosed, d.tableCalls]),
    [["2026-10-15", 5, 0, 4, 7, 300, 2, 2, 0], ["2026-10-16", 0, 3, 1, 5, 100, 0, 0, 2]]);
  assert.deepEqual(ahmed.metrics.courierRequests, { n: 4, ok: 3, cancels: 1 });
  assert.deepEqual(ahmed.metrics.incidents, { n: 3, byResolution: { external: 2, retry: 1 } });
  assert.deepEqual(ahmed.metrics.reviews, { actions: 3, byAction: { call: 2, outcome: 1 }, closed: 1, medianCloseMin: 95, firstAction: { n: 2, medianMin: 40, p90Min: null, within: 2, targetMin: 60, pct: 100 } });
  assert.deepEqual(ahmed.metrics.notices, { n: 3, medianMin: 5, p90Min: null, within: 3, targetMin: 10, pct: 100 });
  assert.equal(ahmed.metrics.extCourier.n, 0, "المصدر وقع ⇒ صفر محسوب مش مخمّن، والمصدر في partial");
  assert.equal(chef.metrics.presence, null); assert.equal(chef.metrics.ack.n, 0); assert.equal(chef.daily.length, 2);
  assert.equal(x.inDirectory, false); assert.equal(x.metrics.reviews.actions, 1);
  // الفريق
  assert.deepEqual(out.team.handovers, { n: 8, acked: 6, auto: 1, open: 2, medianMin: 2, byKind: { other: 5, note: 1, complaint: 2 } });
  assert.deepEqual(out.team.notices, { n: 6, acked: 5, auto: 2, open: 1, byRole: { manager: 3, cashier: 3 } });
  assert.deepEqual(out.team.tableCalls, { n: 3, done: 2, open: 1 });
  assert.deepEqual(out.team.offline, { cashier: 2, manager: 0, back: 1, byDay: { "2026-10-16": { cashier: 2, manager: 0, back: 1 } } });
  assert.deepEqual(out.team.incidents, { n: 4, open: 1 }); assert.deepEqual(out.team.reviews, { n: 3, open: 1 });
  assert.deepEqual(out.team.notes, { n: 3, byDay: { "2026-10-16": 3 } });
  assert.deepEqual(out.team.closes.byOutcome, { answered: 2, complaint_solved: 1 });
  assert.equal(out.team.orders.n, 30); assert.equal(out.team.orders.acceptMedianMin, 3.1);
  assert.deepEqual(out.team.orders.ready, { n: 25, medianMin: 22, p90Min: 35, within: 20, targetMin: 30, pct: 80 });
  assert.deepEqual(out.team.orders.promise, { n: 20, kept: 15, pct: 75 });
  assert.deepEqual(out.team.orders.courier, { n: 18, medianMin: 1.2, within: 17, targetMin: 5, pct: 94.4 });
  assert.deepEqual(out.team.daily.map((d) => [d.day, d.n, d.ready.medianMin]), [["2026-10-15", 12, 20], ["2026-10-16", 18, 24]]);
  assert.deepEqual(out.team.pos.byStaff, [{ name: "Majed", invoices: 40, sold: 38, revenue: 4100.5, voids: 1, refunds: 1 }]);
  assert.deepEqual(out.partial, ["المندوب الخارجي"]);
  assert.deepEqual(out.unavailable.map((u) => u.key), ["cashClose", "kitchen", "posAcceptBy"]);
  // من غير دفتر حضور خالص ⇒ «غير متاح» بيتقال
  const noPres = shapeKpis({ directory: DIR, targets: T, range: RANGE, rows: { ...ROWS, presence: null }, failed: ["presence"] });
  assert.ok(noPres.unavailable.some((u) => u.key === "presence"));
  assert.equal(noPres.staff.find((s) => s.name === "منى").metrics.presence, null);
  // فاضي خالص ⇒ كل موظف بصفوفه وأيامه، ومفيش أي NaN
  const empty = shapeKpis({ directory: DIR, targets: T, range: RANGE, rows: Object.fromEntries(Object.keys(ROWS).map((k) => [k, []])) });
  assert.equal(empty.staff.length, 4); assert.equal(empty.team.orders.n, 0); assert.equal(empty.team.handovers.medianMin, null);
  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/);
});

test("دفتر الحضور اليومي: اليوم التشغيلي + سلّة الدقيقة، والـDDL/UPSERT على portal_presence_day", () => {
  const t = Date.parse("2026-10-17T00:30:00Z");        // ٣:٣٠ فجر السبت الرياض ⇒ لسه يوم ١٦/١٠
  const p = presenceDayParams({ user: { id: "st_1", name: "منى", role: "cashier" }, t, vis: t - 30_000 });
  assert.deepEqual(p, ["2026-10-16", "st_1", "منى", "cashier", Math.floor(t / 60_000), Math.floor((t - 30_000) / 60_000), "2026-10-17T00:30:00.000Z"]);
  assert.equal(presenceDayParams({ user: { id: "st_1" }, t, vis: null })[5], null);
  assert.match(PRESENCE_DAY_DDL, /CREATE TABLE IF NOT EXISTS portal_presence_day/); assert.match(PRESENCE_DAY_UPSERT, /ON CONFLICT \(day, staff_id\)/);
  assert.match(PRESENCE_DAY_UPSERT, /EXCLUDED\.last_bucket > COALESCE\(portal_presence_day\.last_bucket, 0\)/, "الدقيقة بتتعدّ مرة واحدة ومابترجعش لورا");
});

/* ── المسارات ── */
function world({ owner = true, portalUser = { id: "st_1", name: "منى", role: "cashier" }, fail = [], settings = SETTINGS } = {}) {
  const queries = [];
  const pool = { async query(sql, params) {
    const s = String(sql); queries.push([s, params]);
    const m = /^\/\*kpi:(\w+)\*\//.exec(s.trim());
    if (m) { if (fail.includes(m[1])) throw new Error("relation does not exist"); return { rows: ROWS[m[1]] || [] }; }
    if (/^UPDATE settings SET data = jsonb_set/.test(s)) { settings.staffKpi = { ...(settings.staffKpi || {}), ...JSON.parse(params[0]) }; return { rowCount: 1 }; }
    throw new Error("unexpected SQL: " + s.slice(0, 60));
  } };
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  const notes = [];
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => settings, isOwner: async () => owner, log: { error() {} }, auditNote: async (c, n) => { notes.push(n); } };
  const requirePortal = async (c) => (portalUser ? { user: portalUser } : { res: c.json({ ok: false, error: "unauthorized" }, 401) });
  const api = register(app, ctx, { requirePortal, now: () => NOW });
  const call = (method, path, { query = {}, body = {} } = {}) => routes[`${method} ${path}`]({ req: { query: (k) => query[k], json: async () => body }, json: (b, status = 200) => ({ body: b, status }) });
  return { call, queries, notes, api, routes };
}

test("GET /api/cms/staff-kpis: الفترة من preset، كل المصادر بتتقري بالأهداف، والمصدر اللي وقع بيتقال في partial", async () => {
  const w = world({ fail: ["ext", "presence"] });
  const r = await w.call("GET", "/api/cms/staff-kpis", { query: { preset: "yesterday" } });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.scope, "all");
  assert.deepEqual([r.body.range.from, r.body.range.to], ["2026-10-16", "2026-10-16"]);
  assert.equal(r.body.targets.ackMin, 3, "الهدف من الإعدادات"); assert.equal(r.body.targetDefs.length, TARGET_DEFS.length, "تعريفات الأهداف مع الرد (لغير المالك)");
  assert.deepEqual(r.body.partial, ["المندوب الخارجي", "حضور البوابة"]);
  assert.ok(r.body.unavailable.some((u) => u.key === "presence"));
  assert.equal(r.body.staff.find((s) => s.name === "منى").metrics.ack.targetMin, 3);
  assert.ok(r.body.team.pos && r.body.team.orders, "الفريق ونقطة البيع في رد اللوحة");
  const kinds = w.queries.map(([s]) => (/^\/\*kpi:(\w+)\*\//.exec(s.trim()) || [])[1]).filter(Boolean);
  assert.equal(new Set(kinds).size, Object.keys(SQL).length, "كل استعلام اتنفّذ مرة");
  const ack = w.queries.find(([s]) => /kpi:ack/.test(s));
  assert.deepEqual(ack[1], ["2026-10-16T01:00:00.000Z", "2026-10-17T01:00:00.000Z", 3]);
  const orders = w.queries.find(([s]) => /kpi:orders/.test(s)); assert.deepEqual(orders[1].slice(2), [30, 5]);
  const pres = w.queries.find(([s]) => /kpi:presence/.test(s)); assert.deepEqual(pres[1], ["2026-10-16", "2026-10-16"]);
  const bad = await w.call("GET", "/api/cms/staff-kpis", { query: { from: "16-10-2026" } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "bad_date");
  assert.ok(!w.queries.some(([s]) => /INSERT|UPDATE|DELETE/.test(s)), "قراية بس");
});

test("الأهداف: GET للكل، POST للمالك بس، بيتحفظ تحت settings.staffKpi.targets بالقصّ والتحقق، ومتسجّل في سجل النشاط", async () => {
  const settings = JSON.parse(JSON.stringify(SETTINGS));
  const staff = world({ owner: false, settings });
  const g = await staff.call("GET", "/api/cms/staff-kpis/settings");
  assert.equal(g.status, 200); assert.equal(g.body.owner, false); assert.equal(g.body.targets.ackMin, 3); assert.equal(g.body.defs.length, TARGET_DEFS.length);
  const denied = await staff.call("POST", "/api/cms/staff-kpis/settings", { body: { ackMin: 5 } });
  assert.equal(denied.status, 403); assert.equal(denied.body.error, "owner_only"); assert.equal(settings.staffKpi.targets.ackMin, 3);
  const own = world({ owner: true, settings });
  const bad = await own.call("POST", "/api/cms/staff-kpis/settings", { body: { targets: { ackMin: 500 } } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "out_of_range"); assert.match(bad.body.message, /بين/);
  const ok = await own.call("POST", "/api/cms/staff-kpis/settings", { body: { targets: { ackMin: 5, tableCallMin: "4" } } });
  assert.equal(ok.status, 200); assert.equal(ok.body.targets.ackMin, 5); assert.equal(ok.body.targets.tableCallMin, 4); assert.equal(ok.body.targets.readyMin, 30);
  assert.deepEqual(settings.staffKpi.targets.ackMin, 5);
  const up = own.queries.find(([s]) => /UPDATE settings/.test(s));
  assert.match(up[0], /'\{staffKpi\}'/); assert.equal(JSON.parse(up[1][0]).targets.tableCallMin, 4);
  assert.match(own.notes[0], /أهداف أداء الفريق/);
});

test("GET /api/portal/kpis: الكاشير يشوف نفسه بس (من غير الفريق ولا نقطة البيع)، المدير يشوف الكل، ومن غير جلسة 401", async () => {
  const cashier = world();
  const r = await cashier.call("GET", "/api/portal/kpis", { query: { preset: "yesterday" } });
  assert.equal(r.status, 200); assert.equal(r.body.scope, "self");
  assert.deepEqual(r.body.staff.map((s) => s.name), ["منى"]); assert.equal(r.body.team, null); assert.ok(Array.isArray(r.body.targetDefs));
  assert.ok(!cashier.queries.some(([s]) => /kpi:(pos|orders|offline|notes|reviewsOpen|incidentsOpen)/.test(s)), "مصادر الفريق مابتتقراش للكاشير");
  const mgr = world({ portalUser: { id: "st_2", name: "أحمد", role: "manager" } });
  const m = await mgr.call("GET", "/api/portal/kpis", { query: {} });
  assert.equal(m.body.scope, "all"); assert.equal(m.body.staff.length, 5); assert.ok(m.body.team.orders);
  const adminKey = world({ portalUser: { id: "admin", name: "المالك", role: "manager", admin: true } });
  assert.equal((await adminKey.call("GET", "/api/portal/kpis", { query: {} })).body.scope, "all");
  const anon = world({ portalUser: null });
  assert.equal((await anon.call("GET", "/api/portal/kpis", { query: {} })).status, 401);
});

test("collect: كل مصدر لوحده — واحد وقع مايوقّعش الباقي", async () => {
  const pool = { async query(sql) { const k = /^\/\*kpi:(\w+)\*\//.exec(String(sql).trim())[1]; if (k === "closes") throw new Error("boom"); return { rows: ROWS[k] || [] }; } };
  const { rows, failed } = await collect(pool, RANGE, T, { log: { error() {} } });
  assert.deepEqual(failed, ["closes"]); assert.equal(rows.closes, null); assert.equal(rows.ack.length, 4);
  const part = await collect(pool, RANGE, T, { log: { error() {} }, only: ["ack", "replies"] });
  assert.deepEqual(Object.keys(part.rows), ["ack", "replies"]);
});
