import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  navItems,
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
import ServicesCenter from "./ServicesCenter";
import SystemCenter from "./SystemCenter";
import UsersCenter from "./UsersCenter";
import FirewallCenter from "./FirewallCenter";
import StorageCenter from "./StorageCenter";
import ActivityDrawer from "./ActivityDrawer";
import ApprovalSettings from "./ApprovalSettings";
import NotificationSettings from "./NotificationSettings";
import SignInSettings from "./SignInSettings";
import PeopleSettings from "./PeopleSettings";
import { dropElevation, fetchAuthStatus, logoutOwner, type AuthStatus } from "./auth";
import VirtualMachines from "./VirtualMachines";

const viewCopy: Record<ViewName, { title: string; description: string; action?: string }> = {
  setup: {
    title: "Set up this server",
    description: "Pick what this server should be. BoxPilot checks what is already in place and installs the rest, in order, through the normal approved jobs.",
  },
  overview: {
    title: "Server overview",
    description: "Inspect sanitized host, service, network, storage, and Docker state from this server.",
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
  system: {
    title: "System",
    description: "Hostname, time zone, swap, and maintenance timers for this server.",
  },
  users: {
    title: "Users & SSH",
    description: "Add accounts, import SSH keys from GitHub, and control SSH password login.",
  },
  firewall: {
    title: "Firewall",
    description: "Turn ufw on or off and manage which ports are open.",
  },
  storage: {
    title: "Storage",
    description: "See disks and usage, mount filesystems permanently, and format empty disks.",
  },
  network: {
    title: "Network and DNS",
    description: "Inspect the live gateway, resolver path, and DNS listeners on this server.",
  },
  repairs: {
    title: "Prerequisites and Repair Center",
    description: "Inspect live host requirements, stage typed repairs, and verify every operation.",
  },
  virtualization: {
    title: "Virtual Machines",
    description: "Set up QEMU/KVM, inspect libvirt, and manage guarded VM lifecycle operations.",
  },
  backups: {
    title: "Backups",
    description: "BoxPilot's own database: verified snapshots and independent encrypted copies.",
  },
  github: {
    title: "GitHub provenance",
    description: "Inspect fixed public repository, commit, release, and asset-digest metadata without a GitHub token or repository write access.",
  },
  logs: {
    title: "Logs and events",
    description: "Read fixed, redacted service sources without exposing arbitrary journal queries.",
    action: "Download support bundle",
  },
  settings: {
    title: "Settings",
    description: "Review access, network, safety, and prototype capabilities.",
  },
};

const viewStatus: Record<ViewName, { label: string; tone: "live" | "sample"; description: string }> = {
  setup: { label: "Live setup state", tone: "live", description: "Every step is checked against the server before it runs; steps already done are skipped." },
  overview: {
    label: "Live sanitized inventory",
    tone: "live",
    description: "Host identity, compute, root storage, LAN addresses, Tailscale self-state, selected services, and Docker inventory come from this server. Docker labels, commands, mount paths, and environment values are excluded.",
  },
  updates: {
    label: "Live APT state",
    tone: "live",
    description: "Upgradable packages come from APT on this server. Refresh, upgrade, install, and remove run as audited root tasks after a one-click or confirm approval.",
  },
  catalog: {
    label: "Catalog manifests + live Docker state",
    tone: "live",
    description: "Apps are defined by YAML manifests shipped with BoxPilot. Installs, updates, and settings changes run as audited jobs through the helper; data stays under /var/lib/boxpilot-managed/catalog.",
  },
  services: {
    label: "Live systemd state",
    tone: "live",
    description: "Units and timers come from systemd on this server. Start/stop/restart/enable/disable run through the helper after a confirmation; BoxPilot, SSH, systemd, D-Bus, and Tailscale units cannot be stopped from here.",
  },
  system: {
    label: "Live host settings",
    tone: "live",
    description: "Hostname, time zone, memory, swap, and the fstrim timer come from this server. Changes run as audited root tasks after a confirmation.",
  },
  users: {
    label: "Live accounts and sshd state",
    tone: "live",
    description: "Accounts, sudo membership, key counts, and the effective sshd settings come from this server. Account changes confirm; sudo and password-login changes ask for the owner password.",
  },
  firewall: {
    label: "ufw configuration",
    tone: "live",
    description: "State and rules come from ufw's configuration files. Rule changes confirm; turning the firewall on or off asks for the owner password and always keeps SSH and the tailnet reachable.",
  },
  storage: {
    label: "Live block devices and fstab",
    tone: "live",
    description: "Devices and usage come from this server. Mounts are added to fstab by UUID with nofail and verified before use; formatting asks for the owner password and the typed device name.",
  },
  network: {
    label: "Network intelligence and guarded direct tests",
    tone: "live",
    description: "Routes, resolvers, LAN addresses, and Tailscale state come from this server, read-only.",
  },
  repairs: {
    label: "Live Operations Core",
    tone: "live",
    description: "Prerequisite checks, exact pinned repairs, the helper canary, and the recovery readiness kit come from this server. Repairs stage through the shared risk-tiered dialog.",
  },
  virtualization: {
    label: "Host-backed module",
    tone: "live",
    description: "Authenticated ISO staging, separately approved SHA-256-verified media import, helper-backed libvirt inventory, immutable VM plans, lifecycle approvals, offline snapshots, verified exports, encrypted restic copies, isolated restore drills, and stopped no-network recovery clones come from the server. Arbitrary image download, in-place restore, and recovery network attachment remain locked.",
  },
  backups: {
    label: "Controller and application backup engine",
    tone: "live",
    description: "BoxPilot's own database backs up here with verified restore drills and optional encrypted restic copies. App data backs up from each catalog card; VM protection lives on the Virtual Machines page.",
  },
  github: {
    label: "Credential-free public provenance",
    tone: "live",
    description: "Reads only allowlisted public GitHub metadata. Commit verification and asset digests are GitHub-reported, not locally verified. Tokens, writes, arbitrary downloads, webhooks, and workflow dispatch remain unavailable; Keel uses separate local verification and approval gates.",
  },
  logs: {
    label: "Restricted journal inventory",
    tone: "live",
    description: "BoxPilot, Docker, Tailscale, and virtualization logs use fixed unit sets, capped result sizes, and credential-pattern redaction. The server-generated support bundle applies a final configurable redaction pass. Arbitrary units and journal arguments are rejected.",
  },
  settings: {
    label: "Deployment guidance",
    tone: "sample",
    description: "These rows describe recommended deployment boundaries. BoxPilot does not currently edit router, firewall, Tailscale, or DNS settings.",
  },
};


function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`.trim()}>{children}</section>;
}

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

function Settings({ apiMode, csrfToken, role = "owner" }: { apiMode: string; csrfToken: string; role?: string }) {
  const rows = [
    ["LAN address", "Deployment specific", "Use a router DHCP reservation"],
    ["Private access", "Tailscale Serve recommended", "Keep Funnel disabled"],
    ["Tailscale DNS", "Operator controlled", "BoxPilot does not change DNS"],
    ["DNS resolvers", "Operator controlled", "BoxPilot does not replace a DNS service"],
    ["Host mutation", "Durable typed jobs only", "Plans, password approval, narrow executors"],
    ["API mode", apiMode, "Live host inspection endpoints"],
  ];

  return (
    <div className="settings-grid">
      <ApprovalSettings csrfToken={csrfToken} />
      <SignInSettings csrfToken={csrfToken} />
      <NotificationSettings csrfToken={csrfToken} />
      {role === "owner" && <PeopleSettings csrfToken={csrfToken} />}
      <Panel className="settings-panel">
        <header className="panel-header"><strong>Server and access</strong><span>Deployment guidance</span></header>
        <dl>
          {rows.map(([label, value, detail]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd><strong>{value}</strong><span>{detail}</span></dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel className="safety-panel">
        <span className="eyebrow">Safety contract</span>
        <h3>Every future change follows the same path.</h3>
        <ol>
          <li>Plan</li>
          <li>Dry run</li>
          <li>Checkpoint</li>
          <li>Approve and apply</li>
          <li>Verify or roll back</li>
        </ol>
        <p>This release can inspect libvirt and optionally run allowlisted VM lifecycle actions. Package, firewall, bridge, storage, and arbitrary command execution remain disabled.</p>
      </Panel>
    </div>
  );
}

function Console({ authStatus, onSignedOut, onAuthChanged }: { authStatus: AuthStatus; onSignedOut: () => void; onAuthChanged?: (status: AuthStatus) => void }) {
  const [view, setView] = useState<ViewName>("overview");
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
    if (view === "users") return <UsersCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "firewall") return <FirewallCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "storage") return <StorageCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "network") return <NetworkCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "repairs") return <RepairCenter csrfToken={authStatus.csrfToken ?? ""} onNavigate={setView} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "github") return <GitHubCenter />;
    if (view === "logs") return <SystemLogs csrfToken={authStatus.csrfToken ?? ""} />;
    return <Settings apiMode={apiMode} csrfToken={authStatus.csrfToken ?? ""} role={authStatus.owner?.role ?? "owner"} />;
  }, [apiMode, authStatus.csrfToken, view]);

  const downloadSupportBundle = async () => {
    setBundleError(null);
    try {
      const response = await fetch("/api/v1/support-bundle");
      const bundle = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(bundle.error ?? "Support bundle is unavailable");
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
        <div className="brand"><span>B</span><div>BoxPilot<small>Server control plane</small></div></div>
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
        <div className="prototype-label">v{__BOXPILOT_VERSION__} working platform<br />apps, repairs, backups, and VMs</div>
      </aside>

      <main>
        <header className="topbar">
          <div className="hostline">
            <div><strong>BoxPilot control plane</strong><span>Authenticated, sanitized live inventory</span></div>
            <StatusPill tone="neutral">Mixed data</StatusPill>
          </div>
          <div className="topbar-right"><ActivityDrawer />{authStatus.owner?.role && authStatus.owner.role !== "owner" ? <span className="status-pill status-neutral" title="Your role on this server">{authStatus.owner.role}</span> : null}{elevated ? <button className="text-button" type="button" title="High-risk approvals skip the password until this time. Click to lock now." onClick={() => void dropElevation(authStatus.csrfToken ?? "").then(refreshAuth)}>Elevated until {elevatedLabel} · Lock</button> : <StatusPill tone="neutral">Tiered approvals</StatusPill>}<span className="signed-in-user">{authStatus.owner?.username}</span><button className="text-button" type="button" onClick={() => void logoutOwner(authStatus.csrfToken ?? "").then(onSignedOut)}>Sign out</button></div>
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
          <section className={`surface-notice surface-${viewStatus[view].tone}`} aria-label="Data source">
            <strong>{viewStatus[view].label}</strong>
            <span>{viewStatus[view].description}</span>
          </section>
          {bundleError && <div className="auth-error" role="alert">{bundleError}</div>}
          {pageContent}
        </div>
      </main>


    </div>
  );
}

function App() {
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
