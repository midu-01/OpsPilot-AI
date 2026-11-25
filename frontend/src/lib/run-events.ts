import type {
  ApprovalSnapshot,
  ApprovalStatus,
  MessageSnapshot,
  RunEvent,
  RunSnapshot,
  RunStatus,
  ToolCallSnapshot,
  ToolResult,
} from "./api";

export interface RunState {
  id: string;
  goal: string;
  status: RunStatus;
  provider: string;
  model: string;
  reference_time: string;
  business_timezone: string;
  step_count: number;
  tool_call_count: number;
  total_tokens: number;
  token_usage_complete?: boolean | null;
  cost_is_upper_bound?: boolean;
  estimated_cost_usd?: string | null;
  active_elapsed_ms: number;
  max_agent_steps: number;
  max_tool_calls: number;
  messages: MessageSnapshot[];
  tool_calls: ToolCallSnapshot[];
  /**
   * Calls requested in the current model turn. `tool.requested` arrives before the
   * turn's `message.completed` and has no message_id, so calls wait here and are
   * attached to the message that completes next (the server groups them the same way).
   */
  pending_tool_call_ids: string[];
  approvals: ApprovalSnapshot[];
  pending_approval: ApprovalSnapshot | null;
  cursor: number;
  seen_sequences: number[];
  has_sequence_gap: boolean;
  error?: string | null;
}

export function createInitialRunState(snapshot: RunSnapshot): RunState {
  const allToolCalls: ToolCallSnapshot[] = [];
  const seenCallIds = new Set<string>();
  const messages = structuredClone(snapshot.messages);

  for (const message of messages) {
    for (const call of message.tool_calls) {
      if (!seenCallIds.has(call.id)) {
        seenCallIds.add(call.id);
        allToolCalls.push(call);
      }
    }
  }

  const seenSequences = snapshot.events.map((e) => e.sequence);

  return {
    id: snapshot.id,
    goal: snapshot.goal,
    status: snapshot.status,
    provider: snapshot.provider,
    model: snapshot.model,
    reference_time: snapshot.reference_time,
    business_timezone: snapshot.business_timezone,
    step_count: snapshot.step_count,
    tool_call_count: snapshot.tool_call_count,
    total_tokens: snapshot.total_tokens,
    token_usage_complete: snapshot.token_usage_complete,
    cost_is_upper_bound: snapshot.cost_is_upper_bound,
    estimated_cost_usd: snapshot.estimated_cost_usd,
    active_elapsed_ms: snapshot.active_elapsed_ms,
    max_agent_steps: snapshot.max_agent_steps,
    max_tool_calls: snapshot.max_tool_calls,
    messages,
    tool_calls: allToolCalls,
    pending_tool_call_ids: [],
    approvals: structuredClone(snapshot.approvals),
    pending_approval: snapshot.pending_approval ? structuredClone(snapshot.pending_approval) : null,
    cursor: snapshot.snapshot_cursor,
    seen_sequences: seenSequences,
    has_sequence_gap: false,
    error: snapshot.events.findLast(event => event.type === "run.failed")?.payload.message as string | undefined,
  };
}

export type RunAction = RunEvent | { snapshot: RunSnapshot };

export function reduceRunState(state: RunState, action: RunAction): RunState {
  return "snapshot" in action ? createInitialRunState(action.snapshot) : reduceRunEvent(state, action);
}

export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  // Never advance past a missing event; a fresh snapshot repairs the gap.
  if (event.run_id !== state.id || event.sequence <= state.cursor) return state;
  if (event.sequence !== state.cursor + 1) return { ...state, has_sequence_gap: true };

  const nextSeen = [...state.seen_sequences, event.sequence];
  const nextCursor = Math.max(state.cursor, event.sequence);

  let nextStatus = state.status;
  let nextStepCount = state.step_count;
  let nextToolCallCount = state.tool_call_count;
  let nextTotalTokens = state.total_tokens;
  let nextTokenUsageComplete = state.token_usage_complete;
  let nextCostIsUpperBound = state.cost_is_upper_bound;
  let nextEstimatedCost = state.estimated_cost_usd;
  let nextError = state.error;

  const toolCalls = state.tool_calls.map(call => ({ ...call }));
  const callsById = new Map(toolCalls.map(call => [call.id, call]));
  const messages = state.messages.map((message) => ({
    ...message,
    tool_calls: message.tool_calls.map(call => callsById.get(call.id) ?? { ...call }),
  }));
  let pendingToolCallIds = state.pending_tool_call_ids;
  const approvals = [...state.approvals];
  let pendingApproval = state.pending_approval;

  const payload = event.payload ?? {};

  switch (event.type) {
    case "run.queued":
      nextStatus = "queued";
      break;

    case "run.started":
      nextStatus = "running";
      break;

    case "message.delta": {
      const messageId = String(payload.message_id);
      const delta = String(payload.delta ?? "");
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      if (msgIndex >= 0) {
        messages[msgIndex] = {
          ...messages[msgIndex],
          text: (messages[msgIndex].text ?? "") + delta,
        };
      } else {
        const newMsg: MessageSnapshot = {
          id: messageId,
          index: messages.length,
          role: "assistant",
          text: delta,
          tool_calls: [],
          created_at: event.occurred_at,
        };
        messages.push(newMsg);
        // The backend counts a turn when it creates the assistant message (start_turn).
        nextStepCount += 1;
      }
      break;
    }

    case "message.completed": {
      const messageId = String(payload.message_id);
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      if (msgIndex >= 0) {
        messages[msgIndex] = {
          ...messages[msgIndex],
          text: payload.text !== undefined ? (payload.text as string | null) : messages[msgIndex].text,
        };
      } else {
        messages.push({ id: messageId, index: messages.length, role: "assistant",
          text: payload.text as string | null, tool_calls: [], created_at: event.occurred_at });
        nextStepCount += 1;
      }
      // Calls requested during this turn belong to this message.
      const completedIndex = messages.findIndex((m) => m.id === messageId);
      const completed = messages[completedIndex];
      const newCalls = pendingToolCallIds
        .filter((id) => !completed.tool_calls.some((c) => c.id === id))
        .map((id) => callsById.get(id))
        .filter((call): call is ToolCallSnapshot => call !== undefined);
      messages[completedIndex] = { ...completed, tool_calls: [...completed.tool_calls, ...newCalls] };
      pendingToolCallIds = [];
      break;
    }

    case "tool.requested": {
      const toolCallId = String(payload.tool_call_id);
      const providerCallId = String(payload.provider_call_id ?? "");
      const toolName = String(payload.name ?? "");
      const args = (payload.arguments as Record<string, unknown>) ?? {};

      let call = toolCalls.find((c) => c.id === toolCallId);
      if (!call) {
        call = {
          id: toolCallId,
          provider_call_id: providerCallId,
          name: toolName,
          arguments: args,
          status: "requested",
        };
        toolCalls.push(call);
      } else {
        call.arguments = args;
        call.status = "requested";
      }

      // The owning message is not known yet; it is the next one to complete.
      const attached = messages.some((m) => m.tool_calls.some((c) => c.id === toolCallId));
      if (!attached && !pendingToolCallIds.includes(toolCallId)) {
        pendingToolCallIds = [...pendingToolCallIds, toolCallId];
      }
      break;
    }

    case "tool.started": {
      const toolCallId = String(payload.tool_call_id);
      const call = toolCalls.find((c) => c.id === toolCallId);
      if (call) {
        call.status = "running";
        call.started_at = event.occurred_at;
      }
      nextToolCallCount = Math.max(nextToolCallCount, nextToolCallCount + 1);
      break;
    }

    case "tool.completed": {
      const toolCallId = String(payload.tool_call_id);
      const call = toolCalls.find((c) => c.id === toolCallId);
      if (call) {
        call.status = "completed";
        call.result = payload.result as ToolResult;
        call.completed_at = event.occurred_at;
      }
      break;
    }

    case "tool.failed": {
      const toolCallId = String(payload.tool_call_id);
      const call = toolCalls.find((c) => c.id === toolCallId);
      if (call) {
        call.status = "failed";
        call.error = String(payload.message ?? payload.code ?? "Tool failed");
        call.result = {
          ok: false,
          error: {
            code: String(payload.code ?? "TOOL_ERROR"),
            message: String(payload.message ?? "Tool failed"),
          },
        };
        call.completed_at = event.occurred_at;
      }
      break;
    }

    case "approval.required": {
      nextStatus = "awaiting_approval";
      const approvalId = String(payload.approval_id);
      const toolCallId = String(payload.tool_call_id);
      const toolName = String(payload.tool_name ?? "issue_refund");
      const proposedArgs = (payload.proposed_arguments as Record<string, unknown>) ?? {};

      const approval: ApprovalSnapshot = {
        id: approvalId,
        tool_call_id: toolCallId,
        tool_name: toolName,
        proposed_arguments: proposedArgs,
        status: "pending",
      };

      const existingIndex = approvals.findIndex((a) => a.id === approvalId);
      if (existingIndex >= 0) {
        approvals[existingIndex] = approval;
      } else {
        approvals.push(approval);
      }
      pendingApproval = approval;
      break;
    }

    case "approval.decided": {
      const approvalId = String(payload.approval_id);
      const decisionStatus = payload.status as ApprovalStatus;
      const reason = payload.reason as string | null | undefined;

      const appIndex = approvals.findIndex((a) => a.id === approvalId);
      if (appIndex >= 0) {
        approvals[appIndex] = {
          ...approvals[appIndex],
          status: decisionStatus,
          reason: reason ?? approvals[appIndex].reason,
          decided_at: event.occurred_at,
        };
      }

      if (pendingApproval && pendingApproval.id === approvalId) {
        pendingApproval = null;
      }
      break;
    }

    case "usage.updated": {
      if (typeof payload.total_tokens === "number") {
        nextTotalTokens = payload.total_tokens;
      }
      if (typeof payload.token_usage_complete === "boolean") {
        nextTokenUsageComplete = payload.token_usage_complete;
      }
      if (typeof payload.cost_is_upper_bound === "boolean") {
        nextCostIsUpperBound = payload.cost_is_upper_bound;
      }
      if (typeof payload.estimated_cost_usd === "string" || payload.estimated_cost_usd === null) {
        nextEstimatedCost = payload.estimated_cost_usd as string | null;
      }
      break;
    }

    case "run.completed":
      nextStatus = "completed";
      break;

    case "run.failed":
      nextStatus = "failed";
      nextError = String(payload.message ?? payload.code ?? "Run failed");
      break;

    case "run.cancelled":
      nextStatus = "cancelled";
      break;
  }

  return {
    ...state,
    status: nextStatus,
    step_count: nextStepCount,
    tool_call_count: nextToolCallCount,
    total_tokens: nextTotalTokens,
    token_usage_complete: nextTokenUsageComplete,
    cost_is_upper_bound: nextCostIsUpperBound,
    estimated_cost_usd: nextEstimatedCost,
    error: nextError,
    messages,
    tool_calls: toolCalls,
    pending_tool_call_ids: pendingToolCallIds,
    approvals,
    pending_approval: pendingApproval,
    cursor: nextCursor,
    seen_sequences: nextSeen,
    has_sequence_gap: false,
  };
}
