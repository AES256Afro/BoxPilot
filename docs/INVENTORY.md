# Sanitized live inventory

BoxPilot `0.7.0` replaces the demonstration overview with authenticated host, service, network, Docker, and log inventory. Every collector is bounded so discovery does not become arbitrary command execution.

## Host inventory

`GET /api/v1/inventory` reports:

- Hostname, operating-system name, kernel, architecture, and uptime
- CPU count, model, load averages, and normalized one-minute load
- Total, used, and free memory
- Root-filesystem capacity and usage
- Non-loopback IPv4 addresses and interface names
- Tailscale connection state and the local device DNS name
- Load, active, substate, and enablement for a fixed service list

Tailscale peer records and control-plane secrets are never returned.

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

The browser-generated support bundle now includes this sanitized live inventory plus the existing redacted virtualization audit when available. It does not include raw journals, environment variables, Docker labels, commands, mount sources, or Tailscale peers.

## Network and DNS topology

Version `0.18.0` adds a separate authenticated `GET /api/v1/network/topology` response with fixed default-route, systemd-resolved, port 53 listener, LAN-address, and Tailscale self-state collectors. It excludes neighbor tables, MAC addresses, process details, router sessions, and credentials. See [Network and DNS Center](NETWORK.md) for the returned fields and no-change assessment boundary.
