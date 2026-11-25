import { CopyButton } from "@/components/ui/copy-button";

/** Pretty-printed JSON. React escapes the text, so untrusted values are safe to show. */
export function JsonBlock({ value, label = "JSON" }: { value: unknown; label?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <div className="absolute top-1.5 right-1.5">
        <CopyButton text={text} label={`Copy ${label}`} showLabel={false} />
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-96 overflow-auto rounded-md border border-border bg-surface-2 p-3 pr-11 font-mono text-xs leading-relaxed text-fg"
      >
        {text}
      </pre>
    </div>
  );
}
