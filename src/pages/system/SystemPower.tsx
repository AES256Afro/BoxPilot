import { useState } from "react";
import { Button, Checkbox, CopyButton, EmptyState, Field, KeyValue, Notice, Panel, Select, Switch, Table, Tag, TextInput, mayStart, riskOf, type Status } from "../../ui";
import { batteryWords, durationWords, powerEventWords, upsStateWords, type PowerEvent, type PowerEventWords } from "../../powerEvents";
import { upsLabel, type PowerHardware, type PowerOverview, type StartOperation, type UpsDetection, type WakePort, type WatchdogReading } from "./systemTypes";

/*
 * Power (M39): keeping the house running when the server does not. The UPS, from "I bought one"
 * to "protected" in three steps with what the shutdown does and when; the power-event log; the
 * hardware watchdog that restarts a frozen server; and what makes the server start again by
 * itself after an outage: the firmware setting (BoxPilot cannot change it, so it says where it
 * is on this board) and Wake-on-LAN. The power-loss notice links here (?tab=power#power-on).
 */

export interface SystemPowerProps {
  role: string;
  start: StartOperation;
  ups: UpsDetection | null;
  upsError: string | null;
  onLookAgain: () => void;
  overview: PowerOverview | null;
  overviewError: string | null;
  hardware: PowerHardware | null;
  hardwareError: string | null;
  hardwareLoading: boolean;
  onReadHardware: () => void;
}

const minutes = (seconds: number | null | undefined) => (typeof seconds === "number" ? durationWords(seconds * 1000) : null);

/** When the UPS calls its battery low, in words: "below 20% or under 5 min left". */
export function thresholdWords(percent: number | null | undefined, runtimeSeconds: number | null | undefined): string | null {
  const parts = [typeof percent === "number" ? `below ${percent}%` : null, typeof runtimeSeconds === "number" ? `under ${minutes(runtimeSeconds)} left` : null].filter(Boolean);
  return parts.length ? parts.join(" or ") : null;
}

/** The watchdog's state as a status, a label and one sentence. */
export function watchdogWords(reading: WatchdogReading | null): { status: Status; label: string; sentence: string } {
  if (!reading) return { status: "unknown", label: "Not read", sentence: "Whether this board has a watchdog has not been read." };
  const hardware = (reading.devices ?? []).find((device) => !device.software);
  const name = hardware?.identity ?? reading.driver?.name ?? "the board's watchdog";
  const seconds = reading.runtimeSeconds ?? null;
  switch (reading.state) {
    case "on": return { status: "good", label: "On", sentence: `If the server freezes, ${name} restarts it within ${durationWords((seconds ?? 60) * 1000)}.` };
    case "ready": return { status: "neutral", label: "Off", sentence: `This board has a watchdog (${name}), and nothing is using it: a frozen server stays frozen until someone restarts it.` };
    case "loadable": return { status: "neutral", label: "Off", sentence: `This board's chipset has a watchdog timer. Ubuntu does not load its driver (${reading.driver?.name}) by itself; turning the watchdog on loads it, now and at every boot.` };
    case "configured-no-device": return { status: "warning", label: "Not running", sentence: `systemd is set to use a watchdog, but none appeared at this boot, so nothing would restart a frozen server. Turning it on again loads ${reading.driver?.name ?? "its driver"}.` };
    case "virtual-machine": return { status: "neutral", label: "Virtual machine", sentence: `This is a virtual machine (${reading.virtualization ?? "virtualised"}): what a hang does is its host's decision, so BoxPilot leaves the watchdog to the host.` };
    case "software-only": return { status: "neutral", label: "None", sentence: "Only the kernel's software watchdog is here. It cannot restart a kernel that has frozen, so BoxPilot does not use it." };
    case "disabled-in-firmware": return { status: "neutral", label: "Off in firmware", sentence: `The watchdog driver (${reading.driver?.name}) is loaded but found no timer: it is most likely switched off in the firmware settings.` };
    case "no-device": return { status: "neutral", label: "None", sentence: "No hardware watchdog was found on this board." };
    default: return { status: "unknown", label: "Not read", sentence: reading.error ? `The watchdog could not be read: ${reading.error}` : "The watchdog could not be read." };
  }
}

function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type EventRow = PowerEvent & PowerEventWords & { key: string };

export function SystemPower({ role, start, ups, upsError, onLookAgain, overview, overviewError, hardware, hardwareError, hardwareLoading, onReadHardware }: SystemPowerProps) {
  const operator = role === "owner" || role === "operator";
  return (
    <>
      {overviewError && <Notice tone="danger" live title="The power facts could not be read">{overviewError}</Notice>}
      <UpsPanel role={role} start={start} ups={ups} upsError={upsError} onLookAgain={onLookAgain} overview={overview} />
      <EventsPanel overview={overview} />
      <WatchdogPanel role={role} operator={operator} start={start} hardware={hardware} error={hardwareError} loading={hardwareLoading} onRead={onReadHardware} />
      <PowerOnPanel role={role} operator={operator} start={start} overview={overview} hardware={hardware} loading={hardwareLoading} />
    </>
  );
}

function UpsPanel({ role, start, ups, upsError, onLookAgain, overview }: Pick<SystemPowerProps, "role" | "start" | "ups" | "upsError" | "onLookAgain" | "overview">) {
  const policy = overview?.policy ?? null;
  const reading = overview?.ups ?? null;
  const [shutdown, setShutdown] = useState(policy?.shutdownAtLowBattery ?? true);
  const [percent, setPercent] = useState("");
  const [runtime, setRuntime] = useState("");
  const device = ups?.devices[0] ?? null;
  const label = device ? upsLabel(device) : null;
  const description = (label ?? "UPS").replace(/[^A-Za-z0-9 ._()/-]/g, "").slice(0, 60) || "UPS";
  const watching = Boolean(reading?.configured && reading.available);
  const nutInstalled = Boolean(ups?.nutInstalled || reading?.installed);

  const percentValue = Number.parseInt(percent, 10);
  const percentValid = percent.trim() === "" || (/^\d+$/.test(percent.trim()) && percentValue >= 10 && percentValue <= 90);
  const runtimeValue = Number.parseInt(runtime, 10);
  const runtimeValid = runtime.trim() === "" || (/^\d+$/.test(runtime.trim()) && runtimeValue >= 2 && runtimeValue <= 30);
  const lowBatteryPercent = percent.trim() === "" ? null : percentValue;
  const lowRuntimeSeconds = runtime.trim() === "" ? null : runtimeValue * 60;
  const chosen = thresholdWords(lowBatteryPercent, lowRuntimeSeconds);

  const installNut = () => start({ operationId: "apt.install", title: "Install NUT (UPS tools)", parameters: { packages: ["nut"] }, preview: <span><code>apt-get install --no-install-recommends nut</code>. Come back here afterwards to set up monitoring.</span> });
  const setUpUps = () => device && start({
    operationId: "ups.setup",
    title: watching ? `Apply the UPS settings for ${label}` : `Set up monitoring for ${label}`,
    parameters: { driver: device.driver, vendorId: device.vendorId, productId: device.productId, description, shutdownAtLowBattery: shutdown, lowBatteryPercent, lowRuntimeSeconds },
    preview: (
      <div className="system-preview">
        <p>Writes <code>/etc/nut/</code> (driver <code>{device.driver}</code>, server on <code>127.0.0.1</code> only, a generated monitor password), starts the driver and the NUT services, and checks the UPS answers and the monitor is connected. Existing NUT files are kept as .before-boxpilot.</p>
        <p>{shutdown
          ? <>When the UPS says its battery is low{chosen ? <> (<b>{chosen}</b>, your thresholds)</> : " (by its own thresholds)"}, the apps stop and the drives unmount the way BoxPilot's reboot does them, for at most a minute; then the server powers off, and the UPS switches its outlets off until the mains returns.</>
          : "Shutdown is off: the power events are logged and shown, and the server runs until the battery is empty."}</p>
        <p>Every power event (on battery, back on mains, low battery, the shutdown) is logged for this page and Home.</p>
      </div>
    ),
  });

  const status = watching ? upsStateWords(reading?.state) : device ? { status: "neutral" as Status, label: "found" } : ups ? { status: "neutral" as Status, label: "none on USB" } : upsError ? { status: "unknown" as Status, label: "not read" } : undefined;
  const steps = [
    { id: "cable", label: "1. The USB data cable", done: Boolean(device) || watching, value: device ? `Found: ${label}` : watching ? "Connected" : ups ? "No UPS found on USB yet" : "Looking…" },
    { id: "nut", label: "2. The UPS tools (NUT)", done: nutInstalled, value: nutInstalled ? "Installed" : "Not installed" },
    { id: "watch", label: "3. Monitoring and a clean shutdown", done: watching, value: watching ? (policy?.shutdownAtLowBattery === false ? "Watching; shutdown is off" : "Watching; shuts down on a low battery") : reading?.configured ? "Set up, but the UPS is not answering" : "Not set up" },
  ];

  return (
    <Panel padded title="UPS" count={status} actions={<Button variant="ghost" onClick={onLookAgain}>Look again</Button>}>
      <div className="system-ups">
        {upsError && <Notice tone="danger" live title="Could not look for a UPS">{upsError}</Notice>}
        <KeyValue items={steps.map((step) => ({ id: step.id, label: step.label, value: step.value, status: step.done ? "good" : step.id === "watch" && reading?.configured ? "warning" : "neutral" }))} />
        {ups && !device && !watching && <EmptyState title="No UPS found on USB">Connect the data cable that came with the UPS, not just the power cord, wait a few seconds and look again. Network-managed UPSes (SNMP cards) are not detected automatically.</EmptyState>}
        {reading?.configured && (
          <KeyValue layout="columns" items={[
            { id: "power", label: "Power", status: upsStateWords(reading.state).status, value: upsStateWords(reading.state).label },
            { id: "battery", label: "Battery", mono: true, value: reading.batteryChargePercent === null ? "—" : `${reading.batteryChargePercent}%`, hint: reading.estimatedRuntimeSeconds ? `about ${minutes(reading.estimatedRuntimeSeconds)} left` : undefined },
            { id: "load", label: "Load", mono: true, value: reading.loadPercent === null ? "—" : `${reading.loadPercent}%` },
            { id: "low", label: "Low battery", value: thresholdWords(reading.lowBatteryPercent, reading.lowRuntimeSeconds) ?? "the UPS decides", hint: "when the shutdown starts" },
            { id: "shutdown", label: "Then", value: policy?.shutdownAtLowBattery === false ? "Nothing: shutdown is off" : "Apps stop, drives unmount, power off", hint: policy?.shutdownAtLowBattery === false ? undefined : `within ${policy?.preparationSeconds ?? 60} s, then the UPS cuts its outlets until the mains returns` },
          ]} />
        )}
        {device && (nutInstalled ? (
          mayStart(role, "ups.setup") && (
            <form className="system-form system-ups__form" onSubmit={(event) => { event.preventDefault(); if (percentValid && runtimeValid) setUpUps(); }}>
              <Checkbox label="Shut this server down when the battery is low" checked={shutdown} onChange={setShutdown} />
              <Field label="Low below (%)" optional hint="10 to 90. Empty: the UPS's own setting." error={percentValid ? undefined : "A whole number from 10 to 90"}>
                <TextInput mono inputMode="numeric" value={percent} onValueChange={(value) => setPercent(value.trim())} placeholder={reading?.lowBatteryPercent ? String(reading.lowBatteryPercent) : "20"} />
              </Field>
              <Field label="Or under (minutes left)" optional hint="2 to 30. The shutdown needs about 1." error={runtimeValid ? undefined : "A whole number from 2 to 30"}>
                <TextInput mono inputMode="numeric" value={runtime} onValueChange={(value) => setRuntime(value.trim())} placeholder={reading?.lowRuntimeSeconds ? String(Math.round(reading.lowRuntimeSeconds / 60)) : "5"} />
              </Field>
              <Button type="submit" variant="primary" risk={riskOf("ups.setup")} disabled={!percentValid || !runtimeValid}>{watching ? "Apply" : "Set up monitoring"}</Button>
            </form>
          )
        ) : mayStart(role, "apt.install") && <Button variant="primary" risk={riskOf("apt.install")} onClick={installNut}>Install NUT first</Button>)}
        <p className="system-note">Plug the UPS's USB cable into this server and BoxPilot sets up monitoring: its state on Home and here, every power event logged, and a clean shutdown before the battery runs out.</p>
      </div>
    </Panel>
  );
}

function EventsPanel({ overview }: { overview: PowerOverview | null }) {
  const events = overview?.events ?? [];
  const rows: EventRow[] = events.map((event, index) => ({ ...event, ...powerEventWords(event, events, index), key: `${event.at}-${event.event}-${index}` }));
  return (
    <Panel title="Power events" count={overview ? (rows.length ? rows.length : undefined) : undefined}>
      <Table<EventRow>
        caption="Power events, newest first"
        columns={[
          { id: "when", header: "When", cell: (row) => <span className="system-sub">{when(row.at)}</span> },
          // The battery has its own column; a detail that only repeats it is left out.
          { id: "what", header: "What happened", cell: (row) => <span className="system-event ui-marked" data-status={row.status}><span className="ui-mark" aria-hidden="true" /><span>{row.title}{row.detail && row.detail !== batteryWords(row) ? <span className="system-event__detail">{row.detail}</span> : null}</span></span> },
          { id: "battery", header: "Battery", hideOnPhone: true, cell: (row) => batteryWords(row) ?? "—" },
        ]}
        rows={rows}
        rowKey={(row) => row.key}
        empty={overview
          ? <EmptyState title="No power events yet">{overview.eventsAvailable === "unreadable" ? "The power-event log could not be read." : "Once a UPS is set up, every power cut, return of the mains and shutdown is listed here."}</EmptyState>
          : "Reading…"}
      />
    </Panel>
  );
}

function WatchdogPanel({ role, operator, start, hardware, error, loading, onRead }: { role: string; operator: boolean; start: StartOperation; hardware: PowerHardware | null; error: string | null; loading: boolean; onRead: () => void }) {
  const [seconds, setSeconds] = useState("60");
  const reading = hardware?.watchdog ?? null;
  const words = watchdogWords(reading);
  const hardwareDevice = (reading?.devices ?? []).find((device) => !device.software) ?? null;
  const enable = () => start({
    operationId: "power.watchdog.enable",
    title: "Turn on the hardware watchdog",
    parameters: { runtimeSeconds: Number(seconds) },
    preview: (
      <div className="system-preview">
        <p><b>From now on a hang causes an automatic reboot.</b> systemd tells the board's watchdog every few seconds that all is well; if the server freezes and that stops for {durationWords(Number(seconds) * 1000)}, the board restarts it, cutting off whatever was running as a power cut would. Apps start again with the server.</p>
        <p>Writes <code>/etc/systemd/system.conf.d/90-boxpilot-watchdog.conf</code> (RuntimeWatchdogSec={seconds}s, RebootWatchdogSec=10min){reading?.state === "loadable" || reading?.state === "configured-no-device" ? <>, loads <code>{reading.driver?.name}</code> now and at every boot</> : null}, reloads systemd and checks with <code>systemctl show</code> and <code>wdctl</code> that it runs. Undone if anything does not check out.</p>
      </div>
    ),
  });
  const disable = () => start({
    operationId: "power.watchdog.disable",
    title: "Turn off the hardware watchdog",
    parameters: {},
    preview: <span>Removes BoxPilot's watchdog files and reloads systemd. A frozen server then stays frozen until someone restarts it.</span>,
  });
  const canTurnOn = reading?.usable && reading.state !== "on";
  return (
    <Panel padded title="Watchdog" count={operator ? { status: words.status, label: words.label } : undefined}
      actions={operator ? <Button variant="ghost" busy={loading} onClick={onRead}>Read again</Button> : undefined}>
      <div className="system-ups">
        <p className="system-note">A watchdog is a timer on the board that restarts the server if it freezes, so a hang does not leave the house without its network until someone presses the button.</p>
        {!operator ? <Notice tone="info" title="Reading the watchdog is for an operator">It runs as root to read the kernel's drivers, so an owner or operator reads it.</Notice>
          : error ? <Notice tone="danger" live title="The watchdog could not be read" action={<Button onClick={onRead}>Try again</Button>}>{error}</Notice>
            : !hardware ? <p className="system-note">{loading ? "Reading…" : "Not read yet."}</p>
              : (
                <>
                  <p className="system-sub system-sentence">{words.sentence}</p>
                  {(hardwareDevice || reading?.state === "on") && (
                    <KeyValue layout="columns" items={[
                      { id: "device", label: "Device", mono: true, value: hardwareDevice ? `${hardwareDevice.device}` : "—", hint: hardwareDevice?.identity ?? undefined },
                      { id: "timeout", label: "Restarts after", mono: true, value: reading?.runtimeSeconds ? durationWords(reading.runtimeSeconds * 1000) : "—", hint: reading?.runtimeSeconds ? "of silence" : "not in use" },
                      { id: "reboot", label: "Hung reboot cut off after", mono: true, value: reading?.rebootSeconds ? durationWords(reading.rebootSeconds * 1000) : "—" },
                    ]} />
                  )}
                  {reading?.state === "on" && mayStart(role, "power.watchdog.disable") && (
                    <div className="system-form"><Button risk={riskOf("power.watchdog.disable")} onClick={disable}>Turn off</Button></div>
                  )}
                  {canTurnOn && mayStart(role, "power.watchdog.enable") && (
                    <form className="system-form system-ups__form" onSubmit={(event) => { event.preventDefault(); enable(); }}>
                      <Field label="Restart after the server is silent for" hint="60 seconds suits most servers.">
                        <Select value={seconds} onValueChange={setSeconds} options={[{ value: "60", label: "1 minute" }, { value: "120", label: "2 minutes" }, { value: "300", label: "5 minutes" }]} />
                      </Field>
                      <Button type="submit" variant="primary" risk={riskOf("power.watchdog.enable")}>Turn on</Button>
                    </form>
                  )}
                </>
              )}
      </div>
    </Panel>
  );
}

function WakeRow({ port, role, start }: { port: WakePort; role: string; start: StartOperation }) {
  const set = (on: boolean) => start({
    operationId: "power.wake-on-lan.set",
    title: on ? `Turn on Wake-on-LAN for ${port.name}` : `Turn off Wake-on-LAN for ${port.name}`,
    parameters: { interface: port.name, enabled: on },
    preview: on ? (
      <div className="system-preview">
        <p>After a clean shutdown, another device on your network can switch this server on by sending a "magic packet" to <code>{port.mac}</code>: your router's Wake-on-LAN page, a phone app, or another computer (<code>wakeonlan {port.mac}</code>).</p>
        <p>Writes <code>/etc/systemd/network/50-boxpilot-wake-on-lan-{port.name}.link</code> with the port's current naming rules and WakeOnLan=magic, checks with udev that it is the file that applies, and turns wake-on on now. The firmware may also need Wake-on-LAN ("Power On By PCI-E") on and ErP off. After the power was cut outright, most boards cannot be woken; the firmware setting above is what brings the server back then.</p>
      </div>
    ) : <span>Removes BoxPilot's .link file for <code>{port.name}</code> and turns wake-on off. Nothing can switch the server on over the network afterwards.</span>,
  });
  return (
    <div className="system-wake">
      <KeyValue layout="columns" items={[
        { id: "port", label: "Port", mono: true, value: port.name, hint: port.driver ?? undefined },
        { id: "mac", label: "Hardware address", mono: true, value: port.mac ? <span className="system-mac">{port.mac}<CopyButton value={port.mac} label="Copy" name={`${port.name}'s hardware address`} /></span> : "—" },
        { id: "wol", label: "Wake-on-LAN", status: port.magicOn ? "good" : "neutral", value: !port.supportsMagic ? "This port cannot" : port.magicOn ? "On" : "Off", hint: port.magicOn && !port.keptByBoxPilot ? "on now, not kept after a restart" : port.keptByBoxPilot ? "kept after a restart" : undefined },
      ]} />
      {port.supportsMagic && mayStart(role, "power.wake-on-lan.set") && (
        <Switch label={`Wake-on-LAN for ${port.name}`} description={port.magicOn ? "A magic packet to this address switches the server on." : "Let the router or another device switch the server on."} checked={port.magicOn && port.keptByBoxPilot} risk={riskOf("power.wake-on-lan.set")} onChange={set} />
      )}
    </div>
  );
}

function PowerOnPanel({ role, operator, start, overview, hardware, loading }: { role: string; operator: boolean; start: StartOperation; overview: PowerOverview | null; hardware: PowerHardware | null; loading: boolean }) {
  const guidance = overview?.guidance ?? null;
  const mine = guidance?.steps.find((step) => step.thisBoard) ?? null;
  const others = guidance?.steps.filter((step) => !step.thisBoard) ?? [];
  const ports = hardware?.wakeOnLan.ports ?? [];
  return (
    <Panel padded id="power-on" title="After a power cut" label="Power back on after an outage">
      <div className="system-ups">
        {!guidance ? <p className="system-note">Reading…</p> : (
          <>
            <p className="system-lead"><b>{guidance.title}.</b> {guidance.summary}</p>
            {mine && (
              <div className="system-board">
                <p className="system-sub">This board: {guidance.board?.vendor}</p>
                <p className="system-step"><Tag tone="info">{mine.maker}</Tag> Press <kbd>{mine.key}</kbd> while it starts, then <b>{mine.path.join(" › ")}</b>, and choose <b>{mine.value}</b>. Save and exit (usually F10).</p>
              </div>
            )}
            <details className="system-details" open={!mine}>
              <summary>{mine ? "Other makers" : "Where the setting is, by maker"}</summary>
              <ul className="system-guide">
                {others.map((step) => <li key={step.id}><b>{step.maker}:</b> press <kbd>{step.key}</kbd>, then {step.path.join(" › ")} → {step.value}</li>)}
                <li>{guidance.other}</li>
              </ul>
            </details>
            <ul className="system-guide">{guidance.why.map((line) => <li key={line}>{line}</li>)}</ul>
          </>
        )}
        <h3 className="system-subhead">Wake-on-LAN</h3>
        <p className="system-note">{guidance?.alsoHelps ?? "Wake-on-LAN lets another device on your network start the server after a clean shutdown."}</p>
        {!operator ? <p className="system-note">An owner or operator can read and set each network port's Wake-on-LAN.</p>
          : !hardware ? <p className="system-note">{loading ? "Reading the network ports…" : "The network ports have not been read."}</p>
            : !hardware.wakeOnLan.ethtool ? <Notice tone="info" title="ethtool is not installed">Install the ethtool package from Updates to read and set Wake-on-LAN.</Notice>
              : ports.length === 0 ? <EmptyState title="No wired network port">Wake-on-LAN needs a wired port; Wi-Fi cannot wake a server that is off.</EmptyState>
                : ports.map((port) => <WakeRow key={port.name} port={port} role={role} start={start} />)}
      </div>
    </Panel>
  );
}
