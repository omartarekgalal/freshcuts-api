/* ═══════════════════════════════════════════════════════════════════════════
   مصدر الطلب في عمود واحد (attrib_source) + إكمال الـutm من جلسة الرحلة.
   السبب: يوم ١٧/٩ كل الطلبات المدفوعة نزلت utm فاضي وهي جاية من SMS/إعلان،
   لإن المتصفّح الداخلي بتاع فيسبوك بيمسح الـlocalStorage.
     node --test attrib-source.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { classifySource, normalizeSource, mergeSessionAttribution } from "./checkout-meta.js";
import { backfillAttribSource, ATTRIB_BACKFILL_SELECT_NOJOIN } from "./orders-schema.js";

test("utm_source الصريح بيغلب أي حاجة تانية، وبأسماء المنصات الموحّدة", () => {
  assert.equal(classifySource({ utm: { utm_source: "Instagram" }, click: { ttclid: "x" } }), "meta");
  assert.equal(classifySource({ utm: { utm_source: "snap" } }), "snapchat");
  assert.equal(classifySource({ utm: { utm_source: "TikTok" } }), "tiktok");
  assert.equal(classifySource({ utm: { utm_source: "sms" } }), "sms");
  assert.equal(classifySource({ utm: { utm_source: "sticker" } }), "offline");
  assert.equal(normalizeSource("FACEBOOK"), "meta");
  // مصدر مش معروف بيرجع زي ما هو منضّف — مش "other"
  assert.equal(classifySource({ utm: { utm_source: "Jeddah Radio!!" } }), "jeddah-radio");
  assert.equal(normalizeSource(""), null);
});

test("من غير utm: click id ثم fc_link ثم direct", () => {
  assert.equal(classifySource({ click: { fbclid: "abc" } }), "meta");
  assert.equal(classifySource({ click: { fbc: "fb.1.2.3" } }), "meta");
  assert.equal(classifySource({ click: { ttclid: "t" } }), "tiktok");
  assert.equal(classifySource({ click: { ScCid: "s" } }), "snapchat");
  assert.equal(classifySource({ click: { scid: "s" } }), "snapchat");
  assert.equal(classifySource({ click: { gclid: "g" } }), "google");
  assert.equal(classifySource({ fc_link: "96-m2-box-b" }), "link");
  // fbp لوحده مش دليل نقرة — بيتحط لكل زائر
  assert.equal(classifySource({ click: { fbp: "fb.1.2.3" } }), "direct");
  assert.equal(classifySource(null), "direct");
  assert.equal(classifySource({}), "direct");
});

test("الجلسة بتنقذ الطلب اللي جه utm فاضي (حالة ١٧/٩ الحقيقية)", () => {
  const order = { utm: {}, click: { fbp: "fb.1.2.3" }, captured: "checkout" };
  const session = { utm_source: "sms", utm_medium: "crm", utm_campaign: "nd96-sms-onetime", link_slug: "c1" };
  assert.equal(classifySource(order), "direct");            // قبل
  const { attribution, enriched } = mergeSessionAttribution(order, session);
  assert.equal(enriched, true);
  assert.equal(classifySource(attribution, session), "sms"); // بعد
  assert.equal(attribution.utm.utm_campaign, "nd96-sms-onetime");
  assert.equal(attribution.fc_link, "c1");
  assert.equal(attribution.captured, "checkout+journey");
});

test("الدمج مابيدوسش على اللي المتصفّح بعته", () => {
  const order = { utm: { utm_source: "meta", utm_campaign: "fc-96-store" }, fc_link: "96-m2-box-b" };
  const session = { utm_source: "sms", utm_campaign: "other", link_slug: "c1" };
  const { attribution, enriched } = mergeSessionAttribution(order, session);
  assert.equal(attribution.utm.utm_source, "meta");
  assert.equal(attribution.utm.utm_campaign, "fc-96-store");
  assert.equal(attribution.fc_link, "96-m2-box-b");
  assert.equal(enriched, false);
  assert.equal(attribution.captured, undefined);
  // من غير جلسة خالص مافيش تغيير
  assert.deepEqual(mergeSessionAttribution(order, null).attribution, order);
});

test("مصدر الجلسة بيتاخد من channel/referrer لما مافيش utm", () => {
  assert.equal(classifySource({}, { channel: "meta_ads" }), "meta");
  assert.equal(classifySource({}, { channel: "direct", referrer_host: "m.facebook.com" }), "meta");
  assert.equal(classifySource({}, { channel: "direct", referrer_host: "www.google.com" }), "google");
  assert.equal(classifySource({}, { channel: "direct", referrer_host: "example.com" }), "direct");
});

test("الـbackfill بيكتب مصدر لكل صف، وبيكمّل من الجلسة، ومابيرميش", async () => {
  const updates = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.includes("to_regclass")) return { rows: [{ t: "journey_sessions" }] };
      if (sql.startsWith("SELECT o.order_no")) {
        assert.equal(params[0], 5000);
        return { rows: [
          { order_no: "W1", attribution: { utm: { utm_source: "meta" } }, journey_sid: null },
          { order_no: "W2", attribution: { utm: {} }, journey_sid: "s2", utm_source: "sms", utm_campaign: "wave1", link_slug: "c1" },
          { order_no: "W3", attribution: null, journey_sid: null },
        ] };
      }
      updates.push(params);
      return { rowCount: 1 };
    },
  };
  const r = await backfillAttribSource(pool);
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 3);
  assert.equal(r.updated, 3);
  assert.equal(r.enriched, 1);
  assert.deepEqual(updates.map((u) => [u[0], u[1]]), [["W1", "meta"], ["W2", "sms"], ["W3", "direct"]]);
  assert.equal(updates[0][2], null);                       // مااتغيّرش → مانكتبش jsonb
  assert.equal(JSON.parse(updates[1][2]).utm.utm_campaign, "wave1");
});

test("قاعدة من غير جدول رحلة → استعلام من غير JOIN، وفشل الاستعلام مابيرميش", async () => {
  let used = null;
  const noJourney = { query: async (sql, p) => {
    if (sql.includes("to_regclass")) return { rows: [{ t: null }] };
    if (sql.includes("attrib_source IS NULL")) { used = sql; return { rows: [] }; }
    return { rowCount: 0 };
  } };
  const a = await backfillAttribSource(noJourney);
  assert.equal(a.ok, true);
  assert.equal(used, ATTRIB_BACKFILL_SELECT_NOJOIN);

  const broken = { query: async () => { throw new Error("boom"); } };
  const b = await backfillAttribSource(broken, { log: { error() {} } });
  assert.equal(b.ok, false);
  assert.equal(b.updated, 0);
  assert.match(b.error, /boom/);
});
