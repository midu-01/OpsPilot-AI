"""Hybrid policy search: embeddings, the pgvector index and ranking.

Kept free of imports on purpose: app.models imports app.search.embeddings for the vector size, so importing the
database-facing submodules here would create an import cycle.
"""
