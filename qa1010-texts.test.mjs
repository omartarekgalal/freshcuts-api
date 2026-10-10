// Owner rule 10/10: customer-facing copy is white dialect; the public delivery quote carries no internal policy name.
// Run: node --test qa1010-texts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FREEBAR_DEFAULTS } from "./freebar.js";
import { TABLE_MSG } from "./table-order.js";
import { soldOutMessage } from "./soldout.js";

const EGY = /(^|[^؀-ۿ])(فاضل|ضيف|دلوقتي|مش|لسه|تاني|عشان|اللي|النهارده|كمّل|زوّد|شيله|كتير)([^؀-ۿ]|$)/;

test("free-delivery bar defaults carry no Egyptian wording and keep their placeholders", () => {
  const t = FREEBAR_DEFAULTS.texts;
  for (const k of ["gapAr", "tierAr", "doneAr", "firstAr", "addAr"]) assert.ok(!EGY.test(t[k]), k + ": " + t[k]);
  assert.ok(t.gapAr.includes("{x}"));
  assert.ok(t.tierAr.includes("{x}") && t.tierAr.includes("{fee}"));
  assert.ok(t.firstAr.includes("{min}"));
});

test("table messages and the sold-out line are white dialect", () => {
  for (const [k, v] of Object.entries(TABLE_MSG)) assert.ok(!EGY.test(v), k + ": " + v);
  assert.ok(!EGY.test(soldOutMessage(["كفتة"])));
  assert.ok(!EGY.test(soldOutMessage([])));
  assert.match(soldOutMessage(["كفتة"]), /كفتة/);
});

test("the public delivery quote does not expose the policy's internal name", () => {
  const src = readFileSync(new URL("./delivery.js", import.meta.url), "utf8");
  const i = src.indexOf("driveKm: rk.driveKm != null ? r2(rk.driveKm) : null, distanceSource: rk.distanceSource,");
  assert.ok(i > 0);
  const ret = src.slice(i, i + 700);
  assert.ok(ret.includes("policyId: pol.id, policy: publicPolicy(cfg, dcfg)"));
  assert.ok(!/policyName/.test(ret.split("};")[0]));
});
