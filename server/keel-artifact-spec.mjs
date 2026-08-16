export const keelArtifactSpec = Object.freeze({
  repository: "AES256Afro/Keel",
  releaseTag: "v1.2.6",
  releaseCommitSha: "884e7ab1cc48139ed51de350ea5812a2e3a9cc7d",
  name: "keel-1.2.6-linux-x64.tar.gz",
  platform: "linux",
  architecture: "x64",
  sizeBytes: 71052143,
  digest: "sha256:696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00",
  sourceUrl: "https://github.com/AES256Afro/Keel/releases/download/v1.2.6/keel-1.2.6-linux-x64.tar.gz",
  archiveRoot: "keel-1.2.6-linux-x64",
  archiveMembersObservedDuringAdapterReview: 2974,
  archiveRegularFilesObservedDuringAdapterReview: 2466,
  archiveDirectoriesObservedDuringAdapterReview: 508,
});

export const keelArtifactPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/artifacts/keel",
  archive: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.6-linux-x64.tar.gz",
  partial: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.6-linux-x64.tar.gz.partial",
  evidence: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.6-linux-x64.evidence.json",
  evidencePartial: "/var/lib/boxpilot-managed/artifacts/keel/keel-1.2.6-linux-x64.evidence.json.partial",
  approval: "/run/boxpilot/keel-artifact-approval.json",
});

export const keelStagePaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/apps/keel",
  releases: "/var/lib/boxpilot-managed/apps/keel/releases",
  release: "/var/lib/boxpilot-managed/apps/keel/releases/1.2.6",
  evidence: "/var/lib/boxpilot-managed/apps/keel/releases/1.2.6/.boxpilot-stage.json",
});

export const keelArtifactDigestHex = keelArtifactSpec.digest.slice("sha256:".length);

export function validUuid(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}
