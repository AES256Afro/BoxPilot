# QEMU/KVM setup and operation

BoxPilot `0.11.0` can inspect a local libvirt system connection through its restricted helper, create supported Linux virtual machines through durable approved jobs, manage a deliberately small set of lifecycle operations, report QEMU guest-agent and snapshot state, and create guarded offline internal snapshots. It is intended for the Ubuntu server itself, not a remote libvirt daemon.

## What works now

- Detect Linux, KVM support through libvirt, QEMU, `virsh`, `virt-install`, and the restricted helper boundary
- Check the default libvirt NAT network and storage pool
- List persistent VMs with state, vCPU, maximum memory, autostart, lease- and guest-agent-reported IP addresses, guest-agent status, filesystem-freeze state, and bounded snapshot metadata
- Start a stopped VM
- Request graceful shutdown or reboot of a running VM
- Enable or disable VM autostart
- Review current and desired lifecycle state before staging an immutable plan
- Revalidate lifecycle state before staging, after password approval, and after the fixed helper operation
- Detect the host's Tailscale name and an existing Tailscale Serve URL
- Discover managed ISO images, libvirt networks, pools, guest disks, interfaces, and snapshot count
- Validate and durably store a new VM plan with an exact `virt-install` preview
- Revalidate the domain name, managed ISO, active default network, active default pool, and reported pool capacity before staging and approval
- Create supported Linux guests through a typed root helper only after owner password reauthentication
- Verify the domain identity, disk, default network, and autostart state after creation
- Remove only the newly created exact-name domain and allocated storage if creation verification fails
- Create an internal snapshot only while a persistent VM is stopped and every writable disk is an unchained qcow2 file inside the managed image directory
- Label the snapshot offline-consistent and explicitly not an independent backup
- Detect an already active Cockpit socket and show a Tailscale-hostname console handoff without opening or configuring the service

The release does not delete VMs, force power off, edit definitions, open a web console proxy, create online snapshots, revert or delete snapshots, change storage pools, build a network bridge, generate cloud-init media, or create Windows 11 guests. Windows 11 remains locked until TPM 2.0 and Secure Boot checks exist.

## 1. Prepare Ubuntu for virtualization

Run these commands at the physical console or through an SSH session you can recover if networking changes later:

```bash
sudo apt update
sudo apt install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst cpu-checker
sudo adduser "$USER" libvirt
sudo adduser "$USER" kvm
sudo install -d -m 0755 /var/lib/libvirt/boot
sudo virsh net-start default || true
sudo virsh net-autostart default
sudo virsh pool-start default || true
sudo virsh pool-autostart default
```

Log out and back in so the new groups apply. Then verify:

```bash
kvm-ok
id -nG
virsh --connect qemu:///system list --all
virsh --connect qemu:///system net-list --all
virsh --connect qemu:///system pool-list --all
```

If `kvm-ok` reports that acceleration cannot be used, enable Intel VT-x or AMD-V in the server firmware. If Ubuntu itself is running inside another hypervisor, nested virtualization must also be enabled by that outer hypervisor.

## 2. Install BoxPilot as a native service

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
sudo install -m 0644 deploy/boxpilot-helper.service /etc/systemd/system/boxpilot-helper.service
sudo install -m 0644 deploy/boxpilot.service /etc/systemd/system/boxpilot.service
sudo systemctl daemon-reload
sudo systemctl enable --now boxpilot-helper.service boxpilot.service
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

Create the first owner using [Operations Core setup and recovery](OPERATIONS-CORE.md), sign in, then open **Virtual Machines**. The preflight checklist names each missing requirement without changing the host.

Run the read-only deployment doctor at any time:

```bash
cd /opt/boxpilot
sudo -u boxpilot npm run doctor
```

It checks Linux, required commands, the absence of direct virtualization groups, the helper socket, managed ISO media, the loopback health endpoint, and Tailscale. Authenticated BoxPilot preflight performs bounded libvirt, KVM, default-network, and default-pool inspection through the helper. The doctor does not install packages or change configuration.

The systemd unit creates `/var/lib/boxpilot` with mode `0700` for SQLite plans, approvals, jobs, results, and audit attribution plus the older bounded JSONL VM event file. It never records the owner password or a complete environment. Open **Repair Center** for durable job evidence and **Logs** for redacted fixed service journals. Tamper-evident audit chaining is not yet implemented.

## 3. Add installation media and create a VM

Copy an installer ISO into the configured managed-media directory:

```bash
sudo install -d -m 0755 /var/lib/libvirt/boot
sudo cp /path/to/installer.iso /var/lib/libvirt/boot/
sudo chmod 0644 /var/lib/libvirt/boot/installer.iso
```

The production helper unit deliberately fixes this directory to `/var/lib/libvirt/boot`. If a different dedicated directory is required, a root administrator must update `BOXPILOT_ISO_DIRECTORY` consistently in both `/etc/boxpilot/boxpilot.env` and `boxpilot-helper.service`, then reload systemd and restart both services. Do not point it at `/`, a home directory, a writable upload directory, or a directory containing secrets.

In BoxPilot:

1. Open **Virtual Machines**.
2. Select **Plan new VM**.
3. Choose the guest name, operating-system profile, vCPU, memory, disk, managed ISO, default NAT network, firmware, and autostart preference.
4. Select **Generate reviewed plan**.
5. Review capacity warnings, the immutable plan revision, the structured `virt-install` preview, and the execution guardrails.
6. Select **Stage for password approval**. This rechecks live host state and creates an awaiting-approval job without creating a disk or domain.
7. Open **Repair Center**, review the recovery instructions, and approve with the owner password.
8. Return to **Virtual Machines** and refresh the live inventory.

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

## 7. Choose VM networking deliberately

Start with libvirt's default NAT network. Guests receive an address such as `192.168.122.x`, can reach the internet, and remain separated from the main `192.168.8.x` LAN.

To reach a guest application remotely, use one of these approaches:

1. Install Tailscale inside the guest. This is the recommended first choice because the guest gets its own stable tailnet name and access policy.
2. Forward a specific host port to the NAT guest after BoxPilot gains a guarded firewall workflow.
3. Use a bridged interface only when the guest must appear directly on the LAN.

A bridge can interrupt the server's only network connection. BoxPilot will not automate bridging until it can create a connectivity checkpoint, display console recovery commands, and verify the new route. Do not bridge Wi-Fi interfaces as if they were ordinary Ethernet ports.

## 8. Troubleshoot safely

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

## Security boundary

Membership in the `libvirt` group is powerful. In `0.11.0`, the native web service has no `libvirt` or `kvm` supplementary groups. Read-only libvirt inventory and all shipped VM mutations cross the typed helper socket. The helper still runs as root, so its exact schema, fixed binaries, fixed URI, path roots, systemd confinement, and private exposure remain security-critical. Keep the service loopback-only, keep Funnel off, and do not treat this release as an internet-facing appliance.

Operations Core records typed Unix-socket requests and durable approvals. VM creation, lifecycle actions, and offline snapshot creation have operation-specific helper handlers. Storage administration, bridges, online snapshots, snapshot revert/delete, VM backup, migration transfer, console proxy, and delete remain locked until their recovery checkpoints, path rules, and negative tests are complete.
