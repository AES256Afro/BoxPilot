# Keel Notes planning adapter

BoxPilot `0.25.0` includes a non-executable native-service plan for [Keel Notes](https://github.com/AES256Afro/Keel). The milestone defines an exact artifact identity and the safety contract for a future installer. It does not install Keel.

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
| Intended private state | `/var/lib/keel/.keel` |
| Health identity | JSON from `/api/health` identifying Keel and a healthy result |

During adapter authoring, the exact archive was inspected outside BoxPilot's execution path. It contained 2,900 entries and no absolute paths, parent traversal, symbolic links, hard links, block devices, character devices, or FIFOs. That review does not make the running product a verifier. BoxPilot `0.25.0` never downloads this asset and never recomputes its digest from local bytes.

## What the live plan checks

When an authenticated owner generates the Keel plan, BoxPilot:

1. Accepts only `target` and `hostPort` input fields.
2. Requires the fixed `native-service` target.
3. Requires a high TCP port and checks that the selected loopback port is free.
4. Checks the Node.js, state-storage, and restricted-helper prerequisites.
5. Requires a Linux x64 host for this reviewed asset.
6. Reads the fixed public Keel GitHub metadata through the credential-free provenance service.
7. Requires the live tag, release commit, asset filename, byte count, and GitHub-reported digest to match every compiled value.
8. Stores the resulting plan as an immutable, owner-attributable revision.
9. Adds the `keel.execution` blocker even when every observation matches.

The Applications screen shows GitHub metadata matching and local-byte verification as separate facts. A matching GitHub digest is never shown as a local digest check.

## Operations that remain unavailable

The adapter has no helper operation or executable job type. It cannot:

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

A future executable adapter must treat the Keel workspace as one recovery unit. For the default CLI layout, that includes at least:

- `keel.db`
- `uploads/`
- `backups/`
- `.keel-server-secrets.key` when present

Copying a live SQLite file is not an accepted backup. The future adapter must coordinate writes through an application-aware export or clean stop, preserve the managed-secret key companion, restart and verify the source, then test the artifact in an isolated no-network restore environment. A successful archive alone cannot mark Keel protected.

The future discovery pass must also detect a PostgreSQL deployment or an existing replication system before proposing a database operation. It must not silently layer a second replication mechanism over an existing one.

## Claim and exposure contract

Keel registration begins open according to its current operator guidance. A future BoxPilot install must therefore remain loopback-only while unclaimed. The operator will use Keel's short-lived, one-use terminal claim flow from the server console. BoxPilot must verify that ownership and registration policy are safe before offering any Tailscale or proxy handoff.

Tailscale access does not replace Keel authentication. BoxPilot will never expose an unclaimed or openly registering Keel instance to the LAN or tailnet.

## Gates before execution can ship

The Keel plan can become executable only after all of these are implemented and tested:

1. A typed helper operation that accepts no URL, arbitrary path, command, service name, or argument array.
2. A bounded download to a helper-owned staging file with exact byte-count and full local SHA-256 verification.
3. Archive validation that rejects path traversal, links, devices, unexpected roots, changed membership, and extraction races.
4. A dedicated unprivileged account, root-owned immutable application release tree, private writable state, and hardened loopback-only systemd unit.
5. Exact `/api/health` identity checks before any access handoff.
6. A server-local, short-lived claim workflow with registration-state verification.
7. Application-aware backup that preserves database, uploads, backups, and the managed-secret key together.
8. An isolated restore drill with no published port and no route to production data.
9. Upgrade checkpoint and automatic rollback to the previous exact release without deleting state.
10. Negative tests for digest mismatch, archive attacks, partial download, interrupted extraction, wrong ownership, port collision, failed claim, failed health, failed restart, and failed restore.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Anyone offering Keel as a hosted service for third parties should review the license and obtain any required separate permission.
