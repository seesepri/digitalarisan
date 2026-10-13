import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://audit:disabled@127.0.0.1:1/audit";
const { normalizePhoneNumber } = await import("@/server/phone");
const { sendVerificationSms, checkVerificationSms } = await import("@/server/services/sms-provider");

const accountSid = `AC${"a".repeat(32)}`;
const serviceSid = {
  SIGNUP: `VA${"b".repeat(32)}`,
  LOGIN_VERIFY: `VA${"c".repeat(32)}`,
  PASSWORD_RESET: `VA${"d".repeat(32)}`,
};

function configureTwilio() {
  process.env.TWILIO_ACCOUNT_SID = accountSid;
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token-not-real";
  process.env.TWILIO_VERIFY_SERVICE_SID_SIGNUP = serviceSid.SIGNUP;
  process.env.TWILIO_VERIFY_SERVICE_SID_LOGIN = serviceSid.LOGIN_VERIFY;
  process.env.TWILIO_VERIFY_SERVICE_SID_PASSWORD_RESET = serviceSid.PASSWORD_RESET;
}

test("phone numbers normalize to international E.164 format", () => {
  assert.equal(normalizePhoneNumber("0812 3456 7890"), "+6281234567890");
  assert.equal(normalizePhoneNumber("+6281234567890"), "+6281234567890");
  assert.throws(() => normalizePhoneNumber("not-a-phone"), /Format nomor HP tidak valid/);
});

test("Twilio Verify sends SMS through its fixed HTTPS verification endpoint", async () => {
  configureTwilio();
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({ status: "pending" }, { status: 201 });
  };
  try {
    await sendVerificationSms("+6281234567890", "SIGNUP");
    assert.equal(capturedUrl, `https://verify.twilio.com/v2/Services/${serviceSid.SIGNUP}/Verifications`);
    assert.equal(capturedInit?.method, "POST");
    assert.equal(new Headers(capturedInit?.headers).get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(String(capturedInit?.body)).get("To"), "+6281234567890");
    assert.equal(new URLSearchParams(String(capturedInit?.body)).get("Channel"), "sms");
  } finally { globalThis.fetch = originalFetch; }
});

test("Twilio Verify accepts only provider-approved OTP status", async () => {
  configureTwilio();
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = async (_input, init) => {
    capturedBody = String(init?.body);
    return Response.json({ status: "approved" }, { status: 200 });
  };
  try {
    assert.equal(await checkVerificationSms("+6281234567890", "123456", "PASSWORD_RESET"), true);
    assert.equal(new URLSearchParams(capturedBody).get("Code"), "123456");
    assert.match(capturedBody, /Code=/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Twilio Verify uses distinct services for each OTP purpose", async () => {
  configureTwilio();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ status: "pending" }, { status: 201 });
  };
  try {
    await sendVerificationSms("+6281234567890", "SIGNUP");
    await sendVerificationSms("+6281234567890", "LOGIN_VERIFY");
    await sendVerificationSms("+6281234567890", "PASSWORD_RESET");
    assert.equal(new Set(urls).size, 3);
    assert.ok(urls[2].includes(serviceSid.PASSWORD_RESET));
  } finally { globalThis.fetch = originalFetch; }
});

test("Twilio Verify selects the password-reset service for reset challenge checks", async () => {
  configureTwilio();
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return Response.json({ status: "approved" }, { status: 200 });
  };
  try {
    await checkVerificationSms("+6281234567890", "123456", "PASSWORD_RESET");
    assert.equal(capturedUrl, `https://verify.twilio.com/v2/Services/${serviceSid.PASSWORD_RESET}/VerificationCheck`);
  } finally { globalThis.fetch = originalFetch; }
});

test("phone-only registration, login gating, one-time challenge and provider verification are wired", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const register = read("src/app/api/v1/auth/register/route.ts");
  const login = read("src/app/api/v1/auth/login/route.ts");
  const verification = read("src/app/api/v1/auth/phone/verify/route.ts");
  const forgot = read("src/app/api/v1/auth/password/forgot/route.ts");
  const reset = read("src/app/api/v1/auth/password/reset/route.ts");
  const service = read("src/server/services/phone-verification.ts");
  const guard = read("src/server/http.ts");
  const forgotRoute = read("src/app/api/v1/auth/password/forgot/route.ts");
  const resetRoute = read("src/app/api/v1/auth/password/reset/route.ts");
  const schema = read("src/db/schema.ts");
  const migration = read("drizzle/0001_phone_only_registration.sql");
  const authForm = read("src/features/auth/auth-form.tsx");
  assert.doesNotMatch(register, /body\.email|users\.email/);
  assert.match(register, /body\.phone/);
  assert.doesNotMatch(register, /body\.name|body\.password/);
  assert.match(authForm, /JSON\.stringify\(\{ phone \}\)/);
  assert.match(authForm, /registrationPhone|verificationPhone/);
  assert.match(register, /startPhoneVerification/);
  assert.doesNotMatch(register, /createAccessToken|insert\(userSessions\)|insert\(wallets\)/);
  assert.match(login, /!user\.phoneVerifiedAt/);
  assert.match(login, /startPhoneVerification/);
  assert.match(register, /phone-otp-send-ip/);
  assert.match(login, /phone-otp-send-ip/);
  assert.match(verification, /assertSameOrigin/);
  assert.match(verification, /verifyPhoneAndCreateSession/);
  assert.match(service, /checkVerificationSms/);
  assert.match(service, /verificationAttempts >= MAX_VERIFICATION_ATTEMPTS/);
  assert.match(service, /USER_REGISTERED_PHONE_VERIFIED/);
  assert.match(guard, /!record\.phoneVerifiedAt/);
  assert.match(migration, /ALTER TABLE users ALTER COLUMN email DROP NOT NULL/);
  assert.match(migration, /CREATE TABLE phone_verification_challenges/);
  assert.match(schema, /phoneVerificationPurposeEnum.*SIGNUP.*LOGIN_VERIFY.*PASSWORD_RESET/);
  assert.match(forgotRoute, /GENERIC_MESSAGE/);
  assert.match(forgotRoute, /password-reset-request-ip/);
  assert.match(forgotRoute, /password-reset-request-phone/);
  assert.match(forgotRoute, /startPasswordReset/);
  assert.match(service, /if \(!user \|\| !user\.phoneVerifiedAt\) return/);
  assert.match(forgotRoute, /202\)/);
  assert.match(resetRoute, /password-reset-complete-ip/);
  assert.match(resetRoute, /password-reset-complete-phone/);
  assert.match(reset, /resetPasswordWithPhoneCode/);
  assert.match(service, /eq\(phoneVerificationChallenges\.purpose, "PASSWORD_RESET"\)/);
  assert.match(service, /PASSWORD_RESET_BY_VERIFIED_PHONE/);
  const resetService = service.slice(service.indexOf("export async function resetPasswordWithPhoneCode"));
  assert.match(resetService, /update\(userSessions\)[\s\S]*revokedAt: now/);
  assert.match(resetService, /update\(users\)\.set\(\{ passwordHash/);
  assert.doesNotMatch(resetService, /createRefreshToken|insert\(userSessions\)/);
  assert.match(authForm, /Lupa password\?/);
  assert.match(authForm, /resendPasswordResetCode/);
  assert.doesNotMatch(schema.slice(schema.indexOf("export const phoneVerificationChallenges"), schema.indexOf("export const wallets")), /passwordHash|name: varchar/);
  assert.match(schema, /phoneVerificationChallenges = pgTable/);
  assert.match(schema, /email: varchar\("email", \{ length: 255 \}\)/);
});
