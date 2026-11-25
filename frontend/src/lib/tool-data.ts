import { asBoolean, asNumber, asRecord, asString, isRecord } from "./json.ts";

/**
 * Narrowing for tool results. ToolCallSnapshot.result is `ToolResult | string | null`,
 * and `data` is whatever the tool returned. Each parser returns null when the shape is
 * not what the view expects, and the view then falls back to raw JSON.
 * Shapes mirror backend/app/tools/*.py and backend/app/runs/refunds.py.
 */

export type ParsedResult =
  | { kind: "none" }
  | { kind: "success"; data: unknown }
  | { kind: "failure"; code: string; message: string }
  | { kind: "text"; text: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseToolResult(result: unknown): ParsedResult {
  if (result === null || result === undefined) return { kind: "none" };
  const value = typeof result === "string" ? parseJson(result) : result;
  if (isRecord(value) && value.ok === true) return { kind: "success", data: value.data ?? null };
  if (isRecord(value) && value.ok === false) {
    const error = asRecord(value.error);
    return {
      kind: "failure",
      code: asString(error?.code) ?? "TOOL_ERROR",
      message: asString(error?.message) ?? "The tool call failed.",
    };
  }
  return { kind: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
}

// --- query_orders -------------------------------------------------------------

export interface OrderRow {
  id: string;
  customerName: string | null;
  customerEmail: string | null;
  amountMinor: number | null;
  currency: string;
  status: string | null;
  promisedShipAt: string | null;
  shippedAt: string | null;
}

export interface OrdersData {
  orders: OrderRow[];
  count: number;
  offset: number;
  limit: number | null;
}

function parseOrderRow(value: unknown): OrderRow | null {
  const row = asRecord(value);
  const id = asString(row?.id);
  if (!row || !id) return null;
  return {
    id,
    customerName: asString(row.customer_name),
    customerEmail: asString(row.customer_email),
    amountMinor: asNumber(row.amount_minor),
    currency: asString(row.currency) ?? "USD",
    status: asString(row.status),
    promisedShipAt: asString(row.promised_ship_at),
    shippedAt: asString(row.shipped_at),
  };
}

export function parseOrdersData(data: unknown): OrdersData | null {
  const record = asRecord(data);
  if (!record || !Array.isArray(record.orders)) return null;
  const orders = record.orders.map(parseOrderRow).filter((row): row is OrderRow => row !== null);
  return {
    orders,
    count: asNumber(record.count) ?? orders.length,
    offset: asNumber(record.offset) ?? 0,
    limit: asNumber(record.limit),
  };
}

// --- search_policies -----------------------------------------------------------

export interface PolicyMatch {
  id: string;
  title: string;
  version: string | null;
  file: string | null;
  excerpt: string;
}

export interface PolicySearchData {
  query: string | null;
  matches: PolicyMatch[];
  totalPolicies: number | null;
  message: string | null;
}

export function parsePolicySearchData(data: unknown): PolicySearchData | null {
  const record = asRecord(data);
  if (!record || !Array.isArray(record.matches)) return null;
  const matches: PolicyMatch[] = [];
  for (const item of record.matches) {
    const match = asRecord(item);
    const id = asString(match?.id);
    if (!match || !id) continue;
    matches.push({
      id,
      title: asString(match.title) ?? id,
      version: asString(match.version),
      file: asString(match.file),
      excerpt: asString(match.excerpt) ?? "",
    });
  }
  return {
    query: asString(record.query),
    matches,
    totalPolicies: asNumber(record.total_policies),
    message: asString(record.message),
  };
}

// --- date_math -----------------------------------------------------------------

export type DateMathData =
  | {
      operation: "previous_month";
      referenceDate: string;
      start: string;
      end: string;
      daysInMonth: number | null;
      shippedAfter: string | null;
      shippedBefore: string | null;
    }
  | { operation: "days_between"; startDate: string; endDate: string; days: number }
  | { operation: "add_days"; referenceDate: string; days: number; result: string };

export function parseDateMathData(data: unknown): DateMathData | null {
  const record = asRecord(data);
  if (!record) return null;
  const operation = asString(record.operation);
  if (operation === "previous_month") {
    const referenceDate = asString(record.reference_date);
    const start = asString(record.start);
    const end = asString(record.end);
    if (!referenceDate || !start || !end) return null;
    return {
      operation,
      referenceDate,
      start,
      end,
      daysInMonth: asNumber(record.days_in_month),
      shippedAfter: asString(record.shipped_after),
      shippedBefore: asString(record.shipped_before),
    };
  }
  if (operation === "days_between") {
    const startDate = asString(record.start_date);
    const endDate = asString(record.end_date);
    const days = asNumber(record.days);
    return startDate && endDate && days !== null ? { operation, startDate, endDate, days } : null;
  }
  if (operation === "add_days") {
    const referenceDate = asString(record.reference_date);
    const days = asNumber(record.days);
    const result = asString(record.result);
    return referenceDate && result && days !== null ? { operation, referenceDate, days, result } : null;
  }
  return null;
}

// --- issue_refund ----------------------------------------------------------------

export interface RefundReceipt {
  refundId: string | null;
  orderId: string | null;
  amountMinor: number | null;
  currency: string;
  policyVersion: string | null;
  simulated: boolean;
  alreadyIssued: boolean;
}

export function parseRefundReceipt(data: unknown): RefundReceipt | null {
  const record = asRecord(data);
  if (!record || (asString(record.refund_id) === null && asString(record.order_id) === null)) return null;
  return {
    refundId: asString(record.refund_id),
    orderId: asString(record.order_id),
    amountMinor: asNumber(record.amount_minor),
    currency: asString(record.currency) ?? "USD",
    policyVersion: asString(record.policy_version),
    simulated: asBoolean(record.simulated) ?? true,
    alreadyIssued: asBoolean(record.already_issued) ?? false,
  };
}
