import { useCallback, useEffect, useState } from "react";
import { appUrl } from "../../appLinks";
import type { AppFact } from "../../home/facts";
import { relativeTime } from "../../home/format";
import { readJson } from "../../http";
import { onRefresh } from "../../shell/refresh";
import { MetricStrip, MetricTile, Notice, Panel } from "../../ui";
import type { Status } from "../../ui/types";

/*
 * Apps Today reads (M51): one card per installed catalog app that has a reader on the server
 * (server/app-glances.mjs), drawn from what the server sends and nothing else: the card's title,
 * the window its figures cover, the figures with their tone, and where in the app each one comes
 * from. Nothing here knows which app it is drawing, so the next app with a reader gets its card
 * with no change on this side. A figure opens the app at its own page; the panel's action opens
 * the app. Shown only while BoxPilot answers: a copy kept for offline reading has no card, since
 * its figures would be yesterday's by then.
 */

export interface GlanceMetric {
  id: string;
  label: string;
  /** Null when that one read could not be made: drawn as "?", never as 0. */
  value: number | null;
  caption: string | null;
  status: Status;
  /** Where in the app the figure comes from, relative to the app's root. */
  path: string | null;
}

export interface AppGlance {
  app: string;
  name: string;
  title: string;
  window: string;
  url: { host: number; exposure: string; path?: string | null } | null;
  running: boolean;
  available: boolean;
  reason: string | null;
  since: string | null;
  readAt: string;
  metrics: GlanceMetric[];
  digest: { period: string | null; generatedAt: string | null } | null;
}

export async function readAppGlances(): Promise<AppGlance[]> {
  const body = await readJson<{ glances?: AppGlance[] }>(await fetch("/api/v1/apps/glances"));
  if (!Array.isArray(body?.glances)) throw new Error("The apps' glances were missing");
  return body.glances;
}

/** The glances, read when the page opens and again on the bar's Refresh; `reload` for Check again. */
export function useAppGlances(): { glances: AppGlance[]; reload: () => Promise<void> } {
  const [glances, setGlances] = useState<AppGlance[]>([]);
  const reload = useCallback(() => readAppGlances().then(setGlances, () => setGlances([])), []);
  useEffect(() => { void reload(); return onRefresh(() => { void reload(); }); }, [reload]);
  return { glances, reload };
}

const rank: Record<Status, number> = { good: 0, neutral: 0, unknown: 1, warning: 2, danger: 3 };

/** The panel's verdict from its figures: the worst tone, with how many figures are to act on. */
export function glanceCount(glance: AppGlance): { status: Status; label: string } {
  if (!glance.available) return { status: "unknown", label: "Not read" };
  const worst = glance.metrics.reduce<Status>((status, metric) => (rank[metric.status] > rank[status] ? metric.status : status), "neutral");
  if (worst === "unknown") return { status: "unknown", label: "Partly read" };
  if (worst === "neutral" || worst === "good") return { status: "neutral", label: "Quiet" };
  const toActOn = glance.metrics.filter((metric) => rank[metric.status] >= rank.warning).reduce((sum, metric) => sum + (metric.value ?? 0), 0);
  return { status: worst, label: `${toActOn} to look at` };
}

/** The app's root address, from the catalog's own link (which may land on its sign-in page) or the glance's port. */
export function glanceBase(glance: AppGlance, apps: AppFact[]): string | null {
  const fact = apps.find((app) => app.id === glance.app) ?? null;
  if (fact?.url) {
    try { return new URL(fact.url).origin; } catch { /* a link the browser cannot parse is no link */ }
  }
  return glance.url ? appUrl({ host: glance.url.host, exposure: glance.url.exposure }) : null;
}

export interface AppGlancePanelProps {
  glance: AppGlance;
  /** The installed apps as the catalog facts know them, for the app's address. */
  apps: AppFact[];
  clock: number;
}

export function AppGlancePanel({ glance, apps, clock }: AppGlancePanelProps) {
  const base = glanceBase(glance, apps);
  const open = (path: string | null) => {
    if (!base) return;
    window.open(`${base}${path && path !== "/" ? path : ""}`, "_blank", "noopener");
  };
  const written = glance.digest?.generatedAt ? relativeTime(glance.digest.generatedAt, clock) : null;
  const action = base ? <a className="ui-button ui-button--ghost" href={base} target="_blank" rel="noreferrer"><span className="ui-button__label">Open {glance.name}</span></a> : undefined;
  return (
    <Panel className="today-glance" title={glance.title} count={glanceCount(glance)} meta={glance.available ? glance.window : undefined} actions={action} padded>
      {glance.available
        ? (
          <MetricStrip label={`Figures for ${glance.title}`} minTile="9.5rem">
            {glance.metrics.map((metric) => (
              <MetricTile
                key={metric.id}
                label={metric.label}
                value={metric.value ?? "?"}
                caption={metric.caption ?? undefined}
                status={metric.status === "neutral" || metric.status === "good" ? undefined : metric.status}
                onSelect={base && metric.path ? () => open(metric.path) : undefined}
              />
            ))}
          </MetricStrip>
        )
        : <Notice tone="warning" title={`${glance.name} could not be read`}>{glance.reason ?? "It did not answer."}</Notice>}
      {glance.available && written && <p className="today-glance__meta">Digest written {written}.</p>}
    </Panel>
  );
}
