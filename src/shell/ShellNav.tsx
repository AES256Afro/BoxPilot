import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { viewLabel, type ViewName } from "../data";
import { useOptionalFacts } from "../home/facts";
import { Dock, type DockItem } from "../ui";
import { useDialogFocus } from "../useDialogFocus";
import { AreaIcon, MoreIcon } from "./areaIcons";

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
 * shows everything it does (ADR-004). `short` is the name under the icon where the full one does
 * not fit; `priority` is which stay on a narrower screen (1 on a phone, 2 below 1380px, 3 only on
 * a wide one), with More showing all of them.
 */
export const dockAreas: Array<{ id: ViewName; short?: string; priority: 1 | 2 | 3; separatorBefore?: boolean }> = [
  { id: "updates", short: "Updates", priority: 1 }, { id: "storage", priority: 1 }, { id: "firewall", priority: 2 }, { id: "network", priority: 2 },
  { id: "backups", priority: 1 }, { id: "virtualization", short: "VMs", priority: 2 }, { id: "repairs", short: "Repair", priority: 1 }, { id: "logs", priority: 2 },
  { id: "catalog", short: "Apps", priority: 3, separatorBefore: true }, { id: "automations", short: "Automate", priority: 3 }, { id: "services", priority: 3 }, { id: "system", priority: 3 },
  { id: "performance", short: "Metrics", priority: 3 }, { id: "users", short: "Users", priority: 3 }, { id: "github", priority: 3 }, { id: "overview", short: "Classic", priority: 3 },
  { id: "settings", priority: 3, separatorBefore: true },
];

/**
 * The dock, with counts from what Home or Ops last read (nothing is fetched for them). On Ops it is
 * the study's rail instead (M33.7): the same areas stood down the left edge under the BoxPilot mark,
 * led by Ops itself as the current item; on a narrow screen the rail folds back into the dock.
 */
export function ShellDock({ view, onSelect, variant = "dock" }: { view: ViewName | null; onSelect: (view: ViewName) => void; variant?: "dock" | "rail" }) {
  const facts = useOptionalFacts()?.facts;
  const [allOpen, setAllOpen] = useState(false);
  const updates = facts?.updates.value?.count ?? 0;
  const findings = (facts?.repairs.value?.findings ?? []).filter((finding) => finding.severity !== "info").length;
  const areas: DockItem[] = dockAreas.map(({ id, short, priority, separatorBefore }) => ({
    id, short, priority, separatorBefore, label: viewLabel(id), icon: <AreaIcon view={id} />, current: view === id,
    badge: id === "updates" && updates > 0 ? updates : id === "repairs" && findings > 0 ? findings : undefined,
    badgeLabel: id === "repairs" ? "to fix" : "waiting",
  }));
  const more: DockItem = { id: "more", label: "All areas", short: "More", icon: <MoreIcon />, priority: "overflow" };
  const rail = variant === "rail";
  const lead: DockItem[] = rail && view ? [{ id: view, label: viewLabel(view), icon: <AreaIcon view={view} />, current: true, priority: 3 }] : [];
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

/** Every area, named in full, for a screen too narrow for the whole dock. */
function AreasSheet({ areas, onClose, onSelect }: { areas: DockItem[]; onClose: () => void; onSelect: (view: ViewName) => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useDialogFocus(ref);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={ref} tabIndex={-1} className="modal areas-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header className="areas-sheet__head">
          <h2 id={titleId}>All areas</h2>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>X</button>
        </header>
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
      </section>
    </div>,
    document.body,
  );
}
