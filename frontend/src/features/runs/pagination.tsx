import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageSummary } from "@/lib/runs-page";
import { buttonClasses } from "@/components/ui/button";

function PageLink({ page, enabled, label, children }: { page: number; enabled: boolean; label: string; children: ReactNode }) {
  if (!enabled) {
    // A link cannot be disabled, so an unavailable page is plain text.
    return (
      <span aria-disabled="true" className={buttonClasses("secondary", "sm", "pointer-events-none opacity-50")}>
        {children}
      </span>
    );
  }
  return (
    <Link href={page === 1 ? "/runs" : `/runs?page=${page}`} aria-label={label} className={buttonClasses("secondary", "sm")}>
      {children}
    </Link>
  );
}

export function Pagination({ page, total, summary }: { page: number; total: number; summary: PageSummary }) {
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-ui text-muted">
      <p className="tabular-nums">
        {summary.from > 0 ? `${summary.from}–${summary.to} of ${total}` : `0 of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <PageLink page={page - 1} enabled={summary.hasPrevious} label="Previous page">
          <ChevronLeft aria-hidden />
          Previous
        </PageLink>
        <span className="px-1 tabular-nums" aria-current="page">
          Page {page} of {summary.totalPages}
        </span>
        <PageLink page={page + 1} enabled={summary.hasNext} label="Next page">
          Next
          <ChevronRight aria-hidden />
        </PageLink>
      </div>
    </nav>
  );
}
