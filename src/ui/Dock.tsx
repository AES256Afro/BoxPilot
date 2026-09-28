import { Fragment, type ReactNode } from "react";
import { cx } from "./types";

export interface DockItem {
  id: string;
  /** The area's name, read out in full. */
  label: string;
  /** The word shown under the icon, when the full name is too long for it ("VMs"). */
  short?: string;
  /** What is drawn: an icon, or the area's two-letter mark from the navigation. */
  icon: ReactNode;
  /** A count waiting in that area (14 updates). */
  badge?: number | string;
  /** Read after the count: "14 waiting". */
  badgeLabel?: string;
  current?: boolean;
  /** Starts a new group: a thin rule is drawn before it. */
  separatorBefore?: boolean;
  /**
   * How much room the item needs to be shown, for a page whose dock cannot fit everything: 1 always,
   * 2 not on a phone, 3 only on a wide screen, "overflow" only when something else is hidden (the
   * button that shows the rest). The page's stylesheet decides the widths; without it all show.
   */
  priority?: 1 | 2 | 3 | "overflow";
}

export interface DockProps {
  items: DockItem[];
  onSelect: (id: string) => void;
  /** The navigation's name for assistive technology. */
  label?: string;
  className?: string;
}

/**
 * The admin areas as a row of buttons, as on the Launcher's home screen, each with its name under
 * its icon so none has to be guessed. Each button is read by its full name and its count.
 */
export function Dock({ items, onSelect, label = "Admin areas", className }: DockProps) {
  return (
    <nav className={cx("ui-dock", className)} aria-label={label}>
      <ul>
        {items.map((item) => {
          const counted = item.badge !== undefined && item.badge !== "";
          const name = counted ? `${item.label}, ${item.badge} ${item.badgeLabel ?? "waiting"}` : item.label;
          const priority = item.priority === undefined ? undefined : String(item.priority);
          return (
            <Fragment key={item.id}>
              {item.separatorBefore && <li className="ui-dock__separator" data-priority={priority} aria-hidden="true" />}
              <li data-priority={priority}>
                <button type="button" className="ui-dock__item" aria-current={item.current ? "page" : undefined} onClick={() => onSelect(item.id)}>
                  <span className="ui-dock__icon" aria-hidden="true">
                    {item.icon}
                    {counted && <span className="ui-dock__badge">{item.badge}</span>}
                  </span>
                  <span className="ui-dock__label" aria-hidden="true">{item.short ?? item.label}</span>
                  <span className="ui-visually-hidden">{name}</span>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
