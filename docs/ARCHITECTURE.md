# Architecture

BoxPilot manages one Ubuntu server from a browser. It runs as two processes on that server: a
web service that never has root, and a helper that does. Everything the owner asks for becomes a
declared *operation*, staged as a durable *job*, approved according to its risk tier, and carried
out by the helper.

## Processes

```text
Browser  ──HTTPS over Tailscale (or plain HTTP on the LAN)──┐
                                                            v
                                    boxpilot.service  (user: boxpilot, no root)
                                      · Express API + the built UI
                                      · SQLite: accounts, sessions, jobs, approvals, audit, settings
                                      · read-only host collectors: systemd, interfaces, routes,
                                        resolvers, listening ports, lsblk, Docker, Tailscale
                                      · the operation registry, the list of everything BoxPilot can do
                                            │
                                            │ one request per job, over a Unix socket (0660 root:boxpilot)
                                            v
                                    boxpilot-helper.service  (root, heavily sandboxed)
                                      · validates the request against the same registry
                                      · deploys catalog apps with Docker Compose
                                      · reads root-only state; writes root-only files
                                      · PrivateNetwork, PrivateDevices, ProtectSystem=strict
                                            │
                                            │ for work that needs the network or real devices
                                            v
                                    boxpilot-run@<uuid>.service  (root, one-shot per task)
                                      · a fixed task table in server/tasks/index.mjs
                                      · apt, ufw, systemd units, fstab and mounts, Samba/NFS,
                                        LVM, UPS, fail2ban, rclone, Tailscale, the self-update
```

The web service is the only process the browser talks to. It cannot change the host by itself: it
has no root, and the helper refuses anything that is not a registered operation with valid
parameters. The helper is sandboxed so tightly that it cannot reach the network or real devices;
work that needs either is handed to a one-shot unit whose task table is fixed at build time.

## Operations, jobs, approval

An **operation** ([`server/ops/`](../server/ops)) declares an id, a risk tier, a parameter spec (types, patterns, limits) for
its parameters, what it does, and how to verify it. Nothing that is not declared can run. Each
one carries:

| Field | Meaning |
| --- | --- |
| `risk` | `low` runs on one click, `medium` shows a preview to confirm, `high` asks for the owner password |
| `readOnly` | inspections; they answer immediately instead of becoming a job |
| `minimumRole` | `owner` for anything that sends data off the box |
| `confirm(parameters)` | text the approver must type. The disk path, the app id, the VM name |
| `parameters` | field types, patterns, limits; `secret: true` fields never reach the database |

A change becomes a **job**: staged with its parameters pinned, approved, then run. The job records
its steps, its output, and an audit entry; the Activity drawer follows it live. Approval is the
single gate, the same checks apply whether the request came from the UI, a schedule, or the API.

Secrets given to a job (a share password, a cloud key) stay in memory. The database holds
`"[secret]"` in their place, so a backup of BoxPilot's own database never carries them.

## Applications

A catalog app is a YAML manifest plus a Compose template ([`catalog/`](../catalog)). Install,
update, reconfigure, back up, restore and uninstall are generic: no app has its own code path.
Manifests are validated strictly. Unknown keys are errors, image tags are pinned, and an app that
reaches the Docker socket, the host network, or kernel capabilities cannot be marked low risk.

Each app lives in `/var/lib/boxpilot-managed/catalog/<id>/` with its own `.env`, Compose file and
volumes. Ports bind to the LAN address or to loopback, as the manifest says.

## Concurrency

The helper runs one operation at a time *per subject*: one lane per app, one per VM, one shared
lane for host-level work (apt, systemd, storage, firewall, users), and an exclusive lane for
whole-box operations such as a machine snapshot, which runs alone. Two apps can install at once;
two operations on the same app never overlap.

## Identity and roles

Sign in with a local password, a **Tailscale** identity, or **GitHub** (device flow, no client
secret, no callback URL). Identities are linked per account: a login signs in as the account that
linked it. The first Tailscale sign-in in a browser also asks for the password once, because
anything able to reach the loopback port could otherwise claim a tailnet address.

| Role | Can |
| --- | --- |
| owner | everything, including settings, people, and high-risk approvals |
| operator | stage and approve low- and medium-risk work; not settings or people |
| viewer | look; run read-only inspections |

Sessions are cookies (`HttpOnly`, `SameSite=Strict`, `Secure` behind TLS) with a CSRF token
required on every change. Repeated wrong passwords throttle that account.

## What is written where

| Path | Contents |
| --- | --- |
| `/opt/boxpilot` | the release; replaced wholesale by an update, with the previous tree kept for rollback |
| `/var/lib/boxpilot` | SQLite database, job logs, audit log (root-only) |
| `/var/lib/boxpilot-managed` | app projects, app backups, machine snapshots |
| `/etc/boxpilot/secrets` | credentials for shares and cloud destinations (0600, root) |
| `/run/boxpilot` | the helper socket and one spec file per running root task |

## Updating

*System → BoxPilot updates* checks GitHub for a newer release. The update downloads the reviewed
commit (not the tag, which can move), builds it, swaps `/opt/boxpilot`, restarts both services and
health-checks the result, rolling back to the previous tree if the new version does not answer.

## Reading further

- [ADR-001](DECISIONS.md). Why risk tiers replaced password-for-everything
- [Roadmap](ROADMAP-V2.md). What exists and what is next
- [Backups](BACKUPS.md) · [Recovery kit](RECOVERY.md) · [Virtual machines](VIRTUALIZATION.md)
