# Handoff: Keel in the app catalog

Context from the session that made Keel installable from BoxPilot. Keel is a
sibling project in its own repository; this file covers only what BoxPilot
needs to know. No personal host data, per AGENTS.md.

## What Keel is

A self-hosted notebook: pages with wikilinks and backlinks, databases with
table, board, timeline and mind-map views, daily notes, full-text search, and a
graph view. Next.js 16, Prisma, SQLite by default (PostgreSQL supported).
Single user or a small team. Its own repository ships release tarballs, guided
installers, an Electron desktop app, and an iOS client.

## What landed here

`catalog/keel.yaml`, on branch `catalog-keel`. Knowledge category, one web
port, one data volume, `health.kind: healthcheck`.

Choices a reviewer will otherwise wonder about:

- **One volume, not three.** Keel keeps its database, its backups and uploaded
  attachments together under `/data`. Splitting them would let a backup of "the
  data volume" miss the attachments the notes point at.
- **`healthcheck`, not `running`.** The image carries its own HEALTHCHECK
  against `/api/health`, which is unauthenticated and touches no database. It
  reports the app serving rather than the process existing.
- **No `user:` field.** The image declares `USER node`, and `app-helper`
  resolves the volume owner from the image when the manifest is silent, so the
  data directory is chowned to 1000:1000 without the manifest asserting a uid
  that could drift from the image.
- **No `signIn` block.** Keel has no env-supplied password: the first sign-up
  becomes the workspace owner. The schema is right to require `passwordEnv`,
  and there is no credential for that panel to show.
- **`KEEL_SERVER_SECRET_KEY` is deliberately absent.** It applies only to
  managed credentials on PostgreSQL and must decode to exactly 32 bytes. A
  generated generic secret would be the wrong shape, and offering it on a
  SQLite install would be a setting that can only be got wrong.

## The blocker: no image exists yet

This is the one thing to know before trying an install.

BoxPilot deploys images. `server/catalog/schema.mjs` requires
`image.reference`, rejects unknown fields, and has no build-from-git path, so
an app that only ships source cannot be catalogued. Keel shipped only source.

Keel's side now has a workflow (branch `keel-container-image`) that builds
linux/amd64 and linux/arm64 and pushes `ghcr.io/<owner>/keel:<version>` and
`:latest` on a `v*` tag. Until that branch merges and a version is tagged:

- **no image is on GHCR**, so installing Keel from the catalog will fail to
  pull;
- the manifest pins `1.2.6`, which is the version that must be tagged first;
- the first publish creates a **private** package. It has to be made public in
  the Keel repository's package settings, or BoxPilot cannot pull it
  anonymously.

Bump `image.reference` and `image.version` together whenever Keel releases.

## How this was verified

Not by inspection alone. Against a locally built image, standing in for the
unpublished one:

- the manifest validates through `loadCatalog()`: 164 entries, no problems;
- `server/catalog-install-smoke.test.mjs` passes with it, which drives every
  manifest through the real deploy path;
- the compose that `renderCompose` actually produces was deployed with
  `docker compose up`. The container reached `healthy` on its own healthcheck,
  `/api/health` and `/login` answered, and `keel.db` plus `backups/` appeared
  in `./data`;
- replacing the container against the same volume reused the database rather
  than recreating it (Keel logged "No pending migrations to apply"), which is
  what a catalog update and a rollback depend on;
- the container runs as uid 1000, not root.

## Port note

The manifest defaults the host port to 3080 rather than Keel's own 3000,
because 3000 is a busy default on a box that already runs a dashboard. Owners
can change it in the UI like any other app.

## If Keel is reached from outside the LAN

Two settings do the work, both exposed in the manifest:

- `KEEL_PUBLIC_URL` must be the address the owner actually reaches Keel at.
  Sign-in redirects and copied links are built from it; without it they point
  at the container's own hostname.
- `KEEL_ALLOWED_EMAILS` is an allow-list. Registration is open by default, so
  this is what keeps a reachable Keel private. It should include the owner
  address, and the Google address too if Google sign-in is used.

`KEEL_BACKUP_PASSPHRASE` encrypts scheduled backups. It is worth saying plainly
in any UI copy that a lost passphrase means an unrecoverable backup.
