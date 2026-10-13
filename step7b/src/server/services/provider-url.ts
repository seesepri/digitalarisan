import { ApiError } from "@/server/http";

/** Configuration may select a provider, but a request path must never redirect its credentials. */
export function providerUrl(baseValue: string, path: string, code = "PROVIDER_CONFIG_INVALID"): URL {
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseValue);
    url = new URL(path, base);
  } catch {
    throw new ApiError("URL provider tidak valid.", code, 500);
  }
  const localTestHttp = process.env.NODE_ENV === "test" && base.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !localTestHttp) || base.username || base.password
      || base.search || base.hash || !path.startsWith("/") || path.startsWith("//")
      || url.origin !== base.origin || url.username || url.password || url.hash) {
    throw new ApiError("Provider harus memakai HTTPS dan path pada origin yang sama; HTTP hanya untuk loopback dalam test.", code, 500);
  }
  return url;
}
