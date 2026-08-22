# Recovery kit

*Repair Center → Recovery readiness* answers one question: **if this server died tonight, what
could you actually get back?** It reads what BoxPilot has recorded and says, per area, whether
recovery is covered, needs a decision from you, or is not set up at all.

## What it checks

| Area | Covered when |
| --- | --- |
| BoxPilot's database | a verified snapshot exists, ideally copied into the independent encrypted repository |
| BoxPilot itself | the release and install notes are recorded — you need them to rebuild the server |
| Catalog apps | every installed app has a backup recorded |
| Virtual machines | every VM has a retained encrypted copy |
| Host prerequisites | the packages BoxPilot depends on are present |

Each item comes with the next action, and a link to the page where you would take it.

## The order to recover in

1. Install Ubuntu, then BoxPilot, at the release the kit names.
2. Bring up Tailscale and sign in, so you are working privately.
3. Restore BoxPilot's database, so it knows about your accounts, settings and history.
4. Restore the machine snapshot, which reinstalls the apps with their settings and secrets.
5. Restore each app's data from its own backup.
6. Restore virtual machines from their encrypted copies.
7. Check everything is healthy, then download a fresh kit and keep it elsewhere.

The kit you download prints these same steps, so the copy you keep off the server is enough on its own.

## Keep these somewhere else

The kit is a readiness report, not a backup — it deliberately contains no credentials, no database,
no app data, and no keys. Download it (JSON or Markdown) and keep it with the things BoxPilot
cannot hold for you:

- the recovery password for the encrypted `restic` repository;
- the credentials for your off-box destination (SSH key or cloud keys);
- your Tailscale account access, and your GitHub account if you sign in with it;
- your router's configuration, which BoxPilot never touches.

Without the recovery password, an encrypted copy is unreadable — by you as well as by anyone else.

## What it does not do

The kit only reports. It cannot start a backup, install anything, or change the server; every
action it recommends is a link to the page where you decide. That is deliberate: a readiness check
that quietly fixed things would tell you less about the state you are actually in.
