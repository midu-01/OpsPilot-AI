"""Server-owned tool metadata, typed arguments and approval-aware dispatch."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.contracts import ToolDefinition
from app.runs.schemas import ToolError, ToolFailure, ToolResult, ToolSuccess
from app.search.embeddings import Embedder


class InvalidToolArguments(ValueError):
    """The supplied arguments cannot produce a valid tool result."""


@dataclass(frozen=True)
class ToolContext:
    session: AsyncSession
    reference_time: datetime
    timezone: str
    embedder: Embedder


@dataclass(frozen=True)
class ToolSpec[Args: BaseModel]:
    name: str
    description: str
    parameters_model: type[Args]
    executor: Callable[[Args, ToolContext], Awaitable[Mapping[str, object]]]
    requires_approval: bool = False
    is_read_only: bool = True


class ToolRegistry:
    def __init__(self, *specs: ToolSpec[Any]) -> None:
        self._tools = {spec.name: spec for spec in specs}
        if len(self._tools) != len(specs):
            raise ValueError("Duplicate tool name")
        if any(spec.requires_approval == spec.is_read_only for spec in specs):
            raise ValueError("Read tools must be read-only and write tools must require approval")

    @property
    def names(self) -> list[str]:
        return list(self._tools)

    def definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                spec.name, spec.description, spec.parameters_model.model_json_schema(), spec.requires_approval
            )
            for spec in self._tools.values()
        ]

    def validate_arguments(self, name: str, arguments: dict[str, Any]) -> BaseModel:
        if name not in self._tools:
            raise KeyError(f"Unknown tool: {name}")
        model: type[BaseModel] = self._tools[name].parameters_model
        return model.model_validate(arguments)

    async def dispatch(self, name: str, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        spec = self._tools.get(name)
        if spec is None:
            return ToolFailure(error=ToolError(code="UNKNOWN_TOOL", message="Unknown tool name"))
        try:
            validated = spec.parameters_model.model_validate(arguments)
        except ValidationError as exc:
            issues = exc.errors(include_url=False, include_input=False)
            message = "; ".join(
                f"{'.'.join(map(str, issue['loc'])) or 'arguments'}: {issue['msg']}" for issue in issues
            )
            return ToolFailure(error=ToolError(code="INVALID_ARGUMENTS", message=message))
        if spec.requires_approval:
            return ToolFailure(error=ToolError(code="APPROVAL_REQUIRED", message="Human approval is required"))
        try:
            data = await spec.executor(validated, context)
        except InvalidToolArguments as exc:
            return ToolFailure(error=ToolError(code="INVALID_ARGUMENTS", message=str(exc)))
        return ToolSuccess.model_validate({"data": data})
