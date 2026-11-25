"""Opaque session tokens: the client keeps the token, the database keeps only its SHA-256.

A token of 32 random bytes (256 bits) cannot be guessed, so it needs no salt or slow hash: a plain SHA-256 is enough
to make a leaked user_sessions table useless for signing in, and it lets us find a session by an indexed lookup.
"""

import hashlib
import secrets

TOKEN_BYTES = 32


def new_token() -> str:
    """A fresh URL-safe token (43 characters) for every sign-in."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """The 64-character hex digest stored in user_sessions.token_hash."""
    return hashlib.sha256(token.encode()).hexdigest()
