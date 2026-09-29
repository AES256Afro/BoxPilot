import { Panel } from "../../ui";
import { ThemeSwitch } from "../../ui/ThemeSwitch";

/** Settings → Appearance: light, dark or the device's choice. Kept per browser, not per account. */
export default function AppearancePanel() {
  return (
    <Panel title="Theme" meta="for this browser" padded className="settings-panel">
      <ThemeSwitch className="settings-theme" />
      <p className="settings-quiet">System follows the device's light or dark setting. The same choice is in the top bar.</p>
    </Panel>
  );
}
