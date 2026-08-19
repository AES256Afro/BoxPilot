import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunUnitClient } from "./run-unit.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("run-unit client", () => {
  it("writes a one-shot spec, starts the template unit, and returns the task result", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const run = vi.fn(async (_binary, args) => {
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: true, task: "apt.update", result: { updated: true } }));
      return { ok: true, stdout: "", stderr: "" };
    });
    const client = createRunUnitClient({ run, runDirectory, systemctlBinary: "/bin/systemctl", now: () => new Date("2026-08-19T12:00:00.000Z") });
    await expect(client.runTask("apt.update", {}, { timeoutMs: 5000 })).resolves.toEqual({ updated: true });
    expect(run).toHaveBeenCalledWith("/bin/systemctl", ["start", expect.stringMatching(/^boxpilot-run@[a-f0-9-]{36}\.service$/)], { timeout: 65000 });
    expect(await readdir(runDirectory)).toEqual([]);
  });

  it("refuses unknown tasks and surfaces unit failures and task errors", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const client = createRunUnitClient({ run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "Job failed" })), runDirectory });
    await expect(client.runTask("shell.exec", {})).rejects.toThrow("not in the task table");
    await expect(client.runTask("apt.update", {})).rejects.toThrow("produced no result");
    const failing = createRunUnitClient({ runDirectory, run: vi.fn(async (_binary, args) => {
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: false, task: "apt.update", error: "apt-get update failed" }));
      return { ok: false, stdout: "", stderr: "" };
    }) });
    await expect(failing.runTask("apt.update", {})).rejects.toThrow("apt-get update failed");
  });
});
