import { Pool } from 'pg';
import { randomBytes, createCipheriv } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const url = process.env.DATABASE_URL;
const piiKeyRaw = process.env.BANK_PII_ENCRYPTION_KEY?.trim();
if (!url) throw new Error('DATABASE_URL is required');
if (!piiKeyRaw) throw new Error('BANK_PII_ENCRYPTION_KEY is required for production migration');
const piiKey = Buffer.from(piiKeyRaw, 'base64');
if (piiKey.length !== 32) throw new Error('BANK_PII_ENCRYPTION_KEY must decode to exactly 32 bytes');

function encrypt(value) {
  if (!value || value.startsWith('enc:v1:')) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', piiKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

const pool = new Pool({ connectionString: url, max: 2 });
try {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, bank_name, account_name, account_number FROM withdrawals FOR UPDATE');
    for (const row of rows) {
      await client.query(
        'UPDATE withdrawals SET bank_name=$1, account_name=$2, account_number=$3 WHERE id=$4',
        [encrypt(row.bank_name), encrypt(row.account_name), encrypt(row.account_number), row.id],
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ bankPiiMigrated: rows.length }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  console.log('Database migrations and bank PII protection applied successfully.');
} finally { await pool.end(); }
