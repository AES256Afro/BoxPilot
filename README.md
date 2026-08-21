# BoxPilot

Point-and-click setup and management for an Ubuntu home server — from a browser, over your LAN or Tailscale.

Install updates, add the tools and apps you want from a catalog, open exactly the ports you mean to, mount and share storage, create VMs for projects, back everything up, and restore or redeploy quickly. Every change runs as a **registry operation** with a risk tier: low-risk things are one click, medium-risk things ask you to confirm a preview, high-risk things want your password. A root helper does the work; the web process never runs privileged.

![The Overview: updates, services, apps, VMs, backup health, a setup checklist, and the installed apps](docs/screenshots/overview.jpg)

*Screenshots come from the built-in demo mode (`npm run demo`), which runs the real UI on fictional data.*

## Install

On a fresh Ubuntu Server (22.04 or newer), one command installs Node 24, creates the service user, builds BoxPilot under `/opt/boxpilot`, enables the `boxpilot` and `boxpilot-helper` units, and prints the URL plus a one-time owner token:

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh -s -- --ref v0.81.0
```

Open the URL, create the owner account with that token, and pick a **setup profile** (home server, DNS appliance, hypervisor, dev box, essentials) — BoxPilot installs the prerequisites, apps, and backup schedules in order. The Overview then shows a **setup checklist** (reach it from anywhere over Tailscale, firewall profile, automatic security updates, phone alerts, an off-box backup copy) with a link to each step. Already have a BoxPilot? *Set up → Prepare a new server* generates the Ubuntu autoinstall files that do all of this unattended.

After that **BoxPilot updates itself**: *System → BoxPilot updates* shows the latest [release](https://github.com/AES256Afro/BoxPilot/releases) and *Update to vX.Y.Z* downloads it, builds it, swaps it in, and rolls back by itself if the new version fails its health check. The same script works from the terminal with any release tag.

### Try it without a server

```bash
npm install && npm run build && npm run demo
```

Then open <http://127.0.0.1:8799>. Every page works against a fictional host (`homebox`, one NVMe disk, a USB drive, a NAS share, eight installed apps), so you can click through the whole product on a laptop. Buttons that would change the host create demo jobs instead.

## What it does

| Page | What you can do |
| --- | --- |
| **Overview** | Updates, failed services, apps and VMs running, backup health, the setup checklist, and a needs-attention list. |
| **Updates & packages** | See and install APT updates (all or selected), toggle automatic security updates, see what needs a restart, install common tools with one click, take an LVM snapshot first. |
| **App catalog** | Install, configure, update, back up, restore, and uninstall **128 self-hosted apps** from YAML manifests in 19 categories (see below). Live status, logs, resource use, one-click HTTPS on your tailnet. |
| **Services** | systemd units and timers: start, stop, restart, enable, disable, journal. |
| **System** | Hostname, time zone, language, swap, trim, Docker housekeeping, UPS monitoring, scheduled operations, and BoxPilot's own updates. |
| **Users & SSH** | Accounts, sudo, SSH keys (import from GitHub), password-login policy. |
| **Firewall** | ufw profiles (Home server, Tailscale only, Trusted LAN), service presets, suggestions based on what is actually listening, fail2ban, and protected ports: SSH, Tailscale, and BoxPilot's own port can never be blocked from the UI. |
| **Storage** | Disks and LVM (grow the root volume with one click, snapshots before big updates with rollback), mounting by UUID, SMB/NFS network shares with LAN discovery and self-reconnecting mounts, Samba and NFS servers that share this server's folders over your tailnet only (or the LAN), swap files. The system disk can never be formatted from the UI. |
| **Network** | Interfaces, DNS listeners, devices on the LAN with Wake-on-LAN, and Tailscale: exit node and subnet router with one tick each. |
| **Virtual Machines** | Create VMs from cloud images or ISOs, lifecycle, snapshots; export, encrypt to an independent restic repository, restore-drill in isolation, recover as a clone. |
| **Backups** | Database backups with restore drills, encrypted independent copies with retention, off-box mirrors over SSH or to the cloud (Backblaze B2, S3, WebDAV, Google Drive, OneDrive, Dropbox via rclone), **machine snapshots** (everything needed to redeploy the box), an off-box mirror to a backup drive, and restore from a snapshot. |
| **Repair Center** | Prerequisite installs, the disaster-recovery kit, and a read-only action center. |
| **Logs** | Any systemd unit, any container, any journal group — tail, filter, follow, download. |
| **Settings** | Approval mode, alerts for failed jobs, full disks, SMART warnings and power cuts (ntfy, Gotify, webhook), GitHub and Tailscale sign-in. |

Sign in with a local password, your **Tailscale** identity, or **GitHub** (device flow — no secret, no callback).

### App catalog

![The App catalog: 128 apps in 19 categories, each a YAML manifest](docs/screenshots/catalog.jpg)

Photos and files (Immich, PhotoPrism, Nextcloud, File Browser, Syncthing, Resilio Sync), media (Jellyfin, Plex, Emby, Jellyseerr, Tautulli, Audiobookshelf, Navidrome, Kavita, Komga, Calibre-Web), media automation (Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, SABnzbd, qBittorrent behind a VPN, Pinchflat, MeTube), the smart home (Home Assistant, Mosquitto, Zigbee2MQTT, Z-Wave JS UI, Node-RED, ESPHome, OctoPrint), DNS with a bundled Unbound resolver (Pi-hole with a blocklist picker, AdGuard Home, Technitium), monitoring (Uptime Kuma, Netdata, Prometheus, Grafana, Loki, Dozzle, Beszel, Healthchecks, Scrutiny, SmokePing, changedetection.io), networking (WireGuard via wg-easy, Nginx Proxy Manager, Cloudflare Tunnel, Cloudflare DDNS, LibreSpeed), security (Vaultwarden, 2FAuth), communication (a Matrix server with Element, Mattermost, Mumble, Apprise, ntfy, Gotify), knowledge and notes (BookStack, Wiki.js, Docmost, HedgeDoc, Joplin Server, Trilium, Memos, Paperless-ngx, Stirling PDF, Linkding, Linkwarden, Karakeep, FreshRSS, Miniflux), household (Grocy, Tandoor, Mealie, Homebox, Monica, Vikunja, Planka), finance (Actual Budget, Firefly III), developer tools (Forgejo, Portainer, Dockge, Semaphore, code-server, Verdaccio, a Docker registry, PostgreSQL/MariaDB/MongoDB/InfluxDB/Valkey with admin UIs, NocoDB, Baserow, Directus, Metabase, n8n, IT-Tools, CyberChef, draw.io), AI (Open WebUI + Ollama with a model picker, Whisper, LibreTranslate, SearXNG), backups (Duplicati, Kopia, MinIO), games (Minecraft, Crafty, Terraria, Factorio, Satisfactory, Palworld, PufferPanel, RomM), and a Homepage dashboard.

An app is a manifest plus a compose template; install, update, reconfigure, backup, and restore are generic. Manifests are validated strictly and their image tags are verified.

### Firewall

![The Firewall: profile in force, suggestions based on what is listening, protected ports](docs/screenshots/firewall.jpg)

Pick a profile, tick the services other devices should reach, apply. Suggestions come from what is actually listening on the server (a database open to the whole LAN, an app nobody can reach, SSH without rate limiting). SSH, Tailscale, and BoxPilot itself can never be locked out from the UI, and turning the firewall on or off asks for the owner password.

### Storage

![Storage: disks, LVM free space, snapshots with rollback, block devices, shares](docs/screenshots/storage.jpg)

Claim the space the Ubuntu installer left unallocated, take an LVM snapshot before a big update and roll back if it goes wrong, mount disks by UUID, discover and mount SMB/NFS shares on the LAN (credentials are never stored in BoxPilot's database), and serve this server's folders over Samba or NFS — bound to your tailnet unless you say otherwise.

### Backups

![Backups: drilled database snapshots, independent encrypted copies, machine snapshots, off-box mirrors](docs/screenshots/backups.jpg)

Backups only count after a restore drill. A machine snapshot holds everything needed to redeploy the box — database, every app's settings and secrets, network and firewall config, VM definitions — and mirrors to a backup drive, an SSH host, or a cloud bucket.

### Network

![Network and DNS: gateway, resolvers, Tailscale exit node and subnet router, LAN devices with Wake-on-LAN](docs/screenshots/network.jpg)

### Updates & packages

![Updates and packages: APT updates, automatic security updates, common tools](docs/screenshots/updates.jpg)

### System

![System: hostname, time zone, memory and swap, BoxPilot self-update, language, swappiness](docs/screenshots/system.jpg)

## How it works

- **One operation registry** (`server/ops/`): every action is a declared operation with a risk tier, a parameter schema, and a `run`. The helper validates against the same registry; nothing runs that is not declared.
- **Risk tiers, not ceremony** ([ADR-001](docs/DECISIONS.md)): low = one click, medium = confirm with a preview, high = password (a password unlocks a short elevated session). An *Always ask* mode exists if you want every change confirmed.
- **Durable jobs**: every change is a job with steps, live output, and an audit trail; the Activity drawer follows them. Secrets passed to a job (share passwords, cloud keys) stay in memory and are never written to the database.
- **Root helper over a Unix socket**: the web service is unprivileged. Root work runs in `boxpilot-helper.service` (no network, strict filesystem) or, when it needs the network, in a hardened `boxpilot-run@` template unit with an explicit task table.
- **Data-driven catalog**: an app is a YAML manifest plus a compose template. Install, update, reconfigure, backup, and restore are generic; manifests are validated strictly and their image tags are verified.
- **Evidence, not claims**: backups are restore-drilled before they count, independent copies are read back in full, and the server pins what it checked into each job so a change on disk between review and execution is refused.
- **Health alerts**: a watcher checks disks, SMART, RAID, memory, and UPS state every 15 minutes and sends one notification per change of state.

## Run for development

Requires Node.js 24 and npm 11.

```bash
npm install
npm run dev               # UI at http://127.0.0.1:5173
npm run check             # build + tests + syntax checks
npm run demo              # the built UI on fictional data at http://127.0.0.1:8799
npm run demo:screenshots  # regenerate docs/screenshots from the demo (needs Chrome)
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
