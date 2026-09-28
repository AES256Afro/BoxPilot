import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "./ApproveDialog";
import SnapshotFirstButton from "./SnapshotFirstButton";
import { countOf } from "./data";
import { inspectOperation } from "./operations";
import { Button, Card, MetricTile, Section, StatusChip, riskOf, type Status } from "./ui";

interface UpgradablePackage {
  name: string;
  suite: string;
  candidate: string;
  installed: string;
  architecture: string;
  source?: string;
}

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
interface CuratedReport { packages: Array<{ name: string; installed: boolean; version: string | null }> }

const curatedDescriptions: Record<string, string> = {
  htop: "interactive process viewer", btop: "modern resource monitor", tmux: "terminal multiplexer",
  git: "version control", curl: "HTTP client", wget: "file downloader", jq: "JSON processor",
  ncdu: "disk usage explorer", tree: "directory trees", ripgrep: "fast text search (rg)", zsh: "Z shell",
  unzip: "zip extraction", "net-tools": "ifconfig and netstat", dnsutils: "dig and nslookup",
  iotop: "disk I/O monitor", smartmontools: "disk SMART health", restic: "backup engine",
  "nfs-common": "NFS mounts", "cifs-utils": "SMB/CIFS mounts", smbclient: "lists SMB shares on a NAS", samba: "SMB file server (Storage page)", "nfs-kernel-server": "NFS server (Storage page)", nut: "UPS monitoring (System page)", fail2ban: "SSH brute-force protection (Firewall page)", rclone: "cloud backup mirror (Backups page)", needrestart: "finds services running old libraries",
};

/**
 * Updates and packages, the first page built on the design system (M33.1): each figure says its
 * status first, each button shows its risk tier, and nothing that has not been read yet is drawn
 * as fine. Every action still goes through the one approval dialog.
 */
export default function UpdatesCenter({ csrfToken }: { csrfToken: string }) {
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
      setReport(upgradable.result);
      setUnattended(unattendedResult?.result && typeof unattendedResult.result.enabled === "boolean" ? unattendedResult.result : null);
      setCurated(curatedResult?.result && Array.isArray(curatedResult.result.packages) ? curatedResult.result : null);
      setSelected((current) => new Set([...current].filter((name) => upgradable.result.upgradable.some((item) => item.name === name))));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read available updates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  const selectedList = useMemo(() => [...selected].sort(), [selected]);
  const toggle = (name: string) => setSelected((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const allNames = useMemo(() => (report?.upgradable ?? []).map((item) => item.name), [report]);
  const allSelected = allNames.length > 0 && allNames.every((name) => selected.has(name));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allNames));
  const customList = useMemo(() => customPackages.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean), [customPackages]);

  // What is known about updates, said first. Nothing read yet is unknown, never "up to date".
  const securityCount = report?.securityCount ?? 0;
  const updates: { status: Status; label: string } = !report
    ? { status: "unknown", label: loading ? "Checking" : "Not read" }
    : report.count === 0 ? { status: "good", label: "Up to date" }
      : securityCount > 0 ? { status: "warning", label: countOf(securityCount, "security update") }
        : { status: "neutral", label: `${report.count} waiting` };
  const installedTools = curated?.packages.filter((tool) => tool.installed).length ?? 0;
  const unattendedRead = unattended !== null;

  return (
    <div className="updates-center" data-density="comfortable">
      {dialog}
      <div className="updates-figures">
        <MetricTile
          label="Available updates"
          value={loading && !report ? "…" : report?.count ?? "—"}
          caption={!report ? (loading ? "Checking for updates" : "Not read") : securityCount ? `${securityCount} security` : "packages"}
          status={updates.status}
        />
        <MetricTile
          label="Reboot"
          value={!report ? "—" : report.rebootRequired ? "Required" : "Not needed"}
          caption={!report ? (loading ? "Checking for updates" : "Not read") : report.rebootRequired ? "A kernel or core library changed" : "Nothing pending a restart"}
          status={!report ? "unknown" : report.rebootRequired ? "warning" : "good"}
        >
          {report?.rebootRequired && (
            <Button risk={riskOf("system.reboot")} onClick={() => start({ operationId: "system.reboot", title: "Reboot the server", parameters: {}, preview: <span>Reboots in 5 seconds after approval. Running VMs and containers stop; reconnect when this server is back.</span> })}>Reboot now</Button>
          )}
        </MetricTile>
        <MetricTile
          label="Automatic updates"
          value={loading && !unattendedRead ? "…" : !unattendedRead ? "—" : unattended.enabled ? "On" : "Off"}
          caption={!unattendedRead ? (loading ? "Reading the setting" : "Could not read the setting") : unattended.enabled ? "Security upgrades install nightly" : "Security upgrades wait for you"}
          status={!unattendedRead ? "unknown" : unattended.enabled ? "good" : "neutral"}
        >
          {unattended && (
            <Button risk={riskOf("apt.unattended.set")} disabled={loading} aria-label={unattended.enabled ? "Turn off automatic updates" : "Turn on automatic updates"} onClick={() => start({
              operationId: "apt.unattended.set",
              title: unattended.enabled ? "Turn off automatic updates" : "Turn on automatic updates",
              parameters: { enabled: !unattended.enabled },
              preview: unattended.enabled
                ? <span>Sets <code>APT::Periodic::Unattended-Upgrade "0"</code>. You install updates from this page instead.</span>
                : <span>{unattended.installed ? "" : "Installs unattended-upgrades, then "}sets <code>APT::Periodic::Unattended-Upgrade "1"</code> so security updates install nightly.</span>,
            })}>{unattended.enabled ? "Turn off" : "Turn on"}</Button>
          )}
        </MetricTile>
      </div>

      {error && <div className="auth-error" role="alert">{error}</div>}

      {report?.needrestartPresent && report.servicesNeedingRestart === null && (
        <Section title="Running-library check" status={{ status: "unknown", label: "Not finished" }} summary="The scan did not finish. Refresh this page to try again. Package update information is still shown below." />
      )}
      {report?.servicesNeedingRestart && report.servicesNeedingRestart.length > 0 && (
        <Section
          title="Services running old libraries"
          status={{ status: "warning", label: `${report.servicesNeedingRestart.length} to restart` }}
          summary={<>These kept the pre-upgrade code in memory. Restart them when convenient, or reboot to refresh everything.{report.needrestartCheckedAt ? ` Checked ${new Date(report.needrestartCheckedAt).toLocaleString()}.` : ""}</>}
        >
          <div className="updates-restarts">
            {report.servicesNeedingRestart.map((unit) => unit === "systemd-manager" ? (
              <Button key={unit} risk={riskOf("system.manager.reexec")} onClick={() => start({ operationId: "system.manager.reexec", title: "Refresh systemd manager", parameters: {}, preview: <span>Re-executes the system manager to load updated libraries while preserving its state. Runs <code>systemctl daemon-reexec</code>.</span> })}>Refresh systemd manager</Button>
            ) : !/^[A-Za-z0-9:._@\\-]{1,200}\.service$/.test(unit) ? (
              <span key={unit} className="updates-note">{unit}: reboot the server to refresh this process.</span>
            ) : (
              <Button key={unit} risk={riskOf("service.action")} onClick={() => start({ operationId: "service.action", title: `Restart ${unit}`, parameters: { unit, action: "restart" }, preview: <span><code>systemctl restart {unit}</code></span> })}>Restart {unit}</Button>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Upgradable packages"
        status={updates}
        summary="Select some to upgrade only those, or install them all."
        actions={<>
          <Button risk={riskOf("apt.refresh")} disabled={loading} onClick={() => start({ operationId: "apt.refresh", title: "Refresh package lists", parameters: {}, preview: <span>Runs <code>apt-get update</code>. Installs nothing.</span> })}>Refresh lists</Button>
          <SnapshotFirstButton start={start} />
          <Button risk={riskOf("apt.upgrade")} disabled={selectedList.length === 0} onClick={() => start({ operationId: "apt.upgrade", title: `Upgrade ${selectedList.length} selected package${selectedList.length === 1 ? "" : "s"}`, parameters: { packages: selectedList }, preview: <span>{selectedList.join(", ")}</span> })}>Upgrade selected ({selectedList.length})</Button>
          <Button variant="primary" risk={riskOf("apt.upgrade")} disabled={loading || !report?.count} onClick={() => start({ operationId: "apt.upgrade", title: "Install all updates", parameters: {}, preview: <span>Upgrades {report?.count ?? 0} package{report?.count === 1 ? "" : "s"} with <code>apt-get upgrade --with-new-pkgs</code> after refreshing the lists.</span> })}>Install all updates</Button>
        </>}
      >
        <Card flush>
          <div className="table-scroll">
            <table className="ui-table">
              <thead><tr><th className="ui-table__check"><input type="checkbox" aria-label="Select all packages" checked={allSelected} disabled={allNames.length === 0} onChange={toggleAll} /></th><th>Package</th><th className="updates-installed">Installed</th><th>Available</th><th className="updates-source">Source</th></tr></thead>
              <tbody>
                {loading && !report ? <tr><td colSpan={5}>Checking for updates...</td></tr> : null}
                {report && report.upgradable.length === 0 ? <tr><td colSpan={5}>Everything is up to date.</td></tr> : null}
                {report?.upgradable.map((item) => (
                  <tr key={item.name}>
                    <td className="ui-table__check"><input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.name)} onChange={() => toggle(item.name)} /></td>
                    <td className="updates-package"><a className="changelog-link" href={`https://launchpad.net/ubuntu/+source/${encodeURIComponent(item.source ?? item.name)}/+changelog`} target="_blank" rel="noreferrer" title="Changelog on Launchpad"><code>{item.name}</code></a>{/security/i.test(item.suite) && <StatusChip status="warning" className="updates-security-inline" title="A security update">security</StatusChip>}</td>
                    <td className="updates-installed">{item.installed}</td>
                    <td>{item.candidate}</td>
                    <td className="updates-source">{/security/i.test(item.suite) ? <StatusChip status="warning" title="A security update">{item.suite}</StatusChip> : item.suite}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Section>

      {curated && (
        <Section
          title="Common tools"
          status={{ status: "neutral", label: `${installedTools} of ${curated.packages.length} installed` }}
          summary="One-confirm installs of the packages most servers want. Anything else installs below."
        >
          <ul className="updates-tools">
            {curated.packages.map((tool) => (
              <li key={tool.name} className="updates-tool" data-installed={tool.installed || undefined}>
                <div><code>{tool.name}</code><span>{curatedDescriptions[tool.name] ?? ""}</span></div>
                {tool.installed
                  ? <Button variant="ghost" risk={riskOf("apt.remove")} aria-label={`Remove ${tool.name}`} onClick={() => start({ operationId: "apt.remove", title: `Remove ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span>Removes {tool.name} ({tool.version}) and anything only it needed.</span> })}>Remove</Button>
                  : <Button risk={riskOf("apt.install")} aria-label={`Install ${tool.name}`} onClick={() => start({ operationId: "apt.install", title: `Install ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span><code>apt-get install --no-install-recommends {tool.name}</code></span> })}>Install</Button>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Install packages" summary="Any Ubuntu package, installed without recommends.">
        <Card className="updates-install">
          <input aria-label="Package names" placeholder="htop git tmux" value={customPackages} onChange={(event) => setCustomPackages(event.target.value)} />
          <Button variant="primary" risk={riskOf("apt.install")} disabled={customList.length === 0} onClick={() => start({ operationId: "apt.install", title: `Install ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span><code>apt-get install --no-install-recommends {customList.join(" ")}</code></span> })}>Install</Button>
          <Button risk={riskOf("apt.remove")} disabled={customList.length === 0} onClick={() => start({ operationId: "apt.remove", title: `Remove ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span>Removes the packages and anything only they needed. Configuration files are kept.</span> })}>Remove</Button>
          <Button risk={riskOf("apt.autoremove")} onClick={() => start({ operationId: "apt.autoremove", title: "Remove unused packages", parameters: {}, preview: <span><code>apt-get autoremove --purge</code></span> })}>Remove unused packages</Button>
        </Card>
      </Section>
    </div>
  );
}
