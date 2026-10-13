import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";

const adminRoutePath = resolve(
  process.cwd(),
  "src/app/api/v1/admin/privacy/requests/route.ts",
);
const exportRoutePath = resolve(
  process.cwd(),
  "src/app/api/v1/privacy/export/route.ts",
);
const retentionPath = resolve(
  process.cwd(),
  "scripts/compliance-retention-enforce.sh",
);

async function readSource(path: string) {
  return readFile(path, "utf8");
}

test("ERASURE anonymizes withdrawal bank PII without deleting financial history", async () => {
  const source = await readSource(adminRoutePath);

  assert.match(source, /update\(withdrawals\)/);
  assert.match(source, /bankName: "\[REDACTED\]"/);
  assert.match(source, /accountName: "\[REDACTED\]"/);
  assert.match(source, /accountNumber: "\[REDACTED\]"/);
  assert.doesNotMatch(source, /delete\(withdrawals\)/);
  assert.doesNotMatch(source, /delete\(walletTransactions\)/);
  assert.doesNotMatch(source, /delete\(financialTransactions\)/);
});

test("ERASURE invalidates credentials and clears verification PII", async () => {
  const source = await readSource(adminRoutePath);

  assert.match(source, /passwordHash: "ERASED"/);
  assert.match(source, /status: "SUSPENDED"/);
  assert.match(source, /phoneVerifiedAt: null/);
  assert.match(source, /kycVerifiedAt: null/);
  assert.match(source, /kycReviewedAt: null/);
  assert.match(source, /kycReviewedBy: null/);
  assert.match(source, /kycRejectionReason: null/);
  assert.match(source, /update\(userSessions\)/);
  assert.match(source, /revokedAt: now/);
});

test("privacy export is an allow-list and excludes credentials and bank-account PII", async () => {
  const source = await readSource(exportRoutePath);

  assert.match(source, /const \[profile\]/);
  assert.match(source, /name:users\.name/);
  assert.match(source, /email:users\.email/);
  assert.doesNotMatch(source, /passwordHash/);
  assert.doesNotMatch(source, /refreshTokenHash/);
  assert.doesNotMatch(source, /bankName/);
  assert.doesNotMatch(source, /accountName/);
  assert.doesNotMatch(source, /accountNumber/);
  assert.doesNotMatch(source, /\.select\(\*\)/);
});

test("privacy export scopes every exported user-owned collection to the authenticated user", async () => {
  const source = await readSource(exportRoutePath);

  const userFilters = (source.match(/eq\((?:walletTransactions|withdrawals|notifications|privacyConsents|privacyRequests)\.userId,user\.id\)/g) ?? []);
  assert.equal(
    userFilters.length,
    5,
    "all user-owned export collections must filter by the authenticated user id",
  );
  assert.match(source, /const user=await requireUser\(request\)/);
});

test("retention enforcement deletes only ephemeral state and anonymizes erased-user PII", async () => {
  const source = await readSource(retentionPath);

  assert.match(source, /DELETE FROM user_sessions/);
  assert.match(source, /DELETE FROM rate_limit_buckets/);
  assert.match(source, /UPDATE users/);
  assert.match(source, /password_hash = 'ERASED'/);
  assert.match(source, /UPDATE withdrawals w/);
  assert.match(source, /bank_name = '\[REDACTED\]'/);
  assert.doesNotMatch(source, /DELETE FROM wallet_transactions/i);
  assert.doesNotMatch(source, /DELETE FROM financial_transactions/i);
  assert.doesNotMatch(source, /DELETE FROM withdrawals/i);
  assert.doesNotMatch(source, /DELETE FROM audit_logs/i);
});

test("retention policy is configurable independently for sessions and PII", async () => {
  const source = await readSource(retentionPath);

  assert.match(source, /COMPLIANCE_SESSION_RETENTION_DAYS:-90/);
  assert.match(source, /COMPLIANCE_PII_RETENTION_DAYS:-90/);
  assert.match(source, /session_days/);
  assert.match(source, /pii_days/);
});

test("retention report classifies financial and audit records as retained", async () => {
  const reportPath = resolve(
    process.cwd(),
    "scripts/compliance-retention-report.sh",
  );
  const source = await readSource(reportPath);

  assert.match(source, /auditRecords/);
  assert.match(source, /walletTransactions/);
  assert.match(source, /financialTransactions/);
  assert.match(source, /complianceFlags/);
  assert.match(source, /eligibleErasedUsersForPiiAnonymization/);
  assert.match(source, /eligibleWithdrawalPiiRows/);
});
