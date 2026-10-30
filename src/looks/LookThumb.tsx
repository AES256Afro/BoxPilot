import type { CSSProperties } from "react";
import type { LookId } from "./looks";

/*
 * A small picture of each look for its card in Settings → Appearance (M41), drawn from rectangles
 * as the study's cards were (docs/design-directions/05-looks.html). The colours are the looks' own,
 * written out rather than read from tokens: the page around the card is drawn in whichever look is
 * chosen, and every card has to show its own. The looks with light and dark show the one in use.
 */

type Rect = [x: number, y: number, w: number, h: number, background: string, extra?: CSSProperties];

const wall = (dark: boolean) => dark
  ? "radial-gradient(70% 90% at 10% 0%, rgba(30,110,108,.7), transparent 65%), radial-gradient(60% 80% at 100% 0%, rgba(210,108,44,.46), transparent 62%), linear-gradient(160deg, #193240, #161e2c)"
  : "radial-gradient(70% 90% at 10% 0%, rgba(150,200,222,.8), transparent 65%), radial-gradient(60% 80% at 100% 0%, rgba(250,190,150,.75), transparent 62%), linear-gradient(160deg, #e4eef5, #f6ece2)";

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

function picture(look: LookId, dark: boolean): { background: string; rects: Rect[]; numeral?: boolean } {
  const glass = dark ? "rgba(255,255,255,.15)" : "rgba(255,255,255,.72)";
  const ink = dark ? "#ffffff" : "#13212c";
  const cc = dark
    ? { canvas: "#0a0d10", rail: "#07090b", panel: "#10151a", line: "#1c232b", amber: "#ffb547", cyan: "#56c8e0" }
    : { canvas: "#f3f2ee", rail: "#ebe9e3", panel: "#ffffff", line: "#dedbd2", amber: "#935700", cyan: "#0b7489" };
  switch (look) {
    case "blend": return { background: wall(dark), rects: [
      [4, 8, 20, 84, glass, { borderRadius: "12%" }], [28, 8, 68, 13, glass, { borderRadius: "18%" }],
      [28, 26, 36, 66, glass, { borderRadius: "10%" }], [67, 26, 29, 66, glass, { borderRadius: "10%" }],
      ...range(4).map((i): Rect => [32 + i * 7.5, 32, 5.5, 9, ["#7b5cd6", "#1c8ad0", "#d93a44", "#2e8b57"][i], { borderRadius: "25%" }]),
      [40, 13, 18, 3, cc.cyan],
    ] };
    case "launcher": return { background: wall(dark), rects: [
      [4, 10, 26, 36, glass, { borderRadius: "10%" }], [4, 50, 26, 34, glass, { borderRadius: "10%" }], [36, 8, 28, 6, ink, { opacity: 0.7 }],
      ...range(6).map((i): Rect => [36 + (i % 3) * 13, 22 + Math.floor(i / 3) * 24, 9, 15, ["#4b5b73", "#5360d8", "#7b5cd6", "#1c8ad0", "#13917f", "#d93a44"][i], { borderRadius: "25%" }]),
      [22, 87, 56, 9, glass, { borderRadius: "30%" }],
    ] };
    case "console": return { background: cc.canvas, rects: [
      [0, 0, 8, 100, cc.rail], [1.5, 4, 5, 8, cc.amber],
      ...range(5).map((i): Rect => [11 + i * 17.6, 9, 16, 16, cc.panel, { outline: `1px solid ${cc.line}` }]),
      [11, 30, 50, 64, cc.panel, { outline: `1px solid ${cc.line}` }], [63, 30, 33, 64, cc.panel, { outline: `1px solid ${cc.line}` }],
      [66, 38, 7, 6, cc.amber], [66, 54, 7, 6, cc.amber], [14, 20, 10, 2, cc.cyan],
    ] };
    case "aqua": return { background: "radial-gradient(120% 95% at 28% 18%, #7cb8ff, #2f70d6 45%, #0a3584)", rects: [
      [10, 10, 80, 66, "repeating-linear-gradient(0deg,#f5f5f5 0 1px,#e6e6e6 1px 2px)", { borderRadius: "6% 6% 3% 3%" }],
      [10, 10, 80, 11, "linear-gradient(#ececec,#c6c6c6)", { borderRadius: "6% 6% 0 0" }],
      [13, 13, 4, 6, "#e0443a", { borderRadius: "50%" }], [18.5, 13, 4, 6, "#e3a90d", { borderRadius: "50%" }], [24, 13, 4, 6, "#3fae2c", { borderRadius: "50%" }],
      [10, 21, 18, 55, "#e6ecf5"], [32, 30, 22, 5, "linear-gradient(#d6e9ff,#3d88ea 50%,#9ed0ff)", { borderRadius: "9px" }],
      [22, 83, 56, 11, "rgba(255,255,255,.4)", { borderRadius: "12% 12% 0 0" }],
    ] };
    case "blueprint": return { background: "#1f4f98 linear-gradient(rgba(255,255,255,.12) 1px, transparent 1px) 0 0/10% 16%", rects: [
      [5, 7, 90, 86, "none", { outline: "1px solid #f2f6ff" }], [10, 16, 52, 50, "none", { outline: "1px solid #f2f6ff" }],
      ...range(4).map((i): Rect => [13 + i * 12, 24, 10, 12, "none", { outline: "1px solid rgba(242,246,255,.8)" }]),
      [66, 72, 26, 17, "none", { outline: "1px solid #f2f6ff" }], [10, 76, 40, 4, "repeating-linear-gradient(45deg,#f2f6ff 0 1px,transparent 1px 3px)"],
    ] };
    case "phosphor": return { background: "radial-gradient(#07301a, #000 90%)", rects:
      range(8).map((i): Rect => [8, 10 + i * 10, [30, 60, 45, 70, 25, 55, 40, 20][i], 3.5, "#62ff96", { boxShadow: "0 0 4px #62ff96", opacity: i % 3 ? 0.7 : 1 }]) };
    case "rack": return { background: "#161718", rects: [
      ...[[6, 24], [34, 34], [72, 20]].map(([y, h]): Rect => [5, y, 90, h, "repeating-linear-gradient(90deg,#cdd0d4 0 1px,#bfc3c8 1px 2px)", { borderRadius: "3px" }]),
      ...range(5).map((i): Rect => [14 + i * 15, 42, 11, 18, "#222326"]),
      ...range(3).map((i): Rect => [58 + i * 11, 12, 9, 10, "#140404", { boxShadow: "inset 0 0 0 1px #000" }]),
      [40, 12, 12, 10, "#ffb20f", { boxShadow: "0 0 6px #ffb20f" }],
    ] };
    case "swiss": return { background: "#ffffff", numeral: true, rects: [
      [6, 6, 88, 1.5, "#111111"], [46, 18, 44, 7, "#111111"], [46, 28, 30, 7, "#111111"],
      ...range(3).map((i): Rect => [46, 44 + i * 12, 48, 0.8, "#111111"]), [80, 46, 14, 5, "#111111"],
    ] };
    case "toybox": return { background: "#dcefff", rects: [
      [6, 10, 20, 28, "#a9d0ff", { border: "2px solid #2b2340", borderRadius: "25%" }], [30, 10, 64, 28, "#ffffff", { border: "2px solid #2b2340", borderRadius: "14px" }],
      [6, 46, 42, 46, "#ffffff", { border: "2px solid #2b2340", borderRadius: "14px" }], [52, 46, 42, 46, "#ffffff", { border: "2px solid #2b2340", borderRadius: "14px" }],
      ...range(3).map((i): Rect => [56 + i * 12, 54, 9, 14, ["#ffc9dc", "#cbd8ff", "#b8f0d2"][i], { border: "2px solid #2b2340", borderRadius: "50%" }]),
      [10, 76, 18, 8, "#ffd84d", { border: "2px solid #2b2340", borderRadius: "20px" }],
    ] };
    case "cockpit": return { background: "linear-gradient(#34363a,#1c1e21)", rects: [
      [5, 5, 22, 12, "#ffbf1f"], [5, 22, 90, 60, "#04070a", { borderRadius: "6px" }],
      ...range(4).map((i): Rect => [10 + (i % 2) * 22, 28 + Math.floor(i / 2) * 26, 18, 24, "none", { border: "2px solid #39e27d", borderBottomColor: "transparent", borderRadius: "50%" }]),
      [58, 30, 30, 3, "#ffbf1f"], [58, 40, 24, 3, "#3fd7f2"], [58, 50, 28, 3, "#39e27d"],
      ...range(5).map((i): Rect => [5 + i * 18.4, 86, 15, 9, "#3b3e43", { borderRadius: "3px" }]),
    ] };
    case "eink": return { background: "#e6e6e1", rects: [
      [8, 8, 84, 1, "#151515"], [8, 16, 46, 10, "#151515"], [8, 30, 70, 3.5, "#555552"],
      ...range(3).map((i): Rect => [8, 44 + i * 13, 36, 3, "#151515"]),
      ...range(3).map((i): Rect => [56, 44 + i * 13, 36, 5, "repeating-conic-gradient(#151515 0 25%, transparent 0 50%) 0 0/3px 3px", { outline: "1px solid #151515" }]),
    ] };
    case "quest": return { background: "#1d1838", rects: [
      [5, 6, 52, 70, "#2c2554", { outline: "2px solid #f3e6c4" }], [62, 6, 33, 40, "#2c2554", { outline: "2px solid #f3e6c4" }],
      [62, 52, 33, 24, "#2c2554", { outline: "2px solid #f3e6c4" }], [5, 82, 90, 13, "#2c2554", { outline: "2px solid #f3e6c4" }],
      ...range(4).flatMap((i): Rect[] => [[9, 14 + i * 14, 6, 9, ["#7b5cd6", "#5360d8", "#d93a44", "#2e8b57"][i]], [38, 16 + i * 14, 15, 4, i === 1 ? "#ffcc4d" : "#5ee27d"]]),
    ] };
    case "transit": return { background: "#f7f7f3", rects: [
      [70, 0, 30, 100, "#13233f"], [5, 26, 60, 3.5, "#1f4fd1"], [5, 48, 62, 3.5, "#00843d"], [36, 70, 30, 3.5, "#f08a00"],
      [5, 70, 30, 3.5, "repeating-linear-gradient(90deg,#9b9b9b 0 5px,transparent 5px 8px)"],
      [33, 18, 5, 58, "#ffffff", { border: "2px solid #1d1d1f", borderRadius: "8px" }],
      ...range(4).map((i): Rect => [74, 10 + i * 20, 22, 3, "#ffffff", { opacity: 0.8 }]),
    ] };
  }
}

export function LookThumb({ look, dark, className }: { look: LookId; dark: boolean; className?: string }) {
  const { background, rects, numeral } = picture(look, dark);
  return (
    <span className={className} style={{ background }} aria-hidden="true">
      {numeral && <i style={{ left: "6%", top: "4%", color: "#e3061b", font: "900 3.4em/1 Archivo, 'Arial Black', sans-serif", letterSpacing: "-0.06em", fontStyle: "normal" }}>2</i>}
      {rects.map(([x, y, w, h, fill, extra], index) => (
        <i key={index} style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, background: fill, ...extra }} />
      ))}
    </span>
  );
}
