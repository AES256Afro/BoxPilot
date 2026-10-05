import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { productVersion } from "./version.mjs";
import { helperOperations } from "./helper-protocol.mjs";

describe("native systemd network boundaries", () => {
  it("allows netlink only in the web inventory process", async () => {
    const webUnit = await readFile("deploy/boxpilot.service", "utf8");
    // Git for Windows checks text out with CRLF endings by default (core.autocrlf); the committed file has LF.
    const helperUnit = (await readFile("deploy/boxpilot-helper.service", "utf8")).replaceAll("\r\n", "\n");
    const serverEntry = await readFile("server/index.mjs", "utf8");
    const prerequisites = await readFile("server/prerequisites.mjs", "utf8");
    expect(webUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(webUnit).not.toContain("SupplementaryGroups=libvirt");
    expect(webUnit).not.toContain("SupplementaryGroups=kvm");
    expect(helperUnit).toContain("RestrictAddressFamilies=AF_UNIX\n");
    expect(helperUnit).not.toContain("AF_NETLINK");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_EXPORT_ROOT=/var/lib/boxpilot-managed/vm-exports");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_MEDIA_INBOX=/var/lib/boxpilot-managed/vm-media-inbox");
    expect(helperUnit).toContain("ExecStartPre=/usr/bin/install -d -o boxpilot -g boxpilot -m 0700 /var/lib/boxpilot-managed/vm-media-inbox");
    // The web service reaches its upload inbox through boxpilot-managed: pass through, never list.
    expect(helperUnit).toContain("StateDirectoryMode=0710\n");
    // A chmod before ExecStart is undone by systemd, which sets StateDirectoryMode for every command.
    expect(helperUnit).not.toMatch(/^ExecStartPre=.*chmod/m);
    expect(helperUnit).toContain("Environment=BOXPILOT_MIGRATION_INBOX=/var/lib/boxpilot-migration/inbox");
    expect(helperUnit).toContain("Environment=BOXPILOT_MIGRATION_STAGING_ROOT=/var/lib/boxpilot-managed/migration-staging");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_DATABASE=/var/lib/boxpilot/boxpilot.sqlite3");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_BACKUP_ROOT=/var/lib/boxpilot-managed/backups/boxpilot-controller");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTORE_DRILL_ROOT=/var/lib/boxpilot-managed/controller-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_PROTECTION_DRILL_ROOT=/var/lib/boxpilot-managed/controller-independent-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_BACKUP_MOUNT=/mnt/boxpilot/backup");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/controller-backup-restic-password");
    expect(helperUnit).toContain("Environment=BOXPILOT_CONTROLLER_RESTIC_CACHE_DIRECTORY=/var/cache/boxpilot-controller-restic");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_BACKUP_ROOT=/var/lib/boxpilot-managed/backups");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_PROTECTION_DRILL_ROOT=/var/lib/boxpilot-managed/application-independent-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_APPLICATION_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/application-backup-restic-password");
    expect(helperUnit).toContain("StateDirectory=boxpilot-managed boxpilot-migration");
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_BINARY=/usr/bin/restic");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_BACKUP_MOUNT=/mnt/boxpilot/backup");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RESTORE_DRILL_ROOT=/var/lib/libvirt/images/boxpilot-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RECOVERY_ROOT=/var/lib/libvirt/images/boxpilot-recoveries");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_QEMU_GROUP=libvirt-qemu");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_NVRAM_ROOT=/var/lib/libvirt/qemu/nvram");
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/vm-backup-restic-password");
    expect(helperUnit).toContain("CacheDirectory=boxpilot-restic boxpilot-controller-restic boxpilot-application-restic");
    expect(helperUnit).toContain("CacheDirectoryMode=0700");
    expect(helperUnit).toContain("ReadWritePaths=-/mnt/boxpilot\n");
    // The controller backup runs VACUUM INTO against the live database; with the web service stopped
    // SQLite must recreate the WAL index, which a read-only mount refuses.
    expect(helperUnit).toContain("ReadWritePaths=/var/lib/boxpilot");
    expect(helperUnit).toContain("ConditionPathIsDirectory=/var/lib/boxpilot");
    expect(helperUnit).toContain("ReadWritePaths=-/var/lib/libvirt/images"); // optional: hosts without libvirt must still start the helper
    expect(helperUnit).toContain("ReadWritePaths=-/var/lib/libvirt/boot");
    expect(helperUnit).toContain("ReadWritePaths=-/var/lib/libvirt/qemu/nvram");
    expect(webUnit).toContain("ReadWritePaths=-/var/lib/boxpilot-managed/vm-media-inbox"); // optional: a box with no VM media must still start
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
    expect(compose).toContain(`image: boxpilot:${productVersion}`);
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("/tmp:size=16m,mode=1777");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("normalizes only the generated web distribution after hardened builds", async () => {
    const packageDefinition = await readFile("package.json", "utf8");
    const normalizer = await readFile("scripts/boxpilot-web-dist-permissions.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-web-dist-permissions.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    // Order is what matters, not the exact spelling of the build line: everything that writes into
    // dist must run before the normalizer, or its output keeps whatever permissions it was born
    // with. The precompressed assets are written by the build too, so they are covered by this.
    const build = JSON.parse(packageDefinition).scripts.build;
    const dockerfile = await readFile("Dockerfile", "utf8");
    for (const step of ["scripts/precompress-assets.mjs", "scripts/boxpilot-web-dist-permissions.mjs"]) {
      expect(build).toContain(`node ${step}`);
      expect(build.indexOf("vite build")).toBeLessThan(build.indexOf(step));
      // The image builds the web distribution, so every script that build runs has to be in it.
      expect(dockerfile).toContain(`COPY ${step} ./${step}`);
      expect(dockerfile.indexOf(`COPY ${step}`)).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
    }
    expect(build.indexOf("precompress-assets")).toBeLessThan(build.indexOf("boxpilot-web-dist-permissions"));
    // The build copies public/ (the manifest and the home-screen icons, M25.1) into dist.
    expect(dockerfile.indexOf("COPY public ./public")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("COPY public ./public")).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
    expect(normalizer).toContain("process.argv.length !== 2");
    expect(normalizer).toContain("metadata.isSymbolicLink()");
    expect(normalizer).toContain("metadata.nlink !== 1");
    expect(normalizer).toContain("await chmod(target, 0o755)");
    expect(normalizer).toContain("await chmod(target, 0o644)");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships an executable interactive setup utility without embedding a repository password", async () => {
    const setup = await readFile("scripts/boxpilot-restic-setup.sh", "utf8");
    const metadata = await stat("scripts/boxpilot-restic-setup.sh");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(setup).toContain("stty -echo");
    expect(setup).toContain("vm-backup-restic-password");
    expect(setup).toContain("same filesystem as this server");
    expect(setup).toContain("cannot be a symbolic link");
    expect(setup).not.toMatch(/RESTIC_PASSWORD=/);
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a separate terminal-only controller restic setup without accepting a browser password or destination", async () => {
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

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a separate terminal-only application restic setup and repository key", async () => {
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

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a fixed timer-only SMART scanner outside the browser and privileged helper protocol", async () => {
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
    // Every read leaves a sleeping disk asleep (M36): -n standby, then the device.
    expect(scanner).toContain('Object.freeze(["--json=c", "--all", "-n", "standby"])');
    expect(scanner).toContain("[...smartReadArgs, device]");
    // A USB disk that did not answer is asked once more through its bridge. Still a read: SMART is
    // never switched on or off from here.
    expect(scanner).toContain('[...smartReadArgs, "-d", "sat", device]');
    expect(scanner).not.toMatch(/["'](?:-s|--smart=on|--smart=off)["']/);
    expect(scanner).toContain('["--noheadings", "--nodeps", "--output", "KNAME", source]');
    expect(scanner).toContain('`/sys/fs/ext4/${kernelName}/errors_count`');
    expect(scanner).not.toMatch(/["'](?:fsck|e2fsck|tune2fs)["']/);
    expect(scanner).not.toContain("process.argv[2]");
    expect(protocol).not.toContain("storage.smart.scan");
  });

  // M39.3: the heartbeat. Off until the owner turns it on, so nothing that installs or upgrades
  // BoxPilot may enable it; a oneshot with no capabilities, no retries and a short budget.
  it("ships the heartbeat as a hardened oneshot and a timer nothing enables but the owner", async () => {
    const service = (await readFile("deploy/boxpilot-heartbeat.service", "utf8")).replaceAll("\r\n", "\n");
    const timer = (await readFile("deploy/boxpilot-heartbeat.timer", "utf8")).replaceAll("\r\n", "\n");
    const install = await readFile("scripts/boxpilot-install.sh", "utf8");
    const upgrade = await readFile("scripts/boxpilot-upgrade.sh", "utf8");
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/local\/bin\/node \/opt\/boxpilot\/scripts\/boxpilot-heartbeat\.mjs$/m);
    expect(service).toMatch(/^CapabilityBoundingSet=$/m);
    expect(service).toMatch(/^ProtectSystem=strict$/m);
    expect(service).toMatch(/^StateDirectory=boxpilot-heartbeat$/m);
    expect(service).toMatch(/^TimeoutStartSec=30s$/m);
    expect(service).not.toMatch(/^Restart=/m);
    expect(service).not.toMatch(/^PrivateNetwork=true$/m);
    expect(timer).toMatch(/^OnUnitActiveSec=5min$/m);
    expect(timer).toMatch(/^Unit=boxpilot-heartbeat\.service$/m);
    expect(install).not.toContain("boxpilot-heartbeat");
    expect(upgrade).not.toMatch(/enable[^\n]*boxpilot-heartbeat/);
  });

  it("ships a hardened generic root-runner template unit gated on a per-run approval spec", async () => {
    const unit = await readFile("deploy/boxpilot-run@.service", "utf8");
    expect(unit).toContain("ConditionPathExists=/run/boxpilot/run/%i.json");
    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-run.mjs %i");
    expect(unit).toContain("Type=oneshot");
    // Package management needs real root: no User=, no kernel/module/device protection (verified on Ubuntu 26.04).
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toContain("ProtectKernelModules=true");
    expect(unit).not.toContain("PrivateDevices=true");
    expect(unit).not.toContain("PrivateNetwork=true");
    expect(unit).toContain("PrivateTmp=true");
    const runner = await readFile("scripts/boxpilot-run.mjs", "utf8");
    expect(runner).toContain('from "../server/tasks/index.mjs"');
    expect(runner).not.toMatch(/child_process|exec\(|spawn\(/);
  });

  it("ships a static exact-package drive-tools installer without a general package argument", async () => {
    const service = await readFile("deploy/boxpilot-smartmontools-install.service", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    expect(service).toContain("Type=oneshot");
    const installer = await readFile("scripts/boxpilot-smartmontools-install.mjs", "utf8");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-smartmontools-install.mjs");
    // exfatprogs may be the only one missing, so the unit must still start when smartctl exists.
    expect(service).not.toContain("ConditionPathExists=!/usr/sbin/smartctl");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/smartmontools-approval.json");
    // The fixed set, and only exact pinned versions from it.
    expect(installer).toContain('const fixedPackages = Object.freeze(["exfatprogs", "smartmontools"]);');
    expect(installer).toContain("`${name}=${approved[name]}`");
    expect(installer).toContain('"--no-install-recommends", "--no-remove"');
    expect(installer).toContain("[\"start\", \"boxpilot-storage-scan.service\"]");
    expect(installer).toContain("process.argv.length !== 2");
    expect(helperOperations.has("prerequisite.drive-tools.install")).toBe(true);
    expect(service).not.toContain("apt-get update");
    expect(installer).not.toContain("apt-get update");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("$PACKAGE");
    expect(service).not.toContain("[Install]");
    expect(helperOperations.has("prerequisite.smartmontools.install")).toBe(true);
    expect(protocol).not.toContain("package.install");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a separate static exact-package restic installer without repository setup inputs", async () => {
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
    expect(helperOperations.has("prerequisite.restic.install")).toBe(true);
    expect(protocol).not.toContain("package.install");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a separate static exact-package Docker Engine installer without provider or daemon inputs", async () => {
    const service = await readFile("deploy/boxpilot-docker-install.service", "utf8");
    const installer = await readFile("scripts/boxpilot-docker-install.mjs", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-docker-install.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-docker-install.mjs");
    expect(service).toContain("ConditionPathExists=!/usr/bin/docker");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/docker-approval.json");
    expect(installer).toContain("`docker.io=${approval.expectedVersion}`");
    expect(installer).toContain('["enable", "docker.service"]');
    expect(installer).toContain('["start", "docker.service"]');
    expect(installer).toContain("process.argv.length !== 2");
    expect(service).not.toContain("apt-get update");
    expect(installer).not.toContain("apt-get update");
    expect(installer).not.toContain("daemon.json");
    expect(installer).not.toContain("docker pull");
    expect(installer).not.toContain("docker run");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("$PACKAGE");
    expect(service).not.toContain("[Install]");
    expect(helperOperations.has("prerequisite.docker.install")).toBe(true);
    expect(protocol).not.toContain("package.install");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a static fixed virtualization bundle installer without provider, URI, network, pool, or VM inputs", async () => {
    const service = await readFile("deploy/boxpilot-virtualization-install.service", "utf8");
    const installer = await readFile("scripts/boxpilot-virtualization-install.mjs", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-virtualization-install.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-virtualization-install.mjs");
    expect(service).toContain("ConditionPathExists=/dev/kvm");
    expect(service).toContain("ConditionPathExists=!/usr/bin/virsh");
    expect(service).toContain("ConditionPathExists=!/usr/bin/qemu-system-x86_64");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/virtualization-approval.json");
    expect(installer).toContain('const packageNames = ["qemu-system-x86", "libvirt-daemon-system", "libvirt-clients", "virtinst", "ovmf"]');
    expect(installer).toContain('["enable", "libvirtd.service"]');
    expect(installer).toContain('["start", "libvirtd.service"]');
    expect(installer).toContain('["--connect", "qemu:///system", "uri"]');
    expect(installer).toContain("process.argv.length !== 2");
    expect(service).not.toContain("apt-get update");
    expect(installer).not.toContain("apt-get update");
    expect(installer).not.toContain("virsh net-");
    expect(installer).not.toContain("virsh pool-");
    expect(installer).not.toContain("virt-install");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("[Install]");
    expect(helperOperations.has("prerequisite.virtualization.install")).toBe(true);
    expect(protocol).not.toContain("package.install");
  });

  // Linux only: checks the POSIX executable bit.
  it.skipIf(onWindows)("ships a static fixed libvirt foundation initializer with job-limited rollback", async () => {
    const service = await readFile("deploy/boxpilot-libvirt-foundation.service", "utf8");
    const initializer = await readFile("scripts/boxpilot-libvirt-foundation.mjs", "utf8");
    const foundationHelper = await readFile("server/libvirt-foundation-helper.mjs", "utf8");
    const helperUnit = await readFile("deploy/boxpilot-helper.service", "utf8");
    const protocol = await readFile("server/helper-protocol.mjs", "utf8");
    const metadata = await stat("scripts/boxpilot-libvirt-foundation.mjs");
    expect(metadata.mode & 0o111).not.toBe(0);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-libvirt-foundation.mjs");
    expect(service).toContain("ConditionPathExists=/run/boxpilot/libvirt-foundation-approval.json");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(service).toContain("PrivateNetwork=true");
    expect(service).toContain("CapabilityBoundingSet=\n");
    expect(service).toContain("ReadWritePaths=/var/lib/libvirt");
    expect(service).not.toContain("%i");
    expect(service).not.toContain("[Install]");
    expect(helperUnit).toContain("PrivateNetwork=true");
    expect(helperUnit).toContain("PrivateDevices=true");
    expect(initializer).toContain("process.argv.length !== 2");
    expect(initializer).toContain("<name>default</name>");
    expect(initializer).toContain("192.168.122.1");
    expect(foundationHelper).toContain('const poolTarget = "/var/lib/libvirt/images"');
    expect(initializer).toContain('["net-undefine", libvirtFoundationSpec.networkName]');
    expect(initializer).toContain('["pool-undefine", libvirtFoundationSpec.poolName]');
    expect(initializer).not.toContain("process.argv[2]");
    expect(initializer).not.toContain("virt-install");
    expect(protocol).toContain("virtualization.foundation.inspect");
    expect(helperOperations.has("vm.foundation.initialize")).toBe(true);
    expect(helperOperations.has("virtualization.foundation.initialize")).toBe(false);
    expect(protocol).not.toContain("virtualization.resource.execute");
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
    expect(helperOperations.has("prerequisite.apt-metadata.refresh")).toBe(true);
    expect(protocol).not.toContain("package.update");
  });

});


describe("surviving a reboot with the backup drive still waking up", () => {
  it("does not let one failed helper start cancel the web service for good", async () => {
    // 2026-09-09: the helper failed once at boot (its bind path hit "No such device" while the USB
    // drive was probed), restarted fine five seconds later, and the web service stayed down for
    // hours because Requires= had turned that first failure into a dependency failure, which
    // systemd never retries.
    const web = await readFile("deploy/boxpilot.service", "utf8");
    expect(web).toMatch(/^Wants=boxpilot-helper\.service$/m);
    expect(web).not.toMatch(/^Requires=boxpilot-helper\.service$/m);
    expect(web).toMatch(/^After=boxpilot-helper\.service$/m);
  });

  it("gives the helper the folder above the backup share's automount, never the automount itself", async () => {
    // 2026-09-28: waiting for the network was not enough. With the NAS off, setting up the sandbox
    // resolved ReadWritePaths=-/mnt/boxpilot-backup, which fired the automount, the mount failed
    // with "No such device" and so did the helper, again and again until the NAS came back.
    // tests/ubuntu/helper-automount.sh reproduces that on systemd 259 and 255 and proves this layout.
    const helper = (await readFile("deploy/boxpilot-helper.service", "utf8")).replaceAll("\r\n", "\n");
    const { backupMountParent, backupMountpoint, legacyBackupMountpoint } = await import("./backup-mount.mjs");
    expect(path.posix.dirname(backupMountpoint)).toBe(backupMountParent);
    const sandboxPaths = [...helper.matchAll(/^(?:ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|ExecPaths|NoExecPaths|BindPaths|BindReadOnlyPaths|RequiresMountsFor)=(.*)$/gm)]
      .flatMap((match) => match[1].trim().split(/\s+/)).map((entry) => entry.replace(/^[-+]+/, "").split(":")[0]);
    for (const entry of sandboxPaths) {
      expect(entry === backupMountpoint || entry.startsWith(`${backupMountpoint}/`) || entry === legacyBackupMountpoint, `${entry} names the automount point`).toBe(false);
    }
    // The hardening stays: the one folder BoxPilot owns, not /mnt, and the rest still read-only.
    expect(sandboxPaths).toContain(backupMountParent);
    expect(sandboxPaths).not.toContain("/mnt");
    expect(helper).toMatch(/^ProtectSystem=strict$/m);
    expect(helper).toMatch(/^NoNewPrivileges=true$/m);
    for (const variable of ["CONTROLLER", "APPLICATION", "VM"]) expect(helper).toContain(`Environment=BOXPILOT_${variable}_BACKUP_MOUNT=${backupMountpoint}\n`);
    // Ordering only, on the automount unit; neither it nor the network is waited on or required.
    expect(helper).toMatch(/^After=mnt-boxpilot-backup\.automount$/m);
    expect(helper).not.toMatch(/^(?:Wants|Requires|BindsTo|Requisite)=.*(?:automount|network-online)/m);
  });

  it("creates that folder on install and moves an existing destination into it on upgrade", async () => {
    const install = (await readFile("scripts/boxpilot-install.sh", "utf8")).replaceAll("\r\n", "\n");
    const upgrade = (await readFile("scripts/boxpilot-upgrade.sh", "utf8")).replaceAll("\r\n", "\n");
    expect(install).toContain("install -d -o root -g root -m 0755 /mnt/boxpilot\n");
    // The mount point only when it is missing: on a re-run it is the destination, and `install -d`
    // on it woke its automount (and failed with the NAS off) or handed the NAS's folder to root.
    expect(install).toContain("[ -e /mnt/boxpilot/backup ] || install -d -o root -g root -m 0755 /mnt/boxpilot/backup\n");
    expect(install).not.toContain("/mnt/boxpilot-backup");
    // After the new units are in place and before the helper restarts; undone by a rollback, since
    // the old helper looks for the destination where it used to be.
    const moved = upgrade.indexOf('if moved="$("$NODE_BIN" "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"');
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(upgrade.indexOf("systemctl daemon-reload\n"));
    expect(moved).toBeLessThan(upgrade.indexOf("systemctl restart boxpilot-helper.service ||"));
    expect(upgrade).toMatch(/rollback\(\) \{[\s\S]*boxpilot-backup-mount-move\.mjs" undo "\$BACKUP_MOUNT_UNDO"[\s\S]*mv "\$PREVIOUS" "\$INSTALL_DIR"/);
  });
});
