/**
 * NVIDIA GPUs for apps: what the host has, and whether Docker can hand a GPU to a container.
 *
 * An app marked `gpu: optional` gets a GPU reservation in its compose file only when Docker has the
 * NVIDIA runtime (driver + NVIDIA Container Toolkit). Docker refuses to start a service that
 * reserves a device driver it doesn't have, so asking without checking would break the install.
 */
import { readdir, readFile } from "node:fs/promises";

const pciRoot = "/sys/bus/pci/devices";
const nvidiaVendor = "0x10de";

/** `docker info --format '{{json .Runtimes}}'` → does Docker know the nvidia runtime? */
export function dockerHasNvidiaRuntime(output) {
  try {
    const runtimes = JSON.parse(String(output ?? "").trim() || "{}");
    return Boolean(runtimes && typeof runtimes === "object" && Object.hasOwn(runtimes, "nvidia"));
  } catch {
    return false;
  }
}

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` rows. */
export function parseNvidiaSmi(output) {
  return String(output ?? "").split("\n").map((line) => line.split(",").map((part) => part.trim())).filter((parts) => parts.length >= 3 && parts[0])
    .map(([name, memory, driver]) => ({ name, memoryGiB: Number.isFinite(Number(memory)) ? Math.round(Number(memory) / 1024) : null, driverVersion: driver || null }));
}

export function createNvidiaInspector({
  run,
  listDirectory = (directory) => readdir(directory),
  readText = (file) => readFile(file, "utf8"),
  dpkgQueryBinary = "/usr/bin/dpkg-query",
  now = () => Date.now(),
} = {}) {
  /** NVIDIA display/3D controllers on the PCI bus. Works with no driver installed. */
  async function pciDevices() {
    const addresses = await listDirectory(pciRoot).catch(() => []);
    const found = [];
    for (const address of addresses) {
      const [vendor, deviceClass] = await Promise.all([
        readText(`${pciRoot}/${address}/vendor`).catch(() => ""),
        readText(`${pciRoot}/${address}/class`).catch(() => ""),
      ]);
      // Class 0x03xxxx is a display controller (VGA or 3D); skips the card's HDMI audio function.
      if (vendor.trim().toLowerCase() === nvidiaVendor && deviceClass.trim().startsWith("0x03")) found.push(address);
    }
    return found;
  }

  async function inspect() {
    const [pci, driverText, smi, toolkit, runtimes] = await Promise.all([
      pciDevices(),
      readText("/proc/driver/nvidia/version").catch(() => null),
      run("/usr/bin/nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], { timeout: 15000 }),
      run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", "nvidia-container-toolkit"], { timeout: 10000 }),
      run("/usr/bin/docker", ["info", "--format", "{{json .Runtimes}}"], { timeout: 15000 }),
    ]);
    const gpus = smi.ok ? parseNvidiaSmi(smi.stdout) : [];
    const [toolkitStatus, toolkitVersion] = String(toolkit.stdout ?? "").split("\t", 2);
    const toolkitInstalled = toolkit.ok && toolkitStatus === "install ok installed";
    const driverLoaded = Boolean(driverText) || gpus.length > 0;
    const dockerRuntime = runtimes.ok && dockerHasNvidiaRuntime(runtimes.stdout);
    return {
      present: pci.length > 0 || gpus.length > 0,
      pciDevices: pci,
      driverLoaded,
      driverVersion: gpus[0]?.driverVersion ?? driverText?.match(/Kernel Module\s+([0-9.]+)/)?.[1] ?? null,
      gpus,
      toolkitInstalled,
      toolkitVersion: toolkitInstalled ? toolkitVersion?.trim() || null : null,
      dockerRuntime,
      ready: driverLoaded && dockerRuntime,
      mutationPerformed: false,
    };
  }

  // The deployer asks on every render of a GPU-capable app; the answer only changes when someone
  // installs a driver or toolkit, so a minute of caching is plenty (and failures aren't cached long).
  let cached = null;
  async function dockerRuntimeReady() {
    if (cached && now() - cached.at < 60_000) return cached.value;
    const result = await run("/usr/bin/docker", ["info", "--format", "{{json .Runtimes}}"], { timeout: 15000 });
    const value = result.ok && dockerHasNvidiaRuntime(result.stdout);
    cached = result.ok ? { at: now(), value } : null;
    return value;
  }

  return { inspect, dockerRuntimeReady, pciDevices };
}

/** The Repair Center's guidance for getting from what the host has to GPU-ready apps. */
export function nvidiaNextStep(state) {
  if (!state?.present) return null;
  if (!state.driverLoaded) {
    return "Install the NVIDIA driver: `sudo ubuntu-drivers install --gpgpu`, then reboot. Check with `nvidia-smi`.";
  }
  if (!state.toolkitInstalled) {
    return "Install the NVIDIA Container Toolkit (NVIDIA's apt repository: docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), then run `sudo nvidia-ctk runtime configure --runtime=docker` and `sudo systemctl restart docker`.";
  }
  if (!state.dockerRuntime) {
    return "Register the NVIDIA runtime with Docker: `sudo nvidia-ctk runtime configure --runtime=docker`, then `sudo systemctl restart docker`.";
  }
  return null;
}
