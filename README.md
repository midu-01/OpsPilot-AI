# OpsPilot AI — Agent Run Console with Human Approval

OpsPilot AI is an operations copilot built with **Next.js 16 (App Router)** and **FastAPI (Python 3.12)** backed by **PostgreSQL 17 with pgvector**. It assists operations teams with automated customer order analysis and policy-governed refund drafting, while placing write actions behind a human approval boundary. Operators sign in, and each account sees only its own runs.

---

## Architecture Diagram & System Overview

```mermaid
flowchart TD
  Browser(["Browser (holds only the HttpOnly session cookie)"])

  subgraph Frontend["Next.js 16 Console (App Router and TypeScript)"]
    Gate["proxy.ts (no session cookie: redirect to /login)"]
    SignIn["Sign-in page /login + signIn and signOut Server Actions"]
    Composer["New run page / (Server) + composer (Client)"]
    History["Runs page /runs (Server) + auto-refresh (Client)"]
    RunPage["Run page /runs/:id (Server: loads the snapshot)"]
    Console["RunConsole (Client island): trace, tool views, inspector"]
    ApprovalUI["Approval card"]
    Reducer["Pure reducer + view models (timeline, now line, budget)"]
    StreamReader["useRunStream + stream loop (cursor, gaps, back-off)"]
    ApiProxy["Same-origin /api proxy (session cookie to Bearer token)"]
  end

  subgraph Backend["FastAPI Backend (Async and Typed Pydantic v2)"]
    AuthRoutes["Auth Endpoints (/auth/login, /auth/logout, /auth/me)"]
    HTTPRoutes["HTTP Endpoints (/runs, /approve, /stop): owner only"]
    SSEEndpoint["GET /runs/:id/stream (SSE Replay)"]
    Broker["In-Memory Event Broker (Wake-up Hints)"]
  end

  subgraph Database["PostgreSQL 17 + pgvector (SQLAlchemy 2.0 Async and Alembic)"]
    UsersTbl[("users - argon2id password hashes")]
    SessionsTbl[("user_sessions - SHA-256 of each token")]
    RunsTbl[("runs - owner, state machine and budgets")]
    MsgsTbl[("messages - transcripts")]
    CallsTbl[("tool_calls - inputs and outputs")]
    ApprTbl[("approvals - pending and decisions")]
    EventsTbl[("run_events - monotonically ordered")]
    OrdersTbl[("orders - 30 seeded orders")]
    RefundsTbl[("refunds - simulated ledger")]
    ChunksTbl[("policy_chunks - tsvector (GIN) + vector(384) (HNSW)")]
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
    SearchPolicies["search_policies (policy ID + full-text + pgvector)"]
    IssueRefund["issue_refund (approval-gated write)"]
  end

  Embedder["bge-small-en-v1.5 embedding model (fastembed, in-process, baked into the image)"]
  Seed["python -m app.seed on every start: demo users, orders, policy index"]

  Browser -->|Page request| Gate
  Gate -->|No session cookie| SignIn
  SignIn -->|POST /auth/login, POST /auth/logout| AuthRoutes
  SignIn -.->|Set-Cookie HttpOnly, SameSite=Lax| Browser
  AuthRoutes -->|Verify argon2id hash| UsersTbl
  AuthRoutes -->|Store or revoke the token hash| SessionsTbl
  HTTPRoutes -->|Bearer token to user via its SHA-256| SessionsTbl

  Composer -->|POST /api/runs| ApiProxy
  ApiProxy -->|POST /runs + Bearer - 202 Accepted| HTTPRoutes
  HTTPRoutes -->|Persist run with its owner| RunsTbl
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
  SearchPolicies -->|Embed the query| Embedder
  SearchPolicies -->|Policy ID, full-text and cosine similarity| ChunksTbl
  Seed -->|Embed new or changed paragraphs| ChunksTbl
  Seed -->|Create or update demo users| UsersTbl

  AgentLoop -->|Propose refund| IssueRefund
  IssueRefund -->|Persist pending approval| ApprTbl
  IssueRefund -->|Pause run and release worker| RunsTbl

  ApprovalUI -->|POST /api/runs/:id/approve| ApiProxy
  HTTPRoutes -->|Save decision and requeue run| ApprTbl
  HTTPRoutes -->|Requeue run| RunsTbl
  QueueClaim -->|Resume approved batch| AgentLoop
  AgentLoop -->|Verify order and commit refund| RefundsTbl

  StreamReader -->|GET /api/runs/:id/stream?after=N| ApiProxy
  ApiProxy -->|GET /runs/:id/stream?after=N + Bearer| SSEEndpoint
  SSEEndpoint -->|Read bounded committed events| EventsTbl
  SSEEndpoint -.->|Re-check the session at every wake-up| SessionsTbl
  Broker -.->|Post-commit wake-up hint| SSEEndpoint
  SSEEndpoint -->|id, event, data frames| ApiProxy
  ApiProxy -->|Unbuffered SSE frames| StreamReader
  RunPage -->|GET /runs/:id snapshot + Bearer| HTTPRoutes
  RunPage -->|Initial snapshot| Console
  History -->|GET /runs?page=N + Bearer| HTTPRoutes
  StreamReader -->|Contiguous events only| Reducer
  Reducer --> Console
  Console --> ApprovalUI
```

---

## Setup Instructions

### Prerequisites
- **Containerized Run (Recommended):** [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine with Docker Compose v2.
- **Native Local Development (Optional):** Python 3.12, Node.js 20+, [pnpm](https://pnpm.io/) 10+, [uv](https://docs.astral.sh/uv/) package manager, and a local PostgreSQL 17 instance with the [pgvector](https://github.com/pgvector/pgvector) extension. ONNX Runtime, which runs the embedding model, ships macOS wheels only for Apple Silicon on macOS 14 or later.

---

### Option A: Quick Start with Docker Compose (Recommended)

1. **Clone and configure environment:**
   ```sh
   cp .env.example .env
   ```
   *(`.env.example` selects `LLM_PROVIDER=anthropic`, which needs `ANTHROPIC_API_KEY`. For the offline, deterministic demo scenarios without any API key, set `LLM_PROVIDER=fake` and `FAKE_MODEL=scenario`.)*

2. **Launch all containers in detached mode:**
   ```sh
   docker compose up --build -d
   ```
   The database runs `pgvector/pgvector:0.8.7-pg17-bookworm` (PostgreSQL 17 on Debian bookworm plus the pgvector extension), so a `pgdata` volume created by the earlier `postgres:17-bookworm` image keeps working. The first build bakes the policy-search embedding model, `BAAI/bge-small-en-v1.5` (about 67 MB, run locally through fastembed, no API key), into the backend image; the container runs offline and never downloads it. On every start the backend runs the migrations and `python -m app.seed`, which creates the demo users, seeds the orders and syncs the policy index.

3. **Verify running containers and health:**
   ```sh
   docker compose ps
   ```

4. **Sign in** at [http://localhost:3000](http://localhost:3000) as `alex@opspilot.test` (Alex Rivera) or `sam@opspilot.test` (Sam Chen). Both use the password `opspilot-demo`; set `DEMO_USER_PASSWORD` in `.env` to change it, and the seed updates both accounts on the next start. Each account sees only its own runs. Runs created before accounts existed are given to Alex by the seed.

5. **Follow startup logs:**
   ```sh
   docker compose logs -f backend
   ```
   The seed reports the demo users and the policy index, e.g. `Policy index (BAAI/bge-small-en-v1.5): 8 inserted, 0 updated, 0 unchanged, 0 deleted.` on the first start and `0 inserted, 0 updated, 8 unchanged, 0 deleted.` after that.

6. **Stop containers (preserving database volume):**
   ```sh
   docker compose down
   ```

---

### Option B: Native Local Development Setup

If running without Docker:

1. **Start PostgreSQL 17 with pgvector:**
   Ensure a local PostgreSQL instance is running on port 5432 with a database named `opspilot` and the pgvector extension installed. Migration `0002_policy_search` runs `CREATE EXTENSION IF NOT EXISTS vector`, which needs a superuser unless the extension already exists in that database.

2. **Set up the Backend (FastAPI):**
   ```sh
   cd backend
   uv sync
   uv run alembic upgrade head
   uv run python -m app.seed
   uv run uvicorn app.main:app --reload --port 8000
   ```
   The seed creates the demo users only when `DEMO_USER_PASSWORD` is set (`.env.example` sets `opspilot-demo`). With `EMBEDDING_PROVIDER=local` (the default), the first seed downloads the embedding model (about 67 MB) into fastembed's cache, which is in the system temp folder unless `EMBEDDING_CACHE_DIR` names another one; `EMBEDDING_PROVIDER=hashing` needs no download but only matches shared words. Export `ORT_DISABLE_TELEMETRY=1` in that shell to keep ONNX Runtime's usage telemetry off (the Docker image sets it; a value in `.env` reaches only the app's settings, not ONNX Runtime).

3. **Set up the Frontend (Next.js):**
   ```sh
   cd frontend
   pnpm install
   pnpm dev
   ```

---

### Browser API Connection & Proxy Routing

The browser sends commands, readiness checks, and SSE subscriptions to `/api` on the **same origin as the console**. Next.js forwards them to `API_INTERNAL_URL` (`http://backend:8000` in Compose; `http://127.0.0.1:8000` for native development). No browser-side port mapping or CORS permission is needed, including on the isolated test ports. SSE bodies are forwarded without buffering, with the replay cursor intact.

The console is a **backend-for-frontend**: the session token lives in an HttpOnly cookie (`opspilot_session`) that only the Next.js server reads. The `/api` proxy and the server-side page loaders turn it into `Authorization: Bearer <token>` (the proxy drops any `Authorization` header the browser sends, answers `401` without a session, and keeps `/health/*` public). Sign-in and sign-out never go through `/api`: they are Server Actions that call FastAPI's `/auth` endpoints from the Next.js server, so browser JavaScript never sees the token. For the same reason there is no browser-side API override: only the same-origin `/api` proxy can add the token.

After pulling a frontend or backend fix, rebuild the running services from the repository root:
```sh
docker compose up -d --build --wait backend frontend
```

### Access Points
- **Next.js Console:** [http://localhost:3000](http://localhost:3000) (or [http://127.0.0.1:3000](http://127.0.0.1:3000)); without a session it redirects to [/login](http://localhost:3000/login)
- **FastAPI Interactive Docs (Swagger):** [http://localhost:8000/docs](http://localhost:8000/docs). Every `/runs` endpoint needs a bearer token: call `POST /auth/login`, then paste its `access_token` into **Authorize**.
- **Backend Readiness Probe:** [http://localhost:8000/health/ready](http://localhost:8000/health/ready)
- **Backend Liveness Probe:** [http://localhost:8000/health/live](http://localhost:8000/health/live)

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

Accounts and policy search have their own settings (defaults from `backend/app/config.py`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_USER_PASSWORD` | Empty in code; `opspilot-demo` in Compose and `.env.example` | Shared password of `alex@opspilot.test` and `sam@opspilot.test`. The seed skips the accounts while it is empty and re-hashes their password whenever it changes. |
| `SESSION_TTL_HOURS` | `12` | Fixed lifetime of a sign-in session. |
| `LOGIN_MAX_FAILURES`, `LOGIN_WINDOW_SECONDS` | `5`, `900` | Failed sign-ins allowed per email within the window before `429 Too Many Requests` with `Retry-After`. A second cap of 50 failures per window across all emails is a constant in `app/auth/throttle.py`. |
| `EMBEDDING_PROVIDER` | `local` | `local` runs `BAAI/bge-small-en-v1.5` inside the backend process; `hashing` is the deterministic, word-based stand-in the tests use. |
| `EMBEDDING_CACHE_DIR` | Unset (the Docker image sets `/opt/models`) | Folder fastembed loads the model from (and, outside Docker, downloads it into). |

Restart the backend container to apply environment changes:
```sh
docker compose up -d --build --wait
```

---

## Business Scenario & Database Seed Data

OpsPilot simulates an operations assistant for an e-commerce platform:
1. **Orders Database:** 30 synthetic orders seeded across qualifying and non-qualifying cases (orders below, equal to, and above \$500; on-time shipments; late shipments; cancelled and already refunded orders).
2. **Explicit Reference Date:** The first seed picks the reference date (today's UTC date, or `--reference-date`) and stores it in `seed_metadata`, so restarts keep the same orders; the qualifying month is the calendar month before it. The isolated E2E stack (`compose.phase8.yaml`) pins `2026-02-15`, so its qualifying month is January 1 to February 1 (exclusive). Database restarts never reset or duplicate existing records.
3. **8 Shipping Policies:** Bundled in `backend/policies/` covering shipping commitments, late-shipment refund eligibility, refund calculation rules, exclusions, duplicate requests, email drafts, and escalation. The seed indexes them into `policy_chunks` (one row per paragraph, with its embedding) and brings the index in line with the files on every start, embedding only new or changed paragraphs.
4. **Fictional Refund Calculation:** Qualifying late shipments receive 10% of order value capped at \$100. Fractional cents are rounded using `ROUND_HALF_UP` in integer cents (`amount_minor`).
5. **Simulated Ledger:** Refunds are written transactionally to a simulated ledger table (`refunds`). No real money moves.
6. **Demo Accounts:** Two users, Alex Rivera (`alex@opspilot.test`) and Sam Chen (`sam@opspilot.test`), share the password from `DEMO_USER_PASSWORD`. Runs without an owner (created before accounts existed) are given to Alex.

---

## Typed Tools Catalog

The agent loop dispatches four strictly typed tools:

| Tool Name | Type | Behavior |
| --- | --- | --- |
| `date_math` | Read | Computes calendar boundaries in the run's business timezone (e.g. `previous_month`). |
| `query_orders` | Read | Queries orders using typed parameters (`order_id`, `start`, `end`, `min_amount_minor`, `late_only`, `status`). SQL injection is structurally impossible. |
| `search_policies` | Read | Hybrid search over the 8 bundled markdown policies, indexed in PostgreSQL: an exact policy ID, full-text keywords and pgvector similarity. Returns ranked matches with policy IDs, versions, exact paragraph excerpts and why each policy matched (`matched_by`, `similarity`), which the console shows as badges. |
| `issue_refund` | Write *(Approval-Gated)* | Calculates eligible refund from order and policy evidence. Proposes an immutable approval record and **pauses the run**. Upon human approval, writes exactly once to the simulated refund ledger. |

---

## Core Scenarios to Run

### Scenario 1: Read-Only Analysis & Email Drafts (No Write Action)
Choose the **Draft late-shipment emails** scenario on the New run page (`/`), or paste:
> *"Find orders over \$500 that shipped late last month and draft a short refund email for each. Cite the applicable policy. Keep each email to two sentences."*

- **What Happens:** The agent calls `date_math`, `query_orders`, and `search_policies`. It composes email drafts directly in its response. The `search_policies` card shows why each policy matched with badges (**Policy ID**, **Keyword**, **Meaning NN%**) and a footer that says how many of the 8 policies matched and whether the search ran in hybrid or keyword-only mode.
- **Verification:** No approval card appears. Each draft is an email card with its own copy button. The simulated refund ledger has zero new entries.

### Scenario 2: Explicit Refund with Human Approval
Paste this goal:
> *"Check the late-shipment policy and issue the eligible simulated refund for ORD-1006. Show the proposed amount and evidence for my approval."*

- **What Happens:** The agent queries order `ORD-1006` (\$845.05) and policy v1 (10% up to \$100). It calculates \$84.51 USD (8,451 cents), pauses execution, and presents an **Approval Card**.
- **Reload Survival:** Refresh the browser page (`F5`). The same approval card reappears with exact details, and the tab title says "Approval needed".
- **Decision:** Click **Approve refund**. The worker claims the resumed run, records the simulated ledger entry, and outputs the final confirmation.

### Scenario 3: Rejection with Required Reason
Paste this goal:
> *"Please issue the eligible late-shipment refund for ORD-1001 and wait for my decision."*

- **What Happens:** The agent pauses for `ORD-1001` (\$62.50). Click **Reject…** and enter a reason (*"Customer requested store credit"*). A blank reason is refused.
- **Verification:** The rejection reason is passed back to the agent as a tool observation. The agent acknowledges it. Zero rows are added to the refund ledger.

### Scenario 4: Stopping a Run
Click **Stop** (then **Stop run** to confirm) on any queued, running, or waiting run.
- **What Happens:** The run transitions through `cancelling` to `cancelled`. Partial output is preserved. Pending approvals are marked cancelled. Closing the browser tab does **not** cancel a run.

### Scenario 5: Two Users, Separate Runs
Signed in as Alex, start any run and copy its URL. Open the account menu, click **Sign out**, and sign in as `sam@opspilot.test`.
- **What Happens:** `/runs` lists only Sam's runs, and Alex's run URL shows **Run not found**: the API answers `404` for another user's run, exactly as for a run that does not exist, so a run ID reveals nothing. Signing out revokes the session on the backend, and a run stream still open with that session ends within one 15-second keepalive interval.

---

## Optional Stretch Goals

| Stretch Goal | Status |
| :--- | :--- |
| Login for two users, each seeing only their own runs | **Done.** Two seeded demo accounts, sign-in and sign-out, per-user run lists and `404` for other users' runs (Scenario 5). |
| Evaluation script with 10 fixed prompts and their expected tool sequences | **Not done.** See Future Improvements. |

---

## Design Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| **Agent Orchestration** | Native Async Tool Loop (No heavy framework) | Built directly with Python 3.12 async generators and Pydantic v2 schemas. Avoids opaque framework abstractions (e.g. LangChain, CrewAI), providing full observability over continuation contexts, step limits, token budgets, and pause/resume transactions. |
| **State Persistence** | PostgreSQL 17 as Single Source of Truth | Every state transition (`queued` $\to$ `running` $\to$ `awaiting_approval` $\to$ `completed`/`failed`/`cancelled`), message transcript, tool call, and monotonic event is durably committed before dispatching. Runs survive container crashes and browser reloads without in-memory dependency. |
| **Browser Transport** | Server-Sent Events (SSE) + HTTP POST | One-way SSE stream for real-time text deltas and tool lifecycle telemetry. Reconnects via `Last-Event-ID` or `?after=N` replay committed events from the database. Explicit user actions (Approve, Reject, Stop) use standard HTTP POST requests. |
| **Network Architecture** | Same-Origin Next.js Reverse Proxy (`/api/*`) | Direct browser-to-backend requests across ports (`:8000` vs `:3000`) encounter CORS preflight and private-network permission blocks. Next.js App Router catch-all route forwards requests server-to-server to `API_INTERNAL_URL` (`http://backend:8000`) with unbuffered streaming. |
| **Safety Guardrail** | Human-in-the-Loop Financial Boundary | Write actions (`issue_refund`) cannot execute autonomously. When proposed, the agent loop pauses, commits a pending approval record, and yields the worker. Execution only resumes after a human operator explicitly approves or rejects the action with a mandatory reason. |
| **Policy Search** | Hybrid search inside PostgreSQL: exact policy ID + full-text keywords + pgvector meaning | Each signal catches what the others miss: an ID is the most precise request an agent can make, keywords find exact terms like "cap", and embeddings find paraphrases that share no words ("money back" vs "refund"). A policy's relevance is the average of its keyword coverage and its meaning similarity (each 0 to 1; a signal that missed it counts 0), plus 1.0 when the query names its ID, so a named policy always ranks first. Keyword coverage is the share of 3 points per distinct query word that a paragraph earns: 1 point when the word appears in its title or paragraph, 2 more when it is in the title, and nothing for repeats (PostgreSQL extracts the words with the index's own English stemming and stop words). Scores are averaged rather than ranks merged because the rank fusion tried first threw away score strength with only 8 policies (it reduced to the sum of the two ranks), so bge-small's nearly flat similarities decided the order and the demo query "late shipment refund" ranked the exclusions policy (`EXCLUDE-01`) first; averaging the 0–1 scores ranks `AMOUNT-01`, then `LATE-01` first. If the query cannot be embedded, search answers from IDs and keywords and reports `mode: "keyword"`. |
| **Embedding Model** | Local `BAAI/bge-small-en-v1.5` (384 dimensions) through fastembed and ONNX Runtime, baked into the backend image | No API key, no per-query network call or cost, and it works offline; the same model embeds the paragraphs and the queries, in a worker thread so the event loop keeps serving streams. A meaning match needs cosine similarity of at least 0.6, calibrated on the 8 policies: relevant queries score 0.67–0.77 and paraphrases sharing no word 0.61–0.71, while "xyznonexistent123" peaks at 0.59 and 50 other off-topic queries at 0.32–0.58. Tests use a deterministic hashing embedder (`EMBEDDING_PROVIDER=hashing`): no download and identical vectors on every machine. |
| **Policy Index** | One `policy_chunks` row per paragraph, synced by the seed | A paragraph is small enough to quote as exact evidence and to embed without truncation. The seed runs on every start but embeds a paragraph again only when its text (SHA-256) or the model changes, and deletes paragraphs that no longer exist. Every row records the model that embedded it, and every query reads only the active model's rows. |
| **Accounts & Sessions** | Backend-for-frontend with opaque, database-backed session tokens | A Server Action puts the token from FastAPI straight into an HttpOnly, `SameSite=Lax` cookie, so browser JavaScript never holds it; the `/api` proxy and server loaders send it as `Authorization: Bearer`. Tokens are 256-bit random strings and the database stores only their SHA-256, so a leaked `user_sessions` table signs nobody in. Passwords are argon2id hashes (argon2-cffi) checked in a worker thread; an unknown email is checked against a dummy hash, and both failures get the same `401`. Failed sign-ins are throttled per email and globally (`429` with `Retry-After`), and `422` responses never echo submitted values. |
| **Run Ownership** | Sign-in required on the whole `/runs` router; `404` for other users' runs | A router-level dependency covers every current and future run route. An owner check runs before `GET /runs/{id}`, `/approve`, `/stop` and `/stream`, and the list and its total are filtered by owner. `404` rather than `403`, so a run ID reveals nothing. An open SSE stream re-checks the session at every wake-up (at least every 15 s) and ends after sign-out or expiry. Next.js `proxy.ts` only redirects when the cookie is missing; FastAPI makes the real check, and every return path after sign-in goes through `safeNextPath` (same-site paths only). |
| **Server/Client Split** | Server pages, one client island per live view | Pages and the layout are Server Components that load data next to the backend and return expected failures as values. The run console is a single client island because everything in it follows the stream; elsewhere, client code is limited to small interactive leaves (composer, theme toggle, auto-refresh). |
| **Live Trace State** | Pure reducer + view models + React-free stream loop | The SSE loop resumes from the snapshot cursor, accepts only contiguous sequences, reloads the snapshot on a gap or disconnect, and backs off between retries. The reducer groups tool calls the same way the server does (calls requested before their turn's `message.completed` wait for it), so the live trace and the replay match. Both are unit-tested without React. |
| **Rendering Untrusted Output** | react-markdown without raw HTML | Model text is rendered with raw HTML dropped, images disabled and links limited to http, https and mailto. There is no `dangerouslySetInnerHTML` in the app; the theme uses a cookie read on the server instead of an inline script. Email drafts become cards with copy buttons. |
| **Design System** | Tailwind v4 tokens + small owned components | One token table (light and dark through `light-dark()`), semantic status colors always paired with an icon and a label, Radix primitives for tabs, dialog and tooltip, and no component kit. axe checks WCAG 2.2 AA in both themes. |

---

## Technical Trade-offs

| Area | Approach Chosen | Trade-off & Compromise |
| :--- | :--- | :--- |
| **Worker Architecture** | Single-Process Lifespan Worker with PostgreSQL Locks | Eliminates external task broker dependencies (Redis, RabbitMQ, Celery), making local startup instant and reliable. However, multiple queued runs are processed sequentially rather than distributed across parallel worker nodes. |
| **Streaming Protocol** | Server-Sent Events (SSE) instead of WebSockets | SSE is simpler, HTTP/2-friendly, cacheable, and features native browser reconnection. However, it is unidirectional; commands require separate HTTP POST requests instead of duplex messaging over a single socket. |
| **Currency Arithmetic** | Integer Cents (`amount_minor`) instead of Float | All calculations ($R_{\text{cents}} = \min(\lfloor A_{\text{cents}} \times 0.10 + 0.5 \rfloor, 10000)$) use integer cents and `ROUND_HALF_UP`. Eliminates IEEE-754 floating-point precision bugs; requires explicit division by 100 when rendering formatted currency to users. |
| **Policy Search Engine** | pgvector and full-text search inside the existing PostgreSQL instead of a separate vector database | One database to run, migrate and back up, and the index sits next to the data it cites, with exact-paragraph citations. However, `CREATE EXTENSION vector` needs a superuser (or an extension created beforehand), the database image becomes `pgvector/pgvector`, and a dedicated vector store would scale further than one HNSW index. |
| **Embedding Model** | Small local model baked into the image instead of an embeddings API | No key, no network and no per-query cost. However, the backend image grows from about 271 MB to 644 MB (`docker image ls`), the first search after a restart loads the model (about half a second), and bge-small squeezes similarities into roughly 0.3–0.8, so its scores separate on-topic from off-topic queries better than they order on-topic policies. |
| **Session Model** | Opaque database sessions instead of stateless JWTs | Sign-out and expiry take effect on the next request, with no token blacklist or signing keys to manage. However, every API request (and every stream wake-up) costs one indexed `user_sessions` lookup. |
| **Time Management** | Reference date stored by the first seed (pinned to `2026-02-15` UTC in the E2E stack) | The E2E stack gets reproducible orders and assertions regardless of when the tests run, and a normal start keeps the date it first seeded with across restarts. Each run's own reference time is real time (`datetime.now(UTC)`) when it is created. |

---

## Known Gaps

1. **Horizontal Worker Auto-Scaling:** The worker currently uses an in-process queue loop with PostgreSQL advisory locks. Scaling across multiple container replicas requires distributed queue leasing with worker heartbeat health checks.
2. **Demo-Grade Accounts:** The two seeded users share one documented password (`opspilot-demo`), which is meant for local use only. There is no sign-up, password reset, role separation (e.g., Tier-1 Support Operator vs. Finance Manager) or SSO, and sessions have a fixed lifetime (`SESSION_TTL_HOURS`) with no sliding renewal or refresh tokens. An enterprise deployment needs OIDC and roles.
3. **Outbound Channel Connectors:** While the system drafts emails and commits simulated ledger entries, outbound email delivery (via SendGrid/AWS SES) and real banking/Stripe transfers are not wired to live external APIs.
4. **Search Quality on a Small Model:** bge-small squeezes similarities into roughly 0.3–0.8, so the 0.6 floor separates on-topic from off-topic queries but not finely by relevance: for an on-topic query most of the 8 policies clear it, so when the query shares words with the policies, keyword coverage does most of the ordering. The hashing embedder that the tests use only sees shared words, so the default test suite proves the plumbing, not the semantics; only the opt-in `RUN_MODEL_TESTS=1` tests exercise the real model.
5. **In-Memory Login Throttle:** Failed sign-ins are counted in the API process, which is enough for the single `uvicorn --workers 1` process but resets on restart; several replicas would need a shared store such as Redis. The global cap (50 failures per window across all emails) can pause sign-in for everyone during an attack, and per-IP limits would need a trusted proxy that reports the client IP, because the API only sees the console's server.
6. **Embedding Model Supply Chain and Indexing:** The model revision is not pinned: fastembed fetches the latest export of `BAAI/bge-small-en-v1.5` when the image is built, while stored vectors are re-embedded only when the text or the model *name* changes. The model and the libraries that run it make the backend image about 370 MB larger. The policy indexer assumes a single writer (the seed); two concurrent seeds would fail on the unique key rather than corrupt the index.

---

## Future Improvements

1. **Webhook & Collaboration Integrations:** Real-time Slack/Microsoft Teams notifications with interactive approval buttons when runs enter `awaiting_approval`.
2. **Multi-Agent Separation of Concerns:** Decoupling research (investigating orders/policies) from calculation auditing (verifying mathematical proofs) into two specialized collaborating subagents.
3. **Live Payment Gateway Sandboxes:** Connect the simulated ledger to real developer sandboxes (Stripe Test Mode, Adyen Test Platform) for end-to-end payment settlement.
4. **Automated Continuous Benchmarking:** Start with the stretch goal's evaluation script (10 fixed prompts and their expected tool sequences), then a CI suite running golden operational datasets, including labelled policy-search queries, to detect precision/recall regressions across LLM prompt, model and embedding-model version bumps.

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
By default the tests never download a model: `tests/conftest.py` selects the deterministic hashing embedder unless `EMBEDDING_PROVIDER` is already exported. Integration tests need `TEST_DATABASE_URL` pointing at a PostgreSQL 17 server with pgvector and a role that may create databases and the `vector` extension (each test creates, migrates, indexes and drops its own database); without it, tests that need a database are skipped. For example:
```sh
docker run -d --name opspilot-test-db -e POSTGRES_USER=opspilot -e POSTGRES_PASSWORD=opspilot_test \
  -p 127.0.0.1:15433:5432 pgvector/pgvector:0.8.7-pg17-bookworm
export TEST_DATABASE_URL=postgresql+asyncpg://opspilot:opspilot_test@127.0.0.1:15433/postgres
```
With it, the full integration suites run automatically:
```sh
uv run pytest -q tests/integration/test_scenario_reliability.py tests/integration/test_streaming.py
uv run pytest -q tests/integration/test_agent_loop.py tests/integration/test_approvals.py tests/integration/test_approvals_api.py tests/integration/test_cancellation.py tests/integration/test_refund_execution.py tests/integration/test_worker.py
uv run pytest -q tests/integration/test_auth_api.py tests/integration/test_run_ownership.py tests/integration/test_seed.py tests/integration/test_policy_index.py tests/integration/test_policy_search.py
```
What the sign-in and search tests cover:
- **Accounts:** password hashing, token hashing, the login throttle and request normalisation (unit); sign-in, the same `401` for a wrong password and an unknown email (which still pays for a password check), no password echoed in a `422`, `429` with `Retry-After` (also for a burst of parallel guesses and for failures spread over many emails), expired and revoked sessions, and logout (`test_auth_api.py`).
- **Ownership:** every `/runs` endpoint needs sign-in, lists and totals are per user, another user's run answers `404` on `GET`, `stream`, `approve` and `stop` without changing it, and ownerless runs are visible to nobody (`test_run_ownership.py`); signing out ends an open stream (`test_streaming.py`); the seed creates the demo users once, replaces outdated hashes and adopts ownerless runs (`test_seed.py`).
- **Policy search:** corpus parsing and validation, the hashing embedder and the scoring rules (unit); a rerun of the indexer writes nothing, only new or changed paragraphs are embedded, stale ones are deleted, and a model change re-embeds everything (`test_policy_index.py`); every policy is citable by ID with an exact paragraph, keyword coverage, query punctuation and tsquery operators, nonsense queries, the keyword-only fallback, an empty index and the tool through the registry (`test_policy_search.py`).
- **Real model (opt-in):** `RUN_MODEL_TESTS=1 uv run pytest -q -k local_model` downloads `BAAI/bge-small-en-v1.5` (or reuses `EMBEDDING_CACHE_DIR`) and checks that it matches by meaning without shared words; with `TEST_DATABASE_URL` also that a query sharing no word with any policy finds `EMAIL-01`, that nonsense stays below the 0.6 floor, and that the demo queries rank their expected policy first.

### 2. Frontend Checks & Unit Tests
Run from `frontend/`:
```sh
cd frontend
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test             # unit tests for src/lib (node --test)
pnpm test:coverage    # the same, with coverage of src/lib
pnpm build
```
The unit tests include sign-in: `safeNextPath` against hostile return paths (`//evil.com`, `/\evil.com`, `https://…`, encoded variants, `/login` itself), the session cookie options, the `/api` proxy turning the cookie into a bearer token (dropping the browser's own `Authorization`, answering `401` without a session, keeping health checks public), and the stream loop stopping on `401`. They also cover the search result parser and the wording of its badges.

### 3. Isolated Compose & Playwright E2E Tests
To test the complete end-to-end stack in an isolated Docker environment without external keys:
```sh
export P8_PROJECT="opspilot-p8-test"
docker compose --env-file .env.example -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml up --build --wait -d
curl -fsS http://127.0.0.1:18000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:13000/
(cd frontend && pnpm exec playwright install chromium && E2E_EXTERNAL_STACK=1 pnpm exec playwright test)
docker compose -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml down -v --remove-orphans
```
The suite covers the draft, approval, rejection and stop journeys, route states, and axe accessibility checks in both themes. A `setup` project first signs in Alex and Sam through the form and saves their cookies under `frontend/tests/.auth/` (git-ignored); every spec runs as Alex unless it says otherwise. `tests/auth.spec.ts` covers the signed-out redirect and the return to the requested page, a wrong password, sign-out, that Sam can neither open nor list Alex's run, the demo-account buttons at 375 px, and axe on the sign-in page (also while it shows an error) in both themes. The password is `E2E_DEMO_PASSWORD` (default `opspilot-demo`, which `compose.phase8.yaml` seeds). It expects a fresh stack: approving `ORD-1006` writes to the simulated ledger once.

---

## Reviewer Guides
- **Architecture, Trace, Accounts, Policy Search & Data Model:** [`docs/architecture.md`](docs/architecture.md)
- **Demo Script & Interview Rehearsal:** [`docs/demo-script.md`](docs/demo-script.md)
- **Frontend Data Flow, Sign-in, Boundaries & Extension Points:** [`docs/frontend.md`](docs/frontend.md)
