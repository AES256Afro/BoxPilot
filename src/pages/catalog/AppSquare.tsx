import { appHue, initials } from "../../ui";

/**
 * An app's colour square with its glyph, as Home draws its apps (M33.7): the manifest's emoji, or
 * the name's initials, on the app's own hue. Decorative: the app's name is always said beside it.
 */
export function AppSquare({ id, name, icon, size = "md" }: { id: string; name: string; icon: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`catalog-square catalog-square--${size}`} data-hue={appHue(id)} data-emoji={icon ? true : undefined} aria-hidden="true">
      {icon ?? initials(name)}
    </span>
  );
}
