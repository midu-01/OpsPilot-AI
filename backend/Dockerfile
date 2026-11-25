FROM python:3.12-slim-bookworm AS build
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.0 /uv /bin/uv
ENV UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
# Bake the policy-search embedding model (about 67 MB) into the image, so the container never downloads it.
# The name must match LOCAL_MODEL_NAME in app/search/embeddings.py.
ENV ORT_DISABLE_TELEMETRY=1
RUN /app/.venv/bin/python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/models')"

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /opt/models /opt/models
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY policies ./policies
# Offline at runtime: the model loads from /opt/models only, and ONNX Runtime keeps its usage telemetry off.
ENV PATH="/app/.venv/bin:$PATH" \
    EMBEDDING_CACHE_DIR=/opt/models \
    HF_HUB_OFFLINE=1 \
    ORT_DISABLE_TELEMETRY=1
EXPOSE 8000
CMD ["sh", "-ec", "alembic upgrade head && python -m app.seed && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
