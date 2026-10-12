/* Evaluation runner for the WhatsApp ordering assistant.
     node eval/run.mjs --set batch20 [--cap 12] [--routing escalate|strong|fast] [--thinking adaptive|off] [--effort low] [--par 3] [--name NAME] [--ids a,b]
   Spends real money on the model. Every model call is appended to eval/cost-log.jsonl; the run stops before a call when the
   total of TODAY's log lines has reached --cap (SAR). Nothing is sent to WhatsApp, nothing touches the live API or database. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as AR from "../waassistrun.js";
import * as R from "../wabotrun.js";
import { costSar, normUsage, PRICE_DEFAULTS } from "../waaicost.js";
import { litellmKey } from "./_key.mjs";
import { lookupFact } from "../wadishfacts.js";
import { makeWorld, PHONE } from "./world.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { gradeConversation, summarize } from "./grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SET = arg("set", "batch20"), CAP = Number(arg("cap", "12")), PAR = Number(arg("par", "3")), RUNCAP = Number(arg("runcap", "1000"));      // --cap = today's total; --runcap = this run alone
const OVER = { routing: arg("routing", "escalate"), thinking: arg("thinking", "adaptive"), effort: arg("effort", "low"), timeoutMs: 60000 };
const NAME = arg("name", `${SET}-${OVER.routing}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
const OUT = path.join(HERE, "out", NAME);
fs.mkdirSync(OUT, { recursive: true });
const COST_LOG = path.join(HERE, "cost-log.jsonl");
const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
let spentToday = 0;
if (fs.existsSync(COST_LOG)) for (const l of fs.readFileSync(COST_LOG, "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j.day === today) spentToday += Number(j.sar) || 0; } catch { /* skip */ } }
let spentRun = 0, capped = false;
const env = { LITELLM_KEY: litellmKey(), LITELLM_BASE: "https://llm.o2m8.me/v1" };
const rawCall = AR.makeModelCaller({ env });
const callModel = async (a) => { if (spentToday + spentRun >= CAP || spentRun >= RUNCAP) { capped = true; return { ok: false, error: "eval_cap", ms: 0, provider: null, usage: null }; } return rawCall(a); };

let ids = arg("ids") ? arg("ids").split(",") : null;
const list = SCENARIOS.filter((s) => (ids ? ids.includes(s.id) : SET === "all" ? true : (s.sets || []).includes(SET)));
console.log(`set=${SET} conversations=${list.length} routing=${OVER.routing} thinking=${OVER.thinking} cap=${CAP} SAR · already spent today ${spentToday.toFixed(3)} SAR`);

async function runOne(sc) {
  const calls = [];
  const onCall = async (m) => {
    const u = m.usage ? normUsage(m.usage, "anthropic") : { in: 0, out: 0, cached: 0 };
    const c = costSar(u, m.model, PRICE_DEFAULTS);
    spentRun += c.sar;
    const row = { at: new Date().toISOString(), day: today, run: NAME, scenario: sc.id, model: String(m.model).split("/").pop(), in: u.in, out: u.out, cached: u.cached, sar: c.sar, ms: m.ms, outcome: m.outcome, tier: m.detail };
    fs.appendFileSync(COST_LOG, JSON.stringify(row) + "\n"); calls.push(row);
    return { costSar: c.sar, ...u };
  };
  const W = makeWorld(sc.world || {}, { callModel, onCall, acfg: { ...OVER, ...(sc.acfg || {}) } });
  let session = null, handoverOpen = null, first = true;
  const turns = [];
  /* العميل المكتوب بيقفل زي عميل حقيقي: لو المساعد سأله سؤال (اقتراح) بعد آخر سطر في النص ولسه مفيش سلة، بيرد «لا شكراً، ارسل السلة». */
  const script = [...sc.turns];
  for (let i = 0; i < script.length; i++) { const t0 = script[i];
    if (capped) break;
    const t = typeof t0 === "string" ? { text: t0 } : t0;
    const ev = { phone: PHONE, text: t.text || "", type: t.type || (t.location ? "location" : "text"), interactiveId: t.tap || null, location: null };
    if (t.location) { W.state.loc = { lat: 21.58, lng: 39.16 }; W.world_loc = t.location; ev.location = { lat: 21.58, lng: 39.16 }; }
    const cls = R.classify(ev, W.know);
    const d = cls.key === "ack" || cls.key === "nack" ? { act: "silent", reason: "ack" } : cls.key === "unknown" ? { act: "wait", waitKind: "unknown_wait" } : cls.key ? { act: "reply", key: cls.key } : null;
    /* as in the bot since 12/10: an ordinary handover does not stop the assistant; a serious one does (the script has no clock, so it holds to the end) */
    const serious = ["allergy_severe", "complaint", "problem", "order_change"].includes(handoverOpen);
    const el = AR.assistEligible({ acfg: W.acfg, cfg: W.cfg, phone: PHONE, ev, cls, d, sessionActive: Boolean(session), handoverOpen: serious, recentOrder: Boolean((sc.world || {}).orders) });
    const rec = { i, customer: t.text || `[${ev.type}]`, cls: cls.key, raw: cls.rawIntent, by: null, reply: null, cart: null, handover: null, outcome: null, tools: [], verdicts: [], calls: [], ms: 0, costSar: 0, model: null, suggestions: [] };
    const rulesHandover = { complaint: "complaint", problem: "problem", change: "order_change", human: "asked_human", media: "media", custom_offer: "custom_offer" };
    if (!el.run) {
      rec.by = "rules"; rec.outcome = serious ? "rules:handover_open" : `rules:${el.why.replace(/^rules:/, "")}`;
      if (!serious) { if (cls.key === "dishfact" && cls.rawIntent === "allergy_severe") { rec.handover = "allergy_severe"; handoverOpen = "allergy_severe"; } else if (rulesHandover[cls.key]) { rec.handover = rulesHandover[cls.key]; handoverOpen = rec.handover; } }
      if (session) session = AR.noteRulesTurn(session, ev.text, cls.key);
      turns.push(rec); continue;
    }
    const lang = cls.lang === "en" ? "en" : "ar";
    const fresh = !session; if (fresh) session = AR.newSession(W.now());
    const hours = await W.tools.get_hours();
    let profile = null, offers = null;
    if (fresh || first) { const p = await W.tools.customer_profile(PHONE); profile = p && p.ok ? p.profile : null; offers = await W.tools.get_offers(PHONE); }
    const context = AR.buildContext({ first: fresh, hours, profile, offers, reorder: fresh ? W.reorder : null, locationShared: Boolean(W.state.loc), justShared: Boolean(t.location), branch: fresh ? R.textOf(W.cfg, "location", lang) : null, boxes: fresh ? W.boxes : null, notes: fresh ? (sc.world || {}).notes || null : null, ad: fresh ? (sc.world || {}).ad || null : null, hint: AR.hintOf(withAlt(cls)), handover: handoverOpen && !serious ? { reason: handoverOpen, minutes_ago: 2 } : null });
    rec.context = context;
    first = false;
    const text = t.location ? "📍" : ev.text;
    const r = await W.loop.runTurn({ phone: PHONE, text, lang, session, acfg: W.acfg, context, profile });
    Object.assign(rec, { tools: r.trace.tools, verdicts: r.trace.verdicts, calls: r.trace.calls, ms: r.trace.ms, costSar: r.trace.costSar, model: r.trace.model, tier: r.trace.tier, escalated: Boolean(r.trace.escalated), suggestions: r.trace.suggestions, lang: r.trace.lang || lang });
    if (!r.ok) { rec.by = "rules"; rec.outcome = `fallback:${r.reason}`; session = fresh ? null : AR.noteRulesTurn(session, ev.text, cls.key); turns.push(rec); continue; }
    session = r.session; rec.by = "assistant";
    if (r.handover) { rec.handover = r.handover.reason; rec.note = r.handover.note; rec.outcome = `handover:${r.handover.reason}`; handoverOpen = r.handover.reason; }
    else { rec.reply = r.text; rec.cart = r.cart; rec.outcome = "sent"; }
    turns.push(rec);
    if (i === script.length - 1 && i === sc.turns.length - 1 && sc.expect && sc.expect.cart && sc.closing !== false && !turns.some((x) => x.cart) && rec.by === "assistant" && rec.reply) script.push("لا شكراً، ارسل رابط السلة");
  }
  const conv = { id: sc.id, group: sc.group, world: sc.world || {}, expect: sc.expect || {}, turns, carts: W.carts, costSar: turns.reduce((a, t) => a + t.costSar, 0) };
  conv.grade = gradeConversation(conv, W);
  return conv;
}

const withAlt = (cls) => { if (!cls || cls.key !== "dishfact" || cls.rawIntent !== "remove_question" || !cls.arg || !cls.arg.id) return cls; const f = lookupFact(cls.arg.id, cls.arg.text, { remove: true }); return f.status === "alternative" ? { ...cls, alt: { id: f.altId, name: f.alt, name_en: f.altEn } } : cls; };
const results = [];
const queue = [...list];
await Promise.all(Array.from({ length: Math.max(1, PAR) }, async () => { for (;;) { const sc = queue.shift(); if (!sc || capped) return; try { const c = await runOne(sc); results.push(c); console.log(`${c.grade.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(34)} ${c.costSar.toFixed(4)} SAR  ${c.grade.fails.map((f) => f.type).join(",")}`); } catch (e) { console.log(`ERROR ${sc.id}: ${e.stack || e.message}`); results.push({ id: sc.id, group: sc.group, turns: [], error: e.message, grade: { pass: false, fails: [{ type: "harness_error", detail: e.message }], review: [] }, costSar: 0 }); } } }));
results.sort((a, b) => list.findIndex((s) => s.id === a.id) - list.findIndex((s) => s.id === b.id));
fs.writeFileSync(path.join(OUT, "transcripts.json"), JSON.stringify(results, null, 1));
const sum = summarize(results, { set: SET, name: NAME, over: OVER, capped, spentRun, spentTodayBefore: spentToday, cap: CAP });
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(sum, null, 1));
fs.writeFileSync(path.join(OUT, "report.md"), sum.markdown);
console.log("\n" + sum.text);
console.log(`\nwritten: ${OUT}`);
