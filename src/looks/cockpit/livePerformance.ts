import { useEffect, useState } from "react";
import { inspectOperation } from "../../operations";
import { performanceFrom, type Performance } from "../../home/opsFacts";
import type { InventoryFacts, MountFact } from "../../home/facts";

/*
 * The live figures a look draws as instruments (M41): the processor, the memory and the hottest
 * sensor, read with the same inspection Ops makes (system.performance.inspect), again every
 * `pollMs` while the page is open and in front. Nothing is kept between reads; a read that fails
 * keeps the last figures and says so, and the inventory's own figures stand in until one answers.
 */
export function useLivePerformance(pollMs = 5000): { value: Performance | null; failed: boolean } {
  const [state, setState] = useState<{ value: Performance | null; failed: boolean }>({ value: null, failed: false });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const { result } = await inspectOperation<unknown>("system.performance.inspect");
          const value = performanceFrom(result);
          if (live) setState({ value, failed: false });
        } catch {
          if (live) setState((current) => ({ ...current, failed: true }));
        }
      }
      if (live && pollMs > 0) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [pollMs]);
  return state;
}

/** The hottest sensor, in whole degrees, and which it is; null when no sensor answered. */
export function hottestSensor(performance: Performance | null): { celsius: number; label: string } | null {
  const temps = (performance?.temps ?? []).filter((temp) => Number.isFinite(temp.celsius));
  if (!temps.length) return null;
  const hottest = temps.reduce((top, temp) => (temp.celsius > top.celsius ? temp : top));
  return { celsius: Math.round(hottest.celsius), label: hottest.label.split(":")[0] };
}

/**
 * The fullest drive that holds data: every mounted filesystem but the boot partitions, the fullest
 * first. The system disk counts too, since on many servers it is the only one.
 */
export function fullestDrive(inventory: InventoryFacts | null): MountFact | null {
  const mounts = (inventory?.mounts ?? []).filter((mount) => mount.percent !== null && !/^\/boot(\/|$)/.test(mount.target));
  if (!mounts.length) return null;
  return mounts.reduce((top, mount) => ((mount.percent ?? 0) > (top.percent ?? 0) ? mount : top));
}

/** A drive's short name, as an instrument label: "/" is the system disk, "/mnt/media" is MEDIA. */
export function driveWord(target: string): string {
  if (target === "/") return "DISK";
  const last = target.split("/").filter(Boolean).at(-1) ?? target;
  return last.toUpperCase();
}
