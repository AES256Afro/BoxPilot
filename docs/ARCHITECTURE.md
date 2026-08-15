# BoxPilot architecture

## Product boundary

BoxPilot is a local-first management plane for one Ubuntu server. The normal operator uses a browser from another LAN or Tailscale device. Cloud accounts are optional integrations, not a requirement for operating the server.

Version `0.6.0` adds a fixed application-aware backup operation to the integrity-addressed application and durable-job foundations. Uptime Kuma archives are produced only after a clean stop, the source is restarted and verified, and the artifact is restore-tested inside a temporary container with no network or published ports. Live libvirt inspection, read-only VM creation planning, and the provisional VM lifecycle route remain available after authentication. BoxPilot still cannot install packages, deploy arbitrary Compose, apply VM creation plans, delete VMs, change networks or storage, open consoles, or execute arbitrary commands.

Because the native process belongs to `libvirt`, this is an intermediate boundary rather than the final security model. The restricted helper described below remains the target for all mutations.

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
          +---- Read-only collectors
          |       systemd, journald, SMART, Docker, libvirt, Tailscale
          |
          +---- Provisional fixed libvirt lifecycle allowlist (0.2.0)
          |
          +---- Validated non-executing VM creation planner (0.3.0)
          |
          +---- Redacted VM audit JSONL in systemd StateDirectory (0.3.0 foundation)
          |
          v
Restricted helper over a local Unix socket (0.4.0 canary foundation)
          |
          +---- typed no-mutation canary (0.4.0)
          +---- fixed Uptime Kuma inspect, deploy, health, and rollback (0.5.0)
          +---- typed apt operations (future)
          +---- typed systemd operations
          +---- typed firewall operations
          +---- typed storage and backup operations
          +---- adapter-owned Docker and libvirt operations
```

The web process must never accept an arbitrary command string for privileged execution. The helper receives validated operation names and typed parameters, applies an allowlist, records an audit event, and returns structured output.

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
- Uses `execFile` with fixed libvirt verbs and validated domain names for the provisional VM lifecycle route
- Stores encrypted integration secrets separately from ordinary job data
- Redacts secret-like values before persistence and display

### Privileged helper

- Runs as a separate, minimal system service
- Listens only on a root-owned Unix socket
- Accepts no shell fragments or arbitrary paths
- Enforces operation-specific path roots and argument schemas
- Has no inbound network listener
- Emits an append-only audit record for every request

## Access model

The recommended path is:

1. BoxPilot listens on `127.0.0.1:8787`.
2. Tailscale Serve provides private HTTPS inside the tailnet.
3. Tailscale Funnel remains disabled.
4. Full BoxPilot authentication remains required even when Tailscale is present.
5. LAN listening is opt-in and requires TLS or a trusted reverse proxy.

Tailscale provides the private network path. It does not replace application authorization, audit trails, or reauthentication for destructive changes. In `0.2.0`, the administrator token authorizes only the VM lifecycle route. It is not a full login layer, so the service must remain loopback-only behind Tailscale Serve.

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

## Version 0.6.0 limitations

- Dashboard values are demonstration data.
- Compose inspection is a lightweight browser-only scan, not a full YAML policy engine.
- Only the libvirt and Tailscale portions of host inspection are live.
- Password owner bootstrap, sessions, CSRF, and approval reauthentication are live. WebAuthn, recovery codes, multiple owners, and trusted proxy identity are not implemented.
- The web process has `libvirt` group permissions in the host-native deployment. Mutations have not yet moved to the restricted helper.
- VM actions are limited to start, graceful shutdown, reboot, and autostart. They are disabled unless explicitly configured.
- VM creation stops at a validated plan. The displayed `virt-install` argument array has no Apply route.
- Managed media discovery lists regular `.iso` files only and does not upload or download installation media.
- Operations Core jobs and attribution use SQLite. The older VM JSONL audit remains a separate bounded log until VM actions migrate into the durable executor. Tamper evidence remains pending.
- Only fixed Uptime Kuma deployment and backup adapters can execute application mutations. Migration, firewall, package, storage, general Docker, VM creation, console, snapshot, delete, and force-off operations remain unavailable.
- The backup destination is local to Bigbox. It does not protect against host or disk loss until an independent destination adapter is added.
- The safe Docker deployment cannot see host libvirt. Live VM support currently requires the native systemd service.
