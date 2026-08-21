import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { commentPattern, ruleActions, ruleProtocols } from "../tasks/firewall.mjs";
import { profileIds, serviceIds } from "../firewall-profiles.mjs";

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

/**
 * Parse `### tuple ###` lines from /etc/ufw/user.rules:
 *   action proto dport dst sport src [dapp sapp] direction [comment=hex]
 */
export function parseUserRules(content, family = "v4") {
  const rules = [];
  for (const line of String(content ?? "").split("\n")) {
    const match = line.match(/^### tuple ###\s+(.*)$/);
    if (!match) continue;
    const fields = match[1].trim().split(/\s+/);
    let comment = null;
    if (fields.at(-1)?.startsWith("comment=")) {
      const hex = fields.pop().slice("comment=".length);
      comment = /^[0-9a-f]*$/i.test(hex) ? Buffer.from(hex, "hex").toString("utf8") : null;
    }
    const direction = fields.at(-1)?.match(/^(in|out)(?:_(.+))?$/);
    if (!direction || fields.length < 7) { rules.push({ raw: match[1], family }); continue; }
    const [action, protocol, dport] = fields;
    const app = fields.length >= 9 && fields[6] !== "-" ? fields[6] : null;
    rules.push({
      action,
      protocol: protocol === "any" ? "any" : protocol,
      port: /^\d+$/.test(dport) ? Number(dport) : null,
      app,
      direction: direction[1],
      interface: direction[2] ?? null,
      comment,
      family,
    });
  }
  return rules;
}

/** Collapse identical v4/v6 rules into one entry with family "both". */
export function mergeRuleFamilies(v4Rules, v6Rules) {
  const key = (rule) => JSON.stringify([rule.action, rule.protocol, rule.port, rule.app, rule.direction, rule.interface, rule.raw ?? null]);
  const merged = [...v4Rules];
  const seen = new Map(v4Rules.map((rule) => [key(rule), rule]));
  for (const rule of v6Rules) {
    const existing = seen.get(key(rule));
    if (existing) existing.family = "both";
    else merged.push(rule);
  }
  return merged;
}

export function firewallOperations() {
  return [
    defineOperation({
      id: "firewall.inspect", title: "Read firewall state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether ufw is installed and enabled, its default policies, and the configured rules.",
      run: async () => {
        const installed = await access("/usr/sbin/ufw").then(() => true, () => false);
        if (!installed) return { installed: false, enabled: null, defaults: null, rules: [] };
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
        };
      },
    }),
    defineOperation({
      id: "firewall.set", title: "Turn the firewall on or off", risk: "high", timeoutMs: minutes(3),
      description: "Enables or disables ufw. Before enabling, rules keeping SSH (22/tcp), Tailscale (41641/udp), BoxPilot's own port when it is served on the LAN, and the tailscale0 interface reachable are added.",
      parameters: { fields: { enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.set", { enabled: parameters.enabled }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.rule.add", title: "Add a firewall rule", risk: "medium", timeoutMs: minutes(2),
      description: "Allows, denies, or rate-limits a port with ufw, for tcp, udp, or both. SSH, Tailscale, and BoxPilot's port can never be denied.",
      parameters: { fields: {
        action: { type: "string", enum: [...ruleActions] },
        port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be a port between 1 and 65535") },
        protocol: { type: "string", enum: [...ruleProtocols] },
        comment: { type: "string", optional: true, nullable: true, maxLength: 60, pattern: commentPattern },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.rule-add", { action: parameters.action, port: parameters.port, protocol: parameters.protocol, comment: parameters.comment ?? null }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.rule.delete", title: "Delete a firewall rule", risk: "medium", timeoutMs: minutes(2),
      description: "Deletes the matching ufw rule. The SSH, Tailscale, and BoxPilot allow rules cannot be deleted from here.",
      parameters: { fields: {
        action: { type: "string", enum: [...ruleActions] },
        port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be a port between 1 and 65535") },
        protocol: { type: "string", enum: [...ruleProtocols] },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.rule-delete", { action: parameters.action, port: parameters.port, protocol: parameters.protocol }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "firewall.profile.apply", title: "Apply a firewall profile", risk: "high", timeoutMs: minutes(5),
      description: "Keeps SSH, Tailscale, and BoxPilot reachable, adds the profile's rules and the chosen services, sets the default policies, and turns the firewall on. Optionally resets existing rules first or rate-limits SSH.",
      parameters: { fields: {
        profile: { type: "string", enum: [...profileIds] },
        services: { type: "array", optional: true, validate: (value) => (value.every((id) => typeof id === "string" && serviceIds.includes(id)) ? null : `may only contain ${serviceIds.join(", ")}`) },
        replace: { type: "boolean", optional: true },
        sshRateLimit: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("firewall.profile-apply", { profile: parameters.profile, services: parameters.services ?? [], replace: parameters.replace ?? false, sshRateLimit: parameters.sshRateLimit ?? false }, { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
  ];
}
