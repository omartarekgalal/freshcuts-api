/* ═══════════════════════════════════════════════════════════════════════════
   wamajed.js — «تقرير ماجد» اليومي للمالك (PK1 — ١٤/١٠/٢٠٢٦) — صافي: من غير قاعدة بيانات ولا موديل ولا إرسال.

   يوم ١٣/١٠: ٣٢ محادثة، ٨٥ رد من المساعد، ولا سلة. المالك شاف المحادثات بنفسه عشان يعرف ليه. التقرير ده بيقولها كل يوم:
     المحادثات ⇒ السلال ⇒ الطلبات المدفوعة · الأسئلة اللي ماعرفش يجاوبها (مجمّعة بعددها، وحالتها في طابور المدير) ·
     العملاء وقفوا فين (آخر سطر كتبه العميل قبل السكوت والرد اللي اتقال له) · التكلفة · أسوأ ٥ ردود بأسبابها.
   اليوم = يوم الشغل (من ٤ الفجر لـ٤ الفجر بتوقيت الرياض). مفيش رقم جوال في الناتج: المحادثة بتتعرّف بـchat_hash.
═══════════════════════════════════════════════════════════════════════════ */
import { kbTokens, kbSame } from "./wakb.js";
import { NON_ANSWER_RE, WEAK_CLOSE_RE } from "./waassistrun.js";

const RIYADH = 3 * 3600_000, CUT_H = 4;
/* day = "YYYY-MM-DD" (يوم الشغل) ⇒ { from, to } بالـISO. من غير day: يوم الشغل اللي فات. */
export function businessDay(day, now = new Date()) {
  let d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? String(day) : null;
  if (!d) { const loc = new Date(now.getTime() + RIYADH - CUT_H * 3600_000 - 86400_000); d = loc.toISOString().slice(0, 10); }
  const from = Date.parse(`${d}T00:00:00Z`) - RIYADH + CUT_H * 3600_000;
  return { day: d, from: new Date(from).toISOString(), to: new Date(from + 86400_000).toISOString() };
}
const NEGATIVE_RE = /تعبت|غالي|غاليه|عالي|عاليه|خلاص|ولا واحد|ما فهمت|مو واضح|مش واضح|زهقت|طولت|too expensive|never mind/i;
const ASKED_STAFF_RE = /موظف|مدير|انسان|إنسان|بشري|(?:اكلم|أكلم|كلمني|كلموني|ابي|ابغى|أبي|أبغى) (?:شخص|احد|أحد|واحد)|staff|human|agent|manager/i;      // «يكفي كام شخص» مش طلب موظف
const THANKS_RE = /^(?:شكرا|شكراً|شكرن|مشكور|يعطيك العافيه|يعطيك العافية|thanks|thank you)[\s\S]{0,20}$/i;
const REASON_AR = { non_answer: "قال «ما عندي معلومة / ما أقدر» بدل ما يجاوب", sent_to_staff: "حوّل العميل لـ«موظف» من غير ما يطلب", fallback: "المساعد ماردّش (بوت القواعد رد بداله)", left_after: "العميل اعترض أو مشي بعد الرد ده",
  weak_close: "قفل بـ«تحب أجهّز لك طلب؟» والعميل ماردّش", wrong_language: "رد بلغة غير لغة العميل", retried: "الرد اترفض من المراجِع مرة واتكتب تاني", long: "رد طويل", last_no_cart: "آخر رد في محادثة من غير سلة" };
const txt = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const arr = (v) => (Array.isArray(v) ? v : (() => { try { const j = JSON.parse(v || "[]"); return Array.isArray(j) ? j : []; } catch { return []; } })());
const round = (n, d = 2) => Math.round(Number(n) * 10 ** d) / 10 ** d;

/* turns = صفوف wa_assist_turns لليوم (بأي ترتيب) · orders = [{ phone_norm, total, link, created_at }] مدفوعة في نفس اليوم · kbRows = [{ id, status, question }].
   ⇒ التقرير (كائن JSON جاهز للوحة). */
export function buildMajedReport({ day = null, turns = [], orders = [], kbRows = [], worst = 5 } = {}) {
  const rows = [...turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.id) - Number(b.id));
  const chats = new Map();
  for (const t of rows) { const k = String(t.chat_hash || t.phone_norm || "?"); if (!chats.has(k)) chats.set(k, { hash: k, phone: t.phone_norm || null, turns: [] }); chats.get(k).turns.push(t); }
  const isReply = (t) => t.handled_by === "assistant" && (t.outcome === "sent" || /^handover:/.test(String(t.outcome || "")));
  const isCustomer = (t) => t.customer_masked != null && txt(t.customer_masked) !== "";
  const phonesOrdered = new Map();
  for (const o of orders) { const p = String(o.phone_norm || ""); if (!p) continue; const c = phonesOrdered.get(p) || { n: 0, total: 0, viaCart: 0 }; c.n += 1; c.total += Number(o.total) || 0; if (String(o.link || "") === "wa-assistant") c.viaCart += 1; phonesOrdered.set(p, c); }

  let customerMessages = 0, replies = 0, cost = 0, carts = new Set(), cartChats = 0, assistChats = 0, ordersN = 0, ordersSar = 0, ordersViaCart = 0, orderChats = 0, followups = 0;
  const unanswered = [], drops = [], scored = [], owners = {};
  for (const c of chats.values()) {
    const T = c.turns, custIdx = T.map((t, i) => (isCustomer(t) ? i : -1)).filter((i) => i >= 0);
    const chatCarts = new Set(T.map((t) => t.cart_code).filter(Boolean));
    for (const x of chatCarts) carts.add(x);
    if (chatCarts.size) cartChats += 1;
    if (T.some(isReply)) assistChats += 1;
    const ord = c.phone ? phonesOrdered.get(String(c.phone)) : null;
    if (ord) { orderChats += 1; ordersN += ord.n; ordersSar += ord.total; ordersViaCart += ord.viaCart; }
    for (let i = 0; i < T.length; i++) {
      const t = T[i]; cost += Number(t.cost_sar) || 0;
      if (/^(followup|nudge)_/.test(String(t.outcome || ""))) { followups += 1; continue; }
      if (isCustomer(t)) customerMessages += 1;
      const key = t.handled_by === "assistant" ? "assistant" : t.handled_by === "rules" ? "rules_after_assistant_failed" : "rules";
      owners[key] = (owners[key] || 0) + 1;
      if (!isCustomer(t)) continue;
      const reply = txt(t.final_text), q0 = txt(t.customer_masked), next = T.slice(i + 1).find(isCustomer) || null, lastOfChat = custIdx[custIdx.length - 1] === i;
      if (isReply(t)) replies += 1;
      const tools = arr(t.tool_calls), verdicts = arr(t.verdicts);
      const toolUnknown = tools.some((x) => x && x.result && (x.result.answer === "unknown" || x.result.error === "no_approved_answer" || x.result.found === false));
      const nonAnswer = (isReply(t) && NON_ANSWER_RE.test(reply)) || toolUnknown;
      const fallback = /^fallback:/.test(String(t.outcome || ""));
      const toStaff = t.outcome === "handover:needs_staff" || (isReply(t) && /اكتب «?موظف»?|type "?staff"?/i.test(reply) && !ASKED_STAFF_RE.test(q0));
      if ((nonAnswer || fallback || t.outcome === "handover:needs_staff") && !/^\[[^\]]*\]$/.test(q0) && !ASKED_STAFF_RE.test(q0)) unanswered.push({ question: q0, reply: reply.slice(0, 300) || null, why: fallback ? String(t.outcome) : nonAnswer ? "non_answer" : "handover", at: t.at });
      if (!isReply(t) && !fallback) continue;
      const reasons = []; let score = 0;
      const add = (k, n) => { reasons.push(k); score += n; };
      if (nonAnswer) add("non_answer", 4);
      if (fallback) add("fallback", 3);
      if (toStaff && !nonAnswer) add("sent_to_staff", 2);
      if (next && NEGATIVE_RE.test(txt(next.customer_masked))) add("left_after", 3);
      if (lastOfChat && !chatCarts.size && !ord && WEAK_CLOSE_RE.test(reply)) add("weak_close", 2);
      else if (lastOfChat && !chatCarts.size && !ord && !THANKS_RE.test(q0) && reasons.length) add("last_no_cart", 1);
      if (isReply(t) && !/[A-Za-z]{3,}/.test(q0.replace(/\[[^\]]*\]/g, "")) && /(?:[A-Za-z][A-Za-z'’-]*[\s,.;:!?()-]+){5,}/.test(reply)) add("wrong_language", 3);
      if (verdicts.length > 1) add("retried", 1);
      if ([...reply].length > 420) add("long", 1);
      if (score > 0) scored.push({ score, at: t.at, chat: c.hash, customer: q0, reply: reply.slice(0, 600) || null, outcome: t.outcome, reasons, reasons_ar: reasons.map((r) => REASON_AR[r] || r) });
    }
    /* وقف فين: محادثة من غير سلة ولا طلب ⇒ آخر سطر كتبه العميل + الرد اللي اتقال له (أو آخر رد قبله) */
    if (!chatCarts.size && !ord && custIdx.length) {
      const li = custIdx[custIdx.length - 1], last = T[li], q0 = txt(last.customer_masked);
      const answered = txt(last.final_text) ? last : [...T.slice(0, li)].reverse().find((t) => txt(t.final_text)) || null;
      drops.push({ chat: c.hash, at: last.at, customer_messages: custIdx.length, last_customer_line: q0, answered_by: last.handled_by, outcome: last.outcome || null, last_reply: answered ? txt(answered.final_text).slice(0, 400) : null,
        kind: THANKS_RE.test(q0) ? "thanked_and_left" : custIdx.length === 1 ? "one_message" : NEGATIVE_RE.test(q0) ? "objected" : "went_silent" });
    }
  }
  /* الأسئلة اللي من غير إجابة: نفس السؤال (نفس كلمات المعنى) في صف واحد بعدده */
  const groups = [];
  for (const u of unanswered) { const tk = kbTokens(u.question); if (!tk.size) continue;
    const g = groups.find((x) => kbSame(x.tokens, tk));
    if (g) { g.count += 1; if (g.examples.length < 3 && !g.examples.includes(u.question)) g.examples.push(u.question); g.last_at = u.at; }
    else groups.push({ tokens: tk, question: u.question, count: 1, examples: [u.question], reply: u.reply, why: u.why, last_at: u.at }); }
  for (const g of groups) { const hit = kbRows.find((r) => kbSame(g.tokens, kbTokens(r.question))); g.kb = hit ? { id: Number(hit.id), status: hit.status } : null; }
  groups.sort((a, b) => b.count - a.count || Date.parse(b.last_at) - Date.parse(a.last_at));
  /* نفس آخر سطر عند كذا عميل (سؤال الإعلان الجاهز) ⇒ سطر واحد بعدده */
  const dropLines = [];
  for (const d of drops) { const g = dropLines.find((x) => x.last_customer_line === d.last_customer_line && x.kind === d.kind); if (g) { g.count += 1; g.chats.push(d.chat); } else dropLines.push({ last_customer_line: d.last_customer_line, kind: d.kind, count: 1, chats: [d.chat], last_reply: d.last_reply, answered_by: d.answered_by }); }
  dropLines.sort((a, b) => b.count - a.count);
  scored.sort((a, b) => b.score - a.score || Date.parse(a.at) - Date.parse(b.at));
  const n = chats.size;
  return { day, chats: n, customer_messages: customerMessages, assistant_replies: replies, chats_with_assistant_reply: assistChats, followups_sent: followups, answered_by: owners,
    funnel: { chats: n, carts: carts.size, chats_with_cart: cartChats, paid_orders: ordersN, chats_with_paid_order: orderChats, paid_orders_through_cart_link: ordersViaCart, paid_revenue_sar: round(ordersSar),
      cart_rate: n ? round(cartChats / n, 3) : 0, order_rate: n ? round(orderChats / n, 3) : 0 },
    cost: { total_sar: round(cost, 4), per_chat_sar: n ? round(cost / n, 4) : 0, per_reply_sar: replies ? round(cost / replies, 4) : 0, per_paid_order_sar: ordersN ? round(cost / ordersN, 2) : null },
    unanswered: groups.map(({ tokens: _t, ...g }) => g),
    dropped: { chats: drops.length, by_kind: drops.reduce((a, d) => { a[d.kind] = (a[d.kind] || 0) + 1; return a; }, {}), lines: dropLines.slice(0, 40) },
    worst_replies: scored.slice(0, Math.max(1, worst)).map(({ score, ...x }) => ({ ...x, score })),
    notes: ["paid orders = paid website orders of the same day from numbers that chatted that day; «through cart link» = the order's link tag is wa-assistant", "no phone numbers: a chat is identified by its hash"] };
}
