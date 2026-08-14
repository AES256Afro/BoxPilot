# BoxPilot

BoxPilot is a safety-first, local control plane for an Ubuntu home server. It is designed to make applications, backups, logs, imports, migrations, Docker workloads, and virtual machines manageable from another computer over the LAN or Tailscale.

## Current status

Version `0.1.0` is a runnable interface and architecture prototype. It intentionally cannot execute host commands, access the Docker socket, install packages, edit the firewall, or change networking.

The current slice includes:

- Responsive server dashboard and workload inventory
- Keel Notes as the first app-aware managed workload
- Browser-only Docker Compose dry-run inspection with risk warnings
- Backup coverage and restore-drill views
- Non-destructive migration workflow
- Prototype logs and downloadable redacted support bundle
- Read-only health and capability API endpoints
- Hardened, loopback-only Docker deployment
- Full USB-to-headless Ubuntu installation runbook

All displayed server measurements are realistic demonstration data until the read-only inventory agent is implemented.

## Safety contract

Every future host change must follow:

1. Plan
2. Dry run
3. Checkpoint
4. Explicit approval
5. Apply with streamed logs
6. Verify or roll back

The future privileged helper will expose narrow, typed operations. BoxPilot will not mount the Docker socket into its web container or provide an arbitrary root shell.

## Run for development

Requirements:

- Node.js 24 or newer
- npm 11 or newer

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Run the production build

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8787`. The server binds to loopback unless `BOXPILOT_HOST` is explicitly changed.

Health endpoint:

```bash
curl http://127.0.0.1:8787/api/v1/health
```

## Run with Docker

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/api/v1/health
```

The Compose stack:

- Publishes only to `127.0.0.1`
- Runs as the unprivileged Node user
- Drops every Linux capability
- Enables `no-new-privileges`
- Uses a read-only root filesystem
- Does not mount host directories or the Docker socket

## Private Tailscale access

After BoxPilot is healthy on the Ubuntu server, publish it privately to the tailnet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Open the HTTPS URL shown by `tailscale serve status` from another device on the same tailnet. Keep Tailscale Funnel disabled. LAN exposure and an application authentication layer will be added before BoxPilot gains any host-changing capability.

## Validation

```bash
npm run check
docker build -t boxpilot:local .
```

## Documentation

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Dependency-ordered roadmap](docs/ROADMAP.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)

## Keel Notes integration target

The first application adapter will support [Keel Notes](https://github.com/AES256Afro/Keel):

- Detect a Keel Docker or service installation
- Inventory the database dialect and protected data paths without exposing secrets
- Use Keel-aware export and import operations
- Preserve the managed-secret key companion during migration
- Coordinate SQLite writes before backup or restore
- Recognize PostgreSQL deployments
- Surface Keel, Caddy, Docker, backup, and Litestream health
- Test restores in an isolated stack before reporting a backup as verified

## License

No license has been selected yet. All rights are reserved until the repository owner chooses one.
