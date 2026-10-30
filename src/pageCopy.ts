import type { ViewName } from "./data";

/*
 * What each page is called and what it does. The shell names each page in its bar from it and keeps
 * the description behind the page header's info toggle (M33.8), and the command bar (M33.2)
 * searches both, so typing "swap" finds System and "fail2ban" finds Firewall.
 */

export const viewCopy: Record<ViewName, { title: string; description: string }> = {
  home: {
    title: "Home",
    description: "Your apps, and what needs you.",
  },
  ops: {
    title: "Ops",
    description: "Everything at once: load, what needs you by risk, containers, jobs and backups.",
  },
  today: {
    title: "Today",
    description: "The morning glance: what waits for your approval, what ran overnight, and whether the backups are off this server and current.",
  },
  setup: {
    title: "Set up this server",
    description: "Pick what this server should be. BoxPilot checks what is already in place and installs the rest, in order, through the normal approved jobs.",
  },
  updates: {
    title: "Updates",
    description: "See what Ubuntu wants to update, install it, and add or remove packages.",
  },
  catalog: {
    title: "App catalog",
    description: "Install, update, configure, and remove applications with one click.",
  },
  services: {
    title: "Services",
    description: "See what systemd is running, start or stop it, and read its journal.",
  },
  automations: {
    title: "Automations",
    description: "Chains of the operations you already trust, run in order as recorded jobs. Add one from the shelf or build your own.",
  },
  agents: {
    title: "Agents",
    description: "Build agents that learn this server, answer questions, watch Pi-hole and the backups, and propose fixes for you to approve. Local models only, capped so they never run hot.",
  },
  system: {
    title: "System",
    description: "Hostname, time zone, swap, and maintenance timers for this server.",
  },
  performance: {
    title: "Performance",
    description: "How hard this server is working, and what is working it. Pause or stop whatever is costing the most, right where you see the cost.",
  },
  users: {
    title: "Users & SSH",
    description: "Add accounts, import SSH keys from GitHub, and control SSH password login.",
  },
  firewall: {
    title: "Firewall",
    description: "Profiles, open ports, and suggestions based on what is listening.",
  },
  storage: {
    title: "Storage",
    description: "Disks, LVM, mounts, network shares, and sharing this server's folders.",
  },
  network: {
    title: "Network and DNS",
    description: "Gateway, DNS, devices on your LAN, and Tailscale.",
  },
  repairs: {
    title: "Repair Center",
    description: "What is wrong on this server, and the fix for each one.",
  },
  virtualization: {
    title: "Virtual Machines",
    description: "Create and run virtual machines on QEMU/KVM.",
  },
  backups: {
    title: "Backups",
    description: "BoxPilot's own database, machine snapshots, and second copies kept elsewhere.",
  },
  github: {
    title: "GitHub",
    description: "Where this BoxPilot came from: release, commit, and asset digests.",
  },
  logs: {
    title: "Logs",
    description: "Read and download logs from any unit, container, or journal group.",
  },
  settings: {
    title: "Settings",
    description: "Access, alerts, sign-in, approval mode, and theme.",
  },
};

export const viewFeatures: Record<ViewName, string[]> = {
  home: ["Apps with their health", "What needs you, worst first", "System and backups at a glance"],
  ops: ["Load, memory, disks and network", "What needs you, by risk tier", "Containers with their numbers", "Job queue", "Backup matrix"],
  today: ["Approvals waiting, one tap each", "What ran overnight", "Backups off this server", "The agents' morning digest", "Readable offline"],
  agents: ["Agent builder with templates", "Test console with a live trace", "Cards to approve, never acted on alone", "Pause all, or until tomorrow", "Usage against hard caps", "Unsloth and Qwen models", "Golden-question evaluation"],
  automations: ["Ready-made flows", "Build your own", "Steps run as recorded jobs", "A failed step stops the run"],
  setup: ["Setup profiles", "Checks what is already in place", "Installs the rest in order", "Autoinstall files for a new server"],
  updates: ["APT updates, all or selected", "Automatic security updates", "Restart hints", "Common tools with one click", "Snapshot before upgrading", "Install and remove packages"],
  catalog: [`${__BOXPILOT_CATALOG_SIZE__} apps${__BOXPILOT_CATALOG_CATEGORIES__ > 0 ? ` in ${__BOXPILOT_CATALOG_CATEGORIES__} categories` : ""}`, "Install, update, configure, uninstall", "Per-app backups and restores", "Logs and resource use", "HTTPS on your tailnet", "Image tags verified"],
  services: ["systemd units and timers", "Start, stop, restart", "Enable and disable", "Journal", "SSH, Tailscale, and BoxPilot protected"],
  system: ["Hostname", "Time zone and language", "Swap and swappiness", "fstrim", "Docker housekeeping", "UPS monitoring", "Schedules", "BoxPilot self-update"],
  performance: ["CPU, memory and swap live", "Load average and temperatures", "Disk use per filesystem", "CPU and memory per app", "Pause, resume, stop, restart", "AI services pinned to the top"],
  users: ["Accounts", "sudo membership", "SSH keys from GitHub", "Password-login policy"],
  firewall: ["Profiles", "Service presets", "Suggestions from what is listening", "fail2ban", "SSH, Tailscale, and BoxPilot always reachable"],
  storage: ["Disks and LVM", "Grow the root volume", "Snapshots with rollback", "Mount by UUID", "SMB/NFS shares with LAN discovery", "Samba and NFS servers on your tailnet", "Swap files", "Format empty disks"],
  network: ["Gateway and resolvers", "DNS listeners", "Devices on your LAN", "Wake-on-LAN", "Tailscale exit node", "Subnet router"],
  repairs: ["Find what is broken", "Reconnect a drive that dropped out", "Fix a folder nothing can write to", "See what a job did, step by step", "Rebuild-from-scratch checklist"],
  virtualization: ["QEMU/KVM setup", "VMs from cloud images or ISOs", "Start, stop, snapshots", "Encrypted exports", "Restore drills", "Recover as a clone"],
  backups: ["Database backups with restore drills", "Encrypted second copies", "Retention", "Machine snapshots", "Mirrors to a drive, SSH host, or cloud", "Restore from a snapshot"],
  github: ["Release and commit metadata", "Asset digests", "No token needed"],
  logs: ["Any unit, container, or journal group", "Tail and follow", "Filter", "Download", "Support bundle"],
  settings: ["Approval mode", "Alerts: ntfy, Gotify, webhook", "GitHub sign-in", "Tailscale sign-in", "People", "Password", "Theme"],
};
