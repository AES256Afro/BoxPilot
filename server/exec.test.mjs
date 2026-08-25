/**
 * The one place BoxPilot starts a process. Every root command on the host goes through here, so
 * these tests pin the properties the rest of the security model assumes: no shell, arguments as
 * data, a fixed environment, and a failure that reports instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";
import { fixedEnvironment, fixedRun, streamRun, stripTerminalCodes } from "./exec.mjs";

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
  it("collapses a redrawn line instead of reporting every frame of it", async () => {
    const lines = [];
    // curl --progress-bar rewrites one line with \r for the whole transfer. Every frame used to
    // become its own job-log entry, which can exhaust the log's size cap before the lines that
    // matter are written. How many frames share a chunk is up to the kernel, so this asserts the
    // property — far fewer callbacks than frames, and the final state always delivered — rather
    // than an exact sequence that depends on chunk boundaries.
    const frames = 500;
    const script = "i=0; while [ $i -lt " + frames + " ]; do printf 'frame $i\\r'; i=$((i+1)); done; printf 'done\\n'";
    const result = await streamRun("/bin/sh", ["-c", script], { onLine: (line) => lines.push(line) });
    expect(result.ok).toBe(true);
    expect(lines.at(-1)).toBe("done");
    expect(lines.length).toBeLessThan(frames / 10);
  });

  it("still shows progress over time, sampling the redraws", async () => {
    const lines = [];
    // A short sampling interval so the test does not have to wait a second between frames; the
    // point is that redraws still reach the log, just not every one of them.
    const result = await streamRun("/bin/sh", ["-c", "printf '10%%\\r'; sleep 0.08; printf '60%%\\r'; sleep 0.08; printf 'complete\\n'"], { onLine: (line) => lines.push(line), redrawIntervalMs: 20 });
    expect(result.ok).toBe(true);
    expect(lines.at(-1)).toBe("complete");
    expect(lines).toContain("60%");
  });

  it("caps a single endless line at the tail size", async () => {
    const result = await streamRun("/bin/sh", ["-c", "i=0; while [ $i -lt 200 ]; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; i=$((i+1)); done"], { onLine: () => {}, tailBytes: 512 });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(512);
  });
});

describe("terminal control codes in progress output", () => {
  const ESC = String.fromCharCode(27);

  it("strips the cursor moves and clears that progress bars paint with", () => {
    // Verbatim from `ollama pull` on a real host: it does not merely overwrite with a carriage
    // return, it moves the cursor and clears lines, and all of it used to reach the job log.
    expect(stripTerminalCodes(`pulling 797b70c4edf8: 100%  45 MB ${ESC}[K`).trimEnd()).toBe("pulling 797b70c4edf8: 100%  45 MB");
    expect(stripTerminalCodes(`${ESC}[?25h${ESC}[?2026l${ESC}[?2026h${ESC}[?25l${ESC}[A${ESC}[A${ESC}[1Gpulling manifest ${ESC}[K`).trimEnd()).toBe("pulling manifest");
    expect(stripTerminalCodes(`${ESC}[32msuccess${ESC}[0m`)).toBe("success");
    expect(stripTerminalCodes(`title${ESC}]0;window${String.fromCharCode(7)}rest`)).toBe("titlerest");
  });

  it("leaves ordinary text alone", () => {
    expect(stripTerminalCodes("plain line with no codes")).toBe("plain line with no codes");
    expect(stripTerminalCodes("")).toBe("");
    expect(stripTerminalCodes(null)).toBe("");
  });
});
