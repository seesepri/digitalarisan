import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("release integrity is Node.js/npm-only and requires an npm v3 lockfile", () => {
  assert.equal(existsSync("package-lock.json"), true, "A lockfile is required for the release gate.");
  assert.equal(JSON.parse(read("package-lock.json")).lockfileVersion, 3);
  assert.match(read("scripts/deploy/security-gate.mjs"), /package-lock\.json is required/);
  assert.match(read("scripts/deploy/security-gate.mjs"), /npm.*ci/);
  assert.doesNotMatch(read("scripts/deploy/security-gate.mjs"), /Dockerfile|docker compose|docker build/);
  assert.equal(existsSync("Dockerfile"), false);
  assert.equal(existsSync("docker-compose.production.yml"), false);
  assert.equal(existsSync("docker-compose.test.yml"), false);
  assert.doesNotMatch(read(".env.production.example"), /IMAGE_TAG=/);
  assert.match(read(".env.production.example"), /RELEASE_SHA=/);
  const ciWorkflow = ".github/workflows/security-ci.yml";
  if (existsSync(ciWorkflow)) {
    assert.match(read(ciWorkflow), /npm ci/);
    assert.doesNotMatch(read(ciWorkflow), /docker\/build-push-action|docker\/setup-buildx-action/);
  }
});

test("bank-account PII is encrypted and masked", () => {
  const schema = read("src/db/schema.ts");
  const wallet = read("src/server/services/wallet.ts");
  const payout = read("src/server/services/payout-withdrawal.ts");
  assert.match(schema, /bankName: text\("bank_name"\)/);
  assert.match(schema, /accountNumber: text\("account_number"\)/);
  assert.match(wallet, /encryptBankPii\(input\.accountNumber\)/);
  assert.match(wallet, /safeWithdrawalView/);
  assert.match(payout, /decryptBankPii\(w\.accountNumber\)/);
  assert.match(read(".env.production.example"), /BANK_PII_ENCRYPTION_KEY=/);
});

test("privacy governance and migration are present", () => {
  assert.ok(existsSync("PRIVACY_DATA_GOVERNANCE_V21.md"));
  assert.match(read("scripts/deploy/apply-migrations.mjs"), /bankPiiMigrated/);
  assert.match(read(".env.production.example"), /BANK_PII_ENCRYPTION_KEY=/);
});

test("provider webhook normalization rejects invalid currency/status", () => {
  const provider = read("src/server/services/payment-provider.ts");
  assert.match(provider, /INVALID_WEBHOOK_CURRENCY/);
  assert.match(provider, /INVALID_WEBHOOK_STATUS/);
  assert.match(provider, /knownProcessingStatuses/);
});

test("distributed credential stuffing has per-identifier throttling", () => {
  const http = read("src/server/http.ts");
  const login = read("src/app/api/v1/auth/login/route.ts");
  assert.match(http, /createHmac\("sha256"/);
  assert.match(http, /subject\?: string/);
  assert.match(login, /auth-login-identifier/);
});

test("refresh token reuse is detected and family revoked", () => {
  const refresh = read("src/app/api/v1/auth/refresh/route.ts");
  assert.match(refresh, /REFRESH_TOKEN_REUSE_DETECTED/);
  assert.match(refresh, /update\(userSessions\)\.set\(\{ revokedAt/);
  assert.doesNotMatch(refresh, /where\(and\(eq\(userSessions\.refreshTokenHash, oldHash\), isNull\(userSessions\.revokedAt\)\)\)/);
});

test("privileged financial endpoints have rate limits", () => {
  const files = [
    "src/app/api/v1/admin/withdrawals/[id]/approve/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/execute/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/process/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/retry/route.ts",
    "src/app/api/v1/admin/arisan/periods/[id]/draw/route.ts",
    "src/app/api/v1/admin/compliance/flags/[id]/route.ts",
    "src/app/api/v1/wallet/topups/[id]/reconcile/route.ts",
  ];
  for (const file of files) assert.match(read(file), /enforceRateLimit/);
});

test("scheduler batches reminder notification inserts", () => {
  const scheduler = read("src/app/api/v1/jobs/run/route.ts");
  assert.match(scheduler, /\.values\(participants\.map/);
  assert.doesNotMatch(scheduler, /for \(const participant of participants\)/);
});

test("audit logs have database-backed hash chain", () => {
  const baseline = read("drizzle/0000_baseline.sql");
  const schema = read("src/db/schema.ts");
  assert.match(schema, /sequenceNo: bigint\("sequence_no"/);
  assert.match(schema, /prevHash: varchar\("prev_hash"/);
  assert.match(schema, /entryHash: varchar\("entry_hash"/);
  assert.match(baseline, /pg_advisory_xact_lock/);
  assert.match(baseline, /audit_logs_set_integrity_hash/);
  assert.match(baseline, /audit_logs_integrity_insert/);
});

test("operational logs redact sensitive fields", () => {
  const logs = read("src/server/services/observability.ts");
  assert.match(logs, /function redact/);
  assert.match(logs, /account.*number/i);
  assert.match(logs, /refresh[_-]?token/i);
});
