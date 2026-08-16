# BoxPilot architecture

## Product boundary

BoxPilot is a local-first management plane for one Ubuntu server. The normal operator uses a browser from another LAN or Tailscale device. Cloud accounts are optional integrations, not a requirement for operating the server.

Version `0.32.0` extends the fixed root-only storage evidence writer with mounted ext4 kernel error counters. The collector derives a bounded kernel device name from the already fixed host PID 1 mount inventory, reads only `/sys/fs/ext4/<device>/errors_count`, and never invokes a filesystem checker or repair tool. A nonzero counter is critical; missing and unsupported evidence fail closed.

## Target components

```text
Browser over Tailscale HTTPS
          |
          v
BoxPilot web and API process (unprivileged)
          |
          +---- SQLite owner, session, job, approval, and audit state (0.4.0)
          +---- Integrity-addressed application catalog and plans (0.5.0)
          |
          +---- Read-only web collectors
          |       systemd, host interfaces, fixed routes, resolvers, listener scopes, and bounded host state
          |
          +---- Durable VM creation plans and approved jobs (0.9.0)
          +---- Durable VM lifecycle plans and approved jobs (0.10.0)
          +---- Durable offline snapshot plans and approved jobs (0.11.0)
          +---- Durable stopped-VM local export plans and approved background jobs (0.12.0)
          +---- Durable encrypted independent VM copy plans and approved background jobs (0.13.0)
          +---- Durable isolated no-network VM restore drills and protection evidence (0.14.0)
          +---- Durable stopped no-network VM recovery clones from protected evidence (0.15.0)
          +---- Durable exact no-prune VM retention batches (0.16.0)
          +---- Durable checksummed migration staging and reconciliation (0.17.0)
          +---- Immutable no-change router and DNS assessments (0.18.0)
          +---- Durable linked-assessment Pi-hole staging plans and approved jobs (0.19.0)
          +---- Durable Pi-hole configuration backup and isolated restore evidence (0.20.0)
          +---- Durable fixed-query Pi-hole DNS acceptance from Bigbox (0.21.0)
          +---- Signed replay-protected second-device Pi-hole evidence (0.22.0)
          +---- Browser-local router backup hashes and metadata ledger (0.23.0)
          +---- Fixed public GitHub repository and release provenance (0.24.0)
          +---- Exact-release Keel Notes planning with execution locked (0.25.0)
          +---- Secret-free recovery readiness and ordered runbook export (0.26.0)
          +---- Fixed-model router guidance and gateway-address correlation (0.27.0)
          +---- Owner-approved one-shot signed DNS proof windows (0.28.0)
          +---- Read-only fail-closed local Action Center (0.29.0)
          +---- Sanitized host storage inventory and fixed-source support bundle (0.30.1)
          +---- Durable exact-version smartmontools repair plan and approval (0.31.0)
          +---- Mounted ext4 kernel error-counter evidence (0.32.0)
          |
          +<--- Ed25519 signed polling and fixed evidence from enrolled LAN agent
                  no remote shell, arbitrary command, arbitrary target, or private-key transfer
          |
          +---- Redacted VM audit JSONL in systemd StateDirectory (0.3.0 foundation)
          |
          v
Restricted helper over a local Unix socket (0.4.0 canary foundation)
          |
          +---- typed no-mutation canary (0.4.0)
          +---- fixed smartmontools inspect and exact-version package-unit handoff (0.31.0)
          +---- fixed Uptime Kuma inspect, deploy, health, and rollback (0.5.0)
          +---- fixed Linux VM creation, verification, and exact-domain rollback (0.9.0)
          +---- fixed VM start, graceful shutdown, reboot request, and autostart operations (0.10.0)
          +---- bounded libvirt, guest-agent, and snapshot inventory (0.11.0)
          +---- parameter-free Cockpit socket detection for console handoff (0.11.0)
          +---- stopped-VM internal snapshot creation with managed qcow2 confinement (0.11.0)
          +---- stopped-VM standalone qcow2 export and integrity evidence (0.12.0)
          +---- fixed mounted-restic copy with full repository read verification (0.13.0)
          +---- fixed exact-snapshot restore, transient no-network boot, and cleanup verification (0.14.0)
          +---- exact interrupted-drill startup reconciliation with fail-closed identity checks (0.14.0)
          +---- fixed recovery directory, persistent stopped definition, and exact rollback checks (0.15.0)
          +---- exact old protected snapshot forget with copy, age, drill, recovery, and snapshot-set gates (0.16.0)
          +---- fixed root-only migration bundle inspect, resume, verify, and reconcile (0.17.0)
          +---- fixed digest-pinned exact-LAN Pi-hole deploy, secret, health, and rollback (0.19.0)
          +---- fixed Pi-hole config and secret archive, source restart, no-network restore, and strict interrupted-job reconciliation (0.20.0)
          +---- other typed package operations (future)
          +---- typed systemd operations
          +---- typed firewall operations
          +---- typed storage and backup operations
          +---- adapter-owned Docker and libvirt operations
```

The web process must never accept an arbitrary command string for privileged execution. The helper receives validated operation names and typed parameters, applies an allowlist, and returns structured output. The authenticated web job executor records plan, approval, lifecycle, result, and failure audit events in SQLite.

## Change lifecycle

Every mutation is a durable job with these states:

```text
draft -> preflight -> checkpointed -> awaiting approval -> applying
      -> verifying -> completed
                    -> rollback available -> rolled back
                    -> failed
```

An operation cannot enter `applying` without:

1. A successful preflight tied to the current host state
2. A verified recovery checkpoint when the adapter requires one
3. An explicit, short-lived approval from an authorized operator
4. An operation-specific rollback or recovery explanation

## Trust boundaries

### Browser

- Never receives host credentials, cloud client secrets, backup passphrases, or raw environment files
- Uses anti-CSRF protection and a short authenticated session
- Shows redacted diffs and structured command plans
- Requires reauthentication for high-impact approvals

### Web and API process

- Runs as a dedicated unprivileged user
- Binds to loopback by default
- Does not mount `/var/run/docker.sock`
- Cannot invoke `sudo`
- Has no `libvirt` or `kvm` supplementary group and cannot connect to libvirt directly
- Stores encrypted integration secrets separately from ordinary job data
- Redacts secret-like values before persistence and display

### Privileged helper

- Runs as a separate, minimal system service
- Listens only on a root-owned Unix socket
- Accepts no shell fragments or arbitrary paths
- Enforces operation-specific path roots and argument schemas
- Has no inbound network listener
- Returns bounded structured results to the durable authenticated job executor

## Access model

The recommended path is:

1. BoxPilot listens on `127.0.0.1:8787`.
2. Tailscale Serve provides private HTTPS inside the tailnet.
3. Tailscale Funnel remains disabled.
4. Full BoxPilot authentication remains required even when Tailscale is present.
5. LAN listening is opt-in and requires TLS or a trusted reverse proxy.

Tailscale provides the private network path. It does not replace application authorization, audit trails, or reauthentication for destructive changes. VM creation, lifecycle, and snapshot jobs use BoxPilot owner sessions, CSRF protection, immutable revisions, and password approval. The service must remain loopback-only behind Tailscale Serve.

## Adapter contract

Each managed application adapter owns:

- Discovery and version detection
- Configuration inventory with secret redaction
- Health checks and acceptance criteria
- Backup and restore procedures
- Migration compatibility checks
- Upgrade plan and rollback instructions
- Log sources and support-bundle redaction rules

Uptime Kuma is the low-risk canary adapter because it proves fixed Docker arguments, local persistent storage, loopback exposure, health checks, and rollback. Pi-hole is the first network-critical staging adapter. It adds an owner-attributable live network assessment, exact LAN bindings, helper-owned secret generation, least tested capabilities, no-cutover result evidence, and rollback while keeping every router and client unchanged. Keel Notes is the first stateful native-service planning adapter. Version `0.25.0` binds its plan to an exact release identity and documents database, managed-secret, upload, private-claim, health, backup, restore, and rollback gates, but provides no execution route.

## Data model target

The persistent store is SQLite. Owners, sessions, jobs, job steps, approvals, plans, application backups, DNS acceptance runs, fleet agents, one-time enrollment token digests, fleet tasks, signed evidence, router checkpoint metadata, VM exports, VM backups, VM recoveries, VM retention runs, imported migration sources, verified migration transfers, and audit events are live. Planned records include:

- hosts
- workloads
- adapters and capabilities
- plans and plan revisions
- jobs and job steps
- approvals
- checkpoints
- backup artifacts and restore drills
- audit events
- redaction rules

Backup repositories, VM images, database dumps, and application data do not live inside the BoxPilot database. BoxPilot stores their metadata, validation results, and destination references.

## Backup rule

A successful copy is not a verified backup. BoxPilot reports a workload as protected only when:

- The adapter knows every required data and secret component
- The last backup completed without excluded critical paths
- Artifact integrity checks passed
- Encryption and recovery keys meet policy
- A restore drill passed within the configured interval

## Version 0.32.0 limitations

- The current Overview is authenticated live inventory. The retained `0.3.0` overview screenshot is demonstration data, and Settings remains guidance rather than an editable network configuration surface.
- Compose inspection is a lightweight browser-only scan, not a full YAML policy engine.
- Host, sanitized real mounts and block topology, mounted ext4 kernel error counters, selected systemd services, Docker, libvirt, Tailscale self-state, fixed routes, resolver addresses, scoped port 53 listeners, and fixed journal sources are live. SMART evidence is available only when the fixed root-only timer has a recent successful `smartctl` result; absent or stale evidence fails closed. Non-ext4 filesystem counters remain unsupported. Serial numbers, UUIDs, raw SMART output, mount option values, private home paths, physical router identity, operating mode, cabling, DHCP authority, neighbor MAC addresses, router sessions, live router state, and UPS state remain excluded, operator-verified, or pending.
- Password owner bootstrap, sessions, CSRF, and approval reauthentication are live. WebAuthn, recovery codes, multiple owners, and trusted proxy identity are not implemented.
- The web process has no direct libvirt or KVM group access. Read-only libvirt inventory and all shipped VM mutations use the restricted helper.
- VM actions are limited to durable approved start, graceful shutdown, reboot request, and autostart jobs. Reboot verification does not yet prove guest application health.
- Supported Linux VM creation, stopped-VM internal snapshots, local stopped-VM exports, mounted-restic VM copies, isolated VM restore drills, guarded stopped no-network recovery clones, and exact no-prune retention batches are durable approved helper jobs. Windows TPM/Secure Boot creation, cloud-init, console proxy, online snapshot, snapshot revert/delete, force-off, in-place restore, recovered-VM network attachment, and application-level restore tests are unavailable.
- Managed media discovery lists regular `.iso` files only and does not upload or download installation media.
- Operations Core jobs and attribution use SQLite. The older VM JSONL planning log remains a separate bounded log. Tamper evidence remains pending.
- Public GitHub provenance is held only in a 15-minute memory cache. GitHub-reported signature and asset-digest fields are not local verification. Tokens, private repositories, arbitrary repository paths, downloads, writes, webhooks, workflow dispatch, and installation are unavailable.
- The Keel Notes adapter is planning-only. It does not discover an existing install, download or hash an asset, validate an archive locally, install Node or Keel, create a service account, write a unit, open a port, start a process, claim an owner, restrict registration, back up or restore data, or activate a migration.
- The recovery kit is evidence and guidance, not a backup. It cannot prove an independent copy of the BoxPilot database, source archive, router configuration, restic password, application credential, or Tailscale account recovery path. Those remain explicit operator checks outside the controller failure domain.
- The Action Center is a transient read-only projection of recovery evidence. It has fixed guidance and view navigation only. It cannot dismiss or persist notices, repair a condition, run a command, install a package, schedule work, request browser notifications, or deliver messages externally. The separately named `smartmontools` workflow exists only in Repair Center.
- Only the exact `smartmontools` repair, fixed Uptime Kuma deployment and backup, exact-address Pi-hole staging and backup, guarded local migration staging, fixed Linux VM creation, lifecycle actions, offline internal snapshots, stopped-VM exports, mounted-restic VM copies, exact-snapshot isolated restore drills, guarded recovery clones, and exact no-prune retention batches can execute mutations. Network assessments and router checkpoints cannot execute. Pi-hole direct DNS acceptance is an approved fixed read-only job in the unprivileged web process and never crosses the root helper. Signed agents can only repeat the four fixed Pi-hole checks from a separately enrolled device. Pi-hole router cutover, router discovery or writes, client DNS advertisement, DHCP, Tailscale changes, remote migration transport, staged-workload activation, firewall, general package, storage administration, general Docker, general libvirt, console proxy, snapshot revert/delete, restic prune, configurable retention, in-place restore, recovery network attachment, and force-off operations remain unavailable.
- A VM snapshot is never counted as an independent backup. The snapshot workflow rejects running guests, non-file disks, disks outside the managed image root, non-qcow2 disks, backing chains, symlinks, and changed inventory.
- Uptime Kuma and Pi-hole application backups remain root-only local artifacts on Bigbox. Their isolated restore health checks are recovery evidence, not independent 3-2-1 protection. VM copies require an operator-provided independent mounted filesystem; no such destination is currently configured on Bigbox.
- VM exports are root-only local integrity artifacts. They are unencrypted and are not reported as protected until a later independent copy and isolated restore boot pass.
- Mounted-restic VM copies begin unprotected. Only the exact backup record whose transient no-network restore and guest-agent health drill passes is promoted to protected.
- Restore-drill protection proves boot and guest-agent health, not application-level network health. The guest must already contain an enabled QEMU guest agent.
- The safe Docker deployment cannot see host libvirt. Live VM support currently requires the native systemd service.
