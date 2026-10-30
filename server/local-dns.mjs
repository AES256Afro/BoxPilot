/**
 * Local names for the apps on this server: `jellyfin.lan` instead of `192.168.1.10:8096`.
 *
 * The DNS server BoxPilot can install is already answering for the whole house, so it is the right
 * place to put these. Pi-hole's dnsmasq is pointed at a *directory* (`hostsdir=/etc/pihole/hosts`)
 * and reads every file in it, reloading when one changes — so BoxPilot writes a file of its own
 * there and never touches `custom.list`, which is where Pi-hole's own interface puts the records a
 * person adds by hand. Two owners, two files, no argument.
 *
 * The names point at the server, not at individual apps, because that is what DNS can express: a
 * name resolves to an address, and every app here shares one. The port is still needed unless a
 * reverse proxy is doing the routing, and the interface says so rather than implying otherwise.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";

/** More than any server's names; a file past it is not one BoxPilot wrote. */
const hostsFileLimit = 256 * 1024;

/** The file BoxPilot owns inside the DNS app's hosts directory. */
export const managedHostsFile = "boxpilot.list";

/**
 * Where the records go, per DNS platform. Only the platforms whose hosts directory BoxPilot can
 * write are listed: the file lives in a managed volume, so this is an ordinary file write.
 */
export const dnsPlatforms = Object.freeze({
  "pi-hole": {
    label: "Pi-hole", volume: "etc-pihole", hostsDirectory: "hosts", reload: ["pihole", "reloaddns"],
    // Where it writes the queries it answered, and how a client address appears in that line.
    queryLog: "/var/log/pihole/pihole.log", clientPattern: /\bfrom ([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/g,
  },
});

/** Domains that are safe to claim on a home network. */
export const localDomains = Object.freeze(["lan", "home.arpa", "internal"]);

/** A hostname per app: lower case, no underscores, no leading digit trouble. */
export function nameFor(appId, domain) {
  return `${String(appId).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")}.${domain}`;
}

/**
 * The file's contents. Written whole every time and headed with a warning, because a half-updated
 * hosts file is a broken name, and because whoever opens it should know what rewrites it.
 */
export function renderHostsFile(records, { generatedAt }) {
  const lines = [
    "# Managed by BoxPilot. This whole file is rewritten when apps change.",
    "# Records you add yourself belong in custom.list, which BoxPilot never touches.",
    `# Last written ${generatedAt}`,
    "",
    ...records.map((record) => `${record.address} ${record.name}`),
    "",
  ];
  return lines.join("\n");
}

/** Parse the file back, so the panel can show what is actually in force. */
export function parseHostsFile(text) {
  return String(text ?? "").split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length >= 2)
    .map(([address, name]) => ({ address, name }));
}

export function createLocalDnsService({
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  apps = null,
  runDocker = null,
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  now = () => new Date(),
} = {}) {
  /** The installed DNS app BoxPilot can write records for, or null. */
  async function platform() {
    if (!apps) return null;
    const { applications } = await apps.inspect({}).catch(() => ({ applications: [] }));
    for (const [id, spec] of Object.entries(dnsPlatforms)) {
      const application = applications.find((entry) => entry.id === id && entry.installed);
      if (application) return { id, ...spec, running: Boolean(application.container?.running), status: application.container?.status ?? "absent" };
    }
    return null;
  }

  const fileFor = (spec) => path.join(path.resolve(catalogRoot), spec.id, spec.volume, spec.hostsDirectory, managedHostsFile);

  /**
   * The hosts folder, when it is where it should be, or null when it does not exist. It lives in the
   * DNS app's own volume, which its container writes as root: a link left there (the folder, or the
   * volume itself) would lead the root helper to read or write somewhere else, so one that resolves
   * anywhere but its own place is refused. `create` makes it when it is missing.
   */
  async function hostsFolder(spec, { create = false } = {}) {
    const root = await realpath(path.resolve(catalogRoot));
    const volume = path.join(root, spec.id, spec.volume);
    const folder = path.join(volume, spec.hostsDirectory);
    const refuse = () => { throw new Error(`${spec.label}'s hosts folder is a link to somewhere else, so BoxPilot left it alone`); };
    const realVolume = await realpath(volume).catch(() => null);
    if (realVolume !== null && realVolume !== volume) refuse();
    if (create) await mkdir(folder, { recursive: true, mode: 0o755 });
    const realFolder = await realpath(folder).catch(() => null);
    if (realFolder === null) return null;
    if (realFolder !== folder) refuse();
    return folder;
  }

  /** BoxPilot's records as the file holds them: a regular file, never through a link, bounded. */
  async function readRecords(spec) {
    const folder = await hostsFolder(spec).catch(() => null);
    if (!folder) return [];
    let handle = null;
    try {
      handle = await open(path.join(folder, managedHostsFile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > hostsFileLimit) return [];
      return parseHostsFile(await handle.readFile({ encoding: "utf8" }));
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Apps worth having a name: installed, and reachable in a browser. */
  async function nameable() {
    if (!apps) return [];
    const { applications } = await apps.inspect({}).catch(() => ({ applications: [] }));
    return applications
      .filter((application) => application.installed && (application.urls ?? []).length > 0)
      .map((application) => ({ id: application.id, name: application.name, port: application.urls[0].host }));
  }

  async function inspect() {
    const spec = await platform();
    if (!spec) return { available: false, reason: "No DNS server BoxPilot can write to is installed. Install Pi-hole from the App catalog.", platform: null, records: [], apps: await nameable() };
    const records = await readRecords(spec);
    return { available: true, reason: null, platform: { id: spec.id, label: spec.label, running: spec.running }, file: fileFor(spec), records, apps: await nameable() };
  }

  /**
   * Rewrite the records for every installed app. `address` comes from the caller: this process runs
   * with a private network namespace and cannot see the host's interfaces, so the side that can is
   * the side that says what the server's address is.
   */
  async function apply({ address, domain = "lan", ids = null }, { progress = null } = {}) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address ?? ""))) throw new Error("A LAN address for this server is required, for example 192.168.1.10");
    if (!localDomains.includes(domain)) throw new Error(`Domain must be one of ${localDomains.join(", ")}`);
    const spec = await platform();
    if (!spec) throw new Error("No DNS server BoxPilot can write to is installed");

    const chosen = await nameable();
    const wanted = (Array.isArray(ids) ? chosen.filter((app) => ids.includes(app.id)) : chosen)
      .map((app) => ({ ...app, name: nameFor(app.id, domain), address }));
    const folder = await hostsFolder(spec, { create: true });
    const file = path.join(folder, managedHostsFile);
    // Written to a neighbouring file and moved into place: dnsmasq watches this directory, and a
    // partially written file is a name that does not resolve. The neighbour's name is new every
    // time and created only if nothing is there, so nothing the app left in its folder is written
    // through; the rename replaces whatever sits at the file's own name, a link included.
    const contents = renderHostsFile(wanted, { generatedAt: now().toISOString() });
    const temporary = path.join(folder, `.${managedHostsFile}.${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { mode: 0o644, flag: "wx" });
    await rename(temporary, file).catch(async (error) => { await unlink(temporary).catch(() => {}); throw error; });
    progress?.(`Wrote ${wanted.length} name${wanted.length === 1 ? "" : "s"} to ${file}`, "stdout");

    // dnsmasq notices the directory changing on its own; the reload is a belt-and-braces nudge and
    // its failure is not the operation's failure.
    let reloaded = false;
    if (runDocker && spec.running) {
      const result = await runDocker(dockerBinary, ["exec", `bp-${spec.id}`, ...spec.reload], { timeout: 60_000 }).catch(() => ({ ok: false }));
      reloaded = Boolean(result.ok);
      progress?.(reloaded ? "Asked the DNS server to reload." : "The DNS server did not reload on request; it watches the file and will pick the change up shortly.", reloaded ? "stdout" : "stderr");
    }
    return { applied: true, domain, address, reloaded, records: wanted.map((app) => ({ name: app.name, address, port: app.port })) };
  }

  /**
   * Which devices are actually asking this blocker anything.
   *
   * A blocker can be installed, healthy, answering and blocking, and still be used by nobody —
   * because the router is handing out its own address, or somebody else's, instead. Everything the
   * blocker can tell you about itself looks identical in both cases, which is a long evening for
   * whoever is trying to work out why nothing is being blocked.
   *
   * The one signal that separates them is who has asked it. Loopback and this server's own address
   * are set aside: BoxPilot's own checks come from there, so counting them would report a blocker
   * as busy on the strength of its own health checks.
   */
  async function clients({ selfAddress = null, lines = 4000 } = {}) {
    const spec = await platform();
    if (!spec) return { available: false, reason: "No DNS server BoxPilot can read is installed.", platform: null, clients: [], self: 0 };
    if (!runDocker || !spec.running) {
      return { available: false, reason: `${spec.label} is not running, so there is nothing to read.`, platform: { id: spec.id, label: spec.label, running: spec.running }, clients: [], self: 0 };
    }
    const result = await runDocker(dockerBinary, ["exec", `bp-${spec.id}`, "tail", "-n", String(lines), spec.queryLog], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => null);
    if (!result?.ok) {
      // Unreadable is not the same as unused, and saying "nobody is using it" on the strength of a
      // failed read is the kind of invented alarm this codebase has shipped before.
      return { available: false, reason: `Could not read ${spec.label}'s query log.`, platform: { id: spec.id, label: spec.label, running: true }, clients: [], self: 0 };
    }
    const counts = new Map();
    let self = 0;
    for (const match of String(result.stdout).matchAll(spec.clientPattern)) {
      const address = match[1];
      if (address === "127.0.0.1" || address === selfAddress) { self += 1; continue; }
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    const found = [...counts.entries()].map(([address, queries]) => ({ address, queries })).sort((a, b) => b.queries - a.queries);
    return { available: true, reason: null, platform: { id: spec.id, label: spec.label, running: true }, clients: found, self };
  }

  /** Take BoxPilot's names out of DNS again, leaving anything hand-written alone. */
  async function clear({ progress = null } = {}) {
    const spec = await platform();
    if (!spec) throw new Error("No DNS server BoxPilot can write to is installed");
    const folder = await hostsFolder(spec);
    if (folder) await unlink(path.join(folder, managedHostsFile)).catch(() => {});
    progress?.(`Removed ${fileFor(spec)}`, "stdout");
    if (runDocker && spec.running) await runDocker(dockerBinary, ["exec", `bp-${spec.id}`, ...spec.reload], { timeout: 60_000 }).catch(() => {});
    return { cleared: true };
  }

  return { inspect, apply, clear, clients, internals: { platform, nameable, fileFor } };
}
