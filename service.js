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
  const apply = async (b) => {
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
    await save(cfg);
    return serviceState({ service: cfg }, now);
  };

  app.put("/api/service", requireAdmin, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!["delivery", "pickup", "both"].includes(String(b.channel))) {
      return c.json({ ok: false, error: "bad_channel" }, 400);
    }
    return c.json({ ok: true, state: await apply(b) });
  });

  return { serviceState: async (now) => (await settle(now)).st, apply, settle };
}
