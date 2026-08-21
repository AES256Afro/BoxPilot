import { defineOperation } from "./registry.mjs";

const journalctl = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl";
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
const unitPattern = /^[A-Za-z0-9:._@\\-]{1,200}\.(service|timer|socket|mount|target)$/;
const containerPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const sincePattern = /^(\d+(m|h|d)|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/;
const grepPattern = /^[^\0\r\n]{1,200}$/;

/** Fixed journal groups the Logs page offers with one click. */
export const logGroups = Object.freeze({
  boxpilot: { label: "BoxPilot", units: ["boxpilot.service", "boxpilot-helper.service", "boxpilot-run@*"] },
  docker: { label: "Docker", units: ["docker.service", "containerd.service"] },
  tailscale: { label: "Tailscale", units: ["tailscaled.service"] },
  virtualization: { label: "Virtualization", units: ["libvirtd.service", "virtqemud.service", "virtnetworkd.service", "virtstoraged.service"] },
  ssh: { label: "SSH", units: ["ssh.service", "sshd.service"] },
  kernel: { label: "Kernel", kernel: true },
  system: { label: "Everything", all: true },
});

function redact(value) {
  return String(value ?? "").replace(/\b(token|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sinceArgument(since) {
  if (!since) return [];
  const relative = since.match(/^(\d+)(m|h|d)$/);
  if (relative) return ["--since", `-${relative[1]}${relative[2] === "m" ? "min" : relative[2] === "h" ? "hour" : "day"}`];
  return ["--since", since];
}

export function logOperations() {
  return [
    defineOperation({
      id: "logs.sources", title: "List log sources", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Fixed journal groups, every systemd unit with journal output, and every Docker container.",
      run: async (_parameters, { run }) => {
        const [units, containers] = await Promise.all([
          run(systemctl, ["list-units", "--type=service,timer", "--all", "--no-pager", "--plain", "--output=json"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
          run(dockerBinary, ["ps", "--all", "--format", "{{.Names}}\t{{.State}}\t{{.Image}}"], { timeout: 15_000 }),
        ]);
        let unitList = [];
        try { unitList = JSON.parse(units.stdout || "[]").map((unit) => ({ unit: unit.unit, description: unit.description ?? "", active: unit.active ?? "" })).filter((unit) => unitPattern.test(unit.unit)); } catch { unitList = []; }
        const containerList = containers.ok ? containers.stdout.split("\n").filter(Boolean).map((line) => { const [name, state, image] = line.split("\t"); return { name, state, image }; }).filter((item) => containerPattern.test(item.name)) : [];
        return { groups: Object.entries(logGroups).map(([id, group]) => ({ id, label: group.label })), units: unitList.sort((a, b) => a.unit.localeCompare(b.unit)), containers: containerList.sort((a, b) => a.name.localeCompare(b.name)), dockerAvailable: containers.ok };
      },
    }),
    defineOperation({
      id: "logs.read", title: "Read logs", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Tail a journal group, one systemd unit, or one container, with optional time window and text filter. Lines are redacted.",
      parameters: { fields: {
        kind: { type: "string", enum: ["group", "unit", "container"] },
        target: { type: "string", maxLength: 200 },
        lines: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 10 && value <= 2000 ? null : "must be 10-2000") },
        since: { type: "string", optional: true, nullable: true, validate: (value) => (sincePattern.test(value) ? null : "must look like 30m, 2h, 7d, or YYYY-MM-DD[ HH:MM]") },
        filter: { type: "string", optional: true, nullable: true, validate: (value) => (grepPattern.test(value) ? null : "must be a short text pattern") },
      } },
      run: async ({ kind, target, lines = 300, since = null, filter = null }, { run }) => {
        let result;
        if (kind === "container") {
          if (!containerPattern.test(target)) throw new Error("Container name is invalid");
          const known = await run(dockerBinary, ["ps", "--all", "--format", "{{.Names}}"], { timeout: 15_000 });
          if (!known.ok || !known.stdout.split("\n").includes(target)) throw new Error(`Container ${target} was not found`);
          result = await run(dockerBinary, ["logs", "--timestamps", "--tail", String(lines), ...(since ? ["--since", since.match(/^\d+[mhd]$/) ? since : since.replace(" ", "T")] : []), target], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
          if (!result.ok && !result.stdout && !result.stderr) throw new Error("docker logs failed");
          let entries = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean);
          if (filter) entries = entries.filter((line) => line.toLowerCase().includes(filter.toLowerCase()));
          return { kind, target, lines: entries.slice(-lines).map(redact), truncated: entries.length > lines };
        }
        const args = ["--no-pager", "-o", "short-iso", "-n", String(lines), ...sinceArgument(since)];
        if (kind === "group") {
          const group = logGroups[target];
          if (!group) throw new Error("Unknown log group");
          if (group.kernel) args.push("-k");
          else if (!group.all) for (const unit of group.units) args.push("-u", unit);
        } else {
          if (!unitPattern.test(target)) throw new Error("Unit name is invalid");
          args.push("-u", target);
        }
        if (filter) args.push("-g", filter);
        result = await run(journalctl, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        if (!result.ok && !result.stdout) throw new Error(`journalctl failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        const entries = result.stdout.split("\n").filter((line) => line && !line.startsWith("-- "));
        return { kind, target, lines: entries.slice(-lines).map(redact), truncated: false };
      },
    }),
  ];
}
