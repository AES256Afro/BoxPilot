/**
 * Root-side task: download an official cloud image (Ubuntu / Debian) into the libvirt images
 * directory with checksum verification. Runs in boxpilot-run@ because it needs the network.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";

export const cloudImageRoot = process.env.BOXPILOT_CLOUD_IMAGE_ROOT ?? "/var/lib/libvirt/images/boxpilot-cloud-images";

/** Catalog of supported base images. `osVariant` feeds virt-install; `defaultUser` is the distro's cloud-init user. */
export const cloudImages = Object.freeze({
  "ubuntu-24.04": { label: "Ubuntu 24.04 LTS (Noble)", osVariant: "ubuntu24.04", defaultUser: "ubuntu", url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", sums: "https://cloud-images.ubuntu.com/noble/current/SHA256SUMS", file: "noble-server-cloudimg-amd64.img", algorithm: "sha256" },
  "ubuntu-22.04": { label: "Ubuntu 22.04 LTS (Jammy)", osVariant: "ubuntu22.04", defaultUser: "ubuntu", url: "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img", sums: "https://cloud-images.ubuntu.com/jammy/current/SHA256SUMS", file: "jammy-server-cloudimg-amd64.img", algorithm: "sha256" },
  "debian-13": { label: "Debian 13 (Trixie)", osVariant: "debian12", defaultUser: "debian", url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2", sums: "https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS", file: "debian-13-genericcloud-amd64.qcow2", algorithm: "sha512" },
  "debian-12": { label: "Debian 12 (Bookworm)", osVariant: "debian12", defaultUser: "debian", url: "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2", sums: "https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS", file: "debian-12-genericcloud-amd64.qcow2", algorithm: "sha512" },
});

export function cloudImageIds() { return Object.keys(cloudImages); }

async function digestFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function expectedDigest(sumsText, fileName) {
  for (const line of String(sumsText).split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{64,128})\s+\*?(.+)$/);
    if (match && (match[2] === fileName || match[2].endsWith(`/${fileName}`))) return match[1];
  }
  return null;
}

/**
 * Ensure the base image for `image` is present and verified. Returns `{ path, digest, downloaded }`.
 * Cached by digest: <root>/<id>-<digest12>.img plus a stable symlink-free pointer file <root>/<id>.current.
 */
export async function ensureCloudImage({ image } = {}, { run = fixedRun, log = null, fetchImpl = globalThis.fetch, root = cloudImageRoot } = {}) {
  const spec = cloudImages[image];
  if (!spec) throw new Error(`Unsupported cloud image ${image}`);
  await mkdir(root, { recursive: true, mode: 0o755 });
  log?.(`Fetching checksum list for ${spec.label}`, "stdout");
  const sumsResponse = await fetchImpl(spec.sums);
  if (!sumsResponse.ok) throw new Error(`Could not fetch ${spec.sums} (${sumsResponse.status})`);
  const digest = expectedDigest(await sumsResponse.text(), spec.file);
  if (!digest) throw new Error(`Checksum for ${spec.file} was not found in ${spec.sums}`);
  const target = path.join(root, `${image}-${digest.slice(0, 12)}.img`);
  try {
    const existing = await stat(target);
    if (existing.isFile() && existing.size > 0) {
      log?.(`Base image already present: ${path.basename(target)}`, "stdout");
      await writeFile(path.join(root, `${image}.current`), `${target}\n${digest}\n`, { mode: 0o644 });
      return { path: target, digest, downloaded: false, algorithm: spec.algorithm };
    }
  } catch { /* not present */ }
  const partial = `${target}.part`;
  await unlink(partial).catch(() => {});
  log?.(`Downloading ${spec.url}`, "stdout");
  const download = await run("/usr/bin/curl", ["-fL", "--retry", "3", "--progress-bar", "-o", partial, spec.url], { timeout: 60 * 60_000, onLine: log ?? undefined });
  if (!download.ok) { await unlink(partial).catch(() => {}); throw new Error(`Download failed: ${download.stderr.split("\n").slice(-2).join(" ")}`); }
  log?.("Verifying checksum", "stdout");
  const actual = await digestFile(partial, spec.algorithm);
  if (actual !== digest) { await unlink(partial).catch(() => {}); throw new Error(`Checksum mismatch for ${spec.file}`); }
  await rename(partial, target);
  await writeFile(path.join(root, `${image}.current`), `${target}\n${digest}\n`, { mode: 0o644 });
  log?.(`Base image ready: ${path.basename(target)}`, "stdout");
  return { path: target, digest, downloaded: true, algorithm: spec.algorithm };
}

export const cloudImageInternals = { expectedDigest };
