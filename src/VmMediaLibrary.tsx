import { useEffect, useState, type ChangeEvent } from "react";
import { useOperation } from "./ApproveDialog";
import { fetchVmMedia, formatBytes, uploadVmMedia, type VmMediaInventory } from "./virtualization";

export default function VmMediaLibrary({ csrfToken }: { csrfToken: string; onOpenRepair?: () => void }) {
  const [inventory, setInventory] = useState<VmMediaInventory | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const managedImages = inventory?.library?.images ?? [];
  const stagedCandidates = inventory?.inbox?.candidates ?? [];

  const refresh = async () => {
    setInventory(await fetchVmMedia());
  };

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load VM media"));
  }, []);

  const { start: startOperation, dialog } = useOperation(csrfToken, () => { void refresh(); });

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
      setMessage(`Uploaded ${uploaded.name}. Review its SHA-256, then approve the import.`);
      setFile(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to upload ISO media");
    } finally {
      setPending(null);
    }
  };

  const startImport = (candidate: { name: string; sizeBytes: number; sha256: string }) => {
    startOperation({
      operationId: "vm.media.import",
      title: `Import ${candidate.name}`,
      parameters: { filename: candidate.name },
      preview: <span>Copies the staged ISO ({formatBytes(candidate.sizeBytes)}, SHA-256 <code>{candidate.sha256.slice(0, 16)}...</code>) into the fixed libvirt media library with full checksum verification. Existing media is never overwritten and no VM is created.</span>,
    });
  };

  return (
    <>
      {dialog}
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
        {stagedCandidates.length > 0 && <div className="vm-media-candidates"><strong>Awaiting import approval</strong>{stagedCandidates.map((candidate) => <div className="vm-media-row" key={candidate.revision}><span><strong>{candidate.name}</strong><small>{formatBytes(candidate.sizeBytes)} | SHA-256 {candidate.sha256.slice(0, 16)}...</small></span><button type="button" className="text-button" disabled={pending !== null} onClick={() => startImport(candidate)}>Import</button></div>)}</div>}
        <div className="vm-control-lock"><div><strong>How importing works</strong><span>The file is uploaded to a staging area first, then checked by size and SHA-256 again as it is copied into the library. Existing media is never overwritten.</span></div></div>
        {message && <p className="vm-message" aria-live="polite">{message}</p>}
      </section>
    </>
  );
}
