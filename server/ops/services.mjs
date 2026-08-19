import { defineOperation } from "./registry.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const journalctl = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl";
const unitPattern = /^[A-Za-z0-9:._@\\-]{1,200}\.(service|timer|socket|mount|target)$/;
export const serviceActions = Object.freeze(["start", "stop", "restart", "reload", "enable", "disable"]);

/**
 * Units BoxPilot will not stop or disable from the UI because doing so cuts off the operator or the
 * product itself. Restart is still allowed (with confirmation).
 */
export const criticalUnitPatterns = Object.freeze([
  /^boxpilot(-helper)?\.service$/, /^ssh(d)?\.service$/, /^ssh\.socket$/, /^systemd-/, /^dbus(-broker)?\.(service|socket)$/,
  /^tailscaled\.service$/, /^NetworkManager\.service$/, /^networkd-dispatcher\.service$/, /^getty@/, /^serial-getty@/, /^user@/, /^init\.scope$/, /^-\.mount$/,
]);

export function isCriticalUnit(unit) {
  return criticalUnitPatterns.some((pattern) => pattern.test(unit));
}

/** Parse `systemctl list-units --output=json` and `list-unit-files --output=json`. */
export function mergeUnitLists(unitsJson, filesJson) {
  let units = []; let files = [];
  try { units = JSON.parse(unitsJson || "[]"); } catch { units = []; }
  try { files = JSON.parse(filesJson || "[]"); } catch { files = []; }
  const enabledState = new Map(files.map((file) => [file.unit_file, file.state]));
  const seen = new Set();
  const merged = units.filter((unit) => typeof unit.unit === "string" && unitPattern.test(unit.unit)).map((unit) => {
    seen.add(unit.unit);
    return { unit: unit.unit, description: unit.description ?? "", load: unit.load ?? "", active: unit.active ?? "", sub: unit.sub ?? "", enabled: enabledState.get(unit.unit) ?? "static", critical: isCriticalUnit(unit.unit) };
  });
  for (const file of files) {
    if (seen.has(file.unit_file) || !unitPattern.test(file.unit_file ?? "") || file.unit_file.includes("@.")) continue;
    merged.push({ unit: file.unit_file, description: "", load: "not-loaded", active: "inactive", sub: "dead", enabled: file.state ?? "", critical: isCriticalUnit(file.unit_file) });
  }
  return merged.sort((a, b) => a.unit.localeCompare(b.unit));
}

function redact(value) {
  return String(value ?? "").replace(/\b(token|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function serviceOperations() {
  return [
    defineOperation({
      id: "service.list", title: "List system services", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "systemd services and timers with their active and enabled state.",
      run: async (_parameters, { run }) => {
        const [units, files] = await Promise.all([
          run(systemctl, ["list-units", "--type=service,timer", "--all", "--no-pager", "--plain", "--output=json"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
          run(systemctl, ["list-unit-files", "--type=service,timer", "--no-pager", "--output=json"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
        ]);
        if (!units.ok) throw new Error(`systemctl list-units failed: ${units.stderr.split("\n").slice(-2).join(" ")}`);
        const list = mergeUnitLists(units.stdout, files.ok ? files.stdout : "[]");
        return { units: list, counts: { total: list.length, active: list.filter((item) => item.active === "active").length, failed: list.filter((item) => item.active === "failed").length } };
      },
    }),
    defineOperation({
      id: "service.journal", title: "Read service journal", risk: "low", readOnly: true, timeoutMs: 60_000,
      parameters: { fields: { unit: { type: "string", pattern: unitPattern }, lines: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 1000 ? null : "must be 1-1000") } } },
      run: async (parameters, { run }) => {
        const lines = parameters.lines ?? 200;
        const result = await run(journalctl, ["-u", parameters.unit, "-n", String(lines), "--no-pager", "-o", "short-iso"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        if (!result.ok && !result.stdout) throw new Error(`journalctl failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { unit: parameters.unit, lines: result.stdout.split("\n").filter(Boolean).map(redact).slice(-lines) };
      },
    }),
    defineOperation({
      id: "service.action", title: "Control a system service", risk: "medium", timeoutMs: 5 * 60_000,
      description: "Start, stop, restart, reload, enable, or disable a systemd unit. BoxPilot, SSH, systemd, D-Bus, and Tailscale units cannot be stopped or disabled from here.",
      parameters: { fields: { unit: { type: "string", pattern: unitPattern }, action: { type: "string", enum: [...serviceActions] } } },
      run: async (parameters, { run, progress }) => {
        const { unit, action } = parameters;
        if (isCriticalUnit(unit) && ["stop", "disable"].includes(action)) throw new Error(`${unit} is protected: stopping or disabling it would cut off access to this server or to BoxPilot`);
        const args = action === "enable" || action === "disable" ? [action, unit] : [action, unit];
        progress?.(`$ systemctl ${args.join(" ")}`, "stdout");
        const result = await run(systemctl, args, { timeout: 4 * 60_000, onLine: progress ?? undefined });
        if (!result.ok) throw new Error(`systemctl ${action} ${unit} failed: ${result.stderr.split("\n").slice(-3).join(" ") || "see the unit journal"}`);
        const show = await run(systemctl, ["show", unit, "--property=ActiveState,SubState,UnitFileState,Result"], { timeout: 15_000 });
        const state = Object.fromEntries(show.stdout.split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
        return { unit, action, activeState: state.ActiveState ?? null, subState: state.SubState ?? null, enabled: state.UnitFileState ?? null, result: state.Result ?? null };
      },
    }),
  ];
}
