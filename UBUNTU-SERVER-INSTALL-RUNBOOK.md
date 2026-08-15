# Ubuntu Server Headless Docker and VM Installation Runbook

This runbook covers the complete process from inserting the USB installer through a verified headless Ubuntu Server with:

- Target reserved LAN address `192.168.8.10`
- AdGuard DNS
- OpenSSH
- Tailscale
- UFW firewall
- Docker Engine and Docker Compose
- KVM/libvirt virtual machines
- Cockpit web administration
- Disk-health checks and a backup readiness checklist

It is written for Ubuntu Server 24.04 LTS or 26.04 LTS. Some screen wording may differ slightly, but the choices are the same.

## Known network settings

| Setting | Value |
| --- | --- |
| Hostname | `bigbox` |
| Router | GL.iNet GL-MT6000 Flint 2 |
| Router LAN address | `192.168.8.1` |
| Address method | DHCP with router reservation |
| Target reserved IPv4 address | `192.168.8.10` |
| LAN subnet | `192.168.8.0/24` |
| Reserved Ethernet MAC | `A0:AD:9F:87:AD:EE` |
| AdGuard DNS 1 | `94.140.14.49` |
| AdGuard DNS 2 | `94.140.14.59` |
| Tailscale DNS Override | Off during installation and recovery |
| MagicDNS | On |

The Flint 2 DHCP reservation provides the fixed address. Leave Ubuntu on automatic DHCP so the router continues providing the correct gateway and routes. Until that reservation is saved and the lease is renewed, Bigbox may receive another `192.168.8.x` address. Use the address shown by `ip -br address` for immediate SSH access.

## Stage 0: Prepare the machine safely

1. Shut down the future server.
2. Disconnect any external backup disks, recovery disks, or disks that must not be erased.
3. If the failed old disk might be sent for data recovery, disconnect it before installing Ubuntu.
4. Leave connected only:
   - The new intended system disk
   - Monitor
   - Keyboard
   - Wired Ethernet cable
   - Ubuntu Server installer USB stick
5. Connect the Ethernet cable directly to the normal LAN.
6. In the Flint 2 interface at `http://192.168.8.1`, make sure the reservation for `192.168.8.10` is enabled and uses MAC address `A0:AD:9F:87:AD:EE`.
7. If entering the firmware setup is convenient, enable the relevant virtualization options:
   - Intel: Intel Virtualization Technology, VT-x, and preferably VT-d
   - AMD: SVM or AMD-V, and preferably IOMMU
8. Prefer UEFI boot. Secure Boot can remain enabled.

Warning: the Ubuntu storage step will erase the selected destination disk. Disk selection is the irreversible part of this procedure.

## Stage 1: Boot the Ubuntu USB stick

1. Insert the Ubuntu Server USB stick.
2. Power on the server.
3. Immediately tap the one-time boot-menu key repeatedly.
   - Common keys are `F12`, `F11`, `F10`, `F9`, or `Esc`.
   - `Delete` or `F2` usually opens the full firmware setup instead.
4. Select the entry beginning with `UEFI` followed by the USB manufacturer's name.
5. If the USB appears twice, select its UEFI entry rather than Legacy or CSM.
6. At the Ubuntu boot menu, highlight **Try or Install Ubuntu Server** and press Enter.
7. Wait for the text installer to load. A black screen for a short period is normal.

If the installer never appears:

1. Reopen the boot menu and verify the UEFI USB entry was selected.
2. Try a rear motherboard USB port.
3. Recreate the USB installer if the stick produces read or checksum errors.

## Stage 2: Complete every installer screen

### 2.1 Choose language

1. Select **English**.
2. Press Enter.

### 2.2 Installer update

If the installer offers an update:

1. Select **Update to the new installer**.
2. Wait for it to download and restart the installer.

If the update fails because the network is not ready, continue with the installer version on the USB.

### 2.3 Keyboard configuration

1. Layout: **English (US)**.
2. Variant: **English (US)**.
3. Select **Done**.

Use the keyboard identification tool only if the physical keyboard is not a normal US layout.

### 2.4 Installation type

1. Select **Ubuntu Server**.
2. Do not select the minimized installation. The standard server install is more convenient for Docker, KVM, troubleshooting, and hardware tools.
3. If a third-party driver option appears, leave its default unless the installer specifically reports that the network or storage controller needs it.
4. Select **Done**.

### 2.5 Network configuration

1. Highlight the wired Ethernet interface.
2. Open its information or edit screen.
3. Confirm its MAC address is `A0:AD:9F:87:AD:EE`.
4. Select **Edit IPv4**.
5. Set IPv4 Method to **Automatic (DHCP)**.
6. Save the setting.
7. Leave IPv6 at its existing automatic setting.
8. Do not create a bond, bridge, or VLAN during installation.
9. Wait up to 30 seconds for DHCP.
10. If the Flint reservation is already active, confirm the interface displays `192.168.8.10/24`. Otherwise, record the temporary `192.168.8.x/24` address shown by the installer.
11. Select **Done**.

If the installer receives a different address:

1. Recheck the interface MAC address.
2. Correct the router reservation if the shown MAC differs.
3. Disconnect and reconnect the Ethernet cable or return to the interface and reselect automatic DHCP.
4. A temporary DHCP address can complete installation and provide immediate SSH access, but correct the Flint reservation before relying on a permanent LAN address.

Use manual addressing only if DHCP is unavailable. The manual fields would be:

| Field | Value |
| --- | --- |
| Subnet | `192.168.8.0/24` |
| Address | `192.168.8.10` |
| Gateway | Confirm the router LAN address, likely `192.168.8.1` |
| Name servers | `94.140.14.49,94.140.14.59` |
| Search domains | Leave blank |

Do not guess the gateway. The DHCP reservation is the recommended configuration.

### 2.6 Proxy configuration

1. Leave the proxy field blank.
2. Select **Done**.

### 2.7 Ubuntu archive mirror

1. Leave the default Ubuntu mirror selected.
2. Wait for the installer to report that the mirror check passed.
3. Select **Done**.

If the mirror test fails, return to the network screen and check the address, default route, and cable before continuing.

### 2.8 Guided storage configuration

1. Select **Use an entire disk**.
2. Select only the new intended system disk.
3. Verify its manufacturer and capacity. Do not rely only on Linux disk names such as `sda` or `nvme0n1`.
4. Leave **Set up this disk as an LVM group** checked.
5. Leave disk encryption unchecked if the server must restart unattended.
6. Do not choose custom storage unless a specific RAID, separate data disk, or advanced partition layout has already been planned.
7. Select **Done**.

On the storage summary screen:

1. Confirm the selected physical disk is the new intended disk.
2. Confirm there is an EFI boot partition.
3. Confirm there is a root filesystem mounted at `/`.
4. Check the root filesystem size. Docker images and VM disks can consume considerable space, so avoid an unexpectedly tiny root volume.
5. If the root filesystem is much smaller than expected while the volume group shows substantial unused space, stop at this screen and review the layout before confirming. Do not guess at storage changes.
6. Confirm no backup or recovery disk is listed for formatting.
7. Select **Done**.
8. Read the destructive-action warning.
9. Select **Continue** only when the destination is unquestionably correct.

### 2.9 Profile setup

Fill in the profile screen:

1. Your name: `Chris`, or the display name you prefer.
2. Server name: `bigbox`.
3. Username: `bigbox`.
4. Password: create a unique, strong password.
5. Confirm the password.
6. Record the username and password in your password manager.
7. Select **Done**.

The username cannot contain spaces. This account will use `sudo` for administration. Direct root login is not required.

### 2.10 Ubuntu Pro

1. Select **Skip for now** unless you already intend to attach a specific Ubuntu Pro subscription.
2. Select **Continue**.

Ubuntu Pro can be attached later without reinstalling the server.

### 2.11 SSH setup

1. Check **Install OpenSSH server**.
2. Keep password authentication enabled for the initial setup.
3. Do not import a GitHub identity unless a public SSH key has first been added to the intended GitHub account.
4. Select **Done**.

Password authentication will be disabled later, after SSH key access is tested from a second computer.

### 2.12 Featured server snaps

1. Select no optional snaps.
2. Do not install Docker from this screen.
3. Select **Done**.

Docker Engine will be installed later from Docker's official Ubuntu repository.

### 2.13 Wait for installation

1. Let the package installation and updates finish.
2. Do not power off the machine while filesystems or bootloader packages are being installed.
3. If an installer log view is open, return to the main progress view when needed.
4. Wait for **Install complete** and **Reboot Now**.
5. Select **Reboot Now**.
6. When told to remove the installation medium, remove the USB stick.
7. Press Enter.

If the computer returns to the installer, remove the USB and select the internal disk from the boot menu.

## Stage 3: First console login

1. Wait for the `bigbox login:` prompt.
2. Enter the username created during installation.
3. Enter the password. Linux does not display password characters while typing.
4. Confirm the hostname and timezone:

```bash
hostnamectl
timedatectl
```

5. If the timezone is not Central Time, set it:

```bash
sudo timedatectl set-timezone America/Chicago
timedatectl
```

## Stage 4: Verify LAN addressing and DNS

Run:

```bash
ip -br link
ip -br address
ip route
resolvectl status
getent ahostsv4 example.com
```

Expected results:

- The wired interface is up.
- It has `192.168.8.10/24`.
- A default route exists through the home router.
- DNS resolution returns addresses for `example.com`.

To display all interface MAC addresses:

```bash
ip -o link
```

The wired interface should show `a0:ad:9f:87:ad:ee`.

### Override only this server's DNS if necessary

If `resolvectl status` already lists `94.140.14.49` and `94.140.14.59`, skip this section.

If the router supplies different DNS servers and this server must explicitly use AdGuard, run these commands at the physical console:

```bash
wired_if=$(ip -o route show default | awk '{print $5; exit}')
echo "$wired_if"
sudo cp -a /etc/netplan "/etc/netplan.backup-$(date +%Y%m%d-%H%M%S)"
sudo netplan set "ethernets.${wired_if}.dhcp4-overrides.use-dns=false"
sudo netplan set "ethernets.${wired_if}.nameservers.addresses=[94.140.14.49,94.140.14.59]"
sudo netplan try
```

Confirm the configuration when prompted. `netplan try` automatically rolls back if it is not confirmed.

Then verify:

```bash
resolvectl status
getent ahostsv4 example.com
```

## Stage 5: Update Ubuntu and install base tools

Run each command:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates openssh-server ufw unattended-upgrades smartmontools nvme-cli tmux
sudo systemctl enable --now ssh
```

Check whether a reboot is requested:

```bash
test -f /var/run/reboot-required && cat /var/run/reboot-required || echo "No reboot required"
```

Reboot after the initial upgrade:

```bash
sudo reboot
```

Log in at the physical console again after the server restarts.

## Stage 6: Establish SSH key access from the Mac

On the Mac, open Terminal.

### 6.1 Check for an existing key

```bash
ls -l ~/.ssh/*.pub 2>/dev/null
```

If `id_ed25519.pub` exists, use it. If the existing key has another filename, substitute that filename in the copy command below. If no public key exists, create one:

```bash
ssh-keygen -t ed25519 -C "chris-mac-to-bigbox"
```

Press Enter to accept the default filename. Use a key passphrase and store it in the Mac Keychain when offered.

### 6.2 Install the Mac public key on Ubuntu

These commands use the configured Ubuntu username `bigbox`:

```bash
ssh bigbox@192.168.8.10 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < ~/.ssh/id_ed25519.pub
```

Enter the Ubuntu password once.

Test a new connection:

```bash
ssh bigbox@192.168.8.10
```

Do not disable password authentication until this key-based login succeeds in a completely separate Terminal window.

### 6.3 Disable SSH password login after the key works

While keeping one working SSH session open, run on Ubuntu:

```bash
sudo tee /etc/ssh/sshd_config.d/10-headless-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF

sudo sshd -t
sudo systemctl reload ssh
```

Open another Mac Terminal window and test again:

```bash
ssh bigbox@192.168.8.10
```

If the test fails, keep the original session open and remove or correct `/etc/ssh/sshd_config.d/10-headless-hardening.conf` before reloading SSH again.

## Stage 7: Clean up Tailscale DNS before enrolling the server

In the Tailscale admin console:

1. Open **DNS**.
2. Keep **Override DNS servers** off.
3. Keep MagicDNS on.
4. Find the dead global nameserver `100.104.88.63`.
5. Open its three-dot menu and remove it.
6. Do not add `192.168.8.10` as a DNS server unless a real DNS service is later installed and tested on this machine.
7. Do not enable an exit node during the rebuild.

The failed server's old exit-node role and its old DNS-server role are separate dependencies. Neither should be restored until the replacement server is stable and a failure fallback exists.

## Stage 8: Install and verify Tailscale

On Ubuntu:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=bigbox --accept-dns=false
```

1. Copy the displayed authentication URL.
2. Open it on the Mac.
3. Sign in to the correct Tailscale account.
4. Approve the new machine.
5. Return to Ubuntu and run:

```bash
tailscale ip -4
tailscale status
```

The new server will receive a new `100.x.x.x` Tailscale address. Do not assume it will reclaim the old `100.104.88.63` address.

From the Mac, test:

```bash
tailscale ping bigbox
ssh bigbox@bigbox
```

If the Mac cannot resolve `bigbox`, SSH to the new `100.x.x.x` address shown by `tailscale ip -4` and verify MagicDNS remains enabled on the tailnet.

After the new server survives a reboot and remote access is proven:

1. Open Tailscale **Machines**.
2. Confirm `bigbox` is connected.
3. Remove the previous offline node associated with the failed installation when it is no longer needed. Compare the node's last-seen time and Tailscale address before removing it.
4. Optionally disable key expiry for the new trusted always-on server. This improves continuity but increases the importance of revoking the node promptly if the server is lost or compromised.

## Stage 9: Configure the host firewall

Keep physical console access available while enabling the firewall.

Run:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow from 192.168.8.0/24 to any port 22 proto tcp
sudo ufw allow in on tailscale0 to any port 22 proto tcp

sudo ufw allow from 192.168.8.0/24 to any port 9090 proto tcp
sudo ufw allow in on tailscale0 to any port 9090 proto tcp

sudo ufw logging low
sudo ufw enable
sudo ufw status verbose
```

From the Mac, test both paths before leaving the physical console:

```bash
ssh bigbox@192.168.8.10
ssh bigbox@bigbox
```

Emergency firewall rollback from the physical console:

```bash
sudo ufw disable
```

Do not forward router ports `22` or `9090` to this server.

## Stage 10: Install Docker Engine and Docker Compose

Docker supports current Ubuntu Server LTS releases. Install from Docker's official repository:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Verify Docker:

```bash
sudo systemctl status docker --no-pager
sudo docker run --rm hello-world
docker compose version
```

Create a conventional location for Compose projects:

```bash
sudo install -d -m 0750 -o "$USER" -g "$USER" /opt/stacks
```

Continue using `sudo docker` initially. Membership in the `docker` group is convenient but grants root-equivalent control of the server.

### Docker network safety

Docker-published ports can bypass UFW policy. Do not assume a UFW deny rule protects a port published by Docker.

For services intended only for private Tailscale access, bind the container to loopback:

```yaml
services:
  app:
    image: example/image:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
```

Then publish it privately with Tailscale Serve. Keep Tailscale Funnel disabled.

For a service intentionally available only on the home LAN, bind it explicitly to `192.168.8.10` instead of `0.0.0.0`.

## Stage 11: Install KVM, libvirt, and Cockpit

Install the virtualization and web-management packages:

```bash
sudo apt update
sudo apt install -y cpu-checker qemu-kvm libvirt-daemon-system libvirt-clients virtinst cockpit cockpit-machines
```

Check hardware virtualization:

```bash
kvm-ok
```

Expected result:

```text
KVM acceleration can be used
```

If KVM cannot be used, reboot into firmware setup and enable Intel VT-x or AMD SVM/AMD-V.

Add the Ubuntu user to the VM management groups:

```bash
sudo adduser "$USER" libvirt
sudo adduser "$USER" kvm
```

Enable services:

```bash
sudo systemctl enable --now libvirtd
sudo systemctl enable --now cockpit.socket
sudo virsh net-list --all
```

Ensure libvirt's default NAT network starts automatically:

```bash
sudo virsh net-autostart default
sudo virsh net-start default
```

If the final command says the network is already active, that is harmless.

Log out and back in so the new group memberships apply.

### Open Cockpit from the Mac

Use either:

- `https://192.168.8.10:9090`
- `https://bigbox:9090`
- `https://NEW-TAILSCALE-IP:9090`

1. Accept the initial self-signed certificate warning only after confirming the address is the new server.
2. Sign in with the Ubuntu username and password.
3. Select **Virtual Machines**.
4. Confirm Cockpit shows the libvirt connection and default network.

Use libvirt's default NAT network for the first VMs. Do not convert the physical Ethernet interface to a bridge during the initial build. Installing Tailscale inside a guest is usually safer and simpler than changing the stable host network merely to reach that guest.

### Hand off virtualization to BoxPilot

After the final server acceptance test passes, follow [BoxPilot QEMU/KVM setup and operation](docs/VIRTUALIZATION.md) to install the native service. Run `sudo -u boxpilot npm run doctor`, open **Virtual Machines**, and confirm every host preflight item before enabling lifecycle controls. BoxPilot can create a reviewed VM plan, but `0.3.0` intentionally cannot apply that plan or create a guest.

### Optional: Create the first VM in Cockpit

1. Open **Virtual Machines**.
2. Select **Create VM**.
3. Enter a unique VM name.
4. Choose an operating-system download or an ISO installation source.
5. Assign CPU and memory without consuming all host resources.
6. Create a virtual disk of the required size.
7. Leave networking on the default NAT network.
8. Create the VM.
9. Open its console and complete the guest OS installer.
10. After the guest is stable, enable autostart if required:

```bash
sudo virsh autostart VM_NAME
```

## Stage 12: Enable automatic security updates

Run:

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Choose **Yes** when asked whether to automatically download and install stable security updates.

Verify:

```bash
systemctl status unattended-upgrades --no-pager
```

Automatic updates do not replace planned maintenance. Check periodically for `/var/run/reboot-required`.

## Stage 13: Check the replacement disk

Identify the storage devices:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL
sudo smartctl --scan
sudo nvme list
```

For a SATA disk, substitute its actual device:

```bash
sudo smartctl -H /dev/sdX
sudo smartctl -a /dev/sdX
```

For an NVMe disk, substitute its actual device:

```bash
sudo nvme smart-log /dev/nvme0
```

Enable SMART monitoring where supported:

```bash
sudo systemctl enable --now smartmontools
```

Do not blindly copy `/dev/sdX`. Replace it with the exact device reported by `smartctl --scan`.

## Stage 14: Prepare backups before deploying workloads

The previous disk failure makes this a release gate. Before important services are placed on the server, arrange an off-server destination such as a NAS, external disk that is disconnected between backups, or an encrypted cloud repository.

Back up at least:

- `/opt/stacks` Compose files
- Application configuration and secrets
- Application-aware database dumps
- Persistent Docker volume data
- Libvirt VM definitions
- VM disk images while guests are shut down or properly quiesced
- Important `/etc` configuration

Do not treat RAID, SMART monitoring, Docker restart policies, or VM snapshots as backups.

Test restoration of one small container and one VM or configuration file before considering backups complete.

## Stage 15: Final reboot and acceptance test

Reboot the finished host:

```bash
sudo reboot
```

Wait two minutes. From the Mac, test:

```bash
ssh bigbox@192.168.8.10
tailscale ping bigbox
ssh bigbox@bigbox
```

Open Cockpit:

```text
https://bigbox:9090
```

On Ubuntu, run the final checks:

```bash
hostnamectl
ip -br address
ip route
resolvectl status
getent ahostsv4 example.com
tailscale status
sudo ufw status verbose
systemctl --failed
systemctl is-active ssh
systemctl is-active tailscaled
systemctl is-active docker
systemctl is-active cockpit.socket
sudo docker run --rm hello-world
sudo virsh list --all
df -hT
df -ih
```

Acceptance criteria:

- After the Flint reservation is configured, the host returns as `192.168.8.10` after reboot. Before then, use the current address reported by `ip -br address`.
- SSH works from the LAN using a key.
- SSH also works over Tailscale.
- DNS resolves normally without depending on the failed server's old Tailscale address.
- UFW is enabled and only intended host services are allowed.
- Docker starts automatically and runs `hello-world`.
- KVM acceleration is available.
- Cockpit loads on port `9090` from the LAN or tailnet.
- Libvirt is available and the default NAT network is active.
- No systemd services are unexpectedly failed.
- A backup destination and restore test are planned before production data is added.

Once these checks pass, the monitor and keyboard can be removed. Keep a physical-console recovery method available.

## Emergency recovery commands

### Lost network after a Netplan change

At the physical console:

```bash
ip -br address
ip route
sudo netplan get
sudo netplan try
```

Restore the timestamped `/etc/netplan.backup-*` directory if the custom DNS change caused the problem.

### Locked out by UFW

At the physical console:

```bash
sudo ufw disable
```

Correct the rules, test SSH, and re-enable UFW.

### Tailscale DNS breaks name resolution

On the affected Linux device:

```bash
sudo tailscale set --accept-dns=false
```

Then verify that the Tailscale admin DNS Override is off and no dead server is listed as a forced global nameserver.

### Server boots the installer again

1. Remove the USB stick.
2. Open the firmware boot menu.
3. Select the internal disk's **ubuntu** UEFI entry.

### Server stops at a disk passphrase

Full-disk encryption was enabled. A local passphrase is required unless a separate remote or TPM-based unlock design is configured.

## Authoritative references

- [Ubuntu Server basic installation](https://documentation.ubuntu.com/server/tutorial/basic-installation/)
- [Ubuntu OpenSSH server](https://documentation.ubuntu.com/server/how-to/security/openssh-server/)
- [Ubuntu firewall documentation](https://documentation.ubuntu.com/server/how-to/security/firewalls/)
- [Netplan YAML configuration](https://netplan.readthedocs.io/en/latest/netplan-yaml/)
- [Install Tailscale on Linux](https://tailscale.com/docs/install/linux)
- [Tailscale DNS behavior](https://tailscale.com/docs/reference/dns-in-tailscale)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker packet filtering and firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
- [Ubuntu libvirt documentation](https://documentation.ubuntu.com/server/how-to/virtualisation/libvirt/)
- [Ubuntu Virtual Machine Manager documentation](https://documentation.ubuntu.com/server/how-to/virtualisation/virtual-machine-manager/)
- [Cockpit deployment guide](https://cockpit-project.org/guide/latest/)
