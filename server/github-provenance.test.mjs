import { describe, expect, it, vi } from "vitest";
import { createGithubProvenanceService, createGithubRequester, githubProvenanceInternals } from "./github-provenance.mjs";

const commit = (sha, verified = true) => ({
  sha,
  commit: {
    committer: { date: "2026-08-16T02:27:01Z", email: "must-not-leak@example.com" },
    verification: { verified, reason: verified ? "valid" : "unsigned", verified_at: verified ? "2026-08-16T02:27:01Z" : null, signature: "secret-like-signature", payload: "must-not-leak" },
  },
});

function fixtureRequest() {
  const calls = [];
  const requestJson = vi.fn(async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/releases/latest")) {
      if (path.includes("BoxPilot")) return null;
      return {
        tag_name: "v1.2.5", name: "Keel 1.2.5", target_commitish: "main", published_at: "2026-08-14T13:35:44Z",
        draft: false, prerelease: false, immutable: false,
        assets: [{ name: "keel_1.2.5_amd64.deb", size: 103546264, content_type: "application/x-debian-package", digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://example.invalid/must-not-leak" }],
      };
    }
    if (path.endsWith("/commits/v1.2.5")) return commit("3".repeat(40));
    if (path.includes("/commits/")) return commit(path.includes("BoxPilot") ? "1".repeat(40) : "2".repeat(40));
    return { private: false, archived: false, default_branch: "main", pushed_at: "2026-08-16T02:27:03Z", owner: { email: "must-not-leak@example.com" } };
  });
  return { calls, requestJson };
}

describe("GitHub provenance", () => {
  it("returns sanitized metadata for only the fixed public repositories and caches it", async () => {
    const { calls, requestJson } = fixtureRequest();
    const service = createGithubProvenanceService({ requestJson, clock: () => Date.parse("2026-08-16T03:00:00Z") });
    const first = await service.inspect();
    const second = await service.inspect();
    expect(second).toEqual(first);
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining([
      "/repos/AES256Afro/BoxPilot", "/repos/AES256Afro/BoxPilot/commits/main", "/repos/AES256Afro/BoxPilot/releases/latest",
      "/repos/AES256Afro/Keel", "/repos/AES256Afro/Keel/commits/main", "/repos/AES256Afro/Keel/releases/latest", "/repos/AES256Afro/Keel/commits/v1.2.5",
    ]));
    expect(calls).toHaveLength(7);
    expect(first.boundary).toMatchObject({ tokenConfigured: false, repositoryWrites: false, cloneOrDownload: false, localDigestVerification: false });
    expect(first.repositories[0]).toMatchObject({ fullName: "AES256Afro/BoxPilot", latestRelease: null, head: { sha: "1".repeat(40), verification: { verified: true, reportedBy: "github-api" } } });
    expect(first.repositories[1]).toMatchObject({ fullName: "AES256Afro/Keel", latestRelease: { tagName: "v1.2.5", assetsWithGithubReportedDigest: 1, commit: { sha: "3".repeat(40) } } });
    expect(JSON.stringify(first)).not.toContain("must-not-leak");
    expect(JSON.stringify(first)).not.toContain("example.invalid");
  });

  it("degrades one repository without failing the fixed catalog", async () => {
    const requestJson = vi.fn(async (path) => {
      if (path.includes("BoxPilot")) throw new Error("GitHub public API returned status 403");
      if (path.endsWith("/releases/latest")) return null;
      if (path.includes("/commits/")) return commit("4".repeat(40), false);
      return { private: false, default_branch: "main", pushed_at: "2026-08-14T15:47:50Z" };
    });
    const result = await createGithubProvenanceService({ requestJson }).inspect();
    expect(result.repositories).toEqual([
      expect.objectContaining({ id: "boxpilot", status: "unavailable", error: "GitHub public API returned status 403" }),
      expect.objectContaining({ id: "keel", status: "available" }),
    ]);
  });

  it("uses fixed unauthenticated headers and rejects oversized responses", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.headers).not.toHaveProperty("Authorization");
      expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { "User-Agent": "BoxPilot-read-only-provenance", "X-GitHub-Api-Version": "2022-11-28" } });
      return new Response("{}", { status: 200, headers: { "Content-Length": String(githubProvenanceInternals.maximumResponseBytes + 1) } });
    });
    await expect(createGithubRequester({ fetchImpl })("/repos/AES256Afro/BoxPilot")).rejects.toThrow("size limit");
  });
});
