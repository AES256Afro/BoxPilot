import { shared } from "./cache.mjs";

/** needrestart emits both real services and special restart-script markers. */
export function parseNeedrestart(stdout) {
  const services = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.match(/^NEEDRESTART-SVC:\s*(\S+)/);
    if (match) services.add(match[1]);
  }
  return [...services].sort();
}

export function createNeedrestartScanner({ now = () => Date.now() } = {}) {
  const inspect = shared(async (run) => {
    const result = await run("/usr/sbin/needrestart", ["-b"], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    if (!result.ok) throw new Error("The running-library scan did not finish");
    return { services: parseNeedrestart(result.stdout), checkedAt: new Date(now()).toISOString() };
  }, { ttlMs: 10 * 60_000, now });
  return { inspect, forget: inspect.forget, stats: inspect.stats };
}
export const needrestartScanner = createNeedrestartScanner();
