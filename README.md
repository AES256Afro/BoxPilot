# BoxPilot

BoxPilot is an early, safety-first control plane for an Ubuntu home server. The long-term product is a guided interface for applications, backups, logs, imports, migrations, Docker workloads, routers, agents, and virtual machines over a private LAN or Tailscale connection.

## Current status

Version `0.20.0` adds a guarded Pi-hole configuration backup and isolated restore drill. After a staged Pi-hole instance is healthy, a separate password-approved background job stops it briefly, archives its persistent configuration, curated Compose definition, and root-only administrator secret, restarts and revalidates the original DNS and web bindings, records SHA-256 and downtime evidence, and boots the restored configuration in a temporary container with no network and no published ports. The local artifact is recovery-tested but is still on Bigbox, so it is not independent 3-2-1 protection. Router, DHCP, client DNS, Tailscale DNS, firewall, and traffic-path changes remain locked.

### What works now

| Area | Status in `0.20.0` | Capability |
| --- | --- | --- |
| Health and capabilities API | Live | Reports release mode and available product boundaries. |
| Owner authentication | Live | Requires a short-lived token generated from the server terminal for first-owner setup, then uses scrypt password hashes, expiring HTTP-only sessions, and CSRF protection. |
| Operations Core | Live foundation | Persists plans, steps, approvals, results, recovery guidance, and audit attribution in SQLite. Interrupted applying or verifying jobs fail closed for review after restart. |
| Repair Center | Live foundation | Checks Node.js, state storage, the helper, Docker, libvirt, Tailscale, and DNS port availability without returning peer details or raw command output. |
| Restricted helper | Live typed operations | Uses a versioned, allowlisted protocol over a local Unix socket for the canary, bounded inventory and logs, Uptime Kuma deployment and backup, exact-address Pi-hole staging and backup, guarded local migration staging, guarded VM creation and lifecycle, read-only libvirt inventory, offline snapshots, stopped-VM exports, mounted-restic VM copies, isolated restore drills, stopped no-network recovery clones, and exact no-prune retention. It accepts no command strings, binary selection, libvirt URI, argument arrays, operator paths, Compose source path, migration destination, SSH credential, repository password, backup mount, repository path, export destination, restore destination, recovery directory, prune flag, selector such as `latest`, or arbitrary root paths from the browser. |
| Host and Docker inventory | Live | Reports authenticated host identity, CPU, memory, root storage, uptime, selected service state, LAN addresses, Tailscale self-state, and sanitized Docker containers, images, networks, volumes, and Compose projects. |
| Network and DNS Center | Live read-only planning | Reports validated default gateways, host LAN CIDRs, sanitized systemd-resolved servers, scoped TCP and UDP port 53 listeners, and Tailscale resolver observations. It creates attributable immutable assessments for Flint 2, ER707-M2, TP-Link BE400, Pi-hole, and external-DNS roles. Router writes and DNS cutover have no execution route. |
| System logs | Live restricted sources | Returns capped, redacted entries for fixed BoxPilot, Docker, Tailscale, and virtualization unit sets. Credential-like values and URL query strings are redacted. |
| Application catalog | Live | Publishes integrity-addressed manifests, live installation state, exact image policy, targets, ports, storage, prerequisites, recovery, and adapter risk. |
| Uptime Kuma adapter | Executable deployment | Uses the official `2.5.0` image pinned by multi-platform digest, a loopback-only port, local persistent storage, Docker health, approval, and data-preserving rollback. The catalog shows whether restore-verified backup evidence exists. |
| Pi-hole adapter | Guarded staging and recovery proof | Starts a digest-pinned Docker service only after a fresh Pi-hole-on-Bigbox network assessment and separate approval. A second approved workflow archives configuration and the administrator secret, verifies source restart and exact bindings, and health-checks a restored copy with no network or ports. DHCP, NTP, router writes, client DNS advertisement, Tailscale changes, and cutover do not exist. The dedicated-VM target remains planning-only. |
| Backup engine | Two live application adapters | Creates immutable local Uptime Kuma and Pi-hole archives after a clean stop, verifies source restart, records SHA-256 and measured downtime, and runs temporary restore containers with no network or published ports. Pi-hole evidence additionally requires configuration, secret, and no-cutover proof, and a strict startup reconciler recovers interrupted source stops and exact orphan drills. Local artifacts are not independent copies. |
| Migration Center | Guarded local staging | Exports and imports fingerprinted sanitized source manifests, creates immutable destination compatibility plans, discovers root-only checksummed Compose bundles from one fixed inbox, and executes resumable password-approved copies into isolated managed staging. It records exact durable evidence, supports no-copy reconciliation after a restart edge case, preserves the source, and never activates the workload. Remote SSH transport and cutover remain locked. |
| QEMU/KVM preflight | Live through the native helper | Checks Linux, KVM support reported by libvirt, QEMU, `virsh`, `virt-install`, `qemu:///system`, the helper boundary, the default NAT network, the default storage pool, and Tailscale access. |
| VM and libvirt inventory | Live through the restricted helper | Lists domains, state, CPU, memory, autostart, lease- and guest-agent-reported addresses, disks, interfaces, bounded snapshot metadata, guest-agent state, networks, and storage pools. The web service has no direct libvirt group access. |
| VM console handoff | Read-only detection | Detects an already active Cockpit socket through a parameter-free helper operation and shows a Tailscale-hostname handoff. BoxPilot does not install Cockpit, open its port, bypass its authentication, or proxy console traffic. |
| VM creation | Guarded and executable for Linux profiles | Discovers regular ISO files in one managed directory, validates fields, checks live name, network, pool, and capacity state, stores an immutable plan, stages an awaiting-approval job, and executes a fixed helper adapter with post-create verification and exact-domain rollback. |
| VM lifecycle controls | Durable approved helper jobs | Plans start, graceful shutdown, reboot requests, and autostart changes against exact current state, shows recovery limits, revalidates before staging and approval, and verifies post-operation state. Force-off and delete do not exist. |
| Offline VM snapshots | Guarded approved helper job | Creates one internal snapshot only for a stopped persistent VM whose file-backed disks are regular, unchained qcow2 files inside `/var/lib/libvirt/images`. Domain UUID, stopped state, disk confinement, and the snapshot inventory revision are rechecked. It is never reported as an independent backup. |
| Stopped VM export | Guarded approved background job | Exports inactive XML and standalone qcow2 disks to a root-only server-generated directory, checks structure, compares source content, records SHA-256 evidence, and leaves the source unchanged. The local artifact is explicitly unencrypted, untested for restore, and not protected against Bigbox loss. |
| Encrypted independent VM copy | Guarded approved background job | Requires a writable exact mount at `/mnt/boxpilot-backup` on a filesystem different from VM images and local exports, a root-only restic password file, and an initialized fixed repository. It reverifies the local export, writes an encrypted tagged snapshot, performs a full-repository `restic check --read-data`, confirms snapshot identity, and performs no retention mutation. A new copy remains not protected until its isolated restore drill passes. |
| Isolated VM restore drill | Guarded approved background job | Restores one exact encrypted snapshot with restic verification, validates its manifest, checks every qcow2 disk, grants the libvirt QEMU group temporary access only to restored disks, boots a generated transient domain with no network, requires repeated guest-agent health, and verifies domain, UEFI NVRAM, permission, and workspace cleanup. Failures never promote protection and preserve root-only restored files for inspection. Helper startup safely reconciles exact interrupted drill domains before accepting requests. |
| Guarded VM recovery clone | Guarded approved background job | Requires protected backup evidence from a passing isolated restore drill, restores the exact snapshot again, validates checksums and qcow2 structures, and defines a separately named persistent VM beneath `/var/lib/libvirt/images/boxpilot-recoveries`. The clone is stopped, non-autostarting, and has no network interface. It never overwrites or deletes the source. |
| Guarded VM backup retention | Guarded high-risk background job | Keeps at least three active copies per VM, keeps every copy under 30 days old, keeps untested copies, and keeps every backup referenced by a recovery clone or active restore/recovery job. It processes at most 100 exact old protected snapshots per approved batch, revalidates the complete snapshot set, forgets only approved ids, reads all remaining repository data, and records exact evidence. Prune, arbitrary policies, schedules, and automatic execution remain unavailable. |
| VM event log | Limited live foundation | Writes and displays redacted JSONL events for VM plans and enabled lifecycle requests. It is not the final authenticated job ledger. |
| Compose inspector | Browser-only preview | Performs a lightweight structural and risk scan. It is not a full YAML parser and cannot deploy. |
| Support bundle | Browser-generated preview | Downloads release metadata and available redacted VM audit events. It is not yet a general host support bundle. |
| Settings | UI demonstration | Shows the intended operator workflow using sample data. This page does not collect or change host state. |
| Docker deployment | Safe preview | Runs loopback-only without capabilities, host mounts, or the Docker socket. This container cannot inspect host libvirt. |

The repository also includes a read-only Ubuntu deployment doctor and a USB-to-headless installation runbook.

### Not implemented yet

- VM delete, force-off, console proxy, online snapshot, snapshot revert/delete, bridge creation, passthrough, in-place restore, recovered-VM network attachment, application-level restore tests, cloud-init, Windows TPM/Secure Boot creation, or VM migration transfer
- General Docker mutation, custom Compose deployment, additional application installation beyond the curated adapters, package updates, firewall changes, storage changes, or arbitrary command execution
- Backup schedules, application-backup independent or offsite destinations, restic prune and space reclamation, configurable retention policies, remote restic/cloud backends, Keel Notes export, SSH source discovery or transport, general application-aware volume/database capture, staged-workload activation, or migration cutover
- Keel Notes, executable AdGuard Home, Jellyfin, Home Assistant, PostgreSQL, Pi-hole router cutover, GitHub, or remote-agent adapters
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

### Stopped VM export approval mockup

![BoxPilot stopped-VM local export plan before approval](docs/screenshots/vm-export-approval-mock.png)

This explicitly disclosed `0.12.0` mock shows the capacity gate, fixed export changes, integrity checks, immutable revision, and protection boundary. It clearly labels the local artifact as unencrypted and not protected. No VM or disk was changed for the capture.

### Encrypted independent VM copy approval mockup

![BoxPilot encrypted independent restic plan before approval](docs/screenshots/vm-protection-approval-mock.png)

This explicitly disclosed `0.13.0` mock shows the fixed independent mount, encryption and capacity evidence, full repository verification, immutable revision, recovery-key warning, and the remaining restore boundary. No VM, export, repository, or disk was changed for the capture.

### Isolated VM restore drill approval mockup

![BoxPilot isolated no-network VM restore drill before approval](docs/screenshots/vm-restore-drill-approval-mock.png)

This explicitly disclosed `0.14.0` mock shows exact snapshot identity, temporary capacity, no-network transient boot, repeated guest-agent verification, QEMU permission and UEFI cleanup, and the protected-status gate. No snapshot was restored and no VM was booted for the capture.

### Guarded VM recovery-clone approval mockup

![BoxPilot stopped no-network VM recovery clone before approval](docs/screenshots/vm-recovery-approval-mock.png)

This explicitly disclosed `0.15.0` mock shows the separate target name, exact protected source evidence, fixed recovered storage, stopped persistent domain, disabled autostart, zero-network policy, immutable revision, and confined rollback. No snapshot was restored and no recovery VM was defined for the capture.

### Guarded VM backup-retention approval mockup

![BoxPilot exact no-prune VM backup retention before approval](docs/screenshots/vm-retention-approval-mock.png)

This explicitly disclosed `0.16.0` mock shows the fixed 30-day and three-copy floors, exact candidates, immutable snapshot-set revision, repository verification, high-risk approval, and no-prune boundary. No restic snapshot was forgotten or pruned for the capture.

### Guarded migration staging approval mockup

![BoxPilot checksummed migration bundle before staging](docs/screenshots/migration-transfer-approval-mock.png)

This explicitly disclosed `0.17.0` mock shows imported-source binding, immutable content revision, file and sensitive-name totals, exact SHA-256 verification, resume behavior, separate password approval, and the no-activation boundary. No source workload or file was changed, no real bundle was copied, and no Compose project was activated for the capture.

### Network and DNS assessment mockup

![BoxPilot read-only router and DNS change-window assessment](docs/screenshots/network-dns-assessment-mock.png)

This explicitly disclosed `0.18.0` mock shows live-shaped gateway, Bigbox address, external AdGuard DNS, Tailscale split-DNS, port 53 scope, device roles, recovery gates, and the router-write and DNS-cutover locks. No router, DNS, DHCP, firewall, Tailscale, or application setting was read from a real browser session or changed for the capture.

### Guarded Pi-hole staging mockup

![BoxPilot digest-pinned Pi-hole staging plan before approval](docs/screenshots/pihole-staging-approval-mock.png)

This explicitly disclosed `0.19.0` mock shows the linked network assessment, exact Bigbox LAN DNS and web bindings, root-only secret boundary, capability restrictions, health checks, backup-required state, and router, DHCP, client-DNS, and Tailscale cutover locks. No container, router, DNS client, DHCP service, firewall, Tailscale setting, or traffic path was changed for the capture.

### Pi-hole backup and isolated restore mockup

![BoxPilot Pi-hole recovery-proof plan before approval](docs/screenshots/pihole-backup-approval-mock.png)

This explicitly disclosed `0.20.0` mock shows the clean-stop archive, root-only configuration and secret capture, source binding restart verification, SHA-256 evidence, temporary no-network restore container, local-destination limitation, and router and DNS cutover locks. No container was stopped, archive created, secret read, restore started, or network setting changed for the capture.

## Safety contract

Every future host change must follow:

1. Plan
2. Dry run
3. Checkpoint
4. Explicit approval
5. Apply with streamed logs
6. Verify or roll back

Pi-hole staging and backup, migration staging, VM creation, lifecycle changes, offline snapshots, stopped-VM exports, encrypted independent VM copies, isolated restore drills, guarded recovery clones, and exact retention batches use the durable job executor and separate typed helper operations. The helper derives its own application, secret, backup, migration inbox, staging, binary, libvirt URI, managed-media, disk, export, restore-workspace, recovery, UEFI NVRAM, mount, repository, cache, and password-file roots, verbs, and argument arrays; the web process cannot supply them. Every supported mutation requires an immutable plan and owner password reauthentication. Higher-impact operations remain locked until each handler has authorization, path confinement, rollback, and negative tests. BoxPilot will not provide an arbitrary root shell.

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
- [Read-only router and DNS topology planning](docs/NETWORK.md)
- [Guarded migration discovery and local staging](docs/MIGRATIONS.md)
- [Dependency-ordered roadmap](docs/ROADMAP.md)
- [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md)
- [QEMU/KVM milestones](docs/VIRTUALIZATION-MILESTONES.md)
- [QEMU/KVM API and agent contract](docs/VIRTUALIZATION-API.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)

## Keel Notes roadmap adapter

No Keel-specific adapter ships in `0.20.0`. The generic migration packer can stage an offline Keel Notes Compose project only as opaque verified files; it does not understand Keel databases, managed-secret keys, health, activation, or cutover. A planned application adapter will support [Keel Notes](https://github.com/AES256Afro/Keel):

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
