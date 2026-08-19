# Architecture decision records

Short, dated records of decisions that change the product's direction. Newer entries supersede older ones where they conflict. Add a new entry rather than editing an accepted one.

---

## ADR-001 — BoxPilot is a point-and-click server setup tool; risk tiers replace universal password approval

**Date:** 2026-08-19 · **Status:** Accepted · **Supersedes:** the "safety-first control plane" framing in `README.md` and `docs/ROADMAP.md` phases 0–9 where they conflict.

### Context

Through `0.61.0` every host mutation — including low-impact actions such as restarting a managed container — followed the same path: create an immutable plan, stage it, navigate to Repair Center, re-enter the owner password, approve, verify. Each operation was a fixed, argument-less helper call with hand-written boundary prose and a bespoke systemd unit. The result:

- ~550–650 LOC across ~13 files per new privileged operation; ~700–900 LOC per new application.
- Three applications and five package repairs after ~39k LOC.
- No uninstall, no configuration editing, no updates, no general package or service management, no installer, no first-run wizard.
- Operator copy and API values written as disclaimers about what the product refuses to do.

The owner's goal for the product is the opposite: open the app on a fresh Ubuntu Server and point-and-click through updates, dependencies, application and platform installs (Pi-hole, dashboards, VMs for projects), uninstalls, configuration changes, backup, and fast redeploy — with GitHub and Tailscale identity. See `docs/ROADMAP-V2.md`.

### Decision

1. **Product goal.** BoxPilot is an all-in-one, point-and-click setup and management tool for a fresh Ubuntu Server. Capability breadth and low friction are first-class goals. Safety is delivered through *previews, audit, checkpoints, and undo*, not through refusing to act.
2. **Risk tiers replace password-per-action.** Every operation declares a risk tier:
   - `low` — read, start/stop/restart, refresh, view config: one click, audited.
   - `medium` — install/uninstall-keep-data, apt install/upgrade, create VM, edit config: one confirmation showing a plain-English preview of what will change.
   - `high` — uninstall with data purge, DNS cutover, disk format, VM delete, firewall/SSH changes, restore over live data: password (or passkey) plus typed confirmation.
   A successful password unlocks a short **elevated session** (default 10 minutes) so batch setup does not re-prompt. An "always ask" setting restores today's behaviour for operators who want it.
3. **One operation registry.** Operations are declared once (`id, title, risk, params schema, privileged, readOnly, timeout, run, verify, rollback`). The helper allowlist, read-only set, timeouts, parameter validation, job execution, and UI affordances derive from the registry. The three hand-synced allowlists and the per-type ternary chain in `server/jobs.mjs` are retired.
4. **General primitives are in scope.** apt, dpkg, systemd, reboot, docker/compose, ufw, users/SSH keys, netplan (validated), tailscale, and managed-path file edits are legitimate helper operations, each parameter-validated and audited.
5. **Data-driven catalog.** Applications are YAML manifests plus a compose template and optional hooks, deployed by one generic deployer with install / uninstall / update / reconfigure. App-specific JavaScript is the exception, not the rule.
6. **Copy describes what happens, not what is refused.** Operator-facing text names the action and its effect. Boundary disclaimers move to `docs/SAFETY.md` if they are needed at all.
7. **No personal host data in the repository.** Hostnames, MACs, LAN layouts, and router models belong in placeholders or ignored `*.local.md` files.

### Consequences

- Existing guarded workflows keep working during the transition; they are ported to the registry and re-tiered rather than rewritten from scratch.
- `README.md` and `docs/ROADMAP.md` will be rewritten around the new goal; until then `docs/ROADMAP-V2.md` is authoritative.
- Anyone (human or agent) adding a feature should add a registry entry or a catalog manifest, not a new named systemd unit, a new per-workflow SQLite ledger, or a new paragraph of boundary prose.
