import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { users, wallets } from "@/db/schema";
import { ApiError, errorResponse, jsonOk, requireAdmin } from "@/server/http";
import { cursorWhere, decodeCursor, encodeCursor, parsePageSize } from "@/server/pagination";
import { parseDateRange, parseEnumFilter, parseSafeSort } from "@/server/api-governance";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const params = new URL(request.url).searchParams;
    const search = params.get("q")?.trim().slice(0, 80);
    const status = parseEnumFilter(params.get("status"), ["ACTIVE", "SUSPENDED", "PENDING"] as const, "status");
    const kycStatus = parseEnumFilter(params.get("kycStatus"), ["PENDING", "IN_REVIEW", "VERIFIED", "REJECTED"] as const, "kycStatus");
    const created = parseDateRange(params, "createdAt");
    const sort = parseSafeSort(params.get("sort"), ["createdAt", "name", "status"] as const, "createdAt", "desc");
    const pageSize = parsePageSize(params.get("limit"), 50, 100);
    const cursor = decodeCursor(params.get("cursor"));
    if (cursor && sort.field !== "createdAt") throw new ApiError("Cursor hanya didukung untuk sort=createdAt.", "INVALID_CURSOR_SORT", 400);
    const conditions: SQL[] = [];
    if (search) conditions.push(or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`), ilike(users.phone, `%${search}%`))!);
    if (status) conditions.push(eq(users.status, status));
    if (kycStatus) conditions.push(eq(users.kycStatus, kycStatus));
    if (created.from) conditions.push(sql`${users.createdAt} >= ${created.from}`);
    if (created.to) conditions.push(sql`${users.createdAt} <= ${created.to}`);
    const orderBy = sort.field === "name" ? (sort.direction === "asc" ? asc(users.name) : desc(users.name)) : sort.field === "status" ? (sort.direction === "asc" ? asc(users.status) : desc(users.status)) : (sort.direction === "asc" ? asc(users.createdAt) : desc(users.createdAt));
    const cursorCondition = sort.field === "createdAt" ? cursorWhere(cursor, users.createdAt, users.id, sort.direction) : undefined;
    if (cursorCondition) conditions.push(cursorCondition);
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        status: users.status,
        kycStatus: users.kycStatus,
        createdAt: users.createdAt,
        availableBalance: wallets.availableBalance,
        lockedBalance: wallets.lockedBalance,
        pendingBalance: wallets.pendingBalance,
      })
      .from(users)
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderBy, sort.direction === "asc" ? asc(users.id) : desc(users.id))
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return jsonOk({ users: page, nextCursor: rows.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null });
  } catch (error) {
    return errorResponse(error);
  }
}
