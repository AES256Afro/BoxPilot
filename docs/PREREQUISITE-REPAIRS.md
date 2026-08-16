# Exact prerequisite repair boundary

BoxPilot `0.31.0` enables one narrowly scoped executable prerequisite repair: install the fixed Ubuntu `smartmontools` package and verify that the separate storage evidence scanner produces current evidence. Version `0.35.0` adds a separate metadata-only repair that runs the fixed configured-repository refresh without changing installed packages. Neither workflow is a general package manager.

## Operator workflow

1. Repair Center reads package state through `prerequisite.smartmontools.inspect`.
2. If configured APT metadata exposes a candidate, select **Review exact repair**.
3. Review the current state, exact candidate version, network requirement, APT-update prohibition, no-removal policy, recovery guidance, immutable revision, and expiration.
4. Select **Stage exact repair for password approval**.
5. Re-enter the owner password in the durable approval desk.
6. BoxPilot rechecks the package state and exact version immediately before execution.
7. The helper starts only `boxpilot-smartmontools-install.service` when the package is absent. If it is already installed, the helper skips APT and starts only the fixed scanner.
8. The job completes only after the exact version is installed and fresh bounded storage evidence exists.

## Fixed package unit

The static unit accepts no arguments and runs one repository-owned installer:

```ini
ExecStart=/usr/local/bin/node /opt/boxpilot/scripts/boxpilot-smartmontools-install.mjs
```

It is not enabled at boot and has no template instance, environment-supplied package, shell, `%i`, positional argument, repository input, or package-selection field. The helper first rechecks the reviewed version and writes a root-only, short-lived approval marker. The no-argument installer independently rechecks that the configured candidate still matches, pins APT to `smartmontools=<approved-version>`, verifies dpkg state, and starts only the fixed scanner. The helper removes the marker after the unit returns. A negative `ConditionPathExists` prevents the unit from running APT when `/usr/sbin/smartctl` already exists. Network access exists only in this separate oneshot because APT may need to download the already resolved configured candidate. The main helper keeps `PrivateNetwork=true`.

The unit deliberately does not run `apt-get update`. BoxPilot uses currently configured package metadata. If no candidate exists, the plan fails closed and asks the administrator to repair APT metadata from the server console.

## Fixed APT metadata refresh

Repair Center offers **Review metadata refresh** only when bounded evidence says APT metadata is stale or unavailable and dpkg has no pending numeric update fragments. The browser submits an empty plan request. The plan captures only the exact previous metadata timestamp and derived state, then requires separate staging and owner-password approval.

The helper revalidates the timestamp and ready dpkg state, writes a root-only marker valid for at most five minutes, and starts only the static `boxpilot-apt-refresh.service`. The no-argument script independently checks the marker and timestamp, hashes `/var/lib/dpkg/status`, refuses pending fragments, runs exactly:

```text
/usr/bin/apt-get update --error-on=any
```

It then refuses new dpkg fragments, requires the package database hash to remain unchanged, and requires current metadata evidence. No install, upgrade, remove, autoremove, service control, update-policy change, or reboot operation is present. The web process and main root helper keep their existing network boundaries; network access exists only in this separately named static oneshot.

## Durable and helper boundaries

The browser can submit only an empty plan request and later the immutable revision. The helper protocol accepts:

- `prerequisite.smartmontools.inspect` with no parameters
- `prerequisite.smartmontools.install` with one bounded `expectedVersion`
- `prerequisite.apt-metadata.inspect` with no parameters
- `prerequisite.apt-metadata.refresh` with one exact previous `expectedUpdatedAt` value

The expected version is immutable approval evidence, not a package-name selector. The helper independently inspects the only fixed package, rejects a changed candidate, and creates the short-lived marker. The fixed installer rejects a stale marker or changed metadata before mutation, then uses the approved value only to pin the hard-coded `smartmontools` package. No browser value becomes an APT option, command, repository, or package name.

The job records preflight, checkpoint, approval, apply, verify, result, failure, and actor attribution in the existing SQLite Operations Core. Interrupted applying or verifying jobs fail closed after restart.

## Recovery boundary

BoxPilot does not automatically remove `smartmontools`. Package removal is not a safe inverse because an administrator or another service may have begun relying on the package. If the unit fails:

```bash
sudo systemctl status boxpilot-smartmontools-install.service boxpilot-storage-scan.service --no-pager
sudo journalctl -u boxpilot-smartmontools-install.service -u boxpilot-storage-scan.service -n 100 --no-pager
sudo dpkg --audit
sudo apt-get check
```

Repair interrupted dpkg or APT state from the server console before creating a new plan. Do not remove the package merely to recreate the prior state.

## Explicit exclusions

Version `0.35.0` cannot:

- Install, update, downgrade, hold, or remove any other package
- Select a package name, repository, mirror, key, package file, option, command, or argument from the browser
- Run any APT action except the separately approved fixed metadata-only `apt-get update --error-on=any`; it cannot run upgrade, dist-upgrade, install, remove, purge, autoremove, download, source, or repository-management operations
- Change a disk, partition, filesystem, mount, SMART setting, router, DNS setting, firewall, Tailscale setting, or reboot state
- Automatically approve, schedule, retry, roll back, or hide a failed package operation
- Turn missing or stale scanner evidence into a healthy claim

Future prerequisite repairs require separately named operations, units, plans, negative tests, recovery guidance, and documentation. They must not widen either fixed operation into a general handler.
