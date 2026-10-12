/* مكتبة عروض واتساب (waoffers.js) + إطارات العروض في الكتالوج — OF1
   node --test waoffers.test.mjs — قاعدة وهمية؛ مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const O = await import("./waoffers.js");
const CAT = await import("./watemplates.js");
const WC = await import("./wacloud.js");
const WA = await import("./whatsapp.js");

const HOSTS = ["freshcuts-api.o2m8.me", "freshcuts.sa"];
const IMG = "https://freshcuts-api.o2m8.me/api/content/media/md_1.jpg", VID = "https://freshcuts-api.o2m8.me/api/content/media/md_2.mp4";
const NOW = new Date("2026-10-13T12:00:00Z");
const base = { title: "بوكس التشكيلة", details: "مشاوي على الفحم مع بيتزا وباستا وأصناف جانبية ومشروبات", price: 105, media: { kind: "image", url: IMG }, link: { target_type: "box", target_id: "box-taste-all" }, source: { type: "bundle", id: "box-taste-all", price: 105 } };

test("the four frames are in the catalogue, valid by the catalogue's Meta rules, manual, marketing, and HELD until the wording is approved", () => {
  const names = Object.values(O.FRAMES);
  assert.deepEqual(names, ["fc_frame_offer_img", "fc_frame_video", "fc_frame_limited_img", "fc_frame_news_text"]);
  for (const n of names) {
    const t = CAT.findTemplate(n, "ar");
    assert.ok(t, n); assert.deepEqual(CAT.validateTemplate(t), []); assert.equal(t.category, "MARKETING"); assert.equal(t.meta.send, "manual");
    assert.ok(CAT.HOLD[n], `${n} cannot be submitted yet`);
    const body = CAT.bodyOf(t);
    assert.ok(!/^\s*\{\{/.test(body) && !/\}\}\s*$/.test(body), "no variable at the start or the end");
    assert.ok(!/\}\}\s*\{\{/.test(body), "no two variables side by side");
    const vars = (body.match(/\{\{\d+\}\}/g) || []).length, words = body.replace(/\{\{\d+\}\}/g, " ").split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    assert.ok(words >= vars * 3, `${n}: ${words} fixed words for ${vars} variables`);
    assert.ok(!/حصري|أرخص|التطبيقات|خصم/.test(body));
    assert.equal(CAT.footerOf(t), CAT.OPTOUT_FOOTER);
    assert.deepEqual(CAT.buttonsOf(t).map((b) => b.type), ["URL", "QUICK_REPLY"]);
    assert.match(CAT.buttonsOf(t)[0].url, /^https:\/\/freshcuts\.sa\/l\/\{\{1\}\}$/);
  }
  const hdr = (n) => (CAT.findTemplate(n).components.find((c) => c.type === "HEADER") || {}).format || null;
  assert.deepEqual(names.map(hdr), ["IMAGE", "VIDEO", "IMAGE", null]);
  assert.equal(CAT.findTemplate("fc_frame_video").meta.needsUpload, true);
});

test("cleanOffer: required fields, limits, own-host media only, a real future date, a link target", () => {
  const ok = O.cleanOffer(base, { hosts: HOSTS, now: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.offer.price, 105); assert.deepEqual(ok.offer.media, { kind: "image", url: IMG }); assert.match(ok.offer.id, /^box-taste-all-/);
  assert.deepEqual(ok.offer.source, { type: "bundle", id: "box-taste-all", price: 105 });
  const codes = (b) => { const r = O.cleanOffer(b, { hosts: HOSTS, now: NOW }); return r.ok ? [] : r.errors.map((e) => e[0]); };
  assert.deepEqual(codes({}), ["title_required", "details_required"]);
  assert.deepEqual(codes({ ...base, title: "ع".repeat(61) }), ["title_long"]);
  assert.deepEqual(codes({ ...base, price: -3 }), ["bad_price"]);
  assert.deepEqual(codes({ ...base, media: { kind: "video", url: "https://evil.example/v.mp4" } }), ["bad_media"]);
  assert.deepEqual(codes({ ...base, media: { kind: "image", url: "http://freshcuts.sa/x.jpg" } }), ["bad_media"]);
  assert.deepEqual(codes({ ...base, untilDate: "2026-10-01" }), ["until_past"]);
  assert.deepEqual(codes({ ...base, untilDate: "soon" }), ["bad_until"]);
  assert.deepEqual(codes({ ...base, link: { target_type: "box" } }), ["target_missing"]);
  assert.deepEqual(codes({ ...base, coupon: "first!" }), ["bad_coupon"]);
  assert.equal(O.cleanOffer({ ...base, untilDate: "2026-10-13" }, { hosts: HOSTS, now: NOW }).ok, true, "today is still valid");
  assert.equal(O.cleanOffer({ ...base, details: "سطر\nتاني" }, { hosts: HOSTS, now: NOW }).offer.details, "سطر تاني", "a variable is one line at Meta");
  assert.equal(O.cleanOffer({ ...base, coupon: "first" }, { hosts: HOSTS, now: NOW }).offer.coupon, "FIRST");
  assert.equal(O.cleanOffer({ ...base, id: "My Offer 1" }, { hosts: HOSTS, now: NOW }).offer.id, "my-offer-1");
});

test("frameFor: the frame is chosen from what the offer has, and it says what will not be sent", () => {
  const mk = (x) => O.cleanOffer({ ...base, ...x }, { hosts: HOSTS, now: NOW }).offer;
  const a = O.frameFor(mk({}));
  assert.equal(a.frame, "fc_frame_offer_img"); assert.equal(a.header, "image"); assert.deepEqual(a.fields, { "offer.title": "بوكس التشكيلة", "offer.line": base.details, "offer.price": "105" }); assert.deepEqual(a.warnings, []);
  const b = O.frameFor(mk({ untilDate: "2026-10-18" }));
  assert.equal(b.frame, "fc_frame_limited_img"); assert.match(b.fields["offer.untilText"], /18/); assert.ok(!/\n/.test(b.fields["offer.untilText"]));
  assert.equal(O.frameFor(mk({ untilText: "السبت" })).fields["offer.untilText"], "السبت");
  const v = O.frameFor(mk({ media: { kind: "video", url: VID }, untilDate: "2026-10-18" }));
  assert.equal(v.frame, "fc_frame_video"); assert.equal(v.header, "video"); assert.deepEqual(Object.keys(v.fields), ["offer.title", "offer.line"]);
  assert.match(v.fields["offer.line"], /^مشاوي على الفحم مع بيتزا وباستا وأصناف جانبية ومشروبات — السعر 105 ر\.س، العرض لين .*18/); assert.deepEqual(v.warnings, [], "nothing is dropped: price and last day ride in the details line");
  /* فيديو من غير سعر (فيديو «إزاي تطلب»): نفس الإطار، التفاصيل زي ما هي */
  assert.equal(O.frameFor(mk({ media: { kind: "video", url: VID }, price: "" })).fields["offer.line"], base.details);
  const t = O.frameFor(mk({ media: null, price: 29.5 }));
  assert.equal(t.frame, "fc_frame_news_text"); assert.equal(t.header, null); assert.ok(!("offer.price" in t.fields)); assert.match(t.fields["offer.line"], /— السعر 29\.5 ر\.س$/); assert.deepEqual(t.warnings, []);
  const n = O.frameFor(mk({ price: "" }));
  assert.equal(n.frame, "fc_frame_news_text"); assert.match(n.warnings[0], /الصورة مش هتتبعت/);
  assert.equal(O.frameFor(mk({ price: 29.5 })).fields["offer.price"], "29.5");
  /* كل قيمة تنفع متغير عند ميتا */
  for (const f of [a, b, v, t]) assert.deepEqual(f.bad, []);
  assert.deepEqual([O.paramOk("سطر"), O.paramOk("a\nb"), O.paramOk("a    b"), O.paramOk(" ")], [true, false, false, false]);
});

test("the campaign screen can use a frame as soon as it is in the registry: its fields are the offer's fields, the button is the tracked link", async () => {
  /* الكتالوج بيتسجّل في سجل whatsapp.js وقت التشغيل — هنا بنسجّله زي index.js */
  WA.registerCatalog(CAT);
  const d = O.campaignDraft(O.cleanOffer({ ...base, coupon: "FIRST" }, { hosts: HOSTS, now: NOW }).offer);
  assert.deepEqual(d, { cloudTemplate: "fc_frame_offer_img", values: { "offer.title": "بوكس التشكيلة", "offer.line": base.details, "offer.price": "105" }, imageUrl: IMG, videoUrl: null,
    link: { target_type: "box", target_id: "box-taste-all", coupon: "FIRST" }, name: "بوكس التشكيلة" });
  const dv = O.campaignDraft(O.cleanOffer({ ...base, media: { kind: "video", url: VID } }, { hosts: HOSTS, now: NOW }).offer);
  assert.equal(dv.videoUrl, VID); assert.equal(dv.imageUrl, null);
  {
    assert.ok(WA.TEMPLATES["fc_frame_offer_img"], "the frame is in the send registry");
    const spec = WC.campaignSpec("fc_frame_offer_img");
    assert.equal(spec.header, "image"); assert.equal(spec.button, "link"); assert.deepEqual(spec.fields.map((f) => f.key), Object.keys(d.values));
    assert.equal(WC.campaignSpec("fc_frame_video").header, "video"); assert.deepEqual(WC.campaignSpec("fc_frame_video").fields.map((f) => f.key), ["offer.title", "offer.line"]);
    assert.deepEqual(WC.campaignSpec("fc_frame_news_text").fields.map((f) => f.key), ["offer.title", "offer.line"]);
  }
});

function world({ items = [] } = {}) {
  const db = { settings: { waOffers: { items } }, writes: 0 };
  const pool = { async query(sql, p = []) { const s = String(sql).replace(/\s+/g, " ").trim(); if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waOffers\}'/i.test(s)) { db.settings.waOffers = JSON.parse(p[0]); db.writes++; return { rows: [] }; } throw new Error("unexpected SQL: " + s.slice(0, 80)); } };
  const routes = {}; const add = (m) => (pth, h) => { routes[`${m} ${pth}`] = h; };
  const app = { get: add("GET"), post: add("POST") };
  let admin = true;
  O.register(app, { pool, requireAdmin: async (c) => (admin ? null : c.json({ ok: false, error: "unauthorized" }, 401)), getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)) }, { hosts: () => HOSTS, actor: async () => "عمر", log: { error() {} } });
  const call = (route, { json = {}, param = {} } = {}) => routes[route]({ req: { json: async () => json, param: (n) => param[n], query: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  return { db, call, setAdmin: (v) => { admin = v; } };
}

test("routes: save, edit in place, list with frame and campaign draft, archive (nothing is deleted), refusals with the reason; no session ⇒ 401", async () => {
  const w = world();
  const bad = await w.call("POST /api/cms/wa-sender/offers", { json: { title: "x" } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "details_required"); assert.ok(bad.body.message); assert.equal(w.db.writes, 0);
  const a = await w.call("POST /api/cms/wa-sender/offers", { json: base });
  assert.equal(a.status, 200); assert.equal(a.body.created, true); assert.equal(a.body.offer.frame, "fc_frame_offer_img"); assert.equal(a.body.offer.createdBy, "عمر");
  assert.equal(a.body.offer.draft.cloudTemplate, "fc_frame_offer_img");
  const id = a.body.offer.id;
  const e = await w.call("POST /api/cms/wa-sender/offers", { json: { ...base, id, price: 99, untilDate: "2099-01-01" } });
  assert.equal(e.body.created, false); assert.equal(e.body.offer.price, 99); assert.equal(e.body.offer.frame, "fc_frame_limited_img"); assert.equal(e.body.offer.createdAt, a.body.offer.createdAt);
  assert.equal(w.db.settings.waOffers.items.length, 1);
  const l = await w.call("GET /api/cms/wa-sender/offers");
  assert.equal(l.body.offers.length, 1); assert.deepEqual(l.body.frames, Object.values(O.FRAMES)); assert.equal(l.body.limits.title, 60); assert.ok(l.body.offers[0].untilShown);
  const ar = await w.call("POST /api/cms/wa-sender/offers/:id/archive", { param: { id }, json: {} });
  assert.equal(ar.body.offer.archived, true); assert.equal(w.db.settings.waOffers.items.length, 1, "archived, not deleted");
  assert.equal((await w.call("POST /api/cms/wa-sender/offers/:id/archive", { param: { id }, json: { archived: false } })).body.offer.archived, false);
  assert.equal((await w.call("POST /api/cms/wa-sender/offers/:id/archive", { param: { id: "nope" } })).status, 404);
  w.setAdmin(false);
  for (const r of ["GET /api/cms/wa-sender/offers", "POST /api/cms/wa-sender/offers"]) assert.equal((await w.call(r, { json: base })).status, 401);
});

test("the module sends nothing and calls nobody; index.js registers it with the campaign's media-host rule", () => {
  const src = fs.readFileSync(new URL("./waoffers.js", import.meta.url), "utf8");
  assert.ok(!/graph\.facebook|fetch\(|sendTemplate|guardSend|deliver\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  const index = fs.readFileSync(new URL("./index.js", import.meta.url), "latin1");
  assert.ok(index.includes("waoffers.register(app, moduleCtx, { hosts: () => waSenderApi.imageHosts()"));
});
