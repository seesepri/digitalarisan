import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { privacyConsents } from "@/db/schema";
import { assertSameOrigin, errorResponse, jsonOk, readJson, requireUser } from "@/server/http";
import { consentEvidenceHash } from "@/server/privacy";

export async function GET(request: Request) { try { const user=await requireUser(request); const rows=await db.select().from(privacyConsents).where(eq(privacyConsents.userId,user.id)).orderBy(desc(privacyConsents.grantedAt)).limit(100); return jsonOk({consents:rows}); } catch(e){return errorResponse(e);} }
export async function POST(request: Request) {
  try { assertSameOrigin(request); const user=await requireUser(request); const body=await readJson(request); const policyType=typeof body.policyType==="string"?body.policyType.slice(0,40):""; const policyVersion=typeof body.policyVersion==="string"?body.policyVersion.slice(0,40):""; if(!policyType||!policyVersion||typeof body.granted!=="boolean") return Response.json({success:false,message:"policyType, policyVersion dan granted wajib.",code:"INVALID_CONSENT"},{status:400}); const grantedAt=new Date(); const evidenceHash=consentEvidenceHash({userId:user.id,policyType,policyVersion,granted:body.granted,grantedAt}); const [row]=await db.insert(privacyConsents).values({userId:user.id,policyType,policyVersion,granted:body.granted,evidenceHash,grantedAt,withdrawnAt:body.granted?null:grantedAt}).returning(); return jsonOk(row,"Bukti consent tersimpan.",201); } catch(e){return errorResponse(e);} }
