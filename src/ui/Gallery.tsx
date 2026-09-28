import { useState } from "react";
import { navItems } from "../data";
import { Button, RiskTag, riskCopy } from "./Button";
import { Card } from "./Card";
import { Dock } from "./Dock";
import { MetricTile } from "./MetricTile";
import { Section } from "./Section";
import { StatusChip } from "./StatusChip";
import { ThemeSwitch } from "./ThemeSwitch";
import { Table, type TableColumn } from "./Table";
import { Tile } from "./Tile";
import { STATUSES, statusWords, type Density, type RiskTier, type Status } from "./types";

/*
 * Every component in both densities, every status and every risk tier, for review in the demo
 * (/?gallery) and in the CI screenshots, light and dark. Fictional data only: the demo's
 * "homebox", no real host.
 */

const tiers: RiskTier[] = ["low", "medium", "high"];

const apps: Array<{ name: string; status: Status; detail: string }> = [
  { name: "Jellyfin", status: "good", detail: "2 streaming" },
  { name: "Immich", status: "warning", detail: "Not off-box" },
  { name: "Home Assistant", status: "good", detail: "41 devices" },
  { name: "Pi-hole", status: "danger", detail: "Stopped" },
  { name: "Vaultwarden", status: "neutral", detail: "Paused" },
  { name: "Open WebUI", status: "unknown", detail: "Not checked" },
];

const packages = [
  { name: "openssl", installed: "3.0.13-0ubuntu3.4", available: "3.0.13-0ubuntu3.5", suite: "noble-security", security: true, size: "1.4 MB" },
  { name: "htop", installed: "3.2.2-2", available: "3.3.0-4", suite: "noble-updates", security: false, size: "172 kB" },
  { name: "tmux", installed: "3.4-1", available: "3.4-1ubuntu0.1", suite: "noble-updates", security: false, size: "448 kB" },
];

const packageColumns: Array<TableColumn<(typeof packages)[number]>> = [
  { id: "name", header: "Package", cell: (row) => <code>{row.name}</code> },
  { id: "installed", header: "Installed", hideOnPhone: true, cell: (row) => row.installed },
  { id: "available", header: "Available", cell: (row) => row.available },
  { id: "size", header: "Size", numeric: true, cell: (row) => row.size },
  { id: "suite", header: "Source", cell: (row) => (row.security ? <StatusChip status="warning">{row.suite}</StatusChip> : row.suite) },
];

const dockAreas = ["updates", "storage", "firewall", "network", "backups", "virtualization", "repairs", "logs", "settings"];

const swatches = [
  "canvas", "surface", "surface-raised", "surface-inset", "border", "text", "text-muted", "accent",
  "status-good", "status-warning", "status-danger", "status-neutral", "status-unknown",
];

function DensityShowcase({ density, title, summary }: { density: Density; title: string; summary: string }) {
  const [current, setCurrent] = useState("updates");
  return (
    <div className="ui-gallery__density" data-density={density}>
      <Section title={title} summary={summary} status={{ status: "neutral", label: density === "comfortable" ? "Home" : "Ops" }}>
        <Card className="ui-gallery__block">
          <h3>Buttons and their risk tiers</h3>
          <div className="ui-gallery__buttons" role="group" aria-label={`Buttons, ${density}`}>
            {(["primary", "secondary", "ghost"] as const).map((variant) => (
              <div key={variant} className="ui-gallery__row">
                <span className="ui-gallery__caption">{variant}</span>
                <Button variant={variant}>No tier</Button>
                {tiers.map((risk) => <Button key={risk} variant={variant} risk={risk}>{riskCopy[risk].label} risk</Button>)}
              </div>
            ))}
            <div className="ui-gallery__row">
              <span className="ui-gallery__caption">states</span>
              <Button risk="medium" disabled>Disabled</Button>
              <Button risk="high" disabled>Disabled high</Button>
              <Button risk="low" busy>Working</Button>
            </div>
          </div>
        </Card>

        <div className="ui-gallery__split">
          <Card className="ui-gallery__block">
            <h3>Status</h3>
            <div className="ui-gallery__row">
              {STATUSES.map((status) => <StatusChip key={status} status={status}>{statusWords[status]}</StatusChip>)}
            </div>
          </Card>
          <Card className="ui-gallery__block">
            <h3>Risk tiers</h3>
            <div className="ui-gallery__row">
              {tiers.map((risk) => <RiskTag key={risk} risk={risk} />)}
            </div>
          </Card>
        </div>

        <Card className="ui-gallery__block">
          <h3>Tiles</h3>
          <div className="ui-gallery__tiles">
            {apps.map((app) => <Tile key={app.name} name={app.name} status={app.status} detail={app.detail} onSelect={() => undefined} />)}
          </div>
        </Card>

        <div className="ui-gallery__metrics">
          <MetricTile label="Processor" value="12%" caption="load 1.84" status="good" bar={{ value: 12 }} />
          <MetricTile label="Memory" value="21.4 GB" caption="of 64 GB" status="neutral" bar={{ value: 21.4, max: 64 }} />
          <MetricTile label="Root volume" value="80%" caption="+2 GB a week" status="warning" bar={{ value: 80 }} />
          <MetricTile label="Off-box copies" value="7 of 9" caption="2 apps only here" status="danger" bar={{ value: 7, max: 9 }} />
          <MetricTile label="Temperatures" value="—" caption="No sensor answered" status="unknown">
            <Button variant="ghost">Check again</Button>
          </MetricTile>
        </div>

        <Section
          level={3}
          title="Upgradable packages"
          status={{ status: "warning", label: "3 security updates" }}
          summary="A section puts its status first, then one sentence, then the rows."
          actions={<><Button risk="low">Refresh lists</Button><Button variant="primary" risk="medium">Install all updates</Button></>}
        >
          <Card flush>
            <Table
              caption={`Upgradable packages, ${density}`}
              columns={packageColumns}
              rows={packages}
              rowKey={(row) => row.name}
              rowStatus={(row) => (row.security ? "warning" : undefined)}
            />
          </Card>
        </Section>

        <div className="ui-gallery__dock">
          <Dock
            label={`Admin areas, ${density}`}
            onSelect={setCurrent}
            items={dockAreas.map((id) => {
              const item = navItems.find((entry) => entry.id === id);
              return { id, label: item?.label ?? id, icon: item?.short ?? id.slice(0, 2).toUpperCase(), current: id === current, badge: id === "updates" ? 14 : id === "backups" ? 2 : undefined, separatorBefore: id === "settings" };
            })}
          />
        </div>
      </Section>
    </div>
  );
}

export default function Gallery() {
  return (
    <div className="ui-gallery">
      <header className="page-header">
        <div>
          <span className="eyebrow">Demo only</span>
          <h1>Design system</h1>
          <p>The components pages are built from (src/ui), at Home's comfortable density and Ops' compact one. Switch the theme in the top bar or here.</p>
        </div>
        <ThemeSwitch />
      </header>

      <Card className="ui-gallery__block">
        <h3>Tokens</h3>
        <ul className="ui-gallery__swatches">
          {swatches.map((token) => (
            <li key={token}><span className="ui-gallery__swatch" style={{ background: `var(--${token})` }} /><code>--{token}</code></li>
          ))}
        </ul>
      </Card>

      <DensityShowcase density="comfortable" title="Comfortable" summary="Home's density: room around each thing, larger type, 56 px app icons." />
      <DensityShowcase density="compact" title="Compact" summary="Ops' density: tighter rows and type, numbers in monospace." />
    </div>
  );
}
