/* SX2 (١٥/١٠): متانة محرّك الحملات — البدء المجدول من السيرفر، الإعادة التلقائية للفشل المؤقت، فحص الوسيط قبل البدء، والأسباب بالعربي.
   حادثتين ١٥/١٠: (١) البدء/التكملة كانوا من cron بره في جلسة المشغّل ومااشتغلش ⇒ الموجة طلعت متأخرة ساعة؛
   (٢) ٧٦ رسالة فشلت بـ131000 لأن الـAPI اتعمل له ريستارت وميتا بتنزّل صورة الهيدر (الصورة على سيرفرنا).
   node --test wa-sx2-robust.test.mjs — قاعدة وهمية وfetch وهمي وواتساب وهمي؛ مفيش شبكة ولا إرسال حقيقي، وأرقام وهمية بس. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);
C.registerCampaignTemplates();

const AT_17 = Date.parse("2026-10-15T14:00:00Z");          // ١٧:٠٠ الرياض (خميس)
const MIN = 60_000;
const IMG = "https://freshcuts-api.o2m8.me/api/content/media/7.jpg";
const WARM_DONE = { step: 3, since: "2026-09-01", startedAt: "2026-09-01" };

// ───────── دوال صافية ─────────
test("ميعاد البدء: بتوقيت الرياض من خانة الوقت، أو ISO صريح؛ لازم بعد دلوقتي ولحد ١٤ يوم", () => {
  const P = (v) => S.parseStartAt(v, AT_17);
  assert.deepEqual(P(""), { at: null }); assert.deepEqual(P(null), { at: null });
  const a = P("2026-10-15T18:00");                         // ١٨:٠٠ الرياض = ١٥:٠٠ UTC
  assert.equal(a.at, "2026-10-15T15:00:00.000Z"); assert.equal(a.riyadh, "2026-10-15 18:00");
  assert.equal(P("2026-10-15 18:30").at, "2026-10-15T15:30:00.000Z");
  assert.equal(P("2026-10-15T15:00:00Z").at, "2026-10-15T15:00:00.000Z");
  assert.equal(P("2026-10-15T18:00:00+03:00").at, "2026-10-15T15:00:00.000Z");
  assert.equal(P("2026-10-15T18:00:42").at, "2026-10-15T15:00:00.000Z", "لحد الدقيقة");
  assert.equal(P("2026-10-15T16:59")[ "error" ][0], "start_at_past");
  assert.equal(P("2026-10-15T17:00").error[0], "start_at_past", "دلوقتي بالظبط = مش بعد دلوقتي");
  assert.equal(P("2026-10-30T18:00").error[0], "start_at_far");
  assert.equal(P("بكرة").error[0], "bad_start_at"); assert.equal(P("2026-13-01T10:00").error[0], "bad_start_at");
  assert.match(P("x").error[1], /ميعاد البدء/);
  assert.equal(S.riyadhClock("2026-10-15T21:30:00Z"), "2026-10-16 00:30");
});

test("أكواد ميتا: 131000 / 131053 / 131016 / 133004 / 2 مؤقتة؛ 131053 مابقتش بتوقّف القناة؛ 131049 و131026 و130472 عمرهم ما بيتعادوا", () => {
  for (const code of [131000, 131053, 131016, 133004, 2]) assert.equal(C.classifyError(code).transient, true, String(code));
  assert.equal(C.classifyError(131053).stop, false); assert.equal(C.classifyError(131053).media, true); assert.equal(C.classifyError(131053).reason, "media_error");
  assert.equal(C.classifyError(131016).retry, true, "الإعادة الفورية القديمة (حد السرعة) زي ما هي");
  for (const code of [131049, 131026, 130472, 131050, 132001, 131048, null, 987654]) assert.equal(C.classifyError(code).transient, false, String(code));
  const cc = C.cloudCfg({});
  const D = (code, row = {}, x = {}) => C.retryDecision({ cls: C.classifyError(code), row, cc, ...x });
  assert.deepEqual(D(131000), { retry: true, delayMin: 10 });
  assert.equal(D(131049).why, "not_transient"); assert.equal(D(131026).why, "not_transient"); assert.equal(D(130472).why, "not_transient");
  assert.equal(D(131000, { retried_at: "2026-10-15T14:00:00Z" }).why, "already_retried", "مرة واحدة بس");
  assert.equal(D(131000, { cloud_status: "delivered" }).why, "delivered");
  assert.equal(D(131000, {}, { jobStatus: "cancelled" }).why, "job_cancelled");
  assert.equal(C.retryDecision({ cls: C.classifyError(131000), cc: C.cloudCfg({ waCloud: { retryTransient: false } }) }).why, "retry_off");
});

test("إعدادات الإعادة والبدء في settings.waCloud (اللوحة): افتراضي ١٠ دقايق / ٣ ساعات / ١٢٠ دقيقة، ومتظبطة لو اتكتبت غلط", () => {
  const d = C.cloudCfg({});
  assert.deepEqual([d.retryTransient, d.retryDelayMin, d.retryMaxHours, d.startLateMaxMin], [true, 10, 3, 120]);
  const x = C.cloudCfg({ waCloud: { retryTransient: false, retryDelayMin: 0, retryMaxHours: 99, startLateMaxMin: "abc" } });
  assert.deepEqual([x.retryTransient, x.retryDelayMin, x.retryMaxHours, x.startLateMaxMin], [false, 2, 24, 120]);
  for (const k of ["retryTransient", "retryDelayMin", "retryMaxHours", "startLateMaxMin"]) { assert.ok(C.CLOUD_KEYS.includes(k), k); assert.ok(k in C.CLOUD_DEFAULTS, k); }
});

test("الأسباب بالعربي: من ميتا ومن عندنا، والكود المجهول بيتقال برقمه", () => {
  assert.equal(C.reasonText("meta_marketing_limit"), "ميتا مابتوصّلش رسايل تسويق كتير للعميل ده");
  assert.equal(C.reasonText("undeliverable"), "الرقم مش على واتساب");
  assert.equal(C.reasonText("meta_error"), "غلطة مؤقتة عند ميتا (131000)");
  assert.equal(C.reasonText("gap_7d"), "وصلته رسالة واتساب في آخر ٧ أيام");
  assert.equal(C.reasonText("meta_987654"), "ميتا رفضت بكود 987654");
  assert.equal(C.reasonText("offer_gone:box_sold_out"), "العرض بتاعه خلص أو اتشال");
  assert.equal(C.reasonText("zzz"), "سبب تاني (zzz)"); assert.equal(C.reasonText(null), "من غير سبب متسجّل");
  for (const r of Object.values(C.META_ERRORS).map((m) => m.reason)) assert.doesNotMatch(C.reasonText(r), /^سبب تاني/, r);
  const rows = [{ status: "failed", reason: "meta_marketing_limit" }, { status: "failed", reason: "meta_marketing_limit" }, { status: "skipped", reason: "gap_7d" },
    { status: "failed", reason: "meta_error", retry_at: "2026-10-15T14:10:00Z" }, { status: "sent" }];
  assert.deepEqual(C.reasonRows(rows), [{ status: "failed", reason: "meta_marketing_limit", n: 2, text: "ميتا مابتوصّلش رسايل تسويق كتير للعميل ده" },
    { status: "skipped", reason: "gap_7d", n: 1, text: "وصلته رسالة واتساب في آخر ٧ أيام" }], "المستني إعادة مش «فشل»");
  assert.deepEqual(C.retryStats([...rows, { status: "sent", retried_at: "x", cloud_status: "delivered" }, { status: "sent", retried_at: "x", cloud_status: "accepted" },
    { status: "failed", retried_at: "x" }, { status: "sent", note: "delivered_after_failure" }, { status: "failed", note: "retry_expired" }]),
  { waiting: 1, retried: 3, ok: 2, delivered: 1, failedAgain: 1, deliveredLate: 1, expired: 1 });
});

// ───────── عالم وهمي (قاعدة + واتساب + fetch) ─────────
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const call = (app, route, { json = {}, param = {}, auth = "Bearer cms:own", query = {} } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: (k) => query[k], param: (n) => param[n] },
  json: (body, status = 200) => ({ body, status }) });
const OWNER = "Bearer cms:own", MK = "Bearer cms:mk";
const iso = (t) => new Date(t).toISOString();

function world({ jobs = [], queue = [], settings = {}, media = {}, script = [], msgs = [] } = {}) {
  const clock = { t: AT_17 };
  const db = { jobs, queue, msgs: [...msgs], contactLog: [], coupons: [], invalid: new Set(), state: { 1: {}, 2: {} }, optouts: [], sms: [], heads: 0,
    settings: { waCloud: { enabled: true }, waSender: {}, delivery: { alertPhones: ["0555000111"] }, ...settings } };
  const job = (id) => db.jobs.find((j) => j.id === Number(id));
  const qrow = (id) => db.queue.find((q) => q.id === Number(id));
  const ch = (q) => q.channel || (job(q.job_id) || {}).channel || "wa_web";
  const waiting = (q) => q.status === "failed" && q.retry_at;
  const pool = { db, connect: async () => ({ query: (s, p) => pool.query(s, p), release() {} }), async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const rc = (rows) => ({ rows, rowCount: rows.length });
    if (/^CREATE TABLE|^ALTER TABLE|^CREATE INDEX|^INSERT INTO wa_sender_state\(id\)/i.test(s)) return rc([]);
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return rc([{ stopped_reason: db.state[p[0]].stopped_reason || null, warmup: WARM_DONE }]);
    if (/FROM wa_send_queue WHERE status='sent' AND sent_at > NOW\(\) - INTERVAL '2 days'/i.test(s)) { const n = db.queue.filter((q) => q.status === "sent" && q._now).length; return rc([{ today: n, last_hour: n }]); }
    if (/count\(DISTINCT phone_norm\)::int AS n FROM wa_messages/i.test(s)) return rc([{ n: 0 }]);
    if (/^SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running'/i.test(s)) return rc(db.jobs.filter((j) => j.status === "running" && j.channel === "wa_cloud"));
    if (/^SELECT count\(\*\) FILTER \(WHERE status='sent' AND COALESCE\(cloud_status/i.test(s)) { const r = db.queue.filter((q) => q.job_id === Number(p[0]));
      return rc([{ sent: r.filter((q) => q.status === "sent" && q.cloud_status !== "failed").length,
        failed: r.filter((q) => (q.status === "failed" || q.cloud_status === "failed") && Number(q.error_code) !== 131049 && !q.retry_at).length,
        capped: r.filter((q) => (q.status === "failed" || q.cloud_status === "failed") && Number(q.error_code) === 131049).length,
        stopped: r.filter((q) => q.optout_at).length, delivered: 0, read_n: 0, first_sent: null,
        ...(() => { const ack = p[1] ? Date.parse(p[1]) : null, w = r.filter((q) => !ack || Date.parse(q.tried_at || q.claimed_at || 0) > ack);
          return { b_sent: w.filter((q) => q.status === "sent" && q.cloud_status !== "failed").length,
            b_failed: w.filter((q) => (q.status === "failed" || q.cloud_status === "failed") && Number(q.error_code) !== 131049 && !q.retry_at).length,
            b_stopped: w.filter((q) => q.optout_at).length }; })() }]); }
    if (/^UPDATE wa_send_jobs SET status='paused', stop_reason=\$2 WHERE id=\$1 AND status='running'/i.test(s)) { const j = job(p[0]); if (j && j.status === "running") { j.status = "paused"; j.stop_reason = p[1]; return rc([{ id: j.id }]); } return rc([]); }
    if (/^WITH s AS/i.test(s)) {       // recoverStuck
      const out = [];
      for (const q of db.queue.filter((x) => x.status === "sending" && x.channel === "wa_cloud" && x._stale)) {
        const m = db.msgs.find((x) => x.phone_norm === q.phone_norm && x.source === "campaign" && x.template === job(q.job_id).cloud_template && x.wamid && !["failed", "skipped"].includes(x.status));
        if (m) { Object.assign(q, { status: "sent", wamid: m.wamid, cloud_status: "accepted", note: "recovered_after_restart" }); out.push({ id: q.id, phone_norm: q.phone_norm, job_id: q.job_id, coupon: q.coupon }); }
      }
      return rc(out);
    }
    if (/^UPDATE wa_send_queue SET status='pending' WHERE status='sending'/i.test(s)) { for (const q of db.queue) if (q.status === "sending" && q._stale && (q.attempts || 0) < 3) q.status = "pending"; return rc([]); }
    if (/^UPDATE wa_send_queue SET retry_at=NULL, note='retry_off'/i.test(s)) { const hit = db.queue.filter((q) => waiting(q) && !q.retried_at); for (const q of hit) Object.assign(q, { retry_at: null, note: "retry_off" }); return rc(hit.map((q) => ({ id: q.id }))); }
    if (/^UPDATE wa_send_queue SET retry_at=NULL, note='retry_expired'/i.test(s)) {
      const lim = Date.parse(p[0]) - p[1] * 3600e3; const hit = db.queue.filter((q) => waiting(q) && !q.retried_at && Date.parse(q.retry_at) <= lim);
      for (const q of hit) Object.assign(q, { retry_at: null, note: "retry_expired" }); return rc(hit.map((q) => ({ id: q.id })));
    }
    if (/^UPDATE wa_send_queue AS r SET status='sending'/i.test(s)) {       // claimRetry
      const T = Date.parse(p[0]), lim = T - p[1] * 3600e3;
      const q = db.queue.filter((x) => waiting(x) && !x.retried_at && Date.parse(x.retry_at) <= T && Date.parse(x.retry_at) > lim && (job(x.job_id) || {}).status === "running" && ch(x) === "wa_cloud")
        .sort((a, b) => Date.parse(a.retry_at) - Date.parse(b.retry_at) || a.id - b.id)[0];
      if (!q) return rc([]);
      Object.assign(q, { status: "sending", attempts: (q.attempts || 0) + 1, retry_at: null, retried_at: p[0], tried_at: p[0], first_error_code: q.first_error_code ?? q.error_code ?? null,
        first_wamid: q.first_wamid ?? q.wamid ?? null, cloud_status: null, error_code: null, reason: null });
      return rc([{ ...q }]);
    }
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) {
      const q = db.queue.find((x) => x.status === "pending" && (job(x.job_id) || {}).status === "running" && ch(x) === "wa_cloud");
      if (!q) return rc([]);
      Object.assign(q, { status: "sending", channel: "wa_cloud", attempts: (q.attempts || 0) + 1, tried_at: iso(clock.t) }); return rc([{ ...q }]);
    }
    if (/^UPDATE wa_send_jobs j SET status='done'/i.test(s)) {
      for (const j of db.jobs.filter((x) => x.status === "running" && x.channel === "wa_cloud")) if (!db.queue.some((q) => q.job_id === j.id && (["pending", "sending"].includes(q.status) || waiting(q)))) j.status = "done";
      return rc([]);
    }
    if (/^SELECT id, cloud_template, cloud_vars, image_url, video_url/i.test(s)) return rc(job(p[0]) ? [{ ...job(p[0]) }] : []);
    if (/^SELECT status FROM wa_messages WHERE wamid=\$1/i.test(s)) { const m = db.msgs.find((x) => x.wamid === p[0]); return rc(m ? [{ status: m.status }] : []); }
    if (/^UPDATE wa_send_queue SET status='sent', channel='wa_cloud', reason=NULL/i.test(s)) {      // restoreDelivered
      const q = qrow(p[0]); if (!q || !["failed", "sending", "pending"].includes(q.status)) return rc([]);
      Object.assign(q, { status: "sent", channel: "wa_cloud", reason: null, error_code: null, retry_at: null, retried_at: p[3] ? null : q.retried_at, cloud_status: p[1], wamid: p[2] ?? q.wamid,
        note: String(q.note || "").startsWith("sms_fallback") ? q.note : "delivered_after_failure" }); return rc([{ id: q.id }]);
    }
    if (/^UPDATE wa_send_queue SET status='failed', cloud_status='failed', retried_at=NULL, retry_at=\$2/i.test(s)) {       // unclaimRetry
      const q = qrow(p[0]); Object.assign(q, { status: "failed", cloud_status: "failed", retried_at: null, retry_at: p[1], error_code: q.first_error_code ?? q.error_code, reason: p[2], attempts: Math.max(0, (q.attempts || 0) - 1) }); return rc([]);
    }
    if (/^UPDATE wa_send_queue SET status='failed', reason=\$2, error_code=\$3, cloud_status='failed', retry_at=\$4/i.test(s)) { Object.assign(qrow(p[0]), { status: "failed", reason: p[1], error_code: p[2], cloud_status: "failed", retry_at: p[3] }); return rc([]); }
    if (/^UPDATE wa_send_queue SET status='failed', reason=\$2, error_code=\$3, cloud_status='failed'/i.test(s)) { Object.assign(qrow(p[0]), { status: "failed", reason: p[1], error_code: p[2], cloud_status: "failed" }); return rc([]); }
    if (/^UPDATE wa_send_jobs SET status='running', finished_at=NULL WHERE id=\$1 AND status='done'/i.test(s)) { const j = job(p[0]); if (j && j.status === "done") { j.status = "running"; return rc([{ id: j.id }]); } return rc([]); }
    if (/FROM cms_contacts WHERE phone_norm=\$1 AND opted_out_at/i.test(s)) return { rows: [], rowCount: db.optouts.includes(p[0]) ? 1 : 0 };
    if (/FROM wa_invalid_numbers WHERE phone_norm = ANY/i.test(s)) return rc(p[0].filter((x) => db.invalid.has(x)).map((x) => ({ phone_norm: x })));
    if (/FROM wa_contact_log WHERE phone_norm = ANY/i.test(s)) return rc(p[0].filter((x) => db.contactLog.some((l) => l.pn === x)).map((x) => ({ pn: x })));
    if (/sms_ad_blocked|cms_campaign_sends|cms_flow_log|sms_log/i.test(s)) throw Object.assign(new Error("missing"), { code: "42P01" });
    if (/FROM shop_orders/i.test(s)) return rc([]);
    if (/^UPDATE wa_send_queue SET status='sent', sent_at=NOW\(\)/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent", reason: null, media: p[1], note: p[2], channel: p[3], wamid: p[4] ?? qrow(p[0]).wamid, cloud_status: p[4] ? "accepted" : qrow(p[0]).cloud_status, _now: true }); return rc([]); }
    if (/^INSERT INTO wa_contact_log/i.test(s)) { db.contactLog.push({ pn: p[0], job: p[1], by: p[2] ?? (/'cloud'/.test(s) ? "cloud" : null) }); return rc([]); }
    if (/^DELETE FROM wa_contact_log/i.test(s)) { db.contactLog = db.contactLog.filter((l) => !(l.pn === p[0] && l.job === p[1] && l.by === "cloud")); return rc([]); }
    if (/^UPDATE wa_sender_state SET stopped_reason=\$1/i.test(s)) { db.state[2].stopped_reason = p[0]; return rc([]); }
    if (/^SELECT offer FROM wa_send_jobs/i.test(s)) return rc([job(p[0]) || {}]);
    if (/^UPDATE shop_coupons SET active=true/i.test(s)) { db.coupons.push(["on", p[0]]); return rc([]); }
    if (/^UPDATE shop_coupons SET active=false/i.test(s)) { db.coupons.push(["off", p[0]]); return rc([]); }
    if (/^SELECT id, job_id, phone_norm, status, cloud_status, channel, coupon, message FROM wa_send_queue WHERE wamid=\$1/i.test(s)) { const q = db.queue.find((x) => x.wamid === p[0]); return rc(q ? [{ ...q }] : []); }
    if (/^UPDATE wa_send_queue SET cloud_status=\$2/i.test(s)) { qrow(p[0]).cloud_status = p[1]; return rc([]); }
    if (/^SELECT retried_at FROM wa_send_queue WHERE id=\$1/i.test(s)) return rc([{ retried_at: qrow(p[0]).retried_at || null }]);
    if (/^SELECT fallback_from FROM wa_send_queue WHERE id=\$1/i.test(s)) return rc([{ fallback_from: qrow(p[0]).fallback_from || null }]);
    if (/^SELECT id, fallback FROM wa_send_jobs/i.test(s)) return rc([job(p[0]) || {}]);
    if (/^UPDATE wa_send_queue SET retried_at=NULL WHERE id=\$1 AND status='skipped'/i.test(s)) { const q = qrow(p[0]); if (q.status === "skipped") q.retried_at = null; return rc([]); }
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return rc([]); }
    if (/^UPDATE wa_send_queue SET status='pending', attempts=GREATEST/i.test(s)) { const q = qrow(p[0]); q.status = "pending"; q.attempts = Math.max(0, (q.attempts || 0) - 1); return rc([]); }
    if (/^INSERT INTO wa_invalid_numbers/i.test(s)) { db.invalid.add(p[0]); return rc([]); }
    // البدء المجدول
    if (/^SELECT id, name, channel, cloud_template, image_url, video_url, start_at FROM wa_send_jobs WHERE status='paused' AND start_at IS NOT NULL AND start_at <= \$1/i.test(s))
      return rc(db.jobs.filter((j) => j.status === "paused" && j.start_at && Date.parse(j.start_at) <= Date.parse(p[0])).map((j) => ({ ...j })));
    if (/^UPDATE wa_send_jobs SET start_at=NULL, start_error=\$3, stop_reason=\$4/i.test(s)) {
      const j = job(p[0]); if (!(j && j.status === "paused" && j.start_at && Date.parse(j.start_at) <= Date.parse(p[1]))) return rc([]);
      Object.assign(j, { start_at: null, start_error: p[2], stop_reason: p[3] }); return rc([{ id: j.id }]);
    }
    if (/^UPDATE wa_send_jobs SET status='running', started_at=COALESCE/i.test(s)) {
      const j = job(p[0]); if (!(j && j.status === "paused" && j.start_at && Date.parse(j.start_at) <= Date.parse(p[1]))) return rc([]);
      Object.assign(j, { status: "running", started_at: iso(clock.t), start_at: null, start_error: null, stop_reason: null }); return rc([{ id: j.id }]);
    }
    if (/^SELECT id, name, status, channel, cloud_template, image_url, video_url, start_at FROM wa_send_jobs WHERE id = ANY/i.test(s)) return rc(db.jobs.filter((j) => p[0].includes(j.id)).map((j) => ({ ...j })));
    if (/^UPDATE wa_send_jobs SET start_at=\$2, start_by=\$3/i.test(s)) { const hit = db.jobs.filter((j) => p[0].includes(j.id) && j.status === "paused"); for (const j of hit) Object.assign(j, { start_at: p[1], start_by: p[2], start_error: null }); return rc(hit.map((j) => ({ id: j.id }))); }
    if (/^UPDATE wa_send_jobs SET start_at=NULL, start_error=NULL WHERE id = ANY/i.test(s)) { const hit = db.jobs.filter((j) => p[0].includes(j.id) && j.start_at); for (const j of hit) j.start_at = null; return rc(hit.map((j) => ({ id: j.id }))); }
    // التحكم
    if (/^SELECT channel FROM wa_send_jobs WHERE id=\$1/i.test(s)) return rc(job(p[0]) ? [{ channel: job(p[0]).channel }] : []);
    if (/^UPDATE wa_send_jobs SET status=\$2, finished_at/i.test(s)) { const j = job(p[0]); if (!j || ["done", "cancelled"].includes(j.status)) return rc([]);
      j.status = p[1]; if (p[1] === "running") { j.stop_reason = null; j.brake_ack_at = iso(clock.t); } if (["running", "cancelled"].includes(p[1])) j.start_at = null; return rc([{ id: j.id }]); }
    if (/^SELECT id, name, channel, cloud_template, image_url, video_url FROM wa_send_jobs WHERE status='paused' AND channel='wa_cloud'/i.test(s)) return rc(db.jobs.filter((j) => j.status === "paused" && j.channel === "wa_cloud").map((j) => ({ ...j })));
    if (/^UPDATE wa_send_jobs SET status=\$2, stop_reason = CASE/i.test(s)) { const hit = db.jobs.filter((j) => j.status === p[0] && (p[2] || j.channel !== "wa_cloud") && !p[3].includes(j.id));
      for (const j of hit) { j.status = p[1]; if (p[1] === "running") { j.stop_reason = null; j.start_at = null; j.brake_ack_at = iso(clock.t); } } return rc(hit.map((j) => ({ id: j.id }))); }
    if (/^UPDATE wa_send_queue SET status='skipped', reason='cancelled' WHERE job_id/i.test(s)) { for (const q of db.queue) if (q.job_id === p[0] && q.status === "pending") Object.assign(q, { status: "skipped", reason: "cancelled" }); return rc([]); }
    if (/^UPDATE wa_send_queue SET retry_at=NULL WHERE job_id=\$1/i.test(s)) { for (const q of db.queue) if (q.job_id === p[0] && q.retry_at) q.retry_at = null; return rc([]); }
    // النتايج وقايمة المستلمين
    if (/^SELECT \* FROM wa_send_jobs WHERE id=\$1/i.test(s)) return rc(job(p[0]) ? [{ ...job(p[0]) }] : []);
    if (/^SELECT phone_norm pn, status, reason, sent_at/i.test(s)) return rc(db.queue.filter((q) => q.job_id === Number(p[0])).map((q) => ({ pn: q.phone_norm, ...q })));
    if (/count\(DISTINCT so\.order_no\)/i.test(s)) return rc([{ n: 0, rev: 0 }]);
    if (/^SELECT q\.id, q\.phone_norm, q\.name, q\.status/i.test(s)) return rc(db.queue.filter((q) => q.job_id === Number(p[0])).map((q) => ({ retry_at: null, retried_at: null, first_error_code: null, ...q })));
    return rc([]);
  } };
  const fetch = async (url, init = {}) => {
    const m = media[url] || media["*"] || { mime: "image/jpeg", bytes: 200000 };
    if (init.method === "HEAD") { db.heads++; return { ok: m.ok !== false, status: m.ok === false ? 503 : 200, headers: { get: (h) => (h === "content-type" ? m.mime : String(m.bytes)) } }; }
    return { ok: false, status: 500 };
  };
  const sent = [];
  let i = 0;
  const hooks = { status: [], inbound: [], quality: [] };
  const wa = { gate: async () => null, on: (ev, fn) => hooks[ev].push(fn),
    async sendTemplate(a) {
      sent.push(a); const r = script[i++] || { ok: true, wamid: `wamid.N${sent.length}` };
      db.msgs.push({ wamid: r.wamid || null, phone_norm: a.phoneNorm, template: a.template, source: a.source, status: r.ok ? "accepted" : "failed" });
      return r;
    } };
  const cloud = { phoneInfo: async () => ({ ok: true, status: "CONNECTED", quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, checkedAt: iso(clock.t) }),
    templateInfo: async () => ({ ok: true, list: [] }) };
  const app = fakeApp();
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), canSeePhones: async () => false };
  const api = S.register(app, ctx, { wa, fetch, cloud: () => cloud, cloudLoop: false, lock: false, now: () => clock.t, cms: () => null,
    sendSms: async (m) => { db.sms.push(m); return { ok: true }; },
    sessionUser: async (t) => (t === "cms:mk" ? { name: "تسويق", role: "marketing" } : { name: "عمر", role: "owner" }) });
  return { db, app, api, sent, clock, hooks, pool };
}
const J = (x = {}) => ({ id: 1, name: "عرض الخميس", status: "running", channel: "wa_cloud", cloud_template: "fc_offer_img", cloud_vars: { offer: "كيلو بـ96" }, image_url: IMG, video_url: null,
  link_slug: "w1", offer: null, fallback: "none", spend_cap_sar: null, rate_sar: 0.2159, stop_reason: null, brake_ack_at: null, start_at: null, ...x });
const Q = (id, x = {}) => ({ id, job_id: 1, phone_norm: `5200000${String(id).padStart(2, "0")}`, status: "pending", channel: "wa_cloud", name: "عميل تجربة", vars: { first_name: "عميل" },
  link_code: `c${id}`, coupon: null, attempts: 0, message: "-", ...x });

// ───────── (ب) الإعادة التلقائية ─────────
test("حادثة ١٥/١٠: 131000 من الويب هوك ⇒ مش «فشل» نهائي — إعادة واحدة بعد ١٠ دقايق، بعد فحص الصورة وإن الأولى ماوصلتش", async () => {
  const w = world({ jobs: [J()], queue: [Q(1), Q(2)] });
  await w.api.schemaReady;
  assert.equal((await w.api.cloudTick()).sent, 2);
  const [a] = w.db.queue;
  const firstWamid = a.wamid;
  assert.equal(w.db.contactLog.filter((l) => l.pn === a.phone_norm).length, 1);
  // ميتا: 131000 للرسالة الأولى (ماقدرتش تنزّل صورة الهيدر والسيرفر بيعمل ريستارت)
  w.db.msgs.find((m) => m.wamid === firstWamid).status = "failed";
  await w.api.onCloudStatus({ wamid: firstWamid, status: "failed", code: 131000 });
  assert.equal(a.status, "failed"); assert.equal(a.reason, "meta_error"); assert.equal(a.retry_at, iso(AT_17 + 10 * MIN));
  assert.equal(w.db.contactLog.filter((l) => l.pn === a.phone_norm).length, 0, "سجل التواصل اترفع لحد ما الإعادة تنجح");
  // الحملة خلصت؟ لأ — فيها صف مستني إعادة
  await w.api.cloudTick();
  assert.equal(w.db.jobs[0].status, "running"); assert.equal(w.sent.length, 2, "قبل الميعاد مفيش إعادة");
  // بعد ١٠ دقايق
  w.clock.t = AT_17 + 10 * MIN;
  const heads = w.db.heads;
  const r = await w.api.cloudTick();
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(r.retried, 1);
  assert.equal(w.db.heads, heads + 1, "الصورة اتفحصت من السيرفر قبل الإعادة");
  assert.equal(w.sent.length, 3); assert.equal(w.sent[2].phoneNorm, a.phone_norm);
  assert.equal(a.status, "sent"); assert.ok(a.retried_at); assert.equal(a.first_wamid, firstWamid); assert.notEqual(a.wamid, firstWamid); assert.equal(a.first_error_code, 131000);
  assert.equal(w.db.contactLog.filter((l) => l.pn === a.phone_norm).length, 1);
  // خلصت دلوقتي
  await w.api.cloudTick();
  assert.equal(w.db.jobs[0].status, "done");
  // النتايج: اتعادت ونجحت، بالعربي
  const res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.equal(res.body.retried, 1); assert.equal(res.body.retry_ok, 1);
  assert.deepEqual(res.body.retry, { waiting: 0, retried: 1, ok: 1, delivered: 0, failedAgain: 0, deliveredLate: 0, expired: 0 });
  assert.equal(res.body.failed, 0);
});

test("مفيش رسالة مكررة: «وصلت» بعد «فشلت» ⇒ الصف يرجع «اتبعتت» والإعادة تتلغي؛ ولو الـwamid الأول طلع واصل وقت الإعادة ⇒ مفيش إرسال", async () => {
  const w = world({ jobs: [J()], queue: [Q(1), Q(2)] });
  await w.api.schemaReady;
  await w.api.cloudTick();
  const [a, b] = w.db.queue;
  await w.api.onCloudStatus({ wamid: a.wamid, status: "failed", code: 131000 });
  assert.ok(a.retry_at);
  await w.api.onCloudStatus({ wamid: a.wamid, status: "delivered", at: iso(AT_17 + MIN) });
  assert.deepEqual([a.status, a.retry_at, a.cloud_status, a.note], ["sent", null, "delivered", "delivered_after_failure"]);
  assert.equal(w.db.contactLog.filter((l) => l.pn === a.phone_norm).length, 1, "اتحسبت «اتكلّم» تاني");
  // b: الويب هوك حدّث wa_messages (واصلة) بس صف الطابور فضل «فشل — مستني إعادة» ⇒ وقت الإعادة بنكتشف ومانبعتش
  await w.api.onCloudStatus({ wamid: b.wamid, status: "failed", code: 131000 });
  w.db.msgs.find((m) => m.wamid === b.wamid).status = "delivered";
  w.clock.t = AT_17 + 11 * MIN;
  const r = await w.api.cloudTick();
  assert.equal(r.deliveredLate, 1); assert.equal(w.sent.length, 2, "ولا رسالة تانية");
  assert.deepEqual([b.status, b.cloud_status, b.note, b.retried_at], ["sent", "delivered", "delivered_after_failure", null]);
  const res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.equal(res.body.retry.deliveredLate, 2); assert.equal(res.body.retried, 0);
});

test("مرة واحدة بس: الإعادة فشلت تاني ⇒ «فشل» نهائي؛ 131053 بعد الإعادة ⇒ الحملة تقف (الوسيط بايظ فعلاً) وتنبيه للمالك", async () => {
  const w = world({ jobs: [J()], queue: [Q(1), Q(2), Q(3), Q(4)], settings: { waCloud: { enabled: true, perTick: 2 } } });
  await w.api.schemaReady;
  await w.api.cloudTick();
  const [a, b] = w.db.queue;
  await w.api.onCloudStatus({ wamid: a.wamid, status: "failed", code: 131000 });
  await w.api.onCloudStatus({ wamid: b.wamid, status: "failed", code: 131053 });
  assert.ok(a.retry_at && b.retry_at, "131053 كمان بتتعاد (مابقتش بتوقّف القناة)");
  assert.equal(w.db.state[2].stopped_reason, undefined);
  w.clock.t = AT_17 + 10 * MIN;
  assert.equal((await w.api.cloudTick()).retried, 2);
  await w.api.onCloudStatus({ wamid: a.wamid, status: "failed", code: 131000 });
  assert.deepEqual([a.status, a.retry_at || null, a.reason], ["failed", null, "meta_error"], "مفيش إعادة تانية");
  await w.api.onCloudStatus({ wamid: b.wamid, status: "failed", code: 131053 });
  assert.equal(b.retry_at || null, null);
  assert.equal(w.db.jobs[0].status, "paused"); assert.equal(w.db.jobs[0].stop_reason, "media:media_error");
  assert.equal(w.db.sms.length, 1); assert.match(w.db.sms[0].body, /Fresh Cuts|فريش كاتس/);
  const res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.equal(res.body.retry.failedAgain, 2); assert.equal(res.body.retry_ok, 0);
  assert.deepEqual(res.body.reasons.map((x) => [x.reason, x.n, x.text]), [["media_error", 1, "ميتا ماقدرتش تنزّل الصورة/الفيديو بتاع الرسالة"], ["meta_error", 1, "غلطة مؤقتة عند ميتا (131000)"]]);
});

test("إعادة لقت العميل وصله رسالة تانية في النص ⇒ بتتخطّى (حد الـ٧ أيام) ومابتتحسبش «اتعادت»، والسبب بالعربي", async () => {
  const w = world({ jobs: [J()], queue: [Q(1)] });
  await w.api.schemaReady;
  await w.api.cloudTick();
  const a = w.db.queue[0];
  await w.api.onCloudStatus({ wamid: a.wamid, status: "failed", code: 131000 });
  w.db.contactLog.push({ pn: a.phone_norm, job: 9, by: "cloud" });          // حملة تانية وصلته في النص
  w.clock.t = AT_17 + 10 * MIN;
  const r = await w.api.cloudTick();
  assert.equal(r.skipped, 1); assert.equal(w.sent.length, 1, "مفيش رسالة تانية");
  assert.deepEqual([a.status, a.reason, a.retried_at], ["skipped", "gap_7d", null]);
  const res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.equal(res.body.retried, 0);
  assert.deepEqual(res.body.reasons, [{ status: "skipped", reason: "gap_7d", n: 1, text: "وصلته رسالة واتساب في آخر ٧ أيام" }]);
  assert.equal(w.db.jobs[0].status, "done");
});

test("مابتتعادش أبداً: 131049 (ميتا حدّت تسويق العميل)، 131026 (مش على واتساب)، تجربة ميتا — والسبب بالعربي في النتايج وقايمة المستلمين", async () => {
  const w = world({ jobs: [J()], queue: [Q(1), Q(2), Q(3)] });
  await w.api.schemaReady;
  await w.api.cloudTick();
  const [a, b, c] = w.db.queue;
  await w.api.onCloudStatus({ wamid: a.wamid, status: "failed", code: 131049 });
  await w.api.onCloudStatus({ wamid: b.wamid, status: "failed", code: 131026 });
  await w.api.onCloudStatus({ wamid: c.wamid, status: "failed", code: 130472 });
  for (const q of [a, b, c]) assert.equal(q.retry_at || null, null, q.reason);
  assert.ok(w.db.invalid.has(b.phone_norm));
  w.clock.t = AT_17 + 30 * MIN;
  await w.api.cloudTick();
  assert.equal(w.sent.length, 3, "ولا إعادة");
  const res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  const t = Object.fromEntries(res.body.reasons.map((x) => [x.reason, x.text]));
  assert.equal(t.meta_marketing_limit, "ميتا مابتوصّلش رسايل تسويق كتير للعميل ده");
  assert.equal(t.undeliverable, "الرقم مش على واتساب");
  assert.equal(res.body.cloud.reasonsAr.undeliverable, "الرقم مش على واتساب");
  const items = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/items", { param: { id: "1" } });
  assert.deepEqual(items.body.items.map((x) => x.reason_ar).sort(), ["الرقم مش على واتساب", "العميل في تجربة عند ميتا مابتوصّلش له رسايل تسويق", "ميتا مابتوصّلش رسايل تسويق كتير للعميل ده"].sort());
  assert.ok(items.body.items.every((x) => /••••/.test(x.phone_norm)), "الجوال مخفي");
});

test("فشل مؤقت وقت الإرسال نفسه (ميتا رفضت بكود): إعادة مجدولة من غير ما القناة تقف؛ والإعادة اتعطّلت ⇒ «فشل» عادي، واللي كان مستني بيتلغي", async () => {
  const w = world({ jobs: [J()], queue: [Q(1), Q(2)], script: [{ ok: false, error: "WA_131000", code: 131000 }, { ok: false, error: "WA_131053", code: 131053 }] });
  await w.api.schemaReady;
  const r = await w.api.cloudTick();
  assert.equal(r.failed, 2); assert.equal(r.retryLater, 2); assert.equal(r.stopped, undefined, "131053 مابقتش بتوقّف القناة");
  assert.equal(w.db.state[2].stopped_reason, undefined);
  assert.ok(w.db.queue.every((q) => q.status === "failed" && q.retry_at));
  // المالك قفل الإعادة التلقائية ⇒ المستني بيتلغي ومابيتبعتش
  w.db.settings.waCloud.retryTransient = false;
  w.clock.t = AT_17 + 15 * MIN;
  await w.api.cloudTick();
  assert.equal(w.sent.length, 2);
  assert.deepEqual(w.db.queue.map((q) => [q.status, q.retry_at, q.note]), [["failed", null, "retry_off"], ["failed", null, "retry_off"]]);
  // من غير إعادة: نفس الغلطة = فشل نهائي على طول
  const x = world({ jobs: [J()], queue: [Q(1)], settings: { waCloud: { enabled: true, retryTransient: false } }, script: [{ ok: false, error: "WA_131000", code: 131000 }] });
  await x.api.schemaReady; await x.api.cloudTick();
  assert.deepEqual([x.db.queue[0].status, x.db.queue[0].retry_at || null], ["failed", null]);
});

test("الإعادة ليها عمر: لو ماتبعتتش خلال retryMaxHours من ميعادها (بره ساعات الإرسال / القناة مقفولة) بتتلغي — مفيش رسالة حملة تاني يوم", async () => {
  const w = world({ jobs: [J()], queue: [Q(1, { status: "failed", reason: "meta_error", error_code: 131000, cloud_status: "failed", retry_at: iso(AT_17 - 4 * 3600e3), wamid: "wamid.OLD" })] });
  await w.api.schemaReady;
  await w.api.cloudTick();
  assert.equal(w.sent.length, 0);
  assert.deepEqual([w.db.queue[0].retry_at, w.db.queue[0].note], [null, "retry_expired"]);
});

test("الوسيط مابيفتحش وقت الإعادة ⇒ مفيش إرسال والإعادة ماتتحسبش (تستنى)؛ ولو فضل كده ١٠ دقايق ⇒ الحملة تقف بسبب واضح وتنبيه", async () => {
  const w = world({ jobs: [J()], queue: [Q(1, { status: "failed", reason: "meta_error", error_code: 131000, cloud_status: "failed", retry_at: iso(AT_17 - MIN), wamid: "wamid.OLD" }), Q(2)],
    media: { [IMG]: { ok: false } } });
  await w.api.schemaReady;
  const r = await w.api.cloudTick();
  assert.equal(r.reason, "media_unreachable"); assert.equal(w.sent.length, 0, "ولا رسالة — حتى الصف الجديد");
  const a = w.db.queue[0];
  assert.deepEqual([a.status, a.retried_at, a.error_code, a.reason], ["failed", null, 131000, "meta_error"]);
  assert.equal(a.retry_at, iso(AT_17 + 10 * MIN));
  // الصف الجديد كمان مستني (الحملة اتشك في وسيطها)
  w.clock.t = AT_17 + 10 * MIN;
  const r2 = await w.api.cloudTick();
  assert.equal(r2.reason, "media_unreachable");
  w.clock.t = AT_17 + 11 * MIN;
  await w.api.cloudTick();
  assert.equal(w.db.jobs[0].status, "paused"); assert.equal(w.db.jobs[0].stop_reason, "media:media_unreachable");
  assert.equal(w.db.sms.length, 1); assert.equal(w.sent.length, 0);
});

test("ريستارت في نص الإرسال: صف علق في «بيتبعت» بس ميتا كانت قبلته ⇒ «اتبعتت» من غير ما يتبعت تاني", async () => {
  const w = world({ jobs: [J()], queue: [Q(1, { status: "sending", attempts: 1, _stale: true }), Q(2, { status: "sending", attempts: 1, _stale: true })],
    msgs: [{ wamid: "wamid.BEFORE", phone_norm: "520000001", template: "fc_offer_img", source: "campaign", status: "accepted" }] });
  await w.api.schemaReady;
  await w.api.cloudTick();
  assert.deepEqual([w.db.queue[0].status, w.db.queue[0].wamid, w.db.queue[0].note], ["sent", "wamid.BEFORE", "recovered_after_restart"]);
  assert.equal(w.sent.filter((x) => x.phoneNorm === "520000001").length, 0, "الأول ماتبعتش تاني");
  assert.equal(w.sent.filter((x) => x.phoneNorm === "520000002").length, 1, "التاني (ميتا ماستلمتهوش) رجع للطابور واتبعت");
  assert.equal(w.db.contactLog.filter((l) => l.pn === "520000001").length, 1);
});

// ───────── (أ) البدء المجدول + (ج) فحص الوسيط ─────────
test("البدء المجدول من السيرفر: قبل الميعاد مفيش حاجة، بعده الحملة بتشتغل وتبعت في نفس الدورة — الشرط «<=» فالريستارت مابيفوّتوش", async () => {
  const w = world({ jobs: [J({ status: "paused", start_at: iso(AT_17 + 30 * MIN) }), J({ id: 2, status: "paused", channel: "wa_web", start_at: iso(AT_17 + 30 * MIN) })], queue: [Q(1)] });
  await w.api.schemaReady;
  assert.deepEqual(await w.api.startDueJobs(), { started: [], refused: [], late: [] });
  assert.equal(w.db.jobs[0].status, "paused");
  // السيرفر كان واقف من ١٧:٢٥ لـ١٧:٤٥ — أول دورة بعد ما يقوم
  w.clock.t = AT_17 + 45 * MIN;
  const st = await w.api.startDueJobs();
  assert.deepEqual(st.started, [1, 2]);
  assert.deepEqual(w.db.jobs.map((j) => [j.status, j.start_at]), [["running", null], ["running", null]]);
  assert.equal((await w.api.cloudTick()).sent, 1);
  assert.equal((await w.api.startDueJobs()).started.length, 0, "مرة واحدة بس");
});

test("البدء المجدول: الصورة مابتفتحش ⇒ مابتبدأش وسبب بالعربي + تنبيه؛ فات الميعاد بأكتر من startLateMaxMin ⇒ تستنى المالك", async () => {
  const BAD = "https://freshcuts-api.o2m8.me/api/content/media/404.jpg";
  const w = world({ jobs: [J({ status: "paused", image_url: BAD, start_at: iso(AT_17 - MIN) }), J({ id: 2, name: "موجة ٢", status: "paused", start_at: iso(AT_17 - 3 * 3600e3) }), J({ id: 3, status: "paused", start_at: iso(AT_17 - 60 * MIN) })],
    media: { [BAD]: { ok: false } } });
  await w.api.schemaReady;
  const st = await w.api.startDueJobs();
  assert.deepEqual(st.started, [3], "متأخرة ساعة (أقل من ١٢٠ دقيقة) بتبدأ");
  assert.deepEqual(st.refused, [{ id: 1, error: "media_unreachable" }]); assert.deepEqual(st.late, [2]);
  const [a, b] = w.db.jobs;
  assert.deepEqual([a.status, a.start_at, a.stop_reason], ["paused", null, "preflight:media_unreachable"]); assert.match(a.start_error, /^مابدأتش: الرابط مابيفتحش/);
  assert.deepEqual([b.status, b.start_at, b.stop_reason], ["paused", null, "start_late:180"]); assert.match(b.start_error, /فات ميعاد البدء بـ180 دقيقة/);
  assert.equal(w.db.sms.length, 2, "تنبيه لكل واحدة");
  assert.equal((await w.api.startDueJobs()).refused.length, 0, "التنبيه مرة واحدة");
  // نفس الحدود من اللوحة
  const v = world({ jobs: [J({ status: "paused", start_at: iso(AT_17 - 3 * 3600e3) })], settings: { waCloud: { enabled: true, startLateMaxMin: 240 } } });
  await v.api.schemaReady;
  assert.deepEqual((await v.api.startDueJobs()).started, [1]);
});

test("أول ما السيرفر يقوم بيبص على المواعيد اللي فاتت (من غير ما يستنى الدورة)", async () => {
  const saved = process.env.WA_CLOUD_TICK_SEC; process.env.WA_CLOUD_TICK_SEC = "3600";
  try {
    const db = { jobs: [J({ status: "paused", channel: "wa_web", start_at: iso(AT_17 - 5 * MIN) })] };
    const pool = { async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^SELECT id, name, channel, cloud_template, image_url, video_url, start_at FROM wa_send_jobs WHERE status='paused'/.test(s)) return { rows: db.jobs.filter((j) => j.status === "paused" && j.start_at && Date.parse(j.start_at) <= Date.parse(p[0])) };
      if (/^UPDATE wa_send_jobs SET status='running', started_at=COALESCE/.test(s)) { const j = db.jobs.find((x) => x.id === p[0]); j.status = "running"; return { rows: [{ id: j.id }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    } };
    const api = S.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => ({}) }, { now: () => AT_17, cms: () => null });      // من غير cloudLoop:false — زي الإنتاج
    await api.schemaReady; await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.jobs[0].status, "running");
  } finally { if (saved === undefined) delete process.env.WA_CLOUD_TICK_SEC; else process.env.WA_CLOUD_TICK_SEC = saved; }
});

test("جدولة من اللوحة: حملة واحدة أو موجة مرة واحدة؛ حملة Cloud للمالك بس؛ الشغّالة والوسيط البايظ بيتقالوا بالعربي؛ وشيل الميعاد", async () => {
  const BAD = "https://freshcuts-api.o2m8.me/api/content/media/404.jpg";
  const w = world({ jobs: [J({ status: "paused" }), J({ id: 2, status: "paused", name: "موجة ٢" }), J({ id: 3, status: "running" }), J({ id: 4, status: "paused", image_url: BAD })], media: { [BAD]: { ok: false } } });
  await w.api.schemaReady;
  const R = "POST /api/cms/wa-sender/schedule";
  assert.equal((await call(w.app, R, { json: { jobIds: [1], startAt: "2026-10-15T18:00" }, auth: MK })).status, 403);
  assert.equal((await call(w.app, R, { json: { jobIds: [1], startAt: "2026-10-15T16:00" } })).body.error, "start_at_past");
  assert.equal((await call(w.app, R, { json: { jobIds: [], startAt: "2026-10-15T18:00" } })).body.error, "no_jobs");
  const r = await call(w.app, R, { json: { jobIds: [1, 2, 3, 4, 99], startAt: "2026-10-15T18:00" } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.scheduled, [1, 2]); assert.equal(r.body.startAtRiyadh, "2026-10-15 18:00");
  assert.deepEqual(r.body.skipped.map((x) => [x.id, x.error]), [[99, "not_found"], [3, "status_running"], [4, "media_unreachable"]]);
  assert.match(r.body.skipped.find((x) => x.id === 4).message, /^ماتجدولتش: الرابط مابيفتحش/);
  assert.deepEqual(w.db.jobs.map((j) => j.start_at), ["2026-10-15T15:00:00.000Z", "2026-10-15T15:00:00.000Z", null, null]);
  assert.equal(w.db.jobs[0].start_by, "عمر");
  // حملة واحدة: تعديل الميعاد، وبعدين شيله
  const one = await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "2", action: "schedule" }, json: { startAt: "2026-10-15T19:30" } });
  assert.equal(one.status, 200); assert.equal(w.db.jobs[1].start_at, "2026-10-15T16:30:00.000Z");
  const off = await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "2", action: "schedule" }, json: { startAt: null } });
  assert.deepEqual(off.body.cleared, [2]); assert.equal(w.db.jobs[1].start_at, null);
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "3", action: "schedule" }, json: { startAt: "2026-10-15T19:30" } })).status, 409);
  // التكملة اليدوية بتشيل الميعاد
  await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" } });
  assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].start_at], ["running", null]);
});

test("التكملة اليدوية بتفحص الوسيط: مابيفتحش ⇒ مفيش تكملة وسبب واضح؛ «كمّل الكل» بيسيب اللي وسيطه بايظ ويقول ليه", async () => {
  const BAD = "https://freshcuts-api.o2m8.me/api/content/media/404.jpg";
  const w = world({ jobs: [J({ status: "paused", image_url: BAD }), J({ id: 2, status: "paused" })], media: { [BAD]: { ok: false } } });
  await w.api.schemaReady;
  const r = await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" } });
  assert.equal(r.status, 422); assert.equal(r.body.error, "media_unreachable"); assert.match(r.body.message, /^الحملة ماكمّلتش: الرابط مابيفتحش \(HTTP 503\)/);
  assert.equal(w.db.jobs[0].status, "paused");
  const all = await call(w.app, "POST /api/cms/wa-sender/all/:action", { param: { action: "resume" } });
  assert.equal(all.body.changed, 1); assert.deepEqual(all.body.refused.map((x) => [x.id, x.error]), [[1, "media_unreachable"]]);
  assert.deepEqual(w.db.jobs.map((j) => j.status), ["paused", "running"]);
  // الإلغاء = مفيش إعادة للي كان مستني
  const c = world({ jobs: [J()], queue: [Q(1, { status: "failed", retry_at: iso(AT_17 + 5 * MIN), reason: "meta_error" }), Q(2)] });
  await c.api.schemaReady;
  await call(c.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "cancel" } });
  assert.deepEqual(c.db.queue.map((q) => [q.status, q.retry_at || null]), [["failed", null], ["skipped", null]]);
});

test("حملة جديدة بميعاد: بتتحفظ موقوفة وعليها الميعاد (والوسيط اتفحص)، وميعاد غلط بيترفض قبل أي حفظ", async () => {
  const w = world();
  const inserted = [];
  const q0 = w.pool.query.bind(w.pool);
  w.pool.query = async (sql, p = []) => { const s = String(sql).replace(/\s+/g, " ").trim(); if (/^INSERT INTO wa_send_jobs/i.test(s)) { inserted.push(p); return { rows: [{ id: 77 }], rowCount: 1 }; } return q0(sql, p); };
  const rows = Array.from({ length: 3 }, (_, i) => ({ pn: `51000000${i}`, name: `عميل ${i}`, orders: 2, spend: 100, daysAgo: 40, lastTotal: 60, score: 1, vars: { first_name: `عميل${i}` } }));
  const app = fakeApp();
  S.register(app, { pool: w.pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(w.db.settings)) },
    { wa: { gate: async () => null, on: () => {}, sendTemplate: async () => ({ ok: true }) }, fetch: async (u, i = {}) => { if (i.method === "HEAD") w.db.heads++; return { ok: true, status: 200, headers: { get: (h) => (h === "content-type" ? "image/jpeg" : "1000") } }; },
      outreach: { AUDIENCES: { lapsed: { label: "غايبين" } }, audienceRows: async () => rows, cfg: async () => ({ template: "أهلاً {name}" }) },
      cloudLoop: false, lock: false, now: () => AT_17, cms: () => null, cloud: () => ({ templateInfo: async () => ({ ok: true, list: [] }) }), sessionUser: async () => ({ name: "عمر", role: "owner" }) });
  const body = { channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: IMG, cloudVars: { offer: "كيلو بـ96" }, filters: { audience: "lapsed" }, name: "موجة ١٨:٠٠" };
  const bad = await call(app, "POST /api/cms/wa-sender/jobs", { json: { ...body, startAt: "2026-10-15T10:00" } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error, "start_at_past"); assert.equal(inserted.length, 0);
  const ok = await call(app, "POST /api/cms/wa-sender/jobs", { json: { ...body, startAt: "2026-10-15T18:00", confirmCount: 3 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.status, ok.body.startAt, ok.body.startAtRiyadh], ["paused", "2026-10-15T15:00:00.000Z", "2026-10-15 18:00"]);
  assert.deepEqual([inserted[0][17], inserted[0][18], inserted[0][19]], ["paused", "2026-10-15T15:00:00.000Z", "عمر"]);
  assert.equal(w.db.heads, 1, "الصورة اتفحصت قبل الحفظ");
  // من غير ميعاد: زي الأول (شغّالة على طول)
  const now = await call(app, "POST /api/cms/wa-sender/jobs", { json: body });
  assert.deepEqual([now.body.status, inserted[1][17], inserted[1][18]], ["running", "running", null]);
});

test("الحارس في المصدر: الإعادة مابتعدّيش الحارس (نفس sendTemplate)، ومفيش cron ولا مؤقّت بره المحرّك", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./wasender.js", import.meta.url), "utf8");
  assert.match(src, /start_at <= \$1::timestamptz/, "شرط البدء «<=» مش «=»");
  assert.match(src, /schemaReady\.then\(\(\) => startDueJobs\(\)\)/, "فحص المواعيد أول ما السيرفر يقوم");
  assert.equal((src.match(/wa\.sendTemplate\(/g) || []).length, 2, "إرسال الحملة + التجربة بس — الإعادة بتمشي من sendCloudRow نفسه");
  assert.match(src, /COALESCE\(error_code,0\) <> \$\{META_CAPPED_CODE\} AND retry_at IS NULL\)::int AS failed/, "الفرامل مابتعدّش المستني إعادة كفشل");
  assert.match(src, /q\.status = 'failed' AND q\.retry_at IS NOT NULL AND j\.status IN \('running','paused'\)/, "المستني إعادة = لسه في طابور حملته (مايدخلش حملة تانية)");
});

// ───────── (ج) الفرامل: من بعد آخر «كمّل»، والفشل المؤقت اللي اتعاد ونجح مش محسوب ─────────
test("نافذة الفرامل (دالة صافية): المحاولات من بعد آخر «كمّل» بس؛ المستني إعادة و131049 بره؛ اللي اتعاد ونجح = «اتبعتت»", () => {
  const ACK = iso(AT_17), old = iso(AT_17 - 60 * MIN), neu = iso(AT_17 + 5 * MIN);
  const rows = [
    { channel: "wa_cloud", status: "failed", error_code: 131026, tried_at: old },                       // قبل التكملة ⇒ بره
    { channel: "wa_cloud", status: "sent", cloud_status: "delivered", tried_at: neu },
    { channel: "wa_cloud", status: "sent", cloud_status: "accepted", retried_at: neu, first_error_code: 131000, tried_at: neu },   // اتعاد ونجح
    { channel: "wa_cloud", status: "failed", error_code: 131000, retry_at: iso(AT_17 + 15 * MIN), tried_at: neu },               // مستني إعادة
    { channel: "wa_cloud", status: "failed", error_code: 131049, tried_at: neu },                       // ميتا حدّت العميل — بره النسبة
    { channel: "wa_cloud", status: "failed", error_code: 131026, tried_at: neu },
    { channel: "wa_cloud", status: "sent", cloud_status: "read", optout_at: neu, tried_at: neu },
    { channel: "wa_cloud", status: "sent", claimed_at: neu },                                           // صف قديم من غير tried_at
    { channel: "wa_web", status: "failed", tried_at: neu },                                             // مش Cloud
  ];
  assert.deepEqual(C.brakeWindow(rows, ACK), { since: ACK, sent: 4, failed: 1, stopped: 1 });
  assert.deepEqual(C.brakeWindow(rows, null), { since: null, sent: 4, failed: 2, stopped: 1 }, "من غير تكملة = كل الحملة");
  const v = C.brakeView(C.brakeWindow(rows, ACK), C.cloudCfg({}));
  assert.deepEqual([v.tried, v.failPct, v.stopPct, v.failLimit, v.minSends, v.armed], [5, 20, 25, 10, 30, false]);
});

test("حادثة ١٥/١٠: الفرامل وقّفت الحملة ⇒ «كمّل» من المالك مابتوقّفهاش تاني على طول (النسبة بتبدأ من لحظة التكملة) — ولو الفشل رجع بجد بتقف تاني", async () => {
  const old = iso(AT_17 - 60 * MIN);
  const before = [...Array.from({ length: 27 }, (_, i) => Q(i + 1, { status: "sent", cloud_status: "delivered", tried_at: old, sent_at: old })),
    ...[28, 29, 30].map((id) => Q(id, { status: "failed", cloud_status: "failed", reason: "undeliverable", error_code: 131026, tried_at: old }))];
  const pend = Array.from({ length: 40 }, (_, i) => Q(100 + i));
  const w = world({ jobs: [J()], queue: [...before, ...pend], settings: { waCloud: { enabled: true, perTick: 10 } } });
  await w.api.schemaReady;
  const r0 = await w.api.cloudTick();
  assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].stop_reason, w.sent.length], ["paused", "fail_rate:10", 0], JSON.stringify(r0));
  // المالك كمّل ⇒ العدّ من دلوقتي: ٣ فشل قدام مابقوش بيتحسبوا
  assert.equal((await call(w.app, "POST /api/cms/wa-sender/jobs/:id/:action", { param: { id: "1", action: "resume" } })).status, 200);
  assert.equal(w.db.jobs[0].brake_ack_at, iso(AT_17));
  w.clock.t = AT_17 + MIN;
  const r1 = await w.api.cloudTick();
  assert.equal(r1.sent, 10, JSON.stringify(r1)); assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].stop_reason], ["running", null], "مابتقفش تاني على طول");
  // فشل مؤقت (131000) من الويب هوك على رسالة من بعد التكملة ⇒ مستني إعادة، مش فشل في النسبة؛ وبعد الإعادة الناجحة = «اتبعتت»
  const t = w.db.queue.find((q) => q.id === 100);
  await w.api.onCloudStatus({ wamid: t.wamid, status: "failed", code: 131000 });
  assert.ok(t.retry_at);
  // النتايج: الفرامل بتعدّ من التكملة، والنسبة صفر
  let res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.deepEqual([res.body.brake.since, res.body.brake.sinceRiyadh, res.body.brake.tried, res.body.brake.failed, res.body.brake.failPct, res.body.brake.armed],
    [iso(AT_17), "2026-10-15 17:00", 9, 0, 0, false]);
  w.clock.t = AT_17 + 11 * MIN;
  const r2 = await w.api.cloudTick();
  assert.equal(r2.retried, 1, JSON.stringify(r2)); assert.equal(t.status, "sent");
  res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.equal(res.body.brake.failed, 0, "الفشل المؤقت اللي اتعاد ونجح مش محسوب");
  // الفشل الحقيقي رجع من بعد التكملة (٣ من ٣٠ = ١٠٪) ⇒ تقف تاني بنفس الحد
  for (const q of w.db.queue.filter((x) => x.status === "sent" && x.tried_at && Date.parse(x.tried_at) > AT_17).slice(0, 3)) {
    await w.api.onCloudStatus({ wamid: q.wamid, status: "failed", code: 131026 });
  }
  w.clock.t = AT_17 + 12 * MIN;
  for (let i = 0; i < 3 && w.db.jobs[0].status === "running"; i++) await w.api.cloudTick();
  assert.equal(w.db.jobs[0].status, "paused"); assert.match(w.db.jobs[0].stop_reason, /^fail_rate:/);
  res = await call(w.app, "GET /api/cms/wa-sender/jobs/:id/results", { param: { id: "1" } });
  assert.ok(res.body.brake.tried >= 30 && res.body.brake.failPct >= 10, JSON.stringify(res.body.brake));
  assert.equal(res.body.brake.failed, 3, "الـ٣ القديمين قبل التكملة مش منهم");
});

test("سقف صرف الحملة فاضل على كل الرسايل (الفلوس اتصرفت فعلاً) — التكملة بتصفّر الفرامل بس", async () => {
  const old = iso(AT_17 - 60 * MIN);
  const before = Array.from({ length: 10 }, (_, i) => Q(i + 1, { status: "sent", cloud_status: "delivered", tried_at: old, sent_at: old }));
  const w = world({ jobs: [J({ spend_cap_sar: 2.5, rate_sar: 0.25, brake_ack_at: iso(AT_17 - 30 * MIN) })], queue: [...before, Q(50)] });
  await w.api.schemaReady;
  const r = await w.api.cloudTick();
  assert.equal(r.sent || 0, 0, JSON.stringify(r)); assert.deepEqual([w.db.jobs[0].status, w.db.jobs[0].stop_reason], ["paused", "campaign_spend_cap"]);
});
