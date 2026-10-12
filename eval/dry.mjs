// No model, no cost: how each scripted customer line is classified and who would own it (rules or assistant) on a fresh chat.
import * as R from "../wabotrun.js";
import * as AR from "../waassistrun.js";
import { makeWorld, PHONE } from "./world.mjs";
import { SCENARIOS } from "./scenarios.mjs";
const only = process.argv[2] || "";
for (const sc of SCENARIOS) {
  if (only && !sc.id.includes(only) && !String(sc.group).includes(only)) continue;
  const W = makeWorld(sc.world || {}, {});
  let active = false;
  const row = sc.turns.map((t0, i) => { const t = typeof t0 === "string" ? { text: t0 } : t0; const ev = { phone: PHONE, text: t.text || "", type: t.type || (t.location ? "location" : "text"), location: t.location ? { lat: 21.58, lng: 39.16 } : null };
    const cls = R.classify(ev, W.know); const d = cls.key === "ack" || cls.key === "nack" ? { act: "silent", reason: "ack" } : cls.key === "unknown" ? { act: "wait", waitKind: "unknown_wait" } : cls.key ? { act: "reply", key: cls.key } : null;
    const el = AR.assistEligible({ acfg: W.acfg, cfg: W.cfg, phone: PHONE, ev, cls, d, sessionActive: active, recentOrder: Boolean((sc.world || {}).orders) }); if (el.run) active = true;
    const want = sc.expect.owner && sc.expect.owner[i]; return `${el.run ? "A" : "R"}:${cls.key}${cls.rawIntent && cls.rawIntent !== cls.key ? `(${cls.rawIntent})` : ""}${want && (want === "rules") === el.run ? "  <<< EXPECTATION MISMATCH" : ""}`; });
  console.log(sc.id.padEnd(36), row.join(" | "));
}
