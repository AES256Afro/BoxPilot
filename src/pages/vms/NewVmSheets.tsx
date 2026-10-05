import { useEffect, useRef, useState, type FormEvent } from "react";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, CodeBlock, Field, KeyValue, Notice, Select, Sheet, TextInput, Textarea, riskOf } from "../../ui";
import { createVmPlan, fetchVmPlanningOptions, formatBytes, formatMemory, type VmCreationPlan, type VmPlanInput, type VmPlanningOptions } from "../../virtualization";
import { AsksFor, isVmName, vmNamePattern, type StartOperation } from "./vmActions";

/*
 * The two ways to make a VM (M33.12), each a sheet over the page: from an official cloud image with
 * cloud-init (one form, one confirmation), or planned from an ISO in the media library (the server
 * validates the plan and shows the exact command before anything is created; creating it asks for
 * the password and the VM's name typed out).
 */

interface CloudImage { id: string; label: string; defaultUser: string; cached: boolean; digest: string | null }
const fallbackImage: CloudImage = { id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS (Noble)", defaultUser: "ubuntu", cached: false, digest: null };
const githubUserPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A whole number from a number field, or the fallback while it is being typed. */
const whole = (text: string, fallback: number) => Number.parseInt(text, 10) || fallback;

/** Keys fetched from a GitHub account, merged with the ones already typed, without repeats. */
export async function githubKeys(user: string, current: string): Promise<string> {
  const response = await fetch(`/api/v1/ssh-keys/github/${encodeURIComponent(user)}`);
  const body = (await response.json().catch(() => ({}))) as { keys?: string[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Could not fetch keys");
  if (!body.keys?.length) throw new Error(`GitHub user ${user} has no public keys`);
  return [...new Set([...current.split("\n").map((line) => line.trim()).filter(Boolean), ...body.keys])].join("\n");
}

/** The cloud-image form as it was filled in, kept by the page while its approval is open. */
export interface CloudVmDraft { name: string; image: string; vcpus: string; memoryMiB: string; diskGiB: string; username: string; sshKeys: string; githubUser: string; packages: string; autostart: boolean }
const emptyCloudDraft: CloudVmDraft = { name: "", image: "ubuntu-24.04", vcpus: "2", memoryMiB: "2048", diskGiB: "20", username: "", sshKeys: "", githubUser: "", packages: "", autostart: false };

/**
 * "New project VM": an official cloud image and cloud-init with your SSH key, ready in about a minute.
 * The sheet closes for the approval; `onReopen` puts it back as it was filled in (`seed`) when the
 * job does not complete.
 */
export function CloudVmSheet({ onClose, start, seed, onReopen }: { onClose: () => void; start: StartOperation; seed?: CloudVmDraft; onReopen?: (draft: CloudVmDraft) => void }) {
  const first = seed ?? emptyCloudDraft;
  const [images, setImages] = useState<CloudImage[]>([]);
  const [name, setName] = useState(first.name);
  const [image, setImage] = useState(first.image);
  const [vcpus, setVcpus] = useState(first.vcpus);
  const [memoryMiB, setMemoryMiB] = useState(first.memoryMiB);
  const [diskGiB, setDiskGiB] = useState(first.diskGiB);
  const [username, setUsername] = useState(first.username);
  const [sshKeys, setSshKeys] = useState(first.sshKeys);
  const [githubUser, setGithubUser] = useState(first.githubUser);
  const [packages, setPackages] = useState(first.packages);
  const [autostart, setAutostart] = useState(first.autostart);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    inspectOperation<{ images: CloudImage[] }>("vm.cloud.images").then(({ result }) => setImages(Array.isArray(result.images) ? result.images : [])).catch(() => setImages([]));
  }, []);

  const choices = images.length ? images : [fallbackImage];
  const selected = choices.find((item) => item.id === image);
  const keys = sshKeys.split("\n").map((line) => line.trim()).filter(Boolean);
  const packageList = packages.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const nameValid = isVmName(name);
  const valid = nameValid && keys.length > 0;
  const cpus = whole(vcpus, 1);
  const memory = whole(memoryMiB, 512);
  const disk = whole(diskGiB, 4);

  const importKeys = async () => {
    const user = githubUser.trim();
    if (!githubUserPattern.test(user)) { setError("Enter a GitHub user name"); return; }
    setImporting(true);
    setError(null);
    try { setSshKeys(await githubKeys(user, sshKeys)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not fetch keys"); }
    finally { setImporting(false); }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const parameters: Record<string, unknown> = { name, image, vcpus: cpus, memoryMiB: memory, diskGiB: disk, sshKeys: keys, autostart };
    if (username.trim()) parameters.username = username.trim();
    if (packageList.length) parameters.packages = packageList;
    const draft: CloudVmDraft = { name, image, vcpus, memoryMiB, diskGiB, username, sshKeys, githubUser, packages, autostart };
    onClose();
    start({
      operationId: "vm.cloud.create", title: `Create VM ${name}`, parameters,
      preview: <span>{selected?.label ?? image}, {cpus} vCPU, {memory} MiB RAM, {disk} GiB disk, user <code>{username.trim() || selected?.defaultUser || "ubuntu"}</code> with {keys.length} SSH key{keys.length === 1 ? "" : "s"}{packageList.length ? `, packages: ${packageList.join(", ")}` : ""}. {selected?.cached ? "Base image is cached." : "The base image will be downloaded first (a few hundred MB, checksum verified)."}</span>,
      onClosed: (job) => { if (job?.state !== "completed") onReopen?.(draft); },
    });
  };

  return (
    <Sheet kicker="New project VM" title="From a cloud image" size="md" onClose={onClose} className="vms-sheet"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="vms-cloud-form" variant="primary" risk={riskOf("vm.cloud.create")} disabled={!valid}>Review and create</Button>
      </>}>
      <form id="vms-cloud-form" className="vms-form" onSubmit={submit}>
        <fieldset className="vms-fieldset">
          <legend>Machine</legend>
          <Field label="Name" required error={name && !nameValid ? "Use 1-63 letters, numbers, dots, underscores or hyphens" : undefined}>
            <TextInput mono value={name} onValueChange={setName} placeholder="dev-1" autoComplete="off" />
          </Field>
          <Field label="Image" hint="Official Ubuntu or Debian cloud image, checksum verified.">
            <Select value={image} onValueChange={setImage} options={choices.map((item) => ({ value: item.id, label: `${item.label}${item.cached ? " · cached" : ""}` }))} />
          </Field>
          <div className="vms-sizes">
            <Field label="vCPUs"><TextInput mono type="number" min={1} max={64} value={vcpus} onValueChange={setVcpus} /></Field>
            <Field label="Memory (MiB)"><TextInput mono type="number" min={512} max={524288} step={256} value={memoryMiB} onValueChange={setMemoryMiB} /></Field>
            <Field label="Disk (GiB)"><TextInput mono type="number" min={4} max={4096} value={diskGiB} onValueChange={setDiskGiB} /></Field>
          </div>
          <Checkbox label="Start automatically when this server boots" checked={autostart} onChange={setAutostart} />
        </fieldset>
        <fieldset className="vms-fieldset">
          <legend>Access</legend>
          <Field label="User name" optional hint={`Default ${selected?.defaultUser ?? "ubuntu"}, with passwordless sudo.`}>
            <TextInput mono value={username} onValueChange={setUsername} placeholder={selected?.defaultUser ?? "ubuntu"} autoComplete="off" />
          </Field>
          <Field label="SSH public keys" required hint="One per line.">
            <Textarea mono rows={3} value={sshKeys} onValueChange={setSshKeys} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
          </Field>
          <div className="vms-inline">
            <TextInput aria-label="GitHub user" mono value={githubUser} onValueChange={setGithubUser} placeholder="GitHub user name" autoComplete="off" />
            <Button busy={importing} onClick={() => void importKeys()}>Import keys from GitHub</Button>
          </div>
          <Field label="Extra packages" optional hint="Installed on first boot.">
            <TextInput mono value={packages} onValueChange={setPackages} placeholder="docker.io git build-essential" autoComplete="off" />
          </Field>
        </fieldset>
        {error && <Notice tone="danger" live title="Not yet">{error}</Notice>}
        <p className="vms-note">On the default NAT network; its address appears in the result and in the VM list.</p>
      </form>
    </Sheet>
  );
}

const initialPlan: VmPlanInput = { name: "", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "", network: "default", firmware: "uefi", autostart: false };

/**
 * Plan a VM from an ISO: the host's capacity and the managed media, then a plan the server validates
 * and renders as the exact command. Nothing is created until the plan goes to approval. `seed` is the
 * plan's form as it was, put back when its approval was cancelled or its job did not complete.
 */
export function PlanVmSheet({ onClose, onStage, csrfToken, seed }: { onClose: () => void; onStage: (input: VmPlanInput) => void; csrfToken: string; seed?: VmPlanInput }) {
  const [options, setOptions] = useState<VmPlanningOptions | null>(null);
  const [input, setInput] = useState<VmPlanInput>(seed ?? initialPlan);
  const [plan, setPlan] = useState<VmCreationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form as it is now, to tell a plan answered for it from one answered for values since changed.
  const current = useRef(input);
  current.current = input;

  useEffect(() => {
    void fetchVmPlanningOptions()
      .then((next) => { setOptions(next); setInput((current) => ({ ...current, isoFile: current.isoFile || next.isoImages[0]?.name || "" })); })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load planning options"))
      .finally(() => setLoading(false));
  }, []);

  const update = <Key extends keyof VmPlanInput>(key: Key, value: VmPlanInput[Key]) => { setInput((current) => ({ ...current, [key]: value })); setPlan(null); setError(null); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const asked = input;
    setSubmitting(true);
    setError(null);
    // An answer for values changed while it was on its way is dropped: shown, it was staged with
    // the values from before the change.
    try { const next = await createVmPlan(asked, csrfToken); if (current.current === asked) setPlan(next); }
    catch (requestError) { if (current.current === asked) { setPlan(null); setError(requestError instanceof Error ? requestError.message : "Unable to create VM plan"); } }
    finally { setSubmitting(false); }
  };

  const windows = input.osProfile === "windows-11";
  return (
    <Sheet kicker="New virtual machine" title="Plan from an ISO" size="lg" onClose={onClose} className="vms-sheet"
      footer={plan ? <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" risk={riskOf("vm.create")} disabled={!plan.stageable} title={plan.stageable ? undefined : "This operating-system profile needs additional host capability checks"} onClick={() => onStage(plan.input)}>{plan.stageable ? "Continue to approval" : "Cannot create this VM yet"}</Button>
      </> : <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="vms-plan-form" variant="primary" busy={submitting} disabled={!options?.isoImages.length}>Generate reviewed plan</Button>
      </>}>
      {loading ? <p className="vms-note">Reading the host's capacity and the managed ISO media…</p>
        : !options ? <Notice tone="danger" live title="Planning options unavailable">{error}</Notice>
          : (
            <>
              <KeyValue layout="strip" items={[
                { id: "cpu", label: "Host CPU threads", value: String(options.hostCapacity.cpuThreads) },
                { id: "memory", label: "Host memory", value: `${Math.floor(options.hostCapacity.memoryMiB / 1024)} GiB` },
                { id: "isos", label: "Managed ISOs", value: String(options.isoImages.length) },
              ]} />
              <form id="vms-plan-form" className="vms-form vms-form--grid" onSubmit={(event) => void submit(event)}>
                <Field label="VM name" required>
                  <TextInput mono value={input.name} onValueChange={(value) => update("name", value)} placeholder="ubuntu-lab" pattern={vmNamePattern} required autoComplete="off" />
                </Field>
                <Field label="Operating system">
                  <Select value={input.osProfile} onValueChange={(profile) => { update("osProfile", profile); if (profile === "windows-11") update("firmware", "uefi"); }} options={options.profiles.map((profile) => ({ value: profile.id, label: profile.label }))} />
                </Field>
                <Field label="vCPUs" hint={`${options.limits.vcpus.minimum}-${options.limits.vcpus.maximum}`}>
                  <TextInput mono type="number" value={input.vcpus} min={options.limits.vcpus.minimum} max={options.limits.vcpus.maximum} onValueChange={(value) => update("vcpus", Number(value))} />
                </Field>
                <Field label="Memory (MiB)" hint={`${options.limits.memoryMiB.minimum}-${options.limits.memoryMiB.maximum}`}>
                  <TextInput mono type="number" value={input.memoryMiB} min={options.limits.memoryMiB.minimum} max={options.limits.memoryMiB.maximum} step={256} onValueChange={(value) => update("memoryMiB", Number(value))} />
                </Field>
                <Field label="Disk (GiB)" hint={`${options.limits.diskGiB.minimum}-${options.limits.diskGiB.maximum}`}>
                  <TextInput mono type="number" value={input.diskGiB} min={options.limits.diskGiB.minimum} max={options.limits.diskGiB.maximum} onValueChange={(value) => update("diskGiB", Number(value))} />
                </Field>
                <Field label="Install ISO">
                  <Select mono value={input.isoFile} onValueChange={(value) => update("isoFile", value)} disabled={!options.isoImages.length} placeholder="Select managed media" options={options.isoImages.map((iso) => ({ value: iso.name, label: `${iso.name} (${formatBytes(iso.sizeBytes)})` }))} />
                </Field>
                <Field label="Network">
                  <Select value={input.network} onValueChange={(value) => update("network", value)} options={options.networks.map((network) => ({ value: network.name, label: `${network.name} (${network.kind})` }))} />
                </Field>
                <Field label="Firmware" hint={windows ? "Windows 11 needs UEFI." : undefined}>
                  <Select value={input.firmware} disabled={windows} onValueChange={(value) => update("firmware", value as "uefi" | "bios")} options={[{ value: "uefi", label: "UEFI" }, { value: "bios", label: "Legacy BIOS" }]} />
                </Field>
                <Checkbox className="vms-form__wide" label="Start this VM automatically with the host" checked={input.autostart} onChange={(checked) => update("autostart", checked)} />
              </form>
              {!options.isoImages.length && (
                <Notice tone="warning" title="No managed ISO images found">
                  <p>{options.mediaError ?? "Close this, upload an ISO on the Media tab, then approve its import."}</p>
                  <p>Library: <code>{options.mediaRoot}</code></p>
                </Notice>
              )}
              {error && <Notice tone="danger" live title="The plan was not accepted">{error}</Notice>}
              {plan && (
                <section className="vms-plan" aria-live="polite" aria-label="The reviewed plan">
                  <Notice tone={plan.stageable ? "success" : "warning"} title={plan.stageable ? "Ready to create" : "Cannot create yet"}>
                    Plan revision <code>{plan.revision}</code>. Planning did not run virt-install, define a VM or create a disk; the plan is checked against the live host again when you approve.
                  </Notice>
                  <KeyValue items={[
                    { id: "guest", label: "Guest", value: plan.input.name, mono: true },
                    { id: "profile", label: "Profile", value: plan.profile.label },
                    { id: "resources", label: "Resources", mono: true, value: `${plan.input.vcpus} vCPU · ${formatMemory(plan.input.memoryMiB * 1024)} RAM · ${plan.input.diskGiB} GiB disk` },
                    { id: "media", label: "Media", value: plan.media.name, mono: true },
                  ]} />
                  {plan.warnings.length > 0 && <Notice tone="warning" title="Warnings"><ul className="vms-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Notice>}
                  <CodeBlock label="Command that will run">{plan.command.display}</CodeBlock>
                  <div className="vms-gates">
                    <h3>Guardrails</h3>
                    <ol className="vms-list">{plan.gates.map((gate) => <li key={gate}>{gate}</li>)}</ol>
                  </div>
                  {plan.stageable && <AsksFor action="Creating it" typed={plan.input.name} />}
                </section>
              )}
            </>
          )}
    </Sheet>
  );
}
