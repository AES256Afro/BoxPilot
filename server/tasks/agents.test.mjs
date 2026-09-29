// @vitest-environment node
/**
 * The agents runtime's root tasks (M37). Root does only what needs root: everything that touches
 * the runner's own files - installing Unsloth, downloading or removing a model - runs as the runner's
 * user through runuser, with an environment of its own. The runner cannot start without its key.
 * (What the download itself checks is server/agents/download.test.mjs.)
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testedUnslothVersion } from "../agents/models.mjs";
import { agentsDisable, agentsEnable, agentsInstall, agentsModelDownload, agentsModelRemove } from "./agents.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function pathsFor() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-agents-task-"));
  directories.push(root);
  const paths = { state: path.join(root, "state"), runtime: path.join(root, "state", "unsloth"), token: path.join(root, "token"), user: "boxpilot-agents" };
  await mkdir(paths.state, { recursive: true });
  return paths;
}
const okRun = async () => ({ ok: true, stdout: "", stderr: "" });
const repo = "unsloth/Qwen3.5-4B-GGUF";
const file = "Qwen3.5-4B-UD-Q4_K_XL.gguf";

/** A stand-in for the host: records every command, and answers the download script with `answer`. */
function host({ answer = { ok: true, result: { repo, file, downloaded: [file] } }, version = `unsloth ${testedUnslothVersion}` } = {}) {
  const calls = [];
  const run = async (binary, args, options = {}) => {
    calls.push({ binary: path.basename(binary), args, options });
    if (path.basename(binary) === "id") return { ok: true, stdout: "999", stderr: "" };
    if (path.basename(binary) === "runuser" && args.some((arg) => String(arg).endsWith("boxpilot-agents-download.mjs"))) {
      options.onLine?.("Qwen3.5-4B-UD-Q4_K_XL.gguf: 50% of 2.90 GB", "stdout");
      return { ok: answer.ok, stdout: JSON.stringify(answer), stderr: "" };
    }
    if (path.basename(binary) === "runuser" && args.includes("--version")) return { ok: true, stdout: version, stderr: "" };
    return { ok: true, stdout: args[0] === "is-active" ? "active" : "", stderr: "" };
  };
  return { run, calls };
}

describe("downloading and removing a model", () => {
  it("runs as the runner's user with a clean environment, and reports the script's answer", async () => {
    const paths = await pathsFor();
    const { run, calls } = host();
    const lines = [];
    const result = await agentsModelDownload({ repo, file, projector: "mmproj-F16.gguf" }, { run, paths, log: (line) => lines.push(line) });
    expect(result).toEqual({ repo, file, downloaded: [file] });
    const download = calls.find((call) => call.binary === "runuser");
    expect(download.args.slice(0, 5)).toEqual(["-u", "boxpilot-agents", "--", "/usr/bin/env", "-i"]);
    const script = download.args.findIndex((arg) => String(arg).endsWith("boxpilot-agents-download.mjs"));
    expect(download.args.slice(script + 1, script + 3)).toEqual(["download", paths.state]);
    expect(JSON.parse(download.args[script + 3])).toEqual({ repo, file, projector: "mmproj-F16.gguf" });
    expect(lines).toContain("Qwen3.5-4B-UD-Q4_K_XL.gguf: 50% of 2.90 GB");
    // Root made the runner's state directory the runner's, and wrote nothing into it itself.
    expect(calls.find((call) => call.binary === "install").args).toEqual(["-d", "-o", "boxpilot-agents", "-g", "boxpilot-agents", "-m", "0750", paths.state]);
    expect(calls.map((call) => call.binary)).not.toContain("chown");
  });

  it("says why when the script failed, and checks the model's name before anything runs", async () => {
    const paths = await pathsFor();
    await expect(agentsModelDownload({ repo, file }, { run: host({ answer: { ok: false, error: `${file} did not match its SHA-256; it was not kept` } }).run, paths })).rejects.toThrow(/did not match its SHA-256/);
    const { run, calls } = host();
    await expect(agentsModelDownload({ repo: "someone/Qwen3.5-4B-GGUF", file }, { run, paths })).rejects.toThrow(/Only Unsloth's Qwen/);
    await expect(agentsModelDownload({ repo, file: "../../etc/passwd" }, { run, paths })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("never removes the model in use, and hands the rest to the runner's user", async () => {
    const paths = await pathsFor();
    const { run, calls } = host({ answer: { ok: true, result: { repo, file, removed: [file] } } });
    await expect(agentsModelRemove({ repo, file, current: `${repo}/${file}` }, { run, paths })).rejects.toThrow(/agents use now/);
    expect(calls).toEqual([]);
    expect(await agentsModelRemove({ repo, file, current: `${repo}/other-Q4_K_M.gguf` }, { run, paths })).toMatchObject({ removed: [file] });
    const removal = calls.find((call) => call.binary === "runuser");
    expect(removal.args).toContain("remove");
  });
});

describe("the runner unit", () => {
  it("is not started before Agents were turned on and the runner has its key", async () => {
    const paths = await pathsFor();
    await expect(agentsEnable({}, { run: okRun, paths })).rejects.toThrow(/Turn Agents on/);
    await writeFile(paths.token, "k".repeat(43));
    const { run, calls } = host();
    expect(await agentsEnable({}, { run, paths })).toEqual({ unit: "boxpilot-agents.service", active: true });
    expect(calls.map((call) => [call.binary, ...call.args])).toContainEqual(["systemctl", "enable", "--now", "boxpilot-agents.service"]);
  });

  it("stops and disables it", async () => {
    const { run, calls } = host();
    expect(await agentsDisable({}, { run })).toMatchObject({ unit: "boxpilot-agents.service" });
    expect(calls.map((call) => [call.binary, ...call.args])).toContainEqual(["systemctl", "disable", "--now", "boxpilot-agents.service"]);
  });
});

describe("installing Unsloth", () => {
  const script = "#!/bin/sh\necho installing\n";

  it("runs Unsloth's installer as the runner's user into its state, GGUF-only, and never as root", async () => {
    const paths = await pathsFor();
    const { run, calls } = host();
    await expect(agentsInstall({}, { run, paths, fetcher: async () => new Response("<html>not a script</html>") })).rejects.toThrow(/did not look like a shell script/);
    const result = await agentsInstall({}, { run, paths, fetcher: async () => new Response(script) });
    expect(result).toMatchObject({ installed: true, tested: true, testedVersion: testedUnslothVersion, installerSha256: createHash("sha256").update(script).digest("hex") });
    const apt = calls.find((call) => call.binary === "apt-get");
    expect(apt.args).toContain("libgomp1");
    const installer = calls.find((call) => call.binary === "runuser" && call.args.includes("/bin/sh"));
    expect(installer.args.slice(0, 5)).toEqual(["-u", "boxpilot-agents", "--", "/usr/bin/env", "-i"]);
    expect(installer.args).toEqual(expect.arrayContaining(["UNSLOTH_NO_TORCH=1", "UNSLOTH_SKIP_AUTOSTART=1", `UNSLOTH_STUDIO_HOME=${paths.runtime}`, `HOME=${paths.state}`]));
    // Nothing of the runner's is run or written by root.
    const asRoot = calls.filter((call) => call.binary !== "runuser").map((call) => call.binary);
    for (const binary of ["sh", "unsloth", "chown", "node"]) expect(asRoot).not.toContain(binary);
  });

  it("says when the release it installed is not the one BoxPilot was measured with, and installs it anyway", async () => {
    const paths = await pathsFor();
    const warnings = [];
    const result = await agentsInstall({}, { run: host({ version: "unsloth 2026.10.3" }).run, paths, fetcher: async () => new Response(script), log: (line, stream) => { if (stream === "stderr") warnings.push(line); } });
    expect(result).toMatchObject({ installed: true, tested: false, version: "unsloth 2026.10.3" });
    expect(warnings.join(" ")).toContain(testedUnslothVersion);
  });

  it("takes the installer only from Unsloth over HTTPS", async () => {
    const paths = await pathsFor();
    const moved = new Response(script);
    Object.defineProperty(moved, "url", { value: "https://evil.example/install.sh" });
    await expect(agentsInstall({}, { run: host().run, paths, fetcher: async () => moved })).rejects.toThrow(/Refused the installer from evil.example/);
  });
});
