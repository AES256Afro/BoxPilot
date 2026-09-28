# Handoff: the interface redesign, and what 1.119.0 shipped

> **Decided 2026-09-28:** the owner chose the Launcher (Home) and the Command Center (Ops), in light
> and dark following the device. See ADR-004 in `docs/DECISIONS.md` and M33 in `docs/ROADMAP-V2.md`;
> section 8's questions are answered there. Section 1 describes 1.119.0; releases since are in git.

Written 2026-09-27 by a Claude session working in the LLMCoach repo, which also did BoxPilot work
that day. It is a proposal to fold into `docs/ROADMAP-V2.md`, not part of it yet: nothing below has
been added to the roadmap, and the owner has not yet chosen between the designs. No personal host
data here, per AGENTS.md; the server is called `homebox` as in the demo.

## 1. Already done: 1.119.0 (PR #262, merged 2026-09-27)

B0 in the plan below is finished. The PR was merged with `--merge`, so every fix keeps its own
commit: `git log 4f1b249^1..4f1b249^2` lists them.

- **MinIO repaired.** `catalog/minio.yaml` now uses `docker.io/pgsty/minio:RELEASE.2026-08-04T00-00-00Z`
  (the upstream images stopped being published). The `tags-resolve` check is green again, so a red
  run now means a real missing tag.
- **The port-in-use message names the owner.** `server/ports.mjs` (`containersPublishing`) finds the
  container holding a port and `src/portConflict.ts` (`describePortConflict`) says which app it
  belongs to and what to do, instead of a bare "port in use".
- **NVIDIA GPU passthrough.** `server/nvidia.mjs` (`createNvidiaInspector`, `dockerHasNvidiaRuntime`,
  `parseNvidiaSmi`, `nvidiaNextStep`); compose rendering adds a GPU device reservation
  (`nvidiaGpuReservation`, `wantsGpu`) when a manifest says `gpu: optional` and Docker can provide
  one. `catalog/ollama.yaml` and Open WebUI's Ollama sidecar opt in. There is a read operation,
  `prerequisite.nvidia.inspect`, and a Repair Center check. **Not yet tried on real hardware:** the
  owner's server has no GPU installed yet (an RTX 4080 16 GB is planned), so this is covered by unit
  tests and Linux CI only. Expect a follow-up once the card is in.
- **Bug sweep, four areas** (merged as `fix/firewall-sweep`, `fix/backup-sweep`, `fix/core-sweep`,
  `fix/ui-sweep`). Among them: Docker firewall sync and from-scratch rollback; restores staged
  through a folder, never a symlink; the deployed compose file restored when an update or rollback
  fails; scheduled runs kept on wall-clock time across DST; job log lines kept in order past the cap;
  X-Forwarded-For trusted only through Tailscale Serve; modal focus containment and Escape; the top
  bar kept inside a phone screen when elevated.
- **LLMCoach is a catalog app** (`catalog/llmcoach.yaml`, image `ghcr.io/aes256afro/llmcoach:0.2.0`,
  port 8420, `data` volume backed up, `cache` volume excluded). How to ship a new LLMCoach version is
  in section 7.

## 2. The redesign study

Eight directions, two full-size screens each, drawn with a realistic setup (placeholders only):
**`docs/design-directions/04-eight-directions.html`**. Open it in a browser; it needs Google Fonts
and nothing else. It continues the earlier studies `01-terminal`, `02-control-panel` and `03-raw`.

| # | Direction | Idea in one line |
|---|---|---|
| 1 | Launcher | Apps as a home screen of tiles with health badges; admin areas in a dock; catalog as an app store with an install sheet (where data lives, who can reach it, risk tier). |
| 2 | Command Center | Dense ops console: metric strip, alerts, containers, action inbox by tier, job queue, backup matrix; firewall screen compares listening ports with allowed ones. |
| 3 | Recipes & Guides | "What do you want to do?" Guided recipes with a plan panel listing each step's tier; resumable; teaches by constraint (an internal disk greyed out as "not off-box"). |
| 4 | Topology Map | The box as a map: disks → folders/shares → apps → firewall (a wall with gates) → LAN/tailnet. Lenses for Storage, Network, Backups; a storage lens with disks to scale. |
| 5 | Timeline | Every change, job and automation run as a feed with inline diffs and an undo gated by the original tier; "since last week" digest; change detail with rollback plan. |
| 6 | Copilot | Plain-language requests on the local Ollama become plan cards built only from registered operations, each step with its tier; morning briefing from last night's jobs. |
| 7 | Pocket | Phone first: one health status, one-decision cards, bottom tabs, actionable push through ntfy; a gesture per tier (tap / review + slide / passkey + typed hostname). |
| 8 | Calm Settings | GNOME/macOS-style settings: searchable sidebar, grouped rows, one switch per app for "reachable on my network", approval policy shown as ordinary settings. |

The page ends with a comparison (density, learning curve, phone fit, build effort) and three
suggested combinations.

## 3. Recommendation: one blended design (awaiting the owner's decision)

Unlike LLMCoach, which is getting separate "studios" for people who work differently, a server
manager is judged on one question: can you tell at a glance that the box is fine, and fix it in one
move when it isn't? So the proposal is one design built from five directions:

| Where | From | Job |
|---|---|---|
| Home | Launcher | App tiles with live health, a few system widgets and the action inbox. Answers "is everything OK?" on one screen. |
| Command bar | Copilot | Ctrl K: search everything, or type what you want and get a plan of registry operations to approve. |
| History | Timeline | Jobs, checkpoints and settings changes as one readable feed, with "Undo this change". |
| Settings | Calm Settings | Storage, Network, Firewall, Users and System become one searchable settings area instead of separate dashboards. |
| Phone | Pocket | The same home, inbox and timeline laid out for a phone, installable, with push through ntfy. |

Topology becomes the picture at the top of Storage and Network; Recipes live behind the Launcher's
"Add" button and inside Copilot; Command Center is an optional dense view.

Problems this addresses (from reading the code during the sweep): about fifteen top-level pages that
each act as a dashboard; panels that open with paragraphs before the status; risk tiers that only
appear once a dialog opens; every block the same card weight, so nothing stands out; and tables and
the top bar that did not fit a phone (partly fixed in the sweep).

## 4. Proposed milestones and where they meet ROADMAP-V2

Each step ships on its own, and the current pages stay reachable (as "Classic") until their
replacement is done. Sizes are rough: S under a week, M one to two weeks, L more.

| Step | What | Done when | Overlaps with |
|---|---|---|---|
| **B0** ✅ | Ship the sweep: 1.119.0. | Released 2026-09-27. | — |
| **B1** (M) | Design system: color and type tokens, light and dark, a density setting, shared components (buttons that carry their risk tier, status chips, cards used sparingly), a gallery page. | One existing page is rebuilt on it with no visual regressions elsewhere. | §5.8 UI (light theme, shared `<ApproveAction risk=…>`), M28 (one voice, one name) |
| **B2** (M) | New shell and Launcher home: new navigation, app-tile home, action inbox, notification center, command bar ready for search. | "Is everything OK?" is answered by the home screen alone. | §5.8 Dashboard "what needs attention", M25.3 today view, M27 (nothing known and shown to nobody) |
| **B3** (M) | Timeline and undo: jobs, checkpoints and settings changes as one feed with diffs and undo. | You can undo last night's update from the timeline. | M22.2 update history and the way back, the audit trail |
| **B4** (L) | Calm Settings migration, one area at a time, with the Topology picture on Storage and Network. | The old dashboards for those areas can be retired. | M23 storage, M28 copy, §5.8 router |
| **B5** (M–L) | Copilot: requests become plans made only of registry operations, each with its normal approval. Runs on the local Ollama. | "Install Jellyfin and share /srv/media" produces a correct plan approved in one step. | M24 automation intelligence, M13 flows |
| **B6** (M) | Pocket: phone layout, installable app, push through ntfy. | A failed backup reaches the phone and can be retried from there. | M25.1 PWA, M25.2 push approvals, M19.1 passkeys |
| **B7** (M) | Recipes and a GPU page: bundled installs ("Media server" = Jellyfin + share + firewall rule + backup as one reviewed plan); which apps use the GPU and how much memory; a one-click NVIDIA driver and container-toolkit installer. | A fresh box with an NVIDIA card goes from "no driver" to Ollama on the GPU without a terminal. | M3 catalog, M22 app lifecycle, the new `nvidia.mjs` |

Options for folding this in: add it as one new milestone (for example "M33 — One interface",
with B1–B7 as M33.1–M33.7), or distribute each step into the milestone it overlaps. The first keeps
the redesign reviewable as a unit; the second avoids two plans for the phone (B6 and M25).

Other upgrades noted along the way, not yet placed: search across apps, settings, logs, jobs and help
(the Copilot box); app cards with the numbers that matter for that app (photos in Immich, streams in
Jellyfin, models loaded in Ollama); a disk map with SMART health and a space forecast (M23.1 has the
forecast); managing a second machine (Phase 11).

## 5. Guardrails for whoever builds it

- **Keep safety visible.** Show the risk tier on every action button, not only inside the dialog.
- **Copilot never freelances.** It may only propose registered operations, with their normal
  approvals and previews. It never runs shell commands.
- **Migrate gradually.** Replace one area at a time; keep the demo scenarios (`?scenario=fresh`,
  `?scenario=trouble`) and `npm run demo:sweep -- --deep` passing for every new page.
- **No personal host data** in committed files. The mockups copy already uses placeholders.

## 6. What LLMCoach would like from BoxPilot

LLMCoach (github.com/AES256Afro/LLMCoach) now has seven studios over one engine (Chat, Classic,
Pipeline Canvas, Mission Control, Workbench, Field Notebook, Friendly), watched folders with a
secret/PII check, a nightly learning loop, ntfy alerts, and export of fine-tunes into Ollama. Status as
of 2026-09-27 evening:

- **Done: an inbox volume** (shipped in 1.121.0). BoxPilot PR #267 (from the LLMCoach session) bumped
  `catalog/llmcoach.yaml` to 0.7.0 and added a configurable `inbox` hostPath volume (default `/srv/llmcoach-inbox`, mounted at `/inbox`,
  `LLMCOACH_INBOX_DIR=/inbox`, not backed up). The owner shares it over SMB from Storage, or points it
  at a mounted network share. Nothing else in BoxPilot was needed for this.
- **GPU for LLMCoach.** From LLMCoach 0.8.0 every release also publishes
  `ghcr.io/aes256afro/llmcoach:X.Y.Z-cuda` (PyTorch 2.8 on CUDA 12.8, plus bitsandbytes). Once the
  RTX 4080 is installed, point `image.reference` in `catalog/llmcoach.yaml` at the `-cuda` tag and add
  `gpu: optional`. The CUDA image also runs on a CPU, but it's several GB larger, so there's no reason
  to switch before the card is in. LLMCoach's `/api/health` now reports its version (e.g. `0.8.0-cuda`).
- **Exported models land in BoxPilot's Ollama.** LLMCoach's export job uploads blobs and calls
  `/api/create` on the Ollama it's configured with, creating models named `llmcoach-<project>-ft<id>`
  (about 0.5 GB each at q8_0 for a 0.5B model). They show up in BoxPilot's Ollama model list like any
  pulled model; nothing to change, but worth knowing when disk space is reviewed.
- **Backups.** The `data` volume (projects, datasets, trained adapters) is already backed up and the
  `cache` volume is excluded; nothing to change, but restores of it are worth a drill.
- **Whisper and ntfy** as catalog apps, for voice notes into LLMCoach and alerts when training ends.

In return, LLMCoach can later train the model Copilot (B5) uses, on BoxPilot's own docs and operation
registry, and evaluate it before it replaces the stock Ollama model.

## 7. Shipping a new LLMCoach version through the catalog

1. In LLMCoach, push a `vX.Y.Z` tag. Its Action tests and publishes `ghcr.io/aes256afro/llmcoach:X.Y.Z` (public).
2. Here, bump `image.reference` and `image.version` in `catalog/llmcoach.yaml` and open a PR.
3. After merging, `npm version minor -m "Release %s"`, push `main` and the tag; the release workflow
   publishes, and the owner updates from System → Update.

Installed boxes only see catalog changes that ship in a BoxPilot release. BoxPilot's tests do not run
on Windows (Unix sockets, permissions, tar); rely on the Linux CI or compare against a `main` baseline.

Released so far: LLMCoach 0.3.0 (Chat studio), 0.4.0 (inbox and learning loop), 0.5.0 (Mission
Control, alerts), 0.6.0 (Pipeline Canvas), 0.7.0 (Workbench, Field Notebook, Friendly Studio, export
to Ollama). PR #267 was merged and released as **BoxPilot 1.121.0** (2026-09-27), so installed boxes
get LLMCoach 0.7.0 and the inbox volume from System → Update. LLMCoach 0.8.0 (S3/MinIO buckets as inbox
sources, held uploads, a Review-first chat target, split panes) followed in **BoxPilot 1.123.0** (PR #274). LLMCoach 0.9.0–0.10.1 (web pages, sitemaps and feeds as sources; OCR for scanned PDFs, so the
image now carries Tesseract; moving a project between installs as one zip) shipped as LLMCoach 0.10.1 in
**BoxPilot 1.124.0** (PR #275). LLMCoach 0.11.0 (voice notes through the catalog's Whisper app, model cards, a
"Send to LLMCoach" bookmarklet) is in **BoxPilot 1.125.0** (PR #276), whose manifest adds an optional
`LLMCOACH_WHISPER_URL` ("Where Whisper is", e.g. `http://host.docker.internal:9002`). LLMCoach 0.11.1 (a privacy fix: held documents
stay out of the index) is in **BoxPilot 1.126.0** (PR #277), the latest as of 2026-09-27 22:00.

## 8. Decisions still with the owner

1. Is the blend right (Launcher home, Copilot command bar, Timeline, Calm Settings, Pocket), or a
   different mix from the eight?
2. Where does B1 fall against the open M26–M32 work?
3. Fold in as one milestone, or distributed (section 4)?
