// menu.js — full read/write control of the TabSense **digital menus**.
//
// tabsense.js knows how to log in and how to read the dashboard's DataTables
// endpoints. This module adds the one thing it never had: the ability to change
// what the customer actually sees. It drives the same routes the drag-and-drop
// menu editor at /digital-menus/{id}/edit calls from its own JavaScript.
//
// ── The two id spaces (the thing that wastes an afternoon if you miss it) ─────
// A digital menu has a DASHBOARD id and a PUBLIC id, and they are different
// numbers for the same menu:
//
//   dashboard /digital-menus/3/edit   ==  public stores/freshcuts/menus/2
//
// The public JSON even echoes `"id": 3` in its body while living at path 2.
// So: the storefront's TABSENSE_EXTERNAL_MENU_ID=2 and the owner's editor link
// .../digital-menus/3/edit are the SAME menu. EXTERNAL_MENU is the dashboard id
// (3) because everything here writes through the dashboard.
//
// ── The routes the editor uses ───────────────────────────────────────────────
//   POST   /digital-menus/{menu}/pages                {title, local_title}
//   POST   /digital-menus/{menu}/pages/{page}         _method=PUT  {title, local_title, image}
//   POST   /digital-menus/{menu}/pages/{page}         _method=DELETE
//   POST   /digital-menus/{menu}/order-pages          {pages_ids: JSON array}
//   POST   /digital-menu-pages/{page}/items           {items:[{itemable_type,itemable_id,order}]}  (JSON)
//   DELETE /digital-menu-pages/{page}/items/{item}                                                  (JSON)
//   POST   /digital-menu-pages/{page}/order-items     {items_ids:[...]}                             (JSON)
//
// The first four are Laravel form posts (urlencoded + _token). The last three
// are axios/JSON calls guarded by X-CSRF-TOKEN, not by a form _token — sending
// the wrong flavour gets a 419 that reads like an auth failure but isn't.
//
// ── itemable_id vs item id ───────────────────────────────────────────────────
// `itemable_id` is the POS **product** id (the sidebar's data-id). The id that
// comes back — and the one you delete or reorder with — is the **page-item**
// id (the dropzone's data-ids). They are different numbers for the same dish.
// Deleting by product id silently removes the wrong row, so never mix them.

import { getSession, BASE, STORE } from "./tabsense.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const dash = (p) => `${BASE}/${STORE}/dashboard${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE_MS = Number(process.env.TABSENSE_THROTTLE_MS || 200);

// The external (takeaway/delivery) menu — the one order.o2m8.me and every ad
// catalog read. Dashboard id; see the id-space note above.
const EXTERNAL_MENU = Number(process.env.TABSENSE_EXTERNAL_MENU_DASH_ID || 3);
// Same menu as the public API addresses it.
const EXTERNAL_MENU_PUBLIC = Number(process.env.TABSENSE_EXTERNAL_MENU_ID || 2);
const PUBLIC_UPSTREAM =
  process.env.TABSENSE_UPSTREAM || "https://qr.tabsense.ai/api/__api_party/myApi";

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

// ─── Low-level HTTP ──────────────────────────────────────────────────────────
async function authFetch(path, init = {}) {
  const run = async (s) => {
    const url = path.startsWith("http") ? path : dash(path);
    return fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA,
        Cookie: s.jar.header(),
        ...(init.headers || {}),
      },
      redirect: "manual",
    });
  };
  let s = await getSession();
  let res = await run(s);
  const bounced =
    res.status === 401 || res.status === 419 ||
    (res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.get("location") || ""));
  if (bounced) { s = await getSession(true); res = await run(s); }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after")) || 0;
    await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : 3000);
    res = await run(s);
  }
  return res;
}

async function authGetText(path) {
  const res = await authFetch(path, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.text();
}

async function authGetJson(path) {
  const res = await authFetch(path, {
    headers: { Accept: "application/json, text/javascript, */*", "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

// The JSON item routes are CSRF-guarded by the meta tag, not by a form field.
// Cached per editor page load; cheap to refresh because we read the editor
// anyway for every snapshot.
let _csrf = null;
async function csrfToken(menuId = EXTERNAL_MENU) {
  if (_csrf) return _csrf;
  const html = await authGetText(`/digital-menus/${menuId}/edit`);
  const m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error("csrfToken: meta csrf-token not found");
  _csrf = m[1];
  return _csrf;
}

// POST JSON to an axios-style route (items add / remove / reorder).
async function apiJson(path, method, body, menuId = EXTERNAL_MENU) {
  const send = async () => {
    const token = await csrfToken(menuId);
    return authFetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": token,
        Referer: dash(`/digital-menus/${menuId}/edit`),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  let res = await send();
  if (res.status === 419) { _csrf = null; res = await send(); } // token expired
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// POST a Laravel form (page create / update / delete / reorder).
async function apiForm(path, fields, menuId = EXTERNAL_MENU) {
  const html = await authGetText(`/digital-menus/${menuId}/edit`);
  const token =
    (html.match(/<meta name="csrf-token" content="([^"]+)"/) || [])[1] ||
    (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1];
  if (!token) throw new Error("apiForm: CSRF token not found");
  const body = new URLSearchParams({ _token: token, ...fields });
  const res = await authFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/json",
      Referer: dash(`/digital-menus/${menuId}/edit`),
    },
    body,
  });
  const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
  if (!ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST ${path}: HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  // A 200 that hands the form back is Laravel's way of saying "validation failed".
  if (res.status === 200) {
    const t = await res.text().catch(() => "");
    if (/is-invalid|alert-danger|field is required/i.test(t)) {
      throw new Error(`POST ${path}: rejected (validation) ${t.slice(0, 200)}`);
    }
  }
  return { ok: true, status: res.status };
}

// ─── Read: the menus themselves ──────────────────────────────────────────────
// [{ id, title, slug, type, branchId, branchName, isDefault, settings }]
async function listMenus() {
  const d = await authGetJson(`/digital-menus?draw=1&start=0&length=200`);
  return (d.data || []).map((m) => ({
    id: Number(m.id),
    title: m.title || "",
    slug: m.slug || "",
    // The type cell carries an entire Alpine popover; only the leading words matter.
    type: stripTags(String(m.type ?? "").split("<div")[0]),
    branchId: m.branch_id ? Number(m.branch_id) : null,
    branchName: m.branch_name || "",
    isDefault: String(m.default) === "1",
    settings: m.settings || null,
  }));
}

// ─── Read: one menu's editor, fully parsed ───────────────────────────────────
// The editor page is the only place that carries BOTH the page-item ids and the
// full product sidebar, so it is the single read that a snapshot needs.
//
// Returns {
//   menuId,
//   pages:    [{ id, title, localTitle, items:[{ itemId, name, price, image, order }] }],
//   products: [{ id, name, categoryId, image, price }],   // everything the POS has
//   categories: [{ id, name }],
// }
async function fetchMenuEditor(menuId = EXTERNAL_MENU) {
  const html = await authGetText(`/digital-menus/${menuId}/edit`);
  _csrf = (html.match(/<meta name="csrf-token" content="([^"]+)"/) || [])[1] || _csrf;

  // Categories, from the sidebar filter.
  const categories = [];
  const selMatch = html.match(/id="category-filter"[\s\S]*?<\/select>/);
  if (selMatch) {
    for (const m of selMatch[0].matchAll(/<option[^>]*value="(\d*)"[^>]*>([^<]*)</g)) {
      if (m[1]) categories.push({ id: Number(m[1]), name: decode(m[2].trim()) });
    }
  }

  // Sidebar products: every product the POS knows, with its image and category.
  const products = [];
  const sidebarStart = html.indexOf('id="sortable-products"');
  const sidebar = sidebarStart >= 0 ? html.slice(sidebarStart, html.indexOf('id="tab-list"', sidebarStart) + 1 || undefined) : "";
  for (const m of (sidebar || html).matchAll(
    /<li[^>]*data-name="([^"]*)"[^>]*data-id="(\d+)"[^>]*data-category-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g
  )) {
    const inner = m[4];
    products.push({
      id: Number(m[2]),
      name: decode(m[1]),
      categoryId: Number(m[3]),
      image: (inner.match(/<img src="([^"]*)"/) || [])[1] || "",
      price: Number((inner.match(/item-price[^>]*>([\d.]+)/) || [])[1] || 0) || null,
    });
  }

  // Page titles come from each page's own rename form. Scoping matters: the
  // page also carries a DELETE form pointed at the same URL, so a loose regex
  // pairs page N's delete form with page N+1's title inputs and shifts every
  // name by one. Split on <form> and read each form whole instead.
  const pageMeta = new Map();
  for (const raw of html.split(/<form/i).slice(1)) {
    const chunk = raw.slice(0, raw.search(/<\/form>/i) + 1 || 6000);
    const act = chunk.match(/action="[^"]*digital-menus\/\d+\/pages\/(\d+)"/);
    if (!act) continue;
    const title = chunk.match(/name="title"[^>]*value="([^"]*)"/);
    if (!title) continue; // the delete form has no inputs — skip it
    const local = chunk.match(/name="local_title"[^>]*value="([^"]*)"/);
    pageMeta.set(Number(act[1]), { title: decode(title[1]), localTitle: decode(local?.[1] ?? "") });
  }

  // Page items, per tab-pane.
  const pages = [];
  const paneRe = /<div[^>]*class="[^"]*tab-pane[^"]*"[^>]*id="tab(\d+)"[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*tab-pane|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/g;
  for (const m of html.matchAll(paneRe)) {
    const pageId = Number(m[2]);
    const items = [];
    for (const it of m[3].matchAll(
      /<li[^>]*data-name="([^"]*)"[^>]*data-ids="(\d+)"[^>]*title="(\d+)"[^>]*>([\s\S]*?)<\/li>/g
    )) {
      items.push({
        itemId: Number(it[2]),
        name: decode(it[1]),
        order: Number(it[3]),
        image: (it[4].match(/<img src="([^"]*)"/) || [])[1] || "",
        price: Number((it[4].match(/item-price[^>]*>([\d.]+)/) || [])[1] || 0) || null,
      });
    }
    const meta = pageMeta.get(pageId) || {};
    pages.push({ id: pageId, title: meta.title || "", localTitle: meta.localTitle || "", items });
  }

  return { menuId, pages, products, categories };
}

// ─── Read: the public menu (what the customer's browser gets) ────────────────
// Reads through the same api-party proxy the storefront uses, so this is
// literally the payload order.o2m8.me renders. `publicId`, not the dashboard id.
async function fetchPublicMenu(publicId = EXTERNAL_MENU_PUBLIC, branchId = 1) {
  const res = await fetch(PUBLIC_UPSTREAM, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: "https://qr.tabsense.ai/",
      "User-Agent": "freshcuts-menu",
    },
    body: JSON.stringify({
      path: `stores/${STORE}/menus/${publicId}`,
      method: "GET",
      headers: { "branch-id": String(branchId) },
    }),
  });
  if (!res.ok) throw new Error(`fetchPublicMenu(${publicId}): HTTP ${res.status}`);
  const d = await res.json();
  if (d?.meta?.code === 404) return null;
  return d.data ?? d;
}

// ─── Write: pages ────────────────────────────────────────────────────────────
// Pages invert the product convention, and it is easy to get backwards: a
// PRODUCT keeps Arabic in `name` and English in `local_name`, but a PAGE keeps
// English in `title` and Arabic in `local_title`. The storefront relies on it
// (`pageTitleOf` reads local_title first in Arabic), so a page created the
// other way round shows the customer an English section header.
async function createPage(menuId, { title, localTitle = "" }) {
  if (!title) throw new Error("createPage: title required");
  await apiForm(`/digital-menus/${menuId}/pages`, { title, local_title: localTitle }, menuId);
  // The route gives back a redirect, not the new id — resolve by title.
  const ed = await fetchMenuEditor(menuId);
  const page = ed.pages.filter((p) => p.title === title).sort((a, b) => b.id - a.id)[0];
  return { ok: true, id: page?.id ?? null, title };
}

async function updatePage(menuId, pageId, { title, localTitle }) {
  const fields = { _method: "PUT" };
  if (title !== undefined) fields.title = title;
  if (localTitle !== undefined) fields.local_title = localTitle;
  return apiForm(`/digital-menus/${menuId}/pages/${pageId}`, fields, menuId);
}

// Deletes a whole page (and its item rows). The products themselves are
// untouched — they stay in the POS and in the sidebar. Still, nothing in this
// module calls it automatically; it exists so a change can be rolled back.
async function deletePage(menuId, pageId) {
  return apiForm(`/digital-menus/${menuId}/pages/${pageId}`, { _method: "DELETE" }, menuId);
}

// Full ordering of the menu's pages, first to last. `pages_ids` goes over the
// wire as a JSON string — the editor's Sortable stringifies it into a hidden
// input, and the controller expects exactly that.
async function orderPages(menuId, pageIds) {
  return apiForm(
    `/digital-menus/${menuId}/order-pages`,
    { pages_ids: JSON.stringify(pageIds.map(String)) },
    menuId
  );
}

// ─── Write: items on a page ──────────────────────────────────────────────────
// `products` is [{ productId, order }] or a bare array of product ids.
// Returns the created page-item ids, which is what removal and reordering need.
async function addPageItems(pageId, products, menuId = EXTERNAL_MENU) {
  const list = (Array.isArray(products) ? products : [products]).map((p, i) =>
    typeof p === "object" ? p : { productId: p, order: i + 1 }
  );
  if (!list.length) return { ok: true, items: [] };
  const body = {
    items: list.map((p, i) => ({
      itemable_type: "product",
      itemable_id: String(p.productId),
      order: p.order ?? i + 1,
    })),
  };
  const res = await apiJson(`/digital-menu-pages/${pageId}/items`, "post", body, menuId);
  const items = res?.data?.items ?? [];
  return { ok: true, items: items.map((it) => ({ itemId: it.id, raw: it })) };
}

// itemId is the PAGE-ITEM id (data-ids), never the product id.
async function removePageItem(pageId, itemId, menuId = EXTERNAL_MENU) {
  return apiJson(`/digital-menu-pages/${pageId}/items/${itemId}`, "delete", undefined, menuId);
}

async function orderPageItems(pageId, itemIds, menuId = EXTERNAL_MENU) {
  return apiJson(
    `/digital-menu-pages/${pageId}/order-items`,
    "post",
    { items_ids: itemIds.map(String) },
    menuId
  );
}

// ─── Snapshot ────────────────────────────────────────────────────────────────
// Everything needed to put a menu back exactly as it was: page ids and order,
// item ids and order, and the product ids behind them. Written before any
// change this module makes.
async function snapshotMenu(menuId = EXTERNAL_MENU, publicId = EXTERNAL_MENU_PUBLIC) {
  const editor = await fetchMenuEditor(menuId);
  let publicMenu = null;
  try { publicMenu = await fetchPublicMenu(publicId); } catch { /* public read is best-effort */ }

  // Match each page item back to its product by name — the editor never prints
  // the product id inside the dropzone, and the name is unique per product.
  //
  // The sidebar alone is not enough. Roughly two dozen items on the external
  // menu (the fixed-weight "نصف كيلو / كيلو" cuts) no longer appear in the POS
  // product list at all, yet TabSense still serves them to customers. The
  // public payload keys each item by its product id, so it resolves them.
  const byName = new Map(editor.products.map((p) => [p.name, p.id]));
  for (const pg of publicMenu?.pages ?? []) {
    for (const it of pg.items ?? []) if (!byName.has(it.name)) byName.set(it.name, it.id);
  }
  const pages = editor.pages.map((p) => ({
    ...p,
    items: p.items.map((it) => ({ ...it, productId: byName.get(it.name) ?? null })),
  }));

  return {
    takenAt: new Date().toISOString(),
    store: STORE,
    menuId,
    publicId,
    pageOrder: editor.pages.map((p) => p.id),
    pages,
    categories: editor.categories,
    products: editor.products,
    publicMenu,
  };
}

// ─── Convenience: what the external menu is missing ──────────────────────────
// Compares POS products against the external menu and reports, per category,
// which dishes the customer simply cannot order.
async function menuGaps(menuId = EXTERNAL_MENU) {
  const ed = await fetchMenuEditor(menuId);
  const onMenu = new Set(ed.pages.flatMap((p) => p.items.map((i) => i.name)));
  const catName = new Map(ed.categories.map((c) => [c.id, c.name]));
  const gaps = new Map();
  for (const p of ed.products) {
    if (onMenu.has(p.name)) continue;
    const key = catName.get(p.categoryId) || `#${p.categoryId}`;
    if (!gaps.has(key)) gaps.set(key, []);
    gaps.get(key).push(p);
  }
  return {
    menuId,
    onMenu: onMenu.size,
    totalProducts: ed.products.length,
    missing: Object.fromEntries(gaps),
  };
}

export {
  listMenus,
  fetchMenuEditor,
  fetchPublicMenu,
  createPage,
  updatePage,
  deletePage,
  orderPages,
  addPageItems,
  removePageItem,
  orderPageItems,
  snapshotMenu,
  menuGaps,
  EXTERNAL_MENU,
  EXTERNAL_MENU_PUBLIC,
};
