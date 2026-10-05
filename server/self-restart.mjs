import { randomBytes } from "node:crypto";
import { exclusiveLane } from "./helper-lanes.mjs";

const systemdRun = "/usr/bin/systemd-run";
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
/** BoxPilot's own units: the only ones restarted here. */
export const ownUnitPattern = /^boxpilot(-helper)?\.service$/;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
 * The restart is now a task on the exclusive lane. It starts only once every lane has drained -
 * what ran beside the job, and what was queued behind it, finishes first - and while it holds that
 * lane nothing new starts. It waits a moment more for the web side to record the job that asked,
 * then has systemd restart the units from a transient unit of its own (so stopping the helper does
 * not stop the restart), and holds the lane until the restart is done. A web-only restart returns;
 * a helper restart ends this process first.
 *
 * Requests made while one is waiting join it: one restart of every unit asked for.
 */
export function createDrainedRestart({ lanes, run, sleep = pause, graceMs = 10_000, restartTimeoutMs = 3 * 60_000, log = (line) => console.log(line) } = {}) {
  let pending = null;
  let last = Promise.resolve();

  function request(units, { reason = "BoxPilot needs a restart" } = {}) {
    const wanted = [...new Set((Array.isArray(units) ? units : []).filter((unit) => typeof unit === "string" && ownUnitPattern.test(unit)))];
    if (!wanted.length) return false;
    if (pending) {
      for (const unit of wanted) pending.units.add(unit);
      pending.reasons.add(reason);
      return true;
    }
    const entry = { units: new Set(wanted), reasons: new Set([reason]) };
    pending = entry;
    last = lanes.run([exclusiveLane], async () => {
      // Every lane has drained. The job that asked has replied; give the web side a moment to record it.
      await sleep(graceMs);
      if (pending === entry) pending = null;
      const list = [...entry.units];
      const why = [...entry.reasons].join("; ");
      log(`Restarting ${list.join(" and ")} now that no other work is running: ${why}`);
      const unit = `boxpilot-restart-${randomBytes(4).toString("hex")}`;
      const result = await run(systemdRun, ["--quiet", "--collect", "--wait", `--unit=${unit}`, `--description=Restart BoxPilot: ${why}`.slice(0, 200), systemctl, "restart", ...list], { timeout: restartTimeoutMs });
      if (!result?.ok) log(`Could not restart ${list.join(" and ")}: ${String(result?.stderr ?? "").trim().split("\n").at(-1) || "systemd-run failed"}. Restart BoxPilot from the System page.`);
      return { restarted: Boolean(result?.ok), units: list };
    }).catch((error) => {
      log(`Could not restart BoxPilot: ${error.message}. Restart it from the System page.`);
      return { restarted: false, error: error.message };
    });
    return true;
  }

  return {
    request,
    /** The units a waiting restart will restart. */
    pending: () => (pending ? [...pending.units] : []),
    /** Settles once the latest restart asked for has been made (or could not be). */
    settled: () => last,
  };
}
