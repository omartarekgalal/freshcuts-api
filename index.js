import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import pg from "pg";
import crypto from "node:crypto";
import * as ts from "./tabsense.js";
import * as feedus from "./feedus.js";

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
    if (TS_AUTOSYNC) {
      // Insights cache (all orders + customers + linking) — errors here must
      // not break the codes sync above.
      try { await runInsightsSync(); insightsState.lastError = null; }
      catch (e) {
        insightsState.lastError = { at: new Date().toISOString(), message: e.message };
        console.error("[insights] sync error:", e.message);
      }
    }
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

// Create an offer (simplified % or fixed discount).
// Body: { name, value, discountType?, startDate, endDate, active? }
// SAFETY: TabSense's "require promo code" (enable_promocode) does NOT persist via
// this HTTP path, so a created offer would auto-apply to ALL customers. We
// therefore ALWAYS create it INACTIVE and never auto-activate — the admin must
// open it in TabSense, tick "تفعيل رمز الخصم", then activate. `requiresManualCodeGate`
// tells the UI to warn about this.
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
    // Force INACTIVE — never leave a code-less discount live.
    if (created.id) await ts.setPromotionActive(created.id, false).catch(() => {});
    return c.json({ ok: true, ...created, active: false, requiresManualCodeGate: true });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Discount log: per-offer discount totals (SAR) + who used the codes.
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to the last 30 days).
app.get("/api/tabsense/discount-log", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const to = c.req.query("to") || todayISO();
  const from = c.req.query("from") || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  try {
    const offers = await ts.fetchPromotionSales(from, to);

    // Map every code seen in the report to its ambassador (from our DB).
    const allCodes = [...new Set(offers.flatMap((o) => o.codes))];
    const codeOwner = new Map();
    if (allCodes.length) {
      const r = await pool.query(
        `SELECT c.code, c.ambassador_id, a.name
           FROM codes c LEFT JOIN ambassadors a ON a.id = c.ambassador_id
          WHERE c.code = ANY($1)`,
        [allCodes]
      );
      for (const row of r.rows) codeOwner.set(row.code, { id: row.ambassador_id, name: row.name || "(غير معروف)" });
    }

    // Per-offer ambassador breakdown (code counts) + an overall by-ambassador roll-up.
    const byAmb = new Map();
    const offersOut = offers.map((o) => {
      const perAmb = new Map();
      let unknown = 0;
      for (const code of o.codes) {
        const owner = codeOwner.get(code);
        if (!owner || !owner.id) { unknown++; continue; }
        perAmb.set(owner.id, { name: owner.name, count: (perAmb.get(owner.id)?.count || 0) + 1 });
        const agg = byAmb.get(owner.id) || { name: owner.name, codesUsed: 0, offers: new Set() };
        agg.codesUsed++; agg.offers.add(o.name); byAmb.set(owner.id, agg);
      }
      return {
        ...o,
        codesUsed: o.codes.length,
        ambassadors: [...perAmb.entries()].map(([id, v]) => ({ id, name: v.name, codesUsed: v.count }))
          .sort((a, b) => b.codesUsed - a.codesUsed),
        unknownCodes: unknown,
      };
    });

    const totals = {
      totalDiscount: offers.reduce((s, o) => s + o.totalDiscount, 0),
      orders: offers.reduce((s, o) => s + o.orders, 0),
      codesUsed: allCodes.length,
    };
    const byAmbassador = [...byAmb.entries()].map(([id, v]) => ({ id, name: v.name, codesUsed: v.codesUsed, offers: [...v.offers] }))
      .sort((a, b) => b.codesUsed - a.codesUsed);

    return c.json({ ok: true, from, to, totals, offers: offersOut, byAmbassador });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Per-customer discount log runs as a BACKGROUND JOB — scanning customers one by
// one (60/min limit) can exceed the 100s proxy timeout, so we return a jobId
// immediately and let the UI poll for progress. In-memory job store.
const discountJobs = new Map();
function pruneJobs() {
  if (discountJobs.size <= 30) return;
  const oldest = [...discountJobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
  if (oldest) discountJobs.delete(oldest.id);
}

// Upsert a customer's discounted orders into the cache table.
async function cacheCustomerOrders(cust, discountedOrders) {
  const np = normPhone(cust.phone);
  for (const o of discountedOrders) {
    await pool.query(
      `INSERT INTO ts_customer_orders
         (order_id, customer_id, customer_name, customer_phone, customer_phone_norm, customer_points, order_date, gross, discount, promotion, total, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,NOW())
       ON CONFLICT (order_id) DO UPDATE SET
         customer_id=EXCLUDED.customer_id, customer_name=EXCLUDED.customer_name,
         customer_phone=EXCLUDED.customer_phone, customer_phone_norm=EXCLUDED.customer_phone_norm,
         customer_points=EXCLUDED.customer_points, order_date=EXCLUDED.order_date,
         gross=EXCLUDED.gross, discount=EXCLUDED.discount, promotion=EXCLUDED.promotion,
         total=EXCLUDED.total, updated_at=NOW()`,
      [String(o.orderId), String(cust.id), cust.name || "", cust.phone || "", np, cust.points || 0,
       o.date || null, o.gross || 0, o.discount || 0, o.promotion || 0, o.total || 0]
    );
  }
}

// Refresh the discount cache from TabSense (background job with progress).
// Body: { from, to, cap }. Writes into ts_customer_orders + records freshness.
app.post("/api/discounts/refresh", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const to = b.to || todayISO();
  const from = b.from || new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const cap = Math.max(1, Math.min(500, Number(b.cap) || 400));
  const jobId = randToken(12);
  const job = { id: jobId, status: "running", from, to, done: 0, total: 0, startedAt: Date.now(), cached: 0, error: null };
  discountJobs.set(jobId, job);
  pruneJobs();
  (async () => {
    try {
      const { customers } = await ts.fetchCustomerDiscounts(from, to, {
        cap,
        onProgress: (done, total) => { job.done = done; job.total = total; },
      });
      let cached = 0;
      for (const cust of customers) { await cacheCustomerOrders(cust, cust.discountedOrders); cached += cust.discountedOrders.length; }
      job.cached = cached;
      const settings = await getSettingsData();
      settings.tsDiscountSync = { lastRefreshAt: new Date().toISOString(), from, to, customers: customers.length, orders: cached };
      await pool.query("UPDATE settings SET data=$1::jsonb, updated_at=NOW() WHERE id=1", [jb(settings)]);
      job.status = "done";
    } catch (e) {
      job.error = e.message; job.status = "error";
    }
  })();
  return c.json({ ok: true, jobId, from, to });
});

app.get("/api/discounts/refresh-status/:jobId", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const job = discountJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ ok: false, error: "job_not_found" }, 404);
  return c.json({ ok: true, status: job.status, done: job.done, total: job.total, cached: job.cached, error: job.error });
});

// Cache freshness.
app.get("/api/discounts/status", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const r = await pool.query("SELECT count(*)::int AS orders, count(DISTINCT customer_id)::int AS customers, max(updated_at) AS refreshed FROM ts_customer_orders");
  const settings = await getSettingsData();
  return c.json({ ok: true, ...r.rows[0], sync: settings.tsDiscountSync || null });
});

// Fast customer discount search/filters — reads the cache (instant).
// ?search=&from=&to=&minDiscount=&onlyAmbassadors=1&sort=discount|orders|recent&limit=
app.get("/api/discounts/customers", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const q = c.req.query();
  const params = [];
  const where = [];
  if (q.from) { params.push(q.from); where.push(`order_date >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`order_date < ($${params.length}::date + 1)`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  // Aggregate per customer, join ambassadors by phone.
  const rows = (await pool.query(
    `SELECT o.customer_id, max(o.customer_name) AS name, max(o.customer_phone) AS phone,
            max(o.customer_phone_norm) AS phone_norm, max(o.customer_points) AS points,
            count(*)::int AS orders, sum(o.discount + o.promotion) AS total_discount,
            sum(o.total) AS total_spent, max(o.order_date) AS last_order,
            (a.id IS NOT NULL) AS is_ambassador, a.name AS ambassador_name
       FROM ts_customer_orders o
       LEFT JOIN ambassadors a ON a.phone_norm = o.customer_phone_norm AND a.phone_norm <> ''
       ${whereSql}
      GROUP BY o.customer_id, a.id, a.name`,
    params
  )).rows;
  let list = rows.map((r) => ({
    customerId: r.customer_id, name: r.name, phone: r.phone, points: Number(r.points) || 0,
    orders: r.orders, totalDiscount: Number(r.total_discount) || 0, totalSpent: Number(r.total_spent) || 0,
    lastOrder: r.last_order, isAmbassador: r.is_ambassador, ambassadorName: r.ambassador_name,
  }));
  if (q.search) {
    const s = q.search.trim().toLowerCase(); const sp = normPhone(q.search);
    list = list.filter((x) => (x.name || "").toLowerCase().includes(s) || (sp && normPhone(x.phone).includes(sp)));
  }
  if (q.minDiscount) list = list.filter((x) => x.totalDiscount >= Number(q.minDiscount));
  if (q.onlyAmbassadors === "1") list = list.filter((x) => x.isAmbassador);
  const sort = q.sort || "discount";
  list.sort((a, b) => sort === "orders" ? b.orders - a.orders : sort === "recent" ? new Date(b.lastOrder) - new Date(a.lastOrder) : b.totalDiscount - a.totalDiscount);
  const limit = Math.min(500, Number(q.limit) || 200);
  const totals = {
    customers: list.length,
    totalDiscount: list.reduce((s, x) => s + x.totalDiscount, 0),
    ambassadorCustomers: list.filter((x) => x.isAmbassador).length,
  };
  return c.json({ ok: true, totals, customers: list.slice(0, limit) });
});

// Smart discount report — aggregates the cache several ways.
app.get("/api/discounts/report", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const q = c.req.query();
  const params = []; const where = [];
  if (q.from) { params.push(q.from); where.push(`order_date >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`order_date < ($${params.length}::date + 1)`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const one = async (sql) => (await pool.query(sql, params)).rows;

  const summary = (await one(
    `SELECT count(*)::int AS orders, count(DISTINCT customer_id)::int AS customers,
            COALESCE(sum(discount+promotion),0) AS total_discount, COALESCE(sum(total),0) AS total_spent,
            COALESCE(avg(discount+promotion),0) AS avg_discount FROM ts_customer_orders ${whereSql}`
  ))[0];
  const daily = await one(
    `SELECT to_char(order_date,'YYYY-MM-DD') AS day, count(*)::int AS orders, sum(discount+promotion) AS discount
       FROM ts_customer_orders ${whereSql} GROUP BY 1 ORDER BY 1`
  );
  const ambVsRegular = await one(
    `SELECT (a.id IS NOT NULL) AS is_ambassador, count(*)::int AS orders, sum(o.discount+o.promotion) AS discount
       FROM ts_customer_orders o LEFT JOIN ambassadors a ON a.phone_norm=o.customer_phone_norm AND a.phone_norm<>''
       ${whereSql} GROUP BY 1`
  );
  const topCustomers = await one(
    `SELECT customer_name AS name, customer_phone AS phone, count(*)::int AS orders, sum(discount+promotion) AS discount
       FROM ts_customer_orders ${whereSql} GROUP BY customer_name, customer_phone ORDER BY discount DESC LIMIT 10`
  );
  return c.json({
    ok: true,
    summary: {
      orders: summary.orders, customers: summary.customers,
      totalDiscount: Number(summary.total_discount), totalSpent: Number(summary.total_spent),
      avgDiscount: Number(summary.avg_discount),
      discountRatio: Number(summary.total_spent) > 0 ? Number(summary.total_discount) / (Number(summary.total_spent) + Number(summary.total_discount)) : 0,
    },
    daily: daily.map((d) => ({ day: d.day, orders: d.orders, discount: Number(d.discount) })),
    ambassadorVsRegular: ambVsRegular.map((r) => ({ isAmbassador: r.is_ambassador, orders: r.orders, discount: Number(r.discount) })),
    topCustomers: topCustomers.map((t) => ({ name: t.name, phone: t.phone, orders: t.orders, discount: Number(t.discount) })),
  });
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

/* ═══════════════════════════════════════════════════════════════════════════
   MARKETING — paid ads tracking (TikTok / Meta / Snapchat), manual + file import
═══════════════════════════════════════════════════════════════════════════ */
async function ensureMarketingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mk_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'tiktok',
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      daily_budget NUMERIC DEFAULT 0,
      target_cpr NUMERIC DEFAULT 0,
      start_date DATE,
      end_date DATE,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mk_entries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES mk_campaigns(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      spend NUMERIC DEFAULT 0,
      impressions BIGINT DEFAULT 0,
      reach BIGINT DEFAULT 0,
      clicks BIGINT DEFAULT 0,
      results NUMERIC DEFAULT 0,
      video_views BIGINT DEFAULT 0,
      engagements BIGINT DEFAULT 0,
      leads_whatsapp INT DEFAULT 0,
      leads_calls INT DEFAULT 0,
      leads_visits INT DEFAULT 0,
      leads_delivery INT DEFAULT 0,
      leads_apps INT DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (campaign_id, day)
    );
    CREATE INDEX IF NOT EXISTS mk_entries_day_idx ON mk_entries(day);
    CREATE INDEX IF NOT EXISTS mk_entries_campaign_idx ON mk_entries(campaign_id);
    CREATE TABLE IF NOT EXISTS mk_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      builtin BOOL NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Cache of ALL TabSense orders (not just discounted ones). Filled by the
    -- background worker from the /orders DataTables endpoint.
    CREATE TABLE IF NOT EXISTS ts_orders (
      order_id TEXT PRIMARY KEY,
      receipt TEXT,
      order_date TIMESTAMPTZ,
      calendar_day DATE,
      order_option TEXT,
      order_type TEXT,
      order_status INT DEFAULT 0,
      gross NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      promotion NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      payments JSONB NOT NULL DEFAULT '{}',
      branch TEXT,
      customer_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ts_orders_day_idx ON ts_orders(calendar_day);
    CREATE INDEX IF NOT EXISTS ts_orders_customer_idx ON ts_orders(customer_id);
    -- Cache of the TabSense customer directory (has the registration date).
    CREATE TABLE IF NOT EXISTS ts_customers (
      customer_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      phone_norm TEXT,
      gender TEXT,
      email TEXT,
      points INT DEFAULT 0,
      registered_at TIMESTAMPTZ,
      first_order_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ts_customers_reg_idx ON ts_customers(registered_at);
    -- Where each invoice's customer came from — filled by the cashier station
    -- (#cashier) or auto-tagged (delivery apps) by the sync worker.
    CREATE TABLE IF NOT EXISTS order_sources (
      order_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_note TEXT NOT NULL DEFAULT '',
      customer_kind TEXT NOT NULL DEFAULT 'unknown',
      filled_by TEXT NOT NULL DEFAULT 'cashier',
      filled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function mkCampaignRow(r) {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    objective: r.objective || "",
    status: r.status || "active",
    dailyBudget: Number(r.daily_budget) || 0,
    targetCpr: Number(r.target_cpr) || 0,
    startDate: r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : r.start_date,
    endDate: r.end_date instanceof Date ? r.end_date.toISOString().slice(0, 10) : r.end_date,
    notes: r.notes || "",
    createdAt: r.created_at,
  };
}
function mkEntryRow(r) {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    reach: Number(r.reach) || 0,
    clicks: Number(r.clicks) || 0,
    results: Number(r.results) || 0,
    videoViews: Number(r.video_views) || 0,
    engagements: Number(r.engagements) || 0,
    leadsWhatsapp: Number(r.leads_whatsapp) || 0,
    leadsCalls: Number(r.leads_calls) || 0,
    leadsVisits: Number(r.leads_visits) || 0,
    leadsDelivery: Number(r.leads_delivery) || 0,
    leadsApps: Number(r.leads_apps) || 0,
    notes: r.notes || "",
  };
}

// ─── Campaigns ──────────────────────────────────────────────────────────────
app.get("/api/marketing/campaigns", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const r = await pool.query(`
    SELECT c.*,
           COALESCE(sum(e.spend),0)        AS t_spend,
           COALESCE(sum(e.impressions),0)  AS t_impressions,
           COALESCE(sum(e.clicks),0)       AS t_clicks,
           COALESCE(sum(e.results),0)      AS t_results,
           COALESCE(sum(e.leads_whatsapp + e.leads_calls + e.leads_visits + e.leads_delivery + e.leads_apps),0) AS t_leads,
           count(e.id)::int                AS t_days,
           max(e.day)                      AS last_day
      FROM mk_campaigns c
      LEFT JOIN mk_entries e ON e.campaign_id = c.id
     GROUP BY c.id
     ORDER BY c.created_at DESC`);
  return c.json(r.rows.map((row) => ({
    ...mkCampaignRow(row),
    totals: {
      spend: Number(row.t_spend), impressions: Number(row.t_impressions),
      clicks: Number(row.t_clicks), results: Number(row.t_results),
      leads: Number(row.t_leads), days: row.t_days,
      lastDay: row.last_day instanceof Date ? row.last_day.toISOString().slice(0, 10) : row.last_day,
    },
  })));
});
app.post("/api/marketing/campaigns", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  await pool.query(
    `INSERT INTO mk_campaigns (id, name, platform, objective, status, daily_budget, target_cpr, start_date, end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [b.id, b.name, b.platform || "tiktok", b.objective || "", b.status || "active",
     Number(b.dailyBudget) || 0, Number(b.targetCpr) || 0, b.startDate || null, b.endDate || null, b.notes || ""]
  );
  return c.json({ ok: true });
});
app.put("/api/marketing/campaigns/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  await pool.query(
    `UPDATE mk_campaigns SET name=$2, platform=$3, objective=$4, status=$5, daily_budget=$6,
            target_cpr=$7, start_date=$8, end_date=$9, notes=$10, updated_at=NOW() WHERE id=$1`,
    [c.req.param("id"), b.name, b.platform || "tiktok", b.objective || "", b.status || "active",
     Number(b.dailyBudget) || 0, Number(b.targetCpr) || 0, b.startDate || null, b.endDate || null, b.notes || ""]
  );
  return c.json({ ok: true });
});
app.delete("/api/marketing/campaigns/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM mk_campaigns WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Daily entries (manual log + file import both land here) ────────────────
app.get("/api/marketing/entries", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const q = c.req.query();
  const params = []; const where = [];
  if (q.from) { params.push(q.from); where.push(`day >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`day <= $${params.length}::date`); }
  if (q.campaignId) { params.push(q.campaignId); where.push(`campaign_id = $${params.length}`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(1000, Number(q.limit) || 400);
  const r = await pool.query(`SELECT * FROM mk_entries ${whereSql} ORDER BY day DESC, created_at DESC LIMIT ${limit}`, params);
  return c.json(r.rows.map(mkEntryRow));
});
// Upsert on (campaign_id, day) — an import or a re-submitted manual entry
// replaces that day's numbers for that campaign.
app.post("/api/marketing/entries/bulk", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json().catch(() => ({}));
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!entries.length) return c.json({ ok: false, error: "entries required" }, 400);
  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      if (!e.campaignId || !e.day) continue;
      await client.query(
        `INSERT INTO mk_entries (id, campaign_id, day, spend, impressions, reach, clicks, results,
                                 video_views, engagements, leads_whatsapp, leads_calls, leads_visits,
                                 leads_delivery, leads_apps, notes)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (campaign_id, day) DO UPDATE SET
           spend=EXCLUDED.spend, impressions=EXCLUDED.impressions, reach=EXCLUDED.reach,
           clicks=EXCLUDED.clicks, results=EXCLUDED.results, video_views=EXCLUDED.video_views,
           engagements=EXCLUDED.engagements, leads_whatsapp=EXCLUDED.leads_whatsapp,
           leads_calls=EXCLUDED.leads_calls, leads_visits=EXCLUDED.leads_visits,
           leads_delivery=EXCLUDED.leads_delivery, leads_apps=EXCLUDED.leads_apps,
           notes=EXCLUDED.notes, updated_at=NOW()`,
        [e.id || ("me" + randToken(10).toLowerCase()), e.campaignId, e.day,
         Number(e.spend) || 0, Math.round(Number(e.impressions) || 0), Math.round(Number(e.reach) || 0),
         Math.round(Number(e.clicks) || 0), Number(e.results) || 0,
         Math.round(Number(e.videoViews) || 0), Math.round(Number(e.engagements) || 0),
         Math.round(Number(e.leadsWhatsapp) || 0), Math.round(Number(e.leadsCalls) || 0),
         Math.round(Number(e.leadsVisits) || 0), Math.round(Number(e.leadsDelivery) || 0),
         Math.round(Number(e.leadsApps) || 0), e.notes || ""]
      );
      upserted++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return c.json({ ok: true, upserted });
});
app.delete("/api/marketing/entries/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM mk_entries WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Ideas (builtin library statuses + custom ideas, upsert by id) ──────────
app.get("/api/marketing/ideas", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const r = await pool.query("SELECT * FROM mk_ideas ORDER BY created_at DESC");
  return c.json(r.rows.map((x) => ({
    id: x.id, title: x.title, body: x.body || "", category: x.category || "",
    status: x.status || "new", builtin: x.builtin, createdAt: x.created_at,
  })));
});
app.post("/api/marketing/ideas", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const b = await c.req.json();
  await pool.query(
    `INSERT INTO mk_ideas (id, title, body, category, status, builtin)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, body=EXCLUDED.body, category=EXCLUDED.category,
       status=EXCLUDED.status, updated_at=NOW()`,
    [b.id, b.title, b.body || "", b.category || "", b.status || "new", !!b.builtin]
  );
  return c.json({ ok: true });
});
app.delete("/api/marketing/ideas/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  await pool.query("DELETE FROM mk_ideas WHERE id=$1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ─── Report — ads aggregates + TabSense discounted-orders sales overlay ─────
app.get("/api/marketing/report", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const q = c.req.query();
  const params = []; const where = [];
  if (q.from) { params.push(q.from); where.push(`e.day >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`e.day <= $${params.length}::date`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const one = async (sql) => (await pool.query(sql, params)).rows;

  const sumCols = `
    COALESCE(sum(e.spend),0) AS spend, COALESCE(sum(e.impressions),0) AS impressions,
    COALESCE(sum(e.reach),0) AS reach, COALESCE(sum(e.clicks),0) AS clicks,
    COALESCE(sum(e.results),0) AS results, COALESCE(sum(e.video_views),0) AS video_views,
    COALESCE(sum(e.engagements),0) AS engagements,
    COALESCE(sum(e.leads_whatsapp),0) AS leads_whatsapp, COALESCE(sum(e.leads_calls),0) AS leads_calls,
    COALESCE(sum(e.leads_visits),0) AS leads_visits, COALESCE(sum(e.leads_delivery),0) AS leads_delivery,
    COALESCE(sum(e.leads_apps),0) AS leads_apps`;
  const numify = (r) => ({
    spend: Number(r.spend), impressions: Number(r.impressions), reach: Number(r.reach),
    clicks: Number(r.clicks), results: Number(r.results), videoViews: Number(r.video_views),
    engagements: Number(r.engagements), leadsWhatsapp: Number(r.leads_whatsapp),
    leadsCalls: Number(r.leads_calls), leadsVisits: Number(r.leads_visits),
    leadsDelivery: Number(r.leads_delivery), leadsApps: Number(r.leads_apps),
  });

  const summary = numify((await one(`SELECT ${sumCols} FROM mk_entries e ${whereSql}`))[0]);
  const perPlatform = (await one(
    `SELECT c.platform, ${sumCols} FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
     ${whereSql} GROUP BY c.platform`
  )).map((r) => ({ platform: r.platform, ...numify(r) }));
  const perCampaign = (await one(
    `SELECT c.id, c.name, c.platform, c.status, c.target_cpr, ${sumCols}, count(e.id)::int AS days
       FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
     ${whereSql} GROUP BY c.id ORDER BY sum(e.spend) DESC`
  )).map((r) => ({ id: r.id, name: r.name, platform: r.platform, status: r.status,
                   targetCpr: Number(r.target_cpr) || 0, days: r.days, ...numify(r) }));
  const daily = (await one(
    `SELECT to_char(e.day,'YYYY-MM-DD') AS day, ${sumCols} FROM mk_entries e ${whereSql} GROUP BY 1 ORDER BY 1`
  )).map((r) => ({ day: r.day, ...numify(r) }));

  // Sales overlay from the TabSense discounted-orders cache (same date range).
  const sParams = []; const sWhere = [];
  if (q.from) { sParams.push(q.from); sWhere.push(`order_date >= $${sParams.length}::date`); }
  if (q.to) { sParams.push(q.to); sWhere.push(`order_date < ($${sParams.length}::date + 1)`); }
  const sWhereSql = sWhere.length ? "WHERE " + sWhere.join(" AND ") : "";
  const salesDaily = (await pool.query(
    `SELECT to_char(order_date,'YYYY-MM-DD') AS day, count(*)::int AS orders,
            COALESCE(sum(total),0) AS revenue, COALESCE(sum(discount+promotion),0) AS discount
       FROM ts_customer_orders ${sWhereSql} GROUP BY 1 ORDER BY 1`, sParams
  )).rows.map((r) => ({ day: r.day, orders: r.orders, revenue: Number(r.revenue), discount: Number(r.discount) }));

  return c.json({ ok: true, summary, perPlatform, perCampaign, daily, salesDaily });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INSIGHTS — full orders/customers cache, cashier source-tagging, analytics
═══════════════════════════════════════════════════════════════════════════ */
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Payment-method names that mean "this order came through a delivery app".
// Overridable via settings.deliveryAppMethods (array of names).
const DEFAULT_DELIVERY_APPS = ["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];
function deliveryAppOf(payments, settings) {
  const list = (Array.isArray(settings?.deliveryAppMethods) && settings.deliveryAppMethods.length)
    ? settings.deliveryAppMethods.map((s) => String(s).toLowerCase())
    : DEFAULT_DELIVERY_APPS;
  for (const k of Object.keys(payments || {})) {
    if (list.includes(String(k).toLowerCase())) return k;
  }
  return null;
}
// order_type='External' = aggregator (FeedUs) orders — present from creation,
// unlike the payment method which only lands when the order is paid/closed.
function isDeliveryOrder(orderOption, payments, settings, orderType) {
  return /external/i.test(String(orderType || ""))
    || !!deliveryAppOf(payments, settings)
    || /deliver|توصيل/i.test(String(orderOption || ""));
}

const insightsState = {
  lastOrdersSyncAt: null, lastOrdersCount: 0,
  lastCustomersSyncAt: null, lastLinkAt: null, lastError: null,
  feedusEnabled: feedus.ENABLED, lastFeedusSyncAt: null, lastFeedusTagged: 0, lastFeedusError: null,
};

// Pull the FeedUs → TabSense order log and tag each matching order with the
// delivery app it actually came from (Keeta / HungerStation / Ninja …).
// This is the only place the origin app and the TabSense order id meet.
async function syncFeedusSources({ pages = 3 } = {}) {
  if (!feedus.ENABLED) return { ok: false, error: "feedus_not_configured", tagged: 0 };
  const known = new Set(
    (await pool.query(
      `SELECT order_id FROM order_sources WHERE filled_by = 'feedus'
        ORDER BY filled_at DESC LIMIT 400`
    )).rows.map((r) => String(r.order_id))
  );
  const rows = await feedus.fetchPosLogs({ pages, isKnown: (id) => known.has(String(id)) });
  let tagged = 0;
  for (const r of rows) {
    if (!r.tabsenseOrderId || !r.provider) continue;
    // Only tag orders we actually hold — avoids orphan rows for other branches.
    const res = await pool.query(
      `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by, filled_at)
       SELECT o.order_id, 'delivery_app', $2, 'unknown', 'feedus', NOW()
         FROM ts_orders o WHERE o.order_id = $1
       ON CONFLICT (order_id) DO UPDATE SET
         source='delivery_app', source_note=EXCLUDED.source_note,
         filled_by='feedus', filled_at=NOW()
       WHERE order_sources.filled_by IN ('auto','feedus')`,
      [String(r.tabsenseOrderId), r.provider]
    );
    tagged += res.rowCount;
  }
  return { ok: true, tagged, scanned: rows.length };
}

// Pull orders (newest-first down to sinceDate) into ts_orders. Recent
// delivery-app orders are NOT auto-tagged anymore — the POS logs them all as
// Dine-in under an aggregator payment (e.g. Feedus), so the cashier picks the
// actual app (Keeta / HungerStation / Ninja…) from the queue. Orders nobody
// tagged within 48h get auto-tagged with the payment-method name as fallback
// so analytics never lose the delivery attribution.
async function syncOrdersCache(sinceDate) {
  const settings = await getSettingsData();
  const orders = await ts.fetchOrdersSince(sinceDate);
  for (const o of orders) {
    await pool.query(
      `INSERT INTO ts_orders (order_id, receipt, order_date, calendar_day, order_option, order_type,
                              order_status, gross, discount, promotion, total, payments, branch, updated_at)
       VALUES ($1,$2,$3::timestamptz,$4::date,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,NOW())
       ON CONFLICT (order_id) DO UPDATE SET
         receipt=EXCLUDED.receipt, order_date=EXCLUDED.order_date, calendar_day=EXCLUDED.calendar_day,
         order_option=EXCLUDED.order_option, order_type=EXCLUDED.order_type, order_status=EXCLUDED.order_status,
         gross=EXCLUDED.gross, discount=EXCLUDED.discount, promotion=EXCLUDED.promotion,
         total=EXCLUDED.total, payments=EXCLUDED.payments, branch=EXCLUDED.branch, updated_at=NOW()`,
      [o.orderId, o.receipt, o.orderDate, o.calendarDay, o.orderOption, o.orderType,
       o.orderStatus, o.gross, o.discount, o.promotion, o.total, jb(o.payments), o.branch]
    );
  }
  const appList = (Array.isArray(settings?.deliveryAppMethods) && settings.deliveryAppMethods.length)
    ? settings.deliveryAppMethods.map((s) => String(s).toLowerCase())
    : DEFAULT_DELIVERY_APPS;
  await pool.query(
    `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by)
     SELECT o.order_id, 'delivery_app',
            COALESCE((SELECT k FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY($1) LIMIT 1),
                     CASE WHEN o.order_type ILIKE '%external%' THEN 'Feedus' ELSE '' END),
            'unknown', 'auto'
       FROM ts_orders o
       LEFT JOIN order_sources s ON s.order_id = o.order_id
      WHERE s.order_id IS NULL
        AND o.order_date < NOW() - interval '48 hours'
        AND (o.order_type ILIKE '%external%'
             OR EXISTS (SELECT 1 FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY($1)))
     ON CONFLICT (order_id) DO NOTHING`,
    [appList]
  );
  return orders.length;
}

async function syncCustomersCache() {
  const customers = await ts.fetchCustomersList();
  for (const c of customers) {
    await pool.query(
      `INSERT INTO ts_customers (customer_id, name, phone, phone_norm, gender, email, points, registered_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,NOW())
       ON CONFLICT (customer_id) DO UPDATE SET
         name=EXCLUDED.name, phone=EXCLUDED.phone, phone_norm=EXCLUDED.phone_norm,
         gender=EXCLUDED.gender, email=EXCLUDED.email, points=EXCLUDED.points,
         registered_at=EXCLUDED.registered_at, updated_at=NOW()`,
      [c.id, c.name, c.phone, normPhone(c.phone), c.gender, c.email, c.points, c.registeredAt]
    );
  }
  return customers.length;
}

// Link ts_orders rows to a customer by sweeping /customers/{id}/orders (which
// carries the same order ids). Heavy (1 req/customer @ 60/min) — throttled.
async function linkCustomersOrders(customerIds, { throttleMs = 1100, onProgress } = {}) {
  let linked = 0;
  for (let i = 0; i < customerIds.length; i++) {
    if (i > 0) await sleep(throttleMs);
    const cid = String(customerIds[i]);
    let orders = [];
    try { orders = await ts.fetchCustomerOrders(cid); }
    catch (e) { console.error(`[insights] link customer ${cid} failed:`, e.message); continue; }
    let firstAt = null;
    for (const o of orders) {
      const at = o.created_at || o.order_created_at || null;
      if (at && (!firstAt || at < firstAt)) firstAt = at;
      const r = await pool.query(
        "UPDATE ts_orders SET customer_id=$2, updated_at=NOW() WHERE order_id=$1 AND (customer_id IS NULL OR customer_id<>$2)",
        [String(o.id), cid]
      );
      linked += r.rowCount;
    }
    if (firstAt) {
      await pool.query(
        `UPDATE ts_customers SET first_order_at = CASE
           WHEN first_order_at IS NULL OR first_order_at > $2::timestamptz THEN $2::timestamptz
           ELSE first_order_at END
         WHERE customer_id=$1`,
        [cid, firstAt]
      );
    }
    if (onProgress) onProgress(i + 1, customerIds.length);
  }
  return linked;
}

// Runs inside the worker cycle: orders every cycle, customers+linking every ~30m.
async function runInsightsSync() {
  const n = await syncOrdersCache(daysAgoISO(3));
  insightsState.lastOrdersSyncAt = new Date().toISOString();
  insightsState.lastOrdersCount = n;
  if (feedus.ENABLED) {
    try {
      const r = await syncFeedusSources({ pages: 2 });
      insightsState.lastFeedusSyncAt = new Date().toISOString();
      insightsState.lastFeedusTagged = r.tagged || 0;
      insightsState.lastFeedusError = null;
    } catch (e) {
      insightsState.lastFeedusError = e.message;
      console.error("[feedus] sync error:", e.message);
    }
  }
  const THIRTY_MIN = 30 * 60 * 1000;
  const due = !insightsState.lastLinkAt || (Date.now() - new Date(insightsState.lastLinkAt).getTime() > THIRTY_MIN);
  if (due) {
    await syncCustomersCache();
    insightsState.lastCustomersSyncAt = new Date().toISOString();
    // Link only customers active in the last 2 days — small, cheap sweep.
    const actives = await ts.fetchCustomerSales(daysAgoISO(2), todayISO());
    await linkCustomersOrders(actives.slice(0, 40).map((c) => c.id));
    insightsState.lastLinkAt = new Date().toISOString();
  }
}

// ─── Backfill job (orders history + full customer linking) ──────────────────
const insightsJobs = new Map();
app.post("/api/insights/backfill", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!TS_ENABLED) return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const days = Math.max(7, Math.min(400, Number(b.days) || 120));
  const cap = Math.max(10, Math.min(500, Number(b.cap) || 250));
  const jobId = randToken(12);
  const job = { id: jobId, status: "running", phase: "orders", done: 0, total: 0, linked: 0, startedAt: Date.now(), error: null };
  insightsJobs.set(jobId, job);
  if (insightsJobs.size > 20) {
    const oldest = [...insightsJobs.values()].sort((a, b2) => a.startedAt - b2.startedAt)[0];
    if (oldest) insightsJobs.delete(oldest.id);
  }
  (async () => {
    try {
      await syncOrdersCache(daysAgoISO(days));
      job.phase = "customers";
      await syncCustomersCache();
      job.phase = "linking";
      const actives = (await ts.fetchCustomerSales(daysAgoISO(days), todayISO()))
        .sort((a, b2) => b2.spending - a.spending).slice(0, cap);
      job.total = actives.length;
      job.linked = await linkCustomersOrders(actives.map((x) => x.id), {
        onProgress: (done, total) => { job.done = done; job.total = total; },
      });
      job.status = "done";
    } catch (e) {
      job.error = e.message; job.status = "error";
    }
  })();
  return c.json({ ok: true, jobId, days, cap });
});
app.get("/api/insights/backfill-status/:jobId", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const job = insightsJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ ok: false, error: "job_not_found" }, 404);
  return c.json({ ok: true, status: job.status, phase: job.phase, done: job.done, total: job.total, linked: job.linked, error: job.error });
});

// FeedUs: connectivity check + on-demand backfill of the app attribution.
app.get("/api/feedus/ping", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!feedus.ENABLED) return c.json({ ok: false, error: "feedus_not_configured" }, 400);
  try { return c.json(await feedus.ping()); }
  catch (e) { return c.json({ ok: false, error: e.message }, 500); }
});
app.post("/api/feedus/sync", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  if (!feedus.ENABLED) return c.json({ ok: false, error: "feedus_not_configured" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const pages = Math.max(1, Math.min(60, Number(b.pages) || 3));
  try {
    const r = await syncFeedusSources({ pages });
    insightsState.lastFeedusSyncAt = new Date().toISOString();
    insightsState.lastFeedusTagged = r.tagged || 0;
    return c.json(r);
  } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
});

app.get("/api/insights/status", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const r = await pool.query(`
    SELECT (SELECT count(*)::int FROM ts_orders) AS orders,
           (SELECT count(*)::int FROM ts_orders WHERE customer_id IS NOT NULL) AS linked_orders,
           (SELECT count(*)::int FROM ts_customers) AS customers,
           (SELECT count(*)::int FROM order_sources WHERE source <> 'skipped') AS tagged,
           (SELECT max(order_date) FROM ts_orders) AS latest_order`);
  return c.json({ ok: true, ...r.rows[0], state: insightsState });
});

// ─── Cashier auth + task queue ──────────────────────────────────────────────
async function requireCashierOrAdmin(c) {
  const a = getAuth(c);
  if (a && a.kind === "admin") return null;
  const h = c.req.header("Authorization") || "";
  if (h.startsWith("Bearer cashier:")) {
    const pin = h.slice("Bearer cashier:".length);
    const s = await getSettingsData();
    if (pin && String(pin) === String(s.cashierPin || "1111")) return null;
  }
  return c.json({ error: "Unauthorized" }, 401);
}
app.post("/api/auth/cashier", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const s = await getSettingsData();
  if (String(b.pin || "") === String(s.cashierPin || "1111")) return c.json({ ok: true });
  return c.json({ ok: false, error: "wrong_pin" }, 401);
});

// Pending = cached orders in the window with no source row yet.
app.get("/api/cashier/queue", async (c) => {
  const err = await requireCashierOrAdmin(c); if (err) return err;
  const settings = await getSettingsData();
  const hours = Math.max(1, Math.min(168, Number(c.req.query("hours")) || 48));
  const pending = (await pool.query(
    `SELECT o.order_id, o.receipt, o.order_date, o.calendar_day, o.order_option, o.order_type,
            o.total, o.discount, o.promotion, o.payments, o.customer_id, tc.name AS customer_name
       FROM ts_orders o
       LEFT JOIN order_sources s ON s.order_id = o.order_id
       LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
      WHERE s.order_id IS NULL AND o.order_date >= NOW() - ($1 || ' hours')::interval
      ORDER BY o.order_date DESC LIMIT 100`, [hours]
  )).rows.map((r) => ({
    orderId: r.order_id, receipt: r.receipt || "", orderDate: r.order_date,
    day: r.calendar_day instanceof Date ? r.calendar_day.toISOString().slice(0, 10) : r.calendar_day,
    orderOption: r.order_option || "", orderType: r.order_type || "",
    total: Number(r.total) || 0, discount: (Number(r.discount) || 0) + (Number(r.promotion) || 0),
    customerName: r.customer_name || "",
    // POS bug: delivery-app orders are logged as Dine-in — order_type
    // 'External' (FeedUs) and the aggregator payment method are the
    // reliable delivery signals.
    deliveryApp: deliveryAppOf(r.payments, settings)
      || (/external/i.test(r.order_type || "") ? "Feedus" : null),
  }));
  const stats = (await pool.query(
    `SELECT (SELECT count(*)::int FROM ts_orders WHERE calendar_day = CURRENT_DATE) AS today_orders,
            (SELECT count(*)::int FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
              WHERE o.calendar_day = CURRENT_DATE AND s.filled_by = 'cashier') AS today_tagged,
            (SELECT count(*)::int FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
              WHERE o.calendar_day = CURRENT_DATE AND s.filled_by = 'auto') AS today_auto`
  )).rows[0];
  return c.json({ ok: true, pending, stats, lastSyncAt: insightsState.lastOrdersSyncAt });
});

const CASHIER_SOURCES = ["facebook", "instagram", "tiktok", "snapchat", "google_maps", "influencer", "friend", "walkin", "old_customer", "delivery_app", "other", "skipped"];
app.post("/api/cashier/submit", async (c) => {
  const err = await requireCashierOrAdmin(c); if (err) return err;
  const b = await c.req.json().catch(() => ({}));
  if (!b.orderId || !CASHIER_SOURCES.includes(String(b.source))) {
    return c.json({ ok: false, error: "orderId + valid source required" }, 400);
  }
  await pool.query(
    `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by, filled_at)
     VALUES ($1,$2,$3,$4,'cashier',NOW())
     ON CONFLICT (order_id) DO UPDATE SET
       source=EXCLUDED.source, source_note=EXCLUDED.source_note,
       customer_kind=EXCLUDED.customer_kind, filled_by='cashier', filled_at=NOW()`,
    [String(b.orderId), String(b.source), String(b.note || ""), String(b.customerKind || "unknown")]
  );
  return c.json({ ok: true });
});

// ─── Insights summary — the numbers Omar asked for ──────────────────────────
app.get("/api/insights/summary", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const from = c.req.query("from") || daysAgoISO(29);
  const to = c.req.query("to") || todayISO();
  const settings = await getSettingsData();

  const orders = (await pool.query(
    `SELECT order_id, calendar_day, order_option, order_type, total, discount, promotion, payments, customer_id
       FROM ts_orders WHERE calendar_day BETWEEN $1::date AND $2::date`, [from, to]
  )).rows;
  const newCust = (await pool.query(
    `SELECT customer_id, registered_at::date AS reg_day FROM ts_customers
      WHERE registered_at::date BETWEEN $1::date AND $2::date`, [from, to]
  )).rows;
  const custOrders = (await pool.query(
    `SELECT customer_id, order_date, calendar_day, total FROM ts_orders
      WHERE customer_id IS NOT NULL ORDER BY order_date`
  )).rows;
  const sourceRows = (await pool.query(
    `SELECT s.source, s.source_note, s.customer_kind, s.filled_by, o.total
       FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
      WHERE o.calendar_day BETWEEN $1::date AND $2::date`, [from, to]
  )).rows;

  // Daily series over the full range
  const days = [];
  for (let d = new Date(from); d <= new Date(to) && days.length < 400; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const dayKey = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  const daily = Object.fromEntries(days.map((d) => [d, {
    day: d, orders: 0, revenue: 0, delivery: 0, deliveryRevenue: 0, newCustomers: 0, newCustomerValue: 0,
  }]));
  let totDelivery = 0, totDeliveryRev = 0, totRevenue = 0, totDiscount = 0, totAggregatorAdj = 0;
  for (const o of orders) {
    const d = daily[dayKey(o.calendar_day)];
    const total = Number(o.total) || 0;
    const isExternal = /external/i.test(o.order_type || "");
    const isDel = isDeliveryOrder(o.order_option, o.payments, settings, o.order_type);
    const disc = (Number(o.discount) || 0) + (Number(o.promotion) || 0);
    totRevenue += total;
    // "discounts" on External (FeedUs) orders are aggregator commissions /
    // price adjustments — not marketing discounts. Track separately.
    if (isExternal) totAggregatorAdj += disc; else totDiscount += disc;
    if (isDel) { totDelivery++; totDeliveryRev += total; }
    if (d) {
      d.orders++; d.revenue += total;
      if (isDel) { d.delivery++; d.deliveryRevenue += total; }
    }
  }

  // New customers per day + the value they spent inside the range
  const newCustSet = new Map(newCust.map((r) => [String(r.customer_id), dayKey(r.reg_day)]));
  for (const [, regDay] of newCustSet) { if (daily[regDay]) daily[regDay].newCustomers++; }
  let newCustomerValue = 0;
  for (const o of custOrders) {
    const regDay = newCustSet.get(String(o.customer_id));
    if (!regDay) continue;
    const od = dayKey(o.calendar_day);
    if (od >= from && od <= to) {
      const t = Number(o.total) || 0;
      newCustomerValue += t;
      if (daily[regDay]) daily[regDay].newCustomerValue += t;
    }
  }

  // Retention — per-customer order timeline (linked orders only)
  const byCust = new Map();
  for (const o of custOrders) {
    const cid = String(o.customer_id);
    if (!byCust.has(cid)) byCust.set(cid, []);
    byCust.get(cid).push({ at: o.order_date, day: dayKey(o.calendar_day), total: Number(o.total) || 0 });
  }
  let inRangeCustomers = 0, inRangeRepeaters = 0;
  for (const [, list] of byCust) {
    const inRange = list.filter((x) => x.day >= from && x.day <= to);
    if (!inRange.length) continue;
    inRangeCustomers++;
    if (inRange.length > 1) inRangeRepeaters++;
  }
  // Cohorts by first-order month: % who ordered again within 30/60/90 days
  const cohorts = new Map();
  const now = Date.now();
  for (const [, list] of byCust) {
    if (!list.length) continue;
    const first = new Date(list[0].at);
    if (isNaN(first)) continue;
    const key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
    if (!cohorts.has(key)) cohorts.set(key, { month: key, size: 0, r30: 0, r60: 0, r90: 0, m30: 0, m60: 0, m90: 0 });
    const co = cohorts.get(key);
    co.size++;
    const again = (winDays) => list.some((x, i) => i > 0 && (new Date(x.at) - first) <= winDays * 86400000 && (new Date(x.at) - first) > 0);
    if (now - first.getTime() >= 30 * 86400000) { co.m30++; if (again(30)) co.r30++; }
    if (now - first.getTime() >= 60 * 86400000) { co.m60++; if (again(60)) co.r60++; }
    if (now - first.getTime() >= 90 * 86400000) { co.m90++; if (again(90)) co.r90++; }
  }
  const cohortList = [...cohorts.values()].sort((a, b) => a.month < b.month ? -1 : 1).slice(-8)
    .map((co) => ({
      month: co.month, size: co.size,
      retained30: co.m30 > 0 ? co.r30 / co.m30 : null,
      retained60: co.m60 > 0 ? co.r60 / co.m60 : null,
      retained90: co.m90 > 0 ? co.r90 / co.m90 : null,
    }));

  // Sources
  const srcAgg = new Map();
  let skipped = 0, autoTagged = 0, cashierTagged = 0;
  for (const r of sourceRows) {
    if (r.source === "skipped") { skipped++; continue; }
    if (r.filled_by === "auto") autoTagged++; else cashierTagged++;
    const key = r.source === "delivery_app" && r.source_note ? `delivery_app:${r.source_note}` : r.source;
    if (!srcAgg.has(key)) srcAgg.set(key, { source: r.source, note: r.source === "delivery_app" ? r.source_note : "", orders: 0, revenue: 0, newCustomers: 0 });
    const s = srcAgg.get(key);
    s.orders++; s.revenue += Number(r.total) || 0;
    if (r.customer_kind === "new") s.newCustomers++;
  }
  const linkedInRange = orders.filter((o) => o.customer_id).length;

  return c.json({
    ok: true, from, to,
    summary: {
      orders: orders.length,
      revenue: totRevenue,
      discount: totDiscount,
      aggregatorAdjustments: totAggregatorAdj,
      avgOrder: orders.length > 0 ? totRevenue / orders.length : 0,
      deliveryOrders: totDelivery,
      deliveryRevenue: totDeliveryRev,
      deliveryShare: orders.length > 0 ? totDelivery / orders.length : 0,
      newCustomers: newCustSet.size,
      newCustomerValue,
      taggedOrders: sourceRows.length - skipped,
      sourceCoverage: orders.length > 0 ? (sourceRows.length - skipped) / orders.length : 0,
    },
    daily: days.map((d) => daily[d]),
    retention: {
      linkedCoverage: orders.length > 0 ? linkedInRange / orders.length : 0,
      customersInRange: inRangeCustomers,
      repeatersInRange: inRangeRepeaters,
      repeatRate: inRangeCustomers > 0 ? inRangeRepeaters / inRangeCustomers : 0,
      cohorts: cohortList,
    },
    sources: [...srcAgg.values()].sort((a, b) => b.orders - a.orders),
    tagging: { cashier: cashierTagged, auto: autoTagged, skipped },
  });
});

ensureMarketingSchema()
  .then(() => console.log("[marketing] schema ready"))
  .catch((e) => console.error("[marketing] schema init failed:", e.message));

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
