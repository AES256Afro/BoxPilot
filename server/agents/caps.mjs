/**
 * The hard caps the agents runner lives under (M37), in one place. The owner asked that agents
 * never make the server run hot, and promised limits are not limits: these are enforced by the
 * kernel through deploy/boxpilot-agents.service, which caps.test.mjs holds to the values here, and
 * shown in the Agents section's Usage panel from this same object, so what the page says is what
 * systemd enforces. The runner and everything it starts - the model server included - live in the
 * one cgroup these apply to.
 *
 * From the Unsloth spike (docs/spikes/2026-09-unsloth-headless.md): one processor and one thread is
 * the best a small Qwen gets under a cap of one processor or less (two threads spend the quota
 * faster and then sit throttled), the 4B needs about 2.6 GB of memory plus its 3.6 GB of files as
 * page cache, and a reload that forgets its context asks for 8 GB more - which the memory cap stops.
 * On the server this was written for (8 cores / 16 threads, about 29 GB) that is a sixteenth of the
 * processor, and only when nothing else wants it.
 */
export const runnerCaps = Object.freeze({
  // One processor's worth of time at most, whatever the model asks for.
  cpuQuotaPercent: 100,
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
  // The model server's threads: one, as the spike measured best under a one-processor cap.
  modelThreads: 1,
});

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
