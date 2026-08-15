# BoxPilot architecture

## Product boundary

BoxPilot is a local-first management plane for one Ubuntu server. The normal operator uses a browser from another LAN or Tailscale device. Cloud accounts are optional integrations, not a requirement for operating the server.

Version `0.12.0` adds immutable stopped-VM export plans and long-running approved jobs. The helper alone derives source disks and the fixed local export root, converts each disk to standalone qcow2, checks structure, compares content, and creates a SHA-256 manifest. The result is explicitly local, unencrypted, restore-untested, and unprotected. The native web unit retains no direct libvirt or KVM group access.

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
          |       systemd, host interfaces, and bounded host state
          |
          +---- Durable VM creation plans and approved jobs (0.9.0)
          +---- Durable VM lifecycle plans and approved jobs (0.10.0)
          +---- Durable offline snapshot plans and approved jobs (0.11.0)
          +---- Durable stopped-VM local export plans and approved background jobs (0.12.0)
          |
          +---- Redacted VM audit JSONL in systemd StateDirectory (0.3.0 foundation)
          |
          v
Restricted helper over a local Unix socket (0.4.0 canary foundation)
          |
          +---- typed no-mutation canary (0.4.0)
          +---- fixed Uptime Kuma inspect, deploy, health, and rollback (0.5.0)
          +---- fixed Linux VM creation, verification, and exact-domain rollback (0.9.0)
          +---- fixed VM start, graceful shutdown, reboot request, and autostart operations (0.10.0)
          +---- bounded libvirt, guest-agent, and snapshot inventory (0.11.0)
          +---- parameter-free Cockpit socket detection for console handoff (0.11.0)
          +---- stopped-VM internal snapshot creation with managed qcow2 confinement (0.11.0)
          +---- stopped-VM standalone qcow2 export and integrity evidence (0.12.0)
          +---- typed apt operations (future)
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

Uptime Kuma is the first executable adapter because it proves fixed Docker arguments, local persistent storage, loopback exposure, health checks, and rollback without handling a critical network role. Keel Notes remains the first planned backup and migration adapter because it exercises databases, managed secrets, file storage, Docker, restore testing, and migration.

## Data model target

The persistent store is SQLite. Version `0.4.0` includes owners, sessions, jobs, job steps, approvals, and audit events. Planned records include:

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

## Version 0.12.0 limitations

- Dashboard values are demonstration data.
- Compose inspection is a lightweight browser-only scan, not a full YAML policy engine.
- Host, selected systemd services, Docker, libvirt, Tailscale self-state, and fixed journal sources are live. SMART and general hardware inspection remain pending.
- Password owner bootstrap, sessions, CSRF, and approval reauthentication are live. WebAuthn, recovery codes, multiple owners, and trusted proxy identity are not implemented.
- The web process has no direct libvirt or KVM group access. Read-only libvirt inventory and all shipped VM mutations use the restricted helper.
- VM actions are limited to durable approved start, graceful shutdown, reboot request, and autostart jobs. Reboot verification does not yet prove guest application health.
- Supported Linux VM creation, stopped-VM internal snapshots, and local stopped-VM exports are durable approved helper jobs. Windows TPM/Secure Boot, cloud-init, console proxy, online snapshot, snapshot revert/delete, force-off, protected VM backup, and restore execution are unavailable.
- Managed media discovery lists regular `.iso` files only and does not upload or download installation media.
- Operations Core jobs and attribution use SQLite. The older VM JSONL planning log remains a separate bounded log. Tamper evidence remains pending.
- Only fixed Uptime Kuma deployment and backup plus fixed Linux VM creation, lifecycle actions, offline internal snapshots, and stopped-VM exports can execute mutations. Migration transfer, firewall, package, storage administration, general Docker, general libvirt, console proxy, snapshot revert/delete, and force-off operations remain unavailable.
- A VM snapshot is never counted as an independent backup. The snapshot workflow rejects running guests, non-file disks, disks outside the managed image root, non-qcow2 disks, backing chains, symlinks, and changed inventory.
- The backup destination is local to Bigbox. It does not protect against host or disk loss until an independent destination adapter is added.
- VM exports are root-only local integrity artifacts. They are unencrypted and are not reported as protected until a later independent copy and isolated restore boot pass.
- The safe Docker deployment cannot see host libvirt. Live VM support currently requires the native systemd service.
