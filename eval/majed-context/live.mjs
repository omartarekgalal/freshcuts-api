/* ═══════════════════════════════════════════════════════════════════════════
   MJ1 (٢٢/١٠/٢٠٢٦) — تقييم «فهم المحادثة» على الموديل الحقيقي (اختياري، بيصرف فلوس، عمره ما بيكلّم عميل).
     node eval/majed-context/live.mjs --dry                 ⇒ يطبع اللي هيتبعت للموديل لكل حالة (من غير نداء ولا تكلفة)
     node eval/majed-context/live.mjs [--cap 3] [--ids a,b] [--routing escalate|strong|fast]
   كل حالة = لحظة حقيقية من محادثات ١٢–٢٢/١٠ (مقنّعة): اللي اتقال في المحادثة قبلها (سطور chat_since_your_last_reply زي ما wabotrun بيبعتها بالظبط،
   مبنية بـ wachat.chatBlock) + سياق الدور + رسالة العميل ⇒ دور واحد لماجد (waassistrun.runTurn بالأدوات الحقيقية على fixtures eval/world.mjs)
   ⇒ الحكم بقواعد ثابتة: لازم / ممنوع (regex)، تحويل ولا لأ. مفيش واتساب، مفيش قاعدة حيّة، مفيش API حي — النداء الوحيد للموديل.
   كل نداء بيتسجّل في eval/cost-log.jsonl، والتشغيل بيقف قبل النداء لو مصروف النهارده (من الملف) وصل --cap ر.س.
═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as AR from "../../waassistrun.js";
import { chatBlock } from "../../wachat.js";
import { costSar, normUsage, PRICE_DEFAULTS } from "../../waaicost.js";
import { makeWorld, PHONE } from "../world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry"), CAP = Number(arg("cap", "3")), IDS = arg("ids") ? arg("ids").split(",") : null;
const OVER = { routing: arg("routing", "escalate"), thinking: "adaptive", effort: "low", timeoutMs: 60000 };
const COST_LOG = path.join(HERE, "..", "cost-log.jsonl");
const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

const L = (who, min_ago, text) => ({ who, min_ago, text });
const ETA = "طلبك رقم [طلب] مع المندوب وفي الطريق إليك 🛵 ⏎ ⏱ يوصلك خلال 21~31 دقيقة · قبل 11:40 م";
/* الحالات: id, src (المحادثة الحقيقية)، world (eval/world.mjs)، chat (السطور)، ctx (مفاتيح سياق إضافية زي wabotrun)، text (رسالة العميل)، والحكم */
export const PROBES = [
  { id: "eta-0450", src: "…0450 ٢١/١٠ 23:17", world: { orders: [{ order_no: "W1792611609387", status: "on_the_way", option: "delivery", total: 104, created_at: "2026-10-12T14:40:00Z" }], eta: "طلبك في الطريق 🛵\n⏱ يوصلك خلال 21~31 دقيقة · قبل 11:40 م" },
    chat: [L("order_update", 9, ETA)], ctx: { customer_has_an_order_in_progress: { order_no: "W1792611609387", status: "on_the_way", rule: AR.CTX_RULES.activeOrder }, arrival_time_we_told: { said: "يوصلك خلال 21~31 دقيقة · قبل 11:40 م", sent_minutes_ago: 9, rule: AR.CTX_RULES.arrivalTold } }, text: "متى بيجيني الطلب تقريباً؟",      // «كم باقي ويوصل» نفسها بقت رد ثابت من الكود (eta_told) — دي الصيغة اللي بتروح لماجد
    must: ["21~31|11:40"], mustNot: ["ما عندي وقت|ما اقدر احدد|ما أقدر أحدد"], noHandover: true },
  { id: "staff-said-6545", src: "…6545 ١٣/١٠ 13:50", chat: [L("staff", 18, "بتيجى ⏎ واحده ريشه . اتنين اوصال ..اتنين كفته لحم ... حبه طرب"), L("staff", 15, "لو تحتاج كميه اكتر ممكن نص كيلو"), L("staff", 14, "النص ك 78")],
    text: "بهذا المبلغ كم سيخ سوف احصل عليه !!", mustNot: ["ما عندي معلومة|اكتب «?موظف»?"], noHandover: true },
  { id: "out-of-zone-6390", src: "…6390 ١٥/١٠ 22:56", chat: [L("customer", 1, "موقعكم مايوصل للسامر"), L("our_bot", 1, "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.")], world: { profile: "returning" },
    text: ".", mustNot: ["آخر طلب لك|نفس الطلب"], must: ["السامر|موقعك|الموقع|نوصل"] },
  { id: "ad-prefill-9131", src: "…9131 ٢٠/١٠ 02:53", ctx: { ad_button_text: { rule: AR.CTX_RULES.adButton } }, text: "مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟",
    must: ["ر\\.س"], mustNot: ["وش تقصد|ماذا تقصد|تقصد بـ"], noHandover: true },
  { id: "ad-prefill-en-3466", src: "…3466 ١٩/١٠ 09:42", ctx: { ad_button_text: { rule: AR.CTX_RULES.adButton } }, text: "Hello! Can I get more info on this?",
    must: ["[؀-ۿ]{3,} [؀-ۿ]{3,}"], mustNot: ["which dish|what do you mean|Which one do you mean"], noHandover: true },
  { id: "merged-5960", src: "…5960 ٢٠/١٠ 14:52", chat: [L("customer", 0, "تخفه")], text: "بجد\nكريب", must: ["كريب"], mustNot: ["وش تقصد|مو واضح"] },
  { id: "paid-online-0356", src: "…0356 ١٨/١٠ 18:36", world: { orders: [{ order_no: "W1792337498583", status: "accepted", option: "delivery", total: 130, created_at: "2026-10-12T14:55:00Z", items: [{ name: "مشكل مخصوص بالوزن", qty: 1 }] }] },
    chat: [L("order_update", 3, "أهلاً، استلمنا طلبك رقم [طلب] وتم الدفع بنجاح ✅ ⏎ الإجمالي: 130 ر.س")], ctx: { customer_has_an_order_in_progress: { order_no: "W1792337498583", status: "accepted", rule: AR.CTX_RULES.activeOrder } },
    text: "الطلب جاي معاه إضافات رز أو سلطات", mustNot: ["كيف تطلب|من موقعنا|لكم شخص"] },
  { id: "complaint-2488", src: "…2488 ١٩/١٠ 09:12", chat: [L("our_bot", 1, "شكراً، وصلت ملاحظتك ✅ ويتواصل معك المدير في أقرب وقت."), L("customer", 1, "شكرا علي اهتمامك بالرد ..واهتمامك  بالعملاء")], world: { profile: "returning" },
    ctx: { complaint_open: { rule: "This customer has an open complaint or low rating with the manager today: no selling of any kind unless they ask to order themselves (then help normally). Be kind and short." } },
    text: "ربي يبارك فيكم ويصلح حالكم", mustNot: ["نفس طلبك|نفس الطلب|أجهّز لك|اجهز لك|تبين تطلبين"] },
  { id: "campaign-0494", src: "…0494 ١٨/١٠ 01:04", chat: [L("campaign", 3 * 1440 + 380, "جديد من فريش كاتس 👋 بوكس فيه طبقك المفضل: بوكس الكريب لشخصين (كريب ميكس دجاج وكريب ثاني من اختيارك مع تشيز فرايز وصنف جانبي ومشروبين) بـ65 ر.س")],
    text: "محتاج أطلب العرض", must: ["الكريب لشخصين"], mustNot: ["ما عندنا عرض|ما عندنا عروض"] },
  { id: "answered-question-7271", src: "…7271 ١٧/١٠ 22:30", world: { orders: [{ order_no: "W1792250000001", status: "accepted", option: "delivery", total: 70, created_at: "2026-10-12T14:50:00Z" }] },
    chat: [L("customer", 2, "[location pin]"), L("our_bot", 2, "وصلتنا ملاحظتك على طلبك رقم [طلب] ✅ وبلّغنا المطبخ.")], text: "ده الموقع مظبوط", mustNot: ["فرعنا|حي السلامة|دوار رامي"] },
  { id: "staff-ready-1838", src: "…1838 ١٤/١٠ 16:45", chat: [L("staff", 6, "الاوردر جاهز ي فندم")], world: { profile: "returning" }, text: "تمام شكرا يابشمهندس", mustNot: ["نفس الطلب|آخر طلب لك|تبي نجهّز|وش تحب تطلب"] },
];

if (!fs.existsSync(COST_LOG)) fs.writeFileSync(COST_LOG, "");
let spentToday = 0;
for (const l of fs.readFileSync(COST_LOG, "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.day === today) spentToday += Number(j.sar) || 0; } catch { /* skip */ } }
let caller = null;
if (!DRY) { const { litellmKey } = await import("../_key.mjs"); caller = AR.makeModelCaller({ env: { LITELLM_KEY: litellmKey(), LITELLM_BASE: "https://llm.o2m8.me/v1" } }); }
let spentRun = 0, capped = false;
const list = PROBES.filter((p) => !IDS || IDS.includes(p.id));
console.log(`MJ1 live eval: ${list.length} probes · ${DRY ? "DRY (no model call)" : `cap ${CAP} SAR, spent today ${spentToday.toFixed(3)}`}`);
const results = [];
for (const p of list) {
  const callModel = async (a) => { if (DRY) return { ok: false, error: "dry", ms: 0, provider: null, usage: null }; if (spentToday + spentRun >= CAP) { capped = true; return { ok: false, error: "eval_cap", ms: 0, provider: null, usage: null }; } return caller(a); };
  const onCall = async (m) => { const u = m.usage ? normUsage(m.usage, "anthropic") : { in: 0, out: 0, cached: 0 }; const c = costSar(u, m.model, PRICE_DEFAULTS); spentRun += c.sar;
    fs.appendFileSync(COST_LOG, JSON.stringify({ at: new Date().toISOString(), day: today, run: "mj1-live", scenario: p.id, model: String(m.model).split("/").pop(), in: u.in, out: u.out, cached: u.cached, sar: c.sar, ms: m.ms, outcome: m.outcome }) + "\n");
    return { costSar: c.sar, ...u }; };
  const W = makeWorld(p.world || {}, { callModel, onCall, acfg: OVER });
  const hours = await W.tools.get_hours();
  const prof = await W.tools.customer_profile(PHONE);
  const context = { ...AR.buildContext({ first: true, hours: hours && hours.ok ? hours : null, profile: prof && prof.ok ? prof.profile : null, persona: { name: W.cfg.assist.personaName, name_en: W.cfg.assist.personaNameEn } }), ...(p.ctx || {}) };
  const chat = p.chat && p.chat.length ? chatBlock(p.chat) : null;
  if (DRY) { console.log(`\n── ${p.id} (${p.src})\n${chat || "(no chat lines)"}\ncontext keys: ${Object.keys(context).join(", ")}\ncustomer: ${p.text}`); continue; }
  const r = await W.loop.runTurn({ phone: PHONE, text: p.text, lang: "ar", session: AR.newSession(W.now()), acfg: W.acfg, context, profile: prof && prof.ok ? prof.profile : null, chat });
  const reply = r.ok ? String(r.text || "") : "", fails = [];
  if (!r.ok) fails.push(`no reply (${r.reason}: ${((r.trace && r.trace.verdicts) || []).map((v) => `${(v.problems || []).map((x) => `${x.type}:${x.value}`).join(",")} «${String(v.text || "").replace(/\s+/g, " ").slice(0, 160)}»`).join(" | ")})`);
  for (const m of p.must || []) if (r.ok && !r.handover && !new RegExp(m).test(reply)) fails.push(`missing /${m}/`);
  for (const m of p.mustNot || []) if (new RegExp(m).test(reply)) fails.push(`has /${m}/`);
  if (p.noHandover && r.handover) fails.push(`handover ${r.handover.reason}`);
  results.push({ id: p.id, src: p.src, pass: fails.length === 0, fails, reply, handover: r.handover || null, costSar: r.trace ? r.trace.costSar : 0 });
  console.log(`${fails.length ? "FAIL" : "PASS"}  ${p.id.padEnd(24)} ${fails.join("; ")}\n      ${reply.replace(/\n/g, " ⏎ ").slice(0, 220)}`);
  if (capped) { console.log("cap reached — stopping"); break; }
}
if (!DRY) {
  const out = path.join(HERE, "..", "out", `mj1-live-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((x) => x.pass).length}/${results.length} pass · ${spentRun.toFixed(3)} SAR · ${out}`);
}
