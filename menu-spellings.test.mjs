// 10/10: five products were renamed in TabSense (spelling). Everything that recognises a dish by its NAME must
// accept the old spelling (history, cached names) and the corrected one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
const PAIRS = [["كلوسلو", "كولسلو"], ["موتزريلا", "موتزاريلا"]];

test("name matchers know both spellings", () => {
  for (const f of ["dayreport.js", "menuplan.js", "scorecard.js", "wamsg.js"]) {
    const s = src(f);
    for (const [o, n] of PAIRS) assert.ok(s.includes(o) && s.includes(n), `${f}: «${o}» and «${n}»`);
  }
  const side = /const SIDE_RE = (\/.*\/i);/.exec(src("wamsg.js"));
  assert.ok(side, "SIDE_RE found");
  const re = new RegExp(side[1].slice(1, side[1].lastIndexOf("/")), "i");
  for (const n of ["كلوسلو", "كولسلو", "فرايد موتزريلا", "فرايد موتزاريلا"]) assert.ok(re.test(n), n);
  const mp = /\[(\/كومبو.*\/i), "مقبلات"\]/.exec(src("menuplan.js"));
  const re2 = new RegExp(mp[1].slice(1, mp[1].lastIndexOf("/")), "i");
  assert.ok(re2.test("كولسلو") && re2.test("فرايد موتزاريلا"));
});

test("customer-facing strings use the corrected spelling", () => {
  for (const f of ["offers.js", "adsplan.js", "watemplates.js"]) assert.ok(!src(f).includes("كلوسلو"), f);
  assert.ok(src("wamsg.js").includes('"mozzarella hawawshi": "حواوشي موتزاريلا"'));
});
