/**
 * BoxPilot's design system (M33.1, ADR-004): typed components over the tokens in src/styles.css.
 * Every size comes from the density tokens (data-density="comfortable" | "compact" on a
 * container) and every colour from the theme tokens, so each component works in light and dark
 * and at both densities. The demo shows them all at /?gallery.
 */
export { Button, RiskTag, riskCopy, type ButtonProps, type ButtonVariant } from "./Button";
export { Card, type CardProps } from "./Card";
export { Dock, type DockItem, type DockProps } from "./Dock";
export { MetricTile, type MetricTileProps } from "./MetricTile";
export { Section, type SectionProps } from "./Section";
export { StatusChip, type StatusChipProps } from "./StatusChip";
export { ThemeSwitch } from "./ThemeSwitch";
export { Tile, initials, type TileProps } from "./Tile";
export { operationRisk, riskOf } from "./operationRisk";
export { STATUSES, statusWords, type Density, type RiskTier, type Status } from "./types";
