# Working on BoxPilot

Read this before changing anything. It applies to humans and coding agents alike.

## What BoxPilot is

A point-and-click setup and management tool for a fresh Ubuntu Server. From the browser the owner installs updates, dependencies, applications and platforms (Pi-hole, dashboards, Docker stacks), creates VMs for projects, signs in with GitHub or Tailscale, and backs up / restores / redeploys quickly. Uninstall and configuration editing are core features, not exceptions.

The authoritative plan is `docs/ROADMAP-V2.md`. The governing decision is `docs/DECISIONS.md` → ADR-001. Where older docs (`docs/legacy/`, `docs/VIRTUALIZATION.md`, `docs/INVENTORY.md`) describe a "safety-first control plane" that refuses general operations, ADR-001 wins.

## How to add things

- **A new operation** (anything that runs on the host): add one registry entry with `id`, `title`, a risk tier (`low` / `medium` / `high`), a parameter spec (`parameters.fields` — types, patterns, limits), `run`, and, for anything destructive, `confirm` and `minimumRole`. Verification and rollback belong inside `run`, and a result that must survive goes through an `operationRecordHooks` entry. Do **not** add a new named systemd oneshot unit, a new per-workflow SQLite table, or a new branch in `server/jobs.mjs`'s approval chain: the registry has landed, and every mutation already goes through it.
- **A new application**: a YAML manifest + compose template (+ optional hooks) in the catalog, deployed by the generic deployer. App-specific JavaScript needs a justification.
- **Risk tiers, not password-for-everything**: low = one click; medium = one confirmation with a preview; high = password/passkey + typed confirmation. A password unlocks a short elevated session.
- **Copy**: say what the action does. Do not write paragraphs about what the product refuses to do; do not add boundary slugs to API responses.
- **Version**: `package.json` is the only source. Import `productVersion` from `server/version.mjs` (server/scripts) or use `__BOXPILOT_VERSION__` (UI).
- **No personal host data** in committed files: no real hostnames, MAC addresses, LAN layouts, router models. Use placeholders; private copies go in `*.local.md` (gitignored).
- **Tests**: inject clocks (`now`) and never rely on the wall clock against dated fixtures. `npm run check` must pass (build + vitest + shell syntax).

## Conventions

- Server: Node ≥ 24, ESM `.mjs`, Express 5, `node:sqlite`. UI: React 19 + Vite + TypeScript, one global stylesheet.
- Root work runs in the helper (`server/helper-server.mjs`) over the Unix socket; the web process stays unprivileged.
- Keep the systemd hardening pattern from `deploy/boxpilot-helper.service` for anything that runs as root.
- Commit messages: imperative subject, short body explaining *why*.
