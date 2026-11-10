import { useSyncExternalStore } from "react";

/**
 * Whether this device can reach BoxPilot right now (M25.1). The browser's own online flag says only
 * that there is a network, and a phone away from home is online but off the tailnet, so BoxPilot's
 * health answer is asked for too: when the page comes back into view, when the network returns,
 * once a minute while the page is open, and every five seconds while BoxPilot is not answering. The
 * shell's banner says what is stale when either fails.
 */
export interface ConnectionState {
  /** The device has a network at all. */
  online: boolean;
  /** BoxPilot answered the last time it was asked. */
  reachable: boolean;
  /** When it last answered, in ms; null before the first answer. */
  lastHeardAt: number | null;
}

const onlineNow = () => (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" ? true : navigator.onLine);
let state: ConnectionState = { online: onlineNow(), reachable: true, lastHeardAt: null };
const listeners = new Set<() => void>();

function set(next: Partial<ConnectionState>): void {
  const merged = { ...state, ...next };
  if (merged.online === state.online && merged.reachable === state.reachable && merged.lastHeardAt === state.lastHeardAt) return;
  state = merged;
  for (const listener of listeners) listener();
}

export const connectionState = (): ConnectionState => state;

export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask BoxPilot's health route. A reply that is not BoxPilot's (a proxy's error page) counts as not answering. */
export async function checkConnection({ fetcher = (url: string, init?: RequestInit) => fetch(url, init), now = Date.now }: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; now?: () => number } = {}): Promise<ConnectionState> {
  if (!onlineNow()) { set({ online: false }); return state; }
  try {
    const response = await fetcher("/api/v1/health", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const answered = response.ok && (response.headers.get("content-type") ?? "").includes("json");
    set({ online: true, reachable: answered, ...(answered ? { lastHeardAt: now() } : {}) });
  } catch {
    set({ online: onlineNow(), reachable: false });
  }
  return state;
}

export interface WatchOptions {
  /** How often to ask while BoxPilot is answering. */
  intervalMs?: number;
  /** How often while it is not: a restart or an update is over in seconds, and the banner should go with it. */
  retryMs?: number;
  /** The timers, for tests. */
  setTimer?: (run: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

/** Start watching; returns the function that stops. Called once, from main.tsx. */
export function watchConnection({ intervalMs = 60_000, retryMs = 5_000, setTimer = (run, ms) => window.setTimeout(run, ms), clearTimer = (id) => window.clearTimeout(id) }: WatchOptions = {}): () => void {
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const onOnline = () => { void checkConnection(); };
  const onOffline = () => set({ online: false });
  const onVisible = () => { if (visible()) void checkConnection(); };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
  // Once a minute while BoxPilot answers; every few seconds while it does not, so the page is back
  // moments after a reboot or an update rather than up to a minute later.
  let timer: number | null = null;
  let asking = false;
  const arm = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(tick, connected(state) ? intervalMs : Math.min(intervalMs, retryMs));
  };
  const tick = () => {
    timer = null;
    arm();
    if (!visible() || asking) return;
    asking = true;
    void checkConnection().finally(() => { asking = false; });
  };
  // The pace follows the state: lost, the next question is seconds away; back, a minute.
  let was = connected(state);
  const unsubscribe = subscribeConnection(() => {
    const now = connected(state);
    if (now === was) return;
    was = now;
    arm();
  });
  arm();
  void checkConnection();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisible);
    unsubscribe();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}

/** For tests: put the state back as it starts. */
export function resetConnection(next: Partial<ConnectionState> = {}): void {
  state = { online: true, reachable: true, lastHeardAt: null, ...next };
  for (const listener of listeners) listener();
}

export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribeConnection, connectionState, connectionState);
}

/** The connection is good enough to read and to act. */
export const connected = (connection: ConnectionState): boolean => connection.online && connection.reachable;
