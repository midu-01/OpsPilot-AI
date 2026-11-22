import Link from "next/link";
import { listRuns } from "../../lib/api";

export const dynamic = "force-dynamic";

interface RunsPageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function RunsHistoryPage({ searchParams }: RunsPageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const pageSize = 15;

  let runsData = null;
  let fetchError: string | null = null;

  try {
    runsData = await listRuns(page, pageSize);
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : "Failed to load runs history";
  }

  const total = runsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const runs = runsData?.items ?? [];

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <h1 className="page-title">Run History</h1>
          <p className="page-subtitle" style={{ margin: 0 }}>
            Revisit past agent operations, inspect execution traces, and audit approval decisions.
          </p>
        </div>
        <Link href="/" className="btn btn-primary">
          + New Run
        </Link>
      </div>

      {fetchError && (
        <div className="alert alert-error" role="alert">
          {fetchError}
        </div>
      )}

      {runs.length === 0 && !fetchError ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <h3 style={{ margin: "0 0 8px" }}>No runs found</h3>
          <p style={{ color: "var(--color-text-muted)", margin: "0 0 20px" }}>
            Submit an operations goal to launch your first agent run.
          </p>
          <Link href="/" className="btn btn-primary">
            Start a Run
          </Link>
        </div>
      ) : (
        <section className="card" style={{ padding: 0, overflow: "hidden" }} aria-labelledby="runs-table-title">
          <h2 id="runs-table-title" className="sr-only" style={{ display: "none" }}>
            Operations Runs Table
          </h2>
          <div className="table-container">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Goal</th>
                  <th>Steps</th>
                  <th>Tokens</th>
                  <th>Cost (est.)</th>
                  <th>Duration</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const durationSec =
                    typeof run.duration_ms === "number" ? (run.duration_ms / 1000).toFixed(1) + "s" : "—";
                  const cost =
                    run.estimated_cost_usd !== null && run.estimated_cost_usd !== undefined
                      ? `$${parseFloat(run.estimated_cost_usd).toFixed(4)}`
                      : "—";

                  return (
                    <tr key={run.id}>
                      <td>
                        <span className={`badge badge-${run.status}`}>
                          {run.status.replace("_", " ")}
                        </span>
                      </td>
                      <td style={{ maxWidth: "280px" }}>
                        <Link
                          href={`/runs/${run.id}`}
                          style={{
                            fontWeight: 600,
                            color: "var(--color-text)",
                            textDecoration: "none",
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {run.goal}
                        </Link>
                        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                          {run.id.slice(0, 8)}
                        </span>
                      </td>
                      <td>{run.step_count}</td>
                      <td>{run.total_tokens.toLocaleString()}</td>
                      <td>{cost}</td>
                      <td>{durationSec}</td>
                      <td style={{ fontSize: "0.82rem", color: "var(--color-text-muted)" }}>
                        {new Date(run.created_at).toLocaleString()}
                      </td>
                      <td>
                        <Link
                          href={`/runs/${run.id}`}
                          className="btn btn-secondary"
                          style={{ padding: "4px 10px", fontSize: "0.82rem" }}
                        >
                          View Trace →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination controls */}
          <div className="pagination" style={{ padding: "16px 20px" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              Showing {runs.length > 0 ? (page - 1) * pageSize + 1 : 0} to{" "}
              {Math.min(page * pageSize, total)} of {total} runs
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              <Link
                href={`/runs?page=${page - 1}`}
                className={`btn btn-secondary ${page <= 1 ? "disabled" : ""}`}
                style={{
                  pointerEvents: page <= 1 ? "none" : "auto",
                  opacity: page <= 1 ? 0.5 : 1,
                  padding: "6px 12px",
                  fontSize: "0.85rem",
                }}
                aria-disabled={page <= 1}
              >
                ← Previous
              </Link>
              <Link
                href={`/runs?page=${page + 1}`}
                className={`btn btn-secondary ${page >= totalPages ? "disabled" : ""}`}
                style={{
                  pointerEvents: page >= totalPages ? "none" : "auto",
                  opacity: page >= totalPages ? 0.5 : 1,
                  padding: "6px 12px",
                  fontSize: "0.85rem",
                }}
                aria-disabled={page >= totalPages}
              >
                Next →
              </Link>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
