import { useEffect, useId, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import type { ViewName } from "../../data";
import { formatBytes } from "../../formatBytes";
import { inspectOperation } from "../../operations";
import { connectPaths, nfsFstabLine, nfsPaths } from "../../sharePaths";
import { Button, Checkbox, EmptyState, Field, Notice, Panel, SecretInput, Segmented, Select, Sheet, Table, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";
import { CheckList, CopyLines } from "./parts";
import type { DiagnosticCheck, NfsExport, SambaShare, Scope } from "./types";
import type { NfsControl, SambaControl } from "./useSharing";

/*
 * File sharing (M33.9): this server's own file servers. Samba for Windows, macOS, Linux and phones,
 * NFS for Linux, Macs and VMs, each bound to the tailnet unless the owner adds the LAN. Shares are
 * edited as a draft and applied as one job; who may sign in, the diagnosis, and the address to type
 * on each machine follow. Adding a share is a sheet.
 */

export interface FileSharingTabProps {
  csrfToken: string;
  role: string;
  samba: SambaControl;
  nfs: NfsControl;
  /** Folders worth suggesting: mounted shares, BoxPilot's drives, /srv and /mnt. */
  folders: string[];
  /** A folder to share, from a drive's Share on network; `key` changes with each press. */
  prefill: { name: string; path: string; key: number } | null;
  /** The prefill has opened its sheet: forget it, so coming back to this tab does not open it again. */
  onPrefillUsed?: () => void;
  onChanged: () => void;
  onNavigate?: (view: ViewName) => void;
}

type Access = "users" | "selected" | "everyone";
interface ShareForm { name: string; path: string; comment: string; access: Access; users: string[]; readOnly: boolean; recycle: boolean }
const emptyForm: ShareForm = { name: "", path: "", comment: "", access: "users", users: [], readOnly: false, recycle: true };

const shareNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/.test(name) && !["global", "homes", "printers", "print$", "ipc$"].includes(name.toLowerCase());
const sambaPathValid = (path: string) => /^\/[^\0]*$/.test(path) && !path.includes("/../") && !path.endsWith("/..") && path !== "/";
const nfsPathValid = (path: string) => /^\/[^\0\s"]*$/.test(path) && !path.includes("/../") && !path.endsWith("/..") && path !== "/";
const usernameValid = (name: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name);

const scopeOptions: Array<{ value: Scope; label: string }> = [{ value: "tailscale", label: "Tailscale only" }, { value: "lan", label: "Tailscale + LAN" }];
const whoWords = (share: SambaShare) => (share.guest ? "Everyone, no password" : share.users.length ? share.users.join(", ") : "Any file-server user");

function serverState(state: { installed: boolean; running: boolean | null; configured: boolean } | null) {
  if (!state) return undefined;
  if (!state.installed) return { status: "neutral" as const, label: "Not installed" };
  if (state.running) return { status: "good" as const, label: "Running" };
  if (state.running === false) return { status: state.configured ? "warning" as const : "neutral" as const, label: "Stopped" };
  return { status: "unknown" as const, label: "Not known" };
}

export default function FileSharingTab({ csrfToken, role, samba, nfs, folders, prefill, onPrefillUsed, onChanged, onNavigate }: FileSharingTabProps) {
  const { start, dialog } = useOperation(csrfToken, (job) => {
    if (job.state === "completed" && job.type === "op:samba.apply") samba.settle();
    if (job.state === "completed" && job.type === "op:nfs.apply") nfs.settle();
    onChanged();
  });
  const may = (operationId: string) => mayStart(role, operationId);
  const canApply = may("samba.apply");
  const foldersId = useId();

  const [form, setForm] = useState<ShareForm | null>(null);
  const [user, setUser] = useState<{ name: string; password: string } | null>(null);
  const [diagnosis, setDiagnosis] = useState<{ checks: DiagnosticCheck[]; ok: boolean } | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState("");
  const [exportReadOnly, setExportReadOnly] = useState(false);

  // A drive's "Share on network" opens Add a share with the drive's folder filled in.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...emptyForm, name: prefill.name, path: prefill.path });
    onPrefillUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const state = samba.state;
  const users = state?.users ?? [];
  const live = state?.config?.shares ?? [];

  const runDiagnosis = async () => {
    setDiagnosing(true); setDiagnoseError(null);
    try { setDiagnosis((await inspectOperation<{ checks: DiagnosticCheck[]; ok: boolean }>("samba.diagnose")).result); }
    catch (requestError) { setDiagnoseError(requestError instanceof Error ? requestError.message : "File sharing could not be checked"); }
    finally { setDiagnosing(false); }
  };

  const nameFree = form ? !samba.draft.some((share) => share.name.toLowerCase() === form.name.trim().toLowerCase()) : true;
  const formValid = Boolean(form && shareNameValid(form.name.trim()) && nameFree && sambaPathValid(form.path.trim()) && (form.access !== "selected" || form.users.length > 0));
  const addShare = () => {
    if (!form || !formValid) return;
    samba.setDraft((current) => [...current, { name: form.name.trim(), path: form.path.trim().replace(/\/+$/, "") || "/", comment: form.comment.trim() || null, readOnly: form.readOnly, guest: form.access === "everyone", users: form.access === "selected" ? form.users : [], recycle: form.recycle }]);
    setForm(null);
  };

  const applySamba = () => start({
    operationId: "samba.apply",
    title: `Apply ${samba.draft.length} file share${samba.draft.length === 1 ? "" : "s"} (${samba.scope === "lan" ? "tailnet + LAN" : "tailnet only"})`,
    parameters: { workgroup: samba.workgroup, scope: samba.scope, shares: samba.draft.map((share) => ({ name: share.name, path: share.path, comment: share.comment, readOnly: share.readOnly, guest: share.guest, users: share.users, recycle: Boolean(share.recycle) })) },
    preview: (
      <div>
        <p>Writes <code>/etc/samba/smb.conf</code> bound to <code>lo</code>, <code>tailscale0</code>{samba.scope === "lan" ? ", and your LAN interface" : " and nothing else"}, validates it with <code>testparm</code>, and reloads Samba. Any existing smb.conf is kept as <code>smb.conf.before-boxpilot</code>.</p>
        <ul>{samba.draft.map((share) => <li key={share.name}><strong>{share.name}</strong> → <code>{share.path}</code> · {share.guest ? "everyone, no password" : share.users.length ? `only ${share.users.join(", ")}` : "any file-server user"} · {share.readOnly ? "read-only" : "read and write"}</li>)}</ul>
        {samba.draft.length === 0 && <p>No shares: Samba stays running with nothing shared.</p>}
      </div>
    ),
  });
  const applyNfs = () => start({
    operationId: "nfs.apply",
    title: `Apply ${nfs.draft.length} NFS export${nfs.draft.length === 1 ? "" : "s"} (${nfs.scope === "lan" ? "tailnet + LAN" : "tailnet only"})`,
    parameters: { scope: nfs.scope, exports: nfs.draft.map((entry) => ({ path: entry.path, readOnly: entry.readOnly })) },
    preview: (
      <div>
        <p>Writes <code>/etc/exports.d/boxpilot.exports</code> offering the folders to the Tailscale range (<code>100.64.0.0/10</code>){nfs.scope === "lan" ? " and your LAN subnet" : " only"}, NFSv4 only, clients mapped to each folder's owner. Validates with <code>exportfs</code> and starts <code>nfs-server</code>.</p>
        <ul>{nfs.draft.map((entry) => <li key={entry.path}><code>{entry.path}</code> · {entry.readOnly ? "read-only" : "read and write"}</li>)}</ul>
        {nfs.draft.length === 0 && <p>No exports: the NFS server stays running with nothing shared.</p>}
      </div>
    ),
  });
  const submitUser = () => {
    if (!user || !usernameValid(user.name) || user.password.length < 8) return;
    const exists = users.includes(user.name);
    const { name, password } = user;
    setUser(null);
    start({ operationId: "samba.user.set", title: `${exists ? "Update" : "Add"} file-server user ${name}`, parameters: { username: name, password }, preview: <span>Creates a shell-less Linux account <code>{name}</code> in group <code>sambashare</code> if needed and sets its Samba password. The password is kept only in memory until the job runs.</span> });
  };

  const sambaHost = samba.scope === "lan" && state?.lanAddress ? state.lanAddress : state?.tailscaleDnsName ?? state?.tailscaleAddress ?? "<this server>";
  const nfsHost = nfs.scope === "lan" && nfs.state?.lanAddress ? nfs.state.lanAddress : nfs.state?.tailscaleDnsName ?? nfs.state?.tailscaleAddress ?? "<this server>";

  const shareColumns: Array<TableColumn<SambaShare>> = [
    {
      id: "share", header: "Share", sortValue: (share) => share.name, cell: (share) => (
        <span className="storage-name">
          <strong className="storage-name__main">{share.name}</strong>
          {share.comment && <span className="storage-name__sub">{share.comment}</span>}
        </span>
      ),
    },
    { id: "folder", header: "Folder", cell: (share) => <code>{share.path}</code> },
    { id: "who", header: "Who", cell: (share) => <span className="storage-wrap">{whoWords(share)}</span> },
    {
      id: "access", header: "Access", cell: (share) => {
        const liveShare = live.find((row) => row.name === share.name);
        const bin = liveShare?.recycle ? liveShare.recycleBytes ?? 0 : null;
        return share.readOnly ? "Read-only" : (
          <span className="storage-access">
            Read and write
            <Checkbox
              label={`Recycle bin${bin ? ` (${formatBytes(bin)})` : ""}`}
              aria-label={`Recycle bin for ${share.name}`}
              checked={Boolean(share.recycle)}
              disabled={!canApply}
              onChange={(on) => samba.setDraft((current) => current.map((row) => (row.name === share.name ? { ...row, recycle: on } : row)))}
            />
          </span>
        );
      },
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (share) => {
        const liveShare = live.find((row) => row.name === share.name);
        const bin = liveShare?.recycle ? liveShare.recycleBytes ?? 0 : null;
        const scheduled = samba.autoClean[share.name];
        return (
          <span className="storage-actions">
            {bin !== null && bin > 0 && may("samba.recycle.empty") && (
              <Button risk={riskOf("samba.recycle.empty")} aria-label={`Empty the recycle bin of ${share.name}`} onClick={() => start({ operationId: "samba.recycle.empty", title: `Empty the recycle bin for ${share.name}`, parameters: { share: share.name }, preview: <span>Permanently deletes {formatBytes(bin)} of recycled files from <code>{liveShare?.path ?? share.path}/.recycle</code>. Files deleted over the share after this are recoverable again.</span> })}>Empty bin</Button>
            )}
            {bin !== null && (scheduled
              ? <span className="storage-dim">cleans weekly, keeps 30 days {may("samba.recycle.empty") && <Button variant="ghost" aria-label={`Stop cleaning ${share.name}'s bin weekly`} onClick={() => void samba.unscheduleAutoClean(scheduled)}>Stop</Button>}</span>
              : may("samba.recycle.empty") && <Button variant="ghost" title="Every week, permanently delete recycled files older than 30 days, so the bin never fills the drive." aria-label={`Clean ${share.name}'s bin weekly`} onClick={() => void samba.scheduleAutoClean(share.name)}>Clean weekly</Button>)}
            {samba.autoCleanError === share.name && <span className="storage-error" role="alert">The weekly clean could not be scheduled.</span>}
            {canApply && <Button variant="ghost" aria-label={`Remove ${share.name} from the list`} onClick={() => samba.setDraft((current) => current.filter((row) => row.name !== share.name))}>Remove</Button>}
          </span>
        );
      },
    },
  ];
  const exportColumns: Array<TableColumn<NfsExport>> = [
    { id: "folder", header: "Folder", sortValue: (entry) => entry.path, cell: (entry) => <code>{entry.path}</code> },
    { id: "access", header: "Access", cell: (entry) => (entry.readOnly ? "Read-only" : "Read and write") },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (entry) => (
        <span className="storage-actions">{may("nfs.apply") && <Button variant="ghost" aria-label={`Remove ${entry.path} from the list`} onClick={() => nfs.setDraft((current) => current.filter((item) => item.path !== entry.path))}>Remove</Button>}</span>
      ),
    },
  ];

  const normalized = exportPath.trim().replace(/\/+$/, "") || "/";
  const exportValid = nfsPathValid(exportPath.trim()) && !nfs.draft.some((entry) => entry.path === normalized);
  const sambaInstalled = state ? state.installed || Boolean(state.error) : true;
  const nfsInstalled = nfs.state ? nfs.state.installed || Boolean(nfs.state.error) : true;
  const applyBar = (dirty: boolean, configured: boolean, onApply: () => void, operationId: string, first: string) => (
    <div className="storage-apply">
      <span className="storage-apply__state ui-marked" data-status={dirty ? "warning" : configured ? "good" : "neutral"}>
        <span className="ui-mark" aria-hidden="true" />
        {dirty ? "Changes are not live until you apply." : configured ? "Everything shown is live." : "Nothing is applied yet."}
      </span>
      {may(operationId) && <Button variant="primary" risk={riskOf(operationId)} disabled={!dirty && configured} onClick={onApply}>{configured ? "Apply changes" : first}</Button>}
    </div>
  );

  return (
    <>
      {dialog}
      {/* ── Samba ── */}
      <Panel
        title="Samba (SMB)"
        count={serverState(state)}
        meta={state?.installed ? <>{samba.scope === "lan" ? "tailnet + LAN" : "tailnet only"} · <b>{live.length}</b> live · <b>{users.length}</b> {users.length === 1 ? "user" : "users"}</> : undefined}
        actions={state?.installed ? <>
          {state.configured && <Button variant="ghost" busy={diagnosing} onClick={() => void runDiagnosis()}>{diagnosing ? "Checking…" : "Check file sharing"}</Button>}
          {canApply && <Button onClick={() => setForm({ ...emptyForm })}>Add a share</Button>}
        </> : undefined}
      >
        {samba.error && <Notice tone="danger" live title="The file server could not be read" className="storage-inset" action={<Button onClick={() => void samba.refresh()}>Try again</Button>}>{samba.error}</Notice>}
        {!state && !samba.error && <p className="storage-pad storage-dim">Reading the file server…</p>}
        {state && !sambaInstalled && (
          <EmptyState title="Samba is not installed" action={may("apt.install") ? <Button risk={riskOf("apt.install")} onClick={() => start({ operationId: "apt.install", title: "Install Samba", parameters: { packages: ["samba"] }, preview: <span><code>apt-get install --no-install-recommends samba</code>. Nothing is shared until you add a share and apply.</span> })}>Install Samba</Button> : undefined}>
            Turns this server into a file server for your other devices, bound to your tailnet: phones and laptops reach it through Tailscale while nothing is exposed on the LAN or the internet.
          </EmptyState>
        )}
        {state && sambaInstalled && (
          <>
            <div className="storage-settings">
              <div className="storage-settings__item">
                <span className="storage-settings__label" id={`${foldersId}-reach`}>Reachable from</span>
                {canApply
                  ? <Segmented<Scope> label="Samba reachable from" value={samba.scope} onChange={samba.setScope} options={scopeOptions} />
                  : <span className="storage-settings__value">{samba.scope === "lan" ? "Tailscale + LAN" : "Tailscale only"}</span>}
                <span className="storage-dim">{samba.scope === "lan" ? "Also visible to devices on your home network." : "Recommended: your devices reach it anywhere, and it is invisible on the LAN."}</span>
              </div>
              <Field label="Workgroup" className="storage-settings__narrow">
                <TextInput mono value={samba.workgroup} disabled={!canApply} onValueChange={(value) => samba.setWorkgroup(value.toUpperCase())} />
              </Field>
            </div>
            {samba.scope === "lan" && (
              <Notice tone="warning" className="storage-inset" title="The firewall has to allow SMB on the LAN" action={onNavigate ? <Button variant="ghost" onClick={() => onNavigate("firewall")}>Open the Firewall page</Button> : undefined}>
                Otherwise other devices cannot connect. Tick “Windows file sharing (SMB)” on the Firewall page.
              </Notice>
            )}
            {/* Windows browses with WS-Discovery, which Samba does not answer: without wsdd a working
                share is reachable by typing its name but never appears under Network. Offered on the
                LAN, where discovery works at all; kept in view while it runs, so switching to
                tailnet-only never strands it with no way off. */}
            {(samba.scope === "lan" || state.discovery?.running) && (
              <Notice
                tone="info"
                className="storage-inset"
                title={state.discovery?.running ? "Listed under Network in Windows" : "Not listed under Network in Windows"}
                action={may("samba.discovery.set") ? (state.discovery?.running
                  ? <Button risk={riskOf("samba.discovery.set")} onClick={() => start({ operationId: "samba.discovery.set", title: "Stop showing this server in Windows", parameters: { enabled: false }, preview: <span>Stops and disables <code>wsdd</code> and withdraws the discovery rules (3702/udp, 5357/tcp). Shares keep working; Windows will need the address typed in.</span> })}>Turn off</Button>
                  : <Button risk={riskOf("samba.discovery.set")} onClick={() => start({ operationId: "samba.discovery.set", title: "Show this server in Windows", parameters: { enabled: true }, preview: <span>Installs <code>wsdd</code>, runs it, and allows the two discovery ports (3702/udp, 5357/tcp) so File Explorer lists this server under Network. Shares and permissions are unchanged.</span> })}>Show it in Windows</Button>) : undefined}
              >
                {state.discovery?.running
                  ? (samba.scope === "lan" ? "File Explorer lists this server under Network." : "Discovery only reaches devices on the LAN, so it does nothing in this scope.")
                  : "Windows browses with WS-Discovery, which Samba does not speak. Shares still work if you type the address."}
              </Notice>
            )}
            <Table
              caption="Folders this server shares over SMB"
              columns={shareColumns}
              rows={samba.draft}
              rowKey={(share) => share.name}
              empty={<EmptyState title="No shares yet" action={canApply ? <Button onClick={() => setForm({ ...emptyForm })}>Add a share</Button> : undefined}>Add one, then apply.</EmptyState>}
            />
            {diagnoseError && <Notice tone="danger" live className="storage-inset" title="File sharing could not be checked">{diagnoseError}</Notice>}
            {diagnosis && (
              <div className="storage-diagnosis" aria-live="polite">
                <p className="storage-diagnosis__head">{diagnosis.ok ? "Nothing wrong found." : "What stops another computer opening a share:"}</p>
                <CheckList checks={diagnosis.checks} empty="Nothing to check yet." />
              </div>
            )}
            {applyBar(samba.dirty, Boolean(state.configured), applySamba, "samba.apply", "Apply and start sharing")}
          </>
        )}
      </Panel>

      {state && sambaInstalled && (
        <Panel
          title="File-server users"
          count={users.length}
          meta="who may sign in to password-protected shares"
          actions={may("samba.user.set") ? <Button risk={riskOf("samba.user.set")} onClick={() => setUser({ name: "", password: "" })}>Add a user</Button> : undefined}
        >
          {users.length === 0
            ? <EmptyState title="No file-server users yet">Guest shares need none; private shares need at least one.</EmptyState>
            : (
              <ul className="storage-rows">
                {users.map((name) => (
                  <li key={name} className="storage-rows__item">
                    <code className="storage-name__main">{name}</code>
                    <span className="storage-actions">
                      {may("samba.user.set") && <Button variant="ghost" aria-label={`Change the password of ${name}`} onClick={() => setUser({ name, password: "" })}>Change password</Button>}
                      {may("samba.user.remove") && <Button risk={riskOf("samba.user.remove")} aria-label={`Remove ${name}`} onClick={() => start({ operationId: "samba.user.remove", title: `Remove file-server user ${name}`, parameters: { username: name }, preview: <span>Removes {name}'s Samba password. The Linux account is kept.</span> })}>Remove</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </Panel>
      )}

      {state?.configured && (
        <Panel
          title="Open a share from another computer"
          count={live.length}
          meta={samba.scope === "lan" && state.lanAddress ? <>LAN <b>{state.lanAddress}</b> · elsewhere the tailnet name</> : "from any device on your tailnet"}
          footer={live.some((share) => share.forceUser === null && !share.readOnly) ? "Folders owned by root are read-only for everyone until you change their owner." : undefined}
        >
          {live.length === 0
            ? <EmptyState title="Nothing is shared yet" />
            : (
              <ul className="storage-rows">
                {live.map((share) => (
                  <li key={share.name} className="storage-rows__item storage-rows__item--stack">
                    <span className="storage-name__line">
                      <strong className="storage-name__main">{share.name}</strong>
                      <code className="storage-name__sub">{share.path}</code>
                      <span className="storage-dim">{share.guest ? "no password" : "sign in with a file-server user"}{share.readOnly ? " · read-only" : ""}</span>
                    </span>
                    <CopyLines subject={share.name} lines={connectPaths({ host: sambaHost, share: share.name })} />
                  </li>
                ))}
              </ul>
            )}
        </Panel>
      )}

      {/* ── NFS ── */}
      <Panel
        title="NFS exports"
        count={serverState(nfs.state)}
        meta={nfs.state?.installed ? <>{nfs.scope === "lan" ? "tailnet + LAN" : "tailnet only"} · clients act as each folder's owner</> : undefined}
      >
        {nfs.error && <Notice tone="danger" live title="The NFS server could not be read" className="storage-inset" action={<Button onClick={() => void nfs.refresh()}>Try again</Button>}>{nfs.error}</Notice>}
        {!nfs.state && !nfs.error && <p className="storage-pad storage-dim">Reading the NFS server…</p>}
        {nfs.state && !nfsInstalled && (
          <EmptyState title="The NFS server is not installed" action={may("apt.install") ? <Button risk={riskOf("apt.install")} onClick={() => start({ operationId: "apt.install", title: "Install the NFS server", parameters: { packages: ["nfs-kernel-server"] }, preview: <span><code>apt-get install --no-install-recommends nfs-kernel-server</code>. Nothing is exported until you add a folder and apply.</span> })}>Install NFS server</Button> : undefined}>
            The faster choice for Linux machines, Macs and the VMs on this server. Windows and phones are better served by Samba above.
          </EmptyState>
        )}
        {nfs.state && nfsInstalled && (
          <>
            <div className="storage-settings">
              <div className="storage-settings__item">
                <span className="storage-settings__label">Reachable from</span>
                {may("nfs.apply")
                  ? <Segmented<Scope> label="NFS reachable from" value={nfs.scope} onChange={nfs.setScope} options={scopeOptions} />
                  : <span className="storage-settings__value">{nfs.scope === "lan" ? "Tailscale + LAN" : "Tailscale only"}</span>}
                <span className="storage-dim">{nfs.scope === "lan" ? "Also tick “NFS file sharing” on the Firewall page." : "Recommended: nothing to open on the firewall."}</span>
              </div>
            </div>
            <Table
              caption="Folders this server exports over NFS"
              columns={exportColumns}
              rows={nfs.draft}
              rowKey={(entry) => entry.path}
              empty={<EmptyState title="No exports yet">Add a folder below, then apply.</EmptyState>}
            />
            {may("nfs.apply") && (
              <form className="storage-add" onSubmit={(event) => { event.preventDefault(); if (exportValid) { nfs.setDraft((current) => [...current, { path: normalized, readOnly: exportReadOnly }]); setExportPath(""); setExportReadOnly(false); } }}>
                <Field label="Folder to export" className="storage-add__grow">
                  <TextInput mono list={`${foldersId}-folders`} placeholder="/srv/media" value={exportPath} onValueChange={setExportPath} />
                </Field>
                <Checkbox label="Read-only" checked={exportReadOnly} onChange={setExportReadOnly} />
                <Button type="submit" disabled={!exportValid}>Add export</Button>
              </form>
            )}
            {applyBar(nfs.dirty, Boolean(nfs.state.configured), applyNfs, "nfs.apply", "Apply and start exporting")}
          </>
        )}
      </Panel>

      {nfs.state?.configured && (nfs.state.config?.exports.length ?? 0) > 0 && (
        <Panel title="Mount an export from another computer" count={nfs.state.config.exports.length} meta={<>host <b>{nfsHost}</b></>}>
          <ul className="storage-rows">
            {nfs.state.config.exports.map((entry) => (
              // Each export needs its own command: a second export mounted with the first one's line
              // lands on the wrong folder without saying so.
              <li key={entry.path} className="storage-rows__item storage-rows__item--stack">
                <span className="storage-name__line"><code className="storage-name__main">{entry.path}</code><span className="storage-dim">{entry.readOnly ? "read-only" : "read and write"}</span></span>
                <CopyLines subject={entry.path} lines={[...nfsPaths({ host: nfsHost, exportPath: entry.path }), { os: "At boot", path: nfsFstabLine({ host: nfsHost, exportPath: entry.path }), hint: "the fstab line, for a VM that should mount it at boot" }]} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <datalist id={`${foldersId}-folders`}>{folders.map((folder) => <option value={folder} key={folder} />)}</datalist>

      {form && (
        <Sheet
          kicker="Samba"
          title="Add a share"
          onClose={() => setForm(null)}
          footer={<>
            {form.name.trim() && !nameFree && <span className="storage-blocker">That name is already used.</span>}
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" disabled={!formValid} onClick={addShare}>Add share</Button>
          </>}
        >
          <Field label="Share name" hint="What other computers see. Letters, digits, spaces, dots, dashes.">
            <TextInput placeholder="Media" value={form.name} onValueChange={(value) => setForm({ ...form, name: value })} />
          </Field>
          <Field label="Folder on this server">
            <TextInput mono list={`${foldersId}-folders`} placeholder="/mnt/nas-media" value={form.path} onValueChange={(value) => setForm({ ...form, path: value })} />
          </Field>
          <Field label="Description" optional>
            <TextInput placeholder="Films and series" value={form.comment} onValueChange={(value) => setForm({ ...form, comment: value })} />
          </Field>
          <Field label="Who can open it">
            <Select value={form.access} onValueChange={(value) => setForm({ ...form, access: value as Access })} options={[
              { value: "users", label: "Any file-server user (password)" },
              { value: "selected", label: "Only selected users" },
              { value: "everyone", label: "Everyone on the network, no password" },
            ]} />
          </Field>
          {form.access === "selected" && (
            <fieldset className="storage-choose">
              <legend>Allowed users</legend>
              {users.map((name) => <Checkbox key={name} label={name} aria-label={`Allow ${name}`} checked={form.users.includes(name)} onChange={(on) => setForm({ ...form, users: on ? [...new Set([...form.users, name])] : form.users.filter((entry) => entry !== name) })} />)}
              {users.length === 0 && <span className="storage-dim">Add a file-server user first.</span>}
            </fieldset>
          )}
          <Checkbox label="Read-only" checked={form.readOnly} onChange={(on) => setForm({ ...form, readOnly: on })} />
          <Checkbox label="Recycle bin" description="A file deleted over the network moves into a hidden .recycle folder on the share instead of being erased, so an accidental delete from another machine can be recovered." checked={form.recycle} disabled={form.readOnly} onChange={(on) => setForm({ ...form, recycle: on })} />
          <p className="storage-dim">Added to the list; nothing is live until you apply.</p>
        </Sheet>
      )}

      {user && (
        <Sheet
          side="center"
          size="sm"
          kicker="File-server user"
          title={users.includes(user.name) ? `Change ${user.name}'s password` : "Add a user"}
          onClose={() => setUser(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setUser(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("samba.user.set")} disabled={!usernameValid(user.name) || user.password.length < 8} onClick={submitUser}>{users.includes(user.name) ? "Change password" : "Add user"}</Button>
          </>}
        >
          <Field label="User name" hint="Lower case, no spaces. A shell-less account is created if needed." error={user.name && !usernameValid(user.name) ? "Lower case letters, digits, _ and -, starting with a letter." : undefined}>
            <TextInput mono autoComplete="off" value={user.name} onValueChange={(value) => setUser({ ...user, name: value.toLowerCase() })} />
          </Field>
          <Field label="Password" hint="8 characters or more. Kept only in memory until the job runs.">
            <SecretInput autoComplete="new-password" value={user.password} onValueChange={(value) => setUser({ ...user, password: value })} />
          </Field>
        </Sheet>
      )}
    </>
  );
}
