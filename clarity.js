/* ═══════════════════════════════════════════════════════════════════════════
   🎥 Microsoft Clarity: سحب يومي لـ«إشارات الإحباط» ولوحة جوه رحلة العميل

   طلب عمر (١٨ سبتمبر): نشوف Clarity جوه #store/analytics/journey من غير ما
   نفتح موقع تاني، ونعرف فين الناس بتتعب: dead clicks، rage clicks،
   quickbacks، عمق السكرول، أخطاء JS، مقسّمة بالجهاز والمصدر والصفحة.

   الحقيقة اللي بتحكم التصميم: Data Export API بتاع Clarity بيسمح بـ١٠ طلبات
   بس لكل مشروع في اليوم، وبيرجّع آخر ١–٣ أيام بحد أقصى ٣ تقسيمات لكل طلب.
   فبنسحب مرة واحدة يومياً (٣ طلبات: جهاز×مصدر، صفحة، حملة) ونخزّنهم، واللوحة
   بتقرا من الجدول. زرار «تحديث» يدوي موجود بس محكوم بسقف يومي (DAILY_CAP) عشان
   نسيب هامش.

   مفيش توكن (CLARITY_API_TOKEN) ⇒ الموديول نايم واللوحة بتقول إيه الناقص.
   المفاتيح: CLARITY_API_TOKEN (سرّي، Coolify env) و CLARITY_PROJECT_ID
   (افتراضي yk019wcypa).
═══════════════════════════════════════════════════════════════════════════ */

export const ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";
export const DEFAULT_PROJECT = "yk019wcypa";
export const DAILY_CAP = 9;            // حد Clarity ١٠ — بنسيب طلب هامش
export const PULLS = Object.freeze([    // الطلبات اليومية المجدولة (٣ من ١٠)
  ["Device", "Source"],
  ["URL"],
  ["Campaign"],
]);
export const RETENTION_DAYS = 120;
export const MIN_SESSIONS = 5;          // أقل من كده النسب ضوضاء

// اسم المقياس عند Clarity → اسم الحقل عندنا (نسبة الجلسات اللي فيها الإشارة)
export const SIGNALS = Object.freeze({
  DeadClickCount: "deadClickPct",
  RageClickCount: "rageClickPct",
  QuickbackClick: "quickbackPct",
  ExcessiveScroll: "excessiveScrollPct",
  ScriptErrorCount: "scriptErrorPct",
  ErrorClickCount: "errorClickPct",
});
export const SIGNAL_LABELS = Object.freeze({
  rageClickPct: "ضغط بعصبية (Rage)", deadClickPct: "ضغط على حاجة مابتعملش (Dead)",
  quickbackPct: "دخل ورجع بسرعة (Quickback)", scriptErrorPct: "أخطاء JavaScript",
  errorClickPct: "ضغطة طلّعت خطأ", excessiveScrollPct: "سكرول كتير من غير هدف",
});
// الوزن في «درجة الإحباط»: الـrage وأخطاء الضغط أوضح دليل على مشكلة حقيقية
const WEIGHTS = { rageClickPct: 1.5, errorClickPct: 1.5, deadClickPct: 1, quickbackPct: 1, scriptErrorPct: 0.75, excessiveScrollPct: 0.5 };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r1 = (n) => Math.round(num(n) * 10) / 10;

export function cfg(env = process.env) {
  const token = String(env.CLARITY_API_TOKEN || "").trim();
  const project = String(env.CLARITY_PROJECT_ID || DEFAULT_PROJECT).trim() || DEFAULT_PROJECT;
  return { token, project, enabled: token.length > 20 };
}

export function buildUrl(dims, numOfDays = 1) {
  const qs = new URLSearchParams({ numOfDays: String(Math.min(3, Math.max(1, Number(numOfDays) || 1))) });
  (dims || []).slice(0, 3).forEach((d, i) => qs.set(`dimension${i + 1}`, d));
  return `${ENDPOINT}?${qs}`;
}

/* بيحوّل رد Clarity (مصفوفة {metricName, information[]}) لصفوف: صف لكل تركيبة
   تقسيمات، فيه الجلسات + كل الإشارات كنسب. بنتحمّل اختلاف أسماء الحقول. */
export function normalize(raw, dims) {
  const list = Array.isArray(raw) ? raw : [];
  const rows = new Map();
  const keyOf = (info) => {
    const d = {};
    for (const name of dims) {
      const v = info[name] ?? info[name.toLowerCase()] ?? info[name === "URL" ? "Url" : name];
      d[name] = v == null || v === "" ? "(غير معروف)" : String(v).slice(0, 300);
    }
    return d;
  };
  const rowFor = (info) => {
    const d = keyOf(info);
    const k = JSON.stringify(d);
    if (!rows.has(k)) rows.set(k, { dims: d, sessions: 0, bots: 0 });
    return rows.get(k);
  };
  for (const m of list) {
    const name = m && m.metricName;
    const infos = Array.isArray(m && m.information) ? m.information : [];
    for (const info of infos) {
      if (!info || typeof info !== "object") continue;
      const row = rowFor(info);
      if (name === "Traffic") {
        row.sessions = Math.max(row.sessions, num(info.totalSessionCount ?? info.sessionsCount));
        row.bots = num(info.totalBotSessionCount);
        row.users = num(info.distinctUserCount ?? info.distantUserCount);
        row.pagesPerSession = r1(info.PagesPerSessionPercentage ?? info.pagesPerSession);
      } else if (name === "ScrollDepth") {
        row.scrollDepth = r1(info.averageScrollDepth);
      } else if (name === "EngagementTime") {
        row.activeTime = Math.round(num(info.activeTime));
        row.totalTime = Math.round(num(info.totalTime));
      } else if (SIGNALS[name]) {
        row[SIGNALS[name]] = r1(info.sessionsWithMetricPercentage);
        row.sessions = Math.max(row.sessions, num(info.sessionsCount));
      }
    }
  }
  return [...rows.values()].map((r) => ({ ...r, score: frustrationScore(r) }));
}

export function frustrationScore(r) {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) s += num(r[k]) * w;
  return r1(s);
}

/* ملخص الإجمالي من صفوف تقسيم واحد (مرجّح بعدد الجلسات) */
export function totals(rows) {
  const out = { sessions: 0 };
  const acc = {};
  for (const r of rows) {
    const n = num(r.sessions);
    out.sessions += n;
    for (const k of [...Object.values(SIGNALS), "scrollDepth", "activeTime"]) {
      if (r[k] == null) continue;
      acc[k] = acc[k] || { w: 0, s: 0 };
      acc[k].w += n; acc[k].s += num(r[k]) * n;
    }
  }
  for (const [k, a] of Object.entries(acc)) out[k] = a.w ? r1(a.s / a.w) : null;
  return out;
}

/* أسوأ الصفوف لكل إشارة (بحد أدنى جلسات) + أسوأ صفوف بالدرجة الكلية */
export function topSignals(rows, { min = MIN_SESSIONS, limit = 5 } = {}) {
  const ok = rows.filter((r) => num(r.sessions) >= min);
  const bySignal = {};
  for (const k of Object.values(SIGNALS)) {
    bySignal[k] = ok.filter((r) => num(r[k]) > 0).sort((a, b) => num(b[k]) - num(a[k]) || num(b.sessions) - num(a.sessions)).slice(0, limit)
      .map((r) => ({ dims: r.dims, sessions: r.sessions, pct: r[k] }));
  }
  const worst = ok.slice().sort((a, b) => b.score - a.score).slice(0, limit * 2);
  return { bySignal, worst };
}

/* روابط Clarity: التسجيلات والخرائط الحرارية. فلاتر التسجيلات بتتحط من الواجهة
   (Clarity مابيضمنش شكل ثابت لفلاتر الرابط) — فبنرجّع الرابط + وصف الفلتر. */
export function links(project, dims = {}) {
  const base = `https://clarity.microsoft.com/projects/view/${encodeURIComponent(project)}`;
  const hint = Object.entries(dims).filter(([, v]) => v && v !== "(غير معروف)").map(([k, v]) => `${k}: ${v}`).join(" · ");
  return { recordings: `${base}/impressions`, heatmaps: `${base}/heatmaps`, dashboard: `${base}/dashboard`, filterHint: hint };
}

export const riyadhDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
export const riyadhHour = (d = new Date()) => new Date(d.getTime() + 3 * 3600_000).getUTCHours();

/* هل نسحب دلوقتي؟ مرة يومياً بعد ٦ الصبح بتوقيت الرياض (بعد ما المطعم قفل
   ويوم امبارح اكتمل)، ومش لو السقف خلص. */
export function shouldPull({ lastOkDay, usedToday, now = new Date(), cap = DAILY_CAP, need = PULLS.length }) {
  if (riyadhHour(now) < 6) return false;
  if (lastOkDay === riyadhDay(now)) return false;
  return usedToday + need <= cap;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const fetchFn = deps.fetch || ((...a) => fetch(...a));
  let ready = false;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clarity_pulls (
        id BIGSERIAL PRIMARY KEY,
        pulled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        day DATE NOT NULL,
        dims TEXT NOT NULL,
        num_days INT NOT NULL DEFAULT 1,
        trigger TEXT NOT NULL DEFAULT 'daily',
        ok BOOLEAN NOT NULL DEFAULT FALSE,
        status INT,
        error TEXT,
        rows JSONB
      );
      CREATE INDEX IF NOT EXISTS clarity_pulls_day_idx ON clarity_pulls (day DESC, dims);
    `);
    ready = true;
  }
  const schemaP = ensureSchema().catch((e) => console.error("[clarity] schema failed:", e.message));

  async function usedToday() {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM clarity_pulls WHERE day = $1 AND status IS NOT NULL`, [riyadhDay()]);
    return r.rows[0]?.n || 0;
  }

  async function pullOne(dims, trigger, numOfDays = 1) {
    const c = cfg();
    const day = riyadhDay();
    let status = null, rows = null, error = null;
    try {
      const res = await fetchFn(buildUrl(dims, numOfDays), {
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      const text = await res.text();
      if (!res.ok) error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      else rows = normalize(JSON.parse(text), dims);
    } catch (e) { error = String(e.message || e).slice(0, 200); }
    await pool.query(
      `INSERT INTO clarity_pulls (day, dims, num_days, trigger, ok, status, error, rows) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [day, dims.join("+"), numOfDays, trigger, !!rows, status, error, rows ? JSON.stringify(rows) : null],
    );
    return { ok: !!rows, error };
  }

  let running = false;
  async function runPulls(trigger = "daily") {
    if (running) return { ok: false, error: "busy" };
    const c = cfg();
    if (!c.enabled) return { ok: false, error: "no_token" };
    running = true;
    try {
      await schemaP;
      const used = await usedToday();
      if (used + PULLS.length > DAILY_CAP) return { ok: false, error: "daily_cap", used };
      const out = [];
      for (const dims of PULLS) out.push(await pullOne(dims, trigger));
      return { ok: out.every((x) => x.ok), results: out };
    } finally { running = false; }
  }

  async function tick() {
    try {
      if (!cfg().enabled || !ready) return;
      const r = await pool.query(`SELECT MAX(day)::text AS d FROM clarity_pulls WHERE ok AND trigger = 'daily'`);
      if (shouldPull({ lastOkDay: r.rows[0]?.d || null, usedToday: await usedToday() })) await runPulls("daily");
      await pool.query(`DELETE FROM clarity_pulls WHERE day < CURRENT_DATE - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
    } catch (e) { console.error("[clarity] tick failed:", e.message); }
  }
  const timer = setInterval(tick, 30 * 60_000);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, 90_000);
  if (first.unref) first.unref();

  async function latest() {
    const r = await pool.query(`
      SELECT DISTINCT ON (dims) dims, day::text AS day, pulled_at, num_days, rows
        FROM clarity_pulls WHERE ok ORDER BY dims, pulled_at DESC`);
    return Object.fromEntries(r.rows.map((x) => [x.dims, x]));
  }

  app.get("/api/journey/clarity", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const conf = cfg();
    const base = { ok: true, enabled: conf.enabled, project: conf.project, links: links(conf.project), cap: DAILY_CAP };
    try {
      await schemaP;
      const snaps = await latest();
      const used = await usedToday();
      const lastErr = await pool.query(`SELECT pulled_at, error FROM clarity_pulls WHERE NOT ok ORDER BY pulled_at DESC LIMIT 1`);
      const ds = snaps["Device+Source"], url = snaps.URL, camp = snaps.Campaign;
      const deco = (arr) => (arr || []).map((r) => ({ ...r, links: links(conf.project, r.dims) }));
      const t = ds ? totals(ds.rows) : url ? totals(url.rows) : null;
      const urlTop = url ? topSignals(url.rows) : null;
      return c.json({
        ...base, usedToday: used,
        pulledAt: (ds || url || camp)?.pulled_at || null,
        lastError: lastErr.rows[0] || null,
        totals: t,
        pages: urlTop ? { worst: deco(urlTop.worst), bySignal: Object.fromEntries(Object.entries(urlTop.bySignal).map(([k, v]) => [k, deco(v)])) } : null,
        deviceSource: ds ? deco(ds.rows.filter((r) => r.sessions >= MIN_SESSIONS).sort((a, b) => b.sessions - a.sessions).slice(0, 15)) : null,
        campaigns: camp ? deco(camp.rows.filter((r) => r.sessions >= 1).sort((a, b) => b.sessions - a.sessions).slice(0, 15)) : null,
        signalLabels: SIGNAL_LABELS,
      });
    } catch (e) {
      return c.json({ ...base, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  });

  app.post("/api/journey/clarity/refresh", async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;
    const r = await runPulls("manual");
    return c.json(r);
  });

  return { runPulls, latest };
}
