import type { ToolCallSnapshot } from "./api.ts";
import { formatCostUsd, formatCount, formatDuration } from "./format.ts";
import type { RunState } from "./run-events.ts";

/** How long a finished tool call took, from its server timestamps. */
export function toolCallDurationMs(call: Pick<ToolCallSnapshot, "started_at" | "completed_at">): number | null {
  if (!call.started_at || !call.completed_at) return null;
  const ms = Date.parse(call.completed_at) - Date.parse(call.started_at);
  return Number.isNaN(ms) ? null : Math.max(0, ms);
}

/**
 * Active time as of `nowMs`. The server only reports it in snapshots, so while the
 * run is running we add the time since the stopwatch started (see run-events.ts).
 * Pass `nowMs = null` before the client clock is available (server render).
 */
export function activeElapsedMs(state: Pick<RunState, "active_elapsed_ms" | "active_since">, nowMs: number | null): number {
  if (state.active_since === null || nowMs === null) return state.active_elapsed_ms;
  return state.active_elapsed_ms + Math.max(0, nowMs - Date.parse(state.active_since));
}

export interface BudgetItem {
  key: "turns" | "tool-calls" | "tokens" | "cost" | "active-time";
  label: string;
  value: string;
  /** A short qualifier shown next to the value ("partial", "upper bound"). */
  flag: string | null;
  /** Explains the flag or the number, for a tooltip and screen readers. */
  hint: string | null;
  meter: { value: number; max: number; text: string } | null;
}

export function budgetItems(state: RunState, nowMs: number | null): BudgetItem[] {
  const notStarted = state.active_elapsed_ms === 0 && state.active_since === null;
  return [
    {
      key: "turns",
      label: "Turns",
      value: `${state.step_count} / ${state.max_agent_steps}`,
      flag: null,
      hint: null,
      meter: { value: state.step_count, max: state.max_agent_steps, text: `${state.step_count} of ${state.max_agent_steps} turns used` },
    },
    {
      key: "tool-calls",
      label: "Tool calls",
      value: `${state.tool_call_count} / ${state.max_tool_calls}`,
      flag: null,
      hint: null,
      meter: {
        value: state.tool_call_count,
        max: state.max_tool_calls,
        text: `${state.tool_call_count} of ${state.max_tool_calls} tool calls used`,
      },
    },
    {
      key: "tokens",
      label: "Tokens",
      value: formatCount(state.total_tokens),
      flag: state.token_usage_complete === false ? "partial" : null,
      hint: state.token_usage_complete === false ? "Some model calls did not report token usage, so this is a lower bound." : null,
      meter: null,
    },
    {
      key: "cost",
      label: "Est. cost",
      value: formatCostUsd(state.estimated_cost_usd),
      flag: state.cost_is_upper_bound ? "upper bound" : null,
      hint: state.cost_is_upper_bound
        ? "The provider did not report cached tokens, so the estimate assumes the higher rate."
        : state.estimated_cost_usd === null
          ? "No estimate: the model has no configured price or a call did not report usage."
          : null,
      meter: null,
    },
    {
      key: "active-time",
      label: "Active time",
      value: notStarted ? "—" : formatDuration(activeElapsedMs(state, nowMs)),
      flag: null,
      hint: "Time the agent spent working. Waiting in the queue or for your approval is not counted.",
      meter: null,
    },
  ];
}
