"""Password hashing: argon2id hashes, and every failed check is a plain False rather than an exception."""

from argon2 import PasswordHasher

from app.auth.passwords import hash_password, needs_rehash, verify_dummy, verify_password


def test_hash_verifies_only_the_same_password() -> None:
    password_hash = hash_password("opspilot-demo")
    assert password_hash.startswith("$argon2id$")
    assert "opspilot-demo" not in password_hash
    assert verify_password(password_hash, "opspilot-demo") is True
    assert verify_password(password_hash, "opspilot-demo ") is False
    assert verify_password(password_hash, "") is False


def test_each_hash_has_its_own_salt() -> None:
    assert hash_password("same password") != hash_password("same password")


def test_malformed_hashes_fail_closed_and_need_replacing() -> None:
    for broken in ["", "not-a-hash", "$argon2id$v=19$m=65536,t=3,p=4$broken"]:
        assert verify_password(broken, "anything") is False
        assert needs_rehash(broken) is True


def test_hashes_with_weaker_settings_still_verify_but_need_rehash() -> None:
    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash("opspilot-demo")
    assert verify_password(weak, "opspilot-demo") is True
    assert needs_rehash(weak) is True
    assert needs_rehash(hash_password("opspilot-demo")) is False


def test_dummy_check_runs_without_raising_for_any_password() -> None:
    for password in ["", "guess", "x" * 128]:
        assert verify_dummy(password) is None
