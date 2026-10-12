/* ═══════════════════════════════════════════════════════════════════════════
   مكتبة عروض واتساب (waoffers.js) — OF1، ١٣/١٠/٢٠٢٦

   عمر: «عايز طريقة اضيفها واعمل حملات اعلانية منها في قسم داخل الواتس اب» و«شوفلي طريقة سهلة عشان نبعت رسايل
   واتساب باستمرار… متخطيين موضوع القوالب… ولو ينفع يكون جزء العرض ديناميك».

   الفكرة: ميتا مابتسمحش برسالة تسويقية من غير قالب معتمد، بس القالب ممكن يبقى «إطار»: كلام ثابت قليل حوالين
   متغيرات (اسم العرض، تفاصيله، السعر، آخر يوم) + صورة/فيديو بيتغيروا مع كل إرسال + زر رابط متتبَّع. الإطار بيتعتمد
   مرة واحدة، وبعدها كل عرض جديد = قيم جديدة من غير اعتماد جديد. الإطارات الأربعة في watemplates.js (fc_frame_*).

   • مفيش جدول عروض تاني: العرض هنا = «طبقة واتساب» فوق مصدر موجود (بوكس/باقة cms_bundles، عرض offer_registry)
     أو عرض مكتوب بالإيد. متخزّن في settings.waOffers.items (عشرات، مش آلاف). السعر والاسم بيتاخدوا من المصدر
     وقت الاختيار في اللوحة، وsource بيفضل محفوظ عشان اللوحة تقارن وتقول لو السعر اتغيّر.
   • الملف ده مابيبعتش ولا بيكلّم ميتا: بيحفظ العرض وبيقول أنهي إطار يناسبه وقيم خاناته. الحملة نفسها من شاشة
     الحملات (wasender.js) بكل أقفالها وسقوفها.
   • المسارات تحت ‎/api/cms/wa-sender/offers‎ عشان تاخد قسم «العملاء» من cms.js من غير سطر جديد هناك.
═══════════════════════════════════════════════════════════════════════════ */
export const FRAMES = Object.freeze({ offerImg: "fc_frame_offer_img", video: "fc_frame_video", limitedImg: "fc_frame_limited_img", newsText: "fc_frame_news_text" });
export const LIMITS = Object.freeze({ title: 60, details: 200, until: 30, items: 200 });
const TARGETS = ["home", "collection", "product", "offer", "cart", "box", "gather"];
const SOURCES = ["custom", "bundle", "offer"];
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/* رابط وسائط من مخزننا بس (نفس قاعدة الحملات) */
export function mediaUrlOk(url, hosts = []) {
  try { const u = new URL(String(url)); return u.protocol === "https:" && hosts.includes(u.hostname.toLowerCase()); } catch { return false; }
}
/* متغير القالب عند ميتا: سطر واحد، من غير ٤ مسافات ورا بعض، ومش فاضي */
export const paramOk = (v) => { const s = String(v ?? ""); return s.trim().length > 0 && !/[\n\r\t]/.test(s) && !/ {4,}/.test(s); };

/* تنضيف وفحص عرض جاي من اللوحة ⇒ { ok, offer } أو { ok:false, errors[[code, message]…] } */
export function cleanOffer(b = {}, { hosts = [], now = new Date() } = {}) {
  const errs = [];
  const title = clip(b.title, LIMITS.title + 1), details = clip(b.details, LIMITS.details + 1);
  if (!title) errs.push(["title_required", "اكتب اسم العرض"]);
  if (title.length > LIMITS.title) errs.push(["title_long", `اسم العرض لحد ${LIMITS.title} حرف`]);
  if (!details) errs.push(["details_required", "اكتب تفاصيل العرض (اللي فيه)"]);
  if (details.length > LIMITS.details) errs.push(["details_long", `التفاصيل لحد ${LIMITS.details} حرف`]);
  const pr = b.price === "" || b.price == null ? null : Number(b.price);
  if (pr != null && !(Number.isFinite(pr) && pr > 0 && pr < 100000)) errs.push(["bad_price", "السعر: رقم أكبر من صفر"]);
  const price = pr != null && Number.isFinite(pr) && pr > 0 ? Math.round(pr * 100) / 100 : null;
  let untilDate = null;
  if (b.untilDate) {
    const d = String(b.untilDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`))) errs.push(["bad_until", "آخر يوم: تاريخ صحيح"]);
    else { untilDate = d; if (Date.parse(`${d}T23:59:59+03:00`) < now.getTime()) errs.push(["until_past", "آخر يوم العرض عدّى — غيّر التاريخ أو شيله"]); }
  }
  const untilText = clip(b.untilText, LIMITS.until);
  const M = b.media && typeof b.media === "object" ? b.media : {};
  let media = null;
  if (M.url) {
    const kind = M.kind === "video" ? "video" : "image";
    if (!mediaUrlOk(M.url, hosts)) errs.push(["bad_media", "الصورة/الفيديو لازم يترفعوا على مخزن الوسائط بتاعنا الأول"]);
    else media = { kind, url: String(M.url) };
  }
  const L = b.link && typeof b.link === "object" ? b.link : {};
  const target_type = TARGETS.includes(L.target_type) ? L.target_type : "home";
  const target_id = ["home", "gather"].includes(target_type) ? null : clip(L.target_id, 64) || null;
  if (!["home", "gather"].includes(target_type) && !target_id) errs.push(["target_missing", "اختار الرابط يفتح إيه (بوكس / صنف / قسم)"]);
  const coupon = clip(b.coupon, 40).toUpperCase() || null;
  if (coupon && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(coupon)) errs.push(["bad_coupon", "كود الكوبون: حروف إنجليزي وأرقام"]);
  const S = b.source && typeof b.source === "object" ? b.source : {};
  const sType = SOURCES.includes(S.type) ? S.type : "custom";
  const source = sType === "custom" ? { type: "custom" } : { type: sType, id: clip(S.id, 64), ...(S.price != null && Number.isFinite(Number(S.price)) ? { price: Number(S.price) } : {}) };
  if (sType !== "custom" && !source.id) errs.push(["source_missing", "المصدر ناقص"]);
  const id = slugify(b.id) || `${slugify(sType === "custom" ? "o" : source.id) || "o"}-${now.getTime().toString(36)}`;
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, offer: { id, title, details, price, untilDate, untilText: untilText || null, media, link: { target_type, target_id }, coupon, source, archived: b.archived === true } };
}

const AR_DAY = (d) => new Date(`${d}T12:00:00+03:00`).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Riyadh" });
export const untilTextOf = (o) => (o.untilText ? o.untilText : o.untilDate ? AR_DAY(o.untilDate) : "");
const money = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/* أنهي إطار يناسب العرض، وقيم خاناته. مابتتأكدش من حالة الاعتماد عند ميتا — دي من شاشة القوالب.
   صورة + سعر ⇒ إطار الصورة (وبآخر يوم لو فيه). فيديو ⇒ إطار الفيديو. غير كده ⇒ الإطار النصي.
   إطار الفيديو والنصي مافيهمش خانة سعر ولا آخر يوم: بيتكتبوا في آخر سطر التفاصيل لوحدهم (مفيش معلومة بتضيع). */
export function frameFor(o) {
  const warnings = [];
  const until = untilTextOf(o);
  const kind = o.media ? o.media.kind : null;
  let frame;
  if (kind === "video") frame = FRAMES.video;
  else if (o.price != null && kind === "image") frame = until ? FRAMES.limitedImg : FRAMES.offerImg;
  else frame = FRAMES.newsText;
  if (frame === FRAMES.newsText && kind === "image") warnings.push("من غير سعر العرض بيتبعت بالإطار النصي — الصورة مش هتتبعت. اكتب السعر عشان يتبعت بالصورة");
  const inLine = frame === FRAMES.video || frame === FRAMES.newsText;
  const extra = inLine ? [o.price != null ? `السعر ${money(o.price)} ر.س` : "", until ? `العرض لين ${until}` : ""].filter(Boolean).join("، ") : "";
  const fields = { "offer.title": o.title, "offer.line": extra ? `${o.details} — ${extra}` : o.details };
  if (!inLine) fields["offer.price"] = money(o.price);
  if (frame === FRAMES.limitedImg) fields["offer.untilText"] = until;
  const bad = Object.entries(fields).filter(([, v]) => !paramOk(v)).map(([k]) => k);
  return { frame, header: frame === FRAMES.video ? "video" : frame === FRAMES.newsText ? null : "image", fields, warnings, bad };
}
/* اللي شاشة الحملات محتاجاه عشان تتملى لوحدها من العرض */
export function campaignDraft(o) {
  const f = frameFor(o);
  return { cloudTemplate: f.frame, values: f.fields, imageUrl: f.header === "image" ? o.media.url : null, videoUrl: f.header === "video" ? o.media.url : null,
    link: { target_type: o.link.target_type, target_id: o.link.target_id, coupon: o.coupon || null }, name: o.title };
}
export const itemsOf = (settings) => { const l = settings && settings.waOffers && Array.isArray(settings.waOffers.items) ? settings.waOffers.items : []; return l.filter((x) => x && typeof x === "object" && x.id && x.title); };

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = deps.log || console;
  const hosts = () => (typeof deps.hosts === "function" ? deps.hosts() : deps.hosts || []);
  const actor = async (c) => { try { return (await deps.actor?.(c)) || null; } catch { return null; } };
  const out = (o) => { const f = frameFor(o); return { ...o, untilShown: untilTextOf(o) || null, frame: f.frame, header: f.header, fields: f.fields, warnings: f.warnings, draft: campaignDraft(o) }; };
  const save = (items) => pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waOffers}', $1::jsonb, true) WHERE id=1`, [JSON.stringify({ items })]);

  app.get("/api/cms/wa-sender/offers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const items = itemsOf(await getSettingsData().catch(() => ({})));
    return c.json({ ok: true, offers: items.map(out), frames: Object.values(FRAMES), limits: LIMITS, mediaHosts: hosts() });
  });
  app.post("/api/cms/wa-sender/offers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const r = cleanOffer(b, { hosts: hosts() });
    if (!r.ok) return c.json({ ok: false, error: r.errors[0][0], message: r.errors[0][1], errors: r.errors.map(([error, message]) => ({ error, message })) }, 400);
    try {
      const items = itemsOf(await getSettingsData());
      const i = items.findIndex((x) => x.id === r.offer.id);
      const at = new Date().toISOString(), by = await actor(c);
      const row = { ...(i >= 0 ? { createdAt: items[i].createdAt, createdBy: items[i].createdBy } : { createdAt: at, createdBy: by }), ...r.offer, updatedAt: at, updatedBy: by };
      if (i >= 0) items[i] = row; else { if (items.filter((x) => !x.archived).length >= LIMITS.items) return c.json({ ok: false, error: "too_many", message: `المكتبة فيها ${LIMITS.items} عرض — أرشف القديم الأول` }, 400); items.unshift(row); }
      await save(items);
      return c.json({ ok: true, offer: out(row), created: i < 0 });
    } catch (e) { log.error("[wa-offers] save:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  app.post("/api/cms/wa-sender/offers/:id/archive", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    try {
      const items = itemsOf(await getSettingsData());
      const row = items.find((x) => x.id === c.req.param("id"));
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      row.archived = b.archived !== false; row.updatedAt = new Date().toISOString(); row.updatedBy = await actor(c);
      await save(items);
      return c.json({ ok: true, offer: out(row) });
    } catch (e) { log.error("[wa-offers] archive:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
  });
  return { itemsOf, frameFor };
}
