import { Pool } from 'pg';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const url = process.env.DATABASE_URL;
const raw = process.env.BANK_PII_ENCRYPTION_KEY?.trim();
if (!url || !raw) throw new Error('DATABASE_URL and BANK_PII_ENCRYPTION_KEY are required');
const key = Buffer.from(raw, 'base64'); if (key.length !== 32) throw new Error('BANK_PII_ENCRYPTION_KEY must decode to 32 bytes');
const apply = process.argv.includes('--apply');
if (apply && process.env.ALLOW_BANK_PII_INITIAL_ENCRYPTION !== 'YES') throw new Error('BLOCKED: explicit initial-encryption approval is required; this is NOT a key-rotation tool');
function verify(value) {
  if (!value.startsWith('enc:v1:')) return;
  const packed = Buffer.from(value.slice(7), 'base64url');
  if (packed.length < 28) throw new Error('Invalid historical ciphertext');
  const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12)); cipher.setAuthTag(packed.subarray(12, 28)); cipher.update(packed.subarray(28)); cipher.final();
}
function encrypt(value) {
  if (!value || value.startsWith('enc:v1:')) return value;
  if (/^enc:/i.test(value)) throw new Error('Unsupported historical ciphertext version');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}
const pool = new Pool({ connectionString: url, max: 1 }); const client = await pool.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='60s'");
  const { rows } = await client.query(`SELECT id,bank_name,account_name,account_number FROM withdrawals${apply ? ' FOR UPDATE' : ''}`);
  const plaintext = rows.filter((row) => ['bank_name','account_name','account_number'].some((name) => !row[name].startsWith('enc:v1:')));
  for (const row of rows) for (const name of ['bank_name','account_name','account_number']) { verify(row[name]); if (/^enc:/i.test(row[name]) && !row[name].startsWith('enc:v1:')) throw new Error('Unsupported historical ciphertext'); }
  if (apply && plaintext.length) {
    const { rows: guards } = await client.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='withdrawals'::regclass AND tgname='withdrawals_retry_transition_guard'");
    if (guards[0].count) throw new Error('BLOCKED: immutable recipient guard is installed. Initial plaintext encryption must be planned/rehearsed BEFORE migration 0002 while workers/financial traffic are frozen; never disable guards to force this script');
    for (const row of plaintext) await client.query('UPDATE withdrawals SET bank_name=$1,account_name=$2,account_number=$3 WHERE id=$4', [encrypt(row.bank_name),encrypt(row.account_name),encrypt(row.account_number),row.id]);
  }
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode: apply ? 'APPROVED_INITIAL_ENCRYPTION' : 'READ_ONLY_DRY_RUN', rows: rows.length, plaintextRows: plaintext.length, changed: apply ? plaintext.length : 0, keyRotation: 'BLOCKED', warning: 'No statuses, balances or financial retry/refund operations are changed. Keep original keys with retained backups.' }));
} catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
finally { client.release(); await pool.end(); }
