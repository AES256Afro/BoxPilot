import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateDomainName } from "./libvirt.mjs";

const osProfiles = {
  "ubuntu-24.04": {
    label: "Ubuntu 24.04 LTS",
    osVariant: "ubuntu24.04",
    minimumMemoryMiB: 2048,
    minimumDiskGiB: 20,
    diskBus: "virtio",
    networkModel: "virtio",
  },
  "ubuntu-22.04": {
    label: "Ubuntu 22.04 LTS",
    osVariant: "ubuntu22.04",
    minimumMemoryMiB: 2048,
    minimumDiskGiB: 20,
    diskBus: "virtio",
    networkModel: "virtio",
  },
  "debian-12": {
    label: "Debian 12",
    osVariant: "debian12",
    minimumMemoryMiB: 1024,
    minimumDiskGiB: 10,
    diskBus: "virtio",
    networkModel: "virtio",
  },
  "windows-11": {
    label: "Windows 11",
    osVariant: "win11",
    minimumMemoryMiB: 4096,
    minimumDiskGiB: 64,
    diskBus: "sata",
    networkModel: "e1000e",
  },
  "generic-linux": {
    label: "Other Linux",
    osVariant: "generic",
    minimumMemoryMiB: 1024,
    minimumDiskGiB: 10,
    diskBus: "virtio",
    networkModel: "virtio",
  },
};

const limits = {
  vcpus: { minimum: 1, maximum: 32 },
  memoryMiB: { minimum: 1024, maximum: 131072 },
  diskGiB: { minimum: 8, maximum: 4096 },
};

function inIntegerRange(value, range) {
  return Number.isInteger(value) && value >= range.minimum && value <= range.maximum;
}

function isoFilenameIsSafe(filename) {
  return typeof filename === "string"
    && filename.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._ -]*\.iso$/i.test(filename)
    && path.basename(filename) === filename;
}

function displayArgument(argument) {
  return /^[A-Za-z0-9_./,:=+-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}

function normalizedInput(input) {
  return {
    name: input.name,
    osProfile: input.osProfile,
    vcpus: input.vcpus,
    memoryMiB: input.memoryMiB,
    diskGiB: input.diskGiB,
    isoFile: input.isoFile,
    network: input.network,
    firmware: input.firmware,
    autostart: Boolean(input.autostart),
  };
}

export function validateVmPlanInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["A VM plan object is required"];
  }
  if (!validateDomainName(input.name)) errors.push("Name must use 1-63 letters, numbers, dots, underscores, or hyphens");
  if (!Object.hasOwn(osProfiles, input.osProfile)) errors.push("Select a supported operating-system profile");
  if (!inIntegerRange(input.vcpus, limits.vcpus)) errors.push("vCPU count must be an integer from 1 to 32");
  if (!inIntegerRange(input.memoryMiB, limits.memoryMiB)) errors.push("Memory must be an integer from 1024 to 131072 MiB");
  if (!inIntegerRange(input.diskGiB, limits.diskGiB)) errors.push("Disk size must be an integer from 8 to 4096 GiB");
  if (!isoFilenameIsSafe(input.isoFile)) errors.push("Select an ISO filename from the managed media library");
  if (input.network !== "default") errors.push("Only the default NAT network is supported in this planning milestone");
  if (input.firmware !== "uefi" && input.firmware !== "bios") errors.push("Firmware must be UEFI or BIOS");
  if (input.osProfile === "windows-11" && input.firmware !== "uefi") errors.push("Windows 11 planning requires UEFI firmware");
  if (typeof input.autostart !== "boolean") errors.push("Autostart must be true or false");
  return errors;
}

export function createVmPlanner({
  mediaRoot = process.env.BOXPILOT_ISO_DIRECTORY ?? "/var/lib/libvirt/boot",
  connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  readDirectory = readdir,
  statFile = lstat,
  hostCapacity = () => ({ cpuThreads: os.cpus().length, memoryMiB: Math.floor(os.totalmem() / 1024 / 1024) }),
} = {}) {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  async function listIsoImages() {
    try {
      const entries = await readDirectory(resolvedMediaRoot, { withFileTypes: true });
      const candidates = entries.filter((entry) => entry.isFile() && isoFilenameIsSafe(entry.name));
      return await Promise.all(candidates.map(async (entry) => {
        const absolutePath = path.join(resolvedMediaRoot, entry.name);
        const metadata = await statFile(absolutePath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) return null;
        return {
          name: entry.name,
          sizeBytes: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        };
      })).then((images) => images.filter(Boolean));
    } catch (error) {
      return {
        error: error.code === "ENOENT"
          ? `ISO directory does not exist: ${resolvedMediaRoot}`
          : `ISO directory is unavailable: ${resolvedMediaRoot}`,
        images: [],
      };
    }
  }

  async function getOptions() {
    const isoResult = await listIsoImages();
    const images = Array.isArray(isoResult) ? isoResult : isoResult.images;
    return {
      mediaRoot: resolvedMediaRoot,
      mediaError: Array.isArray(isoResult) ? null : isoResult.error,
      isoImages: images.sort((left, right) => left.name.localeCompare(right.name)),
      hostCapacity: hostCapacity(),
      limits,
      profiles: Object.entries(osProfiles).map(([id, profile]) => ({ id, ...profile })),
      networks: [{ name: "default", kind: "NAT", recommended: true }],
      firmware: ["uefi", "bios"],
    };
  }

  async function createPlan(input, { existingDomainNames = [], poolAvailableBytes = null } = {}) {
    const errors = validateVmPlanInput(input);
    if (errors.length) return { ok: false, errors };
    if (existingDomainNames.includes(input.name)) return { ok: false, errors: [`A libvirt domain named ${input.name} already exists`] };
    if (Number.isFinite(poolAvailableBytes) && input.diskGiB * 1024 ** 3 > poolAvailableBytes) {
      return { ok: false, errors: ["The default storage pool does not report enough free space for this virtual disk"] };
    }

    const options = await getOptions();
    const iso = options.isoImages.find((image) => image.name === input.isoFile);
    if (!iso) {
      return { ok: false, errors: [options.mediaError ?? "The selected ISO is not present in the managed media library"] };
    }

    const normalized = normalizedInput(input);
    const profile = osProfiles[normalized.osProfile];
    const warnings = [];
    if (normalized.memoryMiB < profile.minimumMemoryMiB) {
      warnings.push(`${profile.label} is planned below its ${profile.minimumMemoryMiB} MiB memory baseline`);
    }
    if (normalized.diskGiB < profile.minimumDiskGiB) {
      warnings.push(`${profile.label} is planned below its ${profile.minimumDiskGiB} GiB disk baseline`);
    }
    if (normalized.vcpus > options.hostCapacity.cpuThreads) {
      warnings.push(`The plan assigns ${normalized.vcpus} vCPUs on a host reporting ${options.hostCapacity.cpuThreads} CPU threads`);
    }
    if (normalized.memoryMiB > Math.floor(options.hostCapacity.memoryMiB * 0.75)) {
      warnings.push("The plan assigns more than 75% of host memory to one guest");
    }
    if (normalized.osProfile === "windows-11") {
      warnings.push("Windows 11 creation will require a TPM 2.0 and Secure Boot capability check before Apply can be enabled");
    }

    const isoPath = path.join(resolvedMediaRoot, normalized.isoFile);
    const argumentsList = [
      "--connect", connectionUri,
      "--name", normalized.name,
      "--vcpus", String(normalized.vcpus),
      "--memory", String(normalized.memoryMiB),
      "--os-variant", profile.osVariant,
      "--disk", `pool=default,size=${normalized.diskGiB},format=qcow2,bus=${profile.diskBus}`,
      "--network", `network=default,model=${profile.networkModel}`,
      "--cdrom", isoPath,
      "--boot", normalized.firmware,
      "--graphics", "spice,listen=127.0.0.1",
      "--noautoconsole",
    ];
    if (normalized.autostart) argumentsList.push("--autostart");

    const revision = createHash("sha256").update(JSON.stringify({
      input: normalized,
      media: iso,
      mediaRoot: resolvedMediaRoot,
      connectionUri,
    })).digest("hex").slice(0, 16);
    return {
      ok: true,
      plan: {
        revision,
        executable: false,
        requiresRestrictedHelper: true,
        createdAt: new Date().toISOString(),
        input: normalized,
        profile: { label: profile.label, osVariant: profile.osVariant },
        media: iso,
        warnings,
        command: {
          program: "virt-install",
          arguments: argumentsList,
          display: ["virt-install", ...argumentsList].map(displayArgument).join(" "),
        },
        gates: [
          "Confirm storage-pool free space and backup coverage",
          "Create a durable plan revision and authenticated approval",
          "Execute through the restricted libvirt helper",
          "Verify the domain definition, disk, network, and first console boot",
        ],
      },
    };
  }

  return { getOptions, createPlan };
}
