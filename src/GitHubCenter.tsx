import { useCallback, useEffect, useState } from "react";

type CommitEvidence = {
  sha: string;
  url: string;
  committedAt: string | null;
  verification: { reportedBy: string; verified: boolean; reason: string; verifiedAt: string | null };
};
type ReleaseAsset = { name: string; sizeBytes: number; contentType: string | null; digest: string | null };
type RepositoryEvidence = {
  id: string;
  owner: string;
  repository: string;
  purpose: string;
  fullName: string;
  url: string;
  status: "available" | "unavailable";
  error?: string;
  visibility?: string;
  archived?: boolean;
  defaultBranch?: string;
  pushedAt?: string | null;
  head?: CommitEvidence;
  latestRelease?: null | {
    tagName: string;
    name: string;
    url: string;
    publishedAt: string | null;
    targetCommitish: string | null;
    draft: boolean;
    prerelease: boolean;
    immutable: boolean;
    commit: CommitEvidence;
    assets: ReleaseAsset[];
    assetsWithGithubReportedDigest: number;
  };
};
type GithubStatus = {
  fetchedAt: string;
  cacheTtlSeconds: number;
  source: string;
  repositories: RepositoryEvidence[];
  boundary: { repositoryAllowlist: string[]; tokenConfigured: boolean; credentialsAccepted: boolean; repositoryWrites: boolean; cloneOrDownload: boolean; webhookConfigured: boolean; workflowDispatch: boolean; installationSupported: boolean; localDigestVerification: boolean };
  limitations: string[];
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not reported";
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function CommitLine({ label, commit }: { label: string; commit: CommitEvidence }) {
  return <div className="github-commit"><div><span>{label}</span><a href={commit.url} target="_blank" rel="noreferrer"><code>{commit.sha.slice(0, 12)}</code></a></div><div><span className={`status-pill ${commit.verification.verified ? "status-good" : "status-warning"}`}>{commit.verification.verified ? "GitHub reports verified" : `GitHub reports ${commit.verification.reason}`}</span><small>{formatDate(commit.committedAt)}</small></div></div>;
}

export default function GitHubCenter() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await readJson<GithubStatus>(await fetch("/api/v1/integrations/github")));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub provenance is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!status && loading) return <section className="vm-loading">Loading public GitHub provenance...</section>;
  if (!status) return <p className="form-error" role="alert">{error}</p>;

  const available = status.repositories.filter((repository) => repository.status === "available").length;
  return <div className="github-center">
    <section className="readiness"><div><strong>{available} of {status.repositories.length} repositories available</strong><span>Fixed public allowlist, cached for {Math.round(status.cacheTtlSeconds / 60)} minutes</span></div><div className="readiness-actions"><span className="status-pill status-good">No GitHub token</span><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button></div></section>
    {error && <p className="form-error" role="alert">{error}</p>}

    <section className="panel github-boundary">
      <header className="panel-header"><strong>Where this BoxPilot came from</strong><span>{status.source}</span></header>
      <div className="network-lock"><span className="status-pill status-good">Public metadata only</span><span className="status-pill status-good">Credentials rejected</span><span className="status-pill status-warning">Writes locked</span><span className="status-pill status-warning">Downloads locked</span><span className="status-pill status-warning">Install locked</span></div>
      <p>Release, commit, and asset details read from the public repository. No GitHub token is needed and nothing is written back.</p>
      <small>Fetched {formatDate(status.fetchedAt)}. Refresh respects the server cache.</small>
    </section>

    <div className="github-repositories">{status.repositories.map((repository) => <article className="panel github-repository" key={repository.id}>
      <header><div><span className="eyebrow">{repository.purpose}</span><h2>{repository.fullName}</h2></div><span className={`status-pill ${repository.status === "available" ? "status-good" : "status-warning"}`}>{repository.status}</span></header>
      {repository.status === "unavailable" ? <p className="form-error">{repository.error ?? "Public metadata unavailable"}</p> : <>
        <div className="github-repo-meta"><span>Public</span><span>Default branch: {repository.defaultBranch}</span><span>{repository.archived ? "Archived" : "Active"}</span><a href={repository.url} target="_blank" rel="noreferrer">Open repository</a></div>
        {repository.head && <CommitLine label="Default branch head" commit={repository.head} />}
        {repository.latestRelease ? <section className="github-release">
          <header><div><span className="eyebrow">Latest GitHub release</span><h3>{repository.latestRelease.name}</h3></div><a href={repository.latestRelease.url} target="_blank" rel="noreferrer">{repository.latestRelease.tagName}</a></header>
          <CommitLine label="Release tag commit" commit={repository.latestRelease.commit} />
          <div className="github-release-meta"><span>Published {formatDate(repository.latestRelease.publishedAt)}</span><span>{repository.latestRelease.assetsWithGithubReportedDigest}/{repository.latestRelease.assets.length} assets have a GitHub-reported digest</span><span>{repository.latestRelease.immutable ? "GitHub marks release immutable" : "GitHub does not mark release immutable"}</span></div>
          <div className="table-scroll"><table><thead><tr><th>Asset metadata</th><th>Size</th><th>GitHub-reported digest</th><th>Verified locally</th></tr></thead><tbody>{repository.latestRelease.assets.length ? repository.latestRelease.assets.map((asset) => <tr key={asset.name}><td>{asset.name}</td><td>{formatBytes(asset.sizeBytes)}</td><td><code>{asset.digest ? `${asset.digest.slice(0, 23)}...` : "Not reported"}</code></td><td className="warning-text">No</td></tr>) : <tr><td colSpan={4}>No uploaded release assets were reported.</td></tr>}</tbody></table></div>
        </section> : <div className="github-no-release"><strong>No GitHub release</strong><span>This repository has no latest release. Branch metadata is not an installable artifact.</span></div>}
      </>}
    </article>)}</div>

    <section className="panel"><header className="panel-header"><strong>Trust limitations</strong><span>Metadata is not artifact verification</span></header><ul className="dns-acceptance-limitations">{status.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section>
  </div>;
}
