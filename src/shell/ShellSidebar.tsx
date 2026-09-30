import { viewLabel, type ViewName } from "../data";
import { useOptionalFacts } from "../home/facts";
import { uptime } from "../home/format";
import { AreaIcon } from "./areaIcons";
import { useAreaBadges } from "./ShellNav";
import "./sidebar.css";

/*
 * The sidebar (M41): the areas down the left edge, named and grouped, under the server's name, for
 * the looks that go around this way (Home + Ops, Aqua's source list, Toybox). The same areas as the
 * dock and the rail, in the same order within each group; a look's skin draws it (glass, a source
 * list, chunky cards) from src/looks/<id>/skin.css. On a phone the look's CSS folds it away and the
 * dock takes over, so this is only the wide screen's way around.
 */

const groups: Array<{ title: string; areas: Array<{ id: ViewName; short?: string }> }> = [
  { title: "Overview", areas: [{ id: "home" }, { id: "ops" }, { id: "today" }] },
  { title: "Manage", areas: [{ id: "catalog", short: "Apps" }, { id: "storage" }, { id: "network" }, { id: "firewall" }, { id: "backups" }, { id: "virtualization", short: "VMs" }] },
  { title: "Keep it running", areas: [{ id: "updates", short: "Updates" }, { id: "repairs", short: "Repair" }, { id: "logs" }, { id: "services" }, { id: "system" }, { id: "performance", short: "Metrics" }] },
  { title: "More", areas: [{ id: "automations", short: "Automations" }, { id: "agents" }, { id: "users", short: "Users & SSH" }, { id: "github" }] },
];

export function ShellSidebar({ view, onSelect }: { view: ViewName | null; onSelect: (view: ViewName) => void }) {
  const facts = useOptionalFacts()?.facts;
  const inventory = facts?.inventory.value;
  const badgeOf = useAreaBadges();
  const waiting = (badgeOf("updates") ?? 0) + (badgeOf("repairs") ?? 0);
  const item = (id: ViewName, short?: string) => {
    const badge = badgeOf(id);
    return (
      <li key={id}>
        <button type="button" className="sidebar-item" aria-current={view === id ? "page" : undefined} onClick={() => onSelect(id)}>
          <AreaIcon view={id} className="sidebar-item__icon" />
          <span className="sidebar-item__name">{short ?? viewLabel(id)}</span>
          {badge !== undefined && <span className="sidebar-item__badge">{badge}<span className="ui-visually-hidden"> waiting</span></span>}
        </button>
      </li>
    );
  };
  return (
    <nav className="sidebar-nav" aria-label="Areas">
      <div className="sidebar-host">
        <span className="sidebar-host__mark" aria-hidden="true">BP</span>
        <span className="sidebar-host__words">
          <b className="sidebar-host__name">{inventory?.hostname ?? "BoxPilot"}</b>
          <small className="sidebar-host__facts" data-status={waiting > 0 ? "warning" : "good"}>
            {waiting > 0 ? `${waiting} waiting` : "All clear"}{inventory ? ` · up ${uptime(inventory.uptimeSeconds)}` : ""}
          </small>
        </span>
      </div>
      {groups.map((group) => (
        <div className="sidebar-group" key={group.title}>
          <h2 className="sidebar-group__title">{group.title}</h2>
          <ul className="sidebar-group__list">{group.areas.map((area) => item(area.id, area.short))}</ul>
        </div>
      ))}
      <ul className="sidebar-foot">{item("settings")}</ul>
    </nav>
  );
}
