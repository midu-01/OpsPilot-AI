import type { RunSummary } from "./api.ts";
import { isTerminalStatus } from "./status.ts";

/** Paging for the runs list. GET /runs accepts page (1 to 2^31 - 1) and page_size (1 to 100). */
export const RUNS_PAGE_SIZE = 20;
const MAX_PAGE = 2_147_483_647;

/** Reads ?page= safely: anything that is not a positive integer becomes page 1. */
export function parsePageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}

export interface PageSummary {
  /** 1-based index of the first run on this page; 0 when the page is empty. */
  from: number;
  to: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** The requested page is beyond the last page. */
  outOfRange: boolean;
}

export function summarizePage(page: number, pageSize: number, total: number, shown: number): PageSummary {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = shown > 0 ? (page - 1) * pageSize + 1 : 0;
  return {
    from,
    to: shown > 0 ? from + shown - 1 : 0,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    outOfRange: total > 0 && page > totalPages,
  };
}

/** Runs still queued, running, waiting for approval or stopping. */
export function countUnfinished(runs: RunSummary[]): number {
  return runs.filter((run) => !isTerminalStatus(run.status)).length;
}
