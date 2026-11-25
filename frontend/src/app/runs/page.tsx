import type { Metadata } from "next";
import Link from "next/link";
import { History, Plus } from "lucide-react";
import { RUNS_PAGE_SIZE, countUnfinished, parsePageParam, summarizePage } from "@/lib/runs-page";
import { plural } from "@/lib/format";
import { BackendUnavailable } from "@/components/states/backend-unavailable";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { AutoRefresh } from "@/features/runs/auto-refresh";
import { Pagination } from "@/features/runs/pagination";
import { RunsTable } from "@/features/runs/runs-table";
import { loadRuns } from "@/server/data";

export const metadata: Metadata = { title: "Runs" };

interface RunsPageProps {
  searchParams: Promise<{ page?: string | string[] }>;
}

/** Server Component: the run history, paginated with ?page=N (the API supports page and page_size only). */
export default async function RunsPage({ searchParams }: RunsPageProps) {
  const page = parsePageParam((await searchParams).page);
  const result = await loadRuns(page, RUNS_PAGE_SIZE);
  if (result.kind === "unavailable") {
    return <BackendUnavailable title="Runs can't be loaded right now" message={result.message} />;
  }

  const { items, total } = result.page;
  const summary = summarizePage(page, RUNS_PAGE_SIZE, total, items.length);
  const newRun = (
    <Link href="/" className={buttonClasses("primary")}>
      <Plus aria-hidden />
      New run
    </Link>
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Runs</h1>
          <p className="mt-1 text-sm text-muted">
            {total === 0 ? "Every run is stored, so its full trace can be replayed." : `${plural(total, "run")}, newest first. Open one to replay its trace.`}
          </p>
        </div>
        {newRun}
      </header>

      <AutoRefresh unfinished={countUnfinished(items)} />

      {total === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState icon={History} title="No runs yet" action={newRun}>
            Start a run and it will appear here with its status, steps, tokens, cost and duration.
          </EmptyState>
        </div>
      ) : summary.outOfRange ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={History}
            title={`Page ${page} is past the last page`}
            action={
              <Link href={summary.totalPages === 1 ? "/runs" : `/runs?page=${summary.totalPages}`} className={buttonClasses("secondary")}>
                Go to page {summary.totalPages}
              </Link>
            }
          >
            There are {plural(total, "run")} on {plural(summary.totalPages, "page")}.
          </EmptyState>
        </div>
      ) : (
        <>
          <RunsTable runs={items} now={result.loadedAt} caption={`Runs ${summary.from} to ${summary.to} of ${total}, newest first`} />
          <Pagination page={page} total={total} summary={summary} />
        </>
      )}
    </div>
  );
}
