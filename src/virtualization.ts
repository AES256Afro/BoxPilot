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
}

export interface DomainList {
  connected: boolean;
  domains: VirtualDomain[];
  error: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok && response.status !== 503) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return body;
}

export async function fetchVirtualization(): Promise<[VirtualizationStatus, DomainList]> {
  const [statusResponse, domainsResponse] = await Promise.all([
    fetch("/api/v1/virtualization/status"),
    fetch("/api/v1/virtualization/domains"),
  ]);
  return Promise.all([
    readJson<VirtualizationStatus>(statusResponse),
    readJson<DomainList>(domainsResponse),
  ]);
}

export async function runVirtualMachineAction(
  domain: string,
  action: string,
  token: string,
): Promise<void> {
  const response = await fetch(`/api/v1/virtualization/domains/${encodeURIComponent(domain)}/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
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
