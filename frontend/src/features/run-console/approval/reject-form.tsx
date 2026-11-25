"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

const MAX_REASON_LENGTH = 2000;

interface RejectFormProps {
  submitting: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

/** A rejection needs a non-blank reason; the backend returns it to the agent as the tool result. */
export function RejectForm({ submitting, onSubmit, onCancel }: RejectFormProps) {
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const blank = reason.trim().length === 0;
  const showError = attempted && blank;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (!blank) onSubmit(reason.trim());
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
        id={`${id}-reason`}
        autoFocus
        rows={3}
        maxLength={MAX_REASON_LENGTH}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        aria-invalid={showError}
        aria-describedby={`${id}-help ${showError ? `${id}-error` : ""}`.trim()}
        disabled={submitting}
        className="block w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle aria-[invalid=true]:border-danger"
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
        <Button type="submit" variant="danger" disabled={submitting}>
          {submitting ? "Rejecting…" : "Reject refund"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
