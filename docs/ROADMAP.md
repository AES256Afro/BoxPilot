# BoxPilot roadmap

The roadmap is ordered by dependency and safety. A later phase cannot ship merely because its interface exists.

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

Status: libvirt VM, network, pool, and Tailscale access discovery included in `0.2.0`; remaining collectors are pending.

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

- Read-only SSH source discovery over LAN or Tailscale
- Resumable checksummed transfer
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

- Live libvirt discovery and guarded start, graceful shutdown, reboot, and autostart controls included in `0.2.0`
- Guided VM creation, console, snapshot, export, and restore
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
