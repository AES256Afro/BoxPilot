# Curated applications

BoxPilot `0.46.0` provides integrity-addressed manifests, executable Uptime Kuma and guarded Pi-hole adapters, two application-aware local backup adapters, and encrypted independent exact-archive protection for verified Uptime Kuma and Pi-hole records. Its Keel Notes adapter adds read-only discovery, separately approved fixed artifact acquisition, parameter-free archive and staging inspection, and password-approved extraction of the exact corrected `v1.2.6` release into an inert root-only tree. Keel installation, execution, writable state, accounts, registration, listeners, claim, backup, restore, import, adoption, update, and exposure remain locked. The web process never receives the Docker socket or a general root operation.

## Install the Docker prerequisite on Ubuntu

Docker package installation remains a server-terminal bootstrap action in this release. On Ubuntu 26.04:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker.service
sudo docker version
sudo docker compose version
```

Do not add the `boxpilot` web-service account to the `docker` group. The root helper alone invokes fixed Docker argument arrays. Refresh **Repair Center** after installation.

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

After deployment, the Backups page can record artifact integrity and an isolated restore test for the Uptime Kuma data directory. Version `0.44.0` can then copy that exact verified archive into the separate encrypted application restic repository, read the complete repository, restore the exact snapshot, and match its size and SHA-256 before reporting independent protection. See [Verified application backups](BACKUPS.md).

## Keel Notes discovery and safe release staging adapter

Version `0.41.0` adds the parameter-free `application.keel.inspect` helper operation. It checks only bounded fixed locations and identities: supported per-user Linux install trees and systemd user units, the fixed `/opt/keel` and future BoxPilot-managed roots, Docker containers with the exact Keel service label or name, persistent `/data` coverage, fixed port 3000 exposure, and exact JSON identity from `127.0.0.1:3000/api/health`. Candidate usernames, private paths, container ids, image names, unit contents, `.env`, database contents, secret contents, mount sources, and raw command output never reach the browser. Duplicate, stale, changed, unsafe, or incomplete evidence becomes an explicit risk and blocks the plan.

Version `0.42.0` adds parameter-free `application.keel.artifact.inspect` and UUID-only `application.keel.artifact.acquire`. The latter can run only from an immutable empty-input plan after staging and owner-password approval. It verifies one fixed GitHub release redirect, exact response and streamed byte length, and the complete local SHA-256 before publishing a mode `0600` root-only archive and evidence. It cannot accept an asset, URL, redirect, path, digest, filename, command, argument, service, or extraction choice from the browser. The archive remains inert. See [Keel Notes discovery and inert artifact adapter](KEEL.md).

Version `0.43.0` adds parameter-free `application.keel.archive.inspect`. It rehashes only the fixed local artifact and streams bounded gzip and tar validation without extraction. It returns aggregate counts and fixed risk identifiers, never member names, link targets, member contents, or paths. It correctly blocked the old 1.2.5 release because of one absolute-target symbolic link.

Version `0.46.0` pins the corrected Keel `v1.2.6` Linux x64 asset and enables only inert release staging. The archive gate requires exactly 2,974 safe members, 2,466 regular files, 508 directories, and no links or special members. A second parameter-free staging inspection verifies only the fixed root-owned destination. The immutable plan rechecks clean discovery, exact local bytes, archive membership, Linux x64, required prerequisites, an absent or replaceable helper partial destination, and exact public release provenance.

After staging and owner-password approval, the UUID-only helper operation extracts into one generated partial, rejects links, hard links, state, secrets, changed package identity, missing runtime files, unsafe permissions, and changed membership, then atomically publishes `/var/lib/boxpilot-managed/apps/keel/releases/1.2.6`. Failure removes only the generated partial or newly published inert tree. It does not create `/var/lib/keel`, a service account, systemd unit, process, account, listener, registration setting, access route, backup, or migration.

GitHub metadata matching is not local verification. Acquisition must hash all local bytes, archive inspection must pass, and the staged tree must pass its own evidence check. The exact identity and remaining installation, claim, and recovery gates are documented in [Keel Notes safe release staging](KEEL.md).

## Pi-hole guarded staging adapter

Version `0.26.0` can stage Pi-hole in Docker on the exact reviewed Bigbox LAN address, create a local configuration backup with isolated restore proof, collect fixed direct DNS evidence from Bigbox, and repeat the same fixed checks through a signed enrolled agent. The separate router checkpoint, GitHub provenance, Keel planning, and recovery-kit views do not alter this application boundary. The dedicated-VM target remains planning-only. These are service staging, recovery-evidence, and direct-path acceptance workflows, not router or client cutover workflows.

The adapter uses:

- Official version `2026.07.2`, pinned to multi-platform digest `sha256:f7d1be836e3bc608b56d82fc9904f5a831cdfbc0dc9c6d58f94e4c985c70038b`
- Container name `boxpilot-pi-hole`
- Exact `<reviewed Bigbox LAN>:53` TCP and UDP bindings
- Exact `<reviewed Bigbox LAN>:<reviewed high port>` web binding
- Persistent `/var/lib/boxpilot-managed/apps/pi-hole/etc-pihole`
- A generated administrator password stored only in root-owned mode `0600` file `/var/lib/boxpilot-managed/apps/pi-hole/admin-password`
- `cap_drop: ALL`, then only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `NET_BIND_SERVICE`, `SETFCAP`, `SETGID`, and `SETUID`
- `no-new-privileges:true`
- The upstream container DNS health check plus exact published-binding verification

The Compose definition publishes no DHCP port 67 or NTP port 123, adds no `NET_ADMIN` or `SYS_TIME`, uses no host network, mounts no Docker socket, and accepts no browser-provided image, path, password, capability, command, binary, or argument array.

Official source: [Docker Pi-hole](https://github.com/pi-hole/docker-pi-hole).

Deployment workflow:

1. Open **Network** and select **Pi-hole on Bigbox**.
2. Confirm the live gateway, Bigbox address, proposed primary address, and independent emergency resolver.
3. Record the external router checkpoint, independently test the emergency resolver, keep a second LAN device ready, and declare the actual Tailscale DNS override state.
4. Generate a ready no-change assessment. It is owner-attributable and expires.
5. Open **Applications**, select Pi-hole, choose a high LAN web port, and generate the linked plan.
6. Stage the exact revision, open **Repair Center**, review the network-critical recovery statement, and re-enter the owner password.
7. After the background job passes, open the reported LAN URL. Retrieve the administrator password only from a server terminal with the command shown by BoxPilot.
8. Keep every router and client on the current resolver. The application remains **Backup: required** until the separate backup workflow passes.

At planning, staging, and approval, BoxPilot revalidates the assessment owner, role, expiry, gateway, Bigbox address, current resolvers, DNS listeners, Tailscale state, recovery declarations, Docker, and web port. If any evidence changes, the job fails closed and requires a new assessment.

After staging, open **Backups** and plan the Pi-hole backup. The separate network-critical job:

1. Revalidates Pi-hole health, exact bindings, Docker, helper, and storage readiness.
2. Stops only `boxpilot-pi-hole` long enough to archive `etc-pihole`, the curated Compose definition, and the root-only administrator secret.
3. Restarts the source and requires both its health check and original TCP, UDP, and web bindings to pass.
4. Records artifact SHA-256, byte size, and measured source downtime.
5. Extracts the artifact beneath the helper-owned temporary restore root.
6. Starts the same digest-pinned image with `--network none`, no published ports, `cap_drop: ALL`, the same narrow capability set, and `no-new-privileges:true`.
7. Requires restore health, removes the temporary container and workspace, and records configuration, secret, isolation, and no-cutover evidence.

The artifact is mode `0600` beneath `/var/lib/boxpilot-managed/backups/pi-hole`. It contains the administrator secret and must be treated as sensitive. Its local no-network boot drill is required before the `0.44.0` independent application-protection plan can encrypt it in `restic-applications`, read the complete repository, and prove an exact restored hash. Until that second workflow passes, it remains locally verified only.

After the backup passes, open **Network** and plan the fixed direct DNS checks. BoxPilot derives the exact managed address and sends only `pi.hole` over UDP and TCP, `example.com` over UDP, and `boxpilot.invalid` over UDP after a separate password approval. The passing record links the deployment, original assessment, and backup, but is labeled as Bigbox-only evidence.

BoxPilot still will not make Pi-hole authoritative until later milestones can prove:

- A passing live direct DNS run from Bigbox and cryptographically attributable proof from a separately enrolled LAN device
- A separately reviewed router advertisement plan with model-specific rollback
- A stable observation window while the current resolver remains available

If deployment or health verification fails, BoxPilot removes only the managed stack or restores the previous managed Compose definition. Configuration and the administrator secret are preserved. DHCP, NTP, router mutation, client DNS advertisement, Tailscale mutation, firewall mutation, and automatic DNS cutover remain unavailable.
