/* Grade a finished run again with the CURRENT expectations of its scenarios — no model call, no cost:   node eval/regrade.mjs <run-name>
   For when an expectation (a pattern in a scenario file) was wrong, not the reply. The transcripts are kept as they are; only grade, summary and report are rewritten,
   and the summary says it was re-graded. */
import fs from "node:fs";
import { makeWorld } from "./world.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { gradeConversation, summarize } from "./grade.mjs";
const name = process.argv[2], dir = new URL(`./out/${name}/`, import.meta.url);
const convs = JSON.parse(fs.readFileSync(new URL("transcripts.json", dir), "utf8")), old = JSON.parse(fs.readFileSync(new URL("summary.json", dir), "utf8"));
const before = convs.filter((c) => c.grade && c.grade.pass).length;
for (const c of convs) { const sc = SCENARIOS.find((s) => s.id === c.id); if (!sc) continue;
  const W = makeWorld(sc.world || {}, { callModel: async () => ({ ok: false }), onCall: async () => ({}), acfg: old.over || {} });
  c.expect = sc.expect || {}; c.grade = gradeConversation(c, W); }
const sum = summarize(convs, { set: old.set, name, over: old.over, capped: old.capped, spentRun: old.spentRun, spentTodayBefore: old.spentTodayBefore, cap: old.cap });
sum.regraded = { at: new Date().toISOString(), passedBefore: before, note: "graded again with the scenarios' current expectations; no reply was changed and no model was called" };
fs.writeFileSync(new URL("transcripts.json", dir), JSON.stringify(convs, null, 1));
fs.writeFileSync(new URL("summary.json", dir), JSON.stringify(sum, null, 1));
fs.writeFileSync(new URL("report.md", dir), `${sum.markdown}\n\n_Re-graded ${sum.regraded.at.slice(0, 16)} with the scenarios' current expectations (passed before: ${before}). No reply was changed, no model was called._\n`);
console.log(`${name}: passed ${convs.filter((c) => c.grade.pass).length}/${convs.length} (before: ${before})`);
for (const c of convs.filter((x) => !x.grade.pass)) console.log(`FAIL ${c.id}: ${c.grade.fails.map((f) => `${f.type}@${f.turn}: ${f.detail}`).join(" | ")}`);
