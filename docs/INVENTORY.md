# Sanitized live inventory

BoxPilot `0.7.0` replaced the demonstration overview with authenticated host, service, network, Docker, and log inventory. Version `0.30.1` adds sanitized host-mount and block-device topology, a separate fixed root-only storage evidence timer, and a server-generated support bundle with a final configurable redaction pass. Version `0.31.0` adds a separately named exact `smartmontools` repair. Version `0.32.0` adds mounted ext4 kernel error counters to the same fixed evidence document. Every collector remains bounded so discovery does not become arbitrary command execution.

## Host inventory

`GET /api/v1/inventory` reports:

- Hostname, operating-system name, kernel, architecture, and uptime
- CPU count, model, load averages, and normalized one-minute load
- Total, used, and free memory
- Root-filesystem capacity and usage
- Real filesystem mounts with capacity state, safe option names, read-only state, sanitized source and target, and fail-closed ext4 error-counter evidence
- Block-device topology without serial numbers, UUIDs, labels, or raw udev properties
- Bounded SMART health fields from a separate root-only timer when current evidence exists
- Non-loopback IPv4 addresses and interface names
- Tailscale connection state and the local device DNS name
- Load, active, substate, and enablement for a fixed service list

Tailscale peer records and control-plane secrets are never returned.

## Storage and filesystem evidence

The root-only storage timer runs a fixed no-input `findmnt` command against `/proc/1/mountinfo`. This reports the host mount namespace instead of the hardened web service's private namespace. The web process runs only the fixed `lsblk` topology command and reads the timer's allowlisted evidence file. The caller cannot provide an output field, device, path, filter, executable, or argument. The response contains at most 128 host mounts and 256 topology entries.

Mount sanitization:

- Allows only capacity numbers, filesystem type, read-only state, and a fixed set of option names
- Removes every mount option value, including usernames, passwords, and arbitrary values
- Returns an exact source only for a bounded local `/dev` form; network and unfamiliar sources become `[remote-or-virtual-source]`
- Replaces `/root`, `/home/<name>`, and `/run/user/<id>` targets with fixed redacted forms
- Marks capacity `warning` at 85 percent and `critical` at 95 percent

Filesystem error evidence is separate from capacity. For each mounted ext4 source, the timer runs fixed `lsblk --noheadings --nodeps --output KNAME <derived-local-source>` arguments, accepts only one bounded kernel name, and reads only `/sys/fs/ext4/<kernel-name>/errors_count`. A zero counter is `healthy`; a nonzero counter is `critical`; a missing or invalid counter is `unavailable`. Non-ext4 filesystems are `unsupported`, not healthy. The collector does not run `fsck`, `e2fsck`, `tune2fs`, unmount, remount, or write a kernel or filesystem setting.

Block sanitization includes device name, parent, type, filesystem, size, sanitized mount targets, rotational and read-only state, transport, and model. It does not request or return serial, WWN, UUID, partition UUID, filesystem label, udev property, or raw command output.

### SMART scanner boundary

`boxpilot-storage-scan.service` is a separate root-only oneshot started by `boxpilot-storage-scan.timer` every six hours. It has no HTTP endpoint, browser action, helper-protocol operation, request body, or user-selected device. It:

1. Checks only the fixed `/usr/sbin/smartctl` binary.
2. Discovers at most 16 whole disks with fixed `/usr/bin/lsblk` arguments.
3. Accepts only common local disk names such as `/dev/nvme0n1` and `/dev/sda`.
4. Calls only `smartctl --json=c --all <discovered-device>`.
5. Writes only passed state, temperature, power-on hours, NVMe life used, critical-warning count, media errors, unsafe shutdowns, a derived health state, and the separately bounded filesystem error evidence described above.

The evidence excludes serials, UUIDs, firmware, raw output, stderr, arbitrary attributes, and command arguments. The web service treats missing, malformed, more than 24-hour-old, or future-dated evidence as unavailable or stale. It never turns collector failure into a healthy claim.

The timer itself never installs `smartmontools`. Until the package and timer are present, Overview honestly reports `smartctl not installed` or missing evidence. BoxPilot `0.31.0` exposes a separate durable Repair Center plan for only the fixed configured `smartmontools` candidate. It requires staging, password approval, exact-version revalidation, the static `boxpilot-smartmontools-install.service`, and a fresh scan. The inventory route cannot trigger it. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

## Docker inventory

The web process remains outside the Docker group. It sends the no-parameter `container.docker.inventory` operation through the restricted helper.

The response includes sanitized containers, images, networks, volumes, and Compose project status. It excludes:

- Environment variables
- Labels
- Container commands
- Host mount sources and volume mountpoints
- Compose file paths
- Raw Docker inspect output

The UI can show names, images, states, published-port summaries, network names, repository tags, digests, resource drivers, and project status.

## Redacted service logs

`GET /api/v1/logs` supports exactly four source names:

- `boxpilot`
- `docker`
- `tailscale`
- `virtualization`

Each name maps to a fixed systemd unit set inside the helper. The caller can select only a result limit from 1 through 200. It cannot provide a unit, journal field, time expression, executable, or additional argument.

Returned entries contain timestamp, unit, numeric priority, and a message capped at 500 characters. Control characters are removed. Values following common token, password, secret, API-key, and authorization labels are replaced with `[REDACTED]`. URL query strings are removed.

Redaction reduces accidental disclosure but is not a proof that every possible application-specific secret format is recognized. Do not treat the log endpoint as safe for internet exposure. Keep BoxPilot private behind Tailscale Serve with Funnel off.

## Support bundle

`GET /api/v1/support-bundle` is authenticated and server-generated. It independently collects only:

- Sanitized live inventory
- Prerequisite checks
- Local Action Center evidence
- Up to 100 existing bounded audit events
- Up to 50 entries from each fixed BoxPilot, Docker, Tailscale, and virtualization log source

One collector failure does not hide the others. A failed source is recorded only as `unavailable`; thrown error text is not included.

The final recursive redaction pass always removes sensitive field names, secret assignments, bearer values, private-key blocks, URL query strings, control characters, cycles, excessive depth, and oversized collections. It then applies optional site-specific rules from the exact file `/etc/boxpilot/redaction.json`.

Site policy supports only:

- Up to 32 exact literals, each 4 through 128 characters
- Up to 32 absolute path prefixes, each 2 through 256 characters

It accepts no regex, wildcard, replacement string, command, alternate configuration path, or browser-provided rule. Invalid policy fails closed to the built-in rules. The support response reports only policy status and rule counts, never the configured values.

Start from `deploy/redaction.example.json`, keep the installed file readable only by the BoxPilot administrator and service, and restart BoxPilot after changing its environment path. The shipped native environment fixes the path to `/etc/boxpilot/redaction.json`.

The bundle is support evidence, not a backup. It excludes the SQLite database, backup payloads, configuration files, environments, credentials, Tailscale peers, arbitrary commands, arbitrary journal units, and raw SMART output.

## Network and DNS topology

Version `0.18.0` adds a separate authenticated `GET /api/v1/network/topology` response with fixed default-route, systemd-resolved, port 53 listener, LAN-address, and Tailscale self-state collectors. It excludes neighbor tables, MAC addresses, process details, router sessions, and credentials. See [Network and DNS Center](NETWORK.md) for the returned fields and no-change assessment boundary.
