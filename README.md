# OpsPilot AI

OpsPilot is a local operations workspace. The Next.js console connects to a FastAPI service backed by PostgreSQL. A background worker executes model-selected tools and stores the conversation, usage and event history in PostgreSQL.

## Start locally

With a running Docker engine and the Compose plugin, run this from the repository root:

```sh
docker compose up --build -d
docker compose ps
```

Open [the console](http://localhost:3000) and check that **Backend & database** shows **Connected**. The server checks the API on each page load. The [readiness endpoint](http://localhost:8000/health/ready) executes a database query and returns HTTP 503 if PostgreSQL becomes unavailable. [Liveness](http://localhost:8000/health/live) only checks the API process.

On a Mac using Colima, start the engine with `colima start` before running Compose. The console and database start without credentials. Real model calls use the selected provider’s server-side API key. To customize the local database password, copy `.env.example` to `.env` before initializing the volume. Use a URL-safe value. Keep the same password while reusing that volume.

Use `docker compose logs backend` to inspect API startup and `docker compose down` to stop the workspace while keeping the named database volume. The browser and API ports bind to loopback. PostgreSQL is accessible inside the Compose network.

## Database and demo data

The backend applies Alembic migrations and seeds 30 synthetic orders before accepting requests. The first startup records a UTC reference date for the demo. Later starts preserve that date, existing orders, refunds and runs. The backend startup log prints a sample goal with the matching shipment dates. The eight fictional policy documents ship in `backend/policies/`.

`POST /runs` creates a queued run. `GET /runs/{id}` returns its messages, events and replay cursor, including after a backend restart. `GET /runs` returns paginated history. The [local API documentation](http://localhost:8000/docs) lets you exercise these endpoints.

For the PostgreSQL integration tests, set `TEST_DATABASE_URL` to an accessible `postgresql+asyncpg://` URL for a test role with database creation permission. Each test creates, migrates and removes its own database. Run `uv run pytest tests/integration` from `backend/`.

## Run a model-backed goal

For a fresh setup, copy `.env.example` to `.env`. Select a provider and fill in its key in that local file. After editing it, run `docker compose up -d --build --wait` to apply the settings.

| LLM_PROVIDER | Configuration | API |
| --- | --- | --- |
| `groq` | `GROQ_API_KEY` and `GROQ_MODEL` | Groq Chat Completions. The example selects `openai/gpt-oss-20b` hosted by Groq. |
| `openai` | `OPENAI_API_KEY` and `OPENAI_MODEL` | OpenAI Responses with native function calling. |
| `omniroute` | `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL` and `OMNIROUTE_BASE_URL` | OpenAI-compatible Chat Completions. Set the base to a backend-reachable URL ending in `/v1`. On Docker Desktop for Mac, the host address is `http://host.docker.internal:20128/v1`. |
| `fake` | No credential | A fixed offline response. Tests inject multi-turn scripts to exercise tool calls and failures. |

Submit a goal through the local API. The response contains the run ID.

```sh
curl -sS http://localhost:8000/runs \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Which seeded order shipped late last month and has the highest order total above $500? Give one order ID and its total."}'
```

Open `GET /runs/{id}` in the local API documentation to see the selected tools, arguments, actual tool results, final answer and per-turn usage. The backend gives each tool result back to the model before requesting its next decision. The worker enforces separate limits for turns, tool calls, per-turn time and total active time. A backend restart preserves queued goals and closes interrupted active runs with a failure event.

`MODEL_PRICES` maps a provider and model to input, cached-input and output rates in USD per million tokens. The backend saves the rates used for each attempt. If the provider reports token totals without a cache breakdown, `cost_is_upper_bound` identifies a conservative list-price estimate. Missing rates or missing input/output counts leave the cost unknown. Estimates use published rates and may differ from a free-tier bill. [Groq model and rates](https://console.groq.com/docs/model/openai/gpt-oss-20b)

## Backend tools

The internal catalog in `app.tools.registry` exposes four typed tools. Read calls return structured results. A direct refund call returns `APPROVAL_REQUIRED`.

| Tool | Behavior |
| --- | --- |
| `date_math` | Computes calendar ranges in the run's business timezone. Its previous-month result supplies inclusive and exclusive shipment timestamps for `query_orders`. |
| `query_orders` | Filters and paginates synthetic orders. For orders over $500, pass `min_amount_minor: 50000`. |
| `search_policies` | Returns ranked matches with each policy's ID, version, source filename and excerpt. |
| `issue_refund` | Requires human approval. A separate read-only preview uses shipment and ledger evidence to calculate the proposed amount in cents. The runner pauses for a persisted approval and executes the approved simulated refund once. |

## Review a proposed refund

Submit an explicit refund goal through `POST /runs`. When the run reaches `awaiting_approval`, `GET /runs/{id}` includes `pending_approval` with an ID, order, proposed amount in cents, reason, policy version and supporting evidence. Refreshing or restarting the backend preserves that proposal.

Send the decision to `POST /runs/{id}/approve` using the saved approval ID.

```json
{"approval_id":"<saved approval UUID>","decision":"approve"}
```

To reject, send `"decision":"reject"` and a nonblank `"reason"`. The runner passes that reason to the model. Decisions requeue the saved tool call and remaining work. Turn, tool and active-time limits continue from their saved values, with human review time excluded from the active-time budget.

Approved refunds create entries in the local simulated ledger. The transaction rechecks the order and refundable balance against the reviewed amount. Repeated decisions and equivalent refund requests preserve a single adjustment per order and policy version. Conflicting decisions return HTTP 409.

`POST /runs/{id}/stop` cancels queued or waiting runs immediately. Active runs move through `cancelling` while their provider stream closes. Cancellation and refund execution lock the same run row. A cancellation that obtains that lock first blocks the refund, and an already committed refund stays in the trace.

Use the [local API documentation](http://localhost:8000/docs) to exercise these operations. The dedicated frontend approval card is scheduled for Phase 7.

## Run and event contracts

The Pydantic models in `backend/app/runs/schemas.py` describe run creation, states, approval decisions, snapshots and the event stream. Each event has a version, run ID, strictly positive per-run sequence number, event type, timestamp and payload. The snapshot cursor records the last represented sequence number (zero for an empty trace). A subscriber requests events after that cursor. The provider interface in `backend/app/agent/contracts.py` defines the streaming boundary for real and scripted model providers.

## Verify locally

### 1. Backend verification and test suites
From `backend/`:
```sh
uv sync --locked
uv run ruff check .
uv run mypy app
uv run pytest
```
When `TEST_DATABASE_URL` is set to an accessible PostgreSQL database with `CREATEDB` permissions (e.g. in CI or local Postgres), the integration test suites run automatically:
```sh
uv run pytest -q tests/integration/test_scenario_reliability.py tests/integration/test_streaming.py
uv run pytest -q tests/integration/test_agent_loop.py tests/integration/test_approvals.py tests/integration/test_approvals_api.py tests/integration/test_cancellation.py tests/integration/test_refund_execution.py tests/integration/test_worker.py
```

### 2. Frontend checks and unit tests
From `frontend/`:
```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### 3. Isolated Compose verification
Run the Phase 8 isolated test stack with simulated seed data and zero external API keys:
```sh
export P8_PROJECT="opspilot-p8-test"
docker compose --env-file .env.example -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml up --build --wait -d
curl -fsS http://127.0.0.1:18000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:13000/
(cd frontend && E2E_EXTERNAL_STACK=1 pnpm exec playwright test tests/approval-flow.spec.ts tests/draft-only.spec.ts)
docker compose -p "$P8_PROJECT" -f compose.yaml -f compose.phase8.yaml down -v --remove-orphans
```
