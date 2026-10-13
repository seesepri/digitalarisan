import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// This tool NEVER calls a provider, updates status/balances, retries a payout or refunds funds.
const url = process.env.READ_ONLY_AUDIT_DATABASE_URL;
if (!url) throw new Error('READ_ONLY_AUDIT_DATABASE_URL is required; use a least-privilege read-only credential');
const ids = process.argv.slice(2);
if (ids.length > 100 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('Pass up to 100 real withdrawal UUIDs, or no IDs to discover anomalies');
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '30s'");
  const { rows } = await client.query(`
    SELECT w.id, w.wallet_id, w.amount::text, w.status, w.approval_status, w.risk_status,
      w.provider_reference, to_jsonb(w)->>'provider' AS provider, w.attempt_count,
      w.last_error_code, w.last_error_message, w.next_retry_at, w.processed_at, w.created_at,
      COUNT(*) OVER ()::int AS total_matches
    FROM withdrawals w
    WHERE ($1::uuid[] IS NOT NULL AND w.id = ANY($1::uuid[])) OR ($1::uuid[] IS NULL AND (
      (w.status = 'SUCCESS' AND (w.provider_reference IS NULL OR btrim(w.provider_reference) = ''))
      OR (w.status = 'FAILED_FINAL' AND (w.last_error_code = 'PROVIDER_RETRYABLE_FAILURE' OR w.last_error_message ILIKE '%dana tetap ditahan%'))
      OR (w.status = 'FAILED_RETRYABLE' AND w.next_retry_at IS NULL)
      OR EXISTS (SELECT 1 FROM withdrawal_attempts f JOIN withdrawal_attempts r ON r.withdrawal_id = f.withdrawal_id
        AND r.attempt_number = f.attempt_number + 1 AND r.to_status = 'PROCESSING' AND r.from_status = 'FAILED_RETRYABLE'
        WHERE f.withdrawal_id = w.id AND f.to_status = 'FAILED_RETRYABLE' AND r.created_at < f.next_retry_at)
    )) ORDER BY w.created_at, w.id LIMIT 200
  `, [ids.length ? ids : null]);
  const findings = [];
  for (const row of rows) {
    const [attempts, ledger, audit, wallet] = [
      await client.query('SELECT attempt_number, from_status, to_status, provider_reference, error_code, error_message, next_retry_at, created_at FROM withdrawal_attempts WHERE withdrawal_id=$1 ORDER BY attempt_number, created_at, id', [row.id]),
      await client.query('SELECT id, type, direction, amount::text, available_before::text, available_after::text, locked_before::text, locked_after::text, pending_before::text, pending_after::text, idempotency_key, reversal_of_id, created_at FROM wallet_transactions WHERE reference_type=\'withdrawal\' AND reference_id=$1 ORDER BY created_at, id', [row.id]),
      await client.query("SELECT sequence_no::text, action, old_value->>'status' AS old_status, new_value->>'status' AS new_status, new_value->>'attemptCount' AS attempt_count, entry_hash, prev_hash, created_at FROM audit_logs WHERE entity_type='withdrawal' AND entity_id=$1 ORDER BY sequence_no", [row.id]),
      await client.query("SELECT id, available_balance::text, locked_balance::text, pending_balance::text, (SELECT COALESCE(SUM(amount),0)::text FROM withdrawals WHERE wallet_id=wallets.id AND status IN ('PENDING','PROCESSING','FAILED_RETRYABLE')) AS expected_pending, (SELECT COALESCE(SUM(amount),0)::text FROM wallet_reservations WHERE wallet_id=wallets.id AND status='ACTIVE') AS expected_locked FROM wallets WHERE id=$1", [row.wallet_id]),
    ];
    findings.push({ ...row, total_matches: undefined,
      derived_request_reference_not_external_receipt: `WD-${createHash('sha256').update(row.id).digest('hex').slice(0, 32)}`,
      attempts: attempts.rows, local_ledger: ledger.rows, local_audit: audit.rows, wallet_snapshot: wallet.rows[0],
      external_transfer_verification: 'BLOCKED',
      required_external_evidence: ['provider merchant/request reference lookup', 'provider receipt/reference', 'amount and IDR currency', 'bank/provider transfer settlement or explicitly confirmed non-transfer', 'provider logs including idempotency and timestamps'],
    });
  }
  await client.query('ROLLBACK');
  const report = { status: 'BLOCKED', mode: 'READ_ONLY_LOCAL_EVIDENCE', generated_at: new Date().toISOString(), matches: rows[0]?.total_matches ?? 0, returned: findings.length, truncated: (rows[0]?.total_matches ?? 0) > findings.length,
    warning: 'Database SUCCESS is not proof of an external transfer. No statuses, balances, retries, refunds or provider operations were performed. No bank PII is exported.', findings };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (process.env.AUDIT_OUTPUT_FILE) { writeFileSync(process.env.AUDIT_OUTPUT_FILE, text, { mode: 0o600 }); console.log(JSON.stringify({ status: report.status, matches: report.matches, outputSha256: createHash('sha256').update(text).digest('hex') })); }
  else console.log(text);
} finally { client.release(); await pool.end(); }
