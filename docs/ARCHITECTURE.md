# BoxPilot architecture

## Product boundary

BoxPilot is a local-first management plane for one Ubuntu server. The normal operator uses a browser from another LAN or Tailscale device. Cloud accounts are optional integrations, not a requirement for operating the server.

Version `0.34.0` adds unprivileged host-maintenance collectors for fixed systemd, reboot-marker, dpkg fragment, APT metadata, and unattended-upgrades state. Only derived states, bounded counts, and metadata age are returned. No package name, failed unit name, reboot reason, raw output, APT operation, service control, update-policy mutation, or host reboot is available.

Version `0.35.0` adds a separately named durable APT metadata refresh. The browser can request only an empty plan and immutable revision. The root helper accepts only the exact previous metadata timestamp, writes a short-lived marker, and starts a static networked oneshot. That unit runs only `apt-get update --error-on=any`, proves `/var/lib/dpkg/status` is unchanged, and returns current bounded evidence. The main helper remains `PrivateNetwork=true`; no general package, repository, command, option, target, install, upgrade, removal, service control, or reboot operation is added.

Version `0.36.0` adds a separate Flint 2 direct-gateway DNS acceptance job. The target is derived only from one live default route, and the immutable plan requires a retained Flint 2 checkpoint, connected Tailscale recovery, and six exact operator declarations. The unprivileged controller sends four fixed DNS queries and records bounded response evidence. The helper is not called. No router credential, session, arbitrary target, model attestation, configuration read, setting write, DHCP change, DNS advertisement, VPN change, client change, or cutover is added.

Version `0.37.0` adds a second signed agent task contract linked only to fresh passing Flint 2 controller evidence. The Linux or macOS agent re-derives one local IPv4 default gateway and must match the controller target before sending the four fixed queries. Tasks remain owner-password approved, one-shot, delayed only by 0, 5, or 10 minutes, and valid for exactly 10 minutes. No shell, arbitrary command, arbitrary target, recurrence, unattended execution, router write, or model attestation is added.

Version `0.38.0` adds an owner-approved backup of the fixed live controller database. The restricted helper derives every path, takes a consistent standalone SQLite snapshot with `VACUUM INTO`, verifies SHA-256, integrity, foreign keys, required schema, and owner state, repeats those checks on a separate copy, removes the drill workspace, and writes a root-only manifest. BoxPilot remains online and its production database is never replaced or changed. The browser supplies only a server-generated UUID. Scheduling, retention, download, off-host transport, and automatic production restore are not added.

Version `0.38.1` corrects the Backups data-source disclosure and empty-state language so the controller copy-open drill is not described as an application container health check. It does not change the helper, database, job, or recovery contract.

Version `0.39.0` adds a second controller protection stage. The web process can bind an immutable plan only to an existing verified local controller backup and fixed destination revision. The helper accepts no paths, passwords, repositories, commands, or restic options. It requires a separate exact mounted filesystem and controller recovery password, snapshots the complete local backup directory into `restic-controller`, reads all repository data, restores the exact snapshot with verification, repeats both hashes and the SQLite safety checks, removes a successful drill workspace, and stores independent protection evidence in a separate table. No retention, prune, automatic restore, or live database mutation is added.

Version `0.40.0` adds one fixed controller-retention policy. It keeps the three newest active protected snapshots, every snapshot younger than 30 days, every snapshot without complete passing restore evidence, and every snapshot referenced by an active controller protection or retention job. A high-risk immutable plan contains at most 100 exact old snapshot ids and the complete destination and snapshot-set evidence. The helper revalidates the fixed repository and inventory, forgets only those ids, performs a complete post-mutation repository data read, proves every candidate absent and every reviewed noncandidate present, and returns bounded partial-removal evidence when later verification fails. Durable state never presents a confirmed forgotten record as protected or retained. No browser policy, selector, path, password, repository, schedule, prune, space reclamation, local-artifact deletion, production restore, or live database mutation is added.

Version `0.40.1` corrects the Backups data-source disclosure to describe the already shipped controller protection and retention boundary while leaving independent application destinations and scheduling explicitly pending. No helper, job, state, API, or mutation contract changes.

Version `0.41.0` adds parameter-free Keel Notes discovery across the supported per-user Linux layout and exact Docker identity signals. The root helper returns fixed labels, counts, booleans, version, listener posture, health identity, and risk ids while excluding usernames, private paths, unit contents, container ids, images, environments, mount sources, databases, and secrets. It performs no write, service, container, database, claim, exposure, or network mutation. Discovery evidence is refreshed in both catalog and plan views; ambiguity and unsafe exposure fail closed.

Version `0.42.0` adds an inert Keel release acquisition boundary. The browser supplies only an empty planning object and immutable revision. After password approval, the network-isolated root helper accepts only a server-generated UUID, creates a fixed root-only directory and marker, and starts a static separately sandboxed network one-shot. The one-shot permits only the compiled HTTPS GitHub release and reviewed release-asset redirect shape, then requires exact response length, streamed byte count, and full SHA-256 before atomically publishing the mode `0600` archive and evidence. It accepts no browser URL, path, filename, digest, redirect, command, or argument. No extraction, execution, installation, service change, claim, registration change, exposure, backup, restore, or import is added.

Version `0.43.0` adds a read-only archive-membership boundary. The helper accepts only an empty parameter object, opens only the fixed no-follow root-owned archive, rechecks its compressed identity, and streams bounded gzip and tar validation without creating an extraction tree. Aggregate counts and fixed risk identifiers are the only member evidence returned. The exact 1.2.5 archive is blocked because it contains one symbolic link with an absolute GitHub Actions build-workspace target. No link is followed, rewritten, omitted, or extracted, and no service or application state is created.

Version `0.44.0` adds a separate application disaster-protection boundary. The browser selects only a durable verified Uptime Kuma or Pi-hole backup record. The immutable plan pins its application id, two UUIDs, SHA-256, size, and the inspected destination revision. The helper derives the fixed local archive, `restic-applications` repository, separate root-only password file, cache, and generated drill path. It performs a complete repository data read and restores the exact snapshot for byte-for-byte size and hash verification. The earlier adapter-aware no-network container drill remains part of the durable source evidence. No application, router, DNS, local archive, retention, prune, or production restore mutation occurs.

Version `0.45.0` adds a narrow package prerequisite boundary for the hard-coded `restic` package. The browser can create only an empty-input plan and later submit its immutable revision plus the normal owner-password approval. The main helper accepts only a bounded exact version, rechecks configured APT evidence, writes one short-lived root-only marker, and starts one static no-argument package unit. That unit independently rechecks the candidate, installs only the pinned `restic` version, verifies dpkg state, and probes the fixed binary. It has no storage, password, repository, backup, restore, retention, prune, or removal operation. The main helper retains `PrivateNetwork=true`; only the package oneshot can reach configured repositories.

Version `0.46.0` adds a separate Keel inert-staging boundary. Read-only staging inspection accepts no parameters and never repairs files. The mutation accepts only a server-generated UUID from a staged immutable plan after owner-password approval. The helper derives the artifact, partial, release, evidence, and runtime paths; rechecks exact artifact and archive evidence; extracts with fixed arguments; rejects links, hard links, state, secrets, unsafe package identity, and changed membership; hardens the tree; and atomically publishes one root-only release. It never creates writable application state, a user, service, process, listener, account, registration setting, or network route.

Version `0.47.0` adds a separate Keel native-install boundary. Parameter-free inspection reads only the fixed account shape, activation link, unit and environment hashes, state modes, install evidence, systemd state, release identity, database presence, and bounded loopback health. After a distinct immutable plan and owner-password approval, the helper accepts only a server-generated install UUID and invokes one static root one-shot with no arguments. It creates a dedicated non-login account, private state, one immutable activation link, one exact hardened unit, and one loopback listener. Exact JSON health and a private SQLite database are mandatory. Failure removes generated unit, environment, and activation state while retaining application state. Claim tokens, registration settings, browser-supplied environment, firewall changes, Tailscale exposure, DNS, DHCP, router operations, backup, restore, import, update, adoption, and removal have no install route.

Version `0.48.0` adds a separate Keel backup boundary. The web process plans from bounded install and controller-loopback health evidence. After separate staging and owner-password approval, the helper accepts only a server-generated backup UUID, writes a five-minute root-only marker, and starts a static no-argument one-shot. That unit stops only Keel, runs the upstream export as the dedicated account, creates a root-only manifest and archive, restarts and health-checks the source, and verifies an isolated restored SQLite copy. Its network sandbox permits loopback only. Result validation requires full archive and manifest hashes, tree identity, database integrity, zero foreign-key issues, required schema, source restart, no second application, removed drill workspace, and unchanged claim, registration, Tailscale, firewall, router, and production state. A durable local record can then enter the existing exact encrypted application-protection workflow.

Version `0.49.0` adds a distinct Keel recovery-clone boundary. The web process selects only a durable verified backup id and pins a generated recovery id plus exact archive hash, manifest hash, and size. The private-network helper derives all paths, revalidates the root-owned source result and archive, confines archive membership to one fixed root, extracts into a generated partial, repeats tree, managed-secret, and SQLite validation, transforms portable companions into a root-only live-layout state, validates it again, writes evidence, and publishes by atomic rename. The clone is stopped data at rest with no network. No route exists to start it, promote it into `/var/lib/keel`, delete it, alter production, or accept a browser path or command.

Version `0.50.0` adds a separate Keel recovery-drill boundary. The web process selects only a durable stopped recovery id. Planning pins a generated drill id, the root-only recovery evidence checksum, and complete state-tree digest. The network-isolated helper writes only a short-lived fixed marker and starts one static no-argument unit. That unit copies the recovery into a generated writable partial, runs the exact release as the non-login `keel` account, and checks health plus SQLite before cleanly stopping the process and deleting the copy. `PrivateNetwork=true`, loopback-only address policy, zero published ports, and read-only source, release, and production mounts keep the process isolated. Strict durable results record process start and stop, health identity, database health, source immutability, workspace removal, and explicit no-login no-promotion boundaries.

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
          |       systemd, host maintenance, host interfaces, fixed routes, resolvers, listener scopes, local NUT, and bounded host state
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
          +---- Keel discovery, inert exact-release acquisition, and blocked runtime archive gate (0.43.0)
          +---- Encrypted independent Uptime Kuma and Pi-hole exact-archive protection (0.44.0)
          +---- Exact-version restic package prerequisite repair without repository setup (0.45.0)
          +---- Secret-free recovery readiness and ordered runbook export (0.26.0)
          +---- Fixed-model router guidance and gateway-address correlation (0.27.0)
          +---- Owner-approved one-shot signed DNS proof windows (0.28.0)
          +---- Read-only fail-closed local Action Center (0.29.0)
          +---- Sanitized host storage inventory and fixed-source support bundle (0.30.1)
          +---- Durable exact-version smartmontools repair plan and approval (0.31.0)
          +---- Mounted ext4 kernel error-counter evidence (0.32.0)
          +---- Fixed-localhost read-only UPS evidence (0.33.0)
          +---- Bounded host-maintenance readiness evidence (0.34.0)
          +---- Durable fixed APT metadata-only refresh plan and approval (0.35.0)
          +---- Durable fixed Flint 2 observed-gateway DNS acceptance (0.36.0)
          +---- Signed node-local-gateway Flint 2 second-device evidence (0.37.0)
          +---- Durable WAL-aware controller snapshot and isolated copy-open evidence (0.38.0)
          +---- Durable encrypted independent controller copy and exact database restore proof (0.39.0)
          +---- Durable fixed no-prune controller retention with exact removal evidence (0.40.0)
          |
          +<--- Ed25519 signed polling and fixed Pi-hole or Flint 2 evidence from an enrolled LAN agent
                  Flint 2 target must match the node-local default gateway
                  no remote shell, arbitrary command, arbitrary target, or private-key transfer
          |
          +---- Redacted VM audit JSONL in systemd StateDirectory (0.3.0 foundation)
          |
          v
Restricted helper over a local Unix socket (0.4.0 canary foundation)
          |
          +---- typed no-mutation canary (0.4.0)
          +---- fixed smartmontools inspect and exact-version package-unit handoff (0.31.0)
          +---- fixed restic inspect and exact-version package-unit handoff without repository setup (0.45.0)
          +---- fixed APT metadata inspect and static update-only unit handoff (0.35.0)
          +---- fixed controller database inspect, snapshot, manifest, and isolated copy-open drill (0.38.0)
          +---- fixed controller mounted-restic inspect, full read, exact restore, and copy-open drill (0.39.0)
          +---- fixed exact old protected controller snapshot forget and full post-read proof (0.40.0)
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
          +---- additional typed package operations (future)
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

Uptime Kuma is the low-risk canary adapter because it proves fixed Docker arguments, local persistent storage, loopback exposure, health checks, and rollback. Pi-hole is the first network-critical staging adapter. It adds an owner-attributable live network assessment, exact LAN bindings, helper-owned secret generation, least tested capabilities, no-cutover result evidence, and rollback while keeping every router and client unchanged. Keel Notes is the first stateful native-service adapter. Version `0.25.0` binds its plan to an exact release identity and documents database, managed-secret, upload, private-claim, health, backup, restore, and rollback gates. Versions `0.41.0` through `0.43.0` add bounded discovery, inert artifact acquisition, and archive membership inspection. Version `0.46.0` pins corrected 1.2.6 and permits only verified inert root-owned extraction. Version `0.47.0` adds a separate guarded native installation with dedicated identity, private state, immutable activation, exact loopback service configuration, health proof, and state-preserving rollback. Version `0.48.0` adds a consistent service-identity export, guaranteed restart, complete tree proof, isolated SQLite-open recovery drill, and independent-protection eligibility. Version `0.49.0` adds a stopped root-only recovery clone without production replacement or network attachment. Version `0.50.0` adds a disposable private-network startup and health rehearsal without starting the source recovery or promoting production. Claim remains terminal-only; owner-login proof, production restore, recovery promotion, import, adoption, update, removal, and private exposure remain separate unavailable operations.

## Data model target

The persistent store is SQLite. Owners, sessions, jobs, job steps, approvals, plans, controller and application backups, controller protection and retention runs, Pi-hole and Flint 2 gateway DNS acceptance runs, fleet agents, one-time enrollment token digests, fleet tasks, signed evidence, router checkpoint metadata, VM exports, VM backups, VM recoveries, VM retention runs, imported migration sources, verified migration transfers, and audit events are live. Planned records include:

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

A successful copy is not a verified backup. The controller adapter requires a consistent standalone snapshot plus an isolated checksum, open, integrity, foreign-key, schema, and owner-state drill. Application protection requires both the prior adapter-aware no-network container drill and a separate encrypted independent repository copy whose exact restored archive size and hash match. VM adapters apply their own recovery contracts. BoxPilot reports a workload as protected only when:

- The adapter knows every required data and secret component
- The last backup completed without excluded critical paths
- Artifact integrity checks passed
- Encryption and recovery keys meet policy
- A restore drill passed within the configured interval

## Version 0.50.0 limitations

- The current Overview is authenticated live inventory. The retained `0.3.0` overview screenshot is demonstration data, and Settings remains guidance rather than an editable network configuration surface.
- Compose inspection is a lightweight browser-only scan, not a full YAML policy engine.
- Host, sanitized real mounts and block topology, mounted ext4 kernel error counters, selected systemd services, Docker, libvirt, Tailscale self-state, fixed routes, resolver addresses, scoped port 53 listeners, and fixed journal sources are live. SMART evidence is available only when the fixed root-only timer has a recent successful `smartctl` result; absent or stale evidence fails closed. Non-ext4 filesystem counters remain unsupported. Serial numbers, UUIDs, raw SMART output, mount option values, private home paths, physical router identity, operating mode, cabling, DHCP authority, neighbor MAC addresses, router sessions, live router state, and UPS state remain excluded, operator-verified, or pending.
- Password owner bootstrap, sessions, CSRF, and approval reauthentication are live. WebAuthn, recovery codes, multiple owners, and trusted proxy identity are not implemented.
- The web process has no direct libvirt or KVM group access. Read-only libvirt inventory and all shipped VM mutations use the restricted helper.
- VM actions are limited to durable approved start, graceful shutdown, reboot request, and autostart jobs. Reboot verification does not yet prove guest application health.
- Supported Linux VM creation, stopped-VM internal snapshots, local stopped-VM exports, mounted-restic VM copies, isolated VM restore drills, guarded stopped no-network recovery clones, and exact no-prune retention batches are durable approved helper jobs. Windows TPM/Secure Boot creation, cloud-init, console proxy, online snapshot, snapshot revert/delete, force-off, in-place restore, recovered-VM network attachment, and application-level restore tests are unavailable.
- Managed media discovery lists regular `.iso` files only and does not upload or download installation media.
- Operations Core jobs and attribution use SQLite. The older VM JSONL planning log remains a separate bounded log. Tamper evidence remains pending.
- Public GitHub provenance is held only in a 15-minute memory cache. GitHub-reported signature and asset-digest fields are not local verification. Keel has separate fixed-release locally verified artifact, staging, and install jobs. Tokens, private repositories, arbitrary repository paths or downloads, browser downloads, writes, webhooks, and workflow dispatch are unavailable.
- The Keel Notes adapter discovers bounded supported per-user service and exact Docker signals, acquires only fixed 1.2.6 bytes, validates archive membership without extraction, stages the exact root-owned tree, installs that tree as a hardened loopback-only native service, creates a consistent local export with isolated SQLite-open verification, materializes a separately approved stopped root-only recovery clone, and can start only a generated disposable copy in a private network namespace for health proof. Inspection does not read `.env`, open the database, read the managed-secret key, or follow user-supplied paths. The backup, recovery, and startup-rehearsal jobs open only generated copies and return no content. Web and helper operations do not accept a claim token. The separate interactive terminal handoff forces fresh sudo, rechecks the exact fixed installation, permanently drops to the `keel` account, and then runs the upstream one-use claim transaction. PostgreSQL or Litestream detection, Node installation, adoption, registration restriction, owner-login proof, Tailscale exposure, production restore, source recovery start, promotion, import, migration activation, update, removal, and retained-state deletion remain unavailable.
- The recovery kit is evidence and guidance, not a backup. It can report stored encrypted independent controller and application evidence only after their exact restore gates pass, but it cannot prove that the operator retained each repository password in a separate failure domain. It also cannot prove an independent source archive, router configuration file, application credential, or Tailscale account recovery path.
- The Action Center is a transient read-only projection of recovery evidence. It has fixed guidance and view navigation only. It cannot dismiss or persist notices, repair a condition, run a command, install a package, schedule work, request browser notifications, or deliver messages externally. The separately named `smartmontools`, `restic`, and APT metadata workflows exist only in Repair Center.
- Only the exact `smartmontools` and `restic` repairs, fixed local controller backup, fixed mounted-restic controller and application protection, exact no-prune controller retention batch, fixed Uptime Kuma deployment and backup, exact-address Pi-hole staging and backup, fixed Keel artifact, stage, install, backup, and stopped recovery-clone jobs, guarded local migration staging, fixed Linux VM creation, lifecycle actions, offline internal snapshots, stopped-VM exports, mounted-restic VM copies, exact-snapshot isolated restore drills, guarded recovery clones, and exact no-prune VM retention batches can execute mutations. The restic repair installs and verifies only the package; it cannot configure storage, keys, or repositories. Network assessments and router checkpoints cannot execute. Pi-hole and Flint 2 direct DNS acceptance are approved fixed read-only jobs in the unprivileged web process and never cross the root helper. Signed agents can repeat only the four fixed Pi-hole checks or four fixed Flint 2 checks, with a mandatory node-local default-gateway match for Flint 2. Backup scheduling, application retention, configurable controller retention, prune, remote/cloud adapters, browser download, and automatic production restore remain unavailable.
- A VM snapshot is never counted as an independent backup. The snapshot workflow rejects running guests, non-file disks, disks outside the managed image root, non-qcow2 disks, backing chains, symlinks, and changed inventory.
- Controller, Uptime Kuma, Pi-hole, and Keel backups begin as root-only local artifacts on Bigbox. A controller record is protected only after its separate encrypted repository copy, complete read, and exact database restore drill pass. An application record is protected only after its adapter-aware no-network container or SQLite-open drill plus the separate encrypted repository copy, complete read, and exact restored archive hash pass. The fixed controller-retention policy can later mark exact old controller references as forgotten while retaining every local controller artifact; application retention does not exist. These workflows require an operator-provided independent mounted filesystem. No such destination is currently configured on Bigbox, so no live controller or application protection or retention mutation exists there.
- VM exports are root-only local integrity artifacts. They are unencrypted and are not reported as protected until a later independent copy and isolated restore boot pass.
- Mounted-restic VM copies begin unprotected. Only the exact backup record whose transient no-network restore and guest-agent health drill passes is promoted to protected.
- Restore-drill protection proves boot and guest-agent health, not application-level network health. The guest must already contain an enabled QEMU guest agent.
- The safe Docker deployment cannot see host libvirt. Live VM support currently requires the native systemd service.
