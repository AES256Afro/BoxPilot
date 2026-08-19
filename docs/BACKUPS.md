# Verified application backups

BoxPilot provides deliberately narrow recovery-evidence paths: the `0.38.0` WAL-aware controller database snapshot, `0.39.0` encrypted independent exact-restore stage, and `0.40.0` fixed evidence-gated retention; the restore-verified local Uptime Kuma and Pi-hole adapters plus their `0.44.0` encrypted independent exact-archive restore stage and `0.60.0` per-application fixed retention; the `0.48.0` consistent Keel export, guaranteed source restart, and isolated SQLite-open drill using that same independent application protection and retention boundary; the `0.49.0` stopped Keel recovery clone, `0.50.0` disposable private-namespace startup rehearsal, `0.51.0` rollback-backed production promotion, and `0.52.0` operator-requested rollback with displaced-state preservation; and the VM export, encrypted independent-copy, isolated restore-drill, guarded recovery-clone, and evidence-gated retention chain completed through `0.16.0`. It does not report a workload as protected merely because a file was copied.

## Application retention

Version `0.60.0` adds one fixed, high-risk retention batch for the separate `restic-applications` repository. It keeps at least three retained protected snapshots for each application, every snapshot younger than 30 days, every snapshot without passing independent exact-archive restore evidence, every backup referenced by a published Keel recovery object, and every snapshot referenced by an active application operation. A plan can include at most 100 exact sorted snapshot ids.

The helper reads only snapshots tagged `boxpilot-application`, requires every repository snapshot to map to one durable protection record and its exact application, backup, and protection tags, and blocks on missing or unattributed evidence. After approval it runs `restic forget` only for the reviewed ids, runs a complete `restic check --read-data`, proves the reviewed candidates absent, proves all reviewed noncandidates present, and records confirmed partial removal even if a later verification step fails. It never runs `restic prune`, removes local archives, changes applications, deletes Keel recovery objects, accepts a policy or selector from the browser, or claims reclaimed space.

## Safety boundary

The browser can request immutable local plans for `boxpilot-controller`, `uptime-kuma`, `pi-hole`, or `keel`. Independent application protection and stopped Keel recovery can select only a durable verified local application backup id. The Keel startup rehearsal can select only a durable stopped recovery id. Keel production promotion can select only a durable stopped recovery whose latest matching startup rehearsal passed. Approval requires the owner password. The restricted root helper derives every source, artifact, repository, password-file, recovery, drill, promotion, rollback, and restore path itself.

It never accepts a path, archive command, container name, image name, destination, repository selector, password, restic argument, or shell string from the browser.

The managed application and backup directory is root-only mode `0700`. Artifacts, manifests, and generated Compose definitions are mode `0600`. The unprivileged web process reaches these operations only through the typed Unix socket and cannot read the files directly.

## BoxPilot controller workflow

Version `0.38.0` creates a consistent standalone snapshot of the fixed live SQLite database with `VACUUM INTO`, so committed WAL state is included without stopping the controller. It computes SHA-256, requires integrity, foreign-key, schema, and owner-state checks to pass, copies the artifact into a generated root-only drill workspace, opens and verifies that copy again, removes the drill workspace, and writes a recovery manifest. The production database is never replaced or changed.

The local artifact remains on the server and contains sensitive authentication, agent, job, and audit state. It is not independently protected. Version `0.39.0` can bind that exact local evidence to the separate fixed `restic-controller` repository, run a complete repository read, restore the exact snapshot, rehash both files, and repeat the isolated database checks. Version `0.40.0` can later forget at most 100 exact old protected snapshot references after preserving the fixed three-copy, 30-day, failed-restore, and active-job floors. It then reads all remaining repository data and proves reviewed noncandidates remain. It does not prune or remove the local artifact. See [the controller backup and manual recovery runbook](CONTROLLER-BACKUPS.md) before configuring or operating it.

## Uptime Kuma workflow

1. Verify the managed source container is installed and healthy.
2. Revalidate Docker, helper, and storage readiness.
3. Stop Uptime Kuma cleanly so its SQLite database is consistent.
4. Archive only the managed `data` directory and curated Compose definition.
5. Restart the source and require Docker health to pass.
6. Compute SHA-256 over the completed immutable archive.
7. Extract into a confined temporary restore workspace.
8. Start the same digest-pinned image with the restored data, `--network none`, and no published ports.
9. Require the restore container health check to pass.
10. Remove the temporary container and restore workspace, then persist evidence in SQLite.

An interrupted or failed job is never recorded as a successful backup. Existing completed archive names are never overwritten.

## Artifact location

The helper stores artifacts under:

```text
/var/lib/boxpilot-managed/backups/uptime-kuma/<backup-uuid>.tar.gz
/var/lib/boxpilot-managed/backups/pi-hole/<backup-uuid>.tar.gz
/var/lib/boxpilot-managed/backups/keel/<backup-uuid>.tar.gz
/var/lib/boxpilot-managed/backups/boxpilot-controller/<backup-uuid>/boxpilot.sqlite3
/var/lib/boxpilot-managed/backups/boxpilot-controller/<backup-uuid>/manifest.json
```

The BoxPilot database stores the artifact reference, SHA-256 digest, size, measured source downtime, restore isolation settings, operator, and verification time. It does not store the application data itself.

## Recovery behavior

If archive creation fails, the helper restarts Uptime Kuma and verifies source health before returning failure. If source restart verification fails, the job instructs the operator to start and inspect `boxpilot-uptime-kuma` immediately.

Restore-drill failure preserves the completed archive for investigation but does not create a green backup record.

## Pi-hole configuration workflow

Version `0.20.0` adds a second adapter whose artifact contains:

- Persistent `/etc/pihole` configuration from `/var/lib/boxpilot-managed/apps/pi-hole/etc-pihole`
- The exact curated `compose.yaml`
- The generated `admin-password` environment file

The artifact is root-only mode `0600` and contains a live administrator secret. Do not copy it into source control, a support bundle, an unencrypted share, or an operator-selected browser path.

For an approved Pi-hole backup, BoxPilot:

1. Requires the managed Pi-hole container to be healthy with exact LAN TCP and UDP port 53 bindings and its reviewed LAN web binding.
2. Stops only `boxpilot-pi-hole` and creates a new non-overwriting archive in the fixed helper-owned directory.
3. Restarts the source, requires its Docker health check, and independently rechecks the exact published bindings.
4. Records the artifact SHA-256, size, and measured downtime.
5. Extracts the artifact beneath a server-generated root-only restore workspace and validates the configuration directory, curated digest-pinned Compose definition, and administrator-secret shape.
6. Starts a temporary `boxpilot-pi-hole-restore-drill` container using the restored configuration and secret with `--network none`, zero published ports, `cap_drop: ALL`, only the seven adapter capabilities, and `no-new-privileges:true`.
7. Requires the upstream container health check, removes the temporary container and workspace, and records explicit configuration, secret, isolation, source-restart, router-no-mutation, and DNS-no-cutover evidence.

Archive failure restarts and rechecks the source before reporting failure. Source restart failure directs the operator to keep the router and clients on the independent resolver and recover the known container. Restore-drill failure leaves the completed root-only archive for investigation but records no verified backup.

Before stopping the source, the helper writes a strict root-only active-operation marker. On helper restart it validates that marker, restarts and rechecks the exact managed Pi-hole source when needed, and removes an orphan drill only if its digest-pinned image, `network none` mode, empty port bindings, and exact generated configuration mount all match. Ambiguous container or marker state fails helper startup for manual inspection instead of triggering broad cleanup.

This workflow never publishes restore ports, edits Pi-hole live configuration, retrieves the password into the web process, changes DHCP, changes a router, advertises DNS, reconfigures Tailscale, or performs DNS cutover.

## Keel Notes workflow

Version `0.48.0` backs up only the exact BoxPilot-managed Keel 1.2.6 native service. The plan requires the fixed install identity, active and enabled `keel.service`, private state, loopback-only listener, exact JSON health identity, the `runtime.node` prerequisite, the helper boundary, and storage readiness.

For one approved Keel backup, BoxPilot:

1. Writes a five-minute root-only operation marker and starts one static no-argument systemd unit.
2. Rechecks the install id, release, dedicated account, service, private state, and loopback health.
3. Stops only `keel.service`, confirms it is inactive, and runs the fixed upstream `keel export` as the `keel` uid and gid.
4. Captures the consistent SQLite database, emitted WAL companions, managed-secret companion and uploads when present, and the fixed environment into one generated tree without returning contents.
5. Rejects links, non-regular files, multiple hard links, unexpected top-level entries, unsafe managed-secret shape, any upstream incomplete-uploads warning, and fixed member or logical-size ceiling violations.
6. Opens the exported SQLite copy read-only and requires `PRAGMA integrity_check`, zero foreign-key issues, and the required Keel tables.
7. Records complete file hashes, sizes, a deterministic tree digest, and a root-only manifest; creates a non-overwriting compressed artifact; restarts Keel; and requires the exact health identity.
8. Extracts the artifact into one generated restore workspace while the one-shot has only loopback network access. It starts no application and verifies the restored manifest checksum, membership, complete tree digest, SQLite integrity, foreign keys, and schema.
9. Removes the successful drill workspace and records source-restart, isolation, no-production-replacement, and no-network-or-router-mutation evidence.

The script and systemd unit both request source restart after failure. Helper startup can also recover a validated marker left by an interrupted request. It restarts only `keel.service` and removes only generated unrecorded backup paths after restart succeeds. It never deletes or replaces `/var/lib/keel`, changes claim or registration, exposes a listener, modifies Tailscale or a firewall, changes DNS or DHCP, or contacts a router.

The archive may contain private notes, users, sessions, configuration, uploads, credentials, and the managed-secret companion. Keep it mode `0600` and treat it as highly sensitive. Local verification proves that the artifact can be opened and structurally recovered, but not that the server's storage failure is covered. Run the separate encrypted independent application protection workflow before marking it protected.

### Stopped Keel recovery clone

Version `0.49.0` can select only a durable local Keel backup whose isolated drill already passed. It creates a new immutable plan containing one server-generated recovery id, the backup id, exact archive and manifest SHA-256 digests, and exact archive size. No browser path, command, environment value, password, claim token, destination, network, or promotion choice is accepted.

After separate staging and owner-password approval, the helper:

1. Revalidates the root-owned mode-0600 source archive and result record, then rehashes the complete archive.
2. Lists at most 100,000 members and requires every member to remain beneath the single `keel-export` root with no absolute path, parent traversal, backslash path, duplicate, or null byte.
3. Extracts only beneath `/var/lib/boxpilot-managed/keel-recoveries/.<recovery-id>.partial` in the helper's private network namespace.
4. Rejects links, special files, multiple hard links, changed top-level layout, invalid managed-secret shape, changed manifest, changed complete tree, or failed SQLite integrity, foreign-key, and required-schema checks.
5. Copies the database, fixed environment, optional WAL companions, managed-secret companion, and uploads into a new live-layout `state` directory, then repeats tree and SQLite checks.
6. Hardens every directory to root-owned mode `0700` and every file to mode `0600`, writes `recovery.json`, and atomically renames the partial directory to the recovery id.
7. Records the clone in controller SQLite only after all evidence passes.

The clone is data at rest. No Keel process is started, no port is bound, and no network is attached. `/var/lib/keel` and the source archive are never replaced, edited, renamed, or removed. Failure before publication removes only the generated partial directory. A published clone is preserved for explicit operator review. Promotion, application startup, login proof, deletion, and production restore are not part of this workflow.

### Isolated Keel startup rehearsal

Version `0.50.0` can select only a durable stopped Keel recovery record. A read-only helper inspection revalidates its root-owned evidence, complete tree digest, SQLite health, and exact 1.2.6 release. The immutable plan pins one generated drill id, the recovery id, evidence SHA-256, and state-tree SHA-256. It accepts no browser path, command, environment, port, network, login, claim, registration, or promotion input.

After separate staging and owner-password approval, a static no-argument one-shot copies the recovery to one generated disposable workspace. It runs the exact release as the dedicated `keel` uid and gid with a fixed environment whose database, uploads, and backup paths point only into that copy. The unit has `PrivateNetwork=true`, loopback-only IP policy, zero published ports, and read-only mounts for the source recovery, fixed release, and production `/var/lib/keel`.

Passing evidence requires the exact Keel health identity on internal port 3100, clean process stop, SQLite integrity, zero foreign-key issues, required schema, unchanged source evidence and tree digest, unchanged production service state, and removed workspace. Failure kills the generated process and removes only the generated partial. It does not prove owner login, start or attach the source recovery, replace production, change claim or registration, expose Tailscale or LAN access, or authorize promotion.

### Guarded Keel production promotion

Version `0.51.0` permits a separately approved production promotion only after the latest rehearsal for the exact stopped recovery and state digest passes. The immutable plan also pins the current healthy managed install and a generated promotion id. The browser cannot supply a state path, rollback path, service, command, token, listener, or network setting.

The static no-argument promotion unit first copies and completely revalidates the candidate. It then writes a persistent phase marker, stops only Keel, verifies the stopped old and new databases, requires all exchange paths to share one filesystem, and atomically moves the entire old production state into a generated root-only rollback checkpoint before atomically activating the candidate. Exact loopback health, SQLite, source-immutability, and marker-removal evidence must all pass.

Failure after the marker causes the same unit to stop the candidate, atomically restore the exact prior state, restart Keel, and require old-production health. Helper startup reruns that same fixed reconciliation path after an interruption. The successful promotion restores all state present in the recovery, including users, sessions, credentials, uploads, claim, and registration. It does not prove owner login, change network exposure, apply rollback retention, or delete the source recovery or prior-production checkpoint.

### Operator-requested Keel rollback

Version `0.52.0` can select only a durable successful promotion whose original checkpoint still matches the recorded evidence checksum and complete state digest. The immutable plan pins a generated rollback id, promotion id, current managed-install id, original evidence checksum, and original state digest. No state path, command, service, token, port, network, or retention input is accepted.

The fixed no-argument unit copies and revalidates the original checkpoint, stops only Keel, verifies current SQLite, atomically retains current production in a generated displaced-state checkpoint, and activates the copied earlier state. Exact loopback health, SQLite, original-checkpoint immutability, and displaced-state publication must all pass. Failure or interruption restores and health-checks displaced current production. Successful evidence preserves both local checkpoints and changes no Tailscale, firewall, DNS, DHCP, or router state. Owner login, independent protection, retention, deletion, and a second rollback from the same promotion remain unavailable.

## Encrypted independent application protection

Version `0.44.0` adds a second required layer for a locally verified Uptime Kuma or Pi-hole archive. Version `0.48.0` admits a Keel archive only after its native-service restart and isolated SQLite-open evidence passes. All three use the fixed repository and separate key below:

```text
Mount:      /mnt/boxpilot-backup
Repository: /mnt/boxpilot-backup/restic-applications
Key file:   /etc/boxpilot/secrets/application-backup-restic-password
Cache:      /var/cache/boxpilot-application-restic
Drills:     /var/lib/boxpilot-managed/application-independent-restore-drills
```

The mount must be an exact writable mountpoint on a filesystem different from both `/var/lib/boxpilot-managed/apps` and `/var/lib/boxpilot-managed/backups`. The repository password must be a separate root-owned mode-0600 key. Do not reuse the controller or VM recovery password.

After mounting independent storage, run only from an interactive server terminal:

```bash
sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh
sudo systemctl restart boxpilot-helper.service boxpilot.service
```

The script accepts no arguments, refuses a symlink or same-filesystem destination, reads the password without echo, and initializes only `restic-applications`. Keep a recovery copy of the password outside the server and outside the mounted backup filesystem.

For one approved protection job, BoxPilot:

1. Requires the durable local backup to contain complete prior application-aware no-network restore evidence.
2. Pins the application id, backup and protection UUIDs, exact archive SHA-256 and size, and destination revision in an immutable plan.
3. Revalidates the exact mount, repository identity, recovery-key mode, capacity, source artifact type, mode, size, and complete SHA-256 at stage and approval time.
4. Writes only the fixed derived archive path into `restic-applications` with server-generated tags.
5. Runs `restic check --read-data` so every repository data pack is read.
6. Confirms the exact snapshot id, source path, and application, backup, and protection tags.
7. Restores that exact snapshot with verification into a generated root-only workspace, then requires identical size and SHA-256.
8. Removes the successful drill workspace and records encryption, independence, repository verification, prior local drill, and exact restored-artifact evidence.

Uptime Kuma, Pi-hole, and Keel are shown as protected only after both layers pass. The independent drill deliberately does not extract the sensitive archive or start another application; that adapter-aware boot or SQLite-open proof already belongs to the pinned local record. It proves the encrypted independent repository can return the exact bytes that passed that earlier drill.

This workflow never starts or stops the production application, changes the local archive, returns a secret, changes router or client DNS, queries DNS, forgets a snapshot, prunes packs, schedules itself, or performs automatic production restore. A failed post-copy check preserves the repository and generated root-only drill workspace for inspection. Application retention remains unavailable.

Authenticated routes:

```text
GET  /api/v1/application-backup-protection
POST /api/v1/application-backups/:id/protection-plans
POST /api/v1/application-protection-plans/:id/stage
```

Helper operations:

```text
application.backup.protection.inspect parameters: {}
application.backup.protection.create  parameters: {
  applicationId, backupId, protectionId,
  expectedArtifactChecksumSha256, expectedSizeBytes,
  expectedDestinationRevision
}
```

## VM encrypted independent-copy workflow

Version `0.13.0` can move a completed integrity-verified local VM export into one fixed restic repository on a dedicated mounted filesystem. The browser never supplies a path, repository location, password, restic argument, tag, or binary.

The fixed locations are:

```text
/mnt/boxpilot-backup
/mnt/boxpilot-backup/restic-vm
/etc/boxpilot/secrets/vm-backup-restic-password
/var/cache/boxpilot-restic
```

The helper requires the mount to be an exact writable mountpoint and compares filesystem device identifiers against both `/var/lib/boxpilot-managed/vm-exports` and `/var/lib/libvirt/images`. A directory on the server root filesystem is rejected even if it has the expected name. The password file must be a regular non-symlink owned by root, mode `0600`, and 16 to 4096 bytes.

Prepare a real external disk or separately mounted NAS filesystem first. Install restic, mount the destination, then run the interactive setup utility from the server terminal:

```bash
sudo apt update
sudo apt install -y restic
sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh
sudo systemctl restart boxpilot-helper boxpilot
```

The script refuses a same-filesystem destination and never accepts the repository password as a command-line argument. Store a separate recovery copy of that password outside the server. Losing it makes the repository unrecoverable.

For an approved copy job, BoxPilot:

1. Revalidates the immutable export id, domain identity, manifest SHA-256, size, repository identity, exact mount, and free space.
2. Rehashes the manifest, inactive XML, and every standalone qcow2 disk before backup.
3. Writes one restic snapshot tagged with server-generated export and backup ids.
4. Requires the JSON backup summary to match the exact logical source size.
5. Runs a full `restic check --read-data`, reading every repository data pack. This is compatible with Ubuntu 26.04's restic 0.18.1 package but becomes slower as the repository grows.
6. Reads the snapshot back and confirms its id, source path, and both server-generated tags.
7. Records encryption, independence, repository id, snapshot id, size, operator, and verification evidence in SQLite.

The copy operation does not run `forget`, `prune`, or automatic repository deletion. A failed post-copy verification leaves the repository intact for inspection. The local VM export is unchanged. Retention is a separate high-risk workflow with its own immutable preview and approval.

### Protection state before a restore drill

A newly completed VM copy is reported as:

- encrypted: yes
- independent: yes
- repository verified: yes
- isolated restore drill: no
- protected: no

This distinction is intentional. Repository readability does not prove that the domain XML and qcow2 disks can boot as an isolated guest.

## VM isolated restore drill

Version `0.14.0` can validate one completed encrypted independent VM backup. It never accepts a browser-supplied snapshot, repository, restore path, domain name, network, firmware path, command, or binary. The immutable job is tied to the durable backup and export records plus the exact repository and snapshot ids recorded by `0.13.0`.

For an approved drill, BoxPilot:

1. Revalidates repository identity, exact snapshot path and server-generated tags, temporary capacity, and the generated drill-domain name.
2. Restores the exact snapshot with restic content verification under `/var/lib/libvirt/images/boxpilot-restore-drills/<server-generated-uuid>`.
3. Rehashes the manifest, inactive XML, and every disk; rejects unexpected files; and runs `qemu-img check` on each restored qcow2 image.
4. Temporarily grants the `libvirt-qemu` group read and traversal access only to the verified restored disk paths.
5. Imports the disks into a generated transient libvirt domain using 2 vCPUs, 2048 MiB, the recorded BIOS or UEFI mode, a fixed QEMU guest-agent channel, and `--network none`.
6. Confirms that the domain is running and non-persistent and has zero libvirt network interfaces.
7. Requires two guest-agent pings while the domain remains running.
8. Destroys the transient domain, removes only its generated UEFI NVRAM if present, revokes temporary QEMU disk access, removes the successful restore workspace, and verifies cleanup.
9. Atomically records the passing evidence and promotes only that backup record to `protected: true`.

The guest must already contain and enable `qemu-guest-agent`. A drill without it fails safely. The no-network policy intentionally does not test DNS, HTTP, database clients, or other application-level network health.

On failure, BoxPilot never promotes protection. It attempts to destroy only the generated transient domain, removes only generated drill NVRAM, revokes temporary QEMU permissions, and preserves the restored workspace as root-only evidence for inspection. It never modifies the source VM, local export, restic snapshot, or repository retention.

If the helper process or host restarts mid-drill, helper startup reserves the full server-generated drill UUID namespace and reconciles only a transient zero-network domain whose disk paths match its exact managed workspace. It then removes generated NVRAM, resets the preserved tree to root-only ownership and modes, and starts the helper. An ambiguous domain, path, or firmware artifact fails helper startup for manual inspection instead of triggering broad cleanup.

The successful state is:

- encrypted: yes
- independent: yes
- repository verified: yes
- isolated restore drill: yes
- protected backup record: yes

## VM guarded recovery clone

Version `0.15.0` can materialize a protected backup as a new persistent recovery domain. It never performs an in-place restore. Planning accepts only one operator value: a constrained new domain name. Backup, export, repository, snapshot, restore-drill, manifest, size, and destination evidence come from durable server records and are revalidated through the helper.

For an approved recovery job, BoxPilot:

1. Requires the exact backup record to be encrypted, independent, repository-verified, protected, and backed by complete passing isolated restore-drill evidence.
2. Revalidates the fixed repository, snapshot, capacity, target-name absence, and unused server-generated destination.
3. Restores and reverifies the exact snapshot through the same fixed staging and checksum engine used by the passing drill.
4. Moves only the verified export beneath `/var/lib/libvirt/images/boxpilot-recoveries/<server-generated-uuid>`.
5. Grants the libvirt QEMU group persistent read access only to recovered qcow2 disks. The manifest, source XML, and generated recovery definition remain root-only.
6. Generates and validates a fixed persistent libvirt definition with the new name, exact recovered disks, source firmware mode, guest-agent channel, loopback-only SPICE, and no network interface.
7. Defines the domain without starting it, disables autostart, and verifies a new UUID, stopped state, persistence, zero interfaces, and exact disk paths.
8. Atomically records the completed recovery relationship in SQLite.

The source VM, local export, restic snapshot, repository retention, and existing domains remain unchanged. Before definition, failed work remains root-only in staging for inspection. After definition begins, rollback is confined to the exact new stopped no-network domain and generated directory after strict validation. A process or host crash can leave a stopped isolated clone for manual inspection instead of triggering uncertain deletion.

The recovered domain is not automatically started and cannot receive a network interface through this release. Starting it uses a separate password-approved lifecycle plan. In-place overwrite, source deletion, automatic cutover, and application-level acceptance remain unavailable.

## Guarded VM backup retention

Version `0.16.0` adds one fixed retention policy for the current mounted-restic VM repository. It does not accept a browser-supplied repository, path, restic command, selector, retention count, age, prune flag, or password.

The policy evaluates active durable VM backup records by domain UUID and keeps:

- The three newest active backups for every VM
- Every backup less than 30 days old
- Every backup without complete passing restore-drill evidence
- Every backup referenced by a recorded recovery clone
- Every backup currently consumed by an applying or verifying restore-drill or recovery job
- Every repository snapshot that BoxPilot cannot attribute exactly to an active durable backup record, by blocking the run for investigation

At most 100 eligible snapshots enter one approved batch. Additional eligible snapshots are deferred to a later plan. Planning records the exact repository id, destination revision, complete BoxPilot-tagged snapshot-set revision, backup ids, snapshot ids, age, size, and keep reasons.

For an approved retention job, BoxPilot:

1. Recomputes the policy and requires the exact same candidates and snapshot-set revision.
2. Sends only a sorted list of one to 100 full 64-character snapshot ids through the restricted helper protocol.
3. Rechecks the fixed independent mount, encrypted repository identity, and complete tagged snapshot inventory.
4. Runs `restic forget` only for those exact ids. Selectors such as `latest`, arbitrary tags, keep flags, and paths are rejected.
5. Does not run `restic prune`.
6. Runs a full `restic check --read-data` after forgetting the selected references.
7. Proves every approved id is absent and every noncandidate id from the reviewed snapshot set remains.
8. Atomically records the run and marks the corresponding durable backup records as forgotten.

Restore-drill and recovery planning reject forgotten backup records. Source VMs, local exports, recovery domains, repository configuration, noncandidate snapshots, and pack data are not intentionally changed. Forgetting a snapshot reference cannot be automatically rolled back, even when prune has not run, so BoxPilot directs recovery to another retained protected snapshot and never claims that forgotten data is recoverable.

If `restic forget` confirms a full or partial mutation but the later full repository read or inventory verification fails, BoxPilot records every confirmed forgotten id before the job enters failed state. Those records remain unusable for restore or recovery, and the retention run preserves bounded verification reason codes for operator investigation. This avoids presenting a removed snapshot as available after a post-mutation failure.

This release does not reclaim space. A future prune workflow needs a separate capacity preview, repository lock and interruption handling, pack-level verification, explicit approval, and recovery guidance.

The controller repository uses the same evidence principle through a separate `0.40.0` policy, but its copy floor is global to the one controller repository rather than grouped by VM. It keeps the three newest active protected controller snapshots, every snapshot under 30 days old, every failed or incomplete independent restore, and every active controller-operation reference. It forgets only exact approved ids, records confirmed partial removal before a failed job is shown, does not remove local controller artifacts, and never runs prune. See [BoxPilot controller database backups](CONTROLLER-BACKUPS.md) for the operator workflow and manual recovery boundary.

## Current limitations

Controller and application backups begin as local artifacts on the server. Their separate fixed mounted-restic workflows can protect exact verified records, but an operator must first provide the independent filesystem and separately retain each repository key. The controller copy-open drill proves SQLite integrity and schema, not service startup or owner login. Application local restore containers prove basic no-network startup; the independent application drill proves exact archived bytes, not direct Pi-hole DNS service from another LAN device. The server currently has no configured independent backup mount, so its live UI correctly reports setup blockers and no real VM restore drill, recovery clone, independent retention mutation, controller protection, or application protection has run there. Remote restic backends, offsite copies, schedules, local-archive retention, controller browser download or automatic restore, restic prune, configurable policies beyond the fixed evidence-gated policies, notification, in-place restore, recovered-VM network attachment, application-level VM restore tests, PostgreSQL, and Litestream-aware adapters remain future milestones.
