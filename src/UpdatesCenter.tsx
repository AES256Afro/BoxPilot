import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface UpgradablePackage {
  name: string;
  suite: string;
  candidate: string;
  installed: string;
  architecture: string;
}

interface UpgradableReport {
  upgradable: UpgradablePackage[];
  count: number;
  securityCount: number;
  rebootRequired: boolean;
}

export default function UpdatesCenter({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<UpgradableReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customPackages, setCustomPackages] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { result } = await inspectOperation<UpgradableReport>("apt.upgradable.inspect");
      setReport(result);
      setSelected((current) => new Set([...current].filter((name) => result.upgradable.some((item) => item.name === name))));
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
  const customList = useMemo(() => customPackages.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean), [customPackages]);

  return (
    <div className="updates-center">
      {dialog}
      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Available updates</span><strong>{loading ? "…" : report?.count ?? "—"}</strong><span>{report?.securityCount ? `${report.securityCount} security` : "packages"}</span></article>
        <article className="panel"><span className="eyebrow">Reboot</span><strong>{report?.rebootRequired ? "Required" : "Not needed"}</strong><span>{report?.rebootRequired ? "A kernel or core library changed" : "Nothing pending a restart"}</span></article>
        <article className="panel">
          <span className="eyebrow">Actions</span>
          <div className="recovery-actions">
            <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "apt.refresh", title: "Refresh package lists", parameters: {}, preview: <span>Runs <code>apt-get update</code>. Installs nothing.</span> })}>Refresh lists</button>
            <button className="primary-button" type="button" disabled={loading || !report?.count} onClick={() => start({ operationId: "apt.upgrade", title: "Install all updates", parameters: {}, preview: <span>Upgrades {report?.count ?? 0} package{report?.count === 1 ? "" : "s"} with <code>apt-get upgrade --with-new-pkgs</code> after refreshing the lists.</span> })}>Install all updates</button>
          </div>
        </article>
      </div>

      {error && <div className="auth-error" role="alert">{error}</div>}

      <section className="panel">
        <header className="panel-header"><div><strong>Upgradable packages</strong><span>Select some to upgrade only those, or install everything above.</span></div>
          <button className="secondary-button" type="button" disabled={selectedList.length === 0} onClick={() => start({ operationId: "apt.upgrade", title: `Upgrade ${selectedList.length} selected package${selectedList.length === 1 ? "" : "s"}`, parameters: { packages: selectedList }, preview: <span>{selectedList.join(", ")}</span> })}>Upgrade selected ({selectedList.length})</button>
        </header>
        <div className="table-scroll">
          <table>
            <thead><tr><th aria-label="Select" /><th>Package</th><th>Installed</th><th>Available</th><th>Source</th></tr></thead>
            <tbody>
              {loading && !report ? <tr><td colSpan={5}>Reading APT state...</td></tr> : null}
              {report && report.upgradable.length === 0 ? <tr><td colSpan={5}>Everything is up to date.</td></tr> : null}
              {report?.upgradable.map((item) => (
                <tr key={item.name}>
                  <td><input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.name)} onChange={() => toggle(item.name)} /></td>
                  <td><code>{item.name}</code></td>
                  <td>{item.installed}</td>
                  <td>{item.candidate}</td>
                  <td>{/security/i.test(item.suite) ? <span className="status-pill status-warning">{item.suite}</span> : item.suite}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
