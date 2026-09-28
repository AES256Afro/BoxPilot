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

/** The dark looks from before M33.1. The chosen one applies whenever the interface is dark. */
export const PALETTES = [
  { id: "raw", label: "Raw", description: "GitHub-dark, system fonts, minimal" },
  { id: "terminal", label: "Terminal", description: "Monospace, amber phosphor, sharp" },
  { id: "control", label: "Control", description: "Industrial gunmetal, cyan, system IDs" },
  { id: "solarized", label: "Solarized", description: "Classic solarized dark palette" },
  { id: "nord", label: "Nord", description: "Arctic north-bluish" },
  { id: "amber", label: "Amber", description: "Pure phosphor, single color" },
  { id: "contrast", label: "Contrast", description: "Maximum contrast black and white" },
  { id: "old", label: "Old", description: "Original mint and teal design" },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];

export interface ThemeChoice {
  appearance: Appearance;
  palette: PaletteId;
}

/** The keys index.html reads too. */
export const THEME_KEY = "boxpilot-theme";
export const PALETTE_KEY = "boxpilot-palette";

const DEFAULT_CHOICE: ThemeChoice = { appearance: "system", palette: "raw" };

const isAppearance = (value: unknown): value is Appearance => APPEARANCES.some((option) => option.id === value);
const isPalette = (value: unknown): value is PaletteId => PALETTES.some((option) => option.id === value);

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

/** What this browser chose. Before M33.1 boxpilot-theme held a dark palette id; that is read as the palette. */
export function readThemeChoice(): ThemeChoice {
  const theme = read(THEME_KEY);
  const palette = read(PALETTE_KEY);
  const legacyPalette = theme === "default" ? "raw" : isPalette(theme) ? theme : null;
  return {
    appearance: isAppearance(theme) ? theme : "system",
    palette: isPalette(palette) ? palette : legacyPalette ?? "raw",
  };
}

/** Sets data-theme (absent for System) and data-palette (absent for Raw) on the root element. */
export function applyThemeChoice(choice: ThemeChoice, root: HTMLElement = document.documentElement) {
  if (choice.appearance === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice.appearance);
  if (choice.palette === "raw") root.removeAttribute("data-palette");
  else root.setAttribute("data-palette", choice.palette);
}

function persist(choice: ThemeChoice) {
  // System and Raw are the defaults, so they are stored as nothing at all.
  write(THEME_KEY, choice.appearance === "system" ? null : choice.appearance);
  write(PALETTE_KEY, choice.palette === "raw" ? null : choice.palette);
}

let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();

function snapshot(): ThemeChoice {
  if (!current) {
    current = readThemeChoice();
    // Move an old palette id out of boxpilot-theme, so the key means one thing from now on.
    const stored = read(THEME_KEY);
    if (stored !== null && !isAppearance(stored)) persist(current);
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
    if (event.key === null || event.key === THEME_KEY || event.key === PALETTE_KEY) publish(readThemeChoice());
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

  const setPalette = useCallback((palette: PaletteId) => {
    const next = { ...snapshot(), palette };
    persist(next);
    publish(next);
  }, []);

  return { appearance: choice.appearance, palette: choice.palette, setAppearance, setPalette, appearances: APPEARANCES, palettes: PALETTES };
}
