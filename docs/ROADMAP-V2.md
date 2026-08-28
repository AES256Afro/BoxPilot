# BoxPilot v2, from "safety-first control plane" to "point-and-click server setup"

Assessment of the repo at `0.61.0` (93 commits, 2026-08-14 → 08-16) against the stated goal: *open the app, click install. Updates, apps, platforms like Pi-hole, dashboards, VMs, auth via GitHub/Tailscale, backup/restore for fast redeploys, uninstall and config edits.*

---

## 1. Verdict in five lines

1. The codebase is **large (39k LOC, 590 tests, 121 routes, 34 SQLite tables, 75 helper ops)** and **well-built at the primitive level**. Auth, the root-helper socket, the systemd-oneshot-with-approval-file escalation pattern, durable jobs, and the SQLite layer are all genuinely solid.
2. It is **not a setup tool**; it is a *provenance and evidence engine* that happens to install four things. Every capability is expressed as one fixed, parameter-free, password-approved operation with a page of English prose proving what it *didn't* do.
3. The "safety" is **structural, not a setting**. It is baked into three hand-synced allowlists, a 752-line approval function, and per-op prose. You cannot flip a flag to unlock it. You have to change the shape.
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
| Hard-coding | the original hostname in 102 files incl. a stored enum `pihole-on-<host>`; version string in 4 places; libvirt subnet in 4 places | `network.mjs:8`, `index.mjs:173,1183` |
| Health | Build ✅. Tests 589/590. One time-bomb (fixture dated 08-16 vs 24h stale window, no injected clock) | `server/storage-evidence.test.mjs:40-41` |

---

## 3. Why it feels "built for safety", the root causes

These are the things that must change; everything else is polish.

1. **Password-per-action, with no tiers.** Every mutation, even "restart Uptime Kuma", is plan → stage → navigate → password → approve. There is no notion of risk level, no session "sudo mode", no one-click for low-risk actions.
2. **Fixed, argument-less operations.** The helper refuses anything it wasn't hand-taught. `docker install` accepts exactly `{expectedVersion}`; apt refresh is metadata-only *by design*. General `apt install <pkg>` does not exist, nor does `systemctl restart <unit>`, nor `docker compose up` for anything unknown.
3. **Prose as the product.** `/api/v1/capabilities` returns 300-character hyphenated slugs of what it *won't* do; every job carries four paragraphs of boundary prose; the README is 73 KB of disclaimers. This is overhead on every feature and noise in every screen.
4. **Three-list allowlist + mega-ternary.** New op = touch protocol Set, read-only Set, timeout ladder, validator, dispatcher, helper module, script, unit, plan module, `jobs.mjs` (4 places), route, UI, tests. Nothing is data-driven.
5. **Per-workflow ledgers.** 30 of 34 tables are "X_runs / X_members" for one workflow each. A generic installer needs ~6 tables.
6. **No uninstall / no config / no update.** The three operations a setup tool lives on are all explicitly "pending".
7. **No installer and no wizard.** First run requires SSH, ~40 sudo commands, and a terminal-only bootstrap token.
8. **Single-host, single-owner, single-LAN assumptions** hard-coded as product copy (the hostname, the router model, the LAN subnet, `pihole-on-<host>`).

---

## 4. What to keep (don't throw these away)

- `server/security.mjs`: Scrypt, sessions, CSRF. Extend, don't replace.
- `server/helper-client.mjs` + the Unix-socket framing + `operationQueue` serialization.
- **The escalation pattern**: root helper + static oneshot units gated on a 0600 approval file. Generalize it: one `boxpilot-run.service` template (`boxpilot-run@<jobid>.service`) that reads a signed job spec instead of 15 named units.
- `deploy/boxpilot-helper.service` hardening (`ProtectSystem=strict`, pinned binary env). Template for every new unit.
- `state.mjs` primitives: `jobs`, `plans`, `job_steps`, `approvals`, `audit_events`, `recoverInterruptedJobs`, plan revision hashing, WAL SQLite.
- The VM subsystem nearly whole (`vm-*.mjs`, `libvirt*.mjs`, `VmPlanner`, `VmMediaLibrary`).
- restic backup/restore/drill machinery as a *library*. Rewrap it behind a generic "protect this path set" API.
- The manifest *shape* in `applications.mjs` (image+digest, ports, storage, prerequisites, health, rollback), move it to files.
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

### 5.9 De-hostname
`settings.hostAlias` + remove hard-coded strings; migrate `pihole-on-<host>` → `pihole-on-host`. Move the runbook's personal network table (it contains a MAC address and LAN layout) to a `.local` ignored file or a template with placeholders.

---

## 6. Milestones (long list)

Grouped by phase; each has a "done when". Phases 0–3 are the pivot; 4+ are growth. Numbers are for reference, not strict order inside a phase.

### Phase 0, Stop the bleeding (1 week), **done 2026-08-19 on branch `phase-0`**
- ✅ **M0.1** Fix time-bomb test (`storage-evidence.test.mjs:40-41`. Pass `{ now }`); add `vi.useFakeTimers` policy. Done when CI green on any date.
- ✅ **M0.2** Single `VERSION` source (package.json) read by server, helper, protocol. Done when 4 literals become 1.
- ✅ **M0.3** Replace hostname strings; `pihole-on-<host>` → `pihole-on-host` with a read-side alias (no SQL migration needed. Plans expire in 30 min). Chose neutral wording over a `hostAlias` setting; the authenticated UI already shows the real hostname from inventory.
- ✅ **M0.4** Strip personal data from `UBUNTU-SERVER-INSTALL-RUNBOOK.md` (MAC, reservation, router model) into placeholders.
- ✅ **M0.5** Write `docs/DECISIONS.md` ADR-001: "Risk tiers replace universal password approval" so future Codex runs stop re-adding ceremony. Add a `CLAUDE.md`/`AGENTS.md` that states the product goal in one paragraph.

### Phase 1. Registry + risk tiers (2 weeks)
- ✅ **M1.1** `server/ops/registry.mjs` (declarative param spec; JSON Schema can replace it later). **The port is complete: every mutation is a registry operation.** `jobs.mjs` executes only `op:` jobs; the helper's hand-declared list (`legacyHelperOperations`) holds 14 read-only inspections, and each mutating service revalidates its own typed input at execution time. The final batch moved the seven VM workflows (media import, create, export, protection, retention, restore drill, recovery) to ops `vm.media.import`, `vm.create`, `vm.export.create`, `vm.export.protect`, `vm.backup.retention.apply`, `vm.backup.restore-drill`, `vm.recovery.create`: the plan/stage ceremony is gone. The browser names only the subject (a domain name, an export id, a backup id), `operationPrepareHooks` pin the recorded evidence and live revisions server-side at staging time, `operationRecordHooks` turn results into durable evidence rows, and the helper services keep their full TOCTOU revalidation. The VM pages stage everything through the shared risk-tiered ApproveDialog; VmPlanner keeps its host-checked preview and hands the validated input to `vm.create` approval.
- ✅ (foundation) **M1.2** `deploy/boxpilot-run@.service` template unit + `scripts/boxpilot-run.mjs` + root task table `server/tasks/` + helper client `server/run-unit.mjs`. New networked root work needs zero new unit files. Remaining: migrate the 13 named install/Keel units onto it.
- ✅ (server + Repair Center) **M1.3** Risk tiers (`server/ops/risk.mjs`: per-job-type tier, unknown → high), approval policy (low/medium = no password, high = password unless session elevated ≤10 min, `always-password` setting), `POST/DELETE /api/v1/auth/elevate`, `GET /api/v1/jobs/:id/approval`, `GET/PUT /api/v1/settings/approval-mode`, approvals record `method`+`tier`. Repair Center desk is tier-aware ("Run" one-click for low). Shared `ApproveDialog` + `useOperation` hook (`src/ApproveDialog.tsx`) used by Updates and App catalog: stage → tier-aware approve → live output → result. Settings page has the Tiered / Always-ask toggle. `elevatedOnly` read-only ops (e.g. `app.secrets`) require a recent password and are audited. Remaining: adopt the dialog in the legacy Applications/VM centers.
- ✅ **M1.4** Generic job path is the only path: `POST /api/v1/operations/:id/jobs` stages any registered mutating op as `op:<id>`; approval/execution are generic (`jobs.createOperationJob`), `GET /api/v1/operations/:id/inspect` runs read-only ops directly; the legacy executor branch is deleted. `index.mjs` is a ~190-line composition root; routes live in `server/routes/` (operations, jobs+schedules+events, virtualization, settings, host+catalog+evidence, identity). Every approved job runs in the background (202) since all jobs are registry ops.
- ✅ **M1.5** SSE `/api/v1/events` (job snapshots on every create/approve/step/finish, coalesced per job) + Activity drawer in the topbar: running-job badge, recent-job history, expandable step log and live output (`src/ActivityDrawer.tsx`). Per-job output streaming stays on `/api/v1/jobs/:id/stream`.
- ✅ **M1.6** `capabilities` endpoint returns a matrix of booleans, enums, counts, and registered operation ids derived from the registry, no prose.

### Phase 2. Host primitives: updates, packages, services (2 weeks)
- ✅ (v1) **M2.1** Registry ops `apt.upgradable.inspect`, `apt.refresh`, `apt.upgrade` (all/selected), `apt.install`, `apt.remove`, `apt.purge` (high), `apt.autoremove` → root runner. New **Updates & packages** page (`src/UpdatesCenter.tsx`) with count/security/reboot tiles, select-and-upgrade, free-text install/remove, autoremove. Changelog links (Launchpad, via `${source:Package}`), the reboot op/button, and the unattended-upgrades toggle all landed, **complete**.
- ✅ **M2.2** Curated **Common tools** grid on the Updates page (19 packages with installed state from `packages.curated.inspect`, one-confirm install/remove via `apt.install`/`apt.remove`) + the existing free-text install.
- ✅ **M2.3** Automatic-updates toggle (`apt.unattended.inspect`/`set`, installs the package when needed) + `needrestart` integration: the Updates page lists services running pre-upgrade libraries with one-click restarts, and needrestart is in the curated tools. The nightly APT timer default stands; per-time scheduling deliberately skipped.
- ✅ **M2.4** **Services** page: systemd units/timers (Common/Active/Failed/All + filter), start/stop/restart/enable/disable via `service.action` (confirm), journal per unit; BoxPilot/SSH/systemd/D-Bus/Tailscale units cannot be stopped or disabled from the UI.
- ✅ (v1) **M2.5** **Users & SSH** page (`src/UsersCenter.tsx`): accounts with sudo/key counts and effective `sshd -T` state; add user (password-locked, optional GitHub key import), import keys (GitHub or pasted, deduped), sudo grant/revoke (high; last-sudo-user guard), SSH password login toggle (high; refuses off with zero keys, `00-boxpilot.conf` drop-in wins over cloud-init, `sshd -t` validated with rollback, then reload). Ops `users.*` + `ssh.password-auth.set` → root tasks in `server/tasks/users.mjs`. Remaining: SSH port change (needs the rollback timer).
- ✅ (v1) **M2.6** **Firewall** page (`src/FirewallCenter.tsx`): ufw state and rules read from its config files (the helper's PrivateNetwork hides live iptables), enable/disable (high; enabling always adds SSH 22/tcp + `allow in on tailscale0` first), add/delete port rules (medium; the SSH rule is undeletable), install-ufw path via `apt.install`. Ops `firewall.*` → root tasks in `server/tasks/firewall.mjs`. ✅ (v2) **Profiles** (Home server / Tailscale only / Trusted LAN with risky services denied), service presets (web, DNS, Jellyfin, Plex, SMB, mDNS, ...), optional rate-limited SSH and reset-first, a **Suggestions** panel computed from live listeners, rules, and installed apps (`server/firewall-profiles.mjs`, `GET /api/v1/firewall/overview|plan`, op `firewall.profile.apply`), and **protected ports enforced in the root task**: SSH 22/tcp, Tailscale 41641/udp, and BoxPilot's own port (read from `/etc/boxpilot/boxpilot.env`) can never be denied and their allow rules never deleted. Remaining: per-app rules wired into app install/uninstall.
- ✅ (v1) **M2.7** **System** page (`src/SystemCenter.tsx`): hostname rename (hostnamectl + /etc/hosts), time zone picker (timedatectl), memory/swap tiles, `vm.swappiness` with a persisted sysctl drop-in, fstrim.timer toggle via `service.action`. Ops `system.settings.inspect` + `system.{hostname,timezone,swappiness}.set` → root tasks in `server/tasks/system.mjs`. Locale picker (generated locales only, `update-locale`) and the managed swap file both landed, **complete**.
- ✅ (v1) **M2.8** **Storage** page (`src/StorageCenter.tsx`): lsblk device tree with usage, mount by UUID (nofail fstab entry under a `# boxpilot:<name>` marker, `findmnt --verify` before use, rollback on failure), unmount only for BoxPilot-managed entries, format (high risk + typed device name via the dialog's new `confirmText` gate; refused while anything on the device is mounted). Managed swap-file create/remove on the System page (finishes M2.7's swap item). ✅ (v2) Inventory moved to the web process (`server/storage-inventory.mjs`, `GET /api/v1/storage/overview`) because the helper's `PrivateDevices` hid device-mapper nodes, so LVM volumes (the root filesystem on a default Ubuntu install) were invisible and their physical volume looked like a free partition. LVM volume groups are shown with unallocated space and a one-click **Use the rest of the disk** (`storage.lvm.extend`, online `lvextend -r`); **protected devices** (system disk, LVM/RAID/LUKS members, anything with mounted children) are refused in the root task (`assertNotProtected`) and hidden in the UI. **Network shares** (`server/tasks/shares.mjs`, ops `share.mount`/`share.unmount`): LAN discovery by TCP probe of 445/2049 across the /24 (`/storage/shares/discover`), share listing via smbclient/showmount, fstab entries with `nofail,_netdev,x-systemd.automount`, SMB credentials root-only under `/etc/boxpilot/secrets`, readable error explanations; the password is a `secret` parameter the job service keeps in memory only (never SQLite). `catalog/filebrowser.yaml` (loopback-only; publish with Tailscale Serve) for browsing shares remotely. ✅ (v3) **Samba file server** (`server/tasks/samba.mjs`, ops `samba.inspect/apply/user.set/user.remove`, `src/SambaPanel.tsx`): declarative shares rendered into `/etc/samba/smb.conf` (validated with testparm, original kept as `smb.conf.before-boxpilot`), bound to `lo` + `tailscale0` by default so shares are reachable only over the tailnet, optional LAN scope (adds the default-route interface and NetBIOS), guest/any-user/selected-users access, `force user` set to the folder owner so shared folders just work, shell-less Samba accounts in `sambashare` with passwords fed to smbpasswd on stdin (secret job parameter). ✅ (v4) **NFS server** (`server/tasks/nfs.mjs`, ops `nfs.inspect/apply`, `src/NfsPanel.tsx`): exports in `/etc/exports.d/boxpilot.exports`, NFSv4 only (`/etc/nfs.conf.d/boxpilot.conf`), offered to `100.64.0.0/10` and optionally the link-local LAN subnets, clients squashed to the folder owner, validated with `exportfs -ra` and rolled back on rejection. Remaining: per-mount uid/gid choice, Time Machine shares.
- ✅ (v1) **M2.9** **UPS monitoring** (`server/ups-detect.mjs`, `server/tasks/ups.mjs`, op `ups.setup`, `src/UpsPanel.tsx` on the System page): a USB UPS is recognised from sysfs vendor ids (APC, CyberPower, Eaton, Tripp Lite, Belkin, PowerWalker, ...), NUT is installed via `apt.install`, and one medium-risk job writes the standalone NUT configuration (driver, upsd on loopback, generated monitor password, upsmon with optional clean shutdown at low battery), starts the driver and services, and verifies a status. The Overview's UPS card (existing `server/ups.mjs` reader) then shows it. Not verified on hardware: the development server has no UPS. ✅ (v2, 1.6–1.8) **Housekeeping** (`server/housekeeping.mjs`, `housekeeping.inspect/reclaim`): previous BoxPilot trees under every naming scheme the updater ever used (keeps the newest revertible one and the last failure), orphaned layers + build cache, images no container or installed app references, backup archives behind the newest 3 per app, abandoned restore folders, stale job logs. Tick what to clear. Deliberately not `docker system prune`: that removes a stopped app's network and Docker then refuses to start it (verified on Docker 29); `app.action start` now recovers from that wreckage by recreating the container.
- ✅ (v1) **M2.10** **Brute-force protection** (`server/tasks/fail2ban.mjs`, ops `fail2ban.inspect/apply`, `src/Fail2banPanel.tsx` on the Firewall page, advice entry): one managed jail file enables the sshd jail (journal backend for Ubuntu 24.04, ufw ban action when ufw is present) with owner-chosen thresholds; loopback, the tailnet, and optionally the LAN are never banned. Remaining: CrowdSec, jails for proxied web apps.
- ✅ (v1) **M2.11** **LVM snapshots** (`storage.lvm.snapshot.create/delete/rollback` root tasks, Storage page Snapshots panel, `src/SnapshotFirstButton.tsx` on the Updates page): copy-on-write restore points named `boxpilot-snap-<time>[-label]`; metadata (origin, size, time) is recorded web-side because `lvs` needs root, and the web inventory collapses the `-real`/`-cow` device-mapper internals and marks snapshots protected. Rollback is high risk with the snapshot name typed; for the root volume the merge happens on the next reboot. **Use the rest of the disk** now keeps 32 GiB unallocated for snapshots. Remaining: snapshot usage (data%) needs a root reader; automatic snapshot before `apt.upgrade`.
- ✅ (v1) **M2.9** Docker housekeeping on the System page: `docker.disk.inspect` (system df + daemon.json logging state), `docker.prune` (never volumes), and `docker.logging.set`. Log rotation defaults (3 × 10 MB) plus `live-restore`, merged into daemon.json without clobbering other keys. Portainer and Dockge are catalog items. Deliberately skipped: switching a live host from `docker.io` to the docker-ce repo (risks the running app fleet for no functional gain; revisit for fresh installs in M4.1).

### Phase 3. Data-driven catalog with install/uninstall/config/update (3 weeks)
- ✅ (v1) **M3.1** Manifest v2 schema (`server/catalog/schema.mjs`, strict, unknown keys rejected) + YAML loader (`catalog/*.yaml`, sha256 per file, invalid files reported in UI). ✅ (v2) Schema grew `setup` (post-install choices run inside the app or a named sidecar, idempotent, re-applied on settings changes), device globs (`/dev/sd?` resolved at install), `networkVia` (the app lives in a sidecar's network namespace; ports are published there. VPN-routed downloaders), and sidecar `capabilities`/`devices`; sidecar env may reference any app setting as `${NAME}` (secrets stay .env references). Legacy adapters are gone (M12.5). ✅ (2026-08-21) **Live smoke test** of 27 manifests on the real host (isolated catalog root, loopback binds, install → health → purge): 26 came up, including Immich, Nextcloud, Open WebUI + Ollama, Pi-hole + Unbound, Scrutiny with device globs; it found two real defects, both fixed. Images running as a fixed non-root user need `user:` and the deployer now chowns managed volumes to it, and Pi-hole's start script needs CAP_SETFCAP so its manifest keeps Docker's default capability set. Remaining: signature check, GPU reservations, `shm_size`.
- ✅ (v1) **M3.2** Generic compose deployer `server/app-helper.mjs`: install (rollback on failure), uninstall keep-data, purge (high), update (pull + recreate + rollback to previous image), reconfigure (rollback to previous compose), start/stop/restart, logs, inspect, as registry ops `app.*`. **App catalog** page with generated config forms. 12 manifests (Jellyfin, Homepage, Portainer, Uptime Kuma, Vaultwarden, Forgejo, Syncthing, Dockge, AdGuard Home, code-server, n8n, Mealie), tags verified by `scripts/catalog-check-images.mjs`; port-conflict precheck; update-available badge. Remaining: retire legacy adapters.
- ✅ **M3.3** Generated config forms (M3.2), effective `.env`/compose viewer (`app.config.inspect`), and raw compose editing: `app.compose.edit` (high risk. A compose file is root-equivalent, so it outranks the plan's "medium") replaces the file verbatim, validates with `docker compose config`, applies with health-gated rollback, and flags the state `rawEdited`; Settings/Update regenerate from the manifest.
- ◐ **M3.4** Generated secrets live in each app's root-only `.env`; **Secrets** button on the card reveals them after a password (elevated session), audited. Remaining: encrypted central store if/when secrets need to be shared across apps or backed up separately.
- ✅ **M3.5** Catalog at 21 manifests (`scripts/catalog-check-images.mjs` verifies every tag; Paperless-ngx ships with its Redis sidecar): Jellyfin, Home Assistant, AdGuard Home, Vaultwarden, Forgejo, Portainer, Dockge, Homepage, Grafana, Uptime Kuma, Syncthing, n8n, code-server, Mealie, Navidrome, Audiobookshelf, FreshRSS, Jellyseerr, Gotify, ntfy. Remaining singles: Plex, Tautulli, Homarr, wg-easy (needs sysctls in the schema); multi-container apps (Nextcloud, Immich, Paperless-ngx, Prometheus stack, *arr stack) need compose templates with more than one service or config-file provisioning.
- ◐ **M3.6** Multi-service manifests: `sidecars` (helper services in the same compose project, reachable at their id, env `${VAR}` interpolation from the shared .env, managed backed-up volumes; forbidden with host networking; sidecar images verified by the checker). Paperless-ngx + Redis is the first. Remaining wave-2 apps now unblocked: Nextcloud+MariaDB, Immich, qBittorrent+Gluetun, Zigbee2MQTT+Mosquitto, etc.
- ◐ **M3.7** Stacks: the setup wizard's profiles are the first stacks. *Media server*, *Smart home*, *Observability*, *Dev box* install several catalog items in one approved run, with live done/ready state per item. Remaining: a shared compose network and cross-app wiring (e.g. Grafana data sources, Jellyseerr → Jellyfin) inside a bundle.
- ◐ **M3.8** Per-app Tailscale Serve: `app.serve.set` publishes any installed catalog app's web port at `https://<host>.<tailnet>.ts.net:<port>` with a real certificate (tailnet only, Funnel off); `app.serve.inspect` shows what is published; catalog cards get a serve toggle and an "Open on tailnet 🔒" link. Remaining: Caddy/NPM reverse proxy path, `<app>.lan` local DNS + internal CA, auto-register on install. ✅ (1.7) **Exposure per app** (`values.exposure` lan|tailnet, `app.exposure.set`): tailnet-only rebinds HTTP ports to loopback behind Serve; each manifest port declares `tailnet: serve|address|unchanged` so protocol ports (git SSH, sync, RTSP, game) move to the tailnet address and house services (DNS 53, a proxy's 80/443, UniFi inform) stay on the LAN. The confirmation names which is which.
- ✅ (v1) **M3.9** Per-app card shows health pill, logs, live CPU/memory (`app.stats.inspect`, sidecars rolled up), update badge, backups, config, secrets, tailnet serve. Remaining: backup-staleness hint on the card.
- ◐ **M3.10** (v1.51.0) The honest first half: the App catalog lists compose projects BoxPilot did
  not create (`compose.projects.inspect` via `docker compose ls`), with status and compose file
  locations, so the page tells the whole truth about the machine. Adopting one into the catalog
  ("Adopt this stack") remains the second half.

### Phase 4, Install experience (1–2 weeks)
- ◐ **M4.1** `scripts/boxpilot-install.sh`: one command on a fresh Ubuntu box. Node 24 (sha256-verified), user, config, build via the upgrade script, units, access mode (tailscale/lan/local), health check, first-owner token. Re-run = upgrade. Remaining: verify on a pristine VM, GitHub Release tarballs + signature.
- ✅ (v1) **M4.2** First-run wizard: `GET /api/v1/setup` resolves five profiles (Home server, DNS appliance, Hypervisor, Dev box, Essentials) against live state. Prerequisite installs with the exact candidate version pinned, automatic security updates, catalog installs, the libvirt foundation, and backup/snapshot/refresh schedules. Marking each step done, ready, or blocked. The Set up this server view shows the plan, then runs the remaining steps in order through ordinary jobs (one confirmation for the batch; a password prompt appears only under Always-ask), with retry/skip on failure. The Overview offers it prominently on a fresh box and as a link afterwards.
- ✅ (v1) **M4.3** Ubuntu autoinstall generator: *Set up → Prepare a new server* renders a NoCloud `user-data`/`meta-data` pair (hostname, user with an openssl sha512-crypt password hash computed on the spot and never stored, SSH keys with password login off when a key is given, DHCP or static IPv4, direct or LVM whole-disk layout, time zone, locale) whose first-boot `runcmd` installs the chosen BoxPilot release. Copy or download, then boot the Ubuntu Server ISO with it as NoCloud data. Remaining: a ready-to-flash ISO/USB builder.
- **M4.4** `boxpilot` CLI (`boxpilot install jellyfin`, `boxpilot backup now`, `boxpilot doctor`) sharing the registry, same ops, scriptable.
- ✅ (v1) **M4.5** Self-update from GitHub Releases: `GET /api/v1/system/update` compares the running version with the latest published release (`server/release-updates.mjs`, 15-min cache); the System page shows a **BoxPilot updates** card with *Update to vX.Y.Z*. The high-risk `system.update` op pins the release's commit at staging time; the `system.update` root task re-checks that the tag still points at it, copies the upgrade script out of the tree, and launches it in a detached `boxpilot-update-<stamp>` transient unit, so the job finishes before BoxPilot restarts. The script's own health check rolls back a bad build; the page polls `/health` and reloads when the new version answers; `system.update.status` shows the last update's unit and log. A web-side notifier checks GitHub every six hours and sends one push per newer release to the configured notification target (`server/update-notifier.mjs`). Remaining: signed releases; unattended auto-apply (deliberately not offered. Updates restart BoxPilot and are high risk).

### Phase 5, Identity (1–2 weeks)
- ✅ **M5.1** Tailscale identity: `tailscale whois` on the tailnet source (direct, or X-Forwarded-For from Tailscale Serve trusted only from loopback); owner links the login once in Settings (password); sign-in screen then offers "Continue as …". Audited.
- ✅ (v1) **M5.2** GitHub OAuth device flow (no callback/secret): paste OAuth App client ID in Settings, link a GitHub login, then "Sign in with GitHub" shows code + link and polls. SSH key import from GitHub exists for VMs. Remaining: private-repo deploys.
- **M5.3** WebAuthn/passkeys + recovery codes for the local account.
- ✅ (v1) **M5.4** Roles: `owner` (everything), `operator` (stages and approves low/medium work; no settings, people, or high-risk), `viewer` (read-only, including read-only operation runs); accounts are disabled rather than deleted so jobs and audit rows stay attributable. Enforced server-side (policy middleware + `jobs.mjs` guards) and shown on the session; Settings → People (owner-only) adds accounts with a password, changes roles, and disables. Every account changes its own password under Settings → Your password (other sessions end). Remaining: hiding disallowed buttons per role.
- **M5.5** Optional OIDC (Authentik/Authelia/Pocket-ID as catalog items) for all installed apps via forward-auth in the proxy.

### Phase 6. Backup & redeploy (2–3 weeks)
- ◐ **M6.1** Catalog apps back up generically: `app.backup` archives the compose project + backup-flagged volumes (stop → tar → restart, sha256 meta, keep-N pruning), with list/restore/delete ops and UI on each card; restore checksums the archive and saves a safety copy first. **Schedules** exist: a `schedules` table + `server/scheduler.mjs` runs any low/medium registered op hourly/daily/weekly, approved as the schedule's creator (skipped and recorded under Always-ask mode); System-page panel offers app backups, apt refresh/upgrade, and Docker cleanup. Remaining: restic destinations for catalog-app backups, DB-dump hooks, prune policy for restic repos.
- ✅ (v1) **M6.2** Destinations. Two today: (a) **off-box mirror to a backup drive**. `backup.sync` copies the local backup roots onto the independent backup mount with per-file hash verification and no deletes (USB/NFS/SMB arrive by mounting them there); (b) **off-box mirror over SSH**. `backup.remote.setup` generates an ed25519 key under `/etc/boxpilot/secrets` (the owner authorizes its public half on the destination; no password stored), `backup.remote.test` connects, creates the path, and pins the host key, and `backup.remote.sync` rsyncs the controller backups, application backups, and machine snapshots there with checksums and never deletes. All through the `boxpilot-run@` task runner since the helper has no network. Both are schedulable. ✅ (v2) (c) **cloud destination through rclone** (`server/backup-cloud.mjs`, `server/tasks/backup-cloud.mjs`, ops `backup.cloud.inspect/setup/test/sync`, `src/CloudBackupPanel.tsx`): Backblaze B2, S3-compatible, WebDAV, and Google Drive/OneDrive/Dropbox (token pasted from `rclone authorize`); keys and tokens are secret job parameters written only into root-only `/etc/boxpilot/secrets/rclone.conf`, the non-secret description is a setting that prepare hooks pin into test/sync jobs, `rclone copy --checksum` never deletes, and the sync is schedulable. Remaining: restic remote repositories.
- ◐ **M6.3** **Machine snapshot** v1: `host.snapshot.create` builds one root-only `machine-snapshot-*.tar.gz`. A fresh verified controller DB backup (also recorded as a normal backup row), every installed app's compose project (settings + secrets; data volumes stay in app backups), app-backup references, netplan/ufw/fstab, and each VM's domain XML, with a per-file sha256 manifest, keep-3 retention, and a Backups-page panel. The Backups table says how many of a snapshot's apps would come back **with their data**, because the archive holds settings and secrets and not the data itself, so "12 apps" otherwise reads as twelve apps protected when it can mean twelve that come back installed and empty. Remaining: optional age encryption; users/cron capture.
- ◐ **M6.4** **Redeploy wizard**: ✅ **finding the snapshot**. `host.snapshot.discover` scans every mounted filesystem for machine snapshots, including ones BoxPilot never wrote, and `describe`/`restore` accept a discovered location. This is the step that made a rebuild possible at all: a reinstalled server has no snapshots of its own and no off-box destination configured, because what described the destination was on the disk that died, so mount the drive or share from the Storage page and the snapshot on it is offered. A path from the browser is never trusted: `resolveDiscovered` re-runs discovery and accepts only a location and artifact this process can find again itself. Verified against the real host: `findmnt --real` lists the CIFS shares and discovery finds exactly the snapshots on the backup drive and nothing else. ⬜ **the rest**. New Ubuntu + BoxPilot → restore → progress view. ◐ as of v1.31.0: the rebuild is discoverable and its review is real. A fresh box with a snapshot-bearing drive mounted opens with "Rebuilding this server?" and the snapshots it found; `host.snapshot.restores` lists what a restore staged (netplan, ufw, fstab, VM definitions, the database copy) with contents inline, guidance per area, and a discard, which replaces the root-only directory nothing displayed. Discovery reads the full mount table rather than `findmnt --real`: BoxPilot's own shares use `x-systemd.automount`, an idle share is only an autofs door, and `--real` hides those, so discovery could not see the drives the product itself mounts. A mounted drive that fails to answer is reported apart from a drive with nothing on it. Proven on a live idle CIFS share end to end in 1.2 s. Still open: applying staged network/firewall config with rollback rather than reviewing it, and the timed sub-30-minute full rebuild, which cannot be rehearsed on a machine whose twelve live apps share the container namespace a rehearsal would trample.
- ✅ (v1) **M6.5** Restore UX: machine-snapshot restore (apps with settings, secrets, and newest data), whole-app restore from any backup with a safety copy, VM recovery as a stopped clone, and now **single-file restore**. *Browse* any app backup (`app.backup.files`), filter, and *Restore this file* (`app.backup.restore-path`: checksum, checkpoint, brief stop, restore only that path). Remaining: in-place VM restore; restoring a single file from a machine snapshot.
- ✅ **M6.6** Backup health on dashboard: a Backups tile (last DB backup, last off-box mirror) and needs-attention entries when either is missing or older than a week.
- ✅ **M6.7** Pre-change checkpoints: `app.update`, `app.reconfigure`, and `app.compose.edit` take an ordinary app backup first (managed backup-flagged volumes only, keep-5), report it as `checkpoint` in the job result, and the card's Restore undoes the change. `checkpoint: false` opts out per job.

### Phase 7. VMs & projects (2 weeks, builds on the existing strength)
- ✅ **M7.1+** All direct VM verbs as registry ops (start/shutdown/reboot/autostart via `vm.action`, snapshot create/revert/delete, force-off, delete) (`vm.force-off` medium, `vm.delete` high with stopped-only guard + optional storage removal, `vm.snapshot.revert` high offline-only, `vm.snapshot.delete` medium), surfaced on the Virtual Machines page through the shared ApproveDialog. Independent restic backups are never touched.
- ✅ (v1) **M7.2** "New project VM" on the Virtual Machines page: Ubuntu 24.04/22.04, Debian 13/12 cloud images downloaded + checksum-verified by the root runner and cached by digest; name/vCPU/RAM/disk, user, SSH keys (paste or import from GitHub), extra packages, autostart → `vm.cloud.create` clones the image, seeds cloud-init (guest agent, passwordless sudo), `virt-install --import`, waits for the DHCP lease, rolls back on failure. Remaining: Fedora, `runcmd`, choose network/bridge.
- **M7.3** Bridged networking option (`br0`) with a guarded netplan change + rollback timer; static leases via libvirt.
- **M7.4** Web console via noVNC/SPICE proxy through BoxPilot (behind auth), stop punting to Cockpit.
- **M7.5** VM templates & clone; "Dev box" template with Docker + code-server inside.
- **M7.6** LXD/Incus or `systemd-nspawn` as a lighter "project container" option.
- **M7.7** GPU/USB passthrough (advanced, high risk).
- ✅ (stats) **M7.8** `vm.stats.inspect` reads `virsh domstats` (state, CPU time, vCPUs, balloon memory, block and network counters); the Virtual Machines page samples it every five seconds and shows live CPU %, memory, disk, and network rates on each running VM. Remaining: autostart ordering.

### Phase 8. Dashboards & observability (1–2 weeks)
- ✅ (v1) **M8.1** **Home dashboard** on the Overview page (`src/HomeDashboard.tsx`): clickable tiles (updates, failed services, apps running, VMs running), a "Needs attention" list (reboot pending, updates, failed units, stopped apps, app updates, failed jobs), installed-apps grid with health pill + URL + update badge, recent activity. Sources load independently; a down source leaves its tile quiet. Remaining: backup staleness, host vitals sparkline. ✅ (v2) **Set up your server** checklist (`server/setup-checklist.mjs`, `GET /api/v1/setup/checklist`): five essentials (tailnet, firewall profile, automatic security updates, alerts, off-box backups) plus optional DNS blocker, shares, UPS, each computed from live evidence with a link to the page that does it. Catalog categories consolidated to 19.
- ✅ (Homepage) **M8.2** `homepage.sync` (low risk, schedulable) writes a **BoxPilot** group into Homepage's `services.yaml` with every installed catalog app. Link on the host the browser uses, description, dashboard icon, live container status via the read-only Docker socket, and keeps operator-written groups; installs and uninstalls refresh it automatically once a host is known. *Sync dashboard* sits on the Homepage card. Remaining: Homarr; per-app widgets (API keys).
- **M8.3** Managed Grafana+Prometheus stack with node-exporter, cAdvisor, libvirt exporter; pre-built dashboards.
- ◐ **M8.4** Failed-job push notifications: `server/notifications.mjs` subscribes to the job-event stream and sends one push per failed job to ntfy, Gotify, or a webhook (both servers are catalog apps, so alerts can stay on-host); Settings panel with password-gated target + test button; deliveries and failures audited. Remaining triggers: updates available, backup stale, disk >90%, SMART, UPS. Host-health alerting stays with the ops CLI per HANDOFF.md. ✅ (v2) **Health alerts** (`server/health-alerts.mjs`): a 15-minute watcher over the sanitized inventory pushes once when a condition appears and once when it clears. Root/mounted disk ≥ 85–90 % full, SMART problems, UPS on battery/low, failed services, reboot required, unhealthy containers; state in the `healthAlertsState` setting so restarts do not re-send.
- ✅ **M8.5** Log viewer: registry ops `logs.sources` (journal groups, every systemd unit, every container) and `logs.read` (tail any of them with a time window and text filter, redacted). The Logs page offers group tabs, a unit finder, a container picker, follow mode, and download; the support bundle reads through the same op. The fixed-four-sources route and `system.logs.inspect` legacy op are deleted.

### Phase 9, Network platform (2 weeks)
- ✅ (v1) **M9.1** Pi-hole/AdGuard as a **DNS platform** role: Pi-hole (`catalog/pi-hole.yaml`) and AdGuard Home are catalog manifests. Pi-hole's manifest uses the new generic `setup` block (`server/catalog/schema.mjs`, applied by `app-helper.applySetup` via `docker compose exec`) to offer popular blocklists (OISD, HaGeZi, Firebog, Smart TV telemetry) with links; the chosen ones are inserted idempotently into gravity after install and on every settings change, then gravity updates. Remaining: set as host resolver, push to DHCP (via router API where available), rollback timer if resolution breaks.
- ◐ **M9.2** Router integration for OpenWrt-based routers: ✅ **reading**. `router.connect` (owner-only; signs in once to prove the password, stores it root-only under `/etc/boxpilot/secrets`, and pins the certificate the router presented), `router.inspect`, `router.leases`, and a panel on the Network page listing every device the router has addressed. GL.iNet firmware 4's salted-crypt challenge; the password goes to `openssl passwd` on stdin so it never reaches argv. Runs as a task because the helper has `PrivateNetwork=true` and cannot reach the router, and may read `/etc/boxpilot` but not write it. ⬜ **writing**. DNS/DHCP options, static leases and port forwarding are deliberately not shipped: a wrong write takes a household off the internet, and the write path cannot be exercised without a real router and its password. To be built once the read path is confirmed against a live device.
- ✅ **M9.3** Local DNS names for every installed app (`*.lan`, `*.home.arpa` or `*.internal`) via the DNS platform: `dns.names.inspect` / `apply` / `clear` and a panel on the Network page. Pi-hole's dnsmasq reads every file in `hostsdir=/etc/pihole/hosts` and reloads when one changes, so BoxPilot writes `boxpilot.list` there and never touches `custom.list`, where Pi-hole's own interface puts hand-written records. The file is rewritten whole, so an uninstalled app loses its name. A name points at the server, so the port is still part of the address unless a reverse proxy is in front. The panel says so rather than implying otherwise.
- ✅ **M9.3a** `dns.blocker.verify`: sends two ordinary lookups to this server's LAN address, the way a device on the network would, and reports answering / resolving / blocking apart rather than as one boolean, because each has a different fix. It also asks two RFC 5737 documentation addresses, which cannot run a resolver: an answer from one proves every DNS query leaving the network is being intercepted, which is the usual reason a recursive resolver fails while a forwarding one looks fine. Found exactly that on a live network, where Pi-hole answered and blocked but could not resolve anything, so pointing the router at it would have taken every device offline. Runs as a task; the helper has `PrivateNetwork=true` and cannot make a DNS query. It also asks whether the thing doing the intercepting blocks ads itself, because a blocker running on the router is an arrangement rather than a fault: nothing is broken, this blocker is simply idle, and DNS on an always-on router survives the server rebooting. Reported as information rather than an alert, with the one real cost named, which is that local app names are served from here and so stop reaching anything. `dns.blocker.clients` answers the separate and more useful question of whether anything is actually using it, by reading the blocker's own query log: a blocker can be installed, healthy, answering and blocking, and used by nobody because the router hands out a different address, and nothing the blocker says about itself tells those apart. This server's own checks are set aside so a blocker is never reported busy on the strength of its own health queries, and an unreadable log reports as not known rather than as unused.
- ◐ **M9.4** Tailscale: ✅ serve per app (`app.serve.set`), ✅ exit-node and subnet-router toggles (`server/tasks/tailscale.mjs`, op `tailscale.set`, `src/TailscalePanel.tsx` on the Network page: enables forwarding via a sysctl drop-in, `tailscale set --advertise-exit-node/--advertise-routes`, shows offered vs approved routes from `tailscale status`/`debug prefs` and links to the admin console). Remaining: join/leave, Funnel per app, ACL hints, Headscale option.
- **M9.5** WireGuard/wg-easy quick VPN as catalog item with QR.
- ✅ (v1) **M9.6** Network page lists the devices this server has talked to (IPv4 neighbour table with MAC, interface, and reachability) and can **Wake** any of them. `network.wake` (low risk) broadcasts Wake-on-LAN magic packets from the root task runner. Remaining: name resolution for devices, an active scan, a dashboard tile.

### Phase 10, Dev/project workflows (ongoing)
- **M10.1** "Deploy from GitHub repo": pick repo (OAuth), detect compose/Dockerfile, build & run, webhook or poll for auto-redeploy on push.
- **M10.2** Environments per project (VM or container), with port/proxy/DNS auto-wired and teardown.
- **M10.3** Cron/timer builder UI; managed scripts folder.
- **M10.4** Terminal in browser (ttyd/xterm.js through BoxPilot auth). Escape hatch for everything not yet a button.
- **M10.5** Plugin/adapter SDK: a catalog entry can ship a small UI panel and custom ops (signed).

### Phase 11, Multi-host (later)
- **M11.1** Register a second Ubuntu box (agent = the same BoxPilot in agent mode over Tailscale); unified dashboard.
- **M11.2** Move/copy an installed app or VM between hosts (the existing Migration Center code becomes useful here).
- **M11.3** Fleet-wide updates and backup policy.

### Phase 12. Quality & project hygiene (continuous)
- ✅ (v1) **M12.1** Install smoke test (`.github/workflows/install-smoke.yml`): every push installs BoxPilot on a throwaway Ubuntu runner with the production installer at that commit, then checks both systemd units, the health version, owner bootstrap, an authenticated operations listing, a canary round trip through the root helper socket, and the setup profiles. Remaining: KVM/Docker-backed scenarios (nested virtualization or a self-hosted runner).
- ✅ (lint) **M12.2** ESLint 10 flat config over `server/` and `scripts/` (recommended rules, unused-vars, no-undef) runs inside `npm run check`; the first pass caught a real regression (a helper lost `parseJsonLines` during the log-viewer cleanup, which would have broken Docker inventory). The UI is type-checked by `tsc -b` in the build. Remaining: Prettier, a pre-commit hook, server typecheck via JSDoc.
- ✅ **M12.3** Release workflow (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag runs `npm run check`, verifies the tag matches `package.json`, and publishes a GitHub Release with generated notes and the update instructions; self-update picks it up.
- ✅ **M12.4** README rewritten (6 KB): what it does, the one-line install, self-update, a per-page capability table, how it works in six bullets, docs index. The 76 KB version-by-version narrative, the mockups, and the docs for removed features (Keel, fleet, migrations, routers, legacy adapters) moved to `docs/legacy/`. Remaining: real UI screenshots.
- ✅ (code) **M12.5** Deleted: the entire Keel machinery (never installed on the host), the legacy Uptime Kuma/Pi-hole adapters and Applications page (superseded by the catalog), Migration Center, Fleet, Router checkpoints, and the DNS-acceptance flows. 108 files. Generic Docker/journal inspection was extracted to `server/host-inspect-helper.mjs`. Controller database backup was ported to registry op `controller.backup.create` with a new `operationRecordHooks` mechanism; the Backups page was rebuilt around it. The sixteen retired-feature state tables (legacy application recovery/protection/retention, migrations, fleet, router checkpoints, DNS acceptance) and their store functions are dropped, including DROP TABLE on upgrade, and the recovery kit reads live catalog evidence instead.
- ✅ **M12.6** Documentation matches the product: Architecture, Backups, Network and the Recovery kit rewritten around what BoxPilot does today; the pre-pivot roadmap, Operations Core, virtualization milestones and Action Center moved to `docs/legacy/`; every internal link resolves; the last "sanitized"/"immutable plan"/"boundary" copy is out of the UI.
- ✅ **M12.7** Review sweeps (0.83–0.88): parallel security, correctness and performance reviews with each finding verified against the code before it was fixed. Roughly 45 defects, among them a typed confirmation that never reached the server (destructive actions were unapprovable), a helper that died when a caller hung up, scheduled parameters stored in cleartext, Docker ports that ignored the firewall, and device globs resolved in a sandbox that cannot see devices. Coverage followed: `server/routes/authorization.test.mjs` drives the assembled app over a socket for role and CSRF boundaries, `server/exec.test.mjs` pins argv-not-shell, and `src/ApproveDialog.test.tsx` fails if the confirmation regresses.
- ✅ **M12.8** CI runs on `phase-0` as well as `main` (it had never run on the working branch; every release to 1.8.0 went out unverified by CI). `catalog-images.yml` checks every pinned tag still resolves, weekly and on catalog changes. Three manifests had silently gone dead. `optionalDevices` for accelerators (a GPU render node) that must never block an install.
- ✅ (1.9) **Sign-in panel** per app (`manifest.signIn`: path, username/usernameEnv, passwordEnv, note; `app.password.set`): the card shows the sign-in page, the username, the password (owner-password reveal) and a change-password form; the install dialog lets you choose the sign-in password instead of only generating it. Twenty manifests carry it. Prompted by Pi-hole, whose env-set password made the in-app change a trap.
- ✅ (1.10) **Network mode per app** (`manifest.networkModes`, `values.networkMode`): apps that offer it (Pi-hole) show a Bridge/Host selector in install & settings. Host mode shares the host stack so the app sees each device's real address (Pi-hole's client list, per-device rules) instead of the bridge gateway; it publishes no ports and drops sidecars. Pi-hole's default upstream moved to Quad9 (host mode has no bundled Unbound) and its web server is pinned to HTTP/80 so host mode never contends for 443. Also fixed a latent bug: the values allow-list rejected `exposure`, so the tailnet toggle would have failed through reconfigure.
- ✅ (1.11) **Performance section** (`server/performance.mjs`, `system.performance.inspect`): live CPU (a real `/proc/stat` delta, not load average), memory/swap from `/proc/meminfo`, hwmon temperatures, per-filesystem disk use, and each app's CPU/memory from `docker stats`. Polled every 3s. Per-app **pause/unpause** added to `app.action` (freeze a container without losing its memory) alongside start/stop/restart, with the controls beside the usage they explain. AI-category apps are pinned to the top, so the heaviest services on the box are always in view.
- ✅ (1.12) **Local AI, installable by anyone**: `ollama` (standalone engine, shared over :11434) and `anythingllm` (documents/websites in, cited answers out) join the AI category, and Open WebUI's picker gains Hermes 3 8B and Qwen 3 8B/14B/30B-A3B. Backups deliberately cover the knowledge (chats, documents, embeddings) and exclude model weights, which are large and re-downloadable. Nothing is hand-configured on any host: a new BoxPilot install offers the whole stack from the catalog. Catalog size in the UI is now derived at build time (`__BOXPILOT_CATALOG_SIZE__`) after the copy sat at "128 apps" through 161.
- ✅ (1.13) **Review of the 1.11–1.12 diff.** Three real defects: a paused container reports `Running=true` to Docker, so the catalog card called it Running, counted it among running apps and offered no Resume (now `isPaused`/`isRunning` shared by card, sort, count and dashboard); colliding pollers could collapse the `/proc/stat` window to zero ticks and report 0% CPU (now repeats the last reading); and managed volumes were only chowned when the *manifest* named a user, so nine apps whose *image* declares one (AnythingLLM, Suwayomi, Wiki.js, Firefly III, Planka, healthchecks, filebrowser, joplin-server, 2fauth) got root-owned folders their non-root process could not write. `imageDeclaredOwner` now reads `Config.User` and resolves a name against the image's own passwd file.
- ✅ (1.14) **Model management** (`manifest.modelRunner`, `app.models.inspect` / `app.model.pull` / `app.model.remove`): a Models panel on any app that runs models. What is downloaded with sizes and a total, download another, remove one. Downloads are their own job with a two-hour budget and streamed progress, because a 19 GB pull inside `app.install` could never finish: progress goes to the job log, not the socket, so the helper client's 25-minute *idle* timeout killed exactly the download that needed patience. The panel says plainly that memory, not disk, is the limit.
- ✅ (1.14.1–1.14.3) **AI stack validated on real hardware.** The smoke harness installed ollama, anythingllm and open-webui on the live server (isolated catalog root, purged after): all three healthy, sidecar created and removed, and AnythingLLM's clean purge confirms the v1.13 image-user ownership fix. Model management then run end to end against a real Ollama. List, pull with progress, the paused and stopped refusals, remove. Two defects that only a real host could show: `ollama pull` repaints with cursor moves rather than carriage returns, so its escape sequences reached the job log; stripping them then removed the boundary between repaints and ran them together. Both fixed in `exec.mjs`, which covers every command that paints. `helper-client.mjs`, the unprivileged↔root boundary, previously untested, now has coverage including id-mismatch rejection.
- ✅ (1.15) **Backup safety net** (`app.backup.protection`, `src/backupProtection.ts`): the Overview now names apps that have never been backed up, and the Backups page lists every app's last backup beside whether anything keeps making them, with one action to give the unscheduled ones a nightly backup, staggered so a dozen containers do not all stop at 3am together. Prompted by the live server: twelve apps holding passwords, photos and documents, no backup schedule, and nothing in the product saying so. It only ever warned about its *own* database and the off-box mirror. Apps whose only data is a cache or re-downloadable models are excluded rather than reported unprotected.
- ✅ (1.16) **Off-box copies** (`src/offBox.ts`): the Overview's off-box warning was gated on a mounted backup *drive*, so a server with a cloud destination it had never synced, or with no destination at all, which is the common case, was told nothing. It now covers all three destinations and the case of having none, takes the freshest copy anywhere rather than letting a neglected second destination drag the verdict down, and the Backups page offers a nightly copy for whatever is configured. Destinations that cannot be read report unknown rather than absent: the existing dashboard test caught the first version claiming "backups are only on this server" when it had simply failed to ask.
- ✅ (1.17.11) **The demo has to answer what the interface asks** (`scripts/demo-fixtures.test.mjs`): four bugs reached the live server through one mechanism. A page whose operation had no fixture got `{}`, and an empty object is the shape that breaks code expecting a field, so the screen looked fine here because it never rendered. Eight operations the UI reads had no fixture (Logs, journal, app logs, secrets, backup listings, restore sources). CI now requires one for every read-only operation a page reads, refuses an empty fixture or one naming an operation that no longer exists, and holds the shapes that have already drifted to the fields the interface relies on.

---


### Reviewing the interface before it reaches a server

The demo is where every page is looked at, and for a long time it served one world: everything
installed, every list populated, every connection healthy. That is the world least likely to break,
and it was the only one anyone saw, so what shipped broken were the other ones. A router form whose
button could not be clicked, a Logs page with no groups, a catalog dialog whose list was absent.

- `?scenario=fresh` and `?scenario=trouble` serve an empty and an unwell server, chosen from a bar
  at the bottom of the demo. The empty world is *derived* from the lived-in one rather than written
  by hand, because a hand-written fixture is a guess about the server's shape and a wrong guess
  teaches every test that reads it the wrong thing.
- `npm run demo:sweep` loads every page in every world and reports uncaught exceptions, console
  errors, 5xx responses, dead navigation and blank pages. Its first run found six blank pages.
- `npm run demo:sweep -- --deep` also opens everything on every page that opens, 438 controls
  across the three worlds. Dialogs are where several of the shipped crashes actually lived, and a
  sweep that only loads pages cannot see them: with a crash planted in the settings dialog, the
  page-level sweep reports nothing and the deep sweep names the button that caused it.
- A page that throws now falls back to an error boundary instead of blanking the window, so the
  navigation survives and there is a way out.
- The `trouble` world covers what actually goes wrong: a share that will not mount, a credential the
  far end refuses, failed units, a DNS container that is stopped, password sign-in left on, Docker
  unreachable, KVM absent. It was two overrides and a healthy server before that, which is why
  sweeping it found nothing. Reading it found the copy bugs no test would: "Copied off this server
  1 days ago", a list rendered "exports, recoveries, retention", and a panel claiming "this list is
  not empty" about a list it had just failed to read.
- `scripts/demo-fixtures.test.mjs` holds the scenarios to the same shape as the default fixtures, so
  a scenario cannot quietly invent a field or drop one. The REST routes are held the same way, by
  starting the demo's own app and asking it. A second copy of what a route is believed to return is
  the thing that drifts.
- The fresh world covers the plain REST routes too, not only the operations. Until it did, the
  Overview showed nine installed apps and four of five essentials done on a server nobody had set
  up, and the checklist contradicted the pages it linked to.

## 7. "Wish we could" / would be nice

- **One URL from bare metal**: flash USB → boot → phone shows a QR → open BoxPilot. (M4.3 gets 90% there.)
- **Undo for everything**: every change is a checkpoint; the Activity drawer has "Undo" on each item for 24h.
- **Dry-run for everything**: show the exact commands/compose diff before any medium/high op. Keeps the *spirit* of today's evidence model without the ceremony.
- **Mobile-first approval**: push notification "Update available for Jellyfin. Approve?" → tap → done (ntfy + Tailscale).
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

- `server/storage-evidence.test.mjs:40-41`: Failing since 08-17 (no `now` injection).
- Version `0.61.0` hard-coded in `index.mjs:173`, `index.mjs:1183`, `helper-server.mjs:164`, helper canary.
- `helper-protocol.mjs` instantiates helper factories as default params → some helpers constructed twice.
- Failure classification via `error.message.includes("Automated rollback completed")` (`jobs.mjs:855-878`), brittle.
- `UBUNTU-SERVER-INSTALL-RUNBOOK.md` publishes a MAC address, DHCP reservation, router model/IP.
- Three stale `codex/*` remote branches.
- Dockerfile/compose are a demo only; README implies a deployment path.
- `/api/v1/capabilities` returns prose slugs as values.
- Zero TODO/FIXME anywhere. Debt is structural duplication, not annotated.

---

## 9. Suggested first two weeks

1. **Day 1–2**: M0.1–M0.5 (green CI, one version, de-hostname, ADR + `AGENTS.md` stating the new goal).
2. **Day 3–7**: M1.1–M1.3. Registry, template unit, risk tiers, `ApproveAction`. Port the existing 5 repairs + lifecycle verbs to prove the shape.
3. **Day 8–10**: M2.1 + M2.4. Updates page and Services page. These are the first features that make it *feel* like a setup tool.
4. **Day 11–14**: M3.1–M3.2. Manifest files + generic compose deployer; Uptime Kuma and Pi-hole with zero app-specific code; add Jellyfin as the proof (<100 lines YAML).

After that, M4.1 (installer) and M4.2 (wizard) make it something you can hand to a fresh box.

## M13 — Flows: automating the machine and what it talks to

**Where this starts from.** BoxPilot is already most of an automation engine and nobody has called it
one. There are 146 registered operations, 100 of them with typed, validated parameters; a job state
machine that stages, approves, applies, verifies and rolls back; a scheduler that already runs any
low or medium operation hourly, daily or weekly under its creator's authority; secret parameters
that never reach the database; and an audit trail. The registry *is* an action library. What is
missing is everything between one action and the next: triggers other than the clock, values passing
from one step to another, a branch, and a way to reach anything outside this machine.

**What this is not.** Power Automate and Okta Workflows are, in the main, hundreds of maintained SaaS
connectors and an enterprise identity model. That is not reachable for this project and not worth
chasing; n8n is already in the catalog and does it better. The thing neither of them can do is
`apt upgrade`, take an LVM snapshot, stop a container, restore a verified backup, or change a
firewall profile — with an approval, an audit entry, and a rollback. Flows should own the machine and
its network, use a generic HTTP step for everything else, and hand SaaS breadth to n8n.

- ✅ **M13.1** (ADR-002, accepted) **The governing decision, before any code** (an ADR). What may run without a human? Risk
  tiers answer that for a single operation and not for a chain: five low-risk steps can compose into
  a high-risk effect, and a trigger someone else can fire is not the same as a button the owner
  pressed. Proposal to argue out: a flow carries the highest risk tier of any step in it; anything
  above `low` needs an approval the first time a given trigger fires it, and a standing consent
  after that which is revocable and visible; `high` never runs unattended at all.
- ✅ **M13.2** (v1.33.0) **A flow is an ordered list of operations.** Shipped: `server/flows.mjs` + a `flows` table (feature storage like `schedules`), routes mirroring `/schedules`, and the Automations page with a two-tier shelf (ready-made flows that stay editable) and a builder over the step palette: every registered low/medium operation whose fields are all optional, 18 today, self-maintaining as the registry grows. Each step runs as an ordinary job through `createOperationJob`/`approveAndStart` under the runner's authority; a failed step stops the chain and what ran stands. Original sketch: Definition in SQLite, executed through the
  existing job machinery so approvals, audit, output and rollback come free. No branching, no data
  passing. Small, because almost none of it is new.
- ✅ (v1.35.0) **The terminal, from wherever the action lives.** One component (`JobLogView`) shows any job's
  step log and terminal output, live while it runs, recorded once it finishes, an honest note once the
  history has pruned it. Wired where a run happens away from a dialog: each Automations run opens per-step
  terminals ("What the last run did", or watched live, with progress persisted step by step so a crash
  mid-run leaves a true record), and every schedule row grew a "View log" for its last run. The Activity
  drawer uses the same component, which also fixed its poll path duplicating lines behind Tailscale Serve.
- ✅ **M13.3** (v1.36.0) **Values between steps.** A step's result is readable by later steps
  (`{{ steps.snapshot.artifact }}`). Needs a tiny expression reader with no `eval` and no reach
  outside the flow's own values, which is the whole security surface of this milestone. Shipped:
  `server/flow-values.mjs` is the entire language: `steps.<name>.<path>` lookups over the named
  earlier steps' recorded job results, nothing else. No prototype chain (own properties only,
  `__proto__`/`constructor`/`prototype` refused by name), a lone placeholder keeps the value's own
  type, a spliced one must be a primitive. Steps gained an optional lowercase name; references may
  only look backwards, checked at save. A field fed by a reference sits out save-time validation
  (treated as optional), and the resolved parameters pass through the registry's full validation
  again when the job is staged, which is the gate that matters. The builder does not write
  references yet; that arrives with the parameter editor.
- ✅ **M13.4** (v1.42.0) **Branching and failure policy.** Shipped as three small pieces on the M13.3
  machinery. A step may carry `onFailure: continue`, and the run records `completed with problems:
  step N failed` instead of stopping; losing sight of a step always stops, whatever the policy,
  because the next step must not start while this one may still be running. A step may carry
  `when: { value: "{{ steps.name.field }}", equals? }`; false skips the step, which holds its
  place in the run as a null job id (the page says "skipped, its condition was not met"), while a
  reference that cannot resolve fails loudly so a typo is never a silent skip. And a flow failure
  that produced no job (a refusal, a step that could not start, a lost-sight stop) sends its own
  notification, since no failed-job push exists to carry the news; failed step jobs stay covered
  by the ordinary failed-job notifications. The builder gained a per-step failure-policy select;
  conditions are API-and-shelf territory until the M13.10 editor.
- ◐ **M13.5** **Triggers beyond the clock.** First admitted trigger shipped (v1.45.0, ADR-002
  addendum): a flow may run after another flow completes. Every element is already inside the
  fence: the fact is recorded by BoxPilot itself, the consent is the follower's creator writing
  the link (visible on the row, revoked by disabling), the follower runs under its own creator's
  authority with the scheduler's refusals, refusals are recorded and notified, cycles are refused
  at save, and depth is bounded. Only completion triggers, not failure. Remaining: signals from
  jobs and thresholds, which start to look like the third-party question below.
- ✅ **M13.6** (v1.50.0) **Inbound webhooks.** The deferred consent question got its ADR-002
  addendum and then its code: a flow's creator mints a token for exactly that flow (delegated
  authority, like an API key), the armed state shows on the row, regenerating or removing revokes.
  The fence that keeps the consent simple: the caller chooses only WHEN, never WHAT — nothing from
  the request reaches any step. The token is shown once, only its SHA-256 is stored, comparison is
  constant-time, a wrong token is indistinguishable from a missing flow, fires are rate-limited
  per flow (6/minute) and audited with their source, and the run goes through the same door as a
  scheduled one, refusals recorded and notified identically. POST /api/v1/hooks/flows/:id/:token,
  mounted before the session wall on purpose.
- ✅ **M13.7** (v1.49.0) **Reaching outward: an HTTP step and a credential store.** `http.request`
  is an ordinary medium operation: one outbound request from this server, run by hand with a
  confirmation or inside a flow under ADR-002's existing consent, its status/body/parsed-JSON
  becoming the step result later steps read. Credentials are saved once under a short name
  (owner-only, a 0600 root-owned file, atomic writes), referenced by name everywhere, resolved
  only inside the root task that performs the request, and listable as names and dates alone; the
  value arrives through the staged-secret machinery and has no path back out. The request itself
  runs as a task because the helper's PrivateNetwork cannot open a connection. A Settings panel
  manages the names. The step needs a url and so a parameter form, which the v1 builder
  deliberately does not have; it is reachable today through the API and becomes a first-class
  builder step with M13.10's editor. The credential panel's copy says "operation", not "step",
  so it does not promise a builder control that is not there yet.
- ◐ **M13.8** **Durability.** (v1.47.0) A step may carry up to three retries for transient
  failures (the shelf's Update night retries apt.upgrade once, for the classic overnight apt
  lock); each attempt is its own recorded job, the run's slot keeps the attempt that counted, and
  the record says "succeeded on attempt 2 of 2". Only a job that ran and failed retries: staging
  refusals are deterministic, a cancellation was a decision, a lost-sight step may still be
  running. And a record stranded by a BoxPilot restart mid-run ("running step 2 of 3" forever) is
  rewritten at startup to say it was interrupted, what to check, and that later steps did not run,
  with a notification. Remaining: resuming an interrupted flow from the step it reached, which
  needs run state persisted per step rather than inferred.
- **M13.9** **Remote targets.** Run a step on another machine over SSH or the tailnet, so one flow can
  drive several boxes. This is where "manage other systems" stops meaning "call their API".
- **M13.10** **The editor.** Deliberately late. Building a canvas before the data model has settled
  is how these projects acquire a UI they cannot change.
- **M13.11** **A flow library.** Shareable definitions the way the app catalog ships manifests:
  "snapshot, update, verify, tell me on ntfy" as one importable thing rather than everyone
  rebuilding it.
- **M13.12** **Model steps.** A step that asks the local model runner — Ollama is already in the
  catalog — to summarise, classify or choose between options, with the answer constrained to a
  schema. Useful for "read this log and tell me whether it matters". A model may never select the
  operation to run or approve anything; it produces a value, and the flow decides.

**Order that actually works.** M13.1 first and genuinely argued, then 2 → 3 → 4 as one arc, because
each is nearly useless alone. 5 and 6 are what turn it from a macro recorder into automation. 7 is
the biggest single jump in reach for the least new machinery. 8 before anyone depends on it. 10 only
once 2–4 have stopped changing shape.
## M14 — Media automation, end to end

The owner's first real automation wish was "click a magnet link on my PC and it downloads on the
server". Getting there surfaced six product bugs and required a guide, an extension, and a CSRF
concession. The finished pipeline works; this arc makes the next person's version of it a stack
install instead of an afternoon.

- ✅ **M14.1** (v1.39.0) The *arr manifests: Sonarr, Radarr, and Prowlarr as catalog entries
  (Jellyseerr is already in). Sonarr and Radarr mount the same media volume as qBittorrent at the
  same container path (/data), so imports are hard-links on one filesystem instead of copies, and
  the manifests say so instead of leaving the layout to be discovered; each one's notes carry the
  three wiring facts (root folder, download client address and category, Prowlarr pushes the
  indexers). Prowlarr holds no media and says that too. Bazarr later if asked for.
- ✅ **M14.2** (v1.41.0) A *Media automation* stack profile: Prowlarr, Sonarr, Radarr, Jellyfin,
  and Jellyseerr in one approved run. qBittorrent is part of the profile but never auto-installed:
  its defaults cannot work (a VPN with nobody's key would crash-loop and fail the install), so the
  step explains itself and points at the app card, done once it is installed. Volumes gained
  `subdirectories`: the manifest promises the folder layout (`torrents/`, `tv/`, `movies/`) and the
  install delivers it inside the data volume, creating only what is missing and never touching or
  re-owning anything the owner already has.
- ✅ **M14.3** (v1.43.0) Connection helper: manifests declare what an app connects to (Sonarr
  names qBittorrent as its download client, Prowlarr names the *arrs it feeds), and every
  installed card grew a Wiring section showing both directions with real addresses: this server's
  LAN address plus the target's actually-chosen port, since each catalog app is its own compose
  project and container names do not resolve across them (the original sketch's "in-project name"
  was wrong). Where the target is missing it says install it first; where an API key is needed it
  says where that key lives. Read-and-show only; writing another app's config stays a separate
  decision.

## M15 — The reachability doctor

"Unable to reach the panel" took six rounds of live diagnosis: an inbound firewall inside a VPN
container, an app validating the port in the Host header, a browser HSTS preload covering all of
ts.net, an exposure mode that had moved the binding. Every one of those checks was mechanical.
BoxPilot should run them, not the owner.

- ✅ **M15.1** (v1.38.0) `app.reachability.inspect`: for one app, walk the path a browser walks and report per
  address, with evidence: container and sidecar state, which addresses the port actually binds,
  whether the host firewall admits it, whether Serve holds it, and which name forms a browser will
  refuse outright (plain http on the ts.net name, self-signed https on it) with the reason named.
  Verdicts per address: works from the LAN, works over Tailscale, cannot work in a browser and why.
- ✅ **M15.2** (v1.38.0) A "Can't reach it?" action on every app card that runs the op and renders the verdicts.
  Shipped with M15.1 and most of M15.3 in one arc: `server/reachability.mjs` plans probes from the
  helper's own records (effective per-port exposure via `bindingFor`, Serve entries, the host's LAN
  and tailnet addresses) and words the verdicts; `server/tasks/reachability.mjs` opens real
  connections from a task (the helper's PrivateNetwork cannot), reporting answered-with-status,
  refused, silently-dropped, and self-signed-certificate apart; the ts.net HSTS preload rule is
  explained rather than probed. The report says probes ran from the server itself.
- ◐ **M15.3** Active probes shipped with M15.1; v1.46.0 added the outside vantage: each LAN
  address is probed twice, once normally (the kernel picks the docker-bridge source that container
  firewalls quietly whitelist) and once with the connection's source bound to the LAN address, the
  way a real device arrives. Agreement stays silent; disagreement is the finding, worded as what
  it is: a firewall inside the app admitting local checks and blocking real devices. This is the
  exact signature the gluetun inbound firewall hid behind for a day. Still remaining: probing from
  a genuinely different machine, which would catch blocks between the owner's device and this box.

## M16 — Managing the network's other boxes: OPNsense first

The GL.iNet integration proved the shape: connect once, read a lot, mutate carefully through the
registry. OPNsense is the natural second router because its REST API is first-party and stable;
pfSense CE needs a community package and follows once the shape is proven.

- **M16.1** `opnsense.connect` (owner-only, key/secret in `secret: true` fields, verified against
  the API before storing) and read-only panels: interfaces, firewall rules, aliases, DHCP leases.
- **M16.2** Careful mutations as medium-risk registry ops with previews: toggle a named rule, add
  or remove a host in an alias. Nothing structural; the firewall's own UI keeps that.
- **M16.3** pfSense via its REST package, with the requirement stated plainly on the connect panel.
- **M16.4** Flow steps for M16.2's ops, so an automation can open a port for the hours a service
  needs it and close it after (pairs with M13.4's failure policy: the close step must run).

## M17 — The tunnel as a first-class citizen

BoxPilot can put an app behind a VPN, but everything it knows about the tunnel afterwards came
from reading container logs by hand. The tunnel is infrastructure; treat it like the backups.

- ✅ **M17.1** (v1.40.0) `app.vpn.inspect`: exit IP, place, and tunnel state, read from the tunnel
  container's own log rather than its control endpoint: the log line is what gluetun itself
  verified, and reading it needs no network and no control-server credentials the helper does not
  have. Shown on the card as "VPN exit: Netherlands · 212.92.x.x". Shipped with it: app.logs (and
  the Logs dialog) can finally read a helper container's log, which the qBittorrent notes had been
  telling the owner to do while the button could only show the app container.
- ◐ **M17.2** (v1.44.0) Seeding port forwarding, the safe half. One manifest toggle turns on
  gluetun's port forwarding (Proton via NAT-PMP), and the card shows the forwarded port next to
  the exit, with where to paste it in qBittorrent. The other half, setting qBittorrent's listening
  port automatically, is deliberately not done: its API needs credentials BoxPilot does not hold,
  and the localhost auth bypass that would sidestep them also opens the panel to the whole tailnet
  through Serve, because Serve proxies every visitor from loopback. If it ever ships, it is a
  config-file edit plus restart, not an auth hole.
- ✅ **M17.3** (v1.48.0) Kill-switch drill: `app.vpn.killswitch.drill` (medium, one confirmation)
  forces the tunnel down through gluetun's control endpoint, probes the internet from inside the
  app's own namespace (an answer is a leak, silence is the kill switch holding), brings the tunnel
  back whatever happened in between, waits for the exit address to return, and records the verdict
  with timings. The mechanics were proven against the live tunnel before the op was written: stop,
  four-second probe timing out, restore, new exit address. "Prove the kill switch" sits next to
  the exit line on the card. A drill that cannot restore the tunnel reports that as its failure,
  never a pass.

**Order across the new arcs.** M15.1 and M15.2 first: the pain is freshest, every check is already
understood, and it pays off on every app forever. Then M14 as one arc, which finishes the mission
the owner actually started; M17.1 and M17.2 ride along since the media stack is where the tunnel
lives. M16 when the owner says the word about a second firewall box; nothing else depends on it.
