import { useState } from "react";
import { countOf, sentenceList } from "../../data";
import { Button, CodeBlock, EmptyState, Field, KeyValue, Notice, Panel, Sheet, StatusChip, Table, Tag, TextInput, mayStart, riskOf, type Status } from "../../ui";
import { formatBytes, type VmExportArtifact, type VmProtectedBackup, type VmProtectionDestination, type VmRecoveryRecord, type VmRetentionStatus } from "../../virtualization";
import { AsksFor, isVmName, vmNamePattern, when, type StartOperation } from "./vmActions";

export interface VmBackupData {
  exports: VmExportArtifact[];
  destination: VmProtectionDestination | null;
  backups: VmProtectedBackup[];
  retention: VmRetentionStatus | null;
  recoveries: VmRecoveryRecord[];
  /** Which of the four reads failed, in words: "exports", "the encrypted destination"... */
  unread: string[];
}

function backupState(backup: VmProtectedBackup): { status: Status; label: string } {
  if (backup.retained === false) return { status: "neutral", label: "forgotten" };
  return backup.protected ? { status: "good", label: "protected" } : { status: "warning", label: "not protected" };
}

/**
 * A VM's way back (M33.12): a local export, an encrypted copy kept off this server, a test restore
 * that boots it, and a recovery clone built from it. Retention lets go of old copies only when
 * enough restore-tested ones remain. Each step is its own approved job.
 */
export function VmBackups({ data, role, start }: { data: VmBackupData; role: string; start: StartOperation }) {
  const [recoveryFor, setRecoveryFor] = useState<VmProtectedBackup | null>(null);
  const [recoveryName, setRecoveryName] = useState("");
  const { exports, destination, backups, retention, recoveries, unread } = data;
  const ready = Boolean(destination?.ready);
  const protectedCount = backups.filter((backup) => backup.protected && backup.retained !== false).length;
  const candidates = retention?.candidates?.length ?? 0;
  const unrecorded = retention?.unrecordedSnapshotIds ?? [];
  const minimumCopies = retention?.policy?.minimumCopiesPerDomain ?? 3;
  const minimumDays = retention?.policy?.minimumAgeDays ?? 30;

  const protect = (artifact: VmExportArtifact) => start({
    operationId: "vm.export.protect",
    title: `Keep an encrypted copy of ${artifact.domainName}`,
    parameters: { exportId: artifact.id },
    preview: <span>Re-checks the local copy, writes an encrypted copy to the separate destination, and reads the whole thing back to prove it arrived intact. It only counts as backed up once a test restore has opened it, which is the next step.</span>,
  });
  const drill = (backup: VmProtectedBackup) => start({
    operationId: "vm.backup.restore-drill",
    title: `Restore drill for ${backup.domainName}`,
    parameters: { backupId: backup.id },
    preview: <span>Restores the encrypted snapshot to a temporary workspace, boots it as a transient VM with no network, and requires guest-agent health before marking the backup protected. Everything transient is cleaned up afterwards.</span>,
  });
  const applyRetention = () => start({
    operationId: "vm.backup.retention.apply",
    title: "Apply VM backup retention",
    parameters: {},
    preview: <span>Lets go of old backups that are safe to drop: only ones that passed a test restore, are no longer in use, are past the minimum age, and never below {minimumCopies} restore-tested copies per VM. Then checks the store is intact. The files stay and no space is reclaimed, so nothing you still need is touched.</span>,
  });
  const forget = (snapshotId: string) => start({
    operationId: "vm.backup.snapshot.forget",
    title: `Forget snapshot ${snapshotId.slice(0, 8)}`,
    parameters: { snapshotId },
    confirmText: snapshotId.slice(0, 8),
    preview: <span>Removes snapshot <code>{snapshotId.slice(0, 12)}</code> from the encrypted repository. It has no local backup record, so nothing BoxPilot knows about is lost, but if it is in fact a copy you want, this cannot be undone. Nothing is pruned.</span>,
  });
  const openRecovery = (backup: VmProtectedBackup) => { setRecoveryFor(backup); setRecoveryName(`${backup.domainName}-recovery`); };
  const recover = () => {
    if (!recoveryFor || !isVmName(recoveryName)) return;
    const backup = recoveryFor;
    const targetDomainName = recoveryName;
    setRecoveryFor(null);
    start({
      operationId: "vm.recovery.create",
      title: `Recover ${backup.domainName} as ${targetDomainName}`,
      parameters: { backupId: backup.id, targetDomainName },
      preview: <span>Restores the protected snapshot into a new persistent VM named <code>{targetDomainName}</code>. Stopped, no network, autostart off. The source VM, backup, and repository are unchanged.</span>,
    });
  };

  return (
    <>
      <KeyValue layout="strip" items={[
        { id: "store", label: "Encrypted store", status: destination ? (ready ? "good" : "warning") : "unknown", value: destination ? (ready ? "ready" : "setup required") : "not read" },
        { id: "exports", label: "Local exports", value: unread.includes("exports") ? "—" : String(exports.length) },
        { id: "copies", label: "Encrypted copies", value: String(backups.filter((backup) => backup.retained !== false).length) },
        { id: "protected", label: "Restore-tested", status: backups.length ? (protectedCount ? "good" : "warning") : undefined, value: String(protectedCount) },
        { id: "recoveries", label: "Recovery clones", value: unread.includes("recoveries") ? "—" : String(recoveries.length) },
      ]} />

      {unread.length > 0 && <Notice tone="warning" title="Not everything here could be read">BoxPilot could not read {sentenceList(unread)} just now, so what is shown for those is not the whole picture. Read again in a moment.</Notice>}

      <Panel padded title="Encrypted store" count={destination ? { status: ready ? "good" : "warning", label: ready ? "ready" : "setup required" } : { status: "unknown", label: "not read" }}>
        {destination && ready && (
          <KeyValue items={[
            { id: "restic", label: "Restic", value: destination.resticVersion ?? "detected", mono: true },
            { id: "mount", label: "Mounted at", value: destination.mount ? `${destination.mount.target} (${destination.mount.sourceType})` : "mounted storage", mono: true },
            { id: "free", label: "Free", value: destination.destinationFreeBytes === null ? "—" : formatBytes(destination.destinationFreeBytes), mono: true },
          ]} />
        )}
        {destination && !ready && (
          <>
            <ul className="vms-list">{(destination.blockers ?? []).map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            <CodeBlock label="Run from the server's terminal">{destination.setupCommand}</CodeBlock>
            <p className="vms-note">Keep a recovery copy of the repository password outside this server.</p>
          </>
        )}
        {!destination && <p className="vms-note">{unread.includes("the encrypted destination") ? "The destination could not be read just now." : "Set it up on the Backups page to keep second copies."}</p>}
      </Panel>

      <Panel title="Local exports" count={exports.length} meta="copies on this server only">
        <Table<VmExportArtifact>
          caption="VM exports on this server"
          columns={[
            { id: "vm", header: "VM", sortValue: (artifact) => artifact.domainName, cell: (artifact) => <span className="vms-cell"><strong>{artifact.domainName}</strong><code className="vms-sub" title={artifact.id}>{artifact.id}</code></span> },
            { id: "size", header: "Size", numeric: true, cell: (artifact) => formatBytes(artifact.sizeBytes) },
            { id: "made", header: "Made", hideOnPhone: true, sortValue: (artifact) => artifact.createdAt, cell: (artifact) => when(artifact.createdAt) },
            { id: "state", header: "Kept safe", cell: (artifact) => (
              <span className="vms-tags">
                <Tag tone={artifact.encrypted ? "good" : "neutral"}>{artifact.encrypted ? "encrypted" : "not encrypted"}</Tag>
                <Tag tone={artifact.protected ? "good" : "neutral"}>{artifact.protected ? "protected" : "not protected"}</Tag>
                <Tag tone={artifact.restoreDrill.passed ? "good" : "neutral"}>{artifact.restoreDrill.passed ? "drill passed" : "drill not run"}</Tag>
              </span>
            ) },
            {
              id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "vms-actions-cell", cell: (artifact) => (
                <span className="vms-actions">
                  {mayStart(role, "vm.export.protect") && <Button risk={riskOf("vm.export.protect")} disabled={!ready} title={ready ? undefined : "Set up the encrypted store first"} onClick={() => protect(artifact)}>Keep a second copy</Button>}
                </span>
              ),
            },
          ]}
          rows={exports}
          rowKey={(artifact) => artifact.id}
          empty={unread.includes("exports")
            ? <EmptyState title="Exports could not be read">This does not mean there are none: the list could not be read just now.</EmptyState>
            : <EmptyState title="No VM exports yet">Stop a VM, then Export it from its sheet. It counts as backed up once that copy is encrypted, kept off this server, and proven by a test restore.</EmptyState>}
        />
      </Panel>

      <Panel title="Encrypted copies" count={backups.length} meta="kept off this server">
        <Table<VmProtectedBackup>
          caption="Encrypted VM copies"
          columns={[
            { id: "vm", header: "VM", sortValue: (backup) => backup.domainName, cell: (backup) => <strong>{backup.domainName}</strong> },
            { id: "size", header: "Size", numeric: true, cell: (backup) => formatBytes(backup.sizeBytes) },
            { id: "checked", header: "Checked", hideOnPhone: true, cell: (backup) => `${backup.repositoryVerified ? "read back intact" : "not yet read back"} · ${backup.restoreDrill.passed ? "test restore passed" : "test restore needed"}` },
            { id: "state", header: "State", cell: (backup) => { const state = backupState(backup); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
            {
              id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "vms-actions-cell", cell: (backup) => (
                <span className="vms-actions">
                  {backup.retained !== false && !backup.protected && mayStart(role, "vm.backup.restore-drill") && <Button risk={riskOf("vm.backup.restore-drill")} onClick={() => drill(backup)}>Test the restore</Button>}
                  {backup.retained !== false && backup.protected && mayStart(role, "vm.recovery.create") && <Button risk={riskOf("vm.recovery.create")} onClick={() => openRecovery(backup)}>Create recovery clone</Button>}
                  {backup.retained === false && <span className="vms-note">Forgotten {backup.retention?.forgottenAt ? when(backup.retention.forgottenAt) : "by retention"}</span>}
                </span>
              ),
            },
          ]}
          rows={backups}
          rowKey={(backup) => backup.id}
          rowStatus={(backup) => (backup.retained !== false && !backup.protected ? "warning" : undefined)}
          empty={<EmptyState title="No encrypted copies yet">Keep a second copy of an export once the encrypted store is ready.</EmptyState>}
        />
      </Panel>

      <Panel padded title="Retention" count={retention ? `${candidates} eligible` : undefined}
        actions={mayStart(role, "vm.backup.retention.apply") ? <Button risk={riskOf("vm.backup.retention.apply")} disabled={!ready || candidates === 0} onClick={applyRetention}>Apply retention</Button> : undefined}>
        {retention ? (
          <>
            <KeyValue items={[
              { id: "keep", label: "Keeps", value: `at least ${countOf(minimumCopies, "restore-tested copy", "restore-tested copies")} per VM, and every copy under ${countOf(minimumDays, "day")}` },
              { id: "eligible", label: "Eligible now", value: String(candidates), mono: true },
              { id: "snapshots", label: "Repository snapshots", value: String(retention.beforeCount ?? 0), mono: true },
              { id: "runs", label: "Completed runs", value: String(retention.retentionRuns?.length ?? 0), mono: true },
            ]} />
            {(retention.blockers?.length ?? 0) > 0 && <ul className="vms-list">{retention.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            <p className="vms-note">Only restore-tested, unreferenced snapshots can qualify. Prune is off, so retention does not claim reclaimed disk space.</p>
          </>
        ) : <p className="vms-note">The retention policy could not be read just now.</p>}
      </Panel>

      {unrecorded.length > 0 && (
        <Panel padded title="Snapshots with no local record" count={{ status: "warning", label: String(unrecorded.length) }}
          footer={mayStart(role, "vm.backup.snapshot.forget") ? <AsksFor action="Forgetting one" what="first eight characters of its id" /> : undefined}>
          <p className="vms-note">Usually a backup that was written and then failed its check. Retention will not run while they are there, because it cannot account for them.</p>
          <ul className="vms-forget">
            {unrecorded.map((snapshotId) => (
              <li key={snapshotId}>
                <code>{snapshotId.slice(0, 12)}</code>
                {mayStart(role, "vm.backup.snapshot.forget") && <Button risk={riskOf("vm.backup.snapshot.forget")} onClick={() => forget(snapshotId)}>Forget {snapshotId.slice(0, 8)}</Button>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {recoveries.length > 0 && (
        <Panel title="Recovery clones" count={recoveries.length} meta="stopped · no network · autostart off">
          <Table<VmRecoveryRecord>
            caption="VMs recovered from backups"
            columns={[
              { id: "vm", header: "VM", cell: (recovery) => <strong>{recovery.domainName}</strong> },
              { id: "from", header: "From", cell: (recovery) => recovery.sourceDomainName },
              { id: "size", header: "Size", numeric: true, hideOnPhone: true, cell: (recovery) => formatBytes(recovery.sizeBytes) },
              { id: "made", header: "Made", hideOnPhone: true, cell: (recovery) => when(recovery.createdAt) },
              { id: "state", header: "State", cell: () => <StatusChip status="neutral">stopped recovery</StatusChip> },
            ]}
            rows={recoveries}
            rowKey={(recovery) => recovery.id}
          />
        </Panel>
      )}

      {recoveryFor && (
        <Sheet kicker="Recovery clone" title={`Recover ${recoveryFor.domainName}`} side="center" size="sm" onClose={() => setRecoveryFor(null)} className="vms-sheet"
          footer={<>
            <Button variant="ghost" onClick={() => setRecoveryFor(null)}>Cancel</Button>
            <Button type="submit" form="vms-recovery-form" variant="primary" risk={riskOf("vm.recovery.create")} disabled={!isVmName(recoveryName)}>Continue to confirm</Button>
          </>}>
          <form id="vms-recovery-form" className="vms-form" onSubmit={(event) => { event.preventDefault(); recover(); }}>
            <Field label="New VM name" hint="The name must be free. The new VM does not replace the source.">
              <TextInput mono value={recoveryName} onValueChange={setRecoveryName} pattern={vmNamePattern} maxLength={63} required autoComplete="off" />
            </Field>
          </form>
          <Notice tone="info" title="Starts safe">Stopped, persistent, autostart off, and no network interface. Starting it later is a separate approved action.</Notice>
        </Sheet>
      )}
    </>
  );
}
