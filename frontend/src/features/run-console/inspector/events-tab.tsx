"use client";

import { memo, useEffect, useRef } from "react";
import type { RunEvent } from "@/lib/api";
import { summarizeEvent } from "@/lib/event-log";
import { formatTime } from "@/lib/format";

const EventRow = memo(function EventRow({ event, timeZone }: { event: RunEvent; timeZone: string }) {
  const summary = summarizeEvent(event);
  return (
    <li className="grid grid-cols-[2.75rem_minmax(0,1fr)_4.25rem] items-baseline gap-2 px-4 py-1.5 font-mono text-xs">
      <span className="text-right text-subtle tabular-nums">#{event.sequence}</span>
      <span className="min-w-0">
        <span className="text-fg">{event.type}</span>
        {summary ? <span className="block truncate font-sans text-muted">{summary}</span> : null}
      </span>
      <time dateTime={event.occurred_at} className="text-right text-subtle tabular-nums">
        {formatTime(event.occurred_at, timeZone)}
      </time>
    </li>
  );
});

/**
 * The public event log: the snapshot's events, then each streamed event as it is
 * applied. The sequence number is the SSE `id`; the stream resumes after the last one.
 */
export function EventsTab({ events, timeZone }: { events: RunEvent[]; timeZone: string }) {
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);

  // Keep the newest event in view while the reader is at the bottom of the list.
  useEffect(() => {
    const node = list.current;
    if (node && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-border px-4 py-2 text-xs text-muted">
        Sequence numbers are the SSE event ids. Times are {timeZone}.
      </p>
      <ol
        ref={list}
        aria-label="Run events"
        onScroll={(event) => {
          const node = event.currentTarget;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
      >
        {events.map((event) => (
          <EventRow key={event.sequence} event={event} timeZone={timeZone} />
        ))}
      </ol>
    </div>
  );
}
