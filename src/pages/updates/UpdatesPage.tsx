import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import SnapshotFirstButton from "../../SnapshotFirstButton";
import { countOf } from "../../data";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, EmptyState, Field, MetricTile, Notice, PageHeader, Panel, Table, Tabs, Tag, TextInput, Toolbar, mayStart, riskOf, type Status, type TableColumn } from "../../ui";
import "./updates.css";

/*
 * Updates and packages (M33.11), rebuilt in the console on the kit. Facts first: whether anything
 * waits, a reboot, and automatic updates, in the header and the strip under it; then the services
 * still running old libraries, when there are any; then the three jobs the page does, one tab
 * each: the upgradable packages, the common tools, and installing anything else. Every button
 * that runs something carries its tier and goes through the approval dialog, as before.
 */

interface UpgradablePackage { name: string; suite: string; candidate: string; installed: string; architecture: string; source?: string }
interface UpgradableReport {
  upgradable: UpgradablePackage[];
  count: number;
  securityCount: number;
  rebootRequired: boolean;
  needrestartPresent?: boolean;
  servicesNeedingRestart?: string[] | null;
  needrestartCheckedAt?: string | null;
}
interface UnattendedReport { installed: boolean; enabled: boolean }
interface CuratedTool { name: string; installed: boolean; version: string | null }
interface CuratedReport { packages: CuratedTool[] }
type Tab = "packages" | "tools" | "install";

const curatedDescriptions: Record<string, string> = {
  htop: "interactive process viewer", btop: "modern resource monitor", tmux: "terminal multiplexer",
  git: "version control", curl: "HTTP client", wget: "file downloader", jq: "JSON processor",
  ncdu: "disk usage explorer", tree: "directory trees", ripgrep: "fast text search (rg)", zsh: "Z shell",
  unzip: "zip extraction", "net-tools": "ifconfig and netstat", dnsutils: "dig and nslookup",
  iotop: "disk I/O monitor", smartmontools: "disk SMART health", restic: "backup engine",
  "nfs-common": "NFS mounts", "cifs-utils": "SMB/CIFS mounts", smbclient: "lists SMB shares on a NAS", samba: "SMB file server (Storage page)", "nfs-kernel-server": "NFS server (Storage page)", nut: "UPS monitoring (System page)", fail2ban: "SSH brute-force protection (Firewall page)", rclone: "cloud backup mirror (Backups page)", needrestart: "finds services running old libraries",
};

const isSecurity = (item: UpgradablePackage) => /security/i.test(item.suite);
/** A unit systemctl can restart by name; anything else is refreshed by a reboot. */
const restartable = (unit: string) => /^[A-Za-z0-9:._@\\-]{1,200}\.service$/.test(unit);

export interface UpdatesPageProps {
  csrfToken: string;
  /** Who is signed in: a viewer sees what waits and runs nothing. */
  role?: string;
}

export default function UpdatesPage({ csrfToken, role = "owner" }: UpdatesPageProps) {
  const [report, setReport] = useState<UpgradableReport | null>(null);
  const [unattended, setUnattended] = useState<UnattendedReport | null>(null);
  const [curated, setCurated] = useState<CuratedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customPackages, setCustomPackages] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [upgradable, unattendedResult, curatedResult] = await Promise.all([
        inspectOperation<UpgradableReport>("apt.upgradable.inspect"),
        inspectOperation<UnattendedReport>("apt.unattended.inspect").catch(() => null),
        inspectOperation<CuratedReport>("packages.curated.inspect").catch(() => null),
      ]);
      const result = { ...upgradable.result, upgradable: upgradable.result.upgradable ?? [], count: upgradable.result.count ?? upgradable.result.upgradable?.length ?? 0, securityCount: upgradable.result.securityCount ?? 0 };
      setReport(result);
      setUnattended(unattendedResult?.result && typeof unattendedResult.result.enabled === "boolean" ? unattendedResult.result : null);
      setCurated(curatedResult?.result && Array.isArray(curatedResult.result.packages) ? curatedResult.result : null);
      setSelected((current) => new Set([...current].filter((name) => result.upgradable.some((item) => item.name === name))));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read available updates");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });
  const may = (operationId: string) => mayStart(role, operationId);

  const packages = useMemo(() => report?.upgradable ?? [], [report]);
  const selectedList = useMemo(() => [...selected].sort(), [selected]);
  const toggle = (name: string) => setSelected((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const allSelected = packages.length > 0 && packages.every((item) => selected.has(item.name));
  const someSelected = selected.size > 0 && !allSelected;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(packages.map((item) => item.name)));
  const customList = useMemo(() => customPackages.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean), [customPackages]);

  // What is known about updates, said first. Nothing read yet is unknown, never "up to date".
  const securityCount = report?.securityCount ?? 0;
  const verdict: { status: Status; label: string } = !report
    ? { status: "unknown", label: loading ? "Checking…" : "Not read" }
    : report.count === 0 ? { status: "good", label: "Up to date" }
      : securityCount > 0 ? { status: "warning", label: countOf(securityCount, "security update") }
        : { status: "neutral", label: `${report.count} waiting` };
  const restarts = report?.servicesNeedingRestart ?? [];
  const toolsInstalled = curated?.packages.filter((tool) => tool.installed).length ?? 0;

  const reboot = () => start({ operationId: "system.reboot", title: "Reboot the server", parameters: {}, preview: <span>First stops the apps using BoxPilot's drives and unmounts the drives, saying in the log which let go cleanly, then reboots 5 seconds later. Running VMs and containers stop and the apps start again by themselves; reconnect when this server is back.</span> });
  const setAutomatic = (enabled: boolean) => start({
    operationId: "apt.unattended.set",
    title: enabled ? "Turn on automatic updates" : "Turn off automatic updates",
    parameters: { enabled },
    preview: enabled
      ? <span>{unattended?.installed ? "" : "Installs unattended-upgrades, then "}sets <code>APT::Periodic::Unattended-Upgrade "1"</code> so security updates install nightly.</span>
      : <span>Sets <code>APT::Periodic::Unattended-Upgrade "0"</code>. You install updates from this page instead.</span>,
  });

  const packageColumns: Array<TableColumn<UpgradablePackage>> = [
    {
      id: "package", header: "Package", sortValue: (item) => item.name, cell: (item) => (
        <span className="updates-package">
          {may("apt.upgrade") && <Checkbox className="updates-check" label={<span className="ui-visually-hidden">Select {item.name}</span>} checked={selected.has(item.name)} onChange={() => toggle(item.name)} />}
          <a className="updates-package__link" href={`https://launchpad.net/ubuntu/+source/${encodeURIComponent(item.source ?? item.name)}/+changelog`} target="_blank" rel="noreferrer" title="Changelog on Launchpad"><code>{item.name}</code></a>
          {isSecurity(item) && <Tag tone="warning" title="A security update">security</Tag>}
        </span>
      ),
    },
    { id: "installed", header: "Installed", hideOnPhone: true, cell: (item) => <span className="updates-version">{item.installed}</span> },
    { id: "candidate", header: "Available", cell: (item) => <span className="updates-version">{item.candidate}</span> },
    { id: "suite", header: "Source", hideOnPhone: true, sortValue: (item) => (isSecurity(item) ? 0 : 1), cell: (item) => <span className="updates-version">{item.suite}</span> },
  ];

  const toolColumns: Array<TableColumn<CuratedTool>> = [
    {
      id: "tool", header: "Tool", sortValue: (tool) => tool.name, cell: (tool) => (
        <span className="updates-tool">
          <code>{tool.name}</code>
          {curatedDescriptions[tool.name] && <span className="updates-tool__what">{curatedDescriptions[tool.name]}</span>}
        </span>
      ),
    },
    { id: "state", header: "State", sortValue: (tool) => (tool.installed ? 0 : 1), cell: (tool) => (tool.installed ? <Tag tone="good">{tool.version ? `installed ${tool.version}` : "installed"}</Tag> : <Tag>not installed</Tag>) },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "updates-actions-cell", cell: (tool) => (
        <span className="updates-actions">
          {tool.installed
            ? may("apt.remove") && <Button risk={riskOf("apt.remove")} aria-label={`Remove ${tool.name}`} onClick={() => start({ operationId: "apt.remove", title: `Remove ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span>Removes {tool.name} ({tool.version}) and anything only it needed.</span> })}>Remove</Button>
            : may("apt.install") && <Button risk={riskOf("apt.install")} aria-label={`Install ${tool.name}`} onClick={() => start({ operationId: "apt.install", title: `Install ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span><code>apt-get install --no-install-recommends {tool.name}</code></span> })}>Install</Button>}
        </span>
      ),
    },
  ];

  const tabs = [
    { id: "packages" as const, label: "Packages", count: report ? report.count : undefined, status: securityCount ? "warning" as const : undefined, statusLabel: securityCount ? countOf(securityCount, "security update") : undefined },
    { id: "tools" as const, label: "Common tools", count: curated ? `${toolsInstalled}/${curated.packages.length}` : undefined },
    { id: "install" as const, label: "Install" },
  ];

  return (
    <div className="updates-page">
      {dialog}
      <PageHeader
        title="Updates"
        status={verdict}
        meta={report ? <><b>{report.count}</b> upgradable · <b>{securityCount}</b> security · reboot <b>{report.rebootRequired ? "required" : "not needed"}</b>{unattended ? <> · automatic updates <b>{unattended.enabled ? "on" : "off"}</b></> : null}</> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(report)}>Read again</Button>}
        about={<>
          <p>What Ubuntu wants to update, and a way to install it: all of it, or the packages you tick. Automatic updates install security fixes every night by themselves.</p>
          <p>Common tools installs the packages most servers want with one confirmation; Install takes any other package by name, without its recommends.</p>
        </>}
      />

      <section className="updates-strip" aria-label="Updates, reboot and automatic updates">
        <MetricTile
          label="Available updates"
          value={loading && !report ? "…" : report?.count ?? "—"}
          caption={!report ? (loading ? "Checking for updates" : "Not read") : securityCount ? `${securityCount} security` : "packages"}
          status={verdict.status}
        />
        <MetricTile
          label="Reboot"
          value={!report ? "—" : report.rebootRequired ? "Required" : "Not needed"}
          caption={!report ? (loading ? "Checking for updates" : "Not read") : report.rebootRequired ? "A kernel or core library changed" : "Nothing pending a restart"}
          status={!report ? "unknown" : report.rebootRequired ? "warning" : "good"}
        >
          {report?.rebootRequired && may("system.reboot") && <Button risk={riskOf("system.reboot")} onClick={reboot}>Reboot now</Button>}
        </MetricTile>
        <MetricTile
          label="Automatic updates"
          value={loading && !unattended ? "…" : !unattended ? "—" : unattended.enabled ? "On" : "Off"}
          caption={!unattended ? (loading ? "Reading the setting" : "Could not read the setting") : unattended.enabled ? "Security upgrades install nightly" : "Security upgrades wait for you"}
          status={!unattended ? "unknown" : unattended.enabled ? "good" : "neutral"}
        >
          {unattended && may("apt.unattended.set") && (
            <Button risk={riskOf("apt.unattended.set")} disabled={loading} aria-label={unattended.enabled ? "Turn off automatic updates" : "Turn on automatic updates"} onClick={() => setAutomatic(!unattended.enabled)}>
              {unattended.enabled ? "Turn off" : "Turn on"}
            </Button>
          )}
        </MetricTile>
      </section>

      {error && <Notice tone="danger" live title="Available updates could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      {report?.needrestartPresent && report.servicesNeedingRestart === null && (
        <Notice tone="warning" title="The running-library check did not finish">Read again to try it once more. The package updates below are still current.</Notice>
      )}

      {restarts.length > 0 && (
        <Panel
          className="updates-restarts"
          title="Running old libraries"
          count={{ status: "warning", label: `${restarts.length} to restart` }}
          meta={report?.needrestartCheckedAt ? `checked ${new Date(report.needrestartCheckedAt).toLocaleString()}` : undefined}
          footer="These kept the pre-upgrade code in memory: restart them when convenient, or reboot to refresh everything."
        >
          <ul className="updates-restarts__list">
            {restarts.map((unit) => (
              <li key={unit} className="updates-restarts__row">
                <code>{unit}</code>
                {unit === "systemd-manager"
                  ? may("system.manager.reexec") && <Button risk={riskOf("system.manager.reexec")} onClick={() => start({ operationId: "system.manager.reexec", title: "Refresh systemd manager", parameters: {}, preview: <span>Re-executes the system manager to load updated libraries while preserving its state. Runs <code>systemctl daemon-reexec</code>.</span> })}>Refresh systemd manager</Button>
                  : !restartable(unit)
                    ? <span className="updates-note">Reboot the server to refresh this process.</span>
                    : may("service.action") && <Button risk={riskOf("service.action")} onClick={() => start({ operationId: "service.action", title: `Restart ${unit}`, parameters: { unit, action: "restart" }, preview: <span><code>systemctl restart {unit}</code></span> })}>Restart {unit}</Button>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Tabs<Tab> label="Updates and packages" urlParam="tab" tabs={tabs} className="updates-tabs">
        {(tab) => (
          tab === "packages" ? (
            <Panel className="updates-packages" title="Upgradable" count={report ? report.count : undefined} meta={report ? `${securityCount} security · ${selectedList.length} selected` : undefined}>
              {(may("apt.upgrade") || may("apt.refresh")) && (
                <Toolbar
                  label="Upgradable packages"
                  className="updates-toolbar"
                  filters={may("apt.upgrade") ? <Checkbox label={<>Select all<span className="ui-visually-hidden"> packages</span></>} checked={allSelected} indeterminate={someSelected} disabled={packages.length === 0} onChange={toggleAll} /> : undefined}
                  actions={<>
                    {may("apt.refresh") && <Button risk={riskOf("apt.refresh")} disabled={loading} onClick={() => start({ operationId: "apt.refresh", title: "Refresh package lists", parameters: {}, preview: <span>Runs <code>apt-get update</code>. Installs nothing.</span> })}>Refresh lists</Button>}
                    {may("storage.lvm.snapshot.create") && <SnapshotFirstButton start={start} />}
                    {may("apt.upgrade") && <Button risk={riskOf("apt.upgrade")} disabled={selectedList.length === 0} onClick={() => start({ operationId: "apt.upgrade", title: `Upgrade ${countOf(selectedList.length, "selected package")}`, parameters: { packages: selectedList }, preview: <span>{selectedList.join(", ")}</span> })}>Upgrade selected ({selectedList.length})</Button>}
                    {may("apt.upgrade") && <Button variant="primary" risk={riskOf("apt.upgrade")} disabled={loading || !report?.count} onClick={() => start({ operationId: "apt.upgrade", title: "Install all updates", parameters: {}, preview: <span>Upgrades {countOf(report?.count ?? 0, "package")} with <code>apt-get upgrade --with-new-pkgs</code> after refreshing the lists.</span> })}>Install all updates</Button>}
                  </>}
                />
              )}
              <Table
                caption="Upgradable packages"
                columns={packageColumns}
                rows={packages}
                rowKey={(item) => item.name}
                rowStatus={(item) => (isSecurity(item) ? "warning" : undefined)}
                empty={!report
                  ? (loading ? "Checking for updates…" : "The updates could not be read.")
                  : <EmptyState title="Everything is up to date.">Refresh lists asks Ubuntu's mirrors again.</EmptyState>}
              />
            </Panel>
          ) : tab === "tools" ? (
            <Panel className="updates-tools" title="Common tools" count={curated ? `${toolsInstalled} of ${curated.packages.length} installed` : undefined}>
              <Table
                caption="Common tools"
                columns={toolColumns}
                rows={curated?.packages ?? []}
                rowKey={(tool) => tool.name}
                empty={loading && !curated ? "Reading which tools are installed…" : "The list of common tools could not be read."}
              />
            </Panel>
          ) : (
            <Panel padded className="updates-install" title="Install packages">
              <Field label="Package names" hint="Any Ubuntu package, installed without its recommends. Separate names with spaces or commas.">
                <TextInput mono placeholder="htop git tmux" value={customPackages} onValueChange={setCustomPackages} autoCapitalize="off" spellCheck={false} />
              </Field>
              <div className="updates-install__actions">
                {may("apt.install") && <Button variant="primary" risk={riskOf("apt.install")} disabled={customList.length === 0} onClick={() => start({ operationId: "apt.install", title: `Install ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span><code>apt-get install --no-install-recommends {customList.join(" ")}</code></span> })}>Install</Button>}
                {may("apt.remove") && <Button risk={riskOf("apt.remove")} disabled={customList.length === 0} onClick={() => start({ operationId: "apt.remove", title: `Remove ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span>Removes the packages and anything only they needed. Configuration files are kept.</span> })}>Remove</Button>}
                {may("apt.autoremove") && <Button risk={riskOf("apt.autoremove")} onClick={() => start({ operationId: "apt.autoremove", title: "Remove unused packages", parameters: {}, preview: <span><code>apt-get autoremove --purge</code></span> })}>Remove unused packages</Button>}
              </div>
              {!may("apt.install") && <p className="updates-note">Installing and removing packages needs an operator.</p>}
            </Panel>
          )
        )}
      </Tabs>
    </div>
  );
}
