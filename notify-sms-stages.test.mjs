import { test } from "node:test";
import assert from "node:assert/strict";
import { smsStagesOf, statusSmsText, MANDATORY_SMS_STAGES } from "./notify.js";
import { smsParts } from "./smsrules.js";

test("refund SMS stays on even when stages list only on_the_way", () => {
  const st = smsStagesOf({ smsStages: ["on_the_way"] });
  assert.deepEqual(st.sort(), ["on_the_way", ...MANDATORY_SMS_STAGES].sort());
  assert.equal(st.includes("pos_created"), false);
});

test("on_the_way SMS carries the tracking link in one UCS-2 part", () => {
  const t = statusSmsText("on_the_way", { order_no: "W1786465168960" });
  assert.match(t, /المندوب/);
  assert.match(t, /freshcuts\.sa\/track\/W1786465168960$/);
  assert.equal(smsParts(t), 1);
});
