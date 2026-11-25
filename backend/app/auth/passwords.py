"""Password hashing with argon2id.

argon2id is the current OWASP / RFC 9106 recommendation: it is deliberately slow and needs 64 MiB per check
(argon2-cffi's defaults: t=3, m=65536 KiB, p=4), so a stolen hash is expensive to brute-force. The flip side is
~50 ms of CPU per call, which is why the API calls these functions through asyncio.to_thread.
"""

import logging
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

logger = logging.getLogger("opspilot.auth")
_hasher = PasswordHasher()
# A real hash of a random password nobody knows. Checking an unknown email against it costs as much as
# checking a real account, so response times do not reveal which emails have accounts.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    """Return a salted argon2id hash that also records its own cost settings."""
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """True only for a matching password; a mismatch or a malformed hash is simply False."""
    try:
        return _hasher.verify(password_hash, password)
    except InvalidHashError:
        # Never log the hash or the password, only that the stored value is unusable.
        logger.warning("A stored password hash could not be parsed")
        return False
    except VerificationError:  # includes VerifyMismatchError, the ordinary wrong password
        return False


def needs_rehash(password_hash: str) -> bool:
    """True when the hash uses older cost settings (or cannot be parsed) and should be replaced."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def verify_dummy(password: str) -> None:
    """Spend the same time as a real check, for emails that have no account. The answer is thrown away."""
    verify_password(_DUMMY_HASH, password)
