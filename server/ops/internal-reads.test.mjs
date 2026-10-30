import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { internalReadOperations } from "./internal-reads.mjs";

describe("reads the web side's own services make through the helper", () => {
  const reads = internalReadOperations();

  it("are registered, read-only and internal, so no route, flow, schedule or agent runs them", () => {
    expect(reads).toHaveLength(13);
    for (const { id } of reads) {
      const operation = registry.get(id);
      expect(operation, id).not.toBeNull();
      expect(operation.readOnly, id).toBe(true);
      expect(operation.internal, id).toBe(true);
      expect(operation.risk, id).toBe("low");
    }
  });

  it("validate a VM restore drill plan with the function the helper revalidates it with", () => {
    const plan = { backupId: "11111111-2222-4333-8444-555555555555", domainName: "lab", domainUuid: "11111111-2222-4333-8444-555555555556", drillId: "11111111-2222-4333-8444-555555555557", expectedDestinationRevision: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 1024, exportId: "11111111-2222-4333-8444-555555555558", repositoryId: "c".repeat(64), snapshotId: "d".repeat(64) };
    expect(registry.validate("virtualization.export.backup.restore-drill.inspect", plan)).toBeNull();
    expect(registry.validate("virtualization.export.backup.restore-drill.inspect", { ...plan, expectedSizeBytes: 0 })).toContain("Expected backup size is invalid");
    expect(registry.validate("virtualization.export.backup.restore-drill.inspect", { ...plan, expectedSizeBytes: "1024" })).toContain("must be a number");
  });
});
