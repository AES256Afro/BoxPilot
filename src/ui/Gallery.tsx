import { useEffect, useState } from "react";
import { navItems } from "../data";
import { Button, RiskTag, riskCopy } from "./Button";
import { Card } from "./Card";
import { CodeBlock } from "./CodeBlock";
import { Dock } from "./Dock";
import { Field } from "./Field";
import { JobProgress } from "./JobProgress";
import { KeyValue } from "./KeyValue";
import { MetricTile } from "./MetricTile";
import { EmptyState, Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Panel } from "./Panel";
import { Progress } from "./Progress";
import { Section } from "./Section";
import { Segmented } from "./Segmented";
import { Select } from "./Select";
import { Sheet } from "./Sheet";
import { StatusChip } from "./StatusChip";
import { Checkbox, Switch } from "./Switch";
import { Table, type TableColumn } from "./Table";
import { Tabs } from "./Tabs";
import { Tag } from "./Tag";
import { SecretInput, TextInput, Textarea } from "./TextInput";
import { ThemeSwitch } from "./ThemeSwitch";
import { Tile } from "./Tile";
import { Toolbar } from "./Toolbar";
import { STATUSES, statusWords, type Density, type RiskTier, type Status } from "./types";

/*
 * Every component, every status and every risk tier, for review in the demo (/?gallery) and in the
 * CI screenshots, light and dark. It sits inside the console like every page but Home, so it shows
 * the components as the pages draw them. Fictional data only: the demo's "homebox", no real host.
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
  { name: "openssl", installed: "3.0.13-0ubuntu3.4", available: "3.0.13-0ubuntu3.5", suite: "noble-security", security: true, size: "1.4 MB", bytes: 1_400_000 },
  { name: "htop", installed: "3.2.2-2", available: "3.3.0-4", suite: "noble-updates", security: false, size: "172 kB", bytes: 172_000 },
  { name: "tmux", installed: "3.4-1", available: "3.4-1ubuntu0.1", suite: "noble-updates", security: false, size: "448 kB", bytes: 448_000 },
];

const packageColumns: Array<TableColumn<(typeof packages)[number]>> = [
  { id: "name", header: "Package", sortValue: (row) => row.name, cell: (row) => <code>{row.name}</code> },
  { id: "installed", header: "Installed", hideOnPhone: true, cell: (row) => row.installed },
  { id: "available", header: "Available", cell: (row) => row.available },
  { id: "size", header: "Size", numeric: true, sortValue: (row) => row.bytes, cell: (row) => row.size },
  { id: "suite", header: "Source", cell: (row) => (row.security ? <StatusChip status="warning">{row.suite}</StatusChip> : row.suite) },
];

const dockAreas = ["updates", "storage", "firewall", "network", "backups", "virtualization", "repairs", "logs", "settings"];

const swatches = [
  "canvas", "surface", "surface-raised", "surface-inset", "border", "text", "text-muted", "accent",
  "status-good", "status-warning", "status-danger", "status-neutral", "status-unknown", "cc-cyan",
];

const journal = [
  "2026-09-29T08:00:01+0000 homebox systemd[1]: Starting docker.service - Docker Application Container Engine...",
  "2026-09-29T08:00:03+0000 homebox dockerd[812]: API listen on /run/docker.sock",
  "2026-09-29T08:00:03+0000 homebox systemd[1]: Started docker.service - Docker Application Container Engine.",
].join("\n");

function DensityShowcase({ density, title, summary }: { density: Density; title: string; summary: string }) {
  const [current, setCurrent] = useState("updates");
  return (
    <div className="ui-gallery__density" data-density={density}>
      <Section title={title} summary={summary} status={{ status: "neutral", label: density === "comfortable" ? "Home" : "Console" }}>
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

/** The newest job the demo has, so JobProgress follows a real one. */
function useSomeJob(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/jobs?limit=5").then((response) => (response.ok ? response.json() as Promise<{ jobs?: Array<{ id: string; state: string }> }> : null))
      .then((body) => { const job = body?.jobs?.find((entry) => entry.state === "completed") ?? body?.jobs?.[0]; if (live && job) setId(job.id); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return id;
}

/** The console's page kit (M33.8), as a page draws it. */
function PageKit() {
  const [hostname, setHostname] = useState("homebox");
  const [notes, setNotes] = useState("");
  const [token, setToken] = useState("tskey-api-EXAMPLE0000");
  const [since, setSince] = useState("1h");
  const [automatic, setAutomatic] = useState(true);
  const [follow, setFollow] = useState(false);
  const [volumes, setVolumes] = useState(true);
  const [scope, setScope] = useState<"common" | "failed" | "all">("common");
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState<"right" | "center" | null>(null);
  const job = useSomeJob();
  const problem = hostname.length > 20 ? "At most 20 characters" : undefined;
  return (
    <section className="ui-gallery__kit" aria-labelledby="ui-gallery-kit">
      <h2 id="ui-gallery-kit" className="ui-gallery__heading">The page kit</h2>

      <Panel padded title="PageHeader" meta="the name goes in the bar; here it is drawn in place">
        <PageHeader
          placement="inline"
          title="Firewall"
          host="homebox"
          status={{ status: "good", label: "Active" }}
          meta={<>ufw <b>0.36.2</b> · <b>10</b> rules · in <b>deny</b> / out <b>allow</b></>}
          actions={<><Button risk="low">Read again</Button><Button variant="primary" risk="high">Turn off</Button></>}
          about="Profiles, open ports and suggestions from what is listening. SSH, Tailscale and BoxPilot are always kept reachable."
        />
      </Panel>

      <KeyValue layout="strip" items={[
        { id: "ufw", label: "UFW", value: "active", status: "good" },
        { id: "policy", label: "In / out", value: "deny / allow", mono: true },
        { id: "profile", label: "Profile", value: "Home server" },
        { id: "rules", label: "Rules", value: "10", mono: true, hint: "1 staged" },
        { id: "jails", label: "fail2ban", value: "2 jails", status: "warning" },
      ]} />

      <div className="ui-gallery__grid">
        <Panel padded title="Panel" count={{ status: "warning", label: "2" }} meta={<><b>1</b> running · <b>1</b> waiting</>} footer={<>9/9 local · <b>7/9</b> off-box · last run 03:10</>} actions={<Button variant="ghost">All jobs</Button>}>
          <KeyValue layout="rows" items={[
            { id: "kernel", label: "Kernel", value: "6.8.0-45-generic", mono: true },
            { id: "uptime", label: "Uptime", value: "23d 04h", mono: true },
            { id: "backup", label: "Last backup", value: "11 hours ago", status: "good", hint: "with a restore drill" },
          ]} />
        </Panel>

        <Panel padded title="Form controls">
          <Field label="Hostname" hint="Letters, digits and hyphens" error={problem} required>
            <TextInput value={hostname} onValueChange={setHostname} mono />
          </Field>
          <Field label="Since" optional>
            <Select value={since} onValueChange={setSince} options={[{ value: "15m", label: "Last 15 minutes" }, { value: "1h", label: "Last hour" }, { value: "1d", label: "Last day" }]} />
          </Field>
          <Field label="Tailscale API key" hint="Stored encrypted; shown only when you ask">
            <SecretInput value={token} onValueChange={setToken} />
          </Field>
          <Field label="Note" hint="Kept with the backup">
            <Textarea value={notes} onValueChange={setNotes} placeholder="What changed before this backup…" rows={3} />
          </Field>
        </Panel>

        <Panel padded title="Choices">
          <Switch label="Automatic security updates" description="Installs them overnight, with a restart hint" risk="medium" checked={automatic} onChange={setAutomatic} />
          <Switch label="Follow" checked={follow} onChange={setFollow} />
          <Checkbox label="Include named volumes" description="The app's data that lives in Docker volumes" checked={volumes} onChange={setVolumes} />
          <Checkbox label="Every app" indeterminate />
          <Segmented label="Which units" value={scope} onChange={setScope} options={[{ value: "common", label: "Common", count: 38 }, { value: "failed", label: "Failed", count: 1 }, { value: "all", label: "All", count: 214 }]} />
        </Panel>

        <Panel padded title="Notices and empty states">
          <Notice tone="info" title="The package lists are 3 days old">Refresh them before installing.</Notice>
          <Notice tone="success" title="Backup finished" action={<Button variant="ghost">Open</Button>}>Immich, 412 GB, verified.</Notice>
          <Notice tone="warning" title="No off-box copy" action={<Button risk="medium">Copy now</Button>}>Two apps are only on this server.</Notice>
          <Notice tone="danger" title="The journal could not be read" onDismiss={() => undefined}>The helper did not answer.</Notice>
          <EmptyState title="No backups yet" action={<Button risk="medium">Back up now</Button>}>Each app's first backup appears here.</EmptyState>
        </Panel>
      </div>

      <Panel title="Toolbar, Table and Tag" count={packages.length} meta="sort by Package or Size">
        <Toolbar
          label="Packages"
          className="ui-gallery__toolbar"
          search={{ value: search, onValueChange: setSearch, label: "Filter packages" }}
          filters={<Segmented label="Which packages" value="all" onChange={() => undefined} options={[{ value: "all", label: "All" }, { value: "security", label: "Security", count: 1 }]} />}
          actions={<><Tag reach="lan" /><Tag reach="tailnet" /><Tag reach="local" /><Tag reach="public" /><Tag tier="low" /><Tag tier="medium" /><Tag tier="high" /><Tag tone="info">ext4</Tag></>}
        />
        <Table caption="Upgradable packages, sortable" columns={packageColumns} rows={packages.filter((row) => row.name.includes(search.trim()))} rowKey={(row) => row.name}
          rowStatus={(row) => (row.security ? "warning" : undefined)} defaultSort={{ column: "name", direction: "ascending" }}
          empty={<EmptyState title="No packages match">Search looks at the package's name.</EmptyState>} />
      </Panel>

      <Panel padded title="Tabs">
        <Tabs label="Storage" tabs={[{ id: "disks", label: "Disks", count: 3 }, { id: "shares", label: "Shares", count: 2, status: "warning", statusLabel: "1 needs a look" }, { id: "swap", label: "Swap" }]}>
          {(tab) => <p className="ui-gallery__note">The {tab} tab. With urlParam="tab" the open tab lives in the address, as ?view=storage&amp;tab={tab}.</p>}
        </Tabs>
      </Panel>

      <div className="ui-gallery__grid">
        <Panel padded title="CodeBlock and Progress">
          <CodeBlock label="Journal for docker.service" meta="3 lines">{journal}</CodeBlock>
          <Progress label="Backing up Immich" value={62} detail="62%" />
          <Progress label="Restarting docker.service" detail="indeterminate" />
          <Progress label="Restore drill" value={100} status="good" detail="passed" />
        </Panel>
        <Panel padded title="JobProgress and Sheet">
          {job ? <JobProgress jobId={job} /> : <p className="ui-gallery__note">JobProgress follows a job by its id; the demo has none yet.</p>}
          <div className="ui-gallery__row">
            <Button onClick={() => setSheet("right")}>Open a drawer</Button>
            <Button onClick={() => setSheet("center")}>Open a dialog</Button>
          </div>
        </Panel>
      </div>

      {sheet && (
        <Sheet kicker={sheet === "right" ? "Journal" : "New share"} title={sheet === "right" ? "docker.service" : "Share a folder"} side={sheet} size={sheet === "right" ? "lg" : "md"} onClose={() => setSheet(null)}
          footer={<><Button onClick={() => setSheet(null)}>Cancel</Button><Button variant="primary" risk="medium">{sheet === "right" ? "Read again" : "Share"}</Button></>}>
          {sheet === "right" ? <CodeBlock label="Journal for docker.service">{journal}</CodeBlock> : (
            <>
              <Field label="Folder" hint="On this server"><TextInput mono defaultValue="/srv/media" /></Field>
              <Field label="Who can reach it"><Select defaultValue="tailnet" options={[{ value: "tailnet", label: "The tailnet" }, { value: "lan", label: "The local network" }]} /></Field>
            </>
          )}
        </Sheet>
      )}
    </section>
  );
}

export default function Gallery() {
  return (
    <div className="ui-gallery">
      <PageHeader
        title="Design system"
        status={{ status: "neutral", label: "Demo only" }}
        meta={<>src/ui · <b>{STATUSES.length}</b> statuses · <b>{tiers.length}</b> tiers · light and dark</>}
        actions={<ThemeSwitch />}
        about="The components pages are built from (src/ui): Home's comfortable density and the console's compact one, and the page kit every console page uses. docs/UI-PAGES.md says how a page is put together."
      />

      <Panel padded title="Tokens">
        <ul className="ui-gallery__swatches">
          {swatches.map((token) => (
            <li key={token}><span className="ui-gallery__swatch" style={{ background: `var(--${token})` }} /><code>--{token}</code></li>
          ))}
        </ul>
      </Panel>

      <PageKit />

      <DensityShowcase density="compact" title="Compact" summary="The console's density: tighter rows and type, numbers in monospace." />
      <DensityShowcase density="comfortable" title="Comfortable" summary="Home's density: room around each thing, larger type, 56 px app icons." />
    </div>
  );
}
