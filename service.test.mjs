import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceCfg, serviceState, serviceBlock, pausedText, SERVICE_DEFAULTS } from "./service.js";

const at = (iso) => new Date(iso);
const NOW = at("2026-09-23T12:00:00Z");

test("defaults: nothing paused when settings are empty", () => {
  const st = serviceState({}, NOW);
  assert.equal(st.delivery.open, true);
  assert.equal(st.pickup.open, true);
  assert.equal(st.anyPaused, false);
  assert.equal(st.allPaused, false);
});

test("pausing delivery leaves pickup open", () => {
  const s = { service: { delivery: { paused: true, until: null, reason: "ضغط" } } };
  const st = serviceState(s, NOW);
  assert.equal(st.delivery.paused, true);
  assert.equal(st.pickup.open, true);
  assert.equal(st.anyPaused, true);
  assert.equal(st.allPaused, false);
});

test("until in the future keeps it paused; until in the past resumes on its own", () => {
  const future = { service: { delivery: { paused: true, until: "2026-09-23T12:30:00Z" } } };
  assert.equal(serviceState(future, NOW).delivery.paused, true);

  const past = { service: { delivery: { paused: true, until: "2026-09-23T11:59:00Z" } } };
  const st = serviceState(past, NOW);
  assert.equal(st.delivery.paused, false, "a lapsed pause must not block anyone");
  assert.deepEqual(st.expired, ["delivery"]);
});

test("exactly at `until` the channel is open again (boundary)", () => {
  const s = { service: { pickup: { paused: true, until: "2026-09-23T12:00:00Z" } } };
  assert.equal(serviceState(s, NOW).pickup.paused, false);
});

test("both paused sets allPaused", () => {
  const s = { service: { delivery: { paused: true }, pickup: { paused: true } } };
  const st = serviceState(s, NOW);
  assert.equal(st.allPaused, true);
  assert.equal(st.anyPaused, true);
});

test("serviceBlock blocks only the paused channel and points at the other", () => {
  const s = { service: { delivery: { paused: true, until: "2026-09-23T12:30:00Z", reason: "المطبخ مضغوط" } } };
  const b = serviceBlock(s, "delivery", NOW);
  assert.ok(b, "delivery must be blocked");
  assert.equal(b.error, "service_paused");
  assert.equal(b.channel, "delivery");
  assert.equal(b.otherOpen, true, "pickup is still open, tell the customer");
  assert.match(b.message, /التوصيل متوقف/);
  assert.equal(serviceBlock(s, "pickup", NOW), null, "pickup must not be blocked");
});

test("serviceBlock returns null once the window lapses", () => {
  const s = { service: { delivery: { paused: true, until: "2026-09-23T11:00:00Z" } } };
  assert.equal(serviceBlock(s, "delivery", NOW), null);
});

test("the message never says the address is out of range", () => {
  const msg = pausedText("delivery", "2026-09-23T12:30:00Z", "", "ar");
  assert.ok(!/نطاق/.test(msg), "must not imply a coverage problem");
  assert.match(msg, /مؤقت/);
});

test("english message", () => {
  const msg = pausedText("pickup", null, "", "en");
  assert.match(msg, /Pickup is paused/);
});

test("serviceCfg clamps junk instead of trusting it", () => {
  const cfg = serviceCfg({ service: { delivery: { paused: "yes", until: "not-a-date", reason: 5 } } });
  assert.equal(cfg.delivery.paused, false, "only a real boolean true pauses");
  assert.equal(cfg.delivery.until, null);
  assert.equal(cfg.delivery.reason, "");
});

test("SERVICE_DEFAULTS is frozen and has both channels", () => {
  assert.ok(Object.isFrozen(SERVICE_DEFAULTS));
  assert.ok(SERVICE_DEFAULTS.delivery && SERVICE_DEFAULTS.pickup);
});

/* ── دقايق الإيقاف داخل نافذة (٢٣/٩، طلب عمر: «اعرف كل حاجة حصلت») ─────── */
import { pausedMinutesOf } from "./service.js";
const R = (a, b) => [a, b];

test("إيقاف وتشغيل جوه النافذة = الفرق بينهم", () => {
  const ev = [
    { at: "2026-09-23T17:41:00Z", action: "service_pause", channel: "delivery" },
    { at: "2026-09-23T19:07:00Z", action: "service_resume", channel: "delivery" },
  ];
  const m = pausedMinutesOf(ev, R("2026-09-23T12:00:00Z", "2026-09-23T20:00:00Z"), 24);
  assert.equal(m.delivery, 86);
  assert.equal(m.pickup, 0, "الاستلام مالوش أحداث ⇒ صفر");
});

test("«both» بيمسّ القناتين", () => {
  const ev = [
    { at: "2026-09-23T18:00:00Z", action: "service_pause", channel: "both" },
    { at: "2026-09-23T18:30:00Z", action: "service_resume", channel: "both" },
  ];
  const m = pausedMinutesOf(ev, R("2026-09-23T12:00:00Z", "2026-09-23T20:00:00Z"), 24);
  assert.deepEqual(m, { delivery: 30, pickup: 30 });
});

test("كانت واقفة قبل بداية النافذة ⇒ بنحسب من البداية بس", () => {
  const ev = [{ at: "2026-09-23T13:00:00Z", action: "service_resume", channel: "pickup" }];
  const m = pausedMinutesOf(ev, R("2026-09-23T12:30:00Z", "2026-09-23T20:00:00Z"), 24);
  assert.equal(m.pickup, 30, "نص ساعة من بداية النافذة، مش من الإيقاف الحقيقي");
});

test("لسه واقفة لحد دلوقتي ⇒ بنحسب لنهاية النافذة", () => {
  const ev = [{ at: "2026-09-23T19:00:00Z", action: "service_pause", channel: "delivery" }];
  const m = pausedMinutesOf(ev, R("2026-09-23T12:00:00Z", "2026-09-23T20:00:00Z"), 24);
  assert.equal(m.delivery, 60);
});

test("الرقم عمره ما يزيد عن طول النافذة", () => {
  const ev = [
    { at: "2026-09-20T10:00:00Z", action: "service_pause", channel: "both" },
    { at: "2026-09-25T10:00:00Z", action: "service_resume", channel: "both" },
  ];
  const m = pausedMinutesOf(ev, R("2026-09-23T12:00:00Z", "2026-09-23T14:00:00Z"), 24);
  assert.deepEqual(m, { delivery: 120, pickup: 120 });
});

test("مفيش أحداث = صفر، ونافذة بايظة برضه صفر", () => {
  assert.deepEqual(pausedMinutesOf([], R("2026-09-23T12:00:00Z", "2026-09-23T14:00:00Z"), 24),
    { delivery: 0, pickup: 0 });
  assert.deepEqual(pausedMinutesOf([{ at: "x", action: "service_pause", channel: "both" }],
    R("bad", "worse"), 24), { delivery: 0, pickup: 0 });
});

test("بدون range بنستخدم hours من دلوقتي", () => {
  const now = new Date("2026-09-23T20:00:00Z");
  const ev = [{ at: "2026-09-23T19:30:00Z", action: "service_pause", channel: "delivery" }];
  assert.equal(pausedMinutesOf(ev, null, 3, now).delivery, 30);
});
