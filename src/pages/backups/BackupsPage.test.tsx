import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupsPage from "./BackupsPage";
import { nightlySlot } from "./types";

beforeEach(() => { window.history.replaceState(null, "", "/?view=backups"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const day = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * day).toISOString();

const backup = {
  id: "10000000-0000-4000-8000-000000000001", applicationId: "boxpilot-controller", destination: "local-managed",
  checksumSha256: "a".repeat(64), sizeBytes: 4 * 1024 * 1024, downtimeMs: 0,
  restoreDrill: { passed: true }, createdAt: daysAgo(0.2),
};
const machineState = {
  snapshots: [{ artifact: "machine-snapshot-20260821T020000Z-11111111.tar.gz", sizeBytes: 5 * 1024 * 1024, checksumSha256: "b".repeat(64), createdAt: daysAgo(1), contents: { apps: [{ id: "uptime-kuma", backups: 1 }, { id: "immich", backups: 0 }], vms: { domains: ["snapshot-lab"] } } }],
  keep: 3,
  sync: { destination: "/mnt/boxpilot/backup/boxpilot-local-mirror", mount: { mounted: true, freeBytes: 9 * 1024 ** 3 }, lastSync: { completedAt: daysAgo(0.1), copiedCount: 4 } },
};
const providers = {
  b2: { label: "Backblaze B2", fields: ["account", "bucket", "path"], secrets: ["key"], help: "Create an application key." },
  s3: { label: "S3-compatible", fields: ["endpoint", "region", "bucket", "path", "accessKeyId"], secrets: ["secretAccessKey"], help: "S3 help." },
  drive: { label: "Google Drive", fields: ["path"], secrets: ["token"], help: "Run rclone authorize." },
};
const staging = (id: string, risk = "medium") => json({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } }, 201);

interface World {
  backups?: unknown[];
  apps?: unknown[];
  schedules?: unknown[];
  machine?: unknown;
  remote?: unknown;
  remoteSettings?: unknown;
  cloud?: unknown;
  cloudSettings?: unknown;
  extra?: (url: string, init?: RequestInit) => Response | null;
}

/** A lived-in server by default; each test changes what it is about. */
function mockFetch(world: World = {}) {
  const staged: string[] = [];
  const bodies: Record<string, string> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const handled = world.extra?.(url, init);
    if (handled) return handled;
    if (url.endsWith("/api/v1/backups")) return json({ backups: world.backups ?? [backup] });
    if (url.endsWith("/controller-backup-protection")) return json({ destination: { ready: true, encrypted: true, repositoryId: "restic-controller", blockers: [] }, protections: [] });
    if (url.endsWith("/controller-backup-retention")) return json({ policy: { minimumCopies: 3, minimumAgeDays: 30 }, candidates: [] });
    if (url.endsWith("/operations/host.snapshot.inspect/inspect")) return json({ result: world.machine ?? machineState });
    if (url.endsWith("/operations/backup.remote.inspect/inspect")) return json({ result: world.remote ?? { keyReady: true, publicKey: "ssh-ed25519 AAAA boxpilot-backup-mirror", fingerprint: "SHA256:abc", hostKeysPinned: 1, rsyncInstalled: true } });
    if (url.endsWith("/api/v1/settings/backup-destination")) return json(world.remoteSettings ?? { destination: null, lastSync: null });
    if (url.endsWith("/operations/backup.cloud.inspect/inspect")) return json({ result: world.cloud ?? { rcloneInstalled: true, configured: false, provider: null, providers } });
    if (url.endsWith("/api/v1/settings/cloud-destination")) return json(world.cloudSettings ?? { destination: null, lastSync: null });
    if (url.endsWith("/operations/app.backup.protection/inspect")) return json({ result: { available: true, apps: world.apps ?? [{ id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 3, newestAt: daysAgo(0.5) }] } });
    if (url.endsWith("/api/v1/schedules") && init?.method !== "POST") return json({ schedules: world.schedules ?? [{ operationId: "app.backup", parameters: { subject: "vaultwarden" }, enabled: true }, { operationId: "backup.sync", parameters: {}, enabled: true }] });
    if (url.endsWith("/operations/host.snapshot.restores/inspect")) return json({ result: { restores: [] } });
    if (url.endsWith("/operations/host.snapshot.sources/inspect")) return json({ result: { sources: [], mount: { mounted: true, blocker: null } } });
    if (url.endsWith("/operations/host.snapshot.discover/inspect")) return json({ result: { locations: [] } });
    const match = url.match(/\/operations\/([a-z.-]+)\/jobs$/);
    if (match) { staged.push(match[1]); bodies[match[1]] = init?.body as string; return staging(match[1], match[1] === "host.snapshot.restore" ? "high" : match[1] === "controller.backup.create" ? "low" : "medium"); }
    return json({ error: `unexpected ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { staged, bodies, fetchMock };
}
const openTab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

describe("when the nightly backups are scheduled for", () => {
  // Spacing them an hour apart put the seventh app at 08:42, hours after the off-box copy at
  // 04:15 had run, so half the backups sat on the machine for another day.
  const minutes = (slot: { hour: number; minute: number }) => slot.hour * 60 + slot.minute;

  it("fits every app into the window before the off-box copy, however many there are", () => {
    for (const total of [1, 3, 7, 14, 30, 60]) {
      expect(minutes(nightlySlot(total - 1, total))).toBeLessThan(4 * 60 + 15);
      expect(minutes(nightlySlot(0, total))).toBe(2 * 60);
    }
  });

  it("keeps them in order and never doubles up while there is room", () => {
    const seven = Array.from({ length: 7 }, (_, index) => minutes(nightlySlot(index, 7)));
    expect(seven).toEqual([...seven].sort((left, right) => left - right));
    expect(new Set(seven).size).toBe(7);
  });
});

describe("Backups page", () => {
  it("says protected only when every app, the schedules and the off-box copy say so, with the facts in mono", async () => {
    mockFetch();
    render(<BackupsPage csrfToken="csrf-token" />);
    expect(await screen.findByText("Protected")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Backups" })).toBeTruthy();
    expect(screen.getByText("Protected").closest(".ui-chip")?.getAttribute("data-status")).toBe("good");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("1 apps with data · 1 nightly · 1 database backups · 1 machine snapshots · off-box today");
    expect(screen.getAllByRole("tab").map((tab) => /^[A-Za-z -]+/.exec(tab.textContent ?? "")?.[0].trim())).toEqual(["Apps", "This server", "Off-box", "Restore"]);
    fireEvent.click(screen.getByRole("button", { name: "About Backups" }));
    expect(screen.getByText(/an app with no backup comes back installed and empty/).closest("[hidden]")).toBeNull();
  });

  it("never says protected about an app list it could not read", async () => {
    mockFetch({ extra: (url) => (url.endsWith("/operations/app.backup.protection/inspect") ? json({ error: "The helper did not answer" }, 503) : null) });
    render(<BackupsPage csrfToken="csrf-token" />);
    expect(await screen.findByText("Not read")).toBeTruthy();
    expect(screen.getByText("App protection could not be read")).toBeTruthy();
    expect(screen.queryByText("Protected")).toBeNull();
  });

  it("says what it could not read when answers come back in a shape it does not know, and never crashes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    render(<BackupsPage csrfToken="csrf-token" />);
    expect(await screen.findByText("The backups could not be read")).toBeTruthy();
    expect(screen.getByText("Not read")).toBeTruthy();
    for (const tab of [/^This server/, /^Off-box/, /^Restore/]) openTab(tab);
    expect(screen.getByText("Restore from a machine snapshot")).toBeTruthy();
  });

  describe("Apps", () => {
    it("backs up an app from its row, through the approval dialog, with its tier on the button", async () => {
      const { bodies } = mockFetch({ apps: [{ id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 0, newestAt: null }], schedules: [] });
      render(<BackupsPage csrfToken="csrf-token" />);
      expect(await screen.findByText("1 app never backed up")).toBeTruthy();
      const button = screen.getByRole("button", { name: "Back up Vaultwarden now" });
      expect(button.getAttribute("data-risk")).toBe("medium");
      fireEvent.click(button);
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      expect(JSON.parse(bodies["app.backup"] ?? "{}")).toEqual({ parameters: { id: "vaultwarden" } });
    });

    it("schedules nightly backups for the apps with none, and says what it did", async () => {
      const posted: unknown[] = [];
      mockFetch({
        apps: [{ id: "immich", name: "Immich", protectable: true, backups: 2, newestAt: daysAgo(63) }, { id: "nextcloud", name: "Nextcloud", protectable: true, backups: 0, newestAt: null }],
        schedules: [],
        extra: (url, init) => (url.endsWith("/api/v1/schedules") && init?.method === "POST" ? (posted.push(JSON.parse(init.body as string)), json({ schedule: { id: "s" } }, 201)) : null),
      });
      render(<BackupsPage csrfToken="csrf-token" />);
      fireEvent.click(await screen.findByRole("button", { name: "Back up everything nightly" }));
      expect(await screen.findByText("Scheduled nightly backups for 2 apps. The first runs tonight.")).toBeTruthy();
      expect(posted).toEqual([
        { operationId: "app.backup", parameters: { id: "immich" }, frequency: "daily", hour: 2, minute: 0 },
        { operationId: "app.backup", parameters: { id: "nextcloud" }, frequency: "daily", hour: 3, minute: 0 },
      ]);
    });

    it("says when a scheduled backup has stopped running, and where to look", async () => {
      const onNavigate = vi.fn();
      mockFetch({ schedules: [{ operationId: "app.backup", parameters: { subject: "vaultwarden" }, enabled: true, overdue: true, title: "Back up Vaultwarden" }] });
      render(<BackupsPage csrfToken="csrf-token" onNavigate={onNavigate} />);
      expect(await screen.findByText("1 backup stopped running")).toBeTruthy();
      expect(screen.getByText("A scheduled backup has stopped running")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Automations" }));
      expect(onNavigate).toHaveBeenCalledWith("automations");
    });

    it("leaves out the actions a viewer cannot take", async () => {
      mockFetch({ apps: [{ id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 0, newestAt: null }], schedules: [] });
      render(<BackupsPage csrfToken="csrf-token" role="viewer" />);
      expect(await screen.findByText("Vaultwarden")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Back up/ })).toBeNull();
      expect(screen.getByText("not scheduled")).toBeTruthy();
    });
  });

  describe("This server", () => {
    it("lists verified database backups, stages a one-click backup, and offers Protect when the store is ready", async () => {
      const { bodies } = mockFetch({ backups: [backup, { ...backup, id: "x", applicationId: "legacy-app" }] });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByText("Protected");
      openTab(/^This server/);
      const table = screen.getByRole("table", { name: "Backups of BoxPilot's database" });
      expect(within(table).getAllByRole("row")).toHaveLength(2); // the controller's only
      expect(within(table).getByText("passed")).toBeTruthy();
      const backUp = screen.getByRole("button", { name: "Back up now" });
      expect(backUp.getAttribute("data-risk")).toBe("low");
      fireEvent.click(backUp);
      expect(await screen.findByText("Low risk")).toBeTruthy();
      expect(JSON.parse(bodies["controller.backup.create"] ?? "{}")).toEqual({ parameters: {} });
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.click(screen.getByRole("button", { name: /^Protect the backup of/ }));
      await waitFor(() => expect(JSON.parse(bodies["controller.backup.protect"] ?? "{}")).toEqual({ parameters: { backupId: backup.id } }));
    });

    it("says how many apps in a machine snapshot would come back with their data, and creates one", async () => {
      const { staged } = mockFetch();
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByText("Protected");
      openTab(/^This server/);
      expect(screen.getByText("5.0 MiB")).toBeTruthy();
      expect(screen.getByText("1 of 2").closest(".ui-chip")?.getAttribute("data-status")).toBe("warning");
      fireEvent.click(screen.getByRole("button", { name: "Create machine snapshot" }));
      expect(await screen.findByText(/contains secrets/)).toBeTruthy();
      expect(staged).toEqual(["host.snapshot.create"]);
    });

    it("shows an empty database history as a fact with its one action", async () => {
      mockFetch({ backups: [] });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^This server/ });
      openTab(/^This server/);
      expect(await screen.findByText("No database backups yet")).toBeTruthy();
    });
  });

  describe("Off-box", () => {
    it("syncs to the backup drive and says when the copy was made", async () => {
      const { staged } = mockFetch();
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByText("Protected");
      openTab(/^Off-box/);
      expect(screen.getByText("Copied off this server today")).toBeTruthy();
      expect(screen.getByText("A nightly copy is scheduled.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Sync to backup drive" }));
      expect(await screen.findByText(/never deleted/)).toBeTruthy();
      expect(staged).toEqual(["backup.sync"]);
    });

    it("says backups are only on this server when there is nowhere else, and points at Storage", async () => {
      const onNavigate = vi.fn();
      mockFetch({ machine: { ...machineState, sync: { ...machineState.sync, mount: { mounted: false, blocker: null }, lastSync: null } }, schedules: [{ operationId: "app.backup", parameters: { subject: "vaultwarden" }, enabled: true }] });
      render(<BackupsPage csrfToken="csrf-token" onNavigate={onNavigate} />);
      expect(await screen.findByText("Only on this server")).toBeTruthy();
      openTab(/^Off-box/);
      expect(screen.getByText("Backups are only on this server. A disk failure would take them with it")).toBeTruthy();
      expect(screen.getByText("No backup drive is mounted")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Storage" }));
      expect(onNavigate).toHaveBeenCalledWith("storage");
    });

    it("walks the SSH destination from its sheet to a test and a mirror", async () => {
      let saved: string | undefined;
      let destination: unknown = null;
      const { staged } = mockFetch({ extra: (url, init) => {
        if (url.endsWith("/api/v1/settings/backup-destination") && init?.method === "PUT") { saved = init.body as string; destination = { host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" }; return json({ destination, lastSync: null }); }
        if (url.endsWith("/api/v1/settings/backup-destination")) return json({ destination, lastSync: null });
        return null;
      } });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^Off-box/ });
      openTab(/^Off-box/);
      expect(await screen.findByLabelText("Mirror public key")).toBeTruthy();
      fireEvent.click(within(screen.getByRole("region", { name: "Another machine over SSH" })).getByRole("button", { name: "Set destination" }));
      const sheet = screen.getByRole("dialog", { name: "Set the destination" });
      fireEvent.change(within(sheet).getByLabelText("Host"), { target: { value: "nas.local" } });
      fireEvent.change(within(sheet).getByLabelText("User"), { target: { value: "backup" } });
      fireEvent.change(within(sheet).getByLabelText("Path"), { target: { value: "/srv/boxpilot" } });
      expect(within(sheet).getByRole("button", { name: "Save destination" })).toHaveProperty("disabled", true);
      fireEvent.change(within(sheet).getByLabelText("Owner password"), { target: { value: "correct horse battery" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Save destination" }));
      expect(await screen.findByText("backup@nas.local:/srv/boxpilot")).toBeTruthy();
      expect(JSON.parse(saved ?? "{}")).toEqual({ password: "correct horse battery", destination: { host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" } });
      const ssh = screen.getByRole("region", { name: "Another machine over SSH" });
      fireEvent.click(within(ssh).getByRole("button", { name: "Test connection" }));
      expect(await screen.findByText(/pins the destination's host key/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.click(within(ssh).getByRole("button", { name: "Mirror now" }));
      expect(await screen.findByText(/Nothing on the destination is deleted/)).toBeTruthy();
      expect(staged).toEqual(["backup.remote.test", "backup.remote.sync"]);
    });

    it("names the cloud fields still missing, then stages the destination with its secret", async () => {
      const { bodies } = mockFetch();
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^Off-box/ });
      openTab(/^Off-box/);
      const cloud = await screen.findByRole("region", { name: "Cloud bucket" });
      fireEvent.click(within(cloud).getByRole("button", { name: "Set destination" }));
      const sheet = screen.getByRole("dialog", { name: "Set the cloud destination" });
      const hint = within(sheet).getByText(/Still needed:/);
      expect(hint.textContent).toContain("Key ID");
      expect(hint.textContent).toContain("Bucket");
      expect(hint.textContent).toContain("Application key");
      expect(within(sheet).getByRole("button", { name: "Save destination" })).toHaveProperty("disabled", true);
      fireEvent.change(within(sheet).getByLabelText("Key ID"), { target: { value: "0012abc" } });
      fireEvent.change(within(sheet).getByLabelText("Bucket"), { target: { value: "home-backups" } });
      fireEvent.change(within(sheet).getByLabelText("Application key"), { target: { value: "K123" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Save destination" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      expect(JSON.parse(bodies["backup.cloud.setup"] ?? "{}")).toEqual({ parameters: { provider: "b2", account: "0012abc", bucket: "home-backups", key: "K123" } });
    });

    it("offers rclone when it is missing, and a saved cloud destination's test and mirror to the owner only", async () => {
      const cloudSettings = { destination: { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" }, lastSync: { completedAt: daysAgo(1), filesTransferred: 7, bytesTransferred: "1.2 GiB", destination: "boxpilot:home-backups/homebox" } };
      mockFetch({ cloud: { rcloneInstalled: false, configured: true, provider: "b2", providers }, cloudSettings });
      render(<BackupsPage csrfToken="csrf-token" role="operator" />);
      await screen.findByRole("tab", { name: /^Off-box/ });
      openTab(/^Off-box/);
      const cloud = await screen.findByRole("region", { name: "Cloud bucket" });
      expect(within(cloud).getByText("home-backups")).toBeTruthy();
      expect(within(cloud).getByRole("button", { name: "Install rclone" })).toBeTruthy();
      // The cloud destination is the owner's: an operator sees it, and none of its actions.
      expect(within(cloud).queryByRole("button", { name: /destination|Test connection|Mirror now/ })).toBeNull();
      cleanup();

      const { staged } = mockFetch({ cloud: { rcloneInstalled: true, configured: true, provider: "b2", providers }, cloudSettings });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^Off-box/ });
      openTab(/^Off-box/);
      const owned = await screen.findByRole("region", { name: "Cloud bucket" });
      fireEvent.click(within(owned).getByRole("button", { name: "Test connection" }));
      await waitFor(() => expect(staged).toEqual(["backup.cloud.test"]));
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.click(within(owned).getByRole("button", { name: "Change destination" }));
      const sheet = screen.getByRole("dialog", { name: "Change the cloud destination" });
      expect((within(sheet).getByLabelText("Bucket") as HTMLInputElement).value).toBe("home-backups");
      fireEvent.change(within(sheet).getByLabelText("Provider"), { target: { value: "drive" } });
      expect(within(sheet).getByLabelText("Token (from rclone authorize)")).toBeTruthy();
    });
  });

  describe("Restore", () => {
    const sources = { sources: [{ source: "local", root: "/var/lib/boxpilot-managed/machine-snapshots", available: true, snapshots: [{ artifact: "machine-snapshot-a.tar.gz", sizeBytes: 41 * 1024 ** 2, createdAt: daysAgo(1), checksumSha256: null, apps: 2 }] }], mount: { mounted: true, blocker: null } };
    const described = { source: "local", artifact: "machine-snapshot-a.tar.gz", createdAt: daysAgo(1), apps: [{ id: "immich", installed: true, newestBackup: "x", dataAvailable: true, dataLocation: "local" }, { id: "jellyfin", installed: false, newestBackup: null, dataAvailable: false, dataLocation: null }], system: null, vms: { domains: ["dev-lab"], diskRepositoryReachable: false } };

    it("restores the chosen apps from a snapshot's sheet, as a high-risk action", async () => {
      let describedWith: string | undefined;
      const { bodies } = mockFetch({ extra: (url, init) => {
        if (url.endsWith("/operations/host.snapshot.sources/inspect")) return json({ result: sources });
        if (url.endsWith("/operations/host.snapshot.discover/inspect")) return json({ result: { locations: [], unanswered: [{ target: "/mnt/backup-drive", source: "//nas.local/backups", error: "EIO" }] } });
        if (url.endsWith("/operations/host.snapshot.describe/run")) { describedWith = init?.body as string; return json({ result: described }); }
        return null;
      } });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^Restore/ });
      openTab(/^Restore/);
      expect(await screen.findByText("//nas.local/backups did not answer when read")).toBeTruthy();
      const restore = await screen.findByRole("button", { name: /^Restore from the snapshot of/ });
      expect(restore.getAttribute("data-risk")).toBe("high");
      fireEvent.click(restore);
      const sheet = await screen.findByRole("dialog", { name: /^Snapshot of/ });
      expect(await within(sheet).findByText("immich")).toBeTruthy();
      expect(JSON.parse(describedWith ?? "{}")).toEqual({ parameters: { source: "local", artifact: "machine-snapshot-a.tar.gz" } });
      expect(within(sheet).getByText("The VM disk repository is not reachable")).toBeTruthy();
      // What was installed is chosen to start with.
      expect((within(sheet).getByLabelText("Restore immich") as HTMLInputElement).checked).toBe(true);
      fireEvent.click(within(sheet).getByLabelText("Restore jellyfin"));
      fireEvent.click(within(sheet).getByRole("button", { name: "Restore 2 apps" }));
      expect(await screen.findByText("High risk")).toBeTruthy();
      expect(JSON.parse(bodies["host.snapshot.restore"] ?? "{}")).toEqual({ parameters: { source: "local", artifact: "machine-snapshot-a.tar.gz", apps: ["immich", "jellyfin"], restoreData: true } });
    });

    it("shows what a restore staged for review, and discards it", async () => {
      const restores = [{ name: "20260825T140000Z", stagedAt: "/var/lib/boxpilot/snapshots/restored/20260825T140000Z", files: [{ path: "system/fstab", area: "system", sizeBytes: 640, content: "UUID=1a2b / ext4 defaults 0 1\n" }, { path: "controller/boxpilot.sqlite3", area: "controller", sizeBytes: 845_000, content: null }] }];
      const { bodies } = mockFetch({ extra: (url) => (url.endsWith("/operations/host.snapshot.restores/inspect") ? json({ result: { restores } }) : null) });
      render(<BackupsPage csrfToken="csrf-token" />);
      await screen.findByRole("tab", { name: /^Restore/ });
      openTab(/^Restore/);
      expect(screen.getByText("System configuration")).toBeTruthy();
      expect(screen.getByText("The old BoxPilot database")).toBeTruthy();
      expect(screen.getByText(/Not shown here/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^Discard what the restore of/ }));
      await waitFor(() => expect(JSON.parse(bodies["host.snapshot.restores.discard"] ?? "{}")).toEqual({ parameters: { name: "20260825T140000Z" } }));
    });

    it("tells a viewer restoring is for an operator or the owner, without reading the snapshots", async () => {
      const { fetchMock } = mockFetch();
      render(<BackupsPage csrfToken="csrf-token" role="viewer" />);
      await screen.findByRole("tab", { name: /^Restore/ });
      openTab(/^Restore/);
      expect(screen.getByText("Restoring needs an operator or the owner")).toBeTruthy();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("host.snapshot.sources"))).toBe(false);
    });
  });
});
