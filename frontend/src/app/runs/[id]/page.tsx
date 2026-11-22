import Link from "next/link";
import { getRun } from "../../../lib/api";
import RunConsole from "../../../components/run-console";

export const dynamic = "force-dynamic";

interface RunPageProps {
  params: Promise<{ id: string }>;
}

export default async function RunDetailPage({ params }: RunPageProps) {
  const { id } = await params;

  let snapshot = null;
  let errorMessage: string | null = null;

  try {
    snapshot = await getRun(id);
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : "Run not found";
  }

  if (!snapshot) {
    return (
      <div className="card" role="alert">
        <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--color-danger)" }}>
          Run Not Found
        </h1>
        <p className="page-subtitle" style={{ marginBottom: "20px" }}>
          Could not load run with ID <code>{id}</code>. ({errorMessage})
        </p>
        <Link href="/runs" className="btn btn-secondary">
          ← View All Runs
        </Link>
      </div>
    );
  }

  return <RunConsole initialSnapshot={snapshot} />;
}
