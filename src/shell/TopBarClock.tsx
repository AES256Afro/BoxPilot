import { useEffect, useState } from "react";

/**
 * The time at the end of the top bar (M41), for the looks whose drawing has a clock there (Aqua's
 * menu bar). It is hidden until a look's skin shows `.topbar-clock`, so every other look is as it
 * was. Read aloud it is the time, which is all it is.
 */
export function TopBarClock({ now = Date.now }: { now?: () => number }) {
  const [at, setAt] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setAt(now()), 15_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const date = new Date(at);
  return (
    <time className="topbar-clock" dateTime={date.toISOString()} hidden>
      {date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
    </time>
  );
}
