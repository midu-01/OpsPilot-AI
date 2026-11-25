import Link from "next/link";
import { loginPath } from "@/lib/auth";
import { formatRelativeTime } from "@/lib/format";
import { runStatusMeta } from "@/lib/status";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { loadRuns } from "@/server/data";

const RECENT_COUNT = 5;

function AllRunsLink() {
  return (
    <Link href="/runs" className="text-ui font-medium text-link hover:underline">
      All runs
    </Link>
  );
}

/** Server Component, streamed in with Suspense, so a slow backend never blocks the composer. */
export async function RecentRuns() {
  const result = await loadRuns(1, RECENT_COUNT);
  return (
    <Card>
      <CardHeader title="Recent runs" titleId="recent-heading" actions={<AllRunsLink />} />
      {result.kind === "signed-out" ? (
        <p className="px-4 py-3 text-ui text-muted">
          Your session has ended.{" "}
          <Link href={loginPath("/")} className="font-medium text-link hover:underline">
            Sign in again
          </Link>{" "}
          to see your runs.
        </p>
      ) : result.kind === "unavailable" ? (
        <p className="px-4 py-3 text-ui text-muted">Recent runs are unavailable. {result.message}</p>
      ) : result.page.items.length === 0 ? (
        <p className="px-4 py-3 text-ui text-muted">No runs yet. Your first run will show up here.</p>
      ) : (
        <ul aria-labelledby="recent-heading" className="divide-y divide-border">
          {result.page.items.map((run) => (
            <li key={run.id} className="relative px-4 py-2.5 hover:bg-surface-2">
              <Link
                href={`/runs/${run.id}`}
                className="line-clamp-1 text-ui font-medium text-fg outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
              >
                {run.goal}
              </Link>
              <div className="mt-1 flex items-center gap-2 text-xs text-subtle">
                <StatusPill meta={runStatusMeta(run.status)} />
                <time dateTime={run.created_at}>{formatRelativeTime(run.created_at, result.loadedAt)}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RecentRunsSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading recent runs">
      <CardHeader title="Recent runs" />
      <div className="divide-y divide-border">
        {Array.from({ length: 3 }, (_, row) => (
          <div key={row} className="space-y-2 px-4 py-2.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
      </div>
    </Card>
  );
}
