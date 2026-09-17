/* ناشر السوشال (كاروسيل/ريلز/ستوري على IG وFB) + حارس التاريخ والكلام — 17 سبتمبر 2026.
     node --test socialpub.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  publishInstagram, publishFacebook, retryPlan, offerGuard, copyIssues, failAlertText,
  healthAlertText, isVideoUrl,
} from "./socialpub.js";
import { smsInfo } from "./staffalerts.js";

const G = "https://graph.test/v25.0";
const noSleep = async () => {};

/* ميتا مزيّفة: كل نداء بيتسجّل، والرد بيتحدد بدالة. */
function fakeMeta(route) {
  const calls = [];
  const http = async (url, opts = {}) => {
    const body = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
    calls.push({ url, method: opts.method || "GET", body, headers: opts.headers || {} });
    const r = route(url, opts.method || "GET", body, calls);
    return { ok: r.status ? r.status < 400 : true, status: r.status ?? 200, json: r.json ?? r, error: r.error };
  };
  return { http, calls };
}

test("IG كاروسيل: شريحة لكل صورة بـis_carousel_item، وبعدين حاوية CAROUSEL بالأبناء، ونشر", async () => {
  let n = 0;
  const { http, calls } = fakeMeta((url, m, b) => {
    if (url.endsWith("/ig1/media") && m === "POST") return { id: `c${++n}` };
    if (url.includes("fields=status_code")) return { status_code: "FINISHED" };
    if (url.endsWith("/media_publish")) return { id: "m1" };
    if (url.includes("/m1?")) return { permalink: "https://instagram.com/p/X", timestamp: "2026-09-19T14:15:00Z" };
    return { status: 400, json: { error: { message: "unexpected" } } };
  });
  const out = await publishInstagram({
    http, graph: G, igUserId: "ig1", token: "t", type: "CAROUSEL",
    urls: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"], caption: "كاب", sleep: noSleep,
  });
  assert.equal(out.permalink, "https://instagram.com/p/X");
  const creates = calls.filter((c) => c.url.endsWith("/ig1/media"));
  assert.equal(creates.length, 4);
  assert.equal(creates[0].body.is_carousel_item, "true");
  assert.equal(creates[3].body.media_type, "CAROUSEL");
  assert.equal(creates[3].body.children, "c1,c2,c3");
  assert.equal(creates[3].body.caption, "كاب");
});

test("IG ريل: REELS + video_url + share_to_feed، والفيديو اللي لسه بيتجهّز بيرجع retry بالحاوية", async () => {
  const { http, calls } = fakeMeta((url, m) => {
    if (url.endsWith("/ig1/media") && m === "POST") return { id: "r1" };
    if (url.includes("fields=status_code")) return { status_code: "IN_PROGRESS" };
    return { status: 400, json: { error: { message: "x" } } };
  });
  await assert.rejects(
    publishInstagram({ http, graph: G, igUserId: "ig1", token: "t", type: "REELS",
      urls: ["https://a/v.mp4"], caption: "c", options: { shareToFeed: false }, sleep: noSleep, pollTries: 2 }),
    (e) => e.retry === true && e.state?.containerId === "r1");
  const c = calls.find((x) => x.url.endsWith("/ig1/media"));
  assert.equal(c.body.media_type, "REELS");
  assert.equal(c.body.video_url, "https://a/v.mp4");
  assert.equal(c.body.share_to_feed, "false");

  // المحاولة التانية بتكمّل على نفس الحاوية من غير ما تعمل واحدة جديدة
  const m2 = fakeMeta((url) => {
    if (url.includes("fields=status_code")) return { status_code: "FINISHED" };
    if (url.endsWith("/media_publish")) return { id: "m9" };
    if (url.includes("/m9?")) return { permalink: "https://instagram.com/reel/Y" };
    return { status: 400, json: { error: { message: "x" } } };
  });
  const out = await publishInstagram({ http: m2.http, graph: G, igUserId: "ig1", token: "t", type: "REELS",
    urls: ["https://a/v.mp4"], state: { containerId: "r1" }, sleep: noSleep });
  assert.equal(out.permalink, "https://instagram.com/reel/Y");
  assert.equal(m2.calls.filter((x) => x.url.endsWith("/ig1/media")).length, 0);
});

test("IG ستوري صورة وفيديو: media_type=STORIES ومفيش كابشن", async () => {
  for (const [u, key] of [["https://a/s.jpg", "image_url"], ["https://a/s.mp4", "video_url"]]) {
    const { http, calls } = fakeMeta((url, m) => {
      if (url.endsWith("/ig1/media") && m === "POST") return { id: "s1" };
      if (url.includes("fields=status_code")) return { status_code: "FINISHED" };
      if (url.endsWith("/media_publish")) return { id: "m2" };
      return { permalink: "" };
    });
    await publishInstagram({ http, graph: G, igUserId: "ig1", token: "t", type: "STORIES", urls: [u], sleep: noSleep });
    const c = calls.find((x) => x.url.endsWith("/ig1/media"));
    assert.equal(c.body.media_type, "STORIES");
    assert.equal(c.body[key], u);
    assert.equal(c.body.caption, undefined);
  }
});

test("IG: ضياع أمر النشر في الشبكة = uncertain (مايتعادش عشان مايتنشرش مرتين)", async () => {
  const { http } = fakeMeta((url, m) => {
    if (url.endsWith("/ig1/media") && m === "POST") return { id: "c1" };
    if (url.includes("fields=status_code")) return { status_code: "FINISHED" };
    if (url.endsWith("/media_publish")) return { status: 0, json: null, error: "timeout" };
    return {};
  });
  await assert.rejects(publishInstagram({ http, graph: G, igUserId: "ig1", token: "t", urls: ["https://a/1.jpg"], sleep: noSleep }),
    (e) => e.uncertain === true && !e.retry);
});

test("IG: ملف مرفوض (ERROR) مش retry، ورابط http مرفوض قبل أي نداء", async () => {
  const { http } = fakeMeta((url, m) => {
    if (url.endsWith("/ig1/media") && m === "POST") return { id: "c1" };
    return { status_code: "ERROR", status: "bad aspect" };
  });
  await assert.rejects(publishInstagram({ http, graph: G, igUserId: "ig1", token: "t", urls: ["https://a/1.jpg"], sleep: noSleep }),
    (e) => e.retry === false);
  const m2 = fakeMeta(() => ({}));
  await assert.rejects(publishInstagram({ http: m2.http, graph: G, igUserId: "ig1", token: "t", urls: ["http://a/1.jpg"] }),
    (e) => e.retry === false);
  assert.equal(m2.calls.length, 0);
});

test("FB صورة: /photos بالكابشن، والمعرّف = post_id عشان المزامنة تطابقه", async () => {
  const { http, calls } = fakeMeta((url) => {
    if (url.endsWith("/p1/photos")) return { id: "ph1", post_id: "p1_555" };
    if (url.includes("/p1_555?")) return { permalink_url: "https://www.facebook.com/p1/posts/555" };
    return {};
  });
  const out = await publishFacebook({ http, graph: G, pageId: "p1", token: "t", urls: ["https://a/1.jpg"], caption: "هاي" });
  assert.equal(out.externalId, "p1_555");
  assert.equal(out.permalink, "https://www.facebook.com/p1/posts/555");
  assert.equal(calls[0].body.message, "هاي");
  assert.equal(calls[0].body.published, "true");
});

test("FB ألبوم: كل صورة unpublished وبعدين /feed بـattached_media", async () => {
  let k = 0;
  const { http, calls } = fakeMeta((url) => {
    if (url.endsWith("/p1/photos")) return { id: `f${++k}` };
    if (url.endsWith("/p1/feed")) return { id: "p1_9" };
    return { permalink_url: "/p1/posts/9" };
  });
  const out = await publishFacebook({ http, graph: G, pageId: "p1", token: "t", type: "CAROUSEL",
    urls: ["https://a/1.jpg", "https://a/2.jpg"], caption: "ألبوم" });
  assert.equal(out.externalId, "p1_9");
  assert.equal(out.permalink, "https://www.facebook.com/p1/posts/9");
  const feed = calls.find((c) => c.url.endsWith("/feed"));
  assert.equal(feed.body["attached_media[1]"], JSON.stringify({ media_fbid: "f2" }));
  assert.ok(calls.filter((c) => c.url.endsWith("/photos")).every((c) => c.body.published === "false"));
});

test("FB ريل: start → رفع بـfile_url → finish PUBLISHED بالوصف", async () => {
  const { http, calls } = fakeMeta((url, m, b) => {
    if (url.endsWith("/p1/video_reels") && b.upload_phase === "start") return { video_id: "v7", upload_url: "https://rupload.test/v7" };
    if (url === "https://rupload.test/v7") return { success: true };
    if (url.endsWith("/p1/video_reels") && b.upload_phase === "finish") return { success: true, post_id: "p1_77" };
    return {};
  });
  const out = await publishFacebook({ http, graph: G, pageId: "p1", token: "t", type: "REELS", urls: ["https://a/v.mp4"], caption: "ريل" });
  assert.equal(out.permalink, "https://www.facebook.com/reel/v7");
  assert.equal(calls[1].headers.file_url, "https://a/v.mp4");
  assert.equal(calls[2].body.video_state, "PUBLISHED");
  assert.equal(calls[2].body.description, "ريل");
});

test("FB ستوري صورة: صورة unpublished ثم photo_stories", async () => {
  const { http, calls } = fakeMeta((url) => {
    if (url.endsWith("/p1/photos")) return { id: "ph5" };
    if (url.endsWith("/p1/photo_stories")) return { success: true, post_id: "p1_st" };
    return { permalink_url: "" };
  });
  const out = await publishFacebook({ http, graph: G, pageId: "p1", token: "t", type: "STORIES", urls: ["https://a/s.jpg"] });
  assert.equal(out.externalId, "p1_st");
  assert.equal(calls[1].body.photo_id, "ph5");
});

test("الإعادة: ٣ محاولات ثم نهائي، وuncertain/مش-retry نهائي من أول مرة", () => {
  const now = Date.parse("2026-09-17T18:00:00Z");
  const a = retryPlan({ attempts: 0, retryable: true, now });
  assert.equal(a.final, false);
  assert.equal(a.nextAttemptAt, "2026-09-17T18:10:00.000Z");
  assert.equal(retryPlan({ attempts: 1, retryable: true, now }).final, false);
  assert.equal(retryPlan({ attempts: 2, retryable: true, now }).final, true);
  assert.equal(retryPlan({ attempts: 0, retryable: false, now }).final, true);
  assert.equal(retryPlan({ attempts: 0, retryable: true, uncertain: true, now }).final, true);
});

const OFFERS = [
  { id: "combo70", title: "بيتزا + باستا + كريب", catalogTitle: "بيتزا + باستا + كريب 70 ريال", desc: "", price: 70, from: "2026-06-01", until: "2026-09-14" },
  { id: "lamma", title: "صينية اللمة", catalogTitle: "صينية اللمة 100 ريال", price: 100, until: "2026-09-14" },
  { id: "nd96_kilo", title: "كيلو مشاوي — اليوم الوطني ٩٦", catalogTitle: "كيلو مشاوي + أرز — اليوم الوطني ٩٦ ريال", desc: "كيلو مشاوي من اختيارك", price: 96, from: "2026-09-15", until: "2026-09-30" },
  { id: "nd96_box", title: "بوكس اليوم الوطني ٩٦", catalogTitle: "بوكس اليوم الوطني ٩٦ ريال", desc: "بيتزا + باستا + كريب من اختيارك (ما عدا السي فود)", price: 96, from: "2026-09-15", until: "2026-09-30" },
];

test("حارس التاريخ: بوست البوكس بـ«بيتزا + باستا + كريب» يوم ١٤–١٧/٩ مايتمنعش (ده الإنذار الكاذب)", () => {
  for (const day of ["2026-09-15", "2026-09-17", "2026-09-30"]) {
    const v = offerGuard({ text: "بوكس ٩٦ 💚 بيتزا + باستا + كريب من اختيارك (ما عدا السي فود) وحواوشي", day, channel: "instagram" }, OFFERS);
    assert.equal(v.block, false, `${day}: ${v.reason}`);
  }
  const v2 = offerGuard({ text: "ليلة الخميس… بيتزا وباستا وكريب من اختيارك · بوكس ٩٦", day: "2026-09-17", origin: "queue", channel: "facebook" }, OFFERS);
  assert.equal(v2.block, false);
});

test("حارس التاريخ: بعد ٣٠/٩ بيتمنع (بالاسم أو بالرقم أو بالوسم)، والصينية القديمة كمان", () => {
  assert.equal(offerGuard({ text: "كيلو ٩٦ والأرز معاه", day: "2026-10-01", channel: "instagram" }, OFFERS).block, true);
  assert.equal(offerGuard({ text: "", tags: ["nd96_box"], day: "2026-10-01", channel: "instagram" }, OFFERS).block, true);
  assert.equal(offerGuard({ text: "", tags: ["nd96_box"], day: "2026-09-20", channel: "instagram" }, OFFERS).block, false);
  assert.equal(offerGuard({ text: "صينية اللمة بـ١٠٠", day: "2026-09-20", channel: "instagram" }, OFFERS).block, true);
  assert.equal(offerGuard({ text: "بيتزا + باستا + كريب ٧٠ ريال", day: "2026-10-02", origin: "queue" }, OFFERS).block, true);
});

test("حارس السعر: «N ريال» لازم يطابق عرض شغّال يومها", () => {
  assert.equal(offerGuard({ text: "بوكس ٩٦ ريال", day: "2026-09-20", channel: "instagram" }, OFFERS).block, false);
  const v = offerGuard({ text: "كيلو مشاوي بـ٨٠ ريال", day: "2026-09-20", channel: "instagram" }, OFFERS);
  assert.equal(v.block, true);
  assert.equal(v.verdict, "price");
  // فيسبوك مستورد (مجدول عند ميتا) بيتحذّر بس
  assert.equal(offerGuard({ text: "كيلو ٩٦", day: "2026-10-05", channel: "facebook", origin: "imported" }, OFFERS).block, false);
});

test("الكلام الممنوع: وفّر/٪/فقط/حصرياً/FIRST/الهاشتاج الغلط/+ في البوكس/🇸🇦", () => {
  assert.deepEqual(copyIssues("بوكس ٩٦ · بيتزا وباستا وكريب (ما عدا السي فود) #عزنا_بطبعنا #فريش_كاتس"), []);
  for (const bad of ["وفّر ٢٠", "خصم كبير", "٢٠٪", "فقط اليوم", "حصرياً أونلاين", "كود FIRST", "#فريش_كتس",
    "#اليوم_الوطني_السعودي_96", "🇸🇦", "بيتزا + باستا + كريب", "ستيك"]) {
    assert.ok(copyIssues(bad).length > 0, bad);
  }
});

test("تنبيهات SMS: إنجليزي ورسالة واحدة حتى لو سبب الفشل عربي طويل", () => {
  const t = failAlertText({ channel: "instagram", media_type: "CAROUSEL", scheduled_at: "2026-09-19T14:15:00Z" },
    "حاوية الكاروسيل: " + "خطأ ".repeat(80) + " (#9004) media fetch failed " + "x".repeat(200));
  assert.equal(smsInfo(t).encoding, "GSM-7");
  assert.equal(smsInfo(t).segments, 1);
  assert.match(t, /IG CAROUSEL 19\/09 17:15 FAILED/);
  const h = healthAlertText({ failed: 2, overdue: 1, foreign: 6, tokenBad: true });
  assert.equal(smsInfo(h).segments, 1);
  assert.equal(smsInfo(h).encoding, "GSM-7");
});

test("isVideoUrl", () => {
  assert.equal(isVideoUrl("https://x/api/content/media/md_1.mp4"), true);
  assert.equal(isVideoUrl("https://x/a.jpg"), false);
});
