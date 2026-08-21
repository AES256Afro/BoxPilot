import { describe, expect, it, vi } from "vitest";
import { compareVersions, createReleaseUpdateService, parseVersion } from "./release-updates.mjs";

const sha = "c".repeat(40);
function github(responses) {
  return vi.fn(async (path) => { if (!(path in responses)) throw new Error(`unexpected ${path}`); const value = responses[path]; if (value instanceof Error) throw value; return value; });
}

describe("release updates", () => {
  it("orders versions semver-style with prereleases below releases", () => {
    expect(parseVersion("v1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "rc.1" });
    expect(compareVersions("0.62.0", "0.61.0")).toBe(1);
    expect(compareVersions("0.61.10", "0.61.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("v0.62.0", "0.62.0")).toBe(0);
  });

  it("reports whether the latest published release is newer than the running version, and caches", async () => {
    let now = 0;
    const requestJson = github({ "/repos/AES256Afro/BoxPilot/releases/latest": { tag_name: "v0.62.0", name: "BoxPilot v0.62.0", published_at: "2026-08-21T16:00:00Z", body: "Notes here" } });
    const service = createReleaseUpdateService({ requestJson, currentVersion: "0.61.0", clock: () => now });
    const first = await service.inspect();
    expect(first).toMatchObject({ current: { version: "0.61.0" }, latest: { tag: "v0.62.0", version: "0.62.0", notes: "Notes here", url: "https://github.com/AES256Afro/BoxPilot/releases/tag/v0.62.0" }, updateAvailable: true, error: null });
    await service.inspect();
    expect(requestJson).toHaveBeenCalledTimes(1);
    now = 20 * 60 * 1000;
    await service.inspect();
    expect(requestJson).toHaveBeenCalledTimes(2);
    const upToDate = createReleaseUpdateService({ requestJson, currentVersion: "0.62.0", clock: () => now });
    expect((await upToDate.inspect()).updateAvailable).toBe(false);
  });

  it("fails soft when GitHub is unreachable and when no release exists", async () => {
    const offline = createReleaseUpdateService({ requestJson: github({ "/repos/AES256Afro/BoxPilot/releases/latest": new Error("GitHub public API returned status 503") }), currentVersion: "0.61.0" });
    expect(await offline.inspect()).toMatchObject({ latest: null, updateAvailable: false, error: "GitHub public API returned status 503" });
    const none = createReleaseUpdateService({ requestJson: github({ "/repos/AES256Afro/BoxPilot/releases/latest": null }), currentVersion: "0.61.0" });
    expect(await none.inspect()).toMatchObject({ latest: null, updateAvailable: false, error: null });
  });

  it("pins the reviewed tag's commit and refuses drafts, downgrades, and malformed tags", async () => {
    const requestJson = github({
      "/repos/AES256Afro/BoxPilot/releases/tags/v0.62.0": { tag_name: "v0.62.0", draft: false },
      "/repos/AES256Afro/BoxPilot/releases/tags/v0.63.0": { tag_name: "v0.63.0", draft: true },
      "/repos/AES256Afro/BoxPilot/releases/tags/v0.60.0": { tag_name: "v0.60.0", draft: false },
      "/repos/AES256Afro/BoxPilot/commits/v0.62.0": { sha },
    });
    const service = createReleaseUpdateService({ requestJson, currentVersion: "0.61.0" });
    await expect(service.prepareOperation({ tag: "v0.62.0" })).resolves.toEqual({ tag: "v0.62.0", expectedCommit: sha });
    await expect(service.prepareOperation({ tag: "v0.63.0" })).rejects.toThrow("not a published release");
    await expect(service.prepareOperation({ tag: "v0.60.0" })).rejects.toThrow("not newer than the installed 0.61.0");
    await expect(service.prepareOperation({ tag: "main" })).rejects.toThrow("release tag like v1.2.3");
  });
});
