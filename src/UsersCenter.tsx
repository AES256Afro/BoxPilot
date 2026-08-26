import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface UserRow { name: string; uid: number; shell: string; sudo: boolean; keyCount: number }
interface SshdConfig { passwordAuthentication: boolean; keyboardInteractive: boolean; pubkeyAuthentication: boolean; permitRootLogin: string | null; port: number }
interface UsersReport { users: UserRow[]; sshd: SshdConfig | null; sshActive: boolean }

export default function UsersCenter({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<UsersReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newGithub, setNewGithub] = useState("");
  const [keysTarget, setKeysTarget] = useState<string | null>(null);
  const [keysGithub, setKeysGithub] = useState("");
  const [keysPasted, setKeysPasted] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { result } = await inspectOperation<UsersReport>("users.inspect");
      setReport(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read users and SSH state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setKeysTarget(null); setKeysGithub(""); setKeysPasted(""); void refresh(); });

  const passwordAuth = report?.sshd?.passwordAuthentication ?? null;
  const anyKeys = (report?.users ?? []).some((user) => user.keyCount > 0);

  const importKeys = () => {
    if (!keysTarget) return;
    const parameters = keysGithub
      ? { username: keysTarget, githubUser: keysGithub }
      : { username: keysTarget, keys: keysPasted };
    start({
      operationId: "users.keys.import",
      title: `Import SSH keys for ${keysTarget}`,
      parameters,
      preview: keysGithub
        ? <span>Fetches <code>github.com/{keysGithub}.keys</code> and appends new keys to <code>authorized_keys</code>. Existing keys are kept.</span>
        : <span>Appends the pasted public keys to <code>authorized_keys</code>. Existing keys are kept.</span>,
    });
  };

  return (
    <div className="users-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Users</span><strong>{loading ? "…" : report?.users.length ?? "—"}</strong><span>{report ? `${report.users.filter((user) => user.sudo).length} with sudo` : "human accounts"}</span></article>
        <article className="panel"><span className="eyebrow">SSH service</span><strong>{loading ? "…" : report?.sshActive ? "Active" : "Inactive"}</strong><span>port {report?.sshd?.port ?? 22} · root login {report?.sshd?.permitRootLogin ?? "unknown"}</span></article>
        <article className="panel">
          <span className="eyebrow">Password login</span>
          <strong>{loading || passwordAuth === null ? "…" : passwordAuth ? "Allowed" : "Off"}</strong>
          <span>{passwordAuth === false ? "Key-only SSH login" : anyKeys ? "Keys exist; you can turn passwords off" : "Import a key before turning passwords off"}</span>
          {passwordAuth !== null && (
            <div className="recovery-actions">
              <button className="secondary-button" type="button" disabled={loading || (passwordAuth && !anyKeys)} onClick={() => start({
                operationId: "ssh.password-auth.set",
                title: passwordAuth ? "Turn off SSH password login" : "Allow SSH password login",
                parameters: { enabled: !passwordAuth },
                preview: passwordAuth
                  ? <span>Writes <code>PasswordAuthentication no</code> to a validated sshd drop-in and reloads ssh. Only key holders can sign in over plain SSH afterwards; Tailscale SSH is unaffected.</span>
                  : <span>Writes <code>PasswordAuthentication yes</code> to the sshd drop-in and reloads ssh.</span>,
              })}>{passwordAuth ? "Turn off" : "Allow"}</button>
            </div>
          )}
        </article>
      </div>

      <section className="panel">
        <header className="panel-header"><div><strong>Accounts</strong><span>root and login-capable users. New accounts start password-locked, so import a key to sign in.</span></div></header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>User</th><th>UID</th><th>Shell</th><th>Sudo</th><th>SSH keys</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {loading && !report ? <tr><td colSpan={6}>Reading accounts...</td></tr> : null}
              {report?.users.map((user) => (
                <tr key={user.name}>
                  <td><code>{user.name}</code></td>
                  <td>{user.uid}</td>
                  <td>{user.shell}</td>
                  <td>{user.sudo ? <span className="status-pill status-warning">sudo</span> : "—"}</td>
                  <td>{user.keyCount}</td>
                  <td>
                    <div className="recovery-actions">
                      <button className="text-button" type="button" onClick={() => { setKeysTarget(user.name); setKeysGithub(""); setKeysPasted(""); }}>Import keys</button>
                      {user.name !== "root" && (
                        <button className="text-button" type="button" onClick={() => start({
                          operationId: "users.sudo.set",
                          title: user.sudo ? `Remove sudo from ${user.name}` : `Grant sudo to ${user.name}`,
                          parameters: { username: user.name, sudo: !user.sudo },
                          preview: user.sudo ? <span>Removes {user.name} from the sudo group. The last sudo user cannot be removed.</span> : <span>Adds {user.name} to the sudo group, full administrator rights.</span>,
                        })}>{user.sudo ? "Remove sudo" : "Grant sudo"}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {keysTarget && (
        <section className="panel">
          <header className="panel-header"><div><strong>Import SSH keys for {keysTarget}</strong><span>From a GitHub account, or paste public key lines. Existing keys are kept.</span></div>
            <button className="text-button" type="button" onClick={() => setKeysTarget(null)}>Cancel</button>
          </header>
          <div className="recovery-actions">
            <input aria-label="GitHub username" placeholder="GitHub username" value={keysGithub} onChange={(event) => setKeysGithub(event.target.value.trim())} />
            <button className="primary-button" type="button" disabled={!keysGithub && !keysPasted.trim()} onClick={importKeys}>Import</button>
          </div>
          <textarea aria-label="Public keys" placeholder="...or paste public keys, one per line (ssh-ed25519 AAAA... comment)" value={keysPasted} onChange={(event) => setKeysPasted(event.target.value)} spellCheck="false" rows={4} disabled={Boolean(keysGithub)} />
        </section>
      )}

      <section className="panel">
        <header className="panel-header"><div><strong>Add a user</strong><span>Creates the account with a home directory and bash. Password login starts locked; add a GitHub username to import their keys right away.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="New username" placeholder="username" value={newUsername} onChange={(event) => setNewUsername(event.target.value.toLowerCase())} />
          <input aria-label="GitHub username for keys" placeholder="GitHub username (optional)" value={newGithub} onChange={(event) => setNewGithub(event.target.value.trim())} />
          <button className="primary-button" type="button" disabled={!newUsername} onClick={() => start({
            operationId: "users.add",
            title: `Add user ${newUsername}`,
            parameters: newGithub ? { username: newUsername, githubUser: newGithub } : { username: newUsername },
            preview: <span><code>useradd --create-home --shell /bin/bash {newUsername}</code>{newGithub ? <> then import keys from <code>github.com/{newGithub}.keys</code></> : null}</span>,
          })}>Add user</button>
        </div>
      </section>
    </div>
  );
}
