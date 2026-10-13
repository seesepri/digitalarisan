import { and, eq, gt, lt, or, type SQL } from "drizzle-orm";

export type Cursor = { value: string; id: string };

export function encodeCursor(value: Date, id: string): string {
  return Buffer.from(JSON.stringify({ value: value.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null, fieldName = "cursor"): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.value !== "string" || typeof parsed.id !== "string" || !parsed.id) throw new Error("invalid cursor");
    const date = new Date(parsed.value);
    if (Number.isNaN(date.getTime())) throw new Error("invalid cursor date");
    return { value: date.toISOString(), id: parsed.id };
  } catch {
    const error = new Error(`Invalid ${fieldName}`);
    error.name = "INVALID_CURSOR";
    throw error;
  }
}

export function parsePageSize(raw: string | null, fallback = 20, max = 100): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

export function cursorWhere(cursor: Cursor | null, valueColumn: any, idColumn: any, direction: "asc" | "desc" = "desc"): SQL | undefined {
  if (!cursor) return undefined;
  const value = new Date(cursor.value);
  const compare = direction === "asc" ? gt : lt;
  return or(compare(valueColumn, value), and(eq(valueColumn, value), compare(idColumn, cursor.id)))!;
}

export function nextCursor(rows: Array<{ cursorValue: Date; cursorId: string }>, pageSize: number): string | null {
  if (rows.length <= pageSize) return null;
  const last = rows[pageSize - 1];
  return encodeCursor(last.cursorValue, last.cursorId);
}
