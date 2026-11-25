"use client";

import { Info } from "lucide-react";
import type { RunState } from "@/lib/run-events";
import { budgetItems } from "@/lib/run-metrics";
import { cx } from "@/lib/cx";
import { Meter } from "@/components/ui/meter";
import { Tooltip } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";

const TICK_MS = 100;

/** Turns and tool calls against their limits, plus tokens, cost and active time. */
export function BudgetMeters({ state }: { state: RunState }) {
  // Tick only while the stopwatch runs; this component is the only one that re-renders.
  const now = useNow(state.active_since !== null ? TICK_MS : null);
  const items = budgetItems(state, now);

  return (
    <dl aria-label="Budget" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
      {items.map((item, index) => (
        <div key={item.key} className={cx("bg-surface px-3 py-2.5", index === items.length - 1 && "col-span-2 sm:col-span-1")}>
          <dt className="flex items-center gap-1 text-xs text-muted">
            {item.label}
            {item.hint ? (
              <Tooltip content={item.hint}>
                <button type="button" aria-label={`About ${item.label.toLowerCase()}: ${item.hint}`} className="-m-1 grid size-6 place-items-center rounded text-subtle hover:text-fg">
                  <Info aria-hidden className="size-3" />
                </button>
              </Tooltip>
            ) : null}
          </dt>
          <dd className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-fg tabular-nums">{item.value}</span>
            {item.flag ? <span className="text-[11px] font-medium text-warning">{item.flag}</span> : null}
          </dd>
          {item.meter ? (
            <dd className="mt-2">
              <Meter label={item.label} value={item.meter.value} max={item.meter.max} valueText={item.meter.text} />
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
