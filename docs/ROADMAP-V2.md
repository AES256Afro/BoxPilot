# BoxPilot v2 — from "safety-first control plane" to "point-and-click server setup"

Assessment of the repo at `0.61.0` (93 commits, 2026-08-14 → 08-16) against the stated goal: *open the app, click install — updates, apps, platforms like Pi-hole, dashboards, VMs, auth via GitHub/Tailscale, backup/restore for fast redeploys, uninstall and config edits.*

---

## 1. Verdict in five lines

1. The codebase is **large (39k LOC, 590 tests, 121 routes, 34 SQLite tables, 75 helper ops)** and **well-built at the primitive level** — auth, the root-helper socket, the systemd-oneshot-with-approval-file escalation pattern, durable jobs, and the SQLite layer are all genuinely solid.
2. It is **not a setup tool**; it is a *provenance and evidence engine* that happens to install four things. Every capability is expressed as one fixed, parameter-free, password-approved operation with a page of English prose proving what it *didn't* do.
3. The "safety" is **structural, not a setting**. It is baked into three hand-synced allowlists, a 752-line approval function, and per-op prose. You cannot flip a flag to unlock it — you have to change the shape.
4. Cost of adding anything today: **~550–650 LOC across 13 files per privileged operation**, **~700–900 LOC per new app**. That is why there are 3 apps and 5 package repairs after 39k lines.
5. The fix is not a rewrite. **Keep ~25% (security, helper transport, jobs/state primitives, systemd hardening, UI shell), replace the ceremony with a registry + risk tiers + data-driven catalog, and add the missing primitives** (apt, systemd, docker compose, uninstall, config, installer, wizard).

---

## 2. What is actually there (facts, not opinions)

| Layer | Reality | Ref |
|---|---|---|
| Web/API | One flat `index.mjs`, 121 inline routes, no `Router`, ~48 `create*Service()` instantiations | `server/index.mjs:1-150, 167-1170` |
| Auth | Single owner. Terminal-generated bootstrap token → scrypt password → HttpOnly cookie + CSRF header. No OAuth/OIDC, no Tailscale identity, no WebAuthn. | `server/security.mjs`, `src/AuthScreen.tsx:41` |
| Jobs | plan (30-min TTL, hashed revision) → stage → **password re-entry** → run → verify. All enforcement in one 752-line `prepareApproval` with a 40-type allowlist on one line and a ~700-line ternary chain of per-type `execution` literals | `server/jobs.mjs:67-819` |
| Helper | Root process on `/run/boxpilot/helper.sock`, `PrivateNetwork=true`, `ProtectSystem=strict`. Op allowlist is **three lists kept in sync by hand**: ops Set (75 on one line), read-only Set, timeout `if` ladder | `helper-protocol.mjs:36`, `helper-server.mjs:31,117-144` |
| Privilege | No sudo/polkit. Helper writes a 0600 approval JSON to `/run/boxpilot/`, starts a **static argument-less oneshot unit** gated by `ConditionPathExists=`. 15 such units. | `deploy/*.service`, `prerequisite-helper.mjs:270-280` |
| Apps | 3 manifests as JS literals (Uptime Kuma, Pi-hole, Keel). `deployUptimeKuma` and `deployPihole` are separate functions; a second per-app dict lives in `application-lifecycle.mjs`. **No uninstall. No config edit. No update.** | `server/applications.mjs:14-79`, `application-helper.mjs:1006,1054` |
| Packages | 5 fixed repairs (smartmontools, restic, docker.io, KVM bundle, apt *metadata-only* refresh). No general install/upgrade/remove/reboot. | `src/RepairCenter.tsx:383-413` |
| VMs | The strongest area: create, lifecycle, snapshot, export, restic copy, restore drill, recovery clone, retention, ISO import. Missing: delete, force-off, console, cloud-init, bridge. | `server/vm-*.mjs` |
| Backups | restic-based, controller + 3 apps + VMs, with retention and isolated restore drills. No schedule, no prune, no remote destination, no one-click "restore to new box". | `server/*-protection*.mjs`, `*-retention*.mjs` |
| Install UX | No installer. Runbook is 16 stages / ~150 manual steps *before* BoxPilot, then ~40 sudo commands incl. 17 `install` lines for units. Owner setup needs a terminal. | `UBUNTU-SERVER-INSTALL-RUNBOOK.md`, `docs/VIRTUALIZATION.md:44-107` |
| Approve-with-password UX | Not a reusable component. Lives in Repair Center; other screens stage a plan then say "go to Repair Center". Fleet re-implements it 3×. Install = ~6 clicks + tab switch + password. | `src/RepairCenter.tsx:601-618`, `ApplicationCatalog.tsx:300,435` |
| Router | Read-only checkpoints and "observed gateway" evidence. No router API, credentials, writes. | `server/router-checkpoints.mjs` |
| GitHub | Unauthenticated read of 2 hard-coded repos' commits/releases. | `server/github-provenance.mjs:7-8` |
| Tailscale | Read state; one `tailscale serve` publish for Uptime Kuma. | `server/application-private-access.mjs` |
| UI | React 19, no router, `useState` view switch, 3156-line dark-only CSS, two giant prose dictionaries in `App.tsx:23-160` | `src/App.tsx`, `src/styles.css` |
| Hard-coding | "Bigbox" in 102 files incl. a stored enum `pihole-on-bigbox`; version string in 4 places; libvirt subnet in 4 places | `network.mjs:8`, `index.mjs:173,1183` |
| Health | Build ✅. Tests 589/590 — one time-bomb (fixture dated 08-16 vs 24h stale window, no injected clock) | `server/storage-evidence.test.mjs:40-41` |

---

## 3. Why it feels "built for safety" — the root causes

These are the things that must change; everything else is polish.

1. **Password-per-action, with no tiers.** Every mutation — even "restart Uptime Kuma" — is plan → stage → navigate → password → approve. There is no notion of risk level, no session "sudo mode", no one-click for low-risk actions.
2. **Fixed, argument-less operations.** The helper refuses anything it wasn't hand-taught. `docker install` accepts exactly `{expectedVersion}`; apt refresh is metadata-only *by design*. General `apt install <pkg>` does not exist, nor does `systemctl restart <unit>`, nor `docker compose up` for anything unknown.
3. **Prose as the product.** `/api/v1/capabilities` returns 300-character hyphenated slugs of what it *won't* do; every job carries four paragraphs of boundary prose; the README is 73 KB of disclaimers. This is overhead on every feature and noise in every screen.
4. **Three-list allowlist + mega-ternary.** New op = touch protocol Set, read-only Set, timeout ladder, validator, dispatcher, helper module, script, unit, plan module, `jobs.mjs` (4 places), route, UI, tests. Nothing is data-driven.
5. **Per-workflow ledgers.** 30 of 34 tables are "X_runs / X_members" for one workflow each. A generic installer needs ~6 tables.
6. **No uninstall / no config / no update.** The three operations a setup tool lives on are all explicitly "pending".
7. **No installer and no wizard.** First run requires SSH, ~40 sudo commands, and a terminal-only bootstrap token.
8. **Single-host, single-owner, single-LAN assumptions** hard-coded as product copy ("Bigbox", Flint 2, 192.168.8.x, `pihole-on-bigbox`).

---

## 4. What to keep (don't throw these away)

- `server/security.mjs` — scrypt, sessions, CSRF. Extend, don't replace.
- `server/helper-client.mjs` + the Unix-socket framing + `operationQueue` serialization.
- **The escalation pattern**: root helper + static oneshot units gated on a 0600 approval file. Generalize it: one `boxpilot-run.service` template (`boxpilot-run@<jobid>.service`) that reads a signed job spec instead of 15 named units.
- `deploy/boxpilot-helper.service` hardening (`ProtectSystem=strict`, pinned binary env) — template for every new unit.
- `state.mjs` primitives: `jobs`, `plans`, `job_steps`, `approvals`, `audit_events`, `recoverInterruptedJobs`, plan revision hashing, WAL SQLite.
- The VM subsystem nearly whole (`vm-*.mjs`, `libvirt*.mjs`, `VmPlanner`, `VmMediaLibrary`).
- restic backup/restore/drill machinery as a *library* — rewrap it behind a generic "protect this path set" API.
- The manifest *shape* in `applications.mjs` (image+digest, ports, storage, prerequisites, health, rollback) — move it to files.
- Redaction engine + support bundle.
- UI shell: sidebar nav, `Panel`/`StatusPill`/`Modal`, the test harness (vitest + RTL), Vite build.

---

## 5. Where I would make changes (the architectural moves)

### 5.1 One operation registry replaces three allowlists + the ternary chain
`server/ops/registry.mjs`: an array of `{ id, title, risk: "low"|"medium"|"high", params: <JSON schema>, privileged: bool, readOnly: bool, timeoutMs, run(ctx, params), verify(ctx, result), rollback(ctx, result) }`. `helper-protocol` validates against `params` generically; `helper-server` derives the read-only set and timeouts from the registry; `jobs.mjs` becomes ~150 lines (approve → run → verify → record). Each op is **one file in `server/ops/*/`**, ~60–120 LOC including its unit test.

### 5.2 Risk tiers instead of password-for-everything
- **low** (read, start/stop/restart, refresh, view config): one click, audited.
- **medium** (install app, apt install, create VM, edit config): confirm dialog with a plain-English diff/preview, audited.
- **high** (uninstall with data, DNS cutover, wipe disk, delete VM, change firewall/SSH, restore-over-live): password (or WebAuthn) + typed confirmation.
- **Sudo mode**: after any password, a 10-minute elevated session so batch setup doesn't re-prompt. Toggle in Settings: "Always ask" for the paranoid profile (preserves today's behaviour as an *option*).

### 5.3 General primitives in the helper (the missing 20%)
`apt.update/upgrade/install/remove/autoremove/search/changelog`, `dpkg.list`, `systemd.list/start/stop/restart/enable/disable/status/journal`, `reboot/poweroff`, `docker.compose.up/down/pull/logs/exec-readonly`, `docker.prune`, `ufw.status/allow/deny`, `sshd.config.get/set`, `users.add/key/add-to-group`, `netplan.get/set(validated)`, `tailscale.up/serve/funnel/status`, `fs.read/write` under a managed root, `hostnamectl.set`, `timedatectl.set`. Each one is a registry entry, parameter-validated, with `ProtectSystem` paths opened only as needed.

### 5.4 Data-driven app catalog
`catalog/<app>/manifest.yaml` + `compose.yaml.tmpl` + optional `hooks/{pre,post,backup,restore}.sh`. One generic **compose deployer** replaces `deployUptimeKuma`/`deployPihole`. Manifest carries: image+digest, ports, volumes, env schema (typed → auto-generated config form), health check, backup paths, secrets, prerequisites, Tailscale-serve default, uninstall policy (`keep-data|purge`), update policy (`digest-pinned|tag-track`). Catalog is loaded from disk, signed (reuse GitHub provenance code) and can be updated from GitHub without a BoxPilot release. Target: **Jellyfin in <100 lines of YAML**.

### 5.5 Install + first-run wizard
- `curl -fsSL https://get.boxpilot.dev | sudo bash` (or `sudo bash install.sh` from the repo): creates user, installs Node, clones/pulls a release tarball, installs **2** units + the template unit, opens the port, prints a one-time URL with the bootstrap token embedded (`http://<lan-ip>:8787/setup?token=…`).
- Browser wizard: hostname, owner account, (optional) Tailscale join (auth-key or `tailscale up` QR), (optional) GitHub sign-in link, pick a **profile** (Home server / Dev box / NAS / DNS appliance / Hypervisor) → preselects apps and prereqs → one "Install everything" button with a live log.
- Also ship an **autoinstall `user-data`** generator so a fresh Ubuntu USB can land with BoxPilot already running (replaces most of the 16-stage runbook).

### 5.6 Identity
- **Tailscale identity**: when the request arrives on the tailscale interface, call `tailscale whois <remote-ip>` via the local API; map login name → owner. Behind `tailscale serve` read `Tailscale-User-Login` header only from 127.0.0.1. Zero-password sign-in on the tailnet.
- **GitHub OAuth device flow** (no redirect URL needed for a LAN box): link a GitHub account to the owner; optional "allow these GitHub logins". Also unlocks: private repo pulls for deploys, SSH key import (`gh keys`), Gist-backed config export.
- Keep local password as fallback; add recovery codes.

### 5.7 Collapse the ledgers
`jobs, job_steps, plans, approvals, audit_events, installed_items (type, id, version, config_json, state), backups (target_type, target_id, snapshot_id, kind, verified), schedules, secrets (encrypted), settings`. Migrate VM/backup tables into `installed_items`/`backups`. Delete fleet/router/migration tables until those features are real.

### 5.8 UI
Add a real router (`react-router` or a tiny hash router), a shared `<ApproveAction risk=…>` component used everywhere (replaces the Repair-Center hop), a global **Activity drawer** (live job log, SSE), **Dashboard** (installed things, health, update badges, "what needs attention"), light theme, and delete the `viewCopy/viewStatus` prose dictionaries.

### 5.9 De-Bigbox
`settings.hostAlias` + remove hard-coded strings; migrate `pihole-on-bigbox` → `pihole-on-host`. Move the runbook's personal network table (it contains a MAC address and LAN layout) to a `.local` ignored file or a template with placeholders.

---

## 6. Milestones (long list)

Grouped by phase; each has a "done when". Phases 0–3 are the pivot; 4+ are growth. Numbers are for reference, not strict order inside a phase.

### Phase 0 — Stop the bleeding (1 week) — **done 2026-08-19 on branch `phase-0`**
- ✅ **M0.1** Fix time-bomb test (`storage-evidence.test.mjs:40-41` — pass `{ now }`); add `vi.useFakeTimers` policy. Done when CI green on any date.
- ✅ **M0.2** Single `VERSION` source (package.json) read by server, helper, protocol. Done when 4 literals become 1.
- ✅ **M0.3** Replace "Bigbox" strings; `pihole-on-bigbox` → `pihole-on-host` with a read-side alias (no SQL migration needed — plans expire in 30 min). Chose neutral wording over a `hostAlias` setting; the authenticated UI already shows the real hostname from inventory.
- ✅ **M0.4** Strip personal data from `UBUNTU-SERVER-INSTALL-RUNBOOK.md` (MAC, reservation, router model) into placeholders.
- ✅ **M0.5** Write `docs/DECISIONS.md` ADR-001: "Risk tiers replace universal password approval" so future Codex runs stop re-adding ceremony. Add a `CLAUDE.md`/`AGENTS.md` that states the product goal in one paragraph.

### Phase 1 — Registry + risk tiers (2 weeks)
- ✅ **M1.1** `server/ops/registry.mjs` (declarative param spec; JSON Schema can replace it later). **The port is complete: every mutation is a registry operation.** `jobs.mjs` is 153 lines and executes only `op:` jobs; the helper's hand-declared list (`legacyHelperOperations`) holds exactly 15 read-only inspections, and each mutating service revalidates its own typed input at execution time. The final batch moved the seven VM workflows (media import, create, export, protection, retention, restore drill, recovery) to ops `vm.media.import`, `vm.create`, `vm.export.create`, `vm.export.protect`, `vm.backup.retention.apply`, `vm.backup.restore-drill`, `vm.recovery.create`: the plan/stage ceremony is gone — the browser names only the subject (a domain name, an export id, a backup id), `operationPrepareHooks` pin the recorded evidence and live revisions server-side at staging time, `operationRecordHooks` turn results into durable evidence rows, and the helper services keep their full TOCTOU revalidation. The VM pages stage everything through the shared risk-tiered ApproveDialog; VmPlanner keeps its host-checked preview and hands the validated input to `vm.create` approval.
- ✅ (foundation) **M1.2** `deploy/boxpilot-run@.service` template unit + `scripts/boxpilot-run.mjs` + root task table `server/tasks/` + helper client `server/run-unit.mjs`. New networked root work needs zero new unit files. Remaining: migrate the 13 named install/Keel units onto it.
- ✅ (server + Repair Center) **M1.3** Risk tiers (`server/ops/risk.mjs`: per-job-type tier, unknown → high), approval policy (low/medium = no password, high = password unless session elevated ≤10 min, `always-password` setting), `POST/DELETE /api/v1/auth/elevate`, `GET /api/v1/jobs/:id/approval`, `GET/PUT /api/v1/settings/approval-mode`, approvals record `method`+`tier`. Repair Center desk is tier-aware ("Run" one-click for low). Shared `ApproveDialog` + `useOperation` hook (`src/ApproveDialog.tsx`) used by Updates and App catalog: stage → tier-aware approve → live output → result. Settings page has the Tiered / Always-ask toggle. `elevatedOnly` read-only ops (e.g. `app.secrets`) require a recent password and are audited. Remaining: adopt the dialog in the legacy Applications/VM centers.
- ✅ **M1.4** Generic job path is the only path: `POST /api/v1/operations/:id/jobs` stages any registered mutating op as `op:<id>`; approval/execution are generic (`jobs.createOperationJob`), `GET /api/v1/operations/:id/inspect` runs read-only ops directly; the legacy executor branch is deleted. `index.mjs` is a ~190-line composition root; routes live in `server/routes/` (operations, jobs+schedules+events, virtualization, settings, host+catalog+evidence, identity). Every approved job runs in the background (202) since all jobs are registry ops.
- ✅ **M1.5** SSE `/api/v1/events` (job snapshots on every create/approve/step/finish, coalesced per job) + Activity drawer in the topbar: running-job badge, recent-job history, expandable step log and live output (`src/ActivityDrawer.tsx`). Per-job output streaming stays on `/api/v1/jobs/:id/stream`.
- ✅ **M1.6** `capabilities` endpoint returns a matrix of booleans, enums, counts, and registered operation ids derived from the registry — no prose.

### Phase 2 — Host primitives: updates, packages, services (2 weeks)
- ✅ (v1) **M2.1** Registry ops `apt.upgradable.inspect`, `apt.refresh`, `apt.upgrade` (all/selected), `apt.install`, `apt.remove`, `apt.purge` (high), `apt.autoremove` → root runner. New **Updates & packages** page (`src/UpdatesCenter.tsx`) with count/security/reboot tiles, select-and-upgrade, free-text install/remove, autoremove. Changelog links (Launchpad, via `${source:Package}`), the reboot op/button, and the unattended-upgrades toggle all landed — **complete**.
- ✅ **M2.2** Curated **Common tools** grid on the Updates page (19 packages with installed state from `packages.curated.inspect`, one-confirm install/remove via `apt.install`/`apt.remove`) + the existing free-text install.
- ✅ **M2.3** Automatic-updates toggle (`apt.unattended.inspect`/`set`, installs the package when needed) + `needrestart` integration: the Updates page lists services running pre-upgrade libraries with one-click restarts, and needrestart is in the curated tools. The nightly APT timer default stands; per-time scheduling deliberately skipped.
- ✅ **M2.4** **Services** page: systemd units/timers (Common/Active/Failed/All + filter), start/stop/restart/enable/disable via `service.action` (confirm), journal per unit; BoxPilot/SSH/systemd/D-Bus/Tailscale units cannot be stopped or disabled from the UI.
- ✅ (v1) **M2.5** **Users & SSH** page (`src/UsersCenter.tsx`): accounts with sudo/key counts and effective `sshd -T` state; add user (password-locked, optional GitHub key import), import keys (GitHub or pasted, deduped), sudo grant/revoke (high; last-sudo-user guard), SSH password login toggle (high; refuses off with zero keys, `00-boxpilot.conf` drop-in wins over cloud-init, `sshd -t` validated with rollback, then reload). Ops `users.*` + `ssh.password-auth.set` → root tasks in `server/tasks/users.mjs`. Remaining: SSH port change (needs the rollback timer).
- ✅ (v1) **M2.6** **Firewall** page (`src/FirewallCenter.tsx`): ufw state and rules read from its config files (the helper's PrivateNetwork hides live iptables), enable/disable (high; enabling always adds SSH 22/tcp + `allow in on tailscale0` first), add/delete port rules (medium; the SSH rule is undeletable), install-ufw path via `apt.install`. Ops `firewall.*` → root tasks in `server/tasks/firewall.mjs`. ✅ (v2) **Profiles** (Home server / Tailscale only / Trusted LAN with risky services denied), service presets (web, DNS, Jellyfin, Plex, SMB, mDNS, ...), optional rate-limited SSH and reset-first, a **Suggestions** panel computed from live listeners, rules, and installed apps (`server/firewall-profiles.mjs`, `GET /api/v1/firewall/overview|plan`, op `firewall.profile.apply`), and **protected ports enforced in the root task**: SSH 22/tcp, Tailscale 41641/udp, and BoxPilot's own port (read from `/etc/boxpilot/boxpilot.env`) can never be denied and their allow rules never deleted. Remaining: per-app rules wired into app install/uninstall.
- ✅ (v1) **M2.7** **System** page (`src/SystemCenter.tsx`): hostname rename (hostnamectl + /etc/hosts), time zone picker (timedatectl), memory/swap tiles, `vm.swappiness` with a persisted sysctl drop-in, fstrim.timer toggle via `service.action`. Ops `system.settings.inspect` + `system.{hostname,timezone,swappiness}.set` → root tasks in `server/tasks/system.mjs`. Locale picker (generated locales only, `update-locale`) and the managed swap file both landed — **complete**.
- ✅ (v1) **M2.8** **Storage** page (`src/StorageCenter.tsx`): lsblk device tree with usage, mount by UUID (nofail fstab entry under a `# boxpilot:<name>` marker, `findmnt --verify` before use, rollback on failure), unmount only for BoxPilot-managed entries, format (high risk + typed device name via the dialog's new `confirmText` gate; refused while anything on the device is mounted). Managed swap-file create/remove on the System page (finishes M2.7's swap item). Remaining: SMB/NFS share creation.
- ✅ (v1) **M2.9** Docker housekeeping on the System page: `docker.disk.inspect` (system df + daemon.json logging state), `docker.prune` (never volumes), and `docker.logging.set` — log rotation defaults (3 × 10 MB) plus `live-restore`, merged into daemon.json without clobbering other keys. Portainer and Dockge are catalog items. Deliberately skipped: switching a live host from `docker.io` to the docker-ce repo (risks the running app fleet for no functional gain; revisit for fresh installs in M4.1).

### Phase 3 — Data-driven catalog with install/uninstall/config/update (3 weeks)
- ✅ (v1) **M3.1** Manifest v2 schema (`server/catalog/schema.mjs`, strict, unknown keys rejected) + YAML loader (`catalog/*.yaml`, sha256 per file, invalid files reported in UI). Remaining: signature check; migrate legacy Uptime Kuma/Pi-hole/Keel adapters to manifests.
- ✅ (v1) **M3.2** Generic compose deployer `server/app-helper.mjs`: install (rollback on failure), uninstall keep-data, purge (high), update (pull + recreate + rollback to previous image), reconfigure (rollback to previous compose), start/stop/restart, logs, inspect — as registry ops `app.*`. **App catalog** page with generated config forms. 12 manifests (Jellyfin, Homepage, Portainer, Uptime Kuma, Vaultwarden, Forgejo, Syncthing, Dockge, AdGuard Home, code-server, n8n, Mealie), tags verified by `scripts/catalog-check-images.mjs`; port-conflict precheck; update-available badge. Remaining: retire legacy adapters.
- ✅ **M3.3** Generated config forms (M3.2), effective `.env`/compose viewer (`app.config.inspect`), and raw compose editing: `app.compose.edit` (high risk — a compose file is root-equivalent, so it outranks the plan's "medium") replaces the file verbatim, validates with `docker compose config`, applies with health-gated rollback, and flags the state `rawEdited`; Settings/Update regenerate from the manifest.
- ◐ **M3.4** Generated secrets live in each app's root-only `.env`; **Secrets** button on the card reveals them after a password (elevated session), audited. Remaining: encrypted central store if/when secrets need to be shared across apps or backed up separately.
- ✅ **M3.5** Catalog at 21 manifests (`scripts/catalog-check-images.mjs` verifies every tag; Paperless-ngx ships with its Redis sidecar): Jellyfin, Home Assistant, AdGuard Home, Vaultwarden, Forgejo, Portainer, Dockge, Homepage, Grafana, Uptime Kuma, Syncthing, n8n, code-server, Mealie, Navidrome, Audiobookshelf, FreshRSS, Jellyseerr, Gotify, ntfy. Remaining singles: Plex, Tautulli, Homarr, wg-easy (needs sysctls in the schema); multi-container apps (Nextcloud, Immich, Paperless-ngx, Prometheus stack, *arr stack) need compose templates with more than one service or config-file provisioning.
- ◐ **M3.6** Multi-service manifests: `sidecars` (helper services in the same compose project, reachable at their id, env `${VAR}` interpolation from the shared .env, managed backed-up volumes; forbidden with host networking; sidecar images verified by the checker). Paperless-ngx + Redis is the first. Remaining wave-2 apps now unblocked: Nextcloud+MariaDB, Immich, qBittorrent+Gluetun, Zigbee2MQTT+Mosquitto, etc.
- ◐ **M3.7** Stacks: the setup wizard's profiles are the first stacks — *Media server*, *Smart home*, *Observability*, *Dev box* install several catalog items in one approved run, with live done/ready state per item. Remaining: a shared compose network and cross-app wiring (e.g. Grafana data sources, Jellyseerr → Jellyfin) inside a bundle.
- ◐ **M3.8** Per-app Tailscale Serve: `app.serve.set` publishes any installed catalog app's web port at `https://<host>.<tailnet>.ts.net:<port>` with a real certificate (tailnet only, Funnel off); `app.serve.inspect` shows what is published; catalog cards get a serve toggle and an "Open on tailnet 🔒" link. Remaining: Caddy/NPM reverse proxy path, `<app>.lan` local DNS + internal CA, auto-register on install.
- ✅ (v1) **M3.9** Per-app card shows health pill, logs, live CPU/memory (`app.stats.inspect`, sidecars rolled up), update badge, backups, config, secrets, tailnet serve. Remaining: backup-staleness hint on the card.
- **M3.10** Import existing compose projects found in `/opt`, `~/docker` etc. → adopt into catalog ("Adopt this stack").

### Phase 4 — Install experience (1–2 weeks)
- ◐ **M4.1** `scripts/boxpilot-install.sh`: one command on a fresh Ubuntu box — Node 24 (sha256-verified), user, config, build via the upgrade script, units, access mode (tailscale/lan/local), health check, first-owner token. Re-run = upgrade. Remaining: verify on a pristine VM, GitHub Release tarballs + signature.
- ✅ (v1) **M4.2** First-run wizard: `GET /api/v1/setup` resolves five profiles (Home server, DNS appliance, Hypervisor, Dev box, Essentials) against live state — prerequisite installs with the exact candidate version pinned, automatic security updates, catalog installs, the libvirt foundation, and backup/snapshot/refresh schedules — marking each step done, ready, or blocked. The Set up this server view shows the plan, then runs the remaining steps in order through ordinary jobs (one confirmation for the batch; a password prompt appears only under Always-ask), with retry/skip on failure. The Overview offers it prominently on a fresh box and as a link afterwards.
- ✅ (v1) **M4.3** Ubuntu autoinstall generator: *Set up → Prepare a new server* renders a NoCloud `user-data`/`meta-data` pair (hostname, user with an openssl sha512-crypt password hash computed on the spot and never stored, SSH keys with password login off when a key is given, DHCP or static IPv4, direct or LVM whole-disk layout, time zone, locale) whose first-boot `runcmd` installs the chosen BoxPilot release. Copy or download, then boot the Ubuntu Server ISO with it as NoCloud data. Remaining: a ready-to-flash ISO/USB builder.
- **M4.4** `boxpilot` CLI (`boxpilot install jellyfin`, `boxpilot backup now`, `boxpilot doctor`) sharing the registry — same ops, scriptable.
- ✅ (v1) **M4.5** Self-update from GitHub Releases: `GET /api/v1/system/update` compares the running version with the latest published release (`server/release-updates.mjs`, 15-min cache); the System page shows a **BoxPilot updates** card with *Update to vX.Y.Z*. The high-risk `system.update` op pins the release's commit at staging time; the `system.update` root task re-checks that the tag still points at it, copies the upgrade script out of the tree, and launches it in a detached `boxpilot-update-<stamp>` transient unit, so the job finishes before BoxPilot restarts. The script's own health check rolls back a bad build; the page polls `/health` and reloads when the new version answers; `system.update.status` shows the last update's unit and log. A web-side notifier checks GitHub every six hours and sends one push per newer release to the configured notification target (`server/update-notifier.mjs`). Remaining: signed releases; unattended auto-apply (deliberately not offered — updates restart BoxPilot and are high risk).

### Phase 5 — Identity (1–2 weeks)
- ✅ **M5.1** Tailscale identity: `tailscale whois` on the tailnet source (direct, or X-Forwarded-For from Tailscale Serve trusted only from loopback); owner links the login once in Settings (password); sign-in screen then offers "Continue as …". Audited.
- ✅ (v1) **M5.2** GitHub OAuth device flow (no callback/secret): paste OAuth App client ID in Settings, link a GitHub login, then "Sign in with GitHub" shows code + link and polls. SSH key import from GitHub exists for VMs. Remaining: private-repo deploys.
- **M5.3** WebAuthn/passkeys + recovery codes for the local account.
- ✅ (v1) **M5.4** Roles: `owner` (everything), `operator` (stages and approves low/medium work; no settings, people, or high-risk), `viewer` (read-only, including read-only operation runs); accounts are disabled rather than deleted so jobs and audit rows stay attributable. Enforced server-side (policy middleware + `jobs.mjs` guards) and shown on the session; Settings → People (owner-only) adds accounts with a password, changes roles, and disables. Every account changes its own password under Settings → Your password (other sessions end). Remaining: hiding disallowed buttons per role.
- **M5.5** Optional OIDC (Authentik/Authelia/Pocket-ID as catalog items) for all installed apps via forward-auth in the proxy.

### Phase 6 — Backup & redeploy (2–3 weeks)
- ◐ **M6.1** Catalog apps back up generically: `app.backup` archives the compose project + backup-flagged volumes (stop → tar → restart, sha256 meta, keep-N pruning), with list/restore/delete ops and UI on each card; restore checksums the archive and saves a safety copy first. **Schedules** exist: a `schedules` table + `server/scheduler.mjs` runs any low/medium registered op hourly/daily/weekly, approved as the schedule's creator (skipped and recorded under Always-ask mode); System-page panel offers app backups, apt refresh/upgrade, and Docker cleanup. Remaining: restic destinations for catalog-app backups, DB-dump hooks, prune policy for restic repos.
- ✅ (v1) **M6.2** Destinations. Two today: (a) **off-box mirror to a backup drive** — `backup.sync` copies the local backup roots onto the independent backup mount with per-file hash verification and no deletes (USB/NFS/SMB arrive by mounting them there); (b) **off-box mirror over SSH** — `backup.remote.setup` generates an ed25519 key under `/etc/boxpilot/secrets` (the owner authorizes its public half on the destination; no password stored), `backup.remote.test` connects, creates the path, and pins the host key, and `backup.remote.sync` rsyncs the controller backups, application backups, and machine snapshots there with checksums and never deletes — all through the `boxpilot-run@` task runner since the helper has no network. Both are schedulable. Remaining: rclone (B2/S3/Drive), restic remote repositories.
- ◐ **M6.3** **Machine snapshot** v1: `host.snapshot.create` builds one root-only `machine-snapshot-*.tar.gz` — a fresh verified controller DB backup (also recorded as a normal backup row), every installed app's compose project (settings + secrets; data volumes stay in app backups), app-backup references, netplan/ufw/fstab, and each VM's domain XML — with a per-file sha256 manifest, keep-3 retention, and a Backups-page panel. Remaining: optional age encryption; users/cron capture.
- **M6.4** **Redeploy wizard**: new Ubuntu + BoxPilot → "Restore from machine snapshot" → rehydrates everything (apps first, then data restore, then DNS/proxy) with a progress view. Done when a wiped box is back in <30 min from a snapshot.
- ✅ (v1) **M6.5** Restore UX: machine-snapshot restore (apps with settings, secrets, and newest data), whole-app restore from any backup with a safety copy, VM recovery as a stopped clone, and now **single-file restore** — *Browse* any app backup (`app.backup.files`), filter, and *Restore this file* (`app.backup.restore-path`: checksum, checkpoint, brief stop, restore only that path). Remaining: in-place VM restore; restoring a single file from a machine snapshot.
- ✅ **M6.6** Backup health on dashboard: a Backups tile (last DB backup, last off-box mirror) and needs-attention entries when either is missing or older than a week.
- ✅ **M6.7** Pre-change checkpoints: `app.update`, `app.reconfigure`, and `app.compose.edit` take an ordinary app backup first (managed backup-flagged volumes only, keep-5), report it as `checkpoint` in the job result, and the card's Restore undoes the change. `checkpoint: false` opts out per job.

### Phase 7 — VMs & projects (2 weeks, builds on the existing strength)
- ✅ **M7.1+** All direct VM verbs as registry ops (start/shutdown/reboot/autostart via `vm.action`, snapshot create/revert/delete, force-off, delete) (`vm.force-off` medium, `vm.delete` high with stopped-only guard + optional storage removal, `vm.snapshot.revert` high offline-only, `vm.snapshot.delete` medium), surfaced on the Virtual Machines page through the shared ApproveDialog. Independent restic backups are never touched.
- ✅ (v1) **M7.2** "New project VM" on the Virtual Machines page: Ubuntu 24.04/22.04, Debian 13/12 cloud images downloaded + checksum-verified by the root runner and cached by digest; name/vCPU/RAM/disk, user, SSH keys (paste or import from GitHub), extra packages, autostart → `vm.cloud.create` clones the image, seeds cloud-init (guest agent, passwordless sudo), `virt-install --import`, waits for the DHCP lease, rolls back on failure. Remaining: Fedora, `runcmd`, choose network/bridge.
- **M7.3** Bridged networking option (`br0`) with a guarded netplan change + rollback timer; static leases via libvirt.
- **M7.4** Web console via noVNC/SPICE proxy through BoxPilot (behind auth) — stop punting to Cockpit.
- **M7.5** VM templates & clone; "Dev box" template with Docker + code-server inside.
- **M7.6** LXD/Incus or `systemd-nspawn` as a lighter "project container" option.
- **M7.7** GPU/USB passthrough (advanced, high risk).
- ✅ (stats) **M7.8** `vm.stats.inspect` reads `virsh domstats` (state, CPU time, vCPUs, balloon memory, block and network counters); the Virtual Machines page samples it every five seconds and shows live CPU %, memory, disk, and network rates on each running VM. Remaining: autostart ordering.

### Phase 8 — Dashboards & observability (1–2 weeks)
- ✅ (v1) **M8.1** **Home dashboard** on the Overview page (`src/HomeDashboard.tsx`): clickable tiles (updates, failed services, apps running, VMs running), a "Needs attention" list (reboot pending, updates, failed units, stopped apps, app updates, failed jobs), installed-apps grid with health pill + URL + update badge, recent activity. Sources load independently; a down source leaves its tile quiet. Remaining: backup staleness, host vitals sparkline.
- ✅ (Homepage) **M8.2** `homepage.sync` (low risk, schedulable) writes a **BoxPilot** group into Homepage's `services.yaml` with every installed catalog app — link on the host the browser uses, description, dashboard icon, live container status via the read-only Docker socket — and keeps operator-written groups; installs and uninstalls refresh it automatically once a host is known. *Sync dashboard* sits on the Homepage card. Remaining: Homarr; per-app widgets (API keys).
- **M8.3** Managed Grafana+Prometheus stack with node-exporter, cAdvisor, libvirt exporter; pre-built dashboards.
- ◐ **M8.4** Failed-job push notifications: `server/notifications.mjs` subscribes to the job-event stream and sends one push per failed job to ntfy, Gotify, or a webhook (both servers are catalog apps, so alerts can stay on-host); Settings panel with password-gated target + test button; deliveries and failures audited. Remaining triggers: updates available, backup stale, disk >90%, SMART, UPS — host-health alerting stays with the bigbox CLI per HANDOFF.md.
- ✅ **M8.5** Log viewer: registry ops `logs.sources` (journal groups, every systemd unit, every container) and `logs.read` (tail any of them with a time window and text filter, redacted). The Logs page offers group tabs, a unit finder, a container picker, follow mode, and download; the support bundle reads through the same op. The fixed-four-sources route and `system.logs.inspect` legacy op are deleted.

### Phase 9 — Network platform (2 weeks)
- ✅ (v1) **M9.1** Pi-hole/AdGuard as a **DNS platform** role: Pi-hole (`catalog/pi-hole.yaml`) and AdGuard Home are catalog manifests. Pi-hole's manifest uses the new generic `setup` block (`server/catalog/schema.mjs`, applied by `app-helper.applySetup` via `docker compose exec`) to offer popular blocklists (OISD, HaGeZi, Firebog, Smart TV telemetry) with links; the chosen ones are inserted idempotently into gravity after install and on every settings change, then gravity updates. Remaining: set as host resolver, push to DHCP (via router API where available), rollback timer if resolution breaks.
- **M9.2** Router integration for OpenWrt/GL.iNet (Flint 2 is OpenWrt: use `ubus`/LuCI RPC with stored credential in secrets store): read DHCP leases, set DNS/DHCP options, static leases, port forwards — each medium/high risk with checkpoint+rollback. Later: UniFi, MikroTik, pfSense/OPNsense adapters.
- **M9.3** Local DNS names for every installed app (`*.lan` or `*.home.arpa`) via the DNS platform.
- **M9.4** Tailscale: join/leave, serve/funnel per app, exit-node toggle, subnet router toggle, ACL hints; Headscale option.
- **M9.5** WireGuard/wg-easy quick VPN as catalog item with QR.
- ✅ (v1) **M9.6** Network page lists the devices this server has talked to (IPv4 neighbour table with MAC, interface, and reachability) and can **Wake** any of them — `network.wake` (low risk) broadcasts Wake-on-LAN magic packets from the root task runner. Remaining: name resolution for devices, an active scan, a dashboard tile.

### Phase 10 — Dev/project workflows (ongoing)
- **M10.1** "Deploy from GitHub repo": pick repo (OAuth), detect compose/Dockerfile, build & run, webhook or poll for auto-redeploy on push.
- **M10.2** Environments per project (VM or container), with port/proxy/DNS auto-wired and teardown.
- **M10.3** Cron/timer builder UI; managed scripts folder.
- **M10.4** Terminal in browser (ttyd/xterm.js through BoxPilot auth) — escape hatch for everything not yet a button.
- **M10.5** Plugin/adapter SDK: a catalog entry can ship a small UI panel and custom ops (signed).

### Phase 11 — Multi-host (later)
- **M11.1** Register a second Ubuntu box (agent = the same BoxPilot in agent mode over Tailscale); unified dashboard.
- **M11.2** Move/copy an installed app or VM between hosts (the existing Migration Center code becomes useful here).
- **M11.3** Fleet-wide updates and backup policy.

### Phase 12 — Quality & project hygiene (continuous)
- ✅ (v1) **M12.1** Install smoke test (`.github/workflows/install-smoke.yml`): every push installs BoxPilot on a throwaway Ubuntu runner with the production installer at that commit, then checks both systemd units, the health version, owner bootstrap, an authenticated operations listing, a canary round trip through the root helper socket, and the setup profiles. Remaining: KVM/Docker-backed scenarios (nested virtualization or a self-hosted runner).
- ✅ (lint) **M12.2** ESLint 10 flat config over `server/` and `scripts/` (recommended rules, unused-vars, no-undef) runs inside `npm run check`; the first pass caught a real regression (a helper lost `parseJsonLines` during the log-viewer cleanup, which would have broken Docker inventory). The UI is type-checked by `tsc -b` in the build. Remaining: Prettier, a pre-commit hook, server typecheck via JSDoc.
- ✅ **M12.3** Release workflow (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag runs `npm run check`, verifies the tag matches `package.json`, and publishes a GitHub Release with generated notes and the update instructions; self-update picks it up.
- ✅ **M12.4** README rewritten (6 KB): what it does, the one-line install, self-update, a per-page capability table, how it works in six bullets, docs index. The 76 KB version-by-version narrative, the mockups, and the docs for removed features (Keel, fleet, migrations, routers, legacy adapters) moved to `docs/legacy/`. Remaining: real UI screenshots.
- ✅ (code) **M12.5** Deleted: the entire Keel machinery (never installed on the host), the legacy Uptime Kuma/Pi-hole adapters and Applications page (superseded by the catalog), Migration Center, Fleet, Router checkpoints, and the DNS-acceptance flows — 108 files. Generic Docker/journal inspection was extracted to `server/host-inspect-helper.mjs`. Controller database backup was ported to registry op `controller.backup.create` with a new `operationRecordHooks` mechanism; the Backups page was rebuilt around it. The sixteen retired-feature state tables (legacy application recovery/protection/retention, migrations, fleet, router checkpoints, DNS acceptance) and their store functions are dropped — including DROP TABLE on upgrade — and the recovery kit reads live catalog evidence instead.

---

## 7. "Wish we could" / would be nice

- **One URL from bare metal**: flash USB → boot → phone shows a QR → open BoxPilot. (M4.3 gets 90% there.)
- **Undo for everything**: every change is a checkpoint; the Activity drawer has "Undo" on each item for 24h.
- **Dry-run for everything**: show the exact commands/compose diff before any medium/high op — keeps the *spirit* of today's evidence model without the ceremony.
- **Mobile-first approval**: push notification "Update available for Jellyfin — Approve?" → tap → done (ntfy + Tailscale).
- **Profiles as code**: export the machine as `boxpilot.yaml` (like a Brewfile/NixOS config-lite); `boxpilot apply boxpilot.yaml` on a new box. Commit it to GitHub; the GitHub link makes this trivially versioned.
- **Declarative drift detection**: "this box has 3 things installed that aren't in your profile, and 1 thing in your profile isn't installed."
- **App marketplace from GitHub**: community catalog repo; star/fork → shows up in your BoxPilot (signed).
- **Snapshot-before-upgrade with automatic rollback** on failed health (already half-built for Keel; generalize).
- **Disk-aware installs**: pick which disk/pool an app's data lives on; ZFS/btrfs snapshots when available (instant checkpoints).
- **Guided hardware setup**: detect GPU (Intel QSV/NVIDIA) and offer transcoding config for Jellyfin/Plex/Frigate automatically.
- **Power**: UPS (NUT) install + shutdown policy with one toggle; scheduled wake/sleep for a lab box.
- **Cost/energy panel**: power draw estimate, uptime, what's idle.
- **AI assist**: paste a docker-compose from a blog → BoxPilot turns it into a catalog manifest with config form, flags risky bits, offers install.
- **"Explain this"** on any job: plain-English narration of what it will do (this is where the existing prose-generation habit becomes a feature, not a tax).
- **Windows/macOS client**: a tiny tray app that shows the box's health and opens BoxPilot over Tailscale.
- **Family mode**: a second, read-only "status" view for non-admins ("Is Jellyfin up?").

---

## 8. Housekeeping found during the check

- `server/storage-evidence.test.mjs:40-41` — failing since 08-17 (no `now` injection).
- Version `0.61.0` hard-coded in `index.mjs:173`, `index.mjs:1183`, `helper-server.mjs:164`, helper canary.
- `helper-protocol.mjs` instantiates helper factories as default params → some helpers constructed twice.
- Failure classification via `error.message.includes("Automated rollback completed")` (`jobs.mjs:855-878`) — brittle.
- `UBUNTU-SERVER-INSTALL-RUNBOOK.md` publishes a MAC address, DHCP reservation, router model/IP.
- Three stale `codex/*` remote branches.
- Dockerfile/compose are a demo only; README implies a deployment path.
- `/api/v1/capabilities` returns prose slugs as values.
- Zero TODO/FIXME anywhere — debt is structural duplication, not annotated.

---

## 9. Suggested first two weeks

1. **Day 1–2**: M0.1–M0.5 (green CI, one version, de-Bigbox, ADR + `AGENTS.md` stating the new goal).
2. **Day 3–7**: M1.1–M1.3 — registry, template unit, risk tiers, `ApproveAction`. Port the existing 5 repairs + lifecycle verbs to prove the shape.
3. **Day 8–10**: M2.1 + M2.4 — Updates page and Services page. These are the first features that make it *feel* like a setup tool.
4. **Day 11–14**: M3.1–M3.2 — manifest files + generic compose deployer; Uptime Kuma and Pi-hole with zero app-specific code; add Jellyfin as the proof (<100 lines YAML).

After that, M4.1 (installer) and M4.2 (wizard) make it something you can hand to a fresh box.
