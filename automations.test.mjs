/* AUTO1 — «مركز الأتمتة» (automations.js): القراية الموحّدة + الحفظ من المسارات الأصلية + الفلوهات الجديدة.
   كله على Hono حقيقي في الذاكرة: مسارات الموديولات الأصلية «مزيفة» بتسجّل الطلب وبس — مفيش داتابيز ولا شبكة ولا إرسال.
     node --test automations.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import * as auto from "./automations.js";
import { memStore } from "./autoflows.js";
import { sectionOf } from "./cms.js";

const SETTINGS = () => ({
  abandonedCarts: { enabled: true, smsEnabled: false, sms1AfterMinutes: 35 },
  openWait: { enabled: true, text: "فتحنا! {link}", capPerRun: 60 },
  waBot: { mode: "live", testPhones: ["0500000001"], reviewFlow: { enabled: true, deliveryMin: 30 } },
  waMaster: { enabled: true },
  waTeam: { enabled: true },
  cms: { campaigns: { smsEnabled: true, dailySmsCap: 900, quietStart: 22, quietEnd: 12 }, loyalty: { enabled: true, every: 3, startedAt: "2026-10-05T00:00:00Z", minTotal: 60 }, phoneLists: {} },
  delivery: { alertPhones: ["0500000002"], ackEscalation: { enabled: true } },
  adsGuard: { stopAll: false, window: { from: "11:30", to: "01:30" }, defaultCap: 400, revenueCap: { enabled: true, pct: 13, maxTotal: 3000 } },
  jobs: { "fc-adsentry": { enabled: true, label: "حارس الإعلانات" } },
  hours: { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "13:00", close: "02:00" }])) },
  notifications: { whatsappEnabled: true, whatsappStages: ["pos_created", "on_the_way"] },
});

function harness({ settings = SETTINGS(), cmsRows = [], innerOverride = {} } = {}) {
  const app = new Hono();
  const calls = [];           // كل طلب وصل لمسار أصلي (method, path, auth, body)
  const notes = [];
  const sqls = [];
  const sent = [];
  const token = (c) => String(c.req.header("Authorization") || "").replace(/^Bearer /, "");
  const ctx = {
    pool: { query: async (sql, p) => { sqls.push(String(sql)); if (/FROM cms_audit/.test(sql)) return { rows: [{ at: "2026-10-21T10:00:00Z", actor_name: "عمر", role: "owner", method: "PUT", path: "/api/carts/recovery", note: null }] }; return { rows: [], rowCount: 0 }; } },
    requireAdmin: async (c) => (["owner", "mkt", "ops", "mgr", "cashier"].includes(token(c)) ? null : c.json({ error: "Unauthorized" }, 401)),
    getSettingsData: async () => settings,
    isOwner: async (c) => token(c) === "owner",
    auditNote: async (c, n) => { notes.push(n); },
  };
  const PERMS = { marketing: { home: "view", growth: "edit", orders: "view", products: "edit", customers: "edit", discounts: "edit", delivery: "none", analytics: "view", finance: "none", settings: "none" },
    operations: { home: "view", growth: "none", orders: "edit", products: "view", customers: "view", discounts: "view", delivery: "edit", analytics: "view", finance: "none", settings: "none" } };
  const cms = {
    whoami: async (c) => ({ owner: { role: "owner", name: "المالك" }, mkt: { role: "marketing", name: "سارة" }, ops: { role: "operations", name: "أحمد" }, mgr: { role: "manager", name: "مدير الفرع" }, cashier: { role: "cashier", name: "الكاشير" } }[token(c)] || null),
    effectivePerms: async () => PERMS, sectionOf,
    segmentList: () => [{ id: "vip", label: "كبار العملاء" }, { id: "at_risk", label: "في خطر" }, { id: "dormant", label: "نايمين" }, { id: "lapsed_21", label: "غايب ٢١" }, { id: "second_nudge", label: "اطلب تاني" }],
    segmentPhones: async (id) => (id === "vip" ? ["500000011", "500000012", "500000013"] : []),
    autoGuard: async (ch, pns) => ({ ok: new Set(pns.filter((p) => p !== "500000013")), retry: new Set(), skipped: pns.includes("500000013") ? { opted_out: 1 } : {} }),
    autoProfiles: async (pns) => new Map(pns.map((p) => [p, { name: "خالد العتيبي", orders: 4, daysSinceLast: 10, spent: 1500 }])),
    autoLogSend: async (id, pn) => { sent.push({ ch: "log", id, pn }); },
    waFallbackSms: async ({ phoneNorm, text, ref }) => { sent.push({ ch: "sms", pn: phoneNorm, text, ref }); return { ok: true }; },
  };
  const notify = { sendToAudience: async (x) => { sent.push({ ch: "push", pn: x.phoneNorm, title: x.title, body: x.body, stage: x.stage }); return true; } };
  /* المسارات الأصلية (مزيفة): القراية بأشكال ردودها الحقيقية، والكتابة بتتسجّل */
  const rec = (m, p, res = { ok: true }) => app.on(m, p, async (c) => {
    let body = null; try { body = await c.req.json(); } catch { /* GET */ }
    calls.push({ m, path: c.req.path, auth: c.req.header("Authorization"), body });
    const o = innerOverride[`${m} ${p}`];
    if (o) return typeof o === "function" ? o(c, body) : c.json(o.body, o.status || 200);
    if (m !== "GET" && token(c) !== "owner" && /wabot|settings\/patch|campaign-settings|wa-send-hours/.test(c.req.path)) return c.json({ ok: false, error: "owner_only" }, 403);
    return c.json(typeof res === "function" ? res(c, body) : res);
  });
  rec("GET", "/api/carts/recovery", { ok: true, today: { abandoned: 4, abandonedValue: 380, push: 2, wa: 2, sms: 0, opened: 1, recovered: 1, revenue: 95, cost: 0.2 }, d7: { abandoned: 30, abandonedValue: 2900, push: 18, wa: 20, sms: 3, opened: 9, recovered: 6, revenue: 640, cost: 4.1 } });
  rec("GET", "/api/cms/flows", { ok: true, flows: cmsRows, sms: { enabled: true, dailyCap: 900, today: 10 } });
  rec("GET", "/api/cms/wa/templates", { ok: true, rows: [{ name: "fc_cart_1h", statuses: [{ status: "APPROVED" }] }, { name: "fc_cart_24h", statuses: [{ status: "REJECTED" }] }, { name: "fc_promo_dormant", statuses: [{ status: "APPROVED" }] }] });
  rec("GET", "/api/cms/openwait", { ok: true, stats: { joined_today: 3, waiting: 5, notified_today: 0, converted_7d: 4, notified_7d: 11, waitingValue: 640 } });
  rec("GET", "/api/cms/reviews/stats", { ok: true, invites: { sent: 40, rated: 22, avg: 4.6, toGoogle: 12, skipped: 9, replyRate: 0.55 }, viaWhatsapp: 30 });
  rec("GET", "/api/cms/loyalty", { ok: true, stats: { members: 120, rewardsIssued: 30, rewardsUsed: 11, eligibleSoon: 9, sms: { sent: 25, cost: 2.2, clicks: 7 } } });
  rec("GET", "/api/cms/wabot/followups", { ok: true, totals: { sent: 12, replied: 5, said_yes: 3, said_no: 1, stopped: 0, paid_orders: 2, paid_sar: 210 }, brake: { on: false } });
  rec("GET", "/api/cms/ack-escalations", { ok: true, stats: { steps: { 1: 9, 2: 3, 3: 1 }, stops: 8, errors: 0 }, rows: [{ order_no: "W123", step: 2, started_at: "2026-10-22T13:00:00Z", stop_reason: "acked" }] });
  rec("GET", "/api/cms/staff-alerts", { ok: true, totals: { n: 70, cost: 5.6, suppressed: 4, perDay: 10 } });
  rec("GET", "/api/cms/wabot/team", { ok: true, portal: { sentToday: 2, failedToday: 0, working: true, cashier: { open: true } } });
  rec("GET", "/api/cms/wabot/selfreview", { ok: true, runs: [{ day: "2026-10-21", found: 5, filed: 3, finished_at: "2026-10-22T01:40:00Z" }] });
  rec("GET", "/api/cms/revenue-pulse", { ok: true, log: [{ day: "2026-10-22", slot: "15:00", status: "sent", at: "2026-10-22T12:00:00Z" }] });
  rec("GET", "/api/cms/wa-health", { ok: true, alerts: [], log: [] });
  rec("GET", "/api/settings/ads-guard/status", { ok: true, updatedAt: new Date().toISOString(), lastRun: { spend: 120 }, platformStopped: {} });
  rec("GET", "/api/cms/wa-cloud/checklist", { ok: true, stages: [{ stage: "on_the_way", label: "مع المندوب", template: "fc_order_on_the_way", enabled: true, metaStatus: "PENDING" }] });
  rec("GET", "/api/cms/wa-cloud/utility-rewrites", { ok: true, rows: [] });
  rec("GET", "/api/cms/flows-runs", { ok: true, runs: [{ at: "2026-10-22T09:00:00Z", entrants: 4, sent: 3, holdout: 1 }] });
  for (const [m, p] of [["PUT", "/api/carts/recovery"], ["PUT", "/api/cms/openwait"], ["PUT", "/api/cms/wabot/config"], ["PUT", "/api/cms/wabot/team"], ["PUT", "/api/delivery/control"], ["PUT", "/api/cms/reviews/settings"],
    ["PUT", "/api/cms/loyalty"], ["PUT", "/api/cms/campaign-settings"], ["POST", "/api/cms/staff-alerts"], ["POST", "/api/settings/patch"], ["PUT", "/api/cms/flows/:id"], ["POST", "/api/cms/flows"],
    ["POST", "/api/cms/openwait/test"], ["POST", "/api/cms/flows/:id/test-send"], ["POST", "/api/shop/staff-sms/test"], ["POST", "/api/cms/wa-send-hours"]]) rec(m, p, m === "POST" && p === "/api/cms/flows" ? { ok: true, flow: { id: 77 } } : { ok: true });
  const store = memStore();
  const api = auto.register(app, ctx, { cms: () => cms, notify: () => notify, wa: () => null, staff: () => null, store, noTimer: true, now: () => new Date("2026-10-22T15:10:00Z") });
  const req = async (method, path, body, who = "owner") => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${who}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() };
  };
  const writes = () => calls.filter((x) => x.m !== "GET");
  return { app, req, calls, writes, notes, sqls, sent, store, api, settings };
}

const INVENTORY = ["carts", "openwait", "openfu", "reviews", "loyalty", "windowKeeper", "replyFollow", "leadFollow", "paidNote", "orderStages", "utilityFirst", "journeyBursts", "habit",
  "campaignRules", "waCampaignRules", "sendHours", "ackEscalation", "staffAlerts", "courierOps", "portalOffline", "handover", "selfReview", "revenuePulse", "waHealth", "portalSessions", "adsGuard"];

test("GET: كل الجرد موجود بحالته وعُقده وحقوله بأسماء عربي — ومفيش كتابة خالص", async () => {
  const h = harness();
  const r = await h.req("GET", "/api/cms/automations");
  assert.equal(r.status, 200);
  const ids = r.json.flows.map((f) => f.id);
  for (const id of INVENTORY) assert.ok(ids.includes(id), `ناقص ${id}`);
  assert.ok(ids.includes("job-fc-adsentry"), "المهام المجدولة من settings.jobs");
  assert.ok(ids.includes("cmsflow-new-second_nudge") && ids.includes("cmsflow-new-lapsed_21"), "اطلب تاني / استرجاع ٢١ لما مش متعملين");
  for (const f of r.json.flows) {
    assert.ok(f.nodes.length >= 1, `${f.id}: عُقد`);
    assert.ok(["on", "off", "test", "dormant", "partial", "error", "missing"].includes(f.status.state), `${f.id}: ${f.status.state}`);
    for (const fld of f.fields) assert.ok(fld.label && fld.label !== fld.path.split(".").pop(), `${f.id}: اسم ${fld.path}`);
  }
  assert.equal(h.writes().length, 0, "القراية مابتكتبش");
  assert.ok(!h.sqls.some((s) => /UPDATE settings/i.test(s)));
  assert.ok(r.json.calls === undefined);
  const carts = r.json.flows.find((f) => f.id === "carts");
  assert.equal(carts.values["abandonedCarts.sms1AfterMinutes"], 35);
  assert.equal(carts.metrics[0].converted, 6);
  assert.equal(carts.metrics[0].revenue, 640);
  assert.ok(carts.health.some((x) => /fc_cart_24h/.test(x.text)), "قالب مرفوض ⇒ تحذير");
  assert.ok(carts.fields.find((f) => f.path === "abandonedCarts.maxPerWeek").label.includes("أقصى"), "الاسم من CART_FIELDS");
  const os = r.json.flows.find((f) => f.id === "orderStages");
  assert.ok(os.health.some((x) => /PENDING/.test(x.text)), "مرحلة شغّالة وقالبها مش معتمد");
  assert.ok(os.fields.find((f) => f.path === "notifications.whatsappStages").readOnly, "مراحل واتساب للقراية بس (لها مسار تأكيد القالب)");
  assert.equal(r.json.globals.botMode, "live");
  assert.ok(r.json.builder.gallery.length >= 6);
  assert.ok(r.json.builder.templates.includes("fc_promo_dormant"));
  assert.ok(!r.json.builder.templates.includes("fc_cart_24h"), "المرفوض مش في المعرض");
  // كل طلب داخلي بنفس التوكن
  assert.ok(h.calls.every((x) => x.auth === "Bearer owner"));
});

test("PATCH السلات: بيروح PUT /api/carts/recovery بالمفتاح اللي اتغيّر بس، وسطر سجل النشاط", async () => {
  const h = harness();
  const r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.sms1AfterMinutes": 40 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const w = h.writes();
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].m, w[0].path, w[0].body], ["PUT", "/api/carts/recovery", { sms1AfterMinutes: 40 }]);
  assert.equal(w[0].auth, "Bearer owner");
  assert.match(h.notes.at(-1), /^⚡ \[carts\] «السلات المتروكة»: الخطوة ١ بعد سكوت: 35 ← 40/);
  assert.ok(!h.sqls.some((s) => /UPDATE settings/i.test(s)), "مفيش كتابة مباشرة في الإعدادات");
});

test("PATCH: الحدود والنوع بيترفضوا قبل أي طلب، والمفتاح اللي مش من الفلو مرفوض", async () => {
  const h = harness();
  let r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.sms1AfterMinutes": 5 } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /من ٣٠ لـ٢٤٠/);
  r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "cms.campaigns.smsEnabled": true } });
  assert.equal(r.status, 400);
  r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.enabled": "yes" } });
  assert.equal(r.status, 400);
  r = await h.req("PATCH", "/api/cms/automations/orderStages", { changes: { "notifications.whatsappStages": [] } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /للقراية بس/);
  assert.equal(h.writes().length, 0);
});

test("التغيير الخطر محتاج تأكيد: ساعات الهدوء، تشغيل SMS، رفع سقف — وبعد التأكيد الجسم كامل زي ما المسار الأصلي مستنيه", async () => {
  const h = harness();
  let r = await h.req("PATCH", "/api/cms/automations/campaignRules", { changes: { "cms.campaigns.quietStart": 23 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.needConfirm, true);
  assert.equal(r.json.risky[0].from, 22);
  assert.equal(h.writes().length, 0);
  r = await h.req("PATCH", "/api/cms/automations/campaignRules", { changes: { "cms.campaigns.quietStart": 23 }, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const w = h.writes()[0];
  assert.equal(w.path, "/api/cms/campaign-settings");
  assert.deepEqual(w.body, { smsEnabled: true, dailySmsCap: 900, quietStart: 23 }, "smsEnabled والسقف بيتبعتوا دايماً (غير كده المسار بيقفل الـSMS)");
  r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.smsEnabled": true } });
  assert.equal(r.status, 409, "تشغيل SMS السلة");
  r = await h.req("PATCH", "/api/cms/automations/openwait", { changes: { "openWait.capPerRun": 30 } });
  assert.equal(r.status, 200, "تنزيل سقف مش خطر");
  r = await h.req("PATCH", "/api/cms/automations/openwait", { changes: { "openWait.capPerRun": 90 } });
  assert.equal(r.status, 409, "رفع سقف");
});

test("كل كاتب بشكل جسم مساره الأصلي: openwait كامل، الولاء كامل، البوت/الفريق متداخل، التوصيل patch، الإعلانات settings/patch", async () => {
  const h = harness();
  await h.req("PATCH", "/api/cms/automations/openwait", { changes: { "openWait.text": "فتحنا الحين {link}" } });
  let w = h.writes().at(-1);
  assert.equal(w.path, "/api/cms/openwait");
  assert.equal(w.body.text, "فتحنا الحين {link}");
  assert.equal(w.body.enabled, true, "الكائن كله (PUT بيبدّله)");
  assert.equal(w.body.capPerRun, 60);
  await h.req("PATCH", "/api/cms/automations/loyalty", { changes: { "cms.loyalty.every": 4 } });
  w = h.writes().at(-1);
  assert.equal(w.path, "/api/cms/loyalty");
  assert.equal(w.body.enabled, true, "enabled لازم يتبعت true (غير كده بيتقفل)");
  assert.equal(w.body.every, 4);
  assert.equal(w.body.minTotal, 60);
  assert.equal(w.body.startedAt, undefined, "startedAt بيتحسب في السيرفر");
  await h.req("PATCH", "/api/cms/automations/reviews", { changes: { "waBot.reviewFlow.deliveryMin": 45, "reviews.threshold": 5 }, confirm: true });
  const two = h.writes().slice(-2);
  assert.deepEqual(two.map((x) => x.path).sort(), ["/api/cms/reviews/settings", "/api/cms/wabot/config"]);
  assert.deepEqual(two.find((x) => x.path === "/api/cms/wabot/config").body, { reviewFlow: { deliveryMin: 45 } });
  await h.req("PATCH", "/api/cms/automations/portalOffline", { changes: { "waTeam.portalOffline.afterMin": 12 } });
  assert.deepEqual(h.writes().at(-1).body, { portalOffline: { afterMin: 12 } });
  await h.req("PATCH", "/api/cms/automations/ackEscalation", { changes: { "delivery.ackEscalation.escalateAfterSec": 120 } });
  assert.deepEqual(h.writes().at(-1).body, { patch: { "delivery.ackEscalation.escalateAfterSec": 120 } });
  await h.req("PATCH", "/api/cms/automations/adsGuard", { changes: { "adsGuard.revenueCap.pct": 12, "adsGuard.window.from": "12:00" }, confirm: true });
  assert.deepEqual(h.writes().at(-1).body, { changes: [{ path: "adsGuard.revenueCap", value: { pct: 12 } }, { path: "adsGuard.window.from", value: "12:00" }] });
  await h.req("PATCH", "/api/cms/automations/staffAlerts", { changes: { "staffAlerts.types.daily_report.enabled": false } });
  assert.deepEqual(h.writes().at(-1).body, { types: { daily_report: { enabled: false, mute: [], codes: {} } } });
});

test("رد المسار الأصلي بيرجع زي ما هو: رفض بالعربي، و409 confirm_required من لوحة التوصيل", async () => {
  const h = harness({ innerOverride: { "PUT /api/delivery/control": (c, b) => (b.confirm ? c.json({ ok: true }) : c.json({ ok: false, error: "confirm_required", message: "محتاج تأكيد" }, 409)),
    "PUT /api/carts/recovery": { status: 400, body: { ok: false, error: "invalid", message: "قيمة غلط من السيرفر" } } } });
  let r = await h.req("PATCH", "/api/cms/automations/ackEscalation", { changes: { "delivery.ackEscalation.maxAgeMin": 40 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.needConfirm, true);
  r = await h.req("PATCH", "/api/cms/automations/ackEscalation", { changes: { "delivery.ackEscalation.maxAgeMin": 40 }, confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(h.writes().at(-1).body.confirm, ["delivery.ackEscalation.maxAgeMin"]);
  r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.minSubtotal": 20 } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /«السلات المتروكة» رفض الحفظ: قيمة غلط من السيرفر/);
});

/* ⚡ AUTO2 (٢٢/١٠): قرار عمر «الاتمتة تفضل ظاهرة ليا انا بس» — كل المسارات للمالك بس، قراية وتعديل */
const ROUTES = [
  ["GET", "/api/cms/automations"], ["GET", "/api/cms/automations/carts"],
  ["PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.minSubtotal": 20 } }],
  ["POST", "/api/cms/automations/carts/pause", {}], ["POST", "/api/cms/automations/carts/resume", { confirm: true }],
  ["POST", "/api/cms/automations/bulk", { ids: ["carts"], action: "pause" }],
  ["POST", "/api/cms/automations/openwait/test", { phone: "0500000001" }],
  ["POST", "/api/cms/automations/custom", { name: "x", def: { trigger: { type: "segment_entry", segment: "vip" }, steps: [] } }],
  ["PUT", "/api/cms/automations/custom/auto-1", { name: "y" }], ["DELETE", "/api/cms/automations/custom/auto-1"],
  ["POST", "/api/cms/automations/custom/preview", { def: { trigger: { type: "segment_entry", segment: "vip" }, steps: [] } }],
  ["POST", "/api/cms/automations/from-template", { template: "vip-thursday" }],
];

for (const who of ["mkt", "ops", "mgr", "cashier"]) {
  test(`AUTO2: مركز الأتمتة للمالك بس — «${who}» بياخد 403 بالعربي على كل مسار، ومن غير أي كتابة ولا قراية من الموديولات`, async () => {
    const h = harness();
    await h.store.createFlow({ name: "موجود", icon: "✨", def: { trigger: { type: "segment_entry", segment: "vip" }, steps: [] } });
    for (const [m, p, body] of ROUTES) {
      const r = await h.req(m, p, body, who);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error, "owner_only");
      assert.equal(r.json.message, "مركز الأتمتة للمالك بس");
    }
    assert.equal(h.calls.length, 0, "مفيش ولا طلب وصل لأي مسار أصلي");
    assert.equal(h.notes.length, 0, "مفيش سطر نشاط");
    assert.equal(h.store._s.flows.length, 1, "مفيش فلو اتعمل");
    assert.equal(h.store._s.flows[0].archived ?? false, false, "مفيش أرشفة");
  });
}

test("AUTO2: من غير تسجيل دخول ⇒ 401 زي ما هو (requireAdmin الأول)", async () => {
  const h = harness();
  const r = await h.req("GET", "/api/cms/automations", undefined, "nobody");
  assert.equal(r.status, 401);
});

test("AUTO2: المالك بيقرا ويعدّل عادي — وكل الحقول قابلة للتعديل وأرقام التجربة ظاهرة", async () => {
  const h = harness();
  const g = await h.req("GET", "/api/cms/automations");
  assert.equal(g.status, 200);
  assert.equal(g.json.access.owner, true);
  assert.ok(g.json.flows.find((f) => f.id === "carts").fields.every((f) => f.editable));
  assert.ok(g.json.testPhones.length > 0);
  const d = await h.req("GET", "/api/cms/automations/carts");
  assert.equal(d.status, 200);
  const r = await h.req("PATCH", "/api/cms/automations/carts", { changes: { "abandonedCarts.minSubtotal": 20 } });
  assert.equal(r.status, 200);
  assert.equal(h.writes().at(-1).auth, "Bearer owner");
});

test("إيقاف/تشغيل وتجميعي: الإيقاف من غير تأكيد، التشغيل محتاج تأكيد، والحارس المعكوس (إيقاف كل الإعلانات)", async () => {
  const h = harness();
  let r = await h.req("POST", "/api/cms/automations/carts/pause", {});
  assert.equal(r.status, 200);
  assert.deepEqual(h.writes().at(-1).body, { enabled: false });
  r = await h.req("POST", "/api/cms/automations/openwait/resume", {});
  assert.equal(r.status, 200, "شغّال أصلاً ⇒ مفيش تأكيد");
  const h2 = harness({ settings: { ...SETTINGS(), openWait: { enabled: false } } });
  r = await h2.req("POST", "/api/cms/automations/openwait/resume", {});
  assert.equal(r.status, 409);
  r = await h2.req("POST", "/api/cms/automations/openwait/resume", { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(h2.writes().at(-1).body.enabled, true);
  r = await h.req("POST", "/api/cms/automations/adsGuard/pause", { confirm: true });
  assert.deepEqual(h.writes().at(-1).body, { changes: [{ path: "adsGuard.stopAll", value: true }] }, "إيقاف الحارس = stopAll true");
  r = await h.req("POST", "/api/cms/automations/bulk", { ids: ["carts", "windowKeeper", "leadFollow"], action: "pause" });
  assert.equal(r.json.results.find((x) => x.id === "leadFollow").ok, false, "مالوش مفتاح واحد");
  assert.ok(r.json.results.find((x) => x.id === "windowKeeper").ok);
});

test("«جرّب على موبايلي»: رقم مش من الفريق/التجربة ⇒ مرفوض ومفيش طلب؛ رقم الفريق ⇒ مسار التجربة الأصلي", async () => {
  const h = harness();
  let r = await h.req("POST", "/api/cms/automations/openwait/test", { phone: "0599999999" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "not_test_phone");
  assert.equal(h.writes().length, 0);
  r = await h.req("POST", "/api/cms/automations/openwait/test", { phone: "0500000001" });
  assert.equal(r.status, 200);
  assert.deepEqual([h.writes().at(-1).path, h.writes().at(-1).body], ["/api/cms/openwait/test", { phone: "500000001" }]);
  r = await h.req("POST", "/api/cms/automations/windowKeeper/test", { phone: "0500000001" });
  assert.equal(r.status, 400, "مالوش تجربة هنا");
  r = await h.req("POST", "/api/cms/automations/staffAlerts/test", {});
  assert.equal(r.status, 200, "تجربة لأرقام الإدارة المتسجّلة (مش لأي رقم)");
  assert.equal(h.writes().at(-1).path, "/api/shop/staff-sms/test");
  assert.ok(h.sent.length === 0, "مفيش إرسال حقيقي");
});

test("أتمتة الشرائح (cms_flows): الصفوف بتظهر بأرقامها والأثر، والتشغيل = PUT {active} بس، والقالب الكلاسيك بيعمل صف مقفول", async () => {
  const rows = [{ id: 5, name: "اطلب تاني", segment: "second_nudge", channel: "sms", message: "شكراً {link}", active: false, holdout_pct: 10,
    stats: { sent: { n: 60, cost: 4.5, clicked: 9, ordered7: 12, rev7: 1300, optouts: 1, delivered: 55 }, holdout: { n: 22, ordered7: 2 }, lift7: 11.9, liftReliable: true, failed: 0, dlrAvailable: true } }];
  const h = harness({ cmsRows: rows });
  const g = await h.req("GET", "/api/cms/automations");
  const f = g.json.flows.find((x) => x.id === "cmsflow-5");
  assert.equal(f.metrics[0].lift.pct, 11.9);
  assert.equal(f.metrics[0].converted, 12);
  assert.ok(!g.json.flows.some((x) => x.id === "cmsflow-new-second_nudge"), "متعمل ⇒ مايظهرش «مش متعمل»");
  let r = await h.req("POST", "/api/cms/automations/cmsflow-5/resume", {});
  assert.equal(r.status, 409);
  r = await h.req("POST", "/api/cms/automations/cmsflow-5/resume", { confirm: true });
  assert.deepEqual([h.writes().at(-1).path, h.writes().at(-1).body], ["/api/cms/flows/5", { active: true }]);
  r = await h.req("PATCH", "/api/cms/automations/cmsflow-5", { changes: { "cmsFlows.5.message": "وحشتنا {link}" } });
  assert.equal(h.writes().at(-1).body.message, "وحشتنا {link}");
  assert.equal(h.writes().at(-1).body.segment, "second_nudge", "الصف كله + التغيير");
  r = await h.req("POST", "/api/cms/automations/from-template", { template: "classic-lapsed_21" });
  assert.equal(r.status, 200);
  assert.equal(h.writes().at(-1).path, "/api/cms/flows");
  assert.equal(h.writes().at(-1).body.segment, "lapsed_21");
  assert.equal(h.writes().at(-1).body.active, undefined, "بيتعمل مقفول");
});

test("الفلوهات الجديدة: من قالب ⇒ مقفول؛ التشغيل للمالك بتأكيد؛ المحرّك بيبعت بالمرسلين والحراس المزيفين بس", async () => {
  const h = harness();
  let r = await h.req("POST", "/api/cms/automations/from-template", { template: "vip-thursday" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id;
  assert.equal(h.store._s.flows[0].active, false, "مقفول افتراضياً");
  r = await h.req("PATCH", `/api/cms/automations/${id}`, { changes: { [`auto.${id.slice(5)}.active`]: true } }, "mkt");
  assert.equal(r.status, 403, "التشغيل للمالك");
  r = await h.req("PATCH", `/api/cms/automations/${id}`, { changes: { [`auto.${id.slice(5)}.active`]: true } });
  assert.equal(r.status, 409);
  r = await h.req("PATCH", `/api/cms/automations/${id}`, { changes: { [`auto.${id.slice(5)}.active`]: true }, confirm: true });
  assert.equal(r.status, 200);
  assert.match(h.notes.at(-1), /اتشغّل/);
  // الخميس ١٨:١٠ الرياض = جوه خانة ١٧:٠٠
  const out = await h.api.engine().tick("test");
  assert.equal(out.flows, 1);
  const push = h.sent.filter((x) => x.ch === "push");
  assert.deepEqual(push.map((x) => x.pn).sort(), ["500000011", "500000012"]);
  assert.ok(push.every((x) => /خالد/.test(x.body)), "{name} من الملف");
  assert.ok(!push.some((x) => x.pn === "500000013"), "الحارس شال الموقِف");
  assert.ok(h.sent.some((x) => x.ch === "log"), "الإرسال بيتسجّل في الفاصل (cms_flow_log)");
  const g = await h.req("GET", `/api/cms/automations/${id}`);
  assert.ok(g.json.flow.metrics[0].sent.push >= 1);
  assert.ok(g.json.log.length >= 1);
  assert.ok(g.json.activity.length >= 1, "سجل النشاط");
});

test("الفلو الجديد: التحقق والمعاينة والتجربة (رقم فريق بس) والأرشفة", async () => {
  const h = harness();
  let r = await h.req("POST", "/api/cms/automations/custom", { name: "تجربة SMS", def: { trigger: { type: "segment_entry", segment: "nope" }, steps: [{ type: "send", channel: "sms", text: "اهلا {name}" }] } });
  assert.equal(r.status, 200);
  assert.ok(r.json.errors.some((e) => e.path === "trigger.segment"), "المسودة بتتحفظ والغلطة بترجع");
  const id = r.json.id;
  r = await h.req("PATCH", `/api/cms/automations/${id}`, { changes: { [`auto.${id.slice(5)}.active`]: true }, confirm: true });
  assert.equal(r.status, 400, "مايتشغّلش وفيه غلطة");
  r = await h.req("PUT", `/api/cms/automations/custom/${id}`, { def: { trigger: { type: "segment_entry", segment: "vip" }, steps: [{ type: "send", channel: "sms", text: "اهلا {name}" }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.errors, []);
  r = await h.req("POST", "/api/cms/automations/custom/preview", { def: { trigger: { type: "segment_entry", segment: "vip" }, steps: [{ type: "send", channel: "push", text: "x" }] } });
  assert.equal(r.json.segmentSize, 3);
  assert.match(r.json.note, /نقطة بداية/);
  r = await h.req("POST", `/api/cms/automations/${id}/test`, { phone: "0598765432" });
  assert.equal(r.status, 400);
  assert.equal(h.sent.length, 0);
  r = await h.req("POST", `/api/cms/automations/${id}/test`, { phone: "0500000002" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(h.sent[0].ch, "sms");
  assert.match(h.sent[0].ref, /:test$/);
  assert.ok(!h.sent.some((x) => x.ch === "log"), "التجربة مابتتحسبش في الفاصل");
  r = await h.req("DELETE", `/api/cms/automations/custom/${id}`);
  assert.equal(r.status, 200);
  const g = await h.req("GET", "/api/cms/automations");
  assert.ok(!g.json.flows.some((f) => f.id === id), "مؤرشف");
});

test("الأدوات: planWrites بيجمّع حسب الكاتب، والمسار المجهول بيترفض، وعدد الكتّاب يغطي كل حقول الكتالوج", () => {
  const s = SETTINGS();
  const p = auto.planWrites({ "abandonedCarts.minSubtotal": 10, "abandonedCarts.cooldownDays": 5, "waBot.windowKeeperHour": 21, "x.y": 1 }, s);
  assert.deepEqual(p.unknown, ["x.y"]);
  assert.equal(p.plan.length, 2);
  assert.deepEqual(p.plan[0].req.body, { minSubtotal: 10, cooldownDays: 5 });
  for (const f of auto.CATALOG) for (const path of f.fields) {
    const spec = auto.fieldSpec(path);
    if (spec.readOnly) continue;
    assert.ok(auto.writerFor(path), `${f.id}: ${path} مالوش كاتب`);
  }
});
