import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertDisposableTestDatabase, DISPOSABLE_DATABASE_MARKER } from './test-database-guard.mjs';
import { verifyMigrationFiles } from './deploy/verify-migrations.mjs';

const url = process.env.TEST_DATABASE_URL;
await assertDisposableTestDatabase(url); verifyMigrationFiles();
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const name = `rehearsal_${randomBytes(5).toString('hex')}_test`;
const target = new URL(url); target.pathname = `/${name}`;
mkdirSync('/home/user/.cache', { recursive: true });
const folder = mkdtempSync('/home/user/.cache/arisan-rehearsal-');
let pool;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_DATABASE_MARKER}'`);
  pool = new Pool({ connectionString: target.toString(), max: 2 });
  mkdirSync(join(folder, 'meta'));
  for (const file of ['0000_baseline.sql', '0001_phone_only_registration.sql']) cpSync(join('drizzle', file), join(folder, file));
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')); journal.entries = journal.entries.slice(0, 2);
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: folder });
  const { rows: users } = await pool.query("INSERT INTO users(name,phone,password_hash) VALUES ('SYNTHETIC MIGRATION FIXTURE','+6281198765432','test-only') RETURNING id");
  const { rows: wallets } = await pool.query('INSERT INTO wallets(user_id,available_balance,pending_balance) VALUES ($1,100000,40000) RETURNING id', [users[0].id]);
  const walletId = wallets[0].id;
  for (let n = 0; n < 9; n++) {
    const success = n < 5;
    const { rows: withdrawals } = await pool.query(`INSERT INTO withdrawals(user_id,wallet_id,amount,bank_name,account_name,account_number,idempotency_key,status,attempt_count,last_error_code,last_error_message,processed_at)
      VALUES ($1,$2,10000,'SYNTHETIC BANK','SYNTHETIC','0000000000',$3,$4,1,$5,$6,now()) RETURNING id`,
      [users[0].id, walletId, `SYNTHETIC-ANOMALY-${n}`, success ? 'SUCCESS' : 'FAILED_FINAL', success ? null : 'PROVIDER_RETRYABLE_FAILURE', success ? null : 'Provider payout gagal sementara; dana tetap ditahan untuk retry.']);
    if (!success) {
      await pool.query(`INSERT INTO withdrawal_attempts(withdrawal_id,attempt_number,from_status,to_status,idempotency_key,next_retry_at,created_at) VALUES ($1,1,'PROCESSING','FAILED_RETRYABLE',$2,now()+interval '1 minute',now()-interval '1 minute')`, [withdrawals[0].id, `SYNTHETIC-FAIL-${n}`]);
      await pool.query(`INSERT INTO withdrawal_attempts(withdrawal_id,attempt_number,from_status,to_status,idempotency_key,created_at) VALUES ($1,2,'FAILED_RETRYABLE','PROCESSING',$2,now())`, [withdrawals[0].id, `SYNTHETIC-EARLY-${n}`]);
    }
  }
  const snapshot = async () => ({ withdrawals: (await pool.query('SELECT id,status,amount::text,provider_reference,last_error_code,last_error_message,next_retry_at,attempt_count FROM withdrawals ORDER BY id')).rows, wallet: (await pool.query('SELECT available_balance::text,locked_balance::text,pending_balance::text FROM wallets')).rows });
  const before = await snapshot();
  const blockedEnv={...process.env,DATABASE_URL:target.toString(),MIGRATION_DATABASE_URL:target.toString(),BANK_PII_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),ALLOW_SCHEMA_MIGRATION_APPLY:'',FINANCIAL_WORKERS_PAUSED:''};
  assert.throws(()=>execFileSync(process.execPath,['scripts/deploy/apply-migrations.mjs'],{env:blockedEnv,stdio:'pipe'}),'unapproved migration apply must refuse before mutations');
  assert.throws(()=>execFileSync(process.execPath,['scripts/deploy/apply-migrations.mjs'],{env:{...blockedEnv,ALLOW_SCHEMA_MIGRATION_APPLY:'YES',FINANCIAL_WORKERS_PAUSED:'YES',ALLOW_BANK_PII_INITIAL_ENCRYPTION:''},stdio:'pipe'}),'legacy plaintext encryption requires a separate approved before-0002 plan');
  assert.deepEqual(await snapshot(),before);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count,2);
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  assert.deepEqual(await snapshot(), before, 'migration must not repair status, money, references or failure metadata without external evidence');
  await assert.rejects(() => pool.query('ALTER TABLE withdrawals VALIDATE CONSTRAINT withdrawals_state_metadata_valid'), /violated by some row/);
  const reportText = execFileSync(process.execPath, ['scripts/security/audit-withdrawals.mjs'], { env: { ...process.env, READ_ONLY_AUDIT_DATABASE_URL: target.toString(), AUDIT_OUTPUT_FILE: '' }, encoding: 'utf8' });
  const report = JSON.parse(reportText);
  assert.equal(report.status, 'BLOCKED'); assert.equal(report.matches, 9);
  assert.equal(report.findings.filter((row) => row.status === 'SUCCESS' && !row.provider_reference).length, 5);
  assert.equal(report.findings.filter((row) => row.status === 'FAILED_FINAL' && row.last_error_code === 'PROVIDER_RETRYABLE_FAILURE').length, 4);
  assert.deepEqual(await snapshot(), before, 'read-only audit must not move funds or change states');
  if (process.env.REHEARSAL_OUTPUT_FILE) writeFileSync(process.env.REHEARSAL_OUTPUT_FILE, JSON.stringify({ syntheticFixture: true, notTheUsersActualNineWithdrawals: true, report }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'PASS', syntheticFixture: true, scenarios: ['existing repository baseline+0001 upgrade', 'nine anomaly rows unchanged', 'five missing external references', 'four inconsistent final failure metadata', 'premature retry evidence retained', 'legacy constraint validation correctly blocked', 'read-only audit made no changes', 'unapproved migration and unapproved plaintext backfill refused'], externalEvidence: 'BLOCKED', migrations: verifyMigrationFiles().length }));
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
  await admin.end(); rmSync(folder, { recursive: true, force: true });
}
