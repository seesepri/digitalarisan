import test from "node:test";
import assert from "node:assert/strict";

const baseUrl = process.env.E2E_BASE_URL;

test("v11 HTTP E2E smoke requires E2E_BASE_URL", { skip: !baseUrl }, async () => {
  const health = await fetch(new URL("/api/health", baseUrl));
  assert.equal(health.status, 200);
  const body = await health.json() as { status?: string };
  assert.equal(body.status, "ok");

  const unauthenticated = await fetch(new URL("/api/v1/wallet", baseUrl));
  assert.ok([401, 403].includes(unauthenticated.status), `expected auth rejection, got ${unauthenticated.status}`);
});
