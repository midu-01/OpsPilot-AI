"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

const MAX_REASON_LENGTH = 2000;

interface RejectFormProps {
  /** A decision is being sent (approve or reject); the form waits. */
  busy: boolean;
  /** This form's rejection is the one being sent. */
  rejecting: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

/** A rejection needs a non-blank reason; the backend returns it to the agent as the tool result. */
export function RejectForm({ busy, rejecting, onSubmit, onCancel }: RejectFormProps) {
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const blank = reason.trim().length === 0;
  const showError = attempted && blank;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (blank) {
      textarea.current?.focus(); // the field announces its error via aria-describedby
      return;
    }
    onSubmit(reason.trim());
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-2 rounded-md border border-border bg-surface-2 p-3">
      <label htmlFor={`${id}-reason`} className="block text-sm font-medium text-fg">
        Why are you rejecting this refund?
      </label>
      <p id={`${id}-help`} className="text-ui text-muted">
        The agent receives your reason as the result of the refund call and responds to it.
      </p>
      <textarea
        ref={textarea}
        id={`${id}-reason`}
        autoFocus
        rows={3}
        maxLength={MAX_REASON_LENGTH}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        aria-invalid={showError}
        aria-describedby={`${id}-help ${showError ? `${id}-error` : ""}`.trim()}
        readOnly={busy}
        className="block w-full resize-y rounded-md border border-input-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle aria-[invalid=true]:border-danger"
        placeholder="For example: The customer asked for store credit instead."
      />
      <div className="flex items-start justify-between gap-3 text-xs">
        {showError ? (
          <p id={`${id}-error`} className="text-danger">
            Enter a reason to reject the refund.
          </p>
        ) : (
          <span />
        )}
        <span className="tabular-nums text-muted">
          {reason.length} / {MAX_REASON_LENGTH}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" aria-disabled={busy}>
          {rejecting ? "Rejecting…" : "Reject refund"}
        </Button>
        <Button variant="ghost" onClick={onCancel} aria-disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
