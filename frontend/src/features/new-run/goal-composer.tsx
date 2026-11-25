"use client";

import { useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { ApiError, createRun } from "@/lib/api";
import { cx } from "@/lib/cx";
import type { GoalPreset } from "@/lib/presets";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PresetList } from "./preset-list";

/** The backend accepts 1 to 2000 characters after trimming. */
const MAX_GOAL_LENGTH = 2000;

/**
 * Starts a run: POST /api/runs (same-origin proxy), then opens the run console.
 * On failure the goal stays in the box and the error says what to do next.
 */
export function GoalComposer({ initialGoal = "" }: { initialGoal?: string }) {
  const router = useRouter();
  const [goal, setGoal] = useState(initialGoal);
  const [creating, setCreating] = useState(false);
  // The navigation to the new run is a transition, so "Starting…" lasts until the console shows.
  const [navigating, startNavigation] = useTransition();
  const submitting = creating || navigating;
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const nearLimit = goal.length > MAX_GOAL_LENGTH * 0.9;

  async function submit() {
    if (submitting) return;
    const trimmed = goal.trim();
    if (!trimmed) {
      setError("Enter a goal for the agent.");
      textarea.current?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const run = await createRun(trimmed);
      startNavigation(() => router.push(`/runs/${run.id}`));
      setCreating(false);
    } catch (caught) {
      setCreating(false);
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : "The run could not be started. Try again.");
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  function applyPreset(preset: GoalPreset) {
    setGoal(preset.goal);
    setError(null);
    textarea.current?.focus();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="rounded-xl border border-input-border bg-surface shadow-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
        <label htmlFor={`${id}-goal`} className="block px-4 pt-3 text-xs font-medium text-muted">
          Operations goal
        </label>
        <textarea
          ref={textarea}
          id={`${id}-goal`}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={MAX_GOAL_LENGTH}
          rows={5}
          readOnly={submitting}
          aria-invalid={error !== null && !goal.trim()}
          aria-describedby={`${id}-hint ${id}-count`}
          placeholder="Describe the task, for example: find orders over $500 that shipped late last month and draft a refund email for each."
          className="block min-h-32 w-full resize-y bg-transparent px-4 pt-1.5 pb-3 text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          <p id={`${id}-hint`} className="flex items-center gap-1.5 text-xs text-muted">
            <Kbd>Ctrl</Kbd>
            <span aria-hidden>/</span>
            <Kbd>⌘</Kbd>
            <span aria-hidden>+</span>
            <Kbd>Enter</Kbd>
            <span>to start</span>
          </p>
          <div className="flex items-center gap-3">
            <span id={`${id}-count`} className={cx("text-xs tabular-nums", nearLimit ? "text-warning" : "text-subtle")}>
              {goal.length} / {MAX_GOAL_LENGTH}
              <span className="sr-only"> characters</span>
            </span>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <ArrowUp aria-hidden />}
              {submitting ? "Starting…" : "Start run"}
            </Button>
          </div>
        </div>
      </form>

      {error ? (
        <Alert tone="danger" role="alert" title="The run was not started">
          {error}
        </Alert>
      ) : null}

      <PresetList disabled={submitting} onSelect={applyPreset} />
    </div>
  );
}
