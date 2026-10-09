/**
 * Auto-reconnect (M26.5): a drive that drops is mounted again without waiting for a person - when,
 * and only when, somebody armed it.
 *
 * Arming a drive is creating a flow (ADR-002 addendum): one step, storage.remount for that drive,
 * written down by the person who clicked, run under their stored authority with a scheduled run's
 * refusals, visible on Automations and beside the drive, revoked by disarming or pausing it. The
 * trigger is BoxPilot's own health round finding /mnt/<name> dead or read-only, and it chooses only
 * when: nothing about the finding reaches the step. The step is M26.1's reconnect, which already
 * restarts every container bound to the drive and proves the mount with a real read.
 *
 * What this module adds is what a clock never needed, because an event can recur:
 * - a cooldown between automatic reconnects of one drive, and a cap on them per day;
 * - after one that failed, or that a restart cut off, no more until the drive has been reconnected
 *   by hand: a reconnect that did not work will not work better at 3am on a loop;
 * - never while the drive is being checked, or reconnected or unmounted by somebody else;
 * - never after the drive's last check found errors, since writing to it again is a person's call.
 * Each outcome is told once through the health-alert ledger: a reconnect as news, anything that
 * needs a person as the automation's own condition, which the next successful reconnect clears.
 */
import { asSentence } from "./health-alerts.mjs";
import { mountNamePattern } from "./tasks/storage.mjs";
import { mountNameFor, mountpointFor } from "./backup-mount.mjs";

export const autoReconnectLimits = Object.freeze({ cooldownMs: 30 * 60_000, maxAttempts: 3, windowMs: 24 * 60 * 60_000 });
const settingKey = "driveReconnects";
const conditions = Object.freeze({ "storage.mount.detached": "lost its drive", "storage.mount.readonly": "went read-only" });
// Anything else working on the drive right now. The reconnect waits for it rather than racing it.
const driveJobs = Object.freeze(["op:storage.check", "op:storage.dirty-mark.clear", "op:storage.remount", "op:storage.unmount", "op:storage.writable"]);

const reconnectable = (name) => typeof name === "string" && mountNamePattern.test(name) && !name.startsWith("share-") && name !== "swap";

/** The managed drives a health round found dead or read-only: name -> { key, what }. Pure. */
export function lostDrives(activeKeys = []) {
  const lost = new Map();
  for (const key of activeKeys) {
    const at = String(key).indexOf(":");
    if (at < 0) continue;
    const what = conditions[key.slice(0, at)];
    const drive = mountNameFor(key.slice(at + 1));
    if (!what || !reconnectable(drive) || lost.has(drive)) continue;
    lost.set(drive, { key, what });
  }
  return lost;
}

/** Automatic reconnects of one drive still inside the window, oldest first. Pure. */
export function attemptsIn(record, now, limits = autoReconnectLimits) {
  return (record?.attempts ?? []).filter((attempt) => now - Date.parse(attempt.at) < limits.windowMs);
}

/**
 * Why an armed drive is not reconnected now, or null when it is. Pure: the record, the last check
 * and the running jobs are handed in, and `now` is a number. `tell` is whether the owner hears of
 * it: a cooldown or a check in progress passes by itself, a hold was told when it began, and a cap
 * or a check that found errors waits for a person, who is told once.
 */
export function reconnectRefusal({ name, now, record = {}, lastCheck = null, activeJobs = [], limits = autoReconnectLimits }) {
  const busy = activeJobs.find((job) => driveJobs.includes(job?.type) && job.parameters?.name === name);
  if (busy) return { reason: busy.type === "op:storage.check" ? `${mountpointFor(name)} is being checked` : `${mountpointFor(name)} is already being worked on`, tell: false };
  if (lastCheck?.clean === false) {
    return { reason: `its last check found errors${lastCheck.checkedAt ? ` (${new Date(lastCheck.checkedAt).toLocaleString()})` : ""}, and writing to it again is for a person to decide`, advice: "Open Repair to check the drive, repair it if it needs it, and reconnect it there.", tell: true };
  }
  if (record.heldSince) return { reason: record.heldBecause ?? "the last automatic reconnect did not work", tell: false };
  const recent = attemptsIn(record, now, limits);
  if (recent.length >= limits.maxAttempts) {
    return { reason: `it has been reconnected automatically ${recent.length} times in the last ${Math.round(limits.windowMs / 3_600_000)} hours, which is the limit`, advice: "Reconnect it from Repair when you are ready. A drive that keeps dropping loses whatever was being written each time: the cable, port or enclosure is the thing to change.", tell: true };
  }
  const last = recent.at(-1);
  if (last && now - Date.parse(last.at) < limits.cooldownMs) return { reason: `the last automatic reconnect was under ${Math.round(limits.cooldownMs / 60_000)} minutes ago`, tell: false };
  return null;
}

/** "plex, sonarr and radarr": container names as the owner knows the apps. */
function listed(containers) {
  const names = containers.map((name) => String(name).replace(/^bp-/, ""));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The news of a reconnect that worked, from the reconnect step's own result: what it said it
 * mounted, and which apps it restarted. Exported for the tests; the words are the product here.
 */
export function reconnectedNotice({ name, what, result = null, flowName = null, attempt = 1, limits = autoReconnectLimits }) {
  const mountpoint = mountpointFor(name);
  const allowance = ` Automatic reconnect ${attempt} of ${limits.maxAttempts} allowed in a day.`;
  if (!result) return { title: `${mountpoint} ${what}; ${flowName ?? "its automation"} ran`, message: `${flowName ?? "The automation armed for it"} ran and finished.${allowance}`, priority: "default" };
  const restarted = result.restarted ?? [];
  const failed = result.restartFailed ?? [];
  const title = failed.length
    ? `Reconnected ${mountpoint}; ${plural(failed.length, "app")} did not restart`
    : `Reconnected ${mountpoint}${restarted.length ? ` and restarted ${plural(restarted.length, "app")}` : ""}`;
  const message = [
    `It ${what}. It is mounted again${result.source ? ` from ${result.source}` : ""} and reads.`,
    restarted.length ? `${listed(restarted)} ${restarted.length === 1 ? "was" : "were"} restarted so ${restarted.length === 1 ? "it sees" : "they see"} it.` : "",
    failed.length ? `Could not restart ${listed(failed)}; restart ${failed.length === 1 ? "it" : "them"} from the App catalog.` : "",
  ].filter(Boolean).join(" ") + allowance;
  return { title, message, priority: failed.length ? "high" : "default" };
}

export function createAutoReconnect({ store, flows, alerts = null, now = () => new Date(), limits = autoReconnectLimits }) {
  const inFlight = new Set(); // drives being reconnected by this process right now
  const readAll = () => ({ ...(store.getSetting(settingKey, {}) ?? {}) });
  /** Change one drive's record; `null` forgets it. Attempts past the window are dropped as it goes. */
  function write(name, change) {
    const all = readAll();
    const next = change(all[name] ?? {});
    if (next === null) delete all[name];
    else all[name] = { ...next, attempts: attemptsIn(next, now().getTime(), limits) };
    store.setSetting(settingKey, all, { updatedBy: null });
    return all[name] ?? null;
  }
  const armedFlows = () => store.listFlows().filter((flow) => flow.triggerDrive);
  const alertKey = (flow) => `flow.failed:${flow.id}`;
  // The ledger may wait on a notification target; the reconnect's outcome never waits on it.
  const quietly = (call) => { try { return Promise.resolve(call()).catch(() => {}); } catch { return Promise.resolve(); } };
  // Every reconnect runs, or is refused, under the flow's creator (flows.runForDrive): the words are theirs.
  const raise = (flow, title, message) => quietly(() => alerts?.raise({ key: alertKey(flow), title, message: message.slice(0, 500), priority: "high", actorId: flow.createdBy ?? null }));

  /** One armed drive the round found in trouble: refuse with a reason, or reconnect it. */
  async function consider(name, loss, flow) {
    const at = now();
    const record = readAll()[name] ?? {};
    const lastCheck = (store.getSetting("driveChecks", {}) ?? {})[name] ?? null;
    const refusal = reconnectRefusal({ name, now: at.getTime(), record, lastCheck, activeJobs: store.listActiveJobs?.() ?? [], limits });
    if (refusal) {
      if (refusal.tell) {
        flows.recordSkip(flow.id, refusal.reason);
        await raise(flow, `Did not reconnect ${mountpointFor(name)}`, `It ${loss.what}, and was not reconnected automatically: ${asSentence(refusal.reason)} ${refusal.advice ?? ""}`.trim());
      }
      return { name, outcome: "waiting", reason: refusal.reason, told: Boolean(refusal.tell) };
    }

    // Counted before it runs, so a restart mid-reconnect still counts, and still holds (recover).
    inFlight.add(name);
    const attempt = { at: at.toISOString(), outcome: "running" };
    write(name, (entry) => ({ ...entry, attempts: [...(entry.attempts ?? []), attempt] }));
    let ran;
    try {
      ran = await flows.runForDrive(flow.id);
    } catch (error) {
      ran = { outcome: "failed", jobs: [], error: error.message };
    } finally {
      inFlight.delete(name);
    }
    // Audited when it ran: a refusal is already on the flow's record, once per reason.
    if (["completed", "failed"].includes(ran.outcome)) store.recordAudit("drive.reconnect.triggered", { actorId: flow.createdBy, subjectId: flow.id, details: { drive: name, condition: loss.key, outcome: ran.outcome } });
    const settle = (outcome, hold = null) => write(name, (entry) => ({
      ...entry,
      attempts: outcome === null ? (entry.attempts ?? []).filter((item) => item.at !== attempt.at) : (entry.attempts ?? []).map((item) => (item.at === attempt.at ? { ...item, outcome } : item)),
      ...(hold ? { heldSince: at.toISOString(), heldBecause: hold } : {}),
    }));

    // Nothing ran, so nothing counts: its automation was already running, or its consent no longer holds.
    if (ran.outcome === "busy") { settle(null); return { name, outcome: "waiting", reason: "its automation is already running", told: false }; }
    if (ran.outcome === "refused") {
      settle(null);
      await raise(flow, `Did not reconnect ${mountpointFor(name)}`, `It ${loss.what}, and was not reconnected automatically: ${asSentence(ran.error)} Reconnect it from Repair.`);
      return { name, outcome: "refused", reason: ran.error, told: true };
    }
    if (ran.outcome === "failed") {
      settle("failed", "the last automatic reconnect did not work");
      await raise(flow, `Could not reconnect ${mountpointFor(name)}`, `It ${loss.what}, and reconnecting it automatically failed: ${asSentence(ran.error ?? "the job failed")} BoxPilot will not try again on its own until it has been reconnected by hand, from Repair.`);
      return { name, outcome: "failed", reason: ran.error, told: true };
    }

    settle("reconnected");
    const step = (ran.jobs ?? []).find((job) => job?.type === "op:storage.remount" && job.parameters?.name === name) ?? null;
    const count = attemptsIn(readAll()[name], at.getTime(), limits).length;
    const notice = reconnectedNotice({ name, what: loss.what, result: step?.result ?? null, flowName: flow.name, attempt: count, limits });
    // The reconnect is the resolution: a later "resolved" push for the drop would say it twice.
    if (step) for (const family of Object.keys(conditions)) await quietly(() => alerts?.clear(`${family}:${mountpointFor(name)}`, { quietly: true }));
    await quietly(() => alerts?.tell({ key: `drive.reconnected:${name}`, ...notice }));
    return { name, outcome: "reconnected", notice };
  }

  /**
   * What one health round found. Off by default: a drive nobody armed has no flow, and is skipped.
   * A paused flow is a revoked trigger. Drives are taken one at a time, so two on one enclosure do
   * not remount at once.
   */
  async function onRound({ active = [] } = {}) {
    const armed = new Map(armedFlows().filter((flow) => flow.enabled !== false).map((flow) => [flow.triggerDrive, flow]));
    const outcomes = [];
    for (const [name, loss] of lostDrives(active)) {
      const flow = armed.get(name);
      if (!flow || inFlight.has(name)) continue;
      outcomes.push(await consider(name, loss, flow));
    }
    return outcomes;
  }

  /**
   * A reconnect that worked, by anyone: the drive is itself again. It lifts a hold, and when it was
   * done by hand it answers the automation's standing failure too - the same work, succeeding.
   */
  function onJob(job) {
    if (job?.state !== "completed" || job.type !== "op:storage.remount") return;
    const name = job.parameters?.name;
    if (!reconnectable(name)) return;
    if (readAll()[name]?.heldSince) write(name, (entry) => ({ ...entry, heldSince: null, heldBecause: null }));
    const flow = armedFlows().find((entry) => entry.triggerDrive === name);
    if (flow && !flows.owns?.(job.id)) void quietly(() => alerts?.clear(alertKey(flow)));
  }

  /**
   * A reconnect a BoxPilot restart cut off. Its automation's record is rewritten and announced by
   * flows.recover(); here the attempt keeps counting, and the drive waits for a person, because
   * nobody knows how far the remount got.
   */
  function recover() {
    let held = 0;
    for (const [name, record] of Object.entries(readAll())) {
      if (!(record?.attempts ?? []).some((attempt) => attempt.outcome === "running")) continue;
      write(name, (entry) => ({
        ...entry,
        attempts: (entry.attempts ?? []).map((attempt) => (attempt.outcome === "running" ? { ...attempt, outcome: "interrupted" } : attempt)),
        heldSince: entry.heldSince ?? now().toISOString(),
        heldBecause: "BoxPilot restarted while it was reconnecting the drive",
      }));
      held += 1;
    }
    return held;
  }

  /** Arm a drive: its flow, created as the person asking. A fresh arming starts with a clean slate. */
  async function arm(name, actorId, { role = "owner" } = {}) {
    if (["viewer", "disabled"].includes(role)) throw Object.assign(new Error("Viewers cannot arm automations"), { code: "forbidden" });
    if (!reconnectable(name)) throw new Error("Only a drive BoxPilot mounts under /mnt can be reconnected automatically");
    const flow = await flows.create({ name: `Reconnect ${mountpointFor(name)} when it drops`, steps: [{ operationId: "storage.remount", parameters: { name } }], triggerDrive: name, createdBy: actorId });
    write(name, () => null);
    return flow;
  }

  /** Disarm a drive: its flow goes, and with it the trigger (flows.remove settles its condition quietly). */
  function disarm(name, actorId, { role = "owner" } = {}) {
    const flow = armedFlows().find((entry) => entry.triggerDrive === name);
    if (!flow) throw Object.assign(new Error(`${mountpointFor(name)} is not reconnected automatically`), { code: "not_found" });
    flows.remove(flow.id, actorId, { role });
    write(name, () => null);
    return { removed: true, flowId: flow.id };
  }

  /** What is armed, and what is waiting for a person, for the drive rows and the Repair notices. */
  function status() {
    const records = readAll();
    const checks = store.getSetting("driveChecks", {}) ?? {};
    const at = now().getTime();
    const drives = {};
    for (const flow of armedFlows()) {
      const record = records[flow.triggerDrive] ?? {};
      const recent = attemptsIn(record, at, limits);
      drives[flow.triggerDrive] = {
        flowId: flow.id, flowName: flow.name, enabled: flow.enabled !== false,
        held: Boolean(record.heldSince), heldSince: record.heldSince ?? null, heldBecause: record.heldBecause ?? null,
        attempts: recent.length, lastAttemptAt: recent.at(-1)?.at ?? null, lastOutcome: recent.at(-1)?.outcome ?? null,
        lastCheckFoundErrors: checks[flow.triggerDrive]?.clean === false,
      };
    }
    return { limits: { cooldownMinutes: Math.round(limits.cooldownMs / 60_000), maxAttempts: limits.maxAttempts, windowHours: Math.round(limits.windowMs / 3_600_000) }, drives };
  }

  function start() {
    recover();
    const stopRounds = alerts?.afterRound?.(onRound) ?? (() => {});
    const stopJobs = typeof store.subscribeJobs === "function" ? store.subscribeJobs(onJob) : () => {};
    return () => { stopRounds(); stopJobs(); };
  }

  return { onRound, onJob, recover, arm, disarm, status, start };
}
