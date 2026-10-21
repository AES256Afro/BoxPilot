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
        tag_name: "v1.2.6", name: "Keel 1.2.6", target_commitish: "main", published_at: "2026-08-16T12:00:00Z",
        draft: false, prerelease: false, immutable: false,
        assets: [{ name: "keel-1.2.6-linux-x64.tar.gz", size: 71052143, content_type: "application/gzip", digest: "sha256:696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00", browser_download_url: "https://example.invalid/must-not-leak" }],
      };
    }
    if (path.endsWith("/commits/v1.2.6")) return commit("3".repeat(40));
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
    ]));
    expect(calls).toHaveLength(3);
    expect(first.boundary).toMatchObject({ tokenConfigured: false, repositoryWrites: false, cloneOrDownload: false, localDigestVerification: false });
    expect(first.repositories[0]).toMatchObject({ fullName: "AES256Afro/BoxPilot", latestRelease: null, head: { sha: "1".repeat(40), verification: { verified: true, reportedBy: "github-api" } } });
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

describe("what reaches the page from GitHub", () => {
  const repository = { private: false, archived: false, default_branch: "main", pushed_at: "2026-08-16T02:27:03Z" };
  const serve = (release) => vi.fn(async (path) => {
    if (path.endsWith("/releases/latest")) return release;
    if (path.includes("/commits/")) return commit("5".repeat(40));
    return repository;
  });

  it("keeps a release's assets only with a name and a size, a digest only in sha256 form, and no control characters", async () => {
    const release = {
      tag_name: "v1.188.0", name: "BoxPilot\u0007 1.188\nnext", target_commitish: "main; rm -rf /", published_at: "not a date", draft: false, prerelease: true, immutable: true,
      assets: [
        { name: "boxpilot.tar.gz", size: 1024, content_type: "application/gzip", digest: "sha256:" + "a".repeat(64) },
        { name: "notes.txt", size: 10, digest: "md5:abc" },
        { name: "", size: 5 },
        { name: "negative", size: -1 },
        ...Array.from({ length: 20 }, (_, index) => ({ name: `extra-${index}`, size: 1 })),
      ],
    };
    const { repositories: [entry] } = await createGithubProvenanceService({ requestJson: serve(release) }).inspect();
    expect(entry.latestRelease).toMatchObject({ tagName: "v1.188.0", name: "BoxPilot  1.188 next", targetCommitish: null, publishedAt: null, prerelease: true, immutable: true, assetsWithGithubReportedDigest: 1 });
    expect(entry.latestRelease.assets[0]).toEqual({ name: "boxpilot.tar.gz", sizeBytes: 1024, contentType: "application/gzip", digest: "sha256:" + "a".repeat(64) });
    expect(entry.latestRelease.assets[1]).toMatchObject({ name: "notes.txt", digest: null });
    expect(entry.latestRelease.assets.map((asset) => asset.name)).not.toContain("negative");
    expect(entry.latestRelease.assets.length).toBeLessThanOrEqual(16);
  });

  it("says a repository is unavailable rather than show a bad tag, a bad branch, a bad commit or a private repository", async () => {
    const cases = [
      [serve({ tag_name: "../../etc", assets: [] }), "invalid release tag"],
      [vi.fn(async (path) => (path.includes("/commits/") ? commit("5".repeat(40)) : path.endsWith("/releases/latest") ? null : { ...repository, default_branch: "-oops branch" })), "invalid default branch"],
      [vi.fn(async (path) => (path.includes("/commits/") ? { sha: "not-a-sha" } : path.endsWith("/releases/latest") ? null : repository)), "invalid commit identity"],
      [vi.fn(async () => ({ ...repository, private: true })), "Only public repository"],
    ];
    for (const [requestJson, reason] of cases) {
      const { repositories: [entry] } = await createGithubProvenanceService({ requestJson }).inspect();
      expect(entry.status).toBe("unavailable");
      expect(entry.error).toContain(reason);
    }
  });

  it("reads again after fifteen minutes, and asks once for callers that arrive together", async () => {
    let now = Date.parse("2026-08-16T03:00:00Z");
    const requestJson = serve(null);
    const service = createGithubProvenanceService({ requestJson, clock: () => now });
    await Promise.all([service.inspect(), service.inspect()]);
    expect(requestJson).toHaveBeenCalledTimes(3);
    now += 14 * 60_000;
    await service.inspect();
    expect(requestJson).toHaveBeenCalledTimes(3);
    now += 2 * 60_000;
    await service.inspect();
    expect(requestJson).toHaveBeenCalledTimes(6);
  });

  it("treats a missing release as none, other statuses and invalid JSON as errors, and checks the body's real size", async () => {
    const answer = (body, status = 200, headers = {}) => createGithubRequester({ fetchImpl: async () => new Response(body, { status, headers }) });
    await expect(answer("", 404)("/repos/x/releases/latest", { allowNotFound: true })).resolves.toBeNull();
    await expect(answer("", 404)("/repos/x")).rejects.toThrow("status 404");
    await expect(answer("<html>", 200)("/repos/x")).rejects.toThrow("invalid JSON");
    await expect(answer(JSON.stringify({ padding: "x".repeat(githubProvenanceInternals.maximumResponseBytes) }))("/repos/x")).rejects.toThrow("size limit");
  });
});
