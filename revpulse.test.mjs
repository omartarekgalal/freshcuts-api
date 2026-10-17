/* RP2 (١٦/١٠) — رسالة الدخل الدورية: الإعدادات، المواعيد، النص، سطر التنبيه، والتشغيل على داتابيز مزيّفة وواتساب/SMS مزيّفين.
   node --test revpulse.test.mjs   (أرقام وهمية بس — ولا رسالة بتطلع) */
import test from "node:test";
import assert from "node:assert/strict";
process.env.REVENUE_PULSE_SCHEDULER = "0";
const R = await import("./revpulse.js");
const { smsInfo } = await import("./staffalerts.js");
const { typeOfRef, allowStaff } = await import("./staffcontrol.js");
const { SERVER_OWNED_PATHS, redactForViewer } = await import("./settings-guard.js");
const { reviewSkipPhones } = await import("./reviews.js");
const { Hono } = await import("hono");

const P_OWNER = "500000931", P_MGR = "500000932", P_X = "500000933";
const riyadh = (iso) => Date.parse(`${iso}+03:00`);          // "2026-10-16T19:05:00" بتوقيت الرياض
const FRI_1905 = riyadh("2026-10-16T19:05:00");

test("pulseCfg: الافتراضي (مفعّلة، ١ الضهر → ١ بالليل كل ساعتين، القفلة ٣:١٥) + الحدود", () => {
  const d = R.pulseCfg({});
  assert.deepEqual([d.enabled, d.fromHour, d.toHour, d.everyH, d.close, d.closeAt, d.wa, d.sms, d.skipNoChange, d.smsMaxParts], [true, 13, 1, 2, true, "03:15", true, true, true, 3]);
  assert.deepEqual(d.phones, []);
  const c = R.pulseCfg({ revenuePulse: { everyH: 99, smsMaxParts: 0, closeAt: "3:5", phones: [`0${P_X}`, `966${P_X}`, "bad"], wa: false, graceMin: "15" } });
  assert.equal(c.everyH, 6); assert.equal(c.smsMaxParts, 1); assert.equal(c.closeAt, "03:15", "صيغة غلط ⇒ الافتراضي");
  assert.deepEqual(c.phones, [P_X]); assert.equal(c.wa, false); assert.equal(c.graceMin, 15);
  assert.equal(R.pulseCfg({ revenuePulse: { closeAt: "2:45" } }).closeAt, "02:45");
});

test("settingsProblem: رسايل عربي للغلط", () => {
  const chk = (b) => R.settingsProblem(b, { ...R.PULSE_DEFAULTS, ...b });
  assert.equal(chk({ everyH: 3 }), null);
  assert.match(chk({ everyH: 0 }), /كل كام ساعة/);
  assert.match(chk({ fromHour: 2, toHour: 23 }), /قبل آخر رسالة/, "٢ الفجر بعد ١١ بالليل في اليوم التشغيلي");
  assert.match(chk({ closeAt: "00:30" }), /بعد آخر رسالة دورية/, "القفلة ١٢:٣٠ قبل آخر رسالة ١:٠٠");
  assert.match(chk({ closeAt: "25:00" }), /ساعة:دقيقة/);
  assert.match(chk({ phones: ["0512"] }), /مش سعودي/);
  assert.match(chk({ wa: "yes" }), /تشغيل\/إيقاف/);
  assert.equal(chk({ fromHour: 12, toHour: 2, close: false }), null);
});

test("slotsOf / dueSlot / nextSlot: المواعيد بتوقيت الرياض جوّه اليوم التشغيلي", () => {
  const cfg = R.pulseCfg({});
  assert.deepEqual(R.slotsOf(cfg).map((s) => `${s.key}:${s.kind}`),
    ["13:00:slot", "15:00:slot", "17:00:slot", "19:00:slot", "21:00:slot", "23:00:slot", "01:00:slot", "03:15:close"]);
  assert.equal(R.dueSlot(FRI_1905, cfg).key, "19:00");
  assert.equal(R.dueSlot(riyadh("2026-10-16T19:39:00"), cfg).key, "19:00", "جوّه الـ٤٠ دقيقة");
  assert.equal(R.dueSlot(riyadh("2026-10-16T19:45:00"), cfg), null, "عدّى ٤٥ دقيقة (السيرفر كان واقف) ⇒ مايتبعتش متأخر");
  assert.equal(R.dueSlot(FRI_1905, cfg, new Set(["19:00"])), null, "اتبعت قبل كده");
  assert.equal(R.dueSlot(riyadh("2026-10-16T12:30:00"), cfg), null, "قبل أول ميعاد");
  const close = R.dueSlot(riyadh("2026-10-17T03:20:00"), cfg);
  assert.deepEqual([close.key, close.kind], ["03:15", "close"]);
  assert.equal(R.dueSlot(riyadh("2026-10-17T01:02:00"), cfg).key, "01:00");
  const n1 = R.nextSlot(riyadh("2026-10-16T18:01:00"), cfg);
  assert.deepEqual([n1.key, n1.day, n1.at], ["19:00", "2026-10-16", "2026-10-16T16:00:00.000Z"]);
  const n2 = R.nextSlot(riyadh("2026-10-17T03:30:00"), cfg);
  assert.deepEqual([n2.key, n2.day, n2.at], ["13:00", "2026-10-17", "2026-10-17T10:00:00.000Z"], "بعد القفلة ⇒ ١ الضهر بكرة");
  /* القفلة على ميعاد دوري بتاخد مكانه */
  assert.deepEqual(R.slotsOf(R.pulseCfg({ revenuePulse: { fromHour: 23, toHour: 1, everyH: 2, closeAt: "01:00" } })).map((s) => `${s.key}:${s.kind}`), ["23:00:slot", "01:00:close"]);
});

/* نتيجة salesData مزيّفة بنفس الشكل (totals.groups / compare.lastWeek / ads / cards.store.split) */
const SALES = (o = {}) => ({
  totals: {
    orders: o.orders ?? 38, revenue: o.revenue ?? 4520.5,
    groups: { store: { orders: 9, revenue: 1200 }, apps: { orders: 18, revenue: 2100.5 }, restaurant: { orders: 11, revenue: 1220 } },
    compare: { lastWeek: o.noLw ? null : { label: "نفس اليوم الأسبوع اللي فات", orders: 33, revenue: 4036, deltaRevenue: o.delta ?? 0.12, deltaOrders: 0.15 } },
  },
  cards: [{ id: "store", orders: 9, revenue: 1200, split: { delivery: { orders: 7, revenue: 950 }, pickup: { orders: 2, revenue: 250 } } }],
  ads: o.noAds ? null : { total: o.ads ?? 410, shareOfRevenue: (o.ads ?? 410) / (o.revenue ?? 4520.5) },
});
const RANGE = { from: "2026-10-16", preset: "today" };

test("pulseText: نفس أرقام salesData، التقسيم، المقارنة بالجمعة اللي فاتت، الإعلانات قصاد ١٣٪، طلبات الموقع قصاد الهدف", () => {
  const m = R.pulseText({ d: SALES(), range: RANGE, now: FRI_1905, adsLimitPct: 13, target: 200, alert: null });
  const L = m.wa.split("\n");
  assert.ok(L.length <= 6, `≤ ٦ سطور (${L.length})`);
  assert.match(L[0], /لحد 7:05 م — الجمعة 16\/10/);
  assert.match(L[1], /4,521 ر · 38 طلب · ⬆️ \+12% عن الجمعة اللي فاتت \(4,036 ر\)/, "الرقم = totals.revenue (مقرّب) — مفيش حساب تاني");
  assert.match(L[2], /الموقع 1,200 ر \(9\) · 📱 التطبيقات 2,101 ر \(18\) · 🍽 الصالة والسفري 1,220 ر \(11\)/);
  assert.match(L[3], /الإعلانات 410 ر = 9% من الدخل \(الحد 13%\)$/);
  assert.match(L[4], /طلبات الموقع 9 من 200 \(توصيل 7 · استلام 2\)/);
  assert.equal(m.facts.revenue, 4520.5); assert.equal(m.facts.orders, 38); assert.equal(m.facts.ads.over, false);
  assert.ok(m.parts <= 3 && smsInfo(m.sms).segments <= 3, "SMS ≤ ٣ أجزاء");
  assert.doesNotMatch(m.sms, /[\u{1F300}-\u{1FAFF}]/u, "مفيش إيموجي في الـSMS");
  /* فوق الحد + نزول + تنبيه + قفلة */
  const o = R.pulseText({ d: SALES({ ads: 900, delta: -0.2 }), range: RANGE, now: riyadh("2026-10-17T03:15:00"), kind: "close", adsLimitPct: 13, target: 200, alert: "واتساب: الدفع عند ميتا فشل" });
  assert.match(o.wa, /^🧾 قفلة يوم الجمعة 16\/10/);
  assert.match(o.wa, /⬇️ -20% عن الجمعة اللي فاتت/);
  assert.match(o.wa, /= 20% من الدخل \(الحد 13%\) ⚠️ فوق الحد/);
  assert.match(o.wa.split("\n").at(-1), /^⚠️ واتساب: الدفع عند ميتا فشل$/);
  assert.match(o.sms, /تنبيه: واتساب/, "سطر التنبيه أولوية قبل طلبات الموقع في الـSMS");
  assert.ok(o.parts <= 3);
  /* الخميس: «اللي فات» + من غير مقارنة ولا إعلانات */
  const th = R.pulseText({ d: SALES({ noLw: true, noAds: true }), range: { from: "2026-10-15" }, now: riyadh("2026-10-15T13:00:00"), target: null });
  assert.match(th.wa, /الخميس 15\/10/); assert.doesNotMatch(th.wa, /الإعلانات|اللي فات/);
  /* جزء واحد بس */
  const one = R.pulseText({ d: SALES(), range: RANGE, now: FRI_1905, maxParts: 1, alert: "x".repeat(50) });
  assert.equal(smsInfo(one.sms).segments, 1); assert.match(one.sms, /^فريش كاتس لحد/);
});

test("alertLineOf: خطير في واتساب ⇒ أهم تنبيه إدارة آخر ساعتين ⇒ مفيش (التحذير لأ)", () => {
  const crit = { issues: [{ key: "x", level: "warn", title: "تحذير" }, { key: "pay_error", level: "crit", title: "ميتا رفضت", sms: "الدفع عند ميتا فشل" }] };
  assert.equal(R.alertLineOf({ health: crit, staffRows: [{ ref: "pos-failed W1" }] }), "واتساب: الدفع عند ميتا فشل");
  const rows = [{ ref: "courier deliver_late W1" }, { ref: "courier arrive_slow W2" }, { ref: "sla W3 handoff_breach" }, { ref: "test" }, { ref: "daily_report" }, { ref: "revenue-pulse 19:00 slot" }, { ref: "new-order W9" }];
  assert.equal(R.alertLineOf({ staffRows: rows }), "آخر ساعتين: 2 تنبيه «المندوب: تأخير أو رفض»");
  assert.equal(R.alertLineOf({ staffRows: [...rows, { ref: "pos-failed W7" }] }), "آخر ساعتين: 1 تنبيه «طلب مدفوع مانزلش نقطة البيع»", "الحرج قبل الأكتر عدداً");
  assert.equal(R.alertLineOf({ health: { issues: [{ level: "warn", key: "health_limited", title: "الاسم المعروض لسه في المراجعة" }] }, staffRows: [{ ref: "test" }] }), null,
    "التحذير القايم من أيام (الاسم في المراجعة) مايبقاش سطر في كل رسالة");
  assert.equal(R.alertLineOf({}), null);
});

test("staffcontrol + settings-guard + reviews: نوع «رسالة الدخل الدورية» والإعدادات ملك السيرفر والأرقام مستخبية", () => {
  assert.deepEqual(typeOfRef("revenue-pulse 19:00 slot"), { type: "revenue_pulse", code: "slot" });
  assert.deepEqual(typeOfRef("revenue-pulse 03:15 close"), { type: "revenue_pulse", code: "close" });
  assert.equal(allowStaff({ staffAlerts: { types: { revenue_pulse: { enabled: true, codes: { slot: false } } } } }, "revenue-pulse 19:00 slot", P_OWNER), false);
  assert.equal(allowStaff({ staffAlerts: { types: { revenue_pulse: { enabled: true, codes: { slot: false } } } } }, "revenue-pulse 03:15 close", P_OWNER), true);
  assert.ok(SERVER_OWNED_PATHS.includes("revenuePulse"), "الحفظ العام للإعدادات مايمسحش إعدادات الرسالة");
  assert.equal(redactForViewer({ revenuePulse: { phones: [P_X], everyH: 2 } }).revenuePulse.phones, undefined);
  assert.ok(reviewSkipPhones({ revenuePulse: { phones: [`0${P_X}`] } }).has(P_X), "رقم الاستلام مايتسألش عن تقييم");
});

/* ── التشغيل على داتابيز مزيّفة ─────────────────────────────────────────── */
function world({ settings, sales, wa = "open", smsFail = false, smsRows = [], health = null } = {}) {
  const db = {
    settings: settings || { waTeam: { members: [{ phone: P_OWNER, role: "owner" }, { phone: P_MGR, role: "manager" }] }, delivery: { alertPhones: [P_OWNER, P_MGR] }, adsGuard: { revenueCap: { pct: 13 } } },
    log: [], seq: 0, sales: sales || SALES(), smsRows, salesCalls: [], waSent: [], smsSent: [],
  };
  const pool = {
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE (TABLE|UNIQUE INDEX)/.test(s)) return { rows: [] };
      if (/^SELECT slot FROM revenue_pulse_log WHERE day=\$1::date AND kind <> 'test'$/.test(s)) return { rows: db.log.filter((r) => r.day === p[0] && r.kind !== "test").map((r) => ({ slot: r.slot })) };
      if (/^INSERT INTO revenue_pulse_log\(day, slot, kind\) VALUES .* ON CONFLICT \(day, slot\) WHERE kind <> 'test' DO NOTHING RETURNING id$/.test(s)) {
        if (db.beforeClaim) { db.beforeClaim(p); db.beforeClaim = null; }      // حاوية تانية حجزت بين القراية والحجز
        if (db.log.some((r) => r.day === p[0] && r.slot === p[1] && r.kind !== "test")) return { rows: [] };
        const row = { id: ++db.seq, day: p[0], slot: p[1], kind: p[2], status: "claimed" }; db.log.push(row); return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE revenue_pulse_log SET status=\$2/.test(s)) {
        const r = db.log.find((x) => x.id === p[0]);
        Object.assign(r, { status: p[1], reason: p[2], orders: p[3], revenue: p[4], text: p[5], sms_text: p[6], via: JSON.parse(p[7]) }); return { rows: [] };
      }
      if (/^SELECT orders FROM revenue_pulse_log WHERE day=\$1::date AND kind <> 'test' AND status='sent' AND id <> \$2 ORDER BY at DESC LIMIT 1$/.test(s)) {
        const r = db.log.filter((x) => x.day === p[0] && x.kind !== "test" && x.status === "sent" && x.id !== p[1]).sort((a, b) => b.id - a.id)[0];
        return { rows: r ? [{ orders: r.orders }] : [] };
      }
      if (/^SELECT ref FROM sms_log WHERE kind='staff' AND status='sent' AND at > NOW\(\) - INTERVAL '2 hours' GROUP BY ref/.test(s)) return { rows: db.smsRows };
      if (/^SELECT id, day::text AS day, slot, kind, at, status/.test(s)) return { rows: [...db.log].sort((a, b) => b.id - a.id).slice(0, 20).map((r) => ({ ...r, at: new Date(FRI_1905).toISOString() })) };
      if (/^INSERT INTO revenue_pulse_log\(day, slot, kind, status, reason, orders, revenue, text, sms_text, via\) VALUES \(\$1::date, \$2, 'test'/.test(s)) {
        db.log.push({ id: ++db.seq, day: p[0], slot: p[1], kind: "test", status: p[2], reason: p[3], orders: p[4], revenue: p[5], text: p[6], sms_text: p[7], via: JSON.parse(p[8]) }); return { rows: [] };
      }
      if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{revenuePulse\}', \$1::jsonb, true\) WHERE id=1$/.test(s)) { db.settings = { ...db.settings, revenuePulse: JSON.parse(p[0]) }; return { rows: [] }; }
      throw new Error(`fake db: unexpected SQL: ${s.slice(0, 120)}`);
    },
  };
  const biz = {
    async settings() { return { weekStart: 6, dailyTarget: 200 }; },
    async salesData(range) { db.salesCalls.push(range); return typeof db.sales === "function" ? db.sales() : db.sales; },
  };
  const waApi = {
    async sendFreeform(m) {
      db.waSent.push(m);
      if (wa === "open") return { ok: true, wamid: `wamid.${db.waSent.length}` };
      return { ok: false, skipped: wa };      // window_closed | disabled …
    },
  };
  const sendSms = async (m) => { db.smsSent.push(m); if (smsFail) throw new Error("Taqnyat down"); return { messageId: 1 }; };
  const app = new Hono();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => db.settings, isOwner: async (c) => c.req.header("x-owner") === "1" };
  const api = R.register(app, ctx, { biz, wa: waApi, health: { readState: async () => ({ data: { last: health } }) }, sendSms, schedule: false, now: () => db.now ?? FRI_1905, log: () => {} });
  const call = async (method, path, body, owner = true) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", ...(owner ? { "x-owner": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json() };
  };
  return { db, api, call };
}

test("tick ١٩:٠٥: نافذة المالك مفتوحة ⇒ واتساب حر ببلاش لرقم المالك بس، بنفس رقم salesData(today)، ومرة واحدة", async () => {
  const w = world();
  const r = await w.api.tick({ at: FRI_1905 });
  assert.equal(r.sent, 1); assert.equal(r.slot, "19:00");
  assert.equal(w.db.waSent.length, 1); assert.equal(w.db.smsSent.length, 0, "مفيش SMS لما الواتساب وصل");
  const m = w.db.waSent[0];
  assert.equal(m.phoneNorm, P_OWNER, "المالك اللي في دليل الفريق وفي أرقام الإنذارات — مش المدير");
  assert.equal(m.payload.type, "text", "رسالة حرة — مش قالب"); assert.equal(m.source, "pulse");
  assert.match(m.payload.text.body, /💰 4,521 ر · 38 طلب/);
  const rg = w.db.salesCalls[0];
  assert.equal(rg.preset, "today"); assert.equal(rg.from, "2026-10-16"); assert.equal(rg.cutUtc.getTime(), FRI_1905, "نفس فترة /api/reports/biz/sales?preset=today لحد دلوقتي");
  const row = w.db.log[0];
  assert.deepEqual([row.slot, row.kind, row.status, row.orders, row.revenue], ["19:00", "slot", "sent", 38, 4520.5]);
  assert.deepEqual(row.via, [{ to: `***${P_OWNER.slice(-4)}`, ch: "wa", ok: true, why: null }]);
  /* نفس الدقيقة تاني / دقيقة بعدها ⇒ مفيش إرسال تاني */
  assert.equal((await w.api.tick({ at: FRI_1905 + 60_000 })).skipped, "not_due");
  assert.equal(w.db.waSent.length, 1);
});

test("حاويتين وقت النشر: الحجز (unique على اليوم + الميعاد) بيمنع إن نفس الميعاد يتبعت مرتين", async () => {
  const w = world();
  w.db.beforeClaim = (p) => w.db.log.push({ id: ++w.db.seq, day: p[0], slot: p[1], kind: p[2], status: "claimed" });
  const r = await w.api.tick({ at: FRI_1905 });
  assert.deepEqual([r.skipped, r.slot], ["claimed_elsewhere", "19:00"]);
  assert.equal(w.db.waSent.length + w.db.smsSent.length, 0, "الحاوية التانية هي اللي هتبعت");
  assert.equal(w.db.salesCalls.length, 0, "ولا حتى بتحسب الأرقام");
});

test("النافذة مقفولة ⇒ SMS قصيرة من المرسل الخدمي (kind staff، المرجع revenue-pulse) ≤ ٣ أجزاء — ولا قالب", async () => {
  const w = world({ wa: "window_closed" });
  const r = await w.api.tick({ at: FRI_1905 });
  assert.equal(r.sent, 1);
  assert.equal(w.db.smsSent.length, 1);
  const s = w.db.smsSent[0];
  assert.deepEqual([s.phoneNorm, s.kind, s.ref], [P_OWNER, "staff", "revenue-pulse 19:00 slot"]);
  assert.ok(smsInfo(s.body).segments <= 3); assert.match(s.body, /^فريش كاتس لحد 7:05 م\nالدخل 4,521ر 38 طلب \+12% عن الجمعة اللي فاتت/);
  assert.equal(w.db.log[0].via[0].ch, "sms"); assert.equal(w.db.log[0].via[0].waWhy, "window_closed");
  assert.ok(w.db.waSent.every((m) => m.payload.type !== "template"));
});

test("واتساب والـSMS الاتنين فشلوا ⇒ «فشل» في السجل بالسبب، والميعاد مايتعادش كل دقيقة", async () => {
  const w = world({ wa: "disabled", smsFail: true });
  const r = await w.api.tick({ at: FRI_1905 });
  assert.equal(r.sent, 0);
  assert.equal(w.db.log[0].status, "failed"); assert.match(w.db.log[0].reason, /disabled→sms_failed/);
  assert.equal((await w.api.tick({ at: FRI_1905 + 60_000 })).skipped, "not_due");
});

test("مفيش طلبات جديدة من آخر رسالة ⇒ تتخطّى وتتسجّل — إلا القفلة اللي بتتبعت دايماً", async () => {
  const w = world();
  await w.api.tick({ at: FRI_1905 });                                         // ٣٨ طلب ⇒ اتبعتت
  const r = await w.api.tick({ at: riyadh("2026-10-16T21:02:00") });         // لسه ٣٨
  assert.equal(r.skipped, "no_change"); assert.equal(w.db.waSent.length, 1);
  assert.deepEqual([w.db.log[1].slot, w.db.log[1].status, w.db.log[1].reason], ["21:00", "skipped", "no_change"]);
  w.db.sales = SALES({ orders: 41, revenue: 4900 });
  assert.equal((await w.api.tick({ at: riyadh("2026-10-16T23:01:00") })).sent, 1, "٣ طلبات جديدة عن آخر رسالة اتبعتت (مش عن اللي اتخطّت)");
  const c = await w.api.tick({ at: riyadh("2026-10-17T03:16:00") });          // نفس الـ٤١
  assert.deepEqual([c.sent, c.kind], [1, "close"]);
  assert.match(w.db.waSent.at(-1).payload.text.body, /^🧾 قفلة يوم الجمعة 16\/10/);
  /* أول ميعاد واليوم لسه صفر ⇒ مفيش رسالة «صفر» */
  const z = world({ sales: SALES({ orders: 0, revenue: 0 }) });
  assert.equal((await z.api.tick({ at: riyadh("2026-10-16T13:03:00") })).skipped, "no_change");
  /* skipNoChange مقفول ⇒ بتتبعت */
  const k = world({ sales: SALES({ orders: 0, revenue: 0 }) });
  k.db.settings.revenuePulse = { skipNoChange: false };
  assert.equal((await k.api.tick({ at: riyadh("2026-10-16T13:03:00") })).sent, 1);
});

test("مقفولة / مفيش رقم / الاتنين قنوات مقفولة / ميعاد قديم", async () => {
  const off = world(); off.db.settings.revenuePulse = { enabled: false };
  assert.equal((await off.api.tick({ at: FRI_1905 })).skipped, "disabled"); assert.equal(off.db.log.length, 0);
  const np = world({ settings: {} });
  assert.equal((await np.api.tick({ at: FRI_1905 })).skipped, "no_phones"); assert.equal(np.db.log[0].reason, "no_phones");
  const nc = world(); nc.db.settings.revenuePulse = { wa: false, sms: false };
  assert.equal((await nc.api.tick({ at: FRI_1905 })).skipped, "no_channel");
  const late = world();
  assert.equal((await late.api.tick({ at: riyadh("2026-10-16T19:50:00") })).skipped, "not_due"); assert.equal(late.db.log.length, 0);
  /* أرقام مكتوبة بإيد المالك بتغلب التلقائي */
  const cu = world(); cu.db.settings.revenuePulse = { phones: [`0${P_X}`] };
  await cu.api.tick({ at: FRI_1905 });
  assert.deepEqual(cu.db.waSent.map((m) => m.phoneNorm), [P_X]);
});

test("سطر التنبيه في الرسالة: مشكلة خطيرة في واتساب أو تنبيه مندوب آخر ساعتين", async () => {
  const w = world({ health: { issues: [{ level: "crit", key: "pay_error", sms: "الدفع عند ميتا فشل والرسايل مش بتوصل" }] } });
  await w.api.tick({ at: FRI_1905 });
  assert.match(w.db.waSent[0].payload.text.body.split("\n").at(-1), /^⚠️ واتساب: الدفع عند ميتا فشل/);
  const c = world({ smsRows: [{ ref: "courier deliver_late W1" }] });
  await c.api.tick({ at: FRI_1905 });
  assert.match(c.db.waSent[0].payload.text.body, /⚠️ آخر ساعتين: 1 تنبيه «المندوب: تأخير أو رفض»/);
  const off = world({ smsRows: [{ ref: "courier deliver_late W1" }] }); off.db.settings.revenuePulse = { alertLine: false };
  await off.api.tick({ at: FRI_1905 });
  assert.doesNotMatch(off.db.waSent[0].payload.text.body, /⚠️/);
});

test("الأرقام ماتقرتش ⇒ «فشل: الأرقام ماتقرتش» من غير إرسال", async () => {
  const w = world({ sales: () => { throw new Error("db down"); } });
  const r = await w.api.tick({ at: FRI_1905 });
  assert.equal(r.error, "data_error"); assert.equal(w.db.waSent.length + w.db.smsSent.length, 0);
  assert.equal(w.db.log[0].reason, "data_error");
});

test("المسارات: العرض (المالك الأرقام كاملة، غيره مستخبية) + الحفظ للمالك بس وبرسالة عربي + التجربة", async () => {
  const w = world();
  w.db.now = riyadh("2026-10-16T18:01:00");
  const g = await w.call("GET", "/api/cms/revenue-pulse");
  assert.equal(g.j.ok, true);
  assert.deepEqual(g.j.slots.map((s) => s.key), ["13:00", "15:00", "17:00", "19:00", "21:00", "23:00", "01:00", "03:15"]);
  assert.equal(g.j.next.key, "19:00");
  assert.deepEqual(g.j.recipients.phones, [P_OWNER]); assert.equal(g.j.recipients.source, "owner_alert");
  assert.match(g.j.preview.wa, /دخل فريش كاتس لحد 6:01 م/); assert.ok(g.j.preview.parts <= 3);
  assert.equal(g.j.defaults.everyH, 2);
  const v = await w.call("GET", "/api/cms/revenue-pulse", null, false);
  assert.deepEqual(v.j.recipients.phones, [`***${P_OWNER.slice(-4)}`], "غير المالك مايشوفش الرقم كامل");
  /* الحفظ */
  const no = await w.call("POST", "/api/cms/revenue-pulse/settings", { everyH: 3 }, false);
  assert.equal(no.status, 403); assert.equal(w.db.settings.revenuePulse, undefined);
  const bad = await w.call("POST", "/api/cms/revenue-pulse/settings", { fromHour: 2, toHour: 23 });
  assert.equal(bad.j.ok, false); assert.match(bad.j.message, /قبل آخر رسالة/); assert.equal(w.db.settings.revenuePulse, undefined);
  const ok = await w.call("POST", "/api/cms/revenue-pulse/settings", { everyH: 3, phones: `0${P_X}`, closeAt: "3:30" });
  assert.equal(ok.j.ok, true);
  assert.deepEqual([w.db.settings.revenuePulse.everyH, w.db.settings.revenuePulse.closeAt, w.db.settings.revenuePulse.phones], [3, "03:30", [P_X]]);
  assert.equal(w.db.settings.revenuePulse.fromHour, 13, "المفاتيح التانية زي ما هي");
  assert.deepEqual(ok.j.slots.map((s) => s.key), ["13:00", "16:00", "19:00", "22:00", "01:00", "03:30"]);
  /* التجربة: لنفس المستلمين، مابتحجزش ميعاد */
  const t = await w.call("POST", "/api/cms/revenue-pulse/test", {});
  assert.equal(t.j.ok, true); assert.equal(t.j.sent, 1);
  assert.match(w.db.waSent[0].payload.text.body, /^🧪 تجربة\n📊 دخل فريش كاتس/);
  assert.equal(w.db.waSent[0].phoneNorm, P_X);
  assert.equal(w.db.log.at(-1).kind, "test");
  const t2 = await w.call("POST", "/api/cms/revenue-pulse/test", {}, false);
  assert.equal(t2.status, 403);
  /* التجربة مابتاخدش مكان ميعاد ١٩:٠٠ */
  assert.equal((await w.api.tick({ at: FRI_1905 })).sent, 1);
  /* تجربة والنافذة مقفولة ⇒ SMS بالمرجع test (بيعدّي بوابة رسايل الإدارة دايماً) */
  const s = world({ wa: "window_closed" });
  await s.call("POST", "/api/cms/revenue-pulse/test", {});
  assert.deepEqual([s.db.smsSent[0].ref, s.db.smsSent[0].kind], ["test", "staff"]);
});

test("MC1: سطر «التسويق» جنب سطر الإعلانات — الرقمين بيبانوا وحد الـ١٣٪ فاضل على الإعلانات؛ من غيره مفيش سطر", () => {
  const mk = { marketingTotal: 546.1, shareOfRevenue: 546.1 / 4520.5, operationalTotal: 7.05, estimated: false,
    breakdown: { ads: 526.43, whatsapp: 12.95, sms: 6.72 } };
  const m = R.pulseText({ d: { ...SALES({ ads: 526.43 }), marketing: mk }, range: RANGE, now: FRI_1905, adsLimitPct: 13, target: 200, alert: null });
  const L = m.wa.split("\n");
  assert.match(L[3], /^📣 الإعلانات 526 ر = 12% من الدخل \(الحد 13%\)$/, "سطر الإعلانات زي ما هو");
  assert.match(L[4], /^📣 التسويق 546 ر = 12% من الدخل \(إعلانات 526 · واتساب 13 · رسائل 6\.7\) — الحد 13% على الإعلانات بس$/);
  assert.match(L[5], /^🌐 طلبات الموقع/);
  assert.deepEqual(m.facts.marketing, { total: 546.1, pct: 12.1, ads: 526.43, whatsapp: 12.95, sms: 6.72, operational: 7.05, estimated: false, adsLimit: 13 });
  assert.equal(m.facts.ads.total, 526.43, "رقم الإعلانات لوحده لسه موجود");
  assert.match(m.sms, /تسويق 546ر 12% \(اعلانات 526 واتساب 13 رسائل 6\.7\)/);
  assert.ok(smsInfo(m.sms).segments <= 3);
  /* تقديري ⇒ معلّم؛ خطأ أو مفيش ⇒ ولا سطر */
  const e = R.pulseText({ d: { ...SALES(), marketing: { ...mk, estimated: true } }, range: RANGE, now: FRI_1905 });
  assert.match(e.wa, /رسائل 6\.7 · جزء تقديري\)/);
  for (const bad of [undefined, null, { error: "down" }, { marketingTotal: null }]) {
    const x = R.pulseText({ d: { ...SALES(), marketing: bad }, range: RANGE, now: FRI_1905 });
    assert.doesNotMatch(x.wa, /التسويق/); assert.doesNotMatch(x.sms, /تسويق/); assert.equal(x.facts.marketing, null);
  }
  /* جزء واحد: سطر التسويق بيقع قبل ما سطر الدخل يقع */
  const one = R.pulseText({ d: { ...SALES(), marketing: mk }, range: RANGE, now: FRI_1905, maxParts: 1 });
  assert.equal(smsInfo(one.sms).segments, 1); assert.match(one.sms, /^فريش كاتس لحد/);
});
