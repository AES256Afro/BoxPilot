import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitHubPage from "./GitHubPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = () => Date.parse("2026-08-16T03:05:00.000Z");

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

describe("GitHub page", () => {
  it("puts the verdict and the boundary first, then each repository's head and release", async () => {
    const fetchMock = vi.fn(async () => json(status));
    vi.stubGlobal("fetch", fetchMock);
    render(<GitHubPage now={now} />);
    expect(await screen.findByText("2 of 2 read")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "GitHub" })).toBeTruthy();
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 repositories · no token · cached 15 min · fetched 5 minutes ago");
    // What BoxPilot may do with GitHub, as facts: nothing but read public metadata.
    const boundary = document.querySelector(".github-boundary") as HTMLElement;
    expect(within(boundary).getByText("Rejected")).toBeTruthy();
    expect(within(boundary).getAllByText("Locked")).toHaveLength(3);
    expect(within(boundary).getByText("None")).toBeTruthy();

    const boxpilot = screen.getByRole("region", { name: "AES256Afro/BoxPilot" });
    expect(within(boxpilot).getByText("No GitHub release")).toBeTruthy();
    expect(within(boxpilot).getByText("GitHub reports verified")).toBeTruthy();
    const keel = screen.getByRole("region", { name: "AES256Afro/Keel" });
    expect(within(keel).getByText("Keel 1.2.6")).toBeTruthy();
    expect(within(keel).getByText("1 of 1 asset reported by GitHub")).toBeTruthy();
    const assets = within(keel).getByRole("table", { name: "Assets of Keel 1.2.6" });
    expect(within(assets).getByText("keel-1.2.6-linux-x64.tar.gz")).toBeTruthy();
    // GitHub's digest is shown as GitHub's, never as checked here.
    expect(within(assets).getByText("No")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Trust limitations" }).textContent).toContain("No install exists.");
    expect(screen.queryByText(/token input/i)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/integrations/github");
  });

  it("says when a repository did not answer, without inventing its provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...status, repositories: [{ ...status.repositories[0], status: "unavailable", error: "GitHub answered 502", head: undefined }] })));
    render(<GitHubPage now={now} />);
    expect(await screen.findByText("1 not answering")).toBeTruthy();
    expect(screen.getByText("GitHub answered 502")).toBeTruthy();
    expect(screen.queryByText("GitHub reports verified")).toBeNull();
  });

  it("shows an endpoint failure as not read, and offers to try again", async () => {
    const fetchMock = vi.fn(async () => json({ error: "GitHub unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    render(<GitHubPage now={now} />);
    expect((await screen.findByRole("alert")).textContent).toContain("GitHub unavailable");
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.queryByText("GitHub reports verified")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
