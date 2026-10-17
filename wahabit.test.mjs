/* CJ1b (١٧/١٠) — الإرسال على عادة العميل: node --test wahabit.test.mjs
   كل البيانات مصطنعة (أرقام 5100002xx / 5200001xx) — مفيش بيانات عميل حقيقية، ولا شبكة (fetch مزيّف)، ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const Hb = await import("./wahabit.js");
const P = await import("./custprofile.js");
const S = await import("./wasender.js");
const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);
C.registerCampaignTemplates();

const H = 3600_000, M = 60_000;
const NOW = Date.parse("2026-10-17T10:00:00Z");          // السبت ١٧/١٠ ١٣:٠٠ الرياض
const RY = (iso) => Date.parse(iso + "+03:00");           // لحظة بتوقيت الرياض
const CFG = P.profileCfg({});
const on = (x = {}) => ({ enabled: true, ...x });

// ───────── الإعدادات ─────────
test("الإعدادات: الافتراضي (مقفول، ٩٠ دقيقة، القفل ٢ الفجر)، الحدود، وsenderCfg شايلها تحت waSender.byHabit", () => {
  assert.deepEqual(Hb.habitCfg({}), { enabled: false, spreadQuiet: true, leadMin: 90, fromHour: 12, nightCutoffHour: 2, fallbackHour: 17, maxPerHour: 0 });
  assert.deepEqual(Hb.habitCfg(null), Hb.habitCfg(undefined));
  const x = Hb.habitCfg({ enabled: "yes", spreadQuiet: false, leadMin: 999, fromHour: -1, nightCutoffHour: "x", fallbackHour: 23.6, maxPerHour: 5000 });
  assert.deepEqual(x, { enabled: false, spreadQuiet: false, leadMin: 240, fromHour: 0, nightCutoffHour: 2, fallbackHour: 23, maxPerHour: 1000 });
  assert.deepEqual(S.senderCfg({}).byHabit, Hb.habitCfg({}));
  assert.equal(S.senderCfg({ waSender: { byHabit: { enabled: true, leadMin: 60 } } }).byHabit.leadMin, 60);
  assert.equal(S.senderCfg({ waSender: { byHabit: { enabled: true } } }).byHabit.enabled, true);
});

test("المخطط: كل مفتاح له تسمية وشرح عربي ومجموعة «الإيقاع»، والأرقام بحدودها، والافتراضي والقيمة الحيّة في الصفوف", () => {
  for (const k of Object.keys(Hb.HABIT_DEFAULTS)) {
    const s = Hb.HABIT_SCHEMA[k];
    assert.ok(s, k); assert.equal(s.group, Hb.HABIT_GROUP); assert.ok(s.ar && s.help, k);
    if (s.type === "number") assert.deepEqual([s.min, s.max], Hb.HABIT_NUMS[k], k); else assert.equal(s.type, "boolean");
  }
  assert.deepEqual(Object.keys(Hb.HABIT_SCHEMA).sort(), Object.keys(Hb.HABIT_DEFAULTS).sort());
  const rows = Hb.habitSchemaRows({ enabled: true, leadMin: 45 });
  const en = rows.find((r) => r.key === "enabled"), lead = rows.find((r) => r.key === "leadMin"), cut = rows.find((r) => r.key === "nightCutoffHour");
  assert.deepEqual([en.default, en.value, en.groupAr], [false, true, Hb.HABIT_GROUP_AR]);
  assert.deepEqual([lead.default, lead.value, lead.unit], [90, 45, "دقيقة"]);
  assert.deepEqual([cut.default, cut.value], [2, 2]);
  assert.match(Hb.HABIT_GROUP_AR, /الإيقاع/);
});

// ───────── ساعة العادة ─────────
test("ساعة العادة: هيستوجرام ٢٤ خانة، ذروة بعد تنعيم ±ساعة، أقل من الحد = مفيش ساعة، وبعد نص الليل بيتحسب صح", () => {
  const hist = Hb.hourHistOf([20, 20, 21, 13, 99, -1, "x"]);
  assert.equal(hist.length, 24); assert.deepEqual([hist[13], hist[20], hist[21]], [1, 2, 1]); assert.equal(hist.reduce((a, b) => a + b, 0), 4);
  assert.equal(Hb.bestHourOf(hist, 3), 20);
  assert.equal(Hb.bestHourOf(Hb.hourHistOf([20, 21]), 3), null, "طلبين بس ⇒ null");
  assert.equal(Hb.bestHourOf(Hb.hourHistOf([20, 21]), 2), 20, "الحد من الإعدادات");
  assert.equal(Hb.bestHourOf(Hb.hourHistOf([0, 1, 1, 23]), 3), 1, "التعادل بعد التنعيم ⇒ الأعلى خام");
  assert.equal(Hb.bestHourOf(Hb.hourHistOf([19, 21, 23]), 3), 19, "تعادل كامل ⇒ الأبكر بترتيب يوم العمل");
  assert.equal(Hb.bestHourOf([1, 2], 1), null, "هيستوجرام مش ٢٤ خانة ⇒ null");
});

test("ملف العميل (custprofile): best_hour + hour_hist بالرياض من طلباته، العمودين في الجدول، الحقل في الملف، والإعداد habitMinOrders من اللوحة", () => {
  const x = (ats) => ({ pn: "510000201", staff: false, names: [], wa: {}, mkt: null, orders: ats.map((at) => ({ at, total: 80, channel: "pos", service: "takeaway", items: [{ name: "كباب مشوي بالوزن - نص كيلو", qty: 1 }] })) });
  const three = P.computeProfile(x(["2026-10-10T17:00:00Z", "2026-10-11T17:30:00Z", "2026-10-12T18:00:00Z"]), { cfg: CFG, now: NOW, trigger: "test" });      // ٢٠:٠٠ ٢٠:٣٠ ٢١:٠٠ الرياض
  assert.equal(three.best_hour, 20); assert.deepEqual([three.hour_hist[20], three.hour_hist[21], three.hour_hist.length], [2, 1, 24]);
  const two = P.computeProfile(x(["2026-10-10T17:00:00Z", "2026-10-11T17:30:00Z"]), { cfg: CFG, now: NOW, trigger: "test" });
  assert.equal(two.best_hour, null); assert.equal(two.hour_hist[20], 2);
  const none = P.computeProfile(x([]), { cfg: CFG, now: NOW, trigger: "test" });
  assert.deepEqual([none.best_hour, none.hour_hist], [null, null]);
  const strict = P.profileCfg({ cms: { customerProfile: { habitMinOrders: 5 } } });
  assert.equal(strict.habitMinOrders, 5);
  assert.equal(P.computeProfile(x(["2026-10-10T17:00:00Z", "2026-10-11T17:30:00Z", "2026-10-12T18:00:00Z"]), { cfg: strict, now: NOW, trigger: "test" }).best_hour, null);
  assert.equal(CFG.habitMinOrders, 3);
  assert.ok(P.PROFILE_SCHEMA.some((s) => s.key === "habitMinOrders" && s.group === "timing" && s.ar && s.default === 3));
  assert.ok(P.PROFILE_COLS.some(([c, t]) => c === "best_hour" && t === "SMALLINT"));
  assert.ok(P.PROFILE_COLS.some(([c, t]) => c === "hour_hist" && t === "SMALLINT[]"));
  assert.ok(P.PROFILE_DDL.some((d) => /ADD COLUMN IF NOT EXISTS hour_hist SMALLINT\[\]/.test(d)));
  assert.ok(P.PROFILE_DDL.some((d) => /ADD COLUMN IF NOT EXISTS best_hour SMALLINT/.test(d)));
  assert.ok(P.PROFILE_FIELDS.some((f) => f.key === "best_hour" && f.group === "timing" && /الساعة/.test(f.ar)));
  const db = P.fromDb({ phone_norm: "510000201", best_hour: 20, hour_hist: [0, 1, 2] });
  assert.deepEqual([db.best_hour, db.hour_hist], [20, [0, 1, 2]]);
  assert.deepEqual(P.fromDb({ phone_norm: "510000201", best_hour: null, hour_hist: null }).hour_hist, []);
});

// ───────── النافذة ─────────
test("نافذة النهارده (الرياض): من دلوقتي للقفل؛ بعد نص الليل = ديل إمبارح؛ قبل أول ساعة = تبدأ أول ساعة؛ ومن غير لف وخلصت = بكرة", () => {
  const w = Hb.habitWindow(on(), NOW);
  assert.equal(w.start, NOW); assert.equal(w.end, RY("2026-10-18T02:00:00")); assert.equal(w.from, RY("2026-10-17T12:00:00"));
  assert.deepEqual(w.hours, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1]);
  const late = Hb.habitWindow(on(), RY("2026-10-17T01:10:00"));      // ١:١٠ فجر السبت ⇒ ديل نافذة الجمعة
  assert.equal(late.end, RY("2026-10-17T02:00:00")); assert.equal(late.start, RY("2026-10-17T01:10:00")); assert.deepEqual(late.hours, [1]);
  const early = Hb.habitWindow(on(), RY("2026-10-17T09:00:00"));
  assert.equal(early.start, RY("2026-10-17T12:00:00")); assert.equal(early.end, RY("2026-10-18T02:00:00")); assert.equal(early.hours[0], 12);
  const at2 = Hb.habitWindow(on(), RY("2026-10-17T02:00:00"));      // ٢ بالظبط = النافذة قفلت ⇒ النهارده من ١٢
  assert.equal(at2.start, RY("2026-10-17T12:00:00"));
  const nowrap = Hb.habitWindow(on({ fromHour: 12, nightCutoffHour: 22 }), RY("2026-10-17T23:00:00"));
  assert.equal(nowrap.start, RY("2026-10-18T12:00:00")); assert.equal(nowrap.end, RY("2026-10-18T22:00:00"));
  assert.deepEqual([Hb.riyadhHHMM(NOW), Hb.riyadhStamp(NOW)], ["13:00", "2026-10-17 13:00"]);
});

// ───────── planSendAt ─────────
test("planSendAt: ساعته − المهلة؛ أبكر من النافذة ⇒ أولها؛ فاتت النهارده ⇒ للهدوء (مش بكرة)؛ بعد نص الليل جوّه؛ بعد القفل بره؛ من غير ساعة ⇒ هدوء", () => {
  const at = (best_hour, cfg = on(), now = NOW) => Hb.planSendAt({ profileRow: { best_hour }, cfg, now });
  assert.deepEqual(at(20), { at: RY("2026-10-17T18:30:00"), why: "habit" });
  assert.deepEqual(at("20"), { at: RY("2026-10-17T18:30:00"), why: "habit" }, "نص من الداتابيز");
  assert.deepEqual(at(15), { at: RY("2026-10-17T13:30:00"), why: "habit" });
  assert.deepEqual(at(12), { at: null, why: "passed" }, "١٠:٣٠ ⇒ ١٢:٠٠ ⇒ قبل دلوقتي (١٣:٠٠) ⇒ فاتت");
  assert.deepEqual(at(13), { at: null, why: "passed" });
  assert.deepEqual(at(1), { at: RY("2026-10-17T23:30:00"), why: "habit" }, "١ الفجر ⇒ ١١:٣٠ بالليل");
  assert.deepEqual(at(3), { at: RY("2026-10-18T01:30:00"), why: "habit" }, "٣ الفجر ⇒ ١:٣٠ (قبل القفل)");
  assert.deepEqual(at(3, on({ leadMin: 0 })), { at: null, why: "outside" }, "٣ الفجر من غير مهلة ⇒ بعد القفل");
  assert.deepEqual(at(4), { at: null, why: "passed" }, "٤ الفجر = أول يوم العمل ⇒ صبح النهارده ⇒ أول النافذة ⇒ فاتت");
  assert.deepEqual(at(4, on(), RY("2026-10-17T09:00:00")), { at: RY("2026-10-17T12:00:00"), why: "habit" });
  assert.deepEqual(at(11, on(), RY("2026-10-17T09:00:00")), { at: RY("2026-10-17T12:00:00"), why: "habit" }, "زبون الافتتاح ⇒ أول النافذة");
  assert.deepEqual(at(null), { at: null, why: "quiet" });
  assert.deepEqual(at(undefined), { at: null, why: "quiet" });
  assert.deepEqual(Hb.planSendAt({ profileRow: null, cfg: on(), now: NOW }), { at: null, why: "quiet" });
  assert.deepEqual(at(12, on(), RY("2026-10-17T09:00:00")), { at: RY("2026-10-17T12:00:00"), why: "habit" }, "الحملة اتعملت الصبح: زبون الغدا أول النافذة");
  assert.deepEqual(at(20, on({ leadMin: 0 })), { at: RY("2026-10-17T20:00:00"), why: "habit" });
  assert.deepEqual(at(22, on({ nightCutoffHour: 1 })), { at: RY("2026-10-17T20:30:00"), why: "habit" });
  assert.deepEqual(at(2, on({ nightCutoffHour: 1 })), { at: RY("2026-10-18T00:30:00"), why: "habit" });
  assert.deepEqual(at(3, on({ nightCutoffHour: 1 })), { at: null, why: "outside" });
  for (const h of [...Array(24).keys()]) { const r = at(h); if (r.at != null) assert.ok(r.at >= NOW && r.at < RY("2026-10-18T02:00:00"), `h=${h} جوّه النافذة`); }
});

// ───────── planJob ─────────
test("planJob: اللي له ساعة في ساعته، واللي مالوش يتوزّع بالتساوي على الساعات الأفضى، وكله جوّه النافذة ومش في الماضي، والمجموع = العدد", () => {
  const rows = [...Array(6).keys()].map((i) => ({ pn: `52000010${i}`, best_hour: 20 })).concat([...Array(26).keys()].map((i) => ({ pn: `5200002${String(i).padStart(2, "0")}`, best_hour: null })));
  const p = Hb.planJob({ rows, cfg: on(), now: NOW, hourCap: 60 });
  assert.equal(p.byPn.size, 32); assert.deepEqual([p.total, p.byHabit, p.noHour, p.passed, p.outside], [32, 6, 26, 0, 0]);
  assert.deepEqual(p.hours.map((h) => h.hour), [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1]);
  const at18 = p.hours.find((h) => h.hour === 18);
  assert.deepEqual(at18, { hour: 18, n: 6, byHabit: 6, fallback: 0 }, "عادتهم ٨ ⇒ ٦:٣٠ (ساعة ٦ مشغولة بالعادة ⇒ مفيش هدوء فيها)");
  assert.deepEqual(p.hours.filter((h) => h.hour !== 18).map((h) => h.n), [3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], "٢٦ على ١٢ ساعة: ٢ لكل ساعة والباقي للأبكر");
  assert.equal(p.hours.reduce((a, h) => a + h.n, 0), 32);
  const end = RY("2026-10-18T02:00:00");
  for (const [pn, v] of p.byPn) { const t = Date.parse(v.at); assert.ok(t >= NOW && t < end, `${pn} ${v.at}`); }
  assert.equal(p.byPn.get("520000100").at, new Date(RY("2026-10-17T18:30:00")).toISOString());
  assert.equal(p.byPn.get("520000100").why, "habit"); assert.equal(p.byPn.get("520000200").why, "quiet");
  const mins = [...p.byPn.values()].filter((v) => v.why === "quiet").map((v) => new Date(v.at).getUTCMinutes());
  assert.ok(new Set(mins).size >= 3, "الدقايق جوّه الساعة متوزّعة مش كلها :00");
  assert.deepEqual(Object.keys(p.window), ["start", "end", "startRiyadh", "endRiyadh", "fromHour", "nightCutoffHour", "leadMin", "spreadQuiet", "hours"]);
  assert.equal(p.window.endRiyadh, "2026-10-18 02:00");
  // نفس المدخلات ⇒ نفس الخطة (مفيش عشوائية)
  assert.deepEqual([...Hb.planJob({ rows, cfg: on(), now: NOW, hourCap: 60 }).byPn], [...p.byPn]);
});

test("planJob: سعة الساعة (maxPerHour / سقف القناة) بتمنع الهدوء من ساعة مليانة؛ اللي ساعته فاتت بيروح للهدوء؛ والتوزيع مقفول ⇒ ساعة الاحتياط", () => {
  const rows = [{ pn: "520000101", best_hour: 20 }, { pn: "520000102", best_hour: 20 }, { pn: "520000103", best_hour: 20 }, { pn: "520000104", best_hour: 12 },
    { pn: "520000201", best_hour: null }, { pn: "520000202", best_hour: null }, { pn: "520000203", best_hour: null }];
  const p = Hb.planJob({ rows, cfg: on({ maxPerHour: 2 }), now: NOW });
  assert.deepEqual([p.byHabit, p.noHour, p.passed], [3, 3, 1]);
  assert.deepEqual(p.hours.find((h) => h.hour === 18), { hour: 18, n: 3, byHabit: 3, fallback: 0 }, "٣ على العادة في ٦:٣٠ ≥ السعة ٢ ⇒ مفيش هدوء فيها");
  assert.deepEqual(p.hours.slice(0, 4).map((h) => h.n), [1, 1, 1, 1], "٤ صفوف هدوء (٣ من غير ساعة + ١ فاتت) على أول ٤ ساعات");
  assert.equal(p.byPn.get("520000104").why, "passed"); assert.ok(Date.parse(p.byPn.get("520000104").at) >= NOW);
  const cap1 = Hb.planJob({ rows: rows.slice(0, 3).concat(rows.slice(4)), cfg: on(), now: NOW, hourCap: 1 });
  assert.equal(cap1.hours.find((h) => h.hour === 18).fallback, 0, "سقف القناة لما maxPerHour = ٠");
  const cap0 = Hb.planJob({ rows: rows.slice(0, 3).concat(rows.slice(4)), cfg: on({ spreadQuiet: true }), now: NOW, hourCap: 0 });
  assert.equal(cap0.hours.find((h) => h.hour === 18).fallback, 0, "من غير سعة: أقل حمولة برضه مش ساعة العادة");
  const full = Hb.planJob({ rows: [...Array(20).keys()].map((i) => ({ pn: `5200003${String(i).padStart(2, "0")}`, best_hour: null })), cfg: on({ maxPerHour: 1 }), now: NOW });
  assert.equal(full.hours.reduce((a, h) => a + h.n, 0), 20, "كل الساعات وصلت السعة ⇒ بنكمّل على الأقل حمولة (مفيش صف بيضيع)");
  const fb = Hb.planJob({ rows: rows.slice(4), cfg: on({ spreadQuiet: false, fallbackHour: 17 }), now: NOW });
  assert.ok([...fb.byPn.values()].every((v) => Date.parse(v.at) === RY("2026-10-17T17:00:00")));
  const fbPassed = Hb.planJob({ rows: rows.slice(4), cfg: on({ spreadQuiet: false, fallbackHour: 17 }), now: RY("2026-10-17T18:00:00") });
  assert.ok([...fbPassed.byPn.values()].every((v) => Date.parse(v.at) === RY("2026-10-17T18:00:00")), "ساعة الاحتياط فاتت ⇒ من دلوقتي");
  const tail = Hb.planJob({ rows: rows.slice(4), cfg: on(), now: RY("2026-10-17T01:40:00") });      // ديل النافذة: ٢٠ دقيقة بس
  for (const v of tail.byPn.values()) { const t = Date.parse(v.at); assert.ok(t >= RY("2026-10-17T01:40:00") && t < RY("2026-10-17T02:00:00"), v.at); }
  assert.deepEqual(Hb.planJob({ rows: [], cfg: on(), now: NOW }).hours.map((h) => h.n), new Array(13).fill(0));
});

test("storedPlanHours: صفوف متخزّنة ⇒ شريط ساعات متتالي من أول ميعاد لآخر ميعاد", () => {
  const rows = [{ send_at: "2026-10-17T15:30:00Z", send_why: "habit" }, { send_at: new Date("2026-10-17T15:40:00Z"), send_why: "habit" }, { send_at: "2026-10-17T20:30:00Z", send_why: "quiet" }, { send_at: null }];
  const h = Hb.storedPlanHours(rows);
  assert.deepEqual(h.map((x) => x.hour), [18, 19, 20, 21, 22, 23]);
  assert.deepEqual(h[0], { hour: 18, n: 2, byHabit: 2, fallback: 0 }); assert.deepEqual(h[5], { hour: 23, n: 1, byHabit: 0, fallback: 1 });
  assert.deepEqual(Hb.storedPlanHours([]), []);
});

// ───────── المحرّك (قاعدة مزيّفة) ─────────
const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
const withEnv = (vals, fn) => async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const ALLOW = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
const GREEN = { phoneInfo: async () => ({ ok: true, status: "CONNECTED", quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, checkedAt: new Date(NOW).toISOString() }), templateInfo: async () => ({ ok: true, list: [] }) };
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, auth = "Bearer admin", param = {}, query = {} } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: (n) => query[n], param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });
const JOB = (x = {}) => ({ id: 1, status: "running", channel: "wa_cloud", cloud_template: "fc_frame_ask_text", cloud_vars: { values: { "offer.title": "بوكسات", "offer.line": "من 29 ر.س" } }, image_url: null, video_url: null,
  link_slug: "w1", offer: null, fallback: "none", spend_cap_sar: null, rate_sar: 0.2, brake_ack_at: null, name: "تجربة", start_at: null, started_at: null, held_at: null, created_at: new Date(NOW - H).toISOString(), ...x });
const Q = (id, x = {}) => ({ id, job_id: 1, phone_norm: `52000010${id}`, status: "pending", channel: "wa_cloud", name: "تجربة", link_code: `c${id}`, coupon: null, attempts: 0, vars: { first_name: "تجربة" }, send_at: null, send_why: null, hold_until: null, ...x });
const PEOPLE = { 520000101: 20, 520000102: 20, 520000103: null, 520000104: null };      // ساعة العادة لكل رقم (مصطنع)

/* العالم المزيّف: الطابور في الذاكرة والـclaim بيطبّق شرط send_at لو الاستعلام فيه الشرط (زي ما بوستجرس هيعمل) */
function world({ queue = [], jobs = [], byHabit = { enabled: true } } = {}) {
  const db = { jobs, queue, newJobs: [], queued: [], sql: [], settingsWrites: [], planUpdates: [], cleared: 0,
    settings: { waCloud: { enabled: true }, waSender: { startHour: 0, endHour: 24, byHabit }, waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, waBot: { testPhones: ["0544775000"] } } };
  const qrow = (id) => db.queue.find((q) => q.id === Number(id));
  const job = (id) => db.jobs.find((j) => Number(j.id) === Number(id));
  const pool = { connect: async () => ({ query: (s, p) => pool.query(s, p), release() {} }), async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return { rows: [{ stopped_reason: null, warmup: { step: 3, since: "2026-09-01", startedAt: "2026-09-01" } }] };
    if (/^INSERT INTO wa_send_jobs/i.test(s)) { db.newJobs.push(p); return { rows: [{ id: 77 }] }; }
    if (/^INSERT INTO wa_send_queue\(job_id, phone_norm, name, message, score, status, reason, link_code, coupon, vars, send_at, send_why\)/i.test(s)) {
      db.queued.push({ pn: p[1], status: p[5], send_at: p[10], send_why: p[11] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running'/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "running") };
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) {
      const guard = /q\.send_at IS NULL OR q\.send_at <= NOW\(\)/.test(s);
      const cands = db.queue.filter((q) => q.status === "pending" && job(q.job_id)?.status === "running" && (!q.hold_until || Date.parse(q.hold_until) <= NOW) && (!guard || !q.send_at || Date.parse(q.send_at) <= NOW));
      cands.sort((a, b) => (a.send_at ? Date.parse(a.send_at) : -1) - (b.send_at ? Date.parse(b.send_at) : -1) || a.id - b.id);
      const q = cands[0]; if (!q) return { rows: [] }; q.status = "sending"; q.attempts = (q.attempts || 0) + 1; return { rows: [q] }; }
    if (/^UPDATE wa_send_jobs j SET status='done'/i.test(s)) { for (const j of db.jobs) if (j.status === "running" && !db.queue.some((q) => q.job_id === j.id && ["pending", "sending"].includes(q.status))) j.status = "done"; return { rows: [] }; }
    if (/^SELECT id, cloud_template, cloud_vars, image_url, video_url/i.test(s)) return { rows: [job(p[0])] };
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='sent'/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent", sent_at: new Date(NOW).toISOString() }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT id, name, channel, cloud_template, image_url, video_url, start_at, held_at FROM wa_send_jobs WHERE status='paused'/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "paused" && j.start_at && Date.parse(j.start_at) <= Date.parse(p[0])) };
    if (/^UPDATE wa_send_jobs SET status='running', started_at=COALESCE/i.test(s)) { const j = job(p[0]); if (!j || j.status !== "paused") return { rowCount: 0, rows: [] }; j.status = "running"; j.start_at = null; return { rowCount: 1, rows: [{ id: j.id }] }; }
    if (/^SELECT id, phone_norm FROM wa_send_queue WHERE job_id=\$1 AND status='pending'/i.test(s)) return { rows: db.queue.filter((q) => q.job_id === Number(p[0]) && q.status === "pending").map((q) => ({ id: q.id, phone_norm: q.phone_norm })) };
    if (/^UPDATE wa_send_queue q SET send_at = v\.at, send_why = v\.why FROM unnest/i.test(s)) { db.planUpdates.push(p); p[0].forEach((id, i) => { const q = qrow(id); if (q && q.status === "pending") { q.send_at = p[1][i]; q.send_why = p[2][i]; } }); return { rows: [], rowCount: p[0].length }; }
    if (/^UPDATE wa_send_queue SET send_at=NULL, send_why=NULL WHERE job_id=\$1/i.test(s)) { db.cleared++; for (const q of db.queue) if (q.job_id === Number(p[0]) && q.status === "pending") { q.send_at = null; q.send_why = null; } return { rows: [] }; }
    if (/^SELECT id, name, status, channel, start_at, started_at, created_at FROM wa_send_jobs WHERE id=\$1/i.test(s)) return { rows: job(p[0]) ? [job(p[0])] : [] };
    if (/^SELECT phone_norm, status, send_at, send_why, sent_at, replied_at, clicks FROM wa_send_queue WHERE job_id=\$1/i.test(s)) return { rows: db.queue.filter((q) => q.job_id === Number(p[0]) && q.status !== "holdout") };
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waSender\}'/i.test(s)) { db.settings.waSender = JSON.parse(p[0]); db.settingsWrites.push(db.settings.waSender); return { rows: [], rowCount: 1 }; }
    if (/^SELECT 1 FROM cms_links WHERE slug=\$1/i.test(s)) return { rows: [], rowCount: 0 };
    if (/AS invalid, \(SELECT count/i.test(s)) return { rows: [{ invalid: 0, replies7: 0, optouts7: 0 }] };
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.T${calls.length}` }] }) }; };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const people = Object.keys(PEOPLE);
  const rows = people.map((pn, i) => ({ pn, name: `تجربة ${i}`, orders: 3, spend: 100, daysAgo: 30, lastTotal: 60, score: 10 - i, vars: { first_name: `تجربة${i}` } }));
  const prof = { phones: async () => people, profilesFor: async (pns) => new Map(pns.filter((pn) => pn in PEOPLE).map((pn) => [pn, { phone_norm: pn, best_hour: PEOPLE[pn] }])),
    normalizeFilter: P.normalizeProfileFilter, match: P.matchProfile, resolveValues: P.resolveProfileValues, tokenContext: async () => ({}), recheckRow: async () => null };
  const outreach = { AUDIENCES: { lapsed: { label: "غايبين" } }, audienceRows: async () => rows, cfg: async () => ({ template: "أهلاً {name}" }) };
  const app = fakeApp();
  const api = S.register(app, ctx, { wa, fetch, outreach, cloudLoop: false, lock: false, now: () => NOW, cms: () => null, cloud: () => GREEN, profile: () => prof,
    sessionUser: async () => ({ name: "عمر", role: "owner" }) });
  return { db, app, api, calls };
}
const FRAME = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "بوكسات", "offer.line": "من 29 ر.س" } }, filters: { audience: "lapsed", limit: 50 }, confirmCount: 4 };

test("إنشاء الحملة والإعداد شغّال: كل صف بياخد send_at (على عادته أو في الهدوء) + preview.plan بالشريط؛ والإعداد مقفول ⇒ من غير مواعيد", withEnv(ALLOW, async () => {
  const w = world();
  const r = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...FRAME, name: "على عادة العميل" }, auth: "Bearer cms:own" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.db.queued.length, 4);
  const by = Object.fromEntries(w.db.queued.map((q) => [q.pn, q]));
  assert.deepEqual([by["520000101"].send_why, by["520000101"].send_at], ["habit", new Date(RY("2026-10-17T18:30:00")).toISOString()]);
  assert.equal(by["520000103"].send_why, "quiet"); assert.ok(Date.parse(by["520000103"].send_at) >= NOW);
  const plan = r.body.preview.plan;
  assert.deepEqual([plan.enabled, plan.total, plan.byHabit, plan.noHour, plan.outsideSenderHours], [true, 4, 2, 2, 0]);
  assert.equal(plan.hours.reduce((a, h) => a + h.n, 0), 4);
  assert.equal(plan.hours.find((h) => h.hour === 18).byHabit, 2);
  assert.ok(plan.window && plan.window.endRiyadh === "2026-10-18 02:00");
  assert.equal(w.calls.length, 0, "الإنشاء مابيبعتش حاجة");
  const off = world({ byHabit: { enabled: false } });
  const r2 = await call(off.app, "POST /api/cms/wa-sender/jobs", { json: { ...FRAME, name: "عادي" }, auth: "Bearer cms:own" });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(off.db.queued.every((q) => q.send_at === null && q.send_why === null));
  assert.deepEqual(r2.body.preview.plan, { enabled: false, hours: [], noHour: 0, window: null });
}));

test("الدورة: الصف اللي ميعاده جه بيتبعت، واللي ميعاده لسه مابيتاخدش، والحملة مابتتقفلش done طول ما فيه صف مستني", withEnv(ALLOW, async () => {
  const w = world({ jobs: [JOB()], queue: [Q(1, { send_at: new Date(NOW - H).toISOString(), send_why: "habit" }), Q(2, { send_at: new Date(NOW + 2 * H).toISOString(), send_why: "habit" }), Q(3)] });
  const r = await w.api.cloudTick();
  assert.equal(r.sent, 2, JSON.stringify(r));
  assert.deepEqual(w.db.queue.map((q) => q.status), ["sent", "pending", "sent"]);
  assert.equal(w.db.jobs[0].status, "running", "صف مستني ميعاده ⇒ الحملة لسه شغّالة");
  assert.equal(r.reason, "queue_empty");
  assert.equal(w.calls.length, 2);
  const claim = w.db.sql.find((s) => /^UPDATE wa_send_queue SET status='sending'/.test(s));
  assert.match(claim, /q\.send_at IS NULL OR q\.send_at <= NOW\(\)/); assert.match(claim, /q\.hold_until IS NULL OR q\.hold_until <= NOW\(\)/, "CJ1a لسه فوقه");
  assert.match(claim, /ORDER BY j\.id, q\.send_at NULLS FIRST, q\.score DESC/);
  const done = w.db.sql.find((s) => /^UPDATE wa_send_jobs j SET status='done'/.test(s));
  assert.match(done, /q\.status IN \('pending','sending'\)/, "الصف المستني pending ⇒ بيمنع done زي hold_until");
  // ميعاده جه بعدين ⇒ الدورة الجاية بتاخده
  w.db.queue[1].send_at = new Date(NOW - M).toISOString();
  const r2 = await w.api.cloudTick();
  assert.equal(r2.sent, 1); assert.equal(w.db.jobs[0].status, "done");
}));

test("البدء المجدول (startDueJobs): الحملة بتتخطّط لحظة بدئها الفعلي؛ والإعداد اتقفل ⇒ المواعيد القديمة بتتشال", withEnv(ALLOW, async () => {
  const w = world({ jobs: [JOB({ id: 5, status: "paused", start_at: new Date(NOW - M).toISOString(), name: "مجدولة" })],
    queue: [Q(1, { job_id: 5 }), Q(2, { job_id: 5 }), Q(3, { job_id: 5 }), Q(4, { job_id: 5, status: "sent" })] });
  const out = await w.api.startDueJobs();
  assert.deepEqual(out.started, [5], JSON.stringify(out));
  assert.deepEqual(out.planned, [{ id: 5, byHabit: 2, noHour: 1 }]);
  assert.equal(w.db.planUpdates.length, 1); assert.deepEqual(w.db.planUpdates[0][0], [1, 2, 3], "الصفوف pending بس");
  assert.deepEqual(w.db.queue.map((q) => q.send_why), ["habit", "habit", "quiet", null]);
  assert.equal(w.db.queue[0].send_at, new Date(RY("2026-10-17T18:30:00")).toISOString());
  const off = world({ byHabit: { enabled: false }, jobs: [JOB({ id: 6, status: "paused", start_at: new Date(NOW - M).toISOString() })],
    queue: [Q(1, { job_id: 6, send_at: new Date(NOW + H).toISOString(), send_why: "habit" })] });
  const o2 = await off.api.startDueJobs();
  assert.deepEqual(o2.started, [6]); assert.equal(off.db.cleared, 1); assert.equal(off.db.queue[0].send_at, null);
}));

test("GET …/jobs/:id/plan: الخطة المتخزّنة (شريط + مستنية + التالي)، أو معاينة بإعدادات دلوقتي للي لسه من غير مواعيد — قراءة بس", withEnv(ALLOW, async () => {
  const w = world({ jobs: [JOB(), JOB({ id: 9, name: "قديمة" })], queue: [
    Q(1, { send_at: new Date(RY("2026-10-17T18:30:00")).toISOString(), send_why: "habit" }), Q(2, { send_at: new Date(RY("2026-10-17T18:40:00")).toISOString(), send_why: "habit", status: "sent", sent_at: new Date(NOW - H).toISOString(), replied_at: new Date(NOW).toISOString() }),
    Q(3, { send_at: new Date(RY("2026-10-17T22:10:00")).toISOString(), send_why: "quiet" }), Q(4, { send_at: new Date(RY("2026-10-17T13:05:00")).toISOString(), send_why: "passed", status: "holdout" }),
    Q(5, { job_id: 9, phone_norm: "520000101" }), Q(6, { job_id: 9, phone_norm: "520000104" })] });
  const r = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/plan", { param: { id: "1" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.stored, r.body.total, r.body.byHabit, r.body.noHour, r.body.waiting, r.body.enabled], [true, 3, 2, 1, 2, true]);
  assert.deepEqual(r.body.hours.map((h) => [h.hour, h.n, h.byHabit, h.fallback]), [[18, 2, 2, 0], [19, 0, 0, 0], [20, 0, 0, 0], [21, 0, 0, 0], [22, 1, 0, 1]]);
  assert.equal(r.body.nextAtRiyadh, "2026-10-17 18:30"); assert.equal(r.body.window.startRiyadh, "2026-10-17 18:30");
  assert.deepEqual(r.body.sentHours, [{ hour: 12, n: 1, replied: 1, clicked: 0 }]);
  assert.ok(r.body.why.habit);
  const pv = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/plan", { param: { id: "9" } });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.deepEqual([pv.body.stored, pv.body.pending, pv.body.total, pv.body.byHabit, pv.body.noHour], [false, 2, 2, 1, 1]);
  assert.equal(pv.body.hours.reduce((a, h) => a + h.n, 0), 2);
  const off = world({ byHabit: { enabled: false }, jobs: [JOB({ id: 9 })], queue: [Q(5, { job_id: 9, phone_norm: "520000101" })] });
  const pv2 = await call(off.app, "GET /api/cms/wa-sender/jobs/:id/plan", { param: { id: "9" } });
  assert.deepEqual([pv2.body.stored, pv2.body.enabled, pv2.body.byHabit], [false, false, 1], "المعاينة بتشتغل حتى والإعداد مقفول (عشان المالك يشوف قبل ما يفتحه)");
  assert.equal((await call(w.app, "GET /api/cms/wa-sender/jobs/:id/plan", { param: { id: "404" } })).status, 404);
  assert.equal(w.calls.length, 0, "مفيش إرسال");
}));

test("الإعدادات من اللوحة: GET بيرجّع مخطط «الإيقاع» + القيم الحيّة في cfg.byHabit، وPOST بيدمج المفاتيح (مفتاح واحد مايمسحش الباقي) وبينضّف", withEnv(ALLOW, async () => {
  const w = world({ byHabit: {} });
  const g = await call(w.app, "GET /api/cms/wa-sender");
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.cfg.byHabit, Hb.habitCfg({}));
  assert.deepEqual(g.body.byHabit.groups, { rhythm: Hb.HABIT_GROUP_AR });
  assert.deepEqual(g.body.byHabit.settings.map((x) => x.key), Object.keys(Hb.HABIT_SCHEMA));
  assert.ok(g.body.byHabit.settings.every((x) => x.ar && x.help && x.groupAr && "default" in x && "value" in x));
  const p1 = await call(w.app, "POST /api/cms/wa-sender/settings", { json: { byHabit: { enabled: true } } });
  assert.equal(p1.status, 200); assert.deepEqual(p1.body.cfg.byHabit, { ...Hb.habitCfg({}), enabled: true });
  const p2 = await call(w.app, "POST /api/cms/wa-sender/settings", { json: { byHabit: { leadMin: 60, nightCutoffHour: 1 } } });
  assert.deepEqual(p2.body.cfg.byHabit, { ...Hb.habitCfg({}), enabled: true, leadMin: 60, nightCutoffHour: 1 }, "enabled فضل زي ما هو");
  assert.deepEqual(w.db.settingsWrites.at(-1).byHabit, p2.body.cfg.byHabit, "المتخزّن = المنضّف");
  const p3 = await call(w.app, "POST /api/cms/wa-sender/settings", { json: { byHabit: { leadMin: 10000 } } });
  assert.equal(p3.body.cfg.byHabit.leadMin, 240, "بره الحدود ⇒ للحد");
  const p4 = await call(w.app, "POST /api/cms/wa-sender/settings", { json: { dailyCap: 50 } });
  assert.equal(p4.body.cfg.byHabit.enabled, true, "حفظ إعداد تاني مابيمسحش الإيقاع");
}));
