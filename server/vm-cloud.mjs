/**
 * Cloud-init VM creation (helper side). Base images are fetched by the root runner task
 * `vm.cloud-image.ensure`; this module clones the image, writes the cloud-init seed, runs
 * virt-install --import, waits for a DHCP lease, and rolls back on failure.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { fixedRun } from "./exec.mjs";
import { cloudImages, cloudImageRoot } from "./tasks/cloud-images.mjs";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const userPattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const packagePattern = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const sshKeyPattern = /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,256})?$/;

export function validateCloudVmInput(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["input must be an object"];
  const allowed = ["name", "image", "vcpus", "memoryMiB", "diskGiB", "username", "sshKeys", "packages", "autostart", "password"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`unknown field ${key}`);
  if (typeof value.name !== "string" || !namePattern.test(value.name)) errors.push("name must be 1-63 characters: letters, digits, . _ -");
  if (!cloudImages[value.image]) errors.push(`image must be one of ${Object.keys(cloudImages).join(", ")}`);
  if (!Number.isInteger(value.vcpus) || value.vcpus < 1 || value.vcpus > 64) errors.push("vcpus must be 1-64");
  if (!Number.isInteger(value.memoryMiB) || value.memoryMiB < 512 || value.memoryMiB > 512 * 1024) errors.push("memoryMiB must be 512-524288");
  if (!Number.isInteger(value.diskGiB) || value.diskGiB < 4 || value.diskGiB > 4096) errors.push("diskGiB must be 4-4096");
  if (value.username !== undefined && (typeof value.username !== "string" || !userPattern.test(value.username))) errors.push("username must be a lower-case unix name");
  if (!Array.isArray(value.sshKeys) || value.sshKeys.length === 0 || value.sshKeys.length > 10 || !value.sshKeys.every((key) => typeof key === "string" && sshKeyPattern.test(key.trim()))) errors.push("sshKeys must list 1-10 OpenSSH public keys");
  if (value.packages !== undefined && (!Array.isArray(value.packages) || value.packages.length > 50 || !value.packages.every((name) => typeof name === "string" && packagePattern.test(name)))) errors.push("packages must be a list of up to 50 package names");
  if (value.autostart !== undefined && typeof value.autostart !== "boolean") errors.push("autostart must be boolean");
  if (value.password !== undefined && (typeof value.password !== "string" || value.password.length < 8 || value.password.length > 128)) errors.push("password must be 8-128 characters when set");
  return errors;
}

export function renderCloudInit({ name, image, username, sshKeys, packages = [], password = null }) {
  const spec = cloudImages[image];
  const user = username ?? spec.defaultUser;
  const userData = {
    hostname: name,
    manage_etc_hosts: true,
    users: [{ name: user, sudo: "ALL=(ALL) NOPASSWD:ALL", groups: "sudo", shell: "/bin/bash", lock_passwd: !password, ssh_authorized_keys: sshKeys.map((key) => key.trim()) }],
    ssh_pwauth: Boolean(password),
    package_update: true,
    packages: ["qemu-guest-agent", ...packages.filter((name) => name !== "qemu-guest-agent")],
    runcmd: [["systemctl", "enable", "--now", "qemu-guest-agent"]],
  };
  if (password) userData.chpasswd = { expire: false, users: [{ name: user, password, type: "text" }] };
  const metaData = { "instance-id": `boxpilot-${name}`, "local-hostname": name };
  const networkConfig = { version: 2, ethernets: { id0: { match: { name: "en*" }, dhcp4: true, dhcp6: false } } };
  return { userData: `#cloud-config\n${YAML.stringify(userData, { lineWidth: 0 })}`, metaData: YAML.stringify(metaData), networkConfig: YAML.stringify(networkConfig), user };
}

export function createVmCloudHelper({
  imagesRoot = "/var/lib/libvirt/images",
  seedRoot = process.env.BOXPILOT_CLOUDINIT_ROOT ?? "/var/lib/libvirt/images/boxpilot-cloudinit",
  baseRoot = cloudImageRoot,
  connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  qemuImgBinary = process.env.BOXPILOT_QEMU_IMG_BINARY ?? "/usr/bin/qemu-img",
  virtInstallBinary = process.env.BOXPILOT_VIRT_INSTALL_BINARY ?? "/usr/bin/virt-install",
  virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh",
  run = fixedRun,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
} = {}) {
  const virsh = (args, options = {}) => run(virshBinary, ["--connect", connectionUri, ...args], { timeout: 30_000, ...options });

  async function domainExists(name) {
    const result = await virsh(["dominfo", name], { timeout: 15_000 });
    return result.ok;
  }

  async function currentBase(image) {
    try {
      const [imagePath, digest] = (await readFile(path.join(baseRoot, `${image}.current`), "utf8")).split("\n");
      return imagePath ? { path: imagePath, digest } : null;
    } catch { return null; }
  }

  async function images() {
    const list = [];
    for (const [id, spec] of Object.entries(cloudImages)) {
      const cached = await currentBase(id);
      list.push({ id, label: spec.label, defaultUser: spec.defaultUser, cached: Boolean(cached), digest: cached?.digest ?? null });
    }
    return { images: list };
  }

  async function leaseAddress(name) {
    const result = await virsh(["domifaddr", name, "--source", "lease"], { timeout: 15_000 });
    const match = result.stdout.match(/ipv4\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
    return match ? match[1] : null;
  }

  async function create(input, { progress = null, runUnit, jobLog = null } = {}) {
    const errors = validateCloudVmInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const { name, image, vcpus, memoryMiB, diskGiB } = input;
    const spec = cloudImages[image];
    if (await domainExists(name)) throw new Error(`A VM named ${name} already exists`);
    if (!runUnit) throw new Error("Root runner is unavailable");
    progress?.(`Ensuring base image ${spec.label}`, "stdout");
    const base = await runUnit.runTask("vm.cloud-image.ensure", { image }, { timeoutMs: 60 * 60_000, logPath: jobLog?.path ?? null });
    const diskPath = path.join(imagesRoot, `${name}.qcow2`);
    const seedDirectory = path.join(seedRoot, name);
    let diskCreated = false; let defined = false;
    try {
      progress?.(`Creating ${diskGiB} GiB disk from the base image`, "stdout");
      const convert = await run(qemuImgBinary, ["convert", "-f", "qcow2", "-O", "qcow2", base.path, diskPath], { timeout: 30 * 60_000 });
      if (!convert.ok) throw new Error(`qemu-img convert failed: ${convert.stderr.split("\n").slice(-2).join(" ")}`);
      diskCreated = true;
      const resize = await run(qemuImgBinary, ["resize", diskPath, `${diskGiB}G`], { timeout: 5 * 60_000 });
      if (!resize.ok) throw new Error(`qemu-img resize failed: ${resize.stderr.split("\n").slice(-2).join(" ")}`);
      const rendered = renderCloudInit(input);
      await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(seedDirectory, "user-data"), rendered.userData, { mode: 0o600 });
      await writeFile(path.join(seedDirectory, "meta-data"), rendered.metaData, { mode: 0o600 });
      await writeFile(path.join(seedDirectory, "network-config"), rendered.networkConfig, { mode: 0o600 });
      const args = [
        "--connect", connectionUri, "--name", name, "--memory", String(memoryMiB), "--vcpus", String(vcpus),
        "--import", "--disk", `path=${diskPath},format=qcow2,bus=virtio`,
        "--os-variant", spec.osVariant, "--network", "network=default,model=virtio",
        "--graphics", "spice", "--noautoconsole", "--channel", "unix,target_type=virtio,name=org.qemu.guest_agent.0",
        "--cloud-init", `user-data=${path.join(seedDirectory, "user-data")},meta-data=${path.join(seedDirectory, "meta-data")},network-config=${path.join(seedDirectory, "network-config")}`,
        ...(input.autostart ? ["--autostart"] : []),
      ];
      progress?.(`$ virt-install --name ${name} --import (${spec.osVariant}, ${vcpus} vCPU, ${memoryMiB} MiB)`, "stdout");
      const install = await run(virtInstallBinary, args, { timeout: 10 * 60_000, onLine: progress ?? undefined });
      if (!install.ok) throw new Error(`virt-install failed: ${install.stderr.split("\n").slice(-3).join(" ")}`);
      defined = true;
      progress?.("Waiting for the VM to obtain an address (cloud-init first boot)...", "stdout");
      const deadline = clock() + 180_000; let ip = null;
      while (clock() < deadline) { ip = await leaseAddress(name); if (ip) break; await wait(3000); }
      if (ip) progress?.(`VM is up at ${ip}`, "stdout"); else progress?.("No DHCP lease seen yet; cloud-init may still be running.", "stderr");
      // virt-install has already built the seed ISO, so the plain user-data (which carries the
      // account password) does not need to stay on disk.
      await rm(seedDirectory, { recursive: true, force: true }).catch(() => {});
      return { created: true, name, image, imageDigest: base.digest, ip, user: rendered.user, sshCommand: ip ? `ssh ${rendered.user}@${ip}` : null, disk: diskPath, vcpus, memoryMiB, diskGiB, autostart: Boolean(input.autostart) };
    } catch (error) {
      progress?.(`Creation failed: ${error.message}. Rolling back...`, "stderr");
      if (defined) { await virsh(["destroy", name], { timeout: 30_000 }); await virsh(["undefine", name, "--nvram"], { timeout: 60_000 }).catch(() => {}); }
      if (diskCreated) await rm(diskPath, { force: true }).catch(() => {});
      await rm(seedDirectory, { recursive: true, force: true }).catch(() => {});
      throw new Error(`VM creation failed and was rolled back. ${error.message}`);
    }
  }

  return { create, images, internals: { leaseAddress, currentBase } };
}
