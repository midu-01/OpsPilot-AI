import type { RunEvent } from "./api.ts";
import { formatCount, formatMoneyWithCode } from "./format.ts";
import { asNumber, asRecord, asString } from "./json.ts";

/** A short description of an event payload for the inspector's event log. */
export function summarizeEvent(event: RunEvent): string {
  const payload = event.payload;
  switch (event.type) {
    case "message.delta":
      return `+${formatCount((asString(payload.delta) ?? "").length)} chars`;
    case "message.completed": {
      const text = asString(payload.text);
      const status = asString(payload.status) ?? "completed";
      return text ? `${status}, ${formatCount(text.length)} chars` : `${status}, no text`;
    }
    case "tool.requested":
    case "tool.started":
    case "tool.completed":
      return asString(payload.name) ?? "";
    case "tool.failed":
      return [asString(payload.name), asString(payload.code)].filter(Boolean).join(" · ");
    case "approval.required": {
      const proposal = asRecord(payload.proposed_arguments);
      const amount = asNumber(proposal?.amount_minor);
      const order = asString(proposal?.order_id);
      const money = amount !== null ? formatMoneyWithCode(amount, asString(proposal?.currency) ?? "USD") : null;
      return [asString(payload.tool_name), money, order].filter(Boolean).join(" · ");
    }
    case "approval.decided":
      return asString(payload.status) ?? "";
    case "usage.updated": {
      const tokens = asNumber(payload.total_tokens);
      const partial = payload.token_usage_complete === false ? " (partial)" : "";
      return tokens !== null ? `${formatCount(tokens)} tokens${partial}` : "";
    }
    case "run.failed":
    case "run.cancelled":
      return asString(payload.code) ?? "";
    default:
      return "";
  }
}
