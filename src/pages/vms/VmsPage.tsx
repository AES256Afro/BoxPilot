import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { countOf } from "../../data";
import { Button, EmptyState, Notice, PageHeader, Panel, StatusChip, Table, Tabs, Tag, mayStart, riskOf, useUrlParam, type TableColumn } from "../../ui";
import {
  fetchLibvirtFoundation, fetchVirtualization, fetchVmExports, fetchVmProtection, fetchVmRecoveries, fetchVmRetention, formatMemory,
  type ConsoleGuidance, type DomainList, type LibvirtFoundation, type LibvirtResources, type VirtualDomain, type VirtualizationStatus,
} from "../../virtualization";
import { CloudVmSheet, PlanVmSheet } from "./NewVmSheets";
import { useVmStats, gibFromKiB, rateLabel } from "./useVmStats";
import { VmBackups, type VmBackupData } from "./VmBackups";
import { foundationState, VmHost } from "./VmHost";
import { VmMedia } from "./VmMedia";
import { VmSheet } from "./VmSheet";
import { lifecycle, stateOf, unmanagedNote, vmAction, type StartOperation } from "./vmActions";
import "./vms.css";

/*
 * Virtual machines (M33.12), rebuilt on the kit in the console's look with every feature the
 * Classic page had. Facts first: the verdict and the counts in the header, then four tabs, one per
 * job: the machines (each opens a sheet with its facts, snapshots and every action), their backups
 * (export, encrypted copy, test restore, recovery clone, retention), the installation media, and
 * the host (preflight, the default network and pool, libvirt, setup commands, remote access). The
 * two ways to make a VM are sheets. High-risk actions say before the click that they ask for the
 * password and the VM's name typed out.
 */

const tabIds = ["machines", "backups", "media", "host"] as const;
type TabId = (typeof tabIds)[number];
type SheetState = { kind: "vm"; name: string } | { kind: "cloud" } | { kind: "plan" } | null;

const emptyBackups: VmBackupData = { exports: [], destination: null, backups: [], retention: null, recoveries: [], unread: [] };

export interface VmsPageProps {
  csrfToken?: string;
  /** Who is signed in: a viewer sees the machines and no actions; high-risk ones are the owner's. */
  role?: string;
  onOpenRepair?: () => void;
}

export default function VmsPage({ csrfToken = "", role = "owner", onOpenRepair = () => {} }: VmsPageProps) {
  const [status, setStatus] = useState<VirtualizationStatus | null>(null);
  const [domainList, setDomainList] = useState<DomainList | null>(null);
  const [resources, setResources] = useState<LibvirtResources | null>(null);
  const [foundation, setFoundation] = useState<LibvirtFoundation | null>(null);
  const [guidance, setGuidance] = useState<ConsoleGuidance | null>(null);
  const [backups, setBackups] = useState<VmBackupData>(emptyBackups);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [mediaKey, setMediaKey] = useState(0);
  const [tab, setTab] = useUrlParam<TabId>("tab", tabIds, "machines");
  const rates = useVmStats();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [[nextStatus, nextDomains, nextResources, nextGuidance], nextFoundation, exportsRead, protectionRead, recoveriesRead, retentionRead] = await Promise.all([
        fetchVirtualization(),
        fetchLibvirtFoundation(),
        // These four are extras: if one cannot be read the page still shows the VMs, and says so.
        fetchVmExports().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmProtection().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmRecoveries().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmRetention().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
      ]);
      setStatus(nextStatus);
      setDomainList(nextDomains);
      setResources(nextResources);
      setGuidance(nextGuidance);
      setFoundation(nextFoundation);
      setBackups({
        exports: exportsRead.value ?? [],
        destination: protectionRead.value?.destination ?? null,
        backups: Array.isArray(protectionRead.value?.backups) ? protectionRead.value.backups : [],
        recoveries: recoveriesRead.value ?? [],
        retention: retentionRead.value,
        unread: [
          ...(exportsRead.read ? [] : ["exports"]),
          ...(protectionRead.read ? [] : ["the encrypted destination"]),
          ...(recoveriesRead.read ? [] : ["recoveries"]),
          ...(retentionRead.read ? [] : ["retention"]),
        ],
      });
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load virtualization status");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start: startOperation, dialog } = useOperation(csrfToken, () => { void refresh(); setMediaKey((key) => key + 1); });
  // Starting anything closes the sheet it was pressed in, so the approval dialog is alone on screen.
  const start: StartOperation = useCallback((operation) => { setSheet(null); startOperation(operation); }, [startOperation]);

  const domains = domainList?.domains ?? [];
  const running = domains.filter((domain) => domain.state === "running").length;
  const odd = domains.filter((domain) => domain.state !== "running" && domain.state !== "stopped").length;
  const passed = status?.checks.filter((check) => check.ok).length ?? 0;
  const hostSetup = foundationState(foundation);
  const hostNeedsLook = Boolean(status && (!status.ready || passed < status.checks.length || !foundation?.ready));
  const canCloud = Boolean(status?.ready) && mayStart(role, "vm.cloud.create");
  const canPlan = mayStart(role, "vm.create");

  const verdict = !status ? (error ? { status: "unknown" as const, label: "Not read" } : { status: "unknown" as const, label: "Reading…" })
    : !status.ready ? { status: "warning" as const, label: "Host needs setup" }
      : !domainList?.connected ? { status: "danger" as const, label: "libvirt not connected" }
        : odd ? { status: "warning" as const, label: `${odd} need${odd === 1 ? "s" : ""} a look` }
          : { status: "good" as const, label: "Host ready" };

  const newButtons = (
    <>
      {canCloud && <Button onClick={() => setSheet({ kind: "cloud" })}>From a cloud image</Button>}
      {canPlan && <Button onClick={() => setSheet({ kind: "plan" })}>Plan from an ISO</Button>}
    </>
  );

  const risk = riskOf("vm.action");
  const columns: Array<TableColumn<VirtualDomain>> = [
    {
      id: "vm", header: "VM", sortValue: (domain) => domain.name, cell: (domain) => (
        <span className="vms-cell">
          <span className="vms-name">
            <button type="button" className="vms-open" onClick={() => setSheet({ kind: "vm", name: domain.name })}>{domain.name}</button>
            {domain.autostart && <Tag title="Starts when this server boots">autostart</Tag>}
            {!domain.managed && <Tag tone="warning" title={unmanagedNote}>virsh only</Tag>}
          </span>
          <span className="vms-sub">{domain.vcpus} vCPU · {formatMemory(domain.memoryKiB)}</span>
        </span>
      ),
    },
    { id: "state", header: "State", sortValue: (domain) => (domain.state === "running" ? 0 : domain.state === "stopped" ? 2 : 1), cell: (domain) => { const state = stateOf(domain.state); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
    { id: "address", header: "Address", cell: (domain) => (domain.addresses.length ? <code>{domain.addresses.map((address) => address.address).join(", ")}</code> : <span className="vms-dim">none leased</span>) },
    { id: "cpu", header: "CPU", numeric: true, hideOnPhone: true, cell: (domain) => { const rate = rates[domain.name]; return domain.state !== "running" || !rate ? "—" : rate.cpuPercent === null ? "…" : `${rate.cpuPercent.toFixed(0)}%`; } },
    { id: "memory", header: "Memory", numeric: true, hideOnPhone: true, cell: (domain) => { const rate = rates[domain.name]; return domain.state === "running" && rate?.memoryKiB ? `${gibFromKiB(rate.memoryKiB)}${rate.memoryMaxKiB ? ` / ${gibFromKiB(rate.memoryMaxKiB)}` : ""}` : "—"; } },
    { id: "io", header: "Disk · net", numeric: true, hideOnPhone: true, cell: (domain) => { const rate = rates[domain.name]; return domain.state === "running" && rate ? `${rateLabel(rate.diskBytesPerSecond)} · ${rateLabel(rate.netBytesPerSecond)}` : "—"; } },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "vms-actions-cell", cell: (domain) => (
        <span className="vms-actions">
          {domain.managed && mayStart(role, "vm.action") && (domain.state === "running" ? (
            <>
              <Button risk={risk} onClick={() => start(vmAction(domain, "shutdown"))} aria-label={`Shut down ${domain.name}`}>{lifecycle.shutdown.label}</Button>
              <Button risk={risk} onClick={() => start(vmAction(domain, "reboot"))} aria-label={`Reboot ${domain.name}`}>{lifecycle.reboot.label}</Button>
            </>
          ) : domain.state === "stopped" ? <Button risk={risk} onClick={() => start(vmAction(domain, "start"))} aria-label={`Start ${domain.name}`}>{lifecycle.start.label}</Button> : null)}
          <Button variant="ghost" onClick={() => setSheet({ kind: "vm", name: domain.name })} aria-label={`Open ${domain.name}`}>Open</Button>
        </span>
      ),
    },
  ];

  const openDomain = sheet?.kind === "vm" ? domains.find((domain) => domain.name === sheet.name) ?? null : null;
  const protectedCount = backups.backups.filter((backup) => backup.protected && backup.retained !== false).length;

  return (
    <div className="vms-page">
      {dialog}
      <PageHeader
        title="Virtual Machines"
        status={verdict}
        meta={status ? <><b>{domains.length}</b> {domains.length === 1 ? "VM" : "VMs"} · <b>{running}</b> running · <b>{passed}/{status.checks.length}</b> checks · {status.connectionUri}</> : undefined}
        actions={<>
          <Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(status)}>Read again</Button>
          {newButtons}
        </>}
        about={<>
          <p>QEMU/KVM virtual machines through libvirt: make one from a cloud image or plan one from an ISO, start, stop and snapshot it, export it, keep an encrypted copy off this server, prove it restores, and recover it as a clone.</p>
          <p>Starting, stopping and snapshotting a VM asks you to confirm, with the exact change shown first. Creating one from an ISO, deleting one and reverting a snapshot ask for your password and the VM's name typed out.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="Virtualization status is unavailable" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      {!status ? (
        !error && <Panel padded title="Host"><p className="vms-note">Inspecting QEMU, KVM and libvirt…</p></Panel>
      ) : (
        <Tabs<TabId>
          label="Virtual machines"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "machines", label: "Machines", count: domainList?.connected ? domains.length : undefined, status: odd ? "warning" : undefined, statusLabel: odd ? `${odd} need a look` : undefined },
            { id: "backups", label: "Backups", count: backups.backups.length || undefined, status: backups.unread.length ? "unknown" : undefined, statusLabel: backups.unread.length ? "not all read" : undefined },
            { id: "media", label: "Media" },
            { id: "host", label: "Host", status: hostNeedsLook ? "warning" : "good", statusLabel: hostNeedsLook ? "needs a look" : "ready" },
          ]}
        >
          {(current) => current === "machines" ? (
            <Panel className="vms-machines" title="Machines" count={domainList?.connected ? domains.length : undefined}
              meta={domainList?.connected ? `${running} running · live from libvirt` : undefined}
              footer={domainList?.connected && domains.length > 0 ? `${countOf(protectedCount, "VM copy", "VM copies")} restore-tested · default network and pool ${hostSetup.label.toLowerCase()}` : undefined}>
              {!domainList?.connected ? (
                <EmptyState title="libvirt is not connected" action={<Button onClick={() => setTab("host")}>Open the Host tab</Button>}>
                  {domainList?.error ?? "Complete the host checks, then read again."}
                </EmptyState>
              ) : (
                <Table
                  caption="Virtual machines"
                  columns={columns}
                  rows={domains}
                  rowKey={(domain) => domain.uuid ?? domain.name}
                  rowStatus={(domain) => (domain.state !== "running" && domain.state !== "stopped" ? "warning" : undefined)}
                  defaultSort={{ column: "state", direction: "ascending" }}
                  empty={<EmptyState title="No virtual machines yet" action={canCloud || canPlan ? newButtons : undefined}>Make one from a cloud image, or add an ISO on the Media tab and plan one from it. BoxPilot shows the machine it will define before it defines it.</EmptyState>}
                />
              )}
            </Panel>
          ) : current === "backups" ? (
            <VmBackups data={backups} role={role} start={start} />
          ) : current === "media" ? (
            <VmMedia csrfToken={csrfToken} role={role} start={start} refreshKey={mediaKey} />
          ) : (
            <VmHost status={status} foundation={foundation} resources={resources} guidance={guidance} role={role} start={start} onOpenRepair={onOpenRepair} />
          )}
        </Tabs>
      )}

      {openDomain && <VmSheet domain={openDomain} rate={rates[openDomain.name]} role={role} onClose={() => setSheet(null)} start={start} />}
      {sheet?.kind === "cloud" && <CloudVmSheet onClose={() => setSheet(null)} start={start} />}
      {sheet?.kind === "plan" && (
        <PlanVmSheet csrfToken={csrfToken} onClose={() => setSheet(null)} onStage={(input) => start({
          operationId: "vm.create",
          title: `Create VM ${input.name}`,
          parameters: { ...input },
          // High risk: the password, and the new VM's name typed out, as for deleting one.
          confirmText: input.name,
          preview: <span>Creates <code>{input.name}</code> exactly as planned through the restricted helper, {input.vcpus} vCPU, {formatMemory(input.memoryMiB * 1024)} RAM, {input.diskGiB} GiB disk from <code>{input.isoFile}</code>. Checked against the live host first. If it fails, the new VM and its disks are removed.</span>,
        })} />
      )}
    </div>
  );
}
