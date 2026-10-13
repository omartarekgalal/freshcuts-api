/* Old reply (what was really sent that day) beside the new one, per customer line:   node eval/sidebyside.mjs <run-name> > file.md
   Needs scenarios that carry «old» (the replies of the day, in order). Read-only: no model call. */
import fs from "node:fs";
import { SCENARIOS } from "./scenarios.mjs";
const name = process.argv[2];
const convs = JSON.parse(fs.readFileSync(new URL(`./out/${name}/transcripts.json`, import.meta.url), "utf8"));
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, "<br>").trim() || "—";
const who = (t) => (t.ignored ? "_(ignored: nobody answers)_" : t.by === "rules" && !t.reply ? `_(rules bot: ${String(t.outcome || "").replace(/^rules:/, "")})_` : "");
const out = [`# 13/10 — the 27 real chats: what was sent that day, and what the new build answers (${name})`, "",
  "Left: the customer's line. Middle: the reply that was really sent on 13/10. Right: the reply of the new build to the same line (same order, same context: a chat that came from the ad has the ad).",
  "A reply in _(italics)_ is the rules bot's fixed reply (not the model). Buttons attached to a reply are listed under it.", ""];
for (const c of convs) {
  const sc = SCENARIOS.find((s) => s.id === c.id); if (!sc || !Array.isArray(sc.old)) continue;
  out.push(`## ${c.id} — ${sc.group}${c.world && c.world.adItem ? " · from the ad" : ""}`, "", "| Customer | 13/10 (sent) | New build |", "|---|---|---|");
  c.turns.forEach((t, i) => { const extra = [t.menuButton ? "[زر: المنيو]" : "", t.buttons ? `[${t.buttons.join(" · ")}]` : ""].filter(Boolean).join(" ");
    out.push(`| ${cell(t.customer)} | ${cell(sc.old[i])} | ${cell(t.reply || who(t) || (t.handover ? `_(handover: ${t.handover})_` : ""))}${extra ? `<br>${extra}` : ""} |`); });
  out.push("");
}
console.log(out.join("\n"));
