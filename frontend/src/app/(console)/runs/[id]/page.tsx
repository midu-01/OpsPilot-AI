import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loginPath } from "@/lib/auth";
import { truncate } from "@/lib/format";
import { BackendUnavailable } from "@/components/states/backend-unavailable";
import { RunConsole } from "@/features/run-console/run-console";
import { loadRun } from "@/server/data";

interface RunPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: RunPageProps): Promise<Metadata> {
  const result = await loadRun((await params).id);
  return { title: result.kind === "ok" ? truncate(result.snapshot.goal, 60) : "Run" };
}

/**
 * Server Component: fetches the run snapshot (GET /runs/{id}) and hands it to the
 * client console, which streams everything after the snapshot's cursor. Another user's
 * run is "not found"; a 401 sends the user to sign in and back here.
 */
export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params;
  const result = await loadRun(id);
  if (result.kind === "signed-out") redirect(loginPath(`/runs/${encodeURIComponent(id)}`));
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") {
    return <BackendUnavailable title="This run can't be loaded right now" message={result.message} />;
  }
  return <RunConsole key={result.snapshot.id} initialSnapshot={result.snapshot} />;
}
