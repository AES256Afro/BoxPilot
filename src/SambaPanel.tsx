import { useCallback, useEffect, useState, type ReactNode, useRef } from "react";
import type { PendingOperation } from "./ApproveDialog";

interface ShareConfig { name: string; path: string; comment: string | null; readOnly: boolean; guest: boolean; users: string[]; forceUser?: string | null }
interface SambaState {
  installed: boolean; running: boolean | null; configured: boolean; error: string | null;
  config: { managed: boolean; workgroup: string; scope: "tailscale" | "lan"; interfaces: string[]; shares: ShareConfig[] };
  users: string[];
  tailscaleDnsName: string | null; tailscaleAddress: string | null; lanAddress: string | null;
}

const shareNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/.test(name) && !["global", "homes", "printers", "print$", "ipc$"].includes(name.toLowerCase());
const pathValid = (path: string) => /^\/[^\0]*$/.test(path) && !path.includes("/../") && !path.endsWith("/..") && path !== "/";
const usernameValid = (name: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name);

/**
 * "Share folders from this server": a Samba file server bound to the tailnet (and optionally
 * the LAN). The owner edits a draft of the share list and applies it as one medium-risk job.
 */
export default function SambaPanel({ start, folders, refreshKey }: { start: (operation: PendingOperation) => void; folders: string[]; refreshKey: number }) {
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

  const nameFree = !draft.some((share) => share.name.toLowerCase() === name.trim().toLowerCase());
  const addValid = shareNameValid(name.trim()) && nameFree && pathValid(path.trim()) && (access !== "selected" || selectedUsers.length > 0);
  const addShare = () => {
    setDraft((current) => [...current, { name: name.trim(), path: path.trim().replace(/\/+$/, "") || "/", comment: comment.trim() || null, readOnly, guest: access === "everyone", users: access === "selected" ? selectedUsers : [] }]);
    setDirty(true); setName(""); setPath(""); setComment(""); setSelectedUsers([]); setReadOnly(false); setAccess("users");
  };
  const removeShare = (shareName: string) => { setDraft((current) => current.filter((share) => share.name !== shareName)); setDirty(true); };
  const toggleUser = (user: string, checked: boolean) => setSelectedUsers((current) => (checked ? [...new Set([...current, user])] : current.filter((entry) => entry !== user)));

  const apply = () => start({
    operationId: "samba.apply",
    title: `Apply ${draft.length} file share${draft.length === 1 ? "" : "s"} (${scope === "lan" ? "tailnet + LAN" : "tailnet only"})`,
    parameters: { workgroup, scope, shares: draft.map((share) => ({ name: share.name, path: share.path, comment: share.comment, readOnly: share.readOnly, guest: share.guest, users: share.users })) },
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
        <label><input type="radio" name="samba-scope" checked={scope === "lan"} onChange={() => { setScope("lan"); setDirty(true); }} /> <strong>Tailscale + LAN</strong> {hint("also visible to devices on your home network; tick “Windows file sharing (SMB)” on the Firewall page")}</label>
        <label className="samba-workgroup">Workgroup <input aria-label="Workgroup" value={workgroup} onChange={(event) => { setWorkgroup(event.target.value.toUpperCase()); setDirty(true); }} /></label>
      </div>

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
            {draft.map((share) => (
              <tr key={share.name}>
                <td><strong>{share.name}</strong>{share.comment && <span className="muted">, {share.comment}</span>}</td>
                <td><code>{share.path}</code></td>
                <td>{share.guest ? "Everyone (no password)" : share.users.length ? share.users.join(", ") : "Any user"}</td>
                <td>{share.readOnly ? "Read-only" : "Read & write"}</td>
                <td><button className="text-button" type="button" onClick={() => removeShare(share.name)}>Remove</button></td>
              </tr>
            ))}
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
        <p className="muted share-note">
          <strong>Connect:</strong> macOS/Linux <code>smb://{connectHost}/{draft[0]?.name ?? "<share>"}</code> · Windows <code>\\{connectHost}\{draft[0]?.name ?? "<share>"}</code>
          {scope === "tailscale" && <>. Works from any device signed into your tailnet, nowhere else.</>}
          {scope === "lan" && state.lanAddress && <>, on the LAN use <code>{state.lanAddress}</code>; from outside use the Tailscale name.</>}
          {state.config.shares.some((share) => share.forceUser === null && !share.readOnly) && <> Folders owned by root are read-only for everyone until you change their owner.</>}
        </p>
      )}
    </section>
  );
}
