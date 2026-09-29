// @vitest-environment node
/**
 * Fetching a model into the runner's Hugging Face cache (M37), against a temporary directory and a
 * stand-in for Hugging Face: a model is kept only when every byte matches its published checksum,
 * downloads come only from Hugging Face, the model in use is never removed, and a link in the cache
 * that points anywhere but the cache's own blobs is not taken for a model.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { downloadModel, removeModel } from "./download.mjs";
import { cachedFile, checkDownloaded, listCachedModels } from "./host.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function stateDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-agents-download-"));
  directories.push(root);
  return root;
}

const repo = "unsloth/Qwen3.5-4B-GGUF";
const file = "Qwen3.5-4B-UD-Q4_K_XL.gguf";
const model = Buffer.from("GGUF model bytes ".repeat(64));
const projector = Buffer.from("GGUF projector bytes ".repeat(16));
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const commit = "a".repeat(40);

function huggingFace({ modelBody = model, finalUrl = null } = {}) {
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    let response;
    if (url.includes("/api/models/")) {
      response = new Response(JSON.stringify({ sha: commit, siblings: [
        { rfilename: file, lfs: { sha256: sha(model), size: model.length } },
        { rfilename: "mmproj-F16.gguf", lfs: { sha256: sha(projector), size: projector.length } },
        { rfilename: "README.md" },
      ] }), { headers: { "Content-Type": "application/json" } });
    } else if (url.endsWith("mmproj-F16.gguf")) response = new Response(projector);
    else response = new Response(modelBody);
    if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
    return response;
  };
  return { fetcher, requested };
}

describe("downloading a model", () => {
  it.skipIf(onWindows)("puts it in the Hugging Face cache layout Unsloth reads offline, each file checked", async () => {
    const dir = await stateDir();
    const { fetcher, requested } = huggingFace();
    const result = await downloadModel({ repo, file, projector: "mmproj-F16.gguf" }, { stateDir: dir, fetcher });
    expect(result).toMatchObject({ repo, quant: "UD-Q4_K_XL", commit, bytes: model.length + projector.length, downloaded: [file, "mmproj-F16.gguf"] });
    const base = path.join(dir, "hf", "hub", "models--unsloth--Qwen3.5-4B-GGUF");
    expect(await readFile(path.join(base, "refs", "main"), "utf8")).toBe(commit);
    const link = path.join(base, "snapshots", commit, file);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join("..", "..", "blobs", sha(model)));
    expect(await readFile(link)).toEqual(model);
    expect(requested.every((url) => url.startsWith("https://huggingface.co/"))).toBe(true);
    expect(requested).toContain(`https://huggingface.co/${repo}/resolve/${commit}/${file}`);
    // What agents.model.switch and the Agents section read back.
    expect(await checkDownloaded({ repo, file, projector: "mmproj-F16.gguf" }, { paths: { state: dir } })).toMatchObject({ repo, file, commit, bytes: model.length });
    expect(await listCachedModels(dir)).toEqual(expect.arrayContaining([expect.objectContaining({ repo, file, complete: true, projector: false })]));
    // Again: nothing is fetched twice.
    const again = await downloadModel({ repo, file, projector: "mmproj-F16.gguf" }, { stateDir: dir, fetcher });
    expect(again.downloaded).toEqual([]);
  });

  it("keeps nothing that does not match its checksum", async () => {
    const dir = await stateDir();
    const tampered = Buffer.from(model);
    tampered[3] ^= 1;
    await expect(downloadModel({ repo, file }, { stateDir: dir, fetcher: huggingFace({ modelBody: tampered }).fetcher })).rejects.toThrow(/did not match its SHA-256/);
    expect(await readdir(path.join(dir, "hf", "hub", "models--unsloth--Qwen3.5-4B-GGUF", "blobs"))).toEqual([]);
  });

  it("downloads only from Hugging Face, and only Unsloth's Qwen repositories", async () => {
    const dir = await stateDir();
    await expect(downloadModel({ repo, file }, { stateDir: dir, fetcher: huggingFace({ finalUrl: "https://evil.example/model.gguf" }).fetcher })).rejects.toThrow(/Refused a download from evil.example/);
    await expect(downloadModel({ repo: "someone/Qwen3.5-4B-GGUF", file }, { stateDir: dir, fetcher: huggingFace().fetcher })).rejects.toThrow(/Only Unsloth's Qwen/);
    await expect(downloadModel({ repo, file: "missing-Q4_K_M.gguf" }, { stateDir: dir, fetcher: huggingFace().fetcher })).rejects.toThrow(/has no missing-Q4_K_M.gguf/);
  });
});

describe("the cache as it is read", () => {
  it.skipIf(onWindows)("takes a file for a model only when its link stays in the cache's own blobs", async () => {
    const dir = await stateDir();
    const base = path.join(dir, "hf", "hub", "models--unsloth--Qwen3.5-4B-GGUF");
    await mkdir(path.join(base, "snapshots", commit), { recursive: true });
    await mkdir(path.join(base, "blobs"), { recursive: true });
    await writeFile(path.join(dir, "outside"), "secret");
    await symlink(path.join(dir, "outside"), path.join(base, "snapshots", commit, file));
    expect(await cachedFile(dir, repo, file)).toBeNull();
    await expect(checkDownloaded({ repo, file }, { paths: { state: dir } })).rejects.toThrow(/not downloaded yet/);
  });
});

describe("removing a model", () => {
  it.skipIf(onWindows)("frees its files, and never removes the model in use", async () => {
    const dir = await stateDir();
    await downloadModel({ repo, file }, { stateDir: dir, fetcher: huggingFace().fetcher });
    await expect(removeModel({ repo, file, current: `${repo}/${file}` }, { stateDir: dir })).rejects.toThrow(/agents use now/);
    expect(await removeModel({ repo, file, current: `${repo}/other-Q4_K_M.gguf` }, { stateDir: dir })).toMatchObject({ removed: [file] });
    expect(await cachedFile(dir, repo, file)).toBeNull();
  });
});
