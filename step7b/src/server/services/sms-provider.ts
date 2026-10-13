import { ApiError } from "@/server/http";
import { providerFetch, runtimeLimits } from "@/server/services/runtime-resilience";
import type { PhoneVerificationPurpose } from "@/server/services/phone-verification";

type TwilioConfig = { accountSid: string; authToken: string; serviceSids: Record<PhoneVerificationPurpose, string> };

function config(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const serviceSids = {
    SIGNUP: process.env.TWILIO_VERIFY_SERVICE_SID_SIGNUP?.trim() ?? "",
    LOGIN_VERIFY: process.env.TWILIO_VERIFY_SERVICE_SID_LOGIN?.trim() ?? "",
    PASSWORD_RESET: process.env.TWILIO_VERIFY_SERVICE_SID_PASSWORD_RESET?.trim() ?? "",
  };
  if (!accountSid || !authToken || Object.values(serviceSids).some((serviceSid) => !serviceSid)) {
    throw new ApiError("Provider verifikasi SMS belum dikonfigurasi.", "SMS_PROVIDER_UNAVAILABLE", 503);
  }
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || Object.values(serviceSids).some((serviceSid) => !/^VA[0-9a-f]{32}$/i.test(serviceSid))) {
    throw new ApiError("Konfigurasi akun Twilio Verify tidak valid.", "SMS_PROVIDER_CONFIG_INVALID", 500);
  }
  return { accountSid, authToken, serviceSids };
}

function authHeaders(provider: TwilioConfig) {
  const authorization = Buffer.from(`${provider.accountSid}:${provider.authToken}`).toString("base64");
  return { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${authorization}` };
}

async function providerRequest(provider: TwilioConfig, purpose: PhoneVerificationPurpose, action: "start" | "check", params: URLSearchParams) {
  const endpoint = action === "start" ? "Verifications" : "VerificationCheck";
  const serviceSid = provider.serviceSids[purpose];
  const response = await providerFetch("twilio-verify", `${purpose.toLowerCase()}-${action}`, `https://verify.twilio.com/v2/Services/${serviceSid}/${endpoint}`, {
    method: "POST",
    headers: authHeaders(provider),
    body: params.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(runtimeLimits.providerTimeoutMs),
  });
  if (!response.ok) {
    throw new ApiError(`Provider verifikasi SMS gagal memproses permintaan (${response.status}).`, "SMS_PROVIDER_REQUEST_FAILED", 502);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new ApiError("Respons provider verifikasi SMS tidak valid.", "SMS_PROVIDER_INVALID_RESPONSE", 502);
  }
  return payload as Record<string, unknown>;
}

/** Starts a real SMS OTP through Twilio Verify; OTP values are not stored by this application. */
export async function sendVerificationSms(phone: string, purpose: PhoneVerificationPurpose): Promise<void> {
  const provider = config();
  const result = await providerRequest(provider, purpose, "start", new URLSearchParams({ To: phone, Channel: "sms" }));
  if (result.status !== "pending") throw new ApiError("Provider tidak menerima pengiriman kode verifikasi.", "SMS_PROVIDER_SEND_FAILED", 502);
}

export async function checkVerificationSms(phone: string, code: string, purpose: PhoneVerificationPurpose): Promise<boolean> {
  const provider = config();
  const result = await providerRequest(provider, purpose, "check", new URLSearchParams({ To: phone, Code: code }));
  return result.status === "approved";
}
