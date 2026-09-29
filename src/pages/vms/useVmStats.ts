import { useEffect, useRef, useState } from "react";
import { inspectOperation } from "../../operations";

/** What libvirt's domstats reports for one VM at one moment (vm.stats.inspect). */
interface DomainStats { name: string; state: string; cpuTimeNs: number; vcpus: number | null; memoryKiB: number | null; memoryMaxKiB: number | null; diskReadBytes: number; diskWriteBytes: number; netRxBytes: number; netTxBytes: number }

/** A VM's use, worked out from two samples: rates need a before and an after. */
export interface VmRate { cpuPercent: number | null; memoryKiB: number | null; memoryMaxKiB: number | null; diskBytesPerSecond: number | null; netBytesPerSecond: number | null }

/** "1.2 MiB/s", "40 KiB/s", or a dash before there are two samples. */
export function rateLabel(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return "—";
  return bytesPerSecond >= 1024 ** 2 ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s` : `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
}

/** "2.0 GiB", from KiB. */
export const gibFromKiB = (kib: number) => `${(kib / 1024 / 1024).toFixed(1)} GiB`;

/**
 * Live resource use (M7.8): two domstats samples five seconds apart, turned into rates. Polled only
 * while the page is open. Each sample waits for the last to answer (a slow libvirt must not stack up
 * requests), and a hidden tab stops sampling until it is shown again. Stats are a convenience: when
 * they cannot be read, the page works without them.
 */
export function useVmStats(): Record<string, VmRate> {
  const [rates, setRates] = useState<Record<string, VmRate>>({});
  const previous = useRef<{ at: number; domains: DomainStats[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let timer: number | null = null;
    const schedule = () => {
      if (cancelled || document.hidden || timer !== null) return;
      timer = window.setTimeout(() => { timer = null; void sample(); }, 5000);
    };
    const sample = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const { result } = await inspectOperation<{ sampledAt: string; domains: DomainStats[] }>("vm.stats.inspect");
        const at = Date.parse(result.sampledAt) || Date.now();
        const before = previous.current;
        const next: Record<string, VmRate> = {};
        for (const domain of result.domains) {
          const last = before?.domains.find((entry) => entry.name === domain.name);
          const seconds = before ? (at - before.at) / 1000 : 0;
          const cpuPercent = last && seconds > 0 && domain.state === "running" ? Math.max(0, Math.min(100, ((domain.cpuTimeNs - last.cpuTimeNs) / 1e9 / seconds / Math.max(1, domain.vcpus ?? 1)) * 100)) : null;
          const diskBytesPerSecond = last && seconds > 0 ? Math.max(0, (domain.diskReadBytes + domain.diskWriteBytes - last.diskReadBytes - last.diskWriteBytes) / seconds) : null;
          const netBytesPerSecond = last && seconds > 0 ? Math.max(0, (domain.netRxBytes + domain.netTxBytes - last.netRxBytes - last.netTxBytes) / seconds) : null;
          next[domain.name] = { cpuPercent, memoryKiB: domain.memoryKiB, memoryMaxKiB: domain.memoryMaxKiB, diskBytesPerSecond, netBytesPerSecond };
        }
        previous.current = { at, domains: result.domains };
        if (!cancelled) setRates(next);
      } catch { /* stats are a convenience; the page works without them */ }
      finally { busy = false; schedule(); }
    };
    const onVisibility = () => {
      if (document.hidden) { if (timer !== null) { window.clearTimeout(timer); timer = null; } return; }
      if (timer === null && !busy) void sample();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) void sample();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  return rates;
}
