import { useCallback, useEffect, useRef, useState } from "react";
import { openView } from "../../activityEvents";
import { useOperation } from "../../shell/ApproveDialog";
import { countOf } from "../../data";
import { formatBytes } from "../../formatBytes";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, CodeBlock, EmptyState, Notice, Panel, Sheet, StatusChip, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { ComposeAllowance, ComposeRefusal } from "./ComposeReview";
import { alsoOnWords, restoreOptions, type RestoreOption } from "./restoreRows";
import { when, type DescribedSnapshot, type DiscoveredSnapshots, type RestoreReview, type SnapshotSources } from "./types";

/*
 * Restore (M33.9): every machine snapshot this server can restore from, this server's own, the
 * backup drive's, and any found on a drive or share that is simply mounted, which is how a rebuilt
 * server finds the old one's. Restoring one is a sheet: the apps in it, which have data to bring
 * back, and what is staged for review instead of applied. What a restore staged follows.
 *
 * An app whose data archive would start its compose file exactly as it was backed up, giving the app
 * more than the catalog does, is listed with those settings and must be allowed, app by app, before
 * the restore is offered (sweep 4); one that cannot be restored at all says why, and is left out.
 */

export interface RestoreTabProps {
  csrfToken: string;
  role: string;
  /** What earlier restores staged for review; null when it could not be read. */
  restores: RestoreReview[] | null;
  onChanged: () => void;
  /** Turns the page to its Apps' data tab, in place. */
  onOpenApps: () => void;
}

/** Where an app's data archive was found: this server, the backup drive, or beside a snapshot found on another drive. */
const dataPlace = (location: string | null) => (location === "mirror" ? "on backup drive" : location === "drive" ? "on the snapshot's drive" : "local");

/** When an app data archive was taken, from its name (`20260815T030000Z.tar.gz`), as this browser writes a date. */
function archiveDate(name: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  if (!match) return name;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isNaN(date.getTime()) ? name : date.toLocaleDateString();
}

/**
 * An app as a description lists it. `dataNewer`: the archive a restore would use was taken after the
 * snapshot (M91, the default: each app's newest data); `snapshotArchive`: the one the snapshot's own
 * listing gives; `dataSkipped`: each newer archive passed over, and why (one an earlier release wrote
 * that may be a restore's copy of the app installed empty, a backup of the app installed without its
 * data, one whose record names another app).
 */
type DescribedApp = DescribedSnapshot["apps"][number] & { dataNewer?: boolean; snapshotArchive?: string | null; dataSkipped?: string[] };

/**
 * The archive a restore would use, and, beneath it, the newer ones it passes over (M91 review): an
 * app whose newest archive was not used read the same as one with nothing newer at all.
 */
function DataArchive({ app }: { app: DescribedApp }) {
  const skipped = Array.isArray(app.dataSkipped) ? app.dataSkipped.filter((reason) => typeof reason === "string") : [];
  if (!skipped.length) return <DataArchiveChoice app={app} />;
  return (
    <span className="backups-cell">
      <DataArchiveChoice app={app} />
      <StatusChip status="warning" title={skipped.join(" ")}>{skipped.length === 1 ? "1 newer backup not used" : `${skipped.length} newer backups not used`}</StatusChip>
      <span className="backups-dim">{skipped.join(" ")}</span>
    </span>
  );
}

/**
 * Which data a restore would bring back for one app (R5B4-4): its newest archive, taken after the
 * snapshot (M91), or the archive the snapshot names, or, when that one is gone, an older one it lists,
 * which the restore uses and says so; the sheet said "newest" and showed the same green chip either way.
 */
function DataArchiveChoice({ app }: { app: DescribedApp }) {
  if (app.dataNewer && app.dataArchive) {
    return (
      <span className="backups-cell">
        <StatusChip status="good" title={`${app.dataArchive}, taken after the snapshot${app.snapshotArchive ? `; the snapshot names ${app.snapshotArchive}` : ""}.`}>newer, {archiveDate(app.dataArchive)} · {dataPlace(app.dataLocation)}</StatusChip>
        <span className="backups-dim">Taken after the snapshot{app.snapshotArchive ? `, which names one of ${archiveDate(app.snapshotArchive)}` : ""}.</span>
      </span>
    );
  }
  if (!app.newestBackup) return <span className="backups-dim">none</span>;
  if (!app.dataAvailable) return <StatusChip status="warning">not reachable</StatusChip>;
  if (app.dataArchive && app.dataArchive !== app.newestBackup) {
    return (
      <span className="backups-cell">
        <StatusChip status="warning" title={`${app.newestBackup}, the archive this snapshot names, is gone; the restore would use ${app.dataArchive}, an older one it lists.`}>older copy, {archiveDate(app.dataArchive)} · {dataPlace(app.dataLocation)}</StatusChip>
        <span className="backups-dim">The archive this snapshot names is gone; the restore would use this older one.</span>
      </span>
    );
  }
  return <StatusChip status="good">{dataPlace(app.dataLocation)}</StatusChip>;
}

type Option = RestoreOption;

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
    guidance: "A verified copy of the previous server's BoxPilot database, with its accounts, schedules, settings, and history. Restoring it replaces this server's own records: Backups, This server, Restore the database copy puts it back.",
  },
};

const formatStaged = (name: string): string => {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return name;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toLocaleString();
};

export default function RestoreTab({ csrfToken, role, restores, onChanged, onOpenApps }: RestoreTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); onChanged(); });
  const canRead = role === "owner" || role === "operator";
  const canRestore = mayStart(role, "host.snapshot.restore");
  const [sources, setSources] = useState<SnapshotSources | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredSnapshots | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A scan of the mounted drives that failed is said (M49): it used to look like "no snapshots" on the rebuilt server that needed one most.
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // Apps by their names (M49): the sheet listed ids ("pi-hole") in code font where a person chooses
  // what to bring back. The catalog's summary names them; its id where the catalog has gone.
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let gone = false;
    fetch("/api/v1/catalog?view=summary")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { applications?: Array<{ manifest: { id: string; name: string } }> } | null) => {
        if (!gone && Array.isArray(data?.applications)) setNames(Object.fromEntries(data.applications.map((entry) => [entry.manifest.id, entry.manifest.name])));
      })
      .catch(() => { /* the ids stay */ });
    return () => { gone = true; };
  }, []);
  const nameOf = (id: string) => names[id] ?? id;
  const [chosen, setChosen] = useState<Option | null>(null);
  const [described, setDescribed] = useState<DescribedSnapshot | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoreData, setRestoreData] = useState(true);
  // Each app's newest data (the default, M91), or only what the snapshot names.
  const [newestData, setNewestData] = useState(true);
  // Apps whose data archive's compose file the owner allowed to start as it was backed up.
  const [allowed, setAllowed] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!canRead) return;
    setReading(true);
    try {
      const { result } = await inspectOperation<SnapshotSources>("host.snapshot.sources");
      setSources({ sources: (Array.isArray(result?.sources) ? result.sources : []).map((entry) => ({ ...entry, snapshots: Array.isArray(entry.snapshots) ? entry.snapshots : [] })), mount: result?.mount ?? { mounted: false, blocker: null } });
      setError(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "The snapshots could not be listed"); }
    // Scanning mounted drives is slower and less important than listing our own, so it does not hold
    // up the list, and a drive that will not answer must not empty the page.
    try {
      const { result } = await inspectOperation<DiscoveredSnapshots>("host.snapshot.discover");
      setDiscovered({ locations: (Array.isArray(result?.locations) ? result.locations : []).map((location) => ({ ...location, snapshots: Array.isArray(location.snapshots) ? location.snapshots : [] })), unanswered: Array.isArray(result?.unanswered) ? result.unanswered : [] });
      setDiscoverError(null);
    } catch (requestError) { setDiscovered({ locations: [] }); setDiscoverError(requestError instanceof Error ? requestError.message : "The drives could not be scanned"); }
    setReading(false);
  }, [canRead]);
  useEffect(() => { void refresh(); }, [refresh]);

  // One row per snapshot, however many places hold it (M91).
  const options: Option[] = restoreOptions(sources, discovered);

  // Which opening of the sheet an answer belongs to: a slow answer for a snapshot opened earlier
  // filled the sheet of the one opened since, and its restore staged that artifact with these apps.
  const opening = useRef(0);
  const open = async (option: Option, newest = true) => {
    const ticket = ++opening.current;
    const again = chosen?.key === option.key;
    setChosen(option); setDescribed(null); setDescribeError(null); setNewestData(newest); setAllowed(new Set());
    if (!again) { setSelected(new Set()); setRestoreData(true); }
    try {
      // The server's default is each app's newest data; only the other choice is sent.
      const parameters = { source: option.source, artifact: option.snapshot.artifact, ...(option.root ? { root: option.root } : {}), ...(newest ? {} : { dataFrom: "snapshot" }) };
      const response = await fetch("/api/v1/operations/host.snapshot.describe/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
      const body = (await response.json()) as { result?: DescribedSnapshot; error?: string };
      if (ticket !== opening.current) return;
      if (!response.ok || !body.result) throw new Error(body.error ?? "The snapshot could not be read");
      setDescribed(body.result);
      if (!again) setSelected(new Set(body.result.apps.filter((app) => app.installed).map((app) => app.id)));
    } catch (requestError) {
      if (ticket !== opening.current) return;
      setDescribeError(requestError instanceof Error ? requestError.message : "The snapshot could not be read");
    }
  };
  // What restoring each chosen app's data would start: those to allow, and those that cannot be restored.
  const reviewed = restoreData ? (described?.apps ?? []).filter((app) => selected.has(app.id) && app.compose && !app.compose.error) : [];
  const refusedApps = reviewed.filter((app) => app.compose!.refusals.length > 0);
  const toAllow = reviewed.filter((app) => app.compose!.refusals.length === 0 && app.compose!.needsAllow && app.compose!.sha256);
  const unresolved = refusedApps.length > 0 || toAllow.some((app) => !allowed.has(app.id));
  const restore = () => {
    if (!chosen || selected.size === 0 || unresolved) return;
    const option = chosen;
    const apps = [...selected];
    const allowCompose = Object.fromEntries(toAllow.map((app) => [app.id, app.compose!.sha256!]));
    setChosen(null);
    start({
      operationId: "host.snapshot.restore",
      title: `Restore ${countOf(apps.length, "app")} from snapshot`,
      parameters: { source: option.source, artifact: option.snapshot.artifact, ...(option.root ? { root: option.root } : {}), apps, restoreData, ...(restoreData && !newestData ? { dataFrom: "snapshot" } : {}), ...(toAllow.length ? { allowCompose } : {}) },
      preview: <>
        <span>Reinstalls {apps.map(nameOf).join(", ")} from {option.snapshot.createdAt ? `the snapshot of ${when(option.snapshot.createdAt)}` : <code>{option.snapshot.artifact}</code>}{option.root ? <> on <code>{option.where}</code></> : null}{!restoreData ? " without touching data" : newestData ? " and restores each one's newest data backup that checks out, on this server, the backup drive or beside the snapshot, even one taken after the snapshot, or else the one the snapshot names (a safety copy of any existing data is taken first)" : " and restores each one's data from the archive the snapshot names, or an older one it lists where that one is gone (a safety copy of any existing data is taken first)"}. Apps already installed on this box are skipped.</span>
        {toAllow.map((app) => <ComposeAllowance key={app.id} name={nameOf(app.id)} review={app.compose!} />)}
      </>,
      // The sheet closes for the approval, and comes back with the same apps ticked unless the job completed.
      onClosed: (job) => { if (job?.state !== "completed") setChosen(option); },
    });
  };

  const columns: Array<TableColumn<Option>> = [
    { id: "where", header: "Where", sortValue: (option) => option.where, cell: (option) => <span className="backups-cell backups-wrap"><span>{option.source === "discovered" ? <code>{option.where}</code> : option.where}</span>{alsoOnWords(option) && <span className="backups-dim">{alsoOnWords(option)}</span>}</span> },
    { id: "taken", header: "Taken", sortValue: (option) => option.snapshot.createdAt ?? "", cell: (option) => (option.snapshot.createdAt ? when(option.snapshot.createdAt) : <code className="backups-wrap">{option.snapshot.artifact}</code>) },
    { id: "size", header: "Size", numeric: true, cell: (option) => formatBytes(option.snapshot.sizeBytes || null) },
    { id: "apps", header: "Apps", numeric: true, cell: (option) => option.snapshot.apps ?? "—" },
    // How many come back with data, where the choice is made (M91): a snapshot holds settings, not data.
    { id: "data", header: "With their data", numeric: true, hideOnPhone: true, cell: (option) => option.snapshot.withData ?? "—" },
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
        meta={canRead ? <>apps come back with their settings and secrets, then their data as the snapshot found it</> : undefined}
        actions={canRead ? <Button variant="ghost" busy={reading} onClick={() => void refresh()}>Check again</Button> : undefined}
        footer={<span className="backups-foot backups-foot--row">
          <span className="backups-foot__text">One app, or one file from it: open the app's Backups.</span>
          <span className="backups-links"><Button variant="ghost" className="backups-inline" onClick={onOpenApps}>Apps' data</Button></span>
        </span>}
      >
        {!canRead ? (
          <EmptyState title="Restoring needs an operator or the owner">A snapshot lists every app's settings and secrets, so reading one is kept to those who can restore it.</EmptyState>
        ) : (
          <>
            {error && <Notice tone="danger" live className="backups-inset" title="The snapshots could not be listed" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
            {discoverError && <Notice tone="warning" live className="backups-inset" title="The mounted drives could not be scanned for snapshots" action={<Button onClick={() => void refresh()}>Try again</Button>}>{discoverError}. A snapshot on a drive or a network share is not listed until the scan works.</Notice>}
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
                : <EmptyState title="No machine snapshots to restore from" action={<Button onClick={() => openView("storage")}>Open Storage</Button>}>{sources?.mount && !sources.mount.mounted && sources.mount.blocker ? sources.mount.blocker : "If you have one on a drive or a network share, mount it there and it is listed here: a rebuilt server finds it that way."}</EmptyState>}
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
          className="backups-sheet"
          kicker={chosen.where}
          title={chosen.snapshot.createdAt ? `Snapshot of ${when(chosen.snapshot.createdAt)}` : chosen.snapshot.artifact}
          size="lg"
          onClose={() => setChosen(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setChosen(null)}>{canRestore ? "Cancel" : "Close"}</Button>
            {canRestore && <Button variant="primary" risk={riskOf("host.snapshot.restore")} disabled={!described || selected.size === 0 || unresolved} title={unresolved ? "Allow each app's settings below, or leave it out" : undefined} onClick={restore}>Restore {selected.size ? countOf(selected.size, "app") : "selected"}</Button>}
          </>}
        >
          {describeError && <Notice tone="danger" live title="The snapshot could not be read">{describeError}</Notice>}
          {!described && !describeError && <p className="backups-dim">Reading the snapshot…</p>}
          {described && (
            <>
              <Table
                caption={chosen.snapshot.createdAt ? `Apps in the snapshot of ${when(chosen.snapshot.createdAt)}` : `Apps in ${chosen.snapshot.artifact}`}
                columns={[
                  { id: "pick", header: <span className="ui-visually-hidden">Restore</span>, label: "Restore", className: "backups-pick", cell: (app) => <Checkbox label={<span className="ui-visually-hidden">Restore {nameOf(app.id)}</span>} checked={selected.has(app.id)} disabled={!canRestore} onChange={(on) => setSelected((current) => { const next = new Set(current); if (on) next.add(app.id); else next.delete(app.id); return next; })} /> },
                  { id: "app", header: "App", sortValue: (app) => nameOf(app.id), cell: (app) => nameOf(app.id) },
                  { id: "installed", header: "In snapshot", cell: (app) => (app.installed ? "installed" : "not installed") },
                  { id: "data", header: "Data archive", cell: (app) => <DataArchive app={app} /> },
                ]}
                rows={described.apps}
                rowKey={(app) => app.id}
                empty={<EmptyState title="This snapshot has no apps">There is nothing in it to pick. Close this and choose another snapshot from the list.</EmptyState>}
              />
              <Checkbox label="Restore each app's data after installing it" description="A safety copy of any data already there is taken first." checked={restoreData} disabled={!canRestore} onChange={setRestoreData} />
              {restoreData && <Checkbox label="Use each app's newest backup" description={newestData ? "The latest backup of each app on this server, the backup drive or beside the snapshot, even one taken after the snapshot, once it matches its checksum and its record shows it is the app's data; otherwise the archive the snapshot names. Untick to use only the archive the snapshot names." : "Only the archive the snapshot names, or an older one it lists where that one is gone."} checked={newestData} disabled={!canRestore} onChange={(on) => { if (chosen) void open(chosen, on); }} />}
              {refusedApps.map((app) => <ComposeRefusal key={app.id} title={`${nameOf(app.id)} cannot be restored from this snapshot's data; leave it out`} review={app.compose!} />)}
              {toAllow.map((app) => (
                <ComposeAllowance key={app.id} name={nameOf(app.id)} review={app.compose!}>
                  <Checkbox label={`Start ${nameOf(app.id)} with these settings`} checked={allowed.has(app.id)} disabled={!canRestore} onChange={(on) => setAllowed((current) => { const next = new Set(current); if (on) next.add(app.id); else next.delete(app.id); return next; })} />
                </ComposeAllowance>
              ))}
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
