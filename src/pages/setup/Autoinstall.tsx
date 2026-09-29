import { useState, type FormEvent } from "react";
import { Button, CodeBlock, Field, Notice, Panel, SecretInput, Select, TextInput, Textarea } from "../../ui";

/*
 * Prepare a new server (M4.3, rebuilt in M33.12): the NoCloud user-data and meta-data for an
 * unattended Ubuntu Server install that installs BoxPilot on first boot. It renders files for
 * another machine; nothing on this server changes, so the button carries no tier.
 */

interface Rendered { userData: string; metaData: string; ref: string; filename: string }

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoking in the same tick can cancel the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Autoinstall({ csrfToken, canGenerate = true }: { csrfToken: string; canGenerate?: boolean }) {
  const [hostname, setHostname] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sshKeys, setSshKeys] = useState("");
  const [githubUser, setGithubUser] = useState("");
  const [mode, setMode] = useState<"dhcp" | "static">("dhcp");
  const [address, setAddress] = useState("");
  const [gateway, setGateway] = useState("");
  const [nameservers, setNameservers] = useState("");
  const [layout, setLayout] = useState<"lvm" | "direct">("lvm");
  const [timezone, setTimezone] = useState("Etc/UTC");
  // The build's own version, not a number typed here once: the placeholder said v0.62.5 more than a
  // hundred releases later, and it is the one field where copying the example verbatim installs
  // something ancient on a brand-new server. Empty means current, which the server does anyway.
  const [ref, setRef] = useState(`v${__BOXPILOT_VERSION__}`);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);

  const importKeys = async () => {
    const user = githubUser.trim();
    if (!user) return;
    setError(null);
    setImporting(true);
    try {
      const response = await fetch(`/api/v1/ssh-keys/github/${encodeURIComponent(user)}`);
      const body = (await response.json().catch(() => ({}))) as { keys?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not fetch keys");
      setSshKeys((current) => [...new Set([...current.split("\n").map((line) => line.trim()).filter(Boolean), ...(body.keys ?? [])])].join("\n"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not fetch keys");
    } finally {
      setImporting(false);
    }
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRendered(null);
    try {
      const body = {
        hostname: hostname.trim(), username: username.trim(), password,
        sshKeys: sshKeys.split("\n").map((line) => line.trim()).filter(Boolean),
        network: mode === "dhcp" ? { mode } : { mode, address: address.trim(), gateway: gateway.trim(), nameservers: nameservers.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean) },
        disk: { layout }, timezone: timezone.trim() || undefined, boxpilotRef: ref.trim() || undefined,
      };
      const response = await fetch("/api/v1/setup/autoinstall", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(body) });
      const result = (await response.json().catch(() => ({}))) as Rendered & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not generate the autoinstall files");
      setRendered(result);
      setPassword("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not generate the autoinstall files");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-new">
      <Notice tone="warning" title="For another machine">The install is unattended and erases that machine's disk. Nothing here changes this server.</Notice>
      <form className="setup-new__form" onSubmit={(event) => void generate(event)}>
        <div className="setup-new__panels">
          <Panel padded level={2} title="The machine">
            <Field label="Hostname" required hint="Lower-case letters, numbers and hyphens.">
              <TextInput mono value={hostname} onValueChange={setHostname} placeholder="garage-box" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" required autoComplete="off" />
            </Field>
            <Field label="User name" required>
              <TextInput mono value={username} onValueChange={setUsername} placeholder="owner" pattern="[a-z_][a-z0-9_-]{0,31}" required autoComplete="off" />
            </Field>
            <Field label="Password" required hint="12 or more characters. Hashed here, never stored.">
              <SecretInput value={password} onValueChange={setPassword} minLength={12} autoComplete="new-password" required />
            </Field>
            <Field label="Time zone">
              <TextInput mono value={timezone} onValueChange={setTimezone} placeholder="Etc/UTC" autoComplete="off" />
            </Field>
          </Panel>

          <Panel padded level={2} title="Access">
            <Field label="SSH public keys" optional hint="One per line. Password login is turned off when a key is given.">
              <Textarea mono rows={4} value={sshKeys} onValueChange={setSshKeys} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
            </Field>
            <div className="setup-inline">
              <TextInput aria-label="GitHub user for keys" mono placeholder="GitHub user" value={githubUser} onValueChange={setGithubUser} autoComplete="off" />
              <Button busy={importing} disabled={!githubUser.trim()} onClick={() => void importKeys()}>Import keys from GitHub</Button>
            </div>
          </Panel>

          <Panel padded level={2} title="Network and disk">
            <Field label="Network">
              <Select value={mode} onValueChange={(value) => setMode(value as "dhcp" | "static")} options={[{ value: "dhcp", label: "DHCP" }, { value: "static", label: "Static IPv4" }]} />
            </Field>
            {mode === "static" && (
              <>
                <Field label="Address with prefix" required><TextInput mono value={address} onValueChange={setAddress} placeholder="192.168.1.20/24" required /></Field>
                <Field label="Gateway" required><TextInput mono value={gateway} onValueChange={setGateway} placeholder="192.168.1.1" required /></Field>
                <Field label="DNS servers" required hint="Separated by commas or spaces."><TextInput mono value={nameservers} onValueChange={setNameservers} placeholder="192.168.1.1, 1.1.1.1" required /></Field>
              </>
            )}
            <Field label="Disk">
              <Select value={layout} onValueChange={(value) => setLayout(value as "lvm" | "direct")} options={[{ value: "lvm", label: "Whole disk, LVM" }, { value: "direct", label: "Whole disk, plain partitions" }]} />
            </Field>
            <Field label="BoxPilot release" hint="Empty means the current release.">
              <TextInput mono value={ref} onValueChange={setRef} placeholder={`v${__BOXPILOT_VERSION__} (current)`} autoComplete="off" />
            </Field>
          </Panel>
        </div>

        {canGenerate && (
          <div className="setup-new__go">
            <Button type="submit" variant="primary" busy={busy}>Generate autoinstall files</Button>
          </div>
        )}
      </form>

      {error && <Notice tone="danger" live title="Not generated">{error}</Notice>}

      {rendered && (
        <Panel padded title="Autoinstall files" meta={`BoxPilot ${rendered.ref}`}
          actions={<>
            <Button onClick={() => saveFile("user-data", rendered.userData)}>Download user-data</Button>
            <Button variant="ghost" onClick={() => saveFile("meta-data", rendered.metaData)}>Download meta-data</Button>
          </>}>
          <p className="setup-note">Put <code>user-data</code> and <code>meta-data</code> on a small volume labelled <code>CIDATA</code> (or serve them over HTTP) and boot the Ubuntu Server installer with <code>autoinstall ds=nocloud</code>. First boot installs BoxPilot {rendered.ref}; open <code>http://{hostname || "the-new-server"}:8787</code> afterwards.</p>
          <CodeBlock label="Generated user-data" maxHeight="28rem">{rendered.userData}</CodeBlock>
          <CodeBlock label="Generated meta-data">{rendered.metaData}</CodeBlock>
        </Panel>
      )}
    </div>
  );
}
