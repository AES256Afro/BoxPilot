import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningUpgrade, systemUpdate } from "./update.mjs";

const directories = [];
const sha = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-update-task-"));
  directories.push(root);
  await mkdir(path.join(root, "install", "scripts"), { recursive: true });
  await writeFile(path.join(root, "install", "scripts", "boxpilot-upgrade.sh"), "#!/bin/sh\necho upgrade \"$1\"\n");
  const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha }) }));
  const options = { run, fetchImpl, installDir: path.join(root, "install"), stagingDirectory: path.join(root, "run"), nodeBinary: "/usr/local/bin/node", now: () => new Date("2026-08-21T15:00:00.000Z"), lockPath: path.join(root, "boxpilot-upgrade.lock") };
  return { root, run, fetchImpl, options };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("system.update root task", () => {
  it("re-pins the tag to the reviewed commit and starts a detached update unit from a copied script", async () => {
    const { root, run, fetchImpl, options } = await fixture();
    const log = vi.fn();
    const result = await systemUpdate({ tag: "v0.62.0", expectedCommit: sha }, { ...options, log });
    expect(result).toMatchObject({ started: true, tag: "v0.62.0", expectedCommit: sha, unit: "boxpilot-update-20260821T150000Z" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/AES256Afro/BoxPilot/commits/v0.62.0", expect.anything());
    const scriptCopy = path.join(root, "run", "update-20260821T150000Z.sh");
    expect(await readFile(scriptCopy, "utf8")).toContain("echo upgrade");
    expect(run).toHaveBeenCalledWith("/usr/bin/systemd-run", ["--quiet", "--unit", "boxpilot-update-20260821T150000Z", "--description", "BoxPilot update to v0.62.0", "--setenv=BOXPILOT_NODE_BIN=/usr/local/bin/node", "--setenv=BOXPILOT_UPDATE_UNIT=boxpilot-update-20260821T150000Z", "/bin/sh", scriptCopy, sha], expect.anything());
    // It looked at the upgrade lock first, and found it free.
    expect(run.mock.calls[0]).toEqual(["/usr/bin/flock", ["-n", options.lockPath, "/bin/true"], expect.anything()]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rolls back"), "stdout");
  });

  it("refuses when the tag moved, when GitHub cannot resolve it, or when input is malformed", async () => {
    const { run, options } = await fixture();
    await expect(systemUpdate({ tag: "v0.62.0", expectedCommit: sha }, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ sha: "b".repeat(40) }) }) })).rejects.toThrow("not the reviewed");
    await expect(systemUpdate({ tag: "v0.62.0", expectedCommit: sha }, { ...options, fetchImpl: async () => ({ ok: false, status: 404 }) })).rejects.toThrow("status 404");
    await expect(systemUpdate({ tag: "main", expectedCommit: sha }, options)).rejects.toThrow("look like v1.2.3");
    await expect(systemUpdate({ tag: "v0.62.0", expectedCommit: "short" }, options)).rejects.toThrow("full SHA-1");
    expect(run).not.toHaveBeenCalled();
  });

  // M36: two upgrades two seconds apart on the owner's server. The script refuses a second run; the
  // job says so itself rather than start a unit that would only refuse.
  it("refuses while another upgrade holds the lock, naming it, and starts nothing", async () => {
    const { root, options } = await fixture();
    await writeFile(options.lockPath, "pid=4242 ref=abc123 started=20260929T104900Z by=boxpilot-update-20260929T104900Z\n");
    const run = vi.fn(async (binary) => (binary === "/usr/bin/flock" ? { ok: false, code: 1, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await expect(systemUpdate({ tag: "v0.62.0", expectedCommit: sha }, { ...options, run })).rejects.toThrow("Another BoxPilot update is already running (pid=4242 ref=abc123 started=20260929T104900Z by=boxpilot-update-20260929T104900Z). Nothing was started");
    expect(run.mock.calls.map(([binary]) => binary)).toEqual(["/usr/bin/flock"]);
    await expect(readFile(path.join(root, "run", "update-20260821T150000Z.sh"), "utf8")).rejects.toThrow();
  });

  it("leaves the decision to the script when the lock cannot be looked at", async () => {
    const { options } = await fixture();
    expect(await runningUpgrade({ run: async () => ({ ok: false, code: null, stdout: "", stderr: "spawn /usr/bin/flock ENOENT" }), lockPath: options.lockPath })).toBeNull();
    expect(await runningUpgrade({ run: async () => ({ ok: false, code: 1, stdout: "", stderr: "" }), lockPath: options.lockPath })).toBe(`it holds ${options.lockPath}`);
  });

  it("surfaces a failed unit start without claiming the update began", async () => {
    const { options } = await fixture();
    const run = vi.fn(async () => ({ ok: false, stdout: "", stderr: "Failed to start transient service unit: Unit name boxpilot-update-x is not valid." }));
    await expect(systemUpdate({ tag: "v0.62.0", expectedCommit: sha }, { ...options, run })).rejects.toThrow("Could not start the update unit");
  });
});
