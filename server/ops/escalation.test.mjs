import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry.mjs";
import { operationModules, registry } from "./index.mjs";
import { escalationRiskHooks, higherOf, loginHomesFrom, packetFilterUnit, serveWithdrawRisk } from "./escalation.mjs";
import { onWindows } from "../../test/platform.mjs";
import { readFile } from "node:fs/promises";

/** The tier a job is staged at, as the jobs service works it out. */
const withHooks = createRegistry(operationModules).useRiskHooks(escalationRiskHooks);
const tier = (id, parameters) => withHooks.effectiveRisk(id, parameters);

describe("a medium operation is high for what it acts on", () => {
  it("names only registered medium operations, so a hook can never lower a tier", () => {
    for (const id of Object.keys(escalationRiskHooks)) expect(registry.get(id)?.risk, id).toBe("medium");
  });

  it("raises a share or export of a login account's home, and leaves the data drives alone", async () => {
    expect(await tier("samba.apply", { shares: [{ name: "Media", path: "/mnt/media" }, { name: "Admin", path: "/home/admin" }] })).toBe("high");
    expect(await tier("samba.apply", { shares: [{ name: "Home", path: "/home" }] })).toBe("high");
    expect(await tier("samba.apply", { shares: [{ name: "Media", path: "/mnt/media" }, { name: "Srv", path: "/srv/homework" }] })).toBe("medium");
    expect(await tier("samba.apply", { shares: [] })).toBe("medium");
    expect(await tier("nfs.apply", { exports: [{ path: "/home/admin/photos" }] })).toBe("high");
    expect(await tier("nfs.apply", { exports: [{ path: "/srv/media" }] })).toBe("medium");
  });

  it("raises a new account that comes with SSH keys, as importing them is", async () => {
    expect(await tier("users.add", { username: "sam", githubUser: "sam" })).toBe("high");
    expect(await tier("users.add", { username: "sam", githubUser: null })).toBe("medium");
    expect(await tier("users.add", { username: "sam" })).toBe("medium");
    expect(registry.get("users.keys.import").risk).toBe("high");
  });

  it("raises installing or removing what keeps SSH, Tailscale and the firewall up, however apt is told", async () => {
    for (const packages of [["openssh-server"], ["htop", "ufw"], ["tailscale"], ["openssh-server-"], ["sudo:amd64"], ["docker-ce"]]) {
      expect(await tier("apt.remove", { packages }), packages.join(" ")).toBe("high");
      expect(await tier("apt.install", { packages }), packages.join(" ")).toBe("high");
    }
    expect(await tier("apt.remove", { packages: ["htop", "ncdu"] })).toBe("medium");
    expect(await tier("apt.install", { packages: ["openssh-server-extra"] })).toBe("medium");
  });

  it("raises any action on a unit that loads or flushes the packet filter", async () => {
    for (const unit of ["nftables.service", "netfilter-persistent.service", "iptables.service", "ip6tables-restore.service"]) {
      expect(packetFilterUnit.test(unit), unit).toBe(true);
      expect(await tier("service.action", { unit, action: "start" }), unit).toBe("high");
    }
    expect(await tier("service.action", { unit: "nginx.service", action: "restart" })).toBe("medium");
  });

  it("raises mounting anything at the backup destination, which is choosing where backups leave the box", async () => {
    expect(await tier("share.mount", { kind: "smb", host: "nas.lan", share: "backups", name: "boxpilot-backup" })).toBe("high");
    expect(await tier("share.mount", { kind: "smb", host: "nas.lan", share: "media", name: "media" })).toBe("medium");
    expect(await tier("storage.mount", { uuid: "1234-ABCD", name: "boxpilot-backup" })).toBe("high");
    expect(await tier("storage.mount", { uuid: "1234-ABCD", name: "media" })).toBe("medium");
  });
});

describe("BoxPilot's root tasks are not service.action's to control", () => {
  it("refuses a boxpilot-run@ unit whatever the action, and still controls the web and agents services", () => {
    expect(registry.validate("service.action", { unit: "boxpilot-run@0f8f1c2e-1111-4222-8333-444455556666.service", action: "restart" })).toContain("root tasks");
    expect(registry.validate("service.action", { unit: "boxpilot-run@x.service", action: "stop" })).toContain("root tasks");
    expect(registry.validate("service.action", { unit: "boxpilot-agents.service", action: "restart" })).toBeNull();
    expect(registry.validate("service.action", { unit: "boxpilot.service", action: "restart" })).toBeNull();
  });

  it("raises the Cloudflare tunnel: installing it, and giving it a new token", async () => {
    expect(await readFile("catalog/cloudflared.yaml", "utf8")).toMatch(/^risk: high$/m);
    expect(await tier("app.reconfigure", { id: "cloudflared", values: { env: { TUNNEL_TOKEN: "eyJ..." } } })).toBe("high");
    expect(await tier("app.reconfigure", { id: "cloudflared", values: { ports: {} } })).toBe("medium");
    expect(await tier("app.reconfigure", { id: "jellyfin", values: { env: { TUNNEL_TOKEN: "x" } } })).toBe("medium");
  });

  it("raises a backup that would prune below what housekeeping always keeps", async () => {
    expect(await tier("app.backup", { id: "vaultwarden", keep: 1 })).toBe("high");
    expect(await tier("app.backup", { id: "vaultwarden", keep: 2 })).toBe("high");
    expect(await tier("app.backup", { id: "vaultwarden", keep: 3 })).toBe("medium");
    expect(await tier("app.backup", { id: "vaultwarden" })).toBe("medium");
    expect(await tier("app.backup.many", { ids: ["vaultwarden", "immich"], keep: 1 })).toBe("high");
    expect(await tier("app.backup.many", { ids: ["vaultwarden", "immich"] })).toBe("medium");
  });

  it("raises withdrawing the tailnet address BoxPilot itself is served at", async () => {
    const hooks = createRegistry(operationModules).useRiskHooks({ "app.serve.withdraw": serveWithdrawRisk(async () => ["https://box.tail1234.ts.net", "https://box.tail1234.ts.net:8443"]) });
    expect(await hooks.effectiveRisk("app.serve.withdraw", { port: 443 })).toBe("high");
    expect(await hooks.effectiveRisk("app.serve.withdraw", { port: 8443 })).toBe("high");
    expect(await hooks.effectiveRisk("app.serve.withdraw", { port: 8084 })).toBe("medium");
    const unreadable = createRegistry(operationModules).useRiskHooks({ "app.serve.withdraw": serveWithdrawRisk(async () => { throw new Error("tailscale is not running"); }) });
    expect(await unreadable.effectiveRisk("app.serve.withdraw", { port: 443 })).toBe("medium");
  });

  it("raises a data folder chosen outside /mnt, /media and /srv, on install and on a settings change", async () => {
    for (const folder of ["/var/spool/cron", "/home/admin", "/home/admin/Photos", "/opt/data", "/mnt", "/srvx/media", "/tmp"]) {
      expect(await tier("app.install", { id: "filebrowser", values: { volumes: { data: folder } } }), folder).toBe("high");
      expect(await tier("app.reconfigure", { id: "filebrowser", values: { volumes: { data: folder } } }), folder).toBe("high");
    }
    for (const folder of ["/mnt/media", "/media/usb/photos", "/srv/files/", "/srv/a/b"]) {
      expect(await tier("app.install", { id: "filebrowser", values: { volumes: { data: folder } } }), folder).toBe("medium");
    }
    // No folder chosen: the manifest's own default, which the catalog wrote.
    expect(await tier("app.install", { id: "filebrowser", values: {} })).toBe("medium");
    expect(await tier("app.reconfigure", { id: "filebrowser", values: { ports: { web: 8080 } } })).toBe("medium");
  });

  it("stages an install at the higher of its manifest's tier and its folders'", async () => {
    const manifestTier = async (parameters) => (parameters.id === "pihole" ? "high" : "medium");
    const install = higherOf(escalationRiskHooks["app.install"], manifestTier);
    expect(await install({ id: "pihole", values: {} })).toBe("high");
    expect(await install({ id: "jellyfin", values: { volumes: { media: "/home/admin" } } })).toBe("high");
    expect(await install({ id: "jellyfin", values: { volumes: { media: "/mnt/media" } } })).toBe("medium");
    expect(await higherOf(async () => { throw new Error("catalog down"); }, async () => "medium")({})).toBe("medium");
  });

  it("reads which accounts can log in, and where their homes are, from /etc/passwd", () => {
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "postgres:x:114:120:PostgreSQL administrator:/var/lib/postgresql:/bin/bash",
      "backup:x:34:34:backup:/var/backups:/usr/sbin/nologin",
      "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
      "sync:x:4:65534:sync:/bin:/bin/sync",
      "git:x:998:998::/srv/git/:/usr/bin/git-shell",
      "",
    ].join("\n");
    expect(loginHomesFrom(passwd)).toEqual(["/root", "/var/lib/postgresql", "/srv/git"]);
  });

  // Linux only: reads the host's own /etc/passwd, where root logs in with a shell at /root.
  it.skipIf(onWindows)("raises a share or export inside any login account's home, not only under /home", async () => {
    expect(await tier("samba.apply", { shares: [{ name: "Root", path: "/root/files" }] })).toBe("high");
    expect(await tier("nfs.apply", { exports: [{ path: "/root" }] })).toBe("high");
    expect(await tier("samba.apply", { shares: [{ name: "Media", path: "/mnt/media" }] })).toBe("medium");
  });

  it("raises local names pointed at another machine, routes offered to the tailnet, and a cleanup that erases history", async () => {
    expect(await tier("dns.names.apply", { address: "192.0.2.77" })).toBe("high");
    expect(await tier("dns.names.apply", { address: "127.0.0.1" })).toBe("medium");
    expect(await tier("tailscale.set", { exitNode: true })).toBe("high");
    expect(await tier("tailscale.set", { subnetRouter: true, routes: ["172.17.0.0/16"] })).toBe("high");
    expect(await tier("tailscale.set", { exitNode: false, subnetRouter: false, routes: [] })).toBe("medium");
    expect(await tier("space.cleanup", { categories: ["journal"], journalMaxAgeDays: 1 })).toBe("high");
    expect(await tier("space.cleanup", { categories: ["journal"], journalMaxBytes: 64 * 1024 ** 2 })).toBe("high");
    expect(await tier("space.cleanup", { categories: ["job-logs"], jobLogRetentionDays: 1 })).toBe("high");
    expect(await tier("space.cleanup", { categories: ["journal", "job-logs"], journalMaxAgeDays: 30, jobLogRetentionDays: 14 })).toBe("medium");
    expect(await tier("space.cleanup", { categories: ["apt-cache"], journalMaxAgeDays: 1 })).toBe("medium");
  });
});
