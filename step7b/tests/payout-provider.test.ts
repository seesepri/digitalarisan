import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/withdrawal_unit_test";
const { HttpPayoutProvider, assertDisbursementEvidence, stablePayoutReference } = await import("@/server/services/payout-provider");
const reference = stablePayoutReference("withdrawal-123");
const input = { reference, bankName: "TEST BANK", accountName: "Test", accountNumber: "123", amount: 25_000 };
const valid = { reference, providerReference: "provider-1", amount: 25_000, currency: "IDR", status: "SUCCESS" };
function configure() {
  process.env.PAYOUT_PROVIDER_BASE_URL = "https://provider.example";
  process.env.PAYOUT_PROVIDER_API_KEY = "test-key";
  process.env.PAYOUT_PROVIDER = "test";
  delete process.env.PAYOUT_PROVIDER_CREATE_PATH;
  delete process.env.PAYOUT_PROVIDER_STATUS_PATH;
  return new HttpPayoutProvider("test");
}
async function mocked<T>(body: unknown, run: (provider: InstanceType<typeof HttpPayoutProvider>, getInit: () => RequestInit | undefined) => Promise<T>, status = 200) {
  const provider = configure(); const original = globalThis.fetch; let captured: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => { captured = init; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
  try { return await run(provider, () => captured); } finally { globalThis.fetch = original; }
}

test("stable payout reference is deterministic and bounded", () => {
  assert.equal(reference, stablePayoutReference("withdrawal-123"));
  assert.match(reference, /^WD-[0-9a-f]{32}$/);
});

test("payout create sends a stable idempotency key, IDR, and disables redirects", async () => {
  await mocked(valid, async (provider, getInit) => {
    const result = await provider.createDisbursement(input);
    const init = getInit();
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), reference);
    assert.equal(JSON.parse(String(init?.body)).currency, "IDR");
    assert.equal(init?.redirect, "error");
    assert.equal(result.status, "SUCCESS");
    assert.equal(result.providerReference, "provider-1");
  });
});

test("404 is UNKNOWN, not confirmed failure or permission to retry/refund", async () => {
  await mocked({}, async (provider) => {
    const result = await provider.getDisbursementStatus(reference);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.failureConfirmed, false);
    assert.equal(result.providerReference, null);
  }, 404);
});

test("SUCCESS without an external reference is rejected, never invented", async () => {
  await mocked({ ...valid, providerReference: undefined }, async (provider) => {
    await assert.rejects(() => provider.createDisbursement(input), /referensi eksternal/);
    await assert.rejects(() => provider.getDisbursementStatus(reference), /referensi eksternal/);
  });
});

test("reference, amount and currency mismatch are rejected", async () => {
  for (const body of [{ ...valid, reference: "another-transfer" }, { ...valid, amount: 1 }, { ...valid, currency: "USD" }, { ...valid, amount: 25_000.01 }]) {
    await mocked(body, async (provider) => { await assert.rejects(() => provider.createDisbursement(input)); });
  }
});

test("a provider timeout status remains unknown even if a reference exists", async () => {
  await mocked({ ...valid, status: "timeout" }, async (provider) => {
    assert.equal((await provider.getDisbursementStatus(reference)).status, "UNKNOWN");
  });
});

test("failure requires explicit provider assurance that no transfer occurred", async () => {
  for (const status of ["failed", "retryable"]) {
    await mocked({ ...valid, status }, async (provider) => {
      await assert.rejects(() => provider.getDisbursementStatus(reference), /belum memastikan transfer gagal/);
    });
    await mocked({ ...valid, status, failureConfirmed: true }, async (provider) => {
      const result = await provider.getDisbursementStatus(reference);
      assert.equal(result.failureConfirmed, true);
      assert.notEqual(result.status, "UNKNOWN");
    });
  }
});

test("malformed JSON shape never proves a transfer", async () => {
  for (const body of [null, [], "SUCCESS"]) await mocked(body, async (provider) => {
    await assert.rejects(() => provider.getDisbursementStatus(reference), /tidak valid/);
  });
});

test("financial-boundary validation rejects changed external references and mismatched provider", () => {
  const result = { ...valid, status: "SUCCESS" as const, currency: "IDR" as const, provider: "test", failureConfirmed: false, checkedAt: new Date().toISOString() };
  assert.throws(() => assertDisbursementEvidence(result, { reference, amount: 25_000, providerReference: "different" }), /berubah/);
  assert.throws(() => assertDisbursementEvidence(result, { reference, amount: 25_000, provider: "another-provider" }), /Bukti payout/);
});

test("provider paths cannot exfiltrate credentials to another origin or follow redirects", async () => {
  const provider = configure(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("should not send credentials"); };
  try {
    for (const path of ["https://attacker.example/transfer", "//attacker.example/transfer"]) {
      process.env.PAYOUT_PROVIDER_CREATE_PATH = path;
      await assert.rejects(() => provider.createDisbursement(input), /origin yang sama/);
    }
    delete process.env.PAYOUT_PROVIDER_CREATE_PATH;
    process.env.PAYOUT_PROVIDER_BASE_URL = "http://provider.example";
    await assert.rejects(() => provider.createDisbursement(input), /HTTPS/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; configure(); }
});
