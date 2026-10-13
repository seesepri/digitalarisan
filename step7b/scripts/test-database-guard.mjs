import { Pool } from 'pg';

export const DISPOSABLE_DATABASE_MARKER = 'digitalarisan:disposable-test';
export function assertIsolatedTestDatabaseUrl(value) {
  if (!value) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is never a test fallback');
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/^[a-z][a-z0-9_]*_test$/.test(name) || url.search || url.hash) {
    throw new Error('BLOCKED: tests require a loopback PostgreSQL database explicitly named *_test, without URL overrides');
  }
  return value;
}
export async function assertDisposableTestDatabase(value) {
  assertIsolatedTestDatabaseUrl(value);
  if (process.env.NODE_ENV === 'production') throw new Error('BLOCKED: financial tests must never run with NODE_ENV=production');
  if (process.env.TEST_DB_ALLOW_RESET !== 'YES') throw new Error('TEST_DB_ALLOW_RESET=YES is required for the disposable database');
  const pool = new Pool({ connectionString: value, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await pool.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()");
    if (rows[0]?.marker !== DISPOSABLE_DATABASE_MARKER) throw new Error('BLOCKED: test database lacks its disposable marker; do not reset an unverified database');
  } finally { await pool.end(); }
}
export async function configureTestDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  await assertDisposableTestDatabase(url);
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'isolated-test-only-not-a-production-secret';
  process.env.BANK_PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  return url;
}
