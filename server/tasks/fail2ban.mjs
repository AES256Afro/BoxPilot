import { access, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side fail2ban tasks executed by scripts/boxpilot-run.mjs.
 *
 * One managed jail file, /etc/fail2ban/jail.d/boxpilot.local, enables the sshd jail with
 * the owner's thresholds. Loopback, the tailnet, and the directly connected LAN subnets are
 * never banned, so a mistyped password at home cannot lock the owner out; the bans bite only
 * on traffic from elsewhere (a LAN-mode install with a forwarded port, a VPS). Ubuntu 24.04
 * has no auth.log, so the jail reads the journal.
 */

export const jailPath = "/etc/fail2ban/jail.d/boxpilot.local";
export const managedMarker = "# Managed by BoxPilot";
export const jails = Object.freeze(["sshd"]);

const binaries = {
  client: "/usr/bin/fail2ban-client",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  ip: "/usr/sbin/ip",
  ufw: "/usr/sbin/ufw",
};

export function validateFail2banConfig({ maxRetry = 5, findTimeMinutes = 10, banTimeMinutes = 60, ignoreLan = true } = {}) {
  if (!Number.isInteger(maxRetry) || maxRetry < 1 || maxRetry > 50) return "maxRetry must be a whole number between 1 and 50";
  if (!Number.isInteger(findTimeMinutes) || findTimeMinutes < 1 || findTimeMinutes > 1440) return "findTimeMinutes must be between 1 and 1440";
  if (!Number.isInteger(banTimeMinutes) || banTimeMinutes < 1 || banTimeMinutes > 43200) return "banTimeMinutes must be between 1 and 43200 (30 days)";
  if (typeof ignoreLan !== "boolean") return "ignoreLan must be true or false";
  return null;
}

/** Render the managed jail file. Pure. */
export function renderJail({ maxRetry = 5, findTimeMinutes = 10, banTimeMinutes = 60, ignoreLan = true, lanSubnets = [], ufwPresent = false } = {}) {
  const ignore = ["127.0.0.1/8", "::1", "100.64.0.0/10", ...(ignoreLan ? lanSubnets : [])];
  return [
    managedMarker,
    "# Edit from the BoxPilot Firewall page; manual changes here are overwritten on Apply.",
    "",
    "[DEFAULT]",
    `ignoreip = ${ignore.join(" ")}`,
    `bantime = ${banTimeMinutes}m`,
    `findtime = ${findTimeMinutes}m`,
    `maxretry = ${maxRetry}`,
    "backend = systemd",
    ...(ufwPresent ? ["banaction = ufw", "banaction_allports = ufw"] : []),
    "",
    "[sshd]",
    "enabled = true",
    "mode = aggressive",
    "",
  ].join("\n");
}

/** Parse the managed jail file back into settings. */
export function parseJail(content) {
  const text = String(content ?? "");
  const value = (key) => text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
  // fail2ban durations: a bare number is seconds; m/h/d suffixes are minutes, hours, days.
  const minutes = (raw) => { const match = String(raw ?? "").match(/^(\d+)([smhd]?)$/); if (!match) return null; const n = Number(match[1]); return match[2] === "m" ? n : match[2] === "h" ? n * 60 : match[2] === "d" ? n * 1440 : Math.round(n / 60); };
  const ignore = (value("ignoreip") ?? "").split(/\s+/).filter(Boolean);
  return {
    managed: text.startsWith(managedMarker),
    maxRetry: value("maxretry") ? Number(value("maxretry")) : null,
    findTimeMinutes: minutes(value("findtime")),
    banTimeMinutes: minutes(value("bantime")),
    ignoreLan: ignore.some((entry) => !["127.0.0.1/8", "::1", "100.64.0.0/10"].includes(entry)),
    ignore,
    sshd: /\[sshd\][\s\S]*?enabled\s*=\s*true/.test(text),
  };
}

async function lanSubnetsFrom(run) {
  const result = await run(binaries.ip, ["-j", "-4", "route", "show"], { timeout: 10_000 });
  if (!result.ok) throw new Error(`Could not read this server's own networks, so "never ban the LAN" could not be honoured: ${String(result.stderr ?? "").split("\n").filter(Boolean).slice(-1)[0] ?? "ip route failed"}`);
  try {
    return [...new Set(JSON.parse(result.stdout)
      .filter((route) => route.scope === "link" && typeof route.dst === "string" && route.dst.includes("/") && !/^(tailscale|docker|br-|virbr|veth|lo)/.test(route.dev ?? ""))
      .map((route) => route.dst))];
  } catch { throw new Error("This server's own networks could not be read, so \"never ban the LAN\" could not be honoured"); }
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

/** Write the jail, test the configuration, start fail2ban, verify the sshd jail is up. */
export async function fail2banApply({ enabled = true, maxRetry = 5, findTimeMinutes = 10, banTimeMinutes = 60, ignoreLan = true } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir, copyFile, unlink, access } } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  const problem = validateFail2banConfig({ maxRetry, findTimeMinutes, banTimeMinutes, ignoreLan });
  if (problem) throw new Error(`Invalid configuration: ${problem}`);
  const installed = await files.access(binaries.client).then(() => true, () => false);
  if (!installed) throw new Error("fail2ban is not installed; install it from the Firewall page first");
  if (!enabled) {
    await files.unlink(jailPath).catch(() => {});
    await run(binaries.systemctl, ["disable", "--now", "fail2ban"], { timeout: 60_000 });
    log?.("fail2ban stopped and disabled; the managed jail file was removed", "stdout");
    return { enabled: false };
  }
  const lanSubnets = ignoreLan ? await lanSubnetsFrom(run) : [];
  // Without a subnet to exempt, "never ban the LAN" is a promise the jail does not keep — and the
  // owner's own laptop can be banned for up to a month after a few mistyped passwords.
  if (ignoreLan && lanSubnets.length === 0) throw new Error("No local network was found to exempt, so brute-force protection was not applied. Turn off \"never ban my LAN\" to apply it anyway.");
  const ufwPresent = await files.access(binaries.ufw).then(() => true, () => false);
  const previous = await files.readFile(jailPath, "utf8").catch(() => null);
  await files.mkdir("/etc/fail2ban/jail.d", { recursive: true, mode: 0o755 });
  await files.writeFile(jailPath, renderJail({ maxRetry, findTimeMinutes, banTimeMinutes, ignoreLan, lanSubnets, ufwPresent }), { mode: 0o644 });
  const test = await run(binaries.client, ["-t"], { timeout: 60_000 });
  if (!test.ok) {
    if (previous !== null) await files.writeFile(jailPath, previous, { mode: 0o644 }); else await files.unlink(jailPath).catch(() => {});
    throw new Error(`fail2ban rejected the configuration (restored the previous one): ${tail(test.stderr) || tail(test.stdout)}`);
  }
  const enable = await run(binaries.systemctl, ["enable", "--now", "fail2ban"], { timeout: 60_000 });
  if (!enable.ok) throw new Error(`Could not start fail2ban: ${tail(enable.stderr)}`);
  await run(binaries.systemctl, ["reload-or-restart", "fail2ban"], { timeout: 60_000 });
  let status = null;
  for (let attempt = 0; attempt < 5 && !status; attempt += 1) {
    const probe = await run(binaries.client, ["status", "sshd"], { timeout: 15_000 });
    if (probe.ok && /Status for the jail: sshd/.test(probe.stdout)) status = probe.stdout;
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!status) throw new Error("fail2ban started but the sshd jail did not come up; check journalctl -u fail2ban");
  const banned = Number(status.match(/Currently banned:\s*(\d+)/)?.[1] ?? 0);
  log?.(`fail2ban is protecting SSH: ban after ${maxRetry} failures within ${findTimeMinutes} min for ${banTimeMinutes} min; never bans ${["loopback", "the tailnet", ...(lanSubnets.length ? [lanSubnets.join(", ")] : [])].join(", ")}`, "stdout");
  return { enabled: true, maxRetry, findTimeMinutes, banTimeMinutes, ignoreLan, ignored: ["127.0.0.1/8", "::1", "100.64.0.0/10", ...lanSubnets], banAction: ufwPresent ? "ufw" : "iptables", currentlyBanned: banned };
}
