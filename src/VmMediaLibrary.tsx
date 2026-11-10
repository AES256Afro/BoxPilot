import { useEffect, useState, type ChangeEvent } from "react";
import {
  createVmMediaImportPlan,
  createUbuntuMediaAcquisitionPlan,
  fetchUbuntuMediaCatalog,
  fetchVmMedia,
  formatBytes,
  stageVmMediaImportPlan,
  stageUbuntuMediaAcquisitionPlan,
  uploadVmMedia,
  type VmMediaImportPlan,
  type VmMediaInventory,
  type UbuntuMediaAcquisitionPlan,
  type UbuntuMediaCatalog,
} from "./virtualization";

export default function VmMediaLibrary({ csrfToken, onOpenRepair }: { csrfToken: string; onOpenRepair: () => void }) {
  const [inventory, setInventory] = useState<VmMediaInventory | null>(null);
  const [catalog, setCatalog] = useState<UbuntuMediaCatalog | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<VmMediaImportPlan | null>(null);
  const [acquisitionPlan, setAcquisitionPlan] = useState<UbuntuMediaAcquisitionPlan | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const managedImages = inventory?.library?.images ?? [];
  const stagedCandidates = inventory?.inbox?.candidates ?? [];

  const refresh = async () => {
    const [nextInventory, nextCatalog] = await Promise.all([fetchVmMedia(), fetchUbuntuMediaCatalog()]);
    setInventory(nextInventory);
    setCatalog(nextCatalog);
  };

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load VM media"));
  }, []);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setMessage(null);
  };

  const upload = async () => {
    if (!file) return;
    setPending("upload");
    setMessage(null);
    try {
      const uploaded = await uploadVmMedia(file, csrfToken);
      setMessage(`Uploaded ${uploaded.name}. Review its SHA-256 and stage a separate import approval.`);
      setFile(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to upload ISO media");
    } finally {
      setPending(null);
    }
  };

  const planImport = async (filename: string) => {
    setPending(`plan:${filename}`);
    setMessage(null);
    try {
      setPlan(await createVmMediaImportPlan(filename, csrfToken));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to plan ISO import");
    } finally {
      setPending(null);
    }
  };

  const planAcquisition = async (imageId: string) => {
    setPending(`acquire-plan:${imageId}`);
    setMessage(null);
    try {
      setAcquisitionPlan(await createUbuntuMediaAcquisitionPlan(imageId, csrfToken));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to plan the official Ubuntu media acquisition");
    } finally {
      setPending(null);
    }
  };

  const stageAcquisition = async () => {
    if (!acquisitionPlan) return;
    setPending(`acquire-stage:${acquisitionPlan.id}`);
    setMessage(null);
    try {
      await stageUbuntuMediaAcquisitionPlan(acquisitionPlan.id, acquisitionPlan.revision, csrfToken);
      setAcquisitionPlan(null);
      onOpenRepair();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to stage the official Ubuntu media acquisition");
    } finally {
      setPending(null);
    }
  };

  const stage = async () => {
    if (!plan) return;
    setPending(`stage:${plan.id}`);
    setMessage(null);
    try {
      await stageVmMediaImportPlan(plan.id, plan.revision, csrfToken);
      setPlan(null);
      onOpenRepair();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to stage ISO import");
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <section className="panel vm-resources-panel vm-media-library">
        <header className="panel-header"><div><strong>VM installation media</strong><span>Authenticated staging and separately approved import</span></div><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={pending !== null}>Refresh media</button></header>
        <div className="vm-media-grid">
          <div>
            <span className="eyebrow">Managed library</span>
            <strong>{managedImages.length} usable ISO{managedImages.length === 1 ? "" : "s"}</strong>
            <p>VM creation can select only regular ISO files published in the fixed libvirt media directory.</p>
            {managedImages.map((image) => <div className="vm-media-row" key={image.name}><span><strong>{image.name}</strong><small>{formatBytes(image.sizeBytes)}</small></span><span className="status-pill status-good">managed</span></div>)}
          </div>
          <div>
            <span className="eyebrow">Upload staging</span>
            <label className="vm-media-picker">Select ISO<input type="file" accept=".iso,application/x-iso9660-image" onChange={chooseFile} disabled={pending !== null} /></label>
            <p>{file ? `${file.name} | ${formatBytes(file.size)}` : `One .iso file up to ${formatBytes(inventory?.limits?.maximumIsoBytes ?? 16 * 1024 ** 3)}`}</p>
            <button type="button" className="primary-button" disabled={!file || pending !== null} onClick={() => void upload()}>{pending === "upload" ? "Uploading and hashing..." : "Upload to staging"}</button>
          </div>
        </div>
        <div className="vm-media-candidates vm-official-catalog"><strong>Official Ubuntu Server catalog</strong><p>These two identities are compiled into this BoxPilot release. Download still requires a reviewed plan and fresh password approval.</p>{catalog?.images.map((image) => <div className="vm-media-row" key={image.id}><span><strong>{image.label}</strong><small>{formatBytes(image.sizeBytes)} | SHA-256 {image.sha256.slice(0, 16)}... | releases.ubuntu.com</small></span>{image.state === "available" ? <button type="button" className="text-button" disabled={pending !== null} onClick={() => void planAcquisition(image.id)}>{pending === `acquire-plan:${image.id}` ? "Revalidating..." : "Review official download"}</button> : <span className="status-pill status-good">{image.state}</span>}</div>)}</div>
        {stagedCandidates.length > 0 && <div className="vm-media-candidates"><strong>Awaiting import approval</strong>{stagedCandidates.map((candidate) => <div className="vm-media-row" key={candidate.revision}><span><strong>{candidate.name}</strong><small>{formatBytes(candidate.sizeBytes)} | SHA-256 {candidate.sha256.slice(0, 16)}...</small></span><button type="button" className="text-button" disabled={pending !== null} onClick={() => void planImport(candidate.name)}>{pending === `plan:${candidate.name}` ? "Verifying..." : "Review import"}</button></div>)}</div>}
        <div className="vm-control-lock"><div><strong>Separate acquisition and import approvals</strong><span>Browser upload writes only to staging. Official acquisition downloads one compiled identity into the same staging area. Either path still requires a second immutable import plan and fresh password approval before libvirt can use the ISO.</span></div></div>
        {message && <p className="vm-message" aria-live="polite">{message}</p>}
      </section>
      {plan && <div className="vm-planner-backdrop" role="presentation"><section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-media-import-title"><header className="vm-planner-header"><div><span className="eyebrow">Immutable media import</span><h2 id="vm-media-import-title">Import {plan.input.filename}</h2><p>Review the exact staged bytes and confined destination before creating an approval job.</p></div><button type="button" className="modal-close" aria-label="Close media import plan" onClick={() => setPlan(null)}>X</button></header><dl className="vm-plan-summary"><div><dt>Size</dt><dd>{formatBytes(plan.input.expectedSizeBytes)}</dd></div><div><dt>SHA-256</dt><dd><code>{plan.input.expectedSha256}</code></dd></div><div><dt>Destination</dt><dd>{plan.destination}</dd></div><div><dt>Existing media</dt><dd>Never overwritten</dd></div></dl><div className="vm-plan-gates"><strong>Exact changes</strong><ol>{plan.changes.map((change) => <li key={change}>{change}</li>)}</ol></div><div className="vm-plan-gates"><strong>Verification</strong><ol>{plan.verification.map((item) => <li key={item}>{item}</li>)}</ol></div><div className="vm-plan-warnings"><strong>Locked boundaries</strong>{plan.boundaries.map((boundary) => <span key={boundary}>{boundary}</span>)}</div><p>{plan.recovery}</p><div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setPlan(null)}>Cancel</button><button type="button" className="primary-button" disabled={pending !== null} onClick={() => void stage()}>{pending === `stage:${plan.id}` ? "Revalidating..." : "Stage for password approval"}</button></div></section></div>}
      {acquisitionPlan && <div className="vm-planner-backdrop" role="presentation"><section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="ubuntu-media-acquisition-title"><header className="vm-planner-header"><div><span className="eyebrow">Fixed official artifact</span><h2 id="ubuntu-media-acquisition-title">Acquire {acquisitionPlan.artifact.label}</h2><p>Review the compiled Ubuntu release identity before creating the networked approval job.</p></div><button type="button" className="modal-close" aria-label="Close Ubuntu media acquisition plan" onClick={() => setAcquisitionPlan(null)}>X</button></header><dl className="vm-plan-summary"><div><dt>Filename</dt><dd>{acquisitionPlan.artifact.name}</dd></div><div><dt>Size</dt><dd>{formatBytes(acquisitionPlan.artifact.sizeBytes)}</dd></div><div><dt>SHA-256</dt><dd><code>{acquisitionPlan.artifact.sha256}</code></dd></div><div><dt>Fixed source</dt><dd>releases.ubuntu.com</dd></div></dl><div className="vm-plan-gates"><strong>Exact changes</strong><ol>{acquisitionPlan.changes.map((change) => <li key={change}>{change}</li>)}</ol></div><div className="vm-plan-gates"><strong>Verification</strong><ol>{acquisitionPlan.verification.map((item) => <li key={item}>{item}</li>)}</ol></div><div className="vm-plan-warnings"><strong>Locked boundaries</strong>{acquisitionPlan.boundaries.map((boundary) => <span key={boundary}>{boundary}</span>)}</div><p>{acquisitionPlan.recovery}</p><div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setAcquisitionPlan(null)}>Cancel</button><button type="button" className="primary-button" disabled={pending !== null} onClick={() => void stageAcquisition()}>{pending === `acquire-stage:${acquisitionPlan.id}` ? "Revalidating..." : "Stage official download approval"}</button></div></section></div>}
    </>
  );
}
