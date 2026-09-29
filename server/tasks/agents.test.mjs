// @vitest-environment node
/**
 * The agents runtime's root tasks (M37), against a temporary directory and a stand-in for Hugging
 * Face: a model is kept only when every byte matches its published checksum, downloads come only
 * from Hugging Face, the model in use is never removed, and the runner cannot start without its key.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { agentsEnable, agentsInstall, agentsModelDownload, agentsModelRemove } from "./agents.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function pathsFor() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-agents-task-"));
  directories.push(root);
  const paths = { home: path.join(root, "opt"), runtime: path.join(root, "opt", "unsloth"), state: path.join(root, "state"), token: path.join(root, "token"), user: "boxpilot-agents" };
  await mkdir(paths.state, { recursive: true });
  return paths;
}
const okRun = async () => ({ ok: true, stdout: "", stderr: "" });

const repo = "unsloth/Qwen3.5-4B-GGUF";
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
        { rfilename: "Qwen3.5-4B-UD-Q4_K_XL.gguf", lfs: { sha256: sha(model), size: model.length } },
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
    const paths = await pathsFor();
    const { fetcher, requested } = huggingFace();
    const result = await agentsModelDownload({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" }, { run: okRun, fetcher, paths });
    expect(result).toMatchObject({ repo, quant: "UD-Q4_K_XL", commit, bytes: model.length + projector.length, downloaded: ["Qwen3.5-4B-UD-Q4_K_XL.gguf", "mmproj-F16.gguf"] });
    const base = path.join(paths.state, "hf", "hub", "models--unsloth--Qwen3.5-4B-GGUF");
    expect(await readFile(path.join(base, "refs", "main"), "utf8")).toBe(commit);
    const link = path.join(base, "snapshots", commit, "Qwen3.5-4B-UD-Q4_K_XL.gguf");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.join("..", "..", "blobs", sha(model)));
    expect(await readFile(link)).toEqual(model);
    expect(requested.every((url) => url.startsWith("https://huggingface.co/"))).toBe(true);
    expect(requested).toContain(`https://huggingface.co/${repo}/resolve/${commit}/Qwen3.5-4B-UD-Q4_K_XL.gguf`);
    // Again: nothing is fetched twice.
    const again = await agentsModelDownload({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" }, { run: okRun, fetcher, paths });
    expect(again.downloaded).toEqual([]);
  });

  it("keeps nothing that does not match its checksum", async () => {
    const paths = await pathsFor();
    const tampered = Buffer.from(model);
    tampered[3] ^= 1;
    await expect(agentsModelDownload({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" }, { run: okRun, fetcher: huggingFace({ modelBody: tampered }).fetcher, paths })).rejects.toThrow(/did not match its SHA-256/);
    const blobs = await readdir(path.join(paths.state, "hf", "hub", "models--unsloth--Qwen3.5-4B-GGUF", "blobs"));
    expect(blobs).toEqual([]);
  });

  it("downloads only from Hugging Face, and only Unsloth's Qwen repositories", async () => {
    const paths = await pathsFor();
    await expect(agentsModelDownload({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" }, { run: okRun, fetcher: huggingFace({ finalUrl: "https://evil.example/model.gguf" }).fetcher, paths })).rejects.toThrow(/Refused a download from evil.example/);
    await expect(agentsModelDownload({ repo: "someone/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" }, { run: okRun, fetcher: huggingFace().fetcher, paths })).rejects.toThrow(/Only Unsloth's Qwen/);
    await expect(agentsModelDownload({ repo, file: "missing-Q4_K_M.gguf" }, { run: okRun, fetcher: huggingFace().fetcher, paths })).rejects.toThrow(/has no missing-Q4_K_M.gguf/);
  });
});

describe("removing a model", () => {
  it("never removes the model in use", async () => {
    const paths = await pathsFor();
    await expect(agentsModelRemove({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", current: `${repo}/Qwen3.5-4B-UD-Q4_K_XL.gguf` }, { paths })).rejects.toThrow(/agents use now/);
    expect(await agentsModelRemove({ repo, file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", current: `${repo}/other-Q4_K_M.gguf` }, { paths })).toMatchObject({ removed: [] });
  });
});

describe("the runner unit", () => {
  it("is not started before Agents were turned on and the runner has its key", async () => {
    const paths = await pathsFor();
    await expect(agentsEnable({}, { run: okRun, paths })).rejects.toThrow(/Turn Agents on/);
    await writeFile(paths.token, "k".repeat(43));
    const calls = [];
    const run = async (binary, args) => { calls.push([path.basename(binary), ...args]); return { ok: true, stdout: args[0] === "is-active" ? "active" : "", stderr: "" }; };
    expect(await agentsEnable({}, { run, paths })).toEqual({ unit: "boxpilot-agents.service", active: true });
    expect(calls).toContainEqual(["systemctl", "enable", "--now", "boxpilot-agents.service"]);
  });
});

describe("installing Unsloth", () => {
  it("runs Unsloth's installer as the runner's user, never as root, and refuses anything that is not a script", async () => {
    const paths = await pathsFor();
    const calls = [];
    const run = async (binary, args) => { calls.push([path.basename(binary), ...args]); return { ok: true, stdout: "unsloth 2026.9", stderr: "" }; };
    await expect(agentsInstall({}, { run, paths, fetcher: async () => new Response("<html>not a script</html>") })).rejects.toThrow(/did not look like a shell script/);
    const result = await agentsInstall({}, { run, paths, fetcher: async () => new Response("#!/bin/sh\necho installing\n") });
    expect(result).toMatchObject({ installed: true, installerSha256: sha(Buffer.from("#!/bin/sh\necho installing\n")) });
    const installer = calls.find(([binary]) => binary === "runuser");
    expect(installer.slice(0, 4)).toEqual(["runuser", "-u", "boxpilot-agents", "--"]);
    expect(installer).toContain("UNSLOTH_NO_TORCH=1");
    // Read-only to the runner afterwards.
    expect(calls).toContainEqual(["chown", "-R", "root:root", paths.runtime]);
  });
});
