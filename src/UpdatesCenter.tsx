import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

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
}

interface UnattendedReport { installed: boolean; enabled: boolean }
interface CuratedReport { packages: Array<{ name: string; installed: boolean; version: string | null }> }

const curatedDescriptions: Record<string, string> = {
  htop: "interactive process viewer", btop: "modern resource monitor", tmux: "terminal multiplexer",
  git: "version control", curl: "HTTP client", wget: "file downloader", jq: "JSON processor",
  ncdu: "disk usage explorer", tree: "directory trees", ripgrep: "fast text search (rg)", zsh: "Z shell",
  unzip: "zip extraction", "net-tools": "ifconfig and netstat", dnsutils: "dig and nslookup",
  iotop: "disk I/O monitor", smartmontools: "disk SMART health", restic: "backup engine",
  "nfs-common": "NFS mounts", "cifs-utils": "SMB/CIFS mounts", needrestart: "finds services running old libraries",
};

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

  return (
    <div className="updates-center">
      {dialog}
      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Available updates</span><strong>{loading ? "…" : report?.count ?? "—"}</strong><span>{report?.securityCount ? `${report.securityCount} security` : "packages"}</span></article>
        <article className="panel"><span className="eyebrow">Reboot</span><strong>{report?.rebootRequired ? "Required" : "Not needed"}</strong><span>{report?.rebootRequired ? "A kernel or core library changed" : "Nothing pending a restart"}</span>
          {report?.rebootRequired && <div className="recovery-actions"><button className="secondary-button" type="button" onClick={() => start({ operationId: "system.reboot", title: "Reboot the server", parameters: {}, preview: <span>Reboots in 5 seconds after approval. Running VMs and containers stop; reconnect when the host is back.</span> })}>Reboot now</button></div>}
        </article>
        <article className="panel">
          <span className="eyebrow">Automatic updates</span>
          <strong>{loading && !unattended ? "…" : unattended?.enabled ? "On" : "Off"}</strong>
          <span>{unattended?.enabled ? "Security upgrades install nightly" : "Security upgrades wait for you"}</span>
          {unattended && (
            <div className="recovery-actions">
              <button className="secondary-button" type="button" disabled={loading} onClick={() => start({
                operationId: "apt.unattended.set",
                title: unattended.enabled ? "Turn off automatic updates" : "Turn on automatic updates",
                parameters: { enabled: !unattended.enabled },
                preview: unattended.enabled
                  ? <span>Sets <code>APT::Periodic::Unattended-Upgrade "0"</code>. You install updates from this page instead.</span>
                  : <span>{unattended.installed ? "" : "Installs unattended-upgrades, then "}sets <code>APT::Periodic::Unattended-Upgrade "1"</code> so security updates install nightly.</span>,
              })}>{unattended.enabled ? "Turn off" : "Turn on"}</button>
            </div>
          )}
        </article>
        <article className="panel">
          <span className="eyebrow">Actions</span>
          <div className="recovery-actions">
            <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "apt.refresh", title: "Refresh package lists", parameters: {}, preview: <span>Runs <code>apt-get update</code>. Installs nothing.</span> })}>Refresh lists</button>
            <button className="primary-button" type="button" disabled={loading || !report?.count} onClick={() => start({ operationId: "apt.upgrade", title: "Install all updates", parameters: {}, preview: <span>Upgrades {report?.count ?? 0} package{report?.count === 1 ? "" : "s"} with <code>apt-get upgrade --with-new-pkgs</code> after refreshing the lists.</span> })}>Install all updates</button>
          </div>
        </article>
      </div>

      {error && <div className="auth-error" role="alert">{error}</div>}

      {report?.servicesNeedingRestart && report.servicesNeedingRestart.length > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>Services running old libraries</strong><span>These kept the pre-upgrade code in memory. Restart them when convenient — or reboot to refresh everything.</span></div></header>
          <div className="recovery-actions">
            {report.servicesNeedingRestart.map((unit) => (
              <button key={unit} className="secondary-button" type="button" onClick={() => start({ operationId: "service.action", title: `Restart ${unit}`, parameters: { unit, action: "restart" }, preview: <span><code>systemctl restart {unit}</code></span> })}>Restart {unit}</button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <header className="panel-header"><div><strong>Upgradable packages</strong><span>Select some to upgrade only those, or install everything above.</span></div>
          <button className="secondary-button" type="button" disabled={selectedList.length === 0} onClick={() => start({ operationId: "apt.upgrade", title: `Upgrade ${selectedList.length} selected package${selectedList.length === 1 ? "" : "s"}`, parameters: { packages: selectedList }, preview: <span>{selectedList.join(", ")}</span> })}>Upgrade selected ({selectedList.length})</button>
        </header>
        <div className="table-scroll">
          <table>
            <thead><tr><th><input type="checkbox" aria-label="Select all packages" checked={allSelected} disabled={allNames.length === 0} onChange={toggleAll} /></th><th>Package</th><th>Installed</th><th>Available</th><th>Source</th></tr></thead>
            <tbody>
              {loading && !report ? <tr><td colSpan={5}>Reading APT state...</td></tr> : null}
              {report && report.upgradable.length === 0 ? <tr><td colSpan={5}>Everything is up to date.</td></tr> : null}
              {report?.upgradable.map((item) => (
                <tr key={item.name}>
                  <td><input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.name)} onChange={() => toggle(item.name)} /></td>
                  <td><a className="changelog-link" href={`https://launchpad.net/ubuntu/+source/${encodeURIComponent(item.source ?? item.name)}/+changelog`} target="_blank" rel="noreferrer" title="Changelog on Launchpad"><code>{item.name}</code></a></td>
                  <td>{item.installed}</td>
                  <td>{item.candidate}</td>
                  <td>{/security/i.test(item.suite) ? <span className="status-pill status-warning">{item.suite}</span> : item.suite}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {curated && (
        <section className="panel">
          <header className="panel-header"><div><strong>Common tools</strong><span>One-confirm installs of the packages most servers want. Anything else installs below.</span></div></header>
          <div className="curated-grid">
            {curated.packages.map((tool) => (
              <article key={tool.name} className={`curated-tool${tool.installed ? " curated-installed" : ""}`}>
                <div><code>{tool.name}</code><span>{curatedDescriptions[tool.name] ?? ""}</span></div>
                {tool.installed
                  ? <button className="text-button" type="button" onClick={() => start({ operationId: "apt.remove", title: `Remove ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span>Removes {tool.name} ({tool.version}) and anything only it needed.</span> })}>Remove</button>
                  : <button className="secondary-button" type="button" onClick={() => start({ operationId: "apt.install", title: `Install ${tool.name}`, parameters: { packages: [tool.name] }, preview: <span><code>apt-get install --no-install-recommends {tool.name}</code></span> })}>Install</button>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <header className="panel-header"><div><strong>Install packages</strong><span>Any Ubuntu package, installed without recommends. Medium risk: you confirm before it runs.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="Package names" placeholder="htop git tmux" value={customPackages} onChange={(event) => setCustomPackages(event.target.value)} />
          <button className="primary-button" type="button" disabled={customList.length === 0} onClick={() => start({ operationId: "apt.install", title: `Install ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span><code>apt-get install --no-install-recommends {customList.join(" ")}</code></span> })}>Install</button>
          <button className="secondary-button" type="button" disabled={customList.length === 0} onClick={() => start({ operationId: "apt.remove", title: `Remove ${customList.join(", ")}`, parameters: { packages: customList }, preview: <span>Removes the packages and anything only they needed. Configuration files are kept.</span> })}>Remove</button>
          <button className="secondary-button" type="button" onClick={() => start({ operationId: "apt.autoremove", title: "Remove unused packages", parameters: {}, preview: <span><code>apt-get autoremove --purge</code></span> })}>Autoremove unused</button>
        </div>
      </section>
    </div>
  );
}
