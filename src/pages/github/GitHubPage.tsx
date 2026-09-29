import { useCallback, useEffect, useState } from "react";
import { countOf } from "../../data";
import { formatBytes } from "../../formatBytes";
import { relativeTime } from "../../home/format";
import { readJson } from "../../http";
import { EmptyState, KeyValue, Notice, PageHeader, Panel, StatusChip, Table, Tag, Button, type KeyValueItem, type TableColumn } from "../../ui";
import "./github.css";

/*
 * GitHub (M33.10): where this BoxPilot came from, rebuilt on the kit. Facts first: how many of the
 * allowlisted repositories answered, then what BoxPilot may and may not do with GitHub (read public
 * metadata, nothing else), then each repository's branch head and latest release with its assets'
 * digests as GitHub reports them. Nothing here writes, downloads or installs, and no token is asked
 * for; the page says so in facts rather than in a paragraph.
 */

interface CommitEvidence {
  sha: string;
  url: string;
  committedAt: string | null;
  verification: { reportedBy: string; verified: boolean; reason: string; verifiedAt: string | null };
}
interface ReleaseAsset { name: string; sizeBytes: number; contentType: string | null; digest: string | null }
interface Release {
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
}
interface Repository {
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
  latestRelease?: Release | null;
}
interface GithubStatus {
  fetchedAt: string;
  cacheTtlSeconds: number;
  source: string;
  repositories: Repository[];
  boundary: { repositoryAllowlist: string[]; tokenConfigured: boolean; credentialsAccepted: boolean; repositoryWrites: boolean; cloneOrDownload: boolean; webhookConfigured: boolean; workflowDispatch: boolean; installationSupported: boolean; localDigestVerification: boolean };
  limitations: string[];
}

export interface GitHubPageProps {
  /** The clock, for "fetched 3 minutes ago"; a test holds it still. */
  now?: () => number;
}

/** A commit as GitHub describes it: the short id linking to it, whether GitHub calls it verified, and when. */
function Commit({ commit, now }: { commit: CommitEvidence; now: number }) {
  return (
    <span className="github-commit">
      <a href={commit.url} target="_blank" rel="noreferrer"><code>{commit.sha.slice(0, 12)}</code></a>
      <StatusChip status={commit.verification.verified ? "good" : "warning"}>{commit.verification.verified ? "GitHub reports verified" : `GitHub reports ${commit.verification.reason}`}</StatusChip>
      {commit.committedAt && <span className="github-dim">{relativeTime(commit.committedAt, now) ?? commit.committedAt}</span>}
    </span>
  );
}

function RepositoryPanel({ repository, now }: { repository: Repository; now: number }) {
  const release = repository.latestRelease ?? null;
  const available = repository.status === "available";
  const facts: KeyValueItem[] = available ? [
    { id: "visibility", label: "Visibility", value: repository.visibility ?? "public" },
    { id: "branch", label: "Default branch", value: repository.defaultBranch ?? "—", mono: true },
    { id: "state", label: "State", value: repository.archived ? "Archived" : "Active", status: repository.archived ? "warning" : undefined },
    ...(repository.pushedAt ? [{ id: "pushed", label: "Last push", value: relativeTime(repository.pushedAt, now) ?? repository.pushedAt, mono: true }] : []),
    ...(repository.head ? [{ id: "head", label: "Branch head", value: <Commit commit={repository.head} now={now} /> }] : []),
  ] : [];
  const releaseFacts: KeyValueItem[] = release ? [
    { id: "release", label: "Release", value: <span className="github-release-name">{release.name}<a href={release.url} target="_blank" rel="noreferrer"><code>{release.tagName}</code></a>{release.prerelease && <Tag tone="warning">pre-release</Tag>}{release.draft && <Tag tone="warning">draft</Tag>}</span> },
    { id: "published", label: "Published", value: release.publishedAt ? relativeTime(release.publishedAt, now) ?? release.publishedAt : "Not reported", mono: true },
    { id: "commit", label: "Tag commit", value: <Commit commit={release.commit} now={now} /> },
    { id: "digests", label: "Digests", value: `${release.assetsWithGithubReportedDigest} of ${countOf(release.assets.length, "asset")} reported by GitHub`, mono: true },
    { id: "immutable", label: "Immutable", value: release.immutable ? "GitHub marks it immutable" : "GitHub does not mark it immutable", status: release.immutable ? "good" : "neutral" },
  ] : [];
  const assetColumns: Array<TableColumn<ReleaseAsset>> = [
    { id: "name", header: "Asset", sortValue: (asset) => asset.name, cell: (asset) => <code className="github-asset">{asset.name}</code> },
    { id: "size", header: "Size", numeric: true, sortValue: (asset) => asset.sizeBytes, cell: (asset) => formatBytes(asset.sizeBytes) },
    { id: "digest", header: "GitHub-reported digest", cell: (asset) => (asset.digest ? <code className="github-digest" title={asset.digest}>{asset.digest}</code> : <span className="github-dim">Not reported</span>) },
    { id: "local", header: "Verified here", cell: () => <StatusChip status="warning">No</StatusChip> },
  ];
  return (
    <Panel
      className="github-repo"
      title={repository.fullName}
      count={{ status: available ? "good" : "warning", label: repository.status }}
      meta={repository.purpose}
      actions={<a className="github-link" href={repository.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
    >
      {!available ? (
        <div className="github-repo__body"><Notice tone="warning" title="GitHub did not answer for this repository">{repository.error ?? "Its public metadata is unavailable."}</Notice></div>
      ) : (
        <>
          <div className="github-repo__body"><KeyValue items={facts} /></div>
          <h3 className="github-repo__heading">Latest release</h3>
          {release ? (
            <>
              <div className="github-repo__body"><KeyValue items={releaseFacts} /></div>
              <Table
                caption={`Assets of ${release.name}`}
                columns={assetColumns}
                rows={release.assets}
                rowKey={(asset) => asset.name}
                empty="No uploaded release assets were reported."
              />
            </>
          ) : (
            <EmptyState title="No GitHub release">This repository has no release yet, so there is nothing to install.</EmptyState>
          )}
        </>
      )}
    </Panel>
  );
}

export default function GitHubPage({ now = Date.now }: GitHubPageProps) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const body = await readJson<GithubStatus>(await fetch("/api/v1/integrations/github"));
      if (!Array.isArray(body.repositories) || !body.boundary) throw new Error("GitHub's details came back in a shape this page cannot read.");
      setStatus(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "GitHub could not be reached");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const clock = now();
  const repositories = status?.repositories ?? [];
  const available = repositories.filter((repository) => repository.status === "available").length;
  const unavailable = repositories.length - available;
  const boundary = status?.boundary;
  const minutes = status ? Math.round(status.cacheTtlSeconds / 60) : 0;

  const verdict = error && !status ? { status: "unknown" as const, label: "Not read" }
    : !status ? { status: "unknown" as const, label: "Reading…" }
      : unavailable ? { status: "warning" as const, label: `${unavailable} not answering` }
        : { status: "good" as const, label: `${available} of ${repositories.length} read` };

  return (
    <div className="github-page">
      <PageHeader
        title="GitHub"
        status={verdict}
        meta={status ? <><b>{repositories.length}</b> {repositories.length === 1 ? "repository" : "repositories"} · {boundary?.tokenConfigured ? <>token <b>configured</b></> : <><b>no</b> token</>} · cached <b>{minutes}</b> min · fetched <b>{relativeTime(status.fetchedAt, clock) ?? status.fetchedAt}</b></> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(status)}>Read again</Button>}
        about={<>
          <p>Where this BoxPilot came from: release, commit, and asset digests.</p>
          <p>Read from the public repositories on a fixed allowlist, without a GitHub token, and cached on the server; Read again respects that cache. Nothing is written back, downloaded or installed, and GitHub&apos;s word about a digest or a signature is not the same as checking it here.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="GitHub could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      {status && boundary && (
        <>
          <KeyValue
            layout="strip"
            className="github-boundary"
            items={[
              { id: "source", label: "Reads", value: "Public metadata", hint: status.source },
              { id: "token", label: "Token", value: boundary.tokenConfigured ? "Configured" : "None", status: boundary.tokenConfigured ? "warning" : "good" },
              { id: "credentials", label: "Credentials", value: boundary.credentialsAccepted ? "Accepted" : "Rejected", status: boundary.credentialsAccepted ? "warning" : "good" },
              { id: "writes", label: "Writes", value: boundary.repositoryWrites ? "Allowed" : "Locked" },
              { id: "downloads", label: "Downloads", value: boundary.cloneOrDownload ? "Allowed" : "Locked" },
              { id: "install", label: "Install", value: boundary.installationSupported ? "Supported" : "Locked" },
            ]}
          />

          {repositories.length === 0
            ? <Panel title="Repositories" count={0}><EmptyState title="No repositories on the allowlist">BoxPilot reads only the repositories it was built to trust.</EmptyState></Panel>
            : repositories.map((repository) => <RepositoryPanel key={repository.id} repository={repository} now={clock} />)}

          <Panel padded className="github-limits" title="Trust limitations" count={status.limitations.length} meta="metadata is not verification">
            {status.limitations.length
              ? <ul className="github-limits__list">{status.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
              : <p className="github-dim">None reported.</p>}
          </Panel>
        </>
      )}
    </div>
  );
}
