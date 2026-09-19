/* ═══════════════════════════════════════════════════════════════════════════
   MFFEES — رسوم ماي فاتورة الفعلية لكل طلب موقع (عمر، ١٩/٩)

   مصدرها GetPaymentStatus نفسه (نفس المفتاح اللي بنأكد بيه الدفع). في
   InvoiceTransactions للعملية الناجحة:
     TotalServiceCharge = رسوم البوابة على التاجر (من غير ضريبة) — مدى ≈ ٠٫٨٥٪،
                          فيزا/ماستر ≈ ٢٫٢٥٪ (اتقاس على طلبات ١٨/٩)
     VatAmount          = ضريبة الـ١٥٪ على الرسوم دي
     CustomerServiceCharge = رسوم على العميل (عندنا صفر)
   وعلى الفاتورة: DueDeposit / DepositStatus = اللي هيتحوّل لحسابنا وحالته.

   بنخزّن كل طلب مرة في shop_order_fees، والمزامنة كل ٣٠ دقيقة (٤٠ طلب في
   الدورة كحد أقصى)؛ الطلبات اللي تحويلها لسه مش «Deposited» بتتقري تاني بعد
   يوم لحد ما تتحوّل. رسوم الاسترجاع مش في الرد ده (بتظهر في كشف التحويلات
   في لوحة ماي فاتورة بس).
═══════════════════════════════════════════════════════════════════════════ */

import { paymentStatus, configured } from "./pay.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r3 = (v) => Math.round(num(v) * 1000) / 1000;

/** الرد الخام → صف رسوم (صافية، متختبرة). */
export function feesFromStatus(raw) {
  const txs = raw?.InvoiceTransactions || [];
  const tx = txs.find((t) => t.TransactionStatus === "Succss" || t.TransactionStatus === "Success");
  if (!tx) return null;
  return {
    gateway: tx.PaymentGateway || null,
    brand: tx.Card?.Brand || null,
    value: r3(tx.TransationValue ?? tx.PaidCurrencyValue),
    fee: r3(tx.TotalServiceCharge),
    feeVat: r3(tx.VatAmount),
    customerCharge: r3(tx.CustomerServiceCharge),
    dueDeposit: raw.DueDeposit == null ? null : r3(raw.DueDeposit),
    depositStatus: raw.DepositStatus || null,
  };
}

export function register(app, ctx) {
  const { pool, requireAdmin } = ctx;
  let ready = null;
  const ensure = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS shop_order_fees (
      order_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      gateway TEXT, brand TEXT,
      value NUMERIC, fee NUMERIC NOT NULL DEFAULT 0, fee_vat NUMERIC NOT NULL DEFAULT 0,
      customer_charge NUMERIC NOT NULL DEFAULT 0,
      due_deposit NUMERIC, deposit_status TEXT,
      error TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).catch((e) => { ready = null; throw e; }));

  async function sync({ days = 3, limit = 40 } = {}) {
    if (!configured()) return { skipped: "MYFATOORAH_API_KEY not set" };
    await ensure();
    const rows = (await pool.query(
      `SELECT o.order_no, o.mf_invoice_id FROM shop_orders o
         LEFT JOIN shop_order_fees f ON f.order_no = o.order_no
        WHERE o.mf_invoice_id IS NOT NULL
          AND o.status NOT IN ('pending_payment','expired')
          AND o.created_at > now() - ($1::int * interval '1 day')
          AND (f.order_no IS NULL
               OR (f.error IS NOT NULL AND f.fetched_at < now() - interval '1 hour')
               OR (COALESCE(f.deposit_status,'') NOT ILIKE 'deposited' AND f.fetched_at < now() - interval '1 day'))
        ORDER BY o.created_at DESC LIMIT $2`, [days, limit])).rows;
    let ok = 0, failed = 0;
    for (const r of rows) {
      try {
        const st = await paymentStatus({ key: r.mf_invoice_id, keyType: "InvoiceId" });
        const f = feesFromStatus(st.raw);
        await pool.query(
          `INSERT INTO shop_order_fees(order_no, invoice_id, gateway, brand, value, fee, fee_vat, customer_charge, due_deposit, deposit_status, error, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
           ON CONFLICT (order_no) DO UPDATE SET gateway=EXCLUDED.gateway, brand=EXCLUDED.brand, value=EXCLUDED.value, fee=EXCLUDED.fee,
             fee_vat=EXCLUDED.fee_vat, customer_charge=EXCLUDED.customer_charge, due_deposit=EXCLUDED.due_deposit,
             deposit_status=EXCLUDED.deposit_status, error=EXCLUDED.error, fetched_at=now()`,
          [r.order_no, r.mf_invoice_id, f?.gateway, f?.brand, f?.value, f?.fee || 0, f?.feeVat || 0, f?.customerCharge || 0, f?.dueDeposit, f?.depositStatus, f ? null : "no successful transaction"]);
        ok++;
      } catch (e) {
        failed++;
        await pool.query(`INSERT INTO shop_order_fees(order_no, invoice_id, error) VALUES ($1,$2,$3)
                          ON CONFLICT (order_no) DO UPDATE SET error=EXCLUDED.error, fetched_at=now()`, [r.order_no, r.mf_invoice_id, String(e.message).slice(0, 300)]).catch(() => {});
      }
    }
    return { checked: rows.length, ok, failed };
  }

  app.post("/api/reports/biz/mf-fees/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    return c.json({ ok: true, ...(await sync({ days: Math.min(400, Number(b.days) || 60), limit: Math.min(500, Number(b.limit) || 200) })) });
  });

  if (process.env.MF_FEES_SYNC !== "0") {
    setTimeout(() => { sync().catch(() => {}); setInterval(() => sync().catch((e) => console.error("[mffees]", e.message)), 30 * 60_000); }, 120_000);
  }
  return { ensure, sync };
}

export default { register };
