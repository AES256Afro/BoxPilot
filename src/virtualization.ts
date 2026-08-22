import { readJson as readJsonBase } from "./http";

/**
 * Virtualization status, domains, resources and plans answer with their real payload and a 503 when
 * libvirt is not set up here, so those readers accept it. Media and retention answer 503 with an
 * error object, so they must not — an empty library is not the same as a library that failed to load.
 */
const readJson = <T,>(response: Response) => readJsonBase<T>(response, { allowStatus: [503] });
const readStrictJson = <T,>(response: Response) => readJsonBase<T>(response);

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
  snapshots: Array<{ name: string; manageable: boolean; current: boolean | null; state: string | null; location: string | null; parent: string | null; createdAt: string | null }>;
  guestAgent: { available: boolean; filesystemState: string | null; addressDiscovery: boolean };
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

export interface LibvirtFoundation {
  connectionUri: "qemu:///system";
  connectionReady: boolean;
  ready: boolean;
  revision: string | null;
  network: { name: "default"; exists: boolean; active: boolean; autostart: boolean; persistent: boolean; compatible: boolean; bridge: string; forwardMode?: string | null; address?: string | null; rangeStart?: string | null; rangeEnd?: string | null };
  pool: { name: "default"; exists: boolean; active: boolean; autostart: boolean; persistent: boolean; compatible: boolean; type?: string | null; targetPath: string; target?: { exists: boolean; directory: boolean; symbolicLink: boolean } };
  conflicts: string[];
  planAvailable: boolean;
  changes: string[];
  boundary: { networkCidr?: string; poolTarget?: string; mutationPerformed: boolean; browserResourceAccepted: boolean };
}

export interface ConsoleGuidance {
  nativeProxyAvailable: false;
  cockpit: { installed: boolean; active: boolean; enabled: boolean; port: 9090 };
  tailscaleDnsName: string | null;
  privateUrl: string | null;
  accessNote: string;
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

export interface VmMediaCandidate {
  name: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  modifiedAt: string;
  revision: string;
}

export interface VmMediaInventory {
  inbox: { path: string; candidates: VmMediaCandidate[] };
  library: { path: string; images: Array<{ name: string; sizeBytes: number; modifiedAt: string }> };
  limits: { maximumIsoBytes: number };
  boundary: {
    browserPathAccepted: false;
    arbitraryDestinationAccepted: false;
    checksumVerifiedDuringImport: true;
    existingMediaOverwritten: false;
    mutationPerformed: false;
  };
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

export interface VmExportArtifact {
  id: string;
  domainName: string;
  domainUuid: string;
  destination: string;
  artifactPath: string;
  manifestChecksumSha256: string;
  sizeBytes: number;
  protected: boolean;
  encrypted: boolean;
  restoreDrill: { passed: boolean; reason?: string };
  createdAt: string;
}

export interface VmProtectionDestination {
  adapter: "mounted-restic";
  ready: boolean;
  encrypted: boolean;
  independent: boolean;
  resticVersion: string | null;
  mount: { target: string; sourceType: string; independentFilesystem: boolean; writable: boolean } | null;
  repositoryId: string | null;
  destinationRevision: string | null;
  destinationFreeBytes: number | null;
  blockers: string[];
  setupCommand: string;
  recoveryKeyRequired: boolean;
}

export interface VmProtectedBackup {
  id: string;
  exportId: string;
  domainName: string;
  domainUuid: string;
  destination: "mounted-restic";
  repositoryId: string;
  snapshotId: string;
  sizeBytes: number;
  encrypted: boolean;
  independent: boolean;
  repositoryVerified: boolean;
  protected: boolean;
  retained: boolean;
  retention: { runId: string; forgottenAt: string } | null;
  restoreDrill: { passed: boolean; reason?: string };
  createdAt: string;
}

export interface VmRetentionCandidate {
  backupId: string;
  snapshotId: string;
  domainName: string;
  domainUuid: string;
  createdAt: string;
  ageDays: number;
  sizeBytes: number;
}

export interface VmRetentionRun {
  id: string;
  repositoryId: string;
  beforeCount: number;
  afterCount: number;
  forgotten: Array<{ backupId: string; snapshotId: string; domainName: string }>;
  repositoryVerified: boolean;
  complete: boolean;
  prunePerformed: false;
  verification: string[];
  createdAt: string;
}

export interface VmRetentionStatus {
  executable: boolean;
  policy: { minimumCopiesPerDomain: number; minimumAgeDays: number; requiresProtectedRestoreDrill: true; preserveRecoverySources: true };
  repositoryId: string | null;
  beforeCount: number;
  /** Snapshots the repository holds that have no local record; each can be forgotten on its own. */
  unrecordedSnapshotIds?: string[];
  candidates: VmRetentionCandidate[];
  kept: Array<VmRetentionCandidate & { reasons: string[] }>;
  blockers: string[];
  changes: string[];
  warnings: string[];
  verification: string[];
  prunePerformed: false;
  spaceReclaimed: false;
  recovery: string;
  retentionRuns: VmRetentionRun[];
}

export interface VmRecoveryRecord {
  id: string;
  backupId: string;
  sourceDomainName: string;
  sourceDomainUuid: string;
  domainName: string;
  domainUuid: string;
  destination: "managed-libvirt-recovery";
  sizeBytes: number;
  state: "stopped";
  network: "none";
  autostart: false;
  createdAt: string;
}

export async function fetchVirtualization(): Promise<[VirtualizationStatus, DomainList, LibvirtResources, ConsoleGuidance]> {
  const [statusResponse, domainsResponse, resourcesResponse, consoleResponse] = await Promise.all([
    fetch("/api/v1/virtualization/status"),
    fetch("/api/v1/virtualization/domains"),
    fetch("/api/v1/virtualization/resources"),
    fetch("/api/v1/virtualization/console-guidance"),
  ]);
  return Promise.all([
    readJson<VirtualizationStatus>(statusResponse),
    readJson<DomainList>(domainsResponse),
    readJson<LibvirtResources>(resourcesResponse),
    readJson<ConsoleGuidance>(consoleResponse),
  ]);
}

export async function fetchVmPlanningOptions(): Promise<VmPlanningOptions> {
  return readJson<VmPlanningOptions>(await fetch("/api/v1/virtualization/planning-options"));
}

export async function fetchVmMedia(): Promise<VmMediaInventory> {
  return readStrictJson<VmMediaInventory>(await fetch("/api/v1/virtualization/media"));
}

export async function uploadVmMedia(file: File, csrfToken: string): Promise<{ name: string; sizeBytes: number; sha256: string; uploadedAt: string }> {
  const response = await fetch("/api/v1/virtualization/media/uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-BoxPilot-CSRF": csrfToken,
      "X-BoxPilot-Filename": file.name,
      "X-BoxPilot-Size": String(file.size),
    },
    body: file,
  });
  return (await readJson<{ upload: { name: string; sizeBytes: number; sha256: string; uploadedAt: string } }>(response)).upload;
}

export async function fetchLibvirtFoundation(): Promise<LibvirtFoundation> {
  return readJson<LibvirtFoundation>(await fetch("/api/v1/virtualization/foundation"));
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

export async function fetchVmExports(): Promise<VmExportArtifact[]> {
  const body = await readJson<{ exports: VmExportArtifact[] }>(await fetch("/api/v1/virtualization/exports"));
  return Array.isArray(body.exports) ? body.exports : [];
}

export async function fetchVmProtection(): Promise<{ destination: VmProtectionDestination; backups: VmProtectedBackup[] }> {
  return readJson<{ destination: VmProtectionDestination; backups: VmProtectedBackup[] }>(await fetch("/api/v1/virtualization/protection"));
}

export async function fetchVmRetention(): Promise<VmRetentionStatus> {
  return readStrictJson<VmRetentionStatus>(await fetch("/api/v1/virtualization/retention"));
}

export async function fetchVmRecoveries(): Promise<VmRecoveryRecord[]> {
  const body = await readJson<{ recoveries: VmRecoveryRecord[] }>(await fetch("/api/v1/virtualization/recoveries"));
  return Array.isArray(body.recoveries) ? body.recoveries : [];
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
