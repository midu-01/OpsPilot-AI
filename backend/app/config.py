"""OpsPilot backend application configuration."""

from decimal import Decimal
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    Field,
    HttpUrl,
    PositiveInt,
    PostgresDsn,
    SecretStr,
    UrlConstraints,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict


class ModelRates(BaseModel):
    """USD per million tokens, keyed by the provider and model in MODEL_PRICES."""

    input_usd: Decimal = Field(ge=0, allow_inf_nan=False)
    output_usd: Decimal = Field(ge=0, allow_inf_nan=False)
    cached_input_usd: Decimal = Field(ge=0, allow_inf_nan=False)


class Settings(BaseSettings):
    """Environment settings shared by the API and its database pool."""

    model_config = SettingsConfigDict(env_file=".env", env_ignore_empty=True, extra="ignore", hide_input_in_errors=True)

    database_url: Annotated[PostgresDsn, UrlConstraints(allowed_schemes=["postgresql+asyncpg"], host_required=True)] = (
        PostgresDsn("postgresql+asyncpg://localhost:5432/opspilot")
    )
    llm_provider: Literal["groq", "fake"] = "groq"
    groq_api_key: SecretStr = SecretStr("")
    groq_model: str = "openai/gpt-oss-20b"
    model_prices: dict[str, ModelRates] = Field(default_factory=dict)
    business_timezone: str = "UTC"
    max_agent_steps: PositiveInt = 20
    max_tool_calls: PositiveInt = 40
    model_timeout_seconds: PositiveInt = 60
    max_active_run_seconds: PositiveInt = 300
    cors_allowed_origins: str = "http://localhost:3000"

    @property
    def selected_model(self) -> str:
        return {
            "groq": self.groq_model,
            "fake": "scripted",
        }[self.llm_provider]

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
