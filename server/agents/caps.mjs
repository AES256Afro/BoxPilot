/**
 * The hard caps the agents runner lives under (M37), in one place. The owner asked that agents
 * never make the server run hot, and promised limits are not limits: these are enforced by the
 * kernel through deploy/boxpilot-agents.service, which caps.test.mjs holds to the values here, and
 * shown in the Agents section's Usage panel from this same object, so what the page says is what
 * systemd enforces. The runner and everything it starts - the model server included - live in the
 * one cgroup these apply to.
 *
 * Four processors and four threads, the owner's choice (2026-09-29) after the first real run: one
 * processor read a prompt at about 20 tokens a second on the home server, too slow for a question.
 * The Unsloth spike (docs/spikes/2026-09-unsloth-headless.md) found that the model's threads should
 * match the whole processors in the cap (more threads than that spend the quota and sit throttled).
 * The 4B needs about 2.6 GB of memory plus its 3.6 GB of files as page cache, and a reload that
 * forgets its context asks for 8 GB more - which the memory cap stops. On the server this was
 * written for (8 cores / 16 threads, about 29 GB) that is a quarter of the processor at most, only
 * while a run is going, and only when nothing else wants it.
 */
export const runnerCaps = Object.freeze({
  // Four processors' worth of time at most, whatever the model asks for.
  cpuQuotaPercent: 400,
  // CPUWeight=idle: the runner only gets processor time nothing else wants.
  cpuWeight: "idle",
  nice: 19,
  ioSchedulingClass: "idle",
  // The runner (about 70 MB), Unsloth's backend (0.4 GB), the 4B model (2.6 GB) and its files as
  // page cache (3.6 GB). No MemoryHigh: throttling the page cache below the cap would make every
  // token read the disk.
  memoryMaxBytes: 8 * 1024 ** 3,
  memorySwapMaxBytes: 0,
  tasksMax: 256,
  // The model server's threads: one for each whole processor in the quota.
  modelThreads: 4,
});

/**
 * Processors while someone waits, and in the background (M40, ADR-009). The owner's decision: up
 * to eight while a person waits on the answer (their question, the Test tab, a Zulip message), four
 * for everything nobody waits on (schedules, events, webhooks, learning, indexing, the nightly
 * evaluation). The shipped unit holds the background quota; a person's run raises the running
 * unit's quota for itself (`systemctl set-property --runtime`, from the root helper), and a timer
 * set with it takes it back if nothing else does.
 *
 * "Processors" are what CPUQuota counts: 800% is eight processors' time. Each setting is 2 to 8,
 * and never more than this machine's processors less two, so the rest of the server always keeps
 * two. The model runs a thread for each, but never more threads than the machine has physical
 * cores: on a Ryzen 7 7800X3D (8 cores, 16 processors) that is 8 and 4.
 */
export const defaultCores = Object.freeze({ waiting: 8, background: 4 });
export const coreLimits = Object.freeze({ min: 2, max: 8, keepFree: 2 });

/** The most processors agents may have on a machine with this many: 8, or all but two, never under 2. */
export function coreCeiling(processors) {
  const count = Number.isInteger(processors) && processors > 0 ? processors : coreLimits.max + coreLimits.keepFree;
  return Math.max(coreLimits.min, Math.min(coreLimits.max, count - coreLimits.keepFree));
}

/** The owner's two settings, each held to 2 and the machine's ceiling, background no more than waiting. */
export function effectiveCores(saved = {}, { processors } = {}) {
  const ceiling = coreCeiling(processors);
  const clamp = (value, fallback) => Math.min(ceiling, Math.max(coreLimits.min, Number.isInteger(value) ? value : fallback));
  const waiting = clamp(saved?.waiting, defaultCores.waiting);
  return { waiting, background: Math.min(waiting, clamp(saved?.background, defaultCores.background)), ceiling };
}

/** The model's threads for so many processors: one each, never more than the physical cores. */
export const threadsFor = (cores, physicalCores = null) => Math.max(1, Number.isInteger(physicalCores) && physicalCores > 0 ? Math.min(cores, physicalCores) : cores);

/**
 * This machine's physical cores, from sysfs: the distinct (package, core) pairs of its processors.
 * Null where they cannot be read (not Linux, a sandbox that hides them): threads then follow the setting.
 */
export async function physicalCores({ readdir, readFile } = {}) {
  try {
    const fs = await import("node:fs/promises");
    const list = readdir ?? fs.readdir;
    const read = readFile ?? ((file) => fs.readFile(file, "utf8"));
    const cpus = (await list("/sys/devices/system/cpu")).filter((name) => /^cpu\d+$/.test(name));
    const pairs = new Set();
    for (const cpu of cpus) {
      const [pkg, core] = await Promise.all([read(`/sys/devices/system/cpu/${cpu}/topology/physical_package_id`), read(`/sys/devices/system/cpu/${cpu}/topology/core_id`)]);
      pairs.add(`${String(pkg).trim()}:${String(core).trim()}`);
    }
    return pairs.size || null;
  } catch {
    return null;
  }
}

/** The unit's own words for the caps, as systemd reads them. */
export function unitDirectives(caps = runnerCaps) {
  return {
    CPUQuota: `${caps.cpuQuotaPercent}%`,
    CPUWeight: caps.cpuWeight,
    Nice: String(caps.nice),
    IOSchedulingClass: caps.ioSchedulingClass,
    MemoryMax: `${Math.round(caps.memoryMaxBytes / 1024 ** 3)}G`,
    MemorySwapMax: String(caps.memorySwapMaxBytes),
    TasksMax: String(caps.tasksMax),
  };
}

/** The unit's name. It is installed with every other unit and enabled only when the owner turns Agents on. */
export const runnerUnit = "boxpilot-agents.service";
