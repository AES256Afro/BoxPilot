# Virtualization API

The BoxPilot `v1` virtualization API is loopback-only by default. Tailscale Serve may proxy it privately, but it is not an internet API. Version `0.9.1` requires an authenticated owner session for virtualization routes and a CSRF token for POST requests. Network privacy remains mandatory.

All API responses use JSON and send `Cache-Control: no-store`.

## Redacted audit events

```text
GET /api/v1/audit?limit=100
```

The limit is constrained to `1-200`. Events are returned newest first. Current event types are `vm.plan.created`, `vm.action.requested`, `vm.action.completed`, and `vm.action.failed`. Plan events include normalized resource counts, ISO basename, revision, and warning count. Lifecycle events include only domain, allowlisted action, result type, and reported state. Tokens, command output, raw environment values, and guest secrets are excluded.

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
GET /api/v1/virtualization/setup-plan
```

`status` reports host preflight, the fixed `qemu:///system` connection, lifecycle-action availability, and Tailscale information. `domains` reports guest state, resources, lease-known addresses, disks, interfaces, and snapshot count. `resources` reports libvirt networks and pools without changing either.

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

## Guarded lifecycle request

```text
POST /api/v1/virtualization/domains/:name/actions
Authorization: Bearer <administrator token>
Content-Type: application/json
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

The route exists only when `BOXPILOT_VM_ACTIONS_ENABLED=true` and `BOXPILOT_ADMIN_TOKEN` contains at least 32 characters. It maps the validated action and domain name to a fixed `virsh` argument array. There is no `destroy`, delete, XML edit, snapshot mutation, storage mutation, bridge mutation, command string, or executable-selection input.

## Agent integration rules

An agent integrating with BoxPilot should:

1. Read capabilities before proposing an operation.
2. Treat `executable: false` as a hard stop, not a suggestion.
3. Present server validation errors verbatim and ask the operator to correct the plan.
4. Never copy a display command into a shell automatically.
5. Never persist the lifecycle bearer token in prompts, logs, browser storage, or plan data.
6. Refresh host and domain state immediately before requesting a lifecycle action.
7. Explain when a guest address is unknown rather than inventing one.
8. Keep bridge, passthrough, storage, snapshot, and force-off operations unavailable until their capability appears explicitly.
