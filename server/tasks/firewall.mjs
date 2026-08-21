import { readFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { buildPlan, defaultWebPort, isProtected, protectedRules } from "../firewall-profiles.mjs";

/**
 * Root-side ufw tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * iptables state lives in the host network namespace, which the helper's PrivateNetwork
 * hides, so every firewall change (and the fresh status read after it) happens here.
 *
 * Lockout protection is enforced here, not in the UI: SSH, Tailscale, and BoxPilot's own
 * port can never be denied and their allow rules can never be deleted (see
 * server/firewall-profiles.mjs). The web port comes from /etc/boxpilot/boxpilot.env.
 */

const ufw = "/usr/sbin/ufw";
export const defaultEnvPath = "/etc/boxpilot/boxpilot.env";
export const ruleActions = Object.freeze(["allow", "deny", "limit"]);
export const ruleProtocols = Object.freeze(["tcp", "udp", "any"]);
export const commentPattern = /^[A-Za-z0-9 ._-]{1,60}$/;

export function validateRule({ action, port, protocol, comment = null } = {}) {
  if (!ruleActions.includes(action)) return "action must be allow, deny, or limit";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be a whole number between 1 and 65535";
  if (!ruleProtocols.includes(protocol)) return "protocol must be tcp, udp, or any";
  if (comment !== null && (typeof comment !== "string" || !commentPattern.test(comment))) return "comment may use letters, digits, spaces, dot, underscore, hyphen (max 60)";
  return null;
}

/** BOXPILOT_PORT / BOXPILOT_HOST from the service env file; defaults match server/index.mjs. */
export async function readWebEnv({ envPath = defaultEnvPath, read = (file) => readFile(file, "utf8") } = {}) {
  let content = "";
  try { content = await read(envPath); } catch { /* defaults below */ }
  const value = (name) => content.match(new RegExp(`^${name}=["']?([^"'\\n]*)["']?\\s*$`, "m"))?.[1]?.trim();
  const port = Number.parseInt(value("BOXPILOT_PORT") ?? "", 10);
  return { webPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultWebPort, webHost: value("BOXPILOT_HOST") || "127.0.0.1" };
}

function ruleSpec({ port, protocol }) {
  return protocol === "any" ? String(port) : `${port}/${protocol}`;
}

async function statusLines(run) {
  const result = await run(ufw, ["status", "verbose"], { timeout: 30_000 });
  return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}

function tail(text) {
  return String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
}

/** Add every protected allow rule; SSH failing aborts, the rest are best-effort. */
async function ensureProtected(run, log, { webPort, webHost }) {
  for (const entry of protectedRules({ webPort, webHost })) {
    if (!entry.allow) continue;
    const result = await run(ufw, ["allow", ruleSpec(entry), "comment", `BoxPilot keeps ${entry.label} reachable`], { timeout: 30_000 });
    if (!result.ok && entry.port === 22) throw new Error(`Could not add the SSH rule: ${tail(result.stderr)}`);
    if (!result.ok) log?.(`${entry.label} rule (${ruleSpec(entry)}) not added (${tail(result.stderr)}); continuing`, "stderr");
  }
  const tailnet = await run(ufw, ["allow", "in", "on", "tailscale0", "comment", "BoxPilot keeps the tailnet reachable"], { timeout: 30_000 });
  if (!tailnet.ok) log?.(`tailscale0 rule not added (${tail(tailnet.stderr)}); continuing`, "stderr");
}

/** Keep SSH, Tailscale, BoxPilot, and the tailnet reachable, then flip the firewall. Disable never needs guards. */
export async function firewallSet({ enabled } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  if (enabled) {
    log?.("Ensuring SSH, Tailscale, BoxPilot, and tailscale0 stay reachable before enabling", "stdout");
    await ensureProtected(run, log, await readWebEnv({ envPath }));
  }
  log?.(`$ ufw --force ${enabled ? "enable" : "disable"}`, "stdout");
  const result = await run(ufw, ["--force", enabled ? "enable" : "disable"], { timeout: 60_000 });
  if (!result.ok) throw new Error(`ufw ${enabled ? "enable" : "disable"} failed: ${tail(result.stderr)}`);
  return { enabled, status: await statusLines(run) };
}

export async function firewallRuleAdd({ action, port, protocol, comment = null } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath } = {}) {
  const problem = validateRule({ action, port, protocol, comment });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  if (action === "deny") {
    const protectedList = protectedRules(await readWebEnv({ envPath }));
    const hit = protectedList.find((entry) => isProtected({ port, protocol }, [entry]));
    if (hit) throw new Error(`Port ${port} stays open: it is ${hit.label}. ${hit.reason} Denying it could lock you out.`);
  }
  const args = [action, ruleSpec({ port, protocol }), ...(comment ? ["comment", comment] : [])];
  log?.(`$ ufw ${args.join(" ")}`, "stdout");
  const result = await run(ufw, args, { timeout: 30_000 });
  if (!result.ok) throw new Error(`ufw rejected the rule: ${tail(result.stderr)}`);
  return { action, port, protocol, comment, status: await statusLines(run) };
}

export async function firewallRuleDelete({ action, port, protocol } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath } = {}) {
  const problem = validateRule({ action, port, protocol });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  if (action !== "deny") {
    const protectedList = protectedRules(await readWebEnv({ envPath }));
    const hit = protectedList.find((entry) => isProtected({ port, protocol }, [entry]));
    if (hit) throw new Error(`The ${hit.label} rule stays; removing it from here could lock you out`);
  }
  const args = ["--force", "delete", action, ruleSpec({ port, protocol })];
  log?.(`$ ufw ${args.join(" ")}`, "stdout");
  const result = await run(ufw, args, { timeout: 30_000 });
  if (!result.ok) throw new Error(`ufw could not delete the rule: ${tail(result.stderr)}`);
  if (/Could not delete non-existent rule/i.test(result.stdout)) throw new Error("That rule does not exist any more; refresh and try again");
  return { deleted: { action, port, protocol }, status: await statusLines(run) };
}

/**
 * Apply a profile: the exact argv list comes from buildPlan() so the preview the owner
 * approved is what runs. Any required step failing stops before `ufw enable`, so a failed
 * apply leaves the firewall no more closed than before.
 */
export async function firewallProfileApply({ profile, services = [], replace = false, sshRateLimit = false } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath, now = () => new Date() } = {}) {
  if (!Array.isArray(services) || services.some((id) => typeof id !== "string")) throw new Error("services must be a list of service ids");
  if (typeof replace !== "boolean" || typeof sshRateLimit !== "boolean") throw new Error("replace and sshRateLimit must be true or false");
  const env = await readWebEnv({ envPath });
  const plan = buildPlan({ profileId: profile, serviceIds: services, replace, sshRateLimit, ...env });
  log?.(`Applying firewall profile "${plan.profile.name}" (${plan.steps.length} steps)`, "stdout");
  const completed = [];
  for (const step of plan.steps) {
    log?.(`$ ufw ${step.args.join(" ")}  # ${step.label}`, "stdout");
    const result = await run(ufw, step.args, { timeout: 60_000 });
    if (result.ok) { completed.push(step.label); continue; }
    if (step.tolerateFailure) { log?.(`${step.label}: ${tail(result.stderr) || "skipped"}; continuing`, "stderr"); continue; }
    const enabling = step.args.includes("enable");
    throw new Error(`${step.label} failed: ${tail(result.stderr) || tail(result.stdout) || "ufw returned an error"}${enabling ? "" : ". Stopped before turning the firewall on, so nothing new is blocked"}`);
  }
  return { profile: plan.profile.id, services: plan.services, replace, sshRateLimit, steps: completed, appliedAt: now().toISOString(), status: await statusLines(run) };
}
