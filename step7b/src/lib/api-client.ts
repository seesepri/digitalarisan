export type ApiEnvelope<T> = { success: true; data: T; message: string };

export class ApiClientError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<{ data: T; message: string }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiClientError("Respons server tidak dapat dibaca.", "INVALID_RESPONSE", response.status);
  }
  if (!response.ok || !payload || typeof payload !== "object" || !("success" in payload) || payload.success !== true) {
    const failure = payload && typeof payload === "object" ? payload as { message?: unknown; code?: unknown } : {};
    throw new ApiClientError(
      typeof failure.message === "string" ? failure.message : "Permintaan tidak berhasil.",
      typeof failure.code === "string" ? failure.code : "REQUEST_FAILED",
      response.status,
    );
  }
  return { data: (payload as ApiEnvelope<T>).data, message: (payload as ApiEnvelope<T>).message };
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
