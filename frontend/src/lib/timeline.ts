import type { ApprovalSnapshot } from "./api.ts";
import type { RunMessage, RunState } from "./run-events.ts";
import { isTerminalStatus } from "./status.ts";

/**
 * The trace, as an ordered list of items the run console renders top to bottom:
 *
 *   goal -> turn 1 -> turn 2 (+ its approval) -> ... -> answer -> outcome
 *
 * Turns are keyed by position ("turn-3"). Messages are append-only, so a turn whose
 * tool calls arrived before its message completed keeps the same key, and React keeps
 * the same component, when the message completes.
 */
export type TimelineItem =
  | { kind: "goal"; key: "goal" }
  | { kind: "turn"; key: string; turn: number; message: RunMessage | null; callIds: string[] }
  | { kind: "approval"; key: string; approval: ApprovalSnapshot }
  | { kind: "answer"; key: "answer"; message: RunMessage }
  | { kind: "outcome"; key: "outcome"; status: "completed" | "failed" | "cancelled" };

export function buildTimeline(state: RunState): TimelineItem[] {
  const items: TimelineItem[] = [{ kind: "goal", key: "goal" }];
  // Only assistant messages are turns. "tool" messages repeat a call's result, which
  // the tool card already shows, and the user message is the goal.
  const turns = state.messages.filter((message) => message.role === "assistant");
  const placedApprovals = new Set<string>();

  // A turn that streams text and then requests tools: the calls arrive before the
  // message completes. Show them in that turn rather than as a separate one.
  const streamingTurn = turns.at(-1)?.status === "streaming" ? turns.at(-1) : undefined;
  const pending = state.pending_tool_call_ids;

  turns.forEach((message, index) => {
    if (isFinalAnswer(state, message, index === turns.length - 1)) {
      items.push({ kind: "answer", key: "answer", message });
      return;
    }
    const callIds = message === streamingTurn && pending.length > 0 ? [...message.tool_call_ids, ...pending] : message.tool_call_ids;
    items.push({ kind: "turn", key: `turn-${index + 1}`, turn: index + 1, message, callIds });
    for (const approval of state.approvals) {
      if (message.tool_call_ids.includes(approval.tool_call_id)) {
        items.push({ kind: "approval", key: `approval-${approval.id}`, approval });
        placedApprovals.add(approval.id);
      }
    }
  });

  // Calls requested by a tool-only turn whose message has not completed yet.
  if (pending.length > 0 && !streamingTurn) {
    const turn = turns.length + 1;
    items.push({ kind: "turn", key: `turn-${turn}`, turn, message: null, callIds: pending });
  }

  for (const approval of state.approvals) {
    if (!placedApprovals.has(approval.id)) items.push({ kind: "approval", key: `approval-${approval.id}`, approval });
  }

  if (isTerminalStatus(state.status)) {
    items.push({ kind: "outcome", key: "outcome", status: state.status as "completed" | "failed" | "cancelled" });
  }
  return items;
}

/** The last text-only turn of a completed run is its answer. */
function isFinalAnswer(state: RunState, message: RunMessage, isLastTurn: boolean): boolean {
  return (
    state.status === "completed" &&
    isLastTurn &&
    message.tool_call_ids.length === 0 &&
    state.pending_tool_call_ids.length === 0 &&
    Boolean(message.text?.trim())
  );
}

/** True while a message's text is arriving (aria-busy on the feed, so screen readers wait for it). */
export function isTextStreaming(state: RunState): boolean {
  return state.messages.some((message) => message.status === "streaming");
}
