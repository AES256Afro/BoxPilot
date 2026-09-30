import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { openActivity, openNotifications } from "../activityEvents";
import type { AuthStatus, SignedOutReason } from "../auth";
import type { ViewName } from "../data";
import { useTheme } from "../useTheme";
import { signOut } from "./SessionControls";
import "./account.css";

/*
 * The account menu (M41): the person's initial as one button that opens Activity, the
 * notifications, light or dark, Settings and Sign out. Most looks keep those in the bar as they
 * are; a look whose drawing keeps its bar bare (Home + Ops, Blueprint, Phosphor, …) hides them from
 * its skin and shows this instead. It is in every bar and hidden until a look shows it, so turning
 * it on is a stylesheet's choice. The controls it stands in for stay mounted (hidden), so Activity
 * and the bell still open from anywhere.
 */
export function AccountMenu({ authStatus, csrfToken, onNavigate, onSignedOut }: {
  authStatus: AuthStatus;
  csrfToken: string;
  onNavigate: (view: ViewName) => void;
  onSignedOut: (reason: SignedOutReason | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { appearance, setAppearance, appearances } = useTheme();
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const username = authStatus.owner?.username ?? "";
  const role = authStatus.owner?.role ?? "owner";

  // Focus the first item on opening; close on a click elsewhere.
  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (run: () => void) => () => { setOpen(false); run(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); items[items.length - 1]?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className="account-menu" ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button ref={button} type="button" className="account-menu__button" aria-haspopup="menu" aria-expanded={open} aria-label={username ? `Account: ${username}` : "Account"} title={username} onClick={() => setOpen((value) => !value)}>
        <span className="account-menu__avatar" aria-hidden="true">{(username || "?").slice(0, 1).toUpperCase()}</span>
      </button>
      {open && (
        <div className="account-menu__list" role="menu" aria-label="Account">
          <p className="account-menu__who">{username}{role !== "owner" ? ` · ${role}` : ""}</p>
          <button type="button" role="menuitem" className="account-menu__item" onClick={choose(() => openActivity())}>Activity</button>
          <button type="button" role="menuitem" className="account-menu__item" onClick={choose(openNotifications)}>Notifications</button>
          <div role="group" aria-label="Light or dark" className="account-menu__group">
            {appearances.map((option) => (
              <button key={option.id} type="button" role="menuitemradio" aria-checked={appearance === option.id} className="account-menu__item account-menu__item--choice" onClick={() => setAppearance(option.id)}>{option.label}</button>
            ))}
          </div>
          <button type="button" role="menuitem" className="account-menu__item" onClick={choose(() => onNavigate("settings"))}>Settings</button>
          <button type="button" role="menuitem" className="account-menu__item account-menu__item--out" onClick={choose(() => signOut(csrfToken, onSignedOut))}>Sign out</button>
        </div>
      )}
    </div>
  );
}
