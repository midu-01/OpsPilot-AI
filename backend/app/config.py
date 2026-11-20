"""OpsPilot backend application configuration."""

from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import HttpUrl, PositiveInt, PostgresDsn, SecretStr, UrlConstraints, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment settings shared by the API and its database pool."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: Annotated[PostgresDsn, UrlConstraints(allowed_schemes=["postgresql+asyncpg"], host_required=True)] = (
        PostgresDsn("postgresql+asyncpg://localhost:5432/opspilot")
    )
    llm_provider: Literal["openai", "fake"] = "openai"
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = "gpt-4o"
    business_timezone: str = "UTC"
    max_agent_steps: PositiveInt = 20
    max_tool_calls: PositiveInt = 40
    model_timeout_seconds: PositiveInt = 60
    max_active_run_seconds: PositiveInt = 300
    cors_allowed_origins: str = "http://localhost:3000"

    @field_validator("business_timezone")
    @classmethod
    def validate_timezone(cls, name: str) -> str:
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Use an IANA business timezone") from exc
        return name

    @field_validator("cors_allowed_origins")
    @classmethod
    def validate_origins(cls, value: str) -> str:
        origins = []
        for item in value.split(","):
            url = HttpUrl(item.strip())
            if url.username or url.password or url.query or url.fragment or url.path not in (None, "/"):
                raise ValueError("Each CORS origin must contain only a scheme, host and optional port")
            origins.append(str(url).removesuffix("/"))
        return ",".join(origins)

    @model_validator(mode="after")
    def validate_database(self) -> Self:
        if not self.database_url.path or self.database_url.path == "/" or len(self.database_url.hosts()) != 1:
            raise ValueError("Configure one PostgreSQL host and a database name")
        return self


settings = Settings()
