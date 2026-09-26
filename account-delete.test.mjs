/* حذف الحساب (شرط Apple/Google) — node --test account-delete.test.mjs

   قاعدة بيانات وهمية: بتسجّل كل SQL. مفيش شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import { register, deleteAccountData, phoneHash } from "./accounts.js";

const TOKEN = "b".repeat(48);
const PHONE = "512345678";

function fakePool({ active = false, tables = ["push_subs", "shop_carts", "cms_contacts", "cms_optout_log"], failOn = null, withConnect = false } = {}) {
  const log = [];
  const q = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    log.push({ s, params });
    if (failOn && s.includes(failOn)) throw new Error("boom");
    if (/UPDATE acct_sessions SET last_seen_at/.test(s)) {
      return params[0] === TOKEN ? { rowCount: 1, rows: [{ phone_norm: PHONE }] } : { rowCount: 0, rows: [] };
    }
    if (/SELECT \* FROM acct_customers/.test(s)) return { rowCount: 1, rows: [{ phone_norm: PHONE, name: "عمر", addresses: [] }] };
    if (/FROM shop_orders WHERE phone_norm=\$1 AND created_at/.test(s)) {
      return active ? { rowCount: 1, rows: [{ order_no: "W123" }] } : { rowCount: 0, rows: [] };
    }
    if (/to_regclass/.test(s)) return { rowCount: 1, rows: [{ t: tables.includes(params[0]) ? params[0] : null }] };
    if (/^DELETE FROM acct_sessions/.test(s)) return { rowCount: 2, rows: [] };
    if (/^DELETE FROM acct_customers/.test(s)) return { rowCount: 1, rows: [] };
    if (/^UPDATE push_subs/.test(s)) return { rowCount: 3, rows: [] };
    return { rowCount: 0, rows: [] };
  };
  const pool = { log, query: q };
  if (withConnect) pool.connect = async () => ({ query: q, release: () => log.push({ s: "RELEASE" }) });
  return pool;
}

function setup(opts) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  const pool = fakePool(opts);
  register(app, {
    pool, requireAdmin: async () => null, getSettingsData: async () => ({}),
    jb: (v) => JSON.stringify(v), normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
    deliveryAppOf: () => null,
  });
  const call = async ({ body, auth = true } = {}) => {
    const h = auth ? { authorization: `Bearer cust:${TOKEN}` } : {};
    const c = {
      req: { header: (n) => h[String(n).toLowerCase()], json: async () => body, param: () => undefined, query: () => undefined },
      json: (obj, status = 200) => ({ body: obj, status }),
    };
    return routes["DELETE /api/account/me"](c);
  };
  return { pool, call };
}

test("needs a customer session", async () => {
  const { call } = setup();
  const r = await call({ auth: false, body: { confirm: "حذف" } });
  assert.equal(r.status, 401);
});

test("needs the typed confirmation word", async () => {
  const { call, pool } = setup();
  const r = await call({ body: { confirm: "delete" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "confirm_required");
  assert.ok(!pool.log.some((x) => x.s.startsWith("DELETE FROM acct_customers")));
});

test("refuses while an order is still on its way", async () => {
  const { call, pool } = setup({ active: true });
  const r = await call({ body: { confirm: "حذف" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "active_order");
  assert.equal(r.body.orderNo, "W123");
  assert.ok(!pool.log.some((x) => x.s.startsWith("DELETE FROM acct_customers")));
});

test("deletes account, sessions, carts; disables push; opts out; logs a hash only", async () => {
  const { call, pool } = setup();
  const r = await call({ body: { confirm: " حذف ", source: "app_android" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deleted, { sessions: 2, account: 1, otp: 0, pushSubs: 3, carts: 0, installs: 0 });
  const sqls = pool.log.map((x) => x.s);
  assert.ok(sqls.some((s) => s.startsWith("DELETE FROM shop_carts")));
  assert.ok(sqls.some((s) => s.includes("'account_delete'") && s.startsWith("INSERT INTO cms_contacts")));
  // orders stay (invoices / accounting)
  assert.ok(!sqls.some((s) => /^(DELETE|UPDATE) shop_orders/.test(s) || s.startsWith("DELETE FROM shop_orders")));
  // app_installs doesn't exist yet → never touched
  assert.ok(!sqls.some((s) => s.includes("UPDATE app_installs")));
  const logRow = pool.log.find((x) => x.s.startsWith("INSERT INTO acct_deletions"));
  assert.equal(logRow.params[0], phoneHash(PHONE));
  assert.ok(!logRow.params.join("|").includes(PHONE), "the phone number itself is never stored");
  assert.equal(logRow.params[1], "app_android");
});

test("unknown source falls back to web", async () => {
  const { call, pool } = setup();
  await call({ body: { confirm: "حذف", source: "<script>" } });
  assert.equal(pool.log.find((x) => x.s.startsWith("INSERT INTO acct_deletions")).params[1], "web");
});

test("transaction rolls back when a step fails", async () => {
  const pool = fakePool({ withConnect: true, failOn: "INSERT INTO acct_deletions" });
  await assert.rejects(() => deleteAccountData(pool, PHONE));
  const sqls = pool.log.map((x) => x.s);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls.includes("ROLLBACK"));
  assert.ok(!sqls.includes("COMMIT"));
  assert.equal(sqls.at(-1), "RELEASE");
});

test("transaction commits on success", async () => {
  const pool = fakePool({ withConnect: true });
  await deleteAccountData(pool, PHONE, { source: "web" });
  const sqls = pool.log.map((x) => x.s);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls.includes("COMMIT"));
});
