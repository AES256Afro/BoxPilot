import { describe, expect, it, vi } from "vitest";
import { localDnsOperations } from "./local-dns.mjs";

/**
 * Removing the local names (M56.2): in the registry, named by no test. It deletes the file of names
 * BoxPilot wrote, and nothing else — records the owner added themselves live elsewhere and stay,
 * which is the distinction the description has to carry and the reason this is medium and not high.
 */
const operation = (id) => localDnsOperations().find((entry) => entry.id === id);

describe("removing the local names", () => {
  it("clears only BoxPilot's own file, and passes the job's progress through", async () => {
    const found = operation("dns.names.clear");
    expect(found).toMatchObject({ risk: "medium", readOnly: false });
    expect(Object.keys(found.parameters?.fields ?? {})).toEqual([]);
    const localDns = { clear: vi.fn(async () => ({ removed: true })) };
    const progress = vi.fn();
    await expect(found.run({}, { localDns, progress })).resolves.toEqual({ removed: true });
    // The progress handler reaches the task, so the job log says what happened rather than nothing.
    expect(localDns.clear).toHaveBeenCalledWith({ progress });
  });

  it("says that records the owner added themselves are left alone", () => {
    expect(operation("dns.names.clear").description).toContain("stay");
  });
});
