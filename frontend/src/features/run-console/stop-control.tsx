"use client";

import { useState } from "react";
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
 */
export function StopControl({ runId, status, onStopped }: StopControlProps) {
  const [phase, setPhase] = useState<"idle" | "confirming" | "sending">("idle");
  const [returnFocus, setReturnFocus] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "cancelling") {
    return (
      <Button size="sm" variant="secondary" disabled>
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
    } finally {
      setPhase("idle");
    }
  }

  function keepRunning() {
    setPhase("idle");
    setReturnFocus(true);
  }

  if (phase === "idle") {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <Button size="sm" variant="danger-outline" autoFocus={returnFocus} onClick={() => setPhase("confirming")}>
          <Square aria-hidden />
          Stop
        </Button>
      </div>
    );
  }

  return (
    <div role="group" aria-label="Confirm stop" className="flex flex-wrap items-center gap-2">
      <span className="text-ui text-muted">
        {status === "awaiting_approval" ? "Stop and cancel the pending approval?" : "Stop this run?"}
      </span>
      <Button size="sm" variant="danger" autoFocus onClick={stop} disabled={phase === "sending"}>
        {phase === "sending" ? "Stopping…" : "Stop run"}
      </Button>
      <Button size="sm" variant="ghost" onClick={keepRunning} disabled={phase === "sending"}>
        Keep running
      </Button>
    </div>
  );
}
