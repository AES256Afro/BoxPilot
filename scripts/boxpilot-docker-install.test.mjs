// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { dockerInstallInternals, installApprovedDocker } from "./boxpilot-docker-install.mjs";

describe("fixed Docker Engine installer", () => {
  it("installs only the approved configured docker.io candidate and verifies the daemon", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("docker")) {
        const installed = run.mock.calls.some(([candidate]) => candidate.endsWith("apt-get"));
        return installed ? { ok: true, stdout: args[0] === "--version" ? "Docker version 29.1.3, build fixture" : "29.1.3" } : { ok: false, stdout: "" };
      }
      if (binary.endsWith("dpkg-query")) {
        const installed = run.mock.calls.some(([candidate]) => candidate.endsWith("apt-get"));
        return installed ? { ok: true, stdout: "install ok installed\t28.2.2-0ubuntu1" } : { ok: false, stdout: "" };
      }
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 28.2.2-0ubuntu1" };
      if (binary.endsWith("apt-get")) {
        expect(args).toEqual(["install", "--yes", "--no-install-recommends", "docker.io=28.2.2-0ubuntu1"]);
        return { ok: true, stdout: "installed" };
      }
      if (binary.endsWith("systemctl")) return { ok: true, stdout: "" };
      throw new Error(`Unexpected command ${binary}`);
    });
    const result = await installApprovedDocker({
      run,
      loadApproval: async () => JSON.stringify({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T12:00:00.000Z" }),
      now: () => new Date("2026-08-16T12:01:00.000Z"),
    });
    expect(result).toEqual({ installed: true, version: "28.2.2-0ubuntu1", engineVersion: "29.1.3", packageChanged: true, serviceActive: true, engineVerified: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["enable", "docker.service"], { timeout: 30000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "docker.service"], { timeout: 120000 });
  });

  it("rejects stale, changed, injected, and already-active approvals without installing", async () => {
    const rejected = vi.fn(async () => ({ ok: false, stdout: "" }));
    await expect(installApprovedDocker({ run: rejected, loadApproval: async () => JSON.stringify({ expectedVersion: "$(id)", approvedAt: "2026-08-16T12:00:00.000Z" }), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("version is invalid");
    await expect(installApprovedDocker({ run: rejected, loadApproval: async () => JSON.stringify({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T11:00:00.000Z" }), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("marker is stale");

    const changed = vi.fn(async (binary) => binary.endsWith("apt-cache") ? { ok: true, stdout: "  Candidate: 28.3.0-0ubuntu1" } : { ok: false, stdout: "" });
    await expect(installApprovedDocker({ run: changed, loadApproval: async () => JSON.stringify({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T12:00:00.000Z" }), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("APT metadata changed");
    expect(changed.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);

    const active = vi.fn(async (binary) => binary.endsWith("docker") ? { ok: true, stdout: "Docker version 29.1.3, build fixture" } : { ok: false, stdout: "" });
    await expect(installApprovedDocker({ run: active, loadApproval: async () => JSON.stringify({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T12:00:00.000Z" }), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("became present");
  });

  it("accepts only the exact approval schema", () => {
    expect(() => dockerInstallInternals.parseApproval(JSON.stringify({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T12:00:00.000Z", package: "curl" }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("unexpected fields");
  });
});
