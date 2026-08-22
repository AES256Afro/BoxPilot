# QEMU/KVM setup and operation

BoxPilot `0.61.0` can install the fixed Ubuntu KVM, QEMU, libvirt, virt-install, and OVMF prerequisites on a clean hardware-ready host, initialize and verify the canonical default NAT network and storage pool through a separate approved workflow, upload and separately import SHA-256-verified ISO installation media, inspect the local libvirt system connection through its restricted helper, create supported Linux virtual machines through durable approved jobs, manage a deliberately small set of lifecycle operations, report QEMU guest-agent and snapshot state, create guarded offline internal snapshots, produce integrity-verified local exports for stopped managed VMs, copy those exports into a fixed encrypted restic repository on an independent mounted filesystem, prove one backup bootable through an isolated transient restore drill, create a separately named stopped no-network recovery clone, and apply one fixed exact no-prune retention policy. It is intended for the Ubuntu server itself, not a remote libvirt daemon.

## What works now

- Detect Linux, KVM support through libvirt, QEMU, `virsh`, `virt-install`, and the restricted helper boundary
- Review and install the exact five-root Ubuntu virtualization package bundle on a clean host after owner-password approval
- Check the exact default libvirt NAT network and storage pool
- Review, stage, password-approve, initialize, and verify missing or inactive canonical default resources with job-limited automatic rollback
- List persistent VMs with state, vCPU, maximum memory, autostart, lease- and guest-agent-reported IP addresses, guest-agent status, filesystem-freeze state, and bounded snapshot metadata
- Start a stopped VM
- Request graceful shutdown or reboot of a running VM
- Enable or disable VM autostart
- Review current and desired lifecycle state before staging an immutable plan
- Revalidate lifecycle state before staging, after password approval, and after the fixed helper operation
- Detect the host's Tailscale name and an existing Tailscale Serve URL
- Discover managed ISO images, libvirt networks, pools, guest disks, interfaces, and snapshot count
- Stream an authenticated ISO upload into a fixed staging directory while computing its complete SHA-256
- Review and stage a separate immutable import plan that never overwrites existing managed media
- Rehash the staged source, atomic managed copy, and published ISO after owner-password approval
- Validate and durably store a new VM plan with an exact `virt-install` preview
- Revalidate the domain name, managed ISO, active default network, active default pool, and reported pool capacity before staging and approval
- Create supported Linux guests through a typed root helper only after owner password reauthentication
- Verify the domain identity, disk, default network, and autostart state after creation
- Remove only the newly created exact-name domain and allocated storage if creation verification fails
- Create an internal snapshot only while a persistent VM is stopped and every writable disk is an unchained qcow2 file inside the managed image directory
- Label the snapshot offline-consistent and explicitly not an independent backup
- Detect an already active Cockpit socket and show a Tailscale-hostname console handoff without opening or configuring the service
- Reverify a completed local export and copy it into an encrypted restic repository only when `/mnt/boxpilot-backup` is a writable independent mount
- Restore one exact encrypted snapshot, boot it transiently with no network, require repeated QEMU guest-agent health, and mark only that passing record protected
- Read every data pack in the repository and confirm exact snapshot identity before recording evidence
- Restore a protected snapshot into a new persistent recovery domain that remains stopped, non-autostarting, and network-isolated

The release does not delete VMs, force power off, provide general XML editing, open a web console proxy, create online snapshots, revert or delete snapshots, overwrite a VM in place, attach a recovered VM to a network, change non-default storage pools, build a network bridge, generate cloud-init media, or create Windows 11 guests. Windows 11 remains locked until TPM 2.0 and Secure Boot checks exist.

## 1. Prepare Ubuntu for virtualization

First open authenticated **Repair Center**. If the KVM kernel interface is registered, no partial provider exists, and all configured Ubuntu candidates are available, select **Review virtualization install**. The hardened helper reads only fixed `/sys/class/misc/kvm/dev` kernel evidence because its private-device namespace hides the host node. Review all five exact root versions, stage the immutable plan, and re-enter the owner password. The separately sandboxed static installer still requires the actual host `/dev/kvm`, then enables and starts `libvirtd.service` and verifies QEMU plus `qemu:///system`. It does not create a network, storage pool, disk, media attachment, or VM.

The console fallback for Ubuntu 26.04 is:

```bash
sudo apt update
sudo apt install -y qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst ovmf
sudo systemctl enable --now libvirtd.service
test -c /dev/kvm
sudo virsh --connect qemu:///system uri
qemu-system-x86_64 --version
```

Default network and storage-pool initialization are separate from the prerequisite job. In **Virtual Machines**, find **Default VM foundation**, select **Review setup plan**, review the fixed NAT subnet and image path, stage the job, then approve it with the owner password in **Repair Center**. BoxPilot defines missing canonical resources, starts inactive compatible resources, enables autostart, and verifies the result. It accepts no resource value from the browser and never changes other networks or pools.

If the canonical definitions already exist, these console commands are a manual recovery fallback for inactive state only:

```bash
sudo install -d -m 0755 /var/lib/libvirt/boot
sudo virsh net-start default || true
sudo virsh net-autostart default
sudo virsh pool-start default || true
sudo virsh pool-autostart default
```

Then verify:

```bash
sudo virsh --connect qemu:///system list --all
sudo virsh --connect qemu:///system net-list --all
sudo virsh --connect qemu:///system pool-list --all
```

If `/dev/kvm` is unavailable, enable Intel VT-x or AMD-V in the server firmware. If Ubuntu itself is running inside another hypervisor, nested virtualization must also be enabled by that outer hypervisor. BoxPilot refuses automatic installation over partial provider state; repair that state from the console rather than asking the platform to guess at replacement.

## 2. Install BoxPilot as a native service

### One-command install (recommended)

On a fresh Ubuntu Server (24.04 or newer) with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh
```

The installer adds Node.js 24 (checksum-verified, under `/opt/node-v24.x`), creates the `boxpilot` user and `/etc/boxpilot`, builds BoxPilot into `/opt/boxpilot`, installs and enables the systemd units, and prints the URL plus a one-time owner bootstrap token. Access defaults to Tailscale Serve when `tailscaled` is running, otherwise plain HTTP on the LAN; pass `--access tailscale|lan|local`, `--ref <branch>`, or `--port <n>` to change that. Re-running it upgrades in place.

### Upgrading an existing native install

Once BoxPilot is installed under `/opt/boxpilot`, later releases or branches can be deployed with one command. The script downloads the ref from GitHub, builds it in a staging directory, swaps `/opt/boxpilot` atomically, installs changed unit files, restarts the services, verifies `/api/v1/health`, and rolls back automatically if the new tree is unhealthy:

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-upgrade.sh | sudo sh -s -- main
```

Replace the trailing `main` with any branch or tag. It does not change `/etc/boxpilot`, `/var/lib/boxpilot`, systemd drop-ins, or the owner account.

### First installation


The default Docker deployment intentionally cannot reach host libvirt. Install the production build under `/opt/boxpilot` and run it with its own user:

```bash
sudo useradd --system --create-home --home-dir /var/lib/boxpilot --shell /usr/sbin/nologin boxpilot
sudo gpasswd -d boxpilot libvirt 2>/dev/null || true
sudo gpasswd -d boxpilot kvm 2>/dev/null || true
sudo git clone https://github.com/AES256Afro/BoxPilot.git /opt/boxpilot
cd /opt/boxpilot
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev
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

The units expect Node.js 24 or newer at `/usr/local/bin/node`. Check the installed path and version before enabling them:

```bash
command -v node
node --version
```

If Node is installed elsewhere, change `ExecStart` in both service files, run `sudo systemctl daemon-reload`, and restart BoxPilot.

The two `gpasswd -d` commands are required when upgrading an older BoxPilot installation that added the service account to virtualization groups. They do not remove virtualization access from your ordinary Ubuntu administrator account.

Check the native service and API:

```bash
sudo systemctl status boxpilot-helper boxpilot --no-pager
sudo journalctl -u boxpilot-helper -u boxpilot -n 100 --no-pager
curl http://127.0.0.1:8787/api/v1/health
```

Create the first owner with the token the installer printed, sign in, then open **Virtual Machines**. The preflight checklist names each missing requirement without changing the host. **Default VM foundation** either proves both fixed resources ready, offers the immutable setup plan, or reports the exact compatibility conflict that must be handled at the server console.

Run the read-only deployment doctor at any time:

```bash
cd /opt/boxpilot
sudo -u boxpilot npm run doctor
```

It checks Linux, required commands, the absence of direct virtualization groups, the helper socket, managed ISO media, the loopback health endpoint, and Tailscale. Authenticated BoxPilot preflight performs bounded libvirt, KVM, default-network, and default-pool inspection through the helper. The doctor does not install packages or change configuration.

The systemd unit creates `/var/lib/boxpilot` with mode `0700` for SQLite plans, approvals, jobs, results, and audit attribution plus the older bounded JSONL VM event file. It never records the owner password or a complete environment. Open **Repair Center** for durable job evidence and **Logs** for redacted fixed service journals. Tamper-evident audit chaining is not yet implemented.

## 3. Add installation media and create a VM

The working browser workflow is:

1. Open **Virtual Machines** and find **VM installation media**.
2. Select one `.iso` file no larger than 16 GiB and choose **Upload to staging**. BoxPilot streams it to the fixed staging directory and computes SHA-256. It is not yet usable for VM creation.
3. On the completed staged item, select **Review import**. Confirm the exact filename, byte count, complete SHA-256, fixed destination, non-overwrite rule, and rollback boundary.
4. Select **Stage for password approval**, open **Repair Center**, and re-enter the owner password.
5. Wait for source, copy, and final managed-library verification to pass. Return to **Virtual Machines** and refresh the media panel.

The upload accepts bytes, not a browser path. The helper accepts only the recorded filename, byte count, SHA-256, staging revision, and generated import id. It derives both fixed directories, keeps a 1 GiB free-space reserve, writes a generated partial, publishes without overwriting, and creates no domain, disk, network, pool, route, or listener. A changed staging file or conflicting managed filename fails closed.

The server-console fallback remains available for an administrator who has separately verified the image:

```bash
sudo install -d -m 0755 /var/lib/libvirt/boot
sudo cp /path/to/installer.iso /var/lib/libvirt/boot/
sudo chmod 0644 /var/lib/libvirt/boot/installer.iso
```

The production helper unit deliberately fixes the managed library to `/var/lib/libvirt/boot` and the upload staging directory to `/var/lib/boxpilot-managed/vm-media-inbox`. If a different dedicated library is required, a root administrator must update `BOXPILOT_ISO_DIRECTORY` consistently in both `/etc/boxpilot/boxpilot.env` and `boxpilot-helper.service`, then reload systemd and restart both services. Do not point either boundary at `/`, a home directory, or a directory containing secrets. Do not make the managed library writable by the web service.

In BoxPilot:

1. Select **Plan new VM**.
2. Choose the guest name, operating-system profile, vCPU, memory, disk, managed ISO, default NAT network, firmware, and autostart preference.
3. Select **Generate reviewed plan**.
4. Review capacity warnings, the immutable plan revision, the structured `virt-install` preview, and the execution guardrails.
5. Select **Stage for password approval**. This rechecks live host state and creates an awaiting-approval job without creating a disk or domain.
6. Open **Repair Center**, review the recovery instructions, and approve with the owner password.
7. Return to **Virtual Machines** and refresh the live inventory.

The planning API verifies numeric limits, rejects unsafe ISO names and path traversal, checks that the ISO is a regular discovered file, refuses an existing domain name, and rejects a disk larger than the reported free space in the default pool. Planning and staging never invoke `virt-install`. Approval invokes one typed helper operation. The helper independently derives the binary, libvirt URI, ISO path, storage-pool arguments, network arguments, and rollback target. It does not accept shell text, an executable, an argument array, or a path from the web service.

## 4. Publish BoxPilot privately through Tailscale

Keep BoxPilot bound to loopback and publish it only to the tailnet:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Use the HTTPS URL displayed by `tailscale serve status`. Keep Funnel disabled. If MagicDNS is enabled, the URL normally uses the server's tailnet name. The Virtual Machines page also reports that URL when the local Tailscale client exposes it.

Tailscale DNS Override can remain off. BoxPilot does not require a tailnet-wide DNS override to use Tailscale Serve.

If `cockpit.socket` is already active, BoxPilot shows a console handoff using the host's Tailscale DNS name and Cockpit's standard HTTPS port. This is a link to a separate service, not a BoxPilot console grant. Cockpit keeps its own authentication and TLS behavior. Verify that port `9090` is reachable only from networks you intend before using the handoff. If Cockpit is absent or inactive, BoxPilot shows recovery guidance and makes no change.

## 5. Use guarded lifecycle controls

1. Open **Virtual Machines** and refresh live state.
2. Select **Start**, **Shut down**, **Reboot**, or an autostart change on a managed domain.
3. Review current state, desired state, exact changes, recovery limits, and the immutable revision.
4. Select **Stage for password approval**. BoxPilot rejects the stage if state changed after planning.
5. In **Repair Center**, review the job and re-enter the owner password.
6. The helper independently checks exact domain state and autostart, runs one fixed `virsh` verb, and reads back post-operation state.

There is no lifecycle bearer token or configuration switch. The old direct mutation route has been removed. Graceful shutdown waits up to two minutes for the stopped state. A reboot job verifies that libvirt accepted the request and the domain remains running; guest or application health still requires a guest agent or workload-specific check. There is intentionally no `destroy`, force-off, delete, XML edit, or arbitrary action.

## 6. Create a guarded offline snapshot

1. Shut down the guest normally and refresh **Virtual Machines** until its state is `stopped`.
2. Select **Plan snapshot** and enter a constrained unique name.
3. Review the offline consistency label, existing snapshot count, managed disk targets, storage-growth warning, and recovery boundary.
4. Select **Stage for password approval**.
5. In **Repair Center**, review and approve with the owner password.
6. Refresh the VM and confirm the snapshot is listed as internal and current.

The helper rechecks the exact domain UUID, stopped state, snapshot inventory, name absence, disk root, regular-file and no-symlink state, qcow2 format, and absence of a backing chain. It derives all disk paths from libvirt. The browser cannot supply a disk path, description, command, option, or libvirt URI.

This is a storage checkpoint on the same VM disk, not a backup. BoxPilot does not report the VM as protected and does not offer revert or delete. If snapshot verification fails, leave the VM stopped and inspect its metadata and disk chain before any manual change.

## 7. Export a stopped VM to a verified local artifact

1. Keep the domain stopped.
2. In **Virtual Machines**, select **Plan export**.
3. Review allocated size, required capacity, free destination space, exact file changes, integrity checks, and the protection warnings.
4. Stage the immutable plan and move to **Repair Center**.
5. Re-enter the owner password. The approval request returns after the background job starts.
6. Leave the VM stopped until the job completes or fails. Repair Center refreshes active jobs automatically.
7. On completion, inspect **VM integrity exports**. The record must say **Not encrypted**, **Not protected**, and **Restore drill not run**.

The helper derives every source disk from libvirt and writes only beneath `/var/lib/boxpilot-managed/vm-exports`. It rejects running or transient domains, non-file storage, paths outside the managed image root, symlinks, empty disks, non-qcow2 formats, backing chains, stale domain UUIDs, changed disk or snapshot revisions, and insufficient destination capacity. Existing internal snapshot history is flattened into the exported current disk state.

This local export is not yet disaster recovery. Use the next workflow to create an independent encrypted copy. An isolated restore boot is still required before BoxPilot can report VM protection.

## 8. Configure an independent encrypted VM copy

Do not create `/mnt/boxpilot-backup` as an ordinary directory on the server root disk. Attach and mount an external disk or a separately mounted NAS filesystem at that exact path. BoxPilot rejects the destination if its filesystem device matches either local exports or VM images.

Install restic and run the interactive fixed-path setup utility:

```bash
sudo apt update
sudo apt install -y restic
sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh
sudo systemctl restart boxpilot-helper boxpilot
```

The utility prompts without echo, writes a root-owned mode-`0600` password file, and initializes `/mnt/boxpilot-backup/restic-vm`. It does not accept a password or repository path as an argument. Keep a separate recovery copy of the password outside the server.

Then:

1. Open **Virtual Machines** and confirm **Encrypted independent destination** says **ready**.
2. Select **Plan encrypted backup** on a completed local export.
3. Review the exact export size, destination free space, repository verification, recovery-key warning, and immutable revision.
4. Stage the plan and approve it with the owner password in **Repair Center**.
5. Leave the mount attached until the background job completes or fails.
6. Confirm the new record says **encrypted independent restic snapshot**, **Repository data verified**, and **not protected**.

The helper rehashes every local file, uses server-generated restic tags, reads every repository data pack, and confirms the exact snapshot. The full repository check is deliberately compatible with Ubuntu 26.04's restic 0.18.1 package and can take longer as history grows. This copy operation never runs restic retention or deletion commands. A failed verification leaves both the local export and repository intact.

The new record remains not protected until its isolated restore drill passes. Do not delete the local export or source VM based only on copy evidence.

## 9. Run an isolated restore drill

The source guest must have `qemu-guest-agent` installed and enabled before it is exported. On Ubuntu guests:

```bash
sudo apt update
sudo apt install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
```

Then:

1. Open **Virtual Machines** and find the encrypted independent backup record.
2. Select **Plan isolated restore drill**.
3. Review the exact snapshot identity, required temporary capacity, generated transient-domain policy, no-network boundary, warnings, and cleanup contract.
4. Stage the immutable plan, open **Repair Center**, and approve it with the owner password.
5. Leave the independent mount attached while restic restores and verifies the snapshot. The job may take hours for a large disk.
6. Confirm the job records repeated guest-agent health and complete cleanup and the backup record changes to **protected**.

BoxPilot restores only into `/var/lib/libvirt/images/boxpilot-restore-drills/<server-generated-uuid>`. It rejects unexpected export files and unsafe disk targets, rehashes every file, runs `qemu-img check`, and grants the `libvirt-qemu` group temporary read access only to the verified restored qcow2 paths. The generated libvirt domain is transient and has zero network interfaces. BIOS and UEFI exports are supported; generated UEFI NVRAM is removed after the transient domain is destroyed.

If guest-agent health never arrives, the job fails without changing protection state. BoxPilot attempts exact-domain and generated-NVRAM cleanup, revokes temporary QEMU disk permissions, and preserves the restored files as root-only evidence. The drill proves boot and guest-agent health only. It does not prove application-level network services.

## 10. Create a guarded recovery clone

Only a backup already marked **protected** by the complete isolated restore drill can enter this workflow.

1. Open **Virtual Machines** and select **Create recovery clone** on a protected backup.
2. Enter a new constrained domain name. BoxPilot will not overwrite an existing name and reserves the entire `boxpilot-drill-` namespace.
3. Review the exact protected snapshot identity, recovered size, new storage location, fixed guest resources, stopped state, zero-network policy, disabled autostart, and rollback boundary.
4. Stage the immutable plan, open **Repair Center**, and approve it with the owner password.
5. Leave the independent backup mount attached while the background restore and verification run.
6. On completion, refresh **Virtual Machines**. The new domain and recovery record must both report stopped state, no interface, and autostart off.
7. Use the ordinary separately approved **Start** action and the private Cockpit handoff if you are ready to inspect the guest. Do not attach it to a network until you have resolved hostname, static IP, DNS, service identity, and application conflict risks manually.

The helper restores first into the fixed drill staging root, verifies the exact restic snapshot, manifest, logical size, checksums, expected files, and every qcow2 structure, then moves only the verified export beneath `/var/lib/libvirt/images/boxpilot-recoveries/<server-generated-uuid>`. It generates a fixed persistent libvirt definition with 2 vCPUs, 2048 MiB, the source firmware mode, exact recovered disk paths, a guest-agent channel, SPICE bound to loopback, and no network interface. It explicitly disables autostart and verifies a new UUID, stopped state, persistence, disk paths, and zero interfaces. It does not boot the clone during creation.

The source VM, source disks, local export, protected snapshot, repository history, and existing domains are never changed. Before libvirt definition, a failure preserves root-only staging evidence. After definition begins, BoxPilot removes only the separately named stopped zero-interface domain and its exact server-generated recovery directory when strict rollback validation passes. A helper or host crash after definition may leave a stopped isolated clone for manual inspection. BoxPilot does not guess that it is safe to delete.

This is recovery materialization, not cutover. In-place replacement, automatic route changes, network attachment, source deletion, and application-level acceptance are unavailable.

## 11. Apply guarded VM backup retention

Retention is unavailable until the independent repository contains attributable durable VM backup records. Select **Review retention** in **Virtual Machines** to generate a fresh preview.

The fixed policy keeps the three newest active backups for every VM, every backup under 30 days old, every backup without passing restore-drill evidence, every backup referenced by a recovery clone, and every backup currently consumed by an applying or verifying restore/recovery job. If a BoxPilot-tagged restic snapshot is not attributable to an active local record, or an active record is missing from the repository, the plan blocks for investigation.

1. Review every exact candidate, age, size, and snapshot prefix.
2. Confirm the warnings state that forgetting cannot be automatically undone and prune is disabled.
3. Stage the immutable high-risk plan, open **Repair Center**, and re-enter the owner password.
4. Keep the independent mount attached while BoxPilot forgets the exact full snapshot ids and reads the repository.
5. Confirm the completed job proves each approved id absent, every noncandidate id present, and `prunePerformed: false`.
6. Confirm forgotten records remain visible as historical evidence and no longer offer restore-drill or recovery actions.

One run accepts no more than 100 exact candidates. Additional candidates are deferred to another independently reviewed batch. The browser cannot supply a repository, path, password, age, count, restic selector, tag, argument, or prune flag. This release does not reclaim disk space.

## 12. Choose VM networking deliberately

Start with libvirt's default NAT network. Guests receive an address such as `192.168.122.x`, can reach the internet, and remain separated from the main `192.168.8.x` LAN.

To reach a guest application remotely, use one of these approaches:

1. Install Tailscale inside the guest. This is the recommended first choice because the guest gets its own stable tailnet name and access policy.
2. Forward a specific host port to the NAT guest after BoxPilot gains a guarded firewall workflow.
3. Use a bridged interface only when the guest must appear directly on the LAN.

A bridge can interrupt the server's only network connection. BoxPilot will not automate bridging until it can create a connectivity checkpoint, display console recovery commands, and verify the new route. Do not bridge Wi-Fi interfaces as if they were ordinary Ethernet ports.

## 13. Troubleshoot safely

### The system connection fails

```bash
sudo systemctl status libvirtd --no-pager
sudo systemctl restart libvirtd
sudo virsh --connect qemu:///system list --all
sudo systemctl restart boxpilot-helper boxpilot
```

Do not add `boxpilot` to `libvirt` or `kvm`. Confirm `/run/boxpilot/helper.sock` is owned by `root:boxpilot` with mode `0660`, then inspect both service journals.

### A guest has no displayed IP

BoxPilot combines lease and QEMU guest-agent address sources. A static guest address, bridge, unavailable guest agent, or address assigned outside those sources may still not appear. Check inside the guest. BoxPilot does not guess an address.

### Graceful shutdown does not finish

The guest operating system must respond to ACPI shutdown. Use its console or SSH into the guest and shut it down normally. BoxPilot does not offer a force-off button because that can corrupt guest filesystems.

### BoxPilot starts but preflight fails

Run:

```bash
sudo -u boxpilot id -nG
sudo -u boxpilot test -S /run/boxpilot/helper.sock && sudo -u boxpilot test -w /run/boxpilot/helper.sock
sudo journalctl -u boxpilot-helper -u boxpilot -n 100 --no-pager
```

Correct the specific failed requirement and refresh the page. Do not loosen the libvirt socket to world-writable permissions.

### The encrypted destination stays blocked

```bash
findmnt --mountpoint /mnt/boxpilot-backup
stat -c '%d %n' /mnt/boxpilot-backup /var/lib/boxpilot-managed /var/lib/libvirt/images
sudo stat -c '%U:%G %a %s %n' /etc/boxpilot/secrets/vm-backup-restic-password
sudo restic --repo /mnt/boxpilot-backup/restic-vm --password-file /etc/boxpilot/secrets/vm-backup-restic-password snapshots
sudo systemctl restart boxpilot-helper boxpilot
```

The first device number must differ from both server source locations. The password file must be `root:root`, mode `600`, and not a symlink. Restarting the helper after mounting ensures its hardened filesystem namespace sees the independent mount.

## 14. Security boundary

Membership in the `libvirt` group is powerful. In `0.26.0`, the native web service has no `libvirt` or `kvm` supplementary groups. Read-only libvirt inventory and all shipped VM mutations cross the typed helper socket. The helper still runs as root, so its exact schema, fixed binaries, fixed URI, path roots, fixed repository/password paths, temporary and persistent QEMU access, systemd confinement, and private exposure remain security-critical. Keep the service loopback-only, keep Funnel off, and do not treat this release as an internet-facing appliance.

Operations Core records typed Unix-socket requests and durable approvals. VM media import, VM creation, lifecycle actions, offline snapshots, stopped-VM exports, encrypted mounted-restic copies, isolated restore drills, stopped no-network recovery clones, and exact no-prune retention have operation-specific helper handlers. Authenticated ISO upload is confined to one staging directory and cannot publish media without the separate helper job. Arbitrary URL download, automatic vendor-image acquisition, storage administration, bridges, online snapshots, snapshot revert/delete, in-place restore, recovered-VM network attachment, application-level restore tests, configurable retention, restic prune, migration activation, console proxy, and delete remain locked until their recovery checkpoints, path rules, and negative tests are complete.
