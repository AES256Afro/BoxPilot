import { describe, expect, it, vi } from "vitest";
import { logOperations } from "./logs.mjs";
import { createRegistry } from "./registry.mjs";

const registry = createRegistry([logOperations]);

describe("log operations", () => {
  it("lists groups, units, and containers", async () => {
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "list-units") return { ok: true, stdout: JSON.stringify([{ unit: "docker.service", description: "Docker", active: "active" }, { unit: "weird unit", description: "" }]), stderr: "" };
      if (args[0] === "ps") return { ok: true, stdout: "bp-jellyfin\trunning\tjellyfin/jellyfin:10.11.11\nbad name\trunning\tx", stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    });
    await expect(registry.execute("logs.sources", {}, { run })).resolves.toEqual({ groups: expect.arrayContaining([{ id: "boxpilot", label: "BoxPilot" }, { id: "kernel", label: "Kernel" }]), units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [{ name: "bp-jellyfin", state: "running", image: "jellyfin/jellyfin:10.11.11" }], dockerAvailable: true });
  });

  it("reads groups, units, and containers with window and filter, and validates input", async () => {
    const calls = [];
    const run = vi.fn(async (binary, args) => {
      calls.push(`${binary.split("/").pop()} ${args.join(" ")}`);
      if (args[0] === "ps") return { ok: true, stdout: "bp-jellyfin\nother", stderr: "" };
      if (binary.endsWith("docker")) return { ok: true, stdout: "2026-08-21T01:00:00Z hello token=abc\n2026-08-21T01:00:01Z world", stderr: "" };
      return { ok: true, stdout: "-- Logs begin --\n2026-08-21T01:00:00+0000 host boxpilot[1]: up\n2026-08-21T01:00:01+0000 host boxpilot[1]: password=secret", stderr: "" };
    });
    await expect(registry.execute("logs.read", { kind: "group", target: "boxpilot", lines: 50, since: "2h" }, { run })).resolves.toMatchObject({ lines: ["2026-08-21T01:00:00+0000 host boxpilot[1]: up", "2026-08-21T01:00:01+0000 host boxpilot[1]: password=[REDACTED]"] });
    expect(calls.at(-1)).toBe("journalctl --no-pager -o short-iso -n 50 --since -2hour -u boxpilot.service -u boxpilot-helper.service -u boxpilot-run@*");
    await expect(registry.execute("logs.read", { kind: "group", target: "kernel" }, { run })).resolves.toMatchObject({ kind: "group" });
    expect(calls.at(-1)).toContain(" -k");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", filter: "error" }, { run })).resolves.toMatchObject({ target: "docker.service" });
    expect(calls.at(-1)).toBe("journalctl --no-pager -o short-iso -n 300 -u docker.service -g error");
    await expect(registry.execute("logs.read", { kind: "container", target: "bp-jellyfin", filter: "hello" }, { run })).resolves.toEqual({ kind: "container", target: "bp-jellyfin", lines: ["2026-08-21T01:00:00Z hello token=[REDACTED]"], truncated: false });
    await expect(registry.execute("logs.read", { kind: "container", target: "missing" }, { run })).rejects.toThrow("not found");
    await expect(registry.execute("logs.read", { kind: "unit", target: "../etc" }, { run })).rejects.toThrow("invalid");
    await expect(registry.execute("logs.read", { kind: "group", target: "nope" }, { run })).rejects.toThrow("Unknown log group");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", since: "yesterday" }, { run })).rejects.toThrow("must look like");
    await expect(registry.execute("logs.read", { kind: "unit", target: "docker.service", lines: 5 }, { run })).rejects.toThrow("10-2000");
  });
});
