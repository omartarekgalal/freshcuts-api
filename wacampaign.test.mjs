/* حملات واتساب على قناة Cloud (١٣/١٠): قوالب عامة + فيديو + تكلفة + سقف صرف + فرامل + تجربة + المالك بس
   node --test wacampaign.test.mjs — قاعدة وهمية وfetch وهمي؛ مفيش شبكة حقيقية ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);
C.registerCampaignTemplates();

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
function withEnv(vals, fn) {
  return async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}
const CONFIGURED = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const ALLOW = { ...CONFIGURED, WHATSAPP_ENABLED: "1" };
const IMG = "https://freshcuts-api.o2m8.me/api/content/media/1.jpg", VID = "https://freshcuts-api.o2m8.me/api/content/media/9.mp4";
const HOSTS = ["freshcuts-api.o2m8.me", "freshcuts.sa"];
const TESTER = "544775082", AT_17 = Date.parse("2026-10-13T14:00:00Z");      // ١٧:٠٠ الرياض
/* QP1: الدورة بقت بتقرا جودة الرقم قبل أي إرسال (من غيرها مفيش تسويق) وبتمشي على سلّم تسخين. الاختبارات القديمة دي عن حاجات تانية،
   فبتشتغل برقم جودته GREEN وسلّم خلصان (السقف اليومي هو اللي حاكم). البوابة والسلّم نفسهم في waquality.test.mjs. */
const GREEN_CLOUD = { phoneInfo: async () => ({ ok: true, status: "CONNECTED", quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, checkedAt: new Date(AT_17).toISOString() }),
  templateInfo: async () => ({ ok: true, list: [] }) };
const WARM_DONE = { step: 3, since: "2026-09-01", startedAt: "2026-09-01" };

// ───────── دوال صافية ─────────
test("الإعدادات: السقف اليومي ٢٠٠، سقف الصرف ٥٠، والفرامل ٢٪ «إيقاف» / ١٠٪ فشل بعد ٣٠ (QP1) — وكلها بتتظبط لو اتكتبت غلط", () => {
  const d = C.cloudCfg({});
  assert.deepEqual([d.enabled, d.dailyCap, d.spendDaySar, d.brakeMinSends, d.brakeStopPct, d.brakeFailPct, d.tierLimit, d.reserveUtility], [false, 200, 50, 30, 2, 10, 250, 50]);
  const x = C.cloudCfg({ waCloud: { dailyCap: 120, spendDaySar: "12.345", brakeMinSends: 1, brakeStopPct: 0, brakeFailPct: 500 } });
  assert.deepEqual([x.dailyCap, x.spendDaySar, x.brakeMinSends, x.brakeStopPct, x.brakeFailPct], [120, 12.35, 5, 0.5, 100]);
  assert.equal(C.cloudCfg({ waCloud: { spendDaySar: 0 } }).spendDaySar, 0);
  for (const k of ["spendDaySar", "brakeMinSends", "brakeStopPct", "brakeFailPct"]) assert.ok(C.CLOUD_KEYS.includes(k), k);
});

test("الإيقاع: سقف الصرف اليومي بيوقّف وبيحدّ عدد الدورة؛ من غير سعر معروف مفيش سقف صرف", () => {
  const cc = { ...C.cloudCfg({ waCloud: { enabled: true } }) };
  assert.deepEqual(C.cloudPacing(cc, { today: 0, lastHour: 0, uniq24h: 0, rateSar: 0.2159 }, true), { allow: 5, reason: null });
  assert.equal(C.cloudPacing(cc, { today: 231, rateSar: 0.2159 }, true).reason, "daily_cap");          // ٢٠٠ في اليوم قبل الفلوس
  const c2 = { ...cc, dailyCap: 1000, tierLimit: 5000 };
  assert.deepEqual(C.cloudPacing(c2, { today: 229, rateSar: 0.2159 }, true), { allow: 2, reason: null });   // ٥٠ ÷ ٠٫٢١٥٩ = ٢٣١ رسالة
  assert.equal(C.cloudPacing(c2, { today: 231, rateSar: 0.2159 }, true).reason, "spend_cap");
  assert.equal(C.cloudPacing({ ...c2, spendDaySar: 0 }, { today: 0, rateSar: 0.2159 }, true).reason, "spend_cap");
  assert.equal(C.cloudPacing(c2, { today: 900 }, true).allow, 5);
  assert.equal(C.cloudPacing(cc, { today: 0, rateSar: 0.2159, stoppedReason: "payment_issue" }, true).reason, "stopped");
});

test("الفرامل: مش قبل الحد الأدنى من المحاولات، وبعدها نسبة الفشل أو نسبة «إيقاف» (بالحدود القديمة ٢٠ / ٥٪ مكتوبة صريح)", () => {
  const cc = C.cloudCfg({ waCloud: { brakeMinSends: 20, brakeStopPct: 5 } });
  assert.equal(C.brakeCheck({ sent: 10, failed: 9, stopped: 9 }, cc), null);
  assert.deepEqual(C.brakeCheck({ sent: 18, failed: 2, stopped: 0 }, cc), { reason: "fail_rate", pct: 10, limit: 10 });
  assert.equal(C.brakeCheck({ sent: 19, failed: 1, stopped: 0 }, cc), null);
  assert.deepEqual(C.brakeCheck({ sent: 40, failed: 0, stopped: 2 }, cc), { reason: "stop_rate", pct: 5, limit: 5 });
  assert.equal(C.brakeCheck({ sent: 40, failed: 0, stopped: 1 }, cc), null);
  assert.equal(C.brakeCheck({ sent: 30, failed: 5, stopped: 9 }, cc).reason, "fail_rate");     // الفشل أولاً
  assert.equal(C.brakeCheck(null, cc), null);
});

test("حدود الوسائط بتاعة ميتا: النوع والحجم قبل أي إرسال", () => {
  assert.equal(C.mediaProblem("image", { mime: "image/jpeg", bytes: 400000 }), null);
  assert.equal(C.mediaProblem("video", { mime: "video/mp4; codecs=avc1", bytes: 15 * 1048576 }), null);
  assert.equal(C.mediaProblem("video", { mime: "video/quicktime", bytes: 1000 })[0], "media_type");
  assert.equal(C.mediaProblem("video", { mime: "video/mp4", bytes: 17 * 1048576 })[0], "media_too_big");
  assert.match(C.mediaProblem("video", { mime: "video/mp4", bytes: 17 * 1048576 })[1], /١٦ ميجا/);
  assert.equal(C.mediaProblem("image", { mime: "image/png", bytes: 6 * 1048576 })[0], "media_too_big");
  assert.equal(C.mediaProblem("image", { mime: "image/webp", bytes: 10 })[0], "media_type");
  assert.equal(C.mediaProblem("image", { mime: "image/png" })[0], "media_size_unknown");
});

test("قوالب الحملة: القديمة، الفيديو، وقوالب الكتالوج اليدوية بس — وكل واحد بخاناته", () => {
  const names = C.campaignTemplateNames();
  for (const n of ["fc_offer_img", "fc_offer_video", "fc_winback", "fc_weekend_offer", "fc_bundle_offer", "fc_new_item"]) assert.ok(names.includes(n), n);
  for (const n of ["fc_cart_1h", "fc_loyalty_progress", "fc_fav_dish", "fc_winback_45", "fc_order_received", "fc_otp"]) assert.equal(C.campaignSpec(n), null, n);   // آلي / سلة / خدمي / تحقق
  assert.deepEqual(C.CAMPAIGN_TEMPLATES().sort(), ["fc_offer_img", "fc_winback"]);       // القايمة القديمة ما اتغيّرتش
  const w = C.campaignSpec("fc_weekend_offer");
  assert.deepEqual([w.kind, w.header, w.button, w.needsCoupon, w.fields.map((f) => f.key)], ["catalog", "image", "link", false, ["offer.title", "offer.price", "offer.untilText"]]);
  const v = C.campaignSpec("fc_offer_video");
  assert.deepEqual([v.kind, v.header, v.button, v.fields.map((f) => f.key), v.auto], ["legacy", "video", "link", ["offer"], ["name"]]);
  assert.equal(C.campaignSpec("fc_winback").needsCoupon, true);
  assert.equal(W.TEMPLATES.fc_offer_video.category, "MARKETING");
});

test("باراميترات كل مستلم: قيم الحملة + الاسم + الرابط المتتبّع، والهيدر صورة أو فيديو", () => {
  const job = { link_slug: "w9", image_url: IMG, cloud_vars: { values: { "offer.title": "باقة تجمّع", "offer.price": "225", "offer.untilText": "السبت" } } };
  const r = C.campaignParams("fc_weekend_offer", { name: "محمد علي", link_code: "ab12cd" }, job);
  assert.deepEqual(r.params.body, ["باقة تجمّع", "225", "السبت"]); assert.deepEqual(r.params.button, ["w9-ab12cd"]); assert.deepEqual(r.params.header, { image: IMG });
  assert.equal(W.paramProblem("fc_weekend_offer", r.params), null);
  assert.match(r.text, /باقة تجمّع بـ225 ر\.س، والعرض لين السبت/);
  const pay = W.buildTemplatePayload("fc_weekend_offer", "966512345678", r.params);
  assert.deepEqual(pay.template.components[0], { type: "header", parameters: [{ type: "image", image: { link: IMG } }] });
  // قيمة ناقصة ⇒ الحارس مابيبعتش نص ناقص
  const miss = C.campaignParams("fc_weekend_offer", { name: "س", link_code: "x1" }, { link_slug: "w9", image_url: IMG, cloud_vars: { values: { "offer.title": "باقة" } } });
  assert.match(W.paramProblem("fc_weekend_offer", miss.params), /^missing:/);
  // فيديو
  const vp = C.campaignParams("fc_offer_video", { vars: { first_name: "سارة" }, link_code: "zz99aa" }, { link_slug: "w12", video_url: VID, cloud_vars: { offer: "بوكس التشكيلة بـ105 ريال" } });
  assert.deepEqual(vp.params, { header: { video: VID }, body: ["سارة", "بوكس التشكيلة بـ105 ريال"], button: ["w12-zz99aa"] });
  assert.deepEqual(W.buildTemplatePayload("fc_offer_video", "966512345678", vp.params).template.components[0], { type: "header", parameters: [{ type: "video", video: { link: VID } }] });
  assert.equal(W.paramProblem("fc_offer_video", vp.params), null);
});

test("فحص الحملة قبل ما تتعمل: قالب، صورة/فيديو، كوبون، وكل خانة مكتوبة في سطر واحد", () => {
  const P = (x) => (C.cloudJobProblem(x) || [null])[0];
  assert.equal(P({ cloudTemplate: "fc_cart_1h" }), "bad_template");
  assert.equal(P({ cloudTemplate: "fc_weekend_offer", cloudVars: {} }), "image_required");
  assert.equal(P({ cloudTemplate: "fc_weekend_offer", imageUrl: IMG, cloudVars: { values: { "offer.title": "باقة" } } }), "value_required");
  assert.equal(P({ cloudTemplate: "fc_weekend_offer", imageUrl: IMG, cloudVars: { values: { "offer.title": "باقة\nسطر", "offer.price": "225", "offer.untilText": "السبت" } } }), "value_newline");
  assert.equal(P({ cloudTemplate: "fc_weekend_offer", imageUrl: IMG, cloudVars: { values: { "offer.title": "ب".repeat(201), "offer.price": "225", "offer.untilText": "السبت" } } }), "value_long");
  assert.equal(P({ cloudTemplate: "fc_weekend_offer", imageUrl: IMG, cloudVars: { values: { "offer.title": "باقة", "offer.price": "225", "offer.untilText": "السبت" } } }), null);
  assert.equal(P({ cloudTemplate: "fc_offer_video", cloudVars: { offer: "عرض" } }), "video_required");
  assert.equal(P({ cloudTemplate: "fc_offer_video", videoUrl: VID, cloudVars: { offer: "" } }), "offer_line_required");
  assert.equal(P({ cloudTemplate: "fc_offer_video", videoUrl: VID, cloudVars: { offer: "عرض" } }), null);
  assert.equal(P({ cloudTemplate: "fc_winback", cloudVars: {} }), "coupon_required");
  assert.equal(P({ cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "كيلو بـ96" } }), null);        // القديم زي ما هو
});

test("إدخال الحملة: قيم المتغيّرات، الفيديو من دوميناتنا بس، وسقف صرف الحملة", () => {
  const ok = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_video", videoUrl: VID, cloudVars: { offer: " عرض الليلة ", values: { "offer.title": " باقة ", "bad key!": "x" } }, spendCapSar: "25.5" }, { hosts: HOSTS });
  assert.deepEqual(ok.errs, []); assert.equal(ok.videoUrl, VID); assert.equal(ok.spendCapSar, 25.5);
  assert.deepEqual(ok.cloudVars, { offer: "عرض الليلة", values: { "offer.title": "باقة" } });
  assert.equal(S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_video", videoUrl: "https://evil.example/v.mp4", cloudVars: { offer: "x" } }, { hosts: HOSTS }).errs[0][0], "bad_video");
  assert.equal(S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "x" }, spendCapSar: -3 }, { hosts: HOSTS }).errs[0][0], "bad_spend_cap");
  assert.equal(S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "x" } }, { hosts: HOSTS }).spendCapSar, null);
  assert.equal(S.jobInput({ channel: "wa_web", spendCapSar: 10 }, { hosts: HOSTS }).spendCapSar, null);              // سقف الصرف لحملات Cloud بس
  assert.equal(C.campaignCost(187, 0.2159), 40.37); assert.equal(C.campaignCost(10, 0), null);
});

// ───────── المسارات والدورة ─────────
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, param = {}, auth = "Bearer admin" } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: () => undefined, param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });

function world({ jobs = [], queue = [], settings = {}, sentToday = 0, links = ["wa-test"], people = 3, media = { mime: "image/jpeg", bytes: 300000 }, inbound = [TESTER] } = {}) {
  const db = { jobs, queue, settings: { waCloud: { enabled: true }, waSender: {}, waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, waBot: { testPhones: ["0" + TESTER] }, ...settings },
    newJobs: [], newLinks: [], optins: {}, msgs: [], sql: [] };
  const job = (id) => db.jobs.find((j) => j.id === Number(id));
  const qrow = (id) => db.queue.find((q) => q.id === Number(id));
  const pool = { db, connect: async () => ({ query: (s, p) => pool.query(s, p), release() {} }), async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return { rows: [{ stopped_reason: null, warmup: WARM_DONE }] };
    if (/FROM wa_send_queue WHERE status='sent' AND sent_at > NOW\(\) - INTERVAL '2 days'/i.test(s)) return { rows: [{ today: sentToday + db.queue.filter((q) => q.status === "sent" && q._now).length, last_hour: 0 }] };
    if (/^SELECT count\(DISTINCT phone_norm\)::int AS n FROM wa_messages/i.test(s)) return { rows: [{ n: 0 }] };
    if (/^SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running'/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "running" && j.channel === "wa_cloud") };
    if (/^SELECT count\(\*\) FILTER \(WHERE status='sent' AND COALESCE\(cloud_status/i.test(s)) { const r = db.queue.filter((q) => q.job_id === Number(p[0]));
      return { rows: [{ sent: r.filter((q) => q.status === "sent" && q.cloud_status !== "failed").length, failed: r.filter((q) => q.status === "failed" || q.cloud_status === "failed").length, stopped: r.filter((q) => q.optout_at).length }] }; }
    if (/^UPDATE wa_send_jobs SET status='paused', stop_reason=\$2 WHERE id=\$1 AND status='running'/i.test(s)) { const j = job(p[0]); if (j && j.status === "running") { j.status = "paused"; j.stop_reason = p[1]; } return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) { const q = db.queue.find((x) => x.status === "pending" && job(x.job_id)?.status === "running"); if (!q) return { rows: [] }; q.status = "sending"; q.attempts = (q.attempts || 0) + 1; return { rows: [q] }; }
    if (/^SELECT id, cloud_template, cloud_vars, image_url, video_url/i.test(s)) return { rows: [job(p[0])] };
    if (/^UPDATE wa_send_queue SET status='pending', attempts=GREATEST/i.test(s)) { qrow(p[0]).status = "pending"; return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='sent'/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent", _now: true }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_send_queue SET status='failed', reason=\$2, error_code=\$3, cloud_status='failed'/i.test(s)) { Object.assign(qrow(p[0]), { status: "failed", reason: p[1], cloud_status: "failed" }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return { rows: [] }; }
    if (/^SELECT channel FROM wa_send_jobs WHERE id=\$1/i.test(s)) return { rows: job(p[0]) ? [{ channel: job(p[0]).channel }] : [] };
    if (/^UPDATE wa_send_jobs SET status=\$2, finished_at/i.test(s)) { const j = job(p[0]); if (!j || ["done", "cancelled"].includes(j.status)) return { rows: [], rowCount: 0 }; j.status = p[1]; if (p[1] === "running") j.stop_reason = null; return { rows: [{ id: j.id }], rowCount: 1 }; }
    if (/^UPDATE wa_send_jobs SET status=\$2, stop_reason = CASE/i.test(s)) { const hit = db.jobs.filter((j) => j.status === p[0] && (p[2] || j.channel !== "wa_cloud")); for (const j of hit) { j.status = p[1]; if (p[1] === "running") j.stop_reason = null; } return { rows: hit.map((j) => ({ id: j.id })), rowCount: hit.length }; }
    if (/^SELECT 1 FROM cms_links WHERE slug=\$1 AND active/i.test(s)) return { rows: [], rowCount: links.includes(p[0]) ? 1 : 0 };
    if (/^SELECT 1 FROM cms_links WHERE slug=\$1/i.test(s)) return { rows: [], rowCount: links.includes(p[0]) ? 1 : 0 };
    if (/^INSERT INTO wa_send_jobs/i.test(s)) { db.newJobs.push(p); return { rows: [{ id: 77 }] }; }
    if (/^INSERT INTO wa_send_queue\(job_id, phone_norm, name, message, score, status/i.test(s)) { (db.queued = db.queued || []).push({ pn: p[1], status: p[5] }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO cms_links/i.test(s)) { db.newLinks.push(p[0]); (db.linkRows = db.linkRows || []).push(p); return { rows: [] }; }
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], status: p[6], source: p[10] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waCloud\}'/i.test(s)) { db.settings.waCloud = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init = {}) => {
    if (init.method === "HEAD") return { ok: media !== null, status: media ? 200 : 404, headers: { get: (h) => (media ? (h === "content-type" ? media.mime : media.noLength ? null : String(media.bytes)) : null) } };
    if (media && media.noLength && String(url).includes("/api/content/media/")) { calls.gets = (calls.gets || 0) + 1; return { ok: true, status: 200, headers: { get: () => media.mime }, arrayBuffer: async () => new ArrayBuffer(media.bytes) }; }
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.K${calls.length}` }] }) };
  };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const app = fakeApp();
  const rows = Array.from({ length: people }, (_, i) => ({ pn: `51000000${i}`, name: `عميل ${i}`, orders: 2, spend: 100, daysAgo: 40, lastTotal: 60, score: 1, vars: { first_name: `عميل${i}` } }));
  const outreach = { AUDIENCES: { lapsed: { label: "غايبين" } }, audienceRows: async () => rows, cfg: async () => ({ template: "أهلاً {name}" }) };
  /* cms:mk… = دور تسويق، غيره = المالك */
  const api = S.register(app, ctx, { wa, fetch, outreach, cloudLoop: false, lock: false, now: () => AT_17, cms: () => null, cloud: () => GREEN_CLOUD,
    sessionUser: async (t) => (t === "cms:mk" ? { name: "تسويق", role: "marketing" } : { name: "عمر", role: "owner" }) });
  return { db, app, api, wa, calls };
}
const MK = "Bearer cms:mk", OWNER = "Bearer cms:own";
const WEEKEND = { channel: "wa_cloud", cloudTemplate: "fc_weekend_offer", imageUrl: IMG, cloudVars: { values: { "offer.title": "باقة تجمّع", "offer.price": "225", "offer.untilText": "السبت" } }, filters: { audience: "lapsed" } };

test("المعاينة (متاحة للتسويق): العدد بالظبط × سعر بطاقة الأسعار = التكلفة، والسعة والفرامل", withEnv(ALLOW, async () => {
  const w = world({ people: 30, settings: { waBot: { testPhones: ["0" + TESTER], waRates: { date: "2026-10-01", marketing: 0.2159, utility: 0.0401, authentication: 0.0401 } } } });
  const r = await call(w.app, "POST /api/cms/wa-sender/preview", { json: { ...WEEKEND, filters: { audience: "lapsed", limit: 500 }, spendCapSar: 4 }, auth: MK });
  assert.equal(r.status, 200); assert.equal(r.body.willQueue, 30); assert.deepEqual(r.body.problems, []);
  assert.deepEqual(r.body.cost, { messages: 30, rateSar: 0.2159, rateDate: "2026-10-01", sar: 6.48, spendCapSar: 4, willSendUnderCap: 18, sarUnderCap: 3.89 });
  assert.deepEqual([r.body.capacity.perDay, r.body.capacity.dailyCap, r.body.capacity.spendDaySar], [200, 200, 50]);
  assert.deepEqual(r.body.capacity.brake, { minSends: 30, stopPct: 2, failPct: 10, warnPct: 1, lowRead: { minDelivered: 50, hours: 6, pct: 40 } });
  assert.equal(r.body.spec.header, "image"); assert.equal(r.body.gate, null);
  assert.match(r.body.sample[0].cloud.text, /باقة تجمّع بـ225/);
  assert.equal(w.calls.length, 0);
}));

test("البدء للمالك بس؛ والتسويق يتمنع قبل أي فحص أو حفظ", withEnv(ALLOW, async () => {
  const w = world();
  const no = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: WEEKEND, auth: MK });
  assert.equal(no.status, 403); assert.equal(no.body.error, "owner_only"); assert.equal(w.db.newJobs.length, 0);
  const ok = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...WEEKEND, name: "عرض الويكند", confirmCount: 3, spendCapSar: 20 }, auth: OWNER });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.total, 3); assert.equal(ok.body.channel, "wa_cloud");
  const row = w.db.newJobs[0];
  assert.deepEqual([row[9], row[10], row[13], row[14], row[15]], ["wa_cloud", "fc_weekend_offer", null, 20, 0.2159]);       // القناة، القالب، الفيديو، سقف الحملة، سعر الرسالة وقت الإنشاء
  assert.equal(w.calls.length, 0, "creating a campaign sends nothing by itself");
  // العدد اتغيّر بين المعاينة والتأكيد
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...WEEKEND, confirmCount: 9 }, auth: OWNER })).body.error, "count_changed");
  // حملة واتساب ويب: التسويق لسه يقدر
  assert.notEqual((await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { channel: "wa_web", filters: { audience: "lapsed" } }, auth: MK })).status, 403);
}));

test("الوسيط بيتفحص بحدود ميتا قبل البدء: فيديو كبير أو نوع غلط = رفض واضح", withEnv(ALLOW, async () => {
  const vid = { channel: "wa_cloud", cloudTemplate: "fc_offer_video", videoUrl: VID, cloudVars: { offer: "عرض الليلة" }, filters: { audience: "lapsed" } };
  const big = world({ media: { mime: "video/mp4", bytes: 20 * 1048576 } });
  const r1 = await call(big.app, "POST /api/cms/wa-sender/jobs", { json: vid, auth: OWNER });
  assert.equal(r1.status, 422); assert.equal(r1.body.error, "media_too_big"); assert.equal(big.db.newJobs.length, 0);
  assert.equal((await call(world({ media: { mime: "video/quicktime", bytes: 1000 } }).app, "POST /api/cms/wa-sender/jobs", { json: vid, auth: OWNER })).body.error, "media_type");
  assert.equal((await call(world({ media: null }).app, "POST /api/cms/wa-sender/jobs", { json: vid, auth: OWNER })).body.error, "media_unreachable");
  // السيرفر مارجّعش الحجم في HEAD ⇒ بنقيس الملف نفسه
  const nl = world({ media: { mime: "video/mp4", bytes: 17 * 1048576, noLength: true } });
  assert.equal((await call(nl.app, "POST /api/cms/wa-sender/jobs", { json: vid, auth: OWNER })).body.error, "media_too_big"); assert.equal(nl.calls.gets, 1);
  const ok = world({ media: { mime: "video/mp4", bytes: 9 * 1048576 } });
  const r2 = await call(ok.app, "POST /api/cms/wa-sender/jobs", { json: vid, auth: OWNER });
  assert.equal(r2.status, 200, JSON.stringify(r2.body)); assert.equal(ok.db.newJobs[0][13], VID);
}));

test("إرسال تجربة: للمالك، لرقم تجربة بس، بنفس محتوى الحملة ومن باب الحارس — ومن غير ما تتعمل حملة", async () => {
  await withEnv(CONFIGURED, async () => {                 // الإرسال للعملاء مقفول: التجربة لسه تشتغل لرقم التجربة
    const w = world({ settings: { waMaster: { enabled: false } } });
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0" + TESTER, testLinkSlug: "wa-test" }, auth: MK })).status, 403);
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0512345678", testLinkSlug: "wa-test" }, auth: OWNER })).body.error, "not_in_allow_list");
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0" + TESTER }, auth: OWNER })).body.error, "test_link_required");
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0" + TESTER, testLinkSlug: "nope" }, auth: OWNER })).body.error, "test_link_required");
    assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, cloudVars: {}, phone: "0" + TESTER, testLinkSlug: "wa-test" }, auth: OWNER })).body.error, "value_required");
    assert.equal(w.calls.length, 0);
    const ok = await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0" + TESTER, testLinkSlug: "wa-test", testName: "عمر" }, auth: OWNER });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.to, "0" + TESTER); assert.match(ok.body.text, /باقة تجمّع بـ225/);
    assert.equal(w.calls.length, 1);
    const t = w.calls[0].body;
    assert.equal(t.to, "966" + TESTER); assert.equal(t.template.name, "fc_weekend_offer");
    assert.deepEqual(t.template.components.map((c) => c.type), ["header", "body", "button"]);
    assert.deepEqual(t.template.components[2].parameters, [{ type: "text", text: "wa-test" }]);
    assert.equal(w.db.newJobs.length, 0); assert.equal(w.db.msgs[0].source, "campaign");
  })();
  await withEnv({ ...CONFIGURED, WHATSAPP_ENABLED: "0" }, async () => {      // القفل الصلب: ولا حتى التجربة
    const w = world();
    const r = await call(w.app, "POST /api/cms/wa-sender/cloud/test", { json: { ...WEEKEND, phone: "0" + TESTER, testLinkSlug: "wa-test" }, auth: OWNER });
    assert.equal(r.status, 409); assert.equal(r.body.gate, "disabled"); assert.equal(w.calls.length, 0);
  })();
});

const J = (x = {}) => ({ id: 1, status: "running", channel: "wa_cloud", cloud_template: "fc_offer_img", cloud_vars: { offer: "كيلو بـ96" }, image_url: IMG, video_url: null, link_slug: "w1", offer: null, fallback: "none", spend_cap_sar: null, rate_sar: 0.2159, stop_reason: null, ...x });
const Q = (id, x = {}) => ({ id, job_id: 1, phone_norm: `5200000${String(id).padStart(2, "0")}`, status: "pending", channel: "wa_cloud", name: "محمد", vars: { first_name: "محمد" }, link_code: `c${id}`, coupon: null, attempts: 0, ...x });
const optin = (w) => { for (const q of w.db.queue) w.db.optins[q.phone_norm] = { updates: true, marketing: true }; };

/* QP1: الحدود الافتراضية بقت ٢٪ بعد ٣٠ (waquality.test.mjs). السيناريوهات دي مكتوبة على ٥٪ بعد ٢٠، فالحدود دي مكتوبة فيها صريح. */
const OLD_BRAKES = { waCloud: { enabled: true, brakeMinSends: 20, brakeStopPct: 5 } };
test("الدورة: الفرامل بتوقّف الحملة على نسبة الفشل، وعلى نسبة «إيقاف»، وبتكتب السبب", withEnv(ALLOW, async () => {
  // ١٨ اتبعتوا + ٢ فشلوا = ١٠٪ فشل بعد ٢٠ محاولة ⇒ تقف قبل ما تبعت الباقي
  const a = world({ settings: OLD_BRAKES, jobs: [J()], queue: [...Array.from({ length: 18 }, (_, i) => Q(i + 1, { status: "sent" })), Q(19, { status: "failed", cloud_status: "failed" }), Q(20, { status: "failed", cloud_status: "failed" }), Q(21), Q(22)] });
  optin(a);
  const r = await a.api.cloudTick();
  assert.equal(a.db.jobs[0].status, "paused"); assert.equal(a.db.jobs[0].stop_reason, "fail_rate:10"); assert.equal(a.calls.length, 0, JSON.stringify(r));
  assert.equal(a.db.queue.filter((q) => q.status === "pending").length, 2);
  // ٤٠ اتبعتوا و٢ كتبوا «إيقاف» = ٥٪
  const b = world({ settings: OLD_BRAKES, jobs: [J()], queue: [...Array.from({ length: 40 }, (_, i) => Q(i + 1, { status: "sent", ...(i < 2 ? { optout_at: "2026-10-13T13:00:00Z" } : {}) })), Q(41)] });
  optin(b);
  await b.api.cloudTick();
  assert.equal(b.db.jobs[0].stop_reason, "stop_rate:5"); assert.equal(b.calls.length, 0);
  // تحت الحد: بتكمّل
  const c = world({ settings: OLD_BRAKES, jobs: [J()], queue: [...Array.from({ length: 40 }, (_, i) => Q(i + 1, { status: "sent", ...(i < 1 ? { optout_at: "x" } : {}) })), Q(41)] });
  optin(c);
  const rc = await c.api.cloudTick();
  assert.equal(c.db.jobs[0].status, "running"); assert.equal(rc.sent, 1); assert.equal(c.calls.length, 1);
}));

test("الدورة: سقف صرف الحملة بيوقّفها عند آخر رسالة داخل السقف، وسقف الصرف اليومي بيوقّف القناة", withEnv(ALLOW, async () => {
  // سقف الحملة ٠٫٥ ر.س بسعر ٠٫٢١٥٩ ⇒ رسالتين بس
  const a = world({ jobs: [J({ spend_cap_sar: 0.5 })], queue: [Q(1), Q(2), Q(3), Q(4)] });
  optin(a);
  const r = await a.api.cloudTick();
  assert.equal(r.sent, 2, JSON.stringify(r)); assert.equal(a.calls.length, 2);
  assert.equal(a.db.jobs[0].status, "paused"); assert.equal(a.db.jobs[0].stop_reason, "campaign_spend_cap");
  assert.equal(a.db.queue.filter((q) => q.status === "pending").length, 2);
  // سقف اليوم ٥٠ ر.س: ٢٣١ رسالة اتبعتت النهارده (والسقف اليومي بالعدد مرفوع) ⇒ ولا رسالة
  const b = world({ jobs: [J()], queue: [Q(1)], sentToday: 231, settings: { waCloud: { enabled: true, dailyCap: 1000, tierLimit: 5000 } } });
  optin(b);
  assert.equal((await b.api.cloudTick()).reason, "spend_cap"); assert.equal(b.calls.length, 0);
  // السقف اليومي الافتراضي ٢٠٠
  const c = world({ jobs: [J()], queue: [Q(1)], sentToday: 200 });
  optin(c);
  assert.equal((await c.api.cloudTick()).reason, "daily_cap"); assert.equal(c.calls.length, 0);
}));

test("الدورة: مفتاح المالك مقفول ⇒ ولا رسالة، والموافقة من الحارس (اللي مش موافق بيتخطّى)", async () => {
  await withEnv(ALLOW, async () => {
    const w = world({ jobs: [J()], queue: [Q(1), Q(2)], settings: { waMaster: { enabled: false } } }); optin(w);
    assert.equal((await w.api.cloudTick()).reason, "master_off"); assert.equal(w.calls.length, 0);
  })();
  await withEnv(ALLOW, async () => {
    const w = world({ jobs: [J()], queue: [Q(1), Q(2)] });
    w.db.optins[w.db.queue[0].phone_norm] = { updates: true, marketing: true, stopped_at: "2026-10-01T00:00:00Z" };     // وقّف الرسايل
    w.db.optins[w.db.queue[1].phone_norm] = { updates: true, marketing: true };
    const r = await w.api.cloudTick();
    assert.equal(r.sent, 1); assert.equal(w.calls.length, 1); assert.equal(w.db.queue[0].status, "skipped"); assert.equal(w.db.queue[0].reason, "opted_out");
  })();
});

test("التكملة ورفع السقوف للمالك بس؛ الإيقاف لأي حد", withEnv(ALLOW, async () => {
  const w = world({ jobs: [J({ status: "paused", stop_reason: "fail_rate:12" }), J({ id: 2, channel: "wa_web", status: "paused" })] });
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" }, auth: MK })).status, 403);
  assert.equal(w.db.jobs[0].status, "paused");
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/all/:action", { param: { action: "resume" }, auth: MK })).body.changed, 1);     // واتساب ويب بس
  assert.deepEqual(w.db.jobs.map((j) => j.status), ["paused", "running"]);
  const ok = await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" }, auth: OWNER });
  assert.equal(ok.status, 200); assert.equal(w.db.jobs[0].status, "running"); assert.equal(w.db.jobs[0].stop_reason, null);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "pause" }, auth: MK })).status, 200);
  // السقوف
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { spendDaySar: 500 }, auth: MK })).status, 403);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { enabled: false }, auth: MK })).status, 200);
  const up = await call(w.app, "POST /api/cms/wa-sender/cloud", { json: { spendDaySar: 80, brakeStopPct: 3, dailyCap: 220 }, auth: OWNER });
  assert.deepEqual([up.body.cfg.spendDaySar, up.body.cfg.brakeStopPct, up.body.cfg.dailyCap], [80, 3, 220]);
}));

/* ══ LK1 (١٣/١٠): الرابط بيفتح إيه + المجموعة المحجوزة بالعدد ═══════════════ */
const L = await import("./cmslinks.js");
const R = await import("./smsrules.js");
const fs = await import("node:fs");

test("LK1 هدف الرابط: كل أنواع محرر الروابط مقبولة (box / gather / cart)، والنوع المجهول خطأ مش «الرئيسية»", () => {
  const T = (link) => S.jobInput({ channel: "wa_web", link }, { hosts: HOSTS });
  const tgt = (link) => { const r = T(link); return [r.link.target_type, r.link.target_id, r.errs.map((e) => e[0])]; };
  assert.deepEqual(tgt({ target_type: "box", target_id: "taste-it-all" }), ["box", "taste-it-all", []]);
  assert.deepEqual(tgt({ target_type: "gather", target_id: "ignored" }), ["gather", null, []]);
  assert.deepEqual(tgt({ target_type: "cart", target_id: "AB12CD34" }), ["cart", "ab12cd34", []]);
  for (const t of ["collection", "product", "offer"]) assert.deepEqual(tgt({ target_type: t, target_id: "7" }), [t, "7", []]);
  assert.deepEqual(tgt({}), ["home", null, []]); assert.deepEqual(tgt({ target_type: "home", target_id: "x" }), ["home", null, []]);
  // ده اللي كان بيتخزّن «home» في صمت
  assert.deepEqual(tgt({ target_type: "bundle", target_id: "taste-it-all" })[2], ["bad_target"]);
  assert.match(T({ target_type: "bundle", target_id: "x" }).errs[0][1], /«bundle» مش معروف/);
  assert.deepEqual(tgt({ target_type: "box" })[2], ["target_missing"]);
  assert.deepEqual(tgt({ target_type: "cart", target_id: "no!" })[2], ["bad_cart_code"]);
  // مصدر واحد: مفيش قايمة تانية في wasender ولا في cms
  assert.deepEqual([...L.LINK_TARGET_TYPES], ["home", "collection", "product", "offer", "cart", "box", "gather"]);
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  assert.doesNotMatch(src("./wasender.js"), /const TARGETS\b/);
  assert.doesNotMatch(src("./cms.js"), /\["home", "collection", "product", "offer"/);
  assert.match(src("./cms.js"), /LINK_TARGET_TYPES\.includes\(b\.target_type\)/); assert.match(src("./cms.js"), /for \(const \[k, v\] of linkTargetParams\(l\)\) q\.set\(k, v\);/);
  // شكل رابط الهبوط لكل نوع (نفس اللي المحوّل ‎/l/<slug>‎ بيبنيه)
  assert.deepEqual(L.linkTargetParams({ target_type: "box", target_id: "taste-it-all" }), [["go", "offers"], ["box", "taste-it-all"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "box", target_id: "b", autocart: true }), [["go", "offers"], ["box", "b"], ["bxadd", "1"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "gather" }), [["go", "offers"], ["gather", "1"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "offer", target_id: "9" }), [["go", "offers"], ["offer", "9"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "collection", target_id: "3" }), [["col", "3"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "product", target_id: "103" }), [["p", "103"]]);
  assert.deepEqual(L.linkTargetParams({ target_type: "home" }), []);
  assert.deepEqual([L.linkTargetPath({ target_type: "home" }), L.linkTargetPath({ target_type: "box", target_id: "taste-it-all" }), L.linkTargetPath({ target_type: "cart", target_id: "ab12cd34" })],
    ["/", "/?go=offers&box=taste-it-all", "/?cart=ab12cd34"]);
  assert.deepEqual(L.linkTarget("nope", "x", { unknown: "home" }), { ok: true, target_type: "home", target_id: null }, "محرر الروابط بيفضل على سلوكه القديم");
});

test("LK1 حملة برابط بوكس: الرابط بيتخزّن «box» بهدفه، والمعاينة بتعرض الزر هيفتح إيه؛ والنوع المجهول مايتحفظش", withEnv(ALLOW, async () => {
  const BOX = { ...WEEKEND, link: { target_type: "box", target_id: "taste-it-all" } };
  const w = world();
  const pv = await call(w.app, "POST /api/cms/wa-sender/preview", { json: BOX, auth: MK });
  assert.deepEqual(pv.body.link, { slug: null, targetType: "box", targetId: "taste-it-all", url: "freshcuts.sa/l/w…-xxxxxx", opens: "https://freshcuts.sa/?go=offers&box=taste-it-all", coupon: null, button: true });
  assert.deepEqual(pv.body.problems, []);
  const ok = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...BOX, name: "بوكس التشكيلة" }, auth: OWNER });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([w.db.linkRows[0][0], w.db.linkRows[0][2], w.db.linkRows[0][3]], ["w77", "box", "taste-it-all"]);
  assert.deepEqual(ok.body.target, { type: "box", id: "taste-it-all", opens: "https://freshcuts.sa/?go=offers&box=taste-it-all" });
  // باقات التجمّعات: من غير هدف
  const g = world();
  await call(g.app, "POST /api/cms/wa-sender/jobs", { json: { ...WEEKEND, link: { target_type: "gather" } }, auth: OWNER });
  assert.deepEqual([g.db.linkRows[0][2], g.db.linkRows[0][3]], ["gather", null]);
  // من غير link خالص: الرئيسية زي الأول
  const h = world();
  await call(h.app, "POST /api/cms/wa-sender/jobs", { json: WEEKEND, auth: OWNER });
  assert.deepEqual([h.db.linkRows[0][2], h.db.linkRows[0][3]], ["home", null]);
  assert.equal((await call(h.app, "POST /api/cms/wa-sender/preview", { json: WEEKEND, auth: MK })).body.link.opens, "https://freshcuts.sa/");
  // نوع مجهول: المعاينة بتقول، والبدء بيترفض قبل أي حفظ
  const bad = world(), BAD = { ...WEEKEND, link: { target_type: "bundle", target_id: "taste-it-all" } };
  assert.deepEqual((await call(bad.app, "POST /api/cms/wa-sender/preview", { json: BAD, auth: MK })).body.problems.map((p) => p.error), ["bad_target"]);
  const r = await call(bad.app, "POST /api/cms/wa-sender/jobs", { json: BAD, auth: OWNER });
  assert.deepEqual([r.status, r.body.error], [422, "bad_target"]); assert.equal(bad.db.newJobs.length, 0); assert.equal((bad.db.linkRows || []).length, 0);
}));

test("LK1 المجموعة المحجوزة بالعدد: ١٠٪ من ٣٠ = ٣ بالظبط (كانت «عملة» لكل رقم: ٠ أو ٧)، وثابتة لنفس الحملة", withEnv(ALLOW, async () => {
  const phones = (n, base = 510000000) => Array.from({ length: n }, (_, i) => String(base + i));
  for (const [n, want] of [[30, 3], [28, 3], [20, 2], [8, 1], [4, 0], [5, 1], [1000, 100]]) assert.equal(R.holdoutSet("wa9", phones(n), 10).size, want, `${n}`);
  assert.equal(R.holdoutSet("wa9", phones(30), 0).size, 0); assert.equal(R.holdoutSet("wa9", phones(30), 90).size, 15, "السقف ٥٠٪");
  assert.equal(R.holdoutSet("wa9", [], 10).size, 0);
  const a = R.holdoutSet("wa9", phones(30), 10), b = R.holdoutSet("wa9", phones(30).reverse(), 10);
  assert.deepEqual([...a].sort(), [...b].sort(), "نفس القايمة بأي ترتيب ⇒ نفس المحجوزين");
  assert.notDeepEqual([...a].sort(), [...R.holdoutSet("wa10", phones(30), 10)].sort(), "حملة تانية ⇒ اختيار تاني");
  assert.deepEqual([R.holdoutCount(30, 10), R.holdoutCount(8, 10), R.holdoutCount(28, 10), R.holdoutCount(0, 10), R.holdoutCount(30, 0)], [3, 1, 3, 0, 0]);
  // في المسار: المعاينة والبدء نفس العدد
  const w = world({ people: 30 });
  const body = { ...WEEKEND, holdoutPct: 10, filters: { audience: "lapsed", limit: 500 } };
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/preview", { json: body, auth: MK })).body.holdoutEst, 3);
  const r = await call(w.app, "POST /api/cms/wa-sender/jobs", { json: body, auth: OWNER });
  assert.deepEqual([r.body.total, r.body.holdout], [30, 3]);
  assert.deepEqual([w.db.queued.filter((q) => q.status === "holdout").length, w.db.queued.filter((q) => q.status === "pending").length], [3, 27]);
}));
