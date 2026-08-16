import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitHubCenter from "./GitHubCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const commit = { sha: "1".repeat(40), url: `https://github.com/AES256Afro/BoxPilot/commit/${"1".repeat(40)}`, committedAt: "2026-08-16T02:27:01.000Z", verification: { reportedBy: "github-api", verified: true, reason: "valid", verifiedAt: "2026-08-16T02:27:01.000Z" } };
const status = {
  fetchedAt: "2026-08-16T03:00:00.000Z", cacheTtlSeconds: 900, source: "GitHub public REST API without authentication",
  boundary: { repositoryAllowlist: ["AES256Afro/BoxPilot", "AES256Afro/Keel"], tokenConfigured: false, credentialsAccepted: false, repositoryWrites: false, cloneOrDownload: false, webhookConfigured: false, workflowDispatch: false, installationSupported: false, localDigestVerification: false },
  repositories: [
    { id: "boxpilot", owner: "AES256Afro", repository: "BoxPilot", purpose: "BoxPilot control-plane source", fullName: "AES256Afro/BoxPilot", url: "https://github.com/AES256Afro/BoxPilot", status: "available", visibility: "public", archived: false, defaultBranch: "main", pushedAt: "2026-08-16T02:27:03.000Z", head: commit, latestRelease: null },
    { id: "keel", owner: "AES256Afro", repository: "Keel", purpose: "Keel Notes application source and releases", fullName: "AES256Afro/Keel", url: "https://github.com/AES256Afro/Keel", status: "available", visibility: "public", archived: false, defaultBranch: "main", pushedAt: "2026-08-16T12:00:00.000Z", head: commit, latestRelease: { tagName: "v1.2.6", name: "Keel 1.2.6", url: "https://github.com/AES256Afro/Keel/releases/tag/v1.2.6", publishedAt: "2026-08-16T12:00:00.000Z", targetCommitish: "main", draft: false, prerelease: false, immutable: false, commit, assets: [{ name: "keel-1.2.6-linux-x64.tar.gz", sizeBytes: 71052143, contentType: "application/gzip", digest: "sha256:696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00" }], assetsWithGithubReportedDigest: 1 } },
  ],
  limitations: ["GitHub metadata is not local verification.", "No install exists."],
};

describe("GitHub Center", () => {
  it("renders the public metadata and no-credential boundary", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GitHubCenter />);
    expect(await screen.findByText("No GitHub token")).toBeTruthy();
    expect(screen.getByText("AES256Afro/BoxPilot")).toBeTruthy();
    expect(screen.getByText("AES256Afro/Keel")).toBeTruthy();
    expect(screen.getByText("Keel 1.2.6")).toBeTruthy();
    expect(screen.getByText("No GitHub release")).toBeTruthy();
    expect(screen.getAllByText("GitHub reports verified").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Downloads locked")).toBeTruthy();
    expect(screen.getByText("Install locked")).toBeTruthy();
    expect(screen.queryByText(/token input/i)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/integrations/github");
  });

  it("shows an endpoint failure without inventing provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "GitHub unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    render(<GitHubCenter />);
    expect((await screen.findByRole("alert")).textContent).toContain("GitHub unavailable");
    expect(screen.queryByText("GitHub reports verified")).toBeNull();
  });
});
