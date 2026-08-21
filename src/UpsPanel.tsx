import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";

interface DetectedUps { vendorId: string; productId: string; manufacturer: string | null; product: string | null; driver: string; confidence: "vendor-id" | "name"; sysfs: string }
interface Detection { devices: DetectedUps[]; nutInstalled: boolean }

/** One-click UPS monitoring: detect the UPS on USB, install NUT if needed, configure and start it. */
export default function UpsPanel({ start }: { start: (operation: PendingOperation) => void }) {
  const [detection, setDetection] = useState<Detection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shutdown, setShutdown] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/power/ups/detect");
      const body = (await response.json()) as Detection & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not look for a UPS");
      setDetection(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not look for a UPS");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const device = detection?.devices[0] ?? null;
  const label = device ? [device.manufacturer, device.product].filter(Boolean).join(" ") || `USB ${device.vendorId}:${device.productId}` : null;
  const description = (label ?? "UPS").replace(/[^A-Za-z0-9 ._()/-]/g, "").slice(0, 60) || "UPS";

  return (
    <section className="panel" id="ups">
      <header className="panel-header">
        <div><strong>UPS (battery backup)</strong><span>Plug the UPS's USB cable into this server and BoxPilot sets up monitoring: status on the Overview page and a clean shutdown before the battery runs out.</span></div>
        <button className="secondary-button" type="button" onClick={() => void refresh()}>Look again</button>
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {detection && !device && <p className="muted">No UPS found on USB. Connect the data cable that came with the UPS (not just the power cord), wait a few seconds, and click Look again. Network-managed UPSes (SNMP cards) are not detected automatically.</p>}
      {device && (
        <div className="recovery-actions ups-found">
          <span><strong>Found:</strong> {label} <span className="muted">({device.driver}{device.confidence === "name" ? ", matched by name" : ""})</span></span>
          <label className="cloud-vm-check"><input type="checkbox" checked={shutdown} onChange={(event) => setShutdown(event.target.checked)} />shut this server down when the battery is low</label>
          {detection?.nutInstalled
            ? <button className="primary-button" type="button" onClick={() => start({
              operationId: "ups.setup",
              title: `Set up monitoring for ${label}`,
              parameters: { driver: device.driver, vendorId: device.vendorId, productId: device.productId, description, shutdownAtLowBattery: shutdown },
              preview: <span>Writes <code>/etc/nut/</code> (driver <code>{device.driver}</code>, server on <code>127.0.0.1</code> only, a generated monitor password), starts the driver and the NUT services, and checks the UPS answers. {shutdown ? "When the UPS reports a low battery, the server shuts down cleanly." : "Shutdown is disabled; you only get status and alerts."} Existing NUT files are kept as .before-boxpilot.</span>,
            })}>Set up monitoring</button>
            : <button className="primary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install NUT (UPS tools)", parameters: { packages: ["nut"] }, preview: <span><code>apt-get install --no-install-recommends nut</code>. Come back here afterwards to set up monitoring.</span> })}>Install NUT first</button>}
        </div>
      )}
    </section>
  );
}
