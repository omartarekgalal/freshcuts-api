/* ═══════════════════════════════════════════════════════════════════════════
   GOOGLE PLACES (New) — التقييم الحقيقي من جوجل، مرة كل ١٢ ساعة.

   ليه الملف ده موجود: التقييم اللي على المتجر كان رقم مكتوب بالإيد في
   seo.py (٤٫٩) — يعني ممكن يبقى غلط في أي لحظة، والـschema.org بيعلن رقم
   مش حقيقي (ده اللي جوجل بيعتبره structured-data spam). دلوقتي الرقم بييجي
   من Place Details (New) وبيتخزّن في settings.googlePlace، والمتجر بيقراه
   من نسخة الإعدادات — **مفيش نداء لجوجل في أي عرض صفحة**.

   ── التكلفة (اتأكدنا منها قبل ما نكتب سطر) ────────────────────────────────
   حقلَي `rating` و`userRatingCount` مش Pro — هما **Place Details
   (Enterprise)**، SKU `2D9A-3DE0-3766`، بـ٢٠ دولار لكل ١٠٠٠ نداء، وأول
   ١٠٠٠ نداء في الشهر ببلاش. نداء كل ١٢ ساعة = ~٦٢ نداء في الشهر ⇒ **صفر
   دولار** (جوّه الحد المجاني، وحتى لو خرجنا منه = ١٫٢٤ دولار/شهر).
   البحث بالاسم (Text Search Enterprise، SKU `E967-44BC-B44D`، ٣٥ دولار/١٠٠٠)
   بيتنادى **يدوي من اللوحة بس** عشان نلاقي معرّف المكان مرة واحدة.

   ── المفتاح ───────────────────────────────────────────────────────────────
   GOOGLE_PLACES_KEY لو موجود (المفروض مفتاح سيرفر مقصور على Places API
   (New)). لو مش موجود بنقع على GOOGLE_MAPS_BROWSER_KEY — ده مفتاح متصفح
   مقيّد بالـreferrer، فبنبعت Referer بتاع المتجر معاه. GOOGLE_ROUTES_KEY
   مقصور على Routes وبيرجّع API_KEY_SERVICE_BLOCKED، فهو آخر محاولة بس.
═══════════════════════════════════════════════════════════════════════════ */

const BASE = "https://places.googleapis.com/v1";
const DETAILS_FIELDS = "id,displayName,rating,userRatingCount,googleMapsUri,businessStatus";
const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri";

export const PLACES_SKU = Object.freeze({
  details: { name: "Place Details (Enterprise)", sku: "2D9A-3DE0-3766", usd1000: 20, freePerMonth: 1000 },
  search: { name: "Text Search (Enterprise)", sku: "E967-44BC-B44D", usd1000: 35, freePerMonth: 1000 },
});

/* تكلفة متوقعة بالدولار في الشهر لتحديث كل refreshHours ساعة */
export function monthlyCost(refreshHours = 6, sku = PLACES_SKU.details) {
  const h = Math.max(1, Number(refreshHours) || 6);
  const calls = Math.ceil((30 * 24) / h);
  const billable = Math.max(0, calls - sku.freePerMonth);
  return { calls, billable, usd: Math.round((billable / 1000) * sku.usd1000 * 100) / 100 };
}

export const placesKey = (env = process.env) =>
  String(env.GOOGLE_PLACES_KEY || env.GOOGLE_MAPS_BROWSER_KEY || env.GOOGLE_ROUTES_KEY || "").trim();

/* معرّف المكان بيبدأ بـChIJ/GhIJ/E… وبيبقى Base64url — نتأكد من الشكل قبل ما
   نحطه في URL (مايتكتبش من اللوحة غير من نتيجة بحث، بس الحزام الأمان أرخص). */
export const validPlaceId = (id) => /^[A-Za-z0-9_-]{10,255}$/.test(String(id || ""));

/* رابط «اكتب تقييم» القياسي من معرّف المكان — لو عمر ماحطّش رابط g.page */
export const writeReviewUrl = (placeId) =>
  (validPlaceId(placeId) ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}` : "");

export const placeMapsUrl = (placeId) =>
  (validPlaceId(placeId) ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}` : "");

/* رد جوجل → الشكل اللي بنخزّنه. بيرجّع null لو مفيش تقييم حقيقي:
   **عمرنا ما نخترع رقم** — لا صفر ولا افتراضي. */
export function parsePlace(j) {
  if (!j || typeof j !== "object") return null;
  const rating = Number(j.rating);
  const count = Number(j.userRatingCount);
  if (!(rating > 0 && rating <= 5) || !(count >= 1)) return null;
  return {
    placeId: String(j.id || ""),
    name: String(j.displayName?.text || "").slice(0, 120) || null,
    rating: Math.round(rating * 10) / 10,
    count: Math.round(count),
    mapsUrl: String(j.googleMapsUri || "").split("&g_mp=")[0] || placeMapsUrl(j.id),
    status: String(j.businessStatus || "") || null,
  };
}

export function parseSearch(j) {
  const arr = Array.isArray(j?.places) ? j.places : [];
  return arr.slice(0, 5).map((p) => ({
    ...(parsePlace(p) || { placeId: String(p.id || ""), name: p.displayName?.text || null, rating: null, count: null, mapsUrl: String(p.googleMapsUri || "").split("&g_mp=")[0] }),
    address: String(p.formattedAddress || "").slice(0, 200) || null,
  })).filter((p) => validPlaceId(p.placeId));
}

function headers(key, mask) {
  const h = { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask };
  // مفتاح المتصفح مقيّد بالـreferrer بتاع المتجر — من غير السطر ده بيرجّع 403
  const ref = (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "") + "/";
  h.Referer = ref;
  return h;
}

const errOf = async (r) => {
  const t = await r.text().catch(() => "");
  let msg = t.slice(0, 200);
  try { msg = JSON.parse(t)?.error?.message || JSON.parse(t)?.error?.status || msg; } catch { /* نص خام */ }
  return Object.assign(new Error(`places ${r.status}: ${msg}`), { status: r.status });
};

/* Place Details — النداء الدوري (رخيص، حقل واحد مهم) */
export async function fetchPlaceDetails(placeId, { key = placesKey(), fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!key) throw new Error("no_places_key");
  if (!validPlaceId(placeId)) throw new Error("bad_place_id");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${BASE}/places/${encodeURIComponent(placeId)}?languageCode=ar&regionCode=SA`,
      { headers: headers(key, DETAILS_FIELDS), signal: ac.signal });
    if (!r.ok) throw await errOf(r);
    return parsePlace(await r.json());
  } finally { clearTimeout(t); }
}

/* Text Search — مرة واحدة من اللوحة عشان نلاقي المكان */
export async function searchPlaces(textQuery, { key = placesKey(), fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!key) throw new Error("no_places_key");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${BASE}/places:searchText`, {
      method: "POST", headers: headers(key, SEARCH_FIELDS), signal: ac.signal,
      body: JSON.stringify({ textQuery: String(textQuery || "").slice(0, 200), languageCode: "ar", regionCode: "SA", maxResultCount: 5 }),
    });
    if (!r.ok) throw await errOf(r);
    return parseSearch(await r.json());
  } finally { clearTimeout(t); }
}

/* هل النسخة المخزّنة قديمة؟ (بالساعات) */
export const staleAfter = (at, hours) => {
  if (!at) return true;
  const ms = Date.parse(at);
  return !Number.isFinite(ms) || Date.now() - ms > Math.max(1, Number(hours) || 6) * 3600_000;
};
