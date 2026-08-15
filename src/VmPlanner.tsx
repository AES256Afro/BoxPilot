import { useEffect, useState, type FormEvent } from "react";
import {
  createVmPlan,
  fetchVmPlanningOptions,
  formatBytes,
  type VmCreationPlan,
  type VmPlanInput,
  type VmPlanningOptions,
} from "./virtualization";

const initialInput: VmPlanInput = {
  name: "",
  osProfile: "ubuntu-24.04",
  vcpus: 2,
  memoryMiB: 4096,
  diskGiB: 40,
  isoFile: "",
  network: "default",
  firmware: "uefi",
  autostart: false,
};

export default function VmPlanner({ onClose, csrfToken = "" }: { onClose: () => void; csrfToken?: string }) {
  const [options, setOptions] = useState<VmPlanningOptions | null>(null);
  const [input, setInput] = useState<VmPlanInput>(initialInput);
  const [plan, setPlan] = useState<VmCreationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    void fetchVmPlanningOptions()
      .then((nextOptions) => {
        setOptions(nextOptions);
        setInput((current) => ({ ...current, isoFile: current.isoFile || nextOptions.isoImages[0]?.name || "" }));
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load planning options"))
      .finally(() => setLoading(false));
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const updateInput = <Key extends keyof VmPlanInput>(key: Key, value: VmPlanInput[Key]) => {
    setInput((current) => ({ ...current, [key]: value }));
    setPlan(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      setPlan(await createVmPlan(input, csrfToken));
    } catch (requestError) {
      setPlan(null);
      setError(requestError instanceof Error ? requestError.message : "Unable to create VM plan");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="vm-planner-backdrop" role="presentation">
      <section className="vm-planner-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-planner-title">
        <header className="vm-planner-header">
          <div><span className="eyebrow">Read-only planning</span><h2 id="vm-planner-title">Plan a new virtual machine</h2><p>Validate capacity, media, and libvirt arguments without creating a disk or guest.</p></div>
          <button type="button" className="modal-close" aria-label="Close VM planner" onClick={onClose} autoFocus>X</button>
        </header>

        {loading ? (
          <div className="vm-planner-loading">Loading host capacity and managed ISO media...</div>
        ) : !options ? (
          <div className="vm-error"><strong>Planning options unavailable</strong><span>{error}</span></div>
        ) : (
          <div className="vm-planner-body">
            <form className="vm-plan-form" onSubmit={(event) => void submit(event)}>
              <div className="vm-capacity-strip">
                <span><strong>{options.hostCapacity.cpuThreads}</strong> host CPU threads</span>
                <span><strong>{Math.floor(options.hostCapacity.memoryMiB / 1024)} GiB</strong> host memory</span>
                <span><strong>{options.isoImages.length}</strong> managed ISO{options.isoImages.length === 1 ? "" : "s"}</span>
              </div>

              <div className="vm-form-grid">
                <label>VM name<input required value={input.name} onChange={(event) => updateInput("name", event.target.value)} placeholder="ubuntu-lab" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" /></label>
                <label>Operating system<select value={input.osProfile} onChange={(event) => {
                  const profile = event.target.value;
                  updateInput("osProfile", profile);
                  if (profile === "windows-11") updateInput("firmware", "uefi");
                }}>{options.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label}</option>)}</select></label>
                <label>vCPUs<input type="number" value={input.vcpus} min={options.limits.vcpus.minimum} max={options.limits.vcpus.maximum} onChange={(event) => updateInput("vcpus", Number(event.target.value))} /></label>
                <label>Memory (MiB)<input type="number" value={input.memoryMiB} min={options.limits.memoryMiB.minimum} max={options.limits.memoryMiB.maximum} step="256" onChange={(event) => updateInput("memoryMiB", Number(event.target.value))} /></label>
                <label>Disk (GiB)<input type="number" value={input.diskGiB} min={options.limits.diskGiB.minimum} max={options.limits.diskGiB.maximum} onChange={(event) => updateInput("diskGiB", Number(event.target.value))} /></label>
                <label>Install ISO<select value={input.isoFile} onChange={(event) => updateInput("isoFile", event.target.value)} disabled={!options.isoImages.length}><option value="">Select managed media</option>{options.isoImages.map((iso) => <option value={iso.name} key={iso.name}>{iso.name} ({formatBytes(iso.sizeBytes)})</option>)}</select></label>
                <label>Network<select value={input.network} onChange={(event) => updateInput("network", event.target.value)}>{options.networks.map((network) => <option value={network.name} key={network.name}>{network.name} ({network.kind})</option>)}</select></label>
                <label>Firmware<select value={input.firmware} disabled={input.osProfile === "windows-11"} onChange={(event) => updateInput("firmware", event.target.value as "uefi" | "bios")}><option value="uefi">UEFI</option><option value="bios">Legacy BIOS</option></select></label>
              </div>

              <label className="vm-checkbox"><input type="checkbox" checked={input.autostart} onChange={(event) => updateInput("autostart", event.target.checked)} /><span>Start this VM automatically with the host</span></label>

              {!options.isoImages.length && (
                <div className="vm-media-empty">
                  <strong>No managed ISO images found</strong>
                  <span>{options.mediaError ?? `Copy readable .iso files into ${options.mediaRoot}`}</span>
                  <code>sudo install -d -m 0755 {options.mediaRoot}</code>
                  <code>sudo cp /path/to/installer.iso {options.mediaRoot}/</code>
                </div>
              )}

              {error && <p className="vm-plan-error" role="alert">{error}</p>}
              <div className="vm-plan-form-actions">
                <button type="button" className="text-button" onClick={onClose}>Cancel</button>
                <button type="submit" className="primary-button" disabled={submitting || !options.isoImages.length}>{submitting ? "Validating..." : "Generate reviewed plan"}</button>
              </div>
            </form>

            <aside className="vm-plan-preview" aria-live="polite">
              {!plan ? (
                <div className="vm-plan-placeholder"><span>01</span><strong>Complete the plan</strong><p>BoxPilot will validate every field on the server and render the exact argument array.</p></div>
              ) : (
                <>
                  <div className="vm-plan-ready"><span className="eyebrow">Plan revision {plan.revision}</span><strong>Validated, not executable</strong><p>This route did not invoke virt-install, define a domain, or create a disk.</p></div>
                  <dl className="vm-plan-summary">
                    <div><dt>Guest</dt><dd>{plan.input.name}</dd></div>
                    <div><dt>Profile</dt><dd>{plan.profile.label}</dd></div>
                    <div><dt>Resources</dt><dd>{plan.input.vcpus} vCPU | {Math.floor(plan.input.memoryMiB / 1024)} GiB RAM | {plan.input.diskGiB} GiB disk</dd></div>
                    <div><dt>Media</dt><dd>{plan.media.name}</dd></div>
                  </dl>
                  {plan.warnings.length > 0 && <div className="vm-plan-warnings"><strong>Warnings</strong>{plan.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
                  <div className="vm-command-preview"><strong>Future helper request preview</strong><code>{plan.command.display}</code></div>
                  <div className="vm-plan-gates"><strong>Required before Apply</strong><ol>{plan.gates.map((gate) => <li key={gate}>{gate}</li>)}</ol></div>
                  <button type="button" className="primary-button" disabled title="Restricted helper and durable approvals are required">Apply remains locked</button>
                </>
              )}
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}
