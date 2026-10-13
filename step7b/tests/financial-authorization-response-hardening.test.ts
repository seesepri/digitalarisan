import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("financial withdrawal approval response cannot expose encrypted bank PII", () => {
  const source = read("src/server/services/compliance.ts");
  assert.match(source, /financialWithdrawalView/);
  assert.doesNotMatch(source, /return \{ withdrawal: updated, replayed: false \}/);
  assert.doesNotMatch(source, /return \{ withdrawal, replayed: true \}/);
  const helper = source.slice(source.indexOf("function financialWithdrawalView"), source.indexOf("export async function assessWithdrawalRisk"));
  assert.doesNotMatch(helper, /bankName|accountName|accountNumber|decryptBankPii/);
});

test("provider execution response cannot expose bank PII from internal withdrawal row", () => {
  const source = read("src/server/services/payout-withdrawal.ts");
  assert.match(source, /function financialWithdrawalView/);
  assert.match(source, /if \(started\.replayed\) return \{ withdrawal: financialWithdrawalView\(started\.withdrawal\)/);
  assert.doesNotMatch(source, /return \{ \.\.\.started, providerStatus/);
});

test("financial admin mutation routes retain authentication, same-origin, and rate limiting", () => {
  const files = [
    "src/app/api/v1/admin/withdrawals/[id]/approve/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/execute/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/process/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/retry/route.ts",
    "src/app/api/v1/admin/compliance/flags/[id]/route.ts",
    "src/app/api/v1/admin/arisan/periods/[id]/draw/route.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /requireAdmin|requireSuperAdmin/);
    assert.match(source, /assertSameOrigin/);
    assert.match(source, /enforceRateLimit/);
  }
});
