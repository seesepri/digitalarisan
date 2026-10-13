import { createHash } from "node:crypto";
import { ApiError } from "@/server/http";
import { providerFetch, runtimeLimits } from "@/server/services/runtime-resilience";

export type CreateDisbursementInput = {
  reference: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  amount: number;
};
export type DisbursementResult = { provider: string; reference: string; providerReference: string | null; status: "SUCCESS" | "PROCESSING" | "FAILED_RETRYABLE" | "FAILED_FINAL" };
export interface PayoutProvider {
  readonly name: string;
  createDisbursement(input: CreateDisbursementInput): Promise<DisbursementResult>;
  getDisbursementStatus(reference: string): Promise<DisbursementResult>;
}

function env(name: string): string { const v = process.env[name]?.trim(); if (!v) throw new ApiError(`Konfigurasi ${name} belum tersedia.`, "PAYOUT_PROVIDER_UNAVAILABLE", 503); return v; }
function signal() { return AbortSignal.timeout(runtimeLimits.providerTimeoutMs); }
function classify(status: string): DisbursementResult["status"] { const s=status.toLowerCase(); if (["success","completed","settlement"].includes(s)) return "SUCCESS"; if (["failed","deny","cancel","expired"].includes(s)) return "FAILED_FINAL"; if (["retryable","temporary_failure","timeout"].includes(s)) return "FAILED_RETRYABLE"; return "PROCESSING"; }

export class HttpPayoutProvider implements PayoutProvider {
  readonly name: string;
  constructor(name = process.env.PAYOUT_PROVIDER?.trim() || "http") { this.name=name; }
  private base() { return env("PAYOUT_PROVIDER_BASE_URL").replace(/\/$/,""); }
  private key() { return env("PAYOUT_PROVIDER_API_KEY"); }
  async createDisbursement(input: CreateDisbursementInput): Promise<DisbursementResult> {
    const response=await providerFetch(this.name, "create", new URL(process.env.PAYOUT_PROVIDER_CREATE_PATH?.trim()||"/disbursements",this.base()),{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${this.key()}`,"Idempotency-Key":input.reference},body:JSON.stringify(input),cache:"no-store",signal:signal()});
    if(!response.ok) throw new ApiError(`Payout provider menolak disbursement (${response.status}).`,"PAYOUT_PROVIDER_CREATE_FAILED",502);
    const body=await response.json().catch(()=>null) as Record<string,unknown>|null;
    const providerReference=typeof body?.providerReference==="string"?body.providerReference.trim() || null:null;
    const status=typeof body?.status==="string"?classify(body.status):"PROCESSING";
    return {provider:this.name,reference:input.reference,providerReference,status};
  }
  async getDisbursementStatus(reference:string):Promise<DisbursementResult>{
    const path=(process.env.PAYOUT_PROVIDER_STATUS_PATH?.trim()||"/disbursements/{reference}").replace("{reference}",encodeURIComponent(reference));
    const response=await providerFetch(this.name, "status", new URL(path,this.base()),{headers:{Authorization:`Bearer ${this.key()}`},cache:"no-store",signal:signal()});
    if(response.status===404) return {provider:this.name,reference,providerReference:null,status:"FAILED_RETRYABLE"};
    if(!response.ok) throw new ApiError(`Payout provider gagal memeriksa status (${response.status}).`,"PAYOUT_PROVIDER_STATUS_FAILED",502);
    const body=await response.json().catch(()=>null) as Record<string,unknown>|null;
    const providerReference=typeof body?.providerReference==="string"?body.providerReference.trim() || null:null;
    return {provider:this.name,reference,providerReference,status:classify(typeof body?.status==="string"?body.status:"")};
  }
}

/** Generic HTTP adapter. Midtrans Iris-compatible deployments can use the same contract through the configured endpoints. */
export function getPayoutProvider(): PayoutProvider {
  const name=process.env.PAYOUT_PROVIDER?.trim().toLowerCase();
  if(name && name!=="unconfigured") return new HttpPayoutProvider(name);
  throw new ApiError("Payout provider belum dikonfigurasi.","PAYOUT_PROVIDER_UNAVAILABLE",503);
}

export function stablePayoutReference(withdrawalId:string):string { return `WD-${createHash("sha256").update(withdrawalId).digest("hex").slice(0,32)}`; }
