import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import pg from "pg";
import crypto from "node:crypto";
import * as ts from "./tabsense.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // bearer token for admin requests
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ADMIN_TOKEN; // human-friendly password to log in (falls back to token)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const PORT = Number(process.env.PORT || 3000);

// ─── TabSense automation config ────────────────────────────────────────────────
const TS_ENABLED = !!(process.env.TABSENSE_EMAIL && process.env.TABSENSE_PASSWORD);
const TS_AUTOSYNC = (process.env.TABSENSE_AUTOSYNC ?? "1") !== "0";
const TS_AUTOPUSH = (process.env.TABSENSE_AUTOPUSH ?? "1") !== "0";
const TS_SYNC_MINUTES = Math.max(1, Number(process.env.TABSENSE_SYNC_MINUTES || 5));
const TS_DEFAULT_PROMOTION = process.env.TABSENSE_PROMOTION_ID ? Number(process.env.TABSENSE_PROMOTION_ID) : null;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

// Normalize phone: digits only, strip leading 966/0/00
function normPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) return d.slice(5);
  if (d.startsWith("966")) return d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d.slice(1);
  return d;
}

// pg's default param binder does NOT serialize JS objects/arrays to JSONB.
// Use this for every JSONB parameter to force JSON encoding.
function jb(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v; // assume already-serialized JSON
  return JSON.stringify(v);
}

const app = new Hono();

app.use("*", cors({
  origin: (origin) => {
    if (!origin) return "*";
    if (ALLOWED_ORIGINS.includes("*")) return origin;
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  },
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Auth helpers
function getAuth(c) {
  const h = c.req.header("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7);
  if (token === ADMIN_TOKEN) return { kind: "admin" };
  // Ambassador token format: "amb:<id>:<password>"
  if (token.startsWith("amb:")) {
    const [, id, pw] = token.split(":");
    if (id && pw) return { kind: "ambassador", id, pw };
  }
  return null;
}
async function requireAdmin(c) {
  const a = getAuth(c);
  if (!a || a.kind !== "admin") return c.json({ error: "Unauthorized" }, 401);
  return null;
}
async function requireAmbassadorOrAdmin(c) {
  const a = getAuth(c);
  if (!a) return c.json({ error: "Unauthorized" }, 401);
  if (a.kind === "admin") return null;
  // Verify ambassador credentials match DB
  const r = await pool.query("SELECT password FROM ambassadors WHERE id=$1", [a.id]);
  if (!r.rowCount || r.rows[0].password !== a.pw) return c.json({ error: "Unauthorized" }, 401);
  return null;
}
async function getCallerAmbassadorId(c) {
  const a = getAuth(c);
  if (!a) return null;
  if (a.kind === "admin") return null;
  const r = await pool.query("SELECT id, password FROM ambassadors WHERE id=$1", [a.id]);
  if (!r.rowCount || r.rows[0].password !== a.pw) return null;
  return r.rows[0].id;
}

// Row → API mappers (snake_case → camelCase)
function ambRow(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone || "",
    password: r.password,
    customMessage: r.custom_message || "",
    createdAt: r.created_at,
  };
}
function batchRow(r) {
  return {
    id: r.id,
    campaignName: r.campaign_name,
    ambassadorId: r.ambassador_id,
    discountPercent: r.discount_percent,
    validityDate: r.validity_date instanceof Date ? r.validity_date.toISOString().slice(0, 10) : r.validity_date,
    codePrefix: r.code_prefix || "",
    offerDescription: r.offer_description || "",
    bannerTemplateId: r.banner_template_id || "",
    customText: r.custom_text || {},
    customColors: r.custom_colors || {},
    source: r.source || "auto",
    status: r.status || "draft",
    promotionId: r.promotion_id ?? null,
    tabSenseUploaded: r.tab_sense_uploaded,
    exportedAt: r.exported_at,
    createdAt: r.created_at,
  };
}
function codeRow(r) {
  return {
    code: r.code,
    batchId: r.batch_id,
    ambassadorId: r.ambassador_id,
    friendName: r.friend_name || "",
    friendPhone: r.friend_phone || "",
    redeemed: r.redeemed,
    redeemedAt: r.redeemed_at,
    createdAt: r.created_at,
  };
}
function designRow(r) {
  return {
    id: r.id,
    name: r.name,
    imageUrl: r.image_url,
    width: r.width,
    height: r.height,
    fields: r.fields || [],
    createdAt: r.created_at,
  };
}

// ─── Health ──────────────────────────────────────────────────────────────────
app.get("/health", async (c) => {
  try {
    await pool.query("SELECT 1");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  }
});

// ─── Auth ────────────────────────────────────────────────────────────────────
app.post("/api/auth/admin", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || password !== ADMIN_PASSWORD) return c.json({ ok: false }, 401);
  return c.json({ ok: true, token: ADMIN_TOKEN });
});

app.post("/api/auth/ambassador", async (c) => {
  const { phone, password } = await c.req.json().catch(() => ({}));
  if (!phone || !password) return c.json({ ok: false, error: "phone & password required" }, 400);
  const np = normPhone(phone);
  const r = await pool.query(
    "SELECT * FROM ambassadors WHERE (phone_norm = $1 AND phone_norm <> '') OR LOWER(name) = LOWER($2) LIMIT 1",
    [np, String(phone).trim()]
  );
  if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
  const a = r.rows[0];
  if (a.password !== password) return c.json({ ok: false, error: "wrong_password" }, 401);
  return c.json({ ok: true, ambassador: ambRow(a), token: `amb:${a.id}:${a.password}` });
});

// ─── Settings ────────────────────────────────────────────────────────────────
app.get("/api/settings", async (c) => {
  const err = await requireAmbassadorOrAdmin(c);
  if (err) return err;
  const r = await pool.query("SELECT data FROM settings WHERE id=1");
  return c.json(r.rows[0]?.data || {});
});
app.put("/api/settings", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const body = await c.req.json();
  await pool.query("UPDATE settings SET data=$1::jsonb, updated_at=NOW() WHERE id=1", [jb(body)]);
  return c.json({ ok: true });
});

// ─── Ambassadors ─────────────────────────────────────────────────────────────
app.get("/api/ambassadors", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const r = await pool.query("SELECT * FROM ambassadors ORDER BY created_at DESC");
  return c.json(r.rows.map(ambRow));
});
app.post("/api/ambassadors", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  const np = normPhone(b.phone);
  await pool.query(
    `INSERT INTO ambassadors (id, name, phone, phone_norm, password, custom_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))`,
    [b.id, b.name, b.phone || "", np, b.password, b.customMessage || "", b.createdAt || null]
  );
  return c.json({ ok: true });
});
app.put("/api/ambassadors/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const id = c.req.param("id");
  const b = await c.req.json();
  const np = normPhone(b.phone);
  await pool.query(
    `UPDATE ambassadors SET name=$2, phone=$3, phone_norm=$4, password=$5, custom_message=$6, updated_at=NOW()
     WHERE id=$1`,
    [id, b.name, b.phone || "", np, b.password, b.customMessage || ""]
  );
  return c.json({ ok: true });
});
app.delete("/api/ambassadors/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM ambassadors WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Batches ─────────────────────────────────────────────────────────────────
app.get("/api/batches", async (c) => {
  const auth = getAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  let q, args;
  if (auth.kind === "admin") {
    q = "SELECT * FROM batches ORDER BY created_at DESC";
    args = [];
  } else {
    const ambId = await getCallerAmbassadorId(c);
    if (!ambId) return c.json({ error: "Unauthorized" }, 401);
    q = "SELECT * FROM batches WHERE ambassador_id=$1 ORDER BY created_at DESC";
    args = [ambId];
  }
  const r = await pool.query(q, args);
  return c.json(r.rows.map(batchRow));
});
app.post("/api/batches", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  await pool.query(
    `INSERT INTO batches (id, campaign_name, ambassador_id, discount_percent, validity_date, code_prefix,
       offer_description, banner_template_id, custom_text, custom_colors, source, status, promotion_id, tab_sense_uploaded,
       exported_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16::timestamptz, NOW()))`,
    [
      b.id, b.campaignName, b.ambassadorId, b.discountPercent, b.validityDate,
      b.codePrefix || "", b.offerDescription || "", b.bannerTemplateId || "",
      jb(b.customText || {}), jb(b.customColors || {}), b.source || "auto", b.status || "draft",
      b.promotionId ?? null, !!b.tabSenseUploaded, b.exportedAt || null, b.createdAt || null,
    ]
  );
  return c.json({ ok: true });
});
app.put("/api/batches/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const id = c.req.param("id");
  const b = await c.req.json();
  // tab_sense_uploaded is promote-only (existing OR incoming) and exported_at is
  // preserved when omitted — so an edit carrying a stale client copy can never
  // clear the flag/timestamp the TabSense worker set. See pushBatch/runAutoPush.
  await pool.query(
    `UPDATE batches SET campaign_name=$2, discount_percent=$3, validity_date=$4, code_prefix=$5,
       offer_description=$6, banner_template_id=$7, custom_text=$8, custom_colors=$9,
       status=$10, tab_sense_uploaded=(tab_sense_uploaded OR $11), exported_at=COALESCE($12, exported_at),
       promotion_id=COALESCE($13, promotion_id), updated_at=NOW()
     WHERE id=$1`,
    [
      id, b.campaignName, b.discountPercent, b.validityDate, b.codePrefix || "",
      b.offerDescription || "", b.bannerTemplateId || "", jb(b.customText || {}),
      jb(b.customColors || {}), b.status || "draft", !!b.tabSenseUploaded, b.exportedAt || null,
      b.promotionId ?? null,
    ]
  );
  return c.json({ ok: true });
});
app.delete("/api/batches/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM batches WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Codes ───────────────────────────────────────────────────────────────────
app.get("/api/codes", async (c) => {
  const auth = getAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  let q, args;
  if (auth.kind === "admin") {
    q = "SELECT * FROM codes ORDER BY created_at DESC";
    args = [];
  } else {
    const ambId = await getCallerAmbassadorId(c);
    if (!ambId) return c.json({ error: "Unauthorized" }, 401);
    q = "SELECT * FROM codes WHERE ambassador_id=$1 ORDER BY created_at DESC";
    args = [ambId];
  }
  const r = await pool.query(q, args);
  return c.json(r.rows.map(codeRow));
});
app.post("/api/codes/bulk", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const arr = await c.req.json();
  if (!Array.isArray(arr) || arr.length === 0) return c.json({ ok: true, inserted: 0 });
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const x of arr) {
      await client.query(
        `INSERT INTO codes (code, batch_id, ambassador_id, friend_name, friend_phone, redeemed, redeemed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
         ON CONFLICT (code) DO NOTHING`,
        [
          x.code, x.batchId, x.ambassadorId, x.friendName || "", x.friendPhone || "",
          !!x.redeemed, x.redeemedAt || null, x.createdAt || null,
        ]
      );
      inserted++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return c.json({ ok: true, inserted });
});
app.put("/api/codes/:code", async (c) => {
  // Ambassador can only update their own code; admin can update any
  const auth = getAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  const code = c.req.param("code");
  const b = await c.req.json();
  if (auth.kind === "ambassador") {
    const ambId = await getCallerAmbassadorId(c);
    if (!ambId) return c.json({ error: "Unauthorized" }, 401);
    const cur = await pool.query("SELECT ambassador_id FROM codes WHERE code=$1", [code]);
    if (!cur.rowCount || cur.rows[0].ambassador_id !== ambId) return c.json({ error: "Forbidden" }, 403);
  }
  await pool.query(
    `UPDATE codes SET friend_name=$2, friend_phone=$3, redeemed=$4, redeemed_at=$5, updated_at=NOW()
     WHERE code=$1`,
    [code, b.friendName || "", b.friendPhone || "", !!b.redeemed, b.redeemedAt || null]
  );
  return c.json({ ok: true });
});
app.delete("/api/codes/:code", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM codes WHERE code=$1", [c.req.param("code")]);
  return c.json({ ok: true });
});

// ─── Designs ─────────────────────────────────────────────────────────────────
app.get("/api/designs", async (c) => {
  const err = await requireAmbassadorOrAdmin(c); if (err) return err;
  const r = await pool.query("SELECT * FROM designs ORDER BY created_at DESC");
  return c.json(r.rows.map(designRow));
});
app.post("/api/designs", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  await pool.query(
    `INSERT INTO designs (id, name, image_url, width, height, fields, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, COALESCE($7::timestamptz, NOW()))`,
    [b.id, b.name, b.imageUrl, b.width || null, b.height || null, jb(b.fields || []), b.createdAt || null]
  );
  return c.json({ ok: true });
});
app.put("/api/designs/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const id = c.req.param("id");
  const b = await c.req.json();
  await pool.query(
    `UPDATE designs SET name=$2, image_url=$3, width=$4, height=$5, fields=$6::jsonb, updated_at=NOW()
     WHERE id=$1`,
    [id, b.name, b.imageUrl, b.width || null, b.height || null, jb(b.fields || [])]
  );
  return c.json({ ok: true });
});
app.delete("/api/designs/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM designs WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Sync redeemed codes ─────────────────────────────────────────────────────
// Core: given normalized entries [{code, at}], mark existing codes as redeemed.
// Shared by the manual paste route and the automatic TabSense worker.
async function applyRedeemed(entries) {
  const matched = [], unknown = [], alreadyRedeemed = [];
  if (!entries.length) {
    return { total: 0, matched: 0, unknown: 0, alreadyRedeemed: 0, matchedCodes: [], unknownCodes: [], alreadyRedeemedCodes: [] };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      const r = await client.query("SELECT code, redeemed FROM codes WHERE code = $1", [e.code]);
      if (!r.rowCount) { unknown.push(e.code); continue; }
      if (r.rows[0].redeemed) { alreadyRedeemed.push(e.code); continue; }
      const at = e.at || new Date().toISOString();
      await client.query(
        "UPDATE codes SET redeemed = true, redeemed_at = COALESCE($2::timestamptz, NOW()), updated_at = NOW() WHERE code = $1",
        [e.code, at]
      );
      matched.push(e.code);
    }
    await client.query("COMMIT");
  } catch (ex) {
    await client.query("ROLLBACK");
    throw ex;
  } finally {
    client.release();
  }
  return {
    total: entries.length,
    matched: matched.length,
    unknown: unknown.length,
    alreadyRedeemed: alreadyRedeemed.length,
    matchedCodes: matched.slice(0, 200),
    unknownCodes: unknown.slice(0, 200),
    alreadyRedeemedCodes: alreadyRedeemed.slice(0, 200),
  };
}

// Manual paste: { codes: ["AB-XYZ", { code:"AB-XYZ", date:"2026-05-24" }, ...], redeemedAt? }
app.post("/api/sync/redeemed", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const arr = Array.isArray(body.codes) ? body.codes : [];
  const defaultAt = body.redeemedAt || null;

  const entries = [];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === "string") {
      const s = item.trim();
      if (s) entries.push({ code: s, at: defaultAt });
    } else if (typeof item === "object") {
      const s = (item.code || "").trim();
      if (s) entries.push({ code: s, at: item.date || item.redeemedAt || defaultAt });
    }
  }
  if (entries.length === 0) return c.json({ ok: false, error: "no_codes" }, 400);

  const result = await applyRedeemed(entries);
  return c.json({ ok: true, ...result });
});

// ─── Bulk import (one-shot migration from localStorage) ──────────────────────
app.post("/api/import", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const body = await c.req.json();
  const client = await pool.connect();
  const stats = { settings: 0, ambassadors: 0, batches: 0, codes: 0, designs: 0 };
  try {
    await client.query("BEGIN");
    if (body.settings) {
      await client.query("UPDATE settings SET data=$1::jsonb, updated_at=NOW() WHERE id=1", [jb(body.settings)]);
      stats.settings = 1;
    }
    for (const a of (body.ambassadors || [])) {
      const np = normPhone(a.phone);
      await client.query(
        `INSERT INTO ambassadors (id, name, phone, phone_norm, password, custom_message, created_at)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, NOW()))
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone,
           phone_norm=EXCLUDED.phone_norm, password=EXCLUDED.password,
           custom_message=EXCLUDED.custom_message, updated_at=NOW()`,
        [a.id, a.name, a.phone || "", np, a.password, a.customMessage || "", a.createdAt || null]
      );
      stats.ambassadors++;
    }
    for (const b of (body.batches || [])) {
      await client.query(
        `INSERT INTO batches (id, campaign_name, ambassador_id, discount_percent, validity_date, code_prefix,
           offer_description, banner_template_id, custom_text, custom_colors, source, status, tab_sense_uploaded,
           exported_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15::timestamptz, NOW()))
         ON CONFLICT (id) DO UPDATE SET campaign_name=EXCLUDED.campaign_name,
           discount_percent=EXCLUDED.discount_percent, validity_date=EXCLUDED.validity_date,
           code_prefix=EXCLUDED.code_prefix, offer_description=EXCLUDED.offer_description,
           banner_template_id=EXCLUDED.banner_template_id, custom_text=EXCLUDED.custom_text,
           custom_colors=EXCLUDED.custom_colors, status=EXCLUDED.status,
           tab_sense_uploaded=EXCLUDED.tab_sense_uploaded, exported_at=EXCLUDED.exported_at, updated_at=NOW()`,
        [
          b.id, b.campaignName, b.ambassadorId, b.discountPercent, b.validityDate,
          b.codePrefix || "", b.offerDescription || "", b.bannerTemplateId || "",
          jb(b.customText || {}), jb(b.customColors || {}), b.source || "auto", b.status || "draft",
          !!b.tabSenseUploaded, b.exportedAt || null, b.createdAt || null,
        ]
      );
      stats.batches++;
    }
    for (const x of (body.codes || [])) {
      await client.query(
        `INSERT INTO codes (code, batch_id, ambassador_id, friend_name, friend_phone, redeemed, redeemed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
         ON CONFLICT (code) DO UPDATE SET batch_id=EXCLUDED.batch_id, ambassador_id=EXCLUDED.ambassador_id,
           friend_name=EXCLUDED.friend_name, friend_phone=EXCLUDED.friend_phone,
           redeemed=EXCLUDED.redeemed, redeemed_at=EXCLUDED.redeemed_at, updated_at=NOW()`,
        [
          x.code, x.batchId, x.ambassadorId, x.friendName || "", x.friendPhone || "",
          !!x.redeemed, x.redeemedAt || null, x.createdAt || null,
        ]
      );
      stats.codes++;
    }
    for (const d of (body.designs || [])) {
      await client.query(
        `INSERT INTO designs (id, name, image_url, width, height, fields, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb, COALESCE($7::timestamptz, NOW()))
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, image_url=EXCLUDED.image_url,
           width=EXCLUDED.width, height=EXCLUDED.height, fields=EXCLUDED.fields, updated_at=NOW()`,
        [d.id, d.name, d.imageUrl, d.width || null, d.height || null, jb(d.fields || []), d.createdAt || null]
      );
      stats.designs++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return c.json({ ok: true, stats });
});

// ─── TabSense worker: auto-push new batches + auto-sync redemptions ──────────
const tsState = {
  enabled: TS_ENABLED,
  autoSync: TS_AUTOSYNC,
  autoPush: TS_AUTOPUSH,
  intervalMinutes: TS_SYNC_MINUTES,
  running: false,
  lastSyncAt: null,
  lastSyncResult: null,
  lastPushAt: null,
  lastPushResult: null,
  lastError: null,
};
const pushingBatches = new Set(); // in-flight guard to avoid double upload

async function getSettingsData() {
  const r = await pool.query("SELECT data FROM settings WHERE id=1");
  return r.rows[0]?.data || {};
}

// Map an ambassador batch's discount% to a TabSense promotion id.
// Priority: settings.tabsense.promotionMap[pct] → settings.tabsense.defaultPromotionId → env.
function resolvePromotionId(discountPercent, settings) {
  const cfg = settings?.tabsense || {};
  const map = cfg.promotionMap || {};
  const byPct = map[String(discountPercent)];
  if (byPct) return Number(byPct);
  if (cfg.defaultPromotionId) return Number(cfg.defaultPromotionId);
  if (TS_DEFAULT_PROMOTION) return TS_DEFAULT_PROMOTION;
  return null;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Upload one batch's codes to TabSense. Returns { ok, uploaded } or throws.
// `existing` (optional) = Set of code strings already on TabSense; when any of
// this batch's codes are in it, we skip the upload (idempotency guard against
// duplicate batches — covers legacy batches, retries, and crash-after-upload).
async function pushBatch(batch, settings, existing, overridePromotionId) {
  // Prefer an explicit offer: override arg → the batch's stored promotion_id →
  // discount%→promotion mapping. Persist the resolved id back to the batch.
  const promotionId = overridePromotionId || batch.promotion_id || resolvePromotionId(batch.discount_percent, settings);
  if (!promotionId) {
    const e = new Error(`no_promotion_mapping_for_${batch.discount_percent}%`);
    e.code = "NO_PROMOTION";
    throw e;
  }
  if (batch.promotion_id !== promotionId) {
    await pool.query("UPDATE batches SET promotion_id=$2, updated_at=NOW() WHERE id=$1", [batch.id, promotionId]);
  }
  const codesR = await pool.query("SELECT code FROM codes WHERE batch_id=$1", [batch.id]);
  const codes = codesR.rows.map((r) => r.code);
  if (!codes.length) return { ok: true, uploaded: 0, skipped: "no_codes" };

  // Idempotency PER CODE: upload only codes not already on TabSense. This makes
  // push safe to call repeatedly (legacy batches, retries, crash-after-upload)
  // AND lets us top up an existing batch — only the new codes get uploaded.
  const existingSet = existing || await ts.fetchExistingCodeSet();
  const toUpload = codes.filter((c) => !existingSet.has(c));
  if (toUpload.length === 0) {
    await pool.query("UPDATE batches SET tab_sense_uploaded=true, updated_at=NOW() WHERE id=$1", [batch.id]);
    return { ok: true, uploaded: 0, skipped: "already_on_tabsense" };
  }

  const validity = batch.validity_date instanceof Date
    ? batch.validity_date.toISOString().slice(0, 10)
    : String(batch.validity_date || "").slice(0, 10);

  const res = await ts.uploadCodeBatch({
    promotionId,
    batchName: batch.campaign_name,
    startDate: todayISO(),
    endDate: validity || todayISO(),
    usageLimit: 1,
    codes: toUpload,
  });

  // Confirm the upload actually landed before marking uploaded. TabSense may
  // return HTTP 200 with an error/challenge page; only re-reading the codes
  // proves success. If nothing landed, throw so it's retried next cycle
  // (codes aren't on TabSense, so no duplicate risk).
  const after = await ts.fetchExistingCodeSet();
  const landed = toUpload.filter((c) => after.has(c)).length;
  if (landed === 0) {
    const e = new Error("upload_not_confirmed: no codes found on TabSense after upload");
    e.code = "UPLOAD_UNCONFIRMED";
    throw e;
  }

  await pool.query(
    "UPDATE batches SET tab_sense_uploaded=true, exported_at=NOW(), updated_at=NOW() WHERE id=$1",
    [batch.id]
  );
  return { ...res, uploaded: toUpload.length, confirmed: landed };
}

async function runAutoSync() {
  const { codes, scanned, batches } = await ts.fetchAllRedeemedCodes();
  const entries = codes.map((code) => ({ code, at: null }));
  const result = await applyRedeemed(entries);
  tsState.lastSyncAt = new Date().toISOString();
  tsState.lastSyncResult = { ...result, tabSenseCodes: codes.length, scanned, batches };
  return tsState.lastSyncResult;
}

async function runAutoPush() {
  const pending = await pool.query(
    "SELECT * FROM batches WHERE source='auto' AND tab_sense_uploaded=false ORDER BY created_at ASC LIMIT 25"
  );
  if (!pending.rows.length) return []; // common case: no TabSense calls at all
  const settings = await getSettingsData();
  // Build the existing-code set ONCE per sweep (idempotency guard for every batch).
  const existing = await ts.fetchExistingCodeSet();
  const results = [];
  for (const b of pending.rows) {
    if (pushingBatches.has(b.id)) continue;
    pushingBatches.add(b.id);
    try {
      const r = await pushBatch(b, settings, existing);
      results.push({ id: b.id, name: b.campaign_name, ...r });
    } catch (e) {
      results.push({ id: b.id, name: b.campaign_name, ok: false, error: e.message });
    } finally {
      pushingBatches.delete(b.id);
    }
  }
  if (results.length) {
    tsState.lastPushAt = new Date().toISOString();
    tsState.lastPushResult = results;
  }
  return results;
}

async function runCycle() {
  if (!TS_ENABLED || tsState.running) return;
  tsState.running = true;
  try {
    if (TS_AUTOPUSH) await runAutoPush();   // push before sync so fresh codes can be read back
    if (TS_AUTOSYNC) await runAutoSync();
    tsState.lastError = null;
  } catch (e) {
    tsState.lastError = { at: new Date().toISOString(), message: e.message };
    console.error("[tabsense] cycle error:", e.message);
  } finally {
    tsState.running = false;
  }
}

// ─── TabSense endpoints ─────────────────────────────────────────────────────────
app.get("/api/tabsense/status", async (c) => {
  // Admin-only: tsState.lastSyncResult carries code lists spanning ALL
  // ambassadors, so it must not be exposed to a single ambassador.
  const err = await requireAdmin(c); if (err) return err;
  return c.json(tsState);
});

app.post("/api/tabsense/sync-now", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  try {
    const push = TS_AUTOPUSH ? await runAutoPush() : [];
    const sync = await runAutoSync();
    return c.json({ ok: true, push, sync });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Full promotions list (id, name, type, dates, active) for the offers manager.
app.get("/api/tabsense/promotions", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  try {
    const promotions = await ts.listPromotionsFull();
    return c.json({ ok: true, promotions });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Create an offer (simplified % or fixed discount that requires an ambassador code).
// Body: { name, value, discountType?, startDate, endDate, active? }
app.post("/api/tabsense/promotions", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || b.value == null || !b.startDate || !b.endDate) {
    return c.json({ ok: false, error: "name, value, startDate, endDate required" }, 400);
  }
  try {
    const created = await ts.createPromotion({
      name: String(b.name).trim(),
      value: b.value,
      discountType: b.discountType === "fixed" || b.discountType === 1 ? 1 : 2,
      startDate: b.startDate,
      endDate: b.endDate,
    });
    // Optionally deactivate right away (created active by default).
    if (created.id && b.active === false) {
      await ts.setPromotionActive(created.id, false).catch(() => {});
    }
    return c.json({ ok: true, ...created });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Toggle / set an offer's active state. Body: { active?: boolean } (omit to flip).
app.post("/api/tabsense/promotions/:id/toggle", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const id = Number(c.req.param("id"));
  const b = await c.req.json().catch(() => ({}));
  try {
    if (typeof b.active === "boolean") {
      const r = await ts.setPromotionActive(id, b.active);
      return c.json({ ok: true, ...r });
    }
    const r = await ts.togglePromotionActive(id);
    return c.json({ ok: true, toggled: true, raw: r });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Push a batch to TabSense on demand. Body: { promotionId? } to link/relink an
// offer. Safe to call repeatedly and after adding codes — only new codes upload.
app.post("/api/batches/:id/push", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const overridePromotionId = body.promotionId ? Number(body.promotionId) : null;
  const r = await pool.query("SELECT * FROM batches WHERE id=$1", [id]);
  if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
  const batch = r.rows[0];
  if (pushingBatches.has(id)) return c.json({ ok: false, error: "already_in_progress" }, 409);
  pushingBatches.add(id);
  try {
    const settings = await getSettingsData();
    const res = await pushBatch(batch, settings, null, overridePromotionId);
    return c.json({ ok: true, ...res });
  } catch (e) {
    const status = e.code === "NO_PROMOTION" ? 422 : 500;
    return c.json({ ok: false, error: e.message }, status);
  } finally {
    pushingBatches.delete(id);
  }
});

// ─── Quick add codes to an ambassador (new batch or top up an existing one) ─────
// Server-side code generation + insert + TabSense upload, all in one call.
// Body: { count, promotionId, discountPercent?, validityDate?, campaignName?, batchId?, codePrefix? }
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randToken(n) {
  let s = "";
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return s;
}

app.post("/api/ambassadors/:id/generate-codes", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const ambId = c.req.param("id");
  const b = await c.req.json().catch(() => ({}));
  const count = Math.max(1, Math.min(500, Number(b.count) || 0));
  if (!count) return c.json({ ok: false, error: "count required (1-500)" }, 400);
  const promotionId = b.promotionId ? Number(b.promotionId) : null;
  if (!promotionId) return c.json({ ok: false, error: "promotionId (offer) required" }, 400);

  const ambR = await pool.query("SELECT * FROM ambassadors WHERE id=$1", [ambId]);
  if (!ambR.rowCount) return c.json({ ok: false, error: "ambassador_not_found" }, 404);
  const amb = ambR.rows[0];

  // Prefix: explicit → existing batch prefix → derived from ambassador name.
  const derivePrefix = (name) => {
    const ascii = String(name || "").toUpperCase().replace(/[^A-Z]/g, "");
    return (ascii.slice(0, 3) || "AMB");
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Resolve / create the target batch.
    let batch;
    if (b.batchId) {
      const r = await client.query("SELECT * FROM batches WHERE id=$1 AND ambassador_id=$2", [b.batchId, ambId]);
      if (!r.rowCount) { await client.query("ROLLBACK"); return c.json({ ok: false, error: "batch_not_found" }, 404); }
      batch = r.rows[0];
    } else {
      const prefix = (b.codePrefix || derivePrefix(amb.name)).toUpperCase();
      const id = "b" + randToken(10).toLowerCase();
      const discount = Number(b.discountPercent) || 15;
      const validity = b.validityDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const name = (b.campaignName || `${amb.name} ${discount}%`).trim();
      await client.query(
        `INSERT INTO batches (id, campaign_name, ambassador_id, discount_percent, validity_date, code_prefix,
           offer_description, banner_template_id, custom_text, custom_colors, source, status, promotion_id, tab_sense_uploaded, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'','','{}'::jsonb,'{}'::jsonb,'auto','draft',$7,false,NOW())`,
        [id, name, ambId, discount, validity, prefix, promotionId]
      );
      batch = (await client.query("SELECT * FROM batches WHERE id=$1", [id])).rows[0];
    }

    // Generate `count` unique codes (collision-checked against the whole codes table).
    const existingR = await client.query("SELECT code FROM codes");
    const used = new Set(existingR.rows.map((r) => r.code));
    const prefix = (batch.code_prefix || derivePrefix(amb.name)).toUpperCase();
    const newCodes = [];
    let guard = 0;
    while (newCodes.length < count && guard < count * 50) {
      guard++;
      const code = `${prefix}-${randToken(4)}`;
      if (used.has(code)) continue;
      used.add(code); newCodes.push(code);
    }
    for (const code of newCodes) {
      await client.query(
        `INSERT INTO codes (code, batch_id, ambassador_id, redeemed, created_at)
         VALUES ($1,$2,$3,false,NOW()) ON CONFLICT (code) DO NOTHING`,
        [code, batch.id, ambId]
      );
    }
    await client.query("COMMIT");

    // Upload the new codes to TabSense under the chosen offer.
    let push = null;
    try {
      push = await pushBatch(batch, await getSettingsData(), null, promotionId);
    } catch (e) {
      push = { ok: false, error: e.message };
    }
    return c.json({ ok: true, batchId: batch.id, campaignName: batch.campaign_name, generated: newCodes.length, codes: newCodes, push });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return c.json({ ok: false, error: e.message }, 500);
  } finally {
    client.release();
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`freshcuts-api listening on http://0.0.0.0:${info.port}`);
  if (TS_ENABLED) {
    console.log(`[tabsense] worker on — sync=${TS_AUTOSYNC} push=${TS_AUTOPUSH} every ${TS_SYNC_MINUTES}m`);
    // First cycle shortly after boot, then on the configured interval.
    setTimeout(runCycle, 15_000);
    setInterval(runCycle, TS_SYNC_MINUTES * 60_000);
  } else {
    console.log("[tabsense] worker off — set TABSENSE_EMAIL/TABSENSE_PASSWORD to enable");
  }
});
