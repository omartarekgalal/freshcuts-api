/* ════════════════════════════════════════════════════════════════════════════
   BF2 (٢٠/١٠/٢٠٢٦) — الفحص الليلي (BF1) طلّع إنذارات كاذبة في أول تشغيل (يوم ١٩/١٠):
   - wrong_price: «المجموع 58 ر.س» اتقرا كسعر «بطاطس محمرة» (…9572)، وكمان «المجموع 39» و«بيبسي زجاج … المجموع 85» (…9082).
   - broken_promise «أضفت» على سلات حقيقية اتسعّرت (preview_cart ناجح في نفس الدور) — …9572 دفع 58 ر.س.
   الاختبارات من الصفوف الحقيقية بالنص (الأرقام مقنّعة 5000000xx). node --test bf2-selfreview-fp.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "./walearn.js";

/* المنيو الحي يوم ١٩/١٠ (الأسعار اللي الفحص قرأها فعلاً) */
const MENU = { items: [
  { id: "1", name: "بطاطس محمرة", price: 6 }, { id: "2", name: "بيبسي زجاج", price: 4 }, { id: "3", name: "دوريتوس", price: 5 },
  { id: "4", name: "وجبة ميكس جريل", price: 37 }, { id: "13", name: "وجبة نصف دجاجة على الفحم", price: 28 }, { id: "21", name: "تشيز فرايز", price: 12 },
  { id: "103", name: "مشكل مخصوص بالوزن", weights: [{ price: 53 }, { price: 78 }, { price: 155 }] },
] };
const pm = (t, boxes = []) => L.priceMismatches(t, { menu: MENU, boxes });

test("BF2 price: the 20/10 false rows — a total (المجموع) after the item is never the item's price", () => {
  assert.deepEqual(pm("تمام، أضفت *بطاطس محمرة* ✅ المجموع 58 ر.س.\nتوصيل ولا استلام؟"), [], "…9572 log 854 (row 138)");
  assert.deepEqual(pm("تمام، *بطاطس محمرة*. المجموع 39 ر.س. شي ثاني؟"), [], "…9082 log 904 (row 140)");
  assert.deepEqual(pm("تمام، أضفت *بيبسي زجاج* ✅ المجموع 85 ر.س، ولو توصيل يصير مجاني 🎁\nتوصيل ولا استلام؟"), [], "…9082 log 907 (row 143)");
  assert.deepEqual(pm("أضفت *دوريتوس* بـ 5 ر.س. المجموع 44 ر.س. شي ثاني؟"), [], "…9082 log 905: attached price is right, total ignored");
  assert.deepEqual(pm("أضفت *وجبة ميكس جريل* بـ 37 ر.س. المجموع 81 ر.س.\nتحب أضيف لك *بيبسي زجاج* بـ 4 ر.س؟"), [], "…9082 log 906: two attached prices, both right");
  assert.deepEqual(pm("*وجبة نصف دجاجة على الفحم* 28 ر.س + *بطاطس محمرة* 6 ر.س = 34 ر.س."), [], "…6102 log 842: each line price + the sum");
});

test("BF2 price: a wrong number attached to the item is still caught («*X* بـ N» · «X (N)» · «X: N» · «X N»)", () => {
  assert.deepEqual(pm("وجبة نصف دجاجة على الفحم بـ 30 ر.س").map((x) => [x.item, x.said]), [["وجبة نصف دجاجة على الفحم", 30]]);
  assert.deepEqual(pm("*بطاطس محمرة* (8 ر.س)").map((x) => x.said), [8]);
  assert.deepEqual(pm("بيبسي زجاج: 9 ريال").map((x) => x.said), [9]);
  assert.deepEqual(pm("*دوريتوس* ٧ ر.س").map((x) => x.said), [7], "Arabic digits");
  assert.deepEqual(pm("أضفت *دوريتوس* بـ 7 ر.س. المجموع 44 ر.س.").map((x) => x.said), [7], "the attached price is checked, the total is not");
  assert.deepEqual(pm("مشكل مخصوص بالوزن: نصف كيلو 70 ر.س").map((x) => x.said), [70], "a weight price that is not on the menu");
});

test("BF2 price: totals, delivery fees, minimums, coupon thresholds, quantities and weights are not item prices", () => {
  for (const t of [
    "المجموع مع بطاطس محمرة 58 ر.س",
    "الإجمالي: بطاطس محمرة 58 ر.س",
    "سلتك: بطاطس محمرة + بيبسي زجاج = 10 ر.س",
    "التوصيل 15 ر.س، وبطاطس محمرة جاهزة",
    "رسوم التوصيل لـ بطاطس محمرة 15 ر.س",
    "التوصيل مجاني للطلبات من 60 ر.س مع بطاطس محمرة",
    "الحد الأدنى بطاطس محمرة 30 ر.س",
    "كود FIRST يعطيك خصم على بطاطس محمرة 10 ر.س",
    "عرض بطاطس محمرة 4 ر.س بدل 6",
    "2 × بطاطس محمرة 12 ر.س",
    "*بطاطس محمرة* ×3 (18 ر.س)",
    "مشكل مخصوص بالوزن: نصف كيلو 78 ر.س",
    "أضفت ٢ كيلو مشكل مخصوص بالوزن بـ ٣١٠ ر.س",
    "بطاطس محمرة ✅ 58 ر.س",
    "*بطاطس محمرة* بطاطس طازجة، المجموع 58 ر.س",
  ]) assert.deepEqual(pm(t), [], t);
  assert.deepEqual(pm("بوكس العائلة مع بطاطس محمرة 179 ر.س", [{ name: "بوكس العائلة مع بطاطس محمرة", price: 179 }]), [], "the item inside a box name is the box");
});

test("BF2 cart evidence: the live promise guard's signal (build_cart ⇒ built, preview_cart ⇒ touched) from the turn log, or a /c/ link in the reply", () => {
  assert.deepEqual(L.cartEvidence([{ cart_code: null, tool_calls: [{ name: "preview_cart", result: { ok: true, subtotal: 58 } }] }], []), { cartBuilt: false, cartTouched: true }, "…9572 turn 479");
  assert.deepEqual(L.cartEvidence([{ cart_code: "k7p2q9x1", tool_calls: [] }], []), { cartBuilt: true, cartTouched: true });
  assert.deepEqual(L.cartEvidence([{ tool_calls: JSON.stringify([{ name: "build_cart", result: { ok: true } }]) }], []), { cartBuilt: true, cartTouched: true }, "tool_calls as JSON text");
  assert.deepEqual(L.cartEvidence([{ tool_calls: [{ name: "preview_cart", result: { ok: false, error: "item_unavailable" } }] }], []), { cartBuilt: false, cartTouched: false }, "a failed preview is not a cart");
  assert.deepEqual(L.cartEvidence([], [{ type: "interactive", interactive: { action: { parameters: { url: "https://order.o2m8.me/c/ab12cd34" } } } }]), { cartBuilt: true, cartTouched: true }, "no turn row (older reply) but the cart link was sent");
  assert.deepEqual(L.cartEvidence([], []), { cartBuilt: false, cartTouched: false });
});

/* إعادة ليلة ١٩/١٠ بالصفوف الحقيقية (الأرقام مقنّعة): ١٧ صف اتسجّلوا ⇒ ١٠ بس لازم يفضلوا */
test("BF2 self-review replay of 19/10: the 7 false rows are gone, every real detection stays", async () => {
  const P = { r9572: "500000051", r9082: "500000052", r2488: "500000053", r6102: "500000054", r5960: "500000055", r6823: "500000056", r5082: "500000057", old: "500000058", bare: "500000059" };
  const day = "2026-10-19", filed = [], turnsAsked = [];
  const rep = (t) => [{ type: "text", text: { body: t } }];
  const btn = (t) => [{ type: "interactive", interactive: { body: { text: t }, type: "button", action: { buttons: [{ type: "reply", reply: { id: "as:delivery", title: "توصيل" } }] } } }];
  const prev = (sub) => [{ name: "preview_cart", input: {}, result: { ok: true, subtotal: sub } }];
  const rows = [
    { id: 838, phone_norm: P.r2488, at: "2026-10-19T06:12:56Z", reply_key: "assist", replies: btn("تسلمين، الله يبارك فيك.\nللعلم، مقفلين الحين ونفتح اليوم الساعة 12 ظهراً، وأقدر أجهّز لك السلة من الحين وتكمّلين طلبك وقت ما نفتح.\nتبين نفس طلبك السابق: *تشيز فرايز* ومشكل مخصوص بالوزن؟") },
    { id: 842, phone_norm: P.r6102, at: "2026-10-19T07:36:42Z", reply_key: "assist", replies: btn("وعليكم السلام ورحمة الله 👋 مقفلين الحين، ونفتح اليوم الساعة 12 ظهراً، وأجهّز لك السلة من الحين تكملها وقت ما نفتح.\n\n*وجبة نصف دجاجة على الفحم* 28 ر.س + *بطاطس محمرة* 6 ر.س = 34 ر.س.\n\n⭐ كل 3 طلبات من الموقع لك توصيل مجاني، وباقي لك 2 على المكافأة.\nتوصيل ولا استلام؟") },
    { id: 854, phone_norm: P.r9572, at: "2026-10-19T12:54:03Z", reply_key: "assist", replies: btn("تمام، أضفت *بطاطس محمرة* ✅ المجموع 58 ر.س.\nتوصيل ولا استلام؟") },
    { id: 904, phone_norm: P.r9082, at: "2026-10-19T20:27:42Z", reply_key: "assist", replies: rep("تمام، *بطاطس محمرة*. المجموع 39 ر.س. شي ثاني؟") },
    { id: 905, phone_norm: P.r9082, at: "2026-10-19T20:27:52Z", reply_key: "assist", replies: rep("أضفت *دوريتوس* بـ 5 ر.س. المجموع 44 ر.س. شي ثاني؟") },
    { id: 906, phone_norm: P.r9082, at: "2026-10-19T20:28:17Z", reply_key: "assist", replies: btn("أضفت *وجبة ميكس جريل* بـ 37 ر.س. المجموع 81 ر.س.\nتحب أضيف لك *بيبسي زجاج* بـ 4 ر.س؟") },
    { id: 907, phone_norm: P.r9082, at: "2026-10-19T20:28:33Z", reply_key: "assist", replies: btn("تمام، أضفت *بيبسي زجاج* ✅ المجموع 85 ر.س، ولو توصيل يصير مجاني 🎁\nتوصيل ولا استلام؟") },
    /* قبل ما الحارس يتنشر (١٩/١٠ 20:34): مفيش صف أدوار، بس رابط السلة اتبعت ⇒ مش وعد مكسور */
    { id: 700, phone_norm: P.old, at: "2026-10-19T09:00:00Z", reply_key: "assist", replies: [{ type: "text", text: { body: "أضفت *بطاطس محمرة* لسلتك ✅ https://order.o2m8.me/c/ab12cd34" } }] },
    /* «أضفت» من غير أي دليل سلة (لا أداة ولا رابط) ⇒ لسه بيتمسك */
    { id: 701, phone_norm: P.bare, at: "2026-10-19T13:00:00Z", reply_key: "assist", replies: rep("أضفت كريب زنجر سوبريم لطلبك.") },
  ];
  const turns = [
    { log_id: 838, cart_code: null, tool_calls: null },
    { log_id: 842, cart_code: null, tool_calls: [{ name: "search_menu", result: { ok: true } }, { name: "search_menu", result: { ok: true } }, ...prev(34)] },
    { log_id: 854, cart_code: null, tool_calls: prev(58) },
    { log_id: 904, cart_code: null, tool_calls: prev(39) },
    { log_id: 905, cart_code: null, tool_calls: [{ name: "search_menu", result: { ok: true } }, ...prev(44)] },
    { log_id: 906, cart_code: null, tool_calls: prev(81) },
    { log_id: 907, cart_code: null, tool_calls: prev(85) },
    { log_id: 701, cart_code: null, tool_calls: [] },
  ];
  const q = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^INSERT INTO wa_bot_mistakes/.test(s)) { filed.push({ type: p[1], phone: p[3], example: p[4] }); return [{ inserted: true }]; }
    if (/^(INSERT|UPDATE|DELETE)/.test(s)) throw new Error("self-review must not write: " + s.slice(0, 40));
    if (/FROM wa_bot_guard_hits/.test(s)) return [];
    if (/\/\*sr:sales\*\//.test(s)) return [{ id: 909, phone_norm: P.r9082, at: "2026-10-19T20:48:54Z", reply_key: "lead_nudge", replies: rep("أنا معك 🙂 قل لي كم شخص أنتم، وأرشّح لك طلب جاهز بسعره وأجهّز سلتك.") }];
    if (/\/\*sr:claims\*\//.test(s)) return [{ id: 136, phone_norm: P.r5960, at: "2026-10-19T17:02:00Z", by_name: "موظف" }, { id: 138, phone_norm: P.r6823, at: "2026-10-19T18:10:00Z", by_name: "موظف" }];
    if (/\/\*sr:replies\*\//.test(s)) return rows;
    if (/\/\*sr:turns\*\//.test(s)) { turnsAsked.push(...p[0]); return turns.filter((t) => p[0].includes(Number(t.log_id))); }
    if (/\/\*sr:double\*\//.test(s)) return [{ id: 889, phone_norm: P.r5960 }, { id: 882, phone_norm: P.r5960 }, { id: 881, phone_norm: P.r5960 }, { id: 848, phone_norm: P.r5082 }, { id: 847, phone_norm: P.r5082 }];
    return [];
  };
  const learn = L.makeLearn({ q, jb: JSON.stringify, menuIndex: async () => MENU, bundles: async () => [], getSettings: async () => null });
  const r = await learn.runSelfReview(day, { max: 60 });
  const by = (type, ph) => filed.filter((f) => f.type === type && (!ph || f.phone === `…${ph.slice(-4)}`));

  assert.equal(by("wrong_price").length, 0, `no wrong_price (rows 138/140/143): ${JSON.stringify(by("wrong_price"))}`);
  assert.equal(by("broken_promise", P.r9572).length, 0, "…9572 «أضفت» with a priced cart (row 139)");
  assert.equal(by("broken_promise", P.r9082).length, 0, "…9082 «أضفت» ×3 with priced carts (rows 141/142/144)");
  assert.equal(by("broken_promise", P.old).length, 0, "pre-guard reply that carried the cart link");
  /* اللي لازم يفضل */
  assert.equal(by("broken_promise", P.r2488).length, 1, "…2488 closed-hours «أجهّز لك السلة من الحين», no cart at all (row 136)");
  assert.equal(by("broken_promise", P.r6102).length, 1, "…6102 closed-hours «أجهّز لك السلة من الحين»: priced but never saved (build_cart) (row 137)");
  assert.equal(by("broken_promise", P.bare).length, 1, "«أضفت» with no cart evidence is still a broken promise");
  assert.equal(by("sold_after_order", P.r9082).length, 1, "sold after an order (row 133)");
  assert.equal(by("staff_claim_silent").length, 2, "claimed, no written reply (rows 134/135)");
  assert.equal(by("double_reply").length, 5, "Majed + staff in the same minute (rows 145–149)");
  assert.equal(r.filed, 11); assert.equal(filed.length, 11);
  assert.ok(filed.every((f) => /^…\d{4}$/.test(f.phone)), "masked phones only");
  assert.deepEqual([...new Set(turnsAsked)].sort(), rows.map((x) => x.id).sort(), "turn evidence fetched once for every Majed reply");
});

test("BF2 schema: every BF1 setting has an Arabic label and Arabic help (verify «Arabic label + help on each»)", () => {
  const ar = (s) => /[؀-ۿ]/.test(String(s || ""));
  for (const [k, v] of Object.entries(L.LEARN_SCHEMA)) { assert.ok(ar(v.ar), `${k}: Arabic label`); assert.ok(ar(v.help), `${k}: Arabic help`); }
  assert.equal(Object.keys(L.LEARN_SCHEMA).length, 15);
});
