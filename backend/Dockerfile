FROM python:3.12-slim-bookworm AS build
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.0 /uv /bin/uv
ENV UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY policies ./policies
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "-ec", "alembic upgrade head && python -m app.seed && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
