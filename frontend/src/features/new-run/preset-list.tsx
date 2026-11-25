"use client";

import { Eye, ShieldAlert } from "lucide-react";
import { GOAL_PRESETS, type GoalPreset } from "@/lib/presets";
import { Badge } from "@/components/ui/badge";

interface PresetListProps {
  disabled: boolean;
  onSelect: (preset: GoalPreset) => void;
}

/** Demo goals. Choosing one only fills the composer; nothing runs until you start it. */
export function PresetList({ disabled, onSelect }: PresetListProps) {
  return (
    <section aria-labelledby="presets-heading">
      <h2 id="presets-heading" className="text-sm font-semibold text-fg">
        Try a scenario
      </h2>
      <p className="mt-0.5 text-ui text-muted">Fills the box above. You can edit the goal before starting.</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {GOAL_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(preset)}
              className="flex h-full w-full flex-col items-start gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2 disabled:opacity-50"
            >
              <span className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">{preset.title}</span>
                {preset.effect === "needs-approval" ? (
                  <Badge tone="warning">
                    <ShieldAlert aria-hidden />
                    Needs approval
                  </Badge>
                ) : (
                  <Badge tone="info">
                    <Eye aria-hidden />
                    Read-only
                  </Badge>
                )}
              </span>
              <span className="text-ui text-muted">{preset.outcome}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
