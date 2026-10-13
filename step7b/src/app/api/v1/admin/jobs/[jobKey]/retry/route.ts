import { assertSameOrigin, errorResponse, getRequestMetadata, jsonOk, requireSuperAdmin } from "@/server/http";
import { manuallyRetryJob } from "@/server/services/job-lock";
import { auditLogs } from "@/db/schema";
import { db } from "@/db";
type RouteContext={params:Promise<{jobKey:string}>};
export async function POST(request:Request,context:RouteContext){try{assertSameOrigin(request);const admin=await requireSuperAdmin(request);const {jobKey}=await context.params;const result=await manuallyRetryJob(jobKey);await db.insert(auditLogs).values({actorId:admin.id,actorType:admin.role,action:"JOB_MANUAL_RETRY",entityType:"job_execution",entityId:result.id,newValue:{jobKey},...getRequestMetadata(request)});return jsonOk(result,"Job dijadwalkan ulang secara manual.");}catch(error){return errorResponse(error);}}
