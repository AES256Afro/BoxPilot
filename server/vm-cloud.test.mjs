import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVmCloudHelper, renderCloudInit, validateCloudVmInput } from "./vm-cloud.mjs";
import { cloudImageInternals, ensureCloudImage } from "./tasks/cloud-images.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyDataExampleKeyDataExampleKeyDat user@laptop";
const good = { name: "dev-1", image: "ubuntu-24.04", vcpus: 2, memoryMiB: 2048, diskGiB: 20, sshKeys: [key], packages: ["git"] };

describe("cloud-init VM input and seed", () => {
  it("validates input strictly", () => {
    expect(validateCloudVmInput(good)).toEqual([]);
    expect(validateCloudVmInput({ ...good, name: "bad name" })).toContainEqual(expect.stringContaining("name"));
    expect(validateCloudVmInput({ ...good, sshKeys: ["not a key"] })).toContainEqual(expect.stringContaining("sshKeys"));
    expect(validateCloudVmInput({ ...good, packages: ["rm -rf /"] })).toContainEqual(expect.stringContaining("packages"));
    expect(validateCloudVmInput({ ...good, extra: 1 })).toContainEqual(expect.stringContaining("unknown field"));
    expect(validateCloudVmInput({ ...good, username: "Root" })).toContainEqual(expect.stringContaining("username"));
    // The drill namespace is reserved: a VM inside it looks to startup recovery like an abandoned
    // drill it cannot account for, and the helper would refuse to start at all.
    expect(validateCloudVmInput({ ...good, name: "boxpilot-drill-test" })).toContainEqual(expect.stringContaining("boxpilot-drill-"));
  });

  it("renders cloud-init with the key, sudo user, guest agent, and dhcp networking", () => {
    const seed = renderCloudInit(good);
    expect(seed.user).toBe("ubuntu");
    expect(seed.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(seed.userData).toContain("ssh_authorized_keys");
    expect(seed.userData).toContain(key);
    expect(seed.userData).toContain("qemu-guest-agent");
    expect(seed.userData).toContain("- git");
    expect(seed.userData).toContain("lock_passwd: true");
    expect(seed.metaData).toContain("local-hostname: dev-1");
    expect(seed.networkConfig).toContain("dhcp4: true");
    const withPassword = renderCloudInit({ ...good, username: "jamie", password: "hunter22hunter" });
    expect(withPassword.userData).toContain("name: jamie");
    expect(withPassword.userData).toContain("ssh_pwauth: true");
  });
});

describe("cloud image task", () => {
  it("parses checksum lists and caches by digest", async () => {
    const digest = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"; // sha256 of "x"
    expect(cloudImageInternals.expectedDigest(`${digest} *noble-server-cloudimg-amd64.img\nother *x.img\n`, "noble-server-cloudimg-amd64.img")).toBe(digest);
    expect(cloudImageInternals.expectedDigest(`${digest}  ./debian-12-genericcloud-amd64.qcow2\n`, "debian-12-genericcloud-amd64.qcow2")).toBe(digest);
    expect(cloudImageInternals.expectedDigest("short *noble-server-cloudimg-amd64.img\n", "noble-server-cloudimg-amd64.img")).toBeNull();
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cloudimg-")); directories.push(root);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => `${digest} *noble-server-cloudimg-amd64.img\n` }));
    const run = vi.fn(async (_binary, args) => { await writeFile(args[args.indexOf("-o") + 1], "x"); return { ok: true, stdout: "", stderr: "" }; });
    const first = await ensureCloudImage({ image: "ubuntu-24.04" }, { run, fetchImpl, root });
    expect(first).toMatchObject({ downloaded: true, digest });
    expect(await readdir(root)).toEqual(expect.arrayContaining([`ubuntu-24.04-${digest.slice(0, 12)}.img`, "ubuntu-24.04.current"]));
    const second = await ensureCloudImage({ image: "ubuntu-24.04" }, { run, fetchImpl, root });
    expect(second.downloaded).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async (_binary, args) => { await writeFile(args[args.indexOf("-o") + 1], "tampered"); return { ok: true, stdout: "", stderr: "" }; });
    const altRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cloudimg-")); directories.push(altRoot);
    await expect(ensureCloudImage({ image: "ubuntu-24.04" }, { run: bad, fetchImpl, root: altRoot })).rejects.toThrow("Checksum mismatch");
    await expect(ensureCloudImage({ image: "nope" }, { run, fetchImpl, root })).rejects.toThrow("Unsupported");
  });
});

describe("cloud-init VM helper", () => {
  it("clones the base image, seeds cloud-init, runs virt-install, and reports the lease", async () => {
    const imagesRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-images-")); directories.push(imagesRoot);
    const baseRoot = path.join(imagesRoot, "base"); await rm(baseRoot, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises"); await mkdir(baseRoot, { recursive: true });
    await writeFile(path.join(baseRoot, "base.img"), "base");
    await writeFile(path.join(baseRoot, "ubuntu-24.04.current"), `${path.join(baseRoot, "base.img")}\nabc\n`);
    const calls = [];
    const seedSnapshots = [];
    const domains = new Set();
    const run = vi.fn(async (binary, args) => {
      calls.push(`${path.basename(binary)} ${args.join(" ")}`);
      if (binary.endsWith("virsh") && args.includes("dominfo")) return domains.has(args[args.length - 1]) ? { ok: true, stdout: "Name: x", stderr: "" } : { ok: false, stdout: "", stderr: "not found" };
      if (binary.endsWith("virsh") && args.includes("domifaddr")) return { ok: true, stdout: " vnet0  52:54:00:aa:bb:cc  ipv4  192.168.122.45/24", stderr: "" };
      if (binary.endsWith("qemu-img") && args[0] === "convert") { await writeFile(args[args.length - 1], "disk"); return { ok: true, stdout: "", stderr: "" }; }
      if (binary.endsWith("virt-install")) {
        const seed = args[args.indexOf("--cloud-init") + 1].split(",")[0].replace("user-data=", "");
        seedSnapshots.push(await readFile(seed, "utf8"));
        domains.add(args[args.indexOf("--name") + 1]);
        return { ok: true, stdout: "Domain creation completed.", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const runUnit = { runTask: vi.fn(async () => ({ path: path.join(baseRoot, "base.img"), digest: "abc", downloaded: false })) };
    const helper = createVmCloudHelper({ imagesRoot, seedRoot: path.join(imagesRoot, "seeds"), baseRoot, run, wait: async () => {}, clock: () => 1 });
    const progress = vi.fn();
    const result = await helper.create(good, { progress, runUnit });
    expect(result).toMatchObject({ created: true, name: "dev-1", ip: "192.168.122.45", user: "ubuntu", sshCommand: "ssh ubuntu@192.168.122.45" });
    expect(runUnit.runTask).toHaveBeenCalledWith("vm.cloud-image.ensure", { image: "ubuntu-24.04" }, expect.objectContaining({ timeoutMs: 3600000 }));
    expect(calls).toContainEqual(expect.stringMatching(/^qemu-img convert -f qcow2 -O qcow2 .*base\.img .*dev-1\.qcow2$/));
    expect(calls).toContainEqual(expect.stringMatching(/^qemu-img resize .*dev-1\.qcow2 20G$/));
    expect(calls.find((call) => call.startsWith("virt-install"))).toContain("--os-variant ubuntu24.04");
    expect(calls.find((call) => call.startsWith("virt-install"))).toContain("--cloud-init user-data=");
    // virt-install receives the seed, and it is deleted afterwards: the account password does not stay on disk.
    expect(seedSnapshots.at(-1)).toContain(key);
    await expect(readFile(path.join(imagesRoot, "seeds", "dev-1", "user-data"), "utf8")).rejects.toThrow();
    expect((await helper.images()).images.find((image) => image.id === "ubuntu-24.04")).toMatchObject({ cached: true, digest: "abc" });
    await expect(helper.create(good, { progress, runUnit })).rejects.toThrow("already exists");
  });

  it("rolls back the disk and seed when virt-install fails", async () => {
    const imagesRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-images-")); directories.push(imagesRoot);
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("virsh") && args.includes("dominfo")) return { ok: false, stdout: "", stderr: "not found" };
      if (binary.endsWith("qemu-img") && args[0] === "convert") { await writeFile(args[args.length - 1], "disk"); return { ok: true, stdout: "", stderr: "" }; }
      if (binary.endsWith("virt-install")) return { ok: false, stdout: "", stderr: "ERROR    unsupported configuration" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const runUnit = { runTask: vi.fn(async () => ({ path: "/nonexistent/base.img", digest: "abc" })) };
    const helper = createVmCloudHelper({ imagesRoot, seedRoot: path.join(imagesRoot, "seeds"), baseRoot: imagesRoot, run, wait: async () => {}, clock: () => 1 });
    await expect(helper.create(good, { runUnit })).rejects.toThrow(/rolled back.*virt-install failed/);
    expect(await readdir(imagesRoot)).toEqual(expect.not.arrayContaining(["dev-1.qcow2"]));
  });
});
