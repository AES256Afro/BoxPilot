import { useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface CloudImage { id: string; label: string; defaultUser: string; cached: boolean; digest: string | null }

/** "New project VM": official cloud image + cloud-init, one form, one confirm. */
export default function CloudVmForm({ csrfToken, onCreated }: { csrfToken: string; onCreated?: () => void }) {
  const [images, setImages] = useState<CloudImage[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [image, setImage] = useState("ubuntu-24.04");
  const [vcpus, setVcpus] = useState(2);
  const [memoryMiB, setMemoryMiB] = useState(2048);
  const [diskGiB, setDiskGiB] = useState(20);
  const [username, setUsername] = useState("");
  const [sshKeys, setSshKeys] = useState("");
  const [githubUser, setGithubUser] = useState("");
  const [packages, setPackages] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    inspectOperation<{ images: CloudImage[] }>("vm.cloud.images").then(({ result }) => setImages(result.images)).catch(() => setImages([]));
  }, []);

  const { start, dialog } = useOperation(csrfToken, () => { onCreated?.(); });

  const importGithubKeys = async () => {
    const user = githubUser.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) { setError("Enter a GitHub user name"); return; }
    setImporting(true); setError(null);
    try {
      const response = await fetch(`/api/v1/ssh-keys/github/${encodeURIComponent(user)}`);
      const body = (await response.json()) as { keys?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not fetch keys");
      if (!body.keys?.length) throw new Error(`GitHub user ${user} has no public keys`);
      setSshKeys((current) => [...new Set([...current.split("\n").map((line) => line.trim()).filter(Boolean), ...body.keys!])].join("\n"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not fetch keys");
    } finally {
      setImporting(false);
    }
  };

  const keys = sshKeys.split("\n").map((line) => line.trim()).filter(Boolean);
  const packageList = packages.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const selected = images.find((item) => item.id === image);
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name) && keys.length > 0;

  const submit = () => {
    setError(null);
    const parameters: Record<string, unknown> = { name, image, vcpus, memoryMiB, diskGiB, sshKeys: keys, autostart };
    if (username.trim()) parameters.username = username.trim();
    if (packageList.length) parameters.packages = packageList;
    start({
      operationId: "vm.cloud.create", title: `Create VM ${name}`, parameters,
      preview: <span>{selected?.label ?? image}, {vcpus} vCPU, {memoryMiB} MiB RAM, {diskGiB} GiB disk, user <code>{username.trim() || selected?.defaultUser || "ubuntu"}</code> with {keys.length} SSH key{keys.length === 1 ? "" : "s"}{packageList.length ? `, packages: ${packageList.join(", ")}` : ""}. {selected?.cached ? "Base image is cached." : "The base image will be downloaded first (a few hundred MB, checksum verified)."}</span>,
    });
  };

  return (
    <section className="panel cloud-vm-form">
      {dialog}
      <header className="panel-header">
        <div><strong>New project VM</strong><span>Official Ubuntu or Debian cloud image, cloud-init with your SSH key, ready in about a minute.</span></div>
        <button className={open ? "secondary-button" : "primary-button"} type="button" onClick={() => setOpen((value) => !value)}>{open ? "Close" : "Create VM"}</button>
      </header>
      {open && (
        <form className="app-config-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <fieldset><legend>Machine</legend>
            <label>Name<input aria-label="VM name" value={name} onChange={(event) => setName(event.target.value)} placeholder="dev-1" required /></label>
            <label>Image<select aria-label="Image" value={image} onChange={(event) => setImage(event.target.value)}>{(images.length ? images : [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS (Noble)", defaultUser: "ubuntu", cached: false, digest: null }]).map((item) => <option key={item.id} value={item.id}>{item.label}{item.cached ? " · cached" : ""}</option>)}</select></label>
            <div className="cloud-vm-sizes">
              <label>vCPUs<input aria-label="vCPUs" type="number" min={1} max={64} value={vcpus} onChange={(event) => setVcpus(Number.parseInt(event.target.value, 10) || 1)} /></label>
              <label>Memory (MiB)<input aria-label="Memory MiB" type="number" min={512} max={524288} step={256} value={memoryMiB} onChange={(event) => setMemoryMiB(Number.parseInt(event.target.value, 10) || 512)} /></label>
              <label>Disk (GiB)<input aria-label="Disk GiB" type="number" min={4} max={4096} value={diskGiB} onChange={(event) => setDiskGiB(Number.parseInt(event.target.value, 10) || 4)} /></label>
            </div>
            <label className="cloud-vm-check"><input type="checkbox" checked={autostart} onChange={(event) => setAutostart(event.target.checked)} /> Start automatically when this server boots</label>
          </fieldset>
          <fieldset><legend>Access</legend>
            <label>User name <span className="muted">(default: {selected?.defaultUser ?? "ubuntu"}, passwordless sudo)</span><input aria-label="User name" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={selected?.defaultUser ?? "ubuntu"} /></label>
            <label>SSH public keys <span className="muted">(one per line)</span><textarea aria-label="SSH public keys" rows={3} value={sshKeys} onChange={(event) => setSshKeys(event.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" /></label>
            <div className="recovery-actions"><input aria-label="GitHub user" value={githubUser} onChange={(event) => setGithubUser(event.target.value)} placeholder="GitHub user name" /><button className="secondary-button" type="button" disabled={importing} onClick={() => void importGithubKeys()}>{importing ? "Importing…" : "Import keys from GitHub"}</button></div>
            <label>Extra packages <span className="muted">(optional, installed on first boot)</span><input aria-label="Extra packages" value={packages} onChange={(event) => setPackages(event.target.value)} placeholder="docker.io git build-essential" /></label>
          </fieldset>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <footer className="recovery-actions"><button className="primary-button" type="submit" disabled={!valid}>Review and create</button><span className="muted">Default NAT network; address appears in the result and in the VM list.</span></footer>
        </form>
      )}
    </section>
  );
}
