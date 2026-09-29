import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Button, EmptyState, Notice, Panel, Table, Tag, mayStart, riskOf } from "../../ui";
import { fetchVmMedia, formatBytes, uploadVmMedia, type VmMediaCandidate, type VmMediaInventory } from "../../virtualization";
import { when, type StartOperation } from "./vmActions";

type LibraryImage = VmMediaInventory["library"]["images"][number];

/**
 * Installation media (M33.12): the ISOs a VM can be planned from. An ISO is uploaded to a staging
 * area first and hashed; importing it into the fixed libvirt library is an approved job that checks
 * its size and SHA-256 again as it copies, and never overwrites what is there.
 */
export function VmMedia({ csrfToken, role, start, refreshKey }: { csrfToken: string; role: string; start: StartOperation; refreshKey: number }) {
  const [inventory, setInventory] = useState<VmMediaInventory | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const canUpload = role === "owner" || role === "operator";

  // A refresh does not clear the message: it follows an upload, whose result the owner is reading.
  const refresh = useCallback(async () => {
    try { setInventory(await fetchVmMedia()); setReadError(null); }
    catch (error) { setReadError(error instanceof Error ? error.message : "Unable to load VM media"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const choose = (event: ChangeEvent<HTMLInputElement>) => { setFile(event.target.files?.[0] ?? null); setMessage(null); };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const uploaded = await uploadVmMedia(file, csrfToken);
      setMessage({ tone: "success", text: `Uploaded ${uploaded.name}. Review its SHA-256, then approve the import.` });
      setFile(null);
      await refresh();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Unable to upload ISO media" });
    } finally {
      setUploading(false);
    }
  };

  const importCandidate = (candidate: VmMediaCandidate) => start({
    operationId: "vm.media.import",
    title: `Import ${candidate.name}`,
    parameters: { filename: candidate.name },
    preview: <span>Copies the staged ISO ({formatBytes(candidate.sizeBytes)}, SHA-256 <code>{candidate.sha256.slice(0, 16)}...</code>) into the fixed libvirt media library with full checksum verification. Existing media is never overwritten and no VM is created.</span>,
  });

  const images = inventory?.library?.images ?? [];
  const candidates = inventory?.inbox?.candidates ?? [];
  const maximum = formatBytes(inventory?.limits?.maximumIsoBytes ?? 16 * 1024 ** 3);

  return (
    <>
      {readError && <Notice tone="danger" live title="The media library could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{readError}</Notice>}
      <Panel title="Library" count={inventory ? images.length : undefined} meta={inventory?.library?.path ? <code>{inventory.library.path}</code> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()}>Read again</Button>}>
        <Table<LibraryImage>
          caption="ISO images in the managed library"
          columns={[
            { id: "name", header: "ISO", sortValue: (image) => image.name, cell: (image) => <span className="vms-name"><code>{image.name}</code><Tag tone="good">managed</Tag></span> },
            { id: "size", header: "Size", numeric: true, sortValue: (image) => image.sizeBytes, cell: (image) => formatBytes(image.sizeBytes) },
            { id: "modified", header: "Added", hideOnPhone: true, cell: (image) => when(image.modifiedAt) },
          ]}
          rows={images}
          rowKey={(image) => image.name}
          empty={!inventory ? (readError ? "The library could not be read." : "Reading the library…") : <EmptyState title="No ISO in the library yet">Upload one below, then approve its import. A VM planned from an ISO can use only what is here.</EmptyState>}
        />
      </Panel>

      {canUpload && (
        <Panel padded title="Upload an ISO" meta={`one .iso up to ${maximum}`}>
          <div className="vms-upload">
            <label className="vms-file">
              <span className="vms-file__label">Select ISO</span>
              <input className="vms-file__input" type="file" accept=".iso,application/x-iso9660-image" onChange={choose} disabled={uploading} />
            </label>
            <span className="vms-file__chosen">{file ? `${file.name} · ${formatBytes(file.size)}` : "No file chosen"}</span>
            <Button variant="primary" disabled={!file} busy={uploading} onClick={() => void upload()}>{uploading ? "Uploading and hashing…" : "Upload to staging"}</Button>
          </div>
          {message && <Notice tone={message.tone} live title={message.tone === "success" ? "Uploaded" : "The upload did not finish"} onDismiss={() => setMessage(null)}>{message.text}</Notice>}
          <p className="vms-note">The file lands in a staging area and is hashed. Importing checks its size and SHA-256 again as it is copied into the library; existing media is never overwritten.</p>
        </Panel>
      )}

      {candidates.length > 0 && (
        <Panel title="Uploaded, not yet added" count={candidates.length}>
          <Table<VmMediaCandidate>
            caption="Uploaded ISOs waiting to be imported"
            columns={[
              { id: "name", header: "ISO", cell: (candidate) => <code>{candidate.name}</code> },
              { id: "size", header: "Size", numeric: true, cell: (candidate) => formatBytes(candidate.sizeBytes) },
              { id: "sha", header: "SHA-256", hideOnPhone: true, cell: (candidate) => <code title={candidate.sha256}>{candidate.sha256.slice(0, 16)}…</code> },
              {
                id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "vms-actions-cell", cell: (candidate) => (
                  <span className="vms-actions">
                    {mayStart(role, "vm.media.import") && <Button risk={riskOf("vm.media.import")} onClick={() => importCandidate(candidate)} aria-label={`Import ${candidate.name}`}>Import</Button>}
                  </span>
                ),
              },
            ]}
            rows={candidates}
            rowKey={(candidate) => candidate.revision}
          />
        </Panel>
      )}
    </>
  );
}
