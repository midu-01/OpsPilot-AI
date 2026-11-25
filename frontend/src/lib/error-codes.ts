import { humanizeStatus } from "./status.ts";

/**
 * Short titles for the error codes the backend can send (run.failed, tool.failed and
 * failed tool results). The backend message is always shown next to the title, so
 * an unknown code still reads sensibly.
 */
const TITLES: Record<string, string> = {
  // Run level
  MAX_AGENT_STEPS: "Turn limit reached",
  MAX_TOOL_CALLS: "Tool call limit reached",
  MAX_ACTIVE_RUN_SECONDS: "Time limit reached",
  MODEL_ERROR: "Model error",
  MODEL_TIMEOUT: "Model timed out",
  EMPTY_MODEL_OUTPUT: "Empty model response",
  PROVIDER_CONFIGURATION_ERROR: "Model provider not configured",
  PROCESS_RESTARTED: "Interrupted by a server restart",
  EXECUTION_ERROR: "Unexpected execution error",
  CANCELLED: "Stopped by user",
  // Tool level
  INVALID_ARGUMENTS: "Invalid arguments",
  UNKNOWN_TOOL: "Unknown tool",
  TOOL_ERROR: "Tool error",
  REFUND_INELIGIBLE: "Refund not eligible",
  APPROVAL_REJECTED: "Rejected by reviewer",
  APPROVAL_CANCELLED: "Approval cancelled",
  APPROVAL_CHANGED: "Proposal changed after approval",
  APPROVAL_REQUIRED: "Approval required",
  APPROVAL_EXISTS: "Proposal already exists",
  REFUND_DATA_CHANGED: "Order data changed after approval",
  RUN_CANCELLED: "Run was stopped",
};

export function errorTitle(code: string | null | undefined): string {
  if (!code) return "Unexpected error";
  return TITLES[code] ?? humanizeStatus(code.toLowerCase());
}
