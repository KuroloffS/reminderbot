// Calendar dates as 'YYYY-MM-DD' strings. All arithmetic is done in UTC, so a date never shifts
// because of the machine's time zone; the user's local "today" comes from the database.

export type Ymd = string;

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const ymd = (y: number, m: number, d: number): Ymd => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

export function isValidDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: Ymd, days: number): Ymd {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** a - b in days. */
export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: Ymd): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Local calendar date of a unix timestamp for a fixed UTC offset in minutes. */
export function localDateFromUnix(seconds: number, offsetMin: number): Ymd {
  return new Date((seconds + offsetMin * 60) * 1000).toISOString().slice(0, 10);
}
