/**
 * Web-side release check for self-update: which GitHub release is current, whether it is newer
 * than the running version, and — when the owner stages an update — the exact commit that tag
 * points at, pinned into the job so the root task can refuse a tag that moved.
 */
import { createGithubRequester } from "./github-provenance.mjs";
import { productVersion } from "./version.mjs";

const tagPattern = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const shaPattern = /^[a-f0-9]{40}$/;
const controlCharacters = /[\u0000-\u001f\u007f]/g;

export function parseVersion(value) {
  const match = String(value ?? "").replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.]+))?$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null } : null;
}

/** Semver-style ordering; a prerelease sorts below its release. Returns -1, 0, or 1. */
export function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function safeText(value, maximum) {
  return typeof value === "string" ? value.replace(controlCharacters, " ").trim().slice(0, maximum) : null;
}

export function createReleaseUpdateService({ requestJson = createGithubRequester(), currentVersion = productVersion, owner = "AES256Afro", repository = "BoxPilot", clock = () => Date.now(), cacheTtlMs = 15 * 60 * 1000 } = {}) {
  const basePath = `/repos/${owner}/${repository}`;
  let cached = null;

  function describe(release) {
    const tag = typeof release?.tag_name === "string" && tagPattern.test(release.tag_name) ? release.tag_name : null;
    if (!tag) return null;
    return {
      tag,
      version: tag.slice(1),
      name: safeText(release.name, 160) ?? tag,
      url: `https://github.com/${owner}/${repository}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      prerelease: release.prerelease === true,
      notes: safeText(release.body, 4000),
    };
  }

  async function inspect({ refresh = false } = {}) {
    if (!refresh && cached && clock() - cached.at < cacheTtlMs) return cached.value;
    let value;
    try {
      const release = await requestJson(`${basePath}/releases/latest`, { allowNotFound: true });
      const latest = release && release.draft !== true ? describe(release) : null;
      value = { current: { version: currentVersion }, latest, updateAvailable: Boolean(latest && compareVersions(latest.version, currentVersion) > 0), checkedAt: new Date(clock()).toISOString(), error: null };
    } catch (error) {
      value = { current: { version: currentVersion }, latest: null, updateAvailable: false, checkedAt: new Date(clock()).toISOString(), error: error.message };
    }
    cached = { at: clock(), value };
    return value;
  }

  /** Pin the reviewed release's commit into the staged parameters. */
  async function prepareOperation({ tag } = {}) {
    if (typeof tag !== "string" || !tagPattern.test(tag)) throw new Error("Choose a release tag like v1.2.3");
    const release = await requestJson(`${basePath}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    if (!release || release.draft === true) throw new Error(`${tag} is not a published release`);
    if (compareVersions(tag.slice(1), currentVersion) <= 0) throw new Error(`${tag} is not newer than the installed ${currentVersion}`);
    const commit = await requestJson(`${basePath}/commits/${encodeURIComponent(tag)}`);
    if (typeof commit?.sha !== "string" || !shaPattern.test(commit.sha)) throw new Error("GitHub returned an invalid commit for the release");
    return { tag, expectedCommit: commit.sha };
  }

  return { inspect, prepareOperation };
}
