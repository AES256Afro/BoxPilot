import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface SnapshotEntry { artifact: string; sizeBytes: number | null; createdAt: string | null; checksumSha256: string | null; apps: number | null }
interface Sources { sources: Array<{ source: "local" | "mirror"; root: string; available: boolean; snapshots: SnapshotEntry[] }>; mount: { mounted: boolean; blocker: string | null } }
/** Snapshots on drives BoxPilot did not write to — how a rebuilt server finds the old one's. */
interface Discovered { locations: Array<{ root: string; mount: { target: string; source: string; filesystem: string }; snapshots: SnapshotEntry[] }> }
interface Option { key: string; source: "local" | "mirror" | "discovered"; root: string | null; where: string; snapshot: SnapshotEntry }
interface Described { source: string; artifact: string; createdAt: string | null; apps: Array<{ id: string; installed: boolean; newestBackup: string | null; dataAvailable: boolean; dataLocation: string | null }>; system: { netplanFiles?: number; ufwFiles?: number; fstab?: boolean } | null; vms: { domains: string[]; disksIncluded?: boolean; diskRepositoryReachable?: boolean } | null }

function formatBytes(value: number | null) {
  if (!value) return "—";
  const units = ["B", "KiB", "MiB", "GiB"]; let size = value; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * Backups → Restore from a machine snapshot: pick one, choose apps, restore.
 *
 * The snapshots offered are this server's own, the configured off-box mirror's, and — the one that
 * makes a rebuild possible — any found on a drive or share that is simply mounted. A reinstalled
 * server has none of its own and no destination configured, because what described the destination
 * was on the disk that died; mounting the drive from the Storage page is the way back in.
 */
export default function RestorePanel({ csrfToken, start }: { csrfToken: string; start: (operation: PendingOperation) => void }) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [discovered, setDiscovered] = useState<Discovered | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [described, setDescribed] = useState<Described | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoreData, setRestoreData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Sources>("host.snapshot.sources");
      setSources(result);
      setError(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not list snapshots"); }
    // Scanning the mounted drives is slower and less important than listing our own, so it does not
    // hold up the list — and a drive that will not answer must not empty the page.
    try { const { result } = await inspectOperation<Discovered>("host.snapshot.discover"); setDiscovered(result); } catch { setDiscovered({ locations: [] }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Keyed by position rather than by "source:artifact": a discovered root is a filesystem path and
  // splitting one on a colon is a bug waiting for the first drive mounted at an odd place.
  const options: Option[] = [
    ...(sources?.sources ?? []).flatMap((entry) => entry.snapshots.map((snapshot) => ({
      source: entry.source, root: null, where: entry.source === "mirror" ? "Backup drive" : "This server", snapshot,
    }))),
    ...(discovered?.locations ?? []).flatMap((location) => location.snapshots.map((snapshot) => ({
      source: "discovered" as const, root: location.root, where: `${location.mount.source} (${location.mount.filesystem})`, snapshot,
    }))),
  ].map((option, index) => ({ ...option, key: String(index) }));

  const describe = async (key: string) => {
    setChoice(key); setDescribed(null); setSelected(new Set());
    if (!key) return;
    const option = options.find((candidate) => candidate.key === key);
    if (!option) return;
    setLoading(true); setError(null);
    try {
      const parameters = { source: option.source, artifact: option.snapshot.artifact, ...(option.root ? { root: option.root } : {}) };
      const response = await fetch("/api/v1/operations/host.snapshot.describe/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
      const body = (await response.json()) as { result?: Described; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the snapshot");
      setDescribed(body.result);
      setSelected(new Set(body.result.apps.filter((app) => app.installed).map((app) => app.id)));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the snapshot");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const chosen = options.find((option) => option.key === choice);

  return (
    <section className="panel">
      <header className="panel-header">
        <div><strong>Restore from a machine snapshot</strong><span>Rebuild this box's apps from a snapshot taken here or carried over on the backup drive. Apps are reinstalled with their saved settings and secrets, then their newest data archive is restored.</span></div>
        <button className="text-button" type="button" onClick={() => void refresh()}>Refresh</button>
      </header>
      <div className="approval-settings">
        <label>Snapshot
          <select aria-label="Snapshot to restore" value={choice} onChange={(event) => void describe(event.target.value)}>
            <option value="">Choose a snapshot…</option>
            {options.map((option) => <option key={option.key} value={option.key}>{option.where} · {option.snapshot.createdAt ? new Date(option.snapshot.createdAt).toLocaleString() : option.snapshot.artifact} · {formatBytes(option.snapshot.sizeBytes)}{option.snapshot.apps !== null ? ` · ${option.snapshot.apps} apps` : ""}</option>)}
          </select>
        </label>
        {sources && !sources.mount.mounted && options.length === 0 && <span className="muted">{sources.mount.blocker ?? "No snapshots here or on any mounted drive. If you have one on a drive or a network share, mount it from the Storage page and refresh. A rebuilt server finds it that way."}</span>}
        {discovered && discovered.locations.length > 0 && <span className="muted">Also found {discovered.locations.reduce((total, location) => total + location.snapshots.length, 0)} snapshot(s) on {discovered.locations.map((location) => location.mount.source).join(", ")}, which this server did not write.</span>}
        {loading && <span className="muted">Reading the snapshot…</span>}
        {described && (
          <>
            <div className="table-scroll">
              <table>
                <thead><tr><th aria-label="Select" /><th>App</th><th>In snapshot</th><th>Data archive</th></tr></thead>
                <tbody>
                  {described.apps.length === 0 && <tr><td colSpan={4}>This snapshot has no apps.</td></tr>}
                  {described.apps.map((app) => (
                    <tr key={app.id}>
                      <td><input type="checkbox" aria-label={`Restore ${app.id}`} checked={selected.has(app.id)} onChange={() => toggle(app.id)} /></td>
                      <td><code>{app.id}</code></td>
                      <td>{app.installed ? "installed" : "not installed"}</td>
                      <td>{app.newestBackup ? (app.dataAvailable ? <span className="status-pill status-good">{app.dataLocation === "mirror" ? "on backup drive" : "local"}</span> : <span className="status-pill status-warning">not reachable</span>) : <span className="muted">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="cloud-vm-check"><input type="checkbox" checked={restoreData} onChange={(event) => setRestoreData(event.target.checked)} /> Restore each app's newest data archive after installing it</label>
            <p className="muted">Network, firewall, fstab, VM definitions{described.vms?.domains?.length ? ` (${described.vms.domains.join(", ")})` : ""}, and the database copy are staged under the snapshot folder for you to review. They are never applied automatically.</p>
            {described.vms?.domains?.length ? (
              <p className="muted">A snapshot holds VM definitions, not their disks. Those come from the encrypted VM repository, which is {described.vms.diskRepositoryReachable ? "reachable now" : "not reachable right now. Mount the backup drive before restoring a VM"}.</p>
            ) : null}
            <footer className="recovery-actions">
              <button className="primary-button" type="button" disabled={!chosen || selected.size === 0} onClick={() => chosen && start({ operationId: "host.snapshot.restore", title: `Restore ${selected.size} app${selected.size === 1 ? "" : "s"} from snapshot`, parameters: { source: chosen.source, artifact: chosen.snapshot.artifact, ...(chosen.root ? { root: chosen.root } : {}), apps: [...selected], restoreData }, preview: <span>Reinstalls {[...selected].join(", ")} from <code>{chosen.snapshot.artifact}</code>{chosen.root ? <> on <code>{chosen.where}</code></> : null}{restoreData ? " and restores each one's newest data archive (a safety copy of any existing data is taken first)" : " without touching data"}. Apps already installed on this box are skipped.</span> })}>Restore selected</button>
            </footer>
          </>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
