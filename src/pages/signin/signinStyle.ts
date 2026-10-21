import { useSyncExternalStore } from "react";

/*
 * Which sign-in screen this browser shows: the terminal (the default) or the classic glass card.
 * Kept in this browser, like the look and light or dark: the sign-in page reads it before anyone
 * has signed in, so it cannot come from the server without telling everyone who can reach the
 * port what the owner chose.
 */

export const SIGNIN_STYLES = [
  { id: "terminal", label: "Terminal" },
  { id: "classic", label: "Classic" },
] as const;

export type SigninStyle = (typeof SIGNIN_STYLES)[number]["id"];

export const DEFAULT_SIGNIN_STYLE: SigninStyle = "terminal";
const key = "boxpilot-signin-style";
const listeners = new Set<() => void>();

export function readSigninStyle(): SigninStyle {
  let value: string | null = null;
  try { value = window.localStorage?.getItem(key) ?? null; } catch { /* site data blocked: the default */ }
  return SIGNIN_STYLES.some((style) => style.id === value) ? value as SigninStyle : DEFAULT_SIGNIN_STYLE;
}

export function setSigninStyle(style: SigninStyle) {
  try { window.localStorage?.setItem(key, style); } catch { /* the choice still applies until the page reloads */ }
  current = style;
  for (const listener of listeners) listener();
}

let current: SigninStyle | null = null;
const snapshot = () => current ?? (current = readSigninStyle());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useSigninStyle(): SigninStyle {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SIGNIN_STYLE);
}

/** For tests: forget the remembered value so the next read goes back to storage. */
export function resetSigninStyleForTests() { current = null; }
