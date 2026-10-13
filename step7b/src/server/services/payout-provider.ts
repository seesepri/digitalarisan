import { createHash } from "node:crypto";
import { ApiError } from "@/server/http";
import { providerFetch, runtimeLimits } from "@/server/services/runtime-resilience";
import { providerUrl } from "@/server/services/provider-url";

export type CreateDisbursementInput = {
  reference: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  amount: number;
};
export type DisbursementStatus = "SUCCESS" | "PROCESSING" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "UNKNOWN";
export type DisbursementResult = {
  provider: string;
  reference: string;
  providerReference: string | null;
  status: DisbursementStatus;
  amount: number | null;
  currency: "IDR" | null;
  /** True only when the upstream explicitly guarantees that no transfer took place. */
  failureConfirmed: boolean;
  checkedAt: string;
};
export interface PayoutProvider {
  readonly name: string;
  createDisbursement(input: CreateDisbursementInput): Promise<DisbursementResult>;
  getDisbursementStatus(reference: string): Promise<DisbursementResult>;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError(`Konfigurasi ${name} belum tersedia.`, "PAYOUT_PROVIDER_UNAVAILABLE", 503);
  return value;
}

function classify(value: unknown): DisbursementStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["success", "completed", "settlement"].includes(status)) return "SUCCESS";
  if (["failed", "deny", "cancel", "cancelled", "expired", "failed_final"].includes(status)) return "FAILED_FINAL";
  if (["retryable", "temporary_failure", "failed_retryable"].includes(status)) return "FAILED_RETRYABLE";
  if (["processing", "pending", "accepted"].includes(status)) return "PROCESSING";
  // A timeout, 404, malformed response or unknown status is NOT proof of a failed transfer.
  return "UNKNOWN";
}

function positiveAmount(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+(?:\.0{1,2})?$/.test(text)) throw new ApiError("Nominal payout provider tidak valid.", "PAYOUT_PROVIDER_INVALID_RESPONSE", 502);
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError("Nominal payout provider tidak valid.", "PAYOUT_PROVIDER_INVALID_RESPONSE", 502);
  return amount;
}

function unknownResult(provider: string, reference: string): DisbursementResult {
  return { provider, reference, providerReference: null, status: "UNKNOWN", amount: null, currency: null, failureConfirmed: false, checkedAt: new Date().toISOString() };
}

/** Validate normalized evidence again at the row-locked financial boundary, not just in the HTTP adapter. */
export function assertDisbursementEvidence(result: DisbursementResult | undefined, expected: {
  reference: string;
  amount: number;
  provider?: string | null;
  providerReference?: string | null;
}): asserts result is DisbursementResult {
  if (!result || result.status === "UNKNOWN" || result.reference !== expected.reference
      || result.amount !== expected.amount || result.currency !== "IDR"
      || !Number.isSafeInteger(result.amount) || !result.provider?.trim()
      || !result.providerReference?.trim() || result.providerReference.length > 180
      || !Number.isFinite(Date.parse(result.checkedAt))
      || (expected.provider && result.provider !== expected.provider)) {
    throw new ApiError("Bukti payout harus memiliki provider, reference, nominal, currency, dan referensi eksternal yang cocok.", "PAYOUT_PROVIDER_EVIDENCE_REQUIRED", 409);
  }
  if (expected.providerReference && result.providerReference !== expected.providerReference) {
    throw new ApiError("Referensi eksternal payout berubah; rekonsiliasi manual diperlukan.", "PAYOUT_PROVIDER_REFERENCE_CONFLICT", 409);
  }
  if ((result.status === "FAILED_FINAL" || result.status === "FAILED_RETRYABLE") && result.failureConfirmed !== true) {
    throw new ApiError("Provider belum memastikan transfer gagal; dana tetap ditahan.", "PAYOUT_FAILURE_UNCONFIRMED", 409);
  }
}

export class HttpPayoutProvider implements PayoutProvider {
  readonly name: string;
  constructor(name = process.env.PAYOUT_PROVIDER?.trim() || "http") { this.name = name; }

  private endpoint(path: string): URL {
    return providerUrl(env("PAYOUT_PROVIDER_BASE_URL"), path, "PAYOUT_PROVIDER_CONFIG_INVALID");
  }

  private async decode(response: Response, reference: string, expectedAmount?: number): Promise<DisbursementResult> {
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("Respons payout provider tidak valid; status transfer belum diketahui.", "PAYOUT_PROVIDER_INVALID_RESPONSE", 502);
    }
    const data = body as Record<string, unknown>;
    const status = classify(data.status);
    if (status === "UNKNOWN") return unknownResult(this.name, reference);
    const externalReference = typeof data.providerReference === "string" ? data.providerReference.trim() : "";
    const actualReference = typeof data.reference === "string" ? data.reference.trim() : "";
    const amount = positiveAmount(data.amount);
    if (actualReference !== reference || data.currency !== "IDR" || !externalReference || externalReference.length > 180
        || (expectedAmount !== undefined && amount !== expectedAmount)) {
      throw new ApiError("Identitas, nominal, currency, atau referensi eksternal payout tidak cocok.", "PAYOUT_PROVIDER_INVALID_RESPONSE", 502);
    }
    const result: DisbursementResult = {
      provider: this.name, reference: actualReference, providerReference: externalReference,
      amount, currency: "IDR", status, failureConfirmed: data.failureConfirmed === true, checkedAt: new Date().toISOString(),
    };
    assertDisbursementEvidence(result, { reference, amount });
    return result;
  }

  async createDisbursement(input: CreateDisbursementInput): Promise<DisbursementResult> {
    if (!input.reference.trim() || !Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new ApiError("Permintaan payout tidak valid.", "PAYOUT_PROVIDER_INVALID_REQUEST", 400);
    }
    const response = await providerFetch(this.name, "create", this.endpoint(process.env.PAYOUT_PROVIDER_CREATE_PATH?.trim() || "/disbursements"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("PAYOUT_PROVIDER_API_KEY")}`, "Idempotency-Key": input.reference },
      body: JSON.stringify({ ...input, currency: "IDR" }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(runtimeLimits.providerTimeoutMs),
    });
    if (!response.ok) throw new ApiError(`Payout provider menolak disbursement (${response.status}); status transfer belum diketahui.`, "PAYOUT_PROVIDER_CREATE_FAILED", 502);
    return this.decode(response, input.reference, input.amount);
  }

  async getDisbursementStatus(reference: string): Promise<DisbursementResult> {
    const template = process.env.PAYOUT_PROVIDER_STATUS_PATH?.trim() || "/disbursements/{reference}";
    if (!template.includes("{reference}")) throw new ApiError("Payout status path wajib memuat {reference}.", "PAYOUT_PROVIDER_CONFIG_INVALID", 500);
    const path = template.replaceAll("{reference}", encodeURIComponent(reference));
    const response = await providerFetch(this.name, "status", this.endpoint(path), {
      headers: { Authorization: `Bearer ${env("PAYOUT_PROVIDER_API_KEY")}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(runtimeLimits.providerTimeoutMs),
    });
    if (response.status === 404) return unknownResult(this.name, reference);
    if (!response.ok) throw new ApiError(`Payout provider gagal memeriksa status (${response.status}).`, "PAYOUT_PROVIDER_STATUS_FAILED", 502);
    return this.decode(response, reference);
  }
}

/** A generic adapter, NOT a certified Midtrans Iris integration. The configured upstream must honor the documented contract. */
export function getPayoutProvider(expectedProvider?: string | null): PayoutProvider {
  const name = process.env.PAYOUT_PROVIDER?.trim().toLowerCase();
  if (expectedProvider && name !== expectedProvider) throw new ApiError("Provider withdrawal berbeda dari konfigurasi aktif.", "PAYOUT_PROVIDER_CONFIG_MISMATCH", 503);
  if (name && name !== "unconfigured") return new HttpPayoutProvider(name);
  throw new ApiError("Payout provider belum dikonfigurasi.", "PAYOUT_PROVIDER_UNAVAILABLE", 503);
}

export function stablePayoutReference(withdrawalId: string): string {
  return `WD-${createHash("sha256").update(withdrawalId).digest("hex").slice(0, 32)}`;
}
