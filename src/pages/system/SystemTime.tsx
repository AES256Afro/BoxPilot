import { useEffect, useRef, useState } from "react";
import { Button, Field, KeyValue, Panel, Select, TextInput, mayStart, riskOf } from "../../ui";
import type { StartOperation, SystemSettings } from "./systemTypes";

/** The server's own rule (server/tasks/system.mjs): labels of letters, numbers and hyphens, dot-separated. */
const hostnamePattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The server's name, its time zone and its language (M33.12). Each is a small form with its own
 * button and tier; a value typed here is kept when the page reads the server again (a job finishing
 * elsewhere on the page used to wipe a half-typed hostname).
 */
export function SystemTime({ settings, loading, role, start }: { settings: SystemSettings | null; loading: boolean; role: string; start: StartOperation }) {
  const [hostname, setHostname] = useState("");
  const [timezone, setTimezone] = useState("");
  const [locale, setLocale] = useState("");
  const edited = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!settings) return;
    if (!edited.current.has("hostname")) setHostname(settings.hostname.static ?? "");
    if (!edited.current.has("timezone")) setTimezone(settings.timezone ?? "");
    if (!edited.current.has("locale")) setLocale(settings.locale ?? "");
  }, [settings]);
  const edit = (field: string, set: (value: string) => void) => (value: string) => { edited.current.add(field); set(value); };

  const hostnameValid = hostnamePattern.test(hostname);
  const zones = settings?.timezones ?? [];
  const zoneOptions = [...(settings?.timezone && !zones.includes(settings.timezone) ? [settings.timezone] : []), ...zones].map((zone) => ({ value: zone, label: zone }));
  const locales = settings?.locales ?? [];
  const localeOptions = [...(settings?.locale && !locales.includes(settings.locale) ? [settings.locale] : []), ...locales].map((entry) => ({ value: entry, label: entry }));

  const rename = () => start({ operationId: "system.hostname.set", title: `Rename to ${hostname}`, parameters: { hostname }, preview: <span><code>hostnamectl set-hostname {hostname}</code>, then the <code>127.0.1.1</code> line in <code>/etc/hosts</code> is updated.</span> });
  const changeZone = () => start({ operationId: "system.timezone.set", title: `Change time zone to ${timezone}`, parameters: { timezone }, preview: <span><code>timedatectl set-timezone {timezone}</code></span> });
  const changeLocale = () => start({ operationId: "system.locale.set", title: `Set the system language to ${locale}`, parameters: { locale }, preview: <span><code>update-locale LANG={locale}</code>. New sessions and restarted services pick it up.</span> });

  return (
    <>
      <Panel padded title="Name">
        <KeyValue items={[
          { id: "live", label: "Hostname", value: settings?.hostname.live ?? "—", mono: true },
          { id: "static", label: "Static", value: settings ? (settings.hostname.static === settings.hostname.live ? "matches" : settings.hostname.static ?? "—") : "—", mono: true },
        ]} />
        {mayStart(role, "system.hostname.set") && (
          <form className="system-form" onSubmit={(event) => { event.preventDefault(); if (hostnameValid && hostname !== settings?.hostname.static) rename(); }}>
            <Field label="Rename this server" hint="Keeps /etc/hosts in step. Machines that cached the old name keep using it until they look it up again."
              error={hostname && !hostnameValid ? "Lower-case letters, numbers and hyphens; dots between parts" : undefined}>
              <TextInput mono value={hostname} onValueChange={edit("hostname", (value) => setHostname(value.toLowerCase()))} placeholder="my-server" autoComplete="off" spellCheck={false} />
            </Field>
            <Button type="submit" risk={riskOf("system.hostname.set")} disabled={loading || !hostnameValid || hostname === settings?.hostname.static}>Rename</Button>
          </form>
        )}
      </Panel>

      <Panel padded title="Time zone" meta={settings?.timezone ? <code>{settings.timezone}</code> : undefined}>
        {mayStart(role, "system.timezone.set") ? (
          <form className="system-form" onSubmit={(event) => { event.preventDefault(); if (timezone && timezone !== settings?.timezone) changeZone(); }}>
            <Field label="Set the time zone" hint="Log timestamps, cron schedules and timers follow the system's time zone.">
              {zoneOptions.length > 0
                ? <Select mono value={timezone} onValueChange={edit("timezone", setTimezone)} options={zoneOptions} />
                : <TextInput mono value={timezone} onValueChange={edit("timezone", setTimezone)} placeholder="Europe/Berlin" autoComplete="off" />}
            </Field>
            <Button type="submit" risk={riskOf("system.timezone.set")} disabled={loading || !timezone || timezone === settings?.timezone}>Change time zone</Button>
          </form>
        ) : <KeyValue items={[{ id: "zone", label: "Time zone", value: settings?.timezone ?? "unknown", mono: true }]} />}
      </Panel>

      {localeOptions.length > 0 && (
        <Panel padded title="System language" meta={settings?.locale ? <code>{settings.locale}</code> : undefined}>
          {mayStart(role, "system.locale.set") ? (
            <form className="system-form" onSubmit={(event) => { event.preventDefault(); if (locale && locale !== settings?.locale) changeLocale(); }}>
              <Field label="System locale" hint="LANG for services and shells. Only locales already generated on this system are offered.">
                <Select mono value={locale} onValueChange={edit("locale", setLocale)} options={localeOptions} />
              </Field>
              <Button type="submit" risk={riskOf("system.locale.set")} disabled={loading || !locale || locale === settings?.locale}>Change language</Button>
            </form>
          ) : <KeyValue items={[{ id: "locale", label: "System locale", value: settings?.locale ?? "unknown", mono: true }]} />}
        </Panel>
      )}
    </>
  );
}
