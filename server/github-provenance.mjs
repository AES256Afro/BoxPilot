const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const cacheTtlMs = 15 * 60 * 1000;
const maximumResponseBytes = 512 * 1024;

const repositoryCatalog = [
  { id: "boxpilot", owner: "AES256Afro", repository: "BoxPilot", purpose: "BoxPilot control-plane source" },
  { id: "keel", owner: "AES256Afro", repository: "Keel", purpose: "Keel Notes application source and releases" },
];

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;

function safeText(value, maximum = 160) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : null;
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeRef(value) {
  return typeof value === "string" && refPattern.test(value) ? value : null;
}

function commitEvidence(commit, owner, repository) {
  const sha = typeof commit?.sha === "string" && shaPattern.test(commit.sha) ? commit.sha : null;
  if (!sha) throw new Error("GitHub returned an invalid commit identity");
  return {
    sha,
    url: `https://github.com/${owner}/${repository}/commit/${sha}`,
    committedAt: safeIso(commit?.commit?.committer?.date),
    verification: {
      reportedBy: "github-api",
      verified: commit?.commit?.verification?.verified === true,
      reason: safeText(commit?.commit?.verification?.reason, 64) ?? "unavailable",
      verifiedAt: safeIso(commit?.commit?.verification?.verified_at),
    },
  };
}

function releaseEvidence(release, releaseCommit, owner, repository) {
  if (!release) return null;
  const tagName = safeRef(release.tag_name);
  if (!tagName) throw new Error("GitHub returned an invalid release tag");
  const assets = Array.isArray(release.assets) ? release.assets.slice(0, 16).flatMap((asset) => {
    const name = safeText(asset?.name, 120);
    const sizeBytes = Number.isSafeInteger(asset?.size) && asset.size >= 0 ? asset.size : null;
    if (!name || sizeBytes === null) return [];
    return [{
      name,
      sizeBytes,
      contentType: safeText(asset?.content_type, 80),
      digest: typeof asset?.digest === "string" && digestPattern.test(asset.digest) ? asset.digest : null,
    }];
  }) : [];
  return {
    tagName,
    name: safeText(release.name, 160) ?? tagName,
    url: `https://github.com/${owner}/${repository}/releases/tag/${encodeURIComponent(tagName)}`,
    publishedAt: safeIso(release.published_at),
    targetCommitish: safeRef(release.target_commitish),
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    immutable: release.immutable === true,
    commit: commitEvidence(releaseCommit, owner, repository),
    assets,
    assetsWithGithubReportedDigest: assets.filter((asset) => asset.digest).length,
  };
}

export function createGithubRequester({ fetchImpl = globalThis.fetch } = {}) {
  return async function requestJson(path, { allowNotFound = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchImpl(`${githubApiBase}${path}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "BoxPilot-read-only-provenance",
          "X-GitHub-Api-Version": githubApiVersion,
        },
      });
      if (allowNotFound && response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub public API returned status ${response.status}`);
      const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) throw new Error("GitHub response exceeded the fixed size limit");
      const body = await response.text();
      if (Buffer.byteLength(body) > maximumResponseBytes) throw new Error("GitHub response exceeded the fixed size limit");
      try {
        return JSON.parse(body);
      } catch {
        throw new Error("GitHub returned invalid JSON");
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createGithubProvenanceService({ requestJson = createGithubRequester(), clock = () => Date.now() } = {}) {
  let cached = null;
  let inFlight = null;

  async function inspectRepository(declaration) {
    const basePath = `/repos/${declaration.owner}/${declaration.repository}`;
    const metadata = await requestJson(basePath);
    if (metadata?.private === true) throw new Error("Only public repository provenance is supported without credentials");
    const defaultBranch = safeRef(metadata?.default_branch);
    if (!defaultBranch) throw new Error("GitHub returned an invalid default branch");
    const [headCommit, release] = await Promise.all([
      requestJson(`${basePath}/commits/${encodeURIComponent(defaultBranch)}`),
      requestJson(`${basePath}/releases/latest`, { allowNotFound: true }),
    ]);
    const releaseTag = release ? safeRef(release.tag_name) : null;
    const releaseCommit = releaseTag ? await requestJson(`${basePath}/commits/${encodeURIComponent(releaseTag)}`) : null;
    return {
      ...declaration,
      fullName: `${declaration.owner}/${declaration.repository}`,
      url: `https://github.com/${declaration.owner}/${declaration.repository}`,
      status: "available",
      visibility: "public",
      archived: metadata?.archived === true,
      defaultBranch,
      pushedAt: safeIso(metadata?.pushed_at),
      head: commitEvidence(headCommit, declaration.owner, declaration.repository),
      latestRelease: releaseEvidence(release, releaseCommit, declaration.owner, declaration.repository),
    };
  }

  async function load() {
    const repositories = await Promise.all(repositoryCatalog.map(async (declaration) => {
      try {
        return await inspectRepository(declaration);
      } catch (error) {
        return {
          ...declaration,
          fullName: `${declaration.owner}/${declaration.repository}`,
          url: `https://github.com/${declaration.owner}/${declaration.repository}`,
          status: "unavailable",
          error: error instanceof Error ? safeText(error.message, 180) : "GitHub provenance is unavailable",
        };
      }
    }));
    return {
      fetchedAt: new Date(clock()).toISOString(),
      cacheTtlSeconds: cacheTtlMs / 1000,
      source: "GitHub public REST API without authentication",
      repositories,
      boundary: {
        repositoryAllowlist: repositoryCatalog.map(({ owner, repository }) => `${owner}/${repository}`),
        tokenConfigured: false,
        credentialsAccepted: false,
        repositoryWrites: false,
        cloneOrDownload: false,
        webhookConfigured: false,
        workflowDispatch: false,
        installationSupported: false,
        localDigestVerification: false,
      },
      limitations: [
        "GitHub commit verification and asset digests are API-reported metadata; BoxPilot does not independently verify signatures or downloaded bytes.",
        "A release asset is not installable until a future adapter downloads it to a confined staging path and verifies its exact digest locally.",
        "No GitHub token, repository write, clone, download, webhook, workflow dispatch, or adapter installation exists in this release.",
      ],
    };
  }

  async function inspect() {
    const now = clock();
    if (cached && now - cached.loadedAt < cacheTtlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = load().then((value) => {
      cached = { loadedAt: clock(), value };
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { inspect };
}

export const githubProvenanceInternals = { cacheTtlMs, digestPattern, maximumResponseBytes, repositoryCatalog, safeIso, safeRef, safeText, shaPattern };
