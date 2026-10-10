// G2 (10/10): «العنوان قبل رقم الجوال» — the storefront switch, and the per-link «سلة جاهزة» flag for box links.
// Run: node --test g2-address-first.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
// cms.register starts timers — unref them so the process can exit (same as cartpresets.test.mjs)
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = realSI(...a); t?.unref?.(); return t; };
globalThis.setTimeout = (...a) => { const t = realST(...a); t?.unref?.(); return t; };
const cms = await import("./cms.js");
const guard = await import("./settings-guard.js");
const shopSrc = readFileSync(new URL("./shop.js", import.meta.url), "utf8");
const cmsSrc = readFileSync(new URL("./cms.js", import.meta.url), "utf8");

function linksApp(link) {
  const st = { sql: [], autocart: [] };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      st.sql.push(s);
      if (/^UPDATE cms_links SET clicks/i.test(s) || /^SELECT \* FROM cms_links WHERE slug=\$1 AND active/i.test(s)) return { rows: link && p[0] === link.slug ? [link] : [], rowCount: 1 };
      if (/^INSERT INTO cms_links/i.test(s)) return { rows: [{ id: 7, slug: p[0], target_type: p[2], target_id: p[3] }], rowCount: 1 };
      if (/^UPDATE cms_links SET slug=\$2/i.test(s)) return { rows: [{ id: p[0], slug: p[1], target_type: p[3], target_id: p[4] }], rowCount: 1 };
      if (/^UPDATE cms_links SET autocart=\$2 WHERE id=\$1/i.test(s)) { st.autocart.push(p.slice()); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = new Hono();
  cms.register(app, { pool, jb: (x) => JSON.stringify(x), DEFAULT_DELIVERY_APPS: [], todayISO: () => "2026-10-10",
    getSettingsData: async () => ({}), setCmsHooks: () => {}, requireAdmin: async () => null }, { notify: () => null });
  const call = async (method, path, body) => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, st };
}
const params = (r) => new URL("https://x" + r.body.url).searchParams;

test("the storefront gets the switch, ON unless the owner turned it off", () => {
  assert.ok(shopSrc.includes("addressFirst: (s.shop || {}).addressFirst !== false,"));
  // the generic settings PUT must not overwrite a key that has its own writer
  assert.ok(guard.SERVER_OWNED_PATHS ? guard.SERVER_OWNED_PATHS.includes("shop.addressFirst") : readFileSync(new URL("./settings-guard.js", import.meta.url), "utf8").includes('"shop.addressFirst"'));
});

test("box link with «سلة جاهزة»: the landing URL carries bxadd=1 next to the box, with the link's own utm and fc_link", async () => {
  const link = { slug: "m-box-d1", target_type: "box", target_id: "box-crepe-duo", utm_source: "meta", utm_medium: "paid", utm_campaign: "oct-boxes", coupon: null, autocart: true };
  const r = await linksApp(link).call("POST", "/api/cms/links/resolve/m-box-d1", { ip: "51.36.9.20" });
  assert.equal(r.status, 200);
  const q = params(r);
  assert.equal(q.get("box"), "box-crepe-duo");
  assert.equal(q.get("go"), "offers");
  assert.equal(q.get("bxadd"), "1");
  assert.equal(q.get("utm_medium"), "paid");
  assert.equal(q.get("fc_link"), "m-box-d1");
});

test("default is OFF: a box link without the flag opens the picker as before; other link types never get bxadd", async () => {
  const box = { slug: "m-box-d2", target_type: "box", target_id: "box-crepe-duo", utm_source: "meta", utm_medium: "paid" };
  for (const ac of [undefined, false, null, "true", 1]) {
    const q = params(await linksApp({ ...box, autocart: ac }).call("POST", "/api/cms/links/resolve/m-box-d2", { ip: "51.36.9.21" }));
    assert.equal(q.get("box"), "box-crepe-duo");
    assert.equal(q.get("bxadd"), null, String(ac));
  }
  for (const tt of ["home", "offer", "product", "collection", "cart"]) {
    const q = params(await linksApp({ slug: "x-1", target_type: tt, target_id: "1", utm_source: "meta", autocart: true }).call("POST", "/api/cms/links/resolve/x-1", { ip: "51.36.9.22" }));
    assert.equal(q.get("bxadd"), null, tt);
  }
});

test("saving a link: the flag is kept only for box links, and written in its own statement", async () => {
  let a = linksApp(null);
  let r = await a.call("POST", "/api/cms/links", { slug: "m-box-new", label: "x", target_type: "box", target_id: "box-crepe-duo", utm_source: "meta", autocart: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.link.autocart, true);
  assert.deepEqual(a.st.autocart, [[7, true]]);
  a = linksApp(null);
  r = await a.call("POST", "/api/cms/links", { slug: "m-home", label: "x", target_type: "home", utm_source: "meta", autocart: true });
  assert.equal(r.body.link.autocart, false, "not a box link");
  assert.deepEqual(a.st.autocart, [[7, false]]);
  a = linksApp(null);
  r = await a.call("POST", "/api/cms/links", { slug: "m-box-off", label: "x", target_type: "box", target_id: "box-crepe-duo", utm_source: "meta" });
  assert.equal(r.body.link.autocart, false, "default off");
  a = linksApp(null);
  r = await a.call("PUT", "/api/cms/links/12", { slug: "m-box-new", label: "x", target_type: "box", target_id: "box-crepe-duo", utm_source: "meta", autocart: true });
  assert.equal(r.status, 200);
  assert.deepEqual(a.st.autocart, [[12, true]]);
  // the original INSERT / UPDATE statements are untouched (links created by campaigns, flows and WhatsApp jobs do not know the column)
  assert.ok(a.st.sql.some((s) => /^UPDATE cms_links SET slug=\$2, label=\$3, target_type=\$4, target_id=\$5, coupon=\$6, utm_source=\$7, utm_medium=\$8, utm_campaign=\$9, active=\$10 WHERE id=\$1 RETURNING \*/.test(s)));
  assert.ok(cmsSrc.includes("ALTER TABLE cms_links ADD COLUMN IF NOT EXISTS autocart BOOLEAN NOT NULL DEFAULT FALSE;"));
});
