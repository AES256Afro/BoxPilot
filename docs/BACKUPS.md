# Backups

BoxPilot backs up four different things, and they are worth keeping straight:

| What | Where it is set up | What it holds |
| --- | --- | --- |
| **BoxPilot's own database** | Backups page | accounts, jobs, settings, audit, everything BoxPilot knows |
| **An application's data** | its Backups tab in Apps | that app's Compose project, `.env`, and the volumes its manifest marks for backup |
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

## Keeping a copy off this server

A disk failure should not take the backups with it. Three destinations are available, and you can
use more than one:

- **A backup drive**: a second disk mounted on this server. Copies are hash-verified and never
  deleted by BoxPilot.
- **Another computer over SSH**: set the host, user and path in *Backups → Off this server → Another computer over SSH*;
  syncing uses `rsync` over SSH.
- **Cloud storage**: Backblaze B2, S3-compatible storage, WebDAV, Google Drive, OneDrive or
  Dropbox, through `rclone`. A passphrase is required: every copy is encrypted with it before it
  leaves. Credentials live in `/etc/boxpilot/secrets/rclone.conf` (root, 0600) and never in
  BoxPilot's database. **Write the passphrase down with your recovery kit**, somewhere other than
  this server: without it nobody, you included, can read the cloud copy.

All three mirrors can run on a schedule (*System → Schedules*).

## Opening the cloud copy without BoxPilot

The cloud copy is ordinary rclone `crypt`, so any machine with rclone can read it, given the
provider's keys and your passphrase. Its settings are not rclone's defaults, so write them as they
are here (the downloaded recovery kit prints them too, with your bucket and folder filled in):

```ini
[boxpilot]
type = <provider: b2, s3, webdav, drive, onedrive or dropbox>
<the provider's account and keys, as `rclone config` asks for them>

[boxpilot-sealed]
type = crypt
remote = boxpilot:<bucket>/<folder>/sealed
filename_encryption = off
directory_name_encryption = false
password = <the output of: rclone obscure 'your passphrase'>
```

- `remote` is the destination's folder with `/sealed` after it. Backblaze B2 and S3 put the bucket
  first (`boxpilot:<bucket>/<folder>/sealed`); WebDAV, Google Drive, OneDrive and Dropbox have no
  bucket (`boxpilot:<folder>/sealed`). The folder is `boxpilot` unless you named another.
- Leave `password2` out: the copies were sealed with no salt password.
- In the bucket each file's name ends in `.bin`; read through `boxpilot-sealed:` it has its own name again.

Then `rclone lsf boxpilot-sealed:` lists `controller-backups/`, `application-backups/` and
`machine-snapshots/`. To rebuild from the cloud, copy them back into the folders a new server
restores from (see [Where the files are](#where-the-files-are)), then restore the machine snapshot:

```sh
sudo rclone --config ./rclone.conf copy boxpilot-sealed:machine-snapshots /var/lib/boxpilot-managed/machine-snapshots
sudo rclone --config ./rclone.conf copy boxpilot-sealed:application-backups /var/lib/boxpilot-managed/backups/catalog
sudo rclone --config ./rclone.conf copy boxpilot-sealed:controller-backups /var/lib/boxpilot-managed/backups/boxpilot-controller
```

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

The backup folders are root-only, and `/var/lib/boxpilot/` is the boxpilot user's only. Nothing is world-readable, and no archive is served over HTTP.

Private apps (ADR-019) are backed up and restored like any other app, but two things they need are
in no backup and no machine snapshot: their manifests (`/var/lib/boxpilot-managed/private-catalog`)
and the registry sign-in their images are pulled with (`/var/lib/boxpilot-managed/registry-auth`).
Keep your own copy of each manifest. On a rebuilt server, add the manifests again and sign in to the
registry (Apps → Private apps) before reinstalling or restoring those apps.

## Restoring

- **An app**: its Backups tab in Apps offers each recorded backup; restoring stops the app, replaces the volumes,
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
- **The database**: *Backups → This server → Restore the database copy* puts back a verified
  database backup, or the copy a snapshot restore staged. When BoxPilot itself will not start, or
  only the encrypted `restic` copy is left, follow the [database recovery runbook](CONTROLLER-BACKUPS.md#manual-recovery-runbook)
  at the console. The whole rebuild, in order, is in [the recovery kit](RECOVERY.md#the-order-to-recover-in).

## What BoxPilot does not do

- It does not prune a `restic` repository or reclaim space automatically.
- It does not back up the operating system. Reinstall Ubuntu, install BoxPilot, restore a machine
  snapshot.
- Copies on a backup drive or another computer are not encrypted. Cloud copies are encrypted with
  your passphrase before they leave.
