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

/** Rules BoxPilot always keeps open (or, for the web port, refuses to deny). */
export function protectedRules({ webPort = defaultWebPort, webHost = "127.0.0.1" } = {}) {
  const lanWeb = webHost === "0.0.0.0" || webHost === "::";
  return [
    { port: 22, protocol: "tcp", label: "SSH", reason: "Your way back in if the web UI ever breaks.", allow: true },
    { port: tailscalePort, protocol: "udp", label: "Tailscale", reason: "WireGuard port; without it tailnet traffic falls back to relays.", allow: true },
    { port: webPort, protocol: "tcp", label: "BoxPilot", reason: lanWeb ? "This page. BoxPilot is served on the LAN, so the port stays open." : "This page. Served via Tailscale or an SSH tunnel, so no LAN rule is needed, but it can never be denied.", allow: lanWeb },
  ];
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
 * Build the ordered ufw argv list for applying a profile. Pure, so the preview and the root
 * task agree on exactly what runs. Protected allows come first; `ufw enable` comes last and
 * only after every rule succeeded, so a half-applied plan fails open, never closed.
 */
export function buildPlan({ profileId, serviceIds: chosen = [], replace = false, sshRateLimit = false, webPort = defaultWebPort, webHost = "127.0.0.1" } = {}) {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown firewall profile: ${profileId}`);
  const unknown = chosen.filter((id) => !serviceIds.includes(id));
  if (unknown.length) throw new Error(`Unknown services: ${unknown.join(", ")}`);
  const protectedList = protectedRules({ webPort, webHost });
  const steps = [];
  if (replace) steps.push({ args: ["--force", "reset"], label: "Remove every existing rule and start from the profile" });
  for (const entry of protectedList) {
    if (!entry.allow) continue;
    if (entry.port === 22 && sshRateLimit) {
      // Rate-limited SSH is still an allow (6 new connections per 30 s per address). Insert it
      // first, then drop the plain allow so the limit rule is the one that matches.
      steps.push({ args: ["insert", "1", "limit", "22/tcp", "comment", "BoxPilot keeps SSH reachable (rate-limited)"], label: "Keep SSH reachable, rate-limited against password guessing" });
      steps.push({ args: ["--force", "delete", "allow", "22/tcp"], label: "Drop the plain SSH allow in favour of the rate-limited one", tolerateFailure: true });
      continue;
    }
    steps.push({ args: ["allow", spec(entry), "comment", `BoxPilot keeps ${entry.label} reachable`], label: `Keep ${entry.label} reachable (${spec(entry)})` });
  }
  steps.push({ args: ["allow", "in", "on", "tailscale0", "comment", "BoxPilot keeps the tailnet reachable"], label: "Keep the tailnet interface reachable", tolerateFailure: true });
  for (const rule of profile.rules) {
    steps.push({ args: [rule.action, spec(rule), ...(rule.comment ? ["comment", rule.comment] : [])], label: `${rule.action} ${spec(rule)}${rule.comment ? ` (${rule.comment.replace(/^BoxPilot profile: /, "")})` : ""}` });
  }
  const effectiveServices = profile.lockServices ? [] : chosen;
  for (const id of effectiveServices) {
    const service = services.find((entry) => entry.id === id);
    for (const port of service.ports) steps.push({ args: ["allow", spec(port), "comment", `BoxPilot service: ${service.name}`], label: `Allow ${service.name} (${spec(port)})` });
  }
  steps.push({ args: ["default", profile.defaults.incoming, "incoming"], label: `Default incoming: ${profile.defaults.incoming}` });
  steps.push({ args: ["default", profile.defaults.outgoing, "outgoing"], label: `Default outgoing: ${profile.defaults.outgoing}` });
  steps.push({ args: ["--force", "enable"], label: "Turn the firewall on" });
  return { profile: { id: profile.id, name: profile.name }, services: effectiveServices, protected: protectedList, steps };
}

function ruleAllows(rule, port, protocol) {
  return ["allow", "limit"].includes(rule.action) && rule.port === port && (rule.protocol === "any" || rule.protocol === protocol) && !rule.interface && rule.direction !== "out";
}

/**
 * Suggestions for the Firewall page. Every entry has a stable id, a level, copy, and where
 * possible a one-click action (`operationId` + `parameters`) or a `focus` hint for the UI.
 *
 * @param {object} input
 * @param {object|null} input.report   firewall.inspect result
 * @param {Array} input.listeners      listListeners() result from the web process
 * @param {Array} input.apps           installed apps: [{ id, name, ports: [{ port, protocol, label }] }]
 * @param {object|null} input.current  the stored profile setting, if any
 */
export function adviseFirewall({ report, listeners = [], apps = [], current = null, fail2ban = null, webPort = defaultWebPort, webHost = "127.0.0.1" } = {}) {
  const advice = [];
  if (!report || !report.installed) {
    advice.push({ id: "install", level: "action", title: "Install ufw", detail: "BoxPilot manages the firewall through ufw. Installing it does not turn it on.", focus: "install" });
    return advice;
  }
  const protectedList = protectedRules({ webPort, webHost });
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
    const open = rules.some((rule) => ruleAllows(rule, entry.port, entry.protocol));
    const listening = exposed.some((listener) => listener.port === entry.port && listener.protocol === entry.protocol);
    if (open && !isProtected(entry, protectedList)) {
      const rule = rules.find((candidate) => ruleAllows(candidate, entry.port, entry.protocol));
      advice.push({
        id: `risky-allow-${entry.port}-${entry.protocol}`, level: "warn", title: `${entry.label} is open to the whole LAN`,
        detail: `Port ${entry.port}/${entry.protocol} has an allow rule. Services like this should only be reached from this server or over Tailscale.`,
        operationId: "firewall.rule.delete", parameters: { action: rule.action, port: entry.port, protocol: rule.protocol ?? entry.protocol }, actionLabel: "Remove the rule",
      });
    } else if (!denyByDefault && listening) {
      advice.push({
        id: `risky-listen-${entry.port}-${entry.protocol}`, level: "warn", title: `${entry.label} is reachable from the LAN`,
        detail: `Something is listening on ${entry.port}/${entry.protocol} and the default policy lets it through.`,
        operationId: "firewall.rule.add", parameters: { action: "deny", port: entry.port, protocol: entry.protocol, comment: `BoxPilot: block ${entry.label}`.slice(0, 60) }, actionLabel: "Block it",
      });
    }
  }

  if (denyByDefault) {
    for (const app of apps) {
      for (const port of app.ports ?? []) {
        if (rules.some((rule) => ruleAllows(rule, port.port, port.protocol))) continue;
        advice.push({
          id: `app-${app.id}-${port.port}-${port.protocol}`, level: "info", title: `${app.name} is blocked for other devices`,
          detail: `${app.name} publishes ${port.label ?? "a port"} on ${port.port}/${port.protocol} but no rule allows it, so only this server and Tailscale can reach it. Allow it if other devices should.`,
          operationId: "firewall.rule.add", parameters: { action: "allow", port: port.port, protocol: port.protocol, comment: app.name.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 60) || app.id }, actionLabel: `Allow ${app.name}`,
        });
      }
    }
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
  if (sshRule && sshRule.action === "allow") {
    advice.push({ id: "ssh-limit", level: "info", title: "Rate-limit SSH logins", detail: "Allows 6 new connections per 30 seconds per address and drops the rest, which blunts password guessing without locking you out. Apply a profile with the rate-limit option ticked.", focus: "profiles" });
  }

  if (webHost === "0.0.0.0" || webHost === "::") {
    advice.push({ id: "lan-http", level: "info", title: "BoxPilot is served over plain HTTP on the LAN", detail: `Port ${webPort} stays open so you cannot lock yourself out. For HTTPS and no LAN exposure, re-run the installer with --access tailscale.` });
  }
  return advice;
}
