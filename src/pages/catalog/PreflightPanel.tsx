import { useEffect, useState } from "react";
import { inventoryFactsFrom, useOptionalFacts, type InventoryFacts, type Source } from "../../home/facts";
import { readJson } from "../../http";
import { Checkbox, KeyValue, Notice, Panel, Progress, StatusChip, Table, type TableColumn } from "../../ui";
import { checkStatus, checkWords, fitRows, fitVerdict, whereItAnswers, type DriveForecast, type FitRow, type PortReading } from "./preflight";
import type { Manifest, Values } from "./types";

/*
 * "Will it fit" (2026-11-10): what an install takes from this server, where the app will answer and
 * whether it is backed up from its first night, said in the install form before Install is pressed.
 * The arithmetic and the words are preflight.ts's; this reads the two things the form does not
 * already hold (the inventory Home reads, and Storage's forecast) and draws them on the kit.
 */

/**
 * The inventory, from the facts Home and Ops already keep when the page is drawn inside them (asked
 * to read it again, since the install is decided on it), and read directly where there are none.
 */
export function useInventory(): Source<InventoryFacts> {
  const shared = useOptionalFacts();
  const refresh = shared?.refresh;
  const [own, setOwn] = useState<Source<InventoryFacts>>({ state: "loading", value: null, error: null });
  useEffect(() => {
    if (refresh) { void refresh(["inventory"]); return undefined; }
    let active = true;
    fetch("/api/v1/inventory")
      .then((response) => readJson<Parameters<typeof inventoryFactsFrom>[0]>(response))
      .then((body) => { if (active) setOwn({ state: "ready", value: inventoryFactsFrom(body), error: null }); })
      .catch((error: unknown) => { if (active) setOwn({ state: "failed", value: null, error: error instanceof Error ? error.message : "Could not be read" }); });
    return () => { active = false; };
  }, [refresh]);
  return shared ? shared.facts.inventory : own;
}

/** When each filesystem is on track to fill, as Storage shows it. Null until read, and when it could not be: then no forecast is shown. */
function useForecasts(): DriveForecast[] | null {
  const [forecasts, setForecasts] = useState<DriveForecast[] | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/v1/storage/forecast")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { forecasts?: Array<Partial<DriveForecast>> } | null) => {
        if (!active || !Array.isArray(body?.forecasts)) return;
        setForecasts(body.forecasts.filter((forecast): forecast is DriveForecast => typeof forecast?.target === "string" && typeof forecast.daysToFull === "number" && Number.isFinite(forecast.daysToFull)));
      })
      .catch(() => { /* a forecast is an extra: without it the row says only what is free */ });
    return () => { active = false; };
  }, []);
  return forecasts;
}

export interface PreflightPanelProps {
  manifest: Manifest;
  /** The install form as it is filled in. */
  values: Values;
  /** What the server's precheck said about the form's ports. */
  ports: PortReading;
  /** This server's addresses as the catalog read them. */
  host: { lanAddress: string | null; tailscaleDnsName: string | null };
  appNameFor: (id: string) => string | null;
  /**
   * The nightly backup, for an app that holds data and a role that may back it up; null otherwise.
   * `already` is the cadence of a backup schedule this app has from before.
   */
  nightly: { checked: boolean; onChange: (checked: boolean) => void; time: string; already: string | null } | null;
}

const columns: Array<TableColumn<FitRow>> = [
  { id: "item", header: "Item", cell: (row) => <span className="catalog-preflight__item">{row.item}</span> },
  { id: "now", header: "In use now", cell: (row) => row.usedNow },
  { id: "adds", header: "This adds", cell: (row) => row.adds },
  {
    id: "scale", header: "Scale", hideOnPhone: true, className: "catalog-preflight__scale",
    // Cyan is what is measured; amber and red only once it is thin.
    cell: (row) => (row.scale ? <Progress hideLabel label={row.scale.words} value={row.scale.percent} status={row.scale.status === "good" ? undefined : row.scale.status} /> : row.scaleWords ?? ""),
  },
  { id: "left", header: "Left after", cell: (row) => <>{row.leftAfter}{row.leftHint && <span className="catalog-preflight__hint">{row.leftHint}</span>}</> },
  { id: "check", header: "Check", cell: (row) => <StatusChip status={checkStatus[row.check]}>{checkWords[row.check]}</StatusChip> },
];

export function PreflightPanel({ manifest, values, ports, host, appNameFor, nightly }: PreflightPanelProps) {
  const inventory = useInventory();
  const forecasts = useForecasts();
  const pending = inventory.state === "idle" || inventory.state === "loading";
  const rows = fitRows({ manifest, values, inventory: inventory.value, inventoryPending: pending, forecasts, ports, appName: appNameFor });
  const verdict = fitVerdict(rows);
  const noted = (check: FitRow["check"]) => rows.filter((row) => row.check === check && row.note).map((row) => ({ id: row.id, note: row.note as string }));
  const failures = noted("fail");
  const cautions = noted("caution");
  const waiting = noted("unread");
  // The app's own page speaks HTTPS for Portainer alone, as its Open link already knows.
  const answers = whereItAnswers({ manifest, values, host, https: manifest.id === "portainer" });
  const server = inventory.value?.hostname ?? "this server";
  const list = (notes: Array<{ id: string; note: string }>) => (notes.length === 1 ? notes[0].note : <ul className="catalog-list">{notes.map((entry) => <li key={entry.id}>{entry.note}</li>)}</ul>);

  return (
    <div className="catalog-preflight">
      <p className="catalog-preflight__result" aria-live="polite">
        <span className="catalog-preflight__kicker">Will it fit</span>
        <StatusChip status={verdict.status}>{verdict.label}</StatusChip>
        {verdict.summary && <span className="catalog-preflight__summary">{verdict.summary}</span>}
      </p>

      <Panel level={3} title={`What it takes from ${server}`} className="catalog-preflight__takes">
        <Table caption={`What installing ${manifest.name} takes from ${server}`} columns={columns} rows={rows} rowKey={(row) => row.id} />
      </Panel>
      {failures.length > 0 && <Notice tone="danger" title="Does not fit as it stands">{list(failures)}</Notice>}
      {cautions.length > 0 && <Notice tone="warning" title="Caution">{list(cautions)}</Notice>}
      {waiting.length > 0 && <Notice tone="info" title="Not checked yet">{list(waiting)}</Notice>}

      <Panel level={3} title="Where it will answer" padded className="catalog-preflight__answers">
        <KeyValue layout="rows" items={answers.map((line) => ({
          id: line.id, label: line.label, mono: Boolean(line.address),
          value: line.address ? <code>{line.address}</code> : line.words,
          hint: line.address ? line.words ?? undefined : undefined,
        }))} />
      </Panel>

      {nightly && (
        <Panel level={3} title="From the first night" padded className="catalog-preflight__night">
          {nightly.already
            ? <p className="catalog-form__hint">{manifest.name} already has a backup scheduled from before, {nightly.already}. It is kept.</p>
            : <Checkbox
                label="Back it up every night"
                checked={nightly.checked}
                onChange={nightly.onChange}
                description={`Once it is installed you are offered the schedule: a backup every night at ${nightly.time}. Each one stops ${manifest.name} briefly and keeps the newest 5 copies.`}
              />}
        </Panel>
      )}
    </div>
  );
}
