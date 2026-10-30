#!/usr/bin/env node
/**
 * Pin catalog images to the digest their tag names today (ADR-016).
 *   node scripts/catalog-pin-digests.mjs                     # report what would change
 *   node scripts/catalog-pin-digests.mjs --write             # pin every image that has only a tag
 *   node scripts/catalog-pin-digests.mjs --refresh --write   # also move pins whose tag has moved
 *
 * A tag is a pointer the publisher can move. With `repo:tag@sha256:…` every server installs the
 * same bytes, and catalog-check-images.mjs fails when the tag moves on. `--refresh` is the reviewed
 * answer to that failure: it writes the tag's new digest, and the diff shows which images moved.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCatalogDirectory, loadCatalog } from "../server/catalog/index.mjs";
import { headTag } from "./catalog-check-images.mjs";
import { splitReference } from "./catalog-update-images.mjs";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every image to pin (or, with `refresh`, re-pin), and every lookup that failed. */
export async function planPins(manifests, { refresh = false, resolve = (reference) => headTag(reference) } = {}) {
  const pins = [];
  const failures = [];
  for (const manifest of manifests) {
    const references = [manifest.image.reference, ...(manifest.sidecars ?? []).map((sidecar) => sidecar.image)];
    for (const reference of new Set(references)) {
      // A bare digest has no tag to follow; it is already exact.
      const parts = splitReference(reference);
      if (!parts || (parts.digest && !refresh)) continue;
      let digest;
      try {
        ({ digest } = await resolve(`${parts.repo}:${parts.tag}`));
      } catch (error) {
        failures.push({ id: manifest.id, reference, error: error.message });
        continue;
      }
      if (!digest) { failures.push({ id: manifest.id, reference, error: "the registry gave no digest for this tag" }); continue; }
      if (digest === parts.digest) continue;
      pins.push({ id: manifest.id, file: manifest.file, reference, next: `${parts.repo}:${parts.tag}@${digest}` });
    }
  }
  return { pins, failures };
}

/** Write the pins into the manifests, keeping comments and layout, then prove the catalog still validates. */
export async function applyPins(pins, directory = defaultCatalogDirectory) {
  for (const file of new Set(pins.map((pin) => pin.file))) {
    const target = path.join(directory, file);
    let text = await readFile(target, "utf8");
    for (const pin of pins.filter((candidate) => candidate.file === file)) {
      // The lookahead stops `repo:1.2` matching inside `repo:1.2.3` or a reference already pinned.
      const next = text.replace(new RegExp(`${escapeRegExp(pin.reference)}(?=["'\\s]|$)`, "gm"), pin.next);
      if (next === text) throw new Error(`${file}: could not find ${pin.reference} to pin`);
      text = next;
    }
    await writeFile(target, text);
  }
  const { manifests, problems } = await loadCatalog({ directory });
  if (problems.length) throw new Error(`the catalog no longer validates: ${problems.map((problem) => `${problem.file}: ${problem.errors.join("; ")}`).join(" | ")}`);
  for (const pin of pins) {
    const manifest = manifests.find((candidate) => candidate.file === pin.file);
    const references = [manifest?.image.reference, ...(manifest?.sidecars ?? []).map((sidecar) => sidecar.image)];
    if (!references.includes(pin.next)) throw new Error(`${pin.file}: ${pin.reference} was not pinned`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { manifests, problems } = await loadCatalog();
  if (problems.length) {
    for (const problem of problems) console.error(`INVALID ${problem.file}: ${problem.errors.join("; ")}`);
    process.exit(1);
  }
  const { pins, failures } = await planPins(manifests, { refresh: process.argv.includes("--refresh") });
  for (const pin of pins) console.log(`pin     ${pin.id.padEnd(14)} ${pin.next}`);
  for (const failure of failures) console.log(`FAILED  ${failure.id.padEnd(14)} ${failure.reference}: ${failure.error}`);
  if (!pins.length && !failures.length) console.log("Every image is pinned to the digest its tag names.");
  if (process.argv.includes("--write") && pins.length) await applyPins(pins);
  process.exitCode = failures.length ? 1 : 0;
}
