import { useCallback, useEffect, useRef, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { readJson } from "../../http";
import { inspectOperation } from "../../operations";
import SchedulesPanel from "../automations/SchedulesPanel";
import { Button, KeyValue, MetricStrip, MetricTile, Notice, PageHeader, Panel, Tabs, useUrlParam, type Status } from "../../ui";
import { SystemHardware } from "./SystemHardware";
import { SystemHousekeeping } from "./SystemHousekeeping";
import { SystemTime } from "./SystemTime";
import { releaseState, SystemUpdates, updateLogFacts } from "./SystemUpdates";
import { gib, upsLabel, type DockerDisk, type Housekeeping, type ReleaseUpdate, type StartOperation, type SystemSettings, type UpdateStatus, type UpsDetection } from "./systemTypes";
import "./system.css";

/*
 * System (M33.12), rebuilt on the kit in the console's look with every feature the Classic page
 * had. Facts first: the verdict (BoxPilot's own update) and the host's name, clock and memory in
 * the header, then one tab per job: an overview of figures that each open their tab, BoxPilot's
 * update, housekeeping (reclaimable space, Docker's disk, the database copies updates take), the
 * name, time zone and language, the hardware (memory and swap, trim, the UPS), and the schedules.
 */

const tabIds = ["overview", "updates", "housekeeping", "time", "hardware", "schedules"] as const;
type TabId = (typeof tabIds)[number];

export interface SystemPageProps {
  csrfToken: string;
  /** Who is signed in: a viewer reads the settings and changes nothing; housekeeping is an operator's. */
  role?: string;
}

export default function SystemPage({ csrfToken, role = "owner" }: SystemPageProps) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dockerDisk, setDockerDisk] = useState<DockerDisk | null>(null);
  const [housekeeping, setHousekeeping] = useState<Housekeeping | null>(null);
  const [scanning, setScanning] = useState(false);
  const [release, setRelease] = useState<ReleaseUpdate | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateOutcome, setUpdateOutcome] = useState<"live" | "timeout" | "failed" | null>(null);
  const [ups, setUps] = useState<UpsDetection | null>(null);
  const [upsError, setUpsError] = useState<string | null>(null);
  const [tab, setTab] = useUrlParam<TabId>("tab", tabIds, "overview");
  const updateTarget = useRef<string | null>(null);
  const operator = role === "owner" || role === "operator";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ result }, docker] = await Promise.all([
        inspectOperation<SystemSettings>("system.settings.inspect"),
        inspectOperation<DockerDisk>("docker.disk.inspect").catch(() => null),
      ]);
      // A proxy or an older server can answer 200 with something else; say so rather than crash.
      if (!result?.hostname || !result.memory || !result.fstrim) throw new Error("System settings arrived in a shape this page cannot read");
      setSettings({ ...result, timezones: Array.isArray(result.timezones) ? result.timezones : [], swap: Array.isArray(result.swap) ? result.swap : [] });
      setDockerDisk(docker?.result && Array.isArray(docker.result.rows) ? docker.result : null);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read system settings");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const loadRelease = useCallback(async (again = false) => {
    setCheckingRelease(true);
    try {
      const body = await readJson<ReleaseUpdate>(await fetch(`/api/v1/system/update${again ? "?refresh=1" : ""}`));
      if (typeof body?.current?.version !== "string") throw new Error("The release check answered in a shape this page cannot read");
      setRelease(body);
      setReleaseError(null);
    } catch (requestError) {
      setReleaseError(requestError instanceof Error ? requestError.message : "The release check is unavailable");
    } finally {
      setCheckingRelease(false);
    }
    // The update's own log is an operator's to read (ADR-003).
    if (operator) inspectOperation<UpdateStatus>("system.update.status").then(({ result }) => setUpdateStatus(result && Array.isArray(result.log) ? result : null)).catch(() => setUpdateStatus(null));
  }, [operator]);
  useEffect(() => { void loadRelease(); }, [loadRelease]);

  /** What can be reclaimed, asked for once when the page opens and again on demand. */
  const scan = useCallback(async () => {
    if (!operator) return;
    setScanning(true);
    try {
      const { result } = await inspectOperation<Housekeeping>("housekeeping.inspect");
      setHousekeeping(result && Array.isArray(result.categories) ? result : null);
    }
    catch { setHousekeeping(null); }
    finally { setScanning(false); }
  }, [operator]);
  useEffect(() => { void scan(); }, [scan]);

  const lookForUps = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/power/ups/detect");
      const body = (await response.json().catch(() => ({}))) as UpsDetection & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not look for a UPS");
      setUps({ devices: Array.isArray(body.devices) ? body.devices : [], nutInstalled: Boolean(body.nutInstalled) });
      setUpsError(null);
    } catch (requestError) {
      setUpsError(requestError instanceof Error ? requestError.message : "Could not look for a UPS");
    }
  }, []);
  useEffect(() => { void lookForUps(); }, [lookForUps]);

  // After the update job starts the detached build, poll health until the new version answers.
  useEffect(() => {
    if (!updating) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => {
      fetch("/api/v1/health").then((response) => (response.ok ? response.json() : null)).then((health: { version?: string } | null) => {
        if (health?.version === updating) { setUpdateOutcome("live"); window.clearInterval(timer); window.setTimeout(() => window.location.reload(), 1500); }
      }).catch(() => {});
      if (Date.now() - started > 10 * 60 * 1000) { setUpdateOutcome("timeout"); window.clearInterval(timer); }
    }, 3000);
    // The update can stop before it restarts anything (a database copy that could not be made, a
    // build that failed) and health goes on answering the old version. Its own log says so at once.
    const watch = window.setInterval(() => {
      inspectOperation<UpdateStatus>("system.update.status").then(({ result }) => {
        if (result && Array.isArray(result.log)) setUpdateStatus(result);
        if (result?.outcome === "failed") { setUpdateOutcome("failed"); window.clearInterval(timer); window.clearInterval(watch); }
      }).catch(() => {});
    }, 6000);
    return () => { window.clearInterval(timer); window.clearInterval(watch); };
  }, [updating]);

  const { start, dialog } = useOperation(csrfToken, (job) => {
    if (job.type === "op:system.update" && job.state === "completed" && updateTarget.current) setUpdating(updateTarget.current);
    // A finished cleanup invalidates its own figures: leaving them up says gigabytes are still
    // waiting when they have just gone.
    if (job.type === "op:housekeeping.reclaim" && job.state === "completed") void scan();
    if (job.type === "op:ups.setup" || job.type === "op:apt.install") void lookForUps();
    void refresh();
  });
  const begin: StartOperation = start;

  const update = (target: NonNullable<ReleaseUpdate["latest"]>) => {
    updateTarget.current = target.version;
    start({
      operationId: "system.update",
      title: `Update BoxPilot to ${target.tag}`,
      parameters: { tag: target.tag },
      confirmText: target.tag,
      preview: <span>Downloads the commit <code>{target.tag}</code> points at from GitHub and builds it. Then it copies the database, so this version can be put back with the data it wrote, and stops there if the copy cannot be made; otherwise it swaps the new version in. BoxPilot restarts for about a minute; running jobs are interrupted, so let them finish first. If the new version does not answer its health check, the previous version is restored automatically.</span>,
    });
  };

  const lastUpdate = updateLogFacts(updateStatus?.log ?? []);
  const lastFailed = !updating && updateStatus?.outcome === "failed";
  const releaseChip = releaseState(release, releaseError);
  const memory = settings?.memory;
  const usedPercent = memory?.memTotalKiB && memory.memAvailableKiB !== null ? Math.round(((memory.memTotalKiB - memory.memAvailableKiB) / memory.memTotalKiB) * 100) : null;
  const swapUsed = memory?.swapTotalKiB ? (memory.swapTotalKiB ?? 0) - (memory.swapFreeKiB ?? 0) : null;
  const trimOn = settings?.fstrim.enabled === "enabled";
  const upsDevice = ups?.devices[0] ?? null;

  const verdict: { status: Status; label: string } = !settings ? (error ? { status: "unknown", label: "Not read" } : { status: "unknown", label: "Reading…" })
    : updating ? { status: "neutral", label: `Updating to ${updating}` }
      : lastFailed ? { status: "danger", label: "Last update failed" }
        : releaseChip.status === "warning" ? { status: "warning", label: "Update available" }
          : releaseChip.status === "good" ? { status: "good", label: "Up to date" }
            : { status: "neutral", label: releaseChip.label };

  return (
    <div className="system-page">
      {dialog}
      <PageHeader
        title="System"
        status={verdict}
        meta={settings ? <><b>{settings.hostname.live ?? "—"}</b> · {settings.timezone ?? "time zone unknown"} · <b>{gib(memory?.memAvailableKiB)}</b> free of {gib(memory?.memTotalKiB)} · BoxPilot <b>{release?.current.version ?? __BOXPILOT_VERSION__}</b></> : undefined}
        actions={<Button variant="ghost" busy={loading && Boolean(settings)} onClick={() => { void refresh(); void loadRelease(); void scan(); void lookForUps(); }}>Read again</Button>}
        about={<>
          <p>This server's own settings: BoxPilot's update, what can be cleaned up, the name, time zone and language, memory and swap, SSD trim and a UPS, and what runs on a schedule.</p>
          <p>Every change is a job with its tier: renaming, the time zone, swap and cleanup ask you to confirm; updating BoxPilot asks for your password and the release's tag typed out.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="System settings could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      <Tabs<TabId>
        label="System"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "updates", label: "Updates", status: lastFailed ? "danger" : releaseChip.status === "warning" ? "warning" : undefined, statusLabel: lastFailed ? "the last update failed" : releaseChip.status === "warning" ? "an update is available" : undefined },
          { id: "housekeeping", label: "Housekeeping", count: housekeeping && housekeeping.totalBytes > 0 ? housekeeping.totalHumanBytes : undefined },
          { id: "time", label: "Time & name" },
          { id: "hardware", label: "Hardware" },
          { id: "schedules", label: "Schedules" },
        ]}
      >
        {(current) => current === "overview" ? (
          <>
            <MetricStrip label="The server at a glance" className="system-strip">
              <MetricTile label="BoxPilot" value={release?.current.version ?? __BOXPILOT_VERSION__} caption={lastFailed ? "the last update failed" : releaseChip.label} status={lastFailed ? "danger" : releaseChip.status === "good" ? "good" : releaseChip.status === "warning" ? "warning" : "unknown"} onSelect={() => setTab("updates")} />
              <MetricTile label="Memory" value={gib(memory?.memAvailableKiB)} caption={`available of ${gib(memory?.memTotalKiB)}`} status={usedPercent === null ? "unknown" : usedPercent >= 95 ? "danger" : usedPercent >= 85 ? "warning" : "good"} bar={usedPercent === null ? undefined : { value: usedPercent, label: "Memory in use" }} onSelect={() => setTab("hardware")} />
              <MetricTile label="Swap" value={gib(memory?.swapTotalKiB)} caption={memory?.swapTotalKiB ? `${gib(swapUsed)} in use · swappiness ${settings?.swappiness ?? "—"}` : settings ? "no swap configured" : "Reading…"} status={settings ? (memory?.swapTotalKiB ? "neutral" : "warning") : "unknown"} onSelect={() => setTab("hardware")} />
              <MetricTile label="Reclaimable" value={housekeeping ? housekeeping.totalHumanBytes : "—"} caption={!operator ? "an operator's to scan" : housekeeping ? "in items nothing needs" : scanning ? "Scanning…" : "Not scanned"} status={housekeeping ? "neutral" : "unknown"} onSelect={() => setTab("housekeeping")} />
              <MetricTile label="Name" value={settings?.hostname.live ?? "—"} caption={settings ? (settings.hostname.static !== settings.hostname.live ? `static: ${settings.hostname.static}` : "static and live match") : "Reading…"} status={settings ? "neutral" : "unknown"} onSelect={() => setTab("time")} />
              <MetricTile label="Time zone" value={settings?.timezone ?? "—"} caption={settings?.locale ? `language ${settings.locale}` : `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} in your browser`} status={settings ? "neutral" : "unknown"} onSelect={() => setTab("time")} />
            </MetricStrip>
            <Panel padded title="Also on this server">
              <KeyValue layout="columns" items={[
                { id: "trim", label: "SSD trim", status: settings ? (trimOn ? "good" : "neutral") : "unknown", value: settings ? (trimOn ? "weekly" : "off") : "—", hint: trimOn && settings?.fstrim.nextRun ? `next ${settings.fstrim.nextRun}` : undefined },
                { id: "ups", label: "UPS", status: ups ? (upsDevice ? "good" : "neutral") : "unknown", value: upsDevice ? upsLabel(upsDevice) : ups ? "none on USB" : upsError ? "not read" : "—", hint: upsDevice ? (ups?.nutInstalled ? "NUT installed" : "NUT not installed") : undefined },
                { id: "docker-logs", label: "Docker logs", status: dockerDisk?.logging ? (dockerDisk.logging.configured ? "good" : "warning") : undefined, value: !dockerDisk ? "not read" : !dockerDisk.available ? "Docker not answering" : dockerDisk.logging?.configured ? `capped at ${dockerDisk.logging.maxSize}` : "unlimited" },
                { id: "copy", label: "Last database copy", value: lastUpdate.databaseCopy ? lastUpdate.databaseCopy.split("/").at(-1) : "none recorded", mono: Boolean(lastUpdate.databaseCopy) },
              ]} />
            </Panel>
          </>
        ) : current === "updates" ? (
          <SystemUpdates release={release} releaseError={releaseError} checking={checkingRelease} onCheck={() => void loadRelease(true)} status={updateStatus} updating={updating} outcome={updateOutcome} role={role} onUpdate={update} />
        ) : current === "housekeeping" ? (
          <SystemHousekeeping csrfToken={csrfToken} role={role} housekeeping={housekeeping} scanning={scanning} onRescan={() => void scan()} dockerDisk={dockerDisk} start={begin} />
        ) : current === "time" ? (
          <SystemTime settings={settings} loading={loading} role={role} start={begin} />
        ) : current === "hardware" ? (
          <SystemHardware settings={settings} loading={loading} role={role} start={begin} ups={ups} upsError={upsError} onLookAgain={() => void lookForUps()} />
        ) : (
          <SchedulesPanel csrfToken={csrfToken} role={role} serverTimezone={settings?.timezone ?? null} />
        )}
      </Tabs>
    </div>
  );
}
