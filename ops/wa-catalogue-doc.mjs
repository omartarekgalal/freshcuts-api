/* يولّد docs/whatsapp-catalogue.md من watemplates.js + wabot.js + لقطة الاختبار.
   التشغيل: node ops/wa-catalogue-doc.mjs   (بدون شبكة ولا قاعدة) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "../watemplates.js";
import * as B from "../wabot.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = JSON.parse(fs.readFileSync(path.join(root, "fixtures/wabot-context.json"), "utf8"));
const MENU = B.indexMenu(FX.pages);
const at = (iso) => new Date(Date.parse(iso + "+03:00"));
const OPEN = at("2026-09-28T20:00:00"), CLOSED = at("2026-09-28T05:00:00");
const ORDER = { order_no: "W1790012345678", status: "accepted", option: "delivery", total: 86.5,
  created_at: new Date(OPEN.getTime() - 20 * 60000).toISOString(), active: true, label: "المطعم بيجهّز طلبك 👨‍🍳" };
const ctx = (o = {}) => ({ settings: FX.settings, menu: MENU, policy: FX.policy, coupons: FX.coupons, offers: FX.offers,
  order: null, orderHistory: { paid: 0 }, now: OPEN, ...o });

const out = [];
const w = (s = "") => out.push(s);
const q = (s) => String(s).split("\n").map((l) => `> ${l}`).join("\n");
const S = T.summary();

w("# كتالوج واتساب — فريش كاتس");
w();
w("> ملف مولَّد تلقائياً من `watemplates.js` و`wabot.js` (`node ops/wa-catalogue-doc.mjs`). لا تعدّله باليد — عدّل الكود وأعد التوليد.");
w("> الأسعار والعروض في الأمثلة من لقطة ٢٨/٩/٢٠٢٦؛ البوت الحقيقي يقرا المنيو والإعدادات الحية وقت الرد.");
w();
w("## الملخص");
w();
w(`- **القوالب:** ${S.total} (${S.names} اسم) — UTILITY ${S.byCategory.UTILITY} · MARKETING ${S.byCategory.MARKETING} · AUTHENTICATION ${S.byCategory.AUTHENTICATION || 0}`);
w(`- حسب القسم: ${Object.entries(S.byGroup).map(([g, n]) => `${T.GROUPS[g]} ${n}`).join(" · ")}`);
w(`- تحتاج رفع صورة قبل التقديم: ${S.needsUpload.map((x) => `\`${x}\``).join("، ")}`);
w(`- **نوايا البوت:** ${B.INTENTS.length} · عبارات الاختبار: ${B.INTENTS.reduce((a, i) => a + i.examples.length, 0)} مثال + عبارات صعبة في \`wabot.test.mjs\``);
w();
w("## أول ٨ قوالب نقدّمها لميتا");
w();
T.RECOMMENDED_FIRST.forEach((n, i) => {
  const t = T.findTemplate(n, n.startsWith("fc_staff") ? "en" : "ar");
  w(`${i + 1}. \`${n}\` (${t.category}) — ${t.meta.purpose}`);
});
w();
w("## قرارات ومعلومات ناقصة تحتاج عمر");
w();
w("البوت ما يخترع: أي معلومة من دول ناقصة ⇒ يقول «أتأكد لك من الفريق» ويحوّل. تنكتب في `settings.waBot.facts.<key>` (نص، أو `{ar, en}`):");
w();
w("| المفتاح | السؤال | الحالة |");
w("|---|---|---|");
for (const [k, qq] of [["parking", "فيه مواقف؟ وين؟"], ["dineIn", "فيه جلسات داخلية؟ كم تقريباً؟"], ["familySection", "فيه قسم عوائل؟"],
  ["halal", "صياغة «كل اللحوم والدجاج حلال» (مورد/شهادة)"], ["allergens", "المكسرات/السمسم/البيض/الألبان — وش نقول؟"],
  ["gluten", "فيه خيار بدون جلوتين؟"], ["vegetarian", "الأصناف النباتية + هل الزيت/الشواية مشتركة"], ["calories", "عندنا سعرات؟"],
  ["kids", "منيو أطفال؟ (حالياً البوت يقترح أصناف خفيفة من المنيو)"], ["reservations", "نقبل حجوزات؟"], ["jobs", "وين يرسل المتقدم؟"],
  ["partnerships", "إيميل/رقم للتعاون والموردين"], ["cash", "الدفع كاش في المطعم/عند الاستلام؟ (الموقع إلكتروني فقط)"],
  ["deliveryTime", "مدة توصيل تقريبية نقولها؟ (حالياً: «يظهر في صفحة الطلب»)"], ["specialHours", "مواعيد رمضان/العيد"], ["app", "هل تطبيق الجوال منشور؟"]]) {
  w(`| \`${k}\` | ${qq} | ناقص |`);
}
w();
w("قرارات أخرى:");
w("- **عيد الميلاد:** ما نجمع تاريخ الميلاد — `fc_birthday` جاهز لو قررنا نجمعه.");
w("- **الإحالة/السفراء:** مكافأة الصديق وقواعدها لـ`fc_referral_invite`.");
w("- **التقييم مقابل هدية:** `fc_review_thanks_coupon` للملاحظات الداخلية فقط — جوجل تمنع الحوافز على تقييماتها.");
w("- **الولاء:** `cms.loyalty.enabled=false` حالياً؛ قوالب الولاء تشتغل لما يتفعّل.");
w("- **الطلب المجدول:** `settings.preorder.enabled=false`؛ `fc_scheduled_reminder` جاهز.");
w("- **التوصيل بالحي:** الجدول مقفول، فالبوت يجاوب «توصلون حي X؟» بالنطاق بالكيلو ويطلب الموقع 📍 (يسعّره من `/api/delivery/quote`).");
w("- **قسم الصلاحيات:** مسارات `/api/cms/wabot/*` تقع حالياً على «الإعدادات» (المالك). لو تبي دور ثاني يجرّب البوت نضيفها لـ`PATH_SECTIONS` في cms.js.");
w();

w("## ١) القوالب");
for (const [g, label] of Object.entries(T.GROUPS)) {
  const list = T.TEMPLATES.filter((t) => t.meta.group === g);
  if (!list.length) continue;
  w();
  w(`### ${label}`);
  for (const t of list) {
    w();
    w(`#### \`${t.name}\` · ${t.language} · ${t.category}${t.meta.needsUpload ? " · 🖼️ صورة (تحتاج رفع)" : ""}`);
    w();
    w(q(T.previewText(t)));
    const f = T.footerOf(t); if (f && t.category !== "AUTHENTICATION") w(`>\n> _${f}_`);
    const btns = T.buttonsOf(t);
    if (btns.length) w(`\n**الأزرار:** ${btns.map((b) => b.type === "QUICK_REPLY" ? `[${b.text}]` : b.type === "URL" ? `[${b.text} ↗ ${b.url}]` : `[${b.text}]`).join(" ")}`);
    w();
    w(`- **الغرض:** ${t.meta.purpose}`);
    w(`- **يطلقه:** ${t.meta.trigger}`);
    const vars = t.meta.vars?.length ? t.meta.vars : t.meta.bind || [];
    if (vars.length) w(`- **المتغيّرات:** ${vars.map((v) => `{{${v.n}}} = \`${v.path}\` (${v.label || ""}، مثال: ${v.example})`).join(" · ")}`);
    if (t.meta.buttonVars?.length) w(`- **متغيّر الزر:** ${t.meta.buttonVars.map((v) => `\`${v.path}\` → ${v.base}${v.example}`).join(" · ")}`);
    w(`- **الإرسال:** ${{ auto: "تلقائي", "auto-candidate": "مرشّح للتلقائي (بعد التجربة)", manual: "يدوي" }[t.meta.send]}${t.meta.mandatory ? " · إجباري" : ""}`);
    w(`- **بديل SMS:** ${t.meta.fallbackSms || "—"}`);
    if (t.meta.reclassRisk) w(`- **خطر إعادة التصنيف:** ${t.meta.reclassRisk}`);
    if (t.meta.existing) w(`- **موجود سابقاً:** ${t.meta.existing}`);
    if (t.meta.notes) w(`- **ملاحظة:** ${t.meta.notes}`);
    if (t.meta.needsOmar) w(`- **يحتاج عمر:** ${t.meta.needsOmar}`);
  }
}

w();
w("## ٢) البوت (الرد الآلي داخل نافذة ٢٤ ساعة)");
w();
w("السلوك العام:");
w("- **برّه الدوام** (من `settings.hours`): كل رد يقول «مقفلين الحين ونفتح …» + زر «⏰ ذكّرني لما تفتحون» ⇒ أكشن `waitlist_join`.");
w("- **تحويل لموظف:** شكوى/إلغاء/تعديل/استرجاع/دفع/طلب موظف ⇒ أكشن `handoff` (مع `priority` و`ticket` للشكاوى) والبوت يسكت ٣٠ دقيقة إلا للإيقاف وحالة الطلب.");
w("- **الموظف رد من الجوال** (echo) ⇒ البوت يسكت ٤ ساعات على هذا الرقم.");
w("- **حد الردود:** ٦ ردود / ٥ دقائق، ونفس الرسالة خلال ٩٠ ثانية ما تتكرر؛ بعد الحد رسالة وحدة «حوّلناك لموظف».");
w("- **مرتين «ما فهمت»** ⇒ الثالثة تحوّل لموظف.");
w("- **«إلغاء» لوحدها** وعنده طلب نشط ⇒ يسأل: إلغاء الطلب ولا إيقاف الرسائل؟");
w("- **اللغة:** عربي (ويفهم الفرانكو)، وإنجليزي لو كتب العميل إنجليزي.");
w("- **الإعدادات:** `settings.waBot` = `{enabled, staffMuteHours, handoffQuietMinutes, maxRepliesPer5Min, duplicateSeconds, orderLookbackHours, publicCoupons, lateAfterMinutes, facts}`.");
w();
w("### جدول النوايا");
w();
w("| النية | الوصف | نوع الرد | مصادر البيانات | أمثلة |");
w("|---|---|---|---|---|");
for (const it of B.INTENTS) w(`| \`${it.name}\` | ${it.label} | ${it.reply} | ${it.sources.join("، ") || "—"} | ${it.examples.join(" · ").replace(/\|/g, "/")} |`);
w();
w("### أمثلة الردود");
const render = (r) => r.messages.map((p) => {
  if (p.type === "text") return q(p.text.body);
  const i = p.interactive;
  const lines = [];
  if (i.header?.type === "image") lines.push("🖼️ [صورة الصنف]");
  if (i.header?.type === "text") lines.push(`**${i.header.text}**`);
  lines.push(i.body.text);
  if (i.footer) lines.push(`_${i.footer.text}_`);
  if (i.type === "button") lines.push(i.action.buttons.map((b) => `[${b.reply.title}]`).join(" "));
  if (i.type === "list") lines.push(`☰ ${i.action.button}:\n${i.action.sections.flatMap((s) => s.rows).map((r) => `• ${r.title}${r.description ? ` — ${r.description}` : ""}`).join("\n")}`);
  if (i.type === "cta_url") lines.push(`[${i.action.parameters.display_text} ↗ ${i.action.parameters.url}]`);
  return q(lines.join("\n"));
}).join("\n>\n> ———\n>\n");
const SAMPLES = {
  greeting: [["السلام عليكم", {}], ["السلام عليكم (برّه الدوام ٥ الفجر)", { now: CLOSED }, "السلام عليكم"]],
  item_price: [["بكم نص دجاجة؟", {}], ["كم سعر الكفتة", {}], ["بكم الستيك", {}]],
  item_info: [["كريب زنجر", {}], ["مشكل مخصوص بالوزن", {}]],
  order_status: [["وين طلبي (عنده طلب)", { order: ORDER }, "وين طلبي"], ["وين طلبي (ما عنده طلب)", {}, "وين طلبي"]],
  cancel_or_stop: [["الغاء (عنده طلب نشط)", { order: ORDER }, "الغاء"]],
  complaint: [["الاكل وصل بارد", { order: ORDER }]],
  delivery_area: [["توصلون حي الصفا؟", {}], ["📍 موقع مرسل داخل النطاق", { quote: { deliverable: true, fee: 20, routeKm: 6.4 } }, "", { type: "location", location: { lat: 21.5, lng: 39.2 } }]],
  hours: [["متى تفتحون", {}], ["what are your opening hours", {}]],
  ad_welcome: [["(من إعلان) مرحبا", { referral: { source_type: "ad" } }, "مرحبا", { referral: { source_type: "ad" } }]],
  media: [["[صورة]", {}, "", { type: "image" }]],
};
for (const it of B.INTENTS) {
  w();
  w(`#### \`${it.name}\` — ${it.label}`);
  const samples = SAMPLES[it.name] || [[it.examples.find((e) => !e.startsWith("[")) || it.examples[0], {}]];
  for (const [title, over, textOverride, mctx] of samples) {
    const text = textOverride ?? title;
    const m = B.matchIntent(text, { menu: MENU, order: over.order || null, ...(mctx || {}) });
    const r = B.buildReply(m, ctx({ ...over, text, lang: m.lang }));
    w();
    w(`**العميل:** «${title}» → \`${m.intent}\`${r.actions.length ? ` · أكشن: ${r.actions.map((a) => a.type + (a.reason ? `(${a.reason}${a.priority ? `/${a.priority}` : ""})` : "")).join("، ")}` : ""}`);
    w();
    w(render(r));
  }
}
w();
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/whatsapp-catalogue.md"), out.join("\n"));
console.log(`docs/whatsapp-catalogue.md — ${out.length} lines`);
