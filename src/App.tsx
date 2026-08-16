import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  navItems,
  type ViewName,
} from "./data";
import { inspectCompose, type ComposeInspection } from "./composeInspector";
import AuthScreen from "./AuthScreen";
import ApplicationCatalog from "./ApplicationCatalog";
import BackupCenter from "./BackupCenter";
import FleetCenter from "./FleetCenter";
import GitHubCenter from "./GitHubCenter";
import HostOverview from "./HostOverview";
import MigrationCenter from "./MigrationCenter";
import NetworkCenter from "./NetworkCenter";
import RepairCenter from "./RepairCenter";
import RouterCenter from "./RouterCenter";
import SystemLogs from "./SystemLogs";
import { fetchAuthStatus, logoutOwner, type AuthStatus } from "./auth";
import VirtualMachines from "./VirtualMachines";

type DialogName = "compose" | null;

const viewCopy: Record<ViewName, { title: string; description: string; action?: string }> = {
  overview: {
    title: "Server overview",
    description: "Inspect sanitized host, service, network, storage, and Docker state from Bigbox.",
  },
  applications: {
    title: "Applications",
    description: "Curated installs with port, storage, secret, health, and backup checks.",
    action: "Import Compose",
  },
  network: {
    title: "Network and DNS",
    description: "Inspect the live gateway and resolver path, then collect guarded DNS evidence without changing clients or routers.",
  },
  routers: {
    title: "Router checkpoints",
    description: "Record local configuration-backup identity before any future router integration or DNS change.",
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
    description: "Coverage is not complete until a restore has been tested.",
  },
  migrations: {
    title: "Migration Center",
    description: "Discover, copy, validate, and cut over without destroying the source.",
  },
  fleet: {
    title: "Fleet and agents",
    description: "Enroll signed devices for narrow node-local evidence without granting remote shell access.",
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
  overview: {
    label: "Live sanitized inventory",
    tone: "live",
    description: "Host identity, compute, root storage, LAN addresses, Tailscale self-state, selected services, and Docker inventory come from Bigbox. Docker labels, commands, mount paths, and environment values are excluded.",
  },
  applications: {
    label: "Curated application engine",
    tone: "live",
    description: "Curated deployment, backup, and recovery adapters are live. Keel 1.2.6 includes guarded native install, terminal claim, sanitized instance-owner login proof, backup, recovery rehearsal, promotion, and rollback. Router writes, client DNS cutover, and general application execution remain locked.",
  },
  network: {
    label: "Network intelligence and guarded direct tests",
    tone: "live",
    description: "Live topology remains read-only. A password-approved Pi-hole workflow can send four fixed direct DNS queries from Bigbox, and a signed enrolled agent can independently repeat them. Router credentials, router writes, and DNS cutover remain unavailable.",
  },
  routers: {
    label: "Guided router recovery and direct DNS evidence",
    tone: "live",
    description: "BoxPilot correlates Bigbox's observed gateway address with fixed router guidance, records browser-local backup hashes, and can run four approved DNS queries to the observed gateway after Flint 2 recovery declarations. Model identity, AdGuard configuration, DHCP advertisement, operating modes, and cabling remain operator checks. Credentials, sessions, writes, and DNS cutover remain unavailable.",
  },
  repairs: {
    label: "Live Operations Core",
    tone: "live",
    description: "Prerequisite checks, durable approvals, exact smartmontools, restic, and Ubuntu Docker Engine repairs, fixed APT metadata refresh, helper canary, fixed Keel artifact job, and secret-free recovery readiness kit come from Bigbox. Existing Docker providers are preserved; restic storage and repository setup remains terminal-only; general package mutation remains locked.",
  },
  virtualization: {
    label: "Host-backed module",
    tone: "live",
    description: "Helper-backed libvirt inventory, immutable VM plans, lifecycle approvals, offline snapshots, verified exports, encrypted restic copies, isolated restore drills, and stopped no-network recovery clones come from the server. In-place restore and recovery network attachment remain locked.",
  },
  backups: {
    label: "Controller and application backup engine",
    tone: "live",
    description: "BoxPilot controller, Uptime Kuma, and Pi-hole backup planning and durable SHA-256 evidence come from Bigbox. Controller state begins with a WAL-aware snapshot, and controller plus application state support separate encrypted independent exact-restore protection after terminal-only repository setup. Controller fixed no-prune retention is available; application retention and scheduling remain pending.",
  },
  migrations: {
    label: "Guarded local transfer staging",
    tone: "live",
    description: "Sanitized source manifests, compatibility plans, root-only checksummed Compose bundles, resumable managed staging, and durable transfer evidence are live. Remote SSH transport, activation, cutover, and source deletion remain unavailable.",
  },
  fleet: {
    label: "Signed one-shot agent policy",
    tone: "live",
    description: "One-time enrollment, Ed25519 requests, replay protection, and owner-approved one-shot windows for fixed Pi-hole or Flint 2 gateway proof are live. Flint 2 tasks must match the agent's own local default gateway. Recurrence, unattended jobs, arbitrary commands, targets, plugins, router writes, and DNS cutover remain unavailable.",
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

const sampleCompose = `services:
  keel:
    image: ghcr.io/example/keel:latest
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - keel-data:/data

volumes:
  keel-data:
`;

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

function Settings({ apiMode }: { apiMode: string }) {
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

function Console({ authStatus, onSignedOut }: { authStatus: AuthStatus; onSignedOut: () => void }) {
  const [view, setView] = useState<ViewName>("overview");
  const [dialog, setDialog] = useState<DialogName>(null);
  const [apiMode, setApiMode] = useState("browser preview");
  const [composeSource, setComposeSource] = useState(sampleCompose);
  const [inspection, setInspection] = useState<ComposeInspection | null>(null);
  const [networkAssessmentId, setNetworkAssessmentId] = useState<string | null>(null);
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
    if (view === "overview") {
      return <HostOverview />;
    }
    if (view === "applications") {
      return (
        <ApplicationCatalog
          csrfToken={authStatus.csrfToken ?? ""}
          onInspectCompose={() => setDialog("compose")}
          onOpenRepair={() => setView("repairs")}
          networkAssessmentId={networkAssessmentId}
          onOpenNetwork={() => setView("network")}
        />
      );
    }
    if (view === "network") return <NetworkCenter csrfToken={authStatus.csrfToken ?? ""} onAssessmentReady={setNetworkAssessmentId} onOpenRepair={() => setView("repairs")} />;
    if (view === "routers") return <RouterCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "repairs") return <RepairCenter csrfToken={authStatus.csrfToken ?? ""} onNavigate={setView} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "backups") return <BackupCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "migrations") return <MigrationCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "fleet") return <FleetCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "github") return <GitHubCenter />;
    if (view === "logs") return <SystemLogs />;
    return <Settings apiMode={apiMode} />;
  }, [apiMode, authStatus.csrfToken, networkAssessmentId, view]);

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
    if (view === "applications") setDialog("compose");
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
        <div className="prototype-label">v0.55.0 guided KVM, QEMU<br />and libvirt prerequisite install</div>
      </aside>

      <main>
        <header className="topbar">
          <div className="hostline">
            <div><strong>BoxPilot control plane</strong><span>Authenticated, sanitized live inventory</span></div>
            <StatusPill tone="neutral">Mixed data</StatusPill>
          </div>
          <div className="topbar-right"><StatusPill tone="warning">Guarded mode</StatusPill><span className="signed-in-user">{authStatus.owner?.username}</span><button className="text-button" type="button" onClick={() => void logoutOwner(authStatus.csrfToken ?? "").then(onSignedOut)}>Sign out</button></div>
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

      {dialog === "compose" && (
        <Modal title="Inspect a Compose stack" onClose={() => setDialog(null)}>
          <p className="modal-copy">Paste Compose YAML. BoxPilot performs a browser-only structural and risk scan. It does not upload or deploy the stack.</p>
          <label className="field-label" htmlFor="compose-source">Compose YAML</label>
          <textarea id="compose-source" value={composeSource} onChange={(event) => setComposeSource(event.target.value)} spellCheck="false" />
          {inspection && (
            <div className="inspection" aria-live="polite">
              <div><strong>{inspection.services}</strong><span>services</span></div>
              <div><strong>{inspection.publishedPorts}</strong><span>ports</span></div>
              <div><strong>{inspection.volumeMounts}</strong><span>mounts</span></div>
              <p>{inspection.risks.length ? inspection.risks.join(" | ") : "No high-risk patterns detected by this basic scan."}</p>
            </div>
          )}
          <footer className="modal-actions">
            <button className="text-button" type="button" onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary-button" type="button" onClick={() => setInspection(inspectCompose(composeSource))}>Run dry scan</button>
          </footer>
        </Modal>
      )}

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
  return <Console authStatus={authStatus} onSignedOut={() => setAuthStatus({ ...authStatus, authenticated: false, owner: null, csrfToken: null, expiresAt: null })} />;
}

export default App;
