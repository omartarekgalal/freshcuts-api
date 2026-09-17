/* ═══════════════════════════════════════════════════════════════════════════
   SOCIALPUB — نشر كل أنواع المحتوى على انستجرام وفيسبوك + حراس الكلام والتاريخ.

   ── ليه الملف ده موجود (١٧ سبتمبر ٢٠٢٦) ─────────────────────────────────
   عمر وافق على تقويم ٩٦ كامل («انشر انت كل حاجة حتى الستوري»). الناشر القديم
   في content.js كان بيعرف صورة واحدة على انستجرام بس، والتقويم فيه كاروسيل
   وريلز وستوري على المنصتين. وكمان حارس التاريخ منع بوست إطلاق البوكس يوم
   ١٤/٩ بالغلط («بيتزا + باستا + كريب» = اسم عرض الـ٧٠ الموقوف)، والطابور
   كله اتلغى بدل ما الحارس يتصلّح.

   الملف ده **منطق بس** (من غير داتابيز): كل نداء على ميتا بيعدّي من `http`
   اللي بيتبعت له، فالاختبارات بتشغّله على ميتا مزيّفة.

   ── قواعد النشر ─────────────────────────────────────────────────────────
   • انستجرام مالوش جدولة API — العامل بتاعنا بينشر في الميعاد.
   • فيسبوك كمان بننشره إحنا في الميعاد (مش جدولة ميتا): بوست متجدول عند
     ميتا ماينفعش يتعدّل كابشنه من الـAPI، ومايعدّيش على حراسنا وقت النشر.
   • أي خطوة **قبل** أمر النشر النهائي = آمن نعيدها (retry). لو أمر النشر
     نفسه ضاع في الشبكة (status 0) مانعرفش هل نزل ولا لأ → «uncertain»:
     مابنعيدش (عشان مايتنشرش مرتين) وبننبّه بني آدم يبص.
═══════════════════════════════════════════════════════════════════════════ */

import { SAVINGS_RE } from "./offers.js";

export const MEDIA_TYPES = ["IMAGE", "CAROUSEL", "REELS", "STORIES", "VIDEO"];

export const isVideoUrl = (u) => /\.(mp4|mov|m4v)(\?|#|$)/i.test(String(u || ""));

/* ── نداء HTTP من غير إعادة تلقائية ────────────────────────────────────────
   httpJson بتاع ads.js بيعيد أي 5xx مرة — وده خطر على أمر نشر (بوستين). */
export async function plainHttp(url, { method = "GET", headers = {}, body, timeout = 60_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text: json ? undefined : String(text).slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? `timeout after ${timeout}ms` : String(e?.message || e) };
  } finally { clearTimeout(t); }
}

export const graphErr = (r) =>
  r?.json?.error?.error_user_msg || r?.json?.error?.message || r?.error || `HTTP ${r?.status}`;

const form = (obj) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") f.set(k, String(v));
  return f.toString();
};
const FORM_H = { "Content-Type": "application/x-www-form-urlencoded" };

class PubError extends Error {
  constructor(msg, { retry = false, uncertain = false, state } = {}) {
    super(msg); this.retry = retry; this.uncertain = uncertain; this.state = state;
  }
}
/* فشل عادي من ميتا (رد واضح) قبل النشر = نعيد. انقطاع شبكة = نعيد. */
const fail = (step, r, extra = {}) => new PubError(`${step}: ${graphErr(r)}`, { retry: true, ...extra });

/* ══ انستجرام ═══════════════════════════════════════════════════════════ */

async function igWait({ http, graph, token, id, sleep, tries, everyMs }) {
  let code = "";
  for (let i = 0; i < tries; i++) {
    const st = await http(`${graph}/${id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    code = st.json?.status_code || "";
    if (code === "FINISHED" || code === "PUBLISHED") return code;
    if (code === "ERROR" || code === "EXPIRED") {
      // خطأ في الملف نفسه (مقاس/كوديك) — الإعادة مش هتفرق
      throw new PubError(`ميتا رفضت الملف: ${st.json?.status || code}`, { retry: false });
    }
    await sleep(everyMs);
  }
  return code || "UNKNOWN";
}

/* بيرجّع { externalId, permalink, publishedAt } أو بيرمي PubError.
   `state` = اللي اتعمل في محاولة قبل كده (containerId) عشان الفيديو اللي
   لسه بيتجهّز مايتعملّوش حاوية جديدة كل دورة. */
export async function publishInstagram({
  http = plainHttp, graph, igUserId, token, type = "IMAGE", urls = [], caption = "",
  options = {}, state = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollTries, pollMs = 5000,
}) {
  if (!token) throw new PubError("مفيش توكن صفحة", { retry: true });
  const list = (Array.isArray(urls) ? urls : [urls]).map(String).filter(Boolean);
  if (!list.length) throw new PubError("البوست من غير ميديا", { retry: false });
  for (const u of list) if (!/^https:\/\//i.test(u)) throw new PubError(`الرابط مش https: ${u}`, { retry: false });
  const T = String(type || "IMAGE").toUpperCase();
  const hasVideo = list.some(isVideoUrl);
  const tries = pollTries ?? (hasVideo ? 36 : 12);  // فيديو: ٣ دقايق · صورة: دقيقة
  const createUrl = `${graph}/${igUserId}/media`;
  const create = async (params, step) => {
    const r = await http(createUrl, { method: "POST", headers: FORM_H, body: form({ ...params, access_token: token }) });
    if (!r.json?.id) throw fail(step, r);
    return String(r.json.id);
  };

  let containerId = state?.containerId || "";
  if (!containerId) {
    if (T === "IMAGE") {
      if (isVideoUrl(list[0])) throw new PubError("IMAGE بفيديو — استخدم REELS", { retry: false });
      containerId = await create({ image_url: list[0], caption }, "حاوية الصورة");
    } else if (T === "STORIES") {
      containerId = await create(isVideoUrl(list[0])
        ? { media_type: "STORIES", video_url: list[0] }
        : { media_type: "STORIES", image_url: list[0] }, "حاوية الستوري");
    } else if (T === "REELS" || T === "VIDEO") {
      if (!isVideoUrl(list[0])) throw new PubError("الريل محتاج رابط فيديو mp4", { retry: false });
      containerId = await create({
        media_type: "REELS", video_url: list[0], caption,
        share_to_feed: options.shareToFeed === false ? "false" : "true",
        cover_url: options.coverUrl || undefined,
        thumb_offset: options.thumbOffsetMs ?? undefined,
      }, "حاوية الريل");
    } else if (T === "CAROUSEL") {
      if (list.length < 2 || list.length > 10) throw new PubError(`الكاروسيل من ٢ لـ١٠ (${list.length})`, { retry: false });
      const children = [];
      for (const u of list) {
        children.push(await create(isVideoUrl(u)
          ? { media_type: "VIDEO", video_url: u, is_carousel_item: "true" }
          : { image_url: u, is_carousel_item: "true" }, "شريحة كاروسيل"));
      }
      for (const ch of children) {
        const code = await igWait({ http, graph, token, id: ch, sleep, tries, everyMs: pollMs });
        if (code !== "FINISHED") throw new PubError(`شريحة لسه بتتجهّز (${code})`, { retry: true });
      }
      containerId = await create({ media_type: "CAROUSEL", children: children.join(","), caption }, "حاوية الكاروسيل");
    } else {
      throw new PubError(`نوع مش مدعوم: ${T}`, { retry: false });
    }
  }

  const code = await igWait({ http, graph, token, id: containerId, sleep, tries, everyMs: pollMs });
  if (code !== "FINISHED") {
    throw new PubError(`الميديا لسه بتتجهّز عند ميتا (${code})`, { retry: true, state: { containerId } });
  }

  const pub = await http(`${graph}/${igUserId}/media_publish`, {
    method: "POST", headers: FORM_H, body: form({ creation_id: containerId, access_token: token }),
  });
  if (!pub.json?.id) {
    if (pub.status === 0) throw new PubError(`أمر النشر ضاع في الشبكة: ${graphErr(pub)}`, { uncertain: true });
    throw fail("media_publish", pub, { state: { containerId } });
  }
  const mediaId = String(pub.json.id);
  const pl = await http(`${graph}/${mediaId}?fields=permalink,timestamp&access_token=${encodeURIComponent(token)}`);
  return { externalId: mediaId, permalink: pl.json?.permalink || "", publishedAt: pl.json?.timestamp || new Date().toISOString() };
}

/* ══ فيسبوك ═════════════════════════════════════════════════════════════ */

async function fbUploadVideo({ http, graph, pageId, token, url, edge }) {
  const start = await http(`${graph}/${pageId}/${edge}`, {
    method: "POST", headers: FORM_H, body: form({ upload_phase: "start", access_token: token }),
  });
  const videoId = start.json?.video_id;
  const uploadUrl = start.json?.upload_url;
  if (!videoId || !uploadUrl) throw fail(`${edge} start`, start);
  const up = await http(uploadUrl, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_url: url } });
  if (!up.ok || up.json?.success === false) throw fail(`${edge} upload`, up);
  return String(videoId);
}

async function fbPermalink({ http, graph, token, id }) {
  const r = await http(`${graph}/${id}?fields=permalink_url&access_token=${encodeURIComponent(token)}`);
  const p = r.json?.permalink_url || "";
  return p && !/^https?:/i.test(p) ? `https://www.facebook.com${p}` : p;
}

export async function publishFacebook({
  http = plainHttp, graph, pageId, token, type = "IMAGE", urls = [], caption = "", options = {},
}) {
  if (!token) throw new PubError("مفيش توكن صفحة", { retry: true });
  const list = (Array.isArray(urls) ? urls : [urls]).map(String).filter(Boolean);
  if (!list.length) throw new PubError("البوست من غير ميديا", { retry: false });
  const T = String(type || "IMAGE").toUpperCase();
  const post = async (edge, params, step) => {
    const r = await http(`${graph}/${pageId}/${edge}`, { method: "POST", headers: FORM_H, body: form({ ...params, access_token: token }) });
    if (!r.ok || r.json?.error || r.json?.success === false) {
      if (r.status === 0) throw new PubError(`${step} ضاع في الشبكة: ${graphErr(r)}`, { uncertain: true });
      throw fail(step, r);
    }
    return r.json || {};
  };
  const unpublishedPhoto = async (u) => {
    const r = await http(`${graph}/${pageId}/photos`, {
      method: "POST", headers: FORM_H, body: form({ url: u, published: "false", access_token: token }),
    });
    if (!r.json?.id) throw fail("رفع صورة", r);
    return String(r.json.id);
  };

  if (T === "IMAGE") {
    if (isVideoUrl(list[0])) throw new PubError("IMAGE بفيديو — استخدم REELS/VIDEO", { retry: false });
    const j = await post("photos", { url: list[0], message: caption, published: "true" }, "نشر الصورة");
    const id = String(j.post_id || j.id);
    return { externalId: id, permalink: await fbPermalink({ http, graph, token, id }), publishedAt: new Date().toISOString() };
  }
  if (T === "CAROUSEL") {
    const ids = [];
    for (const u of list) ids.push(await unpublishedPhoto(u));
    const params = { message: caption };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const j = await post("feed", params, "نشر الألبوم");
    const id = String(j.id);
    return { externalId: id, permalink: await fbPermalink({ http, graph, token, id }), publishedAt: new Date().toISOString() };
  }
  if (T === "REELS") {
    const videoId = await fbUploadVideo({ http, graph, pageId, token, url: list[0], edge: "video_reels" });
    const j = await post("video_reels", {
      upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: caption,
    }, "نشر الريل");
    const id = String(j.post_id || videoId);
    return { externalId: id, videoId, permalink: `https://www.facebook.com/reel/${videoId}`, publishedAt: new Date().toISOString() };
  }
  if (T === "VIDEO") {
    const j = await post("videos", { file_url: list[0], description: caption }, "نشر الفيديو");
    const id = String(j.id);
    return { externalId: id, permalink: `https://www.facebook.com/${pageId}/videos/${id}`, publishedAt: new Date().toISOString() };
  }
  if (T === "STORIES") {
    if (isVideoUrl(list[0])) {
      const videoId = await fbUploadVideo({ http, graph, pageId, token, url: list[0], edge: "video_stories" });
      const j = await post("video_stories", { upload_phase: "finish", video_id: videoId }, "نشر ستوري فيديو");
      const id = String(j.post_id || videoId);
      return { externalId: id, permalink: await fbPermalink({ http, graph, token, id }).catch(() => ""), publishedAt: new Date().toISOString() };
    }
    const photoId = await unpublishedPhoto(list[0]);
    const j = await post("photo_stories", { photo_id: photoId }, "نشر ستوري صورة");
    const id = String(j.post_id || photoId);
    return { externalId: id, permalink: await fbPermalink({ http, graph, token, id }).catch(() => ""), publishedAt: new Date().toISOString() };
  }
  throw new PubError(`نوع مش مدعوم على فيسبوك: ${T}`, { retry: false });
}

/* ══ الإعادة ════════════════════════════════════════════════════════════
   ٣ محاولات: بعد ١٠ دقايق ثم ٢٠. بعدها فشل نهائي + تنبيه. */
export function retryPlan({ attempts, maxAttempts = 3, retryable, uncertain, now = Date.now() }) {
  const n = (Number(attempts) || 0) + 1;
  if (uncertain || !retryable || n >= maxAttempts) return { final: true, attempts: n };
  return { final: false, attempts: n, nextAttemptAt: new Date(now + 10 * 60_000 * n).toISOString() };
}

/* ══ الحراس ═════════════════════════════════════════════════════════════ */

export const normDish = (s) => String(s || "")
  .replace(/[ً-ْـ]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي")
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

export const coreName = (title) => String(title || "")
  .split(/[—·|]/)[0]
  .replace(/[\d٠-٩].*$/u, "")
  .replace(/\s+/g, " ")
  .trim();

const offerNeedles = (o) => [...new Set([o.title, o.catalogTitle].filter(Boolean)
  .map((t) => normDish(coreName(t))).filter((t) => t.length >= 6))];

/* عرض بالرقم («كيلو ٩٦» / «بوكس ٩٦») من غير الاسم الكامل. */
function numberedOffers(hayNorm, offers) {
  return offers.filter((o) => {
    if (!o.price) return false;
    const p = String(o.price);
    const word = /kilo/.test(o.id) ? "كيلو" : /box/.test(o.id) ? "بوكس" : "";
    return word && new RegExp(`${word}\\s+${p}(\\s|$)`).test(hayNorm);
  });
}

/* حارس التاريخ والسعر.
   بيمنع بس:
     ١) بوست ميعاده بعد نهاية عرض بيعلنه (أو العرض موقوف).
     ٢) بوست بيكتب «N ريال» وN مش سعر أي عرض شغّال يومها.
   مابيمنعش كلام اسمه جزء من وصف عرض **شغّال يومها** — حتى لو العرض الشغّال
   مش مذكور بالاسم (ده اللي منع بوست البوكس ١٤/٩). */
export function offerGuard({ text = "", day, channel = "", origin = "", tags = [] }, offers) {
  const hay = normDish(text);
  const isLate = (o) => o.enabled === false || (o.until && day > o.until) || (o.from && day < o.from);
  const blockable = channel === "instagram" || origin === "queue";
  const byName = offers.filter((o) => offerNeedles(o).some((n) => hay.includes(n)));
  const byNum = numberedOffers(hay, offers);
  const byTag = offers.filter((o) => (tags || []).includes(o.id));
  const named = [...new Set([...byName, ...byNum, ...byTag])];

  const priceIssues = [];
  const liveOnDay = offers.filter((o) => !isLate(o));
  for (const m of hay.matchAll(/(\d+)\s*(ريال|ر س|sar)/g)) {
    const n = Number(m[1]);
    if (!liveOnDay.some((o) => Number(o.price) === n)) priceIssues.push(n);
  }
  if (!named.length && !priceIssues.length) return { verdict: "no-offer", block: false, offers: [] };
  if (!day) return { verdict: "undated", block: false, offers: named.map((o) => o.id) };

  const liveText = liveOnDay.map((o) => normDish(`${o.title || ""} ${o.catalogTitle || ""} ${o.desc || ""}`));
  const late = named.filter(isLate).filter((o) => {
    if (byTag.includes(o) || byNum.includes(o)) return true;       // صريح = مفيش تفسير تاني
    return offerNeedles(o).filter((n) => hay.includes(n)).some((n) => !liveText.some((t) => t.includes(n)));
  });
  if (!late.length && !priceIssues.length) return { verdict: "pass", block: false, offers: named.map((o) => o.id), day };
  const reasons = [
    ...late.map((o) => `البوست ميعاده ${day} وبيعلن «${o.title}» (${o.enabled === false ? "موقوف" : `من ${o.from || "?"} لـ${o.until}`})`),
    ...priceIssues.map((n) => `مكتوب ${n} ريال ومفيش عرض شغّال يوم ${day} بالسعر ده`),
  ];
  return {
    verdict: late.length ? "expired" : "price", block: blockable,
    offers: (late.length ? late : named).map((o) => o.id), day, reason: reasons.join(" · "),
  };
}

/* الكلام الممنوع في التقويم المعتمد (§٣-أ): مايخرجش للناس أبداً. */
const BANNED = [
  [/فقط/, "«فقط»"], [/حصري/, "«حصرياً»"], [/ستيك/, "«ستيك»"], [/سا?ندو?تش/, "«سندوتش»"],
  [/\bFIRST\b/i, "كود FIRST"], [/#فريش_كتس/, "#فريش_كتس (الصح #فريش_كاتس)"],
  [/#اليوم_الوطني_السعودي_96/, "#اليوم_الوطني_السعودي_96"], [/🇸🇦/u, "علم 🇸🇦"],
  [/بيتزا\s*\+\s*باستا/, "«+» بين أصناف البوكس (بـ«و»)"], [/فريش كتس/, "«فريش كتس» (الصح فريش كاتس)"],
];
export function copyIssues(text) {
  const t = String(text || "");
  const out = [];
  if (SAVINGS_RE.test(t)) out.push("كلام توفير/خصم/٪");
  for (const [re, label] of BANNED) if (re.test(t)) out.push(label);
  return out;
}

/* ══ تنبيه SMS ═════════════════════════════════════════════════════════
   إنجليزي، رسالة واحدة (≤١٦٠ GSM-7). أي عربي في سبب الفشل بيتشال. */
export function asciiOnly(s) {
  return String(s || "").replace(/[^\x20-\x7E]/g, " ").replace(/[|^{}\[\]~\\]/g, " ").replace(/\s+/g, " ").trim();
}
export function failAlertText(row, error) {
  const when = row.scheduled_at ? new Date(row.scheduled_at).toLocaleString("en-GB", {
    timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(",", "") : "";
  const plat = row.channel === "instagram" ? "IG" : row.channel === "facebook" ? "FB" : String(row.channel || "");
  const head = `FreshCuts social: ${plat} ${row.media_type || "IMAGE"} ${when} FAILED.`;
  const why = asciiOnly(error).slice(0, 70);
  return `${head} ${why ? why + ". " : ""}Check #marketing queue.`.slice(0, 160);
}
export function healthAlertText({ failed = 0, overdue = 0, foreign = 0, tokenBad = false }) {
  const parts = [];
  if (tokenBad) parts.push("Meta token FAILED");
  if (failed) parts.push(`${failed} failed`);
  if (overdue) parts.push(`${overdue} overdue`);
  if (foreign) parts.push(`${foreign} old FB scheduled posts publish soon`);
  return `FreshCuts social daily check: ${parts.join(", ")}. Check #marketing queue.`.slice(0, 160);
}
