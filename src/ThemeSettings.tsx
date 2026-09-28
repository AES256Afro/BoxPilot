import { ThemeSwitch } from "./ui/ThemeSwitch";

/** Settings panel: light, dark or the device's choice. Kept per browser. */
export default function ThemeSettings() {
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
      </div>
    </section>
  );
}
