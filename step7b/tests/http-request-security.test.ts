import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/http_security_unit_test";
const { readJson, readLimitedText, assertSameOrigin, errorResponse, getRequestMetadata } = await import("@/server/http");

test("JSON and webhook body limits reject oversized streaming payloads before full buffering", async () => {
  await assert.rejects(() => readJson(new Request("https://app.example", { method: "POST", body: JSON.stringify({ payload: "x".repeat(65_000) }) })), /Payload terlalu besar/);
  await assert.rejects(() => readLimitedText(new Request("https://app.example", { method: "POST", body: "x".repeat(32_001) }), 32_000), /Payload terlalu besar/);
  assert.deepEqual(await readJson(new Request("https://app.example", { method: "POST", body: '{"ok":true}' })), { ok: true });
});
test("production CSRF authorization uses APP_URL, never a forged request Host", () => {
  const original = process.env.NODE_ENV; const app = process.env.APP_URL;
  Object.defineProperty(process.env, "NODE_ENV", { value: "production", writable: true, configurable: true, enumerable: true }); process.env.APP_URL = "https://real.example";
  try {
    assert.throws(() => assertSameOrigin(new Request("https://forged.example/api", { headers: { origin: "https://forged.example" } })), /tidak diizinkan/);
    assert.doesNotThrow(() => assertSameOrigin(new Request("https://internal.example/api", { headers: { origin: "https://real.example" } })));
    delete process.env.APP_URL;
    assert.throws(() => assertSameOrigin(new Request("https://forged.example/api", { headers: { origin: "https://forged.example" } })), /APP_URL wajib/);
  } finally {
    Object.defineProperty(process.env, "NODE_ENV", { value: original, writable: true, configurable: true, enumerable: true });
    if (app === undefined) delete process.env.APP_URL; else process.env.APP_URL = app;
  }
});
test("database conflicts do not disclose query parameters to API callers", async () => {
  const error = new Error("Failed query: secret params account_number=1234567890", { cause: Object.assign(new Error("unique violation"), { code: "23505" }) });
  const response = errorResponse(error); const body = await response.text();
  assert.equal(response.status, 409); assert.doesNotMatch(body, /1234567890|Failed query|secret params/);
});

test("proxy metadata ignores attacker-prepended IPs and invalid addresses", () => {
  const trust=process.env.TRUST_PROXY; const hops=process.env.TRUST_PROXY_HOPS;
  try {
    process.env.TRUST_PROXY="true";process.env.TRUST_PROXY_HOPS="1";
    assert.equal(getRequestMetadata(new Request("https://app.example",{headers:{"x-forwarded-for":"203.0.113.9, 192.0.2.1"}})).ipAddress,"192.0.2.1");
    assert.equal(getRequestMetadata(new Request("https://app.example",{headers:{"x-forwarded-for":"untrusted invalid"}})).ipAddress,null);
    process.env.TRUST_PROXY="false";
    assert.equal(getRequestMetadata(new Request("https://app.example",{headers:{"x-forwarded-for":"203.0.113.9"}})).ipAddress,null);
  } finally { if(trust===undefined)delete process.env.TRUST_PROXY;else process.env.TRUST_PROXY=trust;if(hops===undefined)delete process.env.TRUST_PROXY_HOPS;else process.env.TRUST_PROXY_HOPS=hops; }
});
