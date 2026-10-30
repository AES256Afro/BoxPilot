/**
 * The TheySpy adapter: what the Spyware watch agent (and the Server Keeper) may know about what
 * TheySpy found - devices that looked up spyware or ad-intelligence addresses, exploited bugs in
 * software a device runs, and traces the TheySpy agent or MVT found on a device. Read by the root
 * helper as a registered read-only operation (app.theyspy.inspect), never by the agents runner.
 *
 * TheySpy's image carries `node server/summary.mjs`, which opens its own database read-only and
 * prints one line of JSON. This runs exactly that, with `docker exec` and fixed arguments: no
 * token, no network, nothing written. TheySpy owns its schema, so a migration there cannot break
 * this. What comes back is treated as untrusted: every field is re-checked and bounded here, and
 * indicators stay defanged (example[.]com) so no model or page turns one into a link.
 */

const containerPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const imagePattern = /(^|\/)aes256afro\/theyspy(:|@|$)/i;
// Defanged indicators as TheySpy prints them: letters, digits, dots, dashes, and the [.] marks.
const indicatorPattern = /^[A-Za-z0-9.[\]_:-]{1,120}$/;
const cvePattern = /^CVE-\d{4}-\d{4,7}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

/** Text from TheySpy, cut to `max` characters, without control characters or markup brackets. */
const text = (value, max = 60) => {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Math.floor(Number(value)), 1_000_000) : 0);
const when = (value) => (typeof value === "string" && isoPattern.test(value) ? value : null);
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

/** TheySpy's printed summary, checked field by field. Returns null when it is not one. */
export function checkSummary(raw) {
  let s;
  try { s = typeof raw === "string" ? JSON.parse(raw.trim().split("\n").at(-1) ?? "") : raw; } catch { return null; }
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (s.error) return { error: text(s.error, 200), version: text(s.theyspy, 20) || null };
  const tone = (value) => (["good", "warn", "bad"].includes(value) ? value : "unknown");
  return {
    version: text(s.theyspy, 20) || null,
    at: when(s.at),
    days: count(s.days) || 7,
    pihole: { connected: s.pihole?.connected === true, lastTestOk: s.pihole?.lastTest ? s.pihole.lastTest.ok === true : null },
    sections: list(s.sections, 6).map((section) => ({ title: text(section?.title, 40), tone: tone(section?.tone), lines: list(section?.lines, 4).map((line) => text(line, 240)) })),
    lookups: {
      total: count(s.indicatorLookups?.total),
      notFullyBlocked: count(s.indicatorLookups?.notFullyBlocked),
      top: list(s.indicatorLookups?.top, 5)
        .filter((l) => indicatorPattern.test(String(l?.indicator ?? "")))
        .map((l) => ({ device: text(l.device), indicator: String(l.indicator).replace(/(?<!\[)\.(?!\])/g, "[.]"), lookups: count(l.lookups), blocked: count(l.blocked), lastSeen: when(l.lastSeen) })),
    },
    exploited: {
      total: count(s.exploitedOnDevices?.total),
      top: list(s.exploitedOnDevices?.top, 5).filter((e) => cvePattern.test(String(e?.cve ?? ""))).map((e) => ({ cve: String(e.cve), device: text(e.device), software: text(e.software), fixedIn: e.fixedIn ? text(e.fixedIn, 30) : null, due: when(e.due) })),
    },
    evidence: {
      contacted: count(s.evidence?.contacted),
      newThisPeriod: count(s.evidence?.newThisPeriod),
      gaps: count(s.evidence?.gaps),
      top: list(s.evidence?.top, 5).filter((f) => indicatorPattern.test(String(f?.indicator ?? ""))).map((f) => ({ device: text(f.device), indicator: String(f.indicator).replace(/(?<!\[)\.(?!\])/g, "[.]"), source: f.source === "mvt" ? "MVT" : "the TheySpy agent", at: when(f.at) })),
      agents: count(s.evidence?.agents),
      lastAgentReport: when(s.evidence?.lastAgentReport),
    },
  };
}

/**
 * The reader, for the helper. `apps.inspect()` says whether BoxPilot installed TheySpy; `run` is
 * the helper's fixed-binary runner.
 *
 * @param {{ run?: (binary: string, args: string[], options?: { timeout?: number, maxBuffer?: number }) => Promise<{ ok: boolean, stdout?: string, stderr?: string }>, apps?: any, dockerBinary?: string, now?: () => Date }} [options]
 */
export function createTheyspyReader({ run, apps = null, dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker", now = () => new Date() } = {}) {
  /** Where TheySpy runs: BoxPilot's app, another container from its image, or nowhere. */
  async function locate() {
    const listed = apps ? await apps.inspect({}).catch(() => null) : null;
    const app = (listed?.applications ?? []).find((entry) => entry?.id === "theyspy" && entry.installed);
    if (app) return { placement: "boxpilot-app", container: "bp-theyspy", running: app.container?.running === true };
    const containers = await run(dockerBinary, ["ps", "--all", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" }));
    if (containers.ok) {
      for (const line of String(containers.stdout ?? "").split("\n")) {
        const [name, image, state] = line.trim().split("\t");
        if (imagePattern.test(image ?? "") && containerPattern.test(name ?? "")) return { placement: "container", container: name, running: state === "running" };
      }
    }
    return { placement: "absent", container: null, running: false };
  }

  async function inspect() {
    const where = await locate();
    const base = { ...where, readAt: now().toISOString() };
    if (where.placement === "absent") return { ...base, available: false, reason: "TheySpy is not installed on this server (App catalog → TheySpy)." };
    if (!where.running) return { ...base, available: false, reason: `The ${where.container} container is not running.` };
    const result = await run(dockerBinary, ["exec", where.container, "node", "server/summary.mjs", "7"], { timeout: 45_000, maxBuffer: 256 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    const summary = checkSummary(result.stdout ?? "");
    if (!summary) return { ...base, available: false, reason: result.ok ? "TheySpy answered with something that is not its summary." : "TheySpy's summary could not be read; TheySpy 1.2.0 or newer has it." };
    if (summary.error) return { ...base, available: false, version: summary.version, reason: `TheySpy could not read its database: ${summary.error}` };
    return { ...base, available: true, ...summary };
  }

  return { inspect, locate };
}

/** The answer as a few lines for an agent. Indicators stay defanged. */
export function describeTheyspy(result) {
  if (!result) return "TheySpy could not be read.";
  if (!result.available) return String(result.reason ?? "TheySpy could not be read.");
  const lines = [
    `TheySpy ${result.version ?? ""} (container ${result.container}), last ${result.days} days, read ${result.readAt}. Pi-hole ${result.pihole.connected ? "connected" : "NOT connected, so lookups are not being watched"}.`,
    result.lookups.total
      ? `Indicator lookups: ${result.lookups.total} (device, indicator) pairs, ${result.lookups.notFullyBlocked} not fully blocked. ${result.lookups.top.map((l) => `${l.device} looked up ${l.indicator} ${l.lookups}x (${l.blocked} blocked, last ${l.lastSeen ?? "?"})`).join("; ")}.`
      : "Indicator lookups: no device looked up a known spyware or ad-intelligence address.",
    result.evidence.contacted
      ? `On-device evidence: ${result.evidence.contacted} open contact finding(s), ${result.evidence.newThisPeriod} new this period. ${result.evidence.top.map((f) => `${f.device}: ${f.indicator} (found by ${f.source}, ${f.at ?? "?"})`).join("; ")}.`
      : `On-device evidence: no contact found${result.evidence.agents ? ` by ${result.evidence.agents} agent(s)` : " (no computer runs the TheySpy agent)"}.`,
    result.evidence.gaps ? `${result.evidence.gaps} check(s) could not run on a device (gaps; never read as clean).` : null,
    result.exploited.total
      ? `Exploited bugs on devices: ${result.exploited.total}. ${result.exploited.top.map((e) => `${e.cve} on ${e.device} (${e.software}${e.fixedIn ? `, fixed in ${e.fixedIn}` : ""})`).join("; ")}.`
      : "Exploited bugs on devices: none in software TheySpy has seen.",
  ];
  return lines.filter(Boolean).join("\n");
}
