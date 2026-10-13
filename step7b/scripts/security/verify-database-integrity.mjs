import { Pool } from 'pg';
const url = process.env.READ_ONLY_AUDIT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Read-only database URL is required');
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  const checks = {
    invalid_money: `SELECT count(*)::int AS count FROM wallets WHERE available_balance<0 OR locked_balance<0 OR pending_balance<0 OR available_balance+locked_balance+pending_balance>9007199254740991`,
    negative_or_unsafe_accounts: `SELECT count(*)::int AS count FROM financial_accounts WHERE balance<0 OR balance>9007199254740991`,
    pending_mismatch: `SELECT count(*)::int AS count FROM wallets w WHERE w.pending_balance<>(SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE wallet_id=w.id AND status IN ('PENDING','PROCESSING','FAILED_RETRYABLE'))`,
    locked_mismatch: `SELECT count(*)::int AS count FROM wallets w WHERE w.locked_balance<>(SELECT COALESCE(SUM(amount),0) FROM wallet_reservations WHERE wallet_id=w.id AND status='ACTIVE')`,
    wallet_ledger_closing: `SELECT count(*)::int AS count FROM wallets w LEFT JOIN LATERAL (SELECT * FROM wallet_transactions WHERE wallet_id=w.id ORDER BY ledger_sequence DESC LIMIT 1) t ON true WHERE w.available_balance<>COALESCE(t.available_after,0) OR w.locked_balance<>COALESCE(t.locked_after,0) OR w.pending_balance<>COALESCE(t.pending_after,0)`,
    account_ledger_closing: `SELECT count(*)::int AS count FROM financial_accounts a LEFT JOIN LATERAL (SELECT * FROM financial_transactions WHERE account_id=a.id ORDER BY ledger_sequence DESC LIMIT 1) t ON true WHERE a.balance<>COALESCE(t.balance_after,0)`,
    wallet_ledger_chain: `SELECT count(*)::int AS count FROM (SELECT available_before,locked_before,pending_before,lag(available_after,1,0::bigint) OVER w AS prev_available,lag(locked_after,1,0::bigint) OVER w AS prev_locked,lag(pending_after,1,0::bigint) OVER w AS prev_pending FROM wallet_transactions WINDOW w AS (PARTITION BY wallet_id ORDER BY ledger_sequence)) t WHERE available_before<>prev_available OR locked_before<>prev_locked OR pending_before<>prev_pending`,
    account_ledger_chain: `SELECT count(*)::int AS count FROM (SELECT balance_before,lag(balance_after,1,0::bigint) OVER (PARTITION BY account_id ORDER BY ledger_sequence) AS prev FROM financial_transactions) t WHERE balance_before<>prev`,
    unverified_terminal_withdrawals: `SELECT count(*)::int AS count FROM withdrawals WHERE status IN ('SUCCESS','FAILED_RETRYABLE','FAILED_FINAL') AND (provider IS NULL OR provider_reference IS NULL OR btrim(provider_reference)='' OR last_provider_evidence IS NULL OR last_provider_evidence->>'reference' IS DISTINCT FROM 'WD-'||substr(encode(digest(id::text,'sha256'),'hex'),1,32) OR last_provider_evidence->>'providerReference' IS DISTINCT FROM provider_reference OR last_provider_evidence->>'provider' IS DISTINCT FROM provider OR last_provider_evidence->>'amount' IS DISTINCT FROM amount::text OR last_provider_evidence->>'currency' IS DISTINCT FROM 'IDR' OR (status='SUCCESS' AND last_provider_evidence->>'status' IS DISTINCT FROM 'SUCCESS') OR (status IN ('FAILED_RETRYABLE','FAILED_FINAL') AND last_provider_evidence->>'failureConfirmed' IS DISTINCT FROM 'true'))`,
    unvalidated_constraints: `SELECT count(*)::int AS count FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated`,
  };
  const results = {};
  for (const [name, query] of Object.entries(checks)) results[name] = (await client.query(query)).rows[0].count;
  await client.query('ROLLBACK');
  const passed = Object.values(results).every((count) => count === 0);
  console.log(JSON.stringify({ status: passed ? 'PASS' : 'FAIL', mode: 'READ_ONLY_LOCAL_INTEGRITY_ONLY', checks: results, externalTransferVerification: 'BLOCKED', legacyCausalHistoryCertification: 'NOT_TESTED' }, null, 2));
  if (!passed) process.exitCode = 1;
} finally { client.release(); await pool.end(); }
