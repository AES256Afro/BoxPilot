export type ViewName =
  | "overview"
  | "applications"
  | "network"
  | "repairs"
  | "virtualization"
  | "backups"
  | "migrations"
  | "logs"
  | "settings";

export const navItems: Array<{ id: ViewName; label: string; short: string }> = [
  { id: "overview", label: "Overview", short: "OV" },
  { id: "applications", label: "Applications", short: "AP" },
  { id: "network", label: "Network", short: "NW" },
  { id: "repairs", label: "Repair Center", short: "RX" },
  { id: "virtualization", label: "Virtual Machines", short: "VM" },
  { id: "backups", label: "Backups", short: "BK" },
  { id: "migrations", label: "Migrations", short: "MG" },
  { id: "logs", label: "Logs", short: "LG" },
  { id: "settings", label: "Settings", short: "ST" },
];
