"""Configuration must not lose provider credentials when launched from backend/."""

import importlib.util
from pathlib import Path

import pytest

CONFIG_SOURCE = Path(__file__).resolve().parents[2] / "app" / "config.py"


def load_isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, backend_env: str = "") -> object:
    project = tmp_path / "project"
    backend = project / "backend"
    app = backend / "app"
    app.mkdir(parents=True)
    config_path = app / "config.py"
    config_path.write_bytes(CONFIG_SOURCE.read_bytes())
    (project / ".env").write_text("LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=root-test-key\n")
    if backend_env:
        (backend / ".env").write_text(backend_env)
    for key in ("LLM_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "GROQ_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(backend)
    spec = importlib.util.spec_from_file_location("isolated_settings", config_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_root_env_is_loaded_from_backend_working_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_isolated_config(tmp_path, monkeypatch)
    config = module.Settings()  # type: ignore[attr-defined]
    assert config.llm_provider == "anthropic"
    assert config.anthropic_api_key.get_secret_value() == "root-test-key"
    assert "root-test-key" not in repr(config)


def test_backend_override_and_process_environment_keep_precedence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_isolated_config(tmp_path, monkeypatch, "ANTHROPIC_API_KEY=backend-test-key\n")
    assert module.Settings().anthropic_api_key.get_secret_value() == "backend-test-key"  # type: ignore[attr-defined]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "process-test-key")
    assert module.Settings().anthropic_api_key.get_secret_value() == "process-test-key"  # type: ignore[attr-defined]
