# Recovery kit

*Repair → Rebuild checklist* answers one question: **if this server died tonight, what
could you actually get back?** It reads what BoxPilot has recorded and says, per area, whether
recovery is covered, needs a decision from you, or is not set up at all.

## What it checks

| Area | Covered when |
| --- | --- |
| BoxPilot's database | a verified snapshot exists, ideally copied into the independent encrypted repository |
| BoxPilot itself | the release and install notes are recorded. You need them to rebuild the server |
| Catalog apps | every installed app has a backup recorded |
| A copy off this server | a backup drive, another machine over SSH or a cloud bucket holds a copy that is not behind the newest backup |
| Virtual machines | every VM has a retained encrypted copy |
| Host prerequisites | the packages BoxPilot depends on are present |

Each item comes with the next action, and a link to the page where you would take it.

## The order to recover in

1. **Get the server back.** Install Ubuntu Server, then BoxPilot at the release the kit names.
2. **Get back in privately.** Bring up Tailscale and sign in.
3. **Bring the backups back.** Plug in the backup drive and mount it on the *Storage* page;
   *Backups → Restore* then finds the snapshots on it. With no drive, copy the backups back from the
   other machine over SSH, or from the cloud with rclone ([Opening the cloud copy without
   BoxPilot](BACKUPS.md#opening-the-cloud-copy-without-boxpilot)), into the same folders on this server.
4. **Restore the machine snapshot.** *Backups → Restore*: pick the newest snapshot. It reinstalls the
   apps with their settings and secrets and restores each app's data from its newest verified backup
   on this server or the backup drive (or beside the snapshot), even one taken after the snapshot, and
   falls back to the archive the snapshot lists when none checks out; the restore says which newer
   backups it passed over and why. Untick *Use each app's newest backup* on the Restore tab to use only
   the snapshot's own. Network, firewall, fstab, VM definitions and BoxPilot's database copy are
   unpacked beside the snapshot for you to look at and apply yourself.
5. **Put BoxPilot's database back.** *Backups → This server → Restore the database copy*: choose the
   copy the snapshot restore staged, or a newer verified database backup from the drive. BoxPilot then
   knows your accounts, schedules, destinations and history again; sign in with the password you had
   then. By hand instead, at the server's console:
   1. `sudo systemctl stop boxpilot`
   2. Find the staged copy: `/var/lib/boxpilot-managed/machine-snapshots/restored/<time>/controller/`
      holds `boxpilot.sqlite3` and its `manifest.json`. Check that `sha256sum boxpilot.sqlite3` matches
      the `checksumSha256` in the manifest.
   3. Copy it over `/var/lib/boxpilot/boxpilot.sqlite3`, owned by `boxpilot:boxpilot`, mode `0600`, and
      delete the `boxpilot.sqlite3-wal` and `boxpilot.sqlite3-shm` files beside it.
   4. `sudo systemctl start boxpilot`

   The encrypted `restic` copy of the database is for when the drive's copies are gone too; restoring
   it is a console procedure ([database recovery runbook](CONTROLLER-BACKUPS.md#manual-recovery-runbook)).
6. **Check each app's data.** Open each app and check its data is there and how recent it is. If the
   restore passed over a newer backup you want (one an earlier BoxPilot wrote, say), restore it from
   the app's *Backups* tab in *Apps*.
7. **Restore virtual machines** from their encrypted copies, into stopped clones with no network.
8. **Check everything is healthy**, then download a fresh kit and keep it elsewhere.

The kit you download prints these same steps, so the copy you keep off the server is enough on its own.

## Keep these somewhere else

The kit is a readiness report, not a backup. It deliberately contains no credentials, no database,
no app data, and no keys. Download it (JSON or Markdown) and keep it with the things BoxPilot
cannot hold for you:

- the recovery password for the encrypted `restic` repository;
- the cloud copy's encryption passphrase, the one you typed when you set up the cloud destination;
- the credentials for the destination off this server (SSH key or cloud keys);
- your Tailscale account access, and your GitHub account if you sign in with it;
- your router's configuration, which BoxPilot never touches.

Without its password or passphrase, an encrypted copy is unreadable. By you as well as by anyone
else. The kit also prints the rclone settings that open the cloud copy on any machine, with no
BoxPilot needed.

## What it does not do

The kit only reports. It cannot start a backup, install anything, or change the server; every
action it recommends is a link to the page where you decide. That is deliberate: a readiness check
that quietly fixed things would tell you less about the state you are actually in.
