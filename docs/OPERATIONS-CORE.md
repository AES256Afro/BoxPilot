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
sudo install -m 0644 deploy/boxpilot-apt-refresh.service /etc/systemd/system/boxpilot-apt-refresh.service
sudo systemctl daemon-reload
sudo systemctl enable --now boxpilot-helper.service boxpilot.service boxpilot-storage-scan.timer
```

Both units expect the verified Node.js runtime at `/usr/local/bin/node`. Do not weaken the helper socket mode or add the web service to sudoers.

The storage timer is separate from the web service and helper protocol. If `/usr/sbin/smartctl` is absent, its successful evidence file says `smartctl-not-installed`; it does not install a package or invent disk health. Version `0.31.0` adds a dedicated Repair Center workflow that resolves only the configured `smartmontools` candidate, stores an immutable plan, requires separate staging and owner-password approval, revalidates the exact version, starts a static root package unit, and verifies a fresh scan. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.33.0` optionally reads an already configured local Network UPS Tools service through fixed `/usr/bin/upsc` localhost queries. BoxPilot does not install NUT, configure a driver, select a UPS, issue power commands, or change shutdown policy. If NUT is absent, Overview and Action Center report it as optional setup still required.

Version `0.34.0` adds fixed read-only host-maintenance evidence. It reports system and update readiness without package or unit names and without running APT, dpkg recovery, service control, update-policy mutation, or reboot. Every recommended change remains a separately reviewed Ubuntu console procedure.

Version `0.35.0` adds one separately named executable maintenance repair: refresh configured APT metadata through a static no-argument root unit. It requires a stale or unavailable metadata check, ready dpkg state, an immutable plan, separate staging, owner-password approval, and exact timestamp revalidation. The unit runs only `apt-get update --error-on=any` and verifies `/var/lib/dpkg/status` is unchanged. It cannot install, upgrade, remove, select, or accept a package, repository, command, option, or target from the browser. See [Exact prerequisite repair boundary](PREREQUISITE-REPAIRS.md).

Version `0.38.0` adds a separately approved backup of BoxPilot's fixed live SQLite database. The helper captures committed WAL state with SQLite `VACUUM INTO` without stopping the service, verifies the snapshot and a separate copy, writes a root-only manifest, and accepts only a server-generated UUID. It does not provide download, scheduling, retention, off-host transport, or automatic restore. See [BoxPilot controller database backups](CONTROLLER-BACKUPS.md).

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

This stopped-service database-family copy remains a manual incident checkpoint. For normal operations, use the `0.38.0` Backups workflow so committed WAL state, integrity, foreign keys, required schema, owner state, artifact checksum, manifest, and an isolated copy-open drill are verified. Neither method is independent protection until the complete result is stored outside Bigbox.
