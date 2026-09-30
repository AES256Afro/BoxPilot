import { useEffect, useState } from "react";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 7:41 AM", as a menu bar says it. */
export function clockWords(date: Date): string {
  const hours = date.getHours();
  return `${days[date.getDay()]} ${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

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
  return <time className="topbar-clock" dateTime={date.toISOString()} hidden>{clockWords(date)}</time>;
}
