/**
 * BoxPilot's design system (M33.1, ADR-004): typed components over the tokens in src/styles.css.
 * Every size comes from the density tokens (data-density="comfortable" | "compact" on a
 * container) and every colour from the theme tokens, so each component works in light and dark
 * and at both densities. The demo shows them all at /?gallery.
 *
 * M33.8 adds the console's page kit: PageHeader, Panel, the form controls (Field, TextInput,
 * Textarea, Select, Switch, Checkbox, Segmented, SecretInput), Tabs, KeyValue, Notice, EmptyState,
 * Toolbar, Sheet, CodeBlock, Progress, JobProgress and Tag. docs/UI-PAGES.md says how a page is
 * built from them.
 */
export { Button, RiskTag, riskCopy, type ButtonProps, type ButtonVariant } from "./Button";
export { Card, type CardProps } from "./Card";
export { CodeBlock, type CodeBlockProps } from "./CodeBlock";
export { Dock, type DockItem, type DockProps } from "./Dock";
export { Field, useFieldControl, type FieldProps } from "./Field";
export { JobProgress, type JobProgressProps } from "./JobProgress";
export { KeyValue, type KeyValueItem, type KeyValueProps } from "./KeyValue";
export { MetricTile, type MetricTileProps } from "./MetricTile";
export { EmptyState, Notice, type EmptyStateProps, type NoticeProps, type NoticeTone } from "./Notice";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { Panel, type PanelProps } from "./Panel";
export { Progress, type ProgressProps } from "./Progress";
export { Section, type SectionProps } from "./Section";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./Segmented";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { Sheet, type SheetProps } from "./Sheet";
export { Sparkline, sparkPoints, type SparklineProps } from "./Sparkline";
export { StatusChip, type StatusChipProps } from "./StatusChip";
export { Checkbox, Switch, type CheckboxProps, type SwitchProps } from "./Switch";
export { APP_HUES, appHue, type AppHue } from "./appColor";
export { Table, type SortDirection, type TableColumn, type TableProps } from "./Table";
export { Tabs, useUrlParam, type TabItem, type TabsProps } from "./Tabs";
export { Tag, type Reach, type TagProps, type TagTone } from "./Tag";
export { SecretInput, TextInput, Textarea, type SecretInputProps, type TextInputProps, type TextareaProps } from "./TextInput";
export { ThemeSwitch } from "./ThemeSwitch";
export { Tile, initials, type TileProps } from "./Tile";
export { SearchField, Toolbar, type SearchFieldProps, type ToolbarProps } from "./Toolbar";
export { mayStart, operationRisk, ownerOnlyOperations, riskOf } from "./operationRisk";
export { STATUSES, statusWords, type Density, type RiskTier, type Status } from "./types";
