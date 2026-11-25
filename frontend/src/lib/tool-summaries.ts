import { formatDate, formatDateRange, formatMoneyMinor, formatMoneyWithCode, plural } from "./format.ts";
import { asNumber, asString } from "./json.ts";
import {
  parseDateMathData,
  parseOrdersData,
  parsePolicySearchData,
  parseRefundReceipt,
  type ParsedResult,
} from "./tool-data.ts";

/**
 * One-line, human summaries for tool cards:
 *   summarizeToolCall   -> what the agent asked for  ("Late orders over $500.00, shipped Jan 1 – Feb 1, 2026")
 *   summarizeToolResult -> what came back             ("10 orders")
 * Unknown tools get a generic "key: value" summary.
 */

export function summarizeToolCall(name: string, args: Record<string, unknown>, timeZone = "UTC"): string {
  switch (name) {
    case "date_math":
      return summarizeDateMath(args);
    case "query_orders":
      return summarizeOrderQuery(args, timeZone);
    case "search_policies": {
      const query = asString(args.query);
      return query ? `Search policies for "${query}"` : "Search policies";
    }
    case "issue_refund": {
      const order = asString(args.order_id);
      const reason = asString(args.reason);
      return [order ? `Refund ${order}` : "Refund", reason].filter(Boolean).join(": ");
    }
    default:
      return summarizeGeneric(args);
  }
}

function summarizeDateMath(args: Record<string, unknown>): string {
  const operation = asString(args.operation);
  const reference = asString(args.reference_date);
  if (operation === "previous_month") {
    return reference ? `Previous calendar month before ${formatDate(reference)}` : "Previous calendar month";
  }
  if (operation === "days_between") {
    const start = asString(args.start_date);
    const end = asString(args.end_date);
    return start && end ? `Days from ${formatDate(start)} to ${formatDate(end)}` : "Days between two dates";
  }
  if (operation === "add_days") {
    const days = asNumber(args.days) ?? 0;
    const base = reference ? formatDate(reference) : "The reference date";
    return `${base} ${days < 0 ? "minus" : "plus"} ${plural(Math.abs(days), "day")}`;
  }
  return summarizeGeneric(args);
}

const SORT_LABELS: Record<string, string> = { amount_minor: "amount", shipped_at: "ship date" };

function summarizeOrderQuery(args: Record<string, unknown>, timeZone: string): string {
  const after = asString(args.shipped_after);
  const before = asString(args.shipped_before);
  const hasRange = Boolean(after || before);
  const status = asString(args.status);
  const late = args.late_only === true;
  const min = asNumber(args.min_amount_minor);
  const max = asNumber(args.max_amount_minor);

  // "shipped Jan 1 – Feb 1" already says the status, so skip a redundant "shipped orders".
  const showStatus = status !== null && !(status === "shipped" && hasRange);
  const noun = [late ? "late" : null, showStatus ? status.replaceAll("_", " ") : null, "orders"].filter(Boolean).join(" ");
  const hasFilter = late || showStatus || min !== null || max !== null || hasRange;
  let subject = hasFilter ? noun[0].toUpperCase() + noun.slice(1) : "All orders";
  if (min !== null) subject += ` over ${formatMoneyMinor(min)}`;
  if (max !== null) subject += `${min !== null ? " and" : ""} up to ${formatMoneyMinor(max)}`;

  const parts = [subject];
  if (after && before) parts.push(`shipped ${formatDateRange(after, before, timeZone)}`);
  else if (after) parts.push(`shipped since ${formatDate(after, timeZone)}`);
  else if (before) parts.push(`shipped before ${formatDate(before, timeZone)}`);

  const sortBy = asString(args.sort_by);
  if (sortBy && SORT_LABELS[sortBy]) parts.push(`by ${SORT_LABELS[sortBy]}${args.sort_order === "desc" ? ", highest first" : ""}`);
  const limit = asNumber(args.limit);
  if (!hasFilter && limit !== null) parts.push(`up to ${limit}`);
  return parts.join(", ");
}

function summarizeGeneric(args: Record<string, unknown>): string {
  const pairs = Object.entries(args)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return pairs.length > 0 ? pairs.join(", ") : "No arguments";
}

export function summarizeToolResult(name: string, result: ParsedResult): string | null {
  if (result.kind !== "success") return null;
  switch (name) {
    case "query_orders": {
      const data = parseOrdersData(result.data);
      if (!data) return null;
      return data.count === 0 ? "No matching orders" : plural(data.count, "order");
    }
    case "search_policies": {
      const data = parsePolicySearchData(result.data);
      if (!data) return null;
      return data.matches.length === 0 ? "No matching policies" : plural(data.matches.length, "policy", "policies");
    }
    case "date_math": {
      const data = parseDateMathData(result.data);
      if (!data) return null;
      if (data.operation === "previous_month") return formatDateRange(data.start, data.end);
      if (data.operation === "days_between") return plural(data.days, "day");
      return formatDate(data.result);
    }
    case "issue_refund": {
      const receipt = parseRefundReceipt(result.data);
      if (!receipt || receipt.amountMinor === null) return null;
      const money = formatMoneyWithCode(receipt.amountMinor, receipt.currency);
      return receipt.alreadyIssued ? `${money} already recorded` : `${money} recorded`;
    }
    default:
      return null;
  }
}
