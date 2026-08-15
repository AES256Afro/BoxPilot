import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  navItems,
  type ViewName,
} from "./data";
import { inspectCompose, type ComposeInspection } from "./composeInspector";
import AuthScreen from "./AuthScreen";
import ApplicationCatalog from "./ApplicationCatalog";
import BackupCenter from "./BackupCenter";
import HostOverview from "./HostOverview";
import RepairCenter from "./RepairCenter";
import SystemLogs from "./SystemLogs";
import { fetchAuthStatus, logoutOwner, type AuthStatus } from "./auth";
import VirtualMachines from "./VirtualMachines";

type DialogName = "compose" | "migration" | null;

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
    action: "Discover source",
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
    description: "Manifests, host-backed plans, and Uptime Kuma staging are live. Pi-hole remains planning-only until DNS recovery gates pass.",
  },
  repairs: {
    label: "Live Operations Core",
    tone: "live",
    description: "Prerequisite checks, durable approvals, the helper canary, Uptime Kuma deployment, and verified backup jobs come from Bigbox. General package and application mutations remain locked.",
  },
  virtualization: {
    label: "Host-backed module",
    tone: "live",
    description: "Readiness, libvirt inventory, resources, managed ISO discovery, and plan validation come from the server. Creation remains locked.",
  },
  backups: {
    label: "Application-aware backup engine",
    tone: "live",
    description: "Uptime Kuma backup planning, durable evidence, SHA-256 integrity, source restart verification, and isolated restore drills come from Bigbox. Scheduling and off-host destinations remain pending.",
  },
  migrations: {
    label: "Workflow mockup",
    tone: "sample",
    description: "This page illustrates the planned migration sequence. Source discovery, transfer, validation, and cutover are not implemented.",
  },
  logs: {
    label: "Restricted journal inventory",
    tone: "live",
    description: "BoxPilot, Docker, Tailscale, and virtualization logs use fixed unit sets, capped result sizes, and credential-pattern redaction. Arbitrary units and journal arguments are rejected.",
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

function Migrations() {
  const steps = [
    ["Inventory source", "Read-only scan of services, stacks, volumes, users, storage, and versions."],
    ["Map and review", "Resolve ports, paths, secrets, architecture, capacity, and compatibility."],
    ["Backup and dry-run", "Checkpoint source and destination, estimate downtime, and verify free space."],
    ["Transfer and validate", "Checksum data, start in isolation, run health checks, and compare results."],
    ["Cut over with rollback", "Switch routes after approval and keep the source intact until acceptance."],
  ];

  return (
    <div className="migration-grid">
      <Panel className="flow-panel">
        <span className="eyebrow">Resumable plan</span>
        <h3>Source server to BoxPilot host</h3>
        <p>A migration workflow for containers, files, databases, and virtual machines.</p>
        <div className="flow-list">
          {steps.map(([name, description], index) => (
            <div className="flow-row" key={name}>
              <span>{index + 1}</span>
              <div>
                <strong>{name}</strong>
                <p>{description}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel className="source-panel">
        <h3>Source readiness</h3>
        <dl>
          <div><dt>Connection</dt><dd>Tailscale or LAN SSH</dd></div>
          <div><dt>Source writes</dt><dd>Read-only until cutover</dd></div>
          <div><dt>Volume transfer</dt><dd>Required</dd></div>
          <div><dt>Downtime estimate</dt><dd>Calculated after scan</dd></div>
          <div><dt>Deletion policy</dt><dd>Never automatic</dd></div>
        </dl>
      </Panel>
    </div>
  );
}

function Settings({ apiMode }: { apiMode: string }) {
  const rows = [
    ["LAN address", "Deployment specific", "Use a router DHCP reservation"],
    ["Private access", "Tailscale Serve recommended", "Keep Funnel disabled"],
    ["Tailscale DNS", "Operator controlled", "BoxPilot does not change DNS"],
    ["DNS resolvers", "Operator controlled", "BoxPilot does not replace a DNS service"],
    ["Host mutation", "VM-only when unlocked", "Token-protected libvirt allowlist"],
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
        />
      );
    }
    if (view === "repairs") return <RepairCenter csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "virtualization") return <VirtualMachines csrfToken={authStatus.csrfToken ?? ""} />;
    if (view === "backups") return <BackupCenter csrfToken={authStatus.csrfToken ?? ""} onOpenRepair={() => setView("repairs")} />;
    if (view === "migrations") return <Migrations />;
    if (view === "logs") return <SystemLogs />;
    return <Settings apiMode={apiMode} />;
  }, [apiMode, authStatus.csrfToken, view]);

  const downloadSupportBundle = async () => {
    let virtualizationAudit: Array<Record<string, unknown>> = [];
    let sanitizedInventory: Record<string, unknown> | null = null;
    try {
      const response = await fetch("/api/v1/audit?limit=100");
      const body = await response.json() as { events?: Array<Record<string, unknown>> };
      if (response.ok) virtualizationAudit = body.events ?? [];
    } catch {
      virtualizationAudit = [];
    }
    try {
      const response = await fetch("/api/v1/inventory");
      if (response.ok) sanitizedInventory = await response.json() as Record<string, unknown>;
    } catch {
      sanitizedInventory = null;
    }
    const bundle = {
      generatedAt: new Date().toISOString(),
      product: "BoxPilot",
      version: "0.7.0",
      mode: "host-aware",
      safeMode: true,
      hostMutationsEnabled: "configuration-dependent-vm-actions-only",
      inventory: sanitizedInventory,
      inventorySource: sanitizedInventory ? "sanitized-live-inventory" : "unavailable",
      events: virtualizationAudit,
      eventSource: virtualizationAudit.length ? "redacted-virtualization-audit" : "unavailable-or-empty",
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "boxpilot-support-bundle.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handlePrimaryAction = () => {
    if (view === "applications") setDialog("compose");
    if (view === "migrations") setDialog("migration");
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
        <div className="prototype-label">v0.7.0 live inventory<br />Live surfaces are labeled</div>
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

      {dialog === "migration" && (
        <Modal title="Discover a source server" onClose={() => setDialog(null)}>
          <div className="notice"><strong>Read-only discovery</strong><span>The production workflow will use an SSH connection over LAN or Tailscale and will not modify the source before cutover approval.</span></div>
          <div className="plan-grid"><span>Connection</span><strong>SSH over Tailscale</strong><span>First pass</span><strong>Containers, volumes, VMs, services, storage</strong><span>Deletion</span><strong>Never automatic</strong></div>
          <footer className="modal-actions"><button className="primary-button" type="button" onClick={() => setDialog(null)}>Discovery is disabled in prototype</button></footer>
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
