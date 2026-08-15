import { useCallback, useEffect, useState } from "react";

type Inventory = {
  generatedAt: string;
  host: { hostname: string; operatingSystem: string; kernel: string; architecture: string; uptimeSeconds: number };
  compute: { cpuCount: number; cpuModel: string; load1: number; loadPercent: number; totalMemoryBytes: number; usedMemoryBytes: number; memoryUsedPercent: number };
  storage: { root: null | { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number } };
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
      <div className="dashboard-grid">
        <section className="panel"><header className="panel-header"><strong>Docker workloads</strong><span>{inventory.docker.available ? `${inventory.docker.containers.length} containers | ${inventory.docker.projects.length} projects` : "Unavailable"}</span></header>{inventory.docker.containers.length ? <div className="workload-list">{inventory.docker.containers.map((container) => <div className="workload" key={container.id}><div><strong>{container.name}</strong><span>{container.image} | {container.ports || "no published ports"}</span></div><span className="workload-kind">{container.networks || "Docker"}</span><span className={`status-pill ${container.state === "running" ? "status-good" : "status-warning"}`}>{container.state}</span></div>)}</div> : <p className="empty-state">{inventory.docker.error ?? "No Docker containers are present."}</p>}</section>
        <section className="panel"><header className="panel-header"><strong>Selected services</strong><span>Sanitized systemd state</span></header><div className="workload-list">{inventory.services.filter((service) => service.load !== "not-found").map((service) => <div className="workload" key={service.unit}><div><strong>{service.unit}</strong><span>{service.sub} | {service.enabled}</span></div><span className="workload-kind">systemd</span><span className={`status-pill ${service.active === "active" ? "status-good" : "status-warning"}`}>{service.active}</span></div>)}</div></section>
      </div>
      <section className="panel inventory-network"><div><span className="eyebrow">Private access</span><h3>{inventory.network.tailscale.connected ? "Tailscale connected" : "Tailscale unavailable"}</h3><p>{inventory.network.tailscale.dnsName ?? "No tailnet DNS name reported"}</p></div><div>{inventory.network.addresses.map((address) => <span key={`${address.interface}-${address.address}`}><strong>{address.interface}</strong> {address.cidr ?? address.address}</span>)}</div></section>
    </>
  );
}

export const hostOverviewInternals = { gib, duration };
