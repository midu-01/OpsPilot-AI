import { CalendarRange, Database, FileSearch, ReceiptText, Wrench } from "lucide-react";
import type { ToolViewDefinition } from "./types";
import { DateMathView } from "./views/date-math-view";
import { IssueRefundView } from "./views/issue-refund-view";
import { JsonResultView } from "./views/json-result-view";
import { QueryOrdersView } from "./views/query-orders-view";
import { SearchPoliciesView } from "./views/search-policies-view";

/**
 * Result views by tool name. To add a view for a new tool: create one file in
 * ./views that renders ToolViewProps, then add one entry here. Tools without an
 * entry get the JSON fallback, so a new backend tool never breaks the console.
 */
export const TOOL_VIEWS: Record<string, ToolViewDefinition> = {
  date_math: { icon: CalendarRange, ResultView: DateMathView },
  query_orders: { icon: Database, ResultView: QueryOrdersView },
  search_policies: { icon: FileSearch, ResultView: SearchPoliciesView },
  issue_refund: { icon: ReceiptText, ResultView: IssueRefundView },
};

const FALLBACK_VIEW: ToolViewDefinition = { icon: Wrench, ResultView: JsonResultView };

export function getToolView(name: string): ToolViewDefinition {
  return TOOL_VIEWS[name] ?? FALLBACK_VIEW;
}
