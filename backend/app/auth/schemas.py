"""Sign-in request and response bodies. Nothing here ever carries a password hash or a token hash."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, SecretStr, StringConstraints


def _require_at_sign(email: str) -> str:
    if "@" not in email:
        raise ValueError("Enter an email address")
    return email


# Stored emails are trimmed and lower-case (a CHECK constraint), so " Alex@OpsPilot.test" finds the same account.
type Email = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=254),
    AfterValidator(_require_at_sign),
]


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    # SecretStr keeps the password out of repr() and logs; the length cap bounds the hashing work per request.
    password: Annotated[SecretStr, Field(min_length=1, max_length=128)]


class UserPublic(BaseModel):
    """What the console may show about a user."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    display_name: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: AwareDatetime
    user: UserPublic
