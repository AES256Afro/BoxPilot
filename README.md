# BoxPilot

BoxPilot is an early, safety-first control plane for an Ubuntu home server. The long-term product is a guided interface for applications, backups, logs, imports, migrations, Docker workloads, routers, agents, and virtual machines over a private LAN or Tailscale connection.

## Current status

Version `0.11.0` moves read-only libvirt inventory into the restricted helper and removes direct `libvirt` and `kvm` group access from the web service. Domain inventory now includes bounded snapshot metadata, QEMU guest-agent availability, filesystem-freeze state, and agent-reported addresses. A stopped, persistent VM with unchained qcow2 disks in the managed default image directory can stage an immutable, password-approved internal snapshot job. BoxPilot labels it offline-consistent and explicitly not an independent backup. Snapshot revert and delete remain locked.

### What works now

| Area | Status in `0.11.0` | Capability |
| --- | --- | --- |
| Health and capabilities API | Live | Reports release mode and available product boundaries. |
| Owner authentication | Live | Requires a short-lived token generated from the server terminal for first-owner setup, then uses scrypt password hashes, expiring HTTP-only sessions, and CSRF protection. |
| Operations Core | Live foundation | Persists plans, steps, approvals, results, recovery guidance, and audit attribution in SQLite. Interrupted applying or verifying jobs fail closed for review after restart. |
| Repair Center | Live foundation | Checks Node.js, state storage, the helper, Docker, libvirt, Tailscale, and DNS port availability without returning peer details or raw command output. |
| Restricted helper | Live typed operations | Uses a versioned, allowlisted protocol over a local Unix socket for the canary, bounded inventory and logs, Uptime Kuma deployment and backup, guarded VM creation and lifecycle, read-only libvirt inventory, and offline snapshot creation. It accepts no command strings, binary selection, libvirt URI, argument arrays, operator paths, Compose source, or arbitrary root paths from the browser. |
| Host and Docker inventory | Live | Reports authenticated host identity, CPU, memory, root storage, uptime, selected service state, LAN addresses, Tailscale self-state, and sanitized Docker containers, images, networks, volumes, and Compose projects. |
| System logs | Live restricted sources | Returns capped, redacted entries for fixed BoxPilot, Docker, Tailscale, and virtualization unit sets. Credential-like values and URL query strings are redacted. |
| Application catalog | Live | Publishes integrity-addressed manifests, live installation state, exact image policy, targets, ports, storage, prerequisites, recovery, and adapter risk. |
| Uptime Kuma adapter | Executable deployment | Uses the official `2.5.0` image pinned by multi-platform digest, a loopback-only port, local persistent storage, Docker health, approval, and data-preserving rollback. The catalog shows whether restore-verified backup evidence exists. |
| Pi-hole adapter | Planning-only | Models Docker and dedicated-VM targets, TCP and UDP DNS ports, persistent configuration, Flint 2 AdGuard Home conflicts, router cutover, second-device verification, and recovery. It cannot execute. |
| Backup engine | One live application adapter | Creates immutable local Uptime Kuma archives after a clean stop, verifies source restart, records SHA-256 and measured downtime, and runs a temporary restore container with no network or published ports. |
| Migration Center | Read-only manifest discovery | Exports fingerprinted sanitized source manifests, validates and durably imports them, and creates immutable destination compatibility plans. Transfer and cutover are locked. |
| QEMU/KVM preflight | Live through the native helper | Checks Linux, KVM support reported by libvirt, QEMU, `virsh`, `virt-install`, `qemu:///system`, the helper boundary, the default NAT network, the default storage pool, and Tailscale access. |
| VM and libvirt inventory | Live through the restricted helper | Lists domains, state, CPU, memory, autostart, lease- and guest-agent-reported addresses, disks, interfaces, bounded snapshot metadata, guest-agent state, networks, and storage pools. The web service has no direct libvirt group access. |
| VM console handoff | Read-only detection | Detects an already active Cockpit socket through a parameter-free helper operation and shows a Tailscale-hostname handoff. BoxPilot does not install Cockpit, open its port, bypass its authentication, or proxy console traffic. |
| VM creation | Guarded and executable for Linux profiles | Discovers regular ISO files in one managed directory, validates fields, checks live name, network, pool, and capacity state, stores an immutable plan, stages an awaiting-approval job, and executes a fixed helper adapter with post-create verification and exact-domain rollback. |
| VM lifecycle controls | Durable approved helper jobs | Plans start, graceful shutdown, reboot requests, and autostart changes against exact current state, shows recovery limits, revalidates before staging and approval, and verifies post-operation state. Force-off and delete do not exist. |
| Offline VM snapshots | Guarded approved helper job | Creates one internal snapshot only for a stopped persistent VM whose file-backed disks are regular, unchained qcow2 files inside `/var/lib/libvirt/images`. Domain UUID, stopped state, disk confinement, and the snapshot inventory revision are rechecked. It is never reported as an independent backup. |
| VM event log | Limited live foundation | Writes and displays redacted JSONL events for VM plans and enabled lifecycle requests. It is not the final authenticated job ledger. |
| Compose inspector | Browser-only preview | Performs a lightweight structural and risk scan. It is not a full YAML parser and cannot deploy. |
| Support bundle | Browser-generated preview | Downloads release metadata and available redacted VM audit events. It is not yet a general host support bundle. |
| Settings | UI demonstration | Shows the intended operator workflow using sample data. This page does not collect or change host state. |
| Docker deployment | Safe preview | Runs loopback-only without capabilities, host mounts, or the Docker socket. This container cannot inspect host libvirt. |

The repository also includes a read-only Ubuntu deployment doctor and a USB-to-headless installation runbook.

### Not implemented yet

- VM delete, force-off, console proxy, online snapshot, snapshot revert/delete, bridge creation, passthrough, VM backup, restore, export, cloud-init, Windows TPM/Secure Boot creation, or VM migration
- General Docker mutation, custom Compose deployment, additional application installation, package updates, firewall changes, storage changes, or arbitrary command execution
- Backup schedules, retention, NAS/restic/cloud destinations, Keel Notes export, SSH source discovery, resumable transfer, or migration cutover
- Keel Notes, AdGuard Home, Jellyfin, Home Assistant, PostgreSQL, router, GitHub, or remote-agent adapters
- WebAuthn, recovery codes, multiple owners, Tailscale identity headers, tamper-evident audit chaining, or general-purpose mutation handlers

## Screenshots

### Workflow overview mockup

![BoxPilot overview with sample-data disclosure](docs/screenshots/overview-demo.jpg)

This is an actual `0.3.0` UI capture retained to show the workflow shell. The workload, health, backup, and activity values are demonstration data, and the interface labels them accordingly.

### Host-backed virtualization preflight

![BoxPilot virtualization preflight](docs/screenshots/virtualization-preflight.jpg)

This is an actual host-backed capture from a non-Linux development machine. The failed checks are expected and demonstrate that the module reports missing KVM and libvirt dependencies instead of showing a false ready state.

### Earlier VM creation planner capture

![BoxPilot validated VM planner](docs/screenshots/vm-planner.jpg)

This older `0.3.0` capture uses a local development ISO fixture and shows the planning foundation before guarded execution shipped. In `0.9.0`, supported Linux plans can be staged for a separate password approval. The repository does not claim that this fixture created a VM.

### Guarded VM creation approval mockup

![BoxPilot durable VM creation plan staged for approval](docs/screenshots/vm-creation-approval-mock.png)

This `0.9.0` mock screenshot is rendered from the current BoxPilot styles and is explicitly labeled as mocked product state. It demonstrates the staged job, fixed helper preview, and handoff to Repair Center. No VM was created for the capture.

### Durable VM lifecycle approval mockup

![BoxPilot immutable graceful-shutdown plan before staging](docs/screenshots/vm-lifecycle-approval-mock.png)

This explicitly disclosed `0.10.0` mock shows the exact current and desired state, recovery boundary, immutable revision, and separate approval handoff. The state is representative only. No VM was changed for the capture.

### Guarded offline snapshot approval mockup

![BoxPilot stopped-VM internal snapshot plan before approval](docs/screenshots/vm-snapshot-approval-mock.png)

This explicitly disclosed `0.11.0` mock shows the offline-consistency label, independent-backup warning, managed disk target, immutable revision, and recovery boundary. The state is representative only. No VM or disk was changed for the capture.

## Safety contract

Every future host change must follow:

1. Plan
2. Dry run
3. Checkpoint
4. Explicit approval
5. Apply with streamed logs
6. Verify or roll back

VM creation, lifecycle changes, and offline snapshot creation use the durable job executor and separate typed helper operations. The helper derives its own binary paths, libvirt URI, managed-media and disk roots, verbs, and argument arrays; the web process cannot supply them. Every supported VM mutation requires an immutable plan and owner password reauthentication. Higher-impact operations remain locked until each handler has authorization, path confinement, rollback, and negative tests. BoxPilot will not provide an arbitrary root shell.

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

On a fresh instance, generate the short-lived owner token from the server terminal, then finish setup in the browser:

```bash
npm run owner:token
```

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
- Stores preview authentication state only in its temporary filesystem

The default container is the safest preview deployment, but its owner and job database is intentionally ephemeral and it cannot inspect host libvirt because it has no libvirt client or socket. Do not add `/run/libvirt` or the Docker socket to this container. Use the documented native system services for persistent Operations Core and VM support.

## Private Tailscale access

After BoxPilot is healthy on the Ubuntu server, publish it privately to the tailnet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Open the HTTPS URL shown by `tailscale serve status` from another device on the same tailnet. Keep Tailscale Funnel disabled. BoxPilot authentication remains required because tailnet membership alone is not application authorization.

## Validation

```bash
npm run check
npm run doctor
docker build -t boxpilot:local .
```

## Documentation

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Operations Core setup and recovery](docs/OPERATIONS-CORE.md)
- [Curated application planning and deployment](docs/APPLICATIONS.md)
- [Verified backup and isolated restore workflow](docs/BACKUPS.md)
- [Sanitized host, Docker, service, and log inventory](docs/INVENTORY.md)
- [Read-only migration manifests and compatibility planning](docs/MIGRATIONS.md)
- [Dependency-ordered roadmap](docs/ROADMAP.md)
- [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md)
- [QEMU/KVM milestones](docs/VIRTUALIZATION-MILESTONES.md)
- [QEMU/KVM API and agent contract](docs/VIRTUALIZATION-API.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)

## Keel Notes roadmap adapter

No Keel adapter ships in `0.11.0`. A planned application adapter will support [Keel Notes](https://github.com/AES256Afro/Keel):

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
