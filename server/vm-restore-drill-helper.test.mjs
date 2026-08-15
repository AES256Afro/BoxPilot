import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVmRestoreDrillHelper, restoreDrillDomainName, validateVmRestoreDrillInput } from "./vm-restore-drill-helper.mjs";

const directories = [];
const drillId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const exportId = "33333333-3333-4333-8333-333333333333";
const domainUuid = "44444444-4444-4444-8444-444444444444";
const repositoryId = "a".repeat(64);
const snapshotId = "b".repeat(64);
const destinationRevision = "c".repeat(64);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture({ guestAgent = true, uefi = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-drill-"));
  directories.push(directory);
  const managedRoot = path.join(directory, "managed");
  const imageRoot = path.join(directory, "images");
  const restoreRoot = path.join(imageRoot, "boxpilot-restore-drills");
  const nvramRoot = path.join(directory, "nvram");
  const exportRoot = path.join(managedRoot, "vm-exports");
  await mkdir(managedRoot);
  await mkdir(imageRoot);
  await mkdir(nvramRoot);
  const xml = `<domain><os><type>hvm</type>${uefi ? '<loader readonly="yes" type="pflash">/usr/share/OVMF/OVMF_CODE_4M.fd</loader>' : ""}</os><devices><disk type="file" device="disk"><target bus="virtio" dev="vda"/></disk></devices></domain>\n`;
  const disk = Buffer.from("restored qcow2 fixture");
  const manifest = {
    schemaVersion: 1, exportId, domain: { name: "ubuntu-lab", uuid: domainUuid }, destination: "local-managed",
    encrypted: false, protected: false,
    domainXml: { file: "domain.xml", sizeBytes: Buffer.byteLength(xml), checksumSha256: digest(xml) },
    disks: [{ target: "vda", file: "vda.qcow2", sizeBytes: disk.length, checksumSha256: digest(disk), contentVerified: true }],
    restoreDrill: { passed: false, reason: "not run" },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const expectedSizeBytes = Buffer.byteLength(manifestText) + Buffer.byteLength(xml) + disk.length;
  let domainRunning = false;
  const run = vi.fn(async (binary, args) => {
    if (binary === "/usr/bin/restic" && args.includes("snapshots")) {
      return { stdout: JSON.stringify([{ id: snapshotId, paths: [path.join(exportRoot, exportId)], tags: [`boxpilot-export-${exportId}`, `boxpilot-backup-${backupId}`] }]), stderr: "" };
    }
    if (binary === "/usr/bin/restic" && args.includes("restore")) {
      const target = args[args.indexOf("--target") + 1];
      const restored = path.join(target, exportRoot.replace(/^\/+/, ""), exportId);
      await mkdir(restored, { recursive: true });
      await writeFile(path.join(restored, "manifest.json"), manifestText);
      await writeFile(path.join(restored, "domain.xml"), xml);
      await writeFile(path.join(restored, "vda.qcow2"), disk);
      return { stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/qemu-img") return { stdout: '{"corruptions":0,"check-errors":0}', stderr: "" };
    if (binary === "/usr/bin/id") return { stdout: "64055", stderr: "" };
    if (binary === "/usr/bin/virt-install") {
      domainRunning = true;
      if (uefi) await writeFile(path.join(nvramRoot, `${restoreDrillDomainName(drillId)}_VARS.fd`), "temporary firmware state");
      return { stdout: "Domain creation completed.", stderr: "" };
    }
    if (binary === "/usr/bin/virsh") {
      const operation = args[2];
      if (operation === "list") return { stdout: domainRunning ? `${restoreDrillDomainName(drillId)}\n` : "", stderr: "" };
      if (operation === "dominfo") return { stdout: `Name: ${restoreDrillDomainName(drillId)}\nState: running\nPersistent: no\n`, stderr: "" };
      if (operation === "domiflist") return { stdout: " Interface   Type   Source   Model   MAC\n-------------------------------------------------------\n", stderr: "" };
      if (operation === "qemu-agent-command") {
        if (!guestAgent) throw new Error("agent unavailable");
        return { stdout: '{"return":{}}', stderr: "" };
      }
      if (operation === "domstate") return { stdout: "running", stderr: "" };
      if (operation === "destroy") {
        domainRunning = false;
        return { stdout: "destroyed", stderr: "" };
      }
    }
    throw new Error(`Unexpected command ${binary} ${args.join(" ")}`);
  });
  const input = {
    drillId, backupId, exportId, domainName: "ubuntu-lab", domainUuid, repositoryId, snapshotId,
    expectedManifestChecksumSha256: digest(manifestText), expectedSizeBytes, expectedDestinationRevision: destinationRevision,
  };
  const destination = {
    adapter: "mounted-restic", ready: true, encrypted: true, independent: true, repositoryId,
    destinationRevision, destinationFreeBytes: 20 * 1024 ** 3, blockers: [],
  };
  const helper = createVmRestoreDrillHelper({
    imageRoot, restoreRoot, nvramRoot, exportRoot, mountRoot: path.join(directory, "mount"), passwordFile: path.join(directory, "password"), cacheRoot: path.join(directory, "cache"),
    destinationInspector: async () => destination,
    statFilesystem: async () => ({ bavail: 10 * 1024 * 1024, bsize: 4096 }),
    readText: readFile,
    changeMode: async () => {},
    changeOwner: async () => {},
    run,
    wait: async () => {},
  });
  return { helper, input, run, restoreRoot, nvramRoot };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated VM restore drill helper", () => {
  it("accepts only exact secret-free durable evidence", () => {
    expect(validateVmRestoreDrillInput({ drillId: "bad" })).toEqual(expect.arrayContaining(["Drill id must be a UUID", "Backup id must be a UUID", "Repository id is invalid", "Snapshot id is invalid"]));
  });

  it("reports fixed transient no-network readiness", async () => {
    const { helper, input } = await fixture();
    await expect(helper.inspect(input)).resolves.toMatchObject({ ready: true, drillDomain: restoreDrillDomainName(drillId), network: "none", transient: true, memoryMiB: 2048, vcpus: 2, blockers: [] });
  });

  it("blocks reused workspaces and unsafe generated NVRAM paths", async () => {
    const workspaceFixture = await fixture();
    await mkdir(path.join(workspaceFixture.restoreRoot, drillId), { recursive: true });
    await expect(workspaceFixture.helper.inspect(workspaceFixture.input)).resolves.toMatchObject({ ready: false, blockers: expect.arrayContaining(["The generated restore drill workspace already exists"]) });

    const nvramFixture = await fixture();
    await symlink("/etc/passwd", path.join(nvramFixture.nvramRoot, `${restoreDrillDomainName(drillId)}_VARS.fd`));
    await expect(nvramFixture.helper.inspect(nvramFixture.input)).resolves.toMatchObject({ ready: false, blockers: expect.arrayContaining(["Libvirt NVRAM inspection is unavailable"]) });
  });

  it("restores, verifies, boots, health-checks, and cleans up an isolated guest", async () => {
    const { helper, input, run, restoreRoot } = await fixture();
    await expect(helper.runDrill(input)).resolves.toMatchObject({
      passed: true, drillId, backupId, snapshotId, network: "none", transient: true, persistentDomainCreated: false,
      guestAgentPing: true, restoredChecksumsVerified: true, restoredDisksVerified: true, cleanupVerified: true, protected: true,
      temporaryQemuDiskAccessGranted: true, temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true,
    });
    const virtInstall = run.mock.calls.find(([binary]) => binary === "/usr/bin/virt-install");
    expect(virtInstall[1]).toEqual(expect.arrayContaining(["--network", "none", "--transient", "--channel", "unix,target_type=virtio,name=org.qemu.guest_agent.0"]));
    expect(run.mock.calls).toContainEqual(["/usr/bin/id", ["-g", "libvirt-qemu"], { timeout: 15000 }]);
    const restore = run.mock.calls.find(([binary, args]) => binary === "/usr/bin/restic" && args.includes("restore"));
    expect(restore[1]).toEqual(expect.arrayContaining([snapshotId, "--verify"]));
    await expect(access(path.join(restoreRoot, drillId))).rejects.toThrow();
  });

  it("fails closed, removes the transient domain, and preserves restored files when guest health never appears", async () => {
    const { helper, input, run, restoreRoot, nvramRoot } = await fixture({ guestAgent: false, uefi: true });
    await expect(helper.runDrill(input)).rejects.toThrow("guest-agent health signal");
    expect(run.mock.calls.some(([binary, args]) => binary === "/usr/bin/virsh" && args.includes("destroy"))).toBe(true);
    await expect(access(path.join(restoreRoot, drillId))).resolves.toBeUndefined();
    await expect(access(path.join(nvramRoot, `${restoreDrillDomainName(drillId)}_VARS.fd`))).rejects.toThrow();
  });

  it("reconciles an exact orphaned transient domain on helper startup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-recovery-"));
    directories.push(directory);
    const imageRoot = path.join(directory, "images");
    const restoreRoot = path.join(imageRoot, "boxpilot-restore-drills");
    const workspace = path.join(restoreRoot, drillId);
    const nvramRoot = path.join(directory, "nvram");
    const diskPath = path.join(workspace, "var/lib/boxpilot-managed/vm-exports", exportId, "vda.qcow2");
    await mkdir(path.dirname(diskPath), { recursive: true });
    await mkdir(nvramRoot);
    await writeFile(diskPath, "preserved disk");
    const drillDomain = restoreDrillDomainName(drillId);
    const nvramPath = path.join(nvramRoot, `${drillDomain}_VARS.fd`);
    await writeFile(nvramPath, "generated firmware state");
    let running = true;
    const run = vi.fn(async (binary, args) => {
      if (binary !== "/usr/bin/virsh") throw new Error(`Unexpected command ${binary}`);
      const operation = args[2];
      if (operation === "list") return { stdout: running ? drillDomain : "", stderr: "" };
      if (operation === "dominfo") return { stdout: `Name: ${drillDomain}\nState: running\nPersistent: no`, stderr: "" };
      if (operation === "domiflist") return { stdout: " Interface   Type   Source   Model   MAC\n-------------------------------------------------------\n", stderr: "" };
      if (operation === "dumpxml") return { stdout: `<domain><devices><disk><source file='${diskPath}'/></disk></devices></domain>`, stderr: "" };
      if (operation === "destroy") {
        running = false;
        return { stdout: "destroyed", stderr: "" };
      }
      throw new Error(`Unexpected virsh operation ${operation}`);
    });
    const helper = createVmRestoreDrillHelper({
      imageRoot, restoreRoot, nvramRoot, exportRoot: path.join(directory, "exports"),
      destinationInspector: async () => ({ ready: false, blockers: [] }),
      changeMode: async () => {}, changeOwner: async () => {}, run,
    });
    await expect(helper.recoverOrphans()).resolves.toEqual({ inspectedWorkspaces: 1, stoppedDomains: 1, removedNvramFiles: 1, normalizedWorkspaces: 1 });
    expect(run.mock.calls.some(([binary, args]) => binary === "/usr/bin/virsh" && args.includes("destroy"))).toBe(true);
    await expect(access(workspace)).resolves.toBeUndefined();
    await expect(access(nvramPath)).rejects.toThrow();
  });
});
