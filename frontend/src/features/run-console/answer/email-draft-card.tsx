import { Mail } from "lucide-react";
import { draftToPlainText, type EmailDraft } from "@/lib/email-drafts";
import { CopyButton } from "@/components/ui/copy-button";
import { Markdown } from "@/components/markdown/markdown";

export function EmailDraftCard({ draft }: { draft: EmailDraft }) {
  return (
    <article aria-label={draft.title} className="overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="flex items-center gap-2 text-ui font-semibold text-fg">
          <Mail aria-hidden className="size-4 text-muted" />
          {draft.title}
        </span>
        <CopyButton text={draftToPlainText(draft)} label="Copy email" />
      </header>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-ui">
        <dt className="text-muted">To</dt>
        <dd className="font-mono break-all text-fg">{draft.to ?? "—"}</dd>
        <dt className="text-muted">Subject</dt>
        <dd className="font-medium text-fg">{draft.subject ?? "—"}</dd>
      </dl>
      <div className="px-3 py-3">
        <Markdown text={draft.body} />
      </div>
    </article>
  );
}
