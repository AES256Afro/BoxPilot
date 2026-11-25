import { Fragment, useId, useState } from "react";
import { inspectOperation } from "../../operations";
import { useOperation } from "../../shell/ApproveDialog";
import { countOf, type ViewName } from "../../data";
import { formatBytes } from "../../formatBytes";
import type { OffBoxVerdict } from "../../offBox";
import { Button, CodeBlock, EmptyState, Field, KeyValue, Notice, Panel, SecretInput, Select, Sheet, Table, TextInput, Textarea, mayStart, type KnownOperation, riskOf, type Status } from "../../ui";
import { passwordAsked, passwordAskedWords, useOwnerPassword } from "../../ownerPassword";
import { ago, syncedAt, when, type CloudSettings, type CloudState, type MachineSnapshotState, type RemoteDestination, type RemoteMirrorState, type RemoteSettings } from "./types";

/*
 * Off-box (M33.9): a copy somewhere other than this server, because backups beside the data they
 * protect survive a bad upgrade and not a failed disk. Whether one exists and is kept current comes
 * first; then the three places it can go, any one of them enough: a backup drive, another machine
 * over SSH, a cloud bucket. Setting a destination is a sheet.
 */

export interface OffBoxSummary {
  verdict: OffBoxVerdict;
  warning: string | null;
  /** The syncs worth scheduling for what is set up. */
  wanted: KnownOperation[];
  /** Every one of them has a schedule. */
  scheduled: boolean;
}

export interface OffBoxTabProps {
  csrfToken: string;
  role: string;
  tailnetHosts: string[];
  machine: MachineSnapshotState | null;
  remote: RemoteMirrorState | null;
  remoteSettings: RemoteSettings | null;
  cloud: CloudState | null;
  cloudSettings: CloudSettings | null;
  cloudError: string | null;
  summary: OffBoxSummary | null;
  /** Whether a copy is kept elsewhere could not be read. */
  summaryUnknown?: boolean;
  scheduling: { busy: boolean; message: string; failed: boolean } | null;
  onMirrorNightly: (operations: string[]) => void;
  onChanged: () => void;
  onNavigate?: (view: ViewName) => void;
}

const fieldLabels: Record<string, string> = { account: "Key ID", bucket: "Bucket", path: "Folder in the bucket", endpoint: "Endpoint URL", region: "Region", accessKeyId: "Access key ID", url: "WebDAV URL", user: "Username", key: "Application key", secretAccessKey: "Secret access key", password: "Password", token: "Token (from rclone authorize)", passphrase: "Encryption passphrase" };
const placeholders: Record<string, string> = { bucket: "home-backups", path: "boxpilot", endpoint: "https://s3.eu-central-1.wasabisys.com", region: "us-east-1", url: "https://cloud.example.com/remote.php/dav/files/me/" };

/** Where the cloud sheet holds the passphrase's second typing; never a field of the provider, so never sent. */
const passphraseAgainKey = "passphraseAgain";

/**
 * The fields a provider's secret belongs to (M91): saved again with these unchanged, an empty secret keeps the saved
 * one (server/tasks/backup-cloud.mjs, sameAccount). The passphrase is the owner's, not the provider's, so it is kept
 * whatever else changes, as long as the saved destination was sealed.
 */
const secretAccountFields: Record<string, string[]> = { b2: ["account"], s3: ["accessKeyId"], webdav: ["user", "url"] };

/** What the last mirror read back from the bucket (server/backup-cloud.mjs, cloudSyncRecord). */
interface CloudReadBack { ok: boolean | null; at: string | null; artifact: string | null; error: string | null; reason: string | null; lastVerifiedAt: string | null }
/** A machine snapshot in the bucket (backup.cloud.snapshots). */
interface CloudSnapshot { artifact: string; sizeBytes: number | null; modifiedAt: string | null; hasMeta: boolean; local: boolean }

/** When a snapshot was taken, read from its name (machine-snapshot-YYYYMMDDTHHMMSSZ-…). */
function takenAt(artifact: string): string | null {
  const match = artifact.match(/^machine-snapshot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
}

function readBackLine(readBack: CloudReadBack | null | undefined): { value: string; status?: Status } {
  if (!readBack) return { value: "not yet: the next mirror reads the newest snapshot back" };
  if (readBack.ok === true) return { value: `${when(readBack.at)}${readBack.artifact ? ` · ${readBack.artifact}` : ""}`, status: "good" };
  if (readBack.ok === false) return { value: `failed ${when(readBack.at)}${readBack.lastVerifiedAt ? ` · last good ${when(readBack.lastVerifiedAt)}` : ""}`, status: "danger" };
  return { value: readBack.reason ?? "nothing to read back yet" };
}

/** The port a box holds, or null while it is empty or not a port. */
function portOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

function destinationState(configured: boolean, lastSyncAt: string | null): { status: Status; label: string } {
  if (!configured) return { status: "neutral", label: "Not set up" };
  return lastSyncAt ? { status: "good", label: `Mirrored ${ago(lastSyncAt) ?? ""}`.trim() } : { status: "warning", label: "Never mirrored" };
}

export default function OffBoxTab({ csrfToken, role, tailnetHosts, machine, remote, remoteSettings, cloud, cloudSettings, cloudError, summary, summaryUnknown = false, scheduling, onMirrorNightly, onChanged, onNavigate }: OffBoxTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const may = (operationId: KnownOperation) => mayStart(role, operationId);
  const hostsId = useId();

  // The port is held as typed (parsed on Save): as a number, an emptied box could not be retyped.
  const [ssh, setSsh] = useState<(Omit<RemoteDestination, "port"> & { port: string; password: string }) | null>(null);
  // Inside the window a password already opened, saving the destination asks for none (ownerPassword.tsx).
  const owner = useOwnerPassword();
  const sshFormId = useId();
  const [sshError, setSshError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cloudForm, setCloudForm] = useState<{ provider: string; values: Record<string, string> } | null>(null);
  // Why the last save of the cloud destination did not complete, said in its sheet when it comes back.
  const [cloudRefusal, setCloudRefusal] = useState<string | null>(null);
  // The machine snapshots in the bucket (M91), read when asked: each read is a round trip to the provider.
  const [cloudSnapshots, setCloudSnapshots] = useState<{ busy: boolean; error: string | null; snapshots: CloudSnapshot[] | null; total: number }>({ busy: false, error: null, snapshots: null, total: 0 });
  const findCloudSnapshots = async () => {
    setCloudSnapshots((current) => ({ ...current, busy: true, error: null }));
    try {
      const { result } = await inspectOperation<{ snapshots?: CloudSnapshot[]; total?: number }>("backup.cloud.snapshots");
      const snapshots = Array.isArray(result?.snapshots) ? result.snapshots : [];
      setCloudSnapshots({ busy: false, error: null, snapshots, total: typeof result?.total === "number" ? result.total : snapshots.length });
    } catch (requestError) {
      setCloudSnapshots({ busy: false, error: requestError instanceof Error ? requestError.message : "The bucket could not be listed", snapshots: null, total: 0 });
    }
  };
  const fetchSnapshot = (snapshot: CloudSnapshot) => start({
    operationId: "backup.cloud.fetch",
    title: "Fetch a machine snapshot from the cloud",
    parameters: { artifact: snapshot.artifact },
    preview: snapshot.local
      ? <span>Downloads the newest backup of each app in <code>{snapshot.artifact}</code> that is not on this server yet, decrypts it with the saved passphrase and checks it against the checksum recorded when it was taken, so the Restore tab brings the apps back with their data. Nothing on this server is replaced, and nothing is fetched unless all of it fits.</span>
      : <span>Downloads <code>{snapshot.artifact}</code>{snapshot.sizeBytes ? ` (${formatBytes(snapshot.sizeBytes)})` : ""} and each of its apps' newest backup from the bucket, decrypts them with the saved passphrase and checks each against the checksum recorded when it was taken. They then sit in this server's snapshot and app backup stores, where the Restore tab restores the apps with their data. Nothing on this server is replaced, and nothing is fetched unless all of it fits.</span>,
    onClosed: (job) => { if (job?.state === "completed") void findCloudSnapshots(); },
  });

  const mounted = Boolean(machine?.sync.mount.mounted);
  // What the last sync to the drive left out (R5B4-7): recent, and still not every backup.
  const driveSkipped = machine?.sync.lastSync?.skippedCount ?? 0;
  const saved = remoteSettings?.destination ?? null;
  // A viewer is told one is set, not where it is.
  const destination = saved && !("hidden" in saved) ? saved : null;
  const hiddenDestination = Boolean(saved && "hidden" in saved);
  const pinned = (remote?.hostKeysPinned ?? 0) > 0;

  const sshPort = ssh ? portOf(ssh.port) : null;
  const sshMissing = ssh ? [
    ...(!ssh.host.trim() ? ["Host"] : []),
    ...(sshPort === null ? ["a port from 1 to 65535"] : []),
    ...(!ssh.user.trim() ? ["User"] : []),
    ...(!ssh.path.trim() ? ["Path"] : []),
    ...(!owner.free && !ssh.password ? ["Owner password"] : []),
  ] : [];
  const saveSsh = async () => {
    if (!ssh || sshMissing.length || sshPort === null || saving) return;
    setSaving(true); setSshError(null);
    try {
      const response = await fetch("/api/v1/settings/backup-destination", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ ...(owner.free ? {} : { password: ssh.password }), destination: { host: ssh.host.trim(), port: sshPort, user: ssh.user.trim(), path: ssh.path.trim() } }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      // Sent without the password, inside a window that has since ended: the field shows, to send it again.
      if (owner.free && passwordAsked(response, body)) { owner.refused(); return; }
      if (!response.ok) throw new Error(body.error ?? "The destination could not be saved");
      setSsh(null);
      onChanged();
    } catch (requestError) {
      setSshError(requestError instanceof Error ? requestError.message : "The destination could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const spec = cloudForm ? cloud?.providers?.[cloudForm.provider] : undefined;
  const fields = spec?.fields ?? [];
  const secrets = spec?.secrets ?? [];
  const required = fields.filter((field) => !["endpoint", "region", "path"].includes(field));
  const valueOf = (field: string) => (cloudForm?.values[field] ?? "").trim();
  // The passphrase is typed twice and never shown: lost or mistyped, nobody can read the copies.
  const sealed = secrets.includes("passphrase");
  const passphrase = cloudForm?.values.passphrase ?? "";
  const passphraseAgain = cloudForm?.values[passphraseAgainKey] ?? "";
  const passphraseShort = sealed && passphrase.length > 0 && passphrase.trim().length < 12;
  const passphraseDiffers = sealed && passphraseAgain.length > 0 && passphraseAgain !== passphrase;
  // M91: a secret left empty keeps the saved one, when the saved one is still this account's (or, for the passphrase,
  // when a sealed destination was saved), so changing the folder does not mean typing the passphrase twice again.
  const savedDestination = cloudSettings?.destination ?? null;
  const keepable = (field: string) => {
    if (!savedDestination || !cloudForm) return false;
    if (field === "passphrase") return cloud?.sealed === true;
    if (savedDestination.provider !== cloudForm.provider) return false;
    return (secretAccountFields[cloudForm.provider] ?? []).every((name) => valueOf(name) === (savedDestination[name] ?? ""));
  };
  const keeping = secrets.filter((field) => !valueOf(field) && keepable(field));
  const missing = [
    ...[...required, ...secrets].filter((field) => !valueOf(field) && !keeping.includes(field)).map((field) => fieldLabels[field] ?? field),
    ...(cloudForm?.provider === "s3" && !valueOf("endpoint") && !valueOf("region") ? ["an endpoint or a region"] : []),
    ...(passphraseShort ? ["a passphrase of at least 12 characters"] : []),
    ...(sealed && passphrase && !passphraseAgain ? ["the passphrase typed again"] : []),
    ...(passphraseDiffers ? ["the same passphrase both times"] : []),
  ];
  const complete = Boolean(cloudForm) && missing.length === 0;
  const openCloud = () => {
    const saved = cloudSettings?.destination;
    const values = saved ? Object.fromEntries(Object.entries(saved).filter(([key, value]) => key !== "provider" && typeof value === "string").map(([key, value]) => [key, value as string])) : {};
    const first = Object.keys(cloud?.providers ?? {})[0] ?? "b2";
    setCloudRefusal(null);
    setCloudForm({ provider: saved?.provider ?? (cloud?.providers?.b2 ? "b2" : first), values });
  };
  const saveCloud = () => {
    if (!cloudForm || !complete || !cloud?.rcloneInstalled) return;
    const filled = cloudForm;
    const { provider, values } = filled;
    const typed = secrets.filter((field) => (values[field] ?? "").trim());
    const kept = keeping;
    setCloudForm(null);
    setCloudRefusal(null);
    start({
      operationId: "backup.cloud.setup",
      title: `Save the ${spec?.label ?? provider} backup destination`,
      parameters: { provider, ...Object.fromEntries([...fields, ...secrets].map((field) => [field, (values[field] ?? "").trim()]).filter(([, value]) => value)) },
      preview: <span>Saves where the copies go and how to sign in there, in a file on this server that only root can read.{typed.length > 0 && <> The {typed.map((field) => (fieldLabels[field] ?? field).toLowerCase()).join(" and ")} {typed.length === 1 ? "is" : "are"} held in memory until this job runs and never stored in BoxPilot's database.</>}{kept.length > 0 && <> The saved {kept.map((field) => (fieldLabels[field] ?? field).toLowerCase()).join(" and ")} {kept.length === 1 ? "stays" : "stay"} as {kept.length === 1 ? "it is" : "they are"}.</>} Test the connection afterwards.</span>,
      // The sheet closes for the approval, and comes back as it was filled in unless the job completed;
      // a save the server refused (a changed passphrase for a folder already sealed) says why there.
      onClosed: (job) => { if (job?.state !== "completed") { setCloudForm(filled); setCloudRefusal(job?.state === "failed" ? job.error ?? "The job failed; Activity has its log." : null); } },
    });
  };

  const scheduleButton = summary && summary.wanted.length > 0 && !summary.scheduled && summary.wanted.every(may)
    ? <Button variant="primary" disabled={scheduling?.busy} onClick={() => onMirrorNightly(summary.wanted)}>Keep a second copy nightly</Button>
    : undefined;
  const sshState = destinationState(Boolean(destination), syncedAt(remoteSettings?.lastSync));
  const cloudState = destinationState(Boolean(cloudSettings?.destination), syncedAt(cloudSettings?.lastSync));
  const savedCloud = cloudSettings?.destination ?? null;
  const lastReadBack = (cloudSettings?.lastSync as { readBack?: CloudReadBack | null } | null | undefined)?.readBack ?? null;
  const readBack = readBackLine(lastReadBack);

  return (
    <>
      {dialog}
      {scheduling && <Notice tone={scheduling.busy ? "info" : scheduling.failed ? "warning" : "success"} live title={scheduling.message} />}
      {summaryUnknown && <Notice tone="warning" title="Whether a copy is kept elsewhere could not be read">A destination's state did not come back, and no other destination is set up.</Notice>}
      {summary && (summary.warning
        ? (
          <Notice tone={summary.wanted.length === 0 ? "danger" : "warning"} title={summary.warning} action={scheduleButton}>
            {summary.wanted.length === 0 ? "Set up any one of the three below: a backup drive, another machine over SSH, or a cloud bucket." : summary.scheduled ? "A nightly copy is scheduled." : "A destination is set up, but nothing keeps the copy current."}
          </Notice>
        )
        : (
          <Notice tone={summary.scheduled ? "success" : "warning"} title={`Copied off this server ${summary.verdict.ageDays === 0 ? "today" : `${countOf(summary.verdict.ageDays ?? 0, "day")} ago`}`} action={scheduleButton}>
            {summary.scheduled ? "A nightly copy is scheduled." : "Nothing keeps the copy current: scheduling it is the difference between a backup plan and a backup."}
          </Notice>
        ))}

      <Panel
        title="Backup drive"
        count={machine ? { status: mounted ? "good" : "neutral", label: mounted ? "Mounted" : "Not mounted" } : undefined}
        meta={mounted ? "hash-verified copies, never deleted" : undefined}
        padded={mounted}
        actions={mounted && may("backup.sync") ? <Button risk={riskOf("backup.sync")} onClick={() => start({ operationId: "backup.sync", title: "Mirror local backups to the backup drive", parameters: {}, preview: <span>Copies the local backup folders (database backups, app backups, machine snapshots) onto the independent backup drive and verifies every copied file's hash. Nothing on the drive is ever deleted.</span> })}>Sync to backup drive</Button> : undefined}
      >
        {!machine
          ? <p className="backups-pad backups-dim">The backup drive's state could not be read.</p>
          : mounted
            ? (
              <>
                <KeyValue items={[
                  { id: "to", label: "Copies to", value: machine.sync.destination, mono: true },
                  { id: "free", label: "Free", value: formatBytes(machine.sync.mount.freeBytes ?? null), mono: true },
                  { id: "last", label: "Last synced", value: machine.sync.lastSync ? `${when(machine.sync.lastSync.completedAt)} · ${countOf(machine.sync.lastSync.copiedCount, "file")}${driveSkipped ? ` · ${driveSkipped} not copied` : ""}` : "never", mono: true, status: !machine.sync.lastSync || driveSkipped ? "warning" : undefined },
                ]} />
                {driveSkipped > 0 && (
                  <Notice tone="warning" className="backups-inset" title={`The last sync left ${countOf(driveSkipped, "file")} out`}>
                    <ul>{(machine.sync.lastSync?.skipped ?? []).map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    {driveSkipped > (machine.sync.lastSync?.skipped ?? []).length && <p>The job of that sync lists the rest.</p>}
                  </Notice>
                )}
              </>
            )
            : (
              <EmptyState title="No backup drive is mounted" action={onNavigate ? <Button onClick={() => onNavigate("storage")}>Open Storage</Button> : undefined}>
                {machine.sync.mount.blocker ?? <>Mount a NAS or a second drive on the Storage page with “Use this for BoxPilot's backups”: it lands at <code>/mnt/boxpilot/backup</code>, the path backups are copied to.</>}
              </EmptyState>
            )}
      </Panel>

      <Panel
        title="Another computer over SSH"
        count={remote || remoteSettings ? sshState : undefined}
        meta="rsync over SSH with BoxPilot's own key · nothing deleted there"
        padded
        actions={<>
          {remote && !remote.keyReady && may("backup.remote.setup") && <Button risk={riskOf("backup.remote.setup")} onClick={() => start({ operationId: "backup.remote.setup", title: "Create the key for copies on another computer", parameters: {}, preview: <span>Makes a key for BoxPilot to sign in to the other computer with. The private half never leaves this server; the public half is shown here afterwards, for you to add on that computer.</span> })}>Create key</Button>}
          {role === "owner" && <Button onClick={() => { setSshError(null); setSsh({ host: destination?.host ?? "", port: String(destination?.port ?? 22), user: destination?.user ?? "", path: destination?.path ?? "", password: "" }); }}>{destination ? "Change destination" : "Set destination"}</Button>}
          {destination && remote?.keyReady && may("backup.remote.test") && <Button risk={riskOf("backup.remote.test")} onClick={() => start({ operationId: "backup.remote.test", title: "Test the other computer", parameters: {}, preview: <span>Connects as <code>{destination.user}@{destination.host}</code>, creates <code>{destination.path}</code> if needed, checks it is writable, and pins the destination's host key on first use.</span> })}>Test connection</Button>}
          {destination && remote?.keyReady && (remote.rsyncInstalled
            ? may("backup.remote.sync") && <Button variant="primary" risk={riskOf("backup.remote.sync")} disabled={!pinned} title={pinned ? undefined : "Test the connection first"} onClick={() => start({ operationId: "backup.remote.sync", title: `Copy backups to ${destination.host}`, parameters: {}, preview: <span>Copies the database backups, app backups and machine snapshots to <code>{destination.host}</code>. Files already there are not sent again; nothing there is ever deleted.{summary && !summary.scheduled ? " “Keep a second copy nightly”, on this tab, keeps it current." : ""}</span> })}>Copy now</Button>
            : may("apt.install") && <Button risk={riskOf("apt.install")} onClick={() => start({ operationId: "apt.install", title: "Install rsync", parameters: { packages: ["rsync"] }, preview: <span>Installs the <code>rsync</code> package from Ubuntu's repositories; the mirror needs it on this server.</span> })}>Install rsync</Button>)}
        </>}
      >
        <KeyValue items={[
          { id: "key", label: "Mirror key", value: remote?.keyReady ? `ready${remote.fingerprint ? ` · ${remote.fingerprint}` : ""}` : remote ? "not created yet" : "not read", mono: true, status: remote && !remote.keyReady ? "warning" : undefined },
          { id: "destination", label: "Destination", value: destination ? `${destination.user}@${destination.host}:${destination.path}${destination.port && destination.port !== 22 ? ` (port ${destination.port})` : ""}` : hiddenDestination ? "set (an operator or the owner can see where)" : "not set", mono: !hiddenDestination },
          { id: "pinned", label: "Host key", value: destination ? (pinned ? `pinned (${remote?.hostKeysPinned})` : "not pinned: test the connection first") : "—", mono: true, status: destination && !pinned ? "warning" : undefined },
          { id: "last", label: "Last mirrored", value: remoteSettings?.lastSync ? `${when(remoteSettings.lastSync.completedAt)} · ${countOf(remoteSettings.lastSync.filesTransferred, "file")}` : "never", mono: true },
        ]} />
        {remote?.publicKey && <CodeBlock label="Mirror public key" meta="for the destination user's ~/.ssh/authorized_keys">{remote.publicKey}</CodeBlock>}
      </Panel>

      <Panel
        title="Cloud bucket"
        count={cloud || cloudSettings ? cloudState : undefined}
        meta="B2, S3, WebDAV, Google Drive, OneDrive or Dropbox through rclone · copies only"
        padded
        actions={<>
          {cloud && !cloud.rcloneInstalled && may("apt.install") && <Button risk={riskOf("apt.install")} onClick={() => start({ operationId: "apt.install", title: "Install rclone", parameters: { packages: ["rclone"] }, preview: <span>Installs rclone from Ubuntu's repositories: the program that copies backups to a cloud bucket. Nothing is copied until a destination is set.</span> })}>Install rclone</Button>}
          {cloud && may("backup.cloud.setup") && <Button risk={riskOf("backup.cloud.setup")} disabled={!cloud.rcloneInstalled} title={cloud.rcloneInstalled ? undefined : "Install rclone first"} onClick={openCloud}>{savedCloud ? "Change destination" : "Set destination"}</Button>}
          {savedCloud && may("backup.cloud.test") && <Button risk={riskOf("backup.cloud.test")} onClick={() => start({ operationId: "backup.cloud.test", title: "Test the cloud destination", parameters: {}, preview: <span>Creates the destination folder with the saved credentials and lists it, writes a small marker through the encryption and reads it back, and opens the newest snapshot already in the bucket with the saved passphrase. No backup is copied.</span> })}>Test connection</Button>}
          {savedCloud && may("backup.cloud.sync") && <Button variant="primary" risk={riskOf("backup.cloud.sync")} onClick={() => start({ operationId: "backup.cloud.sync", title: "Copy backups to the cloud", parameters: {}, preview: <span>Copies the database backups, app backups and machine snapshots to the bucket, sealed with your passphrase. Files already there are not sent again; nothing there is ever deleted. Afterwards the newest machine snapshot is downloaded back and checked against the one here.</span> })}>Copy now</Button>}
        </>}
      >
        {cloudError && <Notice tone="danger" live title="The cloud destination could not be read" action={<Button onClick={onChanged}>Try again</Button>}>{cloudError}</Notice>}
        {cloud?.configured && cloud.sealed === false && <Notice tone="warning" title="The cloud mirror is not encrypted">App backups hold each app's passwords and keys, so mirroring stops until the destination is set again with an encryption passphrase. Copies made before this stay in the bucket unencrypted until you delete them there.</Notice>}
        <KeyValue items={[
          { id: "provider", label: "Provider", value: savedCloud ? cloud?.providers?.[savedCloud.provider]?.label ?? savedCloud.provider : "not set" },
          ...(savedCloud?.bucket ? [{ id: "bucket", label: "Bucket", value: savedCloud.bucket, mono: true }] : []),
          ...(savedCloud?.path ? [{ id: "folder", label: "Folder", value: savedCloud.path, mono: true }] : []),
          { id: "last", label: "Last mirrored", value: cloudSettings?.lastSync ? `${when(cloudSettings.lastSync.completedAt)} · ${countOf(cloudSettings.lastSync.filesTransferred, "file")}${cloudSettings.lastSync.errors ? ` · ${cloudSettings.lastSync.errors} errors` : ""}` : "never", mono: true, status: cloudSettings?.lastSync?.errors ? "warning" : undefined },
          { id: "readback", label: "Last read back", value: readBack.value, mono: true, status: readBack.status },
          { id: "rclone", label: "rclone", value: cloud ? (cloud.rcloneInstalled ? "installed" : "not installed") : "not read", mono: true, status: cloud && !cloud.rcloneInstalled ? "warning" : undefined },
        ]} />
        {lastReadBack?.ok === false && (
          <Notice tone="danger" className="backups-inset" title="The copy in the bucket did not read back">
            After the last mirror, {lastReadBack.artifact ?? "the newest machine snapshot"} could not be downloaded and decrypted to match the one here: {lastReadBack.error ?? "unknown error"}. Test the connection, which opens the copies with the saved passphrase.
          </Notice>
        )}
        {cloud?.sealed && role !== "viewer" && (
          <div className="backups-inset">
            <Table
              caption="Snapshots in the cloud"
              showCaption
              columns={[
                { id: "taken", header: "Taken", cell: (snapshot: CloudSnapshot) => { const at = takenAt(snapshot.artifact); return at ? when(at) : <code className="backups-wrap">{snapshot.artifact}</code>; } },
                { id: "size", header: "Size", numeric: true, cell: (snapshot: CloudSnapshot) => formatBytes(snapshot.sizeBytes) },
                { id: "here", header: "On this server", cell: (snapshot: CloudSnapshot) => (snapshot.local ? "yes" : "no") },
                // Here already: its app backups can still be fetched, which finishes a fetch an app's download failed in.
                { id: "fetch", header: <span className="ui-visually-hidden">Fetch</span>, label: "Fetch", cell: (snapshot: CloudSnapshot) => (snapshot.local
                  ? may("backup.cloud.fetch") && snapshot.hasMeta
                    ? <Button risk={riskOf("backup.cloud.fetch")} aria-label={`Fetch the app backups of ${snapshot.artifact}`} onClick={() => fetchSnapshot(snapshot)}>Fetch app backups</Button>
                    : <span className="backups-dim">on the Restore tab</span>
                  : may("backup.cloud.fetch")
                    ? <Button risk={riskOf("backup.cloud.fetch")} disabled={!snapshot.hasMeta} title={snapshot.hasMeta ? undefined : "Its record is not in the bucket, so it cannot be checked"} aria-label={`Fetch ${snapshot.artifact}`} onClick={() => fetchSnapshot(snapshot)}>Fetch</Button>
                    : null) },
              ]}
              rows={cloudSnapshots.snapshots ?? []}
              rowKey={(snapshot) => snapshot.artifact}
              empty={cloudSnapshots.busy
                ? "Reading the bucket…"
                : cloudSnapshots.snapshots === null
                  ? <EmptyState title="Not read yet" action={<Button onClick={() => void findCloudSnapshots()}>Find snapshots in the cloud</Button>}>Lists the machine snapshots in the bucket, read with the saved passphrase. A rebuilt server fetches the old one's this way, with each app's newest backup, then restores it from the Restore tab.</EmptyState>
                  : "No machine snapshot is in the bucket yet."}
            />
            {cloudSnapshots.snapshots !== null && <Button onClick={() => void findCloudSnapshots()} busy={cloudSnapshots.busy}>Read the bucket again</Button>}
            {cloudSnapshots.total > (cloudSnapshots.snapshots?.length ?? 0) && <p className="backups-note">The newest {cloudSnapshots.snapshots?.length} of {cloudSnapshots.total} are listed.</p>}
            {cloudSnapshots.error && <Notice tone="warning" live title="The bucket could not be listed" action={<Button onClick={() => void findCloudSnapshots()}>Try again</Button>}>{cloudSnapshots.error}</Notice>}
          </div>
        )}
      </Panel>

      {ssh && (
        <Sheet
          className="backups-sheet"
          kicker="Another computer over SSH"
          title={destination ? "Change the destination" : "Set the destination"}
          onClose={() => setSsh(null)}
          footer={<>
            {sshMissing.length > 0 && <span className="backups-blocker">Still needed: {sshMissing.join(", ")}.</span>}
            <Button variant="ghost" onClick={() => setSsh(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form={sshFormId} busy={saving} disabled={sshMissing.length > 0}>{saving ? "Saving…" : "Save destination"}</Button>
          </>}
        >
          <form id={sshFormId} className="backups-form" onSubmit={(event) => { event.preventDefault(); void saveSsh(); }}>
          <Field label="Host" hint="A name or address, or a device on your tailnet.">
            <TextInput mono list={hostsId} placeholder="nas.local" autoComplete="off" value={ssh.host} onValueChange={(value) => setSsh({ ...ssh, host: value })} />
          </Field>
          <datalist id={hostsId}>{tailnetHosts.map((entry) => <option value={entry} key={entry} />)}</datalist>
          <Field label="Port" error={ssh.port.trim() && sshPort === null ? "A number from 1 to 65535." : undefined}>
            <TextInput mono type="number" min={1} max={65535} value={ssh.port} onValueChange={(value) => setSsh({ ...ssh, port: value })} />
          </Field>
          <Field label="User" hint="The account on the destination that holds BoxPilot's public key.">
            <TextInput mono autoComplete="off" placeholder="backup" value={ssh.user} onValueChange={(value) => setSsh({ ...ssh, user: value })} />
          </Field>
          <Field label="Path" hint="An absolute folder; it is created if needed. Nothing there is ever deleted.">
            <TextInput mono placeholder="/volume1/boxpilot" value={ssh.path} onValueChange={(value) => setSsh({ ...ssh, path: value })} />
          </Field>
          {owner.free
            ? <p className="backups-note">{owner.note} No password for the destination is stored here.</p>
            : (
              <Field label="Owner password" hint={owner.asked ? passwordAskedWords : "Changing where backups go asks for yours. No password for the destination is stored here."}>
                <SecretInput autoComplete="current-password" value={ssh.password} onValueChange={(value) => setSsh({ ...ssh, password: value })} />
              </Field>
            )}
          {sshError && <Notice tone="danger" live title="The destination was not saved">{sshError}</Notice>}
          </form>
        </Sheet>
      )}

      {cloudForm && cloud && (
        <Sheet
          className="backups-sheet"
          kicker="Cloud bucket"
          title={savedCloud ? "Change the cloud destination" : "Set the cloud destination"}
          onClose={() => setCloudForm(null)}
          footer={<>
            {/* Six fields and a greyed-out button is a guessing game; say which one is empty. */}
            {!complete && <span className="backups-blocker">Still needed: {missing.join(", ")}.</span>}
            <Button variant="ghost" onClick={() => setCloudForm(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("backup.cloud.setup")} disabled={!complete || !cloud.rcloneInstalled} onClick={saveCloud}>Save destination</Button>
          </>}
        >
          {cloudRefusal && <Notice tone="danger" live title="The destination was not saved">{cloudRefusal}</Notice>}
          <Field label="Provider" hint={spec?.help}>
            <Select value={cloudForm.provider} onValueChange={(value) => setCloudForm({ ...cloudForm, provider: value })} options={Object.entries(cloud.providers ?? {}).map(([id, entry]) => ({ value: id, label: entry.label }))} />
          </Field>
          {fields.map((field) => (
            <Field key={field} label={fieldLabels[field] ?? field} optional={!required.includes(field)}>
              <TextInput mono autoComplete="off" placeholder={placeholders[field] ?? ""} value={cloudForm.values[field] ?? ""} onValueChange={(value) => setCloudForm({ ...cloudForm, values: { ...cloudForm.values, [field]: value } })} />
            </Field>
          ))}
          {secrets.map((field) => (
            <Fragment key={field}>
              <Field label={fieldLabels[field] ?? field} optional={keepable(field)} error={field === "passphrase" && passphraseShort ? "At least 12 characters." : undefined} hint={`${keepable(field) ? "Leave it empty to keep the saved one. " : ""}${field === "token" ? "Paste what rclone authorize printed." : field === "passphrase" ? "Every copy is encrypted with it before it leaves this server: app backups hold each app's passwords and keys. At least 12 characters. Keep it somewhere other than this server; without it nobody, you included, can read the copies in the bucket." : "Kept in a file on this server that only root can read, never in BoxPilot's database."}`}>
                {field === "token"
                  ? <Textarea mono rows={3} placeholder='{"access_token":"...","token_type":"Bearer",...}' value={cloudForm.values[field] ?? ""} onValueChange={(value) => setCloudForm({ ...cloudForm, values: { ...cloudForm.values, [field]: value } })} />
                  : <SecretInput autoComplete="new-password" value={cloudForm.values[field] ?? ""} onValueChange={(value) => setCloudForm({ ...cloudForm, values: { ...cloudForm.values, [field]: value } })} />}
              </Field>
              {field === "passphrase" && (
                <Field label="Type it again" error={passphraseDiffers ? "The two do not match." : undefined}>
                  <SecretInput autoComplete="new-password" value={passphraseAgain} onValueChange={(value) => setCloudForm({ ...cloudForm, values: { ...cloudForm.values, [passphraseAgainKey]: value } })} />
                </Field>
              )}
            </Fragment>
          ))}
        </Sheet>
      )}
    </>
  );
}
