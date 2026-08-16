# Keel Notes discovery and planning adapter

BoxPilot `0.25.0` introduced a non-executable exact-release plan for [Keel Notes](https://github.com/AES256Afro/Keel). Version `0.41.0` adds bounded parameter-free discovery for supported Linux user-service and exact Docker evidence. It still does not install, adopt, import, start, claim, back up, restore, or expose Keel.

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
| Future BoxPilot-managed state root | `/var/lib/keel` |
| Supported upstream Linux default | `~/keel` with `~/.config/systemd/user/keel.service` |
| Health identity | JSON from `/api/health` identifying Keel and a healthy result |

During adapter authoring, the exact archive was inspected outside BoxPilot's execution path. It contained 2,900 entries and no absolute paths, parent traversal, symbolic links, hard links, block devices, character devices, or FIFOs. That review does not make the running product a verifier. BoxPilot `0.41.0` never downloads this asset and never recomputes its digest from local bytes.

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
9. Stores the resulting plan as an immutable, owner-attributable revision.
10. Adds the `keel.execution` blocker even when every observation matches.

The Applications screen shows GitHub metadata matching and local-byte verification as separate facts. A matching GitHub digest is never shown as a local digest check.

## Operations that remain unavailable

The adapter has one read-only helper operation and no executable job type. It cannot:

- Download, clone, or update Keel
- Hash, extract, copy, or execute a release asset
- Install Node.js or another package
- Create a Keel service account, application tree, state directory, or systemd unit
- Start, stop, restart, enable, or expose a Keel service
- Create an owner, claim an instance, or change registration policy
- Read, export, import, back up, restore, or migrate Keel data
- Change Tailscale Serve, a reverse proxy, firewall, DNS, DHCP, or router state

Because the plan is always non-executable, `Stage for approval` is absent and the API refuses direct staging.

## Stateful data contract

A future executable adapter must treat the Keel workspace as one recovery unit. The supported upstream Linux installer currently creates `~/keel`, stores SQLite beneath `~/keel/data`, writes uploads beneath `~/keel/uploads`, and writes backups beneath `~/keel/backups`. Docker keeps its recovery unit beneath `/data`. At minimum, coordinated recovery must preserve:

- `data/keel.db` for the supported Linux installer, or `/data/keel.db` in Docker
- `uploads/`
- `backups/`
- `data/.keel-server-secrets.key` or `/data/.keel-server-secrets.key` when present

Copying a live SQLite file is not an accepted backup. The future adapter must coordinate writes through an application-aware export or clean stop, preserve the managed-secret key companion, restart and verify the source, then test the artifact in an isolated no-network restore environment. A successful archive alone cannot mark Keel protected.

Version `0.41.0` deliberately does not read `.env`, database URLs, or replication credentials, so it cannot yet identify PostgreSQL or Litestream configuration. A later secret-safe configuration classifier must detect those states before proposing any database operation. BoxPilot must not silently layer a second replication mechanism over an existing one.

## Claim and exposure contract

Keel registration begins open according to its current operator guidance. A future BoxPilot install must therefore remain loopback-only while unclaimed. The operator will use Keel's short-lived, one-use terminal claim flow from the server console. BoxPilot must verify that ownership and registration policy are safe before offering any Tailscale or proxy handoff.

Tailscale access does not replace Keel authentication. BoxPilot will never expose an unclaimed or openly registering Keel instance to the LAN or tailnet.

## Gates before execution can ship

The Keel plan can become executable only after all of these are implemented and tested:

1. Completed in `0.41.0`: a parameter-free read-only helper operation that accepts no URL, path, port, command, service, container, or argument array.
2. A bounded download to a helper-owned staging file with exact byte-count and full local SHA-256 verification.
3. Archive validation that rejects path traversal, links, devices, unexpected roots, changed membership, and extraction races.
4. A dedicated unprivileged account, root-owned immutable application release tree, private writable state, and hardened loopback-only systemd unit.
5. Exact `/api/health` identity checks before any access handoff.
6. A server-local, short-lived claim workflow with registration-state verification.
7. Application-aware backup that preserves database, uploads, backups, and the managed-secret key together.
8. An isolated restore drill with no published port and no route to production data.
9. Upgrade checkpoint and automatic rollback to the previous exact release without deleting state.
10. Negative tests for digest mismatch, archive attacks, partial download, interrupted extraction, wrong ownership, port collision, failed claim, failed health, failed restart, and failed restore. Discovery already has negative coverage for stale or changed units, duplicate installs, wildcard exposure, missing Docker persistence, traversal-like user-unit paths, and secret or private-path non-disclosure.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Anyone offering Keel as a hosted service for third parties should review the license and obtain any required separate permission.
