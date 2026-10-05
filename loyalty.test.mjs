import { test } from "node:test";
import assert from "node:assert/strict";
import { loyaltyCfgOf, loyaltyCfgFromBody, loyaltySmsText, planLoyaltySms, shortDate, LOYALTY_SLUG, LOYALTY_DEFAULT } from "./loyalty.js";
import { smsParts, optoutLine } from "./smsrules.js";
import { parseRecipientSlug, recipientLink } from "./wamsg.js";

test("SMS toggle defaults ON and survives a PUT that doesn't mention it", () => {
  assert.equal(LOYALTY_DEFAULT.smsEnabled, true);
  assert.equal(loyaltyCfgOf({}).smsEnabled, true);
  assert.equal(loyaltyCfgOf({ cms: { loyalty: { enabled: true, every: 3 } } }).smsEnabled, true, "live settings (no key yet) = ON");
  assert.equal(loyaltyCfgOf({ cms: { loyalty: { smsEnabled: false } } }).smsEnabled, false);
  const prev = { enabled: true, startedAt: "2026-09-11T21:43:24.330Z", smsEnabled: false };
  assert.equal(loyaltyCfgFromBody({ enabled: true, every: 3 }, prev).smsEnabled, false, "old dashboard build keeps it");
  assert.equal(loyaltyCfgFromBody({ enabled: true, every: 3, smsEnabled: true }, prev).smsEnabled, true);
  const v = loyaltyCfgFromBody({ enabled: true, every: 3, validDays: 14, smsEnabled: false }, { ...prev, smsEnabled: true });
  assert.equal(v.smsEnabled, false);
  assert.equal(v.startedAt, prev.startedAt, "start point never resets");
  assert.equal(v.every, 3);
});

test("reward SMS: ≤2 UCS-2 parts in every opt-out mode, carries the tracked /l/loy- link", () => {
  const link = recipientLink("https://freshcuts.sa", LOYALTY_SLUG, "abc234");
  assert.equal(link, "freshcuts.sa/l/loy-abc234");
  assert.deepEqual(parseRecipientSlug("loy-abc234"), { base: "loy", code: "abc234" }, "the /l/ resolver can find the reward row");
  for (const mode of ["keyword", "link", "both"]) {
    const optout = optoutLine({ optoutMode: mode }, { code: "0123456789", host: "freshcuts.sa", sender: "FreshCut-AD" });
    for (const exp of ["2026-10-18", "2026-12-31", null]) {
      const b = loyaltySmsText({ code: "FC1A2B3C4D", expires: exp, link, optout });
      assert.ok(b, `${mode}/${exp}`);
      assert.ok(smsParts(b) <= 2, `${mode}/${exp}: ${b.length}`);
      assert.ok(b.includes(link));
      assert.ok(b.endsWith(optout), "opt-out line always last");
      assert.doesNotMatch(b, /دلوقتي|عشان|وفّر|%/);
    }
  }
  // الوضع الافتراضي (كلمة الإيقاف) بياخد الصيغة الكاملة: الكود + «تلقائياً» + التاريخ
  const full = loyaltySmsText({ code: "FC1A2B3C4D", expires: "2026-10-18", link,
    optout: optoutLine({}, { sender: "FreshCut-AD" }) });
  assert.match(full, /FC1A2B3C4D/);
  assert.match(full, /تلقائياً/);
  assert.match(full, /18\/10/);
  assert.match(full, /توصيل مجاني/);
  assert.match(loyaltySmsText({ code: "FC1", expires: null, link, optout: "", reward: "percent", percent: 15 }), /خصم 15٪/);
  assert.equal(loyaltySmsText({ code: "FC1", link: "x".repeat(200), optout: "" }), null, "nothing fits = don't send");
});

test("shortDate", () => {
  assert.equal(shortDate("2026-10-18"), "18/10");
  assert.equal(shortDate("2026-01-05T00:00:00Z"), "5/1");
  assert.equal(shortDate(null), "");
});

test("plan: one SMS per phone (soonest expiry), rest merged; exclusions are final per phone", () => {
  const rows = [
    { phone_norm: "544775082", reward_no: 4, coupon: "D", exp: "2026-10-18" },
    { phone_norm: "544775082", reward_no: 1, coupon: "A", exp: "2026-10-18" },
    { phone_norm: "548494056", reward_no: 2, coupon: "Y", exp: "2026-10-20" },
    { phone_norm: "548494056", reward_no: 1, coupon: "X", exp: "2026-10-18" },
    { phone_norm: "544677667", reward_no: 1, coupon: "B", exp: "2026-10-18" },
    { phone_norm: "562367585", reward_no: 1, coupon: "C", exp: "2026-10-18" },
    { phone_norm: "540801370", reward_no: 1, coupon: "E", exp: "2026-10-18" },
    { phone_norm: "551111111", reward_no: 1, coupon: "F", exp: "2026-10-18" },
    { phone_norm: "552222222", reward_no: 1, coupon: "G", exp: "2026-10-06" },
  ];
  const p = planLoyaltySms(rows, {
    staff: new Set(["544775082"]), optedOut: new Set(["544677667"]), adBlocked: new Set(["562367585"]),
    testSet: new Set(["551111111"]), today: "2026-10-06",
  });
  assert.deepEqual(p.send.map((r) => r.coupon).sort(), ["E", "X"]);
  assert.deepEqual(p.merged.map((r) => r.coupon), ["Y"]);
  const why = Object.fromEntries(p.skip.map((s) => [s.row.coupon, s.reason]));
  assert.deepEqual(why, { A: "staff", D: "staff", B: "opted_out", C: "ad_blocked", F: "test", G: "expiring" });
});
