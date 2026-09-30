import { useCallback, useSyncExternalStore } from "react";
import { ACCENTS, DEFAULT_LOOK, DENSITIES, LOOK_SCOPES, WALLPAPERS, isLookId, type Accent, type Density, type LookId, type LookScope, type Wallpaper } from "./looks";

/**
 * The look and its small choices (M41), kept per browser beside light and dark (src/useTheme.ts).
 * index.html applies the stored look before first paint; this module owns it from then on, and
 * App.tsx says which look the page in front of you is drawn in (data-look on the root element),
 * since Home can keep today's Launcher when the look is set for every page but Home.
 */

export interface LookChoice {
  look: LookId;
  scope: LookScope;
  accent: Accent;
  wallpaper: Wallpaper;
  density: Density;
  /** Solid panels instead of glass. */
  solid: boolean;
}

/** The keys index.html reads too. */
export const LOOK_KEYS = {
  look: "boxpilot-look",
  scope: "boxpilot-look-scope",
  accent: "boxpilot-accent",
  wallpaper: "boxpilot-wallpaper",
  density: "boxpilot-density",
  solid: "boxpilot-solid",
} as const;

export const DEFAULT_LOOK_CHOICE: LookChoice = { look: DEFAULT_LOOK, scope: "all", accent: "sea", wallpaper: "sea", density: "compact", solid: false };

function read(key: string): string | null {
  try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, value);
  } catch { /* the choice still applies for this visit */ }
}

const oneOf = <T extends string>(options: ReadonlyArray<{ id: T }>, value: string | null, fallback: T): T =>
  (options.some((option) => option.id === value) ? value as T : fallback);

export function readLookChoice(): LookChoice {
  const look = read(LOOK_KEYS.look);
  return {
    look: isLookId(look) ? look : DEFAULT_LOOK_CHOICE.look,
    scope: oneOf(LOOK_SCOPES, read(LOOK_KEYS.scope), DEFAULT_LOOK_CHOICE.scope),
    accent: oneOf(ACCENTS, read(LOOK_KEYS.accent), DEFAULT_LOOK_CHOICE.accent),
    wallpaper: oneOf(WALLPAPERS, read(LOOK_KEYS.wallpaper), DEFAULT_LOOK_CHOICE.wallpaper),
    density: oneOf(DENSITIES, read(LOOK_KEYS.density), DEFAULT_LOOK_CHOICE.density),
    solid: read(LOOK_KEYS.solid) === "1",
  };
}

/**
 * The choices that are drawn by the stylesheet, on the root element. The look itself is applied
 * by App.tsx (applyLook), because the page in front of you decides which look it is drawn in.
 */
export function applyLookChoice(choice: LookChoice, root: HTMLElement = document.documentElement) {
  root.dataset.accent = choice.accent;
  root.dataset.wallpaper = choice.wallpaper;
  if (choice.solid) root.dataset.solid = "";
  else delete root.dataset.solid;
}

/** Which look the page is drawn in, on the root element, so a sheet or dialog over it matches. */
export function applyLook(look: LookId, root: HTMLElement = document.documentElement) {
  root.dataset.look = look;
}

function persist(choice: LookChoice) {
  write(LOOK_KEYS.look, choice.look === DEFAULT_LOOK_CHOICE.look ? null : choice.look);
  write(LOOK_KEYS.scope, choice.scope === "all" ? null : choice.scope);
  write(LOOK_KEYS.accent, choice.accent === "sea" ? null : choice.accent);
  write(LOOK_KEYS.wallpaper, choice.wallpaper === "sea" ? null : choice.wallpaper);
  write(LOOK_KEYS.density, choice.density === "compact" ? null : choice.density);
  write(LOOK_KEYS.solid, choice.solid ? "1" : null);
}

let current: LookChoice | null = null;
const listeners = new Set<() => void>();

function snapshot(): LookChoice {
  if (!current) current = readLookChoice();
  return current;
}

function publish(next: LookChoice) {
  current = next;
  applyLookChoice(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab chose a look: follow it here too.
  const keys = new Set<string>(Object.values(LOOK_KEYS));
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || keys.has(event.key)) publish(readLookChoice());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Re-reads the stored choice, for when storage changed underneath this module (tests, mostly). */
export function reloadLookChoice(): LookChoice {
  current = null;
  const choice = snapshot();
  publish(choice);
  return choice;
}

export function useLook() {
  const choice = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LOOK_CHOICE);
  const update = useCallback((change: Partial<LookChoice>) => {
    const next = { ...snapshot(), ...change };
    persist(next);
    publish(next);
  }, []);
  return { ...choice, update };
}
