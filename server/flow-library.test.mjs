import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFlowLibrary } from "./flow-library.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function libraryWith(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-lib-"));
  directories.push(directory);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(directory, name), body);
  return directory;
}

describe("the flow library", () => {
  it("loads valid entries and validates steps against the real registry", async () => {
    const directory = await libraryWith({
      "update-night.yaml": "name: Update night\ndescription: Snapshot then upgrade.\nsteps:\n  - operationId: host.snapshot.create\n    parameters: {}\n  - operationId: apt.upgrade\n    parameters: {}\n    retry: 1\n",
    });
    const { library, problems } = await loadFlowLibrary({ directory });
    expect(problems).toEqual([]);
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({ slug: "update-night", name: "Update night" });
    expect(library[0].steps[1]).toMatchObject({ operationId: "apt.upgrade", retry: 1 });
  });

  it("reports an entry that names a high-risk or unknown operation instead of shipping it", async () => {
    const directory = await libraryWith({
      "danger.yaml": "name: Danger\nsteps:\n  - operationId: storage.format\n    parameters: { device: /dev/sdb, filesystem: ext4, label: d, confirm: sdb }\n",
      "ghost.yaml": "name: Ghost\nsteps:\n  - operationId: no.such.op\n    parameters: {}\n",
    });
    const { library, problems } = await loadFlowLibrary({ directory });
    expect(library).toEqual([]);
    expect(problems.find((problem) => problem.file === "danger.yaml").errors[0]).toMatch(/high risk/);
    expect(problems.find((problem) => problem.file === "ghost.yaml").errors[0]).toMatch(/not a registered operation/);
  });

  it("treats a missing directory as an empty library, not an error", async () => {
    const { library, problems } = await loadFlowLibrary({ directory: "/no/such/library/dir" });
    expect(library).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("the shipped library loads clean against the live registry", async () => {
    const { library, problems } = await loadFlowLibrary();
    expect(problems).toEqual([]);
    expect(library.map((entry) => entry.slug)).toContain("update-night");
  });
});
