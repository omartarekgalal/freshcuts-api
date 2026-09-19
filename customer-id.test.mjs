/* node --test customer-id.test.mjs — معرّف العميل الموحّد + ربط رحلة العميل */
import test from "node:test";
import assert from "node:assert/strict";

const realSI = globalThis.setInterval;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };

const { customerIdFrom, customerId, CUSTOMER_ID_RE } = await import("./customer-id.js");
const J = await import("./journey.js");

test("customerIdFrom: ثابت، hex ٣٢، ومايتحسبش من غير secret أو برقم غلط", () => {
  const a = customerIdFrom("s3cret", "501234567");
  assert.match(a, CUSTOMER_ID_RE);
  assert.equal(a, customerIdFrom("s3cret", "501234567"), "same phone → same id");
  assert.notEqual(a, customerIdFrom("s3cret", "501234568"));
  assert.notEqual(a, customerIdFrom("other", "501234567"), "secret matters (not a bare phone hash)");
  assert.equal(customerIdFrom("", "501234567"), null);
  assert.equal(customerIdFrom("s3cret", "0501234567"), null, "phone_norm form only");
  assert.equal(customerIdFrom("s3cret", "abc"), null);
});

test("customerId: الـsecret بيتولّد مرة ويتقرا من الداتابيز", async () => {
  const rows = {};
  const pool = {
    query: async (sql, params = []) => {
      if (/INSERT INTO fc_identity_secret/.test(sql)) { if (!rows.customer_id) rows.customer_id = params[0]; return { rows: [] }; }
      if (/SELECT v FROM fc_identity_secret/.test(sql)) return { rows: [{ v: rows.customer_id }] };
      return { rows: [] };
    },
  };
  const a = await customerId(pool, "501234567");
  const b = await customerId(pool, "501234567");
  assert.match(a, CUSTOMER_ID_RE);
  assert.equal(a, b);
  assert.equal(a, customerIdFrom(rows.customer_id, "501234567"));
  assert.equal(await customerId(pool, "bad"), null);
});

test("journey parseBatch: ui_lang + أحداث ١٩/٩ (geo_help, lang_switch)", () => {
  const p = J.parseBatch(JSON.stringify({
    sessionId: "sabcdefgh123", anonId: "dabcdefgh123",
    session: { ui_lang: "en", landing_path: "/en/" },
    events: [{ n: "geo_help", seq: 1, p: { surface: "co2_edit", env: "ios_safari" } }, { n: "lang_switch", seq: 2, p: { to: "en" } }],
  }));
  assert.equal(p.session.ui_lang, "en");
  assert.deepEqual(p.events.map((e) => e.name), ["geo_help", "lang_switch"]);
  const bad = J.parseBatch(JSON.stringify({ sessionId: "sabcdefgh123", anonId: "dabcdefgh123", session: { ui_lang: "fr" }, events: [] }));
  assert.equal(bad.session.ui_lang, null);
});
