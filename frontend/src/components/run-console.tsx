"use client";

import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import Link from "next/link";
import {
  type RunSnapshot,
  getRun,
  stopRun,
  getStreamUrl,
  ApiError,
} from "../lib/api";
import { createInitialRunState, reduceRunEvent, reduceRunState } from "../lib/run-events";
import { readRunEvents } from "../lib/run-stream";
import RunTimeline from "./run-timeline";
import ApprovalCard from "./approval-card";

interface RunConsoleProps {
  initialSnapshot: RunSnapshot;
}

export default function RunConsole({ initialSnapshot }: RunConsoleProps) {
  const [state, dispatch] = useReducer(reduceRunState, initialSnapshot, createInitialRunState);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "live" | "reconnecting" | "idle" | "error">("connecting");
  const [isStopping, setIsStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const isTerminal =
    state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  const effectiveConnectionStatus = isTerminal ? "idle" : connectionStatus;

  const reconcile = useCallback(async (signal?: AbortSignal) => {
    const fresh = await getRun(state.id, { signal });
    if (!signal?.aborted) {
      stateRef.current = createInitialRunState(fresh);
      dispatch({ type: "snapshot", snapshot: fresh });
    }
  }, [state.id]);

  // Connect to SSE stream
  useEffect(() => {
    if (isTerminal) {
      return;
    }

    let isMounted = true;
    const abortController = new AbortController();
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let resolveRetry: (() => void) | null = null;
    let backoffMs = 1000;

    async function streamLoop() {
      while (isMounted) {
        const currentCursor = stateRef.current.cursor;
        const currentStatus = stateRef.current.status;
        const isCurrentlyTerminal =
          currentStatus === "completed" ||
          currentStatus === "failed" ||
          currentStatus === "cancelled";

        if (isCurrentlyTerminal) {
          if (isMounted) setConnectionStatus("idle");
          break;
        }

        try {
          if (isMounted) {
            setConnectionStatus(currentCursor > 0 ? "live" : "connecting");
          }

          const streamUrl = getStreamUrl(state.id, currentCursor);
          const response = await fetch(streamUrl, {
            headers: {
              "Last-Event-ID": String(currentCursor),
            },
            signal: abortController.signal,
          });

          if (response.status === 204) {
            await reconcile(abortController.signal);
            if (isMounted) setConnectionStatus("idle");
            break;
          }

          if (!response.ok) {
            throw new Error(`SSE stream returned status ${response.status}`);
          }

          if (isMounted) setConnectionStatus("live");
          let lastSequence = currentCursor;
          for await (const event of readRunEvents(response)) {
            if (!isMounted) break;
            if (event.run_id !== state.id) throw new Error("The stream belongs to a different run.");
            if (event.sequence <= lastSequence) continue;
            if (event.sequence !== lastSequence + 1) throw new Error("A run event is missing; refreshing the trace.");
            lastSequence = event.sequence;
            stateRef.current = reduceRunEvent(stateRef.current, event);
            dispatch({ type: "event", event });
            backoffMs = 1000;
          }
          if (!isMounted) break;
          await reconcile(abortController.signal);
          const status = stateRef.current.status;
          if (status !== "completed" && status !== "failed" && status !== "cancelled") {
            throw new Error("The live stream disconnected before the run finished.");
          }
        } catch (err: unknown) {
          if (!isMounted) break;
          if (err instanceof Error && err.name === "AbortError") {
            break;
          }

          setConnectionStatus("reconnecting");
          try {
            await reconcile(abortController.signal);
          } catch {
            if (isMounted) setConnectionStatus("error");
          }
          if (!isMounted) break;
          await new Promise<void>((resolve) => {
            resolveRetry = resolve;
            retryTimeout = setTimeout(resolve, backoffMs);
          });
          backoffMs = Math.min(backoffMs * 1.5, 8000);
        }
      }
    }

    void streamLoop();

    return () => {
      isMounted = false;
      abortController.abort();
      if (retryTimeout) clearTimeout(retryTimeout);
      resolveRetry?.();
    };
  }, [state.id, isTerminal, reconcile]);

  // Handle Stop button
  async function handleStop() {
    setIsStopping(true);
    setActionError(null);
    try {
      await stopRun(state.id);
      await reconcile();
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
