// @vitest-environment node
/**
 * The runbook generator (M34.4) against a rich set of facts. Every host detail here is a placeholder
 * (documentation addresses, example names); none of it describes a real server.
 */
import { describe, expect, it } from "vitest";
import { registry } from "./ops/index.mjs";
import { approvalFor, changedSections, changesSince, clean, forAudience, formatBytes, formatTime, layoutOperations, outOfDate, renderRunbook, runbookFingerprint, runbookSections, storeMarkers } from "./runbook.mjs";

const owner = "owner-1";
const operator = "operator-1";
// Planted wherever the generator must not look: parameter sets, a destination's user and key id,
// an app's environment. If any of it reaches a document, a secret could.
const sentinel = "SENTINEL-7f3a9c-never-print";
const now = () => new Date("2026-09-28T10:00:00.000Z");

const restoreIds = ["storage.mount", "host.snapshot.discover", "host.snapshot.restore", "host.snapshot.restores", "controller.backup.create", "app.install", "app.backup", "app.backup.restore", "app.backup.restore-path"];
const operations = Object.fromEntries(restoreIds.map((id) => {
  const operation = registry.get(id);
  return [id, { title: operation.title, risk: operation.risk, readOnly: operation.readOnly, minimumRole: operation.minimumRole, confirm: Boolean(operation.confirm) }];
}));

function richFacts() {
  return {
    version: "9.9.9-test",
    server: {
      host: { available: true, hostname: "homeserver", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0-generic", architecture: "x64" },
      databasePath: "/var/lib/boxpilot/boxpilot.sqlite3",
      roots: {
        databaseBackups: { path: "/var/lib/boxpilot-managed/backups/boxpilot-controller" },
        appBackups: { path: "/var/lib/boxpilot-managed/backups/catalog" },
        machineSnapshots: { path: "/var/lib/boxpilot-managed/machine-snapshots" },
        appData: { path: "/var/lib/boxpilot-managed/catalog" },
      },
      reach: { available: true, ways: [
        { label: "On this server", url: "http://127.0.0.1:8787", scope: "Only from the server itself" },
        { label: "On your home network", url: "http://192.0.2.10:8787", scope: "Any device on your network" },
        { label: "Over Tailscale, from anywhere", url: "https://homeserver.example.ts.net", scope: "Any device on your tailnet" },
      ] },
      lan: { available: true, addresses: [{ interface: "eth0", address: "192.0.2.10" }] },
      tailnet: { available: true, connected: true, dnsName: "homeserver.example.ts.net", address: "100.64.0.10" },
      approvalMode: "tiered",
    },
    apps: { available: true, items: [
      {
        id: "jellyfin", name: "Jellyfin", category: "Media", description: "Stream your films and music to any screen",
        image: { reference: "jellyfin/jellyfin:10.10.7", version: "10.10.7" }, container: "running", exposure: "lan", networkMode: "bridge",
        ports: [{ label: "Web interface", host: 8096, protocol: "tcp", reach: "lan", tailnetHttps: "https://homeserver.example.ts.net:8096" }],
        data: [
          { label: "Configuration", path: "/var/lib/boxpilot-managed/catalog/jellyfin/config", managed: true, backedUp: true, readOnly: false, mount: { target: "/", drive: null } },
          { label: "Media library", path: "/mnt/media/library", managed: false, backedUp: false, readOnly: true, mount: { target: "/mnt/media", drive: "media" } },
        ],
        signIn: { note: null }, secretNames: [],
        env: { JELLYFIN_ADMIN_PASSWORD: sentinel },
        backups: {
          available: true, protectable: true, count: 4, newestAt: "2026-09-28T03:00:00.000Z", newestArtifact: "20260928T030000Z.tar.gz", directory: "/var/lib/boxpilot-managed/backups/catalog/jellyfin",
          verification: { verified: true, checkedAt: "2026-09-27T04:00:00.000Z" },
          schedules: [{ id: "s-backup", cadence: "daily at 03:00", keep: 5, enabled: true, createdBy: owner }],
        },
      },
      {
        id: "vaultwarden", name: "Vaultwarden", category: "Security", description: "A password manager server",
        image: { reference: "vaultwarden/server:1.34.3", version: "1.34.3" }, container: "running, healthy", exposure: "tailnet", networkMode: "bridge",
        ports: [{ label: "Web vault", host: 8222, protocol: "tcp", reach: "loopback", tailnetHttps: "https://homeserver.example.ts.net:8222" }],
        data: [{ label: "Vault data", path: "/var/lib/boxpilot-managed/catalog/vaultwarden/data", managed: true, backedUp: true, readOnly: false, mount: { target: "/", drive: null } }],
        signIn: null, secretNames: ["ADMIN_TOKEN"],
        backups: { available: true, protectable: true, count: 0, newestAt: null, newestArtifact: null, directory: "/var/lib/boxpilot-managed/backups/catalog/vaultwarden", verification: null, schedules: [] },
      },
      {
        id: "cloudflared", name: "Cloudflare Tunnel", category: "Network", description: "Publish an app to the internet through Cloudflare",
        image: { reference: "cloudflare/cloudflared:2026.8.2", version: "2026.8.2" }, container: "running", exposure: "lan", networkMode: "bridge",
        ports: [], data: [], signIn: null, secretNames: ["TUNNEL_TOKEN"],
        backups: { available: true, protectable: false, count: 0, newestAt: null, newestArtifact: null, directory: null, verification: null, schedules: [] },
      },
    ] },
    storage: {
      available: true,
      smart: { available: true, status: "healthy", checkedAt: "2026-09-28T02:00:00.000Z" },
      drives: [
        {
          name: "media", target: "/mnt/media", device: "UUID=00000000-0000-4000-8000-000000000001", fstype: "ext4", mounted: true, readOnly: false, sizeBytes: 4e12, availableBytes: 1.2e12,
          disk: "/dev/sdb", model: "Example Disk 4TB", transport: "usb", smart: null, smartReason: "no reading; USB enclosures often do not pass SMART through",
          autoReconnect: { armed: true, enabled: true, held: false, heldBecause: null }, holds: ["Jellyfin: Media library (`/mnt/media/library`)"],
        },
        {
          name: "boxpilot-backup", target: "/mnt/boxpilot-backup", device: "UUID=00000000-0000-4000-8000-000000000002", fstype: "ext4", mounted: true, readOnly: false, sizeBytes: 2e12, availableBytes: 1.5e12,
          disk: "/dev/sdc", model: "Example Backup 2TB", transport: "usb", smart: { health: "healthy" },
          autoReconnect: { armed: false }, holds: ["the backup drive's copy of every local backup", "the encrypted copy of BoxPilot's database"],
        },
      ],
      others: [{ target: "/", source: "/dev/nvme0n1p2", fstype: "ext4", disk: "/dev/nvme0n1", smart: { health: "healthy" }, holds: ["BoxPilot's database", "every app's own folder"] }],
      shares: [],
    },
    network: {
      firewall: {
        available: true, installed: true, enabled: true, defaults: { incoming: "deny", outgoing: "allow", routed: "deny" },
        rules: [
          { action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: "SSH", family: "both" },
          { action: "allow", protocol: "any", port: null, app: null, direction: "in", interface: "tailscale0", comment: null, family: "both" },
          { action: "allow", protocol: "tcp", port: 8096, app: null, direction: "in", interface: null, comment: "Jellyfin", family: "v4" },
        ],
        profile: { id: "home-server", appliedAt: "2026-09-20T10:00:00.000Z", edited: false },
      },
      serves: { available: true, items: [
        { url: "https://homeserver.example.ts.net:8096", port: 8096, target: "http://127.0.0.1:8096", app: "Jellyfin" },
        { url: "https://homeserver.example.ts.net:8222", port: 8222, target: "http://127.0.0.1:8222", app: "Vaultwarden" },
      ] },
      tunnel: { installed: true, name: "Cloudflare Tunnel", running: true },
      tailscale: { advertisedRoutes: ["192.0.2.0/24"], exitNode: false },
    },
    backups: {
      database: {
        count: 12, latest: { at: "2026-09-28T02:00:00.000Z", verifiedAt: "2026-09-28T02:00:05.000Z", drillPassed: true },
        protected: { at: "2026-09-27T02:30:00.000Z", snapshotId: "1".repeat(64), drillPassed: true },
        repository: "/mnt/boxpilot-backup/restic-controller", passwordFile: "/etc/boxpilot/secrets/controller-backup-restic-password",
        retention: { at: "2026-09-20T05:00:00.000Z" },
      },
      snapshots: { available: true, root: "/var/lib/boxpilot-managed/machine-snapshots", count: 3, keep: 3, latest: { at: "2026-09-27T01:00:00.000Z", artifact: "machine-snapshot-20260927T010000Z-0a1b2c3d.tar.gz" } },
      destinations: [
        { kind: "drive", label: "Backup drive", configured: true, where: "/mnt/boxpilot-backup/boxpilot-local-mirror", mountTarget: "/mnt/boxpilot-backup", lastSync: "2026-09-28T04:00:00.000Z", note: "Mounted now. It gets copies of the database backups, app backups and machine snapshots, checked by hash; nothing there is ever deleted by BoxPilot" },
        { kind: "ssh", label: "Another machine over SSH", configured: true, where: "backup.example:/srv/backups/homeserver", lastSync: "2026-09-28T04:30:00.000Z", note: "A plain mirror of the local backups, copied with rsync; not encrypted", credential: "The SSH key is /etc/boxpilot/secrets/backup-mirror-key on this server (root only); its public half is authorized on the destination", user: sentinel },
        { kind: "cloud", label: "Cloud storage (Backblaze B2)", configured: true, where: "example-bucket/homeserver", lastSync: null, note: "A plain mirror of the local backups, copied with rclone; not encrypted", credential: "Its keys are in /etc/boxpilot/secrets/rclone.conf on this server (root only); keep a copy of them off this server", accessKeyId: sentinel },
      ],
    },
    automation: {
      schedules: [
        { id: "s-backup", operationId: "app.backup", title: "Back up application data", subject: "jellyfin", keep: 5, parameters: { id: "jellyfin", keep: 5 }, cadence: "daily at 03:00", enabled: true, backup: true, createdBy: owner, lastRunAt: "2026-09-28T03:00:00.000Z", outcome: "ran" },
        { id: "s-hook", operationId: "http.request", title: "Send an HTTP request", subject: null, keep: null, parameters: { url: `https://hooks.example/${sentinel}`, body: sentinel }, cadence: "Sundays at 09:00", enabled: true, backup: false, createdBy: operator, lastRunAt: null, outcome: null },
        { id: "s-sync", operationId: "backup.remote.sync", title: "Mirror local backups to the off-box SSH destination", subject: null, keep: null, parameters: {}, cadence: "daily at 04:30", enabled: true, backup: true, createdBy: owner, lastRunAt: "2026-09-28T04:30:00.000Z", outcome: "failed" },
      ],
      flows: [
        { id: "f-reconnect", name: "Reconnect media", trigger: "when drive media drops or goes read-only (auto-reconnect)", enabled: true, createdBy: owner, steps: [{ operationId: "storage.remount", title: "Reconnect a drive", subject: "media", parameters: { name: "media" } }] },
        { id: "f-notify", name: "Tell the phone", trigger: "run by hand", enabled: false, createdBy: owner, steps: [{ operationId: "http.request", title: "Send an HTTP request", subject: null, parameters: { url: `https://push.example/${sentinel}` } }] },
      ],
    },
    issues: {
      available: true, targetConfigured: false,
      conditions: [
        { family: "system.reboot", subject: null, label: "A reboot is required", title: "A reboot is required", since: "2026-09-26T00:00:00.000Z", announced: false },
        { family: "schedule.failed", subject: "s-sync", label: "A scheduled task failed or did not run", title: "Scheduled task failed: Mirror local backups to the off-box SSH destination", since: "2026-09-28T04:31:00.000Z", announced: false, scheduleCreatedBy: owner },
      ],
      notices: [{ family: "release.available", subject: null, label: "A new BoxPilot release", title: "BoxPilot 9.9.10 is out", since: "2026-09-27T12:00:00.000Z" }],
    },
    operations,
  };
}

/** Facts from a server where nothing could be read but BoxPilot's own records. */
function unreadableFacts() {
  return {
    version: "9.9.9-test",
    server: {
      host: { available: false, reason: "the host inventory could not be read" },
      databasePath: "/var/lib/boxpilot/boxpilot.sqlite3",
      roots: {
        databaseBackups: { path: null, reason: "no database backup has been taken yet" },
        appBackups: { path: null, reason: "the app backup folders could not be read" },
        machineSnapshots: { path: null, reason: "the snapshot store could not be read" },
        appData: { path: null, reason: "the app inventory could not be read" },
      },
      reach: { available: true, ways: [{ label: "On this server", url: "http://127.0.0.1:8787", scope: "Only from the server itself" }] },
      lan: { available: false, reason: "the network could not be read" },
      tailnet: { available: false, reason: "Tailscale could not be read" },
      approvalMode: "tiered",
    },
    apps: { available: false, reason: "the app inventory could not be read; is the BoxPilot helper running?" },
    storage: { available: false, reason: "the drives could not be read", smart: { available: false, reason: "storage scan evidence missing" } },
    network: {
      firewall: { available: false, reason: "the firewall could not be read" },
      serves: { available: false, reason: "Tailscale Serve could not be read" },
      tunnel: { installed: null, reason: "the app inventory could not be read" },
      tailscale: { advertisedRoutes: [], exitNode: null },
    },
    backups: {
      database: { count: 0, latest: null, protected: null, repository: "/mnt/boxpilot-backup/restic-controller", passwordFile: "/etc/boxpilot/secrets/controller-backup-restic-password", retention: null },
      snapshots: { available: false, reason: "the snapshot store could not be read" },
      destinations: [{ kind: "drive", label: "Backup drive", configured: null, where: null, whereReason: "the snapshot store could not be read", lastSyncReason: "the snapshot store could not be read" }],
    },
    automation: { available: false, reason: "the schedules could not be read", schedules: [], flows: [] },
    issues: { available: true, targetConfigured: null, conditions: [], notices: [] },
    operations,
  };
}

const render = (facts, audience = "owner", callerId = owner) => renderRunbook(forAudience(facts, { audience, callerId }), { now }).markdown;

describe("the runbook", () => {
  it("has every section, in order, and says when it was generated and from which BoxPilot", () => {
    const { markdown, generatedAt, fingerprint } = renderRunbook(forAudience(richFacts()), { now });
    expect(generatedAt).toBe("2026-09-28T10:00:00.000Z");
    expect(markdown.startsWith("# Runbook: homeserver\n")).toBe(true);
    expect(markdown).toContain(`Generated 2026-09-28 10:00 UTC by BoxPilot 9.9.9-test. Fingerprint \`${fingerprint.digest}\`.`);
    const positions = runbookSections.map((section, index) => markdown.indexOf(`\n## ${index + 1}. ${section.title}\n`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markdown).not.toMatch(/\bundefined\b|\bnull\b|NaN|\[object Object\]/);
  });

  it("describes each app the way someone restoring it needs it", () => {
    expect(render(richFacts())).toContain([
      "### Jellyfin (`jellyfin`)",
      "",
      "Stream your films and music to any screen.",
      "",
      "- Image: `jellyfin/jellyfin:10.10.7` (version 10.10.7). Container: running.",
      "- Reach: home network. Its ports listen on every address of this server, so devices on the LAN and on the tailnet can reach them; the firewall decides who gets through.",
      "  - Web interface: 8096/tcp, LAN; on the tailnet at https://homeserver.example.ts.net:8096",
      "- Data:",
      "  - Configuration: `/var/lib/boxpilot-managed/catalog/jellyfin/config`, managed by BoxPilot, in its backups; on the filesystem at `/`",
      "  - Media library: `/mnt/media/library`, a folder you chose, read-only, not in its backups; on drive `media` (`/mnt/media`)",
      "- Sign-in: App catalog → Jellyfin → Sign in. The password is in the app's `.env`; BoxPilot shows it there to the owner, after the owner's password.",
      "- Backups: 4 backups in `/var/lib/boxpilot-managed/backups/catalog/jellyfin`, newest 2026-09-28 03:00 UTC (`20260928T030000Z.tar.gz`). Scheduled daily at 03:00, keeping 5. Last restore drill 2026-09-27 04:00 UTC: passed.",
    ].join("\n"));
  });

  it("says who can reach what, and what BoxPilot cannot see", () => {
    const markdown = render(richFacts());
    expect(markdown).toContain("- ufw: on. Defaults: incoming deny, outgoing allow, routed deny.");
    expect(markdown).toContain("| allow | 22 | tcp | in | any | v4 and v6 | SSH |");
    expect(markdown).toContain("- Connected as `homeserver.example.ts.net` (100.64.0.10). Subnet routes offered: 192.0.2.0/24. Exit node: no.");
    expect(markdown).toContain("  - https://homeserver.example.ts.net:8222 to http://127.0.0.1:8222 (Vaultwarden)");
    expect(markdown).toContain("- Cloudflare Tunnel is installed and running. Which hostnames it publishes, and so which apps are public, is set in the Cloudflare dashboard: unknown (BoxPilot cannot see the tunnel's routes).");
    expect(markdown).toContain("- `media` at `/mnt/media`: ext4 from `UUID=00000000-0000-4000-8000-000000000001`, on `/dev/sdb` (Example Disk 4TB, usb). Mounted read-write, 4.0 TB, 1.2 TB free when generated. SMART: unknown (no reading; USB enclosures often do not pass SMART through). Auto-reconnect: armed.\n  - Holds: Jellyfin: Media library (`/mnt/media/library`)");
  });

  it("lists what BoxPilot published to the internet through Cloudflare, and says what it cannot see (M42)", () => {
    const facts = richFacts();
    facts.network.tunnel = { installed: true, name: "Cloudflare Tunnel", running: true, published: { available: true, tunnelName: "boxpilot-homeserver", items: [{ url: "https://share.example.com", app: "Pingvin Share", port: 3022 }] } };
    const markdown = render(facts);
    expect(markdown).toContain("- Cloudflare Tunnel is installed and running. Public on the internet, published by BoxPilot through the tunnel `boxpilot-homeserver`; anyone with the address can open these, and each app's own sign-in is the only lock:\n  - https://share.example.com to Pingvin Share (port 3022 on this server)\n  - A name added to the tunnel in the Cloudflare dashboard would be public too; BoxPilot lists only what it published itself.");
    facts.network.tunnel.published.items = [];
    expect(render(facts)).toContain("- Cloudflare Tunnel is installed and running. BoxPilot has published nothing through it. A name added");
    // What is published is part of the network section's fingerprint, so a runbook goes out of date when it changes.
    const before = runbookFingerprint(facts).sections.network;
    facts.network.tunnel.published.items = [{ url: "https://share.example.com", app: "Pingvin Share", port: 3022 }];
    expect(runbookFingerprint(facts).sections.network).not.toBe(before);
  });

  it("says where every second copy is, and how the server and each app come back", () => {
    const markdown = render(richFacts());
    expect(markdown).toContain("- Another machine over SSH: at `backup.example:/srv/backups/homeserver`; last copy 2026-09-28 04:30 UTC. A plain mirror of the local backups, copied with rsync; not encrypted. The SSH key is /etc/boxpilot/secrets/backup-mirror-key on this server (root only); its public half is authorized on the destination.");
    expect(markdown).toContain("- Cloud storage (Backblaze B2): at `example-bucket/homeserver`; no copy made yet.");
    expect(markdown).toContain("3. Plug in the backup drive and mount it at `/mnt/boxpilot-backup` on the Storage page: **Mount a filesystem** (`storage.mount`; medium risk, one confirmation), drive `boxpilot-backup` from `UUID=00000000-0000-4000-8000-000000000002`. It holds the mirror of every local backup in `/mnt/boxpilot-backup/boxpilot-local-mirror`.");
    expect(markdown).toContain(`4. Restore BoxPilot's own database from the encrypted copy, snapshot \`${"1".repeat(64)}\` from 2026-09-27 02:30 UTC in \`/mnt/boxpilot-backup/restic-controller\`, with the recovery password you kept off this server.`);
    expect(markdown).toContain("6. **Restore from a machine snapshot** (`host.snapshot.restore`; high risk, the owner's password and a typed confirmation).");
    expect(markdown).toContain("3. **Restore application data from a backup** (`app.backup.restore`; high risk, the owner's password). It needs the backup's name: the newest recorded is `20260928T030000Z.tar.gz` from 2026-09-28 03:00 UTC in `/var/lib/boxpilot-managed/backups/catalog/jellyfin`.");
    expect(markdown).toContain("copy the app's folder back from the backup drive first: `/mnt/boxpilot-backup/boxpilot-local-mirror/application-backups/jellyfin` into `/var/lib/boxpilot-managed/backups/catalog/jellyfin`.");
    expect(markdown).toContain("No backup of Vaultwarden is recorded, so BoxPilot cannot bring its data back. Once it runs again, take one: **Back up application data** (`app.backup`; medium risk, one confirmation).");
    expect(markdown).toContain("Nothing of Cloudflare Tunnel's is backed up, on purpose");
  });

  it("describes automation in plain words, and the issues open right now", () => {
    const markdown = render(richFacts());
    expect(markdown).toContain("- Daily at 03:00: Back up application data (jellyfin), keeping 5. Last run 2026-09-28 03:00 UTC: ran.");
    expect(markdown).toContain("- Daily at 04:30: Mirror local backups to the off-box SSH destination. Last run 2026-09-28 04:30 UTC: failed.");
    expect(markdown).toContain("- **Reconnect media**: when drive media drops or goes read-only (auto-reconnect). Steps: 1. Reconnect a drive (media).");
    expect(markdown).toContain("- **Tell the phone**: run by hand, paused. Steps: 1. Send an HTTP request.");
    expect(markdown).toContain("No notification target is set, so the items below reached no one.");
    expect(markdown).toContain("- Scheduled task failed: Mirror local backups to the off-box SSH destination (since 2026-09-28 04:31 UTC). Not announced.");
    expect(markdown).toContain("- A new BoxPilot release: BoxPilot 9.9.10 is out (2026-09-27 12:00 UTC).");
  });

  it("labels every fact it could not read as unknown, with the reason, and never leaves it out", () => {
    const markdown = render(unreadableFacts());
    for (const line of [
      "- Hostname: unknown (the host inventory could not be read)",
      "- Operating system: unknown (the host inventory could not be read)",
      "- Database backups: unknown (no database backup has been taken yet)",
      "- App backups (one folder per app): unknown (the app backup folders could not be read)",
      "- Machine snapshots: unknown (the snapshot store could not be read)",
      "- LAN address: unknown (the network could not be read)",
      "- Tailnet: unknown (Tailscale could not be read)",
      "Installed apps: unknown (the app inventory could not be read; is the BoxPilot helper running?).",
      "SMART: unknown (storage scan evidence missing).",
      "Drives and mounts: unknown (the drives could not be read).",
      "- ufw: unknown (the firewall could not be read)",
      "- Tailscale: unknown (Tailscale could not be read).",
      "- Published on the tailnet over HTTPS: unknown (Tailscale Serve could not be read)",
      "- Public tunnel: unknown (the app inventory could not be read).",
      "- Apps: unknown (the app inventory could not be read; is the BoxPilot helper running?).",
      "- Backup drive: where: unknown (the snapshot store could not be read); last copy unknown (the snapshot store could not be read).",
      "- unknown (the schedules could not be read)",
      "Whether this server had a backup drive is unknown (the snapshot store could not be read); if it did, mount it with **Mount a filesystem**",
      "Which apps to restore is unknown (the app inventory could not be read; is the BoxPilot helper running?); the machine snapshot restore lists them.",
      "Whether alerts reach anyone is unknown (the notification setting could not be read).",
    ]) expect(markdown).toContain(line);
    expect(markdown).not.toMatch(/\bundefined\b|\bnull\b|NaN|\[object Object\]/);
  });

  it("never prints a secret, for the owner or an operator", () => {
    for (const markdown of [render(richFacts()), render(richFacts(), "operator", operator), render(richFacts(), "operator", "someone-else")]) {
      expect(markdown).not.toContain(sentinel);
      expect(markdown).not.toContain("hooks.example");
      expect(markdown).not.toContain("push.example");
    }
  });

  it("gives an operator the layout without the second copies' whereabouts or other accounts' details", () => {
    const markdown = render(richFacts(), "operator", operator);
    expect(markdown).toContain("> This is an operator's copy.");
    for (const where of ["backup.example", "example-bucket", "/mnt/boxpilot-backup/boxpilot-local-mirror", "/etc/boxpilot/secrets/backup-mirror-key", "rclone.conf"]) expect(markdown).not.toContain(where);
    expect(markdown).toContain("- Another machine over SSH: where: in the owner's copy of this document; last copy 2026-09-28 04:30 UTC. A plain mirror of the local backups, copied with rsync; not encrypted.");
    // Someone else's schedule: what it does and when, not its parameters or how it last went.
    expect(markdown).toContain("- Daily at 03:00: Back up application data (jellyfin), set up by another account.");
    expect(markdown).toContain("Scheduled daily at 03:00 (set up by another account).");
    // Their own is shown in full.
    expect(markdown).toContain("- Sundays at 09:00: Send an HTTP request. Not run yet.");
    // An alert about another account's schedule reads as what kind of thing it is.
    expect(markdown).toContain("- A scheduled task failed or did not run (since 2026-09-28 04:31 UTC). Not announced.");
    expect(markdown).not.toContain("Scheduled task failed: Mirror local backups");
    // The fingerprint an operator sees is of what they were shown.
    const facts = richFacts();
    expect(renderRunbook(forAudience(facts, { audience: "operator", callerId: operator }), { now }).fingerprint.digest).not.toBe(runbookFingerprint(facts).digest);
  });
});

describe("the fingerprint", () => {
  it("stays the same when only the moment changes", () => {
    const base = runbookFingerprint(richFacts());
    const moved = richFacts();
    moved.apps.items[0].container = "exited";
    Object.assign(moved.apps.items[0].backups, { count: 5, newestAt: "2026-09-29T03:00:00.000Z", newestArtifact: "20260929T030000Z.tar.gz", verification: { verified: false, checkedAt: "2026-09-29T04:00:00.000Z" } });
    moved.storage.drives[0].availableBytes = 1;
    moved.storage.smart.status = "warning";
    moved.issues.conditions = [];
    moved.backups.destinations[1].lastSync = "2026-09-29T04:30:00.000Z";
    moved.backups.database.latest.at = "2026-09-29T02:00:00.000Z";
    Object.assign(moved.automation.schedules[0], { lastRunAt: "2026-09-29T03:00:00.000Z", outcome: "failed" });
    expect(runbookFingerprint(moved)).toEqual(base);
    expect(renderRunbook(richFacts(), { now }).fingerprint).toEqual(renderRunbook(richFacts(), { now: () => new Date("2027-01-01T00:00:00.000Z") }).fingerprint);
  });

  it("changes, and names the section, when the layout changes", () => {
    const base = runbookFingerprint(richFacts());
    const cases = [
      ["Apps", (facts) => { facts.apps.items[0].ports[0].host = 8097; }],
      ["Apps", (facts) => { facts.apps.items.push({ ...facts.apps.items[1], id: "immich" }); }],
      ["Storage", (facts) => { facts.storage.drives[0].autoReconnect = { armed: false }; }],
      ["Network and firewall", (facts) => { facts.network.firewall.rules.pop(); }],
      ["Backups and the second copy", (facts) => { facts.backups.destinations[1].where = "backup.example:/srv/elsewhere"; }],
      ["Automation", (facts) => { facts.automation.schedules[0].cadence = "daily at 05:00"; }],
      ["This server", (facts) => { facts.version = "9.9.10-test"; }],
    ];
    for (const [title, change] of cases) {
      const facts = richFacts();
      change(facts);
      const current = runbookFingerprint(facts);
      expect(current.digest, title).not.toBe(base.digest);
      expect(changedSections(base, current), title).toEqual([title]);
    }
  });
});

describe("out of date since", () => {
  const record = { at: "2026-09-28T10:00:00.000Z", version: "9.9.9-test", digest: "0", sections: {}, markers: storeMarkers({}) };
  const titles = { "app.install": { title: "Install application" }, "app.uninstall": { title: "Uninstall application (keep data)" } };
  const job = (overrides = {}) => ({ id: "j1", type: "op:app.install", title: "Install Immich", state: "completed", createdBy: owner, updatedAt: "2026-09-28T12:00:00.000Z", ...overrides });

  it("is up to date when nothing that changes the document happened after the download", () => {
    const jobs = [
      job({ updatedAt: "2026-09-28T09:00:00.000Z" }),
      job({ state: "failed" }),
      job({ type: "op:app.backup", title: "Back up Jellyfin" }),
      job({ type: "op:apt.refresh", title: "Refresh package lists" }),
    ];
    expect(changesSince(record, { jobs, markers: storeMarkers({}), version: "9.9.9-test", operations: titles })).toEqual([]);
    expect(outOfDate([])).toBeNull();
    expect(changesSince(null, { jobs: [job()] })).toEqual([]);
  });

  it("names the first change since the download, oldest first, and counts the rest", () => {
    const changes = changesSince(record, {
      jobs: [job({ id: "j2", type: "op:app.uninstall", title: "Uninstall Plex", updatedAt: "2026-09-29T08:00:00.000Z" }), job()],
      markers: storeMarkers({ schedules: [{ id: "s1", operationId: "app.backup", frequency: "daily", minute: 0, hour: 3, parameters: { id: "jellyfin" } }] }),
      markerTimes: { automation: "2026-09-28T11:00:00.000Z" },
      version: "9.9.10-test", operations: titles,
    });
    expect(changes.map((change) => change.change)).toEqual(["Schedules or automations changed", "Install Immich", "Uninstall Plex", "BoxPilot changed from 9.9.9-test to 9.9.10-test"]);
    expect(outOfDate(changes)).toEqual({ since: "2026-09-28T11:00:00.000Z", change: "Schedules or automations changed", more: 3 });
  });

  it("tells an operator what kind of change another account made, and their own by its title", () => {
    const changes = changesSince(record, {
      jobs: [job({ id: "j3", title: "Install Paperless", createdBy: operator, updatedAt: "2026-09-28T13:00:00.000Z" }), job()],
      markers: record.markers, version: "9.9.9-test", operations: titles, audience: "operator", callerId: operator,
    });
    expect(changes.map((change) => change.change)).toEqual(["Install application", "Install Paperless"]);
  });

  it("watches only operations the registry has", () => {
    for (const id of layoutOperations) expect(registry.has(id), id).toBe(true);
  });
});

describe("words", () => {
  it("says what approving each operation takes", () => {
    expect(approvalFor(registry.get("app.backup.restore"))).toBe("high risk, the owner's password");
    expect(approvalFor(registry.get("host.snapshot.restore"))).toBe("high risk, the owner's password and a typed confirmation");
    expect(approvalFor(registry.get("controller.backup.create"))).toBe("low risk, one click");
    expect(approvalFor(registry.get("storage.mount"))).toBe("medium risk, one confirmation");
    expect(approvalFor(registry.get("host.snapshot.discover"))).toBe("a read, for an operator or the owner");
    expect(approvalFor(null)).toBe("not available in this BoxPilot");
  });

  it("keeps a fact on one line and drops credentials from a URL", () => {
    expect(clean("https://user:pass@host.example/x\nnext\tline")).toBe("https://host.example/x next line");
    expect(formatTime("2026-09-28T03:04:05.000Z")).toBe("2026-09-28 03:04 UTC");
    expect(formatTime("not a time")).toBeNull();
    expect(formatBytes(4e12)).toBe("4.0 TB");
    expect(formatBytes(1_234_567)).toBe("1.2 MB");
    expect(formatBytes(15e9)).toBe("15 GB");
  });
});
