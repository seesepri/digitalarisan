export function formatIDR(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number(value) : value ?? 0;
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function formatDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(options ?? {}),
  }).format(date);
}

export function formatDateTime(value: string | Date): string {
  return formatDate(value, { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
}

export function daysRemaining(value: string | Date): number {
  const target = new Date(value).getTime();
  return Number.isNaN(target) ? 0 : Math.max(0, Math.ceil((target - Date.now()) / 86_400_000));
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
