import { Button, CodeBlock, KeyValue, Notice, Panel, Progress, mayStart, riskOf, type Status } from "../../ui";
import type { ReleaseUpdate, UpdateStatus } from "./systemTypes";

/** What the upgrade script said last, from the update log: why it stopped, and the database copy it took (M36). */
export function updateLogFacts(log: string[]): { error: string | null; databaseCopy: string | null } {
  const marked = log.filter((line) => line.includes("[boxpilot-upgrade]"));
  const failed = marked.filter((line) => line.includes("ERROR: ")).at(-1);
  const error = failed ? failed.slice(failed.indexOf("ERROR: ") + "ERROR: ".length).trim() : null;
  const copies = marked.map((line) => /database copy: (\S+\.sqlite3)/.exec(line)?.[1]).filter((path): path is string => Boolean(path));
  return { error, databaseCopy: copies.at(-1) ?? null };
}

/** Where the release check stands, as a chip: never green about a check that did not answer. */
export function releaseState(release: ReleaseUpdate | null, releaseError: string | null): { status: Status; label: string } {
  if (releaseError || release?.error) return { status: "unknown", label: "Not checked" };
  if (!release) return { status: "unknown", label: "Checking…" };
  if (release.updateAvailable && release.latest) return { status: "warning", label: `${release.latest.tag} available` };
  return release.latest ? { status: "good", label: "Up to date" } : { status: "neutral", label: "No releases yet" };
}

const day = (iso: string | null | undefined) => { const time = Date.parse(iso ?? ""); return Number.isFinite(time) ? new Date(time).toLocaleDateString() : null; };
const moment = (iso: string | null | undefined) => { const time = Date.parse(iso ?? ""); return Number.isFinite(time) ? new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; };

/**
 * BoxPilot's own update (M33.12): the version running, the newest release on GitHub, the update
 * itself (high risk, the tag typed out), its progress until the new version answers, the database
 * copy it took first, and its log.
 */
export function SystemUpdates({ release, releaseError, checking, onCheck, status, updating, outcome, role, onUpdate }: {
  release: ReleaseUpdate | null;
  releaseError: string | null;
  checking: boolean;
  onCheck: () => void;
  status: UpdateStatus | null;
  updating: string | null;
  outcome: "live" | "timeout" | "failed" | null;
  role: string;
  onUpdate: (target: NonNullable<ReleaseUpdate["latest"]>) => void;
}) {
  const facts = updateLogFacts(status?.log ?? []);
  const state = releaseState(release, releaseError);
  const latest = release?.latest ?? null;
  const problem = releaseError ?? release?.error ?? null;
  const offer = release?.updateAvailable && latest && !updating && mayStart(role, "system.update");

  return (
    <>
      <Panel padded title="BoxPilot" count={state}
        actions={<>
          <Button variant="ghost" busy={checking} onClick={onCheck}>Check again</Button>
          {offer && <Button variant="primary" risk={riskOf("system.update")} onClick={() => onUpdate(latest)}>Update to {latest.tag}</Button>}
        </>}>
        <KeyValue items={[
          { id: "running", label: "Running", value: release?.current.version ?? __BOXPILOT_VERSION__, mono: true },
          { id: "latest", label: "Latest release", mono: true, value: latest ? <>{latest.tag}{day(latest.publishedAt) ? ` · ${day(latest.publishedAt)}` : ""} <a className="system-link" href={latest.url} target="_blank" rel="noreferrer">Release notes</a></> : problem ? "—" : checking ? "Checking GitHub…" : "No releases published yet" },
          { id: "checked", label: "Checked", value: release ? moment(release.checkedAt) : "—", mono: true },
        ]} />
        {problem && <Notice tone="warning" title="The release check did not answer">{problem}</Notice>}
        {offer && <p className="system-asks">Updating asks for your password, then the tag <code>{latest.tag}</code> typed out.</p>}
        <p className="system-note">The update downloads the commit the release points at, copies the database, builds, swaps it in and restarts BoxPilot. It rolls back by itself if the new version fails its health check, and does not start without room for the database copy.</p>
      </Panel>

      {!updating && status?.outcome === "failed" && (
        <Notice tone="danger" title="The last update stopped">
          {facts.error ?? "The update log below says why."}{/nothing was changed/i.test(facts.error ?? "") ? "" : " A failed health check restores the previous version automatically."}
        </Notice>
      )}

      {!updating && outcome === "timeout" && (
        <Notice tone="warning" title="The update is taking longer than ten minutes">
          Check the update log below; a failed health check restores the previous version automatically.
        </Notice>
      )}

      {updating && (
        // A stopped or timed-out update is no longer "updating" (the notices above say how it ended).
        <Notice live tone={outcome === "live" ? "success" : "info"} title={outcome === "live" ? `BoxPilot ${updating} is live` : `Updating to ${updating}…`}>
          {outcome === "live" ? "Reloading." : "It copies the database first, then builds; BoxPilot restarts when the build finishes. This page reconnects by itself."}
          {!outcome && <Progress label={`Updating to ${updating}`} hideLabel className="system-progress" />}
        </Notice>
      )}

      {facts.databaseCopy && !updating && (
        <Panel padded title="Database copy from the last update">
          <KeyValue items={[{ id: "copy", label: "Copied to", value: facts.databaseCopy, mono: true, hint: "It matches the version it replaced. Housekeeping lists every copy." }]} />
        </Panel>
      )}

      {status && status.log.length > 0 && (
        <CodeBlock label={`Last update log${status.outcome ? `, ${status.outcome}` : ""}`} meta={`${status.log.length} lines`} maxHeight="24rem" follow>
          {status.log.join("\n")}
        </CodeBlock>
      )}
    </>
  );
}
