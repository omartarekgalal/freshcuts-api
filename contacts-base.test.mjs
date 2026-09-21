/* قاعدة العملاء + جدولة جوجل (٢١/٩).
   السؤال اللي الاختبار ده بيحرسه: ليه تاب سينس بيقول ١٣٧٣ وإحنا بنشوف ١١٤٤؟
   عشان كل الشرايح والقوايم كانت مبنية على الطلبات، وعميل مسجّل وطلباته مش
   مربوطة بسجله ماكانش بيظهر خالص. الشريحة «all» دلوقتي بتضم cms_contacts،
   وجوجل بقت منصة رابعة في نفس السلّم.
     node --test contacts-base.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";

process.env.AUD_SCHEDULER = "0";
delete process.env.META_CAPI_TOKEN;
delete process.env.META_AD_ACCOUNT_ID;
delete process.env.TIKTOK_ACCESS_TOKEN;
delete process.env.SNAP_ACCESS_TOKEN;
delete process.env.GOOGLE_ADS_CUSTOMER_ID;

const { register } = await import("./audiences.js");

/** pool بيسجّل كل SQL، وبيفتح البوابة (syncAudiences=true) عشان نشوف الرفع. */
function harness({ policy = true } = {}) {
  const seen = [];
  const pool = {
    query: async (sql) => {
      const s = String(sql);
      seen.push(s);
      if (/data->>'syncAudiences' sa/.test(s)) {
        return { rows: [{ sa: String(policy), pc: "true", co: "false" }] };
      }
      if (/FROM ap_settings/.test(s)) return { rows: [{ v: String(policy) }] };
      // uploadgate: مفيش لاغيين، مفيش فريق، مفيش أرقام اختبار
      if (/FROM cms_contacts WHERE opted_out_at IS NOT NULL/.test(s)) return { rows: [] };
      if (/FROM settings WHERE id=1/.test(s)) return { rows: [{ data: {} }] };
      // الشرايح: رقمين وهميين عشان القايمة ماتبقاش فاضية
      if (/FROM ph/.test(s) || /FROM cms_contacts/.test(s)) {
        return { rows: [{ pn: "500000001" }, { pn: "500000002" }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const noop = () => {};
  const app = { get: noop, post: noop, put: noop, delete: noop, patch: noop, use: noop };
  const api = register(app, { pool, requireAdmin: async () => null, jb: (x) => JSON.stringify(x) });
  return { api, seen };
}

test("شريحة «كل العملاء» بقت من قاعدة العملاء مش من الطلبات بس", async () => {
  const h = harness();
  await h.api.syncAll({ segments: ["all"], platforms: [], dryRun: true });
  const q = h.seen.find((s) => /FROM ph/.test(s) && /UNION/.test(s));
  assert.ok(q, "لازم يكون فيه استعلام للشريحة all");
  assert.match(q, /FROM cms_contacts/, "all لازم تضم cms_contacts");
  assert.match(q, /NOT is_staff AND NOT is_test/, "أرقام الفريق/الاختبار مستبعدة من المصدر");
});

test("الشرايح السلوكية (vip/lapsed30/recent14/delivery) فضلت على الطلبات", async () => {
  for (const seg of ["vip", "lapsed30", "recent14", "delivery"]) {
    const h = harness();
    await h.api.syncAll({ segments: [seg], platforms: [], dryRun: true });
    const q = h.seen.find((s) => /FROM ph/.test(s));
    assert.ok(q, `استعلام ${seg} مفقود`);
    assert.doesNotMatch(q, /cms_contacts/, `${seg} مالهاش تبقى من قاعدة العملاء — تعريفها سلوكي`);
  }
});

test("جوجل بقت في السلّم: بتتسجّل في aud_upload_log زي باقي المنصات", async () => {
  const h = harness();
  const r = await h.api.syncAll({ trigger: "test" });
  assert.ok(r.results.google, "جوجل لازم تظهر في نتايج المزامنة");
  assert.ok(r.results.meta && r.results.tiktok && r.results.snapchat, "الباقي زي ما هو");
});

test("جوجل من غير توكن: skipped بسبب مكتوب — مش failed بيتكرر كل دورة", async () => {
  const h = harness();
  const r = await h.api.syncAll({ segments: ["all"], platforms: ["google"], trigger: "test" });
  const g = r.results.google.all;
  assert.equal(g.ok, true, "غياب الإعداد مش عطل");
  assert.ok(g.skipped, "لازم يقول السبب");
});
