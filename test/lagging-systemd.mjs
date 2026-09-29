import { vi } from "vitest";

/**
 * PID 1's mount table for one mount point, and systemd's view of it, which lags - for the tests of
 * server/tasks/mount-agreement.mjs and the code that uses it.
 *
 * An unmount made outside systemd changes the kernel's table at once and reaches the mount unit
 * only `lagMs` later, by the clock the fake `sleep` moves. Until then a start finds the unit still
 * active, does nothing and exits 0, as systemd before 252 does (tests/ubuntu/drive-shutdown-order.sh,
 * 6d, run on Ubuntu 22.04's 249).
 * `starts` scripts what each start that does run does: `{ mounts: "/dev/sdb2" }` or `{ fails: "..." }`;
 * without one it mounts `device`. Docker's own start (docker.socket docker.service) answers
 * `dockerStarts`; blkid answers from `blkid`, by UUID.
 */
export function laggingSystemd({ mountpoint = "/mnt/the-dump", unit = "mnt-the\\x2ddump.mount", device = "/dev/sda2", mounted = null, unitActive = Boolean(mounted), lagMs = 0, starts = [], table = true, systemd = true, dockerStarts = true, blkid = {} } = {}) {
  const calls = [];
  const state = { mounted, unitActive, now: 0, seesAt: lagMs, dockerActive: false };
  const sees = () => { if (state.now >= state.seesAt) state.unitActive = Boolean(state.mounted); };
  const results = [...starts];
  const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").pop();
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt") {
      if (!table) return { ok: false, code: 1, stdout: "", stderr: "findmnt: cannot open /proc/1/mountinfo" };
      return ok(["/ ext4 8:1 rw,relatime /dev/mapper/vg-root", ...(state.mounted ? [`${mountpoint} exfat 8:2 rw,relatime,uid=1000 ${state.mounted}`] : [])].join("\n"));
    }
    if (name === "blkid") return args[0] === "-U" && blkid[args[1]] ? ok(blkid[args[1]]) : { ok: false, code: 2, stdout: "", stderr: "" };
    if (name !== "systemctl") return ok();
    if (args[0] === "show" && args[1] === unit) {
      if (!systemd) return { ok: false, code: 1, stdout: "", stderr: "Failed to connect to bus" };
      sees();
      return ok(`ActiveState=${state.unitActive ? "active" : "inactive"}\nSubState=${state.unitActive ? "mounted" : "dead"}`);
    }
    if (args[0] === "start" && args[1] === unit) {
      sees();
      // A unit systemd believes is mounted has nothing to start.
      if (state.unitActive) return ok();
      const next = results.shift() ?? { mounts: device };
      if (next.fails) return { ok: false, code: 1, stdout: "", stderr: next.fails };
      state.mounted = next.mounts; state.unitActive = true;
      return ok();
    }
    if (args[0] === "start" && args.includes("docker.service")) {
      if (dockerStarts !== true) return { ok: false, code: 1, stdout: "", stderr: dockerStarts };
      state.dockerActive = true;
      return ok();
    }
    return ok();
  });
  const sleep = vi.fn(async (ms) => { state.now += ms; });
  return { run, calls, state, sleep, clock: () => state.now, log: vi.fn() };
}
