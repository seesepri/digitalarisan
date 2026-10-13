import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { topups } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, requireUser } from "@/server/http";
import { reconcileTopupPayment } from "@/server/services/wallet";
type RouteContext={params:Promise<{id:string}>};
export async function POST(request:Request,context:RouteContext){try{assertSameOrigin(request);await enforceRateLimit(request, "wallet-topup-reconcile", 10, 60_000);const user=await requireUser(request);const {id}=await context.params;const [topup]=await db.select({id:topups.id}).from(topups).where(and(eq(topups.id,id),eq(topups.userId,user.id))).limit(1);if(!topup)throw new ApiError("Top-up tidak ditemukan.","TOPUP_NOT_FOUND",404);const result=await reconcileTopupPayment({topupId:id,meta:getRequestMetadata(request)});return jsonOk(result,"Status pembayaran direkonsiliasi dengan provider.");}catch(error){return errorResponse(error);}}
