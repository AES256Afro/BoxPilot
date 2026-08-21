import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";

interface ExportConfig { path: string; readOnly: boolean; clients?: string[] }
interface NfsState {
  installed: boolean; running: boolean | null; configured: boolean; error: string | null;
  config: { managed: boolean; scope: "tailscale" | "lan"; exports: ExportConfig[] };
  tailscaleDnsName: string | null; tailscaleAddress: string | null; lanAddress: string | null;
}
const pathValid = (path: string) => /^\/[^\0\s"]*$/.test(path) && !path.includes("/../") && !path.endsWith("/..") && path !== "/";

/** "Export folders over NFS": for Linux and macOS clients and for VMs, tailnet-only by default. */
export default function NfsPanel({ start, folders, refreshKey }: { start: (operation: PendingOperation) => void; folders: string[]; refreshKey: number }) {
  const [state, setState] = useState<NfsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExportConfig[]>([]);
  const [scope, setScope] = useState<"tailscale" | "lan">("tailscale");
  const [dirty, setDirty] = useState(false);
  const [path, setPath] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/storage/nfs");
      const body = (await response.json()) as NfsState & { error?: string | null };
      if (!response.ok) throw new Error(body.error ?? "Could not read the NFS state");
      setState(body);
      setError(body.error ?? null);
      setDraft(body.config.exports.map((entry) => ({ path: entry.path, readOnly: entry.readOnly })));
      setScope(body.config.scope);
      setDirty(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the NFS state");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const normalized = path.trim().replace(/\/+$/, "") || "/";
  const addValid = pathValid(path.trim()) && !draft.some((entry) => entry.path === normalized);
  const apply = () => start({
    operationId: "nfs.apply",
    title: `Apply ${draft.length} NFS export${draft.length === 1 ? "" : "s"} (${scope === "lan" ? "tailnet + LAN" : "tailnet only"})`,
    parameters: { scope, exports: draft.map((entry) => ({ path: entry.path, readOnly: entry.readOnly })) },
    preview: (
      <div className="plan-preview">
        <p>Writes <code>/etc/exports.d/boxpilot.exports</code> offering the folders to the Tailscale range (<code>100.64.0.0/10</code>){scope === "lan" ? " and your LAN subnet" : " only"}, NFSv4 only, clients mapped to each folder's owner. Validates with <code>exportfs</code> and starts <code>nfs-server</code>.</p>
        <ul>{draft.map((entry) => <li key={entry.path}><code>{entry.path}</code> · {entry.readOnly ? "read-only" : "read and write"}</li>)}</ul>
        {draft.length === 0 && <p className="muted">No exports: the NFS server stays running with nothing shared.</p>}
      </div>
    ),
  });
  const host = scope === "lan" && state?.lanAddress ? state.lanAddress : state?.tailscaleDnsName ?? state?.tailscaleAddress ?? "<this server>";

  if (state && !state.installed) {
    return (
      <section className="panel" id="nfs-server">
        <header className="panel-header"><div><strong>Export folders over NFS</strong><span>For Linux and macOS clients and for VMs on this server. The NFS server is not installed yet.</span></div>
          <button className="primary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install the NFS server", parameters: { packages: ["nfs-kernel-server"] }, preview: <span><code>apt-get install --no-install-recommends nfs-kernel-server</code>. Nothing is exported until you add a folder and apply.</span> })}>Install NFS server</button>
        </header>
        <p className="muted">Windows and phones are better served by the Samba file server above; NFS is the faster choice for Linux machines, Macs, and the VMs you create here.</p>
      </section>
    );
  }

  return (
    <section className="panel" id="nfs-server">
      <header className="panel-header">
        <div><strong>Export folders over NFS</strong><span>Linux, macOS, and VMs mount these natively. Offered to your tailnet{scope === "lan" ? " and the LAN" : " only"}; clients act as each folder's owner.</span></div>
        <span className={`status-pill ${state?.running ? "status-good" : "status-neutral"}`}>{state === null ? "…" : state.running ? "Running" : state.running === false ? "Stopped" : "Unknown"}</span>
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="samba-scope">
        <label><input type="radio" name="nfs-scope" checked={scope === "tailscale"} onChange={() => { setScope("tailscale"); setDirty(true); }} /> <strong>Tailscale only</strong> <span className="muted">recommended; nothing to open on the firewall</span></label>
        <label><input type="radio" name="nfs-scope" checked={scope === "lan"} onChange={() => { setScope("lan"); setDirty(true); }} /> <strong>Tailscale + LAN</strong> <span className="muted">also tick “NFS file sharing” on the Firewall page</span></label>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Folder</th><th>Access</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {draft.length === 0 && <tr><td colSpan={3} className="muted">No exports yet. Add a folder below, then Apply.</td></tr>}
            {draft.map((entry) => (
              <tr key={entry.path}>
                <td><code>{entry.path}</code></td>
                <td>{entry.readOnly ? "Read-only" : "Read & write"}</td>
                <td><button className="text-button" type="button" onClick={() => { setDraft((current) => current.filter((item) => item.path !== entry.path)); setDirty(true); }}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="share-form" onSubmit={(event) => { event.preventDefault(); if (addValid) { setDraft((current) => [...current, { path: normalized, readOnly }]); setDirty(true); setPath(""); setReadOnly(false); } }}>
        <label>Folder on this server
          <input aria-label="New export folder" list="nfs-folders" placeholder="/srv/media" value={path} onChange={(event) => setPath(event.target.value)} />
          <datalist id="nfs-folders">{folders.map((folder) => <option value={folder} key={folder} />)}</datalist>
        </label>
        <label className="cloud-vm-check share-readonly"><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />read-only</label>
        <div className="recovery-actions share-actions"><button className="secondary-button" type="submit" disabled={!addValid}>Add export</button></div>
      </form>
      <div className="recovery-actions samba-apply">
        <button className="primary-button" type="button" disabled={!dirty && Boolean(state?.configured)} onClick={apply}>{state?.configured ? "Apply changes" : "Apply and start exporting"}</button>
        {dirty && <span className="muted">Changes are not live until you apply.</span>}
      </div>
      {state?.configured && draft.length > 0 && (
        <p className="muted share-note">
          <strong>Mount it:</strong> Linux <code>sudo mount -t nfs4 {host}:{draft[0].path} /mnt/{draft[0].path.split("/").filter(Boolean).at(-1)}</code> · macOS Finder → Go → Connect to Server → <code>nfs://{host}{draft[0].path}</code> · in a VM, add <code>{host}:{draft[0].path}  /mnt/share  nfs4  defaults,nofail,_netdev  0 0</code> to fstab.
        </p>
      )}
    </section>
  );
}
