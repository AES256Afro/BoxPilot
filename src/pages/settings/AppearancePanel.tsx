import { useEffect, useState, useSyncExternalStore } from "react";
import { LookThumb } from "../../looks/LookThumb";
import { ACCENTS, DENSITIES, LOOKS, LOOK_SCOPES, WALLPAPERS, lookById, type LookId } from "../../looks/looks";
import { useLook } from "../../looks/useLook";
import { Button, Segmented, Switch } from "../../ui";
import { handleRadioKeys } from "../../ui/radio";
import { useTheme } from "../../useTheme";

/*
 * Settings → Appearance (M41): which look the whole interface is drawn in, and its small choices,
 * as docs/design-directions/05-looks.html drew it (settings). Picking a look applies it at once;
 * Keep this look or Go back, the way a display change is confirmed. Kept in this browser, like
 * light and dark, so a phone and a wall screen can each have their own.
 */

function useResolvedDark(): boolean {
  const { appearance } = useTheme();
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [deviceDark, setDeviceDark] = useState(query?.matches ?? true);
  useEffect(() => {
    if (!query) return undefined;
    const listener = () => setDeviceDark(query.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [query]);
  return appearance === "dark" || (appearance === "system" && deviceDark);
}

const modeWords = { both: "light and dark", light: "light only", dark: "dark only" } as const;

/*
 * The look before the one on trial, kept outside the panel: a look that goes around differently
 * redraws Settings (the sidebar lists the sections, or the tabs come back), and Keep this look and
 * Go back must still be there after it.
 */
let onTrialFrom: LookId | null = null;
const trialListeners = new Set<() => void>();
const setTrialFrom = (look: LookId | null) => { onTrialFrom = look; for (const listener of trialListeners) listener(); };
const subscribeTrial = (listener: () => void) => { trialListeners.add(listener); return () => { trialListeners.delete(listener); }; };
function useTrialFrom(): [LookId | null, (look: LookId | null) => void] {
  return [useSyncExternalStore(subscribeTrial, () => onTrialFrom, () => null), setTrialFrom];
}

const wallpaperPictures: Record<(typeof WALLPAPERS)[number]["id"], string> = {
  sea: "radial-gradient(80% 100% at 10% 0%, rgba(30,110,108,.8), transparent 65%), radial-gradient(70% 90% at 100% 0%, rgba(210,108,44,.55), transparent 62%), linear-gradient(160deg, #193240, #161e2c)",
  dusk: "linear-gradient(160deg, #1f2940, #33243f)",
  meadow: "linear-gradient(160deg, #dfe9d8, #f3e3c8)",
  plain: "#8a939c",
};

export default function AppearancePanel() {
  const choice = useLook();
  const { appearance, setAppearance, appearances } = useTheme();
  const dark = useResolvedDark();
  // The look before the last one picked here, while the new one is on trial.
  const [previous, setPrevious] = useTrialFrom();
  const current = lookById(choice.look);

  const pick = (look: LookId) => {
    if (look === choice.look) return;
    setPrevious(previous ?? choice.look);
    choice.update({ look });
  };

  return (
    <section className="settings-appearance" aria-labelledby="settings-appearance-title">
      <h2 id="settings-appearance-title" className="settings-appearance__title">Appearance</h2>
      <p className="settings-appearance__lead">How BoxPilot looks on every page. Kept in this browser, like light and dark.</p>

      <div className="settings-appearance__label"><span>Look</span><span>{LOOKS.length} looks</span></div>
      <div className="settings-looks" role="radiogroup" aria-label="Look" onKeyDown={(event) => handleRadioKeys(event, (next) => pick(next as LookId))}>
        {LOOKS.map((look) => (
          <button
            key={look.id}
            type="button"
            role="radio"
            aria-checked={look.id === choice.look}
            tabIndex={look.id === choice.look ? 0 : -1}
            data-value={look.id}
            className="settings-look"
            title={look.about}
            onClick={() => pick(look.id)}
          >
            <LookThumb look={look.id} dark={dark} className="settings-look__picture" />
            <span className="settings-look__name">{look.name}</span>
            <span className="settings-look__caption">{look.caption}</span>
          </button>
        ))}
        <div className="settings-look settings-look--soon" aria-hidden="true">
          <span className="settings-look__picture settings-look__picture--soon">+</span>
          <span className="settings-look__name">More later</span>
          <span className="settings-look__caption">Or make your own</span>
        </div>
      </div>

      <div className="settings-appearance__now" role="status">
        <span>Selected: <b>{current.name}</b> · {modeWords[current.modes]} · {choice.scope === "all" ? "every page" : "every page but Home"}</span>
        {previous !== null && <>
          <Button variant="primary" className="settings-appearance__keep" onClick={() => setPrevious(null)}>Keep this look</Button>
          <Button variant="ghost" onClick={() => { choice.update({ look: previous }); setPrevious(null); }}>Go back</Button>
        </>}
      </div>

      <div className="settings-appearance__rows">
        <div className="settings-appearance__row">
          <b>Light or dark</b>
          <small>{current.modes === "both" ? "Follows this device unless you choose." : `${current.name} is ${modeWords[current.modes]}.`}</small>
          <Segmented label="Light or dark" options={appearances.map((option) => ({ value: option.id, label: option.label }))} value={appearance} onChange={setAppearance} />
        </div>
        <div className="settings-appearance__row">
          <b>Where it applies</b>
          <small>Or keep today's Launcher on Home only.</small>
          <Segmented label="Where the look applies" options={LOOK_SCOPES.map((option) => ({ value: option.id, label: option.label }))} value={choice.scope} onChange={(scope) => choice.update({ scope })} />
        </div>
        <div className="settings-appearance__row">
          <b>Accent</b>
          <small>{current.personal ? "Buttons, selection and measured values." : `${current.name} keeps its own colours.`}</small>
          <div className="settings-swatches" role="radiogroup" aria-label="Accent" onKeyDown={(event) => handleRadioKeys(event, (next) => choice.update({ accent: next as typeof choice.accent }))}>
            {ACCENTS.map((accent) => (
              <button key={accent.id} type="button" role="radio" aria-checked={choice.accent === accent.id} aria-label={accent.label} tabIndex={choice.accent === accent.id ? 0 : -1} data-value={accent.id} className="settings-swatch" style={{ background: accent.swatch }} onClick={() => choice.update({ accent: accent.id })} />
            ))}
          </div>
        </div>
        <div className="settings-appearance__row">
          <b>Density</b>
          <small>Compact fits more rows on a page.</small>
          <Segmented label="Density" options={DENSITIES.map((option) => ({ value: option.id, label: option.label }))} value={choice.density} onChange={(density) => choice.update({ density })} />
        </div>
        <div className="settings-appearance__row">
          <b>Wallpaper</b>
          <small>{current.personal ? "Behind the glass." : `Used by Home + Ops and the Launcher.`}</small>
          <div className="settings-swatches" role="radiogroup" aria-label="Wallpaper" onKeyDown={(event) => handleRadioKeys(event, (next) => choice.update({ wallpaper: next as typeof choice.wallpaper }))}>
            {WALLPAPERS.map((wallpaper) => (
              <button key={wallpaper.id} type="button" role="radio" aria-checked={choice.wallpaper === wallpaper.id} aria-label={wallpaper.label} tabIndex={choice.wallpaper === wallpaper.id ? 0 : -1} data-value={wallpaper.id} className="settings-wallpaper" style={{ background: wallpaperPictures[wallpaper.id] }} onClick={() => choice.update({ wallpaper: wallpaper.id })} />
            ))}
          </div>
        </div>
        <div className="settings-appearance__row">
          <b>Reduce transparency</b>
          <small>Solid panels instead of glass.</small>
          <Switch label="Reduce transparency" checked={choice.solid} onChange={(solid) => choice.update({ solid })} className="settings-appearance__switch" />
        </div>
      </div>
    </section>
  );
}
