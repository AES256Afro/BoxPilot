export type ViewName =
  | "overview"
  | "applications"
  | "repairs"
  | "virtualization"
  | "backups"
  | "migrations"
  | "logs"
  | "settings";

export type StatusTone = "good" | "warning" | "neutral";

export interface Metric {
  label: string;
  value: string;
  percent: number;
}

export interface Workload {
  name: string;
  detail: string;
  kind: string;
  state: string;
  tone: StatusTone;
}

export interface Application {
  name: string;
  description: string;
  status: string;
  installed: boolean;
}

export const navItems: Array<{ id: ViewName; label: string; short: string }> = [
  { id: "overview", label: "Overview", short: "OV" },
  { id: "applications", label: "Applications", short: "AP" },
  { id: "repairs", label: "Repair Center", short: "RX" },
  { id: "virtualization", label: "Virtual Machines", short: "VM" },
  { id: "backups", label: "Backups", short: "BK" },
  { id: "migrations", label: "Migrations", short: "MG" },
  { id: "logs", label: "Logs", short: "LG" },
  { id: "settings", label: "Settings", short: "ST" },
];

export const metrics: Metric[] = [
  { label: "CPU load", value: "18%", percent: 18 },
  { label: "Memory", value: "6.2 / 32 GB", percent: 20 },
  { label: "Storage", value: "244 / 930 GB", percent: 26 },
  { label: "Disk health", value: "34 C", percent: 34 },
];

export const workloads: Workload[] = [
  {
    name: "Keel Notes",
    detail: "127.0.0.1:3000 | app-aware backup",
    kind: "Docker stack",
    state: "Healthy",
    tone: "good",
  },
  {
    name: "Ubuntu Lab",
    detail: "2 vCPU | 4 GB | default NAT",
    kind: "Virtual machine",
    state: "Running",
    tone: "good",
  },
  {
    name: "Tailscale",
    detail: "Private HTTPS | DNS override off",
    kind: "System service",
    state: "Connected",
    tone: "good",
  },
  {
    name: "Nightly backup",
    detail: "NAS + encrypted offsite copy",
    kind: "Automation",
    state: "Verified",
    tone: "good",
  },
];

export const applications: Application[] = [
  {
    name: "Keel Notes",
    description:
      "Planned app-aware discovery, export, managed-secret preservation, backup, restore, and migration support.",
    status: "Preview integration",
    installed: false,
  },
  {
    name: "AdGuard Home",
    description:
      "DNS filtering with upstream validation, LAN checks, and outage rollback.",
    status: "Planned adapter",
    installed: false,
  },
  {
    name: "Jellyfin",
    description:
      "Media server with hardware detection, library mapping, and migration assistance.",
    status: "Planned adapter",
    installed: false,
  },
  {
    name: "Home Assistant",
    description:
      "Container or VM deployment with USB-device checks and backup registration.",
    status: "Planned adapter",
    installed: false,
  },
  {
    name: "PostgreSQL",
    description:
      "Local database with encrypted secrets and application-aware dumps.",
    status: "Planned adapter",
    installed: false,
  },
  {
    name: "Custom stack",
    description:
      "Paste Compose, inspect risks, map volumes, and create a dry-run plan.",
    status: "Open dry-run inspector",
    installed: false,
  },
];

export const timeline = [
  ["08:14", "SMART short test passed"],
  ["06:02", "Backup integrity check passed"],
  ["03:41", "7 security updates staged"],
  ["00:15", "Keel snapshot and restore test verified"],
] as const;

export const backupRows = [
  ["Keel Notes", "Export + secrets key", "NAS + offsite", "2h ago", "Passed"],
  ["Docker configuration", "Compose + secrets manifest", "NAS", "2h ago", "Passed"],
  ["Ubuntu Lab", "Quiesced qcow2", "NAS", "1d ago", "Passed"],
  ["Host configuration", "Config inventory", "NAS + recovery kit", "1d ago", "Due in 12d"],
] as const;

export const logRows = [
  ["08:14:31", "smartd", "Device /dev/nvme0 health self-assessment passed"],
  ["08:11:04", "tailscaled", "Peer connection active over direct path"],
  ["08:05:42", "docker", "Container keel reported healthy"],
  ["06:02:18", "backup", "Repository integrity sample completed successfully"],
  ["03:41:00", "updates", "7 security updates available; change staged for review"],
  ["00:15:09", "keel", "Export bundle and managed-secret key verified before backup"],
] as const;
