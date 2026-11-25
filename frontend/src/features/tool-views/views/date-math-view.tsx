import { ArrowRight } from "lucide-react";
import { formatDate, plural } from "@/lib/format";
import { parseDateMathData } from "@/lib/tool-data";
import { JsonBlock } from "../json-block";
import type { ToolViewProps } from "../types";

function DateBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function DateMathView({ data }: ToolViewProps) {
  const result = parseDateMathData(data);
  if (!result) return <JsonBlock value={data} label="result" />;

  if (result.operation === "previous_month") {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <DateBox label="From (inclusive)" value={formatDate(result.start)} />
          <ArrowRight aria-hidden className="size-4 text-subtle" />
          <DateBox label="To (exclusive)" value={formatDate(result.end)} />
        </div>
        <p className="text-ui text-muted">
          The calendar month before {formatDate(result.referenceDate)}
          {result.daysInMonth !== null ? `, ${plural(result.daysInMonth, "day")}` : ""}.
        </p>
        {result.shippedAfter && result.shippedBefore ? (
          <p className="text-xs text-muted">
            Passed to query_orders as <code className="font-mono text-fg">shipped_after={result.shippedAfter}</code> and{" "}
            <code className="font-mono text-fg">shipped_before={result.shippedBefore}</code>.
          </p>
        ) : null}
      </div>
    );
  }

  if (result.operation === "days_between") {
    return (
      <p className="text-sm">
        <span className="font-medium tabular-nums">{plural(result.days, "day")}</span> from {formatDate(result.startDate)} to{" "}
        {formatDate(result.endDate)}.
      </p>
    );
  }

  return (
    <p className="text-sm">
      {formatDate(result.referenceDate)} {result.days < 0 ? "minus" : "plus"} {plural(Math.abs(result.days), "day")} is{" "}
      <span className="font-medium">{formatDate(result.result)}</span>.
    </p>
  );
}
