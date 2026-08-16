import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("native systemd network boundaries", () => {
  it("allows netlink only in the web inventory process", async () => {
    const webUnit = await readFile("deploy/boxpilot.service", "utf8");
    const helperUnit = await readFile("deploy/boxpilot-helper.service", "utf8");
    const serverEntry = await readFile("server/index.mjs", "utf8");
    const prerequisites = await readFile("server/prerequisites.mjs", "utf8");
    expect(webUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(webUnit).not.toContain("SupplementaryGroups=libvirt");
    expect(webUnit).not.toContain("SupplementaryGroups=kvm");
    expect(helperUnit).toContain("RestrictAddressFamilies=AF_UNIX\n");
    expect(helperUnit).not.toContain("AF_NETLINK");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_EXPORT_ROOT=/var/lib/boxpilot-managed/vm-exports");
    expect(helperUnit).toContain("Environment=BOXPILOT_MIGRATION_INBOX=/var/lib/boxpilot-migration/inbox");
    expect(helperUnit).toContain("Environment=BOXPILOT_MIGRATION_STAGING_ROOT=/var/lib/boxpilot-managed/migration-staging");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_DATABASE=/var/lib/boxpilot/boxpilot.sqlite3");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_BACKUP_ROOT=/var/lib/boxpilot-managed/backups/boxpilot-controller");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTORE_DRILL_ROOT=/var/lib/boxpilot-managed/controller-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_PROTECTION_DRILL_ROOT=/var/lib/boxpilot-managed/controller-independent-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_BACKUP_MOUNT=/mnt/boxpilot-backup");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/controller-backup-restic-password");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTIC_CACHE_DIRECTORY=/var/cache/boxpilot-controller-restic");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_BACKUP_ROOT=/var/lib/boxpilot-managed/backups");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_PROTECTION_DRILL_ROOT=/var/lib/boxpilot-managed/application-independent-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/application-backup-restic-password");
    expect(helperUnit).toContain("StateDirectory=boxpilot-managed boxpilot-migration");
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_BINARY=/usr/bin/restic");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_BACKUP_MOUNT=/mnt/boxpilot-backup");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RESTORE_DRILL_ROOT=/var/lib/libvirt/images/boxpilot-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RECOVERY_ROOT=/var/lib/libvirt/images/boxpilot-recoveries");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_QEMU_GROUP=libvirt-qemu");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_NVRAM_ROOT=/var/lib/libvirt/qemu/nvram");
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/vm-backup-restic-password");
    expect(helperUnit).toContain("CacheDirectory=boxpilot-restic boxpilot-controller-restic boxpilot-application-restic");
    expect(helperUnit).toContain("CacheDirectoryMode=0700");
    expect(helperUnit).toContain("ReadWritePaths=-/mnt/boxpilot-backup");
    expect(helperUnit).toContain("ReadOnlyPaths=/var/lib/boxpilot");
    expect(helperUnit).toContain("ReadWritePaths=/var/lib/libvirt/images");
    expect(helperUnit).toContain("ReadWritePaths=/var/lib/libvirt/qemu/nvram");
    expect(helperUnit).toContain("PrivateNetwork=true");
    expect(helperUnit).toContain("UMask=0077");
    expect(serverEntry).toContain("createHelperLibvirtService");
    expect(serverEntry).not.toContain("createLibvirtService");
    expect(prerequisites).not.toContain('runCommand("virsh"');
  });

  it("keeps the disposable container preview writable only in temporary state", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const compose = await readFile("docker-compose.yml", "utf8");
    expect(dockerfile).toContain("BOXPILOT_STATE_DIRECTORY=/tmp/boxpilot");
    expect(dockerfile).toContain("BOXPILOT_COOKIE_SECURE=false");
    expect(dockerfile).toContain("USER node");
    expect(compose).toContain("image: boxpilot:0.47.0");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("/tmp:size=16m,mode=1777");
  });

  it("ships an executable interactive setup utility without embedding a repository password", async () => {
    const setup = await readFile("scripts/boxpilot-restic-setup.sh", "utf8");
    const metadata = await stat("scripts/boxpilot-restic-setup.sh");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(setup).toContain("stty -echo");
    expect(setup).toContain("vm-backup-restic-password");
    expect(setup).toContain("same filesystem as Bigbox data");
    expect(setup).toContain("cannot be a symbolic link");
    expect(setup).not.toMatch(/RESTIC_PASSWORD=/);
  });

  it("ships a separate terminal-only controller restic setup without accepting a browser password or destination", async () => {
    const setup = await readFile("scripts/boxpilot-controller-restic-setup.sh", "utf8");
    const metadata = await stat("scripts/boxpilot-controller-restic-setup.sh");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(setup).toContain("restic-controller");
    expect(setup).toContain("controller-backup-restic-password");
    expect(setup).toContain("stty -echo");
    expect(setup).toContain("/var/lib/boxpilot-managed");
    expect(setup).toContain("/var/lib/boxpilot");
    expect(setup).not.toContain("$1");
    expect(setup).not.toMatch(/RESTIC_PASSWORD=/);
  });

  it("ships a separate terminal-only application restic setup and repository key", async () => {
    const setup = await readFile("scripts/boxpilot-application-restic-setup.sh", "utf8");
    const metadata = await stat("scripts/boxpilot-application-restic-setup.sh");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(setup).toContain("restic-applications");
    expect(setup).toContain("application-backup-restic-password");
    expect(setup).toContain("stty -echo");
    expect(setup).toContain("/var/lib/boxpilot-managed/apps");
    expect(setup).toContain("/var/lib/boxpilot-managed/backups");
    expect(setup).not.toContain("$1");
    expect(setup).not.toMatch(/RESTIC_PASSWORD=/);
  });

  it("ships a fixed timer-only SMART scanner outside the browser and privileged helper protocol", async () => {
    const service = await readFile("deploy/boxpilot-storage-scan.service", "utf8");
    const timer = await readFile("deploy/boxpilot-storage-scan.timer", "utf8");
    const scanner = await readFile("scripts/boxpilot-storage-scan.mjs", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-storage-scan.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("PrivateNetwork=true");
    expect(service).toContain("ReadWritePaths=/var/lib/boxpilot");
    expect(service).toContain("ConditionPathIsDirectory=/var/lib/boxpilot");
    expect(service).not.toContain("StateDirectory=boxpilot");
    expect(timer).toContain("OnUnitActiveSec=6h");
    expect(scanner).toContain('["--json=c", "--all", device]');
    expect(scanner).toContain('["--noheadings", "--nodeps", "--output", "KNAME", source]');
    expect(scanner).toContain('`/sys/fs/ext4/${kernelName}/errors_count`');
    expect(scanner).not.toMatch(/["'](?:fsck|e2fsck|tune2fs)["']/);
    expect(scanner).not.toContain("process.argv[2]");
    expect(protocol).not.toContain("storage.smart.scan");
  });

  it("ships a static exact-package smartmontools installer without a general package argument", async () => {
    const service = await readFile("deploy/boxpilot-smartmontools-install.service", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    expect(service).toContain("Type=oneshot");
    const installer = await readFile("scripts/boxpilot-smartmontools-install.mjs", "utf8");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-smartmontools-install.mjs");
    expect(service).toContain("ConditionPathExists=!/usr/sbin/smartctl");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/smartmontools-approval.json");
    expect(installer).toContain("`smartmontools=${approval.expectedVersion}`");
    expect(installer).toContain("[\"start\", \"boxpilot-storage-scan.service\"]");
    expect(installer).toContain("process.argv.length !== 2");
    expect(service).not.toContain("apt-get update");
    expect(installer).not.toContain("apt-get update");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("$PACKAGE");
    expect(service).not.toContain("[Install]");
    expect(protocol).toContain("prerequisite.smartmontools.install");
    expect(protocol).not.toContain("package.install");
  });

  it("ships a separate static exact-package restic installer without repository setup inputs", async () => {
    const service = await readFile("deploy/boxpilot-restic-install.service", "utf8");
    const installer = await readFile("scripts/boxpilot-restic-install.mjs", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-restic-install.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-restic-install.mjs");
    expect(service).toContain("ConditionPathExists=!/usr/bin/restic");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/restic-approval.json");
    expect(installer).toContain("`restic=${approval.expectedVersion}`");
    expect(installer).toContain('["version"]');
    expect(installer).toContain("process.argv.length !== 2");
    expect(service).not.toContain("apt-get update");
    expect(installer).not.toContain("apt-get update");
    expect(installer).not.toContain("restic init");
    expect(installer).not.toContain("--repo");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("$PACKAGE");
    expect(service).not.toContain("[Install]");
    expect(protocol).toContain("prerequisite.restic.install");
    expect(protocol).not.toContain("package.install");
  });

  it("ships a static metadata-only APT refresh without browser package or command arguments", async () => {
    const service = await readFile("deploy/boxpilot-apt-refresh.service", "utf8");
    const refresher = await readFile("scripts/boxpilot-apt-refresh.mjs", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-apt-refresh.mjs");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/apt-refresh-approval.json");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("$PACKAGE");
    expect(service).not.toContain("[Install]");
    expect(refresher).toContain('run("/usr/bin/apt-get", ["update", "--error-on=any"]');
    expect(refresher).toContain("process.argv.length !== 2");
    expect(refresher).toContain("installed package database changed");
    expect(refresher).not.toMatch(/(?:install|upgrade|remove|autoremove|dist-upgrade)["']/);
    expect(protocol).toContain("prerequisite.apt-metadata.refresh");
    expect(protocol).not.toContain("package.update");
  });

  it("ships a static fixed Keel artifact downloader without weakening the main helper network sandbox", async () => {
    const service = await readFile("deploy/boxpilot-keel-artifact.service", "utf8");
    const downloader = await readFile("scripts/boxpilot-keel-artifact.mjs", "utf8");
    const helperUnit = await readFile("deploy/boxpilot-helper.service", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-keel-artifact.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-artifact.mjs");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/keel-artifact-approval.json");
    expect(service).toContain("ReadWritePaths=/var/lib/boxpilot-managed/artifacts/keel");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("[Install]");
    expect(helperUnit).toContain("PrivateNetwork=true");
    expect(helperUnit).toContain("RestrictAddressFamilies=AF_UNIX\n");
    expect(downloader).toContain("process.argv.length !== 2");
    expect(downloader).toContain('new Set(["github.com", "release-assets.githubusercontent.com"])');
    expect(downloader).not.toContain("process.argv[2]");
    expect(protocol).toContain("application.keel.artifact.acquire");
    expect(protocol).not.toContain("artifact.download");
  });

  it("ships a fixed Keel installer with a dedicated account, loopback unit, and preserved state rollback", async () => {
    const service = await readFile("deploy/boxpilot-keel-install.service", "utf8");
    const installer = await readFile("scripts/boxpilot-keel-install.mjs", "utf8");
    const installSpec = await readFile("server/keel-install-spec.mjs", "utf8");
    const helperUnit = await readFile("deploy/boxpilot-helper.service", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-keel-install.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("StateDirectory=keel");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-install.mjs");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/keel-install-approval.json");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadWritePaths=/var/lib/keel");
    expect(service).toContain("ReadWritePaths=/etc/systemd/system");
    expect(service).not.toContain("ReadWritePaths=/etc\n");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("[Install]");
    expect(helperUnit).toContain("PrivateNetwork=true");
    expect(installer).toContain("process.argv.length !== 2");
    expect(installer).not.toContain("process.argv[2]");
    expect(installer).toContain("if (environmentPublished) await unlink(paths.environment)");
    expect(installer).not.toContain("rm(paths.state");
    expect(installSpec).toContain("User=keel");
    expect(installSpec).toContain("Group=keel");
    expect(installSpec).toContain("HOST=127.0.0.1");
    expect(installSpec).toContain("ExecStart=/usr/local/bin/node /var/lib/boxpilot-managed/apps/keel/current/bin/keel.mjs start --foreground --port 3000");
    expect(installSpec).toContain("CapabilityBoundingSet=");
    expect(installSpec).toContain("ProtectSystem=strict");
    expect(protocol).toContain("application.keel.install");
    expect(protocol).not.toContain("service.install");
  });

  it("ships a terminal-only Keel claim handoff that drops root before opening SQLite", async () => {
    const claim = await readFile("scripts/boxpilot-keel-claim.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-keel-claim.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(claim).toContain("process.argv.length !== 3");
    expect(claim).toContain("sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-claim.mjs");
    expect(claim).toContain("setGroups([account.gid])");
    expect(claim).toContain("setGid(account.gid)");
    expect(claim).toContain("setUid(account.uid)");
    expect(claim).toContain('authorize: async () => "boxpilot-terminal-sudo"');
    expect(claim).not.toContain("application.keel.claim");
  });

  it("ships a terminal-only migration packer without a browser-selectable inbox", async () => {
    const packer = await readFile("scripts/boxpilot-migration-pack.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-migration-pack.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(packer).toContain("--source-fingerprint");
    expect(packer).not.toContain("--inbox-root");
    expect(packer).not.toContain("--destination");
  });
});
