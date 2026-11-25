/** Joins class names, skipping falsy values: cx("a", isOn && "b") -> "a b". */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
