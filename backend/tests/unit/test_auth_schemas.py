"""Sign-in bodies are normalised and bounded; public user data never carries a password hash."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.auth.schemas import LoginRequest, LoginResponse, UserPublic
from app.models import User


def test_email_is_trimmed_and_lower_cased() -> None:
    request = LoginRequest(email="  Alex@OpsPilot.TEST\t", password="opspilot-demo")
    assert request.email == "alex@opspilot.test"
    assert request.password.get_secret_value() == "opspilot-demo"


@pytest.mark.parametrize(
    "body",
    [
        {"email": "alex.opspilot.test", "password": "pw"},
        {"email": " a@ ", "password": "pw"},
        {"email": "a" * 250 + "@x.io", "password": "pw"},
        {"email": "alex@opspilot.test", "password": ""},
        {"email": "alex@opspilot.test", "password": "p" * 129},
        {"email": "alex@opspilot.test", "password": "pw", "remember_me": True},
        {"password": "pw"},
    ],
)
def test_invalid_login_bodies_are_rejected(body: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        LoginRequest.model_validate(body)


def test_password_never_appears_in_repr() -> None:
    request = LoginRequest(email="alex@opspilot.test", password="S3cret-visible")
    assert "S3cret-visible" not in repr(request)
    assert "S3cret-visible" not in str(request.model_dump())


def test_public_user_and_login_response_leave_out_hashes() -> None:
    user = User(id=uuid4(), email="alex@opspilot.test", display_name="Alex Rivera", password_hash="$argon2id$secret")
    public = UserPublic.model_validate(user)
    assert public.model_dump() == {"id": user.id, "email": "alex@opspilot.test", "display_name": "Alex Rivera"}
    response = LoginResponse(access_token="token", expires_at=datetime.now(UTC), user=public)
    assert response.token_type == "bearer"
    assert "argon2" not in response.model_dump_json()
