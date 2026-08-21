# Handoff: the sibling ops CLI

Context from the remote Claude session that built BoxPilot's companion tool.
No personal host data here per AGENTS.md; host-specific notes live in the
sibling repo's own HANDOFF.md.

## The sibling project

**The ops CLI** (a private sibling repo, v1.4.x) is a one-file Node CLI
that runs beside BoxPilot on the same server and from an operator's laptop
over SSH. It covers the read-and-alert side of operations:

- `status` / `doctor`: one-screen health with exit codes for scripting
- `notify`: ntfy / Gotify / Uptime Kuma push / webhook alerts with
  once-per-failure dedup, recovery messages, and a daily digest
- `secure`: a read-only Ubuntu security baseline with plain-language findings
- `net`: a layered network-diagnosis ladder with a verdict
- `stacks` / `ports`: Docker fleet visibility (compose-label discovery)
- `gui`: a loopback, token-gated dashboard; `--host` drives a remote box

## Division of responsibilities

BoxPilot is the product that installs, updates, configures, backs up,
restores, and redeploys applications, platforms, and VMs (ADR-001).

The ops CLI observes, diagnoses, and alerts. It links to BoxPilot for operations
instead of duplicating them: its earlier plans for a restore rehearsal, a
deploy catalog, and an identity-gated exposure gateway are ceded to
BoxPilot's roadmap, where those capabilities already exist or are underway
(e.g. Tailscale/GitHub sign-in on this branch).

## Integration ideas, when wanted

- the ops CLI pushes health verdicts into an Uptime Kuma instance BoxPilot deploys
- a BoxPilot catalog entry that installs the ops CLI watchdog service
- the ops CLI `secure` findings rendered in a BoxPilot panel (read-only feed)

Each fits the operation-registry model in ROADMAP-V2 when that lands.
