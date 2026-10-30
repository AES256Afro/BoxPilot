import { useEffect, useRef } from "react";
import { fetchAuthStatus, sessionEndedEvent, signedOutReasonFor, type SignedOutReason } from "./auth";

/**
 * A request found no session (M36): make sure, then hand the reason to `onEnded`, so the page goes
 * to the sign-in page and says why rather than leave every page showing "Your session has expired"
 * in red. One check at a time, however many requests failed together.
 */
export function useSessionEnded(onEnded: (reason: SignedOutReason) => void): void {
  const latest = useRef(onEnded);
  latest.current = onEnded;
  useEffect(() => {
    let checking = false;
    const listener = () => {
      if (checking) return;
      checking = true;
      void fetchAuthStatus()
        .then((status) => { if (!status.authenticated) latest.current(signedOutReasonFor(status) ?? "ended"); })
        .catch(() => undefined)
        .finally(() => { checking = false; });
    };
    window.addEventListener(sessionEndedEvent, listener);
    return () => window.removeEventListener(sessionEndedEvent, listener);
  }, []);
}
