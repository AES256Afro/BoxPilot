# Exact prerequisite repair boundary

BoxPilot `0.31.0` enables one narrowly scoped executable prerequisite repair: install the fixed Ubuntu `smartmontools` package and verify that the separate storage evidence scanner produces current evidence. Version `0.35.0` adds a separate metadata-only repair that runs the fixed configured-repository refresh without changing installed packages. Version `0.45.0` adds a second fixed package repair for the `restic` binary used by BoxPilot's separately configured encrypted repositories. Version `0.54.0` adds an Ubuntu `docker.io` installer only on a provider-free host. Version `0.55.0` adds a clean-host five-root Ubuntu KVM, QEMU, libvirt, virt-install, and OVMF installer. None of these workflows is a general package manager.

## Operator workflow

1. Repair Center reads package state through `prerequisite.smartmontools.inspect`.
2. If configured APT metadata exposes a candidate, select **Review exact repair**.
3. Review the current state, exact candidate version, network requirement, APT-update prohibition, no-removal policy, recovery guidance, immutable revision, and expiration.
4. Select **Stage exact repair for password approval**.
5. Re-enter the owner password in the durable approval desk.
6. BoxPilot rechecks the package state and exact version immediately before execution.
7. The helper starts only `boxpilot-smartmontools-install.service` when the package is absent. If it is already installed, the helper skips APT and starts only the fixed scanner.
8. The job completes only after the exact version is installed and fresh bounded storage evidence exists.

The restic workflow follows the same plan, stage, and reauthentication sequence through **Review restic repair**. Its verification requires the exact package version and a successful fixed `/usr/bin/restic version` probe. It deliberately stops there. Independent storage mounting, recovery-key creation, repository initialization, backup execution, restore drills, retention, and prune are not part of this repair.

The Docker workflow begins with **Review Docker install** only when fixed inspection proves there is no Docker client at the fixed path, no installed `docker.io` provider, and configured Ubuntu metadata exposes a candidate. An active compatible provider is already ready; a present but inactive or unrecognized provider is left for manual repair rather than replaced. The immutable plan shows the exact package version and daemon boundary. After staging and password reauthentication, the job installs that exact package, enables and starts only `docker.service`, and verifies the local server version. It does not replace an existing Docker CE or other provider, change daemon configuration, add a user to the `docker` group, pull an image, create a container, or deploy an application.

The virtualization workflow begins with **Review virtualization install** only when the KVM kernel interface is registered, neither fixed provider path nor any fixed root package is present, and configured Ubuntu metadata exposes candidates for all five roots. The main helper reads only `/sys/class/misc/kvm/dev` because its private-device namespace deliberately hides `/dev/kvm`. An existing active stack is ready; partial or inactive provider state is left for manual repair. The immutable plan shows each exact root version and discloses that APT may install or update required dependencies. After staging and password reauthentication, the separately sandboxed installer additionally requires the real host `/dev/kvm`, installs only those fixed roots, enables and starts only `libvirtd.service`, and verifies `/dev/kvm`, QEMU, and `qemu:///system`. Network, pool, media, disk, and VM setup remain separate operations.

## Fixed package unit

The static unit accepts no arguments and runs one repository-owned installer:

```ini
ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-smartmontools-install.mjs
```

It is not enabled at boot and has no template instance, environment-supplied package, shell, `%i`, positional argument, repository input, or package-selection field. The helper first rechecks the reviewed version and writes a root-only, short-lived approval marker. The no-argument installer independently rechecks that the configured candidate still matches, pins APT to `smartmontools=<approved-version>`, verifies dpkg state, and starts only the fixed scanner. The helper removes the marker after the unit returns. A negative `ConditionPathExists` prevents the unit from running APT when `/usr/sbin/smartctl` already exists. Network access exists only in this separate oneshot because APT may need to download the already resolved configured candidate. The main helper keeps `PrivateNetwork=true`.

The unit deliberately does not run `apt-get update`. BoxPilot uses currently configured package metadata. If no candidate exists, the plan fails closed and asks the administrator to repair APT metadata from the server console.

## Fixed restic package unit

The `0.45.0` unit is separate from the smartmontools installer and also accepts no arguments:

```ini
ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-restic-install.mjs
```

The helper resolves only the hard-coded `restic` package, captures the exact configured candidate, and writes `/run/boxpilot/restic-approval.json` as a short-lived root-only marker. The static installer independently rechecks that marker and candidate, pins APT to `restic=<approved-version>`, verifies the dpkg record, and runs only `/usr/bin/restic version`. `ConditionPathExists=!/usr/bin/restic` prevents the package unit from running once the binary exists; an already installed approved version is verified directly without APT.

The unit has no repository path, password, mount, command, argument, remote, backup, restore, retention, or prune input. It never invokes `restic init`, `restic backup`, `restic restore`, `restic forget`, or `restic prune`. Installing the binary does not make any BoxPilot destination ready and does not satisfy the independent-filesystem or separately retained recovery-key gates.

## Fixed APT metadata refresh

Repair Center offers **Review metadata refresh** only when bounded evidence says APT metadata is stale or unavailable and dpkg has no pending numeric update fragments. The browser submits an empty plan request. The plan captures only the exact previous metadata timestamp and derived state, then requires separate staging and owner-password approval.

The helper revalidates the timestamp and ready dpkg state, writes a root-only marker valid for at most five minutes, and starts only the static `boxpilot-apt-refresh.service`. The no-argument script independently checks the marker and timestamp, hashes `/var/lib/dpkg/status`, refuses pending fragments, runs exactly:

```text
/usr/bin/apt-get update --error-on=any
```

It then refuses new dpkg fragments, requires the package database hash to remain unchanged, and requires current metadata evidence. No install, upgrade, remove, autoremove, service control, update-policy change, or reboot operation is present. The web process and main root helper keep their existing network boundaries; network access exists only in this separately named static oneshot.

## Fixed Docker Engine package unit

The `0.54.0` unit is another static no-argument operation:

```ini
ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-docker-install.mjs
```

The helper creates `/run/boxpilot/docker-approval.json` only after confirming that no Docker client path or installed provider is present and that the exact configured Ubuntu `docker.io` candidate matches the immutable plan. The unit independently repeats those checks, refuses an already present binary or package, installs only `docker.io=<approved-version>`, enables and starts only `docker.service`, and requires both active-unit and local server-version proof. `ConditionPathExists=!/usr/bin/docker` also blocks provider replacement at the systemd boundary.

The operation never runs `apt-get update`, adds the Docker repository or a signing key, changes `/etc/docker/daemon.json`, edits users or groups, opens a TCP daemon socket, pulls an image, creates a network or volume, or runs a container. Existing compatible providers are reported ready and cannot produce an installation plan.

## Fixed virtualization package unit

The `0.55.0` unit is another static no-argument operation:

```ini
ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-virtualization-install.mjs
```

The helper creates `/run/boxpilot/virtualization-approval.json` only after confirming the fixed five candidates, registered KVM kernel evidence, and provider-free state. The marker contains only the exact five-root version map and approval time. The unit independently requires the actual host `/dev/kvm`, repeats the provider, package, and candidate checks, installs exact `name=version` roots for `qemu-system-x86`, `libvirt-daemon-system`, `libvirt-clients`, `virtinst`, and `ovmf`, enables and starts only `libvirtd.service`, and requires QEMU plus `qemu:///system` proof. Ubuntu APT resolves required dependencies from already configured repositories; the plan states that dependencies may be installed or updated.

The operation never runs `apt-get update`, adds a repository or key, edits an operator user or group, replaces an existing or partial provider, creates or changes a libvirt network or storage pool, downloads or attaches an ISO, allocates a VM disk, defines a domain, starts a VM, or accepts a browser path, URI, command, option, package, or resource name.

## Durable and helper boundaries

The browser can submit only an empty plan request and later the immutable revision. The helper protocol accepts:

- `prerequisite.smartmontools.inspect` with no parameters
- `prerequisite.smartmontools.install` with one bounded `expectedVersion`
- `prerequisite.restic.inspect` with no parameters
- `prerequisite.restic.install` with one bounded `expectedVersion`
- `prerequisite.docker.inspect` with no parameters
- `prerequisite.docker.install` with one bounded `expectedVersion`
- `prerequisite.virtualization.inspect` with no parameters
- `prerequisite.virtualization.install` with the exact fixed five-key `expectedPackages` map
- `prerequisite.apt-metadata.inspect` with no parameters
- `prerequisite.apt-metadata.refresh` with one exact previous `expectedUpdatedAt` value

The expected version is immutable approval evidence, not a package-name selector. The helper independently inspects the separately named fixed package, rejects a changed candidate, and creates the matching short-lived marker. Each fixed installer rejects a stale marker or changed metadata before mutation, then uses the approved value only to pin its one hard-coded package. No browser value becomes an APT option, command, repository, or package name.

The job records preflight, checkpoint, approval, apply, verify, result, failure, and actor attribution in the existing SQLite Operations Core. Interrupted applying or verifying jobs fail closed after restart.

## Recovery boundary

BoxPilot does not automatically remove `smartmontools`, `restic`, or Docker Engine. Package removal is not a safe inverse because an administrator or another service may have begun relying on the package. If a unit fails:

```bash
sudo systemctl status boxpilot-smartmontools-install.service boxpilot-storage-scan.service --no-pager
sudo journalctl -u boxpilot-smartmontools-install.service -u boxpilot-storage-scan.service -n 100 --no-pager
sudo systemctl status boxpilot-restic-install.service --no-pager
sudo journalctl -u boxpilot-restic-install.service -n 100 --no-pager
sudo systemctl status boxpilot-docker-install.service docker.service --no-pager
sudo journalctl -u boxpilot-docker-install.service -u docker.service -n 100 --no-pager
sudo systemctl status boxpilot-virtualization-install.service libvirtd.service --no-pager
sudo journalctl -u boxpilot-virtualization-install.service -u libvirtd.service -n 100 --no-pager
stat /dev/kvm
sudo dpkg --audit
sudo apt-get check
```

Repair interrupted dpkg or APT state from the server console before creating a new plan. Do not remove the package merely to recreate the prior state.

## Explicit exclusions

Version `0.58.0` cannot:

- Install, update, downgrade, hold, or remove a requested root package other than the separately approved exact `smartmontools`, `restic`, Ubuntu `docker.io`, or fixed five-root virtualization set. APT may resolve dependencies required by an approved root.
- Select a package name, repository, mirror, key, package file, option, command, or argument from the browser
- Run a general APT action. The only APT verbs are the separately approved metadata-only `apt-get update --error-on=any` and static exact-root `apt-get install` units. There is no browser-selected upgrade, dist-upgrade, remove, purge, autoremove, download, source, or repository-management operation.
- Change a disk, partition, filesystem, mount, SMART setting, router, DNS setting, firewall, Tailscale setting, or reboot state
- Create or read a restic recovery password, initialize or select a repository, start a backup or restore, change retention, prune data, or claim independent protection
- Replace an active Docker provider, configure the Docker daemon, add users to the `docker` group, pull an image, or create a container, network, or volume
- Replace a partial virtualization provider, change an operator user or group, create or change a libvirt network or pool, attach media, allocate a disk, define a domain, or start a VM
- Automatically approve, schedule, retry, roll back, or hide a failed package operation
- Turn missing or stale scanner evidence into a healthy claim

Future prerequisite repairs require separately named operations, units, plans, negative tests, recovery guidance, and documentation. They must not widen either fixed operation into a general handler.
