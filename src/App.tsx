import PageErrorBoundary from "./shell/PageErrorBoundary";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { viewLabel, type ViewName } from "./data";
import { viewCopy } from "./pageCopy";
import SignInPage, { SignInLoading, SignInUnavailable } from "./pages/signin/SignInPage";
import ActivityDrawer from "./shell/ActivityDrawer";
import { useOperation } from "./shell/ApproveDialog";
import { SessionControls } from "./shell/SessionControls";
import { useTheme } from "./useTheme";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { fetchAuthStatus, forgetAccount, forgetSession, rememberSession, rememberedAccount, signedOutReason, type AuthStatus, type SignedOutReason } from "./auth";
import { useSessionEnded } from "./sessionEnd";
import { connected, useConnection } from "./pwa/connection";
import { OfflineBanner } from "./shell/OfflineBanner";
import { DeepLinkApproval, approvalFromUrl, openMessageType, takeApprovalFromLocation } from "./shell/DeepLinkApproval";
import { RefreshButton } from "./shell/RefreshButton";
import { connectionLabel } from "./appLinks";
import { FactsProvider } from "./home/facts";
import { CommandBar } from "./shell/CommandBar";
import { NotificationCentre } from "./shell/NotificationCentre";
import { PageLoading } from "./shell/PageLoading";
import { ShellDock, ViewSwitch, type DockVariant } from "./shell/ShellNav";
import { ShellSidebar } from "./shell/ShellSidebar";
import { TopBarClock } from "./shell/TopBarClock";
import { DrawnLookProvider } from "./looks/drawnLook";
import { LookHome } from "./looks/LookHome";
import { lookById, type LookId } from "./looks/looks";
import { applyLook, applyLookChoice, useLook } from "./looks/useLook";
import { ShellHost } from "./shell/ShellHost";
import { TopBarSlotProvider } from "./shell/TopBarSlot";
import { PageHeader } from "./ui/PageHeader";

// Every page is its own chunk, fetched the first time it is opened. All eighteen used to ride in
// the one bundle: 688 KB of JavaScript to show the first page, about sixty percent of it pages the
// visitor might never reach. Now the shell is what first paint waits for; each page arrives on
// navigation, once, and the immutable asset cache keeps it after that.
const BackupsPage = lazy(() => import("./pages/backups/BackupsPage"));
const GitHubPage = lazy(() => import("./pages/github/GitHubPage"));
const Ops = lazy(() => import("./home/Ops"));
const TodayPage = lazy(() => import("./pages/today/TodayPage"));
const SetupPage = lazy(() => import("./pages/setup/SetupPage"));
const NetworkPage = lazy(() => import("./pages/network/NetworkPage"));
const RepairCenter = lazy(() => import("./RepairCenter"));
const LogsPage = lazy(() => import("./pages/logs/LogsPage"));
const UpdatesPage = lazy(() => import("./pages/updates/UpdatesPage"));
const CatalogPage = lazy(() => import("./pages/catalog/CatalogPage"));
const AutomationsPage = lazy(() => import("./pages/automations/AutomationsPage"));
const ServicesPage = lazy(() => import("./pages/services/ServicesPage"));
const SystemPage = lazy(() => import("./pages/system/SystemPage"));
const AgentsPage = lazy(() => import("./pages/agents/AgentsPage"));
const PerformancePage = lazy(() => import("./pages/performance/PerformancePage"));
const UsersPage = lazy(() => import("./pages/users/UsersPage"));
const FirewallPage = lazy(() => import("./pages/firewall/FirewallPage"));
const StoragePage = lazy(() => import("./pages/storage/StoragePage"));
const VmsPage = lazy(() => import("./pages/vms/VmsPage"));
// The design system's gallery (M33.1), for the demo only: /?gallery opens it when the server says
// it is the demo, so a real BoxPilot never shows it and never fetches its chunk.
const Gallery = lazy(() => import("./ui/Gallery"));

const Settings = lazy(() => import("./pages/settings/SettingsPage"));

/**
 * Pages that draw their own PageHeader (src/ui/PageHeader.tsx): Home its greeting, every other
 * page its verdict and facts; since M33.14 that is all of them. A page not listed would get a
 * plain one from the shell, its name in the bar and what it is for behind the info toggle.
 */
const ownHeader = new Set<ViewName>(["home", "ops", "today", "services", "logs", "repairs", "network", "firewall", "users", "github", "settings", "virtualization", "system", "setup", "storage", "backups", "updates", "catalog", "automations", "performance", "agents"]);

/**
 * Deep link: /?view=firewall opens that page, and a reload keeps the page you were on (Setup
 * included). No view is Home, the landing page since M33.2. The Classic overview is gone (M33.8):
 * ?view=overview, and any page that no longer exists, opens Home and leaves the address clean.
 */
function viewFromLocation(): ViewName {
  const params = new URLSearchParams(window.location.search);
  // Opened from the home screen (the manifest's start_url, M25.1): a phone starts on Today (M25.3),
  // anything wider on Home. Said in the address, so signing in first still lands there.
  if (params.get("launch") === "pwa") {
    const url = new URL(window.location.href);
    url.searchParams.delete("launch");
    const phone = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
    if (phone && !params.get("view")) url.searchParams.set("view", "today");
    window.history.replaceState(null, "", url);
    return viewFromLocation();
  }
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
  // An approval a push opened (M25.2): read before the view, which it leaves on Today.
  const [approving, setApproving] = useState<string | null>(takeApprovalFromLocation);
  const [view, setViewState] = useState<ViewName>(viewFromLocation);
  // The app the catalog opens at (?app=jellyfin), when a tile or the command bar sent us there.
  const [focusApp, setFocusApp] = useState<string | null>(() => new URLSearchParams(window.location.search).get("app"));
  const [galleryAsked, setGalleryAsked] = useState(() => new URLSearchParams(window.location.search).has("gallery"));
  const setView = useCallback((asked: ViewName, options: { app?: string; tab?: string } = {}) => {
    // A link to a page that is gone (an older server's "Open Overview") lands on Home.
    const next: ViewName = Object.hasOwn(viewCopy, asked) ? asked : "home";
    setViewState(next);
    setFocusApp(options.app ?? null);
    setGalleryAsked(false);
    const url = new URL(window.location.href);
    for (const name of [...url.searchParams.keys()]) if (!keptParams.has(name)) url.searchParams.delete(name);
    if (next !== "home") url.searchParams.set("view", next);
    if (options.app) url.searchParams.set("app", options.app);
    if (options.tab) url.searchParams.set("tab", options.tab); // a tabbed page opens at this tab
    window.history.replaceState(null, "", url);
  }, []);
  // A push tapped while the app is open: the service worker says which approval, and it opens here.
  useEffect(() => {
    const container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
    if (!container) return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== openMessageType) return;
      setView("today");
      setApproving(approvalFromUrl(String(event.data.url ?? "")));
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [setView]);
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
  const accountId = authStatus.owner?.id ?? null;

  const copy = viewCopy[view];
  const showGallery = galleryAsked && apiMode === "demo";
  // The look (M41): every page is drawn in the chosen one, except Home when the look is set for
  // every page but Home; then Home keeps today's Launcher. Home in the Launcher is its own shell
  // (the wallpaper, the glass, the dock); every other page is inside the console (M33.8), whose
  // compact bar and components take the look's values, and is reached the look's way around.
  const lookChoice = useLook();
  const onHome = !showGallery && view === "home";
  const drawnLook: LookId = onHome && lookChoice.scope === "not-home" ? "launcher" : lookChoice.look;
  const shell = onHome && drawnLook === "launcher" ? "launcher" : "console";
  const nav = shell === "launcher" ? "dock" : lookById(drawnLook).nav;
  useLayoutEffect(() => { applyLook(drawnLook); }, [drawnLook]);
  const { accent, wallpaper, solid } = lookChoice;
  useLayoutEffect(() => { applyLookChoice({ ...lookChoice, accent, wallpaper, solid }); }, [accent, wallpaper, solid]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (view === "home") return <LookHome look={drawnLook} csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "ops") return <Ops csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "today") return <TodayPage csrfToken={csrfToken} role={role} accountId={accountId} onNavigate={setView} />;
    if (view === "setup") return <SetupPage csrfToken={csrfToken} role={role} onDone={() => setView("home")} />;
    if (view === "updates") return <UpdatesPage csrfToken={csrfToken} role={role} />;
    if (view === "catalog") return <CatalogPage key={focusApp ?? ""} csrfToken={csrfToken} focusApp={focusApp ?? undefined} role={role} />;
    if (view === "services") return <ServicesPage csrfToken={csrfToken} role={role} />;
    if (view === "system") return <SystemPage csrfToken={csrfToken} role={role} />;
    if (view === "automations") return <AutomationsPage csrfToken={csrfToken} role={role} />;
    if (view === "performance") return <PerformancePage csrfToken={csrfToken} role={role} />;
    if (view === "users") return <UsersPage csrfToken={csrfToken} role={role} />;
    if (view === "firewall") return <FirewallPage csrfToken={csrfToken} role={role} />;
    if (view === "storage") return <StoragePage csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "network") return <NetworkPage csrfToken={csrfToken} role={role} />;
    if (view === "repairs") return <RepairCenter csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "virtualization") return <VmsPage csrfToken={csrfToken} role={role} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupsPage csrfToken={csrfToken} role={role} onNavigate={setView} />;
    if (view === "github") return <GitHubPage />;
    if (view === "logs") return <LogsPage csrfToken={csrfToken} role={role} />;
    if (view === "agents") return <AgentsPage csrfToken={csrfToken} role={role} />;
    return <Settings csrfToken={csrfToken} role={role} />;
  }, [accountId, csrfToken, drawnLook, focusApp, role, setView, view]);

  // Where Home and every console page draw the start of the top bar (src/shell/TopBarSlot.tsx).
  const [topBarSlot, setTopBarSlot] = useState<HTMLDivElement | null>(null);

  return (
    <FactsProvider>
      <TopBarSlotProvider value={topBarSlot}>
      <ShellHost ask={shell === "console"}>
      {/* data-shell picks the shell's look (M33.8): Home's Launcher floats over its wallpaper; the
          console, everywhere else, is the compact bar beside a rail. data-view names the page. */}
      <DrawnLookProvider value={drawnLook}>
      <div className="app-shell" data-view={showGallery ? "gallery" : view} data-shell={shell} data-nav={nav}>
        <a className="skip-link" href="#content">Skip to the page</a>
        <header className="topbar">
          <div className="topbar-left">
            <div className="brand" title={`BoxPilot ${__BOXPILOT_VERSION__}`}><span aria-hidden="true">B</span><div>BoxPilot<small>v{__BOXPILOT_VERSION__}</small></div></div>
            <div className="topbar-slot" ref={setTopBarSlot} />
            <ViewSwitch view={showGallery ? null : view} onSelect={setView} />
          </div>
          <CommandBar csrfToken={csrfToken} onNavigate={setView} onStart={startOperation} role={role} />
          <div className="topbar-right">
            <RefreshButton />
            <span className="connection-pill" title="How this browser reached BoxPilot">{connectionLabel(window.location)}</span>
            <ThemeSwitch compact />
            <NotificationCentre csrfToken={csrfToken} role={role} onNavigate={setView} />
            <ActivityDrawer csrfToken={csrfToken} role={role} />
            <SessionControls authStatus={authStatus} csrfToken={csrfToken} onRefresh={() => void refreshAuth()} onSignedOut={onSignedOut} />
            <TopBarClock />
          </div>
        </header>

        {nav === "sidebar"
          ? <><ShellSidebar view={showGallery ? null : view} onSelect={setView} /><div className="look-phone-dock"><ShellDock view={showGallery ? null : view} onSelect={setView} variant="dock" /></div></>
          : <ShellDock view={showGallery ? null : view} onSelect={setView} variant={nav as DockVariant} />}

        <main id="content" tabIndex={-1}>
          <div className={shell === "console" ? "content content--console" : "content content--wide"} data-density={shell === "console" ? lookChoice.density : undefined}>
            <OfflineBanner />
            {showGallery ? <Suspense fallback={<PageLoading name="the design system" />}><Gallery /></Suspense> : <>
              {!ownHeader.has(view) && <PageHeader title={copy.title} about={copy.description} />}
              {/* Keyed by the page, so the page left behind unmounts at once rather than waiting, hidden,
                  behind the next one's loading: its name in the bar would otherwise linger. */}
              <PageErrorBoundary pageName={viewLabel(view)} resetKey={view}><Suspense key={view} fallback={<PageLoading name={viewLabel(view)} />}>{pageContent}</Suspense></PageErrorBoundary>
            </>}
          </div>
        </main>
        {operationDialog}
        {approving && <DeepLinkApproval key={approving} jobId={approving} csrfToken={csrfToken} onClose={() => setApproving(null)} />}
      </div>
      </DrawnLookProvider>
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
      .then((status) => { if (!status.authenticated) { setSignedOut(signedOutReason()); forgetAccount(); } setAuthStatus(status); })
      .catch((error) => {
        // BoxPilot cannot be reached (M25.1): a device with a session that has time left opens as
        // that account, offline, to read what it kept; nothing can be changed until BoxPilot answers.
        const remembered = rememberedAccount();
        if (remembered) { setAuthStatusState({ bootstrapRequired: false, authenticated: true, owner: remembered.owner, csrfToken: "", expiresAt: remembered.expiresAt, offline: true }); return; }
        setAuthError(error instanceof Error ? error.message : "Unable to reach BoxPilot authentication");
      });
  }, [setAuthStatus]);

  // Offline, ask again as soon as BoxPilot answers; it decides whether the session still stands.
  const connection = useConnection();
  const reachable = connected(connection);
  useEffect(() => {
    if (!authStatus?.offline || !reachable) return;
    void fetchAuthStatus()
      .then((status) => { if (!status.authenticated) { setSignedOut(signedOutReason()); forgetAccount(); } setAuthStatus(status); })
      .catch(() => undefined);
  }, [authStatus?.offline, reachable, setAuthStatus]);

  // An app's "Sign in with BoxPilot" (M19.3) lands here with ?next=/oidc/authorize when the strict
  // session cookie was not sent on the cross-site hop. Once we know the owner is signed in, continue
  // the flow. Only same-site /oidc/ paths are followed, so this cannot be an open redirect.
  useEffect(() => {
    if (!authStatus?.authenticated) return;
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/oidc/")) window.location.href = next;
  }, [authStatus?.authenticated]);

  if (authError) return <SignInUnavailable problem={authError} />;
  if (!authStatus) return <SignInLoading />;
  if (!authStatus.authenticated) {
    // After signing in, continue an app's "Sign in with BoxPilot" flow if one sent us here. Only
    // same-site /oidc/ paths are followed, so this can never be an open redirect.
    const onAuthed = (status: AuthStatus) => {
      const next = new URLSearchParams(window.location.search).get("next");
      if (next && next.startsWith("/oidc/")) { window.location.href = next; return; }
      setAuthStatus(status);
    };
    const page = viewFromLocation();
    return <SignInPage bootstrapRequired={authStatus.bootstrapRequired} onAuthenticated={onAuthed} notice={signedOut && !authStatus.bootstrapRequired ? { reason: signedOut, page: page === "home" ? null : viewLabel(page) } : null} />;
  }
  return <Console authStatus={authStatus} onAuthChanged={setAuthStatus} onSignedOut={(reason) => { setSignedOut(reason); forgetSession(); setAuthStatusState({ ...authStatus, authenticated: false, owner: null, csrfToken: null, expiresAt: null }); }} />;
}

export default App;
