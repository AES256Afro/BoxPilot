/**
 * The runbook for this server (M34.4): a Markdown document built from what BoxPilot knows - what
 * is installed, where each app keeps its data, who can reach what, how backups run and where the
 * copies are, and how to put each thing back - written for whoever restores this server at 2 a.m.
 *
 * Pure: facts in, Markdown out, with the clock passed in. Gathering the facts, and masking every
 * stored parameter set with secretPaths/maskSecrets before it reaches this file, is
 * server/runbook-service.mjs's job. This file adds its own guards on top: it never prints an
 * environment value, a username, a key or a token, only where one is kept.
 *
 * A fact that could not be read is printed as "unknown (why)", never left out: a runbook that
 * silently skips the part it could not see reads as though there was nothing there.
 */
import { createHash } from "node:crypto";

/** The document's sections, in order. The first six are fingerprinted; the last two are derived or momentary. */
export const runbookSections = Object.freeze([
  { id: "server", title: "This server" },
  { id: "apps", title: "Apps" },
  { id: "storage", title: "Storage" },
  { id: "network", title: "Network and firewall" },
  { id: "backups", title: "Backups and the second copy" },
  { id: "automation", title: "Automation" },
  { id: "restore", title: "How to restore" },
  { id: "issues", title: "Known issues right now" },
]);

/**
 * Operations whose completion changes what the runbook says: what is installed and how it is
 * reached, what is mounted, the firewall, and where the copies go. A backup, a drill or a restart
 * does not make the document wrong; these do. Every id is checked against the registry in tests.
 */
export const layoutOperations = Object.freeze([
  "app.install", "app.reinstall", "app.uninstall", "app.purge", "app.update", "app.rollback", "app.reconfigure", "app.exposure.set", "app.serve.set", "app.serve.withdraw", "app.compose.edit", "app.backup.restore",
  "host.snapshot.restore",
  "storage.mount", "storage.unmount", "storage.writable", "storage.format", "storage.lvm.extend", "share.mount", "share.unmount",
  "samba.apply", "samba.share.writable", "nfs.apply",
  "firewall.set", "firewall.rule.add", "firewall.rule.delete", "firewall.profile.apply",
  "tailscale.set", "system.web.lan.set", "system.web.tls.provision", "system.hostname.set",
  "backup.remote.setup", "backup.cloud.setup",
]);

// ---- words ----

/** One line of text from a fact: no control characters, no line breaks, no credentials in a URL. */
export function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
const code = (value) => `\`${clean(value, 400).replaceAll("`", "'")}\``;
const cell = (value) => clean(value).replaceAll("|", "\\|");
const unknown = (reason) => `unknown (${clean(reason)})`;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const sentence = (text) => { const value = clean(text, 1200); return value && !/[.!?]$/.test(value) ? `${value}.` : value; };

/** "2026-09-28 03:00 UTC", or null. UTC so the same facts always print the same document. */
export function formatTime(iso) {
  const time = Date.parse(iso ?? "");
  if (!Number.isFinite(time)) return null;
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
const timeOr = (iso, reason) => formatTime(iso) ?? unknown(reason);

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index += 1; }
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** What approving an operation takes, in the words the approval dialog uses. */
export function approvalFor(operation) {
  if (!operation) return "not available in this BoxPilot";
  if (operation.readOnly) return operation.minimumRole === "operator" ? "a read, for an operator or the owner" : operation.minimumRole === "owner" ? "a read, for the owner" : "a read";
  const how = { low: "low risk, one click", medium: "medium risk, one confirmation", high: `high risk, the owner's password${operation.confirm ? " and a typed confirmation" : ""}` }[operation.risk] ?? `${clean(operation.risk)} risk`;
  return operation.minimumRole === "owner" && operation.risk !== "high" ? `${how}, owner only` : how;
}

/** An operation named the way a person looks for it: its title, its id, and what approving it takes. */
function action(operations, id) {
  const operation = operations?.[id];
  return `**${clean(operation?.title ?? id)}** (${code(id)}; ${approvalFor(operation)})`;
}

const reachWords = Object.freeze({ loopback: "this server only", lan: "LAN", tailnet: "tailnet address", host: "every address (host network)" });
const outcomeWords = Object.freeze({ ran: "ran", failed: "failed", "did-not-run": "did not run", running: "running", unknown: "not known" });

// ---- the audience ----

/**
 * The facts as an operator may read them (M29.4, ADR-003). The layout is theirs to read: every part
 * of it is on a page they can open. Two things are not. Where the second copies are kept is the
 * owner's: with the rest of this document it is the map to every copy of the data, and it goes in
 * the owner's download, as the recovery kit does. And another account's work - its schedules'
 * parameters and results, and the words of an alert about it - is the owner's to see, as on
 * /schedules and /settings/watch. The owner gets the facts unchanged.
 */
export function forAudience(facts, { audience = "owner", callerId = null } = {}) {
  if (audience === "owner") return { ...facts, audience: "owner" };
  const own = (createdBy) => Boolean(callerId) && createdBy === callerId;
  const automation = facts.automation ?? {};
  const issues = facts.issues ?? {};
  // The same rule as GET /settings/watch: the words of an alert about another account's work go
  // to the owner and that account; everyone else reads what kind of thing it is.
  const titleFor = (entry) => {
    if (entry.family === "schedule.failed" || entry.family === "schedule.overdue") return own(entry.scheduleCreatedBy) ? entry.title : entry.label;
    if (entry.family === "signin.new") return own(entry.subject) ? entry.title : entry.label;
    if (entry.family === "job.interrupted" || entry.family === "record.failed") return entry.label;
    return entry.title;
  };
  // A schedule someone else set up is shown as what it does and when, without its parameters.
  const scheduleFor = (schedule) => (own(schedule.createdBy) ? schedule : { ...schedule, parameters: {}, keep: null, outcome: null, lastRunAt: null, foreign: true });
  const apps = facts.apps?.items
    ? { ...facts.apps, items: facts.apps.items.map((app) => (app.backups?.schedules ? { ...app, backups: { ...app.backups, schedules: app.backups.schedules.map(scheduleFor) } } : app)) }
    : facts.apps;
  return {
    ...facts,
    audience: "operator",
    apps,
    backups: facts.backups ? { ...facts.backups, destinations: (facts.backups.destinations ?? []).map((destination) => ({ ...destination, where: null, credential: null, whereWithheld: Boolean(destination.where) })) } : facts.backups,
    automation: {
      ...automation,
      schedules: (automation.schedules ?? []).map(scheduleFor),
      flows: (automation.flows ?? []).map((flow) => (own(flow.createdBy) ? flow : { ...flow, lastRunAt: null, foreign: true })),
    },
    issues: {
      ...issues,
      conditions: (issues.conditions ?? []).map((entry) => ({ ...entry, title: titleFor(entry) })),
      notices: (issues.notices ?? []).map((entry) => ({ ...entry, title: titleFor(entry) })),
    },
  };
}

// ---- the fingerprint ----

/** JSON with every object's keys sorted, so the same facts always hash the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

/**
 * What each section says about where things are, without what they are doing this minute: which
 * apps, images, ports, folders, drives, rules, destinations and schedules - not whether a container
 * is running, how full a disk is, when the last backup ran or what SMART read this morning. Those
 * are true for a moment; the rest is what makes a printed copy wrong when it changes.
 */
const stableSections = {
  server: (facts) => {
    const server = facts.server ?? {};
    return {
      version: facts.version ?? null,
      host: server.host?.available === false ? { unknown: true } : { hostname: server.host?.hostname ?? null, operatingSystem: server.host?.operatingSystem ?? null },
      databasePath: server.databasePath ?? null,
      roots: Object.fromEntries(Object.entries(server.roots ?? {}).map(([key, root]) => [key, root?.path ?? null])),
      reach: (server.reach?.ways ?? []).map((way) => way.url),
      lan: (server.lan?.addresses ?? []).map((entry) => entry.address),
      tailnet: { dnsName: server.tailnet?.dnsName ?? null, address: server.tailnet?.address ?? null },
    };
  },
  apps: (facts) => (facts.apps?.available === false ? { unknown: true } : (facts.apps?.items ?? []).map((app) => ({
    id: app.id, image: app.image?.reference ?? null, exposure: app.exposure ?? null, networkMode: app.networkMode ?? null,
    ports: (app.ports ?? []).map((port) => [port.host, port.protocol, port.reach, port.tailnetHttps ?? null]),
    data: (app.data ?? []).map((folder) => [folder.path, folder.backedUp, folder.mount?.target ?? null]),
  }))),
  storage: (facts) => (facts.storage?.available === false ? { unknown: true } : {
    drives: (facts.storage?.drives ?? []).map((drive) => [drive.name, drive.target, drive.device, drive.fstype, drive.autoReconnect?.armed === true]),
    shares: (facts.storage?.shares ?? []).map((share) => [share.name, share.target, share.source]),
  }),
  network: (facts) => {
    const network = facts.network ?? {};
    const firewall = network.firewall ?? {};
    return {
      firewall: firewall.available === false ? { unknown: true } : { installed: firewall.installed ?? null, enabled: firewall.enabled ?? null, defaults: firewall.defaults ?? null, rules: (firewall.rules ?? []).map((rule) => [rule.action, rule.port, rule.protocol, rule.app, rule.direction, rule.interface, rule.family]), profile: firewall.profile ? [firewall.profile.id, firewall.profile.edited === true] : null },
      serves: network.serves?.available === false ? { unknown: true } : (network.serves?.items ?? []).map((serve) => serve.url),
      tunnel: network.tunnel?.installed ?? null,
      // Only once something is published, so a runbook from before M42 is not marked out of date for nothing.
      ...((network.tunnel?.published?.items ?? []).length ? { published: network.tunnel.published.items.map((item) => item.url) } : {}),
      routes: network.tailscale?.advertisedRoutes ?? [],
    };
  },
  backups: (facts) => {
    const backups = facts.backups ?? {};
    return {
      destinations: (backups.destinations ?? []).map((destination) => [destination.kind, destination.configured !== false, destination.where ?? null]),
      snapshotRoot: backups.snapshots?.root ?? null,
      snapshotKeep: backups.snapshots?.keep ?? null,
      protectedDatabase: Boolean(backups.database?.protected),
    };
  },
  automation: (facts) => ({
    schedules: (facts.automation?.schedules ?? []).map((schedule) => [schedule.id, schedule.operationId, schedule.cadence, schedule.enabled, schedule.subject ?? null, schedule.keep ?? null]),
    flows: (facts.automation?.flows ?? []).map((flow) => [flow.id, flow.name, flow.trigger, flow.enabled, (flow.steps ?? []).map((step) => [step.operationId, step.subject ?? null])]),
  }),
};

/** A digest per section, and one over them all: the fingerprint printed in the document. */
export function runbookFingerprint(facts) {
  const sections = Object.fromEntries(Object.entries(stableSections).map(([id, project]) => [id, digest(project(facts ?? {}))]));
  return { digest: digest(sections), sections };
}

/** The sections whose digest differs from a recorded fingerprint, by title. */
export function changedSections(recorded, current) {
  if (!recorded?.sections || !current?.sections) return [];
  return runbookSections.filter((section) => Object.hasOwn(current.sections, section.id) && recorded.sections[section.id] !== current.sections[section.id]).map((section) => section.title);
}

/**
 * The cheap half of "out of date" (no helper call, SQLite only): digests of what BoxPilot's own
 * records say about the automation, the second-copy destinations and the firewall profile. Stored
 * beside the fingerprint at download, compared on every status read.
 */
export function storeMarkers({ schedules = [], flows = [], backupDestination = null, cloudDestination = null, firewallProfile = null } = {}) {
  return {
    automation: digest({
      schedules: schedules.map((schedule) => [schedule.id, schedule.operationId, schedule.frequency, schedule.minute, schedule.hour ?? null, schedule.weekday ?? null, schedule.enabled !== false, schedule.parameters ?? {}]),
      flows: flows.map((flow) => [flow.id, flow.name, flow.frequency ?? null, flow.minute ?? null, flow.hour ?? null, flow.weekday ?? null, flow.enabled !== false, flow.triggerFlowId ?? null, flow.triggerDrive ?? null, Boolean(flow.webhookEnabled), (flow.steps ?? []).map((step) => [step.operationId, step.parameters ?? {}])]),
    }),
    destinations: digest({
      ssh: backupDestination ? [backupDestination.host ?? null, backupDestination.port ?? null, backupDestination.path ?? null] : null,
      cloud: cloudDestination ? [cloudDestination.provider ?? null, cloudDestination.bucket ?? null, cloudDestination.path ?? null, cloudDestination.url ?? null, cloudDestination.endpoint ?? null] : null,
    }),
    firewall: digest(firewallProfile ? [firewallProfile.id ?? null, firewallProfile.appliedAt ?? null, firewallProfile.editedAt ?? null] : null),
  };
}

const markerChanges = Object.freeze({ automation: "Schedules or automations changed", destinations: "A backup destination changed", firewall: "The firewall profile changed" });

/**
 * What has changed since the document was last downloaded, oldest first; empty when nothing has.
 * `record` is what the download stored: when, from which version, and the store markers then.
 * `jobs` are recent jobs, newest first as the store lists them. An operator is told what kind of
 * change it was (the operation's title) unless the job was their own; a job's title can name
 * another account's work, which is the owner's to see.
 */
export function changesSince(record, { jobs = [], markers = {}, markerTimes = {}, version = null, operations = {}, audience = "owner", callerId = null } = {}) {
  if (!record?.at) return [];
  const since = Date.parse(record.at);
  const changes = [];
  if (record.version && version && record.version !== version) changes.push({ kind: "version", at: null, change: `BoxPilot changed from ${clean(record.version)} to ${clean(version)}` });
  for (const job of jobs) {
    if (job?.state !== "completed") continue;
    const operationId = String(job.type ?? "").replace(/^op:/, "");
    if (!layoutOperations.includes(operationId)) continue;
    const at = Date.parse(job.updatedAt ?? "");
    if (!(Number.isFinite(at) && at > since)) continue;
    const own = audience === "owner" || (Boolean(callerId) && job.createdBy === callerId);
    changes.push({ kind: "job", at: new Date(at).toISOString(), change: clean(own ? job.title : operations[operationId]?.title ?? operationId, 160) });
  }
  for (const [name, change] of Object.entries(markerChanges)) {
    if (record.markers?.[name] === undefined || markers[name] === undefined || record.markers[name] === markers[name]) continue;
    const at = Date.parse(markerTimes[name] ?? "");
    changes.push({ kind: name, at: Number.isFinite(at) && at > since ? new Date(at).toISOString() : null, change });
  }
  // Oldest first; a change whose time is not recorded goes last rather than pretending to a time.
  return changes.sort((a, b) => (a.at === null) - (b.at === null) || String(a.at).localeCompare(String(b.at)));
}

/** "Out of date since ..." for the page: the first change, and how many more. Null when up to date. */
export function outOfDate(changes) {
  if (!changes?.length) return null;
  const [first, ...rest] = changes;
  return { since: first.at, change: first.change, more: rest.length };
}

// ---- the document ----

function renderServer(facts, lines) {
  const server = facts.server ?? {};
  const host = server.host ?? {};
  const hostReason = host.reason ?? "the host inventory could not be read";
  lines.push("## 1. This server", "");
  lines.push(`- Hostname: ${host.hostname ? code(host.hostname) : unknown(hostReason)}`);
  const kernel = host.kernel ? ` (kernel ${clean(host.kernel)}${host.architecture ? `, ${clean(host.architecture)}` : ""})` : "";
  lines.push(`- Operating system: ${host.operatingSystem ? `${clean(host.operatingSystem)}${kernel}` : unknown(hostReason)}`);
  lines.push(`- BoxPilot: ${clean(facts.version) || unknown("the version was not recorded")}`);
  lines.push(`- BoxPilot's database: ${server.databasePath ? `${code(server.databasePath)} (live; never copy this file while BoxPilot runs, restore a backup of it instead)` : unknown("the database path was not recorded")}`);
  const roots = server.roots ?? {};
  for (const [key, label] of [["databaseBackups", "Database backups"], ["appBackups", "App backups (one folder per app)"], ["machineSnapshots", "Machine snapshots"], ["appData", "App data (one folder per app, with its compose project and `.env`)"]]) {
    const root = roots[key];
    lines.push(`- ${label}: ${root?.path ? code(root.path) : unknown(root?.reason ?? "not recorded")}`);
  }
  lines.push("", "### How BoxPilot is reached", "");
  if (server.reach?.available === false) lines.push(`- ${sentence(`How to reach BoxPilot is ${unknown(server.reach.reason ?? "the network could not be read")}`)}`);
  else for (const way of server.reach?.ways ?? []) lines.push(`- ${clean(way.label)}: ${clean(way.url)} (${clean(way.scope).toLowerCase()})`);
  const lan = server.lan ?? {};
  lines.push(`- LAN address: ${lan.available === false ? unknown(lan.reason ?? "the network could not be read") : (lan.addresses ?? []).length ? lan.addresses.map((entry) => `${clean(entry.address)}${entry.interface ? ` (${clean(entry.interface)})` : ""}`).join(", ") : "none found"}`);
  const tailnet = server.tailnet ?? {};
  if (tailnet.available === false) lines.push(`- Tailnet: ${unknown(tailnet.reason ?? "Tailscale could not be read")}`);
  else if (!tailnet.connected) lines.push("- Tailnet: not connected");
  else lines.push(`- Tailnet: ${tailnet.dnsName ? code(tailnet.dnsName) : unknown("Tailscale reported no name")}${tailnet.address ? ` (${clean(tailnet.address)})` : ""}, connected`);
  lines.push("");
}

function exposureSentence(app) {
  if (app.networkMode === "host") return "the server's own network. Its ports answer on every address of this server; the firewall decides who gets through.";
  if (app.exposure === "tailnet") return "tailnet only. Its web ports answer only on this server, and Tailscale publishes them on the tailnet over HTTPS, so Tailscale checks every visitor first.";
  if (app.exposure === "lan") return "home network. Its ports listen on every address of this server, so devices on the LAN and on the tailnet can reach them; the firewall decides who gets through.";
  return `${unknown("its exposure setting was not recorded")}.`;
}

function renderDataFolder(folder) {
  const kind = folder.managed ? "managed by BoxPilot" : "a folder you chose";
  const backed = folder.backedUp ? "in its backups" : folder.managed ? "not backed up (a cache, or it can be downloaded again)" : "not in its backups";
  const where = folder.mount ? `; on ${folder.mount.drive ? `drive ${code(folder.mount.drive)} (${code(folder.mount.target)})` : `the filesystem at ${code(folder.mount.target)}`}` : folder.mountReason ? `; drive ${unknown(folder.mountReason)}` : "";
  return `  - ${clean(folder.label)}: ${folder.path ? code(folder.path) : unknown(folder.reason ?? "its folder was not reported")}, ${kind}${folder.readOnly ? ", read-only" : ""}, ${backed}${where}`;
}

const capitalized = (text) => text.replace(/^./, (letter) => letter.toUpperCase());

function backupLine(app) {
  const backups = app.backups ?? {};
  if (backups.available === false) return `- Backups: ${unknown(backups.reason ?? "the backup folder could not be read")}.`;
  if (backups.protectable === false) return "- Backups: nothing to back up; what it keeps is a cache or can be downloaded again.";
  const parts = [];
  if (!backups.count) parts.push(`none yet${backups.directory ? `; they would go in ${code(backups.directory)}` : ""}`);
  else parts.push(`${plural(backups.count, "backup")}${backups.directory ? ` in ${code(backups.directory)}` : ""}, newest ${timeOr(backups.newestAt, "its time was not recorded")}${backups.newestArtifact ? ` (${code(backups.newestArtifact)})` : ""}`);
  const schedules = backups.schedules ?? [];
  parts.push(schedules.length ? `scheduled ${schedules.map((schedule) => `${clean(schedule.cadence)}${schedule.keep ? `, keeping ${schedule.keep}` : ""}${schedule.enabled === false ? " (paused)" : ""}${schedule.foreign ? " (set up by another account)" : ""}`).join("; ")}` : "no schedule");
  const drill = backups.verification;
  parts.push(drill ? `last restore drill ${timeOr(drill.checkedAt, "its time was not recorded")}: ${drill.verified ? "passed" : "failed"}` : "no restore drill recorded");
  return `- Backups: ${parts.map(capitalized).join(". ")}.`;
}

function renderApps(facts, lines) {
  const apps = facts.apps ?? {};
  lines.push("## 2. Apps", "");
  if (apps.available === false) { lines.push(sentence(`Installed apps: ${unknown(apps.reason ?? "the app inventory could not be read")}`), ""); return; }
  const items = apps.items ?? [];
  if (!items.length) { lines.push("No catalog app is installed.", ""); return; }
  lines.push(`${plural(items.length, "catalog app")} installed. Each keeps its compose project and its \`.env\` (which holds the passwords it generated) in its own folder under the app data folder, readable only by root.`, "");
  for (const app of items) {
    lines.push(`### ${clean(app.name) || clean(app.id)} (${code(app.id)})`, "");
    if (app.description) lines.push(sentence(clean(app.description, 300)), "");
    const image = app.image?.reference ? `${code(app.image.reference)}${app.image.version ? ` (version ${clean(app.image.version)})` : ""}` : unknown("the installed image was not recorded");
    lines.push(`- Image: ${image}. Container: ${app.container ? clean(app.container) : unknown("the container state could not be read")}.`);
    lines.push(`- Reach: ${exposureSentence(app)}`);
    for (const port of app.ports ?? []) {
      const tailnet = port.tailnetHttps ? `; on the tailnet at ${clean(port.tailnetHttps)}` : "";
      lines.push(`  - ${clean(port.label)}: ${Number.isInteger(port.host) ? port.host : unknown("no host port recorded")}/${clean(port.protocol)}, ${reachWords[port.reach] ?? unknown("its binding was not recorded")}${tailnet}`);
    }
    if (!(app.ports ?? []).length) lines.push("  - No ports.");
    lines.push(`- Data:${(app.data ?? []).length ? "" : " no folders."}`);
    for (const folder of app.data ?? []) lines.push(renderDataFolder(folder));
    const pointer = `App catalog → ${clean(app.name) || clean(app.id)}`;
    if (app.signIn) lines.push(`- Sign-in: ${pointer} → Sign in. The password is in the app's \`.env\`; BoxPilot shows it there to the owner, after the owner's password.${app.signIn.note ? ` ${sentence(app.signIn.note)}` : ""}`);
    else lines.push("- Sign-in: set up in the app itself; BoxPilot keeps no sign-in for it.");
    if ((app.secretNames ?? []).length) lines.push(`- Secrets it holds: ${app.secretNames.map((name) => code(name)).join(", ")}, kept in its \`.env\`; ${pointer} → Secrets shows them to the owner.`);
    lines.push(backupLine(app), "");
  }
}

function renderStorage(facts, lines) {
  const storage = facts.storage ?? {};
  lines.push("## 3. Storage", "");
  const smart = storage.smart ?? {};
  lines.push(`SMART: ${smart.available === false ? unknown(smart.reason ?? "no SMART reading") : `${clean(smart.status) || "unknown"}${formatTime(smart.checkedAt) ? ` (read ${formatTime(smart.checkedAt)})` : ""}`}.`, "");
  if (storage.available === false) { lines.push(sentence(`Drives and mounts: ${unknown(storage.reason ?? "the drives could not be read")}`), ""); return; }
  const smartOf = (entry) => (entry.smart ? `SMART: ${clean(entry.smart.health)}` : `SMART: ${unknown(entry.smartReason ?? "no reading for this disk")}`);
  const holds = (entry) => ((entry.holds ?? []).length ? `\n  - Holds: ${entry.holds.map((item) => clean(item)).join("; ")}` : "\n  - Holds: nothing BoxPilot knows of");
  lines.push("### Drives BoxPilot manages", "");
  const drives = storage.drives ?? [];
  if (!drives.length) lines.push("- None: no drive is mounted through BoxPilot.");
  for (const drive of drives) {
    const state = drive.mounted === null || drive.mounted === undefined ? `mount ${unknown("the current mounts could not be read")}` : drive.mounted ? `mounted ${drive.readOnly ? "read-only" : "read-write"}` : "not mounted now";
    const size = formatBytes(drive.sizeBytes);
    const free = formatBytes(drive.availableBytes);
    const disk = drive.disk ? `, on ${code(drive.disk)}${drive.model ? ` (${clean(drive.model)}${drive.transport ? `, ${clean(drive.transport)}` : ""})` : ""}` : `, disk ${unknown("the device could not be matched to a disk")}`;
    const reconnect = drive.autoReconnect?.armed ? `armed${drive.autoReconnect.enabled === false ? " but paused" : ""}${drive.autoReconnect.held ? `, holding: ${clean(drive.autoReconnect.heldBecause ?? "waiting for a person")}` : ""}` : "not armed";
    lines.push(`- ${code(drive.name)} at ${code(drive.target)}: ${clean(drive.fstype) || "unknown filesystem"} from ${code(drive.device)}${disk}. ${capitalized(state)}${size ? `, ${size}` : ""}${free ? `, ${free} free when generated` : ""}. ${smartOf(drive)}. Auto-reconnect: ${reconnect}.${holds(drive)}`);
  }
  const others = storage.others ?? [];
  if (others.length) {
    lines.push("", "### Other filesystems that hold something in this document", "");
    for (const mount of others) lines.push(`- ${code(mount.target)} from ${code(mount.source)} (${clean(mount.fstype) || "unknown filesystem"})${mount.disk ? `, on ${code(mount.disk)}` : ""}. ${smartOf(mount)}.${holds(mount)}`);
  }
  const shares = storage.shares ?? [];
  if (shares.length) {
    lines.push("", "### Network shares BoxPilot mounted", "");
    for (const share of shares) lines.push(`- ${code(share.name)} at ${code(share.target)}: ${share.kind === "smb" ? "SMB" : "NFS"} from ${code(share.source)}, ${share.mounted ? "mounted" : "not mounted now"}${share.readOnly ? ", read-only" : ""}.${share.kind === "smb" ? ` Its sign-in is kept in ${code(`/etc/boxpilot/secrets/share-${share.name}.cred`)} (root only).` : ""}`);
  }
  lines.push("");
}

function renderNetwork(facts, lines) {
  const network = facts.network ?? {};
  lines.push("## 4. Network and firewall", "", "### Firewall", "");
  const firewall = network.firewall ?? {};
  if (firewall.available === false) lines.push(`- ufw: ${unknown(firewall.reason ?? "the firewall could not be read")}`);
  else if (firewall.installed === false) lines.push("- ufw is not installed: nothing on this server filters incoming connections.");
  else {
    lines.push(`- ufw: ${firewall.enabled === true ? "on" : firewall.enabled === false ? "off, so every listening port is open to the LAN" : unknown("its setting could not be read")}.${firewall.defaults ? ` Defaults: incoming ${clean(firewall.defaults.incoming ?? "unknown")}, outgoing ${clean(firewall.defaults.outgoing ?? "unknown")}, routed ${clean(firewall.defaults.routed ?? "unknown")}.` : ""}`);
    lines.push(`- Profile: ${firewall.profile ? `${code(firewall.profile.id)}, applied ${timeOr(firewall.profile.appliedAt, "its time was not recorded")}${firewall.profile.edited ? ", with rules edited by hand since" : ""}` : "none applied through BoxPilot"}.`);
    const rules = firewall.rules ?? [];
    if (!rules.length) lines.push("- Rules: none.");
    else {
      lines.push("", "| Rule | Port | Protocol | Direction | Interface | IP | Note |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const rule of rules) {
        if (rule.raw) { lines.push(`| ${cell(rule.raw)} | | | | | ${cell(rule.family)} | not understood by BoxPilot |`); continue; }
        lines.push(`| ${cell(rule.action)} | ${rule.app ? cell(rule.app) : Number.isInteger(rule.port) ? rule.port : "any"} | ${cell(rule.protocol ?? "any")} | ${cell(rule.direction ?? "")} | ${cell(rule.interface ?? "any")} | ${cell(rule.family === "both" ? "v4 and v6" : rule.family ?? "")} | ${cell(rule.comment ?? "")} |`);
      }
    }
  }
  lines.push("", "### Tailscale", "");
  const tailnet = facts.server?.tailnet ?? {};
  if (tailnet.available === false) lines.push(`- ${sentence(`Tailscale: ${unknown(tailnet.reason ?? "Tailscale could not be read")}`)}`);
  else if (!tailnet.connected) lines.push("- Not connected: nothing is reachable over the tailnet.");
  else {
    const routes = network.tailscale?.advertisedRoutes ?? [];
    lines.push(`- Connected as ${tailnet.dnsName ? code(tailnet.dnsName) : unknown("no name reported")}${tailnet.address ? ` (${clean(tailnet.address)})` : ""}. Subnet routes offered: ${routes.length ? routes.map((route) => clean(route)).join(", ") : "none"}. Exit node: ${network.tailscale?.exitNode === true ? "offered" : network.tailscale?.exitNode === false ? "no" : unknown("not reported")}.`);
  }
  const serves = network.serves ?? {};
  if (serves.available === false) lines.push(`- Published on the tailnet over HTTPS: ${unknown(serves.reason ?? "Tailscale Serve could not be read")}`);
  else if (!(serves.items ?? []).length) lines.push("- Published on the tailnet over HTTPS: nothing.");
  else {
    lines.push("- Published on the tailnet over HTTPS (Tailscale Serve, tailnet only):");
    for (const serve of serves.items) lines.push(`  - ${clean(serve.url)}${serve.target ? ` to ${clean(serve.target)}` : ""}${serve.app ? ` (${clean(serve.app)})` : serve.app === null ? " (no installed app uses this port)" : ""}`);
  }
  lines.push("", "### Public exposure", "");
  const tunnel = network.tunnel ?? {};
  // What BoxPilot published through the tunnel (M42), from its own record; null when that could not be read.
  const published = tunnel.published?.available === true ? tunnel.published.items ?? [] : null;
  const elsewhere = "A name added to the tunnel in the Cloudflare dashboard would be public too; BoxPilot lists only what it published itself.";
  if (tunnel.installed === null || tunnel.installed === undefined) lines.push(`- Public tunnel: ${unknown(tunnel.reason ?? "the app inventory could not be read")}.`);
  else if (tunnel.installed) {
    const head = `- ${clean(tunnel.name ?? "Cloudflare Tunnel")} is installed${tunnel.running === true ? " and running" : tunnel.running === false ? " but not running" : ""}.`;
    if (published === null) lines.push(`${head} Which hostnames it publishes, and so which apps are public, is set in the Cloudflare dashboard: ${unknown("BoxPilot cannot see the tunnel's routes")}.`);
    else if (!published.length) lines.push(`${head} BoxPilot has published nothing through it. ${elsewhere}`);
    else {
      lines.push(`${head} Public on the internet, published by BoxPilot${tunnel.published.tunnelName ? ` through the tunnel ${code(tunnel.published.tunnelName)}` : ""}; anyone with the address can open these, and each app's own sign-in is the only lock:`);
      for (const item of published) lines.push(`  - ${clean(item.url)}${item.app ? ` to ${clean(item.app)}` : ""}${Number.isInteger(item.port) ? ` (port ${item.port} on this server)` : ""}`);
      lines.push(`  - ${elsewhere}`);
    }
  } else {
    lines.push("- No public tunnel is installed, and BoxPilot publishes on the tailnet only. A port forward on the router would make something public; BoxPilot cannot see the router's forwards.");
    if (published?.length) lines.push(`- BoxPilot published ${published.map((item) => clean(item.url)).join(", ")} through Cloudflare, but without the Cloudflare Tunnel app ${published.length === 1 ? "it shows" : "they show"} an error page.`);
  }
  lines.push("");
}

function renderBackups(facts, lines) {
  const backups = facts.backups ?? {};
  lines.push("## 5. Backups and the second copy", "", "### What is backed up", "");
  const database = backups.database ?? {};
  if (!database.count) lines.push("- BoxPilot's database: no backup recorded.");
  else lines.push(`- BoxPilot's database: ${plural(database.count, "backup")} recorded, newest ${timeOr(database.latest?.at, "its time was not recorded")}, ${database.latest?.drillPassed ? "restore drill passed (an isolated copy opened)" : "no passing restore drill on the newest"}. The newest ten local copies are kept.`);
  if (database.protected) lines.push(`- Encrypted copy of the database: newest ${timeOr(database.protected.at, "its time was not recorded")}, snapshot ${code(database.protected.snapshotId ?? "unknown")}, ${database.protected.drillPassed ? "restore drill passed" : "restore drill not passed"}. Repository ${code(database.repository)}; its recovery password is in ${code(database.passwordFile)} (root only), and a copy must be kept off this server: without it the copy cannot be read. Retention keeps the three newest and everything under 30 days${database.retention ? `; last applied ${timeOr(database.retention.at, "its time was not recorded")}` : ""}.`);
  else lines.push("- Encrypted copy of the database: none. Until there is one, every copy of the database is a plain copy.");
  const snapshots = backups.snapshots ?? {};
  if (snapshots.available === false) lines.push(`- Machine snapshots: ${unknown(snapshots.reason ?? "the snapshot folder could not be read")}.`);
  else if (!snapshots.count) lines.push("- Machine snapshots: none.");
  else lines.push(`- Machine snapshots: ${plural(snapshots.count, "snapshot")}${snapshots.root ? ` in ${code(snapshots.root)}` : ""}, newest ${timeOr(snapshots.latest?.at, "its time was not recorded")}${snapshots.latest?.artifact ? ` (${code(snapshots.latest.artifact)})` : ""}${snapshots.keep ? `; the newest ${snapshots.keep} are kept` : ""}. A snapshot holds every app's settings and secrets, so keep copies of it only on encrypted or physically controlled media.`);
  const apps = facts.apps ?? {};
  if (apps.available === false) lines.push(`- Apps: ${unknown(apps.reason ?? "the app inventory could not be read")}.`);
  else {
    const items = (apps.items ?? []).filter((app) => app.backups?.protectable !== false);
    const covered = items.filter((app) => app.backups?.available !== false && app.backups?.count > 0).length;
    lines.push(`- Apps: ${items.length ? `${covered} of ${plural(items.length, "installed app")} with data worth keeping ${covered === 1 ? "has" : "have"} a backup` : "no installed app has data worth backing up"}. Each app's section above has its schedule, its newest backup and its last restore drill.`);
  }
  const schedules = (facts.automation?.schedules ?? []).filter((schedule) => schedule.backup);
  lines.push(`- Backup schedules: ${schedules.length ? schedules.map((schedule) => `${clean(schedule.title)}${schedule.subject ? ` (${clean(schedule.subject)})` : ""}, ${clean(schedule.cadence)}${schedule.enabled === false ? ", paused" : ""}`).join("; ") : "none"}.`);

  lines.push("", "### The second copy", "");
  const destinations = (backups.destinations ?? []).filter((destination) => destination.configured !== false);
  if (!destinations.length) lines.push("- None. Every backup is on this server's own disks: if they fail, the backups go with them.");
  for (const destination of destinations) {
    const where = destination.whereWithheld ? "where: in the owner's copy of this document" : destination.where ? `at ${code(destination.where)}` : `where: ${unknown(destination.whereReason ?? "not recorded")}`;
    const last = destination.lastSyncReason ? `last copy ${unknown(destination.lastSyncReason)}` : destination.lastSync ? `last copy ${timeOr(destination.lastSync, "its time was not recorded")}` : "no copy made yet";
    const extra = destination.note ? ` ${sentence(destination.note)}` : "";
    const credential = destination.credential ? ` ${sentence(destination.credential)}` : "";
    lines.push(`- ${clean(destination.label)}: ${where}; ${last}.${extra}${credential}`);
  }
  lines.push("", "### Last restore drills", "");
  lines.push(`- BoxPilot's database: ${database.latest ? `${timeOr(database.latest.verifiedAt ?? database.latest.at, "its time was not recorded")}, ${database.latest.drillPassed ? "passed" : "not passed"}` : "none recorded"}${database.protected ? `; encrypted copy ${timeOr(database.protected.at, "its time was not recorded")}, ${database.protected.drillPassed ? "passed" : "not passed"}` : ""}.`);
  const drills = (apps.items ?? []).filter((app) => app.backups?.verification).sort((a, b) => String(b.backups.verification.checkedAt).localeCompare(String(a.backups.verification.checkedAt)));
  lines.push(`- Apps: ${drills.length ? drills.map((app) => `${clean(app.name)} ${timeOr(app.backups.verification.checkedAt, "not recorded")}, ${app.backups.verification.verified ? "passed" : "failed"}`).join("; ") : "none recorded"}.`, "");
}

function renderAutomation(facts, lines) {
  const automation = facts.automation ?? {};
  lines.push("## 6. Automation", "", "### Schedules", "");
  const schedules = automation.schedules ?? [];
  if (automation.available === false) lines.push(`- ${unknown(automation.reason ?? "the schedules could not be read")}`);
  else if (!schedules.length) lines.push("- None.");
  // What each one does and to what, never its other parameters: a URL or a message body can work
  // like a password, and the registry does not call every such field a secret.
  for (const schedule of schedules) {
    const what = `${clean(schedule.title)}${schedule.subject ? ` (${clean(schedule.subject)})` : ""}`;
    const keep = schedule.keep ? `, keeping ${schedule.keep}` : "";
    const last = schedule.foreign ? ", set up by another account" : schedule.lastRunAt ? `. Last run ${timeOr(schedule.lastRunAt, "not recorded")}: ${outcomeWords[schedule.outcome] ?? "not known"}` : ". Not run yet";
    lines.push(`- ${sentence(`${clean(schedule.cadence).replace(/^./, (letter) => letter.toUpperCase())}: ${what}${keep}${schedule.enabled === false ? ", paused" : ""}${last}`)}`);
  }
  lines.push("", "### Automations", "");
  const flows = automation.flows ?? [];
  if (!flows.length) lines.push("- None.");
  for (const flow of flows) {
    const steps = (flow.steps ?? []).map((step, index) => `${index + 1}. ${clean(step.title)}${step.subject ? ` (${clean(step.subject)})` : ""}`).join("; ");
    lines.push(`- **${clean(flow.name)}**: ${clean(flow.trigger)}${flow.enabled === false ? ", paused" : ""}. Steps: ${steps || "none"}.${flow.foreign ? " Set up by another account." : ""}`);
  }
  lines.push("");
}

function renderRestoreServer(facts, lines, operations) {
  const backups = facts.backups ?? {};
  const database = backups.database ?? {};
  const driveEntry = (backups.destinations ?? []).find((destination) => destination.kind === "drive") ?? null;
  const drive = driveEntry?.configured === true ? driveEntry : null;
  const mountDrive = (facts.storage?.drives ?? []).find((entry) => drive?.mountTarget && entry.target === drive.mountTarget) ?? null;
  const offBox = (backups.destinations ?? []).filter((destination) => destination.configured === true && destination.kind !== "drive");
  const steps = [];
  steps.push(`Install Ubuntu Server, then BoxPilot ${clean(facts.version)}, the release this document was made with. Work from a keyboard and screen or another machine on the LAN, and leave the router and DNS alone until you are back in.`);
  steps.push("Bring up Tailscale and sign in to BoxPilot. A fresh install asks you to create the owner first.");
  const driveUnknown = !drive && driveEntry?.configured === null
    ? `Whether this server had a backup drive is ${unknown(driveEntry.whereReason ?? "not recorded")}; if it did, mount it with ${action(operations, "storage.mount")}.`
    : null;
  if (drive) {
    const target = drive.mountTarget ? code(drive.mountTarget) : unknown("the mount point was not recorded");
    steps.push(`Plug in the backup drive and mount it at ${target} on the Storage page: ${action(operations, "storage.mount")}${mountDrive ? `, drive ${code(mountDrive.name)} from ${code(mountDrive.device)}` : ""}. It holds the mirror of every local backup${drive.whereWithheld ? "" : drive.where ? ` in ${code(drive.where)}` : ""}.`);
  } else if (offBox.length) {
    steps.push(`${driveUnknown ? `${driveUnknown} Otherwise, copy` : "There is no backup drive. Copy"} the backups back from ${offBox.map((destination) => `${clean(destination.label)}${destination.whereWithheld ? "" : destination.where ? ` (${code(destination.where)})` : ""}`).join(" or ")} into the same folders on the new server${offBox.some((destination) => destination.whereWithheld) ? "; the owner's copy of this document says where they are" : ""}. That copy is made from a console, with the key or cloud credentials you kept off this server.`);
  } else if (driveUnknown) {
    steps.push(driveUnknown);
  } else {
    steps.push("No copy of the backups is kept off this server's disks. If those disks survived, mount them; if not, there is nothing BoxPilot can restore from.");
  }
  const databaseSource = database.protected
    ? `the encrypted copy, snapshot ${code(database.protected.snapshotId ?? "unknown")} from ${timeOr(database.protected.at, "its time was not recorded")} in ${code(database.repository)}, with the recovery password you kept off this server`
    : database.count ? `the newest database backup (${timeOr(database.latest?.at, "its time was not recorded")}), from the backup drive's mirror${drive?.where ? ` (${code(`${drive.where}/controller-backups`)})` : ""} or a machine snapshot` : null;
  steps.push(databaseSource
    ? `Restore BoxPilot's own database from ${databaseSource}. This is done from a console with BoxPilot stopped: put back that exact copy, check its SHA-256 and SQLite integrity, install it as ${code(facts.server?.databasePath ?? "/var/lib/boxpilot/boxpilot.sqlite3")} owned by boxpilot with mode 0600, then start the helper and then the web service. docs/CONTROLLER-BACKUPS.md, "Manual recovery runbook", has every command. BoxPilot then knows your accounts, settings, schedules and history again.`
    : "BoxPilot's database has no backup, so its accounts, settings and history cannot be brought back: set them up again by hand from this document.");
  const snapshot = backups.snapshots?.latest;
  steps.push(`Find the machine snapshot: ${action(operations, "host.snapshot.discover")}. ${snapshot?.artifact ? `The newest recorded here is ${code(snapshot.artifact)} from ${timeOr(snapshot.at, "its time was not recorded")}.` : "No machine snapshot is recorded here, so apps must be installed again one by one (below)."}`);
  steps.push(`${action(operations, "host.snapshot.restore")}. It needs where the snapshot is (this server, the backup drive's mirror, or a drive it found), the snapshot's file name and which apps to bring back. It reinstalls the apps with their settings and secrets and restores each app's newest data archive, from the backup drive's mirror when this server's own copy is gone.`);
  steps.push(`Review what the restore staged rather than applied: ${action(operations, "host.snapshot.restores")}. Network, firewall, fstab and virtual machine definitions are never applied for you; compare them with sections 3 and 4 of this document and apply what still fits.`);
  steps.push(`Check each app below, then take a fresh database backup: ${action(operations, "controller.backup.create")}. Download a new copy of this runbook and keep it off the server.`);
  lines.push("### BoxPilot and the whole server", "");
  steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
}

function renderRestoreApp(facts, app, lines, operations) {
  const name = clean(app.name) || clean(app.id);
  const backups = app.backups ?? {};
  const steps = [];
  const ports = (app.ports ?? []).map((port) => `${Number.isInteger(port.host) ? port.host : "?"}/${clean(port.protocol)}`).join(", ");
  const chosen = (app.data ?? []).filter((folder) => !folder.managed);
  steps.push(`If ${name} is not installed yet, restoring the machine snapshot (above) reinstalls it with its settings. Without a snapshot: ${action(operations, "app.install")}, with ${ports ? `ports ${ports}` : "no ports"}, reach set to ${app.exposure === "tailnet" ? "tailnet only" : app.networkMode === "host" ? "the host network" : "home network"}${chosen.length ? `, and ${chosen.map((folder) => `${clean(folder.label)} at ${code(folder.path)}`).join(", ")}` : ""}.`);
  const drives = [...new Set((app.data ?? []).map((folder) => folder.mount?.drive).filter(Boolean))];
  if (drives.length) steps.push(`Mount the ${drives.length === 1 ? "drive" : "drives"} its folders are on before starting it: ${drives.map((drive) => code(drive)).join(", ")}, with ${action(operations, "storage.mount")}.`);
  if (backups.protectable === false) steps.push(`Nothing of ${name}'s is backed up, on purpose: what it keeps is a cache or can be downloaded again. Reinstalling it is enough.`);
  else if (backups.available === false) steps.push(`Whether ${name} has a backup is ${unknown(backups.reason ?? "the backup folder could not be read")}. If it has one: ${action(operations, "app.backup.restore")}.`);
  else if (!backups.count) steps.push(`No backup of ${name} is recorded, so BoxPilot cannot bring its data back. Once it runs again, take one: ${action(operations, "app.backup")}.`);
  else {
    const drive = (facts.backups?.destinations ?? []).find((destination) => destination.kind === "drive" && destination.configured === true);
    const mirror = drive ? ` If this server's own copy is gone, copy the app's folder back from the backup drive first: ${drive.where ? code(`${drive.where}/application-backups/${app.id}`) : "its mirror (the owner's copy of this document says where)"}${backups.directory ? ` into ${code(backups.directory)}` : ""}.` : "";
    steps.push(`${action(operations, "app.backup.restore")}. It needs the backup's name: the newest recorded is ${backups.newestArtifact ? code(backups.newestArtifact) : unknown("its name was not recorded")} from ${timeOr(backups.newestAt, "its time was not recorded")}${backups.directory ? ` in ${code(backups.directory)}` : ""}. It checks the archive against its checksum, keeps the current state as a safety copy, replaces the data and settings, and starts the app.${mirror} For one file or folder only: ${action(operations, "app.backup.restore-path")}.`);
  }
  if (chosen.length) steps.push(`${chosen.map((folder) => code(folder.path)).join(", ")} ${chosen.length === 1 ? "is" : "are"} not in its backups: ${chosen.length === 1 ? "it comes" : "they come"} back with ${chosen.length === 1 ? "its" : "their"} drive, or from however you back that drive up.`);
  const url = (app.ports ?? []).find((port) => port.tailnetHttps)?.tailnetHttps;
  steps.push(`Open it${url ? ` at ${clean(url)}` : ""} and sign in${app.signIn ? `: App catalog → ${name} → Sign in shows the password to the owner` : ""}.`);
  lines.push(`### ${name}`, "");
  steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
}

function renderRestore(facts, lines) {
  const operations = facts.operations ?? {};
  lines.push("## 7. How to restore", "");
  const mode = facts.server?.approvalMode;
  lines.push(`Each step names the BoxPilot action and what approving it takes. ${mode === "always-password" ? "On this server approvals are set to always ask for the password, whatever the risk." : mode === "tiered" ? "On this server approvals are tiered: low risk is one click, medium one confirmation, high the owner's password." : `The approval setting is ${unknown("not recorded")}.`} High-risk actions are the owner's alone.`, "");
  renderRestoreServer(facts, lines, operations);
  const apps = facts.apps ?? {};
  if (apps.available === false) { lines.push(`### Apps`, "", sentence(`Which apps to restore is ${unknown(apps.reason ?? "the app inventory could not be read")}; the machine snapshot restore lists them`), ""); return; }
  for (const app of apps.items ?? []) renderRestoreApp(facts, app, lines, operations);
}

function renderIssues(facts, lines) {
  const issues = facts.issues ?? {};
  lines.push("## 8. Known issues right now", "");
  if (issues.available === false) { lines.push(sentence(`Health alerts: ${unknown(issues.reason ?? "the alert record could not be read")}`), ""); return; }
  lines.push(issues.targetConfigured === true ? "Alerts go to the notification target set in Settings." : issues.targetConfigured === false ? "No notification target is set, so the items below reached no one." : `Whether alerts reach anyone is ${unknown("the notification setting could not be read")}.`, "");
  lines.push("### Open health alerts", "");
  const conditions = issues.conditions ?? [];
  if (!conditions.length) lines.push("- None.");
  for (const entry of conditions) lines.push(`- ${sentence(`${clean(entry.title) || clean(entry.label)} (since ${timeOr(entry.since, "not recorded")})`)}${entry.announced ? " Announced." : " Not announced."}`);
  lines.push("", "### Not announced", "");
  const notices = issues.notices ?? [];
  if (!notices.length) lines.push("- Nothing waiting.");
  for (const entry of notices) lines.push(`- ${sentence(`${clean(entry.label)}: ${clean(entry.title)} (${timeOr(entry.since, "not recorded")})`)}`);
  lines.push("");
}

/**
 * The document. `facts` come from the runbook service, already masked and already cut to the
 * reader's audience (forAudience). `now` is when it was generated.
 */
export function renderRunbook(facts, { now = () => new Date() } = {}) {
  const generatedAt = now().toISOString();
  const fingerprint = runbookFingerprint(facts);
  const hostname = facts.server?.host?.hostname;
  const lines = [
    `# Runbook: ${hostname ? clean(hostname) : "this server"}`,
    "",
    `Generated ${formatTime(generatedAt)} by BoxPilot ${clean(facts.version) || "(version unknown)"}. Fingerprint ${code(fingerprint.digest)}.`,
    "",
    "Written for whoever has to restore this server: what is installed, where each app keeps its data, what can be reached from where, how backups run and where the copies are, and how to put each thing back. It holds no passwords, keys or tokens; where one is needed it says where it is kept. Keep a copy somewhere other than this server, and download a new one after changing the server.",
    "",
  ];
  if (facts.audience === "operator") lines.push("> This is an operator's copy. Where the second copies are kept, and the details of other accounts' schedules and alerts, are only in the owner's copy.", "");
  lines.push("## Contents", "", ...runbookSections.map((section, index) => `${index + 1}. ${section.title}`), "");
  renderServer(facts, lines);
  renderApps(facts, lines);
  renderStorage(facts, lines);
  renderNetwork(facts, lines);
  renderBackups(facts, lines);
  renderAutomation(facts, lines);
  renderRestore(facts, lines);
  renderIssues(facts, lines);
  lines.push("---", "", `Fingerprint ${code(fingerprint.digest)}, from BoxPilot ${clean(facts.version) || "(version unknown)"} at ${formatTime(generatedAt)}. BoxPilot says when the server has changed since this copy was downloaded.`, "");
  return { markdown: lines.join("\n"), generatedAt, fingerprint };
}
