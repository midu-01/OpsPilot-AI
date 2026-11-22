# OpsPilot AI — Agent Run Console with Human Approval

OpsPilot AI is an operations copilot built with **Next.js 16 (App Router)** and **FastAPI (Python 3.12)** backed by **PostgreSQL 17**. It assists operations teams with automated customer order analysis and policy-governed refund drafting, while placing write actions behind a human approval boundary.

---

## Architectural Overview

```mermaid
flowchart TD
  subgraph Frontend["Next.js 16 Console (App Router and TypeScript)"]
    Composer["Goal Composer (/)"]
    Console["Live Run Console (/runs/:id)"]
    ApprovalUI["Human Approval Card"]
    History["Runs History (/runs)"]
    Reducer["Sequence-Aware Event Reducer"]
    StreamReader["SSE ReadableStream Reader"]
  end

  subgraph Backend["FastAPI Backend (Async and Typed Pydantic v2)"]
    HTTPRoutes["HTTP Endpoints (/runs, /approve, /stop)"]
    SSEEndpoint["GET /runs/:id/stream (SSE Replay)"]
    Broker["In-Memory Event Broker (Wake-up Hints)"]
  end

  subgraph Database["PostgreSQL 17 (SQLAlchemy 2.0 Async and Alembic)"]
    RunsTbl[("runs - state machine and budgets")]
    MsgsTbl[("messages - transcripts")]
    CallsTbl[("tool_calls - inputs and outputs")]
    ApprTbl[("approvals - pending and decisions")]
    EventsTbl[("run_events - monotonically ordered")]
    OrdersTbl[("orders - 30 seeded orders")]
    RefundsTbl[("refunds - simulated ledger")]
  end

  subgraph Runner["Single-Process Lifespan Worker"]
    QueueClaim["Atomic Queue Claim (Advisory Lock)"]
    AgentLoop["Bounded Native Tool Loop"]
    UsageAccounting["Token and Cost Tracking"]
  end

  subgraph Providers["LLM Provider Boundary"]
    Adapter["Anthropic / Groq / ScenarioProvider"]
  end

  subgraph Tools["Typed Tool Registry"]
    DateMath["date_math (calendar operations)"]
    QueryOrders["query_orders (typed filters)"]
    SearchPolicies["search_policies (policy retrieval)"]
    IssueRefund["issue_refund (approval-gated write)"]
  end

  Composer -->|POST /runs (202 Accepted)| HTTPRoutes
  HTTPRoutes -->|Persist run and message| RunsTbl
  HTTPRoutes -->|Persist user message| MsgsTbl
  HTTPRoutes -->|Append run.queued| EventsTbl

  QueueClaim -->|Atomic claim FOR UPDATE| RunsTbl
  QueueClaim -->|Reconstruct messages and run| AgentLoop

  AgentLoop -->|Stream conversation turns| Adapter
  Adapter -->|Text deltas and tool calls| AgentLoop
  AgentLoop -->|Batch ~100ms deltas| EventsTbl
  AgentLoop -->|Dispatch read tools| DateMath
  AgentLoop -->|Dispatch read tools| QueryOrders
  AgentLoop -->|Dispatch read tools| SearchPolicies

  AgentLoop -->|Propose refund| IssueRefund
  IssueRefund -->|Persist pending approval| ApprTbl
  IssueRefund -->|Pause run and release worker| RunsTbl

  ApprovalUI -->|POST /runs/:id/approve| HTTPRoutes
  HTTPRoutes -->|Save decision and requeue run| ApprTbl
  HTTPRoutes -->|Requeue run| RunsTbl
  QueueClaim -->|Resume approved batch| AgentLoop
  AgentLoop -->|Verify order and commit refund| RefundsTbl

  StreamReader -->|GET /runs/:id/stream?after=N| SSEEndpoint
  SSEEndpoint -->|Read bounded committed events| EventsTbl
  Broker -.->|Post-commit wake-up hint| SSEEndpoint
  SSEEndpoint -->|id, event, data frames| StreamReader
  StreamReader -->|Deduplicate by sequence| Reducer
  Reducer --> Console
  Reducer --> ApprovalUI
  Reducer --> History
```

---

## Quick Start (One-Command Startup)

With Docker Engine and Docker Compose installed:

```sh
# 1. Start all services (Database, Backend API, Frontend Console)
docker compose up --build -d

# 2. Verify service health
docker compose ps
```

### Access Points
- **Next.js Console:** [http://localhost:3000](http://localhost:3000) (or [http://127.0.0.1:3000](http://127.0.0.1:3000))
- **FastAPI Interactive Docs (Swagger):** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Backend Readiness Probe:** [http://localhost:8000/health/ready](http://localhost:8000/health/ready)
- **Backend Liveness Probe:** [http://localhost:8000/health/live](http://localhost:8000/health/live)

To view backend startup logs:
```sh
docker compose logs backend | grep -E "Demo reference date|Example goal"
```

To stop the services while preserving the database volume:
```sh
docker compose down
```

---

## Configuration & Model Providers

Copy `.env.example` to `.env` to configure your chosen model provider. The application starts without credentials using the built-in offline `ScenarioProvider` (`LLM_PROVIDER=fake`).

```sh
cp .env.example .env
```

| `LLM_PROVIDER` | Required Settings | Capabilities |
| --- | --- | --- |
| `anthropic` *(default)* | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` | Claude native Messages API with streaming tool calling. |
| `groq` | `GROQ_API_KEY`, `GROQ_MODEL=openai/gpt-oss-20b` | High-speed native function calling on hosted models. |
| `fake` | *No key needed* | Deterministic multi-turn scenario simulation for offline demos and CI. |

Restart the backend container to apply environment changes:
```sh
docker compose up -d --build --wait
```

---

## Business Scenario & Database Seed Data

OpsPilot simulates an operations assistant for an e-commerce platform:
1. **Orders Database:** 30 synthetic orders seeded across qualifying and non-qualifying cases (orders below, equal to, and above \$500; on-time shipments; late shipments; cancelled and already refunded orders).
2. **Explicit Reference Date:** Seeded relative to fixed UTC date `2026-02-15` (qualifying month is January 1 to February 1 exclusive). Database restarts never reset or duplicate existing records.
3. **8 Shipping Policies:** Bundled in `backend/policies/` covering shipping commitments, late-shipment refund eligibility, refund calculation rules, exclusions, duplicate requests, email drafts, and escalation.
4. **Fictional Refund Calculation:** Qualifying late shipments receive 10% of order value capped at \$100. Fractional cents are rounded using `ROUND_HALF_UP` in integer cents (`amount_minor`).
5. **Simulated Ledger:** Refunds are written transactionally to a simulated ledger table (`refunds`). No real money moves.

---

## Typed Tools Catalog

The agent loop dispatches four strictly typed tools:

| Tool Name | Type | Behavior |
| --- | --- | --- |
| `date_math` | Read | Computes calendar boundaries in the run's business timezone (e.g. `previous_month`). |
| `query_orders` | Read | Queries orders using typed parameters (`order_id`, `start`, `end`, `min_amount_minor`, `late_only`, `status`). SQL injection is structurally impossible. |
| `search_policies` | Read | Deterministic keyword search over 8 markdown policies, returning ranked matches with policy IDs and excerpts. |
| `issue_refund` | Write *(Approval-Gated)* | Calculates eligible refund from order and policy evidence. Proposes an immutable approval record and **pauses the run**. Upon human approval, writes exactly once to the simulated refund ledger. |

---

## Core Scenarios to Run

### Scenario 1: Read-Only Analysis & Email Drafts (No Write Action)
Paste this goal into the console (`/`):
> *"Find orders over \$500 that shipped late last month and draft a short refund email for each. Cite the applicable policy. Keep each email to two sentences."*

- **What Happens:** The agent calls `date_math`, `query_orders`, and `search_policies`. It composes email drafts directly in its response.
- **Verification:** No approval card appears. The simulated refund ledger has zero new entries.

### Scenario 2: Explicit Refund with Human Approval
Paste this goal:
> *"Check the late-shipment policy and issue the eligible simulated refund for ORD-1006. Show the proposed amount and evidence for my approval."*

- **What Happens:** The agent queries order `ORD-1006` (\$845.05) and policy v1 (10% up to \$100). It calculates \$84.51 USD (8,451 cents), pauses execution, and presents an **Approval Card**.
- **Reload Survival:** Refresh the browser page (`F5`). The same approval card reappears with exact details.
- **Decision:** Click **Approve Refund**. The worker claims the resumed run, records the simulated ledger entry, and outputs the final confirmation.

### Scenario 3: Rejection with Required Reason
Paste this goal:
> *"Please issue the eligible late-shipment refund for ORD-1001 and wait for my decision."*

- **What Happens:** The agent pauses for `ORD-1001` (\$62.50). Click **Reject Proposal…** and enter a reason (*"Customer requested store credit"*).
- **Verification:** The rejection reason is passed back to the agent as a tool observation. The agent acknowledges it. Zero rows are added to the refund ledger.

### Scenario 4: Stopping a Run
Click the **Stop Run** button on any in-flight or waiting run.
- **What Happens:** The run transitions through `cancelling` to `cancelled`. Partial output is preserved. Pending approvals are marked cancelled. Closing the browser tab does **not** cancel a run.

---

## Key Design Decisions & Trade-Offs

| Decision | Choice | Rationale & Trade-Off |
| :--- | :--- | :--- |
| **Agent Orchestration** | Native Tool Loop (No heavy framework) | **Why:** Full control over step limits, token budgets, execution timeouts, and pause/resume transactions. Easier to debug and explain in live interviews than opaque framework graphs.<br>**Trade-off:** Must hand-craft continuation payload tracking and resume logic. |
| **Browser Transport** | SSE (`ReadableStream`) + HTTP POST | **Why:** Server-Sent Events provide natural, lightweight one-way streaming for text and tool events. Reconnects via `Last-Event-ID` or `?after=N` prevent event loss. Commands (Approve, Stop) remain explicit HTTP POST requests.<br>**Trade-off:** Client must handle sequence deduplication and gap reconciliation. |
| **State & Persistence** | PostgreSQL as Source of Truth | **Why:** Browser refresh, container restarts, and pending approvals survive without in-memory dependency. Relational foreign keys prevent orphan calls or decisions.<br>**Trade-off:** Every event and state change requires a database transaction. |
| **Execution Ownership** | Single-Process Lifespan Worker | **Why:** Simplifies Docker Compose local deployment with zero external task broker (RabbitMQ/Redis) overhead. PostgreSQL advisory locks ensure single-worker ownership.<br>**Trade-off:** Concurrent runs execute serially in the queue rather than in parallel across multiple workers. |
| **Simulated Ledger** | Idempotent PostgreSQL Table | **Why:** Safe, realistic demonstration of financial write actions with integer-cent precision (`amount_minor`) and idempotency constraints (`order_id`, `policy_version`).<br>**Trade-off:** Does not integrate with third-party payment APIs like Stripe. |

---

## Known Gaps & Future Work

1. **Distributed Worker Leasing:** The current implementation uses a single-process worker with PostgreSQL row-level locks. For high-throughput cloud deployment, worker queue leasing with heartbeats and horizontal scaling would be added.
2. **Multi-User Authentication & RBAC:** Currently single-tenant local baseline. Adding JWT/OIDC authentication and role-based permissions (Operator vs Approver) is the natural next step.
3. **Policy Retrieval Scaling:** Currently deterministic keyword search over 8 markdown documents. For hundreds of policy manuals, hybrid vector embedding search (pgvector) would replace keyword search.
4. **Third-Party Integrations:** Connect simulated ledger writes to live payment providers (Stripe/Adyen) and email drafts to SendGrid/Postmark behind customer-facing confirmation.

---

## Local Verification & Test Execution

### 1. Backend Unit & Integration Tests
Run from `backend/`:
```sh
cd backend
uv sync --locked
uv run ruff check .
uv run mypy app
uv run pytest
```
When `TEST_DATABASE_URL` is configured to an accessible PostgreSQL instance, full integration suites run automatically:
```sh
uv run pytest -q tests/integration/test_scenario_reliability.py tests/integration/test_streaming.py
uv run pytest -q tests/integration/test_agent_loop.py tests/integration/test_approvals.py tests/integration/test_approvals_api.py tests/integration/test_cancellation.py tests/integration/test_refund_execution.py tests/integration/test_worker.py
```

### 2. Frontend Checks & Unit Tests
Run from `frontend/`:
```sh
cd frontend
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### 3. Isolated Compose & Playwright E2E Tests
To test the complete end-to-end stack in an isolated Docker environment without external keys:
```sh
export P8_PROJECT="opspilot-p8-test"
docker compose --env-file .env.example -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml up --build --wait -d
curl -fsS http://127.0.0.1:18000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:13000/
(cd frontend && E2E_EXTERNAL_STACK=1 pnpm exec playwright test tests/approval-flow.spec.ts tests/draft-only.spec.ts)
docker compose -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml down -v --remove-orphans
```

---

## Reviewer Guides
- **Architecture & Trace Details:** [`docs/architecture.md`](docs/architecture.md)
- **Demo Script & Interview Rehearsal:** [`docs/demo-script.md`](docs/demo-script.md)
