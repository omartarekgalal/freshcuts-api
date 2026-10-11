// 12/10: the watemplates.js catalogue is a LIST; the registry wants a name-keyed map with bind(). Before the fix nothing from
// the catalogue was registered, so the live template routes knew only the 11 built-ins and fc_winback_45 could not be submitted.
// Run: node --test wa-catalog.test.mjs      (offline: Graph is a fake fetch; nothing is sent to Meta)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
const W = await import("./whatsapp.js");
const WT = await import("./watemplates.js");
const C = await import("./wacloud.js");
const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");

const BUILT_IN = Object.keys(W.TEMPLATES);          // before anything is registered
const STAGES_BEFORE = JSON.stringify(W.STAGE_TEMPLATES);

test("the defect: handing the catalogue list straight to registerTemplates registers nothing", () => {
  assert.ok(Array.isArray(WT.TEMPLATES), "watemplates.js exports a list");
  const r = W.registerTemplates(WT.TEMPLATES);
  assert.equal(r.added.length, 0);
  assert.equal(r.skipped.length, WT.TEMPLATES.length);
  assert.deepEqual(r.skipped.slice(0, 3), ["0", "1", "2"], "the keys were array indexes");
  assert.equal(Object.keys(W.TEMPLATES).length, BUILT_IN.length);
  assert.equal(BUILT_IN.length, 11);
  assert.ok(!W.TEMPLATES.fc_winback_45);
});

let reg;
test("registerCatalog: every catalogue template is registered by name; built-ins keep their own definition", () => {
  reg = W.registerCatalog(WT);
  const names = [...new Set(WT.TEMPLATES.map((t) => t.name))];
  const overlap = names.filter((n) => BUILT_IN.includes(n));
  assert.equal(reg.shape, "list");
  assert.deepEqual(reg.invalid, []);
  assert.deepEqual(reg.skipped.sort(), overlap.sort(), "only names that already exist are kept as they were");
  assert.equal(reg.added.length, names.length - overlap.length);
  assert.ok(reg.added.includes("fc_winback_45"));
  assert.equal(Object.keys(W.TEMPLATES).length, BUILT_IN.length + reg.added.length);
  for (const n of overlap) assert.ok(!W.isCatalogTemplate(n), n + " stays the built-in");
  for (const n of reg.added) {
    const t = W.TEMPLATES[n];
    assert.equal(t.catalog, true);
    assert.equal(t.stage, undefined, n + ": no order stage — it must not join the automatic order updates");
    assert.equal(t.campaign, undefined, n + ": not a campaign template — it must not appear in the campaign sender");
    assert.equal(typeof t.bind, "function");
  }
  assert.equal(JSON.stringify(W.STAGE_TEMPLATES), STAGES_BEFORE, "order-update routing is untouched");
  assert.deepEqual(C.CAMPAIGN_TEMPLATES().filter((n) => W.isCatalogTemplate(n)), [], "campaign template list is untouched");
  // idempotent: a second boot call changes nothing
  const again = W.registerCatalog(WT);
  assert.equal(again.added.length, 0);
});

test("a template that exists in two languages is one entry with both versions", () => {
  const dup = "fc_staff_new_order";
  assert.deepEqual(W.templateLanguages(dup).sort(), ["ar", "en"]);
  const ar = W.templateSubmission(dup, "ar"), en = W.templateSubmission(dup, "en");
  assert.equal(ar.language, "ar"); assert.equal(en.language, "en");
  assert.notDeepEqual(ar.components, en.components);
  assert.deepEqual(ar.components, WT.TEMPLATES.find((t) => t.name === dup && t.language === "ar").components);
  assert.throws(() => W.templateSubmission(dup, "fr"), /no fr version/);
  // built-ins: exactly as before
  assert.deepEqual(W.templateSubmission("fc_order_received"), { name: "fc_order_received", language: "ar", category: "UTILITY", components: W.TEMPLATES.fc_order_received.components });
  assert.deepEqual(W.templateLanguages("fc_order_received"), ["ar"]);
});

test("fc_winback_45: the submission body is the catalogue's own, and bind gives the registry's shape", () => {
  const t = WT.TEMPLATES.find((x) => x.name === "fc_winback_45");
  assert.deepEqual(W.templateSubmission("fc_winback_45"), WT.submissionBody(t));
  assert.match(W.templateSubmission("fc_winback_45").components.find((c) => c.type === "BODY").text, /^اشتقنا لك/);
  const b = W.TEMPLATES.fc_winback_45.bind({ customer: { name: "سارة العتيبي" }, coupon: { benefitText: "خصم 10٪", code: "WB-4Q7M", expiresText: "20 أكتوبر", linkSuffix: "wb-4q7m" } });
  assert.ok(Array.isArray(b.body) && Array.isArray(b.button) && Array.isArray(b.missing));
  assert.equal(b.body.length, 4);
  assert.ok(b.body.includes("WB-4Q7M"));
  // an empty variable is reported, so a sender can refuse to send «{{2}}» blank
  assert.ok(W.TEMPLATES.fc_winback_45.bind({}).missing.length > 0);
});

/* ── routes ── */
function mkApp({ admin = true } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body && typeof init.body === "string" ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ id: "T" + calls.length, status: "PENDING", category: "MARKETING" }), headers: { get: () => "application/json" } };
  };
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const app = new Hono();
  W.register(app, { pool, requireAdmin: async (c) => (admin ? null : c.json({ ok: false, error: "unauthorized" }, 401)),
    getSettingsData: async () => ({ notifications: {} }), jb: (x) => JSON.stringify(x), normPhone: (x) => String(x || "") }, { fetch, sendSms: async () => ({ ok: true }) });
  const call = async (method, path, body) => { const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { call, calls, posts: () => calls.filter((c) => c.method === "POST" && /message_templates$/.test(c.url)) };
}
const ENV = ["WHATSAPP_TEMPLATES_WRITE", "WHATSAPP_TOKEN", "WHATSAPP_WABA_ID", "WHATSAPP_ENABLED", "META_CAPI_TOKEN", "WHATSAPP_PHONE_ID"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const WRITE = { WHATSAPP_TEMPLATES_WRITE: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_WABA_ID: "WABA1" };   // WHATSAPP_ENABLED stays off

test("GET /api/wa/templates lists the catalogue too, marked, one row per language", withEnv({}, async () => {
  const { call, calls } = mkApp();
  const r = await call("GET", "/api/wa/templates");
  assert.equal(r.status, 200);
  const names = r.body.templates.map((t) => t.name);
  assert.ok(names.includes("fc_winback_45") && names.includes("fc_order_received"));
  assert.equal(r.body.templates.find((t) => t.name === "fc_winback_45").catalog, true);
  assert.equal(r.body.templates.find((t) => t.name === "fc_order_received").catalog, false);
  assert.equal(r.body.templates.filter((t) => t.name === "fc_staff_new_order").length, 2);
  assert.equal(r.body.templates.length, WT.TEMPLATES.length - WT.TEMPLATES.filter((t) => BUILT_IN.includes(t.name)).length + BUILT_IN.length);
  assert.equal(calls.length, 0, "listing calls nobody");
}));

test("submit: one catalogue template by name goes to Meta with the catalogue's body — and only that one", withEnv(WRITE, async () => {
  const { call, posts } = mkApp();
  const r = await call("POST", "/api/wa/templates/submit", { names: ["fc_winback_45"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.name, x.ok]), [["fc_winback_45", true]]);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].url, /\/WABA1\/message_templates$/);
  assert.deepEqual(posts()[0].body, WT.submissionBody(WT.TEMPLATES.find((t) => t.name === "fc_winback_45")));
}));

test("submit: no names = the built-ins only, minus the retired one — the catalogue is never submitted in bulk", withEnv(WRITE, async () => {
  const a = mkApp();
  const r = await a.call("POST", "/api/wa/templates/submit", {});
  const asked = r.body.results.map((x) => x.name);
  // 12/10: fc_cart_reminder is retired (never wired, never submitted; fc_cart_1h replaces it) and is not submitted
  assert.deepEqual(asked.sort(), BUILT_IN.filter((n) => n !== "fc_cart_reminder").sort());
  assert.ok(a.posts().every((p) => BUILT_IN.includes(p.body.name)));
  // two catalogue names, or a catalogue name mixed with others, are refused: one decision per template
  const b = mkApp();
  const r2 = await b.call("POST", "/api/wa/templates/submit", { names: ["fc_winback_45", "fc_winback_90"] });
  assert.deepEqual(r2.body.results.map((x) => [x.name, x.ok, x.error]), [["fc_winback_45", false, "catalog_one_at_a_time"], ["fc_winback_90", false, "catalog_one_at_a_time"]]);
  assert.equal(b.posts().length, 0);
  const c = mkApp();
  const r3 = await c.call("POST", "/api/wa/templates/submit", { names: ["fc_order_delivered", "fc_winback_45"] });
  assert.deepEqual(r3.body.results.find((x) => x.name === "fc_winback_45").error, "catalog_one_at_a_time");
  assert.deepEqual(c.posts().map((p) => p.body.name), ["fc_order_delivered"]);
  const d = mkApp();
  assert.equal((await d.call("POST", "/api/wa/templates/submit", { names: ["fc_nope"] })).body.results[0].error, "unknown");
}));

test("submit: a two-language template sends each language; an image template still needs the sample image", withEnv(WRITE, async () => {
  const a = mkApp();
  const r = await a.call("POST", "/api/wa/templates/submit", { names: ["fc_staff_new_order"] });
  assert.deepEqual(r.body.results.map((x) => [x.name, x.language, x.ok]).sort(), [["fc_staff_new_order", "ar", true], ["fc_staff_new_order", "en", true]]);
  assert.deepEqual(a.posts().map((p) => p.body.language).sort(), ["ar", "en"]);
  const b = mkApp();
  const r2 = await b.call("POST", "/api/wa/templates/submit", { names: ["fc_staff_new_order"], language: "en" });
  assert.deepEqual(b.posts().map((p) => p.body.language), ["en"]);
  assert.equal(r2.body.results.length, 1);
  const img = WT.TEMPLATES.find((t) => !BUILT_IN.includes(t.name) && t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE"));
  const c = mkApp();
  const r3 = await c.call("POST", "/api/wa/templates/submit", { names: [img.name] });
  assert.equal(r3.body.results[0].error, "sample_image_required");
  assert.equal(c.posts().length, 0);
}));

test("the gates are where they were: write switch, admin, and nothing here sends a message", withEnv({ WHATSAPP_TOKEN: "tok", WHATSAPP_WABA_ID: "WABA1" }, async () => {
  const a = mkApp();
  const r = await a.call("POST", "/api/wa/templates/submit", { names: ["fc_winback_45"] });
  assert.equal(r.body.error, "templates_write_disabled");
  assert.equal(a.calls.length, 0);
  const b = mkApp({ admin: false });
  assert.equal((await b.call("POST", "/api/wa/templates/submit", { names: ["fc_winback_45"] })).status, 401);
  assert.equal((await b.call("GET", "/api/wa/templates")).status, 401);
}));
test("submitting never calls the messages endpoint", withEnv(WRITE, async () => {
  const a = mkApp();
  await a.call("POST", "/api/wa/templates/submit", { names: ["fc_winback_45"] });
  assert.ok(a.calls.every((c) => !/\/messages$/.test(c.url)));
}));

test("boot: index.js registers the catalogue through registerCatalog, and nothing submits at startup", () => {
  assert.ok(indexSrc.includes("const r = whatsapp.registerCatalog(m);"));
  assert.ok(!indexSrc.includes("whatsapp.registerTemplates(defs)"));
  assert.ok(!/templates\/submit|message_templates/.test(indexSrc.slice(indexSrc.indexOf('import("./watemplates.js")'), indexSrc.indexOf('import("./wabot.js")'))));
});
