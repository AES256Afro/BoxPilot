import { useCallback, useEffect, useState, type ReactNode, useRef } from "react";
import type { PendingOperation } from "./ApproveDialog";
import type { ViewName } from "./data";
import { inspectOperation } from "./operations";

interface DiagnosticCheck { id: string; state: "ok" | "problem" | "warn" | "info"; title: string; detail: string; hint: string | null; share: string | null }

interface ShareConfig { name: string; path: string; comment: string | null; readOnly: boolean; guest: boolean; users: string[]; forceUser?: string | null; recycle?: boolean; recycleBytes?: number | null }

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
interface SambaState {
  installed: boolean; running: boolean | null; configured: boolean; error: string | null;
  config: { managed: boolean; workgroup: string; scope: "tailscale" | "lan"; interfaces: string[]; shares: ShareConfig[] };
  users: string[];
  tailscaleDnsName: string | null; tailscaleAddress: string | null; lanAddress: string | null;
  discovery?: { installed: boolean; running: boolean };
}

const shareNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/.test(name) && !["global", "homes", "printers", "print$", "ipc$"].includes(name.toLowerCase());
const pathValid = (path: string) => /^\/[^\0]*$/.test(path) && !path.includes("/../") && !path.endsWith("/..") && path !== "/";
const usernameValid = (name: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name);

/**
 * "Share folders from this server": a Samba file server bound to the tailnet (and optionally
 * the LAN). The owner edits a draft of the share list and applies it as one medium-risk job.
 */
export default function SambaPanel({ start, folders, refreshKey, prefill, onNavigate, csrfToken }: { start: (operation: PendingOperation) => void; folders: string[]; refreshKey: number; prefill?: { name: string; path: string } | null; onNavigate?: (view: ViewName) => void; csrfToken?: string }) {
  const [state, setState] = useState<SambaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShareConfig[]>([]);
  const [scope, setScope] = useState<"tailscale" | "lan">("tailscale");
  const [workgroup, setWorkgroup] = useState("WORKGROUP");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [comment, setComment] = useState("");
  const [access, setAccess] = useState<"everyone" | "users" | "selected">("users");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [recycle, setRecycle] = useState(true);
  const [newUser, setNewUser] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/storage/samba");
      const body = (await response.json()) as SambaState & { error?: string | null };
      if (!response.ok) throw new Error(body.error ?? "Could not read the file server state");
      setState(body);
      setError(body.error ?? null);
      // Keep an unapplied draft: any operation on the Storage page refreshes this panel.
      if (!dirtyRef.current) {
        setDraft(body.config.shares.map((share) => ({ ...share, users: share.users ?? [] })));
        setScope(body.config.scope);
        setWorkgroup(body.config.workgroup || "WORKGROUP");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the file server state");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // "Share on network" on a drive over in the Block devices table prefills this form and scrolls
  // here, so adding a mounted drive as a share is one click rather than a hunt for the right path.
  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name); setPath(prefill.path); setComment(""); setReadOnly(false); setAccess("users");
  }, [prefill]);

  const nameFree = !draft.some((share) => share.name.toLowerCase() === name.trim().toLowerCase());
  const addValid = shareNameValid(name.trim()) && nameFree && pathValid(path.trim()) && (access !== "selected" || selectedUsers.length > 0);
  const addShare = () => {
    setDraft((current) => [...current, { name: name.trim(), path: path.trim().replace(/\/+$/, "") || "/", comment: comment.trim() || null, readOnly, guest: access === "everyone", users: access === "selected" ? selectedUsers : [], recycle }]);
    setDirty(true); setName(""); setPath(""); setComment(""); setSelectedUsers([]); setReadOnly(false); setRecycle(true); setAccess("users");
  };
  const removeShare = (shareName: string) => { setDraft((current) => current.filter((share) => share.name !== shareName)); setDirty(true); };
  const setShareRecycle = (shareName: string, on: boolean) => { setDraft((current) => current.map((share) => (share.name === shareName ? { ...share, recycle: on } : share))); setDirty(true); };

  // Auto-clean: a weekly schedule of samba.recycle.empty with an age, per share, so the bin never
  // quietly fills the drive. Same mechanism as the VPN kill-switch's "Verify weekly".
  const [autoClean, setAutoClean] = useState<Record<string, string>>({});
  const [autoCleanError, setAutoCleanError] = useState<string | null>(null);

  // "Why can't my other computer open this?" answered from the server rather than guessed at.
  const [diagnosis, setDiagnosis] = useState<{ checks: DiagnosticCheck[]; ok: boolean } | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const runDiagnosis = async () => {
    setDiagnosing(true);
    try {
      const { result } = await inspectOperation<{ checks: DiagnosticCheck[]; ok: boolean }>("samba.diagnose");
      setDiagnosis(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not check file sharing");
    } finally {
      setDiagnosing(false);
    }
  };
  const loadAutoClean = useCallback(async () => {
    try {
      const body = (await fetch("/api/v1/schedules").then((response) => (response.ok ? response.json() : { schedules: [] }))) as { schedules: Array<{ id: string; operationId: string; parameters?: { subject?: string } }> };
      setAutoClean(Object.fromEntries(body.schedules.filter((schedule) => schedule.operationId === "samba.recycle.empty" && schedule.parameters?.subject).map((schedule) => [schedule.parameters!.subject!, schedule.id])));
    } catch { /* the buttons just show the manual state */ }
  }, []);
  useEffect(() => { void loadAutoClean(); }, [loadAutoClean, refreshKey]);
  const scheduleAutoClean = async (shareName: string) => {
    if (!csrfToken) return;
    try {
      const response = await fetch("/api/v1/schedules", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ operationId: "samba.recycle.empty", parameters: { share: shareName, olderThanDays: 30 }, frequency: "weekly", minute: 0, hour: 5, weekday: 0 }) });
      setAutoCleanError(response.ok ? null : shareName);
      await loadAutoClean();
    } catch { setAutoCleanError(shareName); }
  };
  const unscheduleAutoClean = async (scheduleId: string) => {
    if (!csrfToken) return;
    try {
      await fetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } });
      await loadAutoClean();
    } catch { /* leave as-is */ }
  };
  const toggleUser = (user: string, checked: boolean) => setSelectedUsers((current) => (checked ? [...new Set([...current, user])] : current.filter((entry) => entry !== user)));

  const apply = () => start({
    operationId: "samba.apply",
    title: `Apply ${draft.length} file share${draft.length === 1 ? "" : "s"} (${scope === "lan" ? "tailnet + LAN" : "tailnet only"})`,
    parameters: { workgroup, scope, shares: draft.map((share) => ({ name: share.name, path: share.path, comment: share.comment, readOnly: share.readOnly, guest: share.guest, users: share.users, recycle: Boolean(share.recycle) })) },
    preview: (
      <div className="plan-preview">
        <p>Writes <code>/etc/samba/smb.conf</code> bound to <code>lo</code>, <code>tailscale0</code>{scope === "lan" ? ", and your LAN interface" : " and nothing else"}, validates it with <code>testparm</code>, and reloads Samba. Any existing smb.conf is kept as <code>smb.conf.before-boxpilot</code>.</p>
        <ul>{draft.map((share) => <li key={share.name}><strong>{share.name}</strong> → <code>{share.path}</code> · {share.guest ? "everyone, no password" : share.users.length ? `only ${share.users.join(", ")}` : "any file-server user"} · {share.readOnly ? "read-only" : "read and write"}</li>)}</ul>
        {draft.length === 0 && <p className="muted">No shares: Samba stays running with nothing shared.</p>}
      </div>
    ),
  });

  const connectHost = scope === "lan" && state?.lanAddress ? state.lanAddress : state?.tailscaleDnsName ?? state?.tailscaleAddress ?? "<this server>";
  const hint = (text: ReactNode) => <span className="muted">{text}</span>;

  if (state && !state.installed && !state.error) {
    return (
      <section className="panel" id="file-server">
        <header className="panel-header"><div><strong>Share folders from this server</strong><span>Turn this server into a file server for your other devices. Samba is not installed yet.</span></div>
          <button className="primary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install Samba", parameters: { packages: ["samba"] }, preview: <span><code>apt-get install --no-install-recommends samba</code>. Nothing is shared until you add a share and apply.</span> })}>Install Samba</button>
        </header>
        <p className="muted">Shares are bound to your tailnet by default, so phones and laptops reach them from anywhere through Tailscale while nothing is exposed on the LAN or the internet.</p>
      </section>
    );
  }

  return (
    <section className="panel" id="file-server">
      <header className="panel-header">
        <div><strong>Share folders from this server</strong><span>Windows, macOS, Linux, and phones connect with SMB. Bound to your tailnet{scope === "lan" ? " and the LAN" : " only"}.</span></div>
        <span className={`status-pill ${state?.running ? "status-good" : "status-neutral"}`}>{state === null ? "…" : state.running ? "Running" : state.running === false ? "Stopped" : "Unknown"}</span>
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="samba-scope">
        <label><input type="radio" name="samba-scope" checked={scope === "tailscale"} onChange={() => { setScope("tailscale"); setDirty(true); }} /> <strong>Tailscale only</strong> {hint("recommended, reachable from your devices anywhere, invisible on the LAN")}</label>
        <label><input type="radio" name="samba-scope" checked={scope === "lan"} onChange={() => { setScope("lan"); setDirty(true); }} /> <strong>Tailscale + LAN</strong> {hint("also visible to devices on your home network")}</label>
        <label className="samba-workgroup">Workgroup <input aria-label="Workgroup" value={workgroup} onChange={(event) => { setWorkgroup(event.target.value.toUpperCase()); setDirty(true); }} /></label>
      </div>
      {scope === "lan" && (
        <p className="samba-firewall-note muted">On the LAN, the firewall also has to allow SMB, or other devices cannot connect.{" "}
          {onNavigate
            ? <button className="text-button" type="button" onClick={() => onNavigate("firewall")}>Open the Firewall page</button>
            : <>Tick “Windows file sharing (SMB)” on the Firewall page.</>}
        </p>
      )}
      {/* Windows browses with WS-Discovery, which Samba does not answer: without this a working
          share is reachable by typing its name but never appears under Network in File Explorer. */}
      {/* Offered on the LAN, where discovery works at all; but if it is already running it stays
          visible in every scope, so switching to tailnet-only never strands it with no way off. */}
      {state && (scope === "lan" || state.discovery?.running) && (
        <p className="samba-discovery muted">
          {state.discovery?.running
            ? <>This server appears under <strong>Network</strong> in Windows File Explorer{scope === "lan" ? "" : " (which only reaches devices on the LAN, so it does nothing in this scope)"}.{" "}
                <button className="text-button" type="button" onClick={() => start({ operationId: "samba.discovery.set", title: "Stop showing this server in Windows", parameters: { enabled: false }, preview: <span>Stops and disables <code>wsdd</code> and withdraws the discovery rules (3702/udp, 5357/tcp). Shares keep working; Windows will need the address typed in.</span> })}>turn off</button></>
            : <>Windows does not list this server under <strong>Network</strong> yet: Windows browses with WS-Discovery, which Samba does not speak. Shares still work if you type the address.{" "}
                <button className="text-button" type="button" onClick={() => start({ operationId: "samba.discovery.set", title: "Show this server in Windows", parameters: { enabled: true }, preview: <span>Installs <code>wsdd</code>, runs it, and allows the two discovery ports (3702/udp, 5357/tcp) so File Explorer lists this server under Network. Shares and permissions are unchanged.</span> })}>Show it in Windows</button></>}
        </p>
      )}

      <div className="samba-users">
        <strong>Users</strong> {hint("who may sign in to password-protected shares")}
        <div className="share-list">
          {state?.users.length === 0 && <span className="muted">No users yet. Guest shares need none; private shares need at least one.</span>}
          {state?.users.map((user) => <span className="status-pill status-neutral" key={user}>{user} <button className="text-button" type="button" aria-label={`Remove ${user}`} onClick={() => start({ operationId: "samba.user.remove", title: `Remove file-server user ${user}`, parameters: { username: user }, preview: <span>Removes {user}'s Samba password. The Linux account is kept.</span> })}>×</button></span>)}
        </div>
        <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); if (usernameValid(newUser) && newPassword.length >= 8) { start({ operationId: "samba.user.set", title: `${state?.users.includes(newUser) ? "Update" : "Add"} file-server user ${newUser}`, parameters: { username: newUser, password: newPassword }, preview: <span>Creates a shell-less Linux account <code>{newUser}</code> in group <code>sambashare</code> if needed and sets its Samba password. The password is kept only in memory until the job runs.</span> }); setNewPassword(""); } }}>
          <input aria-label="New user name" placeholder="username" autoComplete="off" value={newUser} onChange={(event) => setNewUser(event.target.value.toLowerCase())} />
          <input aria-label="New user password" type="password" placeholder="password (8+ characters)" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <button className="secondary-button" type="submit" disabled={!usernameValid(newUser) || newPassword.length < 8}>{state?.users.includes(newUser) ? "Change password" : "Add user"}</button>
        </form>
      </div>

      <div className="table-scroll">
        <table>
          <thead><tr><th>Share</th><th>Folder</th><th>Who</th><th>Access</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {draft.length === 0 && <tr><td colSpan={5} className="muted">No shares yet. Add one below, then Apply.</td></tr>}
            {draft.map((share) => {
              const live = state?.config.shares.find((row) => row.name === share.name);
              const bin = live?.recycle ? live.recycleBytes ?? 0 : null; // bytes if this share's recycle bin is live, else null
              return (
                <tr key={share.name}>
                  <td><strong>{share.name}</strong>{share.comment && <span className="muted">, {share.comment}</span>}</td>
                  <td><code>{share.path}</code></td>
                  <td>{share.guest ? "Everyone (no password)" : share.users.length ? share.users.join(", ") : "Any user"}</td>
                  <td>{share.readOnly ? "Read-only" : <>Read &amp; write{" "}<label className="share-recycle-toggle muted" title="Keep files deleted over the network in a hidden .recycle folder on the share, so they can be recovered."><input type="checkbox" checked={Boolean(share.recycle)} onChange={(event) => setShareRecycle(share.name, event.target.checked)} /> recycle bin{bin ? ` (${formatBytes(bin)})` : ""}</label></>}</td>
                  <td>
                    {bin !== null && bin > 0 && <button className="text-button" type="button" onClick={() => start({ operationId: "samba.recycle.empty", title: `Empty the recycle bin for ${share.name}`, parameters: { share: share.name }, preview: <span>Permanently deletes {formatBytes(bin)} of recycled files from <code>{live?.path ?? share.path}/.recycle</code>. Files deleted over the share after this are recoverable again.</span> })}>Empty bin</button>}
                    {bin !== null && csrfToken && (autoClean[share.name]
                      ? <span className="muted share-autoclean">auto-cleans weekly (keeps 30 days) <button className="text-button" type="button" onClick={() => void unscheduleAutoClean(autoClean[share.name])}>stop</button></span>
                      : <button className="text-button" type="button" title="Every week, permanently delete recycled files older than 30 days, so the bin never fills the drive." onClick={() => void scheduleAutoClean(share.name)}>Auto-clean</button>)}
                    {autoCleanError === share.name && <span className="share-error">could not schedule auto-clean</span>}
                    <button className="text-button" type="button" onClick={() => removeShare(share.name)}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form className="share-form" onSubmit={(event) => { event.preventDefault(); if (addValid) addShare(); }}>
        <label>Share name<input aria-label="New share name" placeholder="Media" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Folder on this server
          <input aria-label="New share folder" list="samba-folders" placeholder="/mnt/nas-media" value={path} onChange={(event) => setPath(event.target.value)} />
          <datalist id="samba-folders">{folders.map((folder) => <option value={folder} key={folder} />)}</datalist>
        </label>
        <label>Description {hint("(optional)")}<input aria-label="New share description" placeholder="Films and series" value={comment} onChange={(event) => setComment(event.target.value)} /></label>
        <label>Who can open it
          <select aria-label="New share access" value={access} onChange={(event) => setAccess(event.target.value as "everyone" | "users" | "selected")}>
            <option value="users">Any file-server user (password)</option>
            <option value="selected">Only selected users</option>
            <option value="everyone">Everyone on the network, no password</option>
          </select>
        </label>
        {access === "selected" && <div className="share-list">{(state?.users ?? []).map((user) => <label key={user}><input type="checkbox" checked={selectedUsers.includes(user)} onChange={(event) => toggleUser(user, event.target.checked)} aria-label={`Allow ${user}`} /> {user}</label>)}{(state?.users.length ?? 0) === 0 && <span className="muted">Add a user first.</span>}</div>}
        <label className="cloud-vm-check share-readonly"><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />read-only</label>
        <label className="cloud-vm-check share-recycle" title="A file deleted over the network moves into a hidden .recycle folder on the share instead of being erased, so an accidental delete from another machine can be recovered."><input type="checkbox" checked={recycle} disabled={readOnly} onChange={(event) => setRecycle(event.target.checked)} />recycle bin (keep deleted files)</label>
        <div className="recovery-actions share-actions">
          <button className="secondary-button" type="submit" disabled={!addValid}>Add share</button>
          {name.trim() && !nameFree && <span className="muted">That name is already used.</span>}
        </div>
      </form>

      <div className="recovery-actions samba-apply">
        <button className="primary-button" type="button" disabled={!dirty && Boolean(state?.configured)} onClick={apply}>{state?.configured ? "Apply changes" : "Apply and start sharing"}</button>
        {dirty && <span className="muted">Changes are not live until you apply.</span>}
        {!dirty && state?.configured && <span className="muted">Everything shown is live.</span>}
      </div>

      {state?.configured && (
        <div className="samba-diagnose">
          <button className="secondary-button" type="button" disabled={diagnosing} onClick={() => void runDiagnosis()}>{diagnosing ? "Checking..." : "Check file sharing"}</button>
          <span className="muted">Says what is actually wrong when another computer cannot open a share.</span>
          {diagnosis && (
            <ul className="diagnose-results">
              {diagnosis.checks.map((check) => (
                <li key={check.id} className={`diagnose-${check.state}`}>
                  <span className="diagnose-mark" aria-hidden="true">{check.state === "ok" ? "✓" : check.state === "problem" ? "!" : check.state === "warn" ? "•" : "i"}</span>
                  <span className="diagnose-body">
                    <strong>{check.title}</strong>
                    <span>{check.detail}{check.hint ? ` ${check.hint}` : ""}</span>
                  </span>
                </li>
              ))}
              {diagnosis.checks.length === 0 && <li className="muted">Nothing to check yet.</li>}
            </ul>
          )}
        </div>
      )}

      {state?.configured && (
        <div className="muted share-note">
          {/* Every applied share, with the exact text to paste on each platform. Windows needs the
              backslash form typed into File Explorer's address bar; macOS and Linux take a URL. */}
          <strong>Open a share from another computer</strong>
          <ul className="share-connect">
            {state.config.shares.map((share) => (
              <li key={share.name}>
                <strong>{share.name}</strong>
                <span>Windows <code>\\{connectHost}\{share.name}</code></span>
                <span>macOS, Linux <code>smb://{connectHost}/{share.name}</code></span>
                <span>{share.guest ? "no password" : "sign in with a file-server user"}</span>
              </li>
            ))}
          </ul>
          {state.config.shares.length === 0 && <p>Nothing is shared yet.</p>}
          {scope === "tailscale" && <p>Works from any device signed into your tailnet, nowhere else.</p>}
          {scope === "lan" && state.lanAddress && <p>On the LAN use <code>{state.lanAddress}</code>; from outside use the Tailscale name.</p>}
          {state.config.shares.some((share) => share.forceUser === null && !share.readOnly) && <p>Folders owned by root are read-only for everyone until you change their owner.</p>}
        </div>
      )}
    </section>
  );
}
