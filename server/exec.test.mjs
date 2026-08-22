/**
 * The one place BoxPilot starts a process. Every root command on the host goes through here, so
 * these tests pin the properties the rest of the security model assumes: no shell, arguments as
 * data, a fixed environment, and a failure that reports instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";
import { fixedEnvironment, fixedRun, streamRun } from "./exec.mjs";

describe("running a command", () => {
  it("passes arguments as data, never through a shell", async () => {
    // If any of this reached a shell the semicolon would start a second command and the
    // backticks would be substituted; as an argv entry it is just an odd string to echo.
    const nasty = "hello; touch /tmp/boxpilot-should-not-exist `id` $(id) && echo no";
    const result = await fixedRun("/bin/echo", [nasty]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(nasty);
  });

  it("uses a fixed environment that the caller can add to but not replace", async () => {
    const result = await fixedRun("/usr/bin/env", [], { env: { BOXPILOT_TEST: "yes" } });
    expect(result.stdout).toContain("BOXPILOT_TEST=yes");
    expect(result.stdout).toContain(`PATH=${fixedEnvironment.PATH}`);
    expect(result.stdout).toContain("LC_ALL=C.UTF-8");
    // The caller's env is merged over the fixed one, so nothing from the parent process leaks in.
    expect(result.stdout).not.toMatch(/^HOME=/m);
  });

  it("reports a non-zero exit instead of throwing, and keeps both streams", async () => {
    const result = await fixedRun("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"]);
    expect(result).toMatchObject({ ok: false, code: 3, stdout: "out", stderr: "err" });
  });

  it("reports a missing binary rather than throwing", async () => {
    const result = await fixedRun("/nonexistent/boxpilot-binary", []);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });

  it("kills a command that runs past its timeout", async () => {
    const started = Date.now();
    const result = await fixedRun("/bin/sleep", ["30"], { timeout: 300 });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("sends stdin instead of putting a secret on the command line", async () => {
    const result = await fixedRun("/bin/cat", [], { input: "a password\n" });
    expect(result.stdout).toBe("a password");
  });
});

describe("streaming a command", () => {
  it("reports each line as it arrives and still returns the tail", async () => {
    const lines = [];
    const result = await streamRun("/bin/sh", ["-c", "echo first; echo second 1>&2; echo third"], { onLine: (line, stream) => lines.push(`${stream}:${line}`) });
    expect(result.ok).toBe(true);
    expect(lines).toContain("stdout:first");
    expect(lines).toContain("stderr:second");
    expect(lines).toContain("stdout:third");
    expect(result.stdout).toContain("third");
  });

  it("keeps running when the line callback throws", async () => {
    const onLine = vi.fn(() => { throw new Error("the log writer failed"); });
    const result = await streamRun("/bin/echo", ["still fine"], { onLine });
    expect(onLine).toHaveBeenCalled();
    expect(result.ok).toBe(true); // a broken logger must not fail the command it was watching
  });

  it("caps what it keeps in memory from a noisy command", async () => {
    const result = await streamRun("/bin/sh", ["-c", "i=0; while [ $i -lt 400 ]; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done"], { onLine: () => {}, tailBytes: 512 });
    expect(result.stdout.length).toBeLessThanOrEqual(512);
    expect(result.ok).toBe(true);
  });

  it("stops a stream that overruns its timeout", async () => {
    const started = Date.now();
    const result = await streamRun("/bin/sleep", ["30"], { timeout: 300, onLine: () => {} });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("a child that never writes a newline", () => {
  it("reports the latest state of a redrawn line, not every frame of it", async () => {
    const lines = [];
    // curl --progress-bar rewrites one line with \r for the whole transfer. Every frame used to
    // become its own job-log entry, which can exhaust the log's size cap before the lines that
    // matter are written. The newest frame is the one worth having.
    const result = await streamRun("/bin/sh", ["-c", "printf 'a\\rb\\rc\\r'; printf 'done\\n'"], { onLine: (line) => lines.push(line) });
    expect(result.ok).toBe(true);
    expect(lines).toEqual(["done"]);
  });

  it("still reports each redraw that arrives separately, so progress is visible over time", async () => {
    const lines = [];
    const result = await streamRun("/bin/sh", ["-c", "printf '10%%\\r'; sleep 0.05; printf '60%%\\r'; sleep 0.05; printf 'complete\\n'"], { onLine: (line) => lines.push(line) });
    expect(result.ok).toBe(true);
    expect(lines).toEqual(["10%", "60%", "complete"]);
  });

  it("caps a single endless line at the tail size", async () => {
    const result = await streamRun("/bin/sh", ["-c", "i=0; while [ $i -lt 200 ]; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; i=$((i+1)); done"], { onLine: () => {}, tailBytes: 512 });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(512);
  });
});
