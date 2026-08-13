/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEMCHECK — «هل كل حاجة شغالة؟» في نداء واحد.

   ── ليه الملف ده موجود ────────────────────────────────────────────────────
   النظام بقى ٤٠+ موديول وسبع شاشات، وكل شاشة بتعرف نُص الحقيقة. المالك مش
   محتاج يفتح سبعة تبويبات عشان يعرف إذا كان في حاجة واقعة — محتاج سطر واحد
   فوق، وتحته: إيه المكسور، بيمنع إيه، ومين اللي بيصلّحه.

   ── القاعدة الأولى: مش بنحسب أي رقم من جديد ───────────────────────────────
   الملف ده **مجمِّع، مش حاسب**. كل رقم بيتجاب بنداء داخلي على نفس المسار
   اللي الشاشة التانية بتقراه (`app.request`) — مش باستعلام SQL جديد. السبب
   مباشر: أكبر مرض في المشروع ده إن موديولين يعرّفوا «البيعة» أو «العميل
   الجديد» بطريقتين، فالشاشتين يقولوا رقمين. لو الصفحة دي كتبت استعلامها
   الخاص كانت هتبقى التعريف الثامن — والصفحة اللي المفروض تكشف التناقض تبقى
   هي نفسها مصدره. فبنسأل نفس الراوت، وبنعرض جوابه زي ما هو.

   ── القاعدة التانية: الغلطة مش صفر ────────────────────────────────────────
   ده الباج اللي وقع أربع مرات في يوم واحد: نداء بيفشل، الكود بيقرا الفشل
   كرقم، والرقم بيتعرض للمالك كأنه حقيقة. فكل قيمة هنا شكلها:

       { ok: true,  value: 42,   how: "من /api/x" }
       { ok: false, value: null, how: "...", why: "نص الخطأ بالحرف" }

   `value` بيبقى `null` لما `ok` تبقى false — مش صفر، ولا آخر رقم معروف
   متقدَّم كأنه جديد. والواجهة بتكتب «مقدرناش نقيس» ومعاها السبب. أي حاجة
   الملف ده مش قادر يتأكد منها بيقول «مش متأكد» بصوت عالي بدل ما يفترض إنها
   تمام — الافتراض الجميل أخطر من الخبر الوحش.

   ── القاعدة التالتة: الحيّ يثبت إنه حيّ ──────────────────────────────────
   وجود الكود مش دليل إنه بيشتغل. كل شغلة مجدولة هنا بتتحاسب بآخر أثر حقيقي
   سابته في الداتابيز (ap_runs, aud_syncs, content_posts …) مقارنة بالمدة
   المفروض تشتغل فيها. كرون وقف من غير ما يزعّق هو أخطر عطل في النظام ده،
   وده المكان اللي بيبان فيه.

   ملحوظة على العمر: كل الجدولة `setInterval` جوّه العملية نفسها — يعني كل
   نشر بيصفّر العدّادات. فمهلة كل شغلة هنا = ضِعف دورتها + هامش، عشان نشرة
   واحدة متطلّعش إنذار كاذب.

   GET  /api/system/status        الصورة كاملة (admin)
   POST /api/system/tasks/:id     يقفل/يفتح بند من قايمة المالك (admin)
═══════════════════════════════════════════════════════════════════════════ */

const CACHE_MS = 90_000;          // النداء بيلمس المنصات، فمش كل رفرش يروح لبرّه
const STORE_BASE = process.env.CATALOG_MENU_BASE || "https://order.o2m8.me";

/* قيمة متقاسة. `ok:false` معناها القيمة null — مش صفر، ومش رقم قديم. */
const M = (ok, value, how, why) =>
  ok ? { ok: true, value, how } : { ok: false, value: null, how, why: why || "مقدرناش نقيس" };

const isoOf = (d) => (d ? new Date(d).toISOString() : null);
const minsSince = (iso) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null);

/* ─────────────────────────────────────────────────────────────────────────
   الشغل المجدول: كل واحدة وآخر أثر حقيقي سابته، ومهلتها.
   `graceMin` = ضِعف الدورة + هامش. أقل من كده والنشر بيعمل إنذار كاذب.
   `quietWhenIdle` = الدورة دي مبتسجّلش غير لما تتحرّك فعلاً، فالمهلة مش
   مقياس ليها خالص — بتتحاسب بنبضة العملية بدل كده (شوف الشرح تحت).
   ───────────────────────────────────────────────────────────────────────── */
const JOBS = [
  {
    id: "ap_cycle", label: "دورة الطيار الكاملة", everyMin: 60, graceMin: 150,
    what: "بتقرا أرقام المنصات، بتطلّع القرارات، وبترفع الجماهير والتحويلات.",
    selfHeals: "أيوه — بتشتغل تاني لوحدها كل ساعة، وبتشتغل مرة عند كل تشغيل.",
  },
  {
    id: "ap_pace", label: "إيقاع اليوم (كل ٥ دقايق)", everyMin: 5, quietWhenIdle: true,
    what: "بتقيس مبيعات النهاردة لحد دلوقتي وبتزوّد أو تقلّل الميزانية جوّه اليوم.",
    selfHeals: "أيوه — دورة مستقلة كل ٥ دقايق.",
    quietOk: "مبتسجّلش غير لما تحرّك ميزانية فعلاً. سكوتها معناه إن الإيقاع جوّه المنطقة الطبيعية — مش إنها واقفة.",
  },
  {
    id: "ap_daypart", label: "نافذة الإعلانات (فتح/قفل)", everyMin: 5, quietWhenIdle: true,
    what: "بتوقف الإعلانات والمطبخ مقفول وبترجّعها قبل الفتح بساعة.",
    selfHeals: "أيوه — واللي اتوقف متسجّل في الداتابيز، فحتى لو الخدمة وقعت بترجّع لوحدها.",
    quietOk: "مبتسجّلش غير لما توقف أو ترجّع حملة. التأكيد الحقيقي إن الإعلانات شغالة جاي من فحص النافذة تحت.",
  },
  {
    id: "aud_sync", label: "رفع الجماهير للمنصات", everyMin: 60, graceMin: 180,
    what: "بيرفع قوايم العملاء (مشفّرة) لميتا وسناب وتيك توك للريتارجيت.",
    selfHeals: "أيوه — جزء من دورة الطيار.",
  },
  {
    id: "content_pub", label: "ناشر انستجرام/فيسبوك", everyMin: 5, graceMin: 1440,
    what: "بينشر البوستات المجدولة في ميعادها. انستجرام ملهاش جدولة، فدي جدولتنا.",
    selfHeals: "أيوه — والصف محجوز في الداتابيز فمفيش نشر مرتين.",
    quietOk: "مفيش بوست ميعاده جه — السكوت هنا طبيعي مش عطل.",
  },
  {
    id: "ts_sync", label: "سحب الطلبات من نقطة البيع", everyMin: 5, graceMin: 40,
    what: "بيجيب طلبات وعملاء TabSense — ده مصدر كل رقم مبيعات في النظام.",
    selfHeals: "أيوه — كل ٥ دقايق.",
  },
];

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const tsState = deps.tsState || (() => ({}));

  let cache = { at: 0, payload: null };

  /* ── قايمة المالك ─────────────────────────────────────────────────────
     البنود اللي محتاجة إيده. بعضها بنقيسه بنفسنا (العرض الناقص من المنيو،
     نسبة تعليم الكاشير، روابط التوصيل) وبعضها حالة على منصة برّه مبنقدرش
     نقراها من غير متصفح — دي بتتكتب «غير مقيس آليًا» بالحرف، عشان محدش
     يقرا سطر مكتوب بالإيد كأنه قياس. */
  async function schema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sys_tasks (
        id TEXT PRIMARY KEY,
        rank INT NOT NULL DEFAULT 50,
        title TEXT NOT NULL,
        why TEXT,
        prevents TEXT,
        screen TEXT,
        button TEXT,
        who TEXT NOT NULL DEFAULT 'owner',
        status TEXT NOT NULL DEFAULT 'open',
        measured BOOL NOT NULL DEFAULT false,
        note TEXT,
        done_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const t of SEED_TASKS) {
      await pool.query(
        `INSERT INTO sys_tasks (id, rank, title, why, prevents, screen, button, who, measured, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           rank=EXCLUDED.rank, title=EXCLUDED.title, why=EXCLUDED.why,
           prevents=EXCLUDED.prevents, screen=EXCLUDED.screen, button=EXCLUDED.button,
           measured=EXCLUDED.measured, note=EXCLUDED.note, updated_at=NOW()`,
        [t.id, t.rank, t.title, t.why, t.prevents, t.screen, t.button, t.who || "owner",
          !!t.measured, t.note || null]);
    }
    console.log("[systemcheck] schema ready");
  }
  schema().catch((e) => console.error("[systemcheck] schema", e.message));

  /* نداء داخلي على راوت بتاعنا. بيرجّع { ok, data, why } — والفشل بيفضل
     فشل، عمره ما بيتحوّل لصفر. */
  async function inner(path, auth) {
    try {
      const res = await app.request(path, { headers: auth ? { authorization: auth } : {} });
      const text = await res.text();
      if (!res.ok) return { ok: false, why: `${res.status}: ${text.slice(0, 180)}` };
      try { return { ok: true, data: JSON.parse(text) }; }
      catch { return { ok: false, why: "رد مش JSON" }; }
    } catch (e) {
      return { ok: false, why: String(e?.message || e).slice(0, 180) };
    }
  }

  /* ── حياة الشغل المجدول، من آثار حقيقية ────────────────────────────── */
  async function jobLiveness() {
    const out = {};
    const one = async (id, sql, params = []) => {
      try {
        const r = await pool.query(sql, params);
        return isoOf(r.rows[0]?.at || null);
      } catch (e) { out[`${id}__err`] = String(e?.message || e).slice(0, 140); return undefined; }
    };

    const lastFull = await one("ap_cycle",
      `SELECT max(started_at) AS at FROM ap_runs
        WHERE COALESCE(summary->>'kind','full') = 'full'`);
    const lastPace = await one("ap_pace",
      `SELECT max(started_at) AS at FROM ap_runs WHERE summary->>'kind' = 'pace'`);
    // الدايبارت مبيسيبش صف في ap_runs كل دورة — بيسيب أثر بس لما يوقف أو
    // يرجّع حملة. فبنقراه من ap_daypart، ولو النافذة مفتوحة طول اليوم
    // الجدول ممكن يبقى ساكت بحق — وده مكتوب تحت مش متسكّت.
    const lastDaypart = await one("ap_daypart",
      `SELECT GREATEST(max(paused_at), max(resumed_at)) AS at FROM ap_daypart`);
    const lastAud = await one("aud_sync",
      `SELECT max(created_at) AS at FROM aud_syncs`);
    const lastPub = await one("content_pub",
      `SELECT max(published_at) AS at FROM content_posts WHERE published_at IS NOT NULL`);
    const nextDue = await one("content_due",
      `SELECT min(scheduled_at) AS at FROM content_posts
        WHERE status='scheduled' AND scheduled_at IS NOT NULL`);

    return { lastFull, lastPace, lastDaypart, lastAud, lastPub, nextDue, errs: out };
  }

  /* دورات ماتت في نُصّها. النشر بيقتل العملية جوّه الدورة، فالصف بيفضل
     `running` للأبد. مش بيأذي (القفل في الذاكرة مش في الداتابيز) — بس أي
     شاشة بتقرا «في دورة شغالة دلوقتي» هتفضل تكدب. فبنعدّهم ونقولهم. */
  async function orphanRuns() {
    try {
      const r = await pool.query(
        `SELECT count(*)::int AS n, max(started_at) AS newest FROM ap_runs
          WHERE status='running' AND started_at < NOW() - interval '30 minutes'`);
      return { n: r.rows[0]?.n || 0, newest: isoOf(r.rows[0]?.newest) };
    } catch { return null; }
  }

  /* روابط تطبيقات التوصيل — بتتقاس من إعدادات المتجر الحيّة، مش من خريطة
     مكتوبة في الكود. الخريطة المكتوبة بتفضل تكدب بعد ما المالك يصلّح الرابط. */
  async function goLinks() {
    try {
      const res = await fetch(`${STORE_BASE}/api/config`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return M(false, null, `من ${STORE_BASE}/api/config`, `رد ${res.status}`);
      const cfg = await res.json();
      const links = cfg.links || {};
      const rows = ["keeta", "hungerstation", "ninja"].map((k) => {
        const url = String(links[k] || "");
        const real = !!url && !url.includes("order.o2m8.me");
        return { app: k, url: url || null, real };
      });
      return M(true, rows, `من إعدادات المتجر الحيّة على ${STORE_BASE}`);
    } catch (e) {
      return M(false, null, `من ${STORE_BASE}/api/config`, String(e?.message || e).slice(0, 140));
    }
  }

  /* العرض اللي في الإعلانات ومش في المنيو. بيتقاس من نفس الكتالوج اللي
     بيروح للمنصات — لو الصنف مش هناك، الكاشير مش هيقدر يدقّه. */
  function comboCheck(catalogRes) {
    if (!catalogRes.ok) return M(false, null, "من /api/catalog/status", catalogRes.why);
    const d = catalogRes.data || {};
    const dineIn = Array.isArray(d.dineInOnly) ? d.dineInOnly : [];
    const has70 = dineIn.some((x) => /٧٠|\b70\b/.test(String(x.title || "")));
    return M(true, { has70, dineInTitles: dineIn.map((x) => x.title) },
      "من الكتالوج اللي بيروح للمنصات (/api/catalog/status)");
  }

  async function build(auth) {
    const [ads, apHealth, catalog, content, aud, instore, tracking, go, live, orphans] =
      await Promise.all([
        inner("/api/ads/status", auth),
        inner("/api/autopilot/health", auth),
        inner("/api/catalog/status", auth),
        inner("/api/content/status", auth),
        inner("/api/audiences/status", auth),
        inner("/api/attribution/instore-health", auth),
        inner("/api/tracking/health", auth),
        goLinks(),
        jobLiveness(),
        orphanRuns(),
      ]);

    /* ── ١) الشغل الآلي ─────────────────────────────────────────────── */
    const ts = tsState() || {};
    const lastOf = {
      ap_cycle: live.lastFull,
      ap_pace: live.lastPace,
      ap_daypart: live.lastDaypart,
      aud_sync: live.lastAud,
      content_pub: live.lastPub,
      ts_sync: ts.lastSyncAt || null,
    };
    /* ── السكوت مش دليل موت ────────────────────────────────────────────
       الدورات السريعة (الإيقاع، النافذة، الناشر) بترجع من بدري من غير ما
       تسيب صف لما مفيش حاجة تتعمل — وده مقصود، عشان متضربش المنصات ١٢
       نداء كل ٥ دقايق عشان تطلع بـ«مفيش داعي». يعني «مفيش صف من ٦ ساعات»
       معناه «مفيش شغل»، مش «الكرون وقف».

       أول نسخة من الصفحة دي قرت السكوت ده كعطل وكتبت «🔴 في حاجة واقعة»
       الساعة ٢ بالليل والمطعم بيقفل — وده بالظبط نفس الغلطة اللي الصفحة
       اتعملت عشانها: استنتاج فشل واثق من غياب دليل.

       فالدليل الصح على إن مؤقتات العملية شغالة هو نبضة الدورة الكاملة —
       دي بتسجّل كل مرة من غير شروط. لو هي حيّة، العملية حيّة، والدورات
       السريعة المتعلّقة بنفس المؤقتات شغّالة معاها. */
    const heartbeatAge = minsSince(live.lastFull);
    const processAlive = heartbeatAge != null && heartbeatAge <= 150;

    const jobs = JOBS.map((j) => {
      const at = lastOf[j.id] || null;
      const age = minsSince(at);
      let state = "unknown", line = "مفيش أثر — مش متأكدين إنها اشتغلت أصلاً.";

      if (j.quietWhenIdle) {
        // مبتتحاسبش بالمهلة أصلاً — بتتحاسب بنبضة العملية.
        if (processAlive) {
          state = "idle";
          line = at
            ? `آخر مرة تحرّكت من ${age} دقيقة. ${j.quietOk}`
            : `عمرها ما تحرّكت. ${j.quietOk}`;
        } else {
          state = "unknown";
          line = `مش متأكدين — نبضة الطيار نفسها ساكتة، فمش قادرين نأكّد إن الدورة دي شغالة.`;
        }
        return { ...j, lastAt: at, ageMin: age, state, line };
      }

      if (at != null && age != null) {
        if (age <= j.graceMin) { state = "live"; line = `آخر مرة اشتغلت من ${age} دقيقة.`; }
        else { state = "late"; line = `آخر مرة اشتغلت من ${age} دقيقة — المفروض كل ${j.everyMin} دقيقة.`; }
      }
      // الناشر بيسكت بحق لما مفيش بوست ميعاده جه.
      if (state === "late" && j.id === "content_pub" && !live.nextDue) {
        state = "idle"; line = j.quietOk;
      }
      return { ...j, lastAt: at, ageMin: age, state, line };
    });

    /* ── ٢) المنصات الأربعة ─────────────────────────────────────────── */
    const platforms = ads.ok
      ? (ads.data.platforms || []).map((p) => ({
        id: p.id, label: p.label,
        configured: !!p.configured,
        canManage: !!p.canManageCampaigns,
        blocked: !!p.blocked,
        blockedReason: p.blockedReason || null,
        blockedCode: p.blockedCode || null,
        lastSentAt: p.lastSentAt || null,
        sent24h: M(true, p.sent24h ?? 0, "من /api/ads/status"),
        failed24h: M(true, p.failed24h ?? 0, "من /api/ads/status"),
        lastFailure: p.lastFailure || null,
        note: p.note || null,
      }))
      : [];
    const platformsMeta = ads.ok
      ? M(true, platforms.length, "من /api/ads/status")
      : M(false, null, "من /api/ads/status", ads.why);

    /* ── ٣) اللي مكسور ──────────────────────────────────────────────── */
    const problems = [];
    // مشاكل الطيار جاية جاهزة مرتّبة ومعاها مين بيصلّح — مش بنعيد كتابتها.
    if (apHealth.ok) for (const p of (apHealth.data.problems || [])) problems.push({ ...p, from: "الطيار" });
    else problems.push({
      rank: 1, tone: "bad", who: "us", from: "الطيار",
      line: "مقدرناش نقرا حالة الطيار.", prevents: "كل حكم على الإعلانات.",
      action: { what: apHealth.why, screen: "—", button: "—" },
    });

    if (tracking.ok && tracking.data.healthy === false) {
      problems.push({
        rank: 6, tone: "warn", who: "us", from: "التتبع",
        line: `التتبع فيه ${(tracking.data.problems || []).length} ملاحظة.`,
        prevents: "دقة نسب الإعلانات ومطابقة العملاء على المنصات.",
        detail: (tracking.data.problems || []).slice(0, 12),
        action: { what: "افتح تبويب 📡 التتبع للتفصيل.", screen: "📡 التتبع", button: "—" },
      });
    }

    for (const j of jobs) {
      if (j.state === "late") problems.push({
        rank: 2, tone: "bad", who: "us", from: "الجدولة",
        line: `«${j.label}» متأخرة: ${j.line}`,
        prevents: j.what,
        action: { what: "دي حاجة من عندنا — مش محتاجة منك حاجة.", screen: "—", button: "—" },
      });
      if (j.state === "unknown") problems.push({
        rank: 5, tone: "warn", who: "us", from: "الجدولة",
        line: `«${j.label}»: مفيش أثر يثبت إنها اشتغلت. مش متأكدين.`,
        prevents: j.what,
        action: { what: "محتاجة فحص من عندنا.", screen: "—", button: "—" },
      });
    }

    if (orphans && orphans.n > 0) problems.push({
      rank: 9, tone: "warn", who: "us", from: "الجدولة",
      line: `${orphans.n} دورة مسجّلة «شغالة» وهي مماتتش خلاص — النشر قطعها في نُصّها.`,
      prevents: "مش بيأثر على الشغل نفسه، بس بيوسّخ السجل.",
      action: { what: "تنضيف من عندنا.", screen: "—", button: "—" },
    });

    /* ── ٤) قايمة المالك، مقيسة حيثما أمكن ──────────────────────────── */
    const combo = comboCheck(catalog);
    const tagRate = instore.ok
      ? M(true, instore.data.totals?.tagRate ?? null, "من /api/attribution/instore-health")
      : M(false, null, "من /api/attribution/instore-health", instore.why);
    const taggedN = instore.ok ? (instore.data.totals?.tagged ?? null) : null;
    const ordersN = instore.ok ? (instore.data.totals?.orders ?? null) : null;

    const evidence = {
      combo70: combo,
      cashierTagging: tagRate,
      cashierTaggedOf: instore.ok
        ? M(true, `${taggedN} من ${ordersN}`, "من /api/attribution/instore-health")
        : M(false, null, "من /api/attribution/instore-health", instore.why),
      goLinks: go,
      tiktokBlocked: ads.ok
        ? M(true, platforms.find((p) => p.id === "tiktok")?.blocked ?? null, "من /api/ads/status")
        : M(false, null, "من /api/ads/status", ads.why),
      igQuota: content.ok
        ? M(true, content.data.igQuota?.used ?? null, "من /api/content/status")
        : M(false, null, "من /api/content/status", content.why),
      audienceSegments: aud.ok
        ? M(true, (aud.data.segments || []).length, "من /api/audiences/status")
        : M(false, null, "من /api/audiences/status", aud.why),
    };

    let tasks = [];
    try {
      const r = await pool.query(`SELECT * FROM sys_tasks ORDER BY rank ASC, created_at ASC`);
      tasks = r.rows.map((t) => {
        const row = {
          id: t.id, rank: t.rank, title: t.title, why: t.why, prevents: t.prevents,
          screen: t.screen, button: t.button, who: t.who, status: t.status,
          measured: t.measured, note: t.note, doneAt: isoOf(t.done_at),
        };
        // البنود المقيسة بتتحدّث لوحدها من الواقع — قفلها بالإيد مش بيخفيها
        // لو لسه المشكلة موجودة.
        if (t.id === "menu-combo70" && combo.ok) {
          row.live = combo.value.has70
            ? { ok: true, line: "العرض بقى في المنيو ✔" }
            : { ok: false, line: `لسه مش في المنيو. اللي موجود داخل الصالة: ${combo.value.dineInTitles.join("، ") || "ولا صنف"}` };
        }
        if (t.id === "cashier-tagging" && tagRate.ok && tagRate.value != null) {
          const pct = Math.round(tagRate.value * 1000) / 10;
          row.live = { ok: tagRate.value >= 0.5, line: `التعليم دلوقتي ${pct}٪ — ${taggedN} من ${ordersN} طلب.` };
        }
        if (t.id === "go-links" && go.ok) {
          const dead = go.value.filter((x) => !x.real).map((x) => x.app);
          row.live = dead.length
            ? { ok: false, line: `لسه راجعة على المتجر نفسه: ${dead.join("، ")}` }
            : { ok: true, line: "كل الروابط بقت حقيقية ✔" };
        }
        if (t.id === "tiktok-oauth" && evidence.tiktokBlocked.ok) {
          row.live = evidence.tiktokBlocked.value === false
            ? { ok: true, line: "تيك توك بقت بتقرا وبترفع ✔" }
            : { ok: false, line: "لسه متقفلة — التوكن مش واخد الصلاحيات." };
        }
        return row;
      });
    } catch (e) {
      problems.push({
        rank: 3, tone: "warn", who: "us", from: "حالة النظام",
        line: "مقدرناش نقرا قايمة البنود.", prevents: "عرض اللي محتاج منك.",
        action: { what: String(e?.message || e).slice(0, 140), screen: "—", button: "—" },
      });
    }

    const openTasks = tasks.filter((t) => t.status !== "done");

    /* ── ٥) الخلاصة ─────────────────────────────────────────────────── */
    problems.sort((a, b) => (a.rank || 50) - (b.rank || 50));
    const broken = problems.filter((p) => p.tone === "bad");
    const warn = problems.filter((p) => p.tone === "warn");
    const jobsLate = jobs.filter((j) => j.state === "late" || j.state === "unknown");

    let tone = "good";
    let line = "كل الشغل الآلي ماشي، والمنصات بتردّ.";
    if (broken.length) {
      tone = "bad";
      line = `في ${broken.length} حاجة واقعة — ${broken[0].line}`;
    } else if (jobsLate.length) {
      tone = "bad";
      line = `${jobsLate.length} شغلة مجدولة متأخرة أو مش متأكدين منها.`;
    } else if (warn.length) {
      tone = "warn";
      line = `الشغل الآلي ماشي، بس في ${warn.length} ملاحظة محتاجة عين.`;
    }
    const ownerCount = openTasks.length;
    if (ownerCount) line += ` وعندك ${ownerCount} بند مستني إيدك.`;

    /* ── ٦) آلي تمامًا × محتاج إنسان ────────────────────────────────── */
    const automatic = [
      "سحب الطلبات والعملاء من نقطة البيع كل ٥ دقايق.",
      "فتح وقفل الإعلانات مع مواعيد المطبخ — واللي اتوقف بيرجع لوحده.",
      "زيادة وتقليل الميزانية جوّه اليوم حسب المبيعات الفعلية.",
      "إيقاف الحملة اللي بتحرق فلوس بقواعد مكتوبة وسقف مصاريف.",
      "رفع قوايم العملاء (مشفّرة) لميتا وسناب للريتارجيت.",
      "رفع أحداث الشراء للمنصات (CAPI) مع منع التكرار.",
      "تحديث كتالوج المنيو على المنصات لما الأسعار تتغيّر.",
      "نشر البوستات المجدولة على فيسبوك وانستجرام في ميعادها.",
      "إعادة بناء نسب الإسناد وربط الطلب بالعميل كل ساعة.",
    ];
    const manual = [
      "الموافقة على قرارات الطيار الكبيرة (لو الوضع «اقتراح» مش «تلقائي»).",
      "تصوير ونشر تيك توك — بالإيد لحد ما التطبيق يتقبل.",
      "أي حاجة على حساب منصة برّه: توثيق، فواتير، صلاحيات.",
      "تعليم مصدر الطلب على الكاشير — ده الوحيد اللي مفيش بديل آلي ليه.",
      "إضافة صنف جديد على نقطة البيع.",
    ];

    return {
      ok: true,
      at: new Date().toISOString(),
      overall: { tone, line, brokenCount: broken.length, warnCount: warn.length, ownerCount },
      jobs,
      platforms,
      platformsMeta,
      window: apHealth.ok ? (apHealth.data.window || null) : null,
      verified: apHealth.ok ? (apHealth.data.verified || null) : null,
      problems,
      tasks,
      evidence,
      automatic,
      manual,
      sources: {
        ads: ads.ok ? "ok" : ads.why,
        autopilotHealth: apHealth.ok ? "ok" : apHealth.why,
        catalog: catalog.ok ? "ok" : catalog.why,
        content: content.ok ? "ok" : content.why,
        audiences: aud.ok ? "ok" : aud.why,
        instore: instore.ok ? "ok" : instore.why,
        tracking: tracking.ok ? "ok" : tracking.why,
        storefront: go.ok ? "ok" : go.why,
        jobErrors: live.errs,
      },
    };
  }

  app.get("/api/system/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const fresh = c.req.query("fresh") === "1";
    if (!fresh && cache.payload && Date.now() - cache.at < CACHE_MS) {
      return c.json({ ...cache.payload, cached: true });
    }
    const payload = await build(c.req.header("authorization") || "");
    cache = { at: Date.now(), payload };
    return c.json({ ...payload, cached: false });
  });

  app.post("/api/system/tasks/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const status = String(b.status || "").trim();
    if (!["open", "done", "blocked"].includes(status)) {
      return c.json({ ok: false, error: "status must be open|done|blocked" }, 400);
    }
    const r = await pool.query(
      `UPDATE sys_tasks SET status=$2, done_at=$3, note=COALESCE($4, note), updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [id, status, status === "done" ? new Date() : null,
        b.note != null ? String(b.note) : null]);
    if (!r.rows[0]) return c.json({ ok: false, error: "not found" }, 404);
    cache = { at: 0, payload: null };
    return c.json({ ok: true, task: r.rows[0] });
  });

  console.log("[systemcheck] routes ready");
  return { build };
}

/* ─────────────────────────────────────────────────────────────────────────
   البنود المزروعة. الترتيب بالأثر على الفلوس، مش بالسهولة.

   اللي `measured: true` بنقيسه بنفسنا وبيتحدّث لوحده تحت كل بند.
   اللي `measured: false` حالة على منصة برّه مبنقدرش نقراها من غير متصفح —
   مكتوبة هنا عشان متتنسيش، ومعلَّمة إنها **مش مقيسة** عشان محدش يفتكرها
   قياس. لو حصلت من غير ما نعرف، المالك بيقفلها بإيده.
   ───────────────────────────────────────────────────────────────────────── */
const SEED_TASKS = [
  {
    id: "meta-verification", rank: 1, measured: false,
    title: "وثّق النشاط على ميتا (Business Verification)",
    why: "الحساب لسه على أصغر حصة API (development_access). الحصة دي هي السبب المباشر إن ٣٣٤ أمر إيقاف "
      + "اترفض في ليلة واحدة، والإعلانات فضلت شغالة والمطبخ مقفول. التوثيق بيفتح الحصة الأكبر.",
    prevents: "إن الطيار يقدر يوقف الإعلانات ساعة ما يقرر — دلوقتي بيتمنع ساعات الذروة.",
    screen: "Meta Business Suite ← Settings ← Business info ← Security Center",
    button: "Start verification / تابع الطلب لو مكتوب In review",
    note: "الحالة المكتوبة عندنا: In review — وعدت بيومين وعدّت المدة. غير مقيس آليًا: محتاج تفتح الصفحة وتشوف.",
  },
  {
    id: "gbp-website", rank: 2, measured: false,
    title: "حط رابط الموقع على بروفايل جوجل، واسحب ملكيته",
    why: "٤٫٧ نجمة و١٥٧ تقييم بيوصّلوا الناس لبروفايل مفيهوش رابط طلب. دي أرخص زيادة مبيعات موجودة — "
      + "الناس دي بتدوّر عليك بالاسم وبتوصل لحيطة. والبروفايل ملكه حساب جوجل مش معروف.",
    prevents: "كل زيارة بحث مجانية على اسم المطعم بتضيع من غير ما تتحوّل لطلب.",
    screen: "Google Business Profile ← تعديل الملف ← الموقع الإلكتروني",
    button: "أضف https://order.o2m8.me — ولو مش مالك: «طلب الوصول / Request access»",
    note: "غير مقيس آليًا.",
  },
  {
    id: "tiktok-oauth", rank: 3, measured: true,
    title: "ادخل بحساب تيك توك ووافق على الصلاحيات تاني",
    why: "التطبيق بتاعنا اتقبل، بس التوكن اللي معانا اتعمل قبل القبول فمش شايل الصلاحيات الجديدة. "
      + "الدليل: أحداث الشراء بتتقبل على تيك توك عادي، ورفع الجماهير بس هو اللي بيترفض بصلاحية باسمها. "
      + "يعني الباب مش مقفول — التوكن بس محتاج تجديد بموافقتك.",
    prevents: "قراءة أرقام تيك توك ورفع جماهير الريتارجيت عليها. الصرف والإيقاف شغّالين عادي.",
    screen: "TikTok for Business ← Developers ← My Apps ← التطبيق ← Authorize",
    button: "Authorize / Re-authorize وبعدين ابعتلنا الكود",
    note: "الشاشة بتاعتنا كانت بتقول «مفيش حاجة تتعمل من عندك» — ده كان كلام قديم متكتّب في الكود.",
  },
  {
    id: "google-billing", rank: 4, measured: false,
    title: "سدّد تحذير الدفع المتأخر على جوجل",
    why: "في تحذير «past due» من ٣ أغسطس. الحملة دلوقتي بتصرف وبتظهر، بس الحساب اللي عليه متأخرات "
      + "ممكن يتوقف فجأة من غير إنذار — ووقتها بنخسر فترة التعلّم كلها.",
    prevents: "استمرار حملة البحث اللي لسه بتتعلّم.",
    screen: "Google Ads ← الفوترة (Billing) ← ملخّص",
    button: "سدّد الآن / Fix payment method",
    note: "غير مقيس آليًا.",
  },
  {
    id: "menu-combo70", rank: 5, measured: true,
    title: "ضيف عرض الـ ٧٠ ريال على نقطة البيع",
    why: "الإعلانات والبوستات بتقول «بيتزا + باستا + كريب — ٧٠ ريال»، والصنف ده مش موجود في المنيو "
      + "أصلاً. يعني العميل بيدخل يطلبه والكاشير مش لاقيه. بندفع على الضغطة وبنخسر العميل.",
    prevents: "إن العرض اللي بندفع عليه إعلانات يتباع.",
    screen: "TabSense ← المنيو ← إضافة صنف (صفحة العروض)",
    button: "أضف صنف: «بيتزا + باستا + كريب — ٧٠ ريال — داخل الصالة فقط»",
  },
  {
    id: "cashier-tagging", rank: 6, measured: true,
    title: "خلّي الكاشير يعلّم مصدر كل طلب",
    why: "من غير التعليم ده مفيش طريقة نعرف بيها إعلان جاب كام طلب داخل المطعم. النسبة دلوقتي شبه صفر، "
      + "يعني كل قرار على إعلانات الصالة مبني على تخمين. ده البند الوحيد اللي مفيش حل آلي ليه.",
    prevents: "قياس أي إعلان بيجيب طلبات جوّه المطعم — وده أغلب البيع.",
    screen: "محطة الكاشير ← /#cashier (الرقم السري في الإعدادات)",
    button: "بعد كل طلب: اختار المصدر (سناب / تيك توك / إعلان / زبون قديم)",
    note: "التصنيف بين صالة وسفري باظ يوم ١ أغسطس والسبب نفسه: انضباط الإدخال.",
  },
  {
    id: "go-links", rank: 7, measured: true,
    title: "هات روابط متجرك على هنقرستيشن ونينجا",
    why: "لينكات /go/hungerstation و /go/ninja لسه راجعة على المتجر بتاعنا نفسه. أي إعلان عليهم "
      + "بيوّدي العميل لمكان تاني غير اللي وعدناه بيه، والقياس بيطلع صفر. كيتا مظبوط خلاص.",
    prevents: "قياس أي حملة بتوّدي على تطبيقات التوصيل.",
    screen: "افتح تطبيق هنقرستيشن ونينجا ← صفحة المطعم ← مشاركة ← نسخ الرابط",
    button: "ابعت الرابطين وإحنا نركّبهم",
  },
  {
    id: "google-brand-keywords", rank: 8, measured: false,
    title: "صعّد رفض كلمتَي اسم المطعم على جوجل",
    why: "«فريش كاتس» و«مطعم فريش كاتس» اترفضوا تاني بسبب «Sensitive events» حتى بعد طلب استثناء. "
      + "وفي نفس الوقت «فريش كتس» (من غير ألف) **مقبولة وشغالة**. نفس الاسم وفرق حرف واحد — "
      + "ده أقوى دليل إن الرفض غلطة تصنيف آلي، واستعمله في التصعيد.",
    prevents: "إن اللي بيدوّر على اسم المطعم بالظبط يلاقيك.",
    screen: "Google Ads ← الكلمات المفتاحية ← المرفوضة ← Appeal",
    button: "Appeal واكتب: «فريش كتس» approved / «فريش كاتس» disapproved — نفس العلامة",
    note: "غير مقيس آليًا — الحالة اتقرت من الـ API ساعة المراجعة.",
  },
];
