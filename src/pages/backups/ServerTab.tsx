import { useOperation } from "../../shell/ApproveDialog";
import { formatBytes } from "../../formatBytes";
import { Button, EmptyState, Notice, Panel, StatusChip, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { when, withData, type BackupRecord, type MachineSnapshot, type MachineSnapshotState, type ProtectionState, type RetentionStatus } from "./types";

/*
 * This server (M33.9): BoxPilot's own database, backed up with no downtime and restore-drilled
 * before it is recorded, with an encrypted second copy of each on request; and machine snapshots,
 * one archive to redeploy this server, with how many of its apps would come back with their data.
 */

export interface ServerTabProps {
  csrfToken: string;
  role: string;
  loading: boolean;
  /** The database's backups, newest first; null when they could not be read. */
  backups: BackupRecord[] | null;
  protection: ProtectionState | null;
  retention: RetentionStatus | null;
  machine: MachineSnapshotState | null;
  onChanged: () => void;
}

export default function ServerTab({ csrfToken, role, loading, backups, protection, retention, machine, onChanged }: ServerTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const may = (operationId: string) => mayStart(role, operationId);

  // A copy the retention run forgot is no longer in the repository, so it is not a protected copy.
  const live = (protection?.protections ?? []).filter((entry) => entry.retained !== false && entry.protected !== false);
  const protectedIds = new Set(live.map((entry) => entry.backupId));
  // A backup can be protected once. Where retention has since forgotten that copy, offering the
  // button again only produces an error, so the row says what happened instead.
  const forgottenIds = new Set((protection?.protections ?? []).filter((entry) => entry.retained === false).map((entry) => entry.backupId));
  const ready = Boolean(protection?.destination?.ready);
  const list = backups ?? [];
  const snapshots = machine?.snapshots ?? [];
  const candidates = retention?.candidates?.length ?? 0;

  const backupColumns: Array<TableColumn<BackupRecord>> = [
    { id: "created", header: "Created", sortValue: (backup) => backup.createdAt, cell: (backup) => when(backup.createdAt) },
    { id: "size", header: "Size", numeric: true, sortValue: (backup) => backup.sizeBytes, cell: (backup) => formatBytes(backup.sizeBytes) },
    { id: "drill", header: "Drill", cell: (backup) => (backup.restoreDrill?.passed ? <StatusChip status="good">passed</StatusChip> : <StatusChip status="warning">unverified</StatusChip>) },
    {
      id: "copy", header: "Encrypted copy", cell: (backup) => (protectedIds.has(backup.id) ? <StatusChip status="good">protected</StatusChip>
        : forgottenIds.has(backup.id) ? <StatusChip status="neutral" title="Retention removed the encrypted copy of this backup">copy removed</StatusChip>
          : <span className="backups-dim">—</span>),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "backups-actions-cell", cell: (backup) => (
        <span className="backups-actions">
          {ready && may("controller.backup.protect") && !protectedIds.has(backup.id) && !forgottenIds.has(backup.id) && (
            <Button risk={riskOf("controller.backup.protect")} aria-label={`Protect the backup of ${when(backup.createdAt)}`} onClick={() => start({
              operationId: "controller.backup.protect",
              title: "Keep a second copy of this backup",
              parameters: { backupId: backup.id },
              preview: <span>Copies this backup into a separate encrypted store, reads the whole store back to prove it arrived intact, and restores that exact copy in isolation to prove it opens. Nothing existing is removed or overwritten.</span>,
            })}>Protect</Button>
          )}
        </span>
      ),
    },
  ];

  const snapshotColumns: Array<TableColumn<MachineSnapshot>> = [
    { id: "created", header: "Created", sortValue: (snapshot) => snapshot.createdAt ?? snapshot.artifact, cell: (snapshot) => (snapshot.createdAt ? when(snapshot.createdAt) : <code>{snapshot.artifact}</code>) },
    { id: "size", header: "Size", numeric: true, cell: (snapshot) => (snapshot.sizeBytes ? formatBytes(snapshot.sizeBytes) : "—") },
    { id: "apps", header: "Apps", numeric: true, cell: (snapshot) => snapshot.contents?.apps?.length ?? "—" },
    {
      id: "data", header: "With their data", cell: (snapshot) => {
        const whole = withData(snapshot);
        const apps = snapshot.contents?.apps?.length ?? 0;
        return whole === null ? <span className="backups-dim">—</span> : whole === apps
          ? <StatusChip status="good">all {whole}</StatusChip>
          : <StatusChip status="warning" title="The others would come back installed and empty">{whole} of {apps}</StatusChip>;
      },
    },
    { id: "vms", header: "VMs", numeric: true, cell: (snapshot) => snapshot.contents?.vms?.domains?.length ?? "—" },
    { id: "sha", header: "SHA-256", hideOnPhone: true, cell: (snapshot) => (snapshot.checksumSha256 ? <code title={snapshot.checksumSha256}>{snapshot.checksumSha256.slice(0, 16)}…</code> : "—") },
  ];

  return (
    <>
      {dialog}
      <Panel
        title="BoxPilot database"
        count={backups ? list.length : undefined}
        meta={backups ? <>latest <b>{list[0] ? when(list[0].createdAt) : "never"}</b> · <b>{live.length}</b> encrypted {live.length === 1 ? "copy" : "copies"}</> : undefined}
        actions={may("controller.backup.create") ? <Button variant="primary" risk={riskOf("controller.backup.create")} disabled={loading && !backups} onClick={() => start({ operationId: "controller.backup.create", title: "Back up the BoxPilot database", parameters: {}, preview: <span>Snapshots the live database with <code>VACUUM INTO</code> (no downtime) and restore-drills the copy before recording it.</span> })}>Back up now</Button> : undefined}
        footer={retention?.policy ? (
          <span className="backups-foot backups-foot--row">
            <span>Retention keeps at least <b>{retention.policy.minimumCopies ?? 3}</b> restore-tested encrypted copies · <b>{candidates}</b> eligible to let go</span>
            {candidates > 0 && may("controller.backup.retention.apply") && (
              <Button risk={riskOf("controller.backup.retention.apply")} onClick={() => start({ operationId: "controller.backup.retention.apply", title: "Let go of old database backups", parameters: {}, preview: <span>Removes the record of old backups that are safe to let go, then checks the store is still intact. The files themselves are not deleted and no space is reclaimed yet, so nothing recent is ever at risk.</span> })}>Apply retention</Button>
            )}
          </span>
        ) : undefined}
      >
        {protection && !ready && (
          <Notice tone="info" className="backups-inset" title="Encrypted second copies are not ready">{protection.destination?.blockers?.[0] ?? "The restic repository needs setting up in a terminal."}</Notice>
        )}
        <Table
          caption="Backups of BoxPilot's database"
          columns={backupColumns}
          rows={list}
          rowKey={(backup) => backup.id}
          rowStatus={(backup) => (backup.restoreDrill?.passed ? undefined : "warning")}
          empty={!backups
            ? (loading ? "Reading the backups…" : "The backups could not be read.")
            : <EmptyState title="No database backups yet">Back up now creates one and restore-drills it before recording it.</EmptyState>}
        />
      </Panel>

      <Panel
        title="Machine snapshots"
        count={machine ? snapshots.length : undefined}
        meta={machine ? <>newest <b>{machine.keep || 3}</b> kept · settings and secrets, not the data</> : undefined}
        actions={may("host.snapshot.create") ? <Button variant="primary" risk={riskOf("host.snapshot.create")} disabled={loading && !machine} onClick={() => start({ operationId: "host.snapshot.create", title: "Create a machine snapshot", parameters: {}, preview: <span>Takes a fresh verified database backup and bundles it with every installed app's compose project (settings and secrets), netplan, firewall rules, fstab, and VM definitions. The archive contains secrets. Keep copies only on encrypted or physically controlled media. The newest {machine?.keep || 3} snapshots are kept.</span> })}>Create machine snapshot</Button> : undefined}
      >
        <Table
          caption="Machine snapshots"
          columns={snapshotColumns}
          rows={snapshots}
          rowKey={(snapshot) => snapshot.artifact}
          rowStatus={(snapshot) => { const whole = withData(snapshot); return whole !== null && whole < (snapshot.contents?.apps?.length ?? 0) ? "warning" : undefined; }}
          empty={!machine
            ? (loading ? "Reading the machine snapshots…" : "The machine snapshots could not be read.")
            : <EmptyState title="No machine snapshots yet">One archive to redeploy this server: the database, every app's settings and secrets, network and firewall config, and each VM's definition.</EmptyState>}
        />
      </Panel>
    </>
  );
}
