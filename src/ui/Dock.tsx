import { Fragment, type ReactNode } from "react";
import { cx } from "./types";

export interface DockItem {
  id: string;
  /** The area's name, read out, and shown above the icon on hover and on keyboard focus. */
  label: string;
  /** What is drawn: an icon, or the area's two-letter mark from the navigation. */
  icon: ReactNode;
  /** A count waiting in that area (14 updates). */
  badge?: number | string;
  /** Read after the count: "14 waiting". */
  badgeLabel?: string;
  current?: boolean;
  /** Starts a new group: a thin rule is drawn before it. */
  separatorBefore?: boolean;
}

export interface DockProps {
  items: DockItem[];
  onSelect: (id: string) => void;
  /** The navigation's name for assistive technology. */
  label?: string;
  className?: string;
}

/**
 * The admin areas as a row of buttons, as on the Launcher's home screen. Each button is named by
 * its area (and its count); the name also appears above the icon on hover and on keyboard focus,
 * so an icon never has to be guessed.
 */
export function Dock({ items, onSelect, label = "Admin areas", className }: DockProps) {
  return (
    <nav className={cx("ui-dock", className)} aria-label={label}>
      <ul>
        {items.map((item) => {
          const counted = item.badge !== undefined && item.badge !== "";
          const name = counted ? `${item.label}, ${item.badge} ${item.badgeLabel ?? "waiting"}` : item.label;
          return (
            <Fragment key={item.id}>
              {item.separatorBefore && <li className="ui-dock__separator" aria-hidden="true" />}
              <li>
                <button type="button" className="ui-dock__item" aria-current={item.current ? "page" : undefined} onClick={() => onSelect(item.id)}>
                  <span className="ui-dock__icon" aria-hidden="true">{item.icon}</span>
                  <span className="ui-visually-hidden">{name}</span>
                  <span className="ui-dock__tip" aria-hidden="true">{counted ? `${item.label} · ${item.badge} ${item.badgeLabel ?? "waiting"}` : item.label}</span>
                  {counted && <span className="ui-dock__badge" aria-hidden="true">{item.badge}</span>}
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
