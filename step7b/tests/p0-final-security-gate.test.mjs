import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(p,'utf8');

test('provider reconciliation uses provider SUCCESS as authoritative and finalizes through processWithdrawal', () => {
  const s = read('src/server/services/reconciliation.ts');
  assert.match(s, /status\.status === "SUCCESS"/);
  assert.match(s, /processWithdrawal\(\{[\s\S]*decision: "SUCCESS"/);
  assert.match(s, /finalized\.replayed/);
});

test('admin audit log API redacts sensitive old/new values', () => {
  const s = read('src/app/api/v1/admin/audit-logs/route.ts');
  assert.match(s, /redactAuditValue/);
  assert.match(s, /oldValue: redactAuditValue/);
  assert.match(s, /newValue: redactAuditValue/);
});

test('privacy data-subject workflow exists', () => {
  assert.ok(existsSync('src/app/api/v1/privacy/requests/route.ts'));
  assert.ok(existsSync('src/app/api/v1/privacy/export/route.ts'));
  assert.ok(existsSync('src/app/api/v1/privacy/consent/route.ts'));
  assert.ok(existsSync('src/app/api/v1/admin/privacy/requests/route.ts'));
  const baseline = read('drizzle/0000_baseline.sql');
  assert.match(baseline, /CREATE TABLE "privacy_requests"/);
  assert.match(baseline, /CREATE TABLE "privacy_consents"/);
});

test('metrics route normalizes UUID/numeric path identifiers', () => {
  const s = read('src/server/metrics.ts');
  assert.match(s, /normalizeRoute/);
  assert.match(s, /normalizeRoute\(route\)/);
  assert.match(s, /\.replace\(\/\\b\[0-9a-f\]\{8\}/);
});

test('retention enforcement is explicit and only removes operational ephemeral data', () => {
  const s = read('scripts/compliance-retention-enforce.sh');
  assert.match(s, /DELETE FROM user_sessions/);
  assert.match(s, /DELETE FROM rate_limit_buckets/);
  assert.doesNotMatch(s, /DELETE FROM audit_logs/);
  assert.doesNotMatch(s, /DELETE FROM financial_transactions/);
});
