import { Skeleton } from "@/components/ui/skeleton";

/** Same blocks and heights as RunConsole, so the page does not shift when it loads. */
export function RunConsoleSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading run">
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-full max-w-3xl" />
        <Skeleton className="h-7 w-2/3 max-w-xl" />
        <div className="flex flex-wrap gap-5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-5 w-44" />
        </div>
      </div>
      <div className="-mx-4 flex items-center gap-3 border-y border-border px-4 py-2.5 sm:-mx-6 sm:px-6">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((cell) => (
          <div key={cell} className={cell === 4 ? "col-span-2 bg-surface px-3 py-2.5 sm:col-span-1" : "bg-surface px-3 py-2.5"}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-4 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-7 pt-2">
        {[0, 1, 2, 3].map((step) => (
          <div key={step} className="flex gap-3">
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2 pt-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
