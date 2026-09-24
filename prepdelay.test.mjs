import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchDelayOf, dispatchDelayOverride, DEFAULT_DISPATCH_DELAY_MIN } from "./delivery.js";

/* ٢٤/٩ — المدير بيمدّ المهلة مؤقتاً لما المطبخ يتضغط، وبترجع لوحدها.
   الرجوع بيتحسب وقت القراية عشان مستحيل تفضل ممدودة لأن حد نسي. */
const NOW = Date.parse("2026-09-24T20:00:00Z");
const at = (mins) => new Date(NOW + mins * 60000).toISOString();
const S = (temp, base) => ({ delivery: { ...(base !== undefined ? { dispatchDelayMin: base } : {}), ...(temp ? { dispatchDelayTemp: temp } : {}) } });

test("من غير تمديد: الرقم الأصلي", () => {
  assert.equal(dispatchDelayOf(S(null, 15), NOW), 15);
  assert.equal(dispatchDelayOf({}, NOW), DEFAULT_DISPATCH_DELAY_MIN);
});

test("تمديد شغّال بيغلب الرقم الأصلي", () => {
  const s = S({ minutes: 10, until: at(60) }, 15);
  assert.equal(dispatchDelayOf(s, NOW), 10);
  assert.equal(dispatchDelayOverride(s, NOW).minutes, 10);
});

test("عدّى وقته ⇒ رجع لوحده من غير ما حد يعمل حاجة", () => {
  const s = S({ minutes: 45, until: at(-1) }, 15);
  assert.equal(dispatchDelayOf(s, NOW), 15, "لازم يرجع ١٥");
  assert.equal(dispatchDelayOverride(s, NOW), null);
});

test("بالظبط على لحظة الانتهاء = رجع", () => {
  assert.equal(dispatchDelayOf(S({ minutes: 45, until: at(0) }, 15), NOW), 15);
});

test("تمديد من غير نهاية مرفوض — مفيش تمديد للأبد", () => {
  assert.equal(dispatchDelayOf(S({ minutes: 45 }, 15), NOW), 15);
  assert.equal(dispatchDelayOf(S({ minutes: 45, until: null }, 15), NOW), 15);
  assert.equal(dispatchDelayOf(S({ minutes: 45, until: "مش تاريخ" }, 15), NOW), 15);
});

test("قيم بايظة بترجع للأصلي مش بتوقع", () => {
  for (const bad of [{ minutes: -5, until: at(60) }, { minutes: 200, until: at(60) },
                     { minutes: "x", until: at(60) }, { minutes: null, until: at(60) },
                     "مش كائن", 5, []]) {
    assert.equal(dispatchDelayOf(S(bad, 15), NOW), 15, `${JSON.stringify(bad)}`);
  }
});

test("صفر مسموح — يعني اطلب الكابتن فوراً", () => {
  assert.equal(dispatchDelayOf(S({ minutes: 0, until: at(60) }, 15), NOW), 0);
});

test("بيحتفظ بمين عمله وليه — عشان السجل", () => {
  const t = dispatchDelayOverride(S({ minutes: 25, until: at(120), by: "محمد عادل", reason: "ضغط" }, 15), NOW);
  assert.equal(t.by, "محمد عادل");
  assert.equal(t.reason, "ضغط");
});
