import { Pool } from 'pg';
import { verifyMigrationFiles } from './verify-migrations.mjs';

const migrations = verifyMigrationFiles();
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10s'");
  const { rows: locations } = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS journal, to_regclass('public.__drizzle_migrations') AS legacy_journal");
  if (locations[0].legacy_journal && !locations[0].journal) throw new Error('BLOCKED: legacy migration journal needs a reviewed baseline-adoption plan');
  if (!locations[0].journal) {
    const { rows } = await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    if (rows[0].count > 0) throw new Error('BLOCKED: existing schema has no verified migration journal; do not bootstrap the squashed baseline');
    if (process.env.ALLOW_EMPTY_DATABASE_BOOTSTRAP !== 'YES') throw new Error('BLOCKED: empty bootstrap requires ALLOW_EMPTY_DATABASE_BOOTSTRAP=YES');
    if (process.env.REQUIRE_ALL_MIGRATIONS_APPLIED === 'YES') throw new Error('BLOCKED: application promotion requires an already migrated database');
    console.log(JSON.stringify({ status: 'PASS', mode: 'EXPLICIT_EMPTY_BOOTSTRAP', pending: migrations.length }));
  } else {
    const { rows } = await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id');
    if (rows.length > migrations.length) throw new Error('BLOCKED: database journal is ahead of this release');
    rows.forEach((row, index) => {
      if (row.hash !== migrations[index].hash || Number(row.created_at) !== migrations[index].when) throw new Error(`BLOCKED: applied migration differs from this release at index ${index}; never edit an applied migration`);
    });
    if (process.env.REQUIRE_ALL_MIGRATIONS_APPLIED === 'YES' && rows.length !== migrations.length) throw new Error('BLOCKED: pending schema migrations must be reviewed/applied before app promotion');
    console.log(JSON.stringify({ status: 'PASS', applied: rows.length, pending: migrations.length - rows.length }));
  }
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
