# How to build a page

Every page but Home is drawn inside the console (M33.8, ADR-004 addendum): the Command Center's
rail down the left (the dock along the bottom on a phone), a compact bar across the top, and the
Command Center's look, near-black or paper, light and dark. A page builds on the kit in `src/ui/`
and puts its own layout in its own stylesheet. `src/pages/services/` and `src/pages/logs/` are the
reference pages; copy their shape. `src/pages/settings/` shows a page of tabs (`Tabs` with
`urlParam`, the owner's tabs left out for other roles) and forms on `Field`; `src/pages/signin/`
is the one page outside the console, on the Launcher's wallpaper.

## The shell gives you

- **The bar.** Your page's `PageHeader` puts its name there after the server's, as the study drew
  it: `homebox / services`. That name is the page's one `h1`. Do not draw another title.
- **The rail and the dock.** Nothing to do. The rail marks your area as current; Home / Ops and
  Ctrl K work everywhere.
- **The look.** The shell sets `data-shell="console"` on `<html>` and on `.app-shell`, and points
  the base token names (`--surface`, `--text`, `--accent`, `--link`, `--status-*`, `--risk-*`) at
  the Command Center's (`--cc-*`). A component that uses tokens is right in light and dark with no
  work. Dialogs and sheets opened over the page get the same look, because the tokens are on the
  root.
- **Compact density.** The console's content has `data-density="compact"`.
- **Your address.** `?view=<area>`. A page's own parameters (a tab, a filter) are dropped when the
  owner changes page; only `scenario` (the demo's world) survives.

Every page is on the kit (M33.14). A new page adds its view to `ownHeader` in `src/App.tsx`, so
the shell draws no header for it, and renders its own `PageHeader`. While its code arrives the
shell shows `src/shell/PageLoading.tsx` (the kit's `Progress`, named for the page).

The shell also owns what opens over any page (M33.13), so a page never draws these itself:

- **The approval dialog** (`src/shell/ApproveDialog.tsx`; import it from there, the old
  `src/ApproveDialog.tsx` is gone). Call `useOperation(csrfToken, onFinished)` and
  render its `dialog` once; `start({ operationId, title, parameters, preview })` opens it. Give it
  a `preview` that says in words what will happen (the command, the path, what stops): it is the
  "What it will do" box, and without one the dialog falls back to the registry's description.
  The tier, the password, the typed confirmation, the run (`JobProgress`) and the ending (the job
  log) are the dialog's. `onStaged`, `handoff`, `moreTimeFor` and `existingJobId` are there for
  Repair, Activity, Home and Ops.
- **Activity and the notifications**, the job log (`src/JobLogView.tsx`) and the page error
  (`src/shell/PageErrorBoundary.tsx`). Show one job inline with the kit's `JobProgress`, or its
  whole log with `JobLogView`.
- **The console's look everywhere.** What the shell draws over a page carries `look-console`
  (`src/shell/look.css`), so it is the same on Home, whose root keeps the Launcher's tokens. The
  shell's own sheets live in `src/shell/<name>.css`, every selector under `.<name>-`, held by
  `src/shell/shellCss.test.ts` as the pages' are by `src/pages/pageCss.test.ts`.

## The rule: facts first

1. **The verdict first.** `PageHeader`'s `status` is one `StatusChip` that answers "is this area
   OK?": `2 failed` in red, `None failed` in green, `Not read` when it could not be read. Never
   green about something unread (M28.5).
2. **Then the facts,** in mono: `meta` in the header (`142 units · 98 active · 2 failed`), a
   `KeyValue` strip or `MetricTile`s when there are more.
3. **Then the panels** with the rows, each `Panel` with its count and its facts on the right.
4. **No explainer paragraphs above the facts.** What the page is for goes in `PageHeader`'s
   `about`, behind the info toggle. A longer explanation belongs to the assistant (M34), not the
   page. One sentence under a verdict is fine (`summary`); a paragraph is not.
5. **Every action carries its tier.** A `Button` that starts an operation has `risk` (from
   `riskOf(operationId)` in `src/ui/operationRisk.ts`, which the server's registry test holds to
   the truth) and goes through `useOperation` and the approval dialog, unchanged. A button that
   changes nothing on the server (Read again, Copy, Show output) has no tier. Leave out the buttons
   a role cannot use: `mayStart(role, operationId)`.
6. **Say what failed.** A request that fails is a `Notice tone="danger" live` with a Try again
   action; an empty list is an `EmptyState` with the one action that would fill it.

## The kit (`src/ui/`)

| Component | What it is for |
| --- | --- |
| `PageHeader` | The page's name in the bar, the verdict, a sentence, the mono facts, the actions, and `about` behind the info toggle. `placement="inline"` draws the name in place (the gallery). |
| `Panel` | The console's panel (Ops' and Repair's): an uppercase mono title, a count (`12`, or `{ status, label }` with its mark), facts on the right, actions, a body, a footer. The body draws its rows to the edges; `padded` for words, a form or facts. A region named by its title, or by `label` when the title alone would not do. |
| `Field` | A label, one control, then its hint or error. The control inside takes the field's id, description and invalid state. |
| `TextInput`, `Textarea` | Text, with `mono` for paths, units, addresses and keys, and `onValueChange`. |
| `Select` | The browser's own select with the kit's face: keyboard, screen readers and a phone's picker all work. `options`, `placeholder`, `onValueChange`. |
| `SecretInput` | A password, token or key: masked until Show, never autofilled or spell-checked, in mono. |
| `Switch` | On or off, `role="switch"`; `risk` when flipping it starts an operation. State shown by position, fill and the word On/Off. |
| `Checkbox` | A real checkbox under the drawn box; `indeterminate` for "some". |
| `Segmented` | One of a few, side by side, as a radio group (arrow keys, one tab stop). Filters and scopes; a choice that changes the server is a form. |
| `Tabs` | The ARIA tabs pattern; `urlParam="tab"` keeps the open tab in the address (`?view=storage&tab=shares`). `useUrlParam` for any other page parameter. |
| `KeyValue` | Facts as a description list: `rows` (a sheet), `columns` (a summary), `strip` (the study's row of key facts across the top of a page). |
| `Facts` | One line of facts in mono, as `PageHeader`'s `meta` draws them: figures in `<b>`, names and ids in `<code>`. `as="span"` inside a row's words. |
| `MetricStrip` | The row of `MetricTile`s across the top of a page, as many to a row as fit; `minTile` says how narrow a tile may get (`9.5rem` for short figures, `14rem` for tiles with a button). A region named by `label`. |
| `AppIcon` | An app's colour square: its emoji, or its initials, in white on the app's own hue (`appHue`). `sm` 22 px in a table row, `md` 34 px in a list, `lg` 52 px at a sheet's head. Decorative: say the app's name beside it. |
| `CopyButton` | Copy one value from a row (a client id, a path) with `label` and `name` for assistive technology; says Copied only once the current value is on the clipboard, and says so when the clipboard refuses. For a block of text, `CodeBlock` has its own Copy. |
| `Notice` | Something the page must say: `info`, `success`, `warning`, `danger`, with an action and an optional dismiss. `live` announces it (use it for what a click caused). |
| `EmptyState` | What an empty panel or table says, and the one action that fills it. |
| `Toolbar`, `SearchField` | The row over a table: a search (Escape clears it), filters, actions; wraps on a phone. |
| `Sheet` | A drawer (`side="right"`) or dialog (`side="center"`) over the page: modal, focus held, Escape closes, focus returns. Render it only while open. |
| `CodeBlock` | Text shown exactly in mono, named, with Copy; `follow` keeps the newest line in view. |
| `Progress` | A progress bar; indeterminate without a value. |
| `JobProgress` | One job inline, by id: its state in Activity's words, a moving bar, the newest line, the output behind a toggle. Reads the job log's own stream. It never approves or cancels: the approval dialog and Activity do. |
| `Tag` | A small mono label: `reach` (LAN, tailnet, local, public, said in words), `tier` (LOW/MED/HIGH), or a tone. |
| `Table` | Rows at the density's height, a status mark per row, an empty state, a phone layout that stacks, and `sortValue` on a column to make it sortable (with `aria-sort`). |
| `Button`, `RiskTag`, `StatusChip`, `MetricTile`, `Section`, `Card`, `Tile`, `Dock`, `ThemeSwitch`, `Sparkline` | From M33.1-M33.7. A `Button` is always in the UI's face (`--font-sans`), even inside a mono table cell or facts line (M33.14). |

All of them are in the gallery (`/?gallery` on the demo), in both themes, in the CI screenshots.

## Your page's CSS

- Page styles go in **`src/pages/<area>/<area>.css`**, imported by the page
  (`import "./<area>.css";`). The page itself lives beside it (`src/pages/<area>/<Area>Page.tsx`)
  with its test.
- **Every selector starts with `.<area>-`** (`.services-toolbar`, `.logs-output .ui-code`), so no
  page can restyle another. Reaching into a kit component from your own class is fine.
- **Colours from tokens only**: no hex, `rgb()`, `hsl()` or named colours. Use the semantic tokens
  (`--text`, `--text-muted`, `--surface`, `--border`, `--status-*`, `--risk-*`, `--accent`) before
  the `--cc-*` ones.
- `src/pages/pageCss.test.ts` enforces all three.
- **`src/styles.css` holds only what is used** (M33.14): the tokens, the base (reset, focus ring,
  a bare link in `--link`), the shell's bar, dock and command bar, Home and Ops, and the kit. The
  Classic pages' classes and the console's stopgap for them are gone; there is no `.panel`,
  `.primary-button` or `.modal` to reach for. If two pages need the same thing, it is a kit
  component: add it to `src/ui/` with a test and a place in the gallery.
- **Fix a kit bug in the kit.** A page that works around one (a sheet that grows, a tab that
  escapes its list) patches every page but its own; M33.14 moved three such patches into `src/ui`.

## Density and size

- Rows 28-30 px, controls 30 px (26 px inside a table row), 4 px corners on panels, 3 px on
  controls.
- Type: IBM Plex Sans Condensed at 13-14.5 px for words; JetBrains Mono at 12-12.5 px for every
  figure, id, path and unit name; panel titles and table headings in mono small capitals (10.5-11
  px, letter-spaced).
- Amber is what to act on; cyan is what is measured; green, amber and red are states and are always
  said in words too (a chip's label, a mark's shape).
- No horizontal scroll at 375 px: give a table's less important columns `hideOnPhone`, let
  toolbars wrap, and check the phone screenshots.

## Checklist before the pull request

- `npm test`: the page's tests, `pageCss.test.ts`, and `scripts/check-contrast.mjs` (which checks the
  main pairs under the console's tokens too).
- Keyboard: every action reachable with Tab, sheets hold focus, Escape closes them.
- Screenshots (`gh workflow run ui-screenshots.yml --ref <branch> -f viewport=375x812`): the page in
  dark and light, desktop and phone. Nothing from the old frame: no eyebrow over a big title, no
  paragraph before the facts, no "What you can do".
