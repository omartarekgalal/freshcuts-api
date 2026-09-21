/* posnames.js — اسم العميل الحقيقي في نقطة البيع (تاب سينس).
   ═══════════════════════════════════════════════════════════════════════════
   المشكلة اللي الموديول ده اتعمل عشانها (عمر ٢١/٩): «في طلبات بتظهر باسم
   عميل اونلاين محتاجة تتظبط».

   السبب الحقيقي (اتأكدنا منه على الإنتاج، مش تخمين):
   • نقطة البيع بتعرض **اسم دفتر العملاء** على الطلب والفاتورة وتذكرة المطبخ،
     وبتتجاهل `customer.name` اللي بنبعته مع الطلب في API الشركاء. طلب
     W1790011118692 اتبعت باسم العميل الحقيقي ونزل على الشاشة «عميل أونلاين».
   • واحنا اللي كتبنا الاسم ده: عند تسجيل الدخول بالـOTP (قبل ما نعرف الاسم
     أصلاً) كان `accounts.linkOrCreateTsCustomer` بيعمل صف في الدفتر اسمه
     «عميل أونلاين». بعد كده العميل بيكتب اسمه الحقيقي في الشيك أوت — بس
     الدفتر فضل على الاسم المؤقت، فكل طلباته للأبد بتطلع بالاسم ده.
   • الخبر الحلو: العرض بيقرا من الدفتر **حيّ**، فتصليح الاسم في الدفتر
     بيصلّح الطلبات القديمة كمان (مثبت: طلب mko7mRE8wp اتغيّر لحظياً).

   فالموديول ده:
   1. `plausibleName` — القاعدة الواحدة اللي بتقول ده اسم ولا نص مؤقت.
   2. `bestNameFor(phone)` — أحسن اسم حقيقي عندنا للرقم (الحساب ← الطلبات ←
      تسجيل الكاشير).
   3. `ensurePosName(phone)` — بيصلّح صف الدفتر لو اسمه مؤقت (وعمره ما بيدهس
      اسم حقيقي كتبه الكاشير).
   4. كنس دوري لكل الأسماء المؤقتة القديمة.
   5. `linkPosOrders` — بيربط مرآة الطلب في نقطة البيع بطلب الموقع (عن طريق
      tenant_order_id) ويكتب اسم/جوال العميل في order_sources عشان التقارير
      وملف العميل و«جديد ولا راجع» يطلعوا صح.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as ts from "./tabsense.js";

/* اسم الدفتر بيبقى اسم العميل على كل طلباته، فاللي مش اسم مايتكتبش.
   تاب سينس مليانة نصوص كاشير («الاسم الكامل 111111»، أرقام، نصوص مؤقتة)،
   ونسخها أسوأ من إننا نسيب الخانة فاضية والعميل يملاها.
   ملحوظة: «عميلة» و«عميلة الصفا» أسماء بني آدمين في الدفتر، فالقاعدة على
   كلمة «عميل» لوحدها (أو متبوعة بمسافة) مش على أي كلمة بتبدأ بيها.
   القاعدة **مثبّتة على أول الاسم**، مش على أي جزء منه: «Test Customer» اسم
   بني آدم عادي، و«test» لوحده نص مؤقت. الفرق ده مهم لأن نفس القاعدة بتقفل
   الشيك أوت دلوقتي — وقاعدة واسعة معناها عميل بيدفع بيتمنع. */
export function plausibleName(s) {
  const v = String(s || "").trim();
  if (v.length < 2 || v.length > 60) return false;
  if (/^[\d\s\-_.+]+$/.test(v)) return false;               // أرقام/علامات بس
  if (/^عميل( |$)/.test(v)) return false;                   // النصوص المؤقتة بتاعتنا
  // نص مؤقت لوحده (يمكن وراه أرقام/نقط زي «الاسم الكامل 111111») — مش جزء من اسم
  if (/^(الاسم الكامل|بدون اسم|full ?name|unknown|n\/?a|test|tester|x+)[\d\s.]*$/i.test(v)) return false;
  return true;
}

/* تاب سينس بترفض اسم أول أقل من ٣ حروف، وترفض لقب من حرف أو حرفين — واللقب
   الفاضي مقبول. فبنقسم ونرمي اللقب القصير بدل ما نخسر الصف كله. */
const letters = (s) => (String(s || "").match(/\p{L}/gu) || []).length;

export function splitName(s) {
  const parts = String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  /* لقب قصير في الأول («د.» / «ام») بيخلي الاسم الأول أقل من ٣ حروف وتاب
     سينس بترفض الصف بصمت — فبنضم الكلمة اللي بعده بدل ما نخسر الاسم كله.
     «د. هاني السيد» ← «د. هاني» + «السيد». */
  const head = [parts[0]];
  let i = 1;
  while (i < parts.length && letters(head.join(" ")) < 3) { head.push(parts[i]); i++; }
  const first = head.join(" ").slice(0, 30);
  const rest = parts.slice(i).join(" ").slice(0, 30);
  return { first, last: rest.length >= 3 ? rest : "" };
}

/* الاسم اللي هيتكتب في الدفتر لازم يعدّي قواعد تاب سينس كمان (٣ حروف على
   الأقل في الاسم الأول)، مش بس يبقى «اسم معقول». */
export function writableName(s) {
  if (!plausibleName(s)) return null;
  const { first, last } = splitName(s);
  // ٣ حروف على الأقل في الاسم الأول (شرط تاب سينس)، وحروف حقيقية مش رموز:
  // «M E» طوله ٣ بس فيه حرفين — ده مش اسم.
  if (first.length < 3 || letters(first) < 3) return null;
  return { first, last, full: `${first} ${last}`.trim() };
}

/* نفس قاعدة plausibleName بس في SQL، عشان التقارير ماتعرضش نص مؤقت لسه
   ماتصلّحش في الدفتر. الترتيب: اسم الدفتر لو اسم حقيقي ← اسم اتسجّل على
   الطلب (الموقع/الكاشير). */
export const POS_NAME_SQL = (tc = "tc", src = "s") =>
  `COALESCE(NULLIF(CASE WHEN ${tc}.name ~ '^عميل( |$)' OR ${tc}.name ~ '^[0-9 .+_-]+$'
                        THEN '' ELSE ${tc}.name END, ''),
            NULLIF(${src}.customer_name, ''))`;

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, normPhone } = ctx;
  const tsp = deps.tsp || (() => null);
  const THROTTLE_MS = Number(process.env.TABSENSE_THROTTLE_MS || 200);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const enabled = () => Boolean(process.env.TABSENSE_EMAIL && process.env.TABSENSE_PASSWORD);

  /* ── أحسن اسم حقيقي عندنا للرقم ──────────────────────────────────────
     الترتيب: الحساب (العميل كتبه بنفسه) ← آخر طلب موقع ← تسجيل الكاشير.
     كله بيعدّي على plausibleName الأول — مصدر فيه نص مؤقت مابيتحسبش. */
  async function bestNameFor(phoneNorm) {
    const pn = String(phoneNorm || "");
    if (!/^5\d{8}$/.test(pn)) return null;
    const r = await pool.query(
      `SELECT (SELECT name FROM acct_customers WHERE phone_norm=$1)                      AS acct,
              (SELECT customer->>'name' FROM shop_orders
                WHERE phone_norm=$1 AND COALESCE(btrim(customer->>'name'),'')<>''
                ORDER BY created_at DESC LIMIT 1)                                        AS shop,
              (SELECT customer_name FROM order_sources
                WHERE phone_norm=$1 AND COALESCE(btrim(customer_name),'')<>''
                ORDER BY filled_at DESC LIMIT 1)                                         AS cashier`,
      [pn]).catch(() => ({ rows: [{}] }));
    const row = r.rows[0] || {};
    for (const cand of [row.acct, row.shop, row.cashier]) {
      const w = writableName(cand);
      if (w) return w.full;
    }
    return null;
  }

  /* ── تصليح اسم الرقم في دفتر نقطة البيع ──────────────────────────────
     بيشتغل **بس** لما اسم الدفتر مؤقت/مش اسم. لو الكاشير كاتب اسم حقيقي
     بنسيبه (قرار عمر ١٤/٨: بيانات تاب سينس هي الأصل).
     مابيرميش أبداً — بيرجّع سبب. */
  async function ensurePosName(phoneNorm, preferred = null) {
    if (!enabled()) return { ok: false, reason: "tabsense_off" };
    const pn = String(phoneNorm || "");
    if (!/^5\d{8}$/.test(pn)) return { ok: false, reason: "invalid_phone" };

    const want = writableName(preferred) || writableName(await bestNameFor(pn));
    if (!want) return { ok: false, reason: "no_real_name" };

    const cur = (await pool.query(
      "SELECT customer_id, name FROM ts_customers WHERE phone_norm=$1 ORDER BY customer_id LIMIT 1", [pn]
    ).catch(() => ({ rows: [] }))).rows[0];

    let customerId = cur && cur.customer_id;
    if (cur && plausibleName(cur.name)) return { ok: true, reason: "already_named", name: cur.name, changed: false };
    // الصف ممكن يكون اتعمل حالاً ولسه ماوصلش الكاش — نسأل اللوحة بالجوال
    if (!customerId) customerId = await ts.findCustomerIdByPhone(pn).catch(() => null);
    if (!customerId) return { ok: false, reason: "not_in_directory", name: want.full };

    const res = await ts.updateCustomerName({ customerId, firstName: want.first, lastName: want.last })
      .catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) return { ok: false, reason: res.error || "update_failed", customerId };
    // الكاش المحلي يمشي ورا اللوحة فوراً — من غير كده الكنس بيعيد نفس الصف
    await pool.query("UPDATE ts_customers SET name=$2, updated_at=NOW() WHERE customer_id=$1",
      [String(customerId), want.full]).catch(() => {});
    return { ok: true, changed: res.changed !== false, customerId, name: want.full };
  }

  /* ── كنس الأسماء المؤقتة القديمة ─────────────────────────────────────
     كل صف في الدفتر اسمه مش اسم واحنا عارفين اسمه الحقيقي من أي مصدر. */
  /* نص مؤقت اتخزّن على الحساب (رجع من كاش الجهاز قبل ما نقفل الباب): بنفضّيه
     عشان الشيك أوت يسأل العميل عن اسمه الحقيقي المرة الجاية، وعشان ما يمشيش
     لدفتر نقطة البيع. بنفضّي بس اللي فعلاً نص مؤقت. */
  async function clearPlaceholderAccountNames() {
    const rows = (await pool.query(
      "SELECT phone_norm, name FROM acct_customers WHERE COALESCE(btrim(name),'') <> ''"
    ).catch(() => ({ rows: [] }))).rows;
    const bad = rows.filter((r) => !plausibleName(r.name)).map((r) => r.phone_norm);
    if (!bad.length) return 0;
    const r = await pool.query(
      "UPDATE acct_customers SET name=NULL WHERE phone_norm = ANY($1::text[])", [bad]).catch(() => ({ rowCount: 0 }));
    return r.rowCount || 0;
  }

  async function sweepNames({ limit = 40, dryRun = false } = {}) {
    if (!enabled()) return { ok: false, error: "tabsense_off" };
    const rows = (await pool.query(
      `SELECT c.customer_id, c.phone_norm, c.name,
              COALESCE(NULLIF(btrim(a.name),''),
                       NULLIF(btrim(s.name),''),
                       NULLIF(btrim(os.customer_name),'')) AS best
         FROM ts_customers c
         LEFT JOIN acct_customers a ON a.phone_norm = c.phone_norm
         LEFT JOIN LATERAL (SELECT customer->>'name' AS name FROM shop_orders
                             WHERE phone_norm = c.phone_norm
                               AND COALESCE(btrim(customer->>'name'),'') <> ''
                             ORDER BY created_at DESC LIMIT 1) s ON TRUE
         LEFT JOIN LATERAL (SELECT customer_name FROM order_sources
                             WHERE phone_norm = c.phone_norm
                               AND COALESCE(btrim(customer_name),'') <> ''
                             ORDER BY filled_at DESC LIMIT 1) os ON TRUE
        WHERE c.phone_norm ~ '^5[0-9]{8}$'
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT 2000`)).rows;

    const todo = rows.filter((r) => !plausibleName(r.name) && writableName(r.best));
    const out = { ok: true, candidates: todo.length, fixed: 0, failed: 0, skipped: rows.length - todo.length,
                  accountNamesCleared: dryRun ? null : await clearPlaceholderAccountNames(), details: [] };
    if (dryRun) {
      out.details = todo.slice(0, limit).map((r) => ({ customerId: r.customer_id, from: r.name, to: writableName(r.best).full }));
      return out;
    }
    for (const r of todo.slice(0, limit)) {
      const want = writableName(r.best);
      try {
        const res = await ts.updateCustomerName({ customerId: r.customer_id, firstName: want.first, lastName: want.last });
        if (res.ok) {
          out.fixed++;
          await pool.query("UPDATE ts_customers SET name=$2, updated_at=NOW() WHERE customer_id=$1",
            [String(r.customer_id), want.full]).catch(() => {});
        } else { out.failed++; out.details.push({ customerId: r.customer_id, error: res.error || "rejected" }); }
      } catch (e) {
        out.failed++; out.details.push({ customerId: r.customer_id, error: e.message });
      }
      await sleep(THROTTLE_MS + 150);
    }
    return out;
  }

  /* ── ربط مرآة نقطة البيع بطلب الموقع ─────────────────────────────────
     المفتاح: API الشركاء بيرجّع `tenant_order_id = "<store>-<id>"` والـid ده
     هو بالظبط `ts_orders.order_id`. (pos_order_id المقنّع مالوش أي علاقة
     بيه — ده اللي كان مضيّع الربط.)
     النتيجة بتتكتب في order_sources: مصدر الطلب «website» + اسم وجوال
     العميل الحقيقي، فالتقارير وملف العميل و«جديد ولا راجع» يبقوا صح.
     عمرنا ما بندهس صف كتبه الكاشير — بنملا الناقص فيه بس. */
  async function tenantOrderIdOf(posOrderId) {
    const partner = tsp();
    if (!partner) return null;
    const r = await partner.api(`/orders/${posOrderId}`);
    const d = (r && (r.data || r)) || {};
    const raw = String(d.tenant_order_id || "");
    const m = raw.match(/(\d+)\s*$/);
    return m ? m[1] : null;
  }

  async function linkPosOrders({ limit = 100, dryRun = false } = {}) {
    const rows = (await pool.query(
      `SELECT order_no, pos_order_id, pos_tenant_order_id, phone_norm, customer->>'name' AS name, created_at
         FROM shop_orders
        WHERE pos_order_id IS NOT NULL AND COALESCE(phone_norm,'') <> ''
          AND (is_test IS NOT TRUE)
        ORDER BY created_at DESC
        LIMIT $1`, [Math.min(Number(limit) || 100, 500)])).rows;

    const out = { ok: true, scanned: rows.length, linked: 0, alreadyLinked: 0, noTenantId: 0, failed: 0, details: [] };
    for (const r of rows) {
      let tid = r.pos_tenant_order_id;
      if (!tid) {
        try { tid = await tenantOrderIdOf(r.pos_order_id); } catch (e) { tid = null; }
        if (tid) await pool.query("UPDATE shop_orders SET pos_tenant_order_id=$2 WHERE order_no=$1", [r.order_no, tid]).catch(() => {});
      }
      if (!tid) { out.noTenantId++; continue; }
      const has = await pool.query(
        "SELECT filled_by, COALESCE(phone_norm,'') AS pn FROM order_sources WHERE order_id=$1", [tid]);
      if (has.rowCount && has.rows[0].pn) { out.alreadyLinked++; continue; }
      if (dryRun) { out.linked++; out.details.push({ orderNo: r.order_no, tid }); continue; }
      const nm = (writableName(r.name) || writableName(await bestNameFor(r.phone_norm)) || {}).full || "";
      try {
        await pool.query(
          `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by, filled_at,
                                      customer_name, customer_phone, phone_norm)
           VALUES ($1,'website',$2,'unknown','shop',NOW(),$3,$4,$5)
           ON CONFLICT (order_id) DO UPDATE SET
             customer_name = COALESCE(NULLIF(EXCLUDED.customer_name,''), order_sources.customer_name),
             customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone,''), order_sources.customer_phone),
             phone_norm    = COALESCE(NULLIF(EXCLUDED.phone_norm,''), order_sources.phone_norm),
             -- مصدر كتبه الكاشير بإيده بيفضل زي ما هو؛ بنصحّح التلقائي بس
             source      = CASE WHEN order_sources.filled_by IN ('auto','shop') THEN 'website' ELSE order_sources.source END,
             source_note = CASE WHEN order_sources.filled_by IN ('auto','shop') THEN EXCLUDED.source_note ELSE order_sources.source_note END,
             filled_by   = CASE WHEN order_sources.filled_by IN ('auto','shop') THEN 'shop' ELSE order_sources.filled_by END`,
          [tid, String(r.order_no), nm.slice(0, 120), r.phone_norm ? "+966" + r.phone_norm : "", r.phone_norm || ""]);
        out.linked++;
      } catch (e) { out.failed++; out.details.push({ orderNo: r.order_no, error: e.message }); }
    }
    return out;
  }

  /* الصورة الحالية: كام صف مؤقت فاضل، وكام طلب لسه مش مربوط. */
  async function statusReport() {
    const q = async (sql, p = []) => (await pool.query(sql, p).catch(() => ({ rows: [{}] }))).rows;
    const dir = await q(`SELECT name, count(*)::int n FROM ts_customers WHERE phone_norm ~ '^5[0-9]{8}$' GROUP BY 1`);
    let placeholders = 0, fixable = 0;
    for (const r of dir) if (!plausibleName(r.name)) placeholders += r.n;
    const fix = await q(
      `SELECT count(*)::int n FROM ts_customers c
         LEFT JOIN acct_customers a ON a.phone_norm=c.phone_norm
        WHERE c.phone_norm ~ '^5[0-9]{8}$' AND COALESCE(btrim(a.name),'') <> ''`);
    fixable = fix[0]?.n || 0;
    const links = await q(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE pos_tenant_order_id IS NOT NULL)::int with_tid
         FROM shop_orders WHERE pos_order_id IS NOT NULL`);
    return { ok: true, directoryPlaceholders: placeholders, namesWeKnow: fixable, posMirrors: links[0] || {} };
  }

  /* ── routes (أدمن) ──────────────────────────────────────────────────── */
  app.get("/api/pos/names/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json(await statusReport());
  });
  app.post("/api/pos/names/sweep", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch {}
    return c.json(await sweepNames({ limit: Number(b.limit) || 40, dryRun: b.dryRun === true }));
  });
  app.post("/api/pos/names/fix", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch {}
    const pn = normPhone(b.phone);
    return c.json(await ensurePosName(pn, b.name || null));
  });
  app.post("/api/pos/link-orders", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch {}
    return c.json(await linkPosOrders({ limit: Number(b.limit) || 100, dryRun: b.dryRun === true }));
  });

  /* كنس دوري خفيف: الأسماء المؤقتة اللي عرفنا أصحابها بعد كده، والطلبات
     اللي لسه مش مربوطة. الاتنين آمنين للتكرار. */
  async function runCycle() {
    try {
      if (enabled()) {
        const r = await sweepNames({ limit: 15 });
        if (r.fixed) console.log(`[posnames] fixed ${r.fixed} POS name(s), ${r.failed} failed`);
      }
      const l = await linkPosOrders({ limit: 60 });
      if (l.linked) console.log(`[posnames] linked ${l.linked} POS mirror order(s) to website orders`);
    } catch (e) { console.error("[posnames] cycle failed:", e.message); }
  }
  if (process.env.POSNAMES_CRON !== "0") {
    setTimeout(runCycle, 90_000);
    setInterval(runCycle, 30 * 60_000);
  }

  return { plausibleName, writableName, bestNameFor, ensurePosName, sweepNames, linkPosOrders, tenantOrderIdOf, clearPlaceholderAccountNames, runCycle };
}
