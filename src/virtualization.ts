export interface VirtualizationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SetupPlan {
  title: string;
  destructive: boolean;
  requiresConsoleApproval: boolean;
  commands: string[];
  notes: string[];
}

export interface VirtualizationStatus {
  platform: string;
  architecture: string;
  connectionUri: string;
  ready: boolean;
  checks: VirtualizationCheck[];
  tailscale: {
    installed: boolean;
    connected: boolean;
    dnsName: string | null;
    serveUrls: string[];
  };
  setupPlan: SetupPlan;
  actions: { enabled: boolean; reason: string };
}

export interface DomainAddress {
  interface: string;
  protocol: "ipv4" | "ipv6";
  address: string;
}

export interface VirtualDomain {
  name: string;
  uuid: string | null;
  state: string;
  vcpus: number;
  memoryKiB: number;
  persistent: boolean;
  autostart: boolean;
  managed: boolean;
  addresses: DomainAddress[];
  disks: Array<{ type: string; device: string; target: string; source: string }>;
  interfaces: Array<{ interface: string; type: string; source: string; model: string | null; mac: string }>;
  snapshotCount: number | null;
}

export interface DomainList {
  connected: boolean;
  domains: VirtualDomain[];
  error: string | null;
}

export interface LibvirtResources {
  connected: boolean;
  networks: Array<{ name: string; active: boolean; autostart: boolean; persistent: boolean; bridge: string | null }>;
  pools: Array<{
    name: string;
    active: boolean;
    autostart: boolean;
    persistent: boolean;
    type: string | null;
    targetPath: string | null;
    capacity: string | null;
    allocation: string | null;
    available: string | null;
    availableBytes: number | null;
  }>;
  errors: string[];
}

export interface VmPlanningOptions {
  mediaRoot: string;
  mediaError: string | null;
  isoImages: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
  hostCapacity: { cpuThreads: number; memoryMiB: number };
  limits: {
    vcpus: { minimum: number; maximum: number };
    memoryMiB: { minimum: number; maximum: number };
    diskGiB: { minimum: number; maximum: number };
  };
  profiles: Array<{
    id: string;
    label: string;
    osVariant: string;
    minimumMemoryMiB: number;
    minimumDiskGiB: number;
  }>;
  networks: Array<{ name: string; kind: string; recommended: boolean }>;
  firmware: string[];
}

export interface VmPlanInput {
  name: string;
  osProfile: string;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  isoFile: string;
  network: string;
  firmware: "uefi" | "bios";
  autostart: boolean;
}

export interface VmCreationPlan {
  id: string;
  revision: string;
  adapterRevision: string;
  executable: boolean;
  stageable: boolean;
  status: "draft" | "staged";
  expiresAt: string;
  requiresRestrictedHelper: true;
  createdAt: string;
  input: VmPlanInput;
  profile: { label: string; osVariant: string };
  media: { name: string; sizeBytes: number; modifiedAt: string };
  warnings: string[];
  command: { program: string; arguments: string[]; display: string };
  gates: string[];
}

export interface VmCreationJob {
  id: string;
  state: string;
  title: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string; errors?: string[] };
  if (!response.ok && response.status !== 503) {
    throw new Error(body.error ?? body.errors?.join(" | ") ?? `Request failed with status ${response.status}`);
  }
  return body;
}

export async function fetchVirtualization(): Promise<[VirtualizationStatus, DomainList, LibvirtResources]> {
  const [statusResponse, domainsResponse, resourcesResponse] = await Promise.all([
    fetch("/api/v1/virtualization/status"),
    fetch("/api/v1/virtualization/domains"),
    fetch("/api/v1/virtualization/resources"),
  ]);
  return Promise.all([
    readJson<VirtualizationStatus>(statusResponse),
    readJson<DomainList>(domainsResponse),
    readJson<LibvirtResources>(resourcesResponse),
  ]);
}

export async function fetchVmPlanningOptions(): Promise<VmPlanningOptions> {
  return readJson<VmPlanningOptions>(await fetch("/api/v1/virtualization/planning-options"));
}

export async function createVmPlan(input: VmPlanInput, csrfToken: string): Promise<VmCreationPlan> {
  const response = await fetch("/api/v1/virtualization/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify(input),
  });
  const body = await readJson<{ ok: boolean; errors?: string[]; plan?: VmCreationPlan }>(response);
  if (!body.ok || !body.plan) throw new Error(body.errors?.join(" | ") ?? "Unable to create VM plan");
  return body.plan;
}

export async function stageVmPlan(planId: string, revision: string, csrfToken: string): Promise<VmCreationJob> {
  const response = await fetch(`/api/v1/virtualization/plans/${encodeURIComponent(planId)}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ revision }),
  });
  const body = await readJson<{ job: VmCreationJob }>(response);
  return body.job;
}

export async function runVirtualMachineAction(
  domain: string,
  action: string,
  token: string,
  csrfToken: string,
): Promise<void> {
  const response = await fetch(`/api/v1/virtualization/domains/${encodeURIComponent(domain)}/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-BoxPilot-CSRF": csrfToken,
    },
    body: JSON.stringify({ action }),
  });
  await readJson(response);
}

export function formatMemory(memoryKiB: number): string {
  if (!Number.isFinite(memoryKiB) || memoryKiB <= 0) return "Unknown";
  const gib = memoryKiB / 1024 / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown";
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}
