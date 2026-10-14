/* ═══════════════════════════════════════════════════════════════════════════
   APP SYNC — صنف عندنا = صنف في كيتا = صنف في هنقرستيشن (٢٠٢٦-١٠-١٤)

   طلب عمر: «قفل وفتح الأصناف هيكون عند المدير… وهو بيقفل الصنف يوقفه على
   كيتا وهنجر». البوابة (soldout.js) بتنده sync() بعد ما تقفل/تفتح الصنف عندنا.

   الربط:
     • كيتا وهنقرستيشن منيوهم جاي من FeedUs بنفس الأسماء (٧٦/٧٦ متطابقين ١٤/١٠).
     • منيونا (أرقام تاب سينس ١–١٢٣) بأسماء قريبة: ٦٢ مطابقين بالظبط، والباقي
       فروق كتابة («كباب مشوي بالوزن» ↔ «كباب ثلث كيلو»، «موتزاريلا» ↔
       «موتزريلا»، «كولسلو» ↔ «كلوسلو»، «بيف الفريدو» ↔ «بنا بيف الفريدو»).
     • autoMatch بيعمل ده لوحده، والمالك بيصلّح أي سطر من شاشة «الربط»
       (app_item_map — اختيار يدوي بيكسب دايماً، و"" = «مش موجود في التطبيق»).
═══════════════════════════════════════════════════════════════════════════ */

const STOP = new Set(["مشوي", "مشويه", "مشوى", "بالوزن", "ثلث", "كيلو", "بنا"]);

export function normName(s) {
  return String(s || "")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
export const canonName = (s) => normName(s).split(" ").filter((w) => w && !STOP.has(w)).join(" ");
const sortedLetters = (s) => [...s.replace(/\s/g, "")].sort().join("");
function dice(a, b) {
  const bi = (s) => { const x = s.replace(/\s/g, ""); const out = []; for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2)); return out; };
  const A = bi(a), B = bi(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B]; let hit = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}

/** أحسن صنف في list (عناصره {id,name}) لاسم عندنا. بيرجّع {item, how} أو null. */
export function bestMatch(name, list, taken = new Set()) {
  const free = list.filter((x) => !taken.has(String(x.id)));
  const n = normName(name), c = canonName(name);
  const one = (arr) => (arr.length === 1 ? arr[0] : null);
  let it = one(free.filter((x) => normName(x.name) === n));
  if (it) return { item: it, how: "exact" };
  it = c && one(free.filter((x) => canonName(x.name) === c));
  if (it) return { item: it, how: "alias" };
  it = c.length >= 4 && one(free.filter((x) => sortedLetters(canonName(x.name)) === sortedLetters(c)));
  if (it) return { item: it, how: "alias" };
  const scored = free.map((x) => ({ x, s: dice(c, canonName(x.name)) })).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 0.8 && (!scored[1] || scored[0].s - scored[1].s >= 0.08)) return { item: scored[0].x, how: "similar" };
  return null;
}

/** سطر لكل صنف عندنا: {ourId, ourName, keeta, hs, how}. manual = Map(ourId → {keetaId, hsId}). */
export function buildMap(ours, keetaItems, hsItems, manual = new Map()) {
  const takenK = new Set(), takenH = new Set();
  for (const m of manual.values()) { if (m.keetaId) takenK.add(String(m.keetaId)); if (m.hsId) takenH.add(String(m.hsId)); }
  const kById = new Map(keetaItems.map((x) => [String(x.id), x]));
  const hById = new Map(hsItems.map((x) => [String(x.id), x]));
  const hByName = new Map(hsItems.map((x) => [normName(x.name), x]));
  // الأوتوماتيك على مرحلتين: الأدق الأول عشان «تشابه» مايخطفش صنف له تطابق مضبوط
  const rows = ours.map((o) => ({ ourId: String(o.id), ourName: o.name, category: o.category || null, keeta: null, hs: null, how: "none" }));
  for (const pass of ["exact", "alias", "similar"]) {
    for (const r of rows) {
      const m = manual.get(r.ourId);
      if (m) continue;
      if (r.keeta) continue;
      const hit = bestMatch(r.ourName, keetaItems, takenK);
      if (hit && hit.how === pass) { r.keeta = hit.item; r.how = pass; takenK.add(String(hit.item.id)); }
    }
  }
  for (const r of rows) {
    const m = manual.get(r.ourId);
    if (m) {
      r.how = "manual";
      r.keeta = m.keetaId ? kById.get(String(m.keetaId)) || { id: String(m.keetaId), name: "؟ مش لاقيه في منيو كيتا", missing: true } : null;
      r.hs = m.hsId ? hById.get(String(m.hsId)) || { id: String(m.hsId), name: "؟ مش لاقيه في منيو هنقرستيشن", missing: true } : null;
      continue;
    }
    // هنقرستيشن = نفس اسم كيتا بالظبط (الاتنين من FeedUs)، وإلا نطابق باسمنا
    if (r.keeta) r.hs = hByName.get(normName(r.keeta.name)) || null;
    if (!r.hs) { const h = bestMatch(r.ourName, hsItems, takenH); if (h) r.hs = h.item; }
    if (r.hs) takenH.add(String(r.hs.id));
  }
  const usedK = new Set(rows.map((r) => r.keeta && String(r.keeta.id)).filter(Boolean));
  const usedH = new Set(rows.map((r) => r.hs && String(r.hs.id)).filter(Boolean));
  return {
    rows,
    keetaUnlinked: keetaItems.filter((x) => !usedK.has(String(x.id))),
    hsUnlinked: hsItems.filter((x) => !usedH.has(String(x.id))),
  };
}

/** until بتاع البوابة → اللغة اللي كيتا وهنقرستيشن فاهمينها. */
export function portalUntil(until) {
  if (until === null || until === "manual") return "manual";
  if (!until || until === "reopen_next_open") return "open";
  return String(until);
}

export function register(app, ctx, { keeta, hs }) {
  const { pool, requireAdmin, getSettingsData } = ctx;

  pool.query(`
    CREATE TABLE IF NOT EXISTS app_item_map (
      our_id TEXT PRIMARY KEY,
      keeta_spu TEXT,          -- NULL = مش موجود في كيتا
      hs_product TEXT,         -- NULL = مش موجود في هنقرستيشن
      by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error("[app-sync] table:", e.message));

  const STORE = () => (process.env.CATALOG_MENU_BASE || process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  let ourCache = null;
  async function ourMenu() {
    if (ourCache && Date.now() - ourCache.at < 60_000) return ourCache.list;
    const r = await fetch(`${STORE()}/api/menu?branch_id=1&raw=1`, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "freshcuts-appsync" } });
    if (!r.ok) throw new Error(`منيو المتجر HTTP ${r.status}`);
    const j = await r.json();
    const seen = new Set(); const list = [];
    for (const p of j?.data?.pages || []) for (const it of p.items || []) {
      const id = String(it.id); if (seen.has(id)) continue; seen.add(id);
      list.push({ id, name: it.name || it.local_name || "", category: p.local_title || p.title || null });
    }
    ourCache = { at: Date.now(), list };
    return list;
  }
  async function manualMap() {
    const r = await pool.query("SELECT our_id, keeta_spu, hs_product, by, updated_at FROM app_item_map").catch(() => ({ rows: [] }));
    return new Map(r.rows.map((x) => [x.our_id, { keetaId: x.keeta_spu, hsId: x.hs_product, by: x.by, at: x.updated_at }]));
  }
  const side = (x) => (x ? { id: String(x.id), name: x.name, available: x.available !== false, missing: !!x.missing } : null);

  async function currentMap({ fresh = false } = {}) {
    const [ours, km, hm, manual] = await Promise.all([
      ourMenu(),
      keeta.readMenu(fresh).then((m) => m.list.map((s) => ({ id: String(s.id), name: s.name, available: s.status === 1 }))).catch((e) => ({ error: e.message })),
      hs.readMenu(fresh).then((m) => m.items).catch((e) => ({ error: e.message })),
      manualMap(),
    ]);
    const kItems = Array.isArray(km) ? km : [], hItems = Array.isArray(hm) ? hm : [];
    const built = buildMap(ours, kItems, hItems, manual);
    return {
      ...built,
      errors: { keeta: km?.error || null, hs: hm?.error || null },
      rows: built.rows.map((r) => ({ ...r, keeta: side(r.keeta), hs: side(r.hs) })),
      keetaUnlinked: built.keetaUnlinked.map(side), hsUnlinked: built.hsUnlinked.map(side),
    };
  }

  /* البوابة: المدير قفل/فتح صنف عندنا ← نفس الصنف في كيتا وهنقرستيشن.
     بيرجّع لكل تطبيق {ok, skipped?, error?} — البوابة بتعرضه للمدير. */
  async function sync({ productId, soldOut, until, by = null }) {
    const out = { keeta: null, hs: null };
    try {
      const settings = await getSettingsData();
      if (settings?.keeta?.control?.syncPortal === false) {
        return { keeta: { ok: false, skipped: "off" }, hs: { ok: false, skipped: "off" } };
      }
      const map = await currentMap();
      const row = map.rows.find((r) => r.ourId === String(productId));
      const via = `البوابة · ${by || "المدير"}`;
      const u = soldOut ? portalUntil(until) : undefined;
      const job = (ctl, ids) => (ids
        ? Promise.race([
            ctl.applyAvailability({ ids, available: !soldOut, until: u, via }),
            new Promise((res) => setTimeout(() => res({ ok: false, pending: true, error: "لسه بيتطبّق — هيبان في السجل" }), 15000)),
          ])
        : Promise.resolve({ ok: false, skipped: "not_linked" }));
      const [k, h] = await Promise.all([
        job(keeta, row?.keeta && !row.keeta.missing ? [row.keeta.id] : null),
        job(hs, row?.hs && !row.hs.missing ? [row.hs.id] : null),
      ]);
      out.keeta = k; out.hs = h;
    } catch (e) {
      out.keeta = out.keeta || { ok: false, error: e.message };
      out.hs = out.hs || { ok: false, error: e.message };
    }
    return out;
  }

  app.get("/api/apps/map", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json({ ok: true, ...(await currentMap({ fresh: c.req.query("fresh") === "1" })) }); }
    catch (e) { return c.json({ ok: false, error: e.message }); }
  });

  /* اختيار يدوي: keetaId / hsId = رقم الصنف، أو "" = «مش موجود في التطبيق ده». */
  app.put("/api/apps/map/:ourId", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const ourId = String(c.req.param("ourId"));
    if (!/^\d{1,12}$/.test(ourId)) return c.json({ ok: false, error: "رقم الصنف غلط" });
    const b = await c.req.json().catch(() => ({}));
    const clean = (v) => (v === "" || v === null ? null : /^\d{3,}$/.test(String(v)) ? String(v) : undefined);
    const k = clean(b.keetaId), h = clean(b.hsId);
    if (k === undefined || h === undefined) return c.json({ ok: false, error: "رقم صنف التطبيق غلط" });
    const by = (await ctx.cmsWho?.(c).catch(() => null)) || null;
    await pool.query(
      `INSERT INTO app_item_map(our_id, keeta_spu, hs_product, by, updated_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (our_id) DO UPDATE SET keeta_spu=$2, hs_product=$3, by=$4, updated_at=NOW()`, [ourId, k, h, by]);
    await ctx.auditNote?.(c, `ربط التطبيقات: صنف ${ourId} ← كيتا ${k || "—"} · هنقرستيشن ${h || "—"}`);
    return c.json({ ok: true });
  });
  app.delete("/api/apps/map/:ourId", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM app_item_map WHERE our_id=$1", [String(c.req.param("ourId"))]);
    return c.json({ ok: true });
  });

  console.log("[app-sync] routes ready");
  return { sync, currentMap };
}
