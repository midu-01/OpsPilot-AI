from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.agent import runtime
from app.agent.contracts import ModelEventType
from app.config import Settings


def test_groq_settings_keep_credentials_and_pricing_bound_to_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    config = Settings.model_validate(
        {
            "llm_provider": "groq",
            "groq_api_key": "test-only",
            "model_prices": {
                "groq/openai/gpt-oss-20b": {"input_usd": "0.075", "output_usd": "0.3", "cached_input_usd": 0}
            },
        }
    )
    monkeypatch.setattr(runtime, "settings", config)
    assert config.selected_model == "openai/gpt-oss-20b"
    _, pricing = runtime.resolve_run_provider("groq", config.selected_model)
    assert pricing and pricing.input_usd == Decimal("0.075")
    assert runtime.resolve_run_provider("groq", "another-model")[1] is None
    with pytest.raises(runtime.ProviderConfigurationError):
        runtime.resolve_run_provider("openai", config.selected_model)


def test_omniroute_uses_api_base_without_editor_url_fragment() -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate({"omniroute_base_url": "http://localhost:20128/v1/chat/completions#editor"})


async def test_fake_runs_have_independent_scripts() -> None:
    for _ in range(2):
        fake, _ = runtime.resolve_run_provider("fake", "scripted")
        assert [e.type async for e in fake.stream_turn([], [])] == [
            ModelEventType.text_delta,
            ModelEventType.turn_complete,
        ]
