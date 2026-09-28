import { useId } from "react";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { handleRadioKeys } from "./ui/radio";
import { useTheme, type PaletteId } from "./useTheme";

/** Settings panel: light, dark or the device's choice, and which dark palette. Kept per browser. */
export default function ThemeSettings() {
  const { appearance, palette, setPalette, palettes } = useTheme();
  const paletteLabel = useId();

  return (
    <section className="panel settings-panel theme-settings">
      <header className="panel-header">
        <div>
          <strong>Appearance</strong>
          <span>For this browser. System follows the device's light or dark setting.</span>
        </div>
      </header>
      <div className="theme-settings-body">
        <ThemeSwitch />
        <div className="theme-palettes">
          <p id={paletteLabel} className="theme-palettes-label">
            <strong>Dark palette</strong>
            <span>{appearance === "light" ? "Used when you switch to Dark or System on a dark device." : "Used whenever BoxPilot is dark."}</span>
          </p>
          <div role="radiogroup" aria-labelledby={paletteLabel} className="theme-palette-grid" onKeyDown={(event) => handleRadioKeys(event, (value) => setPalette(value as PaletteId))}>
            {palettes.map((option) => {
              const checked = option.id === palette;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  data-value={option.id}
                  className="theme-palette"
                  onClick={() => setPalette(option.id)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
