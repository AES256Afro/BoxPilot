/**
 * Firewall profiles, protected ports, service presets, and advice.
 *
 * Pure data and functions shared by the root task that applies a profile
 * (server/tasks/firewall.mjs), the web route that lists profiles and advice
 * (server/routes/firewall.mjs), and the Firewall page. Nothing here runs ufw.
 *
 * Lockout rule: the ports in `protectedRules()` can never be denied and their allow
 * rules can never be deleted through BoxPilot. The root task enforces it; the UI
 * only explains it.
 */

export const tailscalePort = 41641;
export const defaultWebPort = 8787;

/** Whether a BOXPILOT_HOST value keeps the web service (and its HTTPS listener) off the network. */
const isLoopbackHost = (host) => ["127.0.0.1", "::1", "localhost"].includes(String(host ?? ""));

/**
 * The ports sshd listens on, from `sshd -T` (M90 review): its `port` lines, and the port of each
 * `listenaddress` line, since a ListenAddress with a port replaces Port. Null when there are none,
 * which means the port is not known; a caller then protects 22 and fails safe.
 * @returns {number[] | null}
 */
export function sshPortsFromSshdT(stdout) {
  const ports = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.trim().match(/^(port|listenaddress)\s+(\S+)/i);
    if (!match) continue;
    const text = match[1].toLowerCase() === "port" ? match[2] : match[2].match(/:(\d+)$/)?.[1];
    if (!text || !/^\d{1,5}$/.test(text)) continue;
    const port = Number(text);
    if (port >= 1 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports.length ? ports : null;
}

/**
 * Rules BoxPilot always keeps open (or, for the web port, refuses to deny).
 *
 * M90 review: the list was 22/tcp, 41641/udp and the web port, so "Tailscale only" deleted the
 * HTTPS port web-tls opens (written as a bare `ufw allow 8443/tcp`) and an SSH port other than 22.
 * Now SSH is 22 plus every port `sshd -T` reports (`sshPorts`, null when it could not be read), and
 * the HTTPS port is kept while a certificate is set (`tlsPort`) and the page is served off loopback.
 * @param {{ webPort?: number, webHost?: string, tlsPort?: number | null, sshPorts?: number[] | null }} [options]
 */
export function protectedRules({ webPort = defaultWebPort, webHost = "127.0.0.1", tlsPort = null, sshPorts = null } = {}) {
  const lanWeb = !isLoopbackHost(webHost);
  const ssh = [22, ...(Array.isArray(sshPorts) ? sshPorts : [])].filter((port, index, all) => Number.isInteger(port) && all.indexOf(port) === index);
  const list = [
    ...ssh.map((port) => ({ port, protocol: "tcp", label: "SSH", kind: "ssh", reason: "Your way back in if the web UI ever breaks.", allow: true })),
    { port: tailscalePort, protocol: "udp", label: "Tailscale", kind: "tailscale", reason: "WireGuard port; without it tailnet traffic falls back to relays.", allow: true },
    { port: webPort, protocol: "tcp", label: "BoxPilot", kind: "web", reason: lanWeb ? "This page. BoxPilot is served on the LAN, so the port stays open." : "This page. Served via Tailscale or an SSH tunnel, so no LAN rule is needed, but it can never be denied.", allow: lanWeb },
  ];
  if (Number.isInteger(tlsPort) && lanWeb && !list.some((entry) => entry.port === tlsPort && entry.protocol === "tcp")) {
    list.push({ port: tlsPort, protocol: "tcp", label: "BoxPilot HTTPS", kind: "tls", reason: "This page over HTTPS. BoxPilot is served on the LAN, so the port stays open.", allow: true });
  }
  return list;
}

/** True when `rule` targets a protected port (protocol "any" covers both). */
export function isProtected(rule, protectedList) {
  return protectedList.some((entry) => entry.port === rule.port && (rule.protocol === "any" || entry.protocol === rule.protocol));
}

/** Ports that should not face a whole LAN: databases, remote desktops, management APIs. */
export const riskyPorts = Object.freeze([
  { port: 23, protocol: "tcp", label: "Telnet" },
  { port: 111, protocol: "tcp", label: "rpcbind" },
  { port: 161, protocol: "udp", label: "SNMP" },
  { port: 2375, protocol: "tcp", label: "Docker API (unencrypted)" },
  { port: 2376, protocol: "tcp", label: "Docker API (TLS)" },
  { port: 3306, protocol: "tcp", label: "MySQL / MariaDB" },
  { port: 3389, protocol: "tcp", label: "Remote Desktop (RDP)" },
  { port: 5432, protocol: "tcp", label: "PostgreSQL" },
  { port: 5900, protocol: "tcp", label: "VNC" },
  { port: 6379, protocol: "tcp", label: "Redis" },
  { port: 9200, protocol: "tcp", label: "Elasticsearch" },
  { port: 11211, protocol: "tcp", label: "Memcached" },
  { port: 16509, protocol: "tcp", label: "libvirt (unencrypted)" },
  { port: 27017, protocol: "tcp", label: "MongoDB" },
]);

/** Common services the owner can open with one checkbox when applying a profile. */
export const services = Object.freeze([
  { id: "web", name: "Web (HTTP/HTTPS)", hint: "Reverse proxies, dashboards, Nextcloud", ports: [{ port: 80, protocol: "tcp" }, { port: 443, protocol: "tcp" }] },
  { id: "dns", name: "DNS server", hint: "Pi-hole or AdGuard Home answering for the LAN", ports: [{ port: 53, protocol: "tcp" }, { port: 53, protocol: "udp" }] },
  { id: "dhcp", name: "DHCP server", hint: "Only if Pi-hole / AdGuard hands out addresses instead of the router", ports: [{ port: 67, protocol: "udp" }] },
  { id: "jellyfin", name: "Jellyfin", hint: "Web player plus client discovery", ports: [{ port: 8096, protocol: "tcp" }, { port: 8920, protocol: "tcp" }, { port: 7359, protocol: "udp" }] },
  { id: "plex", name: "Plex", hint: "Plex Media Server", ports: [{ port: 32400, protocol: "tcp" }] },
  { id: "home-assistant", name: "Home Assistant", hint: "The Home Assistant web UI", ports: [{ port: 8123, protocol: "tcp" }] },
  { id: "samba", name: "Windows file sharing (SMB)", hint: "Trusted LAN only; never on a shared network", ports: [{ port: 445, protocol: "tcp" }, { port: 139, protocol: "tcp" }] },
  { id: "nfs", name: "NFS file sharing", hint: "Linux/macOS network mounts", ports: [{ port: 2049, protocol: "tcp" }, { port: 2049, protocol: "udp" }] },
  { id: "mdns", name: "Bonjour / mDNS discovery", hint: "Lets devices find services by name (AirPlay, printers, Home Assistant discovery)", ports: [{ port: 5353, protocol: "udp" }] },
  { id: "wireguard", name: "WireGuard VPN", hint: "Self-hosted VPN endpoint (wg-easy)", ports: [{ port: 51820, protocol: "udp" }] },
  { id: "syncthing", name: "Syncthing", hint: "File sync between your own devices", ports: [{ port: 22000, protocol: "tcp" }, { port: 22000, protocol: "udp" }, { port: 21027, protocol: "udp" }] },
  { id: "printing", name: "Printing (CUPS / IPP)", hint: "Shared printers", ports: [{ port: 631, protocol: "tcp" }] },
  { id: "minecraft", name: "Minecraft server", hint: "Java edition default port", ports: [{ port: 25565, protocol: "tcp" }] },
]);

/**
 * Profiles. `defaults` are ufw default policies; `rules` are applied after the protected
 * rules and before the chosen services. Applying a profile always ends with `ufw enable`.
 */
export const profiles = Object.freeze([
  {
    id: "home-server",
    name: "Home server",
    recommended: true,
    summary: "Block everything that was not asked for. SSH, Tailscale, and BoxPilot stay reachable; tick the services you run below.",
    detail: "Default incoming deny, outgoing allow. This is the right starting point for almost every home server.",
    defaults: { incoming: "deny", outgoing: "allow" },
    rules: [],
  },
  {
    id: "tailscale-only",
    name: "Tailscale only",
    recommended: false,
    summary: "Reach this server only over your tailnet. The LAN sees SSH and nothing else.",
    detail: "Same as Home server but with no LAN services. If BoxPilot itself is served on the LAN, its port stays open; switch the install to Tailscale access to close it.",
    defaults: { incoming: "deny", outgoing: "allow" },
    rules: [],
    lockServices: true,
  },
  {
    id: "trusted-lan",
    name: "Trusted LAN, risky services blocked",
    recommended: false,
    summary: "Keep the LAN open but refuse databases, remote desktops, and management APIs from the network.",
    detail: "Default incoming allow with explicit deny rules for the services that should never face a whole network. Pick this only on a network where you trust every device.",
    defaults: { incoming: "allow", outgoing: "allow" },
    rules: riskyPorts.map((entry) => ({ action: "deny", port: entry.port, protocol: entry.protocol, comment: `BoxPilot profile: ${entry.label}` })),
  },
]);

export const profileIds = Object.freeze(profiles.map((profile) => profile.id));
export const serviceIds = Object.freeze(services.map((service) => service.id));

function spec({ port, protocol }) {
  return protocol === "any" ? String(port) : `${port}/${protocol}`;
}

/**
 * Where a rule may let traffic in from (M90). A rule added without one is ufw's "Anywhere", which
 * on a box with IPv6 includes its global address: the add form used to say "to devices on your
 * network" about exactly that. The tailnet is one choice in two families: Tailscale hands out
 * 100.64.0.0/10 and fd7a:115c:a1e0::/48, so a rule for one is written, and deleted, with the other.
 */
export const tailnetSources = Object.freeze(["100.64.0.0/10", "fd7a:115c:a1e0::/48"]);

/** The sources one choice stands for: the tailnet's two ranges, or the one range given. */
export function sourcesFor(source) {
  return tailnetSources.includes(source) ? [...tailnetSources] : [source];
}

/**
 * The ufw words after the action for a port rule: `8096/tcp` from anywhere, or
 * `from 192.168.1.0/24 to any port 8096 proto tcp` from one range (no `proto` for tcp + udp).
 * Adding and deleting use the same words, so a delete names exactly the rule an add wrote.
 * @param {{ port: number, protocol: string, source?: string | null }} rule
 */
export function ruleTarget({ port, protocol, source = null }) {
  if (!source) return [spec({ port, protocol })];
  return ["from", source, "to", "any", "port", String(port), ...(protocol === "any" ? [] : ["proto", protocol])];
}

function ipv4Number(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((number, part) => ((number << 8) | part) >>> 0, 0);
}
const ipv4Text = (number) => [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join(".");
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
function isPrivateIpv4(number) {
  return (number >>> 24) === 10 || (number >>> 20) === ((172 << 4) | 1) || (number >>> 16) === ((192 << 8) | 168);
}

/**
 * The LAN this server sits on, as the network ranges of its private IPv4 addresses (M90), from an
 * os.networkInterfaces()-shaped object: not loopback, the tailnet, Docker's or libvirt's bridges.
 * "This LAN" in the add form is the first of them.
 * @param {Record<string, Array<{ address: string, family: string | number, internal?: boolean, cidr?: string | null }> | undefined>} interfaces
 */
export function lanSubnets(interfaces) {
  const subnets = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if (/^(lo|tailscale|docker|virbr|br-|veth)/.test(name)) continue;
    for (const entry of entries ?? []) {
      if (!(entry.family === "IPv4" || entry.family === 4) || entry.internal) continue;
      const address = ipv4Number(entry.address);
      const prefix = Number(String(entry.cidr ?? "").split("/")[1]);
      if (address === null || !isPrivateIpv4(address) || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) continue;
      const subnet = `${ipv4Text((address & maskOf(prefix)) >>> 0)}/${prefix}`;
      if (!subnets.includes(subnet)) subnets.push(subnet);
    }
  }
  return subnets;
}

/** ufw's "from anywhere", in either family. */
const anywhere = new Set(["0.0.0.0/0", "::/0", "any"]);

/**
 * Parse `### tuple ###` lines from /etc/ufw/user.rules:
 *   action proto dport dst sport src [dapp sapp] direction [comment=hex]
 * `source` is where the rule lets traffic come from (`ufw status`'s From column), null for anywhere:
 * a rule for 192.168.8.0/24 and one for anywhere on the same port are different rules.
 * `destination` is the address on this server the rule is for (`ufw allow to 192.168.1.5 port 3306`),
 * null for any of them.
 * `deletable` says whether firewall.rule.delete can reach the rule: it runs `ufw delete <action>`
 * with the port, protocol and, since M90, the source (ruleTarget), so a rule tied to an interface,
 * an application profile or a destination is not one it can remove.
 *
 * Here rather than in ops/firewall.mjs since M90: the root task reads the same rules to work out
 * what applying a profile closes, and must agree with the page about what a rule is.
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
    const [action, protocol, dport, dst, , src] = fields;
    const app = fields.length >= 9 && fields[6] !== "-" ? fields[6] : null;
    const port = /^\d+$/.test(dport) ? Number(dport) : null;
    const source = anywhere.has(src) ? null : src;
    const destination = anywhere.has(dst) ? null : dst;
    const iface = direction[2] ?? null;
    rules.push({
      action,
      protocol: protocol === "any" ? "any" : protocol,
      port,
      app,
      source,
      destination,
      direction: direction[1],
      interface: iface,
      deletable: port !== null && !app && !destination && !iface,
      comment,
      family,
    });
  }
  return rules;
}

/** Collapse identical v4/v6 rules into one entry with family "both"; a rule from one source is never merged with one from anywhere. */
export function mergeRuleFamilies(v4Rules, v6Rules) {
  const key = (rule) => JSON.stringify([rule.action, rule.protocol, rule.port, rule.app, rule.source ?? null, rule.destination ?? null, rule.direction, rule.interface, rule.raw ?? null]);
  const merged = [...v4Rules];
  const seen = new Map(v4Rules.map((rule) => [key(rule), rule]));
  for (const rule of v6Rules) {
    const existing = seen.get(key(rule));
    if (existing) existing.family = "both";
    else merged.push(rule);
  }
  return merged;
}

/** A rule a profile may remove: a plain incoming port rule, from anywhere or one range, that delete can name. */
const removable = (rule) => !rule.raw && Number.isInteger(rule.port) && !rule.app && !rule.destination && !rule.interface && rule.direction !== "out" && ["allow", "limit", "deny"].includes(rule.action);

/**
 * What applying a profile closes (M90). It used to only add: switching to "Tailscale only" ("The
 * LAN sees SSH and nothing else") left every earlier service's allow in ufw while the Profile panel
 * said "Open to the LAN: Nothing". Now:
 *  - a rule BoxPilot wrote for a service (`BoxPilot service: <name>`) whose service is not chosen goes;
 *  - a rule BoxPilot wrote for a profile (`BoxPilot profile: <label>`) that the new profile does not write goes;
 *  - for a profile that opens nothing on the LAN (lockServices), every other allow goes too, except
 *    one only the tailnet can use.
 * The protected ports (SSH, Tailscale, BoxPilot's own, its HTTPS port) are never touched, whatever
 * the rule's protocol, source or action. When the SSH port could not be read (`sshUnknown`), no rule
 * that could be SSH's is closed either: a rate-limited one, one whose comment says SSH, or one on a
 * port sshd is commonly moved to.
 */
const commonSshPorts = Object.freeze([22, 222, 2022, 2200, 2222, 22222]);
const couldBeSsh = (rule) => rule.action === "limit" || /ssh/i.test(String(rule.comment ?? "")) || commonSshPorts.includes(rule.port);

function closingRules({ profile, chosen, protectedList, existing, sshUnknown = false }) {
  const chosenNames = new Set(chosen.map((id) => services.find((entry) => entry.id === id)?.name));
  const chosenPorts = chosen.flatMap((id) => services.find((entry) => entry.id === id)?.ports ?? []);
  const keptByChoice = (rule) => chosenPorts.some((entry) => entry.port === rule.port && entry.protocol === rule.protocol) && !rule.source;
  const profileComments = new Set(profile.rules.map((rule) => rule.comment));
  const closing = [];
  for (const rule of existing ?? []) {
    if (!removable(rule) || protectedList.some((entry) => entry.port === rule.port)) continue;
    if (sshUnknown && rule.action !== "deny" && couldBeSsh(rule)) continue;
    const comment = typeof rule.comment === "string" ? rule.comment : "";
    const service = comment.startsWith("BoxPilot service: ") ? comment.slice("BoxPilot service: ".length) : null;
    const reason = profile.lockServices && rule.action !== "deny" && !(rule.source && sourcesFor(rule.source).length > 1) ? `${profile.name} opens nothing on the LAN`
      : service !== null && services.some((entry) => entry.name === service) && !chosenNames.has(service) && !keptByChoice(rule) ? `${service} is no longer chosen`
        : comment.startsWith("BoxPilot profile: ") && !profileComments.has(comment) ? `${profile.name} does not keep it`
          : null;
    if (!reason) continue;
    const key = JSON.stringify([rule.action, rule.port, rule.protocol, rule.source ?? null]);
    if (closing.some((entry) => entry.key === key)) continue;
    closing.push({ key, rule, reason });
  }
  return closing.map(({ rule, reason }) => ({
    args: ["--force", "delete", rule.action, ...ruleTarget({ port: rule.port, protocol: rule.protocol ?? "any", source: rule.source ?? null })],
    label: `Close ${spec({ port: rule.port, protocol: rule.protocol ?? "any" })}${rule.source ? ` from ${rule.source}` : ""}${rule.comment ? ` (${rule.comment.replace(/^BoxPilot (service|profile): /, "")})` : ""}: ${reason}`,
    removes: { action: rule.action, port: rule.port, protocol: rule.protocol ?? "any", source: rule.source ?? null, comment: rule.comment ?? null },
  }));
}

/**
 * Build the ordered ufw argv list for applying a profile. Pure, so the preview and the root
 * task agree on exactly what runs. Protected allows come first; `ufw enable` comes last and
 * only after every rule succeeded, so a half-applied plan fails open, never closed.
 *
 * `existing` is the rule list as parseUserRules/mergeRuleFamilies read it (the page's Rules tab):
 * the plan closes what the new choice no longer keeps (closingRules, M90). Allows close straight
 * after the protected rules; a deny closes only once the default is deny, so it never opens a port
 * for a moment under the old allow-by-default. "Start from scratch" resets instead, so it closes nothing.
 *
 * `sshPorts` is what `sshd -T` reports (null: unknown, so 22 is kept and nothing that could be SSH's
 * closes) and `tlsPort` the HTTPS port while a certificate is set (null: none); see protectedRules.
 *
 * @param {{ profileId?: string, serviceIds?: string[], replace?: boolean, sshRateLimit?: boolean, webPort?: number, webHost?: string, tlsPort?: number | null, sshPorts?: number[] | null, existing?: any[] }} [options]
 */
export function buildPlan({ profileId, serviceIds: chosen = [], replace = false, sshRateLimit = false, webPort = defaultWebPort, webHost = "127.0.0.1", tlsPort = null, sshPorts = null, existing = [] } = {}) {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown firewall profile: ${profileId}`);
  const unknown = chosen.filter((id) => !serviceIds.includes(id));
  if (unknown.length) throw new Error(`Unknown services: ${unknown.join(", ")}`);
  const protectedList = protectedRules({ webPort, webHost, tlsPort, sshPorts });
  const sshUnknown = !Array.isArray(sshPorts) || sshPorts.length === 0;
  const steps = [];
  if (replace) steps.push({ args: ["--force", "reset"], label: "Remove every existing rule and start from the profile" });
  for (const entry of protectedList) {
    if (!entry.allow) continue;
    if (entry.kind === "ssh" && sshRateLimit) {
      // Rate-limited SSH is still an allow (6 new connections per 30 s per address). `ufw limit`
      // replaces an existing allow for the same tuple, so this needs no position and works on an
      // empty rule list — `insert 1` does not, and it was the first step after a reset that had
      // already cleared every rule.
      steps.push({ args: ["limit", spec(entry), "comment", "BoxPilot keeps SSH reachable (rate-limited)"], label: `Keep SSH reachable, rate-limited against password guessing${entry.port === 22 ? "" : ` (${spec(entry)})`}` });
      continue;
    }
    steps.push({ args: ["allow", spec(entry), "comment", `BoxPilot keeps ${entry.label} reachable`], label: `Keep ${entry.label} reachable (${spec(entry)})` });
  }
  // When the web UI is on loopback there is no LAN rule for it, so this interface rule is the only
  // thing keeping the page reachable — a failure there has to stop the apply, not be logged and
  // passed over. On a LAN-served box the rule is a convenience and a missing tailscale0 is normal.
  const tailnetIsTheOnlyWayIn = !protectedList.some((entry) => entry.label === "BoxPilot" && entry.allow);
  steps.push({ args: ["allow", "in", "on", "tailscale0", "comment", "BoxPilot keeps the tailnet reachable"], label: "Keep the tailnet interface reachable", tolerateFailure: !tailnetIsTheOnlyWayIn });
  const effectiveServices = profile.lockServices ? [] : chosen;
  const closing = replace ? [] : closingRules({ profile, chosen: effectiveServices, protectedList, existing, sshUnknown });
  steps.push(...closing.filter((step) => step.removes.action !== "deny"));
  for (const rule of profile.rules) {
    steps.push({ args: [rule.action, spec(rule), ...(rule.comment ? ["comment", rule.comment] : [])], label: `${rule.action} ${spec(rule)}${rule.comment ? ` (${rule.comment.replace(/^BoxPilot profile: /, "")})` : ""}` });
  }
  for (const id of effectiveServices) {
    const service = services.find((entry) => entry.id === id);
    for (const port of service.ports) steps.push({ args: ["allow", spec(port), "comment", `BoxPilot service: ${service.name}`], label: `Allow ${service.name} (${spec(port)})` });
  }
  steps.push({ args: ["default", profile.defaults.incoming, "incoming"], label: `Default incoming: ${profile.defaults.incoming}` });
  if (profile.defaults.incoming === "deny") steps.push(...closing.filter((step) => step.removes.action === "deny"));
  steps.push({ args: ["default", profile.defaults.outgoing, "outgoing"], label: `Default outgoing: ${profile.defaults.outgoing}` });
  steps.push({ args: ["--force", "enable"], label: "Turn the firewall on" });
  const notes = sshUnknown && !replace ? ["The SSH port could not be read, so 22 is kept, and no rule that could be SSH's (rate-limited, named SSH, or on a usual SSH port) is closed."] : [];
  return { profile: { id: profile.id, name: profile.name }, services: effectiveServices, protected: protectedList, steps, notes };
}

/** The key a removal is compared by: what a delete names (action, port, protocol, source). */
export function removalKey({ action, port, protocol, source = null }) {
  return JSON.stringify([action, port, protocol ?? "any", source ?? null]);
}

function ruleAllows(rule, port, protocol) {
  return ["allow", "limit"].includes(rule.action) && rule.port === port && (rule.protocol === "any" || rule.protocol === protocol) && !rule.interface && rule.direction !== "out";
}

/**
 * A rule narrower than "this port, from anywhere, on every address": one that lets in only one
 * address or range (ufw's `from`), is tied to an interface (`allow in on eth0 to any port 8084`),
 * names an application profile (`allow 'Nginx HTTP'`) or is for one address of this server
 * (`allow to 192.168.1.5 port 3306`). firewall.rule.delete removes the plain rule
 * (`ufw delete allow 3306/tcp`), which is none of these: offered its removal, the owner got "does
 * not exist any more" and the same advice on every visit. So the advice that removes rules leaves
 * these alone; the owner who wrote one meant it. (Since M90 delete can name a source too, and the
 * Rules tab offers it; the advice still leaves a narrowed rule to the owner.)
 */
const narrowed = (rule) => [rule.source, rule.destination, rule.interface, rule.app].some((value) => typeof value === "string" && value.length > 0);

/** ufw comments allow letters, digits, spaces, dot, underscore and dash — nothing else. */
function ruleComment(text) {
  return String(text).replace(/[^A-Za-z0-9 ._-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Suggestions for the Firewall page. Every entry has a stable id, a level, copy, and where
 * possible a one-click action (`operationId` + `parameters`) or a `focus` hint for the UI.
 *
 * @param {object} [input]
 * @param {any} [input.report]           firewall.inspect result, or null
 * @param {any[]} [input.listeners]      listListeners() result from the web process
 * @param {any[]} [input.apps]           installed apps: [{ id, name, ports: [{ port, protocol, label }] }]
 * @param {any} [input.current]          the stored profile setting, if any
 * @param {any} [input.fail2ban]         fail2ban.inspect result, if any
 * @param {number} [input.webPort]
 * @param {string} [input.webHost]
 * @param {number | null} [input.tlsPort]  the HTTPS port while a certificate is set
 * @param {string | null} [input.lan]    this LAN's range (lanSubnets), which "Allow <app>" opens the app to
 */
export function adviseFirewall({ report, listeners = [], apps = [], current = null, fail2ban = null, webPort = defaultWebPort, webHost = "127.0.0.1", tlsPort = null, lan = null } = {}) {
  const advice = [];
  if (!report) {
    advice.push({ id: "unavailable", level: "warn", title: "The firewall state could not be read", detail: "BoxPilot could not reach the part of itself that reads ufw. Check the BoxPilot services on the Services page, then refresh.", focus: undefined });
    return advice;
  }
  if (!report.installed) {
    advice.push({ id: "install", level: "action", title: "Install ufw", detail: "BoxPilot manages the firewall through ufw. Installing it does not turn it on.", focus: "install" });
    return advice;
  }
  const protectedList = protectedRules({ webPort, webHost, tlsPort, sshPorts: Array.isArray(report.sshPorts) ? report.sshPorts : null });
  if (report.enabled && apps.length > 0 && report.dockerRules === false) {
    advice.push({ id: "docker-rules", level: "action", title: "Docker apps are not following the firewall yet", detail: "Docker publishes app ports outside ufw, so until the firewall is re-applied every installed app is reachable from the LAN whatever the rules say. Apply a profile (or turn the firewall off and on) once; BoxPilot then adds the rules that make Docker ports follow it.", focus: "profiles" });
  }
  const rules = report.rules ?? [];
  const incoming = report.defaults?.incoming ?? null;
  const denyByDefault = incoming === "drop" || incoming === "reject";
  const exposed = listeners.filter((listener) => listener.scope !== "loopback");

  if (!report.enabled) {
    const risky = riskyPorts.filter((entry) => exposed.some((listener) => listener.port === entry.port && listener.protocol === entry.protocol));
    advice.push({
      id: "enable-profile", level: "action", title: "Turn the firewall on with the Home server profile",
      detail: risky.length
        ? `Right now every port is reachable from the LAN, including ${risky.map((entry) => `${entry.label} (${entry.port})`).join(", ")}. The profile keeps SSH, Tailscale, and BoxPilot open and blocks the rest.`
        : "Right now every listening port is reachable from the LAN. The profile keeps SSH, Tailscale, and BoxPilot open and blocks the rest.",
      focus: "profiles",
    });
    return advice;
  }

  if (!denyByDefault && current?.id !== "trusted-lan") {
    advice.push({ id: "default-deny", level: "warn", title: "Incoming traffic is allowed by default", detail: "The firewall is on, but without a matching rule traffic is still let in. Apply a profile to switch to deny-by-default.", focus: "profiles" });
  }

  for (const entry of riskyPorts) {
    const fromAnywhere = (rule) => ruleAllows(rule, entry.port, entry.protocol) && !narrowed(rule);
    const open = rules.some(fromAnywhere);
    const listening = exposed.some((listener) => listener.port === entry.port && listener.protocol === entry.protocol);
    if (open && !isProtected(entry, protectedList)) {
      const rule = rules.find(fromAnywhere);
      advice.push({
        id: `risky-allow-${entry.port}-${entry.protocol}`, level: "warn", title: `${entry.label} is open to the whole LAN`,
        detail: `Port ${entry.port}/${entry.protocol} has an allow rule. Services like this should only be reached from this server or over Tailscale.`,
        operationId: "firewall.rule.delete", parameters: { action: rule.action, port: entry.port, protocol: rule.protocol ?? entry.protocol }, actionLabel: "Remove the rule",
      });
    } else if (!denyByDefault && listening) {
      advice.push({
        id: `risky-listen-${entry.port}-${entry.protocol}`, level: "warn", title: `${entry.label} is reachable from the LAN`,
        detail: `Something is listening on ${entry.port}/${entry.protocol} and the default policy lets it through.`,
        operationId: "firewall.rule.add", parameters: { action: "deny", port: entry.port, protocol: entry.protocol, comment: ruleComment(`BoxPilot block ${entry.label}`) }, actionLabel: "Block it",
      });
    }
  }

  if (denyByDefault) {
    for (const app of apps) {
      for (const port of app.ports ?? []) {
        if (rules.some((rule) => ruleAllows(rule, port.port, port.protocol))) continue;
        advice.push({
          id: `app-${app.id}-${port.port}-${port.protocol}`, level: "info", title: `${app.name} is blocked for other devices`,
          detail: `${app.name} publishes ${port.label ?? "a port"} on ${port.port}/${port.protocol} but no rule allows it, so only this server and Tailscale can reach it. Allow it if other devices should${lan ? `: the rule lets in devices on this LAN (${lan}) and nothing from further away` : ""}.`,
          // M90: from this LAN when the server knows it. A rule from anywhere also lets in the
          // server's global IPv6 address, which "other devices" never meant.
          operationId: "firewall.rule.add", parameters: { action: "allow", port: port.port, protocol: port.protocol, comment: app.name.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 60) || app.id, ...(lan ? { source: lan } : {}) }, actionLabel: `Allow ${app.name}`,
        });
      }
    }
  }

  // A rule holding a port open for nothing.
  //
  // Rules do not follow an app when its ports change. Switching Pi-hole to host networking moved its
  // admin page from 8084 to 80; the rule for 8084 stayed, allowing a port nothing answers on, while
  // the page it was written for had become unreachable. Both facts were known here and neither was
  // said, so it read as a broken app rather than a rule left behind.
  for (const rule of rules) {
    if (!["allow", "limit"].includes(rule.action) || rule.direction === "out") continue;
    if (!Number.isInteger(rule.port) || isProtected(rule, protectedList) || narrowed(rule)) continue;
    if (listeners.some((entry) => entry.port === rule.port && (rule.protocol === "any" || entry.protocol === rule.protocol))) continue;
    if (apps.some((app) => (app.ports ?? []).some((port) => port.port === rule.port))) continue;

    // When the rule names an app that is still installed, say where that app went instead.
    const named = apps.find((app) => typeof rule.comment === "string" && rule.comment.trim().toLowerCase() === app.name.toLowerCase());
    const movedTo = named ? (named.ports ?? []).map((port) => `${port.port}/${port.protocol}`).join(", ") : "";
    advice.push({
      id: `orphan-${rule.port}-${rule.protocol}`, level: "info",
      title: named ? `${named.name} no longer uses port ${rule.port}` : `Nothing is listening on port ${rule.port}`,
      detail: named && movedTo
        ? `This rule opens ${rule.port}/${rule.protocol} for ${named.name}, which now publishes ${movedTo}. Nothing answers on ${rule.port} any more, so the rule holds a port open for nothing. Removing it changes nothing you can reach.`
        : `A rule allows ${rule.port}/${rule.protocol}, and nothing on this server is listening there. Either whatever used it has gone, or it has not started yet. A rule for a port nothing answers is one more way in for no benefit.`,
      operationId: "firewall.rule.delete",
      parameters: { action: rule.action, port: rule.port, protocol: rule.protocol },
    });
  }

  const tailscaleAllowed = rules.some((rule) => ruleAllows(rule, tailscalePort, "udp")) || rules.some((rule) => rule.interface === "tailscale0");
  if (denyByDefault && !rules.some((rule) => ruleAllows(rule, tailscalePort, "udp"))) {
    advice.push({
      id: "tailscale-udp", level: tailscaleAllowed ? "info" : "warn", title: "Let Tailscale connect directly",
      detail: `Without ${tailscalePort}/udp open, tailnet peers still reach this server but through relays, which is slower.`,
      operationId: "firewall.rule.add", parameters: { action: "allow", port: tailscalePort, protocol: "udp", comment: "BoxPilot keeps Tailscale reachable" }, actionLabel: "Allow 41641/udp",
    });
  }

  const sshRule = rules.find((rule) => ruleAllows(rule, 22, "tcp"));
  if (sshRule && fail2ban && !(fail2ban.running && fail2ban.configured)) {
    advice.push({ id: "fail2ban", level: "info", title: "Ban repeated SSH login failures", detail: fail2ban.installed ? "fail2ban is installed but not protecting SSH. Turn it on below; your tailnet and LAN are never banned." : "Install fail2ban and turn it on below: addresses that keep failing SSH logins are blocked for a while.", focus: "fail2ban" });
  }
  // Only the plain rule from anywhere: `limit 22/tcp` replaces that one, and beside a LAN-only allow it would add a rule from anywhere.
  if (rules.some((rule) => ruleAllows(rule, 22, "tcp") && rule.action === "allow" && !narrowed(rule)) && !rules.some((rule) => ruleAllows(rule, 22, "tcp") && rule.action === "limit" && !narrowed(rule))) {
    // M90: one rule change, not a profile re-apply. `ufw limit 22/tcp` replaces the allow for the
    // same tuple; sending the owner through a high-risk profile apply for it also re-ran everything else.
    advice.push({
      id: "ssh-limit", level: "info", title: "Rate-limit SSH logins",
      detail: "Allows 6 new connections per 30 seconds per address and drops the rest, which blunts password guessing without locking you out.",
      operationId: "firewall.rule.add", parameters: { action: "limit", port: 22, protocol: "tcp", comment: "BoxPilot keeps SSH reachable rate-limited" }, actionLabel: "Rate-limit 22/tcp",
    });
  }

  if (webHost === "0.0.0.0" || webHost === "::") {
    // M90: Network, Overview has both switches; the installer flag was the long way round.
    advice.push({ id: "lan-http", level: "info", title: "BoxPilot is served over plain HTTP on the LAN", detail: `Port ${webPort} stays open so you cannot lock yourself out. To stop sending passwords in the clear, turn off LAN access, or set up HTTPS, on Network.`, focus: "network", actionLabel: "Open Network" });
  }
  return advice;
}
