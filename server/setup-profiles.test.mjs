import { describe, expect, it, vi } from "vitest";
import { createSetupService, setupProfiles } from "./setup-profiles.mjs";

function helperWith(state) {
  return { request: vi.fn(async (operation) => { if (!(operation in state)) throw new Error(`unexpected ${operation}`); const value = state[operation]; if (value instanceof Error) throw value; return value; }) };
}

describe("first-run setup profiles", () => {
  it("only schedules low or medium operations and only catalog apps", () => {
    for (const profile of setupProfiles) {
      for (const step of profile.steps) {
        if (step.kind === "schedule") expect(["host.snapshot.create", "controller.backup.create", "apt.refresh"]).toContain(step.schedule.operationId);
        if (step.kind === "app") expect(step.appId).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it("resolves each step against live state: done, ready with the exact job, or blocked", async () => {
    const helper = helperWith({
      "app.inspect": { applications: [{ id: "homepage", installed: true }, { id: "jellyfin", installed: false }, { id: "uptime-kuma", installed: false }, { id: "dockge", installed: false }, { id: "adguard-home", installed: false }, { id: "forgejo", installed: false }, { id: "code-server", installed: false }] },
      "prerequisite.docker.inspect": { installed: true, installedVersion: "28.0.0-1" },
      "prerequisite.restic.inspect": { installed: false, repairAvailable: true, candidateVersion: "0.18.0-1" },
      "prerequisite.smartmontools.inspect": { installed: false, repairAvailable: false, detail: "No candidate" },
      "prerequisite.virtualization.inspect": { installed: false, repairAvailable: true, candidatePackages: { "libvirt-clients": "1", "libvirt-daemon-system": "1", ovmf: "1", "qemu-system-x86": "1", virtinst: "1" } },
      "apt.unattended.inspect": { installed: true, enabled: false },
      "virtualization.foundation.inspect": { ready: false, planAvailable: true },
    });
    // The cadence is part of the match: a nightly database backup at a different hour is a
    // different schedule from the one this profile offers to create.
    const scheduler = { list: () => [{ operationId: "controller.backup.create", parameters: {}, frequency: "daily", hour: 3, weekday: null }] };
    const setup = createSetupService({ helper, scheduler });
    const result = await setup.describe();
    expect(result.firstRun).toBe(false);
    const home = result.profiles.find((profile) => profile.id === "home-server");
    const byId = Object.fromEntries(home.steps.map((step) => [step.id, step]));
    expect(byId["prerequisite-docker"]).toMatchObject({ status: "done", detail: "installed 28.0.0-1" });
    expect(byId["automatic-updates"]).toMatchObject({ status: "ready", job: { operationId: "apt.unattended.set", parameters: { enabled: true } } });
    expect(byId["app-homepage"].status).toBe("done");
    expect(byId["app-jellyfin"]).toMatchObject({ status: "ready", job: { operationId: "app.install", parameters: { id: "jellyfin", values: {} } } });
    expect(byId["schedule-database-backup"].status).toBe("done");
    expect(byId["schedule-machine-snapshot"]).toMatchObject({ status: "ready", schedule: { operationId: "host.snapshot.create", frequency: "weekly" } });
    expect(home.remaining).toBe(6);

    const hypervisor = result.profiles.find((profile) => profile.id === "hypervisor");
    const virt = hypervisor.steps.find((step) => step.id === "prerequisite-virtualization");
    expect(virt).toMatchObject({ status: "ready", job: { operationId: "prerequisite.virtualization.install", parameters: { expectedPackages: { virtinst: "1" } } } });
    expect(hypervisor.steps.find((step) => step.id === "vm-foundation")).toMatchObject({ status: "ready", job: { operationId: "vm.foundation.initialize" } });
    expect(hypervisor.steps.find((step) => step.id === "prerequisite-smartmontools")).toMatchObject({ status: "blocked", detail: expect.stringContaining("package lists") });
    expect(hypervisor.blocked).toBe(1);
  });

  it("never auto-installs an app whose defaults cannot work, and says why", async () => {
    // qBittorrent installed with default values means a VPN with nobody's key: the tunnel
    // crash-loops and the install fails. The step is part of the profile, explained, not staged.
    const bare = { "app.inspect": { applications: [{ id: "qbittorrent", installed: false }, { id: "prowlarr", installed: false }, { id: "sonarr", installed: false }, { id: "radarr", installed: false }, { id: "jellyfin", installed: false }, { id: "jellyseerr", installed: false }] }, "prerequisite.docker.inspect": { installed: true }, "prerequisite.restic.inspect": null, "prerequisite.smartmontools.inspect": null, "prerequisite.virtualization.inspect": null, "apt.unattended.inspect": { enabled: true }, "virtualization.foundation.inspect": null };
    const setup = createSetupService({ helper: helperWith(bare), scheduler: { list: () => [] } });
    const { profiles } = await setup.describe();
    const media = profiles.find((profile) => profile.id === "media-automation");
    const qbt = media.steps.find((step) => step.id === "app-qbittorrent");
    expect(qbt.status).toBe("blocked");
    expect(qbt.job).toBeNull();
    expect(qbt.detail).toMatch(/needs your VPN provider and key.*App catalog card/);
    // The rest of the stack installs normally, and an installed qBittorrent counts as done.
    expect(media.steps.find((step) => step.id === "app-sonarr").status).toBe("ready");
    const after = createSetupService({ helper: helperWith({ ...bare, "app.inspect": { applications: [{ id: "qbittorrent", installed: true }] } }), scheduler: { list: () => [] } });
    const resolved = (await after.describe()).profiles.find((profile) => profile.id === "media-automation");
    expect(resolved.steps.find((step) => step.id === "app-qbittorrent").status).toBe("done");
  });

  it("marks a box with no apps and no schedules as first run and tolerates missing collectors", async () => {
    const helper = helperWith({ "app.inspect": { applications: [] }, "prerequisite.docker.inspect": new Error("helper offline"), "prerequisite.restic.inspect": null, "prerequisite.smartmontools.inspect": null, "prerequisite.virtualization.inspect": null, "apt.unattended.inspect": null, "virtualization.foundation.inspect": null });
    const setup = createSetupService({ helper, scheduler: { list: () => [] } });
    const result = await setup.describe();
    expect(result.firstRun).toBe(true);
    expect(result.profiles.find((profile) => profile.id === "essentials").steps.find((step) => step.id === "prerequisite-docker")).toMatchObject({ status: "unknown" });
  });
});

describe("why a step is blocked", () => {
  it("names the real reason instead of blaming the package lists", () => {
    const service = createSetupService({ helper: { request: async () => ({}) }, scheduler: { list: () => [] } });
    const step = { id: "prerequisite-docker", kind: "prerequisite", name: "docker", title: "Install Docker" };
    // Installed but not running: the candidate is configured, so "no candidate" was simply wrong.
    const stopped = service.resolveStep(step, { prerequisites: { docker: { installed: false, providerPresent: true, candidateVersion: "27.5.1", repairAvailable: false } } });
    expect(stopped).toMatchObject({ status: "blocked", detail: expect.stringContaining("service is not running") });
    // Genuinely no candidate.
    const noCandidate = service.resolveStep(step, { prerequisites: { docker: { installed: false, providerPresent: false, candidateVersion: null, repairAvailable: false } } });
    expect(noCandidate.detail).toContain("package lists");
  });
});
