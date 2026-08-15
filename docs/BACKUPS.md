# Verified application backups

BoxPilot `0.6.0` provides one deliberately narrow backup adapter for its managed Uptime Kuma deployment. It does not report a workload as protected merely because a file was copied.

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

## Current limitation

The only destination is on Bigbox. This proves consistency, integrity, and restorability but does not protect against loss of the Bigbox disk or host. NAS, restic, encrypted offsite, scheduling, retention, notification, Keel Notes export, PostgreSQL, and Litestream-aware adapters remain future milestones.
