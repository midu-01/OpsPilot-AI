import GoalComposer from "../components/goal-composer";
import BrowserConnection from "./browser-connection";
import { checkReadiness } from "../lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ready = await checkReadiness(process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000");

  return (
    <>
      <h1 className="page-title">Agent Run Console</h1>
      <p className="page-subtitle">
        Enter an operations goal. The agent plans steps, queries orders, checks shipping
        policies, and pauses for human approval before write actions.
      </p>

      {/* Goal Composer Card */}
      <GoalComposer />

      {/* System Status Panel */}
      <section className="card" aria-labelledby="status-heading" style={{ marginTop: "32px" }}>
        <h2 id="status-heading" style={{ fontSize: "1rem", margin: "0 0 12px" }}>
          Environment Status
        </h2>
        <dl style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--color-border)" }}>
            <dt style={{ color: "var(--color-text-muted)" }}>Backend &amp; Database</dt>
            <dd className={ready ? "badge badge-completed" : "badge badge-failed"}>
              {ready ? "Connected" : "Unavailable"}
            </dd>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
            <dt style={{ color: "var(--color-text-muted)" }}>Browser to API</dt>
            <BrowserConnection />
          </div>
        </dl>
      </section>
    </>
  );
}

