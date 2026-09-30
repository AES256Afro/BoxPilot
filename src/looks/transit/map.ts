/*
 * The transit map's geometry (M41, docs/design-directions/05-looks.html, M.transit), computed from
 * the facts rather than drawn by hand: in the drawing's own 520 x 380 box, the tailnet's blue line
 * across the top dipping to the interchange, your network's green line through it, the backups'
 * orange line from its foot to the off-box copy and a dashed grey branch for what has no recent
 * backup. Stations are spread evenly along each segment, and their names are placed above or below
 * the line, on a first or a second row, so that no two ever overlap. Pure, so it is tested alone.
 */

export type LineId = "tailnet" | "network" | "backups" | "unprotected";

export const LINE_COLOURS: Record<LineId, string> = { tailnet: "#1f4fd1", network: "#00843d", backups: "#f08a00", unprotected: "#9b9b9b" };

export interface StopInput { id: string; name: string }

export interface PlacedStop extends StopInput {
  line: LineId;
  x: number;
  y: number;
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

export interface Terminus { line: LineId; x: number; y: number; name: string; label: { x: number; y: number; anchor: "start" | "middle" | "end" } }

export interface TransitMap {
  paths: Array<{ line: LineId; d: string; dashed: boolean }>;
  stops: PlacedStop[];
  termini: Terminus[];
  interchange: { x: number; y: number; width: number; height: number };
}

/** The interchange: a tall capsule where the lines meet. */
const HUB = { x: 236, y: 98, width: 28, height: 182 };
const Y = { tailnet: 70, network: 190, backups: 302 };

/** Roughly how wide a name is at the map's 10.5 px in Overpass 600. */
export const labelWidth = (text: string) => text.length * 6.1 + 4;

interface Box { x1: number; x2: number; y: number }

/**
 * Stations evenly spaced along [from, to] on one line, each name at the first of `rows` (label
 * baselines) where it overlaps nothing already placed. When every row is taken the name goes on
 * the row with the most room.
 */
function place(line: LineId, stops: StopInput[], from: number, to: number, y: number, rows: number[], taken: Box[], edge: { min: number; max: number }): PlacedStop[] {
  const placed: PlacedStop[] = [];
  stops.forEach((stop, index) => {
    const x = Math.round(from + ((to - from) * (index + 1)) / (stops.length + 1));
    const width = labelWidth(stop.name);
    // A name near the map's edge is set flush to it rather than running off it.
    const box = (row: number) => {
      let x1 = x - width / 2;
      let x2 = x + width / 2;
      if (x1 < edge.min) { x2 += edge.min - x1; x1 = edge.min; }
      if (x2 > edge.max) { x1 -= x2 - edge.max; x2 = edge.max; }
      return { x1, x2, y: row };
    };
    const clash = (candidate: Box) => taken.some((other) => other.y === candidate.y && candidate.x1 < other.x2 + 6 && other.x1 < candidate.x2 + 6);
    // Alternate the first choice between above and below, as the drawing does.
    const order = index % 2 === 0 ? rows : [...rows.slice(1, 2), rows[0], ...rows.slice(2)];
    let chosen = order.find((row) => !clash(box(row)));
    if (chosen === undefined) {
      const room = (row: number) => Math.min(...taken.filter((other) => other.y === row).map((other) => Math.abs((other.x1 + other.x2) / 2 - x)), 1e6);
      chosen = [...order].sort((a, b) => room(b) - room(a))[0];
    }
    const at = box(chosen);
    taken.push(at);
    placed.push({ ...stop, line, x, y, label: { x: (at.x1 + at.x2) / 2, y: chosen, anchor: "middle" } });
  });
  return placed;
}

export function transitMap({ tailnet, network, backups, unprotected, offBoxName = "Off-box copy" }: { tailnet: StopInput[]; network: StopInput[]; backups: StopInput[]; unprotected: StopInput[]; offBoxName?: string }): TransitMap {
  const taken: Box[] = [];
  const edge = { min: 4, max: 516 };
  // Names either side of the interchange keep clear of it.
  const left = { min: 4, max: HUB.x - 4 };
  const right = { min: HUB.x + HUB.width + 4, max: 516 };
  const termini: Terminus[] = [
    { line: "tailnet", x: 40, y: Y.tailnet, name: "Your phone", label: { x: 34, y: 56, anchor: "start" } },
    { line: "tailnet", x: 500, y: Y.tailnet, name: "Anywhere", label: { x: 506, y: 56, anchor: "end" } },
    { line: "backups", x: 500, y: Y.backups, name: offBoxName, label: { x: 506, y: 338, anchor: "end" } },
  ];
  // The termini's names are taken first, so no station's name lands on them.
  taken.push({ x1: 34, x2: 34 + labelWidth("Your phone"), y: 56 }, { x1: 506 - labelWidth("Anywhere"), x2: 506, y: 56 }, { x1: 506 - labelWidth(offBoxName), x2: 506, y: 338 });

  // The tailnet: the right-hand run first, then the left, around the dip to the interchange.
  const tailRight = tailnet.slice(0, Math.ceil(tailnet.length / 2));
  const tailLeft = tailnet.slice(Math.ceil(tailnet.length / 2));
  const stops = [
    ...place("tailnet", tailLeft, 40, 190, Y.tailnet, [56, 92, 42], taken, { min: edge.min, max: 200 }),
    ...place("tailnet", tailRight, 310, 500, Y.tailnet, [56, 92, 42], taken, { min: 300, max: edge.max }),
  ];
  // Your network: through the interchange, the stations shared either side of it.
  const netLeft = network.slice(0, Math.floor(network.length * (206 / (206 + 236))));
  const netRight = network.slice(netLeft.length);
  stops.push(
    ...place("network", netLeft, 30, HUB.x, Y.network, [176, 214, 162, 228], taken, left),
    ...place("network", netRight, HUB.x + HUB.width, 500, Y.network, [176, 214, 162, 228], taken, right),
  );
  // Backups to the right of the interchange's foot, what has none on the dashed branch to the left.
  stops.push(
    ...place("backups", backups, 290, 500, Y.backups, [322, 338, 288], taken, { min: 298, max: edge.max }),
    ...place("unprotected", unprotected, 30, 210, Y.backups, [322, 338, 288], taken, { min: edge.min, max: 202 }),
  );

  return {
    paths: [
      { line: "tailnet", d: "M40 70 H190 L230 110 H270 L310 70 H500", dashed: false },
      { line: "network", d: "M30 190 H500", dashed: false },
      { line: "backups", d: "M250 262 L290 302 H500", dashed: false },
      { line: "unprotected", d: "M250 262 L210 302 H30", dashed: true },
    ],
    stops,
    termini,
    interchange: HUB,
  };
}
