import { ApiError } from "@/server/http";

export const API_VERSION = "1" as const;
export const API_MEDIA_TYPE = `application/vnd.digital-arisan.v${API_VERSION}+json`;

const supportedVersions = new Set(["1"]);

export function negotiateApiVersion(request: Request): string {
  const requested = request.headers.get("x-api-version")?.trim() || request.headers.get("accept")?.match(/application\/vnd\.digital-arisan\.v(\d+)\+json/i)?.[1] || "1";
  if (!supportedVersions.has(requested)) {
    throw new ApiError(`API version v${requested} tidak didukung.`, "API_VERSION_NOT_SUPPORTED", 406);
  }
  return requested;
}

export function applyApiContractHeaders(response: Response, version = API_VERSION): Response {
  response.headers.set("X-API-Version", version);
  response.headers.set("Vary", "Accept, X-API-Version");
  response.headers.set("Content-Type", `${API_MEDIA_TYPE}; charset=utf-8`);
  return response;
}

export type SortDirection = "asc" | "desc";

export function parseSafeSort(raw: string | null, allowed: readonly string[], fallback: string, fallbackDirection: SortDirection = "desc") {
  if (!raw) return { field: fallback, direction: fallbackDirection };
  const [field, directionRaw] = raw.split(":", 2);
  if (!allowed.includes(field)) throw new ApiError("Field sorting tidak diizinkan.", "INVALID_SORT", 400);
  const direction = directionRaw === undefined ? fallbackDirection : directionRaw.toLowerCase();
  if (direction !== "asc" && direction !== "desc") throw new ApiError("Arah sorting tidak valid.", "INVALID_SORT", 400);
  return { field, direction: direction as SortDirection };
}

export function parseEnumFilter<T extends string>(raw: string | null, allowed: readonly T[], field: string): T | undefined {
  if (!raw) return undefined;
  if (!allowed.includes(raw as T)) throw new ApiError(`${field} filter tidak valid.`, "INVALID_FILTER", 400);
  return raw as T;
}

export function parseDateRange(params: URLSearchParams, field: string) {
  const fromRaw = params.get(`${field}From`);
  const toRaw = params.get(`${field}To`);
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && Number.isNaN(from.getTime())) throw new ApiError(`${field}From tidak valid.`, "INVALID_FILTER", 400);
  if (to && Number.isNaN(to.getTime())) throw new ApiError(`${field}To tidak valid.`, "INVALID_FILTER", 400);
  if (from && to && from > to) throw new ApiError(`${field}From harus <= ${field}To.`, "INVALID_FILTER", 400);
  return { from, to };
}
