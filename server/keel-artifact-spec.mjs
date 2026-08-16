export const keelArtifactSpec = Object.freeze({
  repository: "AES256Afro/Keel",
  releaseTag: "v1.2.5",
  releaseCommitSha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f",
  name: "keel-1.2.5-linux-x64.tar.gz",
  platform: "linux",
  architecture: "x64",
  sizeBytes: 47655144,
  digest: "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee",
  sourceUrl: "https://github.com/AES256Afro/Keel/releases/download/v1.2.5/keel-1.2.5-linux-x64.tar.gz",
  archiveMembersObservedDuringAdapterReview: 2900,
});

export const keelArtifactPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/artifacts/keel",
  archive: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.5-linux-x64.tar.gz",
  partial: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.5-linux-x64.tar.gz.partial",
  evidence: "/var/lib/boxpilot-managed/artifacts/keel/evidence.json",
  evidencePartial: "/var/lib/boxpilot-managed/artifacts/keel/evidence.json.partial",
  approval: "/run/boxpilot/keel-artifact-approval.json",
});

export const keelArtifactDigestHex = keelArtifactSpec.digest.slice("sha256:".length);

export function validUuid(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}
