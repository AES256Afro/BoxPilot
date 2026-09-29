import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, Switch, Table, TextInput, mayStart, riskOf } from "../../ui";
import { gib, upsLabel, type StartOperation, type SystemSettings, type UpsDetection } from "./systemTypes";

type SwapDevice = SystemSettings["swap"][number];

/**
 * The machine itself (M33.12): memory and swap, how eagerly it swaps, a swap file BoxPilot manages,
 * the weekly SSD trim, and a UPS on USB, detected and set up for monitoring and a clean shutdown.
 */
export function SystemHardware({ settings, loading, role, start, ups, upsError, onLookAgain }: {
  settings: SystemSettings | null;
  loading: boolean;
  role: string;
  start: StartOperation;
  ups: UpsDetection | null;
  upsError: string | null;
  onLookAgain: () => void;
}) {
  const [swappiness, setSwappiness] = useState("");
  const [swapFileGiB, setSwapFileGiB] = useState("4");
  const [shutdown, setShutdown] = useState(true);
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
  const device = ups?.devices[0] ?? null;
  const label = device ? upsLabel(device) : null;
  const description = (label ?? "UPS").replace(/[^A-Za-z0-9 ._()/-]/g, "").slice(0, 60) || "UPS";

  const applySwappiness = () => start({ operationId: "system.swappiness.set", title: `Set swappiness to ${swappinessValue}`, parameters: { value: swappinessValue }, preview: <span>Applies now with <code>sysctl</code> and persists in <code>/etc/sysctl.d/99-boxpilot.conf</code>.</span> });
  const createSwap = () => start({ operationId: "storage.swapfile.set", title: `Create a ${swapFileValue} GiB swap file`, parameters: { sizeGiB: swapFileValue }, preview: <span>Creates <code>/swap.boxpilot</code> ({swapFileValue} GiB), adds a nofail fstab entry, and enables it.</span> });
  const removeSwap = () => start({ operationId: "storage.swapfile.set", title: "Remove the swap file", parameters: { remove: true }, preview: <span>Turns off and deletes <code>/swap.boxpilot</code> and removes its fstab entry. Other swap devices are untouched.</span> });
  const setTrim = (on: boolean) => start({ operationId: "service.action", title: on ? "Enable weekly trim" : "Disable weekly trim", parameters: { unit: "fstrim.timer", action: on ? "enable" : "disable" }, preview: <span><code>systemctl {on ? "enable" : "disable"} fstrim.timer</code></span> });
  const installNut = () => start({ operationId: "apt.install", title: "Install NUT (UPS tools)", parameters: { packages: ["nut"] }, preview: <span><code>apt-get install --no-install-recommends nut</code>. Come back here afterwards to set up monitoring.</span> });
  const setUpUps = () => device && start({
    operationId: "ups.setup",
    title: `Set up monitoring for ${label}`,
    parameters: { driver: device.driver, vendorId: device.vendorId, productId: device.productId, description, shutdownAtLowBattery: shutdown },
    preview: <span>Writes <code>/etc/nut/</code> (driver <code>{device.driver}</code>, server on <code>127.0.0.1</code> only, a generated monitor password), starts the driver and the NUT services, and checks the UPS answers. {shutdown ? "When the UPS reports a low battery, the server shuts down cleanly." : "Shutdown is disabled; you only get status and alerts."} Existing NUT files are kept as .before-boxpilot.</span>,
  });

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

      <Panel padded title="UPS" count={ups ? { status: device ? "good" : "neutral", label: device ? "found" : "none on USB" } : upsError ? { status: "unknown", label: "not read" } : undefined}
        actions={<Button variant="ghost" onClick={onLookAgain}>Look again</Button>}>
        {upsError && <Notice tone="danger" live title="Could not look for a UPS">{upsError}</Notice>}
        {ups && !device && <EmptyState title="No UPS found on USB">Connect the data cable that came with the UPS, not just the power cord, wait a few seconds and look again. Network-managed UPSes (SNMP cards) are not detected automatically.</EmptyState>}
        {device && (
          <div className="system-ups">
            <KeyValue items={[
              { id: "found", label: "Found", value: label },
              { id: "driver", label: "Driver", value: `${device.driver}${device.confidence === "name" ? ", matched by name" : ""}`, mono: true },
              { id: "nut", label: "NUT", value: ups?.nutInstalled ? "installed" : "not installed" },
            ]} />
            {ups?.nutInstalled ? (
              mayStart(role, "ups.setup") && (
                <div className="system-form">
                  <Checkbox label="Shut this server down when the battery is low" checked={shutdown} onChange={setShutdown} />
                  <Button variant="primary" risk={riskOf("ups.setup")} onClick={setUpUps}>Set up monitoring</Button>
                </div>
              )
            ) : mayStart(role, "apt.install") && <Button variant="primary" risk={riskOf("apt.install")} onClick={installNut}>Install NUT first</Button>}
          </div>
        )}
        <p className="system-note">Plug the UPS's USB cable into this server and BoxPilot sets up monitoring: its state on Home and Ops, and a clean shutdown before the battery runs out.</p>
      </Panel>
    </>
  );
}
