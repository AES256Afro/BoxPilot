import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { countOf } from "../../data";
import { inspectOperation } from "../../operations";
import { Button, Field, KeyValue, Notice, PageHeader, Panel, Sheet, Table, Tag, TextInput, Textarea, mayStart, riskOf, type TableColumn } from "../../ui";
import "./users.css";

/*
 * Users & SSH (M33.10), rebuilt on the kit. Facts first: whether SSH takes passwords (the one
 * setting that decides how exposed this server is), then how SSH is set up, then the accounts with
 * their sudo and their keys. Adding an account and importing keys are forms, so they open in
 * sheets; every action carries its tier, and a role that cannot start one does not see it.
 */

interface UserRow { name: string; uid: number; shell: string; sudo: boolean; keyCount: number }
interface SshdConfig { passwordAuthentication: boolean; keyboardInteractive: boolean; pubkeyAuthentication: boolean; permitRootLogin: string | null; port: number }
interface UsersReport { users: UserRow[]; sshd: SshdConfig | null; sshActive: boolean }

export interface UsersPageProps {
  csrfToken: string;
  /** Who is signed in. Accounts and keys are read as root, so a viewer is told an operator reads them. */
  role?: string;
}

/** A Linux account name as useradd takes it, and a GitHub account's name; the server checks both again. */
const validUsername = (name: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name);
const validGithub = (name: string) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38})?$/.test(name);
const githubProblem = (name: string) => (name && !validGithub(name) ? "Letters, digits and single hyphens, as GitHub has them." : null);

export default function UsersPage({ csrfToken, role = "owner" }: UsersPageProps) {
  const canRead = role === "owner" || role === "operator";
  const [report, setReport] = useState<UsersReport | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"add" | "keys" | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newGithub, setNewGithub] = useState("");
  const [keysTarget, setKeysTarget] = useState<string | null>(null);
  const [keysGithub, setKeysGithub] = useState("");
  const [keysPasted, setKeysPasted] = useState("");

  const refresh = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const { result } = await inspectOperation<UsersReport>("users.inspect");
      if (!Array.isArray(result?.users)) throw new Error("The accounts came back in a shape this page cannot read.");
      setReport(result);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The accounts and SSH could not be read");
    } finally {
      setLoading(false);
    }
  }, [canRead]);
  useEffect(() => { void refresh(); }, [refresh]);

  // A finished change clears the form it came from; a cancelled approval keeps it, so reopening the
  // sheet shows what was typed.
  const { start, dialog } = useOperation(csrfToken, () => {
    setNewUsername(""); setNewGithub(""); setKeysGithub(""); setKeysPasted(""); setKeysTarget(null);
    void refresh();
  });

  const users = report?.users ?? [];
  const sshd = report?.sshd ?? null;
  const passwordAuth = sshd?.passwordAuthentication ?? null;
  const anyKeys = users.some((user) => user.keyCount > 0);
  const sudoCount = users.filter((user) => user.sudo).length;
  const keyCount = users.reduce((sum, user) => sum + user.keyCount, 0);
  const canAdd = mayStart(role, "users.add");
  const canImport = mayStart(role, "users.keys.import");
  const canSudo = mayStart(role, "users.sudo.set");
  const canPassword = mayStart(role, "ssh.password-auth.set");

  const openKeys = (name: string) => {
    if (keysTarget !== name) { setKeysGithub(""); setKeysPasted(""); }
    setKeysTarget(name);
    setSheet("keys");
  };

  // The sheet closes before the approval opens: two modals at once would fight over focus and Escape.
  const importKeys = () => {
    if (!keysTarget) return;
    const github = keysGithub.trim();
    setSheet(null);
    start({
      operationId: "users.keys.import",
      title: `Import SSH keys for ${keysTarget}`,
      parameters: github ? { username: keysTarget, githubUser: github } : { username: keysTarget, keys: keysPasted },
      preview: github
        ? <span>Fetches <code>github.com/{github}.keys</code> and appends new keys to <code>authorized_keys</code>. Existing keys are kept.</span>
        : <span>Appends the pasted public keys to <code>authorized_keys</code>. Existing keys are kept.</span>,
    });
  };

  const addUser = () => {
    const username = newUsername.trim();
    const github = newGithub.trim();
    setSheet(null);
    start({
      operationId: "users.add",
      title: `Add user ${username}`,
      parameters: github ? { username, githubUser: github } : { username },
      preview: <span><code>useradd --create-home --shell /bin/bash {username}</code>{github ? <> then import keys from <code>github.com/{github}.keys</code></> : null}. Password login starts locked.</span>,
    });
  };

  const setPasswordLogin = () => start({
    operationId: "ssh.password-auth.set",
    title: passwordAuth ? "Turn off SSH password login" : "Allow SSH password login",
    parameters: { enabled: !passwordAuth },
    preview: passwordAuth
      ? <span>Writes <code>PasswordAuthentication no</code> to a validated sshd drop-in and reloads ssh. Only key holders can sign in over plain SSH afterwards; Tailscale SSH is unaffected.</span>
      : <span>Writes <code>PasswordAuthentication yes</code> to the sshd drop-in and reloads ssh.</span>,
  });

  const toggleSudo = (user: UserRow) => start({
    operationId: "users.sudo.set",
    title: user.sudo ? `Remove sudo from ${user.name}` : `Grant sudo to ${user.name}`,
    parameters: { username: user.name, sudo: !user.sudo },
    preview: user.sudo ? <span>Removes {user.name} from the sudo group. The last sudo user cannot be removed.</span> : <span>Adds {user.name} to the sudo group, full administrator rights.</span>,
  });

  const columns: Array<TableColumn<UserRow>> = [
    { id: "name", header: "User", sortValue: (user) => user.name, cell: (user) => <code className="users-name">{user.name}</code> },
    { id: "uid", header: "UID", numeric: true, sortValue: (user) => user.uid, cell: (user) => user.uid },
    { id: "shell", header: "Shell", hideOnPhone: true, sortValue: (user) => user.shell, cell: (user) => <code className="users-shell">{user.shell}</code> },
    { id: "sudo", header: "Sudo", sortValue: (user) => (user.sudo ? 0 : 1), cell: (user) => (user.sudo ? <Tag tone="warning" title="Full administrator rights">sudo</Tag> : <span className="users-dim">—</span>) },
    { id: "keys", header: "SSH keys", numeric: true, sortValue: (user) => user.keyCount, cell: (user) => user.keyCount },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "users-actions-cell", cell: (user) => (
        <span className="users-actions">
          {canImport && <Button variant="ghost" onClick={() => openKeys(user.name)} aria-label={`Import keys for ${user.name}`}>Import keys…</Button>}
          {canSudo && user.name !== "root" && (
            <Button risk={riskOf("users.sudo.set")} onClick={() => toggleSudo(user)} aria-label={`${user.sudo ? "Remove sudo from" : "Grant sudo to"} ${user.name}`}>{user.sudo ? "Remove sudo" : "Grant sudo"}</Button>
          )}
        </span>
      ),
    },
  ];

  const verdict = !canRead ? { status: "neutral" as const, label: "Operators only" }
    : error && !report ? { status: "unknown" as const, label: "Not read" }
      : !report ? { status: "unknown" as const, label: "Reading…" }
        : !sshd ? { status: "unknown" as const, label: "SSH not read" }
          : !report.sshActive ? { status: "neutral" as const, label: "SSH not running" }
            : passwordAuth ? { status: "warning" as const, label: "Password login on" }
              : { status: "good" as const, label: "Key-only login" };
  const rootWithPassword = Boolean(sshd && report?.sshActive && passwordAuth && sshd.permitRootLogin === "yes");
  const passwordHint = passwordAuth === false ? "Key-only SSH login." : anyKeys ? "Keys are in place, so passwords can be turned off." : "Import a key before turning passwords off: nobody could sign in over SSH otherwise.";
  const username = newUsername.trim();
  const usernameProblem = username && !validUsername(username) ? "Lowercase letters, digits, - and _, starting with a letter or _; at most 32." : null;
  const keysGithubProblem = githubProblem(keysGithub.trim());
  const newGithubProblem = githubProblem(newGithub.trim());
  const keysReady = Boolean((keysGithub.trim() && !keysGithubProblem) || (!keysGithub.trim() && keysPasted.trim()));

  return (
    <div className="users-page">
      {dialog}
      <PageHeader
        title="Users & SSH"
        status={verdict}
        summary={rootWithPassword ? "Root can sign in over SSH with a password." : undefined}
        meta={report ? <><b>{users.length}</b> {users.length === 1 ? "account" : "accounts"} · <b>{sudoCount}</b> with sudo · <b>{keyCount}</b> {keyCount === 1 ? "key" : "keys"}{sshd ? <> · port <b>{sshd.port}</b> · root login <b>{sshd.permitRootLogin ?? "unknown"}</b></> : null}</> : undefined}
        actions={canRead ? <>
          {canAdd && <Button onClick={() => setSheet("add")}>Add a user…</Button>}
          <Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(report)}>Read again</Button>
        </> : undefined}
        about={<>
          <p>Add accounts, import SSH keys from GitHub, and control SSH password login.</p>
          <p>Only root and the accounts that can sign in are listed. A new account starts with its password locked, so it signs in with a key: import one from a GitHub account or paste it. Turning password login off leaves Tailscale SSH as it is.</p>
        </>}
      />

      {!canRead && <Notice tone="info" title="Reading accounts needs an operator">Accounts and their keys are read as root, so an owner or operator reads them.</Notice>}
      {error && <Notice tone="danger" live title="The accounts and SSH could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      {canRead && (
        <>
          <Panel
            padded
            className="users-ssh"
            title="SSH"
            count={report ? { status: report.sshActive ? "good" : "neutral", label: report.sshActive ? "running" : "not running" } : undefined}
            actions={canPassword && passwordAuth !== null ? (
              <Button risk={riskOf("ssh.password-auth.set")} disabled={loading || (passwordAuth && !anyKeys)} onClick={setPasswordLogin}>
                {passwordAuth ? "Turn off password login" : "Allow password login"}
              </Button>
            ) : undefined}
            footer={passwordAuth !== null ? passwordHint : undefined}
          >
            {!report ? <p className="users-dim">{loading ? "Reading sshd…" : "Not read."}</p> : !sshd ? <p className="users-dim">The SSH server's settings could not be read.</p> : (
              <KeyValue
                layout="columns"
                items={[
                  { id: "service", label: "Service", value: report.sshActive ? "Active" : "Inactive", status: report.sshActive ? "good" : "neutral" },
                  { id: "port", label: "Port", value: sshd.port, mono: true },
                  { id: "password", label: "Password login", value: sshd.passwordAuthentication ? "Allowed" : "Off", status: sshd.passwordAuthentication ? "warning" : "good" },
                  { id: "keys", label: "Key login", value: sshd.pubkeyAuthentication ? "Allowed" : "Off" },
                  { id: "interactive", label: "Keyboard-interactive", value: sshd.keyboardInteractive ? "On" : "Off" },
                  { id: "root", label: "Root login", value: sshd.permitRootLogin ?? "unknown", mono: true, status: sshd.permitRootLogin === "yes" ? "warning" : undefined },
                ]}
              />
            )}
          </Panel>

          <Panel className="users-accounts" title="Accounts" count={report ? users.length : undefined} meta={report ? `${countOf(sudoCount, "admin")} · ${countOf(keyCount, "key")}` : undefined}>
            <Table
              caption="Accounts that can sign in"
              columns={columns}
              rows={users}
              rowKey={(user) => user.name}
              defaultSort={{ column: "uid", direction: "ascending" }}
              empty={!report ? (loading ? "Reading accounts…" : "The accounts could not be read.") : "No accounts that can sign in."}
            />
          </Panel>
        </>
      )}

      {sheet === "keys" && keysTarget && (
        <Sheet
          kicker="SSH keys"
          title={`Import keys for ${keysTarget}`}
          side="center"
          size="sm"
          onClose={() => setSheet(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("users.keys.import")} disabled={!keysReady} onClick={importKeys}>Import</Button>
          </>}
        >
          <div className="users-form">
            <Field label="From a GitHub account" error={keysGithubProblem} hint="Every public key on github.com/<name>.keys.">
              <TextInput mono value={keysGithub} onValueChange={(value) => setKeysGithub(value.trim())} placeholder="GitHub username" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Or paste public keys" hint={keysGithub ? "The GitHub account is used; clear it to paste instead." : "One per line: ssh-ed25519 AAAA… comment. Existing keys are kept."}>
              <Textarea mono rows={5} value={keysPasted} onValueChange={setKeysPasted} disabled={Boolean(keysGithub)} spellCheck={false} placeholder="ssh-ed25519 AAAA… you@laptop" />
            </Field>
          </div>
        </Sheet>
      )}

      {sheet === "add" && (
        <Sheet
          kicker="New account"
          title="Add a user"
          side="center"
          size="sm"
          onClose={() => setSheet(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("users.add")} disabled={!username || Boolean(usernameProblem) || Boolean(newGithubProblem)} onClick={addUser}>Add user</Button>
          </>}
        >
          <div className="users-form">
            <Field label="Username" required error={usernameProblem} hint="Created with a home directory and bash. Password login starts locked.">
              <TextInput mono value={newUsername} onValueChange={(value) => setNewUsername(value.toLowerCase())} placeholder="username" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Keys from GitHub" optional error={newGithubProblem} hint="Imports that account's public keys right away, so the new user can sign in.">
              <TextInput mono value={newGithub} onValueChange={(value) => setNewGithub(value.trim())} placeholder="GitHub username" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        </Sheet>
      )}
    </div>
  );
}
