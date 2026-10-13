import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { assertDisposableTestDatabase } from './test-database-guard.mjs';
import { verifyMigrationFiles } from './deploy/verify-migrations.mjs';

const url = process.env.TEST_DATABASE_URL;
await assertDisposableTestDatabase(url);
verifyMigrationFiles();
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, MIGRATION_DATABASE_URL: url,
  AUTH_SECRET: 'isolated-test-only-not-a-production-secret', BANK_PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYMENT_PROVIDER: 'unconfigured', PAYOUT_PROVIDER: 'unconfigured', NEXT_TELEMETRY_DISABLED: '1', ALLOW_EMPTY_DATABASE_BOOTSTRAP: 'YES' };
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Test gate failed (${result.status}): ${args.join(' ')}`);
}
run(['scripts/deploy/migration-state-check.mjs']);
run(['node_modules/drizzle-kit/bin.cjs', 'migrate']);
const suites = process.argv.slice(2);
const files = suites.length ? suites : ['tests/concurrency-idempotency.test.ts', 'tests/crash-restart-recovery.test.ts', 'tests/integration-financial.test.ts', 'tests/financial-integrity.integration.test.ts', 'tests/financial-integrity-extra.integration.test.ts'];
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const constraints = await pool.query("SELECT conrelid::regclass::text AS table_name, conname FROM pg_constraint WHERE NOT convalidated AND connamespace='public'::regnamespace");
  for (const row of constraints.rows) await pool.query(`ALTER TABLE ${row.table_name} VALIDATE CONSTRAINT "${row.conname.replaceAll('"', '""')}"`);
  console.log(`[isolated-test] validated ${constraints.rows.length} added constraints`);
  for (const file of files) {
    // This is intentionally destructive ONLY after URL + environment + explicit consent + database marker checks.
    await pool.query(`DO $$ DECLARE item record; BEGIN FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', item.tablename); END LOOP; END $$`);
    console.log(`\n[isolated-test] ${file}`);
    run(['--import', 'tsx', '--test', '--test-concurrency=1', file]);
  }
} finally { await pool.end(); }
