import { createHash } from "node:crypto";
import path from "node:path";

export const ubuntuMediaCatalog = Object.freeze([
  Object.freeze({
    id: "ubuntu-server-26.04-amd64",
    label: "Ubuntu Server 26.04 LTS",
    release: "26.04",
    architecture: "amd64",
    name: "ubuntu-26.04-live-server-amd64.iso",
    sizeBytes: 2918598656,
    sha256: "dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9",
    sourceUrl: "https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso",
    checksumUrl: "https://releases.ubuntu.com/26.04/SHA256SUMS",
    signatureUrl: "https://releases.ubuntu.com/26.04/SHA256SUMS.gpg",
  }),
  Object.freeze({
    id: "ubuntu-server-24.04.4-amd64",
    label: "Ubuntu Server 24.04.4 LTS",
    release: "24.04.4",
    architecture: "amd64",
    name: "ubuntu-24.04.4-live-server-amd64.iso",
    sizeBytes: 3405469696,
    sha256: "e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433",
    sourceUrl: "https://releases.ubuntu.com/24.04/ubuntu-24.04.4-live-server-amd64.iso",
    checksumUrl: "https://releases.ubuntu.com/24.04/SHA256SUMS",
    signatureUrl: "https://releases.ubuntu.com/24.04/SHA256SUMS.gpg",
  }),
]);

export const ubuntuMediaCatalogRevision = createHash("sha256").update(JSON.stringify(ubuntuMediaCatalog)).digest("hex");
export const ubuntuMediaPaths = Object.freeze({
  approval: "/run/boxpilot/ubuntu-media-approval.json",
  evidenceRoot: "/var/lib/boxpilot-managed/vm-media-acquisitions",
  inboxRoot: "/var/lib/boxpilot-managed/vm-media-inbox",
});

export function validUbuntuMediaAcquisitionId(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

export function getUbuntuMediaSpec(imageId) {
  return ubuntuMediaCatalog.find((item) => item.id === imageId) ?? null;
}

export function ubuntuMediaAcquisitionPaths(acquisitionId, spec, roots = ubuntuMediaPaths) {
  if (!validUbuntuMediaAcquisitionId(acquisitionId) || !spec) throw new Error("The Ubuntu media acquisition identity is invalid");
  return {
    target: path.join(roots.inboxRoot, spec.name),
    metadata: path.join(roots.inboxRoot, `${spec.name}.boxpilot.json`),
    partial: path.join(roots.inboxRoot, `.ubuntu-media-${acquisitionId}.partial`),
    metadataPartial: path.join(roots.inboxRoot, `.ubuntu-media-${acquisitionId}.json.partial`),
    evidence: path.join(roots.evidenceRoot, `${acquisitionId}.json`),
    evidencePartial: path.join(roots.evidenceRoot, `.${acquisitionId}.json.partial`),
  };
}
