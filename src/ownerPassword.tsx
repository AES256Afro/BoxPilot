import { createContext, useCallback, useContext, useEffect, useState } from "react";

/*
 * The owner's password on a settings change (people, where alerts go, the approval mode, where
 * backups go). The server takes those without it inside the short window a password already opened
 * on this session, the same window high-risk approvals use, and answers 401
 * `reauthentication_required` once the window has lapsed. So the forms ask for it only when it is
 * needed: inside the window they say until when none is, and send none; a change the server sends
 * back for the password shows the field and is sent again with it.
 *
 * With approvals set to ask every time there is no window: the field always shows.
 */

export interface SessionFacts {
  /** ISO time until which a password already typed stands (the bar's "No password until"). */
  elevatedUntil: string | null;
  /** Who is signed in, so a list of people knows which row is theirs. */
  accountId: string | null;
}

const SessionContext = createContext<SessionFacts>({ elevatedUntil: null, accountId: null });

/** The shell gives every page the session's facts; a page drawn without it asks for the password, as before. */
export const SessionProvider = SessionContext.Provider;

export const useSessionFacts = (): SessionFacts => useContext(SessionContext);

/** The server's "the password, please": the window lapsed, or there never was one. */
export function passwordAsked(response: Response, body: { code?: string } | null | undefined): boolean {
  return response.status === 401 && body?.code === "reauthentication_required";
}

export const passwordAskedWords = "Type your password to continue.";

export interface OwnerPassword {
  /** No password is needed right now: hide the field, send none. */
  free: boolean;
  /** "No password needed until 14:05.", while `free`. */
  note: string | null;
  /** The server sent a change back for the password: say so beside the field. */
  asked: boolean;
  /** Call when a change sent without a password came back `reauthentication_required`. */
  refused: () => void;
}

export function useOwnerPassword({ now = Date.now }: { now?: () => number } = {}): OwnerPassword {
  const { elevatedUntil } = useSessionFacts();
  const until = elevatedUntil ? Date.parse(elevatedUntil) : Number.NaN;
  const [clock, setClock] = useState(() => now());
  const [mode, setMode] = useState<"tiered" | "always-password" | null>(null);
  const [asked, setAsked] = useState(false);
  const open = Number.isFinite(until) && until > clock;

  // A new window (a password typed since) starts again: what the last one was refused is forgotten.
  useEffect(() => { setAsked(false); setClock(now()); }, [elevatedUntil]); // eslint-disable-line react-hooks/exhaustive-deps
  // The field comes back the moment the window ends, not at the next thing that happens to draw.
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => setClock(now()), Math.min(2_147_000_000, Math.max(0, until - now()) + 50));
    return () => window.clearTimeout(timer);
  }, [open, until]); // eslint-disable-line react-hooks/exhaustive-deps
  // Whether there is a window at all is the approval mode's to say; until it has, the field shows.
  useEffect(() => {
    if (!open) return undefined;
    let gone = false;
    fetch("/api/v1/settings/approval-mode")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { approvalMode?: unknown } | null) => { if (!gone) setMode(body?.approvalMode === "tiered" || body?.approvalMode === "always-password" ? body.approvalMode : null); })
      .catch(() => { if (!gone) setMode(null); });
    return () => { gone = true; };
  }, [open]);

  const refused = useCallback(() => {
    setAsked(true);
    // The bar still says "No password until": it reads the session again.
    window.dispatchEvent(new Event("boxpilot:auth-changed"));
  }, []);

  const free = open && mode === "tiered" && !asked;
  return {
    free,
    note: free ? `No password needed until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : null,
    asked,
    refused,
  };
}
