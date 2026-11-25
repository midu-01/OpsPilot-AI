"use client";

import { memo, useMemo, useState } from "react";
import { splitEmailDrafts } from "@/lib/email-drafts";
import { plural } from "@/lib/format";
import { cx } from "@/lib/cx";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Markdown } from "@/components/markdown/markdown";
import { EmailDraftCard } from "./email-draft-card";

type View = "formatted" | "markdown";

/** Long answers show the first drafts and collapse the rest behind a button. */
const VISIBLE_DRAFTS = 3;

/**
 * The agent's final answer. Email drafts (## **Draft Email N** sections) become
 * cards with their own copy button; everything else renders as safe markdown.
 */
export const FinalAnswer = memo(function FinalAnswer({ text }: { text: string }) {
  const [view, setView] = useState<View>("formatted");
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const answer = useMemo(() => splitEmailDrafts(text), [text]);
  const drafts = answer ? (showAllDrafts ? answer.drafts : answer.drafts.slice(0, VISIBLE_DRAFTS)) : [];
  const hiddenDrafts = answer ? answer.drafts.length - drafts.length : 0;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div role="group" aria-label="Answer format" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
          {(["formatted", "markdown"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={cx(
                "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                view === option ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              {option === "formatted" ? "Formatted" : "Markdown"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {answer ? <span className="text-xs text-muted">{plural(answer.drafts.length, "email draft")}</span> : null}
          <CopyButton text={text} label={answer ? "Copy all" : "Copy"} />
        </div>
      </div>

      <div className="p-3 sm:p-4">
        {view === "markdown" ? (
          <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg">{text}</pre>
        ) : answer ? (
          <div className="space-y-3">
            {answer.intro ? <Markdown text={answer.intro} /> : null}
            {drafts.map((draft, index) => (
              <EmailDraftCard key={`${index}-${draft.title}`} draft={draft} />
            ))}
            {answer.drafts.length > VISIBLE_DRAFTS ? (
              <Button variant="secondary" size="sm" onClick={() => setShowAllDrafts(!showAllDrafts)} aria-expanded={showAllDrafts}>
                {showAllDrafts ? "Show fewer drafts" : `Show ${plural(hiddenDrafts, "more draft")}`}
              </Button>
            ) : null}
            {answer.summary ? (
              <div className="rounded-md border border-info-border bg-info-soft px-3 py-2">
                <p className="text-xs font-semibold text-info">Summary</p>
                <Markdown text={answer.summary} className="mt-1" />
              </div>
            ) : null}
          </div>
        ) : (
          <Markdown text={text} />
        )}
      </div>
    </div>
  );
});
