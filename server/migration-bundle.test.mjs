import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationBundle, inspectMigrationBundleDirectory, validateMigrationBundleManifest } from "./migration-bundle.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;
const roots = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-migration-bundle-"));
  roots.push(root);
  const source = path.join(root, "source");
  const inbox = path.join(root, "inbox");
  await mkdir(path.join(source, "data"), { recursive: true });
  await writeFile(path.join(source, "compose.yaml"), "services:\n  app:\n    image: example/app:1\n");
  await writeFile(path.join(source, ".env"), "PASSWORD=not-returned-to-browser\n");
  await writeFile(path.join(source, "data", "state.txt"), "durable-state\n");
  return { root, source, inbox };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration bundle capture", () => {
  it("copies a stable Compose project into a checksummed root-only bundle", async () => {
    const { source, inbox } = await fixture();
    const result = await createMigrationBundle({ sourceDirectory: source, workloadName: "keel-notes", sourceFingerprint: fingerprint, inboxRoot: inbox });
    const inspected = await inspectMigrationBundleDirectory(inbox, result.bundleId);
    expect(result).toMatchObject({ workloadName: "keel-notes", sourceFingerprint: fingerprint, fileCount: 3, sensitiveFileCount: 1, sourcePreserved: true });
    expect(inspected.manifest.composeFile).toBe("compose.yaml");
    expect(inspected.manifest.files.map((item) => item.path)).toEqual([".env", "compose.yaml", "data/state.txt"]);
    expect(await readFile(path.join(source, "data", "state.txt"), "utf8")).toBe("durable-state\n");
    expect(JSON.stringify(result)).not.toContain("PASSWORD");
    expect(validateMigrationBundleManifest(inspected.manifest, result.bundleId)).toEqual([]);
  });

  it("rejects links and leaves no published bundle", async () => {
    const { source, inbox } = await fixture();
    await symlink(path.join(source, "data", "state.txt"), path.join(source, "linked-state"));
    await expect(createMigrationBundle({ sourceDirectory: source, workloadName: "linked-app", sourceFingerprint: fingerprint, inboxRoot: inbox })).rejects.toThrow("symbolic links");
  });

  it("detects payload tampering", async () => {
    const { source, inbox } = await fixture();
    const result = await createMigrationBundle({ sourceDirectory: source, workloadName: "changed-app", sourceFingerprint: fingerprint, inboxRoot: inbox });
    await writeFile(path.join(inbox, result.bundleId, "payload", "data", "state.txt"), "changed\n");
    await expect(inspectMigrationBundleDirectory(inbox, result.bundleId)).rejects.toThrow("checksum verification failed");
  });
});
