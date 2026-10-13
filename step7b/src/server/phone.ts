import { ApiError } from "@/server/http";

export function normalizePhoneNumber(value: unknown): string {
  if (typeof value !== "string") throw new ApiError("Nomor HP wajib diisi.", "VALIDATION_ERROR", 400);
  let phone = value.trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("08")) phone = `+62${phone.slice(1)}`;
  else if (phone.startsWith("8")) phone = `+62${phone}`;
  else if (phone.startsWith("62")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new ApiError("Format nomor HP tidak valid. Gunakan nomor internasional atau format Indonesia 08xx.", "VALIDATION_ERROR", 400);
  }
  return phone;
}
