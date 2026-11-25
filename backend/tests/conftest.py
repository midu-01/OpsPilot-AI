"""Test-wide setup that has to happen before any test module imports the application.

app.config builds its settings once, at import time. Choosing the embedding provider here, before the first
`import app...`, makes every test (and every Alembic subprocess, which inherits this environment) use the
deterministic HashingEmbedder: no model download, no network, identical vectors on every machine.
setdefault leaves an explicitly exported EMBEDDING_PROVIDER in charge.
"""

import os

os.environ.setdefault("EMBEDDING_PROVIDER", "hashing")
