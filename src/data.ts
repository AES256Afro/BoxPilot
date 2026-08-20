export type ViewName =
  | "overview"
  | "updates"
  | "catalog"
  | "services"
  | "system"
  | "users"
  | "firewall"
  | "applications"
  | "network"
  | "routers"
  | "repairs"
  | "virtualization"
  | "backups"
  | "migrations"
  | "fleet"
  | "github"
  | "logs"
  | "settings";

export const navItems: Array<{ id: ViewName; label: string; short: string }> = [
  { id: "overview", label: "Overview", short: "OV" },
  { id: "updates", label: "Updates & packages", short: "UP" },
  { id: "catalog", label: "App catalog", short: "AC" },
  { id: "services", label: "Services", short: "SV" },
  { id: "system", label: "System", short: "SY" },
  { id: "users", label: "Users & SSH", short: "US" },
  { id: "firewall", label: "Firewall", short: "FW" },
  { id: "applications", label: "Applications", short: "AP" },
  { id: "network", label: "Network", short: "NW" },
  { id: "routers", label: "Routers", short: "RT" },
  { id: "repairs", label: "Repair Center", short: "RX" },
  { id: "virtualization", label: "Virtual Machines", short: "VM" },
  { id: "backups", label: "Backups", short: "BK" },
  { id: "migrations", label: "Migrations", short: "MG" },
  { id: "fleet", label: "Fleet", short: "FL" },
  { id: "github", label: "GitHub", short: "GH" },
  { id: "logs", label: "Logs", short: "LG" },
  { id: "settings", label: "Settings", short: "ST" },
];
