#!/usr/bin/env node
/**
 * Verify every catalog manifest's image tag exists in its registry (anonymous pull scope), and that
 * a tag pinned with a digest (`repo:tag@sha256:…`) still points at that digest.
 *   node scripts/catalog-check-images.mjs        # exit 1 if any tag is missing or has moved
 *
 * A publisher can re-push a tag, and a compromised registry account can repoint one. A moved tag
 * fails here, so the new digest arrives as a reviewed catalog change (catalog-pin-digests.mjs
 * --refresh) rather than as different bytes on the next install.
 */
import { loadCatalog } from "../server/catalog/index.mjs";

export const accept = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

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

/**
 * HEAD the reference's tag. `digest` is the registry's Docker-Content-Digest for it: the multi-arch
 * index when there is one, which is also what Docker records in RepoDigests after a pull by tag.
 */
export async function headTag(reference, { fetchImpl = fetch } = {}) {
  const { host, path, tag } = parseReference(reference);
  // `repo@sha256:…` with no tag: nothing can move, so ask for the digest itself.
  const url = `https://${host}/v2/${path}/manifests/${hasTag(reference) ? tag : pinnedDigest(reference) ?? tag}`;
  let response = await fetchImpl(url, { method: "HEAD", headers: { Accept: accept } });
  if (response.status === 401) {
    const token = await bearer(host, path, response.headers.get("www-authenticate"), fetchImpl);
    if (token) response = await fetchImpl(url, { method: "HEAD", headers: { Accept: accept, Authorization: `Bearer ${token}` } });
  }
  const digest = response.headers.get("docker-content-digest");
  return { status: response.status, digest: response.status === 200 && /^sha256:[a-f0-9]{64}$/.test(digest ?? "") ? digest : null };
}

/**
 * `moved` when the reference pins a digest and the tag now names another one. A pinned tag whose
 * registry gives no digest cannot be checked, which is a failure too: it must not read as a pass.
 */
export async function checkImage(reference, options = {}) {
  const { status, digest } = await headTag(reference, options);
  const pinned = pinnedDigest(reference);
  const moved = Boolean(pinned && digest && digest !== pinned);
  const unverified = Boolean(pinned && status === 200 && !digest);
  return { reference, status, digest, pinned, moved, unverified, ok: status === 200 && !moved && !unverified };
}

export function checkLine(id, result) {
  const word = result.moved ? "MOVED  " : result.unverified ? "NODIGST" : result.ok ? "ok     " : "MISSING";
  const detail = result.moved ? `tag now points to ${result.digest}` : result.unverified ? "registry gave no digest to compare" : String(result.status);
  return `${word} ${id.padEnd(14)} ${result.reference} (${detail})`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { manifests, problems } = await loadCatalog();
  let failed = problems.length;
  for (const problem of problems) console.log(`INVALID ${problem.file}: ${problem.errors.join("; ")}`);
  for (const manifest of manifests) {
    const references = [manifest.image.reference, ...(manifest.sidecars ?? []).map((sidecar) => sidecar.image)];
    for (const reference of references) {
      const result = await checkImage(reference);
      console.log(checkLine(manifest.id, result));
      if (!result.ok) failed += 1;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
