import type { ReactNode, SVGProps } from "react";
import type { ViewName } from "../data";

/*
 * One line icon per page, for the dock and the command bar (M33.2). The shapes are the ones the
 * design study drew for its dock (docs/design-directions/04-eight-directions.html), on a 24-unit
 * grid, stroked in the text colour. They are decoration: every place that shows one also shows the
 * page's name and reads it to assistive technology.
 */

function Svg({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

const shapes: Record<ViewName, ReactNode> = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  // Today (M25.3): the sun over the horizon, the morning glance.
  today: <><path d="M3 19h18M7 19a5 5 0 0 1 10 0" /><path d="M12 5.5v2.5M5.3 10.3l1.8 1.8M18.7 10.3l-1.8 1.8M2.5 15h2M19.5 15h2" /></>,
  ops: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  updates: <><path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" /><path d="M4 4v4h4M20 20v-4h-4" /></>,
  catalog: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  services: <><path d="M12 3l9 4.5-9 4.5-9-4.5z" /><path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" /></>,
  system: <><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" /></>,
  automations: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  agents: <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M9 12h.01M15 12h.01M9.5 16h5M2 12v3M22 12v3" /></>,
  performance: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  users: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  firewall: <><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 9.3h18M3 14.7h18M9 4v5.3M15 9.3v5.4M9 14.7V20" /></>,
  storage: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  network: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  repairs: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  virtualization: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  backups: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  github: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 7.2v9.6M18 10.2c0 4-6 3.5-11 7" /></>,
  logs: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  // A gear with eight teeth. It was a circle with eight rays, the same sun the bar uses for light,
  // so in the icon-only rail it read as a light switch and System's chip read as the settings.
  settings: <><path d="M10.1 5.3L10.5 2.6L13.5 2.6L13.9 5.3L15.4 5.9L17.6 4.3L19.7 6.4L18.1 8.6L18.7 10.1L21.4 10.5L21.4 13.5L18.7 13.9L18.1 15.4L19.7 17.6L17.6 19.7L15.4 18.1L13.9 18.7L13.5 21.4L10.5 21.4L10.1 18.7L8.6 18.1L6.4 19.7L4.3 17.6L5.9 15.4L5.3 13.9L2.6 13.5L2.6 10.5L5.3 10.1L5.9 8.6L4.3 6.4L6.4 4.3L8.6 5.9Z" /><circle cx="12" cy="12" r="3" /></>,
  setup: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" /></>,
};

export function AreaIcon({ view, ...props }: { view: ViewName } & Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}>{shapes[view]}</Svg>;
}

export function SearchIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Svg>;
}

/** What needs you, on Home's panel as in the study (M33.7). */
export function BellIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></Svg>;
}

export function PlusIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><path d="M12 5v14M5 12h14" /></Svg>;
}

export function SparkIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}>{shapes.setup}</Svg>;
}

/** The dock's More: every area, when the screen is too narrow for all of them. */
export function MoreIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Svg>;
}

/** Something the command bar does rather than opens (M36). */
export function RunIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><path d="M8 5.5v13l10-6.5z" /></Svg>;
}

/** The bar's Refresh (M25): read this page again. */
export function RefreshIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>;
}

export function ExternalIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <Svg {...props}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>;
}
