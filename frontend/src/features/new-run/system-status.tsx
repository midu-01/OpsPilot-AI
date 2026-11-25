import { loadReadiness } from "@/server/data";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BrowserCheck } from "./browser-check";
import { StatusDot } from "./status-dot";

/** Server Component, streamed in with Suspense: readiness as seen from the Next.js server. */
export async function SystemStatus() {
  const readiness = await loadReadiness();
  const database = readiness.details.database;
  return (
    <Card>
      <CardHeader title="System status" titleId="status-heading" />
      <dl aria-labelledby="status-heading" className="divide-y divide-border text-ui">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted">Backend API</dt>
          <dd>
            {readiness.status === "ready" ? (
              <StatusDot tone="success" label="Ready" />
            ) : (
              <StatusDot tone="danger" label={readiness.status === "unreachable" ? "Unreachable" : "Unavailable"} />
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted">Database</dt>
          <dd>
            {database === "connected" ? (
              <StatusDot tone="success" label="Connected" />
            ) : (
              <StatusDot tone={database ? "danger" : "neutral"} label={database ? "Unavailable" : "Unknown"} />
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted">Browser to API</dt>
          <dd>
            <BrowserCheck />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

export function SystemStatusSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading system status">
      <CardHeader title="System status" />
      <div className="divide-y divide-border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center justify-between px-4 py-2.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
        ))}
      </div>
    </Card>
  );
}
