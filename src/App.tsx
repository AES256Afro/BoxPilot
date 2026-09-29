import PageErrorBoundary from "./PageErrorBoundary";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { viewLabel, type ViewName } from "./data";
import { viewCopy, viewFeatures } from "./pageCopy";
import AuthScreen from "./AuthScreen";
import ActivityDrawer from "./ActivityDrawer";
import { useOperation } from "./ApproveDialog";
import { useTheme } from "./useTheme";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { dropElevation, fetchAuthStatus, logoutOwner, type AuthStatus } from "./auth";
import { connectionLabel } from "./appLinks";
import { FactsProvider } from "./home/facts";
import { CommandBar } from "./shell/CommandBar";
import { ShellDock, ViewSwitch } from "./shell/ShellNav";
import { TopBarSlotProvider } from "./shell/TopBarSlot";

// Every page is its own chunk, fetched the first time it is opened. All eighteen used to ride in
// the one bundle: 688 KB of JavaScript to show the Overview, about sixty percent of it pages the
// visitor might never reach. Now the shell is what first paint waits for; each page arrives on
// navigation, once, and the immutable asset cache keeps it after that.
const BackupCenter = lazy(() => import("./BackupCenter"));
const GitHubCenter = lazy(() => import("./GitHubCenter"));
const Home = lazy(() => import("./home/Home"));
const Ops = lazy(() => import("./home/Ops"));
const HomeDashboard = lazy(() => import("./HomeDashboard"));
const SetupWizard = lazy(() => import("./SetupWizard"));
const HostOverview = lazy(() => import("./HostOverview"));
const NetworkCenter = lazy(() => import("./NetworkCenter"));
const RepairCenter = lazy(() => import("./RepairCenter"));
const SystemLogs = lazy(() => import("./SystemLogs"));
const UpdatesCenter = lazy(() => import("./UpdatesCenter"));
const AppCatalog = lazy(() => import("./AppCatalog"));
const AutomationsCenter = lazy(() => import("./AutomationsCenter"));
const ServicesCenter = lazy(() => import("./ServicesCenter"));
const SystemCenter = lazy(() => import("./SystemCenter"));
const PerformanceCenter = lazy(() => import("./PerformanceCenter"));
const UsersCenter = lazy(() => import("./UsersCenter"));
const FirewallCenter = lazy(() => import("./FirewallCenter"));
const StorageCenter = lazy(() => import("./StorageCenter"));
const VirtualMachines = lazy(() => import("./VirtualMachines"));
// The design system's gallery (M33.1), for the demo only: /?gallery opens it when the server says
// it is the demo, so a real BoxPilot never shows it and never fetches its chunk.
const Gallery = lazy(() => import("./ui/Gallery"));

function StatusPill({ children, tone = "good", className }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={`status-pill status-${tone}${className ? ` ${className}` : ""}`}>{children}</span>;
}

const Settings = lazy(() => import("./SettingsView"));

/** Home and Ops draw their own headers; every other page gets the Classic one. */
const ownHeader = new Set<ViewName>(["home", "ops"]);

/**
 * Deep link: /?view=firewall opens that page, and a reload keeps the page you were on (Setup
 * included). No view is Home, the landing page since M33.2; the old landing page is ?view=overview.
 */
function viewFromLocation(): ViewName {
  const candidate = new URLSearchParams(window.location.search).get("view");
  return candidate && Object.hasOwn(viewCopy, candidate) ? (candidate as ViewName) : "home";
}

function Console({ authStatus, onSignedOut, onAuthChanged }: { authStatus: AuthStatus; onSignedOut: () => void; onAuthChanged?: (status: AuthStatus) => void }) {
  const [view, setViewState] = useState<ViewName>(viewFromLocation);
  // The app the catalog opens at (?app=jellyfin), when a tile or the command bar sent us there.
  const [focusApp, setFocusApp] = useState<string | null>(() => new URLSearchParams(window.location.search).get("app"));
  const [galleryAsked, setGalleryAsked] = useState(() => new URLSearchParams(window.location.search).has("gallery"));
  const setView = useCallback((next: ViewName, options: { app?: string } = {}) => {
    setViewState(next);
    setFocusApp(options.app ?? null);
    setGalleryAsked(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("gallery");
    url.searchParams.delete("app");
    if (next === "home") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
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
    const check = () => { void fetchAuthStatus().then((status) => { if (!status.authenticated) onSignedOut(); else onAuthChanged?.(status); }).catch(() => { retry = window.setTimeout(check, 15_000); }); };
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
  const [apiMode, setApiMode] = useState("browser preview");
  const [bundleError, setBundleError] = useState<string | null>(null);
  const role = authStatus.owner?.role ?? "owner";
  const csrfToken = authStatus.csrfToken ?? "";

  const copy = viewCopy[view];
  const showGallery = galleryAsked && apiMode === "demo";
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
    if (view === "overview") {
      return <><HomeDashboard onNavigate={setView} /><HostOverview /></>;
    }
    if (view === "updates") return <UpdatesCenter csrfToken={csrfToken} />;
    if (view === "catalog") return <AppCatalog key={focusApp ?? ""} csrfToken={csrfToken} focusApp={focusApp ?? undefined} />;
    if (view === "services") return <ServicesCenter csrfToken={csrfToken} />;
    if (view === "system") return <SystemCenter csrfToken={csrfToken} />;
    if (view === "automations") return <AutomationsCenter csrfToken={csrfToken} />;
    if (view === "performance") return <PerformanceCenter csrfToken={csrfToken} />;
    if (view === "users") return <UsersCenter csrfToken={csrfToken} />;
    if (view === "firewall") return <FirewallCenter csrfToken={csrfToken} />;
    if (view === "storage") return <StorageCenter csrfToken={csrfToken} onNavigate={setView} />;
    if (view === "network") return <NetworkCenter csrfToken={csrfToken} onOpenRepair={() => setView("repairs")} />;
    if (view === "repairs") return <RepairCenter csrfToken={csrfToken} onNavigate={setView} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={csrfToken} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupCenter csrfToken={csrfToken} onOpenRepair={() => setView("repairs")} />;
    if (view === "github") return <GitHubCenter />;
    if (view === "logs") return <SystemLogs csrfToken={csrfToken} />;
    return <Settings csrfToken={csrfToken} role={role} />;
  }, [csrfToken, focusApp, role, setView, view]);

  const downloadSupportBundle = async () => {
    setBundleError(null);
    try {
      const response = await fetch("/api/v1/support-bundle");
      // A crashed service or a proxy answers with HTML; say what to do rather than showing a parser error.
      const bundle = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(bundle.error ?? "BoxPilot could not build the support bundle. Check the BoxPilot service on the Services page, then try again.");
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "boxpilot-support-bundle.json";
      anchor.click();
      // Revoking in the same tick can cancel the download before the browser has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Support bundle is unavailable");
    }
  };

  const handlePrimaryAction = () => {
    if (view === "logs") void downloadSupportBundle();
  };

  const wide = !showGallery && ownHeader.has(view);
  // Where Home and Ops draw the start of the top bar (src/shell/TopBarSlot.tsx).
  const [topBarSlot, setTopBarSlot] = useState<HTMLDivElement | null>(null);

  return (
    <FactsProvider>
      <TopBarSlotProvider value={topBarSlot}>
      {/* data-view picks the shell's look (M33.7): Home's floats over its wallpaper, Ops' is the
          compact dark bar beside a rail, every other page the Classic bar and the dock. */}
      <div className="app-shell" data-view={showGallery ? "gallery" : view}>
        <a className="skip-link" href="#content">Skip to the page</a>
        <header className="topbar">
          <div className="topbar-left">
            <div className="brand" title={`BoxPilot ${__BOXPILOT_VERSION__}`}><span aria-hidden="true">B</span><div>BoxPilot<small>v{__BOXPILOT_VERSION__}</small></div></div>
            <div className="topbar-slot" ref={setTopBarSlot} />
            <ViewSwitch view={showGallery ? null : view} onSelect={setView} />
          </div>
          <CommandBar csrfToken={csrfToken} onNavigate={setView} onStart={startOperation} />
          <div className="topbar-right">
            <span className="connection-pill" title="How this browser reached BoxPilot">{connectionLabel(window.location)}</span>
            <ThemeSwitch compact />
            <ActivityDrawer csrfToken={csrfToken} />
            {authStatus.owner?.role && authStatus.owner.role !== "owner" ? <span className="status-pill status-neutral" title="Your role on this server">{authStatus.owner.role}</span> : null}
            {elevated
              ? <button className="text-button elevation-lock" type="button" title="High-risk approvals skip the password until this time. Click to lock now." aria-label={`Elevated until ${elevatedLabel}. Lock now`} onClick={() => void dropElevation(csrfToken).then(refreshAuth).catch(() => refreshAuth())}><span className="elevation-long">Elevated until </span><span className="elevation-short">Until </span>{elevatedLabel} · Lock</button>
              : <StatusPill tone="neutral" className="approvals-pill">Tiered approvals</StatusPill>}
            <span className="signed-in-user" title={authStatus.owner?.username}>
              {authStatus.owner?.username && <span className="signed-in-user__avatar" aria-hidden="true">{authStatus.owner.username.slice(0, 1).toUpperCase()}</span>}
              <span className="signed-in-user__name">{authStatus.owner?.username}</span>
            </span>
            <button className="text-button" type="button" onClick={() => void logoutOwner(csrfToken).then(onSignedOut).catch(onSignedOut)}>Sign out</button>
          </div>
        </header>

        <ShellDock view={showGallery ? null : view} onSelect={setView} variant={!showGallery && view === "ops" ? "rail" : "dock"} />

        <main id="content" tabIndex={-1}>
          <div className={wide ? "content content--wide" : "content"}>
            {showGallery ? <Suspense fallback={<p className="muted page-loading">Loading…</p>}><Gallery /></Suspense> : <>
              {!ownHeader.has(view) && (
                <header className="page-header">
                  <div><span className="eyebrow">{view === "overview" ? "Classic overview" : "BoxPilot"}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>
                  {copy.action && (
                    <button className="primary-button" type="button" onClick={handlePrimaryAction}>
                      {copy.action}
                    </button>
                  )}
                </header>
              )}
              {view !== "repairs" && !ownHeader.has(view) && <section className="surface-notice surface-live feature-strip" aria-label="Features">
                <strong>What you can do</strong>
                <ul className="feature-list">{viewFeatures[view].map((feature) => <li key={feature}>{feature}</li>)}</ul>
              </section>}
              {bundleError && <div className="auth-error" role="alert">{bundleError}</div>}
              <PageErrorBoundary pageName={viewLabel(view)} resetKey={view}><Suspense fallback={<p className="muted page-loading">Loading…</p>}>{pageContent}</Suspense></PageErrorBoundary>
            </>}
          </div>
        </main>
        {operationDialog}
      </div>
      </TopBarSlotProvider>
    </FactsProvider>
  );
}

function App() {
  useTheme(); // keeps data-theme true to this browser's choice
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void fetchAuthStatus()
      .then(setAuthStatus)
      .catch((error) => setAuthError(error instanceof Error ? error.message : "Unable to reach BoxPilot authentication"));
  }, []);

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
    return <AuthScreen bootstrapRequired={authStatus.bootstrapRequired} onAuthenticated={onAuthed} />;
  }
  return <Console authStatus={authStatus} onAuthChanged={setAuthStatus} onSignedOut={() => setAuthStatus({ ...authStatus, authenticated: false, owner: null, csrfToken: null, expiresAt: null })} />;
}

export default App;
