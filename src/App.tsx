import PageErrorBoundary from "./PageErrorBoundary";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  navItems,
  viewLabel,
  type ViewName,
} from "./data";
import AuthScreen from "./AuthScreen";
import BackupCenter from "./BackupCenter";
import GitHubCenter from "./GitHubCenter";
import HomeDashboard from "./HomeDashboard";
import SetupWizard from "./SetupWizard";
import HostOverview from "./HostOverview";
import NetworkCenter from "./NetworkCenter";
import RepairCenter from "./RepairCenter";
import SystemLogs from "./SystemLogs";
import UpdatesCenter from "./UpdatesCenter";
import AppCatalog from "./AppCatalog";
import AutomationsCenter from "./AutomationsCenter";
import ServicesCenter from "./ServicesCenter";
import SystemCenter from "./SystemCenter";
import PerformanceCenter from "./PerformanceCenter";
import UsersCenter from "./UsersCenter";
import FirewallCenter from "./FirewallCenter";
import StorageCenter from "./StorageCenter";
import ActivityDrawer from "./ActivityDrawer";
import ApprovalSettings from "./ApprovalSettings";
import NotificationSettings from "./NotificationSettings";
import CredentialsPanel from "./CredentialsPanel";
import SignInSettings from "./SignInSettings";
import PeopleSettings from "./PeopleSettings";
import PasswordSettings from "./PasswordSettings";
import ThemeSettings from "./ThemeSettings";
import { useTheme } from "./useTheme";
import { dropElevation, fetchAuthStatus, logoutOwner, type AuthStatus } from "./auth";
import VirtualMachines from "./VirtualMachines";

const viewCopy: Record<ViewName, { title: string; description: string; action?: string }> = {
  setup: {
    title: "Set up this server",
    description: "Pick what this server should be. BoxPilot checks what is already in place and installs the rest, in order, through the normal approved jobs.",
  },
  overview: {
    title: "Server overview",
    description: "What is running on this server and what needs attention.",
  },
  updates: {
    title: "Updates and packages",
    description: "See what Ubuntu wants to update, install it, and add or remove packages.",
  },
  catalog: {
    title: "App catalog",
    description: "Install, update, configure, and remove applications with one click.",
  },
  services: {
    title: "Services",
    description: "See what systemd is running, start or stop it, and read its journal.",
  },
  automations: {
    title: "Automations",
    description: "Chains of the operations you already trust, run in order as recorded jobs. Add one from the shelf or build your own.",
  },
  system: {
    title: "System",
    description: "Hostname, time zone, swap, and maintenance timers for this server.",
  },
  performance: {
    title: "Performance",
    description: "How hard this server is working, and what is working it. Pause or stop whatever is costing the most, right where you see the cost.",
  },
  users: {
    title: "Users & SSH",
    description: "Add accounts, import SSH keys from GitHub, and control SSH password login.",
  },
  firewall: {
    title: "Firewall",
    description: "Profiles, open ports, and suggestions based on what is listening.",
  },
  storage: {
    title: "Storage",
    description: "Disks, LVM, mounts, network shares, and sharing this server's folders.",
  },
  network: {
    title: "Network and DNS",
    description: "Gateway, DNS, devices on your LAN, and Tailscale.",
  },
  repairs: {
    title: "Repair Center",
    description: "Check prerequisites, fix what is missing, and verify every operation.",
  },
  virtualization: {
    title: "Virtual Machines",
    description: "Create and run virtual machines on QEMU/KVM.",
  },
  backups: {
    title: "Backups",
    description: "BoxPilot's own database, machine snapshots, and off-box copies.",
  },
  github: {
    title: "GitHub",
    description: "Where this BoxPilot came from: release, commit, and asset digests.",
  },
  logs: {
    title: "Logs",
    description: "Read and download logs from any unit, container, or journal group.",
    action: "Download support bundle",
  },
  settings: {
    title: "Settings",
    description: "Access, alerts, sign-in, approval mode, and theme.",
  },
};

const viewFeatures: Record<ViewName, string[]> = {
  automations: ["Ready-made flows", "Build your own", "Steps run as recorded jobs", "A failed step stops the run"],
  setup: ["Setup profiles", "Checks what is already in place", "Installs the rest in order", "Autoinstall files for a new server"],
  overview: ["Updates and failed services", "Apps and VMs running", "Backup health", "Setup checklist", "Needs attention", "Installed apps"],
  updates: ["APT updates, all or selected", "Automatic security updates", "Restart hints", "Common tools with one click", "Snapshot before upgrading", "Install and remove packages"],
  catalog: [`${__BOXPILOT_CATALOG_SIZE__} apps in 19 categories`, "Install, update, configure, uninstall", "Per-app backups and restores", "Logs and resource use", "HTTPS on your tailnet", "Image tags verified"],
  services: ["systemd units and timers", "Start, stop, restart", "Enable and disable", "Journal", "SSH, Tailscale, and BoxPilot protected"],
  system: ["Hostname", "Time zone and language", "Swap and swappiness", "fstrim", "Docker housekeeping", "UPS monitoring", "Schedules", "BoxPilot self-update"],
  performance: ["CPU, memory and swap live", "Load average and temperatures", "Disk use per filesystem", "CPU and memory per app", "Pause, resume, stop, restart", "AI services pinned to the top"],
  users: ["Accounts", "sudo membership", "SSH keys from GitHub", "Password-login policy"],
  firewall: ["Profiles", "Service presets", "Suggestions from what is listening", "fail2ban", "SSH, Tailscale, and BoxPilot always reachable"],
  storage: ["Disks and LVM", "Grow the root volume", "Snapshots with rollback", "Mount by UUID", "SMB/NFS shares with LAN discovery", "Samba and NFS servers on your tailnet", "Swap files", "Format empty disks"],
  network: ["Gateway and resolvers", "DNS listeners", "Devices on your LAN", "Wake-on-LAN", "Tailscale exit node", "Subnet router"],
  repairs: ["Prerequisite checks", "Guided repairs", "Disaster-recovery kit", "Verification after every operation"],
  virtualization: ["QEMU/KVM setup", "VMs from cloud images or ISOs", "Start, stop, snapshots", "Encrypted exports", "Restore drills", "Recover as a clone"],
  backups: ["Database backups with restore drills", "Encrypted independent copies", "Retention", "Machine snapshots", "Mirrors to a drive, SSH host, or cloud", "Restore from a snapshot"],
  github: ["Release and commit metadata", "Asset digests", "No token needed"],
  logs: ["Any unit, container, or journal group", "Tail and follow", "Filter", "Download", "Support bundle"],
  settings: ["Approval mode", "Alerts: ntfy, Gotify, webhook", "GitHub sign-in", "Tailscale sign-in", "People", "Password", "Theme"],
};


function StatusPill({ children, tone = "good" }: { children: ReactNode; tone?: string }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">Safe preview</span>
            <h2 id="dialog-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            X
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Settings({ csrfToken, role = "owner" }: { csrfToken: string; role?: string }) {
  return (
    <div className="settings-grid">
      {/* Box-level settings are the owner's; a viewer's Settings page is their own password. */}
      {role === "owner" && <ApprovalSettings csrfToken={csrfToken} />}
      {role !== "viewer" && <SignInSettings csrfToken={csrfToken} />}
      {role === "owner" && <NotificationSettings csrfToken={csrfToken} />}
      {role === "owner" && <CredentialsPanel csrfToken={csrfToken} />}
      <PasswordSettings csrfToken={csrfToken} />
      {role === "owner" && <PeopleSettings csrfToken={csrfToken} />}
      <ThemeSettings />
    </div>
  );
}

/** Deep link: /?view=firewall opens that page, and a reload keeps the page you were on (Setup included). */
function viewFromLocation(): ViewName {
  const candidate = new URLSearchParams(window.location.search).get("view");
  return candidate && Object.hasOwn(viewCopy, candidate) ? (candidate as ViewName) : "overview";
}

function Console({ authStatus, onSignedOut, onAuthChanged }: { authStatus: AuthStatus; onSignedOut: () => void; onAuthChanged?: (status: AuthStatus) => void }) {
  const [view, setViewState] = useState<ViewName>(viewFromLocation);
  const setView = useCallback((next: ViewName) => {
    setViewState(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
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

  const copy = viewCopy[view];

  useEffect(() => {
    if (typeof fetch !== "function") return;
    fetch("/api/v1/health")
      .then((response) => {
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          throw new Error("Prototype API unavailable");
        }
        return response.json() as Promise<{ mode?: string }>;
      })
      .then((health) => setApiMode(health.mode ?? "prototype"))
      .catch(() => setApiMode("browser preview"));
  }, []);

  const pageContent = useMemo(() => {
    if (view === "setup") return <SetupWizard csrfToken={authStatus.csrfToken ?? ""} onDone={() => setView("overview")} />;
    if (view === "overview") {
      return <><HomeDashboard onNavigate={setView} /><HostOverview /></>;
    }
    if (view === "updates") return <UpdatesCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "catalog") return <AppCatalog csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "services") return <ServicesCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "system") return <SystemCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "automations") return <AutomationsCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "performance") return <PerformanceCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "users") return <UsersCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "firewall") return <FirewallCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "storage") return <StorageCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "network") return <NetworkCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "repairs") return <RepairCenter csrfToken={authStatus.csrfToken ?? ""} onNavigate={setView} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "github") return <GitHubCenter />;
    if (view === "logs") return <SystemLogs csrfToken={authStatus.csrfToken ?? ""} />;
    return <Settings csrfToken={authStatus.csrfToken ?? ""} role={authStatus.owner?.role ?? "owner"} />;
  }, [apiMode, authStatus.csrfToken, view]);

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
      URL.revokeObjectURL(url);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Support bundle is unavailable");
    }
  };

  const handlePrimaryAction = () => {
    if (view === "logs") void downloadSupportBundle();
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>B</span><div>BoxPilot<small>v{__BOXPILOT_VERSION__}</small></div></div>
        <nav aria-label="Product areas">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <span>{item.short}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="private-access">
          <i />
          <div><strong>Private administration</strong><span>Tailscale HTTPS | Funnel off</span></div>
        </div>
        <div className="prototype-label">v{__BOXPILOT_VERSION__}</div>
      </aside>

      <main>
        <header className="topbar">
          <div className="hostline">
            <div><strong>BoxPilot</strong><span>Server administration</span></div>
          </div>
          <div className="topbar-right"><ActivityDrawer />{authStatus.owner?.role && authStatus.owner.role !== "owner" ? <span className="status-pill status-neutral" title="Your role on this server">{authStatus.owner.role}</span> : null}{elevated ? <button className="text-button" type="button" title="High-risk approvals skip the password until this time. Click to lock now." onClick={() => void dropElevation(authStatus.csrfToken ?? "").then(refreshAuth).catch(() => refreshAuth())}>Elevated until {elevatedLabel} · Lock</button> : <StatusPill tone="neutral">Tiered approvals</StatusPill>}<span className="signed-in-user">{authStatus.owner?.username}</span><button className="text-button" type="button" onClick={() => void logoutOwner(authStatus.csrfToken ?? "").then(onSignedOut).catch(onSignedOut)}>Sign out</button></div>
        </header>

        <div className="content">
          <header className="page-header">
            <div><span className="eyebrow">{view === "overview" ? "System overview" : "BoxPilot"}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>
            {copy.action && (
              <button className="primary-button" type="button" onClick={handlePrimaryAction}>
                {copy.action}
              </button>
            )}
          </header>
          <section className="surface-notice surface-live feature-strip" aria-label="Features">
            <strong>What you can do</strong>
            <ul className="feature-list">{viewFeatures[view].map((feature) => <li key={feature}>{feature}</li>)}</ul>
          </section>
          {bundleError && <div className="auth-error" role="alert">{bundleError}</div>}
          <PageErrorBoundary pageName={viewLabel(view)} resetKey={view}>{pageContent}</PageErrorBoundary>
        </div>
      </main>


    </div>
  );
}

function App() {
  useTheme(); // applies data-theme from localStorage
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void fetchAuthStatus()
      .then(setAuthStatus)
      .catch((error) => setAuthError(error instanceof Error ? error.message : "Unable to reach BoxPilot authentication"));
  }, []);

  if (authError) {
    return <main className="auth-shell"><section className="auth-card"><span className="eyebrow">Connection failed</span><h1>BoxPilot is unavailable</h1><p role="alert">{authError}</p><button className="secondary-button" type="button" onClick={() => window.location.reload()}>Try again</button></section></main>;
  }
  if (!authStatus) return <main className="auth-shell"><section className="auth-card"><span className="eyebrow">Private administration</span><h1>Loading BoxPilot...</h1></section></main>;
  if (!authStatus.authenticated) {
    return <AuthScreen bootstrapRequired={authStatus.bootstrapRequired} onAuthenticated={setAuthStatus} />;
  }
  return <Console authStatus={authStatus} onAuthChanged={setAuthStatus} onSignedOut={() => setAuthStatus({ ...authStatus, authenticated: false, owner: null, csrfToken: null, expiresAt: null })} />;
}

export default App;
