/**
 * First-run setup profiles (M4.2): what a fresh box should become, expressed as ordinary
 * registry operations and schedules. The wizard shows each profile's steps with live
 * "already done" state, then runs the rest in order through the normal job path.
 */

const weeklySnapshot = { operationId: "host.snapshot.create", parameters: {}, frequency: "weekly", minute: 30, hour: 3, weekday: 0 };
const dailyDatabaseBackup = { operationId: "controller.backup.create", parameters: {}, frequency: "daily", minute: 15, hour: 3, weekday: null };
const dailyAptRefresh = { operationId: "apt.refresh", parameters: {}, frequency: "daily", minute: 0, hour: 5, weekday: null };

const prerequisite = (name, title) => ({ id: `prerequisite-${name}`, kind: "prerequisite", name, title });
const app = (id, title) => ({ id: `app-${id}`, kind: "app", appId: id, title: `Install ${title}` });
const schedule = (id, title, definition) => ({ id: `schedule-${id}`, kind: "schedule", title, schedule: definition });
const unattended = { id: "automatic-updates", kind: "unattended", title: "Turn on automatic security updates" };
const foundation = { id: "vm-foundation", kind: "foundation", title: "Initialize the libvirt default network and storage pool" };

export const setupProfiles = Object.freeze([
  {
    id: "home-server", name: "Home server", icon: "🏠",
    description: "Media, a dashboard, uptime monitoring, and nightly backups. The usual first box.",
    steps: [prerequisite("docker", "Install Docker Engine"), unattended, app("homepage", "Homepage"), app("jellyfin", "Jellyfin"), app("uptime-kuma", "Uptime Kuma"), app("dockge", "Dockge"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("machine-snapshot", "Take a machine snapshot every week", weeklySnapshot), schedule("apt-refresh", "Refresh package lists every morning", dailyAptRefresh)],
  },
  {
    id: "dns-appliance", name: "DNS appliance", icon: "🛡️",
    description: "AdGuard Home for the whole network, with monitoring and backups.",
    steps: [prerequisite("docker", "Install Docker Engine"), unattended, app("adguard-home", "AdGuard Home"), app("uptime-kuma", "Uptime Kuma"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("apt-refresh", "Refresh package lists every morning", dailyAptRefresh)],
  },
  {
    id: "hypervisor", name: "Hypervisor", icon: "🖥️",
    description: "KVM/QEMU with the default network and storage pool ready for project VMs.",
    steps: [prerequisite("virtualization", "Install KVM, QEMU, and libvirt"), foundation, prerequisite("smartmontools", "Install smartmontools for disk health"), unattended, schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("machine-snapshot", "Take a machine snapshot every week", weeklySnapshot)],
  },
  {
    id: "dev-box", name: "Dev box", icon: "🧰",
    description: "Git hosting, a browser IDE, and compose management.",
    steps: [prerequisite("docker", "Install Docker Engine"), unattended, app("forgejo", "Forgejo"), app("code-server", "code-server"), app("dockge", "Dockge"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("apt-refresh", "Refresh package lists every morning", dailyAptRefresh)],
  },
  {
    id: "media-server", name: "Media server", icon: "🎬",
    description: "Movies, shows, music, and audiobooks with request management and a dashboard.",
    steps: [prerequisite("docker", "Install Docker Engine"), unattended, app("jellyfin", "Jellyfin"), app("jellyseerr", "Jellyseerr"), app("navidrome", "Navidrome"), app("audiobookshelf", "Audiobookshelf"), app("homepage", "Homepage"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("machine-snapshot", "Take a machine snapshot every week", weeklySnapshot)],
  },
  {
    id: "smart-home", name: "Smart home", icon: "💡",
    description: "Home Assistant with push notifications and uptime monitoring.",
    steps: [prerequisite("docker", "Install Docker Engine"), unattended, app("home-assistant", "Home Assistant"), app("ntfy", "ntfy"), app("uptime-kuma", "Uptime Kuma"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("machine-snapshot", "Take a machine snapshot every week", weeklySnapshot)],
  },
  {
    id: "observability", name: "Observability", icon: "📈",
    description: "Grafana, uptime checks, and a notification relay for alerts.",
    steps: [prerequisite("docker", "Install Docker Engine"), prerequisite("smartmontools", "Install smartmontools for disk health"), unattended, app("grafana", "Grafana"), app("uptime-kuma", "Uptime Kuma"), app("ntfy", "ntfy"), schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("apt-refresh", "Refresh package lists every morning", dailyAptRefresh)],
  },
  {
    id: "essentials", name: "Essentials only", icon: "✅",
    description: "Docker, automatic security updates, disk health, and backup schedules. Add apps later.",
    steps: [prerequisite("docker", "Install Docker Engine"), prerequisite("smartmontools", "Install smartmontools for disk health"), prerequisite("restic", "Install restic for encrypted backups"), unattended, schedule("database-backup", "Back up the BoxPilot database every night", dailyDatabaseBackup), schedule("machine-snapshot", "Take a machine snapshot every week", weeklySnapshot), schedule("apt-refresh", "Refresh package lists every morning", dailyAptRefresh)],
  },
]);

function sameSchedule(existing, wanted) {
  return existing.operationId === wanted.operationId && JSON.stringify(existing.parameters ?? {}) === JSON.stringify(wanted.parameters ?? {});
}

/** Resolve every profile step against live state: done, runnable, or blocked — and the exact job to stage. */
export function createSetupService({ helper, scheduler }) {
  async function liveState() {
    const read = (operation, parameters = {}) => helper.request(operation, parameters, { timeoutMs: 30_000 }).catch(() => null);
    const [apps, docker, restic, smartmontools, virtualization, unattendedState, foundationState] = await Promise.all([
      read("app.inspect"), read("prerequisite.docker.inspect"), read("prerequisite.restic.inspect"), read("prerequisite.smartmontools.inspect"), read("prerequisite.virtualization.inspect"), read("apt.unattended.inspect"), read("virtualization.foundation.inspect"),
    ]);
    return { apps, prerequisites: { docker, restic, smartmontools, virtualization }, unattended: unattendedState, foundation: foundationState, schedules: scheduler.list() };
  }

  function resolveStep(step, state) {
    if (step.kind === "prerequisite") {
      const inspection = state.prerequisites[step.name];
      if (!inspection) return { ...step, status: "unknown", detail: "Inspection unavailable", job: null };
      if (inspection.installed) return { ...step, status: "done", detail: inspection.installedVersion ? `installed ${inspection.installedVersion}` : "installed", job: null };
      if (!inspection.repairAvailable) return { ...step, status: "blocked", detail: inspection.detail ?? "No installable candidate is configured", job: null };
      const parameters = step.name === "virtualization" ? { expectedPackages: inspection.candidatePackages } : { expectedVersion: inspection.candidateVersion };
      return { ...step, status: "ready", detail: step.name === "virtualization" ? "installs the fixed package set" : `installs ${inspection.candidateVersion}`, job: { operationId: `prerequisite.${step.name}.install`, parameters } };
    }
    if (step.kind === "unattended") {
      if (!state.unattended) return { ...step, status: "unknown", detail: "Inspection unavailable", job: null };
      return state.unattended.enabled ? { ...step, status: "done", detail: "already on", job: null } : { ...step, status: "ready", detail: "unattended-upgrades for security updates", job: { operationId: "apt.unattended.set", parameters: { enabled: true } } };
    }
    if (step.kind === "foundation") {
      if (!state.foundation) return { ...step, status: "unknown", detail: "libvirt is not reachable yet", job: null };
      if (state.foundation.ready) return { ...step, status: "done", detail: "default network and pool ready", job: null };
      return { ...step, status: state.foundation.planAvailable ? "ready" : "blocked", detail: state.foundation.planAvailable ? "defines and starts the missing defaults" : (state.foundation.conflicts ?? []).join("; ") || "blocked", job: state.foundation.planAvailable ? { operationId: "vm.foundation.initialize", parameters: {} } : null };
    }
    if (step.kind === "app") {
      const live = state.apps?.applications?.find((entry) => entry.id === step.appId);
      if (!state.apps) return { ...step, status: "unknown", detail: "Catalog state unavailable", job: null };
      if (!live) return { ...step, status: "blocked", detail: "not in the catalog", job: null };
      return live.installed ? { ...step, status: "done", detail: "installed", job: null } : { ...step, status: "ready", detail: "with default settings", job: { operationId: "app.install", parameters: { id: step.appId, values: {} } } };
    }
    if (step.kind === "schedule") {
      const exists = state.schedules.some((entry) => sameSchedule(entry, step.schedule));
      return exists ? { ...step, status: "done", detail: "scheduled", job: null } : { ...step, status: "ready", detail: `${step.schedule.frequency}`, job: null };
    }
    return { ...step, status: "unknown", detail: "", job: null };
  }

  async function describe() {
    const state = await liveState();
    const installedApps = state.apps?.applications?.filter((entry) => entry.installed).length ?? 0;
    const profiles = setupProfiles.map((profile) => {
      const steps = profile.steps.map((step) => resolveStep(step, state));
      return { id: profile.id, name: profile.name, icon: profile.icon, description: profile.description, steps, remaining: steps.filter((step) => step.status === "ready").length, blocked: steps.filter((step) => step.status === "blocked").length };
    });
    return { firstRun: installedApps === 0 && state.schedules.length === 0, installedApps, profiles };
  }

  return { describe, resolveStep };
}
