import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertDisposableTestDatabase, DISPOSABLE_DATABASE_MARKER } from './test-database-guard.mjs';
import { verifyMigrationFiles } from './deploy/verify-migrations.mjs';

const url = process.env.TEST_DATABASE_URL; await assertDisposableTestDatabase(url); verifyMigrationFiles();
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const id = randomBytes(5).toString('hex'); const sourceName = `dr_source_${id}_test`; const targetName = `dr_restore_${id}_test`;
const sourceUrl = new URL(url); sourceUrl.pathname = `/${sourceName}`; const targetUrl = new URL(url); targetUrl.pathname = `/${targetName}`;
mkdirSync('/home/user/.cache', { recursive: true }); const folder = mkdtempSync('/home/user/.cache/arisan-dr-');
const env = { ...process.env, NODE_ENV: 'test', TEST_DB_ALLOW_RESET: 'YES', AUTH_SECRET: 'isolated-test-only-not-a-production-secret', BANK_PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const run = (command, args, extra = {}) => execFileSync(command, args, { env: { ...env, ...extra }, encoding: 'utf8' });
let source; let target;
const started = performance.now();
try {
  for (const name of [sourceName, targetName]) { await admin.query(`CREATE DATABASE "${name}"`); await admin.query(`COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_DATABASE_MARKER}'`); }
  source = new Pool({ connectionString: sourceUrl.toString(), max: 1 }); target = new Pool({ connectionString: targetUrl.toString(), max: 1 });
  console.log(run(process.execPath,['scripts/deploy/apply-migrations.mjs'],{DATABASE_URL:sourceUrl.toString(),MIGRATION_DATABASE_URL:sourceUrl.toString(),ALLOW_SCHEMA_MIGRATION_APPLY:'YES',FINANCIAL_WORKERS_PAUSED:'YES',ALLOW_EMPTY_DATABASE_BOOTSTRAP:'YES'}).trim());
  const { rows: constraints } = await source.query("SELECT conrelid::regclass::text AS table_name,conname FROM pg_constraint WHERE NOT convalidated AND connamespace='public'::regnamespace");
  for (const row of constraints) await source.query(`ALTER TABLE ${row.table_name} VALIDATE CONSTRAINT "${row.conname}"`);
  console.log(run(process.execPath, ['--import','tsx','tests/fixtures/dr-financial-fixture.ts'], { TEST_DATABASE_URL: sourceUrl.toString() }).trim());
  const snapshot = async (pool) => {
    const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename");
    const data = {};
    for (const row of rows) { const schema = row.tablename === '__drizzle_migrations' ? 'drizzle' : 'public'; const result = await pool.query(`SELECT to_jsonb(t) AS row FROM "${schema}"."${row.tablename}" t ORDER BY to_jsonb(t)::text`); data[`${schema}.${row.tablename}`] = result.rows.map((item) => item.row); }
    return data;
  };
  const before = await snapshot(source); assert.equal(before['public.wallet_transactions'].length, 3);
  const unrelated = join(folder, 'must-not-delete.txt'); writeFileSync(unrelated, 'unrelated data'); const old = new Date(Date.now() - 40*86400000); utimesSync(unrelated, old, old);
  console.log(run('bash', ['scripts/backup-postgres.sh'], { DATABASE_URL: sourceUrl.toString(), BACKUP_DIR: folder, BACKUP_RETENTION_DAYS: '1' }).trim());
  assert.equal(existsSync(unrelated), true, 'backup retention must not delete arbitrary old files');
  const archive = join(folder, readdirSync(folder).find((file) => file.endsWith('.dump')));
  const corrupt = join(folder, 'corrupt.dump'); copyFileSync(archive, corrupt); copyFileSync(`${archive}.sha256`, `${corrupt}.sha256`); const bytes = readFileSync(corrupt); bytes[0] ^= 1; writeFileSync(corrupt, bytes);
  const restoreEnv = { DATABASE_URL: targetUrl.toString(), RESTORE_ISOLATED_TARGET_CONFIRMED: 'YES', RESTORE_TARGET_DATABASE: targetName };
  assert.throws(() => run('bash', ['scripts/restore-postgres.sh', corrupt], restoreEnv));
  assert.equal((await target.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")).rows[0].count, 0);
  console.log(run('bash', ['scripts/restore-postgres.sh', archive], restoreEnv).trim());
  const after = await snapshot(target); assert.deepEqual(after, before, 'all table rows, balances, statuses, references, sequences and journal must be preserved');
  assert.throws(() => run('bash', ['scripts/restore-postgres.sh', archive], restoreEnv), 'second restore into nonempty target must refuse, not drop public');
  console.log(run(process.execPath, ['--import','tsx','tests/fixtures/dr-financial-fixture.ts','--verify-only'], { TEST_DATABASE_URL: targetUrl.toString() }).trim());
  console.log(run('bash', ['scripts/dr/verify-restored-db.sh'], { DATABASE_URL: targetUrl.toString(), MIGRATION_DATABASE_URL: targetUrl.toString() }).trim());
  const report = { status: 'PASS', syntheticFixture: true, originalFinancialDataTouched: false, logicalRowsSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'), tables: Object.keys(before).length, walletTransactions: before['public.wallet_transactions'].length, auditLogs: before['public.audit_logs'].length, labDurationMs: Math.round(performance.now()-started), checks: ['nonzero balances and provider-evidenced mock payout preserved', 'every logical table row and migration journal identical', 'encrypted bank data decrypts with original test key', 'audit hash chain matches', '10 local financial integrity checks', 'corrupt archive refused before target writes', 'nonempty restore target refused', 'retention does not delete unrelated files'], productionRpoRtoAndPitr: 'BLOCKED', originalKeyRecovery: 'BLOCKED', actualProviderSettlement: 'BLOCKED' };
  if (process.env.DR_REHEARSAL_OUTPUT_FILE) writeFileSync(process.env.DR_REHEARSAL_OUTPUT_FILE, JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  if (source) await source.end(); if (target) await target.end();
  for (const name of [sourceName,targetName]) await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
  await admin.end(); rmSync(folder,{ recursive:true,force:true });
}
