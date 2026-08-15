import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVmRecoveryHelper, validateVmRecoveryInput } from "./vm-recovery-helper.mjs";

const directories = [];
const restoreId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const exportId = "33333333-3333-4333-8333-333333333333";
const sourceDomainUuid = "44444444-4444-4444-8444-444444444444";
const targetDomainUuid = "55555555-5555-4555-8555-555555555555";

function input(overrides = {}) {
  return {
    restoreId, backupId, exportId, sourceDomainName: "ubuntu-services", sourceDomainUuid,
    targetDomainName: "ubuntu-recovered", restoreDrillId: "66666666-6666-4666-8666-666666666666",
    repositoryId: "a".repeat(64), snapshotId: "b".repeat(64), expectedManifestChecksumSha256: "c".repeat(64),
    expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64), ...overrides,
  };
}

async function fixture({ existingTarget = false, invalidUuid = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-recovery-helper-"));
  directories.push(directory);
  const imageRoot = path.join(directory, "images");
  const recoveryRoot = path.join(imageRoot, "boxpilot-recoveries");
  const stagingRoot = path.join(imageRoot, "boxpilot-restore-drills");
  const staging = path.join(stagingRoot, restoreId);
  const restoredExport = path.join(staging, "var/lib/boxpilot-managed/vm-exports", exportId);
  await mkdir(imageRoot);
  let defined = existingTarget;
  let finalDisk = null;
  const restoreEngine = {
    inspect: vi.fn(async () => ({ ready: true, blockers: [], restoreFreeBytes: 20 * 1024 ** 3 })),
    prepareSnapshot: vi.fn(async () => {
      await mkdir(restoredExport, { recursive: true });
      await writeFile(path.join(restoredExport, "manifest.json"), "manifest");
      await writeFile(path.join(restoredExport, "domain.xml"), "domain");
      await writeFile(path.join(restoredExport, "vda.qcow2"), "disk");
      return {
        drillDirectory: staging,
        restored: {
          restoredExport,
          disks: [{ target: "vda", path: path.join(restoredExport, "vda.qcow2"), bus: "virtio" }],
          firmware: "uefi",
          sizeBytes: 8192,
          fileCount: 3,
        },
      };
    }),
  };
  const run = vi.fn(async (binary, args) => {
    if (binary === "/usr/bin/id") return { stdout: "64055", stderr: "" };
    if (binary === "/usr/bin/virt-install") {
      finalDisk = args.find((value) => typeof value === "string" && value.startsWith("path="))?.split(",")[0].slice(5);
      return { stdout: `<domain><name>ubuntu-recovered</name><devices><disk><source file='${finalDisk}'/></disk><channel><target type='virtio' name='org.qemu.guest_agent.0'/></channel></devices></domain>`, stderr: "" };
    }
    if (binary === "/usr/bin/virsh") {
      const operation = args[2];
      if (operation === "list") return { stdout: defined ? "ubuntu-recovered" : "", stderr: "" };
      if (operation === "define") {
        defined = true;
        return { stdout: "defined", stderr: "" };
      }
      if (operation === "autostart") return { stdout: "disabled", stderr: "" };
      if (operation === "dominfo") return { stdout: "Name: ubuntu-recovered\nState: shut off\nPersistent: yes\nAutostart: disable", stderr: "" };
      if (operation === "domstate") return { stdout: "shut off", stderr: "" };
      if (operation === "domiflist") return { stdout: " Interface   Type   Source   Model   MAC\n-------------------------------------------------------\n", stderr: "" };
      if (operation === "dumpxml") return { stdout: `<domain><name>ubuntu-recovered</name><devices><disk><source file='${finalDisk}'/></disk><channel><target type='virtio' name='org.qemu.guest_agent.0'/></channel></devices></domain>`, stderr: "" };
      if (operation === "domuuid") return { stdout: invalidUuid ? "invalid" : targetDomainUuid, stderr: "" };
      if (operation === "undefine") {
        defined = false;
        return { stdout: "undefined", stderr: "" };
      }
    }
    throw new Error(`Unexpected command ${binary} ${args.join(" ")}`);
  });
  const helper = createVmRecoveryHelper({
    restoreEngine, imageRoot, recoveryRoot, run,
    changeMode: async () => {}, changeOwner: async () => {},
  });
  return { helper, restoreEngine, run, recoveryRoot };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("guarded VM recovery helper", () => {
  it("accepts only exact typed protected-backup evidence and a safe target name", () => {
    expect(validateVmRecoveryInput(input())).toEqual([]);
    expect(validateVmRecoveryInput(input({ targetDomainName: "boxpilot-drill-manual", snapshotId: "latest" }))).toEqual(expect.arrayContaining([
      "Recovery domain name uses the reserved restore-drill namespace", "Snapshot id is invalid",
    ]));
  });

  it("blocks an existing recovery domain without restoring data", async () => {
    const { helper, restoreEngine } = await fixture({ existingTarget: true });
    await expect(helper.inspect(input())).resolves.toMatchObject({ ready: false, network: "none", persistent: true, initialState: "stopped", blockers: ["The recovery domain name is already in use"] });
    expect(restoreEngine.prepareSnapshot).not.toHaveBeenCalled();
  });

  it("treats punctuation in a valid target name as literal XML text", async () => {
    const { helper } = await fixture();
    await expect(helper.createRecovery(input({ targetDomainName: "ubuntu.recovered" }))).rejects.toThrow("Generated recovery domain XML has the wrong name");
  });

  it("restores a protected snapshot into a stopped persistent no-network recovery clone", async () => {
    const { helper, run, recoveryRoot } = await fixture();
    await expect(helper.createRecovery(input())).resolves.toMatchObject({
      created: true, restoreId, backupId, domain: "ubuntu-recovered", domainUuid: targetDomainUuid,
      persistent: true, state: "stopped", network: "none", autostart: false,
      encryptedSource: true, protectedSource: true, sourceUnchanged: true, snapshotUnchanged: true,
    });
    const virtInstall = run.mock.calls.find(([binary]) => binary === "/usr/bin/virt-install");
    expect(virtInstall[1]).toEqual(expect.arrayContaining(["--network", "none", "--print-xml", "--graphics", "spice,listen=127.0.0.1"]));
    expect(run.mock.calls.some(([binary, args]) => binary === "/usr/bin/virsh" && args.includes("define"))).toBe(true);
    expect(run.mock.calls.some(([binary, args]) => binary === "/usr/bin/virsh" && args.includes("autostart") && args.includes("--disable"))).toBe(true);
    await expect(access(path.join(recoveryRoot, restoreId, "vda.qcow2"))).resolves.toBeUndefined();
  });

  it("undefines and removes only the new recovery clone when post-define evidence fails", async () => {
    const { helper, run, recoveryRoot } = await fixture({ invalidUuid: true });
    await expect(helper.createRecovery(input())).rejects.toThrow("Automatic recovery-clone rollback removed");
    expect(run.mock.calls.some(([binary, args]) => binary === "/usr/bin/virsh" && args.includes("undefine"))).toBe(true);
    await expect(access(path.join(recoveryRoot, restoreId))).rejects.toThrow();
  });
});
