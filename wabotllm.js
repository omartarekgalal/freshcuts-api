/* ═══════════════════════════════════════════════════════════════════════════
   WABOTLLM — تصنيف هجين لبوت واتساب (١٢/١٠/٢٠٢٦). **مقفول افتراضياً** (settings.waBot.llm.enabled من اللوحة).

   بيتنده بس لما قواعد wabotrun.classify ترجّع «غير مفهوم». الموديل **مابيكتبش ولا كلمة للعميل**: بيرجّع
   اسم نية من قايمتنا + (اختياري) صنف/قسم/بوكس/سؤال شائع من القوايم اللي اتبعتت له + درجة ثقة. الرد نفسه نص ثابت
   بيتعبّى من البيانات الحيّة في wabotrun.buildReply زي أي رد تاني. أي حاجة مش من القايمة، أو ثقة تحت الحد، أو
   تأخير عن المهلة، أو خطأ ⇒ null ⇒ مسار «غير مفهوم» العادي (انتظار الموظف ثم القائمة).

   اللي بيتبعت للموديل: نص الرسالة بس (أول ٣٠٠ حرف) بعد ما أي رقم من ٧ خانات أو أكتر (جوال، رقم طلب) يتبدّل بـ«#»،
   + أسماء أقسام وأصناف وبوكسات المنيو (بيانات عامة). **مابيتبعتش**: رقم الجوال، الاسم، تاريخ المحادثة، ولا أي طلب.

   المزوّد = نفس ترتيب ai.js: ANTHROPIC_API_KEY (Messages API مباشرة) وإلا LITELLM_KEY (بروكسي الفريق llm.o2m8.me).
   الموديل الافتراضي claude-haiku-5-5 (الأسرع والأرخص)، effort منخفض.
═══════════════════════════════════════════════════════════════════════════ */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const LLM_INTENTS = Object.freeze({
  greet: "تحية بس", main: "عايز القائمة / يختار", boxes: "يسأل عن البوكسات عموماً", tier: "بوكسات نوع معيّن (tier: 0 فردي، 1 لشخصين، 2 مشاركة/عائلة)",
  box: "بوكس معيّن بالاسم (box = slug)", cats: "المنيو / الأقسام / الأسعار عموماً", cat: "قسم معيّن (category_id)", item: "صنف معيّن: سعره أو مكوناته (item_id)",
  offers: "عروض / خصم / كود / أول طلب", order: "عايز يطلب / رابط الطلب", delivery: "توصيل: مناطق، رسوم، حد أدنى، مدة", pickup: "استلام من الفرع",
  hours: "مواعيد / مفتوحين؟ / الساعة كام بتقفلوا", location: "مكان الفرع / لوكيشن", payment: "طرق الدفع / كاش", status: "حالة طلبه / وين الطلب / المندوب",
  packs: "طلبات كبيرة / تجمعات / مناسبات", complaint: "شكوى فعلية: بارد، ناقص، غلط، متأخر، استرجاع", problem: "مشكلة دفع أو موقع أو كود", change: "تعديل أو إلغاء طلب",
  human: "عايز موظف / مدير / اتصال", thanks: "شكر / وداع", faq: "سؤال معلومات (faq = واحد من المفاتيح المسموحة)", spicy: "عايز أكل حار", unknown: "مش واضح / مش من دول",
});

export function maskText(text) {
  return String(text || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/\d{7,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function buildPrompt({ menu, bundles, faqKeys = [] }) {
  const cats = (menu?.categories || []).map((c) => `${c.id}: ${c.titleAr}`).join(" | ");
  const items = (menu?.items || []).map((i) => `${i.id}: ${i.name}`).join(" | ");
  const boxes = (bundles || []).filter((b) => String(b.section || "").trim()).map((b) => `${b.slug}: ${b.name}`).join(" | ");
  return [
    "أنت مصنّف رسائل لمطعم فريش كاتس في جدة. مهمتك الوحيدة: تحديد قصد رسالة عميل واتساب واحدة. لا ترد على العميل ولا تكتب أي نص له.",
    "الرسالة قد تكون بالسعودي/الخليجي، المصري، الفصحى، الإنجليزية أو الفرانكو، وفيها أخطاء إملائية.",
    `النوايا المسموحة فقط:\n${Object.entries(LLM_INTENTS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
    `مفاتيح faq المسموحة: ${faqKeys.join(", ")}`,
    cats ? `الأقسام (category_id: الاسم): ${cats}` : "",
    items ? `الأصناف (item_id: الاسم): ${items}` : "",
    boxes ? `البوكسات (slug: الاسم): ${boxes}` : "",
    "قواعد: الشكوى تحتاج شكوى صريحة؛ سؤال عن الوقت أو الساعة = hours. لا تخمّن صنفاً أو بوكساً غير موجود في القوائم. إن لم تكن متأكداً فالنية unknown بثقة منخفضة.",
    'أجب بكائن JSON واحد فقط بهذا الشكل ولا شيء غيره: {"intent":"...","category_id":null,"item_id":null,"box":null,"tier":null,"faq":null,"confidence":0.0}',
  ].filter(Boolean).join("\n\n");
}

/* مخرجات الموديل ⇒ {key, arg, confidence} أو null. أي قيمة مش موجودة في بياناتنا بتترفض (الموديل مايقدرش «يخترع» صنف). */
export function validate(raw, { menu, bundles, faqKeys = [] }) {
  let o = raw;
  if (typeof raw === "string") { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; try { o = JSON.parse(m[0]); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const intent = String(o.intent || "");
  const confidence = Number(o.confidence);
  if (!Object.prototype.hasOwnProperty.call(LLM_INTENTS, intent) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (intent === "unknown") return { key: null, arg: null, confidence };
  let arg = null;
  if (intent === "cat") { const c = (menu?.categories || []).find((x) => x.id === String(o.category_id)); if (!c) return null; arg = c.id; }
  if (intent === "item") { const i = (menu?.items || []).find((x) => x.id === String(o.item_id)); if (!i) return null; arg = i.id; }
  if (intent === "box") { const b = (bundles || []).find((x) => x.slug === String(o.box) && String(x.section || "").trim()); if (!b) return null; arg = b.slug; }
  if (intent === "tier") { if (![0, 1, 2].includes(Number(o.tier))) return null; arg = String(Number(o.tier)); }
  if (intent === "faq") { if (!faqKeys.includes(String(o.faq))) return null; arg = String(o.faq); }
  return { key: intent, arg, confidence };
}

export function providerOf(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return { kind: "anthropic", key: env.ANTHROPIC_API_KEY };
  if (env.LITELLM_KEY) return { kind: "litellm", key: env.LITELLM_KEY, base: String(env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "") };
  return null;
}

/* ⇒ async ({text, menu, bundles, cfg:{model, timeoutMs}}) ⇒ {key, arg, confidence, ms} | null. عمرها ما بترمي. */
export function makeClassifier({ fetch: doFetch = globalThis.fetch, env = process.env, faqKeys = [] } = {}) {
  return async function classify({ text, menu, bundles, cfg = {} }) {
    const provider = providerOf(env);
    const user = maskText(text);
    if (!provider || user.length < 2) return null;
    const system = buildPrompt({ menu, bundles, faqKeys });
    const model = String(cfg.model || "claude-haiku-5-5");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(500, Number(cfg.timeoutMs) || 2500));
    const t0 = Date.now();
    try {
      let out = "";
      if (provider.kind === "anthropic") {
        const res = await doFetch(ANTHROPIC_URL, { method: "POST", signal: ctl.signal,
          headers: { "content-type": "application/json", "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: "user", content: user }], output_config: { effort: "low" } }) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.stop_reason === "refusal") return null;
        out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      } else {
        const res = await doFetch(`${provider.base}/chat/completions`, { method: "POST", signal: ctl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
          body: JSON.stringify({ model: model.includes("/") ? model : `anthropic/${model}`, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
        if (!res.ok) return null;
        const data = await res.json();
        out = String(data.choices?.[0]?.message?.content || "");
      }
      const v = validate(out, { menu, bundles, faqKeys });
      return v ? { ...v, ms: Date.now() - t0 } : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
}
