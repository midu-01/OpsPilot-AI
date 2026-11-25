import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
export type ButtonSize = "sm" | "md" | "icon";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap " +
  "transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 " +
  // aria-disabled keeps a busy button focusable, so keyboard focus is not lost mid-action.
  "aria-disabled:pointer-events-none aria-disabled:opacity-60 " +
  "[&_svg]:size-4 [&_svg]:shrink-0";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface text-fg hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger-solid text-on-solid shadow-sm hover:bg-danger-solid-hover",
  "danger-outline": "border border-danger-border bg-surface text-danger hover:bg-danger-soft",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-ui",
  md: "h-9 px-3.5 text-sm",
  icon: "size-8",
};

/** Class names for a button; also used to style <Link> elements as buttons. */
export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cx(BASE, VARIANTS[variant], SIZES[size], className);
}

/** React 19 passes `ref` as a normal prop, so ComponentProps<"button"> includes it. */
interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}
