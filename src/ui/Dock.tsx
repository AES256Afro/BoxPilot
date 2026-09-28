import type { ReactNode } from "react";
import { cx } from "./types";

export interface DockItem {
  id: string;
  /** The area's name, read out and shown on hover. */
  label: string;
  /** What is drawn: an icon, or the area's two-letter mark from the navigation. */
  icon: ReactNode;
  /** A count waiting in that area (14 updates). */
  badge?: number | string;
  /** Read after the count: "14 waiting". */
  badgeLabel?: string;
  current?: boolean;
}

export interface DockProps {
  items: DockItem[];
  onSelect: (id: string) => void;
  /** The navigation's name for assistive technology. */
  label?: string;
  className?: string;
}

/** The admin areas as a row of buttons, as on the Launcher's home screen. */
export function Dock({ items, onSelect, label = "Admin areas", className }: DockProps) {
  return (
    <nav className={cx("ui-dock", className)} aria-label={label}>
      <ul>
        {items.map((item) => {
          const counted = item.badge !== undefined && item.badge !== "";
          const name = counted ? `${item.label}, ${item.badge} ${item.badgeLabel ?? "waiting"}` : item.label;
          return (
            <li key={item.id}>
              <button type="button" className="ui-dock__item" title={name} aria-current={item.current ? "page" : undefined} onClick={() => onSelect(item.id)}>
                <span className="ui-dock__icon" aria-hidden="true">{item.icon}</span>
                <span className="ui-visually-hidden">{name}</span>
                {counted && <span className="ui-dock__badge" aria-hidden="true">{item.badge}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
