import { useCallback, useEffect, useRef, useState } from "react";
import type { NfsExport, NfsState, SambaShare, SambaState, Scope } from "./types";

/*
 * The file servers' state and the owner's unapplied edits (M33.9). Held by the page rather than by
 * the File sharing tab, so a draft share list survives switching tabs and every operation's
 * refresh: the server's answer replaces the draft only while nothing is waiting to be applied.
 */

export interface SambaControl {
  state: SambaState | null;
  error: string | null;
  draft: SambaShare[];
  scope: Scope;
  workgroup: string;
  /** Edits wait to be applied. */
  dirty: boolean;
  /** Share name → the id of its weekly recycle-bin clean, when one is scheduled. */
  autoClean: Record<string, string>;
  autoCleanError: string | null;
  setDraft: (change: (current: SambaShare[]) => SambaShare[]) => void;
  setScope: (scope: Scope) => void;
  setWorkgroup: (workgroup: string) => void;
  /** An apply finished: what the server has now is the list, so the next read takes it. */
  settle: () => void;
  refresh: () => Promise<void>;
  scheduleAutoClean: (share: string) => Promise<void>;
  unscheduleAutoClean: (scheduleId: string) => Promise<void>;
}

export function useSamba(csrfToken: string): SambaControl {
  const [state, setState] = useState<SambaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<SambaShare[]>([]);
  const [scope, setScopeState] = useState<Scope>("tailscale");
  const [workgroup, setWorkgroupState] = useState("WORKGROUP");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [autoClean, setAutoClean] = useState<Record<string, string>>({});
  const [autoCleanError, setAutoCleanError] = useState<string | null>(null);

  const loadAutoClean = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/schedules");
      const body = (response.ok ? await response.json() : { schedules: [] }) as { schedules?: Array<{ id: string; operationId: string; parameters?: { subject?: string } }> };
      setAutoClean(Object.fromEntries((body.schedules ?? []).filter((schedule) => schedule.operationId === "samba.recycle.empty" && schedule.parameters?.subject).map((schedule) => [schedule.parameters!.subject!, schedule.id])));
    } catch { /* the rows show the manual state */ }
  }, []);

  const refresh = useCallback(async () => {
    void loadAutoClean();
    try {
      const response = await fetch("/api/v1/storage/samba");
      const body = (await response.json()) as SambaState & { error?: string | null };
      if (!response.ok) throw new Error(body.error ?? "The file server could not be read");
      setState(body);
      setError(body.error ?? null);
      if (!dirtyRef.current) {
        setDraftState((body.config?.shares ?? []).map((share) => ({ ...share, users: share.users ?? [] })));
        setScopeState(body.config?.scope ?? "tailscale");
        setWorkgroupState(body.config?.workgroup || "WORKGROUP");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The file server could not be read");
    }
  }, [loadAutoClean]);
  useEffect(() => { void refresh(); }, [refresh]);

  const scheduleAutoClean = async (share: string) => {
    try {
      const response = await fetch("/api/v1/schedules", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ operationId: "samba.recycle.empty", parameters: { share, olderThanDays: 30 }, frequency: "weekly", minute: 0, hour: 5, weekday: 0 }) });
      setAutoCleanError(response.ok ? null : share);
      await loadAutoClean();
    } catch { setAutoCleanError(share); }
  };
  const unscheduleAutoClean = async (scheduleId: string) => {
    try {
      await fetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } });
      await loadAutoClean();
    } catch { /* left as it was */ }
  };

  return {
    state, error, draft, scope, workgroup, dirty, autoClean, autoCleanError,
    setDraft: (change) => { setDraftState(change); setDirty(true); },
    setScope: (next) => { setScopeState(next); setDirty(true); },
    setWorkgroup: (next) => { setWorkgroupState(next); setDirty(true); },
    settle: () => { dirtyRef.current = false; setDirty(false); },
    refresh, scheduleAutoClean, unscheduleAutoClean,
  };
}

export interface NfsControl {
  state: NfsState | null;
  error: string | null;
  draft: NfsExport[];
  scope: Scope;
  dirty: boolean;
  setDraft: (change: (current: NfsExport[]) => NfsExport[]) => void;
  setScope: (scope: Scope) => void;
  settle: () => void;
  refresh: () => Promise<void>;
}

export function useNfs(): NfsControl {
  const [state, setState] = useState<NfsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<NfsExport[]>([]);
  const [scope, setScopeState] = useState<Scope>("tailscale");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/storage/nfs");
      const body = (await response.json()) as NfsState & { error?: string | null };
      if (!response.ok) throw new Error(body.error ?? "The NFS server could not be read");
      setState(body);
      setError(body.error ?? null);
      if (!dirtyRef.current) {
        setDraftState((body.config?.exports ?? []).map((entry) => ({ path: entry.path, readOnly: entry.readOnly })));
        setScopeState(body.config?.scope ?? "tailscale");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The NFS server could not be read");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return {
    state, error, draft, scope, dirty,
    setDraft: (change) => { setDraftState(change); setDirty(true); },
    setScope: (next) => { setScopeState(next); setDirty(true); },
    settle: () => { dirtyRef.current = false; setDirty(false); },
    refresh,
  };
}
