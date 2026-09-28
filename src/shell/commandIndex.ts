import { navItems, type ViewName } from "../data";
import { viewCopy, viewFeatures } from "../pageCopy";

/*
 * What the command bar can jump to (M33.2): every page, every app in the catalog, and every
 * feature the pages list. Pure, so the ranking is tested without a browser.
 */

export type CommandGroup = "Pages" | "Apps" | "Settings and features";

export interface Command {
  id: string;
  group: CommandGroup;
  /** What is shown and matched first: "Firewall", "Open Jellyfin". */
  label: string;
  /** Where it goes, in a few words: "Page", "System", "Opens in a new tab". */
  hint: string;
  /** The page to open, with an app to open the catalog at. */
  view?: ViewName;
  app?: string;
  /** An address outside BoxPilot (an app's own web page), opened in a new tab. */
  href?: string;
  /** Extra words that should find it. */
  keywords?: string;
}

export interface CatalogEntry { id: string; name: string; category: string; installed: boolean; url: string | null }

const groupRank: Record<CommandGroup, number> = { Pages: 0, Apps: 1, "Settings and features": 2 };

/** The pages, as the command bar lists them with nothing typed: Home and Ops first, then the dock's areas. */
export function pageCommands(): Command[] {
  const pages: Command[] = navItems.map((item) => ({
    id: `page:${item.id}`, group: "Pages", label: item.label, hint: item.id === "home" || item.id === "ops" ? "View" : "Page", view: item.id,
    keywords: `${viewCopy[item.id].title} ${viewCopy[item.id].description}`,
  }));
  pages.push({ id: "page:setup", group: "Pages", label: viewCopy.setup.title, hint: "Page", view: "setup", keywords: "setup profile wizard install essentials" });
  return pages;
}

export function buildCommands(catalog: CatalogEntry[]): Command[] {
  const features: Command[] = navItems.flatMap((item) => viewFeatures[item.id].map((feature, index) => ({
    id: `feature:${item.id}:${index}`, group: "Settings and features" as const, label: feature, hint: item.label, view: item.id,
  })));
  const apps: Command[] = [...catalog].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)).flatMap((app): Command[] => {
    if (!app.installed) return [{ id: `app:${app.id}`, group: "Apps", label: `Install ${app.name}`, hint: `App catalog · ${app.category}`, view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category}` }];
    // Typing an installed app's name and pressing Enter opens the app itself, as a launcher does.
    return [
      ...(app.url ? [{ id: `open:${app.id}`, group: "Apps" as const, label: app.name, hint: "Opens it in a new tab", href: app.url, keywords: `open ${app.id}` }] : []),
      { id: `app:${app.id}`, group: "Apps", label: `${app.name} in the App catalog`, hint: "Installed", view: "catalog", app: app.id, keywords: `${app.name} ${app.id} ${app.category} manage settings logs backups` },
    ];
  });
  return [...pageCommands(), ...apps, ...features];
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
