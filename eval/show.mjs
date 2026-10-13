/* Print a run's transcripts compactly:   node eval/show.mjs <run-name> [id-substring]
   Read-only: no model call. Used to review a run turn by turn (customer line, who answered, tools, the reply, buttons, grader fails). */
import fs from "node:fs";
const [name, only] = process.argv.slice(2);
const convs = JSON.parse(fs.readFileSync(new URL(`./out/${name}/transcripts.json`, import.meta.url), "utf8"));
for (const c of convs) {
  if (only && !c.id.includes(only)) continue;
  console.log(`\n=== ${c.id} · ${c.grade.pass ? "PASS" : "FAIL"} · ${c.costSar.toFixed(3)} SAR${c.grade.fails.length ? ` · ${c.grade.fails.map((f) => `${f.type}${f.turn != null ? `@${f.turn}` : ""}: ${f.detail}`).join(" | ")}` : ""}`);
  for (const t of c.turns) {
    console.log(`C: ${t.customer}`);
    const tools = (t.tools || []).map((x) => `${x.name}${x.result && x.result.ok === false ? `✗${x.result.error || ""}` : ""}`).join(", ");
    console.log(`   [${t.by}/${t.outcome}${t.ignored ? "/ignored" : ""}${tools ? ` · ${tools}` : ""}${(t.verdicts || []).length > 1 ? ` · retried: ${(t.verdicts[0].problems || []).map((p) => `${p.type}:${p.value}`).join(",")}` : ""}${t.menuButton ? " · menu button" : ""}${t.buttons ? ` · buttons: ${t.buttons.join(" / ")}` : ""}] ${String(t.reply || "").replace(/\n/g, " ⏎ ")}`);
  }
}
