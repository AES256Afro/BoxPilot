import { useEffect, useState, type ReactNode } from "react";
import { viewLabel, type ViewName } from "../data";
import { useOptionalFacts } from "../home/facts";
import { uptime } from "../home/format";
import { useHostVerdict } from "../home/hostVerdict";
import { sectionsFor, useSettingsSection, type SettingsSection } from "../pages/settings/sections";
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

/** One line icon per Settings section, on the areas' 24-unit grid. Decoration. */
const sectionShapes: Record<SettingsSection, ReactNode> = {
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6" /></>,
  appearance: <><circle cx="12" cy="12" r="9" /><circle cx="8" cy="10" r="1.2" /><circle cx="12" cy="7.5" r="1.2" /><circle cx="16" cy="10" r="1.2" /><path d="M12 21a3 3 0 0 1 0-6h2" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.5-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.3 2.6 3.5 5.5" /></>,
  notifications: <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
  approvals: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  sso: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>,
  credentials: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
};

function SectionIcon({ section }: { section: SettingsSection }) {
  return (
    <svg className="sidebar-item__icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {sectionShapes[section]}
    </svg>
  );
}

export interface ShellSidebarProps {
  view: ViewName | null;
  onSelect: (view: ViewName) => void;
  /** Who is signed in, for Settings' own list: its sections are the role's. */
  role?: string;
  username?: string | null;
}

export function ShellSidebar(props: ShellSidebarProps) {
  // While Settings is open the sidebar is Settings' own list of sections, as a Mac's System
  // Settings is (M41); "All areas" shows the areas again without leaving the page.
  const [areasAsked, setAreasAsked] = useState(false);
  useEffect(() => { setAreasAsked(false); }, [props.view]);
  if (props.view === "settings" && !areasAsked) return <SettingsSidebar {...props} onAreas={() => setAreasAsked(true)} />;
  return <AreasSidebar {...props} onSettingsAgain={props.view === "settings" ? () => setAreasAsked(false) : undefined} />;
}

function SettingsSidebar({ role = "owner", username, onAreas }: ShellSidebarProps & { onAreas: () => void }) {
  const inventory = useOptionalFacts()?.facts.inventory.value;
  const [open, setOpen] = useSettingsSection(role);
  const sections = sectionsFor(role);
  const groups = (["You", "This server"] as const).map((title) => ({ title, sections: sections.filter((section) => section.group === title) })).filter((group) => group.sections.length);
  return (
    <nav className="sidebar-nav" aria-label="Settings sections">
      <div className="sidebar-host">
        <span className="sidebar-host__mark" aria-hidden="true">BP</span>
        <span className="sidebar-host__words">
          <b className="sidebar-host__name">Settings</b>
          <small className="sidebar-host__facts" data-status="good">{[inventory?.hostname, username ? `${username} (${role})` : role].filter(Boolean).join(" · ")}</small>
        </span>
      </div>
      <ul className="sidebar-group__list">
        <li>
          <button type="button" className="sidebar-item sidebar-item--back" onClick={onAreas}>
            <svg className="sidebar-item__icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" /></svg>
            <span className="sidebar-item__name">All areas</span>
          </button>
        </li>
      </ul>
      {groups.map((group) => (
        <div className="sidebar-group" key={group.title}>
          <h2 className="sidebar-group__title">{group.title}</h2>
          <ul className="sidebar-group__list">
            {group.sections.map((section) => (
              <li key={section.id}>
                <button type="button" className="sidebar-item" aria-current={open === section.id ? "page" : undefined} aria-controls="settings-section" onClick={() => setOpen(section.id)}>
                  <SectionIcon section={section.id} />
                  <span className="sidebar-item__name">{section.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AreasSidebar({ view, onSelect, onSettingsAgain, role }: ShellSidebarProps & { onSettingsAgain?: () => void }) {
  const facts = useOptionalFacts()?.facts;
  const inventory = facts?.inventory.value;
  const badgeOf = useAreaBadges();
  // Home's own verdict ("3 to look at"), so the sidebar and Home's chip always agree; nothing
  // until it has been read, never an "All clear" nobody checked.
  const verdict = useHostVerdict(role);
  const item = (id: ViewName, short?: string) => {
    const badge = badgeOf(id);
    return (
      <li key={id}>
        <button type="button" className="sidebar-item" aria-current={view === id ? "page" : undefined} onClick={() => (id === "settings" && onSettingsAgain ? onSettingsAgain() : onSelect(id))}>
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
          <small className="sidebar-host__facts" data-status={verdict.status ?? undefined}>
            {[verdict.label, inventory ? `up ${uptime(inventory.uptimeSeconds)}` : null].filter(Boolean).join(" · ")}
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
