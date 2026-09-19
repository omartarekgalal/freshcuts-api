/* ═══════════════════════════════════════════════════════════════════════════
   «الجاهزية» (#store/grow/ready) — مهام المالك بالأدوار + تقويم المواسم

   GET  /api/social/ready                 → الأدوار (مهام متكررة بحالتها) + التقويم
   POST /api/social/ready/task/:id        {status, note}   حالة مهمة للفترة الحالية
   POST /api/social/ready/cal/:id         {status, note}   حالة مناسبة في التقويم

   ليه اتعمل من جديد (١٩ سبتمبر): الشاشة القديمة اتكتبت في أغسطس قبل المتجر —
   كانت بتقول «المطعم ماعندهوش توصيل خاص» وبتبيع عروض خلصت ١٤/٩. دلوقتي فيه
   متجر freshcuts.sa (توصيل + استلام، عرض ٩٦ كيلو/بوكس، FIRST لأول طلب، SMS،
   إعلانات ميتا وسناب شغّالة)، فالشغل المتكرر اتقسم على ٣ أدوار:
     🎬 المحتوى · 📣 الإعلانات · 🏪 التشغيل
   كل مهمة ليها تكرار (يومي/أسبوعي) وحالتها بتتحفظ **للفترة الحالية** بس —
   بكرة المهمة اليومية بترجع «لسه» لوحدها من غير كرون.

   التخزين: نفس جدول social_profile_state (id → status/current/note) اللي
   بنود الصفحات بتستعمله — مفتاح `rd:<مهمة>:<فترة>` و`rdcal:<مناسبة>:<تاريخ>`.
   مفيش جدول جديد.

   ⚠️ زي باقي الصفحة: **مفيش أي نشر ولا جدولة ولا تعديل إعلان من هنا.** المهمة
   بتقول تعمل إيه وفين (رابط للشاشة الصح)، والحالة صف في جدول وبس.

   التواريخ: عرض ٩٦ بيتقري من سجل العروض الحي (OFFERS ← offer_registry) مش
   مكتوب هنا. التواريخ الهجرية (رمضان/العيد) تقريبية ومتعلّمة approx.
═══════════════════════════════════════════════════════════════════════════ */
import { OFFERS, offerState, riyadhDay as bizDayOf } from "./offers.js";
import { cachedSnapshot } from "./growthnow.js";

const DAY = 86400_000;
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const diff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0=الأحد … 6=السبت

/* الأسبوع بيبدأ السبت (بعد ويك إند الخميس/الجمعة) — مفتاحه تاريخ السبت. */
export function weekKey(day) { return shift(day, -((dowOf(day) + 1) % 7)); }
export function periodKey(freq, day) { return freq === "weekly" ? `w${weekKey(day)}` : `d${day}`; }

/* أقرب يوم بالـdow ده من النهارده (النهارده نفسه لو هو) */
export function nextDow(day, dow) { return shift(day, (dow - dowOf(day) + 7) % 7); }
/* أقرب ٢٧ في الشهر (النهارده لو هو ٢٧) */
export function nextPayday(day) {
  const [y, m, d] = day.split("-").map(Number);
  if (d <= 27) return `${y}-${String(m).padStart(2, "0")}-27`;
  const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}-27`;
}

/* ═══ ١) مهام الأدوار ═════════════════════════════════════════════════════
   go = [مجموعة، شاشة] في #store. auto = مفتاح إشارة لحظية من growthnow. */
export const ROLES = [
  {
    id: "content", icon: "🎬", label: "المحتوى",
    who: "اللي ماسك السوشال (النشر على انستجرام وفيسبوك أوتوماتيك من الطابور؛ تيك توك وسناب يدوي)",
    tasks: [
      { id: "c_queue24", freq: "daily", title: "الطابور فيه بوست أو ستوري للـ٢٤ ساعة الجاية", how: "افتح طابور النشر. لو فاضي حط بوست من الرف (صور حقيقية بس).", go: ["grow", "queue"], auto: "queue24" },
      { id: "c_queue_failed", freq: "daily", title: "مفيش بوست فاشل في الطابور", how: "البوست الفاشل بعد آخر محاولة مابيتعادش لوحده — افتح الخطأ وصلّحه.", go: ["grow", "queue"], auto: "queueFailed" },
      { id: "c_story_peak", freq: "daily", title: "ستوري وقت الذروة (٧–١٠م): «مفتوحين — اطلب من freshcuts.sa»", how: "لقطة حقيقية من الفحم أو التغليف + ستيكر رابط freshcuts.sa. العرض بالاسم والسعر بس — من غير «وفّر/خصم/٪»." },
      { id: "c_reply", freq: "daily", title: "الرد على الكومنتات والرسايل في أقل من ساعة", how: "أي حد بيسأل «توصلون؟» أو «بكم؟» ← رابط freshcuts.sa (توصيل واستلام، وFIRST = توصيل ببلاش لأول طلب من الموقع)." },
      { id: "c_shelf", freq: "daily", title: "لقطة خام واحدة للرف", how: "فحم شغّال · سحبة جبنة · وزن الكيلو · شنطة البوكس بالستيكر (البوكس أصناف منفصلة في شنطة — مش علبة مقفولة)." },
      { id: "c_reels", freq: "weekly", title: "٢ ريلز في الأسبوع من الرف", how: "صور وفيديو حقيقي بس — عمر رفض فيديوهات الذكاء الاصطناعي (١٨/٩). صور الأكل بالذكاء الاصطناعي مسموحة للمود بس ومن غير سعر/نص." },
      { id: "c_ugc", freq: "weekly", title: "فيديو رأي عميل حقيقي (UGC)", how: "اطلب من عميل مبسوط في الصالة ١٥ ثانية. ده الكرياتيف الجاي للإعلانات." },
      { id: "c_manual", freq: "weekly", title: "تيك توك وسناب: نزّل الباكدجات الجاهزة يدوياً", how: "مفيش API نشر للمنصتين — الكابشن والهاشتاجات جاهزين في تبويب التريندات/المحتوى." },
      { id: "c_pages", freq: "weekly", title: "الصفحات الأربعة: الرابط freshcuts.sa والمواعيد والتوصيل صح", how: "تبويب «الصفحات» تحت — أي رابط تاني بيعمل تحويل ويرفض إعلانات." },
      { id: "c_trends", freq: "weekly", title: "راجع بنك التريندات", how: "أي تريند عمره أكتر من ١٤ يوم = عدّى — خُد القالب بس من غير الصوت." },
    ],
  },
  {
    id: "ads", icon: "📣", label: "الإعلانات",
    who: "اللي ماسك ميتا وسناب (الحارس على السيرفر بيقفل ويفتح لوحده — المهام دي مراجعة وقرار)",
    tasks: [
      { id: "a_report", freq: "daily", title: "اقرا تقرير الدخل اليومي (SMS الساعة ٣:٤٠ الفجر)", how: "القاعدة: الصرف ≈ ٢٥–٣٠٪ من الدخل، وتكلفة طلب الموقع ≤ ٦٠. التوصية (كبّر/ثبّت/قلّل) مكتوبة في التقرير.", go: ["overview", "daily"], auto: "reportFresh" },
      { id: "a_guard", freq: "daily", title: "الحارس شغّال", how: "بيفتح ١٢:٣٠ ويقفل ١:٣٠ (الخميس والجمعة ٢:٣٠)، سقف ٣٬٠٠٠/يوم، وبيبعت تنبيهات الصحة لجوال عمر (إعلان مرفوض، صرف واقف، Learning Limited).", go: ["overview", "daily"], auto: "guardFresh" },
      { id: "a_health", freq: "daily", title: "مفيش إعلان مرفوض أو مجموعة من غير إعلانات شغّالة", how: "لو جالك SMS «health» من الحارس — افتح مدير الإعلانات وصلّح نفس اليوم.", go: ["grow", "ads"] },
      { id: "a_whatsapp", freq: "daily", title: "إعلان الواتساب: عدد المحادثات + «من وين عرفتنا؟» عند الكاشير", how: "الواتساب بيجيب عملاء للصالة مابيتتبعوش أونلاين (قرار عمر) — ماتحكمش عليه بطلبات الموقع." },
      { id: "a_approvals", freq: "daily", title: "اقتراحات الطيار الآلي وطلبات الموافقة", how: "الطيار في وضع «اقتراح» — مابينفّذ حاجة من غير موافقة.", go: ["grow", "ads"], auto: "approvals" },
      { id: "a_rotate", freq: "weekly", title: "دوّر الكرياتيف", how: "أي إعلان التكرار عنده فوق ٣ أو الـCTR نازل ← بدّله بصورة حقيقية جديدة. ممنوع «وفّر/خصم/٪» وممنوع أي ادعاء عن الستيك." },
      { id: "a_budget", freq: "weekly", title: "قرار الميزانية الأسبوعي", how: "CPA ≤ ٦٠ والدخل طالع ← كبّر ٢٥٪ (لحد ٣٬٠٠٠/يوم). غير كده ← ثبّت أو قلّل لأحسن إعلانين. التركيز الخميس/الجمعة/السبت.", go: ["overview", "daily"] },
      { id: "a_retarget", freq: "weekly", title: "الريتارجت شغّال", how: "حملة FC-RT-WEB-96 (زوار الموقع والسلات المتروكة) + جماهير العملاء متزامنة. أغلب السلات المتروكة مالهاش جوال — الريتارجت هو اللي بيرجّعهم.", go: ["grow", "ads"] },
      { id: "a_links", freq: "weekly", title: "كل إعلان على رابط حملة", how: "freshcuts.sa/l/<slug> بـUTM — روابط التوصيل عليها FIRST، وكل عرض له رابطه.", go: ["grow", "links"] },
    ],
  },
  {
    id: "ops", icon: "🏪", label: "التشغيل",
    who: "المدير والكاشير (البورتال) — التشغيل الجاهز هو اللي بيخلّي الإعلان يتحوّل لطلب",
    tasks: [
      { id: "o_soldout", freq: "daily", title: "راجع الأصناف المقفولة «خلص»", how: "من البورتال ← تبويب الأصناف. الصنف اللي رجع افتحه — العميل بيشوفه «خلص» في المتجر.", go: ["ops", "portal"], auto: "soldOut" },
      { id: "o_peak_prep", freq: "daily", title: "تحضير الذروة قبل ٧م", how: "فحم، مشاوي متبّلة للكيلو (كفتة/طرب/شيش/صدور)، الأرز الهدية، خبز وسلطة وطحينة، شنط وستيكرات البوكس." },
      { id: "o_ready", freq: "daily", title: "«جاهز» في البورتال أول ما الطلب يخلص", how: "الضغطة دي هي اللي بتطلب المندوب (أو بعد مهلة ١٥ دقيقة). تأخيرها = تأخير التوصيل.", go: ["ops", "monitor"] },
      { id: "o_courier", freq: "daily", title: "المندوب وشركة التوصيل شغّالين", how: "تكلفة المندوب ~٢٠ ر.س من أول كيلو — عشان كده مفيش توصيل ببلاش على السلة الصغيرة (FIRST لأول طلب بس).", go: ["ops", "monitor"] },
      { id: "o_hours", freq: "weekly", title: "المواعيد في المتجر = الواقع", how: "١٢م–٢ف، والخميس والجمعة لين ٣ف. أي قفل استثنائي يتسجّل قبلها عشان «نبّهني لما تفتحوا» يشتغل.", go: ["menu", "storefront"] },
      { id: "o_weekend_stock", freq: "weekly", title: "مخزون الويك إند (الأربعاء)", how: "لحم الكيلو ومكونات البوكس (بيتزا/باستا/كريب/حواوشي + بطاطس وكولسلو هدية) وشنط وستيكرات تكفّي خميس–سبت." },
      { id: "o_reviews", freq: "weekly", title: "الرد على التقييمات ١–٣★", how: "صندوق التقييمات — الرد خلال يوم.", go: ["grow", "reviews"] },
      { id: "o_optouts", freq: "weekly", title: "«مش عايز رسايل» في البورتال", how: "راجع اللي اتسجّلوا — الرجوع للاشتراك بموافقة العميل بس.", go: ["customers", "optouts"] },
    ],
  },
];
const TASKS = Object.fromEntries(ROLES.flatMap((r) => r.tasks.map((t) => [t.id, { ...t, role: r.id }])));
export const TASK_STATUS = ["todo", "done", "skip"];

/* إشارات لحظية من لقطة growthnow → { ok, note }. ok=null = مش معروف. */
export function autoSignals(s, today) {
  if (!s) return {};
  const ar = (n) => Math.round(Number(n) || 0).toLocaleString("ar-SA");
  const out = {};
  if (s.content) {
    out.queue24 = s.content.next24 == null ? { ok: null, note: "مش قادر أقرا الطابور" }
      : { ok: s.content.next24 > 0, note: `${ar(s.content.next24)} مجدول في الـ٢٤ ساعة الجاية` };
    out.queueFailed = { ok: !s.content.failed, note: s.content.failed ? `${ar(s.content.failed)} فاشل` : "مفيش فاشل" };
  }
  const g = s.ads?.guard;
  if (g) out.guardFresh = { ok: !g.stale, note: g.ageMin == null ? "مفيش دورة متسجّلة" : `آخر دورة من ${ar(g.ageMin)} دقيقة` };
  const rep = s.ads?.lastReport;
  if (rep) {
    const yday = shift(today, -1);
    out.reportFresh = { ok: rep.day >= yday, note: `آخر تقرير ${rep.day}${rep.rec?.ar ? ` — ${rep.rec.ar}` : ""}` };
  }
  if (s.approvals) {
    const n = (s.approvals.hub || 0) + (s.approvals.autopilot || 0);
    out.approvals = { ok: n === 0, note: n ? `${ar(n)} مستني قرار` : "مفيش حاجة مستنية" };
  }
  if (Array.isArray(s.soldOut)) {
    const old = s.soldOut.filter((x) => !x.until && (x.hoursAgo || 0) >= 12);
    out.soldOut = { ok: old.length === 0, note: s.soldOut.length ? `مقفول: ${s.soldOut.map((x) => x.name || x.id).slice(0, 3).join("، ")}` : "مفيش أصناف مقفولة" };
  }
  return out;
}

/* ═══ ٢) التقويم ═════════════════════════════════════════════════════════
   كل مناسبة: content/ads/ops = اللي يتعمل، lead = نبدأ قبلها بكام يوم.
   approx = التاريخ تقريبي (هجري/طقس). check = لازم حد يتأكد من المصدر. */
function nd96Window(now) {
  const nd = OFFERS.filter((o) => /^nd96/.test(o.id)).map((o) => ({ o, st: offerState(o, now) }))
    .filter((x) => x.st.status === "live" || x.st.status === "upcoming");
  if (!nd.length) return null;
  const until = nd.map((x) => x.o.until).filter(Boolean).sort().pop();
  return { until, provisional: nd.some((x) => x.o.untilProvisional), titles: nd.map((x) => `${x.o.title} (${x.o.price ?? 96} ر.س)`) };
}

export function buildCalendar(today, now = new Date()) {
  const nd = nd96Window(now);
  const thu = nextDow(today, 4);
  const pay = nextPayday(today);
  const payDow = dowOf(pay);
  const list = [
    { id: "ads_review", name: "مراجعة الإعلانات — قرار «كمّل لحد الاتنين»", date: "2026-09-21", lead: 1, tag: "إعلانات",
      ads: ["تكلفة طلب الموقع ≤ ٦٠ والدخل طالع ← كبّر ٢٥٪", "غير كده ← قلّل لحوالي ٤٥٠/يوم على أحسن إعلانين", "الواتساب يتقيّم بالمحادثات وسؤال الكاشير مش بطلبات الموقع"],
      content: ["جهّز ٢ كرياتيف بديل (صور حقيقية) لو هنكبّر"], ops: [] },
    { id: "snap_test", name: "نهاية تجربة سناب", date: "2026-09-22", lead: 1, tag: "إعلانات",
      ads: ["قيّم: طلبات الموقع المنسوبة لسناب ÷ صرفه (الحساب بالدولار ×٣٫٧٥)", "كمّل أو اقفل على مستوى الحملة — سناب بيرفض تعديل الـsquad"], content: [], ops: [] },
    { id: "nd96", name: "اليوم الوطني السعودي ٩٦", date: "2026-09-23", lead: 7, tag: "مناسبة",
      content: ["ستوري ليلة ٢٢ + بوست صباح ٢٣ بالهوية الرسمية (دليل GEA — ٩٦ نفس هوية ٩٥)",
        `العرض: ${nd ? nd.titles.join(" · ") : "كيلو ٩٦ وبوكس ٩٦"} — الكيلو معاه أرز هدية، البوكس معاه بطاطس وكولسلو هدية`,
        "ممنوع «وفّر/خصم/٪» — السعر والمحتوى بس"],
      ads: ["زوّد حملة الشراء ٢٢–٢٣/٩ لو تكلفة الطلب تمام (السقف ٣٬٠٠٠/يوم)", "روابط /l/ لكل عرض عليها FIRST للتوصيل"],
      ops: ["ضاعف تحضير الكيلو (كفتة/طرب/شيش/صدور) والأرز", "شنط وستيكرات البوكس", "طاقم إضافي ٧م–٢ف", "بلّغ شركة التوصيل بضغط الليلة"] },
    ...(nd && nd.until ? [{
      id: "nd96_end", name: "آخر يوم عرض ٩٦", date: nd.until, lead: 7, tag: "عرض", approx: nd.provisional,
      approxNote: nd.provisional ? "تاريخ النهاية لسه مؤقت في سجل العروض — ثبّته أو غيّره من «العروض والباقات»" : "",
      content: ["«آخر أيام» ستوري قبلها بـ٣ أيام", "موجة SMS «آخر أيام» مجدولة ٢٨/٩"],
      ads: [`وقّف كرياتيف ٩٦ بعد ${nd.until}`, "جهّز إعلانات العرض اللي بعده قبلها بـ٣ أيام"],
      ops: ["قرار عمر: العرض اللي بعده (أو تمديد)", "رجّع أسعار الكيلو الأصلية في نقطة البيع يدوياً — تاريخ النهاية مابيرجّعهاش"],
    }] : []),
    { id: "weekend", name: "الويك إند (الخميس/الجمعة/السبت) — الذروة", date: thu, lead: 2, tag: "متكرر", recurring: "كل أسبوع",
      content: ["بوست «مفتوحين لين ٣ الفجر» الخميس بعد ١١م", "ستوري لمّات/عزومة (الكيلو والبوكس)"],
      ads: ["الحارس بيمد لحد ٢:٣٠ الخميس والجمعة لوحده", "قرار ميزانية الويك إند يوم الأربعاء"],
      ops: ["جدول طاقم خميس–سبت", "مخزون مضاعف (لحم الكيلو + مكونات البوكس + شنط)"] },
    { id: "payday", name: "نزول الرواتب (٢٧ من الشهر)", date: pay, lead: 3, tag: "متكرر", recurring: "كل شهر", approx: payDow === 5 || payDow === 6,
      approxNote: payDow === 5 || payDow === 6 ? "٢٧ واقع ويك إند — غالباً الراتب بينزل آخر يوم عمل قبله" : "",
      content: ["محتوى لمّات وعزومة (الكيلو والبوكس) من يوم ٢٧"],
      ads: ["كبّر ٢٠–٣٠٪ من ٢٧ لحد أول ويك إند بعده لو تكلفة الطلب ≤ ٦٠"],
      ops: ["توقّع سلات أكبر — كميات الكيلو زيادة"] },
    { id: "heat", name: "حر جدة — ذروة التوصيل بالليل", date: null, lead: 0, tag: "طقس", recurring: "لحد أواخر أكتوبر تقريباً", approx: true,
      content: ["«خليك في التكييف — اطلب من freshcuts.sa» توصيل أو استلام"],
      ads: ["ركّز الصرف ٨م–١ص (الحارس بيقفل برّه ساعات الفتح)"],
      ops: ["مناديب كفاية بالليل", "تغليف يحافظ على السخونة"] },
    { id: "teacher", name: "اليوم العالمي للمعلم", date: "2026-10-05", lead: 7, tag: "مناسبة",
      content: ["بوست تقدير بسيط — من غير عرض"], ads: [], ops: [] },
    { id: "cool", name: "اعتدال الجو — موسم الجلسات برّه والكشتات", date: "2026-11-01", lead: 14, tag: "طقس", approx: true,
      approxNote: "راقب الجو: أول أسبوع الحرارة تنزل تحت ٣٢ بالليل = ابدأ",
      content: ["«مشاوي بالوزن للكشتة» — الطلب بالكيلو من المتجر استلام"],
      ads: ["زوّد إعلانات الاستلام والصالة، ووسّع النطاق شوية لمناطق الكشتات"],
      ops: ["تجهيز الجلسات الخارجية", "تغليف للكميات الكبيرة"] },
    { id: "white_friday", name: "الجمعة البيضاء — موسم التسوّق أونلاين", date: "2026-11-27", lead: 14, tag: "متجر",
      content: ["باقة للمتجر بس (اسمها «باقة» — من غير كلمة خصم)"],
      ads: ["حملة شراء للمتجر — المنافسة على الإعلانات بتغلى الأسبوع ده، ابدأ بدري"],
      ops: ["اختبر الدفع والـOTP تحت ضغط قبلها"] },
    { id: "school_term", name: "اختبارات وإجازة نهاية الفصل الأول", date: "2027-01-01", lead: 14, tag: "دراسة", approx: true, check: true,
      approxNote: "راجع تقويم وزارة التعليم ١٤٤٨ — التاريخ هنا تقريبي",
      content: ["«مذاكرة بالليل؟ مفتوحين لين ٢»"], ads: ["إعلانات متأخرة بالليل للطلاب"], ops: ["طاقم ليلي في أسبوع الاختبارات"] },
    { id: "ramadan", name: "رمضان ١٤٤٨", date: "2027-02-08", lead: 45, tag: "موسم", approx: true,
      approxNote: "بالرؤية — ممكن يتحرّك يوم",
      content: ["محتوى إفطار وسحور — إحنا مفتوحين متأخر (أقوى ورقة)", "صواني العزايم"],
      ads: ["الإعلانات من بعد العصر لحد السحور — جدول الحارس لازم يتغيّر"],
      ops: ["مواعيد رمضان على المتجر وجوجل والتطبيقات قبلها بأسبوع", "منيو إفطار/سحور", "طاقم وردية السحور"] },
    { id: "founding", name: "يوم التأسيس", date: "2027-02-22", lead: 21, tag: "مناسبة",
      approxNote: "بيقع جوّه رمضان تقريباً — راجع التداخل",
      content: ["هوية التأسيس (بنّي/تاريخي) — مختلفة عن اليوم الوطني"], ads: ["حملة قصيرة لو فيه عرض"], ops: [] },
    { id: "eid_fitr", name: "عيد الفطر ١٤٤٨", date: "2027-03-10", lead: 30, tag: "موسم", approx: true, approxNote: "بالرؤية — تقريبي",
      content: ["عزايم العيد — الكيلو والصواني"], ads: ["زوّد من آخر ٣ أيام رمضان"],
      ops: ["مواعيد أيام العيد على كل المنصات قبلها بأسبوع", "مخزون مضاعف"] },
    { id: "eid_adha", name: "عيد الأضحى ١٤٤٨", date: "2027-05-17", lead: 21, tag: "موسم", approx: true, approxNote: "بالرؤية — تقريبي",
      content: ["لمّات العيد"], ads: ["حملة أيام العيد"], ops: ["مواعيد العيد + طاقم"] },
    { id: "football", name: "مباريات الدوري السعودي والمنتخب", date: null, lead: 2, tag: "رياضة", recurring: "كل أسبوع", check: true,
      approxNote: "مفيش جدول مباريات هنا — شيّك جدول الأسبوع كل سبت",
      content: ["بوست «طلبات الشلّة قبل الماتش» (بيتزا/أطباق جماعية)"],
      ads: ["إعلان قبل الماتش بساعتين في نطاق ٨ كم"], ops: ["جهّز البيتزا والأطباق الجماعية قبل الماتش"] },
  ];
  return list.map((o) => {
    const daysLeft = o.date ? diff(today, o.date) : null;
    const startBy = o.date ? shift(o.date, -(o.lead || 0)) : null;
    const startNow = !!(startBy && diff(today, startBy) <= 0 && daysLeft >= 0);
    return { ...o, daysLeft, startBy, startNow, passed: daysLeft !== null && daysLeft < 0 };
  }).sort((a, b) => (a.date || "9999") < (b.date || "9999") ? -1 : 1);
}
export const CAL_STATUS = ["todo", "doing", "done", "skip"];

/* ═══ المسارات ═════════════════════════════════════════════════════════ */
export function register(app, ctx) {
  const { pool, requireAdmin } = ctx;
  const save = (id, status, note) => pool.query(
    `INSERT INTO social_profile_state (id, status, note, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, updated_at=NOW()`,
    [id, status, String(note || "").slice(0, 300)]);

  app.get("/api/social/ready", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const now = new Date();
    const today = bizDayOf(now);
    const snap = await cachedSnapshot(ctx).catch(() => null);
    const sig = autoSignals(snap, today);
    const rows = (await pool.query(
      `SELECT id, status, note, updated_at FROM social_profile_state WHERE id LIKE 'rd:%' OR id LIKE 'rdcal:%'`)).rows;
    const st = Object.fromEntries(rows.map((r) => [r.id, r]));
    const roles = ROLES.map((r) => {
      const tasks = r.tasks.map((t) => {
        const key = `rd:${t.id}:${periodKey(t.freq, today)}`;
        const row = st[key];
        return { ...t, status: row?.status || "todo", note: row?.note || "", doneAt: row?.updated_at || null, auto: t.auto ? sig[t.auto] || null : null };
      });
      const open = tasks.filter((t) => t.status === "todo");
      return { ...r, tasks, totals: { all: tasks.length, done: tasks.filter((t) => t.status === "done").length, open: open.length,
        flagged: tasks.filter((t) => t.status === "todo" && t.auto && t.auto.ok === false).length } };
    });
    const calendar = buildCalendar(today, now).map((o) => {
      const row = st[`rdcal:${o.id}:${o.date || periodKey("weekly", today)}`];
      return { ...o, status: row?.status || "todo", note: row?.note || "" };
    });
    const nd = nd96Window(now);
    return c.json({
      ok: true, today, week: weekKey(today),
      store: {
        site: "freshcuts.sa", modes: ["توصيل", "استلام"],
        offers: OFFERS.map((o) => ({ id: o.id, title: o.title, price: o.price ?? null, until: o.until, provisional: !!o.untilProvisional, status: offerState(o, now).status }))
          .filter((o) => o.status === "live" || o.status === "upcoming"),
        nd96Until: nd?.until || null,
        facts: [
          "المتجر freshcuts.sa: توصيل من المطعم + استلام، دفع أونلاين (مدى/أبل باي)",
          "FIRST = توصيل ببلاش لأول طلب من الموقع (بيتحط لوحده على روابط الإعلانات)",
          "إعلانات ميتا (شراء + ريتارجت + واتساب) وسناب شغّالة بحارس على السيرفر",
          "رسايل SMS تسويقية شغّالة (موجات ٩٦) + استرداد السلات المتروكة",
        ],
        dailyTarget: snap?.target?.daily || 200, onlineToday: snap?.online?.today ?? null,
      },
      roles, calendar,
      publishing: { any: false, why: "مهام ومراجعة — مفيش نشر ولا جدولة ولا تعديل إعلانات من هنا" },
    });
  });

  app.post("/api/social/ready/task/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const t = TASKS[c.req.param("id")];
    if (!t) return c.json({ ok: false, error: "not_found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    if (!TASK_STATUS.includes(b.status)) return c.json({ ok: false, error: "bad status", message: `الحالة: ${TASK_STATUS.join(" · ")}` }, 400);
    const key = `rd:${t.id}:${periodKey(t.freq, bizDayOf(new Date()))}`;
    await save(key, b.status, b.note);
    return c.json({ ok: true, id: t.id, period: key.split(":")[2], status: b.status, published: false });
  });

  app.post("/api/social/ready/cal/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const today = bizDayOf(new Date());
    const o = buildCalendar(today).find((x) => x.id === c.req.param("id"));
    if (!o) return c.json({ ok: false, error: "not_found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    if (!CAL_STATUS.includes(b.status)) return c.json({ ok: false, error: "bad status", message: `الحالة: ${CAL_STATUS.join(" · ")}` }, 400);
    await save(`rdcal:${o.id}:${o.date || periodKey("weekly", today)}`, b.status, b.note);
    return c.json({ ok: true, id: o.id, status: b.status, published: false });
  });
  console.log("[readiness] routes ready");
}
