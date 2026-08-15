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
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_BINARY=/usr/bin/restic");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_BACKUP_MOUNT=/mnt/boxpilot-backup");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RESTORE_DRILL_ROOT=/var/lib/libvirt/images/boxpilot-restore-drills");
    expect(helperUnit).toContain("Environment=BOXPILOT_VM_RECOVERY_ROOT=/var/lib/libvirt/images/boxpilot-recoveries");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_QEMU_GROUP=libvirt-qemu");
    expect(helperUnit).toContain("Environment=BOXPILOT_LIBVIRT_NVRAM_ROOT=/var/lib/libvirt/qemu/nvram");
    expect(helperUnit).toContain("Environment=BOXPILOT_RESTIC_PASSWORD_FILE=/etc/boxpilot/secrets/vm-backup-restic-password");
    expect(helperUnit).toContain("CacheDirectory=boxpilot-restic");
    expect(helperUnit).toContain("CacheDirectoryMode=0700");
    expect(helperUnit).toContain("ReadWritePaths=-/mnt/boxpilot-backup");
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
    expect(compose).toContain("image: boxpilot:0.16.0");
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
});
