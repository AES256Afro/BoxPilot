import { useCallback, useSyncExternalStore } from "react";

/*
 * Settings' sections (M33.13, M41): the tabs of the Settings page, and in the sidebar looks the
 * sidebar's own list while Settings is open, as a Mac's System Settings lists its panes (the
 * Appearance drawing in docs/design-directions/05-looks.html). One list and one open section for
 * both, kept in the address (?view=settings&tab=appearance), so a link or a reload opens it.
 */

export type SettingsSection = "account" | "people" | "notifications" | "approvals" | "sso" | "credentials" | "appearance";

export interface SectionInfo {
  id: SettingsSection;
  label: string;
  /** Where the sidebar lists it: the person's own, or the whole server's (the owner's). */
  group: "You" | "This server";
  ownerOnly: boolean;
}

export const SECTIONS: readonly SectionInfo[] = [
  { id: "account", label: "Account & sign-in", group: "You", ownerOnly: false },
  { id: "appearance", label: "Appearance", group: "You", ownerOnly: false },
  { id: "people", label: "People", group: "This server", ownerOnly: true },
  { id: "notifications", label: "Notifications", group: "This server", ownerOnly: true },
  { id: "approvals", label: "Approvals", group: "This server", ownerOnly: true },
  { id: "sso", label: "Single sign-on", group: "This server", ownerOnly: true },
  { id: "credentials", label: "Credentials", group: "This server", ownerOnly: true },
];

/** The sections a role sees, in the tabs' order: the account first, Appearance last. */
export function sectionsFor(role: string): SectionInfo[] {
  const order: SettingsSection[] = ["account", "people", "notifications", "approvals", "sso", "credentials", "appearance"];
  return order.map((id) => SECTIONS.find((section) => section.id === id)!).filter((section) => role === "owner" || !section.ownerOnly);
}

const PARAM = "tab";
const FALLBACK: SettingsSection = "account";
const listeners = new Set<() => void>();

function read(): SettingsSection {
  if (typeof window === "undefined") return FALLBACK;
  const found = new URLSearchParams(window.location.search).get(PARAM);
  return SECTIONS.some((section) => section.id === found) ? (found as SettingsSection) : FALLBACK;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Opens a section: in the address, and in whichever of the page and the sidebar shows it. */
export function openSection(next: SettingsSection) {
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    if (next === FALLBACK) url.searchParams.delete(PARAM); else url.searchParams.set(PARAM, next);
    window.history.replaceState(window.history.state, "", url);
  }
  for (const listener of listeners) listener();
}

/** The open section, from the address; a section this role cannot see opens the account. */
export function useSettingsSection(role: string): [SettingsSection, (next: SettingsSection) => void] {
  const found = useSyncExternalStore(subscribe, read, () => FALLBACK);
  const visible = sectionsFor(role).some((section) => section.id === found) ? found : FALLBACK;
  const set = useCallback((next: SettingsSection) => openSection(next), []);
  return [visible, set];
}
