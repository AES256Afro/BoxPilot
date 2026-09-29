// @vitest-environment node
/**
 * The model server's life (M37): started as the runner's child when a run needs it, its per-start
 * key read from its output and never kept anywhere else, stopped when idle, and a failure to start
 * reported as the model being unavailable. Driven with the fake model as a real child process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiClient } from "../assistant/model-client.mjs";
import { ModelUnavailable, createRuntime, serverCommand } from "./runtime.mjs";

const client = createOpenAiClient({ loopbackOnly: true });
const runtimes = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop("test over"))); });
const make = (options = {}) => { const runtime = createRuntime({ client, pollMs: 100, ...options }); runtimes.push(runtime); return runtime; };

describe("the command that serves a model", () => {
  it("is unsloth run on loopback with the model, context and threads, offline", () => {
    const { command, args, env } = serverCommand({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", contextTokens: 8192, threads: 2 }, { port: 18888, runtimeDir: "/opt/boxpilot-agents/unsloth", stateDir: "/var/lib/boxpilot-agents" });
    expect(command.replaceAll("\\", "/")).toBe("/opt/boxpilot-agents/unsloth/bin/unsloth");
    expect(args).toEqual(["run", "--model", "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL", "--api-only", "--disable-tools", "-H", "127.0.0.1", "-p", "18888", "--context-length", "8192", "--parallel", "1", "--threads", "2"]);
    expect(env).toMatchObject({ HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" });
    expect(env.HF_HOME.replaceAll("\\", "/")).toBe("/var/lib/boxpilot-agents/hf");
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
    const runtime = make({ runtimeDir: "/nonexistent/unsloth" });
    await expect(runtime.ensure({ driver: "unsloth", model: "unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL" })).rejects.toBeInstanceOf(ModelUnavailable);
    expect(runtime.status().state).toBe("idle");
  });

  it("only checks a model server someone else runs, and never starts one", async () => {
    const runtime = make();
    await expect(runtime.ensure({ driver: "external", endpoint: null })).rejects.toMatchObject({ reason: "no-model" });
    await expect(runtime.ensure({ driver: "external", endpoint: "http://127.0.0.1:9" })).rejects.toBeInstanceOf(ModelUnavailable);
  });
});
