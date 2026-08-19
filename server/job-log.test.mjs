import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobLogReader, createJobLogWriter, jobLogPath } from "./job-log.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const jobId = "11111111-2222-4333-8444-555555555555";

describe("job log", () => {
  it("appends timestamped lines that a reader can tail incrementally, then removes the file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-joblog-")); directories.push(directory);
    const writer = createJobLogWriter({ jobId, directory, now: () => new Date("2026-08-19T12:00:00.000Z") });
    await writer.append("hello", "stdout");
    await writer.append("oops", "stderr");
    expect(((await stat(writer.path)).mode & 0o777)).toBe(0o640);
    const reader = createJobLogReader({ directory });
    const first = await reader.read(jobId, 0);
    expect(first.text).toBe("2026-08-19T12:00:00.000Z   hello\n2026-08-19T12:00:00.000Z ! oops\n");
    await writer.append("more");
    const second = await reader.read(jobId, first.offset);
    expect(second.text).toBe("2026-08-19T12:00:00.000Z   more\n");
    await reader.remove(jobId);
    expect(await readdir(directory)).toEqual([]);
    expect((await reader.read(jobId, 0)).exists).toBe(false);
  });

  it("refuses non-UUID job ids and is a no-op without a job id", async () => {
    expect(() => jobLogPath("../etc/passwd", "/tmp")).toThrow("UUID");
    const writer = createJobLogWriter({ jobId: null });
    expect(writer.enabled).toBe(false);
    await expect(writer.append("x")).resolves.toBeUndefined();
  });
});
