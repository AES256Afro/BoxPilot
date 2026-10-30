import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useDrawnLookInShell } from "../../looks/drawnLook";
import { lookById } from "../../looks/looks";
import { PageHeader, Tabs, type Status, type TabItem } from "../../ui";
import ApprovalsPanel from "./ApprovalsPanel";
import AppearancePanel from "./AppearancePanel";
import CredentialsPanel from "./CredentialsPanel";
import NotificationsPanel from "./NotificationsPanel";
import PasskeysPanel from "./PasskeysPanel";
import PasswordPanel from "./PasswordPanel";
import PeoplePanel from "./PeoplePanel";
import SessionsPanel from "./SessionsPanel";
import SignInMethodsPanel from "./SignInMethodsPanel";
import SingleSignOnPanel from "./SingleSignOnPanel";
import { sectionsFor, useSettingsSection, type SettingsSection } from "./sections";
import "./settings.css";

/*
 * Settings (M33.13), rebuilt on the kit in the console's look, one tab per concern, the open tab
 * kept in the address (?view=settings&tab=people). Facts first: for the owner, whether alerts can
 * reach them and how approvals are set, in the header. Who sees what is ADR-003's: box-level
 * settings (people, notifications, approvals, single sign-on, credentials) are the owner's; an
 * operator also links their own sign-in methods; everyone has their password, passkeys, sessions and
 * the theme. The panels load in this page's own chunk, so no other page pays for them.
 */

type TabId = SettingsSection;

/** A screen wide enough for the sidebar (it folds away at 760 px and under, as sidebar.css says). */
const wideQuery = "(min-width: 761px)";
function useWideScreen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = typeof window.matchMedia === "function" ? window.matchMedia(wideQuery) : null;
      query?.addEventListener("change", listener);
      return () => query?.removeEventListener("change", listener);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(wideQuery).matches : true),
    () => true,
  );
}

interface Summary { target: { configured: boolean; kind: string | null } | null; mode: string | null; read: boolean }

const modeWords: Record<string, string> = { tiered: "tiered", "always-password": "always ask" };

export default function SettingsPage({ csrfToken, role = "owner" }: { csrfToken: string; role?: string }) {
  const owner = role === "owner";
  const [summary, setSummary] = useState<Summary>({ target: null, mode: null, read: false });

  // The owner's two facts: where alerts go, and how approvals are set.
  const readSummary = useCallback(async () => {
    if (!owner) return;
    const [target, mode] = await Promise.all([
      fetch("/api/v1/settings/notifications").then((response) => (response.ok ? response.json() as Promise<{ configured: boolean; kind: string | null }> : null)).catch(() => null),
      fetch("/api/v1/settings/approval-mode").then((response) => (response.ok ? response.json() as Promise<{ approvalMode?: string }> : null)).catch(() => null),
    ]);
    setSummary({ target: target && typeof target.configured === "boolean" ? { configured: target.configured, kind: target.kind ?? null } : null, mode: mode?.approvalMode ?? null, read: true });
  }, [owner]);
  useEffect(() => { void readSummary(); }, [readSummary]);

  const noTarget = owner && summary.target !== null && !summary.target.configured;
  const tabs: Array<TabItem<TabId>> = sectionsFor(role).map((section) => ({
    id: section.id,
    label: section.label,
    ...(section.id === "notifications" && noTarget ? { status: "warning" as Status, statusLabel: "no target set" } : {}),
  }));
  const [tab, setTab] = useSettingsSection(role);
  // In a look that goes around by the sidebar, the sidebar lists the sections while Settings is
  // open (src/shell/ShellSidebar.tsx) and the page is the open section, named as its title (M41).
  const drawn = useDrawnLookInShell();
  const wide = useWideScreen();
  const inSidebar = drawn !== null && lookById(drawn).nav === "sidebar" && wide;

  const verdict: { status: Status; label: string } | undefined = !owner ? undefined
    : !summary.read ? { status: "unknown", label: "Reading…" }
      : summary.target === null ? { status: "unknown", label: "Alerts not read" }
        : summary.target.configured ? { status: "good", label: `Alerts go to ${summary.target.kind ?? "a target"}` }
          : { status: "warning", label: "No notification target" };

  const section = (current: TabId) => {
    if (current === "people") return <div className="settings-grid"><PeoplePanel csrfToken={csrfToken} /></div>;
    if (current === "notifications") return <div className="settings-grid"><NotificationsPanel csrfToken={csrfToken} onChange={() => void readSummary()} /></div>;
    if (current === "approvals") return <div className="settings-grid"><ApprovalsPanel csrfToken={csrfToken} onChange={() => void readSummary()} /></div>;
    if (current === "sso") return <div className="settings-grid"><SingleSignOnPanel csrfToken={csrfToken} /></div>;
    if (current === "credentials") return <div className="settings-grid"><CredentialsPanel csrfToken={csrfToken} /></div>;
    if (current === "appearance") return <AppearancePanel />;
    return (
      <div className="settings-grid">
        <PasswordPanel csrfToken={csrfToken} />
        {/* Linking Tailscale or GitHub changes how this account signs in; a viewer's Settings
            is their own password, passkeys and sessions (ADR-003). */}
        {role !== "viewer" && <SignInMethodsPanel csrfToken={csrfToken} />}
        <PasskeysPanel csrfToken={csrfToken} />
        <SessionsPanel csrfToken={csrfToken} />
      </div>
    );
  };

  return (
    <div className="settings-page" data-sections={inSidebar ? "sidebar" : "tabs"}>
      <PageHeader
        title={inSidebar ? sectionsFor(role).find((entry) => entry.id === tab)?.label ?? "Settings" : "Settings"}
        // The owner's two facts belong to Settings as a whole; a section on its own (Appearance in
        // the sidebar looks) opens with its own words instead.
        status={inSidebar && tab === "appearance" ? undefined : verdict}
        meta={inSidebar && tab === "appearance" ? undefined : <>role <b>{role}</b>{owner && summary.mode ? <> · approvals <b>{modeWords[summary.mode] ?? summary.mode}</b></> : null}</>}
        about={<>
          <p>Your own account on every tab you can see: your password, passkeys and recovery codes, where you are signed in, and the theme.</p>
          {owner && <p>The owner also decides who can sign in, where alerts go, how much approving asks, which apps may sign in with BoxPilot, and the tokens automations send.</p>}
        </>}
      />
      {inSidebar
        ? <div className="settings-section" id="settings-section">{section(tab)}</div>
        : <Tabs<TabId> label="Settings" tabs={tabs} value={tab} onChange={setTab} className="settings-tabs">{section}</Tabs>}
    </div>
  );
}
