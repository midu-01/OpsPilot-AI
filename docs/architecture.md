# OpsPilot AI — Architecture and End-to-End Trace

This document describes the architectural flow, state machine, data models, and transaction boundaries of OpsPilot AI.

---

## 1. System Architecture

```mermaid
flowchart TD
  subgraph Frontend["Next.js 16 Console (Client & Server Components)"]
    Composer[Goal Composer]
    Console[Run Console & State Reducer]
    Timeline[Execution Timeline]
    ApprovalUI[Human Approval Card]
    StreamClient[SSE ReadableStream Client]
  end

  subgraph API["FastAPI Backend (Async Endpoints)"]
    Routes["/runs Routes (POST, GET, /stream, /approve, /stop)"]
    EventsService[Events & Sequence Broker]
  end

  subgraph Database["PostgreSQL 17"]
    RunsTbl[(runs)]
    MsgsTbl[(messages)]
    CallsTbl[(tool_calls)]
    ApprTbl[(approvals)]
    EventsTbl[(run_events)]
    OrdersTbl[(orders)]
    RefundsTbl[(refunds ledger)]
  end

  subgraph Worker["Single-Process Lifespan Runner"]
    QueueClaim[Advisory Lock & Queue Claim]
    AgentLoop[Bounded Tool Loop]
    UsageTracker[Token & Cost Accounting]
  end

  subgraph Provider["LLM Provider Interface"]
    ProviderAdapter[Groq / Scenario / Anthropic planned]
  end

  subgraph Tools["Typed Tool Catalog"]
    DateMath[date_math]
    QueryOrders[query_orders]
    SearchPolicies[search_policies]
    IssueRefund[issue_refund (Approval Gated)]
  end

  Composer -->|POST /runs| Routes
  Routes -->|Persist run & user message| RunsTbl
  Routes -->|Persist run & user message| MsgsTbl
  Routes -->|Append run.queued| EventsTbl

  QueueClaim -->|Atomic claim & mark running| RunsTbl
  QueueClaim -->|Reconstruct history| MsgsTbl
  QueueClaim -->|Start turn| AgentLoop

  AgentLoop -->|Stream turn messages| ProviderAdapter
  ProviderAdapter -->|Text deltas & tool calls| AgentLoop
  AgentLoop -->|Append message.delta & tool.requested| EventsTbl
  AgentLoop -->|Dispatch read tools| DateMath & QueryOrders & SearchPolicies

  AgentLoop -->|Propose refund| IssueRefund
  IssueRefund -->|Persist pending approval| ApprTbl
  IssueRefund -->|Pause run & release worker| RunsTbl

  ApprovalUI -->|POST /runs/:id/approve| Routes
  Routes -->|Verify proposal & requeue| ApprTbl & RunsTbl
  QueueClaim -->|Resume approved tool batch| AgentLoop
  AgentLoop -->|Lock order & commit refund| RefundsTbl

  StreamClient -->|GET /runs/:id/stream?after=N| Routes
  Routes -->|Read bounded committed events| EventsTbl
  EventsService -.->|Wake-up hint after commit| Routes
  Routes -->|SSE frames id, event, data| StreamClient
  StreamClient -->|Deduplicate & reduce| Console
  Console --> Timeline & ApprovalUI
```

---

## 2. Request & Execution Lifecycle Trace

### Step 1: Goal Submission
1. The user enters an operations goal in the Next.js Goal Composer (`/`).
2. Client sends `POST /runs` with `{"goal": "..."}`.
3. FastAPI validates the goal length ($1 \le \text{length} \le 2000$) and begins a short transaction:
   - Inserts `runs` row with `status = "queued"`, budget limits, and `next_event_sequence = 2`.
   - Inserts `messages` row with `index = 0`, `role = "user"`, `text = goal`.
   - Inserts `run_events` row with `sequence = 1`, `type = "run.queued"`.
   - Commits transaction and returns `202 Accepted` with `RunSummary`.
4. Client navigates to `/runs/{id}`.

### Step 2: Queue Claim & Worker Execution
1. The background worker claims one queued run using PostgreSQL `FOR UPDATE` row lock.
2. If `cancellation_requested` is true, it marks the run cancelled immediately.
3. Otherwise, it updates `status = "running"`, appends `run.started` (sequence 2), and commits.
4. The worker loads all persisted messages and claims an `LLMProvider` instance via `resolve_run_provider`.

### Step 3: Model Turn & Live Streaming
1. `Execution.stream_turn` invokes the provider stream.
2. As the model produces tokens:
   - Early text is batched at $\approx 100\text{ms}$ or $4096$ characters to avoid excessive database writes.
   - Text chunks are appended to the assistant message in `messages` and committed with a `message.delta` event.
   - PostgreSQL `after_commit` hook notifies active SSE stream subscribers.
   - The browser's `GET /runs/{id}/stream` reader receives the SSE frame, deduplicates by sequence, and updates the live UI before the model finishes.
3. Tool calls requested by the model are persisted as `tool_calls` rows (`status = "requested"`) and emitted as `tool.requested` events.

### Step 4: Tool Execution & Human Approval Boundary
1. **Read tools** (`date_math`, `query_orders`, `search_policies`):
   - Dispatched outside the trace lock to avoid blocking other operations.
   - When finished, results reacquire the run lock, save a tool observation message (`role = "tool"`), and commit with `tool.completed`.
2. **Approval-gated tool** (`issue_refund`):
   - The engine checks for an existing approved record.
   - If none exists, it executes `propose`:
     - Calculates eligible refund based on order amount and shipping policies ($10\%$, capped at $\$100$).
     - Inserts an `approvals` row with `status = "pending"`, proposed arguments, and digest.
     - Updates `runs.status = "awaiting_approval"`.
     - Appends `approval.required` and commits.
     - Raises `RunPaused`, releasing the worker process so it consumes no resources while waiting for human review.

### Step 5: Decision & Resumption
1. The operator reviews the pending card in the Next.js console (which survived browser reloads).
2. The operator clicks **Approve** (or **Reject** with a reason), sending `POST /runs/{id}/approve`:
   - Validates that the approval belongs to this run and is currently pending.
   - Re-checks cancellation and terminal state under run lock.
   - Updates approval status (`"approved"` or `"rejected"`).
   - Requeues the run (`status = "queued"`), appends `approval.decided`, and commits.
3. The worker claims the queued run again.
4. When `issue_refund` executes this time, `resolve` finds the approved proposal:
   - Re-validates order refundable balance and eligibility.
   - Inserts unique `refunds` ledger entry (`order_id`, `amount_minor`, `policy_version`, `tool_call_id`).
   - Updates tool call status to `"completed"`.
   - Appends `tool.completed` and commits.
5. The model receives the tool success observation and composes its final closing text.
6. The run transitions to `completed`, appends `run.completed`, and the SSE stream closes cleanly.

---

## 3. Replay Protocol & Snapshot Consistency

- `GET /runs/{id}` reads the full trace under a shared read lock (`FOR UPDATE READ`), ensuring `snapshot_cursor` equals the exact sequence of the latest event included in the snapshot.
- `GET /runs/{id}/stream?after=N` and `Last-Event-ID: N` stream only events with $\text{sequence} > N$.
- If `Last-Event-ID` and `?after` are both provided, `Last-Event-ID` takes precedence.
- If a client connects to a completed run with an already consumed cursor ($N \ge \text{latest\_sequence}$), the endpoint returns `204 No Content`.
- The frontend reducer ignores duplicate sequences and detects sequence gaps, reconciling with a fresh snapshot if a gap is ever observed.

---

## 4. Cancellation & Concurrency Invariants

1. **Cancellation (`POST /runs/{id}/stop`)**:
   - Acquires the run lock and sets `cancellation_requested = true`.
   - Parked work is cancelled immediately; in-flight model calls are interrupted cleanly.
   - Disconnecting a browser stream does **not** stop or cancel the run.
2. **Write Race Safety**:
   - `stop_run` and refund execution lock the same run row.
   - If Stop wins the lock, no refund commits.
   - If refund commit wins the lock, the refund remains valid and visible in the trace, and the run transitions to cancelled afterward.
3. **Approval Idempotency**:
   - Repeated identical approval requests return the stored result without duplicate writes or extra events.
   - Conflicting or stale decisions return `409 Conflict`.
