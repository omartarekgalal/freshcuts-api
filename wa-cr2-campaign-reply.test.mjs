/* CR2 (١٦/١٠) — «أبغى أطلب» على رسالة حملة ⇒ عرض الحملة نفسها (wacampreply.js) + «رسالة اتمسحت» (whatsapp.js revokeOf/revokeText/parseWebhook)
   دوال صافية + قراءة القاعدة بقاعدة وهمية. أرقام وهمية بس. المسار الكامل (ويب هوك ⇒ رد البوت) في wabotrun.test.mjs «CR2 …».
     node --test wa-cr2-campaign-reply.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { untilDay, campaignReplyOffer, makeCampaignReply, CR_SQL, CR_DEFAULTS } from "./wacampreply.js";
import { revokeOf, revokeText, parseWebhook, REVOKE_PLAIN, REVOKE_GAP_SEC } from "./whatsapp.js";

/* صف حملة باقات التجمّع ١٥/١٠ بنفس شكله الحقيقي (wa_send_queue ⨝ wa_send_jobs ⨝ cms_links) */
const PACK = { id: 9101, job_id: 21, sent_at: new Date("2026-10-15T14:28:43Z"), wamid: "wamid.PACK15", vars: { name: "عميلتنا" }, link_code: "q7k2m9",
  cloud_template: "fc_frame_limited_img", link_slug: "wa-1015-packs-a", target_type: "gather", target_id: null, link_active: true,
  cloud_vars: { offer: "", values: { "offer.title": "جمعتكم الليلة أو بكره؟ باقة التجمّع لـ4 إلى 6 أشخاص", "offer.price": "225", "offer.untilText": "الجمعة 16 أكتوبر",
    "offer.line": "2 كيلو مشاوي على الفحم من اختيارك مع أرز وبطاطس وكولسلو و4 مشروبات" } } };
const FRI = Date.parse("2026-10-16T14:18:43Z"), SAT = Date.parse("2026-10-17T09:00:00Z");
const BOX = { ...PACK, wamid: "wamid.MIX15", job_id: 39, cloud_template: "fc_frame_offer_img", link_slug: "wa-1015-solo-mixgrill-a-r", target_type: "box", target_id: "box-solo-mixgrill",
  cloud_vars: { offer: "", values: { "offer.title": "اخترنا لك بوكس الميكس جريل الفردي", "offer.price": "39", "offer.line": "وجبة ميكس جريل" } } };
const BUNDLES = [{ slug: "box-solo-mixgrill", price: 39 }, { slug: "gathering-4", price: 225 }];

test("defaults: on, 72 h", () => { assert.deepEqual({ ...CR_DEFAULTS }, { campaignReply: true, campaignReplyHours: 72 }); });

test("untilDay: Arabic/Latin digits, weekday prefixes, «حتى», year wrap; anything else ⇒ null", () => {
  assert.equal(untilDay("الجمعة 16 أكتوبر", FRI), "2026-10-16");
  assert.equal(untilDay("اليوم الجمعة ١٦ أكتوبر", FRI), "2026-10-16");
  assert.equal(untilDay("حتى 15 اكتوبر", FRI), "2026-10-15");
  assert.equal(untilDay("السبت 18 أكتوبر", FRI), "2026-10-18");
  assert.equal(untilDay("5 يناير", Date.parse("2026-12-20T10:00:00Z")), "2027-01-05");
  assert.equal(untilDay("28 ديسمبر", Date.parse("2027-01-03T10:00:00Z")), "2026-12-28");
  for (const x of ["", "آخر الأسبوع", "الجمعة", "45 أكتوبر", "16 بكره"]) assert.equal(untilDay(x, FRI), null, x);
});

test("the 15/10 pack row on Friday 17:18 ⇒ title, price, last day, the recipient's own campaign link", () => {
  const o = campaignReplyOffer(PACK, { now: FRI });
  assert.deepEqual(o, { ok: true, title: "جمعتكم الليلة أو بكره؟ باقة التجمّع لـ4 إلى 6 أشخاص", price: 225, until: "الجمعة 16 أكتوبر", untilDay: "2026-10-16",
    slug: "wa-1015-packs-a", url: "https://freshcuts.sa/l/wa-1015-packs-a-q7k2m9", jobId: 21, queueId: 9101, wamid: "wamid.PACK15", sentAt: "2026-10-15T14:28:43.000Z" });
  assert.equal(campaignReplyOffer({ ...PACK, link_code: null }, { now: FRI }).url, "https://freshcuts.sa/l/wa-1015-packs-a", "no recipient code ⇒ the campaign link");
});

test("refusals ⇒ the generic reply: expired, link off/missing, «طبقك المفضل», unreplaced token, no title", () => {
  assert.deepEqual(campaignReplyOffer(PACK, { now: SAT }), { ok: false, why: "expired" });
  assert.equal(campaignReplyOffer({ ...PACK, link_active: false }, { now: FRI }).why, "link_off");
  assert.equal(campaignReplyOffer({ ...PACK, link_active: null }, { now: FRI }).why, "link_off", "link row missing");
  assert.equal(campaignReplyOffer({ ...PACK, link_slug: null }, { now: FRI }).why, "no_link");
  assert.equal(campaignReplyOffer({ ...PACK, cloud_template: "fc_frame_ask_text", cloud_vars: { perRecipient: true }, vars: { fav: { kind: "item" }, cloud: { values: { "offer.title": "طبقك المفضل" } } } }, { now: FRI }).why, "fav_campaign");
  assert.equal(campaignReplyOffer({ ...PACK, cloud_vars: { values: { "offer.title": "{fav_dish} بسعر خاص", "offer.price": "30" } } }, { now: FRI }).why, "token");
  assert.equal(campaignReplyOffer({ ...PACK, cloud_vars: { values: { "offer.price": "30" } } }, { now: FRI }).why, "no_title");
  assert.equal(campaignReplyOffer(null).why, "no_campaign");
});

test("per-recipient values (CP1 profileVars) win over the job values; no price / unparsed last day ⇒ name only, still offered", () => {
  const prof = { ...PACK, cloud_vars: { profileVars: true, values: { "offer.title": "{fav_dish} لجمعتكم", "offer.price": "225" } }, vars: { cloud: { values: { "offer.title": "كباب مشوي لجمعتكم" } } } };
  const o = campaignReplyOffer(prof, { now: FRI });
  assert.equal(o.ok, true); assert.equal(o.title, "كباب مشوي لجمعتكم"); assert.equal(o.price, 225); assert.equal(o.until, null);
  const v = campaignReplyOffer({ ...PACK, cloud_template: "fc_frame_video", cloud_vars: { values: { "offer.title": "اطلب من موقعنا مباشرة.", "offer.untilText": "آخر الشهر" } } }, { now: FRI });
  assert.deepEqual([v.ok, v.title, v.price, v.until, v.untilDay], [true, "اطلب من موقعنا مباشرة", null, "آخر الشهر", null]);
});

test("box link: live box at the same price ⇒ price kept; price changed or boxes unknown ⇒ no number; box gone ⇒ refused", () => {
  assert.equal(campaignReplyOffer(BOX, { now: FRI, bundles: BUNDLES }).price, 39);
  const ch = campaignReplyOffer(BOX, { now: FRI, bundles: [{ slug: "box-solo-mixgrill", price: 42 }] });
  assert.deepEqual([ch.ok, ch.price, ch.priceDropped], [true, null, true]);
  assert.deepEqual([campaignReplyOffer(BOX, { now: FRI, bundles: [] }).price, campaignReplyOffer(BOX, { now: FRI, bundles: null }).price], [null, null]);
  assert.equal(campaignReplyOffer(BOX, { now: FRI, bundles: [{ slug: "gathering-4", price: 225 }] }).why, "box_gone");
});

test("lastCampaign: one query with (phone, hours clamped 1..168, tapped wamid); typed + ordered since ⇒ ordered_since; tap does not check orders; DB error ⇒ db", async () => {
  const calls = [];
  const mk = (rows, ordered = false, fail = false) => makeCampaignReply({ pool: { async query(q, p) { calls.push([q, p]); if (fail) throw new Error("down");
    if (q === CR_SQL.lastRow) return { rows }; if (q === CR_SQL.orderedSince) return { rows: ordered ? [{}] : [] }; throw new Error("unexpected"); } } });
  const a = await mk([PACK]).lastCampaign("512345678", { hours: 500, wamid: "wamid.PACK15", now: FRI });
  assert.equal(a.offer.ok, true); assert.deepEqual(calls.at(-1)[1], ["512345678", 168, "wamid.PACK15"]);
  calls.length = 0;
  const t = await mk([PACK], true).lastCampaign("512345678", { typed: false, now: FRI });
  assert.equal(t.offer.ok, true); assert.equal(calls.length, 1, "a tap never asks about orders");
  assert.equal((await mk([PACK], true).lastCampaign("512345678", { typed: true, now: FRI })).offer.why, "ordered_since");
  assert.equal((await mk([]).lastCampaign("512345678", { wamid: "wamid.X", now: FRI })).offer.why, "not_campaign_msg");
  assert.equal((await mk([]).lastCampaign("512345678", { now: FRI })).offer.why, "no_campaign");
  assert.equal((await mk([PACK], false, true).lastCampaign("512345678", { now: FRI })).offer.why, "db");
  assert.equal((await mk([PACK]).lastCampaign("0512", { now: FRI })).offer.why, "bad_phone");
  assert.match(CR_SQL.lastRow, /q\.status = 'sent'/); assert.match(CR_SQL.lastRow, /cloud_status,''\) <> 'failed'/); assert.match(CR_SQL.lastRow, /ORDER BY q\.sent_at DESC/);
});

/* ── (ب) رسالة اتمسحت ── */
const hook = (value) => ({ entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "P1", display_phone_number: "966500000000" }, ...value } }] }] });
test("revokeOf: Meta's revoke.original_message_id (docs: webhooks/reference/messages/revoke); other types ⇒ null; no reference ⇒ original null + the keys we saw", () => {
  assert.deepEqual(revokeOf({ type: "revoke", revoke: { original_message_id: "wamid.ORIG" } }), { original: "wamid.ORIG", keys: ["original_message_id"] });
  assert.deepEqual(revokeOf({ type: "revoke" }), { original: null, keys: [] });
  assert.equal(revokeOf({ type: "text", text: { body: "x" } }), null);
});
test("parseWebhook: an inbound revoke carries the reference and no intent; a staff revoke echo carries it too", () => {
  const p = parseWebhook(hook({ messages: [{ from: "966512345678", id: "wamid.DEL", timestamp: "1792160327", type: "revoke", revoke: { original_message_id: "wamid.ORIG" } }],
    message_echoes: [{ from: "966500000000", to: "966512345678", id: "wamid.EDEL", timestamp: "1792160330", type: "revoke", revoke: { original_message_id: "wamid.MINE" } }] }));
  assert.equal(p.messages[0].text, REVOKE_PLAIN);
  assert.deepEqual(p.messages[0].revoke, { original: "wamid.ORIG", keys: ["original_message_id"] });
  assert.equal(p.messages[0].intent, null);
  assert.deepEqual(p.echoes[0].revoke, { original: "wamid.MINE", keys: ["original_message_id"] });
});
test("revokeText: the deleted text when we have it; the ≤10 s guess labelled «(تقدير)»; staff echo wording; otherwise the plain line", () => {
  assert.equal(REVOKE_GAP_SEC, 10);
  assert.equal(revokeText({ body: "أبغى أطلب" }), "مسحت رسالتها: أبغى أطلب");
  assert.equal(revokeText({ body: "[صورة]" }), "مسحت رسالتها: [صورة]");
  assert.equal(revokeText({ body: "تمام", echo: true }), "اتمسحت من موبايل المطعم: تمام");
  assert.equal(revokeText({ gapSec: 4, lastText: "عندكم مشاوي اليوم" }), "مسحت رسالة بعد 4 ثواني من «عندكم مشاوي اليوم» (تقدير)");
  assert.equal(revokeText({ gapSec: 1, lastText: "هلا" }), "مسحت رسالة بعد 1 ثانية من «هلا» (تقدير)");
  assert.equal(revokeText({ gapSec: 11, lastText: "هلا" }), REVOKE_PLAIN);
  assert.equal(revokeText({ gapSec: 3, lastText: "هلا", echo: true }), REVOKE_PLAIN, "no guessing for staff deletions");
  assert.equal(revokeText({}), REVOKE_PLAIN);
  assert.ok(revokeText({ body: "x".repeat(2000) }).length < 1000);
});
