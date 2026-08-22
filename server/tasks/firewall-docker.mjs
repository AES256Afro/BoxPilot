/**
 * Make ufw's decisions apply to Docker-published ports.
 *
 * Docker forwards published ports through its own iptables chains (nat PREROUTING → filter
 * FORWARD → DOCKER), which ufw's INPUT rules never see, so a "deny incoming" firewall still
 * left every catalog app reachable from the LAN. This module maintains a `boxpilot-docker`
 * chain, jumped to from the top of DOCKER-USER, that lets loopback, the tailnet, container
 * traffic, and established flows through and then mirrors ufw's port rules against the
 * original (pre-DNAT) destination port. The rules live in a managed block of
 * /etc/ufw/after.rules so `ufw reload` and boot re-apply them; turning ufw off removes the
 * chain so Docker ports behave like everything else. IPv4 only: Docker's IPv6 publishing is
 * off by default and ufw keeps IPv6 in after6.rules.
 *
 * Runs inside boxpilot-run@ (host network namespace); the helper cannot see iptables.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

export const afterRulesPath = "/etc/ufw/after.rules";
export const chainName = "boxpilot-docker";
export const beginMarker = "# BEGIN BOXPILOT DOCKER RULES (managed by BoxPilot; edits here are overwritten)";
export const endMarker = "# END BOXPILOT DOCKER RULES";
const iptables = "/usr/sbin/iptables";
const ufw = "/usr/sbin/ufw";

function tail(text) {
  return String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
}

/**
 * Read what `ufw status verbose` says: default incoming policy plus the port rules
 * (optionally source-restricted). Interface rules, IPv6 rows, and anything that is not a
 * plain port are ignored — the chain handles loopback and the tailnet itself.
 */
export function parseUfwStatus(output) {
  const lines = Array.isArray(output) ? output : String(output ?? "").split("\n");
  const status = { active: false, defaultIncoming: "deny", allowed: [], denied: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Status:\s*active/i.test(line)) status.active = true;
    const policy = line.match(/^Default:\s*(allow|deny|reject)\s*\(incoming\)/i);
    if (policy) status.defaultIncoming = policy[1].toLowerCase() === "allow" ? "allow" : "deny";
    const rule = line.match(/^(\d{1,5})(?:\/(tcp|udp))?\s+(ALLOW|LIMIT|DENY|REJECT)\s+IN\s+(.+)$/i);
    if (!rule) continue;
    const port = Number(rule[1]);
    if (!(port >= 1 && port <= 65535)) continue;
    const source = rule[4].trim();
    let from = null;
    if (!/^Anywhere$/i.test(source)) {
      const cidr = source.match(/^(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)$/);
      if (!cidr) continue; // IPv6 rows, interface-scoped rows, and odd sources are not mirrored
      from = cidr[1];
    }
    const target = /^(ALLOW|LIMIT)$/i.test(rule[3]) ? status.allowed : status.denied;
    for (const protocol of rule[2] ? [rule[2].toLowerCase()] : ["tcp", "udp"]) {
      if (!target.some((entry) => entry.port === port && entry.protocol === protocol && entry.from === from)) target.push({ port, protocol, from });
    }
  }
  return status;
}

/** The managed after.rules block for a parsed ufw status. */
export function renderDockerRules({ defaultIncoming = "deny", allowed = [], denied = [] } = {}) {
  const rule = (entry, target) => `-A ${chainName} -p ${entry.protocol}${entry.from ? ` -s ${entry.from}` : ""} -m conntrack --ctorigdstport ${entry.port} --ctdir ORIGINAL -j ${target}`;
  const lines = [
    beginMarker,
    "*filter",
    ":DOCKER-USER - [0:0]",
    `:${chainName} - [0:0]`,
    `-I DOCKER-USER 1 -j ${chainName}`,
    `-A ${chainName} -i lo -j RETURN`,
    `-A ${chainName} -i tailscale0 -j RETURN`,
    `-A ${chainName} -i docker0 -j RETURN`,
    `-A ${chainName} -i br-+ -j RETURN`,
    `-A ${chainName} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`,
    ...denied.map((entry) => rule(entry, "DROP")),
  ];
  if (defaultIncoming === "allow") lines.push(`-A ${chainName} -j RETURN`);
  else lines.push(...allowed.map((entry) => rule(entry, "RETURN")), `-A ${chainName} -j DROP`);
  lines.push("COMMIT", endMarker);
  return `${lines.join("\n")}\n`;
}

/** Replace (or remove, when block is null) the managed block in an after.rules file. */
export function spliceManagedBlock(text, block) {
  const source = String(text ?? "");
  const start = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  let base = source;
  if (start >= 0 && end > start) base = source.slice(0, start) + source.slice(end + endMarker.length);
  base = `${base.replace(/\s+$/, "")}\n`;
  return block ? `${base}\n${block}` : base;
}

/**
 * Bring the chain in line with ufw. With enabled=false the block and chain are removed.
 * A rejected ruleset is backed out before the error surfaces, so ufw stays up either way.
 */
export async function syncDockerRules({ enabled } = {}, { run = fixedRun, log = null, path = afterRulesPath, read = (file) => readFile(file, "utf8"), write = (file, content) => writeFile(file, content, { mode: 0o640 }) } = {}) {
  const current = await read(path).catch(() => null);
  if (current === null) {
    log?.(`${path} is missing, so Docker-published ports are not filtered`, "stderr");
    return { synced: false, reason: "after-rules-missing" };
  }
  const detach = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const removed = await run(iptables, ["-D", "DOCKER-USER", "-j", chainName], { timeout: 15_000 });
      if (!removed.ok) break;
    }
    await run(iptables, ["-F", chainName], { timeout: 15_000 });
    await run(iptables, ["-X", chainName], { timeout: 15_000 });
  };
  if (!enabled) {
    const next = spliceManagedBlock(current, null);
    if (next !== current) await write(path, next);
    await detach();
    log?.("Docker-published ports are no longer filtered while the firewall is off", "stdout");
    return { synced: true, enabled: false };
  }
  const status = parseUfwStatus((await run(ufw, ["status", "verbose"], { timeout: 30_000 })).stdout);
  const next = spliceManagedBlock(current, renderDockerRules(status));
  if (next !== current) await write(path, next);
  await detach();
  log?.("$ ufw reload  # load the Docker rules", "stdout");
  const reload = await run(ufw, ["reload"], { timeout: 60_000 });
  if (!reload.ok) {
    await write(path, current).catch(() => {});
    await detach();
    await run(ufw, ["reload"], { timeout: 60_000 });
    throw new Error(`ufw rejected the Docker rules, so they were backed out and the firewall kept its previous rules: ${tail(reload.stderr) || tail(reload.stdout)}`);
  }
  const summary = status.defaultIncoming === "allow"
    ? `everything except ${status.denied.length} denied port(s)`
    : `${status.allowed.length} allowed port(s)`;
  log?.(`Docker-published ports now follow the firewall: ${summary} reachable from the LAN; this server and the tailnet always are`, "stdout");
  return { synced: true, enabled: true, defaultIncoming: status.defaultIncoming, allowed: status.allowed, denied: status.denied };
}

/** True when the managed block is present in an after.rules file's text. */
export function hasDockerRules(text) {
  const source = String(text ?? "");
  return source.includes(beginMarker) && source.includes(endMarker);
}
