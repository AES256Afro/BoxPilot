# Curated applications

BoxPilot `0.5.0` introduces application manifests and one executable evaluation adapter. The web process never receives the Docker socket. Application inspection and execution cross the restricted local helper as typed operations.

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

The deployment remains evaluation-only until the backup milestone records artifact integrity and an isolated restore test for the Uptime Kuma data directory.

## Pi-hole planning adapter

Pi-hole is planning-only. The adapter models the official Docker image, persistent `/etc/pihole` configuration, TCP and UDP port 53, web access, and both Docker and dedicated-VM targets.

Official source: [Docker Pi-hole](https://github.com/pi-hole/docker-pi-hole).

BoxPilot will not stage Pi-hole until later milestones can prove:

- The active DNS role and port 53 owner
- Whether Flint 2 AdGuard Home remains primary, becomes fallback, or is being replaced
- A reserved LAN address or VM address
- A router configuration checkpoint
- An emergency resolver path independent of Bigbox
- DNS tests from Bigbox and a second LAN device
- Configuration backup integrity and an isolated restore drill
- Route cutover and rollback ordering

DHCP, NTP, `NET_ADMIN`, `SYS_TIME`, host networking, router mutation, and automatic DNS cutover are not enabled by the `0.5.0` adapter.
