"use client";

import Link from "next/link";
import type { MessageSnapshot, ToolCallSnapshot, ApprovalSnapshot, RunStatus } from "../lib/api";

interface RunTimelineProps {
  goal: string;
  status: RunStatus;
  messages: MessageSnapshot[];
  toolCalls: ToolCallSnapshot[];
  approvals: ApprovalSnapshot[];
  error?: string | null;
}

export default function RunTimeline({
  goal,
  status,
  messages,
  toolCalls,
  approvals,
  error,
}: RunTimelineProps) {
  // Map calls by ID for quick lookup
  const callMap = new Map<string, ToolCallSnapshot>();
  for (const call of toolCalls) {
    callMap.set(call.id, call);
  }

  return (
    <div className="timeline" role="feed" aria-label="Agent Run Execution Timeline">
      {/* 1. User Goal Card */}
      <article className="timeline-item timeline-user-goal" aria-label="User Goal">
        <header className="timeline-item-header">
          <span>User Goal</span>
          <span className="badge badge-queued">Input</span>
        </header>
        <div className="timeline-item-body">{goal}</div>
      </article>

      {/* 2. Messages & Embedded Tool Calls */}
      {messages.map((message) => {
        if (message.role === "user") {
          return null; // already shown above
        }

        // Get any tool calls associated with this message
        const attachedCalls = message.tool_calls.length > 0 ? message.tool_calls : [];

        return (
          <article key={message.id} className="timeline-item" aria-label={`Message ${message.index}`}>
            <header className="timeline-item-header">
              <span>{message.role === "assistant" ? "OpsPilot Agent" : "Tool Observation"}</span>
              <span className="badge badge-running">Step {message.index}</span>
            </header>
            <div className="timeline-item-body">
              {message.text && (
                <div style={{ marginBottom: attachedCalls.length > 0 ? "14px" : "0" }}>
                  {message.text}
                </div>
              )}

              {/* Render tool calls attached to this message */}
              {attachedCalls.map((call) => (
                <details key={call.id} className="tool-details" open={call.status === "failed"}>
                  <summary className="tool-summary">
                    <span>
                      <strong>Tool Call:</strong> <code>{call.name}</code>
                    </span>
                    <span
                      className={`badge ${
                        call.status === "completed"
                          ? "badge-completed"
                          : call.status === "failed"
                            ? "badge-failed"
                            : "badge-running"
                      }`}
                    >
                      {call.status}
                    </span>
                  </summary>
                  <div className="tool-content">
                    <div>
                      <strong>Arguments:</strong>
                      <pre className="code-block">{JSON.stringify(call.arguments, null, 2)}</pre>
                    </div>
                    {call.result !== undefined && call.result !== null && (
                      <div>
                        <strong>Result:</strong>
                        <pre className="code-block">{JSON.stringify(call.result, null, 2)}</pre>
                      </div>
                    )}
                    {call.error && (
                      <div className="alert alert-error" style={{ margin: "8px 0" }}>
                        <strong>Error:</strong> {call.error}
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </article>
        );
      })}

      {/* Standalone Tool Calls not linked to a specific assistant message */}
      {toolCalls
        .filter((c) => !messages.some((m) => m.tool_calls.some((tc) => tc.id === c.id)))
        .map((call) => (
          <article key={call.id} className="timeline-item" aria-label={`Tool Call ${call.name}`}>
            <header className="timeline-item-header">
              <span>Tool Call: <code>{call.name}</code></span>
              <span
                className={`badge ${
                  call.status === "completed"
                    ? "badge-completed"
                    : call.status === "failed"
                      ? "badge-failed"
                      : "badge-running"
                }`}
              >
                {call.status}
              </span>
            </header>
            <div className="timeline-item-body">
              <details className="tool-details" open>
                <summary className="tool-summary">View Details</summary>
                <div className="tool-content">
                  <div>
                    <strong>Arguments:</strong>
                    <pre className="code-block">{JSON.stringify(call.arguments, null, 2)}</pre>
                  </div>
                  {call.result !== undefined && call.result !== null && (
                    <div>
                      <strong>Result:</strong>
                      <pre className="code-block">{JSON.stringify(call.result, null, 2)}</pre>
                    </div>
                  )}
                  {call.error && (
                    <div className="alert alert-error">
                      <strong>Error:</strong> {call.error}
                    </div>
                  )}
                </div>
              </details>
            </div>
          </article>
        ))}

      {/* Approvals History */}
      {approvals
        .filter((a) => a.status !== "pending")
        .map((a) => (
          <article key={a.id} className="timeline-item" aria-label="Human Approval Decision">
            <header className="timeline-item-header">
              <span>Approval Decision: <code>{a.tool_name}</code></span>
              <span className={`badge ${a.status === "approved" ? "badge-completed" : "badge-failed"}`}>
                {a.status}
              </span>
            </header>
            <div className="timeline-item-body">
              <p>
                Decision: <strong>{a.status.toUpperCase()}</strong>
                {a.reason && <span> — Reason: <em>{a.reason}</em></span>}
              </p>
              <pre className="code-block">{JSON.stringify(a.proposed_arguments, null, 2)}</pre>
            </div>
          </article>
        ))}

      {/* Terminal Outcome */}
      {status === "completed" && (
        <div className="card" style={{ borderLeft: "4px solid var(--color-success)" }} role="status">
          <h3 style={{ margin: "0 0 6px", color: "var(--color-success)" }}>✓ Run Completed</h3>
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
            The agent finished all tasks and produced its final response.
          </p>
        </div>
      )}

      {status === "failed" && (
        <div className="card" style={{ borderLeft: "4px solid var(--color-danger)" }} role="alert">
          <h3 style={{ margin: "0 0 6px", color: "var(--color-danger)" }}>✕ Run Failed</h3>
          <p style={{ margin: "0 0 14px", color: "var(--color-danger)" }}>
            {error || "An error occurred during execution."}
          </p>
          <Link href="/" className="btn btn-secondary" style={{ padding: "6px 14px", fontSize: "0.85rem" }}>
            Start a New Run →
          </Link>
        </div>
      )}

      {status === "cancelled" && (
        <div className="card" style={{ borderLeft: "4px solid #64748b" }} role="status">
          <h3 style={{ margin: "0 0 6px", color: "#475569" }}>⏹ Run Cancelled</h3>
          <p style={{ margin: "0 0 14px", color: "var(--color-text-muted)" }}>
            Execution was stopped by user request.
          </p>
          <Link href="/" className="btn btn-secondary" style={{ padding: "6px 14px", fontSize: "0.85rem" }}>
            Start a New Run →
          </Link>
        </div>
      )}
    </div>
  );
}
