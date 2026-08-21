# Guarded migration discovery and local staging

BoxPilot `0.17.0` combines the sanitized source-manifest foundation from `0.8.0` with the first executable migration slice: a root-only, checksummed Compose-project bundle can be copied or safely resumed from a fixed local inbox into isolated managed staging. This release never activates the staged workload and never changes or deletes the source.

## Trust boundaries

The browser may choose only an opaque bundle UUID that the helper already discovered. It cannot provide:

- A source or destination path
- A command, binary, argument list, SSH target, username, or credential
- A file name, file count, checksum, overwrite flag, or deletion flag
- A Compose project, service, port, route, network, or activation instruction

The root helper owns both fixed roots:

- Inbox: `/var/lib/boxpilot-migration/inbox`
- Managed staging: `/var/lib/boxpilot-managed/migration-staging`

Both are mode `0700` systemd state directories. The browser receives only bundle identity, workload name, source fingerprint, Compose filename, revision, file count, sensitive-name count, byte totals, destination state, and blockers. It never receives bundled file paths or contents.

## Source manifest workflow

1. Sign in to the source BoxPilot node.
2. Open Migration Center.
3. Download `boxpilot-migration-source-manifest.json`.
4. Sign in to the destination BoxPilot node.
5. Paste the manifest into Migration Center.
6. Validate and import it.
7. Create a destination compatibility plan.

Export is a read-only inventory operation. Import never contacts the source.

The sanitized manifest contains host and capacity summaries, selected service state, Docker object summaries, and a declaration of excluded classes. It excludes environment variables, labels, commands, mount paths, Compose paths, Tailscale peers, and credentials. The destination reconstructs a bounded allowlisted object and recomputes its canonical SHA-256 fingerprint. Added secret-shaped fields are discarded; changed allowlisted content invalidates the fingerprint.

## Prepare a Compose bundle

Run the pack tool from a trusted terminal on the machine that can read the Compose project. Copy the exact `fingerprint` value from the downloaded sanitized source manifest:

```bash
cd /opt/boxpilot
sudo node scripts/boxpilot-migration-pack.mjs \
  --source /absolute/path/to/compose-project \
  --name workload-slug \
  --source-fingerprint sha256:REPLACE_WITH_64_HEX_CHARACTERS
```

The source directory must contain exactly one supported root Compose filename: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, or `docker-compose.yml`.

The packer:

- Rejects symlinks, hard links, devices, sockets, unsafe paths, reserved metadata names, unsupported file types, and changing source content
- Accepts at most 10,000 regular files and 500 GiB per bundle
- Copies into a generated partial directory with mode `0700` directories and mode `0600` files
- Hashes the source before and after each copy and hashes the copy
- Rescans the complete source inventory before publishing the bundle UUID
- Labels secret-sensitive names in the root-only manifest without returning paths or contents to the browser
- Preserves the original source tree

For a local the server workload, the completed bundle immediately appears in Migration Center. For a remote source, an administrator may transport the complete UUID directory into the fixed destination inbox using an out-of-band tool. BoxPilot `0.17.0` does not manage that remote transport, credentials, or SSH session. It fully revalidates the landed bundle before offering a plan.

## Plan, approve, and stage

1. Refresh Migration Center.
2. Confirm the bundle matches the imported source hostname and fingerprint.
3. Select **Plan staged transfer** or **Plan safe resume**.
4. Review the immutable content revision, counts, sizes, sensitive-name count, exact changes, verification list, warnings, and recovery guidance.
5. Select **Stage transfer for approval**.
6. Open Operations, review the durable job, and re-enter the owner password.
7. Let the background helper copy and verify the bundle.
8. Refresh Migration Center and confirm a durable **Checksums verified**, **Source preserved**, **Not activated** record.

Approval is invalidated if the bundle, imported source, destination contents, or remaining-byte evidence changes.

Inbox inspection is serialized with transfer mutations and re-hashes the complete source and any existing final destination files. Large bundles can take substantial time to appear or revalidate. BoxPilot favors fresh content evidence over a fast cached result in this release.

## Resume and restart recovery

Each destination is derived from the server-validated bundle UUID. The helper never overwrites a conflicting final file. On a new plan it hashes already staged files and skips only those matching the immutable source manifest. Missing files are copied through exact `.boxpilot-part` temporary names and atomically renamed after SHA-256 verification.

If the helper finished copying but BoxPilot restarted before SQLite recorded success, Migration Center reports a reconciliation-required completed staging tree. A new immutable plan re-reads every source and destination checksum and records the missing durable result without copying or activating files.

Partial and completed staging trees remain isolated. No Compose command is run. No container, port, network, DNS record, reverse proxy, router, or Tailscale route is changed.

## Durable evidence

Completed transfer records contain:

- Transfer and bundle UUIDs
- Imported source record and fingerprint
- Immutable content revision
- Sanitized workload name
- Logical server-owned destination identifier
- File count and total bytes
- Content-verification, source-preservation, and activation flags
- Owner attribution and completion time

Paths and secret contents are not stored in Operations Core.

## Authenticated API

All routes require an owner session. POST routes also require `X-BoxPilot-CSRF`. The browser never submits a filesystem path.

- `GET /api/v1/migrations/export-manifest`: export the current sanitized source manifest
- `GET /api/v1/migrations/sources`: list imported source records
- `POST /api/v1/migrations/sources/import`: validate and import one sanitized manifest
- `POST /api/v1/migrations/sources/:id/plans`: create an evidence-only compatibility plan
- `GET /api/v1/migrations/bundles`: inspect valid and invalid fixed-inbox bundles and list durable completed transfers
- `POST /api/v1/migrations/bundles/:id/transfer-plans`: create an immutable copy, resume, or reconciliation plan for one helper-discovered UUID
- `POST /api/v1/migration-transfer-plans/:id/stage`: revalidate and create an awaiting-approval background job
- `GET /api/v1/migrations/transfers`: list durable verified staging records
- `POST /api/v1/jobs/:id/approve`: reauthenticate and start the staged job

## Compatibility planning

The earlier compatibility plan remains evidence-only. It reports CPU architecture differences, destination Docker availability, container-name collisions, published host-port collisions, and a root-capacity warning. It does not make the new local bundle transfer executable by itself. The exact source fingerprint must also match a valid bundle in the fixed inbox.

## Still unavailable

Version `0.17.0` cannot:

- Discover or transport a non-BoxPilot source over SSH
- Store SSH credentials or private keys
- Parse the staged Compose YAML with a complete policy engine
- Capture live Docker named volumes or application-consistent database dumps automatically
- Start the destination workload in an isolated network
- Change DNS, reverse-proxy, router, or Tailscale routes
- Stop, alter, or delete the source
- Activate, cut over, or delete a staged bundle

Those operations require source-specific adapters, isolated application health checks, verified backup coverage, downtime measurement, and a separately approved rollback-capable cutover.
