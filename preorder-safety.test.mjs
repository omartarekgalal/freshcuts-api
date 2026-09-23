/* الطلب المسبق — شبكة الأمان (node --test preorder-safety.test.mjs)

   الحادثة اللي الملف ده اتكتب بسببها (٢٢–٢٣ سبتمبر ٢٠٢٦، طلب W1790115558483):
   عميلة دفعت ٩٦ ريال الساعة ١:١٩ بالليل لموعد الخميس ١٢ الضهر. النتيجة:
     • مراقب المهل حسب عمر الطلب من ساعة ما دفعت، فبعت للمدير رسالتين
       (متأخر + تجاوز) الساعة ١:٥٥ الفجر لطلب موعده بعد ٣٤ ساعة، وسجّل
       مفاتيح الإنذار «اتبعت» فكان هيسكت في الموعد الحقيقي.
     • نفس الحساب كان هيوصل لـ«ما اتقبلش ⇒ استرجاع تلقائي» لو الكاشير
       ما قبلش في ٢٥ دقيقة — استرجاع لطلب أصلاً مش وقته.
     • شاشة المطبخ كانت هترمي التذكرة في نفس لحظة ظهورها (عمرها ٣٤ ساعة
       > staleMin)، وتوأمها في نقطة البيع كان بيتعرض كتذكرة عادية بالليل.

   كل اختبار هنا بيقفل واحدة منهم. الدوال صافية — مفيش قاعدة بيانات. */
import test from "node:test";
import assert from "node:assert/strict";
import { slaCheck, DEFAULT_SLA } from "./shop.js";
import { buildBoard, kitchenStartOf, DEFAULT_CONFIG } from "./kitchen-core.js";

/* ساعة الحادثة الحقيقية: اتطلب ٢٣/٩ ١:١٩ بالرياض، لموعد ٢٤/٩ ١٢:٠٠ بالرياض */
const PLACED = Date.parse("2026-09-22T22:19:19Z");   // ١:١٩ فجر الأربع (رياض)
const SLOT = Date.parse("2026-09-24T09:00:00Z");     // ١٢:٠٠ ضهر الخميس (رياض)
const iso = (t) => new Date(t).toISOString();
const MIN = 60_000;

const preorder = (extra = {}) => ({
  order_no: "W1790115558483", status: "accepted", option: "delivery",
  created_at: iso(PLACED), updated_at: iso(PLACED),
  scheduled_for: iso(SLOT), scheduled_slot: "2026-09-24#12:00-14:00",
  pos_order_id: "xEobRyEoNV", pos_ready_at: null, items: [{ name: "كفتة مشوية بالوزن", qty: 1 }],
  ...extra,
});

/* ═══ ١) مراقب المهل: الساعة بتبدأ من الموعد ═══════════════════════════ */

test("SLA: طلب مسبق ما لهوش أي مهل قبل موعده", () => {
  // الساعة ١:٥٥ الفجر — ٣٦ دقيقة من الدفع، و٣٤ ساعة قبل الموعد
  const at0155 = PLACED + 36 * MIN;
  assert.deepEqual(slaCheck(preorder(), {}, at0155), { level: 0, code: null, minutes: 0 });
  // نفس الطلب من غير موعد = الحادثة الأصلية بالظبط: الساعة ١:٥٥ الفجر
  // اتبعت handoff_breach (درجة ٢ ⇒ رسالة للمدير على جواله)
  const live = slaCheck({ ...preorder(), scheduled_for: null }, {}, at0155);
  assert.equal(live.code, "handoff_breach");
  assert.equal(live.level, 2);
});

test("SLA: نفس الطلب بيبقى تحت المراقبة عادي بعد ما ييجي موعده", () => {
  // ٢٥ دقيقة من بداية الشباك والكاشير ما دخّلوش لوحة التوصيل
  const v = slaCheck(preorder(), {}, SLOT + 25 * MIN);
  assert.equal(v.code, "handoff_breach");
  assert.equal(v.level, 2);
  assert.equal(v.minutes, 25, "الدقايق بتتعدّ من الموعد مش من الدفع");
});

/* ═══ ٢) الاسترجاع التلقائي ════════════════════════════════════════════ */

test("SLA: الطلب المسبق عمره ما يترد تلقائي لأنه ما اتقبلش", () => {
  const notAccepted = preorder({ status: "pos_created" });
  // ساعتين بعد الموعد ومحدش قبل — بني آدم يقرر، مش استرجاع
  const v = slaCheck(notAccepted, {}, SLOT + 120 * MIN);
  assert.equal(v.level, 2);
  assert.notEqual(v.action, "auto_refund");
  assert.equal(v.action, "accept_now");
  // وقبل الموعد مفيش أي حاجة خالص
  assert.equal(slaCheck(notAccepted, {}, PLACED + DEFAULT_SLA.autoRefundNoAcceptMinutes * MIN).level, 0);
  // الطلب العادي لسه بيترد زي ما هو (مابنكسرش السلوك القديم)
  const live = slaCheck({ ...notAccepted, scheduled_for: null }, {}, PLACED + 30 * MIN);
  assert.equal(live.action, "auto_refund");
  assert.equal(live.level, 3);
});

/* ═══ ٣) شاشة المطبخ ═══════════════════════════════════════════════════ */

test("المطبخ: ساعة التذكرة بتبدأ من الموعد مش من الدفع", () => {
  assert.equal(kitchenStartOf({ created_at: iso(PLACED), scheduled_for: iso(SLOT) }), iso(SLOT));
  assert.equal(kitchenStartOf({ created_at: iso(PLACED), scheduled_for: null }), iso(PLACED));
  // موعد في الماضي (طلب قديم اتصلّح يدوي) مابيرجّعش الساعة لورا
  assert.equal(kitchenStartOf({ created_at: iso(SLOT), scheduled_for: iso(PLACED) }), iso(SLOT));
});

test("المطبخ: التذكرة بتعيش في موعدها بدل ما staleMin ياكلها", () => {
  const row = { ...preorder(), status: "accepted", is_test: false };
  const at = SLOT + 5 * MIN;             // خمس دقايق من بداية الشباك
  const board = buildBoard({ shopRows: [row], now: at });
  assert.equal(board.length, 1, "التذكرة لازم تكون على الشاشة في موعدها");
  assert.equal(board[0].key, "shop:W1790115558483");
  assert.equal(board[0].createdAt, iso(SLOT));
  assert.equal(board[0].placedAt, iso(PLACED), "ساعة الدفع محفوظة للمرجع");
  assert.equal(board[0].flags.slot.key, "2026-09-24#12:00-14:00");
  // قبل الإصلاح: العمر ٣٤ ساعة > staleMin ⇒ كانت بتتشال
  assert.ok((at - PLACED) / MIN > DEFAULT_CONFIG.staleMin);
});

test("المطبخ: توأم نقطة البيع لطلب مسبق لسه بدري مايتعرضش كتذكرة عادية", () => {
  const row = { ...preorder(), status: "accepted" };
  const tsTwin = [{
    order: {
      id: "xEobRyEoNV", order_type_name: "external", order_option_id: "o_del",
      orders_external: { source: "FreshCuts", source_channel: "freshcuts_online", approval_status: "accepted" },
      created_at: new Date(PLACED).toISOString().replace("T", " ").slice(0, 19),
      receipt: { number: 4100 }, purchases: [{ name: "كفتة مشوية بالوزن", quantity: 1, modifiers: [] }],
      meta: {}, tables: [],
    },
    slugs: { approval_status: "accepted" },
    firstSeenAt: iso(PLACED), lastAt: iso(PLACED + MIN),
  }];
  const at = PLACED + 40 * MIN;          // بالليل، الموعد لسه بعد ٣٤ ساعة
  // كده بينده kitchen.js: shopRows اتفلتر (لسه مجاش وقته)، والدمج شايف الكل
  const fixed = buildBoard({ tsOrders: tsTwin, shopRows: [], allShopRows: [row], now: at });
  assert.deepEqual(fixed.map((o) => o.key), [], "مفيش أي تذكرة بالليل");
  // من غير allShopRows (السلوك القديم): توأم نقطة البيع بيتسرّب على الشاشة
  const broken = buildBoard({ tsOrders: tsTwin, shopRows: [], now: at });
  assert.deepEqual(broken.map((o) => o.key), ["ts:xEobRyEoNV"]);
  assert.equal(broken[0].flags.slot, undefined, "ومن غير شارة 📅 — الطباخ مش هيعرف");
});
