/**
 * Fetching a model into the runner's Hugging Face cache (M37), run as the runner's own user - never
 * as root - by scripts/boxpilot-agents-download.mjs, which the root task agents.model.download starts
 * with runuser (the task has the network; the runner does not). The cache is the runner's, so a
 * root process writing into it could be steered by a link planted there; its own user cannot be
 * steered anywhere it could not already write.
 *
 * Only Unsloth's Qwen GGUF repositories, only from huggingface.co and its download hosts, every
 * byte checked against the SHA-256 Hugging Face publishes, free space checked first; a file that
 * does not match is not kept. The layout is the one `unsloth run` reads offline:
 * hub/models--<org>--<name>/{blobs/<sha256>, snapshots/<commit>/<file> -> ../../blobs/<sha256>, refs/main}.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readlink, rename, rm, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cacheDirectory, cachedFile, readModelParameters } from "./host.mjs";

const trustedHosts = /(^|\.)(huggingface\.co|hf\.co)$/;

/** Fetch one URL over HTTPS from Hugging Face, following redirects only to its own hosts. */
export async function fetchFromHub(url, { fetcher = fetch, timeoutMs = 60_000 } = {}) {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "BoxPilot agents runtime" } });
  const final = new URL(response.url || url);
  if (final.protocol !== "https:" || !trustedHosts.test(final.hostname)) throw new Error(`Refused a download from ${final.hostname}`);
  if (!response.ok) throw new Error(`${final.hostname} answered ${response.status}`);
  return response;
}

/** Stream a URL to a new file, hashing as it goes; the file is kept only when size and hash match. */
async function downloadVerified(url, target, { size, sha256, fetcher, log, label }) {
  const response = await fetchFromHub(url, { fetcher, timeoutMs: 6 * 3600_000 });
  if (!response.body) throw new Error(`No body for ${label}`);
  const partial = `${target}.incomplete`;
  await unlink(partial).catch(() => {});
  const hash = createHash("sha256");
  let received = 0;
  let nextReport = 0.05;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (received > size) { callback(new Error(`${label} is larger than Hugging Face said`)); return; }
      if (received / size >= nextReport) { log(`${label}: ${Math.floor((received / size) * 100)}% of ${(size / 1e9).toFixed(2)} GB`); nextReport += 0.05; }
      callback(null, chunk);
    },
  });
  try {
    // "wx": a new file, never an existing one or whatever a link at that name points to.
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial, { flags: "wx", mode: 0o644 }));
    const digest = hash.digest("hex");
    if (received !== size) throw new Error(`${label} arrived with ${received} bytes, not ${size}`);
    if (digest !== sha256) throw new Error(`${label} did not match its SHA-256; it was not kept`);
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

export async function downloadModel(parameters, { stateDir, fetcher = fetch, log = () => {} }) {
  const model = readModelParameters(parameters);
  const info = await (await fetchFromHub(`https://huggingface.co/api/models/${model.repo}/revision/main?blobs=true`, { fetcher })).json();
  const commit = typeof info?.sha === "string" && /^[a-f0-9]{40}$/.test(info.sha) ? info.sha : null;
  if (!commit) throw new Error("Hugging Face did not say which revision is current");
  const siblings = new Map((Array.isArray(info.siblings) ? info.siblings : []).map((entry) => [entry?.rfilename, entry]));
  const wanted = [model.file, ...(model.projector ? [model.projector] : [])].map((file) => {
    const entry = siblings.get(file);
    const sha256 = entry?.lfs?.sha256 ?? entry?.lfs?.oid;
    const size = entry?.lfs?.size ?? entry?.size;
    if (!entry || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !Number.isInteger(size) || size <= 0) throw new Error(`${model.repo} has no ${file} with a published checksum`);
    return { file, sha256, size };
  });
  const base = cacheDirectory(stateDir, model.repo);
  await mkdir(path.join(base, "blobs"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(base, "snapshots", commit), { recursive: true, mode: 0o755 });
  await mkdir(path.join(base, "refs"), { recursive: true, mode: 0o755 });
  const missing = [];
  for (const entry of wanted) {
    const have = await stat(path.join(base, "blobs", entry.sha256)).catch(() => null);
    if (have?.size === entry.size) { log(`${entry.file} is already downloaded`); continue; }
    missing.push(entry);
  }
  const needed = missing.reduce((sum, entry) => sum + entry.size, 0);
  const free = await statfs(stateDir).then((fs) => fs.bavail * fs.bsize, () => null);
  if (free !== null && needed * 1.1 + 2e9 > free) throw new Error(`Not enough space: ${(needed / 1e9).toFixed(1)} GB to download and ${(free / 1e9).toFixed(1)} GB free`);
  for (const entry of missing) {
    await downloadVerified(`https://huggingface.co/${model.repo}/resolve/${commit}/${encodeURIComponent(entry.file)}`, path.join(base, "blobs", entry.sha256), { size: entry.size, sha256: entry.sha256, fetcher, log, label: entry.file });
  }
  for (const entry of wanted) {
    const link = path.join(base, "snapshots", commit, entry.file);
    const target = path.join("..", "..", "blobs", entry.sha256);
    const current = await readlink(link).catch(() => null);
    if (current !== target) { await unlink(link).catch(() => {}); await symlink(target, link); }
  }
  await writeFile(path.join(base, "refs", "main"), commit, { mode: 0o644 });
  return { ...model, commit, bytes: wanted.reduce((sum, entry) => sum + entry.size, 0), downloaded: missing.map((entry) => entry.file) };
}

export async function removeModel(parameters, { stateDir }) {
  const model = readModelParameters(parameters);
  if (parameters.current === `${model.repo}/${model.file}`) throw new Error("That is the model agents use now; switch to another first");
  const removed = [];
  for (const file of [model.file, ...(model.projector ? [model.projector] : [])]) {
    const found = await cachedFile(stateDir, model.repo, file);
    if (!found) continue;
    await rm(found.path, { force: true });
    await rm(path.join(cacheDirectory(stateDir, model.repo), "snapshots", found.commit, file), { force: true });
    removed.push(file);
  }
  return { ...model, removed };
}
