/* 🔔 تحويلات واتساب على بوابة المطعم — node --test wahandover.test.mjs
   قاعدة وهمية بحالة، مفيش شبكة ولا Push حقيقي ولا أي إرسال لعميل. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, publicRow, pushPayloadFor } from "./wahandover.js";
import { bizDay, bizStart } from "./bizday.js";

const NOW = "2026-10-13T18:30:00Z";            // ٩:٣٠ مساءً الرياض
function world({ role = "cashier", lastIn = "الطلب وصل بارد\n ومتأخر", failInsert = false } = {}) {
  const db = { rows: [], seq: 0 };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE IF NOT EXISTS wa_handovers/i.test(s)) return { rows: [] };
    if (/^SELECT body FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: lastIn == null ? [] : [{ body: lastIn }] };
    if (/^INSERT INTO wa_handovers/i.test(s)) {
      if (failInsert) throw new Error("db down");
      const row = { id: ++db.seq, phone_norm: p[0], reason: p[1], reason_ar: p[2], urgent: p[3], order_no: p[4], test: p[5], last_text: p[6], at: p[7], acked_at: null, acked_by: null };
      db.rows.push(row); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (/^SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at FROM wa_handovers WHERE acked_at IS NULL AND at >= \$1/i.test(s)) {
      return { rows: db.rows.filter((r) => !r.acked_at && Date.parse(r.at) >= Date.parse(p[0])).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50).map((r) => ({ ...r })) };
    }
    if (/^UPDATE wa_handovers SET acked_at=NOW\(\), acked_by=\$2 WHERE id=\$1 AND acked_at IS NULL/i.test(s)) {
      const r = db.rows.find((x) => x.id === p[0] && !x.acked_at);
      if (!r) return { rows: [], rowCount: 0 };
      r.acked_at = NOW; r.acked_by = p[1]; return { rows: [{ id: r.id }], rowCount: 1 };
    }
    throw new Error("unexpected SQL: " + s.slice(0, 80));
  } };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST") };
  const events = [], pushes = [];
  let user = role ? { id: "s1", name: "منى", role } : null;
  const requirePortal = async (c) => {
    if (!user) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    if (user.role === "kitchen") return { res: c.json({ ok: false, error: "kitchen_only" }, 403) };
    return { user };
  };
  const api = register(app, { pool }, { requirePortal, broadcast: (ev, d) => events.push([ev, d]), now: () => new Date(NOW), log: { error() {} },
    push: () => ({ PORTAL_URL: "https://freshcuts-invite.o2m8.me/portal/", sendToSubs: async (p) => { pushes.push(p); return { sent: 1, of: 1 }; } }) });
  const call = (method, path, params = {}) => routes[`${method} ${path}`]({ req: { param: (k) => params[k], json: async () => ({}) }, json: (body, status = 200) => ({ body, status }) });
  return { db, api, events, pushes, call, setUser: (u) => { user = u; } };
}
const EV = { phone: "0512345678", phoneMasked: "…5678", reason: "complaint", reasonAr: "شكوى", urgent: true, orderNo: "W1790000000001", at: "2026-10-13T18:29:50Z", test: false };

test("a handover is recorded, then broadcast with its id and the customer's last message, and pushed to the portal devices", async () => {
  const w = world();
  const out = await w.api.emit(EV);
  assert.deepEqual(out, { id: 1, phone: "0512345678", phoneMasked: "…5678", reason: "complaint", reasonAr: "شكوى", urgent: true, orderNo: "W1790000000001",
    at: "2026-10-13T18:29:50.000Z", test: false, lastText: "الطلب وصل بارد ومتأخر" });
  assert.deepEqual(w.events, [["wa_handover", out]]);
  assert.equal(w.db.rows[0].phone_norm, "512345678");
  assert.equal(w.pushes.length, 1);
  const p = w.pushes[0];
  assert.equal(p.kind, "wa_handover");
  assert.equal(p.title, "🚨 واتساب: شكوى");
  assert.equal(p.body, "عميل …5678 محتاج موظف · طلب W1790000000001");
  assert.ok(!/512345678/.test(JSON.stringify(p)), "the push carries the masked number only");
  assert.equal(p.requireInteraction, true); assert.equal(p.urgency, "high"); assert.equal(p.tag, "wa-handover-1");
});

test("an ordinary handover: not urgent, no order, a calm push; the bot decides what is urgent", async () => {
  const w = world({ lastIn: null });
  const out = await w.api.emit({ ...EV, reason: "asked_human", reasonAr: "العميل طلب موظف", urgent: false, orderNo: null });
  assert.equal(out.urgent, false); assert.equal(out.orderNo, null); assert.equal(out.lastText, null);
  assert.equal(w.pushes[0].title, "💬 واتساب: العميل طلب موظف");
  assert.equal(w.pushes[0].body, "عميل …5678 محتاج موظف");
  assert.equal(w.pushes[0].requireInteraction, false);
  const late = await w.api.emit({ ...EV, reason: "order_late", reasonAr: "طلب متأخر", urgent: false });
  assert.equal(late.urgent, false, "no urgency is invented here");
});

test("test mode: recorded and shown with test:true, but no web push", async () => {
  const w = world();
  const out = await w.api.emit({ ...EV, test: true });
  assert.equal(out.test, true);
  assert.equal(w.events.length, 1);
  assert.equal(w.pushes.length, 0);
});

test("the list: unacknowledged handovers of the business day, newest first — a portal opened later still sees them", async () => {
  const w = world();
  const day = bizDay(new Date(NOW));
  const start = bizStart(day).getTime();
  await w.api.emit({ ...EV, at: new Date(start - 60_000).toISOString(), reason: "problem" });      // yesterday's business day
  await w.api.emit({ ...EV, at: new Date(start + 60_000).toISOString(), reason: "asked_human", urgent: false });
  await w.api.emit({ ...EV, at: "2026-10-13T18:29:50Z" });
  const r = await w.call("GET", "/api/portal/wa-handovers");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.handovers.map((h) => h.reason), ["complaint", "asked_human"]);
  assert.deepEqual(Object.keys(r.body.handovers[0]).sort(), ["at", "id", "lastText", "orderNo", "phone", "phoneMasked", "reason", "reasonAr", "test", "urgent"]);
});

test("«تم»: acknowledged once, by name, removed from the list and announced to every screen; a second tap changes nothing", async () => {
  const w = world();
  await w.api.emit(EV);
  w.events.length = 0;
  const r = await w.call("POST", "/api/portal/wa-handovers/:id/ack", { id: "1" });
  assert.deepEqual(r.body, { ok: true, id: 1, already: false });
  assert.equal(w.db.rows[0].acked_by, "منى");
  assert.deepEqual(w.events, [["wa_handover_ack", { id: 1, by: "منى" }]]);
  assert.deepEqual((await w.call("GET", "/api/portal/wa-handovers")).body.handovers, []);
  const again = await w.call("POST", "/api/portal/wa-handovers/:id/ack", { id: "1" });
  assert.equal(again.body.already, true);
  assert.equal(w.events.length, 1, "no second announcement");
  for (const bad of ["abc", "0", "-3", "1.5"]) assert.equal((await w.call("POST", "/api/portal/wa-handovers/:id/ack", { id: bad })).status, 400);
});

test("who can see and acknowledge: portal staff only — no session 401, the kitchen account 403", async () => {
  const w = world();
  await w.api.emit(EV);
  w.setUser(null);
  assert.equal((await w.call("GET", "/api/portal/wa-handovers")).status, 401);
  assert.equal((await w.call("POST", "/api/portal/wa-handovers/:id/ack", { id: "1" })).status, 401);
  w.setUser({ id: "k", name: "المطبخ", role: "kitchen" });
  assert.equal((await w.call("GET", "/api/portal/wa-handovers")).status, 403);
  assert.equal(w.db.rows[0].acked_at, null);
  w.setUser({ id: "m", name: "المدير", role: "manager" });
  assert.equal((await w.call("GET", "/api/portal/wa-handovers")).body.handovers.length, 1);
});

test("a failed save never swallows the live event; a malformed event is passed on as it came and not stored", async () => {
  const w = world({ failInsert: true });
  const out = await w.api.emit(EV);
  assert.equal(out.id, null);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0][1].reasonAr, "شكوى");
  assert.equal(w.pushes.length, 0);
  const w2 = world();
  await w2.api.emit({ reason: "asked_human", phone: "123" });
  assert.equal(w2.db.rows.length, 0);
  assert.equal(w2.events.length, 1);
});

test("shape helpers", () => {
  const row = { id: "7", phone_norm: "598765432", reason: "media", reason_ar: null, urgent: false, order_no: null, test: true, last_text: null, at: new Date("2026-10-13T10:00:00Z") };
  assert.deepEqual(publicRow(row), { id: 7, phone: "0598765432", phoneMasked: "…5432", reason: "media", reasonAr: "media", urgent: false, orderNo: null, at: "2026-10-13T10:00:00.000Z", test: true, lastText: null });
  assert.equal(pushPayloadFor(row, "https://x/portal/").url, "https://x/portal/");
});

test("wiring: the bot's event goes through this module; other portal events are untouched; nothing here talks to a customer", () => {
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.ok(index.includes('if (event === "wa_handover" && waHandoverApi) waHandoverApi.emit(data).catch(() => {}); else if (portalApi && typeof portalApi.broadcast === "function") portalApi.broadcast(event, data);'));
  assert.ok(index.includes("waHandoverApi = wahandover.register(app, moduleCtx, { requirePortal: portalApi.requirePortal, broadcast: portalApi.broadcast, push: () => portalApi.push });"));
  const src = readFileSync(new URL("./wahandover.js", import.meta.url), "utf8");
  for (const w of ["sendTemplate", "sendText", "sendFreeform", "guardSend", "deliver(", "graph.facebook.com", "sendSms", "fetch("]) assert.ok(!src.includes(w), w);
  assert.ok(!/UPDATE wa_bot|INSERT INTO wa_bot|DELETE FROM/.test(src), "the bot's tables are not written");
});
