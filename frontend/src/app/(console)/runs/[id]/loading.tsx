import { RunConsoleSkeleton } from "@/features/run-console/run-console-skeleton";

/** Shown immediately on navigation while the server loads the run snapshot. */
export default function Loading() {
  return <RunConsoleSkeleton />;
}
