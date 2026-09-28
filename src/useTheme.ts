import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Light or dark (M33.1, ADR-004). The interface follows the device unless this browser chose
 * otherwise; the choice is kept per browser in localStorage. index.html applies it before first
 * paint, and this module owns it from then on, so the top bar and Settings always agree.
 */
export const APPEARANCES = [
  { id: "system", label: "System", description: "Follows this device's light or dark setting" },
  { id: "light", label: "Light", description: "Always light" },
  { id: "dark", label: "Dark", description: "Always dark" },
] as const;

export type Appearance = (typeof APPEARANCES)[number]["id"];

export interface ThemeChoice {
  appearance: Appearance;
}

/** The key index.html reads too. */
export const THEME_KEY = "boxpilot-theme";
/**
 * Where a dark palette was kept until the eight old palettes were retired. A browser that chose
 * one is cleaned up once, and gets the one dark look BoxPilot has now.
 */
export const RETIRED_PALETTE_KEY = "boxpilot-palette";

const DEFAULT_CHOICE: ThemeChoice = { appearance: "system" };

const isAppearance = (value: unknown): value is Appearance => APPEARANCES.some((option) => option.id === value);

// localStorage is not guaranteed: some browsers throw on access with site data blocked, and test
// environments may not provide it. No stored choice is a normal state either way.
function read(key: string): string | null {
  try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, value);
  } catch { /* the choice still applies for this visit */ }
}

/** What this browser chose. Anything else in boxpilot-theme (an old palette id) means System. */
export function readThemeChoice(): ThemeChoice {
  const theme = read(THEME_KEY);
  return { appearance: isAppearance(theme) ? theme : "system" };
}

/** Sets data-theme on the root element, absent for System. A data-palette left from before is removed. */
export function applyThemeChoice(choice: ThemeChoice, root: HTMLElement = document.documentElement) {
  if (choice.appearance === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice.appearance);
  root.removeAttribute("data-palette");
}

function persist(choice: ThemeChoice) {
  // System is the default, so it is stored as nothing at all.
  write(THEME_KEY, choice.appearance === "system" ? null : choice.appearance);
}

let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function snapshot(): ThemeChoice {
  if (!current) {
    current = readThemeChoice();
    // Clear what the retired palettes left: their key, and a palette id kept under boxpilot-theme.
    const stored = read(THEME_KEY);
    if (stored !== null && !isAppearance(stored)) persist(current);
    if (read(RETIRED_PALETTE_KEY) !== null) write(RETIRED_PALETTE_KEY, null);
  }
  return current;
}

function publish(next: ThemeChoice) {
  current = next;
  applyThemeChoice(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the choice: follow it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_KEY) publish(readThemeChoice());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Re-reads the stored choice, for when storage changed underneath this module (tests, mostly). */
export function reloadThemeChoice(): ThemeChoice {
  current = null;
  const choice = snapshot();
  publish(choice);
  return choice;
}

export function useTheme() {
  const choice = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_CHOICE);

  useEffect(() => { applyThemeChoice(choice); }, [choice]);

  const setAppearance = useCallback((appearance: Appearance) => {
    const next = { ...snapshot(), appearance };
    persist(next);
    publish(next);
  }, []);

  return { appearance: choice.appearance, setAppearance, appearances: APPEARANCES };
}
