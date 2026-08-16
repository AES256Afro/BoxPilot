# Virtualization API

The BoxPilot `v1` virtualization API is loopback-only by default. Tailscale Serve may proxy it privately, but it is not an internet API. Version `0.19.0` requires an authenticated owner session for virtualization routes and a CSRF token for POST requests. Network privacy remains mandatory. Version `0.19.0` does not change the virtualization route contract.

All API responses use JSON and send `Cache-Control: no-store`.

## Redacted audit events

```text
GET /api/v1/audit?limit=100
```

The limit is constrained to `1-200`. Events are returned newest first. The older JSONL foundation records bounded `vm.plan.created` events and may contain historical lifecycle events from releases before `0.10.0`. Current lifecycle and snapshot attribution, approvals, steps, results, and failures live in the Operations Core SQLite job ledger. Tokens, command output, raw environment values, and guest secrets are excluded.

On the native systemd deployment, the JSONL file lives under `StateDirectory=boxpilot`. This is a live operational foundation, not the final owner-attributed and tamper-evident audit ledger.

## Health and capability discovery

```text
GET /api/v1/health
GET /api/v1/capabilities
```

Agents and interfaces should read capabilities before showing an operation. `vmCreationPlanning: validated-durable-approved` means supported plans can be staged as immutable jobs, but execution still requires separate password reauthentication.

## Host and domain discovery

```text
GET /api/v1/virtualization/status
GET /api/v1/virtualization/domains
GET /api/v1/virtualization/resources
GET /api/v1/virtualization/console-guidance
GET /api/v1/virtualization/setup-plan
```

`status`, `domains`, and `resources` are collected through fixed read-only helper scopes. The web service has no `libvirt` or `kvm` supplementary group. `status` reports host preflight, the fixed `qemu:///system` connection, lifecycle-action availability, and Tailscale information. `domains` reports guest state, resources, lease- and guest-agent-known addresses, disks, interfaces, bounded snapshot metadata, guest-agent availability, and filesystem-freeze state. `resources` reports libvirt networks and pools without changing either.

`console-guidance` uses a parameter-free helper operation to inspect only `cockpit.socket`. If Cockpit is already active and Tailscale reports a DNS name, the response includes an HTTPS port `9090` handoff on that private hostname. BoxPilot does not install, enable, reconfigure, authenticate to, or proxy Cockpit. Cockpit remains a separate security boundary.

A `503` from `domains` or `resources` is a structured discovery result when libvirt is unavailable. The web interface renders the partial result rather than treating the entire console as failed.

## VM planning options

```text
GET /api/v1/virtualization/planning-options
```

The response includes:

- Host CPU threads and memory
- Accepted vCPU, memory, and disk ranges
- Curated OS profiles
- The default NAT network
- UEFI and BIOS choices
- Regular non-empty `.iso` files from `BOXPILOT_ISO_DIRECTORY`
- A media-directory diagnostic when discovery fails

Directory entries, symbolic links, zero-byte files, files with unsafe names, and non-ISO files are excluded.

## Create a durable VM plan

```text
POST /api/v1/virtualization/plans
Content-Type: application/json
```

Example request:

```json
{
  "name": "ubuntu-lab",
  "osProfile": "ubuntu-24.04",
  "vcpus": 2,
  "memoryMiB": 4096,
  "diskGiB": 40,
  "isoFile": "ubuntu-24.04.iso",
  "network": "default",
  "firmware": "uefi",
  "autostart": false
}
```

A successful response contains:

- A durable plan id, immutable revision, draft status, and expiration time
- A separate adapter revision tied to normalized inputs, ISO name, ISO size, ISO modification time, media root, and libvirt URI
- `executable` and `stageable` capability flags
- `requiresRestrictedHelper: true`
- Capacity and OS-profile warnings
- A program plus argument array and a display-only `virt-install` preview
- Required execution guardrails

The route rejects invalid types and ranges, path traversal, unlisted media, an existing domain name, a non-default network, incompatible Windows 11 firmware, and a disk larger than reported free space in the default pool.

The planning route does not execute the display string. Clients must never execute it themselves.

## Stage a VM creation job

```text
POST /api/v1/virtualization/plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging requires the plan owner, exact revision, unexpired draft status, executable profile, unchanged plan inputs and managed ISO metadata, no exact-name domain, an active default NAT network, and an active default storage pool with sufficient reported space. A successful response contains an `awaiting_approval` job. It performs no host mutation.

Approve that job through the Operations Core approval route with the owner password. Approval revalidates the host again and sends only the nine fixed typed VM fields to `virtualization.domain.create` over the helper Unix socket. The protocol rejects extra `program`, `arguments`, `path`, URI, or unknown fields.

## Create a durable lifecycle plan

```text
POST /api/v1/virtualization/domains/:name/action-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "action": "shutdown" }
```

Accepted action values are:

- `start`
- `shutdown`
- `reboot`
- `autostart-on`
- `autostart-off`

The response is an immutable draft with exact expected power and autostart state, desired state, changes, recovery, expiration, and revision. The planner rejects an action that is invalid for current state and rejects no-op autostart changes.

## Stage a lifecycle job

```text
POST /api/v1/virtualization/action-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging requires the plan owner, exact revision, unexpired draft, matching domain state, and matching autostart state. It returns an `awaiting_approval` job without mutating the VM. Approval uses the ordinary password reauthentication route. The helper accepts only `name`, `action`, `expectedState`, and `expectedAutostart`, rechecks them independently, maps the action to a fixed local `virsh` argument array, and reads back post-operation state.

There is no `destroy`, force-off, delete, XML edit, snapshot mutation through the lifecycle route, storage mutation, bridge mutation, command string, arbitrary action, libvirt URI, argument array, or executable-selection input. Reboot verification proves request acceptance and a running libvirt state, not guest application health.

## Create a guarded offline snapshot plan

```text
POST /api/v1/virtualization/domains/:name/snapshot-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "snapshotName": "pre-upgrade" }
```

Planning requires an exact managed persistent domain that is stopped, a UUID, available snapshot inventory, no duplicate snapshot name, and at least one file-backed disk under `/var/lib/libvirt/images`. The immutable response records the domain UUID, stopped state, a SHA-256 revision of existing snapshot names, disk targets, exact changes, warnings, and manual recovery guidance. It labels consistency as `offline-consistent` and `independentBackup` as `false`.

## Stage an offline snapshot job

```text
POST /api/v1/virtualization/snapshot-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and password approval recheck the exact domain UUID, stopped state, snapshot-name absence, and existing snapshot revision. The helper additionally derives disk paths from libvirt, confines every disk to the managed image root, uses `lstat` to reject symlinks and non-files, uses fixed `qemu-img info --output=json` arguments to require unchained qcow2 disks, and constructs one fixed atomic `virsh snapshot-create-as` request. Verification requires the new snapshot to be current, internal, and associated with a stopped guest state.

There is no operator-supplied path, description, program, argument array, online or memory snapshot, quiesce request, revert, delete, or metadata-only cleanup. If post-create verification fails, BoxPilot leaves the VM stopped and requires inspection instead of guessing at a destructive rollback. Snapshots are never counted as independent backups.

## List stopped-VM export evidence

```text
GET /api/v1/virtualization/exports
```

This returns durable metadata for completed exports: server-generated id, domain identity, fixed destination type, root-owned artifact reference, manifest SHA-256, size, encryption flag, protection flag, restore-drill evidence, and creation time. Local export records report `destination: local-managed`, `encrypted: false`, `protected: false`, and `restoreDrill.passed: false` even when a later independent restic record refers to the export.

## Create a stopped-VM export plan

```text
POST /api/v1/virtualization/domains/:name/export-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

The body is empty. Planning requires an exact managed persistent domain that is stopped, an exact UUID, available snapshot inventory, and at least one regular unchained qcow2 disk confined to `/var/lib/libvirt/images`. The helper reports source allocated bytes and fixed-destination free space. The immutable plan records disk and snapshot inventory revisions, required capacity, exact changes, verification, warnings, and cleanup scope.

The browser cannot select or supply a source path, destination path, output filename, binary, libvirt URI, qemu-img argument, manifest field, encryption flag, or protection flag.

## Stage a stopped-VM export job

```text
POST /api/v1/virtualization/export-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and password approval recheck domain UUID, persistent stopped state, disk topology, snapshot inventory, and capacity. The approved job starts in the background so the HTTP request does not wait for disk conversion. Read-only helper inventory remains available, while helper mutations remain serialized. A six-hour typed-operation timeout applies only to the export.

The helper creates one new directory under `/var/lib/boxpilot-managed/vm-exports/<server-generated-uuid>`, dumps inactive XML, converts each source disk to standalone qcow2, runs `qemu-img check`, compares source and output content, and records SHA-256 checksums in a manifest. Failure removes only that new export directory and never changes the source domain or source disks. Success is an integrity-verified local artifact, not a protected backup. A service restart marks an in-progress web job failed for operator review and never automatically repeats it.

## Inspect VM protection destination and evidence

```text
GET /api/v1/virtualization/protection
```

The response contains one fixed `mounted-restic` destination inspection and durable completed-copy records. Destination evidence includes readiness, restic version, exact mount metadata, independent-filesystem status, repository id, destination revision, free bytes, structured blockers, and the fixed terminal setup command. It never returns the repository password or password-file contents.

Completed records contain the server-generated backup id, source export id, domain identity, repository and snapshot ids, size, encryption, independence, full repository-read verification, restore-drill evidence, protection state, retained state, and optional retention-run reference. A new copy reports `protected: false`, `restoreDrill.passed: false`, and `retained: true`. Version `0.14.0` changes only that exact record to `protected: true` after strict passing restore-drill evidence is committed. Version `0.16.0` preserves a forgotten record but changes its derived retained state to false after exact retention evidence is committed.

## Create an encrypted independent-copy plan

```text
POST /api/v1/virtualization/exports/:id/protection-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

The body is empty. Planning requires a durable local unencrypted export, the fixed restic binary, an exact writable mount at `/mnt/boxpilot-backup`, a filesystem device different from local exports and VM images, a root-owned mode-`0600` non-symlink password file, an initialized readable repository, and at least the export size plus 1 GiB free.

The immutable input contains only server-generated ids, domain identity, expected manifest checksum, expected logical size, and a destination revision. It contains no path, mount, repository, password, tag, binary, command, or arbitrary restic argument. The output includes exact changes, verification, blockers, warnings, and recovery guidance.

## Stage an encrypted independent-copy job

```text
POST /api/v1/virtualization/protection-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and password approval recheck the local export evidence, exact repository identity, independent mount identity, and capacity. The approved operation runs in the background with a twelve-hour typed-operation timeout. Helper mutations remain serialized.

The helper rehashes the local manifest and all files, creates one tagged restic snapshot, requires an exact JSON summary, performs a full-repository `check --read-data`, and reads back the exact snapshot path and tags. The full check is compatible with Ubuntu 26.04's restic 0.18.1 package and can become slower as the repository grows. This operation cannot invoke `forget`, `prune`, repository deletion, an operator-selected destination, or an operator-selected restore. Failure never changes the local export and never automatically deletes repository data.

## Inspect guarded VM retention

```text
GET /api/v1/virtualization/retention
```

The response contains the fixed policy, exact currently eligible candidates, keep reasons, repository snapshot count, blockers, warnings, verification requirements, and completed retention runs. The fixed policy keeps three active copies per domain UUID, every copy under 30 days old, every copy without passing restore-drill evidence, and every backup referenced by a recovery clone. Unattributed or missing repository evidence blocks execution.

## Create a guarded VM retention plan

```text
POST /api/v1/virtualization/retention-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

The body is empty. The immutable input contains a server-generated retention id, exact repository id, destination revision, complete BoxPilot-tagged snapshot-set revision, and one to 100 sorted full snapshot ids. The output lists exact durable backup candidates, every keep reason, changes, warnings, verification, and no-prune recovery boundary.

The browser cannot select a repository, path, password, tag, age, count, keep rule, snapshot selector such as `latest`, restic binary, arbitrary argument, or prune behavior.

## Stage a guarded VM retention job

```text
POST /api/v1/virtualization/retention-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and high-risk password approval recompute the policy and require the exact same candidates, repository identity, destination revision, snapshot-set revision, protection evidence, ages, minimum-copy floors, and recovery references. The background helper forgets only the approved full ids and never runs prune. It then runs `restic check --read-data`, proves every selected id absent and every noncandidate id present, and atomically records the run plus forgotten-record relationships.

The response does not claim reclaimed bytes. `prunePerformed` and `spaceReclaimed` are both false. Forgotten records cannot be used for a new restore drill or recovery clone.

If a full or partial forget is confirmed but subsequent repository verification fails, Operations Core records the confirmed forgotten ids before marking the job failed. The retention run reports `repositoryVerified: false`, `complete` for the requested forget set, and bounded verification reason codes. Clients must treat every recorded member as unavailable regardless of the job's terminal state.

## Create an isolated restore-drill plan

```text
POST /api/v1/virtualization/backups/:id/restore-drill-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

The body is empty. Planning requires an unprotected completed backup with encrypted, independent, full-repository verification evidence plus its unchanged local export record. The helper rechecks repository identity, exact mount state, free temporary capacity, generated domain-name availability, and generated UEFI-state availability.

The immutable input contains only the server-generated drill, backup, and export ids; domain identity; repository and snapshot ids; expected manifest SHA-256 and size; and destination revision. The output fixes `network: "none"`, `transient: true`, 2 vCPUs, 2048 MiB, blockers, exact changes, verification, warnings, and recovery behavior.

## Stage an isolated restore-drill job

```text
POST /api/v1/virtualization/restore-drill-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and password approval recheck durable backup and export identity, repository revision, capacity, domain-name absence, and UEFI-state absence. The approved operation runs in the background with a twelve-hour typed-operation timeout. Helper mutations remain serialized.

The helper restores only the exact recorded snapshot into a fixed server-generated workspace, verifies every file and qcow2 structure, temporarily grants QEMU access to verified disk files, and imports a transient no-network domain. A passing result must include repeated guest-agent health plus verified domain, workspace, QEMU permission, and UEFI NVRAM cleanup. Only then does Operations Core atomically promote the exact backup record to protected. A failure cannot promote protection and preserves root-only restored files for inspection.

## List guarded recovery clones

```text
GET /api/v1/virtualization/recoveries
```

The response contains durable records only for completed recovery-clone jobs. Each record ties one protected backup to a separate libvirt domain UUID and reports the fixed destination type, size, stopped state, no-network policy, disabled autostart, operator, and creation time. It never returns a repository password, filesystem path, or domain XML.

## Create a guarded recovery-clone plan

```text
POST /api/v1/virtualization/backups/:id/recovery-plans
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "targetDomainName": "ubuntu-lab-recovery" }
```

Planning requires a protected encrypted independent backup with complete passing restore-drill evidence, its unchanged local export record, the exact repository and snapshot identities, sufficient restore capacity, an available constrained target domain name, and an unused server-generated recovery directory. The target name is the only operator-selected recovery field. It cannot use the reserved `boxpilot-drill-` namespace.

The immutable plan fixes 2 vCPUs, 2048 MiB, the source firmware mode, `network: "none"`, `persistent: true`, `initialState: "stopped"`, and `autostart: false`. The browser cannot supply a disk path, recovery root, XML, UUID, network, firmware path, repository, snapshot, command, binary, or libvirt argument.

## Stage a guarded recovery-clone job

```text
POST /api/v1/virtualization/recovery-plans/:id/stage
Content-Type: application/json
X-BoxPilot-CSRF: <session CSRF token>
```

Body:

```json
{ "revision": "immutable-plan-revision" }
```

Staging and password approval recheck the exact protected evidence, repository revision, capacity, target-name absence, and fixed destination. The background helper restores and verifies the exact snapshot in staging, moves the verified export under `/var/lib/libvirt/images/boxpilot-recoveries/<server-generated-uuid>`, grants persistent QEMU access only to recovered qcow2 disks, generates fixed no-network XML, and defines a new persistent domain. It then verifies a new UUID, stopped state, disabled autostart, zero interfaces, exact disk paths, and the guest-agent channel.

The operation never starts the recovered guest. The operator can later use the ordinary separately approved Start action and private Cockpit handoff for inspection. Network attachment is unavailable. Before definition, failures preserve root-only staging evidence. After definition begins, automatic cleanup can undefine only the exact newly named stopped no-network domain and remove only its server-generated directory after strict path validation. A crash after definition can leave a stopped isolated clone for manual inspection instead of guessing that deletion is safe.

## Agent integration rules

An agent integrating with BoxPilot should:

1. Read capabilities before proposing an operation.
2. Treat `executable: false` as a hard stop, not a suggestion.
3. Present server validation errors verbatim and ask the operator to correct the plan.
4. Never copy a display command into a shell automatically.
5. Never request or invent VM credentials, guest secrets, or unlisted helper fields.
6. Refresh host and domain state immediately before requesting a lifecycle action.
7. Explain when a guest address is unknown rather than inventing one.
8. Treat a local VM export and a repository-verified encrypted copy as unprotected until the API reports a passed isolated restore drill.
9. Treat a recovery clone as isolated and non-production until an operator separately inspects and starts it. Never infer that network attachment is available.
10. Treat `retained: false` as historical evidence, not a usable snapshot, and never offer restore or recovery from it.
11. Keep bridge, passthrough, storage, online snapshot, snapshot revert/delete, in-place restore, recovery network attachment, restic prune, and force-off operations unavailable until their capability appears explicitly.
