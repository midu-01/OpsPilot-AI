import type {
  ApprovalSnapshot,
  ApprovalStatus,
  MessageSnapshot,
  ModelAttemptSnapshot,
  RunEvent,
  RunSnapshot,
  RunStatus,
  ToolCallSnapshot,
  ToolResult,
} from "./api.ts";
import { asBoolean, asNumber, asString, isRecord } from "./json.ts";

/**
 * Client-side state of one run.
 *
 * It starts from a server snapshot (GET /runs/{id}) and is then updated by each
 * streamed event. Everything here is pure: the same inputs always produce the same
 * state. Updates replace only the objects that changed, so a text delta creates a
 * new object for one message and every other message keeps its identity (memoized
 * components skip re-rendering).
 */

export type MessageStatus = "streaming" | "completed" | "failed";

export interface RunMessage {
  id: string;
  index: number;
  role: MessageSnapshot["role"];
  text: string | null;
  /** Snapshots carry no message status, so replayed messages count as completed. */
  status: MessageStatus;
  /** Calls this turn requested, in request order. Their details live in RunState.tool_calls. */
  tool_call_ids: string[];
  created_at: string;
}

export interface RunState {
  id: string;
  goal: string;
  status: RunStatus;
  provider: string;
  model: string;
  reference_time: string;
  business_timezone: string;
  created_at: string;
  updated_at: string;
  step_count: number;
  tool_call_count: number;
  max_agent_steps: number;
  max_tool_calls: number;
  total_tokens: number;
  token_usage_complete: boolean | null;
  cost_is_upper_bound: boolean;
  estimated_cost_usd: string | null;
  /** Active time accumulated up to `active_since` (or in total, when not running). */
  active_elapsed_ms: number;
  /** Server time the current running interval started; null while not running. */
  active_since: string | null;
  model_calls: ModelAttemptSnapshot[];
  messages: RunMessage[];
  /** Every tool call of the run, in request order. */
  tool_calls: ToolCallSnapshot[];
  /**
   * Calls requested in the current model turn. `tool.requested` arrives before the
   * turn's `message.completed` and has no message_id, so calls wait here and are
   * attached to the message that completes next (the server groups them the same way).
   */
  pending_tool_call_ids: string[];
  approvals: ApprovalSnapshot[];
  pending_approval: ApprovalSnapshot | null;
  /** The public event log, in sequence order. */
  events: RunEvent[];
  /** Sequence of the last event applied. The stream resumes after it. */
  cursor: number;
  has_sequence_gap: boolean;
  error: string | null;
  error_code: string | null;
}

export type RunAction =
  | { type: "event"; event: RunEvent }
  /** `force` replaces state even with an older cursor (the server reported ours is ahead of it). */
  | { type: "snapshot"; snapshot: RunSnapshot; force?: boolean }
  /** POST /stop succeeded. No event announces `cancelling`, so it is applied locally. */
  | { type: "stop-accepted" };

const RUNNING_STATUSES: ReadonlySet<RunStatus> = new Set(["running", "cancelling"]);
const FINISHED_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);
const APPROVAL_STATUSES: ReadonlySet<string> = new Set(["pending", "approved", "rejected", "cancelled"]);

export function createInitialRunState(snapshot: RunSnapshot): RunState {
  const failure = snapshot.events.findLast((event) => event.type === "run.failed");
  return {
    id: snapshot.id,
    goal: snapshot.goal,
    status: snapshot.status,
    provider: snapshot.provider,
    model: snapshot.model,
    reference_time: snapshot.reference_time,
    business_timezone: snapshot.business_timezone,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    step_count: snapshot.step_count,
    tool_call_count: snapshot.tool_call_count,
    max_agent_steps: snapshot.max_agent_steps,
    max_tool_calls: snapshot.max_tool_calls,
    total_tokens: snapshot.total_tokens,
    token_usage_complete: snapshot.token_usage_complete ?? null,
    cost_is_upper_bound: snapshot.cost_is_upper_bound ?? false,
    estimated_cost_usd: snapshot.estimated_cost_usd ?? null,
    active_elapsed_ms: snapshot.active_elapsed_ms,
    // The server checkpoints active time whenever it updates the run row.
    active_since: RUNNING_STATUSES.has(snapshot.status) ? snapshot.updated_at : null,
    model_calls: snapshot.model_calls,
    messages: snapshot.messages.map(toRunMessage),
    tool_calls: snapshot.messages.flatMap((message) => message.tool_calls),
    pending_tool_call_ids: [],
    approvals: snapshot.approvals,
    pending_approval: snapshot.pending_approval ?? null,
    events: snapshot.events,
    cursor: snapshot.snapshot_cursor,
    has_sequence_gap: false,
    error: asString(failure?.payload.message),
    error_code: asString(failure?.payload.code),
  };
}

function toRunMessage(message: MessageSnapshot): RunMessage {
  return {
    id: message.id,
    index: message.index,
    role: message.role,
    text: message.text ?? null,
    status: "completed",
    tool_call_ids: message.tool_calls.map((call) => call.id),
    created_at: message.created_at,
  };
}

export function reduceRunState(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "event":
      return reduceRunEvent(state, action.event);
    case "snapshot":
      // Never go backwards: the stream may already have applied newer events.
      if (!action.force && action.snapshot.snapshot_cursor < state.cursor) return state;
      return createInitialRunState(action.snapshot);
    case "stop-accepted":
      // Status only: a running run keeps its stopwatch going, a paused one stays stopped.
      return FINISHED_STATUSES.has(state.status) ? state : { ...state, status: "cancelling" };
  }
}

export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  if (event.run_id !== state.id || event.sequence <= state.cursor) return state; // duplicate or another run
  // Never apply an event after a missing one; a fresh snapshot repairs the gap.
  if (event.sequence !== state.cursor + 1) return { ...state, has_sequence_gap: true };

  const next = applyEvent(state, event);
  return { ...next, cursor: event.sequence, events: [...state.events, event], has_sequence_gap: false };
}

function applyEvent(state: RunState, event: RunEvent): RunState {
  const payload = event.payload;
  const at = event.occurred_at;
  switch (event.type) {
    case "run.queued":
      return withStatus(state, "queued", at);
    case "run.started":
      return withStatus(state, "running", at);
    case "run.completed":
      return withStatus(state, "completed", at);
    case "run.cancelled":
      return withStatus(state, "cancelled", at);
    case "run.failed":
      return {
        ...withStatus(state, "failed", at),
        error: asString(payload.message) ?? "The run failed.",
        error_code: asString(payload.code),
      };
    case "message.delta":
      return appendDelta(state, asString(payload.message_id), asString(payload.delta) ?? "", at);
    case "message.completed":
      return completeMessage(state, payload, at);
    case "tool.requested":
      return requestTool(state, payload);
    case "tool.started":
      return {
        ...updateCall(state, asString(payload.tool_call_id), (call) => ({ ...call, status: "running", started_at: at })),
        tool_call_count: state.tool_call_count + 1,
      };
    case "tool.completed":
      return updateCall(state, asString(payload.tool_call_id), (call) => ({
        ...call,
        status: "completed",
        result: isToolResult(payload.result) ? payload.result : { ok: true, data: payload.result ?? null },
        error: null,
        completed_at: at,
      }));
    case "tool.failed":
      return updateCall(state, asString(payload.tool_call_id), (call) => failCall(call, payload, at));
    case "approval.required":
      return requireApproval(state, payload, at);
    case "approval.decided":
      return decideApproval(state, payload, at);
    case "usage.updated":
      return {
        ...state,
        total_tokens: asNumber(payload.total_tokens) ?? state.total_tokens,
        token_usage_complete: asBoolean(payload.token_usage_complete) ?? state.token_usage_complete,
        cost_is_upper_bound: asBoolean(payload.cost_is_upper_bound) ?? state.cost_is_upper_bound,
        estimated_cost_usd:
          "estimated_cost_usd" in payload ? asString(payload.estimated_cost_usd) : state.estimated_cost_usd,
      };
    default:
      return state;
  }
}

/** Changes the run status and keeps the active-time stopwatch in step with it. */
function withStatus(state: RunState, status: RunStatus, at: string): RunState {
  const isRunning = RUNNING_STATUSES.has(status);
  if (state.active_since !== null && !isRunning) {
    const interval = Math.max(0, Date.parse(at) - Date.parse(state.active_since));
    return { ...state, status, active_elapsed_ms: state.active_elapsed_ms + interval, active_since: null };
  }
  if (state.active_since === null && isRunning) return { ...state, status, active_since: at };
  return { ...state, status };
}

function nextMessageIndex(messages: RunMessage[]): number {
  return messages.length === 0 ? 0 : messages[messages.length - 1].index + 1;
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  const copy = items.slice();
  copy[index] = item;
  return copy;
}

function appendDelta(state: RunState, messageId: string | null, delta: string, at: string): RunState {
  if (!messageId) return state;
  const index = state.messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    const message: RunMessage = {
      id: messageId,
      index: nextMessageIndex(state.messages),
      role: "assistant",
      text: delta,
      status: "streaming",
      tool_call_ids: [],
      created_at: at,
    };
    // The backend counts a turn when it creates the assistant message.
    return { ...state, messages: [...state.messages, message], step_count: state.step_count + 1 };
  }
  const current = state.messages[index];
  const updated: RunMessage = { ...current, text: (current.text ?? "") + delta, status: "streaming" };
  return { ...state, messages: replaceAt(state.messages, index, updated) };
}

function completeMessage(state: RunState, payload: Record<string, unknown>, at: string): RunState {
  const messageId = asString(payload.message_id);
  if (!messageId) return state;
  const status: MessageStatus = payload.status === "failed" ? "failed" : "completed";
  // The completed text is authoritative when present (null for tool-only turns).
  const hasText = "text" in payload;
  const text = asString(payload.text);
  const pending = state.pending_tool_call_ids;
  const index = state.messages.findIndex((message) => message.id === messageId);

  if (index === -1) {
    const message: RunMessage = {
      id: messageId,
      index: nextMessageIndex(state.messages),
      role: "assistant",
      text,
      status,
      tool_call_ids: pending,
      created_at: at,
    };
    return {
      ...state,
      messages: [...state.messages, message],
      pending_tool_call_ids: [],
      step_count: state.step_count + 1,
    };
  }

  const current = state.messages[index];
  const newCalls = pending.filter((id) => !current.tool_call_ids.includes(id));
  const updated: RunMessage = {
    ...current,
    text: hasText ? text : current.text,
    status,
    tool_call_ids: newCalls.length > 0 ? [...current.tool_call_ids, ...newCalls] : current.tool_call_ids,
  };
  return { ...state, messages: replaceAt(state.messages, index, updated), pending_tool_call_ids: [] };
}

function requestTool(state: RunState, payload: Record<string, unknown>): RunState {
  const id = asString(payload.tool_call_id);
  if (!id) return state;
  const requested: ToolCallSnapshot = {
    id,
    provider_call_id: asString(payload.provider_call_id) ?? "",
    name: asString(payload.name) ?? "unknown_tool",
    arguments: isRecord(payload.arguments) ? payload.arguments : {},
    status: "requested",
  };
  const exists = state.tool_calls.some((call) => call.id === id);
  const tool_calls = exists
    ? state.tool_calls.map((call) => (call.id === id ? { ...call, ...requested } : call))
    : [...state.tool_calls, requested];
  const attached =
    state.pending_tool_call_ids.includes(id) || state.messages.some((message) => message.tool_call_ids.includes(id));
  return {
    ...state,
    tool_calls,
    pending_tool_call_ids: attached ? state.pending_tool_call_ids : [...state.pending_tool_call_ids, id],
  };
}

function updateCall(
  state: RunState,
  id: string | null,
  update: (call: ToolCallSnapshot) => ToolCallSnapshot,
): RunState {
  if (!id || !state.tool_calls.some((call) => call.id === id)) return state;
  return { ...state, tool_calls: state.tool_calls.map((call) => (call.id === id ? update(call) : call)) };
}

function failCall(call: ToolCallSnapshot, payload: Record<string, unknown>, at: string): ToolCallSnapshot {
  const code = asString(payload.code) ?? "TOOL_ERROR";
  const message = asString(payload.message) ?? "The tool call failed.";
  return {
    ...call,
    status: "failed",
    result: isToolResult(payload.result) ? payload.result : { ok: false, error: { code, message } },
    error: message,
    completed_at: at,
  };
}

function requireApproval(state: RunState, payload: Record<string, unknown>, at: string): RunState {
  const id = asString(payload.approval_id);
  const toolCallId = asString(payload.tool_call_id);
  if (!id || !toolCallId) return state;
  const approval: ApprovalSnapshot = {
    id,
    tool_call_id: toolCallId,
    tool_name: asString(payload.tool_name) ?? "issue_refund",
    proposed_arguments: isRecord(payload.proposed_arguments) ? payload.proposed_arguments : {},
    status: "pending",
    reason: null,
    decided_at: null,
  };
  const exists = state.approvals.some((item) => item.id === id);
  const paused = withStatus(state, "awaiting_approval", at);
  return {
    ...updateCall(paused, toolCallId, (call) => ({ ...call, status: "awaiting_approval" })),
    approvals: exists
      ? state.approvals.map((item) => (item.id === id ? approval : item))
      : [...state.approvals, approval],
    pending_approval: approval,
  };
}

function decideApproval(state: RunState, payload: Record<string, unknown>, at: string): RunState {
  const id = asString(payload.approval_id);
  const status = asString(payload.status);
  if (!id || !status || !APPROVAL_STATUSES.has(status)) return state;
  const approvals = state.approvals.map((item) =>
    item.id === id
      ? { ...item, status: status as ApprovalStatus, reason: asString(payload.reason) ?? item.reason ?? null, decided_at: at }
      : item,
  );
  const pending_approval = state.pending_approval?.id === id ? null : state.pending_approval;
  return { ...state, approvals, pending_approval };
}

function isToolResult(value: unknown): value is ToolResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return "data" in value;
  return value.ok === false && isRecord(value.error);
}
