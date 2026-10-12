/* Evaluation world: the real assistant code (tools, loop, validator, rules classifier) on fixed fixtures.
   Fixtures are public snapshots of 12/10/2026 (menu, boxes, add-ons, offers) + the owner-approved FAQ answers.
   Nothing here talks to the live API, the database or WhatsApp. The only network call is the model. */
import fs from "node:fs";
import { indexMenu, openState, openingText, fmtTime } from "../wabot.js";
import { expandBundle, normalizeSlots } from "../bundles.js";
import { makeAssistTools } from "../waassist.js";
import * as AR from "../waassistrun.js";
import * as R from "../wabotrun.js";
import { factNote } from "../wadishfacts.js";
import { kbCandidates, kbCheck } from "../wakb.js";

const J = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
export const FX = { pages: J("menu.json").data.pages, bundles: J("bundles.json").bundles, mods: J("modifiers.json").items, offers: J("offers.json").offers || [], faq: J("faq.json"), variants: J("variants.json").variants };
export const PHONE = "512345678";
const HOURS = { enabled: true, days: { fri: { open: "12:00", close: "03:00" }, mon: { open: "12:00", close: "02:00" }, sat: { open: "12:00", close: "02:00" }, sun: { open: "12:00", close: "02:00" }, thu: { open: "12:00", close: "03:00" }, tue: { open: "12:00", close: "02:00" }, wed: { open: "12:00", close: "02:00" } } };
export const POLICY = { type: "distance_tiers", maxKm: 10, farZoneEnabled: true, farZoneMaxKm: 15, farZonePerKm: 3, farZoneFromKm: 10, feeByTotal: [{ fee: 20, over: 0 }, { fee: 15, over: 60 }, { fee: 10, over: 80 }, { fee: 5, over: 100 }, { fee: 0, over: 150 }] };
const OPEN_AT = "2026-10-12T15:00:00Z", CLOSED_AT = "2026-10-12T05:00:00Z";   // Monday 18:00 / 08:00 Riyadh
const RETURNING = { identity: { name: "أحمد محمد العتيبي" }, summary: { orders: 7, aov: 92.4, status: "repeat", daysSinceLast: 6.2 },
  orders: [{ source: "web", at: "2026-10-06T17:10:00Z", channel: "website", option: "delivery", total: 74, items: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "وجبة كفتة", qty: 1 }] },
    { source: "web", at: "2026-09-29T18:00:00Z", channel: "website", option: "delivery", total: 48, items: [{ name: "وجبة كفتة", qty: 2 }] }],
  favorites: { items: [{ name: "وجبة كفتة", qty: 5, orders: 4 }, { name: "كريب زنجر سوبريم", qty: 4, orders: 3 }], lean: "grill", leanLabel: "مشاوي" },
  addresses: [{ label: "البيت", area: "الصفا", street: "شارع صاري", building: "12", landmark: "جنب مسجد النور" }],
  reviews: [{ rating: 2, comment: "الأكل وصل بارد", categories: ["cold_food"], at: "2026-09-21T10:00:00Z" }], unpaidAttempts: [], voidedOrders: [] };
const NEW = { identity: { name: "" }, summary: { orders: 0, status: "no_orders" }, orders: [], favorites: { items: [] }, addresses: [], reviews: [], unpaidAttempts: [], voidedOrders: [] };
const undress = (b) => ({ ...b, slots: normalizeSlots(b.slots.map((s) => (s.type === "fixed" ? { key: s.key, type: "fixed", label: s.label, quantity: s.quantity, product_id: s.item.product_id, variant_option_id: s.item.variant_option_id ?? null }
  : { key: s.key, type: "choice", label: s.label, quantity: s.quantity, choices: s.choices.map((c) => ({ product_id: c.product_id, variant_option_id: c.variant_option_id ?? null, ...(c.surcharge ? { surcharge: c.surcharge } : {}) })) }))) });

/* w = { profile: "new"|"returning", closed, soldOut:[ids], loc: null|"in"|"far"|"out", offers: "none"|undefined, firstUsed, reorder, down:[source] } */
export function makeWorld(w = {}, { callModel, onCall, acfg: acfgIn = {} } = {}) {
  const nowIso = w.closed ? CLOSED_AT : OPEN_AT, now = () => new Date(nowIso);
  const soldOut = Object.fromEntries((w.soldOut || []).map((id) => [String(id), true]));
  const menu = indexMenu(FX.pages, { hiddenIds: [], soldOut, variants: w.noWeights ? null : FX.variants });      // M3: the live weights and prices of the by-weight dishes (fixtures/variants.json)
  const boxes = FX.bundles, raw = boxes.map(undress);
  const item = (id) => menu.items.find((i) => i.id === String(id));
  const resolve = (pid) => { const it = item(pid); return { name: it ? it.name : `#${pid}`, priceEx: (it ? it.price : 10) / 1.15, taxId: 1 }; };
  const carts = [];
  const pool = { async query(sql) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/FROM shop_coupons WHERE upper\(code\)='FIRST'/.test(s)) return { rows: [{ code: "FIRST", percent: 0, active: true, expires_at: null, free_delivery: true, min_total: 60 }] };
    if (/shop_coupons/.test(s) && /used|coupon = /.test(s) && !/cms_loyalty/.test(s)) return { rows: w.firstUsed || w.profile === "returning" ? [{ x: 1 }] : [], rowCount: w.firstUsed || w.profile === "returning" ? 1 : 0 };
    if (/FROM cms_loyalty l JOIN shop_coupons/.test(s)) return { rows: [] };
    if (/count\(\*\)::int AS n FROM shop_orders WHERE phone_norm=\$1 AND created_at >=/.test(s)) return { rows: [{ n: w.profile === "returning" ? 4 : 0 }] };
    if (/FROM shop_orders WHERE phone_norm=\$1 AND NOT COALESCE\(is_test,false\) AND status NOT IN \('expired','pending_payment'\) AND created_at > NOW\(\) - INTERVAL '72 hours'/.test(s)) return { rows: w.orders || [] };
    if (/FROM shop_orders/.test(s)) return { rows: w.profile === "returning" ? [{ x: 1 }] : [], rowCount: w.profile === "returning" ? 1 : 0 };
    if (/FROM wa_optins/.test(s)) return { rows: [] };
    if (/FROM ts_order_items/.test(s)) return { rows: [{ name: "بطاطس محمرة", qty: 900 }, { name: "وجبة ميكس جريل", qty: 420 }, { name: "كريب زنجر سوبريم", qty: 300 }, { name: "بنا تشيكن كازرول", qty: 280 }, { name: "وجبة نصف دجاجة على الفحم", qty: 260 }, { name: "كريب ميكس دجاج", qty: 240 }, { name: "برجر لحم كلاسيك", qty: 200 }] };
    return { rows: [], rowCount: 0 };
  } };
  const settings = { hours: HOURS, cms: { loyalty: { enabled: true, every: 3, reward: "free_delivery", minTotal: 60, startedAt: "2026-09-01" } } };
  const down = new Set(w.down || []);
  const feeFor = (t) => (t >= 150 ? 0 : t >= 100 ? 5 : t >= 80 ? 10 : t >= 60 ? 15 : 20);
  const nextAt = (t) => (t < 60 ? 60 : t < 80 ? 80 : t < 100 ? 100 : t < 150 ? 150 : null);
  const tools = makeAssistTools({ pool, log: () => {}, now, tune: async () => AR.assistConfig(acfgIn),
    menuIndex: async () => (down.has("menu") ? null : menu), dishNote: async (id) => { const ar = factNote(id, "ar"); return ar ? { ar, en: factNote(id, "en") || ar } : null; }, boxes: async () => (down.has("boxes") ? null : boxes),
    expandBundle: async (slug, choices, qty, _option, extra) => { const b = raw.find((x) => x.slug === slug); return b ? expandBundle(b, choices, qty, resolve, extra) : { ok: false, error: "bundle_not_found" }; },
    modifiers: { catalogItems: async () => FX.mods, resolve: async (pid, ids) => { const opts = (FX.mods[String(pid)] || []).flatMap((g) => g.options); const bad = ids.filter((id) => !opts.some((o) => o.id === id));
      return bad.length ? { ok: false, error: "unknown_modifier", ids: bad } : { ok: true, shown: ids.reduce((a, id) => a + opts.find((o) => o.id === id).shown, 0) }; } },
    quote: async ({ orderTotal }) => (w.loc === "out" ? { deliverable: false, reason: "out_of_range" } : { deliverable: true, fee: feeFor(orderTotal) + (w.loc === "far" ? 9 : 0), toNextTier: nextAt(orderTotal) ? nextAt(orderTotal) - orderTotal : 0, nextTierFee: nextAt(orderTotal) ? feeFor(nextAt(orderTotal)) : null, toFree: Math.max(0, 150 - orderTotal), routeKm: w.loc === "far" ? 21.3 : 6.4, ...(w.eta ? { etaMinutes: w.eta } : {}), ...(w.loc === "far" ? { farZone: { surcharge: 9 } } : {}) }),
    offers: async () => (w.offers === "none" ? [] : FX.offers.filter((o) => (!o.until || o.until >= nowIso.slice(0, 10))).map((o) => ({ title: o.title, price: o.price, until: o.until || null }))),
    openState: async () => { const o = openState(settings, now()); let opens = null; try { opens = o.open ? null : openingText(HOURS, now(), "ar"); } catch { opens = null; } return { open: o.open, closesText: o.closesAt ? fmtTime(o.closesAt, "ar") : null, opensText: opens, deliveryPaused: false }; },
    settings: async () => settings, buildProfile: async () => (w.profile === "returning" ? RETURNING : NEW),
    lastLocation: async () => state.loc, botCarts: { create: async (x) => { const code = `ev${String(carts.length + 1).padStart(6, "0")}`; carts.push({ code, ...x }); return { code }; } } });
  const state = { loc: null };
  const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`], dishFactsEnabled: true } });
  const faq = async (topic, lang) => {
    if (topic === "payment") return lang === "en" ? "Online payment with Apple Pay, mada, credit cards and STC Pay." : "الدفع الإلكتروني عبر Apple Pay وmada والبطاقات الائتمانية وSTC Pay.";
    if (topic === "branch_location") return R.textOf(cfg, "location", lang);
    const a = FX.faq[topic]; return a ? (lang === "en" ? a.en : a.ar) || null : null;
  };
  const loop = AR.makeAssistLoop({ tools, callModel, onCall, now, faq, knowOf: async () => ({ menu, boxes }),
    dishFactSay: async (a) => R.dishFactSay(cfg, { open: { open: !w.closed } }, a),
    /* manager knowledge base: w.kb = [{ id, question, ar, en? }] (same matching and the same re-check as the store) */
    kbSearch: async (question, lang) => kbCandidates((w.kb || []).map((r) => ({ ...r, examples: r.examples || [] })), question).map((r) => ({ id: r.id, question: r.question, say: (lang === "en" && r.en) || r.ar })).filter((r) => kbCheck(r.say).ok),
    deliveryInfo: async () => ({ ok: true, delivers_up_to_km: POLICY.maxKm, far_zone_up_to_km: POLICY.farZoneMaxKm, far_zone_extra_per_km: POLICY.farZonePerKm, fee_by_order_total: R.feeLines(POLICY, "ar").split("\n"), note: "the exact fee is shown on the website before payment" }) });
  const acfg = { ...AR.assistConfig({ mode: "test", ...acfgIn }) };
  const reorder = w.reorder ? { day: "يوم الثلاثاء 6/10", lines: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "وجبة كفتة", qty: 1 }], note: "a one-tap button «نفس طلبي السابق» is attached under your message" } : null;
  return { tools, loop, menu, boxes, cfg, acfg, carts, state, now, reorder, know: { menu, bundles: boxes } };
}
