# Keel Notes guarded native service and recovery evidence

BoxPilot `0.52.0` can acquire, inspect, stage, install, activate, health-check, consistently export, locally restore-verify, materialize a stopped recovery clone, run a disposable isolated startup rehearsal, promote only that exact drilled state, and explicitly roll back a completed promotion for one fixed [Keel Notes](https://github.com/AES256Afro/Keel) release. The corrected upstream `v1.2.6` server archive contains no links or special members. BoxPilot verifies that fact before extraction and again after extraction. Separate password-approved jobs create the guarded native service, create a root-only recovery artifact with an isolated SQLite-open drill, materialize only a stopped no-network recovery state, test only a disposable copy in a private network namespace, atomically exchange production only after the drill passes, and preserve both sides of a later operator-requested rollback.

Ownership claim remains a terminal-only handoff. Registration changes, owner-login proof, Tailscale exposure, import, migration activation, adoption, update, removal, rollback retention, and retained-state deletion remain unavailable. A locally verified artifact or local rollback checkpoint is not independently protected until its separate encrypted restic copy and exact restored-artifact proof pass.

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

## Guarded evidence boundaries

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

### Consistent export and isolated recovery drill

`application.keel.backup` accepts only one server-generated backup UUID from a separately staged immutable Backups plan. The restricted helper rechecks the exact managed install and writes a five-minute root-only marker before starting static `boxpilot-keel-backup.service`. The one-shot accepts no arguments and:

1. Rechecks the exact 1.2.6 release, install id, dedicated account, active service, private state, and loopback health identity.
2. Stops only `keel.service` and confirms it is inactive.
3. Runs the fixed upstream `keel export` as the non-login `keel` uid and gid into one generated partial directory.
4. Includes the consistent SQLite database, WAL companions when emitted, managed-secret companion when present, uploads when present, and the fixed environment without returning their contents.
5. Rejects links, special files, multiple hard links, changed top-level membership, unsafe secret-key shape, any upstream incomplete-uploads warning, more than 100,000 members, or more than 20 GiB of logical data.
6. Opens the exported SQLite database read-only and requires integrity, zero foreign-key issues, and the `AppSetting`, `Page`, `User`, and `Workspace` tables.
7. Writes a complete tree digest and root-only manifest, creates a non-overwriting archive, restarts Keel, and requires the exact loopback health identity.
8. Extracts only into a generated restore-drill workspace while the unit is restricted to loopback network access, starts no application, and requires the restored manifest, complete tree, file hashes, sizes, SQLite integrity, foreign keys, and schema to match.
9. Removes the successful drill workspace and publishes root-only result evidence. The production database, environment, key, uploads, claim, registration, listener, Tailscale, firewall, DNS, DHCP, and router are unchanged.

The script and static unit both request source restart on failure. Helper-start recovery detects a short-lived marker left by an interrupted request, asks systemd to restart the exact source, and removes only generated unrecorded partial, drill, archive, and result paths. Ambiguous or failed restart recovery preserves the marker for manual intervention.

### Isolated stopped-clone startup rehearsal

`application.keel.recovery-drill.inspect` accepts only one durable recovery UUID. It revalidates the root-owned clone evidence, complete state-tree digest, SQLite integrity, and exact staged 1.2.6 release. Planning pins the evidence checksum and tree digest into a separate immutable plan.

After separate staging and owner-password approval, `application.keel.recovery-drill.create` accepts only the server-generated drill UUID, recovery UUID, evidence checksum, and tree digest. The helper writes a five-minute root-only marker and starts static `boxpilot-keel-recovery-drill.service`. That unit accepts no arguments and:

1. Revalidates the exact stopped recovery, fixed release, and dedicated non-login `keel` identity.
2. Copies only that recovery state into one generated partial beneath `/var/lib/boxpilot-managed/keel-recovery-drills`.
3. Replaces the copied environment with fixed paths into the disposable state and runs Keel 1.2.6 as the `keel` uid and gid on internal port 3100.
4. Uses `PrivateNetwork=true`, `IPAddressDeny=any`, `IPAddressAllow=localhost`, and zero published ports. Its loopback listener exists only inside the unit namespace and is not reachable from the host, LAN, or tailnet.
5. Requires the exact `{ app: "keel", ok: true }` health identity, stops the disposable process, and repeats SQLite integrity, foreign-key, and required-schema checks.
6. Rehashes the source recovery evidence and complete tree, verifies the production service state did not change, and removes the successful disposable workspace.
7. Records passing evidence only when process start and stop, health, SQLite, source immutability, zero published ports, and workspace removal all pass.

The unit mounts the source recovery, fixed release, and production `/var/lib/keel` read-only. Failure terminates the generated process and removes only its generated partial workspace. It never tests an owner login, changes claim or registration, promotes state, installs a service, configures Tailscale, opens a firewall, changes DNS or DHCP, or contacts a router.

### Guarded production promotion

Version `0.51.0` can plan only from a durable stopped recovery whose latest matching isolated startup rehearsal passed. Planning pins the recovery id, drill id, recovery evidence checksum, complete state-tree digest, generated promotion id, and exact healthy managed-install id. A stale drill, changed source, unhealthy production service, or mismatched install blocks planning.

After separate staging and owner-password approval, `application.keel.promotion.create` accepts only that exact server-generated tuple. The helper writes a fixed root-only approval file and starts static `boxpilot-keel-promotion.service`. That unit accepts no arguments and:

1. Revalidates the source recovery, matching drill, exact release, dedicated account, current managed installation, and loopback health.
2. Copies the recovery into one generated candidate and repeats complete tree and SQLite checks before touching production.
3. Writes a persistent root-only phase marker, stops only `keel.service`, and verifies both the stopped old database and candidate database.
4. Requires the candidate, production state, and rollback root to be on one filesystem so whole-directory moves are atomic.
5. Atomically moves the prior `/var/lib/keel` state into `/var/lib/boxpilot-managed/keel-promotion-rollbacks/<promotion-id>/state`, then atomically activates the candidate at `/var/lib/keel`.
6. Starts Keel and requires the exact loopback health identity, SQLite integrity, zero foreign-key issues, and required schema.
7. Proves the stopped source recovery evidence and state digest remain unchanged, writes root-only result evidence, and removes the active marker.

If any step after the marker fails, the same unit stops the candidate, moves it aside, atomically restores the exact prior production directory, restarts Keel, and requires the old health identity before reporting failure. If the helper or host restarts mid-exchange, helper startup detects the persistent phase marker and starts this same static no-argument unit to reconcile it before accepting new promotion work. The unit's `/var/lib` write allowance exists only because atomic whole-directory moves require write access to the parent; exact fixed paths, one operation marker, strict ownership and membership checks, no browser-selected paths, and automatic rollback are the controlling boundary.

The promotion restores the recovery's notes, users, sessions, credentials, uploads, managed secret, claim state, and registration state. It does not prove that an owner can log in, expose Keel to LAN or Tailscale, change a port, modify a firewall, contact a router, delete the recovery, or prune the retained prior state.

### Operator-requested rollback

Version `0.52.0` can plan only from a durable successful promotion whose original root-only rollback checkpoint still matches its recorded complete state digest and exact evidence checksum. The current managed Keel install must be healthy and must retain the same installation identity. A promotion can have only one completed operator rollback record.

After separate staging and owner-password approval, `application.keel.rollback.create` accepts only a generated rollback UUID, promotion UUID, install UUID, state digest, and evidence checksum. Static `boxpilot-keel-rollback.service` accepts no arguments. It copies and revalidates the original checkpoint, writes a persistent phase marker, stops only Keel, verifies current SQLite, requires all exchange paths on one filesystem, atomically retains current production under `/var/lib/boxpilot-managed/keel-rollback-checkpoints/<rollback-id>/state`, and activates the copied older state at `/var/lib/keel`. Success requires exact health, SQLite, an unchanged original checkpoint, and durable displaced-state evidence.

Failure or interruption stops the candidate, restores the displaced current production directory, restarts Keel, and requires its exact health identity before new rollback work is accepted. The original promotion checkpoint is never moved or edited. Neither checkpoint is an independent encrypted backup. The workflow does not prove owner login, accept a browser path or command, choose retention, delete either retained state, or alter ports, Tailscale, firewall, DNS, DHCP, or router state.

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
13. After Keel contains data, open **Backups**, create the Keel Notes plan, stage the exact revision, and approve it in Repair Center.
14. Require source restart, exact health, manifest and tree digest, SQLite checks, and removed isolated workspace evidence before treating the artifact as locally verified.
15. Configure the separate application restic destination and run the independent protection plan before treating the local artifact as protected from Bigbox storage failure.
16. To rehearse the data transformation, choose that verified local backup under **Stopped Keel recovery clones**, build the immutable plan, stage it, and approve it in Repair Center.
17. Require exact source hashes, confined archive membership, repeated manifest, tree, managed-secret, and SQLite proof, a root-only published state path, `stopped` state, `none` network, and explicit no-production-replacement evidence.
18. On that stopped clone, choose **Plan isolated startup rehearsal**, stage the exact plan, and approve it in Repair Center. Require private-namespace health, SQLite proof, clean stop, zero published ports, unchanged source evidence, and removed workspace.
19. Only after the matching rehearsal passes, choose **Plan production promotion**, review the pinned drill and rollback checkpoint, stage the exact plan, and approve it in Repair Center.
20. Require the final evidence to show the old state retained, the drilled state active, exact health and SQLite checks passing, the source recovery unchanged, and the active marker removed. Verify owner login manually before any future private exposure.
21. If the promoted state must be reversed, choose **Plan operator rollback**, review the exact original and displaced-state boundaries, stage the critical plan, and approve it in Repair Center.
22. Require the completed evidence to show the original checkpoint unchanged, current production retained under the generated displaced-state checkpoint, older state active and healthy, SQLite checks passing, and no exposure change.

Neither job asks for a sudo password, shell command, path, service name, listener, Keel account, claim token, environment value, or registration choice.

## Operations that remain unavailable

BoxPilot `0.52.0` cannot:

- Install Node.js or another package through the Keel adapter
- Accept a different Keel release, account, path, port, unit, command, or environment value
- Expose Keel through Tailscale Serve, a reverse proxy, LAN binding, firewall, or public route
- Create an owner, claim an instance, or change registration policy
- Import, migrate, or delete Keel. Production restore is limited to the exact recovery and matching drill selected by the guarded promotion plan.
- Start or expose the source recovery clone, test owner login automatically, delete a recovery, repeat rollback for one promotion, delete retained state, or prune a retained rollback checkpoint.
- Schedule Keel backups, apply application retention, run restic prune, or select another backup destination from the browser
- Adopt or overwrite an existing native or Docker installation
- Change Tailscale Serve, firewall, DNS, DHCP, or router state
- Download an arbitrary asset, clone a repository, select another release, or update Keel

## Terminal claim and private access handoff

Keel deliberately separates registration from instance ownership. BoxPilot does not collect or execute a claim token. After installation:

1. From the client computer, create a private tunnel: `ssh -N -L 3000:127.0.0.1:3000 bigbox@bigbox`.
2. Open `http://127.0.0.1:3000`, register the intended account, and generate Keel's five-minute one-use claim token.
3. SSH to Bigbox as your normal administrator and run `sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-claim.mjs 'PASTE_TOKEN'`.
4. The fixed terminal handoff rechecks the exact activation, environment, database ownership, install evidence, dedicated account, and active service before it drops permanently to the `keel` identity and calls Keel's claim transaction. `sudo -k` forces a fresh operating-system confirmation. The five-minute token never enters BoxPilot's API, database, job log, or browser storage.
5. Verify the claimed owner inside Keel, restrict or close registration, and only then plan a future private Tailscale access route.

Tailscale access does not replace Keel authentication. The current BoxPilot Tailscale Serve root remains assigned to BoxPilot and is not changed by the Keel installer.

## Stateful data contract and next milestone

The shipped adapter keeps immutable release bytes separate from writable state. Its coordinated export preserves the database, uploads, environment, and `.keel-server-secrets.key` companion when present. It does not accept a copy of the live SQLite main file as a backup. The source is stopped, exported as the service identity, restarted, health checked, and tested through an isolated no-network SQLite-open drill before BoxPilot records local verification. Version `0.49.0` transforms that exact immutable archive into a new stopped root-only live-layout state under `/var/lib/boxpilot-managed/keel-recoveries`. Version `0.50.0` runs the exact release against a disposable copy inside a private network namespace and records health, SQLite, clean-stop, source-immutability, and cleanup evidence. Version `0.51.0` can then atomically promote only that exact drilled state while retaining and automatically restoring the stopped prior production state on failure. Version `0.52.0` can explicitly restore that retained checkpoint while preserving both the original source checkpoint and displaced current production.

The next adapter milestone needs a separately designed terminal-only owner-login proof that never records a password, safe rollback-checkpoint retention and deletion, import planning, claim-state and registration verification, update rollback, and removal that preserves data by default. A future private Tailscale handoff must use a route that does not replace BoxPilot's existing Serve root and must not happen before login, claim, and registration verification.

The published source uses BUSL-1.1. Personal self-hosting and internal organizational use are within the repository's stated grant. Third-party managed hosting requires separate license review.
