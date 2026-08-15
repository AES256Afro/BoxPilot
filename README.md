# BoxPilot

BoxPilot is an early, safety-first control plane for an Ubuntu home server. The long-term product is a guided interface for applications, backups, logs, imports, migrations, Docker workloads, routers, agents, and virtual machines over a private LAN or Tailscale connection.

## Current status

Version `0.3.0` is a host-aware prototype, not a complete server manager. Its QEMU/KVM module has real read-only collectors and server-side VM plan validation when BoxPilot runs natively on Linux. Most other product areas are workflow mockups with visibly labeled sample data.

### What works now

| Area | Status in `0.3.0` | Capability |
| --- | --- | --- |
| Health and capabilities API | Live | Reports release mode and available product boundaries. |
| QEMU/KVM preflight | Live on the native host | Checks Linux, `/dev/kvm`, QEMU, `virsh`, `virt-install`, `qemu:///system`, service-user groups, the default NAT network, the default storage pool, and Tailscale access. |
| VM and libvirt inventory | Live on the native host | Lists domains, state, CPU, memory, autostart, lease-reported addresses, disks, interfaces, snapshot count, networks, and storage pools. |
| VM creation planner | Validated read-only | Discovers regular ISO files in one managed directory, validates fields on the server, checks name collisions and reported pool space, and renders a non-executing `virt-install` argument preview. |
| VM lifecycle controls | Provisional and off by default | Can request start, graceful shutdown, reboot, and autostart through fixed `virsh` argument arrays after an operator enables the route and supplies a token. |
| VM event log | Limited live foundation | Writes and displays redacted JSONL events for VM plans and enabled lifecycle requests. It is not the final authenticated job ledger. |
| Compose inspector | Browser-only preview | Performs a lightweight structural and risk scan. It is not a full YAML parser and cannot deploy. |
| Support bundle | Browser-generated preview | Downloads release metadata and available redacted VM audit events. It is not yet a general host support bundle. |
| Overview, apps, backups, migrations, and settings | UI demonstration | Shows the intended operator workflow using sample data. These pages do not collect or change host state. |
| Docker deployment | Safe preview | Runs loopback-only without capabilities, host mounts, or the Docker socket. This container cannot inspect host libvirt. |

The repository also includes a read-only Ubuntu deployment doctor and a USB-to-headless installation runbook.

### Not implemented yet

- VM plan application, VM creation, delete, force-off, console, snapshot mutation, bridge creation, passthrough, backup, restore, export, or migration
- Docker inventory, Compose deployment, application installation, package updates, firewall changes, storage changes, or arbitrary command execution
- Backup execution, restore drills, source-server discovery, transfer, or migration cutover
- Keel Notes, AdGuard Home, Jellyfin, Home Assistant, PostgreSQL, router, GitHub, or remote-agent adapters
- Owner bootstrap, user sessions, WebAuthn, CSRF protection, durable approval jobs, or the restricted privileged helper

## Screenshots

### Workflow overview mockup

![BoxPilot overview with sample-data disclosure](docs/screenshots/overview-demo.jpg)

This is an actual `0.3.0` UI capture. The workload, health, backup, and activity values are demonstration data, and the interface labels them accordingly.

### Host-backed virtualization preflight

![BoxPilot virtualization preflight](docs/screenshots/virtualization-preflight.jpg)

This is an actual host-backed capture from a non-Linux development machine. The failed checks are expected and demonstrate that the module reports missing KVM and libvirt dependencies instead of showing a false ready state.

### Read-only VM creation planner

![BoxPilot validated VM planner](docs/screenshots/vm-planner.jpg)

This capture uses a local development ISO fixture. The plan was validated by the running server, but the displayed `virt-install` request was not executed. Apply remains locked.

## Safety contract

Every future host change must follow:

1. Plan
2. Dry run
3. Checkpoint
4. Explicit approval
5. Apply with streamed logs
6. Verify or roll back

The current VM action route maps validated requests to fixed `virsh` argument arrays and never invokes a shell. A separate privileged helper, owner authentication, durable approvals, and a tamper-evident job ledger are still required before higher-impact operations can ship. BoxPilot will not provide an arbitrary root shell.

## Run for development

Requirements:

- Node.js 24 or newer
- npm 11 or newer

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Run the production build

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8787`. The server binds to loopback unless `BOXPILOT_HOST` is explicitly changed.

Health endpoint:

```bash
curl http://127.0.0.1:8787/api/v1/health
```

On Ubuntu, a native service is required for live libvirt access. Follow [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md) after the base operating-system installation.

## Run with Docker

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/api/v1/health
```

The Compose stack:

- Publishes only to `127.0.0.1`
- Runs as the unprivileged Node user
- Drops every Linux capability
- Enables `no-new-privileges`
- Uses a read-only root filesystem
- Does not mount host directories or the Docker socket

The default container is the safest preview deployment, but it cannot inspect host libvirt because it has no libvirt client or socket. Do not add `/run/libvirt` to this container. Use the documented native system service for the VM module until BoxPilot has a separate local agent.

## Private Tailscale access

After BoxPilot is healthy on the Ubuntu server, publish it privately to the tailnet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Open the HTTPS URL shown by `tailscale serve status` from another device on the same tailnet. Keep Tailscale Funnel disabled. The administrator token protects only allowlisted VM lifecycle requests, not the whole interface, so BoxPilot must remain loopback-only behind private Tailscale Serve.

## Validation

```bash
npm run check
npm run doctor
docker build -t boxpilot:local .
```

## Documentation

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Dependency-ordered roadmap](docs/ROADMAP.md)
- [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md)
- [QEMU/KVM milestones](docs/VIRTUALIZATION-MILESTONES.md)
- [QEMU/KVM API and agent contract](docs/VIRTUALIZATION-API.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)

## Keel Notes roadmap adapter

No Keel adapter ships in `0.3.0`. The first planned application adapter will support [Keel Notes](https://github.com/AES256Afro/Keel):

- Detect a Keel Docker or service installation
- Inventory the database dialect and protected data paths without exposing secrets
- Use Keel-aware export and import operations
- Preserve the managed-secret key companion during migration
- Coordinate SQLite writes before backup or restore
- Recognize PostgreSQL deployments
- Surface Keel, Caddy, Docker, backup, and Litestream health
- Test restores in an isolated stack before reporting a backup as verified

## License

No license has been selected yet. All rights are reserved until the repository owner chooses one.
