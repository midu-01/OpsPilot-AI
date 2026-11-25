"use client";

import { memo } from "react";
import { Bot, LoaderCircle } from "lucide-react";
import type { ApprovalSnapshot, ToolCallSnapshot } from "@/lib/api";
import { approvalForCall } from "@/lib/approval";
import { plural } from "@/lib/format";
import type { RunMessage } from "@/lib/run-events";
import { Markdown } from "@/components/markdown/markdown";
import { ToolCallCard } from "@/features/tool-views/tool-call-card";
import { TraceStep, type StepPosition } from "./trace-step";

interface TurnItemProps extends StepPosition {
  turn: number;
  /** Null while the turn's tool calls are known but its message has not completed. */
  message: RunMessage | null;
  callIds: string[];
  toolCalls: ToolCallSnapshot[];
  approvals: ApprovalSnapshot[];
  timeZone: string;
}

/**
 * One model turn: its text (with a caret while streaming), then its tool calls.
 * Memoized: a text delta for another turn does not re-render this one.
 */
export const TurnItem = memo(function TurnItem({ turn, message, callIds, toolCalls, approvals, timeZone, ...position }: TurnItemProps) {
  const calls = callIds
    .map((id) => toolCalls.find((call) => call.id === id))
    .filter((call): call is ToolCallSnapshot => call !== undefined);
  const streaming = message?.status === "streaming";
  const failed = message?.status === "failed";
  const working = streaming || message === null || calls.some((call) => call.status === "running" || call.status === "requested");
  const meta = streaming ? "Writing…" : calls.length > 0 ? plural(calls.length, "tool call") : null;

  return (
    <TraceStep
      id={`turn-${turn}`}
      icon={working ? LoaderCircle : Bot}
      spinning={working}
      tone={failed ? "danger" : working ? "info" : "neutral"}
      title={`Turn ${turn}`}
      meta={meta}
      {...position}
    >
      {message?.text ? <Markdown text={message.text} streaming={streaming} /> : null}
      {calls.length > 0 ? (
        <div className={message?.text ? "mt-3 space-y-2" : "space-y-2"}>
          {calls.map((call) => (
            <ToolCallCard key={call.id} call={call} approval={approvalForCall(approvals, call.id)} timeZone={timeZone} />
          ))}
        </div>
      ) : null}
      {failed && !message?.text && calls.length === 0 ? (
        <p className="text-sm text-danger">This turn ended before the model produced output.</p>
      ) : null}
    </TraceStep>
  );
});
