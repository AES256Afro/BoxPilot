# Keel Notes discovery and inert artifact adapter

BoxPilot `0.25.0` introduced a non-executable exact-release plan for [Keel Notes](https://github.com/AES256Afro/Keel). Version `0.41.0` adds bounded parameter-free discovery for supported Linux user-service and exact Docker evidence. Version `0.42.0` adds a separate guarded download and complete local digest check for one fixed archive. Version `0.43.0` adds bounded runtime archive membership inspection and correctly blocks the fixed 1.2.5 release. It still does not extract, execute, install, adopt, import, start, claim, back up, restore, or expose Keel.

## Fixed release identity

The adapter accepts no repository, URL, tag, filename, digest, path, service name, user, or command from the browser. Its reviewed identity is compiled into BoxPilot:

| Field | Fixed value |
| --- | --- |
| Repository | `AES256Afro/Keel` |
| Release | `v1.2.5` |
| Release commit | `bcf872e2cee5820bdeb74685f5573cc6beb0a28f` |
| Asset | `keel-1.2.5-linux-x64.tar.gz` |
| Platform | `linux` |
| Architecture | `x64` |
| Size | `47,655,144` bytes |
| SHA-256 | `4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee` |
| Intended listener | `127.0.0.1:3000` by default |
| BoxPilot artifact root | `/var/lib/boxpilot-managed/artifacts/keel` |
| Future BoxPilot-managed state root | `/var/lib/keel` |
| Supported upstream Linux default | `~/keel` with `~/.config/systemd/user/keel.service` |
| Health identity | JSON from `/api/health` identifying Keel and a healthy result |

The earlier source-level review incorrectly recorded that the archive contained no symbolic links. Runtime review of the exact 47,655,144-byte asset, whose complete SHA-256 still matches the pinned identity, found 2,900 logical entries: 2,398 regular files, 501 directories, and one symbolic link. That link has an absolute target into the GitHub Actions build workspace. Version `0.43.0` records this correction and blocks the release. BoxPilot does not expose the member name or link target in its API, and it will not follow, rewrite, omit, or extract the link.

## Runtime archive membership gate

The browser can request only `application.keel.archive.inspect` with an empty parameter object. The root helper opens only the compiled root-only artifact with no-follow semantics, rechecks its exact compressed byte length and SHA-256, then streams gzip and tar parsing without creating an extraction directory. It applies fixed limits of 10,000 logical members and 2 GiB of declared uncompressed member bytes, validates every tar checksum, understands bounded GNU long-name and long-link metadata, requires the one exact archive root and the expected 2,900 logical entries, and rejects malformed structure, changed bytes, unsupported metadata, duplicates, absolute paths, Windows-style paths, backslashes, parent traversal, symbolic or hard links, devices, FIFOs, contiguous files, and unknown member types.

The result contains only state, fixed risk identifiers, aggregate type counts, total declared regular-member bytes, the expected root label, and the expected member count. It never returns a member name, member body, link target, extracted path, or archive byte. The exact 1.2.5 result is `blocked`, with `symbolic-link-member` and `absolute-link-target` risks. `safeToExtract` is false. This is a read-only inspection result, not an extraction approval.

## Guarded artifact acquisition

Artifact planning accepts only an empty JSON object. The immutable plan captures a server-generated acquisition UUID, current fixed artifact state, the compiled release identity, host platform and architecture, clean discovery evidence, required BoxPilot prerequisites, and a fresh exact public GitHub metadata match. Staging rechecks every observation. Approval requires the owner password again.

The main root helper remains `PrivateNetwork=true` and accepts only `application.keel.artifact.acquire` with the acquisition UUID. It creates `/var/lib/boxpilot-managed/artifacts/keel` as a real mode `0700` directory, writes a five-minute root-only marker containing only compiled identity fields, and starts `boxpilot-keel-artifact.service`. The marker is removed whether the one-shot succeeds or fails.

The separate static one-shot:

1. Accepts no command-line arguments.
2. Requires the exact marker keys, values, UUID, and freshness.
3. Starts from the compiled `https://github.com/AES256Afro/Keel/releases/download/...` URL.
4. Allows only HTTPS with no credentials or port and only the reviewed `github.com` to `release-assets.githubusercontent.com` release-asset redirect shape.
5. Requires the final `Content-Length` and streamed byte count to equal `47,655,144`.
6. Hashes every byte and requires the compiled SHA-256 before publication.
7. Uses exclusive mode `0600` partial files and no-follow file-type checks.
8. Publishes the archive and evidence only after verification, without overwriting an existing final artifact.
9. Removes its exact partial files on any failure.
10. Records no signed redirect query, response body, archive byte, browser input, secret, or command in the API result.

An interrupted regular partial file can be removed by a fresh approved job. A mismatched final archive, symbolic link, directory, device, orphaned evidence file, or otherwise invalid fixed state blocks automatic acquisition for terminal inspection. BoxPilot will not overwrite it.

## Read-only discovery boundary

The browser can request only `application.keel.inspect` with an empty parameter object. The helper derives every location, binary, argument, port, and health endpoint. It checks:

- At most 64 ordinary home directories beneath `/home`, plus `/root`
- The supported `~/keel` tree and fixed `~/.config/systemd/user/keel.service`
- A custom systemd-user `WorkingDirectory` only when it remains beneath that same home
- Fixed `/opt/keel` and `/var/lib/boxpilot-managed/apps/keel/current` candidates
- A regular bounded `package.json` only for the `keel` name and version
- File or directory presence for the SQLite database, managed-secret companion, uploads, and backups without reading their contents
- At most eight Docker candidates with the exact Compose service label `keel` or exact container name `keel`
- Docker running and health state, loopback port publication, and a writable volume or bind mount at `/data`, without returning the image, id, environment, label values, or host mount source
- Fixed TCP port 3000 listener posture and up to 8 KiB of JSON from `http://127.0.0.1:3000/api/health`, accepted only when `app` is `keel` and `ok` is `true`

The result contains only fixed source labels, counts, booleans, a bounded version, listener posture, health identity, and fixed risk identifiers. It excludes usernames, home paths, application paths, container ids, images, unit contents, `.env`, database contents, secret contents, mount sources, boot identifiers, and raw command output. It performs no write, download, database open, process change, service change, container change, claim, exposure, or network mutation.

Multiple candidates, changed or stale units, unsafe listeners, missing persistence, unrecognized port 3000 services, and incomplete inspection fail closed. Absence is reported only when no candidate, listener, or discovery risk remains.

## What the live plan checks

When an authenticated owner generates the Keel plan, BoxPilot:

1. Accepts only `target` and `hostPort` input fields.
2. Requires the fixed `native-service` target.
3. Requires a high TCP port and checks that the selected loopback port is free.
4. Checks the Node.js, state-storage, and restricted-helper prerequisites.
5. Requires a Linux x64 host for this reviewed asset.
6. Runs the fixed read-only Keel discovery and blocks existing, ambiguous, unsafe, or incomplete evidence.
7. Reads the fixed public Keel GitHub metadata through the credential-free provenance service.
8. Requires the live tag, release commit, asset filename, byte count, and GitHub-reported digest to match every compiled value.
9. Runs the fixed runtime archive gate when local verified bytes exist, or reports `artifact-required` when they do not.
10. Stores the resulting plan as an immutable, owner-attributable revision.
11. Adds `keel.archive` and `keel.execution` blockers. The exact 1.2.5 release cannot proceed.

The Applications screen shows GitHub metadata matching and local-byte verification as separate facts. A matching GitHub digest is never shown as a local digest check. The deployment plan remains non-executable even after the separate artifact plan succeeds.

## Operations that remain unavailable

The adapter has parameter-free discovery, artifact inspection, and archive membership inspection plus one UUID-only executable artifact job. It cannot:

- Download an arbitrary asset, clone a repository, or update Keel
- Extract, copy into an application tree, or execute a release asset
- Install Node.js or another package
- Create a Keel service account, application tree, state directory, or systemd unit
- Start, stop, restart, enable, or expose a Keel service
- Create an owner, claim an instance, or change registration policy
- Read, export, import, back up, restore, or migrate Keel data
- Change Tailscale Serve, a reverse proxy, firewall, DNS, DHCP, or router state

The Keel deployment plan is always non-executable, so its `Stage for approval` control remains absent. Only the separately labeled artifact verification plan can be staged.

## Stateful data contract

A future executable adapter must treat the Keel workspace as one recovery unit. The supported upstream Linux installer currently creates `~/keel`, stores SQLite beneath `~/keel/data`, writes uploads beneath `~/keel/uploads`, and writes backups beneath `~/keel/backups`. Docker keeps its recovery unit beneath `/data`. At minimum, coordinated recovery must preserve:

- `data/keel.db` for the supported Linux installer, or `/data/keel.db` in Docker
- `uploads/`
- `backups/`
- `data/.keel-server-secrets.key` or `/data/.keel-server-secrets.key` when present

Copying a live SQLite file is not an accepted backup. The future adapter must coordinate writes through an application-aware export or clean stop, preserve the managed-secret key companion, restart and verify the source, then test the artifact in an isolated no-network restore environment. A successful archive alone cannot mark Keel protected.

Version `0.42.0` deliberately does not read `.env`, database URLs, or replication credentials, so it cannot yet identify PostgreSQL or Litestream configuration. A later secret-safe configuration classifier must detect those states before proposing any database operation. BoxPilot must not silently layer a second replication mechanism over an existing one.

## Claim and exposure contract

Keel registration begins open according to its current operator guidance. A future BoxPilot install must therefore remain loopback-only while unclaimed. The operator will use Keel's short-lived, one-use terminal claim flow from the server console. BoxPilot must verify that ownership and registration policy are safe before offering any Tailscale or proxy handoff.

Tailscale access does not replace Keel authentication. BoxPilot will never expose an unclaimed or openly registering Keel instance to the LAN or tailnet.

## Gates before execution can ship

The Keel plan can become executable only after all of these are implemented and tested:

1. Completed in `0.41.0`: a parameter-free read-only helper operation that accepts no URL, path, port, command, service, container, or argument array.
2. Completed in `0.42.0`: a separately sandboxed bounded download to a helper-owned staging file with exact byte-count and full local SHA-256 verification.
3. Completed in `0.43.0`: runtime archive validation that rejects path traversal, links, devices, unexpected roots, changed membership, malformed tar structure, and unbounded input without extracting a member. The fixed 1.2.5 release fails this gate.
4. A dedicated unprivileged account, root-owned immutable application release tree, private writable state, and hardened loopback-only systemd unit.
5. Exact `/api/health` identity checks before any access handoff.
6. A server-local, short-lived claim workflow with registration-state verification.
7. Application-aware backup that preserves database, uploads, backups, and the managed-secret key together.
8. An isolated restore drill with no published port and no route to production data.
9. Upgrade checkpoint and automatic rollback to the previous exact release without deleting state.
10. Negative tests for archive attacks, interrupted extraction, wrong ownership, port collision, failed claim, failed health, failed restart, and failed restore. Version `0.42.0` covers stale or changed markers, URL and redirect escape, response length and digest mismatch, partial cleanup, extra browser input, mismatched existing artifacts, changed plan state, and no extraction or installation. Version `0.43.0` covers hostile links and targets, traversal, absolute and Windows-style paths, backslashes, devices, FIFOs, unsupported extensions and types, changed member counts and roots, duplicate paths, invalid checksums, malformed or truncated streams, and member and size ceilings. Discovery already covers stale or changed units, duplicate installs, wildcard exposure, missing Docker persistence, traversal-like user-unit paths, and secret or private-path non-disclosure.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Anyone offering Keel as a hosted service for third parties should review the license and obtain any required separate permission.
