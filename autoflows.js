/* ═══════════════════════════════════════════════════════════════════════════
   ⚡ AUTO1 (٢٢/١٠) — «مركز الأتمتة»: فلوهات جديدة من اللوحة (المحرّك الصغير)

   الفلوهات الموجودة (السلات، اطلب تاني، التقييم، تنبيهات الفريق…) بتفضل في
   موديولاتها زي ما هي — automations.js بيعرضها ويعدّلها من مساراتها الأصلية.
   الملف ده للفلوهات **الجديدة** اللي المالك بيبنيها من «معرض القوالب»:
   محفّز (شريحة / جدول / حدث) ← شروط ← خطوات (انتظار / رسالة / تفرّع) ← هدف.

   قواعد الأمان (مش اختيارية):
     • كل فلو جديد بيتعمل **مقفول** (active=false). التشغيل من اللوحة بتأكيد.
     • أول تشغيل لفلو «دخول شريحة» = نقطة بداية من غير إرسال (زي cms_flows).
     • الإرسال بيعدّي على نفس حراس الحملات (deps.guard): الإيقاف/الموظفين/
       أرقام التجارب/الفاصل/فرملة SMS/السقف اليومي — مفيش حارس جديد موازي.
     • ساعات الهدوء (SMS/إشعار) ومواعيد الإرسال (واتساب) من deps.quietUntil —
       نفس المصدر الواحد (smsrules.quietOf / sendhours).
     • سقف لكل فلو: مرة كل reenterDays للجوال، perRun للدورة، perDay لليوم.
     • holdout ثابت بالهاش (smsrules.inHoldout) عشان نقيس الأثر الحقيقي.

   التخزين من ورا واجهة store (pgStore للداتابيز، memStore للاختبارات) —
   المحرّك نفسه مالوش SQL، فبيتختبر كله بفيكس (autoflows.test.mjs).
═══════════════════════════════════════════════════════════════════════════ */

export const DEF_VERSION = 1;

/* ── وحدات البناء (الكتالوج اللي اللوحة بتبني منه) ─────────────────────── */
export const TRIGGERS = Object.freeze([
  { id: "segment_entry", label: "دخل شريحة", icon: "🎯", hint: "أول ما العميل يدخل الشريحة (بنفحص كل ساعة). الموجودين وقت التشغيل = نقطة بداية من غير إرسال" },
  { id: "schedule", label: "جدول ثابت", icon: "🗓", hint: "في أيام وساعة محددة لكل اللي في الشريحة ساعتها" },
  { id: "event", label: "حدث", icon: "⚡", hint: "بعد حدث زي طلب مدفوع أو أول طلب" },
]);
export const EVENTS = Object.freeze([
  { id: "order_paid", label: "طلب مدفوع من الموقع" },
  { id: "first_order", label: "أول طلب من الموقع" },
]);
export const CONDITION_FIELDS = Object.freeze([
  { id: "orders", label: "عدد الطلبات", unit: "طلب" },
  { id: "daysSinceLast", label: "أيام من آخر طلب", unit: "يوم" },
  { id: "spent", label: "إجمالي الصرف", unit: "ر.س" },
]);
export const OPS = Object.freeze({ gte: "≥", lte: "≤", eq: "=" });
export const CHANNELS = Object.freeze([
  { id: "push", label: "إشعار", icon: "🔔", marketing: true, cost: 0 },
  { id: "sms", label: "SMS", icon: "✉️", marketing: true, cost: 0.08 },
  { id: "wa_template", label: "قالب واتساب", icon: "🟢", marketing: true, cost: 0.2 },
  { id: "wa_text", label: "واتساب نص حر (النافذة مفتوحة بس)", icon: "💬", marketing: true, cost: 0 },
  { id: "staff_alert", label: "تنبيه للفريق", icon: "📟", marketing: false, cost: 0.08 },
]);
export const BRANCH_CHECKS = Object.freeze([
  { id: "ordered", label: "طلب؟" },
  { id: "replied", label: "ردّ على واتساب؟" },
]);
export const STEP_TYPES = Object.freeze([
  { id: "wait", label: "انتظار", icon: "⏳" },
  { id: "send", label: "رسالة", icon: "📨" },
  { id: "branch", label: "تفرّع", icon: "🔀" },
]);
export const CAP_LIMITS = Object.freeze({ reenterDays: [1, 365], perRun: [1, 500], perDay: [1, 2000], holdoutPct: [0, 50], waitMinutes: [5, 60 * 24 * 60], goalDays: [1, 60], withinHours: [1, 24 * 30] });
export const CAP_DEFAULTS = Object.freeze({ reenterDays: 30, perRun: 100, perDay: 200 });

const chanById = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (s, n) => String(s ?? "").replace(/\s+$/g, "").slice(0, n);
const int = (v, [lo, hi], d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const STEP_ID = /^[a-z][a-z0-9_]{0,23}$/;

/* ── التحقق: بيرجّع def منظّف أو أخطاء بالعربي ─────────────────────────── */
export function validateDef(raw, { segments = null, templates = null } = {}) {
  const errors = [];
  const err = (path, msg) => errors.push({ path, error: msg });
  const d = isObj(raw) ? raw : {};
  const out = { v: DEF_VERSION };

  const t = isObj(d.trigger) ? d.trigger : {};
  if (!TRIGGERS.some((x) => x.id === t.type)) err("trigger.type", "اختار المحفّز: شريحة / جدول / حدث");
  out.trigger = { type: t.type };
  if (t.type === "segment_entry" || t.type === "schedule") {
    const seg = String(t.segment || "");
    if (!seg) err("trigger.segment", "اختار الشريحة");
    else if (segments && !segments.has(seg)) err("trigger.segment", `مفيش شريحة اسمها «${seg}»`);
    out.trigger.segment = seg;
  }
  if (t.type === "schedule") {
    const days = Array.isArray(t.days) ? [...new Set(t.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : [];
    if (!days.length) err("trigger.days", "اختار يوم واحد على الأقل");
    if (!HHMM.test(String(t.at || ""))) err("trigger.at", "الساعة لازم HH:MM");
    out.trigger.days = days; out.trigger.at = String(t.at || "");
  }
  if (t.type === "event") {
    if (!EVENTS.some((x) => x.id === t.event)) err("trigger.event", "اختار الحدث");
    out.trigger.event = t.event;
  }

  out.conditions = [];
  (Array.isArray(d.conditions) ? d.conditions : []).slice(0, 6).forEach((c, i) => {
    if (!CONDITION_FIELDS.some((f) => f.id === c?.field) || !OPS[c?.op] || !Number.isFinite(Number(c?.value))) { err(`conditions.${i}`, "شرط ناقص (الحقل / المقارنة / الرقم)"); return; }
    out.conditions.push({ field: c.field, op: c.op, value: Math.max(0, Number(c.value)) });
  });

  const rawSteps = Array.isArray(d.steps) ? d.steps.slice(0, 12) : [];
  if (!rawSteps.length) err("steps", "لازم خطوة رسالة واحدة على الأقل");
  const ids = new Set();
  out.steps = rawSteps.map((s, i) => {
    const p = `steps.${i}`;
    const id = STEP_ID.test(String(s?.id || "")) ? String(s.id) : `s${i + 1}`;
    if (ids.has(id)) err(`${p}.id`, `الخطوة ${id} متكررة`);
    ids.add(id);
    if (s?.type === "wait") return { id, type: "wait", minutes: int(s.minutes, CAP_LIMITS.waitMinutes, 60) };
    if (s?.type === "branch") {
      if (!BRANCH_CHECKS.some((b) => b.id === s.check)) err(`${p}.check`, "التفرّع على إيه؟ طلب / ضغط / رد");
      return { id, type: "branch", check: s.check, withinHours: int(s.withinHours, CAP_LIMITS.withinHours, 48), yes: String(s.yes || "exit"), no: String(s.no || "next") };
    }
    if (s?.type === "send") {
      const ch = chanById[s.channel];
      if (!ch) { err(`${p}.channel`, "اختار القناة"); return { id, type: "send", channel: null }; }
      const st = { id, type: "send", channel: ch.id };
      if (ch.id === "wa_template") {
        st.template = clip(s.template, 80);
        st.params = (Array.isArray(s.params) ? s.params : []).slice(0, 5).map((x) => clip(x, 120));
        if (!st.template) err(`${p}.template`, "اختار القالب");
        else if (templates && !templates.has(st.template)) err(`${p}.template`, `القالب «${st.template}» مش معتمد أو مش موجود`);
      } else {
        st.text = clip(s.text, ch.id === "sms" ? 320 : 600);
        if (!st.text.trim()) err(`${p}.text`, "اكتب نص الرسالة");
        if (ch.id === "push") { st.title = clip(s.title || "فريش كاتس 🍔", 40); st.url = clip(s.url || "", 200); }
      }
      return st;
    }
    err(`${p}.type`, "نوع خطوة مش معروف");
    return { id, type: "wait", minutes: 60 };
  });
  if (rawSteps.length && !out.steps.some((s) => s.type === "send")) err("steps", "لازم خطوة رسالة واحدة على الأقل");
  for (const [i, s] of out.steps.entries()) {
    if (s.type !== "branch") continue;
    for (const k of ["yes", "no"]) if (!["exit", "next", "goal"].includes(s[k]) && !ids.has(s[k])) err(`steps.${i}.${k}`, `التفرّع بيودّي على خطوة مش موجودة «${s[k]}»`);
  }
  if (out.steps.length && out.steps[0].type === "branch") err("steps.0", "التفرّع مايبقاش أول خطوة");

  const g = isObj(d.goal) ? d.goal : null;
  out.goal = g && g.type === "order" ? { type: "order", withinDays: int(g.withinDays, CAP_LIMITS.goalDays, 7) } : null;
  out.exitOnGoal = d.exitOnGoal !== false;

  const caps = isObj(d.caps) ? d.caps : {};
  out.caps = {
    reenterDays: int(caps.reenterDays, CAP_LIMITS.reenterDays, CAP_DEFAULTS.reenterDays),
    perRun: int(caps.perRun, CAP_LIMITS.perRun, CAP_DEFAULTS.perRun),
    perDay: int(caps.perDay, CAP_LIMITS.perDay, CAP_DEFAULTS.perDay),
  };
  out.holdoutPct = int(d.holdoutPct, CAP_LIMITS.holdoutPct, 10);
  out.respectQuiet = true;   // رسايل العملاء دايماً بساعات الهدوء — مش مفتاح
  return { ok: errors.length === 0, errors, def: out };
}

/* ── أدوات وقت (توقيت الرياض +٣ ثابت، من غير DST) ─────────────────────── */
const RIYADH_MS = 3 * 3600_000;
export function riyadh(now) {
  const d = new Date(new Date(now).getTime() + RIYADH_MS);
  return { day: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
}
/* خانة الجدول: لو اليوم مطابق والساعة عدّت «at» بأقل من windowMin ⇒ "YYYY-MM-DDTHH:MM" */
export function scheduleSlot(trigger, now, windowMin = 75) {
  if (!trigger || trigger.type !== "schedule" || !HHMM.test(String(trigger.at || ""))) return null;
  const r = riyadh(now);
  if (!trigger.days.includes(r.day)) return null;
  const [h, m] = trigger.at.split(":").map(Number);
  const diff = (r.hh * 60 + r.mm) - (h * 60 + m);
  return diff >= 0 && diff < windowMin ? `${r.ymd}T${trigger.at}` : null;
}
/* المرات الجاية للجدول (للتايم لاين في اللوحة) */
export function nextScheduleTimes(trigger, now, count = 7) {
  if (!trigger || trigger.type !== "schedule" || !HHMM.test(String(trigger.at || "")) || !trigger.days?.length) return [];
  const [h, m] = trigger.at.split(":").map(Number);
  const out = [];
  const base = new Date(now).getTime();
  for (let i = 0; i < 15 && out.length < count; i++) {
    const r = riyadh(base + i * 86400_000);
    if (!trigger.days.includes(r.day)) continue;
    const at = Date.parse(`${r.ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`) - RIYADH_MS;
    if (at > base) out.push(new Date(at).toISOString());
  }
  return out;
}

export function render(text, person = {}, vars = {}) {
  const first = String(person.name || "").trim().split(/\s+/)[0] || "";
  return String(text || "")
    .replaceAll("{name}", first)
    .replaceAll("{link}", vars.link || "")
    .replace(/[ \t]{2,}/g, " ").trim();
}
export function stepCost(step) { return chanById[step?.channel]?.cost || 0; }
export function holdoutHash(key, pn, pct) {
  if (!pct) return false;
  let h = 2166136261;
  for (const ch of `${key}:${pn}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100) < pct;
}
export function condOk(conds, prof) {
  for (const c of conds || []) {
    const v = Number(prof?.[c.field]);
    if (!Number.isFinite(v)) return false;
    if (c.op === "gte" && !(v >= c.value)) return false;
    if (c.op === "lte" && !(v <= c.value)) return false;
    if (c.op === "eq" && v !== c.value) return false;
  }
  return true;
}

/* شرح بالعربي لأي فلو (كارت/جدول/كانفاس) */
export function describeDef(def, segLabel = (s) => s) {
  const t = def?.trigger || {};
  const DAYS = ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];
  const trig = t.type === "segment_entry" ? `لما العميل يدخل «${segLabel(t.segment)}»`
    : t.type === "schedule" ? `${(t.days || []).map((d) => DAYS[d]).join(" و")} الساعة ${t.at} لـ«${segLabel(t.segment)}»`
      : t.type === "event" ? `بعد «${(EVENTS.find((e) => e.id === t.event) || {}).label || t.event}»` : "—";
  const chans = [...new Set((def?.steps || []).filter((s) => s.type === "send").map((s) => s.channel))];
  return { trigger: trig, channels: chans };
}

/* ═══ المحرّك ════════════════════════════════════════════════════════════
   deps:
     store            واجهة التخزين (pgStore / memStore)
     getSettings()    صف الإعدادات (للهدوء والحراس)
     segmentPhones(id) → [pn]                      (cms.segmentPhones)
     eventsSince(type, sinceIso) → [{pn, at, ref}]
     profiles(pns) → Map pn → {orders, daysSinceLast, spent, name}
     guard(channel, pn, settings) → {ok} | {ok:false, reason}
     quietUntil(channel, settings, now) → Date|null   (null = مسموح دلوقتي)
     send: { push, sms, wa_template, wa_text, staff_alert } (pn, payload, meta) → {ok, cost?, error?}
     ordered(pn, sinceIso, untilIso) → {n, revenue}
     clicked(flowId, pn, sinceIso) / replied(pn, sinceIso) → bool
     now() → Date
   ═════════════════════════════════════════════════════════════════════════ */
export function makeEngine(deps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const iso = (d) => new Date(d).toISOString();
  const addMin = (d, m) => new Date(new Date(d).getTime() + m * 60_000);

  async function entrantsFor(flow, def, t) {
    const tr = def.trigger;
    if (tr.type === "segment_entry") {
      const cur = new Set(await deps.segmentPhones(tr.segment));
      if (!flow.baseline_at) {
        await deps.store.setMembers(flow.id, [...cur], null);
        await deps.store.updateFlow(flow.id, { baseline_at: iso(t) });
        return { list: [], note: `baseline:${cur.size}` };
      }
      const seen = await deps.store.membersOf(flow.id);
      const list = [...cur].filter((p) => !seen.has(p));
      const left = [...seen].filter((p) => !cur.has(p));
      await deps.store.setMembers(flow.id, list, left);
      return { list, note: left.length ? `left:${left.length}` : "" };
    }
    if (tr.type === "schedule") {
      const slot = scheduleSlot(tr, t);
      if (!slot || slot === flow.last_slot) return { list: [], note: "" };
      await deps.store.updateFlow(flow.id, { last_slot: slot });
      return { list: [...new Set(await deps.segmentPhones(tr.segment))], note: `slot:${slot}` };
    }
    if (tr.type === "event") {
      const since = flow.last_event_at || flow.activated_at || iso(t);
      const ev = await deps.eventsSince(tr.event, since);
      if (!ev.length) return { list: [], note: "" };
      const last = ev.reduce((m, e) => (e.at > m ? e.at : m), since);
      await deps.store.updateFlow(flow.id, { last_event_at: iso(last) });
      return { list: [...new Set(ev.map((e) => e.pn))], note: "" };
    }
    return { list: [], note: "bad_trigger" };
  }

  async function goalMet(def, e, t) {
    if (!def.goal || def.goal.type !== "order") return null;
    const until = addMin(e.enrolled_at, def.goal.withinDays * 1440);
    if (new Date(t) > until && !deps.ordered) return null;
    const r = await deps.ordered(e.phone_norm, iso(e.enrolled_at), iso(until < new Date(t) ? until : t));
    return r && r.n > 0 ? r : null;
  }

  async function branchTrue(step, flow, e, t) {
    const since = iso(e.step_at || e.enrolled_at);
    if (step.check === "ordered") { const r = await deps.ordered(e.phone_norm, since, iso(t)); return Boolean(r && r.n > 0); }
    if (step.check === "clicked") return Boolean(await deps.clicked?.(flow.id, e.phone_norm, since));
    if (step.check === "replied") return Boolean(await deps.replied?.(e.phone_norm, since));
    return false;
  }

  /* خطوة/خطوات لعميل واحد — بيرجّع «stop» لو وقف لسبب في الدورة كلها (سقف الدورة) */
  async function advanceOne(flow, def, e, t, settings, run, people) {
    const idx = Object.fromEntries(def.steps.map((s, i) => [s.id, i]));
    for (let guard = 0; guard < 24; guard++) {
      const won = await goalMet(def, e, t);
      if (won && def.exitOnGoal) {
        await deps.store.updateEnroll(e.id, { status: "converted", finished_at: iso(t) });
        await deps.store.logEvent({ flow_id: flow.id, enroll_id: e.id, phone_norm: e.phone_norm, kind: "goal", revenue: won.revenue || 0 });
        run.converted++; return;
      }
      const step = def.steps[e.step_idx];
      if (!step) { await deps.store.updateEnroll(e.id, { status: "done", finished_at: iso(t) }); return; }
      if (step.type === "wait") {
        if (e.waiting_step === step.id) { e.step_idx++; e.waiting_step = null; await deps.store.updateEnroll(e.id, { step_idx: e.step_idx, waiting_step: null, step_at: iso(t) }); continue; }
        const at = addMin(t, step.minutes);
        await deps.store.updateEnroll(e.id, { next_at: iso(at), waiting_step: step.id });
        return;
      }
      if (step.type === "branch") {
        const yes = await branchTrue(step, flow, e, t);
        const to = yes ? step.yes : step.no;
        await deps.store.logEvent({ flow_id: flow.id, enroll_id: e.id, phone_norm: e.phone_norm, step_id: step.id, kind: "branch", reason: yes ? "yes" : "no" });
        if (to === "exit") { await deps.store.updateEnroll(e.id, { status: "exited", finished_at: iso(t) }); return; }
        if (to === "goal") { await deps.store.updateEnroll(e.id, { status: yes ? "converted" : "exited", finished_at: iso(t) }); if (yes) run.converted++; return; }
        e.step_idx = to === "next" ? e.step_idx + 1 : idx[to];
        await deps.store.updateEnroll(e.id, { step_idx: e.step_idx, step_at: iso(t) });
        continue;
      }
      // send
      const ch = chanById[step.channel];
      if (ch?.marketing && def.respectQuiet !== false) {
        const q = await deps.quietUntil(step.channel, settings, t);
        if (q) {
          await deps.store.updateEnroll(e.id, { next_at: iso(q) });
          run.deferred.quiet = (run.deferred.quiet || 0) + 1; return;
        }
      }
      if (run.sentToday >= def.caps.perDay) {
        await deps.store.updateEnroll(e.id, { next_at: iso(addMin(t, 60)) });
        run.deferred.daily_cap = (run.deferred.daily_cap || 0) + 1; return;
      }
      if (run.sent >= def.caps.perRun) { run.deferred.run_cap = (run.deferred.run_cap || 0) + 1; return "stop"; }
      const g = await deps.guard(step.channel, e.phone_norm, settings);
      if (!g || !g.ok) {
        const reason = (g && g.reason) || "guard";
        run.skipped[reason] = (run.skipped[reason] || 0) + 1;
        await deps.store.logEvent({ flow_id: flow.id, enroll_id: e.id, phone_norm: e.phone_norm, step_id: step.id, kind: "skipped", channel: step.channel, reason });
        if (g && g.retry) { await deps.store.updateEnroll(e.id, { next_at: iso(addMin(t, 60)) }); return; }
        e.step_idx++; await deps.store.updateEnroll(e.id, { step_idx: e.step_idx, step_at: iso(t) }); continue;
      }
      const person = people.get(e.phone_norm) || {};
      const payload = step.channel === "wa_template" ? { template: step.template, params: (step.params || []).map((x) => render(x, person)) }
        : step.channel === "push" ? { title: step.title, body: render(step.text, person), url: step.url }
          : { text: render(step.text, person) };
      let r;
      try { r = await deps.send[step.channel](e.phone_norm, payload, { flowId: flow.id, stepId: step.id, enrollId: e.id }); }
      catch (x) { r = { ok: false, error: String(x?.message || x) }; }
      if (r && r.ok) { run.sent++; run.sentToday++; run.byChannel[step.channel] = (run.byChannel[step.channel] || 0) + 1; }
      else run.failed++;
      await deps.store.logEvent({ flow_id: flow.id, enroll_id: e.id, phone_norm: e.phone_norm, step_id: step.id, kind: r && r.ok ? "sent" : "failed",
        channel: step.channel, reason: r && !r.ok ? clip(r.error || "send_failed", 120) : null, cost: r && r.ok ? Number(r.cost ?? stepCost(step)) : 0 });
      e.step_idx++; await deps.store.updateEnroll(e.id, { step_idx: e.step_idx, step_at: iso(t) });
    }
  }

  async function runFlow(flow, settings, trigger = "cron") {
    const t = now();
    const v = validateDef(flow.def);
    if (!v.ok) { await deps.store.logRun({ flow_id: flow.id, trigger, note: "invalid_def", entered: 0 }); return { error: "invalid_def", errors: v.errors }; }
    const def = v.def;
    const run = { entered: 0, holdout: 0, sent: 0, failed: 0, converted: 0, skipped: {}, deferred: {}, byChannel: {}, sentToday: await deps.store.sentToday(flow.id, t) };
    const ent = await entrantsFor(flow, def, t);
    let list = ent.list;
    if (list.length) {
      const recent = await deps.store.lastEnrolledAt(flow.id, list);
      const cut = t.getTime() - def.caps.reenterDays * 86400_000;
      const n0 = list.length;
      list = list.filter((p) => !(recent.get(p) && new Date(recent.get(p)).getTime() > cut));
      if (n0 - list.length) run.skipped.reenter = n0 - list.length;
      if (def.conditions.length && list.length) {
        const prof = await deps.profiles(list);
        const n1 = list.length;
        list = list.filter((p) => condOk(def.conditions, prof.get(p)));
        if (n1 - list.length) run.skipped.conditions = n1 - list.length;
      }
      const rows = list.map((pn) => ({ pn, holdout: holdoutHash(`a${flow.id}`, pn, def.holdoutPct) }));
      await deps.store.enroll(flow.id, rows.map((r) => ({ ...r, next_at: iso(t) })));
      run.entered = rows.length; run.holdout = rows.filter((r) => r.holdout).length;
    }
    const due = await deps.store.due(flow.id, iso(t), 1000);
    const people = due.length ? await deps.profiles(due.map((e) => e.phone_norm)) : new Map();
    for (const e of due) {
      const r = await advanceOne(flow, def, e, t, settings, run, people);
      if (r === "stop") break;
    }
    await deps.store.updateFlow(flow.id, { last_run_at: iso(t) });
    const out = { flow_id: flow.id, trigger, entered: run.entered, holdout: run.holdout, sent: run.sent, failed: run.failed, converted: run.converted,
      skipped: run.skipped, deferred: run.deferred, by_channel: run.byChannel, note: ent.note };
    await deps.store.logRun(out);
    return out;
  }

  let busy = false;
  async function tick(trigger = "cron") {
    if (busy) return { busy: true };
    busy = true;
    try {
      const flows = await deps.store.listActive();
      if (!flows.length) return { flows: 0 };
      const settings = await deps.getSettings();
      const res = [];
      for (const f of flows) res.push(await runFlow(f, settings, trigger).catch((e) => ({ flow_id: f.id, error: String(e?.message || e) })));
      return { flows: flows.length, res };
    } finally { busy = false; }
  }

  /* «جرّب على موبايلي»: أول رسالة في الفلو لرقم تجربة بس — مايدخلش الفلو ومايتحسبش */
  async function testSend(flow, phone, { allowed, person = { name: "عمر" } } = {}) {
    if (!allowed || !allowed.has(phone)) return { ok: false, error: "not_test_phone", message: "التجربة لأرقام الفريق والتجربة بس" };
    const v = validateDef(flow.def);
    if (!v.ok) return { ok: false, error: "invalid_def", errors: v.errors };
    const step = v.def.steps.find((s) => s.type === "send");
    const payload = step.channel === "wa_template" ? { template: step.template, params: (step.params || []).map((x) => render(x, person)), test: true }
      : step.channel === "push" ? { title: step.title, body: render(step.text, person), url: step.url, test: true } : { text: render(step.text, person), test: true };
    const r = await deps.send[step.channel](phone, payload, { flowId: flow.id, stepId: step.id, test: true });
    await deps.store.logEvent({ flow_id: flow.id, phone_norm: phone, step_id: step.id, kind: "test", channel: step.channel, reason: r?.ok ? null : clip(r?.error || "failed", 120) });
    return { ok: Boolean(r?.ok), channel: step.channel, preview: payload, error: r?.ok ? null : r?.error || "failed" };
  }

  return { tick, runFlow, testSend, advanceOne, entrantsFor };
}

/* ═══ التخزين ═══════════════════════════════════════════════════════════ */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS auto_flows (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    def JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    template TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    baseline_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_slot TEXT,
    last_event_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS auto_flow_members (
    flow_id INT NOT NULL,
    phone_norm TEXT NOT NULL,
    PRIMARY KEY (flow_id, phone_norm)
  );
  CREATE TABLE IF NOT EXISTS auto_flow_enroll (
    id BIGSERIAL PRIMARY KEY,
    flow_id INT NOT NULL,
    phone_norm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    holdout BOOLEAN NOT NULL DEFAULT FALSE,
    step_idx INT NOT NULL DEFAULT 0,
    waiting_step TEXT,
    next_at TIMESTAMPTZ,
    step_at TIMESTAMPTZ,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS auto_flow_enroll_due ON auto_flow_enroll(flow_id, status, next_at);
  CREATE INDEX IF NOT EXISTS auto_flow_enroll_pn ON auto_flow_enroll(flow_id, phone_norm, enrolled_at DESC);
  CREATE TABLE IF NOT EXISTS auto_flow_events (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    flow_id INT NOT NULL,
    enroll_id BIGINT,
    phone_norm TEXT,
    step_id TEXT,
    kind TEXT NOT NULL,
    channel TEXT,
    reason TEXT,
    cost NUMERIC(10,3) NOT NULL DEFAULT 0,
    revenue NUMERIC(10,2) NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS auto_flow_events_idx ON auto_flow_events(flow_id, at DESC);
  CREATE TABLE IF NOT EXISTS auto_flow_runs (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    flow_id INT NOT NULL,
    trigger TEXT,
    entered INT NOT NULL DEFAULT 0,
    holdout INT NOT NULL DEFAULT 0,
    sent INT NOT NULL DEFAULT 0,
    failed INT NOT NULL DEFAULT 0,
    converted INT NOT NULL DEFAULT 0,
    skipped JSONB,
    deferred JSONB,
    by_channel JSONB,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS auto_flow_runs_idx ON auto_flow_runs(flow_id, at DESC);
`;

const FLOW_COLS = ["name", "icon", "def", "active", "archived", "template", "activated_at", "baseline_at", "last_run_at", "last_slot", "last_event_at"];
const ENROLL_COLS = ["status", "step_idx", "waiting_step", "next_at", "step_at", "finished_at"];

export function pgStore(pool, { paidSql = "o.status IN ('paid')" } = {}) {
  let ready = null;
  const ensure = () => (ready ||= pool.query(SCHEMA_SQL).catch((e) => { ready = null; throw e; }));
  const q = async (sql, p) => { await ensure(); return pool.query(sql, p); };
  const set = (patch, cols, start = 2) => {
    const keys = Object.keys(patch).filter((k) => cols.includes(k));
    return { keys, sql: keys.map((k, i) => `${k} = $${i + start}${k === "def" ? "::jsonb" : ""}`).join(", "), vals: keys.map((k) => (k === "def" ? JSON.stringify(patch[k]) : patch[k])) };
  };
  return {
    ensure,
    async listActive() { return (await q("SELECT * FROM auto_flows WHERE active AND NOT archived ORDER BY id")).rows; },
    async listFlows() { return (await q("SELECT * FROM auto_flows WHERE NOT archived ORDER BY id DESC")).rows; },
    async getFlow(id) { return (await q("SELECT * FROM auto_flows WHERE id=$1", [id])).rows[0] || null; },
    async createFlow({ name, icon, def, template, createdBy }) {
      return (await q(`INSERT INTO auto_flows(name, icon, def, template, created_by) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *`,
        [name, icon || null, JSON.stringify(def), template || null, createdBy || null])).rows[0];
    },
    async updateFlow(id, patch) {
      const s = set(patch, FLOW_COLS);
      if (!s.keys.length) return null;
      return (await q(`UPDATE auto_flows SET ${s.sql}, updated_at = NOW() WHERE id=$1 RETURNING *`, [id, ...s.vals])).rows[0] || null;
    },
    async membersOf(id) { return new Set((await q("SELECT phone_norm FROM auto_flow_members WHERE flow_id=$1", [id])).rows.map((r) => r.phone_norm)); },
    async setMembers(id, add, remove) {
      if (remove === null) await q("DELETE FROM auto_flow_members WHERE flow_id=$1", [id]);
      else if (remove?.length) await q("DELETE FROM auto_flow_members WHERE flow_id=$1 AND phone_norm = ANY($2)", [id, remove]);
      if (add?.length) await q("INSERT INTO auto_flow_members(flow_id, phone_norm) SELECT $1, p FROM unnest($2::text[]) p ON CONFLICT DO NOTHING", [id, add]);
    },
    async lastEnrolledAt(id, pns) {
      const r = await q("SELECT phone_norm, max(enrolled_at) AS at FROM auto_flow_enroll WHERE flow_id=$1 AND phone_norm = ANY($2) GROUP BY 1", [id, pns]);
      return new Map(r.rows.map((x) => [x.phone_norm, x.at]));
    },
    async enroll(id, rows) {
      if (!rows.length) return;
      await q(`INSERT INTO auto_flow_enroll(flow_id, phone_norm, holdout, status, next_at)
               SELECT $1, x.pn, x.h, CASE WHEN x.h THEN 'holdout' ELSE 'active' END, $4::timestamptz
                 FROM unnest($2::text[], $3::bool[]) AS x(pn, h)`, [id, rows.map((r) => r.pn), rows.map((r) => r.holdout), rows[0].next_at]);
    },
    async due(id, at, limit) {
      return (await q("SELECT * FROM auto_flow_enroll WHERE flow_id=$1 AND status='active' AND (next_at IS NULL OR next_at <= $2) ORDER BY next_at NULLS FIRST, id LIMIT $3", [id, at, limit])).rows;
    },
    async updateEnroll(id, patch) {
      const s = set(patch, ENROLL_COLS);
      if (s.keys.length) await q(`UPDATE auto_flow_enroll SET ${s.sql} WHERE id=$1`, [id, ...s.vals]);
    },
    async logEvent(e) {
      await q(`INSERT INTO auto_flow_events(flow_id, enroll_id, phone_norm, step_id, kind, channel, reason, cost, revenue) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.flow_id, e.enroll_id || null, e.phone_norm || null, e.step_id || null, e.kind, e.channel || null, e.reason || null, Number(e.cost) || 0, Number(e.revenue) || 0]);
    },
    async logRun(r) {
      await q(`INSERT INTO auto_flow_runs(flow_id, trigger, entered, holdout, sent, failed, converted, skipped, deferred, by_channel, note)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
        [r.flow_id, r.trigger || null, r.entered || 0, r.holdout || 0, r.sent || 0, r.failed || 0, r.converted || 0,
          JSON.stringify(r.skipped || {}), JSON.stringify(r.deferred || {}), JSON.stringify(r.by_channel || {}), r.note || null]);
    },
    async sentToday(id, at) {
      return (await q(`SELECT count(*)::int AS n FROM auto_flow_events WHERE flow_id=$1 AND kind='sent'
                         AND (at AT TIME ZONE 'Asia/Riyadh')::date = ($2::timestamptz AT TIME ZONE 'Asia/Riyadh')::date`, [id, at])).rows[0]?.n || 0;
    },
    async recentRuns(id, limit = 20) { return (await q("SELECT * FROM auto_flow_runs WHERE flow_id=$1 ORDER BY at DESC LIMIT $2", [id, limit])).rows; },
    async recentEvents(id, limit = 30) {
      return (await q("SELECT id, at, step_id, kind, channel, reason, right(phone_norm, 4) AS tail FROM auto_flow_events WHERE flow_id=$1 ORDER BY at DESC LIMIT $2", [id, limit])).rows;
    },
    /* الأرقام: دخل/محجوز/اتبعت بالقناة/اتشال بالسبب/حقق الهدف + الأثر (طلب خلال ٧ أيام: داخلين قصاد محجوزين) */
    async stats(id, sinceIso) {
      const ev = (await q(`SELECT kind, channel, reason, count(*)::int AS n, COALESCE(sum(cost),0)::float AS cost, COALESCE(sum(revenue),0)::float AS rev
                             FROM auto_flow_events WHERE flow_id=$1 AND at >= $2 GROUP BY 1,2,3`, [id, sinceIso])).rows;
      const en = (await q(`SELECT e.holdout, count(*)::int AS n,
                                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm = e.phone_norm AND ${paidSql}
                                    AND o.created_at >= e.enrolled_at AND o.created_at < e.enrolled_at + INTERVAL '7 days'))::int AS ordered7
                             FROM auto_flow_enroll e WHERE e.flow_id=$1 AND e.enrolled_at >= $2 GROUP BY 1`, [id, sinceIso]).catch(() => ({ rows: [] }))).rows;
      return foldStats(ev, en);
    },
  };
}

export function foldStats(ev, en) {
  const out = { entered: 0, holdout: 0, sent: {}, sentTotal: 0, failed: 0, skipped: {}, converted: 0, revenue: 0, cost: 0, tests: 0, lift7: null, liftReliable: false };
  for (const x of ev) {
    if (x.kind === "sent") { out.sent[x.channel] = (out.sent[x.channel] || 0) + x.n; out.sentTotal += x.n; out.cost += x.cost; }
    else if (x.kind === "failed") out.failed += x.n;
    else if (x.kind === "skipped") out.skipped[x.reason || "guard"] = (out.skipped[x.reason || "guard"] || 0) + x.n;
    else if (x.kind === "goal") { out.converted += x.n; out.revenue += x.rev; }
    else if (x.kind === "test") out.tests += x.n;
  }
  let a = null, b = null;
  for (const r of en) {
    if (r.holdout) { out.holdout += r.n; b = r.n ? r.ordered7 / r.n : null; } else { out.entered += r.n; a = r.n ? r.ordered7 / r.n : null; }
  }
  out.entered += out.holdout;
  out.lift7 = a != null && b != null ? Math.round((a - b) * 1000) / 10 : null;
  out.liftReliable = out.holdout >= 20;
  out.cost = Math.round(out.cost * 100) / 100; out.revenue = Math.round(out.revenue);
  return out;
}

/* ذاكرة للاختبارات (نفس الواجهة) */
export function memStore() {
  const s = { flows: [], members: new Map(), enroll: [], events: [], runs: [], seq: { f: 0, e: 0 } };
  const flowOf = (id) => s.flows.find((f) => f.id === id);
  return {
    _s: s,
    async ensure() {},
    async listActive() { return s.flows.filter((f) => f.active && !f.archived); },
    async listFlows() { return s.flows.filter((f) => !f.archived); },
    async getFlow(id) { return flowOf(id) || null; },
    async createFlow({ name, icon, def, template, createdBy }) {
      const f = { id: ++s.seq.f, name, icon: icon || null, def, template: template || null, created_by: createdBy || null, active: false, archived: false,
        baseline_at: null, last_slot: null, last_event_at: null, activated_at: null, last_run_at: null, created_at: new Date().toISOString() };
      s.flows.push(f); return f;
    },
    async updateFlow(id, patch) { const f = flowOf(id); if (!f) return null; for (const k of FLOW_COLS) if (k in patch) f[k] = patch[k]; return f; },
    async membersOf(id) { return new Set(s.members.get(id) || []); },
    async setMembers(id, add, remove) {
      let m = s.members.get(id) || new Set();
      if (remove === null) m = new Set(); else for (const p of remove || []) m.delete(p);
      for (const p of add || []) m.add(p);
      s.members.set(id, m);
    },
    async lastEnrolledAt(id, pns) {
      const out = new Map();
      for (const e of s.enroll) if (e.flow_id === id && pns.includes(e.phone_norm) && (!out.get(e.phone_norm) || out.get(e.phone_norm) < e.enrolled_at)) out.set(e.phone_norm, e.enrolled_at);
      return out;
    },
    async enroll(id, rows) {
      for (const r of rows) s.enroll.push({ id: ++s.seq.e, flow_id: id, phone_norm: r.pn, holdout: r.holdout, status: r.holdout ? "holdout" : "active",
        step_idx: 0, waiting_step: null, next_at: r.next_at, step_at: null, enrolled_at: r.next_at, finished_at: null });
    },
    async due(id, at, limit) {
      return s.enroll.filter((e) => e.flow_id === id && e.status === "active" && (!e.next_at || e.next_at <= at)).slice(0, limit).map((e) => ({ ...e }));
    },
    async updateEnroll(id, patch) { const e = s.enroll.find((x) => x.id === id); if (e) for (const k of ENROLL_COLS) if (k in patch) e[k] = patch[k]; },
    async logEvent(e) { s.events.push({ at: new Date().toISOString(), ...e }); },
    async logRun(r) { s.runs.push({ at: new Date().toISOString(), ...r }); },
    async sentToday(id) { return s.events.filter((e) => e.flow_id === id && e.kind === "sent").length; },
    async recentRuns(id, limit = 20) { return s.runs.filter((r) => r.flow_id === id).slice(-limit).reverse(); },
    async recentEvents(id, limit = 30) { return s.events.filter((r) => r.flow_id === id).slice(-limit).reverse(); },
    async stats(id) {
      const g = new Map();
      for (const e of s.events.filter((x) => x.flow_id === id)) {
        const k = `${e.kind}|${e.channel || ""}|${e.reason || ""}`;
        const o = g.get(k) || { kind: e.kind, channel: e.channel || null, reason: e.reason || null, n: 0, cost: 0, rev: 0 };
        o.n++; o.cost += Number(e.cost) || 0; o.rev += Number(e.revenue) || 0; g.set(k, o);
      }
      const en = [true, false].map((h) => ({ holdout: h, n: s.enroll.filter((e) => e.flow_id === id && e.holdout === h).length, ordered7: 0 })).filter((x) => x.n);
      return foldStats([...g.values()], en);
    },
  };
}
