/**
 * What the agent can do. The backend has no catalog endpoint, so this mirrors
 * backend/app/tools/registry.py. Keep it in sync when a tool is added there.
 */
export interface ToolCatalogEntry {
  name: string;
  title: string;
  access: "read" | "write";
  requiresApproval: boolean;
  description: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: "date_math",
    title: "Date math",
    access: "read",
    requiresApproval: false,
    description: "Resolves windows like \"last month\" in the run's business timezone.",
  },
  {
    name: "query_orders",
    title: "Query orders",
    access: "read",
    requiresApproval: false,
    description: "Reads orders through typed filters: amount, ship dates, lateness, status. No free-form SQL.",
  },
  {
    name: "search_policies",
    title: "Search policies",
    access: "read",
    requiresApproval: false,
    description:
      "Searches the 8 policy documents by ID, keywords and meaning (full-text search plus pgvector). Returns cited excerpts and why each matched.",
  },
  {
    name: "issue_refund",
    title: "Issue refund",
    access: "write",
    requiresApproval: true,
    description: "Proposes a policy-based refund and pauses. Writes to the simulated ledger only after you approve.",
  },
];

export function catalogEntry(name: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG.find((entry) => entry.name === name);
}
