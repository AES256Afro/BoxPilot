import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface Provider { label: string; fields: string[]; secrets: string[]; help: string }
interface CloudState { rcloneInstalled: boolean; configured: boolean; provider: string | null; providers: Record<string, Provider> }
interface CloudSettings { destination: (Record<string, string | null> & { provider: string }) | null; lastSync: { completedAt: string; filesTransferred: number; bytesTransferred: string | null; destination: string; errors?: number } | null }

const fieldLabels: Record<string, string> = { account: "Key ID", bucket: "Bucket", path: "Folder in the bucket", endpoint: "Endpoint URL", region: "Region", accessKeyId: "Access key ID", url: "WebDAV URL", user: "Username", key: "Application key", secretAccessKey: "Secret access key", password: "Password", token: "Token (from rclone authorize)" };
const placeholders: Record<string, string> = { bucket: "home-backups", path: "boxpilot", endpoint: "https://s3.eu-central-1.wasabisys.com", region: "us-east-1", url: "https://cloud.example.com/remote.php/dav/files/me/" };

/** Cloud mirror of the local backup folders through rclone; credentials go only to root-only rclone.conf. */
export default function CloudBackupPanel({ start, refreshKey }: { start: (operation: PendingOperation) => void; refreshKey?: number }) {
  const [state, setState] = useState<CloudState | null>(null);
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("b2");
  const [values, setValues] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [inspected, saved] = await Promise.all([
        inspectOperation<CloudState>("backup.cloud.inspect").then((body) => body.result),
        fetch("/api/v1/settings/cloud-destination").then((response) => (response.ok ? (response.json() as Promise<CloudSettings>) : null)),
      ]);
      setState(inspected);
      setSettings(saved);
      setError(null);
      if (saved?.destination) {
        setProvider(saved.destination.provider);
        setValues((current) => ({ ...Object.fromEntries(Object.entries(saved.destination!).filter(([key, value]) => key !== "provider" && typeof value === "string").map(([key, value]) => [key, value as string])), ...current }));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the cloud destination");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const spec = state?.providers[provider];
  const fields = spec?.fields ?? [];
  const secrets = spec?.secrets ?? [];
  const required = fields.filter((field) => !["endpoint", "region", "path"].includes(field));
  const missing = [...required, ...secrets].filter((field) => !(values[field] ?? "").trim());
  const complete = required.every((field) => (values[field] ?? "").trim()) && secrets.every((field) => (values[field] ?? "").trim()) && (provider !== "s3" || Boolean((values.endpoint ?? "").trim() || (values.region ?? "").trim()));
  const set = (field: string, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const destinationParameters = () => Object.fromEntries([...fields, ...secrets].map((field) => [field, (values[field] ?? "").trim()]).filter(([, value]) => value));

  const save = () => start({
    operationId: "backup.cloud.setup",
    title: `Save the ${spec?.label ?? provider} backup destination`,
    parameters: { provider, ...destinationParameters() },
    preview: <span>Writes the rclone remote to <code>/etc/boxpilot/secrets/rclone.conf</code> (root only). The {secrets.map((field) => fieldLabels[field] ?? field).join(" and ")} stays in memory until this job runs and is never stored in BoxPilot's database. Test the connection afterwards.</span>,
  });
  const test = () => start({ operationId: "backup.cloud.test", title: "Test the cloud destination", parameters: {}, preview: <span>Creates the destination folder with the saved credentials and lists it. Nothing is copied yet.</span> });
  const mirror = () => start({ operationId: "backup.cloud.sync", title: "Mirror backups to the cloud", parameters: {}, preview: <span><code>rclone copy --checksum</code> of the controller backups, app backups, and machine snapshots to the destination. Files already there are verified, not re-uploaded; nothing is ever deleted at the destination.</span> });

  return (
    <section className="panel" id="cloud-backup">
      <header className="panel-header">
        <div><strong>Cloud destination</strong><span>Mirror the backup folders to Backblaze B2, S3, WebDAV, Google Drive, OneDrive, or Dropbox through rclone. Copies only: nothing at the destination is ever deleted.</span></div>
        {state && !state.rcloneInstalled && <button className="secondary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install rclone", parameters: { packages: ["rclone"] }, preview: <span><code>apt-get install --no-install-recommends rclone</code></span> })}>Install rclone</button>}
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {state && (
        <form className="share-form" onSubmit={(event) => { event.preventDefault(); if (complete && state.rcloneInstalled) save(); }}>
          <label>Provider
            <select aria-label="Cloud provider" value={provider} onChange={(event) => { setProvider(event.target.value); }}>{Object.entries(state.providers).map(([id, entry]) => <option value={id} key={id}>{entry.label}</option>)}</select>
          </label>
          {spec && <p className="muted share-actions">{spec.help}</p>}
          {fields.map((field) => (
            <label key={field}>{fieldLabels[field] ?? field}{required.includes(field) ? "" : " (optional)"}
              <input aria-label={fieldLabels[field] ?? field} placeholder={placeholders[field] ?? ""} value={values[field] ?? ""} onChange={(event) => set(field, event.target.value)} autoComplete="off" />
            </label>
          ))}
          {secrets.map((field) => (
            <label key={field}>{fieldLabels[field] ?? field}
              {field === "token"
                ? <textarea aria-label={fieldLabels[field] ?? field} rows={3} value={values[field] ?? ""} onChange={(event) => set(field, event.target.value)} placeholder='{"access_token":"...","token_type":"Bearer",...}' />
                : <input aria-label={fieldLabels[field] ?? field} type="password" autoComplete="new-password" value={values[field] ?? ""} onChange={(event) => set(field, event.target.value)} />}
            </label>
          ))}
          <div className="recovery-actions share-actions">
            <button className="secondary-button" type="submit" disabled={!complete || !state.rcloneInstalled}>Save destination</button>
            {settings?.destination && <button className="secondary-button" type="button" onClick={test}>Test connection</button>}
            {settings?.destination && <button className="primary-button" type="button" onClick={mirror}>Mirror now</button>}
            {!state.rcloneInstalled && <span className="muted">Install rclone first.</span>}
            {/* A greyed-out button over a form of six fields is a guessing game, and the one field
                still empty is rarely the one being looked at. */}
            {state.rcloneInstalled && !complete && <span className="muted">Still needed: {missing.length ? missing.join(", ") : "an endpoint or a region"}.</span>}
          </div>
          {settings?.destination && (
            <span className="muted share-actions">Saved: <strong>{state.providers[settings.destination.provider]?.label ?? settings.destination.provider}</strong>{settings.destination.bucket ? <> · bucket <code>{settings.destination.bucket}</code></> : null}{settings.destination.path ? <> · folder <code>{settings.destination.path}</code></> : null}{settings.lastSync ? ` — last mirrored ${new Date(settings.lastSync.completedAt).toLocaleString()} (${settings.lastSync.filesTransferred} files${settings.lastSync.errors ? `, ${settings.lastSync.errors} errors` : ""})` : " — never mirrored"}. Schedule it on the System page.</span>
          )}
        </form>
      )}
    </section>
  );
}
