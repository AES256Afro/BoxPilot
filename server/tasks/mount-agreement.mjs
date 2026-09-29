/**
 * systemd's word about a mount and the kernel's, made to agree before a mount unit is started, and
 * a mount proven by PID 1's mount table rather than by an exit code.
 *
 * BoxPilot unmounts and mounts drives itself, with umount(8) and mount(8) switched into PID 1's
 * namespace (hostNamespace in storage.mjs), not through systemd. systemd follows the mount table in
 * its own time: it rereads it at most five times a second, and a container starting or stopping
 * makes several changes of its own, so a mount unit can still say `active` for most of a second
 * after its drive was unmounted. Before systemd 252 (Ubuntu 22.04 has 249) a `systemctl start`
 * issued then finds the unit started already, does nothing and exits 0; 252 and later hold the start
 * until they have caught up. The drive stays unmounted, and whatever starts next - Docker, and every
 * app with a folder on the drive - starts on the empty folder underneath and writes to the system
 * disk. A stop is held in no version: issued while systemd has not yet seen a mount, it does nothing
 * and exits 0 (tests/ubuntu/drive-shutdown-order.sh, 7c). 6d there shows the lag, what a start does
 * in it on the systemd at hand, and the resume below it.
 *
 * So a mount unit is started only once its state says what the table says (waitForSystemd), and
 * the start counts only when the table has the mount, from the device expected (startMountUnit,
 * mountedFrom). Every wait is bounded.
 */

const binaries = {
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
};
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** How long a start waits for systemd to catch up with the mount table before it goes ahead regardless. */
export const systemdSettleMs = 5_000;

/**
 * What PID 1 has mounted exactly at `mountpoint`, bottom first (an automount's autofs, then what is
 * mounted over it), or null when the table could not be read. Listed rather than looked up by path,
 * so an automount is never fired and a share whose server has gone is never waited on. OPTIONS and
 * SOURCE come last: a source is the one value that could be empty.
 */
export async function hostMountsAt(run, mountpoint) {
  const listed = await run(binaries.findmnt, ["--task", "1", "-rn", "-o", "TARGET,FSTYPE,MAJ:MIN,OPTIONS,SOURCE"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (!listed.ok) return null;
  return listed.stdout.split("\n").map((row) => row.trim().split(/\s+/)).filter(([target]) => target === mountpoint)
    .map(([, fstype = null, majMin = null, options = "", source = null]) => ({ source, fstype, majMin, options, readOnly: options.split(",").includes("ro") }));
}

/** The filesystem itself among the mounts at a mount point: the top one that is not an automount's autofs. */
export function realMount(mounts) {
  return (mounts ?? []).filter((mount) => mount.fstype !== "autofs").at(-1) ?? null;
}

/** A mount unit's ActiveState and SubState, or null when systemd did not answer. */
export async function unitState(run, unit) {
  const shown = await run(binaries.systemctl, ["show", unit, "--property=ActiveState,SubState"], { timeout: 15_000 });
  if (!shown.ok) return null;
  const fields = Object.fromEntries(shown.stdout.split("\n").map((line) => line.trim().split(/=(.*)/s)).filter(([key]) => key));
  return fields.ActiveState ? { active: fields.ActiveState, sub: fields.SubState ?? null } : null;
}

/**
 * Whether the unit's state says what the table says: `active` for a mount that is there, `inactive`
 * or `failed` for one that is not. A unit on its way somewhere (activating, deactivating) agrees
 * with nothing yet.
 */
export function agrees(state, mounted) {
  if (!state) return false;
  return mounted ? state.active === "active" : state.active === "inactive" || state.active === "failed";
}

/** One look at both: what the table has at the mount point, and what the unit says. */
async function lookAt(run, unit, mountpoint) {
  const [mounts, state] = await Promise.all([hostMountsAt(run, mountpoint), unitState(run, unit)]);
  const mount = realMount(mounts);
  return { mount, state, known: mounts !== null && state !== null, agreed: mounts !== null && agrees(state, Boolean(mount)) };
}

/**
 * Wait, bounded by `timeoutMs`, until the unit's state agrees with PID 1's mount table about
 * `mountpoint`. Returns the last look either way: `agreed` says whether it got there, `mount` what
 * is mounted there now. When systemd or findmnt cannot be asked there is nothing to wait for.
 */
export async function waitForSystemd(run, unit, mountpoint, { log = null, sleep = pause, clock = () => Date.now(), timeoutMs = systemdSettleMs } = {}) {
  const began = clock();
  let look = await lookAt(run, unit, mountpoint);
  // Behind at the first look, or not: the time the look itself took is not a wait.
  const behind = !look.agreed && look.known;
  let interval = 50;
  while (!look.agreed && look.known && clock() - began < timeoutMs) {
    await sleep(interval);
    interval = Math.min(interval * 2, 250);
    look = await lookAt(run, unit, mountpoint);
  }
  const waitedMs = behind ? clock() - began : 0;
  const where = `${mountpoint} ${look.mount ? "mounted" : "unmounted"}`;
  if (behind && look.agreed) log?.(`systemd took ${waitedMs} ms to see ${where}`, "stdout");
  if (!look.agreed && look.known) log?.(`${unit} still says ${look.state?.active ?? "nothing"} ${waitedMs} ms on, with ${where}; going ahead`, "stderr");
  return { ...look, waitedMs };
}

/**
 * Whether `mountpoint` is mounted now, in PID 1's namespace, from one of `sources` (the device it
 * was mounted from before, the device its fstab entry names now). With no sources, any filesystem
 * there counts. `reason` is a plain sentence when it is not.
 */
export async function mountedFrom(run, mountpoint, sources = []) {
  const expected = [...new Set(sources.filter(Boolean))];
  const mounts = await hostMountsAt(run, mountpoint);
  const mount = realMount(mounts);
  if (!mount) return { ok: false, mount: null, reason: mounts === null ? `findmnt could not read the host's mount table to see whether ${mountpoint} is mounted` : `nothing is mounted at ${mountpoint}` };
  if (expected.length && !expected.includes(mount.source)) return { ok: false, mount, reason: `${mountpoint} is mounted from ${mount.source}, not from ${expected.join(" or ")}` };
  return { ok: true, mount, reason: null };
}

/**
 * Start a mount unit and prove it mounted. First the unit is given the time to catch up with the
 * table (waitForSystemd), so the start is not taken as done by a unit that still thinks it is
 * mounted. Then the table must have the mount, from `sources`. A start that exits 0 with nothing
 * mounted is that same lag, so it is waited out and the start made once more; a start that fails,
 * or a mount from another device, is not retried.
 *
 * Returns `{ ok, mount, reason, started, tries, result }`: `started` is false when the mount was
 * there already, `result` is systemctl's last answer.
 */
export async function startMountUnit(run, unit, mountpoint, { sources = [], log = null, sleep = pause, clock = () => Date.now(), timeoutMs = systemdSettleMs } = {}) {
  const settle = () => waitForSystemd(run, unit, mountpoint, { log, sleep, clock, timeoutMs });
  const first = await settle();
  if (first.mount) {
    const already = await mountedFrom(run, mountpoint, sources);
    return { ...already, started: false, tries: 0, result: null };
  }
  let result = null;
  for (let tries = 1; tries <= 2; tries += 1) {
    result = await run(binaries.systemctl, ["start", unit], { timeout: 120_000 });
    const found = await mountedFrom(run, mountpoint, sources);
    if (found.ok || found.mount) return { ...found, started: true, tries, result };
    if (!result.ok) return { ok: false, mount: null, reason: `systemctl start ${unit} failed: ${tail(result.stderr) || "see the unit's journal"}`, started: true, tries, result };
    if (tries === 1) {
      log?.(`systemctl start ${unit} exited 0 with nothing mounted at ${mountpoint}; waiting for systemd to catch up, then starting it once more`, "stderr");
      await settle();
    }
  }
  return { ok: false, mount: null, reason: `systemd said ${unit} started, twice, but nothing is mounted at ${mountpoint}`, started: true, tries: 2, result };
}
