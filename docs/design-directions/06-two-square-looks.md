# Two square looks: Field Manual and Workbook

Drawn on 2026-11-10 with the four mockups of that day's sweep. The owner's note on the first pass
was to drop the rounded buttons and the frosted glass, which every other tool has now; these two
are what came back. Both are in Settings → Appearance (`src/looks/manual/`, `src/looks/workbook/`),
each with a skin for every page and a Home of its own, like the thirteen before them (ADR-010).

The four boards are kept beside this file as they were drawn, one file each
(`06-two-square-looks/*.dc.html`; they are canvas artboards, so they need the canvas to render):

| Board | Look | What it proposes |
| --- | --- | --- |
| `Main.dc.html` | Workbook | Backups, "What you'd get back": each app's copies as a depth of three, and the one sentence that matters, what happens if the disk dies tonight. |
| `Tonight.dc.html` | Workbook | Automations, "Tonight": the night's jobs as filled cells on a time axis, with last night's real durations and the two that will collide. |
| `Preflight.dc.html` | Field Manual | Installing an app, "Will it fit": memory, disks and port as a preflight check, where it will answer, and a backup from the first night. |
| `Approve.dc.html` | Field Manual | Approving on a phone: the procedure, the reason, what it will not touch, one thumb-sized action, and the ending. |

## Field Manual

The server as an operator's manual. White paper and black ink in B612, which was drawn for cockpit
displays and was already bundled for the Glass Cockpit. Nothing is rounded and nothing casts a
shadow.

- **The three blocks are the three tiers.** Every such manual prints a NOTE in a plain box, a
  CAUTION under black-and-yellow hatching and a WARNING under black-and-red. Low, medium and high
  were already that idea: a medium job's button carries the yellow hatching down its left edge, a
  high one the red, and the approval dialog's tier is printed as its block.
- **Colour is kept for those two.** Everything that is fine is black. A caution is black on yellow
  (and dark amber where it is text on white, so it still reads); a warning is red.
- **A panel is a numbered section,** counted by the stylesheet (`1. APPS' DATA`), and a table is a
  ruled table with its heading row reversed.
- **The bar is the running head,** white capitals on a black band, and the areas are index tabs
  under it, the open one reversed.
- **Home is the manual's first page:** "Condition of homebox", the result stamped beside it, then
  1-1 Faults and corrective action, 1-2 Readings, 1-3 Applications.

## Workbook

The server as a spreadsheet. White cells on a faint grid, PT Sans for words and JetBrains Mono for
figures.

- **A state is a filled cell,** the way conditional formatting fills one: green, yellow or red, each
  with a dark ink of its own hue that passes 4.5:1 on its fill and on white.
- **A table is the grid,** every cell ruled, the heading row filled, and its rows numbered down the
  left by the stylesheet (the heading row is 1).
- **Search is the formula bar** (`fx`), and on Home the bar above the grid says which cell is
  selected and what its value was worked out from: the verdict is a cell, and it shows its working.
- **The areas are sheet tabs** along the bottom, Home and Ops first.
- **Focus is the selection rectangle,** two pixels of blue, and the selected verdict on Home has the
  fill handle at its corner.
- **A notice is a comment** pinned to the sheet: the pale yellow note with a hard offset edge.

## What both leave alone

Neither changes a page's structure, a word of copy or what any control does: a look is a skin and a
Home (`src/looks/looks.ts`), and `src/looks/looksCss.test.ts` holds each skin to its own
`:root[data-look="…"]`. Both are light only. A night variant of the Field Manual (red on black, the
way a manual is read under a red lamp) is drawn nowhere yet and is on the roadmap.
