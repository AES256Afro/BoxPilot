import { useEffect, useState } from "react";
import { Button, Notice } from "../ui";

/*
 * Said ten minutes before the session ends (M36): a session lasts twelve hours and is not renewed,
 * and the sign-in page that follows took a half-typed form with it. The banner says when, counts
 * down by the minute, and can be put away; it does not come back for the same session.
 */

const warnMs = 10 * 60_000;

/** Whole minutes left, never below one while any time is left. */
export function minutesLeft(expiresAt: number, at: number): number {
  return Math.max(1, Math.ceil((expiresAt - at) / 60_000));
}

export function SessionEndingBanner({ expiresAt, now = Date.now }: { expiresAt: string | null | undefined; now?: () => number }) {
  const end = Date.parse(expiresAt ?? "");
  const [at, setAt] = useState(now);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(end)) return undefined;
    setAt(now());
    // Asleep until ten minutes before; then every half minute, so the count stays true.
    const untilWarning = end - warnMs - now();
    let interval = 0;
    const tick = () => setAt(now());
    const timer = window.setTimeout(() => { tick(); interval = window.setInterval(tick, 30_000); }, Math.min(2_147_000_000, Math.max(0, untilWarning)));
    // A laptop that slept through the timeout wakes with it late or not yet fired: look again when
    // the tab is seen.
    const seen = () => { if (document.visibilityState !== "hidden") tick(); };
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", seen);
    return () => { window.clearTimeout(timer); if (interval) window.clearInterval(interval); document.removeEventListener("visibilitychange", seen); window.removeEventListener("focus", seen); };
  }, [end, now]);
  if (!Number.isFinite(end) || dismissed === end) return null;
  if (end - at > warnMs || at >= end) return null;
  const minutes = minutesLeft(end, at);
  const clock = new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <Notice tone="warning" live title={`Your session ends at ${clock}, in ${minutes} minute${minutes === 1 ? "" : "s"}`}
      action={<Button variant="ghost" onClick={() => { setDismissed(end); document.getElementById("content")?.focus(); }}>Got it</Button>}>
      Sessions last twelve hours. Finish or copy anything you are typing: after {clock} BoxPilot asks you to sign in again, and a form left open is not kept.
    </Notice>
  );
}
