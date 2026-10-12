/* PS2 probe: does the proxy accept a 1-hour cache on the fixed prefix (tools + system), and what does usage report?
     node eval/probe-cache.mjs [1h|5m] [model]
   Two identical calls with the real system prompt and tool list; prints the raw usage of each. Costs about 0.01 SAR on the fast model. */
import * as AR from "../waassistrun.js";
import { litellmKey } from "./_key.mjs";
const ttl = process.argv[2] === "5m" ? "5m" : "1h", model = process.argv[3] || "claude-haiku-5-5";
const call = AR.makeModelCaller({ env: { LITELLM_KEY: litellmKey(), LITELLM_BASE: "https://llm.o2m8.me/v1" } });
for (const i of [1, 2]) {
  const r = await call({ model, system: AR.SYSTEM_PROMPT, tools: AR.TOOL_DEFS, messages: [{ role: "user", content: [{ type: "text", text: "<customer_message>هلا</customer_message>" }] }], effort: "low", thinking: "adaptive", timeoutMs: 30000, cacheTtl: ttl, maxTokens: 200 });
  console.log(`call ${i} ttl=${ttl} ${model}:`, r.ok ? "ok" : `${r.error} ${r.detail || ""}`, JSON.stringify(r.usage), "billable", JSON.stringify(r.usage ? AR.billableUsage(r.usage) : null));
}
