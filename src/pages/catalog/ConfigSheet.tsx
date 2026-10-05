import { useEffect, useId, useState, type ReactNode } from "react";
import { describePortConflict, type PortConflict } from "../../portConflict";
import { Button, Checkbox, Field, Notice, SecretInput, Select, Sheet, Tag, TextInput, riskOf } from "../../ui";
import { compactValues, initialValues, installTier } from "./appState";
import type { LiveState, Manifest, Values } from "./types";

/*
 * Installing an app, or changing its settings (M33.11): a form in a sheet, a section for each kind
 * of setting the manifest asks for. The server prechecks it (ports in use, required settings)
 * before the operation is staged, and the approval dialog runs it as before.
 */

export interface ConfigSheetProps {
  manifest: Manifest;
  live: LiveState | null;
  mode: "install" | "reconfigure";
  csrfToken: string;
  /** What to send, and the whole form as it was filled in (to put back if the job does not complete). */
  onSubmit: (values: Values, form: Values) => void;
  onCancel: () => void;
  /** The form as it was last filled in, when its approval was cancelled or its job failed. */
  seed?: Values;
  /** An installed app's name by id, to say who holds a port that is taken. */
  appNameFor?: (id: string) => string | null;
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <fieldset className="catalog-form__section">
      <legend className="catalog-form__legend">{title}</legend>
      {hint && <p className="catalog-form__hint">{hint}</p>}
      <div className="catalog-form__fields">{children}</div>
    </fieldset>
  );
}

export function ConfigSheet({ manifest, live, mode, csrfToken, onSubmit, onCancel, seed, appNameFor = () => null }: ConfigSheetProps) {
  const formId = useId();
  const foldersId = useId();
  const [values, setValues] = useState<Values>(() => seed ?? initialValues(manifest, live));
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  // The drives and network shares already mounted on this server, offered for a folder field, so
  // attaching one to an app is a pick, not a typed path; and it needs no credentials, because the
  // drive or share was connected once under Storage.
  const [mountedFolders, setMountedFolders] = useState<string[]>([]);
  const hasConfigurableVolumes = manifest.volumes.some((volume) => volume.configurable);
  useEffect(() => {
    if (!hasConfigurableVolumes) return undefined;
    let active = true;
    const dataFolder = (folder: unknown): folder is string => typeof folder === "string" && (folder.startsWith("/mnt/") || folder.startsWith("/srv/"));
    fetch("/api/v1/storage/overview").then((response) => (response.ok ? response.json() : null)).then((report: { mounts?: Array<{ target: string }>; shares?: Array<{ mountpoint: string }>; fstab?: Array<{ mountpoint: string; managedName: string | null }> } | null) => {
      if (!active || !report) return;
      const list = [
        ...(report.shares ?? []).map((share) => share.mountpoint),
        ...(report.mounts ?? []).map((mount) => mount.target).filter(dataFolder),
        ...(report.fstab ?? []).filter((row) => row.managedName && dataFolder(row.mountpoint)).map((row) => row.mountpoint),
      ].filter(dataFolder);
      const roots = [...new Set(list)].sort();
      setMountedFolders(roots);
      // Also what is directly inside each one. Pointing an app at a subfolder is the normal case
      // (downloads into their own folder rather than the root of a 15 TB drive), and a path that
      // has to be typed is a path that gets typed wrong.
      void Promise.all(roots.slice(0, 8).map((root) => fetch("/api/v1/operations/storage.folders/run", {
        method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { path: root } }),
      }).then((response) => (response.ok ? response.json() : null)).catch(() => null))).then((results) => {
        if (!active) return;
        const nested = results.flatMap((body: { result?: { folders?: string[] } } | null) => body?.result?.folders ?? []);
        if (nested.length) setMountedFolders([...new Set([...roots, ...nested])].sort());
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [hasConfigurableVolumes, csrfToken]);

  const submit = async () => {
    const compact = compactValues(manifest, values, mode === "reconfigure" ? live?.state?.values : undefined);
    // The precheck resolves against the catalog's defaults, so it needs unchanged required settings
    // and custom ports too. The mutation still sends only what changed from the stored values.
    const precheckValues = compactValues(manifest, values);
    setChecking(true); setProblems([]);
    try {
      const response = await fetch(`/api/v1/catalog/${encodeURIComponent(manifest.id)}/precheck`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ values: precheckValues }) });
      const body = (await response.json().catch(() => ({}))) as { ok: boolean; errors: string[]; conflicts: PortConflict[]; error?: string };
      if (!response.ok && !body.errors?.length) throw new Error(body.error ?? "Precheck failed");
      const found = [...(body.errors ?? []), ...(body.conflicts ?? []).map((conflict) => describePortConflict(conflict, appNameFor))];
      if (found.length) { setProblems(found); return; }
      onSubmit(compact, values);
    } catch {
      // The precheck is advice: if it cannot run, continue and let the install report the real error.
      onSubmit(compact, values);
    } finally {
      setChecking(false);
    }
  };

  const setPort = (id: string, value: string) => setValues((current) => ({ ...current, ports: { ...current.ports, [id]: Number.parseInt(value, 10) || 0 } }));
  const setEnv = (name: string, value: string) => setValues((current) => ({ ...current, env: { ...current.env, [name]: value } }));
  const setVolume = (id: string, value: string) => setValues((current) => ({ ...current, volumes: { ...current.volumes, [id]: value } }));
  const toggleSetup = (id: string, checked: boolean) => setValues((current) => ({ ...current, setup: checked ? [...new Set([...(current.setup ?? []), id])] : (current.setup ?? []).filter((entry) => entry !== id) }));

  const editablePorts = manifest.ports.filter((port) => !port.fixed);
  const editableEnv = manifest.env.filter((entry) => !entry.fixed && !entry.generate);
  // When an app is routed through the shared VPN profile, the connection fields come from the
  // profile, so they are hidden here rather than asked for twice.
  const usingVpnProfile = Boolean(manifest.usesVpnProfile) && values.env.USE_VPN_PROFILE === "on";
  const shownEnv = editableEnv.filter((entry) => !(usingVpnProfile && entry.fromVpnProfile));
  const generated = manifest.env.filter((entry) => entry.generate);
  // A password the app signs you in with is worth choosing yourself; the rest (database passwords,
  // session secrets) nobody ever types, so those stay generated and out of the way.
  const choosable = generated.filter((entry) => entry.name === manifest.signIn?.passwordEnv);
  const generatedQuietly = generated.filter((entry) => !choosable.includes(entry));
  const editableVolumes = manifest.volumes.filter((volume) => volume.configurable);
  const networkMode = values.networkMode ?? manifest.networkModes?.[0];
  const operationId = mode === "install" ? "app.install" : "app.reconfigure";
  const nothingToAsk = (manifest.networkModes?.length ?? 0) <= 1 &&!editablePorts.length && !editableVolumes.length && !shownEnv.length && !(manifest.setup?.choices.length) && !choosable.length;

  return (
    <Sheet
      kicker={mode === "install" ? "Install" : "Settings"}
      title={manifest.name}
      onClose={onCancel}
      className="catalog-config"
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} risk={mode === "install" ? installTier(manifest) : riskOf(operationId)} disabled={checking}>{checking ? "Checking…" : mode === "install" ? "Continue to install" : "Apply settings"}</Button>
      </>}
    >
      <form id={formId} className="catalog-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {problems.length > 0 && (
          <Notice tone="danger" live title={mode === "install" ? "Not installed yet" : "Not changed yet"}>
            <ul className="catalog-form__problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          </Notice>
        )}
        {nothingToAsk && <p className="catalog-form__hint">{manifest.name} needs no settings: {mode === "install" ? "it installs with the catalog's defaults." : "there is nothing here to change."}</p>}
        {mode === "install" && manifest.defaultExposure === "tailnet" && (
          <p className="catalog-form__hint">Reached through Tailscale only: its web page stays on this server and Tailscale Serve publishes it on your tailnet over HTTPS, with a valid certificate. Nothing on your home network can open it. You can change that later on its Reach tab.</p>
        )}

        {(manifest.networkModes?.length ?? 0) > 1 && (
          <Section title="Network">
            <Field label="Network mode" hint={networkMode === "host"
              ? "Shares this server's network, so the app sees real client addresses. Its ports become this server's ports (the admin UI moves to port 80), and it cannot use a bundled recursive resolver."
              : "Runs behind Docker's own network. Safer isolation, but every device reaches it through one address, so per-device rules and client lists do not work."}>
              <Select value={networkMode} onValueChange={(value) => setValues((current) => ({ ...current, networkMode: value }))}
                options={(manifest.networkModes ?? []).map((option) => ({ value: option, label: option === "host" ? "Host: sees each device on your network by address and name" : "Bridge: sees your whole network as one device (the usual choice)" }))} />
            </Field>
          </Section>
        )}

        {editablePorts.length > 0 && (
          <Section title="Ports">
            {editablePorts.map((port) => (
              <Field key={port.id} label={`${port.label} port`} hint={`${port.containerFollowsHost ? "The app listens here" : `Container ${port.container}/${port.protocol}`} · ${port.exposure === "loopback" ? "this server only" : mode === "install" && manifest.defaultExposure === "tailnet" && port.protocol === "tcp" ? "your tailnet, over HTTPS" : "your network"}`}>
                <TextInput type="number" mono min={1} max={65535} value={values.ports[port.id] ?? port.host} onValueChange={(value) => setPort(port.id, value)} />
              </Field>
            ))}
          </Section>
        )}

        {editableVolumes.length > 0 && (
          <Section title="Folders" hint={mountedFolders.length > 0 ? "Pick one of your mounted drives or network shares, or type a path. A mounted folder needs no credentials here: it was connected once under Storage." : undefined}>
            <datalist id={foldersId}>{mountedFolders.map((folder) => <option value={folder} key={folder} />)}</datalist>
            {editableVolumes.map((volume) => (
              <Field key={volume.id} label={volume.label} hint={volume.description ?? undefined}>
                <TextInput mono list={foldersId} value={values.volumes[volume.id] ?? ""} onValueChange={(value) => setVolume(volume.id, value)} placeholder={volume.hostPath ?? "/srv/..."} spellCheck={false} autoCapitalize="off" />
              </Field>
            ))}
          </Section>
        )}

        {shownEnv.length > 0 && (
          <Section title="Settings">
            {shownEnv.map((entry) => {
              const hint = <>{entry.description}{entry.name === "USE_VPN_PROFILE" && usingVpnProfile ? <>{entry.description ? " " : ""}The VPN provider and key come from your VPN profile (set it up on the Network page). If none is saved, the install will ask you to save one first.</> : null}</>;
              const hasHint = Boolean(entry.description) || (entry.name === "USE_VPN_PROFILE" && usingVpnProfile);
              return (
                <Field key={entry.name} label={entry.label} required={entry.required} hint={hasHint ? hint : undefined}>
                  {entry.options
                    ? <Select value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} options={entry.options.map((option) => ({ value: option, label: option }))} />
                    : entry.type === "boolean"
                      ? <Select value={values.env[entry.name] || "false"} onValueChange={(value) => setEnv(entry.name, value)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                      : entry.type === "password"
                        ? <SecretInput value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} autoComplete="new-password" />
                        : <TextInput type={entry.type === "number" ? "number" : "text"} mono={entry.type === "path" || entry.type === "timezone"} value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} />}
                </Field>
              );
            })}
          </Section>
        )}

        {manifest.setup && manifest.setup.choices.length > 0 && (
          <Section title={manifest.setup.title} hint={manifest.setup.note ?? undefined}>
            {manifest.setup.choices.map((choice) => (
              <Checkbox
                key={choice.id}
                label={choice.label}
                checked={(values.setup ?? []).includes(choice.id)}
                onChange={(checked) => toggleSetup(choice.id, checked)}
                description={(choice.recommended || choice.description || choice.website) ? <>
                  {choice.recommended && <Tag tone="good">recommended</Tag>}{choice.recommended && (choice.description || choice.website) ? " " : null}
                  {choice.description}
                  {choice.website && <> <a href={choice.website} target="_blank" rel="noreferrer">Learn more</a></>}
                </> : undefined}
              />
            ))}
          </Section>
        )}

        {choosable.length > 0 && (
          <Section title="Sign-in">
            {choosable.map((entry) => (
              <Field key={entry.name} label={entry.label} hint="Leave it empty to have one generated; you can see or change it from the app's sheet afterwards.">
                <SecretInput autoComplete="new-password" minLength={8} maxLength={128} value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} placeholder={mode === "install" ? "Generate one for me" : "Unchanged"} />
              </Field>
            ))}
          </Section>
        )}

        {generatedQuietly.length > 0 && <p className="catalog-form__hint">Generated for you: {generatedQuietly.map((entry) => entry.label).join(", ")} (stored in the app's .env on the server).</p>}
        {manifest.volumes.some((volume) => volume.path) && <p className="catalog-form__hint">Data lives under <code>/var/lib/boxpilot-managed/catalog/{manifest.id}/</code> and is kept on uninstall unless you delete it explicitly.</p>}
      </form>
    </Sheet>
  );
}
