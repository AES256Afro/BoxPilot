import { useId, type ReactNode } from "react";
import { cx, statusWords, type Status } from "./types";

export interface TileProps {
  /** The app's name, shown under its icon. */
  name: string;
  /** The app's health, drawn as a mark on the icon. */
  status: Status;
  /** Read out with the name; defaults to the plain words for the status ("Needs a look"). */
  statusLabel?: string;
  /** One short fact under the name: "2 streaming", "Not off-box". */
  detail?: ReactNode;
  /** The app's icon (an img or svg). Without one, the tile shows the name's initials. */
  icon?: ReactNode;
  /** A colour square behind the icon, named from src/ui/appColor.ts: Home's app squares (M33.7). */
  hue?: string;
  /** Opens the app; the tile is then a link. */
  href?: string;
  /** Opens something about the app (a sheet, its page); the tile is then a button. */
  onSelect?: () => void;
  className?: string;
}

/** Initials for an app without an icon: "Home Assistant" -> "HA", "Jellyfin" -> "J". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0].slice(0, 1) + words[1].slice(0, 1)).toUpperCase();
}

/**
 * An app on a home screen: its icon with a health mark, its name, one fact. A tile that opens
 * something is named "Immich, Needs a look" and described by its fact, so the name stays short
 * and never depends on how inline pieces are spaced.
 */
export function Tile({ name, status, statusLabel, detail, icon, hue, href, onSelect, className }: TileProps) {
  const detailId = useId();
  const interactive = Boolean(href || onSelect);
  const hasDetail = detail !== undefined && detail !== null && detail !== "";
  const body = (
    <>
      <span className="ui-tile__icon" data-hue={hue} aria-hidden="true">
        {icon ?? <span className="ui-tile__initials">{initials(name)}</span>}
        <span className="ui-mark ui-tile__mark" />
      </span>
      <span className="ui-tile__name">{name}</span>
      <span className="ui-visually-hidden">{`, ${statusLabel ?? statusWords[status]}`}</span>
      {hasDetail && <span className="ui-tile__detail" id={detailId} aria-hidden={interactive || undefined}>{detail}</span>}
    </>
  );
  const classes = cx("ui-tile", className);
  const describedBy = hasDetail ? detailId : undefined;
  if (href) return <a className={classes} data-status={status} href={href} target="_blank" rel="noreferrer" aria-describedby={describedBy}>{body}</a>;
  if (onSelect) return <button className={classes} data-status={status} type="button" onClick={onSelect} aria-describedby={describedBy}>{body}</button>;
  return <div className={classes} data-status={status}>{body}</div>;
}
