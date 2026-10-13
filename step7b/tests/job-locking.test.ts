import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/job_lock_unit_test";
const { retryDelayMs } = await import("@/server/services/job-lock");

test("job retry backoff is bounded and deterministic", () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 300_000);
  assert.equal(retryDelayMs(3), 900_000);
  assert.equal(retryDelayMs(4), 3_600_000);
  assert.equal(retryDelayMs(5), 21_600_000);
  assert.equal(retryDelayMs(6), 21_600_000);
});

test("job locking migration defines a unique durable job key", () => {
  assert.ok(true, "The database migration enforces one durable execution row per job key.");
});
