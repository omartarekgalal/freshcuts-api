/* ═══════════════════════════════════════════════════════════════════════════
   TSSTORE — TabSense PUBLIC store API client (the qr.tabsense.ai api-party
   proxy), ported from the Python storefront's call_store.

   This is NOT tabsense.js (the headless DASHBOARD connector with Omar's
   credentials). The public store API is what the customer-facing QR app uses:
   no auth, per-store paths, and it is the only surface that can create
   external orders («طلبات خارجية») the cashier sees on the POS.

   Why the port exists: the own-MyFatoorah checkout moves order orchestration
   into this API (Postgres, payments, refunds, couriers all live here), so the
   API itself must be able to calculate and create POS orders instead of
   round-tripping through the Python storefront.

   Retry policy copied from the Python original: connect errors retry for any
   call (the request never left, cannot duplicate an order); anything after
   that retries only on read-only paths.
═══════════════════════════════════════════════════════════════════════════ */

const env = (k, d) => (process.env[k] || d || "").toString().trim();

export const STORE = () => env("TABSENSE_STORE", "freshcuts");
const UPSTREAM = () => env("TABSENSE_UPSTREAM", "https://qr.tabsense.ai/api/__api_party/myApi");
export const STORE_LAT = () => Number(env("TABSENSE_STORE_LAT", "21.5881404"));
export const STORE_LNG = () => Number(env("TABSENSE_STORE_LNG", "39.1521236"));
// TabSense money integers are SAR × this factor.
export const MULTIPLY = 1000000000;

const SAFE_RETRY = ["calculate-order", "payments/status", "check-stocks", "pos-availability"];
const safeToRetry = (path, method) => method === "GET" || SAFE_RETRY.some((m) => path.includes(m));

export async function callStore(path, { method = "GET", branchId, body } = {}) {
  const payload = { path, method, headers: {} };
  if (branchId != null) payload.headers["branch-id"] = String(branchId);
  if (body !== undefined) payload.body = body;

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const resp = await fetch(UPSTREAM(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Referer: "https://qr.tabsense.ai/",
          "User-Agent": "FreshCutsAPI/1.0",
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      }).finally(() => clearTimeout(t));
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        throw Object.assign(new Error("tabsense upstream returned non-JSON"), { code: "TS_NON_JSON" });
      }
    } catch (e) {
      lastErr = e;
      // fetch's pre-connection failures surface as TypeError; a timeout/abort
      // or non-JSON body may mean the request WAS processed — only retry those
      // on read-only paths.
      const neverLeft = e instanceof TypeError;
      if (!neverLeft && !safeToRetry(path, method)) break;
      if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw Object.assign(new Error(`tabsense upstream unreachable: ${lastErr?.message || "unknown"}`), {
    code: "TS_UNREACHABLE",
  });
}

/* ── menu (cached) — checkout needs real system prices for helper products ── */
let _menuCache = { at: 0, data: null };
export async function fetchMenu(branchId = "1") {
  if (Date.now() - _menuCache.at < 10 * 60_000 && _menuCache.data) return _menuCache.data;
  const menuId = env("TABSENSE_EXTERNAL_MENU_ID", "2");
  const res = await callStore(`stores/${STORE()}/menus/${menuId}`, { branchId });
  if (res?.data?.pages) _menuCache = { at: Date.now(), data: res.data };
  return _menuCache.data;
}
export async function findProduct(productId, branchId = "1") {
  const menu = await fetchMenu(branchId);
  for (const p of menu?.pages || [])
    for (const it of p.items || [])
      if (String(it.id) === String(productId)) return it;
  return null;
}

/* ── calculate-order ─────────────────────────────────────────────────────────
   purchases: [{product_id, quantity, unit_amount, tax_id?}] in TabSense units
   (unit_amount already × MULTIPLY, exactly as the storefront cart sends).
   discountPercent (probed 2026-08-12): adjustments.discount MUST be
   {id, percentage_value} — id:null + a percentage applies pre-VAT and TabSense
   recomputes the tax itself. Flat charges are silently IGNORED and free-form
   unit_amounts are rejected, which is why the delivery fee travels as a
   quantity of a real 1-SAR product instead.                                 */
export async function calculateOrder({ branchId = "1", orderOptionId = 3, purchases, tipAmount = 0, discountPercent = 0 }) {
  const adjustments = { discount: null, charges: [], product_extra: {} };
  if (discountPercent > 0) {
    adjustments.discount = { id: null, percentage_value: Math.min(100, Number(discountPercent)) };
  }
  if (tipAmount > 0) adjustments.tips = { amount: Math.round(tipAmount * MULTIPLY) };
  const body = {
    order_type: 9,
    order_option_id: orderOptionId,
    branch_id: Number(branchId),
    multiply_factor: MULTIPLY,
    purchases: purchases.map((p) => ({
      product_id: Number(p.product_id),
      quantity: Number(p.quantity),
      tax_id: p.tax_id ?? 1,
      unit_amount: Number(p.unit_amount),
      modifiers: [],
      parent_product: { meta: { notes: null } },
    })),
    adjustments,
  };
  const calc = await callStore(`stores/${STORE()}/calculate-order`, { method: "POST", branchId, body });
  const data = calc?.data || {};
  if (!data.purchases?.length || !data.totals?.total_amount) {
    const err = calc?.meta?.error_message || "calculate-order returned no data";
    throw Object.assign(new Error(err), { code: "TS_CALC_EMPTY", resp: calc });
  }
  for (const p of data.purchases) p.meta = p.meta || { notes: null };
  return data;
}

/* ── direct order creation (the proven "cash-path" shape) ────────────────────
   Creates the order in the POS immediately. payment_method is what shows on
   the POS ("cash" today; "online" once Omar adds the payment method in
   TabSense settings — until the probe in task #6 confirms TabSense accepts
   it, callers should treat non-cash values as experimental).               */
export async function createPosOrder({
  branchId = "1", orderOptionId, calcData, customer, orderNo,
  notes, paymentMethod = "cash", deliveryAddress, latitude, longitude,
}) {
  const body = { ...calcData };
  body.order_option_id = orderOptionId;
  body.order_source = 2;
  body.store_front_order_type = 1;
  body.customer = customer;
  body.meta = {
    ...(calcData.meta || {}),
    version: 2,
    notes: (notes || "").slice(0, 100) || null,
    store_front_order_no: orderNo,
    table_id: null,
  };
  body.table = { table_id: null, guests: null };
  body.payment_info = {
    latitude: latitude ?? STORE_LAT(),
    longitude: longitude ?? STORE_LNG(),
    payment_method: paymentMethod,
    delivery_address: deliveryAddress || "Pickup",
  };
  const created = await callStore(`stores/${STORE()}/orders`, { method: "POST", branchId, body });
  const d = created?.data || {};
  if (d.id == null) {
    throw Object.assign(new Error("order creation failed"), { code: "TS_CREATE_FAILED", resp: created });
  }
  return d; // {id, order_status, payment_status, ...}
}

export async function getOrder(orderId, branchId = "1") {
  const raw = await callStore(`stores/${STORE()}/orders/${orderId}`, { branchId });
  return raw?.data || null;
}

/* The POS lifecycle we can see from outside: orders_store_front.approval_status
   (new → accepted / rejected). ready/completed never reach the public API —
   the staff panel stage covers those. */
export function approvalOf(orderData) {
  return (orderData?.orders_store_front || {}).approval_status || null;
}
