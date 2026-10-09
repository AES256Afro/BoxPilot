import { navItems, type ViewName } from "../data";
import { viewCopy, viewFeatures } from "../pageCopy";
import { mayStart, riskOf } from "../ui/operationRisk";
import type { RiskTier } from "../ui/types";

/*
 * What the command bar can jump to (M33.2): every page, every app in the catalog, and every
 * feature the pages list. Pure, so the ranking is tested without a browser.
 */

export type CommandGroup = "Pages" | "Actions" | "Apps" | "Settings and features";

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
  /** An address outside BoxPilot (an app's own web page), opened in a new tab. */
  href?: string;
  /** Extra words that should find it. */
  keywords?: string;
  /** An operation to start, through the approval dialog at its tier (M36). */
  action?: CommandAction;
}

/** What the command bar needs to know about an installed app to offer to act on it. */
export interface AppActionFacts { id: string; name: string; running: boolean; paused: boolean; updateAvailable: boolean; backup: boolean }

export interface CatalogEntry { id: string; name: string; category: string; installed: boolean; url: string | null }

const groupRank: Record<CommandGroup, number> = { Pages: 0, Actions: 1, Apps: 2, "Settings and features": 3 };

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
  offer("database.backup", "Back up BoxPilot's database", "controller.backup.create", "Back up the BoxPilot database", {}, "Snapshots the live database with VACUUM INTO (no downtime) and restore-drills the copy before recording it.", "controller sqlite snapshot boxpilot");
  offer("reboot", "Reboot the server", "system.reboot", "Reboot the server", {}, "First stops the apps using BoxPilot's drives and unmounts the drives, then reboots 5 seconds later. Running VMs and containers stop and the apps start again by themselves.", "restart machine power");
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

/** The pages, as the command bar lists them with nothing typed: Home and Ops first, then the dock's areas. */
export function pageCommands(): Command[] {
  const pages: Command[] = navItems.map((item) => ({
    id: `page:${item.id}`, group: "Pages", label: item.label, hint: item.id === "home" || item.id === "ops" ? "View" : "Page", view: item.id,
    keywords: `${viewCopy[item.id].title} ${viewCopy[item.id].description}`,
  }));
  pages.push({ id: "page:setup", group: "Pages", label: viewCopy.setup.title, hint: "Page", view: "setup", keywords: "setup profile wizard install essentials" });
  return pages;
}

export function buildCommands(catalog: CatalogEntry[], actions: Command[] = []): Command[] {
  const features: Command[] = navItems.flatMap((item) => viewFeatures[item.id].map((feature, index) => ({
    id: `feature:${item.id}:${index}`, group: "Settings and features" as const, label: feature, hint: item.label, view: item.id,
  })));
  // Appearance is a tab of Settings, and the words people look for it by are not its name.
  features.push({
    id: "settings:appearance", group: "Settings and features", label: "Appearance", hint: "Settings", view: "settings", tab: "appearance",
    keywords: "look looks theme light dark mode wallpaper accent colour color rows density compact glass",
  });
  const apps: Command[] = [...catalog].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)).flatMap((app): Command[] => {
    if (!app.installed) return [{ id: `app:${app.id}`, group: "Apps", label: `Install ${app.name}`, hint: `App catalog · ${app.category}`, view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category}` }];
    // Typing an installed app's name and pressing Enter opens the app itself, as a launcher does.
    return [
      ...(app.url ? [{ id: `open:${app.id}`, group: "Apps" as const, label: app.name, hint: "Opens it in a new tab", href: app.url, keywords: `open ${app.id}` }] : []),
      { id: `app:${app.id}`, group: "Apps", label: `${app.name} in the App catalog`, hint: "Installed", view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category} manage settings logs backups` },
    ];
  });
  return [...pageCommands(), ...actions, ...apps, ...features];
}

/**
 * Commands that contain every word typed, best first: a label that starts with what was typed,
 * then one with a word starting with it, then one containing it, then a match in the keywords
 * only. Pages come before apps and apps before features at the same rank.
 */
export function searchCommands(commands: Command[], query: string, limit = 40): Command[] {
  const typed = query.trim().toLowerCase();
  if (!typed) return commands.filter((command) => command.group === "Pages");
  const words = typed.split(/\s+/);
  const scored: Array<{ command: Command; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const label = command.label.toLowerCase();
    const haystack = `${label} ${command.hint.toLowerCase()} ${(command.keywords ?? "").toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) return;
    const score = label.startsWith(typed) ? 0
      : label.split(/[\s&/(),.-]+/).some((word) => word.startsWith(words[0])) ? 1
        : label.includes(typed) ? 2 : 3;
    scored.push({ command, score, order });
  });
  scored.sort((a, b) => a.score - b.score || groupRank[a.command.group] - groupRank[b.command.group] || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.command);
}
