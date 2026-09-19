import test from "node:test";
import assert from "node:assert/strict";
import { feesFromStatus } from "./mffees.js";

test("MyFatoorah fee = TotalServiceCharge + VAT of the successful transaction", () => {
  const f = feesFromStatus({ DueDeposit: 103.0, DepositStatus: "Not Deposited", InvoiceTransactions: [
    { TransactionStatus: "Failed", TotalServiceCharge: "9" },
    { TransactionStatus: "Succss", PaymentGateway: "Apple Pay (mada)", TransationValue: "104.000", TotalServiceCharge: "0.884", VatAmount: "0.133", CustomerServiceCharge: "0.000", Card: { Brand: "Mada" } },
  ] });
  assert.deepEqual(f, { gateway: "Apple Pay (mada)", brand: "Mada", value: 104, fee: 0.884, feeVat: 0.133, customerCharge: 0, dueDeposit: 103, depositStatus: "Not Deposited" });
  assert.equal(feesFromStatus({ InvoiceTransactions: [] }), null);
});
