"use client";

import { useId, useState } from "react";
import { Info } from "lucide-react";

/**
 * A small "i" button that shows an explanation underneath when pressed. Unlike a
 * hover tooltip it works with touch, mouse and keyboard alike.
 */
export function InfoHint({ label, hint }: { label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="-m-1 inline-grid size-6 shrink-0 place-items-center rounded text-subtle hover:text-fg"
      >
        <Info aria-hidden className="size-3.5" />
      </button>
      <span id={id} hidden={!open} className="mt-1 block basis-full text-xs font-normal text-muted">
        {hint}
      </span>
    </>
  );
}
