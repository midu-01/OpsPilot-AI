import Link from "next/link";
import { Ban, CircleCheck, CircleX, RotateCcw } from "lucide-react";
import { errorTitle } from "@/lib/error-codes";
import { formatCount, formatDuration, plural } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { TraceStep, type StepPosition } from "./trace-step";

interface OutcomeItemProps extends StepPosition {
  status: "completed" | "failed" | "cancelled";
  goal: string;
  stepCount: number;
  toolCallCount: number;
  totalTokens: number;
  activeMs: number;
  error: string | null;
  errorCode: string | null;
}

/** Links back to the composer with this goal filled in; nothing is submitted. */
function RetryLink({ goal, label }: { goal: string; label: string }) {
  return (
    <Link href={`/?${new URLSearchParams({ goal })}`} className={buttonClasses("secondary", "sm")}>
      <RotateCcw aria-hidden />
      {label}
    </Link>
  );
}

export function OutcomeItem({ status, goal, stepCount, toolCallCount, totalTokens, activeMs, error, errorCode, ...position }: OutcomeItemProps) {
  const summary = `${plural(stepCount, "turn")} · ${plural(toolCallCount, "tool call")} · ${formatCount(totalTokens)} tokens · ${formatDuration(activeMs)} active`;

  if (status === "completed") {
    return <TraceStep id="outcome" icon={CircleCheck} tone="success" title="Run completed" meta={summary} {...position} />;
  }

  if (status === "failed") {
    return (
      <TraceStep id="outcome" icon={CircleX} tone="danger" title="Run failed" meta={summary} {...position}>
        <Alert
          tone="danger"
          title={
            <span className="flex flex-wrap items-center gap-2">
              {errorTitle(errorCode)}
              {errorCode ? <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs font-normal">{errorCode}</code> : null}
            </span>
          }
          action={<RetryLink goal={goal} label="Retry with this goal" />}
        >
          <p>{error ?? "The backend did not report a reason."}</p>
        </Alert>
      </TraceStep>
    );
  }

  return (
    <TraceStep id="outcome" icon={Ban} tone="neutral" title="Run stopped" meta={summary} {...position}>
      <p className="text-sm text-muted">
        Stopped before finishing. Everything above happened before the stop; pending approvals were cancelled.
      </p>
      <div className="mt-3">
        <RetryLink goal={goal} label="Start again with this goal" />
      </div>
    </TraceStep>
  );
}
