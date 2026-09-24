/* ═══════════════════════════════════════════════════════════════════════════
   حجز إرسال المندوب في الكنس (٢٤ سبتمبر ٢٠٢٦)

   الباج: الكنس بيحجز الطلب (dispatch_claimed_at=NOW()) **قبل** ما يحاول
   يطلب الكابتن، وأي فشل كان بيتسجّل في اللوج وخلاص — الحجز مايترجّعش.
   وبما إن اختيار الكنس نفسه شرطه `dispatch_claimed_at IS NULL`، فشلة واحدة
   كانت بتطفّي الإرسال التلقائي للطلب ده **للأبد**: يستنى مهلة الـ٢٠ دقيقة،
   يرن إنذار، وبني آدم يدوس الزرار. دقيقة ٥xx من شركة التوصيل وقت الذروة =
   ٦–١٠ طلبات كلها متأخرة.

   والإصلاح لازم يكون دقيق: إعادة عمياء بعد أي فشل = كابتنين على طلب واحد
   لو الفشل كان مشكوك فيه (timeout/٥xx/سوكيت اتقطع — ممكن الشركة سجّلت
   الطلب وإحنا ماشوفناش الرد). فالحجز بيترجّع **بس** للفشل الأكيد قبل
   الإرسال، بنفس التصنيف اللي البوابة بتستعمله (dispatchFailure).

     node --test dispatch-claim.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { register as registerShop, dispatchFailure } from "./shop.js";

/* ═══ ١) التصنيف نفسه (صافي) ═════════════════════════════════════════════ */

const err = (o) => Object.assign(new Error(o.message || "boom"), o);

test("التصنيف: فشل قبل الشبكة = أكيد ⇒ إعادة", () => {
  for (const code of ["COURIER_UNCONFIGURED", "MANUAL_MODE", "BAD_STAGE", "BAD_PROVIDER"]) {
    const f = dispatchFailure(err({ code }));
    assert.equal(f.certain, true, code);
    assert.equal(f.retry, true, code);
    assert.equal(f.stop, false, code);
  }
});

test("التصنيف: 4xx = رفض صريح منهم ⇒ إعادة، ما عدا 408/409", () => {
  for (const st of [400, 401, 403, 404, 422]) assert.equal(dispatchFailure(err({ status: st })).retry, true, `${st}`);
  for (const st of [408, 409]) assert.equal(dispatchFailure(err({ status: st })).retry, false, `${st}`);
});

test("التصنيف: 5xx/timeout/خطأ بلا كود = مشكوك فيه ⇒ الحجز يفضل", () => {
  for (const e of [err({ status: 500 }), err({ status: 502 }), err({ status: 503 }),
    err({ code: "ETIMEDOUT" }), err({ code: "ECONNRESET" }), err({ message: "socket hang up" })]) {
    const f = dispatchFailure(e);
    assert.equal(f.retry, false, JSON.stringify({ code: f.code, status: f.status }));
  }
});

test("التصنيف: خطأ مش Error خالص (undefined/{}) ⇒ مشكوك فيه، مش وقوع", () => {
  for (const e of [undefined, null, {}, "boom"]) {
    const f = dispatchFailure(e);
    assert.equal(f.retry, false, JSON.stringify(e ?? null));
    assert.equal(f.code, null);
  }
});

test("التصنيف: أكواد القفل عمرها ما تتعاد — حتى لو جات بـ4xx", () => {
  // COURIER_DUPLICATE بييجي فعلاً بـstatus 400 من لاجلك — لازم يفضل قفل
  for (const code of ["COURIER_DUPLICATE", "DISPATCH_BLOCKED", "DISPATCH_LOST",
    "DISPATCH_IN_PROGRESS", "ALREADY_DISPATCHED"]) {
    const f = dispatchFailure(err({ code, status: 400 }));
    assert.equal(f.stop, true, code);
    assert.equal(f.certain, false, code);
    assert.equal(f.retry, false, code);
  }
});

/* ═══ ٢) الكنس نفسه — قاعدة بيانات وهمية لصف واحد ════════════════════════
   بنقلّد اللي يهم بس: عمود الحجز وشرط الذرّية. أي استعلام تاني بيرجّع فاضي،
   فباقي خطوات الكنس بتعدّي من غير ما تعمل حاجة.                          */

const ORDER_NO = "W1790200000001";

function build({ dispatch, shipmentOf = async () => null, settings = { shop: { autoDispatch: true } } } = {}) {
  const prevSweep = process.env.SHOP_SWEEP_SECONDS, prevTsp = process.env.TSP_AUTO_ORDER;
  process.env.SHOP_SWEEP_SECONDS = "0";      // مفيش مؤقّت في الاختبار
  delete process.env.TSP_AUTO_ORDER;         // مفيش فحص شريك

  // الصف: مقبول، توصيل، ومحدش حجزه
  const row = {
    order_no: ORDER_NO, status: "accepted", option: "delivery", total: 96,
    history: [], delivery_quote: null, is_test: false, scheduled_for: null,
    pos_ready_at: new Date(Date.now() - 30 * 60000).toISOString(),
    dispatch_claimed_at: null,
  };
  const log = { claims: 0, releases: 0, statusSets: [] };
  let claimSeq = 0;
  const app = { get() {}, post() {}, put() {}, delete() {} };

  const pool = {
    query: async (sql, vals = []) => {
      const s = String(sql);
      // اللي الكنس بيدوّر عليه: مقبول + توصيل + مش محجوز
      if (/FROM shop_orders\s+WHERE status='accepted' AND option='delivery' AND dispatch_claimed_at IS NULL/.test(s)) {
        return row.dispatch_claimed_at === null && row.status === "accepted"
          ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // الحجز الذري
      if (/UPDATE shop_orders SET dispatch_claimed_at=NOW\(\)\s+WHERE order_no=\$1 AND dispatch_claimed_at IS NULL AND status='accepted'/.test(s)) {
        if (row.dispatch_claimed_at !== null || row.status !== "accepted") return { rows: [], rowCount: 0 };
        row.dispatch_claimed_at = `claim-${++claimSeq}`;
        log.claims++;
        return { rows: [{ claimed: row.dispatch_claimed_at }], rowCount: 1 };
      }
      // رجوع الحجز (الإصلاح): مقفول على نفس قيمة الحجز
      if (/UPDATE shop_orders SET dispatch_claimed_at = NULL\s+WHERE order_no=\$1 AND status='accepted' AND dispatch_claimed_at::text = \$2/.test(s)) {
        if (row.status !== "accepted" || row.dispatch_claimed_at !== vals[1]) return { rows: [], rowCount: 0 };
        row.dispatch_claimed_at = null;
        log.releases++;
        return { rows: [{ order_no: ORDER_NO }], rowCount: 1 };
      }
      if (/SELECT \* FROM shop_orders WHERE order_no/.test(s)) return { rows: [{ ...row }], rowCount: 1 };
      if (/UPDATE shop_orders SET status=\$2/.test(s)) {
        log.statusSets.push(vals[1]);
        row.status = vals[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const calls = [];
  const api = registerShop(app, {
    pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
    getSettingsData: async () => settings, jb: (v) => JSON.stringify(v),
    normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9),
  }, {
    pay: { configured: () => true },
    delivery: {
      quote: async () => ({ deliverable: true, fee: 0 }),
      shipmentOf, cancelShipment: async () => null,
      dispatchGate: async () => ({ mode: "auto" }),
      canAutoDispatch: async () => true,
      dispatch: async (o, opt) => { calls.push({ orderNo: o.order_no, ...opt }); return dispatch(calls.length); },
    },
    emitOrder: () => {},
  });

  const restore = () => {
    if (prevSweep === undefined) delete process.env.SHOP_SWEEP_SECONDS; else process.env.SHOP_SWEEP_SECONDS = prevSweep;
    if (prevTsp === undefined) delete process.env.TSP_AUTO_ORDER; else process.env.TSP_AUTO_ORDER = prevTsp;
  };
  return { api, pool, row, calls, log, restore };
}

const ticks = async (api, n) => { for (let i = 0; i < n; i++) await api.sweep(); };

test("نجاح: الحجز بيفضل، والحالة بتتحرك، ومفيش إرسال تاني", async () => {
  const s = build({ dispatch: async () => ({ provider: "leajlak", faOrderId: "x1" }) });
  try {
    await ticks(s.api, 4);
    assert.equal(s.calls.length, 1, "مرة واحدة بس");
    assert.equal(s.log.releases, 0, "نجح ⇒ الحجز عمره ما يترجّع");
    assert.notEqual(s.row.dispatch_claimed_at, null);
    assert.deepEqual(s.log.statusSets, ["courier_requested"]);
  } finally { s.restore(); }
});

test("فشل أكيد (مفاتيح ناقصة): الحجز يترجّع والدورة الجاية تحاول تاني", async () => {
  const s = build({ dispatch: async (n) => { if (n === 1) throw err({ code: "COURIER_UNCONFIGURED" }); return { provider: "leajlak" }; } });
  try {
    await s.api.sweep();
    assert.equal(s.calls.length, 1);
    assert.equal(s.log.releases, 1, "الحجز لازم يترجّع");
    assert.equal(s.row.dispatch_claimed_at, null, "NULL عشان اختيار الكنس (IS NULL) يشوفه تاني");
    // الدورة الجاية: بيتلقط ويتبعت وينجح — من غير أي تدخل بشري
    await s.api.sweep();
    assert.equal(s.calls.length, 2, "الدورة التانية لقطته");
    assert.deepEqual(s.log.statusSets, ["courier_requested"]);
    // وبعد النجاح مفيش ولا إرسال زيادة
    await ticks(s.api, 3);
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
});

test("فشل أكيد (رفض 400 منهم): نفس السلوك — إعادة", async () => {
  const s = build({ dispatch: async (n) => { if (n === 1) throw err({ status: 400, message: "bad address" }); return { provider: "leajlak" }; } });
  try {
    await ticks(s.api, 2);
    assert.equal(s.calls.length, 2);
    assert.equal(s.log.releases, 1);
  } finally { s.restore(); }
});

test("فشل مشكوك فيه (٥٠٢): الحجز بيفضل ومفيش إعادة أبداً — كابتنين أغلى من تأخيرة", async () => {
  const s = build({ dispatch: async () => { throw err({ status: 502, message: "bad gateway" }); } });
  try {
    await ticks(s.api, 5);
    assert.equal(s.calls.length, 1, "محاولة واحدة بس — ممكن تكون وصلتهم فعلاً");
    assert.equal(s.log.releases, 0);
    assert.notEqual(s.row.dispatch_claimed_at, null, "الحجز لازم يفضل");
    assert.deepEqual(s.log.statusSets, [], "الحالة فضلت «مقبول» فمراقب المهل بيصعّد لبني آدم");
  } finally { s.restore(); }
});

test("فشل مشكوك فيه (timeout/سوكيت): الحجز بيفضل", async () => {
  for (const e of [err({ code: "ETIMEDOUT" }), err({ status: 408 }), err({ message: "socket hang up" })]) {
    const s = build({ dispatch: async () => { throw e; } });
    try {
      await ticks(s.api, 3);
      assert.equal(s.calls.length, 1, e.code || e.status || e.message);
      assert.equal(s.log.releases, 0);
    } finally { s.restore(); }
  }
});

test("«موجود عندهم» (COURIER_DUPLICATE): قفل — الحجز بيفضل ولا إعادة", async () => {
  const s = build({ dispatch: async () => { throw err({ code: "COURIER_DUPLICATE", status: 400 }); } });
  try {
    await ticks(s.api, 5);
    assert.equal(s.calls.length, 1);
    assert.equal(s.log.releases, 0);
  } finally { s.restore(); }
});

test("شحنة حيّة على الطلب: مهما كان شكل الفشل، الحجز مايترجّعش", async () => {
  const s = build({
    dispatch: async () => { throw err({ code: "COURIER_UNCONFIGURED" }); },   // «أكيد» في العادي
    shipmentOf: async () => ({ id: 7, provider: "leajlak", status: "assigned" }),
  });
  try {
    await ticks(s.api, 3);
    assert.equal(s.calls.length, 1, "فيه كابتن فعلاً ⇒ ممنوع نبعت تاني");
    assert.equal(s.log.releases, 0);
  } finally { s.restore(); }
});

test("شحنة ملغية مش شحنة: الإعادة بتكمل عادي", async () => {
  const s = build({
    dispatch: async (n) => { if (n === 1) throw err({ code: "BAD_STAGE" }); return { provider: "leajlak" }; },
    shipmentOf: async () => ({ id: 7, provider: "leajlak", status: "cancelled" }),
  });
  try {
    await ticks(s.api, 2);
    assert.equal(s.calls.length, 2);
    assert.equal(s.log.releases, 1);
  } finally { s.restore(); }
});

test("سؤال الشحنة نفسه لو وقع: نعتبرها مشكوك فيها ونسيب الحجز", async () => {
  const s = build({
    dispatch: async () => { throw err({ code: "COURIER_UNCONFIGURED" }); },
    shipmentOf: async () => { throw new Error("db down"); },
  });
  try {
    await ticks(s.api, 3);
    assert.equal(s.calls.length, 1);
    assert.equal(s.log.releases, 0, "ماتأكدناش ⇒ ما نفكّش الحجز");
  } finally { s.restore(); }
});

test("رفض أكيد ثابت: ٣ إعادات وبعدها بني آدم — مفيش لفّة سريعة للأبد", async () => {
  const s = build({ dispatch: async () => { throw err({ status: 400, message: "invalid phone" }); } });
  try {
    await ticks(s.api, 12);
    assert.equal(s.log.releases, 3, "٣ إعادات بالكتير");
    assert.equal(s.calls.length, 4, "٤ محاولات (الأصلية + ٣ إعادات) وبعدها وقفة");
    assert.notEqual(s.row.dispatch_claimed_at, null, "بيقف محجوز فمراقب المهل يصعّد");
  } finally { s.restore(); }
});

test("دورتين كنس في نفس اللحظة: الحجز الذري بيخلّي الإرسال مرة واحدة", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = build({ dispatch: async () => { await gate; return { provider: "leajlak" }; } });
  try {
    const a = s.api.sweep();
    const b = s.api.sweep();
    release();
    await Promise.all([a, b]);
    assert.equal(s.calls.length, 1, "كابتن واحد بس");
    assert.equal(s.log.claims, 1);
  } finally { s.restore(); }
});

test("الحجز اتغيّر من مكان تاني (المدير بعت من البوابة): مانلمسوش", async () => {
  const s = build({
    dispatch: async () => {
      // وإحنا بنحاول، البوابة حجزت الطلب بقيمة تانية
      s.row.dispatch_claimed_at = "portal-claim";
      throw err({ code: "COURIER_UNCONFIGURED" });
    },
  });
  try {
    await s.api.sweep();
    assert.equal(s.log.releases, 0, "القيمة مش بتاعتنا ⇒ ما نرجّعهاش");
    assert.equal(s.row.dispatch_claimed_at, "portal-claim");
    await s.api.sweep();
    assert.equal(s.calls.length, 1, "ومفيش إرسال تاني من الكنس");
  } finally { s.restore(); }
});
