import test from "node:test";
import assert from "node:assert/strict";
import { decide, watchCfg, downText, upText, WATCH_DEFAULTS, realSessionSql } from "./checkoutwatch.js";
import { smsInfo } from "./staffalerts.js";

const cfg = watchCfg(null);
const ok = { state: "ok" };
const alerting = { state: "alerting" };

test("الحدود الافتراضية هي اللي الـbacktest طلعها", () => {
  assert.equal(cfg.windowMin, 45);
  assert.equal(cfg.threshold, 5);
  assert.equal(WATCH_DEFAULTS.minTotal, 20);
});

test("العطل: ناس جاهزة للدفع ومحدش دفع ⇒ إنذار", () => {
  const d = decide({ ready: 5, payPage: 0, paid: 0 }, ok, cfg, true);
  assert.equal(d.bad, true);
  assert.equal(d.action, "alert");
  assert.equal(d.state, "alerting");
});

test("إنذار واحد للحادثة — الدورة اللي بعدها ساكتة", () => {
  const d = decide({ ready: 9, payPage: 0, paid: 0 }, alerting, cfg, true);
  assert.equal(d.action, "none");
  assert.equal(d.state, "alerting");
});

test("تحت الحد ⇒ مفيش إنذار (الهدوء العادي مش عطل)", () => {
  assert.equal(decide({ ready: 4, payPage: 0, paid: 0 }, ok, cfg, true).action, "none");
  assert.equal(decide({ ready: 0, payPage: 0, paid: 0 }, ok, cfg, true).action, "none");
});

test("طلب واحد مدفوع في النافذة بيكفي يمنع الإنذار", () => {
  assert.equal(decide({ ready: 20, payPage: 8, paid: 1 }, ok, cfg, true).action, "none");
});

test("مقفول ⇒ عمره ما يرن، والحالة بترجع مسلّحة", () => {
  const d = decide({ ready: 50, payPage: 0, paid: 0 }, ok, cfg, false);
  assert.equal(d.bad, false);
  assert.equal(d.action, "none");
  assert.equal(d.state, "ok");
  // وكنا في إنذار وقفلنا: نرجع نسلّح من غير رسالة «رجع»
  assert.equal(decide({ ready: 50, payPage: 0, paid: 0 }, alerting, cfg, false).action, "rearm");
});

test("رسالة «رجع» بتتبعت بس لما طلبات فعلاً تنزل", () => {
  // رجعت الطلبات ⇒ رسالة رجوع
  assert.equal(decide({ ready: 6, payPage: 4, paid: 2 }, alerting, cfg, true).action, "recover");
  // الدنيا هديت بس لسه صفر طلبات ⇒ نسلّح في صمت، ما نقولش «تمام» والدفع واقف
  const quiet = decide({ ready: 1, payPage: 0, paid: 0 }, alerting, cfg, true);
  assert.equal(quiet.action, "rearm");
  assert.equal(quiet.state, "ok");
});

test("الرسايل رسالة واحدة (مش أكتر من سيجمنت)", () => {
  for (const m of [{ ready: 5, payPage: 0 }, { ready: 14, payPage: 2 }, { ready: 48, payPage: 11 }]) {
    assert.equal(smsInfo(downText(m, cfg, "en")).segments, 1, `en ${m.ready}`);
    assert.equal(smsInfo(downText(m, cfg, "ar")).segments, 1, `ar ${m.ready}`);
  }
  for (const mins of [3, 137, 999]) {
    assert.equal(smsInfo(upText(mins, "en")).segments, 1);
    assert.equal(smsInfo(upText(mins, "ar")).segments, 1);
  }
});

test("الإنجليزي هو الافتراضي وبيقول الرقم والنافذة", () => {
  const t = downText({ ready: 7, payPage: 0 }, cfg, "en");
  assert.match(t, /7 customers ready to pay/);
  assert.match(t, /45min/);
  assert.match(t, /0 paid/);
});

test("الإعدادات بتتقصّ في حدود معقولة", () => {
  assert.equal(watchCfg({ checkoutWatch: { threshold: 0 } }).threshold, 2);
  assert.equal(watchCfg({ checkoutWatch: { threshold: 999 } }).threshold, 50);
  assert.equal(watchCfg({ checkoutWatch: { windowMin: 5 } }).windowMin, 15);
  assert.equal(watchCfg({ checkoutWatch: { enabled: false } }).enabled, false);
  assert.equal(watchCfg({ checkoutWatch: { threshold: "x" } }).threshold, 5); // قيمة بايظة ⇒ الافتراضي
});

test("فلتر الجلسات الحقيقية بيتبادئ صح", () => {
  assert.match(realSessionSql("s"), /COALESCE\(s\.is_bot,false\)=false/);
  assert.match(realSessionSql(), /COALESCE\(is_bot,false\)=false/);
});
