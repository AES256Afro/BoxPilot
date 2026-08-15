# Read-only migration discovery

BoxPilot `0.8.0` introduces a deliberately non-executing migration foundation. Source discovery uses a portable, fingerprinted BoxPilot manifest rather than SSH credentials.

## Source workflow

1. Sign in to the source BoxPilot node.
2. Open Migration Center.
3. Download `boxpilot-migration-source-manifest.json`.
4. Sign in to the destination BoxPilot node.
5. Paste the manifest into Migration Center.
6. Validate and import it.
7. Create a destination compatibility plan.

Export is a read-only inventory operation. Import never contacts the source.

## Manifest boundary

The manifest contains only:

- Hostname, operating-system name, kernel, architecture, and uptime
- CPU, memory, and root-capacity totals
- Non-loopback IPv4 addresses and the source Tailscale self-name
- Selected service state
- Sanitized Docker containers, images, networks, volumes, and project status
- A declaration of excluded sensitive field classes

It excludes environment variables, labels, commands, mount paths, Compose file paths, Tailscale peers, and credentials.

The destination does not trust the supplied shape. It reconstructs a new bounded object from the allowlisted fields, applies array and string limits, discards extra fields, and recomputes SHA-256 over canonical JSON. A changed or incomplete manifest is rejected when its fingerprint does not match.

## Compatibility plan

The destination compares the imported snapshot with live destination inventory and currently reports:

- CPU architecture differences
- Destination Docker availability
- Container-name collisions
- Published host-port collisions
- A root-capacity warning that requires per-workload sizing later

Every compatibility plan is immutable and stored in Operations Core. `executable` remains `false` even when no blocker is found.

## Not implemented

This release cannot:

- Discover a non-BoxPilot source over SSH
- Store SSH credentials or private keys
- Calculate volume or database transfer sizes
- Transfer or resume data
- Start destination workloads in isolation
- Change DNS, reverse-proxy, router, or Tailscale routes
- Stop, alter, or delete the source

Future transfer work must preserve the source, checksum every transferred object, resume without recopying verified blocks, test the destination in isolation, and require approval before cutover.
