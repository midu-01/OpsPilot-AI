"use client";

import { useState } from "react";
import Link from "next/link";
import { type RunSnapshot, stopRun, ApiError } from "../lib/api";
import { useRunStream } from "../features/run-console/use-run-stream";
import RunTimeline from "./run-timeline";
import ApprovalCard from "./approval-card";

interface RunConsoleProps {
  initialSnapshot: RunSnapshot;
}

export default function RunConsole({ initialSnapshot }: RunConsoleProps) {
  const { state, connection, refresh, markStopping } = useRunStream(initialSnapshot);
  const [isStopping, setIsStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isTerminal =
    state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  const effectiveConnectionStatus =
    connection === "offline" ? "error" : connection === "live" || connection === "reconnecting" ? connection : "idle";
  const reconcile = refresh;

  // Handle Stop button
  async function handleStop() {
    setIsStopping(true);
    setActionError(null);
    try {
      await stopRun(state.id);
      markStopping();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setActionError("Run is already terminal or cannot be stopped.");
      } else {
        setActionError(err instanceof Error ? err.message : "Failed to stop run");
      }
    } finally {
      setIsStopping(false);
    }
  }

  const canStop =
    state.status === "queued" ||
    state.status === "running" ||
    state.status === "awaiting_approval";

  return (
    <div>
      {/* Top Breadcrumb & Controls */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <Link href="/runs" className="btn btn-secondary" style={{ padding: "6px 14px" }}>
          ← Back to Runs
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {canStop && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleStop}
              disabled={isStopping}
              aria-label="Stop run in progress"
            >
              {isStopping ? "Stopping…" : "Stop Run"}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
        </div>
      )}

      {/* Run Header Card */}
      <section className="card" aria-labelledby="run-heading">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <h1 id="run-heading" style={{ fontSize: "1.4rem", margin: "0 0 6px" }}>
              Run <code>{state.id.slice(0, 8)}</code>
            </h1>
            <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              <span>Model: <strong>{state.model}</strong></span>
              <span style={{ marginInline: "8px" }}>•</span>
              <span>Started: {new Date(state.reference_time).toLocaleTimeString()}</span>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className={`badge badge-${state.status}`}>
              {state.status === "running" && <span className="pulse-dot" />}
              {state.status.replace("_", " ")}
            </span>
            <span
              style={{
                fontSize: "0.8rem",
                color: "var(--color-text-muted)",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {effectiveConnectionStatus === "live" && <span className="pulse-dot" />}
              {effectiveConnectionStatus === "live"
                ? "Live"
                : effectiveConnectionStatus === "reconnecting"
                  ? "Reconnecting…"
                  : effectiveConnectionStatus === "error"
                    ? "Offline — retrying…"
                    : isTerminal
                      ? "Persisted"
                      : "Connecting…"}
            </span>
          </div>
        </div>

        {/* Metrics Bar */}
        <div className="metrics-grid" role="region" aria-label="Run Metrics">
          <div className="metric-box">
            <div className="metric-label">Agent Turns</div>
            <div className="metric-value">
              {state.step_count} <span style={{ fontSize: "0.85rem", fontWeight: 400 }}>/ {state.max_agent_steps}</span>
            </div>
          </div>

          <div className="metric-box">
            <div className="metric-label">Tool Calls</div>
            <div className="metric-value">
              {state.tool_call_count} <span style={{ fontSize: "0.85rem", fontWeight: 400 }}>/ {state.max_tool_calls}</span>
            </div>
          </div>

          <div className="metric-box">
            <div className="metric-label">Total Tokens</div>
            <div className="metric-value">
              {state.total_tokens.toLocaleString()}
            </div>
            {state.token_usage_complete === false && (
              <div className="metric-sub">Incomplete</div>
            )}
          </div>

          <div className="metric-box">
            <div className="metric-label">Estimated Cost</div>
            <div className="metric-value">
              {state.estimated_cost_usd ? `$${parseFloat(state.estimated_cost_usd).toFixed(4)}` : "—"}
            </div>
            {state.cost_is_upper_bound && (
              <div className="metric-sub">Upper bound</div>
            )}
          </div>

          <div className="metric-box">
            <div className="metric-label">Elapsed</div>
            <div className="metric-value">
              {(state.active_elapsed_ms / 1000).toFixed(1)}s
            </div>
          </div>
        </div>

        {/* Pending Approval Card */}
        {state.pending_approval && (
          <ApprovalCard
            approval={state.pending_approval}
            runId={state.id}
            onDecisionSubmitted={() => reconcile()}
          />
        )}

        {/* Timeline */}
        <RunTimeline
          goal={state.goal}
          status={state.status}
          messages={state.messages}
          toolCalls={state.tool_calls}
          approvals={state.approvals}
          error={state.error}
        />
      </section>
    </div>
  );
}
