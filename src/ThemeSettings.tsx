import { useTheme, THEMES, type ThemeId } from "./useTheme";

/** Settings panel: choose the UI theme. Persisted in localStorage. */
export default function ThemeSettings() {
  const { theme, setTheme, themes } = useTheme();

  return (
    <section className="panel settings-panel">
      <header className="panel-header">
        <div>
          <strong>Theme</strong>
          <span>Appearance of the interface</span>
        </div>
      </header>
      <div style={{ padding: "16px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: "10px",
          }}
        >
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id as ThemeId)}
              style={{
                display: "grid",
                gap: "4px",
                padding: "12px",
                border:
                  theme === t.id
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                background:
                  theme === t.id ? "var(--accent-bg)" : "var(--surface)",
                color: theme === t.id ? "var(--accent)" : "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                fontSize: "inherit",
                transition: "160ms ease",
              }}
            >
              <strong style={{ fontSize: "12px" }}>{t.label}</strong>
              <span
                style={{
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  lineHeight: 1.4,
                }}
              >
                {t.description}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
