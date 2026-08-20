import { fixedRun } from "../exec.mjs";

/**
 * Root-side ufw tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * iptables state lives in the host network namespace, which the helper's PrivateNetwork
 * hides, so every firewall change (and the fresh status read after it) happens here.
 */

const ufw = "/usr/sbin/ufw";
export const ruleActions = Object.freeze(["allow", "deny"]);
export const ruleProtocols = Object.freeze(["tcp", "udp", "any"]);
export const commentPattern = /^[A-Za-z0-9 ._-]{1,60}$/;

export function validateRule({ action, port, protocol, comment = null } = {}) {
  if (!ruleActions.includes(action)) return "action must be allow or deny";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be a whole number between 1 and 65535";
  if (!ruleProtocols.includes(protocol)) return "protocol must be tcp, udp, or any";
  if (comment !== null && (typeof comment !== "string" || !commentPattern.test(comment))) return "comment may use letters, digits, spaces, dot, underscore, hyphen (max 60)";
  return null;
}

function ruleSpec({ port, protocol }) {
  return protocol === "any" ? String(port) : `${port}/${protocol}`;
}

async function statusLines(run) {
  const result = await run(ufw, ["status", "verbose"], { timeout: 30_000 });
  return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Keep SSH and the tailnet reachable, then flip the firewall. Disable never needs guards. */
export async function firewallSet({ enabled } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  if (enabled) {
    log?.("Ensuring SSH and tailscale0 stay reachable before enabling", "stdout");
    const ssh = await run(ufw, ["allow", "22/tcp", "comment", "BoxPilot keeps SSH reachable"], { timeout: 30_000 });
    if (!ssh.ok) throw new Error(`Could not add the SSH rule: ${ssh.stderr.split("\n").slice(-2).join(" ")}`);
    const tailnet = await run(ufw, ["allow", "in", "on", "tailscale0", "comment", "BoxPilot keeps the tailnet reachable"], { timeout: 30_000 });
    if (!tailnet.ok) log?.(`tailscale0 rule not added (${tailnet.stderr.split("\n").at(-1)}); continuing`, "stderr");
  }
  log?.(`$ ufw --force ${enabled ? "enable" : "disable"}`, "stdout");
  const result = await run(ufw, ["--force", enabled ? "enable" : "disable"], { timeout: 60_000 });
  if (!result.ok) throw new Error(`ufw ${enabled ? "enable" : "disable"} failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { enabled, status: await statusLines(run) };
}

export async function firewallRuleAdd({ action, port, protocol, comment = null } = {}, { run = fixedRun, log = null } = {}) {
  const problem = validateRule({ action, port, protocol, comment });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  const args = [action, ruleSpec({ port, protocol }), ...(comment ? ["comment", comment] : [])];
  log?.(`$ ufw ${args.join(" ")}`, "stdout");
  const result = await run(ufw, args, { timeout: 30_000 });
  if (!result.ok) throw new Error(`ufw rejected the rule: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { action, port, protocol, comment, status: await statusLines(run) };
}

export async function firewallRuleDelete({ action, port, protocol } = {}, { run = fixedRun, log = null } = {}) {
  const problem = validateRule({ action, port, protocol });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  if (port === 22) throw new Error("The SSH rule stays; removing it from here could lock you out");
  const args = ["--force", "delete", action, ruleSpec({ port, protocol })];
  log?.(`$ ufw ${args.join(" ")}`, "stdout");
  const result = await run(ufw, args, { timeout: 30_000 });
  if (!result.ok) throw new Error(`ufw could not delete the rule: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  if (/Could not delete non-existent rule/i.test(result.stdout)) throw new Error("That rule does not exist any more; refresh and try again");
  return { deleted: { action, port, protocol }, status: await statusLines(run) };
}
