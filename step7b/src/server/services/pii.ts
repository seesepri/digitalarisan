import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.BANK_PII_ENCRYPTION_KEY?.trim();
  if (!raw && process.env.NODE_ENV !== "production" && process.env.AUTH_SECRET) {
    return createHash("sha256").update(process.env.AUTH_SECRET).digest();
  }
  if (!raw) throw new Error("BANK_PII_ENCRYPTION_KEY is not configured");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch { /* fall through */ }
  throw new Error("BANK_PII_ENCRYPTION_KEY must be base64 for 32 bytes");
}

export function encryptBankPii(value: string): string {
  if (!value) return value;
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function decryptBankPii(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  try {
    const packed = Buffer.from(value.slice(PREFIX.length), "base64url");
    if (packed.length < 28) throw new Error("ciphertext too short");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Bank account PII decryption failed");
  }
}

export function hashBankPii(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function maskAccountNumber(value: string): string {
  const plain = decryptBankPii(value);
  if (plain.length <= 4) return "••••";
  return `${"•".repeat(Math.max(4, plain.length - 4))}${plain.slice(-4)}`;
}

export function safeWithdrawalView(withdrawal: { id: string; amount: number; status: string; approvalStatus: string; riskStatus: string; bankName: string; accountName: string; accountNumber: string; createdAt?: Date | null; [key: string]: unknown }) {
  return {
    id: withdrawal.id,
    amount: withdrawal.amount,
    status: withdrawal.status,
    approvalStatus: withdrawal.approvalStatus,
    riskStatus: withdrawal.riskStatus,
    bankName: decryptBankPii(withdrawal.bankName),
    accountName: decryptBankPii(withdrawal.accountName),
    accountNumber: maskAccountNumber(withdrawal.accountNumber),
    createdAt: withdrawal.createdAt ?? null,
  };
}
