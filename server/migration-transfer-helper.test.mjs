import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationBundle } from "./migration-bundle.mjs";
import { createMigrationTransferHelper, validateMigrationTransferInput } from "./migration-transfer-helper.mjs";

const fingerprint = `sha256:${"b".repeat(64)}`;
const roots = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-migration-transfer-"));
  roots.push(root);
  const source = path.join(root, "source");
  const inbox = path.join(root, "inbox");
  const staging = path.join(root, "staging");
  await mkdir(path.join(source, "data"), { recursive: true });
  await writeFile(path.join(source, "compose.yml"), "services:\n  canary:\n    image: example/canary:1\n");
  await writeFile(path.join(source, "data", "one.txt"), "one\n");
  const bundle = await createMigrationBundle({ sourceDirectory: source, workloadName: "canary", sourceFingerprint: fingerprint, inboxRoot: inbox });
  const helper = createMigrationTransferHelper({ inboxRoot: inbox, stagingRoot: staging });
  await helper.initialize();
  return { root, source, inbox, staging, bundle, helper };
}

function input(bundle, inspected, transferId = "11111111-1111-4111-8111-111111111111") {
  return {
    transferId,
    bundleId: bundle.bundleId,
    sourceFingerprint: bundle.sourceFingerprint,
    contentRevision: bundle.contentRevision,
    expectedDestinationState: inspected.destinationState,
    expectedRemainingBytes: inspected.remainingBytes,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("restricted migration transfer helper", () => {
  it("copies and fully verifies an exact bundle without activation or source mutation", async () => {
    const { source, bundle, helper } = await fixture();
    const before = (await helper.inspect()).bundles[0];
    expect(before).toMatchObject({ executable: true, destinationState: "empty", sourceFingerprint: fingerprint });
    const result = await helper.transfer(input(bundle, before));
    expect(result).toMatchObject({ created: true, contentVerified: true, sourcePreserved: true, activationPerformed: false, networkCutoverPerformed: false, sourceDeletionPerformed: false, copiedFiles: 2, resumedFiles: 0 });
    expect(await writeFile(path.join(source, "proof.txt"), "source remains writable\n")).toBeUndefined();
    const after = (await helper.inspect()).bundles[0];
    expect(after).toMatchObject({ executable: false, destinationState: "completed", remainingBytes: 0 });
    const reconciled = await helper.transfer(input(bundle, after));
    expect(reconciled).toMatchObject({ reconciled: true, copiedFiles: 0, resumedFiles: 2, contentVerified: true, activationPerformed: false });
  });

  it("resumes verified files without recopying them", async () => {
    const { inbox, staging, bundle, helper } = await fixture();
    const first = (await helper.inspect()).bundles[0];
    const destinationPayload = path.join(staging, bundle.bundleId, "payload");
    await mkdir(destinationPayload, { recursive: true });
    await copyFile(path.join(inbox, bundle.bundleId, "payload", "compose.yml"), path.join(destinationPayload, "compose.yml"));
    const resumable = (await helper.inspect()).bundles[0];
    expect(resumable.destinationState).toBe("resumable");
    expect(resumable.remainingBytes).toBeLessThan(first.remainingBytes);
    const result = await helper.transfer(input(bundle, resumable, "22222222-2222-4222-8222-222222222222"));
    expect(result).toMatchObject({ copiedFiles: 1, resumedFiles: 1, contentVerified: true });
  });

  it("fails closed on destination collisions and source tampering", async () => {
    const { inbox, staging, bundle, helper } = await fixture();
    await mkdir(path.join(staging, bundle.bundleId), { recursive: true });
    await writeFile(path.join(staging, bundle.bundleId, "operator-file"), "do not overwrite\n");
    const collision = await helper.inspect();
    expect(collision.bundles).toEqual([]);
    expect(collision.invalidBundles[0].reason).toContain("outside the reviewed bundle inventory");
    await writeFile(path.join(inbox, bundle.bundleId, "payload", "data", "one.txt"), "tampered\n");
    const tampered = await helper.inspect();
    expect(tampered.invalidBundles[0].reason).toContain("checksum verification failed");
  });

  it("accepts no paths, commands, or extra fields from the browser", () => {
    const valid = {
      transferId: "33333333-3333-4333-8333-333333333333",
      bundleId: "44444444-4444-4444-8444-444444444444",
      sourceFingerprint: fingerprint,
      contentRevision: "c".repeat(64),
      expectedDestinationState: "empty",
      expectedRemainingBytes: 42,
    };
    expect(validateMigrationTransferInput(valid)).toEqual([]);
    expect(validateMigrationTransferInput({ ...valid, sourcePath: "/etc" })).toContain("Transfer accepts only fixed typed evidence fields");
    expect(validateMigrationTransferInput({ ...valid, expectedDestinationState: "overwrite" })).toContain("Destination state is invalid");
  });
});
