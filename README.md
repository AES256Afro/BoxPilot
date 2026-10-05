# BoxPilot

BoxPilot runs a home server from a web page. You install apps, keep them updated and backed up, and fix problems by clicking, not by typing commands.

![Home: what needs you, the system, backups and disks, and your apps with their health](docs/screenshots/overview.jpg)

*See any page in all thirteen looks: open "in every look" under its picture. Home in every look is under [Looks](#looks).*

## What it is for

One computer at home can run your own versions of things you pay for or hand your data to: movies and TV, photo backup from your phone, file sync, a password manager, ad blocking for every device in the house, home automation, game servers. Setting those up and keeping them running is the hard part. BoxPilot does that part.

- **Install** any of 169 apps and game servers from a catalog. Each one's address, username and password are in one place.
- **Back up** every app and BoxPilot itself. A backup only counts once BoxPilot has restored it somewhere safe and checked it.
- **Update** the system and the apps. An app whose new version does not come up healthy goes back to the old one.
- **Watch** the drives, memory, temperatures and every app, and say in plain words what is wrong and what to do about it.
- **Fix** most problems with one button, from Repair.
- **Tell you** on your phone when something needs you, and when the server itself has gone quiet.
- **Reach it from anywhere** over Tailscale, without opening ports on your router.

Every change is a job you can watch while it runs and read back later. Small changes are one click. Bigger ones show exactly what will happen before anything does. Risky ones ask for your password. The web page never runs with admin rights: a separate, locked-down service does the admin work, and it only runs jobs BoxPilot defines.

You pick how it looks: thirteen looks in Settings → Appearance, from frosted glass over a wallpaper to a green terminal, a rack of LEDs, or an e-paper screen. [See them all.](#looks)

*Screenshots show the real interface with made-up data.*

## Install

On a fresh Ubuntu Server (22.04 or newer):

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh -s -- --ref v1.163.0
```

The installer sets up Node 24, builds BoxPilot in `/opt/boxpilot`, starts its services, and prints the address to open with a one-time setup code. Create your account, say what the server is for (home server, media server, smart home, ad blocking, virtual machines, development, monitoring, or just the basics), and follow the checklist on Ops.

When a new release is out, BoxPilot says so. Installing it takes one click and your password. It copies the database first, and puts the old version back by itself if the new one does not come up healthy.

## Pages

| Page | What it does |
| --- | --- |
| **Home** | Is everything OK, what needs you, and your apps with their health, in one screen. |
| **Ops** | The same facts all at once for a big screen: each drive's health, the battery backup (UPS), key services, the job queue, which apps are backed up where, and the setup checklist. |
| **Today** | The morning view: what is waiting for your approval, what needs a look, what ran overnight, and the agents' digest. Built for a phone first. |
| **Apps** | The catalog: search, install, set up, update, back up, restore, remove. |
| **Storage** | Disks and partitions, grow the system drive into free space, snapshots to roll back a bad update, mount drives and network shares so they come back after a reboot, share folders with other computers. |
| **Network** | Your router, DNS, the devices on your network (with wake-up), Tailscale, and a VPN to send chosen apps through. Checks whether your whole network loses the internet when this server is off, and gives the router steps to fix that. |
| **Firewall** | Choose who can reach what. Suggestions come from what is actually listening. Ban addresses that keep failing to log in. SSH, Tailscale and BoxPilot itself can never be blocked. |
| **Backups** | Tested backups of every app and of BoxPilot, encrypted copies kept off the server, a snapshot of the whole machine to rebuild it from, and copies to a drive, another computer, or cloud storage (Backblaze B2, S3, WebDAV, Google Drive, OneDrive, Dropbox). |
| **VMs** | Virtual machines from ready-made cloud images or your own ISO: start, stop, snapshot, encrypted backups with restore tests. |
| **Updates** | System updates, all or picked by hand, automatic security updates, and which updates need a restart. |
| **Repair** | Finds what is wrong and offers the fix for each problem. Lists what is installed and what you would need to rebuild this server from nothing. |
| **Logs** | Any service's or app's log: search, filter, follow live, download. |
| **Services** | The system's services and timers: start, stop, restart, turn on at boot, read their logs. |
| **System** | Name, time zone, language, memory and swap, drive trim, the battery backup (UPS), schedules, and BoxPilot's own updates. Housekeeping finds what nothing uses any more (old releases, unused images, stale backups) and clears only what you tick. |
| **Metrics** | Live CPU, memory, disk and temperature for the machine and for each app, with pause, restart and stop. |
| **Automations** | Chain jobs you already trust and run them on a schedule, or after another one finishes. |
| **Agents** | Helpers that run on this server and answer questions about it, write a morning digest, and suggest fixes. Nothing they suggest runs until you approve it. Off until you turn it on. |
| **Users & SSH** | Accounts, admin rights, SSH keys (import from GitHub), whether passwords may log in over SSH. |
| **GitHub** | Where this copy of BoxPilot came from: each release and the checksums of its files. Read-only. |
| **Settings** | How much approval each kind of change needs, alerts, the heartbeat, sign-in, the phone app, and Appearance: thirteen looks, light or dark, accent colour, wallpaper and row size, kept per browser so a phone and a wall screen can differ. |

Sign in with a password, a passkey, your Tailscale account, or GitHub.

### Today, and on your phone

<table>
<tr><td width="70%" valign="top"><img src="docs/screenshots/today.jpg" alt="Today: waiting for approval, needs a look, the agents' digest, what ran and what is backed up off this server"></td>
<td width="30%" valign="top"><img src="docs/screenshots/phone-today.jpg" alt="Today on a phone, with the bottom tab bar"></td></tr>
</table>

<!-- every-look:today -->
<details><summary>Today in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-today.jpg" alt="Today in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-today.jpg" alt="Today in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-today.jpg" alt="Today in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-today.jpg" alt="Today in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-today.jpg" alt="Today in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-today.jpg" alt="Today in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-today.jpg" alt="Today in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-today.jpg" alt="Today in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-today.jpg" alt="Today in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-today.jpg" alt="Today in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-today.jpg" alt="Today in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-today.jpg" alt="Today in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-today.jpg" alt="Today in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

Add BoxPilot to your phone's home screen and it opens like an app. Turn on notifications and a job waiting for approval reaches your phone. Tapping it opens the normal approval, with its password step: a notification never approves anything by itself.

### Agents

![Agents: the latest digest, four agents with their schedules and budgets, and cards waiting for approval](docs/screenshots/agents.jpg)

<!-- every-look:agents -->
<details><summary>Agents in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-agents.jpg" alt="Agents in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-agents.jpg" alt="Agents in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-agents.jpg" alt="Agents in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-agents.jpg" alt="Agents in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-agents.jpg" alt="Agents in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-agents.jpg" alt="Agents in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-agents.jpg" alt="Agents in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-agents.jpg" alt="Agents in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-agents.jpg" alt="Agents in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-agents.jpg" alt="Agents in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-agents.jpg" alt="Agents in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-agents.jpg" alt="Agents in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-agents.jpg" alt="Agents in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

An agent is a small language model running on this server, with a job to do: keep an eye on the server, survey it once a week and say where to focus, look after the apps, watch the drives fill, plan updates, check that ad blocking is working, audit the backups, answer questions, or show new people around. Each starts from a template you can change. Agents only read. When one thinks something should change, it writes a card, and the change runs as a normal job only after you approve it. They run at the lowest priority with hard limits (four processors in the background, up to eight while you wait for an answer, 8 GB of memory, no network beyond this machine). They can be paused, paused until tomorrow, or all stopped at once. A nightly check scores their answers against questions you set. With the Zulip app installed, you can message an agent or @mention it in a chat room.

### Ops

![Ops: the machine's numbers, alerts, the action inbox, and every container and VM](docs/screenshots/ops.jpg)

<!-- every-look:ops -->
<details><summary>Ops in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-ops.jpg" alt="Ops in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-ops.jpg" alt="Ops in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-ops.jpg" alt="Ops in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-ops.jpg" alt="Ops in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-ops.jpg" alt="Ops in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-ops.jpg" alt="Ops in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-ops.jpg" alt="Ops in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-ops.jpg" alt="Ops in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-ops.jpg" alt="Ops in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-ops.jpg" alt="Ops in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-ops.jpg" alt="Ops in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-ops.jpg" alt="Ops in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-ops.jpg" alt="Ops in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

### Metrics

![Metrics: CPU, memory, swap, load, disks and temperature, then every app with its CPU and memory](docs/screenshots/performance.jpg)

<!-- every-look:performance -->
<details><summary>Metrics in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-performance.jpg" alt="Metrics in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-performance.jpg" alt="Metrics in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-performance.jpg" alt="Metrics in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-performance.jpg" alt="Metrics in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-performance.jpg" alt="Metrics in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-performance.jpg" alt="Metrics in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-performance.jpg" alt="Metrics in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-performance.jpg" alt="Metrics in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-performance.jpg" alt="Metrics in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-performance.jpg" alt="Metrics in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-performance.jpg" alt="Metrics in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-performance.jpg" alt="Metrics in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-performance.jpg" alt="Metrics in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

### Automations

![Automations](docs/screenshots/automations.jpg)

<!-- every-look:automations -->
<details><summary>Automations in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-automations.jpg" alt="Automations in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-automations.jpg" alt="Automations in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-automations.jpg" alt="Automations in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-automations.jpg" alt="Automations in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-automations.jpg" alt="Automations in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-automations.jpg" alt="Automations in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-automations.jpg" alt="Automations in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-automations.jpg" alt="Automations in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-automations.jpg" alt="Automations in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-automations.jpg" alt="Automations in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-automations.jpg" alt="Automations in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-automations.jpg" alt="Automations in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-automations.jpg" alt="Automations in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

Chains of the jobs you already trust, run in order, each one recorded. A ready-made shelf (Update night, Belt and braces) that you can edit, and a builder over every job that needs no settings. A chain runs on a schedule or after another one finishes. A step can retry when something fails for a moment, keep going on failure, or run only if an earlier step's result says so. Every run shows each step's output. A run cut off by a restart says so, instead of claiming it is still running.

### Firewall

![Firewall](docs/screenshots/firewall.jpg)

<!-- every-look:firewall -->
<details><summary>Firewall in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-firewall.jpg" alt="Firewall in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-firewall.jpg" alt="Firewall in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-firewall.jpg" alt="Firewall in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-firewall.jpg" alt="Firewall in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-firewall.jpg" alt="Firewall in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-firewall.jpg" alt="Firewall in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-firewall.jpg" alt="Firewall in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-firewall.jpg" alt="Firewall in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-firewall.jpg" alt="Firewall in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-firewall.jpg" alt="Firewall in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-firewall.jpg" alt="Firewall in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-firewall.jpg" alt="Firewall in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-firewall.jpg" alt="Firewall in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

Pick a profile, tick the services other devices should reach, apply. Suggestions come from what is listening right now: a database open to the whole network, an app nobody can reach, SSH with no limit on login attempts.

### Storage

![Storage](docs/screenshots/storage.jpg)

<!-- every-look:storage -->
<details><summary>Storage in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-storage.jpg" alt="Storage in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-storage.jpg" alt="Storage in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-storage.jpg" alt="Storage in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-storage.jpg" alt="Storage in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-storage.jpg" alt="Storage in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-storage.jpg" alt="Storage in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-storage.jpg" alt="Storage in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-storage.jpg" alt="Storage in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-storage.jpg" alt="Storage in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-storage.jpg" alt="Storage in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-storage.jpg" alt="Storage in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-storage.jpg" alt="Storage in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-storage.jpg" alt="Storage in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

Claim the space the Ubuntu installer left unused, take a snapshot before a big update and roll back if it goes wrong, mount disks and network shares permanently, and share folders with Samba or NFS. Passwords for network shares are never stored in BoxPilot's database.

### Backups

![Backups](docs/screenshots/backups.jpg)

<!-- every-look:backups -->
<details><summary>Backups in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-backups.jpg" alt="Backups in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-backups.jpg" alt="Backups in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-backups.jpg" alt="Backups in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-backups.jpg" alt="Backups in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-backups.jpg" alt="Backups in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-backups.jpg" alt="Backups in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-backups.jpg" alt="Backups in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-backups.jpg" alt="Backups in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-backups.jpg" alt="Backups in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-backups.jpg" alt="Backups in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-backups.jpg" alt="Backups in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-backups.jpg" alt="Backups in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-backups.jpg" alt="Backups in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

A backup counts only after a restore test passes. A machine snapshot holds everything needed to rebuild the server: BoxPilot's database, every app's settings and secrets, network and firewall settings, and VM definitions.

### Network

![Network and DNS](docs/screenshots/network.jpg)

<!-- every-look:network -->
<details><summary>Network in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-network.jpg" alt="Network in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-network.jpg" alt="Network in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-network.jpg" alt="Network in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-network.jpg" alt="Network in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-network.jpg" alt="Network in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-network.jpg" alt="Network in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-network.jpg" alt="Network in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-network.jpg" alt="Network in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-network.jpg" alt="Network in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-network.jpg" alt="Network in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-network.jpg" alt="Network in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-network.jpg" alt="Network in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-network.jpg" alt="Network in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

### Updates

![Updates and packages](docs/screenshots/updates.jpg)

<!-- every-look:updates -->
<details><summary>Updates in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-updates.jpg" alt="Updates in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-updates.jpg" alt="Updates in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-updates.jpg" alt="Updates in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-updates.jpg" alt="Updates in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-updates.jpg" alt="Updates in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-updates.jpg" alt="Updates in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-updates.jpg" alt="Updates in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-updates.jpg" alt="Updates in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-updates.jpg" alt="Updates in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-updates.jpg" alt="Updates in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-updates.jpg" alt="Updates in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-updates.jpg" alt="Updates in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-updates.jpg" alt="Updates in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

### System

![System](docs/screenshots/system.jpg)

<!-- every-look:system -->
<details><summary>System in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-system.jpg" alt="System in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-system.jpg" alt="System in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-system.jpg" alt="System in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-system.jpg" alt="System in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-system.jpg" alt="System in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-system.jpg" alt="System in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-system.jpg" alt="System in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-system.jpg" alt="System in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-system.jpg" alt="System in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-system.jpg" alt="System in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-system.jpg" alt="System in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-system.jpg" alt="System in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-system.jpg" alt="System in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

### Repair

Finds what is wrong and offers the fix for each one: a drive that dropped off and came back under a different name, an app still holding the folder that was mounted when it started, a share nobody can write to, an app that cannot write its own data. Below that, what is installed and what you would need to rebuild this server from nothing.

![Repair](docs/screenshots/repairs.jpg)

<!-- every-look:repairs -->
<details><summary>Repair in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-repairs.jpg" alt="Repair in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-repairs.jpg" alt="Repair in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-repairs.jpg" alt="Repair in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-repairs.jpg" alt="Repair in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-repairs.jpg" alt="Repair in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-repairs.jpg" alt="Repair in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-repairs.jpg" alt="Repair in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-repairs.jpg" alt="Repair in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-repairs.jpg" alt="Repair in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-repairs.jpg" alt="Repair in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-repairs.jpg" alt="Repair in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-repairs.jpg" alt="Repair in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-repairs.jpg" alt="Repair in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

## Apps

![App catalog](docs/screenshots/catalog.jpg)

<!-- every-look:catalog -->
<details><summary>Apps in every look</summary>

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/blend-catalog.jpg" alt="Apps in Home + Ops"><br>Home + Ops</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/launcher-catalog.jpg" alt="Apps in Launcher"><br>Launcher</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/console-catalog.jpg" alt="Apps in Command Center"><br>Command Center</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/aqua-catalog.jpg" alt="Apps in Aqua"><br>Aqua</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/blueprint-catalog.jpg" alt="Apps in Blueprint"><br>Blueprint</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/phosphor-catalog.jpg" alt="Apps in Phosphor"><br>Phosphor</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/rack-catalog.jpg" alt="Apps in Rack Panel"><br>Rack Panel</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/swiss-catalog.jpg" alt="Apps in Swiss Poster"><br>Swiss Poster</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/toybox-catalog.jpg" alt="Apps in Toybox"><br>Toybox</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/cockpit-catalog.jpg" alt="Apps in Glass Cockpit"><br>Glass Cockpit</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/eink-catalog.jpg" alt="Apps in E-Ink"><br>E-Ink</td><td width="33%" valign="top"><img src="docs/screenshots/every-look/quest-catalog.jpg" alt="Apps in Quest"><br>Quest</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/every-look/transit-catalog.jpg" alt="Apps in Transit Map"><br>Transit Map</td></tr>
</table>
</details>
<!-- /every-look -->

169 apps and game servers, each installed and managed the same way:

- **Sign in**: its address, username and password, and a way to change them.
- **Performance**: live CPU, memory, temperature and disk use, with pause and stop.
- **Reach**: one switch puts an app on your home network, or keeps it on Tailscale only. Both use HTTPS with a real certificate.
- **Backups**: Home names any app that has never been backed up, or has no copy off the server, and one button fixes each.
- **Models**: for apps that run language models, list, add and remove models.

Each app is a short description file plus a Docker Compose template, so installing, updating, reconfiguring, backing up and restoring work the same way for every app. Apps you set up yourself with Docker Compose can be adopted and managed alongside.

<!-- apps:start -->
| Category | Apps |
| --- | --- |
| Developer tools (22) | Baserow, code-server, CyberChef, Directus, Docker Registry, Dockge, draw.io, Forgejo, InfluxDB, IT-Tools, MariaDB, Metabase, MongoDB, n8n, NocoDB, pgAdmin, phpMyAdmin, Portainer CE, PostgreSQL, Semaphore, Valkey (Redis), Verdaccio |
| Monitoring (19) | Beszel, Beszel agent, cAdvisor, changedetection.io, Diun, Dozzle, Glance, Grafana, Grafana Alloy, Healthchecks, Homepage, LibreSpeed, Loki, Netdata, node-exporter, Prometheus, Scrutiny, Speedtest Tracker, Uptime Kuma |
| Games (17) | 7 Days to Die server, Core Keeper server, Crafty Controller, EmulatorJS, Enshrouded server, Factorio server, FarSpace, Minecraft server, Necesse server, Palworld server, Project Zomboid server, PufferPanel, RomM, Satisfactory server, Terraria server, V Rising server, Valheim server |
| Knowledge (14) | AuDHDMAP, BookStack, Docmost, HedgeDoc, Joplin Server, Karakeep, Keel, linkding, Linkwarden, Memos, Shiori, Trilium Notes, wallabag, Wiki.js |
| Media automation (14) | autobrr, Bazarr, Deluge, FlareSolverr, Lidarr, NZBGet, Prowlarr, qBittorrent (through a VPN), Radarr, SABnzbd, slskd, Sonarr, Tdarr, Transmission |
| Media (13) | Audiobookshelf, Emby, Jellyfin, Jellyseerr, Maintainerr, MeTube, Navidrome, Overseerr, Pinchflat, Plex Media Server, Stremio (through a VPN), Tautulli, Wizarr |
| Communication (9) | Apprise API, Element web, Gotify, Mailpit, Matrix server (Tuwunel), Mattermost, Mumble server, ntfy, Zulip |
| Files (8) | File Browser, Nextcloud, PairDrop, Paperless-ngx, Pingvin Share X, Resilio Sync, Stirling PDF, Syncthing |
| Home automation (8) | ESPHome, Frigate, Home Assistant, Mosquitto (MQTT broker), Node-RED, OctoPrint, Z-Wave JS UI, Zigbee2MQTT |
| Network (8) | Apache Guacamole, Cloudflare DDNS, Cloudflare Tunnel, NetAlertX, Nginx Proxy Manager, SmokePing, UniFi Network Application, WireGuard (wg-easy) |
| AI (6) | AnythingLLM, LibreTranslate, LLMCoach, Ollama, Open WebUI + Ollama, Whisper (speech to text) |
| Productivity (6) | Baïkal, FreshRSS, Miniflux, Planka, SearXNG, Vikunja |
| Household (5) | Grocy, Homebox, Mealie, Monica, Tandoor Recipes |
| Backup (4) | Backrest, Duplicati, Kopia, MinIO |
| Books (4) | Calibre-Web, Kavita, Komga, Suwayomi |
| Ad blocking and DNS (3) | AdGuard Home, Pi-hole, Technitium DNS Server |
| Finance (3) | Actual Budget, Firefly III, Wallos |
| Security (3) | 2FAuth, Pocket ID, Vaultwarden |
| Photos (2) | Immich, PhotoPrism |
| Administration (1) | Protec |
<!-- apps:end -->

## What runs in the background

- **Drive health**: every six hours, each drive's own health report (SMART) and file-system errors are read, so a failing drive shows up before it fails.
- **Backups and restore tests** on the schedules you set, each recorded as a job.
- **Alerts** through ntfy, Gotify, a webhook, or your phone's notifications: failed jobs, full disks, drive warnings, power cuts. A weekly report sums up the week.
- **Heartbeat** (off until you turn it on): every five minutes the server checks in with a service you choose, such as healthchecks.io. When the check-ins stop, because the power is out or the server crashed, that service alerts your phone. An alert sent from the server itself cannot do this.
- **After a power cut**: a few minutes after the server comes back from losing power, it checks that devices on your network can look up names again, and that the server itself can.
- **Agents** (off until you turn them on): the digest and checks you schedule, at idle priority.

## What it installs on your server

| Service | What it does | When it runs |
| --- | --- | --- |
| `boxpilot.service` | The web app. Runs as its own user, `boxpilot`, with no admin rights. | Always |
| `boxpilot-helper.service` | Does the admin work (installs, mounts, firewall, backups) for jobs you approved. Runs as root, locked down, and reachable only through a local socket. | Always |
| `boxpilot-storage-scan.timer` | Reads drive health and file-system errors. Changes nothing. | Every six hours |
| `boxpilot-agents.service` | Runs the agents, capped as described above. | Only once you turn Agents on |
| `boxpilot-heartbeat.timer` | Sends one bare request to your check-in address, with nothing about the server in it. | Only once you turn it on; every five minutes |
| `boxpilot-run@.service` and the `*-install` services | Fixed root tasks the helper starts for approved jobs: refreshing the package list, and installing Docker, restic, the drive-check tools or the VM tools. | Only when a job needs one |

Apps run in Docker. Beyond Node 24 and BoxPilot, nothing is installed until a job you approved installs it, Docker included.

## Looks

Settings → Appearance changes every page at once. Pick a look and it applies straight away, with Keep this look or Go back. Each look below is its Home on a made-up server; every other page follows it.

<table>
<tr><td width="33%" valign="top"><img src="docs/screenshots/looks/blend.jpg" alt="Home + Ops: Glass over a wallpaper, with the console's numbers inside. The default."><br><b>Home + Ops</b><br>Glass over a wallpaper, with the console's numbers inside. The default.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/launcher.jpg" alt="Launcher: Home's wallpaper, frosted glass and dock on every page."><br><b>Launcher</b><br>Home's wallpaper, frosted glass and dock on every page.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/console.jpg" alt="Command Center: The Ops console on every page, Home included."><br><b>Command Center</b><br>The Ops console on every page, Home included.</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/looks/aqua.jpg" alt="Aqua: Mac OS X, 2001: pinstripes, gel buttons, a source list and a dock."><br><b>Aqua</b><br>Mac OS X, 2001: pinstripes, gel buttons, a source list and a dock.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/blueprint.jpg" alt="Blueprint: The server as a technical drawing on blue drafting paper."><br><b>Blueprint</b><br>The server as a technical drawing on blue drafting paper.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/phosphor.jpg" alt="Phosphor: A green CRT terminal with a key for every action."><br><b>Phosphor</b><br>A green CRT terminal with a key for every action.</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/looks/rack.jpg" alt="Rack Panel: Brushed-metal rack units, LEDs and segment displays."><br><b>Rack Panel</b><br>Brushed-metal rack units, LEDs and segment displays.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/swiss.jpg" alt="Swiss Poster: White, black and one red: type and rules, no boxes."><br><b>Swiss Poster</b><br>White, black and one red: type and rules, no boxes.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/toybox.jpg" alt="Toybox: Chunky pastel cards and buttons that press down."><br><b>Toybox</b><br>Chunky pastel cards and buttons that press down.</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/looks/cockpit.jpg" alt="Glass Cockpit: Round gauges, a master caution lamp and soft keys."><br><b>Glass Cockpit</b><br>Round gauges, a master caution lamp and soft keys.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/eink.jpg" alt="E-Ink: Black on e-paper grey: serif text, dithered bars, shapes and words for status."><br><b>E-Ink</b><br>Black on e-paper grey: serif text, dithered bars, shapes and words for status.</td><td width="33%" valign="top"><img src="docs/screenshots/looks/quest.jpg" alt="Quest: An RPG party screen: apps are party members, problems are quests."><br><b>Quest</b><br>An RPG party screen: apps are party members, problems are quests.</td></tr>
<tr><td width="33%" valign="top"><img src="docs/screenshots/looks/transit.jpg" alt="Transit Map: The box as a subway map, with a line status board."><br><b>Transit Map</b><br>The box as a subway map, with a line status board.</td></tr>
</table>

## How it works

- **Every action is declared** (`server/ops/`) with its risk level, the settings it takes, and what it runs. Nothing runs that is not declared.
- **Risk levels** ([ADR-001](docs/DECISIONS.md)): low is one click, medium shows a preview to confirm, high asks for your password, which unlocks a short window for further high-risk changes.
- **Jobs are recorded** with their steps, live output and who approved them. Passwords handed to a job stay in memory and are never written down.
- **The web app has no admin rights.** Admin work runs in the separate helper service, which the web app talks to over a local socket.
- **Evidence, not claims**: backups are restore-tested, copies kept off the server are read back, and a job refuses to run if what you reviewed has changed on disk since.

## Development

Requires Node.js 24 and npm 11.

```bash
npm install
npm run dev               # UI at http://127.0.0.1:5173
npm run check             # build + tests + syntax checks
npm run demo              # the built UI on made-up data at http://127.0.0.1:8799
npm run demo:screenshots  # retake docs/screenshots from it (needs Chrome)
npm run demo:every-look   # retake each page in every look and the README's galleries
node scripts/look-check.mjs look aqua  # score a look against its drawing (needs Chrome)
```

`npm run build && npm start` listens on `127.0.0.1:8787` (`BOXPILOT_HOST` changes it). Installs on a server run as the systemd services in `deploy/`.

## Private access over Tailscale

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
```

Open the HTTPS address from any device on your tailnet. Keep Funnel off. BoxPilot still asks everyone to sign in.

## Documentation

- [Roadmap](docs/ROADMAP-V2.md) · [Decisions](docs/DECISIONS.md) · [Architecture](docs/ARCHITECTURE.md)
- [Virtual machines](docs/VIRTUALIZATION.md) · [Backups](docs/BACKUPS.md) · [Recovery kit](docs/RECOVERY.md) · [Network](docs/NETWORK.md)
- [Ubuntu Server installation runbook](UBUNTU-SERVER-INSTALL-RUNBOOK.md)
- [Legacy documentation](docs/legacy/README.md), kept for history

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first. New actions are declared operations, new apps are description files, and `npm run check` must pass.

## License

No license has been selected yet. All rights are reserved until the repository owner chooses one.
