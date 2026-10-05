# Backups

BoxPilot backs up four different things, and they are worth keeping straight:

| What | Where it is set up | What it holds |
| --- | --- | --- |
| **BoxPilot's own database** | Backups page | accounts, jobs, settings, audit, everything BoxPilot knows |
| **An application's data** | its card in the App catalog | that app's Compose project, `.env`, and the volumes its manifest marks for backup |
| **A machine snapshot** | Backups page | one archive that can rebuild the whole box: the database, every app's settings and secrets, network and firewall configuration, and each VM's definition |
| **A virtual machine** | Virtual Machines page | the VM's disk, exported and optionally encrypted |

App *data* is not inside a machine snapshot. A snapshot rebuilds the box and reinstalls the apps
with their settings; each app's own backup restores what it stored.

## A backup counts only after a restore drill

Every database backup is restored into an isolated copy before it is recorded. If the copy will
not open, the backup is not written down as good. The Backups page shows the drill result beside
each snapshot. That is what "passed" means there.

Creating a database backup also keeps the newest ten local database copies, always preserving
the copy just created. Encrypted repository retention is separate. If old local copies cannot
be listed or removed, the new verified backup is kept and its result shows a follow-up notice
in both the approval dialog and Activity. Only successful removals are reported as removed.
An incomplete inventory prevents local pruning for that run. The backup table is recorded
history; an older row is not proof that its local file still exists after retention.

## Keeping a copy off the box

A disk failure should not take the backups with it. Three destinations are available, and you can
use more than one:

- **A backup drive**: a second disk mounted on this server. Copies are hash-verified and never
  deleted by BoxPilot.
- **Another machine over SSH**: set the host, user and path in *Backups → Off-box destination over SSH*;
  syncing uses `rsync` over SSH.
- **Cloud storage**: Backblaze B2, S3-compatible storage, WebDAV, Google Drive, OneDrive or
  Dropbox, through `rclone`. Credentials live in `/etc/boxpilot/secrets/rclone.conf` (root, 0600)
  and never in BoxPilot's database.

All three mirrors can run on a schedule (*System → Schedules*).

## Encrypted independent copies

Beyond the plain mirrors, BoxPilot can copy a database snapshot into a `restic` repository with
its own password, separate from anything else on the box. Those copies are read back in full after
they are written, and retention keeps at least the three newest.

## Where the files are

| Path | Contents |
| --- | --- |
| `/var/lib/boxpilot-managed/backups/boxpilot-controller` | database snapshots and their manifests |
| `/var/lib/boxpilot-managed/backups/catalog` | per-app archives |
| `/var/lib/boxpilot-managed/machine-snapshots` | machine snapshots |
| `/var/lib/boxpilot/` | the live database (never a backup target) |

All of it is root-only. Nothing is world-readable, and no archive is served over HTTP.

## Restoring

- **An app**: its card offers each recorded backup; restoring stops the app, replaces the volumes,
  and starts it again.
- **Apps and their data**: *Backups → Restore from a machine snapshot* reinstalls the apps with their saved settings and secrets, then restores each one's newest data archive. Network, firewall, fstab, VM definitions and the database copy are unpacked beside the snapshot for you to review and apply yourself. They are never applied for you.
- **What a backup may bring with it**: a restore normally writes the app's compose file again from
  the catalog and the backup's saved settings. A compose file you edited by hand (or one whose
  settings are missing or no longer fit the catalog) is started exactly as it was backed up, and a
  backup is only as trustworthy as whoever last held the drive. Before such a restore, the dialog
  lists every setting in that file that gives the app more than the catalog does (privileged,
  server folders such as `/` or Docker's socket, devices, capabilities, the host's network or
  processes, confinement turned off, another image, an extra service), and the restore goes ahead
  only once you allow exactly that file, typing `allow <app>`. A file this server already runs needs
  nothing. Data folders a backup's settings name must pass what an install checks (no `..`, no
  system location, no link on the way), named pipes and sockets in a backup are left out with a
  warning, and the app's own project files are never restored as links, hard links included.
- **The database alone**: see the [controller recovery runbook](CONTROLLER-BACKUPS.md), which is
  the procedure to follow when BoxPilot itself will not start.

## What BoxPilot does not do

- It does not prune a `restic` repository or reclaim space automatically.
- It does not back up the operating system. Reinstall Ubuntu, install BoxPilot, restore a machine
  snapshot.
- It does not encrypt the plain mirrors: an SSH or cloud destination holds the same bytes as the
  local copy. Use the encrypted independent copy when the destination is not somewhere you trust.
