/**
 * All display formatting lives here. Every function uses a fixed locale and an explicit
 * time zone, so the server render and the browser render produce the same text (no
 * hydration mismatches) no matter where the server or the viewer is.
 */

const LOCALE = "en-US";
const DAY_MS = 86_400_000;

const countFormat = new Intl.NumberFormat(LOCALE);

export function formatCount(value: number): string {
  return countFormat.format(value);
}

/** plural(1, "turn") -> "1 turn"; plural(3, "policy", "policies") -> "3 policies". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Money arrives as integer minor units (cents). 8451 USD -> "$84.51". */
export function formatMoneyMinor(amountMinor: number, currency = "USD"): string {
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency });
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`; // unknown currency code
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}

/** "$84.51 USD", for places where the currency must be explicit (approvals, receipts). */
export function formatMoneyWithCode(amountMinor: number, currency = "USD"): string {
  return `${formatMoneyMinor(amountMinor, currency)} ${currency}`;
}

/** Cost estimates are decimal strings with up to 10 places, or null when unknown. */
export function formatCostUsd(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  if (amount === 0) return "$0.00";
  if (amount < 0.0001) return "<$0.0001";
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: amount < 1 ? 4 : 2,
  }).format(amount);
}

/** 850 -> "850ms", 4230 -> "4.2s", 65_000 -> "1m 05s", 7_380_000 -> "2h 03m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function dateTimeFormat(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" }); // unknown zone name
  }
}

function toDate(iso: string): Date | null {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time);
}

/** "Feb 15, 2026". Date-only strings ("2026-02-15") are read as that calendar day. */
export function formatDate(iso: string, timeZone = "UTC"): string {
  const date = toDate(iso);
  return date ? dateTimeFormat(timeZone, { month: "short", day: "numeric", year: "numeric" }).format(date) : iso;
}

/** "Feb 15, 2026, 14:05 UTC" (24-hour clock, explicit zone). */
export function formatDateTime(iso: string, timeZone = "UTC"): string {
  const date = toDate(iso);
  if (!date) return iso;
  return dateTimeFormat(timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

/** "14:05:09", for event logs and decision records. */
export function formatTime(iso: string, timeZone = "UTC"): string {
  const date = toDate(iso);
  if (!date) return iso;
  return dateTimeFormat(timeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

/** "Jan 1 – Feb 1, 2026", or with both years when they differ. */
export function formatDateRange(startIso: string, endIso: string, timeZone = "UTC"): string {
  const start = toDate(startIso);
  const end = toDate(endIso);
  if (!start || !end) return `${startIso} – ${endIso}`;
  const year = (date: Date) => dateTimeFormat(timeZone, { year: "numeric" }).format(date);
  if (year(start) !== year(end)) return `${formatDate(startIso, timeZone)} – ${formatDate(endIso, timeZone)}`;
  const monthDay = dateTimeFormat(timeZone, { month: "short", day: "numeric" });
  return `${monthDay.format(start)} – ${monthDay.format(end)}, ${year(end)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. `nowMs` is passed in to keep this pure. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const seconds = Math.max(0, Math.round((nowMs - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export interface Lateness {
  /** Whole days late; 0 when on time; null when not shipped. */
  days: number | null;
  label: string;
}

/** Compares the promised and actual ship times: "3 days late", "On time", "Not shipped". */
export function lateness(promisedIso: string | null, shippedIso: string | null): Lateness {
  if (!shippedIso) return { days: null, label: "Not shipped" };
  const promised = promisedIso ? Date.parse(promisedIso) : Number.NaN;
  const shipped = Date.parse(shippedIso);
  if (Number.isNaN(promised) || Number.isNaN(shipped)) return { days: null, label: "Unknown" };
  const late = shipped - promised;
  if (late <= 0) return { days: 0, label: "On time" };
  const days = Math.floor(late / DAY_MS);
  if (days === 0) return { days: 0, label: "Under 1 day late" };
  return { days, label: `${plural(days, "day")} late` };
}
