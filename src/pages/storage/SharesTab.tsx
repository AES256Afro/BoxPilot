import { useId, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { readJson } from "../../http";
import { BACKUP_MOUNT_NAME, BACKUP_MOUNTPOINT, mountpointFor } from "../../mountpoints";
import { validShareName } from "../../shareName";
import { Button, Checkbox, EmptyState, Field, Notice, Panel, SecretInput, Select, Sheet, StatusChip, Table, Tag, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";
import { UsageMeter } from "./parts";
import { nameValid, percentUsed, slug, type Discovered, type ShareRow, type StorageReport } from "./types";

/*
 * Shares (M33.9): folders on a NAS or another computer, mounted here so apps can use them. Each one
 * with where it comes from, whether it is connected and how full it is; mounting a new one is a
 * sheet that can find the NAS, list its shares and store the credentials root-only. This server
 * only connects out: nothing is opened to the LAN.
 */

export interface SharesTabProps {
  csrfToken: string;
  role: string;
  report: StorageReport | null;
  loading: boolean;
  /** The other machines on the tailnet, as suggestions for the address. */
  tailnetHosts: string[];
  onChanged: () => void;
}

type Kind = "smb" | "nfs";
const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;

function stateOf(share: ShareRow) {
  if (share.mounted) return { status: "good" as const, label: "Connected" };
  if (share.automount) return { status: "neutral" as const, label: "Connects on first use" };
  return { status: "warning" as const, label: "Not connected" };
}

export default function SharesTab({ csrfToken, role, report, loading, tailnetHosts, onChanged }: SharesTabProps) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState<{ devices: Discovered[]; scanned: number } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [kind, setKind] = useState<Kind>("smb");
  const [host, setHost] = useState("");
  const [share, setShare] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState<Array<{ name: string; comment: string | null }> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const hostsId = useId();
  // The password is held only until the job that uses it has run.
  const { start, dialog } = useOperation(csrfToken, () => { setPassword(""); onChanged(); });

  const shares = report?.shares ?? [];
  const tools = report?.tools;
  const may = (operationId: string) => mayStart(role, operationId);

  const setShareAndName = (value: string) => { setShare(value); if (!nameTouched) setName(slug(value.split("/").filter(Boolean).at(-1) ?? value)); };
  const useDevice = (device: Discovered) => { setHost(device.name ?? device.address); setKind(device.smb ? "smb" : "nfs"); setListed(null); setFormError(null); };
  const discover = async () => {
    setDiscovering(true); setFormError(null);
    try { setDiscovered(await readJson(await fetch("/api/v1/storage/shares/discover"))); }
    catch (requestError) { setFormError(requestError instanceof Error ? requestError.message : "Discovery failed"); }
    finally { setDiscovering(false); }
  };
  const listShares = async () => {
    setListing(true); setFormError(null); setListed(null);
    try {
      const credentials = kind === "smb" && username.trim();
      const body = await readJson<{ shares: Array<{ name: string; comment: string | null }> }>(await fetch("/api/v1/storage/shares/list", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ kind, host: host.trim(), username: credentials ? username.trim() : null, password: credentials ? password : null, domain: credentials && domain.trim() ? domain.trim() : null }) }));
      setListed(body.shares);
      if (!body.shares.length) setFormError("No shares were listed. Type the share name if you know it.");
    } catch (requestError) { setFormError(requestError instanceof Error ? requestError.message : "The shares could not be listed"); }
    finally { setListing(false); }
  };

  const hostValid = hostPattern.test(host.trim());
  const shareValid = validShareName(kind, share.trim());
  const toolReady = kind === "smb" ? tools?.cifs : tools?.nfs;
  const formValid = hostValid && shareValid && nameValid(name) && Boolean(toolReady);
  // A greyed-out button that explains nothing is a dead end: say which field is still wanted.
  const blocker = !toolReady ? `Install ${kind === "smb" ? "cifs-utils" : "nfs-common"} first.`
    : !hostValid ? "Enter the NAS address first."
    : !shareValid ? (kind === "smb" ? "Pick a share below, or type its name. A folder inside one is fine, like alex/Backups." : "Enter the export path.")
    : !nameValid(name) ? "Give it a folder name under /mnt (lower case, no spaces)."
    : null;
  const credentialsPath = `/etc/boxpilot/secrets/share-${name || "<name>"}.cred`;

  const install = (pkg: string) => start({ operationId: "apt.install", title: `Install ${pkg}`, parameters: { packages: [pkg] }, preview: <span><code>apt-get install --no-install-recommends {pkg}</code></span> });
  const mountShare = () => {
    if (!formValid) return;
    setOpen(false);
    start({
      operationId: "share.mount",
      title: `Mount ${kind === "smb" ? `//${host.trim()}/${share.trim()}` : `${host.trim()}:${share.trim()}`} at ${mountpointFor(name)}`,
      parameters: {
        kind, host: host.trim(), share: share.trim(), name,
        ...(kind === "smb" && username.trim() ? { username: username.trim(), password } : {}),
        ...(kind === "smb" && username.trim() && domain.trim() ? { domain: domain.trim() } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      },
      preview: (
        <span>
          Adds a <code>{kind === "smb" ? "cifs" : "nfs"}</code> entry to fstab for <code>{mountpointFor(name)}</code> with <code>nofail</code>, <code>_netdev</code>, and systemd automount, so a NAS that is off never blocks boot and reconnects by itself.
          {kind === "smb" && username.trim() ? <> Credentials for <strong>{username.trim()}</strong> are stored root-only at <code>{credentialsPath}</code> and never shown again.</> : kind === "smb" ? <> Connects as <strong>guest</strong>.</> : null}
          {readOnly ? " Mounted read-only." : ""} If the first mount fails, everything is removed again.
        </span>
      ),
    });
  };

  const missing = tools ? [
    ...(!tools.cifs ? [{ pkg: "cifs-utils", what: "SMB / Windows sharing" }] : []),
    ...(!tools.nfs ? [{ pkg: "nfs-common", what: "NFS" }] : []),
    ...(!tools.smbclient ? [{ pkg: "smbclient", what: "listing a NAS's shares for you" }] : []),
  ] : [];

  const columns: Array<TableColumn<ShareRow>> = [
    {
      id: "share", header: "Share", sortValue: (entry) => entry.name, cell: (entry) => (
        <span className="storage-name">
          <span className="storage-name__line"><strong className="storage-name__main">{entry.name}</strong><Tag>{entry.kind === "smb" ? "SMB" : "NFS"}</Tag>{entry.readOnly && <Tag>read-only</Tag>}</span>
          <code className="storage-name__sub">{entry.source}</code>
        </span>
      ),
    },
    { id: "mountpoint", header: "Mounted at", cell: (entry) => <code>{entry.mountpoint}</code> },
    { id: "state", header: "State", sortValue: (entry) => (entry.mounted ? 2 : entry.automount ? 1 : 0), cell: (entry) => { const state = stateOf(entry); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
    { id: "used", header: "Used", sortValue: (entry) => percentUsed(entry.usedBytes, entry.sizeBytes), cell: (entry) => <UsageMeter used={entry.usedBytes} size={entry.sizeBytes} label={entry.mountpoint} /> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (entry) => (
        <span className="storage-actions">
          {may("share.unmount") && <Button risk={riskOf("share.unmount")} aria-label={`Unmount ${entry.name}`} onClick={() => start({ operationId: "share.unmount", title: `Unmount ${entry.name}`, parameters: { name: entry.name }, preview: <span>Unmounts <code>{entry.mountpoint}</code>, removes its fstab entry and automount, and deletes the stored credentials. Nothing on the NAS is touched.</span> })}>Unmount</Button>}
        </span>
      ),
    },
  ];
  const openButton = may("share.mount") ? <Button variant="primary" risk={riskOf("share.mount")} onClick={() => setOpen(true)}>Mount a share</Button> : null;

  return (
    <>
      {dialog}
      {missing.length > 0 && may("apt.install") && (
        <Notice tone="warning" title={`Not installed: ${missing.map((entry) => entry.pkg).join(", ")}`} action={<>{missing.map((entry) => <Button key={entry.pkg} risk={riskOf("apt.install")} onClick={() => install(entry.pkg)}>Install {entry.pkg}</Button>)}</>}>
          {missing.map((entry) => `${entry.pkg} is for ${entry.what}`).join("; ")}.
        </Notice>
      )}

      <Panel
        title="Network shares"
        count={report ? shares.length : undefined}
        meta={tools ? <>SMB <b>{tools.cifs ? "ready" : "missing"}</b> · NFS <b>{tools.nfs ? "ready" : "missing"}</b> · <b>{shares.filter((entry) => entry.mounted).length}</b> connected</> : undefined}
        actions={openButton}
      >
        <Table
          caption="Network shares mounted on this server"
          columns={columns}
          rows={shares}
          rowKey={(entry) => entry.name}
          rowStatus={(entry) => (!entry.mounted && !entry.automount ? "warning" : undefined)}
          empty={!report
            ? (loading ? "Reading the shares…" : "The shares could not be read.")
            : <EmptyState title="No network share is mounted" action={openButton}>A folder on a NAS or another computer, mounted here so apps can use it. A NAS that is off never blocks boot.</EmptyState>}
        />
      </Panel>

      {open && (
        <Sheet
          className="storage-sheet"
          kicker="Network share"
          title="Mount a share"
          onClose={() => setOpen(false)}
          footer={<>
            {blocker && <span className="storage-blocker">{blocker}</span>}
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("share.mount")} disabled={!formValid} onClick={mountShare}>Mount share</Button>
          </>}
        >
          <div className="storage-find">
            <Button onClick={() => void discover()} busy={discovering}>{discovering ? "Scanning your network…" : "Find devices on my network"}</Button>
            <span className="storage-dim">Anything answering Windows sharing (445) or NFS (2049) on your LAN. A few seconds.</span>
          </div>
          {discovered && discovered.devices.length === 0 && (
            <Notice tone="info" title={`Nothing answered on ports 445 or 2049 across ${discovered.scanned} addresses`}>
              Check the NAS is on. On a WD My Cloud Home, turn on <em>Local network access</em> in the My Cloud Home app (Settings), then try again, or type its address below.
            </Notice>
          )}
          {discovered && discovered.devices.length > 0 && (
            <ul className="storage-picks" aria-label="Devices found">
              {discovered.devices.map((device) => (
                <li key={device.address}>
                  <strong>{device.name ?? device.address}</strong>
                  {device.name && <code>{device.address}</code>}
                  {device.smb && <Tag tone="good">SMB</Tag>}
                  {device.nfs && <Tag tone="good">NFS</Tag>}
                  <Button variant="ghost" onClick={() => useDevice(device)} aria-label={`Use ${device.name ?? device.address}`}>Use this device</Button>
                </li>
              ))}
            </ul>
          )}

          <Field label="Type">
            <Select value={kind} onValueChange={(value) => { setKind(value as Kind); setListed(null); }} options={[{ value: "smb", label: "SMB / Windows sharing (most NAS, My Cloud)" }, { value: "nfs", label: "NFS" }]} />
          </Field>
          <Field label="NAS address or name" hint="An address, a name on your network, or a tailnet device.">
            <TextInput mono list={hostsId} placeholder="192.168.1.50" autoComplete="off" value={host} onValueChange={setHost} />
          </Field>
          <datalist id={hostsId}>{tailnetHosts.map((entry) => <option value={entry} key={entry} />)}</datalist>

          {kind === "smb" && (
            <>
              <Field label="Username" optional hint="Empty connects as guest, which is enough for a Public folder.">
                <TextInput autoComplete="off" value={username} onValueChange={setUsername} />
              </Field>
              <Field label="Password" hint={username.trim() ? "Stored root-only on this server, never shown again." : "Needs a username."}>
                <SecretInput autoComplete="new-password" value={password} onValueChange={setPassword} disabled={!username.trim()} />
              </Field>
              <Field label="Domain or workgroup" optional>
                <TextInput mono placeholder="WORKGROUP" value={domain} onValueChange={setDomain} disabled={!username.trim()} />
              </Field>
            </>
          )}

          <Field
            label={kind === "smb" ? "Share name" : "Export path"}
            hint={kind === "smb" ? "A folder inside a share works too, like alex/Backups. A WD My Cloud Home offers only Public, TimeMachineBackup and one share per user: point at a folder inside one." : "The folder the NAS exports, like /volume1/media."}
          >
            <TextInput mono placeholder={kind === "smb" ? "Public" : "/volume1/media"} value={share} onValueChange={setShareAndName} />
          </Field>
          <div className="storage-find">
            <Button onClick={() => void listShares()} disabled={!hostValid} busy={listing}>{listing ? "Asking the NAS…" : "List shares"}</Button>
            {listed && listed.length > 0 && <span className="storage-dim">Shares on {host.trim()}. Pick one:</span>}
          </div>
          {listed && listed.length > 0 && (
            <ul className="storage-picks storage-picks--inline" aria-label={`Shares on ${host.trim()}`}>
              {listed.map((entry) => (
                <li key={entry.name}>
                  <Button variant="ghost" onClick={() => setShareAndName(entry.name)}>{entry.name}</Button>
                  {entry.comment && <span className="storage-dim">{entry.comment}</span>}
                </li>
              ))}
            </ul>
          )}

          <Field
            label={<>Mount as <code>/mnt/…</code></>}
            error={name && !nameValid(name) ? "Lower case letters, digits and dashes." : undefined}
            hint={name === BACKUP_MOUNT_NAME
              ? <>Mounted at <code>{BACKUP_MOUNTPOINT}</code>: BoxPilot copies its backups there.</>
              : <>Backups look for one exact place. <Button variant="ghost" className="storage-inline" onClick={() => { setNameTouched(true); setName(BACKUP_MOUNT_NAME); }}>Use this for BoxPilot's backups</Button></>}
          >
            <TextInput mono placeholder="nas-media" autoComplete="off" value={name} onValueChange={(value) => { setNameTouched(true); setName(value.toLowerCase()); }} />
          </Field>
          <Checkbox label="Read-only" checked={readOnly} onChange={setReadOnly} />
          {formError && <Notice tone="danger" live title={formError} />}
        </Sheet>
      )}
    </>
  );
}
