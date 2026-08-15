# Virtualization API

The BoxPilot `v1` virtualization API is loopback-only by default. Tailscale Serve may proxy it privately, but it is not an internet API. Version `0.11.0` requires an authenticated owner session for virtualization routes and a CSRF token for POST requests. Network privacy remains mandatory.

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

## Agent integration rules

An agent integrating with BoxPilot should:

1. Read capabilities before proposing an operation.
2. Treat `executable: false` as a hard stop, not a suggestion.
3. Present server validation errors verbatim and ask the operator to correct the plan.
4. Never copy a display command into a shell automatically.
5. Never request or invent VM credentials, guest secrets, or unlisted helper fields.
6. Refresh host and domain state immediately before requesting a lifecycle action.
7. Explain when a guest address is unknown rather than inventing one.
8. Keep bridge, passthrough, storage, online snapshot, snapshot revert/delete, and force-off operations unavailable until their capability appears explicitly.
