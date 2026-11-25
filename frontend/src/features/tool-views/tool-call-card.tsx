"use client";

import { memo, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ApprovalSnapshot, ToolCallSnapshot } from "@/lib/api";
import { cx } from "@/lib/cx";
import { errorTitle } from "@/lib/error-codes";
import { formatDuration } from "@/lib/format";
import { toolCallDurationMs } from "@/lib/run-metrics";
import { approvalStatusMeta, toolCallStatusMeta, type Tone } from "@/lib/status";
import { parseToolResult } from "@/lib/tool-data";
import { summarizeToolCall, summarizeToolResult } from "@/lib/tool-summaries";
import { Alert } from "@/components/ui/alert";
import { TONE_CLASSES } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui/status-pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JsonBlock } from "./json-block";
import { getToolView } from "./registry";

interface ToolCallCardProps {
  call: ToolCallSnapshot;
  /** Set when the call went through human approval (issue_refund). */
  approval?: ApprovalSnapshot;
  timeZone: string;
}

const WAITING_NOTES: Record<string, string> = {
  requested: "Requested by the model. It starts after the model finishes this turn.",
  running: "Running now. The result appears here when it finishes.",
  awaiting_approval: "Paused for your decision. Review the approval card below this turn.",
};

/**
 * One tool call: icon, name, status, duration and a one-line summary of the arguments.
 * Expanding shows the tool's own result view (from the registry) and the raw JSON.
 * Memoized: it re-renders only when this call or its approval changes.
 */
export const ToolCallCard = memo(function ToolCallCard({ call, approval, timeZone }: ToolCallCardProps) {
  const result = parseToolResult(call.result);
  const failed = call.status === "failed" || result.kind === "failure";
  // Failed calls open by default; once the user toggles, their choice wins.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? failed;
  const bodyId = useId();

  const { icon: Icon, ResultView } = getToolView(call.name);
  const status = toolCallStatusMeta(call.status, approval?.status);
  // An approved call's duration would include the human review, so it is not shown.
  const durationMs = approval ? null : toolCallDurationMs(call);
  const resultSummary = summarizeToolResult(call.name, result);

  return (
    <div className="rounded-lg border border-border bg-surface motion-safe:animate-enter">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setToggled(!expanded)}
        className={cx(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2",
          expanded ? "rounded-t-lg" : "rounded-lg",
        )}
      >
        <span className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border", TONE_CLASSES[status.tone])}>
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-ui font-semibold text-fg">{call.name}</span>
            <StatusPill meta={status} />
            {approval && approval.status !== "pending" ? (
              <span className="text-xs text-muted">{approvalStatusMeta(approval.status).label} by you</span>
            ) : null}
            {durationMs !== null ? <span className="text-xs tabular-nums text-subtle">{formatDuration(durationMs)}</span> : null}
            {resultSummary ? <span className="text-xs font-medium text-muted">{resultSummary}</span> : null}
          </span>
          <span className="mt-0.5 block text-ui break-words text-muted">
            {summarizeToolCall(call.name, call.arguments, timeZone)}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className={cx("mt-1.5 size-4 shrink-0 text-subtle transition-transform duration-150", expanded && "rotate-90")}
        />
      </button>

      {expanded ? (
        <div id={bodyId} className="space-y-3 border-t border-border px-3 py-3">
          {result.kind === "failure" ? <FailureNotice code={result.code} message={result.message} /> : null}
          {result.kind === "none" ? (
            <p className="text-ui text-muted">{WAITING_NOTES[call.status] ?? "No result yet."}</p>
          ) : null}
          <Tabs defaultValue={result.kind === "success" ? "result" : "raw"}>
            <TabsList aria-label={`${call.name} details`}>
              {result.kind === "success" ? <TabsTrigger value="result">Result</TabsTrigger> : null}
              <TabsTrigger value="raw">Raw JSON</TabsTrigger>
            </TabsList>
            {result.kind === "success" ? (
              <TabsContent value="result" className="pt-3">
                <ResultView call={call} data={result.data} timeZone={timeZone} />
              </TabsContent>
            ) : null}
            <TabsContent value="raw" className="pt-3">
              <JsonBlock value={{ arguments: call.arguments, result: call.result ?? null }} label="tool call" />
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </div>
  );
});

/** A stop or a reviewer's rejection is a deliberate outcome, not an error, so it is not red. */
const DELIBERATE_OUTCOMES: Record<string, Tone> = {
  APPROVAL_REJECTED: "warning",
  APPROVAL_CANCELLED: "neutral",
  RUN_CANCELLED: "neutral",
  CANCELLED: "neutral",
};

function FailureNotice({ code, message }: { code: string; message: string }) {
  return (
    <Alert
      tone={DELIBERATE_OUTCOMES[code] ?? "danger"}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {errorTitle(code)}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs font-normal">{code}</code>
        </span>
      }
    >
      {code === "APPROVAL_REJECTED" ? (
        <p>
          Your reason, sent back to the agent: <q>{message}</q>
        </p>
      ) : (
        <p>{message}</p>
      )}
    </Alert>
  );
}
