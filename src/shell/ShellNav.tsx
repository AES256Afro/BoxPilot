import { viewLabel, type ViewName } from "../data";
import { useOptionalFacts } from "../home/facts";
import { Dock } from "../ui";
import { AreaIcon } from "./areaIcons";

/*
 * The shell's two ways around (M33.2, ADR-004): the Home / Ops switch in the top bar, and the dock
 * of admin areas that replaced the sidebar. Every page in the navigation is in one or the other.
 */

/** Home and Ops, the two views of the same facts. */
export function ViewSwitch({ view, onSelect }: { view: ViewName | null; onSelect: (view: ViewName) => void }) {
  return (
    <nav className="view-switch" aria-label="Views">
      {(["home", "ops"] as const).map((id) => (
        <button key={id} type="button" className="view-switch__option" aria-current={view === id ? "page" : undefined} onClick={() => onSelect(id)}>
          <AreaIcon view={id} />
          <span>{viewLabel(id)}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * The admin areas, in the dock's order: the everyday ones first as in the study's Launcher, then
 * the rest of what the sidebar held, then Settings. The Overview is there as Classic until Home
 * shows everything it does (ADR-004).
 */
export const dockAreas: Array<{ id: ViewName; separatorBefore?: boolean }> = [
  { id: "updates" }, { id: "storage" }, { id: "firewall" }, { id: "network" }, { id: "backups" }, { id: "virtualization" }, { id: "repairs" }, { id: "logs" },
  { id: "catalog", separatorBefore: true }, { id: "automations" }, { id: "services" }, { id: "system" }, { id: "performance" }, { id: "users" }, { id: "github" }, { id: "overview" },
  { id: "settings", separatorBefore: true },
];

/** The dock, with counts from what Home or Ops last read (nothing is fetched for them). */
export function ShellDock({ view, onSelect }: { view: ViewName | null; onSelect: (view: ViewName) => void }) {
  const facts = useOptionalFacts()?.facts;
  const updates = facts?.updates.value?.count ?? 0;
  const findings = (facts?.repairs.value?.findings ?? []).filter((finding) => finding.severity !== "info").length;
  return (
    <Dock
      className="shell-dock"
      label="Admin areas"
      onSelect={(id) => onSelect(id as ViewName)}
      items={dockAreas.map(({ id, separatorBefore }) => ({
        id, separatorBefore, label: viewLabel(id), icon: <AreaIcon view={id} />, current: view === id,
        badge: id === "updates" && updates > 0 ? updates : id === "repairs" && findings > 0 ? findings : undefined,
        badgeLabel: id === "repairs" ? "to fix" : "waiting",
      }))}
    />
  );
}
