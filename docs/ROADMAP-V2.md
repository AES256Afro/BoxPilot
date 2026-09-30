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
- ◐ **M3.10** (v1.51.0 + v1.58.0) The App catalog lists compose projects BoxPilot did not create
  (`compose.projects.inspect` via `docker compose ls`) and now manages their lifecycle:
  `compose.project.action` (start/stop/restart, medium) and `compose.project.logs` run docker
  compose against the stack's own resolved compose files, with the name looked up against
  `compose ls` (never trusted from the caller) and BoxPilot's own bp-*/boxpilot projects refused.
  The "Also on this server" section grew Start/Stop/Restart and Logs. Full adoption into the
  catalog (a manifest reverse-engineered from arbitrary compose, so backups and updates apply)
  remains the harder second half; lifecycle-only is the honest, bounded step.

### Phase 4, Install experience (1–2 weeks)
- ◐ **M4.1** `scripts/boxpilot-install.sh`: one command on a fresh Ubuntu box. Node 24 (sha256-verified), user, config, build via the upgrade script, units, access mode (tailscale/lan/local), health check, first-owner token. Re-run = upgrade. Remaining: verify on a pristine VM, GitHub Release tarballs + signature.
- ✅ (v1) **M4.2** First-run wizard: `GET /api/v1/setup` resolves five profiles (Home server, DNS appliance, Hypervisor, Dev box, Essentials) against live state. Prerequisite installs with the exact candidate version pinned, automatic security updates, catalog installs, the libvirt foundation, and backup/snapshot/refresh schedules. Marking each step done, ready, or blocked. The Set up this server view shows the plan, then runs the remaining steps in order through ordinary jobs (one confirmation for the batch; a password prompt appears only under Always-ask), with retry/skip on failure. The Overview offers it prominently on a fresh box and as a link afterwards.
- ✅ (v1) **M4.3** Ubuntu autoinstall generator: *Set up → Prepare a new server* renders a NoCloud `user-data`/`meta-data` pair (hostname, user with an openssl sha512-crypt password hash computed on the spot and never stored, SSH keys with password login off when a key is given, DHCP or static IPv4, direct or LVM whole-disk layout, time zone, locale) whose first-boot `runcmd` installs the chosen BoxPilot release. Copy or download, then boot the Ubuntu Server ISO with it as NoCloud data. Remaining: a ready-to-flash ISO/USB builder.
- **M4.4** `boxpilot` CLI (`boxpilot install jellyfin`, `boxpilot backup now`, `boxpilot doctor`) sharing the registry, same ops, scriptable.
- ✅ (v1) **M4.5** Self-update from GitHub Releases: `GET /api/v1/system/update` compares the running version with the latest published release (`server/release-updates.mjs`, 15-min cache); the System page shows a **BoxPilot updates** card with *Update to vX.Y.Z*. The high-risk `system.update` op pins the release's commit at staging time; the `system.update` root task re-checks that the tag still points at it, copies the upgrade script out of the tree, and launches it in a detached `boxpilot-update-<stamp>` transient unit, so the job finishes before BoxPilot restarts. The script's own health check rolls back a bad build; the page polls `/health` and reloads when the new version answers; `system.update.status` shows the last update's unit and log. A web-side notifier checks GitHub every six hours and sends one push per newer release to the configured notification target (`server/update-notifier.mjs`). ✅ (v1.63.0) **An update refuses to start while another job is running**, because the restart would cut that job off and leave it half-done: operations that restart or reboot BoxPilot carry a `restartsService` flag (`system.update`, `system.reboot`, `system.web.lan.set`, `system.web.tls.provision`), and the job service blocks their approval while any job is `applying`/`verifying`, naming what to wait for. Remaining: signed releases; unattended auto-apply (deliberately not offered. Updates restart BoxPilot and are high risk); disable the update button in the UI while a job runs, not only refuse at approval.

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
- ◐ **M8.3** (v1.54.0) Managed Prometheus stack: `catalog/prometheus.yaml` ships Prometheus with a
  node-exporter sidecar already wired as a scrape target, so the host's CPU, memory, disk,
  filesystem, and network are recorded out of the box; point Grafana (already a catalog app) at it.
  This landed on two new, general capabilities: manifest **config-file provisioning** (a manifest
  declares `files:` with a container path and inline content, interpolated for non-secret settings
  and `${PORT_<ID>}`, refused if it embeds a secret, written into the project directory and mounted
  read-only) and **read-only host bind mounts for sidecars** (an absolute `hostPath`, always
  read-only, for an exporter that must read the host). Remaining: cAdvisor (needs privileged host
  access, deferred rather than rushed), the libvirt exporter, Grafana now provisions Prometheus as a data source (via host.docker.internal, v1.55.1)
  and ships a compact BoxPilot host dashboard (CPU, memory, disk, swap, load, network, disk I/O)
  bound to it (v1.56.0), verified importing cleanly on a real Grafana. Install Prometheus and
  Grafana and the graphs are drawn. cAdvisor (per-container metrics) ships too (v1.57.0),
  running unprivileged with read-only host mounts and /dev/kmsg, verified live scraping UP on
  the server's cgroup v2. Remaining: the libvirt exporter and a per-container dashboard.
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
  at save, and depth is bounded. Only completion triggers, not failure. Since then (unreleased,
  M26.5): one health condition, a managed drive going dead or read-only, with bounds on how often
  it may fire. Remaining: signals from jobs and other thresholds, which start to look like the
  third-party question below.
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
- ◐ **M13.10** **The editor.** First real slice (v1.52.0): the automation builder configures each
  step, not just names it. The palette broadened from all-optional operations to everything a
  scalar form can build (never high, never read-only, and never a step whose value would be a
  secret, since flow steps are stored as JSON) and carries each operation's field descriptors; the
  builder renders a form per step (text, number, yes/no, enum select), a retry count, and the
  failure policy, coercing types and omitting unset optionals on save while the server validates
  as ever. This makes http.request, retry, and parameterized steps reachable from the interface at
  last, closing the shipped-but-unreachable gap on M13.3/13.4/13.7/13.8. Remaining: a canvas,
  per-step naming and conditions in the form (they need a name picker), and reordering beyond
  up/down.
- ◐ **M13.11** (v1.53.0) **A flow library.** The ready-made shelf is now files, not a hardcoded
  array: `automations/*.yaml`, each validated against the live registry by the same validateFlow
  the API uses, so a library entry can never offer a step a hand-built flow could not (a retired
  op, a high-risk one, a secret-bearing one show up as a load problem instead of a broken shelf
  item). `loadFlowLibrary` mirrors the catalog loader; `/flows` serves the shelf; the page reads
  it. Adding an entry is dropping a YAML file. Remaining: sharing definitions between servers and
  an export of a flow the owner built, which is the same shape pointed outward.
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
  never a pass. ✅ (v1.71.0) **Verify weekly:** a one-click toggle next to the manual button schedules
  the drill (a weekly operation schedule), so "if the VPN drops, nothing leaks" is a continuously
  tested fact — a failed drill fires the failed-job alert, and a schedule that stops fires the
  overdue-schedule alert (M20.1). The card shows the last run and turns the badge amber if it failed
  or fell behind. Downloads pause for the few seconds of each drill and resume on their own.
- ✅ **M17.4** (v1.76.0) **Shared VPN profile.** One VPN connection, entered once in the VPN section
  on the Network page, that any VPN-capable app can be routed through with a single switch instead
  of re-typing the provider and key per app. The connection (provider, WireGuard/OpenVPN keys,
  countries) plus security options (DNS-over-TLS, malware/ad/tracker blocklists, port forwarding,
  which LAN subnets the kill switch still allows, custom DNS) live in a root-owned file
  (`server/vpn-profile.mjs`, 0600, beside the credential store); the web process only ever sees the
  redacted description, mirrored to the `vpnProfile` setting. Written only through the registry
  (`vpn.profile.set`/`clear`/`inspect`), the two secrets riding the ordinary secret-parameter
  machinery. A manifest opts in with `usesVpnProfile: true` and marks its connection env
  `fromVpnProfile`; a per-app "Use my VPN profile" switch (`USE_VPN_PROFILE=on`) makes the app helper
  overlay the profile's connection onto its Gluetun sidecar and layer the security options on at
  deploy. It is strictly additive: an app with the switch off renders exactly as before, so the live
  qBittorrent is untouched until the owner chooses to adopt the profile. Stremio (v1.75.0) ships
  routed through it. Remaining: a shared gateway (one Gluetun for several apps) if the connection
  count ever matters; surfacing on the app card which apps a profile change will next reach.

**Order across the new arcs.** M15.1 and M15.2 first: the pain is freshest, every check is already
understood, and it pays off on every app forever. Then M14 as one arc, which finishes the mission
the owner actually started; M17.1 and M17.2 ride along since the media stack is where the tunnel
lives. M16 when the owner says the word about a second firewall box; nothing else depends on it.

## M18 — Reach BoxPilot the way you actually live on your network

By default the control plane is loopback-only behind Tailscale Serve: away from home it is perfect,
but a laptop on the couch that is not on the tailnet could not reach it at all, and without HTTPS on
the LAN every browser feature that needs a secure context (passkeys first among them) stays dark.
This arc makes local access first-class — reachable and encrypted — without weakening the away path.

- ✅ **M18.1** (v1.59.0) **Bind to the LAN, safely.** An owner-only toggle that also serves the admin UI on the
  network address, not only loopback. The identity trust already handles this correctly — a LAN
  request is neither a tailnet address nor a Serve-fronted loopback hop, so it earns no automatic
  Tailscale identity and falls through to the password — so the work is the plumbing (rewrite the
  bind, deferred self-restart, open the web port in the firewall) and the honesty (a plain warning
  that the password crosses the LAN in the clear until M18.2). Binding `0.0.0.0` keeps the Serve
  path working, so this cannot lock the owner out.
- ◐ **M18.2** (v1.60.0) **HTTPS on the LAN with a local certificate.** ✅ **The core.** A small local
  certificate authority created once on the box (`server/tasks/web-tls.mjs`, op `system.web.tls.provision`,
  EC P-256 via the system `openssl`), reused forever so a device that trusts it stays trusting, and a
  short-lived leaf reissued for the server's names and LAN address (`boxpilot.lan`, `<host>`, `<host>.lan`,
  and the IPv4 as an IP SAN so `https://<lan-ip>:8443` is trusted with no DNS at all). The web process
  opens a second listener that terminates TLS itself (`server/tls-listener.mjs`, port 8443, opt-in and
  never fatal — the HTTP and Serve paths are untouched, so this cannot lock the owner out); the CA
  private key stays root-only, the leaf key is readable only by the `boxpilot` group, the certificates
  are public. The owner installs the CA once per device from a public `/ca.crt` download (never a key),
  with the SHA-256 fingerprint shown to check against and per-OS install steps on the Network page. The
  status is read with Node's built-in `X509Certificate` (`server/tls-status.mjs`), no shell-out on the
  web side. This is the gate for passkeys over the LAN (M19.1) and for anything that wants a secure
  context. **Remaining:** bind 443 directly via `AmbientCapabilities=CAP_NET_BIND_SERVICE` so the port
  is not in the URL; and (done) the reachability panel folds the HTTPS address in (M18.3). ✅ (v1.70.0)
  **Automatic renewal:** a background check reissues the leaf when it comes within 30 days of expiring,
  reusing the CA so trusted devices stay trusted, running the same provisioning with the names already
  on the certificate — and it waits rather than restarting BoxPilot out from under a running job
  (`server/tls-renewal.mjs`).
- ✅ **M18.3** (v1.65.0) **One place that tells you every way in.** A "Ways to reach BoxPilot" panel at
  the top of the Network page lists the addresses the control plane answers on — loopback, the LAN
  (when bound there), the LAN over HTTPS (one per certificate name and address, when TLS is
  provisioned), and the tailnet over Serve — each with its URL, who can use it, whether it is encrypted,
  and whether the certificate needs installing first, plus copy. Assembled server-side from the bind,
  the local certificate, and a real check of whether Tailscale Serve publishes the control plane
  (`identity.servePublishesControlPlane`, i.e. the existing Serve-status detector), so the tailnet URL
  is shown only when it actually works. `GET /api/v1/network/reachability`, pure `buildReachability` in
  `server/routes/host.mjs`, panel in `src/NetworkCenter.tsx`. This is the answer to the "which URL do I
  use" confusion that broke ntfy's notifications. **Remaining:** an active outside-in probe per address
  (the reachability doctor pointed at BoxPilot itself), and the same panel per installed app.
- ✅ **M18.4** (v1.81.0) **The tailnet, visible.** A "Devices on your tailnet" panel on the Network page
  lists every machine signed into the owner's Tailscale network the way the LAN device list does: name,
  tailnet address, OS, online state (offline devices show last seen), direct vs relayed connection, and
  the roles that matter — exit node, subnet router with its routes, and "this server". New devices appear
  as they join with nothing to configure. Pure `parseTailnetPeers` over `tailscale status --json` in
  `server/network.mjs` (read-only, unprivileged, keys and endpoints never pass through),
  `GET /api/v1/network/tailnet`, `src/TailnetPanel.tsx`. **Remaining:** turning rows into pickers
  (grant a share to a device, open its address) once a concrete action needs one.
- ✅ **M6.6** (v1.93.0) **Repair says what is wrong and fixes it.** The page opened with a
  prerequisite inventory, which is the least urgent thing on it, and offered no repairs at all. It
  now opens with the problems found on this server, worst first, each with the operation that fixes
  it staged as a normal job with a preview. Every detector is a failure that actually happened here:
  a mount whose drive came back under a different name (findmnt and df both still look healthy while
  every read fails), a container still bound to the filesystem that was mounted when it started, a
  share nobody can write to, a drive with no permissions of its own mounted without a uid, an app
  that cannot write its own data folder, a VPN kill switch that leaked, and a backup whose rehearsal
  failed. Detection is pure (`server/remediations.mjs`) so each is tested against the situation that
  produced it; the fix for the mount case is the new `storage.remount`. Copy across the page was
  rewritten from architecture language into what the reader would say.

- ✅ **M6.7** (v1.95.0) **A lost drive announces itself.** The failure that started this: a USB
  drive dropped off the bus at 06:46, came back two seconds later under a different kernel name, and
  the mount stayed pointing at the device that no longer existed. It was found hours later by a share
  looking empty. `evaluateHealth` now raises `storage.mount.detached` (high) when a mount's source is
  not among the block devices, so it reaches the phone through the same notification target as
  everything else. The condition needs both halves of the evidence: without the device list, absent
  evidence would read as "every drive has gone". Repair also gained the split-data-folders finding —
  apps each given an owner-chosen folder, but on different drives, so nothing one writes is visible
  to another, which is why a download appeared nowhere and a library stayed empty.

- ✅ **M22.7** (v1.94.0) **The address to type, wherever a share is named.** One shared component
  (`src/ConnectPaths.tsx` over the pure `src/sharePaths.ts`) renders the Windows and macOS/Linux
  forms of a share path with a copy button, and takes a subpath so it can point at a folder inside
  the share rather than only its root — "save your downloads here" is useless without the path to
  type on each machine. Used on the file-server panel and on each storage-map card that is shared.
  macOS and Linux share one row because the URL is identical; printing it twice under two labels
  reads as two different answers.

- ✅ **M22.5** (v1.88.0) **Windows can find the server.** A healthy Samba share is reachable by
  typing `\\host\share` but never appears under Network in Windows File Explorer, because Windows
  browses with WS-Discovery and Samba does not speak it (nmbd's NetBIOS browsing is off by default in
  Windows 10 and 11). One button installs and runs `wsdd` and allows the two discovery ports
  (3702/udp, 5357/tcp); another turns it back off and withdraws the rules. `samba.inspect` reports
  the state, and the panel now lists every share's exact Windows and macOS/Linux path to paste.
  `server/tasks/samba.mjs` (`sambaDiscoverySet`, `discoveryState`), op `samba.discovery.set`.
- ✅ **M22.6** (v1.89.0) **"Why can't my other computer open this?"** One read-only pass over the
  whole file server that says what is actually wrong, because the two ways sharing fails in practice
  are invisible from the client: a share nobody can write to (root-owned folder, no force user) and
  a share nobody can find (no WS-Discovery). Checks the service, the configuration, what it is
  listening on, the firewall, discovery, and per share the folder, who can write, and whether the
  users it allows exist. Missing discovery is reported as a warning, not a fault, because the share
  does work. `sambaDiagnose` in `server/tasks/samba.mjs`, op `samba.diagnose`.

- ✅ **M23.4** (v1.82.0) **Storage map.** One card per place data lives — each mounted drive, each
  connected network share, the system disk — with capacity and a usage bar, the fill forecast, the
  apps that mount folders there, and the network shares serving it out (with their recycle bins).
  Pure correlation in `src/storageMap.ts` over data the Storage page already fetches; no new endpoint.
- ✅ **M15.4** (v1.83.0) **No silent write failures.** The catalog listing checks each installed app's
  read-write data folders against the user the app actually runs as (PUID, `user:`, or the image's
  own) and the card warns — folder, reason — with a one-click "Fix folder access" redeploy that hands
  the folder over. Complements v1.80.2's deploy-time ownership claim by catching apps broken *now*.
- ✅ **M8.6** (v1.98.0) **One-click notification target.** BoxPilot watches thirteen conditions and
  pushes a failed job or a lost drive to the phone, but only if a target is set, and setting one meant
  knowing the address to type. When ntfy or Gotify is installed and running on this server, the
  Notifications panel now offers to point BoxPilot straight at it — one click fills the loopback
  address, leaving only the owner password — and then says, honestly, that to receive on the phone you
  subscribe in the app to the topic at the server's tailnet address, publishing it there first if it
  is only reachable locally. Closes the loop the Repair page's "nothing can reach you" opened.
- ✅ **M8.7** (v1.98.1) **Where each app's data lives, on its card.** An installed app that lets you
  choose a data folder now shows it — "Data: /mnt/the-dump/torrents" — so an app writing to the wrong
  drive is visible at a glance rather than a mystery. This is the class of confusion that took a shell
  session to untangle (a download client on one disk, the media app reading another).
- ✅ **M8.8** (v1.98.2–v1.98.4) **Plain-language sweep.** The Virtual Machines and System pages, the
  retention previews, and the recovery guidance were rewritten out of the vocabulary they were built
  in — "integrity-checked artifact", "encrypted independent restic snapshot", "isolated restore
  drill", "forget but never prune" — into what the reader would say. A full pass confirmed no visible
  page overflows on mobile, no console errors across 30 page/world combinations, no unlabeled
  controls, and no per-app request fan-out; the sweep found the copy, not new faults.

- ✅ **M8.5** (v1.84.0) **Readability + full job output.** Type floor raised (the 7–9px rules moved to
  9–11px; text buttons and panel subtitles to 12px), prose capped at a readable measure, keyboard
  focus outlines extended to inputs/selects/links. And the root task runner now writes every command
  a task executes into the job log (command lines plus stderr on failure; never stdout, which can
  carry secret-derived values), so a job's Output is a complete history rather than a summary line.

## M19 — Identity and access, finished

The whole box is guarded by one password plus optional Tailscale/GitHub identity. This arc makes the
front door as strong as the rest of the product, and does it in a way that works on the LAN.

- ✅ **M19.1** (v1.61.0) **Passkeys (WebAuthn) + recovery codes.** Register a phone or a security key;
  sign in with a touch. Verification is done with `node:crypto` alone (`server/webauthn.mjs`), not a
  vendored library — the one thing that would force a CBOR decoder, reading the credential key out of
  the attestation, is sidestepped by having the browser hand over the key in DER form via the WebAuthn
  Level 2 accessors, so the server only ever parses authenticator-data bytes and checks a signature.
  Attestation is not verified (`attestation: "none"`): proving an authenticator's make and model is not
  something a single-owner box needs. A passkey is bound to the RP ID of the origin it was made at
  (`boxpilot.lan`, the tailnet name, `localhost`) — that is how WebAuthn works — and the UI says so
  rather than pretending one passkey covers every way in; register one per way in you use. Challenges
  are single-use and in memory; the origin is taken from the browser and trusted safely, because every
  check lives in signed material (the challenge, the origin in the client data, the RP ID hash in the
  authenticator data). Sign-in is discoverable/usernameless (empty `allowCredentials`, `residentKey:
  "required"`). Recovery codes: ten ~99-bit codes, shown once, stored only as SHA-256 hashes, each good
  for one sign-in, regenerating replaces the set. Removing a passkey and minting recovery codes re-check
  the password; registering does not (the biometric gesture is the consent). `server/passkeys.mjs`,
  `server/routes/passkeys.mjs`, tables `passkeys` + `recovery_codes`, `src/passkey.ts`,
  `src/PasskeySettings.tsx`, and the sign-in screen. **Needs** M18.2's HTTPS to work on the LAN (an
  insecure origin is refused with that reason); over Tailscale Serve it works today. **Remaining:**
  offer conditional-UI autofill on the sign-in field; a "cloned authenticator" alert surfaced in the UI
  (the counter regression is already audited).
- **M19.2** **A second factor for the password path.** TOTP for owners who keep the password, so the
  weakest door is not one secret.
- ✅ **M19.3** (v1.66.0) **BoxPilot as an OIDC provider.** Apps can offer "Sign in with BoxPilot"
  instead of their own passwords. Standards-compliant authorization-code + PKCE only, so there is no
  client secret to store — a registered client is just a name and its redirect URIs. The one secret is
  the signing keypair (EC P-256, kept in the state directory like the TLS key, generated on first use);
  the public half is at the JWKS endpoint. Tokens are ES256 JWTs signed with `node:crypto` alone
  (`server/jwt.mjs`, JOSE raw signatures via `ieee-p1363`, JWKS from node's JWK export — no library).
  Endpoints live at the site root: `/.well-known/openid-configuration`, `/oidc/jwks`, `/oidc/authorize`
  (session-gated, a server-rendered consent screen), `/oidc/token`, `/oidc/userinfo`
  (`server/oidc.mjs`, `server/routes/oidc.mjs`). The issuer is whatever BoxPilot URL the app reached,
  so nothing is configured. Owner-registers clients under Settings, Single sign-on (`src/OidcSettings.tsx`);
  scopes `openid`/`profile`/`groups` (the role travels as a group so apps can authorize by it). A
  same-site `?next=/oidc/…` bounce carries the owner through sign-in when the strict cookie is not sent
  on the cross-site hop. Security: PKCE S256 enforced, exact redirect-URI match, single-use codes bound
  to client and redirect, consent CSRF, error-redirects only to validated URIs. **Remaining:** a
  forward-auth endpoint for apps with no native OIDC; refresh tokens; per-client scope limits.
- ✅ **M19.4** (v1.62.0) **Session and device management.** A session list on Settings: every live
  session for the account, with the device (parsed from the user agent), the address it signed in from,
  how (password, passkey, Tailscale, GitHub, recovery code), when, and how recently it was active — the
  current one marked, an elevated window shown as "unlocked". Each session carries a stable public id
  (the token hash stays the only secret), so it is revoked by id without the token ever being exposed;
  revoke one, or "sign out everywhere else" in one action; revoking the current session is a plain
  sign-out. Every revoke is owner-scoped and audited. Sign-in records the address/user-agent/method at
  each entry point so the list has something honest to show; the "from where" is best-effort and says
  so. `state.mjs` (id + metadata columns, migrated and backfilled), `server/security.mjs`,
  `src/SessionsSettings.tsx`. ✅ (v1.64.0) **New-sign-in alerts:** the first address on an account is
  baselined silently, then any genuinely new address sends a push through the same notification target
  as failed-job alerts ("New sign-in to BoxPilot: alex from 100.x via passkey"), with the known set
  kept per owner and loopback ignored. **Remaining:** a geo/ASN hint on the address.

## M20 — Backups you can bet the house on

M6 shipped the mechanics: off-box mirror, machine snapshots, restore drills, pre-change checkpoints.
This arc turns them into a policy the owner sets once and a disaster they have already rehearsed.

- ◐ **M20.1** (v1.68.0) **A backup that quietly stopped is loud.** ✅ **The behind detector.** The
  scheduler advances a schedule's next-due time every time it runs it, so a healthy schedule's next
  run is always in the future; if it slips more than a whole cycle into the past, the scheduler skipped
  an entire interval — the box was off for a long time, or the task stopped — and that is now a health
  alert through the same notification target as everything else (`server/schedule-freshness.mjs`, wired
  into `server/health-alerts.mjs`), covering both operation schedules (how BoxPilot's nightly backups
  run) and scheduled flows. The Backups page shows a banner naming any overdue backup schedule, and the
  schedules API carries an `overdue` flag. **Remaining:** the full one-page policy view (what/how
  often/how many/where/last-ran in one place); this slice makes the failure loud, not the policy
  visible.
- **M20.2** **Encrypted cloud destinations, first-class.** B2, S3, and any rclone remote as a
  managed target with its own key, not a hand-edited rclone.conf.
- ◐ **M20.3** (v1.90.0) **Restore rehearsals with a verdict.** ✅ **The rehearsal.** Per app,
  "Rehearse restore" proves a backup would actually restore: it checks the archive against the
  checksum recorded when it was written, unpacks all of it into scratch space to prove it opens and
  holds what it claims (compose file included, parsed), then deletes the scratch copy. The app is
  never stopped and nothing it holds is changed, so it is safe to run against anything. The verdict
  is recorded per app and shown on the card's Backups dialog, so it outlives job pruning.
  `verifyAppBackup` in `server/app-helper.mjs`, op `app.backup.verify`. ✅ **The cadence** (v1.91.0).
  "Rehearse weekly" schedules it, and each verdict folds into a short per-app history (newest first,
  capped) shown as a run of ticks, so an intermittent failure is visible rather than overwritten by
  the next pass. A verdict written before histories existed is adopted rather than discarded.
  `server/backup-verdicts.mjs`.
- **M20.4** **One-button disaster recovery.** From a bare machine and an off-box copy to a running
  server, timed, with the machine-snapshot redeploy (M6.4) as its spine.

## M21 — Observability, the second half

M8.3 shipped metrics (Prometheus, node-exporter, cAdvisor) with a provisioned Grafana host
dashboard. Metrics tell you *that* something is wrong; this arc tells you *what happened* and *warns
you first*.

- ✅ **M21.1** (v1.67.0) **Logs in the same Grafana as the metrics.** Grafana Alloy (`catalog/alloy.yaml`)
  reads every container's log stream through a read-only Docker socket mount and ships it to Loki,
  labelled by container name; Grafana auto-provisions a Loki data source (`catalog/grafana.yaml`)
  alongside the Prometheus one, so metrics and logs live in one place. Uses the config-file provisioning
  and read-only-host-mount capabilities already built. Verified end to end on the real box: a throwaway
  logger's lines were shipped, stored, and queried back with the right container label (the key finding
  was that Alloy must be its own compose project — sharing Loki's project makes the host-gateway hop a
  hairpin that fails; separate projects reach Loki's published port fine, the same pattern Grafana uses
  for Prometheus). A ready-made **BoxPilot Logs** dashboard is auto-provisioned into Grafana too (a
  per-container log-volume bar chart, a live logs panel, and Container + Search variables), verified by
  deploying Grafana on the box and reading it back from Grafana's API. **Remaining:** ship the systemd
  journal too (the Logs page already shows it).
- ◐ **M21.2** (v1.69.0) **Alerting rules that reach your phone.** BoxPilot's own alert loop already
  routes disk/SMART/UPS/failed-services/reboot/unhealthy-container to ntfy/Gotify, deduplicated and
  clear-when-resolved, without a separate Alertmanager to run. Strengthened it where the real gaps
  were: a **crash-looping container** (state "restarting"/"dead", worse than merely unhealthy and
  unambiguous — a stopped container is "exited", so an intentional stop does not trip it), and the
  **overdue-schedule** detector from M20.1. **Remaining:** custom metric thresholds from Prometheus
  (sustained CPU/memory, a scrape target down), for owners who want more than the built-in conditions.
- **M21.3** **A public-facing status page.** An at-a-glance "is everything up" the owner can glance
  at, or share read-only, built from the uptime data already collected.
- **M21.4** **The libvirt exporter**, so VM metrics join the host and container ones for owners who
  run virtual machines.

## M22 — App lifecycle: adopt, update, and trust

The catalog installs and manages BoxPilot's own apps well, and now lists and lifecycle-manages
foreign stacks (M3.10). This arc closes the gap between "a stack that is here" and "a stack BoxPilot
fully looks after."

- **M22.1** **Adopt a foreign stack for real.** Read an existing compose project into a managed
  shape so backups, updates, and config editing apply to it, not just start/stop — the hard half of
  M3.10, done conservatively (the owner reviews the derived manifest before it takes over).
- ◐ **M22.2** (v1.99.0) **Update history and going back.** ✅ **The way back.** Every update records
  what each service moved from, read out of the deployed compose file (the only exact record: the
  manifest has already moved on, and stored state carries the app's own image but never its
  sidecars'). "Go back to <version>" redeploys the app *and any sidecar that moved with it* — an app
  restored onto an upgraded database cannot read its own data. The version comes from the app's own
  recorded history rather than the request, so the operation can only ever restore what that app was
  already running, and catalog references are version tags (never `latest`), so the old image is
  re-pullable after a prune has removed it locally. `rollbackApp` in `server/app-helper.mjs`,
  `deployedImages` in `server/catalog/compose.mjs`, op `app.rollback`. ✅ **Stepping back further**
  (v1.101.0): every recorded version is offered, not only the most recent. `at` names one of the
  app's own recorded updates, so a jump of several releases is still only ever a version it actually
  ran; entries newer than the one undone are dropped rather than left ahead of the current state.
  **Remaining:** channels (stable vs latest).
  of image versions installed, and a one-click return to any previous one, on top of the checkpoint
  machinery already there.
- **M22.3** **App bundles.** A named set of apps installed and wired together in one approved run —
  the media stack (M14.2) generalized, so "a Nextcloud office", "an *arr stack", "a monitoring
  stack" are each one choice.
- **M22.4** **A signed community manifest source.** A second catalog the owner can opt into, with
  provenance shown, so the app list can grow without a BoxPilot release — bounded by signature and a
  clear "not curated by BoxPilot" mark.

## M23 — Storage and data, understood

BoxPilot sees disks and mounts; it does not yet help the owner reason about capacity, health over
time, or the filesystem features a home server leans on.

- ◐ **M23.1** (v1.72.0) **Capacity planning.** ✅ **The projection.** A daily sampler keeps a small
  free-space history per mount, and a least-squares fit over it says when each filesystem runs out at
  the recent rate — before it does. The Storage page shows a "Filling up" panel (mounts on track to
  fill within three months, amber inside two weeks), and a filesystem projected to fill soon becomes a
  health alert to the phone, earlier than the 90% threshold that arrives with little runway.
  `server/disk-forecast.mjs` (pure fit + sampler), `GET /storage/forecast`, wired into `health-alerts`.
  ✅ **The attribution** (v1.105.0). Knowing a drive fills in nine days is a problem; knowing the
  downloads folder grew 246 GB this week is a decision. A nightly sampler measures each installed
  app's data folders (`du -sbx`, per-folder timeout, one at a time — a reading that misses a folder
  is fine, one that saturates the disk is not) and the "Filling up" panel names the apps growing on
  each drive, biggest grower first. The paths are derived from the manifests and the owner's stored
  values inside the helper, never taken from the request. A folder that could not be measured is
  recorded as unmeasured rather than zero, so a slow library never draws a collapse that did not
  happen. `server/app-data-growth.mjs` (pure + sampler), `apps.dataUsage()` in the helper,
  `app.data.usage` operation, carried on `GET /storage/forecast`.
- ◐ **M23.2** (v1.86.0) **Filesystem snapshots as a first-class thing.** Where btrfs filesystems or
  ZFS datasets exist, a Storage panel lists their snapshots and offers take (read-only btrfs snapshot
  under a managed `.boxpilot-snapshots` folder; `zfs snapshot`) and delete (typed confirmation).
  Every mutation re-derives its target from the live system (`findmnt`, `zfs list`), so a request can
  never name a path or dataset it invented, and a bare ZFS dataset can never be destroyed — the
  `@name` is always appended (`server/tasks/fs-snapshots.mjs`). The panel hides itself on servers
  with neither filesystem, which is the common case and this server's. **Remaining:** rollback /
  browse-and-restore, deliberately absent until it can be verified against a real btrfs/ZFS
  filesystem — rollback discards data newer than the snapshot and will not ship untested. Same
  release: tailnet devices offered as a dropdown in the SSH-backup and network-mount host fields
  (M18.4 follow-up, `src/tailnetHosts.ts`).
- ◐ **M23.3** (v1.73.0) **SMART trends, not just a green light.** ✅ **The alert.** A daily sampler
  keeps a small per-disk history of the numbers that move before a drive dies, and a least-squares fit
  turns them into warnings while smartctl still says "healthy": a media-error count that is climbing,
  or an SSD's write-endurance projected to reach its limit within six months (or already past 90%).
  Both go to the phone through the same notification target, so a slowly-failing drive is a slope, not
  a surprise at the end. `server/smart-trends.mjs` (pure trend + sampler), wired into `health-alerts`.
  **Remaining:** a per-disk trend chart in the UI (the Overview already shows the point-in-time numbers;
  Scrutiny in the catalog draws the full graphs).
- **M23.4** **Guided array and mount setup.** Bringing a new disk from bare to mounted-and-backed-up
  in a few clicks, with the deny-list and safety rails already in the deployer.

## M24 — Automation intelligence

M13 gave flows a solid, consent-respecting engine. This arc makes the product suggest and reason,
not just execute.

- ◐ **M24.1** (v1.107.0) **Suggested automations.** ✅ **The argument.** The shelf listed all three
  built-in flows equally, which reads as a catalogue: no reason to pick one, so nobody picks any. A
  suggestion is the same shelf item with the evidence attached — "12 backups are on this box and the
  off-box destination has never been used" — which is what turns a list into a decision. Suggested
  items sort first and carry the reason above the description. Nothing is ever created: a suggestion
  is an argument for pressing a button that was already there. Every one cites a fact read from this
  server, and one whose evidence goes away stops being made; a flow already on the shelf is never
  suggested again, matched on what its steps do rather than its name, so renaming a copy does not
  restart the recommendation. `server/flow-suggestions.mjs` (pure), `GET /flows/suggestions`.
  **Remaining:** suggestions from what has *gone wrong* (a job that keeps failing, an app that keeps
  restarting) rather than only from standing facts, and app-pairing recipes ("you have qBittorrent
  and Sonarr") once the library has flows that span two apps. **Not started, deliberately (2026-09-02):**
  the facts are cheap (failed jobs from the job table, restart counts from `app.inspect`), but the
  library holds three flows - mirror the backups, tidy Docker, update night - and none of them is
  what you do about a restarting container or a failing backup. A suggestion with nothing to press
  is a complaint. The order is: write the remediation flows first (restart-and-watch, re-run the
  last failed backup, roll an app back), then suggest them from the evidence.
- **M24.2** **Anomaly notices from the metrics.** A quiet watch over the time series that says "this
  is unusual for your box" — a memory climb, a nightly job that got slower — grounded in the data,
  not a model's guess.
- **M24.3** **Guided troubleshooting.** When something is wrong, a walk from symptom to cause using
  the checks the product already has (the reachability doctor, the kill-switch drill, the health
  reads), so the answer is a sequence of real evidence, not advice.

## M25 — On your phone

BoxPilot is a desktop web app that happens to work on a phone. This arc makes the phone a
first-class place to approve, glance, and act.

- ✅ **M25.1** (unreleased) **A proper PWA.** Installable, offline-aware for reads, laid out for a thumb — the
  dashboard and approvals designed for the small screen, not shrunk to it. A manifest (`start_url`
  `/?launch=pwa`, standalone, the console's colours) and icons drawn by `scripts/make-app-icons.mjs`
  (the rail's BP mark; a maskable one and Apple's 180 px), with `apple-touch-icon`, the
  `apple-mobile-web-app-*` tags and `viewport-fit=cover`, so the page keeps clear of the notch and
  the home indicator (`env(safe-area-inset-*)` on the bar, the rail, the dock and every sheet). A
  service worker (`/sw.js`, scope `/`, only over HTTPS and never in the demo) keeps the app itself -
  the shell, the entry bundle, the fonts, the icons, and each hashed chunk once used - and never an
  API answer: it does not even look at `/api/`, `/oidc/`, `/.well-known/` or `/ca.crt`, refuses to
  keep JSON, an event stream, `no-store` or `private`, and the build refuses a precache list naming
  any of them. Its rules are in `src/pwa/swRules.js`, and the tests run the worker exactly as built
  against a stand-in network. The one exception is the "last known state": Today's summary, saved by
  the page for the account that saw it, kept a day, and cleared on sign-out or whenever BoxPilot says
  the session is gone (`src/pwa/lastKnown.ts`). The installed app opened with no network opens as the
  account this device remembers (its id, name and role; never a token) to read it, marked Not live
  with no buttons. A banner under the bar says when the phone is offline or BoxPilot is not answering
  (checked against `/api/v1/health`: a phone off the tailnet is online, but cannot reach it), when it
  last answered, and that approvals and actions wait. The CSP already allowed all of it; `worker-src`
  and `manifest-src 'self'` now say so, and `/sw.js` and the manifest are sent `no-cache`.
  **Phone polish across the shell:** on a touch screen the bar's controls, the dock, sheet and dialog
  close buttons, the kit's buttons and fields are at least 44 px (fields at 16 px, so iOS does not
  zoom), a bottom sheet shows a grip, the approval dialog's buttons clear the home indicator, the
  theme switch leaves the phone's bar (Settings keeps it), and the bar has a Refresh - the
  pull-to-refresh the installed app otherwise lacks: Home, Ops and Today read their facts again in
  place, any other page loads again. The phone screenshots emulate touch, so they show all of this.
- ✅ **M25.2** (unreleased) **Push approvals.** "Update available for Jellyfin — approve?" as a push you tap, tied to
  the passkey (M19.1), so approving a medium action from bed is a touch, not a login. **Channel
  (September 2026):** Web Push, with ntfy as the fallback. iOS and iPadOS have delivered Web Push to
  Home Screen web apps since 16.4, and since 18.4 in the declarative form, which Safari shows with no
  service worker woken at all; Chrome, Firefox and Edge take the same standard. It needs no app, no
  account and no ntfy, only HTTPS with a real certificate (the tailnet's `*.ts.net`) and the server
  reaching `*.push.apple.com` (or Google's or Mozilla's service) outbound. So: `server/web-push.mjs`
  does VAPID (RFC 8292) and aes128gcm (RFC 8291) with node:crypto alone - checked against the RFC's
  own worked example - and the push service carries only ciphertext; the VAPID key is a 0600 file
  beside the OIDC key, never in the database. `server/push-approvals.mjs` pushes a job that has
  waited two minutes for a person (so approving in the dialog that staged it never pushes) to the
  devices of whoever may approve it - the owner always; an operator for the medium and low jobs they
  staged - and to the notification target (ntfy, with a `Click` to the approval) when no device of
  the owner's took it, or always, or never. **A push approves nothing:** it carries the operation's
  title (with the app's name from the catalog), one sentence per tier, and `/?approve=<job id>`;
  tapping it opens BoxPilot, which reads the job again as the signed-in account and opens the
  ordinary dialog at its tier - the confirmation, or the password and typed text, exactly as
  before. The service worker opens only this app at an approval or at Today, whatever a push names.
  Quiet: once per job; several at once as "3 approvals waiting"; identical jobs as one; nothing in
  the owner's quiet hours (what still waits is said once after); two minutes between pushes and ten
  an hour at most; nothing staged over a day ago. The owner chooses the tiers (medium and high by
  default), the quiet hours and ntfy's part in the notification centre, where each account also
  turns pushes on per device, sees its devices and sends a test; signing out on a device turns its
  pushes off. Each push is in the notification centre's record. The tests decrypt what each push
  carried and find no parameter, password, path or error in it, or in ntfy's request. The catalog's
  ntfy gains `NTFY_UPSTREAM_BASE_URL` for the iPhone app's instant delivery. **Not done:** approving
  with a passkey instead of the password (the tier's step-up is unchanged; M19.1's passkey signs in,
  it does not yet elevate), and action buttons on the push itself, which would approve from outside
  the app.
- ✅ **M25.3** (unreleased) **A today view.** What ran overnight, what needs attention, what is off-box and current —
  the morning glance, on the lock screen. `?view=today`, first in the dock and on the rail, and the
  installed app's start page on a phone (anything wider starts on Home). Top to bottom: the jobs
  waiting for approval, each with Review opening the ordinary dialog at its own tier; what else needs
  a look, worst first (what can wait stays on Home); the agents' morning digest and cards; what ran
  since 18:00 yesterday (since 06:00 after the evening turns), as backups, updates and other jobs,
  failures first, each opening in Activity; and the backups at a glance - off this server, apps
  backed up, BoxPilot's database - drawn by the same `backupGlance` as Home's panel. It reads nothing
  new: the facts Home and Ops read, `buildNeeds`, and the job history Ops' matrix reads
  (`src/home/jobHistory.ts`, now shared). The dock's Today carries the count of approvals waiting,
  from Activity's live feed, so an approval is one tap from any page.


---

## Next milestones (written 2026-09-05, after the second the-dump incident and four review sweeps)

Each of these came out of something that actually happened or was actually measured this week,
not from a wish list. They are ordered by what the owner would notice first.

### M26 — Drive resilience: a drive that drops must never be a mystery again

Twice in five days the USB drive dropped for eight seconds, came back under another name, and the
old mount stayed - the second time exFAT turned it read-only and another computer saw I/O errors.
BoxPilot now detects the dead mount, the read-only remount, and the missing exFAT checker (v1.111.0),
but detection is the floor.

- ✅ **M26.1 Reconnect in one fix** (v1.113.0). Today the owner clicks "Reconnect the drive" and then restarts
  each bound container from separate findings. One remediation should remount and restart every
  container bound to it, in order, with the verification (a real read of the mount) in between.
- ✅ **M26.2 Check before writing** (v1.114.0): `storage.check` pauses the containers on the drive, unmounts, runs the filesystem's own read-only checker, remounts and restarts them; Repair offers it for any USB drive that has dropped since its last clean check. After a reconnect of an exFAT/ext4 drive that hit errors, offer
  `fsck -n` (read-only) as a job, show its verdict on the drive card, and only then offer the
  repairing run. Requires exfatprogs, which M26.3 installs.
- ✅ **M26.3 Setup checklist item: "This server can check its drives."** (unreleased): an essential
  item on the Overview checklist, not done while smartctl or fsck.exfat is missing and linked to
  Repair, where `prerequisite.drive-tools.install` (medium) installs whichever of smartmontools and
  exfatprogs is missing at the exact versions in its preview - through the existing fixed
  smartmontools installer, now given a fixed two-package set and `--no-remove` - then fails unless
  both tools answer and a fresh SMART scan lands. The storage scan asks a USB disk that did not
  answer once more with `-d sat` (a read; SMART is never switched on) and records how each disk
  answered. The item is done once every USB drive BoxPilot mounts answers, directly or through its
  bridge; an enclosure that passes no SMART through is named as the enclosure's limit, on the item
  and on the Overview's disk card, and no longer holds the SMART reading at "needs a look". Repair's
  drive-check offer for an exFAT drive becomes the install while fsck.exfat is missing, and
  `storage.check` refuses before unmounting anything without its checker. `server/drive-checks.mjs`.
- ✅ **M26.4 Say why it dropped** (v1.113.0; the real log showed four drops in thirty days, not two). Correlate the kernel's USB disconnect with what BoxPilot knows:
  same port, same vendor:product, how many times in 30 days, whether a power fault was logged. A
  drive that has dropped twice earns a standing Repair notice naming the cable, port or enclosure
  as the thing to change. The evidence is already in the journal; nothing reads it.
- ✅ **M26.5 Auto-reconnect, opt-in** (unreleased): arming a drive - "Reconnect automatically" on
  its row under Storage, or "Reconnect it automatically next time" on the Repair notice that says it
  dropped - creates a flow of one step, `storage.remount` for that drive (M26.1's reconnect, which
  restarts every container bound to it and proves the mount with a real read), started by a new
  trigger: the health round finding /mnt/<name> dead or read-only (ADR-002 addendum). Armed per
  drive, not globally: the step is written when the drive is armed and nothing from the finding
  reaches it, and restarting the apps on a drive is a decision about that drive. It is off until
  someone arms it, runs as an ordinary job under the armer's stored authority with a scheduled run's
  refusals (always-ask approvals, a creator who lost the role), and shows on Automations, where
  pausing or removing it revokes it. Guardrails, in `server/auto-reconnect.mjs`: 30 minutes between
  automatic reconnects of one drive and at most 3 in 24 hours; after one that failed, or that a
  restart cut off, none until the drive has been reconnected by hand; never while that drive is
  being checked, reconnected or unmounted; never after its last check found errors. A reconnect is
  told through the ledger as news ("Reconnected /mnt/media and restarted 3 apps", which stands in
  for the drop's "resolved"); a failure, the cap, a check with errors or a consent refusal as the
  automation's own condition, once, cleared by the next reconnect that works, automatic or by hand.
  One sentence beside each control states the limits.
- ✅ **M26.6 Drives unmount cleanly, and a drive that was not is checked** (unreleased): after a
  reboot through BoxPilot the kernel said /mnt/the-dump "was not properly unmounted". Measured on
  real systemd, the kernel's exFAT driver and Docker by `tests/ubuntu/drive-shutdown-order.sh` (a CI
  job), and by real reboots of an Ubuntu VM with an app writing to an exFAT drive,
  `tests/ubuntu/drive-reboot-vm.sh` (in the install smoke workflow):
  - *The warning.* Linux keeps exFAT's VolumeDirty mark once it has mounted a volume with it set, as
    the exFAT specification asks, and `fsck.exfat -n` calls such a volume clean; only a repairing run
    clears it. So a drive that dropped mid-write in September warns at every mount however cleanly it
    has been unmounted since. The VM's reboots left the drive clean every time, with the fstab line
    before and after this change and Docker's live-restore off and on.
  - *Boot and shutdown order.* `nofail` takes a drive out of local-fs.target's ordering, the only thing
    that put it before docker.service: with a drive 6 s late, Docker started at once and the app saw
    the empty folder underneath, where anything it saves lands on the system disk. Drive entries now
    carry `x-systemd.before=docker.service,x-systemd.device-timeout=30s`: Docker waits for the drive,
    at most 30 s when it is missing (10 s risks a cold large USB disk missing the window and then not
    being mounted at all). `x-systemd.required-by=` was rejected: with the drive missing, Docker and
    every app fail to start. Existing entries get it from `storage.docker-order.apply` (medium),
    offered on Repair for a drive an app uses: fstab copied first, the new file checked with
    `findmnt --verify --tab-file` (no worse than the current one) before an atomic rename, the
    ordering read back from systemd after the daemon-reload, the old file put back otherwise; shares,
    swap and hand-made entries are not touched. At shutdown the ordering makes Docker stop first but
    changed nothing measurable: a container's bind is its own copy of the mount, so the drive is only
    released when the container exits, and with live-restore on (`docker.logging.set` turns it on)
    Docker leaves its containers running until systemd's final kill.
  - *BoxPilot's reboot* gets the drives ready first: stops Docker (not `docker stop`, which marks an
    `unless-stopped` app as stopped by hand, so it would stay down after the reboot), sends containers
    that live-restore kept running their own stop signal and timeout, syncs, unmounts each drive, and
    says in the job log which let go, which did not and what held on (from /proc: fuser is not
    installed everywhere), and whether an exFAT drive still carries the mark. Bounded at 2.5 minutes;
    it never keeps the server from rebooting, and puts everything back if the reboot cannot be
    scheduled.
  - *File sharing.* A drive shared to a Windows PC is held by smbd, and Windows reconnects within a
    second of `smbcontrol close-share`. The check and the reboot close the drive's shares and unmount
    straight after, up to 30 times, and say whom they disconnected.
  - *Mounts from the runner.* boxpilot-run@ has PrivateTmp=, which gave its mount and umount a
    namespace of their own: storage.mount's mount went away with the runner, and Reconnect and Check
    never touched the host's mount while reporting success. They now run with `-N /proc/1/ns/mnt`.
    (Share mounts in `server/tasks/shares.mjs` still do not.)
  - *Finding an unclean unmount.* `storage.volumes.state` (operator) reads each drive's exFAT mark and
    ext superblock state and when its current mount began; `storage.unclean.events` (operator) reads
    this boot's kernel warnings. Repair offers `storage.check` when the filesystem says so or a warning
    was printed at the current mount, until a clean check after it; a warning from a mount since
    undone (a check, a repair by hand) no longer counts. A clean check that found the mark still set
    offers `storage.dirty-mark.clear` (medium): the read-only pass again, then `fsck.exfat -y` only if
    that is still clean, so the mark is all it changes. The Storage page has "Check this drive" on
    each drive BoxPilot mounted.

### M27 — Silent-failure audit: nothing BoxPilot knows may be shown to nobody

Both incidents were known to BoxPilot and announced to no one. Three separate causes were found
this week (a tree the parser did not walk, alerts hidden without a notification target, job logs
the web service could not read). There will be more.

- ✅ **M27.1 Every recorded verdict has a reader** (v1.114.0): `server/settings-audit.test.mjs` walks the source and fails when a setting is written and never read. Audit every `setSetting` and record hook: for each
  key, name the page that reads it. The kill-switch drill verdict was recorded for a month and read
  by nothing (v1.92.0); `healthAlertsState` was read by one route that filtered out the unannounced
  half (v1.111.0). Turn the audit into a test that fails when a new key has no consumer.
- ✅ **M27.2 "Not announced" is a state the owner can see** (unreleased): a scheduled task that failed
  (or could not start, was skipped under always-ask approvals, was paused for a stored password, or
  was cut off by a restart), an automation that stopped, finished with problems or did not run, and a
  job whose record hook could not save its result are now conditions in `healthAlertsState` beside
  the health alerts. Each is announced once per schedule, flow or operation through the notification
  target, kept as not announced when there is no target or the send fails, sent by the next
  15-minute round once a target answers, and cleared by the next success (one "resolved" push if it
  had been announced; deleting the schedule or flow clears it quietly). The jobs those conditions
  cover no longer push once per failure, so a schedule failing every hour is one push. A host alert
  whose send failed is now kept as not announced too, instead of being dropped until the next round.
  The Overview shows one "BoxPilot could not tell you about N things" line, quiet at zero, that opens
  to the list and links to Settings. Since then (unreleased): release notices, new-sign-in alerts,
  the weekly report and a job a restart cut off that no schedule or automation started go through the
  same ledger as notices - pushed at once, or kept as one not-announced entry per release, account
  and address, or operation and subject; counted on the Overview but not under "Needs attention";
  sent by the next round once a target answers and then dropped; at most 20 kept, none past 30 days.
  A job run by hand is not kept when its push reaches no one: the person who ran it watched it fail,
  and Activity and the Overview keep it; the unattended case, the interrupted job, is kept. The
  Schedules panel shows how the last run ended (ran, failed, or did not run, with the reason) rather
  than that a job started, and a scheduled run whose record hook fails is one condition, the record
  one, which quietly replaces the schedule's own earlier failure. Still open: a "resolved" push that
  fails is dropped rather than retried. An automation whose step's record hook fails still raises
  both, on purpose: the automation also stopped, and its later steps did not run.
- **M27.3 Run the detectors against captured reality.** Keep a fixture directory of real
  `findmnt -J`, `lsblk -J`, fstab, `docker inspect` output from the real server (scrubbed), and run
  every Repair detector and health rule over it in CI. The findmnt tree bug would have failed on
  the first such fixture.
- ✅ **M27.4 The helper's own health** (v1.113.0). A canary that writes a job log as the helper and reads it as
  the web service, run at startup; the umask bug would have been caught the day it shipped.

### M28 — Copy and naming: one voice, one name per thing

The readability sweep produced a table of things called two names on two pages and fourteen
Repair notices written in the refusal voice CLAUDE.md forbids. About forty strings were fixed in
v1.112.0; the structural half remains.

- ✅ **M28.1 The action-center notices** (v1.113.0; rewritten in place, the table move is still open). Move the 14 inline notice literals into the guidance table
  the same file already has, then rewrite them: "Could not read the drives" rather than "Storage
  evidence is unavailable ... BoxPilot will not claim storage readiness without the fixed mount
  and device collectors." Strip evidence / collector / bounded / sanitized / fixed / separately
  reviewed / the "performs no deletion" tails.
- ◐ **M28.2 One name per thing** (v1.114.0): off-box/independent → second copy, disk/block device → drive, controller backup → database backup, Recent jobs → Activity, the box/the host → this server in owner copy; the Overview's second "Housekeeping" is now "Updates and reboots". Left by design: "the host" where it means the host of a VM, and code comments. Adopt the table: *second copy* (not off-box / independent /
  mirror as the owner word); *drive* for the thing you plug in, *disk* only for a VM's virtual
  disk, never "block device" or "filesystem" as a heading; *machine snapshot* for the redeploy
  archive and *database backup* for the database's; rename the Overview's "Housekeeping" panel
  (it collides with disk-space housekeeping); delete "Action Center" and "controller" from copy;
  *Activity* everywhere ("Recent jobs" goes).
- **M28.3 Boundary slugs out of API responses.** `boundary: {...}` and `mode:
  "read-only-local-action-guidance"` ride on a dozen responses and are rendered by nothing; one
  (`prerequisites.mjs` reading `mutationPerformed`) is load-bearing and needs a named field.
- **M28.4 Extract the long JSX.** HostOverview has a 1,147-character line; the ext4 label is a
  four-way ternary. `mountErrorLabel()` / `smartHeadline()` helpers give the strings one home and
  make M28.1-style edits copy edits rather than code edits.

### M29 — Secrets hygiene, finished

The registry masks top-level secret fields; an app's token nested in `values.env` was stored in
clear until v1.112.0. The lesson generalises.

- ✅ **M29.1 Secrets are a shape, not a flag** (unreleased): the spec declares where a secret sits (`secret: true`, or `secretEnvOf` for an app's `values.env`) and one registry `secretPaths` serves jobs, the scheduler and flows; `server/secrets-at-rest.test.mjs` walks every secret-bearing operation through every store (the audit log records no parameter values). A single `secretPaths(operation, parameters)` used by
  jobs, scheduler, flows and the audit log, so a new nesting cannot be missed three times.
- **M29.2 Staged secrets expire.** Thirty minutes unapproved and the staged copy is dropped, with
  the dialog saying so; today they live until the daily prune.
- ✅ **M29.3 Transient operation secrets stay out of controller backups** (unreleased): `server/secrets-at-rest.test.mjs` stages every secret-bearing operation in one database, one job run and one left awaiting approval with its secrets in memory, attempts a schedule and a flow with them, and has the controller-backup helper write its copy; no supplied value is in the artifact, the manifest or the drill (Linux; the staging and the helper's preflight run everywhere). Rows stored before M29.1 are masked at startup by `server/secret-scrub.mjs`: secretPaths finds them, a job with staged secrets is left alone, a masked schedule or flow is paused or refused as before, and one audit entry records counts. Existing backups are not rewritten. Application backups still contain the credentials needed to restore the application and require private storage.

### M30 — BoxPilot watching BoxPilot

- ✅ **M30.1 Job logs are verified readable** at write time (M27.4's canary, made permanent)
  (unreleased): once the helper has finished a job, the web service opens its log and stats it,
  without reading it, before saving the output. A log it cannot open is said on the job, as a failed
  "log" step naming what was in the way ("permission denied (the log folder is mode 700)"), and
  Activity says the output could not be opened where it used to say "This job recorded no output".
  It raises one condition for the server, `joblog.unreadable`, not one per job, through the same
  ledger as `record.failed`: announced once, kept as not announced without a target, and cleared,
  with one "resolved" push if it was announced, by the next log that opens. A job that printed
  nothing has no file, which proves nothing either way and leaves the condition as it is. The
  startup canary stays.
- ✅ **M30.2 Interrupted jobs are announced** (v1.112.0) **and run again where safe** (unreleased):
  a registry entry declares `rerunAfterInterrupt`, with the reason written beside it, and a job of
  it that a restart cut off is staged again once, as its creator, through the ordinary approval
  path; the two records name each other ("Ran again after BoxPilot restarted"). Declared:
  `homepage.sync`, `dns.names.apply` and `backup.sync`; reads count too, though no read is a job.
  Never run again: a rerun (one per job), a job staged with secrets, a scheduled run or an
  automation's step (their owners report them), anything under always-ask approvals, a job whose
  creator can no longer approve. The registry refuses the flag on high-risk, typed-confirmation,
  BoxPilot-restarting and secret-taking operations. Everything else is still marked failed and
  announced. Left undeclared on purpose: the SSH and cloud mirrors and `apt.refresh`, whose root
  task keeps running through a restart, so a second run would race the first.
- ✅ **M30.3 Timeouts are a first-class result**, not a stderr prefix (unreleased): a job that ran
  out of time carries `timeout` - whose limit (the whole operation's, or one step's such as a
  pull), the budget, the time used, whether it never left the queue, the step, the last line of
  its log, and what "Try again with more time" would give. Commands, root tasks and the helper's
  reply say so as a flag; nothing matches "timed out after" any more. The dialog and Activity show
  it as "Ran out of time" / "Timed out", apart from failures. `app.install`, `app.update`,
  `app.rollback` and `app.model.pull` declare `maxTimeoutMs`, four times their budget (twelve
  hours is the ceiling for any operation); a retry doubles the budget and the pull limits inside
  it, and is staged for approval at the same tier as any other job. The helper takes the larger
  budget as `context.budgetMs`, sent only for those jobs, so a helper one release older still
  runs everything else.
- ✅ **M30.4 A weekly self-report** (unreleased): one push on Sundays at 09:00 server time, timed by
  the scheduler's own daylight-saving-safe next-run arithmetic; on by default like every other push
  once a target is set, and turned off, previewed or sent now under Settings, Notifications. It is
  read from what BoxPilot records - jobs, schedule and automation records, the health-alert ledger,
  the backups table - plus the setup checklist and the apps with no backup schedule for "not covered
  yet", a line left out when those cannot be checked. A week the server was off for is skipped
  rather than sent at whatever hour it came back; with no target it is one not-announced entry,
  replaced each week. Six lines at most. To the notification target: what ran, what failed, what
  was skipped and why, what is not covered yet. The morning glance M25.3 promised, from the server side.
- ✅ **M30.10 The helper starts without its backup NAS** (unreleased): after a reboot the helper
  failed with `Failed to set up mount namespacing: /mnt/boxpilot-backup: No such device` and, with
  `Restart=on-failure`, kept failing, five seconds after each attempt, for as long as the NAS was
  off, taking every host operation with it. The sandbox named the share's automount point (`ReadWritePaths=`), and
  setting a sandbox up resolves those paths: systemd 258+ does it through the automount on purpose,
  so a failed mount fails the helper; 255 fires it from its nosuid pass and waits out the mount on
  every start. The `-` prefix forgives only a missing path, and waiting for the network (the
  previous fix) does not make a NAS that is off answer. The destination now lives at
  `/mnt/boxpilot/backup` and the helper is given the folder above it, `/mnt/boxpilot`, which is not
  an automount point, so the share mounts on first use instead - writable whether it was mounted
  before the helper started or came up after. Kept: `ProtectSystem=strict`, `NoNewPrivileges=`,
  every other path; nothing else under `/mnt` is opened (tried and measured: `ReadWritePaths=-/mnt`
  also starts, but lets the helper write to every other drive; no `ReadWritePaths=` at all starts,
  but a share already mounted at start is read-only to it; `NoNewPrivileges=false` does not help on
  259). `server/backup-mount.mjs` is where the path is decided, and `/mnt/<name>` stays the rule for
  every other mount; `boxpilot` is reserved as a mount name. **An existing install on upgrade**:
  `scripts/boxpilot-upgrade.sh` stops the helper, then `scripts/boxpilot-backup-mount-move.mjs`
  moves the one fstab entry at `/mnt/boxpilot-backup` (a BoxPilot share or drive, or a line the
  owner wrote) to `/mnt/boxpilot/backup`: the old mount is released first and left alone if it is in
  use, fstab is saved as `/etc/fstab.boxpilot-<stamp>`, changed in that one field, checked with
  `findmnt --verify`, and put back with the old automount if the new one does not come up; a NAS
  that is off does not stop it. A rolled-back upgrade undoes the move. When the move did not happen
  (the share was in use, or the upgrade ran an older upgrade script - the in-app update runs the
  installed version's script, so it will for this one release), the helper still starts, backups to
  the NAS say the destination is unavailable, and Repair offers **Move the backup destination**
  (`storage.backup.relocate`, medium). Repositories on the share keep their paths inside it. Backup
  code with the NAS off reports the destination unavailable within the mount timeout (about 10 s
  measured, 30 s at most; the mirror check no longer asks a share that did not mount a second time
  for its sync record, which doubled the wait), and a write to a mounted share whose NAS went away
  fails in about 10 s rather than hanging (CIFS is mounted soft). Remaining: an NFS destination is
  mounted hard, so a write in flight when its NAS goes away waits for it to come back; not changed
  here, since soft NFS trades that wait for silent write errors. `tests/ubuntu/helper-automount.sh`,
  run on Ubuntu 24.04 and 26.04 in the install smoke workflow, reproduces the failure with the unit as
  it was, then proves the shipped unit starts with a TEST-NET NAS, mirrors to a local Samba share that
  comes up later, keeps writing across a restart and a NAS outage, refuses writes elsewhere under
  `/mnt`, and moves, refuses to move (in use) and un-moves a real fstab entry.

### M31 — Storage and data, next steps (continues M23)

- **M31.1** btrfs/ZFS snapshot rollback and browse-and-restore, still deliberately gated on a real
  filesystem to verify against.
- **M31.2** Per-disk SMART trend chart in the UI (the sampler and alert exist).
- **M31.3** Guided array/mount setup from bare disk to mounted-and-backed-up (M23.4).
- **M31.4** "Where the space went" over time: the app-data sampler's history as a chart, so a
  download folder growing 240 GB a week is a slope the owner can see, not only a sentence.

## Review follow-through: 2026-09-07

Evidence, implemented fixes, live measurements, limitations and alternative repair approaches are in [the reliability review](reviews/2026-09-07-reliability-review.md). Items below extend existing owners; they are not a second roadmap. Local implementation does not mean released or deployed.

### Extend M27: trustworthy and verifiable findings

- **M27.5 Partial checks and fresh verification (P1).** First slice implemented locally: failed/partial Repair scans say Checks incomplete and name missing sources; successful sections survive unrelated fetch failures. Second local slice: mount/fstab/catalog failure availability, dated running-library scans, and mutation-to-cache invalidation before terminal job events. Next: checked-at, age and per-source availability for every collector; targeted retry; post-repair detector rerun. Acceptance: helper failure, one collector timeout and stale cache never produce an all-clear; completed jobs say resolved, still failing, or could not verify using new evidence. Depends on M32.2 for cache instrumentation, not for honest failure display.
- **M27.6 Failure fixtures (P1, extends M27.3).** Add captured, scrubbed fixtures for full disk/inodes, apt lock held, helper unavailable, partial SMART, failed backup and disconnected client. Acceptance: reproducible tests establish both the finding and the safe action without damaging a real host. M26 retains drive-specific ownership.

### Extend M28: Repair Center readability

- **M28.5 Findings before explanation (P2).** First slice: larger Repair text, consistent severity labels, expandable evidence and rebuild inventory, contiguous prerequisite count/details, visible download formats, neutral readiness styling and per-source missing-data notices. Desktop and 390 px browser checks passed for layout and preview entry. Modal focus containment, opener restoration and bounded/cancellable result observation are implemented and keyboard-checked. Remaining: current jobs above the fold and explicit service interruption/duration. Recovery exports identify private operational information. Acceptance: keyboard workflow from finding to preview to result; desktop and narrow-screen QA; no green readiness styling for missing/unknown checks. Separate verified facts from likely causes.

### Extend M29: security and bounded retention

- **M29.2 Staged-secret expiry (first slice implemented locally 2026-09-07).** Thirty-minute deadlines now apply to secret-bearing approvals; the minute sweep cancels expired jobs and drops secrets; the dialog shows expiry. Clock/restart tests pass. Remaining shared secret-path and backup-exclusion audit stays with M29.1/3. Original scope: expire awaiting-approval secret material and approval validity together after 30 minutes, including restart and abandoned-dialog behavior. Acceptance: injected-clock boundary tests, no secret in jobs/flows/schedules/logs/backups, and clear re-entry guidance.
- ✅ **M29.4 Recovery exports and dependency hygiene (P1).** First slice implemented locally: owner-only full recovery export, case-insensitive API no-store, qs 6.16.0. Dependency audit done (unreleased): `scripts/dependency-audit.mjs` runs in its own workflow on dependency changes and weekly; a production advisory at moderate or above fails unless `.github/audit-triage.json` accepts it with a reason and an expiry date, development-only advisories warn, and Dependabot groups weekly npm and Actions updates. Composite routes audited against direct-operation role rules (unreleased): `server/routes/access.mjs` holds the role policy `index.mjs` mounts and the two rules composite routes now follow. Another account's work is the owner's to see: the action centre's failed-job count and an operator's support bundle (audit trail included) are the caller's own; `/flows` keeps a run's outcome but drops the job ids and error text of a run someone else started; `/settings/watch` shows other accounts' interrupted jobs, unsaved results, schedule failures and new sign-ins by kind, not by title; `GET /audit` shows each account its own entries; and the backup, protection, retention, VM export and recovery records, the catalog's rehearsal and kill-switch verdicts, LVM snapshots and the firewall profile name no other account. An operator read (ADR-003) no longer answers a viewer through a composite route: Repair leaves File sharing and USB history to an operator and says so, the Storage page's per-app data sizes and each share's recycle-bin size and folder owner are left out, and automation suggestions skip the housekeeping scan. The role policy treats a trailing slash as Express does. `server/routes/route-matrix.test.mjs` mounts every router `index.mjs` mounts, fails on any route without an entry, and drives every data route as viewer, operator and owner, as written, in upper case and with a trailing slash, with the owner's and the operator's jobs on record everywhere a composite route reads. Acceptance: non-owner cannot obtain another user's job metadata through any export or aggregate endpoint; inventory summaries stay usable where authorized.
- **M29.5 Capacity bounds on authentication state (implemented 2026-09-07).** OIDC retains at most 1,024 pending codes and 64 per client, physically expires idle grants and rechecks client registration. Throttles preserve active blocks at a true capacity ceiling, including all-blocked saturation. Signing-key damage preserves the identity and leaves ordinary login available; Settings explains recovery. Acceptance: hostile cardinality test keeps memory bounded and does not let a caller evict its own block. Reuse the existing bounded whois/passkey caches.
- **M29.6 Raw configuration and private inventories (implemented 2026-09-07).** Raw Compose reads require an elevated owner session, use bounded fixed-file reads and remain editable. Viewer configuration masks unknown environment values. Password fields cannot opt out of secret handling, and new raw edits stay in temporary secret storage rather than persisted job parameters. Backup inventories and model names/sizes require an operator. Acceptance: HTTP role/elevation tests, manual inline-secret fixtures, symlink/oversize refusals, and a durable-job test that keeps the edit out of stored parameters. Existing historical copies are not rewritten.

### Extend M30: repair BoxPilot when BoxPilot is broken

- **M30.5 Independent doctor and known-good recovery (P1).** First local slice: independent text/JSON CLI plus manual operator UI inspector; service/account state, socket/log/state metadata, free bytes/inodes and required release assets. CLI probes bounded web/helper responses and version agreement. Live ordinary-account inspection passed 15 checks with 2 protected-path unknowns. Next: exact repair plans, last-known-good release metadata and database-compatible rollback. Acceptance: disposable Ubuntu VM recovers with Express stopped; preserves configuration/secrets and original release; requires database compatibility before rollback; verifies both HTTP and helper afterward.
- **M30.6 Interrupted APT recovery (P1).** First local slice: manual operator diagnosis with dpkg audit, dependency simulation and kernel lock ownership; reviewed no-remove repair through the existing task runner; execution-time diagnosis and fresh final verification. Live Linux read-only diagnosis passed. Disposable Ubuntu 24.04 package-interruption and real-lock refusal tests passed locally and are wired into CI. Remaining: bind the displayed dependency plan to execution and active BoxPilot job context. Acceptance: active upgrade is left alone; stale job metadata never authorizes deleting locks; interruption fixture returns a clean audit and recorded repair result.
- **M30.7 Database recovery and rehearsal (P1).** First slice: manual operator SQLite health inspection and independent doctor `--database`, using an isolated process with a deadline and omitted record contents. Corruption/WAL/foreign-key/missing-table fixtures pass; a real Ubuntu ownership test preserves bytes and permits reopening by the web identity. Hosted native installation verifies the helper inspector and independent database checks with both services stopped. Remaining: preserve an offline recovery copy, validate a chosen backup/schema, stop the writer, restore and verify. Reuse M20 backup primitives. Acceptance: disposable corruption fixture restores service; original database and WAL remain recoverable; never delete a live WAL or replace an unverified database.
- ◐ **M30.8 Low-space recovery (P2).** First slice: completed-job runtime logs are released by the helper only after a full saved-copy comparison; failed, active, changed and oversized logs are retained. Real Ubuntu file-permission fixture passed. Second slice (unreleased): `space.inspect` (operator, ADR-003) attributes bytes and inodes to the journal (journald's own `--disk-usage` figure beside a file-by-file count), BoxPilot's job logs by the state of their jobs, the APT cache (`du` bytes and inodes), Docker (`docker system df`, volumes included, and the dangling images), and each local backup folder with the retention it already has, plus the free bytes and inodes of every filesystem involved; a category that cannot be read is unavailable, never zero. `space.cleanup.preview` (operator) takes the cleanup's own parameters and lists exactly what goes, what that frees and what stays; the journal half models journald's own vacuum order so it can name the files. `space.cleanup` (medium) works the plan out again and carries it out: `journalctl --vacuum-size`/`--vacuum-time` to the chosen bound (at least 64 MiB, at least one day) and `apt-get clean`, both as root tasks because the helper sees /var read-only; `docker image prune` for dangling images no container uses, never `--all`, a volume or a system prune; and completed jobs' logs older than a retention of at least one day, each checked again as it goes (root's alone, unchanged, still a completed job). It measures each category and its filesystem before and after, reports a planned item still there instead of claiming it, and fails the job, after doing the rest, when a chosen category could not be read. Never touched: the journal file being written, logs of running, failed, cancelled or recently written jobs, volumes, tagged images and every backup. Parsers and the bounds are tested against captured output with placeholders. Reuses the Reclaim disk space service's dangling-image listing, Docker size parsing and backup keep count, and the root task runner. Remaining: a panel on the System page over these three operations; running the journal and APT halves on a real Ubuntu host; and the backup-history half, not attempted in this slice: reconcile recorded backup history with current local and independent-copy availability; keep unavailable and unknown distinct and preserve audit history. Acceptance: gain measured free space without deleting active logs, application volumes, or last good backup. Reuse existing housekeeping and retention operations.
- **M30.9 Repair recipes and bounded automation (P2).** Add declarative detect/precondition/action/verify/recovery recipes over the operation registry. Link existing M22 app repair, M20 restore, M26 mount recovery and M31 browse/restore instead of reimplementing them. Acceptance: one root-cause card groups related symptoms; opt-in automatic recipes have cooldown, maximum attempts, stop conditions and notification; destructive recipes retain existing approval tiers. Depends on M27.5 and individually validated M30.5-8 tools.

Implementation note, 2026-09-07: the tested source slices described above and below are included in 1.115.0. "Implemented locally" in the dated entries describes their initial validation stage; it does not claim they are deployed. See the [outcome review](reviews/2026-09-07-final-review.md) for publication and remaining verification.

### M32: BoxPilot's own resource use, measured and controlled

This owns diagnostic cost and resource accounting. M21 remains the owner of general server performance views; M30 owns recovery actions.

- **M32.1 Resource breakdown (first slice implemented locally 2026-09-07).** Repair has a manual web/helper resource check, separate heap/file-cache accounting, partial availability and cheap five-second caching. No scan or sampler starts on page load. Remaining: bounded history, event-loop delay, service restart counters and trend presentation. Original scope: show web/helper RSS, heap used/total, external buffers, cgroup anonymous/file memory, PSI, event-loop delay, active subprocesses/streams and restart/OOM counters. Use low-cost sampling and bounded history. Acceptance: Linux file cache is labelled correctly; unavailable counters are not zero; enabling the view starts no recursive scans.
- **M32.2 Measured caching (P1).** First slice implemented locally: generation-safe shared cache invalidation and synchronous error normalization. Second local slice: hit/miss/dedup/duration/age counters, shared inventory/prerequisite reads with injected clocks, concurrent needrestart coalescing, and selective invalidation after relevant operations. Remaining: expose collector metrics and benchmark contention across tabs. Acceptance: post-change readers cannot get pre-change cached facts; concurrent tabs share one expensive read; errors are not cached as healthy results.
- **M32.3 IO budgets and scheduling (first slice implemented 2026-09-07).** Existing sequential du/deadline/minimum-gap controls remain. Added supported idle IO and nice 10 requests, scheduled PSI-based deferral with a visible reason and 30-minute retry, and coalesced scans/sampler writes. Exact shared folder paths are scanned once per pass and labelled as shared in growth history; empty successes and malformed inventories have distinct outcomes. The actual Linux priority command passed in disposable Ubuntu. Remaining: per-device coordination, repeated-failure backoff and representative IO contention benchmarks. Acceptance: scheduled scans defer under injected pressure, manual checks remain possible, and database writes stay bounded. Benchmark in a disposable VM with representative metadata volume, not production.
- **M32.4 Stream and helper memory budgets (implemented locally 2026-09-07).** Incremental helper protocol parsing, response-size cap and overall deadline; SSE backpressure and per-session connection budget with cleanup. Acceptance: stalled clients and a continuously heartbeating oversized helper cannot grow buffers or retain listeners without limit; normal long jobs keep streaming and reconnect correctly.
- **M32.5 Reproducible leak and idle-cost suite (first slice implemented 2026-09-07).** `npm run check:retention` exercises shared helper reads, stream close/abort, SSO exchange and throttle churn with explicit garbage collection, zero outstanding-work checks and an 8 MiB retained-heap regression budget. CI runs a shorter workload. A manual same-document browser churn experiment was also run; DOM/listener counts stayed constant, while a browser-native memory counter rose and remains a profiling lead. Remaining: a repeatable browser harness with native-allocation profiling, failed-helper and job churn scenarios, resource-counter assertions, read/write/process-spawn costs and a 24-72 hour disposable-host soak. Acceptance: budgets stated against a measured baseline; no unexplained positive retained-heap slope; no orphan listeners/timers; results include workload and version. Do not claim a full pass from a short RSS snapshot or the synthetic suite alone.

Suggested order: release the reviewed fixes; M32.4 and M29.2; M27.5 plus M32.1-2; M30.5-7; then M30.8-9, M28.5 and M32.3-5. Keep backup compatibility and independent recovery ahead of broad automatic remediation.

## M33 — One interface: Home and Ops

Decided 2026-09-28 (ADR-004): the owner chose the Launcher and the Command Center from the ten
directions in `docs/design-directions/04-eight-directions.html`. One design system, two views of
the same data; light and dark, following the device with an override. The plan and the earlier
study are in `HANDOFF-UI-REDESIGN.md` (B1-B7); this milestone takes B1-B4 and leaves the rest to
the milestones they overlap.

- ✅ **M33.1 Design system** (B1, unreleased). `src/styles.css` holds one set of colour tokens
  with a dark value (the GitHub-dark look BoxPilot always had, unchanged) and a light one, applied
  by `@media (prefers-color-scheme: light)` while the choice is System and by
  `html[data-theme="light"]` when it is Light. The eight older dark looks were retired at the
  owner's call (2026-09-28): one dark and one light, System by default. Semantic tokens for
  status (good, warning, danger, neutral, unknown - grey, hollow and dashed, never green), risk
  tier and elevation, and density tokens (`data-density="comfortable|compact"`) for spacing, row
  heights and type. Every colour literal in the page styles became a token (63, fifteen of them
  fallbacks inside `var()`), and twelve references to tokens that were never defined now resolve.
  `scripts/check-contrast.mjs`, run by `npm test`, checks 40 text and mark pairs in both themes
  (4.5:1 body, 3:1 large text and marks), that the two light blocks match, that every dark colour
  has a light value and that unknown is not green. System / Light / Dark sits in the top bar and
  in Settings, per browser in localStorage, set before first paint by `index.html`. Components in
  `src/ui/`: `Button` with `risk` (low plain; medium an amber mark; high a red mark, a lock and
  "Password"; the tier is the button's description for screen readers), `RiskTag`, `StatusChip`,
  `Tile`, `MetricTile`, `Card`, `Section` (status first), `Dock`, `ThemeSwitch`; tiers come from
  `src/ui/operationRisk.ts`, which `server/ops/ui-risk.test.mjs` holds to the registry. The gallery
  is `/?gallery`, shown only by the demo. Updates & packages is rebuilt on them.
  `.github/workflows/ui-screenshots.yml` photographs every demo page and the gallery, light and
  dark, on Linux for each UI pull request (artifact `ui-screenshots`); run by hand with a
  `baseline` ref it adds that ref's dark pages. Against `main`, the other pages' dark captures
  differ only in the top bar, in timestamps, and in the few lines whose undefined colour now
  applies (a drive's "kernel errors: 0" in green, the apps filling a disk). Left for M33.2: the shell (the Home/Ops switch and
  the command bar in the top bar, the dock replacing the sidebar), Home itself, and real app icons
  on tiles from the manifests. Left for M33.3: Ops, whose tables need a compact `Table` component
  (today the class `ui-table`). Every other page keeps its own styles, now on the tokens, until
  M33.5 moves it.
- ✅ **M33.2 The shell and Home** (B2, unreleased). A top bar with the Home/Ops switch and a command
  bar ready for search; Home shows app tiles with live health, what needs the owner, and the admin
  areas in a dock. Acceptance: "is everything OK?" is answered by Home alone. The sidebar is gone:
  the top bar holds the Home / Ops switch, the command bar and the theme, and the admin areas sit
  in a dock at the bottom (`src/shell/`), one row with each area's name over its icon on hover and
  keyboard focus, scrolling inside itself on a narrow screen, Updates and Repair carrying counts.
  Home (`src/home/Home.tsx`) is the landing page. A verdict comes first ("homebox is running. 2
  things need a look.") and is never "healthy" about a source that could not be read: it names
  what was not read. What needs the owner (`needs.ts`) is worst first, then in the order asked
  for: health alerts, Repair's findings, jobs awaiting approval, updates, backups, failed jobs,
  setup; it carries every attention item the Classic overview raised. The installed apps are
  tiles with their health (stopped, unwell, never or not lately backed up, paused, update ready)
  and the manifest's icon, initials where it has none; a tile opens a sheet with the app's state,
  reach, update, backups and restore drill and a link to the app itself. The system (load,
  memory, each disk) and the backups (apps covered, the off-box copy, the database) are figures.
  Every fact opens its page; every fix shows its tier on its button and opens the ordinary
  approval dialog; a role sees only the buttons it could use (`mayStart`, whose owner-only list
  `server/ops/ui-risk.test.mjs` holds to the registry's `minimumRole`). One facts provider
  (`facts.tsx`) reads the endpoints the Classic pages already use, only while Home or Ops is
  open: the quick ones every minute, the slow ones every five, jobs over the live event stream.
  The command bar (Ctrl/Cmd K, `CommandBar.tsx`) finds any page, any app (its own page, or its
  card: the catalog opens at one app with `?app=`) and any feature the pages list; where the
  local assistant answers (M34.2) it asks it and shows the answer, its sources and any suggested
  step, which opens the approval dialog at its tier; where it does not, it says so and stays a
  search box. The Overview stays in the dock as "Overview (Classic)". The demo answers the
  assistant, records which app each backup job was for, and adds a failed backup and a job
  awaiting approval to the trouble world; the screenshots add the command bar, an app sheet and
  Home in the trouble and fresh worlds. Left: app logos (manifests carry an emoji; real logos
  need a manifest field and bundled images); per-app numbers on tiles ("2 streaming") need
  per-app reads; the Classic overview still shows facts Home does not (the UPS, each SMART disk,
  the key services, the setup checklist as a list), so it is not retired; the assistant's answer
  arrives whole rather than streamed; B2's notification centre is not built.
- ✅ **M33.3 Ops** (unreleased). The metric strip, what needs the owner by tier, containers with
  their numbers, the job queue and a backup matrix, from the same sources as Home. Acceptance:
  every fact on Home is one click from its detail on Ops. `src/home/Ops.tsx`, at compact density,
  reads Home's facts provider plus the Performance page's live read (every five seconds while
  open) and a longer job history for the matrix. The strip: CPU and memory live, each disk, the
  network (whether the tailnet is up, the LAN address), the hottest sensor or the uptime, each
  opening its page. What needs the owner is Home's list, split: alerts, with nothing to run from
  here (a staged job shows the tier it waits at), and an action inbox grouped by the tier of its
  fix (password and typed confirmation; preview, then confirm; one click), every button through
  the approval dialog. Containers and VMs with their state, CPU, memory, reach and port; the job
  queue with the operation, what it acted on (from its parameters), its state in Activity's
  words, when it started and how long it took; and the backup matrix: each app worth backing up
  with its last five runs, its newest backup, its restore drill and a verdict. `Ops.test.tsx`
  holds that every need Home lists is on Ops and every app tile is a row. `src/ui/Table.tsx` is
  the compact table (the `ui-table` class): a caption for assistive technology, figures
  right-aligned in tabular (compact: monospace) numerals, a status mark per row, an empty state,
  columns a phone leaves out and rows it stacks instead of scrolling; the gallery shows it at
  both densities. Left: network throughput (no endpoint measures it, so the strip shows
  connectivity); the study's time-range control and sparklines (these figures keep no history);
  the GPU tile (with the GPU page, M22); and the Firewall's "listening vs. allowed" screen (M33.5).
- **M33.4 Timeline and the way back** (B3). Jobs, checkpoints and settings changes as one feed.
  "Undo" appears only where an operation declares a way back (M22.2); elsewhere the entry says
  plainly that it cannot be undone.
- **M33.5 Settings, area by area** (B4). Storage, Network, Firewall, Users and System move into
  one searchable settings area; each old dashboard is retired only once its replacement shows
  the same facts. Current pages stay reachable as "Classic" until then.
- **M33.6 Topology** (from the study's direction 4): the picture at the top of Storage and Network -
  drives to folders and apps, the firewall's gates, the LAN and the tailnet - drawn from the same
  facts as the pages beneath it.
- ✅ **M33.7 The look** (unreleased; ADR-004 addendum). Home and Ops had the study's layouts in the
  old skin; now they have its look, light and dark, and every Classic page its type and surfaces.
  Fonts: Figtree, IBM Plex Sans Condensed and JetBrains Mono, OFL, self-hosted from `@fontsource`
  (Latin, upright, the weights used) under `font-src 'self'`, licences in `dist/licenses/`.
  **Home** is the Launcher: a wallpaper of three glows (a fixed layer on Home only), frosted glass
  panels down the left (what needs you, the system, backups and disks), the greeting and verdict
  and the apps as colour squares on the right, what can wait in a glass strip under them, the dock
  in glass at the bottom; light is a daylight wallpaper with white glass and dark ink. Buttons are
  pills that keep the tier (medium's amber mark, high's red mark, lock and Password), with the
  tier also beside the words as in the study. App colours come from `src/ui/appColor.ts` (fifteen
  deep hues, the known colour for about forty well-known apps, otherwise stable from the id;
  manifests carry no colour); each tile's badge has its own shape (a dot, "!", "×", a dashed ring).
  The top bar floats over the wallpaper with the host and its verdict's mark, a glass search box
  and glass controls. **Ops** is the Command Center: near-black (paper in light), hairlines, Plex
  Condensed, every figure in mono, amber and cyan, panels with small capitals and a count, alerts
  with a coloured leading edge, the inbox led by each fix's tier, a compact bar reading
  "homebox / ops" with the host's facts (`src/shell/TopBarSlot.tsx`), and the dock stood up as a
  56px rail under the BoxPilot mark (a phone keeps the dock). CPU, memory and the hottest sensor
  draw sparklines from the reads Ops makes while open (a sixty-read buffer; no history API, so
  none is invented, and no time-range control). The Classic pages move to the new sans, a
  blue-slate palette with Home's glows faint behind it, softer radii and flat buttons, layouts
  untouched. The contrast check judges text on the wallpaper and on glass at its lightest and
  darkest points, Ops' pairs and every app square's glyph (554 pairs). The demo's performance read
  moves a little between reads so its sparklines have something to draw, and the screenshots wait
  for Ops' third read. Left: real app logos (the squares carry the manifest's emoji or initials);
  network throughput and a GPU tile on Ops (no endpoint); history for the sparklines and the range
  control; the study's notification bell and "Tailnet" pill on Home's bar (BoxPilot has no
  notification centre, and the connection pill says how this browser connected).
- ✅ **M33.8 The console** (wave 1, unreleased; ADR-004 second addendum). The owner, after 1.138.0:
  tapping any icon under Ops "just reverts me back to the old box pilot... I want it gone." Every
  page but Home now opens inside Ops' shell: the rail (the dock on a phone), the compact bar with
  the page's name after the server's (`homebox / firewall`, the name read once from the inventory
  when a page is opened first), and the Command Center's tokens on `<html>` (`data-shell`), so
  dialogs, sheets, Activity and the command bar opened over a page share its look. The Classic
  header (eyebrow, title, description) and the "What you can do" strip are gone; a page not yet
  rebuilt gets the kit's `PageHeader` from the shell, its description behind an info toggle.
  Switching pages keys the page's Suspense boundary, so the page left behind takes its name out of
  the bar at once. **The kit** (`src/ui`, each with tests and a place in the gallery):
  `PageHeader`, `Panel`, `Field`, `TextInput`, `Textarea`, `Select` (the native select, styled),
  `SecretInput`, `Switch`, `Checkbox`, `Segmented`, `Tabs` (with `useUrlParam`, so
  `?view=storage&tab=shares` opens that tab), `KeyValue` (rows, columns, the study's strip),
  `Notice`, `EmptyState`, `Toolbar` and `SearchField`, `Sheet` (`useDialogFocus`), `CodeBlock`,
  `Progress`, `JobProgress` (the job log's own stream) and `Tag` (reach and tier); `Table` sorts
  from its headers with `aria-sort`. Ops' header and panels are the kit's, and `Panel` is the one Repair (M35) uses too. **The page CSS
  convention:** a rebuilt page's styles live in `src/pages/<area>/<area>.css`, tokens only, every
  selector under `.<area>-`, held by `src/pages/pageCss.test.ts`; `src/styles.css` keeps tokens and
  shared components. **The stopgap:** the Classic pages' classes (panels and their headers, stat
  cards, buttons, pills, notices, legacy tables, inputs and selects, modals) are restyled to the
  console until wave 2 rebuilds each. **The Classic overview is retired:** Ops gains Disks (each
  drive's SMART health, a USB bridge or a sleeping drive said as such), Key services, Power (the
  UPS) and Setup (the checklist); Home shows drive health and the UPS as figures; `?view=overview`
  and an older server's "Open Overview" land on Home, and the action centre recommends Ops.
  **Reference pages:** Services and Logs rebuilt on the kit with every feature (scopes with counts,
  search, sortable units, tiered actions, a journal sheet; groups, units, containers, lines, window,
  filter, follow, download and the support bundle, now in Logs' own header), and
  `docs/UI-PAGES.md` says how to build a page: facts first, tiers on every action, explanations
  behind the toggle. The contrast check runs the main pairs under the console's tokens as well,
  which found light amber and green chips at 4.37:1 on the page; they are a shade darker
  (`#935700`, `#147447`). Left for wave 2: rebuilding Storage, Backups, Network, Firewall, Users,
  GitHub, Apps, Automations, Metrics, VMs, System, Settings, Setup, sign-in, Activity and
  the approval dialog on the kit, and deleting stopgap rules as their classes go; Repair is
  M35's; Updates, built on the components in M33.1, still takes its header from the shell.
- ✅ **M33.9 Storage and Backups on the kit** (wave 2A, unreleased). Both pages rebuilt in
  `src/pages/storage/` and `src/pages/backups/` with every feature the Classic pages had, organised
  by what the owner does. **Storage:** the verdict (a mount 90% full, a filesystem filling within
  two weeks, a share that dropped, or room to spare; "Not read" when the drives could not be read),
  then disks, mounts, shares and free LVM space in mono, then tabs kept in the address: *Drives*
  (BoxPilot's drives with Check, Unmount and a switch to reconnect by itself, the rule stated once;
  every disk and partition with Mount…, Format and Share…; unused LVM space to claim), *Shares*
  (NAS folders mounted here, missing client tools to install), *File sharing* (Samba and NFS, the
  draft kept across tabs until applied, users, the diagnosis, the address to type on each machine),
  *Snapshots* (LVM with roll back, btrfs and ZFS) and *Mounts* (what is filling up and why, where
  data lives, every mounted filesystem). Mounting a drive or a share, adding a share or a user and
  taking a snapshot are sheets. **Backups:** the verdict (a backup that stopped, an app never
  backed up, nothing off the box, or protected; never green about app data it could not read),
  then tabs: *Apps* (each app's last backup and whether it keeps happening, back up or schedule
  from its row), *This server* (the database's drilled backups with Protect and retention, machine
  snapshots with how many apps would come back with their data), *Off-box* (whether a copy is kept
  elsewhere, then the backup drive, SSH and cloud destinations, each set in a sheet) and *Restore*
  (every snapshot this server can restore from, restored from a sheet, and what a restore staged
  for review). Every action carries its tier and is left out for a role that cannot start it;
  `operationRisk` gains the 24 operations the two pages start. The Classic `StorageCenter`,
  `SambaPanel`, `NfsPanel`, `BackupCenter`, `CloudBackupPanel`, `RestorePanel`,
  `RestoreReviewPanel`, `ConnectPaths` and the Storage-only half of `AutoReconnect` are deleted,
  with the Classic CSS only they used. **The flaky share-mount-host check:** share.mount read its
  unit's journal from the start of the second its attempt began, so a NAS that did not answer,
  tried in the same second a wrong password for the same share was refused, read that refusal too
  and was said to refuse the credentials. The journal is now read from the millisecond the attempt
  began, only the last attempt's lines explain it, and the Ubuntu test puts a refusal in that
  second on every run.
- ✅ **M33.10 Network and security on the kit** (wave 2B, unreleased). Network, Firewall, Users & SSH
  and GitHub are rebuilt in `src/pages/{network,firewall,users,github}/`, each with its own sheet
  and tests, and the Classic components (`NetworkCenter`, `TailnetPanel`, `TailscalePanel`,
  `DnsCheckPanel`, `LocalNamesPanel`, `RouterPanel`, `VpnProfilePanel`, `FirewallCenter`,
  `Fail2banPanel`, `UsersCenter`, `GitHubCenter`) are deleted with the Classic and stopgap CSS only
  they used. Every feature stays; the facts come first. **Network** leads with whether the server
  has a way out (no default route is red, an unread source amber), a strip of gateway, address,
  resolvers and Tailscale, then five tabs (`?tab=`): Overview (every address BoxPilot answers on
  with Copy, LAN access and HTTPS on the LAN side by side, the LAN's devices with Wake), Tailnet
  (exit node and subnet router as one `tailscale.set`, every tailnet device and how it is reached),
  Names & DNS (the blocker check and who uses it, local names, port 53, the DNS assessment in a
  sheet, device roles), Router (read only; connecting takes the password in a sheet) and VPN (the
  owner's profile, edited in a sheet). How to trust the certificate on each device is a sheet
  rather than a `<details>` above the facts. **Firewall** leads with on or off and the default
  policy; its tabs are Overview (suggestions, each one click with its tier; the profile in force;
  what always stays open), Rules (delete with its tier, protected rules marked "kept open", adding
  one in a sheet that refuses a deny on a protected port) and Brute force (fail2ban's facts, banned
  now and since start, thresholds and what is never banned, shown to every role per ADR-003's
  addendum; the thresholds form only to a role that may apply it). Choosing a profile is a sheet
  of radio cards, services and options, and the approval dialog still lists every ufw command. A
  suggestion with no label of its own says what it does ("Remove 53/tcp"). **Users & SSH** leads
  with whether SSH takes passwords, then sshd's settings, then the accounts; adding a user and
  importing keys are sheets that check names as `useradd` and GitHub would. **GitHub** leads with
  how many allowlisted repositories answered and a strip of what BoxPilot may do with GitHub (read
  public metadata, nothing else), then each repository's head, release and assets. Each page takes
  the signed-in role: a viewer sees the facts and no buttons, an operator no owner-only or
  high-risk ones, and reads that need an operator (accounts, the router) or the owner (the VPN
  profile) say so instead of failing. `operationRisk` gains the eighteen operations these pages
  start, held to the registry by `server/ops/ui-risk.test.mjs`. The demo answers
  `/integrations/github` with fictional metadata, so the page can be reviewed. Page-local pieces
  worth promoting to the kit: a Copy button for one value, a link drawn as a Button, radio cards,
  and a list of suggestion rows with a tag, words and one action.
- ✅ **M33.11 Apps, Automations, Performance and Updates** (wave 2C, unreleased). Four pages
  rebuilt in the console on the kit, every feature kept, the Classic components deleted
  (`AppCatalog`, `AutomationsCenter`, `PerformanceCenter`, `UpdatesCenter`, the old
  `SchedulesPanel`) with the stopgap rules only they used, and the Classic Updates rules, whose
  names the new page reuses. **App catalog**
  (`src/pages/catalog/`): the verdict counts apps that need a look (a leak outside the VPN or a
  folder the app cannot write to is red, a paused app or a broken helper container amber), then
  three tabs with one search and a category across them: the installed apps as Home's colour
  squares with their health, the catalog as cards, and the Compose stacks BoxPilot did not start.
  Each app opens its sheet (`?view=catalog&app=<id>`, and `&sheet=backups` for a tab): its facts
  first, then Reach (every address, home network or tailnet only with the switch and what each
  port does, the reachability check, the wiring between apps), Backups (the rehearsal's record,
  weekly rehearsal, restore whole or one file, rehearse, delete), VPN (exit, forwarded port, the
  kill-switch drill and its weekly check), Logs (helper containers too), Config (masked .env, the
  owner-only raw Compose file and its editor), Models, Sign-in and Secrets. Install and settings
  are a form in a sheet with a section per kind of setting, prechecked as before. Tailnet
  addresses that lead nowhere are listed with their withdrawal. **Automations**
  (`src/pages/automations/`): failed and late runs first, then Automations (steps, tier, facts,
  what the last run did in a sheet, schedule and webhook controls, confirmations inline), Schedules
  (the panel System also shows, now with its log and its form in sheets) and Ready to use (the
  suggested flows first, with the tier of their steps); building one is a sheet. **Performance**
  (`src/pages/performance/`, "Metrics" in the dock): the verdict names the busiest measure, the
  strip has each figure with Ops' thresholds, every app with its square, live CPU and memory and
  its controls, then each filesystem and sensor; it no longer reads while the tab is hidden.
  **Updates** (`src/pages/updates/`): its own header, the strip, the services still running old
  libraries, and tabs for the packages, the common tools and installing anything by name. Every
  button carries its tier (fourteen more operations in `src/ui/operationRisk.ts`, held to the
  registry) and a role that cannot run it does not see it; a viewer reads everything.
  System's Schedules tab (M33.12) draws the same panel from `src/pages/automations/` with the
  signed-in role, so a viewer there sees no Pause or Delete either. Left: the Classic rules
  outside the stopgap that only the old pages used are listed in the pull request for a sweep;
  `AppSquare` and the sheet's "act, then close" pattern are candidates for the kit.
- ✅ **M33.12 Virtual Machines, System and Setup** (wave 2D, unreleased). Rebuilt under
  `src/pages/{vms,system,setup}/` on the kit, facts first, every feature kept; the Classic
  components, their tests and the CSS only they used are gone. **Virtual Machines:** the verdict
  (host ready, needs setup, libvirt not connected) and the counts in the header; tabs for the
  machines, their backups, the installation media and the host. Each VM opens a sheet with its
  facts, live use, snapshots, disks, interfaces and every action; making a VM from a cloud image or
  planning one from an ISO are sheets. High-risk actions (create from a plan, delete, revert a
  snapshot, forget an unrecorded snapshot) say beside the button that they ask for the password and
  the name typed out, and creating from a plan now does ask for the name, as the page always said.
  **System:** BoxPilot's update as the verdict; Overview (figures that open their tab), Updates,
  Housekeeping (reclaimable space, Docker's disk, the database copies), Time & name, Hardware
  (memory and swap, swappiness, the swap file, SSD trim as a tiered switch, the UPS) and
  Schedules. **Setup:** the welcoming start of the product, in the console: the server greeted by
  name and the profiles on the Launcher's colour squares, each saying what is in place; a profile
  lists its steps with state and tier and runs the rest as before; preparing a new server is the
  second tab. The VM and system operations are in `operationRisk`, and roles see only what they
  may start. The demo's VM backups, media, planning, stats, Docker disk and update fixtures now have
  the server's shapes. Page-local pieces worth promoting to the kit: a file picker, a
  "what this asks for" line beside a high-risk button, and a sheet body whose rows keep their
  height (`grid-auto-rows: max-content`) so a panel in a sheet scrolls instead of being clipped.
- ✅ **M33.13 Settings, sign-in and the shell's dialogs** (wave 2E, unreleased). The pieces seen on
  every page, rebuilt on the kit with every behaviour kept. **The approval dialog**
  (`src/shell/ApproveDialog.tsx`; the old path re-exports it for pages still being rebuilt) leads
  with the tier: a band in the tier's colour with its name in words (a lock for high) and what
  approving asks, under the operation's name and id. Then "What it will do" (the page's preview,
  or the registry's description when a page gives none; exactly what the job is given behind a
  toggle, or in full when approving what someone else staged), then what approving needs (the
  typed confirmation and the password as the kit's fields; the approval's expiry), then the run
  followed with `JobProgress`, and its ending with the job log. Existing jobs (M36), `onStaged`,
  `handoff` and `moreTimeFor` (M35, M30.3) are unchanged, as are the labels other pages' tests
  press. It is drawn over the page in the console's look wherever it opens, Home included
  (`src/shell/look.css`). **Activity** and **the notifications** are the kit's `Sheet` with the
  facts on top (running, waiting, failed); a job's row carries its state in words, and M36's
  review, cancel and dismiss stay on it. **The job log**, its timeout and follow-up notices and
  the page error are the kit's notices, rows and `CodeBlock`. **The top bar's own controls**
  (Activity, the bell, the role, the elevated lock, Sign out) are the shell's
  (`src/shell/SessionControls.tsx`). **Settings** (`src/pages/settings/`) is tabbed, the tab in
  the address: Account & sign-in (password, passkeys and recovery codes, sign-in methods, where
  you are signed in), People, Notifications, Approvals, Single sign-on, Credentials, Appearance;
  the owner's tabs stay the owner's and a viewer has no sign-in methods (ADR-003); the header says
  whether alerts can reach the owner and how approvals are set; saving or removing a credential
  carries its tier. **Sign-in** (`src/pages/signin/`) is the Launcher's wallpaper and a glass
  card, the ways in best first (passkey, GitHub, Tailscale, then the password), with M36's reason
  the session ended and the page it goes back to. The runbook and the installation doctor, shown
  only in Repair, move into `src/repair/`. The areas sheet is the kit's `Sheet`, and the command
  bar has its own overlay. The shell's stylesheets follow the page convention
  (`src/shell/shellCss.test.ts`), and the Classic rules only these surfaces used are deleted. The
  demo can show the sign-in page (`?signin`) and stages each operation at its registry tier, so
  the dialog is reviewed at low, medium and high.
- ✅ **M33.14 The final sweep** (unreleased). The owner: "never see the old bones again". What no
  page owned is rebuilt on the kit: **Home's app sheet** and **Repair's confirmations** (the batch
  of safe fixes, a nightly schedule, dismissing a finding) were Classic modals, drawn on Home in the
  Classic palette; they are the kit's `Sheet` in the console's look (`look-console`). **Repair**
  uses `PageHeader` like every other page, its name in the bar, and its approval desk's typed
  confirmation and password are the kit's fields. The shell's loading line is the kit's
  `Progress` (`src/shell/PageLoading.tsx`); Firewall's plan preview drops its Classic classes.
  `src/ApproveDialog.tsx`, the re-export, is deleted and everything imports
  `src/shell/ApproveDialog.tsx`. **The CSS:** `src/styles.css` holds only what is rendered (the
  tokens, the base, the shell, Home and Ops, the kit): 3,609 lines, from 5,629. The Classic page
  rules and the console's stopgap for their classes are gone, each selector checked against every
  class the source can render; KeyValue's small-capital labels and bold values, which came from the
  Classic `dt`/`dd` rules, are the kit's own now, and a bare link is drawn in `--link` everywhere.
  **Kit fixes** that pages had patched for themselves: a tab's hidden status label no longer
  widens a phone's page, and a sheet's body, a select and a code block keep to their width; the
  patches in Backups and Storage are removed. On a primary (amber) button the medium tier's mark
  was a hollow box (amber on amber, ringed); it is a solid bar in the button's ink, light and dark.
  **Promoted to the kit**, with tests and a place in the gallery: `AppIcon` (the app colour square
  Catalog, Performance and Home each drew), `CopyButton` (Settings' and Storage's copies, and the
  unused Classic one), `MetricStrip` (the figure strips of Ops, Performance, System and Updates)
  and `Facts` (the mono facts line of Activity, the notifications, the approval dialog, Settings and
  `PageHeader`). Setup's profile squares stay Setup's: larger, shadowed, a profile's rather than an
  app's. Agents (M37), merged meanwhile, uses them too: Usage's figures are a `MetricStrip`, the
  templates' and the trace's facts lines `Facts`, and the webhook's one-time URL a `CopyButton`;
  an overview of another shape is said on the page rather than failing it. A button inside a mono
  row (a console table's cell, a line of facts) is drawn in the UI's face now, like every other.
- The owner wants every concept from the study (2026-09-28): the assistant (B5) is M34; the phone
  layout (B6) is M25; recipes and a GPU page (B7) belong to M22.

Guardrails: the risk tier shows on every action, not only in the dialog; the demo scenarios
(`?scenario=fresh`, `?scenario=trouble`) and `npm run demo:sweep -- --deep` keep passing for every
new page; no personal host data in mockups or fixtures.

## M34 — The local assistant

Asked for 2026-09-28: a local AI that learns BoxPilot and this server, helps solve problems, and
writes notes and documentation. It is the study's Copilot direction (B5), and it absorbs M24.3.

Guardrails, before any feature: it runs only on a local model (the catalog's Ollama on this box, or
an address on the owner's network), and nothing is sent to a cloud service. Its context is built
with the asker's role (ADR-003, M29.4) and secrets are masked by `secretPaths` (M29.1), so it can
never tell someone what they could not read themselves. It never runs commands: what it proposes
is a plan made only of registered operations, each approved at its own tier through the ordinary
job path. Every answer names what it was drawn from - a document, a job, a log line - so a wrong
answer can be caught. On a CPU a small model works; the GPU (1.119.0) makes it quicker.

- ✅ **M34.1 What it knows** (unreleased): `server/assistant/knowledge.mjs` indexes `AGENTS.md` and
  `docs/*.md` cut by heading (pieces of at most 1,200 characters), one chunk per registered
  operation (id, title, tier, read-only or not, who may run it, parameter names and types) and one
  per catalog manifest (name, description, ports, notes). It lives in memory, is built at startup
  and is rebuilt when the catalog's manifests change. Retrieval is BM25 always; when the model
  server has an embedding model (`nomic-embed-text` and the like) the question and its best keyword
  matches are embedded, the rest of the index in the background while nobody waits for an answer,
  cached by content hash and model, and the two rankings are fused. `docs/INVENTORY.md` and
  `docs/VIRTUALIZATION.md` are labelled older and weigh less. The server's facts are read at
  question time as the person asking (`facts.mjs`): failed jobs with their error and last log lines
  (the owner's context holds every account's, anyone else's only their own), the health-alert
  ledger with another account's entries cut back to their kind (the rule now shared with
  Settings in `access.mjs`), installed apps and their containers, disk use and SMART, and backups
  without who took them; an app's container log only for an operator (ADR-003). Job parameters are
  masked by `secretPaths`, and a job of an unregistered type carries none.
- ◐ **M34.2 Ask** (unreleased): `POST /api/v1/assistant/ask` takes `{ question, context?: { jobId,
  alertKey, appId } }` and answers `{ answer, sources, plan, model, degraded, citations, notes }`,
  as server-sent events (sources, the answer as it is written, the result) when the page asks for
  `text/event-stream`, as JSON otherwise. `GET /api/v1/assistant/status` says whether a model
  answers, which one, and how big the index is; `PUT /api/v1/settings/assistant` (the owner, with
  the password) sets the model server's address and the models. Only a local model: the catalog's
  Ollama when it is installed, or an address the owner gives that is loopback, private, link-local
  or on the tailnet, checked when saved and before every request, redirects refused. Every piece
  of context goes through the redactor after `secretPaths`; secrets planted in parameters, an
  app's env, logs, errors, alerts and documents are tested never to reach the prompt. The model
  cites sources by id; ids it made up and sentences with no source come back with the answer. A
  plan is registered operations only, each checked against the registry (it exists, its parameters
  pass, the asker could approve it, it carries no secret) and returned with its title, tier and
  the request that would stage it; nothing is staged or run, and a viewer gets no plan. Bounded: a
  2,000-character question, a 24,000-character prompt, a 12,000-character answer, two minutes, and
  one answer at a time per account; the audit trail records who asked, how many sources, the
  outcome and how long it took, never the question or the answer. Viewers may ask (the role
  policy's one other read-only POST), and `route-matrix.test.mjs` checks the model's prompt for
  every role as it checks a response. With no model, the answer is the sources it found.
  The command bar (M33.2) asks it, as JSON for now rather than the stream. Remaining: a Settings
  panel for the address and models.
- **M34.3 Guided troubleshooting** (was M24.3). From a symptom - a failed job, a health alert, an
  app that will not start - it runs the read-only checks BoxPilot already has and explains the
  cause from their evidence rather than from general advice.
- ✅ **M34.4 Documentation of this server** (unreleased): *Repair Center → Document this server*,
  beside the recovery kit. `server/runbook.mjs` turns facts into Markdown, pure and with the clock
  passed in; `server/runbook-service.mjs` gathers the facts from reads BoxPilot already makes (the
  host inventory, the network topology, the drives, the helper's app, backup, Serve, firewall,
  snapshot and Samba reads, and its own records), masking every stored parameter set with
  `secretPaths`/`maskSecrets` first. Eight sections: this server; each app's image, ports and who
  can reach them, data folders and their drives, where its sign-in is kept and its backups;
  storage, with what each drive holds, SMART and auto-reconnect; network and firewall; backups and
  the second copy; automation; how to restore, numbered, naming each registered operation and
  what approving it takes; and the issues open right now. A fact that could not be read says
  unknown and why. Generating it needs an operator (ADR-003); downloading the full copy, which
  names where the second copies are kept and carries every account's schedules and alerts, is the
  owner's, like the recovery kit. Each download keeps a fingerprint per section - what is where,
  not what it is doing this minute - and the page says "out of date since" the first layout
  change BoxPilot recorded after it (a completed install, mount, firewall or exposure job, a
  schedule, destination or firewall-profile change, a new version), from SQLite alone; a preview
  names the sections that differ, which also catches changes made by hand. Remaining: the model's
  prose pass, once M34.1 has a local model.
- **M34.5 Notes.** A note drafted after an incident (what happened, what fixed it), attached to the
  app or drive, which the owner can edit and which the assistant reads next time. Off by default.
- **M34.6 Learning the platform.** Later, with LLMCoach: a model tuned on BoxPilot's documents and
  registry, evaluated against the stock model before it replaces it.

## M35 — Repair that fixes

Asked for 2026-09-29: "Repair should be revamped to actually work with click of the button fixes."
On the owner's server (2026-09-28) Reconnect the drive was refused four times as busy and told the
owner to stop things by hand; "Nothing BoxPilot notices can reach you" said only "set a target"
while ntfy ran on that very server; two apps without a recent backup and six apps with no container
had nothing to press; and a refused reconnect stayed on Home as a failure. The rule now: a finding's
fix does everything needed to succeed, or the finding says exactly why it cannot and the one thing
the owner does. Approvals and tiers are unchanged: every fix is an ordinary job at its own tier.

- ✅ **M35.1 Every detector audited** (unreleased): a finding carries `fixes` (the first is `fix`),
  and each preview names the apps it stops and the shares it disconnects. `manual` is left for what
  no operation can do: a cable (a flaky USB drive), a choice (apps split across drives, which is
  often deliberate), and somebody else's folder, which BoxPilot does not take over. The table of
  each detector before and after is in the PR.
- ✅ **M35.2 Reconnect through the busy pipeline**: `storage.remount` checks the drive is connected
  before anything stops, stops the containers with the folder bound, closes Samba with the
  close-and-retry loop, unmounts in PID 1's namespace (a dead mount lazily, a healthy one never),
  mounts again, proves it reads and is writable, and starts the apps. A fresh mount that is still
  read-only is said, not called fixed; a drive that will not mount leaves the apps stopped so they
  do not write into the empty folder. `tests/ubuntu/drive-shutdown-order.sh` 7f and 7g remount a
  busy drive (an app and a Samba client) and a read-only one on real systemd.
- ✅ **M35.3 Permission fixes that make the change**: `storage.writable` adds the apps' uid/gid to an
  exFAT/FAT/NTFS drive's fstab entry and reconnects it (fstab copied, verified, put back if the
  drive will not mount); `samba.share.writable` hands a root-owned share folder (not its contents)
  to the apps' user and applies the shares so the share writes as them; an app's root-owned folder
  is handed over by a redeploy, one on an exFAT drive by the drive's fix.
- ✅ **M35.4 Alerts to the ntfy on this server**: `notifications.ntfy.connect` (high, the owner's,
  the same password Settings asks for) makes a topic nobody can guess, sends a test from this
  server, and the web service saves the target once ntfy accepted it. Refused when a target is set.
  "Fixed" then says how to subscribe in the ntfy app on a phone: the address over Tailscale (Serve's
  HTTPS when it publishes the port, the short MagicDNS name otherwise) and the topic. With ntfy
  stopped the finding offers Start; without it, Install.
- ✅ **M35.5 Backups due**: one finding for every app with data and no backup in 14 days, with
  Back up now (`app.backup`, or `app.backup.many` for several, one job) and Back up nightly (a
  schedule for each app without one, spread 02:00-04:00).
- ✅ **M35.6 Apps the clean-up removed**: the nightly "Clean up Docker disk space" ran `docker system
  prune`, which deletes every stopped container, so every app the owner had stopped was gone by
  morning (the prune itself is fixed in #312). Each such app now says what happened ("Plex was
  removed by the nightly clean-up; your data is intact"), with the stop and the clean-up as its
  evidence, and comes back in one click: **Recreate (stays stopped)** (`app.reinstall` with
  `start: false`, `docker compose up --no-start`) for an app stopped on purpose, which keeps its
  stop on record; **Start** otherwise, since `app.action` start now builds a missing container
  again from the saved compose project (`app.reinstall` when that file is gone too, from the saved
  settings on the image it last ran); or **Uninstall** (data kept).
- ✅ **M35.7 A page that fixes in place**: the whole page is the Command Center console, built from
  src/ui alone (a new `Panel`, the console panel Ops draws) with its styles beside it in
  `src/repair/repair.css`; no old panel, page header or feature strip is left, and the checks
  below the findings (prerequisites, approval desk, helper, resources, installation, packages,
  protection gaps, rebuild checklist, runbook, Activity) are console panels too. Findings worst first, each
  fix with its tier on the button, approved in the ordinary dialog, its log streaming in the
  finding's card, and the scan read again when it ends: "Fixed" with what changed, or "Still there"
  with the job's own error and the next step. The last failed try shows on its finding, whose fix
  becomes Try again.
- ✅ **M35.8 Fix the safe ones**: every low-risk fix, listed in one confirmation, run in turn; each
  is still staged, approved and audited on its own, and the batch stops at any job the server wants
  more than a click for.
- ✅ **M35.9 Dismiss, with a reason**: a finding set aside moves to Dismissed and leaves Home, and
  comes back by itself when what it says changes. A critical finding is never set aside.
- ✅ **M35.10 Failed jobs**: Try again (with more time for one that ran out of it) and Dismiss, which
  sets M36's own "dismissed" mark on the job (`POST /jobs/:id/dismiss`), the one Activity reads; a
  failure drops off as M36's `failureSettled` says (dismissed, re-run, or the same operation tried
  again), or once Repair shows it on its finding or that finding is gone.
- ✅ **M35.11 Home and Ops offer the same fixes**, from the same runner, and say "Fixed".
- ✅ **M35.12 Ports something else holds** (unreleased). On 2026-09-29 Repair's Start for Dockge
  rebuilt its container and Docker failed with "address already in use": Dockge was on the home
  network (`0.0.0.0:5001`) and Tailscale Serve published it at the same port, so tailscaled held
  `100.x.y.z:5001`, and on Linux a publish on every address fails beside any one address holding the
  port. Serve now fronts only a port bound to 127.0.0.1 ("Tailnet only"): `app.serve.set` refuses an
  app published on every address, `app.exposure.set` withdraws Serve before putting an app on the
  home network (and serves it again if that fails). Publishing the LAN side on the host's LAN
  addresses was rejected (a DHCP change or a slow network at boot leaves the app unable to start,
  and a second NIC, a VM bridge or IPv6 each need their own entry), and so was serving on another
  port (the HTTPS address moves, every page matches Serve to an app by port, and the new port is a
  trap for the next app published there). Start, restart, reinstall, install, reconfigure and update
  check the host's listeners before `compose up` (root task `host.listeners`: `ss -p`, since the
  helper has no network of its own) and name the holder: Tailscale Serve and the app it publishes,
  another app's container, or a process. Repair finds the trap on running apps too, and offers
  **Serve it only through Tailscale**, **Stop serving it on the tailnet** (which starts it), or
  **Move it to port N**. A failed job no longer leaves `apply` running. The demo showed Immich and
  Vaultwarden in the same trap; `server/serve-audit.test.mjs` holds the catalog to it and
  `tests/ubuntu/port-preflight.sh` proves the check on a real host.

## M36 — Value and quality of life

Asked for 2026-09-29: "Look for value. Look for usability. QoL." Started from what the owner hit on
the real server that week, then from reading every page in the demo, light and dark, at desktop and
phone width. Repair itself (its findings and fixes) is M35's, and stays out of this milestone.

- ✅ **M36.1 A database copy before every update** (unreleased). `scripts/boxpilot-upgrade.sh`, and
  so the System page's update (`system.update` runs it), copies the database after the build and
  before anything stops: a read-only open, `VACUUM INTO /var/lib/boxpilot/boxpilot-rollback-<old
  version>-<UTC stamp>.sqlite3`, `PRAGMA integrity_check`, then the live file's owner and mode
  (0600; made under `umask 077`). A copy that cannot be made stops the update with the reason and
  nothing swapped; a rollback names the copy that matches the old code and how to put it in place.
  The System page reads the update's own log while it runs, so a refusal shows at once, and names
  the copy the last update took. Copies are never deleted by an update: *System → Database copies
  from updates* lists them with a rule (keep the newest N, and any younger than D days) and exactly
  which go; `housekeeping.database-copies.remove` (medium, owner only) deletes only the listed names
  the rule still lets go when it runs, and copies from before 1.127.0 are marked as possibly holding
  passwords. `tests/ubuntu/upgrade-db-copy.sh` upgrades a real install three times in the install
  smoke test: into a full disk (refused, nothing moved), normally (the copy exists, 0600, intact,
  taken before the stop) and with a failing health check (rolled back, the copy named). The copy
  starts with the first update *from* the release that has this, since an update runs the installed
  version's script. The System page's update and reclaim buttons now show their tier. **One upgrade
  at a time**: two started two seconds apart on the owner's server (two previous trees, two copies,
  the service started twice). The script holds `/run/boxpilot-upgrade.lock` (flock) for its whole
  run and writes who holds it; a second run refuses at once, names the first and changes nothing, and
  the System page's update checks the same lock and fails its job with the same words. The smoke test
  starts two at once.
- ✅ **M36.2 Approvals nobody will give** (unreleased). Two updates staged for 1.116 waited three
  weeks for approval on a server running 1.138. An operation can say when a staged job is
  superseded (`supersededWhen`; `system.update`: a version at or below the running one); such a job
  is cancelled with that reason when someone tries to approve it, at startup (right after an update
  lands) and hourly. A job nobody approves in seven days is cancelled too, and the owner is told once
  (`approval.lapsed` notice). Activity approves a staged job through the ordinary dialog at its own
  tier (the dialog can now open an existing job and leaves it waiting when closed), cancels it, or
  dismisses a failure; Home and Ops open a waiting or failed job there. Home's and Ops' "Waiting for
  approval" row has *Review*, which opens that job in the same dialog at the tier it was staged at
  (Ops files it in its inbox by that tier); a viewer, or an operator facing an owner-only job, sees
  no button.
- ✅ **M36.3 Signed out after an update** (unreleased). Sessions live in the database and survive a
  restart (now proved by a test across two store instances); what ended the owner's was the
  twelve-hour sign-in, and the page went to sign-in without a word. The browser remembers only when
  its session ends: the sign-in page says whether it ran out or was ended elsewhere, and names the
  page signing in returns to (the address keeps it). A request that finds no session sends the page
  to sign-in the same way instead of leaving it red. Signing out on purpose says nothing.
- ✅ **M36.4 Failed jobs that were dealt with** (unreleased). Home's and Ops' failed-job item skips a
  failure that was dismissed, run again after a restart, tried again with more time, or followed by
  a completed, running or staged run of the same operation on the same subject; after a week
  Activity keeps it and Home lets it go, and Home counts the other open failures. Dismissing
  (`POST /jobs/:id/dismiss`, its creator or the owner) adds a step to the job, which stays failed in
  Activity as "Failed, dismissed". Repair's own failed-job findings are M35's.
- ✅ **M36.5 SMART checks leave sleeping drives asleep** (unreleased). Every read passes `-n standby`;
  a sleeping disk is recorded as asleep, never asked again through its USB bridge, keeps the health
  and time of its last reading, and holds a failing disk's alert rather than resolving it. The
  Overview says "asleep, not read" with the last reading.
- ✅ **M36.6 The command bar acts** (unreleased). "Back up Immich", "Restart Plex", "Stop", "Start",
  "Resume", "Update", "Check for updates", "Install all updates", "Back up BoxPilot's database",
  "Reboot the server": each an operation the role may start, with its tier in the list, through the
  ordinary approval dialog. A quick backup is offered only for apps that keep data worth one (the
  catalog summary now says so per volume).
- ✅ **M36.7 A notification centre** (unreleased). A bell in the top bar counts what is new; its panel
  lists what BoxPilot said in the last thirty days (at most a hundred): conditions raised and when
  they cleared, news, failed jobs pushed, each with when, whether the target took it (sent, not sent
  for want of a target, sending failed) and a way to its page or its job in Activity. The record is
  `server/notification-history.mjs`, written by the ledger and the failed-job push; a retry is the
  same entry. Read-only apart from "Mark all seen", each account's own. Another account's job,
  schedule or sign-in is cut back to its kind. Home's "could not tell you" item opens it.
- ✅ **M36.8 Back up an app from Backups** (unreleased). The list of apps and their last backup had
  only "Schedule it"; each row now has *Back up now* (medium).
- ✅ **M36.9 Apps whose data is in a sidecar count as having data** (unreleased). Whether an app
  keeps anything an app backup archives looked only at the app's own volumes, so Immich (its
  library a host folder kept out on purpose, its database in the postgres sidecar, which every
  backup does archive) counted as "nothing to back up" and was never reported as unprotected.
  `keepsBackupData` (`server/catalog/schema.mjs`) counts sidecar volumes too; the catalog summary
  carries it as `keepsBackup`. After updating, Home may name such an app as never backed up.

Proposed, value to the owner against effort:

- **Say before the twelve hours are up** - medium, small: a notice ten minutes before a session ends,
  so a half-typed form is not lost to the sign-in page.
- **A weekly read of a drive that is always asleep** - medium, small: wake it once a week so its SMART
  health is not unknown for months. Wakes the drive, so the owner's call.
- **Suggest actions in an empty command bar** - medium, small: what is waiting for approval, the
  failed job to retry, the update ready.
- **Activity filters** (failed, waiting, running) and search - medium, small to medium.
- **A Home item when old database copies pile up** - medium, small: points at the copies panel when
  copies from before the secret scrub are still on disk.
- **Restore a database copy as an operation** (high risk, stops BoxPilot) - medium, medium to large;
  today it is the three manual steps the rollback prints.
- **Hold the update button while jobs run** - low to medium, small: the approval already refuses;
  the button could say so first.
- **Fold "What you can do" into the page header** - low to medium, small: the strip on every Classic
  page explains rather than does. A design call for the owner.
- **Quiet hours or a daily digest for pushes** - medium, medium.
- **Update every app with an update ready, in one approval** - medium, medium.

## M37 — Agents

Asked for 2026-09-29: "create a section for building agents. I want it robust. I want you to put in
suggestions and act on them. But I want an agent builder." Decided in ADR-005. The owner's standing
requirements, before any feature: **agents never make the server run hot** (hard caps the kernel
enforces, not promises), **everything can be paused** (one agent, or all of them with one switch,
"until tomorrow" included), **agents propose and never act** (a plan of registered operations,
checked against the registry and the person, approved step by step at each step's own tier through
the ordinary job path), **local models only, on Unsloth** (not Ollama), and **privacy** (Pi-hole and
network data as network-wide counts; secrets masked; the audit trail says who, what and when, never
the content). The engine is `feat/m37-agents-engine`; the section is `feat/m37-agent-builder-ui`.

- ✅ **M37.1 What an agent is** (unreleased). `server/agents/spec.mjs`: a name, a purpose, the owner's
  instructions (a system prompt below BoxPilot's own rules), who may ask it (owner, operator, and
  viewers for a helper someone can borrow), its knowledge sources, a permission per catalog tool
  (auto, only when a person asked, off), its triggers (asked; a schedule - hourly, every six hours,
  daily, weekly - that waits for quiet hours when heavy; events: a health alert raised, a job failed,
  a drive dropped), its budget (runs a day, model seconds a day, steps, tokens and seconds a run, each
  under a ceiling no spec can lift), its outputs (notes, a daily digest, notifications - important
  only - and approval cards) and its memory (on or off, how long a note stays fresh, how many).
  `normalizeSpec` refuses anything it does not know rather than guessing. Stored in BoxPilot's own
  database (`server/agents/store.mjs`), so a controller backup carries it; every edit that changes
  something is a new version with a field-by-field diff (the instructions line by line), and a roll
  back is a new version too. Five templates (`templates.mjs`): **Server Keeper** (the resident agent
  that learns the server, answers questions and writes a digest at 05:30 in quiet hours), **Pi-hole
  Watcher**, **Backup Auditor**, **IT Support helper** (viewer-level tools only, no notes, no plans,
  anyone signed in may ask it) and a blank one, each with golden questions for its evaluation.
- ✅ **M37.2 The tools catalog** (unreleased). `tool-catalog.mjs` and `tools.mjs`, fifteen tools (M37.7 brought them to twenty-five), each
  with a cost and the least role a run must read as: server facts, apps and containers, service
  status, bounded logs (at most 200 lines, a week back; an operator read, ADR-003), storage and SMART,
  search over the docs, the registry, the catalog and the owner's documents, the agent's own notes
  (read, write), BoxPilot's jobs and health alerts as the run's person may see them, backups, the
  **Pi-hole adapter** (`pihole.mjs`, the registered read `app.pihole.inspect`, operator: blocking on
  or off, queries and blocked in the last day, the blocklists' age and size, each upstream's share and
  answer time, the most blocked domains as totals; no query reads the client column), **where does it
  run** (a BoxPilot app, another container, or a systemd unit on the host), **propose a plan** and
  **tell the owner**. Only notes, cards and notices are written; nothing on the server. **Tool output
  is data**: redacted, stripped of chat-template tokens and our own tags, boxed as untrusted with a
  line saying so, and text that reads like an instruction is flagged in the trace, in the box the
  model sees and on any card proposed after it (`guard.mjs`).
- ✅ **M37.3 The runner** (unreleased). `runner.mjs`, `runner-main.mjs`: a small loop - plan, call
  tools, answer - under limits on steps, tool calls, tokens, model time and wall time; one run at a
  time for the whole server, one question at a time per person. It runs in
  `deploy/boxpilot-agents.service` and reaches the web service only on `/api/v1/agent-runner/*` with
  a scoped key (`access.mjs`, `agentRunnerAuth`: loopback only, never through a proxy, handed over by
  systemd's `LoadCredential`; the route matrix proves it opens nothing else), never the root helper.
  Every tool runs in the web process as the run's person. Every run keeps its trace - each step, each
  tool call with its input and its (redacted) output, the model's words, tokens and timing - which a
  page follows live as server-sent events. Idle is a long poll: no busy loop. Unsloth frees the
  model itself after 15 quiet minutes, and the runner stops the whole model server after the owner's
  idle time (an hour unless changed, five minutes to twelve hours), so idle is then no process at all.
- ✅ **M37.4 The runtime** (unreleased), built to the Unsloth spike
  (`docs/spikes/2026-09-unsloth-headless.md`, PR #316). Unsloth runs as the runner's own child, in
  its cgroup and under its caps: a systemd unit, not a container or a catalog app (ADR-005 says why).
  `server/agents/runtime.mjs` starts the spike's command on demand - `unsloth run --model
  <repo:quant> --api-only --disable-tools -H 127.0.0.1 -p <port> --context-length 8192 --parallel 1
  --threads 4 -c 8192 --ctx-checkpoints 4 --batch-size 512 --cache-ram 1024` (four threads since M37.8; the
  spike's was one) - offline (`HF_HUB_OFFLINE=1`), with
  `UNSLOTH_MODEL_IDLE_TTL=900`, `UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK=1` and
  `UNSLOTH_STUDIO_PASSWORD` set to a secret the runner keeps (0600) in place of the admin password
  Studio would generate and print. `--disable-tools` is mandatory (Studio's server-side Python, shell
  and web search are on by default for every bind); `-c 8192` is passed through to llama-server
  because Unsloth's idle reload forgets `--context-length` and relaunches at 262,144 tokens, which the
  memory cap kills. The key Studio mints is read from its "API Key:" line (or its auth folder), sent
  on every request, never logged; lines carrying a key or a password never reach the log tail. Every
  request names the model (the repo), and Qwen's thinking is off (`enable_thinking: false`). Stopping
  the server stops its whole process group, Studio's llama-server with it. Unsloth is installed into
  the runner's state (`/var/lib/boxpilot-agents/unsloth`) by its own installer, GGUF-only
  (`UNSLOTH_NO_TORCH=1`, `UNSLOTH_SKIP_AUTOSTART=1`), as the runner's user, with `libgomp1` as a
  package of its own; root runs nothing from there and writes nothing there. Models are downloaded as
  the runner's user too (`scripts/boxpilot-agents-download.mjs`, started by the root task with
  `runuser`), and the helper's reads only follow links that stay inside the cache's blobs.
  Registered operations: `agents.runtime.install` (medium, owner; the installer's SHA-256 and the
  release it installed are kept, and the Agents section says when that is not 2026.9.12, the one
  measured), `agents.runtime.enable` (medium, owner), `agents.runtime.disable` (low),
  `agents.model.download` (medium, owner: Unsloth's Qwen GGUFs only, every byte checked against
  Hugging Face's SHA-256, space checked first; the preview gives size, time and memory),
  `agents.model.switch` (medium, owner), `agents.model.remove` (medium, owner; never the model in use)
  and the read `agents.runtime.inspect`. The model library (`models.mjs`) holds Qwen 3.5 4B (the
  default: 4.2 tokens a second at one processor, about 8 at four threads since M37.8, 6.2 GB with its files), 2B (8.3 a second at one processor, 3.7 GB)
  and 9B (2.3 a second at one processor, 10.7 GB: more than the cap, not recommended), all UD-Q4_K_XL with the F16
  vision projector, each 5 of 5 on tool calls and right on the chart in the spike. A daily look at
  Hugging Face finds a newer small Qwen with vision and offers the download and the switch as a card,
  never on its own. A `llama-server` driver runs llama.cpp's own server from the same install with no
  Studio layer, for the owner to choose (ADR-005). All model clients are one pluggable
  OpenAI-compatible client (`assistant/model-client.mjs`) under M34's local-only address rules; for
  agents, loopback only. The assistant uses it too; Ollama's own API stays as a legacy provider.
- ✅ **M37.5 The Agent Builder** (unreleased, the stacked UI pull request): the Agents section in the
  Command Center's look (`src/pages/agents/`), in seven tabs. **Agents**: the module switch, pause
  all, until tomorrow and the kill switch, each agent's last run and budget, and the cards waiting in
  their three kinds - a plan to stage step by step at its own tier, a question the agent asked back,
  and a matter it hands the owner. **Build**: templates and import from a file, then the seven steps
  (its job and success criteria with scope warnings; what it is told; data and tools, each tool's
  permission and the allowlist; when it runs, with its webhook; guardrails and escalation; memory;
  its team), versions with line diffs and rollback, and export. **Test**: ask or run once, the live
  trace with the intent and plan open, a hand-off's runs as one tree, "Was this right?", and the
  cards the run proposed. **Memory**: how it recalls, the facts it learned (edit, pin, forget),
  facts other agents share, what past runs found, and the conversation, each forgettable.
  **Knowledge**: the sources, the owner's documents (upload, paste, pin), outside data (a folder,
  web search, Notion, Slack; each saved with the owner's password, a sync staged at its tier) and the
  learning passes. **Usage**: the runner against its caps, the day's budget for all agents and each,
  the runtime and model library, and the settings. **Evaluation**: the success criteria, golden
  questions, the latest result and accuracy over time by version and model. Small entries on Home
  and Ops, in the dock and in the command bar. The demo's default world shows each of these: a
  hand-off tree, a question and an escalation card, thumbs up and down, and a shared note.
- ✅ **M37.6 Safety and robustness** (unreleased). An audit entry for every run (`agents.run.finished`:
  who, which agent and version, how it ended, tools, model time, tokens; never the question or the
  answer) and for every change to an agent, a card, the module and the runtime. Redaction of
  questions, tool output, notes, the model's words and tool arguments before anything is kept or
  sent. Rate limits (questions an hour a person; the runner's calls). The kill switch (cancels what
  waits, stops what runs, tells the runner to stop its model; only the owner starts agents again).
  A model that is missing, failing or slow still gives an answer: the tools' facts, marked degraded.
  Timeouts on every model call, every tool, every run. Crash recovery: a run whose runner stopped
  answering, restarted or was cut off by a BoxPilot restart is marked interrupted and never retried.
  Backpressure: at most twenty runs waiting and two per agent; unattended runs past that are dropped
  and counted, a person is told to try later. Tests for each limit (`limits.test.mjs`), and a
  real-systemd test (`tests/ubuntu/agents-caps.sh`, CI job `agents-caps` on 24.04 and 26.04): under a
  fake model burning three threads the service's cgroup stays at or under its quota and was throttled
  to stay there (the shipped `CPUQuota=400%` is checked in the unit; GitHub's four-processor runners
  cannot reach it, so the test lowers the running unit's quota to 200% first), the model server is its niced, idle-I/O child, and afterwards the service
  idles under 2%.
- ✅ **M37.7 The owner's components** (2026-09-29, unreleased): what the owner said an agent builder
  and an orchestrator must have, each mapped to BoxPilot and built into the engine, and shown in the
  Agents section (M37.5).
  - **The brain.** ✅ Intent, then plan, then act (`intent.mjs`, `runner.mjs`): a request, a schedule,
    an event or a webhook is first turned into a structured intent (goal, subject, constraints, the
    tools needed, a confidence) and a plan of at most six steps, returned as JSON against a strict
    schema (`response_format`, which Unsloth honours), checked (only offered tools, bounded text) and
    kept in the trace as intent and plan steps; the plan is then the model's steps. ✅ Ambiguity is
    a clarifying question, which becomes a question card; the run stops there instead of guessing.
    ✅ Thinking stays off on the CPU (the spike's 4B spent 1,500 tokens thinking and never answered)
    and an agent may turn it on for hard tasks, within its budget (`model.thinking`).
  - **Memory.** ✅ Short-term: a conversation per agent and person, the last turns word for word and
    older ones folded into a running summary, sized to leave room in `-c 8192` (`memory.mjs`). ✅
    Long-term: facts the agent learned (shared with other agents when the writer allows, each only as
    far as the reading run may read), episodes (what past runs found), and knowledge the owner pinned
    (facts and documents), with provenance and freshness. ✅ Embeddings as BLOBs of 32-bit floats in
    SQLite, brute-force cosine, fused with BM25 by reciprocal rank (hybrid retrieval); a query's
    embedding is made by the runner where the model is. ✅ Embeddings come from Unsloth's own
    `/v1/embeddings` (bge-small-en-v1.5, downloaded with the chat model because the runner is
    offline); an index run embeds what is new in quiet hours, within the day's budget. ✅ The owner
    sees each tier, edits a fact (its words, freshness, pinned, shared) and makes an agent forget a
    fact, an episode or a conversation; forgetting deletes the row and its embedding, overwritten
    on disk (`secure_delete`). ◐ Qwen3-Embedding-0.6B as a second capped llama-server: the spike's
    stronger option, not wired; bge-small first.
  - **Tools.** ✅ A registry with categories, typed schemas, permissions and costs (`tool-catalog.mjs`,
    25 tools): BoxPilot's reads; its records through its API (`records.query`: jobs, schedules,
    automations, backups, as the run's person; never SQL); app adapters (Pi-hole first); exact work
    - `calc` (its own parser, never eval), `time.calc`, `units.convert`, `json.extract`, `regex.match`
    (in a worker stopped after half a second) - so the model never does sums in its head; documents
    (`docs.search`, `document.read`); memory; actions that only propose; orchestration. ✅ Web search,
    off by default: only through the owner's own SearXNG on this network (the catalog has it), never
    a cloud API, and its results are boxed as data like any tool's. ✅ Outside data: PDF upload (a
    dependency-free reader: Flate streams, object streams, ToUnicode maps), Markdown and text; a
    folder on this server looked at in quiet hours; read-only Notion and Slack with a token saved as a
    named credential, read inside a root task (`agents.connector.sync`, low risk, owner) so the web
    process never holds it. Each is off until the owner turns it on; `connectors.mjs` is the
    interface to add more. ✅ Real-world actions only as cards through the approval path. ✅ Webhooks:
    an agent can be started by one (`/api/v1/hooks/agents/:id/:token`, the flows' door: the token is
    the auth, only its digest is kept, nothing from the call reaches the run), and can propose an
    outgoing one as the registered `http.request` step, so n8n and the like interoperate.
  - **The builder's steps** (✅ the API, ✅ the Build tab's seven steps): one job and its success
    criteria, with warnings when the scope reads like "do everything" (`scopeWarnings`); a
    structured system prompt - rules, operational steps, an output format (text, or JSON with named
    fields the answer is checked against), what to escalate - prefilled by the templates and versioned
    with line diffs; knowledge sources and tools with their permissions and costs; then test and
    guardrails.
  - **Testing and oversight.** ✅ The console's trace holds the intent, the plan, every tool call and
    output, memory reads (the recall step) and writes, tokens and time. ✅ Evaluation: golden
    questions scored by deterministic checks, plus the people's thumbs, kept as accuracy over time
    per agent version and model. ✅ "Was this right?" on every run, by whoever may see it. ✅
    Escalation rules per agent: low confidence, a limit reached, an action needed (a card), something
    risky (a card and a notification). Never an action. ✅ Guardrails: limits, redaction, rate
    limits, the kill switch, injection defence for tool and connector output, and an allowlist of the
    apps an agent may look at and the operations it may propose.
  - **The orchestrator.** ✅ A supervisor (the Server Keeper by default) hands subtasks to specialists
    with `agents.handoff`; the specialist runs as the same person, one level down, and the supervisor
    gets a follow-up run with the answers as tool output it cites (`orchestrator.mjs`). ✅ Bounded
    depth (at most 3), three hand-offs a run, no loops (never to an agent already in the chain), no
    hand-off to itself. ✅ Memory shared between agents under their permissions. ✅ One global queue:
    concurrency 1 on the one capped model, a person's live question first, orchestrated follow-ups
    with it, background work last in quiet hours, and one budget across all agents on top of each
    agent's own. ✅ Orchestrated runs are one trace tree. ◐ Events still go to the agents subscribed
    to them; the Server Keeper subscribes to health alerts and hands off from there.
  - **Portable definitions.** ✅ An agent exports as JSON (spec and golden questions; never runs,
    memory or webhooks) and imports as a new agent through the same gate as the Builder.
- ✅ **M37.8 The first real run** (2026-09-29, unreleased; ADR-006). The owner asked Steve (a Server
  Keeper) for the most important issue to focus on, on a Ryzen 7 7800X3D at one thread under
  `CPUQuota=100%`. Qwen 3.5 4B read about 20 tokens a second and wrote about 4: the plan took 110 s
  (1,138 tokens in, 204 out), came back as "1. }, (alerts_active) 2. 2 (storage_health)...", the next
  call - all 22 tools' schemas behind a changed start - hit the fixed 300 s limit before it had read
  its prompt, and the run ended degraded after 416 s with docs.search's roadmap as its answer. Fixed:
  - **Four processors, four threads, 15 minutes** (the owner's decisions): `CPUQuota=400%`, `--threads
    4`, the default longest run 900 s and a day's model time 1,800 s; agents saved at 600 s moved to
    900 s once, as a version noted "BoxPilot raised the time limit to the new 15-minute default".
  - **Prompts built for llama-server's cache.** The planner is a small conversation whose system
    message is the same for every run of an agent; the calls that act are one conversation that only
    grows, with the same tools in the catalog's order every time (`tool_choice: "none"` for a forced
    answer keeps them in the prompt; the "answer now" note ends the last tool round). They carry the
    tools the plan named plus the always-on ones (memory, propose, tell, hand off), at most ten.
  - **Time from measured speed.** llama-server's timings (Unsloth relays them) or the runner's clock
    give the speed; a call starts only if it can read its prompt and answer in what is left, else the
    trace says why; no fixed per-call limit. The speed is kept (`usage.modelSpeed`) and starts the
    next run. A call given up on is closed and cancelled (`cancel_id`), and llama-server gets
    `--batch-size 512` so it stops within 512 tokens, and `--cache-ram 1024`.
  - **The plan**: a bounded schema whose tools are an enum of the offered ones, its shape shown to the
    planner; tools read as registry ids however spelled; a step that is only punctuation or a number
    is named after its tool. A degraded run reads the tools its plan named; docs.search leaves
    BoxPilot's roadmap and decision records out unless asked about building BoxPilot.
  - **Measured.** On the stand-in (`test/agents-bench.mjs`, CI's `bench.test.mjs`: Qwen's template
    rendered, one slot's cache with a hybrid model's checkpoints, 20 tokens a second read and 4
    written), the same question went from 14,390 tokens read over four calls (the first to act 4,039
    tokens and 22 tools, 214 s) to 3,294 (2,067 and 8 tools, 115 s; 4,601 more from the cache), and
    from 378 s to 250 s. On the real model (`agents-bench.yml`: Unsloth and Qwen 3.5 4B started by
    BoxPilot's runtime, under `CPUQuota=400%` at four threads on a four-processor GitHub runner - two
    cores - which read about 15 tokens a second and wrote 6 to 9), the owner's question finished in
    242 to 306 s over three runs: the plan about 50 s, the first call to act about 135 s (2,029
    tokens), then 30 s and less for each later call, reading only what it added (285 and 69 new
    tokens, 2,082 and 2,471 from the cache). Asked again, the plan's 534-token system message came
    from llama-server's prompt cache, and when the plan picked the same tools the first call to act
    did too (1,557 of 2,436 tokens): 163 s. At one thread under 100% on the same runner the question
    took 537 s. The home server's four real cores should be several times faster than the runner's
    two; its own speed is measured on every run.
  - **The Server Keeper's day.** Three questions at one thread used up the template's 1,800 s of
    model time; new Server Keepers get 3,600 s (an hour) for their 24 runs. Agents already saved keep
    theirs.
  - **Starting again.** Unsloth takes `UNSLOTH_STUDIO_PASSWORD` only as the first admin password and
    refuses to start when given it again, so every start after the first failed, silently (the line
    says "password" and was kept out of the log). It is now passed until Studio has one
    (`studio-password.set`), and a start refused that way is tried once more without it.
- **The caps** (`server/agents/caps.mjs`, held to the unit by `caps.test.mjs`): `CPUQuota=400%` (four
  processors since M37.8, the owner's choice: a quarter of a sixteen-thread server at most, only while a
  run goes; the model runs a thread for each, as the spike found best; it was one processor), `CPUWeight=idle`, `Nice=19`, `IOSchedulingClass=idle`,
  `MemoryMax=8G` (the 4B's 2.6 GB plus its 3.6 GB of mapped files, with room; no swap),
  `TasksMax=256`, loopback-only
  networking (`IPAddressDeny=any`), its own user, no capabilities. The unit is installed with the
  others by the upgrade script and stays disabled until the owner turns Agents on; an upgrade
  restarts it only if it runs.

Left, and why:

- **Embeddings on the server**: wired to Unsloth's own `/v1/embeddings` (bge-small-en-v1.5, 101 MB,
  26 ms a text), with the embedder downloaded beside the chat model. Whether Unsloth offline finds it
  in the cache under that name is the first thing to check on the home server; if not, memory search
  stays by words until it does.
- **Pinning Unsloth**: its installer always takes the newest release. BoxPilot keeps the installer's
  checksum and the release, and says when it is not 2026.9.12; a pinned install (or a BoxPilot-built
  image) and a rerun of the spike's workflow before moving is the owner's call (ADR-005).
- **The home server's own numbers**: the spike and `agents-bench.yml` ran on EPYC cores; since M37.8 the
  runner measures the model's speed on the server itself on every run, and the Usage tab can show it
  (`usage.modelSpeed`).
- **Images**: the model reads them, but no tool hands one over yet (a chart of a disk, a screenshot).
- **The 9B model** needs the memory cap raised to about 12 GB and is slow even at four threads: the
  owner's call (a drop-in), not a default.
- **Studio or bare llama-server**: Studio brings tool-call healing and its own idle unload; it also
  brings a 0.4 GB Python process (all of the idle processor), its management API and AGPL-3.0 code.
  llama.cpp's server alone is MIT, idles at 0.00% and starts in about a second; it was measured for
  embeddings, not chat. The driver is there; the choice is the owner's.
- **The command bar's assistant as the Server Keeper**: the bar still asks M34's assistant.
- **Per-device Pi-hole numbers**: only if the owner opts in, as a separate owner-only read.
- **Learning on its own schedule**: a learning pass runs when asked ("Re-learn"), in quiet hours.

## M38 — Agents in Zulip

Asked for 2026-09-29: "Install Zulip... Setup the rooms for the agents so all future agents know
they can report their findings, detail logs, knowledge, a channel for dumping images, documents,
files for training." Zulip over Mattermost and Matrix: fully open source, no cap on history, and
channel plus topic fits agents (ADR-007). The owner's rules stand: agents propose and never act,
nothing leaves the server unless the owner says so, and no account is made with a password.

- ✅ **M38.1 Zulip in the catalog** (unreleased). `catalog/zulip.yaml`: Zulip Server 12.3 from
  docker-zulip's image with its PostgreSQL 14, memcached, RabbitMQ 4.2 and Redis as sidecars, every
  image pinned, every internal secret generated and passed by reference, the database and uploads
  in app backups, a health check, Zulip's own nightly dump off, threaded queue workers.
  - **Tailnet only by default.** Manifests can say `defaultExposure: tailnet`: installed without a
    choice, the web port binds 127.0.0.1 (never every address, #323) and `app.install` publishes it
    with Tailscale Serve; if Serve fails, the install stands and says so, and the Reach tab offers
    "Publish on the tailnet". Zulip's port is 8543.
  - **Its address is the Serve address.** Env values may name `${TAILNET_HOST}`, this server's
    tailnet name, filled in at every deploy (Zulip's `EXTERNAL_HOST` is `${TAILNET_HOST}:${PORT_WEB}`),
    so the phone apps get a valid certificate; an app that needs it is refused, unchanged, when
    Tailscale gives no name. Zulip trusts Serve's forwarded headers from Docker's gateway only.
  - **Create your organization.** Manifests can put `actions` on an app's sheet, each a registered
    operation run with the app's id. Zulip's is `app.zulip.organization.link` (medium, owner): Zulip's
    own `manage.py generate_realm_creation_link`, as the zulip user; refused once an organization
    exists. The registry's new `oneTimeFields` keep the link out of the job's record and log: the
    approval dialog asks `POST /jobs/:id/once` for it, once, and shows it with Copy and Open.
  - **Email and push**: without SMTP nothing is emailed, which the install form and the notes say;
    the SMTP server, user, password, port and sender are optional settings. Phone push is a setting
    that is off, with the steps to register with Zulip's push service; BoxPilot never registers.
  - The demo shows Zulip installed and served; the screenshots take its sheet, the approval for
    Create your organization, and its install form on a new server.
  - **On a real host** (`zulip-host.yml`, run when Zulip's files change or by hand): BoxPilot's own
    deployer and install operation bring it up healthy in about two and a half minutes on a GitHub
    runner, its port on 127.0.0.1 only, answering through Serve's headers as Zulip 12.3; Create your
    organization's link opens the organization form. A minute later it used about 2.6 GB of memory
    (Zulip 2.4 GB, RabbitMQ 150 MB, PostgreSQL 60 MB, Redis and memcached 17 MB) and 3.5 GB of disk
    for its images.
- ✅ **M38.2 Agents talk to Zulip** (unreleased).
  - **Connect** (`agents.zulip.connect`, medium, owner, the approval dialog from the Agents tab's
    Team chat panel): one fixed script (`server/agents/zulip-connect.py`) through `manage.py shell`
    as the zulip user makes a generic bot with Zulip's own `do_create_user`, owned by the
    organization's owner, and four private channels only the owner and the bot are in -
    #agent-findings, #agent-logs, #agent-knowledge, #agent-files - and is safe to run again (it
    reuses the bot, reactivates it if needed, keeps channels that exist and says which are public).
    Chosen over a key the owner pastes: the key never passes through a browser or the web process,
    nothing is made by hand, and running it again repairs. The key goes straight into the
    credential store (`zulip-agents-bot`); a root task checks it with Zulip and says hello in
    #agent-findings. `agents.zulip.disconnect` (low) removes the key; nothing in Zulip is deleted.
  - **Every agent has chat outputs**: findings, logs and knowledge, each on by default, to the
    connection's channel under the agent's name, overridable per agent (channel, topic, on or off)
    on the Build tab's guardrails; templates, new agents and agents saved before M38 all get them.
    Once connected, the system prompt says where each goes, that BoxPilot posts and the agent
    cannot, that approvals never happen in chat, and that #agent-files is data (`chatParagraph`).
  - **The runtime posts, never the model** (`server/agents/chat.mjs`): after a run, its answer or
    digest and its cards (at most two, each linking back to BoxPilot, where it is decided) go to
    #agent-findings, its trace to #agent-logs (a summary; a long trace as an attached Markdown
    file, 48,000 characters at most), and the notes it kept to #agent-knowledge. Every word is
    redacted as the runner's are, stripped of template tokens, and has its @-mentions broken, so an
    agent pages nobody; BoxPilot's own links are added after redaction. An outbox table
    (`agent_chat_posts`) holds at most 200 waiting posts, sends batches of ten through the root task
    (`agents.zulip.post`, low, run by BoxPilot itself like the TLS renewal, on a helper lane of its
    own), sixty posts an hour for all agents, three tries each, and waits while Agents are off,
    paused or killed.
  - **#agent-files into Knowledge**: every three minutes while Agents run (or "Check #agent-files
    now"), the read `agents.zulip.poll` (owner) reads the messages after the last one seen, twenty
    at most, and downloads the files they link: PDFs, Markdown and text through the uploads' own
    reader, images kept as they came (60 at most) - at most 5 MB each, ten files and 12 MB a poll. A
    message of words alone becomes a note. Each is redacted, is data, and is answered in its topic
    ("Added to Knowledge as ..." or why not). An image is described by the model in quiet hours (a
    `describe` run like the memory index's: one image, 320 tokens, within the day's model time),
    and the description becomes the document's text.
  - **The Team chat panel** (Agents tab): installed, connected, the channels and what goes where,
    the last post or error, what came in from #agent-files, counts and, for the owner, the last
    posts; Connect, Connect again, Disconnect, Check now. Links from chat open the run
    (`?view=agents&tab=test&agent=..&run=..`).
  - Tests: the connect operation (key only in the store, safe to run again, what to do first), the
    script parses (Python), channel names and posts validated, lanes; the root tasks against a
    stand-in Zulip API (`test/fake-zulip.mjs`: loopback only, Serve's headers, attachments, the
    poll's limits); the words (redaction, mentions, cards, traces as files); the service end to end
    with the real runner (nothing before Connect, outputs per agent, the outbox's limits, pause,
    failures, disconnect, ingest and acks, an image described in quiet hours); the panel and the
    Builder. `zulip-host.yml` runs Connect twice, posts, and reads back a file the owner dropped, on
    a real Zulip.
- **M38.3 Two-way chat** (specified, not built): a DM or an @-mention of the bot asks an agent, and
  the answer goes to the thread. The owner maps each Zulip user to a BoxPilot account in the Team
  chat panel; a message from anyone unmapped is answered with "you are not set up to ask" and never
  reaches a model. The question runs as that person, read-only, exactly as the Test tab's Ask does
  (their role's tools, their rate limit, their conversation), against the agent named in the
  message or the owner's default (the Server Keeper). The poll that reads #agent-files would also
  read `is:dm` and `is:mentioned` after the last seen id; the reply is an ordinary queued post.
  Cards it proposes still link back to BoxPilot; nothing is approved in chat.

## M39 — Keep the house running when the server does not

Approved 2026-09-29, after the owner's server lost power for 3 h 37 min: Pi-hole on it was the
house's only DNS, so every device lost the internet, and nothing said so because ntfy was on the
same server. Decided in ADR-008. The network half is `feat/m39-network`.

- ✅ **M39.2 DNS that survives the server** (unreleased, `feat/m39-network`). The router becomes the
  one DNS server devices are given, asks Pi-hole here first and a public resolver only when it does
  not answer (ADR-008 weighs a second DHCP server and a synced second Pi-hole). BoxPilot does not sign in
  to the router; it shows the steps and proves the result. `server/dns-resilience.mjs` reads what the
  router hands out from this server's own DHCP lease (networkd's JSON or lease file, NetworkManager,
  dhclient), or, on a server with a hand-set address like the owner's, from who asks Pi-hole
  (`dns.blocker.askers`: its own query database read-only, counts only), asks every other server on
  the list directly with node's resolver (no dig, ping or
  tcpdump), sends a canary through the router and looks for it in Pi-hole's query log
  (`dns.blocker.canary`), and reads the last rehearsal. **Rehearse** (`dns.fallback.rehearse`, medium)
  stops the DNS app for about half a minute behind a three-minute safety timer, asks the router three
  uncached names, starts the app and waits until it answers on the LAN. "If <server> goes down, every
  device on your network loses the internet" is said only on evidence (a lease naming nothing else,
  a failed rehearsal, second servers that do not answer), on Network (a notice, the strip, the
  panel) and on Home and Ops through Repair; an unrehearsed router is "not known yet", with the
  rehearsal as its fix. **Router steps** for GL.iNet 4.x, OpenWrt and any router, addresses filled
  in (`docs/NETWORK.md` too). After a boot that followed an unclean end, the DNS app is asked on the
  LAN and the host through NSS, and both lines go on the outage's record
  (`server/outage-dns.mjs`, plugged into feat/repair-dns-power's `previousBootEndedUncleanly()`).
  `tests/ubuntu/dns-fallback.sh` runs it all against real dnsmasq routers with and without a
  fallback and the runner's own lease, on both LTS releases; `tests/ubuntu/pihole-askers.sh` runs
  the catalog's Pi-hole image asked by eight devices and reads its database as the helper does.
- ✅ **M39.3 Told when the server is down** (unreleased, `feat/m39-network`). An opt-in heartbeat
  (Settings, Notifications): a bare `GET` every few minutes (five unless changed) to a dead man's switch the
  owner picks (healthchecks.io's free plan, or Healthchecks or Uptime Kuma push on another machine),
  which alerts their phone when the pings stop. No body, no header of BoxPilot's, nothing about the
  server. The address is a credential in the root-only store (`heartbeat-url`); the pinging is
  `deploy/boxpilot-heartbeat.timer` and a capability-less oneshot, so a BoxPilot restart does not
  trip the alarm; never retried in a loop. `heartbeat.set` (medium, owner), `heartbeat.test` (low,
  owner), the last ping and the host on the panel. Tailscale has no device-offline alert (its webhooks
  have no such event); a router cron script is documented, not built. `tests/ubuntu/heartbeat.sh`
  runs the units as shipped on real systemd.
- **Later**: sync a second Pi-hole over Pi-hole v6's teleporter API once there is a second always-on
  box; read the router's DNS settings through the existing GL.iNet connection.

## M40 — Agents you can rely on

Asked for 2026-09-29, after the owner's Server Keeper ("Steve", Unsloth with Qwen 3.5 4B at four
threads under `CPUQuota=400%` on a Ryzen 7 7800X3D: 52 tokens a second read, 10 written) answered
"List the drives connected to BoxPilot" in 99 s with "**/dev/sda** (primary drive): 528 GB total, 31%
used". The 528 GB root was on NVMe through LVM; /dev/sda was a 15 TB exFAT drive on USB.
storage.health had said "Root disk: 31% used, 366 GB free of 528 GB. /boot … " and named no device,
so the model filled one in. Asked where Pi-hole runs, it planned `apps.list` over `where.runs`,
twice. The hard caps and "agents propose, never act" stay as they are.

- ✅ **M40.1 Tools that leave nothing to guess** (unreleased, `feat/m40-agents`). Every read tool's
  words are in `server/agents/tool-text.mjs`, one line a thing, its facts on its own line.
  **storage.health** says first which drives are connected - "2 drives connected: /dev/nvme0n1 (NVMe
  SSD, 1.02 TB, the system disk) and /dev/sda (USB drive (spinning disk), 16.0 TB)" - then the root
  filesystem on its drive ("/ (the root filesystem): on /dev/nvme0n1 (NVMe SSD, the system disk)
  through LVM volume … on /dev/nvme0n1p3, ext4, 528 GB in total, 162 GB used (31%), 366 GB free"),
  then each drive (device, attachment, size, model, "The system disk" or "Not the system disk", what
  it holds, SMART) and each other real filesystem (mountpoint, drive and partition under it, type,
  size, used, free). It joins what BoxPilot already reads: lsblk's devices and parents, the root
  scan's mounts, statfs of /, and SMART. lsblk in the web service's sandbox (`PrivateDevices=yes`)
  lists no device-mapper volume, so a mapper root is placed on its LVM2_member (or crypto_LUKS)
  partition; what cannot be worked out is said ("Which drive holds / could not be worked out"),
  never guessed. **apps.list** leads with "BoxPilot apps installed: 12. Running: 10. Stopped or not
  running: 2 (…). Unhealthy: …"; **server.facts** names the OS and its version ("Ubuntu 24.04.3 LTS
  (Ubuntu, version 24.04.3)"); **where.runs** says where in its first line, and that a BoxPilot app is
  not on the host. Descriptions say what each tool is for, and the planner lists that beside each
  tool ("- where_runs: Where does it run?. For: where does X run; is X a container, a BoxPilot app or
  on the host; is X installed"). **The request's own words point at tools** (`toolsForQuestion`,
  patterns in the catalog): "where does X run" is where.runs, "which drives" is storage.health. The
  planner is told after the request (so its system message stays the same bytes for the cache), the
  calls that act carry those tools beside the plan's, and the plan names them when it left them out.
  The demo world's lsblk now lists partitions as the sandbox does.
- ✅ **M40.2 The agent checks itself before answering** (unreleased, `feat/m40-agents`). After the
  model drafts its answer, `server/agents/verify.mjs` holds every claim to the tool output it cites,
  with no model: the devices and paths it names must be in that output, and its sizes and
  percentages must be ones the output gives *for those things* - on the lines whose subject they are,
  on the stretch of a line after they are named, and for a drive on the lines of what it holds -
  within the claim's own rounding (GB read as GiB too). What a claim calls a thing is checked the
  same way: the system disk, USB/NVMe/SATA, ext4/exFAT and the rest, running or stopped. An uncited
  claim is held to every output. A mismatch is corrected by the model once, in a small conversation
  of its own (a fixed system message, the failing claims, only the output's lines about them), when
  that fits in what the run and the day have left (`optional` calls never degrade a run); the
  correction is checked the same way and kept only if better; whatever still does not match is said
  plainly under the answer ("Checked against the tools, some of this does not match what they said,
  so I am not sure of it: …"). A JSON answer is only checked. The trace has a "check" step, the run a
  `check` flag (claims, mismatches, corrected, unsure) the service works out again from what it kept,
  and the Test tab a line under the answer. **Measured**: the text check takes 1 to 3 ms; the
  owner's wrong answer about the drives was corrected in one call of 504 tokens read and 51 written,
  14.8 s at the owner's 52 and 10 tokens a second (`check.test.mjs`), in an 80 s run.
- ✅ **M40.3 An accuracy score that means something** (unreleased, `feat/m40-agents`). **Built-in
  questions** (`templates.mjs`, `builtInEvaluation`), each asked only of an agent whose own tools
  answer it: which drives are connected (graded by `grade.mjs`: every drive named, none called the
  system disk that is not, none given the wrong attachment), how full the root filesystem is, where
  Pi-hole runs (from where.runs' own reading), which apps are stopped, the OS and its version. The
  owner's own questions and expected answers (a fact, or words a right answer holds) join them, and
  one of the owner's about the same fact takes a built-in's place. **Nightly in quiet hours**: one
  agent at a time, at most once in 20 hours, as the person who made it, as background work nobody
  waits on (after learning and indexing in the queue, waiting for quiet hours, stepping aside when
  the server is busy), only when its budget and every agent's have room for its questions at two
  minutes each and still keep half of the day's model time for people; otherwise skipped, and the
  audit says so once a night. An evaluation now plans as a person's question does, since the plan is
  where a tool is chosen. **The Evaluation tab** shows the built-in questions, the owner's, the
  latest result (nightly or asked), accuracy over time (a bar an evaluation, and the table), the
  people's verdicts by day, and **flags a drop** - the latest score more than 20 points under the
  average of the five before, or 25 under the one before - with whether the instructions or the
  model changed in between; the agent list shows "accuracy down to 60%". Sixty evaluations are kept
  per agent. **Thumbs feed it**: a "Wrong" with the words a right answer holds, from whoever may
  change the agent, makes the question one of its golden questions. **Measured on the stand-in**
  (`test/agents-eval.mjs`: the five built-in questions and the owner's own "List the drives
  connected to BoxPilot", each asked of a fresh Server Keeper on a server laid out like the owner's):
  2 of 6 before M40, 6 of 6 after; CI holds it (`evaluation.test.mjs`). **Measured on the real
  model** (`agents-bench.yml`, `mode: eval`, `baseline: main`: Qwen 3.5 4B UD-Q4_K_XL under Unsloth
  2026.9.12, four threads under `CPUQuota=400%` on a GitHub runner's Xeon Platinum 8370C, the same
  questions and graders for both): **2 of 6 before M40 (33%), 6 of 6 after (100%)**. Before, it
  answered the drives question as the owner's server did ("/dev/sda: 528 GB total, 31% used", no
  NVMe), and for Pi-hole and the stopped apps it never called where.runs or apps.list and said it
  could not know. After, each question used the tool made for it, and the check found no mismatch;
  each answer took 100 to 230 s there (run 36656892146).
- ✅ **M40.4 Faster while someone waits** (unreleased, `feat/m40-burst`; ADR-009). The owner's
  decision: **eight processors while a person waits** (their question, the Test tab, a Zulip
  message, and the hand-offs and follow-ups made for one), **four for everything else**. The shipped
  unit keeps `CPUQuota=400%`; when a person's run is handed out the root helper raises the running
  unit's quota (`agents.runtime.cpu`, low, owner, BoxPilot's own: `systemctl set-property --runtime`,
  its own helper lane) and arms a transient timer that puts the background quota back after the
  run's longest time plus two minutes; the web service lowers it as soon as nobody waits (after the
  run, on the tick, after the kill switch, at start). A raise whose timer cannot be set is taken
  back and refused. The model runs a thread per processor, never more than the physical cores, so a
  class change restarts it (a few seconds) instead of oversubscribing the quota; speeds are kept per
  thread count. **Usage** shows the quota set now, and the owner's "Processors while you wait" and
  "Processors in the background", 2 to 8 and never more than the machine's processors less two,
  checked in the web service and again in the helper. Idle priority, idle I/O, the memory cap and
  "no process when idle" are untouched. `agents-caps` raises and lowers the quota with the helper's
  own code on real systemd, with the fake model busy, and watches the timer take it back. **Measured**
  on the real model (`agents-bench.yml`, a four-processor runner on two cores): four threads under a
  200% quota ran at half the speed of two (7.5 against 14.4 tokens a second read, the owner's
  question 436 s against 257 s), which is why threads follow the processors; four under 400% gained
  little over two on that runner's two cores. The gain at eight on the owner's eight cores shows in
  their Usage tab, which keeps speeds per thread count.
- ✅ **M40.5 Talk to agents in Zulip** (M38.3; unreleased, `feat/m40-zulip`, stacked on M40.4). A
  direct message to the bot, or an @-mention of it in any channel it is in, is a question; the answer
  comes back in the same thread (the DM, or the channel and topic), with "open the run in BoxPilot"
  under it. **Nothing listens**: once a minute (and on "Check Zulip now") the registered read
  `agents.zulip.events` (owner, a root task beside `agents.zulip.poll`, since only a task may reach
  the tailnet) reads the bot's own event queue without waiting (`dont_block`), narrowed to DMs and
  mentions; a queue Zulip let expire is registered again and the last 15 minutes are read from the
  message history, so nothing asked while BoxPilot was down is lost or answered twice (at most ten
  a read, the rest at the next). **Who asks is who they are in BoxPilot**: the owner maps Zulip people
  to BoxPilot accounts in the Team chat panel ("Asking in Zulip", with the password, at most 50) and
  picks the agent asked when a message names none ("Steve, which drives …" names one). A run starts
  exactly as the Test tab's Ask does, as that account: its role's tools and reads, its rate limit,
  its conversation, the eight processors of M40.4 while they wait. Anyone not on the list is told
  politely, at most once an hour, that they are not set up, and listed for the owner to add.
  **Chat never approves**: a plan or question card an answer made is posted in the thread as a card
  linking to BoxPilot's Agents page, where it is staged at its tier as always; a question asked back
  is in the reply. Every word the model wrote goes through the same `chatText` as findings (#344:
  links and images as code, no mentions, redacted); BoxPilot's own link is added after. Replies go
  through the outbox and its limits; a direct reply is `type: direct` to the asker's id (1 to 8
  ids, validated in `agents.zulip.post`). Tests: the events task against `test/fake-zulip.mjs` (the
  queue read once, DMs and mentions and nothing else, bots and the bot itself skipped, an expired
  queue opened again with what was asked since read back, what is too old left out), the service
  end to end with the real runner (`chat-ask.test.mjs`: someone not set up told once an hour and
  never reaching a model; a mapped person asking as their account and answered in the DM; a named
  agent answered in the channel's thread; a card sent back as a link; nothing asked while paused),
  the panel; and **on a real Zulip** (`zulip-host.yml`, docker-zulip as BoxPilot installs it) a
  person DMs the bot and the answer comes back in the DM.
- ✅ **M40.6 Pictures** (with M40.5). **Checked on the real model** (`agents-bench.yml`, `mode:
  image`: Unsloth 2026.9.12 started by BoxPilot's runtime, offline, four threads under
  `CPUQuota=400%`): `unsloth run` finds `mmproj-F16.gguf` beside the model in the Hugging Face cache
  (BoxPilot downloads it with the model, checksummed) and starts llama-server with `--mmproj`
  ("Using mmproj for vision"); Qwen 3.5 4B described a picture made on the spot as "a red circle on
  a white background, with a blue horizontal bar below it", in 27 s (20 s of model time) through
  the real describe run (run 36661268748). **What was wrong**: nothing checked that the projector
  loaded. A server without one refuses every image, each refusal spent one of the image's three
  tries, and three minutes into quiet hours the image was never described again. Now the runner
  asks the server it started whether it can see - Unsloth's `GET /api/inference/status`
  (`is_vision`, `mmproj_fallback_reason`), llama-server's `GET /props` (`modalities.vision`) - and
  sends no image to one that says it cannot; an image refused with "image input is not supported"
  counts the same. That costs the image no try, and describing waits a day (or until the model or
  runtime changes) instead of starting the model every minute to fail. **Found by the benchmark**:
  Studio answers its status before the model it is loading is listed, with `is_vision: false` for
  no model at all; only a status that names a loaded model counts, else the image is tried. The
  reason kept carries the server's own last line about a projector. The Knowledge tab says whether
  the model can see images, and which wait and why. llama-server, skipped for images since M38,
  describes when the model has a projector. Tests: a stand-in `unsloth run` (the start's key, the
  fallback reason, the status before the model is listed), the fake model answering both endpoints
  and refusing an image with `--vision off` as llama-server does, the service waiting a day and
  then describing (`chat.test.mjs`), the bench's image path on the stand-in, the tab's notice.

## M41 — Looks

Asked for 2026-09-30: the owner liked both of ADR-004's views and wanted to see either cover the
whole site; the study (`docs/design-directions/05-looks.html`) drew three ways and ten more, and the
owner chose all thirteen, each built to match its drawing (ADR-010).

- ✅ **M41.1 The ground the looks stand on** (unreleased, `feature/looks`). The registry
  (`src/looks/looks.ts`), the choice kept per browser and applied before first paint, `data-look`
  on the root, a Home per look, the sidebar and the soft-key and top-line docks, Storage's lead
  slot, the typefaces, and Settings → Appearance with a card per look, "Where it applies", accent,
  density, wallpaper and solid panels. `scripts/look-check.mjs` draws the reference pictures and
  scores screenshots against them.
- ✅ **M41.2 The thirteen looks** (unreleased, `feature/looks`), each with its skin on every page,
  its way around and its Home, matched to its drawing and checked light and dark where it has both.
  An account menu stands in for the bar's controls where a drawing keeps its bar bare; the shell
  says Home's verdict on every page. The README shows each look's Home.
- ✅ **M41.3 Checked by eye as well as by score** (unreleased, `feature/looks`): two rounds of two
  checkers put every look's Home (and Home + Ops' and the Launcher's Storage, and Appearance) side
  by side with its drawing and read every other page in every look, on a phone too; what they
  found was fixed. Every reference now scores 80 or more. Left as drawn differently on purpose:
  Command Center's rail has no Home stop, Phosphor and Quest keep their rail beside the screen,
  Glass Cockpit's unlit lamps are brighter than drawn so their names can be read, and the
  Launcher's Storage keeps status chips where a switch would promise what it cannot do.

## App catalogue candidates

Checked against the 164 manifests already in `catalog/`, so nothing here duplicates an existing
entry. Each names the gap it fills. Risk tiers follow the existing convention; anything that needs
host networking or a capability is marked.

**Fills a real gap on this server**
- **Unbound** (DNS) - a recursive resolver to sit behind Pi-hole/AdGuard so DNS does not depend on
  a third party; the catalog has three blockers and no resolver. Low risk.
- **CrowdSec** (Security) - collaborative intrusion prevention for the services the server exposes;
  fail2ban is host-level and BoxPilot-managed, CrowdSec covers the apps. Medium (reads Docker logs).
- **Authelia** or **Authentik** (Security) - a full SSO/2FA gateway for apps that cannot use
  "Sign in with BoxPilot" (M19); Pocket-ID covers OIDC-capable apps only. Medium.
- **Caddy** or **Traefik** (Network) - an alternative reverse proxy to Nginx Proxy Manager with
  automatic certificates and labels-based routing; NPM is the only proxy offered. Medium.
- **Gatus** (Monitoring) - status page + health checks with a config file that can be
  BoxPilot-generated from the catalog's installed apps; complements Uptime Kuma's UI-driven model.
  Low.
- **Borgmatic** (Backup) - Borg-based deduplicated backups with a declarative config, the common
  alternative to restic for people who already have a Borg repository. Low.
- **Rclone (web GUI)** (Backup) - the owner already mirrors to the cloud through BoxPilot's own
  rclone; exposing rclone's browser for ad-hoc cloud file management fills a gap the CLI leaves.
  Medium (holds cloud credentials).
- **Headscale** (Network) - self-hosted Tailscale control server, for owners who want the tailnet
  without the SaaS; BoxPilot already leans on Tailscale everywhere. Medium.
- **Copyparty** or **Dufs** (Files) - a zero-config file server for "just give me a URL to drop a
  file on" moments; Filebrowser and Pingvin cover adjacent needs, neither is this. Low.
- **Seafile** (Files) - the heavyweight sync alternative to Nextcloud for owners who want speed
  over the app ecosystem. Medium.

**Rounds out an existing category**
- **Kokoro / Speaches** (AI) - local text-to-speech to pair with Whisper's speech-to-text; the AI
  category has STT and LLMs but no TTS. Low, GPU optional.
- **Woodpecker CI** (Developer) - lightweight CI that pairs with Forgejo, which is already in the
  catalog with no CI beside it. Medium (runs containers).
- **Docuseal** (Files) - self-hosted document signing; Paperless and Stirling handle documents in,
  nothing handles signatures. Low.
- **Homarr** or **Dashy** (Monitoring) - alternative dashboards for owners who find Homepage's
  YAML or Glance's layout limiting. Low.
- **Ghostfolio** (Finance) - portfolio tracking beside Actual/Firefly's budgeting. Low.
- **Umami** or **Plausible** (Monitoring) - privacy-respecting web analytics for anything the owner
  hosts publicly through Cloudflared. Low.
- **Ntfy is present; add Gotify's sibling "Apprise API"** - already present. No action.
- **Immich is present; add "Photoview"** - only if a read-only, folder-based gallery is wanted for
  the-dump's media without an import step. Low.

**Deliberately not suggested**
- **Wazuh / Graylog / full ELK** - far heavier than a home server's monitoring should be; Loki +
  Grafana are already there.
- **Anything requiring `privileged: true`** beyond what the eight already-privileged monitoring/HA
  entries need.
- **A second download client or indexer manager** - the media-automation category is complete for
  the *arr stack.
