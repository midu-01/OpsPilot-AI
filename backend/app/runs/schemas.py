"""Public run, tool, approval, and event contracts."""

from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    NonNegativeInt,
    PositiveInt,
    StringConstraints,
    model_validator,
)

type Goal = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
type Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class RunStatus(StrEnum):
    queued = "queued"
    running = "running"
    awaiting_approval = "awaiting_approval"
    completed = "completed"
    failed = "failed"
    cancelling = "cancelling"
    cancelled = "cancelled"


class ApprovalDecision(StrEnum):
    approve = "approve"
    reject = "reject"


class ApprovalStatus(StrEnum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    cancelled = "cancelled"


class RunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goal: Goal


class ApprovalAction(BaseModel):
    """The caller decides an existing proposal and supplies a reason for rejection."""

    model_config = ConfigDict(extra="forbid")
    approval_id: UUID
    decision: ApprovalDecision
    reason: Reason | None = None

    @model_validator(mode="after")
    def require_rejection_reason(self) -> Self:
        if self.decision == ApprovalDecision.reject and self.reason is None:
            raise ValueError("A rejection requires a reason")
        return self


class ToolError(BaseModel):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)


class ToolSuccess(BaseModel):
    ok: Literal[True] = True
    data: JsonValue


class ToolFailure(BaseModel):
    ok: Literal[False] = False
    error: ToolError


type ToolResult = Annotated[ToolSuccess | ToolFailure, Field(discriminator="ok")]


class ToolCallSnapshot(BaseModel):
    id: UUID
    provider_call_id: str
    name: str
    arguments: dict[str, JsonValue]
    status: str
    result: ToolResult | str | None = None
    error: str | None = None
    started_at: AwareDatetime | None = None
    completed_at: AwareDatetime | None = None


class MessageSnapshot(BaseModel):
    id: UUID
    index: NonNegativeInt
    role: Literal["system", "user", "assistant", "tool"]
    text: str | None = None
    tool_calls: list[ToolCallSnapshot] = Field(default_factory=list)
    created_at: AwareDatetime


class ApprovalSnapshot(BaseModel):
    id: UUID
    tool_call_id: UUID
    tool_name: str
    proposed_arguments: dict[str, JsonValue]
    status: ApprovalStatus
    reason: Reason | None = None
    decided_at: AwareDatetime | None = None


class RunSummary(BaseModel):
    id: UUID
    goal: Goal
    status: RunStatus
    step_count: NonNegativeInt = 0
    total_tokens: NonNegativeInt = 0
    cost_is_upper_bound: bool = False
    estimated_cost_usd: str | None = Field(default=None, coerce_numbers_to_str=True)
    duration_ms: NonNegativeInt | None = None
    created_at: AwareDatetime
    updated_at: AwareDatetime


class EventType(StrEnum):
    run_queued = "run.queued"
    run_started = "run.started"
    message_delta = "message.delta"
    message_completed = "message.completed"
    tool_requested = "tool.requested"
    tool_started = "tool.started"
    tool_completed = "tool.completed"
    tool_failed = "tool.failed"
    approval_required = "approval.required"
    approval_decided = "approval.decided"
    usage_updated = "usage.updated"
    run_completed = "run.completed"
    run_failed = "run.failed"
    run_cancelled = "run.cancelled"


class RunEvent(BaseModel):
    """Persisted event envelope for SSE delivery and replay."""

    schema_version: Literal[1] = 1
    run_id: UUID
    sequence: PositiveInt = Field(description="Strictly positive per-run sequence number")
    type: EventType
    occurred_at: AwareDatetime
    payload: dict[str, JsonValue] = Field(default_factory=dict)


class ModelAttemptSnapshot(BaseModel):
    id: UUID
    model: str
    status: str
    input_tokens: NonNegativeInt | None
    output_tokens: NonNegativeInt | None
    cached_tokens: NonNegativeInt | None
    usage_complete: bool
    pricing_snapshot: dict[str, JsonValue] | None
    estimated_cost_usd: str | None = Field(default=None, coerce_numbers_to_str=True)


class RunSnapshot(BaseModel):
    id: UUID
    goal: Goal
    status: RunStatus
    provider: str
    model: str
    reference_time: AwareDatetime
    business_timezone: str
    step_count: NonNegativeInt = 0
    tool_call_count: NonNegativeInt = 0
    total_tokens: NonNegativeInt = 0
    cost_is_upper_bound: bool = False
    estimated_cost_usd: str | None = Field(default=None, coerce_numbers_to_str=True)
    active_elapsed_ms: NonNegativeInt = 0
    max_agent_steps: PositiveInt
    max_tool_calls: PositiveInt
    model_calls: list[ModelAttemptSnapshot] = Field(default_factory=list)
    messages: list[MessageSnapshot] = Field(default_factory=list)
    approvals: list[ApprovalSnapshot] = Field(default_factory=list, description="All approval proposals and decisions")
    events: list[RunEvent] = Field(default_factory=list, description="Public event history in sequence order")
    pending_approval: ApprovalSnapshot | None = None
    snapshot_cursor: NonNegativeInt = Field(0, description="Last event sequence represented by this snapshot")
    created_at: AwareDatetime
    updated_at: AwareDatetime

    @model_validator(mode="after")
    def validate_event_history(self) -> Self:
        last_sequence = 0
        for event in self.events:
            if event.run_id != self.id or event.sequence <= last_sequence:
                raise ValueError("Snapshot events must belong to this run and have strictly increasing sequences")
            last_sequence = event.sequence
        if self.snapshot_cursor != last_sequence:
            raise ValueError("The snapshot cursor must match the last included event, or zero for an empty history")
        return self


class PaginatedRuns(BaseModel):
    items: list[RunSummary]
    total: NonNegativeInt
    page: PositiveInt
    page_size: PositiveInt


class HealthResponse(BaseModel):
    status: Literal["alive", "ready", "unavailable"]
    details: dict[str, str] = Field(default_factory=dict)
