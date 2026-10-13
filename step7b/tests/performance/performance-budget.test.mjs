import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const file = process.env.PERF_RESULT_FILE;
test("performance budget result is within configured limits", async () => {
  if (!file) return;
  const result = JSON.parse(await readFile(file, "utf8"));
  assert.ok(result.p95Ms <= Number(process.env.PERF_P95_HEALTH_MS || 300));
  assert.ok(result.errorRate <= Number(process.env.PERF_MAX_ERROR_RATE || 0.01));
  assert.ok(result.requestsPerSecond >= Number(process.env.PERF_MIN_RPS || 20));
});
