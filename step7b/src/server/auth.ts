import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });

type AccessClaims = { sub: string; sid: string; exp: number; iat: number };

const globalSecrets = globalThis as typeof globalThis & { __seearisanDevAuthSecret?: string };

function getSecret(): string {
  const configured = process.env.AUTH_SECRET ?? process.env.JWT_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be configured with at least 32 characters");
  }
  globalSecrets.__seearisanDevAuthSecret ??= randomBytes(48).toString("base64url");
  return globalSecrets.__seearisanDevAuthSecret;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltEncoded, hashEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltEncoded || !hashEncoded) return false;
  try {
    const expected = Buffer.from(hashEncoded, "base64url");
    const actual = await scrypt(password, Buffer.from(saltEncoded, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function createAccessToken(userId: string, sessionId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims: AccessClaims = { sub: userId, sid: sessionId, iat: now, exp: now + ACCESS_TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(sign(unsigned));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AccessClaims;
    if (header.alg !== "HS256" || !claims.sub || !claims.sid || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function createRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const accessTokenMaxAge = ACCESS_TTL_SECONDS;
export const refreshTokenMaxAge = REFRESH_TTL_SECONDS;

export function cookieHeader(name: string, value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearAuthCookies(): string[] {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return [
    `access_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `refresh_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ];
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeaderValue = request.headers.get("cookie");
  if (!cookieHeaderValue) return null;
  for (const item of cookieHeaderValue.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
