"use client";

import { useState, type KeyboardEvent } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { ApiError, stopRun, type RunStatus } from "@/lib/api";
import { canStop } from "@/lib/status";
import { Button } from "@/components/ui/button";

interface StopControlProps {
  runId: string;
  status: RunStatus;
  onStopped: () => void;
}

/**
 * Stop with a light, inline confirmation (stopping cancels a pending approval).
 * A running run reports "cancelling" until the worker reaches a checkpoint.
 * Focus follows the flow: Stop -> "Keep running" -> "Stopping…".
 */
export function StopControl({ runId, status, onStopped }: StopControlProps) {
  const [phase, setPhase] = useState<"idle" | "confirming" | "sending">("idle");
  // Which control should take focus when it appears (set only by user actions).
  const [focusOnMount, setFocusOnMount] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One element for "sending" and "cancelling", so focus stays on it when the status changes.
  if (phase === "sending" || status === "cancelling") {
    return (
      <Button size="sm" variant="secondary" aria-disabled autoFocus={focusOnMount}>
        <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
        Stopping…
      </Button>
    );
  }
  if (!canStop(status)) return null;

  async function stop() {
    setPhase("sending");
    setError(null);
    try {
      await stopRun(runId);
      onStopped();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status !== 0 ? (caught.detail ?? caught.message) : "Could not reach the backend to stop the run.");
      setPhase("idle");
    }
  }

  function keepRunning() {
    setPhase("idle");
    setFocusOnMount(true);
  }

  function onConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") keepRunning();
  }

  if (phase === "idle") {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="danger-outline"
          autoFocus={focusOnMount}
          onClick={() => {
            setFocusOnMount(true);
            setPhase("confirming");
          }}
        >
          <Square aria-hidden />
          Stop
        </Button>
      </div>
    );
  }

  return (
    <div role="group" aria-label="Confirm stop" onKeyDown={onConfirmKeyDown} className="flex flex-wrap items-center gap-2">
      <span className="text-ui text-muted">
        {status === "awaiting_approval" ? "Stop and cancel the pending approval?" : "Stop this run?"}
      </span>
      <Button size="sm" variant="danger" onClick={stop}>
        Stop run
      </Button>
      <Button size="sm" variant="ghost" autoFocus onClick={keepRunning}>
        Keep running
      </Button>
    </div>
  );
}
