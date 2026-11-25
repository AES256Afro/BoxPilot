import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { commentPattern, ruleActions, ruleProtocols, sourceProblem } from "../tasks/firewall.mjs";
import { mergeRuleFamilies, parseUserRules, profileIds, serviceIds, sshPortsFromSshdT } from "../firewall-profiles.mjs";
import { hasDockerRules } from "../tasks/firewall-docker.mjs";

const minutes = (value) => value * 60_000;

/**
 * The helper cannot see live iptables state (PrivateNetwork), so enabled/rules come from
 * ufw's own configuration files; mutations return a fresh `ufw status` from the root task.
 */

/** ENABLED=yes|no from /etc/ufw/ufw.conf. */
export function parseUfwConf(content) {
  const match = String(content ?? "").match(/^ENABLED=(yes|no)\s*$/m);
  return match ? match[1] === "yes" : null;
}

/** DEFAULT_*_POLICY from /etc/default/ufw. */
export function parseDefaultPolicies(content) {
  const policy = (name) => String(content ?? "").match(new RegExp(`^DEFAULT_${name}_POLICY="?(ACCEPT|DROP|REJECT)"?\\s*$`, "m"))?.[1]?.toLowerCase() ?? null;
  return { incoming: policy("INPUT"), outgoing: policy("OUTPUT"), routed: policy("FORWARD") };
}

/** A previewed removal: what a delete names, as the plan's `removes` gives it. */
function closesProblem(value) {
  if (value.length > 500) return "lists more rules than a firewall holds";
  const valid = (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && ruleActions.includes(entry.action) && Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535
    && ruleProtocols.includes(entry.protocol) && (entry.source === undefined || entry.source === null || (typeof entry.source === "string" && entry.source.length <= 64));
  return value.every(valid) ? null : "each entry must be a rule: action, port, protocol and source";
}

export function firewallOperations() {
  return [
    defineOperation({
      id: "firewall.inspect", title: "Read firewall state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether ufw is installed and enabled, its default policies, the configured rules, and the ports sshd listens on.",
      run: async (_parameters, { run }) => {
        const installed = await access("/usr/sbin/ufw").then(() => true, () => false);
        if (!installed) return { installed: false, enabled: null, defaults: null, rules: [] };
        // M90 review: SSH's port, so the profile preview keeps it as the root task does; null when
        // sshd -T cannot be read, and the plan then keeps every rule that could be SSH's.
        const sshd = await Promise.resolve(run("/usr/sbin/sshd", ["-T"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).catch(() => null);
        const [conf, defaults, v4, v6] = await Promise.all([
          readFile("/etc/ufw/ufw.conf", "utf8").catch(() => ""),
          readFile("/etc/default/ufw", "utf8").catch(() => ""),
          readFile("/etc/ufw/user.rules", "utf8").catch(() => ""),
          readFile("/etc/ufw/user6.rules", "utf8").catch(() => ""),
        ]);
        return {
          installed: true,
          enabled: parseUfwConf(conf),
          defaults: parseDefaultPolicies(defaults),
          rules: mergeRuleFamilies(parseUserRules(v4, "v4"), parseUserRules(v6, "v6")),
          dockerRules: hasDockerRules(await readFile("/etc/ufw/after.rules", "utf8").catch(() => "")),
          sshPorts: sshd?.ok ? sshPortsFromSshdT(sshd.stdout) : null,
        };
      },
    }),
    defineOperation({
      id: "firewall.set", title: "Turn the firewall on or off", risk: "high", timeoutMs: minutes(3),
      description: "On: blocks incoming connections except the ones you allowed; SSH, Tailscale and BoxPilot always stay reachable. Off: every port on this server is open to your network.",
      parameters: { fields: { enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.set", { enabled: parameters.enabled }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.rule.add", title: "Add a firewall rule", risk: "medium", timeoutMs: minutes(2),
      description: "Allows, denies, or rate-limits a port with ufw, for tcp, udp, or both, from anywhere or from one address or range (this LAN, the tailnet). SSH, Tailscale, and BoxPilot's port can never be denied.",
      parameters: { fields: {
        action: { type: "string", enum: [...ruleActions] },
        port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be a port between 1 and 65535") },
        protocol: { type: "string", enum: [...ruleProtocols] },
        comment: { type: "string", optional: true, nullable: true, maxLength: 60, pattern: commentPattern },
        // M90: an address or range only (sourceProblem); left out, the rule is from anywhere.
        source: { type: "string", optional: true, nullable: true, maxLength: 64, validate: sourceProblem },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.rule-add", { action: parameters.action, port: parameters.port, protocol: parameters.protocol, comment: parameters.comment ?? null, source: parameters.source ?? null }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.rule.delete", title: "Delete a firewall rule", risk: "medium", timeoutMs: minutes(2),
      description: "Deletes the matching ufw rule, from anywhere or from the one address or range it names. The SSH, Tailscale, and BoxPilot allow rules cannot be deleted from here.",
      parameters: { fields: {
        action: { type: "string", enum: [...ruleActions] },
        port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be a port between 1 and 65535") },
        protocol: { type: "string", enum: [...ruleProtocols] },
        source: { type: "string", optional: true, nullable: true, maxLength: 64, validate: sourceProblem },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.rule-delete", { action: parameters.action, port: parameters.port, protocol: parameters.protocol, source: parameters.source ?? null }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.profile.apply", title: "Apply a firewall profile", risk: "high", timeoutMs: minutes(5),
      description: "Keeps SSH, Tailscale, and BoxPilot reachable, adds the profile's rules and the chosen services, sets the default policies, and turns the firewall on. Optionally resets existing rules first or rate-limits SSH.",
      parameters: { fields: {
        profile: { type: "string", enum: [...profileIds] },
        services: { type: "array", optional: true, validate: (value) => (value.every((id) => typeof id === "string" && serviceIds.includes(id)) ? null : `may only contain ${serviceIds.join(", ")}`) },
        replace: { type: "boolean", optional: true },
        sshRateLimit: { type: "boolean", optional: true },
        // M90 review: the rules the preview showed closing. The task refuses, changing nothing, when
        // the plan it rebuilds would close anything else; left out, it may close nothing.
        closes: { type: "array", optional: true, validate: closesProblem },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.profile-apply", { profile: parameters.profile, services: parameters.services ?? [], replace: parameters.replace ?? false, sshRateLimit: parameters.sshRateLimit ?? false, closes: parameters.closes ?? [] }, { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
  ];
}
