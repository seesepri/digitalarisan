import assert from "node:assert/strict";
import test from "node:test";
// This provider adapter test is network-mocked and must never connect to a configured database.
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/withdrawal_unit_test";
const { HttpPayoutProvider, stablePayoutReference } = await import("@/server/services/payout-provider");

test("stable payout reference is deterministic and bounded", () => {
  const a = stablePayoutReference("withdrawal-123");
  const b = stablePayoutReference("withdrawal-123");
  assert.equal(a, b);
  assert.match(a, /^WD-[0-9a-f]{32}$/);
});

test("payout create sends the stable reference as Idempotency-Key", async () => {
  process.env.PAYOUT_PROVIDER_BASE_URL = "https://provider.example";
  process.env.PAYOUT_PROVIDER_API_KEY = "test-key";
  process.env.PAYOUT_PROVIDER = "test";
  const provider = new HttpPayoutProvider("test");
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ providerReference: "provider-1", status: "PROCESSING" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await provider.createDisbursement({
      reference: "WD-abcdef1234567890abcdef1234567890",
      bankName: "TEST BANK",
      accountName: "Test",
      accountNumber: "123",
      amount: 25_000,
    });
    assert.equal(new Headers(captured?.headers).get("Idempotency-Key"), "WD-abcdef1234567890abcdef1234567890");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payout status 404 is never treated as provider success", async () => {
  process.env.PAYOUT_PROVIDER_BASE_URL = "https://provider.example";
  process.env.PAYOUT_PROVIDER_API_KEY = "test-key";
  const provider = new HttpPayoutProvider("test");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const result = await provider.getDisbursementStatus("WD-missing");
    assert.notEqual(result.status, "SUCCESS");
    assert.equal(result.status, "FAILED_RETRYABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider adapter does not invent an external reference", async () => {
  process.env.PAYOUT_PROVIDER_BASE_URL = "https://provider.example";
  process.env.PAYOUT_PROVIDER_API_KEY = "test-key";
  const provider = new HttpPayoutProvider("test");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "SUCCESS" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const created = await provider.createDisbursement({
      reference: "WD-abcdef1234567890abcdef1234567890",
      bankName: "TEST BANK",
      accountName: "Test",
      accountNumber: "123",
      amount: 25_000,
    });
    assert.equal(created.status, "SUCCESS");
    assert.equal(created.providerReference, null);
    const status = await provider.getDisbursementStatus(created.reference);
    assert.equal(status.providerReference, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
