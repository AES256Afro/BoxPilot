// @vitest-environment node
/**
 * The model server's life (M37): started as the runner's child when a run needs it, its per-start
 * key read from its output and never kept anywhere else, stopped when idle, and a failure to start
 * reported as the model being unavailable. Driven with the fake model as a real child process.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOpenAiClient } from "../assistant/model-client.mjs";
import { ModelUnavailable, createRuntime, findLlamaServer, ownSecret, serverCommand, storedUnslothKey, studioPasswordSetFile } from "./runtime.mjs";

const fakeModelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-model.mjs");

const onWindows = process.platform === "win32";
let scratch;
beforeAll(async () => { scratch = await mkdtemp(path.join(os.tmpdir(), "boxpilot-runtime-")); });
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

const client = createOpenAiClient({ loopbackOnly: true });
const runtimes = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop("test over"))); });
const make = (options = {}) => { const runtime = createRuntime({ client, pollMs: 100, ...options }); runtimes.push(runtime); return runtime; };

describe("the command that serves a model", () => {
  it("is the spike's unsloth run: loopback, tools off, the cap's threads, the context pinned for the reload, offline", () => {
    const { command, args, env } = serverCommand({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", contextTokens: 8192, threads: 4 }, { port: 18888, runtimeDir: "/var/lib/boxpilot-agents/unsloth", stateDir: "/var/lib/boxpilot-agents", secrets: { studioPassword: "p".repeat(32) } });
    expect(command.replaceAll("\\", "/")).toBe("/var/lib/boxpilot-agents/unsloth/bin/unsloth");
    // Batches of 512 so a call given up on stops soon; a gigabyte of prompt cache inside the memory cap.
    expect(args).toEqual(["run", "--model", "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", "--api-only", "--disable-tools", "-H", "127.0.0.1", "-p", "18888",
      "--context-length", "8192", "--parallel", "1", "--threads", "4", "-c", "8192", "--ctx-checkpoints", "4", "--batch-size", "512", "--cache-ram", "1024"]);
    expect(env).toMatchObject({ HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK: "1", UNSLOTH_MODEL_IDLE_TTL: "900", UNSLOTH_STUDIO_PASSWORD: "p".repeat(32) });
    expect(env.HF_HOME.replaceAll("\\", "/")).toBe("/var/lib/boxpilot-agents/hf");
    expect(env.UNSLOTH_STUDIO_HOME.replaceAll("\\", "/")).toBe("/var/lib/boxpilot-agents/unsloth");
  });

  it("never starts Unsloth without Studio's password, so it cannot make and print its own, and passes it only until Studio has it", () => {
    expect(() => serverCommand({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL" }, { port: 1, runtimeDir: "/", stateDir: "/" })).toThrow(ModelUnavailable);
    const later = serverCommand({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL" }, { port: 1, runtimeDir: "/", stateDir: "/", secrets: { studioPassword: "p".repeat(32), studioPasswordSet: true } });
    expect(later.env.UNSLOTH_STUDIO_PASSWORD).toBeUndefined();
  });

  it("serves llama.cpp's own server when the owner chose it: loopback, a key from a file, the files it was handed", () => {
    const { command, args } = serverCommand({ driver: "llama-server", requestModel: "unsloth/Qwen3.5-4B-GGUF", contextTokens: 8192, threads: 4 }, {
      port: 18889, runtimeDir: "/r", stateDir: "/s", secrets: { apiKeyFile: "/s/llama-server.key" },
      files: { binary: "/r/bin/llama-server", model: "/s/hf/hub/m/snapshots/c/model.gguf", projector: "/s/hf/hub/m/snapshots/c/mmproj-F16.gguf" },
    });
    expect(command).toBe("/r/bin/llama-server");
    expect(args).toEqual(["-m", "/s/hf/hub/m/snapshots/c/model.gguf", "--mmproj", "/s/hf/hub/m/snapshots/c/mmproj-F16.gguf", "--alias", "unsloth/Qwen3.5-4B-GGUF",
      "--host", "127.0.0.1", "--port", "18889", "-c", "8192", "--parallel", "1", "--threads", "4", "--ctx-checkpoints", "4", "--batch-size", "512", "--cache-ram", "1024", "--jinja", "--no-webui", "--api-key-file", "/s/llama-server.key"]);
    expect(args.join(" ")).not.toContain("0.0.0.0");
  });

  it("refuses a model spec that could be anything else", () => {
    expect(() => serverCommand({ driver: "unsloth", model: "x; rm -rf /" }, { port: 1, runtimeDir: "/", stateDir: "/" })).toThrow(ModelUnavailable);
    expect(() => serverCommand({ driver: "external" }, { port: 1, runtimeDir: "/", stateDir: "/" })).toThrow(ModelUnavailable);
  });
});

describe("starting and stopping", () => {
  it("starts the model on demand, reads its key, reuses it, and stops it when idle", async () => {
    let clock = 0;
    const runtime = make({ now: () => clock });
    const model = await runtime.ensure({ driver: "fake", model: null, idleStopMs: 60_000 });
    expect(model.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(model.apiKey).toMatch(/^sk-fake-/);
    expect(model.model).toBe("fake/qwen-agent");
    expect(runtime.status()).toMatchObject({ state: "running", modelLoaded: true });
    const pid = runtime.status().pid;
    expect(await runtime.ensure({ driver: "fake", model: null, idleStopMs: 60_000 })).toMatchObject({ endpoint: model.endpoint, loadMs: 0 });
    expect(runtime.status().pid).toBe(pid);
    clock += 30_000;
    await runtime.maybeStopIdle();
    expect(runtime.status().state).toBe("running");
    clock += 31_000;
    await runtime.maybeStopIdle();
    expect(runtime.status()).toMatchObject({ state: "idle", modelLoaded: false, pid: null });
  }, 30_000);

  it("says the model is unavailable when its server cannot start", async () => {
    const runtime = make({ runtimeDir: "/nonexistent/unsloth", stateDir: scratch });
    await expect(runtime.ensure({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL" })).rejects.toBeInstanceOf(ModelUnavailable);
    expect(runtime.status().state).toBe("idle");
  });

  it("gives Studio its admin password only until it has one, and starts again without it when Studio already has one", async () => {
    // A stand-in for `unsloth run`: like Unsloth 2026.9.12, it refuses to start when handed a
    // password once one is set, and otherwise serves the fake model and prints its key.
    const stateDir = await mkdtemp(path.join(scratch, "studio-state-"));
    const studio = path.join(stateDir, "studio.mjs");
    await writeFile(studio, [
      `import { startFakeModel } from ${JSON.stringify(pathToFileURL(fakeModelPath).href)};`,
      "const args = process.argv.slice(2);",
      "if (process.env.UNSLOTH_STUDIO_PASSWORD && process.env.STUDIO_HAS_PASSWORD === '1') { console.error(\"Error: an Unsloth admin password is already set; --password only sets the initial password.\"); process.exit(1); }",
      "const fake = await startFakeModel({ port: Number(args[args.indexOf('-p') + 1]), apiKey: 'sk-unsloth-' + 'k'.repeat(24) });",
      "console.log('API Key: ' + fake.apiKey);",
    ].join("\n"));
    const started = [];
    const spawn = (_command, args, options) => { started.push(options.env); return spawnProcess(process.execPath, [studio, ...args], { ...options, env: { ...options.env, STUDIO_HAS_PASSWORD: "1" } }); };
    const runtime = make({ spawn, stateDir, runtimeDir: path.join(stateDir, "unsloth") });
    const unsloth = { driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", threads: 4 };
    // The owner's server: the password was set by an earlier start, before BoxPilot kept track.
    expect((await runtime.ensure(unsloth)).apiKey).toBe(`sk-unsloth-${"k".repeat(24)}`);
    expect(started.map((env) => Boolean(env.UNSLOTH_STUDIO_PASSWORD))).toEqual([true, false]);
    expect((await stat(path.join(stateDir, studioPasswordSetFile))).isFile()).toBe(true);
    // After an idle stop, the next start passes no password at all.
    await runtime.stop("idle");
    await runtime.ensure(unsloth);
    expect(started.map((env) => Boolean(env.UNSLOTH_STUDIO_PASSWORD))).toEqual([true, false, false]);
  }, 30_000);

  it("asks the model server it started whether it can see, with the start's key, once a start (M40.6)", async () => {
    // A stand-in for `unsloth run` that answers Studio's status as Unsloth does: is_vision, and why
    // it started without its projector when that failed.
    const stateDir = await mkdtemp(path.join(scratch, "studio-vision-"));
    const studio = path.join(stateDir, "studio.mjs");
    await writeFile(studio, [
      `import { startFakeModel } from ${JSON.stringify(pathToFileURL(fakeModelPath).href)};`,
      "const args = process.argv.slice(2);",
      "const blind = process.env.STUDIO_BLIND === '1';",
      "const fake = await startFakeModel({ port: Number(args[args.indexOf('-p') + 1]), apiKey: 'sk-unsloth-' + 'v'.repeat(24), vision: !blind, mmprojFallback: blind ? 'mmproj_load_failed' : null, statusLoaded: process.env.STUDIO_LOADING !== '1' });",
      "console.log('API Key: ' + fake.apiKey);",
      "if (!blind) console.log(JSON.stringify({ level: 'info', event: 'Using mmproj for vision: /var/lib/boxpilot-agents/hf/hub/mmproj-F16.gguf' }));",
    ].join("\n"));
    let blind = "0";
    let loading = "0";
    const spawn = (_command, args, options) => spawnProcess(process.execPath, [studio, ...args], { ...options, env: { ...options.env, STUDIO_BLIND: blind, STUDIO_LOADING: loading } });
    const runtime = make({ spawn, stateDir, runtimeDir: path.join(stateDir, "unsloth") });
    const unsloth = { driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", threads: 4 };
    expect(await runtime.vision()).toBeNull();
    // What the real Studio did on agents-bench: status answered while the model was still loading
    // (no model listed) with is_vision false, although it had started llama-server with --mmproj.
    // That is no answer: nothing is kept, and the image is tried.
    loading = "1";
    await runtime.ensure(unsloth);
    expect(await runtime.vision()).toEqual({ vision: null, reason: "the model server's status named no loaded model yet" });
    expect(runtime.status().vision).toBeNull();
    await runtime.stop("test");
    loading = "0";
    await runtime.ensure(unsloth);
    // A 401 would be "did not say": this answer came with the key the start printed.
    expect(await runtime.vision()).toEqual({ vision: true, reason: null });
    expect(runtime.status().vision).toEqual({ vision: true, reason: null });
    await runtime.stop("test");
    blind = "1";
    await runtime.ensure(unsloth);
    expect(await runtime.vision()).toEqual({ vision: false, reason: "it started without its vision projector (mmproj load failed)" });

    // The fake driver, started blind, says so the same way.
    const fake = make({ fake: { vision: false } });
    await fake.ensure({ driver: "fake", model: null });
    expect(await fake.vision()).toEqual({ vision: false, reason: "the model was loaded without its vision projector" });
  }, 30_000);

  it("only checks a model server someone else runs, and never starts one", async () => {
    const runtime = make();
    await expect(runtime.ensure({ driver: "external", endpoint: null })).rejects.toMatchObject({ reason: "no-model" });
    await expect(runtime.ensure({ driver: "external", endpoint: "http://127.0.0.1:9" })).rejects.toBeInstanceOf(ModelUnavailable);
  });
});

describe("the secrets it keeps", () => {
  it.skipIf(onWindows)("makes Studio's password once, owner-only, and reads the same one after", async () => {
    const file = path.join(scratch, "studio-password");
    const first = await ownSecret(file);
    expect(first.length).toBeGreaterThanOrEqual(20);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await ownSecret(file)).toBe(first);
  });

  it.skipIf(onWindows)("refuses a secret that is a link rather than a file", async () => {
    await writeFile(path.join(scratch, "elsewhere"), "x".repeat(40));
    await symlink(path.join(scratch, "elsewhere"), path.join(scratch, "linked-password"));
    await expect(ownSecret(path.join(scratch, "linked-password"))).rejects.toBeInstanceOf(ModelUnavailable);
    expect(await readFile(path.join(scratch, "elsewhere"), "utf8")).toBe("x".repeat(40));
  });

  it("reads the key Studio kept when its output did not say it, and nothing shaped otherwise", async () => {
    const runtimeDir = path.join(scratch, "studio");
    await mkdir(path.join(runtimeDir, "auth"), { recursive: true });
    expect(await storedUnslothKey(runtimeDir)).toBeNull();
    await writeFile(path.join(runtimeDir, "auth", ".cli_api_key_a"), "not a key\n");
    expect(await storedUnslothKey(runtimeDir)).toBeNull();
    await writeFile(path.join(runtimeDir, "auth", ".cli_api_key_b"), "sk-unsloth-abcdefghijkl\n");
    expect(await storedUnslothKey(runtimeDir)).toBe("sk-unsloth-abcdefghijkl");
  });

  it("finds llama-server in the install, and says so when it is not there", async () => {
    const runtimeDir = path.join(scratch, "install");
    await expect(findLlamaServer(runtimeDir, { override: null })).rejects.toMatchObject({ reason: "no-model" });
    await mkdir(path.join(runtimeDir, "llama.cpp", "build", "bin"), { recursive: true });
    await writeFile(path.join(runtimeDir, "llama.cpp", "build", "bin", "llama-server"), "");
    expect((await findLlamaServer(runtimeDir, { override: null })).replaceAll("\\", "/").endsWith("llama.cpp/build/bin/llama-server")).toBe(true);
  });
});
