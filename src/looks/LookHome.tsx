import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { HomeProps } from "../home/Home";
import type { LookId } from "./looks";

/*
 * Home in each look (M41). The Launcher is today's Home; every other look has its own, drawn to
 * match docs/design-directions/05-looks.html and reading the same facts (src/home/facts.tsx) and
 * the same list of what needs you (src/home/needs.ts), with every fix going through the approval
 * dialog at its tier. Each is its own chunk, fetched only by a browser that chose that look.
 */
const homes: Record<LookId, LazyExoticComponent<ComponentType<HomeProps>>> = {
  launcher: lazy(() => import("../home/Home")),
  blend: lazy(() => import("./blend/Home")),
  console: lazy(() => import("./console/Home")),
  aqua: lazy(() => import("./aqua/Home")),
  blueprint: lazy(() => import("./blueprint/Home")),
  phosphor: lazy(() => import("./phosphor/Home")),
  rack: lazy(() => import("./rack/Home")),
  swiss: lazy(() => import("./swiss/Home")),
  toybox: lazy(() => import("./toybox/Home")),
  cockpit: lazy(() => import("./cockpit/Home")),
  eink: lazy(() => import("./eink/Home")),
  quest: lazy(() => import("./quest/Home")),
  transit: lazy(() => import("./transit/Home")),
};

export function LookHome({ look, ...props }: HomeProps & { look: LookId }) {
  const Home = homes[look];
  return <Home {...props} />;
}
