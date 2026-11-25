/**
 * Theme preference. "system" means no override: CSS follows the OS setting.
 * The choice is stored in a cookie so the server can render <html data-theme>
 * correctly on the first byte (no flash, no inline script).
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_COOKIE = "opspilot-theme";
export const THEME_OPTIONS: readonly ThemePreference[] = ["system", "light", "dark"];

export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** The cookie string that stores (or, for "system", clears) the preference. */
export function themeCookie(preference: ThemePreference): string {
  const maxAge = preference === "system" ? 0 : 60 * 60 * 24 * 365;
  return `${THEME_COOKIE}=${preference}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
