"use client";

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_OPTIONS, themeCookie, type ThemePreference } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

const LABELS: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };
const ICONS = { system: Monitor, light: Sun, dark: Moon };

function nextPreference(current: ThemePreference): ThemePreference {
  return THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length];
}

/**
 * Cycles System -> Light -> Dark. The choice goes into a cookie that layout.tsx reads,
 * and onto <html data-theme> right away; "System" removes the override.
 */
export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [theme, setTheme] = useState<ThemePreference>(initial);
  const next = nextPreference(theme);
  const Icon = ICONS[theme];

  function switchTheme() {
    setTheme(next);
    document.cookie = themeCookie(next, window.location.protocol === "https:");
    if (next === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
  }

  return (
    <Tooltip content={`Theme: ${LABELS[theme]}`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={switchTheme}
        aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      >
        <Icon aria-hidden />
      </Button>
    </Tooltip>
  );
}
