import { useState } from "react";
import { viewLabel, type ViewName } from "../data";
import { useOptionalFacts } from "../home/facts";
import { Dock, Sheet, type DockItem } from "../ui";
import { AreaIcon, MoreIcon } from "./areaIcons";
import "./look.css";

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
 * the rest of what the sidebar held, then Settings. `short` is the name under the icon where the
 * full one does not fit; `priority` is which stay on a narrower screen (1 on a phone, 2 below
 * 1380px, 3 only on a wide one), with More showing all of them. The Classic overview left the dock
 * in M33.8, when Home and Ops came to show everything it did.
 */
export const dockAreas: Array<{ id: ViewName; short?: string; priority: 1 | 2 | 3; separatorBefore?: boolean }> = [
  { id: "updates", short: "Updates", priority: 1 }, { id: "storage", priority: 1 }, { id: "firewall", priority: 2 }, { id: "network", priority: 2 },
  { id: "backups", priority: 1 }, { id: "virtualization", short: "VMs", priority: 2 }, { id: "repairs", short: "Repair", priority: 1 }, { id: "logs", priority: 2 },
  { id: "catalog", short: "Apps", priority: 3, separatorBefore: true }, { id: "automations", short: "Automate", priority: 3 }, { id: "services", priority: 3 }, { id: "system", priority: 3 },
  { id: "performance", short: "Metrics", priority: 3 }, { id: "users", short: "Users", priority: 3 }, { id: "github", priority: 3 },
  { id: "settings", priority: 3, separatorBefore: true },
];

/**
 * The dock, with counts from what Home or Ops last read (nothing is fetched for them). In the
 * console, which is every page but Home (M33.8), it is the study's rail instead (M33.7): the same
 * areas stood down the left edge under the BoxPilot mark, led by Ops, the console's overview; on a
 * narrow screen the rail folds back into the dock.
 */
export function ShellDock({ view, onSelect, variant = "dock" }: { view: ViewName | null; onSelect: (view: ViewName) => void; variant?: "dock" | "rail" }) {
  const facts = useOptionalFacts()?.facts;
  const [allOpen, setAllOpen] = useState(false);
  const updates = facts?.updates.value?.count ?? 0;
  const findings = (facts?.repairs.value?.findings ?? []).filter((finding) => finding.severity !== "info").length;
  const rail = variant === "rail";
  const areas: DockItem[] = dockAreas.map(({ id, short, priority, separatorBefore }, index) => ({
    // On the rail a rule sets the areas apart from Ops, which leads them.
    id, short, priority, separatorBefore: separatorBefore || (rail && index === 0), label: viewLabel(id), icon: <AreaIcon view={id} />, current: view === id,
    badge: id === "updates" && updates > 0 ? updates : id === "repairs" && findings > 0 ? findings : undefined,
    badgeLabel: id === "repairs" ? "to fix" : "waiting",
  }));
  const more: DockItem = { id: "more", label: "All areas", short: "More", icon: <MoreIcon />, priority: "overflow" };
  const lead: DockItem[] = rail ? [{ id: "ops", label: viewLabel("ops"), icon: <AreaIcon view="ops" />, current: view === "ops", priority: 3 }] : [];
  return (
    <>
      <Dock
        className={rail ? "shell-dock shell-dock--rail" : "shell-dock"}
        label="Admin areas"
        lead={rail ? <span className="shell-rail__logo" aria-hidden="true">BP</span> : undefined}
        onSelect={(id) => (id === "more" ? setAllOpen(true) : onSelect(id as ViewName))}
        items={[...lead, ...areas, more]}
      />
      {allOpen && <AreasSheet areas={areas} onClose={() => setAllOpen(false)} onSelect={(id) => { setAllOpen(false); onSelect(id); }} />}
    </>
  );
}

/**
 * Every area, named in full, for a screen too narrow for the whole dock: the kit's Sheet as a
 * dialog (M33.13), in the console's look wherever it opens.
 */
function AreasSheet({ areas, onClose, onSelect }: { areas: DockItem[]; onClose: () => void; onSelect: (view: ViewName) => void }) {
  return (
    <Sheet title="All areas" side="center" className="look-console areas-sheet" onClose={onClose}>
        <ul className="areas-sheet__grid">
          {areas.map((area) => {
            const counted = area.badge !== undefined && area.badge !== "";
            return (
              <li key={area.id}>
                <button type="button" className="ui-dock__item" aria-current={area.current ? "page" : undefined} onClick={() => onSelect(area.id as ViewName)}>
                  <span className="ui-dock__icon" aria-hidden="true">
                    {area.icon}
                    {counted && <span className="ui-dock__badge">{area.badge}</span>}
                  </span>
                  <span className="ui-dock__label">{area.label}</span>
                  {counted && <span className="ui-visually-hidden">, {area.badge} {area.badgeLabel ?? "waiting"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
    </Sheet>
  );
}
