import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heartbeatCredential, hostOf, intervalChoices, parseDropIn, parseTimerState, pingOnce, readStatus, renderDropIn, sendHeartbeat, validateHeartbeatUrl, writeStatus } from "./heartbeat.mjs";
import { onWindows } from "../test/platform.mjs";

const url = "https://hc-ping.com/5a3f1c2e-0000-4000-8000-00000000abcd";
const clock = () => { let at = Date.parse("2026-09-30T10:00:00Z"); return () => new Date((at += 25)); };
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const scratch = async () => { const directory = await mkdtemp(path.join(os.tmpdir(), "bp-heartbeat-")); directories.push(directory); return directory; };

describe("the heartbeat address", () => {
  it("takes http(s) addresses on the internet, the LAN or the tailnet, and nothing that would leak or mislead", () => {
    expect(validateHeartbeatUrl(url)).toBeNull();
    expect(validateHeartbeatUrl("http://192.168.50.30:3001/api/push/Ab12Cd34?status=up&msg=OK&ping=")).toBeNull();
    expect(validateHeartbeatUrl("ftp://example.com/x")).toMatch(/https/);
    expect(validateHeartbeatUrl("https://user:secret@example.com/x")).toMatch(/user name or password/);
    expect(validateHeartbeatUrl("http://169.254.169.254/latest/meta-data")).toMatch(/link-local/);
    expect(validateHeartbeatUrl("not an address")).toMatch(/not an address/);
    expect(validateHeartbeatUrl(`https://example.com/${"x".repeat(2100)}`)).toMatch(/2048/);
  });

  it("is shown only as the host it goes to", () => {
    expect(hostOf(url)).toBe("hc-ping.com");
    expect(hostOf("http://192.168.50.30:3001/api/push/Ab12Cd34")).toBe("192.168.50.30:3001");
    expect(hostOf("nonsense")).toBeNull();
  });
});

describe("one ping", () => {
  it("is one bare GET with no body and no header of BoxPilot's", async () => {
    const seen = [];
    const fetcher = async (target, options) => { seen.push({ target, options }); return new Response("OK", { status: 200 }); };
    const status = await sendHeartbeat(url, { fetcher, now: clock() });
    expect(status).toMatchObject({ ok: true, status: 200, error: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].target).toBe(url);
    expect(seen[0].options.method).toBe("GET");
    expect(seen[0].options.body).toBeUndefined();
    expect(seen[0].options.headers).toBeUndefined();
    expect(seen[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it("records a refusal or a failure in words that never quote the address, and does not try again", async () => {
    let calls = 0;
    const refused = await sendHeartbeat(url, { fetcher: async () => { calls += 1; return new Response("gone", { status: 404 }); }, now: clock() });
    expect(refused).toMatchObject({ ok: false, status: 404, error: "it answered 404" });
    const unresolved = await sendHeartbeat(url, { fetcher: async () => { calls += 1; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${url}` } }); }, now: clock() });
    expect(unresolved).toMatchObject({ ok: false, status: null, error: "its name did not resolve" });
    const slow = await sendHeartbeat(url, { fetcher: async () => { calls += 1; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, now: clock(), timeoutMs: 10_000 });
    expect(slow.error).toBe("no answer within 10 seconds");
    expect(calls).toBe(3);
    for (const status of [refused, unresolved, slow]) expect(JSON.stringify(status)).not.toContain("5a3f1c2e");
  });

  it("reads the address from the credential store and records what happened, or that there is none", async () => {
    const directory = await scratch();
    const statusFile = path.join(directory, "last.json");
    const credentials = { read: async (name) => (name === heartbeatCredential ? url : null) };
    const done = await pingOnce({ credentials, fetcher: async () => new Response(null, { status: 200 }), statusFile, now: clock() });
    expect(done.ok).toBe(true);
    expect(await readStatus({ file: statusFile })).toEqual(done);
    expect(await readFile(statusFile, "utf8")).not.toContain("hc-ping");
    const none = await pingOnce({ credentials: { read: async () => null }, fetcher: async () => { throw new Error("must not be called"); }, statusFile, now: clock() });
    expect(none).toMatchObject({ ok: false, error: "no heartbeat address is saved" });
  });

  it.skipIf(onWindows)("leaves a status file anyone can read, since it holds no secret", async () => {
    const directory = await scratch();
    const statusFile = path.join(directory, "nested", "last.json");
    await writeStatus({ at: "2026-09-30T10:00:00.000Z", ok: true, status: 200, ms: 80, error: null }, { file: statusFile });
    expect((await stat(statusFile)).mode & 0o777).toBe(0o644);
  });
});

describe("the timer", () => {
  it("writes the interval as a drop-in that replaces the unit's own, and reads it back", () => {
    const text = renderDropIn(10);
    expect(text).toContain("[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec=10min\n");
    expect(parseDropIn(text)).toBe(10);
    expect(parseDropIn("")).toBeNull();
    expect(() => renderDropIn(7)).toThrow(/one of/);
    expect(intervalChoices).toContain(5);
  });

  it("reads whether the timer is installed, enabled and running", () => {
    expect(parseTimerState("LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n")).toEqual({ installed: true, enabled: true, active: true });
    expect(parseTimerState("LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\n")).toEqual({ installed: true, enabled: false, active: false });
    expect(parseTimerState("LoadState=not-found\nUnitFileState=\nActiveState=inactive\n").installed).toBe(false);
  });
});
