import { useEffect, useState } from "react";
import { dropElevation, forgetSession, logoutOwner, type AuthStatus, type SignedOutReason } from "../auth";
import "./bar.css";

/**
 * Who is signed in, at the end of the top bar (M33.13): the role when it is not the owner's, the
 * elevated session's lock (or, when there is none, that approvals are tiered), the person, and
 * Sign out. The lock shows until when high-risk approvals skip the password; a press locks it now.
 */
export function SessionControls({ authStatus, csrfToken, onRefresh, onSignedOut }: {
  authStatus: AuthStatus;
  csrfToken: string;
  /** Read the session again (after locking it). */
  onRefresh: () => void;
  /** Signing out is done: go to the sign-in page. */
  onSignedOut: (reason: SignedOutReason | null) => void;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!authStatus.elevatedUntil) return undefined;
    const interval = window.setInterval(() => setClock(Date.now()), 15000);
    return () => window.clearInterval(interval);
  }, [authStatus.elevatedUntil]);
  const elevatedTime = authStatus.elevatedUntil ? Date.parse(authStatus.elevatedUntil) : Number.NaN;
  const elevated = Number.isFinite(elevatedTime) && elevatedTime > clock;
  const until = elevated ? new Date(elevatedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const role = authStatus.owner?.role;
  const username = authStatus.owner?.username;
  return (
    <>
      {role && role !== "owner" && <span className="bar-label bar-role" title="Your role on this server">{role}</span>}
      {elevated
        ? (
          <button className="bar-button bar-lock" type="button" title="High-risk approvals skip the password until this time. Click to lock now." aria-label={`Elevated until ${until}. Lock now`}
            onClick={() => void dropElevation(csrfToken).then(onRefresh).catch(() => onRefresh())}>
            <span className="bar-lock__long">Elevated until </span><span className="bar-lock__short">Until </span>{until} · Lock
          </button>
        )
        : <span className="bar-label bar-tiers">Tiered approvals</span>}
      <span className="signed-in-user" title={username}>
        {username && <span className="signed-in-user__avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span>}
        <span className="signed-in-user__name">{username}</span>
      </span>
      <button className="bar-button" type="button" onClick={() => { forgetSession(); void logoutOwner(csrfToken).then(() => onSignedOut(null)).catch(() => onSignedOut(null)); }}>Sign out</button>
    </>
  );
}
