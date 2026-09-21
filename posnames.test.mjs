/* اسم العميل في نقطة البيع — posnames.js
   السبب: نقطة البيع بتعرض اسم دفتر العملاء على كل طلب وفاتورة للرقم ده،
   وبتتجاهل الاسم اللي جوه الطلب. فالنص المؤقت «عميل أونلاين» بقى اسم دايم
   لعملاء حقيقيين (عمر ٢١/٩). الاختبارات دي بتقفل الباب ده من ٣ نواحي:
   القاعدة نفسها، اللي مسموح نكتبه في الدفتر، والتصليح/الربط بـpool مزيّف.
     node --test posnames.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { plausibleName, splitName, writableName, POS_NAME_SQL, register } from "./posnames.js";

/* ═══ ١) القاعدة: إيه اللي يعتبر اسم ═════════════════════════════════════ */

test("النصوص المؤقتة بتاعتنا مش أسماء", () => {
  for (const s of ["عميل", "عميل أونلاين", "عميل اونلاين", "عميل توصيل", "عميل توصيل عبدالله ٠٠"]) {
    assert.equal(plausibleName(s), false, s);
  }
});

test("نصوص الكاشير المعروفة مش أسماء", () => {
  for (const s of ["", " ", "1", "0551234567", "الاسم الكامل 111111", "full name", "unknown", "test", "بدون اسم"]) {
    assert.equal(plausibleName(s), false, JSON.stringify(s));
  }
});

test("الأسماء الحقيقية بتعدّي — بالعربي والإنجليزي، وكلمة «عميلة» اسم بني آدم", () => {
  // «Test Customer» اسم عادي: القاعدة مثبّتة على أول الاسم مش على أي جزء منه،
  // عشان قاعدة واسعة كانت هتمنع عملاء بيدفعوا من الشيك أوت.
  for (const s of ["زياد محمد", "ahmed elbeltagy", "د. هاني السيد", "ام ماريا", "عميلة", "عميلة الصفا", "Test Customer", "Nadia Testa"]) {
    assert.equal(plausibleName(s), true, s);
  }
});

/* ═══ ٢) اللي مسموح نكتبه في دفتر تاب سينس ═══════════════════════════════
   قواعد الرفض الصامت: اسم أول < ٣ حروف مرفوض، لقب من حرف/حرفين مرفوض،
   واللقب الفاضي مقبول (ذاكرة tabsense-create-customer-rules). */

test("اللقب القصير بيتشال بدل ما الصف كله يتـرفض", () => {
  assert.deepEqual(splitName("Fawaz H"), { first: "Fawaz", last: "" });
  assert.deepEqual(splitName("محمود ابوالعطا"), { first: "محمود", last: "ابوالعطا" });
  assert.deepEqual(splitName("  زياد   محمد  علي "), { first: "زياد", last: "محمد علي" });
});

test("اسم أول أقل من ٣ حروف = مش قابل للكتابة (تاب سينس بترفضه بصمت)", () => {
  assert.equal(writableName("M E"), null);
  assert.equal(writableName("لي"), null);
  assert.equal(writableName("عميل أونلاين"), null);
  assert.equal(writableName("Mohamed Adel").full, "Mohamed Adel");
  assert.equal(writableName("Fawaz H").full, "Fawaz");
});

/* ═══ ٣) SQL العرض: نص مؤقت في الدفتر مايكسبش اسم حقيقي على الطلب ══════ */

test("POS_NAME_SQL بيستبعد النص المؤقت قبل ما يفضّل اسم الدفتر", () => {
  const sql = POS_NAME_SQL("tc", "s");
  assert.match(sql, /tc\.name/);
  assert.match(sql, /s\.customer_name/);
  assert.match(sql, /عميل/);           // شرط الاستبعاد موجود
});

/* ═══ ٤) التصليح والربط بـpool مزيّف (مفيش شبكة ولا داتابيز) ════════════ */

function fakeApp() {
  const routes = new Map();
  const on = (m) => (p, h) => routes.set(`${m} ${p}`, h);
  return { get: on("GET"), post: on("POST"), put: on("PUT"), routes };
}
const ctx = (queryFn) => ({
  pool: { query: queryFn },
  requireAdmin: async () => null,
  normPhone: (p) => String(p || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""),
});

function mk(queryFn, deps = {}) {
  process.env.POSNAMES_CRON = "0";           // مفيش كنس دوري جوه الاختبار
  return register(fakeApp(), ctx(queryFn), deps);
}

test("bestNameFor: الحساب بيكسب، والنص المؤقت مابيتحسبش", async () => {
  const api = mk(async () => ({ rows: [{ acct: "عميل أونلاين", shop: "زياد محمد", cashier: "M E" }] }));
  assert.equal(await api.bestNameFor("532097915"), "زياد محمد");
});

test("bestNameFor: مفيش أي اسم حقيقي → null (ومابنخترعش اسم)", async () => {
  const api = mk(async () => ({ rows: [{ acct: "", shop: "عميل", cashier: null }] }));
  assert.equal(await api.bestNameFor("532097915"), null);
});

test("bestNameFor: جوال مش سعودي → null من غير أي نداء", async () => {
  let called = 0;
  const api = mk(async () => { called++; return { rows: [{}] }; });
  assert.equal(await api.bestNameFor("12345"), null);
  assert.equal(called, 0);
});

test("ensurePosName: اسم حقيقي في الدفتر مابيتدهسش", async () => {
  process.env.TABSENSE_EMAIL = "x@y.z"; process.env.TABSENSE_PASSWORD = "p";
  const api = mk(async (sql) => {
    if (/FROM ts_customers WHERE phone_norm/.test(sql)) return { rows: [{ customer_id: "1379", name: "زياد محمد" }] };
    return { rows: [{ acct: "اسم تاني", shop: null, cashier: null }] };
  });
  const r = await api.ensurePosName("532097915");
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.reason, "already_named");
});

test("ensurePosName: مفيش اسم حقيقي عندنا → مابنكتبش حاجة", async () => {
  process.env.TABSENSE_EMAIL = "x@y.z"; process.env.TABSENSE_PASSWORD = "p";
  const api = mk(async () => ({ rows: [{ acct: null, shop: "عميل أونلاين", cashier: null }] }));
  const r = await api.ensurePosName("532097915");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_real_name");
});

test("ensurePosName: تاب سينس مقفولة → سبب واضح مش استثناء", async () => {
  const email = process.env.TABSENSE_EMAIL;
  delete process.env.TABSENSE_EMAIL;
  const api = mk(async () => ({ rows: [{}] }));
  assert.deepEqual(await api.ensurePosName("532097915"), { ok: false, reason: "tabsense_off" });
  if (email) process.env.TABSENSE_EMAIL = email;
});

test("linkPosOrders: بياخد tenant_order_id من الشريك ويربط الطلب بالعميل", async () => {
  const writes = [];
  const api = mk(async (sql, p = []) => {
    if (/FROM shop_orders\s+WHERE pos_order_id IS NOT NULL/.test(sql)) {
      return { rows: [{ order_no: "W1", pos_order_id: "mko7mRE8wp", pos_tenant_order_id: null,
                        phone_norm: "532097915", name: "زياد محمد" }] };
    }
    if (/FROM order_sources WHERE order_id/.test(sql)) return { rowCount: 0, rows: [] };
    writes.push({ sql, p });
    return { rowCount: 1, rows: [] };
  }, { tsp: () => ({ api: async () => ({ data: { tenant_order_id: "freshcuts-4287" } }) }) });

  const out = await api.linkPosOrders({ limit: 5 });
  assert.equal(out.linked, 1);
  const ins = writes.find((w) => /INSERT INTO order_sources/.test(w.sql));
  assert.ok(ins, "لازم يكتب صف order_sources");
  assert.equal(ins.p[0], "4287");                 // الـid الرقمي، مش المقنّع
  assert.equal(ins.p[2], "زياد محمد");
  assert.equal(ins.p[4], "532097915");
  assert.match(ins.sql, /'website'/);
  // الصف اللي كتبه الكاشير مايتدهسش
  assert.match(ins.sql, /filled_by IN \('auto','shop'\)/);
});

test("linkPosOrders: طلب مربوط قبل كده مابيتلمسش", async () => {
  const api = mk(async (sql) => {
    if (/FROM shop_orders\s+WHERE pos_order_id IS NOT NULL/.test(sql)) {
      return { rows: [{ order_no: "W1", pos_order_id: "x", pos_tenant_order_id: "4287",
                        phone_norm: "532097915", name: "زياد محمد" }] };
    }
    if (/FROM order_sources WHERE order_id/.test(sql)) {
      return { rowCount: 1, rows: [{ filled_by: "cashier", pn: "532097915" }] };
    }
    throw new Error("مالوش لازمة: " + sql.slice(0, 40));
  });
  const out = await api.linkPosOrders({ limit: 5 });
  assert.equal(out.alreadyLinked, 1);
  assert.equal(out.linked, 0);
});

test("tenantOrderIdOf: بيشيل بادئة المتجر ويرجّع الرقم", async () => {
  const api = mk(async () => ({ rows: [] }),
    { tsp: () => ({ api: async () => ({ data: { tenant_order_id: "freshcuts-4296" } }) }) });
  assert.equal(await api.tenantOrderIdOf("abc"), "4296");
});
