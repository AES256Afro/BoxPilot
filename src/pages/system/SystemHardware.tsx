import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Field, KeyValue, Panel, Switch, Table, TextInput, mayStart, riskOf } from "../../ui";
import { gib, type StartOperation, type SystemSettings } from "./systemTypes";

type SwapDevice = SystemSettings["swap"][number];

/**
 * The machine itself (M33.12): memory and swap, how eagerly it swaps, a swap file BoxPilot manages,
 * and the weekly SSD trim. The UPS, the watchdog and Wake-on-LAN are on the Power tab (M39).
 */
export function SystemHardware({ settings, loading, role, start }: {
  settings: SystemSettings | null;
  loading: boolean;
  role: string;
  start: StartOperation;
}) {
  const [swappiness, setSwappiness] = useState("");
  const [swapFileGiB, setSwapFileGiB] = useState("4");
  const edited = useRef(false);
  useEffect(() => { if (settings && !edited.current) setSwappiness(settings.swappiness === null ? "" : String(settings.swappiness)); }, [settings]);

  const swappinessValue = Number.parseInt(swappiness, 10);
  const swappinessValid = /^\d+$/.test(swappiness.trim()) && swappinessValue >= 0 && swappinessValue <= 100;
  const swapFileValue = Number.parseInt(swapFileGiB, 10);
  const swapFileValid = /^\d+$/.test(swapFileGiB.trim()) && swapFileValue >= 1 && swapFileValue <= 64;
  const managedSwap = settings?.swap.some((device) => device.device === "/swap.boxpilot") ?? false;
  const memory = settings?.memory;
  const usedPercent = memory?.memTotalKiB && memory.memAvailableKiB !== null ? Math.round(((memory.memTotalKiB - memory.memAvailableKiB) / memory.memTotalKiB) * 100) : null;
  const swapUsed = memory?.swapTotalKiB ? (memory.swapTotalKiB ?? 0) - (memory.swapFreeKiB ?? 0) : null;
  const trimOn = settings?.fstrim.enabled === "enabled";

  const applySwappiness = () => start({ operationId: "system.swappiness.set", title: `Set swappiness to ${swappinessValue}`, parameters: { value: swappinessValue }, preview: <span>Applies now with <code>sysctl</code> and persists in <code>/etc/sysctl.d/99-boxpilot.conf</code>.</span> });
  const createSwap = () => start({ operationId: "storage.swapfile.set", title: `Create a ${swapFileValue} GiB swap file`, parameters: { sizeGiB: swapFileValue }, preview: <span>Creates <code>/swap.boxpilot</code> ({swapFileValue} GiB), adds a nofail fstab entry, and enables it.</span> });
  const removeSwap = () => start({ operationId: "storage.swapfile.set", title: "Remove the swap file", parameters: { remove: true }, preview: <span>Turns off and deletes <code>/swap.boxpilot</code> and removes its fstab entry. Other swap devices are untouched.</span> });
  const setTrim = (on: boolean) => start({ operationId: "service.action", title: on ? "Enable weekly trim" : "Disable weekly trim", parameters: { unit: "fstrim.timer", action: on ? "enable" : "disable" }, preview: <span><code>systemctl {on ? "enable" : "disable"} fstrim.timer</code></span> });

  return (
    <>
      <Panel title="Memory and swap" count={usedPercent === null ? undefined : `${usedPercent}% used`}>
        <div className="system-pad">
          <KeyValue layout="columns" items={[
            { id: "memory", label: "Memory available", mono: true, value: gib(memory?.memAvailableKiB), hint: `of ${gib(memory?.memTotalKiB)}` },
            { id: "swap", label: "Swap", mono: true, value: gib(memory?.swapTotalKiB), hint: memory?.swapTotalKiB ? `${gib(swapUsed)} in use` : "none configured" },
            { id: "swappiness", label: "Swappiness", mono: true, value: settings?.swappiness ?? "—", hint: "Ubuntu's default is 60" },
          ]} />
        </div>
        <Table<SwapDevice>
          caption="Swap devices"
          columns={[
            { id: "device", header: "Swap device", cell: (entry) => <code>{entry.device}</code> },
            { id: "type", header: "Type", cell: (entry) => entry.type },
            { id: "size", header: "Size", numeric: true, cell: (entry) => gib(entry.sizeKiB) },
            { id: "used", header: "In use", numeric: true, cell: (entry) => gib(entry.usedKiB) },
            { id: "priority", header: "Priority", numeric: true, hideOnPhone: true, cell: (entry) => String(entry.priority) },
          ]}
          rows={settings?.swap ?? []}
          rowKey={(entry) => entry.device}
          empty={settings ? <EmptyState title="No swap">A swap file gives the server room when memory runs short.</EmptyState> : "Reading…"}
        />
        <div className="system-pad system-forms">
          {mayStart(role, "system.swappiness.set") && (
            <form className="system-form" onSubmit={(event) => { event.preventDefault(); if (swappinessValid && swappinessValue !== settings?.swappiness) applySwappiness(); }}>
              <Field label="Swappiness" hint="Lower keeps more in RAM; 10 suits most servers." error={swappiness && !swappinessValid ? "A whole number from 0 to 100" : undefined}>
                <TextInput mono inputMode="numeric" value={swappiness} onValueChange={(value) => { edited.current = true; setSwappiness(value); }} placeholder="10" />
              </Field>
              <Button type="submit" risk={riskOf("system.swappiness.set")} disabled={loading || !swappinessValid || swappinessValue === settings?.swappiness}>Apply</Button>
            </form>
          )}
          {settings && mayStart(role, "storage.swapfile.set") && (managedSwap ? (
            <div className="system-form">
              <p className="system-sub">BoxPilot's swap file is <code>/swap.boxpilot</code>.</p>
              <Button risk={riskOf("storage.swapfile.set")} disabled={loading} onClick={removeSwap}>Remove swap file</Button>
            </div>
          ) : (
            <form className="system-form" onSubmit={(event) => { event.preventDefault(); if (swapFileValid) createSwap(); }}>
              <Field label="Swap file size (GiB)" hint="1 to 64 GiB, at /swap.boxpilot." error={swapFileGiB && !swapFileValid ? "A whole number from 1 to 64" : undefined}>
                <TextInput mono inputMode="numeric" value={swapFileGiB} onValueChange={(value) => setSwapFileGiB(value.trim())} placeholder="4" />
              </Field>
              <Button type="submit" risk={riskOf("storage.swapfile.set")} disabled={loading || !swapFileValid}>Create swap file</Button>
            </form>
          ))}
        </div>
      </Panel>

      <Panel padded title="SSD trim" count={settings ? { status: trimOn ? "good" : "neutral", label: trimOn ? "weekly" : "off" } : undefined}>
        {mayStart(role, "service.action") && settings ? (
          <Switch
            label="Weekly trim"
            description={trimOn ? `fstrim.timer is enabled${settings.fstrim.nextRun ? `; next run ${settings.fstrim.nextRun}` : ""}.` : "fstrim.timer is disabled. Weekly trim keeps SSDs fast and healthy."}
            checked={trimOn}
            risk={riskOf("service.action")}
            disabled={loading}
            onChange={setTrim}
          />
        ) : (
          <KeyValue items={[{ id: "trim", label: "fstrim.timer", value: settings ? `${settings.fstrim.enabled ?? "unknown"}${settings.fstrim.nextRun ? ` · next ${settings.fstrim.nextRun}` : ""}` : "—", mono: true }]} />
        )}
      </Panel>
    </>
  );
}
