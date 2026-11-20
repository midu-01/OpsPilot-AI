"""Built-in tool catalog for the run service."""

from app.tools import ToolRegistry, date_math, issue_refund, query_orders, search_policies

_registry = ToolRegistry(query_orders.spec, search_policies.spec, date_math.spec, issue_refund.spec)


def get_registry() -> ToolRegistry:
    return _registry
