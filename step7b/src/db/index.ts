import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
};

const poolOptions = (connectionString: string) => ({
  connectionString,
  max: intEnv("DB_POOL_MAX", 20, 1, 200),
  min: intEnv("DB_POOL_MIN", 0, 0, 50),
  idleTimeoutMillis: intEnv("DB_IDLE_TIMEOUT_MS", 30_000, 1_000, 600_000),
  connectionTimeoutMillis: intEnv("DB_CONNECTION_TIMEOUT_MS", 5_000, 250, 120_000),
  maxLifetimeSeconds: intEnv("DB_MAX_LIFETIME_SECONDS", 1_800, 60, 86_400),
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  statement_timeout: intEnv("DB_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 300_000),
  query_timeout: intEnv("DB_QUERY_TIMEOUT_MS", 35_000, 1_000, 300_000),
});

type DbGlobals = typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlReadPool?: Pool;
};
const globals = globalThis as DbGlobals;

const pool = globals.__arenaNextJsPostgresqlPool ?? new Pool(poolOptions(databaseUrl));
if (!globals.__arenaNextJsPostgresqlPool) globals.__arenaNextJsPostgresqlPool = pool;

// READ_DATABASE_URL is optional. When configured, explicitly safe/read-only queries can use
// a replica without changing transactional financial flows. Never use readDb inside writes.
const readDatabaseUrl = process.env.READ_DATABASE_URL;
const readPool = readDatabaseUrl
  ? globals.__arenaNextJsPostgresqlReadPool ?? new Pool(poolOptions(readDatabaseUrl))
  : pool;
if (readDatabaseUrl && !globals.__arenaNextJsPostgresqlReadPool) globals.__arenaNextJsPostgresqlReadPool = readPool;

export { pool, readPool };
export const db = drizzle(pool);
export const readDb = drizzle(readPool);
export const readDatabaseConfigured = Boolean(readDatabaseUrl);
