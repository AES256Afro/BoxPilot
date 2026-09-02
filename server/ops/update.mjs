import { defineOperation } from "./registry.mjs";
import { releaseTagPattern } from "../tasks/update.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const journalctl = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl";

/** `systemctl list-units --plain --no-legend` rows for boxpilot-update-* units. */
export function parseUpdateUnits(stdout) {
  return String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [unit, load, active, sub, ...description] = line.split(/\s+/);
    return { unit, load, active, sub, description: description.join(" ") };
  }).filter((entry) => /^boxpilot-update-[0-9TZ]+\.service$/.test(entry.unit));
}

/** What the last update did, from its unit state and the upgrade script's own markers. */
export function updateOutcome(units, lines) {
  if (units.some((unit) => unit.active === "active" || unit.active === "activating")) return "running";
  const markers = lines.filter((line) => line.includes("[boxpilot-upgrade]"));
  const last = markers.at(-1) ?? "";
  if (/ is live;/.test(last)) return "live";
  if (/ERROR:/.test(last) || units.some((unit) => unit.active === "failed")) return "failed";
  return markers.length ? "running" : null;
}

/** BoxPilot self-update (M4.5): the status read and the high-risk update itself. */
export function updateOperations() {
  return [
    defineOperation({
      // operator (ADR-003): returns up to eighty raw journal lines as root; every other journal read needs an operator.
      id: "system.update.status", title: "Read BoxPilot update status", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 30_000,
      description: "The most recent self-update units and the upgrade log they wrote.",
      run: async (_parameters, { run }) => {
        const [units, journal] = await Promise.all([
          run(systemctl, ["list-units", "--all", "--plain", "--no-legend", "--no-pager", "boxpilot-update-*"], { timeout: 15_000 }),
          run(journalctl, ["--no-pager", "-o", "short-iso", "-n", "80", "-u", "boxpilot-update-*"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }),
        ]);
        const unitList = parseUpdateUnits(units.ok ? units.stdout : "");
        const lines = journal.ok ? journal.stdout.split("\n").filter((line) => line && !line.startsWith("-- ")) : [];
        return { units: unitList, log: lines, outcome: updateOutcome(unitList, lines) };
      },
    }),
    defineOperation({
      id: "system.update", title: "Update BoxPilot", risk: "high", timeoutMs: 10 * 60_000, restartsService: true,
      description: "Downloads the chosen GitHub release, builds it, swaps it into place, and restarts BoxPilot. If the new version does not pass its health check the previous tree is restored automatically. Let running jobs finish first; the restart interrupts them.",
      parameters: { fields: { tag: { type: "string", pattern: releaseTagPattern }, expectedCommit: { type: "string", pattern: /^[a-f0-9]{40}$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.update", { tag: parameters.tag, expectedCommit: parameters.expectedCommit }, { timeoutMs: 5 * 60_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
