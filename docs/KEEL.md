# Keel Notes guarded native installation

BoxPilot `0.47.0` can acquire, inspect, stage, install, activate, and health-check one exact [Keel Notes](https://github.com/AES256Afro/Keel) release. The corrected upstream `v1.2.6` server archive contains no links or special members. BoxPilot verifies that fact before extraction and again after extraction. A separate password-approved job can then create a dedicated non-login account, private writable state, an atomic activation link, and one hardened service bound only to `127.0.0.1:3000`.

Ownership claim, registration changes, Tailscale exposure, backup, restore, import, migration, adoption, update, and removal remain unavailable. An installed Keel service is not claimed, exposed, or protected until those separate workflows are completed.

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
| State root | `/var/lib/keel` |
| Activation link | `/var/lib/boxpilot-managed/apps/keel/current` |
| Service account | `keel` with a non-login shell |
| Systemd unit | `/etc/systemd/system/keel.service` |
| Listener | `127.0.0.1:3000` |

The earlier `v1.2.5` archive had one symbolic link with an absolute build-workspace target and was correctly blocked. BoxPilot does not rewrite or omit unsafe archive members. The upstream release pipeline was corrected, `v1.2.6` was rebuilt, and the published Linux archive independently passed the same no-link membership audit before this adapter was enabled.

## Five separate evidence boundaries

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

### Guarded native installation

`application.keel.install.inspect` is parameter-free and read-only. It checks only the fixed dedicated account shape, activation link, unit and environment hashes, state ownership and modes, installation evidence, systemd active and enabled state, fixed release identity, database presence, and bounded health status. It does not open the database, read the managed-secret key, return environment contents, accept a path, or accept a service name.

`application.keel.install` accepts only one server-generated install UUID after an immutable plan is staged and the owner re-enters the BoxPilot password. The helper writes a five-minute root-only marker and starts the static `boxpilot-keel-install.service`. That one-shot independently rechecks the exact staged release and then:

1. Refuses any existing activation link, environment file, unit, or installation evidence.
2. Creates only the fixed `keel` system group and non-login system account.
3. Creates `/var/lib/keel`, `uploads`, and `backups` at mode `0700` without putting writable state in the release tree.
4. Makes the immutable release root-owned and readable only by the dedicated group.
5. Writes the exact root-owned mode `0640` environment file with SQLite, upload, backup, host, port, claim-required, supervised, and loopback public-URL settings.
6. Atomically points `current` at only `releases/1.2.6`.
7. Writes one exact root-owned systemd unit with no capabilities, strict filesystem protection, private temporary storage, protected kernel and home state, an address-family allowlist, and write access only to `/var/lib/keel`.
8. Enables and starts the service, waits for the exact `{ app: "keel", ok: true }` health identity at `127.0.0.1:3000`, and verifies the private SQLite file.
9. Publishes fixed installation evidence only after every check succeeds.

On failure, the one-shot stops and disables the new service and removes only the unit, environment file, activation link, and its own partial files. It preserves `/var/lib/keel`, including a database or managed-secret companion that startup may have created. It never claims an account, changes registration, configures Tailscale Serve, opens a firewall, advertises DNS, changes DHCP, or contacts a router.

## Owner workflow

1. Open **Applications**, choose **Keel Notes**, and review discovery, artifact, archive, staging, and public provenance evidence.
2. If the artifact is absent, create the separate fixed acquisition plan.
3. Stage that artifact plan, open **Repair Center**, review the inert-download boundary, and re-enter the owner password.
4. Wait for the background acquisition job to complete, then refresh Applications.
5. Generate the Keel safe-staging plan. It becomes executable only when discovery is clean, the exact local artifact is verified, the archive gate is safe, the staging destination is absent or a replaceable helper partial, prerequisites are ready, the host is Linux x64, and public release provenance still matches.
6. Stage the exact plan revision.
7. Open Repair Center, review the no-install recovery boundary, and re-enter the owner password.
8. Wait for the background job and inspect its completed evidence.
9. Refresh Applications. The staged release now offers **Plan private install**.
10. Generate the install plan. BoxPilot rechecks the staged release, fixed port 3000, empty installation boundary, prerequisites, and public provenance.
11. Stage the install plan, open Repair Center, review the state-preserving rollback, and re-enter the owner password.
12. Wait for the background job. The completed result must show the exact version, dedicated service, boot enablement, `127.0.0.1:3000`, health identity, preserved state, and still-required terminal claim.

Neither job asks for a sudo password, shell command, path, service name, listener, Keel account, claim token, environment value, or registration choice.

## Operations that remain unavailable

BoxPilot `0.47.0` cannot:

- Install Node.js or another package through the Keel adapter
- Accept a different Keel release, account, path, port, unit, command, or environment value
- Expose Keel through Tailscale Serve, a reverse proxy, LAN binding, firewall, or public route
- Create an owner, claim an instance, or change registration policy
- Read, export, import, back up, restore, migrate, or delete Keel data
- Adopt or overwrite an existing native or Docker installation
- Change Tailscale Serve, firewall, DNS, DHCP, or router state
- Download an arbitrary asset, clone a repository, select another release, or update Keel

## Terminal claim and private access handoff

Keel deliberately separates registration from instance ownership. BoxPilot does not collect or execute a claim token. After installation:

1. From the client computer, create a private tunnel: `ssh -N -L 3000:127.0.0.1:3000 bigbox@bigbox`.
2. Open `http://127.0.0.1:3000`, register the intended account, and generate Keel's five-minute one-use claim token.
3. SSH to Bigbox as your normal administrator and run `sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-claim.mjs 'PASTE_TOKEN'`.
4. The fixed terminal handoff rechecks the exact activation, environment, database ownership, install evidence, dedicated account, and active service before it drops permanently to the `keel` identity and calls Keel's claim transaction. `sudo -k` forces a fresh operating-system confirmation. The five-minute token never enters BoxPilot's API, database, job log, or browser storage.
4. Verify the claimed owner inside Keel, restrict or close registration, and only then plan a future private Tailscale access route.

Tailscale access does not replace Keel authentication. The current BoxPilot Tailscale Serve root remains assigned to BoxPilot and is not changed by the Keel installer.

## Stateful data contract for the next milestone

A future installation adapter must keep immutable release bytes separate from the writable recovery unit. At minimum, coordinated recovery must preserve the database, uploads, backups, and `.keel-server-secrets.key` companion together. Copying a live SQLite file is not an accepted backup. The source must be quiesced or exported safely, restarted, health checked, and tested in an isolated no-network restore environment before BoxPilot reports protection.

The next adapter milestone needs claim-state guidance, registration verification, application-aware backup, isolated restore, update rollback, removal that preserves data by default, and negative tests for interrupted recovery. A future private Tailscale handoff must use a route that does not replace BoxPilot's existing Serve root and must not happen before claim and registration verification.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Third-party managed hosting requires separate license review.
