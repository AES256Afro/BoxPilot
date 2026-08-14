import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applications,
  backupRows,
  logRows,
  metrics,
  navItems,
  timeline,
  workloads,
  type ViewName,
} from "./data";
import { inspectCompose, type ComposeInspection } from "./composeInspector";

type DialogName = "compose" | "change" | "backup" | "migration" | null;

const viewCopy: Record<ViewName, { title: string; description: string; action?: string }> = {
  overview: {
    title: "Good morning, Chris",
    description: "The server is reachable, protected, and ready for workloads.",
    action: "Run health check",
  },
  applications: {
    title: "Applications",
    description: "Curated installs with port, storage, secret, health, and backup checks.",
    action: "Import Compose",
  },
  backups: {
    title: "Backups",
    description: "Coverage is not complete until a restore has been tested.",
    action: "New backup plan",
  },
  migrations: {
    title: "Migration Center",
    description: "Discover, copy, validate, and cut over without destroying the source.",
    action: "Discover source",
  },
  logs: {
    title: "Logs and events",
    description: "System, containers, VMs, backups, and changes in one filtered timeline.",
    action: "Download support bundle",
  },
  settings: {
    title: "Settings",
    description: "Review access, network, safety, and prototype capabilities.",
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

function Overview({ healthStatus, onReview }: { healthStatus: string; onReview: () => void }) {
  return (
    <>
      <div className="readiness">
        <div>
          <strong>Recovery readiness is healthy</strong>
          <span>Backup verified 2 hours ago | SSH and Tailscale tested | rollback point available</span>
        </div>
        <StatusPill>Protected</StatusPill>
      </div>

      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className="metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <div className="meter" aria-label={`${metric.label}: ${metric.value}`}>
              <i style={{ width: `${metric.percent}%` }} />
            </div>
          </article>
        ))}
      </div>

      <div className="dashboard-grid">
        <Panel>
          <header className="panel-header">
            <strong>Workloads</strong>
            <span>4 healthy</span>
          </header>
          <div className="workload-list">
            {workloads.map((workload) => (
              <div className="workload" key={workload.name}>
                <div>
                  <strong>{workload.name}</strong>
                  <span>{workload.detail}</span>
                </div>
                <span className="workload-kind">{workload.kind}</span>
                <StatusPill tone={workload.tone}>{workload.state}</StatusPill>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <header className="panel-header">
            <strong>Today</strong>
            <span>Audit trail</span>
          </header>
          <div className="timeline">
            {timeline.map(([time, event]) => (
              <div className="timeline-row" key={`${time}-${event}`}>
                <time>{time}</time>
                <i />
                <span>{event}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <section className="change-card">
        <div className="change-heading">
          <div>
            <span className="eyebrow">Approval required</span>
            <strong>Pending change: install 7 security updates</strong>
          </div>
          <button className="secondary-button" type="button" onClick={onReview}>
            Review plan
          </button>
        </div>
        <div className="change-steps" aria-label="Change workflow">
          <span className="done">Preflight</span>
          <span className="done">Checkpoint</span>
          <span className="current">Review</span>
          <span>Apply</span>
          <span>Verify or roll back</span>
        </div>
      </section>

      <p className="session-result" aria-live="polite">{healthStatus}</p>
    </>
  );
}

function Applications({ onInspect, onPreview }: { onInspect: () => void; onPreview: (name: string) => void }) {
  return (
    <div className="app-grid">
      {applications.map((application) => (
        <article className="app-card" key={application.name}>
          <div className="app-card-top">
            <span className="app-initials">{application.name.slice(0, 2).toUpperCase()}</span>
            <StatusPill tone={application.installed ? "good" : "neutral"}>
              {application.installed ? "Installed" : "Available"}
            </StatusPill>
          </div>
          <h3>{application.name}</h3>
          <p>{application.description}</p>
          <button
            type="button"
            className={application.installed ? "text-button" : "secondary-button"}
            onClick={() => (application.name === "Custom stack" ? onInspect() : onPreview(application.name))}
          >
            {application.status}
          </button>
        </article>
      ))}
    </div>
  );
}

function Backups() {
  return (
    <>
      <div className="readiness">
        <div>
          <strong>All protected workloads meet policy</strong>
          <span>3-2-1 destinations configured | recovery key exported | next restore drill in 12 days</span>
        </div>
        <StatusPill>4 of 4 covered</StatusPill>
      </div>
      <Panel className="table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Workload</th>
                <th>Method</th>
                <th>Destination</th>
                <th>Last backup</th>
                <th>Restore test</th>
              </tr>
            </thead>
            <tbody>
              {backupRows.map((row) => (
                <tr key={row[0]}>
                  {row.map((value, index) => (
                    <td key={value} className={index >= 3 ? (value.startsWith("Due") ? "warning-text" : "good-text") : ""}>
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
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
        <h3>Old Ubuntu server to ubuntu-server</h3>
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

function Logs() {
  return (
    <Panel className="log-panel">
      <div className="log-toolbar">
        <span>Prototype event stream</span>
        <StatusPill tone="neutral">6 events</StatusPill>
      </div>
      {logRows.map(([time, unit, message]) => (
        <div className="log-row" key={`${time}-${unit}`}>
          <time>{time}</time>
          <span>{unit}</span>
          <code>{message}</code>
        </div>
      ))}
    </Panel>
  );
}

function Settings({ apiMode }: { apiMode: string }) {
  const rows = [
    ["LAN address", "192.168.0.10", "Router DHCP reservation"],
    ["Private access", "Tailscale HTTPS", "Funnel disabled"],
    ["Tailscale DNS", "Override off", "Prevents DNS outage dependency"],
    ["DNS resolvers", "94.140.14.49, 94.140.14.59", "AdGuard DNS"],
    ["Host mutation", "Disabled", "Privileged helper not installed"],
    ["API mode", apiMode, "Read-only prototype endpoints"],
  ];

  return (
    <div className="settings-grid">
      <Panel className="settings-panel">
        <header className="panel-header"><strong>Server and access</strong><span>ubuntu-server</span></header>
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
        <p>This release cannot run commands, install packages, edit the firewall, or access Docker.</p>
      </Panel>
    </div>
  );
}

function App() {
  const [view, setView] = useState<ViewName>("overview");
  const [dialog, setDialog] = useState<DialogName>(null);
  const [selectedApplication, setSelectedApplication] = useState("security updates");
  const [healthStatus, setHealthStatus] = useState("Health check has not run in this browser session.");
  const [healthRunning, setHealthRunning] = useState(false);
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
      return <Overview healthStatus={healthStatus} onReview={() => setDialog("change")} />;
    }
    if (view === "applications") {
      return (
        <Applications
          onInspect={() => setDialog("compose")}
          onPreview={(name) => {
            setSelectedApplication(name);
            setDialog("change");
          }}
        />
      );
    }
    if (view === "backups") return <Backups />;
    if (view === "migrations") return <Migrations />;
    if (view === "logs") return <Logs />;
    return <Settings apiMode={apiMode} />;
  }, [apiMode, healthStatus, view]);

  const runHealthCheck = () => {
    setHealthRunning(true);
    setHealthStatus("Running six safe, read-only prototype checks...");
    window.setTimeout(() => {
      setHealthRunning(false);
      setHealthStatus(`Six prototype checks passed at ${new Date().toLocaleTimeString()}. No host commands were run.`);
    }, 700);
  };

  const downloadSupportBundle = () => {
    const bundle = {
      generatedAt: new Date().toISOString(),
      product: "BoxPilot",
      version: "0.1.0",
      mode: "prototype",
      safeMode: true,
      hostMutationsEnabled: false,
      server: { hostname: "ubuntu-server", lanAddress: "192.168.0.10" },
      events: logRows,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "boxpilot-support-bundle-demo.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handlePrimaryAction = () => {
    if (view === "overview") runHealthCheck();
    if (view === "applications") setDialog("compose");
    if (view === "backups") setDialog("backup");
    if (view === "migrations") setDialog("migration");
    if (view === "logs") downloadSupportBundle();
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
        <div className="prototype-label">v0.1.0 prototype<br />Host changes disabled</div>
      </aside>

      <main>
        <header className="topbar">
          <div className="hostline">
            <div><strong>ubuntu-server</strong><span>192.168.0.10 | tailnet address</span></div>
            <StatusPill>Online</StatusPill>
          </div>
          <div className="topbar-right"><StatusPill tone="warning">Safe mode</StatusPill><span className="avatar">CC</span></div>
        </header>

        <div className="content">
          <header className="page-header">
            <div><span className="eyebrow">{view === "overview" ? "System overview" : "BoxPilot"}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>
            {copy.action && (
              <button className="primary-button" type="button" onClick={handlePrimaryAction} disabled={healthRunning}>
                {healthRunning ? "Checking..." : copy.action}
              </button>
            )}
          </header>
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

      {dialog === "change" && (
        <Modal title={`Review ${selectedApplication}`} onClose={() => setDialog(null)}>
          <div className="notice warning-notice"><strong>Plan only</strong><span>The privileged helper does not exist in v0.1.0, so Apply is intentionally unavailable.</span></div>
          <ol className="review-list">
            <li><strong>Preflight</strong><span>Check OS version, free space, network, conflicting ports, and current health.</span></li>
            <li><strong>Checkpoint</strong><span>Create a recovery point and verify its destination before changes.</span></li>
            <li><strong>Apply</strong><span>Require explicit approval, stream output, and stop on failed checks.</span></li>
            <li><strong>Verify</strong><span>Run health tests and offer immediate rollback when acceptance fails.</span></li>
          </ol>
          <footer className="modal-actions"><button className="primary-button" type="button" onClick={() => setDialog(null)}>Close preview</button></footer>
        </Modal>
      )}

      {dialog === "backup" && (
        <Modal title="Create a backup plan" onClose={() => setDialog(null)}>
          <div className="notice"><strong>Keel-aware protection</strong><span>Use Keel export, preserve its managed-secret key, copy configuration, encrypt offsite data, then test a restore in isolation.</span></div>
          <div className="plan-grid"><span>Source</span><strong>Keel Notes</strong><span>Destinations</span><strong>Local NAS + encrypted offsite</strong><span>Schedule</span><strong>Daily at 02:00</strong><span>Restore drill</span><strong>Monthly</strong></div>
          <footer className="modal-actions"><button className="primary-button" type="button" onClick={() => setDialog(null)}>Save is disabled in prototype</button></footer>
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

export default App;
