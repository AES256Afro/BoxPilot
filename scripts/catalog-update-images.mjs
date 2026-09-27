#!/usr/bin/env node
/**
 * Move catalog pins for images the repository's owner publishes to their newest release tag.
 *   node scripts/catalog-update-images.mjs --owner <github-owner>              # report only
 *   node scripts/catalog-update-images.mjs --owner <github-owner> --write \
 *     --title-file title.txt --body-file body.md                               # edit manifests
 *
 * FarSpace shipped sixty-odd releases in one day and each needed a hand-made pull request; the one
 * that waited fell 22 releases behind. The owner's own images are released on the owner's say-so
 * already, so following them is bookkeeping. Third-party images are left alone: an upstream
 * release can change ports, users or data layout, and that needs a person.
 *
 * Only plain release tags in the shape the manifest already pins (1.2.3, or v1.2.3) are
 * candidates: never `latest`, pre-releases, or digest pins. Each move compares the new image's
 * shape (platforms, user, exposed ports, volumes, healthcheck) with the pinned one and lists any
 * difference, because the manifest may need to change with it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCatalogDirectory, loadCatalog } from "../server/catalog/index.mjs";
import { accept, bearer, parseReference } from "./catalog-check-images.mjs";

const releasePattern = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/** `repo:tag` without a digest, or null when the reference is digest-pinned or has no tag. */
export function splitReference(reference) {
  if (typeof reference !== "string" || reference.includes("@")) return null;
  const match = reference.match(/^(.+\/[^/:]+|[^/:]+):([^/:]+)$/);
  return match ? { repo: match[1], tag: match[2] } : null;
}

export function isOwnedImage(reference, owner) {
  const parts = splitReference(reference);
  return Boolean(parts && owner && parts.repo.toLowerCase().startsWith(`ghcr.io/${owner.toLowerCase()}/`));
}

function releaseKey(match) {
  return [Number(match[2]), Number(match[3]), Number(match[4])];
}

function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The highest release tag above `current` with the same `v` prefix, or null. */
export function newestRelease(tags, current) {
  const pinned = String(current).match(releasePattern);
  if (!pinned) return null;
  let best = null;
  for (const tag of tags) {
    const match = String(tag).match(releasePattern);
    if (!match || match[1] !== pinned[1]) continue;
    if (compareKeys(releaseKey(match), releaseKey(pinned)) <= 0) continue;
    if (!best || compareKeys(releaseKey(match), releaseKey(best)) > 0) best = match;
  }
  return best ? best[0] : null;
}

export function isMajorMove(from, to) {
  const a = String(from).match(releasePattern);
  const b = String(to).match(releasePattern);
  return Boolean(a && b && a[2] !== b[2]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite one image's tag in a manifest's text, keeping comments and layout. The main image's
 * `version:` line moves with it when it spelled the same tag.
 */
export function retag(text, { repo, from, to, main, version }) {
  const reference = new RegExp(`(${escapeRegExp(repo)}):${escapeRegExp(from)}(?=["'\\s]|$)`, "gm");
  let next = text.replace(reference, (_, name) => `${name}:${to}`);
  if (main && version === from) {
    // `\r?` because a Windows checkout has CRLF endings, and `$` in multiline mode stops before `\n`.
    const versionLine = new RegExp(`^(\\s+version:[ \\t]*)(["']?)${escapeRegExp(from)}\\2([ \\t]*\\r?)$`, "m");
    next = next.replace(versionLine, (_, key, quote, tail) => `${key}${quote}${to}${quote}${tail}`);
  }
  return next;
}

const shapeFields = [["platforms", "platforms"], ["user", "user"], ["ports", "exposed ports"], ["volumes", "volumes"], ["healthcheck", "healthcheck"]];

function showShapeValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  return value ?? "none";
}

export function shapeChanges(before, after) {
  return shapeFields
    .filter(([key]) => showShapeValue(before[key]) !== showShapeValue(after[key]))
    .map(([key, label]) => `${label}: ${showShapeValue(before[key])} → ${showShapeValue(after[key])}`);
}

/** Anonymous registry reads for one repository: its tags, and the shape of one tag's image. */
export function registryClient(reference) {
  const { host, path: repository } = parseReference(reference);
  let token = null;
  async function get(url, headers = {}) {
    const withAuth = () => ({ ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
    let response = await fetch(url, { headers: withAuth() });
    if (response.status === 401 && !token) {
      token = await bearer(host, repository, response.headers.get("www-authenticate"));
      if (token) response = await fetch(url, { headers: withAuth() });
    }
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    return response;
  }
  return {
    async tags() {
      const tags = [];
      let next = `https://${host}/v2/${repository}/tags/list?n=1000`;
      for (let page = 0; next && page < 50; page += 1) {
        const response = await get(next);
        tags.push(...((await response.json()).tags ?? []));
        const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        next = link ? new URL(link, `https://${host}`).href : null;
      }
      return tags;
    },
    async shape(tag) {
      let manifest = await (await get(`https://${host}/v2/${repository}/manifests/${tag}`, { Accept: accept })).json();
      let platforms = [];
      if (Array.isArray(manifest.manifests)) {
        const images = manifest.manifests.filter((entry) => entry.platform && entry.platform.os !== "unknown");
        platforms = images.map(({ platform }) => [platform.os, platform.architecture, platform.variant].filter(Boolean).join("/")).sort();
        const chosen = images.find((entry) => entry.platform.architecture === "amd64") ?? images[0];
        manifest = await (await get(`https://${host}/v2/${repository}/manifests/${chosen.digest}`, { Accept: accept })).json();
      }
      const config = (await (await get(`https://${host}/v2/${repository}/blobs/${manifest.config.digest}`)).json()).config ?? {};
      return {
        platforms,
        user: config.User || "root",
        ports: Object.keys(config.ExposedPorts ?? {}).sort(),
        volumes: Object.keys(config.Volumes ?? {}).sort(),
        healthcheck: config.Healthcheck?.Test?.join(" ") ?? "none",
      };
    },
  };
}

/** Every owned image in the catalog with a newer release, and every lookup that failed. */
export async function findUpdates(manifests, owner, { clientFor = registryClient } = {}) {
  const updates = [];
  const failures = [];
  for (const manifest of manifests) {
    const images = [
      { reference: manifest.image.reference, main: true },
      ...(manifest.sidecars ?? []).map((sidecar) => ({ reference: sidecar.image, main: false, sidecar: sidecar.id })),
    ];
    for (const image of images) {
      if (!isOwnedImage(image.reference, owner)) continue;
      const { repo, tag: from } = splitReference(image.reference);
      const client = clientFor(image.reference);
      let to;
      try {
        to = newestRelease(await client.tags(), from);
      } catch (error) {
        failures.push({ id: manifest.id, reference: image.reference, error: error.message });
        continue;
      }
      if (!to) continue;
      let changes;
      try {
        changes = shapeChanges(await client.shape(from), await client.shape(to));
      } catch (error) {
        changes = [`could not compare image shapes: ${error.message}`];
      }
      if (isMajorMove(from, to)) changes.unshift("new major version");
      updates.push({ id: manifest.id, name: manifest.name, file: manifest.file, repo, from, to, main: image.main, sidecar: image.sidecar, version: manifest.image.version, changes });
    }
  }
  return { updates, failures };
}

/** Write the moves into the manifests, then load the catalog again to prove it still validates. */
export async function applyUpdates(updates, directory = defaultCatalogDirectory) {
  for (const file of new Set(updates.map((update) => update.file))) {
    const target = path.join(directory, file);
    const before = await readFile(target, "utf8");
    let text = before;
    for (const update of updates.filter((candidate) => candidate.file === file)) {
      const next = retag(text, update);
      if (next === text) throw new Error(`${file}: could not find ${update.repo}:${update.from} to move`);
      text = next;
    }
    await writeFile(target, text);
  }
  const { manifests, problems } = await loadCatalog({ directory });
  if (problems.length) throw new Error(`the catalog no longer validates: ${problems.map((problem) => `${problem.file}: ${problem.errors.join("; ")}`).join(" | ")}`);
  for (const update of updates) {
    const manifest = manifests.find((candidate) => candidate.file === update.file);
    const references = [manifest?.image.reference, ...(manifest?.sidecars ?? []).map((sidecar) => sidecar.image)];
    if (!references.includes(`${update.repo}:${update.to}`)) throw new Error(`${update.file}: ${update.repo} did not move to ${update.to}`);
    if (update.main && update.version === update.from && manifest.image.version !== update.to) throw new Error(`${update.file}: image.version did not move to ${update.to}`);
  }
}

function label(update) {
  return update.sidecar ? `${update.name} (${update.sidecar})` : update.name;
}

export function pullRequestTitle(updates) {
  if (updates.length === 1) return `Update ${label(updates[0])} catalog image to ${updates[0].to}`;
  if (updates.length <= 3) return `Update catalog images: ${updates.map((update) => `${label(update)} ${update.to}`).join(", ")}`;
  return `Update ${updates.length} catalog images`;
}

export function pullRequestBody(updates, failures, owner) {
  const lines = [
    `Newer releases of images published by \`${owner}\`.`,
    "",
    "| App | Image | From | To | Needs a look |",
    "|---|---|---|---|---|",
    ...updates.map((update) => `| ${label(update)} | \`${update.repo}\` | ${update.from} | ${update.to} | ${update.changes.length ? update.changes.join("; ") : "—"} |`),
    "",
    "Each move compares the two images' platforms, user, exposed ports, volumes and healthcheck. Anything under *Needs a look* may need a matching change in the manifest.",
  ];
  if (failures.length) {
    lines.push("", "**Could not check:**", ...failures.map((failure) => `- ${failure.id}: \`${failure.reference}\`: ${failure.error}`));
  }
  lines.push(
    "",
    "Installed servers pick this up in the next BoxPilot release.",
    "",
    "The Catalog updates workflow keeps this pull request current from `main` once a day. Merging or closing it is safe; the next run starts again from `main`."
  );
  return `${lines.join("\n")}\n`;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const owner = argument("--owner") ?? process.env.GITHUB_REPOSITORY_OWNER;
  if (!owner) {
    console.error("Pass --owner <github-owner>: images under ghcr.io/<owner>/ are the ones followed.");
    process.exit(2);
  }
  const { manifests, problems } = await loadCatalog();
  if (problems.length) {
    for (const problem of problems) console.error(`INVALID ${problem.file}: ${problem.errors.join("; ")}`);
    process.exit(1);
  }
  const { updates, failures } = await findUpdates(manifests, owner);
  for (const update of updates) console.log(`update  ${update.id.padEnd(14)} ${update.repo} ${update.from} → ${update.to}${update.changes.length ? ` (${update.changes.join("; ")})` : ""}`);
  for (const failure of failures) console.log(`FAILED  ${failure.id.padEnd(14)} ${failure.reference}: ${failure.error}`);
  if (!updates.length && !failures.length) console.log("Every owned image is on its newest release.");
  if (process.argv.includes("--write") && updates.length) await applyUpdates(updates);
  const titleFile = argument("--title-file");
  const bodyFile = argument("--body-file");
  if (titleFile && updates.length) await writeFile(titleFile, `${pullRequestTitle(updates)}\n`);
  if (bodyFile && updates.length) await writeFile(bodyFile, pullRequestBody(updates, failures, owner));
  // A lookup that could not run must not look like "nothing to update".
  process.exitCode = failures.length ? 1 : 0;
}
