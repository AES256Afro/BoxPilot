# BoxPilot roadmap

The roadmap is ordered by dependency and safety. A later phase cannot ship merely because its interface exists.

The detailed QEMU/KVM sequence and acceptance gates live in [Virtualization milestones](VIRTUALIZATION-MILESTONES.md).

## Phase 0: runnable product shell

Status: included in `0.1.0`.

- Responsive local console
- Read-only prototype API
- Safe-mode banner and explicit capability reporting
- Compose dry-run risk hints
- Support-bundle demonstration
- Docker packaging and CI
- Architecture, installation, and recovery documentation

Acceptance:

- Build and tests pass.
- The container runs without Linux capabilities, host mounts, or Docker socket access.
- API reports `hostMutationsEnabled: false`.
- Every unavailable action says it is a preview.

## Phase 1: real read-only inventory

Status: libvirt VM, network, pool, and Tailscale access discovery is included in `0.2.0`. Version `0.7.0` adds host identity and resources, root storage, LAN addresses, selected systemd services, sanitized Docker resource inventory, and fixed redacted journal sources. Version `0.18.0` adds fixed default-route, systemd-resolved, scoped port 53 listener, and Tailscale resolver observations plus no-change router and DNS assessments. SMART, full mount inventory, support-bundle redaction policies, and broader hardware collectors remain pending.

- Host identity, OS, kernel, uptime, CPU, memory, mounts, and disk space
- SMART and filesystem health
- systemd unit status and selected journald streams
- Docker containers, images, networks, named volumes, Compose projects, and health
- libvirt networks, pools, and virtual machines
- Tailscale status without control-plane secrets
- Configurable redaction engine and support bundle

Acceptance:

- Inventory runs as an unprivileged dedicated user.
- Missing permissions degrade individual collectors rather than failing the console.
- Fixtures and integration tests cover Ubuntu LTS versions.
- No read-only endpoint returns environment secret values.

## Phase 2: identity, audit, and durable jobs

Status: password-based owner bootstrap, expiring sessions, CSRF protection, SQLite jobs, approval reauthentication, audit attribution, and interrupted-job fail-closed recovery are included in `0.4.0`. WebAuthn, recovery codes, migration tooling, and proxy identity remain pending.

- Local owner bootstrap from the server terminal
- Password plus WebAuthn support
- Tailscale identity header integration only behind a verified proxy
- SQLite state and migrations
- Durable plan, job, step, approval, and audit records
- CSRF protection, session expiration, and approval reauthentication

Acceptance:

- Fresh installs cannot be claimed remotely without a server-local action.
- Every plan and approval is attributable to one operator.
- Restarting BoxPilot safely resumes or marks interrupted jobs.
- Security tests cover session, CSRF, proxy-header, and authorization boundaries.

## Phase 3: backup engine and Keel Notes adapter

Status: `0.6.0` includes a local managed destination for Uptime Kuma, clean source coordination, SHA-256 integrity evidence, source restart health verification, and an isolated no-network restore drill. Version `0.13.0` adds the encrypted independent mounted-restic copy stage for verified local VM exports, including full repository reads and durable evidence. Version `0.14.0` adds exact-snapshot isolated VM restore boots, repeated guest-agent health, complete transient cleanup, and evidence-gated protected status. Version `0.15.0` adds protected-snapshot recovery as a separately named stopped persistent no-network VM. Version `0.16.0` adds fixed evidence-gated retention batches that forget exact old protected snapshot references but deliberately do not prune. Scheduling, configurable retention, prune, remote destinations, application-level VM health, Keel Notes, PostgreSQL, and Litestream awareness remain pending.

- Destination adapters for local disk, mounted NAS, restic repositories, and optional cloud object storage
- Keel discovery for Docker and service installs
- Keel-aware export/import and managed-secret key handling
- SQLite write coordination and PostgreSQL dump/restore
- Litestream awareness without configuring duplicate replication blindly
- Encrypted retention policies
- Isolated restore drills and evidence capture

Acceptance:

- A Keel backup is not green until an isolated restore and health check pass.
- Interrupted backups leave no successful record.
- Existing Litestream and Keel backup settings are discovered before changes.
- Migration preserves the source until the operator accepts the destination.

## Phase 4: restricted privileged helper

Status: the root-owned service, Unix-socket boundary, versioned allowlist, hardened unit, negative protocol tests, and no-mutation canary are included in `0.4.0`. Version `0.5.0` adds fixed Uptime Kuma inspect and deploy operations. Version `0.6.0` adds the fixed Uptime Kuma backup and isolated restore handler. Version `0.9.0` adds fixed Linux VM creation with managed-media confinement, post-create verification, and exact-domain rollback. Version `0.10.0` adds durable approved start, graceful shutdown, reboot request, and autostart handlers. Version `0.11.0` moves read-only libvirt inventory across the helper, removes direct web-service virtualization groups, and adds stopped-VM internal snapshots with managed qcow2 confinement. Version `0.12.0` adds stopped-VM local exports with fixed server-owned paths, standalone qcow2 conversion, integrity evidence, and confined cleanup. Version `0.13.0` adds fixed mounted-restic destination inspection and encrypted independent-copy creation without browser-supplied paths, credentials, commands, or deletion operations. Version `0.14.0` adds exact-snapshot isolated restore drills without browser-supplied restore paths, domains, networks, firmware paths, or restic arguments. Version `0.15.0` adds exact protected-snapshot recovery into one fixed generated directory and a separately named stopped no-network domain. Version `0.16.0` adds exact bounded snapshot forgetting with fixed eligibility and no prune. Version `0.17.0` adds fixed migration inbox and staging roots, checksum-only resume, complete inventory verification, and no-copy restart reconciliation without browser-supplied paths, commands, credentials, or activation. Package, service, firewall, storage-pool administration, host reboot, general Docker, general libvirt, in-place restore, recovery network attachment, configurable retention, prune, remote migration transport, and general backup handlers remain locked.

- Root-owned Unix socket
- Versioned typed-operation protocol
- Allowlisted package, service, firewall, storage, and reboot operations
- Path confinement and argument validation
- Preflight, checkpoint, apply, verify, and rollback handlers
- AppArmor profile and systemd hardening

Acceptance:

- The helper cannot execute arbitrary shell commands.
- Every operation has negative authorization and path-escape tests.
- Loss of the web process does not leave an unsafe partial operation.
- Manual recovery steps are printed before any reboot or networking change.

## Phase 5: applications and Compose imports

Status: integrity-addressed manifests, live prerequisite and port planning, immutable revisions, the executable Uptime Kuma adapter, and planning-only Pi-hole Docker and VM targets are included in `0.5.0`. Version `0.18.0` adds the read-only route, resolver, exact listener, router-role, and DNS recovery assessment that Pi-hole will consume, but does not enable Pi-hole execution. Full Compose parsing, secret storage, verified backups, additional adapters, proxy registration, and update previews remain pending.

- Full Compose YAML parser and policy engine
- Port, volume, architecture, secret, health, and backup planning
- Curated AdGuard Home, Jellyfin, Home Assistant, PostgreSQL, and Keel templates
- Image digest pinning options and update previews
- Secret store integration
- Reverse-proxy and private-access registration

Acceptance:

- Import never executes on first submission.
- Privileged mode, host networking, devices, broad mounts, and socket access require explicit risk handling.
- Persistent paths receive backup coverage before an app is reported production-ready.
- Rollback is tested for every curated adapter version.

## Phase 6: migration center

Status: `0.8.0` includes fingerprinted sanitized BoxPilot source manifests, attributable durable imports, and destination architecture, container-name, and published-port compatibility plans. Version `0.17.0` adds terminal-created immutable local Compose bundles, fixed root-only inbox discovery, imported-source binding, capacity and collision gates, durable approved staging, per-file SHA-256 verification, exact-file resume, source preservation, and no-copy reconciliation after a record-write interruption. Remote SSH discovery and transport, live volume/database capture, full Compose policy parsing, isolated destination startup, health validation, downtime measurement, activation, route cutover, and source deletion remain pending.

- Read-only SSH source discovery over LAN or Tailscale
- Resumable checksummed local staging included in `0.17.0`; remote transport remains pending
- Container, volume, application database, file, and VM migration adapters
- Compatibility and capacity gates
- Isolated destination tests
- Approval-based route cutover with source preservation

Acceptance:

- The first pass cannot mutate the source.
- Transfer resumes after interruption without recopying verified blocks.
- Source deletion is never automatic.
- Cutover includes a measured downtime estimate and tested rollback.

## Phase 7: virtual machines and storage

- Live libvirt discovery included in `0.2.0`; start, graceful shutdown, reboot, and autostart move to durable helper jobs in `0.10.0`
- Read-only creation planning, managed ISO discovery, resource guardrails, and detailed guest/network/pool inventory included in `0.3.0`
- Durable approved Linux VM creation through the restricted helper included in `0.9.0`
- Helper-backed guest-agent and snapshot inventory plus guarded offline internal snapshot creation included in `0.11.0`
- Read-only Cockpit socket detection and Tailscale-hostname console handoff included in `0.11.0`; BoxPilot does not install or expose Cockpit
- Guarded stopped-VM local export with content verification and explicit unprotected status included in `0.12.0`
- Encrypted independent mounted-restic copy with source rehashing, full repository reads, snapshot identity evidence, and explicit unprotected status included in `0.13.0`
- Exact-snapshot isolated restore drill with no-network transient boot, guest-agent health, cleanup evidence, and per-backup protected status included in `0.14.0`
- Guarded protected-snapshot recovery as a separately named stopped persistent VM with no network interface or autostart included in `0.15.0`
- Fixed guarded retention of exact old protected snapshot references with a three-copy floor, 30-day floor, recovery-reference preservation, full repository read, and no prune included in `0.16.0`
- Console proxy, online snapshot, snapshot revert/delete, in-place restore, recovery network attachment, application-level restore tests, restic prune, configurable retention, Windows TPM/Secure Boot creation, and cloud-init remain pending
- Storage pool management with destructive-operation confirmation
- Cloud-init templates and bridged-network planning
- UPS state, shutdown policy, and disk replacement runbooks

Acceptance:

- VM and storage operations cannot target an unresolved disk or broad path.
- Snapshots are not misrepresented as independent backups.
- Bridge changes require console recovery instructions and a connectivity checkpoint.

## Phase 8: fleet and plugin model

- Multiple BoxPilot nodes
- Signed adapter packages with compatibility declarations
- Central inventory with node-local execution and approval
- Policy templates, scheduled maintenance, and notification integrations
- Exportable disaster-recovery kit

Acceptance:

- Compromise of the controller does not provide unrestricted shell access to nodes.
- Adapter signatures and requested privileges are visible before installation.
- Nodes keep functioning safely when the controller is unavailable.
