/* ═══════════════════════════════════════════════════════════════════════════
   waopenfu.js — WO1 (١٩/١٠/٢٠٢٦): «نكمّل لما نفتح» — العميل طلب والمطعم مقفول ⇒ رسالة واحدة أول ما نفتح بسلته

   الحادثة (عمر ١٩/١٠): عميل …6102 كتب ١٠:٣٦ الرياض والمطعم مقفول: «عايز نص دجاج فحم وباكت بطاطس». ماجد ردّ ١٠:٣٦:٥١:
   «مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً، وأجهّز لك السلة من الحين تكملها وقت ما نفتح … = 34 ر.س … توصيل ولا استلام؟».
   العميل ماردّش، وفتحنا ١٢:٠٠ ومحدش بعتله حاجة — الوعد «تكملها وقت ما نفتح» مالوش أي آلية. والسلة نفسها كانت عايشة في جلسة المساعد بس
   (state.cartNow / lastInput في wa_assist_chats)، والجلسة بتموت بعد assist.sessionMin (٩٠ د) — يعني وقت الفتح ماكانش فيه سلة نحكي عنها.
   عمر: «كان بيحاول يطلب الصبح بدري ولما فتحنا البوت مرجعش يبعتله تاني».

   الحل:
   ١) التسجيل (wabotrun assistTurn ⇒ record): رد المساعد اتبعت والمطعم مقفول بمواعيده (settings.hours، من غير هامش «يقف قبل القفل») وفيه سلة
      (معاينة أو رابط) أو كلمة طلب ⇒ شغلة واحدة في wa_bot_jobs (kind open_followup، المفتاح of:<الرقم>:<وقت الفتح>) ومعاها **صورة السلة**
      (السطور + المجموع + مدخلات السلة اللي تتسعّر بيها تاني) — السلة مابقتش معتمدة على الجلسة. رد جديد والمطعم لسه مقفول ⇒ نفس الشغلة بتتحدّث.
      الفتح + openFollowUpDelayMin هيعدّي قفلة نافذة الـ٢٤ ساعة ⇒ مفيش شغلة، وسطر «اتلغت: النافذة هتقفل قبل الفتح» في الدفتر.
   ٢) الإرسال (runDueJobs ⇒ run): وقت الفتح + التأخير، رسالة حرة واحدة بس (عمرها ما قالب مدفوع) لو: العميل ماكتبش من ساعتها، ماطلبش (الموقع أو نقطة البيع)،
      مش موقّف/محظور/مكتوم/مستلَم من موظف (wa_chat_holds) ولا عنده تحويل أو شكوى، مش موظف (قوايم «مايتردّش عليه»)، النافذة لسه مفتوحة،
      ومفيش متابعة تانية اتبعتت له في نفس النافذة، والفرامل (FU1) مش مشدودة، وتحت السقف اليومي. السعر بيتحسب تاني الحين من المنيو الحي:
      صنف خلص ⇒ سطر من غير سلة (أو ولا حاجة لو مقفول من اللوحة).
   ٣) مرة واحدة لكل شغلة: الحجز في wa_open_followups (job_key UNIQUE) قبل الإرسال — حاويتين وقت الـrollover مايبعتوش مرتين.
   ٤) كل قرار (اتبعت / اتلغى + السبب) سطر في الدفتر + سطر في سجل المساعد (wa_assist_turns)، والمبعوت كمان في سجل البوت (wa_bot_log).
   ملف صافي من ناحية الاعتماد: كل حاجة من wabotrun بتيجي في deps (مفيش import دائري).
═══════════════════════════════════════════════════════════════════════════ */
import { isRestaurantOpenAt, nextSendOpenAt, hoursKnown } from "./sendhours.js";
import { FU_SQL, FU_OTHER_JOBS, FU_PROACTIVE_KEYS, bizDayStart } from "./wafollow.js";

export const OF_KIND = "open_followup";          // wa_bot_jobs.kind + wa_bot_log.reply_key
export const OF_GROUP = "openFollowUp";
export const OF_GROUP_AR = "نكمّل لما نفتح: العميل طلب والمطعم مقفول";
export const WINDOW_MIN = 24 * 60 - 10;         // نفس هامش باقي رسايل البوت الحرة

export const OF_DEFAULTS = Object.freeze({
  openFollowUp: true,             // المفتاح الرئيسي
  openFollowUpDelayMin: 2,        // بعد الفتح بكام دقيقة
  openFollowUpPlain: true,        // كلمة طلب من غير سلة ⇒ سطر «فتحنا الحين، وش تحب نجهّز لك؟»
  openFollowUpDailyCap: 60,       // أقصى عدد في يوم الشغل (صفر = مقفول)
});
export const OF_NUMS = Object.freeze({ openFollowUpDelayMin: [0, 60], openFollowUpDailyCap: [0, 500] });
export const OF_BOOLS = Object.freeze(["openFollowUp", "openFollowUpPlain"]);
const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
export function ofConfig(x = {}) {
  const src = x && typeof x === "object" ? x : {};
  const out = {};
  for (const k of OF_BOOLS) out[k] = src[k] !== false;
  for (const [k, lim] of Object.entries(OF_NUMS)) out[k] = Math.round(clamp(src[k], lim, OF_DEFAULTS[k]));
  return out;
}
const S = (type, ar, help, extra = {}) => Object.freeze({ group: OF_GROUP, type, ar, help, ...extra });
const N = (k, ar, help, unit) => S("number", ar, help, { min: OF_NUMS[k][0], max: OF_NUMS[k][1], unit });
export const OF_SCHEMA = Object.freeze({
  openFollowUp: S("boolean", "نكمّل لما نفتح: رسالة واحدة وقت الفتح للي طلب والمطعم مقفول",
    "العميل كتب طلبه والمطعم مقفول والمساعد جهّز له السلة ⇒ أول ما نفتح (بعد التأخير تحت) رسالة حرة واحدة ببلاش: «فتحنا الحين 👋 سلتك جاهزة: … = … ر.س. توصيل ولا استلام؟» بالسعر الحي، أو زر السلة لو اتعمل رابط. مابتتبعتش لو العميل كتب أو طلب (الموقع أو الفرع) من ساعتها، أو وقّف الرسايل، أو المحادثة عند موظف أو فيها تحويل أو شكوى، أو نافذة الـ٢٤ ساعة هتقفل قبل الفتح (عمرها ما قالب مدفوع)، أو فيه متابعة تانية اتبعتت له. مرة واحدة بس. كل قرار وسببه في سجل المساعد. النص من «النصوص» (open_fu_cart / open_fu_link / open_fu_plain)."),
  openFollowUpDelayMin: N("openFollowUpDelayMin", "نكمّل لما نفتح: بعد الفتح بـ", "من أول دقيقة المطعم بيفتح فيها حسب مواعيده. صفر = مع الفتح.", "دقيقة"),
  openFollowUpPlain: S("boolean", "نكمّل لما نفتح: كمان لو مفيش سلة (كلمة طلب بس)", "العميل قال «ابي أطلب» والمطعم مقفول ومااتعملتش سلة، أو صنف في السلة خلص وقت الفتح ⇒ سطر «فتحنا الحين 👋 وش تحب نجهّز لك؟» من غير أسعار. مقفول = مفيش رسالة من غير سلة كاملة."),
  openFollowUpDailyCap: N("openFollowUpDailyCap", "نكمّل لما نفتح: أقصى عدد في اليوم", "يوم الشغل (٤ الفجر لـ٤ الفجر). صفر = مقفول.", "رسالة"),
});

/* ── الوقت والمواعيد ─────────────────────────────────────────────────────────── */
/* مواعيد المطعم نفسها (من غير «يقف قبل القفل» ومن غير مفتاح «الإرسال بمواعيد المطعم» — ده سؤال «مفتوحين ولا لأ»، زي ackescalate.restaurantClosed) */
export const hoursCfgOf = (settings) => { const hours = settings && settings.hours; return { enabled: true, stopBeforeCloseMin: 0, hours, active: hoursKnown(hours) }; };
/* مقفول بمواعيده؟ المواعيد مش متعرّفة ⇒ false (مانسجّلش على الأعمى) */
export function closedNow(now, settings) { const c = hoursCfgOf(settings); return c.active ? isRestaurantOpenAt(now, c) === false : false; }
/* ⇒ { ok, openAt, dueAt } أو { ok:false, reason[, openAt, dueAt] } — reason: hours_unknown | open_now | no_opening | window_would_close */
export function openingPlan({ now, settings, lastInMs, delayMin = OF_DEFAULTS.openFollowUpDelayMin }) {
  const c = hoursCfgOf(settings);
  if (!c.active) return { ok: false, reason: "hours_unknown" };
  const t = now instanceof Date ? now : new Date(now);
  if (isRestaurantOpenAt(t, c)) return { ok: false, reason: "open_now" };
  const open = nextSendOpenAt(t, c, { stepMin: 5, maxDays: 8 });
  if (!open) return { ok: false, reason: "no_opening" };
  const openAt = open.toISOString(), dueAt = new Date(open.getTime() + Math.max(0, Number(delayMin) || 0) * 60_000).toISOString();
  const li = Number.isFinite(Number(lastInMs)) ? Number(lastInMs) : t.getTime();
  if (Date.parse(dueAt) >= li + WINDOW_MIN * 60_000) return { ok: false, reason: "window_would_close", openAt, dueAt };
  return { ok: true, openAt, dueAt };
}

/* ── السلة ───────────────────────────────────────────────────────────────────── */
const cleanInput = (x) => {
  if (!x || typeof x !== "object") return null;
  const items = (Array.isArray(x.items) ? x.items : []).filter((i) => i && i.id != null).slice(0, 40).map((i) => ({ id: String(i.id), qty: i.qty, ...(i.note ? { note: String(i.note).slice(0, 100) } : {}), ...(i.variant_option_id != null ? { variant_option_id: i.variant_option_id } : {}) }));
  const boxes = (Array.isArray(x.boxes) ? x.boxes : []).filter((b) => b && b.slug).slice(0, 10);
  return items.length || boxes.length ? { items, ...(boxes.length ? { boxes: JSON.parse(JSON.stringify(boxes)) } : {}) } : null;
};
const lineOf = (l) => ({ name: String(l.name || ""), ...(l.name_en ? { name_en: String(l.name_en) } : {}), qty: Math.max(1, Math.round(Number(l.qty) || 1)), ...(l.weight ? { weight: String(l.weight) } : {}), ...(l.weight_en ? { weight_en: String(l.weight_en) } : {}) });
/* صورة السلة وقت الرد: الرابط (لو اتعمل) أو آخر معاينة في الجلسة — والمدخلات اللي تتسعّر بيها تاني (آخر build_cart نجح في الدور، أو lastInput بتاع الجلسة).
   ⇒ { code?, subtotal, lines, input } أو null */
export function cartSnapshotOf({ cart = null, state = null, trace = null } = {}) {
  const st = state && typeof state === "object" ? state : {};
  const built = ((trace && trace.tools) || []).filter((x) => x && x.name === "build_cart" && x.result && x.result.ok && x.result.saved).pop();
  if (cart && cart.code) {
    const input = cleanInput(built ? built.input : st.lastInput);
    return { code: String(cart.code), subtotal: Number(cart.subtotal) || 0, lines: (cart.lines || []).map(lineOf), input };
  }
  const now = st.cartNow, input = cleanInput(st.lastInput);
  if (now && Array.isArray(now.lines) && now.lines.length && input) return { subtotal: Number(now.subtotal) || 0, lines: now.lines.map(lineOf), input };
  return null;
}
const money = (n) => { const x = Math.round(Number(n) * 100) / 100; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""); };
/* «وجبة نصف دجاجة على الفحم + بطاطس محمرة» — الكمية قبل الاسم لو أكتر من واحد، والوزن بين قوسين */
export function cartLine(lines = [], lang = "ar") {
  const en = lang === "en";
  return (Array.isArray(lines) ? lines : []).map((l) => {
    const nm = (en && l.name_en) || l.name, w = (en && l.weight_en) || l.weight, q = Math.max(1, Math.round(Number(l.qty) || 1));
    return `${q > 1 ? `${q} × ` : ""}${nm}${w ? ` (${w})` : ""}`;
  }).filter((s) => s.trim()).join(" + ");
}

/* ── الـSQL (كل جملة بعلامة /*of:…*\/ في أولها: للتشخيص وللاختبارات) ──────────────── */
export const OF_SQL = Object.freeze({
  /* شغلة تانية مستنية لنفس الرقم بفتح تاني ⇒ تتلغي (الأحدث بس) */
  replace: `/*of:replace*/ UPDATE wa_bot_jobs SET status='cancelled', reason='replaced', done_at=NOW() WHERE phone_norm=$1 AND kind='${OF_KIND}' AND status='pending' AND wamid <> $2`,
  replaceLedger: "/*of:replace_ledger*/ UPDATE wa_open_followups SET status='skipped', reason='replaced', updated_at=NOW() WHERE phone_norm=$1 AND status='pending' AND job_key <> $2",
  /* الشغلة: جديدة، أو تحديث صورة السلة لو لسه مستنية */
  upsertJob: `/*of:upsert_job*/ INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,'${OF_KIND}',$3,$4,NULL)
     ON CONFLICT (wamid) DO UPDATE SET ev = EXCLUDED.ev, due_at = EXCLUDED.due_at WHERE wa_bot_jobs.status = 'pending' RETURNING id`,
  /* الدفتر: صف لكل شغلة (pending ⇒ sending ⇒ sent | failed، أو skipped بسببه) */
  ledgerPlan: `/*of:ledger_plan*/ INSERT INTO wa_open_followups(job_key, phone_norm, msg_at, open_at, due_at, cart, lang, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (job_key) DO UPDATE SET msg_at = EXCLUDED.msg_at, due_at = EXCLUDED.due_at, cart = EXCLUDED.cart, lang = EXCLUDED.lang, status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = NOW()
      WHERE wa_open_followups.status IN ('pending','skipped')`,
  skip: `/*of:skip*/ INSERT INTO wa_open_followups(job_key, phone_norm, status, reason) VALUES ($1,$2,'skipped',$3)
     ON CONFLICT (job_key) DO UPDATE SET status = 'skipped', reason = $3, updated_at = NOW() WHERE wa_open_followups.status IN ('pending','skipped')`,
  /* الحجز قبل الإرسال: بيرجّع صف بس لو إحنا اللي حجزنا (الشغلة لسه pending في الدفتر أو مالهاش صف) */
  reserve: `/*of:reserve*/ INSERT INTO wa_open_followups(job_key, phone_norm, status, via) VALUES ($1,$2,'sending',$3)
     ON CONFLICT (job_key) DO UPDATE SET status = 'sending', via = $3, updated_at = NOW() WHERE wa_open_followups.status = 'pending' RETURNING id`,
  unreserve: "/*of:unreserve*/ UPDATE wa_open_followups SET status = 'pending', reason = $2, updated_at = NOW() WHERE job_key = $1 AND status = 'sending'",
  mark: "/*of:mark*/ UPDATE wa_open_followups SET status = $2, wamid = $3, error = $4, text = $5, cart_code = $6, total = $7, sent_at = NOW(), updated_at = NOW() WHERE job_key = $1",
  /* اتبعتله «نكمّل لما نفتح» بعد الرسالة دي ($2) */
  sentSince: "/*of:sent_since*/ SELECT 1 FROM wa_open_followups WHERE phone_norm = $1 AND status IN ('sending','sent') AND job_key <> $3 AND updated_at > $2::timestamptz LIMIT 1",
  /* متابعة تانية من أي نوع اتبعتت بعد الرسالة دي ($2) — $3 = الأنواع */
  othersSince: "/*of:others_since*/ SELECT 1 FROM wa_bot_jobs WHERE phone_norm = $1 AND kind = ANY($3::text[]) AND status = 'done' AND done_at > $2::timestamptz LIMIT 1",
  hold: "/*of:hold*/ SELECT 1 FROM wa_chat_holds WHERE phone_norm = $1 AND state = 'held' LIMIT 1",
  dayCount: "/*of:day_count*/ SELECT count(*)::int AS n FROM wa_open_followups WHERE status IN ('sending','sent') AND sent_at >= $1::timestamptz",
  cartOk: FU_SQL.cartOk,
  ordered: FU_SQL.ordered,
  optedOut: FU_SQL.optedOut,
  ignored: FU_SQL.ignored,
  /* للوحة: آخر N يوم — الحالة والسبب */
  stats: `/*of:stats*/ SELECT status, COALESCE(split_part(reason, ':', 1), '') AS reason, count(*)::int AS n FROM wa_open_followups WHERE created_at > NOW() - make_interval(days => $1::int) GROUP BY 1, 2 ORDER BY 3 DESC`,
  recent: `/*of:recent*/ SELECT job_key, phone_norm, msg_at, open_at, due_at, status, reason, via, total, cart_code, text, sent_at, created_at FROM wa_open_followups ORDER BY created_at DESC LIMIT $1`,
});
export const OF_DDL = `
  CREATE TABLE IF NOT EXISTS wa_open_followups (
    id BIGSERIAL PRIMARY KEY,
    job_key TEXT UNIQUE NOT NULL,          -- of:<الرقم>:<وقت الفتح> — نفس wa_bot_jobs.wamid
    phone_norm TEXT NOT NULL,
    msg_at TIMESTAMPTZ, open_at TIMESTAMPTZ, due_at TIMESTAMPTZ,
    cart JSONB, lang TEXT,
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | sending | sent | failed | skipped
    reason TEXT, via TEXT,                 -- via: cart | link | plain
    wamid TEXT, error TEXT, text TEXT, cart_code TEXT, total NUMERIC,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS wa_open_followups_phone_idx ON wa_open_followups(phone_norm, created_at DESC);
  CREATE INDEX IF NOT EXISTS wa_open_followups_sent_idx ON wa_open_followups(sent_at DESC);
`;

/* ── التشغيل ─────────────────────────────────────────────────────────────────────
   deps (من wabotrun): q, jb, store (assistStore), assist (أدوات المساعد: build_cart), sendOwnX, ownGate, brakeState, audience, complaintSql,
   text(cfg, key, lang, vars) ⇒ نص من «النصوص»، modeButtons(cfg, lang), disclosure(cfg, lang, settings), newSession(now), STORE */
export function makeOpenFollowUp(deps) {
  const { q, jb = (v) => JSON.stringify(v), STORE = "https://freshcuts.sa" } = deps;
  const isoOf = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  const turn = (phone, outcome, text, lang, cartCode = null) => (deps.store ? deps.store.addTurn({ phone, sessionId: null, handledBy: outcome === "open_followup_sent" ? "assistant" : "system", outcome, masked: null, text, lang, trace: {}, cartCode }).catch?.(() => null) : null);

  /* رد المساعد اتبعت ⇒ نسجّل ولا لأ. ⇒ { ok, key?, dueAt?, reason? } (عمرها ما بترمي) */
  async function record({ phone, settings, cfg, now, msgAt = null, snapshot = null, intent = false, lang = "ar" }) {
    try {
      if (!cfg || !cfg.openFollowUp) return { ok: false, reason: "off" };
      if (!/^5\d{8}$/.test(String(phone || ""))) return { ok: false, reason: "bad_phone" };
      if (!snapshot && !(intent && cfg.openFollowUpPlain)) return { ok: false, reason: "no_order_intent" };
      if (!closedNow(now, settings)) return { ok: false, reason: "open_now" };
      const mt = Date.parse(msgAt || ""), li = Number.isFinite(mt) && mt <= now.getTime() ? mt : now.getTime();
      const plan = openingPlan({ now, settings, lastInMs: li, delayMin: cfg.openFollowUpDelayMin });
      const L = lang === "en" ? "en" : "ar";
      if (!plan.ok) {
        if (plan.reason === "window_would_close") {
          const key = `of:${phone}:${Date.parse(plan.openAt)}`;
          await q(OF_SQL.ledgerPlan, [key, phone, new Date(li).toISOString(), plan.openAt, plan.dueAt, snapshot ? jb(snapshot) : null, L, "skipped", "window_would_close"]);
          await turn(phone, "open_followup_skip:window_would_close", null, L);
        }
        return { ok: false, reason: plan.reason };
      }
      const key = `of:${phone}:${Date.parse(plan.openAt)}`;
      await q(OF_SQL.replace, [phone, key]); await q(OF_SQL.replaceLedger, [phone, key]);
      const ev = { at: now.toISOString(), msgAt: new Date(li).toISOString(), openAt: plan.openAt, cart: snapshot, intent: Boolean(intent), lang: L };
      const r = await q(OF_SQL.upsertJob, [key, phone, plan.dueAt, jb(ev)]);
      if (r === null) return { ok: false, reason: "db" };
      if (!r.length) return { ok: false, reason: "already_done", key };      // نفس الفتح واتعالجت قبل كده (اتبعتت / اتلغت)
      await q(OF_SQL.ledgerPlan, [key, phone, ev.msgAt, plan.openAt, plan.dueAt, snapshot ? jb(snapshot) : null, L, "pending", null]);
      return { ok: true, key, dueAt: plan.dueAt };
    } catch (e) { (deps.log || console.error)("[openfu] record:", e.message); return { ok: false, reason: "exception" }; }
  }

  /* المحتوى بسعر الحين ⇒ { via, body, extra, total, code } أو { none: reason } */
  async function content({ phone, cfg, ev, L }) {
    const plain = () => (cfg.openFollowUpPlain ? { via: "plain", body: deps.text(cfg, "open_fu_plain", L, {}), extra: {} } : null);
    const c = ev.cart;
    if (!c) return plain() || { none: "no_cart" };
    let live = null;
    if (c.input && deps.assist) { try { live = await deps.assist.build_cart(phone, { ...c.input, option: "delivery" }, { save: false }); } catch { live = null; } }
    if (!live || !live.ok || (live.problems || []).length || !(live.lines || []).length) {
      const why = live && live.ok ? `cart_changed:${String(((live.problems || [])[0] || {}).error || "lines")}` : `cart_unpriced:${String((live && (live.error || live.what)) || "no_input")}`;
      const p = plain(); return p ? { ...p, ref: why } : { none: why };
    }
    const vars = { cart: cartLine(live.lines.map(lineOf), L), total: money(live.subtotal) };
    if (c.code) {
      const ok = await q(OF_SQL.cartOk, [String(c.code), phone]);
      if (ok && ok.length) return { via: "link", body: deps.text(cfg, "open_fu_link", L, vars), extra: { cta: { title: deps.text(cfg, "cta_reorder", L, {}), url: `${STORE}/c/${c.code}` } }, total: live.subtotal, code: String(c.code), lines: live.lines };
    }
    return { via: "cart", body: deps.text(cfg, "open_fu_cart", L, vars), extra: deps.modeButtons(cfg, L), total: live.subtotal, lines: live.lines };
  }

  /* الشغلة. end(status, reason) = نفس دالة runDueJobs. ⇒ نتيجة end */
  async function run(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), key = String(j.wamid || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const L = ev.lang === "en" ? "en" : "ar";
    const skip = async (reason) => { await q(OF_SQL.skip, [key, phone, String(reason).slice(0, 80)]); await turn(phone, `open_followup_skip:${String(reason).slice(0, 60)}`, null, L); return end("cancelled", String(reason).slice(0, 80)); };
    const lastInMs = Date.parse(ev.msgAt || ev.at || "");
    if (!Number.isFinite(lastInMs) || !ev.at) return skip("bad_job");
    const windowEnd = lastInMs + WINDOW_MIN * 60_000;
    const later = async (atMs, reason) => {
      if (!(atMs < windowEnd)) return skip(`window_would_close:${reason}`);
      await q(FU_SQL.defer, [j.id, new Date(Math.max(atMs, now.getTime() + 1000)).toISOString(), `wait:${reason}`]);
      return "deferred";
    };
    if (!cfg.openFollowUp) return skip("off");
    if (!(cfg.openFollowUpDailyCap > 0)) return skip("cap_zero");
    if (deps.audience) { const a = await deps.audience({ cfg, phone, chat: {}, now, hasReferral: false, count: false }); if (!a || !a.on) return skip(a && a.why === "assist_off" ? "assist_off" : "not_in_audience"); }
    const br = await deps.brakeState();
    if (br === null) return skip("brake_check_failed"); if (br.on) return skip("braked");
    /* +١ مللي: ev.at متقطّع للمللي (Postgres بالميكرو) — رسالتنا نفسها مش «العميل كتب» */
    const [why, m, chat, op] = await deps.ownGate(phone, settings, cfg, now, new Date(Date.parse(ev.at) + 1).toISOString());
    if (why) return skip(why);      // الوضع، أرقام التجربة، «مايتردّش عليه» (موظف/مندوب/تنبيهات)، النافذة قفلت، «إيقاف»، مكتوم
    if (Number(m.wrote) > 0) return skip("customer_wrote");
    if (Number(m.staff) > 0) return skip("staff_in_chat");
    if (op.marketing_off_at) return skip("stopped");
    const oo = await q(OF_SQL.optedOut, [phone]);
    if (oo === null) return skip("optout_check_failed"); if (oo.length) return skip("opted_out");
    const hd = await q(OF_SQL.hold, [phone]);
    if (hd === null) return skip("hold_check_failed"); if (hd.length) return skip("staff_hold");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return skip("handover_open");
    if (chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000) return skip("declined");
    const cmp = await q(deps.complaintSql, [phone]);
    if (cmp === null) return skip("complaint_check_failed"); if (cmp.length) return skip("complaint_today");
    const ord = await q(OF_SQL.ordered, [phone, ev.msgAt]);
    if (ord === null) return skip("order_check_failed"); if (ord.length) return skip("ordered");
    const ss = await q(OF_SQL.sentSince, [phone, ev.msgAt, key]);
    if (ss === null) return skip("sent_check_failed"); if (ss.length) return skip("already_sent");
    const os = await q(OF_SQL.othersSince, [phone, ev.at, [...FU_OTHER_JOBS, "reply_followup"]]);
    if (os === null) return skip("others_check_failed"); if (os.length) return skip("window_used");
    const ig = await q(OF_SQL.ignored, [phone, [...FU_PROACTIVE_KEYS], Math.ceil(cfg.replyFollowUpIgnoredDays)]);
    if (ig === null || !ig[0]) return skip("ignored_check_failed"); if (Number(ig[0].n) >= cfg.replyFollowUpIgnoredMax) return skip("ignored");
    const hc = hoursCfgOf(settings);
    if (!hc.active) return skip("hours_unknown");
    if (isRestaurantOpenAt(now, hc) !== true) {      // اتأجّل الفتح (المالك غيّر المواعيد / يوم مقفول) ⇒ الفتح الجاي، طول ما النافذة هتفضل مفتوحة
      const nx = nextSendOpenAt(now, hc, { stepMin: 5, maxDays: 2 });
      return nx ? later(nx.getTime() + cfg.openFollowUpDelayMin * 60_000, "closed") : skip("no_opening");
    }
    const dc = await q(OF_SQL.dayCount, [bizDayStart(now).toISOString()]);
    if (dc === null || !dc[0]) return skip("cap_check_failed"); if (Number(dc[0].n) >= cfg.openFollowUpDailyCap) return skip("daily_cap");
    let pick;
    try { pick = await content({ phone, cfg, ev, L }); } catch (e) { (deps.log || console.error)("[openfu] content:", e.message); return skip("text_invalid"); }
    if (!pick || pick.none) return skip(pick && pick.none ? pick.none : "no_content");
    let body = pick.body, disclosed = false;
    if (deps.disclosure && (!chat.last_disclosed_at || now.getTime() - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000)) { try { body = `${deps.disclosure(cfg, L, settings)}\n${body}`; disclosed = true; } catch { /* من غير التعريف */ } }
    const rs = await q(OF_SQL.reserve, [key, phone, pick.via]);
    if (rs === null) return skip("reserve_failed");
    if (!rs.length) return end("cancelled", "already_reserved");      // حاوية تانية حجزت / اتبعتت قبل كده — مانلمسش الدفتر
    const sx = await deps.sendOwnX(phone, cfg, now, { body, ...pick.extra }, L, OF_KIND, `${pick.via}${pick.ref ? `:${pick.ref}` : ""}`);
    if (sx.until) { await q(OF_SQL.unreserve, [key, "burst_hold"]); return later(Date.parse(isoOf(sx.until)), "burst_hold"); }      // CJ1a: هدوء بعد آخر رسالة ⇒ تأجيل مش إلغاء
    await q(OF_SQL.mark, [key, sx.err ? "failed" : "sent", sx.wamid || null, sx.err ? String(sx.err).slice(0, 120) : null, sx.err ? null : body, pick.code || null, pick.total ?? null]);
    if (sx.err) { await turn(phone, `open_followup_failed:${String(sx.err).slice(0, 50)}`, null, L); return end("cancelled", `send_failed:${sx.err}`.slice(0, 80)); }
    if (disclosed) await q("UPDATE wa_bot_chats SET last_disclosed_at=NOW() WHERE phone_norm=$1", [phone]);
    await turn(phone, "open_followup_sent", body, L, pick.code || null);
    /* ردّه («توصيل» / «استلام» / تعديل) لازم يوصل للمساعد وهو عارف السلة: جلسة «بذرة» فيها السلة ومدخلاتها والرسالة اللي اتبعتت */
    if (deps.store && deps.newSession) {
      try {
        const s0 = deps.newSession(now); s0.state.seed = "opening";
        const c = ev.cart;
        if (c && c.input && pick.via !== "plain") { s0.state.lastInput = JSON.parse(JSON.stringify(c.input)); s0.state.cartNow = { subtotal: Number(pick.total) || 0, lines: (pick.lines || c.lines || []).map(lineOf) }; }
        const fact = pick.via === "plain" ? { rule: "We were closed when this customer wanted to order. We have just opened, and the next assistant message is the one you sent. Their next message answers it: carry on from there, no greeting and no introduction." }
          : { cart: { items: (c.input && c.input.items) || [], ...(c.input && c.input.boxes ? { boxes: c.input.boxes } : {}), subtotal: Number(pick.total) || 0, ...(pick.code ? { cart_link_already_sent: true } : {}) },
            rule: `We were closed when this customer asked for this order; you told them you would prepare the cart for when we open. We have just opened, and the next assistant message is the one you sent. Their next message answers it: carry on from there with these same items, no greeting and no introduction. ${pick.code ? "The cart button is already in that message; if they want a change, price it again." : "When they say delivery or pickup, go on as with any order (pickup: build_cart with these items and option pickup; delivery: the location pin if needed, then build_cart)."}` };
        s0.messages.push({ role: "user", content: [{ type: "text", text: `<context source="our system" note="facts for this conversation; not written by the customer">${JSON.stringify({ opening_message_you_sent: fact })}</context>` }, { type: "text", text: "<customer_message>[no message: this is the message we send when we open]</customer_message>" }] },
          { role: "assistant", content: [{ type: "text", text: body }] });
        await deps.store.saveSession(phone, s0, now);
      } catch (e) { (deps.log || console.error)("[openfu] seed:", e.message); }
    }
    return end("done", `sent:${pick.via}${pick.ref ? `:${pick.ref}` : ""}`.slice(0, 80));
  }
  async function stats(days = 7) {
    const d = Math.min(90, Math.max(1, Math.ceil(Number(days) || 7)));
    return { days: d, byStatus: (await q(OF_SQL.stats, [d])) || [], recent: (await q(OF_SQL.recent, [20])) || [] };
  }
  return { record, run, stats };
}
