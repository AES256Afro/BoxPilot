# GitHub provenance

BoxPilot `0.24.0` introduced, and `0.26.0` retains, a credential-free read-only view of one fixed public repository:

- `AES256Afro/BoxPilot`

The service uses GitHub's public REST API without an authorization header. GitHub documents that public resources and the latest-release endpoint can be requested without authentication:

- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub release endpoints](https://docs.github.com/en/rest/releases/releases)
- [GitHub commit endpoints](https://docs.github.com/en/rest/commits/commits)

## Data collected

For each fixed repository, BoxPilot retains only the current response in a 15-minute in-memory cache and returns sanitized fields:

- Public repository identity, default branch, archived state, and last push time
- Default-branch head SHA and GitHub-reported verification result
- Latest release tag, publication time, target, and immutable flag when a release exists
- Release-tag commit SHA and GitHub-reported verification result
- Up to 16 asset names, content types, byte counts, and valid `sha256:` digests reported by GitHub

Commit author email, committer email, raw signature, signed payload, release body, asset download URL, owner profile, and arbitrary API response fields are discarded. Responses are limited to 512 KiB and six seconds. One repository can degrade without hiding the other.

## Trust boundary

GitHub's `verified` field means GitHub reports that commit verification succeeded. It does not mean BoxPilot independently verified the signature. A GitHub-reported asset digest is also metadata only. BoxPilot has not verified that digest until a future adapter downloads the exact bytes to a confined staging path and computes SHA-256 locally.

Version `0.26.0` does not:

- Accept or store a GitHub token
- Query an operator-supplied owner, repository, ref, URL, or API path
- Clone a repository or download source or release assets
- Write to a repository, issue, pull request, release, branch, or Actions workflow
- Configure a webhook or GitHub App
- Install or update BoxPilot, Keel Notes, or an adapter
- Claim that a GitHub release is safe, compatible, backed up, restorable, or deployable

## Future installation gate

A later curated adapter must still:

1. Pin an allowed repository, release tag, platform asset name, and SHA-256 digest in an immutable plan.
2. Download into a confined non-executable staging directory with a strict byte limit.
3. Compute and compare the full local digest before extracting anything.
4. Reject links, path traversal, devices, unexpected archive members, and changed metadata.
5. Verify platform compatibility, prerequisites, ports, storage, backup coverage, and rollback.
6. Require owner-password approval immediately before installation.
7. Preserve the previous version and prove application health before reporting success.

Private repositories and repository write capabilities require a separate encrypted credential design and are not implied by this foundation.

## Signed releases

The catalog, and all of BoxPilot, reaches a server inside a release. By default an update builds
whatever commit the release tag points at, so the GitHub account is the whole trust boundary. To
move it to a key only you hold:

1. Sign tags with an SSH key: `git config gpg.format ssh` and
   `git config user.signingkey ~/.ssh/id_ed25519.pub` (a hardware-backed `sk-ssh-ed25519` key works).
2. Cut releases with `git tag -s vX.Y.Z -m vX.Y.Z` instead of `git tag vX.Y.Z`, then push the tag.
3. On each server: System → BoxPilot update → **Release key…**, paste the public key line, and
   approve (high risk: password and the words typed out).

From then on the upgrade script fetches the tag with git and runs `git verify-tag` against that key
(`/var/lib/boxpilot-managed/release-signers`, git's allowed-signers format). An unsigned tag, a lightweight
tag, one signed with another key, a PGP signature, an old signed tag published again under a newer
name, a tree whose version is not the tag's, or one that no longer points at the commit you reviewed
stops the update before anything changes, and the update log says which. The key file must be
root's and writable by nobody else. An update run by hand
(`sudo sh scripts/boxpilot-upgrade.sh v1.2.3`) checks the same way; it has to name a tag.
