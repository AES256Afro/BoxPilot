import PageErrorBoundary from "./PageErrorBoundary";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { viewLabel, type ViewName } from "./data";
import { viewCopy } from "./pageCopy";
import AuthScreen from "./AuthScreen";
import ActivityDrawer from "./ActivityDrawer";
import { useOperation } from "./ApproveDialog";
import { useTheme } from "./useTheme";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { dropElevation, fetchAuthStatus, forgetSession, logoutOwner, rememberSession, signedOutReason, type AuthStatus, type SignedOutReason } from "./auth";
import { useSessionEnded } from "./sessionEnd";
import { connectionLabel } from "./appLinks";
import { FactsProvider } from "./home/facts";
import { CommandBar } from "./shell/CommandBar";
import { NotificationCentre } from "./shell/NotificationCentre";
import { ShellDock, ViewSwitch } from "./shell/ShellNav";
import { ShellHost } from "./shell/ShellHost";
import { TopBarSlotProvider } from "./shell/TopBarSlot";
import { PageHeader } from "./ui/PageHeader";

// Every page is its own chunk, fetched the first time it is opened. All eighteen used to ride in
// the one bundle: 688 KB of JavaScript to show the first page, about sixty percent of it pages the
// visitor might never reach. Now the shell is what first paint waits for; each page arrives on
// navigation, once, and the immutable asset cache keeps it after that.
const BackupCenter = lazy(() => import("./BackupCenter"));
const GitHubPage = lazy(() => import("./pages/github/GitHubPage"));
const Home = lazy(() => import("./home/Home"));
const Ops = lazy(() => import("./home/Ops"));
const SetupWizard = lazy(() => import("./SetupWizard"));
const NetworkPage = lazy(() => import("./pages/network/NetworkPage"));
const RepairCenter = lazy(() => import("./RepairCenter"));
const LogsPage = lazy(() => import("./pages/logs/LogsPage"));
const UpdatesPage = lazy(() => import("./pages/updates/UpdatesPage"));
const CatalogPage = lazy(() => import("./pages/catalog/CatalogPage"));
const AutomationsPage = lazy(() => import("./pages/automations/AutomationsPage"));
const ServicesPage = lazy(() => import("./pages/services/ServicesPage"));
const SystemCenter = lazy(() => import("./SystemCenter"));
const PerformancePage = lazy(() => import("./pages/performance/PerformancePage"));
const UsersPage = lazy(() => import("./pages/users/UsersPage"));
const FirewallPage = lazy(() => import("./pages/firewall/FirewallPage"));
const StorageCenter = lazy(() => import("./StorageCenter"));
const VirtualMachines = lazy(() => import("./VirtualMachines"));
// The design system's gallery (M33.1), for the demo only: /?gallery opens it when the server says
// it is the demo, so a real BoxPilot never shows it and never fetches its chunk.
const Gallery = lazy(() => import("./ui/Gallery"));

function StatusPill({ children, tone = "good", className }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={`status-pill status-${tone}${className ? ` ${className}` : ""}`}>{children}</span>;
}

const Settings = lazy(() => import("./SettingsView"));

/**
 * Pages that draw their own PageHeader (src/ui/PageHeader.tsx): Home its greeting, Ops and the
 * pages rebuilt on the kit their verdict and facts. Every other page gets one from the shell, with
 * its name in the bar and what it is for behind the info toggle, until wave 2 rebuilds it (M33.8).
 * A rebuilt page adds itself here. Repair (M35) draws its own crumb and verdict in the page.
 */
const ownHeader = new Set<ViewName>(["home", "ops", "services", "logs", "repairs", "network", "firewall", "users", "github", "updates", "catalog", "automations", "performance"]);

/**
 * Deep link: /?view=firewall opens that page, and a reload keeps the page you were on (Setup
 * included). No view is Home, the landing page since M33.2. The Classic overview is gone (M33.8):
 * ?view=overview, and any page that no longer exists, opens Home and leaves the address clean.
 */
function viewFromLocation(): ViewName {
  const params = new URLSearchParams(window.location.search);
  const candidate = params.get("view");
  if (candidate && Object.hasOwn(viewCopy, candidate)) return candidate as ViewName;
  if (candidate) {
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  }
  return "home";
}

/** A page's own address parameters (a tab, a filter) belong to it; these outlive a change of page. */
const keptParams = new Set(["scenario"]);

function Console({ authStatus, onSignedOut, onAuthChanged }: { authStatus: AuthStatus; onSignedOut: (reason: SignedOutReason | null) => void; onAuthChanged?: (status: AuthStatus) => void }) {
  const [view, setViewState] = useState<ViewName>(viewFromLocation);
  // The app the catalog opens at (?app=jellyfin), when a tile or the command bar sent us there.
  const [focusApp, setFocusApp] = useState<string | null>(() => new URLSearchParams(window.location.search).get("app"));
  const [galleryAsked, setGalleryAsked] = useState(() => new URLSearchParams(window.location.search).has("gallery"));
  const setView = useCallback((asked: ViewName, options: { app?: string } = {}) => {
    // A link to a page that is gone (an older server's "Open Overview") lands on Home.
    const next: ViewName = Object.hasOwn(viewCopy, asked) ? asked : "home";
    setViewState(next);
    setFocusApp(options.app ?? null);
    setGalleryAsked(false);
    const url = new URL(window.location.href);
    for (const name of [...url.searchParams.keys()]) if (!keptParams.has(name)) url.searchParams.delete(name);
    if (next !== "home") url.searchParams.set("view", next);
    if (options.app) url.searchParams.set("app", options.app);
    window.history.replaceState(null, "", url);
  }, []);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!authStatus.elevatedUntil) return undefined;
    const interval = window.setInterval(() => setClock(Date.now()), 15000);
    return () => window.clearInterval(interval);
  }, [authStatus.elevatedUntil]);
  const elevatedTime = authStatus.elevatedUntil ? Date.parse(authStatus.elevatedUntil) : Number.NaN;
  const elevated = Number.isFinite(elevatedTime) && elevatedTime > clock;
  const elevatedLabel = elevated ? new Date(elevatedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const refreshAuth = () => fetchAuthStatus().then((status) => onAuthChanged?.(status)).catch(() => undefined);
  // When the session reaches its expiry, go back to the sign-in screen instead of leaving every page red.
  useEffect(() => {
    const expiresAt = Date.parse(authStatus.expiresAt ?? "");
    if (!Number.isFinite(expiresAt)) return undefined;
    const delay = Math.min(2_147_000_000, Math.max(1000, expiresAt - Date.now() + 1000));
    let retry = 0;
    const check = () => { void fetchAuthStatus().then((status) => { if (!status.authenticated) onSignedOut(signedOutReason() ?? "expired"); else onAuthChanged?.(status); }).catch(() => { retry = window.setTimeout(check, 15_000); }); };
    const timer = window.setTimeout(check, delay);
    return () => { window.clearTimeout(timer); if (retry) window.clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus.expiresAt]);
  useEffect(() => {
    const listener = () => { void refreshAuth(); };
    window.addEventListener("boxpilot:auth-changed", listener);
    return () => window.removeEventListener("boxpilot:auth-changed", listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useSessionEnded(onSignedOut); // M36: a request that finds no session goes to sign-in, saying why
  const [apiMode, setApiMode] = useState("browser preview");
  const role = authStatus.owner?.role ?? "owner";
  const csrfToken = authStatus.csrfToken ?? "";

  const copy = viewCopy[view];
  const showGallery = galleryAsked && apiMode === "demo";
  // Home is the Launcher; every other page, the gallery included, is inside the console (M33.8):
  // the rail, the compact bar and the Command Center's look. On a phone the rail is the dock.
  const shell = showGallery || view !== "home" ? "console" : "launcher";
  // The look is set on the page's root too, so what opens over the page (a sheet, Activity, the
  // command bar, the approval dialog) is drawn in the same look as the page under it.
  useLayoutEffect(() => {
    document.documentElement.dataset.shell = shell;
    return () => { delete document.documentElement.dataset.shell; };
  }, [shell]);
  // A step the command bar's assistant suggested goes through the same approval dialog as any other.
  const { start: startOperation, dialog: operationDialog } = useOperation(csrfToken);

  useEffect(() => {
    if (typeof fetch !== "function") return;
    fetch("/api/v1/health")
      .then((response) => {
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          throw new Error("BoxPilot is not answering");
        }
        return response.json() as Promise<{ mode?: string }>;
      })
      .then((health) => setApiMode(health.mode ?? "prototype"))
      .catch(() => setApiMode("browser preview"));
  }, []);

  const pageContent = useMemo(() => {
    if (view === "home") return <Home csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "ops") return <Ops csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "setup") return <SetupWizard csrfToken={csrfToken} onDone={() => setView("home")} />;
    if (view === "updates") return <UpdatesPage csrfToken={csrfToken} role={role} />;
    if (view === "catalog") return <CatalogPage key={focusApp ?? ""} csrfToken={csrfToken} focusApp={focusApp ?? undefined} role={role} />;
    if (view === "services") return <ServicesPage csrfToken={csrfToken} role={role} />;
    if (view === "system") return <SystemCenter csrfToken={csrfToken} role={role} />;
    if (view === "automations") return <AutomationsPage csrfToken={csrfToken} role={role} />;
    if (view === "performance") return <PerformancePage csrfToken={csrfToken} role={role} />;
    if (view === "users") return <UsersPage csrfToken={csrfToken} role={role} />;
    if (view === "firewall") return <FirewallPage csrfToken={csrfToken} role={role} />;
    if (view === "storage") return <StorageCenter csrfToken={csrfToken} onNavigate={setView} />;
    if (view === "network") return <NetworkPage csrfToken={csrfToken} role={role} />;
    if (view === "repairs") return <RepairCenter csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={csrfToken} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupCenter csrfToken={csrfToken} onOpenRepair={() => setView("repairs")} />;
    if (view === "github") return <GitHubPage />;
    if (view === "logs") return <LogsPage csrfToken={csrfToken} role={role} />;
    return <Settings csrfToken={csrfToken} role={role} />;
  }, [csrfToken, focusApp, role, setView, view]);

  // Where Home and every console page draw the start of the top bar (src/shell/TopBarSlot.tsx).
  const [topBarSlot, setTopBarSlot] = useState<HTMLDivElement | null>(null);

  return (
    <FactsProvider>
      <TopBarSlotProvider value={topBarSlot}>
      <ShellHost ask={shell === "console"}>
      {/* data-shell picks the shell's look (M33.8): Home's Launcher floats over its wallpaper; the
          console, everywhere else, is the compact bar beside a rail. data-view names the page. */}
      <div className="app-shell" data-view={showGallery ? "gallery" : view} data-shell={shell}>
        <a className="skip-link" href="#content">Skip to the page</a>
        <header className="topbar">
          <div className="topbar-left">
            <div className="brand" title={`BoxPilot ${__BOXPILOT_VERSION__}`}><span aria-hidden="true">B</span><div>BoxPilot<small>v{__BOXPILOT_VERSION__}</small></div></div>
            <div className="topbar-slot" ref={setTopBarSlot} />
            <ViewSwitch view={showGallery ? null : view} onSelect={setView} />
          </div>
          <CommandBar csrfToken={csrfToken} onNavigate={setView} onStart={startOperation} role={role} />
          <div className="topbar-right">
            <span className="connection-pill" title="How this browser reached BoxPilot">{connectionLabel(window.location)}</span>
            <ThemeSwitch compact />
            <NotificationCentre csrfToken={csrfToken} onNavigate={setView} />
            <ActivityDrawer csrfToken={csrfToken} role={role} />
            {authStatus.owner?.role && authStatus.owner.role !== "owner" ? <span className="status-pill status-neutral" title="Your role on this server">{authStatus.owner.role}</span> : null}
            {elevated
              ? <button className="text-button elevation-lock" type="button" title="High-risk approvals skip the password until this time. Click to lock now." aria-label={`Elevated until ${elevatedLabel}. Lock now`} onClick={() => void dropElevation(csrfToken).then(refreshAuth).catch(() => refreshAuth())}><span className="elevation-long">Elevated until </span><span className="elevation-short">Until </span>{elevatedLabel} · Lock</button>
              : <StatusPill tone="neutral" className="approvals-pill">Tiered approvals</StatusPill>}
            <span className="signed-in-user" title={authStatus.owner?.username}>
              {authStatus.owner?.username && <span className="signed-in-user__avatar" aria-hidden="true">{authStatus.owner.username.slice(0, 1).toUpperCase()}</span>}
              <span className="signed-in-user__name">{authStatus.owner?.username}</span>
            </span>
            <button className="text-button" type="button" onClick={() => { forgetSession(); void logoutOwner(csrfToken).then(() => onSignedOut(null)).catch(() => onSignedOut(null)); }}>Sign out</button>
          </div>
        </header>

        <ShellDock view={showGallery ? null : view} onSelect={setView} variant={shell === "console" ? "rail" : "dock"} />

        <main id="content" tabIndex={-1}>
          <div className={shell === "console" ? "content content--console" : "content content--wide"} data-density={shell === "console" ? "compact" : undefined}>
            {showGallery ? <Suspense fallback={<p className="muted page-loading">Loading…</p>}><Gallery /></Suspense> : <>
              {!ownHeader.has(view) && <PageHeader title={copy.title} about={copy.description} />}
              {/* Keyed by the page, so the page left behind unmounts at once rather than waiting, hidden,
                  behind the next one's loading: its name in the bar would otherwise linger. */}
              <PageErrorBoundary pageName={viewLabel(view)} resetKey={view}><Suspense key={view} fallback={<p className="muted page-loading">Loading…</p>}>{pageContent}</Suspense></PageErrorBoundary>
            </>}
          </div>
        </main>
        {operationDialog}
      </div>
      </ShellHost>
      </TopBarSlotProvider>
    </FactsProvider>
  );
}

function App() {
  useTheme(); // keeps data-theme true to this browser's choice
  const [authStatus, setAuthStatusState] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Why the sign-in page is showing, when a session this browser had has gone (M36).
  const [signedOut, setSignedOut] = useState<SignedOutReason | null>(null);
  const setAuthStatus = useCallback((status: AuthStatus) => {
    if (status.authenticated) { rememberSession(status); setSignedOut(null); }
    setAuthStatusState(status);
  }, []);

  useEffect(() => {
    void fetchAuthStatus()
      .then((status) => { if (!status.authenticated) setSignedOut(signedOutReason()); setAuthStatus(status); })
      .catch((error) => setAuthError(error instanceof Error ? error.message : "Unable to reach BoxPilot authentication"));
  }, [setAuthStatus]);

  // An app's "Sign in with BoxPilot" (M19.3) lands here with ?next=/oidc/authorize when the strict
  // session cookie was not sent on the cross-site hop. Once we know the owner is signed in, continue
  // the flow. Only same-site /oidc/ paths are followed, so this cannot be an open redirect.
  useEffect(() => {
    if (!authStatus?.authenticated) return;
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/oidc/")) window.location.href = next;
  }, [authStatus?.authenticated]);

  if (authError) {
    return <main className="auth-shell"><section className="auth-card"><span className="eyebrow">Connection failed</span><h1>BoxPilot is unavailable</h1><p role="alert">{authError}</p><button className="secondary-button" type="button" onClick={() => window.location.reload()}>Try again</button></section></main>;
  }
  if (!authStatus) return <main className="auth-shell"><section className="auth-card"><span className="eyebrow">Private administration</span><h1>Loading BoxPilot...</h1></section></main>;
  if (!authStatus.authenticated) {
    // After signing in, continue an app's "Sign in with BoxPilot" flow if one sent us here. Only
    // same-site /oidc/ paths are followed, so this can never be an open redirect.
    const onAuthed = (status: AuthStatus) => {
      const next = new URLSearchParams(window.location.search).get("next");
      if (next && next.startsWith("/oidc/")) { window.location.href = next; return; }
      setAuthStatus(status);
    };
    const page = viewFromLocation();
    return <AuthScreen bootstrapRequired={authStatus.bootstrapRequired} onAuthenticated={onAuthed} notice={signedOut && !authStatus.bootstrapRequired ? { reason: signedOut, page: page === "home" ? null : viewLabel(page) } : null} />;
  }
  return <Console authStatus={authStatus} onAuthChanged={setAuthStatus} onSignedOut={(reason) => { setSignedOut(reason); forgetSession(); setAuthStatusState({ ...authStatus, authenticated: false, owner: null, csrfToken: null, expiresAt: null }); }} />;
}

export default App;
