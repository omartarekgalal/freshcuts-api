/* ═══════════════════════════════════════════════════════════════════════════
   🪜 حركة المحادثة بين الكاشير والمدير والملاك (ST2 — ١٢/١٠، طلب عمر بنصه):
     «عايز انظم الردود والتحويل بين الكاشير والمدير واشعارات الملاك ورقم المدير في الاشعارات برسالة واضحة. عايز كمان انظم الحركة
      بتعليمات للمدير والكاشير لما يخلص المحادثة، وبعد ما يخلصها المساعد يدخل يكمل كلام مع العميل بشكل مرتب ومنظم احترافي»

   • سلّم التصعيد: التحويل بيروح للكاشير أولاً؛ محدش استلم ولا رد خلال ladder.managerAfterMin ⇒ المدير؛ ولسه بعد ladder.ownersAfterMin
     كمان ⇒ الملاك. العاجل من الأول ⇒ الكاشير والمدير والملاك مع بعض. كل رسالة كاملة لوحدها: النوع، اسم العميل وآخر ٤ أرقام، آخر
     رسالة منه (مقنّعة)، مستني بقاله قد إيه، مين اتبلّغ قبل كده، والمطلوب — وزر «استلم المحادثة». نسخة الملاك فيها المسؤول دلوقتي ورقم المدير.
   • «حوّل للمدير»: الكاشير يحوّل بملاحظة قصيرة (بورتال أو واتساب)، المدير بياخدها بالملاحظة، والعميل بياخد سطر واحد ثابت.
   • «خلصت — اقفل» بنتيجة من قايمة قصيرة + ملاحظة اختيارية؛ محادثة الموظف رد فيها ومااتقفلتش ⇒ تذكير واحد للي ماسكها.
   • بعد القفل: المساعد بياخد ملخص اللي الموظف قاله للعميل (مقنّع) + النتيجة والملاحظة في سياق أول دور بعدها (handbackFor)،
     فيكمّل من غير ترحيب تاني ولا تكرار.
   • ورقة التعليمات (SOP) للكاشير والمدير من مسار، بالدقايق الحيّة من الإعدادات.

   الملف ده مابيبعتش حاجة بنفسه: رسايل الفريق من wateam.sendToStaff (⇒ حارس whatsapp.js، ولأرقام دليل الفريق بس)، وسطر العميل
   الوحيد (التحويل للمدير) من دالة البوت sendFlowLine (نفس أقفال البوت والنافذة). السحب والترك والقفل نفسهم دوال waowner.js.
   الجداول: wa_flow (صف لكل محادثة: خطوة السلّم، مين اتبلّغ، التحويل، آخر قفل، ملخص الموظف للمساعد) · wa_flow_pending (ملاحظة تحويل مستنية تتكتب).
   المسارات: POST /api/portal/wa/chats/:key/transfer · GET /api/portal/wa/sop · GET /api/cms/wa/threads-sop
             (take / release / done على مساراتهم الموجودة في wastaff.js و wahub.js — بينادوا الدوال اللي هنا).
═══════════════════════════════════════════════════════════════════════════ */
import { teamConfig, ACTIONS, OUTCOMES, OUTCOME_IDS, ROLE_AR, PORTAL_URL, INBOX_URL } from "./wateam.js";
import { maskText } from "./wabotllm.js";

const H = 3600_000, MIN = 60_000;
const clip = (v, n) => String(v ?? "").slice(0, n);
const last4 = (p) => `…${String(p || "").slice(-4)}`;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const ms = (v) => (v ? new Date(v).getTime() : NaN);
const MANAGERS = new Set(["manager", "owner", "operations"]);
export const STEPS = Object.freeze(["cashier", "manager", "owners"]);
const STEP_ROLE = { cashier: "cashier", manager: "manager", owners: "owner" };
const STEP_AR = { cashier: "الكاشير", manager: "المدير", owners: "الملاك" };
export const NOTE_MAX = 300;
export const LADDER_MAX_AGE_MIN = 120;       // تحويل أقدم من كده مايتصعّدش (سيرفر رجع بعد وقفة)
export const PENDING_NOTE_MIN = 10;          // ملاحظة التحويل على واتساب: الرسالة الجاية من الكاشير خلال الدقايق دي
export const TRANSFER_CUSTOMER_KEY = "transfer_note";
const outcomeOf = (id) => OUTCOMES.find((o) => o.id === id) || null;

/* ── حالة المحادثة والفعل الأساسي الواحد (صافي) ───────────────────────────────
   owner = ناتج waowner.ownerOf · row = صف wa_flow أو null · me = { role } */
/* meta = { lastInAt, unanswered } من صف المحادثة (آخر رسالة من العميل ومحدش رد عليها) — لحساب waitingSince */
export function flowOf(owner, row, me, meta = null) {
  const o = owner || { state: "bot" }, r = row || {};
  const manager = Boolean(me && MANAGERS.has(String(me.role))), cashier = Boolean(me && String(me.role) === "cashier");
  const realHold = o.state === "held" && !(o.by && o.by.via === "mute");
  const tr = r.transfer && typeof r.transfer === "object" ? r.transfer : null;
  const state = tr && !realHold && o.state !== "closed" ? "transferred" : (o.state || "bot");
  let primary = null; const actions = [];
  if (state === "bot" || state === "closed") actions.push("take");
  else if (state === "waiting_staff") { primary = "take"; actions.push("take"); }
  else if (state === "transferred") { if (manager) { primary = "take"; actions.push("take"); } }
  else if (state === "held") {
    if (o.mine) { primary = "done"; actions.push("done", "release"); if (cashier) actions.push("transfer"); }
    else if (manager) { primary = "take"; actions.push("take"); }
  }
  const open = state === "waiting_staff" && r.ho_at && o.since && Math.abs(ms(r.ho_at) - ms(o.since)) < 2000;
  const lc = r.last_close && typeof r.last_close === "object" ? r.last_close : null;
  /* من إمتى حد مستني: وقت التحويل المفتوح، أو وقت التحويل للمدير، أو آخر رسالة من العميل لو محدش رد عليها — في أي حالة. null = محدش مستني. */
  const pend = meta && meta.unanswered === true && meta.lastInAt ? iso(meta.lastInAt) : null;
  const waitingSince = state === "waiting_staff" ? iso(o.since) || pend : state === "transferred" ? iso(tr.at) || pend : pend;
  return { state, primary, actions, waitingSince, step: open ? r.step || null : null,
    kind: o.reason || (open ? r.reason : null) || null, kindAr: (open && r.reason_ar) || (o.reason && r.reason === o.reason ? r.reason_ar : null) || o.reason || null,
    urgent: open ? r.urgent === true : false, waitedMin: o.waitedMin ?? null, alerted: open && Array.isArray(r.alerted) ? r.alerted : [],
    transfer: state === "transferred" || (realHold && tr) ? tr : null,
    lastClose: lc ? { outcome: lc.outcome, outcomeAr: (outcomeOf(lc.outcome) || {}).label || lc.outcome, note: lc.note || null, by: lc.by || null, at: lc.at || null } : null };
}

/* ── السلّم (صافي): الخطوة الجاية أو null ─────────────────────────────────── */
export function nextStep({ step, hoAt, now, ladder }) {
  const waited = (new Date(now).getTime() - ms(hoAt)) / MIN;
  if (!ladder || !ladder.enabled || !Number.isFinite(waited) || waited > LADDER_MAX_AGE_MIN) return null;
  if (step === "cashier" && waited >= ladder.managerAfterMin) return "manager";
  if (step === "manager" && waited >= ladder.managerAfterMin + ladder.ownersAfterMin) return "owners";
  return null;
}
/* خطوات أول تبليغ: العادي ⇒ الكاشير. العاجل ⇒ التلاتة مع بعض. خطوة مافيهاش حد في الدليل بتتخطّى للي بعدها. */
export function firstSteps(cfg, urgent) {
  const has = (s) => cfg.members.some((m) => m.active && m.role === STEP_ROLE[s]);
  if (urgent) return STEPS.filter(has);
  const s = STEPS.find(has);
  return s ? [s] : [];
}

/* ── نصوص رسايل الفريق (مصري) ─────────────────────────────────────────────── */
const waitAr = (m) => (m == null ? null : m < 1 ? "لسه دلوقتي" : m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? `${m} دقايق` : `${m} دقيقة`);
export function ladderText({ step, to, kindAr, urgent = false, name = null, phone, orderNo = null, lastText = null, waitedMin = null, alerted = [], stage = "new", manager = null }) {
  const head = stage === "reminder" ? "🔔 تذكير: العميل لسه مستني" : stage === "reopened" ? "♻️ التحويل اتقفل من غير رد للعميل" : step === "manager" && !urgent ? "⬆️ تصعيد للمدير: محدش رد على العميل" : step === "owners" && !urgent ? "⬆️ تصعيد للملاك: العميل لسه من غير رد" : urgent ? "🚨 تحويل عاجل لموظف" : "💬 تحويل لموظف";
  const who = `${name ? `${clip(name, 30)} ` : ""}${last4(phone)}`;
  const before = alerted.filter((a) => a && a.role).map((a) => STEP_AR[a.role] || a.role);
  const lines = [`${head} — ${kindAr || "تحويل"}`, `العميل: ${who}${orderNo ? ` · طلب ${orderNo}` : ""}`];
  if (lastText) lines.push(`آخر رسالة منه: «${clip(lastText, 200)}»`);
  if (waitedMin != null) lines.push(`مستني: ${waitAr(waitedMin)}`);
  if (before.length) lines.push(`اتبلّغ قبل كده: ${[...new Set(before)].join("، ")}`);
  if (to === "owner") {
    const resp = step === "owners" || urgent ? (manager ? `المدير ${manager.name || ""}`.trim() : "الكاشير") : STEP_AR[step] || "الكاشير";
    lines.push(`المسؤول دلوقتي: ${resp}`);
    if (manager) lines.push(`رقم المدير: 0${manager.phone}`);
    lines.push(`المطلوب: تابع مع المدير، أو اضغط «${ACTIONS.take}» لو هترد بنفسك.`);
  } else lines.push(`المطلوب: اضغط «${ACTIONS.take}» ورد على العميل من البورتال، ولما تخلص «${ACTIONS.done}».`);
  lines.push(`رد من البورتال ↗ ${PORTAL_URL}`);
  return lines.join("\n").slice(0, 1000);
}
export function transferText({ by, note, name = null, phone, lastText = null }) {
  return [`↪️ ${ACTIONS.transfer} — من ${by || "الكاشير"}`, `العميل: ${name ? `${clip(name, 30)} ` : ""}${last4(phone)}`, `ملاحظة الكاشير: «${clip(note, NOTE_MAX)}»`,
    lastText ? `آخر رسالة منه: «${clip(lastText, 200)}»` : null, `العميل اتقال له إن المدير هيكمّل معاه.`, `المطلوب: اضغط «${ACTIONS.take}» ورد عليه من البورتال، ولما تخلص «${ACTIONS.done}».`,
    `رد من البورتال ↗ ${PORTAL_URL}`].filter(Boolean).join("\n").slice(0, 1000);
}
export const tookText = ({ phone, name = null }) => `✅ المحادثة معاك — ${name ? `${clip(name, 30)} ` : ""}${last4(phone)}\nرد على العميل من البورتال ↗ ${PORTAL_URL}\nلما تخلص اضغط «${ACTIONS.done}».`;
export const closeAskText = ({ phone }) => `نتيجة محادثة ${last4(phone)} إيه؟ اختار من القايمة عشان تتقفل.`;
export const closedText = ({ phone, outcome }) => `✅ اتقفلت محادثة ${last4(phone)} — ${(outcomeOf(outcome) || {}).label || outcome}.${outcome === "follow_up" ? "\nاكتب المطلوب في ملاحظة القفل من البورتال لو لسه ماكتبتوش." : ""}`;
export const releasedText = ({ phone }) => `↩️ محادثة ${last4(phone)} رجعت للبوت.`;
export const noteAskText = ({ phone }) => `اكتب ملاحظة قصيرة للمدير عن محادثة ${last4(phone)} في رسالة واحدة (إيه المطلوب منه؟).`;
export const transferredText = ({ phone }) => `↪️ محادثة ${last4(phone)} اتحوّلت للمدير بملاحظتك.`;
export const closeReminderText = ({ phone, name = null, waitedMin }) => `⏳ محادثة ${name ? `${clip(name, 30)} ` : ""}${last4(phone)} اترد عليها من ${waitAr(waitedMin)} ولسه مفتوحة.\nلو خلصت اضغط «${ACTIONS.done}» واختار النتيجة، ولو لسه كمّل مع العميل.`;
const FAIL_AR = { held_by_other: "المحادثة ماسكها حد تاني", not_yours: "المحادثة ماسكها حد تاني — المدير بس يقدر يقفلها", not_found: "المحادثة مش موجودة", cashier_only: `«${ACTIONS.transfer}» للكاشير بس`, no_manager: "مفيش مدير في دليل الفريق",
  transfer_off: "التحويل للمدير مقفول من الإعدادات", unavailable: "الخدمة مش متاحة دلوقتي — جرّب من البورتال", gone: "المحادثة دي اتقفلت أو اتغيّرت — افتح البورتال" };

/* ── ورقة التعليمات (SOP) ─────────────────────────────────────────────────── */
export function sopFor(role, cfg) {
  const L = cfg.ladder, C = cfg.close;
  const cashier = { title: "الكاشير — لما ييجي تحويل من واتساب", steps: [
    `هيوصلك تنبيه على واتساب والبورتال فيه نوع الطلب واسم العميل وآخر رسالة. اضغط «${ACTIONS.take}» فوراً — من غيرها محدش عارف إنك ماسكها.`,
    "رد على العميل من البورتال (صندوق واتساب) بكلام واضح ومهذب. طول ما المحادثة معاك البوت ساكت.",
    `طلب أو سؤال عن المنيو والتوصيل والعروض: جاوب وساعده يكمّل طلبه من الرابط.`,
    `شكوى، مشكلة دفع، استرجاع، تعديل أو إلغاء طلب مدفوع، حساسية شديدة، أو أي حاجة مش من صلاحيتك: اضغط «${ACTIONS.transfer}» واكتب ملاحظة قصيرة (إيه المشكلة وإيه المطلوب). العميل بيتقال له إن المدير هيكمّل.`,
    `لو فتحتها بالغلط أو العميل رجع يسأل عن المنيو بس: «${ACTIONS.release}».`,
    `لما تخلص: «${ACTIONS.done}» واختار النتيجة. من غير القفل المحادثة بتفضل محسوبة عليك${C.remindAfterMin ? ` وهيجيلك تذكير بعد ${C.remindAfterMin} دقيقة` : ""}.`,
    `لو مااستلمتش خلال ${L.managerAfterMin} دقايق التنبيه بيطلع للمدير، وبعدها بـ${L.ownersAfterMin} دقايق للملاك.`,
    "ممنوع: وعد بوقت توصيل أو استرجاع أو تعويض من غير المدير، وأي كلام عن الوصفات أو المقادير أو المورّدين.",
  ] };
  const manager = { title: "المدير — التصعيد والتحويلات", steps: [
    `بيوصلك: أي تحويل عاجل من أول لحظة (شكوى، دفع، إلغاء، حساسية)، أي تحويل الكاشير مااستلموش خلال ${L.managerAfterMin} دقايق، وأي محادثة الكاشير ضغط فيها «${ACTIONS.transfer}» بملاحظته.`,
    `اضغط «${ACTIONS.take}» (تقدر تاخد محادثة ماسكها كاشير) ورد من البورتال. اقرا ملاحظة الكاشير الأول.`,
    "الشكوى: اعتذر، اسأل عن رقم الطلب، وقول هتعمل إيه بالظبط. أي استرجاع أو تعويض قرارك إنت.",
    `لو مارديتش خلال ${L.ownersAfterMin} دقايق من تصعيدها ليك التنبيه بيروح للملاك ومعاه رقمك.`,
    `لما تخلص: «${ACTIONS.done}» بالنتيجة الصح. «محتاج متابعة» = لسه فيه حاجة للعميل: اكتبها في الملاحظة عشان المساعد يكمّل عليها.`,
    "رقم مش عميل (مورّد، طالب شغل): اقفلها «مش عميل»، ولو بيكرر علّمه «البوت مايردش عليه».",
  ] };
  const closing = { title: `القفل — «${ACTIONS.done}»`, steps: OUTCOMES.map((o) => `${o.label}: ${o.hint}.`).concat([
    "بعد القفل المساعد بيرجع يرد على العميل، وهو عارف إنت قلت له إيه — فمش هيرحّب تاني ولا يكرر كلامك.",
  ]) };
  const order = role === "manager" ? [manager, cashier, closing] : [cashier, manager, closing];
  return { role: role === "manager" ? "manager" : "cashier", updated: "2026-10-12",
    actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })), outcomes: OUTCOMES.map((o) => ({ id: o.id, label: o.label, hint: o.hint })),
    ladder: { managerAfterMin: L.managerAfterMin, ownersAfterMin: L.ownersAfterMin, closeRemindMin: C.remindAfterMin }, sections: order };
}

const DDL = `
  CREATE TABLE IF NOT EXISTS wa_flow (
    fid BIGSERIAL UNIQUE, phone_norm TEXT PRIMARY KEY, ho_at TIMESTAMPTZ, reason TEXT, reason_ar TEXT, urgent BOOLEAN NOT NULL DEFAULT FALSE, order_no TEXT,
    step TEXT, alerted JSONB NOT NULL DEFAULT '[]'::jsonb, transfer JSONB, last_close JSONB, handback JSONB, close_reminded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS wa_flow_pending (staff_phone TEXT PRIMARY KEY, phone_norm TEXT NOT NULL, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData } = ctx;
  const log = deps.log || console;
  const clock = deps.now || (() => new Date());
  const lazy = (k) => () => { try { return (typeof deps[k] === "function" ? deps[k]() : deps[k]) || null; } catch { return null; } };
  const team = lazy("team"), staff = lazy("staff"), bot = lazy("bot"), hub = lazy("hub");
  const q = async (sql, p = []) => { try { return (await pool.query(sql, p)).rows || []; } catch (e) { log.error("[wa-flow] db:", e.message); return null; } };
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-flow] schema:", e.message); return false; });
  const cfgNow = async () => { try { return teamConfig((await getSettingsData()) || {}); } catch { return teamConfig({}); } };
  const owner = () => (staff() && staff().owner) || null;
  const jb = (x) => JSON.stringify(x);
  const say = (event, data) => { try { deps.broadcast?.(event, data); } catch (e) { log.error("[wa-flow] broadcast:", e.message); } };
  const keyOf = (pn) => { try { return hub() && hub().keyOf ? hub().keyOf(pn) : null; } catch { return null; } };

  const rowOf = async (pn) => { const r = await q("SELECT * FROM wa_flow WHERE phone_norm=$1", [pn]); return r && r[0] ? r[0] : null; };
  const rowByFid = async (fid) => { const r = await q("SELECT * FROM wa_flow WHERE fid=$1", [Number(fid)]); return r && r[0] ? r[0] : null; };
  const nameOf = async (pn) => { const r = await q("SELECT COALESCE(full_name, profile_name) AS name FROM wa_contact_names WHERE phone_norm=$1 AND NOT removed", [pn]); const n = r && r[0] && r[0].name ? String(r[0].name).trim().split(/\s+/)[0] : ""; return n || null; };
  const managerOf = (cfg) => cfg.members.find((m) => m.active && m.role === "manager") || null;
  const membersOf = (cfg, step) => cfg.members.filter((m) => m.active && m.role === STEP_ROLE[step]);

  /* flow لكل صف من صفوف القايمة / للمحادثة */
  async function flowsFor(phones, owners, me, metas = null) {
    const out = new Map();
    try {
      await ready;
      const list = [...new Set((phones || []).filter(Boolean))];
      const r = list.length ? await q("SELECT * FROM wa_flow WHERE phone_norm = ANY($1::text[])", [list]) : [];
      const by = new Map((r || []).map((x) => [x.phone_norm, x]));
      for (const pn of list) out.set(pn, flowOf(owners && owners.get ? owners.get(pn) : null, by.get(pn) || null, me, metas && metas.get ? metas.get(pn) || null : null));
    } catch (e) { log.error("[wa-flow] flows:", e.message); }
    return out;
  }
  async function flowFor(pn, me, ownerObj = undefined, meta = null) {
    const o = ownerObj !== undefined ? ownerObj : (owner() ? await owner().ownerFor(pn, me).catch(() => null) : null);
    return flowOf(o, await rowOf(pn), me, meta);
  }
  /* محادثات محوّلة للمدير ولسه محدش استلمها (للعدّاد) */
  async function transferredCount() {
    const r = await q("SELECT count(*)::int AS n FROM wa_flow f WHERE f.transfer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wa_chat_holds h WHERE h.phone_norm = f.phone_norm AND h.state = 'held')", []);
    return r && r[0] ? Number(r[0].n) || 0 : 0;
  }

  /* ── ١) السلّم ─────────────────────────────────────────────────────────── */
  async function alertStep(cfg, row, step, { stage = "new", sms = null, waitedMin = null } = {}) {
    const t = team(); if (!t) return { sent: 0, wa: 0, sms: 0, failed: 0, to: 0 };
    const to = membersOf(cfg, step);
    if (!to.length) return { sent: 0, wa: 0, sms: 0, failed: 0, to: 0 };
    const pn = row.phone_norm, name = await nameOf(pn), lastText = await t.lastCustomerText(pn), manager = managerOf(cfg);
    const waited = waitedMin != null ? waitedMin : Math.max(0, Math.floor((clock().getTime() - ms(row.ho_at)) / MIN));
    const alerted = Array.isArray(row.alerted) ? row.alerted : [];
    const summary = clip(`${name ? `${name} ` : "عميل "}${last4(pn)} محتاج موظف (${row.reason_ar || row.reason})${step !== "cashier" && !row.urgent ? " — تصعيد" : ""}`, 120);
    return t.fanOut(cfg, to, (m) => ({ topic: row.urgent ? "urgent" : "handover", kind: row.reason, urgent: row.urgent === true, ref4: pn.slice(-4),
      body: ladderText({ step, to: m.role, kindAr: row.reason_ar || row.reason, urgent: row.urgent === true, name, phone: pn, orderNo: row.order_no, lastText, waitedMin: waited, alerted: alerted.filter((a) => a.role !== step), stage, manager }),
      buttons: [{ id: `flow:take:${row.fid}`, title: ACTIONS.take }],
      templates: [{ name: "fc_staff_team_notice", data: { notice: { text: summary } } }, { name: "fc_staff_wa_handoff", data: { handoff: { reasonText: row.reason_ar || row.reason, summary: `عميل ${last4(pn)}${row.order_no ? ` طلب ${row.order_no}` : ""}` } } }],
      sms: cfg.smsFallback ? sms : null, smsRef: `wabot ${row.reason}` }));
  }
  const sum = (a, b) => ({ sent: a.sent + b.sent, wa: a.wa + b.wa, sms: a.sms + b.sms, failed: a.failed + b.failed, to: a.to + b.to });
  /* من wateam.handover لما السلّم شغّال. ⇒ null لو مفيش ولا مستلم (المنادي يكمل بالـSMS القديم). */
  async function onHandover({ cfg, phone, reason, reasonAr = null, urgent = false, orderNo = null, stage = "new", waitedMin = null, sms = null }) {
    await ready;
    const now = clock();
    let row = await rowOf(phone);
    if (stage === "new" || !row || !row.step) {
      const steps = firstSteps(cfg, urgent);
      if (!steps.length) return null;
      const ho = await q("SELECT handoff_at FROM wa_bot_chats WHERE phone_norm=$1", [phone]);
      const hoAt = ho && ho[0] && ho[0].handoff_at ? iso(ho[0].handoff_at) : now.toISOString();
      const alerted = steps.map((s) => ({ role: s, at: now.toISOString() }));
      const up = await q(`INSERT INTO wa_flow(phone_norm, ho_at, reason, reason_ar, urgent, order_no, step, alerted, transfer, close_reminded_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NULL,NULL,NOW())
                          ON CONFLICT (phone_norm) DO UPDATE SET ho_at=$2, reason=$3, reason_ar=$4, urgent=$5, order_no=$6, step=$7, alerted=$8::jsonb, transfer=NULL, close_reminded_at=NULL, updated_at=NOW() RETURNING *`,
        [phone, hoAt, clip(reason, 40), reasonAr ? clip(reasonAr, 80) : null, urgent === true, orderNo ? clip(orderNo, 30) : null, steps[steps.length - 1], jb(alerted)]);
      if (!up || !up[0]) return null;
      row = { ...up[0], alerted: [] };      // أول تبليغ: محدش اتبلّغ قبل كده
      let out = { sent: 0, wa: 0, sms: 0, failed: 0, to: 0 };
      for (const s of steps) out = sum(out, await alertStep(cfg, row, s, { stage: stage === "new" ? "new" : stage, sms, waitedMin: stage === "new" ? 0 : waitedMin }));
      return out;
    }
    /* تذكير / اتفتح تاني: لنفس اللي اتبلّغوا لحد دلوقتي */
    const roles = [...new Set((Array.isArray(row.alerted) ? row.alerted : []).map((a) => a.role).filter((s) => STEPS.includes(s)))];
    let out = { sent: 0, wa: 0, sms: 0, failed: 0, to: 0 };
    for (const s of roles.length ? roles : firstSteps(cfg, urgent)) out = sum(out, await alertStep(cfg, { ...row, alerted: (row.alerted || []).filter((a) => a.role !== s) }, s, { stage, sms, waitedMin }));
    return out.to ? out : null;
  }
  /* التحويل ده لسه مفتوح ومحدش استلمه ولا رد؟ */
  async function stillWaiting(row) {
    const r = await q(`SELECT b.handoff_at, b.muted_until,
        (SELECT 1 FROM wa_messages m WHERE m.phone_norm=$1 AND m.source='echo' AND COALESCE(m.echo_kind,'staff') <> 'auto' AND m.created_at > $2 LIMIT 1) AS answered,
        (SELECT 1 FROM wa_handovers h WHERE h.phone_norm=$1 AND h.at >= $2 AND h.acked_at IS NOT NULL LIMIT 1) AS acked
      FROM wa_bot_chats b WHERE b.phone_norm=$1`, [row.phone_norm, iso(row.ho_at)]);
    if (r === null || !r[0]) return false;
    const x = r[0];
    if (!x.handoff_at || Math.abs(ms(x.handoff_at) - ms(row.ho_at)) > 2000) return false;      // التحويل اتقفل أو اتغيّر
    if (ms(x.muted_until) > clock().getTime()) return false;                                   // حد استلمها
    return !x.answered && !x.acked;
  }
  async function climb(cfg, now) {
    let n = 0;
    if (!cfg.ladder.enabled) return n;
    const rows = await q("SELECT * FROM wa_flow WHERE step IN ('cashier','manager') AND ho_at > $1 ORDER BY ho_at LIMIT 30", [new Date(now.getTime() - LADDER_MAX_AGE_MIN * MIN).toISOString()]);
    for (const row of rows || []) {
      let next = nextStep({ step: row.step, hoAt: row.ho_at, now, ladder: cfg.ladder });
      if (!next) continue;
      if (!(await stillWaiting(row))) { await q("UPDATE wa_flow SET step=NULL, updated_at=NOW() WHERE phone_norm=$1 AND step=$2", [row.phone_norm, row.step]); continue; }
      if (next === "manager" && !membersOf(cfg, "manager").length) next = "owners";      // مفيش مدير في الدليل ⇒ للملاك على طول
      const alerted = [...(Array.isArray(row.alerted) ? row.alerted : []), { role: next, at: now.toISOString() }];
      /* الحجز قبل الإرسال: نسخة واحدة بس بتصعّد، وسيرفر وقع في النص مايبعتش مرتين */
      const claim = await q("UPDATE wa_flow SET step=$3, alerted=$4::jsonb, updated_at=NOW() WHERE phone_norm=$1 AND step=$2 RETURNING fid", [row.phone_norm, row.step, next, jb(alerted)]);
      if (!claim || !claim.length) continue;
      await alertStep(cfg, row, next, { stage: "new" });
      say("wa_handover", { phone: `0${row.phone_norm}`, phoneMasked: last4(row.phone_norm), reason: row.reason, reasonAr: row.reason_ar || row.reason, urgent: row.urgent === true, orderNo: row.order_no || null, at: iso(row.ho_at),
        step: next, escalated: true, waitedMin: Math.floor((now.getTime() - ms(row.ho_at)) / MIN), reminder: true });
      n++;
    }
    return n;
  }

  /* ── ٣) القفل بنتيجة + تذكير القفل ─────────────────────────────────────── */
  const staffSaid = async (pn, since) => { const r = await q(`SELECT body FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND COALESCE(echo_kind,'staff') <> 'auto' AND created_at > $2 ORDER BY id LIMIT 12`, [pn, since]);
    return (r || []).map((x) => clip(maskText(x.body), 200)).filter(Boolean); };
  async function close(pn, me, { outcome = null, note = null } = {}) {
    await ready;
    const cfg = await cfgNow(), own = owner();
    if (!own) return { ok: false, error: "unavailable", status: 503 };
    let oc = OUTCOME_IDS.includes(String(outcome)) ? String(outcome) : null;
    if (!oc && !cfg.close.requireOutcome && (outcome == null || outcome === "")) oc = "answered";
    if (!oc) return { ok: false, error: "outcome_required", status: 400, message: "اختار نتيجة المحادثة", outcomes: OUTCOMES.map((o) => ({ id: o.id, label: o.label })) };
    const nt = String(note ?? "").trim();
    if (nt.length > NOTE_MAX) return { ok: false, error: "note_too_long", status: 400, message: `الملاحظة لحد ${NOTE_MAX} حرف` };
    const before = await rowOf(pn);
    const hold = await q("SELECT since FROM wa_chat_holds WHERE phone_norm=$1 AND state='held'", [pn]);
    const since = iso((hold && hold[0] && hold[0].since) || (before && before.ho_at) || new Date(clock().getTime() - 2 * H));
    const said = await staffSaid(pn, since);
    const r = await own.done(pn, me);
    if (!r.ok) return r;
    const now = clock().toISOString(), by = clip((me && (me.name || me.role)) || "", 60);
    const lc = { outcome: oc, note: nt || null, by, role: (me && me.role) || null, at: now };
    const hb = { outcome: oc, note: nt ? clip(maskText(nt), NOTE_MAX) : null, staffSaid: said, at: now };
    await q(`INSERT INTO wa_flow(phone_norm, step, transfer, last_close, handback, updated_at) VALUES ($1,NULL,NULL,$2::jsonb,$3::jsonb,NOW())
             ON CONFLICT (phone_norm) DO UPDATE SET step=NULL, transfer=NULL, last_close=$2::jsonb, handback=$3::jsonb, updated_at=NOW()`, [pn, jb(lc), jb(hb)]);
    try { await hub()?.markHandled?.(pn); } catch { /* */ }
    const ack = await q("UPDATE wa_handovers SET acked_at=NOW(), acked_by=$2 WHERE phone_norm=$1 AND acked_at IS NULL RETURNING id", [pn, by || "closed"]);
    for (const a of ack || []) say("wa_handover_ack", { id: Number(a.id), by });
    const flow = flowOf(r.owner, await rowOf(pn), me);
    say("wa_chat_owner", { key: keyOf(pn), owner: { ...r.owner, mine: undefined }, flow: { ...flow, primary: undefined, actions: undefined } });
    /* مفيش رسالة بتطلع للعميل من القفل نفسه: المساعد بيكمّل على أول رسالة من العميل بعدها، ومعاه الملخص (handbackFor) — و«محتاج متابعة» بتتعلّم still_to_do. */
    return { ok: true, owner: r.owner, flow };
  }
  async function take(pn, me, opts = {}) {
    const own = owner(); if (!own) return { ok: false, error: "unavailable", status: 503 };
    /* محادثة محوّلة للمدير: الكتم بتاع التحويل مش «حد تاني ماسكها» — المدير يستلمها من غير force */
    if (!opts.force && me && MANAGERS.has(String(me.role))) { const row = await rowOf(pn); if (row && row.transfer) opts = { ...opts, force: true }; }
    const r = await own.take(pn, me, opts);
    if (!r.ok) return r;
    await q("UPDATE wa_flow SET step=NULL, close_reminded_at=NULL, updated_at=NOW() WHERE phone_norm=$1", [pn]);
    return { ...r, flow: flowOf(r.owner, await rowOf(pn), me) };
  }
  async function release(pn, me) {
    const own = owner(); if (!own) return { ok: false, error: "unavailable", status: 503 };
    const r = await own.release(pn, me);
    if (!r.ok) return r;
    await q("UPDATE wa_flow SET step=NULL, transfer=NULL, updated_at=NOW() WHERE phone_norm=$1", [pn]);
    return { ...r, flow: flowOf(r.owner, await rowOf(pn), me) };
  }
  /* الموظف رد ومااتقفلتش: تذكير واحد للي ماسكها */
  async function closeReminders(cfg, now) {
    let n = 0;
    if (!(cfg.close.remindAfterMin > 0)) return n;
    const rows = await q(`SELECT h.phone_norm, h.by_id, h.by_name, h.role, h.since, t.last_in_at, f.close_reminded_at,
        (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = h.phone_norm AND m.source='echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') AS last_echo_at
      FROM wa_chat_holds h LEFT JOIN wa_threads t ON t.phone_norm = h.phone_norm LEFT JOIN wa_flow f ON f.phone_norm = h.phone_norm WHERE h.state='held' LIMIT 50`, []);
    const t = team();
    for (const r of rows || []) {
      const echo = ms(r.last_echo_at), since = ms(r.since);
      if (!(echo > since) || ms(r.last_in_at) > echo) continue;                                     // لسه مارديتش، أو العميل كتب بعد ردك
      const waited = Math.floor((now.getTime() - echo) / MIN);
      if (waited < cfg.close.remindAfterMin || ms(r.close_reminded_at) >= since) continue;
      const claim = await q(`INSERT INTO wa_flow(phone_norm, close_reminded_at, updated_at) VALUES ($1,$2,NOW())
                             ON CONFLICT (phone_norm) DO UPDATE SET close_reminded_at=$2, updated_at=NOW() WHERE wa_flow.close_reminded_at IS NULL OR wa_flow.close_reminded_at < $3 RETURNING fid`, [r.phone_norm, now.toISOString(), iso(r.since)]);
      if (!claim || !claim.length) continue;
      say("wa_chat_close_reminder", { key: keyOf(r.phone_norm), holder: r.by_name || null, waitedMin: waited });
      if (t) {
        const wa = /^wa:(5\d{8})$/.exec(String(r.by_id || ""));
        const to = wa ? cfg.members.filter((m) => m.active && m.phone === wa[1]) : cfg.members.filter((m) => m.active && m.role === r.role);
        const body = closeReminderText({ phone: r.phone_norm, name: await nameOf(r.phone_norm), waitedMin: waited });
        if (to.length) await t.fanOut(cfg, to, () => ({ topic: "close", kind: "close_reminder", body, ref4: r.phone_norm.slice(-4), buttons: [{ id: `flow:done:${claim[0].fid}`, title: ACTIONS.done }], templates: [], sms: null }));
      }
      n++;
    }
    return n;
  }

  /* ── ٢) حوّل للمدير ────────────────────────────────────────────────────── */
  async function transfer(pn, me, { note = null } = {}) {
    await ready;
    const cfg = await cfgNow(), own = owner(), b = bot(), t = team();
    if (!cfg.transfer.enabled) return { ok: false, error: "transfer_off", status: 409, message: FAIL_AR.transfer_off };
    if (!me || String(me.role) !== "cashier") return { ok: false, error: "cashier_only", status: 403, message: FAIL_AR.cashier_only };
    const nt = String(note ?? "").trim();
    if (!nt) return { ok: false, error: "note_required", status: 400, message: "اكتب ملاحظة قصيرة للمدير" };
    if (nt.length > NOTE_MAX) return { ok: false, error: "note_too_long", status: 400, message: `الملاحظة لحد ${NOTE_MAX} حرف` };
    const manager = managerOf(cfg);
    if (!manager) return { ok: false, error: "no_manager", status: 409, message: FAIL_AR.no_manager };
    if (!own || !b || typeof b.holdChat !== "function") return { ok: false, error: "unavailable", status: 503 };
    const cur = await own.ownerFor(pn, me);
    if (!cur) return { ok: false, error: "not_found", status: 404 };
    if (cur.state === "held" && !cur.mine && !(cur.by && cur.by.via === "mute")) return { ok: false, error: "held_by_other", status: 409, owner: cur, message: FAIL_AR.held_by_other };
    const now = clock().toISOString(), by = clip(me.name || "الكاشير", 60);
    const tr = { by, at: now, note: nt };
    /* المحادثة تفضل ساكتة للبوت (نفس مهلة «استلم») لحد ما المدير يستلم؛ صف السحب بتاع الكاشير بيتشال */
    await b.holdChat(pn, await own.minutes(), "transfer");
    await q("DELETE FROM wa_chat_holds WHERE phone_norm=$1", [pn]);
    const up = await q(`INSERT INTO wa_flow(phone_norm, transfer, step, close_reminded_at, updated_at) VALUES ($1,$2::jsonb,NULL,NULL,NOW())
                        ON CONFLICT (phone_norm) DO UPDATE SET transfer=$2::jsonb, step=NULL, close_reminded_at=NULL, updated_at=NOW() RETURNING *`, [pn, jb(tr)]);
    const row = up && up[0] ? up[0] : null;
    let alert = null;
    if (t && row) {
      const body = transferText({ by, note: clip(maskText(nt), NOTE_MAX), name: await nameOf(pn), phone: pn, lastText: await t.lastCustomerText(pn) });
      alert = await t.fanOut(cfg, [manager], () => ({ topic: "transfer", kind: "transfer", body, ref4: pn.slice(-4), buttons: [{ id: `flow:take:${row.fid}`, title: ACTIONS.take }],
        templates: [{ name: "fc_staff_team_notice", data: { notice: { text: clip(`${by} حوّل لك محادثة عميل ${last4(pn)}`, 120) } } }],
        sms: cfg.smsFallback ? `Fresh Cuts WhatsApp: a cashier transferred a customer chat (${last4(pn).slice(1)}) to you. Open the portal.` : null, smsRef: "wabot transfer" }));
    }
    say("wa_chat_transfer", { key: keyOf(pn), by, note: nt, at: now });
    /* سطر واحد للعميل إن المدير هيكمّل — من دالة البوت (أقفاله والنافذة وأرقام التجربة). الفشل مايلغيش التحويل. */
    let customer = null;
    try { customer = typeof b.sendFlowLine === "function" ? await b.sendFlowLine(pn, TRANSFER_CUSTOMER_KEY) : "unavailable"; } catch (e) { log.error("[wa-flow] customer line:", e.message); customer = "failed"; }
    const o2 = await own.ownerFor(pn, me), flow = flowOf(o2, row, me);
    say("wa_chat_owner", { key: keyOf(pn), owner: { ...o2, mine: undefined }, flow: { ...flow, primary: undefined, actions: undefined } });
    return { ok: true, owner: o2, flow, alert, customerLine: customer };
  }

  /* ── أزرار وكلام الموظف على واتساب (من wateam.inbound) ⇒ true لو اتمسكت هنا ── */
  const meOfMember = (m) => ({ id: `wa:${m.phone}`, name: m.name || last4(m.phone), role: m.role, via: "whatsapp" });
  async function staffInbound(ev, m, cfg) {
    await ready;
    const t = team(); if (!t) return false;
    const reply = (body, buttons = null, list = null) => t.sendToStaff(cfg, m, { topic: "flow", kind: "flow_reply", body, button: false, buttons, list, templates: [], sms: null });
    const id = /^flow:(take|rel|done|xfer|out):(\d+)(?::([a-z_]+))?$/.exec(String(ev.interactiveId || ""));
    const me = meOfMember(m);
    if (!id) {
      /* ملاحظة تحويل مستنية من الكاشير ده: رسالته النصية الجاية هي الملاحظة */
      if (ev.interactiveId || String(ev.type || "text") !== "text" || !String(ev.text || "").trim()) return false;
      const pd = await q("DELETE FROM wa_flow_pending WHERE staff_phone=$1 RETURNING phone_norm, kind, at", [m.phone]);
      if (!pd || !pd[0] || clock().getTime() - ms(pd[0].at) > PENDING_NOTE_MIN * MIN) return false;
      const r = await transfer(pd[0].phone_norm, me, { note: String(ev.text).trim().slice(0, NOTE_MAX) });
      await reply(r.ok ? transferredText({ phone: pd[0].phone_norm }) : `ماقدرتش أحوّلها: ${FAIL_AR[r.error] || r.message || r.error}`);
      return true;
    }
    const [, act, fid, arg] = id;
    const row = await rowByFid(fid);
    if (!row) { await reply(FAIL_AR.gone); return true; }
    const pn = row.phone_norm, name = await nameOf(pn);
    const fail = (r) => reply(`ماقدرتش: ${FAIL_AR[r.error] || r.message || r.error}`);
    if (act === "take") {
      const r = await take(pn, me, { force: MANAGERS.has(m.role) });
      if (!r.ok) { await fail(r); return true; }
      await reply(tookText({ phone: pn, name }), [{ id: `flow:done:${fid}`, title: ACTIONS.done }, ...(m.role === "cashier" && cfg.transfer.enabled ? [{ id: `flow:xfer:${fid}`, title: ACTIONS.transfer }] : []), { id: `flow:rel:${fid}`, title: ACTIONS.release }]);
    } else if (act === "rel") {
      const r = await release(pn, me);
      if (!r.ok) await fail(r); else await reply(releasedText({ phone: pn }));
    } else if (act === "done") {
      await reply(closeAskText({ phone: pn }), null, { button: "نتيجة المحادثة", rows: OUTCOMES.map((o) => ({ id: `flow:out:${fid}:${o.id}`, title: o.label })) });
    } else if (act === "out") {
      const r = await close(pn, me, { outcome: arg });
      if (!r.ok) await fail(r); else await reply(closedText({ phone: pn, outcome: arg }));
    } else if (act === "xfer") {
      if (m.role !== "cashier") { await reply(FAIL_AR.cashier_only); return true; }
      await q("INSERT INTO wa_flow_pending(staff_phone, phone_norm, kind, at) VALUES ($1,$2,'transfer',$3) ON CONFLICT (staff_phone) DO UPDATE SET phone_norm=$2, kind='transfer', at=$3", [m.phone, pn, clock().toISOString()]);
      await reply(noteAskText({ phone: pn }));
    }
    return true;
  }

  /* ── ٤) رجوع المساعد: ملخص اللي الموظف قاله + النتيجة (مرة واحدة، لحد ٢٤ ساعة) ── */
  async function handbackFor(pn) {
    const r = await rowOf(pn);
    const hb = r && r.handback && typeof r.handback === "object" ? r.handback : null;
    if (!hb || !hb.at || clock().getTime() - ms(hb.at) > 24 * H) return null;
    const o = outcomeOf(hb.outcome);
    return { outcome: hb.outcome, outcome_label: o ? o.label : hb.outcome, staff_note: hb.note || null, staff_told_customer: Array.isArray(hb.staffSaid) ? hb.staffSaid : [],
      closed_minutes_ago: Math.max(0, Math.floor((clock().getTime() - ms(hb.at)) / MIN)), still_to_do: hb.outcome === "follow_up" };
  }
  const handbackUsed = (pn) => q("UPDATE wa_flow SET handback=NULL, updated_at=NOW() WHERE phone_norm=$1", [pn]);

  let ticking = false;
  async function tick() {
    if (ticking) return { skipped: "busy" };
    ticking = true;
    try { await ready; const cfg = await cfgNow(), now = clock(); if (!cfg.enabled) return { skipped: "off" };
      return { escalated: await climb(cfg, now), closeReminders: await closeReminders(cfg, now) }; }
    catch (e) { log.error("[wa-flow] tick:", e.message); return { escalated: 0, closeReminders: 0 }; }
    finally { ticking = false; }
  }
  const timer = deps.noTimer ? null : setInterval(() => { tick().catch(() => {}); }, 60_000);
  if (timer && typeof timer.unref === "function") timer.unref();

  if (app && typeof app.get === "function") {
    if (deps.requirePortal) app.get("/api/portal/wa/sop", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      if (!["cashier", "manager"].includes(a.user && a.user.role)) return c.json({ ok: false, error: "forbidden" }, 403);
      return c.json({ ok: true, ...sopFor(a.user.role, await cfgNow()) });
    });
    app.get("/api/cms/wa/threads-sop", async (c) => {
      const err = await ctx.requireAdmin(c); if (err) return err;
      return c.json({ ok: true, ...sopFor("manager", await cfgNow()) });
    });
  }

  return { ready, onHandover, tick, climb, closeReminders, take, release, close, transfer, staffInbound, flowsFor, flowFor, transferredCount, handbackFor, handbackUsed, stop: () => { if (timer) clearInterval(timer); } };
}
