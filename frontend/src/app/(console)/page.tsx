import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { composerReturnPath, loginPath } from "@/lib/auth";
import { GoalComposer } from "@/features/new-run/goal-composer";
import { RecentRuns, RecentRunsSkeleton } from "@/features/new-run/recent-runs";
import { SystemStatus, SystemStatusSkeleton } from "@/features/new-run/system-status";
import { ToolCatalogPanel } from "@/features/new-run/tool-catalog-panel";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "New run" };

interface NewRunPageProps {
  /** ?goal= prefills the composer ("Retry with this goal" links here). */
  searchParams: Promise<{ goal?: string | string[] }>;
}

/**
 * Server Component. The composer paints immediately; system status and recent runs
 * stream in through their own Suspense boundaries. A stale session cookie (expired or
 * revoked) passes proxy.ts, so the page asks the backend who is signed in; the layout
 * already did, and cache() makes that one call.
 */
export default async function NewRunPage({ searchParams }: NewRunPageProps) {
  const raw = (await searchParams).goal;
  const initialGoal = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 2000) ?? "";
  if ((await getCurrentUser()).kind === "signed-out") {
    redirect(loginPath(composerReturnPath(initialGoal)));
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="new-run-heading" className="min-w-0 space-y-5">
        <header>
          <h1 id="new-run-heading" className="text-xl font-semibold tracking-tight text-fg">
            Start a run
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Describe an operations task. The agent works through it with typed, read-only tools, streams every step, and
            pauses for your approval before it writes anything.
          </p>
        </header>
        <GoalComposer key={initialGoal} initialGoal={initialGoal} />
      </section>

      <aside aria-label="Agent and system" className="space-y-5">
        <ToolCatalogPanel />
        <Suspense fallback={<SystemStatusSkeleton />}>
          <SystemStatus />
        </Suspense>
        <Suspense fallback={<RecentRunsSkeleton />}>
          <RecentRuns />
        </Suspense>
      </aside>
    </div>
  );
}
