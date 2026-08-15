# Verified application backups

BoxPilot provides two deliberately narrow evidence workflows: the `0.6.0` restore-verified local Uptime Kuma adapter and the VM export, encrypted independent-copy, and isolated restore-drill chain completed through `0.14.0`. It does not report a workload as protected merely because a file was copied.

## Safety boundary

The browser can request only an immutable plan for `uptime-kuma` and the fixed `local-managed` destination. Approval requires the owner password. The restricted root helper accepts only a server-generated UUID and derives every source, artifact, and restore path itself.

It never accepts a path, archive command, container name, image name, destination, or shell string from the browser.

The managed application and backup directory is root-only mode `0700`. Artifacts and generated Compose definitions are mode `0600`. The unprivileged web process reaches these operations only through the typed Unix socket and cannot read the files directly.

## Workflow

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
```

The BoxPilot database stores the artifact reference, SHA-256 digest, size, measured source downtime, restore isolation settings, operator, and verification time. It does not store the application data itself.

## Recovery behavior

If archive creation fails, the helper restarts Uptime Kuma and verifies source health before returning failure. If source restart verification fails, the job instructs the operator to start and inspect `boxpilot-uptime-kuma` immediately.

Restore-drill failure preserves the completed archive for investigation but does not create a green backup record.

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

BoxPilot does not run `forget`, `prune`, or automatic repository deletion. A failed post-copy verification leaves the repository intact for inspection. The local VM export is unchanged.

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

## Current limitations

The Uptime Kuma artifact remains local to Bigbox. The VM workflow supports only the fixed mounted-restic destination and requires an operator-provided independent filesystem. Bigbox currently has no configured independent backup mount, so its live UI correctly reports setup blockers and no real VM restore drill has run there. Remote restic backends, offsite copies, schedules, retention mutation, notification, operator-directed restore execution, application-level VM restore tests, Keel Notes export, PostgreSQL, and Litestream-aware adapters remain future milestones.
