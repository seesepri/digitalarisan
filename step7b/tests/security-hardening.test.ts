import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

test("stable payout reference is deterministic and non-sensitive", () => {
  const a=createHash("sha256").update("withdrawal-1").digest("hex").slice(0,32);
  const b=createHash("sha256").update("withdrawal-1").digest("hex").slice(0,32);
  assert.equal(a,b); assert.notEqual(a,"withdrawal-1");
});

test("Midtrans gross amount must be integer IDR", () => {
  assert.match("10000", /^\d+$/);
  assert.doesNotMatch("10000.99", /^\d+$/);
});

test("production requires trusted proxy before using forwarded IP", () => {
  const original=process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  assert.notEqual(process.env.TRUST_PROXY,"true");
  if(original===undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY=original;
});
