"use client";

import { CircleCheck, CircleX, Ban, ShieldAlert, FileText } from "lucide-react";
import type { ApprovalSnapshot } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { RunState } from "@/lib/run-events";
import { activeElapsedMs } from "@/lib/run-metrics";
import type { TimelineItem } from "@/lib/timeline";
import { ApprovalCard } from "../approval/approval-card";
import { DecisionRecord } from "../approval/decision-record";
import { FinalAnswer } from "../answer/final-answer";
import { GoalItem } from "./goal-item";
import { OutcomeItem } from "./outcome-item";
import { TraceStep, type StepPosition } from "./trace-step";
import { TurnItem } from "./turn-item";

interface RunTraceProps {
  state: RunState;
  items: TimelineItem[];
  /** Text is arriving right now (aria-busy). */
  busy: boolean;
  /** The run is not finished, so more steps may come (aria-setsize -1). */
  live: boolean;
  onDecided: (approvalId: string) => void;
  onConflict: (detail: string) => void;
}

const DECISION_STEP = {
  approved: { icon: CircleCheck, tone: "success", title: "Refund approved" },
  rejected: { icon: CircleX, tone: "danger", title: "Refund rejected" },
  cancelled: { icon: Ban, tone: "neutral", title: "Approval cancelled" },
} as const;

/**
 * The trace, as an ARIA feed: one article per step. aria-busy is true while text is
 * streaming, and aria-setsize is -1 until the run finishes and the total is known.
 */
export function RunTrace({ state, items, busy, live, onDecided, onConflict }: RunTraceProps) {
  const timeZone = state.business_timezone;

  function approvalStep(approval: ApprovalSnapshot, position: StepPosition) {
    const id = `approval-${approval.id}`;
    if (approval.status === "pending") {
      return (
        <TraceStep key={id} id={id} icon={ShieldAlert} tone="warning" title="Your approval is needed" {...position}>
          <ApprovalCard runId={state.id} approval={approval} timeZone={timeZone} onDecided={onDecided} onConflict={onConflict} />
        </TraceStep>
      );
    }
    const step = DECISION_STEP[approval.status];
    const meta = approval.decided_at ? formatDateTime(approval.decided_at, timeZone) : undefined;
    return (
      <TraceStep key={id} id={id} icon={step.icon} tone={step.tone} title={step.title} meta={meta} {...position}>
        <DecisionRecord approval={approval} />
      </TraceStep>
    );
  }

  return (
    <section aria-labelledby="trace-heading">
      <h2 id="trace-heading" className="sr-only">
        Trace
      </h2>
      <div role="feed" aria-busy={busy} aria-labelledby="trace-heading">
        {items.map((item, index) => {
          const position: StepPosition = {
            position: index + 1,
            total: live ? -1 : items.length,
            isLast: index === items.length - 1,
          };
          switch (item.kind) {
            case "goal":
              return <GoalItem key={item.key} goal={state.goal} createdAt={state.created_at} timeZone={timeZone} {...position} />;
            case "turn":
              return (
                <TurnItem
                  key={item.key}
                  turn={item.turn}
                  message={item.message}
                  callIds={item.callIds}
                  toolCalls={state.tool_calls}
                  approvals={state.approvals}
                  timeZone={timeZone}
                  {...position}
                />
              );
            case "approval":
              return approvalStep(item.approval, position);
            case "answer":
              return (
                <TraceStep key={item.key} id="answer" icon={FileText} tone="success" title="Answer" {...position}>
                  <FinalAnswer text={item.message.text ?? ""} />
                </TraceStep>
              );
            case "outcome":
              return (
                <OutcomeItem
                  key={item.key}
                  status={item.status}
                  goal={state.goal}
                  stepCount={state.step_count}
                  toolCallCount={state.tool_call_count}
                  totalTokens={state.total_tokens}
                  activeMs={activeElapsedMs(state, null)}
                  error={state.error}
                  errorCode={state.error_code}
                  {...position}
                />
              );
          }
        })}
      </div>
    </section>
  );
}
