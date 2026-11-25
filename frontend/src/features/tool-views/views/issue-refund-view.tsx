import { ReceiptText } from "lucide-react";
import { formatMoneyWithCode } from "@/lib/format";
import { parseRefundReceipt } from "@/lib/tool-data";
import { JsonBlock } from "../json-block";
import type { ToolViewProps } from "../types";

/** The simulated refund receipt returned after an approved refund executes. */
export function IssueRefundView({ data }: ToolViewProps) {
  const receipt = parseRefundReceipt(data);
  if (!receipt) return <JsonBlock value={data} label="result" />;

  return (
    <div className="rounded-md border border-success-border bg-success-soft px-3 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-success">
        <ReceiptText aria-hidden className="size-4" />
        {receipt.alreadyIssued ? "Refund was already recorded" : "Simulated refund recorded"}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
        <dt className="text-muted">Amount</dt>
        <dd className="font-medium tabular-nums text-fg">
          {receipt.amountMinor !== null ? formatMoneyWithCode(receipt.amountMinor, receipt.currency) : "—"}
        </dd>
        <dt className="text-muted">Order</dt>
        <dd className="font-mono text-fg">{receipt.orderId ?? "—"}</dd>
        <dt className="text-muted">Refund ID</dt>
        <dd className="font-mono break-all text-fg">{receipt.refundId ?? "—"}</dd>
        <dt className="text-muted">Policy</dt>
        <dd className="text-fg">{receipt.policyVersion ?? "—"}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted">Written to the simulated ledger. No money moved.</p>
    </div>
  );
}
