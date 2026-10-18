/* RV1 — التقييم بالنجوم جوّه واتساب لكل أنواع الطلبات (عمر ١٥/١٠/٢٠٢٦). القواعد الصافية (wareviews.js) + المسح في reviews.js (قاعدة مزيّفة، من غير شبكة).
     node --test wa-rv1.test.mjs
   الرحلة على واتساب نفسها (قايمة النجوم ⇒ جوجل / الاعتذار والمدير) في wabotrun.test.mjs «RV1: …». */
import test from "node:test";
import assert from "node:assert/strict";

process.env.REVIEW_INVITE_MINUTES = "0";      // مفيش مؤقّت: بننادي runInvites بإيدنا بوقت ثابت
process.env.REVIEWS_GOOGLE_JOB = "0";
const RV = await import("./wareviews.js");
const reviews = await import("./reviews.js");
const CAT = await import("./watemplates.js");

const Z = (s) => new Date(s);
const F0 = RV.reviewFlowConfig({});

/* ═══ القواعد الصافية ═══════════════════════════════════════════════════ */
test("quiet hours 23:30 → 11:30 Riyadh push a due ask to 13:00 (same day after midnight, next day before it); 11:30–13:00 sends normally; from = to ⇒ no quiet", () => {
  assert.deepEqual(RV.quietWindow(F0), { from: 1410, to: 690, resume: 780 });
  assert.equal(RV.nextAllowed(Z("2026-10-15T20:45:30Z"), F0).toISOString(), "2026-10-16T10:00:00.000Z", "23:45 ⇒ tomorrow 13:00");
  assert.equal(RV.nextAllowed(Z("2026-10-15T23:00:00Z"), F0).toISOString(), "2026-10-16T10:00:00.000Z", "02:00 ⇒ today 13:00");
  assert.equal(RV.nextAllowed(Z("2026-10-16T08:00:00Z"), F0).toISOString(), "2026-10-16T10:00:00.000Z", "11:00 ⇒ 13:00");
  assert.equal(RV.nextAllowed(Z("2026-10-16T08:45:00Z"), F0).toISOString(), "2026-10-16T08:45:00.000Z", "11:45 is outside the quiet window");
  assert.equal(RV.nextAllowed(Z("2026-10-15T20:29:00Z"), F0).toISOString(), "2026-10-15T20:29:00.000Z", "23:29 still sends");
  assert.equal(RV.inQuiet(Z("2026-10-15T20:30:00Z"), F0), true, "23:30 is quiet");
  const none = RV.reviewFlowConfig({ quietFromHour: 0, quietFromMinute: 0, quietToHour: 0, quietToMinute: 0 });
  assert.equal(RV.inQuiet(Z("2026-10-15T21:00:00Z"), none), false);
  const odd = RV.reviewFlowConfig({ resumeHour: 2 });      // resume inside the quiet window ⇒ the end of the window
  assert.equal(RV.nextAllowed(Z("2026-10-15T21:00:00Z"), odd).toISOString(), "2026-10-16T08:30:00.000Z");
});

test("timing per order type: dine-in +90, takeaway +50, apps +100 from the order; table = max(order +75, served +15); pickup/delivery keep the courier and one-hour rules; late night ⇒ 13:00", () => {
  const at = "2026-10-15T15:00:00Z";      // 18:00 Riyadh
  assert.equal(RV.dueFor("dinein", { orderAt: at }, F0).toISOString(), "2026-10-15T16:30:00.000Z");
  assert.equal(RV.dueFor("takeaway", { orderAt: at }, F0).toISOString(), "2026-10-15T15:50:00.000Z");
  assert.equal(RV.dueFor("app", { orderAt: at }, F0).toISOString(), "2026-10-15T16:40:00.000Z");
  assert.equal(RV.dueFor("table", { orderAt: at, createdAt: at, deliveredAt: "2026-10-15T16:10:00Z" }, F0).toISOString(), "2026-10-15T16:25:00.000Z");
  assert.equal(RV.dueFor("table", { orderAt: at, createdAt: at, deliveredAt: "2026-10-15T15:20:00Z" }, F0).toISOString(), "2026-10-15T16:15:00.000Z");
  assert.equal(RV.dueFor("pickup", { orderAt: at, createdAt: at, deliveredAt: "2026-10-15T15:30:00Z" }, F0).toISOString(), "2026-10-15T16:15:00.000Z", "collected +45");
  assert.equal(RV.dueFor("pickup", { orderAt: at, createdAt: at, deliveredAt: "2026-10-15T15:05:00Z" }, F0).toISOString(), "2026-10-15T16:00:00.000Z", "never before one hour from the order");
  assert.equal(RV.dueFor("delivery", { createdAt: at, deliveredAt: "2026-10-15T15:40:00Z" }, F0).toISOString(), "2026-10-15T16:10:00.000Z");
  assert.equal(RV.dueFor("delivery", { createdAt: at, deliveredAt: "2026-10-15T15:20:00Z", pickedAt: "2026-10-15T15:18:00Z", courierConfirmed: false }, F0).toISOString(), "2026-10-15T16:18:00.000Z", "external courier nobody confirmed: ride floor");
  assert.equal(RV.dueFor("dinein", { orderAt: "2026-10-15T20:00:00Z" }, F0).toISOString(), "2026-10-16T10:00:00.000Z", "dinner at 23:00 ⇒ asked next day 13:00");
  const f = RV.reviewFlowConfig({ dineinMin: 60 });
  assert.equal(RV.dueFor("dinein", { orderAt: at }, f).toISOString(), "2026-10-15T16:00:00.000Z", "from the dashboard");
});

test("stars: list ids, the template's three buttons (5 / 4 / «3 or less»), typed digits or stars; routing never sends 3★ or «يحتاج تحسين» to Google", () => {
  assert.deepEqual(RV.starOfListId("rs:4:AB12cd34"), { stars: 4, code: "ab12cd34", exact: true });
  for (const bad of ["rs:0:ab12cd34", "rs:6:ab12cd34", "rs:5:ab", "rs:5:ab12cd34x!", "rs:5"]) assert.equal(RV.starOfListId(bad), null, bad);
  assert.deepEqual(CAT.STAR_BUTTONS.map((b) => [b.text, b.stars, b.exact]), [["ممتاز", 5, true], ["جيد جداً", 4, true], ["يحتاج تحسين", 3, false]], "RV4: no emoji on template buttons (Meta 2388060)");
  assert.deepEqual(RV.starOfQr("ممتاز ⭐️⭐️⭐️⭐️⭐️"), { stars: 5, exact: true }, "emoji variation selectors do not matter (old starred text still understood — RV4)");
  assert.equal(RV.starOfQr("تمام"), null);
  for (const [t, n] of [["5", 5], ["٥", 5], ["4 نجوم", 4], ["3/5", 3], ["⭐⭐⭐", 3], ["⭐⭐⭐⭐⭐ ممتاز", 5], ["⭐", 1]]) assert.equal(RV.typedStar(t), n, t);
  for (const t of ["55", "6", "0", "تمام", "5 ريال", "ابي 2 شاورما", "⭐⭐⭐⭐⭐⭐"]) assert.equal(RV.typedStar(t), null, t);
  const G = "https://g.page/r/CSG0gPAqlvHMEBM/review";
  assert.equal(RV.routeOf({ stars: 5, threshold: 4, googleUrl: G }), "google");
  assert.equal(RV.routeOf({ stars: 4, threshold: 4, googleUrl: G }), "google");
  assert.equal(RV.routeOf({ stars: 3, threshold: 4, googleUrl: G }), "low");
  assert.equal(RV.routeOf({ stars: 3, threshold: 3, googleUrl: G }), "low", "a rating-page threshold of 3 does not apply here");
  assert.equal(RV.routeOf({ stars: 4, threshold: 5, googleUrl: G }), "low", "a stricter threshold is respected");
  assert.equal(RV.routeOf({ stars: 3, exact: false, threshold: 2, googleUrl: G }), "low");
  assert.equal(RV.routeOf({ stars: 5, threshold: 4, googleUrl: "" }), "thanks");
  assert.equal(RV.googleLinkOf("ab12cd34", F0, G), `${RV.REVIEW_GO_BASE}ab12cd34`);
  assert.equal(RV.googleLinkOf("ab12cd34", RV.reviewFlowConfig({ trackGoogle: false }), G), G);
  assert.equal(RV.googleLinkOf(null, F0, G), G, "no invite ⇒ Google directly");
  assert.ok(RV.reviewCtaOk(`${RV.REVIEW_GO_BASE}ab12cd34`) && RV.reviewCtaOk(G) && RV.reviewCtaOk("https://search.google.com/local/writereview?placeid=ChIJf3COWQDbwxURIbSA8CqW8cw"));
  for (const bad of [`${RV.REVIEW_GO_BASE}ab`, `${RV.REVIEW_GO_BASE}ab12cd34/x`, "https://evil.example/r", "http://g.page/r/x/review"]) assert.equal(RV.reviewCtaOk(bad), false, bad);
  assert.deepEqual(RV.reasonsFor("delivery").map((r) => r.id), ["food", "wrong", "time", "delivery", "service", "price", "other"]);
  assert.deepEqual(RV.reasonsFor("dinein").map((r) => r.id), ["food", "wrong", "time", "service", "price", "clean", "other"]);
  assert.deepEqual(RV.reasonOfListId("rr:clean:42"), { reason: "clean", cat: "النظافة", reviewId: 42 });
  assert.equal(RV.reasonOfListId("rr:clean:4x"), null);
});

test("kinds: till orders by option (dine-in / takeaway), app orders behind their own switch (ON by default since Omar 15/10: «ابعت أرقام كيتا عادي»); the settings carry every knob with Arabic labels", () => {
  assert.equal(RV.posKindOf({ is_app: false, order_option: "Dine in" }), "dinein");
  assert.equal(RV.posKindOf({ is_app: false, order_option: "Take away" }), "takeaway");
  assert.equal(RV.posKindOf({ is_app: true, order_option: "Take away" }), "app");
  assert.equal(RV.posKindOf({ is_app: false, order_option: "توصيل Delivery" }), null);
  assert.deepEqual(["delivery", "pickup", "table", "dinein", "takeaway", "app"].map((k) => RV.kindOn(k, F0)), [true, true, true, true, true, true]);
  assert.equal(RV.kindOn("app", RV.reviewFlowConfig({ apps: false })), false, "still a dashboard switch");
  assert.equal(RV.kindOfInvite({ option: "pickup" }), "pickup"); assert.equal(RV.kindOfInvite({ option: "delivery" }), "delivery"); assert.equal(RV.kindOfInvite({ kind: "dinein", option: "dinein" }), "dinein");
  for (const k of Object.keys(RV.REVIEW_FLOW_DEFAULTS)) { const row = RV.REVIEW_FLOW_SCHEMA[`reviewFlow.${k}`]; assert.ok(row && /[؀-ۿ]/.test(row.ar) && row.group === "reviews", k); }
  assert.equal(Object.keys(RV.REVIEW_FLOW_SCHEMA).length, Object.keys(RV.REVIEW_FLOW_DEFAULTS).length);
  assert.deepEqual(RV.reviewFlowFromBody({ capDays: 3, smsVisits: true }, { dineinMin: 80 }), { ok: true, value: { dineinMin: 80, capDays: 3, smsVisits: true } });
  assert.equal(RV.reviewFlowFromBody({ capDays: 99 }).ok, false);
  assert.equal(RV.reviewFlowFromBody({ nope: 1 }).ok, false);
  assert.equal(RV.reviewFlowConfig({ dineinMin: 5000, enabled: "no" }).dineinMin, 90, "out of range ⇒ default"); assert.equal(RV.reviewFlowConfig({ enabled: false }).enabled, false);
});

test("copy: white dialect, no numbers in the texts, no incentive, no app name next to Google; the stars template is valid, utility, held until Omar approves the wording", () => {
  for (const [k, d] of Object.entries(RV.REVIEW_TEXTS)) for (const lang of ["ar", "en"]) {
    assert.ok([...d[lang]].length <= d.max, `${k}.${lang}`);
    assert.doesNotMatch(d[lang], /[0-9٠-٩]/, `${k}.${lang} has a number`);
    assert.doesNotMatch(d[lang], /خصم|كوبون|هدية|مجان|discount|coupon|gift|free/i, `${k}.${lang}: no incentive`);
    assert.doesNotMatch(d[lang], /كيتا|هنقر|نينجا|keeta|hunger|ninja/i, `${k}.${lang}: no app names`);
  }
  for (const d of Object.values(RV.REVIEW_TEXTS)) assert.doesNotMatch(d.ar, /دلوقتي|عايز|عاوز|بتاع|إزاي|ازاي|كده|مفيش|\sمش\s|لسه|بأسرع وقت/);
  const t = CAT.findTemplate("fc_review_stars");
  assert.deepEqual(CAT.validateTemplate(t), []);
  assert.equal(t.category, "UTILITY");
  assert.equal(CAT.previewText(t), "فريش كاتس تشكرك 🌟\nكيف تقيّم طلبك رقم W1790012345678؟ اختر من الأزرار 👇");
  assert.deepEqual(CAT.buttonsOf(t).map((b) => [b.type, b.text]), CAT.STAR_BUTTONS.map((b) => ["QUICK_REPLY", b.text]));
  assert.ok(CAT.HOLD.fc_review_stars, "not submittable without the owner (force:true)");
  assert.ok(!CAT.SUBMIT_BATCHES.flat().includes("fc_review_stars"));
});

/* ═══ reviews.js: المسح (مين يتسأل وامتى) ═══════════════════════════════ */
const ORDER_T = Date.parse("2026-10-15T15:00:00Z");      // 18:00 Riyadh
const ago = (min) => new Date(ORDER_T - min * 60_000).toISOString();
/* مراجعة RV1: Postgres (node-pg من غير أنواع) بيرفض أي براميتر مش مستخدم في الجملة (42P18) وأي $n مالوش قيمة — الأداة المزيّفة بترفض زيه */
function pgParamsCheck(sql, params = []) {
  const used = new Set([...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) throw Object.assign(new Error("could not determine data type of parameter $" + i), { code: "42P18" });
  for (const i of used) if (i > params.length) throw Object.assign(new Error("bind message supplies " + params.length + " parameters, but prepared statement requires " + Math.max(...used)), { code: "08P01" });
}
function rig({ ts = [], invites = [], reviewsRows = [], chats = {}, contacts = {}, shop = [], flow = {}, reviewsCfg = {}, waReply = null, sms = true, failRe = null, bills = {}, billCounts = {}, extra = {} } = {}) {
  const db = { invites: invites.map((x) => ({ ...x })), reviews: reviewsRows.map((x) => ({ ...x })), sms: [], asked: [], sql: [] };
  const inv = (no) => db.invites.find((x) => x.order_no === no);
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push(s);
    pgParamsCheck(s, p);
    if (failRe && failRe.test(s)) throw new Error("db down");
    /* عدد فواتير الرقم في آخر ٢٤ ساعة (رقم الكاشير الافتراضي): billCounts[pn] أو العدّ من ts */
    if (/FROM ts_orders b LEFT JOIN order_sources bs/i.test(s)) {
      return { rows: p[1].map((pn) => ({ pn, n: pn in billCounts ? billCounts[pn] : ts.filter((o) => o.pn === pn && Date.parse(o.order_date) > Date.parse(p[0])).length })).filter((r) => r.n > 0) };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref, skip_reason\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7], skip_reason: p[8], ...(db.clock ? { created_at: db.clock } : {}) }); return { rows: [], rowCount: 1 };
    }
    if (/^SELECT order_no, phone_norm, option, is_test, created_at, table_no FROM shop_orders WHERE order_no=\$1/i.test(s)) return { rows: shop.filter((o) => o.order_no === p[0]) };
    /* الفاتورة وقت السؤال (reviews.js بيقراها تاني قبل أي رسالة): bills[id] = { pn, src, order_type } | "missing" | "error" — من غيره نفس جوال الفاتورة/الدعوة */
    if (/^SELECT o\.order_type, COALESCE\(s\.source, ''\) AS src/i.test(s)) {
      const b = bills[p[0]];
      if (b === "error") throw new Error("db down");
      if (b === "missing") return { rows: [] };
      const t = ts.find((o) => String(o.order_id) === String(p[0])), iv0 = inv(`pos:${p[0]}`);
      return { rows: [{ order_type: (b && b.order_type) ?? null, src: (b && b.src) ?? "", pn: b && "pn" in b ? b.pn : t ? t.pn || null : iv0 ? iv0.phone_norm : null }] };
    }
    if (/FROM ts_orders o LEFT JOIN order_sources s/i.test(s) && /review_invites i WHERE i\.order_no = 'pos:'/i.test(s)) {
      return { rows: ts.filter((o) => Date.parse(o.order_date) > Date.parse(p[0]) && !inv(`pos:${o.order_id}`)).map((o) => ({ order_id: o.order_id, receipt: o.receipt || "", order_date: o.order_date, order_option: o.order_option, pn: o.pn || null, is_app: Boolean(o.is_app), web_near: Boolean(o.web_near) })) };
    }
    if (/^INSERT INTO review_invites\(order_no, code, phone_norm, option, due_at, kind, order_at, ref\)/i.test(s)) {
      if (inv(p[0])) return { rows: [], rowCount: 0 };
      db.invites.push({ order_no: p[0], code: p[1], phone_norm: p[2], option: p[3], due_at: p[4], kind: p[5], order_at: p[6], ref: p[7], ...(db.clock ? { created_at: db.clock } : {}) }); return { rows: [{ code: p[1] }], rowCount: 1 };
    }
    /* مراجعة RV1 (التالتة): قفل الدعوات القديمة (askMaxAgeHours) — العمر بيتحسب زي ما الجملة بتقول بالظبط:
       CASE ⇒ طلب الكاشير من order_at والموقع من created_at؛ COALESCE لوحده (الشكل القديم) ⇒ order_at للكل. صف من غير وقت ⇒ مايتقفلش. */
    if (/^UPDATE review_invites SET skip_reason='expired'/i.test(s)) {
      const cut = Date.parse(p[0]) - Number(p[1]) * 3600_000;
      const posCase = /\(CASE WHEN order_no LIKE 'pos:%' THEN COALESCE\(order_at, created_at\) ELSE created_at END\) </i.test(s);
      const anyOrderAt = !posCase && /COALESCE\(order_at, created_at\) </i.test(s);
      const base = (iv) => (posCase ? (/^pos:/.test(iv.order_no) ? iv.order_at ?? iv.created_at : iv.created_at) : anyOrderAt ? iv.order_at ?? iv.created_at : iv.created_at);
      let n = 0; for (const iv of db.invites) if (!iv.sent_at && !iv.skip_reason && Date.parse(base(iv)) < cut) { iv.skip_reason = "expired"; n++; }
      return { rows: [], rowCount: n };
    }
    if (/^UPDATE review_invites SET due_at=\$1::timestamptz WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at < \$1::timestamptz/i.test(s)) {
      let n = 0; for (const iv of db.invites) if (!iv.sent_at && !iv.skip_reason && Date.parse(iv.due_at) < Date.parse(p[0])) { iv.due_at = p[0]; n++; } return { rows: [], rowCount: n };
    }
    if (/FROM review_invites WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <=/i.test(s)) return { rows: db.invites.filter((iv) => !iv.sent_at && !iv.skip_reason && Date.parse(iv.due_at) <= Date.parse(p[0])).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at)) };
    if (/^SELECT opted_out_at FROM cms_contacts/i.test(s)) return { rows: contacts[p[0]] && contacts[p[0]].opted_out_at ? [{ opted_out_at: contacts[p[0]].opted_out_at }] : [] };
    if (/^SELECT 1 FROM cms_contacts WHERE phone_norm=\$1 AND is_staff/i.test(s)) return { rows: contacts[p[0]] && contacts[p[0]].is_staff ? [{}] : [] };
    if (/^SELECT 1 FROM review_invites WHERE phone_norm=\$1 AND order_no <> \$2 AND sent_at IS NOT NULL/i.test(s)) return { rows: db.invites.filter((x) => x.phone_norm === p[0] && x.order_no !== p[1] && x.sent_at && !/^TEST-/.test(x.order_no) && Date.parse(x.sent_at) > Date.parse(p[2]) - p[3] * 86400_000).map(() => ({})) };
    if (/^SELECT 1 FROM reviews WHERE phone_norm=\$1 AND NOT COALESCE\(is_test,false\) AND created_at >/i.test(s)) return { rows: db.reviews.filter((r) => r.phone_norm === p[0] && Date.parse(r.created_at) > Date.parse(p[1]) - p[2] * 86400_000).map(() => ({})) };
    if (/^SELECT 1 FROM wa_bot_chats WHERE phone_norm=\$1 AND \(muted_until/i.test(s)) { const c = chats[p[0]]; const now = Date.parse(p[1]); return { rows: c && ((c.muted_until && Date.parse(c.muted_until) > now) || (c.handoff_at && Date.parse(c.handoff_at) > now - 86400_000)) ? [{}] : [] }; }
    if (/^SELECT 1 FROM reviews WHERE phone_norm=\$1 AND rating < 4 AND NOT resolved/i.test(s)) return { rows: db.reviews.filter((r) => r.phone_norm === p[0] && r.rating < 4 && !r.resolved && Date.parse(r.created_at) > Date.parse(p[1]) - 7 * 86400_000).map(() => ({})) };
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel=\$2 WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: new Date(ORDER_T).toISOString(), channel: p[1] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel='sms' WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: new Date(ORDER_T).toISOString(), channel: "sms" }); return { rows: [], rowCount: 1 }; }
    const m = /^UPDATE review_invites SET (\w+)=\$2 WHERE order_no=\$1/i.exec(s); if (m) { inv(p[0])[m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE review_invites SET went_google=TRUE, google_clicked_at=/i.test(s)) { const iv = db.invites.find((x) => x.code === p[0]); if (!iv) return { rows: [], rowCount: 0 }; iv.went_google = true; iv.google_clicked_at = iv.google_clicked_at || "now"; return { rows: [{ review_id: iv.review_id || null }], rowCount: 1 }; }
    if (/^UPDATE reviews SET went_google=TRUE WHERE id=\$1/i.test(s)) { const r = db.reviews.find((x) => x.id === p[0]); if (r) r.went_google = true; return { rows: [], rowCount: r ? 1 : 0 }; }
    return { rows: [], rowCount: 0 };
  } };
  const routes = {}; const add = (mm) => (path, h) => { routes[`${mm} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const settings = { reviews: { threshold: 4, googleUrl: "https://g.page/r/CSG0gPAqlvHMEBM/review", askMaxAgeHours: 20, ...reviewsCfg }, delivery: { alertPhones: ["0544775082"] }, waBot: { testPhones: ["0561186075"], reviewFlow: flow }, ...extra };
  const api = reviews.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (x) => JSON.stringify(x), normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") },
    { notify: () => ({ sendSmsTo: async (phone, body, meta) => { db.sms.push({ phone, body, meta }); return sms; } }),
      ...(waReply ? { waReview: () => ({ reviewAsk: async (x) => { db.asked.push(x); return typeof waReply === "function" ? waReply(x) : waReply; } }) } : {}) });
  /* at(iso) = ساعة القاعدة المزيّفة (NOW() وقت تسجيل الدعوة)؛ run بيحرّكها لوقت المسح */
  return { api, db, routes, at: (iso) => { db.clock = new Date(iso).toISOString(); }, run: (iso) => { if (db.clock) db.clock = new Date(iso).toISOString(); return api.runInvites(new Date(iso)); } };
}

test("till orders: a closed bill with the customer's phone gets ONE invite (dine-in +90, takeaway +50); no phone, a website mirror, or an app order with its switch off ⇒ none; staff contacts are skipped at send time", async () => {
  const ts = [
    { order_id: "9001", order_date: ago(100), order_option: "Dine in", pn: "531478260", receipt: "1043" },
    { order_id: "9002", order_date: ago(40), order_option: "Take away", pn: "542689137" },
    { order_id: "9003", order_date: ago(120), order_option: "Take away", pn: "553791024", is_app: true },
    { order_id: "9004", order_date: ago(120), order_option: "Dine in", pn: null },
    { order_id: "9005", order_date: ago(120), order_option: "Dine in", pn: "564802135", web_near: true },
    { order_id: "9006", order_date: ago(60), order_option: "Take away", pn: "576913246" },
  ];
  const r = rig({ ts, flow: { apps: false }, contacts: { "576913246": { is_staff: true } }, waReply: { ok: false, skipped: "no_visit_template" } });
  const out = await r.run("2026-10-15T15:00:00Z");
  assert.deepEqual(r.db.invites.map((x) => [x.order_no, x.kind, x.due_at, x.ref]).sort(), [
    ["pos:9001", "dinein", new Date(ORDER_T - 10 * 60_000).toISOString(), "فاتورة 1043"],
    ["pos:9002", "takeaway", new Date(ORDER_T + 10 * 60_000).toISOString(), null],
    ["pos:9006", "takeaway", new Date(ORDER_T - 10 * 60_000).toISOString(), null],
  ].sort());
  assert.equal(r.db.invites.find((x) => x.order_no === "pos:9006").skip_reason, "staff");
  const a = r.db.invites.find((x) => x.order_no === "pos:9001");
  assert.deepEqual(r.db.asked.map((x) => [x.orderNo, x.kind, x.ref]), [["pos:9001", "dinein", "فاتورة 1043"]]);
  assert.deepEqual([a.skip_reason, a.wa_skip, r.db.sms.length, out.sent], ["no_sms_visit:no_visit_template", "no_visit_template", 0, 0], "no SMS to a till customer unless the owner opens it");
  assert.equal(r.db.invites.find((x) => x.order_no === "pos:9002").sent_at, undefined, "takeaway not due yet");
  // second sweep: nothing new, nothing twice
  await r.run("2026-10-15T15:05:00Z");
  assert.equal(r.db.invites.length, 3); assert.equal(r.db.asked.length, 1);
  // apps ON by default (Omar 15/10) ⇒ the Keeta order gets one too
  const ap = rig({ ts, waReply: { ok: false, skipped: "no_visit_template" } });
  await ap.run("2026-10-15T15:00:00Z");
  assert.ok(ap.db.invites.some((x) => x.order_no === "pos:9003" && x.kind === "app"));
  // smsVisits on ⇒ SMS with the rating-page link when WhatsApp is not possible
  const s = rig({ ts: [ts[0]], flow: { smsVisits: true }, waReply: { ok: false, skipped: "no_optin" } });
  const o2 = await s.run("2026-10-15T15:00:00Z");
  assert.equal(o2.sent, 1); assert.equal(s.db.sms.length, 1);
  assert.match(s.db.sms[0].body, /\/r\?c=[a-z0-9]{8}$/); assert.equal(s.db.invites[0].channel, "sms");
  // WhatsApp worked ⇒ channel + the template's message id (for the button tap)
  const w = rig({ ts: [ts[0]], waReply: { ok: true, channel: "wa_stars", wamid: "wamid.T1" } });
  await w.run("2026-10-15T15:00:00Z");
  assert.deepEqual([w.db.invites[0].channel, w.db.invites[0].wa_msg_id], ["wa_stars", "wamid.T1"]);
});

test("one ask per customer per 7 days (any channel), none after a recent rating, none while the chat is with staff or a low rating is still open; staff and test numbers never; the switch per type holds at send time", async () => {
  const due = { order_no: "W1790012345678", code: "ab12cd34", phone_norm: "512345678", option: "delivery", kind: "delivery", due_at: ago(5) };
  const ok = { ok: true, channel: "wa_list" };
  const prior = { order_no: "pos:8001", code: "zz11yy22", phone_norm: "512345678", option: "takeaway", kind: "takeaway", due_at: ago(4000), sent_at: new Date(ORDER_T - 3 * 86400_000).toISOString() };
  const c1 = rig({ invites: [due, prior], waReply: ok }); await c1.run("2026-10-15T15:00:00Z");
  assert.equal(c1.db.invites[0].skip_reason, "cap_days");
  const c0 = rig({ invites: [due, prior], flow: { capDays: 0 }, waReply: ok }); await c0.run("2026-10-15T15:00:00Z");
  assert.equal(c0.db.invites[0].channel, "wa_list", "cap 0 = no limit");
  const old = rig({ invites: [due, { ...prior, sent_at: new Date(ORDER_T - 8 * 86400_000).toISOString() }], waReply: ok }); await old.run("2026-10-15T15:00:00Z");
  assert.equal(old.db.invites[0].channel, "wa_list", "8 days ago ⇒ allowed");
  const rr = rig({ invites: [due], reviewsRows: [{ id: 1, phone_norm: "512345678", rating: 5, created_at: new Date(ORDER_T - 86400_000).toISOString() }], waReply: ok }); await rr.run("2026-10-15T15:00:00Z");
  assert.equal(rr.db.invites[0].skip_reason, "rated_recently");
  const ho = rig({ invites: [due], chats: { "512345678": { handoff_at: new Date(ORDER_T - 3600_000).toISOString() } }, waReply: ok }); await ho.run("2026-10-15T15:00:00Z");
  assert.equal(ho.db.invites[0].skip_reason, "handover_open");
  const mu = rig({ invites: [due], chats: { "512345678": { muted_until: new Date(ORDER_T + 3600_000).toISOString() } }, waReply: ok }); await mu.run("2026-10-15T15:00:00Z");
  assert.equal(mu.db.invites[0].skip_reason, "handover_open");
  const oc = rig({ invites: [due], flow: { capDays: 0 }, reviewsRows: [{ id: 2, phone_norm: "512345678", rating: 2, resolved: false, created_at: new Date(ORDER_T - 2 * 86400_000).toISOString() }], waReply: ok }); await oc.run("2026-10-15T15:00:00Z");
  assert.equal(oc.db.invites[0].skip_reason, "open_complaint");
  const tp = rig({ invites: [{ ...due, phone_norm: "561186075" }], waReply: ok }); await tp.run("2026-10-15T15:00:00Z");
  assert.equal(tp.db.invites[0].skip_reason, "staff", "the bot's test numbers are not customers");
  const al = rig({ invites: [{ ...due, phone_norm: "544775082" }], waReply: ok }); await al.run("2026-10-15T15:00:00Z");
  assert.equal(al.db.invites[0].skip_reason, "staff");
  const off = rig({ invites: [due], flow: { delivery: false }, waReply: ok }); await off.run("2026-10-15T15:00:00Z");
  assert.equal(off.db.invites[0].skip_reason, "kind_off");
  const visitOff = rig({ invites: [{ ...due, order_no: "pos:7001", kind: "dinein", option: "dinein" }], flow: { enabled: false }, waReply: ok }); await visitOff.run("2026-10-15T15:00:00Z");
  assert.equal(visitOff.db.invites[0].skip_reason, "flow_off", "the new path off ⇒ no message for a till order queued earlier");
});

test("quiet hours: a sweep inside 23:30–11:30 sends nothing and moves every due ask to 13:00; the web order keeps the old SMS fallback; queueInvite honours the per-type switch", async () => {
  const due = { order_no: "W1790012345678", code: "ab12cd34", phone_norm: "512345678", option: "delivery", kind: "delivery", due_at: "2026-10-15T20:40:00.000Z" };
  const q = rig({ invites: [due], waReply: { ok: true, channel: "wa_list" } });
  const out = await q.run("2026-10-15T21:00:00Z");      // 00:00 Riyadh
  assert.deepEqual([out.skipped, out.deferredTo, out.deferred, q.db.asked.length], ["quiet", "2026-10-16T10:00:00.000Z", 1, 0]);
  assert.equal(q.db.invites[0].due_at, "2026-10-16T10:00:00.000Z");
  const out2 = await q.run("2026-10-16T10:00:00Z");
  assert.equal(out2.sent, 1); assert.equal(q.db.invites[0].channel, "wa_list");
  const sm = rig({ invites: [due], waReply: { ok: false, skipped: "no_optin" } });
  await sm.run("2026-10-16T10:00:00Z");
  assert.deepEqual([sm.db.invites[0].channel, sm.db.invites[0].wa_skip, sm.db.sms.length], ["sms", "no_optin", 1], "website order: SMS fallback as today");
  const shop = [{ order_no: "W1790012340001", phone_norm: "512345678", option: "pickup", is_test: false, created_at: ago(60), table_no: null }];
  const k = rig({ shop, flow: { pickup: false } });
  assert.deepEqual(await k.api.queueInvite("W1790012340001", { at: new Date(ORDER_T) }), { ok: false, reason: "kind_off" });
  const k2 = rig({ shop });
  const qi = await k2.api.queueInvite("W1790012340001", { at: new Date(ORDER_T) });
  assert.equal(qi.ok, true); assert.deepEqual([k2.db.invites[0].kind, k2.db.invites[0].ref, k2.db.invites[0].due_at], ["pickup", "W1790012340001", new Date(ORDER_T + 45 * 60_000).toISOString()]);
  const t2 = rig({ shop: [{ ...shop[0], order_no: "W1790012340002", table_no: 7 }] });
  await t2.api.queueInvite("W1790012340002", { at: new Date(ORDER_T) });
  assert.equal(t2.db.invites[0].kind, "table");
});

test("the Google button: /api/reviews/g/<code> counts the click on the invite and the rating, then 302 to the configured Google link (never a URL from the request)", async () => {
  const r = rig({ invites: [{ order_no: "W1", code: "ab12cd34", phone_norm: "512345678", review_id: 5 }], reviewsRows: [{ id: 5, phone_norm: "512345678", rating: 5 }] });
  const hdr = {};
  const res = await r.routes["GET /api/reviews/g/:code"]({ req: { param: () => "ab12cd34", header: () => "1.2.3.4" }, header: (k, v) => { hdr[k] = v; }, redirect: (url, status) => ({ url, status }) });
  assert.deepEqual(res, { url: "https://g.page/r/CSG0gPAqlvHMEBM/review", status: 302 });
  assert.equal(hdr["Cache-Control"], "no-store");
  assert.deepEqual([r.db.invites[0].went_google, r.db.invites[0].google_clicked_at, r.db.reviews[0].went_google], [true, "now", true]);
  const unk = await r.routes["GET /api/reviews/g/:code"]({ req: { param: () => "../../evil", header: () => "1.2.3.4" }, header: () => {}, redirect: (url, status) => ({ url, status }) });
  assert.deepEqual(unk, { url: "https://g.page/r/CSG0gPAqlvHMEBM/review", status: 302 }, "a bad code still lands on Google, counted nowhere");
});

test("the daily numbers: requests by channel and kind, ratings (exact stars only in the average), Google links sent vs clicked, low ratings handled vs open", async () => {
  const q = async (sql) => {
    const s = String(sql).replace(/\s+/g, " ");
    if (/FROM review_invites WHERE sent_at >= \$1/.test(s)) return [{ channel: "wa_list", kind: "delivery", n: 3 }, { channel: "wa_stars", kind: "dinein", n: 5 }, { channel: "sms", kind: "pickup", n: 2 }];
    if (/skip_reason AS reason/.test(s)) return [{ reason: "cap_days", n: 4 }, { reason: "no_sms_visit:no_optin", n: 6 }];
    if (/FROM reviews WHERE created_at >= \$1/.test(s)) return [{ channel: "whatsapp", rating: 5, exact: true, n: 4, google: 3 }, { channel: "whatsapp", rating: 2, exact: true, n: 1, google: 0 }, { channel: "whatsapp", rating: 3, exact: false, n: 1, google: 0 }, { channel: "sms", rating: 4, exact: true, n: 1, google: 1 }];
    if (/google_sent_at >= \$1 AND google_sent_at < \$2/.test(s)) return [{ sent: 4, clicked: 3 }];
    if (/r\.rating < 4/.test(s)) return [{ n: 2, resolved: 0, handled: 1 }];
    if (/created_at > NOW\(\) - INTERVAL '30 days'/.test(s)) return [{ n: 7 }];
    return [];
  };
  const r = await RV.reviewsDaily(q, { from: "2026-10-15T01:00:00Z", to: "2026-10-16T01:00:00Z", place: { rating: 4.9, count: 296, at: "x" } });
  assert.deepEqual(r.requests, { total: 10, byChannel: { wa_list: 3, wa_stars: 5, sms: 2 }, byKind: { delivery: 3, dinein: 5, pickup: 2 } });
  assert.deepEqual(r.skipped, { cap_days: 4, "no_sms_visit:no_optin": 6 });
  assert.deepEqual(r.ratings.dist, { 1: 0, 2: 1, 3: 0, 4: 1, 5: 4 });
  assert.deepEqual([r.ratings.total, r.ratings.avg, r.ratings.needsImprovement, r.ratings.whatsapp, r.ratings.page], [7, 4.33, 1, 6, 1]);
  assert.deepEqual(r.google, { linksSent: 4, clicked: 3, pageClicks: 1 });
  assert.deepEqual(r.low, { total: 2, handled: 1, resolved: 0, openLast30d: 7 });
  assert.deepEqual(r.place, { rating: 4.9, count: 296, at: "x" });
  assert.deepEqual(RV.bizDayWindow("2026-10-15"), { day: "2026-10-15", from: "2026-10-15T01:00:00.000Z", to: "2026-10-16T01:00:00.000Z" });
  assert.equal(RV.bizDayWindow(null, new Date("2026-10-16T00:30:00Z")).day, "2026-10-15", "03:30 Riyadh still belongs to the 15th");
});

test("a check that cannot run (database error) never lets an ask out: the invite waits for the next sweep, untouched", async () => {
  const due = { order_no: "W1790012345678", code: "ab12cd34", phone_norm: "512345678", option: "delivery", kind: "delivery", due_at: ago(5) };
  const r = rig({ invites: [due], waReply: { ok: true, channel: "wa_list" }, failRe: /^SELECT 1 FROM review_invites WHERE phone_norm=\$1 AND order_no <> \$2/ });
  const out = await r.run("2026-10-15T15:00:00Z");
  assert.deepEqual([out.retry, out.sent, r.db.asked.length, r.db.invites[0].skip_reason, r.db.invites[0].sent_at], [1, 0, 0, undefined, undefined]);
});

/* مراجعة RV1: جملة التأجيل بالليل كانت بتبعت براميترين وبتستخدم $2 بس ⇒ Postgres (node-pg) بيرفضها (42P18) والمسح كله كان بيقع بالليل —
   والدعوة اللي ميعادها جه في الهدوء كانت بتطلع ١١:٣٠ بدل ١ الضهر. الأداة المزيّفة دلوقتي بترفض زي Postgres (pgParamsCheck). */
test("review fix (quiet SQL): the night deferral is valid for real Postgres (one parameter, used); a WhatsApp paid-gap deferral that lands at night moves to 13:00 — nothing goes out at 11:30", async () => {
  assert.throws(() => pgParamsCheck("UPDATE review_invites SET due_at=$2 WHERE due_at < $2::timestamptz", ["2026-10-15T21:00:00Z", "2026-10-16T10:00:00Z"]), /could not determine data type of parameter \$1/, "the old statement is what Postgres rejects");
  const gap = { order_no: "W1790012345670", code: "ab12cd30", phone_norm: "534781260", option: "delivery", kind: "delivery", due_at: "2026-10-15T20:50:00.000Z" };      // 23:50 Riyadh (paid_gap until)
  const q = rig({ invites: [gap], waReply: { ok: true, channel: "wa_list" } });
  const out = await q.run("2026-10-15T21:05:00Z");
  assert.deepEqual([out.skipped, out.deferred], ["quiet", 1]);
  const upd = q.db.sql.find((s) => /^UPDATE review_invites SET due_at=/i.test(s));
  assert.match(upd, /SET due_at=\$1::timestamptz .* due_at < \$1::timestamptz$/); assert.doesNotMatch(upd, /\$2/);
  const at1130 = await q.run("2026-10-16T08:30:00Z");      // 11:30 Riyadh
  assert.equal(q.db.asked.length, 0, "not at 11:30"); assert.equal(at1130.sent, 0);
  await q.run("2026-10-16T10:00:00Z");
  assert.equal(q.db.asked.length, 1, "at 13:00");
});

/* مراجعة RV1 (التالتة) — SB2: الطلب المسبق (preorder.js: لبكرة) كان بيتقفل «expired» أول ما يتسلّم: عمر دعوة الموقع كان بيتحسب من وقت الطلب
   (order_at = shop_orders.created_at) بدل وقت الدعوة نفسها (= التوصيل، زي main). طلب الساعة ٣ العصر لبكرة ٩ بالليل = ٣٠ ساعة > ٢٠ ⇒ لا واتساب ولا SMS. */
test("review fix (pre-orders, SB2): a next-day pre-order is asked after delivery — a website invite's max age counts from the invite (= delivery), not from when the order was placed; a till invite still counts from its bill; an unsent website invite past the limit still expires", async () => {
  const placed = "2026-10-14T12:00:00.000Z";      // 15:00 Riyadh — a pre-order for tomorrow's 20:00–23:00 slot
  const delivered = "2026-10-15T18:00:00.000Z";   // 21:00 Riyadh the next day = 30 h after it was placed
  const shop = [{ order_no: "W1790012349001", phone_norm: "534781260", option: "delivery", is_test: false, created_at: placed, table_no: null }];
  const invites = [
    /* فاتورة كاشير عمرها ٢١.٥ ساعة ودعوتها اتسجّلت متأخر (الجوال اتربط بعدين) ⇒ لسه بتتقفل من وقت الفاتورة */
    { order_no: "pos:9301", code: "ab12cd31", phone_norm: "542689137", option: "dinein", kind: "dinein", due_at: "2026-10-15T17:00:00.000Z", order_at: "2026-10-14T21:00:00.000Z", created_at: "2026-10-15T17:00:00.000Z", ref: null },
    /* دعوة موقع اتسجّلت من ٢١ ساعة ومااتبعتتش (زي main) ⇒ بتتقفل */
    { order_no: "W1790012349002", code: "ab12cd32", phone_norm: "553791024", option: "delivery", kind: "delivery", due_at: "2026-10-14T22:00:00.000Z", order_at: "2026-10-14T20:00:00.000Z", created_at: "2026-10-14T21:30:00.000Z", ref: "W1790012349002" },
  ];
  const r = rig({ shop, invites, waReply: { ok: true, channel: "wa_stars" } });
  r.at(delivered);
  const qi = await r.api.queueInvite("W1790012349001", { at: new Date(delivered) });
  assert.equal(qi.ok, true, JSON.stringify(qi));
  const iv = r.db.invites.find((x) => x.order_no === "W1790012349001");
  assert.deepEqual([iv.order_at, iv.created_at], [placed, delivered], "order_at = placed (30 h before), the invite row = delivery");
  const out = await r.run("2026-10-15T18:31:00Z");      // 21:31 Riyadh — the invite is due
  assert.equal(iv.skip_reason, undefined, "not expired");
  assert.ok(iv.sent_at, "asked"); assert.equal(iv.channel, "wa_stars");
  assert.deepEqual(r.db.asked.map((x) => x.orderNo), ["W1790012349001"]);
  assert.equal(out.sent, 1);
  assert.equal(r.db.invites.find((x) => x.order_no === "pos:9301").skip_reason, "expired", "till invite: age from the bill (unchanged)");
  assert.equal(r.db.invites.find((x) => x.order_no === "W1790012349002").skip_reason, "expired", "website invite unsent for 21 h: expired as on main");
  const sql = r.db.sql.find((q) => /^UPDATE review_invites SET skip_reason='expired'/i.test(q));
  assert.match(sql, /AND \(CASE WHEN order_no LIKE 'pos:%' THEN COALESCE\(order_at, created_at\) ELSE created_at END\) < \$1::timestamptz - \(\$2 \|\| ' hours'\)::interval$/);
  // the same pre-order without a WhatsApp path still gets the website SMS (SB2 fallback) — not expired either
  const sm = rig({ shop, waReply: { ok: false, skipped: "no_optin" } });
  sm.at(delivered);
  await sm.api.queueInvite("W1790012349001", { at: new Date(delivered) });
  await sm.run("2026-10-15T18:31:00Z");
  assert.deepEqual([sm.db.invites[0].skip_reason, sm.db.invites[0].channel, sm.db.sms.length], [undefined, "sms", 1]);
});

/* عمر ١٨/١٠: «المطعم شغال طول اليوم — كل الرسايل المربوطة إن المطعم مفتوح تتبعت عادي في وقتها» ⇒ طلب التقييم بمواعيد المطعم (sendhours.js) */
const OPEN_HOURS = { enabled: true, days: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "13:00", close: d === "thu" || d === "fri" ? "03:00" : "02:00" }])) };
test("open-hours gate: 00:30 Riyadh with the restaurant open ⇒ the WhatsApp ask goes now (the old 23:30–11:30 quiet would hold it to 13:00); 11:00 closed ⇒ deferred to the 13:00 opening; the SMS fallback still keeps the old quiet; setting off ⇒ old quiet", async () => {
  const late = "2026-10-15T21:30:00Z";      // 00:30 Riyadh (Thursday shift → open till 03:00)
  const inv = (no, due) => ({ order_no: no, code: `c${no.replace(/\D/g, "").slice(-6)}xx`, phone_norm: "531478260", option: "dinein", kind: "dinein", due_at: due, order_at: due, created_at: due });
  const a = rig({ invites: [inv("pos:7001", "2026-10-15T21:00:00Z")], extra: { hours: OPEN_HOURS }, waReply: { ok: true, channel: "wa_list" } });
  const o1 = await a.run(late);
  assert.equal(o1.sent, 1, JSON.stringify(o1)); assert.equal(a.db.asked.length, 1);
  const b = rig({ invites: [inv("pos:7002", "2026-10-16T07:30:00Z")], extra: { hours: OPEN_HOURS }, waReply: { ok: true, channel: "wa_list" } });
  const o2 = await b.run("2026-10-16T08:00:00Z");      // 11:00 Riyadh — closed
  assert.equal(o2.skipped, "closed"); assert.equal(o2.deferredTo, "2026-10-16T10:00:00.000Z", "the 13:00 opening"); assert.equal(b.db.asked.length, 0);
  const c = rig({ invites: [inv("pos:7003", "2026-10-15T21:00:00Z")], flow: { smsVisits: true }, extra: { hours: OPEN_HOURS }, waReply: { ok: false, skipped: "no_visit_template" } });
  const o3 = await c.run(late);
  assert.equal(c.db.sms.length, 0, "no SMS at 00:30"); assert.equal(o3.deferred, 1);
  assert.equal(c.db.invites[0].due_at, "2026-10-16T10:00:00.000Z", "the SMS waits for the old resume time (13:00)");
  const d = rig({ invites: [inv("pos:7004", "2026-10-15T21:00:00Z")], extra: { hours: OPEN_HOURS, waSendHours: { enabled: false } }, waReply: { ok: true, channel: "wa_list" } });
  const o4 = await d.run(late);
  assert.equal(o4.skipped, "quiet", "setting off ⇒ the old 23:30–11:30 quiet"); assert.equal(d.db.asked.length, 0);
});
