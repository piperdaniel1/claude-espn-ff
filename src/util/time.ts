/** Formatting helpers that keep every timestamp in the user's timezone. */

export function formatDateTime(input: number | Date | undefined | null, timeZone: string): string | null {
  if (input === undefined || input === null) return null;
  const d = typeof input === "number" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function formatDate(input: number | Date | undefined | null, timeZone: string): string | null {
  if (input === undefined || input === null) return null;
  const d = typeof input === "number" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function weekdayName(input: number | Date, timeZone: string): string {
  const d = typeof input === "number" ? new Date(input) : input;
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(d);
}

export function hoursBetween(from: number | Date, to: number | Date): number {
  const a = typeof from === "number" ? from : from.getTime();
  const b = typeof to === "number" ? to : to.getTime();
  return Math.round(((b - a) / 36e5) * 10) / 10;
}

export function humanDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 36e5);
  const minutes = Math.round((abs % 36e5) / 6e4);
  if (hours >= 48) return `${sign}${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${sign}${hours}h ${minutes}m`;
  return `${sign}${minutes}m`;
}
