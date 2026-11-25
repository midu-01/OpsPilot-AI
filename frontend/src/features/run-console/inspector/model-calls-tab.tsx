import type { ModelAttemptSnapshot } from "@/lib/api";
import { formatCostUsd, formatCount } from "@/lib/format";
import { toolStatusMeta } from "@/lib/status";
import { Badge } from "@/components/ui/badge";

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatCount(value);
}

/** One entry per model call, from snapshot.model_calls. */
export function ModelCallsTab({ calls, live }: { calls: ModelAttemptSnapshot[]; live: boolean }) {
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted">
        Per-call usage comes from the run snapshot{live ? ", which reloads when you open this tab and when the run pauses or finishes" : ""}. A dash means the
        provider did not report that number.
      </p>
      {calls.length === 0 ? (
        <p className="text-ui text-muted">No model calls yet.</p>
      ) : (
        <ol className="space-y-2">
          {calls.map((call, index) => {
            const upperBound = call.pricing_snapshot?.basis === "upper_bound";
            return (
              <li key={call.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ui font-medium text-fg">
                    Call {index + 1} <span className="font-mono text-xs font-normal text-muted">{call.model}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {call.usage_complete ? null : <Badge tone="warning">partial usage</Badge>}
                    <Badge tone={toolStatusMeta(call.status).tone}>{toolStatusMeta(call.status).label}</Badge>
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Input</dt>
                    <dd className="font-medium text-fg tabular-nums">{count(call.input_tokens)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Output</dt>
                    <dd className="font-medium text-fg tabular-nums">{count(call.output_tokens)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Cached</dt>
                    <dd className="font-medium text-fg tabular-nums">{count(call.cached_tokens)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Cost</dt>
                    <dd className="font-medium text-fg tabular-nums">
                      {upperBound ? "≤" : ""}
                      {formatCostUsd(call.estimated_cost_usd)}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
