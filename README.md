# BoxPilot

Point-and-click setup and management for an Ubuntu home server — from a browser, over your LAN or Tailscale.

Install updates, add the tools and apps you want from a catalog, create VMs for projects, back everything up, and restore or redeploy quickly. Every change runs as a **registry operation** with a risk tier: low-risk things are one click, medium-risk things ask you to confirm a preview, high-risk things want your password. A root helper does the work; the web process never runs privileged.

## Install

On a fresh Ubuntu Server (22.04 or newer), one command installs Node 24, creates the service user, builds BoxPilot under `/opt/boxpilot`, enables the `boxpilot` and `boxpilot-helper` units, and prints the URL plus a one-time owner token:

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh -s -- --ref v0.62.5
```

Open the URL, create the owner account with that token, and pick a **setup profile** (home server, DNS appliance, hypervisor, dev box, essentials) — BoxPilot installs the prerequisites, apps, and backup schedules in order. Already have a BoxPilot? *Set up → Prepare a new server* generates the Ubuntu autoinstall files that do all of this unattended.

After that **BoxPilot updates itself**: *System → BoxPilot updates* shows the latest [release](https://github.com/AES256Afro/BoxPilot/releases) and *Update to vX.Y.Z* downloads it, builds it, swaps it in, and rolls back by itself if the new version fails its health check. The same script works from the terminal with any release tag.

## What it does

| Page | What you can do |
| --- | --- |
| **Overview** | Updates, failed services, apps and VMs running, backup health, and a needs-attention list. |
| **Updates & packages** | See and install APT updates (all or selected), toggle automatic security updates, see what needs a restart, install common tools with one click. |
| **App catalog** | Install, configure, update, back up, restore, and uninstall 22 self-hosted apps from YAML manifests — Jellyfin, Home Assistant, Vaultwarden, Forgejo, Portainer, Grafana, Paperless-ngx, n8n, Pi-hole (with a blocklist picker), AdGuard Home, and more. Live status, logs, resource use, one-click HTTPS on your tailnet. |
| **Services** | systemd units and timers: start, stop, restart, enable, disable, journal. |
| **System** | Hostname, time zone, language, swap, trim, Docker housekeeping, scheduled operations, and BoxPilot's own updates. |
| **Users & SSH** | Accounts, sudo, SSH keys (import from GitHub), password-login policy. |
| **Firewall** | ufw state and rules. |
| **Storage** | Disks, filesystems, SMART, mounting by UUID, swap files. |
| **Network** | Interfaces, Tailscale, and a read-only DNS/topology assessment. |
| **Virtual Machines** | Create VMs from cloud images or ISOs, lifecycle, snapshots; export, encrypt to an independent restic repository, restore-drill in isolation, recover as a clone. |
| **Backups** | Database backups with restore drills, encrypted independent copies with retention, **machine snapshots** (everything needed to redeploy the box), an off-box mirror to a backup drive, and restore from a snapshot. |
| **Repair Center** | Prerequisite installs, the disaster-recovery kit, and a read-only action center. |
| **Logs** | Any systemd unit, any container, any journal group — tail, filter, follow, download. |
| **Settings** | Approval mode, failed-job notifications (ntfy, Gotify, webhook), GitHub and Tailscale sign-in. |

Sign in with a local password, your **Tailscale** identity, or **GitHub** (device flow — no secret, no callback).

## How it works

- **One operation registry** (`server/ops/`): every action is a declared operation with a risk tier, a parameter schema, and a `run`. The helper validates against the same registry; nothing runs that is not declared.
- **Risk tiers, not ceremony** ([ADR-001](docs/DECISIONS.md)): low = one click, medium = confirm with a preview, high = password (a password unlocks a short elevated session). An *Always ask* mode exists if you want every change confirmed.
- **Durable jobs**: every change is a job with steps, live output, and an audit trail; the Activity drawer follows them.
- **Root helper over a Unix socket**: the web service is unprivileged. Root work runs in `boxpilot-helper.service` (no network, strict filesystem) or, when it needs the network, in a hardened `boxpilot-run@` template unit with an explicit task table.
- **Data-driven catalog**: an app is a YAML manifest plus a compose template. Install, update, reconfigure, backup, and restore are generic; manifests are validated strictly and their image tags are verified.
- **Evidence, not claims**: backups are restore-drilled before they count, independent copies are read back in full, and the server pins what it checked into each job so a change on disk between review and execution is refused.

## Run for development

Requires Node.js 24 and npm 11.

```bash
npm install
npm run dev          # UI at http://127.0.0.1:5173
npm run check        # build + tests + syntax checks
```

Production build: `npm run build && npm start` listens on `127.0.0.1:8787` (set `BOXPILOT_HOST` to change it). Native installs run as systemd units from `deploy/`; the Docker Compose file builds a loopback-only, read-only preview that cannot manage a host.

## Private access over Tailscale

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Open the HTTPS URL from any device on your tailnet. Keep Funnel off; BoxPilot authentication is still required.

## Documentation

- [Roadmap](docs/ROADMAP-V2.md) — what exists, what is next, with ✅ markers per milestone
- [Decisions](docs/DECISIONS.md) — ADR-001 and the design rules
- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [QEMU/KVM setup and operation](docs/VIRTUALIZATION.md) · [API](docs/VIRTUALIZATION-API.md)
- [Backups](docs/BACKUPS.md) · [Controller recovery runbook](docs/CONTROLLER-BACKUPS.md) · [Recovery kit](docs/RECOVERY.md)
- [Prerequisite repairs](docs/PREREQUISITE-REPAIRS.md) · [Inventory](docs/INVENTORY.md) · [Network](docs/NETWORK.md) · [GitHub provenance](docs/GITHUB.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)
- [Legacy documentation](docs/legacy/README.md) — the 0.4–0.61 "control plane" era, kept for history

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it is short and applies to humans and coding agents alike. New actions are registry operations; new apps are manifests; `npm run check` must pass.

## License

No license has been selected yet. All rights are reserved until the repository owner chooses one.
