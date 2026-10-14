/* SB5 — «طلبك مع المندوب» باسمه وزر «راسل المندوب على واتساب» (عمر ١٤/١٠). من غير شبكة.      node --test wa-sb5.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as CC from "./couriercontact.js";
import * as CAT from "./watemplates.js";

test("the courier fields we really hold (Leajlak / Cervo / external): first name + a wa.me number; no phone ⇒ no button; odd names dropped", () => {
  const lj = CC.courierOf({ name: "أحمد علي", phone: "0551234567", location: { latitude: "21.5", longitude: "39.1" } }, "W1790012345678");
  assert.deepEqual([lj.first_name, lj.wa, CC.verifyCourierToken(lj.link)], ["أحمد", "966551234567", "W1790012345678"]);
  assert.deepEqual(CC.courierOf(JSON.stringify({ name: "Fahad", phone: "966501112223", source: "cervo" }), "W1").wa, "966501112223");
  const np = CC.courierOf({ name: "سالم", phone: "" }, "W1"); assert.deepEqual([np.first_name, np.wa, np.link], ["سالم", null, null], "no phone ⇒ no WhatsApp button, the name can still be said");
  assert.equal(CC.courierFirstName("Fot testing"), "Fot");
  assert.equal(CC.courierFirstName("كابتن"), null); assert.equal(CC.courierFirstName("123"), null);
  assert.equal(CC.courierOf(null, "W1"), null); assert.equal(CC.courierOf({}, "W1"), null);
  assert.equal(CC.courierWaNumber("551234567"), "966551234567"); assert.equal(CC.courierWaNumber("12"), null);
});

test("the button link carries no phone number and cannot be forged for another order", () => {
  const t = CC.courierToken("W1790012345678");
  assert.match(t, /^W1790012345678\.[A-Za-z0-9]{12}$/); assert.doesNotMatch(t, /966|05/);
  assert.equal(CC.verifyCourierToken(t.replace("W1790012345678", "W1790012345679")), null);
  assert.equal(CC.verifyCourierToken(`${t.slice(0, -1)}${t.slice(-1) === "A" ? "B" : "A"}`), null);
  assert.equal(CC.courierChatUrl("W1790012345678"), `${CC.COURIER_CHAT_BASE}${t}`);
});

test("GET /api/shop/courier-chat/:tok ⇒ the courier's WhatsApp with a ready line (order number) while the order is with him; delivered / unknown ⇒ tracking; forged ⇒ the store", async () => {
  const routes = {}; const app = { get: (p, h) => { routes[p] = h; } };
  let row = { status: "on_the_way", driver: { name: "أحمد", phone: "0551234567" } };
  CC.register(app, { pool: { query: async () => ({ rows: row ? [row] : [] }) } });
  const call = async (tok) => { let loc = null; await routes["/api/shop/courier-chat/:tok"]({ req: { param: () => tok }, redirect: (u, s) => { loc = [u, s]; return loc; } }); return loc; };
  const tok = CC.courierToken("W1790012345678");
  const [u, s] = await call(tok);
  assert.equal(s, 302); assert.match(u, /^https:\/\/wa\.me\/966551234567\?text=/); assert.match(decodeURIComponent(u), /طلب رقم W1790012345678/);
  row = { status: "delivered", driver: { name: "أحمد", phone: "0551234567" } };
  assert.equal((await call(tok))[0], "https://freshcuts.sa/track/W1790012345678", "after delivery the link is dead");
  row = { status: "on_the_way", driver: { name: "أحمد" } };
  assert.equal((await call(tok))[0], "https://freshcuts.sa/track/W1790012345678");
  assert.equal((await call("W1790012345678.AAAAAAAAAAAA"))[0], "https://freshcuts.sa");
});

test("the new utility template (ar + en) for submission: two variables, «راسل المندوب» + tracking buttons, passes the catalogue lint, never auto-wired", () => {
  const ts = CAT.TEMPLATES.filter((t) => t.name === "fc_order_on_the_way_courier");
  assert.deepEqual(ts.map((t) => t.language).sort(), ["ar", "en"]);
  for (const t of ts) {
    assert.equal(t.category, "UTILITY"); assert.deepEqual(CAT.validateTemplate(t), [], t.language); assert.equal(t.meta.stage, undefined);
    const b = t.components.find((c) => c.type === "BUTTONS").buttons;
    assert.deepEqual(b.map((x) => x.type), ["URL", "URL"]); assert.equal(b[0].url, "https://freshcuts.sa/m/{{1}}"); assert.equal(b[1].url, "https://freshcuts.sa/track/{{1}}");
  }
  assert.match(ts.find((t) => t.language === "ar").components[0].text, /^طلبك رقم \{\{1\}\} مع المندوب \{\{2\}\} وفي الطريق إليك 🛵/);
});
