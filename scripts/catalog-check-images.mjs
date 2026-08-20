#!/usr/bin/env node
/**
 * Verify every catalog manifest's image tag exists in its registry (anonymous pull scope).
 *   node scripts/catalog-check-images.mjs        # exit 1 if any tag is missing
 */
import { loadCatalog } from "../server/catalog/index.mjs";

const accept = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

function parseReference(reference) {
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

async function bearer(host, path, challenge) {
  const realm = challenge?.match(/realm="([^"]+)"/)?.[1] ?? (host === "registry-1.docker.io" ? "https://auth.docker.io/token" : `https://${host}/token`);
  const service = challenge?.match(/service="([^"]+)"/)?.[1] ?? (host === "registry-1.docker.io" ? "registry.docker.io" : host);
  const response = await fetch(`${realm}?service=${encodeURIComponent(service)}&scope=repository:${path}:pull`);
  const body = await response.json().catch(() => ({}));
  return body.token ?? body.access_token ?? null;
}

export async function checkImage(reference) {
  const { host, path, tag } = parseReference(reference);
  const url = `https://${host}/v2/${path}/manifests/${tag}`;
  let response = await fetch(url, { method: "HEAD", headers: { Accept: accept } });
  if (response.status === 401) {
    const token = await bearer(host, path, response.headers.get("www-authenticate"));
    if (token) response = await fetch(url, { method: "HEAD", headers: { Accept: accept, Authorization: `Bearer ${token}` } });
  }
  return { reference, status: response.status, ok: response.status === 200 };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { manifests, problems } = await loadCatalog();
  let failed = problems.length;
  for (const problem of problems) console.log(`INVALID ${problem.file}: ${problem.errors.join("; ")}`);
  for (const manifest of manifests) {
    const references = [manifest.image.reference, ...(manifest.sidecars ?? []).map((sidecar) => sidecar.image)];
    for (const reference of references) {
      const result = await checkImage(reference);
      console.log(`${result.ok ? "ok     " : "MISSING"} ${manifest.id.padEnd(14)} ${reference} (${result.status})`);
      if (!result.ok) failed += 1;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
