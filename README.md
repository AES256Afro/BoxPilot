# BoxPilot

BoxPilot is a safety-first, local control plane for an Ubuntu home server. It is designed to make applications, backups, logs, imports, migrations, Docker workloads, and virtual machines manageable from another computer over the LAN or Tailscale.

## Current status

Version `0.2.0` adds a live QEMU/KVM and libvirt module. BoxPilot can inspect host readiness, discover virtual machines, show leased guest addresses, and optionally request a small allowlist of lifecycle operations. VM controls are disabled by default. Package installation, VM creation, deletion, force-off, bridges, storage changes, snapshots, consoles, Docker socket access, firewall edits, and arbitrary command execution remain unavailable.

The current slice includes:

- Responsive server dashboard and workload inventory
- Keel Notes as the first app-aware managed workload
- Browser-only Docker Compose dry-run inspection with risk warnings
- Backup coverage and restore-drill views
- Non-destructive migration workflow
- Prototype logs and downloadable redacted support bundle
- Read-only health and capability API endpoints
- Live QEMU/KVM host preflight and libvirt VM inventory
- Token-protected start, graceful shutdown, reboot, and autostart controls
- Copyable Ubuntu virtualization setup plan
- Hardened, loopback-only Docker deployment
- Full USB-to-headless Ubuntu installation runbook

The Virtual Machines page uses live libvirt data when BoxPilot runs natively on the Ubuntu host. Other dashboard measurements remain demonstration data until their collectors are implemented.

## Safety contract

Every future host change must follow:

1. Plan
2. Dry run
3. Checkpoint
4. Explicit approval
5. Apply with streamed logs
6. Verify or roll back

The current VM action route maps validated requests to fixed `virsh` argument arrays and never invokes a shell. A separate privileged helper, durable approvals, and an audit log are still required before higher-impact operations can ship. BoxPilot will not provide an arbitrary root shell.

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
docker build -t boxpilot:local .
```

## Documentation

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Dependency-ordered roadmap](docs/ROADMAP.md)
- [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)

## Keel Notes integration target

The first application adapter will support [Keel Notes](https://github.com/AES256Afro/Keel):

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
