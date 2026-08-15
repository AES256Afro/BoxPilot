# Verified application backups

BoxPilot provides two deliberately narrow evidence workflows: the `0.6.0` restore-verified local Uptime Kuma adapter and the `0.13.0` encrypted independent-copy stage for stopped-VM exports. It does not report a workload as protected merely because a file was copied.

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

### Honest protection state

The `0.13.0` VM copy is reported as:

- encrypted: yes
- independent: yes
- repository verified: yes
- isolated restore drill: no
- protected: no

This distinction is intentional. Repository readability does not prove that the domain XML and qcow2 disks can boot as an isolated guest. The next milestone must restore into a root-only temporary area, verify the restored files, boot with no network, and require a guest health signal before protected status can become true.

## Current limitations

The Uptime Kuma artifact remains local to Bigbox. The VM workflow supports only the fixed mounted-restic destination and requires an operator-provided independent filesystem. Bigbox currently has no configured independent backup mount, so its live UI correctly reports setup blockers. Remote restic backends, offsite copies, schedules, retention mutation, notification, isolated VM restore boot, restore execution, Keel Notes export, PostgreSQL, and Litestream-aware adapters remain future milestones.
