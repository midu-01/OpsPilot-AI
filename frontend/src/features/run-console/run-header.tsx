"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatDate, formatDateTime } from "@/lib/format";
import type { RunState } from "@/lib/run-events";
import { CopyButton } from "@/components/ui/copy-button";
import { Tooltip } from "@/components/ui/tooltip";

const LONG_GOAL_CHARS = 180;

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-fg">{children}</dd>
    </div>
  );
}

export function RunHeader({ state }: { state: RunState }) {
  const [expanded, setExpanded] = useState(false);
  const long = state.goal.length > LONG_GOAL_CHARS;
  const timeZone = state.business_timezone;

  return (
    <header className="space-y-3">
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1.5 text-ui text-muted">
          <li>
            <Link href="/runs" className="rounded hover:text-fg">
              Runs
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="font-mono">
            {state.id.slice(0, 8)}
          </li>
        </ol>
      </nav>

      <div>
        <h1 className={cx("text-lg leading-snug font-semibold tracking-tight text-balance text-fg sm:text-xl", long && !expanded && "line-clamp-2")}>
          {state.goal}
        </h1>
        {long ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-1 text-ui font-medium text-link hover:underline">
            {expanded ? "Show less" : "Show full goal"}
          </button>
        ) : null}
      </div>

      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-ui">
        <MetaItem label="Run">
          <code className="font-mono" title={state.id}>
            {state.id.slice(0, 8)}
          </code>
          <CopyButton text={state.id} label="Copy run ID" showLabel={false} />
        </MetaItem>
        <MetaItem label="Model">
          <span className="truncate">
            {state.provider} / {state.model}
          </span>
        </MetaItem>
        <MetaItem label="Reference date">
          {formatDate(state.reference_time, timeZone)} ({timeZone})
          <Tooltip content={`The agent reads "last month" and other relative dates from this date, in the ${timeZone} timezone.`}>
            <button type="button" aria-label="About the reference date" className="grid size-6 place-items-center rounded text-subtle hover:text-fg">
              <Info aria-hidden className="size-3.5" />
            </button>
          </Tooltip>
        </MetaItem>
        <MetaItem label="Created">{formatDateTime(state.created_at, timeZone)}</MetaItem>
      </dl>
    </header>
  );
}
