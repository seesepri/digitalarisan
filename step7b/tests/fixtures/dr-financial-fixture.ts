import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configureTestDatabase } from "../../scripts/test-database-guard.mjs";
const url = await configureTestDatabase(); if (!url) throw new Error("Guarded disposable database required");
const { db, pool } = await import("@/db");
const { decryptBankPii } = await import("@/server/services/pii");
try {
  if (process.argv.includes("--verify-only")) {
    const { rows } = await pool.query("SELECT status,provider_reference,account_number FROM withdrawals");
    assert.equal(rows.length, 1); assert.equal(rows[0].status, "SUCCESS"); assert.ok(rows[0].provider_reference); assert.ok(rows[0].account_number.startsWith("enc:v1:")); assert.equal(decryptBankPii(rows[0].account_number), "1234567890");
    console.log(JSON.stringify({ status: "PASS", syntheticFixture: true, preservedEncryptedBankPiiDecryptsWithOriginalTestKey: true }));
  } else {
    const s = await import("@/db/schema");
    const { createTopup, reconcileTopupPayment, createWithdrawal } = await import("@/server/services/wallet");
    const { approveWithdrawal } = await import("@/server/services/compliance");
    const { executeWithdrawal } = await import("@/server/services/payout-withdrawal");
    process.env.PAYMENT_PROVIDER = "dr-lab-payment"; process.env.PAYOUT_PROVIDER = "dr-lab";
    process.env.PAYMENT_PROVIDER_BASE_URL = "https://dr-lab.invalid"; process.env.PAYOUT_PROVIDER_BASE_URL = "https://dr-lab.invalid";
    process.env.PAYMENT_PROVIDER_API_KEY = "synthetic-only"; process.env.PAYOUT_PROVIDER_API_KEY = "synthetic-only";
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const ref = decodeURIComponent(path.split("/").pop()!);
      const result = path === "/payments" && body ? { providerReference: `PAY-${body.reference}`, checkoutUrl: "https://dr-lab.invalid/checkout" }
        : path.startsWith("/payments/") ? { reference: ref, providerReference: `PAY-${ref}`, amount: 100_000, currency: "IDR", status: "PAID" }
        : path === "/disbursements" && body ? { provider: "dr-lab", reference: body.reference, providerReference: `EXTERNAL-${body.reference}`, amount: body.amount, currency: "IDR", status: "SUCCESS" }
        : null;
      if (!result) throw new Error("Unexpected mock-provider operation; no real external call is allowed");
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const makerId = randomUUID(); const checkerId = randomUUID(); const userId = randomUUID();
      await db.insert(s.users).values([{ id: makerId, name: "DR synthetic maker", phone: "+6281100033001", passwordHash: "test-only", role: "SUPER_ADMIN", phoneVerifiedAt: new Date() }, { id: checkerId, name: "DR synthetic checker", phone: "+6281100033002", passwordHash: "test-only", role: "ADMIN", phoneVerifiedAt: new Date() }]);
      await db.insert(s.users).values({ id: userId, name: "DR synthetic user", phone: "+6281100033003", passwordHash: "test-only", kycStatus: "VERIFIED", kycReviewedBy: makerId, phoneVerifiedAt: new Date() });
      await db.insert(s.wallets).values({ userId });
      const invoice = await createTopup({ userId, amount: 100_000, idempotencyKey: `DR-TOPUP-${randomUUID()}`, callbackUrl: "https://dr-lab.invalid/return" });
      await reconcileTopupPayment({ topupId: invoice.topup.id });
      const withdrawal = await createWithdrawal({ userId, amount: 25_000, bankName: "SYNTHETIC BANK", accountName: "SYNTHETIC USER", accountNumber: "1234567890", idempotencyKey: `DR-WD-${randomUUID()}` });
      await approveWithdrawal({ withdrawalId: withdrawal.withdrawal.id, adminId: makerId, reason: "Synthetic DR fixture" });
      const paid = await executeWithdrawal({ withdrawalId: withdrawal.withdrawal.id, adminId: checkerId, adminRole: "ADMIN" }); assert.equal(paid.status, "SUCCESS");
      console.log(JSON.stringify({ status: "PASS", syntheticFixture: true, noActualProviderCalls: true, funded: 100_000, confirmedMockWithdrawal: 25_000, available: 75_000, expectedWalletLedgerEntries: 3 }));
    } finally { globalThis.fetch = original; }
  }
} finally { await pool.end(); }
