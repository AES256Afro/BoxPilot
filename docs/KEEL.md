# Keel Notes safe release staging

BoxPilot `0.46.0` can acquire, inspect, and stage one exact [Keel Notes](https://github.com/AES256Afro/Keel) release without installing or starting it. The corrected upstream `v1.2.6` server archive contains no links or special members. BoxPilot verifies that fact before extraction and again after extraction, then publishes only an inert root-only release tree.

Installation, writable application state, service creation, startup, accounts, ownership claim, registration changes, listeners, access handoff, backup, restore, import, migration, adoption, and update remain unavailable. A staged release is not an installed or protected application.

## Fixed release identity

The browser cannot supply a repository, URL, tag, filename, digest, archive path, extraction path, service name, user, command, or argument. The reviewed identity is compiled into BoxPilot:

| Field | Fixed value |
| --- | --- |
| Repository | `AES256Afro/Keel` |
| Release | `v1.2.6` |
| Release commit | `884e7ab1cc48139ed51de350ea5812a2e3a9cc7d` |
| Asset | `keel-1.2.6-linux-x64.tar.gz` |
| Platform | `linux` |
| Architecture | `x64` |
| Size | `71,052,143` bytes |
| SHA-256 | `696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00` |
| Archive root | `keel-1.2.6-linux-x64` |
| Logical members | `2,974` |
| Regular files | `2,466` |
| Directories | `508` |
| Links or special members | `0` |
| Artifact root | `/var/lib/boxpilot-managed/artifacts/keel` |
| Staged release | `/var/lib/boxpilot-managed/apps/keel/releases/1.2.6` |
| Future state root | `/var/lib/keel` |
| Future listener | `127.0.0.1:3000` by default |

The earlier `v1.2.5` archive had one symbolic link with an absolute build-workspace target and was correctly blocked. BoxPilot does not rewrite or omit unsafe archive members. The upstream release pipeline was corrected, `v1.2.6` was rebuilt, and the published Linux archive independently passed the same no-link membership audit before this adapter was enabled.

## Four separate evidence boundaries

### Read-only host discovery

`application.keel.inspect` accepts an empty parameter object. It checks bounded supported native-service and Docker evidence, fixed port 3000 posture, persistence signals, and the exact `/api/health` identity. It never reads `.env`, a database, a managed-secret key, container environment values, a private mount source, or a browser-selected path.

Existing, ambiguous, duplicated, stale, incompletely persistent, or non-loopback Keel evidence blocks new staging. This prevents a new release tree from being confused with adoption or migration of an existing instance.

### Guarded artifact acquisition

Artifact planning accepts an empty JSON object and records a server-generated acquisition UUID. After separate staging and owner-password approval, the restricted helper can request only that UUID. A fixed sandboxed one-shot downloads only the compiled GitHub release URL, permits only the reviewed GitHub release-asset redirect shape, checks the exact response length, hashes every byte, and atomically publishes mode `0600` archive and evidence files.

The acquisition job does not extract or execute the archive. Changed bytes, changed public provenance, unexpected redirects, stale approval, unsafe existing files, and partial failures fail closed.

### Runtime archive membership inspection

`application.keel.archive.inspect` accepts no parameters. It opens only the fixed root-owned artifact with no-follow checks, verifies its exact size and SHA-256, and streams bounded gzip and tar validation without extraction. The parser validates tar checksums and rejects malformed data, unexpected roots or counts, traversal, absolute or backslash paths, duplicates, links, devices, FIFOs, unsupported extensions, unknown types, and size or member-limit violations.

The response contains aggregate counts and fixed risk identifiers only. It never returns a member name, link target, member content, archive byte, or extracted path. The expected `v1.2.6` result is `safe` with exactly 2,974 members and no risks.

### Inert release staging

`application.keel.stage.inspect` is parameter-free and read-only. It reports only aggregate fixed-release evidence. Inspection never repairs permissions or changes files. Unsafe modes, links, hard links, state files, secrets, changed package identity, changed membership, partial ambiguity, or unsafe evidence return `invalid` and block staging.

`application.keel.stage` accepts only one server-generated stage UUID after an immutable plan is staged and the owner re-enters the account password. The helper then:

1. Rechecks local artifact identity and the runtime archive gate.
2. Creates only fixed root-owned directories beneath `/var/lib/boxpilot-managed/apps/keel`.
3. Removes only prior helper-generated partial directories matching the fixed release and UUID shape.
4. Extracts into one helper-generated partial directory with fixed `/usr/bin/tar` arguments.
5. Requires the exact archive root, package name and version, and required runtime files.
6. Rejects symbolic links, multiply linked files, non-regular files, `.env` files, managed-secret keys, SQLite files, and other application state.
7. Requires exactly 2,974 source members, 2,466 regular files, and 508 directories.
8. Rechecks the source archive after extraction.
9. Hardens directories to mode `0700`, executable files to `0700`, and other files to `0600`.
10. Writes one mode `0600` evidence file and atomically publishes the fixed `1.2.6` release directory.
11. Removes its generated partial or newly published release tree if later verification fails.

The result explicitly proves `applicationInstalled`, `applicationStateCreated`, `serviceChanged`, `registrationChanged`, `listenerChanged`, and `archiveExecuted` are all false. The archive was parsed and extracted as data; none of its programs were run.

## Owner workflow

1. Open **Applications**, choose **Keel Notes**, and review discovery, artifact, archive, staging, and public provenance evidence.
2. If the artifact is absent, create the separate fixed acquisition plan.
3. Stage that artifact plan, open **Repair Center**, review the inert-download boundary, and re-enter the owner password.
4. Wait for the background acquisition job to complete, then refresh Applications.
5. Generate the Keel safe-staging plan. It becomes executable only when discovery is clean, the exact local artifact is verified, the archive gate is safe, the staging destination is absent or a replaceable helper partial, prerequisites are ready, the host is Linux x64, and public release provenance still matches.
6. Stage the exact plan revision.
7. Open Repair Center, review the no-install recovery boundary, and re-enter the owner password.
8. Wait for the background job and inspect its completed evidence.

The job never asks for a sudo password, shell command, path, service name, listener, Keel account, claim token, or registration choice.

## Operations that remain unavailable

BoxPilot `0.46.0` cannot:

- Install Node.js, Keel, or another package through the Keel adapter
- Create a service account, writable state directory, systemd unit, or reverse-proxy route
- Start, stop, restart, enable, or expose Keel
- Create an owner, claim an instance, or change registration policy
- Read, export, import, back up, restore, migrate, or delete Keel data
- Adopt or overwrite an existing native or Docker installation
- Change Tailscale Serve, firewall, DNS, DHCP, or router state
- Download an arbitrary asset, clone a repository, select another release, or update Keel

## Stateful data and claim contract for the next milestone

A future installation adapter must keep immutable release bytes separate from the writable recovery unit. At minimum, coordinated recovery must preserve the database, uploads, backups, and `.keel-server-secrets.key` companion together. Copying a live SQLite file is not an accepted backup. The source must be quiesced or exported safely, restarted, health checked, and tested in an isolated no-network restore environment before BoxPilot reports protection.

Keel registration begins open under its current operator workflow. A future BoxPilot install must stay loopback-only while unclaimed, use Keel's short-lived one-use terminal claim, verify ownership and registration policy, and only then offer a private Tailscale access handoff. Tailscale access does not replace Keel authentication.

Before installation can ship, the adapter still needs a dedicated unprivileged account, immutable release activation link, private writable state, hardened loopback-only unit, exact health checks, local claim verification, application-aware backup, isolated restore, upgrade rollback, and negative tests for interrupted activation and recovery failures.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Third-party managed hosting requires separate license review.
