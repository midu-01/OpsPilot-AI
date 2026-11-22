"""Resolve a run's stored provider and model using server-side configuration."""

from app.agent.contracts import FakeProvider, LLMProvider, ModelEvent, ModelEventType
from app.agent.providers import make_provider
from app.agent.usage import Pricing
from app.config import settings


class ProviderConfigurationError(RuntimeError):
    """No credential or supported backend exists for this run."""


def resolve_run_provider(provider_name: str, model: str) -> tuple[LLMProvider, Pricing | None]:
    if provider_name == "fake":
        if model == "scripted":
            return FakeProvider(
                [
                    [
                        ModelEvent(
                            ModelEventType.text_delta, text="Offline demo completed using the scripted provider."
                        ),
                        ModelEvent(ModelEventType.turn_complete),
                    ]
                ]
            ), None
        from app.agent.scenario_provider import ScenarioProvider

        return ScenarioProvider(), None

    endpoints = {
        "anthropic": ("https://api.anthropic.com/v1", settings.anthropic_api_key),
        "groq": ("https://api.groq.com/openai/v1", settings.groq_api_key),
    }
    if provider_name not in endpoints:
        raise ProviderConfigurationError("Unsupported provider.")
    base_url, secret = endpoints[provider_name]
    if not secret.get_secret_value().strip():
        raise ProviderConfigurationError("Missing credential for the selected provider.")
    rates = settings.model_prices.get(f"{provider_name}/{model}")
    pricing = Pricing(rates.input_usd, rates.output_usd, rates.cached_input_usd) if rates else None
    return make_provider(provider_name, model, secret.get_secret_value(), base_url), pricing
