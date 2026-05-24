import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // bearer token for admin requests
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ADMIN_TOKEN; // human-friendly password to log in (falls back to token)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const PORT = Number(process.env.PORT || 3000);

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
       offer_description, banner_template_id, custom_text, custom_colors, source, status, tab_sense_uploaded,
       exported_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15::timestamptz, NOW()))`,
    [
      b.id, b.campaignName, b.ambassadorId, b.discountPercent, b.validityDate,
      b.codePrefix || "", b.offerDescription || "", b.bannerTemplateId || "",
      jb(b.customText || {}), jb(b.customColors || {}), b.source || "auto", b.status || "draft",
      !!b.tabSenseUploaded, b.exportedAt || null, b.createdAt || null,
    ]
  );
  return c.json({ ok: true });
});
app.put("/api/batches/:id", async (c) => {
  const err = await requireAdmin(c); if (err) return err;
  const id = c.req.param("id");
  const b = await c.req.json();
  await pool.query(
    `UPDATE batches SET campaign_name=$2, discount_percent=$3, validity_date=$4, code_prefix=$5,
       offer_description=$6, banner_template_id=$7, custom_text=$8, custom_colors=$9,
       status=$10, tab_sense_uploaded=$11, exported_at=$12, updated_at=NOW()
     WHERE id=$1`,
    [
      id, b.campaignName, b.discountPercent, b.validityDate, b.codePrefix || "",
      b.offerDescription || "", b.bannerTemplateId || "", jb(b.customText || {}),
      jb(b.customColors || {}), b.status || "draft", !!b.tabSenseUploaded, b.exportedAt || null,
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

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`freshcuts-api listening on http://0.0.0.0:${info.port}`);
});
