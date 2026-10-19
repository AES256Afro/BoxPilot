import { useEffect, useState } from "react";
import { Notice, Panel, Switch } from "../../ui";

/**
 * Storage → Drives: the weekly read of a drive that sleeps through every check (M36). The storage
 * scan leaves a sleeping disk asleep rather than spin it up, so a disk that is always asleep could go
 * months with its SMART health unknown. With this on, a disk last read awake more than a week ago is
 * read once even though that wakes it. Waking a drive is the owner's call; everyone sees the setting.
 */
export function WeeklyWakePanel({ csrfToken, role }: { csrfToken: string; role: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  /** Disks asleep at the last check, and how many the last check read by waking them. */
  const [asleep, setAsleep] = useState<{ count: number; woken: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/settings/storage-wake").then((response) => response.json()).then((body: { enabled?: unknown }) => setEnabled(body?.enabled === true)).catch(() => setError("Could not read whether sleeping drives are read weekly"));
    fetch("/api/v1/inventory").then((response) => response.json()).then((body: { storage?: { smart?: { disks?: Array<{ reason?: string; wokenForWeeklyRead?: boolean }> } } }) => {
      const disks = Array.isArray(body?.storage?.smart?.disks) ? body.storage.smart.disks : [];
      setAsleep({ count: disks.filter((disk) => disk?.reason === "asleep").length, woken: disks.filter((disk) => disk?.wokenForWeeklyRead === true).length });
    }).catch(() => setAsleep(null));
  }, []);

  const change = async (on: boolean) => {
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/v1/settings/storage-wake", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ enabled: on }) });
      const body = (await response.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change the setting");
      setEnabled(body.enabled === true);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Could not change the setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Sleeping drives" meta={asleep ? <><b>{asleep.count}</b> asleep at the last check{asleep.woken ? <> · <b>{asleep.woken}</b> read by waking at the last check</> : null}</> : undefined} padded className="storage-wake">
      <Switch
        checked={enabled === true}
        busy={saving}
        disabled={enabled === null || role !== "owner"}
        onChange={(on) => void change(on)}
        label="Read a sleeping drive's health once a week"
        description={role === "owner"
          ? "Checks leave a sleeping drive asleep. With this on, one not read for a week is read anyway, which spins it up for a moment."
          : "Checks leave a sleeping drive asleep. The owner can have one not read for a week read anyway, which spins it up."}
      />
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Panel>
  );
}
