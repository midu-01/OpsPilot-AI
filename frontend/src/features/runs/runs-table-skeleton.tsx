import { Skeleton } from "@/components/ui/skeleton";

const ROWS = 8;

/** Matches the runs page header, table rows and pagination, so nothing shifts on load. */
export function RunsPageSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading runs">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="h-[37px] border-b border-border bg-surface-2" />
        {Array.from({ length: ROWS }, (_, row) => (
          <div key={row} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <Skeleton className="h-6 w-24 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="hidden h-4 w-40 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
