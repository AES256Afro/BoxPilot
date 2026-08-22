# Curated applications

BoxPilot `0.61.0` provides integrity-addressed manifests, executable Uptime Kuma and Pi-hole deployment plus Start, Stop, and Restart management, a guarded tailnet-only Uptime Kuma access route, three application-aware local backup adapters, encrypted independent exact-archive protection and fixed per-application no-prune retention for verified Uptime Kuma, Pi-hole, and Keel records, and the guarded Keel recovery lifecycle through operator rollback. Repair Center can install the fixed Ubuntu `docker.io` prerequisite on a clean host and the separate fixed KVM, QEMU, and libvirt bundle needed by Virtual Machines. Virtual Machines can then initialize the canonical default NAT network and storage pool through a separate password-approved workflow. The web process never receives the Docker socket or a general root operation.

## Install the Docker prerequisite on Ubuntu

From authenticated **Repair Center**, select **Review Docker install**, inspect the exact configured Ubuntu `docker.io` candidate, stage the immutable plan, and re-enter the owner password. BoxPilot then uses a static no-argument unit to install the pinned candidate, enable and start `docker.service`, and verify the local daemon. An existing client path or installed provider blocks the install so it can be repaired manually rather than replaced.

The console fallback on Ubuntu is:

```bash
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable --now docker.service
sudo docker version
```

Do not add the `boxpilot` web-service account to the `docker` group. The root helper alone invokes fixed Docker argument arrays. The guided repair does not add repositories, configure the daemon, alter groups, pull images, or create containers.

## Manifest contract

Each catalog entry declares:

- Adapter and schema versions
- Deployment targets
- Exact image policy
- Ports and exposure
- Persistent storage
- Prerequisite identifiers
- Health acceptance
- Backup requirement
- Recovery behavior
- Official upstream source
- Canonical SHA-256 manifest integrity digest

The digest detects local manifest drift. It is not yet a third-party signature. Signed adapter distribution belongs to the fleet and plugin milestone.

Authenticated API routes:

- `GET /api/v1/applications` lists manifests and live adapter state.
- `POST /api/v1/applications/:id/plans` creates an immutable plan revision after live prerequisite and port checks.
- `POST /api/v1/application-plans/:id/stage` stages the exact unexpired revision as a durable approval job.
- `POST /api/v1/applications/:id/action-plans` creates a Start, Stop, or Restart plan for Uptime Kuma or Pi-hole bound to the exact managed-container state revision.
- `POST /api/v1/application-action-plans/:id/stage` rechecks and stages that exact lifecycle revision.
- `POST /api/v1/applications/uptime-kuma/private-access-plans` creates a Publish or Unpublish plan derived from the exact managed loopback port and current complete Tailscale Serve state.
- `POST /api/v1/application-private-access-plans/:id/stage` rechecks the application and every non-application Serve route before creating the approval job.
- `POST /api/v1/jobs/:id/approve` revalidates host state, reauthenticates the owner, executes the typed helper operation, verifies health, and records the outcome.

All POST routes require the session CSRF token. A plan cannot execute on its first submission.

## Uptime Kuma evaluation adapter

The adapter follows the official Uptime Kuma v2 Docker layout:

- Image version `2.5.0`, pinned to multi-platform digest `sha256:a8610b3b4c38077922ba51b036691e06887d7cefd91fe620fd3d6d23d03dc240`
- Container name `boxpilot-uptime-kuma`
- Container port `3001`
- Host binding `127.0.0.1:<reviewed port>`
- Persistent data `/var/lib/boxpilot-managed/apps/uptime-kuma/data`
- No privileged mode, added capabilities, devices, Docker socket mount, or broad host mount

Official source: [Uptime Kuma](https://github.com/louislam/uptime-kuma).

Deployment workflow:

1. Open **Applications** and select **Plan deployment** for Uptime Kuma.
2. Choose an available loopback port.
3. Generate a live plan.
4. Resolve every prerequisite and port blocker.
5. Stage the exact revision.
6. Open **Repair Center** and review the checkpoint and recovery statement.
7. Re-enter the owner password.
8. Approve the typed job.
9. Confirm container health and all recorded steps.

If deployment or health verification fails, BoxPilot stops the managed stack and restores the previous Compose definition when one exists. It does not delete the data directory.

After deployment, the Uptime Kuma card exposes only actions allowed by its live state. Start, Stop, and Restart each require a new immutable plan, a second state check while staging, and owner-password approval in Repair Center. The helper refuses a changed or nonconforming container and verifies persistent data after every action. Removal, image updates, port changes, environment editing, volume changes, and network changes remain separate locked workflows.

Version `0.59.0` adds a separate **Plan private access** action. BoxPilot derives the managed loopback port and server tailnet DNS name; the browser cannot choose either. Read-only inspection requires connected Tailscale, parses `tailscale serve status --json`, confirms human-readable `(tailnet only)` state, rejects any unmanaged listener on the app port, and revision-locks the complete remaining Serve configuration. After separate password approval, the helper can run only the fixed Tailscale Serve publish or removal command for that one HTTPS port. Publishing must produce `https://<server tailnet name>:<managed port>/` and remain tailnet only. Funnel, public exposure, BoxPilot's existing HTTPS route, every other Serve route, firewall, DNS, router, application, container, and data must remain unchanged. The verified URL is then shown directly on the application card.

The fixed command shape follows the current official [Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Tailscale access-control rules still apply to the published route.

After deployment, the Backups page can record artifact integrity and an isolated restore test for the Uptime Kuma data directory. Version `0.44.0` can then copy that exact verified archive into the separate encrypted application restic repository, read the complete repository, restore the exact snapshot, and match its size and SHA-256 before reporting independent protection. See [Verified application backups](../BACKUPS.md).

## Keel Notes discovery, safe staging, and private installation adapter

Version `0.41.0` adds the parameter-free `application.keel.inspect` helper operation. It checks only bounded fixed locations and identities: supported per-user Linux install trees and systemd user units, the fixed `/opt/keel` and future BoxPilot-managed roots, Docker containers with the exact Keel service label or name, persistent `/data` coverage, fixed port 3000 exposure, and exact JSON identity from `127.0.0.1:3000/api/health`. Candidate usernames, private paths, container ids, image names, unit contents, `.env`, database contents, secret contents, mount sources, and raw command output never reach the browser. Duplicate, stale, changed, unsafe, or incomplete evidence becomes an explicit risk and blocks the plan.

Version `0.42.0` adds parameter-free `application.keel.artifact.inspect` and UUID-only `application.keel.artifact.acquire`. The latter can run only from an immutable empty-input plan after staging and owner-password approval. It verifies one fixed GitHub release redirect, exact response and streamed byte length, and the complete local SHA-256 before publishing a mode `0600` root-only archive and evidence. It cannot accept an asset, URL, redirect, path, digest, filename, command, argument, service, or extraction choice from the browser. The archive remains inert. See [Keel Notes discovery and inert artifact adapter](KEEL.md).

Version `0.43.0` adds parameter-free `application.keel.archive.inspect`. It rehashes only the fixed local artifact and streams bounded gzip and tar validation without extraction. It returns aggregate counts and fixed risk identifiers, never member names, link targets, member contents, or paths. It correctly blocked the old 1.2.5 release because of one absolute-target symbolic link.

Version `0.46.0` pins the corrected Keel `v1.2.6` Linux x64 asset and enables only inert release staging. The archive gate requires exactly 2,974 safe members, 2,466 regular files, 508 directories, and no links or special members. A second parameter-free staging inspection verifies only the fixed root-owned destination. The immutable plan rechecks clean discovery, exact local bytes, archive membership, Linux x64, required prerequisites, an absent or replaceable helper partial destination, and exact public release provenance.

After staging and owner-password approval, the UUID-only helper operation extracts into one generated partial, rejects links, hard links, state, secrets, changed package identity, missing runtime files, unsafe permissions, and changed membership, then atomically publishes `/var/lib/boxpilot-managed/apps/keel/releases/1.2.6`. Failure removes only the generated partial or newly published inert tree. It does not create `/var/lib/keel`, a service account, systemd unit, process, account, listener, registration setting, access route, backup, or migration.

Version `0.47.0` adds a second immutable plan after safe staging. The parameter-free inspection requires an absent, exact, or explicitly degraded fixed installation boundary. The mutation accepts only a server-generated install UUID after a separate stage and owner-password approval. Its static one-shot creates only the `keel` non-login account and private `/var/lib/keel` state, grants that group read-only access to the immutable release, atomically links `current` to `releases/1.2.6`, writes one exact root-owned environment file and hardened systemd unit, and starts only `127.0.0.1:3000`. Success requires the exact Keel JSON health identity and a private SQLite database. Failure removes generated activation, environment, and unit state but retains `/var/lib/keel` for recovery.

Version `0.48.0` adds a third application-aware local backup adapter. Its immutable plan is available only for the exact installed and healthy managed Keel service. A UUID-only helper operation starts a static no-argument unit that stops only Keel, runs the upstream export as `keel`, creates a root-only non-overwriting archive with complete manifest and tree hashes, restarts and health-checks the source, and opens the restored SQLite copy in a generated loopback-only drill workspace. Integrity, zero foreign-key issues, required schema, restored membership, and workspace removal are mandatory. The workflow starts no second Keel process and cannot change claim, registration, exposure, firewall, DNS, DHCP, router, or production state. Its verified artifact can then use the same separate encrypted application restic workflow as Uptime Kuma and Pi-hole.

Version `0.49.0` adds a separate high-risk recovery-clone plan for only that durable verified Keel archive. The helper accepts one generated recovery id plus exact backup id, archive hash, manifest hash, and size. It derives all paths, rehashes and confines the source archive, repeats its manifest, complete-tree, managed-secret, and SQLite checks, converts portable companions into a live-layout state, validates it again, and atomically publishes root-only evidence. The clone remains stopped with no network. No production state, service, listener, source artifact, claim, registration, firewall, DNS, DHCP, router, or Tailscale state changes.

BoxPilot's web and helper operations never accept a Keel claim token. The owner claims the fresh instance from a normal server administrator terminal with the exact fixed command displayed by the application view. That command forces fresh sudo, rechecks the activation, environment, database ownership, evidence, account, and active service, then drops permanently to the `keel` identity before it invokes the upstream claim transaction. Before claim, private browser access uses an SSH loopback tunnel. BoxPilot does not enable Tailscale Serve, open a firewall, alter registration, or advertise the service.

Version `0.53.0` adds a second terminal-only command for password-based instance-owner login proof. The fixed root parent rechecks the same installation boundary, starts a child that permanently drops to `keel` before prompting, submits Keel's generated login Server Action only to `127.0.0.1:3000`, verifies the instance-owner-only server endpoint, invokes Keel's own logout action, and proves the old session is unauthorized. BoxPilot records only sanitized root-only booleans, release, endpoint, and timestamp. Email, password, cookie, owner identity, response content, and session never enter the web API, helper protocol, database, or logs. WebAuthn redirects are explicitly incomplete.

GitHub metadata matching is not local verification. Acquisition must hash all local bytes, archive inspection must pass, and the staged tree must pass its own evidence check before installation becomes available. The exact identity, install boundary, terminal claim handoff, backup, and remaining recovery gates are documented in [Keel Notes guarded native service and recovery evidence](KEEL.md).

## Pi-hole guarded staging adapter

Version `0.26.0` can stage Pi-hole in Docker on the exact reviewed server LAN address, create a local configuration backup with isolated restore proof, collect fixed direct DNS evidence from the server, and repeat the same fixed checks through a signed enrolled agent. Version `0.58.0` adds revision-bound Start, Stop, and Restart management for only that exact managed container. The separate router checkpoint, GitHub provenance, Keel planning, and recovery-kit views do not alter this application boundary. The dedicated-VM target remains planning-only. These are service staging, lifecycle, recovery-evidence, and direct-path acceptance workflows, not router or client cutover workflows.

The adapter uses:

- Official version `2026.07.2`, pinned to multi-platform digest `sha256:f7d1be836e3bc608b56d82fc9904f5a831cdfbc0dc9c6d58f94e4c985c70038b`
- Container name `boxpilot-pi-hole`
- Exact `<reviewed server LAN>:53` TCP and UDP bindings
- Exact `<reviewed server LAN>:<reviewed high port>` web binding
- Persistent `/var/lib/boxpilot-managed/apps/pi-hole/etc-pihole`
- A generated administrator password stored only in root-owned mode `0600` file `/var/lib/boxpilot-managed/apps/pi-hole/admin-password`
- `cap_drop: ALL`, then only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `NET_BIND_SERVICE`, `SETFCAP`, `SETGID`, and `SETUID`
- `no-new-privileges:true`
- The upstream container DNS health check plus exact published-binding verification

The Compose definition publishes no DHCP port 67 or NTP port 123, adds no `NET_ADMIN` or `SYS_TIME`, uses no host network, mounts no Docker socket, and accepts no browser-provided image, path, password, capability, command, binary, or argument array.

Official source: [Docker Pi-hole](https://github.com/pi-hole/docker-pi-hole).

Deployment workflow:

1. Open **Network** and select **Pi-hole on the server**.
2. Confirm the live gateway, server address, proposed primary address, and independent emergency resolver.
3. Record the external router checkpoint, independently test the emergency resolver, keep a second LAN device ready, and declare the actual Tailscale DNS override state.
4. Generate a ready no-change assessment. It is owner-attributable and expires.
5. Open **Applications**, select Pi-hole, choose a high LAN web port, and generate the linked plan.
6. Stage the exact revision, open **Repair Center**, review the network-critical recovery statement, and re-enter the owner password.
7. After the background job passes, open the reported LAN URL. Retrieve the administrator password only from a server terminal with the command shown by BoxPilot.
8. Keep every router and client on the current resolver. The application remains **Backup: required** until the separate backup workflow passes.

At planning, staging, and approval, BoxPilot revalidates the assessment owner, role, expiry, gateway, server address, current resolvers, DNS listeners, Tailscale state, recovery declarations, Docker, and web port. Docker planning tests TCP and UDP port 53 specifically on the reviewed server LAN address, so Ubuntu's loopback systemd-resolved stub is not treated as a conflicting LAN listener. A real TCP or UDP conflict on that exact address blocks deployment. If any evidence changes, the job fails closed and requires a new assessment.

After deployment, the Pi-hole card exposes only the actions allowed by its live state. Each lifecycle plan pins the complete sanitized identity: reserved name, digest image, Compose labels, private-LAN DNS and web bindings, fixed configuration mount, root-only secret-file metadata, restart policy, exact capability allowlist, `CAP_DROP=ALL`, `no-new-privileges`, privileges, devices, and Docker-socket absence. Start and Restart require healthy DNS and web bindings after the action. Stop verifies the container stopped while configuration and the secret remain present. Every plan requires a tested independent resolver and makes no DHCP, router, client DNS, firewall, Tailscale, image, Compose, port, storage, secret, or other-container change.

After staging, open **Backups** and plan the Pi-hole backup. The separate network-critical job:

1. Revalidates Pi-hole health, exact bindings, Docker, helper, and storage readiness.
2. Stops only `boxpilot-pi-hole` long enough to archive `etc-pihole`, the curated Compose definition, and the root-only administrator secret.
3. Restarts the source and requires both its health check and original TCP, UDP, and web bindings to pass.
4. Records artifact SHA-256, byte size, and measured source downtime.
5. Extracts the artifact beneath the helper-owned temporary restore root.
6. Starts the same digest-pinned image with `--network none`, no published ports, `cap_drop: ALL`, the same narrow capability set, and `no-new-privileges:true`.
7. Requires restore health, removes the temporary container and workspace, and records configuration, secret, isolation, and no-cutover evidence.

The artifact is mode `0600` beneath `/var/lib/boxpilot-managed/backups/pi-hole`. It contains the administrator secret and must be treated as sensitive. Its local no-network boot drill is required before the `0.44.0` independent application-protection plan can encrypt it in `restic-applications`, read the complete repository, and prove an exact restored hash. Until that second workflow passes, it remains locally verified only.

After the backup passes, open **Network** and plan the fixed direct DNS checks. BoxPilot derives the exact managed address and sends only `pi.hole` over UDP and TCP, `example.com` over UDP, and `boxpilot.invalid` over UDP after a separate password approval. The passing record links the deployment, original assessment, and backup, but is labeled as server-only evidence.

BoxPilot still will not make Pi-hole authoritative until later milestones can prove:

- A passing live direct DNS run from the server and cryptographically attributable proof from a separately enrolled LAN device
- A separately reviewed router advertisement plan with model-specific rollback
- A stable observation window while the current resolver remains available

If deployment or health verification fails, BoxPilot removes only the managed stack or restores the previous managed Compose definition. Configuration and the administrator secret are preserved. DHCP, NTP, router mutation, client DNS advertisement, Tailscale mutation, firewall mutation, and automatic DNS cutover remain unavailable.
