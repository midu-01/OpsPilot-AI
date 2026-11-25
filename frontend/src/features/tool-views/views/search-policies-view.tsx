import { FileText } from "lucide-react";
import { parsePolicySearchData } from "@/lib/tool-data";
import { JsonBlock } from "../json-block";
import type { ToolViewProps } from "../types";

export function SearchPoliciesView({ data }: ToolViewProps) {
  const result = parsePolicySearchData(data);
  if (!result) return <JsonBlock value={data} label="result" />;

  if (result.matches.length === 0) {
    return <p className="text-sm text-muted">{result.message ?? "No policies matched the search terms."}</p>;
  }

  return (
    <ul className="space-y-2">
      {result.matches.map((match) => (
        <li key={match.id} className="rounded-md border border-border bg-surface px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs font-semibold text-link">
              {match.id}
            </span>
            <span className="text-sm font-medium">{match.title}</span>
            {match.version ? <span className="text-xs text-muted">{match.version}</span> : null}
            {match.file ? (
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-subtle">
                <FileText aria-hidden className="size-3.5" />
                {match.file}
              </span>
            ) : null}
          </div>
          {match.excerpt ? <p className="mt-1.5 line-clamp-4 text-ui text-muted">{match.excerpt}</p> : null}
        </li>
      ))}
      {result.totalPolicies !== null ? (
        <li className="text-xs text-subtle">
          {result.matches.length} of {result.totalPolicies} policies matched
          {result.query ? ` "${result.query}"` : ""}.
        </li>
      ) : null}
    </ul>
  );
}
