"use client";

import { useState } from "react";
import { asNumber, asString } from "@/lib/json";
import { formatDate, formatDateRange, formatMoneyMinor, lateness, plural } from "@/lib/format";
import { parseOrdersData, type OrderRow } from "@/lib/tool-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonBlock } from "../json-block";
import type { ToolViewProps } from "../types";

const INITIAL_ROWS = 10;

/** The typed filters the agent used, as chips. */
function filterChips(args: Record<string, unknown>, timeZone: string): string[] {
  const chips: string[] = [];
  if (args.late_only === true) chips.push("Late only");
  const status = asString(args.status);
  if (status) chips.push(`Status: ${status.replaceAll("_", " ")}`);
  const min = asNumber(args.min_amount_minor);
  if (min !== null) chips.push(`Over ${formatMoneyMinor(min)}`);
  const max = asNumber(args.max_amount_minor);
  if (max !== null) chips.push(`Up to ${formatMoneyMinor(max)}`);
  const after = asString(args.shipped_after);
  const before = asString(args.shipped_before);
  if (after && before) chips.push(`Shipped ${formatDateRange(after, before, timeZone)}`);
  else if (after) chips.push(`Shipped since ${formatDate(after, timeZone)}`);
  else if (before) chips.push(`Shipped before ${formatDate(before, timeZone)}`);
  const limit = asNumber(args.limit);
  if (limit !== null) chips.push(`Limit ${limit}`);
  return chips;
}

function LateBadge({ order }: { order: OrderRow }) {
  const late = lateness(order.promisedShipAt, order.shippedAt);
  if (late.days === null) return <Badge tone="neutral">{late.label}</Badge>;
  if (late.days === 0 && late.label === "On time") return <Badge tone="success">On time</Badge>;
  return <Badge tone="warning">{late.days === 0 ? "<1 day" : plural(late.days, "day")}</Badge>;
}

export function QueryOrdersView({ call, data, timeZone }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false);
  const result = parseOrdersData(data);
  if (!result) return <JsonBlock value={data} label="result" />;

  const chips = filterChips(call.arguments, timeZone);
  const rows = showAll ? result.orders : result.orders.slice(0, INITIAL_ROWS);

  return (
    <div className="space-y-3">
      {chips.length > 0 ? (
        <ul aria-label="Filters" className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li key={chip} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
              {chip}
            </li>
          ))}
        </ul>
      ) : null}

      {result.orders.length === 0 ? (
        <p className="text-sm text-muted">No orders matched these filters.</p>
      ) : (
        <div tabIndex={0} role="region" aria-label="Orders" className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[36rem] text-left text-ui">
            <caption className="sr-only">Orders returned by query_orders</caption>
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Order</th>
                <th scope="col" className="px-3 py-2 font-medium">Customer</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                <th scope="col" className="px-3 py-2 font-medium">Promised → shipped</th>
                <th scope="col" className="px-3 py-2 font-medium">Late by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((order) => (
                <tr key={order.id}>
                  <td className="px-3 py-2 align-top">
                    <span className="font-mono font-medium">{order.id}</span>
                    {order.status ? <span className="block text-xs text-subtle">{order.status.replaceAll("_", " ")}</span> : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className="block">{order.customerName ?? "—"}</span>
                    {order.customerEmail ? <span className="block text-xs text-subtle">{order.customerEmail}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right align-top font-medium tabular-nums">
                    {order.amountMinor !== null ? formatMoneyMinor(order.amountMinor, order.currency) : "—"}
                  </td>
                  <td className="px-3 py-2 align-top tabular-nums text-muted">
                    <span className="block">{order.promisedShipAt ? formatDate(order.promisedShipAt, timeZone) : "—"}</span>
                    <span className="block text-fg">{order.shippedAt ? formatDate(order.shippedAt, timeZone) : "Not shipped"}</span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <LateBadge order={order} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {plural(result.count, "order")}
          {result.offset > 0 ? `, starting at #${result.offset + 1}` : ""}
          {result.limit !== null && result.count >= result.limit ? ` (the limit of ${result.limit} was reached)` : ""}
        </span>
        {result.orders.length > INITIAL_ROWS ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)} aria-expanded={showAll}>
            {showAll ? "Show fewer" : `Show all ${result.orders.length}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
