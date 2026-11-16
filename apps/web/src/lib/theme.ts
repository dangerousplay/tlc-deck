import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "tlc-theme";

export function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function readTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme) || "system";
  } catch {
    return "system";
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);
  return [theme, setTheme];
}

export const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
