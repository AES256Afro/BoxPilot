# Curated applications

BoxPilot `0.19.0` provides integrity-addressed manifests, two executable deployment adapters, and one application-aware backup adapter. The web process never receives the Docker socket. Docker readiness, application inspection, deployment, backup, and restore-drill execution cross the restricted local helper as typed operations.

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

After deployment, the Backups page can record artifact integrity and an isolated restore test for the Uptime Kuma data directory. A local-only verified artifact still needs an independent destination before it qualifies as resilient 3-2-1 protection.

## Pi-hole guarded staging adapter

Version `0.19.0` can stage Pi-hole in Docker on the exact reviewed Bigbox LAN address. The dedicated-VM target remains planning-only. This is a service-staging workflow, not a router or client cutover workflow.

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
8. Keep every router and client on the current resolver. The application remains **Backup: required**.

At planning, staging, and approval, BoxPilot revalidates the assessment owner, role, expiry, gateway, Bigbox address, current resolvers, DNS listeners, Tailscale state, recovery declarations, Docker, and web port. If any evidence changes, the job fails closed and requires a new assessment.

BoxPilot still will not make Pi-hole authoritative until later milestones can prove:

- Configuration backup integrity and an isolated restore drill
- Direct DNS query tests from Bigbox and a second LAN device
- A separately reviewed router advertisement plan with model-specific rollback
- A stable observation window while the current resolver remains available

If deployment or health verification fails, BoxPilot removes only the managed stack or restores the previous managed Compose definition. Configuration and the administrator secret are preserved. DHCP, NTP, router mutation, client DNS advertisement, Tailscale mutation, firewall mutation, and automatic DNS cutover remain unavailable.
