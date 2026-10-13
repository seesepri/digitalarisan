import { assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, requireAdmin } from "@/server/http";
import { executeWithdrawal } from "@/server/services/payout-withdrawal";
type RouteContext={params:Promise<{id:string}>};
export async function POST(request:Request,context:RouteContext){try{assertSameOrigin(request);await enforceRateLimit(request, "admin-financial-withdrawal-execute", 10, 60_000);const admin=await requireAdmin(request);const {id}=await context.params;const result=await executeWithdrawal({withdrawalId:id,adminId:admin.id,adminRole:admin.role,meta:getRequestMetadata(request)});return jsonOk(result,"Withdrawal diproses melalui payout provider.");}catch(error){return errorResponse(error);}}
