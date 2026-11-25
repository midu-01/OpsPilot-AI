"use client";

import { memo, useState, type ReactNode } from "react";
import Link from "next/link";
import { cx } from "@/lib/cx";
import { formatDate, formatDateTime } from "@/lib/format";
import { CopyButton } from "@/components/ui/copy-button";
import { InfoHint } from "@/components/ui/info-hint";

const LONG_GOAL_CHARS = 180;

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-fg">{children}</dd>
    </div>
  );
}

interface RunHeaderProps {
  id: string;
  goal: string;
  provider: string;
  model: string;
  referenceTime: string;
  timeZone: string;
  createdAt: string;
}

/** Memoized with plain props, so streamed events do not re-render it. */
export const RunHeader = memo(function RunHeader({ id, goal, provider, model, referenceTime, timeZone, createdAt }: RunHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const long = goal.length > LONG_GOAL_CHARS;

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
            {id.slice(0, 8)}
          </li>
        </ol>
      </nav>

      <div>
        <h1 className={cx("text-lg leading-snug font-semibold tracking-tight text-balance text-fg sm:text-xl", long && !expanded && "line-clamp-2")}>
          {goal}
        </h1>
        {long ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-1 text-ui font-medium text-link hover:underline">
            {expanded ? "Show less" : "Show full goal"}
          </button>
        ) : null}
      </div>

      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-ui">
        <MetaItem label="Run">
          <code className="font-mono" title={id}>
            {id.slice(0, 8)}
          </code>
          <CopyButton text={id} label="Copy run ID" showLabel={false} />
        </MetaItem>
        <MetaItem label="Model">
          <span className="truncate">
            {provider} / {model}
          </span>
        </MetaItem>
        <MetaItem label="Reference date">
          <span className="flex flex-wrap items-center gap-x-1.5">
            {formatDate(referenceTime, timeZone)} ({timeZone})
            <InfoHint
              label="the reference date"
              hint={`The agent reads "last month" and other relative dates from this date, in the ${timeZone} timezone.`}
            />
          </span>
        </MetaItem>
        <MetaItem label="Created">{formatDateTime(createdAt, timeZone)}</MetaItem>
      </dl>
    </header>
  );
});
