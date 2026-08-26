export type ViewName =
  | "overview"
  | "updates"
  | "catalog"
  | "services"
  | "system"
  | "performance"
  | "users"
  | "firewall"
  | "storage"
  | "network"
  | "repairs"
  | "virtualization"
  | "backups"
  | "github"
  | "logs"
  | "settings"
  | "setup";

export const navItems: Array<{ id: ViewName; label: string; short: string }> = [
  { id: "overview", label: "Overview", short: "OV" },
  { id: "updates", label: "Updates & packages", short: "UP" },
  { id: "catalog", label: "App catalog", short: "AC" },
  { id: "services", label: "Services", short: "SV" },
  { id: "system", label: "System", short: "SY" },
  { id: "performance", label: "Performance", short: "PF" },
  { id: "users", label: "Users & SSH", short: "US" },
  { id: "firewall", label: "Firewall", short: "FW" },
  { id: "storage", label: "Storage", short: "SG" },
  { id: "network", label: "Network", short: "NW" },
  { id: "repairs", label: "Repair Center", short: "RX" },
  { id: "virtualization", label: "Virtual Machines", short: "VM" },
  { id: "backups", label: "Backups", short: "BK" },
  { id: "github", label: "GitHub", short: "GH" },
  { id: "logs", label: "Logs", short: "LG" },
  { id: "settings", label: "Settings", short: "ST" },
];

/** The name a page is known by in the navigation, for anything that has to talk about a page. */
export const viewLabel = (view: ViewName): string => navItems.find((item) => item.id === view)?.label ?? String(view);

/**
 * A list as a person would say it: "exports, recoveries and retention", not
 * "exports, recoveries, retention". Used wherever a sentence names several things it could not do.
 */
export const sentenceList = (items: string[]): string =>
  new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);

/**
 * A count with its noun agreed: "1 day", "3 days", "1 copy", "3 copies". Written out because the
 * Backups page told people their data had been copied off "1 days ago", and because the irregular
 * ones (copy/copies) read badly as an inline ternary.
 */
export const countOf = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;
