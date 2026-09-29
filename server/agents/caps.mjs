/**
 * The hard caps the agents runner lives under (M37), in one place. The owner asked that agents
 * never make the server run hot, and promised limits are not limits: these are enforced by the
 * kernel through deploy/boxpilot-agents.service, which caps.test.mjs holds to the values here, and
 * shown in the Agents section's Usage panel from this same object, so what the page says is what
 * systemd enforces. The runner and everything it starts - the model server included - live in the
 * one cgroup these apply to.
 *
 * Sized for the server this was written for (8 cores / 16 threads, about 29 GB, no usable GPU):
 * two threads' worth of CPU is an eighth of the machine, and only when nothing else wants it.
 */
export const runnerCaps = Object.freeze({
  // Two threads' worth of processor time at most, whatever the model asks for.
  cpuQuotaPercent: 200,
  // CPUWeight=idle: the runner only gets processor time nothing else wants.
  cpuWeight: "idle",
  nice: 19,
  ioSchedulingClass: "idle",
  // A 4B model in 4 bits with its vision projector and an 8k context fits in about 5 GB.
  memoryMaxBytes: 8 * 1024 ** 3,
  memoryHighBytes: 7 * 1024 ** 3,
  memorySwapMaxBytes: 0,
  tasksMax: 256,
  // The model server's threads: no more than the quota can feed.
  modelThreads: 2,
});

/** The unit's own words for the caps, as systemd reads them. */
export function unitDirectives(caps = runnerCaps) {
  const gib = (bytes) => `${Math.round(bytes / 1024 ** 3)}G`;
  return {
    CPUQuota: `${caps.cpuQuotaPercent}%`,
    CPUWeight: caps.cpuWeight,
    Nice: String(caps.nice),
    IOSchedulingClass: caps.ioSchedulingClass,
    MemoryMax: gib(caps.memoryMaxBytes),
    MemoryHigh: gib(caps.memoryHighBytes),
    MemorySwapMax: String(caps.memorySwapMaxBytes),
    TasksMax: String(caps.tasksMax),
  };
}

/** The unit's name. It is installed with every other unit and enabled only when the owner turns Agents on. */
export const runnerUnit = "boxpilot-agents.service";
