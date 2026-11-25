"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";

interface CopyButtonProps {
  text: string;
  /** Visible label, and the accessible name when the label is hidden. */
  label?: string;
  showLabel?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({ text, label = "Copy", showLabel = true, variant = "ghost", size = "sm", className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");

  // Return to the idle label two seconds after a copy attempt.
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const visibleLabel = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <Button
      variant={variant}
      size={showLabel ? size : "icon"}
      onClick={copy}
      aria-label={showLabel ? undefined : label}
      className={className}
    >
      {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      {showLabel ? <span>{visibleLabel}</span> : null}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""}
      </span>
    </Button>
  );
}
