import { parseRefundProposal, proposalTitle } from "./approval.ts";
import { errorTitle } from "./error-codes.ts";
import { plural } from "./format.ts";
import type { RunState } from "./run-events.ts";
import { humanizeStatus, type Tone } from "./status.ts";

/** The "now" line: one sentence about what the agent is doing at this moment. */
export interface Activity {
  text: string;
  tone: Tone;
  /** True while something is happening, so the UI shows a pulse. */
  live: boolean;
}

function listNames(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length <= 2 ? unique.join(" and ") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

export function describeActivity(state: RunState): Activity {
  switch (state.status) {
    case "queued":
      return state.approvals.some((approval) => approval.status !== "pending")
        ? { text: "Your decision is recorded. Resuming the run…", tone: "info", live: true }
        : { text: "Queued. Waiting for the worker to start this run…", tone: "neutral", live: true };
    case "running":
      return describeRunning(state);
    case "awaiting_approval": {
      const approval = state.pending_approval;
      const subject = approval ? `: ${proposalTitle(parseRefundProposal(approval.proposed_arguments))}` : "";
      return { text: `Waiting for your approval${subject}.`, tone: "warning", live: true };
    }
    case "cancelling":
      return { text: "Stopping… the agent halts at its next checkpoint.", tone: "warning", live: true };
    case "completed":
      return {
        text: `Completed in ${plural(state.step_count, "turn")} and ${plural(state.tool_call_count, "tool call")}.`,
        tone: "success",
        live: false,
      };
    case "failed":
      return { text: `Failed: ${errorTitle(state.error_code)}.`, tone: "danger", live: false };
    case "cancelled":
      return { text: "Stopped. Everything the agent did before stopping is kept below.", tone: "neutral", live: false };
    default:
      return { text: humanizeStatus(state.status), tone: "neutral", live: false };
  }
}

function describeRunning(state: RunState): Activity {
  const namesWith = (status: string) => state.tool_calls.filter((call) => call.status === status).map((call) => call.name);

  const running = namesWith("running");
  if (running.length > 0) return { text: `Calling ${listNames(running)}…`, tone: "info", live: true };

  const resuming = namesWith("awaiting_approval");
  if (resuming.length > 0) return { text: `Applying your decision to ${listNames(resuming)}…`, tone: "info", live: true };

  const pending = state.tool_calls.filter((call) => state.pending_tool_call_ids.includes(call.id)).map((call) => call.name);
  const queued = namesWith("requested");
  if (pending.length > 0 || queued.length > 0) {
    return { text: `Preparing ${listNames([...pending, ...queued])}…`, tone: "info", live: true };
  }

  const last = state.messages.findLast((message) => message.role === "assistant");
  if (last?.status === "streaming") return { text: "Writing a response…", tone: "info", live: true };

  const nextTurn = Math.min(state.step_count + 1, state.max_agent_steps);
  return { text: `Waiting for the model (turn ${nextTurn} of ${state.max_agent_steps})…`, tone: "info", live: true };
}
