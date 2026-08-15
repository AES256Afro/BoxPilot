# QEMU/KVM setup and operation

BoxPilot `0.9.1` can inspect a local libvirt system connection, create supported Linux virtual machines through durable approved jobs, and manage a deliberately small set of virtual-machine lifecycle operations after owner authentication. It is intended for the Ubuntu server itself, not a remote libvirt daemon.

## What works now

- Detect Linux, `/dev/kvm`, QEMU, `virsh`, `virt-install`, and the service user's groups
- Check the default libvirt NAT network and storage pool
- List persistent VMs with state, vCPU, maximum memory, autostart, and lease-reported IP addresses
- Start a stopped VM
- Request graceful shutdown or reboot of a running VM
- Enable or disable VM autostart
- Detect the host's Tailscale name and an existing Tailscale Serve URL
- Discover managed ISO images, libvirt networks, pools, guest disks, interfaces, and snapshot count
- Validate and durably store a new VM plan with an exact `virt-install` preview
- Revalidate the domain name, managed ISO, active default network, active default pool, and reported pool capacity before staging and approval
- Create supported Linux guests through a typed root helper only after owner password reauthentication
- Verify the domain identity, disk, default network, and autostart state after creation
- Remove only the newly created exact-name domain and allocated storage if creation verification fails

The release does not delete VMs, force power off, edit definitions, open a web console, make snapshots, change storage pools, build a network bridge, generate cloud-init media, or create Windows 11 guests. Windows 11 remains locked until TPM 2.0 and Secure Boot checks exist. The existing lifecycle controls remain a provisional fixed-argument route rather than durable jobs.

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
sudo usermod -aG libvirt,kvm boxpilot
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

It checks Linux, KVM access, required commands, groups, libvirt, the default network and pool, managed ISO media, the loopback health endpoint, and Tailscale. It does not install packages or change configuration.

The systemd unit creates `/var/lib/boxpilot` with mode `0700` for redacted audit events. The service records successful creation plans plus requested, completed, and failed lifecycle operations. It never records the administrator token or a complete environment. Open **Logs** in BoxPilot to see the newest events. This JSONL foundation is not yet a tamper-evident, owner-attributed audit ledger.

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

## 5. Unlock the guarded lifecycle controls

Leave the controls locked until read-only discovery works. Generate a dedicated random token on the server:

```bash
openssl rand -hex 32
```

Edit `/etc/boxpilot/boxpilot.env` as root and set:

```ini
BOXPILOT_VM_ACTIONS_ENABLED=true
BOXPILOT_ADMIN_TOKEN=paste-the-random-token-here
```

Protect and activate the configuration:

```bash
sudo chmod 0600 /etc/boxpilot/boxpilot.env
sudo systemctl restart boxpilot
curl http://127.0.0.1:8787/api/v1/capabilities
```

Enter the token only when the Virtual Machines page requests it. The browser keeps it in component memory and does not persist it to local storage. Lifecycle buttons still require confirmation and can invoke only `start`, `shutdown`, `reboot`, and autostart on or off. There is intentionally no `destroy` or force-off action.

## 6. Choose VM networking deliberately

Start with libvirt's default NAT network. Guests receive an address such as `192.168.122.x`, can reach the internet, and remain separated from the main `192.168.8.x` LAN.

To reach a guest application remotely, use one of these approaches:

1. Install Tailscale inside the guest. This is the recommended first choice because the guest gets its own stable tailnet name and access policy.
2. Forward a specific host port to the NAT guest after BoxPilot gains a guarded firewall workflow.
3. Use a bridged interface only when the guest must appear directly on the LAN.

A bridge can interrupt the server's only network connection. BoxPilot will not automate bridging until it can create a connectivity checkpoint, display console recovery commands, and verify the new route. Do not bridge Wi-Fi interfaces as if they were ordinary Ethernet ports.

## 7. Troubleshoot safely

### The system connection fails

```bash
sudo systemctl status libvirtd --no-pager
sudo systemctl restart libvirtd
sudo -u boxpilot virsh --connect qemu:///system list --all
```

Confirm `boxpilot` belongs to `libvirt` and restart the BoxPilot service after group changes.

### A guest has no displayed IP

`virsh domifaddr --source lease` only reports addresses known from libvirt DHCP leases. A static guest address, a bridge, or an address assigned outside libvirt DHCP may not appear. Check inside the guest or install the QEMU guest agent. BoxPilot does not guess an address.

### Graceful shutdown does not finish

The guest operating system must respond to ACPI shutdown. Use its console or SSH into the guest and shut it down normally. BoxPilot does not offer a force-off button because that can corrupt guest filesystems.

### BoxPilot starts but preflight fails

Run:

```bash
sudo -u boxpilot id -nG
sudo -u boxpilot test -r /dev/kvm && sudo -u boxpilot test -w /dev/kvm
sudo -u boxpilot virsh --connect qemu:///system uri
sudo journalctl -u boxpilot -n 100 --no-pager
```

Correct the specific failed requirement and refresh the page. Do not loosen the libvirt socket to world-writable permissions.

## Security boundary

Membership in the `libvirt` group is powerful. In `0.9.1`, the native BoxPilot process still has that membership so it can inspect libvirt and issue the provisional small action allowlist. VM creation itself has moved to the root helper, but lifecycle mutations have not. A compromised web process would still have the operating-system permissions of the `boxpilot` service account. Keep the service loopback-only, keep Funnel off, protect the token, and do not treat this release as an internet-facing appliance.

The Operations Core now proves typed Unix-socket requests and durable approvals with a no-mutation canary. VM creation, storage, bridges, snapshots, backup, migration, and console access remain locked until their operation-specific helper handlers, recovery checkpoints, path rules, and negative tests are complete.
