import { copyFile, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { envFileValue, webListenFromEnv } from "../env-file.mjs";
import { buildPlan, isProtected, mergeRuleFamilies, parseUserRules, protectedRules, removalKey, ruleTarget, sourcesFor, sshPortsFromSshdT } from "../firewall-profiles.mjs";
import { tlsPortOf } from "../tls-listener.mjs";
import { syncDockerRules } from "./firewall-docker.mjs";

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
const sshd = "/usr/sbin/sshd";
const ufwDirectory = "/etc/ufw";
export const defaultEnvPath = "/etc/boxpilot/boxpilot.env";
export const ruleActions = Object.freeze(["allow", "deny", "limit"]);
export const ruleProtocols = Object.freeze(["tcp", "udp", "any"]);
export const commentPattern = /^[A-Za-z0-9 ._-]{1,60}$/;

/** An IPv6 address as a 128-bit number, or null; written without an embedded IPv4 part. */
function ipv6Number(address) {
  if (address.includes(".")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (text) => (text === "" ? [] : text.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return all.reduce((number, group) => (number << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

/**
 * Where a rule lets traffic in from (M90): one address or a network range, IPv4 or IPv6, and nothing
 * else — no names, no "any", no list. "Anywhere" is no source at all, so 0.0.0.0/0 and ::/0 are
 * refused rather than being a second way to say it (ufw would write them for one family only). A
 * range must be its network address (192.168.1.0/24, not 192.168.1.5/24; fd00::/64, not fd00::1/64):
 * ufw rewrites the other spelling, and a delete naming it would then match nothing.
 *
 * M90 review: the unspecified address on its own (0.0.0.0, ::) is refused too, as is an IPv4-mapped
 * IPv6 address (::ffff:10.0.0.0/104), which is an IPv4 range in the wrong family, and a prefix
 * length written with leading zeros (/032), which is not how ufw writes it back.
 * @returns {string | null} what is wrong, or null
 */
export function sourceProblem(value) {
  const words = "source must be an address or range such as 192.168.1.0/24";
  if (typeof value !== "string" || value.length > 64) return words;
  const [address, prefixText, ...rest] = value.split("/");
  if (rest.length) return words;
  const family = net.isIP(address);
  if (family === 0 || (family === 6 && address.includes("%"))) return words;
  const number = family === 4
    ? BigInt(address.split(".").reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0))
    : ipv6Number(address);
  if (number === null) return "write an IPv4 range in IPv4, such as 192.168.1.0/24";
  const bits = family === 4 ? 32 : 128;
  if (family === 6 && (number >> 32n) === 0xffffn) return "write an IPv4 range in IPv4, such as 192.168.1.0/24";
  if (number === 0n) return "for anywhere, leave the source out";
  if (prefixText === undefined) return null;
  if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return words;
  const prefix = Number(prefixText);
  if (prefix === 0) return "for anywhere, leave the source out";
  if (prefix > bits) return words;
  const hostBits = BigInt(bits - prefix);
  if (number & ((1n << hostBits) - 1n)) {
    return family === 4 ? "an IPv4 range must start at its network address, such as 192.168.1.0/24" : "an IPv6 range must start at its network address, such as fd00::/64";
  }
  return null;
}

/** @param {{ action?: string, port?: number, protocol?: string, comment?: string | null, source?: string | null }} [rule] */
export function validateRule({ action, port, protocol, comment = null, source = null } = {}) {
  if (!ruleActions.includes(action)) return "action must be allow, deny, or limit";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be a whole number between 1 and 65535";
  if (!ruleProtocols.includes(protocol)) return "protocol must be tcp, udp, or any";
  if (comment !== null && (typeof comment !== "string" || !commentPattern.test(comment))) return "comment may use letters, digits, spaces, dot, underscore, hyphen (max 60)";
  if (source !== null && sourceProblem(source)) return sourceProblem(source);
  return null;
}

/** The rules as the Firewall page reads them, for the plan to work out what a profile closes. */
async function readExistingRules(directory, read) {
  const [v4, v6] = await Promise.all(["user.rules", "user6.rules"].map((name) => Promise.resolve().then(() => read(path.join(directory, name))).catch(() => "")));
  return mergeRuleFamilies(parseUserRules(v4, "v4"), parseUserRules(v6, "v6"));
}

/**
 * BOXPILOT_PORT / BOXPILOT_HOST from the service env file, read as systemd reads it (the last line
 * for a key wins, blanks around "=" are allowed); defaults match server/index.mjs.
 */
export async function readWebEnv({ envPath = defaultEnvPath, read = (file) => readFile(file, "utf8") } = {}) {
  let content = "";
  try { content = await read(envPath); } catch { /* defaults below */ }
  return webListenFromEnv(content);
}

/**
 * What the protected list is built from (M90 review): the web port and host, and the HTTPS port
 * while a certificate is set — BOXPILOT_TLS_CERT and _KEY, as web-tls writes them and the web
 * process (tls-listener.mjs) and web-bind read them. Null when there is no certificate.
 */
async function readListenEnv({ envPath = defaultEnvPath, read = (file) => readFile(file, "utf8") } = {}) {
  let content = "";
  try { content = await read(envPath); } catch { /* defaults below */ }
  const tlsPort = envFileValue(content, "BOXPILOT_TLS_CERT") && envFileValue(content, "BOXPILOT_TLS_KEY") ? tlsPortOf(envFileValue(content, "BOXPILOT_TLS_PORT")) : null;
  return { ...webListenFromEnv(content), tlsPort };
}

/**
 * The ports sshd listens on, from `sshd -T` (M90 review). Null when it cannot be read: the caller
 * then keeps 22 and closes nothing that could be SSH's (firewall-profiles.mjs closingRules).
 * @returns {Promise<number[] | null>}
 */
async function readSshPorts(run, log) {
  const result = await Promise.resolve(run(sshd, ["-T"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).catch((error) => ({ ok: false, stdout: "", stderr: error.message }));
  const ports = result.ok ? sshPortsFromSshdT(result.stdout) : null;
  if (!ports) log?.(`The SSH port could not be read from sshd -T (${tail(result.stderr) || "no port in its output"}); keeping 22 and every rule that could be SSH's`, "stderr");
  return ports;
}

function ruleSpec({ port, protocol }) {
  return protocol === "any" ? String(port) : `${port}/${protocol}`;
}

async function statusLines(run) {
  const result = await run(ufw, ["status", "verbose"], { timeout: 30_000 });
  return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Rule changes only need the Docker chain refreshed while ufw is on; off means unfiltered anyway. */
async function syncIfActive(status, dockerSync, run, log) {
  const active = status.some((line) => /^Status:\s*active/i.test(line));
  return dockerSync({ enabled: active }, { run, log });
}

function tail(text) {
  return String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
}

/** Add every protected allow rule; SSH failing aborts, the rest are best-effort. */
async function ensureProtected(run, log, { webPort, webHost, tlsPort = null }) {
  const sshPorts = await readSshPorts(run, log);
  for (const entry of protectedRules({ webPort, webHost, tlsPort, sshPorts })) {
    if (!entry.allow) continue;
    const result = await run(ufw, ["allow", ruleSpec(entry), "comment", `BoxPilot keeps ${entry.label} reachable`], { timeout: 30_000 });
    if (!result.ok && entry.kind === "ssh") throw new Error(`Could not add the SSH rule (${ruleSpec(entry)}): ${tail(result.stderr)}`);
    if (!result.ok) log?.(`${entry.label} rule (${ruleSpec(entry)}) not added (${tail(result.stderr)}); continuing`, "stderr");
  }
  const tailnet = await run(ufw, ["allow", "in", "on", "tailscale0", "comment", "BoxPilot keeps the tailnet reachable"], { timeout: 30_000 });
  if (!tailnet.ok) log?.(`tailscale0 rule not added (${tail(tailnet.stderr)}); continuing`, "stderr");
}

/**
 * Keep SSH, Tailscale, BoxPilot, and the tailnet reachable, then flip the firewall. Disable never needs guards.
 * @param {{ enabled?: boolean }} [parameters]
 */
export async function firewallSet({ enabled } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath, dockerSync = syncDockerRules } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  if (enabled) {
    log?.("Ensuring SSH, Tailscale, BoxPilot, and tailscale0 stay reachable before enabling", "stdout");
    await ensureProtected(run, log, await readListenEnv({ envPath }));
  }
  log?.(`$ ufw --force ${enabled ? "enable" : "disable"}`, "stdout");
  const result = await run(ufw, ["--force", enabled ? "enable" : "disable"], { timeout: 60_000 });
  if (!result.ok) throw new Error(`ufw ${enabled ? "enable" : "disable"} failed: ${tail(result.stderr)}`);
  const docker = await dockerSync({ enabled }, { run, log });
  return { enabled, docker, status: await statusLines(run) };
}

/**
 * The protected entry a rule would hit, or null. The env file's list (22, Tailscale, the web and
 * HTTPS ports) is checked first, so a refusal there runs nothing; only then is sshd asked for its
 * port, so a deny on (or a delete of) an SSH port other than 22 is refused too (M90 review).
 */
async function protectedHit(rule, { envPath, run, log }) {
  const env = await readListenEnv({ envPath });
  const hit = protectedRules(env).find((entry) => isProtected(rule, [entry]));
  if (hit) return hit;
  return protectedRules({ ...env, sshPorts: await readSshPorts(run, log) }).find((entry) => isProtected(rule, [entry])) ?? null;
}

/**
 * Add one rule, from anywhere or (M90) from one source: `ufw allow from 192.168.1.0/24 to any port
 * 8096 proto tcp`. The tailnet is written in both its families; the second failing (ufw with IPv6
 * off) is logged, not fatal, since the one asked for is in.
 * @param {{ action?: string, port?: number, protocol?: string, comment?: string | null, source?: string | null }} [parameters]
 */
export async function firewallRuleAdd({ action, port, protocol, comment = null, source = null } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath, dockerSync = syncDockerRules } = {}) {
  const problem = validateRule({ action, port, protocol, comment, source });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  if (action === "deny") {
    const hit = await protectedHit({ port, protocol }, { envPath, run, log });
    if (hit) throw new Error(`Port ${port} stays open: it is ${hit.label}. ${hit.reason} Denying it could lock you out.`);
  }
  const added = [];
  for (const from of source ? sourcesFor(source) : [null]) {
    const args = [action, ...ruleTarget({ port, protocol, source: from }), ...(comment ? ["comment", comment] : [])];
    log?.(`$ ufw ${args.join(" ")}`, "stdout");
    const result = await run(ufw, args, { timeout: 30_000 });
    if (result.ok) { added.push(from); continue; }
    if (from !== source) { log?.(`The rule from ${from} was not added (${tail(result.stderr)}); the one from ${source} is in`, "stderr"); continue; }
    throw new Error(`ufw rejected the rule: ${tail(result.stderr)}`);
  }
  const status = await statusLines(run);
  const docker = await syncIfActive(status, dockerSync, run, log);
  return { action, port, protocol, comment, source, sources: source ? added : null, docker, status };
}

/**
 * Delete one rule by the same words an add wrote it with (ruleTarget), so a rule from one source is
 * reachable (M90). For the tailnet the other family's rule goes too, when it is there.
 * @param {{ action?: string, port?: number, protocol?: string, source?: string | null }} [parameters]
 */
export async function firewallRuleDelete({ action, port, protocol, source = null } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath, dockerSync = syncDockerRules } = {}) {
  const problem = validateRule({ action, port, protocol, source });
  if (problem) throw new Error(`Invalid rule: ${problem}`);
  if (action !== "deny") {
    const hit = await protectedHit({ port, protocol }, { envPath, run, log });
    if (hit) throw new Error(`The ${hit.label} rule stays; removing it from here could lock you out`);
  }
  const deleted = [];
  for (const from of source ? sourcesFor(source) : [null]) {
    const args = ["--force", "delete", action, ...ruleTarget({ port, protocol, source: from })];
    log?.(`$ ufw ${args.join(" ")}`, "stdout");
    const result = await run(ufw, args, { timeout: 30_000 });
    const missing = result.ok && /Could not delete non-existent rule/i.test(result.stdout);
    if (result.ok && !missing) { deleted.push(from); continue; }
    if (from !== source) { log?.(`No rule from ${from} was deleted (${missing ? "there was none" : tail(result.stderr)})`, "stderr"); continue; }
    if (!result.ok) throw new Error(`ufw could not delete the rule: ${tail(result.stderr)}`);
    throw new Error("That rule does not exist any more; refresh and try again");
  }
  const status = await statusLines(run);
  const docker = await syncIfActive(status, dockerSync, run, log);
  return { deleted: { action, port, protocol, source, ...(source ? { sources: deleted } : {}) }, docker, status };
}

/** A removal in words: `allow 8443/tcp`, `limit 2222/tcp from 192.168.1.0/24`. */
function ruleWords({ action, port, protocol, source = null }) {
  return `${action} ${ruleSpec({ port, protocol: protocol ?? "any" })}${source ? ` from ${source}` : ""}`;
}

/**
 * Add back the rules a failed apply had already closed (M90 review), each with the words a delete
 * named it by and its original comment, and say what happened to each.
 * @returns {Promise<{ text: string, reopened: string[], notReopened: string[] }>}
 */
async function reopenClosed(closedSteps, run, log) {
  const reopened = [];
  const notReopened = [];
  for (const { removes } of closedSteps) {
    const args = [removes.action, ...ruleTarget({ port: removes.port, protocol: removes.protocol ?? "any", source: removes.source ?? null }), ...(removes.comment ? ["comment", removes.comment] : [])];
    log?.(`$ ufw ${args.join(" ")}  # put back a rule this apply had closed`, "stdout");
    const result = await Promise.resolve(run(ufw, args, { timeout: 60_000 })).catch((error) => ({ ok: false, stdout: "", stderr: error.message }));
    if (result.ok) reopened.push(ruleWords(removes));
    else { notReopened.push(ruleWords(removes)); log?.(`${ruleWords(removes)} could not be put back: ${tail(result.stderr) || "ufw returned an error"}`, "stderr"); }
  }
  if (!reopened.length && !notReopened.length) return { text: "", reopened, notReopened };
  const closedList = [...reopened, ...notReopened].join(", ");
  const text = notReopened.length === 0
    ? ` It had closed ${closedList} first; ${reopened.length === 1 ? "that rule was" : "those rules were"} put back.`
    : reopened.length === 0
      ? ` It had closed ${closedList} first, and could not put ${notReopened.length === 1 ? "it" : "them"} back: add ${notReopened.length === 1 ? "it" : "them"} again on the Rules tab.`
      : ` It had closed ${closedList} first; ${reopened.join(", ")} ${reopened.length === 1 ? "was" : "were"} put back, but ${notReopened.join(", ")} could not be: add ${notReopened.length === 1 ? "it" : "them"} again on the Rules tab.`;
  return { text, reopened, notReopened };
}

/** The files `ufw --force reset` overwrites; copied aside so a failed apply can put them back. */
const resetFiles = ["user.rules", "user6.rules", "ufw.conf", "before.rules", "before6.rules", "after.rules", "after6.rules"];

/**
 * Of those, the ones that are not the owner's rule list: hand-written NAT or forwarding, and the
 * BoxPilot Docker block. "Start from scratch" clears rules, so these go back straight after the reset.
 */
const keptThroughReset = new Set(["before.rules", "before6.rules", "after.rules", "after6.rules"]);

/**
 * Apply a profile: the exact argv list comes from buildPlan() so the preview the owner
 * approved is what runs. Any required step failing stops before `ufw enable`, so a failed
 * apply leaves the firewall no more closed than before.
 *
 * "Start from scratch" resets ufw before the new rules are added, and a step failing after that
 * point would otherwise leave the owner with no rules at all and the firewall off. The files the
 * reset overwrites are copied aside first and put back if anything fails. The firewall is turned
 * back on only if it was on before: on a box that ran without one, the old rules may not let SSH in.
 *
 * M90 review: without "start from scratch" nothing is copied aside, and the deletions run straight
 * after the protected rules, live on a firewall that is already on. So:
 *  - `closes` is the list of removals the owner saw in the preview. The plan is rebuilt here from the
 *    rules and env file as they are now; if it would delete anything the preview did not list, the
 *    apply refuses before running a step and asks for a fresh review. Left out, nothing may close.
 *  - when a step fails, each rule already closed is added back (same words, same comment), and the
 *    error says what was closed, what was put back and what could not be.
 * @param {{ profile?: string, services?: string[], replace?: boolean, sshRateLimit?: boolean, closes?: Array<{ action: string, port: number, protocol: string, source?: string | null }> | null }} [parameters]
 */
export async function firewallProfileApply({ profile, services = [], replace = false, sshRateLimit = false, closes = null } = {}, { run = fixedRun, log = null, envPath = defaultEnvPath, now = () => new Date(), dockerSync = syncDockerRules, ufwDirectory: rulesDirectory = ufwDirectory, readEnv = undefined, readRules = (file) => readFile(file, "utf8") } = {}) {
  if (!Array.isArray(services) || services.some((id) => typeof id !== "string")) throw new Error("services must be a list of service ids");
  if (typeof replace !== "boolean" || typeof sshRateLimit !== "boolean") throw new Error("replace and sshRateLimit must be true or false");
  if (closes !== null && (!Array.isArray(closes) || closes.some((entry) => !entry || typeof entry !== "object"))) throw new Error("closes must be the list of rules the preview showed closing");
  // Unknown profiles and services are refused before anything runs, sshd included.
  buildPlan({ profileId: profile, serviceIds: services, replace });
  const env = await readListenEnv({ envPath, ...(readEnv ? { read: readEnv } : {}) });
  const sshPorts = await readSshPorts(run, log);
  // M90: the rules in place now, read as the page reads them, so the plan closes what the new
  // choice no longer keeps — the same deletions the preview listed from the same files.
  const existing = replace ? [] : await readExistingRules(rulesDirectory, readRules);
  const plan = buildPlan({ profileId: profile, serviceIds: services, replace, sshRateLimit, ...env, sshPorts, existing });
  const previewed = new Set((closes ?? []).map((entry) => removalKey(entry)));
  const unseen = plan.steps.filter((step) => step.removes && !previewed.has(removalKey(step.removes)));
  if (unseen.length) {
    throw new Error(`Nothing was changed: applying ${plan.profile.name} now would also close ${unseen.map((step) => ruleWords(step.removes)).join(", ")}, which the preview did not show. The rules or settings changed since it was built; review the profile again.`);
  }
  log?.(`Applying firewall profile "${plan.profile.name}" (${plan.steps.length} steps)`, "stdout");
  const completed = [];
  const saved = [];
  let wasEnabled = false;
  if (replace) {
    const before = await run(ufw, ["status"], { timeout: 30_000 });
    wasEnabled = before.ok && /^Status:\s*active/im.test(before.stdout);
    if (!before.ok) log?.(`Could not tell whether the firewall is on (${tail(before.stderr) || "ufw returned an error"}); if this apply fails it is left off`, "stderr");
    for (const name of resetFiles) {
      const source = path.join(rulesDirectory, name);
      const copy = `${source}.boxpilot-pre`;
      if (await copyFile(source, copy).then(() => true, () => false)) saved.push({ name, source, copy });
    }
    log?.(`Copied ${saved.length} rule file(s) aside so they can be put back if this fails`, "stdout");
  }
  /** Rule files whose put-back failed: their copies are kept, so the owner still has them. */
  const notPutBack = new Set();
  const putBack = async (reason) => {
    if (!saved.length) return "";
    // M73: each copy's outcome is recorded and the message is worded from it. It used to say
    // "Your previous rules were put back" whether or not the copies went back.
    for (const { name, source, copy } of saved) {
      await copyFile(copy, source).catch((error) => { notPutBack.add(name); log?.(`${name} could not be put back: ${error.message}`, "stderr"); });
    }
    const failed = saved.filter(({ name }) => notPutBack.has(name)).map(({ name }) => name);
    const rules = failed.length === 0 ? " Your previous rules were put back"
      : failed.length === saved.length ? ` Your previous rules could not be put back; copies are kept in ${rulesDirectory} as *.boxpilot-pre`
        : ` Your previous rules were put back except ${failed.join(", ")}, which could not be copied back; copies are kept in ${rulesDirectory} as *.boxpilot-pre`;
    if (!wasEnabled) {
      // The reset already turned ufw off; this covers a failure at the enable step itself.
      const disabled = await run(ufw, ["--force", "disable"], { timeout: 60_000 });
      log?.(`Put the previous rules back after ${reason}${failed.length ? ` (not ${failed.join(", ")})` : ""}; the firewall was off before${disabled.ok ? " and stays off" : ", but could not be turned off again"}`, "stderr");
      return disabled.ok ? `${rules}, and the firewall was left off, as it was.` : `${rules}, but the firewall could not be turned off again (${tail(disabled.stderr) || "ufw returned an error"}).`;
    }
    const reloaded = await run(ufw, ["--force", "enable"], { timeout: 60_000 });
    log?.(`Put the previous rules back after ${reason}${failed.length ? ` (not ${failed.join(", ")})` : ""}${reloaded.ok ? "" : " (the firewall could not be re-enabled)"}`, "stderr");
    if (!reloaded.ok) return `${rules}, but the firewall could not be turned back on.`;
    // The restored after.rules holds the old Docker block; a sync reattaches its chain without duplicates.
    await dockerSync({ enabled: true }, { run, log }).catch((error) => log?.(`Docker rules not refreshed: ${error.message}`, "stderr"));
    return `${rules}.`;
  };
  const keepCustomRules = async () => {
    for (const { name, source, copy } of saved) {
      if (keptThroughReset.has(name)) await copyFile(copy, source).catch((error) => log?.(`${name} could not be put back after the reset: ${error.message}`, "stderr"));
    }
  };
  const discardSaved = async () => { for (const { name, copy } of saved) if (!notPutBack.has(name)) await rm(copy, { force: true }).catch(() => {}); };
  try {
    for (const step of plan.steps) {
      log?.(`$ ufw ${step.args.join(" ")}  # ${step.label}`, "stdout");
      const result = await run(ufw, step.args, { timeout: 60_000 });
      if (result.ok) {
        completed.push(step.label);
        if (step.args.includes("reset")) await keepCustomRules();
        continue;
      }
      if (step.tolerateFailure) { log?.(`${step.label}: ${tail(result.stderr) || "skipped"}; continuing`, "stderr"); continue; }
      const enabling = step.args.includes("enable");
      const reopened = await reopenClosed(plan.steps.filter((done) => done.removes && completed.includes(done.label)), run, log);
      const restored = await putBack(`"${step.label}" failed`);
      const policy = plan.steps.find((done) => done.args[0] === "default" && done.args[2] === "incoming" && completed.includes(done.label));
      const stopped = enabling ? "" : `. Stopped before turning the firewall on${reopened.text || policy ? "" : ", so nothing new is blocked"}`;
      const policyText = policy ? ` The default for incoming traffic had already been set to ${policy.args[1]}.` : "";
      throw new Error(`${step.label} failed: ${tail(result.stderr) || tail(result.stdout) || "ufw returned an error"}${stopped}.${reopened.text}${policyText}${restored}`);
    }
  } catch (error) {
    await discardSaved();
    throw error;
  }
  await discardSaved();
  const docker = await dockerSync({ enabled: true }, { run, log });
  const closed = plan.steps.filter((step) => step.removes && completed.includes(step.label)).map((step) => step.removes);
  return { profile: plan.profile.id, services: plan.services, replace, sshRateLimit, steps: completed, closed, docker, appliedAt: now().toISOString(), status: await statusLines(run) };
}
