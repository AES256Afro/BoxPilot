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

Status: libvirt VM, network, pool, and Tailscale access discovery is included in `0.2.0`. Version `0.7.0` adds host identity and resources, root storage, LAN addresses, selected systemd services, sanitized Docker resource inventory, and fixed redacted journal sources. Versions `0.18.0` through `0.22.0` add bounded network, DNS, and signed second-device evidence. Versions `0.30.0` through `0.32.0` add sanitized mount, block, SMART, support-redaction, host PID 1 mount, exact smartmontools repair, and ext4 error-counter evidence. Version `0.33.0` adds optional fixed-localhost NUT state. Version `0.34.0` adds bounded systemd, reboot, dpkg, APT metadata, and unattended-upgrades readiness evidence. Version `0.35.0` adds a separately approved fixed APT metadata-only refresh with installed-package immutability proof. Version `0.45.0` adds bounded read-only restic package evidence and a separately approved exact-version install without repository setup. Version `0.54.0` adds a separately approved exact Ubuntu `docker.io` installation that refuses to replace an active compatible provider and performs no daemon, user, image, container, or repository configuration. Non-ext4 counters, UPS installation and configuration, remote targets, power controls, automatic shutdown policy, broader fixed prerequisites, general package install or upgrade, service remediation, host reboot, and broader hardware collectors remain pending.

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

Status: `0.6.0` includes a local managed destination for Uptime Kuma, clean source coordination, SHA-256 integrity evidence, source restart health verification, and an isolated no-network restore drill. Versions `0.13.0` through `0.16.0` add independent VM protection, restore drills, recovery clones, and fixed no-prune retention. Versions `0.38.0` through `0.40.0` add controller snapshot, independent protection, and fixed no-prune retention. Versions `0.41.0` through `0.43.0` add Keel discovery, fixed artifact acquisition, and runtime archive inspection. Version `0.44.0` adds independent application protection, and `0.45.0` adds the exact restic package prerequisite. Version `0.46.0` pins the corrected Keel `v1.2.6` release and adds password-approved extraction into a verified inert root-owned tree. Version `0.47.0` adds a separate guarded native-service install with dedicated identity, private state, immutable activation, exact loopback health proof, terminal-only claim handoff, and state-preserving rollback. Version `0.48.0` adds application-aware consistent Keel export, guaranteed source restart, complete manifest and tree evidence, an isolated restored-SQLite drill, interrupted-operation recovery, and eligibility for encrypted independent application protection. Version `0.49.0` adds a separately approved stopped no-network recovery clone from exact local evidence while preserving production. Version `0.50.0` adds a separately approved disposable private-network startup and health rehearsal with clean stop and source-immutability evidence. Version `0.50.1` keeps hardened preflight builds readable by the unprivileged web service through a fixed validated generated-output mode normalizer. Version `0.51.0` adds exact-drill-gated Keel production promotion with a retained old-state checkpoint, interrupted-operation reconciliation, and automatic rollback. Version `0.52.0` adds an exact-evidence operator rollback that preserves both the original promotion checkpoint and displaced current production. Version `0.53.0` adds terminal-only Keel instance-owner login and forced-logout proof with no credential or session storage. Keel claim automation, WebAuthn terminal proof, import, PostgreSQL and Litestream configuration awareness, scheduling, application retention, rollback-checkpoint retention and deletion, configurable controller retention beyond the fixed policy, prune, remote or cloud destinations, and application-level VM health remain pending.

- Destination adapters for local disk, mounted NAS, restic repositories, and optional cloud object storage
- Completed in `0.41.0`: bounded read-only Keel discovery for supported per-user service and exact Docker evidence
- Completed in `0.42.0`: fixed root-only Keel artifact acquisition with complete local SHA-256 evidence and no extraction or execution
- Completed in `0.43.0`: parameter-free bounded archive membership inspection that blocks the unsafe 1.2.5 link without extraction or private member disclosure
- Completed in `0.44.0`: encrypted independent Uptime Kuma and Pi-hole archive protection with a separate key, full repository read, and exact restored size and SHA-256
- Completed in `0.45.0`: fixed exact-version restic package prerequisite repair with durable approval and no repository setup
- Completed in `0.46.0`: corrected Keel 1.2.6 identity, dual archive and extracted-tree gates, and UUID-only inert root-owned release staging with automatic partial cleanup
- Completed in `0.47.0`: UUID-only native install with a dedicated non-login account, private state, atomic activation, exact hardened loopback unit, health and database proof, terminal claim handoff, and state-preserving rollback
- Completed in `0.48.0`: UUID-only consistent Keel export with managed-secret and uploads coverage, guaranteed source restart, complete tree and manifest proof, isolated SQLite-open drill, interrupted-operation recovery, and independent-restic eligibility
- Completed in `0.49.0`: typed exact-evidence Keel recovery clone with archive confinement, repeated manifest, tree, secret, and SQLite verification, atomic root-only publication, stopped state, no network, and no production replacement
- Completed in `0.50.0`: typed stopped-recovery startup rehearsal using a disposable copy, dedicated identity, private network namespace, exact health identity, repeated SQLite proof, clean stop, unchanged source, removed workspace, zero published ports, and no login or promotion
- Completed in `0.50.1`: fixed no-argument generated-web-output validation and mode normalization that preserves hardened preflight builds while keeping the unprivileged interface readable
- Completed in `0.51.0`: exact-drill-gated Keel production promotion with generated candidate validation, atomic whole-state exchange, retained prior production, exact health proof, persistent interruption reconciliation, and automatic rollback
- Completed in `0.52.0`: separately approved Keel operator rollback with exact original-checkpoint revalidation, atomic displaced-current-state preservation, repeated health and SQLite proof, persistent interruption reconciliation, and unchanged exposure boundaries
- Completed in `0.53.0`: terminal-only Keel instance-owner login proof using Keel's generated action, an unprivileged credential worker, owner-only route verification, forced logout and session revocation proof, and exact sanitized root-only evidence
- Keel-aware import and rollback-checkpoint retention
- SQLite write coordination and PostgreSQL dump/restore
- Litestream awareness without configuring duplicate replication blindly
- Encrypted retention policies
- Completed in `0.48.0`: isolated Keel export restore drill and evidence capture without starting a second application

Acceptance:

- A Keel backup is not green until an isolated restore and health check pass.
- Interrupted backups leave no successful record.
- Existing Litestream and Keel backup settings are discovered before changes.
- Migration preserves the source until the operator accepts the destination.

## Phase 4: restricted privileged helper

Status: the root-owned service, Unix-socket boundary, versioned allowlist, hardened unit, negative protocol tests, and no-mutation canary are included in `0.4.0`. Later releases add bounded application, backup, migration, VM, package, controller, and Keel operations. Version `0.46.0` adds parameter-free Keel stage inspection and a separate stage mutation that accepts only a server-generated UUID. Version `0.47.0` adds parameter-free fixed-boundary install inspection and a distinct UUID-only install mutation delegated to a no-argument static one-shot. Version `0.48.0` adds a UUID-only backup mutation delegated to a second no-argument static one-shot with a loopback-only network sandbox and guaranteed source restart. Version `0.50.0` adds a recovery-UUID-only inspection and an exact-evidence startup rehearsal delegated to a static no-argument private-network one-shot. Version `0.51.0` adds a static no-argument promotion unit that accepts only a helper-staged exact tuple, retains prior production, and automatically restores it after failure or interruption. Version `0.52.0` adds a second static no-argument exchange unit with an immutable original checkpoint and displaced-state recovery. Version `0.54.0` adds separate parameter-free Docker prerequisite inspection and an exact-version mutation delegated to a static no-argument Ubuntu package unit. All archive, destination, package-identity, membership, account, permission, unit, activation, health, backup, recovery, drill, promotion, rollback, evidence, and cleanup paths are helper-owned and fixed. General package, service, firewall, storage-pool administration, host reboot, general Docker, general libvirt, arbitrary application installation, arbitrary in-place restore, recovery network attachment, configurable retention, prune, remote migration transport, and general backup handlers remain locked.

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

Status: integrity-addressed manifests, live prerequisite and port planning, immutable revisions, executable Uptime Kuma, guarded Pi-hole staging and recovery, and fixed DNS acceptance are included. Versions `0.41.0` through `0.43.0` add Keel discovery, guarded local acquisition, and runtime archive inspection. Version `0.46.0` pins the corrected Keel 1.2.6 archive and permits inert root-owned staging after all evidence gates pass. Version `0.47.0` installs only that staged release as a dedicated loopback-only native service through a separate immutable, staged, password-approved job. Versions `0.48.0` through `0.52.0` add application-aware backup, stopped recovery, isolated startup rehearsal, exact rollback-backed production promotion, and operator-requested rollback with displaced-state preservation. Version `0.53.0` adds terminal-only password owner-login, owner-route, forced-logout, and revoked-session proof with sanitized root-only evidence. The Pi-hole VM target, Keel claim automation and adoption, router advertisement, full Compose parsing, additional adapters, proxy registration, application retention, import, rollback retention, and update previews remain pending.

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
