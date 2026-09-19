/* ═══════════════════════════════════════════════════════════════════════════
   SYSHEALTH — «حالة النظام» بمكوّنات النهارده (٢٠٢٦-٠٩-١٩)

   /api/system/status (systemcheck.js) اتبنى وقت ما النظام كان إعلانات وطيّار
   بس. من ساعتها بقى عندنا: ربط شريك تاب سينس + webhooks، مندوب لأجلك، SMS
   تقنيات، ماي فاتورة، جوجل Routes/Places، ناشر انستجرام/فيسبوك، رحلة العميل،
   استرجاع السلة، قايمة «نبّهني لما تفتحوا»، رسايل التقييم، والنسخ الاحتياطي.
   الشاشة كانت بتقول «كله تمام» وهي مابتبصّش على نصهم.

   القاعدة هنا: كل مكوّن بيتحاسب بـ**آخر أثر حقيقي** في الداتابيز (أو نداء
   حي للمتجر)، مش بوجود الكود. والحالة:
     good    أخضر  — شغّال وفيه دليل حديث
     warn    أصفر  — شغّال بس فيه حاجة محتاجة عين (أو مفيش دليل حديث وده ممكن يكون طبيعي)
     bad     أحمر  — واقف أو فشل مؤكد
     unknown رمادي — مقدرناش نقيس (الغلطة مش «تمام» ومش صفر)
   كل مكوّن بيرجّع checkedAt + last (آخر أثر) + line (جملة واحدة) + fix.

   الـ«مفتوح/مقفول» مهم: مفيش طلبات الساعة ٦ الصبح ده طبيعي، فالمهلات بتتحسب
   على مواعيد المطعم (settings.hours — نفس المصدر بتاع المتجر).

   GET  /api/system/health           (admin) — دايماً HTTP 200 (كلاودفلير بيبلع الـ5xx)
   POST /api/system/heartbeat/:name  (admin) — نبضة من برّه العملية (النسخ الاحتياطي)
═══════════════════════════════════════════════════════════════════════════ */
import { isOpenNow } from "./carts.js";

const CACHE_MS = 60_000;
const STOREFRONT = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
const iso = (d) => (d ? new Date(d).toISOString() : null);
const minsSince = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null);
const ar = (n) => String(n).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
const ago = (m) => (m == null ? "—" : m < 1 ? "من أقل من دقيقة" : m < 90 ? `من ${ar(m)} دقيقة`
  : m < 48 * 60 ? `من ${ar(Math.round(m / 60))} ساعة` : `من ${ar(Math.round(m / 1440))} يوم`);
export const TONES = ["good", "warn", "bad", "unknown"];
export const TONE_LABELS = { good: "شغّال", warn: "محتاج عين", bad: "واقف", unknown: "مش مقاس" };

/** مكوّن — شكل واحد لكل البنود. صافية. */
export function comp(id, group, label, status, line, { last = null, detail = null, fix = null } = {}) {
  return { id, group, label, status: TONES.includes(status) ? status : "unknown", statusLabel: TONE_LABELS[status] || TONE_LABELS.unknown,
    line, last: iso(last), lastAgo: last ? ago(minsSince(last)) : null, detail, fix, checkedAt: new Date().toISOString() };
}

/** حالة «آخر أثر» بمهلة (بالدقايق). المقفول ⇒ الأصفر بيبقى أخضر (السكوت طبيعي). صافية. */
export function freshness(lastAt, { warnMin, badMin, open = true }) {
  const m = minsSince(lastAt);
  if (m == null) return "unknown";
  if (!open) return m > badMin * 4 ? "warn" : "good";
  return m > badMin ? "bad" : m > warnMin ? "warn" : "good";
}

/** الخلاصة: الأسوأ يغلب. صافية. */
export function overallOf(components) {
  const n = { good: 0, warn: 0, bad: 0, unknown: 0 };
  for (const c of components) n[c.status] = (n[c.status] || 0) + 1;
  const tone = n.bad ? "bad" : n.warn || n.unknown ? "warn" : "good";
  const worst = components.find((c) => c.status === "bad") || components.find((c) => c.status === "warn");
  const line = n.bad ? `${ar(n.bad)} مكوّن واقف — ${worst.label}: ${worst.line}`
    : n.warn ? `كله شغّال، و${ar(n.warn)} محتاجين عين${n.unknown ? ` (و${ar(n.unknown)} مش مقاسين)` : ""}.`
      : n.unknown ? `كله شغّال، بس ${ar(n.unknown)} مش مقاسين.` : "كل المكوّنات شغّالة وفيها دليل حديث.";
  return { tone, counts: n, line };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const tsp = deps.tsp || (() => null);
  const tsState = deps.tsState || (() => ({}));
  const insightsState = deps.insightsState || (() => ({}));
  let cache = { at: 0, payload: null };

  pool.query(`CREATE TABLE IF NOT EXISTS sys_heartbeats (
      name TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ok BOOLEAN NOT NULL DEFAULT TRUE,
      note TEXT, count INT NOT NULL DEFAULT 1)`).catch((e) => console.error("[syshealth] schema:", e.message));

  const q1 = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || {};
  async function inner(path, auth) {
    try {
      const res = await app.request(path, { headers: auth ? { authorization: auth } : {} });
      const text = await res.text();
      if (!res.ok) return { ok: false, why: `${res.status}` };
      return { ok: true, data: JSON.parse(text) };
    } catch (e) { return { ok: false, why: String(e?.message || e).slice(0, 160) }; }
  }
  // كل فحص معزول: فحص بيقع مايوقعش الصفحة، وبيطلع «مش مقاس» بالسبب
  const guard = (id, group, label) => async (fn) => {
    try { return await fn(); }
    catch (e) { return comp(id, group, label, "unknown", `مقدرناش نقيس: ${String(e?.message || e).slice(0, 140)}`); }
  };

  async function build(auth) {
    const s = (await getSettingsData().catch(() => ({}))) || {};
    const open = isOpenNow(s.hours);
    const checks = [];
    const add = (id, group, label, fn) => checks.push(guard(id, group, label)(fn));

    /* ── الأساس ─────────────────────────────────────────────────────── */
    add("api", "core", "الـAPI (السيرفر)", async () => {
      await pool.query("SELECT 1");
      const up = Math.round(process.uptime() / 60);
      const commit = String(process.env.SOURCE_COMMIT || "").slice(0, 7) || "—";
      const mem = Math.round(process.memoryUsage().rss / 1048576);
      return comp("api", "core", "الـAPI (السيرفر)", "good", `شغّال والداتابيز بترد — آخر نشر ${ago(up)} (نسخة ${commit}).`,
        { last: new Date(Date.now() - up * 60000), detail: { uptimeMin: up, commit, rssMb: mem } });
    });

    // الصفحة الرئيسية بتتقري مرة واحدة: المتجر + فحص التاجات (Clarity/GA)
    let homeP = null;
    const getHome = () => (homeP ||= fetch(`${STOREFRONT()}/`, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "freshcuts-health" } })
      .then(async (r) => ({ ok: r.ok, status: r.status, text: r.ok ? await r.text() : "" }))
      .catch((e) => ({ ok: false, status: 0, text: "", err: String(e.message || e) })));
    add("storefront", "core", "المتجر freshcuts.sa", async () => {
      const t0 = Date.now();
      const [home, menu] = await Promise.all([
        getHome(),
        fetch(`${STOREFRONT()}/api/menu?branch_id=1`, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "freshcuts-health" } }),
      ]);
      const ms = Date.now() - t0;
      let items = 0;
      if (menu.ok) { const j = await menu.json().catch(() => null); items = (j?.data?.pages || []).reduce((a, p) => a + (p.items || []).length, 0); }
      const st = !home.ok || !menu.ok || !items ? "bad" : ms > 6000 ? "warn" : "good";
      return comp("storefront", "core", "المتجر freshcuts.sa", st,
        st === "bad" ? `الصفحة ${home.status} / المنيو ${menu.status} (${ar(items)} صنف) — العملاء مش قادرين يطلبوا.`
          : `الصفحة والمنيو شغّالين (${ar(items)} صنف) في ${ar((ms / 1000).toFixed(1))} ثانية.`,
        { last: new Date(), detail: { homeStatus: home.status, menuStatus: menu.status, items, ms },
          fix: st === "bad" ? "راجع حاوية المتجر على السيرفر (docker compose ps في freshcuts-storefront)." : null });
    });

    /* ── تاب سينس ───────────────────────────────────────────────────── */
    add("ts_partner", "tabsense", "تاب سينس — ربط الشريك (التوكن)", async () => {
      const api = tsp();
      if (!api) return comp("ts_partner", "tabsense", "تاب سينس — ربط الشريك (التوكن)", "unknown", "الموديول مش متسجّل.");
      const st = await api.status();
      const leftMin = st.expiresAt ? Math.round((new Date(st.expiresAt) - Date.now()) / 60000) : null;
      const auto = String(process.env.TSP_AUTO_ORDER || "") === "1";
      let status = "good", line = `متصل (${st.env})، التوكن صالح ${leftMin != null ? `${ar(Math.round(leftMin / 60))} ساعة` : "—"}، الطلبات بتنزل تلقائي ${auto ? "✓" : "✗"}.`;
      if (!st.configured || !st.connected) { status = "bad"; line = "مش متصل — الطلبات الأونلاين مش هتنزل نقطة البيع."; }
      else if (leftMin != null && leftMin <= 0) { status = "bad"; line = "التوكن انتهى — التجديد التلقائي فشل."; }
      else if (leftMin != null && leftMin < 60) { status = "warn"; line = `التوكن فاضل عليه ${ar(leftMin)} دقيقة (التجديد بيحصل كل ٢٠ دقيقة لو فاضل أقل من ٦ ساعات).`; }
      else if (!auto) { status = "warn"; line = "متصل بس TSP_AUTO_ORDER مقفول — الطلبات مش بتنزل كمدفوعة مسبقاً."; }
      return comp("ts_partner", "tabsense", "تاب سينس — ربط الشريك (التوكن)", status, line,
        { last: st.connectedAt, detail: { env: st.env, expiresAt: iso(st.expiresAt), autoOrder: auto },
          fix: status === "bad" ? "اللوحة ← الإعدادات ← تاب سينس ← «اربط من جديد»." : null });
    });

    add("ts_webhooks", "tabsense", "تاب سينس — Webhooks (قبول/جاهز)", async () => {
      const r = await q1(`SELECT max(received_at) AS last, count(*) FILTER (WHERE received_at > NOW() - interval '24 hours')::int AS n24
                            FROM tsp_webhooks`);
      const o = await q1(`SELECT count(*)::int AS n FROM shop_orders WHERE created_at > NOW() - interval '24 hours'
                            AND pos_order_id IS NOT NULL AND coalesce(is_test,false) = false`);
      // مفيش طلبات أونلاين النهارده ⇒ مفيش webhooks وده طبيعي
      const st = !r.last ? "unknown" : o.n ? freshness(r.last, { warnMin: 180, badMin: 720, open }) : "good";
      return comp("ts_webhooks", "tabsense", "تاب سينس — Webhooks (قبول/جاهز)", st,
        r.last ? `آخر حدث ${ago(minsSince(r.last))} — ${ar(r.n24)} حدث في ٢٤ ساعة لـ${ar(o.n)} طلب أونلاين.` : "عمرنا ما استلمنا حدث.",
        { last: r.last, detail: { events24h: r.n24, onlineOrders24h: o.n },
          fix: st === "bad" ? "الطلبات بتتقفل «جاهز» بالمسح الاحتياطي كل دقيقتين — كلّم تاب سينس لو الأحداث وقفت." : null });
    });

    add("ts_sync", "tabsense", "سحب طلبات نقطة البيع (ts_orders)", async () => {
      const ts = tsState() || {};
      const ins = insightsState() || {};
      const r = await q1(`SELECT max(updated_at) AS upd, max(order_date) AS newest FROM ts_orders`);
      const last = ins.lastOrdersSyncAt || ts.lastSyncAt || r.upd;
      let st = freshness(last, { warnMin: 15, badMin: 45, open: true });
      const newestMin = minsSince(r.newest);
      if (st === "good" && open && newestMin != null && newestMin > 180) st = "warn";
      const err = ins.lastError || ts.lastError || null;
      return comp("ts_sync", "tabsense", "سحب طلبات نقطة البيع (ts_orders)", st,
        `آخر سحب ${ago(minsSince(last))}، وآخر طلب في الكاش ${ago(newestMin)}${err ? ` — آخر خطأ: ${String(err).slice(0, 80)}` : ""}.`,
        { last, detail: { lastSyncAt: iso(last), newestOrderAt: iso(r.newest), lastError: err },
          fix: st === "bad" ? "التقارير واقفة على آخر سحب. غالباً دخول لوحة تاب سينس (TABSENSE_EMAIL/PASSWORD) — راجع اللوج." : null });
    });

    /* ── التشغيل ───────────────────────────────────────────────────── */
    add("leajlak", "ops", "لأجلك — متابعة المندوب", async () => {
      const r = await q1(`SELECT count(*)::int AS n, min(updated_at) AS oldest, max(updated_at) AS newest FROM dl_shipments
                            WHERE lower(coalesce(status,'')) NOT IN ('delivered','cancelled','canceled','failed','returned','completed','rejected')
                              AND created_at > NOW() - interval '12 hours'`);
      const w = await q1(`SELECT max(received_at) AS last FROM dl_webhook_log`);
      const lastAny = await q1(`SELECT max(updated_at) AS last FROM dl_shipments`);
      const st = r.n ? freshness(r.oldest, { warnMin: 10, badMin: 30, open: true }) : "good";
      return comp("leajlak", "ops", "لأجلك — متابعة المندوب", st,
        r.n ? `${ar(r.n)} مشوار شغّال — أقدم تحديث ${ago(minsSince(r.oldest))} (السؤال كل دقيقة؛ لأجلك مابيبعتش webhooks).`
          : `مفيش مشاوير شغّالة دلوقتي — آخر تحديث مشوار ${ago(minsSince(lastAny.last))}.`,
        { last: r.newest || lastAny.last, detail: { inFlight: r.n, lastWebhook: iso(w.last) },
          fix: st === "bad" ? "المتابعة (poll) واقفة على مشوار شغّال — راجع اللوج [delivery] أو حالة لأجلك." : null });
    });

    add("sms", "ops", "SMS (تقنيات)", async () => {
      const r = await q1(`SELECT max(at) FILTER (WHERE ok) AS last_ok, max(at) FILTER (WHERE NOT ok) AS last_fail,
                                 count(*) FILTER (WHERE ok AND at > NOW() - interval '24 hours')::int AS ok24,
                                 count(*) FILTER (WHERE NOT ok AND at > NOW() - interval '24 hours')::int AS fail24
                            FROM shop_order_events WHERE channel='sms' AND at > NOW() - interval '14 days'`);
      const c = await q1(`SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE status='failed')::int AS failed,
                                 max(created_at) FILTER (WHERE status='sent') AS last
                            FROM cms_campaign_sends WHERE created_at > NOW() - interval '24 hours'`);
      const otp = await q1(`SELECT max(created_at) AS last FROM acct_otp`);
      const last = [r.last_ok, c.last].filter(Boolean).sort().pop() || null;
      let st = "good";
      if (r.fail24 && (!r.last_ok || new Date(r.last_fail) > new Date(r.last_ok))) st = "bad";
      else if (r.fail24 || c.failed) st = "warn";
      else if (!last) st = "unknown";
      return comp("sms", "ops", "SMS (تقنيات)", st,
        `رسايل الطلبات: ${ar(r.ok24)} اتبعتت و${ar(r.fail24)} فشلت في ٢٤ ساعة؛ الحملات: ${ar(c.sent)} اتبعتت و${ar(c.failed)} فشلت. آخر OTP ${ago(minsSince(otp.last))}.`,
        { last, detail: { orderOk24: r.ok24, orderFail24: r.fail24, lastFail: iso(r.last_fail), campaignSent24: c.sent, campaignFailed24: c.failed,
          lastOtp: iso(otp.last), smsEnabled: (s.notifications || {}).smsEnabled !== false },
          fix: st === "bad" ? "آخر رسالة فشلت بعد آخر نجاح — راجع رصيد تقنيات أو DNS الحاوية (EAI_AGAIN)." : null });
    });

    add("myfatoorah", "ops", "ماي فاتورة (الدفع)", async () => {
      const keyOk = Boolean(process.env.MYFATOORAH_API_KEY);
      const w = await q1(`SELECT max(created_at) AS last, count(*) FILTER (WHERE NOT signature_ok AND created_at > NOW() - interval '24 hours')::int AS badsig
                            FROM pay_webhook_log`);
      /* «Failed/InProgress» من ماي فاتورة = العميل رفض/لسه بيدفع — مش عطل. العطل = نداء
         مارجعش حالة أصلاً (مفيش mf_tx_status). */
      const e = await q1(`SELECT count(*) FILTER (WHERE ok)::int AS ok,
                                 count(*) FILTER (WHERE NOT ok AND coalesce(data->>'mf_tx_status','') = '')::int AS fail,
                                 count(*) FILTER (WHERE NOT ok AND data->>'mf_tx_status' = 'Failed')::int AS declined
                            FROM shop_order_events WHERE name='payment_check' AND at > NOW() - interval '24 hours'`);
      const paid = await q1(`SELECT max(created_at) AS last, count(*)::int AS n FROM shop_orders
                              WHERE mf_payment_id IS NOT NULL AND coalesce(is_test,false)=false AND created_at > NOW() - interval '7 days'`);
      let st = !keyOk ? "bad" : e.fail > e.ok && e.fail >= 3 ? "bad" : e.fail || w.badsig ? "warn" : "good";
      return comp("myfatoorah", "ops", "ماي فاتورة (الدفع)", st,
        !keyOk ? "مفتاح ماي فاتورة مش موجود — الدفع واقف."
          : `آخر دفعة ناجحة ${ago(minsSince(paid.last))} (${ar(paid.n)} في ٧ أيام)؛ ٢٤ ساعة: ${ar(e.ok)} دفعة اتأكدت، ${ar(e.fail)} نداء فشل، ${ar(e.declined)} فحص لمحاولة مرفوضة من البنك (مش عطل).`,
        { last: paid.last, detail: { keyConfigured: keyOk, checksOk24: e.ok, apiFail24: e.fail, declinedChecks24: e.declined, badSignature24: w.badsig, lastWebhook: iso(w.last) } });
    });

    add("google", "ops", "جوجل — Routes (مسافة التوصيل) وPlaces (التقييم)", async () => {
      const routesKey = Boolean(process.env.GOOGLE_ROUTES_KEY), placesKey = Boolean(process.env.GOOGLE_PLACES_KEY);
      const r = await q1(`SELECT count(*) FILTER (WHERE created_at > date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS today,
                                 count(*) FILTER (WHERE created_at > NOW() - interval '30 days')::int AS d30, max(created_at) AS last FROM geo_drive_cache`);
      const g = s.googlePlace || {};
      const refreshH = Number((s.reviews || {}).googleRefreshHours) || 6;
      const placeAge = minsSince(g.at);
      let st = "good";
      if (!routesKey) st = "bad";
      else if (!placesKey || placeAge == null || placeAge > refreshH * 60 * 2.5 || (g.status && g.status !== "OK" && g.status !== "ok")) st = "warn";
      return comp("google", "ops", "جوجل — Routes (مسافة التوصيل) وPlaces (التقييم)", st,
        `Routes: ${routesKey ? "✓" : "✗ المفتاح ناقص (المسافة بتتقدّر هوائي×١٫٣)"} — ${ar(r.today)} مسافة جديدة النهارده (${ar(r.d30)} في ٣٠ يوم، الباقي من الكاش). `
          + `Places: ${placesKey ? "✓" : "✗"} — التقييم ${g.rating || "—"} (${ar(g.count || 0)}) اتحدّث ${ago(placeAge)}.`,
        { last: r.last, detail: { routesKey, placesKey, routesCallsToday: r.today, routes30d: r.d30, placeStatus: g.status || null, placeAt: iso(g.at),
          quotaNote: "جوجل مابيدّيش الكوتة من الـAPI — العدد هنا = نداءات فعلية (كل عنوان جديد مرة في ٣٠ يوم)." } });
    });

    /* ── الإعلانات والنشر ─────────────────────────────────────────────── */
    add("ads", "marketing", "منصات الإعلانات (ميتا/سناب/تيك توك) + الطيّار", async () => {
      const [ads, runs] = await Promise.all([
        inner("/api/ads/status", auth),
        q1(`SELECT max(started_at) AS last, max(started_at) FILTER (WHERE status='ok' OR status='done' OR error IS NULL) AS last_ok,
                   count(*) FILTER (WHERE error IS NOT NULL AND started_at > NOW() - interval '24 hours')::int AS err24 FROM ap_runs`),
      ]);
      if (!ads.ok) return comp("ads", "marketing", "منصات الإعلانات (ميتا/سناب/تيك توك) + الطيّار", "unknown", `مقدرناش نقرا حالة المنصات (${ads.why}).`, { last: runs.last });
      const plats = (ads.data.platforms || []).filter((p) => p.configured);
      const blocked = plats.filter((p) => p.blocked);
      const cycle = freshness(runs.last, { warnMin: 150, badMin: 360, open: true });
      const st = blocked.length ? "bad" : cycle !== "good" ? cycle : runs.err24 ? "warn" : "good";
      return comp("ads", "marketing", "منصات الإعلانات (ميتا/سناب/تيك توك) + الطيّار", st,
        `${plats.map((p) => `${p.label} ${p.blocked ? "✗" : "✓"}`).join(" · ") || "مفيش منصة متوصلة"} — دورة الطيّار آخر مرة ${ago(minsSince(runs.last))}${runs.err24 ? `، ${ar(runs.err24)} خطأ في ٢٤ ساعة` : ""}.`,
        { last: runs.last, detail: { platforms: plats.map((p) => ({ id: p.id, label: p.label, blocked: !!p.blocked, reason: p.blockedReason || null })) },
          fix: blocked.length ? `${blocked[0].label}: ${blocked[0].blockedReason || "التوكن/الصلاحية"} — مركز التسويق ← الطيّار ← الإعداد.` : null });
    });

    add("social", "marketing", "ناشر انستجرام/فيسبوك (الطابور)", async () => {
      const r = await q1(`SELECT count(*) FILTER (WHERE status IN ('scheduled','queued','approved') AND published_at IS NULL AND scheduled_at < NOW() - interval '30 minutes')::int AS overdue,
                                 count(*) FILTER (WHERE status IN ('scheduled','queued','approved') AND published_at IS NULL AND scheduled_at >= NOW())::int AS upcoming,
                                 count(*) FILTER (WHERE status='failed' AND updated_at > NOW() - interval '48 hours')::int AS failed48,
                                 max(published_at) AS last
                            FROM content_posts WHERE channel IN ('instagram','facebook','ig','fb','ig_story','instagram_story')`);
      const st = r.overdue ? "bad" : r.failed48 ? "warn" : "good";
      return comp("social", "marketing", "ناشر انستجرام/فيسبوك (الطابور)", st,
        `${ar(r.upcoming)} بوست مستني ميعاده، ${ar(r.overdue)} متأخر، ${ar(r.failed48)} فشل في ٤٨ ساعة — آخر نشر ${ago(minsSince(r.last))}.`,
        { last: r.last, detail: r, fix: r.overdue ? "مركز التسويق ← المحتوى ← الطابور: البوست المتأخر فيه سبب الفشل." : null });
    });

    add("analytics", "marketing", "Clarity + جوجل أناليتكس (التتبّع)", async () => {
      const c = await q1(`SELECT max(pulled_at) FILTER (WHERE ok) AS last_ok, max(pulled_at) FILTER (WHERE NOT ok) AS last_fail FROM clarity_pulls`);
      // التاجات بيحمّلها static/analytics.js من /api/config (GA4_ID/CLARITY_ID في .env بتاع المتجر)
      const html = (await getHome()).text;
      let cfgJ = null;
      try { cfgJ = await (await fetch(`${STOREFRONT()}/api/config`, { signal: AbortSignal.timeout(8000) })).json(); } catch { cfgJ = null; }
      const loader = /analytics\.js/.test(html);
      const clarityTag = loader && !!(cfgJ && cfgJ.clarity_id), gaTag = loader && !!(cfgJ && (cfgJ.ga4_id || cfgJ.gtag_loader_id));
      const token = Boolean(process.env.CLARITY_API_TOKEN);
      const pullFresh = freshness(c.last_ok, { warnMin: 36 * 60, badMin: 72 * 60, open: true });
      const st = !html || !cfgJ ? "unknown" : !clarityTag ? "bad" : !token || pullFresh !== "good" || !gaTag ? "warn" : "good";
      return comp("analytics", "marketing", "Clarity + جوجل أناليتكس (التتبّع)", st,
        `على المتجر: Clarity ${clarityTag ? "✓" : "✗"} · GA ${gaTag ? "✓" : "✗"}. سحب تقارير Clarity: ${token ? `آخر نجاح ${ago(minsSince(c.last_ok))}` : "مفيش توكن"}.`,
        { last: c.last_ok, detail: { clarityTag, gaTag, clarityToken: token, lastPullOk: iso(c.last_ok), lastPullFail: iso(c.last_fail) } });
    });

    /* ── رحلة العميل والاسترجاع ─────────────────────────────────────── */
    add("journey", "customers", "رحلة العميل (استقبال الأحداث)", async () => {
      const r = await q1(`SELECT max(at) AS last, count(*) FILTER (WHERE at > NOW() - interval '1 hour')::int AS h1 FROM journey_events
                            WHERE at > NOW() - interval '3 days'`);
      const st = freshness(r.last, { warnMin: 90, badMin: 360, open });
      return comp("journey", "customers", "رحلة العميل (استقبال الأحداث)", st,
        `آخر حدث ${ago(minsSince(r.last))} — ${ar(r.h1)} حدث في آخر ساعة.`, { last: r.last, detail: r,
          fix: st === "bad" ? "journey.js على المتجر مش بيبعت — راجع ?v= في index.html وCORS." : null });
    });

    add("carts", "customers", "استرجاع السلة المتروكة", async () => {
      const on = ((s.abandonedCarts || {}).smsEnabled) === true;
      const r = await q1(`SELECT count(*) FILTER (WHERE started_at > NOW() - interval '24 hours')::int AS carts24,
                                 count(*) FILTER (WHERE step1_at > NOW() - interval '24 hours')::int AS sent24,
                                 count(*) FILTER (WHERE recovered_at > NOW() - interval '7 days')::int AS rec7,
                                 max(greatest(step1_at, step2_at)) AS last FROM cart_recovery`);
      const st = !on ? "warn" : r.carts24 >= 5 && !r.sent24 && open ? "warn" : "good";
      return comp("carts", "customers", "استرجاع السلة المتروكة", st,
        on ? `${ar(r.carts24)} سلة متروكة في ٢٤ ساعة، ${ar(r.sent24)} رسالة استرجاع، ${ar(r.rec7)} طلب رجع في ٧ أيام — آخر رسالة ${ago(minsSince(r.last))}.`
          : "رسايل الاسترجاع مقفولة من الإعدادات.",
        { last: r.last, detail: { enabled: on, ...r } });
    });

    add("waitlist", "customers", "«نبّهني لما تفتحوا»", async () => {
      const on = (s.openWait || {}).enabled !== false;
      const r = await q1(`SELECT count(*) FILTER (WHERE notified_at IS NULL AND created_at > NOW() - interval '48 hours')::int AS waiting,
                                 max(notified_at) AS last, count(*) FILTER (WHERE created_at > NOW() - interval '7 days')::int AS joined7
                            FROM open_waitlist`);
      // المطعم مفتوح بقاله أكتر من ساعة وفيه ناس مستنية ⇒ الإرسال عند الفتح ماحصلش
      const st = !on ? "warn" : open && r.waiting > 0 && minsSince(r.last) > 24 * 60 ? "warn" : "good";
      return comp("waitlist", "customers", "«نبّهني لما تفتحوا»", st,
        on ? `${ar(r.waiting)} مستنيين رسالة الفتح، ${ar(r.joined7)} سجّلوا في ٧ أيام — آخر إرسال ${ago(minsSince(r.last))}.` : "الخاصية مقفولة من الإعدادات.",
        { last: r.last, detail: { enabled: on, ...r } });
    });

    add("reviews", "customers", "رسايل التقييم بعد التوصيل", async () => {
      const on = (s.reviews || {}).active !== false;
      const maxAge = Number((s.reviews || {}).askMaxAgeHours) || 20;
      const r = await q1(`SELECT count(*) FILTER (WHERE sent_at IS NULL AND due_at < NOW() - interval '60 minutes' AND created_at > NOW() - make_interval(hours => $1))::int AS overdue,
                                 count(*) FILTER (WHERE sent_at > NOW() - interval '24 hours')::int AS sent24, max(sent_at) AS last
                            FROM review_invites`, [maxAge]);
      const st = !on ? "warn" : r.overdue >= 3 ? "warn" : "good";
      return comp("reviews", "customers", "رسايل التقييم بعد التوصيل", st,
        on ? `${ar(r.sent24)} رسالة في ٢٤ ساعة، ${ar(r.overdue)} فات ميعادها (ساعات الهدوء ${ar((s.reviews || {}).askQuietStart ?? 2)}→${ar((s.reviews || {}).askQuietEnd ?? 11)} بتأخّرها عادي) — آخر إرسال ${ago(minsSince(r.last))}.`
          : "رسايل التقييم مقفولة.",
        { last: r.last, detail: { enabled: on, ...r } });
    });

    add("push", "customers", "إشعارات المتصفح (Push)", async () => {
      const r = await q1(`SELECT count(*) FILTER (WHERE NOT coalesce(disabled,false))::int AS active,
                                 count(*) FILTER (WHERE NOT coalesce(disabled,false) AND phone_norm IS NOT NULL)::int AS linked, max(last_ok_at) AS last FROM push_subs`);
      return comp("push", "customers", "إشعارات المتصفح (Push)", r.active ? "good" : "warn",
        `${ar(r.active)} مشترك (${ar(r.linked)} مربوط برقم) — آخر إرسال ناجح ${ago(minsSince(r.last))}.`, { last: r.last, detail: r });
    });

    /* ── ربط منصات الإعلانات (adconnect.js، فحص كل ٣ ساعات) ───────────── */
    add("ads_connect", "marketing", "ربط منصات الإعلانات (ميتا/سناب/تيك توك/جوجل)", async () => {
      const rows = (await pool.query(`SELECT platform, ok, configured, detail, checked_at FROM ad_connect_state`).catch(() => ({ rows: [] }))).rows;
      if (!rows.length) return comp("ads_connect", "marketing", "ربط منصات الإعلانات (ميتا/سناب/تيك توك/جوجل)", "unknown", "لسه مفيش فحص — أول فحص بعد النشر بدقيقتين.");
      const bad = rows.filter((r) => r.configured && !r.ok), off = rows.filter((r) => !r.configured);
      const last = rows.map((r) => r.checked_at).sort().slice(-1)[0];
      const st = bad.length ? "bad" : off.length ? "warn" : freshness(last, { warnMin: 7 * 60, badMin: 24 * 60, open: true });
      const line = bad.length ? `واقف: ${bad.map((r) => `${r.platform} (${String(r.detail?.reason || "").slice(0, 60)})`).join("، ")}`
        : `${ar(rows.length - off.length)} من ${ar(rows.length)} متوصّلين${off.length ? ` — مش متظبط: ${off.map((r) => r.platform).join("، ")}` : ""}.`;
      return comp("ads_connect", "marketing", "ربط منصات الإعلانات (ميتا/سناب/تيك توك/جوجل)", st, line,
        { last, detail: rows.map((r) => ({ platform: r.platform, ok: r.ok, configured: r.configured, token: r.detail?.token || null, reason: r.detail?.reason || null })),
          fix: bad.length ? "أعد تفويض المنصة الواقفة وحط التوكن الجديد في env الـapi ثم deploy — GET /api/ads/connections?fresh=1 للتأكد." : null });
    });

    /* ── النسخ الاحتياطي (نبضة من السكربت على السيرفر) ──────────────────── */
    add("backups", "core", "النسخ الاحتياطي (Restic يومي)", async () => {
      const r = await q1(`SELECT at, ok, note FROM sys_heartbeats WHERE name='backup'`);
      const st = !r.at ? "bad" : !r.ok ? "bad" : freshness(r.at, { warnMin: 26 * 60, badMin: 50 * 60, open: true });
      return comp("backups", "core", "النسخ الاحتياطي (Restic يومي)", st,
        !r.at ? "مفيش نبضة من سكربت النسخ خالص — يعني مفيش دليل إن فيه نسخة."
          : `آخر نسخة ${r.ok ? "ناجحة" : "فشلت"} ${ago(minsSince(r.at))}${r.note ? ` — ${String(r.note).slice(0, 80)}` : ""}.`,
        { last: r.at, detail: r, fix: st !== "good" ? "على السيرفر: sudo /usr/local/bin/o2m8-backup وراجع /var/log/restic/." : null });
    });

    const components = await Promise.all(checks);
    return { ok: true, at: new Date().toISOString(), open, overall: overallOf(components), components,
      groups: { core: "الأساس", tabsense: "تاب سينس", ops: "التشغيل والدفع", marketing: "الإعلانات والنشر", customers: "العملاء والرسايل" } };
  }

  app.get("/api/system/health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (c.req.query("fresh") !== "1" && cache.payload && Date.now() - cache.at < CACHE_MS) return c.json({ ...cache.payload, cached: true });
    try {
      const payload = await build(c.req.header("authorization") || "");
      cache = { at: Date.now(), payload };
      return c.json({ ...payload, cached: false });
    } catch (e) {
      return c.json({ ok: false, error: "health_failed", message: String(e?.message || e).slice(0, 200), components: [] });
    }
  });

  app.post("/api/system/heartbeat/:name", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const name = String(c.req.param("name") || "").toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) return c.json({ ok: false, error: "bad_name" }, 400);
    const b = await c.req.json().catch(() => ({}));
    await pool.query(
      `INSERT INTO sys_heartbeats(name, at, ok, note) VALUES ($1, NOW(), $2, $3)
       ON CONFLICT (name) DO UPDATE SET at=NOW(), ok=$2, note=$3, count=sys_heartbeats.count+1`,
      [name, b.ok !== false, b.note ? String(b.note).slice(0, 300) : null]);
    cache = { at: 0, payload: null };
    return c.json({ ok: true });
  });

  return { build };
}
