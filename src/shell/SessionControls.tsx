import { useEffect, useState, type ReactNode } from "react";
import { dropElevation, forgetSession, logoutOwner, type AuthStatus, type SignedOutReason } from "../auth";
import { turnOffThisDevice } from "../pwa/push";
import { openView } from "../activityEvents";
import "./bar.css";

/** Signs out of this browser, and stops this device's approval pushes (M25.2) while the session can still say so. */
export function signOut(csrfToken: string, onSignedOut: (reason: SignedOutReason | null) => void) {
  forgetSession();
  void turnOffThisDevice(csrfToken).catch(() => undefined)
    .then(() => logoutOwner(csrfToken)).then(() => onSignedOut(null)).catch(() => onSignedOut(null));
}

/**
 * Who is signed in, at the end of the top bar (M33.13): the role when it is not the owner's, the
 * elevated session's lock (or, when there is none, that approvals are tiered), the person, and
 * Sign out. The lock shows until when high-risk approvals skip the password; a press locks it now.
 */
export function SessionControls({ authStatus, csrfToken, onRefresh, onSignedOut, user }: {
  authStatus: AuthStatus;
  csrfToken: string;
  /** Read the session again (after locking it). */
  onRefresh: () => void;
  /** Signing out is done: go to the sign-in page. */
  onSignedOut: (reason: SignedOutReason | null) => void;
  /** What stands for the person in the bar: the account menu under their name, from App. The plain name otherwise. */
  user?: ReactNode;
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
          <button className="bar-button bar-lock" type="button" title="High-risk approvals skip the password until this time. Click to ask for it again now." aria-label={`No password asked until ${until}. Ask again now`}
            onClick={() => void dropElevation(csrfToken).then(onRefresh).catch(() => onRefresh())}>
            <span className="bar-lock__long">No password until </span><span className="bar-lock__short">Until </span>{until} · Lock
          </button>
        )
        : (
          // The bar said "Tiered approvals", a label that explained nothing and led nowhere (M50): it says what the tiers mean for the person, and opens where they are set.
          <button className="bar-button bar-tiers" type="button" title="Low risk runs on one click, medium after a preview, high with your password. Change this in Settings." onClick={() => openView("settings", { tab: "approvals" })}>
            <span className="bar-lock__long">Password for high risk</span><span className="bar-lock__short">Approvals</span>
          </button>
        )}
      {user ?? <span className="signed-in-user" title={username}>
        {username && <span className="signed-in-user__avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span>}
        <span className="signed-in-user__name">{username}</span>
      </span>}
      <button className="bar-button bar-sign-out" type="button" onClick={() => signOut(csrfToken, onSignedOut)}>Sign out</button>
    </>
  );
}
