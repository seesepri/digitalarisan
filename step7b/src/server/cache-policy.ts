export const PUBLIC_REFERENCE_CACHE_CONTROL = "public, s-maxage=5, stale-while-revalidate=15";
export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store, max-age=0";

export function withCacheControl<T extends Response>(response: T, value: string): T {
  response.headers.set("Cache-Control", value);
  return response;
}
