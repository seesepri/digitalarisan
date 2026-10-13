import test from "node:test";
import assert from "node:assert/strict";

process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD = "2";
process.env.PROVIDER_CIRCUIT_OPEN_MS = "60000";
process.env.PROVIDER_MAX_CONCURRENCY = "1";
process.env.PROVIDER_MAX_QUEUE = "0";

const { providerFetch } = await import("@/server/services/runtime-resilience");

test("provider circuit opens after consecutive upstream failures", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream down"); };
  const key = `http://127.0.0.1/circuit-test-${Date.now()}`;
  try {
    await assert.rejects(() => providerFetch(key, "create", key));
    await assert.rejects(() => providerFetch(key, "create", key));
    await assert.rejects(
      () => providerFetch(key, "create", key),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "PROVIDER_CIRCUIT_OPEN",
    );
  } finally { globalThis.fetch = original; }
});

test("provider backpressure rejects when queue capacity is exhausted", async () => {
  const original = globalThis.fetch;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async () => { await blocker; return new Response("ok", { status: 200 }); };
  const key = `http://127.0.0.1/backpressure-${Date.now()}`;
  try {
    const first = providerFetch(key, "create", key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => providerFetch(key, "create", key),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "PROVIDER_BACKPRESSURE",
    );
    release();
    await first;
  } finally { globalThis.fetch = original; }
});
