import { navItems, type ViewName } from "../data";
import { viewCopy, viewFeatures } from "../pageCopy";
import { mayStart, riskOf } from "../ui/operationRisk";
import type { RiskTier } from "../ui/types";

/*
 * What the command bar can jump to (M33.2): every page, every app in the catalog, and every
 * feature the pages list. Pure, so the ranking is tested without a browser.
 */

export type CommandGroup = "Suggested" | "Pages" | "Actions" | "Apps" | "Settings and features";

/**
 * Something the command bar can do rather than open (M36): a registered operation, started through
 * the ordinary approval dialog, with its tier shown in the list before it is chosen.
 */
export interface CommandAction {
  operationId: string;
  /** The approval dialog's title. */
  title: string;
  parameters: Record<string, unknown>;
  preview: string;
  risk: RiskTier;
}

export type ShellAction = "activity" | "notifications" | "sign-out";

export interface Command {
  id: string;
  group: CommandGroup;
  /** What is shown and matched first: "Firewall", "Open Jellyfin". */
  label: string;
  /** Where it goes, in a few words: "Page", "System", "Opens in a new tab". */
  hint: string;
  /** The page to open, with an app to open the catalog at, or the tab to open it at. */
  view?: ViewName;
  app?: string;
  tab?: string;
  /** With `app`: the tab its sheet opens at ("tunnel"). */
  sheet?: string;
  /**
   * For a command that must not be the first result by accident (Sign out, which Enter would run):
   * it leads only when exactly one of these, or its label, was typed, and is last otherwise.
   */
  exactly?: string[];
  /** An address outside BoxPilot (an app's own web page), opened in a new tab. */
  href?: string;
  /** Extra words that should find it, searched like the label and ranked just under it. */
  keywords?: string;
  /** Longer words about it (a page's description): they find it too, after everything else. */
  text?: string;
  /** Something the shell does itself rather than a page or an operation: open Activity, open the notifications, sign out. */
  shell?: ShellAction;
  /** An operation to start, through the approval dialog at its tier (M36). */
  action?: CommandAction;
  /** A job to open Activity at (M36: the failure to look at again). */
  job?: string;
}

/** What the command bar needs to know about an installed app to offer to act on it. */
export interface AppActionFacts { id: string; name: string; running: boolean; paused: boolean; updateAvailable: boolean; backup: boolean }

export interface CatalogEntry { id: string; name: string; category: string; installed: boolean; url: string | null }

const viewLabelOf = (view: ViewName): string => (view === "setup" ? viewCopy.setup.title : navItems.find((item) => item.id === view)?.label ?? view);

const groupRank: Record<CommandGroup, number> = { Suggested: -1, Pages: 0, Actions: 1, Apps: 2, "Settings and features": 3 };

const tierHint: Record<RiskTier, string> = { low: "Runs at once", medium: "Preview, then confirm", high: "Asks for your password" };

/**
 * What can be done from the command bar (M36): "Back up Immich", "Restart Plex", "Check for
 * updates". Each is an operation this role may start, offered with the preview the approval dialog
 * shows and the tier it will ask at. Nothing runs from here: choosing one opens the dialog.
 */
export function actionCommands(apps: AppActionFacts[], role: string | null | undefined): Command[] {
  const commands: Command[] = [];
  const offer = (id: string, label: string, operationId: string, title: string, parameters: Record<string, unknown>, preview: string, keywords = "") => {
    if (!mayStart(role, operationId)) return;
    const risk = riskOf(operationId);
    commands.push({ id: `action:${id}`, group: "Actions", label, hint: tierHint[risk], keywords, action: { operationId, title, parameters, preview, risk } });
  };
  offer("updates.check", "Check for updates", "apt.refresh", "Check for updates", {}, "Refreshes the package lists (apt-get update), so Updates shows what can be installed. Nothing is installed.", "refresh package lists apt upgrades available");
  offer("updates.install", "Install all updates", "apt.upgrade", "Install all updates", {}, "Refreshes the package lists, then upgrades every package with apt-get upgrade --with-new-pkgs.", "upgrade packages apt security");
  offer("database.backup", "Back up BoxPilot's database", "controller.backup.create", "Back up BoxPilot's database", {}, "Copies BoxPilot's database while it runs, then opens the copy to prove it reads.", "controller sqlite snapshot boxpilot");
  offer("reboot", "Restart the server", "system.reboot", "Restart the server", {}, "First stops the apps using BoxPilot's drives and unmounts the drives, then restarts the server 5 seconds later. Running VMs and containers stop and the apps start again by themselves.", "reboot restart machine power");
  for (const app of apps) {
    const words = `${app.id} ${app.name}`;
    if (app.backup) offer(`backup:${app.id}`, `Back up ${app.name}`, "app.backup", `Back up ${app.name}`, { id: app.id }, `Stops ${app.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.`, `${words} backup save copy`);
    if (app.running) {
      offer(`restart:${app.id}`, `Restart ${app.name}`, "app.action", `Restart ${app.name}`, { id: app.id, action: "restart" }, `Restarts ${app.name}. Its data and settings are untouched.`, `${words} reboot reload`);
      offer(`stop:${app.id}`, `Stop ${app.name}`, "app.action", `Stop ${app.name}`, { id: app.id, action: "stop" }, `Stops ${app.name}. It stays stopped, and says so, until you start it.`, `${words} halt`);
    } else if (app.paused) {
      offer(`resume:${app.id}`, `Resume ${app.name}`, "app.action", `Resume ${app.name}`, { id: app.id, action: "unpause" }, `Thaws ${app.name} exactly where it left off.`, `${words} unpause`);
    } else {
      offer(`start:${app.id}`, `Start ${app.name}`, "app.action", `Start ${app.name}`, { id: app.id, action: "start" }, `Starts ${app.name}.`, `${words} run`);
    }
    if (app.updateAvailable) offer(`update:${app.id}`, `Update ${app.name}`, "app.update", `Update ${app.name}`, { id: app.id }, "Pulls the image and recreates the container. The previous image is restored if the new one fails to become healthy.", `${words} upgrade image`);
  }
  return commands;
}

/**
 * What the command bar offers before anything is typed (M36), above the pages: the approvals
 * waiting, the newest failure nobody has dealt with, and each app update this role may start.
 * The approvals open Today, where they are listed first; the failure opens Activity at that job,
 * where it can be run again or dismissed; an update is the same action a search finds.
 */
export function suggestedCommands({ waiting, failure, actions }: { waiting: number; failure: { id: string; title: string } | null; actions: Command[] }): Command[] {
  const suggested: Command[] = [];
  if (waiting > 0) suggested.push({ id: "suggest:approvals", group: "Suggested", label: `Review ${waiting === 1 ? "the job" : `${waiting} jobs`} waiting for approval`, hint: "Today", view: "today" });
  if (failure) suggested.push({ id: "suggest:failure", group: "Suggested", label: `Failed: ${failure.title}`, hint: "Opens it in Activity, to try again or dismiss", job: failure.id });
  for (const action of actions) if (action.id.startsWith("action:update:")) suggested.push({ ...action, id: `suggest:${action.id}`, group: "Suggested" });
  return suggested;
}

/**
 * The longer names some pages went by before each took the navigation's word, and what else people
 * type for them. Search still finds the page by these.
 */
const otherNames: Partial<Record<ViewName, string>> = {
  catalog: "App catalog",
  performance: "Performance",
  repairs: "Repair Center",
  network: "Network and DNS",
  setup: "Set up this server",
};

/** Words people type for a page that are neither its name nor in its description. */
const pageWords: Partial<Record<ViewName, string>> = {
  firewall: "ufw ports open port block",
  network: "wifi wi-fi wireless ethernet internet lan ip",
  repairs: "help troubleshoot something is wrong not working broken fix",
  logs: "journal journalctl errors",
  users: "accounts sudo ssh keys",
  virtualization: "vm vms kvm qemu libvirt",
};

/** The pages, as the command bar lists them with nothing typed: Home and Ops first, then the dock's areas. */
export function pageCommands(): Command[] {
  const pages: Command[] = navItems.map((item) => ({
    id: `page:${item.id}`, group: "Pages", label: item.label, hint: item.id === "home" || item.id === "ops" ? "View" : "Page", view: item.id,
    keywords: `${viewCopy[item.id].title} ${otherNames[item.id] ?? ""} ${pageWords[item.id] ?? ""}`, text: viewCopy[item.id].description,
  }));
  pages.push({ id: "page:setup", group: "Pages", label: viewCopy.setup.title, hint: "Page", view: "setup", keywords: `${otherNames.setup} setup profile wizard install essentials`, text: viewCopy.setup.description });
  return pages;
}

/**
 * What the shell does itself, offered among the actions: Activity and the notifications open over
 * the page, and Sign out ends the session as the bar's own button does.
 */
export function shellCommands(): Command[] {
  return [
    { id: "shell:activity", group: "Actions", label: "Open Activity", hint: "Jobs running, waiting and finished", shell: "activity", keywords: "jobs history queue running recent" },
    { id: "shell:notifications", group: "Actions", label: "Open notifications", hint: "What BoxPilot told you", shell: "notifications", keywords: "bell alerts inbox" },
    { id: "shell:push", group: "Actions", label: "Approvals on your phone", hint: "In the notifications", shell: "notifications", keywords: "push mobile iphone android notify device" },
    { id: "shell:sign-out", group: "Actions", label: "Sign out", hint: "Ends this session", shell: "sign-out", keywords: "logout log out signout leave", exactly: ["sign out", "signout", "logout", "log out"] },
  ];
}

/**
 * Where a feature a page lists is on that page (the tab to open it at), and what else people call
 * it. Keyed by the page and the feature's own words in src/pageCopy.ts; the test holds every key to
 * a feature that is still listed, and every tab to one its page has.
 */
export const featureDetails: Partial<Record<ViewName, Record<string, { tab?: string; keywords?: string }>>> = {
  setup: {
    "Autoinstall files for a new server": { tab: "new", keywords: "cloud-init usb iso prepare reinstall" },
  },
  updates: {
    "Automatic security updates": { keywords: "unattended upgrades unattended-upgrades auto patch" },
    "Common tools with one click": { tab: "tools" },
    "Install and remove packages": { tab: "install", keywords: "apt package" },
  },
  system: {
    Hostname: { tab: "time", keywords: "name rename server" },
    "Time zone and language": { tab: "time", keywords: "timezone clock date locale ntp" },
    "Swap and swappiness": { tab: "hardware", keywords: "memory ram" },
    "SSD trim": { tab: "hardware", keywords: "fstrim" },
    "Docker housekeeping": { tab: "housekeeping", keywords: "clean cleanup prune images reclaim" },
    "UPS monitoring": { tab: "power", keywords: "battery power cut outage shutdown shut down power off nut apc" },
    Schedules: { tab: "schedules", keywords: "cron crontab timers scheduled" },
    "BoxPilot update": { tab: "updates", keywords: "version release upgrade boxpilot new" },
  },
  firewall: {
    fail2ban: { tab: "bans", keywords: "brute force bans banned blocked addresses" },
  },
  storage: {
    "Disks and LVM": { tab: "drives" },
    "SMB/NFS shares with LAN discovery": { tab: "shares", keywords: "mount network drive" },
    "Snapshots with rollback": { tab: "snapshots" },
    "Mount by UUID": { tab: "mounts" },
    "Samba and NFS servers on your tailnet": { tab: "sharing" },
  },
  network: {
    "DNS listeners": { tab: "dns" },
    "Tailscale exit node": { tab: "tailnet" },
    "Subnet router": { tab: "tailnet" },
  },
  settings: {
    "Approval mode": { tab: "approvals", keywords: "risk tier password every time" },
    "Alerts: ntfy, Gotify, webhook": { tab: "notifications" },
    People: { tab: "people" },
    Password: { keywords: "change password passphrase" },
    Theme: { tab: "appearance" },
  },
};

/**
 * Features the pages' own lists do not name, or name in words nobody types. Each opens its page at
 * the tab it is on. Setup's tab is its mode (?mode=new), which the shell writes for it.
 */
const moreFeatures: Array<{ id: string; label: string; view: ViewName; tab?: string; keywords: string }> = [
  { id: "settings:appearance", label: "Appearance", view: "settings", tab: "appearance", keywords: "look looks theme light dark mode wallpaper accent colour color rows density compact glass" },
  { id: "settings:passkeys", label: "Passkeys", view: "settings", keywords: "passkey 2fa two-factor two factor mfa webauthn security key fingerprint face id touch id" },
  { id: "settings:recovery-codes", label: "Recovery codes", view: "settings", keywords: "recovery code backup codes locked out lost passkey" },
  { id: "settings:sessions", label: "Sessions: where you're signed in", view: "settings", keywords: "session devices browsers sign out everywhere else" },
  { id: "settings:notifications", label: "Notifications", view: "settings", tab: "notifications", keywords: "notification alerts ntfy gotify webhook quiet hours weekly report watch list" },
  { id: "settings:heartbeat", label: "Heartbeat", view: "settings", tab: "notifications", keywords: "ping dead man's switch server is down monitor uptime" },
  { id: "settings:people", label: "Invite someone, or change a role", view: "settings", tab: "people", keywords: "roles invite add user operator viewer owner disable account people" },
  { id: "settings:sso", label: "Single sign-on", view: "settings", tab: "sso", keywords: "sso oidc sign in with boxpilot apps login" },
  { id: "settings:credentials", label: "Credentials", view: "settings", tab: "credentials", keywords: "secret secrets token tokens api key keys password stored" },
  { id: "system:hardware", label: "Hardware", view: "system", tab: "hardware", keywords: "memory ram swap ssd trim processor cpu" },
  { id: "system:power", label: "Power: UPS, watchdog, after a power cut", view: "system", tab: "power", keywords: "shutdown shut down power off outage battery wake" },
  { id: "system:watchdog", label: "Watchdog", view: "system", tab: "power", keywords: "hang frozen reset hardware" },
  { id: "system:space", label: "Free up space", view: "system", tab: "housekeeping", keywords: "free space clean cleanup disk full reclaim housekeeping delete old" },
  { id: "storage:sharing", label: "File sharing", view: "storage", tab: "sharing", keywords: "nas windows mac smb samba nfs network drive share a folder recycle bin" },
  { id: "storage:health", label: "Drive health (SMART)", view: "storage", tab: "drives", keywords: "s.m.a.r.t disk failing temperature hours hdd ssd" },
  { id: "network:vpn", label: "VPN", view: "network", tab: "vpn", keywords: "wireguard openvpn provider exit tunnel kill switch" },
  { id: "network:router", label: "Router", view: "network", tab: "router", keywords: "gateway port forwarding dhcp" },
  { id: "network:address", label: "BoxPilot's address and HTTPS", view: "network", keywords: "url port lan reach ssl tls certificate trust encrypted" },
  { id: "firewall:rules", label: "Firewall rules", view: "firewall", tab: "rules", keywords: "ufw allow deny port open close" },
  { id: "automations:schedules", label: "Scheduled automations", view: "automations", tab: "schedules", keywords: "cron timer recurring every day week" },
];

export function buildCommands(catalog: CatalogEntry[], actions: Command[] = []): Command[] {
  // Setup is a page without a place in the navigation; its features are found all the same.
  const listed: Array<{ id: ViewName; label: string }> = [...navItems, { id: "setup", label: viewCopy.setup.title }];
  const features: Command[] = listed.flatMap((item) => viewFeatures[item.id].map((feature, index) => ({
    id: `feature:${item.id}:${index}`, group: "Settings and features" as const, label: feature, hint: item.label, view: item.id,
    ...featureDetails[item.id]?.[feature],
  })));
  for (const feature of moreFeatures) features.push({ id: feature.id, group: "Settings and features", label: feature.label, hint: viewLabelOf(feature.view), view: feature.view, tab: feature.tab, keywords: feature.keywords });
  const apps: Command[] = [...catalog].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)).flatMap((app): Command[] => {
    if (!app.installed) return [{ id: `app:${app.id}`, group: "Apps", label: `Install ${app.name}`, hint: `Apps · ${app.category}`, view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category}` }];
    // Typing an installed app's name and pressing Enter opens the app itself, as a launcher does.
    return [
      ...(app.url ? [{ id: `open:${app.id}`, group: "Apps" as const, label: app.name, hint: "Opens it in a new tab", href: app.url, keywords: `open ${app.id}` }] : []),
      { id: `app:${app.id}`, group: "Apps", label: `${app.name} in Apps`, hint: "Installed", view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category} manage settings logs backups` },
    ];
  });
  // Publishing to the internet is a tab of the Cloudflare Tunnel app's sheet, which nobody types.
  if (catalog.some((app) => app.id === "cloudflared")) features.push({ id: "catalog:publish", group: "Settings and features", label: "Publish an app to the internet", hint: "Apps · Cloudflare Tunnel", view: "catalog", app: "cloudflared", sheet: "tunnel", keywords: "cloudflare tunnel public domain expose website outside port forward share online" });
  return [...pageCommands(), ...actions, ...shellCommands(), ...apps, ...features];
}

/**
 * Commands that contain every word typed, best first: a label that starts with what was typed,
 * then one with a word starting with it, then one containing it, then a match in its keywords,
 * then one only in its hint or its longer text. Pages come before apps and apps before features at
 * the same rank. A command with `exactly` (Sign out) leads when one of those was typed whole, and
 * is below every page, app and feature otherwise: "si", "sign" and "out" are on the way to other things.
 */
export function searchCommands(commands: Command[], query: string, limit = 40): Command[] {
  const typed = query.trim().toLowerCase();
  if (!typed) return commands.filter((command) => command.group === "Pages");
  const words = typed.split(/\s+/);
  const scored: Array<{ command: Command; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const label = command.label.toLowerCase();
    const named = `${label} ${(command.keywords ?? "").toLowerCase()}`;
    const haystack = `${named} ${command.hint.toLowerCase()} ${(command.text ?? "").toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) return;
    const score = command.exactly ? (label === typed || command.exactly.includes(words.join(" ")) ? -1 : 9)
      : label.startsWith(typed) ? 0
      : label.split(/[\s&/(),.:-]+/).some((word) => word.startsWith(words[0])) ? 1
        : label.includes(typed) ? 2
          : words.every((word) => named.includes(word)) ? 3 : 4;
    scored.push({ command, score, order });
  });
  scored.sort((a, b) => a.score - b.score || groupRank[a.command.group] - groupRank[b.command.group] || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.command);
}
