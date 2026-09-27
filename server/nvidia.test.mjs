import { describe, expect, it } from "vitest";
import { createNvidiaInspector, dockerHasNvidiaRuntime, nvidiaNextStep, parseNvidiaSmi } from "./nvidia.mjs";

const pci = {
  "0000:01:00.0": { vendor: "0x10de\n", class: "0x030000\n" }, // RTX 4080 (VGA)
  "0000:01:00.1": { vendor: "0x10de\n", class: "0x040300\n" }, // its HDMI audio function
  "0000:00:02.0": { vendor: "0x8086\n", class: "0x030000\n" }, // Intel iGPU
};

function fakeHost({ smi = null, driver = null, toolkit = null, runtimes = '{"io.containerd.runc.v2":{},"runc":{}}' } = {}) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary.endsWith("nvidia-smi")) return smi ? { ok: true, stdout: smi } : { ok: false, stdout: "" };
    if (binary.endsWith("dpkg-query")) return toolkit ? { ok: true, stdout: `install ok installed\t${toolkit}` } : { ok: false, stdout: "" };
    if (binary.endsWith("docker")) return runtimes === null ? { ok: false, stdout: "" } : { ok: true, stdout: runtimes };
    return { ok: false, stdout: "" };
  };
  const listDirectory = async () => Object.keys(pci);
  const readText = async (file) => {
    if (file === "/proc/driver/nvidia/version") { if (driver) return driver; throw new Error("ENOENT"); }
    const [, address, field] = /devices\/([^/]+)\/(vendor|class)$/.exec(file) ?? [];
    if (pci[address]) return pci[address][field];
    throw new Error("ENOENT");
  };
  return { run, listDirectory, readText, calls };
}

describe("nvidia parsing", () => {
  it("reads docker runtimes and nvidia-smi rows", () => {
    expect(dockerHasNvidiaRuntime('{"nvidia":{"path":"nvidia-container-runtime"},"runc":{}}')).toBe(true);
    expect(dockerHasNvidiaRuntime('{"runc":{}}')).toBe(false);
    expect(dockerHasNvidiaRuntime("not json")).toBe(false);
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4080, 16376, 570.86.15\n")).toEqual([{ name: "NVIDIA GeForce RTX 4080", memoryGiB: 16, driverVersion: "570.86.15" }]);
  });
});

describe("nvidia inspection", () => {
  it("sees a card with no driver", async () => {
    const state = await createNvidiaInspector(fakeHost()).inspect();
    expect(state).toMatchObject({ present: true, pciDevices: ["0000:01:00.0"], driverLoaded: false, toolkitInstalled: false, dockerRuntime: false, ready: false });
    expect(nvidiaNextStep(state)).toContain("ubuntu-drivers install");
  });

  it("walks the owner through toolkit and runtime", async () => {
    const withDriver = await createNvidiaInspector(fakeHost({ smi: "NVIDIA GeForce RTX 4080, 16376, 570.86.15", driver: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  570.86.15" })).inspect();
    expect(withDriver).toMatchObject({ driverLoaded: true, driverVersion: "570.86.15", ready: false });
    expect(nvidiaNextStep(withDriver)).toContain("Container Toolkit");
    const withToolkit = await createNvidiaInspector(fakeHost({ smi: "RTX, 8192, 570", toolkit: "1.17.8-1" })).inspect();
    expect(nvidiaNextStep(withToolkit)).toContain("nvidia-ctk runtime configure");
  });

  it("is ready when Docker has the nvidia runtime", async () => {
    const state = await createNvidiaInspector(fakeHost({ smi: "RTX, 16376, 570", toolkit: "1.17.8-1", runtimes: '{"nvidia":{},"runc":{}}' })).inspect();
    expect(state.ready).toBe(true);
    expect(nvidiaNextStep(state)).toBeNull();
  });

  it("reports nothing to do without an NVIDIA card", async () => {
    const host = fakeHost();
    const state = await createNvidiaInspector({ ...host, listDirectory: async () => ["0000:00:02.0"] }).inspect();
    expect(state.present).toBe(false);
    expect(nvidiaNextStep(state)).toBeNull();
  });

  it("caches the runtime answer for a minute, but not failures", async () => {
    let clock = 0;
    const host = fakeHost({ runtimes: null });
    const inspector = createNvidiaInspector({ ...host, now: () => clock });
    expect(await inspector.dockerRuntimeReady()).toBe(false);
    expect(await inspector.dockerRuntimeReady()).toBe(false);
    expect(host.calls.filter((c) => c[0].endsWith("docker")).length).toBe(2); // failures retried
    const ready = fakeHost({ runtimes: '{"nvidia":{}}' });
    const cached = createNvidiaInspector({ ...ready, now: () => clock });
    await cached.dockerRuntimeReady();
    clock = 30_000;
    await cached.dockerRuntimeReady();
    expect(ready.calls.length).toBe(1);
    clock = 61_000;
    await cached.dockerRuntimeReady();
    expect(ready.calls.length).toBe(2);
  });
});
