import { useTheme, type Appearance } from "../useTheme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import { handleRadioKeys } from "./radio";
import { cx } from "./types";

const icons = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } satisfies Record<Appearance, unknown>;

/**
 * System, Light or Dark, as a radio group. The compact one sits in the top bar and shows icons
 * only (the names stay for assistive technology and in the tooltip); Settings shows the words.
 */
export function ThemeSwitch({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { appearance, setAppearance, appearances } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cx("ui-theme-switch", compact && "ui-theme-switch--compact", className)}
      onKeyDown={(event) => handleRadioKeys(event, (value) => setAppearance(value as Appearance))}
    >
      {appearances.map((option) => {
        const Icon = icons[option.id];
        const checked = option.id === appearance;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-value={option.id}
            className="ui-theme-switch__option"
            title={compact ? `${option.label}: ${option.description.toLowerCase()}` : option.description}
            onClick={() => setAppearance(option.id)}
          >
            <Icon />
            <span className={compact ? "ui-visually-hidden" : undefined}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
