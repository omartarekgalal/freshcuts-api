/* ═══════════════════════════════════════════════════════════════════════════
   PC1 — ربط عميل نقطة البيع بالطلب لحظياً (عمر ١٧/١٠): node --test poslink.test.mjs
     ١) الـupsert بتاع ts_orders مابيلمسش customer_id (القايمة مافيهاش عميل)
     ٢) مسح النهارده بيربط الطلب الجديد في نفس الدورة + صف أدنى للعميل الجديد
     ٣) الإيقاع من الإعداد (linkEveryMin) بيتحترم، والمسح الكامل على ميعاده
     ٤) customerPending = من غير عميل وجوّه نافذة (linkEveryMin + syncEveryMin)
     ٥) المخطط بتسمياته وحدوده وافتراضياته + الحفظ بيرفض برّه الحدود
═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as pl from "./poslink.js";

const ORDER_COLS = ["order_id", "receipt", "order_date", "calendar_day", "order_option", "order_type", "order_status", "gross", "discount",
  "promotion", "net", "tax", "gross_incl", "discount_incl", "total", "payments", "branch", "staff_name"];

/* داتابيز مزيّفة: ts_orders بـON CONFLICT حقيقي (بتطبّق أعمدة الـSET بس)، ts_customers، وتحديث الربط */
function fakeDb() {
  const orders = new Map(); const customers = new Map(); const log = [];
  return {
    orders, customers, log,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim(); log.push({ s, p });
      if (/^INSERT INTO ts_orders/i.test(s)) {
        const setCols = (s.match(/DO UPDATE SET (.*?) RETURNING/i) || [])[1].split(",").map((x) => x.trim().split("=")[0].trim());
        const row = Object.fromEntries(ORDER_COLS.map((c, i) => [c, p[i]]));
        const ex = orders.get(row.order_id);
        if (!ex) { orders.set(row.order_id, { ...row, customer_id: null }); return { rows: [{ order_id: row.order_id, inserted: true }], rowCount: 1 }; }
        for (const c of setCols) {
          if (c === "updated_at") continue;
          if (c === "staff_name") ex.staff_name = row.staff_name || ex.staff_name;
          else if (c in row) ex[c] = row[c];
          else ex[c] = undefined;   // عمود في الـSET مش في الـVALUES = غلط في الاستعلام ⇒ هيبان في الاختبار
        }
        return { rows: [{ order_id: row.order_id, inserted: false }], rowCount: 1 };
      }
      if (/^INSERT INTO ts_customers/i.test(s)) {
        const [ids, names, phones, norms, points] = p;
        ids.forEach((id, i) => {
          const ex = customers.get(id);
          if (!ex) customers.set(id, { customer_id: id, name: names[i], phone: phones[i], phone_norm: norms[i], points: points[i], registered_at: null });
          else { ex.name = ex.name || names[i]; ex.phone = ex.phone || phones[i]; ex.phone_norm = ex.phone_norm || norms[i]; }
        });
        return { rowCount: ids.length, rows: [] };
      }
      if (/^UPDATE ts_orders SET customer_id/i.test(s)) {
        const o = orders.get(String(p[0]));
        if (o && (o.customer_id == null || o.customer_id !== p[1])) { o.customer_id = p[1]; return { rowCount: 1, rows: [] }; }
        return { rowCount: 0, rows: [] };
      }
      if (/^UPDATE ts_customers SET first_order_at/i.test(s)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

/* نفس حلقة index.js linkCustomersOrders (من غير sleep) — الدالة الحقيقية بتتحقن في الإنتاج */
function mkLinker(db, ts, calls) {
  return async (ids) => {
    let linked = 0;
    for (const cid of ids) {
      calls.push(cid);
      const orders = await ts.fetchCustomerOrders(cid);
      for (const o of orders) {
        const r = await db.query("UPDATE ts_orders SET customer_id=$2, updated_at=NOW() WHERE order_id=$1 AND (customer_id IS NULL OR customer_id<>$2)", [String(o.id), cid]);
        linked += r.rowCount;
      }
    }
    return linked;
  };
}

const posRow = (id, over = {}) => ({
  orderId: id, receipt: "R" + id, orderDate: "2026-10-17 19:01:00", calendarDay: "2026-10-17", orderOption: "Take away", orderType: "POS",
  orderStatus: 1, gross: 100, discount: 0, promotion: 0, net: 100, tax: 15, total: 115, payments: { Mada: 115 }, branch: "Salamah", staffName: "أحمد", ...over,
});
const NOW = Date.parse("2026-10-17T17:05:00Z");   // ٢٠:٠٥ الرياض
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const daysAgoISO = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const todayISO = () => new Date(NOW).toISOString().slice(0, 10);
const CFG = pl.poslinkCfg({});

/* ── ١) الـupsert ───────────────────────────────────────────────────────── */
test("PC1: upsert ts_orders مافيهوش customer_id خالص — والربط الموجود بيعيش بعد سحب تاني", async () => {
  assert.ok(!/customer_id/i.test(pl.ORDER_UPSERT_SQL), "الـSQL مايذكرش customer_id (القايمة مافيهاش عميل — مفيش تخمين)");
  assert.equal(pl.orderUpsertParams(posRow("5627")).length, 18);
  const db = fakeDb();
  const r1 = await db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(posRow("5627")));
  assert.equal(r1.rows[0].inserted, true, "أول مرة = طلب جديد");
  await db.query("UPDATE ts_orders SET customer_id=$2, updated_at=NOW() WHERE order_id=$1 AND (customer_id IS NULL OR customer_id<>$2)", ["5627", "77"]);
  const r2 = await db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(posRow("5627", { total: 120, staffName: "" })));
  assert.equal(r2.rows[0].inserted, false, "تاني مرة = تحديث مش إدخال");
  const o = db.orders.get("5627");
  assert.equal(o.customer_id, "77", "الربط فضل زي ما هو");
  assert.equal(o.total, 120, "والأرقام اتحدّثت");
  assert.equal(o.staff_name, "أحمد", "اسم الكاشير مابيتمسحش بفاضي");
  for (const c of ORDER_COLS) assert.notEqual(o[c], undefined, `عمود ${c} اتحدّث من الـVALUES`);
});

test("PC1: صف /orders الحقيقي (tabsense.mapOrderRow) مافيهوش أي حقل عميل ⇒ السحب مابيغيّرش الربط", async () => {
  const { mapOrderRow } = await import("./tabsense.js");
  // صف زي اللي بيرجع من DataTables /orders (الأعمدة اللي بنطلبها في fetchOrdersSince + عمود دفع)
  const raw = { main_order_id: 5627, order_created_at: "2026-10-17 16:01:00", order_calendar_day: "2026-10-17", order_option_id: "Take away",
    order_type: "<span class=\"badge\">POS</span>", order_status: 1, purchases_quantity: 2, total_gross_amount: "100.00", total_discount_amount: "0.00",
    total_promotion_amount: "0.00", total_net_amount: "100.00", total_amount: "115.00", total_tax_amount: "15.00", receipt_number: "R5627", branch_name: "Salamah",
    payment_method: "Mada", notes: "", Mada: "115.00", created_by: "أحمد" };
  const m = mapOrderRow(raw);
  assert.ok(!Object.keys(m).some((k) => /customer/i.test(k)), "مفيش مفتاح عميل في صف الطلب");
  assert.equal(m.orderId, "5627"); assert.deepEqual(m.payments, { Mada: 115 });
  const db = fakeDb();
  await db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(m));
  await db.query("UPDATE ts_orders SET customer_id=$2, updated_at=NOW() WHERE order_id=$1 AND (customer_id IS NULL OR customer_id<>$2)", ["5627", "77"]);
  await db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(mapOrderRow({ ...raw, customer_id: 99, customer_name: "حد تاني" })));
  assert.equal(db.orders.get("5627").customer_id, "77", "حتى لو تاب سينس ضافوا عمود عميل يوم، السحب مايغيّرش الربط من غير مراجعة");
});

test("PC1: orderUpsertParams — الأرقام شاملة الضريبة من نسبة الطلب نفسه", () => {
  const p = pl.orderUpsertParams(posRow("1", { gross: 100, net: 100, tax: 15, total: 103.5 }));
  assert.equal(p[12], 115, "gross_incl");
  assert.equal(p[13], 11.5, "discount_incl");
  assert.equal(typeof p[15], "string", "payments jsonb كنص");
});

/* ── ٢) مسح النهارده في نفس الدورة ──────────────────────────────────────── */
function scenario({ lastLinkAt = minsAgo(1), lastCustomersSyncAt = minsAgo(1), cfg = CFG, sales, custOrders } = {}) {
  const db = fakeDb();
  const tsCalls = []; const linkCalls = []; let dirSyncs = 0;
  const ts = {
    async fetchCustomerSales(from, to) { tsCalls.push({ from, to }); return sales(from, to); },
    async fetchCustomerOrders(cid) { return custOrders[cid] || []; },
  };
  const insightsState = { lastLinkAt, lastCustomersSyncAt, lastTodayLinkAt: null };
  const deps = {
    pool: db, ts, insightsState, cfg, linkCustomersOrders: mkLinker(db, ts, linkCalls),
    syncCustomersCache: async () => { dirSyncs++; }, daysAgoISO, todayISO, normPhone: (p) => p.replace(/\D/g, ""),
    now: () => NOW, log: { error() {} },
  };
  return { db, ts, tsCalls, linkCalls, insightsState, deps, dirSyncs: () => dirSyncs };
}

test("PC1: طلب جديد النهارده ⇒ مسح النهارده بس (الكامل مش مستحق) ⇒ العميل اتربط في نفس الدورة + صف أدنى للعميل الجديد", async () => {
  const sc = scenario({
    sales: (from, to) => (from === "2026-10-17" && to === "2026-10-17" ? [{ id: 77, name: "سارة العتيبي", phone: "0501234567", points: 3 }] : []),
    custOrders: { 77: [{ id: 5627, created_at: "2026-10-17 19:01:00" }] },
  });
  await sc.db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(posRow("5627")));
  assert.equal(sc.db.orders.get("5627").customer_id, null, "بعد السحب: من غير عميل");
  const r = await pl.runLinkPass(sc.deps, { reason: "new_orders" });
  assert.equal(r.ran, true); assert.equal(r.mode, "today"); assert.equal(r.reason, "new_orders");
  assert.deepEqual(sc.tsCalls, [{ from: "2026-10-17", to: "2026-10-17" }], "تقرير المبيعات لليوم بس (رخيص)");
  assert.deepEqual(sc.linkCalls, ["77"]);
  assert.equal(sc.db.orders.get("5627").customer_id, "77", "الطلب اتربط بعميله في نفس الدورة");
  assert.equal(r.linked, 1);
  const cust = sc.db.customers.get("77");
  assert.ok(cust, "العميل الجديد خد صف أدنى في ts_customers");
  assert.equal(cust.name, "سارة العتيبي"); assert.equal(cust.phone_norm, "0501234567"); assert.equal(cust.registered_at, null, "تاريخ التسجيل من الدليل بعدين");
  assert.equal(sc.insightsState.lastTodayLinkAt, new Date(NOW).toISOString(), "lastTodayLinkAt اتسجّل");
  assert.equal(sc.insightsState.lastLinkAt, minsAgo(1), "lastLinkAt (الكامل) ماتغيّرش");
  assert.equal(sc.insightsState.lastLinkMode, "today");
  assert.equal(sc.dirSyncs(), 0, "دليل العملاء مش مستحق (اتحدّث من دقيقة)");
});

test("PC1: الصف الأدنى مابيكتبش فوق اسم/جوال موجودين، و«(بدون اسم)» بتتكتب فاضية", async () => {
  const db = fakeDb();
  db.customers.set("5", { customer_id: "5", name: "محمد", phone: "0555", phone_norm: "0555", points: 0, registered_at: "2026-01-01" });
  const n = await pl.ensureCustomerRows(db, [{ id: 5, name: "اسم تاني", phone: "0999" }, { id: 6, name: "(بدون اسم)", phone: "" }, { id: null }], (p) => p);
  assert.equal(n, 2);
  assert.equal(db.customers.get("5").name, "محمد"); assert.equal(db.customers.get("5").phone, "0555");
  assert.equal(db.customers.get("6").name, "", "مفيش «(بدون اسم)» في الداتابيز");
  assert.equal(await pl.ensureCustomerRows(db, []), 0);
});

/* ── ٣) الإيقاع ─────────────────────────────────────────────────────────── */
test("PC1: linkDue — الإعداد بيتحترم (٥ دقايق افتراضي، و٣٠ لو المالك رفعها)", () => {
  assert.equal(pl.linkDue(null, 5, NOW), true, "عمره ما اتعمل ⇒ مستحق");
  assert.equal(pl.linkDue("garbage", 5, NOW), true);
  assert.equal(pl.linkDue(minsAgo(4), 5, NOW), false);
  assert.equal(pl.linkDue(minsAgo(5), 5, NOW), true);
  assert.equal(pl.linkDue(minsAgo(29), 30, NOW), false);
  assert.equal(pl.linkDue(minsAgo(31), 30, NOW), true);
  assert.equal(pl.linkDue(NOW - 2 * 60_000, 2, NOW), true, "رقم ms كمان");
});

test("PC1: المسح الكامل لما يبقى مستحق — يومين، ≤١٥٠، بيحدّث lastLinkAt ودليل العملاء على إيقاعه", async () => {
  const many = Array.from({ length: 170 }, (_, i) => ({ id: 1000 + i, name: "ع" + i, phone: "05" + i }));
  const sc = scenario({ lastLinkAt: minsAgo(6), lastCustomersSyncAt: minsAgo(31), sales: () => many, custOrders: { 1000: [{ id: 9001 }] } });
  await sc.db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(posRow("9001")));
  const r = await pl.runLinkPass(sc.deps, { reason: "cycle" });
  assert.equal(r.mode, "full");
  assert.deepEqual(sc.tsCalls, [{ from: daysAgoISO(2), to: todayISO() }], "آخر يومين");
  assert.equal(sc.linkCalls.length, pl.FULL_PASS_CAP, "سقف ١٥٠ زي القديم");
  assert.equal(sc.db.orders.get("9001").customer_id, "1000");
  assert.equal(sc.insightsState.lastLinkAt, new Date(NOW).toISOString());
  assert.equal(sc.insightsState.lastLinkCount, 170); assert.equal(sc.insightsState.lastTodayLinkAt, sc.insightsState.lastLinkAt);
  assert.equal(sc.dirSyncs(), 1, "دليل العملاء اتحدّث (٣١ دقيقة > ٣٠)");
  assert.equal(sc.insightsState.lastCustomersSyncAt, new Date(NOW).toISOString());
});

test("PC1: الكامل مش مستحق وtodayPass مقفول ⇒ ولا طلب لتاب سينس", async () => {
  const cfg = pl.poslinkCfg({ insights: { todayPass: false } });
  const sc = scenario({ cfg, sales: () => { throw new Error("مايتنادش"); }, custOrders: {} });
  const r = await pl.runLinkPass(sc.deps, { reason: "new_orders" });
  assert.equal(r.ran, false); assert.deepEqual(sc.tsCalls, []); assert.equal(sc.insightsState.lastTodayLinkAt, null);
});

test("PC1: مسح النهارده بيقف عند سقفه (٦٠) — حد تاب سينس ٦٠/دقيقة", async () => {
  const many = Array.from({ length: 75 }, (_, i) => ({ id: 2000 + i, name: "ع" + i, phone: "" }));
  const sc = scenario({ sales: () => many, custOrders: {} });
  const r = await pl.runLinkPass(sc.deps, { reason: "cycle" });
  assert.equal(r.mode, "today"); assert.equal(sc.linkCalls.length, pl.TODAY_PASS_CAP); assert.equal(r.customers, 60);
});

test("PC1: فشل الصف الأدنى مايوقّفش الربط", async () => {
  const sc = scenario({ sales: () => [{ id: 1, name: "x", phone: "" }], custOrders: { 1: [{ id: 42 }] } });
  await sc.db.query(pl.ORDER_UPSERT_SQL, pl.orderUpsertParams(posRow("42")));
  const realQuery = sc.db.query.bind(sc.db);
  sc.db.query = async (sql, p) => { if (/INSERT INTO ts_customers/i.test(String(sql))) throw new Error("boom"); return realQuery(sql, p); };
  const r = await pl.runLinkPass(sc.deps, { reason: "cycle" });
  assert.equal(r.linked, 1); assert.equal(sc.db.orders.get("42").customer_id, "1");
});

/* ── ٤) customerPending ─────────────────────────────────────────────────── */
test("PC1: customerPending — من غير عميل وجوّه (linkEveryMin + syncEveryMin) دقيقة بس", () => {
  assert.equal(pl.pendingWindowMin(CFG), 10, "٥ + ٥ افتراضي");
  assert.equal(pl.customerPending(minsAgo(3), false, CFG, NOW), true, "٣ دقايق، من غير عميل ⇒ بيتربط");
  assert.equal(pl.customerPending(new Date(NOW - 9.5 * 60_000), false, CFG, NOW), true, "Date من pg كمان");
  assert.equal(pl.customerPending(minsAgo(15), false, CFG, NOW), false, "١٥ دقيقة ⇒ بدون عميل بجد");
  assert.equal(pl.customerPending(minsAgo(3), true, CFG, NOW), false, "معاه عميل ⇒ مش pending");
  assert.equal(pl.customerPending(null, false, CFG, NOW), false);
  const slow = pl.poslinkCfg({ insights: { linkEveryMin: 30, syncEveryMin: 5 } });
  assert.equal(pl.pendingWindowMin(slow), 35);
  assert.equal(pl.customerPending(minsAgo(20), false, slow, NOW), true, "النافذة بتتبع الإعداد");
});

test("PC1: todayPassRange — يوم الرياض، وقبل ٦ الصبح إمبارح كمان (الوردية بتقفل ٤ الفجر)", () => {
  assert.deepEqual(pl.todayPassRange(Date.parse("2026-10-17T17:00:00Z")), { from: "2026-10-17", to: "2026-10-17" }, "٢٠:٠٠ الرياض");
  assert.deepEqual(pl.todayPassRange(Date.parse("2026-10-17T20:30:00Z")), { from: "2026-10-17", to: "2026-10-17" }, "٢٣:٣٠ الرياض");
  assert.deepEqual(pl.todayPassRange(Date.parse("2026-10-17T23:00:00Z")), { from: "2026-10-17", to: "2026-10-18" }, "٠٢:٠٠ الرياض ⇒ إمبارح + النهارده");
  assert.deepEqual(pl.todayPassRange(Date.parse("2026-10-18T02:30:00Z")), { from: "2026-10-17", to: "2026-10-18" }, "٠٥:٣٠ الرياض");
  assert.deepEqual(pl.todayPassRange(Date.parse("2026-10-18T03:00:00Z")), { from: "2026-10-18", to: "2026-10-18" }, "٠٦:٠٠ الرياض ⇒ النهارده بس");
});

/* ── ٥) المخطط والحفظ ───────────────────────────────────────────────────── */
test("PC1: المخطط — المفاتيح والافتراضيات والحدود وتسميات عربية + help", () => {
  const byKey = Object.fromEntries(pl.POSLINK_SCHEMA.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(byKey).sort(), ["customersEveryMin", "linkEveryMin", "syncEveryMin", "todayPass"]);
  assert.equal(byKey.linkEveryMin.default, 5); assert.equal(byKey.linkEveryMin.min, 2); assert.equal(byKey.linkEveryMin.max, 60);
  assert.equal(byKey.syncEveryMin.default, 5); assert.equal(byKey.syncEveryMin.min, 1);
  assert.equal(byKey.todayPass.default, true); assert.equal(byKey.todayPass.type, "bool");
  assert.equal(byKey.customersEveryMin.default, 30);
  for (const x of pl.POSLINK_SCHEMA) { assert.ok(/[؀-ۿ]/.test(x.ar), x.key + " ar"); assert.ok(x.help && x.help.length > 20, x.key + " help"); assert.ok(pl.POSLINK_GROUPS[x.group], x.key + " group"); }
  const v = pl.schemaView({ insights: { linkEveryMin: 15 } });
  assert.equal(v.find((x) => x.key === "linkEveryMin").value, 15);
});

test("PC1: poslinkCfg — الافتراضي، الـfallback من البيئة، والتقصقص على الحدود", () => {
  assert.deepEqual(pl.poslinkCfg({}), { syncEveryMin: 5, linkEveryMin: 5, todayPass: true, customersEveryMin: 30 });
  assert.deepEqual(pl.poslinkCfg(null), pl.poslinkCfg({}));
  assert.equal(pl.poslinkCfg({}, { syncEveryMin: 7 }).syncEveryMin, 7, "إيقاع البيئة لما الإعداد مش متسجّل");
  assert.equal(pl.poslinkCfg({ insights: { syncEveryMin: 2 } }, { syncEveryMin: 7 }).syncEveryMin, 2, "الإعداد بيكسب البيئة");
  const c = pl.poslinkCfg({ insights: { linkEveryMin: 999, syncEveryMin: 0, todayPass: "0", customersEveryMin: "abc" } });
  assert.deepEqual(c, { syncEveryMin: 1, linkEveryMin: 60, todayPass: false, customersEveryMin: 30 });
  assert.equal(pl.poslinkCfg({ insights: "junk" }).linkEveryMin, 5);
});

test("PC1: cleanPoslinkSettings — بيرفض برّه الحدود والمفاتيح الغريبة من غير تقريب في صمت", () => {
  const bad = pl.cleanPoslinkSettings({ linkEveryMin: 1 }, {});
  assert.equal(bad.ok, false); assert.match(bad.errors[0][1], /من 2 لـ60/);
  const unk = pl.cleanPoslinkSettings({ foo: 1 }, {});
  assert.equal(unk.ok, false); assert.equal(unk.errors[0][0], "foo");
  const nan = pl.cleanPoslinkSettings({ syncEveryMin: "" }, {});
  assert.equal(nan.ok, false); assert.match(nan.errors[0][1], /اكتب رقم/);
  const badBool = pl.cleanPoslinkSettings({ todayPass: "maybe" }, {});
  assert.equal(badBool.ok, false);
  const ok = pl.cleanPoslinkSettings({ linkEveryMin: 10, todayPass: "0" }, { insights: { customersEveryMin: 45 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.cfg, { syncEveryMin: 5, linkEveryMin: 10, todayPass: false, customersEveryMin: 45 }, "اللي ماتبعتش بيفضل زي ما هو");
});
