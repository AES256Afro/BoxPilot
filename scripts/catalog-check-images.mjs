#!/usr/bin/env node
/**
 * Verify every catalog manifest's image tag exists in its registry (anonymous pull scope), and that
 * a tag pinned with a digest (`repo:tag@sha256:…`) still points at that digest.
 *   node scripts/catalog-check-images.mjs        # exit 1 if any tag is missing or has moved
 *
 * A publisher can re-push a tag, and a compromised registry account can repoint one. A moved tag
 * fails here, so the new digest arrives as a reviewed catalog change (catalog-pin-digests.mjs
 * --refresh) rather than as different bytes on the next install.
 *
 * The pin is the multi-arch index's digest, and an index is rewritten whole when any one platform
 * under it is re-pushed. So a changed index digest is not by itself a changed image: when only the
 * platforms BoxPilot never runs moved, this reports RESTACK and does not fail. The pin is then
 * stale but harmless, and `--refresh` moves it in the weekly catalog-updates pull request.
 */
import { loadCatalog } from "../server/catalog/index.mjs";

export const accept = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

/** Every BoxPilot server is one of these: the deployment target is Ubuntu Server on amd64 or arm64. */
export const targetedPlatforms = ["linux/amd64", "linux/arm64"];

export function parseReference(reference) {
  const [name] = reference.split("@");
  const [repo, tag = "latest"] = name.split(/:(?=[^/]+$)/);
  const first = repo.split("/")[0];
  const hasRegistry = repo.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let path = hasRegistry ? repo.split("/").slice(1).join("/") : repo.includes("/") ? repo : `library/${repo}`;
  let host = registry;
  if (registry === "lscr.io") { host = "ghcr.io"; path = `linuxserver/${path.split("/").pop()}`; }
  if (registry === "docker.io") { host = "registry-1.docker.io"; }
  return { host, path, tag };
}

/** The digest a reference pins (`sha256:…`), or null for a plain tag. */
export function pinnedDigest(reference) {
  return String(reference).match(/@(sha256:[a-f0-9]{64})$/)?.[1] ?? null;
}

/** Whether the reference names a tag (`repo:tag`, with or without a digest after it). */
export function hasTag(reference) {
  const [name] = String(reference).split("@");
  return name.lastIndexOf(":") > name.lastIndexOf("/");
}

export async function bearer(host, path, challenge, fetchImpl = fetch) {
  const realm = challenge?.match(/realm="([^"]+)"/)?.[1] ?? (host === "registry-1.docker.io" ? "https://auth.docker.io/token" : `https://${host}/token`);
  const service = challenge?.match(/service="([^"]+)"/)?.[1] ?? (host === "registry-1.docker.io" ? "registry.docker.io" : host);
  const response = await fetchImpl(`${realm}?service=${encodeURIComponent(service)}&scope=repository:${path}:pull`);
  const body = await response.json().catch(() => ({}));
  return body.token ?? body.access_token ?? null;
}

/** One registry request, retried with an anonymous pull token when the registry asks for one. */
async function registryRequest(url, { host, path, method, fetchImpl = fetch }) {
  let response = await fetchImpl(url, { method, headers: { Accept: accept } });
  if (response.status === 401) {
    const token = await bearer(host, path, response.headers.get("www-authenticate"), fetchImpl);
    if (token) response = await fetchImpl(url, { method, headers: { Accept: accept, Authorization: `Bearer ${token}` } });
  }
  return response;
}

/**
 * HEAD the reference's tag. `digest` is the registry's Docker-Content-Digest for it: the multi-arch
 * index when there is one, which is also what Docker records in RepoDigests after a pull by tag.
 */
export async function headTag(reference, { fetchImpl = fetch } = {}) {
  const { host, path, tag } = parseReference(reference);
  // `repo@sha256:…` with no tag: nothing can move, so ask for the digest itself.
  const target = hasTag(reference) ? tag : pinnedDigest(reference) ?? tag;
  const response = await registryRequest(`https://${host}/v2/${path}/manifests/${target}`, { host, path, method: "HEAD", fetchImpl });
  const digest = response.headers.get("docker-content-digest");
  return { status: response.status, digest: response.status === 200 && /^sha256:[a-f0-9]{64}$/.test(digest ?? "") ? digest : null };
}

/** GET one manifest of the reference's repository by digest, parsed. `body` is null unless it is 200 JSON. */
export async function getManifest(reference, target, { fetchImpl = fetch } = {}) {
  const { host, path } = parseReference(reference);
  const response = await registryRequest(`https://${host}/v2/${path}/manifests/${target}`, { host, path, method: "GET", fetchImpl });
  if (response.status !== 200) return { status: response.status, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * An index's per-platform manifest digests, keyed `os/architecture` so `arm64/v8` and a bare
 * `arm64` are one platform. `unknown/unknown` attestation entries are not images and are dropped;
 * a single-platform manifest has no entries at all, so this is empty for it.
 */
export function platformDigests(index) {
  const digests = new Map();
  for (const entry of index?.manifests ?? []) {
    const { os, architecture } = entry?.platform ?? {};
    if (!os || !architecture || os === "unknown" || architecture === "unknown" || !entry.digest) continue;
    const platform = `${os}/${architecture}`;
    if (!digests.has(platform)) digests.set(platform, new Set());
    digests.get(platform).add(entry.digest);
  }
  return digests;
}

/**
 * Which platforms moved between two indexes. `changed` is the targeted ones whose manifest digests
 * differ or that have gone — the ones that mean a BoxPilot server would pull other bytes. `rebuilt`
 * is everything else that moved or appeared, which no BoxPilot server pulls.
 */
export function comparePlatforms(pinnedIndex, currentIndex) {
  const before = platformDigests(pinnedIndex);
  const after = platformDigests(currentIndex);
  const same = (platform) => {
    const [was, now] = [before.get(platform), after.get(platform)];
    return Boolean(now && was && now.size === was.size && [...was].every((digest) => now.has(digest)));
  };
  const changed = [];
  const rebuilt = [];
  for (const platform of before.keys()) {
    if (same(platform)) continue;
    if (!targetedPlatforms.includes(platform)) rebuilt.push(platform);
    else changed.push(after.has(platform) ? platform : `${platform} (gone)`);
  }
  for (const platform of after.keys()) if (!before.has(platform)) rebuilt.push(`${platform} (new)`);
  return { changed, rebuilt };
}

/**
 * Why a pinned index's digest changed: read both indexes and compare the platforms BoxPilot runs
 * on. Anything that cannot be compared fails as a move, so an unreadable index never reads as a
 * pass: a pinned index the registry has dropped, a reference that is not a multi-arch index, or a
 * request that errors.
 */
export async function comparePinnedIndex(reference, pinned, current, options = {}) {
  let before;
  let after;
  try {
    before = await getManifest(reference, pinned, options);
    after = await getManifest(reference, current, options);
  } catch (error) {
    return { moved: true, reason: `could not read the indexes to compare (${error.message})` };
  }
  if (before.status !== 200) return { moved: true, reason: `the registry no longer serves the pinned digest (${before.status})` };
  if (after.status !== 200) return { moved: true, reason: `could not read the index the tag now names (${after.status})` };
  const platforms = comparePlatforms(before.body, after.body);
  const targeted = [...platformDigests(before.body).keys()].filter((platform) => targetedPlatforms.includes(platform));
  if (!targeted.length) return { moved: true, platforms, reason: `the pinned digest names no ${targetedPlatforms.join(" or ")} image to compare` };
  if (platforms.changed.length) return { moved: true, platforms, reason: `${platforms.changed.join(", ")} changed` };
  return { moved: false, restacked: true, platforms };
}

/**
 * `moved` when the reference pins a digest and the bytes a BoxPilot server would pull have changed;
 * `restacked` when the pinned index was rewritten but linux/amd64 and linux/arm64 are the same
 * manifests as before. A pinned tag whose registry gives no digest cannot be checked, which is a
 * failure too: it must not read as a pass.
 */
export async function checkImage(reference, options = {}) {
  const { status, digest } = await headTag(reference, options);
  const pinned = pinnedDigest(reference);
  const unverified = Boolean(pinned && status === 200 && !digest);
  const drifted = Boolean(pinned && digest && digest !== pinned);
  const result = { reference, status, digest, pinned, moved: drifted, restacked: false, unverified, platforms: { changed: [], rebuilt: [] }, reason: null };
  if (drifted) Object.assign(result, await comparePinnedIndex(reference, pinned, digest, options));
  return { ...result, ok: status === 200 && !result.moved && !unverified };
}

export function checkLine(id, result) {
  const word = result.moved ? "MOVED  " : result.restacked ? "RESTACK" : result.unverified ? "NODIGST" : result.ok ? "ok     " : "MISSING";
  const rebuilt = result.platforms?.rebuilt?.length ? result.platforms.rebuilt.join(", ") : "no platform";
  const detail = result.moved
    ? [`tag now points to ${result.digest}`, result.reason].filter(Boolean).join("; ")
    : result.restacked ? `tag now points to ${result.digest}; ${rebuilt} rebuilt, nothing BoxPilot runs changed`
    : result.unverified ? "registry gave no digest to compare"
    : String(result.status);
  return `${word} ${id.padEnd(14)} ${result.reference} (${detail})`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { manifests, problems } = await loadCatalog();
  let failed = problems.length;
  let restacked = 0;
  for (const problem of problems) console.log(`INVALID ${problem.file}: ${problem.errors.join("; ")}`);
  for (const manifest of manifests) {
    const references = [manifest.image.reference, ...(manifest.sidecars ?? []).map((sidecar) => sidecar.image)];
    for (const reference of references) {
      const result = await checkImage(reference);
      console.log(checkLine(manifest.id, result));
      if (!result.ok) failed += 1;
      if (result.restacked) restacked += 1;
    }
  }
  if (restacked) console.log(`${restacked} pin${restacked === 1 ? "" : "s"} are stale on platforms BoxPilot does not run; catalog-pin-digests.mjs --refresh --write moves them in the weekly update.`);
  process.exitCode = failed ? 1 : 0;
}
