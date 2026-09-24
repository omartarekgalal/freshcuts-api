/* ⏱ GET /api/service/report — المسار نفسه (node --test service-report-api.test.mjs)
   Hono حقيقي + قاعدة وهمية بتردّ على كل استعلام بحسب شكله + مقبض bizreports
   وهمي. الهدف تلات حاجات:
     ١) الاستعلامات بتتبني صح (حدود النافذة على كل عمود، ومفتاح ساعة الرياض).
     ٢) الرد فيه الخط الزمني بترتيب الوقت الحقيقي — ١ الفجر بعد ٢٣.
     ٣) لو مقبض bizreports مش موجود، الشاشة مابتقعش: الباقي بيرجع ومعاه error.
   مفيش قاعدة حقيقية ولا شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { register } from "./service.js";

const ADMIN = "admin-token-abc";
/* ساعة الرياض h = UTC h−3 */
const R = (day, h, m = 0) => new Date(Date.UTC(2026, 8, day, h - 3, m, 0));
const iso = (d) => d.toISOString();

const NOW = R(24, 7);   // ٧ الصبح الرياض — كل نوافذ الاختبار خلصت قبلها

function build({ withBiz = true, posRows = [], now = NOW } = {}) {
  const seen = [];
  const pool = {
    query: async (sql, vals = []) => {
      sql = String(sql);
      seen.push({ sql, vals });
      const rows = (r) => ({ rows: r, rowCount: r.length });
      if (/FROM journey_sessions/.test(sql) && /GROUP BY 1/.test(sql)) {
        return rows([
          { hkey: "2026-09-23 22", sessions: 40, cart: 5, paid: 2, known: 3 },
          { hkey: "2026-09-24 01", sessions: 12, cart: 1, paid: 0, known: 1 },
        ]);
      }
      if (/FROM journey_sessions/.test(sql)) {
        return rows([{ sessions: 60, reached_cart: 7, known: 5, paid: 3, cart_value: 900 }]);
      }
      if (/FROM ad_spend_hourly/.test(sql)) return rows([{ hkey: "2026-09-23 23", sar: "88.50" }]);
      if (/FROM shop_orders/.test(sql) && /GROUP BY 1/.test(sql)) return rows([{ hkey: "2026-09-24 00", n: 2 }]);
      if (/FROM shop_orders/.test(sql)) return rows([{ n: 6, sar: 700, delivery: 5, pickup: 1, unpaid: 2 }]);
      if (/item_sold_out/.test(sql)) {
        return rows([{ hkey: "2026-09-23 23", at: iso(R(23, 23, 10)), action: "item_sold_out", detail: { name: "كيلو مشاوي" } }]);
      }
      if (/FROM ts_orders/.test(sql)) return rows(posRows);
      if (/FROM open_waitlist/.test(sql) && /count\(\*\)/.test(sql)) return rows([{ n: 1, sar: 90 }]);
      if (/FROM open_waitlist/.test(sql)) return rows([]);
      if (/FROM sms_log/.test(sql)) return rows([]);
      if (/service\\?_%/.test(sql) || /portal_audit/.test(sql)) {
        return rows([{ at: iso(R(23, 22, 30)), action: "service_pause", channel: "delivery", staff_name: "المالك", role: "manager", detail: {} },
                     { at: iso(R(24, 0, 0)), action: "service_resume", channel: "delivery", staff_name: "المالك", role: "manager", detail: {} }]);
      }
      return rows([]);
    },
  };
  const ctx = {
    pool, getSettingsData: async () => ({}), jb: (x) => JSON.stringify(x),
    requireAdmin: async (c) => (c.req.header("authorization") === `Bearer ${ADMIN}` ? null : c.json({ ok: false }, 401)),
  };
  const biz = {
    settings: async () => ({ apps: ["keeta"], rates: {}, basis: "net" }),
    loadWindow: async () => ({
      rows: [
        { src: "pos", ch: "hall", ts: iso(R(23, 22, 5)), total: 100 },
        { src: "store", ch: "store", ts: iso(R(23, 23, 40)), total: 220 },
        { src: "pos", ch: "app:keeta", ts: iso(R(24, 0, 15)), total: 130 },
        { src: "store", ch: "store", ts: iso(R(24, 1, 50)), total: 70 },
        { src: "pos", ch: "takeaway", ts: iso(R(24, 1, 55)), total: 45 },
      ],
      stats: { mirrors: 1, unmatchedExternal: 0 },
    }),
  };
  const app = new Hono();
  register(app, ctx, { now: () => now, ...(withBiz ? { biz: () => biz } : {}) });
  const get = async (qs) => {
    const res = await app.request(`/api/service/report?${qs}`, { headers: { authorization: `Bearer ${ADMIN}` } });
    return { status: res.status, body: await res.json() };
  };
  return { get, seen, app };
}

const WIN = `from=${encodeURIComponent(iso(R(23, 22)))}&to=${encodeURIComponent(iso(R(24, 2)))}`;

test("لازم توكن إدارة", async () => {
  const { app } = build();
  const res = await app.request("/api/service/report?hours=3");
  assert.equal(res.status, 401);
});

test("الخط الزمني: ٢٢ ← ٢٣ ← ٠٠ ← ٠١، و١ الفجر بعد ٢٣ مش قبلها", async () => {
  const { body } = await build().get(WIN);
  assert.equal(body.ok, true);
  const hs = body.hourly.hours;
  assert.deepEqual(hs.map((h) => h.hour), [22, 23, 0, 1]);
  assert.ok(hs.findIndex((h) => h.hour === 1) > hs.findIndex((h) => h.hour === 23));
  // كلهم على نفس اليوم التشغيلي (القطع ٤ الفجر)
  assert.deepEqual(body.range.bizDays, ["2026-09-23"]);
  assert.deepEqual(hs.map((h) => h.bizHourIndex), [18, 19, 20, 21]);
});

test("الطلبات بتقع في ساعتها وبقناتها، والمجموع من السيرفر", async () => {
  const { body } = await build().get(WIN);
  const hs = body.hourly.hours;
  assert.deepEqual(hs.map((h) => h.orders.n), [1, 1, 1, 2]);
  assert.equal(hs[0].ch.hall.n, 1);
  assert.equal(hs[1].ch.store.sar, 220);
  assert.equal(hs[2].ch.apps.n, 1);
  assert.deepEqual(hs[2].apps, { keeta: { n: 1, sar: 130 } });
  assert.equal(hs[3].ch.store.n, 1);
  assert.equal(hs[3].ch.takeaway.n, 1);
  assert.equal(body.hourly.totals.orders.n, 5);
  assert.equal(body.hourly.totals.orders.sar, 565);
  assert.deepEqual(body.hourly.apps, ["keeta"]);
  assert.deepEqual(body.hourly.appLabels, { keeta: "كيتا" });
  assert.equal(body.hourly.stats.mirrors, 1);
});

test("الزوار والصرف و«خلص» و«وقف على الدفع» بيقعوا في ساعتهم", async () => {
  const { body } = await build().get(WIN);
  const by = Object.fromEntries(body.hourly.hours.map((h) => [h.hour, h]));
  assert.equal(by[22].visitors.sessions, 40);
  assert.equal(by[22].visitors.cart, 5);
  assert.equal(by[1].visitors.sessions, 12);
  assert.equal(by[23].spend, 88.5);
  assert.equal(by[23].soldOut, 1);
  assert.equal(by[0].stuck, 2);
  assert.equal(body.hourly.flags[0].name, "كيلو مشاوي");
  assert.equal(body.hourly.flags[0].kind, "closed");
  // مجموع الزوار في الخط الزمني = نفس تعريف كرت الزوار (cart_max > 0)
  assert.equal(body.hourly.totals.visitors.sessions, 52);
});

test("دقايق الإيقاف موزّعة على الساعات ومجموعها = رقم المدى", async () => {
  const { body } = await build().get(WIN);
  assert.deepEqual(body.hourly.hours.map((h) => h.pausedMin.delivery), [30, 60, 0, 0]);
  assert.equal(body.pausedMinutes.delivery, 90);
  assert.equal(body.pausedMinutes.pickup, 0);
});

test("ملف الساعات مرتّب بترتيب اليوم التشغيلي", async () => {
  const { body } = await build().get(WIN);
  const idx = body.hourProfile.map((p) => p.bizHourIndex);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual(body.hourProfile.map((p) => p.hour), [22, 23, 0, 1]);
  assert.ok(body.hourProfile.every((p) => p.days === 1));
});

test("جدول نقطة البيع القديم بقى مرتّب تشغيلياً — ٠١ بعد ٢١ مش قبلها", async () => {
  // ده الباج القديم بالظبط: ORDER BY 'HH24' كان بيدّي 00,01,02,21,22
  const posRows = [{ n: 4, sar: 243, hh: "00" }, { n: 2, sar: 197, hh: "01" },
                   { n: 1, sar: 96, hh: "02" }, { n: 6, sar: 862, hh: "21" }, { n: 3, sar: 274, hh: "22" }];
  const { body } = await build({ posRows }).get(WIN);
  assert.deepEqual(body.pos.rows.map((r) => r.hh), ["21", "22", "00", "01", "02"]);
  assert.equal(body.pos.n, 16);
});

test("كل استعلام بياخد نفس الحدود ($1,$2) وبيقص على الرياض", async () => {
  const h = build();
  await h.get(WIN);
  const qs = h.seen.filter((x) => !/^\s*CREATE/.test(x.sql));
  assert.ok(qs.length >= 11, `المفروض ١١ استعلام على الأقل، طلعوا ${qs.length}`);
  for (const { sql, vals } of qs) {
    if (!/\$1/.test(sql)) continue;
    assert.ok(/>= \$1::timestamptz/.test(sql), `مفيش حد بداية:\n${sql}`);
    assert.ok(/< \$2::timestamptz/.test(sql), `مفيش حد نهاية حصري:\n${sql}`);
    assert.equal(vals.length, 2);
    assert.equal(new Date(vals[0]).toISOString(), iso(R(23, 22)));
    assert.equal(new Date(vals[1]).toISOString(), iso(R(24, 2)));
  }
  // أي استعلام بيطلع مفتاح ساعة لازم يحوّل للرياض — الفخ اللي غلّط الساعات قبل كده
  for (const { sql } of qs.filter((x) => /AS hkey/.test(x.sql))) {
    assert.match(sql, /AT TIME ZONE 'Asia\/Riyadh', 'YYYY-MM-DD HH24'/);
  }
  // ومفيش NOW() - INTERVAL فاضل (كان بيدّي حدود مختلفة لكل استعلام)
  assert.ok(!qs.some((x) => /NOW\(\) - INTERVAL/.test(x.sql)));
});

test("hours=: نافذة مقفولة من دلوقتي لورا، والرد لسه فيه range.hours للتوافق", async () => {
  const h = build();
  const { body } = await h.get("hours=3");
  assert.equal(body.range.hours, 3);
  assert.ok(body.range.startUtc && body.range.cutUtc);
  const span = (Date.parse(body.range.cutUtc) - Date.parse(body.range.startUtc)) / 3600_000;
  assert.ok(Math.abs(span - 3) < 0.01);
  assert.ok(body.hourly.hours.length >= 3 && body.hourly.hours.length <= 4);
});

test("من غير مقبض bizreports: الشاشة مابتقعش — الباقي بيرجع ومعاه error", async () => {
  const { body } = await build({ withBiz: false }).get(WIN);
  assert.equal(body.ok, true);
  assert.equal(body.hourly.error, "biz_unavailable");
  assert.equal(body.hourly.totals.orders.n, 0);
  // الزوار والإيقاف لسه شغّالين
  assert.equal(body.hourly.totals.visitors.sessions, 52);
  assert.equal(body.pausedMinutes.delivery, 90);
  assert.equal(body.visitors.sessions, 60);
});

test("مدى بيعدّي ٤ الفجر: اليوم التشغيلي بيتقسم واليوم الجديد بيبدأ من ٤", async () => {
  const h = build();
  const { body } = await h.get(`from=${encodeURIComponent(iso(R(24, 2)))}&to=${encodeURIComponent(iso(R(24, 6)))}`);
  assert.deepEqual(body.hourly.hours.map((x) => x.hour), [2, 3, 4, 5]);
  assert.deepEqual(body.hourly.hours.map((x) => x.bizDay),
    ["2026-09-23", "2026-09-23", "2026-09-24", "2026-09-24"]);
  assert.deepEqual(body.range.bizDays, ["2026-09-23", "2026-09-24"]);
  // وملف الساعات لسه بترتيب اليوم التشغيلي: ٤ و٥ الأول بعدين ٢ و٣
  assert.deepEqual(body.hourProfile.map((p) => p.hour), [4, 5, 2, 3]);
});
