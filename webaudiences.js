/* ═══════════════════════════════════════════════════════════════════════════
   WEB AUDIENCES — جماهير البيكسل على سناب وجوجل (وتيك توك لما يتسمح)

   النص التاني من audiences.js (جماهير المنصة نفسها — مفيهاش ولا رقم جوال
   واحد من عندنا، المنصة بتبنيها من البيكسل/التاج بتاعها). ميتا متغطية في
   audiences.js (META_AUDIENCES)؛ هنا سناب وجوجل بنفس المفاتيح عشان اللوحة
   تعرض صف واحد لكل «زاروا ٧ أيام» على كل المنصات.

   • idempotent: قبل أي إنشاء بندوّر بالاسم على المنصة ونتبنّى الموجود.
   • الـids بتتخزّن في aud_audiences (platform, segment=key)، والأحجام في
     aud_sizes بطريقة القياس بتاعة كل منصة:
       سناب  approximate_number_users (NOT_READY/0 = «لسه بيتعبّى»، مش صفر)
       جوجل  size_for_display / size_for_search (جوجل بتقرّب؛ أقل من ١٠٠ = مش قابل للاستهداف)
   • تيك توك: التوكن بتاعنا مالوش صلاحية Pixel (pixel/list بيرجع 40001)، وقواعد
     جمهور البيكسل محتاجة pixel_id رقمي مانقدرش نقراه ⇒ rule/create بيرجع
     'value' is invalid. متسجّل كـ blocked بسبب مكتوب — مش خطأ بيتكرر.

   ولا نداء هنا بيصرف ريال. كله إنشاء/قراءة جماهير.
═══════════════════════════════════════════════════════════════════════════ */

import { byId, httpJson } from "./ads.js";

const env = (k) => (process.env[k] || "").trim();
const SNAP_BASE = "https://adsapi.snapchat.com/v1";

/* الكتالوج الموحّد. `snap` = أحداث بيكسل سناب، `google` = قاعدة التاج.
   الأسماء نفس أسماء ميتا بالظبط (العقد مع اللي موجود). */
export const WEB_AUDIENCES = [
  { key: "web:visitors7",   name: "FreshCuts Web Visitors 7d",   days: 7,   tier: "hot",     ar: "زار الموقع آخر ٧ أيام",    snap: ["PAGE_VIEW"], google: { pagetype: null } },
  { key: "web:visitors30",  name: "FreshCuts Web Visitors 30d",  days: 30,  tier: "warm",    ar: "زار الموقع آخر ٣٠ يوم",    snap: ["PAGE_VIEW"], google: { pagetype: null } },
  { key: "web:visitors180", name: "FreshCuts Web Visitors 180d", days: 180, tier: "prospect", ar: "زار الموقع آخر ١٨٠ يوم",  snap: ["PAGE_VIEW"], google: { pagetype: null } },
  { key: "web:viewers30",   name: "FreshCuts Product Viewers 30d", days: 30, tier: "warm",   ar: "فتح صنف أو عرض آخر ٣٠ يوم", snap: ["VIEW_CONTENT"], google: { pagetype: "product" } },
  { key: "web:atc7",        name: "FreshCuts Add To Cart 7d",    days: 7,   tier: "hot",     ar: "حط في السلة آخر ٧ أيام",   snap: ["ADD_CART"], google: { pagetype: "cart", excludeBuyers: true } },
  { key: "web:atc30",       name: "FreshCuts Add To Cart 30d",   days: 30,  tier: "warm",    ar: "حط في السلة آخر ٣٠ يوم",   snap: ["ADD_CART"], google: { pagetype: "cart", excludeBuyers: true } },
  { key: "web:ic7",         name: "FreshCuts Checkout Started 7d", days: 7, tier: "hot",     ar: "بدأ الشيك أوت آخر ٧ أيام", snap: ["START_CHECKOUT"], google: { pagetype: "checkout", excludeBuyers: true } },
  { key: "web:ic30",        name: "FreshCuts Checkout Started 30d", days: 30, tier: "warm",  ar: "بدأ الشيك أوت آخر ٣٠ يوم", snap: ["START_CHECKOUT"], google: { pagetype: "checkout", excludeBuyers: true } },
  { key: "web:buyers7",     name: "FreshCuts Web Purchasers 7d", days: 7,   tier: "exclude", ar: "اشترى من الموقع آخر ٧ أيام — استبعاد", snap: ["PURCHASE"], google: { pagetype: "purchase" } },
  { key: "web:buyers30",    name: "FreshCuts Web Purchasers 30d", days: 30, tier: "exclude", ar: "اشترى من الموقع آخر ٣٠ يوم — استبعاد", snap: ["PURCHASE"], google: { pagetype: "purchase" } },
  { key: "web:buyers180",   name: "FreshCuts Web Purchasers 180d", days: 180, tier: "exclude", ar: "اشترى من الموقع آخر ١٨٠ يوم — استبعاد", snap: ["PURCHASE"], google: { pagetype: "purchase" } },
];

/* ليه جوجل بـ ecomm_pagetype: pixels.js بيبعت مع كل حدث تسوّق gtag event فيه
   ecomm_pagetype = product | cart | checkout | purchase (وecomm_prodid بنفس معرّفات
   الكتالوج). القاعدة بتتقري المعامل ده. «زاروا» = url__ فيه freshcuts.sa. */
function googleRule(spec) {
  const days = spec.days;
  const item = spec.google.pagetype
    ? { name: "ecomm_pagetype", stringRuleItem: { operator: "EQUALS", value: spec.google.pagetype } }
    : { name: "url__", stringRuleItem: { operator: "CONTAINS", value: "freshcuts.sa" } };
  const fr = {
    inclusiveRuleOperator: "AND",
    inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [item] }] }, lookbackWindowDays: days }],
  };
  if (spec.google.excludeBuyers) {
    fr.exclusiveOperands = [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: "ecomm_pagetype", stringRuleItem: { operator: "EQUALS", value: "purchase" } }] }] }, lookbackWindowDays: days }];
  }
  return {
    name: spec.name, description: spec.ar, membershipLifeSpan: Math.min(540, days), membershipStatus: "OPEN",
    ruleBasedUserList: { prepopulationStatus: "REQUESTED", flexibleRuleUserList: fr },
  };
}

export function register(ctx) {
  const { pool } = ctx;

  const saveId = (platform, key, id, name) => pool.query(
    `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id, name=EXCLUDED.name`,
    [platform, key, String(id), name]);
  const savedIds = async (platform) => Object.fromEntries((await pool.query(
    `SELECT segment, audience_id FROM aud_audiences WHERE platform=$1`, [platform])).rows.map((x) => [x.segment, x.audience_id]));
  const saveSize = (platform, key, id, { low = null, high = null, method, ok, error = null }) => pool.query(
    `INSERT INTO aud_sizes (platform, key, audience_id, low, high, dau, method, ok, error, measured_at)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NOW())
     ON CONFLICT (platform, key) DO UPDATE SET audience_id=EXCLUDED.audience_id, low=EXCLUDED.low, high=EXCLUDED.high,
       method=EXCLUDED.method, ok=EXCLUDED.ok, error=EXCLUDED.error, measured_at=NOW()`,
    [platform, key, id ? String(id) : null, low, high, method, !!ok, error ? String(error).slice(0, 300) : null]).catch(() => {});

  /* ── Snapchat ─────────────────────────────────────────────────────────── */
  async function snapCtx() {
    const t = await byId("snapchat").token();
    const acct = env("SNAP_AD_ACCOUNT_ID"), px = env("SNAP_PIXEL_ID");
    if (!t || !acct || !px) return { ok: false, error: "SNAP_AD_ACCOUNT_ID / SNAP_PIXEL_ID / OAuth ناقصين" };
    return { ok: true, acct, px, hdr: { "Content-Type": "application/json", Authorization: `Bearer ${t}` } };
  }
  async function snapList(sc) {
    const r = await httpJson(`${SNAP_BASE}/adaccounts/${sc.acct}/segments`, { method: "GET", headers: sc.hdr });
    if (!r.ok) return { ok: false, error: r.json?.debug_message || r.error || `HTTP ${r.status}` };
    return { ok: true, list: (r.json?.segments || []).map((x) => x.segment) };
  }
  async function ensureSnap() {
    const out = { platform: "snapchat", ok: true, created: [], adopted: [], existing: [], failed: [] };
    const sc = await snapCtx(); if (!sc.ok) return { ...out, ok: false, error: sc.error };
    const have = await savedIds("snapchat");
    const l = await snapList(sc); if (!l.ok) return { ...out, ok: false, error: l.error };
    const byName = new Map(l.list.filter((s) => s.source_type === "PIXEL").map((s) => [s.name, s]));
    for (const spec of WEB_AUDIENCES) {
      if (have[spec.key]) { out.existing.push(spec.key); continue; }
      const found = byName.get(spec.name);
      if (found) { await saveId("snapchat", spec.key, found.id, spec.name); out.adopted.push({ key: spec.key, id: found.id }); continue; }
      const r = await httpJson(`${SNAP_BASE}/adaccounts/${sc.acct}/segments`, {
        method: "POST", headers: sc.hdr,
        body: { segments: [{
          name: spec.name, description: spec.ar, source_type: "PIXEL", retention_in_days: spec.days,
          ad_account_id: sc.acct, pixel_id: sc.px, prefill: true,
          pixel_spec: JSON.stringify({ or: { event: spec.snap.map((e) => ({ eq: e })) } }),
        }] },
      });
      const seg = r.json?.segments?.[0]?.segment;
      if (!r.ok || !seg?.id) { out.ok = false; out.failed.push({ key: spec.key, error: r.json?.segments?.[0]?.sub_request_error_reason || r.json?.debug_message || `HTTP ${r.status}` }); continue; }
      await saveId("snapchat", spec.key, seg.id, spec.name);
      out.created.push({ key: spec.key, id: seg.id });
    }
    return out;
  }
  async function measureSnap() {
    const sc = await snapCtx(); if (!sc.ok) return { ok: false, error: sc.error };
    const l = await snapList(sc); if (!l.ok) return { ok: false, error: l.error };
    const have = await savedIds("snapchat");
    const byId_ = new Map(l.list.map((s) => [s.id, s]));
    let n = 0;
    for (const spec of WEB_AUDIENCES) {
      const id = have[spec.key]; if (!id) continue;
      const s = byId_.get(id);
      if (!s) { await saveSize("snapchat", spec.key, id, { method: "none", ok: false, error: "الجمهور مش موجود على سناب" }); continue; }
      const ready = s.targetable_status === "READY";
      const v = Number(s.approximate_number_users);
      await saveSize("snapchat", spec.key, id, ready && Number.isFinite(v)
        ? { low: v, high: v, method: "approximate_number_users", ok: true }
        : { method: "approximate_number_users", ok: false, error: `لسه بيتعبّى (${s.targetable_status || "?"})` });
      n++;
    }
    return { ok: true, measured: n };
  }

  /* ── Google Ads ───────────────────────────────────────────────────────── */
  const g = () => byId("google");
  async function googleLists() {
    const r = await g().search("SELECT user_list.id, user_list.name, user_list.size_for_display, user_list.size_for_search, user_list.membership_status FROM user_list");
    if (!r.ok) return { ok: false, error: r.reason };
    return { ok: true, list: r.results.map((x) => x.userList) };
  }
  async function ensureGoogle() {
    const out = { platform: "google", ok: true, created: [], adopted: [], existing: [], failed: [] };
    const l = await googleLists(); if (!l.ok) return { ...out, ok: false, error: l.error };
    const have = await savedIds("google");
    const byName = new Map(l.list.map((u) => [u.name, u]));
    const tok = await g().token();
    for (const spec of WEB_AUDIENCES) {
      if (have[spec.key]) { out.existing.push(spec.key); continue; }
      const found = byName.get(spec.name);
      if (found) { await saveId("google", spec.key, found.id, spec.name); out.adopted.push({ key: spec.key, id: found.id }); continue; }
      const r = await httpJson(`${g().apiBase()}/customers/${g().cust()}/userLists:mutate`, {
        method: "POST", headers: { ...g().hdr(), Authorization: `Bearer ${tok}` },
        body: { operations: [{ create: googleRule(spec) }] },
      });
      const rn = r.json?.results?.[0]?.resourceName;
      if (!r.ok || !rn) {
        out.ok = false;
        out.failed.push({ key: spec.key, error: r.json?.error?.details?.[0]?.errors?.[0]?.message || r.json?.error?.message || `HTTP ${r.status}` });
        continue;
      }
      const id = rn.split("/").pop();
      await saveId("google", spec.key, id, spec.name);
      out.created.push({ key: spec.key, id });
    }
    return out;
  }
  async function measureGoogle() {
    const l = await googleLists(); if (!l.ok) return { ok: false, error: l.error };
    const have = await savedIds("google");
    const m = new Map(l.list.map((u) => [String(u.id), u]));
    let n = 0;
    for (const spec of WEB_AUDIENCES) {
      const id = have[spec.key]; if (!id) continue;
      const u = m.get(String(id));
      if (!u) { await saveSize("google", spec.key, id, { method: "none", ok: false, error: "القايمة مش موجودة على جوجل" }); continue; }
      const d = Number(u.sizeForDisplay), s = Number(u.sizeForSearch);
      await saveSize("google", spec.key, id, { low: Number.isFinite(d) ? d : null, high: Number.isFinite(s) ? s : null, method: "size_for_display/search", ok: true });
      n++;
    }
    return { ok: true, measured: n };
  }

  const TIKTOK_BLOCK = "تيك توك: التوكن مالوش صلاحية Pixel (pixel/list ⇒ 40001) — جمهور البيكسل بيتعمل يدوي من TikTok Ads Manager أو بعد إعادة تفويض التطبيق بصلاحية Pixel Management.";

  async function ensureAll() {
    const snap = await ensureSnap().catch((e) => ({ ok: false, error: e.message }));
    const google = await ensureGoogle().catch((e) => ({ ok: false, error: e.message }));
    return { ok: !!(snap.ok && google.ok), snapchat: snap, google, tiktok: { ok: false, blocked: TIKTOK_BLOCK } };
  }
  async function measureAll() {
    const snap = await measureSnap().catch((e) => ({ ok: false, error: e.message }));
    const google = await measureGoogle().catch((e) => ({ ok: false, error: e.message }));
    return { ok: !!(snap.ok && google.ok), snapchat: snap, google };
  }

  /* للّوحة: صف لكل جمهور × منصة (ميتا بتيجي من statusLine في audiences.js). */
  async function status() {
    const ids = (await pool.query(`SELECT platform, segment, audience_id FROM aud_audiences WHERE platform IN ('snapchat','google') AND segment LIKE 'web:%'`)).rows;
    const sizes = (await pool.query(`SELECT * FROM aud_sizes WHERE platform IN ('snapchat','google')`)).rows;
    const sz = new Map(sizes.map((x) => [`${x.platform}|${x.key}`, x]));
    return {
      catalogue: WEB_AUDIENCES.map(({ key, name, days, tier, ar }) => ({ key, name, days, tier, ar })),
      rows: ids.map((x) => {
        const s = sz.get(`${x.platform}|${x.segment}`);
        return {
          platform: x.platform, key: x.segment, id: x.audience_id,
          size: s?.ok ? { low: s.low, high: s.high, method: s.method } : null,
          /* الحدّين متساويين = ميتا/سناب بترجّع رقم أرضية مش قياس — نفس قاعدة
             audiences.js. من غير الحقل ده اللوحة كانت بترسم الأرضية كإنها عدد. */
          floor: s?.ok && Number(s.low) === Number(s.high) ? Number(s.low) : null,
          sizeNote: s?.ok ? null : (s?.error || "لسه ما اتقاسش"),
          measuredAt: s?.measured_at || null,
        };
      }),
      tiktok: { blocked: TIKTOK_BLOCK },
    };
  }

  return { ensureAll, measureAll, status, ensureSnap, ensureGoogle, WEB_AUDIENCES };
}
