import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { onPageRefresh } from "../../shell/refresh";
import { useOperation } from "../../shell/ApproveDialog";
import { countOf } from "../../data";
import { relativeTime } from "../../home/format";
import { inspectOperation } from "../../operations";
import { openView } from "../../activityEvents";
import { Button, EmptyState, Field, KeyValue, Notice, PageHeader, Panel, Select, Sheet, StatusChip, Table, Tabs, Tag, TextInput, mayStart, riskOf, useUrlParam, type Status, type TableColumn, type TagTone } from "../../ui";
import { FirewallBruteForce, fail2banVerdict } from "./FirewallBruteForce";
import { FirewallProfileSheet, type ProfileChoice } from "./FirewallProfileSheet";
import { spec, type Advice, type Fail2banState, type FirewallRule, type Overview, type Plan, type PlanStep, type ProtectedRule } from "./types";

import "./firewall.css";

/** Where a rule lets traffic in from, as the page says it (M90): this LAN, the tailnet, a range, or anywhere. */
type Sources = { lan: string | null; tailnet: string[] };
function fromWords(source: string | null | undefined, sources: Sources): string {
  if (!source) return "anywhere";
  if (source === sources.lan) return `this LAN (${source})`;
  if (sources.tailnet.includes(source)) return `your tailnet (${source})`;
  return source;
}

/** Who a rule is about, in the preview's words: a rule from anywhere also reaches a public IPv6 address. */
function whoWords(source: string | null | undefined, sources: Sources): string {
  if (!source) return "any device that can reach this server, including over its public IPv6 address if it has one";
  if (source === sources.lan) return `devices on this LAN (${source})`;
  if (sources.tailnet.includes(source)) return `devices on your tailnet (${sources.tailnet.join(" and ")})`;
  return `addresses in ${source}`;
}

/**
 * What a rule change means for the people on the network (M50): the preview used to be the ufw
 * command alone, so deleting a rule never said who loses access. M90: and from where. "Opens port
 * 8096 to devices on your network" was said of `ufw allow 8096/tcp`, which lets in anyone.
 */
function ruleWords(action: string | undefined, portSpec: string, { deleting, comment, source = null, sources }: { deleting: boolean; comment?: string | null; source?: string | null; sources: Sources }): string {
  const note = comment ? ` (${comment})` : "";
  const who = whoWords(source, sources);
  if (deleting) {
    if (action === "deny") return `Port ${portSpec} is no longer blocked for ${who}${note}.`;
    if (action === "limit") return `Port ${portSpec} is no longer rate-limited for ${who}${note}; it stays open to them.`;
    return `${who[0].toUpperCase()}${who.slice(1)} can no longer reach port ${portSpec}${note}, unless another rule lets them.`;
  }
  if (action === "deny") return `Blocks port ${portSpec} for ${who}.`;
  if (action === "limit") return `Rate-limits port ${portSpec} for ${who}: up to 6 new connections per 30 seconds per address, the rest dropped. It replaces a plain allow for the same port.`;
  return `Opens port ${portSpec} to ${who}.`;
}

/** The ufw words for a rule, as the root task writes them (ruleTarget in server/firewall-profiles.mjs). */
function ufwWords(action: string | undefined, port: number, protocol: string | undefined, source: string | null | undefined): string {
  if (!source) return `${action} ${spec(port, protocol)}`;
  return `${action} from ${source} to any port ${port}${protocol && protocol !== "any" ? ` proto ${protocol}` : ""}`;
}

/**
 * Whether SSH is rate-limited now: a plain `limit` rule (from anywhere, every interface) on an SSH
 * port, which is what the profile's "Rate-limit SSH" writes and the one-click suggestion adds. The
 * SSH ports are the protected list's; 22 when it names none.
 */
function sshIsRateLimited(rules: FirewallRule[], protectedRules: ProtectedRule[]): boolean {
  const sshPorts = protectedRules.filter((entry) => entry.kind === "ssh" || entry.label === "SSH").map((entry) => entry.port);
  const ports = sshPorts.length ? sshPorts : [22];
  return rules.some((rule) => rule.action === "limit" && typeof rule.port === "number" && ports.includes(rule.port)
    && (rule.protocol === "tcp" || rule.protocol === "any") && !rule.source && !rule.interface && !rule.destination && !rule.app && rule.direction !== "out");
}

/**
 * Why the Rules tab offers no Delete on a rule (M90): it used to show nothing, and a rule limited to
 * one range looked like it had been forgotten. Delete names a port rule by port, protocol and source.
 */
function notDeletableReason(rule: FirewallRule): { short: string; long: string } | null {
  if (rule.raw) return { short: "not read", long: "BoxPilot could not read this rule. Change it with ufw over SSH." };
  if (rule.direction === "out") return { short: "outgoing", long: "An outgoing rule. BoxPilot deletes incoming rules only; change it with ufw over SSH." };
  if (rule.interface) return { short: `on ${rule.interface}`, long: `Tied to the ${rule.interface} interface. BoxPilot deletes port rules only; change it with ufw over SSH.` };
  if (rule.app) return { short: "app profile", long: `Names the ufw application profile ${rule.app}. Change it with ufw over SSH.` };
  if (rule.destination) return { short: "one address", long: `For ${rule.destination} on this server only. Change it with ufw over SSH.` };
  if (rule.port === null || rule.port === undefined) return { short: "no port", long: "Not a rule for one port. Change it with ufw over SSH." };
  return null;
}

/*
 * Firewall (M33.10), rebuilt on the kit with every feature the Classic page had. Facts first: on or
 * off, the default policy, the rules and the bans in the header; then three tabs for its three
 * jobs: what to do about it (suggestions, the profile in force, what always stays open), the rules
 * themselves, and brute-force protection for SSH. Choosing a profile and adding a rule are forms,
 * so they open in sheets; every action carries its tier and is left out for a role that cannot
 * start it. Banned addresses stay visible to every role (ADR-003 addendum).
 */

type Tab = "overview" | "rules" | "bans";
const tabIds: readonly Tab[] = ["overview", "rules", "bans"];

const levelWords: Record<Advice["level"], { label: string; tone: TagTone; status: Status }> = {
  action: { label: "Do this", tone: "danger", status: "danger" },
  warn: { label: "Heads-up", tone: "warning", status: "warning" },
  info: { label: "Tip", tone: "neutral", status: "neutral" },
};

const actionStatus = (action?: string): Status => (action === "allow" ? "good" : action === "limit" ? "warning" : "danger");

/** What a suggestion's one-click rule change does, for one that names no label: "Remove 53/tcp", "Allow 53/tcp". */
function operationWords(entry: Advice): string {
  const { action, port, protocol } = (entry.parameters ?? {}) as { action?: string; port?: number; protocol?: string };
  if (entry.operationId === "firewall.rule.delete") return port ? `Remove ${spec(port, protocol)}` : "Remove the rule";
  if (entry.operationId === "firewall.rule.add" && action && port) return `${action === "limit" ? "Rate-limit" : `${action[0].toUpperCase()}${action.slice(1)}`} ${spec(port, protocol)}`;
  return "Do it";
}
const ruleActions = ["allow", "deny", "limit"];

export interface FirewallPageProps {
  csrfToken: string;
  /** Who is signed in: the facts are everyone's, the buttons only for a role that may start them. */
  role?: string;
  /** The clock, for "applied 3 days ago"; a test holds it still. */
  now?: () => number;
}

interface IndexedRule { rule: FirewallRule; index: number }

export default function FirewallPage({ csrfToken, role = "owner", now = Date.now }: FirewallPageProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fail2ban, setFail2ban] = useState<Fail2banState | null>(null);
  const [fail2banError, setFail2banError] = useState<string | null>(null);
  const [tab, setTab] = useUrlParam<Tab>("tab", tabIds, "overview");
  const [sheet, setSheet] = useState<"profile" | "rule" | null>(null);
  const [choice, setChoice] = useState<ProfileChoice>({ profileId: null, services: [], sshRateLimit: false, replace: false });
  const [choiceTouched, setChoiceTouched] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [ruleAction, setRuleAction] = useState("allow");
  const [rulePort, setRulePort] = useState("");
  const [ruleProtocol, setRuleProtocol] = useState("tcp");
  const [ruleComment, setRuleComment] = useState("");
  /** "lan", "tailnet" or "anywhere"; null until the owner picks, so the default can follow the action. */
  const [ruleFrom, setRuleFrom] = useState<string | null>(null);
  /** The plan for the choice in the sheet, with the query it answers, so the sheet can say what it closes (M90). */
  const [sheetPlan, setSheetPlan] = useState<{ query: string; steps: PlanStep[] } | null>(null);

  const readFail2ban = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Fail2banState>("fail2ban.inspect");
      if (typeof result?.installed !== "boolean" || !result.config) throw new Error("Brute-force protection came back in a shape this page cannot read.");
      setFail2ban(result);
      setFail2banError(null);
    } catch (requestError) {
      setFail2banError(requestError instanceof Error ? requestError.message : "fail2ban could not be read");
    }
  }, []);

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    // A quiet read (a job ended somewhere) changes nothing but the facts: Check again does not spin,
    // and what is on screen, an error included, stays until the answer is in.
    if (!quiet) setLoading(true);
    void readFail2ban();
    try {
      const response = await fetch("/api/v1/firewall/overview");
      const body = (await response.json().catch(() => null)) as (Overview & { error?: string }) | null;
      if (!response.ok) throw new Error(body?.error ?? "The firewall could not be read");
      if (!body || !Array.isArray(body.profiles) || !Array.isArray(body.advice)) throw new Error("The firewall came back in a shape this page cannot read.");
      setOverview(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The firewall could not be read");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [readFail2ban]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The bar's Refresh is Check again; a job ending anywhere (Activity, the command bar, a schedule) reads it again quietly.
  useEffect(() => onPageRefresh({ asked: () => refresh(), job: () => refresh({ quiet: true }) }), [refresh]);

  // The profile sheet starts from what is in force, until the owner changes it themselves.
  // M90 review: rate-limited SSH is read from the rules, not the last profile apply, so a one-click
  // `limit 22/tcp` since then is kept by the next apply instead of being turned back into an allow.
  useEffect(() => {
    if (!overview || choiceTouched) return;
    setChoice({
      profileId: overview.current?.id ?? overview.profiles.find((profile) => profile.recommended)?.id ?? overview.profiles[0]?.id ?? null,
      services: overview.current?.services ?? [],
      sshRateLimit: overview.report ? sshIsRateLimited(overview.report.rules ?? [], overview.protected ?? []) : Boolean(overview.current?.sshRateLimit),
      replace: false,
    });
  }, [overview, choiceTouched]);

  // Only the change that took clears its own form: a suggestion's rule, the firewall switch or a
  // brute-force change ending used to wipe a half-typed rule and the profile being chosen.
  const { start, dialog } = useOperation(csrfToken, (job) => {
    if (job.state === "completed" && job.type === "op:firewall.rule.add" && String(job.parameters?.port ?? "") === rulePort.trim()) { setRulePort(""); setRuleComment(""); setRuleFrom(null); }
    if (job.state === "completed" && job.type === "op:firewall.profile.apply") setChoiceTouched(false);
    void refresh();
  });

  const report = overview?.report ?? null;
  const protectedRules = useMemo(() => overview?.protected ?? [], [overview]);
  const isProtectedPort = useCallback((port: number | null | undefined, protocol?: string | null) => port !== null && port !== undefined && protectedRules.some((entry) => entry.port === port && (!protocol || protocol === "any" || entry.protocol === protocol)), [protectedRules]);
  const rules = report?.rules ?? [];
  const advice = overview?.advice ?? [];
  const current = overview?.current ?? null;
  const currentProfile = current ? overview?.profiles.find((profile) => profile.id === current.id) ?? null : null;
  const clock = now();
  const sources = useMemo<Sources>(() => ({ lan: overview?.sources?.lan ?? null, tailnet: overview?.sources?.tailnet ?? [] }), [overview]);
  const sourceOf = (choiceId: string): string | null => (choiceId === "lan" ? sources.lan : choiceId === "tailnet" ? sources.tailnet[0] ?? null : null);
  // Allowing defaults to this LAN when the server knows it; a deny defaults to everyone.
  const fromChoice = ruleFrom ?? (ruleAction !== "deny" && sources.lan ? "lan" : "anywhere");

  // M90: while the profile sheet is open, the plan for its choice, so the sheet can list the rules
  // applying it would close before the owner gets as far as the approval.
  const planQuery = useMemo(() => {
    const profile = sheet === "profile" ? overview?.profiles.find((entry) => entry.id === choice.profileId) : undefined;
    if (!profile) return null;
    return new URLSearchParams({ profile: profile.id, services: (profile.lockServices ? [] : choice.services).join(","), replace: String(choice.replace), sshRateLimit: String(choice.sshRateLimit) }).toString();
  }, [sheet, overview, choice]);
  useEffect(() => {
    if (!planQuery) return undefined;
    const controller = new AbortController();
    fetch(`/api/v1/firewall/plan?${planQuery}`, { signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json().catch(() => null)) as Plan | null) : null))
      .then((plan) => { if (!controller.signal.aborted && Array.isArray(plan?.steps)) setSheetPlan({ query: planQuery, steps: plan.steps }); })
      .catch(() => { /* the review says why, when the owner asks for it */ });
    return () => controller.abort();
  }, [planQuery]);
  const closing = sheetPlan && sheetPlan.query === planQuery ? sheetPlan.steps.filter((step) => step.removes) : null;

  const canToggle = mayStart(role, "firewall.set");
  const canProfile = mayStart(role, "firewall.profile.apply");
  const canAddRule = mayStart(role, "firewall.rule.add");
  const canDeleteRule = mayStart(role, "firewall.rule.delete");
  const canInstall = mayStart(role, "apt.install");

  const installUfw = () => start({ operationId: "apt.install", title: "Install ufw", parameters: { packages: ["ufw"] }, preview: <span><code>apt-get install --no-install-recommends ufw</code>. Installing does not turn it on.</span> });

  const toggleFirewall = () => {
    if (!report || report.enabled === null) return;
    start({
      operationId: "firewall.set",
      title: report.enabled ? "Turn the firewall off" : "Turn the firewall on",
      parameters: { enabled: !report.enabled },
      preview: report.enabled
        ? <span><code>ufw disable</code>. All incoming traffic is accepted afterwards.</span>
        : <span>Adds rules keeping SSH (22/tcp), Tailscale (41641/udp){overview?.web.lanExposed ? `, BoxPilot (${overview.web.port}/tcp)` : ""}, and the <code>tailscale0</code> interface reachable, then <code>ufw enable</code>. Other incoming traffic follows the default policy.</span>,
    });
  };

  const openProfiles = () => { setPlanError(null); setSheet("profile"); };

  const reviewProfile = async () => {
    const profile = overview?.profiles.find((entry) => entry.id === choice.profileId);
    if (!profile) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const services = profile.lockServices ? [] : choice.services;
      const query = new URLSearchParams({ profile: profile.id, services: services.join(","), replace: String(choice.replace), sshRateLimit: String(choice.sshRateLimit) });
      const response = await fetch(`/api/v1/firewall/plan?${query.toString()}`);
      const plan = (await response.json().catch(() => null)) as (Plan & { error?: string }) | null;
      if (!response.ok || !plan?.steps) throw new Error(plan?.error ?? "The plan could not be built");
      const closes = plan.steps.filter((step) => step.removes);
      const notes = Array.isArray(plan.notes) ? plan.notes : [];
      // The sheet closes before the approval opens: two modals would fight over focus and Escape.
      setSheet(null);
      start({
        operationId: "firewall.profile.apply",
        title: `Apply the ${profile.name} profile`,
        // M90 review: the removals shown here go with the job; the task refuses if it would close anything else.
        parameters: { profile: profile.id, services, replace: choice.replace, sshRateLimit: choice.sshRateLimit, closes: closes.flatMap((step) => (step.removes ? [{ action: step.removes.action, port: step.removes.port, protocol: step.removes.protocol, source: step.removes.source ?? null }] : [])) },
        preview: (
          <div className="firewall-plan">
            <p>Runs these ufw commands in order. The firewall ends up <strong>on</strong>; SSH, Tailscale, and BoxPilot stay reachable throughout. If any required step fails, nothing is turned on.</p>
            {notes.map((note) => <p key={note} className="firewall-plan__note">{note}</p>)}
            {closes.length > 0 && <p className="firewall-plan__closes"><strong>Closes {countOf(closes.length, "rule", "rules")}</strong> the new choice no longer keeps: {closes.map((step) => step.label).join("; ")}.</p>}
            <ol className="firewall-plan__steps">{plan.steps.map((step, index) => <li key={index}><code>ufw {step.args.join(" ")}</code><span className="firewall-plan__label">, {step.label}</span></li>)}</ol>
          </div>
        ),
      });
    } catch (requestError) {
      setPlanError(requestError instanceof Error ? requestError.message : "The plan could not be built");
    } finally {
      setPlanning(false);
    }
  };

  const followAdvice = (entry: Advice) => {
    if (entry.operationId && entry.parameters) {
      const parameters = entry.parameters as { action?: string; port?: number; protocol?: string; source?: string | null };
      start({
        operationId: entry.operationId,
        title: entry.actionLabel ?? entry.title,
        parameters: entry.parameters,
        preview: <span>{ruleWords(parameters.action, spec(parameters.port ?? 0, parameters.protocol), { deleting: entry.operationId === "firewall.rule.delete", source: parameters.source, sources })} <code>ufw {entry.operationId === "firewall.rule.delete" ? "delete " : ""}{ufwWords(parameters.action, parameters.port ?? 0, parameters.protocol, parameters.source)}</code></span>,
      });
      return;
    }
    if (entry.focus === "install") installUfw();
    else if (entry.focus === "fail2ban") setTab("bans");
    else if (entry.focus === "network") openView("network");
    else openProfiles();
  };

  /** The button a suggestion offers, when this role may follow it. */
  const adviceButton = (entry: Advice): ReactNode => {
    const primary = entry.level === "action" ? "primary" : "secondary";
    if (entry.operationId && entry.parameters) {
      if (!mayStart(role, entry.operationId)) return null;
      const main = <Button variant={primary} risk={riskOf(entry.operationId)} onClick={() => followAdvice(entry)}>{entry.actionLabel ?? operationWords(entry)}</Button>;
      const parameters = entry.parameters as { action?: string; port?: number; protocol?: string; comment?: string; source?: string | null };
      if (entry.operationId !== "firewall.rule.add" || parameters.action !== "allow" || !parameters.port) return main;
      // M90: an "Allow <app>" opens it to this LAN; From, in the add form, chooses otherwise.
      return <>{main}<Button variant="ghost" onClick={() => openRuleForm(parameters)} aria-label={`Choose where ${spec(parameters.port, parameters.protocol)} is open from`}>From…</Button></>;
    }
    if (entry.focus === "install") return canInstall ? <Button variant={primary} risk={riskOf("apt.install")} onClick={() => followAdvice(entry)}>{entry.actionLabel ?? "Install ufw"}</Button> : null;
    if (entry.focus === "fail2ban") return <Button variant="ghost" onClick={() => followAdvice(entry)}>{entry.actionLabel ?? "Set it up"}</Button>;
    if (entry.focus === "profiles") return canProfile ? <Button variant={primary} onClick={() => followAdvice(entry)}>{entry.actionLabel ?? "Choose a profile"}</Button> : null;
    if (entry.focus === "network") return <Button variant="ghost" onClick={() => followAdvice(entry)}>{entry.actionLabel ?? "Open Network"}</Button>;
    return null;
  };

  // Delete sends the action, port, protocol and (M90) source, which ufw reads as an incoming rule
  // from that source to any address here: an outgoing, interface or destination rule is not one it can name.
  const deletable = (rule: FirewallRule) => rule.deletable !== false && !notDeletableReason(rule) && ruleActions.includes(rule.action ?? "") && (rule.action === "deny" || !isProtectedPort(rule.port, rule.protocol));
  const ruleName = (rule: FirewallRule) => `${rule.action} ${spec(rule.port ?? 0, rule.protocol)} from ${fromWords(rule.source, sources)}`;
  const deleteRule = (rule: FirewallRule) => start({
    operationId: "firewall.rule.delete",
    title: `Delete ${ruleName(rule)}`,
    parameters: { action: rule.action, port: rule.port, protocol: rule.protocol ?? "any", ...(rule.source ? { source: rule.source } : {}) },
    preview: <span>{ruleWords(rule.action, spec(rule.port ?? 0, rule.protocol), { deleting: true, comment: rule.comment, source: rule.source, sources })} <code>ufw delete {ufwWords(rule.action, rule.port ?? 0, rule.protocol ?? "any", rule.source)}</code></span>,
  });

  /** Why a rule has no Delete, when it has none: kept open by BoxPilot, or not a rule Delete can name. */
  const ruleTag = (rule: FirewallRule): ReactNode => {
    if (!rule.raw && (rule.action === "allow" || rule.action === "limit") && isProtectedPort(rule.port, rule.protocol)) return <Tag title="BoxPilot keeps this open, so it cannot be deleted here">kept open</Tag>;
    const reason = notDeletableReason(rule);
    return reason ? <Tag title={reason.long}>{reason.short}</Tag> : null;
  };

  /** The add form, filled in from a suggestion, so its From can be chosen before anything is staged. */
  const openRuleForm = (parameters: { action?: string; port?: number; protocol?: string; comment?: string; source?: string | null }) => {
    setRuleAction(parameters.action ?? "allow");
    setRulePort(String(parameters.port ?? ""));
    setRuleProtocol(parameters.protocol ?? "tcp");
    setRuleComment(parameters.comment ?? "");
    setRuleFrom(null);
    setSheet("rule");
  };

  const portValue = Number.parseInt(rulePort, 10);
  const portValid = /^\d+$/.test(rulePort) && portValue >= 1 && portValue <= 65535;
  const protectedHit = ruleAction === "deny" && portValid ? protectedRules.find((entry) => entry.port === portValue && (ruleProtocol === "any" || entry.protocol === ruleProtocol)) ?? null : null;
  const addRule = () => {
    const source = sourceOf(fromChoice);
    setSheet(null);
    start({
      operationId: "firewall.rule.add",
      title: `${ruleAction === "allow" ? "Allow" : ruleAction === "deny" ? "Deny" : "Rate-limit"} port ${portValue} from ${fromWords(source, sources)}`,
      parameters: { action: ruleAction, port: portValue, protocol: ruleProtocol, ...(ruleComment.trim() ? { comment: ruleComment.trim() } : {}), ...(source ? { source } : {}) },
      preview: <span>{ruleWords(ruleAction, spec(portValue, ruleProtocol), { deleting: false, source, sources })} <code>ufw {ufwWords(ruleAction, portValue, ruleProtocol, source)}</code>{fromChoice === "tailnet" ? <>, and the same from <code>{sources.tailnet.slice(1).join(", ")}</code></> : null}</span>,
    });
  };

  const ruleColumns: Array<TableColumn<IndexedRule>> = [
    { id: "action", header: "Action", sortValue: ({ rule }) => rule.action ?? "", cell: ({ rule }) => (rule.raw ? <span className="firewall-quiet">—</span> : <StatusChip status={actionStatus(rule.action)}>{rule.action ?? "?"}</StatusChip>) },
    { id: "port", header: "Port / app", sortValue: ({ rule }) => rule.port ?? rule.app ?? rule.raw ?? "", cell: ({ rule }) => <code className="firewall-port">{rule.raw ?? rule.app ?? rule.port ?? "any"}</code> },
    { id: "protocol", header: "Protocol", cell: ({ rule }) => (rule.raw ? "—" : <code>{rule.protocol ?? "any"}</code>) },
    // M90: where a rule lets traffic in from. A LAN-only rule and one open to anywhere looked the
    // same; this is the column that tells them apart, so it stays on a phone.
    { id: "from", header: "From", sortValue: ({ rule }) => rule.source ?? "", cell: ({ rule }) => (rule.raw ? "—" : rule.source ? <code className="firewall-source" title={fromWords(rule.source, sources)}>{rule.source}{rule.source === sources.lan ? " (this LAN)" : sources.tailnet.includes(rule.source) ? " (tailnet)" : ""}</code> : <span>anywhere</span>) },
    { id: "where", header: "Where", hideOnPhone: true, cell: ({ rule }) => (rule.raw ? "—" : <>{rule.interface ? `on ${rule.interface}` : rule.direction === "out" ? "outgoing" : "incoming"}{rule.destination ? <>, to <code>{rule.destination}</code></> : null}{rule.family === "v6" ? " (IPv6)" : ""}</>) },
    { id: "comment", header: "Comment", cell: ({ rule }) => (rule.comment ? <span className="firewall-comment">{rule.comment}</span> : <span className="firewall-quiet">—</span>) },
    {
      id: "delete", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "firewall-actions-cell", cell: ({ rule }) => (
        <span className="firewall-actions">
          {canDeleteRule && deletable(rule) && <Button risk={riskOf("firewall.rule.delete")} onClick={() => deleteRule(rule)} aria-label={`Delete ${ruleName(rule)}`}>Delete</Button>}
          {ruleTag(rule)}
        </span>
      ),
    },
  ];

  const protectedColumns: Array<TableColumn<Overview["protected"][number]>> = [
    { id: "port", header: "Port", cell: (entry) => <code className="firewall-port">{spec(entry.port, entry.protocol)}</code> },
    { id: "what", header: "What", cell: (entry) => entry.label },
    { id: "why", header: "Why", cell: (entry) => <span className="firewall-comment">{entry.reason}</span> },
    { id: "rule", header: "Rule", hideOnPhone: true, cell: (entry) => (entry.allow ? "allowed" : <span className="firewall-quiet" title="No LAN rule is needed; it just cannot be denied">cannot be denied</span>) },
  ];

  const notInstalled = Boolean(report && !report.installed);
  const verdict = error && !overview ? { status: "unknown" as const, label: "Not read" }
    : !overview ? { status: "unknown" as const, label: "Reading…" }
      : !report ? { status: "unknown" as const, label: "Not read" }
        : notInstalled ? { status: "warning" as const, label: "Not installed" }
          : report.enabled === null ? { status: "unknown" as const, label: "State not read" }
            : report.enabled ? { status: "good" as const, label: "On" } : { status: "warning" as const, label: "Off" };
  const bans = fail2banVerdict(fail2ban);
  const actionCount = advice.filter((entry) => entry.level === "action").length;

  const overviewTab = (
    <>
      <Panel
        className="firewall-advice"
        title="Suggestions"
        count={overview ? (actionCount ? { status: "danger", label: `${actionCount} to do` } : advice.length) : undefined}
        meta="from what is listening now"
      >
        {!overview ? <p className="firewall-quiet firewall-pad">{loading ? "Reading…" : "Not read yet. Press Check again."}</p>
          : advice.length === 0 ? <EmptyState title="Nothing to suggest">The firewall is on, blocks by default, and nothing risky is open to the network.</EmptyState>
            : (
              <ul className="firewall-advice__list">
                {advice.map((entry) => {
                  const level = levelWords[entry.level];
                  return (
                    <li key={entry.id} className="firewall-advice__item ui-marked" data-status={level.status}>
                      <Tag tone={level.tone} className="firewall-advice__level">{level.label}</Tag>
                      <span className="firewall-advice__words">
                        <span className="firewall-advice__title">{entry.title}</span>
                        <span className="firewall-advice__detail">{entry.detail}</span>
                      </span>
                      <span className="firewall-advice__action">{adviceButton(entry)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
      </Panel>

      <Panel
        padded
        className="firewall-profile"
        title="Profile"
        count={overview ? (currentProfile ? { status: "good", label: "in force" } : { status: "neutral", label: "none" }) : undefined}
        meta={current?.appliedAt ? `applied ${relativeTime(current.appliedAt, clock) ?? current.appliedAt}` : undefined}
        actions={canProfile && overview && !notInstalled ? <Button onClick={openProfiles}>Choose a profile…</Button> : undefined}
      >
        {!overview ? <p className="firewall-quiet">{loading ? "Reading…" : "Not read yet. Press Check again."}</p> : (
          <KeyValue items={[
            { id: "profile", label: "In force", value: currentProfile?.name ?? "None applied", hint: currentProfile?.summary ?? "Apply one to get sensible defaults." },
            ...(current ? [
              { id: "services", label: "Open to the LAN", value: current.services.length ? current.services.map((id) => overview.services.find((service) => service.id === id)?.name ?? id).join(", ") : "Nothing" },
              { id: "ssh", label: "SSH logins", value: current.sshRateLimit ? "Rate-limited" : "Not limited" },
            ] : []),
          ]} />
        )}
      </Panel>

      <Panel className="firewall-kept" title="Always kept open" count={protectedRules.length || undefined} footer="These cannot be denied or deleted from BoxPilot, so a profile or a typo can never lock you out.">
        <Table caption="Ports BoxPilot always keeps open" columns={protectedColumns} rows={protectedRules} rowKey={(entry) => `${entry.port}/${entry.protocol}`} empty={overview ? "No ports are kept open." : "Reading…"} />
      </Panel>
    </>
  );

  const rulesTab = (
    <Panel
      className="firewall-rules"
      title="Rules"
      count={report ? rules.length : undefined}
      meta={report?.defaults ? <>default in <b>{report.defaults.incoming ?? "?"}</b> · out <b>{report.defaults.outgoing ?? "?"}</b></> : undefined}
      actions={canAddRule && report?.installed ? <Button onClick={() => setSheet("rule")}>Add a rule…</Button> : undefined}
    >
      <Table
        caption="Firewall rules from ufw"
        columns={ruleColumns}
        rows={rules.map((rule, index) => ({ rule, index }))}
        rowKey={({ index }) => String(index)}
        rowStatus={({ rule }) => (rule.action === "deny" || rule.action === "reject" ? "danger" : undefined)}
        empty={!report
          ? (loading ? "Reading the firewall…" : "The rules could not be read.")
          : report.enabled
            ? <EmptyState title="No rules yet">Only the default policy applies.</EmptyState>
            // Off, with nothing on the list: the one step that fills it is a profile, which turns it on too.
            : <EmptyState title="No rules yet" action={canProfile && overview ? <Button onClick={openProfiles}>Choose a profile…</Button> : undefined}>The firewall is off. A profile turns it on with the rules this server needs, keeping SSH, Tailscale and BoxPilot reachable.</EmptyState>}
      />
    </Panel>
  );

  return (
    <div className="firewall-page">
      {dialog}
      <PageHeader
        title="Firewall"
        status={verdict}
        summary={report?.enabled === false ? "All incoming traffic is accepted." : undefined}
        meta={report?.installed ? <>
          in <b>{report.defaults?.incoming ?? "?"}</b> · out <b>{report.defaults?.outgoing ?? "?"}</b> · <b>{rules.length}</b> {rules.length === 1 ? "rule" : "rules"}
          {fail2ban?.installed ? <> · fail2ban <b>{bans.label}</b>{fail2ban.currentlyBanned !== null ? <>, <b>{fail2ban.currentlyBanned}</b> banned</> : null}</> : null}
        </> : undefined}
        actions={<>
          {canToggle && report?.installed && report.enabled !== null && (
            <Button variant={report.enabled ? "secondary" : "primary"} risk={riskOf("firewall.set")} disabled={loading} onClick={toggleFirewall}>{report.enabled ? "Turn off" : "Turn on"}</Button>
          )}
          <Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(overview)}>Check again</Button>
        </>}
        about={<>
          <p>Profiles, open ports, and suggestions based on what is listening.</p>
          <p>BoxPilot drives ufw: a profile sets the defaults and opens the services you pick, rules open or close one port, and fail2ban bans addresses that keep failing SSH logins. SSH, Tailscale and BoxPilot itself always stay reachable, so no change made here can lock you out.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The firewall could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
      {overview?.reportError && !error && <Notice tone="warning" title="The firewall's rules could not be read">{overview.reportError}</Notice>}
      {planError && sheet !== "profile" && <Notice tone="danger" live title="The plan could not be built" onDismiss={() => setPlanError(null)}>{planError}</Notice>}

      {notInstalled ? (
        <Panel title="The firewall" count={{ status: "warning", label: "not installed" }}>
          <EmptyState title="The firewall is not installed" action={canInstall ? <Button variant="primary" risk={riskOf("apt.install")} onClick={installUfw}>Install ufw</Button> : undefined}>
            Install the firewall (ufw) to manage incoming traffic from here. Installing does not turn it on.
          </EmptyState>
        </Panel>
      ) : (
        <Tabs<Tab>
          label="Firewall"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview", count: advice.length || undefined, status: actionCount ? "danger" : undefined, statusLabel: actionCount ? countOf(actionCount, "thing to do", "things to do") : undefined },
            { id: "rules", label: "Rules", count: report ? rules.length : undefined },
            { id: "bans", label: "Brute force", count: fail2ban?.currentlyBanned ?? undefined, status: bans.status === "good" ? "good" : bans.status === "warning" ? "warning" : undefined, statusLabel: `fail2ban ${bans.label}` },
          ]}
        >
          {(open) => (open === "rules" ? rulesTab
            : open === "bans" ? <FirewallBruteForce state={fail2ban} error={fail2banError} role={role} start={start} onRetry={() => void readFail2ban()} />
              : overviewTab)}
        </Tabs>
      )}

      {sheet === "profile" && overview && (
        <FirewallProfileSheet
          profiles={overview.profiles}
          services={overview.services}
          protectedRules={protectedRules}
          current={current}
          choice={choice}
          onChange={(next) => { setChoiceTouched(true); setChoice(next); }}
          onReview={() => void reviewProfile()}
          planning={planning}
          error={planError}
          closing={closing}
          onClose={() => { setSheet(null); setPlanError(null); }}
        />
      )}

      {sheet === "rule" && (
        <Sheet
          kicker="New rule"
          title="Add a rule"
          side="center"
          size="sm"
          onClose={() => setSheet(null)}
          onSubmit={() => { if (portValid && !protectedHit) addRule(); }}
          footer={<>
            <Button variant="ghost" onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="primary" type="submit" risk={riskOf("firewall.rule.add")} disabled={!portValid || Boolean(protectedHit)}>Add rule</Button>
          </>}
        >
          <div className="firewall-rule-form">
            <Field label="Action">
              <Select value={ruleAction} onValueChange={setRuleAction} options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }, { value: "limit", label: "Rate-limit" }]} />
            </Field>
            <Field label="Port" error={protectedHit ? `Port ${spec(protectedHit.port, protectedHit.protocol)} is ${protectedHit.label} and stays open: ${protectedHit.reason}` : rulePort && !portValid ? "A port from 1 to 65535." : undefined}>
              <TextInput mono inputMode="numeric" placeholder="8096" value={rulePort} onValueChange={(value) => setRulePort(value.trim())} />
            </Field>
            <Field label="Protocol">
              <Select mono value={ruleProtocol} onValueChange={setRuleProtocol} options={[{ value: "tcp", label: "tcp" }, { value: "udp", label: "udp" }, { value: "any", label: "tcp + udp" }]} />
            </Field>
            <Field label="From" hint={fromChoice === "anywhere" ? "Any device that can reach this server, including over its public IPv6 address if it has one." : fromChoice === "tailnet" ? `Devices on your tailnet: ${sources.tailnet.join(" and ")}.` : `Devices on this LAN only.`}>
              <Select value={fromChoice} onValueChange={setRuleFrom} options={[
                ...(sources.lan ? [{ value: "lan", label: `This LAN (${sources.lan})` }] : []),
                ...(sources.tailnet.length ? [{ value: "tailnet", label: "Your tailnet" }] : []),
                { value: "anywhere", label: "Anywhere" },
              ]} />
            </Field>
            <Field label="Comment" optional>
              <TextInput value={ruleComment} onValueChange={setRuleComment} placeholder="What it is for" />
            </Field>
            {ruleAction === "limit" && <p className="firewall-quiet">Allows up to 6 new connections per 30 seconds per address, then drops the rest.</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}
