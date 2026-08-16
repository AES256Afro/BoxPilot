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

Status: libvirt VM, network, pool, and Tailscale access discovery is included in `0.2.0`. Version `0.7.0` adds host identity and resources, root storage, LAN addresses, selected systemd services, sanitized Docker resource inventory, and fixed redacted journal sources. Versions `0.18.0` through `0.22.0` add bounded network, DNS, and signed second-device evidence. Versions `0.30.0` through `0.32.0` add sanitized mount, block, SMART, support-redaction, host PID 1 mount, exact smartmontools repair, and ext4 error-counter evidence. Version `0.33.0` adds optional fixed-localhost NUT state. Version `0.34.0` adds bounded systemd, reboot, dpkg, APT metadata, and unattended-upgrades readiness evidence. Version `0.35.0` adds a separately approved fixed APT metadata-only refresh with installed-package immutability proof. Non-ext4 counters, UPS installation and configuration, remote targets, power controls, automatic shutdown policy, general package install or upgrade, service remediation, host reboot, and broader hardware collectors remain pending.

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

Status: `0.6.0` includes a local managed destination for Uptime Kuma, clean source coordination, SHA-256 integrity evidence, source restart health verification, and an isolated no-network restore drill. Version `0.13.0` adds the encrypted independent mounted-restic copy stage for verified local VM exports, including full repository reads and durable evidence. Version `0.14.0` adds exact-snapshot isolated VM restore boots, repeated guest-agent health, complete transient cleanup, and evidence-gated protected status. Version `0.15.0` adds protected-snapshot recovery as a separately named stopped persistent no-network VM. Version `0.16.0` adds fixed evidence-gated retention batches that forget exact old protected snapshot references but deliberately do not prune. Version `0.25.0` adds the non-executable Keel state, secret, claim, backup, restore, and rollback contract to an exact-release plan. Version `0.38.0` adds a WAL-aware no-downtime BoxPilot controller snapshot, artifact and manifest hashes, database verification, and an isolated copy-open drill. Version `0.39.0` adds a fixed encrypted independent mounted-restic controller copy, separate recovery key, complete repository read, exact snapshot restore, repeated file and database checks, and evidence-gated protected status. Version `0.40.0` adds a fixed high-risk controller-retention batch with three-copy and 30-day floors, failed-restore and active-job preservation, exact-id forget, a complete post-change repository read, noncandidate-presence proof, durable partial-removal evidence, and no prune. Version `0.41.0` adds parameter-free read-only Keel discovery for supported per-user service and fixed Docker evidence. Version `0.42.0` adds a durable approved fixed-release Keel acquisition with exact byte and local digest evidence while keeping the archive inert. Keel extraction, installation, claim, backup, restore, PostgreSQL and Litestream configuration awareness, scheduling, configurable controller retention beyond that fixed policy, prune, remote or cloud destinations, independent application destinations, and application-level VM health remain pending.

- Destination adapters for local disk, mounted NAS, restic repositories, and optional cloud object storage
- Completed in `0.41.0`: bounded read-only Keel discovery for supported per-user service and exact Docker evidence
- Completed in `0.42.0`: fixed root-only Keel artifact acquisition with complete local SHA-256 evidence and no extraction or execution
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

Status: the root-owned service, Unix-socket boundary, versioned allowlist, hardened unit, negative protocol tests, and no-mutation canary are included in `0.4.0`. Versions `0.5.0` through `0.17.0` add the fixed Uptime Kuma, backup, migration, and VM operations documented above. Version `0.19.0` adds fixed exact-LAN Pi-hole inspection and deployment. Version `0.20.0` adds fixed Pi-hole configuration and secret backup, source restart verification, an isolated no-network restore container, and root-only cleanup. Version `0.31.0` adds the first package operation, limited to one immutable exact-version `smartmontools` plan and a static root oneshot that never accepts the package name or APT arguments. Version `0.38.0` adds parameter-free fixed controller inspection and an approved snapshot operation that accepts only a server-generated UUID while deriving the source, artifact, manifest, and drill paths. Version `0.39.0` adds parameter-free controller protection inspection and one typed create operation limited to two UUIDs, two hashes, a size, and destination revision while the helper derives all restic and filesystem inputs. Version `0.40.0` adds parameter-free fixed controller-retention inspection plus one exact-id apply operation limited to a server-generated UUID, three fixed evidence hashes, and one to 100 sorted snapshot ids selected by server policy. Version `0.41.0` adds one parameter-free read-only Keel discovery operation with fixed native, Docker, listener, and health checks and no environment, database, secret, path, port, or mutation input. Version `0.42.0` adds parameter-free artifact inspection and UUID-only acquisition, with the network-isolated helper delegating one compiled HTTPS release transfer to a static separately sandboxed one-shot. General package, service, firewall, storage-pool administration, host reboot, general Docker, general libvirt, extraction, in-place restore, recovery network attachment, configurable retention, prune, remote migration transport, and general backup handlers remain locked.

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

Status: integrity-addressed manifests, live prerequisite and port planning, immutable revisions, the executable Uptime Kuma adapter, and planning-only Pi-hole Docker and VM targets are included in `0.5.0`. Version `0.18.0` adds the read-only route, resolver, exact listener, router-role, and DNS recovery assessment. Version `0.19.0` enables guarded Docker Pi-hole staging only when a fresh owner-attributable assessment passes again at plan, stage, and approval time. Version `0.20.0` adds the separate application-aware Pi-hole backup and isolated restore workflow, including configuration and administrator-secret evidence without router or DNS cutover. Version `0.21.0` adds approved fixed direct DNS acceptance from Bigbox with durable controller-only evidence. Version `0.22.0` adds signed second-device evidence for the same fixed checks. Version `0.25.0` adds a Keel Notes native-service plan bound to one exact public release identity, with execution locked. Version `0.41.0` adds bounded read-only discovery of supported existing Keel native and Docker installs. Version `0.42.0` adds guarded local acquisition and digest verification of the one fixed Keel archive, without extracting or installing it. The Pi-hole VM target, Keel extraction, installation and adoption, router advertisement, full Compose parsing, additional adapters, proxy registration, independent application-backup destinations, and update previews remain pending.

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

Status: `0.22.0` ships the first narrow node identity and evidence path: password-gated one-time enrollment, device-generated Ed25519 keys, signed requests, timestamp and sequence replay protection, revocation, node-local execution, and one fixed second-device Pi-hole probe. Version `0.24.0` adds credential-free sanitized provenance for the fixed public BoxPilot and Keel repositories. Version `0.25.0` consumes only the fixed Keel release metadata in a non-executable plan. Version `0.26.0` adds an authenticated read-only disaster recovery readiness kit and secret-free JSON and Markdown runbook exports. Version `0.28.0` adds owner-approved immediate, 5-minute, and 10-minute one-shot windows. Version `0.29.0` adds a fail-closed local Action Center with fixed sanitized evidence, manual guidance, and in-product handoffs. Version `0.37.0` adds the second allowlisted task: four fixed Flint 2 DNS checks after a node-local default-gateway match. Multiple controllers, a general or recurring scheduler, locally verified signed adapter installation, private repository credentials, broader policy templates, persistent alerts, external notification delivery, and executable recovery automation remain pending.

- Multiple BoxPilot nodes
- Signed adapter packages with compatibility declarations
- Central inventory with node-local execution and approval
- Fixed one-shot signed DNS proof policy included in `0.28.0`; broader policy templates, scheduled maintenance, and notification integrations remain pending
- Signed Flint 2 proof linked to fresh controller evidence and an exact node-local default-gateway match included in `0.37.0`
- Exportable disaster-recovery kit
- Read-only local Action Center with fixed severity, evidence explanations, manual steps, and navigation included in `0.29.0`

Acceptance:

- Compromise of the controller does not provide unrestricted shell access to nodes.
- Adapter signatures and requested privileges are visible before installation.
- Nodes keep functioning safely when the controller is unavailable.

## Phase 9: router integration and DNS cutover

Status: `0.23.0` added a fixed three-model declaration catalog and browser-local SHA-256 checkpoint ledger. Version `0.27.0` added model-specific, vendor-grounded operator checklists and correlates the single default-gateway address observed by Bigbox without claiming router identity. Version `0.36.0` adds a password-approved four-query DNS acceptance against only that observed gateway after a retained Flint 2 checkpoint, Tailscale recovery, and six fixed operator declarations. Version `0.37.0` adds an owner-approved signed second-device task that re-derives and matches its local gateway before repeating those tests. The unprivileged controller and node-local agent store bounded evidence without a router login or helper call. Configuration upload, credentials, sessions, neighbor discovery, operator-supplied targets, live device-state claims, writes, restore claims, DHCP, DNS advertisement, and cutover remain unavailable.

- Browser-local configuration identity with external-file retention evidence included in `0.23.0`
- Fixed intended-role guidance, live gateway-address correlation, explicit operator checks, and vendor handoff included in `0.27.0`
- Immutable observed-gateway Flint 2 DNS acceptance with four fixed queries and durable no-write evidence included in `0.36.0`
- Signed second-device Flint 2 evidence with a node-local default-gateway match included in `0.37.0`
- Exact model and firmware compatibility declarations for future executable adapters
- Encrypted least-privilege credential storage only where vendor support permits it
- Read-only router discovery with bounded redaction
- Model-specific configuration export and isolated restore validation
- Exact proposed DNS or DHCP diff with no arbitrary settings
- Password-approved apply, second-device observation window, and one-step rollback

Acceptance:

- A checkpoint is never described as restorable until an isolated or vendor-supported restore test passes.
- Router credentials never enter ordinary job, audit, log, support-bundle, or browser response data.
- Every change is tied to exact model, firmware, pre-change evidence, bounded fields, and a tested rollback.
- Bigbox and signed second-device checks pass before cutover and throughout the observation window.
- Loss of BoxPilot or Tailscale cannot prevent console-based recovery.
