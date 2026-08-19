# BoxPilot controller database backups

BoxPilot `0.38.0` adds a guarded local backup for its own SQLite controller state. Version `0.39.0` adds a separate encrypted independent protection stage for that verified snapshot. It reads the complete restic repository, restores the exact snapshot, verifies both files and the database again, and only then reports the controller snapshot as protected. Version `0.40.0` adds one fixed, separately approved retention policy for exact old protected snapshot references.

A local snapshot is recovery evidence, not complete disaster protection. The `0.39.0` stage can make a verified independent copy, but only after an operator mounts storage in a different failure domain and keeps the separate recovery password outside the server. The `0.40.0` retention workflow can remove exact repository snapshot references, but it never removes the local verified artifacts and never reclaims repository space.

## What the backup contains

The snapshot contains BoxPilot controller state, including owner password hashes, sessions, enrolled-agent identities, plans, approvals, jobs, audit events, migrations, router evidence, and backup records present when the snapshot is created. Treat the entire backup directory as sensitive.

The fixed locations are:

```text
Live source:      /var/lib/boxpilot/boxpilot.sqlite3
Backup root:     /var/lib/boxpilot-managed/backups/boxpilot-controller
Drill root:      /var/lib/boxpilot-managed/controller-restore-drills
Protection drill:/var/lib/boxpilot-managed/controller-independent-restore-drills
Artifact:        <backup-uuid>/boxpilot.sqlite3
Manifest:        <backup-uuid>/manifest.json
Restic mount:    /mnt/boxpilot-backup
Restic repo:     /mnt/boxpilot-backup/restic-controller
Recovery key:    /etc/boxpilot/secrets/controller-backup-restic-password
```

Directories are root-only mode `0700`; the database and manifest are mode `0600`. The browser cannot choose or read any path.

## Create a verified local backup

1. Sign in to BoxPilot over the private LAN or Tailscale address.
2. Open **Backups**.
3. Find **BoxPilot controller** and select **Plan verified backup for BoxPilot controller**.
4. Review the immutable workflow, sensitive-data warning, local-only destination warning, and recovery boundary.
5. Select **Stage for approval**. BoxPilot opens Repair Center.
6. Re-enter the owner password and approve **Back up and restore-test BoxPilot controller**.
7. Wait for all durable job steps to complete.
8. Return to **Backups** and confirm the artifact shows **Passed, isolated copy-open**.
9. Treat the row as **locally verified**, not protected, until the independent workflow below passes.

Do not paste the owner password into chat, a terminal command, issue tracker, or log. BoxPilot accepts it only in the approval form and does not include it in the helper request.

## Set up the fixed independent destination

BoxPilot does not partition, format, mount, or select storage. Attach and mount an external disk or NAS using a separately reviewed host procedure. The exact mount must be `/mnt/boxpilot-backup`, must be writable, and must report a different filesystem device from both `/var/lib/boxpilot` and `/var/lib/boxpilot-managed`.

After the mount is stable:

```sh
sudo apt install -y restic
sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh
sudo systemctl restart boxpilot-helper.service boxpilot.service
```

The interactive script accepts no arguments. It asks for a new controller recovery password without echo, writes only `/etc/boxpilot/secrets/controller-backup-restic-password` as `root:root` mode `0600`, and initializes only `/mnt/boxpilot-backup/restic-controller`. It refuses a symbolic-link password file, a non-exact mount, a same-filesystem destination, a short password, or a repository it cannot read. The VM repository uses a different path and password. Keep an additional recovery copy of the controller password outside the server and outside the mounted backup storage.

The server does not currently have this independent mount configured. Until it does, Backups displays every blocker and disables staging. Inspection is read-only and does not create a repository or secret.

## Protect and restore-test one local snapshot

1. Open **Backups** after the fixed destination reports ready.
2. In the verified controller artifact row, select **Plan encrypted copy**.
3. Review the immutable source hashes, destination identity, complete repository-read requirement, exact restore workflow, password-loss warning, and no-retention boundary.
4. Select **Stage independent protection**. BoxPilot opens Repair Center.
5. Re-enter the owner password and approve **Encrypt, independently copy, and restore-test BoxPilot controller state**.
6. Wait for backup, full repository read, exact snapshot readback, restore, hash checks, and SQLite checks to complete.
7. Return to **Backups** and confirm the exact row says **Protected and restored**. Expand it to retain the repository and snapshot ids.

The helper snapshots the complete generated UUID directory, including both `boxpilot.sqlite3` and `manifest.json`. It restores the exact new snapshot with restic verification into a generated root-only workspace. It requires the restored artifact and manifest SHA-256 values, size, backup identity, SQLite integrity, foreign keys, required schema, schema fingerprint, and owner-state presence to match before removing the successful workspace and recording protection.

## Apply the fixed retention policy

The policy has no operator-editable values. It considers active controller protection records in the fixed `restic-controller` repository and keeps:

- The three newest active protected snapshots
- Every snapshot younger than 30 days
- Every snapshot without complete passing independent restore evidence
- Every snapshot referenced by an applying or verifying controller protection or retention job
- Every repository snapshot that cannot be attributed exactly to an active BoxPilot protection record, by blocking the run for investigation

At most 100 eligible snapshots enter one immutable high-risk plan. Additional eligible snapshots are deferred to another separately approved batch. The plan records the exact repository id, destination revision, complete BoxPilot-tagged snapshot-set revision, protection ids, backup ids, snapshot ids, ages, sizes, and keep reasons.

For an approved batch, BoxPilot:

1. Recomputes the fixed policy and requires the exact candidate list and snapshot-set revision to remain unchanged.
2. Sends only the server-generated retention UUID, fixed evidence revisions, and a sorted list of one to 100 full snapshot ids to the restricted helper.
3. Rechecks the exact independent mount, encrypted repository identity, and complete tagged controller snapshot inventory.
4. Runs `restic forget` only for those exact ids. Moving selectors, tags, paths, keep flags, arbitrary commands, and policy values are rejected.
5. Never runs `restic prune`.
6. Reads every remaining repository data pack with `restic check --read-data --quiet`.
7. Proves every approved id is absent and every reviewed noncandidate id remains.
8. Atomically records the retention run and marks the exact protection records as forgotten.

Forgotten protection records remain visible as historical evidence but are not reported as retained or protected. If any removal is confirmed and a later repository read or inventory check fails, BoxPilot records every confirmed forgotten id before the durable job fails. This prevents a removed snapshot from being shown as available after partial success. The live database, every local controller backup directory, noncandidate repository snapshots, and repository pack data are not intentionally changed.

Because forgetting a snapshot reference cannot be automatically undone, recovery guidance points to another retained protected snapshot. Pack data may still exist until a separately designed prune workflow, but BoxPilot never claims a forgotten snapshot is recoverable.

## Why a normal file copy is unsafe

BoxPilot uses SQLite write-ahead logging. A live database can have committed state in `boxpilot.sqlite3-wal` that is not yet present in the main `boxpilot.sqlite3` file. Copying only that main file can therefore produce a stale or incomplete recovery point even when the file opens successfully.

The `0.38.0` helper opens the fixed live database read-only and uses SQLite `VACUUM INTO` to create one consistent standalone database. It does not stop BoxPilot, checkpoint or truncate the live WAL, replace the production database, or return database content to the web process.

## Verification performed

For every approved controller backup, the restricted helper:

1. Revalidates the fixed source and the pre-created helper-owned roots.
2. Requires the live database integrity check to pass, foreign-key issues to be zero, the required controller schema to be present, and at least one owner record to exist.
3. Creates a new non-overwriting UUID directory and a WAL-aware snapshot with SQLite `VACUUM INTO`.
4. Computes the artifact SHA-256 and repeats integrity, foreign-key, schema, and owner-state checks.
5. Copies the artifact into a separate generated drill workspace.
6. Requires the drill copy checksum to match, opens it read-only, and repeats the database checks.
7. Removes only the generated drill copy after success.
8. Writes and verifies a root-only JSON manifest, flushes the artifact and manifest, then returns bounded evidence.

If any step fails, no successful backup record is created. Cleanup is restricted to the new backup and drill UUID paths. Existing artifacts and the production database remain untouched.

## Restricted-helper contract

The helper exposes six controller-specific typed operations:

```text
controller.database.backup.inspect  parameters: {}
controller.database.backup.create   parameters: { backupId: <server-generated UUID> }
controller.database.protection.inspect parameters: {}
controller.database.protection.create  parameters: {
  protectionId, backupId, expectedArtifactChecksumSha256,
  expectedManifestChecksumSha256, expectedSizeBytes,
  expectedDestinationRevision
}
controller.database.protection.retention.inspect parameters: {}
controller.database.protection.retention.apply parameters: {
  retentionId, repositoryId, expectedDestinationRevision,
  expectedSnapshotSetRevision, forgetSnapshotIds
}
```

It accepts no database path, destination path, filename, password, browser-supplied repository, restic option, command, argument array, retention rule, moving selector, service name, download target, or remote endpoint. The retention apply operation receives only the fixed repository identity and revisions plus exact sorted snapshot ids selected by the server policy. The helper derives the source, repository path, password file, cache, tags, snapshot selector, and restore workspace. It retains `PrivateNetwork=true`; mounted storage I/O requires no process network socket.

## Manual recovery runbook

Recovery is intentionally not an in-product mutation in `0.40.0`. Perform it from a physical or SSH console only after selecting an exact retained protected record and retrieving its separately stored recovery password.

1. Keep a separate copy of the current live database family before replacement.
2. Stop the web service before changing controller state. The helper may remain stopped during the recovery.
3. Restore the recorded exact snapshot id from `/mnt/boxpilot-backup/restic-controller` into a new root-only recovery directory with restic `--verify`. Do not use a moving selector such as `latest`.
4. Verify that the restored `boxpilot.sqlite3` and `manifest.json` match both recorded SHA-256 values and that the database passes SQLite integrity and foreign-key checks in an isolated location.
5. Install only the verified standalone database as `/var/lib/boxpilot/boxpilot.sqlite3`, owned by `boxpilot:boxpilot` and mode `0600`. Remove or quarantine old WAL and shared-memory companions only while the service is stopped and only after the current state has been preserved.
6. Start the helper first and the web service second.
7. Inspect both units and BoxPilot health, then sign in and review the durable job ledger. A job captured mid-application must fail closed for operator review after restart.
8. Create and independently protect a new snapshot after recovery.

The exact restore procedure depends on the incident and the BoxPilot version being recovered. Do not overwrite production from the browser, do not restore while the web service is running, and do not use a lone raw main-file copy from a live WAL database.

## What `0.40.0` does not prove

- A local snapshot is not protected until its own independent restic record passes. A mounted USB disk is not offsite merely because it uses a different filesystem.
- The drill does not start a second BoxPilot service or attempt an owner login.
- The snapshot does not include the final successful record for itself because that record is written only after artifact verification completes.
- There is no schedule, recurrence, configurable retention value, browser download, remote or cloud adapter, notification, or automatic production restore. Retention can forget only exact references selected by the fixed policy and never runs restic prune.
- BoxPilot does not back up the source checkout, Tailscale account recovery, router configuration payloads, application credentials outside controller state, or the restic password.

Use the Disaster recovery kit and Action Center to track those separate recovery obligations.
