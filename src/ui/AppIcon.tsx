import { appHue } from "./appColor";
import { initials } from "./Tile";
import { cx } from "./types";

export interface AppIconProps {
  /** The app's id: it picks the app's hue, the same on every page and every visit. */
  id: string;
  /** The app's name, whose initials are drawn when it has no emoji. */
  name: string;
  /** The manifest's emoji, when it has one. */
  icon?: string | null;
  /** sm 22 px for a table row, md 34 px for a list, lg 52 px for a sheet's head. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * An app's colour square (M33.7, promoted to the kit in M33.14): the manifest's emoji, or the
 * name's initials, in white on the app's own hue, as Home draws its apps. Decorative, so hidden
 * from assistive technology: the app's name is always said beside it.
 */
export function AppIcon({ id, name, icon, size = "md", className }: AppIconProps) {
  return (
    <span className={cx("ui-app-icon", `ui-app-icon--${size}`, className)} data-hue={appHue(id)} data-emoji={icon ? true : undefined} aria-hidden="true">
      {icon || initials(name)}
    </span>
  );
}
