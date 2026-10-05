import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../../formatBytes";
import { Button, EmptyState, Notice, Panel, SearchField, StatusChip, mayStart, riskOf } from "../../ui";
import { ComposeAllowance, ComposeRefusal, type ComposeReview } from "../backups/ComposeReview";
import { offlineFor, runRead } from "./appState";
import type { CatalogContext, Entry } from "./types";

/*
 * An app's backups (M33.11): the restore rehearsal's verdict and its recent record first, whether
 * something rehearses them on a schedule, then each archive with what it cost (how long the app was
 * offline) and what can be done with it: restore it whole, restore one file, rehearse it, or
 * delete it. Each of those goes through the approval dialog at its tier.
 *
 * A whole restore asks first what the backup would start (sweep 4): a compose file edited by hand,
 * or one whose settings no longer fit, starts exactly as it was backed up, and one that gives the app
 * more than the catalog does is listed in the dialog and staged allowing exactly that file, which
 * the server types out as a confirmation. One the server cannot restore at all says why instead.
 */

interface Backup { artifact: string; createdAt: string | null; sizeBytes: number | null; downtimeMs: number | null; skippedHostPaths: string[]; skippedVolumes?: string[]; image: string | null }
type BackupFile = { path: string; sizeBytes: number; type: string };
interface FileListing { files?: BackupFile[]; truncated?: boolean; matched?: number }
/** A backup's files as the server listed them: `filter` is what it filtered by ("" for none), `matched` how many there were. */
interface Browsing { backup: string; files: BackupFile[]; truncated: boolean; matched: number | null; filter: string }

/** How the server is asked to filter a backup's files: lower case, as long as it takes one. */
const serverFilter = (text: string) => text.trim().toLowerCase().slice(0, 200);

/**
 * Whether the server must filter a backup's files again (R5B3-6): what is here holds only the first
 * few thousand of a long listing, so a filter searched only those. Not when the list here is whole
 * and the filter only narrows what it was listed for.
 */
function needsServer(text: string, browsing: Browsing): boolean {
  const wanted = serverFilter(text);
  if (wanted === browsing.filter) return false;
  return browsing.truncated || !wanted.includes(browsing.filter);
}

export function BackupsTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest, live } = entry;
  const { csrfToken, act, role, rehearsal, scheduling, scheduleError, schedules } = ctx;
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<Browsing | null>(null);
  const [filter, setFilter] = useState("");
  // The backup whose restore is being looked over, and one that cannot be restored, with why.
  const [checking, setChecking] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ backup: string; review: ComposeReview } | null>(null);
  const may = (operationId: string) => mayStart(role, operationId);
  const verification = live?.backupVerification ?? null;
  const name = manifest.name;

  const read = useCallback(async () => {
    setError(null);
    try {
      const { response, body } = await runRead<{ backups?: Backup[] }>(csrfToken, "app.backups.inspect", { id: manifest.id });
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not list backups");
      // Normalised here rather than guarded at each read: a partial answer no longer costs the list.
      setBackups((body.result.backups ?? []).map((backup) => ({ ...backup, skippedVolumes: backup.skippedVolumes ?? [], skippedHostPaths: backup.skippedHostPaths ?? [] })));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not list backups");
    }
  }, [csrfToken, manifest.id]);
  useEffect(() => { void read(); }, [read]);

  // Which listing an answer belongs to: a slow one for an earlier filter must not replace a newer one.
  const listingAsked = useRef(0);
  const browse = async (backup: string) => {
    setError(null);
    const ticket = ++listingAsked.current;
    try {
      const { response, body } = await runRead<FileListing>(csrfToken, "app.backup.files", { id: manifest.id, backup });
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the backup");
      if (ticket !== listingAsked.current) return;
      setFilter("");
      setBrowsing({ backup, files: body.result.files ?? [], truncated: Boolean(body.result.truncated), matched: typeof body.result.matched === "number" ? body.result.matched : null, filter: "" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the backup");
    }
  };
  // A listing too long to send whole is filtered by the server, a moment after the typing stops.
  useEffect(() => {
    if (!browsing || !needsServer(filter, browsing)) return undefined;
    const wanted = serverFilter(filter);
    const { backup } = browsing;
    const timer = window.setTimeout(() => {
      const ticket = ++listingAsked.current;
      void (async () => {
        try {
          const { response, body } = await runRead<FileListing>(csrfToken, "app.backup.files", { id: manifest.id, backup, ...(wanted ? { filter: wanted } : {}) });
          if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the backup");
          if (ticket !== listingAsked.current) return;
          const result = body.result;
          setBrowsing((current) => (current && current.backup === backup ? { backup, files: result.files ?? [], truncated: Boolean(result.truncated), matched: typeof result.matched === "number" ? result.matched : null, filter: wanted } : current));
        } catch (requestError) {
          if (ticket === listingAsked.current) setError(requestError instanceof Error ? requestError.message : "Could not read the backup");
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [browsing, filter, csrfToken, manifest.id]);

  const when = (backup: Backup) => (backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.artifact);

  const restore = async (backup: Backup) => {
    setError(null); setRefused(null); setChecking(backup.artifact);
    // A review that cannot be read is not a reason not to try: the restore itself checks the files it
    // unpacks, and says what it refused and why.
    let review: ComposeReview | null = null;
    try {
      const { response, body } = await runRead<ComposeReview>(csrfToken, "app.backup.review", { id: manifest.id, backup: backup.artifact });
      if (response.ok && body.result) review = body.result;
    } catch { review = null; }
    setChecking(null);
    if (review && review.refusals.length) { setRefused({ backup: when(backup), review }); return; }
    const allow = review?.needsAllow && review.sha256 ? review.sha256 : null;
    act({
      operationId: "app.backup.restore",
      title: `Restore ${name} from ${when(backup)}`,
      parameters: { id: manifest.id, backup: backup.artifact, ...(allow ? { allowCompose: allow } : {}) },
      preview: <>
        <span>Saves the current state as a safety copy first, then replaces {name}'s data and configuration with this backup and starts it.</span>
        {allow && review ? <ComposeAllowance name={name} review={review} /> : null}
      </>,
    });
  };
  // Newest first; one without a date (an older record) goes last.
  const archives = useMemo(() => [...(backups ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")), [backups]);

  const shownFiles = useMemo(() => (browsing?.files ?? []).filter((file) => file.type !== "directory" && (!filter || file.path.toLowerCase().includes(filter.toLowerCase()))).slice(0, 200), [browsing, filter]);
  const skippedVolumes = [...new Set((backups ?? []).flatMap((backup) => backup.skippedVolumes ?? []))];
  const skippedHostPaths = [...new Set((backups ?? []).flatMap((backup) => backup.skippedHostPaths))];
  const schedule = rehearsal[manifest.id];
  const history = verification?.history ?? [];

  return (
    <div className="catalog-tab">
      {verification && (
        <Notice tone={verification.verified ? "success" : "danger"} title={verification.verified ? "Last rehearsal passed" : "Last rehearsal failed"}>
          {verification.verified
            ? <><code>{verification.backup}</code> unpacked cleanly on {new Date(verification.checkedAt).toLocaleString()}.</>
            : <>On {new Date(verification.checkedAt).toLocaleString()}: {verification.reason}</>}
        </Notice>
      )}
      {/* A run of results, so an intermittent failure is visible rather than overwritten. */}
      {history.length > 1 && (
        <p className="catalog-ticks">
          <span className="catalog-ticks__label">Recent rehearsals</span>
          {history.map((result) => (
            <span key={result.checkedAt} className="catalog-tick ui-marked" data-status={result.verified ? "good" : "danger"} title={`${new Date(result.checkedAt).toLocaleString()}: ${result.verified ? "passed" : result.reason ?? "failed"}`}>
              <span className="ui-mark" aria-hidden="true" /><span className="ui-visually-hidden">{`${new Date(result.checkedAt).toLocaleString()}: ${result.verified ? "passed" : "failed"}. `}</span>
            </span>
          ))}
        </p>
      )}
      {(backups?.length ?? 0) > 0 && (
        <div className="catalog-inline catalog-rehearsal">
          {schedule
            ? <><StatusChip status="good">rehearsed automatically</StatusChip><span className="catalog-row__dim">{schedule.cadence}</span>{role !== "viewer" && <Button variant="ghost" disabled={scheduling} onClick={() => void schedules.stopRehearsal(schedule.id)}>Stop</Button>}</>
            : <><StatusChip status="neutral">not rehearsed on a schedule</StatusChip><span className="catalog-row__dim">Nothing checks these on their own.</span>{role !== "viewer" && <Button disabled={scheduling} onClick={() => void schedules.rehearse(manifest.id)}>Rehearse weekly</Button>}</>}
        </div>
      )}
      {scheduleError && <Notice tone="danger" live title="The rehearsal schedule was not changed">{scheduleError}</Notice>}
      {error && <Notice tone="danger" live title="The backups could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>}
      {refused && <ComposeRefusal title={`${name} cannot be restored from ${refused.backup}`} review={refused.review} />}

      {browsing && (
        <Panel level={3} title={`Files in ${browsing.backup}`} count={browsing.files.filter((file) => file.type !== "directory").length} className="catalog-files" actions={<Button variant="ghost" onClick={() => setBrowsing(null)}>Close the file list</Button>}>
          <div className="catalog-files__search"><SearchField label="Filter files" value={filter} onValueChange={setFilter} /></div>
          <ul className="catalog-rows">
            {shownFiles.map((file) => (
              <li key={file.path} className="catalog-row">
                <span className="catalog-row__main"><code>{file.path}</code><span className="catalog-row__dim">{formatBytes(file.sizeBytes)}</span></span>
                {may("app.backup.restore-path") && (
                  <Button risk={riskOf("app.backup.restore-path")} aria-label={`Restore ${file.path}`} onClick={() => act({ operationId: "app.backup.restore-path", title: `Restore ${file.path} into ${name}`, parameters: { id: manifest.id, backup: browsing.backup, path: file.path }, preview: <span>Takes a checkpoint of {name}'s current data, stops it briefly, restores only <code>{file.path}</code> from this backup over the current one, and starts it again. Everything else is untouched.</span> })}>Restore this file</Button>
                )}
              </li>
            ))}
            {shownFiles.length === 0 && <li className="catalog-quiet">No file matches.</li>}
          </ul>
          {browsing.truncated && (
            <p className="catalog-quiet">
              {browsing.matched !== null
                ? `${browsing.filter ? `${browsing.matched.toLocaleString()} files and folders match “${browsing.filter}”` : `The backup holds ${browsing.matched.toLocaleString()} files and folders`}; the first ${browsing.files.length.toLocaleString()} are here. The filter searches all of them.`
                : "Only the first part of the listing is here. The filter searches all of it."}
            </p>
          )}
        </Panel>
      )}

      <Panel level={3} title="Archives" count={backups ? backups.length : undefined} className="catalog-archives">
        {backups && backups.length === 0
          ? <EmptyState title="No backups yet" action={live?.installed && may("app.backup") ? <Button risk={riskOf("app.backup")} onClick={() => act({ operationId: "app.backup", title: `Back up ${name}`, parameters: { id: manifest.id }, preview: <span>Stops {name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.</span> })}>Back up now</Button> : undefined}>A backup is a consistent archive of the app's data and configuration.</EmptyState>
          : !backups ? <p className="catalog-quiet">{error ? "The backups could not be read." : "Reading…"}</p>
            : (
              <ul className="catalog-rows" aria-label={`Backups of ${name}`}>
                {archives.map((backup) => (
                  <li key={backup.artifact} className="catalog-row">
                    <span className="catalog-row__main">
                      <span className="catalog-archive__when">{when(backup)}</span>
                      <span className="catalog-archive__facts"><span>{formatBytes(backup.sizeBytes)}</span><span>offline for <span className="catalog-archive__offline">{offlineFor(backup.downtimeMs)}</span></span></span>
                    </span>
                    <span className="catalog-actions catalog-actions--wrap">
                      {may("app.backup.restore") && <Button risk={riskOf("app.backup.restore")} aria-label={`Restore ${when(backup)}`} busy={checking === backup.artifact} disabled={checking !== null} onClick={() => void restore(backup)}>Restore</Button>}
                      <Button variant="ghost" aria-label={`Browse ${when(backup)}`} onClick={() => void browse(backup.artifact)}>Browse</Button>
                      {may("app.backup.verify") && <Button risk={riskOf("app.backup.verify")} aria-label={`Rehearse restoring ${when(backup)}`} onClick={() => act({ operationId: "app.backup.verify", title: `Rehearse restoring ${name}`, parameters: { id: manifest.id, backup: backup.artifact }, preview: <span>Checks this archive against its recorded checksum, unpacks all of it into scratch space to prove it opens and holds what it claims, then deletes the scratch copy. {name} keeps running and nothing it holds is changed.</span> })}>Rehearse</Button>}
                      {may("app.backup.delete") && <Button risk={riskOf("app.backup.delete")} aria-label={`Delete ${when(backup)}`} onClick={() => act({ operationId: "app.backup.delete", title: `Delete backup of ${name}`, parameters: { id: manifest.id, backup: backup.artifact }, preview: <span>Deletes the archive from {when(backup)}. This cannot be undone.</span> })}>Delete</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </Panel>
      {skippedVolumes.length > 0 && <p className="catalog-quiet">Not included in these archives: {skippedVolumes.join(", ")}.</p>}
      {skippedHostPaths.length > 0 && <p className="catalog-quiet">Volumes at operator-managed host paths are not included: {skippedHostPaths.join(", ")}</p>}
    </div>
  );
}
