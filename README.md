# OpsPilot AI

OpsPilot is a local operations workspace. The Next.js console connects to a FastAPI service backed by PostgreSQL. The API stores queued runs and their event history.

## Start locally

With a running Docker engine and the Compose plugin, run this from the repository root:

```sh
docker compose up --build -d
docker compose ps
```

Open [the console](http://localhost:3000) and check that **Backend & database** shows **Connected**. The server checks the API on each page load. The [readiness endpoint](http://localhost:8000/health/ready) executes a database query and returns HTTP 503 if PostgreSQL becomes unavailable. [Liveness](http://localhost:8000/health/live) only checks the API process.

On a Mac using Colima, start the engine with `colima start` before running Compose. Local defaults work without an API key or an environment file. To customize the local database password, copy `.env.example` to `.env` before initializing the volume. Use a URL-safe value. Keep the same password while reusing that volume.

Use `docker compose logs backend` to inspect API startup and `docker compose down` to stop the workspace while keeping the named database volume. The browser and API ports bind to loopback. PostgreSQL is accessible inside the Compose network.

## Database and demo data

The backend applies Alembic migrations and seeds 30 synthetic orders before accepting requests. The first startup records a UTC reference date for the demo. Later starts preserve that date, existing orders, refunds and runs. The backend startup log prints a sample goal with the matching shipment dates. The eight fictional policy documents ship in `backend/policies/`.

`POST /runs` creates a queued run. `GET /runs/{id}` returns its messages, events and replay cursor, including after a backend restart. `GET /runs` returns paginated history. The [local API documentation](http://localhost:8000/docs) lets you exercise these endpoints.

For the PostgreSQL integration tests, set `TEST_DATABASE_URL` to an accessible `postgresql+asyncpg://` URL for a test role with database creation permission. Each test creates, migrates and removes its own database. Run `uv run pytest tests/integration` from `backend/`.

## Run and event contracts

The Pydantic models in `backend/app/runs/schemas.py` describe run creation, states, approval decisions, snapshots and the event stream. Each event has a version, run ID, strictly positive per-run sequence number, event type, timestamp and payload. The snapshot cursor records the last represented sequence number (zero for an empty trace). A subscriber requests events after that cursor. The provider interface in `backend/app/agent/contracts.py` defines the streaming boundary for real and scripted model providers.

## Verify locally

Run `pnpm install --frozen-lockfile`, `pnpm lint`, and `pnpm typecheck` from `frontend/`. From `backend/`, run `uv sync --locked`, then `uv run pytest`, `uv run ruff check .`, and `uv run mypy app`. Backend unit tests use a scripted provider and do not require an OpenAI key.

The console shows both the server-side database readiness check and the browser's independent request to the API. Select **Refresh status** to repeat both checks.
