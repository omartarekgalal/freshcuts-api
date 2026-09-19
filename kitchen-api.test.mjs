/* شاشة المطبخ — المسارات + فصل أدوار البورتال (node --test kitchen-api.test.mjs)
   Hono حقيقي + قاعدة وهمية. مفيش شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { register as registerPortal } from "./portal.js";
import { register as registerKitchen } from "./kitchen.js";
import { hashPin, verifyToken, tokenSecret } from "./portal-core.js";

const ADMIN = "admin-token-xyz-123";
const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const tsUtc = (minAgo) => iso(minAgo).replace("T", " ").slice(0, 19);

const STAFF = () => [
  { id: "st_m", name: "سارة", role: "manager", pinHash: hashPin("7777") },
  { id: "st_c", name: "علي", role: "cashier", pinHash: hashPin("2468") },
  { id: "st_k", name: "شاشة المطبخ", role: "kitchen", pinHash: hashPin("3690") },
];

function build({ settings = {}, partner = null } = {}) {
  const db = { settings: { portal: { staff: STAFF() }, catalog: { soldOut: { 105: { at: iso(30), name: "ريش مشوية بالوزن", until: null } } }, ...settings }, bumps: new Map(), audit: [] };
  const webhooks = [
    { oid: "K1", first_at: iso(8), last_at: iso(7), st: { approval_status: "accepted" },
      o: { id: "K1", order_type_name: "external", created_at: tsUtc(8), orders_external: { source: "Feedus", source_channel: "Keeta", approval_status: "accepted", external_order_number: "5551234" },
        purchases: [{ name: "وجبة كفتة", quantity: 1, category_id: "c1", modifiers: [], meta: { notes: "بدون بصل" } }], meta: { notes: "تواصل واتساب" } } },
  ];
  const shop = [{ order_no: "W1789000009999", status: "paid", option: "pickup", items: [{ name: "كريب ميكس دجاج", qty: 1 }], notes: "",
    address: null, pos_order_id: null, created_at: iso(2), updated_at: iso(2), is_test: false }];
  const pool = {
    query: async (sql, vals = []) => {
      sql = String(sql);
      if (/^\s*CREATE (TABLE|INDEX)/.test(sql)) return { rows: [] };
      if (/JOIN tsp_webhooks t ON t.id = f.last_id/.test(sql)) return { rows: webhooks };
      if (/MAX\(received_at\)/.test(sql)) return { rows: [{ at: iso(0.2) }] };
      if (/FROM shop_orders o\s+LEFT JOIN LATERAL/.test(sql)) return { rows: shop };
      if (/FROM kitchen_bumps/.test(sql)) return { rows: [...db.bumps.entries()].map(([k, v]) => ({ order_key: k, ...v })) };
      if (/INSERT INTO kitchen_bumps/.test(sql)) { db.bumps.set(vals[0], { stage: vals[1], at: new Date().toISOString(), by_name: vals[3] }); return { rowCount: 1, rows: [] }; }
      if (/INSERT INTO portal_audit/.test(sql)) { db.audit.push({ action: vals[3], order_no: vals[4], detail: JSON.parse(vals[6]) }); return { rowCount: 1, rows: [] }; }
      if (/UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{kitchen\}'/.test(sql)) { db.settings.kitchen = JSON.parse(vals[0]); return { rowCount: 1, rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  const requireAdmin = async (c) => (c.req.header("Authorization") === `Bearer ${ADMIN}` ? null : c.json({ error: "Unauthorized" }, 401));
  const ctx = { pool, getSettingsData: async () => ({ ...db.settings }), requireAdmin, log: { error() {} } };
  const events = [];
  const portal = registerPortal(app, ctx, {
    shop: () => null, delivery: () => null, timers: false, eventStore: false, backfill: false,
    env: { ADMIN_TOKEN: ADMIN }, subscribe: () => () => {}, emitOrder: () => {},
    webpush: { sendNotification: async () => {} }, names: { fillRows: async (r) => r },
  });
  const tsp = partner ? { api: partner } : null;
  const kitchen = registerKitchen(app, ctx, { portal: () => portal, tsp: () => tsp, emitOrder: (n, o) => events.push({ name: n, ...o }) });
  const req = (method, path, { token, body, ip = "10.0.0.9" } = {}) => app.request(path, {
    method, headers: { "Content-Type": "application/json", "cf-connecting-ip": ip,
      ...(token ? { Authorization: token.startsWith("Bearer") ? token : `Bearer portal:${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (...a) => { const r = await req(...a); return { status: r.status, body: await r.json() }; };
  return { app, db, json, kitchen, events };
}
const kLogin = (s, pin) => s.json("POST", "/api/portal/login", { body: { pin, app: "kitchen" } });

test("الدخول: حساب المطبخ للشاشة بس (٣٠ يوم)، والبورتال يرفضه من غير ما يعدّها غلطة", async () => {
  const s = build();
  const k = await kLogin(s, "3690");
  assert.equal(k.status, 200);
  assert.equal(k.body.role, "kitchen");
  const p = verifyToken(k.body.token, tokenSecret({ ADMIN_TOKEN: ADMIN }));
  assert.ok(p.exp - p.iat >= 29 * 24 * 3600_000);
  const onPortal = await s.json("POST", "/api/portal/login", { body: { pin: "3690" } });
  assert.equal(onPortal.status, 403);
  assert.equal(onPortal.body.error, "wrong_app");
  // الكاشير مايدخلش شاشة المطبخ، والمدير يدخل
  assert.equal((await kLogin(s, "2468")).body.error, "wrong_app");
  assert.equal((await kLogin(s, "7777")).body.role, "manager");
  // ولا حاجة من دول اتحسبت محاولة غلط
  assert.equal((await s.json("POST", "/api/portal/login", { body: { pin: "2468" } })).status, 200);
});

test("توكن المطبخ: 403 على كل مسارات البورتال (فيها جوالات)، وتوكن الكاشير 403 على المطبخ", async () => {
  const s = build();
  const k = (await kLogin(s, "3690")).body.token;
  for (const path of ["/api/portal/orders", "/api/portal/me", "/api/portal/orders/W1", "/api/portal/menu-availability"]) {
    const r = await s.json("GET", path, { token: k });
    assert.equal(r.status, 403, path);
  }
  const c = (await s.json("POST", "/api/portal/login", { body: { pin: "2468" } })).body.token;
  assert.equal((await s.json("GET", "/api/kitchen/board", { token: c })).status, 403);
  assert.equal((await s.json("GET", "/api/kitchen/board")).status, 401);
});

test("اللوحة: طلبات تاب سينس + المتجر + خلص + حالة المزامنة، ومن غير جوالات", async () => {
  const s = build();
  const k = (await kLogin(s, "3690")).body.token;
  const r = await s.json("GET", "/api/kitchen/board", { token: k });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const keys = r.body.orders.map((o) => o.key).sort();
  assert.deepEqual(keys, ["shop:W1789000009999", "ts:K1"]);
  const keeta = r.body.orders.find((o) => o.key === "ts:K1");
  assert.deepEqual([keeta.stage, keeta.channel.label, keeta.items[0].note], ["prep", "كيتا", "بدون بصل"]);
  assert.deepEqual(r.body.soldOut.map((x) => x.name), ["ريش مشوية بالوزن"]);
  assert.ok(r.body.sync.webhookAt);
  assert.equal(r.body.config.allowBump, true);
  assert.deepEqual(r.body.config.stations.map((x) => x.id), ["grill", "crepe", "pizza", "pasta", "sides"]);
  assert.equal(r.body.me.role, "kitchen");
});

test("التقديم: بيتسجّل + حدث للخط الزمني لطلب المتجر، ومايرجعش ورا المصدر، ويتقفل من الإعدادات", async () => {
  const s = build();
  const k = (await kLogin(s, "3690")).body.token;
  const ok = await s.json("POST", "/api/kitchen/orders/shop:W1789000009999/stage", { token: k, body: { stage: "ready" } });
  assert.equal(ok.status, 200);
  assert.equal(s.db.bumps.get("shop:W1789000009999").stage, "ready");
  assert.equal(s.events.at(-1).data.action, "kitchen_ready");
  assert.equal(s.events.at(-1).orderNo, "W1789000009999");
  const b = await s.json("GET", "/api/kitchen/board", { token: k });
  assert.equal(b.body.orders.find((o) => o.key === "shop:W1789000009999").stage, "ready");
  // كيتا «بيتحضّر» على نقطة البيع — مايرجعش «جديد»
  const back = await s.json("POST", "/api/kitchen/orders/ts:K1/stage", { token: k, body: { stage: "new" } });
  assert.equal(back.status, 409);
  assert.equal((await s.json("POST", "/api/kitchen/orders/bad key/stage", { token: k, body: { stage: "ready" } })).status, 400);
  assert.equal((await s.json("POST", "/api/kitchen/orders/ts:K1/stage", { token: k, body: { stage: "x" } })).status, 400);
  // المطبخ مايعدّلش الإعدادات، المدير يقدر، والتقديم يتقفل
  assert.equal((await s.json("PUT", "/api/kitchen/config", { token: k, body: { allowBump: false } })).status, 403);
  const m = (await kLogin(s, "7777")).body.token;
  const put = await s.json("PUT", "/api/kitchen/config", { token: m, body: { config: { allowBump: false, slaAmberMin: 8, slaRedMin: 15 } } });
  assert.equal(put.status, 200);
  assert.equal(s.db.settings.kitchen.slaAmberMin, 8);
  const off = await s.json("POST", "/api/kitchen/orders/ts:K1/stage", { token: k, body: { stage: "ready" } });
  assert.equal(off.status, 403);
  assert.equal(off.body.error, "bump_disabled");
});

test("استطلاع الشريك: طلب مالوش webhook لسه بيظهر، وفشل الاستطلاع مايوقّعش اللوحة", async () => {
  let calls = 0;
  const partner = async (path) => {
    calls++;
    if (path.startsWith("/orders")) return { data: [{ id: "T7", order_type_name: "table", created_at: tsUtc(1), updated_at: tsUtc(1), tables: [{ name: "T3" }], purchases: [{ name: "بيتزا مارجريتا", quantity: 1, category_id: "cp", modifiers: [] }] }] };
    if (path.startsWith("/categories")) return { data: [{ id: "cp", name: "بيتزا" }], meta: { last_page: 1 } };
    if (path.startsWith("/order-options")) return { data: [] };
    if (path.startsWith("/products")) return { data: [{ name: "بيتزا مارجريتا", category_id: "cp" }], meta: { last_page: 1 } };
    throw new Error("x");
  };
  const s = build({ partner });
  const k = (await kLogin(s, "3690")).body.token;
  await s.kitchen.runPoll();
  await s.kitchen.loadMeta();
  const r = await s.json("GET", "/api/kitchen/board", { token: k });
  const t = r.body.orders.find((o) => o.key === "ts:T7");
  assert.ok(t, "طلب الطاولة من الاستطلاع");
  assert.deepEqual([t.table, t.channel.key, t.items[0].station, t.via], ["T3", "dine_in", "pizza", "poll"]);
  assert.ok(r.body.sync.pollAt);
  assert.ok(calls >= 3);

  const bad = build({ partner: async () => { throw Object.assign(new Error("429"), { status: 429 }); } });
  const k2 = (await kLogin(bad, "3690")).body.token;
  await bad.kitchen.runPoll();
  const r2 = await bad.json("GET", "/api/kitchen/board", { token: k2 });
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.sync.pollError, "429");
});
