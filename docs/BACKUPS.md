# Verified application backups

BoxPilot provides four deliberately narrow recovery-evidence paths: the `0.38.0` WAL-aware controller database snapshot and isolated copy-open drill, the `0.6.0` restore-verified local Uptime Kuma adapter, the `0.20.0` restore-verified local Pi-hole configuration adapter, and the VM export, encrypted independent-copy, isolated restore-drill, guarded recovery-clone, and evidence-gated retention chain completed through `0.16.0`. It does not report a workload as verified merely because a file was copied.

## Safety boundary

The browser can request only an immutable plan for `boxpilot-controller`, `uptime-kuma`, or `pi-hole` and the fixed `local-managed` destination. Approval requires the owner password. The restricted root helper accepts only a server-generated UUID and derives every source, artifact, manifest, and restore path itself.

It never accepts a path, archive command, container name, image name, destination, or shell string from the browser.

The managed application and backup directory is root-only mode `0700`. Artifacts, manifests, and generated Compose definitions are mode `0600`. The unprivileged web process reaches these operations only through the typed Unix socket and cannot read the files directly.

## BoxPilot controller workflow

Version `0.38.0` creates a consistent standalone snapshot of the fixed live SQLite database with `VACUUM INTO`, so committed WAL state is included without stopping the controller. It computes SHA-256, requires integrity, foreign-key, schema, and owner-state checks to pass, copies the artifact into a generated root-only drill workspace, opens and verifies that copy again, removes the drill workspace, and writes a recovery manifest. The production database is never replaced or changed.

The artifact remains on Bigbox and contains sensitive authentication, agent, job, and audit state. It is not an independent or encrypted copy. See [the controller backup and manual recovery runbook](CONTROLLER-BACKUPS.md) before operating or moving it.

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

## VM encrypted independent-copy workflow

Version `0.13.0` can move a completed integrity-verified local VM export into one fixed restic repository on a dedicated mounted filesystem. The browser never supplies a path, repository location, password, restic argument, tag, or binary.

The fixed locations are:

```text
/mnt/boxpilot-backup
/mnt/boxpilot-backup/restic-vm
/etc/boxpilot/secrets/vm-backup-restic-password
/var/cache/boxpilot-restic
```

The helper requires the mount to be an exact writable mountpoint and compares filesystem device identifiers against both `/var/lib/boxpilot-managed/vm-exports` and `/var/lib/libvirt/images`. A directory on the Bigbox root filesystem is rejected even if it has the expected name. The password file must be a regular non-symlink owned by root, mode `0600`, and 16 to 4096 bytes.

Prepare a real external disk or separately mounted NAS filesystem first. Install restic, mount the destination, then run the interactive setup utility from the Bigbox terminal:

```bash
sudo apt update
sudo apt install -y restic
sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh
sudo systemctl restart boxpilot-helper boxpilot
```

The script refuses a same-filesystem destination and never accepts the repository password as a command-line argument. Store a separate recovery copy of that password outside Bigbox. Losing it makes the repository unrecoverable.

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

## Current limitations

The controller, Uptime Kuma, and Pi-hole artifacts remain local to Bigbox. The controller copy-open drill proves SQLite integrity and schema, not service startup or owner login. Application restore containers prove local artifact integrity and basic container startup, not survival of Bigbox loss or direct DNS service from another LAN device. The VM workflow supports only the fixed mounted-restic destination and requires an operator-provided independent filesystem. Bigbox currently has no configured independent backup mount, so its live UI correctly reports setup blockers and no real VM restore drill, recovery clone, or retention mutation has run there. Remote restic backends, offsite copies, schedules, controller browser download or automatic restore, restic prune, configurable policies, notification, in-place restore, recovered-VM network attachment, application-level VM restore tests, Keel Notes export, PostgreSQL, and Litestream-aware adapters remain future milestones.
