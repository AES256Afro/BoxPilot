# BoxPilot controller database backups

BoxPilot `0.38.0` adds a guarded local backup for its own SQLite controller state. It creates a transactionally consistent snapshot while BoxPilot remains online, verifies the artifact, opens and verifies a separate drill copy, writes a recovery manifest, and records durable evidence only after every check passes.

This is local recovery evidence, not complete disaster protection. The managed artifact remains on Bigbox and must be copied to encrypted independent storage to survive loss of the server.

## What the backup contains

The snapshot contains BoxPilot controller state, including owner password hashes, sessions, enrolled-agent identities, plans, approvals, jobs, audit events, migrations, router evidence, and backup records present when the snapshot is created. Treat the entire backup directory as sensitive.

The fixed locations are:

```text
Live source:      /var/lib/boxpilot/boxpilot.sqlite3
Backup root:     /var/lib/boxpilot-managed/backups/boxpilot-controller
Drill root:      /var/lib/boxpilot-managed/controller-restore-drills
Artifact:        <backup-uuid>/boxpilot.sqlite3
Manifest:        <backup-uuid>/manifest.json
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
9. From an SSH or physical console, copy the entire generated backup UUID directory to encrypted storage outside Bigbox. Preserve both `boxpilot.sqlite3` and `manifest.json` together.
10. Expand **Verification details** in the durable artifact row and verify the copied artifact and manifest SHA-256 values against the complete BoxPilot evidence before calling the independent copy usable.

Do not paste the owner password into chat, a terminal command, issue tracker, or log. BoxPilot accepts it only in the approval form and does not include it in the helper request.

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

The helper exposes only two typed operations:

```text
controller.database.backup.inspect  parameters: {}
controller.database.backup.create   parameters: { backupId: <server-generated UUID> }
```

It accepts no database path, destination path, filename, command, argument array, retention rule, selector, service name, download target, or remote endpoint. The helper retains `PrivateNetwork=true`; the workflow requires no network access.

## Manual recovery runbook

Recovery is intentionally not an in-product mutation in `0.38.0`. Perform it from a physical or SSH console only after selecting an exact backup and verifying its stored checksums.

1. Keep a separate copy of the current live database family before replacement.
2. Stop the web service before changing controller state. The helper may remain stopped during the recovery.
3. Verify that the chosen `boxpilot.sqlite3` matches its manifest checksum and passes SQLite integrity and foreign-key checks in an isolated location.
4. Install only the verified standalone database as `/var/lib/boxpilot/boxpilot.sqlite3`, owned by `boxpilot:boxpilot` and mode `0600`. Remove or quarantine old WAL and shared-memory companions only while the service is stopped and only after the current state has been preserved.
5. Start the helper first and the web service second.
6. Inspect both units and BoxPilot health, then sign in and review the durable job ledger. A job captured mid-application must fail closed for operator review after restart.
7. Create a new verified backup after recovery and replace the independent copy only after checking its hashes.

The exact restore procedure depends on the incident and the BoxPilot version being recovered. Do not overwrite production from the browser, do not restore while the web service is running, and do not use a lone raw main-file copy from a live WAL database.

## What `0.38.0` does not prove

- The artifact is not independent, encrypted by BoxPilot, offsite, or protected from Bigbox disk loss.
- The drill does not start a second BoxPilot service or attempt an owner login.
- The snapshot does not include the final successful record for itself because that record is written only after artifact verification completes.
- There is no schedule, recurrence, retention deletion, browser download, remote transport, cloud destination, notification, or automatic production restore.
- BoxPilot does not back up the source checkout, Tailscale account recovery, router configuration payloads, application credentials outside controller state, or the restic password.

Use the Disaster recovery kit and Action Center to track those separate recovery obligations.
