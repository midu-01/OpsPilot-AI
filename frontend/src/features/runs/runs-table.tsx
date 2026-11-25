import Link from "next/link";
import type { RunSummary } from "@/lib/api";
import { formatCostUsd, formatCount, formatDateTime, formatDuration, formatRelativeTime, plural } from "@/lib/format";
import { runStatusMeta } from "@/lib/status";
import { StatusPill } from "@/components/ui/status-pill";

interface RunsTableProps {
  runs: RunSummary[];
  /** Server time the list was loaded, for relative "created" times. */
  now: number;
  caption: string;
}

/**
 * Server-rendered list of runs. Each row has one link (the goal) whose ::after covers
 * the row, so the whole row is clickable and keyboard users get one tab stop per run.
 */
export function RunsTable({ runs, now, caption }: RunsTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-ui">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border bg-surface-2 text-xs text-muted">
          <tr>
            <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Status</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Goal</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Steps</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Tokens</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">Cost</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Duration</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run, now }: { run: RunSummary; now: number }) {
  const created = formatDateTime(run.created_at);
  const tokens = `${formatCount(run.total_tokens)}${run.token_usage_complete === false ? "+" : ""}`;
  const cost = `${run.cost_is_upper_bound ? "≤" : ""}${formatCostUsd(run.estimated_cost_usd)}`;
  return (
    <tr title={`${run.goal}\nCreated ${created}`} className="relative transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2">
      <td className="hidden px-4 py-3 align-top whitespace-nowrap sm:table-cell">
        <StatusPill meta={runStatusMeta(run.status)} />
      </td>
      <td className="w-full max-w-0 px-4 py-3 align-top">
        <Link
          href={`/runs/${run.id}`}
          className="line-clamp-2 font-medium text-fg outline-none sm:line-clamp-1 after:absolute after:inset-0 after:rounded-sm after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          {run.goal}
        </Link>
        <span className="mt-0.5 hidden font-mono text-xs text-subtle sm:block">
          {run.id.slice(0, 8)}
          <span className="font-sans md:hidden">
            {" · "}
            {plural(run.step_count, "step")} · {tokens} tokens
          </span>
        </span>
        {/* Small screens: status and key numbers under the goal instead of in columns. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle sm:hidden">
          <StatusPill meta={runStatusMeta(run.status)} />
          <span>
            {plural(run.step_count, "step")} · {tokens} tokens · {formatRelativeTime(run.created_at, now)}
          </span>
        </span>
      </td>
      <td className="hidden px-4 py-3 text-right align-top tabular-nums md:table-cell">{run.step_count}</td>
      <td className="hidden px-4 py-3 text-right align-top tabular-nums md:table-cell">
        {tokens}
        {run.token_usage_complete === false ? <span className="sr-only"> (some usage not reported)</span> : null}
      </td>
      <td className="hidden px-4 py-3 text-right align-top tabular-nums lg:table-cell">
        {cost}
        {run.cost_is_upper_bound ? <span className="sr-only"> (upper bound)</span> : null}
      </td>
      <td className="hidden px-4 py-3 text-right align-top tabular-nums md:table-cell">{formatDuration(run.duration_ms)}</td>
      <td className="hidden px-4 py-3 text-right align-top whitespace-nowrap text-muted sm:table-cell">
        <time dateTime={run.created_at}>
          {formatRelativeTime(run.created_at, now)}
          <span className="sr-only">, {created}</span>
        </time>
      </td>
    </tr>
  );
}
