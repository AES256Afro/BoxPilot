import { access, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { defineOperation } from "./registry.mjs";
import { jailPath, parseJail } from "../tasks/fail2ban.mjs";

const minutes = (value) => value * 60_000;
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const client = "/usr/bin/fail2ban-client";
/** The most banned addresses one read hands back; the counts still say how many there are. */
const bannedListLimit = 500;

/**
 * Read `fail2ban-client status sshd`: the counts, and which addresses are banned now. Every
 * address is checked to be one (a line fail2ban never writes is not passed on as one).
 * @returns {{ currentlyBanned: number, totalBanned: number, bannedAddresses: string[] }}
 */
export function parseJailStatus(stdout) {
  const text = String(stdout ?? "");
  const listed = (text.match(/Banned IP list:[ \t]*(.*)$/m)?.[1] ?? "").split(/\s+/).filter((entry) => isIP(entry) !== 0);
  return {
    currentlyBanned: Number(text.match(/Currently banned:\s*(\d+)/)?.[1] ?? 0),
    totalBanned: Number(text.match(/Total banned:\s*(\d+)/)?.[1] ?? 0),
    bannedAddresses: [...new Set(listed)].slice(0, bannedListLimit),
  };
}

/** A single IPv4 or IPv6 address as fail2ban lists it: no prefix, no zone, no leading zeros. */
const singleAddress = (value) => (typeof value === "string" && isIP(value) !== 0 && !value.includes("%") ? null : "must be one IPv4 or IPv6 address");
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");

const whole = (min, max) => (value) => (Number.isInteger(value) && value >= min && value <= max ? null : `must be a whole number between ${min} and ${max}`);

/** Brute-force protection for SSH with fail2ban. */
export function fail2banOperations() {
  return [
    defineOperation({
      id: "fail2ban.inspect", title: "Read brute-force protection state", risk: "low", readOnly: true, timeoutMs: 30_000,
      // Open to every role (ADR-003 addendum, 2026-09-28): the owner decided everyone sees which addresses are banned.
      description: "Whether fail2ban is installed and running, the managed sshd jail settings, and which addresses are banned right now.",
      run: async (_parameters, { run, installedCheck = () => access(client) }) => {
        const installed = await Promise.resolve().then(installedCheck).then(() => true, () => false);
        const config = parseJail(await readFile(jailPath, "utf8").catch(() => ""));
        let running = null; let currentlyBanned = null; let totalBanned = null; let bannedAddresses = null;
        if (installed) {
          const active = await run(systemctl, ["is-active", "fail2ban"], { timeout: 10_000 }).catch(() => null);
          running = active ? active.stdout.trim() === "active" : null;
          const status = await run(client, ["status", "sshd"], { timeout: 10_000 }).catch(() => null);
          if (status?.ok) ({ currentlyBanned, totalBanned, bannedAddresses } = parseJailStatus(status.stdout));
        }
        return { installed, running, configured: config.managed, config, currentlyBanned, totalBanned, bannedAddresses };
      },
    }),
    defineOperation({
      id: "fail2ban.apply", title: "Apply brute-force protection", risk: "medium", timeoutMs: minutes(3),
      description: "Writes /etc/fail2ban/jail.d/boxpilot.local enabling the sshd jail with your thresholds (loopback, the tailnet, and optionally the LAN are never banned), tests it, and starts fail2ban. Disabling stops the service and removes the file.",
      parameters: { fields: {
        enabled: { type: "boolean", optional: true },
        maxRetry: { type: "number", optional: true, validate: whole(1, 50) },
        findTimeMinutes: { type: "number", optional: true, validate: whole(1, 1440) },
        banTimeMinutes: { type: "number", optional: true, validate: whole(1, 43200) },
        ignoreLan: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("fail2ban.apply", { enabled: parameters.enabled ?? true, maxRetry: parameters.maxRetry ?? 5, findTimeMinutes: parameters.findTimeMinutes ?? 10, banTimeMinutes: parameters.banTimeMinutes ?? 60, ignoreLan: parameters.ignoreLan ?? true }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "fail2ban.unban", title: "Lift a ban", risk: "medium", timeoutMs: 30_000,
      description: "Lifts one address's SSH ban now, with fail2ban-client set sshd unbanip. The address can be banned again if it keeps failing.",
      parameters: { fields: { address: { type: "string", maxLength: 45, pattern: /^[0-9A-Fa-f:.]+$/, validate: singleAddress } } },
      run: async (parameters, { run }) => {
        const address = parameters.address;
        const problem = singleAddress(address);
        if (problem) throw new Error(`The address ${problem}.`);
        const result = await run(client, ["set", "sshd", "unbanip", address], { timeout: 15_000 });
        const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
        // Older fail2ban refuses an address it has not banned; newer answers with how many bans it lifted.
        if (/not banned/i.test(said) || (result.ok && String(result.stdout ?? "").trim() === "0")) return { address, unbanned: false, note: `${address} was not banned, so there was nothing to lift.` };
        if (!result.ok) throw new Error(`fail2ban did not lift the ban on ${address}: ${tail(result.stderr) || tail(result.stdout) || "no reason given"}`);
        // Read the jail back rather than take the answer's word for it.
        const status = await run(client, ["status", "sshd"], { timeout: 15_000 });
        if (!status.ok) return { address, unbanned: true, note: `fail2ban accepted the unban, but the jail could not be read back to confirm it: ${tail(status.stderr) || "no reason given"}` };
        if (parseJailStatus(status.stdout).bannedAddresses.includes(address)) throw new Error(`fail2ban accepted the unban, but ${address} is still on the sshd jail's banned list.`);
        return { address, unbanned: true };
      },
    }),
  ];
}
