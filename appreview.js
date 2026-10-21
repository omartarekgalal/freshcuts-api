/* ═══════════════════════════════════════════════════════════════════════════
   🍏 دخول مراجع المتجر (Apple App Store / Google Play) — AR1 (٢١/١٠)

   المراجع بتاع أبل وجوجل لازم يدخل التطبيق برقم جوال + رمز، ومش هيستلم SMS على
   رقم سعودي. الحل: رقم واحد + رمز ثابت من ٤ أرقام في الإعدادات (settings.appReview —
   ملك السيرفر، الـPUT الكامل للإعدادات مابيلمسوش، ومتشال من GET لغير المالك).

     settings.appReview = { enabled: false, phone: "5XXXXXXXX", code: "1234",
                            updated_at, updated_by }

   القاعدة (accounts.js /api/account/otp/request):
     • enabled === true والرقم بعد التطبيع = appReview.phone بالظبط ⇒ مفيش SMS ولا واتساب
       ولا بيتحسب من سقف الساعة، والرمز المتخزّن = hashOtp(phone, appReview.code)
       بنفس طريقة الرمز الحقيقي، والرد نفس شكل الرد الحقيقي ({ok:true, sent:"sms"}).
     • أي رقم تاني = زي النهارده بالظبط. مقفول أو رقم/رمز فاضي = الميزة مش موجودة.
     • /otp/verify ماتغيّرتش: نفس حد المحاولات (٥) ونفس مدة الصلاحية.

   الرقم ده كمان (حتى لو الميزة مقفولة، طالما مكتوب):
     • برا كل التسويق (phonelists.noMarketingPhones ⇐ smsrules.staffPhoneSet: الحملات
       والأتمتة والسلات المتروكة والإرسال الآلي ورفع الجماهير للإعلانات).
     • برا إحصائيات رحلة العميل (journey.js staffPhones ⇒ is_staff).
     • مايتسألش عن تقييم (reviews.reviewSkipPhones).
     • الدخول بيه مابيعملش صف في دفتر عملاء تاب سينس.

   المسارات (requireAdmin ⇒ قسم «الإعدادات والفريق» في cms.js — المالك افتراضياً):
     GET /api/cms/app-review   { ok, appReview:{enabled, phone, code, updated_at, updated_by}, active }
     PUT /api/cms/app-review   { enabled?, phone?, code? } — الرمز ٤ أرقام بالظبط، الجوال سعودي 05XXXXXXXX
═══════════════════════════════════════════════════════════════════════════ */

export const APP_REVIEW_KEY = "appReview";
export const CODE_RE = /^\d{4}$/;

/* نفس تطبيع index.js normPhone + نفس فحص accounts.js (/^5\d{8}$/) — عشان الرقم
   المتخزّن يطابق بالظبط اللي /otp/request بيحسبه. */
export function normReviewPhone(p) {
  const d = String(p == null ? "" : p).replace(/\D/g, "");
  let n = d;
  if (d.startsWith("00966")) n = d.slice(5);
  else if (d.startsWith("966")) n = d.slice(3);
  else if (d.startsWith("0") && d.length === 10) n = d.slice(1);
  return /^5\d{8}$/.test(n) ? n : null;
}

/* settings ⇒ شكل ثابت. أي قيمة بايظة في الداتابيز ⇒ فاضية (الميزة مقفولة). */
export function configOf(settings) {
  const x = settings && typeof settings === "object" && settings[APP_REVIEW_KEY] && typeof settings[APP_REVIEW_KEY] === "object"
    ? settings[APP_REVIEW_KEY] : {};
  const phone = normReviewPhone(x.phone) || "";
  const code = CODE_RE.test(String(x.code == null ? "" : x.code)) ? String(x.code) : "";
  return {
    enabled: x.enabled === true,
    phone, code,
    updated_at: typeof x.updated_at === "string" ? x.updated_at : null,
    updated_by: typeof x.updated_by === "string" ? x.updated_by : null,
  };
}

/* شغّالة فعلاً؟ لازم الثلاثة: مفعّل + رقم صحيح + رمز ٤ أرقام */
export const isActive = (cfg) => Boolean(cfg && cfg.enabled === true && cfg.phone && cfg.code);

/* الرمز الثابت لو الرقم ده هو رقم المراجع والميزة شغّالة — غير كده null. */
export function reviewCodeFor(settings, phoneNorm) {
  const cfg = configOf(settings);
  if (!isActive(cfg)) return null;
  return String(phoneNorm || "") === cfg.phone ? cfg.code : null;
}

/* الرقم نفسه (لو مكتوب وصحيح) — للاستبعاد من التسويق والإحصائيات حتى بعد القفل. */
export function reviewPhoneOf(settings) {
  return configOf(settings).phone || null;
}

/* PUT ⇒ { ok, next } أو { ok:false, error, message }. القيم المش مبعوتة بتفضل زي ما هي. */
export function applyUpdate(cur, body, { who = "المالك", now = new Date() } = {}) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  const bad = (error, message) => ({ ok: false, error, message });
  if (!b) return bad("bad_body", "الطلب لازم يبقى كائن");
  const prev = configOf({ [APP_REVIEW_KEY]: cur });
  const next = { enabled: prev.enabled, phone: prev.phone, code: prev.code };
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return bad("bad_enabled", "enabled: لازم true أو false");
    next.enabled = b.enabled;
  }
  if ("phone" in b) {
    const raw = String(b.phone == null ? "" : b.phone).trim();
    if (!raw) next.phone = "";
    else {
      const pn = normReviewPhone(raw);
      if (!pn) return bad("bad_phone", "اكتب جوال سعودي صحيح 05XXXXXXXX");
      next.phone = pn;
    }
  }
  if ("code" in b) {
    const raw = String(b.code == null ? "" : b.code).trim();
    if (!raw) next.code = "";
    else if (!CODE_RE.test(raw)) return bad("bad_code", "الرمز لازم ٤ أرقام بالظبط (زي رمز الـSMS)");
    else next.code = raw;
  }
  if (next.enabled && (!next.phone || !next.code)) {
    return bad("incomplete", "عشان تفعّله لازم رقم الجوال والرمز الاتنين");
  }
  return {
    ok: true,
    next: { ...next, updated_at: new Date(now).toISOString(), updated_by: String(who || "المالك").slice(0, 60) },
    prev,
  };
}

const maskPhone = (pn) => (pn ? `05${String(pn).slice(1, 2)}•••${String(pn).slice(-2)}` : "—");

/* سطر السجل — من غير الرمز أبداً */
export function auditLine(prev, next) {
  const parts = [];
  if (prev.enabled !== next.enabled) parts.push(next.enabled ? "اتفعّل" : "اتقفل");
  if (prev.phone !== next.phone) parts.push(`الرقم ${maskPhone(prev.phone)} ← ${maskPhone(next.phone)}`);
  if (prev.code !== next.code) parts.push(next.code ? "الرمز اتغيّر" : "الرمز اتمسح");
  return `🍏 دخول مراجع المتجر: ${parts.length ? parts.join(" · ") : "مفيش تغيير"}`;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, auditNote } = ctx;
  const note = (c, s) => (typeof auditNote === "function" ? auditNote(c, s).catch(() => {}) : Promise.resolve());
  const actor = async (c) => {
    try { const u = deps.whoami ? await deps.whoami(c) : null; return String((u && (u.name || u.username)) || "المالك").slice(0, 60); } catch { return "المالك"; }
  };
  const view = (cfg) => ({ enabled: cfg.enabled, phone: cfg.phone ? `0${cfg.phone}` : "", code: cfg.code, updated_at: cfg.updated_at, updated_by: cfg.updated_by });

  app.get("/api/cms/app-review", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = configOf(await getSettingsData());
    return c.json({ ok: true, appReview: view(cfg), active: isActive(cfg) });
  });

  app.put("/api/cms/app-review", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const who = await actor(c);
    const client = await pool.connect();
    let res;
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT data FROM settings WHERE id=1 FOR UPDATE");
      const cur = (r.rows[0] && r.rows[0].data && r.rows[0].data[APP_REVIEW_KEY]) || {};
      res = applyUpdate(cur, b, { who });
      if (!res.ok) { await client.query("ROLLBACK"); return c.json(res, 400); }
      await client.query(
        `UPDATE settings SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{${APP_REVIEW_KEY}}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
        [JSON.stringify(res.next)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[appreview] save failed:", e.message);
      return c.json({ ok: false, error: "save_failed" }, 500);
    } finally { client.release(); }
    const cfg = configOf({ [APP_REVIEW_KEY]: res.next });
    await note(c, auditLine(res.prev, cfg));
    return c.json({ ok: true, appReview: view(cfg), active: isActive(cfg) });
  });

  return { configOf, reviewCodeFor, reviewPhoneOf };
}
