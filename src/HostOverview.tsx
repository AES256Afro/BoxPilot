import { useCallback, useEffect, useState } from "react";

type Inventory = {
  generatedAt: string;
  host: { hostname: string; operatingSystem: string; kernel: string; architecture: string; uptimeSeconds: number };
  compute: { cpuCount: number; cpuModel: string; load1: number; loadPercent: number; totalMemoryBytes: number; usedMemoryBytes: number; memoryUsedPercent: number };
  storage: {
    root: null | { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number };
    filesystems?: { available: boolean; namespace: "host-pid1" | "unavailable"; mounts: Array<{ target: string; source: string; filesystem: string; totalBytes: number | null; usedBytes: number | null; availableBytes: number | null; usedPercent: number | null; capacityState: "healthy" | "warning" | "critical" | "unavailable"; readOnly: boolean; optionNames: string[]; errorEvidence: { supported: boolean; state: "healthy" | "critical" | "unavailable" | "unsupported"; errorsCount: number | null; source: "ext4-sysfs-errors-count" | null; reason: string } }>; summary: { healthy: number; warning: number; critical: number; unavailable: number }; errors: { healthy: number; critical: number; unavailable: number; unsupported: number } };
    blockDevices?: { available: boolean; devices: Array<{ name: string; parent: string | null; type: string; filesystem: string | null; sizeBytes: number | null; mountTargets: string[]; rotational: boolean | null; readOnly: boolean | null; transport: string | null; model: string | null }> };
    smart?: { available: boolean; status: "healthy" | "warning" | "critical" | "stale" | "unavailable"; reason: string; generatedAt: string | null; stale: boolean; disks: Array<{ device: string; health: string; passed: boolean | null; temperatureCelsius: number | null; powerOnHours: number | null; percentageUsed: number | null; mediaErrors: number | null; unsafeShutdowns: number | null }> };
  };
  power?: { ups: { installed: boolean; configured: boolean; available: boolean; state: "online" | "on-battery" | "low-battery" | "forced-shutdown" | "bypass" | "offline" | "unavailable"; reason: string; deviceCount: number; statusTokens: string[]; batteryChargePercent: number | null; estimatedRuntimeSeconds: number | null; loadPercent: number | null; source: "nut-localhost-fixed"; boundary: { mutationPerformed: false; powerCommandAvailable: false; shutdownPolicyChanged: false; localhostOnly: true; remoteNetworkProbePerformed: false; browserTargetAccepted: false; rawOutputIncluded: false; deviceNameIncluded: false; serialIncluded: false } } };
  network: { addresses: Array<{ interface: string; address: string; cidr: string | null }>; tailscale: { installed: boolean; connected: boolean; dnsName: string | null } };
  services: Array<{ unit: string; load: string; active: string; sub: string; enabled: string }>;
  docker: { available: boolean; error?: string; containers: Array<{ id: string; name: string; image: string; state: string; status: string; ports: string; networks: string }>; images: unknown[]; networks: unknown[]; volumes: unknown[]; projects: Array<{ name: string; status: string }> };
};

function gib(value: number) { return `${(value / 1024 ** 3).toFixed(1)} GiB`; }

function duration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function HostOverview() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/inventory");
      const body = await response.json() as Inventory & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Host inventory is unavailable");
      setInventory(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Host inventory is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!inventory && loading) return <section className="vm-loading">Collecting sanitized host inventory...</section>;
  if (!inventory) return <p className="form-error" role="alert">{error}</p>;
  const root = inventory.storage.root;
  const filesystems = inventory.storage.filesystems ?? { available: false, namespace: "unavailable" as const, mounts: [], summary: { healthy: 0, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 0, critical: 0, unavailable: 0, unsupported: 0 } };
  const blockDevices = inventory.storage.blockDevices ?? { available: false, devices: [] };
  const smart = inventory.storage.smart ?? { available: false, status: "unavailable" as const, reason: "storage-scan-evidence-missing", generatedAt: null, stale: true, disks: [] };
  const ups = inventory.power?.ups ?? { installed: false, configured: false, available: false, state: "unavailable" as const, reason: "ups-evidence-missing", deviceCount: 0, statusTokens: [], batteryChargePercent: null, estimatedRuntimeSeconds: null, loadPercent: null };
  const physicalDisks = blockDevices.devices.filter((device) => device.type === "disk");
  const storageStatus = filesystems.errors.critical > 0 || filesystems.summary.critical > 0 || smart.status === "critical"
    ? "critical"
    : filesystems.errors.unavailable > 0 || filesystems.summary.warning > 0 || ["warning", "stale"].includes(smart.status)
      ? "warning"
      : !filesystems.available || !smart.available || filesystems.errors.unsupported > 0
        ? "review"
        : "healthy";
  const upsStatus = ["low-battery", "forced-shutdown"].includes(ups.state)
    ? "critical"
    : ["on-battery", "bypass", "offline"].includes(ups.state) || (ups.configured && !ups.available)
      ? "warning"
      : ups.state === "online"
        ? "healthy"
        : "not configured";
  const upsHeadline = ups.state === "online" ? "Local UPS is online"
    : ups.state === "on-battery" ? "Local UPS is on battery"
      : ups.state === "low-battery" ? "Local UPS battery is low"
        : ups.state === "forced-shutdown" ? "Local UPS reports forced shutdown"
          : ups.reason === "nut-client-not-installed" ? "NUT client is not installed"
            : ups.reason === "no-local-ups-configured" ? "No local UPS is configured"
              : ups.configured ? "Local UPS evidence is unavailable" : "UPS evidence is unavailable";
  const metrics = [
    { label: "CPU load", value: `${inventory.compute.load1.toFixed(2)} / ${inventory.compute.cpuCount} cores`, percent: inventory.compute.loadPercent },
    { label: "Memory", value: `${gib(inventory.compute.usedMemoryBytes)} / ${gib(inventory.compute.totalMemoryBytes)}`, percent: inventory.compute.memoryUsedPercent },
    { label: "Root storage", value: root ? `${gib(root.usedBytes)} / ${gib(root.totalBytes)}` : "Unavailable", percent: root?.usedPercent ?? 0 },
    { label: "Uptime", value: duration(inventory.host.uptimeSeconds), percent: Math.min(100, Math.round(inventory.host.uptimeSeconds / 86400)) },
  ];

  return (
    <>
      <div className="readiness"><div><strong>{inventory.host.hostname}</strong><span>{inventory.host.operatingSystem} | kernel {inventory.host.kernel} | {inventory.host.architecture}</span></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh inventory"}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="metric-grid">{metrics.map((metric) => <article className="metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><div className="meter" aria-label={`${metric.label}: ${metric.value}`}><i style={{ width: `${metric.percent}%` }} /></div></article>)}</div>
      <section className="panel storage-evidence-panel">
        <header className="panel-header"><div><strong>Storage and filesystem evidence</strong><span>Host PID 1 mounts, ext4 kernel error counters, sanitized block topology, and timer-generated SMART results</span></div><span className={`status-pill ${storageStatus === "healthy" ? "status-good" : storageStatus === "critical" || storageStatus === "warning" ? "status-warning" : "status-neutral"}`}>{storageStatus}</span></header>
        <div className="storage-evidence-summary">
          <div><span className="eyebrow">Filesystems</span><strong>{filesystems.available ? `${filesystems.mounts.length} real mounts` : "Inventory unavailable"}</strong><small>{filesystems.errors.critical} errors recorded | {filesystems.errors.unavailable} unavailable | {filesystems.errors.unsupported} unsupported</small></div>
          <div><span className="eyebrow">Physical disks</span><strong>{blockDevices.available ? `${physicalDisks.length} detected` : "Topology unavailable"}</strong><small>Serials and UUIDs excluded</small></div>
          <div><span className="eyebrow">SMART evidence</span><strong>{smart.available ? `${smart.disks.length} disk results` : smart.reason.replaceAll("-", " ")}</strong><small>{smart.generatedAt ? `${smart.stale ? "Stale" : "Collected"} ${new Date(smart.generatedAt).toLocaleString()}` : "Install smartmontools and enable the fixed root-only timer"}</small></div>
        </div>
        {filesystems.mounts.length > 0 && <div className="mount-grid">{filesystems.mounts.map((mount) => <article key={`${mount.target}-${mount.source}`}><div><strong>{mount.target}</strong><span className={`status-pill status-${mount.capacityState === "healthy" ? "good" : mount.capacityState === "unavailable" ? "neutral" : "warning"}`}>{mount.usedPercent === null ? "unknown" : `${mount.usedPercent}% used`}</span></div><p>{mount.source} | {mount.filesystem} | {mount.totalBytes === null ? "size unavailable" : gib(mount.totalBytes)}</p><small>{mount.readOnly ? "read-only" : "read-write"} | {mount.optionNames.length ? mount.optionNames.join(", ") : "no safe option flags reported"}</small><small className={`filesystem-error filesystem-error-${mount.errorEvidence.state}`}>{mount.errorEvidence.state === "healthy" ? `ext4 kernel errors: ${mount.errorEvidence.errorsCount}` : mount.errorEvidence.state === "critical" ? `ext4 kernel errors recorded: ${mount.errorEvidence.errorsCount}` : mount.errorEvidence.state === "unsupported" ? `${mount.filesystem} error counter unsupported` : "ext4 error counter unavailable"}</small></article>)}</div>}
        {smart.disks.length > 0 && <div className="smart-grid">{smart.disks.map((disk) => <article key={disk.device}><div><strong>{disk.device}</strong><span className={`status-pill status-${disk.health === "healthy" ? "good" : disk.health === "unavailable" ? "neutral" : "warning"}`}>{disk.health}</span></div><span>{disk.temperatureCelsius === null ? "temperature unavailable" : `${disk.temperatureCelsius} C`} | {disk.percentageUsed === null ? "wear unavailable" : `${disk.percentageUsed}% life used`} | {disk.mediaErrors === null ? "media errors unavailable" : `${disk.mediaErrors} media errors`}</span></article>)}</div>}
        <div className="storage-boundary"><strong>Read-only evidence boundary</strong><span>The browser cannot select a device, run smartctl, or start fsck. A fixed root-only timer reads the host PID 1 mount table, reads only the mounted ext4 kernel errors_count file, and writes bounded fields. Unsupported filesystems stay explicit; service-sandbox mounts, serials, UUIDs, raw SMART output, mount option values, and private home paths are excluded.</span></div>
      </section>
      <section className="panel power-evidence-panel">
        <header className="panel-header"><div><strong>UPS power protection</strong><span>Optional read-only evidence from one locally enumerated NUT device</span></div><span className={`status-pill ${upsStatus === "healthy" ? "status-good" : upsStatus === "critical" || upsStatus === "warning" ? "status-warning" : "status-neutral"}`}>{upsStatus}</span></header>
        <div className="power-evidence-summary">
          <div><span className="eyebrow">Local state</span><strong>{upsHeadline}</strong><small>{ups.available ? ups.statusTokens.join(" ") || "status unavailable" : ups.reason.replaceAll("-", " ")}</small></div>
          <div><span className="eyebrow">Battery charge</span><strong>{ups.batteryChargePercent === null ? "Unavailable" : `${ups.batteryChargePercent}%`}</strong><small>{ups.estimatedRuntimeSeconds === null ? "Runtime estimate unavailable" : `${duration(ups.estimatedRuntimeSeconds)} estimated runtime`}</small></div>
          <div><span className="eyebrow">UPS load</span><strong>{ups.loadPercent === null ? "Unavailable" : `${ups.loadPercent}%`}</strong><small>{ups.deviceCount === 1 ? "One bounded local device" : `${ups.deviceCount} bounded local devices`}</small></div>
        </div>
        <div className="power-boundary"><strong>Read-only localhost boundary</strong><span>BoxPilot runs only fixed upsc queries against localhost. The browser cannot provide a target, device name, command, or argument. Device names, serials, alarms, and raw output are excluded. BoxPilot cannot switch power, start a shutdown, change NUT policy, or probe a remote UPS.</span></div>
      </section>
      <div className="dashboard-grid">
        <section className="panel"><header className="panel-header"><strong>Docker workloads</strong><span>{inventory.docker.available ? `${inventory.docker.containers.length} containers | ${inventory.docker.projects.length} projects` : "Unavailable"}</span></header>{inventory.docker.containers.length ? <div className="workload-list">{inventory.docker.containers.map((container) => <div className="workload" key={container.id}><div><strong>{container.name}</strong><span>{container.image} | {container.ports || "no published ports"}</span></div><span className="workload-kind">{container.networks || "Docker"}</span><span className={`status-pill ${container.state === "running" ? "status-good" : "status-warning"}`}>{container.state}</span></div>)}</div> : <p className="empty-state">{inventory.docker.error ?? "No Docker containers are present."}</p>}</section>
        <section className="panel"><header className="panel-header"><strong>Selected services</strong><span>Sanitized systemd state</span></header><div className="workload-list">{inventory.services.filter((service) => service.load !== "not-found").map((service) => <div className="workload" key={service.unit}><div><strong>{service.unit}</strong><span>{service.sub} | {service.enabled}</span></div><span className="workload-kind">systemd</span><span className={`status-pill ${service.active === "active" ? "status-good" : "status-warning"}`}>{service.active}</span></div>)}</div></section>
      </div>
      <section className="panel inventory-network"><div><span className="eyebrow">Private access</span><h3>{inventory.network.tailscale.connected ? "Tailscale connected" : "Tailscale unavailable"}</h3><p>{inventory.network.tailscale.dnsName ?? "No tailnet DNS name reported"}</p></div><div>{inventory.network.addresses.map((address) => <span key={`${address.interface}-${address.address}`}><strong>{address.interface}</strong> {address.cidr ?? address.address}</span>)}</div></section>
    </>
  );
}

export const hostOverviewInternals = { gib, duration };
