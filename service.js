/* ⏸️ إيقاف الخدمة مؤقتاً (٢٣/٩) — «المطبخ مضغوط، وقّف التوصيل نص ساعة».
   ──────────────────────────────────────────────────────────────────────
   المشكلة اللي بيحلّها: قبل كده مكانش فيه غير حيلتين — تقفل المطعم كله من
   المواعيد، أو تنزّل نطاق التوصيل لصفر. التانية بتقول للعميل «عنوانك خارج
   نطاق التوصيل» — كلام مش صحيح، وشكله دايم مش مؤقت، وبيلوّث تقارير التغطية.

   الفكرة: مفتاح لكل قناة على حدة (توصيل / استلام) بوقت رجوع اختياري، والرجوع
   بيحصل **من نفسه** لما الوقت يعدّي — مفيش كرون ولا حاجة تفتكر. الحالة
   بتتحسب وقت القراية، فمستحيل تفضل مقفولة بالغلط.

   وبيعيد استخدام ماكينة «نبّهني لما تفتحوا» (openwait.js) زي ما هي: اللي
   حاول يطلب والخدمة موقوفة بيسيب رقمه وسلته، وأول ما نرجع بتوصله رسالة
   برابط سلته. مفيش طابور جديد ولا رسايل جديدة.

   ملاحظة مهمة: ده **مش** بديل لمواعيد العمل. المواعيد بتقفل المطعم كله،
   وده بيوقف قناة واحدة لفترة قصيرة والباقي شغّال.                       */

export const SERVICE_DEFAULTS = Object.freeze({
  delivery: { paused: false, until: null, reason: "" },
  pickup: { paused: false, until: null, reason: "" },
  note: "",
  resumedAt: null,          // آخر مرة رجعت فيها قناة — openwait بيبعت بعدها
});

export const CHANNELS = ["delivery", "pickup"];

/* الرسالة اللي العميل بيشوفها. صادقة ومؤقتة — مش «عنوانك بره النطاق». */
export const pausedText = (ch, until, reason, lang = "ar") => {
  const back = untilText(until, lang);
  if (lang === "en") {
    const what = ch === "pickup" ? "Pickup" : "Delivery";
    return `${what} is paused for a short while${back ? ` — back ${back}` : ""}.${reason ? ` ${reason}` : ""}`;
  }
  const what = ch === "pickup" ? "الاستلام من المطعم متوقف" : "التوصيل متوقف";
  return `${what} مؤقتاً${back ? ` — نرجع ${back}` : ""}.${reason ? ` ${reason}` : ""}`;
};

function untilText(until, lang = "ar") {
  if (!until) return "";
  const t = new Date(until);
  if (!Number.isFinite(t.getTime())) return "";
  const hhmm = t.toLocaleTimeString(lang === "en" ? "en-GB" : "ar-SA", {
    hour: "2-digit", minute: "2-digit", hour12: lang !== "en", timeZone: "Asia/Riyadh",
  });
  return lang === "en" ? `at ${hhmm}` : `الساعة ${hhmm}`;
}

const chanIn = (v) => {
  const o = v && typeof v === "object" ? v : {};
  const until = o.until ? new Date(o.until) : null;
  return {
    paused: o.paused === true,
    until: until && Number.isFinite(until.getTime()) ? until.toISOString() : null,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 120) : "",
  };
};

/* serviceCfg(settings) → الشكل المخزّن، متحقَّق منه. */
export function serviceCfg(settings) {
  const raw = ((settings || {}).service) || {};
  return {
    delivery: chanIn(raw.delivery),
    pickup: chanIn(raw.pickup),
    note: typeof raw.note === "string" ? raw.note.slice(0, 200) : "",
    resumedAt: raw.resumedAt || null,
  };
}

/* serviceState(settings, now) → الحالة **الفعلية** دلوقتي.
   `until` اللي عدّى = القناة رجعت، من غير ما حد يعمل حاجة. `expired` بيقول
   للمتصل إن المخزّن بقى قديم ويستاهل تنضيف (تنضيف كسول، مش شرط).        */
export function serviceState(settings, now = new Date()) {
  const cfg = serviceCfg(settings);
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = { note: cfg.note, expired: [], anyPaused: false };
  for (const ch of CHANNELS) {
    const c = cfg[ch];
    const lapsed = Boolean(c.paused && c.until && new Date(c.until).getTime() <= t);
    const paused = Boolean(c.paused && !lapsed);
    if (lapsed) out.expired.push(ch);
    if (paused) out.anyPaused = true;
    out[ch] = { open: !paused, paused, until: paused ? c.until : null, reason: paused ? c.reason : "" };
  }
  out.allPaused = CHANNELS.every((ch) => out[ch].paused);
  return out;
}

/* الحارس اللي shop.js بيستخدمه قبل ما يفتح أي جلسة دفع. */
/* ═══ دقايق الإيقاف داخل نافذة (٢٣/٩) ══════════════════════════════════════
   عمر: «اعرف كل حاجة حصلت في الوقت دا». السؤال اللي بيسأله التقرير: التوصيل
   والاستلام كانوا واقفين كام دقيقة في المدى اللي اختاره.

   الأحداث جاية من portal_audit بترتيب تصاعدي: service_pause بيفتح فترة،
   service_resume بيقفلها، و«both» بيمسّ القناتين. حالتين لازم يتحسبوا صح:
     • أول حدث لقناة = resume ⇒ كانت واقفة من قبل بداية النافذة ⇒ من البداية.
     • آخر حدث = pause من غير resume ⇒ لسه واقفة ⇒ لحد نهاية النافذة.
   بنقصّ أي فترة على حدود النافذة عشان رقم مايزيدش عن طول النافذة نفسها.  */
export function pausedMinutesOf(events, range, hours, now = new Date()) {
  const end = range ? new Date(range[1]) : now;
  const start = range ? new Date(range[0]) : new Date(end.getTime() - hours * 3600_000);
  const s = start.getTime(), e = end.getTime();
  if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) return { delivery: 0, pickup: 0 };

  const out = { delivery: 0, pickup: 0 };
  for (const ch of CHANNELS) {
    const mine = (events || []).filter(
      (x) => x.channel === ch || x.channel === "both").map(
      (x) => ({ at: new Date(x.at).getTime(), pause: x.action === "service_pause" }))
      .filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);

    let openedAt = mine.length && !mine[0].pause ? s : null;  // كانت واقفة قبل البداية
    let total = 0;
    for (const ev of mine) {
      if (ev.pause) { if (openedAt == null) openedAt = ev.at; }
      else if (openedAt != null) {
        total += Math.max(0, Math.min(ev.at, e) - Math.max(openedAt, s));
        openedAt = null;
      }
    }
    if (openedAt != null) total += Math.max(0, e - Math.max(openedAt, s));
    out[ch] = Math.round(total / 60000);
  }
  return out;
}

export function serviceBlock(settings, option, now = new Date(), lang = "ar") {
  const ch = option === "pickup" ? "pickup" : "delivery";
  const st = serviceState(settings, now);
  if (!st[ch].paused) return null;
  const other = ch === "delivery" ? "pickup" : "delivery";
  return {
    error: "service_paused",
    channel: ch,
    until: st[ch].until,
    otherOpen: st[other].open,
    message: pausedText(ch, st[ch].until, st[ch].reason || st.note, lang),
  };
}

/* التغيير نفسه، متاح للوحة وللبوابة (كل واحدة بصلاحيتها). مفيش نسخة تانية
   من القواعد — الاتنين بينادوا على ده.                                    */
export async function applyService(ctx, b = {}) {
  const { pool, getSettingsData, jb } = ctx;
  const now = new Date();
  const s = await getSettingsData();
  const cfg = serviceCfg(s);
  const chans = b.channel === "both" ? CHANNELS : [b.channel === "pickup" ? "pickup" : "delivery"];
  const paused = b.paused === true;
  let until = null;
  if (paused) {
    if (b.until) { const d = new Date(b.until); if (Number.isFinite(d.getTime())) until = d.toISOString(); }
    else if (Number(b.minutes) > 0) until = new Date(now.getTime() + Math.min(24 * 60, Number(b.minutes)) * 60000).toISOString();
  }
  let resumedAny = false;
  for (const ch of chans) {
    if (!paused && cfg[ch].paused) resumedAny = true;
    cfg[ch] = { paused, until, reason: paused ? String(b.reason || "").slice(0, 120) : "" };
  }
  if (typeof b.note === "string") cfg.note = b.note.slice(0, 200);
  if (resumedAny) cfg.resumedAt = now.toISOString();
  await pool.query(
    `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{service}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
    [jb(cfg)]);
  return serviceState({ service: cfg }, now);
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;

  const save = async (next) => {
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{service}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
      [jb(next)]);
    return next;
  };

  /* لو وقت الرجوع عدّى بنمسح الإيقاف من التخزين كمان — عشان اللوحة تبان
     نضيفة، وعشان openwait يعرف إن فيه قناة رجعت دلوقتي. */
  async function settle(now = new Date()) {
    const s = await getSettingsData();
    const st = serviceState(s, now);
    if (!st.expired.length) return { s, st, changed: false };
    const cfg = serviceCfg(s);
    for (const ch of st.expired) cfg[ch] = { paused: false, until: null, reason: "" };
    cfg.resumedAt = new Date(now).toISOString();
    await save(cfg);
    return { s, st, changed: true, resumed: st.expired };
  }

  /* ── عام: المتجر بيقرا منها قبل ما يعرض أي حاجة ─────────────────────── */
  app.get("/api/service", async (c) => {
    const { st } = await settle();
    const lang = String(c.req.query("lang") || "ar") === "en" ? "en" : "ar";
    const body = { ok: true, note: st.note, anyPaused: st.anyPaused, allPaused: st.allPaused };
    for (const ch of CHANNELS) {
      body[ch] = { ...st[ch], text: st[ch].paused ? pausedText(ch, st[ch].until, st[ch].reason || st.note, lang) : "" };
    }
    return c.json(body);
  });

  /* ── إدارة: اللوحة والبوابة ──────────────────────────────────────────
     body: { channel:"delivery"|"pickup"|"both", paused:true|false,
             minutes?:30, until?:ISO, reason?:"" , note?:"" }            */
  const apply = (b) => applyService(ctx, b);

  /* ملاحظة: requireAdmin في المشروع ده **بيتنادى جوه** المعالِج ويرجّع
     Response أو null — مش وسيط Hono. لو اتحطّ كوسيط بيرجع «Context is not
     finalized» ٥٠٠ للتوكن الصح ويعدّي ٤٠١ للغلط، وده أسوأ شكل للعطل. */
  /* ── 📊 تقرير الإيقاف: إيه اللي حصل، ومين ضاع، ومين رجع ──────────────
     السؤال اللي عمر عايز يرد عليه في أي وقت: «قفلت الساعة كام، وكام واحد
     جه وأنا مقفول، وكام واحد سبنا رقمه، ووصلته الرسالة، ورجع طلب؟»
     المدى بالساعات (hours) أو from/to بتوقيت الرياض.                    */
  app.get("/api/service/report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const hours = Math.min(24 * 30, Math.max(1, Number(c.req.query("hours")) || 24));
    const from = c.req.query("from") || null, to = c.req.query("to") || null;
    const range = from && to ? [from, to] : null;
    const W = range
      ? { sql: "BETWEEN $1::timestamptz AND $2::timestamptz", args: range }
      : { sql: `> NOW() - INTERVAL '${hours} hours'`, args: [] };
    const q = (s, a = W.args) => pool.query(s, a).then((r) => r.rows).catch(() => []);

    const [events, visitors, wait, sms, orders, sales, pos, paused] = await Promise.all([
      /* مين قفل/فتح، إمتى، وأي قناة */
      q(`SELECT at, staff_name, role, action, order_no AS channel, detail
           FROM portal_audit WHERE action LIKE 'service\\_%' AND at ${W.sql}
          ORDER BY at DESC LIMIT 200`),
      /* الزوار في نفس المدى — دي اللي بتقول «ضاع مني كام» */
      q(`SELECT count(*)::int AS sessions,
                count(*) FILTER (WHERE cart_max > 0)::int AS reached_cart,
                count(*) FILTER (WHERE phone_norm IS NOT NULL)::int AS known,
                count(*) FILTER (WHERE paid)::int AS paid,
                COALESCE(round(sum(cart_max) FILTER (WHERE cart_max > 0))::int, 0) AS cart_value
           FROM journey_sessions WHERE started_at ${W.sql}
            AND NOT COALESCE(is_bot,false) AND NOT COALESCE(is_qa,false) AND NOT COALESCE(is_staff,false)`),
      /* اللي سابوا رقمهم */
      q(`SELECT id, created_at, phone_norm, item_count, subtotal, option, source,
                notified_at, channel, skip_reason, order_no, order_total
           FROM open_waitlist WHERE created_at ${W.sql} ORDER BY created_at DESC LIMIT 200`),
      /* الرسايل اللي اتبعتت فعلاً — من سجل الرسايل مش من نيّتنا */
      q(`SELECT at, phone_norm, status, parts, cost, error
           FROM sms_log WHERE kind='waitlist' AND at ${W.sql} ORDER BY at DESC LIMIT 200`),
      /* ورجعوا طلبوا؟ */
      q(`SELECT count(*)::int AS n, COALESCE(round(sum(order_total))::int,0) AS sar
           FROM open_waitlist WHERE order_no IS NOT NULL AND created_at ${W.sql}`),
      /* ٢٣/٩ — طلب عمر «اعرف كل حاجة حصلت في الوقت دا»: طلبات المتجر نفسها،
         مش بس اللي جم من قايمة الانتظار. ساعة الرياض عشان الجدول يتقرا. */
      q(`SELECT count(*)::int AS n,
                COALESCE(round(sum(total))::int,0) AS sar,
                count(*) FILTER (WHERE option='delivery')::int AS delivery,
                count(*) FILTER (WHERE option='pickup')::int AS pickup,
                count(*) FILTER (WHERE status IN ('pending_payment','payment_failed'))::int AS unpaid
           FROM shop_orders WHERE created_at ${W.sql}`),
      /* ونقطة البيع كلها (صالة/سفري/تطبيقات) — دي اللي بتقول إيه اللي فات */
      q(`SELECT count(*)::int AS n, COALESCE(round(sum(total))::int,0) AS sar,
                to_char(date_trunc('hour', order_date AT TIME ZONE 'Asia/Riyadh'),'HH24') AS hh
           FROM ts_orders WHERE order_date ${W.sql}
          GROUP BY 3 ORDER BY 3`),
      /* وكام دقيقة كانت الخدمة موقوفة في المدى ده */
      q(`SELECT action, at, order_no AS channel FROM portal_audit
          WHERE action LIKE 'service\_%' AND at ${W.sql} ORDER BY at ASC`),
    ]);

    const v = visitors[0] || {};
    const sent = sms.filter((r) => r.status === "sent").length;
    return c.json({
      ok: true,
      range: range ? { from: range[0], to: range[1] } : { hours },
      now: serviceState(await getSettingsData()),
      events,
      visitors: { sessions: v.sessions || 0, reachedCart: v.reached_cart || 0, known: v.known || 0, paid: v.paid || 0, cartValue: v.cart_value || 0 },
      waitlist: {
        rows: wait,
        captured: wait.length,
        waiting: wait.filter((r) => !r.notified_at && !r.skip_reason).length,
        notified: wait.filter((r) => r.notified_at).length,
        skipped: wait.filter((r) => r.skip_reason).length,
        value: wait.filter((r) => !r.notified_at && !r.skip_reason).reduce((n, r) => n + (Number(r.subtotal) || 0), 0),
      },
      sms: { rows: sms, sent, failed: sms.length - sent, cost: sms.reduce((n, r) => n + (Number(r.cost) || 0), 0) },
      returned: orders[0] || { n: 0, sar: 0 },
      /* «إيه اللي حصل» — الطلبات نفسها في نفس النافذة */
      orders: sales[0] || { n: 0, sar: 0, delivery: 0, pickup: 0, unpaid: 0 },
      pos: { rows: pos, n: pos.reduce((a, r) => a + Number(r.n || 0), 0),
             sar: pos.reduce((a, r) => a + Number(r.sar || 0), 0) },
      pausedMinutes: pausedMinutesOf(paused, range, hours),
    });
  });

  app.put("/api/service", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!["delivery", "pickup", "both"].includes(String(b.channel))) {
      return c.json({ ok: false, error: "bad_channel" }, 400);
    }
    return c.json({ ok: true, state: await apply(b) });
  });

  return { serviceState: async (now) => (await settle(now)).st, apply, settle };
}
