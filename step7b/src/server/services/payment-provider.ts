import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/server/http";
import { providerFetch, runtimeLimits } from "@/server/services/runtime-resilience";

export type CreatePaymentInput = {
  reference: string;
  amount: number;
  currency: "IDR";
  expiresAt: Date;
  callbackUrl: string;
};

export type CreatePaymentResult = {
  provider: string;
  providerReference: string;
  checkoutUrl: string;
  expiresAt: Date;
};

export type NormalizedWebhookEvent = {
  provider: string;
  eventId: string;
  reference: string;
  amount: number;
  currency: "IDR";
  status: "PAID" | "FAILED" | "PROCESSING" | "EXPIRED";
};

export type VerifyWebhookInput = {
  rawBody: string;
  signature?: string;
  timestamp?: string;
};

export type PaymentStatusResult = { provider: string; reference: string; amount: number; status: "PAID" | "FAILED" | "PROCESSING" | "EXPIRED"; providerReference?: string };

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus?(reference: string): Promise<PaymentStatusResult>;
  verifyWebhook(input: VerifyWebhookInput): NormalizedWebhookEvent;
}

const MAX_WEBHOOK_SKEW_MS = 5 * 60 * 1000;
function providerSignal(): AbortSignal { return AbortSignal.timeout(runtimeLimits.providerTimeoutMs); }

function validateCheckoutUrl(value: unknown, provider: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("Respons payment provider tidak memiliki checkout URL.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new ApiError("Checkout URL payment provider tidak valid.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ApiError("Checkout URL payment provider tidak aman.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  }
  if (provider === "midtrans" && !["app.midtrans.com", "app.sandbox.midtrans.com"].includes(url.hostname)) {
    throw new ApiError("Host checkout URL Midtrans tidak diizinkan.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  }
  return url.toString();
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError(`Konfigurasi ${name} belum tersedia.`, "PAYMENT_PROVIDER_UNAVAILABLE", 503);
  return value;
}

function positiveAmount(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  // Midtrans represents IDR gross_amount as a decimal string (for example, "50000.00").
  // IDR is integer-valued here, so only a zero fractional part is accepted.
  if (!/^\d+(?:\.0{1,2})?$/.test(text)) throw new ApiError("Nominal pembayaran provider tidak valid.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError("Nominal pembayaran provider tidak valid.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
  }
  return amount;
}

/** Generic adapter retained for providers that use the v7 timestamp/HMAC contract. */
export class HttpPaymentProvider implements PaymentProvider {
  readonly name: string;

  constructor(name = process.env.PAYMENT_PROVIDER?.trim() || "http") {
    this.name = name;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const baseUrl = requireEnv("PAYMENT_PROVIDER_BASE_URL");
    const apiKey = requireEnv("PAYMENT_PROVIDER_API_KEY");
    const path = process.env.PAYMENT_PROVIDER_CREATE_PATH?.trim() || "/payments";
    const url = new URL(path, baseUrl).toString();
    const response = await providerFetch(this.name, "create", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "Idempotency-Key": input.reference },
      body: JSON.stringify({ reference: input.reference, amount: input.amount, currency: input.currency, expiresAt: input.expiresAt.toISOString(), callbackUrl: input.callbackUrl }),
      cache: "no-store",
      signal: providerSignal(),
    });
    if (!response.ok) throw new ApiError(`Payment provider menolak pembuatan pembayaran (${response.status}).`, "PAYMENT_PROVIDER_CREATE_FAILED", 502);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ApiError("Respons payment provider tidak valid.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502); }
    if (payload === null || typeof payload !== "object") throw new ApiError("Respons payment provider tidak valid.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
    const data = payload as Record<string, unknown>;
    const providerReference = typeof data.providerReference === "string" ? data.providerReference.trim() : "";
    const checkoutUrl = validateCheckoutUrl(data.checkoutUrl, this.name);
    if (!providerReference) throw new ApiError("Respons payment provider tidak memiliki reference atau checkout URL.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
    const expiresAt = typeof data.expiresAt === "string" && !Number.isNaN(Date.parse(data.expiresAt)) ? new Date(data.expiresAt) : input.expiresAt;
    return { provider: this.name, providerReference, checkoutUrl, expiresAt };
  }

  verifyWebhook(input: VerifyWebhookInput): NormalizedWebhookEvent {
    const secret = requireEnv("PAYMENT_WEBHOOK_SECRET");
    const timestamp = input.timestamp?.trim() ?? "";
    const signature = input.signature?.trim().toLowerCase() ?? "";
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_WEBHOOK_SKEW_MS) throw new ApiError("Timestamp webhook kedaluwarsa atau tidak valid.", "WEBHOOK_TIMESTAMP_INVALID", 401);
    const expected = createHmac("sha256", secret).update(`${timestamp}.${input.rawBody}`).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(signature)) throw new ApiError("Signature webhook tidak valid.", "INVALID_WEBHOOK_SIGNATURE", 401);
    const expectedBuffer = Buffer.from(expected, "hex");
    const receivedBuffer = Buffer.from(signature, "hex");
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) throw new ApiError("Signature webhook tidak valid.", "INVALID_WEBHOOK_SIGNATURE", 401);
    let body: unknown;
    try { body = JSON.parse(input.rawBody); } catch { throw new ApiError("Payload webhook tidak valid.", "INVALID_WEBHOOK_BODY", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("Payload webhook tidak valid.", "INVALID_WEBHOOK_BODY", 400);
    const event = body as Record<string, unknown>;
    const reference = typeof event.reference === "string" ? event.reference.trim() : "";
    const eventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
    const status = typeof event.status === "string" ? event.status.trim().toUpperCase() : "";
    const currency = typeof event.currency === "string" ? event.currency.trim().toUpperCase() : "";
    if (!reference || !eventId || !status || !currency) throw new ApiError("Payload webhook tidak lengkap.", "INVALID_WEBHOOK_BODY", 400);
    if (currency !== "IDR") throw new ApiError("Currency webhook tidak didukung.", "INVALID_WEBHOOK_CURRENCY", 400);
    if (!["PAID", "FAILED", "PROCESSING", "EXPIRED"].includes(status)) throw new ApiError("Status webhook tidak didukung.", "INVALID_WEBHOOK_STATUS", 400);
    return { provider: this.name, eventId, reference, amount: positiveAmount(event.amount), currency: "IDR", status: status as NormalizedWebhookEvent["status"] };
  }
}

/** Midtrans Snap API adapter. Server key never leaves the server. */
export class MidtransPaymentProvider implements PaymentProvider {
  readonly name = "midtrans";
  private readonly baseUrl: string;
  private readonly serverKey: string;

  constructor() {
    this.serverKey = requireEnv("MIDTRANS_SERVER_KEY");
    const rawProduction = process.env.MIDTRANS_IS_PRODUCTION?.trim().toLowerCase();
    if (rawProduction !== "true" && rawProduction !== "false") {
      throw new ApiError("MIDTRANS_IS_PRODUCTION harus dikonfigurasi secara eksplisit.", "PAYMENT_PROVIDER_CONFIG_INVALID", 500);
    }
    const production = rawProduction === "true";
    const configuredBaseUrl = process.env.MIDTRANS_BASE_URL?.trim();
    const baseUrl = configuredBaseUrl || (production ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");
    let parsedBaseUrl: URL;
    try { parsedBaseUrl = new URL(baseUrl); } catch {
      throw new ApiError("MIDTRANS_BASE_URL tidak valid.", "PAYMENT_PROVIDER_CONFIG_INVALID", 500);
    }
    const allowedHosts = production ? ["app.midtrans.com"] : ["app.sandbox.midtrans.com"];
    if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.username || parsedBaseUrl.password || !allowedHosts.includes(parsedBaseUrl.hostname) || parsedBaseUrl.pathname !== "/" || parsedBaseUrl.search || parsedBaseUrl.hash) {
      throw new ApiError("MIDTRANS_BASE_URL harus HTTPS dan sesuai mode Midtrans.", "PAYMENT_PROVIDER_CONFIG_INVALID", 500);
    }
    this.baseUrl = parsedBaseUrl.origin;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const authorization = Buffer.from(`${this.serverKey}:`, "utf8").toString("base64");
    const expiryMinutes = Math.max(1, Math.min(24 * 60, Math.ceil((input.expiresAt.getTime() - Date.now()) / 60_000)));
    const response = await providerFetch(this.name, "create", `${this.baseUrl}/snap/v1/transactions`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${authorization}`, "Idempotency-Key": input.reference },
      body: JSON.stringify({
        transaction_details: { order_id: input.reference, gross_amount: input.amount },
        callbacks: { finish: input.callbackUrl },
        custom_expiry: { expiry_duration: expiryMinutes, unit: "minute" },
      }),
      cache: "no-store",
      signal: providerSignal(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ApiError(`Midtrans menolak pembuatan pembayaran (${response.status}).${detail ? ` ${detail.slice(0, 240)}` : ""}`, "PAYMENT_PROVIDER_CREATE_FAILED", 502);
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    const redirectUrl = validateCheckoutUrl(payload?.redirect_url, this.name);
    if (!token) throw new ApiError("Respons Snap Midtrans tidak memiliki token/redirect_url.", "PAYMENT_PROVIDER_INVALID_RESPONSE", 502);
    return { provider: this.name, providerReference: input.reference, checkoutUrl: redirectUrl, expiresAt: input.expiresAt };
  }

  async getPaymentStatus(reference: string): Promise<PaymentStatusResult> {
    const orderId = reference.trim();
    if (!orderId) throw new ApiError("Reference pembayaran tidak valid.", "PAYMENT_PROVIDER_INVALID_REQUEST", 400);
    const authorization = Buffer.from(`${this.serverKey}:`, "utf8").toString("base64");
    const response = await providerFetch(this.name, "status", `${this.baseUrl}/v2/${encodeURIComponent(orderId)}/status`, {
      method: "GET", headers: { Accept: "application/json", Authorization: `Basic ${authorization}` }, cache: "no-store", signal: providerSignal(),
    });
    if (response.status === 404) return { provider: this.name, reference: orderId, amount: 0, status: "PROCESSING" };
    if (!response.ok) throw new ApiError(`Midtrans gagal memeriksa status pembayaran (${response.status}).`, "PAYMENT_PROVIDER_STATUS_FAILED", 502);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const amount = positiveAmount(payload?.gross_amount);
    const transactionStatus = typeof payload?.transaction_status === "string" ? payload.transaction_status.toLowerCase() : "";
    const fraudStatus = typeof payload?.fraud_status === "string" ? payload.fraud_status.toLowerCase() : "";
    const status = transactionStatus === "settlement" || (transactionStatus === "capture" && fraudStatus === "accept") ? "PAID" : transactionStatus === "expire" ? "EXPIRED" : ["cancel", "deny", "failure"].includes(transactionStatus) ? "FAILED" : "PROCESSING";
    return { provider: this.name, reference: orderId, amount, status, providerReference: orderId };
  }

  verifyWebhook(input: VerifyWebhookInput): NormalizedWebhookEvent {
    let body: unknown;
    try { body = JSON.parse(input.rawBody); } catch { throw new ApiError("Payload webhook Midtrans tidak valid.", "INVALID_WEBHOOK_BODY", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("Payload webhook Midtrans tidak valid.", "INVALID_WEBHOOK_BODY", 400);
    const event = body as Record<string, unknown>;
    const orderId = typeof event.order_id === "string" ? event.order_id.trim() : "";
    const statusCode = typeof event.status_code === "string" ? event.status_code.trim() : "";
    const grossAmount = typeof event.gross_amount === "string" || typeof event.gross_amount === "number" ? String(event.gross_amount).trim() : "";
    const signatureKey = typeof event.signature_key === "string" ? event.signature_key.trim().toLowerCase() : "";
    const transactionId = typeof event.transaction_id === "string" ? event.transaction_id.trim() : "";
    const transactionStatus = typeof event.transaction_status === "string" ? event.transaction_status.trim().toLowerCase() : "";
    const fraudStatus = typeof event.fraud_status === "string" ? event.fraud_status.trim().toLowerCase() : "";
    if (!orderId || !statusCode || !grossAmount || !signatureKey || !transactionStatus) throw new ApiError("Payload webhook Midtrans tidak lengkap.", "INVALID_WEBHOOK_BODY", 400);
    const expected = createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${this.serverKey}`, "utf8").digest("hex");
    if (!/^[0-9a-f]{128}$/.test(signatureKey)) throw new ApiError("Signature webhook Midtrans tidak valid.", "INVALID_WEBHOOK_SIGNATURE", 401);
    const expectedBuffer = Buffer.from(expected, "hex");
    const receivedBuffer = Buffer.from(signatureKey, "hex");
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) throw new ApiError("Signature webhook Midtrans tidak valid.", "INVALID_WEBHOOK_SIGNATURE", 401);
    const amount = positiveAmount(grossAmount);
    const knownProcessingStatuses = new Set(["pending", "authorize"]);
    const status = transactionStatus === "settlement" || (transactionStatus === "capture" && fraudStatus === "accept")
      ? "PAID"
      : transactionStatus === "expire"
        ? "EXPIRED"
        : ["cancel", "deny", "failure"].includes(transactionStatus)
          ? "FAILED"
          : knownProcessingStatuses.has(transactionStatus) || (transactionStatus === "capture" && fraudStatus !== "accept")
            ? "PROCESSING"
            : null;
    if (!status) throw new ApiError("Status transaksi Midtrans tidak dikenali.", "INVALID_WEBHOOK_STATUS", 400);
    const eventId = transactionId ? `${transactionId}:${transactionStatus}:${statusCode}` : `${orderId}:${transactionStatus}:${statusCode}:${grossAmount}`;
    return { provider: this.name, eventId, reference: orderId, amount, currency: "IDR", status };
  }
}

export function getPaymentProvider(): PaymentProvider {
  const name = process.env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (name === "midtrans") return new MidtransPaymentProvider();
  if (name && name !== "unconfigured") return new HttpPaymentProvider(name);
  throw new ApiError("Payment provider belum dikonfigurasi.", "PAYMENT_PROVIDER_UNAVAILABLE", 503);
}
