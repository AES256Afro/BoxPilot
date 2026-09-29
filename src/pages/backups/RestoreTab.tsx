import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { countOf } from "../../data";
import { formatBytes } from "../../formatBytes";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, CodeBlock, EmptyState, Notice, Panel, Sheet, StatusChip, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { when, type DescribedSnapshot, type DiscoveredSnapshots, type RestoreReview, type SnapshotEntry, type SnapshotSources } from "./types";

/*
 * Restore (M33.9): every machine snapshot this server can restore from, this server's own, the
 * backup drive's, and any found on a drive or share that is simply mounted, which is how a rebuilt
 * server finds the old one's. Restoring one is a sheet: the apps in it, which have data to bring
 * back, and what is staged for review instead of applied. What a restore staged follows.
 */

export interface RestoreTabProps {
  csrfToken: string;
  role: string;
  /** What earlier restores staged for review; null when it could not be read. */
  restores: RestoreReview[] | null;
  onChanged: () => void;
}

interface Option { key: string; source: "local" | "mirror" | "discovered"; root: string | null; where: string; snapshot: SnapshotEntry }

/** What each staged area is, and what to do with it: a file alone is a puzzle. */
const areaGuidance: Record<string, { label: string; guidance: string }> = {
  system: {
    label: "System configuration",
    guidance: "The old machine's network addresses, firewall rules, and mount table. None of it is applied automatically: a wrong network write takes this box offline. Set addresses by hand if this box takes over the old ones, apply a firewall profile from the Firewall page, and mount drives from the Storage page.",
  },
  vms: {
    label: "Virtual machine definitions",
    guidance: "Each VM's definition, not its disks. Disks come from the encrypted VM repository on the Virtual Machines page; the definition tells you what the machine was.",
  },
  controller: {
    label: "The old BoxPilot database",
    guidance: "A verified copy of the previous server's BoxPilot database, with its accounts, schedules, settings, and history. Restoring it replaces this server's own records; the controller recovery runbook covers when that is the right call.",
  },
};

const formatStaged = (name: string): string => {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return name;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toLocaleString();
};

export default function RestoreTab({ csrfToken, role, restores, onChanged }: RestoreTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); onChanged(); });
  const canRead = role === "owner" || role === "operator";
  const canRestore = mayStart(role, "host.snapshot.restore");
  const [sources, setSources] = useState<SnapshotSources | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredSnapshots | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [chosen, setChosen] = useState<Option | null>(null);
  const [described, setDescribed] = useState<DescribedSnapshot | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoreData, setRestoreData] = useState(true);

  const refresh = useCallback(async () => {
    if (!canRead) return;
    setReading(true);
    try {
      setSources((await inspectOperation<SnapshotSources>("host.snapshot.sources")).result);
      setError(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The snapshots could not be listed"); }
    // Scanning mounted drives is slower and less important than listing our own, so it does not hold
    // up the list, and a drive that will not answer must not empty the page.
    try { setDiscovered((await inspectOperation<DiscoveredSnapshots>("host.snapshot.discover")).result); } catch { setDiscovered({ locations: [] }); }
    setReading(false);
  }, [canRead]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Keyed by position, not "source:artifact": a discovered root is a path, and splitting one on a
  // colon waits for the first drive mounted somewhere odd.
  const options: Option[] = [
    ...(sources?.sources ?? []).flatMap((entry) => entry.snapshots.map((snapshot) => ({ source: entry.source, root: null, where: entry.source === "mirror" ? "Backup drive" : "This server", snapshot }))),
    ...(discovered?.locations ?? []).flatMap((location) => location.snapshots.map((snapshot) => ({ source: "discovered" as const, root: location.root, where: `${location.mount.source} (${location.mount.filesystem})`, snapshot }))),
  ].map((option, index) => ({ ...option, key: String(index) }));

  const open = async (option: Option) => {
    setChosen(option); setDescribed(null); setDescribeError(null); setSelected(new Set()); setRestoreData(true);
    try {
      const parameters = { source: option.source, artifact: option.snapshot.artifact, ...(option.root ? { root: option.root } : {}) };
      const response = await fetch("/api/v1/operations/host.snapshot.describe/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
      const body = (await response.json()) as { result?: DescribedSnapshot; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "The snapshot could not be read");
      setDescribed(body.result);
      setSelected(new Set(body.result.apps.filter((app) => app.installed).map((app) => app.id)));
    } catch (requestError) {
      setDescribeError(requestError instanceof Error ? requestError.message : "The snapshot could not be read");
    }
  };
  const restore = () => {
    if (!chosen || selected.size === 0) return;
    const option = chosen;
    const apps = [...selected];
    setChosen(null);
    start({
      operationId: "host.snapshot.restore",
      title: `Restore ${countOf(apps.length, "app")} from snapshot`,
      parameters: { source: option.source, artifact: option.snapshot.artifact, ...(option.root ? { root: option.root } : {}), apps, restoreData },
      preview: <span>Reinstalls {apps.join(", ")} from <code>{option.snapshot.artifact}</code>{option.root ? <> on <code>{option.where}</code></> : null}{restoreData ? " and restores each one's newest data archive (a safety copy of any existing data is taken first)" : " without touching data"}. Apps already installed on this box are skipped.</span>,
    });
  };

  const columns: Array<TableColumn<Option>> = [
    { id: "where", header: "Where", sortValue: (option) => option.where, cell: (option) => <span className="backups-wrap">{option.source === "discovered" ? <code>{option.where}</code> : option.where}</span> },
    { id: "taken", header: "Taken", sortValue: (option) => option.snapshot.createdAt ?? "", cell: (option) => (option.snapshot.createdAt ? when(option.snapshot.createdAt) : <code className="backups-wrap">{option.snapshot.artifact}</code>) },
    { id: "size", header: "Size", numeric: true, cell: (option) => formatBytes(option.snapshot.sizeBytes || null) },
    { id: "apps", header: "Apps", numeric: true, cell: (option) => option.snapshot.apps ?? "—" },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "backups-actions-cell", cell: (option) => (
        <span className="backups-actions">
          {canRestore
            ? <Button risk={riskOf("host.snapshot.restore")} aria-label={`Restore from the snapshot of ${option.snapshot.createdAt ? when(option.snapshot.createdAt) : option.snapshot.artifact}, ${option.where}`} onClick={() => void open(option)}>Restore…</Button>
            : <Button variant="ghost" onClick={() => void open(option)}>Look inside</Button>}
        </span>
      ),
    },
  ];

  const foundElsewhere = (discovered?.locations ?? []).reduce((total, location) => total + location.snapshots.length, 0);

  return (
    <>
      {dialog}
      <Panel
        title="Restore from a machine snapshot"
        count={canRead && sources ? options.length : undefined}
        meta={canRead ? <>apps come back with their settings and secrets, then their newest data</> : undefined}
        actions={canRead ? <Button variant="ghost" busy={reading} onClick={() => void refresh()}>Read again</Button> : undefined}
      >
        {!canRead ? (
          <EmptyState title="Restoring needs an operator or the owner">A snapshot lists every app's settings and secrets, so reading one is kept to those who can restore it.</EmptyState>
        ) : (
          <>
            {error && <Notice tone="danger" live className="backups-inset" title="The snapshots could not be listed" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
            {foundElsewhere > 0 && <Notice tone="info" className="backups-inset" title={`Also found ${countOf(foundElsewhere, "snapshot")} this server did not write`}>On {(discovered?.locations ?? []).map((location) => location.mount.source).join(", ")}: a rebuilt server finds the old one's this way.</Notice>}
            {(discovered?.unanswered ?? []).map((drive) => (
              <Notice key={drive.target} tone="warning" className="backups-inset" title={`${drive.source} did not answer when read`}>
                It is mounted at <code>{drive.target}</code> but reading it failed ({drive.error}). That is usually a network hiccup rather than an empty drive: read again to try it.
              </Notice>
            ))}
            <Table
              caption="Machine snapshots to restore from"
              columns={columns}
              rows={options}
              rowKey={(option) => option.key}
              defaultSort={{ column: "taken", direction: "descending" }}
              empty={!sources && !error
                ? "Reading the snapshots…"
                : <EmptyState title="No machine snapshots to restore from">{sources?.mount && !sources.mount.mounted && sources.mount.blocker ? sources.mount.blocker : "If you have one on a drive or a network share, mount it on the Storage page and read again: a rebuilt server finds it that way."}</EmptyState>}
            />
          </>
        )}
      </Panel>

      {restores && restores.length > 0 && (
        <Panel title="Left for you to review" count={restores.length} meta="staged, never applied: an old machine's network settings can take this one offline">
          {restores.map((review) => {
            const areas = [...new Set(review.files.map((file) => file.area))].filter((area) => area in areaGuidance);
            return (
              <section key={review.name} className="backups-review" aria-label={`Restored ${formatStaged(review.name)}`}>
                <div className="backups-review__head">
                  <strong>Restored {formatStaged(review.name)}</strong>
                  <span className="backups-dim">{countOf(review.files.length, "file")}</span>
                  {mayStart(role, "host.snapshot.restores.discard") && (
                    <Button risk={riskOf("host.snapshot.restores.discard")} aria-label={`Discard what the restore of ${formatStaged(review.name)} staged`} onClick={() => start({
                      operationId: "host.snapshot.restores.discard",
                      title: "Discard these review files",
                      parameters: { name: review.name },
                      preview: <span>Removes the staged review copies from this restore ({countOf(review.files.length, "file")}). The restored apps and their data are untouched.</span>,
                    })}>Discard</Button>
                  )}
                </div>
                {areas.map((area) => (
                  <div key={area} className="backups-review__area">
                    <h3 className="backups-review__label">{areaGuidance[area].label}</h3>
                    <p className="backups-review__guidance">{areaGuidance[area].guidance}</p>
                    {review.files.filter((file) => file.area === area).map((file) => (
                      <details key={file.path} className="backups-disclose">
                        <summary><code>{file.path}</code> <span className="backups-dim">{formatBytes(file.sizeBytes)}</span></summary>
                        {file.content !== null
                          ? <CodeBlock label={file.path} maxHeight="24rem">{file.content}</CodeBlock>
                          : <p className="backups-dim">Not shown here ({formatBytes(file.sizeBytes)}, not plain text). It is on this server at <code>{review.stagedAt}/{file.path}</code>.</p>}
                      </details>
                    ))}
                  </div>
                ))}
              </section>
            );
          })}
        </Panel>
      )}

      {chosen && (
        <Sheet
          kicker={chosen.where}
          title={chosen.snapshot.createdAt ? `Snapshot of ${when(chosen.snapshot.createdAt)}` : chosen.snapshot.artifact}
          size="lg"
          onClose={() => setChosen(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setChosen(null)}>{canRestore ? "Cancel" : "Close"}</Button>
            {canRestore && <Button variant="primary" risk={riskOf("host.snapshot.restore")} disabled={!described || selected.size === 0} onClick={restore}>Restore {selected.size ? countOf(selected.size, "app") : "selected"}</Button>}
          </>}
        >
          {describeError && <Notice tone="danger" live title="The snapshot could not be read">{describeError}</Notice>}
          {!described && !describeError && <p className="backups-dim">Reading the snapshot…</p>}
          {described && (
            <>
              <Table
                caption={`Apps in ${chosen.snapshot.artifact}`}
                columns={[
                  { id: "pick", header: <span className="ui-visually-hidden">Restore</span>, label: "Restore", className: "backups-pick", cell: (app) => <Checkbox label={<span className="ui-visually-hidden">Restore {app.id}</span>} checked={selected.has(app.id)} disabled={!canRestore} onChange={(on) => setSelected((current) => { const next = new Set(current); if (on) next.add(app.id); else next.delete(app.id); return next; })} /> },
                  { id: "app", header: "App", sortValue: (app) => app.id, cell: (app) => <code>{app.id}</code> },
                  { id: "installed", header: "In snapshot", cell: (app) => (app.installed ? "installed" : "not installed") },
                  { id: "data", header: "Data archive", cell: (app) => (app.newestBackup ? (app.dataAvailable ? <StatusChip status="good">{app.dataLocation === "mirror" ? "on backup drive" : "local"}</StatusChip> : <StatusChip status="warning">not reachable</StatusChip>) : <span className="backups-dim">none</span>) },
                ]}
                rows={described.apps}
                rowKey={(app) => app.id}
                empty={<EmptyState title="This snapshot has no apps" />}
              />
              <Checkbox label="Restore each app's newest data archive after installing it" description="A safety copy of any data already there is taken first." checked={restoreData} disabled={!canRestore} onChange={setRestoreData} />
              <p className="backups-note">Network, firewall, fstab, VM definitions{described.vms?.domains?.length ? ` (${described.vms.domains.join(", ")})` : ""}, and the database copy are staged under the snapshot folder for you to review. They are never applied automatically.</p>
              {described.vms?.domains?.length ? (
                <Notice tone={described.vms.diskRepositoryReachable ? "info" : "warning"} title={described.vms.diskRepositoryReachable ? "The VM disk repository is reachable" : "The VM disk repository is not reachable"}>
                  A snapshot holds VM definitions, not their disks; those come from the encrypted VM repository.{described.vms.diskRepositoryReachable ? "" : " Mount the backup drive before restoring a VM."}
                </Notice>
              ) : null}
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
