from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from app.runs.schemas import ToolFailure, ToolSuccess
from app.search.embeddings import HashingEmbedder
from app.tools import ToolContext, ToolRegistry, ToolSpec


class CountArgs(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    count: int


async def test_only_valid_read_calls_reach_executor() -> None:
    calls = []

    async def record(args: CountArgs, context: ToolContext) -> dict[str, int]:
        calls.append(args.count)
        return {"count": args.count}

    registry = ToolRegistry(
        ToolSpec("count", "read count", CountArgs, record),
        ToolSpec("mutate", "write count", CountArgs, record, requires_approval=True, is_read_only=False),
    )
    async with AsyncSession() as session:
        context = ToolContext(session, datetime(2026, 11, 1, tzinfo=UTC), "UTC", HashingEmbedder())
        for name, arguments, code in [
            ("unknown", {}, "UNKNOWN_TOOL"),
            ("count", {"count": "5"}, "INVALID_ARGUMENTS"),
            ("mutate", {"count": 5, "approved": True}, "INVALID_ARGUMENTS"),
            ("mutate", {"count": 5}, "APPROVAL_REQUIRED"),
        ]:
            result = await registry.dispatch(name, arguments, context)
            assert isinstance(result, ToolFailure) and result.error.code == code
        success = await registry.dispatch("count", {"count": 3}, context)

    assert calls == [3]
    assert isinstance(success, ToolSuccess) and success.data == {"count": 3}
