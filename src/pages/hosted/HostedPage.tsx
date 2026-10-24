import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { readJson } from "../../http";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, KeyValue, Notice, PageHeader, Panel, Select, Sheet, StatusChip, Table, Tag, TextInput, type KeyValueItem, type Status, type TableColumn } from "../../ui";
import { isHostedStatus, type DomainBackup, type DomainCertificate, type DomainDns, type DomainProbe, type DomainSource, type DomainState, type HostedDomain, type HostedStatus, type TunnelFacts } from "./types";
import "./hosted.css";

/*
 * Hosted domains (M42.2): every public name this server answers for, one row each, with the checks
 * BoxPilot runs on the cadence the owner sets. Facts first: the verdict (how many are down), the
 * tunnel, Cloudflare, the cadence and the alerts in a strip, then the table: DNS, the certificate,
 * an answer from the internet and one from inside, uptime, the app's backups, and under a name
 * that is not up, what to do. A name's full facts open in a sheet; a name nothing found is added
 * by hand in another. Adding a name changes nothing on the server, so it carries no tier.
 */

const stateWords: Record<DomainState, { status: Status; label: string }> = {
  up: { status: "good", label: "Up" },
  degraded: { status: "warning", label: "Needs a look" },
  down: { status: "danger", label: "Down" },
  unknown: { status: "unknown", label: "Not checked" },
};
const stateRank: Record<DomainState, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
const sourceWords: Record<DomainSource, string> = { tunnel: "published by BoxPilot", "cloudflared-config": "a cloudflared config", proxy: "the proxy manager", catalog: "the app's own settings", manual: "added by hand" };

interface Figure { value: string; hint?: string | null; status?: Status }

function dnsWords(dns: DomainDns | null, expect: HostedDomain["expect"]): Figure {
  if (!dns) return { value: "—", hint: "not asked" };
  if (!dns.resolved) return { value: "None", hint: dns.error ?? "no address", status: "danger" };
  const first = dns.addresses[0] ?? null;
  if (dns.private) return { value: "Private", hint: first, status: "warning" };
  if (dns.viaCloudflare) return { value: "Cloudflare", hint: first, status: "good" };
  return { value: "Direct", hint: first, status: expect === "cloudflare" ? "warning" : "good" };
}

function certificateWords(certificate: DomainCertificate | null, outside: DomainProbe | null): Figure {
  if (!certificate || certificate.daysLeft === null) return { value: "—", hint: outside?.skipped ? "not reached" : "none shown" };
  if (certificate.daysLeft < 0) return { value: "Expired", hint: certificate.issuer, status: "danger" };
  const days = `${certificate.daysLeft} ${certificate.daysLeft === 1 ? "day" : "days"}`;
  if (!certificate.authorized) return { value: days, hint: "not trusted", status: "warning" };
  return { value: days, hint: certificate.issuer, status: certificate.daysLeft <= 14 ? "warning" : "good" };
}

function probeWords(probe: DomainProbe | null, nothingToAsk: string): Figure {
  if (!probe) return { value: "—", hint: nothingToAsk };
  if (probe.skipped) return { value: "Not tried", hint: probe.skipped, status: "warning" };
  if (probe.outcome === "answered") {
    const status = probe.status ?? 0;
    const fine = status < 400 || status === 401 || status === 403;
    return { value: `HTTP ${status}`, hint: probe.ms === null ? null : `${probe.ms} ms${probe.server ? ` · ${probe.server}` : ""}`, status: fine ? "good" : status >= 500 ? "danger" : "warning" };
  }
  if (probe.outcome === "timeout") return { value: "No answer", hint: probe.error, status: "danger" };
  if (probe.outcome === "refused") return { value: "Refused", hint: "nothing is listening", status: "danger" };
  return { value: "Failed", hint: probe.error, status: "danger" };
}

function backupWords(backup: DomainBackup | null, clock: number): Figure {
  if (!backup) return { value: "—", hint: "no app behind it" };
  if (backup.state === "ok") return { value: relativeTime(backup.newestAt, clock) ?? "Backed up", hint: backup.scheduled ? "on a schedule" : "no schedule", status: backup.scheduled ? "good" : "warning" };
  if (backup.state === "stale") return { value: "Stale", hint: `last ${relativeTime(backup.newestAt, clock) ?? "a while ago"}`, status: "warning" };
  if (backup.state === "never") return { value: "Never", hint: "no backup yet", status: "warning" };
  if (backup.state === "none") return { value: "No data", hint: "nothing to back up", status: "neutral" };
  return { value: "—", hint: "not read", status: "unknown" };
}

function tunnelWords(tunnel: TunnelFacts | null, clock: number): Figure {
  if (!tunnel?.installed) return { value: "Not installed", hint: "the Cloudflare Tunnel app", status: "neutral" };
  if (!tunnel.running) return { value: "Stopped", hint: tunnel.status ?? "not running", status: "danger" };
  if (tunnel.connections === 0) return { value: "Not connected", hint: tunnel.lastProblem ?? "no connection to Cloudflare", status: "danger" };
  const since = relativeTime(tunnel.since, clock);
  return { value: tunnel.connections === null ? "Running" : "Connected", hint: [tunnel.connections !== null ? `${tunnel.connections} ${tunnel.connections === 1 ? "connection" : "connections"}` : null, since && since.endsWith(" ago") ? `for ${since.slice(0, -4)}` : null].filter(Boolean).join(" · ") || "the Cloudflare Tunnel app", status: "good" };
}

const percent = (value: number | null) => (value === null ? "—" : `${value}%`);

function FigureCell({ figure }: { figure: Figure }) {
  return (
    <span className="hosted-figure">
      <span className={`hosted-figure__value${figure.status ? "" : " hosted-dim"}`}>{figure.status ? <StatusChip status={figure.status}>{figure.value}</StatusChip> : figure.value}</span>
      {figure.hint && <span className="hosted-figure__hint">{figure.hint}</span>}
    </span>
  );
}

export interface HostedPageProps {
  csrfToken: string;
  /** Who is signed in: the facts are everyone's; a viewer gets no buttons, and the cadence is the owner's. */
  role?: string;
  /** The clock, for "checked 3 minutes ago"; a test holds it still. */
  now?: () => number;
}

export default function HostedPage({ csrfToken, role = "owner", now = Date.now }: HostedPageProps) {
  const [status, setStatus] = useState<HostedStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);
  const canChange = role === "owner" || role === "operator";

  const read = useCallback(async (fresh = false) => {
    if (fresh) setChecking(true); else setLoading(true);
    try {
      const body = await readJson<HostedStatus>(await fetch(`/api/v1/hosted-domains${fresh ? "?fresh=1" : ""}`));
      if (!isHostedStatus(body)) throw new Error("The hosted domains came back in a shape this page cannot read.");
      setStatus(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The hosted domains could not be read");
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);
  useEffect(() => { void read(); }, [read]);
  // The first round after a start is still running: read again shortly, until it has an answer.
  useEffect(() => {
    if (!status || (!status.checking && status.checkedAt)) return undefined;
    const timer = window.setTimeout(() => { void read(); }, 4000);
    return () => window.clearTimeout(timer);
  }, [status, read]);

  const send = useCallback(async <T,>(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), "X-BoxPilot-CSRF": csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    return readJson<T>(response);
  }, [csrfToken]);

  const remove = async (hostname: string) => {
    setRemoving(hostname);
    try {
      await send("DELETE", `/api/v1/hosted-domains/manual/${encodeURIComponent(hostname)}`);
      setNotice({ tone: "success", text: `${hostname} is no longer watched.` });
      setOpen((current) => (current === hostname ? null : current));
      await read();
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : `${hostname} could not be removed` });
    } finally {
      setRemoving(null);
    }
  };

  const setCadence = async (minutes: number) => {
    setSavingInterval(true);
    try {
      const saved = await send<{ intervalMinutes: number }>("PUT", "/api/v1/hosted-domains/settings", { intervalMinutes: minutes });
      setStatus((current) => (current ? { ...current, intervalMinutes: saved.intervalMinutes } : current));
      setNotice({ tone: "success", text: `The names are checked every ${saved.intervalMinutes} minutes from now on.` });
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "The cadence could not be changed" });
    } finally {
      setSavingInterval(false);
    }
  };

  const clock = now();
  const domains = useMemo(() => status?.domains ?? [], [status]);
  const down = domains.filter((domain) => domain.state === "down").length;
  const degraded = domains.filter((domain) => domain.state === "degraded").length;
  const unchecked = domains.filter((domain) => domain.state === "unknown").length;
  const tunnel = tunnelWords(status?.tunnel ?? null, clock);
  const checked = relativeTime(status?.checkedAt, clock);

  const verdict: { status: Status; label: string } = error && !status ? { status: "unknown", label: "Not read" }
    : !status ? { status: "unknown", label: "Reading…" }
      : !domains.length ? (status.checkedAt ? { status: "neutral", label: "No domains" } : { status: "unknown", label: "Checking…" })
        : down ? { status: "danger", label: `${down} down` }
          : degraded ? { status: "warning", label: `${degraded} ${degraded === 1 ? "needs" : "need"} a look` }
            : unchecked === domains.length ? { status: "unknown", label: "Not checked" }
              : { status: "good", label: "All up" };

  const columns: Array<TableColumn<HostedDomain>> = [
    {
      id: "domain", header: "Domain", sortValue: (domain) => domain.hostname, cell: (domain) => (
        <span className="hosted-domain">
          <span className="hosted-domain__name">
            <a href={domain.url} target="_blank" rel="noreferrer">{domain.hostname}</a>
            {domain.manual && <Tag title="Added by hand on this page">watched</Tag>}
            {domain.wildcard && <Tag tone="neutral">wildcard</Tag>}
          </span>
          <span className="hosted-domain__about">
            {domain.appName ? <span>{domain.appName}{domain.app?.running === false ? " (stopped)" : ""}</span> : domain.label ? <span>{domain.label}</span> : null}
            {domain.service && <code>{domain.service}</code>}
            <span>{domain.sources.map((source) => sourceWords[source]).join(", ")}</span>
          </span>
          {domain.advice && domain.state !== "up" && <p className={`hosted-advice${domain.state === "down" ? " hosted-advice--down" : ""}`}>{domain.advice}</p>}
        </span>
      ),
    },
    { id: "state", header: "Status", sortValue: (domain) => stateRank[domain.state], cell: (domain) => <StatusChip status={stateWords[domain.state].status} title={domain.headline}>{stateWords[domain.state].label}</StatusChip> },
    { id: "dns", header: "DNS", hideOnPhone: true, cell: (domain) => <FigureCell figure={dnsWords(domain.dns, domain.expect)} /> },
    { id: "certificate", header: "Certificate", sortValue: (domain) => domain.certificate?.daysLeft ?? null, cell: (domain) => <FigureCell figure={certificateWords(domain.certificate, domain.outside)} /> },
    { id: "outside", header: "From the internet", sortValue: (domain) => domain.outside?.ms ?? null, cell: (domain) => <FigureCell figure={probeWords(domain.outside, "not asked")} /> },
    { id: "inside", header: "On this server", hideOnPhone: true, sortValue: (domain) => domain.inside?.ms ?? null, cell: (domain) => <FigureCell figure={probeWords(domain.inside, "nowhere to ask")} /> },
    { id: "uptime", header: "Up 24 h / 7 d", numeric: true, hideOnPhone: true, sortValue: (domain) => domain.uptime.day ?? null, cell: (domain) => <FigureCell figure={{ value: `${percent(domain.uptime.day)} / ${percent(domain.uptime.week)}`, hint: `${domain.uptime.checks} ${domain.uptime.checks === 1 ? "check" : "checks"}` }} /> },
    { id: "backup", header: "Backup", hideOnPhone: true, cell: (domain) => <FigureCell figure={backupWords(domain.backup, clock)} /> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "hosted-actions-cell", cell: (domain) => (
        <span className="hosted-actions">
          <Button variant="ghost" onClick={() => setOpen(domain.hostname)} aria-label={`Details of ${domain.hostname}`}>Details</Button>
          {canChange && domain.manual && <Button variant="ghost" onClick={() => void remove(domain.hostname)} busy={removing === domain.hostname} aria-label={`Stop watching ${domain.hostname}`}>Remove</Button>}
        </span>
      ),
    },
  ];

  const strip: KeyValueItem[] = status ? [
    { id: "tunnel", label: "Tunnel", value: tunnel.value, status: tunnel.status, hint: tunnel.hint ?? undefined },
    { id: "cloudflare", label: "Cloudflare", value: status.tunnel?.cloudflare?.connected ? status.tunnel.cloudflare.tunnelName ?? "Connected" : "Not connected", mono: Boolean(status.tunnel?.cloudflare?.connected), status: status.tunnel?.cloudflare?.connected ? "good" : "neutral", hint: status.tunnel?.cloudflare?.connected ? "the tunnel BoxPilot manages" : "connect from the Cloudflare Tunnel app" },
    { id: "checks", label: "Checks", value: `every ${status.intervalMinutes} min`, mono: true, hint: status.checking ? "checking now" : status.nextCheckAt ? `next ${relativeTime(status.nextCheckAt, clock) ?? "soon"}` : checked ? `last ${checked}` : "not yet" },
    { id: "alerts", label: "Alerts", value: status.alertsTarget ? "On" : "No target", status: status.alertsTarget ? "good" : "warning", hint: status.alertsTarget ? "a name down, or a certificate inside 14 days" : "set one under Settings, Alerts" },
  ] : [];

  const opened = open ? domains.find((domain) => domain.hostname === open) ?? null : null;

  return (
    <div className="hosted-page">
      <PageHeader
        title="Hosted domains"
        status={verdict}
        meta={status ? <>
          <b>{domains.length}</b> {domains.length === 1 ? "domain" : "domains"} · tunnel {tunnel.value.toLowerCase()} · checked {checked ?? "never"} · every <b>{status.intervalMinutes}</b> min
        </> : undefined}
        actions={<>
          {canChange && <Button variant="ghost" onClick={() => void read(true)} busy={checking}>Check now</Button>}
          {canChange && <Button onClick={() => setAdding(true)}>Add a domain…</Button>}
          <Button variant="ghost" onClick={() => void read()} busy={loading && Boolean(status)}>Read again</Button>
        </>}
        about={<>
          <p>Every public name this server answers for, and whether it does.</p>
          <p>The names come from what BoxPilot already knows: the apps it published through the Cloudflare tunnel, a cloudflared config, Nginx Proxy Manager's sites, and installed apps that say their public address. For each, BoxPilot checks DNS, the certificate, an answer from the internet's side and one from inside, the tunnel, and the app's backups, on the cadence set here. A name down twice running, or a certificate inside its last fortnight, is pushed through your alerts once.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The hosted domains could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>}
      {status?.problem && <Notice tone="warning" title="Not every name could be read">{status.problem}</Notice>}
      {notice && <Notice tone={notice.tone} live onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {status && <KeyValue layout="strip" className="hosted-strip" items={strip} />}

      <Panel
        className="hosted-domains"
        title="Domains"
        count={status ? domains.length : undefined}
        meta={status ? (down ? `${down} down · ${degraded} to look at` : degraded ? `${degraded} to look at` : domains.length ? "all answering" : undefined) : undefined}
        actions={role === "owner" && status ? (
          <label className="hosted-interval">Check every
            <Select aria-label="Check every" options={status.intervals.map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }))} value={String(status.intervalMinutes)} disabled={savingInterval} onValueChange={(value) => void setCadence(Number(value))} />
          </label>
        ) : undefined}
      >
        <Table
          caption="Public names this server answers for"
          columns={columns}
          rows={domains}
          rowKey={(domain) => domain.hostname}
          rowStatus={(domain) => (domain.state === "down" ? "danger" : domain.state === "degraded" ? "warning" : undefined)}
          defaultSort={{ column: "state", direction: "ascending" }}
          empty={!status
            ? (loading ? "Reading the names…" : "The names could not be read.")
            : !status.checkedAt && status.checking
              ? "Checking the names for the first time…"
              : <EmptyState title="No public names found" action={canChange ? <Button onClick={() => setAdding(true)}>Add a domain…</Button> : undefined}>BoxPilot finds the apps it published through the Cloudflare tunnel, a cloudflared config, Nginx Proxy Manager's sites, and apps that say their public address. Add anything else by hand.</EmptyState>}
        />
      </Panel>

      {opened && (
        <Sheet kicker="Domain" title={opened.hostname} side="right" onClose={() => setOpen(null)} footer={canChange && opened.manual ? <Button variant="ghost" onClick={() => void remove(opened.hostname)} busy={removing === opened.hostname}>Stop watching</Button> : undefined}>
          <DomainDetails domain={opened} clock={clock} />
        </Sheet>
      )}

      {adding && <AddDomainSheet onClose={() => setAdding(false)} send={send} onAdded={(hostname) => { setAdding(false); setNotice({ tone: "success", text: `${hostname} is watched from the next check.` }); void read(); }} />}
    </div>
  );
}

/** A name's every fact, and what to do about it, in the sheet. */
function DomainDetails({ domain, clock }: { domain: HostedDomain; clock: number }) {
  const words = stateWords[domain.state];
  const dns = dnsWords(domain.dns, domain.expect);
  const certificate = certificateWords(domain.certificate, domain.outside);
  const outside = probeWords(domain.outside, "not asked");
  const inside = probeWords(domain.inside, "nowhere to ask");
  const backup = backupWords(domain.backup, clock);
  const ends = domain.certificate?.validTo ? new Date(domain.certificate.validTo).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  const items: KeyValueItem[] = [
    { id: "state", label: "Status", value: words.label, status: words.status },
    { id: "url", label: "Address", value: <a className="hosted-link" href={domain.url} target="_blank" rel="noreferrer">{domain.url}</a>, mono: true },
    { id: "app", label: "App", value: domain.appName ?? domain.label ?? "Not known", hint: domain.app ? (domain.app.installed ? (domain.app.running ? "running" : "stopped") : "not installed") : domain.service ? undefined : "nothing on this server is tied to it" },
    { id: "service", label: "Answered here at", value: domain.service ?? "—", mono: true, hint: domain.service ? "where the tunnel sends visitors" : "not known" },
    { id: "dns", label: "DNS", value: dns.value, status: dns.status, hint: domain.dns?.addresses.length ? domain.dns.addresses.join(", ") : dns.hint ?? undefined },
    { id: "certificate", label: "Certificate", value: certificate.value, status: certificate.status, hint: [ends ? `until ${ends}` : null, domain.certificate?.issuer ?? null, domain.certificate && !domain.certificate.authorized ? "not trusted" : null].filter(Boolean).join(" · ") || certificate.hint || undefined },
    { id: "outside", label: "From the internet", value: outside.value, status: outside.status, hint: outside.hint ?? undefined },
    { id: "inside", label: "On this server", value: inside.value, status: inside.status, hint: inside.hint ?? undefined },
    { id: "uptime", label: "Up over 24 h / 7 d", value: `${percent(domain.uptime.day)} / ${percent(domain.uptime.week)}`, mono: true, hint: `${domain.uptime.checks} ${domain.uptime.checks === 1 ? "check" : "checks"} kept` },
    { id: "backup", label: "Backup", value: backup.value, status: backup.status, hint: backup.hint ?? undefined },
    { id: "checked", label: "Last checked", value: relativeTime(domain.checkedAt, clock) ?? "never", hint: domain.checkedAt ? new Date(domain.checkedAt).toLocaleString() : undefined },
  ];
  return (
    <div className="hosted-sheet">
      {domain.advice && domain.state !== "up"
        ? <Notice tone={domain.state === "down" ? "danger" : "warning"} title={domain.headline}>{domain.advice}</Notice>
        : <Notice tone="success" title="Up">Resolves, answers from the internet and from this server, and its certificate is good.</Notice>}
      <KeyValue layout="rows" items={items} />
      <p className="hosted-sheet__sources hosted-note">Found by {domain.sources.map((source) => <Tag key={source}>{sourceWords[source]}</Tag>)}</p>
    </div>
  );
}

/** A name nothing found, added by hand: the name, and what BoxPilot can say about it on this server. */
function AddDomainSheet({ onClose, send, onAdded }: { onClose: () => void; send: <T,>(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown) => Promise<T>; onAdded: (hostname: string) => void }) {
  const [hostname, setHostname] = useState("");
  const [service, setService] = useState("");
  const [appId, setAppId] = useState("");
  const [label, setLabel] = useState("");
  const [expectedAddress, setExpectedAddress] = useState("");
  const [apps, setApps] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch("/api/v1/catalog?view=summary").then((response) => (response.ok ? response.json() : null)).then((body: { applications?: Array<{ manifest: { id: string; name: string }; live?: { installed?: boolean } }> } | null) => {
      if (gone || !body?.applications) return;
      setApps(body.applications.filter((entry) => entry.live?.installed).map((entry) => ({ id: entry.manifest.id, name: entry.manifest.name })).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, []);
  const ready = hostname.trim().length > 0 && !saving;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      const added = await send<{ added: string }>("POST", "/api/v1/hosted-domains/manual", { hostname: hostname.trim(), service: service.trim() || null, appId: appId || null, label: label.trim() || null, expectedAddress: expectedAddress.trim() || null });
      onAdded(added.added);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The name could not be added");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet kicker="Watch a name" title="Add a domain" side="center" size="sm" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!ready} busy={saving} onClick={() => void submit()}>Add</Button>
    </>}>
      <form className="hosted-form" onSubmit={(event) => void submit(event)}>
        {problem && <Notice tone="danger" live title="Not added">{problem}</Notice>}
        <Field label="Name" hint="The public name, as people type it: news.example.com." required>
          <TextInput mono autoFocus placeholder="news.example.com" value={hostname} onValueChange={setHostname} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Answered on this server at" hint="Where the tunnel or proxy sends visitors here, so BoxPilot can ask the app directly too: http://127.0.0.1:4321." optional>
          <TextInput mono placeholder="http://127.0.0.1:4321" value={service} onValueChange={setService} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="App" hint="The installed app behind it, for its backups and whether it is running." optional>
          <Select options={apps.map((app) => ({ value: app.id, label: app.name }))} placeholder="None" value={appId} onValueChange={setAppId} />
        </Field>
        <Field label="Label" hint="A few words, when there is no app to name it by." optional>
          <TextInput placeholder="The site" value={label} onValueChange={setLabel} autoComplete="off" />
        </Field>
        <Field label="Should resolve to" hint="Only for a name not behind Cloudflare: the address its DNS record should hold." optional>
          <TextInput mono placeholder="203.0.113.7" value={expectedAddress} onValueChange={setExpectedAddress} autoComplete="off" spellCheck={false} />
        </Field>
      </form>
    </Sheet>
  );
}
