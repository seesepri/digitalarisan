import { Pool } from "pg";
import { randomBytes, createCipheriv } from "node:crypto";
const url = process.env.DATABASE_URL;
const keyRaw = process.env.BANK_PII_ENCRYPTION_KEY?.trim();
if (!url) throw new Error("DATABASE_URL is required");
if (!keyRaw) throw new Error("BANK_PII_ENCRYPTION_KEY is required");
const key = Buffer.from(keyRaw, "base64");
if (key.length !== 32) throw new Error("BANK_PII_ENCRYPTION_KEY must decode to 32 bytes");
function encrypt(value) {
  if (!value || value.startsWith("enc:v1:")) return value;
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}
const pool = new Pool({ connectionString: url, max: 2 });
try {
  await pool.query("BEGIN");
  const { rows } = await pool.query("SELECT id, bank_name, account_name, account_number FROM withdrawals FOR UPDATE");
  for (const row of rows) await pool.query("UPDATE withdrawals SET bank_name=$1, account_name=$2, account_number=$3 WHERE id=$4", [encrypt(row.bank_name), encrypt(row.account_name), encrypt(row.account_number), row.id]);
  await pool.query("COMMIT");
  console.log(JSON.stringify({ migrated: rows.length }));
} catch (error) { await pool.query("ROLLBACK").catch(() => undefined); throw error; }
finally { await pool.end(); }
