import { useEffect, useState } from "react";
import { openActivity } from "../../activityEvents";
import type { LookBarProps } from "../LookBar";

/*
 * What Phosphor adds to the shell's bar on every page (M41; docs/design-directions/05-looks.html,
 * M.phosphor): the version and the time at the right end of the terminal's top line, and the keys
 * the bar's own controls are written with, "(/)search" and "(a)ctivity". Pressing either key does
 * what its control does, wherever the keyboard is not in a field or a dialog.
 */

/** Opens the command bar, as Ctrl K does. */
export const openCommandBar = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

/**
 * Where a keypress is someone typing, or belongs to what is open, and no key of this look answers:
 * a field, anything editable (contenteditable="", "true", "plaintext-only"), a dialog or a menu.
 */
export const typingPlaces = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='menu']";

/** The keys the bar answers to on every page; Home's fixes take any other letter. */
export const barKeys = new Set(["/", "a"]);

export default function PhosphorBar({ now = Date.now }: LookBarProps) {
  const [at, setAt] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setAt(now()), 15_000);
    return () => window.clearInterval(timer);
  }, [now]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(typingPlaces)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === "/") { event.preventDefault(); openCommandBar(); }
      else if (event.key.toLowerCase() === "a") { event.preventDefault(); openActivity(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return <span className="phosphor-topline">boxpilot {__BOXPILOT_VERSION__} :: <time dateTime={new Date(at).toISOString()}>{time}</time></span>;
}
