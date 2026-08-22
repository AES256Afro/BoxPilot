# Operations Core setup and recovery

BoxPilot `0.4.0` introduces the authenticated, durable boundary required before application, package, backup, DNS, or router mutation can be enabled.

## Security model

- The browser and API run as the unprivileged `boxpilot` account.
- The helper is a separate root process with no network listener.
- Requests cross a group-restricted Unix socket using a versioned JSON protocol.
- The only `0.4.0` helper operation is `canary.verify`. It accepts no parameters and performs no mutation.
- Passwords use scrypt hashes. Session tokens are stored only as SHA-256 digests.
- Sessions expire and use HTTP-only, SameSite cookies.
- Every non-read API request after login requires a CSRF token.
- Job approval requires the owner password again.
- Jobs interrupted while applying or verifying are marked failed for operator review instead of being retried automatically.

## Install the services

After building BoxPilot under `/opt/boxpilot`:

```bash
sudo install -d -m 0755 /etc/boxpilot
sudo install -m 0600 deploy/boxpilot.env.example /etc/boxpilot/boxpilot.env
sudo install -m 0640 -o root -g boxpilot deploy/redaction.example.json /etc/boxpilot/redaction.json
sudo install -m 0644 deploy/boxpilot-helper.service /etc/systemd/system/boxpilot-helper.service
sudo install -m 0644 deploy/boxpilot.service /etc/systemd/system/boxpilot.service
sudo install -m 0644 deploy/boxpilot-storage-scan.service /etc/systemd/system/boxpilot-storage-scan.service
sudo install -m 0644 deploy/boxpilot-storage-scan.timer /etc/systemd/system/boxpilot-storage-scan.timer
sudo install -m 0644 deploy/boxpilot-smartmontools-install.service /etc/systemd/system/boxpilot-smartmontools-install.service
sudo install -m 0644 deploy/boxpilot-restic-install.service /etc/systemd/system/boxpilot-restic-install.service
sudo install -m 0644 deploy/boxpilot-docker-install.service /etc/systemd/system/boxpilot-docker-install.service
sudo install -m 0644 deploy/boxpilot-virtualization-install.service /etc/systemd/system/boxpilot-virtualization-install.service
sudo install -m 0644 deploy/boxpilot-libvirt-foundation.service /etc/systemd/system/boxpilot-libvirt-foundation.service
sudo install -m 0644 deploy/boxpilot-apt-refresh.service /etc/systemd/system/boxpilot-apt-refresh.service
sudo install -m 0644 deploy/boxpilot-keel-artifact.service /etc/systemd/system/boxpilot-keel-artifact.service
sudo install -m 0644 deploy/boxpilot-keel-install.service /etc/systemd/system/boxpilot-keel-install.service
sudo install -m 0644 deploy/boxpilot-keel-backup.service /etc/systemd/system/boxpilot-keel-backup.service
sudo install -m 0644 deploy/boxpilot-keel-recovery-drill.service /etc/systemd/system/boxpilot-keel-recovery-drill.service
sudo install -m 0644 deploy/boxpilot-keel-promotion.service /etc/systemd/system/boxpilot-keel-promotion.service
sudo install -m 0644 deploy/boxpilot-keel-rollback.service /etc/systemd/system/boxpilot-keel-rollback.service
sudo systemctl daemon-reload
sudo systemctl enable --now boxpilot-helper.service boxpilot.service boxpilot-storage-scan.timer
```

Both units expect the verified Node.js runtime at `/usr/local/bin/node`. Do not weaken the helper socket mode or add the web service to sudoers.

The storage timer is separate from the web service and helper protocol. If `/usr/sbin/smartctl` is absent, its successful evidence file says `smartctl-not-installed`; it does not install a package or invent disk health. Version `0.31.0` adds a dedicated Repair Center workflow that resolves only the configured `smartmontools` candidate, stores an immutable plan, requires separate staging and owner-password approval, revalidates the exact version, starts a static root package unit, and verifies a fresh scan. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.33.0` optionally reads an already configured local Network UPS Tools service through fixed `/usr/bin/upsc` localhost queries. BoxPilot does not install NUT, configure a driver, select a UPS, issue power commands, or change shutdown policy. If NUT is absent, Overview and Action Center report it as optional setup still required.

Version `0.34.0` adds fixed read-only host-maintenance evidence. It reports system and update readiness without package or unit names and without running APT, dpkg recovery, service control, update-policy mutation, or reboot. Every recommended change remains a separately reviewed Ubuntu console procedure.

Version `0.35.0` adds one separately named executable maintenance repair: refresh configured APT metadata through a static no-argument root unit. It requires a stale or unavailable metadata check, ready dpkg state, an immutable plan, separate staging, owner-password approval, and exact timestamp revalidation. The unit runs only `apt-get update --error-on=any` and verifies `/var/lib/dpkg/status` is unchanged. It cannot install, upgrade, remove, select, or accept a package, repository, command, option, or target from the browser. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.38.0` adds a separately approved backup of BoxPilot's fixed live SQLite database. The helper captures committed WAL state with SQLite `VACUUM INTO` without stopping the service, verifies the snapshot and a separate copy, writes a root-only manifest, and accepts only a server-generated UUID. It does not provide download, scheduling, retention, off-host transport, or automatic restore. See [BoxPilot controller database backups](../CONTROLLER-BACKUPS.md).

Version `0.39.0` adds a separate encrypted independent copy and exact restore drill for that local controller snapshot. Version `0.40.0` adds one high-risk fixed retention batch that preserves at least three snapshots, every snapshot under 30 days old, unprotected or failed-restore evidence, and active controller-operation references. The helper can receive only the server-generated retention UUID, repository and destination revisions, the complete snapshot-set revision, and one to 100 exact sorted snapshot ids. It revalidates the approved evidence, forgets only those ids, runs a complete repository data read, proves reviewed noncandidates remain, and records confirmed partial removal before a failed job is shown. It never prunes, reclaims space, removes local artifacts, schedules itself, or accepts a browser policy. See [BoxPilot controller database backups](../CONTROLLER-BACKUPS.md).

Version `0.42.0` adds a static Keel artifact one-shot. Install its unit, but do not enable it: it has no `[Install]` section and starts only after a fresh durable plan, staging, password approval, exact state revalidation, and a short-lived root-only marker. The main helper remains network-isolated. See [Keel Notes discovery and inert artifact adapter](KEEL.md).

Version `0.43.0` adds a parameter-free read-only Keel archive membership operation inside the network-isolated helper. It rechecks the fixed compressed identity and parses the archive in place under hard member and size ceilings. No extraction unit or installation unit existed. The then-pinned 1.2.5 result was blocked by one symbolic link with an absolute build-workspace target.

Version `0.44.0` adds parameter-free inspection and one exact typed create operation for independent Uptime Kuma and Pi-hole protection. The helper derives the fixed local archive, separate `restic-applications` repository and password file, cache, and drill path. It accepts only the application id, two UUIDs, approved hash and size, and destination revision. A complete repository data read and exact restored archive hash are mandatory. The application, local artifact, router, DNS, repository retention, and production restore state remain unchanged. Configure the separate terminal-only key with `sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh`; see [Verified application backups](../BACKUPS.md).

Version `0.45.0` adds a separately named fixed `restic` package repair. The read-only helper inspection accepts no parameters. Its immutable plan captures the hard-coded package's exact installed state and configured APT candidate, then requires staging and owner-password approval. The helper delegates an absent package only to `boxpilot-restic-install.service`, which independently rechecks a short-lived root-only marker, pins the exact version, verifies dpkg state, and probes `/usr/bin/restic version`. It does not run `apt-get update`, accept a package or repository selector, configure a mount or key, initialize a repository, start a backup, change retention, or remove a package. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.46.0` adds a distinct Keel inert-staging job. The application plan stores one server-generated stage UUID after exact discovery, artifact, archive, destination, platform, prerequisite, and public-provenance checks. Staging creates a durable `application.keel.stage` job. Approval rechecks those host facts and the owner password before the helper accepts only the UUID. The helper publishes an exact root-only release tree or removes its generated partial/new release on failure. It cannot create application state, a service, account, registration setting, listener, access route, backup, restore, or migration.

Version `0.47.0` adds a second Keel native-install job and a separate static `boxpilot-keel-install.service`. Install that unit but do not enable it. It has no `[Install]` section and starts only after exact staging evidence, a fresh immutable install plan, separate job staging, owner-password approval, host-state revalidation, and a short-lived root-only marker. The helper accepts only a server-generated install UUID. The one-shot creates the fixed non-login account, private state, exact release link, root-owned environment, hardened loopback unit, and health evidence. It requires the exact JSON health identity and private SQLite database. Its automatic rollback removes only generated unit, environment, and activation state, preserving `/var/lib/keel`. Claim tokens, registration, Tailscale exposure, firewall, DNS, DHCP, router changes, backup, restore, import, update, adoption, and removal are outside this operation. See [Keel Notes guarded private installation](KEEL.md).

Version `0.48.0` adds the static `boxpilot-keel-backup.service`. Install it but do not enable it. It has no `[Install]` section and runs only after an immutable Keel Backups plan, separate staging, owner-password approval, exact managed-install revalidation, and a five-minute root-only marker. The helper accepts only a server-generated backup UUID. The no-argument unit stops only Keel, exports as its dedicated account, builds and validates a root-only archive, restarts and health-checks the source, and performs an isolated restored-SQLite drill with only loopback network access. `ExecStopPost` also requests `keel.service` restart. Helper startup recovers a validated interrupted marker and removes only generated unrecorded paths after restart succeeds. Production state, claim, registration, exposure, firewall, DNS, DHCP, and router state are outside the operation. See [Keel Notes guarded native service and recovery evidence](KEEL.md).

Version `0.49.0` adds `application.keel.recovery.create` as a high-risk durable job. Its plan captures only a server-generated recovery id and exact durable backup evidence. The helper's existing private network namespace revalidates and extracts the fixed archive beneath a generated partial, repeats manifest, tree, managed-secret, and SQLite checks, hardens the live-layout clone, and publishes it atomically as stopped data at rest. Failure before publication removes only that partial. Published state is preserved for review. No service unit is started and no production, network, claim, registration, router, or source-artifact mutation exists.

Versions `0.50.0` and `0.51.0` add the isolated Keel startup rehearsal and rollback-backed production promotion. Version `0.52.0` adds static `boxpilot-keel-rollback.service`; install it but do not enable it. The unit has no `[Install]` section and starts only after exact durable promotion evidence, an immutable plan, separate staging, owner-password approval, and a short-lived root-only marker. It accepts no arguments, preserves the original promotion checkpoint, atomically retains current production in a second root-only checkpoint, and restores displaced current production after failure or interruption. Network exposure, retention, and deletion remain separate.

Version `0.53.0` keeps owner-login proof outside Operations Core mutations. Its terminal-only command accepts no arguments and requires fresh `sudo`. A root parent validates the fixed managed install, while an unprivileged `keel` worker alone handles the prompt, loopback session, owner-only read, logout, and revocation check. The helper can inspect only the exact sanitized mode-0600 proof file with no parameters. No BoxPilot job, approval, browser input, credential record, or session record is created.

Version `0.54.0` adds a separately named `docker.io` prerequisite repair for clean Ubuntu hosts. Parameter-free inspection recognizes an active compatible provider as ready and blocks automatic replacement when any fixed Docker client path or installed provider is already present. Only a host with no present provider and one configured Ubuntu candidate can create a plan. After immutable staging and password approval, the helper writes a five-minute root-only marker and starts `boxpilot-docker-install.service`. Its no-argument script rechecks provider absence and the exact candidate, installs only `docker.io=<approved-version>` without metadata refresh or repository setup, enables and starts only `docker.service`, and verifies the local server version. It cannot change Docker daemon configuration, users, images, containers, networks, volumes, or an existing provider. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.55.0` adds the separate clean-host KVM, QEMU, and libvirt prerequisite. It requires `/dev/kvm`, no existing or partial provider, and exact configured candidates for `qemu-system-x86`, `libvirt-daemon-system`, `libvirt-clients`, `virtinst`, and `ovmf`. The immutable plan shows every root version and that Ubuntu may install or update required dependencies. Password approval creates a five-minute root-only marker for `boxpilot-virtualization-install.service`. That no-argument unit independently rechecks hardware, provider paths, installed package state, and all candidates; installs the fixed roots; enables and starts only `libvirtd.service`; and verifies QEMU plus `qemu:///system`. It never creates a libvirt network, pool, disk, ISO attachment, or VM, changes an operator user or group, replaces a partial provider, or accepts a browser command, package, repository, URI, or resource name.

Version `0.55.1` corrects read-only KVM readiness inside the main helper's private-device namespace. Inspection now proves kernel registration through fixed `/sys/class/misc/kvm/dev` evidence without exposing `/dev/kvm` to the helper. The static installer retains its independent real-host `/dev/kvm` condition and script check.

Version `0.56.0` adds a separate fixed libvirt foundation job. The read-only operation accepts no parameters and recognizes only the canonical `default` NAT network, `virbr0`, `192.168.122.0/24`, `default` directory pool, and `/var/lib/libvirt/images`. An immutable plan captures one generated UUID and exact state revision. After staging and password approval, the helper writes a five-minute root-only marker and starts `boxpilot-libvirt-foundation.service`. The static no-argument unit independently rechecks state, defines only missing canonical resources, starts and enables only inactive compatible resources, verifies them through `qemu:///system`, and reverses only changes made by the failing job. It cannot accept XML, a name, subnet, bridge, pool, path, URI, command, or argument from the browser and cannot change other resources, a VM, disk, ISO, operator group, LAN route, firewall, or Tailscale setting.

Version `0.57.0` adds fixed lifecycle operations for the managed Uptime Kuma canary. Parameter-free inspection proves the reserved container name, exact digest-pinned image, Compose identity, loopback binding, persistent data mount, restart policy, health, and absence of privileges, devices, added capabilities, and Docker-socket access. An immutable plan pins that complete state revision. Start, Stop, and Restart require staging and owner-password approval; the helper rechecks identity and state before changing only the reserved container, then verifies the desired state and preserved data. No arbitrary Docker operation or change to images, Compose, environments, ports, mounts, volumes, networks, data, other containers, router, DNS, firewall, or Tailscale is available.

Version `0.58.0` adds the separate `application.pi-hole.action` job. Parameter-free inspection proves the exact managed Pi-hole identity, private-LAN TCP and UDP DNS bindings, reviewed web binding, fixed configuration mount, root-only secret-file metadata, restart policy, exact capability allowlist, `CAP_DROP=ALL`, `no-new-privileges`, and absence of privileges, devices, or Docker-socket access. An immutable network-critical plan pins that revision and requires an independently tested resolver. The helper accepts only Start, Stop, or Restart plus the exact revision, changes only the reserved container, and rechecks configuration, secret, state, health, and DNS bindings. It cannot change DHCP, router, client DNS, firewall, Tailscale, image, Compose, ports, storage, secret content, or another container.

Version `0.59.0` adds the separate `application.uptime-kuma.private-access` job. Parameter-free inspection derives the exact managed loopback port and connected tailnet DNS name, rejects unmanaged listener conflicts, proves the CLI labels an existing app route tailnet only, and hashes every non-application Serve route into the state revision. The helper accepts only Publish or Unpublish plus that revision and uses one fixed Tailscale Serve command. Post-action verification requires the expected private URL, Funnel and public exposure off, and the complete remaining Serve configuration unchanged. The job cannot accept or change an arbitrary hostname, port, target, path, protocol, Service, command, argument, firewall, DNS, router, container, application, or data value.

Version `0.60.0` adds the separate `application.backup.retention.apply` job. Parameter-free inspection reads only the fixed application restic repository, exact BoxPilot application tags, repository identity, destination revision, and snapshot-set revision. The immutable service plan correlates that inventory with all durable application protection records, per-application copy floors, age, exact restore evidence, published Keel recovery references, and active application jobs. The helper accepts only a generated retention UUID, the fixed repository and destination revisions, the exact snapshot-set revision, and one to 100 sorted snapshot ids. It runs `restic forget` only for those ids, performs a complete repository data read, proves candidates absent and noncandidates present, and records confirmed partial removal. It never accepts a browser path, repository, password, application, selector, policy, schedule, prune request, or deletion target and never changes applications, local archives, recovery objects, or space allocation.

Claim is a separate terminal-only handoff, not a helper operation or web job. The displayed `boxpilot-keel-claim.mjs` command requires a normal administrator to invoke it through `sudo -k`, verifies only the exact managed installation, drops all supplementary groups and then its GID and UID to `keel`, and invokes the upstream one-use transaction against the fixed SQLite database. It rejects root-login, noninteractive, changed-boundary, and malformed-token calls. The token is never stored by BoxPilot.

The manual console fallback remains:

```bash
sudo apt-get install smartmontools
sudo systemctl start boxpilot-storage-scan.service
sudo systemctl status boxpilot-storage-scan.service boxpilot-storage-scan.timer --no-pager
```

The browser cannot trigger this command. Review and customize only the bounded exact literals and path prefixes in `/etc/boxpilot/redaction.json`; regexes, wildcards, alternate paths, and replacement strings are rejected.

## Create the first owner

Generate a single-use token from an SSH or physical console on the server:

```bash
sudo -u boxpilot env BOXPILOT_STATE_DIRECTORY=/var/lib/boxpilot \
  /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs create-bootstrap-token
```

The token expires after 15 minutes and becomes unusable after the first owner is created. Open the private BoxPilot URL, enter the token, and choose a password of at least 12 characters.

Do not paste the bootstrap token or password into chat, issue trackers, shell history, or service logs.

## Verify the boundary

1. Sign in to BoxPilot.
2. Open **Repair Center**.
3. Confirm the live prerequisite checks.
4. Select **Create verification job**.
5. Review its no-mutation recovery statement.
6. Re-enter the owner password and select **Approve and verify**.
7. Confirm all six recorded steps and the `completed` state.

## Diagnose a failed helper check

```bash
sudo systemctl status boxpilot-helper.service boxpilot.service --no-pager
sudo journalctl -u boxpilot-helper.service -u boxpilot.service -n 100 --no-pager
sudo ls -l /run/boxpilot/helper.sock
sudo -u boxpilot test -r /run/boxpilot/helper.sock
sudo -u boxpilot test -w /run/boxpilot/helper.sock
```

Expected socket ownership is `root:boxpilot` with mode `0660`. Restart the helper before the web service:

```bash
sudo systemctl restart boxpilot-helper.service
sudo systemctl restart boxpilot.service
```

Do not make the socket world-writable. A failed canary changes no host state and requires no rollback.

## Database recovery

The database is `/var/lib/boxpilot/boxpilot.sqlite3` by default. Its WAL and shared-memory companion files may exist while BoxPilot is running. Stop both services before copying the database manually:

```bash
sudo systemctl stop boxpilot.service boxpilot-helper.service
sudo install -d -m 0700 /var/backups/boxpilot
sudo cp -a /var/lib/boxpilot/boxpilot.sqlite3* /var/backups/boxpilot/
sudo systemctl start boxpilot-helper.service boxpilot.service
```

This stopped-service database-family copy remains a manual incident checkpoint. For normal operations, use the `0.38.0` Backups workflow so committed WAL state, integrity, foreign keys, required schema, owner state, artifact checksum, manifest, and an isolated copy-open drill are verified. Neither method is independent protection until the complete result is stored outside the server.
