import { useCallback, useEffect, useState } from "react";

export const THEMES = [
  { id: "raw", label: "Raw", description: "GitHub-dark, system fonts, minimal" },
  { id: "terminal", label: "Terminal", description: "Monospace, amber phosphor, sharp" },
  { id: "control", label: "Control", description: "Industrial gunmetal, cyan, system IDs" },
  { id: "solarized", label: "Solarized", description: "Classic solarized dark palette" },
  { id: "nord", label: "Nord", description: "Arctic north-bluish" },
  { id: "amber", label: "Amber", description: "Pure phosphor, single color" },
  { id: "contrast", label: "Contrast", description: "Maximum contrast black and white" },
  { id: "old", label: "Old", description: "Original mint and teal design" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "boxpilot-theme";

function getStoredTheme(): ThemeId {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  return "raw";
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(getStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    localStorage.setItem(STORAGE_KEY, id);
    setThemeState(id);
  }, []);

  return { theme, setTheme, themes: THEMES };
}
