import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { craftedTarGz, paxBody } from "../test/crafted-tar.mjs";
import { testTar } from "../test/platform.mjs";
import { readArchiveMembers } from "./archive-members.mjs";
import { fixedRun } from "./exec.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function archive(entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-members-")); directories.push(directory);
  const file = path.join(directory, "a.tar.gz");
  await writeFile(file, craftedTarGz(entries));
  return file;
}
const asText = (found) => Object.fromEntries([...found].map(([name, body]) => [name, body.toString("utf8")]));

describe("reading a few files out of a backup without unpacking it", () => {
  it("reads the named files and nothing else", async () => {
    const file = await archive([
      { name: "boxpilot.json", body: "{\"rawEdited\":true}" },
      { name: "compose.yaml", body: "services: {}\n" },
      { name: ".env", body: "A='b'\n" },
      { name: "data/", type: "dir" },
      { name: "data/compose.yaml", body: "not this one" },
    ]);
    expect(asText(await readArchiveMembers(file, ["compose.yaml", "boxpilot.json"]))).toEqual({ "compose.yaml": "services: {}\n", "boxpilot.json": "{\"rawEdited\":true}" });
  });

  it("reads an archive the real tar wrote, names with ./ included", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-members-")); directories.push(directory);
    await writeFile(path.join(directory, "compose.yaml"), "services:\n  a:\n    image: x\n");
    await writeFile(path.join(directory, "boxpilot.json"), "{}");
    await writeFile(path.join(directory, "big.bin"), randomBytes(300_000));
    for (const [name, members] of [["plain.tar.gz", ["compose.yaml", "boxpilot.json", "big.bin"]], ["dotted.tar.gz", ["./big.bin", "./compose.yaml", "./boxpilot.json"]]]) {
      const made = await fixedRun(testTar, ["-czf", path.join(directory, name), "-C", directory, ...members], { timeout: 60_000 });
      expect(made.ok, made.stderr).toBe(true);
      expect(asText(await readArchiveMembers(path.join(directory, name), ["compose.yaml", "boxpilot.json", ".env"]))).toEqual({ "compose.yaml": "services:\n  a:\n    image: x\n", "boxpilot.json": "{}" });
    }
  });

  it("stops once it has them, and never reads the rest", async () => {
    // The rest of this archive is cut off: read through, it would fail.
    const whole = craftedTarGz([{ name: "compose.yaml", body: "services: {}\n" }, { name: "boxpilot.json", body: "{}" }, { name: "data/big", body: randomBytes(512 * 1024).toString("latin1") }]);
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-members-")); directories.push(directory);
    const file = path.join(directory, "cut.tar.gz");
    await writeFile(file, whole.subarray(0, Math.floor(whole.length * 0.6)));
    expect(asText(await readArchiveMembers(file, ["compose.yaml", "boxpilot.json"]))).toEqual({ "compose.yaml": "services: {}\n", "boxpilot.json": "{}" });
    await expect(readArchiveMembers(file, ["compose.yaml", "missing"])).rejects.toThrow();
  });

  it("follows long names and pax headers to the member they name", async () => {
    const file = await archive([
      { name: "././@LongLink", type: "longname", body: "compose.yaml\0" },
      { name: "something-else", body: "from a long name" },
      { name: "PaxHeader", type: "pax", body: paxBody({ path: "boxpilot.json" }) },
      { name: "another-name", body: "from a pax header" },
    ]);
    expect(asText(await readArchiveMembers(file, ["compose.yaml", "boxpilot.json"]))).toEqual({ "compose.yaml": "from a long name", "boxpilot.json": "from a pax header" });
  });

  it("returns no link, pipe, folder or oversized file at a wanted name", async () => {
    const file = await archive([
      { name: "compose.yaml", type: "symlink", linkname: "/etc/shadow" },
      { name: ".env", type: "fifo" },
      { name: "boxpilot.json/", type: "dir" },
      { name: "big.yaml", body: "x".repeat(2048) },
    ]);
    expect(asText(await readArchiveMembers(file, ["compose.yaml", ".env", "boxpilot.json", "big.yaml"], { maxBytes: 1024 }))).toEqual({});
  });

  it("keeps the first of two members with one name (the restore checks what tar actually kept)", async () => {
    const file = await archive([{ name: "compose.yaml", body: "first" }, { name: "./compose.yaml", body: "second" }]);
    expect(asText(await readArchiveMembers(file, ["compose.yaml"]))).toEqual({ "compose.yaml": "first" });
  });

  it("fails on a file that is not a gzipped archive", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-members-")); directories.push(directory);
    await writeFile(path.join(directory, "x.tar.gz"), "not gzip");
    await expect(readArchiveMembers(path.join(directory, "x.tar.gz"), ["compose.yaml"])).rejects.toThrow();
    await expect(readArchiveMembers(path.join(directory, "missing.tar.gz"), ["compose.yaml"])).rejects.toThrow();
  });
});
