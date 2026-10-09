import { randomBytes } from "node:crypto";
import { exclusiveLane } from "./helper-lanes.mjs";
import { formatDuration } from "./timeouts.mjs";

const systemdRun = "/usr/bin/systemd-run";
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
/** BoxPilot's own units: the only ones restarted here. */
export const ownUnitPattern = /^boxpilot(-helper)?\.service$/;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** What the helper answers a change sent while BoxPilot restarts: it did not start. */
export const restartRefusal = "BoxPilot is restarting to pick up what an update changed, so this did not start and nothing was changed. Run it again once BoxPilot is back, in a minute.";

/**
 * The helper's refusal of a change it never started because it is restarting or stopping, with its
 * own code (sweep 5): the web side's job layer waits for BoxPilot to come back and sends it again
 * once, so an automation's next step is not lost to the restart. Every other failure says
 * operation_failed and is never sent again.
 */
export const restartRefusalError = (message = restartRefusal) => Object.assign(new Error(message), { code: "helper_restarting" });

/**
 * BoxPilot restarting its own services after a job, once the work beside and behind it is done.
 *
 * An upgrade that moved libc or openssl leaves the web service and the helper on the old libraries,
 * and installing KVM leaves the helper unable to write to /var/lib/libvirt until it restarts. Both
 * used to schedule the restart on a blind timer, 30 seconds and 8 seconds out. Work queued behind
 * them started the moment they returned - every app operation waits for an upgrade on the Docker
 * lane - and the timer then killed it mid `compose up`: the helper drains for at most 90 seconds,
 * then its whole group is killed, with no rollback.
 *
 * The restart is now a task on the exclusive lane. It waits, holding nothing, until no lane is held -
 * what ran beside the job, what was queued behind it and what was started meanwhile all finish, and
 * new work keeps flowing while it waits (it used to take the exclusive lane at once and wait there,
 * which froze every change behind the longest job running, for hours) - then takes the exclusive lane
 * at that idle moment, so nothing new starts. From then the helper turns away what would wait for it
 * (`onRestarting`). It waits a moment more for the web side to record the job that asked, then has
 * systemd restart the units from a transient unit of its own (so stopping the helper does not stop
 * the restart), and holds the lane until the restart is done. A web-only restart returns; a helper
 * restart ends this process first. A server never idle for `maxWaitMs` is not restarted: nothing is
 * stopped, and the journal says BoxPilot still needs a restart.
 *
 * Requests made while one is waiting join it: one restart of every unit asked for.
 *
 * What a restart that gave up or failed still owes is kept (`status().unfinished`) until a restart of
 * those units works, and the next restart asked for takes it along (sweep 5): it used to be said only
 * in the journal. The helper's runtime read carries it, and the web side's health check raises
 * "BoxPilot needs a restart" from it, pointing at Services.
 */
export function createDrainedRestart({ lanes, run, sleep = pause, graceMs = 10_000, restartTimeoutMs = 3 * 60_000, maxWaitMs = 6 * 60 * 60_000, setTimer = setTimeout, clearTimer = clearTimeout, onRestarting = () => {}, log = (line) => console.log(line), now = () => new Date() } = {}) {
  let pending = null;
  let restarting = false;
  let unfinished = null;
  let last = Promise.resolve();
  const owe = (outcome, units, reason, error = null) => {
    unfinished = { outcome, units: [...new Set([...(unfinished?.units ?? []), ...units])], reason, at: now().toISOString(), error };
  };
  const paid = (units) => {
    const left = (unfinished?.units ?? []).filter((unit) => !units.includes(unit));
    unfinished = left.length ? { ...unfinished, units: left } : null;
  };
  const where = "Restart it from the Services page.";

  function request(units, { reason = "BoxPilot needs a restart" } = {}) {
    const wanted = [...new Set((Array.isArray(units) ? units : []).filter((unit) => typeof unit === "string" && ownUnitPattern.test(unit)))];
    if (!wanted.length) return false;
    if (pending) {
      for (const unit of wanted) pending.units.add(unit);
      pending.reasons.add(reason);
      return true;
    }
    // What an earlier restart could not make goes with this one.
    const entry = { units: new Set([...wanted, ...(unfinished?.units ?? [])]), reasons: new Set([reason]), since: now().toISOString() };
    pending = entry;
    const restartNow = () => lanes.run([exclusiveLane], async () => {
      // Nothing else runs, and nothing new starts behind the exclusive lane: from here the helper
      // turns away what would only wait for the restart to cut it off.
      restarting = true;
      onRestarting(true);
      try {
        // The job that asked has replied; give the web side a moment to record it.
        await sleep(graceMs);
        if (pending === entry) pending = null;
        const list = [...entry.units];
        const why = [...entry.reasons].join("; ");
        log(`Restarting ${list.join(" and ")} now that no other work is running: ${why}`);
        const unit = `boxpilot-restart-${randomBytes(4).toString("hex")}`;
        const result = await run(systemdRun, ["--quiet", "--collect", "--wait", `--unit=${unit}`, `--description=Restart BoxPilot: ${why}`.slice(0, 200), systemctl, "restart", ...list], { timeout: restartTimeoutMs });
        if (result?.ok) paid(list);
        else {
          const said = String(result?.stderr ?? "").trim().split("\n").at(-1) || "systemd-run failed";
          owe("failed", list, why, said);
          log(`Could not restart ${list.join(" and ")}: ${said}. ${where}`);
        }
        return { restarted: Boolean(result?.ok), units: list };
      } finally {
        // Still here: only the web service restarted, or nothing did. Work is taken again.
        restarting = false;
        onRestarting(false);
      }
    });
    // Wait for an idle moment holding nothing, so new work keeps flowing meanwhile; at most maxWaitMs.
    last = new Promise((resolve) => {
      const timer = setTimer(() => {
        stopWaiting();
        if (pending === entry) pending = null;
        owe("gave-up", [...entry.units], [...entry.reasons].join("; "));
        log(`BoxPilot still needs a restart of ${[...entry.units].join(" and ")} (${[...entry.reasons].join("; ")}): the server was never idle in ${formatDuration(maxWaitMs)}, so it was not restarted and nothing was stopped. ${where}`);
        resolve({ restarted: false, units: [...entry.units], gaveUp: true });
      }, maxWaitMs);
      timer?.unref?.();
      const stopWaiting = lanes.onIdle(() => { clearTimer(timer); resolve(restartNow()); });
    }).catch((error) => {
      if (pending === entry) pending = null;
      owe("failed", [...entry.units], [...entry.reasons].join("; "), error.message);
      log(`Could not restart BoxPilot: ${error.message}. ${where}`);
      return { restarted: false, error: error.message };
    });
    return true;
  }

  return {
    request,
    /** The units a waiting restart will restart. */
    pending: () => (pending ? [...pending.units] : []),
    /**
     * Where BoxPilot's own restart stands: one waiting for an idle moment (`waiting`), one under way
     * (`restarting`), and what one that gave up or failed still owes (`unfinished`: its outcome, the
     * units, why it was asked for, when, and systemd's last words when it failed).
     */
    status: () => ({
      waiting: pending && !restarting ? { units: [...pending.units], reason: [...pending.reasons].join("; "), since: pending.since } : null,
      restarting,
      unfinished: unfinished ? { ...unfinished, units: [...unfinished.units] } : null,
    }),
    /** Settles once the latest restart asked for has been made (or could not be). */
    settled: () => last,
  };
}
