// LiteLLM key for the eval, read from CREDENTIALS.md; never printed.
import fs from "node:fs";
export function litellmKey() {
  if (process.env.LITELLM_KEY) return process.env.LITELLM_KEY;
  const m = fs.readFileSync("C:/server/CREDENTIALS.md", "utf8").match(/LiteLLM master key\*\*[^`]*`(sk-[A-Za-z0-9_-]+)`/);
  if (!m) throw new Error("LiteLLM key not found in CREDENTIALS.md");
  return m[1];
}
