import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLibvirtFoundation, fetchVmProtection, formatBytes, formatMemory } from "./virtualization";

afterEach(() => vi.unstubAllGlobals());


describe("what 503 means on each virtualization route", () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("reads a not-connected foundation, because that 503 carries the real answer", async () => {
    // libvirt not being up yet is the answer, not a failure to get one.
    vi.stubGlobal("fetch", vi.fn(async () => json({ connectionUri: "qemu:///system", connectionReady: false, ready: false, conflicts: ["libvirtd is not running"], changes: [], planAvailable: false }, 503)));
    const foundation = await fetchLibvirtFoundation();
    expect(foundation.connectionReady).toBe(false);
    expect(foundation.conflicts).toEqual(["libvirtd is not running"]);
  });

  it("refuses an error envelope wearing the shape of a result", async () => {
    // /virtualization/protection answers 503 with { error, code }. Accepting that as data gave the
    // page an object whose every field was undefined, and — because nothing threw — it recorded the
    // subsystem as read with nothing in it. Unreadable then looked identical to not configured.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "restic is not installed", code: "vm_protection_unavailable" }, 503)));
    await expect(fetchVmProtection()).rejects.toThrow("restic is not installed");
  });
});

describe("virtualization helpers", () => {
  it("formats libvirt KiB memory values", () => {
    expect(formatMemory(4 * 1024 * 1024)).toBe("4 GiB");
    expect(formatMemory(1536 * 1024)).toBe("1.5 GiB");
    expect(formatMemory(0)).toBe("Unknown");
  });

  it("formats managed ISO sizes", () => {
    expect(formatBytes(4.8 * 1024 * 1024 * 1024)).toBe("4.8 GiB");
    expect(formatBytes(700 * 1024 * 1024)).toBe("700 MiB");
  });
});
