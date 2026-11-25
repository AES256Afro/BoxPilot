import { useEffect, useState } from "react";
import { keepSessionAlive, sessionCapAt } from "../auth";
import { errorWords } from "../http";
import { Button, Notice } from "../ui";
import "./offline.css";

/*
 * Said ten minutes before the session ends (M36): the sign-in page that follows took a half-typed
 * form with it. A session in use is renewed (twelve hours from last use, up to three days from
 * signing in), so the notice is seen in two cases, and says which (M89): a tab left unused, which
 * "Stay signed in" keeps by making one request that renews it; or a session at its three-day cap,
 * which nothing extends. It says when, counts down by the minute, and can be put away; it does not
 * come back for the same session. It is held under the bar like the offline banner (offline.css),
 * so someone two screens down a form sees it.
 */

const warnMs = 10 * 60_000;
/** An end this close to the cap is the cap. */
const capSlackMs = 60_000;

/** Whole minutes left, never below one while any time is left. */
export function minutesLeft(expiresAt: number, at: number): number {
  return Math.max(1, Math.ceil((expiresAt - at) / 60_000));
}

type Staying = { for: number; state: "asking" } | { for: number; state: "capped" } | { for: number; state: "failed"; words: string };

export function SessionEndingBanner({ expiresAt, now = Date.now, capAt = sessionCapAt }: {
  expiresAt: string | null | undefined;
  now?: () => number;
  /** When the session can be kept to at the latest (X-BoxPilot-Session-Cap), if known. */
  capAt?: () => string | null;
}) {
  const end = Date.parse(expiresAt ?? "");
  const [at, setAt] = useState(now);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [staying, setStaying] = useState<Staying | null>(null);
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
  const cap = Date.parse(capAt() ?? "");
  const mine = staying?.for === end ? staying : null;
  // At the cap when the server said so, or when asking to stay moved nothing.
  const atCap = (Number.isFinite(cap) && Math.abs(cap - end) <= capSlackMs) || mine?.state === "capped";
  const putAway = () => { setDismissed(end); document.getElementById("content")?.focus(); };
  const stay = () => {
    setStaying({ for: end, state: "asking" });
    keepSessionAlive()
      .then((renewed) => {
        // Renewed: the app hears the new end (noteSessionRenewal) and the notice has nothing left to say.
        if (renewed && Date.parse(renewed) > end) { setStaying(null); setDismissed(end); return; }
        setStaying({ for: end, state: "capped" });
      })
      .catch((error: unknown) => setStaying({ for: end, state: "failed", words: errorWords(error, "BoxPilot could not keep the session.") }));
  };
  const title = `Your session ends at ${clock}, in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (atCap) {
    return (
      <Notice tone="warning" live className="offline-session" title={title}
        action={<Button variant="ghost" onClick={putAway}>Got it</Button>}>
        You signed in three days ago; BoxPilot asks again at {clock}. Finish or copy anything you are typing: a form left open is not kept.
      </Notice>
    );
  }
  return (
    <Notice tone="warning" live className="offline-session" title={title}
      action={<>
        <Button variant="primary" busy={mine?.state === "asking"} onClick={stay}>Stay signed in</Button>
        <Button variant="ghost" onClick={putAway}>Got it</Button>
      </>}>
      {Number.isFinite(cap) && "BoxPilot has not been used here for a while. "}A session stays open while it is in use, up to three days from signing in; after {clock} this one asks you to sign in again, and a form left open is not kept.
      {mine?.state === "failed" && <> {mine.words}</>}
    </Notice>
  );
}
