# Working on BoxPilot

Read this before changing anything. It applies to humans and coding agents alike.

## What BoxPilot is

A point-and-click setup and management tool for a fresh Ubuntu Server. From the browser the owner installs updates, dependencies, applications and platforms (Pi-hole, dashboards, Docker stacks), creates VMs for projects, signs in with GitHub or Tailscale, and backs up / restores / redeploys quickly. Uninstall and configuration editing are core features, not exceptions.

The authoritative plan is `docs/ROADMAP-V2.md`. The governing decision is `docs/DECISIONS.md` → ADR-001. Where older docs (`docs/legacy/`, `docs/VIRTUALIZATION.md`, `docs/INVENTORY.md`) describe a "safety-first control plane" that refuses general operations, ADR-001 wins.

## How to add things

- **A new operation** (anything that runs on the host): add one registry entry with `id`, `title`, a risk tier (`low` / `medium` / `high`), a parameter spec (`parameters.fields` — types, patterns, limits), `run`, and, for anything destructive, `confirm` and `minimumRole`. Verification and rollback belong inside `run`, and a result that must survive goes through an `operationRecordHooks` entry. Do **not** add a new named systemd oneshot unit, a new per-workflow SQLite table, or a new branch in `server/jobs.mjs`'s approval chain: the registry has landed, and every mutation already goes through it.
- **A new application**: a YAML manifest + compose template (+ optional hooks) in the catalog, deployed by the generic deployer. App-specific JavaScript needs a justification. The image must be publicly pullable before the manifest lands: a new GHCR package starts private, `catalog-check-images` reports the registry's 401 as `MISSING`, and nothing here holds registry credentials, so no server could install the app. Visibility is a one-way switch in the package's own settings (Danger Zone → Change visibility); there is no API for it.
- **An app Today reads** (a card of its figures, a tool the agents cite): one reader module in `server/` (`server/baselinewatch.mjs` is the shape: pure summarising, every field checked, a bounded read of the app's own API from the web service), registered in `server/app-glances.mjs` with the card's title and window, and a tool in `server/agents/tool-catalog.mjs` that calls it. The card is keyed off the catalog app being installed, and the Today page draws whatever the server sends: nothing about the app lives in the UI.
- **Risk tiers, not password-for-everything**: low = one click; medium = one confirmation with a preview; high = password/passkey + typed confirmation. A password unlocks a short elevated session.
- **The tier follows the target** (ADR-015): an operator approves medium jobs alone, so a medium operation whose parameters can reach what a high one guards (a home folder, a protected package, the backup destination, BoxPilot's own address, data that leaves the box) gets a hook in `server/ops/escalation.mjs` that raises it to high for those values. Refuse outright only what no one legitimately needs.
- **Reads have a rule too** (ADR-003): a `readOnly` operation needs `minimumRole: "operator"` when it runs in the root helper *and* returns something the caller could not have read themselves — a directory listing, an archive's contents, a log, the size of someone else's data. Everything else stays open to viewers.
- **Copy**: say what the action does. Do not write paragraphs about what the product refuses to do; do not add boundary slugs to API responses.
- **Version**: `package.json` is the only source. Import `productVersion` from `server/version.mjs` (server/scripts) or use `__BOXPILOT_VERSION__` (UI).
- **No personal host data** in committed files: no real hostnames, MAC addresses, LAN layouts, router models. Use placeholders; private copies go in `*.local.md` (gitignored).
- **Types**: the server is type-checked (`npm run check:types`, `tsconfig.server.json`: `checkJs`, not strict). Declare an options object or a factory's dependencies with a JSDoc `@param` rather than leaving TypeScript to read `= {}` as `{}`; cast to `any` only what is really dynamic (parsed JSON, a remote reply). No `@ts-ignore`.
- **Tests**: inject clocks (`now`) and never rely on the wall clock against dated fixtures. `npm run check` must pass (build + types + vitest + shell syntax). Platform-gated tests come from `test/platform.mjs`, at the narrowest level that works, next to a comment naming what they need: `it.skipIf(onWindows)` for a test that only needs a POSIX filesystem (modes, file symlinks, `/usr/bin/tar`, `/mnt/...` resolving as itself), which a macOS checkout has; `it.skipIf(!onLinux)` for one that needs Linux itself (root's home at `/root`, `/bin/true`, a chown that changes ownership, GNU coreutils, observable `fsync` ordering). Linux CI runs every one of them either way. Pick `onWindows` unless the test really does need Linux: a run on macOS should be green, so a failure there is a regression worth chasing.

## Conventions

- Server: Node ≥ 24, ESM `.mjs`, Express 5, `node:sqlite`. UI: React 19 + Vite + TypeScript, one global stylesheet.
- Root work runs in the helper (`server/helper-server.mjs`) over the Unix socket; the web process stays unprivileged.
- Keep the systemd hardening pattern from `deploy/boxpilot-helper.service` for anything that runs as root.
- Commit messages: imperative subject, short body explaining *why*.
