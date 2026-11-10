import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { describePortConflict, type PortConflict } from "../../portConflict";
import { Button, Checkbox, Field, Notice, SecretInput, Select, Sheet, Tag, TextInput, riskOf } from "../../ui";
import { PreflightPanel } from "./PreflightPanel";
import { compactValues, initialValues, installTier, runRead } from "./appState";
import { holdsData, needsSettingsFirst, nightlyTime, relocatePorts, startsWords, type PortClash, type PortReading } from "./preflight";
import type { LiveState, Manifest, Values } from "./types";

/*
 * Installing an app, or changing its settings (M33.11): a form in a sheet, a section for each kind
 * of setting the manifest asks for. The server prechecks it (ports in use, required settings)
 * before the operation is staged, and the approval dialog runs it as before.
 *
 * An install says first whether it will fit (PreflightPanel): what it takes from the server's memory and
 * disks, the port it will get, where it will answer, and whether it is backed up from its first
 * night. A default port that is taken is moved to the next free one before the owner meets a
 * refusal; one they typed themselves is left alone and said to clash.
 */

/** How many times one open form moves a taken port and asks again, before it says the port clashes. */
const portMoveRounds = 6;

export interface ConfigSheetProps {
  manifest: Manifest;
  live: LiveState | null;
  mode: "install" | "reconfigure";
  csrfToken: string;
  /**
   * What to send, and the whole form as it was filled in (to put back if the job does not complete).
   * `backupNightly`: an install whose "Back it up every night" was ticked, to offer once it has finished.
   */
  onSubmit: (values: Values, form: Values, options: { backupNightly: boolean }) => void;
  onCancel: () => void;
  /** The form as it was last filled in, when its approval was cancelled or its job failed. */
  seed?: Values;
  /** An installed app's name by id, to say who holds a port that is taken. */
  appNameFor?: (id: string) => string | null;
  /** The ids of installed apps that run models (Ollama), for a setting whose choices are their models. */
  modelRunnerApps?: string[];
  /** This server's addresses as the catalog read them, for where an install will answer. */
  host?: { lanAddress: string | null; tailscaleDnsName: string | null };
  /** "8000/tcp" for each port an installed app holds: what a taken default steps around. */
  heldPorts?: ReadonlySet<string>;
  /**
   * The nightly backup offered with an install: whether this role may schedule one, the cadence of
   * a backup schedule the app already has, and how the box stood when the form was last filled in.
   */
  nightly?: { may: boolean; already: string | null; seed?: boolean };
}

const unknownHost = { lanAddress: null, tailscaleDnsName: null };
const noPorts: ReadonlySet<string> = new Set();

/** The port a box holds, or null while it is empty or not a port. */
function portNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
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

export function ConfigSheet({ manifest, live, mode, csrfToken, onSubmit, onCancel, seed, appNameFor = () => null, modelRunnerApps = [], host = unknownHost, heldPorts = noPorts, nightly }: ConfigSheetProps) {
  const formId = useId();
  const install = mode === "install";
  const foldersId = useId();
  const [values, setValues] = useState<Values>(() => seed ?? initialValues(manifest, live));
  // A port as it is being typed. Parsed at every keystroke, an emptied box got "0" put back in it
  // and the number could not be retyped; the text is held, and Save waits for a port it can read.
  const [portText, setPortText] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries((seed ?? initialValues(manifest, live)).ports).map(([id, host]) => [id, String(host)])));
  // Secrets are never sent to the browser. These say which ones have a saved value, so the box can
  // read "Saved" instead of looking forgotten, and which the owner asked to clear on save.
  const savedSecrets = new Set(mode === "reconfigure" ? live?.state?.secretsSaved ?? [] : []);
  const [cleared, setCleared] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const editablePorts = manifest.ports.filter((port) => !port.fixed);
  const badPorts = editablePorts.filter((port) => portNumber(portText[port.id] ?? String(values.ports[port.id] ?? port.host)) === null);

  // ── Will it fit: the ports, asked of the server's precheck as soon as the form opens. ──
  // "Back it up every night" is on unless the owner unticked it; only an app that holds data is asked.
  const [backupNightly, setBackupNightly] = useState(nightly?.seed ?? true);
  const offersNightly = install && Boolean(nightly?.may) && holdsData(manifest);
  const [portReading, setPortReading] = useState<PortReading>({ state: "reading", conflicts: [], moved: {} });
  // A port the owner typed is theirs: it is never moved for them. A form put back holds what they
  // (or an earlier check) chose, so anything in it that is not the catalog's default counts as typed.
  const touchedPorts = useRef(new Set(seed ? manifest.ports.filter((port) => seed.ports[port.id] !== undefined && seed.ports[port.id] !== port.host).map((port) => port.id) : []));
  const triedPorts = useRef(new Set<string>());
  const movedPorts = useRef<PortReading["moved"]>({});
  const moveRounds = useRef(0);
  const askedPorts = useRef(false);
  const askAtOnce = useRef(false);
  // The latest of what the check reads, so it asks again only when a port or the network mode changes.
  const latest = useRef({ values, heldPorts, appNameFor });
  latest.current = { values, heldPorts, appNameFor };
  const settingsFirst = install && needsSettingsFirst(manifest, values);
  const hostNetwork = (values.networkMode ?? manifest.network) === "host";
  // On the host's own network a setting can drop a port (Pi-hole's admin page), so its settings count too.
  const portsKey = JSON.stringify([manifest.ports.map((port) => values.ports[port.id] ?? port.host), values.networkMode ?? null, hostNetwork ? values.env : null]);
  const portsUnreadable = settingsFirst || badPorts.length > 0;
  useEffect(() => {
    if (!install) return undefined;
    if (portsUnreadable) { setPortReading({ state: "unread", conflicts: [], moved: movedPorts.current, reason: "settings" }); return undefined; }
    let active = true;
    setPortReading((current) => (current.state === "reading" ? current : { ...current, state: "reading" }));
    // At once when the form opens; a moment after the typing stops when a port is being changed.
    const timer = window.setTimeout(() => {
      askedPorts.current = true;
      askAtOnce.current = false;
      void (async () => {
        const form = latest.current.values;
        try {
          const response = await fetch(`/api/v1/catalog/${encodeURIComponent(manifest.id)}/precheck`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ values: compactValues(manifest, form) }) });
          const body = (await response.json().catch(() => ({}))) as { errors?: string[]; conflicts?: PortClash[] };
          if (!active) return;
          const conflicts = Array.isArray(body.conflicts) ? body.conflicts : null;
          // Refused before it looked at the ports (a setting it wants first), or no answer to read.
          if (!response.ok || !conflicts) { setPortReading({ state: "unread", conflicts: [], moved: movedPorts.current, reason: body.errors?.length ? "settings" : "failed" }); return; }
          for (const conflict of conflicts) triedPorts.current.add(`${conflict.port}/${conflict.protocol}`);
          const relocation = moveRounds.current < portMoveRounds
            ? relocatePorts({ manifest, values: form, conflicts, touched: touchedPorts.current, held: latest.current.heldPorts, tried: triedPorts.current, appName: latest.current.appNameFor })
            : { ports: {}, moved: {} };
          if (Object.keys(relocation.ports).length > 0) {
            // Moved to the next free one: the changed port asks again, and only a clean answer says Pass.
            moveRounds.current += 1;
            askAtOnce.current = true;
            movedPorts.current = { ...relocation.moved, ...movedPorts.current }; // where it first came from stays
            setPortText((current) => ({ ...current, ...Object.fromEntries(Object.entries(relocation.ports).map(([id, port]) => [id, String(port)])) }));
            setValues((current) => ({ ...current, ports: { ...current.ports, ...relocation.ports } }));
            return;
          }
          setPortReading({ state: "read", conflicts, moved: movedPorts.current });
        } catch {
          if (active) setPortReading({ state: "unread", conflicts: [], moved: movedPorts.current, reason: "failed" });
        }
      })();
    }, askedPorts.current && !askAtOnce.current ? 400 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [install, portsUnreadable, portsKey, manifest, csrfToken]);
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

  // The models downloaded in this server's model runners, for a setting that picks one. Embedding
  // models are left out: they turn text into numbers and cannot write an answer. null while asking.
  const [installedModels, setInstalledModels] = useState<string[] | null>(null);
  const wantsModels = manifest.env.some((entry) => entry.optionsFrom === "ollama-models");
  const runnerKey = modelRunnerApps.join(",");
  useEffect(() => {
    if (!wantsModels) return undefined;
    let active = true;
    const runners = runnerKey ? runnerKey.split(",") : [];
    void Promise.all(runners.map((id) => runRead<{ models?: Array<{ name: string }> }>(csrfToken, "app.models.inspect", { id })
      .then(({ response, body }) => (response.ok ? (body.result?.models ?? []).map((model) => model.name) : []))
      .catch(() => [] as string[]))).then((lists) => {
      if (active) setInstalledModels([...new Set(lists.flat())].filter((name) => !/embed/i.test(name)).sort());
    });
    return () => { active = false; };
  }, [wantsModels, runnerKey, csrfToken]);

  const submit = async () => {
    if (badPorts.length) return;
    const compact = { ...compactValues(manifest, values, mode === "reconfigure" ? live?.state?.values : undefined), ...(cleared.length ? { clearSecrets: cleared } : {}) };
    // The precheck resolves against the catalog's defaults, so it needs unchanged required settings
    // and custom ports too. The mutation still sends only what changed from the stored values.
    const precheckValues = compactValues(manifest, values);
    const submitOptions = { backupNightly: offersNightly && !nightly?.already && backupNightly };
    setChecking(true); setProblems([]);
    try {
      const response = await fetch(`/api/v1/catalog/${encodeURIComponent(manifest.id)}/precheck`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ values: precheckValues }) });
      const body = (await response.json().catch(() => ({}))) as { ok: boolean; errors: string[]; conflicts: PortConflict[]; error?: string };
      if (!response.ok && !body.errors?.length) throw new Error(body.error ?? "Precheck failed");
      const found = [...(body.errors ?? []), ...(body.conflicts ?? []).map((conflict) => describePortConflict(conflict, appNameFor))];
      if (found.length) { setProblems(found); return; }
      onSubmit(compact, values, submitOptions);
    } catch {
      // The precheck is advice: if it cannot run, continue and let the install report the real error.
      onSubmit(compact, values, submitOptions);
    } finally {
      setChecking(false);
    }
  };

  const setPort = (id: string, value: string) => {
    // Typed by the owner: theirs from here on, and no longer "the next free one".
    touchedPorts.current.add(id);
    if (movedPorts.current[id]) movedPorts.current = Object.fromEntries(Object.entries(movedPorts.current).filter(([moved]) => moved !== id));
    setPortText((current) => ({ ...current, [id]: value }));
    const port = portNumber(value);
    if (port !== null) setValues((current) => ({ ...current, ports: { ...current.ports, [id]: port } }));
  };
  const setEnv = (name: string, value: string) => {
    setValues((current) => ({ ...current, env: { ...current.env, [name]: value } }));
    if (value) setCleared((current) => current.filter((entry) => entry !== name)); // typing a new one replaces, not clears
  };
  const setVolume = (id: string, value: string) => setValues((current) => ({ ...current, volumes: { ...current.volumes, [id]: value } }));
  const toggleSetup = (id: string, checked: boolean) => setValues((current) => ({ ...current, setup: checked ? [...new Set([...(current.setup ?? []), id])] : (current.setup ?? []).filter((entry) => entry !== id) }));

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
        {badPorts.length > 0 && <span className="catalog-form__blocker" role="status">Still needed: a port number from 1 to 65535 for {badPorts.map((port) => port.label).join(", ")}.</span>}
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} risk={mode === "install" ? installTier(manifest) : riskOf(operationId)} disabled={checking || badPorts.length > 0}>{checking ? "Checking…" : mode === "install" ? "Continue to install" : "Apply settings"}</Button>
      </>}
    >
      <form id={formId} className="catalog-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {problems.length > 0 && (
          <Notice tone="danger" live title={mode === "install" ? "Not installed yet" : "Not changed yet"}>
            <ul className="catalog-form__problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          </Notice>
        )}
        {install && (
          <PreflightPanel
            manifest={manifest} values={values} ports={portReading} host={host} appNameFor={appNameFor}
            nightly={offersNightly ? { checked: backupNightly, onChange: setBackupNightly, time: nightlyTime, already: nightly?.already ?? null } : null}
          />
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
              <Field key={port.id} label={`${port.label} port`} error={badPorts.includes(port) ? "A number from 1 to 65535." : undefined} hint={`${port.containerFollowsHost ? "The app listens here" : `Container ${port.container}/${port.protocol}`} · ${port.exposure === "loopback" ? "this server only" : mode === "install" && manifest.defaultExposure === "tailnet" && port.protocol === "tcp" ? "your tailnet, over HTTPS" : "your network"}`}>
                <TextInput type="number" mono min={1} max={65535} value={portText[port.id] ?? String(values.ports[port.id] ?? port.host)} onValueChange={(value) => setPort(port.id, value)} />
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
              const pickModel = entry.optionsFrom === "ollama-models";
              const modelChoices = pickModel && installedModels?.length
                ? [...new Set([...installedModels, values.env[entry.name] ?? ""].filter(Boolean))]
                : null;
              const modelHint = pickModel && installedModels !== null && !installedModels.length
                ? "No downloaded models were found in this server's Ollama apps. Type a model name, or download one from Ollama's Models tab."
                : null;
              const labels = entry.optionLabels ?? null;
              const chosen = labels?.find((option) => option.value === (values.env[entry.name] ?? "")) ?? null;
              const hint = <>{entry.description}{chosen?.hint ? <>{entry.description ? " " : ""}<strong>{chosen.label}:</strong> {chosen.hint}</> : null}{modelHint ? <>{entry.description ? " " : ""}{modelHint}</> : null}{entry.name === "USE_VPN_PROFILE" && usingVpnProfile ? <>{entry.description ? " " : ""}The VPN provider and key come from your VPN profile (set it up on the Network page). If none is saved, the install will ask you to save one first.</> : null}</>;
              const hasHint = Boolean(entry.description) || Boolean(chosen?.hint) || Boolean(modelHint) || (entry.name === "USE_VPN_PROFILE" && usingVpnProfile);
              return (
                <Field key={entry.name} label={entry.label} required={entry.required} hint={hasHint ? hint : undefined}>
                  {modelChoices
                    ? <Select value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} options={modelChoices.map((model) => ({ value: model, label: installedModels?.includes(model) ? model : `${model} (not downloaded)` }))} />
                    : entry.options
                    ? <Select value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} options={entry.options.map((option) => ({ value: option, label: labels?.find((named) => named.value === option)?.label ?? option }))} />
                    : entry.type === "boolean"
                      ? <Select value={values.env[entry.name] || "false"} onValueChange={(value) => setEnv(entry.name, value)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                      : entry.type === "password" || entry.secret
                        ? <SavedSecret
                            entryName={entry.name} label={entry.label}
                            value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)}
                            saved={savedSecrets.has(entry.name)} clearable={!entry.required}
                            cleared={cleared.includes(entry.name)}
                            onClear={(clear) => { setCleared((current) => (clear ? [...new Set([...current, entry.name])] : current.filter((name) => name !== entry.name))); if (clear) setEnv(entry.name, ""); }}
                          />
                        : <TextInput type={entry.type === "number" ? "number" : "text"} mono={pickModel || entry.type === "path" || entry.type === "timezone"} value={values.env[entry.name] ?? ""} onValueChange={(value) => setEnv(entry.name, value)} />}
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
        {install && <p className="catalog-form__hint catalog-preflight__starts">{startsWords(manifest, values)}</p>}
      </form>
    </Sheet>
  );
}

/**
 * A secret setting in Settings. Its saved value never reaches the browser, so an empty box used to
 * look like a forgotten one, and owners typed keys again (a wrong one then replaced the right one).
 * Now an empty box says it is saved and kept, and an optional secret can be cleared on purpose.
 */
function SavedSecret({ entryName, label, value, onValueChange, saved, clearable, cleared, onClear }: { entryName: string; label: string; value: string; onValueChange: (value: string) => void; saved: boolean; clearable: boolean; cleared: boolean; onClear: (clear: boolean) => void }) {
  const placeholder = cleared ? "Will be cleared when you save" : saved ? "Saved · leave empty to keep" : undefined;
  return (
    <div className="catalog-secret" data-secret={entryName}>
      <SecretInput value={value} onValueChange={onValueChange} autoComplete="new-password" placeholder={placeholder} aria-label={label} />
      {saved && clearable && !value && (
        <Button type="button" variant="ghost" onClick={() => onClear(!cleared)} aria-pressed={cleared}>{cleared ? "Keep it" : "Clear"}</Button>
      )}
    </div>
  );
}
