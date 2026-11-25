"""Session tokens are long random strings; only their SHA-256 is ever stored."""

import hashlib
import re

from app.auth.tokens import hash_token, new_token


def test_tokens_are_random_url_safe_and_256_bits() -> None:
    tokens = {new_token() for _ in range(200)}
    assert len(tokens) == 200
    # 32 random bytes in base64url without padding are 43 characters.
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{43}", token) for token in tokens)


def test_hash_token_is_the_sha256_hex_digest() -> None:
    assert hash_token("example-token") == hashlib.sha256(b"example-token").hexdigest()
    digest = hash_token(new_token())
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert hash_token("example-token") == hash_token("example-token")
    assert hash_token("example-token") != hash_token("example-token2")
